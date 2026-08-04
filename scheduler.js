// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Jorge Ruiz Centelles
// scheduler.js
// IJCCRL — Deterministic RR Scheduler (Crash-safe + Hole repair)
// ✅ Pair-blocked legs: for each pair => Game 1 then Game 2 (colour swap) using SAME opening (by round)
// Node ESM ("type":"module")
// Patch: 2026-03-01 • Scheduler robustness — resolve engine keys + prevent pending stalls

import fs from "node:fs";
import path from "node:path";

// --------------------
// FS helpers
// --------------------
function safeMkdir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
}
function fileExists(p) {
  try { return fs.existsSync(p) && fs.statSync(p).isFile(); } catch { return false; }
}
function readTextSafe(p) {
  try { return fs.readFileSync(p, "utf8"); } catch { return ""; }
}
function readJsonSafe(p, fallback = null) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fallback; }
}
function clampInt(v, lo, hi, def) {
  const n = Number.parseInt(String(v ?? ""), 10);
  if (!Number.isFinite(n)) return def;
  return Math.max(lo, Math.min(hi, n));
}
function loadState(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}
function saveState(p, obj) {
  const dir = path.dirname(p);
  safeMkdir(dir);
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
  fs.renameSync(tmp, p);
}

// Split PGN into games (used for openings suite)
function splitPgnGames(pgnText) {
  const t = String(pgnText || "").replace(/\r/g, "").trim();
  if (!t) return [];
  return t.split(/\n\s*\n(?=\[Event\s")/g).map(s => s.trim()).filter(Boolean);
}

// ECO extraction from an opening chunk
function parseEcoFromOpeningChunk(openingChunk) {
  const s = String(openingChunk || "");
  const m = s.match(/^\[ECO\s+"([^"]+)"\]/m);
  return m ? String(m[1]).trim() : "";
}

// --------------------
// RR pairings (circle method on indices)
// --------------------
function buildRoundsEven(n) {
  if (n < 2 || (n % 2) !== 0) throw new Error("buildRoundsEven: n must be even >= 2");
  const fixed = 0;
  let rest = [];
  for (let i = 1; i < n; i++) rest.push(i);

  const rounds = [];
  for (let r = 0; r < n - 1; r++) {
    const arr = [fixed, ...rest];
    const pairs = [];
    for (let i = 0; i < n / 2; i++) {
      const a = arr[i];
      const b = arr[n - 1 - i];
      pairs.push([a, b]);
    }
    rounds.push(pairs);

    // rotate rest: last -> front
    rest = [rest[rest.length - 1], ...rest.slice(0, rest.length - 1)];
  }
  return rounds; // length = n-1, each round has n/2 pairs [aIdx,bIdx]
}

function makeCounts(engines) {
  const counts = {};
  for (const e of engines) counts[e] = { w: 0, b: 0, g: 0 };
  return counts;
}

// --------------------
// Engine key normalisation (compat across server/uci_proxy variants)
// - Accept either engine IDs, display names, or exe paths
// - Helps avoid scheduler stalls if onGameFinished() receives non-canonical keys
// --------------------
function normalizeEngineKey(k) {
  let s = String(k || "").trim();
  if (!s) return "";
  s = s.replace(/\\/g, "/");
  if (s.includes("/")) s = s.split("/").pop() || s;
  s = s.replace(/\.exe$/i, "");
  s = s.replace(/\s+/g, " ").trim();
  return s.toLowerCase();
}

function parseEngineAliases(raw) {
  if (!raw) return {};
  if (typeof raw === "object" && !Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(String(raw));
    return (parsed && typeof parsed === "object" && !Array.isArray(parsed)) ? parsed : {};
  } catch {
    return {};
  }
}

function buildEngineKeyResolver(engines, aliasSource = {}) {
  const map = new Map();
  for (const e of engines) {
    map.set(normalizeEngineKey(e), e);
  }

  const aliases = parseEngineAliases(aliasSource);
  for (const [aliasKey, canonicalRaw] of Object.entries(aliases)) {
    const canonical = map.get(normalizeEngineKey(canonicalRaw)) || String(canonicalRaw || "").trim();
    if (canonical) map.set(normalizeEngineKey(aliasKey), canonical);
  }

  return function resolveEngineKey(k) {
    const n = normalizeEngineKey(k);
    return map.get(n) || null;
  };
}


// --------------------
// games.pgn index (for hole detection + pending commit)
// --------------------
function readOpeningIndexSet(gamesPgnPath) {
  const txt = readTextSafe(gamesPgnPath);
  const done = new Set();
  let maxDone = 0;

  const re = /^\[IJCCRL_OpeningIndex\s+"(\d+)"\]/gm;
  let m;
  while ((m = re.exec(txt)) !== null) {
    const n = Number.parseInt(m[1], 10);
    if (Number.isFinite(n) && n > 0) {
      done.add(n);
      if (n > maxDone) maxDone = n;
    }
  }

  const count = (txt.match(/^\[Event\s+"/gm) || []).length;
  return { done, maxDone, count };
}

function firstMissingUpTo(doneSet, upToInclusive) {
  for (let i = 1; i <= upToInclusive; i++) {
    if (!doneSet.has(i)) return i;
  }
  return null;
}

// ✅ Pair-blocked mapping:
// per round: pairsPerRound pairs × 2 games = gamesPerRound
// per cycleSet: roundsTotal rounds × gamesPerRound = 240
function posFromOpeningIndex(openingIndexHuman, roundsTotal, pairsPerRound) {
  const idx0 = openingIndexHuman - 1;

  const gamesPerRound = pairsPerRound * 2;         // 8*2 = 16
  const gamesPerCycle = roundsTotal * gamesPerRound; // 15*16 = 240

  const cycleSetNo = Math.floor(idx0 / gamesPerCycle) + 1;
  const withinCycle = idx0 % gamesPerCycle;

  const roundNo = Math.floor(withinCycle / gamesPerRound) + 1; // 1..15
  const withinRound = withinCycle % gamesPerRound;

  const pairInRound = Math.floor(withinRound / 2); // 0..7
  const legNo = (withinRound % 2) + 1;              // 1..2

  return { cycleSetNo, legNo, roundNo, pairInRound };
}

// Compute openingBasePos0 for a given cycleSetNo based on current state's base/cycle
function baseSeedFromState(state, roundsTotal, openingsUsed) {
  const used = Math.max(1, openingsUsed);
  const cyc = clampInt(state.cycleSetNo, 1, 1_000_000_000, 1);
  const base = clampInt(state.openingBasePos0, 0, 1_000_000_000, 0) % used;
  const delta = ((cyc - 1) * roundsTotal) % used;
  let seed = base - delta;
  seed %= used;
  if (seed < 0) seed += used;
  return seed;
}
function baseForCycle(seed, cycleSetNo, roundsTotal, openingsUsed) {
  const used = Math.max(1, openingsUsed);
  return (seed + ((cycleSetNo - 1) * roundsTotal)) % used;
}

function loadResultsCounts(resultsPath, resolveEngineKey) {
  const out = { counts: {}, maxOpeningIndex: 0, gamesCount: 0 };
  const json = readJsonSafe(resultsPath, null);
  const games = Array.isArray(json?.games) ? json.games : [];
  out.gamesCount = games.length;

  for (const g of games) {
    const white = resolveEngineKey(g?.white_key || g?.white || "") || String(g?.white_key || g?.white || "").trim();
    const black = resolveEngineKey(g?.black_key || g?.black || "") || String(g?.black_key || g?.black || "").trim();
    const oi = clampInt(g?.ijccrl_opening_index ?? g?.openingIndex, 0, 1_000_000_000, 0);

    if (oi > out.maxOpeningIndex) out.maxOpeningIndex = oi;

    if (white) {
      if (!out.counts[white]) out.counts[white] = { w: 0, b: 0, g: 0 };
      out.counts[white].w += 1;
      out.counts[white].g += 1;
    }
    if (black) {
      if (!out.counts[black]) out.counts[black] = { w: 0, b: 0, g: 0 };
      out.counts[black].b += 1;
      out.counts[black].g += 1;
    }
  }

  return out;
}

function countsAreAllZero(counts, engines) {
  for (const e of engines) {
    const c = counts?.[e];
    if (c && (Number(c.w) > 0 || Number(c.b) > 0 || Number(c.g) > 0)) return false;
  }
  return true;
}

// --------------------
// Scheduler
// --------------------
export function createScheduler(opts = {}) {
  const engines = Array.isArray(opts.engines) ? opts.engines.map(String) : [];
  if (engines.length < 2) throw new Error("createScheduler: need at least 2 engines");
  if (engines.length % 2 !== 0) {
    throw new Error(`createScheduler: engines count must be EVEN for round-based scheduler. Got ${engines.length}`);
  }
  const enginesSet = new Set(engines);

  const engineAliases = opts.engineAliases ?? process.env.IJCCRL_ENGINE_ALIASES_JSON ?? {};
  const resolveEngineKey = buildEngineKeyResolver(engines, engineAliases);

  const outDir = String(opts.outDir || path.join(process.cwd(), "out"));
  const statePath = String(opts.statePath || path.join(outDir, "scheduler_state.json"));
  const resultsPath = String(opts.resultsPath || path.join(outDir, "results.json"));
  const gamesPgnPath = path.join(outDir, "games.pgn");

  // Targets (Phase 1 semantics)
  const perEngineGamesTarget = clampInt(opts.perEngineGamesTarget, 1, 100_000, 250);
  const perEngineWhiteTarget = clampInt(opts.perEngineWhiteTarget, 0, perEngineGamesTarget, Math.floor(perEngineGamesTarget / 2));
  const perEngineBlackTarget = clampInt(opts.perEngineBlackTarget, 0, perEngineGamesTarget, perEngineGamesTarget - perEngineWhiteTarget);

  // ---- Openings load
  const openingsPath = String(opts.openingsPath || "").trim();
  const requestedOpeningsMax = clampInt(opts.openingsMax, 1, 100_000, 250);

  let openingsChunks = [];
  if (openingsPath && fileExists(openingsPath)) {
    try {
      const raw = fs.readFileSync(openingsPath, "utf8");
      openingsChunks = splitPgnGames(raw);
    } catch {
      openingsChunks = [];
    }
  }

  const openingsCount = openingsChunks.length;
  const openingsMax = Math.min(openingsCount || 0, requestedOpeningsMax);
  const openingsUsed = (openingsMax > 0) ? openingsMax : 1;

  // ---- Round-robin rounds
  const rounds = buildRoundsEven(engines.length); // length = N-1
  const roundsTotal = rounds.length;              // e.g. 15 for N=16
  const pairsPerRound = engines.length / 2;       // e.g. 8 for N=16

  // ---- Load/init state (schema-gated)
  const loaded = loadState(statePath);

  const state = {
    schema: 4,

    // cycle repetition (each is a full cycle = 240 games for N=16)
    cycleSetNo: 1,
    openingBasePos0: 0,

    // RR cursor (openingIndex is 0-based internal; human = openingIndex+1)
    openingIndex: 0,
    legNo: 1,        // ✅ PairGameNo within pair: 1..2
    roundNo: 1,      // 1..roundsTotal
    pairInRound: 0,  // 0..pairsPerRound-1

    counts: makeCounts(engines),
    last: {
      white: "",
      black: "",
      openingPos0: 0,
      openingIndex: 0,
      cycleNo: 1,
      pairIndex: 1,
      pairGameNo: 1,
      cycleSetNo: 1,
      openingBasePos0: 0,
    },

    // pending game (crash-safe, prevents holes)
    pending: null, // { mode:"cursor"|"repair", openingIndex, white, black, cycleSetNo, legNo, roundNo, pairInRound, openingPos0, openingBlock }
  };

  // ✅ Only resume if schema matches
  if (loaded && typeof loaded === "object" && Number(loaded.schema) === 4) {
    state.cycleSetNo = clampInt(loaded.cycleSetNo, 1, 1_000_000_000, state.cycleSetNo);
    state.openingBasePos0 = clampInt(loaded.openingBasePos0, 0, 1_000_000_000, state.openingBasePos0) % openingsUsed;

    state.legNo = clampInt(loaded.legNo, 1, 2, state.legNo);
    state.roundNo = clampInt(loaded.roundNo, 1, roundsTotal, state.roundNo);
    state.pairInRound = clampInt(loaded.pairInRound, 0, pairsPerRound - 1, state.pairInRound);

    state.openingIndex = clampInt(loaded.openingIndex, 0, 1_000_000_000, state.openingIndex);

    if (loaded.counts && typeof loaded.counts === "object") {
      for (const [rawEngineKey, rawCounts] of Object.entries(loaded.counts)) {
        const resolvedEngineKey = resolveEngineKey(rawEngineKey) || String(rawEngineKey || "").trim();
        if (!resolvedEngineKey || !enginesSet.has(resolvedEngineKey)) continue;
        if (!rawCounts || typeof rawCounts !== "object") continue;

        const w = clampInt(rawCounts.w, 0, 1_000_000_000, 0);
        const b = clampInt(rawCounts.b, 0, 1_000_000_000, 0);
        const g = clampInt(rawCounts.g, 0, 1_000_000_000, 0);

        if (!state.counts[resolvedEngineKey]) state.counts[resolvedEngineKey] = { w: 0, b: 0, g: 0 };
        state.counts[resolvedEngineKey].w += w;
        state.counts[resolvedEngineKey].b += b;
        state.counts[resolvedEngineKey].g += g;
      }
    }

    if (loaded.last && typeof loaded.last === "object") {
      state.last = { ...state.last, ...loaded.last };
      state.last.white = resolveEngineKey(state.last.white) || String(state.last.white || "").trim();
      state.last.black = resolveEngineKey(state.last.black) || String(state.last.black || "").trim();
    }

    if (loaded.pending && typeof loaded.pending === "object") {
      state.pending = { ...loaded.pending };
      state.pending.white = resolveEngineKey(state.pending.white) || String(state.pending.white || "").trim();
      state.pending.black = resolveEngineKey(state.pending.black) || String(state.pending.black || "").trim();
    }
  }

  if (countsAreAllZero(state.counts, engines)) {
    const rebuilt = loadResultsCounts(resultsPath, resolveEngineKey);
    for (const e of engines) {
      if (rebuilt.counts[e]) state.counts[e] = rebuilt.counts[e];
    }
  }

  function persist() {
    saveState(statePath, state);
  }

  function allDoneCompat() {
    for (const e of engines) {
      const c = state.counts[e];
      if (!c) return false;
      if (c.g < perEngineGamesTarget) return false;
      if (!(c.w >= perEngineWhiteTarget && c.b >= perEngineBlackTarget)) return false;
    }
    return true;
  }

  // ✅ Pair-blocked advance:
  // game1 -> game2 (same pair, swapped colours)
  // game2 -> next pair; after last pair -> next round; after last round -> next cycleSet (+openingBase shift)
  function advanceAfterGame() {
    state.openingIndex += 1;

    if (state.legNo === 1) {
      state.legNo = 2;
      return;
    }

    // legNo == 2 finished => move to next pair
    state.legNo = 1;
    state.pairInRound += 1;

    if (state.pairInRound >= pairsPerRound) {
      state.pairInRound = 0;
      state.roundNo += 1;

      if (state.roundNo > roundsTotal) {
        state.roundNo = 1;
        state.cycleSetNo += 1;

        // carry UHO forward by exactly roundsTotal openings each cycleSet
        state.openingBasePos0 = (state.openingBasePos0 + roundsTotal) % openingsUsed;
      }
    }
  }

  function buildGameForPosition(cycleSetNo, legNo, roundNo, pairInRound, openingIndexHuman) {
    const roundIdx0 = roundNo - 1;
    const pairIdx0 = pairInRound;

    const rrPair = rounds[roundIdx0][pairIdx0]; // [aIdx, bIdx]
    const a = engines[rrPair[0]];
    const b = engines[rrPair[1]];

    const isLeg2 = (legNo === 2);
    const white = isLeg2 ? b : a;
    const black = isLeg2 ? a : b;

    const seed = baseSeedFromState(state, roundsTotal, openingsUsed);
    const basePos0 = baseForCycle(seed, cycleSetNo, roundsTotal, openingsUsed);

    // opening by ROUND (same for all pairs in this round), with cycle base offset
    const openingPos0 = (basePos0 + roundIdx0) % openingsUsed;

    const openingChunk = (openingsChunks && openingsChunks.length > 0) ? openingsChunks[openingPos0] : "";
    const openingBlock = parseEcoFromOpeningChunk(openingChunk);

    const cycleNo = roundNo;           // audit intent: cycleNo = roundNo
    const pairIndex1 = pairIdx0 + 1;   // 1..pairsPerRound

    return {
      white,
      black,
      openingPos0,

      // canonical fields
      cycleNo,
      pairIndex: pairIndex1,
      pairGameNo: legNo,

      // aliases
      cycle: cycleNo,
      pair_index: pairIndex1,
      pair_game_no: legNo,

      // audit helpers
      openingIndex: openingIndexHuman,
      openingBlock,

      // extra audit context for long runs
      cycleSetNo,
      openingBasePos0: basePos0,
    };
  }

  function stagePending(p) {
    state.pending = p;
    persist();
  }

  function commitPendingIfWritten(pgnIndex) {
    if (!state.pending || !state.pending.openingIndex) return false;

    const oi = Number(state.pending.openingIndex);
    if (!Number.isFinite(oi) || oi <= 0) return false;

    if (!pgnIndex.done.has(oi)) return false;

    const w = resolveEngineKey(state.pending.white) || String(state.pending.white || "").trim();
    const b = resolveEngineKey(state.pending.black) || String(state.pending.black || "").trim();

    if (w && b && enginesSet.has(w) && enginesSet.has(b)) {
      if (!state.counts[w]) state.counts[w] = { w: 0, b: 0, g: 0 };
      if (!state.counts[b]) state.counts[b] = { w: 0, b: 0, g: 0 };
      state.counts[w].w += 1; state.counts[w].g += 1;
      state.counts[b].b += 1; state.counts[b].g += 1;
    }

    const mode = String(state.pending.mode || "cursor");
    state.pending = null;

    if (mode === "cursor") {
      advanceAfterGame();
    }

    persist();
    return true;
  }

  function nextGame() {
    const pgnIndex = readOpeningIndexSet(gamesPgnPath);

    // If pending exists and game already got written, commit it (restart-safe)
    if (commitPendingIfWritten(pgnIndex)) {
      // fall through and schedule the next thing
    }

    // If still pending (not written yet), re-serve it (prevents holes)
    if (state.pending && state.pending.openingIndex && !pgnIndex.done.has(Number(state.pending.openingIndex))) {
      return {
        white: state.pending.white,
        black: state.pending.black,
        openingPos0: state.pending.openingPos0,
        cycleNo: state.pending.cycleNo,
        pairIndex: state.pending.pairIndex,
        pairGameNo: state.pending.pairGameNo,
        cycle: state.pending.cycleNo,
        pair_index: state.pending.pairIndex,
        pair_game_no: state.pending.pairGameNo,
        openingIndex: state.pending.openingIndex,
        openingBlock: state.pending.openingBlock,
        cycleSetNo: state.pending.cycleSetNo,
        openingBasePos0: state.pending.openingBasePos0,
      };
    }

    // Hole repair: if cursor progressed past some indices, but games.pgn is missing them, fill them first.
    const repairOi = firstMissingUpTo(pgnIndex.done, state.openingIndex);
    if (repairOi != null) {
      const pos = posFromOpeningIndex(repairOi, roundsTotal, pairsPerRound);
      const game = buildGameForPosition(pos.cycleSetNo, pos.legNo, pos.roundNo, pos.pairInRound, repairOi);

      state.last = { ...game };
      stagePending({
        mode: "repair",
        openingIndex: repairOi,
        white: game.white,
        black: game.black,
        openingPos0: game.openingPos0,
        openingBlock: game.openingBlock,
        cycleNo: game.cycleNo,
        pairIndex: game.pairIndex,
        pairGameNo: game.pairGameNo,
        cycleSetNo: game.cycleSetNo,
        openingBasePos0: game.openingBasePos0,
        legNo: pos.legNo,
        roundNo: pos.roundNo,
        pairInRound: pos.pairInRound,
      });
      return game;
    }

    if (allDoneCompat()) return null;

    // Normal scheduling: emit next cursor game, but DO NOT advance state yet.
    const openingIndexHuman = state.openingIndex + 1;
    const game = buildGameForPosition(state.cycleSetNo, state.legNo, state.roundNo, state.pairInRound, openingIndexHuman);

    state.last = { ...game };
    stagePending({
      mode: "cursor",
      openingIndex: openingIndexHuman,
      white: game.white,
      black: game.black,
      openingPos0: game.openingPos0,
      openingBlock: game.openingBlock,
      cycleNo: game.cycleNo,
      pairIndex: game.pairIndex,
      pairGameNo: game.pairGameNo,
      cycleSetNo: game.cycleSetNo,
      openingBasePos0: game.openingBasePos0,
      legNo: state.legNo,
      roundNo: state.roundNo,
      pairInRound: state.pairInRound,
    });

    return game;
  }

  function onGameFinished(white, black) {
    // Accept canonical engine IDs, display names, or exe paths.
    // If keys don't match exactly, try a normalised resolver to prevent "pending" stalls.
    let wRaw = String(white || "").trim();
    let bRaw = String(black || "").trim();
    if (!wRaw || !bRaw) return;

    const wResolved = resolveEngineKey(wRaw) || wRaw;
    const bResolved = resolveEngineKey(bRaw) || bRaw;

    // If still unknown, but matches the current pending (after normalisation), commit using pending keys.
    if (!enginesSet.has(wResolved) || !enginesSet.has(bResolved)) {
      const pend = state.pending;
      if (pend && pend.white && pend.black) {
        const nw = normalizeEngineKey(wRaw);
        const nb = normalizeEngineKey(bRaw);
        const pw = normalizeEngineKey(pend.white);
        const pb = normalizeEngineKey(pend.black);

        if (nw === pw && nb === pb) {
          wRaw = String(pend.white).trim();
          bRaw = String(pend.black).trim();
        } else {
          // Keep last-seen for diagnostics, but do not advance cursor.
          if (!state.last || typeof state.last !== "object") state.last = {};
          if (!state.last.white) state.last.white = wResolved;
          if (!state.last.black) state.last.black = bResolved;
          persist();
          return;
        }
      } else {
        if (!state.last || typeof state.last !== "object") state.last = {};
        if (!state.last.white) state.last.white = wResolved;
        if (!state.last.black) state.last.black = bResolved;
        persist();
        return;
      }
    } else {
      wRaw = wResolved;
      bRaw = bResolved;
    }

    const w = wRaw;
    const b = bRaw;

    if (!state.counts[w]) state.counts[w] = { w: 0, b: 0, g: 0 };
    if (!state.counts[b]) state.counts[b] = { w: 0, b: 0, g: 0 };

    state.counts[w].w += 1;
    state.counts[w].g += 1;

    state.counts[b].b += 1;
    state.counts[b].g += 1;

    if (!state.last || typeof state.last !== "object") state.last = {};
    if (!state.last.white) state.last.white = w;
    if (!state.last.black) state.last.black = b;

    if (state.pending && state.pending.openingIndex) {
      const mode = String(state.pending.mode || "cursor");
      state.pending = null;

      if (mode === "cursor") {
        advanceAfterGame();
      }
    }

    persist();
  }

  function debugState() {
    const pgnIndex = readOpeningIndexSet(gamesPgnPath);
    const nextHole = firstMissingUpTo(pgnIndex.done, state.openingIndex);

    return {
      openingIndex: state.openingIndex,
      cycleSetNo: state.cycleSetNo,
      openingBasePos0: state.openingBasePos0,

      legNo: state.legNo,
      roundNo: state.roundNo,
      pairInRound: state.pairInRound,

      roundsTotal,
      pairsPerRound,

      counts: state.counts,
      last: state.last,
      pending: state.pending,

      pgn: {
        gamesCount: pgnIndex.count,
        maxOpeningIndexSeen: pgnIndex.maxDone,
        nextMissingUpToCursor: nextHole,
      },

      targets: { perEngineGamesTarget, perEngineWhiteTarget, perEngineBlackTarget },
      openings: { openingsCount, openingsMax, openingsUsed, openingsPath },
      resultsPath,
    };
  }

  // persist initial state (ensures pending field exists)
  persist();

  return {
    statePath,
    resultsPath,
    openingsPath,
    openingsCount,
    openingsMax,

    nextGame,
    onGameFinished,
    debugState,
  };
}

export default { createScheduler };
