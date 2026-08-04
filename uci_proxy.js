// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Jorge Ruiz Centelles
// uci_proxy.js
// IJCCRL Live Arena — UCI proxy runner with Phase-1 scheduler (SERVER-DRIVEN)
//
// ✅ Key fixes (Phase 1 seal):
// 1) SINGLE source of truth for scheduling: server.js creates scheduler and passes cfg.scheduler.nextGame()
// 2) Stable keys ALWAYS: white_key/black_key = ENGINE_IDS (never "id name")
// 3) Display names separated: white/black show friendly names, but keys remain stable
//
// NOTE: Pair-blocking (A vs B then B vs A) is controlled by scheduler.js order.
// This proxy executes exactly the nextGame() order it receives.
//
// Node ESM ("type": "module")

// ============================================================
// UI/BE build: 2026-03-19BE01P1 • phase BE-01 — Live Clock Heartbeat
// Scope:
//   - emit live clock snapshots while the side to move is thinking
//   - keep the server/frontend clocks fresh between bestmove boundaries
//   - preserve engine protocol, scheduler flow, PGN/results persistence and TB logic
// ============================================================

import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";

const DEBUG = process.env.IJCCRL_DEBUG === "1";
const DEBUG_FILE = process.env.IJCCRL_DEBUG_FILE === "1";

const BESTMOVE_TIMEOUT_MS = Number(process.env.IJCCRL_BESTMOVE_TIMEOUT_MS || 45000);
const STOP_GRACE_MS = Number(process.env.IJCCRL_STOP_GRACE_MS || 1500);
const MIN_TIME_MS = Number(process.env.IJCCRL_MIN_TIME_MS || 1);
const UCIOK_TIMEOUT_MS = Number(process.env.IJCCRL_UCI_UCIOK_TIMEOUT_MS || 12000);
const READYOK_TIMEOUT_MS = Number(process.env.IJCCRL_UCI_READYOK_TIMEOUT_MS || 12000);
const LIVE_CLOCK_HEARTBEAT_MS = Math.max(0, Math.floor(Number(process.env.IJCCRL_LIVE_CLOCK_HEARTBEAT_MS || 1000)));

// ✅ TB Turbo ("toque") for Syzygy endgames
// When enabled and material <= pieceLimit, we send `go movetime N` (or `go depth D`)
// instead of clock-based `go wtime/btime`.
// Controls:
//   IJCCRL_TB_TURBO=1|0                  (default: 1)
//   IJCCRL_TB_TURBO_MODE=movetime|depth  (default: movetime)
//   IJCCRL_TB_TURBO_MOVETIME_MS=25       (default: 25)
//   IJCCRL_TB_TURBO_DEPTH=1              (default: 1)
//   IJCCRL_TB_TURBO_PIECE_LIMIT=5        (default: SyzygyProbeLimit)
const TB_TURBO = String(process.env.IJCCRL_TB_TURBO ?? "1").trim() !== "0";
const TB_TURBO_MODE = String(process.env.IJCCRL_TB_TURBO_MODE || "movetime").trim().toLowerCase();
const TB_TURBO_MOVETIME_MS = Number(process.env.IJCCRL_TB_TURBO_MOVETIME_MS || 25);
const TB_TURBO_DEPTH = Number(process.env.IJCCRL_TB_TURBO_DEPTH || 1);
const TB_TURBO_PIECE_LIMIT_ENV = Number(process.env.IJCCRL_TB_TURBO_PIECE_LIMIT || NaN);

// no_bestmove policy: loss|draw
const NO_BESTMOVE_POLICY = String(process.env.IJCCRL_NO_BESTMOVE_POLICY || "draw").toLowerCase();

// rules enforcement toggles
const RULE_3FOLD = String(process.env.IJCCRL_3FOLD_RULE || "true").toLowerCase() !== "false";
const RULE_50MOVE = String(process.env.IJCCRL_50_MOVE_RULE || "true").toLowerCase() !== "false";
const RULE_IM = String(process.env.IJCCRL_IM_RULE || "true").toLowerCase() !== "false";

// ✅ Phase name (for cycle audit). Set via env, stable across restarts.
const IJCCRL_PHASE_NAME = String(process.env.IJCCRL_PHASE_NAME || process.env.IJCCRL_PHASE || "").trim();
// Optional season label (purely cosmetic)
const IJCCRL_EVENT_NAME = String(process.env.IJCCRL_EVENT_NAME || "IJCCRL Live").trim();

// ✅ Anti-duplicate safeguard (single-writer rule)
//
// Default: uci_proxy WRITES out/games.pgn
// If server is started with IJCCRL_SERVER_WRITES_PGN=1, then uci_proxy should NOT write the PGN bundle,
// unless user explicitly forces IJCCRL_PROXY_WRITES_PGN=1.
const SERVER_WRITES_PGN = String(process.env.IJCCRL_SERVER_WRITES_PGN || "0").trim() === "1";
const PROXY_WRITES_PGN_EXPLICIT = String(process.env.IJCCRL_PROXY_WRITES_PGN || "").trim();
const PROXY_WRITES_PGN =
  (PROXY_WRITES_PGN_EXPLICIT === "1") ? true :
  (PROXY_WRITES_PGN_EXPLICIT === "0") ? false :
  (!SERVER_WRITES_PGN); // default depends on server writer mode

function log(...args) { if (DEBUG) console.log(...args); }
function safeMkdir(dir) { try { fs.mkdirSync(dir, { recursive: true }); } catch {} }
function fileExists(p) { try { return fs.existsSync(p) && fs.statSync(p).isFile(); } catch { return false; } }

function evidence(msg) {
  try { console.log(`[IJCCRL][evidence] ${msg}`); } catch {}
}

function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

function baseNameNoExt(p) {
  try { return path.basename(p).replace(/\.[^.]+$/, ""); }
  catch { return String(p || "engine"); }
}

// -------------------------------
// ENV helpers (Syzygy options)
// -------------------------------
function envFirst(keys) {
  for (const k of keys) {
    const v = process.env[k];
    if (v != null && String(v).trim() !== "") return String(v).trim();
  }
  return null;
}

function envNum(keys, fallback = null) {
  const v = envFirst(keys);
  if (v == null) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function envBool(keys, fallback = null) {
  const v = envFirst(keys);
  if (v == null) return fallback;
  const s = String(v).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(s)) return true;
  if (["0", "false", "no", "n", "off"].includes(s)) return false;
  return fallback;
}

// We support both IJCCRL_* and generic names if you ever want them
const ENV_SYZ_PROBE_LIMIT = envNum(["IJCCRL_SYZYGY_PROBE_LIMIT", "SYZYGY_PROBE_LIMIT"], null);
const ENV_SYZ_PROBE_DEPTH = envNum(["IJCCRL_SYZYGY_PROBE_DEPTH", "SYZYGY_PROBE_DEPTH"], null);
const ENV_SYZ_50_MOVE_RULE = envBool(["IJCCRL_SYZYGY_50_MOVE_RULE", "SYZYGY_50_MOVE_RULE"], null);

const COMMON_PONDER = envBool(["IJCCRL_PONDER"], false);
const COMMON_OWN_BOOK = envBool(["IJCCRL_OWN_BOOK"], false);
const COMMON_CHESS960 = envBool(["IJCCRL_CHESS960"], false);
const COMMON_MULTIPV = Math.max(1, Math.floor(envNum(["IJCCRL_MULTIPV"], 1) || 1));
const COMMON_MOVE_OVERHEAD_MS = Math.max(0, Math.floor(envNum(["IJCCRL_MOVE_OVERHEAD_MS", "MOVE_OVERHEAD_MS"], 75) || 75));
const COMMON_MINIMAL_REPORTING = Math.max(0, Math.floor(envNum(["IJCCRL_MINIMAL_REPORTING"], 0) || 0));
const TOURNAMENT_CONTEMPT_CP = Math.trunc(envNum(["IJCCRL_TOURNAMENT_CONTEMPT_CP"], 0) || 0);

const STOCKFISH_SKILL_LEVEL = Math.max(0, Math.floor(envNum(["IJCCRL_STOCKFISH_SKILL_LEVEL"], 20) || 20));
const DRAGON_SKILL_LEVEL = Math.max(0, Math.floor(envNum(["IJCCRL_DRAGON_SKILL_LEVEL"], 20) || 20));
const DRAGON_TABLE_MEMORY_MB = Math.max(1, Math.floor(envNum(["IJCCRL_DRAGON_TABLE_MEMORY_MB"], 512) || 512));

const DRAGON_AUTO_SKILL = envBool(["IJCCRL_DRAGON_AUTO_SKILL"], false);
const DRAGON_WHITE_CONTEMPT = envBool(["IJCCRL_DRAGON_WHITE_CONTEMPT"], false);
const DRAGON_USE_REGULAR_EVAL = envBool(["IJCCRL_DRAGON_USE_REGULAR_EVAL"], false);
const DRAGON_USE_MCTS = envBool(["IJCCRL_DRAGON_USE_MCTS"], false);

const MOVE_OVERHEAD_OPTION_ALIASES = ["Move Overhead", "MoveOverhead", "Move_Overhead", "Overhead ms"];

function normalizeOptionKey(v) {
  return String(v || "").trim().toLowerCase().replace(/[\s_\-]+/g, "");
}

function optionPrimaryName(nameOrAliases) {
  if (Array.isArray(nameOrAliases)) return String(nameOrAliases[0] || "").trim();
  return String(nameOrAliases || "").trim();
}

function inferEngineProfile({ exePath, engineName = "", supportsOption = () => false } = {}) {
  const sig = `${String(engineName || "")} ${path.basename(String(exePath || ""))}`.toLowerCase();

  if (/dragon|komodo/.test(sig)) return "dragon_komodo";

  if (
    /stockfish|brainlearn|wordfish|deepalienist|darkseid|darksister|corchess|killfish|stockfishjrc|brainlearnjrc|artemis|hypnos|spectral|raptora|stormphrax|corchess|recklessjrc/.test(sig) ||
    (supportsOption(["Skill Level"]) && supportsOption(["UCI_LimitStrength"]))
  ) {
    return "stockfish_family";
  }

  return "generic_original";
}

// -------------------------------
// UCI info parsing (depth/nodes/nps/time/score/pv + tbhits evidence)
// -------------------------------
function fmtScoreHuman(score_type, score_value) {
  if (!score_type || score_value == null || !Number.isFinite(Number(score_value))) return null;
  if (score_type === "mate") {
    const v = Number(score_value);
    const s = (v >= 0) ? `+${v}` : `${v}`;
    return `#${s}`;
  }
  const cp = Number(score_value);
  const pawns = cp / 100.0;
  const s = pawns >= 0 ? "+" : "";
  return `${s}${pawns.toFixed(2)}`;
}

function truncatePv(pv, maxTokens = 12) {
  if (!pv) return null;
  const toks = String(pv).trim().split(/\s+/).filter(Boolean);
  if (toks.length <= maxTokens) return toks.join(" ");
  return toks.slice(0, maxTokens).join(" ") + " …";
}

function parseInfoLine(line) {
  if (!line.startsWith("info ")) return null;
  const out = {};
  const toks = line.split(/\s+/);

  const getAfter = (key) => {
    const i = toks.indexOf(key);
    if (i >= 0 && i + 1 < toks.length) return toks[i + 1];
    return null;
  };

  const depth = getAfter("depth"); if (depth != null) out.depth = Number(depth);
  const seldepth = getAfter("seldepth"); if (seldepth != null) out.seldepth = Number(seldepth);
  const nodes = getAfter("nodes"); if (nodes != null) out.nodes = Number(nodes);
  const nps = getAfter("nps"); if (nps != null) out.nps = Number(nps);
  const time = getAfter("time"); if (time != null) out.time_ms = Number(time);
  const multipv = getAfter("multipv"); if (multipv != null) out.multipv = Number(multipv);

  const tbh = getAfter("tbhits");
  if (tbh != null) out.tbhits = Number(tbh);

  const sIdx = toks.indexOf("score");
  if (sIdx >= 0 && sIdx + 2 < toks.length) {
    const st = toks[sIdx + 1];
    const sv = Number(toks[sIdx + 2]);
    if ((st === "cp" || st === "mate") && Number.isFinite(sv)) {
      out.score_type = st;
      out.score_value = sv;
    }
  }

  const pvIdx = toks.indexOf("pv");
  if (pvIdx >= 0 && pvIdx + 1 < toks.length) out.pv = toks.slice(pvIdx + 1).join(" ");
  return Object.keys(out).length ? out : null;
}

function normalizeInfo(prev, next) {
  const out = { ...(prev || {}) };
  for (const [k, v] of Object.entries(next || {})) {
    if (v == null) continue;
    out[k] = v;
  }

  if ((out.nps == null || !Number.isFinite(out.nps)) && out.nodes != null && out.time_ms != null && out.time_ms > 0) {
    out.nps = Math.floor((out.nodes * 1000) / out.time_ms);
  }

  const scoreHuman = fmtScoreHuman(out.score_type, out.score_value);
  if (scoreHuman != null) out.score = scoreHuman;

  if (out.pv) out.pv = truncatePv(out.pv, Number(process.env.IJCCRL_PV_TOKENS || 12));
  return out;
}

// -------------------------------
// Openings loader (PGN -> UCI prefix using chess.js)
// -------------------------------
function splitPgnGames(pgnText) {
  const t = String(pgnText || "").replace(/\r/g, "").trim();
  if (!t) return [];
  return t.split(/\n\s*\n(?=\[)/g).map(s => s.trim()).filter(Boolean);
}

function parseTags(pgnChunk) {
  const tags = {};
  const re = /^\[([A-Za-z0-9_]+)\s+"([^"]*)"\]\s*$/gm;
  let m;
  while ((m = re.exec(pgnChunk)) !== null) tags[m[1]] = m[2];
  return tags;
}

function extractMovesSection(pgnChunk) {
  return String(pgnChunk || "").replace(/^\[[^\]]+\]\s*$/gm, "").trim();
}

function isUciMoveToken(tok) {
  return /^[a-h][1-8][a-h][1-8][qrbn]?$/i.test(tok);
}

let ChessNode = null;
async function ensureChessNode() {
  if (ChessNode) return ChessNode;
  const mod = await import("chess.js");
  ChessNode = mod.Chess;
  return ChessNode;
}

async function movesTextToUciList(pgnChunk, plyLimit) {
  const tags = parseTags(pgnChunk);
  const body = extractMovesSection(pgnChunk);

  let s = body;
  s = s.replace(/\{[^}]*\}/g, " ");
  s = s.replace(/\([^)]*\)/g, " ");
  s = s.replace(/\$\d+/g, " ");
  s = s.replace(/1-0|0-1|1\/2-1\/2|\*/g, " ");
  s = s.replace(/\d+\.(\.\.)?/g, " ");
  s = s.replace(/\s+/g, " ").trim();

  const tokens = s.split(" ").filter(Boolean);
  if (!tokens.length) return null;

  if (tokens.every(isUciMoveToken)) {
    return { tags, movesUci: tokens.slice(0, plyLimit).join(" ") };
  }

  const Chess = await ensureChessNode();
  const fenTag = tags.FEN || tags.Fen || "";
  const game = fenTag ? new Chess(fenTag) : new Chess();

  const uci = [];
  for (const tok of tokens) {
    if (uci.length >= plyLimit) break;
    const mv = game.move(tok, { sloppy: true });
    if (!mv) break;
    uci.push(mv.from + mv.to + (mv.promotion ? mv.promotion : ""));
  }
  if (!uci.length) return null;
  return { tags, movesUci: uci.join(" ") };
}

function formatOpeningLabel(tags) {
  const eco = String(tags?.ECO || tags?.Eco || tags?.eco || "").trim();
  const op  = String(tags?.Opening || tags?.opening || "").trim();
  const varr = String(tags?.Variation || tags?.variation || "").trim();

  let name = "";
  if (op && varr) name = `${op}: ${varr}`;
  else if (op) name = op;
  else if (varr) name = varr;

  if (eco && name) return `${eco} ${name}`;
  if (eco) return eco;
  if (name) return name;
  return "—";
}

function computeTurnFromMovesArray(moves) {
  const ply = Array.isArray(moves) ? moves.length : 0;
  const turn = (ply % 2 === 0) ? "w" : "b";
  return { ply, turn };
}

function emitClockSnapshot(onClocks, { w_ms, b_ms, turn }) {
  try {
    onClocks({
      w_ms: Math.max(0, Math.floor(Number(w_ms) || 0)),
      b_ms: Math.max(0, Math.floor(Number(b_ms) || 0)),
      turn,
    });
  } catch {}
}

function startLiveClockHeartbeat({ turn, wRemain, bRemain, onClocks, intervalMs }) {
  const ms = Math.max(0, Math.floor(Number(intervalMs) || 0));
  if (ms <= 0) return () => {};

  const startedAt = Date.now();
  const tick = () => {
    const elapsed = Math.max(0, Date.now() - startedAt);
    emitClockSnapshot(onClocks, {
      w_ms: (turn === "w") ? Math.max(0, Number(wRemain) - elapsed) : Number(wRemain),
      b_ms: (turn === "b") ? Math.max(0, Number(bRemain) - elapsed) : Number(bRemain),
      turn,
    });
  };

  const timer = setInterval(tick, ms);
  try { if (typeof timer.unref === "function") timer.unref(); } catch {}

  return () => {
    try { clearInterval(timer); } catch {}
  };
}

// -------------------------------
// Chess termination helpers (3fold / 50-move / IM / mate / stalemate)
// -------------------------------
function fenKeyForRepetition(fen) {
  const parts = String(fen || "").split(/\s+/);
  return parts.slice(0, 4).join(" ");
}

function parseHalfmoveClockFromFen(fen) {
  const parts = String(fen || "").split(/\s+/);
  const hm = Number(parts[4]);
  return Number.isFinite(hm) ? hm : 0;
}

function countPiecesFromFen(fen) {
  // Counts ALL pieces including kings (SyzygyProbeLimit semantics)
  const board = String(fen || "").split(/\s+/)[0] || "";
  const m = board.match(/[pnbrqkPNBRQK]/g);
  return m ? m.length : 0;
}

function hasMethod(obj, name) {
  return obj && typeof obj[name] === "function";
}

function isInsufficientMaterial(game) {
  if (!RULE_IM) return false;
  if (hasMethod(game, "isInsufficientMaterial")) return !!game.isInsufficientMaterial();
  return false;
}

function isThreefold(game, repMap) {
  if (!RULE_3FOLD) return false;
  if (hasMethod(game, "isThreefoldRepetition")) return !!game.isThreefoldRepetition();
  const key = fenKeyForRepetition(game.fen());
  const n = repMap.get(key) || 0;
  return n >= 3;
}

function isFiftyMove(game) {
  if (!RULE_50MOVE) return false;
  if (hasMethod(game, "isDrawByFiftyMoves")) return !!game.isDrawByFiftyMoves();
  const hm = parseHalfmoveClockFromFen(game.fen());
  return hm >= 100;
}

function isCheckmate(game) {
  if (hasMethod(game, "isCheckmate")) return !!game.isCheckmate();
  if (hasMethod(game, "inCheckmate")) return !!game.inCheckmate();
  return false;
}

function isStalemate(game) {
  if (hasMethod(game, "isStalemate")) return !!game.isStalemate();
  if (hasMethod(game, "inStalemate")) return !!game.inStalemate();
  return false;
}

// -------------------------------
// PGN builder (real tags + SAN using chess.js)
// -------------------------------
function fmtDateYYYYMMDD(d = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}`;
}

async function buildPgnFromUciMoves({
  white,
  black,
  result,
  movesUci,
  openingEco,
  openingName,
  openingRef,
  openingsSourceLabel,
  tcBaseMs,
  tcIncMs,
  roundNo,
  tbHitsW,
  tbHitsB,
  tbHitsTotal,
  tbReportedW,
  tbReportedB,
  termination,
  gameDurationMs,

  // ✅ cycle audit tags
  ijccrlPhase,
  ijccrlCycle,
  ijccrlOpeningIndex,
  ijccrlOpeningBlock,

  // ✅ pair slot audit tags
  ijccrlPairIndex,
  ijccrlPairGameNo,
}) {
  const Chess = await ensureChessNode();
  const game = new Chess();

  const uciList = String(movesUci || "").trim().split(/\s+/).filter(Boolean);
  for (const u of uciList) {
    if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/i.test(u)) break;
    const from = u.slice(0, 2);
    const to = u.slice(2, 4);
    const promo = u[4] ? u[4].toLowerCase() : undefined;
    const mv = game.move({ from, to, promotion: promo });
    if (!mv) break;
  }

  const tc = `${Math.round(tcBaseMs / 1000)}+${Math.round(tcIncMs / 1000)}`;

  const tags = [];
  tags.push(`[Event "${String(IJCCRL_EVENT_NAME || "IJCCRL Live").replaceAll('"', "'")}"]`);
  tags.push(`[Site "IJCCRL"]`);
  tags.push(`[Date "${fmtDateYYYYMMDD()}"]`);
  tags.push(`[Round "${String(roundNo != null ? roundNo : "-")}"]`);
  tags.push(`[White "${white}"]`);
  tags.push(`[Black "${black}"]`);
  tags.push(`[Result "${result}"]`);
  tags.push(`[TimeControl "${tc}"]`);

  const phase = String(ijccrlPhase || IJCCRL_PHASE_NAME || "").trim();
  if (phase) tags.push(`[IJCCRL_Phase "${phase.replaceAll('"', "'")}"]`);

  if (ijccrlCycle != null && String(ijccrlCycle).trim() !== "") {
    tags.push(`[IJCCRL_Cycle "${String(ijccrlCycle).trim().replaceAll('"', "'")}"]`);
  }
  if (ijccrlOpeningIndex != null && String(ijccrlOpeningIndex).trim() !== "") {
    tags.push(`[IJCCRL_OpeningIndex "${String(ijccrlOpeningIndex).trim().replaceAll('"', "'")}"]`);
  }

  if (ijccrlPairIndex != null && String(ijccrlPairIndex).trim() !== "") {
    tags.push(`[IJCCRL_PairIndex "${String(ijccrlPairIndex).trim().replaceAll('"', "'")}"]`);
  }
  if (ijccrlPairGameNo != null && String(ijccrlPairGameNo).trim() !== "") {
    tags.push(`[IJCCRL_PairGameNo "${String(ijccrlPairGameNo).trim().replaceAll('"', "'")}"]`);
  }

  const ob = String(ijccrlOpeningBlock || openingEco || "").trim();
  if (ob) tags.push(`[IJCCRL_OpeningBlock "${ob.replaceAll('"', "'")}"]`);

  if (openingEco) tags.push(`[ECO "${openingEco}"]`);
  if (openingName && openingName !== "—") tags.push(`[Opening "${openingName}"]`);
  if (openingRef) tags.push(`[Annotator "${openingRef}"]`);
  if (openingsSourceLabel) tags.push(`[Source "${openingsSourceLabel}"]`);

  if (Number.isFinite(tbHitsW)) tags.push(`[IJCCRL_TBHitsWhite "${String(tbHitsW)}"]`);
  if (Number.isFinite(tbHitsB)) tags.push(`[IJCCRL_TBHitsBlack "${String(tbHitsB)}"]`);
  if (Number.isFinite(tbHitsTotal)) tags.push(`[IJCCRL_TBHitsTotal "${String(tbHitsTotal)}"]`);

  if (tbReportedW != null) tags.push(`[IJCCRL_TBReportedWhite "${tbReportedW ? "1" : "0"}"]`);
  if (tbReportedB != null) tags.push(`[IJCCRL_TBReportedBlack "${tbReportedB ? "1" : "0"}"]`);

  if (termination) tags.push(`[Termination "${String(termination).replaceAll('"', "'")}"]`);
  if (Number.isFinite(gameDurationMs)) tags.push(`[IJCCRL_DurationMs "${String(Math.max(0, Math.floor(gameDurationMs)))}"]`);

  const san = game.history();
  let movetext = "";
  for (let i = 0; i < san.length; i++) {
    if (i % 2 === 0) movetext += `${(i / 2) + 1}. `;
    movetext += san[i] + " ";
  }
  movetext = movetext.trim();
  if (movetext) movetext += ` ${result}`;
  else movetext = result;

  return tags.join("\n") + "\n\n" + movetext + "\n";
}

// -------------------------------
// persistent stores (out/games.pgn + out/results.json)
// -------------------------------
const OUT_DIR = path.join(process.cwd(), "out");
const PGN_BUNDLE_PATH = path.join(OUT_DIR, "games.pgn");
const RESULTS_JSON_PATH = path.join(OUT_DIR, "results.json");

function appendPgnBundle(pgnText) {
  if (!PROXY_WRITES_PGN) return;
  try {
    safeMkdir(OUT_DIR);
    fs.appendFileSync(PGN_BUNDLE_PATH, String(pgnText || "").trimEnd() + "\n\n", "utf8");
  } catch {}
}

function readResultsJson() {
  try {
    if (!fileExists(RESULTS_JSON_PATH)) return { games: [], rows: [] };
    const j = JSON.parse(fs.readFileSync(RESULTS_JSON_PATH, "utf8"));
    if (j && typeof j === "object") {
      if (!Array.isArray(j.games)) j.games = [];
      if (!Array.isArray(j.rows)) j.rows = [];
      return j;
    }
  } catch {}
  return { games: [], rows: [] };
}

function rebuildRowsFromGames(games) {
  const map = new Map();

  const ensure = (key) => {
    const k = String(key || "").trim();
    if (!k) return null;
    if (!map.has(k)) {
      map.set(k, {
        engine: k,
        engine_key: k,
        engine_display: k,
        pts: 0,
        gp: 0,
        w: 0,
        d: 0,
        l: 0,
        last: "",
      });
    }
    return map.get(k);
  };

  const pushLast = (row, ch) => {
    const s = String(row.last || "") + ch;
    row.last = s.slice(-10);
  };

  for (const g of (games || [])) {
    const wKey = String(g.white_key || "").trim();
    const bKey = String(g.black_key || "").trim();
    const W = ensure(wKey);
    const B = ensure(bKey);
    if (!W || !B) continue;

    const wDisp = String(g.white_display || "").trim();
    const bDisp = String(g.black_display || "").trim();
    if (wDisp) W.engine_display = wDisp;
    if (bDisp) B.engine_display = bDisp;

    W.gp++; B.gp++;

    if (g.result === "1-0") {
      W.w++; W.pts += 1; B.l++;
      pushLast(W, "W"); pushLast(B, "L");
    } else if (g.result === "0-1") {
      B.w++; B.pts += 1; W.l++;
      pushLast(B, "W"); pushLast(W, "L");
    } else if (g.result === "1/2-1/2" || g.result === "0.5-0.5") {
      W.d++; W.pts += 0.5; B.d++; B.pts += 0.5;
      pushLast(W, "D"); pushLast(B, "D");
    } else {
      pushLast(W, "-"); pushLast(B, "-");
    }
  }

  const rows = [...map.values()];
  rows.sort((a, b) => (b.pts - a.pts) || String(a.engine_key).localeCompare(String(b.engine_key)));
  return rows;
}

function persistResultsGame(gameObj) {
  try {
    safeMkdir(OUT_DIR);
    const data = readResultsJson();
    data.games.push({ ...gameObj, ts: Date.now() });
    data.rows = rebuildRowsFromGames(data.games);
    fs.writeFileSync(RESULTS_JSON_PATH, JSON.stringify(data, null, 2), "utf8");
  } catch {}
}

function getResultsSnapshot() {
  const snap = readResultsJson();
  return {
    rows: Array.isArray(snap.rows) ? snap.rows : [],
    games: Array.isArray(snap.games) ? snap.games : [],
  };
}

// -------------------------------
// UCI Engine wrapper
// -------------------------------
class UCIEngine extends EventEmitter {
  constructor(exePath, side, opts = {}) {
    super();
    this.exePath = exePath;
    this.side = side;
    this.proc = null;
    this.stdoutBuf = "";
    this.name = null;
    this.author = null;
    this.ready = false;
    this.bestmove = null;
    this.ponder = null;
    this.lastInfo = {};
    this._logStream = null;
    this.dead = false;
    this.profile = "generic_original";

    // ✅ option discovery (to avoid sending unsupported setoption)
    this.options = new Set();
    this.optionNameMap = new Map();

    if (DEBUG_FILE && opts?.logFile) {
      safeMkdir(path.dirname(opts.logFile));
      this._logStream = fs.createWriteStream(opts.logFile, { flags: "a" });
    }
  }

  _writeLog(line) { try { this._logStream?.write(line + "\n"); } catch {} }

  safeWrite(cmd) {
    const p = this.proc;
    if (!p || !p.stdin) return false;
    if (this.dead) return false;
    if (p.killed) return false;
    if (p.exitCode !== null) return false;
    if (!p.stdin.writable) return false;

    try {
      const s = cmd.endsWith("\n") ? cmd : (cmd + "\n");
      if (DEBUG) console.log(`[${this.side}] >> ${cmd}`);
      this._writeLog(`[${this.side}] >> ${cmd}`);
      p.stdin.write(s);
      return true;
    } catch {
      this.dead = true;
      return false;
    }
  }

  attachStdinGuards() {
    const p = this.proc;
    if (!p) return;

    try {
      p.stdin?.on("error", (err) => {
        this.dead = true;
        if (DEBUG) console.warn(`[${this.side}] stdin error:`, err?.code || err?.message || err);
      });
    } catch {}

    p.on("exit", () => { this.dead = true; });
    p.on("close", () => { this.dead = true; });
    p.on("error", () => { this.dead = true; });
  }

  ensureAliveOrThrow() {
    const p = this.proc;
    const alive = p && p.exitCode === null && !p.killed && !this.dead;
    if (!alive) throw new Error(`[Engine ${this.side}] not alive (cannot write commands)`);
  }

  spawn() {
    if (!this.exePath) throw new Error(`[Engine ${this.side}] Missing engine exe path`);
    this.dead = false;
    this.options = new Set(); // reset on spawn
    this.optionNameMap = new Map();
    try {
      this.proc = spawn(this.exePath, [], {
        cwd: path.dirname(this.exePath),
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e) {
      this.dead = true;
      throw new Error(`[Engine ${this.side}] spawn failed: ${e?.message || e}`);
    }
    this.attachStdinGuards();

    this.proc.on("error", (e) => this.emit("error", e));

    this.proc.stderr.on("data", (d) => {
      const s = d.toString("utf8");
      if (s && s.trim()) {
        const line = s.trimEnd();
        if (DEBUG) console.warn(`[${this.side}][stderr] ${line}`);
        this._writeLog(`[${this.side}][stderr] ${line}`);
      }
    });

    this.proc.stdout.on("data", (d) => {
      this.stdoutBuf += d.toString("utf8");
      let idx;
      while ((idx = this.stdoutBuf.indexOf("\n")) >= 0) {
        const line = this.stdoutBuf.slice(0, idx).replace(/\r$/, "");
        this.stdoutBuf = this.stdoutBuf.slice(idx + 1);
        this._onLine(line);
      }
    });
  }

  send(cmd) { this.safeWrite(cmd); }
  stop() { try { this.send("stop"); } catch {} }

  _onLine(line) {
    if (!line) return;
    if (DEBUG) console.log(`[${this.side}] ${line}`);
    this._writeLog(`[${this.side}] ${line}`);

    // ✅ learn options during "uci" handshake
    if (line.startsWith("option name ")) {
      try {
        const rest = line.slice("option name ".length);
        const idx = rest.indexOf(" type ");
        const name = (idx >= 0 ? rest.slice(0, idx) : rest).trim();
        if (name) {
          this.options.add(name);
          const norm = normalizeOptionKey(name);
          if (norm && !this.optionNameMap.has(norm)) this.optionNameMap.set(norm, name);
        }
      } catch {}
      return;
    }

    if (line.startsWith("id name ")) {
      this.name = line.slice("id name ".length).trim();
      this.emit("id", { name: this.name });
      return;
    }
    if (line.startsWith("id author ")) {
      this.author = line.slice("id author ".length).trim();
      this.emit("id", { author: this.author });
      return;
    }
    if (line === "uciok") { this.emit("uciok"); return; }
    if (line === "readyok") { this.ready = true; this.emit("readyok"); return; }

    if (line.startsWith("bestmove ")) {
      const parts = line.split(/\s+/);
      this.bestmove = parts[1] || "";
      this.ponder = (parts[2] === "ponder") ? (parts[3] || "") : null;
      this.emit("bestmove", { bestmove: this.bestmove, ponder: this.ponder });
      return;
    }

    const info = parseInfoLine(line);
    if (info) {
      this.lastInfo = normalizeInfo(this.lastInfo, info);
      this.emit("info", this.lastInfo);
    }
  }

  _resolveSupportedOptionName(nameOrAliases) {
    const aliases = Array.isArray(nameOrAliases) ? nameOrAliases : [nameOrAliases];
    const cleaned = aliases.map((x) => String(x || "").trim()).filter(Boolean);
    if (!cleaned.length) return null;

    if (!this.options || this.options.size === 0) return cleaned[0];

    for (const name of cleaned) {
      if (this.options.has(name)) return name;
    }

    for (const name of cleaned) {
      const mapped = this.optionNameMap.get(normalizeOptionKey(name));
      if (mapped) return mapped;
    }

    return null;
  }

  _supportsOption(nameOrAliases) {
    // If options were discovered, only send supported ones.
    // If not discovered (engine odd), we still try to send.
    if (!this.options || this.options.size === 0) return true;
    return !!this._resolveSupportedOptionName(nameOrAliases);
  }

  _setOptIfSupported(nameOrAliases, value, evidenceLabel = null) {
    try {
      const resolved = this._resolveSupportedOptionName(nameOrAliases);
      if (!resolved) return false;
      this.send(`setoption name ${resolved} value ${value}`);
      if (evidenceLabel) {
        evidence(`${evidenceLabel} sent to ${this.side}${this.name ? ` (${this.name})` : ""}: ${value}`);
        this._writeLog(`[evidence] ${evidenceLabel}=${value}`);
      }
      return true;
    } catch {
      return false;
    }
  }

  _setBoolOptIfSupported(nameOrAliases, value, evidenceLabel = null) {
    return this._setOptIfSupported(nameOrAliases, value ? "true" : "false", evidenceLabel || optionPrimaryName(nameOrAliases));
  }

  _detectTournamentProfile() {
    return inferEngineProfile({
      exePath: this.exePath,
      engineName: this.name,
      supportsOption: (nameOrAliases) => this._supportsOption(nameOrAliases),
    });
  }

  _applyCommonTournamentOptions(defaults = {}) {
    if (defaults?.threads != null) this._setOptIfSupported("Threads", Number(defaults.threads), "Threads");
    if (defaults?.hashMb != null) this._setOptIfSupported("Hash", Number(defaults.hashMb), "Hash");

    this._setBoolOptIfSupported(["Ponder"], COMMON_PONDER, "Ponder");
    this._setOptIfSupported(["MultiPV"], COMMON_MULTIPV, "MultiPV");
    this._setBoolOptIfSupported(["OwnBook", "Own Book"], COMMON_OWN_BOOK, "OwnBook");
    this._setBoolOptIfSupported(["UCI_Chess960", "Chess960"], COMMON_CHESS960, "UCI_Chess960");
    this._setOptIfSupported(MOVE_OVERHEAD_OPTION_ALIASES, COMMON_MOVE_OVERHEAD_MS, "MoveOverhead");
    this._setOptIfSupported(["Minimal Reporting", "Minimal"], COMMON_MINIMAL_REPORTING, "MinimalReporting");
  }

  _applyTournamentProfileOptions(profile) {
    if (profile === "stockfish_family") {
      this._setBoolOptIfSupported(["UCI_LimitStrength"], false, "UCI_LimitStrength");
      this._setOptIfSupported(["Skill Level"], STOCKFISH_SKILL_LEVEL, "SkillLevel");
      return;
    }

    if (profile === "dragon_komodo") {
      this._setOptIfSupported(["Skill"], DRAGON_SKILL_LEVEL, "Skill");
      this._setBoolOptIfSupported(["Auto Skill"], DRAGON_AUTO_SKILL, "AutoSkill");
      this._setOptIfSupported(["Contempt"], TOURNAMENT_CONTEMPT_CP, "Contempt");
      this._setBoolOptIfSupported(["White Contempt"], DRAGON_WHITE_CONTEMPT, "WhiteContempt");
      this._setBoolOptIfSupported(["Use Regular Eval"], DRAGON_USE_REGULAR_EVAL, "UseRegularEval");
      this._setBoolOptIfSupported(["Use MCTS"], DRAGON_USE_MCTS, "UseMCTS");
      this._setOptIfSupported(["Table Memory"], DRAGON_TABLE_MEMORY_MB, "TableMemory");
      return;
    }

    // generic_original
    this._setOptIfSupported(["Contempt"], TOURNAMENT_CONTEMPT_CP, "Contempt");
    this._setBoolOptIfSupported(["White Contempt"], false, "WhiteContempt");
    this._setBoolOptIfSupported(["UCI_LimitStrength"], false, "UCI_LimitStrength");
  }

  async init(defaults = {}, syzygyPath = null, syzygyOpts = null) {
    this.ensureAliveOrThrow();
    this.send("uci");

    // ✅ uciok wait with timeout (prevents startup hangs)
    await new Promise((resolve, reject) => {
      let done = false;
      const timeoutMs = Math.max(1000, Number(UCIOK_TIMEOUT_MS) || 12000);

      const onOk = () => {
        if (done) return;
        done = true;
        cleanup();
        resolve();
      };

      const onErr = (e) => {
        if (done) return;
        done = true;
        cleanup();
        reject(new Error(`[Engine ${this.side}] uci handshake error: ${e?.message || e}`));
      };

      const onTimeout = () => {
        if (done) return;
        done = true;
        cleanup();
        reject(new Error(`[Engine ${this.side}] uciok timeout (${timeoutMs}ms)`));
      };

      const cleanup = () => {
        try { this.off("uciok", onOk); } catch {}
        try { this.off("error", onErr); } catch {}
        try { clearTimeout(t); } catch {}
      };

      const t = setTimeout(onTimeout, timeoutMs);
      this.on("uciok", onOk);
      this.on("error", onErr);
    });

    this.profile = this._detectTournamentProfile();
    evidence(`UCI tournament profile ${this.profile} for ${this.side}${this.name ? ` (${this.name})` : ` (${path.basename(this.exePath)})`}`);
    this._writeLog(`[evidence] profile=${this.profile}`);

    this._applyCommonTournamentOptions(defaults);
    this._applyTournamentProfileOptions(this.profile);

    if (syzygyPath) {
      const p = String(syzygyPath).trim();
      this._setOptIfSupported("SyzygyPath", p, "SyzygyPath");
    }

    // ✅ Syzygy behaviour control (optional, safe)
    // These are *engine options*, not proxy rules.
    const pl = (syzygyOpts && Number.isFinite(Number(syzygyOpts.probeLimit))) ? Number(syzygyOpts.probeLimit) : null;
    const pd = (syzygyOpts && Number.isFinite(Number(syzygyOpts.probeDepth))) ? Number(syzygyOpts.probeDepth) : null;
    const r50 = (syzygyOpts && typeof syzygyOpts.rule50 === "boolean") ? syzygyOpts.rule50 : null;

    if (pl != null) this._setOptIfSupported("SyzygyProbeLimit", Math.max(0, Math.min(7, Math.floor(pl))), "SyzygyProbeLimit");
    if (pd != null) this._setOptIfSupported("SyzygyProbeDepth", Math.max(1, Math.floor(pd)), "SyzygyProbeDepth");
    if (r50 != null) this._setBoolOptIfSupported(["Syzygy50MoveRule"], r50, "Syzygy50MoveRule");

    this.send("isready");

    // ✅ readyok wait with timeout (prevents startup hangs)
    await new Promise((resolve, reject) => {
      let done = false;
      const timeoutMs = Math.max(1000, Number(READYOK_TIMEOUT_MS) || 12000);

      const onOk = () => {
        if (done) return;
        done = true;
        cleanup();
        resolve();
      };

      const onErr = (e) => {
        if (done) return;
        done = true;
        cleanup();
        reject(new Error(`[Engine ${this.side}] ready handshake error: ${e?.message || e}`));
      };

      const onTimeout = () => {
        if (done) return;
        done = true;
        cleanup();
        reject(new Error(`[Engine ${this.side}] readyok timeout (${timeoutMs}ms)`));
      };

      const cleanup = () => {
        try { this.off("readyok", onOk); } catch {}
        try { this.off("error", onErr); } catch {}
        try { clearTimeout(t); } catch {}
      };

      const t = setTimeout(onTimeout, timeoutMs);
      this.on("readyok", onOk);
      this.on("error", onErr);
    });

    this.ready = true;
  }

  async goPositionStartpos(movesUci = []) {
    this.ensureAliveOrThrow();
    if (!movesUci || movesUci.length === 0) this.send("position startpos");
    else this.send(`position startpos moves ${movesUci.join(" ")}`);
  }

  goTimeControl(w_ms, b_ms, inc_ms) {
    this.ensureAliveOrThrow();
    const wtime = Math.max(MIN_TIME_MS, Number(w_ms) | 0);
    const btime = Math.max(MIN_TIME_MS, Number(b_ms) | 0);
    const winc = Math.max(0, Number(inc_ms) | 0);
    const binc = Math.max(0, Number(inc_ms) | 0);
    this.send(`go wtime ${wtime} btime ${btime} winc ${winc} binc ${binc}`);
  }

  goMovetime(ms) {
    this.ensureAliveOrThrow();
    const t = Math.max(1, Number(ms) | 0);
    this.send(`go movetime ${t}`);
  }

  goDepth(depth) {
    this.ensureAliveOrThrow();
    const d = Math.max(1, Number(depth) | 0);
    this.send(`go depth ${d}`);
  }

  async waitBestmove(timeoutMs = BESTMOVE_TIMEOUT_MS) {
    this.bestmove = null;

    return await new Promise((resolve) => {
      let settled = false;

      const onBm = (bm) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(bm?.bestmove || "");
      };

      const cleanup = () => {
        try { this.off("bestmove", onBm); } catch {}
        try { clearTimeout(timer1); } catch {}
        try { clearTimeout(timer2); } catch {}
      };

      const timer1 = setTimeout(() => {
        try { this.stop(); } catch {}
        timer2 = setTimeout(() => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve("");
        }, Math.max(0, STOP_GRACE_MS));
      }, Math.max(1, timeoutMs));

      let timer2 = null;

      this.on("bestmove", onBm);
    });
  }

  quit() {
    try { this.dead = true; } catch {}
    try { this.safeWrite("stop"); } catch {}
    try { this.safeWrite("quit"); } catch {}

    const p = this.proc;
    this.proc = null;

    try { p?.kill(); } catch {}
    try { this._logStream?.end(); } catch {}
  }
}

function rrPairs(engines) {
  const pairs = [];
  for (let i = 0; i < engines.length; i++) {
    for (let j = i + 1; j < engines.length; j++) pairs.push([i, j]);
  }
  return pairs;
}

// -------------------------------
// Main loop
// -------------------------------
export async function startMatchLoop(cfg) {
  evidence(`Proxy loop start: pid=${process.pid} node=${process.version}`);

  evidence(`PGN writer mode: uci_proxy=${PROXY_WRITES_PGN ? "ON" : "OFF"} (server_writes_pgn=${SERVER_WRITES_PGN ? "YES" : "NO"})`);
  evidence(`PGN bundle path: ${PGN_BUNDLE_PATH}`);

  const enginesPaths = Array.isArray(cfg?.engines) ? cfg.engines.filter(Boolean) : [];
  if (enginesPaths.length < 2) throw new Error(`[IJCCRL] Need at least 2 engines`);

  const tcBaseMs = Number(cfg?.tcBaseMs ?? 10 * 60 * 1000);
  const tcIncMs  = Number(cfg?.tcIncMs ?? 0);

  const openingsPgnPath     = String(cfg?.openingsPgnPath || "").trim();
  const openingsPlyLimit    = Number(cfg?.openingsPlyLimit ?? 16);
  const openingsSourceLabel = String(cfg?.openingsSourceLabel || "UHO").trim();

  const syzygyPath = cfg?.syzygyPath ? String(cfg.syzygyPath) : null;

  // ✅ Syzygy option policy (from env; can be overridden in cfg later if you want)
  const syzygyOpts = {
    probeLimit: (cfg?.syzygyProbeLimit != null ? Number(cfg.syzygyProbeLimit) : ENV_SYZ_PROBE_LIMIT),
    probeDepth: (cfg?.syzygyProbeDepth != null ? Number(cfg.syzygyProbeDepth) : ENV_SYZ_PROBE_DEPTH),
    rule50:     (typeof cfg?.syzygy50MoveRule === "boolean" ? cfg.syzygy50MoveRule : ENV_SYZ_50_MOVE_RULE),
  };

  evidence(
    `Syzygy cfg: path=${syzygyPath || "<empty>"} ` +
    `probeLimit=${syzygyOpts.probeLimit ?? "<unset>"} ` +
    `probeDepth=${syzygyOpts.probeDepth ?? "<unset>"} ` +
    `50MoveRule=${(typeof syzygyOpts.rule50 === "boolean") ? String(syzygyOpts.rule50) : "<unset>"}`
  );

  // ✅ TB Turbo runtime policy (proxy-level). Uses SyzygyProbeLimit semantics (pieces including kings).
  const tbTurbo = {
    enabled: false,
    pieceLimit: null,
    mode: TB_TURBO_MODE,
    movetimeMs: Math.max(1, Math.floor(TB_TURBO_MOVETIME_MS)),
    depth: Math.max(1, Math.floor(TB_TURBO_DEPTH)),
  };

  const plFromSyzygy = Number.isFinite(Number(syzygyOpts.probeLimit)) ? Math.floor(Number(syzygyOpts.probeLimit)) : null;
  const plTurbo = Number.isFinite(TB_TURBO_PIECE_LIMIT_ENV) ? Math.floor(TB_TURBO_PIECE_LIMIT_ENV) : plFromSyzygy;

  if (plTurbo != null) tbTurbo.pieceLimit = Math.max(2, Math.min(7, plTurbo));
  tbTurbo.enabled = !!(TB_TURBO && syzygyPath && tbTurbo.pieceLimit != null && tbTurbo.pieceLimit >= 2);

  evidence(
    `TB Turbo: ${tbTurbo.enabled ? "ON" : "OFF"} ` +
    `mode=${tbTurbo.mode} pieceLimit=${tbTurbo.pieceLimit ?? "<unset>"} ` +
    `movetimeMs=${tbTurbo.movetimeMs} depth=${tbTurbo.depth}`
  );

  evidence(`Live clock heartbeat: ${LIVE_CLOCK_HEARTBEAT_MS > 0 ? "ON" : "OFF"} intervalMs=${LIVE_CLOCK_HEARTBEAT_MS}`);

  const defaults   = cfg?.defaults || { threads: 1, hashMb: 64 };

  const callbacks  = cfg?.callbacks || {};
  const onMeta     = callbacks?.onMeta    || (() => {});
  const onClocks   = callbacks?.onClocks  || (() => {});
  const onInfo     = callbacks?.onInfo    || (() => {});
  const onMoves    = callbacks?.onMoves   || (() => {});
  const onPgn      = callbacks?.onPgn     || (() => {});
  const onResults  = callbacks?.onResults || (() => {});
  const onGameEnd  = callbacks?.onGameEnd || (() => {});

  // ✅ Prefer stable ids from server.js (ENGINE_IDS). Fallback: basename keys.
  const engineIds = Array.isArray(cfg?.engineIds) && cfg.engineIds.length === enginesPaths.length
    ? cfg.engineIds.map(String)
    : enginesPaths.map(baseNameNoExt);

  // ✅ Map stable id -> path (from server.js if provided)
  const enginePathById = (cfg?.enginePathById && typeof cfg.enginePathById === "object")
    ? cfg.enginePathById
    : Object.fromEntries(engineIds.map((id, i) => [id, enginesPaths[i]]));

  // Load openings chunks once
  let openingsChunks = [];
  const openingParsedCache = new Map(); // idx0 -> parsed opening
  if (openingsPgnPath && fileExists(openingsPgnPath)) {
    evidence(`Loading openings (sync) from ${openingsPgnPath}...`);
    try {
      const raw = fs.readFileSync(openingsPgnPath, "utf8");
      openingsChunks = splitPgnGames(raw);
      evidence(`Openings loaded: ${openingsChunks.length} from ${openingsPgnPath}`);
    } catch (e) {
      console.warn("[IJCCRL] failed to read openings file:", e?.message || e);
      openingsChunks = [];
    }
  } else {
    evidence(`Openings file missing: ${openingsPgnPath}`);
  }

  function getOpeningByPos(pos0) {
    if (!openingsChunks.length) return null;
    const i = Math.max(0, Math.min(openingsChunks.length - 1, Number(pos0) | 0));
    return { idx0: i, idx1: i + 1, chunk: openingsChunks[i] };
  }

  async function parseOpeningChunk(openingObj) {
    if (!openingObj || !openingObj.chunk) return null;
    const key = openingObj.idx0;
    if (openingParsedCache.has(key)) return openingParsedCache.get(key);

    const parsed = await movesTextToUciList(openingObj.chunk, openingsPlyLimit);
    if (!parsed) return null;

    const label = formatOpeningLabel(parsed.tags || {});
    const eco = String((parsed.tags?.ECO || parsed.tags?.Eco || parsed.tags?.eco || "")).trim();
    const moves = String(parsed.movesUci || "").trim().split(/\s+/).filter(Boolean);

    const out = {
      idx: openingObj.idx1, // 1-based line index in file order
      eco,
      label,
      tags: parsed.tags || {},
      rawMovesUci: parsed.movesUci || "",
      moves,
    };

    openingParsedCache.set(key, out);
    return out;
  }

  // -------------------------------
  // Game runner
  // -------------------------------
  let matchNo = 0;

  function chooseRoundNo(ijccrlCycle, fallbackMatchNo) {
    const s = String(ijccrlCycle ?? "").trim();
    const n = Number(s);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
    return fallbackMatchNo;
  }

  function getSchedulerTotals(serverScheduler) {
    try {
      const st = serverScheduler && typeof serverScheduler.debugState === "function"
        ? serverScheduler.debugState()
        : null;
      const rr = st?.rr || st?.meta || null;
      const roundsTotal = Number(rr?.roundsTotal);
      const pairsPerRound = Number(rr?.pairsPerRound);
      return {
        roundsTotal: Number.isFinite(roundsTotal) && roundsTotal > 0 ? roundsTotal : null,
        pairsPerRound: Number.isFinite(pairsPerRound) && pairsPerRound > 0 ? pairsPerRound : null,
      };
    } catch {
      return { roundsTotal: null, pairsPerRound: null };
    }
  }

  const runGame = async ({
    whiteId, blackId, whitePath, blackPath, openingLine, flipLabel,

    ijccrlPhase,
    ijccrlCycle,
    ijccrlOpeningIndex,
    ijccrlOpeningBlock,

    ijccrlPairIndex,
    ijccrlPairGameNo,

    ijccrlRoundsTotal,
    ijccrlPairsPerRound,

    openingPos0,
  }) => {
    const whiteKey = String(whiteId || "").trim();
    const blackKey = String(blackId || "").trim();

    let whiteDisplay = whiteKey || baseNameNoExt(whitePath);
    let blackDisplay = blackKey || baseNameNoExt(blackPath);

    matchNo++;

    const roundNo = chooseRoundNo(ijccrlCycle, matchNo);

    const gameId =
      `game-${matchNo}-R${roundNo}-P${String(ijccrlPairIndex ?? "").trim() || "?"}` +
      `-G${String(ijccrlPairGameNo ?? "").trim() || "?"}-${flipLabel}-${whiteKey}-vs-${blackKey}-${nowStamp()}`;

    const outDir = path.join(process.cwd(), "out");
    safeMkdir(outDir);

    const logFileW = path.join(outDir, `${gameId}-W.txt`);
    const logFileB = path.join(outDir, `${gameId}-B.txt`);

    const openingMoves = openingLine?.moves ? openingLine.moves.slice(0, openingsPlyLimit) : [];
    const openingLabel = openingLine ? openingLine.label : "—";
    const openingEco = openingLine?.eco ? openingLine.eco : "";

    const openingRefIdx1 = Number.isFinite(Number(openingPos0)) ? (Number(openingPos0) + 1) : (openingLine?.idx || "");
    const openingTag = `{${path.basename(openingsPgnPath)} #${openingRefIdx1}}`;

    const openingName = (openingLabel && openingLabel !== "—") ? openingLabel : (openingEco ? openingEco : "—");

    const cycleStr = (ijccrlCycle != null ? String(ijccrlCycle) : "");
    const pairIndexStr = (ijccrlPairIndex != null ? String(ijccrlPairIndex) : "");
    const pairGameNoStr = (ijccrlPairGameNo != null ? String(ijccrlPairGameNo) : "");

    const roundsTotalStr = (ijccrlRoundsTotal != null ? String(ijccrlRoundsTotal) : "");
    const pairsPerRoundStr = (ijccrlPairsPerRound != null ? String(ijccrlPairsPerRound) : "");

    onMeta({
      meta_kind: "start",
      round_no: roundNo,
      game_id: gameId,

      white_key: whiteKey,
      black_key: blackKey,

      white: whiteDisplay,
      black: blackDisplay,
      white_display: whiteDisplay,
      black_display: blackDisplay,

      opening: openingName,
      opening_eco: openingEco,
      openingMoves: openingMoves.join(" "),
      opening_source: openingsSourceLabel,
      opening_ref: openingTag,

      ijccrl_phase: String(ijccrlPhase || IJCCRL_PHASE_NAME || "").trim(),
      ijccrl_cycle: cycleStr,
      ijccrl_opening_index: (ijccrlOpeningIndex != null ? String(ijccrlOpeningIndex) : ""),
      ijccrl_opening_block: String(ijccrlOpeningBlock || openingEco || "").trim(),
      ijccrl_pair_index: pairIndexStr,
      ijccrl_pair_game_no: pairGameNoStr,

      cycle: cycleStr,
      pairIndex: pairIndexStr,
      pairGameNo: pairGameNoStr,
      openingIndex: (ijccrlOpeningIndex != null ? String(ijccrlOpeningIndex) : ""),
      openingBlock: String(ijccrlOpeningBlock || openingEco || "").trim(),

      roundsTotal: roundsTotalStr,
      pairsPerRound: pairsPerRoundStr,
      legTotal: "2",
    });

    const wEng = new UCIEngine(whitePath, "w", { logFile: logFileW });
    const bEng = new UCIEngine(blackPath, "b", { logFile: logFileB });

    let tbHitsWMax = 0;
    let tbHitsBMax = 0;
    let tbReportedW = false;
    let tbReportedB = false;
    let tbEvidencePrinted = false;
    let tbTurboEvidenceOnce = false;

    const maybeUpdateMeta = () => {
      const wName = (wEng.name && wEng.name.trim()) ? wEng.name.trim() : whiteDisplay;
      const bName = (bEng.name && bEng.name.trim()) ? bEng.name.trim() : blackDisplay;

      if (wName !== whiteDisplay || bName !== blackDisplay) {
        whiteDisplay = wName;
        blackDisplay = bName;

        onMeta({
          meta_kind: "update",
          round_no: roundNo,
          game_id: gameId,

          white_key: whiteKey,
          black_key: blackKey,

          white: whiteDisplay,
          black: blackDisplay,
          white_display: whiteDisplay,
          black_display: blackDisplay,

          opening: openingName,
          opening_eco: openingEco,
          openingMoves: openingMoves.join(" "),
          opening_source: openingsSourceLabel,
          opening_ref: openingTag,

          ijccrl_phase: String(ijccrlPhase || IJCCRL_PHASE_NAME || "").trim(),
          ijccrl_cycle: cycleStr,
          ijccrl_opening_index: (ijccrlOpeningIndex != null ? String(ijccrlOpeningIndex) : ""),
          ijccrl_opening_block: String(ijccrlOpeningBlock || openingEco || "").trim(),
          ijccrl_pair_index: pairIndexStr,
          ijccrl_pair_game_no: pairGameNoStr,

          cycle: cycleStr,
          pairIndex: pairIndexStr,
          pairGameNo: pairGameNoStr,
          openingIndex: (ijccrlOpeningIndex != null ? String(ijccrlOpeningIndex) : ""),
          openingBlock: String(ijccrlOpeningBlock || openingEco || "").trim(),

          roundsTotal: roundsTotalStr,
          pairsPerRound: pairsPerRoundStr,
          legTotal: "2",
        });
      }
    };

    const gameStartMs = Date.now();
    let termination = "unknown";
    let reason = "";
    let resultFinal = "*";

    const Chess = await ensureChessNode();
    const chess = new Chess();
    const rep = new Map();

    // ✅ Always-defined live state (used for safe-finalize on fatal errors)
    let moves = [...openingMoves];
    let ply = moves.length;
    let turn = (ply % 2 === 0) ? "w" : "b";
    let wRemain = tcBaseMs;
    let bRemain = tcBaseMs;
    let finalized = false;
    let fatalMsg = "";

    for (const uci of openingMoves) {
      const from = uci.slice(0, 2);
      const to = uci.slice(2, 4);
      const promo = uci[4] ? uci[4].toLowerCase() : undefined;
      const mv = chess.move({ from, to, promotion: promo });
      if (!mv) break;
      const key = fenKeyForRepetition(chess.fen());
      rep.set(key, (rep.get(key) || 0) + 1);
    }

    try {
      wEng.spawn();
      bEng.spawn();

      wEng.on("info", (info) => {
        if (info && Object.prototype.hasOwnProperty.call(info, "tbhits")) tbReportedW = true;
        const th = Number(info?.tbhits);
        if (Number.isFinite(th)) tbHitsWMax = Math.max(tbHitsWMax, th);
        if (!tbEvidencePrinted && (tbHitsWMax + tbHitsBMax) > 0) {
          tbEvidencePrinted = true;
          evidence(`TBHits detected (during game ${gameId}): W=${tbHitsWMax} B=${tbHitsBMax}`);
        }
        onInfo("w", info);
      });

      bEng.on("info", (info) => {
        if (info && Object.prototype.hasOwnProperty.call(info, "tbhits")) tbReportedB = true;
        const th = Number(info?.tbhits);
        if (Number.isFinite(th)) tbHitsBMax = Math.max(tbHitsBMax, th);
        if (!tbEvidencePrinted && (tbHitsWMax + tbHitsBMax) > 0) {
          tbEvidencePrinted = true;
          evidence(`TBHits detected (during game ${gameId}): W=${tbHitsWMax} B=${tbHitsBMax}`);
        }
        onInfo("b", info);
      });

      wEng.on("id", () => maybeUpdateMeta());
      bEng.on("id", () => maybeUpdateMeta());

      await wEng.init(defaults, syzygyPath, syzygyOpts);
      await bEng.init(defaults, syzygyPath, syzygyOpts);
      maybeUpdateMeta();

      moves = [...openingMoves];
      const derived = computeTurnFromMovesArray(moves);
      ply = derived.ply;
      turn = derived.turn;

      wRemain = tcBaseMs;
      bRemain = tcBaseMs;

      onMoves(moves.join(" "), { ply, turn });
      emitClockSnapshot(onClocks, { w_ms: wRemain, b_ms: bRemain, turn });

      while (true) {
        const eng = (turn === "w") ? wEng : bEng;

        await eng.goPositionStartpos(moves);

        const t0 = Date.now();

        // ✅ TB Turbo ("toque") — avoid wasting clock time in Syzygy endgames
        // If enabled and material <= tbTurbo.pieceLimit, we send a tiny movetime (or depth) instead of clock-based go.
        let usedTbTurbo = false;
        try {
          if (tbTurbo && tbTurbo.enabled && tbTurbo.pieceLimit != null) {
            const pc = countPiecesFromFen(chess.fen());
            if (pc > 0 && pc <= tbTurbo.pieceLimit) {
              usedTbTurbo = true;
              if (!tbTurboEvidenceOnce) {
                tbTurboEvidenceOnce = true;
                evidence(`TB Turbo active (game ${gameId}): pieces=${pc} limit=${tbTurbo.pieceLimit} mode=${tbTurbo.mode} movetimeMs=${tbTurbo.movetimeMs} depth=${tbTurbo.depth}`);
              }
              if (tbTurbo.mode === "depth") eng.goDepth(tbTurbo.depth);
              else eng.goMovetime(tbTurbo.movetimeMs);
            }
          }
        } catch {}

        if (!usedTbTurbo) {
          eng.goTimeControl(wRemain, bRemain, tcIncMs);
        }

        const stopClockHeartbeat = startLiveClockHeartbeat({
          turn,
          wRemain,
          bRemain,
          onClocks,
          intervalMs: LIVE_CLOCK_HEARTBEAT_MS,
        });

        const bm = await eng.waitBestmove(BESTMOVE_TIMEOUT_MS);
        try { stopClockHeartbeat(); } catch {}

        const spent = Math.max(0, Date.now() - t0);

        if (turn === "w") wRemain = Math.max(0, wRemain - spent + tcIncMs);
        else             bRemain = Math.max(0, bRemain - spent + tcIncMs);

        if (wRemain <= 0) { termination = "flag"; reason = "white flag (time)"; resultFinal = "0-1"; break; }
        if (bRemain <= 0) { termination = "flag"; reason = "black flag (time)"; resultFinal = "1-0"; break; }

        if (!bm || bm === "(none)") {
          termination = "no_bestmove";
          reason = "engine returned no bestmove / timeout";
          resultFinal = (NO_BESTMOVE_POLICY === "loss")
            ? ((turn === "w") ? "0-1" : "1-0")
            : "1/2-1/2";
          break;
        }

        const from = bm.slice(0, 2);
        const to = bm.slice(2, 4);
        const promo = bm[4] ? bm[4].toLowerCase() : undefined;
        const mv = chess.move({ from, to, promotion: promo });

        if (!mv) {
          termination = "illegal_move";
          reason = `illegal move: ${bm}`;
          resultFinal = (turn === "w") ? "0-1" : "1-0";
          break;
        }

        moves.push(bm);
        ply++;

        const key = fenKeyForRepetition(chess.fen());
        rep.set(key, (rep.get(key) || 0) + 1);

        if (isCheckmate(chess)) {
          termination = "checkmate";
          reason = "checkmate";
          resultFinal = (turn === "w") ? "1-0" : "0-1";
        } else if (isStalemate(chess)) {
          termination = "stalemate";
          reason = "stalemate";
          resultFinal = "1/2-1/2";
        } else if (isInsufficientMaterial(chess)) {
          termination = "insufficient_material";
          reason = "insufficient material";
          resultFinal = "1/2-1/2";
        } else if (isThreefold(chess, rep)) {
          termination = "threefold_repetition";
          reason = "threefold repetition";
          resultFinal = "1/2-1/2";
        } else if (isFiftyMove(chess)) {
          termination = "fifty_move_rule";
          reason = "50-move rule";
          resultFinal = "1/2-1/2";
        } else {
          resultFinal = "*";
        }

        const nextTurn = (turn === "w") ? "b" : "w";

        onMoves(moves.join(" "), { ply, turn: nextTurn });
        emitClockSnapshot(onClocks, { w_ms: wRemain, b_ms: bRemain, turn: nextTurn });

        if (resultFinal !== "*") break;

        turn = nextTurn;

        if (ply > 800) {
          termination = "ply_limit";
          reason = "ply limit reached";
          resultFinal = "1/2-1/2";
          break;
        }
      }

      const gameDurationMs = Date.now() - gameStartMs;
      const tbHitsTotal = tbHitsWMax + tbHitsBMax;

      evidence(
        `Game summary ${gameId}: result=${resultFinal} plies=${ply} ` +
        `termination=${termination} TBHitsTotal=${tbHitsTotal} (W=${tbHitsWMax}, B=${tbHitsBMax})`
      );

      const summary = {
        game_id: gameId,
        round_no: roundNo,

        white_key: whiteKey,
        black_key: blackKey,

        white: whiteDisplay,
        black: blackDisplay,

        result: resultFinal,
        termination,
        reason,
        plies: ply,
        moves_uci: moves.join(" "),
        tc_base_ms: tcBaseMs,
        tc_inc_ms: tcIncMs,
        opening: openingName,
        opening_eco: openingEco,
        opening_ref: openingTag,
        opening_source: openingsSourceLabel,
        syzygy_path: syzygyPath || "",
        tb_hits_white: tbHitsWMax,
        tb_hits_black: tbHitsBMax,
        tb_hits_total: tbHitsTotal,
        tb_reported_white: tbReportedW ? 1 : 0,
        tb_reported_black: tbReportedB ? 1 : 0,
        duration_ms: gameDurationMs,

        ijccrl_phase: String(ijccrlPhase || IJCCRL_PHASE_NAME || "").trim(),
        ijccrl_cycle: (ijccrlCycle != null ? String(ijccrlCycle) : ""),
        ijccrl_opening_index: (ijccrlOpeningIndex != null ? String(ijccrlOpeningIndex) : ""),
        ijccrl_opening_block: String(ijccrlOpeningBlock || openingEco || "").trim(),

        ijccrl_pair_index: (ijccrlPairIndex != null ? String(ijccrlPairIndex) : ""),
        ijccrl_pair_game_no: (ijccrlPairGameNo != null ? String(ijccrlPairGameNo) : ""),
      };

      const pgnText = await buildPgnFromUciMoves({
        white: whiteDisplay,
        black: blackDisplay,
        result: resultFinal,
        movesUci: moves.join(" "),
        openingEco,
        openingName,
        openingRef: openingTag,
        openingsSourceLabel,
        tcBaseMs,
        tcIncMs,
        roundNo,
        tbHitsW: tbHitsWMax,
        tbHitsB: tbHitsBMax,
        tbHitsTotal,
        tbReportedW,
        tbReportedB,
        termination: reason || termination,
        gameDurationMs,

        ijccrlPhase: String(ijccrlPhase || IJCCRL_PHASE_NAME || "").trim(),
        ijccrlCycle,
        ijccrlOpeningIndex,
        ijccrlOpeningBlock: String(ijccrlOpeningBlock || openingEco || "").trim(),

        ijccrlPairIndex,
        ijccrlPairGameNo,
      });

      onPgn({ pgn: pgnText, summary });

      appendPgnBundle(pgnText);

      persistResultsGame({
        id: gameId,
        round_no: roundNo,

        white_key: whiteKey,
        black_key: blackKey,

        white_display: whiteDisplay,
        black_display: blackDisplay,

        result: resultFinal,
        termination,
        reason,
        plies: ply,
        duration_ms: gameDurationMs,
        tb_hits_white: tbHitsWMax,
        tb_hits_black: tbHitsBMax,
        tb_hits_total: tbHitsTotal,
        tb_reported_white: tbReportedW ? 1 : 0,
        tb_reported_black: tbReportedB ? 1 : 0,

        ijccrl_phase: String(ijccrlPhase || IJCCRL_PHASE_NAME || "").trim(),
        ijccrl_cycle: (ijccrlCycle != null ? String(ijccrlCycle) : ""),
        ijccrl_opening_index: (ijccrlOpeningIndex != null ? String(ijccrlOpeningIndex) : ""),
        ijccrl_opening_block: String(ijccrlOpeningBlock || openingEco || "").trim(),

        ijccrl_pair_index: (ijccrlPairIndex != null ? String(ijccrlPairIndex) : ""),
        ijccrl_pair_game_no: (ijccrlPairGameNo != null ? String(ijccrlPairGameNo) : ""),
      });

      const snap = getResultsSnapshot();

      onResults({
        engines: engineIds,
        rows: snap.rows,
        games: snap.games,

        game: {
          id: gameId,

          white_key: whiteKey,
          black_key: blackKey,

          white: whiteDisplay,
          black: blackDisplay,

          result: resultFinal,
          moves_uci: moves.join(" "),
          tb_hits_white: tbHitsWMax,
          tb_hits_black: tbHitsBMax,
          tb_hits_total: tbHitsTotal,
          tb_reported_white: tbReportedW ? 1 : 0,
          tb_reported_black: tbReportedB ? 1 : 0,
          duration_ms: gameDurationMs,
          termination,
          reason,

          ijccrl_phase: String(ijccrlPhase || IJCCRL_PHASE_NAME || "").trim(),
          ijccrl_cycle: (ijccrlCycle != null ? String(ijccrlCycle) : ""),
          ijccrl_opening_index: (ijccrlOpeningIndex != null ? String(ijccrlOpeningIndex) : ""),
          ijccrl_opening_block: String(ijccrlOpeningBlock || openingEco || "").trim(),

          ijccrl_pair_index: (ijccrlPairIndex != null ? String(ijccrlPairIndex) : ""),
          ijccrl_pair_game_no: (ijccrlPairGameNo != null ? String(ijccrlPairGameNo) : ""),
        },
        summary,
      });

      onGameEnd(summary);

      finalized = true;

    } catch (e) {
      fatalMsg = String(e && e.message ? e.message : e);
      console.error("[IJCCRL] match fatal:", fatalMsg);

      // If we crashed before producing a final result, decide a deterministic forfeit:
      // - Engine w fails => 0-1
      // - Engine b fails => 1-0
      // - Unknown => draw
      if (resultFinal === "*" || !resultFinal) {
        const side =
          fatalMsg.includes("[Engine w]") ? "w" :
          fatalMsg.includes("[Engine b]") ? "b" :
          null;
        resultFinal = (side === "w") ? "0-1" : (side === "b") ? "1-0" : "1/2-1/2";
      }

      if (!termination || termination === "unknown") termination = "proxy_fatal";
      if (!reason) reason = fatalMsg || "proxy fatal";

    } finally {

      // ✅ SAFE FINALIZE: never leave a pending scheduler slot without a written PGN/results,
      // even if an engine fails to spawn/init. This prevents "pending" stalls.
      if (!finalized) {
        try {
          const gameDurationMs = Date.now() - gameStartMs;
          const tbHitsTotal = tbHitsWMax + tbHitsBMax;

          evidence(
            `Game summary ${gameId}: result=${resultFinal} plies=${ply} ` +
            `termination=${termination} TBHitsTotal=${tbHitsTotal} (W=${tbHitsWMax}, B=${tbHitsBMax}) [safe-finalize]`
          );

          const summary = {
            game_id: gameId,
            round_no: roundNo,

            white_key: whiteKey,
            black_key: blackKey,

            white: whiteDisplay,
            black: blackDisplay,

            result: resultFinal,
            termination,
            reason,
            plies: ply,
            moves_uci: moves.join(" "),
            tc_base_ms: tcBaseMs,
            tc_inc_ms: tcIncMs,
            opening: openingName,
            opening_eco: openingEco,
            opening_ref: openingTag,
            opening_source: openingsSourceLabel,
            syzygy_path: syzygyPath || "",
            tb_hits_white: tbHitsWMax,
            tb_hits_black: tbHitsBMax,
            tb_hits_total: tbHitsTotal,
            tb_reported_white: tbReportedW ? 1 : 0,
            tb_reported_black: tbReportedB ? 1 : 0,
            duration_ms: gameDurationMs,

            ijccrl_phase: String(ijccrlPhase || IJCCRL_PHASE_NAME || "").trim(),
            ijccrl_cycle: (ijccrlCycle != null ? String(ijccrlCycle) : ""),
            ijccrl_opening_index: (ijccrlOpeningIndex != null ? String(ijccrlOpeningIndex) : ""),
            ijccrl_opening_block: String(ijccrlOpeningBlock || openingEco || "").trim(),

            ijccrl_pair_index: (ijccrlPairIndex != null ? String(ijccrlPairIndex) : ""),
            ijccrl_pair_game_no: (ijccrlPairGameNo != null ? String(ijccrlPairGameNo) : ""),
          };

          let pgnText = "";
          try {
            pgnText = await buildPgnFromUciMoves({
              white: whiteDisplay,
              black: blackDisplay,
              result: resultFinal,
              movesUci: moves.join(" "),
              openingEco,
              openingName,
              openingRef: openingTag,
              openingsSourceLabel,
              tcBaseMs,
              tcIncMs,
              roundNo,
              tbHitsW: tbHitsWMax,
              tbHitsB: tbHitsBMax,
              tbHitsTotal,
              tbReportedW,
              tbReportedB,
              termination: reason || termination,
              gameDurationMs,

              ijccrlPhase: String(ijccrlPhase || IJCCRL_PHASE_NAME || "").trim(),
              ijccrlCycle,
              ijccrlOpeningIndex,
              ijccrlOpeningBlock: String(ijccrlOpeningBlock || openingEco || "").trim(),

              ijccrlPairIndex,
              ijccrlPairGameNo,
            });
          } catch (e) {
            // last resort PGN
            pgnText = `[Event "IJCCRL Live"]\n[Site "IJCCRL"]\n[Date "${fmtDateYYYYMMDD()}"]\n[Round "${roundNo}"]\n[White "${whiteDisplay}"]\n[Black "${blackDisplay}"]\n[Result "${resultFinal}"]\n\n${resultFinal}\n`;
          }

          try { onPgn({ pgn: pgnText, summary }); } catch {}
          try { appendPgnBundle(pgnText); } catch {}

          try {
            persistResultsGame({
              id: gameId,
              round_no: roundNo,

              white_key: whiteKey,
              black_key: blackKey,

              white_display: whiteDisplay,
              black_display: blackDisplay,

              result: resultFinal,
              termination,
              reason,
              plies: ply,
              duration_ms: gameDurationMs,
              tb_hits_white: tbHitsWMax,
              tb_hits_black: tbHitsBMax,
              tb_hits_total: tbHitsTotal,
              tb_reported_white: tbReportedW ? 1 : 0,
              tb_reported_black: tbReportedB ? 1 : 0,

              ijccrl_phase: String(ijccrlPhase || IJCCRL_PHASE_NAME || "").trim(),
              ijccrl_cycle: (ijccrlCycle != null ? String(ijccrlCycle) : ""),
              ijccrl_opening_index: (ijccrlOpeningIndex != null ? String(ijccrlOpeningIndex) : ""),
              ijccrl_opening_block: String(ijccrlOpeningBlock || openingEco || "").trim(),

              ijccrl_pair_index: (ijccrlPairIndex != null ? String(ijccrlPairIndex) : ""),
              ijccrl_pair_game_no: (ijccrlPairGameNo != null ? String(ijccrlPairGameNo) : ""),
            });
          } catch {}

          const snap = getResultsSnapshot();

          try {
            onResults({
              engines: engineIds,
              rows: snap.rows,
              games: snap.games,

              game: {
                id: gameId,

                white_key: whiteKey,
                black_key: blackKey,

                white: whiteDisplay,
                black: blackDisplay,

                result: resultFinal,
                moves_uci: moves.join(" "),
                tb_hits_white: tbHitsWMax,
                tb_hits_black: tbHitsBMax,
                tb_hits_total: tbHitsTotal,
                tb_reported_white: tbReportedW ? 1 : 0,
                tb_reported_black: tbReportedB ? 1 : 0,
                duration_ms: gameDurationMs,
                termination,
                reason,

                ijccrl_phase: String(ijccrlPhase || IJCCRL_PHASE_NAME || "").trim(),
                ijccrl_cycle: (ijccrlCycle != null ? String(ijccrlCycle) : ""),
                ijccrl_opening_index: (ijccrlOpeningIndex != null ? String(ijccrlOpeningIndex) : ""),
                ijccrl_opening_block: String(ijccrlOpeningBlock || openingEco || "").trim(),

                ijccrl_pair_index: (ijccrlPairIndex != null ? String(ijccrlPairIndex) : ""),
                ijccrl_pair_game_no: (ijccrlPairGameNo != null ? String(ijccrlPairGameNo) : ""),
              },
              summary,
            });
          } catch {}

          try { onGameEnd(summary); } catch {}

          finalized = true;
        } catch (e) {
          console.error("[IJCCRL] safe-finalize failed:", e && e.message ? e.message : e);
        }
      }

      try { wEng.quit(); } catch {}
      try { bEng.quit(); } catch {}
    }

    return { resultFinal };
  };

  // -------------------------------
  // MODE A) SERVER scheduler (Phase 1)
  // -------------------------------
  const serverScheduler = cfg?.scheduler && cfg.scheduler.enabled && typeof cfg.scheduler.nextGame === "function"
    ? cfg.scheduler
    : null;

  const totals = getSchedulerTotals(serverScheduler);

  if (serverScheduler) {
    evidence("Scheduling: using SERVER scheduler (cfg.scheduler.nextGame).");

    while (true) {
      let next = null;
      try {
        next = serverScheduler.nextGame();
      } catch (e) {
        console.error('[IJCCRL] scheduler.nextGame threw:', e && e.message ? e.message : e);
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }
      if (!next) {
        evidence("Scheduling DONE: server scheduler returned null.");
        if (String(process.env.IJCCRL_SCHEDULER_CONTINUOUS || "0") === "1") {
          evidence("continuous=1 -> waiting (delete out/scheduler_state.json to restart).");
          await new Promise(r => setTimeout(r, 30_000));
          continue;
        }
        return;
      }

      const whiteId = String(next.white || "").trim();
      const blackId = String(next.black || "").trim();

      evidence(`Next scheduled: W=${whiteId} vs B=${blackId} OI=${next.openingIndex ?? (next.openingPos0 != null ? (Number(next.openingPos0) + 1) : '?')} cycle=${next.cycle ?? next.cycleNo ?? ''} pair=${next.pairIndex ?? ''} leg=${next.pairGameNo ?? ''}`);


      const whitePath = enginePathById[whiteId];
      const blackPath = enginePathById[blackId];

      if (!whitePath || !blackPath) {
        console.warn("[IJCCRL] missing engine path mapping for:", { whiteId, blackId });
        continue;
      }

      const openingObj = getOpeningByPos(next.openingPos0);
      let openingLine = null;
      try {
        openingLine = await parseOpeningChunk(openingObj);
      } catch (e) {
        console.warn('[IJCCRL] opening parse failed; continuing with startpos. err=', e && e.message ? e.message : e);
        openingLine = null;
      }

      const ijPhase = String(next.phase || next.ijccrl_phase || IJCCRL_PHASE_NAME || "").trim();
      const ijCycle = (next.cycle != null ? next.cycle : (next.ijccrl_cycle != null ? next.ijccrl_cycle : ""));

      const ijOpeningIndex =
        (next.openingIndex != null ? next.openingIndex :
         (next.opening_idx != null ? next.opening_idx :
          (openingLine?.idx != null ? openingLine.idx : "")));

      const ijOpeningBlock =
        String(next.openingBlock || next.opening_block || (openingLine?.eco || "")).trim();

      const ijPairIndex =
        (next.pairIndex != null ? next.pairIndex :
         (next.pair_index != null ? next.pair_index :
          (next.pairIdx != null ? next.pairIdx : "")));

      const ijPairGameNo =
        (next.pairGameNo != null ? next.pairGameNo :
         (next.pair_game_no != null ? next.pair_game_no :
          (next.pairGame != null ? next.pairGame : "")));

      const pairGameNoStr = String(ijPairGameNo ?? "").trim();

      await runGame({
        whiteId,
        blackId,
        whitePath,
        blackPath,
        openingLine,

        openingPos0: next.openingPos0,

        flipLabel: pairGameNoStr === "1" ? "S1" : "S2",

        ijccrlPhase: ijPhase,
        ijccrlCycle: ijCycle,
        ijccrlOpeningIndex: ijOpeningIndex,
        ijccrlOpeningBlock: ijOpeningBlock,

        ijccrlPairIndex: ijPairIndex,
        ijccrlPairGameNo: ijPairGameNo,

        ijccrlRoundsTotal: totals.roundsTotal,
        ijccrlPairsPerRound: totals.pairsPerRound,
      });
    }
  }

  // -------------------------------
  // MODE B) legacy RR loop (only if server scheduler disabled)
  // -------------------------------
  evidence("Scheduler disabled -> fallback to legacy RR loop.");

  const pairs = rrPairs(enginesPaths);

  let legacyChunks = openingsChunks;
  if (!legacyChunks.length && openingsPgnPath && fileExists(openingsPgnPath)) {
    try {
      const raw = fs.readFileSync(openingsPgnPath, "utf8");
      legacyChunks = splitPgnGames(raw);
    } catch {
      legacyChunks = [];
    }
  }
  let legacyOpenCursor = 0;

  async function legacyNextOpeningLine() {
    if (!legacyChunks.length) return null;
    const idx0 = legacyOpenCursor % legacyChunks.length;
    legacyOpenCursor = (legacyOpenCursor + 1) % legacyChunks.length;
    const openingObj = { idx0, idx1: idx0 + 1, chunk: legacyChunks[idx0] };
    return await parseOpeningChunk(openingObj);
  }

  while (true) {
    for (let pIdx = 0; pIdx < pairs.length; pIdx++) {
      const openingLine = await legacyNextOpeningLine();
      const [iA, iB] = pairs[pIdx];

      const whiteId = engineIds[iA];
      const blackId = engineIds[iB];

      await runGame({
        whiteId,
        blackId,
        whitePath: enginesPaths[iA],
        blackPath: enginesPaths[iB],
        openingLine,
        openingPos0: (openingLine?.idx ? (Number(openingLine.idx) - 1) : 0),
        flipLabel: "S1",

        ijccrlPhase: IJCCRL_PHASE_NAME,
        ijccrlCycle: "",
        ijccrlOpeningIndex: String(openingLine?.idx ?? ""),
        ijccrlOpeningBlock: String(openingLine?.eco || "").trim(),

        ijccrlPairIndex: String(pIdx + 1),
        ijccrlPairGameNo: "1",

        ijccrlRoundsTotal: "",
        ijccrlPairsPerRound: "",
      });

      await runGame({
        whiteId: blackId,
        blackId: whiteId,
        whitePath: enginesPaths[iB],
        blackPath: enginesPaths[iA],
        openingLine,
        openingPos0: (openingLine?.idx ? (Number(openingLine.idx) - 1) : 0),
        flipLabel: "S2",

        ijccrlPhase: IJCCRL_PHASE_NAME,
        ijccrlCycle: "",
        ijccrlOpeningIndex: String(openingLine?.idx ?? ""),
        ijccrlOpeningBlock: String(openingLine?.eco || "").trim(),

        ijccrlPairIndex: String(pIdx + 1),
        ijccrlPairGameNo: "2",

        ijccrlRoundsTotal: "",
        ijccrlPairsPerRound: "",
      });
    }
  }
}

export default { startMatchLoop };