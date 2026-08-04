// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Jorge Ruiz Centelles
// server.js
// Patch: 2026-03-01 • WS compat (clocks/moves data mirror) + results→moves bridge
// Patch: 2026-03-19 • BE-01 — Broadcast Snapshot Keepalive / Live Clock Heartbeat (server-side authoritative state reassertion)
import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";

import express from "express";
import { WebSocketServer } from "ws";
import nodemailer from "nodemailer";

import { PGNStore } from "./pgn_store.js";
import { startMatchLoop } from "./uci_proxy.js";

// ✅ Deterministic scheduler
import { createScheduler } from "./scheduler.js";

// ✅ NEW: Guest chat (no tokens) + rate-limit + admin commands
import { attachChatWss } from "./tools/chat_ws.js";
import { createSupportStore } from "./tools/support_store.js";
import { createSupportAuth } from "./tools/support_auth.js";
import { createPaypalSupport } from "./tools/paypal_support.js";

// --------------------
// Paths
// --------------------
const ROOT = path.resolve(".");
const PUBLIC_DIR = path.join(ROOT, "public");
const DEV_VENDOR_DIR = path.join(ROOT, "_dev_vendor");

// --------------------
// Config
// --------------------
// ✅ Default port: 3012 (mini PC standard)
const PORT = parseInt(process.env.PORT || "3012", 10);

// Syzygy tablebases (3-6 pieces)
// Prefer IJCCRL_SYZYGY_PATH, then SYZYGY_PATH. No local tablebase path is enabled by default.
const SYZYGY_PATH = process.env.IJCCRL_SYZYGY_PATH || process.env.SYZYGY_PATH || "";

// ✅ Syzygy policy
// We default probeLimit to 6 when Syzygy path is configured (you have complete 3–6-men),
// but you can override with env: IJCCRL_SYZYGY_PROBE_LIMIT or SYZYGY_PROBE_LIMIT.
const SYZYGY_PROBE_LIMIT = (() => {
  const raw =
    process.env.IJCCRL_SYZYGY_PROBE_LIMIT ??
    process.env.SYZYGY_PROBE_LIMIT ??
    (SYZYGY_PATH ? "6" : "");
  const n = parseInt(String(raw || ""), 10);
  return Number.isFinite(n) ? n : null;
})();

// ✅ Syzygy path sanity check
if (SYZYGY_PATH) {
  try {
    if (!fs.existsSync(SYZYGY_PATH)) {
      console.warn(`[IJCCRL] WARNING: SYZYGY_PATH does not exist: ${SYZYGY_PATH}`);
    }
  } catch {}
}

// Openings
const DEFAULT_OPENINGS_PGN = "";
const OPENINGS_PGN_PATH = String(process.env.IJCCRL_OPENINGS_PGN || process.env.OPENINGS_PGN_PATH || DEFAULT_OPENINGS_PGN).trim();
const OPENINGS_PLY_LIMIT = parseInt(process.env.OPENINGS_PLY_LIMIT || process.env.IJCCRL_OPENINGS_PLY_LIMIT || "16", 10);
const OPENINGS_SOURCE_LABEL = String(process.env.IJCCRL_OPENINGS_SOURCE_LABEL || "Operator-supplied opening suite").trim();

// Engine defaults
const DEFAULT_THREADS = parseInt(process.env.IJCCRL_THREADS || "1", 10);
const DEFAULT_HASH_MB = parseInt(process.env.IJCCRL_HASH_MB || "64", 10);

// Time control
const TC_BASE_MS = parseInt(process.env.IJCCRL_BASE_MS || String(10 * 60 * 1000), 10);
const TC_INC_MS = parseInt(process.env.IJCCRL_INC_MS || "2000", 10);

// Clock mode
const CLOCK_MODE = String(process.env.IJCCRL_CLOCK_MODE || "passthrough").toLowerCase(); // passthrough | movetime(legacy)

// ✅ Anti-freeze: throttle info spam (ms)
const INFO_THROTTLE_MS = parseInt(process.env.IJCCRL_INFO_THROTTLE_MS || "250", 10);

// ✅ WS keepalive
const WS_PING_MS = parseInt(process.env.IJCCRL_WS_PING_MS || "20000", 10);

// ✅ BE-01: authoritative state keepalive
// Reassert the current broadcast state even when only incremental info packets are flowing.
const WS_STATE_KEEPALIVE_MS = Math.max(500, parseInt(process.env.IJCCRL_WS_STATE_KEEPALIVE_MS || "1500", 10));
const WS_STATE_KEEPALIVE_PGN_EVERY = Math.max(1, parseInt(process.env.IJCCRL_WS_STATE_KEEPALIVE_PGN_EVERY || "4", 10));
const WS_CONNECT_ENGINE_REPLAY_MS = Math.max(0, parseInt(process.env.IJCCRL_WS_CONNECT_ENGINE_REPLAY_MS || "90", 10));

// --------------------
// Engine score display contract (UI-facing)
// --------------------
// Keep raw engine score untouched, but expose display_* fields normalized for the UI.
// Default policy:
// - UI wants white-perspective scores
// - black-engine incoming score is assumed to be in engine-side perspective
const ENGINE_SCORE_ORIENTATION = String(
  process.env.IJCCRL_ENGINE_SCORE_ORIENTATION || "white_perspective"
).trim().toLowerCase();

const BLACK_ENGINE_SCORE_INPUT_FRAME = String(
  process.env.IJCCRL_BLACK_ENGINE_SCORE_INPUT_FRAME || "engine_side"
).trim().toLowerCase();


// --------------------
// ✅ NEW: Guest Chat Config
// --------------------
const OUT_DIR = path.join(process.cwd(), "out");

// Allowed origins (VERY IMPORTANT; protects WS from cross-site abuse)
// - Use semicolon-separated list in env: IJCCRL_CHAT_ORIGINS="https://ijccrl-live.ijccrl.com;https://ijccrl-liveavx2.ijccrl.com"
function parseSemicolonList(v) {
  if (!v) return [];
  return String(v).split(";").map(s => s.trim()).filter(Boolean);
}
const CHAT_ALLOWED_ORIGINS = (() => {
  const fromEnv = parseSemicolonList(process.env.IJCCRL_CHAT_ORIGINS);
  if (fromEnv.length) return fromEnv;

  // sensible defaults for local testing + your live host
  return [
    `http://127.0.0.1:${PORT}`,
    `http://localhost:${PORT}`,
    "https://ijccrl-live.ijccrl.com",
    "https://elite.ijccrl.com",
  ];
})();

// Admin secret for commands (/mute, /ban, /readonly, /slowmode, etc.)
const CHAT_ADMIN_SECRET = String(process.env.IJCCRL_CHAT_ADMIN_SECRET || process.env.IJCCRL_CHAT_ADMIN || "").trim();


// --------------------
// ✅ NEW: Premium support / PayPal config
// --------------------
const SUPPORT_COOKIE_NAME = String(process.env.IJCCRL_SUPPORT_COOKIE_NAME || "ijccrl_support").trim() || "ijccrl_support";
const SUPPORT_COOKIE_SECRET = String(
  process.env.IJCCRL_SUPPORT_COOKIE_SECRET ||
  process.env.IJCCRL_CHAT_ADMIN ||
  ""
).trim();
const SUPPORT_SECURE_COOKIES = String(process.env.IJCCRL_SUPPORT_SECURE_COOKIES || "false").toLowerCase() === "true";
const SUPPORT_SESSION_TTL_DAYS = Math.max(1, parseInt(process.env.IJCCRL_SUPPORT_SESSION_TTL_DAYS || "30", 10));
const SUPPORT_LOGIN_CODE_TTL_MINUTES = Math.max(5, parseInt(process.env.IJCCRL_SUPPORT_LOGIN_CODE_TTL_MINUTES || "15", 10));
const SUPPORT_PREMIUM_AMOUNT_EUR = Number.parseFloat(process.env.IJCCRL_SUPPORT_AMOUNT_EUR || "5");
const SUPPORT_PREMIUM_CURRENCY = String(process.env.IJCCRL_SUPPORT_CURRENCY || "EUR").trim() || "EUR";
const SUPPORT_PAYPAL_URL = String(process.env.IJCCRL_SUPPORT_PAYPAL_URL || "").trim();
const SUPPORT_PAYPAL_RETURN_PATH = String(process.env.IJCCRL_SUPPORT_PAYPAL_RETURN_PATH || "/support/paypal/return").trim() || "/support/paypal/return";
const SUPPORT_VERIFY_EMAIL_PATH = String(process.env.IJCCRL_SUPPORT_VERIFY_EMAIL_PATH || "/support/verify-email").trim() || "/support/verify-email";
const SUPPORT_RESET_PASSWORD_PATH = String(process.env.IJCCRL_SUPPORT_RESET_PASSWORD_PATH || "/support/reset-password").trim() || "/support/reset-password";
const SUPPORT_HOME_URL = String(process.env.IJCCRL_SUPPORT_HOME_URL || `http://127.0.0.1:${PORT}/`).trim() || `http://127.0.0.1:${PORT}/`;
const SUPPORT_PREMIUM_DURATION_DAYS = Math.max(1, parseInt(process.env.IJCCRL_SUPPORT_PREMIUM_DURATION_DAYS || "31", 10));
const SUPPORT_DEV_ECHO_CODES = String(process.env.IJCCRL_SUPPORT_DEV_ECHO_CODES || "false").toLowerCase() === "true";
const SUPPORT_MAIL_ENABLED = String(process.env.IJCCRL_SUPPORT_MAIL_ENABLED || "false").toLowerCase() === "true";
const SUPPORT_MAIL_FROM = String(process.env.IJCCRL_SUPPORT_MAIL_FROM || "").trim();
const SUPPORT_MAIL_REPLY_TO = String(process.env.IJCCRL_SUPPORT_MAIL_REPLY_TO || "").trim();
const SUPPORT_SMTP_HOST = String(process.env.IJCCRL_SUPPORT_SMTP_HOST || "").trim();
const SUPPORT_SMTP_PORT = Math.max(0, parseInt(process.env.IJCCRL_SUPPORT_SMTP_PORT || "0", 10) || 0);
const SUPPORT_SMTP_SECURE = String(process.env.IJCCRL_SUPPORT_SMTP_SECURE || "false").toLowerCase() === "true";
const SUPPORT_SMTP_USER = String(process.env.IJCCRL_SUPPORT_SMTP_USER || "").trim();
const SUPPORT_SMTP_PASS = String(process.env.IJCCRL_SUPPORT_SMTP_PASS || "");
const SUPPORT_MAIL_CONFIG_READY = Boolean(
  SUPPORT_MAIL_ENABLED &&
  SUPPORT_MAIL_FROM &&
  SUPPORT_SMTP_HOST &&
  SUPPORT_SMTP_PORT > 0 &&
  SUPPORT_SMTP_USER &&
  SUPPORT_SMTP_PASS
);
const VOTE_POLL_DURATION_SECONDS = Math.max(5, parseInt(process.env.IJCCRL_VOTE_POLL_SECONDS || "20", 10));
const VOTE_ENABLED = String(process.env.IJCCRL_VOTE_ENABLED || "true").toLowerCase() !== "false";
const VOTE_ALLOW_GUEST = String(process.env.IJCCRL_ALLOW_GUEST_VOTE || "true").toLowerCase() !== "false";
const VOTE_GUEST_COOKIE_NAME = String(process.env.IJCCRL_VOTE_GUEST_COOKIE_NAME || "ijccrl_guest_vote_id").trim() || "ijccrl_guest_vote_id";
const VOTE_GUEST_COOKIE_TTL_SECONDS = Math.max(86400, parseInt(process.env.IJCCRL_VOTE_GUEST_COOKIE_TTL_SECONDS || String(90 * 24 * 60 * 60), 10));
const VOTE_RATE_LIMIT_MS = Math.max(250, parseInt(process.env.IJCCRL_VOTE_RATE_LIMIT_MS || "800", 10));
const VOTE_RUNTIME_STATE_PATH = path.join(OUT_DIR, "vote_runtime_state.json");
const VOTE_POLLS_LOG_PATH = path.join(OUT_DIR, "vote_polls.jsonl");
const VOTE_BALLOTS_LOG_PATH = path.join(OUT_DIR, "vote_ballots.jsonl");
const VOTE_LEADERBOARD_PATH = path.join(OUT_DIR, "vote_leaderboard.json");
const VOTE_SELECTION_KEYS = ["white", "draw", "black"];
const VOTE_RESULT_LABELS = ["1-0", "½-½", "0-1"];

let supportStore = null;
let supportAuth = null;
let paypalSupport = null;
let supportMailer = null;
let supportMailDispatch = null;
let SUPPORT_ENABLED = false;

// --------------------
// ✅ Tournament Rules (declared)
// --------------------
const RULES_SPEC = {
  standard: String(process.env.IJCCRL_RULESET || "FIDE Laws of Chess (declared)").trim(),
  fifty_move_rule: String(process.env.IJCCRL_50_MOVE_RULE || "true").toLowerCase() !== "false",
  threefold_repetition: String(process.env.IJCCRL_3FOLD_RULE || "true").toLowerCase() !== "false",
  insufficient_material: String(process.env.IJCCRL_IM_RULE || "true").toLowerCase() !== "false",

  adjudication_enabled: String(process.env.IJCCRL_ADJ_ENABLED || "true").toLowerCase() !== "false",
  adjudicate_win_cp: parseInt(process.env.IJCCRL_ADJ_WIN_CP || "700", 10),
  adjudicate_win_moves: parseInt(process.env.IJCCRL_ADJ_WIN_MOVES || "8", 10),
  adjudicate_draw_cp: parseInt(process.env.IJCCRL_ADJ_DRAW_CP || "10", 10),
  adjudicate_draw_moves: parseInt(process.env.IJCCRL_ADJ_DRAW_MOVES || "10", 10),
  adjudicate_min_ply: parseInt(process.env.IJCCRL_ADJ_MIN_PLY || "80", 10),

  syzygy_claims: String(process.env.IJCCRL_SYZYGY_CLAIMS || (SYZYGY_PATH ? "enabled" : "disabled")).trim(),
  enforcement_status: String(process.env.IJCCRL_RULES_ENFORCEMENT || "declared (enforcement in progress)").trim(),
};

// --------------------
// ✅ IMPORTANT: prevent double-writer duplicates
// - If uci_proxy.js writes out/games.pgn, server.js MUST NOT write it.
// - Default: OFF (0) => server is read-only for PGN bundle.
// - Set IJCCRL_SERVER_WRITES_PGN=1 ONLY if uci_proxy does NOT write games.pgn.
// --------------------
const SERVER_WRITES_PGN = String(process.env.IJCCRL_SERVER_WRITES_PGN || "0").trim() === "1";
const PGN_BUNDLE_PATH = path.join(OUT_DIR, "games.pgn");

// --------------------
// PGN bundle store (out/games.pgn)
// --------------------
let pgnStore = null;
if (SERVER_WRITES_PGN) {
  pgnStore = new PGNStore({
    baseDir: process.cwd(),
    outDir: path.join(process.cwd(), "out"),
    bundleName: "games.pgn",
    writePerGame: true,
    debug: Boolean(process.env.IJCCRL_DEBUG_FILE),
  });
  await pgnStore.init();
} else {
  // read-only mode: uci_proxy is the writer
  pgnStore = null;
}

// --------------------
// Engines (mini-PC: ORIGINAL-ONLY, public AVX2 builds)
// --------------------
const ENGINES_DIR = process.env.IJCCRL_ENGINES_DIR || path.join(process.cwd(), "engines");
// Engine binaries are deliberately not distributed with this repository.
// Configure an even number of UCI engine executable paths through IJCCRL_ENGINES.
const DEFAULT_ENGINES = [];

function parseEnginesEnv(v) {
  if (!v) return null;
  const parts = String(v).split(";").map(s => s.trim()).filter(Boolean);
  return parts.length ? parts : null;
}

if (!OPENINGS_PGN_PATH || !fs.existsSync(OPENINGS_PGN_PATH)) {
  throw new Error("[IJCCRL][openings] Missing PGN opening suite. Set IJCCRL_OPENINGS_PGN to an existing PGN file.");
}

let ENGINES = parseEnginesEnv(process.env.IJCCRL_ENGINES) || DEFAULT_ENGINES;

// Hard safety: filter missing exes + enforce even count
ENGINES = ENGINES.filter(p => {
  const ok = fs.existsSync(p);
  if (!ok) console.warn(`[IJCCRL][engines] Missing EXE: ${p}`);
  return ok;
});

if (ENGINES.length < 2) {
  throw new Error("[IJCCRL][engines] No engines found. Set IJCCRL_ENGINES to an even, semicolon-separated list of UCI executable paths.");
}
if ((ENGINES.length % 2) !== 0) {
  throw new Error(`[IJCCRL][engines] Engine count must be even. Got ${ENGINES.length}`);
}

// ✅ Stable engine IDs (display names) for scheduler
function engineIdFromPath(p) {
  const base = path.basename(String(p || ""));
  const noExt = base.replace(/\.[^.]+$/, "");
  return noExt.trim() || base.trim() || "Engine";
}

// Ensure unique IDs (if two paths produce same basename)
function makeUniqueEngineIds(paths) {
  const seen = new Map();
  return paths.map((p) => {
    const raw = engineIdFromPath(p);
    const n = (seen.get(raw) || 0) + 1;
    seen.set(raw, n);
    return n === 1 ? raw : `${raw} #${n}`;
  });
}

const ENGINE_IDS = makeUniqueEngineIds(ENGINES);
const ENGINE_PATH_BY_ID = new Map(ENGINE_IDS.map((id, i) => [id, ENGINES[i]]));

// Log roster (so you always know what is actually running)
console.log(`[IJCCRL][engines] Using engines_dir=${ENGINES_DIR} count=${ENGINES.length}`);
ENGINE_IDS.forEach((id, i) => console.log(`  ${i + 1}. ${id} -> ${ENGINES[i]}`));

// --------------------
// ✅ Phase 1 scheduler targets (DEFAULTS aligned with RR double cycle)
// If you do NOT set env vars, we compute:
// - games_per_engine = 2*(N-1)
// - white_target     = (N-1)
// - black_target     = (N-1)
// --------------------
const N_ENG = ENGINE_IDS.length;
const DEFAULT_GAMES_PER_ENGINE = Math.max(1, 2 * (N_ENG - 1));
const DEFAULT_WHITE_TARGET = Math.max(0, (N_ENG - 1));
const DEFAULT_BLACK_TARGET = Math.max(0, (N_ENG - 1));

const PHASE1_GAMES_PER_ENGINE = parseInt(
  (process.env.IJCCRL_PHASE1_GAMES_PER_ENGINE ?? String(DEFAULT_GAMES_PER_ENGINE)),
  10
);
const PHASE1_WHITE_TARGET = parseInt(
  (process.env.IJCCRL_PHASE1_WHITE_TARGET ?? String(DEFAULT_WHITE_TARGET)),
  10
);
const PHASE1_BLACK_TARGET = parseInt(
  (process.env.IJCCRL_PHASE1_BLACK_TARGET ?? String(DEFAULT_BLACK_TARGET)),
  10
);
const PHASE1_OPENINGS_MAX = parseInt(process.env.IJCCRL_PHASE1_OPENINGS_MAX || "25", 10);

// --------------------
// ✅ Deterministic Phase 1 Scheduler
// --------------------
let scheduler = null;
try {
  scheduler = createScheduler({
    engines: ENGINE_IDS,
    openingsPath: OPENINGS_PGN_PATH,
    openingsMax: PHASE1_OPENINGS_MAX,
    outDir: path.join(process.cwd(), "out"),
    perEngineGamesTarget: PHASE1_GAMES_PER_ENGINE,
    perEngineWhiteTarget: PHASE1_WHITE_TARGET,
    perEngineBlackTarget: PHASE1_BLACK_TARGET,
  });
} catch (e) {
  console.warn("[IJCCRL] Scheduler disabled (error):", e?.message || e);
  scheduler = null;
}

// helper: final results only
const FINAL_RESULTS = new Set(["1-0", "0-1", "1/2-1/2", "0.5-0.5"]);

// --------------------
// Express static
// --------------------
const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "64kb" }));


// --------------------
// ✅ NEW: Support identity + PayPal layer
// --------------------
function buildSupportMailDispatch() {
  if (!SUPPORT_MAIL_CONFIG_READY) return null;
  const transporter = nodemailer.createTransport({
    host: SUPPORT_SMTP_HOST,
    port: SUPPORT_SMTP_PORT,
    secure: SUPPORT_SMTP_SECURE,
    auth: {
      user: SUPPORT_SMTP_USER,
      pass: SUPPORT_SMTP_PASS,
    },
  });

  const dispatch = async ({ to, subject, text, html, from, replyTo }) => {
    const mail = {
      from: String(from || SUPPORT_MAIL_FROM || "").trim(),
      to: String(to || "").trim(),
      subject: String(subject || "").trim(),
      text: String(text || ""),
      html: String(html || ""),
    };
    const resolvedReplyTo = String(replyTo || SUPPORT_MAIL_REPLY_TO || "").trim();
    if (resolvedReplyTo) mail.replyTo = resolvedReplyTo;
    return transporter.sendMail(mail);
  };

  return { transporter, dispatch };
}

try {
  if (!SUPPORT_COOKIE_SECRET) {
    console.warn("[IJCCRL][support] Disabled: missing IJCCRL_SUPPORT_COOKIE_SECRET (or IJCCRL_CHAT_ADMIN fallback).");
  } else {
    supportStore = createSupportStore({
      rootDir: ROOT,
      outDir: OUT_DIR,
      dbPath: path.join(OUT_DIR, "ijccrl_support.sqlite"),
      mailCodesLogPath: path.join(OUT_DIR, "support_mail_codes.jsonl"),
      paypalEventsLogPath: path.join(OUT_DIR, "support_paypal_events.jsonl"),
    });

    const supportMailRuntime = buildSupportMailDispatch();
    supportMailer = supportMailRuntime?.transporter || null;
    supportMailDispatch = supportMailRuntime?.dispatch || null;

    supportAuth = createSupportAuth({
      store: supportStore,
      cookieName: SUPPORT_COOKIE_NAME,
      cookieSecret: SUPPORT_COOKIE_SECRET,
      sessionTtlDays: SUPPORT_SESSION_TTL_DAYS,
      loginCodeTtlMinutes: SUPPORT_LOGIN_CODE_TTL_MINUTES,
      secureCookies: SUPPORT_SECURE_COOKIES,
      allowLocalCodeEcho: SUPPORT_DEV_ECHO_CODES,
      allowLocalVerificationEcho: SUPPORT_DEV_ECHO_CODES,
      verifyEmailPath: SUPPORT_VERIFY_EMAIL_PATH,
      resetPasswordPath: SUPPORT_RESET_PASSWORD_PATH,
      homeUrl: SUPPORT_HOME_URL,
      mailEnabled: SUPPORT_MAIL_ENABLED,
      mailFrom: SUPPORT_MAIL_FROM,
      mailReplyTo: SUPPORT_MAIL_REPLY_TO,
      mailDispatch: supportMailDispatch,
    });

    paypalSupport = createPaypalSupport({
      store: supportStore,
      paymentUrl: SUPPORT_PAYPAL_URL,
      amountEur: SUPPORT_PREMIUM_AMOUNT_EUR,
      currency: SUPPORT_PREMIUM_CURRENCY,
      returnPath: SUPPORT_PAYPAL_RETURN_PATH,
      homeUrl: SUPPORT_HOME_URL,
      premiumDurationDays: SUPPORT_PREMIUM_DURATION_DAYS,
    });

    SUPPORT_ENABLED = true;
  }
} catch (e) {
  SUPPORT_ENABLED = false;
  console.warn("[IJCCRL][support] Disabled due to init error:", e?.message || e);
}

/* ==========================================================
   ✅ NEW: Admin login for chat (browser-friendly) via cookie
   - POST /chat/admin/login   { secret: "..." }  -> sets httpOnly cookie
   - POST /chat/admin/logout  -> clears cookie
   - GET  /chat/admin/status  -> tells UI if admin session is present
   ========================================================== */

const CHAT_ADMIN_COOKIE = "ijccrl_admin";
const CHAT_ADMIN_TTL_MS = parseInt(process.env.IJCCRL_CHAT_ADMIN_TTL_MS || String(12 * 60 * 60 * 1000), 10);

function hmacHex(secret, data) {
  return crypto.createHmac("sha256", String(secret)).update(String(data)).digest("hex");
}

function b64urlEncode(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function b64urlDecodeToBuf(s) {
  const t = String(s || "").replace(/-/g, "+").replace(/_/g, "/");
  const pad = t.length % 4 ? "=".repeat(4 - (t.length % 4)) : "";
  return Buffer.from(t + pad, "base64");
}

function parseCookies(cookieHeader) {
  const out = {};
  const raw = String(cookieHeader || "");
  if (!raw) return out;
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key) continue;
    out[key] = decodeURIComponent(value);
  }
  return out;
}

function verifyAdminCookieToken(token, adminSecret) {
  try {
    if (!token || !adminSecret) return false;
    const obj = JSON.parse(b64urlDecodeToBuf(token).toString("utf8"));
    const ts = Number(obj?.ts);
    const exp = Number(obj?.exp);
    const sig = String(obj?.sig || "");
    if (!Number.isFinite(ts) || !Number.isFinite(exp) || !sig) return false;
    if (Date.now() > exp) return false;

    const expected = hmacHex(adminSecret, `${ts}.${exp}`);
    const a = Buffer.from(sig, "hex");
    const b = Buffer.from(expected, "hex");
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function makeAdminCookieToken(adminSecret) {
  const ts = Date.now();
  const exp = ts + CHAT_ADMIN_TTL_MS;
  const sig = hmacHex(adminSecret, `${ts}.${exp}`);
  const obj = { ts, exp, sig };
  return b64urlEncode(Buffer.from(JSON.stringify(obj), "utf8"));
}

function hasAdminCookie(req) {
  const cookies = parseCookies(req.headers.cookie);
  const tok = String(cookies[CHAT_ADMIN_COOKIE] || "");
  if (!tok || !CHAT_ADMIN_SECRET) return false;
  return verifyAdminCookieToken(tok, CHAT_ADMIN_SECRET);
}

function ensureParentDir(filePath) {
  try { fs.mkdirSync(path.dirname(filePath), { recursive: true }); } catch {}
}

function readJsonFileSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const txt = fs.readFileSync(filePath, "utf8");
    if (!txt.trim()) return fallback;
    return JSON.parse(txt);
  } catch {
    return fallback;
  }
}

function writeJsonFileAtomic(filePath, value) {
  ensureParentDir(filePath);
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(tmp, filePath);
}

function appendJsonLine(filePath, value) {
  ensureParentDir(filePath);
  fs.appendFileSync(filePath, `${JSON.stringify(value)}
`, "utf8");
}

function ensureFileWithDefault(filePath, defaultContent) {
  ensureParentDir(filePath);
  if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, defaultContent, "utf8");
}

function makeVoteRuntimeDefault() {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    currentPoll: null,
  };
}

function makeVoteLeaderboardDefault() {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    entries: {},
  };
}

ensureFileWithDefault(VOTE_RUNTIME_STATE_PATH, `${JSON.stringify(makeVoteRuntimeDefault(), null, 2)}
`);
ensureFileWithDefault(VOTE_LEADERBOARD_PATH, `${JSON.stringify(makeVoteLeaderboardDefault(), null, 2)}
`);
ensureFileWithDefault(VOTE_POLLS_LOG_PATH, "");
ensureFileWithDefault(VOTE_BALLOTS_LOG_PATH, "");

let voteRuntimeState = readJsonFileSafe(VOTE_RUNTIME_STATE_PATH, makeVoteRuntimeDefault()) || makeVoteRuntimeDefault();
let voteLeaderboardState = readJsonFileSafe(VOTE_LEADERBOARD_PATH, makeVoteLeaderboardDefault()) || makeVoteLeaderboardDefault();
let voteCloseTimer = null;
const voteSubmitThrottle = new Map();

function persistVoteRuntimeState() {
  voteRuntimeState.updatedAt = new Date().toISOString();
  writeJsonFileAtomic(VOTE_RUNTIME_STATE_PATH, voteRuntimeState);
}

function persistVoteLeaderboardState() {
  voteLeaderboardState.updatedAt = new Date().toISOString();
  writeJsonFileAtomic(VOTE_LEADERBOARD_PATH, voteLeaderboardState);
}

function sanitizeVotePublicLabel(value, fallback = "Guest") {
  const raw = String(value || "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  if (!raw) return fallback;
  return raw.slice(0, 32);
}

function requestIsHttps(req) {
  return (String(req?.headers?.["x-forwarded-proto"] || "").toLowerCase() === "https") || (req?.secure === true);
}

function setVoteGuestCookie(res, req, guestId) {
  if (!res || !guestId) return;
  const secure = requestIsHttps(req) ? "; Secure" : "";
  res.append("Set-Cookie", `${VOTE_GUEST_COOKIE_NAME}=${encodeURIComponent(guestId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${VOTE_GUEST_COOKIE_TTL_SECONDS}${secure}`);
}

function getRequestIp(req) {
  const fwd = String(req?.headers?.["x-forwarded-for"] || "").split(",")[0].trim();
  return fwd || String(req?.socket?.remoteAddress || req?.ip || "").trim() || "0.0.0.0";
}

function createGuestVoteId() {
  return `g_${crypto.randomBytes(12).toString("hex")}`;
}

function getVoteSelectionIndex(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return -1;
  if (raw === "white" || raw === "w" || raw === "1-0") return 0;
  if (raw === "draw" || raw === "d" || raw === "1/2-1/2" || raw === "0.5-0.5" || raw === "½-½") return 1;
  if (raw === "black" || raw === "b" || raw === "0-1") return 2;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 2 ? n : -1;
}

function getVoteSelectionKey(index) {
  return VOTE_SELECTION_KEYS[index] || "";
}

function getVoteResultLabel(index) {
  return VOTE_RESULT_LABELS[index] || "*";
}

function getVotePollCounts(poll) {
  if (!poll || typeof poll !== "object") return [0, 0, 0];
  const counts = [0, 0, 0];
  const ballots = (poll.ballots && typeof poll.ballots === "object") ? Object.values(poll.ballots) : [];
  for (const ballot of ballots) {
    const idx = Number(ballot?.optionIndex);
    if (Number.isInteger(idx) && idx >= 0 && idx <= 2) counts[idx] += 1;
  }
  return counts;
}

function sanitizeVotePollForPublic(poll) {
  if (!poll || typeof poll !== "object") return null;
  const counts = getVotePollCounts(poll);
  const totalVotes = counts[0] + counts[1] + counts[2];
  return {
    pollId: String(poll.pollId || ""),
    matchKey: String(poll.matchKey || ""),
    status: String(poll.status || "idle"),
    question: String(poll.question || ""),
    whiteEngine: String(poll.whiteEngine || ""),
    blackEngine: String(poll.blackEngine || ""),
    options: Array.isArray(poll.options) ? poll.options.slice(0, 3) : VOTE_SELECTION_KEYS.slice(),
    optionLabels: Array.isArray(poll.optionLabels) ? poll.optionLabels.slice(0, 3) : VOTE_RESULT_LABELS.slice(),
    openedAt: String(poll.openedAt || ""),
    closesAt: String(poll.closesAt || ""),
    closedAt: String(poll.closedAt || ""),
    resolvedAt: String(poll.resolvedAt || ""),
    closeReason: String(poll.closeReason || ""),
    resultOptionIndex: Number.isInteger(Number(poll.resultOptionIndex)) ? Number(poll.resultOptionIndex) : null,
    resultLabel: String(poll.resultLabel || ""),
    meta: poll.meta && typeof poll.meta === "object" ? { ...poll.meta } : {},
    counts,
    totalVotes,
  };
}

function getCurrentVotePoll() {
  return voteRuntimeState?.currentPoll && typeof voteRuntimeState.currentPoll === "object"
    ? voteRuntimeState.currentPoll
    : null;
}

function getVoteChoiceForPollVoter(pollId, voterId) {
  const poll = getCurrentVotePoll();
  if (!poll || String(poll.pollId || "") !== String(pollId || "")) return null;
  if (!voterId) return null;
  const ballot = poll.ballots && poll.ballots[voterId] ? poll.ballots[voterId] : null;
  if (!ballot) return null;
  return {
    pollId: String(pollId || ""),
    voterId,
    optionIndex: Number(ballot.optionIndex),
    selection: getVoteSelectionKey(Number(ballot.optionIndex)),
    resultLabel: getVoteResultLabel(Number(ballot.optionIndex)),
    castAt: String(ballot.castAt || ""),
    updatedAt: String(ballot.updatedAt || ballot.castAt || ""),
  };
}

function getVoteScoreByVoterId(voterId) {
  if (!voterId) return null;
  const entry = voteLeaderboardState?.entries?.[voterId];
  if (!entry) return null;
  const totalVotes = Math.max(0, Number(entry.totalVotes) || 0);
  const correctVotes = Math.max(0, Number(entry.correctVotes) || 0);
  const accuracyPct = totalVotes > 0 ? Number(((correctVotes / totalVotes) * 100).toFixed(2)) : 0;
  return {
    voterId,
    publicLabel: sanitizeVotePublicLabel(entry.publicLabel || voterId, "Guest"),
    totalVotes,
    correctVotes,
    accuracyPct,
    lastVoteAt: String(entry.lastVoteAt || ""),
    lastCorrectAt: String(entry.lastCorrectAt || ""),
    isGuest: Boolean(entry.isGuest),
  };
}

function getPublicVoteLeaderboard(limit = 25) {
  const max = Math.max(1, Math.min(100, parseInt(String(limit || "25"), 10) || 25));
  const entries = Object.entries(voteLeaderboardState?.entries || {})
    .map(([voterId, entry]) => {
      const totalVotes = Math.max(0, Number(entry.totalVotes) || 0);
      const correctVotes = Math.max(0, Number(entry.correctVotes) || 0);
      const accuracyPct = totalVotes > 0 ? Number(((correctVotes / totalVotes) * 100).toFixed(2)) : 0;
      return {
        voterId,
        publicLabel: sanitizeVotePublicLabel(entry.publicLabel || voterId, "Guest"),
        totalVotes,
        correctVotes,
        accuracyPct,
        lastVoteAt: String(entry.lastVoteAt || ""),
        lastCorrectAt: String(entry.lastCorrectAt || ""),
        isGuest: Boolean(entry.isGuest),
      };
    })
    .sort((a, b) => {
      if (b.correctVotes !== a.correctVotes) return b.correctVotes - a.correctVotes;
      if (b.accuracyPct !== a.accuracyPct) return b.accuracyPct - a.accuracyPct;
      if (b.totalVotes !== a.totalVotes) return b.totalVotes - a.totalVotes;
      return String(a.publicLabel).localeCompare(String(b.publicLabel));
    });
  return entries.slice(0, max).map((row, idx) => ({ rank: idx + 1, ...row }));
}

function broadcastVoteEvent(type, extra = {}) {
  if (!VOTE_ENABLED) return;
  const poll = sanitizeVotePollForPublic(getCurrentVotePoll());
  wsBroadcast({
    type,
    t: new Date().toISOString(),
    poll,
    leaderboard: getPublicVoteLeaderboard(10),
    ...extra,
  });
}

function ensureVotePollTimer() {
  if (voteCloseTimer) {
    clearTimeout(voteCloseTimer);
    voteCloseTimer = null;
  }

  const poll = getCurrentVotePoll();
  if (!poll || String(poll.status || "") !== "open") return;

  const closesAtMs = Date.parse(String(poll.closesAt || ""));
  if (!Number.isFinite(closesAtMs)) return;

  const delayMs = Math.max(0, closesAtMs - Date.now());

  voteCloseTimer = setTimeout(() => {
    try {
      const current = getCurrentVotePoll();
      if (!current || String(current.status || "") !== "open") return;

      if (isVotePollForCurrentLiveMatch(current)) {
        reopenCurrentVotePollForLiveMatch("live_match_window_extend");
        return;
      }

      closeCurrentVotePoll("window_elapsed");
    } catch {}
  }, delayMs + 25);
}

function closeCurrentVotePoll(reason = "closed") {
  const poll = getCurrentVotePoll();
  if (!poll || String(poll.status || "") !== "open") return sanitizeVotePollForPublic(poll);
  poll.status = "closed";
  poll.closedAt = new Date().toISOString();
  poll.closeReason = String(reason || "closed");
  voteRuntimeState.currentPoll = poll;
  persistVoteRuntimeState();
  appendJsonLine(VOTE_POLLS_LOG_PATH, {
    event: "poll_close",
    at: poll.closedAt,
    pollId: poll.pollId,
    matchKey: poll.matchKey,
    reason: poll.closeReason,
    counts: getVotePollCounts(poll),
  });
  if (voteCloseTimer) {
    clearTimeout(voteCloseTimer);
    voteCloseTimer = null;
  }
  broadcastVoteEvent("poll_close", { closeReason: poll.closeReason, counts: getVotePollCounts(poll) });
  return sanitizeVotePollForPublic(poll);
}

function resolveVoteIdentity(req, res, { ensureGuestId = false } = {}) {
  const viewer = supportAuth ? supportAuth.getViewerFromRequest(req) : null;
  if (viewer && viewer.userId) {
    const publicLabel = sanitizeVotePublicLabel(
      viewer.publicHandle || viewer.displayName || viewer.screenName || viewer.name || viewer.email || viewer.userId,
      "User"
    );
    return {
      voterId: `u:${viewer.userId}`,
      publicLabel,
      isGuest: false,
      supportUserId: viewer.userId,
    };
  }

  if (!VOTE_ALLOW_GUEST) return null;

  const cookies = parseCookies(req?.headers?.cookie);
  let guestId = String(
    req?.body?.guest_vote_id ||
    req?.headers?.["x-ijccrl-guest-vote-id"] ||
    cookies[VOTE_GUEST_COOKIE_NAME] ||
    req?.query?.guest_vote_id ||
    ""
  ).trim();

  if (!guestId && ensureGuestId) {
    guestId = createGuestVoteId();
    setVoteGuestCookie(res, req, guestId);
  }

  if (!guestId) return null;

  const publicLabel = sanitizeVotePublicLabel(
    req?.body?.display_name ||
    req?.body?.nick ||
    req?.headers?.["x-ijccrl-chat-nick"] ||
    cookies.ijccrl_chat_nick ||
    `Guest-${guestId.slice(-4)}`,
    `Guest-${guestId.slice(-4)}`
  );

  return {
    voterId: `g:${guestId}`,
    publicLabel,
    isGuest: true,
    guestVoteId: guestId,
  };
}

function checkVoteSubmitThrottle(voterId, req) {
  const now = Date.now();
  const ipHash = sha1(getRequestIp(req)).slice(0, 12);
  const keys = [String(voterId || ""), `ip:${ipHash}`];
  for (const key of keys) {
    const last = Number(voteSubmitThrottle.get(key) || 0);
    if (last && (now - last) < VOTE_RATE_LIMIT_MS) return false;
  }
  for (const key of keys) voteSubmitThrottle.set(key, now);
  return true;
}

function pruneVoteSubmitThrottle() {
  const threshold = Date.now() - (10 * 60 * 1000);
  for (const [key, ts] of voteSubmitThrottle.entries()) {
    if (Number(ts) < threshold) voteSubmitThrottle.delete(key);
  }
}
setInterval(pruneVoteSubmitThrottle, 5 * 60 * 1000).unref?.();

function isSupportAdminRequest(req) {
  if (!CHAT_ADMIN_SECRET) return false;

  const cookies = parseCookies(req.headers.cookie);
  const tok = String(cookies[CHAT_ADMIN_COOKIE] || "");
  if (tok && verifyAdminCookieToken(tok, CHAT_ADMIN_SECRET)) return true;

  const hdr = String(req.headers["x-ijccrl-admin"] || "").trim();
  if (hdr) {
    try {
      const a = Buffer.from(hdr);
      const b = Buffer.from(CHAT_ADMIN_SECRET);
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
    } catch {}
  }

  const bodySecret = String(req.body?.secret || "").trim();
  if (bodySecret && bodySecret === CHAT_ADMIN_SECRET) return true;

  const qp = String(req.query?.admin || "").trim();
  if (qp && qp === CHAT_ADMIN_SECRET) return true;

  return false;
}

function parseAdminPremiumDurationDays(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return 30;
  if (raw === "premium_7d" || raw === "7d" || raw === "7") return 7;
  if (raw === "premium_30d" || raw === "30d" || raw === "30") return 30;
  if (raw === "premium_31d" || raw === "31d" || raw === "31") return 31;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 30;
}

function resolveSupportAdminTargetUser(req) {
  if (!supportStore) return null;
  const rawUserId = req.body?.user_id ?? req.body?.userId ?? req.query?.user_id ?? req.query?.userId;
  const numericUserId = Number(rawUserId);
  if (Number.isFinite(numericUserId) && numericUserId > 0 && typeof supportStore.getUserById === "function") {
    const user = supportStore.getUserById(numericUserId);
    if (user) return user;
  }

  const identifier = String(
    req.body?.identifier ??
    req.body?.email ??
    req.body?.public_handle ??
    req.body?.publicHandle ??
    req.body?.handle ??
    req.query?.identifier ??
    req.query?.email ??
    req.query?.public_handle ??
    req.query?.publicHandle ??
    ""
  ).trim();

  if (!identifier) return null;
  if (typeof supportStore.getUserByIdentifier === "function") return supportStore.getUserByIdentifier(identifier);
  return null;
}

function supportViewerPayload(viewer) {
  if (!viewer || !viewer.userId) return null;
  return {
    auth: String(viewer.auth || "guest"),
    userId: Number(viewer.userId || 0) || null,
    email: String(viewer.email || ""),
    displayName: String(viewer.displayName || ""),
    publicHandle: String(viewer.publicHandle || ""),
    isRegistered: !!viewer.isRegistered,
    isPremium: !!viewer.isPremium,
    premiumStatus: String(viewer.premiumStatus || "none"),
    badgeLabel: String(viewer.badgeLabel || ""),
    canVote: !!viewer.canVote,
    canUsePremiumEmoji: !!viewer.canUsePremiumEmoji,
    canPublicRank: !!viewer.canPublicRank,
    premiumExpiresAt: viewer.premiumExpiresAt ? String(viewer.premiumExpiresAt) : null,
  };
}

app.post("/chat/admin/login", (req, res) => {
  if (!CHAT_ADMIN_SECRET) return res.status(400).json({ ok: false, error: "admin_disabled" });

  const incoming = String(req.body?.secret || "").trim();
  if (!incoming || incoming !== CHAT_ADMIN_SECRET) return res.status(403).json({ ok: false, error: "bad_secret" });

  const token = makeAdminCookieToken(CHAT_ADMIN_SECRET);

  // If behind https in production, Secure should be true
  const isHttps = (String(req.headers["x-forwarded-proto"] || "").toLowerCase() === "https") || (req.secure === true);

  res.setHeader("Set-Cookie", [
    `${CHAT_ADMIN_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(CHAT_ADMIN_TTL_MS / 1000)}${isHttps ? "; Secure" : ""}`
  ]);

  return res.json({ ok: true, admin: true, ttl_ms: CHAT_ADMIN_TTL_MS });
});

app.post("/chat/admin/logout", (req, res) => {
  const isHttps = (String(req.headers["x-forwarded-proto"] || "").toLowerCase() === "https") || (req.secure === true);
  res.setHeader("Set-Cookie", [
    `${CHAT_ADMIN_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${isHttps ? "; Secure" : ""}`
  ]);
  return res.json({ ok: true, admin: false });
});

app.get("/chat/admin/status", (req, res) => {
  return res.json({ ok: true, admin_enabled: Boolean(CHAT_ADMIN_SECRET), has_cookie: hasAdminCookie(req) });
});

/* ========================================================== */

// --------------------
// ✅ NEW: Support identity / premium / PayPal routes
// --------------------
app.get("/api/support/me", async (req, res) => {
  if (!SUPPORT_ENABLED || !supportAuth) return res.status(503).json({ ok: false, error: "support_unavailable" });
  return supportAuth.handleSupportMe(req, res);
});

app.post("/api/support/register", async (req, res) => {
  if (!SUPPORT_ENABLED || !supportAuth) return res.status(503).json({ ok: false, error: "support_unavailable" });
  return supportAuth.handleSupportRegister(req, res);
});

app.get(SUPPORT_VERIFY_EMAIL_PATH, async (req, res) => {
  if (!SUPPORT_ENABLED || !supportAuth) return res.status(503).type("text/plain").send("Support unavailable");
  return supportAuth.handleSupportVerifyEmailGet(req, res);
});

app.post("/api/support/verify-email", async (req, res) => {
  if (!SUPPORT_ENABLED || !supportAuth) return res.status(503).json({ ok: false, error: "support_unavailable" });
  return supportAuth.handleSupportVerifyEmailPost(req, res);
});

app.get(SUPPORT_RESET_PASSWORD_PATH, async (req, res) => {
  if (!SUPPORT_ENABLED || !supportAuth) return res.status(503).type("text/plain").send("Support unavailable");
  return supportAuth.handleSupportResetPasswordGet(req, res);
});

app.post("/api/support/login/password", async (req, res) => {
  if (!SUPPORT_ENABLED || !supportAuth) return res.status(503).json({ ok: false, error: "support_unavailable" });
  return supportAuth.handleSupportLoginPassword(req, res);
});

app.post("/api/support/password/reset/request", async (req, res) => {
  if (!SUPPORT_ENABLED || !supportAuth) return res.status(503).json({ ok: false, error: "support_unavailable" });
  return supportAuth.handleSupportPasswordResetRequest(req, res);
});

app.post("/api/support/password/reset/confirm", async (req, res) => {
  if (!SUPPORT_ENABLED || !supportAuth) return res.status(503).json({ ok: false, error: "support_unavailable" });
  return supportAuth.handleSupportPasswordResetConfirm(req, res);
});

app.post("/api/support/login/request-code", async (req, res) => {
  if (!SUPPORT_ENABLED || !supportAuth) return res.status(503).json({ ok: false, error: "support_unavailable" });
  return supportAuth.handleSupportLoginRequestCode(req, res);
});

app.post("/api/support/login/verify-code", async (req, res) => {
  if (!SUPPORT_ENABLED || !supportAuth) return res.status(503).json({ ok: false, error: "support_unavailable" });
  return supportAuth.handleSupportLoginVerifyCode(req, res);
});

app.post("/api/support/logout", async (req, res) => {
  if (!SUPPORT_ENABLED || !supportAuth) return res.status(503).json({ ok: false, error: "support_unavailable" });
  return supportAuth.handleSupportLogout(req, res);
});

app.post("/api/support/paypal/start", async (req, res) => {
  if (!SUPPORT_ENABLED || !supportAuth || !paypalSupport) return res.status(503).json({ ok: false, error: "support_unavailable" });
  return supportAuth.handleSupportPaypalStart(req, res, paypalSupport.getStartOptions());
});

app.get(SUPPORT_PAYPAL_RETURN_PATH, async (req, res) => {
  if (!SUPPORT_ENABLED || !paypalSupport) return res.status(503).type("text/plain").send("Support unavailable");
  return paypalSupport.handlePaypalReturn(req, res);
});

app.post("/api/support/paypal/webhook", async (req, res) => {
  if (!SUPPORT_ENABLED || !paypalSupport) return res.status(503).json({ ok: false, error: "support_unavailable" });
  return paypalSupport.handlePaypalWebhook(req, res);
});

app.post("/api/support/admin/grant", async (req, res) => {
  if (!SUPPORT_ENABLED || !supportStore) return res.status(503).json({ ok: false, error: "support_unavailable" });
  if (!isSupportAdminRequest(req)) return res.status(403).json({ ok: false, error: "admin_required" });

  try {
    const user = resolveSupportAdminTargetUser(req);
    if (!user) return res.status(404).json({ ok: false, error: "user_not_found" });

    const durationDays = parseAdminPremiumDurationDays(
      req.body?.grant_type ?? req.body?.duration ?? req.body?.duration_days ?? req.body?.premium_duration_days
    );
    const reason = String(req.body?.reason || req.body?.grant_reason || "manual_promo").trim() || "manual_promo";
    const adminActor = String(req.body?.granted_by || req.body?.admin_actor || req.body?.actor || "support_admin").trim() || "support_admin";
    const note = String(req.body?.note || "").trim();
    const viewer = supportStore.grantPremiumByUserId(user.id, {
      provider: "admin_manual",
      amountEur: 0,
      currency: SUPPORT_PREMIUM_CURRENCY,
      durationDays,
      reason,
      grantedBy: adminActor,
      note,
      attemptId: `admin_${Date.now()}_${crypto.randomBytes(6).toString("hex")}`,
      force: Boolean(req.body?.force),
    });

    return res.json({
      ok: true,
      grant: {
        kind: `premium_${durationDays}d`,
        durationDays,
        reason,
        grantedBy: adminActor,
      },
      viewer: supportViewerPayload(viewer),
    });
  } catch (err) {
    const msg = String(err?.message || err || "grant_failed");
    if (msg.includes("verified user")) return res.status(409).json({ ok: false, error: "email_not_verified", detail: msg });
    return res.status(400).json({ ok: false, error: "grant_failed", detail: msg });
  }
});

app.post("/api/support/admin/revoke", async (req, res) => {
  if (!SUPPORT_ENABLED || !supportStore) return res.status(503).json({ ok: false, error: "support_unavailable" });
  if (!isSupportAdminRequest(req)) return res.status(403).json({ ok: false, error: "admin_required" });

  try {
    const user = resolveSupportAdminTargetUser(req);
    if (!user) return res.status(404).json({ ok: false, error: "user_not_found" });

    const reason = String(req.body?.reason || req.body?.revoke_reason || "manual_revoke").trim() || "manual_revoke";
    const adminActor = String(req.body?.revoked_by || req.body?.admin_actor || req.body?.actor || "support_admin").trim() || "support_admin";
    const note = String(req.body?.note || "").trim();
    const viewer = supportStore.revokePremiumByUserId(user.id, {
      reason,
      revokedBy: adminActor,
      note,
    });

    return res.json({
      ok: true,
      revoke: {
        reason,
        revokedBy: adminActor,
      },
      viewer: supportViewerPayload(viewer),
    });
  } catch (err) {
    const msg = String(err?.message || err || "revoke_failed");
    return res.status(400).json({ ok: false, error: "revoke_failed", detail: msg });
  }
});

app.get("/api/support/admin/users", async (req, res) => {
  if (!SUPPORT_ENABLED || !supportStore) return res.status(503).json({ ok: false, error: "support_unavailable" });
  if (!isSupportAdminRequest(req)) return res.status(403).json({ ok: false, error: "admin_required" });
  const limit = Math.max(1, Math.min(200, parseInt(String(req.query.limit || req.query.n || "50"), 10) || 50));
  const offset = Math.max(0, parseInt(String(req.query.offset || "0"), 10) || 0);
  const query = String(req.query.q || req.query.query || "").trim();
  return res.json({ ok: true, ...supportStore.listAdminUsers({ limit, offset, query }) });
});

app.get("/api/support/admin/payments", async (req, res) => {
  if (!SUPPORT_ENABLED || !supportStore) return res.status(503).json({ ok: false, error: "support_unavailable" });
  if (!isSupportAdminRequest(req)) return res.status(403).json({ ok: false, error: "admin_required" });
  const limit = Math.max(1, Math.min(200, parseInt(String(req.query.limit || req.query.n || "50"), 10) || 50));
  const offset = Math.max(0, parseInt(String(req.query.offset || "0"), 10) || 0);
  const query = String(req.query.q || req.query.query || "").trim();
  const status = String(req.query.status || "").trim();
  return res.json({ ok: true, ...supportStore.listAdminPayments({ limit, offset, query, status }) });
});

app.get("/api/vote/state", async (req, res) => {
  if (!VOTE_ENABLED) return res.status(503).json({ ok: false, error: "vote_disabled" });
  const poll = ensureVotePollAlignedToLiveMatch(STATE.meta, { allowCreate: true, allowReopen: true });
  const livePoll = getCurrentVotePoll();
  const viewer = resolveVoteIdentity(req, res, { ensureGuestId: false });
  const choice = (livePoll && viewer && viewer.voterId) ? getVoteChoiceForPollVoter(livePoll.pollId, viewer.voterId) : null;
  const viewerScore = (viewer && viewer.voterId) ? getVoteScoreByVoterId(viewer.voterId) : null;
  return res.json({
    ok: true,
    enabled: VOTE_ENABLED,
    allowGuestVote: VOTE_ALLOW_GUEST,
    guestCookieName: VOTE_GUEST_COOKIE_NAME,
    poll,
    counts: getVotePollCounts(livePoll),
    choice,
    viewer: viewer ? { voterId: viewer.voterId, publicLabel: viewer.publicLabel, isGuest: viewer.isGuest } : null,
    viewerScore,
    leaderboard: getPublicVoteLeaderboard(10),
  });
});

app.post("/api/vote/submit", async (req, res) => {
  if (!VOTE_ENABLED) return res.status(503).json({ ok: false, error: "vote_disabled" });

  const poll = getCurrentVotePoll();
  if (!poll) return res.status(409).json({ ok: false, error: "poll_unavailable" });
  if (String(poll.status || "") !== "open") return res.status(409).json({ ok: false, error: "poll_closed", poll: sanitizeVotePollForPublic(poll) });
  if (req.body?.pollId && String(req.body.pollId).trim() !== String(poll.pollId)) {
    return res.status(409).json({ ok: false, error: "poll_mismatch", poll: sanitizeVotePollForPublic(poll) });
  }

  const identity = resolveVoteIdentity(req, res, { ensureGuestId: true });
  if (!identity || !identity.voterId) return res.status(403).json({ ok: false, error: "vote_identity_required" });
  if (!checkVoteSubmitThrottle(identity.voterId, req)) return res.status(429).json({ ok: false, error: "vote_rate_limited" });

  const optionIndex = getVoteSelectionIndex(req.body?.selection ?? req.body?.choice ?? req.body?.option ?? req.body?.optionIndex);
  if (optionIndex < 0) return res.status(400).json({ ok: false, error: "invalid_selection" });

  const ipHash = sha1(getRequestIp(req));
  const nowIso = new Date().toISOString();
  const ballots = (poll.ballots && typeof poll.ballots === "object") ? poll.ballots : {};
  const prev = ballots[identity.voterId] || null;

  ballots[identity.voterId] = {
    voterId: identity.voterId,
    publicLabel: identity.publicLabel,
    optionIndex,
    selection: getVoteSelectionKey(optionIndex),
    resultLabel: getVoteResultLabel(optionIndex),
    isGuest: Boolean(identity.isGuest),
    ipHash,
    castAt: prev?.castAt || nowIso,
    updatedAt: nowIso,
  };

  poll.ballots = ballots;
  poll.lastVoteAt = nowIso;
  voteRuntimeState.currentPoll = poll;
  persistVoteRuntimeState();

  appendJsonLine(VOTE_BALLOTS_LOG_PATH, {
    event: prev ? "vote_update" : "vote_cast",
    at: nowIso,
    pollId: poll.pollId,
    matchKey: poll.matchKey,
    voterId: identity.voterId,
    publicLabel: identity.publicLabel,
    optionIndex,
    selection: getVoteSelectionKey(optionIndex),
    resultLabel: getVoteResultLabel(optionIndex),
    isGuest: Boolean(identity.isGuest),
    ipHash,
  });

  const counts = getVotePollCounts(poll);
  const choice = getVoteChoiceForPollVoter(poll.pollId, identity.voterId);
  broadcastVoteEvent("poll_state", { counts, choice, viewer: { voterId: identity.voterId, publicLabel: identity.publicLabel, isGuest: identity.isGuest } });

  return res.json({
    ok: true,
    poll: sanitizeVotePollForPublic(poll),
    counts,
    choice,
    viewer: { voterId: identity.voterId, publicLabel: identity.publicLabel, isGuest: identity.isGuest },
    viewerScore: getVoteScoreByVoterId(identity.voterId),
    leaderboard: getPublicVoteLeaderboard(10),
  });
});

app.get("/api/vote/leaderboard", async (req, res) => {
  if (!VOTE_ENABLED) return res.status(503).json({ ok: false, error: "vote_disabled" });
  const limit = Math.max(1, Math.min(100, parseInt(String(req.query.limit || req.query.n || "25"), 10) || 25));
  const viewer = resolveVoteIdentity(req, res, { ensureGuestId: false });
  const viewerScore = (viewer && viewer.voterId) ? getVoteScoreByVoterId(viewer.voterId) : null;
  return res.json({ ok: true, allowGuestVote: VOTE_ALLOW_GUEST, leaderboard: getPublicVoteLeaderboard(limit), viewerScore });
});


app.get('/support', (req, res) => res.redirect(302, '/support/login'));
app.use(express.static(PUBLIC_DIR));
app.use("/vendor", express.static(path.join(PUBLIC_DIR, "vendor")));
app.use("/chessboardjs", express.static(path.join(PUBLIC_DIR, "chessboardjs")));
app.use("/pieces", express.static(path.join(PUBLIC_DIR, "pieces")));
app.use("/_dev_vendor", express.static(DEV_VENDOR_DIR));

// ✅ FIX: expose /out/* so UI can fetch /out/scheduler_state.json (and other audit artifacts)
try { fs.mkdirSync(OUT_DIR, { recursive: true }); } catch {}
app.use("/out", express.static(OUT_DIR, {
  fallthrough: false,
  etag: false,
  lastModified: true,
  setHeaders(res) {
    res.setHeader("Cache-Control", "no-store, max-age=0");
  }
}));

app.get("/", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "index.html")));
app.get("/health", (req, res) => res.json({ ok: true, port: PORT, clock_mode: CLOCK_MODE, ws_state_keepalive_ms: WS_STATE_KEEPALIVE_MS, ws_connect_engine_replay_ms: WS_CONNECT_ENGINE_REPLAY_MS }));

// --------------------
// State + endpoints
// --------------------
const STATE = {
  meta: {
    fen: "startpos",
    opening: "—",
    openingMoves: "",
    white: "White",
    black: "Black",
    // ✅ stable keys for scheduler/accounting (IMPORTANT)
    white_key: "",
    black_key: "",
    opening_source: "",
    opening_eco: "",
    opening_ref: "",
    // ✅ new
    meta_kind: "start",
    round_no: 0,
    game_id: "",
  },

  // ✅ PGN real (si llega por onPgn)
  pgn: { pgn: "" },

  // ✅ LIVE moves UCI (para directo, siempre viene por onMoves)
  live: { movesUci: "" },

  // ✅ last engine analysis snapshot per side (replayed to new WS clients)
  engine: { w: null, b: null },

  results: { rows: [] },
  clocks: { ply: 0, turn: "w", w_ms: TC_BASE_MS, b_ms: TC_BASE_MS },
};

let currentVotePoll = null;

const DIAG = {
  meta_count: 0,
  info_count: 0,
  moves_count: 0,
  pgn_count: 0,
  results_count: 0,
  snapshot_count: 0,
  snapshot_pgn_count: 0,
  engine_snapshot_count: 0,
  last_meta_ms: 0,
  last_info_ms: 0,
  last_moves_ms: 0,
  last_pgn_ms: 0,
  last_results_ms: 0,
  last_snapshot_ms: 0,
  last_snapshot_reason: "",
  last_engine_snapshot_ms: 0,
};

/* ==========================================================
   ✅ PROGRESS FEED (Round / Pair / Leg / Cycle)
   - Source priority:
     1) STATE.meta (fields from uci_proxy / scheduler injection)
     2) STATE.pgn.pgn (tags [IJCCRL_* "..."])
   ========================================================== */

// ✅ Dynamic pairs-per-round (EVEN N): e.g. 16 -> 8
const PAIRS_PER_ROUND = Math.max(1, Math.floor(ENGINE_IDS.length / 2));

function safeInt(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function parsePgnTag(pgnText, tagName) {
  const t = String(pgnText || "");
  if (!t) return "";
  const esc = tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp("\\[" + esc + "\\s+\"([^\"]*)\"\\]", "i");
  const m = t.match(re);
  return m && m[1] != null ? String(m[1]) : "";
}

function computeProgressFromState() {
  const m = STATE.meta || {};

  // In your Phase-1 semantics, IJCCRL_Cycle == roundNo (1..15)
  const cycle =
    safeInt(m.cycle ?? m.ijccrl_cycle ?? m.IJCCRL_Cycle ?? m.IJCCRL_cycle) ??
    null;

  // Prefer explicit round_no if present
  const roundNo =
    safeInt(m.round_no ?? m.roundNo ?? m.round ?? null) ??
    (cycle != null ? cycle : null);

  // ✅ IMPORTANT: prefer 1-based pairIndex coming from proxy/meta,
  // and ONLY fall back to our patched 0-based pair_index if no source exists.
  const pairIndex1 =
    safeInt(m.ijccrl_pair_index ?? m.IJCCRL_PairIndex ?? m.pairIndex ?? null);

  const pairIndex0 =
    (pairIndex1 != null)
      ? Math.max(0, pairIndex1 - 1)
      : (safeInt(m.pair_index) != null ? safeInt(m.pair_index) : null);

  // ✅ Same for leg: prefer pairGameNo from proxy
  const leg1or2 =
    safeInt(m.ijccrl_pair_game_no ?? m.IJCCRL_PairGameNo ?? m.pairGameNo ?? m.pair_game_no ?? null) ??
    safeInt(m.leg ?? null) ??
    null;

  return { cycle, roundNo, pairIndex0, pairGameNo: leg1or2 };
}

function computeProgressFromPgn() {
  const pgnText = String(STATE.pgn?.pgn || "").trim();
  if (!pgnText) return { cycle: null, roundNo: null, pairIndex0: null, pairGameNo: null };

  const cycleRaw = parsePgnTag(pgnText, "IJCCRL_Cycle");
  const pairIndexRaw = parsePgnTag(pgnText, "IJCCRL_PairIndex");
  const pairGameNoRaw = parsePgnTag(pgnText, "IJCCRL_PairGameNo");

  const cycle = safeInt(cycleRaw);
  const roundNo = cycle;

  const pairIndexMaybe1 = safeInt(pairIndexRaw);
  const pairGameNo = safeInt(pairGameNoRaw);

  const pairIndex0 = (pairIndexMaybe1 != null)
    ? ((pairIndexMaybe1 >= 1) ? (pairIndexMaybe1 - 1) : pairIndexMaybe1)
    : null;

  return { cycle, roundNo, pairIndex0, pairGameNo };
}

function computeProgressFromAny() {
  const a = computeProgressFromState();
  const b = computeProgressFromPgn();

  const cycle = (a.cycle != null) ? a.cycle : b.cycle;
  const roundNo = (a.roundNo != null) ? a.roundNo : b.roundNo;
  const pairIndex0 = (a.pairIndex0 != null) ? a.pairIndex0 : b.pairIndex0;
  const leg = (a.pairGameNo != null) ? a.pairGameNo : b.pairGameNo;

  return { cycle, roundNo, pairIndex0, leg };
}

function deriveAndAttachProgressMeta() {
  const { cycle, roundNo, pairIndex0, leg } = computeProgressFromAny();
  const patch = {};

  if (cycle != null) patch.cycle = cycle;

  // ✅ FIX: round_index must come from round/cycle, not from pairIndex math
  if (roundNo != null && roundNo >= 1) patch.round_index = roundNo - 1;
  else if (cycle != null && cycle >= 1) patch.round_index = cycle - 1;

  if (pairIndex0 != null && pairIndex0 >= 0) {
    // pair index is within the round (0..pairsPerRound-1)
    patch.pair_index = pairIndex0;
  }

  if (leg != null) patch.leg = leg;

  const hasAny = ("cycle" in patch) || ("pair_index" in patch) || ("round_index" in patch) || ("leg" in patch);
  if (!hasAny) return null;

  STATE.meta = { ...STATE.meta, ...patch };
  return patch;
}

/* ==========================================================
   ✅ Upcoming generation (minimal, no openings)
   - FIXED: uses scheduler_state.json schema:
     { legNo, roundNo, pairInRound, roundsTotal, pairsPerRound, pending? }
   - If pending exists => current game in progress, so "upnext" starts AFTER pending
   - ✅ FIX: PAIR-BLOCKED legs (leg1 then leg2 for same pair)
   ========================================================== */

function readJsonSafe(p) {
  try {
    if (!p) return null;
    if (!fs.existsSync(p)) return null;
    const txt = fs.readFileSync(p, "utf8");
    return JSON.parse(txt);
  } catch {
    return null;
  }
}

function rrPairingsForRound(engines, roundIdx0) {
  const list = Array.isArray(engines) ? engines.slice() : [];
  const n = list.length;
  if (n < 2) return [];

  const fixed = list[0];
  let rot = list.slice(1);

  for (let r = 0; r < (roundIdx0 % (n - 1) + (n - 1)) % (n - 1); r++) {
    rot = [rot[rot.length - 1], ...rot.slice(0, rot.length - 1)];
  }

  const arr = [fixed, ...rot];
  const pairs = [];
  const half = Math.floor(n / 2);

  for (let i = 0; i < half; i++) {
    const a = arr[i];
    const b = arr[n - 1 - i];
    pairs.push([a, b]);
  }
  return pairs;
}

function clampInt(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : dflt;
}

// ✅ FIX: pair-blocked advance: leg1 -> leg2 (same pair), then move to next pair
function advancePointer(ptr, roundsTotal, pairsPerRound) {
  const out = { ...ptr };

  if (out.legNo === 1) {
    out.legNo = 2; // immediate rematch, same pairInRound
  } else {
    out.legNo = 1;
    out.pairInRound += 1;

    if (out.pairInRound >= pairsPerRound) {
      out.pairInRound = 0;
      out.roundNo += 1;

      if (out.roundNo > roundsTotal) {
        out.roundNo = 1;
        out.cycleSetNo += 1;
      }
    }
  }

  out.openingIndexHuman += 1;
  return out;
}

function generateUpcomingMinimalFromSchedulerState(state, engines, maxItems = 12) {
  const j = state || {};
  const n = engines.length;

  const roundsTotal = clampInt(j.roundsTotal, Math.max(1, n - 1));
  const pairsPerRound = clampInt(j.pairsPerRound, Math.max(1, Math.floor(n / 2)));

  // Determine pointer:
  // - If pending exists => current game in progress, so start AFTER pending
  // - Else => state points to next cursor already (no skip)
  const hasPending = Boolean(j.pending && Number.isFinite(Number(j.pending.openingIndex)));

  const baseCycleSetNo = clampInt(
    hasPending ? (j.pending.cycleSetNo ?? j.cycleSetNo) : j.cycleSetNo,
    1
  );
  const baseLegNo = clampInt(
    hasPending ? (j.pending.legNo ?? j.legNo) : j.legNo,
    1
  );
  const baseRoundNo = clampInt(
    hasPending ? (j.pending.roundNo ?? j.roundNo) : j.roundNo,
    1
  );
  const basePairInRound = clampInt(
    hasPending ? (j.pending.pairInRound ?? j.pairInRound) : j.pairInRound,
    0
  );

  // openingIndex is 0-based cursor in state; pending.openingIndex is 1-based human
  const baseOpeningIndexHuman = hasPending
    ? clampInt(j.pending.openingIndex, 1)
    : (clampInt(j.openingIndex, 0) + 1);

  let ptr = {
    cycleSetNo: baseCycleSetNo,
    legNo: baseLegNo,
    roundNo: baseRoundNo,
    pairInRound: basePairInRound,
    openingIndexHuman: baseOpeningIndexHuman,
  };

  if (hasPending) {
    // skip current in-progress game => advance as if it just finished
    ptr = advancePointer(ptr, roundsTotal, pairsPerRound);
  }

  const out = [];
  const max = Math.max(1, Math.min(30, clampInt(maxItems, 12)));
  let guard = 0;

  while (out.length < max && guard < 500) {
    guard++;

    const roundIdx0 = ptr.roundNo - 1;
    const pairs = rrPairingsForRound(engines, roundIdx0);
    const p = pairs[ptr.pairInRound];

    if (p && p[0] && p[1]) {
      const a = p[0];
      const b = p[1];

      const isLeg2 = (ptr.legNo === 2);
      const white = isLeg2 ? b : a;
      const black = isLeg2 ? a : b;

      out.push({
        white,
        black,
        roundNo: ptr.roundNo,
        pairIndex: ptr.pairInRound + 1, // 1..pairsPerRound
        leg: ptr.legNo,                 // 1..2
        cycleNo: ptr.roundNo,            // Phase-1 semantics: cycle == round
        cycleSetNo: ptr.cycleSetNo,
        openingIndex: ptr.openingIndexHuman,
      });
    }

    ptr = advancePointer(ptr, roundsTotal, pairsPerRound);
  }

  return { roundsTotal, pairsPerRound, hasPending, upcoming: out, pointer: ptr };
}

/* ========================================================== */

app.get("/pgn", (req, res) => {
  const pgnReal = String(STATE.pgn?.pgn || "").trim();
  const live = String(STATE.live?.movesUci || "").trim();
  res.type("text/plain").send(pgnReal || live || "");
});

app.get("/pgns", async (req, res) => {
  res.type("text/plain; charset=utf-8");

  if (SERVER_WRITES_PGN && pgnStore) {
    res.send(await pgnStore.readBundle());
    return;
  }

  try {
    if (!fs.existsSync(PGN_BUNDLE_PATH)) return res.send("");
    const txt = fs.readFileSync(PGN_BUNDLE_PATH, "utf8");
    return res.send(txt || "");
  } catch {
    return res.send("");
  }
});

app.get("/results", (req, res) => res.json(STATE.results || { rows: [] }));

app.get("/meta", (req, res) => {
  deriveAndAttachProgressMeta();
  res.json(STATE.meta || {});
});

app.get("/clocks", (req, res) => res.json(STATE.clocks || {}));

// ✅ Alias: /scheduler_state.json -> out/scheduler_state.json (what UI was trying)
app.get("/scheduler_state.json", (req, res) => {
  const fp = path.join(OUT_DIR, "scheduler_state.json");
  const j = readJsonSafe(fp);
  if (!j) return res.status(404).json({ ok: false, error: "scheduler_state.json not found" });
  res.setHeader("Cache-Control", "no-store, max-age=0");
  return res.json(j);
});

// ✅ Endpoint for UI "Up next / Upcoming" (FIXED schema + pair-blocked legs)
app.get("/upnext", (req, res) => {
  const fp = scheduler?.statePath ? scheduler.statePath : path.join(OUT_DIR, "scheduler_state.json");
  const j = readJsonSafe(fp);
  if (!j) return res.status(404).json({ ok: false, error: "scheduler_state.json not found" });

  const max = clampInt(req.query?.n, 12);
  const pack = generateUpcomingMinimalFromSchedulerState(j, ENGINE_IDS, Math.max(1, Math.min(30, max)));

  // Provide current pointer snapshot (what state says)
  const pointer = (() => {
    const hasPending = Boolean(j.pending && Number.isFinite(Number(j.pending.openingIndex)));
    const legNo = clampInt(hasPending ? (j.pending.legNo ?? j.legNo) : j.legNo, 1);
    const roundNo = clampInt(hasPending ? (j.pending.roundNo ?? j.roundNo) : j.roundNo, 1);
    const pairInRound = clampInt(hasPending ? (j.pending.pairInRound ?? j.pairInRound) : j.pairInRound, 0);
    const openingIndexHuman = hasPending ? clampInt(j.pending.openingIndex, 1) : (clampInt(j.openingIndex, 0) + 1);
    const cycleSetNo = clampInt(hasPending ? (j.pending.cycleSetNo ?? j.cycleSetNo) : j.cycleSetNo, 1);

    return {
      hasPending,
      cycleSetNo,
      legNo,
      roundNo,
      pairInRound0: pairInRound,
      pairIndex: pairInRound + 1,
      openingIndex: openingIndexHuman,
      roundsTotal: clampInt(j.roundsTotal, Math.max(1, ENGINE_IDS.length - 1)),
      pairsPerRound: clampInt(j.pairsPerRound, Math.max(1, Math.floor(ENGINE_IDS.length / 2))),
    };
  })();

  res.setHeader("Cache-Control", "no-store, max-age=0");
  return res.json({
    ok: true,
    source: "/upnext",
    pointer,
    upcoming: pack.upcoming,
  });
});

app.get("/debug/state", (req, res) => {
  const schedulerFileState = scheduler ? readJsonSafe(scheduler.statePath) : null;

  const prog = (() => {
    const before = { ...(STATE.meta || {}) };
    const patch = deriveAndAttachProgressMeta();
    const after = { ...(STATE.meta || {}) };
    return {
      patch,
      before_subset: {
        cycle: before.cycle, ijccrl_cycle: before.ijccrl_cycle,
        round_no: before.round_no, round_index: before.round_index,
        pairIndex: before.pairIndex, pair_index: before.pair_index,
        pairGameNo: before.pairGameNo, pair_game_no: before.pair_game_no,
        leg: before.leg
      },
      after_subset: {
        cycle: after.cycle,
        round_no: after.round_no, round_index: after.round_index,
        pair_index: after.pair_index,
        leg: after.leg
      }
    };
  })();

  // --- PGN truth: memory vs disk bundle ---
  const pgn_mem_len = String(STATE.pgn?.pgn || "").length;
  const live_moves_len = String(STATE.live?.movesUci || "").length;

  let pgn_file_exists = false;
  let pgn_file_len = 0;
  let pgn_file_mtime_ms = 0;
  let pgn_games_est = null;

  try {
    const st = fs.statSync(PGN_BUNDLE_PATH);
    if (st && st.isFile()) {
      pgn_file_exists = true;
      pgn_file_len = st.size;
      pgn_file_mtime_ms = Math.trunc(st.mtimeMs);

      // Optional: estimate games in the bundle (cheap for small bundles).
      // Avoid reading huge files on every /debug/state request.
      const MAX_SCAN_BYTES = 5 * 1024 * 1024; // 5 MB
      if (pgn_file_len > 0 && pgn_file_len <= MAX_SCAN_BYTES) {
        try {
          const txt = fs.readFileSync(PGN_BUNDLE_PATH, "utf8");
          const m = txt.match(/^\[Result\s+"/gm);
          pgn_games_est = m ? m.length : 0;
        } catch {
          pgn_games_est = null;
        }
      }
    }
  } catch {
    // keep defaults
  }

  // Keep DIAG counters (session-local), but report last_pgn_ms using disk truth as well.
  const diag_out = {
    ...DIAG,
    last_pgn_ms: Math.max(DIAG.last_pgn_ms || 0, pgn_file_mtime_ms || 0),
  };

  res.json({
    ok: true,
    diag: diag_out,
    ws_clients: clients.size,
    ws_state_keepalive_ms: WS_STATE_KEEPALIVE_MS,
    ws_state_keepalive_pgn_every: WS_STATE_KEEPALIVE_PGN_EVERY,
    meta: STATE.meta,
    progress_meta: prog,
    clocks: STATE.clocks,
    engine: STATE.engine,
    engine_debug: {
      has_w: hasEngineSnapshot(STATE.engine?.w),
      has_b: hasEngineSnapshot(STATE.engine?.b),
      w_pv_len: String(STATE.engine?.w?.pv || "").trim().length,
      b_pv_len: String(STATE.engine?.b?.pv || "").trim().length,
      w_server_ts: Number.isFinite(Number(STATE.engine?.w?.server_ts)) ? Number(STATE.engine.w.server_ts) : 0,
      b_server_ts: Number.isFinite(Number(STATE.engine?.b?.server_ts)) ? Number(STATE.engine.b.server_ts) : 0,
      display_contract: {
        orientation: ENGINE_SCORE_ORIENTATION,
        black_input_frame: BLACK_ENGINE_SCORE_INPUT_FRAME,
        w_display_score: STATE.engine?.w?.display_score ?? null,
        b_display_score: STATE.engine?.b?.display_score ?? null,
      },
    },

    // ✅ real bundle info (disk)
    pgn_real_len: pgn_file_len,
    pgn_file_exists,
    pgn_file_mtime_ms,
    pgn_games_est,

    // extra debug (memory)
    pgn_mem_len,
    live_moves_len,

    results_rows: Array.isArray(STATE.results?.rows) ? STATE.results.rows.length : 0,

    scheduler: scheduler ? scheduler.debugState?.() : null,
    scheduler_file_state: schedulerFileState,

    server_writes_pgn: SERVER_WRITES_PGN,
    pgn_bundle_path: PGN_BUNDLE_PATH,
  });
});

app.get("/conditions", (req, res) => {
  res.json({
    engines_count: ENGINES.length,
    engines_ids: ENGINE_IDS,
    syzygy: SYZYGY_PATH || "",
    openings_pgn: OPENINGS_PGN_PATH || "",
    openings_ply_limit: OPENINGS_PLY_LIMIT,
    openings_source_label: OPENINGS_SOURCE_LABEL,
    defaults: { threads: DEFAULT_THREADS, hash_mb: DEFAULT_HASH_MB },
    time_control: { base_ms: TC_BASE_MS, inc_ms: TC_INC_MS },
    clock_mode: CLOCK_MODE,
    info_throttle_ms: INFO_THROTTLE_MS,
    ws_ping_ms: WS_PING_MS,
    ws_connect_engine_replay_ms: WS_CONNECT_ENGINE_REPLAY_MS,

    chat: {
      mode: "guest",
      ws_path: "/ws-chat",
      allowed_origins: CHAT_ALLOWED_ORIGINS,
      admin_enabled: Boolean(CHAT_ADMIN_SECRET),
    },

    support: {
      enabled: SUPPORT_ENABLED,
      cookie_name: SUPPORT_COOKIE_NAME,
      secure_cookies: SUPPORT_SECURE_COOKIES,
      login_code_ttl_minutes: SUPPORT_LOGIN_CODE_TTL_MINUTES,
      session_ttl_days: SUPPORT_SESSION_TTL_DAYS,
      paypal_mode: "hosted_link",
      paypal_url: SUPPORT_PAYPAL_URL,
      amount_eur: SUPPORT_PREMIUM_AMOUNT_EUR,
      currency: SUPPORT_PREMIUM_CURRENCY,
      return_path: SUPPORT_PAYPAL_RETURN_PATH,
      premium_duration_days: SUPPORT_PREMIUM_DURATION_DAYS,
      mail: {
        enabled: SUPPORT_MAIL_ENABLED,
        config_ready: SUPPORT_MAIL_CONFIG_READY,
        from: SUPPORT_MAIL_FROM || "",
        reply_to: SUPPORT_MAIL_REPLY_TO || "",
        smtp_host: SUPPORT_SMTP_HOST || "",
        smtp_port: SUPPORT_SMTP_PORT || 0,
        smtp_secure: SUPPORT_SMTP_SECURE,
      },
      endpoints: {
        me: "/api/support/me",
        register: "/api/support/register",
        verify_email: "/api/support/verify-email",
        login_password: "/api/support/login/password",
        login_request_code: "/api/support/login/request-code",
        login_verify_code: "/api/support/login/verify-code",
        password_reset_request: "/api/support/password/reset/request",
        password_reset_confirm: "/api/support/password/reset/confirm",
        logout: "/api/support/logout",
        paypal_start: "/api/support/paypal/start",
        paypal_webhook: "/api/support/paypal/webhook",
        admin_grant: "/api/support/admin/grant",
        admin_revoke: "/api/support/admin/revoke",
        admin_users: "/api/support/admin/users",
        admin_payments: "/api/support/admin/payments",
      },
    },

    vote: {
      enabled: VOTE_ENABLED,
      allow_guest_vote: VOTE_ALLOW_GUEST,
      guest_cookie_name: VOTE_GUEST_COOKIE_NAME,
      poll_seconds: VOTE_POLL_DURATION_SECONDS,
      endpoints: {
        state: "/api/vote/state",
        submit: "/api/vote/submit",
        leaderboard: "/api/vote/leaderboard",
      },
      storage: {
        runtime_state: VOTE_RUNTIME_STATE_PATH,
        polls_log: VOTE_POLLS_LOG_PATH,
        ballots_log: VOTE_BALLOTS_LOG_PATH,
        leaderboard_json: VOTE_LEADERBOARD_PATH,
      },
    },

    phase1: {
      enabled: Boolean(scheduler),
      games_per_engine: PHASE1_GAMES_PER_ENGINE,
      target_white: PHASE1_WHITE_TARGET,
      target_black: PHASE1_BLACK_TARGET,
      openings_max: PHASE1_OPENINGS_MAX,
      openings_loaded: scheduler ? scheduler.openingsCount : 0,
      state_path: scheduler ? scheduler.statePath : "",
      scheduling: "round-robin by rounds + same opening per round + pair-blocked 2 legs (colour swapped)",
    },

    rules: {
      standard: RULES_SPEC.standard,
      enforcement_status: RULES_SPEC.enforcement_status,
      draws: {
        fifty_move_rule: RULES_SPEC.fifty_move_rule,
        threefold_repetition: RULES_SPEC.threefold_repetition,
        insufficient_material: RULES_SPEC.insufficient_material,
      },
      adjudication: {
        enabled: RULES_SPEC.adjudication_enabled,
        win_cp: RULES_SPEC.adjudicate_win_cp,
        win_moves: RULES_SPEC.adjudicate_win_moves,
        draw_cp: RULES_SPEC.adjudicate_draw_cp,
        draw_moves: RULES_SPEC.adjudicate_draw_moves,
        min_ply: RULES_SPEC.adjudicate_min_ply,
      },
      tablebases: {
        syzygy_claims: RULES_SPEC.syzygy_claims,
        path_configured: Boolean(SYZYGY_PATH),
      },
    },

    engine_scores: {
      display_orientation: ENGINE_SCORE_ORIENTATION,
      black_input_frame: BLACK_ENGINE_SCORE_INPUT_FRAME,
      ui_field: "display_score",
      raw_fields: ["score_type", "score_value", "score"],
    },

    server_writes_pgn: SERVER_WRITES_PGN,
    pgn_bundle_path: PGN_BUNDLE_PATH,
  });
});

// --------------------
// HTTP + WS (Broadcast UI)
// --------------------
const server = http.createServer(app);

// ✅ Attach Guest Chat WS at /ws-chat (separate from broadcast WS)
const chatLayer = attachChatWss(server, {
  outDir: OUT_DIR,
  allowedOrigins: CHAT_ALLOWED_ORIGINS,
  adminSecret: CHAT_ADMIN_SECRET,
  adminCookieName: "ijccrl_admin",
  supportStore,
  supportSecret: SUPPORT_COOKIE_SECRET,
  supportCookieName: SUPPORT_COOKIE_NAME,
  onPollVote: (payload) => {
    try {
      if (!supportStore || !payload || !payload.pollId || !payload.userId) return;
      supportStore.recordVoteChoice({
        pollId: payload.pollId,
        userId: payload.userId,
        optionIndex: payload.optionIndex,
        optionLabel: payload.optionLabel || "",
        castAt: new Date().toISOString(),
      });
    } catch (e) {
      console.warn("[vote] record choice failed:", e?.message || e);
    }
  },
  onPollClose: (payload) => {
    try {
      if (!supportStore || !payload || !payload.pollId) return;
      supportStore.closeVotePoll(payload.pollId, payload.reason || "closed");
    } catch (e) {
      console.warn("[vote] close poll failed:", e?.message || e);
    }
  },
  // optional tuning (defaults are good)
  // maxMsgLen: 280,
  // historyMax: 120,
  // rate: { perSec: 1, burst: 3 },
});

// --------------------
// ✅ BE-WS1 — Master Upgrade Router / Broadcast WS Priority / Chat WS Preservation
// - Capture the chat upgrade handlers installed by attachChatWss(server, ...)
// - Replace the multi-listener upgrade surface with one explicit router
// - /ws is handled here by the broadcast WebSocket server
// - /ws-chat is delegated only to the captured chat handlers
// - Unknown upgrade paths are closed cleanly
// --------------------
function getWsPathname(reqUrl) {
  try {
    return new URL(reqUrl || "", "http://localhost").pathname || "/";
  } catch {
    const s = String(reqUrl || "/");
    const q = s.indexOf("?");
    return (q >= 0 ? s.slice(0, q) : s) || "/";
  }
}

// ✅ IMPORTANT: disable permessage-deflate to avoid RSV1 frames
const wss = new WebSocketServer({
  noServer: true,
  perMessageDeflate: false,
  maxPayload: 2 * 1024 * 1024, // safety for broadcast payloads (meta/pgn can be bigger)
});

const clients = new Set();

// Capture existing upgrade handlers from attachChatWss(), then install a single authority router.
const ijccrlChatUpgradeHandlers = server.listeners("upgrade");
server.removeAllListeners("upgrade");

console.log(`[IJCCRL][ws-router] BE-WS1 master upgrade router installed; chat_handlers=${ijccrlChatUpgradeHandlers.length}`);

server.on("upgrade", (req, socket, head) => {
  try {
    const pathname = getWsPathname(req.url);

    if (pathname === "/ws") {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
      return;
    }

    if (pathname === "/ws-chat") {
      if (!ijccrlChatUpgradeHandlers.length) {
        socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
        socket.destroy();
        return;
      }

      for (const handler of ijccrlChatUpgradeHandlers) {
        try {
          handler.call(server, req, socket, head);
        } catch {
          try { socket.destroy(); } catch {}
        }
      }
      return;
    }

    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
  } catch {
    try { socket.destroy(); } catch {}
  }
});

// --------------------
// Broadcast WS helpers
// --------------------
function wsSend(ws, obj) {
  try { ws.send(JSON.stringify(obj)); } catch {}
}

function wsBroadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const ws of clients) {
    try { ws.send(msg); } catch {}
  }
}



// --------------------
// WS payload compatibility (UI variants)
// - Always provide msg.data mirror for clocks/moves
// - Provide alias "moves" for board code that expects msg.moves
// --------------------
function packClocks(cl) {
  const ply = Number.isFinite(Number(cl?.ply)) ? Number(cl.ply) : 0;
  const turn = (cl?.turn === "w" || cl?.turn === "b") ? cl.turn : "w";
  const w_ms = Number.isFinite(Number(cl?.w_ms)) ? Number(cl.w_ms) : 0;
  const b_ms = Number.isFinite(Number(cl?.b_ms)) ? Number(cl.b_ms) : 0;
  return { type: "clocks", ply, turn, w_ms, b_ms, data: { ply, turn, w_ms, b_ms } };
}

function packMoves(movesUci, extra = {}) {
  const moves = (typeof movesUci === "string") ? movesUci : "";
  return {
    type: "moves",
    movesUci: moves,
    moves, // alias
    ...(extra || {}),
    data: { movesUci: moves, moves, ...(extra || {}) }
  };
}

function packInfo(side, info = {}, extra = {}) {
  const s = (side === "b") ? "b" : "w";
  const payload = { ...(info || {}) };
  delete payload.type;
  delete payload.data;
  delete payload.side;
  return {
    type: "info",
    side: s,
    ...payload,
    ...(extra || {}),
    data: { side: s, ...payload, ...(extra || {}) }
  };
}

function hasEngineSnapshot(info) {
  if (!info || typeof info !== "object") return false;
  return Object.keys(info).length > 0;
}

function isMeaningfulEngineValue(v) {
  if (v === undefined || v === null) return false;
  if (typeof v === "string") return v.trim().length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v).length > 0;
  return true;
}

const ENGINE_SCORE_CP_KEYS = ["cp", "scoreCp", "score_cp"];
const ENGINE_SCORE_MATE_KEYS = ["mate", "scoreMate", "score_mate"];

function deleteKeys(obj, keys) {
  if (!obj || typeof obj !== "object") return obj;
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, k)) delete obj[k];
  }
  return obj;
}

function mergeEngineInfoSnapshot(prev, incoming) {
  const base = (prev && typeof prev === "object") ? prev : {};
  const next = (incoming && typeof incoming === "object") ? incoming : {};
  const out = { ...base };

  const hasCp = ENGINE_SCORE_CP_KEYS.some((k) => isMeaningfulEngineValue(next[k]));
  const hasMate = ENGINE_SCORE_MATE_KEYS.some((k) => isMeaningfulEngineValue(next[k]));

  if (hasCp) deleteKeys(out, ENGINE_SCORE_MATE_KEYS);
  if (hasMate) deleteKeys(out, ENGINE_SCORE_CP_KEYS);

  for (const [k, v] of Object.entries(next)) {
    if (k === "type" || k === "data" || k === "side" || k === "server_ts") continue;
    if (isMeaningfulEngineValue(v)) {
      out[k] = v;
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(out, k)) out[k] = v;
  }

  return out;
}


function parseDisplayScoreToken(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return { kind: null, value: null };

  const mateMatch = s.match(/^#\s*([+-]?\d+)$/);
  if (mateMatch) {
    const value = Number(mateMatch[1]);
    return Number.isFinite(value) ? { kind: "mate", value } : { kind: null, value: null };
  }

  const n = Number(s);
  if (Number.isFinite(n)) {
    return { kind: "cp", value: Math.round(n * 100) };
  }

  return { kind: null, value: null };
}

function extractRawEngineScore(info) {
  const src = (info && typeof info === "object") ? info : {};

  const scoreType = String(src.score_type || "").trim().toLowerCase();
  const scoreValue = Number(src.score_value);

  if ((scoreType === "cp" || scoreType === "mate") && Number.isFinite(scoreValue)) {
    return { kind: scoreType, value: scoreValue };
  }

  for (const key of ENGINE_SCORE_CP_KEYS) {
    const cp = Number(src[key]);
    if (Number.isFinite(cp)) return { kind: "cp", value: cp };
  }

  for (const key of ENGINE_SCORE_MATE_KEYS) {
    const mate = Number(src[key]);
    if (Number.isFinite(mate)) return { kind: "mate", value: mate };
  }

  return parseDisplayScoreToken(src.score);
}

function formatEngineDisplayScore(kind, value) {
  if (kind === "mate" && Number.isFinite(value)) {
    const signed = value >= 0 ? `+${value}` : String(value);
    return `#${signed}`;
  }

  if (kind === "cp" && Number.isFinite(value)) {
    const pawns = value / 100;
    const prefix = pawns >= 0 ? "+" : "";
    return `${prefix}${pawns.toFixed(2)}`;
  }

  return "—";
}

function shouldInvertDisplayScore(side) {
  if (ENGINE_SCORE_ORIENTATION !== "white_perspective") return false;
  if (side !== "b") return false;
  return BLACK_ENGINE_SCORE_INPUT_FRAME === "engine_side";
}

function attachDisplayScoreContract(info, side) {
  const out = (info && typeof info === "object") ? { ...info } : {};
  const parsed = extractRawEngineScore(out);

  let displayKind = parsed.kind;
  let displayValue = parsed.value;

  if (displayKind && Number.isFinite(displayValue) && shouldInvertDisplayScore(side)) {
    displayValue = -displayValue;
  }

  if (displayKind && Number.isFinite(displayValue)) {
    out.display_score_kind = displayKind;
    out.display_score_value = displayValue;
    out.display_score = formatEngineDisplayScore(displayKind, displayValue);
  } else {
    delete out.display_score_kind;
    delete out.display_score_value;
    if (isMeaningfulEngineValue(out.score)) out.display_score = String(out.score).trim();
    else delete out.display_score;
  }

  out.display_score_orientation = ENGINE_SCORE_ORIENTATION;
  out.display_score_input_frame = (side === "b")
    ? BLACK_ENGINE_SCORE_INPUT_FRAME
    : "white_perspective";
  out.display_score_source_side = side;

  return out;
}

function sendAuthoritativeEngineSnapshots(ws, { reason = "sync" } = {}) {
  if (!ws) return;
  try {
    let sent = false;
    if (hasEngineSnapshot(STATE.engine?.w)) {
      wsSend(ws, packInfo("w", STATE.engine.w, { sync_reason: reason }));
      sent = true;
    }
    if (hasEngineSnapshot(STATE.engine?.b)) {
      wsSend(ws, packInfo("b", STATE.engine.b, { sync_reason: reason }));
      sent = true;
    }
    if (sent) {
      DIAG.engine_snapshot_count += 1;
      DIAG.last_engine_snapshot_ms = nowMs();
    }
  } catch {}
}

function scheduleAuthoritativeEngineReplay(ws, { reason = "ws_connect_engine_replay", delayMs = WS_CONNECT_ENGINE_REPLAY_MS } = {}) {
  const ms = Math.max(0, Number(delayMs) || 0);
  setTimeout(() => {
    try {
      if (!ws || !clients.has(ws)) return;
      if (ws.readyState !== 1) return;
      sendAuthoritativeEngineSnapshots(ws, { reason });
    } catch {}
  }, ms);
}
function safeNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function computeTurnFromMoves(movesUci) {
  const s = String(movesUci || "").trim();
  if (!s) return { ply: 0, turn: "w" };
  const ply = s.split(/\s+/).filter(Boolean).length;
  const turn = (ply % 2 === 0) ? "w" : "b";
  return { ply, turn };
}

function ensureClocksSane() {
  if (!Number.isFinite(STATE.clocks.w_ms) || STATE.clocks.w_ms <= 0) STATE.clocks.w_ms = TC_BASE_MS;
  if (!Number.isFinite(STATE.clocks.b_ms) || STATE.clocks.b_ms <= 0) STATE.clocks.b_ms = TC_BASE_MS;
  if (STATE.clocks.turn !== "w" && STATE.clocks.turn !== "b") STATE.clocks.turn = "w";
  if (!Number.isFinite(STATE.clocks.ply)) STATE.clocks.ply = 0;
}

function emitClocks() {
  ensureClocksSane();
  wsBroadcast(packClocks(STATE.clocks));
}

function sendAuthoritativeState(ws, { includePgn = false, reason = "sync" } = {}) {
  if (!ws) return;
  try {
    deriveAndAttachProgressMeta();
    ensureClocksSane();

    wsSend(ws, { type: "meta", ...STATE.meta, sync_reason: reason });
    if (includePgn) wsSend(ws, { type: "pgn", data: STATE.pgn });
    wsSend(ws, packMoves(STATE.live.movesUci, {}));
    sendAuthoritativeEngineSnapshots(ws, { reason });
    wsSend(ws, { type: "results", data: STATE.results });
    wsSend(ws, packClocks(STATE.clocks));
    if (VOTE_ENABLED) {
      wsSend(ws, {
        type: "poll_state",
        poll: sanitizeVotePollForPublic(getCurrentVotePoll()),
        leaderboard: getPublicVoteLeaderboard(10),
      });
    }
    wsSend(ws, {
      type: "sync",
      reason,
      server_ts: Date.now(),
      data: {
        meta_kind: String(STATE.meta?.meta_kind || ""),
        moves_len: String(STATE.live?.movesUci || "").trim().length,
        pgn_len: String(STATE.pgn?.pgn || "").trim().length,
        results_rows: Array.isArray(STATE.results?.rows) ? STATE.results.rows.length : 0,
        ply: Number.isFinite(Number(STATE.clocks?.ply)) ? Number(STATE.clocks.ply) : 0,
        turn: (STATE.clocks?.turn === "b") ? "b" : "w",
      },
    });
  } catch {}
}

function broadcastAuthoritativeState({ includePgn = false, reason = "sync" } = {}) {
  deriveAndAttachProgressMeta();
  ensureClocksSane();

  DIAG.snapshot_count += 1;
  if (includePgn) DIAG.snapshot_pgn_count += 1;
  DIAG.last_snapshot_ms = nowMs();
  DIAG.last_snapshot_reason = String(reason || "sync");

  for (const ws of clients) sendAuthoritativeState(ws, { includePgn, reason });
}

function heartbeat() { this.isAlive = true; }

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on("pong", heartbeat);
  clients.add(ws);

  sendAuthoritativeState(ws, { includePgn: true, reason: "ws_connect" });
  scheduleAuthoritativeEngineReplay(ws, { reason: "ws_connect_engine_replay" });

  ws.on("message", (buf) => {
    // Broadcast WS is now read-only for clients; ignore client messages.
    // (Chat is on /ws-chat)
    try { JSON.parse(buf.toString("utf8")); } catch {}
  });

  ws.on("close", () => clients.delete(ws));
  ws.on("error", () => {
    // prevent unhandled ws errors from bubbling
  });
});

const pingTimer = setInterval(() => {
  for (const ws of clients) {
    try {
      if (ws.isAlive === false) { ws.terminate(); clients.delete(ws); continue; }
      ws.isAlive = false;
      ws.ping();
    } catch {
      try { ws.terminate(); } catch {}
      clients.delete(ws);
    }
  }
}, WS_PING_MS);

wss.on("close", () => clearInterval(pingTimer));

let stateKeepaliveTick = 0;
const stateKeepaliveTimer = setInterval(() => {
  if (clients.size === 0) return;
  stateKeepaliveTick += 1;
  const includePgn = (stateKeepaliveTick % WS_STATE_KEEPALIVE_PGN_EVERY) === 0;
  broadcastAuthoritativeState({ includePgn, reason: includePgn ? "keepalive+pgn" : "keepalive" });
}, WS_STATE_KEEPALIVE_MS);

wss.on("close", () => clearInterval(stateKeepaliveTimer));

// --------------------
// PGN helpers
// --------------------
function nowMs() { return Date.now(); }

function sha1(s) {
  return crypto.createHash("sha1").update(String(s || ""), "utf8").digest("hex");
}

function safeMkdir(dir) { try { fs.mkdirSync(dir, { recursive: true }); } catch {} }

function looksLikePgn(s) {
  const t = String(s || "").trim();
  return t.startsWith("[Event ") || t.includes("\n[Event ") || (t.includes("\n\n1.") && t.includes("[Result "));
}

function plyFromMovesUci(movesUci) {
  const s = String(movesUci || "").trim();
  if (!s) return 0;
  return s.split(/\s+/).filter(Boolean).length;
}

function escapePgnTagValue(v) {
  return String(v || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function ymdDots(d = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}`;
}

function makeTcTag(baseMs, incMs) {
  const baseS = Math.max(0, Math.floor(Number(baseMs) / 1000));
  const incS = Math.max(0, Math.floor(Number(incMs) / 1000));
  return `${baseS}+${incS}`;
}

function buildMinimalPgnFromMovesUci({
  white, black, result, opening, eco, openingRef, openingSource, tcBaseMs, tcIncMs, movesUci, round, blockedReason
}) {
  const dt = new Date();
  const tags = [
    ["Event", "IJCCRL Live Broadcast"],
    ["Site", "IJCCRL"],
    ["Date", ymdDots(dt)],
    ["Round", String(round || "1")],
    ["White", white || "White"],
    ["Black", black || "Black"],
    ["Result", result || "*"],
    ["TimeControl", makeTcTag(tcBaseMs, tcIncMs)],
  ];

  if (eco) tags.push(["ECO", eco]);
  if (opening) tags.push(["Opening", opening]);
  if (openingSource) tags.push(["OpeningSource", openingSource]);
  if (openingRef) tags.push(["OpeningRef", openingRef]);
  if (blockedReason) tags.push(["IJCCRL_ResultBlocked", blockedReason]);

  tags.push(["MovesUCI", movesUci || ""]);

  const header = tags.map(([k, v]) => `[${k} "${escapePgnTagValue(v)}"]`).join("\n");
  return `${header}\n\n${result || "*"}\n`;
}

// ✅ per-game save ledger to prevent duplicates across multiple finalize triggers
// gameKey -> { snapshotSaved:boolean, finalSaved:boolean, lastHash:string }
const gameSaveLedger = new Map();

// --------------------
// ✅ round viene del proxy (matchNo) y NO se incrementa en meta_update
let currentRound = 0;

// --------------------
// ✅ Fallback save when uci_proxy never emits onResults()
// --------------------
const FALLBACK_SAVE_IDLE_MS = parseInt(process.env.IJCCRL_FALLBACK_SAVE_IDLE_MS || "45000", 10);
let lastMoveAtMs = 0;
let fallbackTimer = null;

function scheduleFallbackSave() {
  if (fallbackTimer) clearTimeout(fallbackTimer);
  fallbackTimer = setTimeout(async () => {
    try {
      if (!SERVER_WRITES_PGN || !pgnStore) return;

      const now = nowMs();
      if (!lastMoveAtMs || (now - lastMoveAtMs) < FALLBACK_SAVE_IDLE_MS) return;

      const white = String(STATE.meta?.white || "White");
      const black = String(STATE.meta?.black || "Black");
      const movesUci = String(STATE.live?.movesUci || "").trim();
      const pgnReal = String(STATE.pgn?.pgn || "").trim();

      if (!movesUci && !pgnReal) return;

      const result = "*";
      const pgnToWrite = (pgnReal && looksLikePgn(pgnReal))
        ? (pgnReal.endsWith("\n") ? pgnReal : (pgnReal + "\n"))
        : buildMinimalPgnFromMovesUci({
            white,
            black,
            result,
            opening: String(STATE.meta?.opening || ""),
            eco: String(STATE.meta?.opening_eco || ""),
            openingRef: String(STATE.meta?.opening_ref || ""),
            openingSource: String(STATE.meta?.opening_source || ""),
            tcBaseMs: TC_BASE_MS,
            tcIncMs: TC_INC_MS,
            movesUci,
            round: currentRound || 1,
            blockedReason: "fallback_idle_save",
          });

      safeMkdir(path.join(process.cwd(), "out"));
      await pgnStore.appendGame({
        pgn: pgnToWrite,
        white,
        black,
        result,
        gameId: Date.now(),
        tcLabel: `TC ${Math.round(TC_BASE_MS / 60000)}+${Math.round(TC_INC_MS / 1000)}`,
      });
    } catch (e) {
      if (process.env.IJCCRL_DEBUG_FILE) console.warn("[PGNStore] fallback save failed:", e?.message || e);
    }
  }, FALLBACK_SAVE_IDLE_MS + 2000);
}

function normalizeVoteResultLabel(result) {
  const raw = String(result || "").trim();
  if (raw === "1-0") return "1-0";
  if (raw === "0-1") return "0-1";
  if (raw === "1/2-1/2" || raw === "0.5-0.5") return "½-½";
  return raw || "*";
}

function voteOptionIndexFromResult(result) {
  const raw = String(result || "").trim();
  if (raw === "1-0") return 0;
  if (raw === "1/2-1/2" || raw === "0.5-0.5") return 1;
  if (raw === "0-1") return 2;
  return -1;
}

function buildVoteMatchKey(meta) {
  const m = meta || {};
  const gid = String(m.game_id || "").trim();
  if (gid) return gid;
  const parts = [m.white_key || m.white || "", m.black_key || m.black || "", m.round_no || m.round || "", m.ijccrl_pair_index || m.pairIndex || m.pair_index || "", m.ijccrl_pair_game_no || m.pairGameNo || m.leg || ""];
  return parts.map((x) => String(x || "").trim()).join("|");
}

function getLiveVoteMatchKeyFromState() {
  return String(buildVoteMatchKey(STATE.meta || {}) || "").trim();
}

function isVotePollForCurrentLiveMatch(poll) {
  if (!poll || typeof poll !== "object") return false;
  const liveKey = getLiveVoteMatchKeyFromState();
  const pollKey = String(poll.matchKey || "").trim();
  if (!liveKey || !pollKey) return false;
  return liveKey === pollKey;
}

function reopenCurrentVotePollForLiveMatch(reason = "live_match_reopen") {
  const poll = getCurrentVotePoll();
  if (!poll || typeof poll !== "object") return sanitizeVotePollForPublic(poll);

  poll.status = "open";
  poll.closedAt = "";
  poll.closeReason = "";
  poll.openedAt = poll.openedAt || new Date().toISOString();
  poll.closesAt = new Date(Date.now() + (VOTE_POLL_DURATION_SECONDS * 1000)).toISOString();

  voteRuntimeState.currentPoll = poll;
  persistVoteRuntimeState();

  appendJsonLine(VOTE_POLLS_LOG_PATH, {
    event: "poll_reopen",
    at: new Date().toISOString(),
    pollId: poll.pollId,
    matchKey: poll.matchKey,
    reason: String(reason || "live_match_reopen"),
    closesAt: poll.closesAt,
    counts: getVotePollCounts(poll),
  });

  ensureVotePollTimer();
  broadcastVoteEvent("poll_reopen", {
    reopenReason: String(reason || "live_match_reopen"),
    counts: getVotePollCounts(poll),
  });

  return sanitizeVotePollForPublic(poll);
}

function ensureVotePollAlignedToLiveMatch(meta, { allowCreate = false, allowReopen = false } = {}) {
  const liveMeta = meta && typeof meta === "object" ? meta : (STATE.meta || {});
  const white = String(liveMeta?.white || "").trim();
  const black = String(liveMeta?.black || "").trim();
  if (!white || !black) return sanitizeVotePollForPublic(getCurrentVotePoll());

  const liveKey = String(buildVoteMatchKey(liveMeta) || "").trim();
  if (!liveKey) return sanitizeVotePollForPublic(getCurrentVotePoll());

  const poll = getCurrentVotePoll();
  if (!poll) {
    return allowCreate ? openServerVotePoll(liveMeta) : null;
  }

  const pollKey = String(poll.matchKey || "").trim();
  const pollStatus = String(poll.status || "").trim().toLowerCase();

  if (pollKey !== liveKey) {
    if (pollStatus === "open") closeCurrentVotePoll("superseded_by_new_live_match");
    return allowCreate ? openServerVotePoll(liveMeta) : sanitizeVotePollForPublic(getCurrentVotePoll());
  }

  if (pollStatus === "closed" && String(poll.closeReason || "") === "window_elapsed" && allowReopen) {
    return reopenCurrentVotePollForLiveMatch("same_match_still_live");
  }

  if (pollStatus === "open") ensureVotePollTimer();
  return sanitizeVotePollForPublic(getCurrentVotePoll());
}

function openServerVotePoll(meta) {
  if (!VOTE_ENABLED) return null;

  const white = String(meta?.white || "").trim();
  const black = String(meta?.black || "").trim();
  if (!white || !black) return null;

  if (getCurrentVotePoll() && String(getCurrentVotePoll()?.status || "") === "open") {
    closeCurrentVotePoll("superseded_by_new_game");
  }

  const matchKey = buildVoteMatchKey(meta);
  const pollId = sha1(`vote|${matchKey}|${Date.now()}`).slice(0, 12);
  const openedAt = new Date().toISOString();
  const closesAt = new Date(Date.now() + (VOTE_POLL_DURATION_SECONDS * 1000)).toISOString();

  const poll = {
    pollId,
    matchKey,
    status: "open",
    question: `${white} vs ${black}`,
    whiteEngine: white,
    blackEngine: black,
    options: VOTE_SELECTION_KEYS.slice(),
    optionLabels: VOTE_RESULT_LABELS.slice(),
    openedAt,
    closesAt,
    closedAt: "",
    resolvedAt: "",
    closeReason: "",
    resultOptionIndex: null,
    resultLabel: "",
    meta: {
      roundNo: meta?.round_no ?? null,
      pairIndex: meta?.ijccrl_pair_index ?? meta?.pairIndex ?? meta?.pair_index ?? null,
      leg: meta?.ijccrl_pair_game_no ?? meta?.pairGameNo ?? meta?.leg ?? null,
      gameId: String(meta?.game_id || ""),
    },
    ballots: {},
  };

  voteRuntimeState.currentPoll = poll;
  persistVoteRuntimeState();
  appendJsonLine(VOTE_POLLS_LOG_PATH, {
    event: "poll_open",
    at: openedAt,
    pollId,
    matchKey,
    whiteEngine: white,
    blackEngine: black,
    closesAt,
    durationSeconds: VOTE_POLL_DURATION_SECONDS,
    meta: poll.meta,
  });

  currentVotePoll = { pollId, matchKey, white, black };
  ensureVotePollTimer();

  try {
    if (chatLayer?.openVotePoll) {
      chatLayer.openVotePoll({
        pollId,
        matchKey,
        question: poll.question,
        options: VOTE_RESULT_LABELS.slice(),
        whiteEngine: white,
        blackEngine: black,
        durationSeconds: VOTE_POLL_DURATION_SECONDS,
        meta: poll.meta,
      });
    }
  } catch {}

  broadcastVoteEvent("poll_open", { counts: [0, 0, 0] });
  return sanitizeVotePollForPublic(poll);
}

function resolveServerVotePoll(result) {
  if (!VOTE_ENABLED) return null;
  const poll = getCurrentVotePoll();
  if (!poll) return null;

  const optionIndex = voteOptionIndexFromResult(result);
  if (optionIndex < 0) return null;

  if (String(poll.status || "") === "open") closeCurrentVotePoll("resolved");

  poll.status = "resolved";
  poll.resolvedAt = new Date().toISOString();
  poll.resultOptionIndex = optionIndex;
  poll.resultLabel = normalizeVoteResultLabel(result);
  poll.closeReason = "resolved";

  const ballots = (poll.ballots && typeof poll.ballots === "object") ? Object.values(poll.ballots) : [];
  for (const ballot of ballots) {
    const voterId = String(ballot?.voterId || "").trim();
    if (!voterId) continue;
    const entry = voteLeaderboardState.entries[voterId] || {
      voterId,
      publicLabel: sanitizeVotePublicLabel(ballot?.publicLabel || voterId, "Guest"),
      isGuest: Boolean(ballot?.isGuest),
      totalVotes: 0,
      correctVotes: 0,
      lastVoteAt: "",
      lastCorrectAt: "",
    };
    entry.publicLabel = sanitizeVotePublicLabel(ballot?.publicLabel || entry.publicLabel || voterId, "Guest");
    entry.isGuest = Boolean(ballot?.isGuest);
    entry.totalVotes = Math.max(0, Number(entry.totalVotes) || 0) + 1;
    entry.lastVoteAt = String(poll.resolvedAt || new Date().toISOString());
    if (Number(ballot?.optionIndex) === optionIndex) {
      entry.correctVotes = Math.max(0, Number(entry.correctVotes) || 0) + 1;
      entry.lastCorrectAt = String(poll.resolvedAt || new Date().toISOString());
    }
    voteLeaderboardState.entries[voterId] = entry;
  }

  voteRuntimeState.currentPoll = poll;
  persistVoteRuntimeState();
  persistVoteLeaderboardState();

  appendJsonLine(VOTE_POLLS_LOG_PATH, {
    event: "poll_resolved",
    at: poll.resolvedAt,
    pollId: poll.pollId,
    matchKey: poll.matchKey,
    resultOptionIndex: optionIndex,
    resultLabel: poll.resultLabel,
    counts: getVotePollCounts(poll),
  });

  try {
    if (chatLayer?.broadcastJson) {
      chatLayer.broadcastJson({
        type: "poll_resolved",
        t: poll.resolvedAt,
        poll: sanitizeVotePollForPublic(poll),
        resultLabel: poll.resultLabel,
        resultOptionIndex: optionIndex,
        leaderboard: getPublicVoteLeaderboard(10),
      });
    }
  } catch {}
  try { if (chatLayer?.closeVotePoll) chatLayer.closeVotePoll("resolved"); } catch {}

  currentVotePoll = null;
  broadcastVoteEvent("poll_resolved", {
    resultLabel: poll.resultLabel,
    resultOptionIndex: optionIndex,
    counts: getVotePollCounts(poll),
  });
  return sanitizeVotePollForPublic(poll);
}
// --------------------
// Callbacks desde uci_proxy
// --------------------
const lastInfoSent = { w: 0, b: 0 };
const lastInfoCache = { w: null, b: null };

const callbacks = {
  onMeta: (m) => {
    DIAG.meta_count += 1;
    DIAG.last_meta_ms = nowMs();

    const incoming = (m || {});
    const kind = String(incoming.meta_kind || "start").toLowerCase(); // start | update
    const roundNo = Number.isFinite(Number(incoming.round_no)) ? Number(incoming.round_no) : null;

    STATE.meta = { ...STATE.meta, ...incoming };

    deriveAndAttachProgressMeta();

    wsBroadcast({ type: "meta", ...STATE.meta });

    if (kind === "update") {
      if (roundNo != null) currentRound = roundNo;

      try {
        ensureVotePollAlignedToLiveMatch(STATE.meta, { allowCreate: true, allowReopen: true });
      } catch (e) {
        console.warn("[vote] align poll on meta_update failed:", e?.message || e);
      }

      broadcastAuthoritativeState({ includePgn: true, reason: "meta_update" });
      return;
    }

    if (roundNo != null) currentRound = roundNo;
    else currentRound += 1;

    STATE.pgn = { pgn: "" };
    STATE.live = { movesUci: "" };
    STATE.engine = { w: null, b: null };
    lastInfoCache.w = null;
    lastInfoCache.b = null;
    lastInfoSent.w = 0;
    lastInfoSent.b = 0;

    wsBroadcast({ type: "pgn", data: STATE.pgn });
    wsBroadcast(packMoves("", {}));

    lastMoveAtMs = nowMs();
    scheduleFallbackSave();

    try {
      ensureVotePollAlignedToLiveMatch(STATE.meta, { allowCreate: true, allowReopen: true });
    } catch (e) {
      console.warn("[vote] open poll failed:", e?.message || e);
    }
    emitClocks();
    broadcastAuthoritativeState({ includePgn: true, reason: "meta_start" });
  },

  onInfo: (side, info) => {
    DIAG.info_count += 1;
    DIAG.last_info_ms = nowMs();

    const s = (side === "b") ? "b" : "w";
    const now = Date.now();
    const merged = mergeEngineInfoSnapshot(lastInfoCache[s], info || {});
    const withDisplayScore = attachDisplayScoreContract(merged, s);
    lastInfoCache[s] = withDisplayScore;
    STATE.engine[s] = { ...withDisplayScore, server_ts: now };

    if (now - lastInfoSent[s] < INFO_THROTTLE_MS) return;
    lastInfoSent[s] = now;

    DIAG.engine_snapshot_count += 1;
    DIAG.last_engine_snapshot_ms = nowMs();
    wsBroadcast(packInfo(s, STATE.engine[s] || {}, { sync_reason: "live_info" }));
  },

  onMoves: (movesUci, extra = {}) => {
    DIAG.moves_count += 1;
    DIAG.last_moves_ms = nowMs();

    const movesStr = String(movesUci || "").trim();
    STATE.live.movesUci = movesStr;

    lastMoveAtMs = nowMs();
    scheduleFallbackSave();

    wsBroadcast(packMoves(movesStr, (extra || {})));

    const derived = computeTurnFromMoves(movesStr);
    const ply = Number.isFinite(Number(extra?.ply)) ? Number(extra.ply) : derived.ply;
    const turn = (extra?.turn === "w" || extra?.turn === "b") ? extra.turn : derived.turn;

    STATE.clocks.ply = ply;
    STATE.clocks.turn = turn;

    if (CLOCK_MODE === "movetime") {
      if (turn === "w") STATE.clocks.w_ms = TC_BASE_MS;
      else STATE.clocks.b_ms = TC_BASE_MS;
    }
    emitClocks();
    broadcastAuthoritativeState({ includePgn: false, reason: "moves" });
  },

  onClocks: (c) => {
    const incoming = c || {};
    const w_in = safeNum(incoming.w_ms);
    const b_in = safeNum(incoming.b_ms);

    const turn = (incoming.turn === "w" || incoming.turn === "b") ? incoming.turn : STATE.clocks.turn;
    const ply = Number.isFinite(Number(incoming.ply)) ? Number(incoming.ply) : STATE.clocks.ply;

    let w_ms = (w_in != null) ? w_in : STATE.clocks.w_ms;
    let b_ms = (b_in != null) ? b_in : STATE.clocks.b_ms;

    STATE.clocks = { ...STATE.clocks, ...incoming, ply, turn, w_ms, b_ms };
    emitClocks();
    broadcastAuthoritativeState({ includePgn: false, reason: "clocks" });
  },

  onPgn: async (pgnObj) => {
    DIAG.pgn_count += 1;
    DIAG.last_pgn_ms = nowMs();

    STATE.pgn = pgnObj || { pgn: "" };

    deriveAndAttachProgressMeta();

    wsBroadcast({ type: "pgn", data: STATE.pgn });
    wsBroadcast({ type: "meta", ...STATE.meta });

    lastMoveAtMs = nowMs();
    scheduleFallbackSave();

    broadcastAuthoritativeState({ includePgn: true, reason: "pgn" });
  },

  onResults: async (r) => {
    DIAG.results_count += 1;
    DIAG.last_results_ms = nowMs();

    STATE.results = r || { rows: [] };
    wsBroadcast({ type: "results", data: STATE.results });
    broadcastAuthoritativeState({ includePgn: true, reason: "results" });

// ✅ WS compat bridge:
// If live moves are empty but results carries moves_uci, emit moves so the UI can update the board.
try {
  const live = String(STATE.live?.movesUci || "").trim();
  const rMoves = String(
    r?.game?.moves_uci ||
    r?.summary?.moves_uci ||
    r?.game?.movesUci ||
    r?.summary?.movesUci ||
    ""
  ).trim();

  if ((!live || live.length < 4) && rMoves && rMoves.length >= 4) {
    STATE.live = STATE.live || { movesUci: "" };
    STATE.live.movesUci = rMoves;

    const derived = computeTurnFromMoves(rMoves);
    const plyFromResults = Number.isFinite(Number(r?.game?.plies)) ? Number(r.game.plies) : derived.ply;

    wsBroadcast(packMoves(rMoves, { ply: plyFromResults, turn: derived.turn }));

    // keep clocks aligned (does not overwrite w_ms/b_ms)
    STATE.clocks.ply = plyFromResults;
    STATE.clocks.turn = derived.turn;
    emitClocks();
  }
} catch {}

    try {
      const white = String(STATE.meta?.white || "White");
      const black = String(STATE.meta?.black || "Black");

      // ✅ Always prefer stable keys coming from proxy/meta
      const whiteKey =
        String(r?.game?.white_key || STATE.meta?.white_key || "").trim() || white;
      const blackKey =
        String(r?.game?.black_key || STATE.meta?.black_key || "").trim() || black;

      const pgnReal = String(STATE.pgn?.pgn || "").trim();
      const movesUci = String(STATE.live?.movesUci || "").trim();
      if (!pgnReal && !movesUci) return;

      const rawResult = String(r?.game?.result || r?.result || r?.gameResult || "").trim() || "*";
      const isFinal = FINAL_RESULTS.has(rawResult);
      if (isFinal) {
        try { resolveServerVotePoll(rawResult); } catch (e) { console.warn("[vote] resolve poll failed:", e?.message || e); }
      }

      // ✅ Scheduler accounting: count ONLY on FINAL results (in both writer modes)
      if (scheduler && isFinal) {
        try { scheduler.onGameFinished(whiteKey, blackKey); } catch {}
      }

      // (Optional legacy writer: keep your fallback snapshot system)
      // In your current production mode: SERVER_WRITES_PGN=0, so we do nothing here.
      if (!SERVER_WRITES_PGN || !pgnStore) return;

      // If you ever enable server writer: de-dup saves by a stable per-game key
      const openingIndexTag =
        String(STATE.meta?.ijccrl_opening_index || STATE.meta?.openingIndex || "").trim();
      const stableGameKey =
        openingIndexTag ? `OI:${openingIndexTag}` :
        (String(STATE.meta?.game_id || "").trim() ? `GID:${String(STATE.meta?.game_id).trim()}` : "");

      const ledgerKey =
        stableGameKey ||
        `WK:${whiteKey}|BK:${blackKey}|R:${rawResult}`;

      const pgnToWrite = (pgnReal && looksLikePgn(pgnReal))
        ? (pgnReal.endsWith("\n") ? pgnReal : (pgnReal + "\n"))
        : buildMinimalPgnFromMovesUci({
            white,
            black,
            result: rawResult,
            opening: String(STATE.meta?.opening || ""),
            eco: String(STATE.meta?.opening_eco || ""),
            openingRef: String(STATE.meta?.opening_ref || ""),
            openingSource: String(STATE.meta?.opening_source || ""),
            tcBaseMs: TC_BASE_MS,
            tcIncMs: TC_INC_MS,
            movesUci,
            round: currentRound || 1,
            blockedReason: "",
          });

      // Only persist final PGNs (avoid polluting games.pgn with "*")
      if (!isFinal) return;

      const h = sha1(`${ledgerKey}|${rawResult}|${movesUci}|${STATE.meta?.opening_ref || ""}`);

      const entry = gameSaveLedger.get(ledgerKey) || { snapshotSaved: false, finalSaved: false, lastHash: "" };
      if (entry.finalSaved && entry.lastHash === h) return;

      safeMkdir(path.join(process.cwd(), "out"));

      await pgnStore.appendGame({
        pgn: pgnToWrite,
        white,
        black,
        result: rawResult,
        gameId: Date.now(),
        tcLabel: `TC ${Math.round(TC_BASE_MS / 60000)}+${Math.round(TC_INC_MS / 1000)}`,
      });

      entry.finalSaved = true;
      entry.lastHash = h;
      gameSaveLedger.set(ledgerKey, entry);

    } catch (e) {
      if (process.env.IJCCRL_DEBUG_FILE) {
        console.warn("[onResults] failed:", e && e.message ? e.message : e);
      }
    }
  },
};

// --------------------
// Start server + loop
// --------------------
server.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
  console.log(`✅ UI    : http://127.0.0.1:${PORT}/`);
  console.log(`✅ WS    : ws://127.0.0.1:${PORT}/ws`);
  console.log(`✅ Chat  : ws://127.0.0.1:${PORT}/ws-chat (guest, no tokens)`);
  console.log(`✅ Health: http://127.0.0.1:${PORT}/health`);
  console.log(`✅ Debug : http://127.0.0.1:${PORT}/debug/state`);
  console.log(`✅ UpNext: http://127.0.0.1:${PORT}/upnext`);
  console.log(`✅ Out   : http://127.0.0.1:${PORT}/out/scheduler_state.json`);
  console.log(`🎯 Engines enabled: ${ENGINES.length}`);
  console.log(`📘 OPENINGS_PGN_PATH: ${OPENINGS_PGN_PATH} (${fs.existsSync(OPENINGS_PGN_PATH) ? "OK" : "MISSING"})`);
  console.log(`🧾 OPENINGS_SOURCE_LABEL: ${OPENINGS_SOURCE_LABEL}`);
  console.log(`🧊 INFO_THROTTLE_MS=${INFO_THROTTLE_MS} WS_PING_MS=${WS_PING_MS} WS_STATE_KEEPALIVE_MS=${WS_STATE_KEEPALIVE_MS} PGN_EVERY=${WS_STATE_KEEPALIVE_PGN_EVERY} WS_CONNECT_ENGINE_REPLAY_MS=${WS_CONNECT_ENGINE_REPLAY_MS}`);
  console.log(`📈 Engine score display: orientation=${ENGINE_SCORE_ORIENTATION} black_input_frame=${BLACK_ENGINE_SCORE_INPUT_FRAME} ui_field=display_score`);
  console.log(`📄 PGN bundle path: ${PGN_BUNDLE_PATH}`);
  console.log(`✍️  server_writes_pgn: ${SERVER_WRITES_PGN ? "YES (legacy)" : "NO (recommended w/ uci_proxy writer)"}`);

  if (!CHAT_ADMIN_SECRET) {
    console.log("💬 Chat admin: DISABLED (set IJCCRL_CHAT_ADMIN to enable /mute /ban /readonly /slowmode)");
  } else {
    console.log("💬 Chat admin: ENABLED (admin commands available)");
  }
  console.log(`💬 Chat origins allowlist: ${CHAT_ALLOWED_ORIGINS.join(" | ")}`);
  console.log(`🗳️  Vote enabled    : ${VOTE_ENABLED ? "YES" : "NO"}`);
  console.log(`🗳️  Vote guest      : ${VOTE_ALLOW_GUEST ? "YES" : "NO"}`);
  console.log(`🗳️  Vote window     : ${VOTE_POLL_DURATION_SECONDS}s`);
  console.log(`🗳️  Vote state      : http://127.0.0.1:${PORT}/api/vote/state`);
  console.log(`🗳️  Vote submit     : http://127.0.0.1:${PORT}/api/vote/submit`);
  console.log(`🗳️  Vote ranking    : http://127.0.0.1:${PORT}/api/vote/leaderboard`);
  console.log(`🗳️  Vote files      : ${VOTE_RUNTIME_STATE_PATH} | ${VOTE_BALLOTS_LOG_PATH} | ${VOTE_LEADERBOARD_PATH}`);

  if (!SUPPORT_ENABLED) {
    console.log("💎 Support premium: DISABLED");
  } else {
    console.log("💎 Support premium: ENABLED");
    console.log(`💎 Support mail    : ${SUPPORT_MAIL_ENABLED ? "ENABLED" : "DISABLED"}`);
    console.log(`💎 Mail config     : ${SUPPORT_MAIL_CONFIG_READY ? "READY" : "INCOMPLETE"}`);
    console.log(`💎 Mail from       : ${SUPPORT_MAIL_FROM || ""}`);
    console.log(`💎 Mail reply-to   : ${SUPPORT_MAIL_REPLY_TO || ""}`);
    console.log(`💎 SMTP host/port  : ${SUPPORT_SMTP_HOST || ""}:${SUPPORT_SMTP_PORT || 0} secure=${SUPPORT_SMTP_SECURE ? "true" : "false"}`);
    console.log(`💎 Support me      : http://127.0.0.1:${PORT}/api/support/me`);
    console.log(`💎 Login/password  : http://127.0.0.1:${PORT}/api/support/login/password`);
    console.log(`💎 Reset request   : http://127.0.0.1:${PORT}/api/support/password/reset/request`);
    console.log(`💎 Reset confirm   : http://127.0.0.1:${PORT}/api/support/password/reset/confirm`);
    console.log(`💎 Support PayPal  : ${SUPPORT_PAYPAL_URL}`);
    console.log(`💎 Support return  : http://127.0.0.1:${PORT}${SUPPORT_PAYPAL_RETURN_PATH}`);
    console.log(`💎 Verify email    : http://127.0.0.1:${PORT}${SUPPORT_VERIFY_EMAIL_PATH}?token=...`);
    console.log(`💎 Reset page      : http://127.0.0.1:${PORT}${SUPPORT_RESET_PASSWORD_PATH}?token=...`);
    console.log(`💎 Admin users     : http://127.0.0.1:${PORT}/api/support/admin/users`);
    console.log(`💎 Admin payments  : http://127.0.0.1:${PORT}/api/support/admin/payments`);
    console.log(`💎 Support register: http://127.0.0.1:${PORT}/support/register`);
    console.log(`💎 Support login   : http://127.0.0.1:${PORT}/support/login`);
    console.log(`💎 Support account : http://127.0.0.1:${PORT}/support/account`);
    console.log(`💎 Support admin   : http://127.0.0.1:${PORT}/support/admin`);
    console.log(`💎 Support DB      : ${path.join(OUT_DIR, "ijccrl_support.sqlite")}`);
  }

  if (scheduler) {
    console.log(
      `🧠 Scheduler: ENABLED (Phase1 ${PHASE1_GAMES_PER_ENGINE} per engine, ` +
      `${PHASE1_WHITE_TARGET}W/${PHASE1_BLACK_TARGET}B, openings=${PHASE1_OPENINGS_MAX}, ` +
      `loaded=${scheduler.openingsCount})`
    );
    console.log(`🧠 Scheduler state: ${scheduler.statePath}`);
  } else {
    console.log("🧠 Scheduler: DISABLED (fallback to legacy pairing/openings inside uci_proxy)");
  }

  emitClocks();
});

// ✅ Pass scheduler + engine-id mapping into uci_proxy (server-driven scheduling)
startMatchLoop({
  engines: ENGINES,
  engineIds: ENGINE_IDS,
  enginePathById: Object.fromEntries(ENGINE_PATH_BY_ID),

  tcBaseMs: TC_BASE_MS,
  tcIncMs: TC_INC_MS,
  openingsPgnPath: OPENINGS_PGN_PATH,
  openingsPlyLimit: OPENINGS_PLY_LIMIT,
  openingsSourceLabel: OPENINGS_SOURCE_LABEL,
  syzygyPath: SYZYGY_PATH,
  syzygyProbeLimit: SYZYGY_PROBE_LIMIT,
  defaults: { threads: DEFAULT_THREADS, hashMb: DEFAULT_HASH_MB },

  scheduler: scheduler
    ? {
        enabled: true,
        perEngineGamesTarget: PHASE1_GAMES_PER_ENGINE,
        perEngineWhiteTarget: PHASE1_WHITE_TARGET,
        perEngineBlackTarget: PHASE1_BLACK_TARGET,
        openingsMax: PHASE1_OPENINGS_MAX,

        nextGame: () => {
          const g = scheduler.nextGame?.();
          if (!g) return null;

          const phase =
            String(process.env.IJCCRL_PHASE_NAME || process.env.IJCCRL_PHASE || "").trim();

          const openingPos0 =
            (g.openingPos0 != null) ? g.openingPos0 :
            (g.opening_pos0 != null) ? g.opening_pos0 :
            0;

          const cycle =
            (g.cycle != null) ? g.cycle :
            (g.cycleNo != null) ? g.cycleNo :
            (g.cycleno != null) ? g.cycleno :
            (g.ijccrl_cycle != null) ? g.ijccrl_cycle :
            "";

          const pairIndex =
            (g.pairIndex != null) ? g.pairIndex :
            (g.pair_index != null) ? g.pair_index :
            "";

          const pairGameNo =
            (g.pairGameNo != null) ? g.pairGameNo :
            (g.pair_game_no != null) ? g.pair_game_no :
            "";

          const openingIndex =
            (g.openingIndex != null) ? g.openingIndex :
            (g.opening_idx != null) ? g.opening_idx :
            (g.ijccrl_opening_index != null) ? g.ijccrl_opening_index :
            (Number.isFinite(Number(openingPos0)) ? (Number(openingPos0) + 1) : "");

          const openingBlock =
            String(
              g.openingBlock ??
              g.opening_block ??
              g.ijccrl_opening_block ??
              ""
            ).trim();

          return {
            ...g,
            openingPos0,
            phase: g.phase ?? g.ijccrl_phase ?? phase,
            cycle,
            pairIndex,
            pairGameNo,
            openingIndex,
            openingBlock,
          };
        },

        debugState: () => scheduler.debugState?.(),
      }
    : { enabled: false },

  callbacks,
});