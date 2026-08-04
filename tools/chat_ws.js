// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Jorge Ruiz Centelles
// tools/chat_ws.js
// IJCCRL — Guest Chat (No tokens) + Rate Limit + Admin Commands
// - WebSocket endpoint: /ws-chat
// - Guest by default (nick optional)
// - Rate limit per IP + slowmode
// - Admin commands via:
//    1) Cookie-based admin session (recommended for browser UI)
//    2) x-ijccrl-admin header (for non-browser clients)
//    3) ?admin=SECRET (fallback; avoid in production if possible)
// - Origin allowlist (protects your hardware from cross-site WS abuse)
// - Escapes all user input (no HTML)
// - Logs to out/chat_YYYY-MM-DD.jsonl (rotating by day)
// - MVP extension: timed promo drops + semipersistent admin-assigned chat badges by nick
// - PL82R30 extension: lightweight live polls broadcast through chat/support modal
// - Badge state survives process restarts through out/chat_badges.json

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import WebSocket, { WebSocketServer } from "ws";

function safeMkdir(dir) { try { fs.mkdirSync(dir, { recursive: true }); } catch {} }
function nowIso() { return new Date().toISOString(); }

function escapeText(s) {
  // strict escaping (no HTML)
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .trim();
}

function clampInt(x, lo, hi, dflt) {
  const n = Number.parseInt(x, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
}

function sha1(s) {
  return crypto.createHash("sha1").update(String(s)).digest("hex");
}

function getDayStamp(d = new Date()) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

function getOutFile(outDir) {
  return path.join(outDir, `chat_${getDayStamp()}.jsonl`);
}

function safeUrl(raw) {
  try {
    const u = new URL(String(raw || "").trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    return u.toString();
  } catch {
    return "";
  }
}

function normalizeNickKey(raw) {
  return String(raw || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function getIp(req) {
  const cf = req.headers["cf-connecting-ip"];
  if (cf) return String(cf).split(",")[0].trim();
  const xff = req.headers["x-forwarded-for"];
  if (xff) return String(xff).split(",")[0].trim();
  const ra = req.socket?.remoteAddress || "0.0.0.0";
  return String(ra).replace(/^::ffff:/, "");
}

function parseQuery(url) {
  try {
    const u = new URL(url, "http://localhost");
    return u.searchParams;
  } catch {
    return new URLSearchParams();
  }
}

function parseCookies(cookieHeader) {
  const out = {};
  const s = String(cookieHeader || "");
  if (!s) return out;
  const parts = s.split(";");
  for (const p of parts) {
    const idx = p.indexOf("=");
    if (idx <= 0) continue;
    const k = p.slice(0, idx).trim();
    const v = p.slice(idx + 1).trim();
    if (!k) continue;
    out[k] = decodeURIComponent(v);
  }
  return out;
}

function b64urlDecodeToBuf(s) {
  const t = String(s || "").replace(/-/g, "+").replace(/_/g, "/");
  const pad = t.length % 4 ? "=".repeat(4 - (t.length % 4)) : "";
  return Buffer.from(t + pad, "base64");
}

function hmacHex(secret, data) {
  return crypto.createHmac("sha256", String(secret)).update(String(data)).digest("hex");
}

// Cookie token format (simple, signed):
// token = base64url(JSON.stringify({ ts, exp, sig }))
// sig = HMAC(secret, `${ts}.${exp}`)
function verifyAdminCookieToken(token, secret) {
  try {
    if (!token || !secret) return false;
    const buf = b64urlDecodeToBuf(token);
    const obj = JSON.parse(buf.toString("utf8"));
    const ts = Number(obj?.ts);
    const exp = Number(obj?.exp);
    const sig = String(obj?.sig || "");
    if (!Number.isFinite(ts) || !Number.isFinite(exp) || !sig) return false;
    if (Date.now() > exp) return false;

    const expected = hmacHex(secret, `${ts}.${exp}`);
    // constant-time compare
    const a = Buffer.from(sig, "hex");
    const b = Buffer.from(expected, "hex");
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function verifySupportCookieToken(token, secret) {
  try {
    if (!token || !secret) return null;
    const buf = b64urlDecodeToBuf(token);
    const obj = JSON.parse(buf.toString("utf8"));
    const sid = String(obj?.sid || "");
    const ts = Number(obj?.ts);
    const exp = Number(obj?.exp);
    const sig = String(obj?.sig || "");
    if (!sid || !Number.isFinite(ts) || !Number.isFinite(exp) || !sig) return null;
    if (Date.now() > exp) return null;

    const expected = hmacHex(secret, `${sid}.${ts}.${exp}`);
    const a = Buffer.from(sig, "hex");
    const b = Buffer.from(expected, "hex");
    if (a.length !== b.length) return null;
    if (!crypto.timingSafeEqual(a, b)) return null;
    return { sid, exp };
  } catch {
    return null;
  }
}

/**
 * attachChatWss(httpServer, options)
 *
 * options:
 *  - outDir: "./out"
 *  - allowedOrigins: [ "https://ijccrl-live.ijccrl.com", ... ]  (recommended)
 *  - adminSecret: string (required for admin commands)
 *  - adminCookieName: string (default "ijccrl_admin")
 *  - maxMsgLen: 280 (default)
 *  - historyMax: 120 (default)
 *  - rate: { perSec: 1, burst: 3 } (default)
 */
export function attachChatWss(httpServer, options = {}) {
  const outDir = options.outDir || path.resolve(process.cwd(), "out");
  safeMkdir(outDir);

  const adminSecret = String(options.adminSecret || "").trim();
  const adminCookieName = String(options.adminCookieName || "ijccrl_admin").trim() || "ijccrl_admin";
  const supportStore = options.supportStore || null;
  const supportSecret = String(options.supportSecret || "").trim();
  const supportCookieName = String(options.supportCookieName || "ijccrl_support").trim() || "ijccrl_support";
  const onPollOpen = typeof options.onPollOpen === "function" ? options.onPollOpen : null;
  const onPollVote = typeof options.onPollVote === "function" ? options.onPollVote : null;
  const onPollClose = typeof options.onPollClose === "function" ? options.onPollClose : null;

  if (!adminSecret) {
    console.warn("[chat] WARNING: adminSecret is empty. Admin commands will be disabled.");
  }

  const allowedOrigins = Array.isArray(options.allowedOrigins) ? options.allowedOrigins.map(String) : [];
  const maxMsgLen = clampInt(options.maxMsgLen, 40, 800, 280);
  const historyMax = clampInt(options.historyMax, 20, 500, 120);

  const ratePerSec = clampInt(options.rate?.perSec, 1, 10, 1);
  const rateBurst  = clampInt(options.rate?.burst, 1, 20, 3);

  const history = [];
  const bans = new Map();
  const mutes = new Map();
  const rl = new Map();
  const clients = new Set();
  const badges = new Map();
  const badgesFile = path.join(outDir, "chat_badges.json");

  let activePromo = null;
  let activePoll = null;
  let activePollVotes = new Map();
  let readonly = false;
  const PREMIUM_EMOJI_MAP = new Map([
    [":crown:", "👑"],
    [":gem:", "💎"],
    [":trophy:", "🏆"],
    [":rocket:", "🚀"],
    [":fire:", "🔥"],
    [":bolt:", "⚡"],
  ]);
  let slowmodeMs = 1200;
  let autoSlowmode = true;


  function loadBadgesFromDisk() {
    try {
      const raw = fs.readFileSync(badgesFile, "utf8");
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return;
      for (const item of arr) {
        const nick = escapeText(item?.nick || "").slice(0, 18);
        const label = escapeText(item?.badge || item?.label || "").slice(0, 16);
        if (!nick || !label) continue;
        badges.set(normalizeNickKey(nick), { nick, badge: label, updatedAt: String(item?.updatedAt || nowIso()) });
      }
    } catch {}
  }

  function saveBadgesToDisk() {
    try {
      const rows = getActiveBadges(250).map((item) => ({
        nick: item.nick,
        badge: item.badge,
        updatedAt: item.updatedAt || nowIso(),
      }));
      fs.writeFileSync(badgesFile, JSON.stringify(rows, null, 2) + "\n", "utf8");
    } catch {}
  }

  function getActiveBadges(limit = 24) {
    const out = [];
    for (const [key, value] of badges.entries()) {
      if (!key || !value) continue;
      const nick = String(value.nick || key).trim();
      const badge = String(value.badge || value.label || value).trim();
      if (!nick || !badge) continue;
      out.push({
        nick,
        badge,
        updatedAt: String(value.updatedAt || nowIso()),
      });
    }
    out.sort((a, b) => a.nick.localeCompare(b.nick));
    return out.slice(0, Math.max(0, limit));
  }

  function broadcastBadgeState() {
    broadcast({ type: "badge_state", t: nowIso(), items: getActiveBadges() });
  }

  function isBanned(ip) {
    const b = bans.get(ip);
    if (!b) return false;
    if (Date.now() > b.untilMs) { bans.delete(ip); return false; }
    return true;
  }

  function isMuted(ip) {
    const m = mutes.get(ip);
    if (!m) return false;
    if (Date.now() > m.untilMs) { mutes.delete(ip); return false; }
    return true;
  }

  function checkOrigin(req) {
    if (!allowedOrigins.length) return true;
    const origin = String(req.headers.origin || "");
    return allowedOrigins.includes(origin);
  }

  function isAdmin(req) {
    if (!adminSecret) return false;

    // 1) Cookie-based admin session (browser-friendly)
    const cookies = parseCookies(req.headers.cookie);
    const tok = String(cookies[adminCookieName] || "");
    if (tok && verifyAdminCookieToken(tok, adminSecret)) return true;

    // 2) Header (non-browser clients)
    const hdr = String(req.headers["x-ijccrl-admin"] || "").trim();
    if (hdr) {
      try {
        const a = Buffer.from(hdr);
        const b = Buffer.from(adminSecret);
        if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
      } catch {}
    }

    // 3) Query param fallback
    const q = parseQuery(req.url);
    const qp = String(q.get("admin") || "").trim();
    if (qp && qp === adminSecret) return true;

    return false;
  }

  function getSupportViewerFromReq(req) {
    const guest = {
      auth: "guest",
      userId: null,
      email: "",
      displayName: "",
      publicHandle: "",
      isRegistered: false,
      isPremium: false,
      premiumStatus: "none",
      badgeLabel: "",
      canVote: false,
      canUsePremiumEmoji: false,
      canPublicRank: false,
      premiumExpiresAt: null,
    };

    if (!supportStore || !supportSecret) return guest;
    try {
      const cookies = parseCookies(req.headers.cookie);
      const tok = String(cookies[supportCookieName] || "");
      const checked = verifySupportCookieToken(tok, supportSecret);
      if (!checked || !checked.sid) return guest;
      const viewer = supportStore.getViewerBySessionToken(checked.sid);
      if (!viewer || typeof viewer !== "object") return guest;
      return { ...guest, ...viewer };
    } catch {
      return guest;
    }
  }

  function resolveEffectiveChatNick(viewer, requestedNick) {
    const supportHandle = escapeText(viewer?.publicHandle || "").replace(/\s+/g, " ").trim();
    if (viewer && viewer.userId && supportHandle) return supportHandle.slice(0, 18);

    const supportDisplay = escapeText(viewer?.displayName || viewer?.name || "").replace(/\s+/g, " ").trim();
    if (viewer && viewer.userId && supportDisplay) return supportDisplay.slice(0, 18);

    let nick = escapeText(requestedNick || "Guest");
    if (!nick) nick = "Guest";
    if (nick.length > 18) nick = nick.slice(0, 18);
    return nick;
  }

  function getBadgeForNick(nick) {
    const key = normalizeNickKey(nick);
    if (!key) return "";
    const item = badges.get(key);
    if (!item) return "";
    return String(item.badge || item.label || item || "");
  }

  function getVerifiedBadge(viewer) {
    if (!viewer || !viewer.isPremium) return "";
    return escapeText(String(viewer.badgeLabel || "Premium")).slice(0, 16) || "Premium";
  }


  function decodePremiumEmoji(text, viewer) {
    let out = String(text || "");
    let usedPremiumEmoji = false;
    for (const [token, emoji] of PREMIUM_EMOJI_MAP.entries()) {
      if (out.includes(token)) {
        usedPremiumEmoji = true;
        out = out.split(token).join(emoji);
      }
    }
    if (usedPremiumEmoji && !(viewer && viewer.canUsePremiumEmoji)) {
      return { ok: false, error: "premium_emoji_required", text: String(text || "") };
    }
    return { ok: true, text: out, usedPremiumEmoji };
  }

  function getActivePromo() {
    if (activePromo && activePromo.expiresAt) {
      const until = Date.parse(activePromo.expiresAt);
      if (Number.isFinite(until) && Date.now() > until) activePromo = null;
    }
    return activePromo;
  }

  function pushHistory(msg) {
    history.push(msg);
    while (history.length > historyMax) history.shift();
  }

  function logLine(obj) {
    try {
      fs.appendFileSync(getOutFile(outDir), JSON.stringify(obj) + "\n", { encoding: "utf8" });
    } catch {}
  }

  function broadcast(obj) {
    const s = JSON.stringify(obj);
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(s); } catch {}
      }
    }
  }

  function sys(msg) {
    const obj = { type: "sys", t: nowIso(), msg };
    pushHistory(obj);
    logLine(obj);
    broadcast(obj);
  }

  function broadcastPromo(promo) {
    const clean = {
      type: "promo",
      t: nowIso(),
      promoId: String(promo.promoId || sha1(String(Date.now()) + String(promo.code || "drop")).slice(0, 10)),
      title: escapeText(promo.title || "Broadcast drop"),
      text: escapeText(promo.text || "Timed gift active now."),
      code: escapeText(promo.code || ""),
      url: safeUrl(promo.url || ""),
      expiresAt: String(promo.expiresAt || "").trim(),
    };
    activePromo = clean;
    pushHistory(clean);
    logLine(clean);
    broadcast(clean);
  }

  function clearPromo() {
    activePromo = null;
    const obj = { type: "promo_clear", t: nowIso() };
    logLine(obj);
    broadcast(obj);
  }

  function buildPollSnapshot(status = "active") {
    if (!activePoll || !Array.isArray(activePoll.options) || activePoll.options.length < 2) return null;
    const counts = activePoll.options.map((label, idx) => ({
      index: idx,
      label: String(label || "").trim(),
      votes: 0,
    }));
    for (const optIdx of activePollVotes.values()) {
      if (counts[optIdx]) counts[optIdx].votes += 1;
    }
    const totalVotes = counts.reduce((sum, item) => sum + item.votes, 0);
    const expiresAt = String(activePoll.expiresAt || "").trim();
    const expiresMs = Date.parse(expiresAt);
    return {
      pollId: String(activePoll.pollId || ""),
      matchKey: String(activePoll.matchKey || ""),
      question: String(activePoll.question || "").trim(),
      options: counts,
      totalVotes,
      expiresAt,
      remainingMs: Number.isFinite(expiresMs) ? Math.max(0, expiresMs - Date.now()) : 0,
      whiteEngine: String(activePoll.whiteEngine || "").trim(),
      blackEngine: String(activePoll.blackEngine || "").trim(),
      meta: activePoll.meta && typeof activePoll.meta === "object" ? { ...activePoll.meta } : {},
      status,
    };
  }

  function openVotePollExternal(def = {}) {
    if (activePoll) closePoll("replaced");
    const cleanQuestion = escapeText(def.question || "").slice(0, 120);
    const cleanOptions = (Array.isArray(def.options) ? def.options : [])
      .map((opt) => escapeText(opt || "").slice(0, 40))
      .filter(Boolean)
      .slice(0, 4);
    const durationSeconds = clampInt(def.durationSeconds, 5, 3600, 20);
    if (!cleanQuestion || cleanOptions.length < 2) return null;
    activePoll = {
      pollId: String(def.pollId || sha1(String(Date.now()) + cleanQuestion).slice(0, 10)),
      matchKey: escapeText(def.matchKey || "").slice(0, 96),
      question: cleanQuestion,
      options: cleanOptions,
      whiteEngine: escapeText(def.whiteEngine || "").slice(0, 80),
      blackEngine: escapeText(def.blackEngine || "").slice(0, 80),
      meta: (def.meta && typeof def.meta === "object") ? { ...def.meta } : {},
      expiresAt: new Date(Date.now() + (durationSeconds * 1000)).toISOString(),
    };
    activePollVotes = new Map();
    const snap = buildPollSnapshot("active");
    const obj = { type: "poll_open", t: nowIso(), ...(snap || {}) };
    pushHistory(obj);
    logLine(obj);
    broadcast(obj);
    try { if (onPollOpen && snap) onPollOpen({ ...snap }); } catch {}
    return snap;
  }

  function openPoll(question, options, minutes) {
    return !!openVotePollExternal({ question, options, durationSeconds: Number(minutes || 1) * 60 });
  }

  function closePoll(reason = "closed") {
    if (!activePoll) return false;
    const snap = buildPollSnapshot("closed");
    activePoll = null;
    activePollVotes = new Map();
    const obj = { type: "poll_close", t: nowIso(), reason, ...(snap || {}) };
    pushHistory(obj);
    logLine(obj);
    broadcast(obj);
    try { if (onPollClose && snap) onPollClose({ reason, ...snap }); } catch {}
    return true;
  }

  function ensureActivePollFresh() {
    if (!activePoll) return;
    const until = Date.parse(String(activePoll.expiresAt || ""));
    if (Number.isFinite(until) && Date.now() > until) closePoll("expired");
  }

  function pruneState() {
    const now = Date.now();
    for (const [ip, v] of bans) if (now > v.untilMs) bans.delete(ip);
    for (const [ip, v] of mutes) if (now > v.untilMs) mutes.delete(ip);
    ensureActivePollFresh();
  }

  let msgCountWindow = [];
  function noteMsgForAutoSlowmode() {
    if (!autoSlowmode) return;
    const now = Date.now();
    msgCountWindow.push(now);
    while (msgCountWindow.length && (now - msgCountWindow[0] > 10_000)) msgCountWindow.shift();
    const c = msgCountWindow.length;
    if (c > 120) slowmodeMs = 4000;
    else if (c > 70) slowmodeMs = 2500;
    else if (c > 40) slowmodeMs = 1600;
    else slowmodeMs = 1200;
  }

  function rateAllow(ip) {
    const now = Date.now();
    let s = rl.get(ip);
    if (!s) {
      s = { tokens: rateBurst, lastMs: now, lastMsgMs: 0 };
      rl.set(ip, s);
    }
    const dt = Math.max(0, now - s.lastMs);
    s.tokens = Math.min(rateBurst, s.tokens + (dt / 1000) * ratePerSec);
    s.lastMs = now;

    if (slowmodeMs > 0 && (now - s.lastMsgMs) < slowmodeMs) return { ok: false, why: "slowmode" };

    if (s.tokens >= 1) {
      s.tokens -= 1;
      s.lastMsgMs = now;
      return { ok: true };
    }
    return { ok: false, why: "ratelimit" };
  }

  function parseAdminCommand(text) {
    const t = text.trim();
    if (!t.startsWith("/")) return null;
    const parts = t.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    return { cmd, parts, raw: t };
  }

  function handleAdmin(cmdObj) {
    const { cmd, parts } = cmdObj;
    const now = Date.now();

    if (cmd === "/readonly") {
      const v = (parts[1] || "").toLowerCase();
      readonly = (v === "on" || v === "1" || v === "true");
      sys(`Admin: readonly ${readonly ? "ON" : "OFF"}`);
      return true;
    }

    if (cmd === "/slowmode") {
      const ms = clampInt(parts[1], 0, 20_000, slowmodeMs);
      slowmodeMs = ms;
      sys(`Admin: slowmode ${slowmodeMs}ms`);
      return true;
    }

    if (cmd === "/autoslow") {
      const v = (parts[1] || "").toLowerCase();
      autoSlowmode = (v === "on" || v === "1" || v === "true");
      sys(`Admin: autoslow ${autoSlowmode ? "ON" : "OFF"}`);
      return true;
    }

    if (cmd === "/mute" || cmd === "/ban") {
      const ip = String(parts[1] || "").trim();
      const minutes = clampInt(parts[2], 1, 43200, 10);
      const reason = escapeText(parts.slice(3).join(" ")) || (cmd === "/mute" ? "Muted" : "Banned");
      if (!ip) return false;
      const untilMs = now + minutes * 60_000;
      if (cmd === "/mute") mutes.set(ip, { untilMs, reason });
      else bans.set(ip, { untilMs, reason });
      pruneState();
      sys(`Admin: ${cmd === "/mute" ? "mute" : "ban"} ${ip} for ${minutes}m (${reason})`);
      return true;
    }

    if (cmd === "/unmute") {
      const ip = String(parts[1] || "").trim();
      if (!ip) return false;
      mutes.delete(ip);
      sys(`Admin: unmute ${ip}`);
      return true;
    }

    if (cmd === "/unban") {
      const ip = String(parts[1] || "").trim();
      if (!ip) return false;
      bans.delete(ip);
      sys(`Admin: unban ${ip}`);
      return true;
    }

    if (cmd === "/drop") {
      const code = escapeText(parts[1] || "").slice(0, 32);
      const url = safeUrl(parts[2] || "");
      const minutes = clampInt(parts[3], 1, 10080, 60);
      const title = escapeText(parts.slice(4).join(" ")) || "Broadcast drop";
      if (!code || !url) return false;
      const expiresAt = new Date(now + minutes * 60_000).toISOString();
      broadcastPromo({
        title,
        text: `Gift active in chat for ${minutes}m.`,
        code,
        url,
        expiresAt,
      });
      sys(`Admin: promo drop ${code} for ${minutes}m`);
      return true;
    }

    if (cmd === "/dropclear") {
      clearPromo();
      sys("Admin: promo cleared");
      return true;
    }

    if (cmd === "/badge") {
      const raw = String(cmdObj.raw || "").replace(/^\/badge\s*/i, "");
      const partsRaw = raw.split("|");
      const nick = escapeText((partsRaw[0] || "").trim()).slice(0, 18);
      const label = escapeText((partsRaw[1] || "Member").trim()).slice(0, 16) || "Member";
      if (!nick) return false;
      badges.set(normalizeNickKey(nick), { nick, badge: label, updatedAt: nowIso() });
      saveBadgesToDisk();
      broadcastBadgeState();
      sys(`Admin: badge ${label} -> ${nick}`);
      return true;
    }

    if (cmd === "/unbadge") {
      const raw = String(cmdObj.raw || "").replace(/^\/unbadge\s*/i, "");
      const nick = escapeText(raw.trim()).slice(0, 18);
      if (!nick) return false;
      badges.delete(normalizeNickKey(nick));
      saveBadgesToDisk();
      broadcastBadgeState();
      sys(`Admin: unbadge ${nick}`);
      return true;
    }

    if (cmd === "/poll") {
      const raw = String(cmdObj.raw || "").replace(/^\/poll\s*/i, "");
      const partsRaw = raw.split("|").map((s) => s.trim()).filter(Boolean);
      if (partsRaw.length < 4) return false;
      const minutes = clampInt(partsRaw[0], 1, 10080, 60);
      const question = partsRaw[1];
      const options = partsRaw.slice(2, 6);
      const ok = openPoll(question, options, minutes);
      if (!ok) return false;
      sys(`Admin: poll open for ${minutes}m`);
      return true;
    }

    if (cmd === "/pollclose" || cmd === "/pollclear") {
      const closed = closePoll("admin");
      if (!closed) return false;
      sys("Admin: poll closed");
      return true;
    }

    if (cmd === "/purge") {
      const n = clampInt(parts[1], 1, historyMax, 20);
      history.splice(Math.max(0, history.length - n), n);
      sys(`Admin: purged last ${n} messages`);
      broadcast({ type: "purge", t: nowIso(), n });
      return true;
    }

    return false;
  }

  loadBadgesFromDisk();

  // ✅ IMPORTANT: disable permessage-deflate to avoid RSV1 frame issues
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

  httpServer.on("upgrade", (req, socket, head) => {
    try {
      if (!req.url || !req.url.startsWith("/ws-chat")) return;
      if (!checkOrigin(req)) {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    } catch {
      try { socket.destroy(); } catch {}
    }
  });

  wss.on("connection", (ws, req) => {
    const ip = getIp(req);
    const admin = isAdmin(req);
    const viewer = getSupportViewerFromReq(req);
    ws._ijccrlSupportViewer = viewer;

    if (isBanned(ip)) {
      try { ws.send(JSON.stringify({ type: "err", t: nowIso(), msg: "banned" })); } catch {}
      try { ws.close(); } catch {}
      return;
    }

    clients.add(ws);

    try {
      ws.send(JSON.stringify({
        type: "hello",
        t: nowIso(),
        guest: true,
        readonly,
        slowmodeMs,
        historyMax,
        maxMsgLen,
        admin: admin ? true : false,
        viewer,
        activePromo: getActivePromo(),
        activePoll: buildPollSnapshot("active"),
        activeBadges: getActiveBadges(),
      }));
      ws.send(JSON.stringify({ type: "history", t: nowIso(), items: history }));
    } catch {}

    logLine({ type: "connect", t: nowIso(), ip_hash: sha1(ip), admin, support_auth: viewer.auth || "guest", support_user_id: viewer.userId || null, premium: viewer.isPremium ? true : false });

    ws.on("message", (buf) => {
      pruneState();

      if (isBanned(ip)) return;
      if (readonly && !admin) return;

      let data = null;
      try { data = JSON.parse(String(buf)); } catch { return; }
      if (!data || typeof data !== "object") return;

      const kind = String(data.type || "");
      if (kind === "poll_vote") {
        ensureActivePollFresh();
        if (!activePoll) {
          try { ws.send(JSON.stringify({ type: "err", t: nowIso(), msg: "poll_closed" })); } catch {}
          return;
        }
        const viewerVote = ws._ijccrlSupportViewer || viewer || null;
        if (!viewerVote || !viewerVote.canVote || !viewerVote.userId) {
          try { ws.send(JSON.stringify({ type: "err", t: nowIso(), msg: "vote_auth_required" })); } catch {}
          return;
        }
        const pollId = String(data.pollId || "").trim();
        if (pollId && pollId !== String(activePoll.pollId || "")) {
          try { ws.send(JSON.stringify({ type: "err", t: nowIso(), msg: "poll_stale" })); } catch {}
          return;
        }
        const optionIndex = clampInt(data.optionIndex, 0, activePoll.options.length - 1, -1);
        if (optionIndex < 0 || !activePoll.options[optionIndex]) {
          try { ws.send(JSON.stringify({ type: "err", t: nowIso(), msg: "poll_option" })); } catch {}
          return;
        }
        const voterKey = `user:${viewerVote.userId}`;
        activePollVotes.set(voterKey, optionIndex);
        const snap = buildPollSnapshot("active");
        const chosenLabel = activePoll.options[optionIndex] ? String(activePoll.options[optionIndex]) : "";
        const obj = { type: "poll_state", t: nowIso(), viewer: viewerVote, ...(snap || {}) };
        logLine({ type: "poll_vote", t: nowIso(), pollId: activePoll.pollId, optionIndex, optionLabel: chosenLabel, user_id: viewerVote.userId, ip_hash: sha1(ip) });
        try { if (onPollVote && snap) onPollVote({ pollId: activePoll.pollId, userId: viewerVote.userId, optionIndex, optionLabel: chosenLabel, viewer: viewerVote, snapshot: { ...snap } }); } catch {}
        broadcast(obj);
        return;
      }
      if (kind !== "chat") return;

      const viewerNow = ws._ijccrlSupportViewer || viewer || null;
      const nick = resolveEffectiveChatNick(viewerNow, data.nick || "Guest");

      let text = escapeText(data.text || "");
      if (!text) return;
      if (text.length > maxMsgLen) text = text.slice(0, maxMsgLen);

      const cmdObj = parseAdminCommand(text);
      if (cmdObj && admin) {
        const ok = handleAdmin(cmdObj);
        if (!ok) {
          try { ws.send(JSON.stringify({ type: "err", t: nowIso(), msg: "unknown_admin_command" })); } catch {}
        }
        return;
      }

      if (!admin && isMuted(ip)) {
        try { ws.send(JSON.stringify({ type: "err", t: nowIso(), msg: "muted" })); } catch {}
        return;
      }

      const r = rateAllow(ip);
      if (!admin && !r.ok) {
        try { ws.send(JSON.stringify({ type: "err", t: nowIso(), msg: r.why })); } catch {}
        return;
      }

      noteMsgForAutoSlowmode();

      const emojiApplied = decodePremiumEmoji(text, viewerNow);
      if (!emojiApplied.ok) {
        try { ws.send(JSON.stringify({ type: "err", t: nowIso(), msg: emojiApplied.error })); } catch {}
        return;
      }
      text = emojiApplied.text;
      const verifiedBadge = getVerifiedBadge(viewerNow);
      const manualBadge = getBadgeForNick(nick);
      const badge = verifiedBadge || manualBadge;
      const msg = {
        type: "chat",
        t: nowIso(),
        nick,
        text,
        badge,
        badgeSource: verifiedBadge ? "support_session" : (manualBadge ? "manual" : "none"),
      };
      pushHistory(msg);
      logLine({ ...msg, ip_hash: sha1(ip) });
      broadcast(msg);
    });

    ws.on("close", () => {
      clients.delete(ws);
      logLine({ type: "disconnect", t: nowIso(), ip_hash: sha1(ip) });
    });
  });

  sys("Chat online: guest mode enabled (no tokens).");

  return {
    wss,
    openVotePoll(def = {}) {
      return openVotePollExternal(def);
    },
    closeVotePoll(reason = "closed") {
      return closePoll(reason);
    },
    broadcastJson(obj = {}) {
      broadcast(obj && typeof obj === "object" ? obj : { type: "noop", t: nowIso() });
    },
    getVotePollSnapshot(status = "active") {
      return buildPollSnapshot(status);
    },
    getState() {
      return { readonly, slowmodeMs, autoSlowmode, clients: clients.size, bans: bans.size, mutes: mutes.size, badges: badges.size, badgesFile, pollActive: !!activePoll };
    }
  };
}