// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Jorge Ruiz Centelles
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";

function safeMkdir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {}
}

function nowIso() {
  return new Date().toISOString();
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("hex");
}

function makeSupportStoreError(code, message) {
  const err = new Error(String(message || "support_store: unknown error"));
  err.code = String(code || "support_store_error");
  return err;
}


function buildPasswordHash(password) {
  const clean = String(password || "");
  if (clean.length < 8) {
    throw makeSupportStoreError("password_too_short", "support_store: password must be at least 8 characters");
  }
  const salt = crypto.randomBytes(16);
  const N = 16384;
  const r = 8;
  const p = 1;
  const dk = crypto.scryptSync(clean, salt, 64, { N, r, p });
  return `scrypt$${N}$${r}$${p}$${salt.toString("hex")}$${dk.toString("hex")}`;
}

function verifyPasswordHash(password, stored) {
  try {
    const clean = String(password || "");
    const raw = String(stored || "");
    if (!clean || !raw) return false;
    const parts = raw.split("$");
    if (parts.length !== 6 || parts[0] !== "scrypt") return false;
    const N = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    const salt = Buffer.from(parts[4], "hex");
    const expected = Buffer.from(parts[5], "hex");
    const derived = crypto.scryptSync(clean, salt, expected.length, { N, r, p });
    if (derived.length !== expected.length) return false;
    return crypto.timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeDisplayName(value) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, 64);
}

function normalizePublicHandle(value) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, 32);
}

function normalizePublicHandleKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_.-]/g, "")
    .slice(0, 32);
}

function resolvePremiumDurationDays(value, fallbackDays = 31) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return Math.max(1, Number(fallbackDays || 31) || 31);
  if (raw === "premium_7d" || raw === "7d" || raw === "7") return 7;
  if (raw === "premium_30d" || raw === "30d" || raw === "30") return 30;
  if (raw === "premium_31d" || raw === "31d" || raw === "31") return 31;
  const numeric = Number.parseInt(raw, 10);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  return Math.max(1, Number(fallbackDays || 31) || 31);
}

function localPartFromEmail(email) {
  const clean = normalizeEmail(email);
  const idx = clean.indexOf("@");
  return idx > 0 ? clean.slice(0, idx) : clean;
}

function roundPct(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 10000) / 100;
}

function appendJsonl(filePath, obj) {
  try {
    fs.appendFileSync(filePath, JSON.stringify(obj) + "\n", "utf8");
  } catch {}
}

function getTableColumns(db, tableName) {
  try {
    return db.prepare(`PRAGMA table_info(${tableName})`).all().map((row) => String(row.name || ""));
  } catch {
    return [];
  }
}

function ensureColumn(db, tableName, columnName, ddl) {
  const cols = new Set(getTableColumns(db, tableName));
  if (cols.has(columnName)) return;
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${ddl}`);
}

function toViewer(row) {
  if (!row) {
    return {
      auth: "guest",
      userId: null,
      email: "",
      displayName: "",
      publicHandle: "",
      isRegistered: false,
      isPremium: false,
      isEmailVerified: false,
      premiumStatus: "none",
      badgeLabel: "",
      canVote: false,
      canUsePremiumEmoji: false,
      canPublicRank: false,
      premiumExpiresAt: null,
    };
  }

  const isRegistered = !!Number(row.is_registered);
  const isPremium = !!Number(row.is_premium);
  return {
    auth: isPremium ? "premium" : (isRegistered ? "registered" : "guest"),
    userId: Number(row.user_id || row.id || 0) || null,
    email: String(row.email || ""),
    displayName: String(row.display_name || ""),
    publicHandle: String(row.public_handle || ""),
    isRegistered,
    isPremium,
    isEmailVerified: !!Number(row.is_email_verified),
    premiumStatus: String(row.premium_status || "none"),
    badgeLabel: String(row.badge_label || ""),
    canVote: !!Number(row.can_vote),
    canUsePremiumEmoji: !!Number(row.can_use_premium_emoji),
    canPublicRank: !!Number(row.can_public_rank),
    premiumExpiresAt: row.premium_expires_at ? String(row.premium_expires_at) : null,
  };
}

export function createSupportStore(options = {}) {
  const rootDir = path.resolve(options.rootDir || process.cwd());
  const outDir = path.resolve(options.outDir || path.join(rootDir, "out"));
  const dbPath = path.resolve(options.dbPath || path.join(outDir, "ijccrl_support.sqlite"));
  const mailCodesLogPath = path.resolve(options.mailCodesLogPath || path.join(outDir, "support_mail_codes.jsonl"));
  const paypalEventsLogPath = path.resolve(options.paypalEventsLogPath || path.join(outDir, "support_paypal_events.jsonl"));

  safeMkdir(outDir);

  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA synchronous = NORMAL;

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL DEFAULT '',
      public_handle TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT 'guest',
      is_public_in_rankings INTEGER NOT NULL DEFAULT 0,
      is_email_verified INTEGER NOT NULL DEFAULT 0,
      email_verified_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS support_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      session_token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS premium_purchases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      provider TEXT NOT NULL DEFAULT 'paypal',
      provider_payment_url TEXT NOT NULL DEFAULT '',
      provider_payment_id TEXT NOT NULL DEFAULT '',
      provider_payer_id TEXT NOT NULL DEFAULT '',
      provider_email TEXT NOT NULL DEFAULT '',
      attempt_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending_verification',
      amount_eur REAL NOT NULL DEFAULT 5.0,
      currency TEXT NOT NULL DEFAULT 'EUR',
      purchased_at TEXT,
      expires_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS entitlements (
      user_id INTEGER PRIMARY KEY,
      is_registered INTEGER NOT NULL DEFAULT 0,
      is_premium INTEGER NOT NULL DEFAULT 0,
      can_vote INTEGER NOT NULL DEFAULT 0,
      can_use_premium_emoji INTEGER NOT NULL DEFAULT 0,
      can_public_rank INTEGER NOT NULL DEFAULT 0,
      badge_label TEXT NOT NULL DEFAULT '',
      premium_status TEXT NOT NULL DEFAULT 'none',
      premium_expires_at TEXT,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS login_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      consumed_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS email_verifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      consumed_at TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      consumed_at TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS paypal_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL DEFAULT '',
      payload_json TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS vote_polls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      poll_id TEXT NOT NULL UNIQUE,
      match_key TEXT NOT NULL DEFAULT '',
      question TEXT NOT NULL DEFAULT '',
      options_json TEXT NOT NULL DEFAULT '[]',
      white_engine TEXT NOT NULL DEFAULT '',
      black_engine TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      opened_at TEXT NOT NULL,
      closes_at TEXT NOT NULL,
      closed_at TEXT,
      resolved_at TEXT,
      result_option_index INTEGER,
      result_label TEXT NOT NULL DEFAULT '',
      meta_json TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS vote_choices (
      poll_id TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      option_index INTEGER NOT NULL,
      option_label TEXT NOT NULL DEFAULT '',
      cast_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (poll_id, user_id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS vote_scoreboard (
      user_id INTEGER PRIMARY KEY,
      votes_total INTEGER NOT NULL DEFAULT 0,
      votes_correct INTEGER NOT NULL DEFAULT 0,
      votes_wrong INTEGER NOT NULL DEFAULT 0,
      accuracy_pct REAL NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS premium_grant_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      purchase_id INTEGER,
      action TEXT NOT NULL DEFAULT 'grant',
      duration_days INTEGER NOT NULL DEFAULT 0,
      reason TEXT NOT NULL DEFAULT '',
      granted_by TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      expires_at TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE INDEX IF NOT EXISTS idx_support_sessions_user_id ON support_sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_premium_purchases_user_id ON premium_purchases(user_id);
    CREATE INDEX IF NOT EXISTS idx_premium_purchases_status ON premium_purchases(status);
    CREATE INDEX IF NOT EXISTS idx_login_codes_email ON login_codes(email);
    CREATE INDEX IF NOT EXISTS idx_email_verifications_user_id ON email_verifications(user_id);
    CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user_id ON password_reset_tokens(user_id);
    CREATE INDEX IF NOT EXISTS idx_vote_polls_status ON vote_polls(status);
    CREATE INDEX IF NOT EXISTS idx_vote_choices_user_id ON vote_choices(user_id);
    CREATE INDEX IF NOT EXISTS idx_premium_grant_audit_user_id ON premium_grant_audit(user_id);
  `);

  // schema migration safety for existing files
  ensureColumn(db, "users", "is_email_verified", "is_email_verified INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "users", "email_verified_at", "email_verified_at TEXT");
  ensureColumn(db, "users", "public_handle_key", "public_handle_key TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "users", "password_hash", "password_hash TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "users", "password_updated_at", "password_updated_at TEXT");
  ensureColumn(db, "vote_scoreboard", "accuracy_pct", "accuracy_pct REAL NOT NULL DEFAULT 0");

  try {
    const rows = db.prepare(`SELECT id, public_handle FROM users`).all();
    const stmtBackfillHandleKey = db.prepare(`UPDATE users SET public_handle_key = ? WHERE id = ?`);
    for (const row of rows) {
      const handleKey = normalizePublicHandleKey(String(row.public_handle || ""));
      if (handleKey) stmtBackfillHandleKey.run(handleKey, row.id);
    }
  } catch {}

  const stmtGetUserByEmail = db.prepare(`SELECT * FROM users WHERE email = ? LIMIT 1`);
  const stmtGetUserByHandleKey = db.prepare(`SELECT * FROM users WHERE public_handle_key = ? LIMIT 1`);
  const stmtGetUserById = db.prepare(`SELECT * FROM users WHERE id = ? LIMIT 1`);
  const stmtInsertUser = db.prepare(`
    INSERT INTO users (
      email, display_name, public_handle, public_handle_key, password_hash, password_updated_at,
      role, is_public_in_rankings, is_email_verified, email_verified_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const stmtUpdateUser = db.prepare(`
    UPDATE users
    SET
      display_name = ?,
      public_handle = ?,
      public_handle_key = ?,
      password_hash = ?,
      password_updated_at = ?,
      role = ?,
      is_public_in_rankings = ?,
      is_email_verified = ?,
      email_verified_at = ?,
      updated_at = ?
    WHERE id = ?
  `);

  const stmtGetEntitlements = db.prepare(`SELECT * FROM entitlements WHERE user_id = ? LIMIT 1`);
  const stmtInsertEntitlements = db.prepare(`
    INSERT INTO entitlements (
      user_id, is_registered, is_premium, can_vote, can_use_premium_emoji,
      can_public_rank, badge_label, premium_status, premium_expires_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const stmtUpdateEntitlements = db.prepare(`
    UPDATE entitlements
    SET
      is_registered = ?,
      is_premium = ?,
      can_vote = ?,
      can_use_premium_emoji = ?,
      can_public_rank = ?,
      badge_label = ?,
      premium_status = ?,
      premium_expires_at = ?,
      updated_at = ?
    WHERE user_id = ?
  `);

  const stmtInsertSession = db.prepare(`
    INSERT INTO support_sessions (
      user_id, session_token_hash, expires_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?)
  `);
  const stmtGetSessionByHash = db.prepare(`
    SELECT s.*, u.email, u.display_name, u.public_handle
    FROM support_sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.session_token_hash = ?
    LIMIT 1
  `);
  const stmtDeleteExpiredSessions = db.prepare(`DELETE FROM support_sessions WHERE expires_at <= ?`);
  const stmtDeleteSessionByHash = db.prepare(`DELETE FROM support_sessions WHERE session_token_hash = ?`);

  const stmtInsertLoginCode = db.prepare(`
    INSERT INTO login_codes (email, code_hash, expires_at, created_at)
    VALUES (?, ?, ?, ?)
  `);
  const stmtConsumeLoginCode = db.prepare(`
    UPDATE login_codes
    SET consumed_at = ?
    WHERE email = ?
      AND code_hash = ?
      AND consumed_at IS NULL
      AND expires_at > ?
  `);

  const stmtInsertEmailVerification = db.prepare(`
    INSERT INTO email_verifications (user_id, token_hash, expires_at, created_at)
    VALUES (?, ?, ?, ?)
  `);
  const stmtGetEmailVerificationByHash = db.prepare(`
    SELECT * FROM email_verifications
    WHERE token_hash = ?
    LIMIT 1
  `);
  const stmtConsumeEmailVerification = db.prepare(`
    UPDATE email_verifications
    SET consumed_at = ?
    WHERE token_hash = ?
      AND consumed_at IS NULL
      AND expires_at > ?
  `);
  const stmtInsertPasswordResetToken = db.prepare(`
    INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, created_at)
    VALUES (?, ?, ?, ?)
  `);
  const stmtGetPasswordResetTokenByHash = db.prepare(`
    SELECT * FROM password_reset_tokens
    WHERE token_hash = ?
    LIMIT 1
  `);
  const stmtConsumePasswordResetToken = db.prepare(`
    UPDATE password_reset_tokens
    SET consumed_at = ?
    WHERE token_hash = ?
      AND consumed_at IS NULL
      AND expires_at > ?
  `);

  const stmtInsertPremiumAttempt = db.prepare(`
    INSERT INTO premium_purchases (
      user_id, provider, provider_payment_url, attempt_id, status,
      amount_eur, currency, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const stmtGetPremiumAttempt = db.prepare(`SELECT * FROM premium_purchases WHERE attempt_id = ? LIMIT 1`);
  const stmtLatestPurchaseByUser = db.prepare(`
    SELECT * FROM premium_purchases
    WHERE user_id = ?
    ORDER BY id DESC
    LIMIT 1
  `);
  const stmtUpdatePremiumAttempt = db.prepare(`
    UPDATE premium_purchases
    SET
      provider_payment_id = ?,
      provider_payer_id = ?,
      provider_email = ?,
      status = ?,
      purchased_at = ?,
      expires_at = ?,
      updated_at = ?
    WHERE attempt_id = ?
  `);
  const stmtFindPendingAttemptByUser = db.prepare(`
    SELECT * FROM premium_purchases
    WHERE user_id = ? AND status IN ('pending_verification', 'returned_unverified', 'pending')
    ORDER BY id DESC
    LIMIT 1
  `);
  const stmtFindPendingAttemptByEmail = db.prepare(`
    SELECT p.*
    FROM premium_purchases p
    JOIN users u ON u.id = p.user_id
    WHERE u.email = ?
      AND p.status IN ('pending_verification', 'returned_unverified', 'pending')
    ORDER BY p.id DESC
    LIMIT 1
  `);

  const stmtInsertPaypalEvent = db.prepare(`
    INSERT INTO paypal_events (event_type, payload_json, created_at)
    VALUES (?, ?, ?)
  `);

  const stmtUpsertVotePoll = db.prepare(`
    INSERT INTO vote_polls (
      poll_id, match_key, question, options_json, white_engine, black_engine,
      status, opened_at, closes_at, closed_at, resolved_at, result_option_index, result_label, meta_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(poll_id) DO UPDATE SET
      match_key = excluded.match_key,
      question = excluded.question,
      options_json = excluded.options_json,
      white_engine = excluded.white_engine,
      black_engine = excluded.black_engine,
      status = excluded.status,
      opened_at = excluded.opened_at,
      closes_at = excluded.closes_at,
      closed_at = excluded.closed_at,
      resolved_at = excluded.resolved_at,
      result_option_index = excluded.result_option_index,
      result_label = excluded.result_label,
      meta_json = excluded.meta_json
  `);
  const stmtGetVotePollById = db.prepare(`SELECT * FROM vote_polls WHERE poll_id = ? LIMIT 1`);
  const stmtGetLatestVotePoll = db.prepare(`SELECT * FROM vote_polls ORDER BY id DESC LIMIT 1`);
  const stmtCloseVotePoll = db.prepare(`
    UPDATE vote_polls
    SET status = ?, closed_at = ?, meta_json = ?
    WHERE poll_id = ?
  `);
  const stmtResolveVotePoll = db.prepare(`
    UPDATE vote_polls
    SET status = 'resolved', resolved_at = ?, result_option_index = ?, result_label = ?, meta_json = ?
    WHERE poll_id = ?
  `);
  const stmtUpsertVoteChoice = db.prepare(`
    INSERT INTO vote_choices (
      poll_id, user_id, option_index, option_label, cast_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(poll_id, user_id) DO UPDATE SET
      option_index = excluded.option_index,
      option_label = excluded.option_label,
      updated_at = excluded.updated_at
  `);
  const stmtGetVoteChoiceByPollUser = db.prepare(`SELECT * FROM vote_choices WHERE poll_id = ? AND user_id = ? LIMIT 1`);
  const stmtGetVoteChoicesByPoll = db.prepare(`SELECT * FROM vote_choices WHERE poll_id = ? ORDER BY updated_at ASC`);
  const stmtGetVoteCountsByPoll = db.prepare(`
    SELECT option_index, COUNT(*) AS votes
    FROM vote_choices
    WHERE poll_id = ?
    GROUP BY option_index
    ORDER BY option_index ASC
  `);
  const stmtGetScoreboardByUser = db.prepare(`SELECT * FROM vote_scoreboard WHERE user_id = ? LIMIT 1`);
  const stmtUpsertScoreboard = db.prepare(`
    INSERT INTO vote_scoreboard (
      user_id, votes_total, votes_correct, votes_wrong, accuracy_pct, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      votes_total = excluded.votes_total,
      votes_correct = excluded.votes_correct,
      votes_wrong = excluded.votes_wrong,
      accuracy_pct = excluded.accuracy_pct,
      updated_at = excluded.updated_at
  `);
  const stmtPublicLeaderboard = db.prepare(`
    SELECT
      u.id AS user_id,
      u.email,
      u.display_name,
      u.public_handle,
      e.badge_label,
      s.votes_total,
      s.votes_correct,
      s.votes_wrong,
      s.accuracy_pct
    FROM vote_scoreboard s
    JOIN users u ON u.id = s.user_id
    JOIN entitlements e ON e.user_id = s.user_id
    WHERE e.can_public_rank = 1
      AND s.votes_total > 0
    ORDER BY s.votes_correct DESC, s.accuracy_pct DESC, s.votes_total DESC, u.updated_at DESC
    LIMIT ?
  `);
  const stmtAdminUsers = db.prepare(`
    SELECT
      u.id AS user_id,
      u.email,
      u.display_name,
      u.public_handle,
      u.public_handle_key,
      u.role,
      u.is_email_verified,
      u.email_verified_at,
      u.created_at,
      u.updated_at,
      e.is_registered,
      e.is_premium,
      e.can_vote,
      e.can_use_premium_emoji,
      e.can_public_rank,
      e.badge_label,
      e.premium_status,
      e.premium_expires_at,
      (SELECT COUNT(*) FROM premium_purchases p WHERE p.user_id = u.id) AS payments_total,
      (SELECT MAX(p.created_at) FROM premium_purchases p WHERE p.user_id = u.id) AS last_payment_created_at
    FROM users u
    LEFT JOIN entitlements e ON e.user_id = u.id
    WHERE (? = '' OR u.email LIKE ? OR u.display_name LIKE ? OR u.public_handle LIKE ?)
    ORDER BY u.id DESC
    LIMIT ? OFFSET ?
  `);
  const stmtAdminUsersCount = db.prepare(`
    SELECT COUNT(*) AS total
    FROM users u
    WHERE (? = '' OR u.email LIKE ? OR u.display_name LIKE ? OR u.public_handle LIKE ?)
  `);
  const stmtAdminPayments = db.prepare(`
    SELECT
      p.id,
      p.user_id,
      u.email,
      u.public_handle,
      u.display_name,
      u.is_email_verified,
      p.provider,
      p.provider_payment_url,
      p.provider_payment_id,
      p.provider_payer_id,
      p.provider_email,
      p.attempt_id,
      p.status,
      p.amount_eur,
      p.currency,
      p.purchased_at,
      p.expires_at,
      p.created_at,
      p.updated_at
    FROM premium_purchases p
    JOIN users u ON u.id = p.user_id
    WHERE (? = '' OR p.status = ?)
      AND (? = '' OR u.email LIKE ? OR u.public_handle LIKE ? OR p.attempt_id LIKE ? OR p.provider_payment_id LIKE ?)
    ORDER BY p.id DESC
    LIMIT ? OFFSET ?
  `);
  const stmtAdminPaymentsCount = db.prepare(`
    SELECT COUNT(*) AS total
    FROM premium_purchases p
    JOIN users u ON u.id = p.user_id
    WHERE (? = '' OR p.status = ?)
      AND (? = '' OR u.email LIKE ? OR u.public_handle LIKE ? OR p.attempt_id LIKE ? OR p.provider_payment_id LIKE ?)
  `);

  const stmtInsertPremiumGrantAudit = db.prepare(`
    INSERT INTO premium_grant_audit (
      user_id, purchase_id, action, duration_days, reason, granted_by, note, created_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  function ensureEntitlementsRow(userId) {
    const existing = stmtGetEntitlements.get(userId);
    if (existing) return existing;
    const ts = nowIso();
    stmtInsertEntitlements.run(userId, 0, 0, 0, 0, 0, "", "none", null, ts);
    return stmtGetEntitlements.get(userId);
  }

  function recomputeEntitlements(userId) {
    const user = stmtGetUserById.get(userId);
    if (!user) return null;

    ensureEntitlementsRow(userId);

    const latest = stmtLatestPurchaseByUser.get(userId);
    const now = Date.now();
    const isVerified = !!Number(user.is_email_verified || 0);

    let isPremium = 0;
    let premiumStatus = "none";
    let premiumExpiresAt = null;
    let badgeLabel = "";
    let canVote = isVerified ? 1 : 0;
    let canUsePremiumEmoji = 0;
    let canPublicRank = isVerified ? 1 : 0;

    if (latest) {
      premiumStatus = String(latest.status || "none");
      premiumExpiresAt = latest.expires_at ? String(latest.expires_at) : null;
      const expiresMs = premiumExpiresAt ? Date.parse(premiumExpiresAt) : NaN;
      const activeAndValid = premiumStatus === "active" && (!Number.isFinite(expiresMs) || expiresMs > now);
      if (activeAndValid && isVerified) {
        isPremium = 1;
        badgeLabel = "Premium";
        canVote = 1;
        canUsePremiumEmoji = 1;
        canPublicRank = 1;
      }
    }

    const isRegistered = isVerified ? 1 : 0;
    const role = isPremium ? "premium" : (isRegistered ? "registered" : "guest");
    const ts = nowIso();

    stmtUpdateUser.run(
      String(user.display_name || ""),
      String(user.public_handle || ""),
      String(user.public_handle_key || normalizePublicHandleKey(user.public_handle || "")),
      String(user.password_hash || ""),
      user.password_updated_at ? String(user.password_updated_at) : null,
      role,
      Number(user.is_public_in_rankings || 0),
      isVerified ? 1 : 0,
      user.email_verified_at ? String(user.email_verified_at) : null,
      ts,
      userId,
    );

    stmtUpdateEntitlements.run(
      isRegistered,
      isPremium,
      canVote,
      canUsePremiumEmoji,
      canPublicRank,
      badgeLabel,
      premiumStatus,
      premiumExpiresAt,
      ts,
      userId,
    );

    return getViewerByUserId(userId);
  }

  function getViewerByUserId(userId) {
    const user = stmtGetUserById.get(userId);
    if (!user) return toViewer(null);
    const ent = ensureEntitlementsRow(userId);
    return toViewer({
      user_id: user.id,
      email: user.email,
      display_name: user.display_name,
      public_handle: user.public_handle,
      is_email_verified: user.is_email_verified,
      is_registered: ent.is_registered,
      is_premium: ent.is_premium,
      premium_status: ent.premium_status,
      badge_label: ent.badge_label,
      can_vote: ent.can_vote,
      can_use_premium_emoji: ent.can_use_premium_emoji,
      can_public_rank: ent.can_public_rank,
      premium_expires_at: ent.premium_expires_at,
    });
  }

  function getUserByEmail(email) {
    const cleanEmail = normalizeEmail(email);
    if (!cleanEmail) return null;
    return stmtGetUserByEmail.get(cleanEmail) || null;
  }

  function getUserByPublicHandle(handle) {
    const cleanHandleKey = normalizePublicHandleKey(handle);
    if (!cleanHandleKey) return null;
    return stmtGetUserByHandleKey.get(cleanHandleKey) || null;
  }

  function getUserByIdentifier(identifier) {
    const raw = String(identifier || "").trim();
    if (!raw) return null;
    if (raw.includes("@")) return getUserByEmail(raw);
    return getUserByPublicHandle(raw) || getUserByEmail(raw);
  }

  function createOrUpdatePendingUser({ email, displayName = "", publicHandle = "", password = "" }) {
    const cleanEmail = normalizeEmail(email);
    if (!cleanEmail) {
      throw makeSupportStoreError("invalid_email", "support_store: email is required");
    }
    const cleanDisplayName = normalizeDisplayName(displayName || localPartFromEmail(cleanEmail));
    const cleanPublicHandle = normalizePublicHandle(publicHandle || cleanDisplayName || localPartFromEmail(cleanEmail));
    const cleanPublicHandleKey = normalizePublicHandleKey(cleanPublicHandle || localPartFromEmail(cleanEmail));
    const passwordHash = password ? buildPasswordHash(password) : "";
    const ts = nowIso();

    const existing = stmtGetUserByEmail.get(cleanEmail);
    if (existing && Number(existing.is_email_verified || 0)) {
      throw makeSupportStoreError("email_already_registered", "support_store: email is already registered");
    }
    const handleOwner = cleanPublicHandleKey ? stmtGetUserByHandleKey.get(cleanPublicHandleKey) : null;
    if (handleOwner && Number(handleOwner.id || 0) !== Number(existing?.id || 0)) {
      throw makeSupportStoreError("public_handle_in_use", "support_store: public handle is already in use");
    }

    if (!existing) {
      const info = stmtInsertUser.run(
        cleanEmail,
        cleanDisplayName,
        cleanPublicHandle,
        cleanPublicHandleKey,
        passwordHash,
        passwordHash ? ts : null,
        "guest",
        0,
        0,
        null,
        ts,
        ts,
      );
      const userId = Number(info.lastInsertRowid);
      ensureEntitlementsRow(userId);
      recomputeEntitlements(userId);
      return stmtGetUserById.get(userId);
    }

    stmtUpdateUser.run(
      cleanDisplayName || String(existing.display_name || ""),
      cleanPublicHandle || String(existing.public_handle || ""),
      cleanPublicHandleKey || String(existing.public_handle_key || ""),
      passwordHash || String(existing.password_hash || ""),
      passwordHash ? ts : (existing.password_updated_at ? String(existing.password_updated_at) : null),
      Number(existing.is_email_verified || 0) ? (String(existing.role || "registered") || "registered") : "guest",
      Number(existing.is_public_in_rankings || 0),
      Number(existing.is_email_verified || 0) ? 1 : 0,
      existing.email_verified_at ? String(existing.email_verified_at) : null,
      ts,
      existing.id,
    );

    ensureEntitlementsRow(existing.id);
    recomputeEntitlements(existing.id);
    return stmtGetUserById.get(existing.id);
  }

  function markUserEmailVerified(userId) {
    const user = stmtGetUserById.get(userId);
    if (!user) return null;
    const verifiedAt = nowIso();
    stmtUpdateUser.run(
      String(user.display_name || ""),
      String(user.public_handle || ""),
      String(user.public_handle_key || normalizePublicHandleKey(user.public_handle || "")),
      String(user.password_hash || ""),
      user.password_updated_at ? String(user.password_updated_at) : null,
      Number(user.is_email_verified || 0) ? String(user.role || "registered") : "registered",
      Number(user.is_public_in_rankings || 0),
      1,
      verifiedAt,
      verifiedAt,
      userId,
    );
    return recomputeEntitlements(userId);
  }

  function createEmailVerificationToken(userId, { ttlHours = 48 } = {}) {
    const user = stmtGetUserById.get(userId);
    if (!user) throw new Error("support_store: user not found for email verification");
    const rawToken = randomToken(24);
    const tokenHash = sha256Hex(rawToken);
    const createdAt = nowIso();
    const expiresAt = new Date(Date.now() + Math.max(1, Number(ttlHours || 48)) * 60 * 60 * 1000).toISOString();
    stmtInsertEmailVerification.run(userId, tokenHash, expiresAt, createdAt);
    appendJsonl(mailCodesLogPath, {
      t: createdAt,
      scope: "support_verify",
      email: String(user.email || ""),
      user_id: userId,
      token: rawToken,
      expiresAt,
    });
    return { token: rawToken, expiresAt, email: String(user.email || "") };
  }

  function consumeEmailVerificationToken(rawToken) {
    const cleanToken = String(rawToken || "").trim();
    if (!cleanToken) return null;
    const tokenHash = sha256Hex(cleanToken);
    const row = stmtGetEmailVerificationByHash.get(tokenHash);
    if (!row) return null;
    const consumedAt = nowIso();
    const info = stmtConsumeEmailVerification.run(consumedAt, tokenHash, consumedAt);
    if (Number(info.changes) <= 0) return null;
    return markUserEmailVerified(row.user_id);
  }

  function createLoginCode(email, { ttlMinutes = 15 } = {}) {
    const cleanEmail = normalizeEmail(email);
    if (!cleanEmail) throw new Error("support_store: email is required for login code");
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const codeHash = sha256Hex(code);
    const createdAt = nowIso();
    const expiresAt = new Date(Date.now() + Math.max(5, Number(ttlMinutes || 15)) * 60_000).toISOString();
    stmtInsertLoginCode.run(cleanEmail, codeHash, expiresAt, createdAt);
    appendJsonl(mailCodesLogPath, {
      t: createdAt,
      scope: "support_login",
      email: cleanEmail,
      code,
      expiresAt,
    });
    return { email: cleanEmail, code, expiresAt };
  }

  function consumeLoginCode(email, code) {
    const cleanEmail = normalizeEmail(email);
    const codeHash = sha256Hex(String(code || "").trim());
    const consumedAt = nowIso();
    const info = stmtConsumeLoginCode.run(consumedAt, cleanEmail, codeHash, consumedAt);
    return Number(info.changes) > 0;
  }

  function authenticateUserPassword(identifier, password) {
    const user = getUserByIdentifier(identifier);
    if (!user) return null;
    if (!Number(user.is_email_verified || 0)) return { error: "email_not_verified", user };
    if (!String(user.password_hash || "")) return { error: "password_not_set", user };
    if (!verifyPasswordHash(password, user.password_hash)) return { error: "invalid_credentials", user };
    return { viewer: getViewerByUserId(user.id), user };
  }

  function setPasswordByUserId(userId, password) {
    const user = stmtGetUserById.get(Number(userId || 0));
    if (!user) return null;
    const ts = nowIso();
    const passwordHash = buildPasswordHash(password);
    stmtUpdateUser.run(
      String(user.display_name || ""),
      String(user.public_handle || ""),
      String(user.public_handle_key || normalizePublicHandleKey(user.public_handle || "")),
      passwordHash,
      ts,
      String(user.role || (Number(user.is_email_verified || 0) ? "registered" : "guest")),
      Number(user.is_public_in_rankings || 0),
      Number(user.is_email_verified || 0) ? 1 : 0,
      user.email_verified_at ? String(user.email_verified_at) : null,
      ts,
      user.id,
    );
    recomputeEntitlements(user.id);
    return stmtGetUserById.get(user.id) || null;
  }

  function createPasswordResetToken(identifierOrEmail, { ttlHours = 2 } = {}) {
    const user = getUserByIdentifier(identifierOrEmail);
    if (!user) return null;
    const rawToken = randomToken(24);
    const tokenHash = sha256Hex(rawToken);
    const createdAt = nowIso();
    const expiresAt = new Date(Date.now() + Math.max(1, Number(ttlHours || 2)) * 60 * 60 * 1000).toISOString();
    stmtInsertPasswordResetToken.run(user.id, tokenHash, expiresAt, createdAt);
    appendJsonl(mailCodesLogPath, {
      t: createdAt,
      scope: "support_reset_password",
      email: String(user.email || ""),
      user_id: user.id,
      token: rawToken,
      expiresAt,
    });
    return { token: rawToken, expiresAt, email: String(user.email || ""), userId: user.id };
  }

  function consumePasswordResetToken(rawToken, newPassword) {
    const cleanToken = String(rawToken || "").trim();
    if (!cleanToken) return null;
    const tokenHash = sha256Hex(cleanToken);
    const row = stmtGetPasswordResetTokenByHash.get(tokenHash);
    if (!row) return null;
    const consumedAt = nowIso();
    const info = stmtConsumePasswordResetToken.run(consumedAt, tokenHash, consumedAt);
    if (Number(info.changes) <= 0) return null;
    const user = setPasswordByUserId(row.user_id, newPassword);
    if (!user) return null;
    return getViewerByUserId(row.user_id);
  }

  function createSessionForUser(userId, { ttlDays = 30 } = {}) {
    const user = stmtGetUserById.get(userId);
    if (!user) throw new Error("support_store: user not found for session");
    const rawToken = randomToken(32);
    const tokenHash = sha256Hex(rawToken);
    const createdAt = nowIso();
    const expiresAt = new Date(Date.now() + Math.max(1, Number(ttlDays || 30)) * 24 * 60 * 60 * 1000).toISOString();
    stmtInsertSession.run(userId, tokenHash, expiresAt, createdAt, createdAt);
    return {
      token: rawToken,
      expiresAt,
      viewer: getViewerByUserId(userId),
    };
  }

  function getViewerBySessionToken(rawToken) {
    if (!rawToken) return toViewer(null);
    stmtDeleteExpiredSessions.run(nowIso());
    const tokenHash = sha256Hex(String(rawToken));
    const row = stmtGetSessionByHash.get(tokenHash);
    if (!row) return toViewer(null);
    const expiresMs = Date.parse(String(row.expires_at || ""));
    if (Number.isFinite(expiresMs) && expiresMs <= Date.now()) {
      stmtDeleteSessionByHash.run(tokenHash);
      return toViewer(null);
    }
    recomputeEntitlements(row.user_id);
    return getViewerByUserId(row.user_id);
  }

  function destroySession(rawToken) {
    if (!rawToken) return false;
    const tokenHash = sha256Hex(String(rawToken));
    const info = stmtDeleteSessionByHash.run(tokenHash);
    return Number(info.changes) > 0;
  }

  function createPremiumAttempt(userId, options = {}) {
    const user = stmtGetUserById.get(userId);
    if (!user) throw new Error("support_store: user not found for premium attempt");
    if (!Number(user.is_email_verified || 0)) throw new Error("support_store: premium attempt requires verified user");
    const attemptId = String(options.attemptId || randomToken(12));
    const provider = String(options.provider || "paypal");
    const paymentUrl = String(options.paymentUrl || "").trim();
    const status = String(options.status || "pending_verification");
    const amountEur = Number(options.amountEur ?? 5);
    const currency = String(options.currency || "EUR");
    const ts = nowIso();
    stmtInsertPremiumAttempt.run(userId, provider, paymentUrl, attemptId, status, amountEur, currency, ts, ts);
    return stmtGetPremiumAttempt.get(attemptId) || null;
  }

  function markPremiumAttemptStatus(attemptId, options = {}) {
    const row = stmtGetPremiumAttempt.get(String(attemptId || ""));
    if (!row) return null;
    const status = String(options.status || row.status || "pending_verification");
    const providerPaymentId = String(options.providerPaymentId || row.provider_payment_id || "");
    const providerPayerId = String(options.providerPayerId || row.provider_payer_id || "");
    const providerEmail = normalizeEmail(options.providerEmail || row.provider_email || "");
    const purchasedAt = options.purchasedAt ? String(options.purchasedAt) : (row.purchased_at ? String(row.purchased_at) : null);
    const expiresAt = options.expiresAt ? String(options.expiresAt) : (row.expires_at ? String(row.expires_at) : null);
    const updatedAt = nowIso();
    stmtUpdatePremiumAttempt.run(providerPaymentId, providerPayerId, providerEmail, status, purchasedAt, expiresAt, updatedAt, String(attemptId));
    const fresh = stmtGetPremiumAttempt.get(String(attemptId));
    if (fresh) recomputeEntitlements(fresh.user_id);
    return fresh || null;
  }

  function getPendingPremiumAttemptForUser(userId) {
    return stmtFindPendingAttemptByUser.get(userId) || null;
  }

  function findPendingPremiumAttemptByEmail(email) {
    const cleanEmail = normalizeEmail(email);
    if (!cleanEmail) return null;
    return stmtFindPendingAttemptByEmail.get(cleanEmail) || null;
  }

  function grantPremiumByUserId(userId, options = {}) {
    const user = stmtGetUserById.get(userId);
    if (!user) throw new Error("support_store: user not found for premium grant");
    if (!options.force && !Number(user.is_email_verified || 0)) throw new Error("support_store: premium grant requires verified user");

    const durationDays = resolvePremiumDurationDays(
      options.durationDays ?? options.premiumDurationDays ?? options.duration ?? options.grantType,
      31,
    );
    const purchasedAt = options.purchasedAt ? String(options.purchasedAt) : nowIso();
    const expiresAt = options.expiresAt
      ? String(options.expiresAt)
      : new Date(Date.now() + durationDays * 24 * 60 * 60 * 1000).toISOString();
    const provider = String(options.provider || "admin_manual");
    const attempt = createPremiumAttempt(userId, {
      provider,
      paymentUrl: String(options.paymentUrl || ""),
      amountEur: Number(options.amountEur ?? (provider === "admin_manual" ? 0 : 5)),
      currency: String(options.currency || "EUR"),
      status: "active",
      attemptId: String(options.attemptId || randomToken(12)),
    });
    const fresh = markPremiumAttemptStatus(attempt.attempt_id, {
      status: "active",
      providerPaymentId: String(options.providerPaymentId || ""),
      providerPayerId: String(options.providerPayerId || ""),
      providerEmail: normalizeEmail(options.providerEmail || user.email || ""),
      purchasedAt,
      expiresAt,
    });
    logPremiumGrantAudit({
      userId,
      purchaseId: fresh?.id ?? attempt?.id ?? null,
      action: "grant",
      durationDays,
      reason: String(options.reason || "manual_promo"),
      grantedBy: String(options.grantedBy || options.adminActor || ""),
      note: String(options.note || ""),
      createdAt: purchasedAt,
      expiresAt,
    });
    return recomputeEntitlements(userId);
  }

  function activatePremiumAttempt(attemptId, options = {}) {
    const row = stmtGetPremiumAttempt.get(String(attemptId || ""));
    if (!row) return null;
    const user = stmtGetUserById.get(row.user_id);
    if (!user || !Number(user.is_email_verified || 0)) {
      markPremiumAttemptStatus(String(attemptId || ""), { status: "paid_unverified", providerEmail: normalizeEmail(options.providerEmail || row.provider_email || "") });
      return null;
    }
    const durationDays = resolvePremiumDurationDays(
      options.durationDays ?? options.premiumDurationDays ?? options.duration,
      31,
    );
    const expiresAt = options.expiresAt
      ? String(options.expiresAt)
      : new Date(Date.now() + durationDays * 24 * 60 * 60 * 1000).toISOString();
    markPremiumAttemptStatus(row.attempt_id, {
      status: "active",
      providerPaymentId: String(options.providerPaymentId || row.provider_payment_id || ""),
      providerPayerId: String(options.providerPayerId || row.provider_payer_id || ""),
      providerEmail: normalizeEmail(options.providerEmail || row.provider_email || ""),
      purchasedAt: options.purchasedAt ? String(options.purchasedAt) : nowIso(),
      expiresAt,
    });
    return recomputeEntitlements(row.user_id);
  }

  function revokePremiumByUserId(userId, options = {}) {
    const user = stmtGetUserById.get(userId);
    if (!user) throw new Error("support_store: user not found for premium revoke");
    const latest = stmtLatestPurchaseByUser.get(userId);
    const revokedAt = options.revokedAt ? String(options.revokedAt) : nowIso();
    if (latest) {
      markPremiumAttemptStatus(latest.attempt_id, {
        status: "revoked",
        expiresAt: revokedAt,
      });
      logPremiumGrantAudit({
        userId,
        purchaseId: latest.id ?? null,
        action: "revoke",
        durationDays: 0,
        reason: String(options.reason || "manual_revoke"),
        grantedBy: String(options.revokedBy || options.adminActor || ""),
        note: String(options.note || ""),
        createdAt: revokedAt,
        expiresAt: revokedAt,
      });
    }
    ensureEntitlementsRow(userId);
    stmtUpdateEntitlements.run(
      Number(user.is_email_verified || 0) ? 1 : 0,
      0,
      Number(user.is_email_verified || 0) ? 1 : 0,
      0,
      0,
      "",
      latest ? "revoked" : "none",
      revokedAt,
      revokedAt,
      userId,
    );
    stmtUpdateUser.run(
      String(user.display_name || ""),
      String(user.public_handle || ""),
      String(user.public_handle_key || normalizePublicHandleKey(user.public_handle || "")),
      String(user.password_hash || ""),
      user.password_updated_at ? String(user.password_updated_at) : null,
      Number(user.is_email_verified || 0) ? "registered" : "guest",
      Number(user.is_public_in_rankings || 0),
      Number(user.is_email_verified || 0) ? 1 : 0,
      user.email_verified_at ? String(user.email_verified_at) : null,
      revokedAt,
      userId,
    );
    return getViewerByUserId(userId);
  }

  function recordPaypalEvent(eventType, payload) {
    const createdAt = nowIso();
    const json = JSON.stringify(payload || {});
    stmtInsertPaypalEvent.run(String(eventType || ""), json, createdAt);
    appendJsonl(paypalEventsLogPath, {
      t: createdAt,
      eventType: String(eventType || ""),
      payload: payload || {},
    });
    return true;
  }

  function logPremiumGrantAudit({ userId, purchaseId = null, action = "grant", durationDays = 0, reason = "", grantedBy = "", note = "", createdAt = nowIso(), expiresAt = null } = {}) {
    stmtInsertPremiumGrantAudit.run(
      Number(userId || 0),
      purchaseId == null ? null : Number(purchaseId || 0),
      String(action || "grant"),
      Math.max(0, Number(durationDays || 0) || 0),
      String(reason || ""),
      String(grantedBy || ""),
      String(note || ""),
      String(createdAt || nowIso()),
      expiresAt ? String(expiresAt) : null,
    );
    return true;
  }

  function getViewerByEmail(email) {
    const user = getUserByEmail(email);
    if (!user) return toViewer(null);
    ensureEntitlementsRow(user.id);
    recomputeEntitlements(user.id);
    return getViewerByUserId(user.id);
  }

  function listAdminUsers({ limit = 50, offset = 0, query = "" } = {}) {
    const q = String(query || "").trim();
    const like = q ? `%${q}%` : "";
    const cleanLimit = Math.max(1, Math.min(200, Number(limit || 50)));
    const cleanOffset = Math.max(0, Number(offset || 0));
    const rows = stmtAdminUsers.all(q, like, like, like, cleanLimit, cleanOffset);
    const totalRow = stmtAdminUsersCount.get(q, like, like, like) || { total: rows.length };
    return {
      total: Number(totalRow.total || 0),
      items: rows.map((row) => ({
        userId: Number(row.user_id || 0),
        email: String(row.email || ""),
        displayName: String(row.display_name || ""),
        publicHandle: String(row.public_handle || ""),
        publicHandleKey: String(row.public_handle_key || ""),
        role: String(row.role || "guest"),
        isEmailVerified: !!Number(row.is_email_verified || 0),
        emailVerifiedAt: row.email_verified_at ? String(row.email_verified_at) : null,
        createdAt: String(row.created_at || ""),
        updatedAt: String(row.updated_at || ""),
        isRegistered: !!Number(row.is_registered || 0),
        isPremium: !!Number(row.is_premium || 0),
        canVote: !!Number(row.can_vote || 0),
        canUsePremiumEmoji: !!Number(row.can_use_premium_emoji || 0),
        canPublicRank: !!Number(row.can_public_rank || 0),
        badgeLabel: String(row.badge_label || ""),
        premiumStatus: String(row.premium_status || "none"),
        premiumExpiresAt: row.premium_expires_at ? String(row.premium_expires_at) : null,
        paymentsTotal: Number(row.payments_total || 0),
        lastPaymentCreatedAt: row.last_payment_created_at ? String(row.last_payment_created_at) : null,
      })),
    };
  }

  function listAdminPayments({ limit = 50, offset = 0, query = "", status = "" } = {}) {
    const q = String(query || "").trim();
    const s = String(status || "").trim();
    const like = q ? `%${q}%` : "";
    const cleanLimit = Math.max(1, Math.min(200, Number(limit || 50)));
    const cleanOffset = Math.max(0, Number(offset || 0));
    const rows = stmtAdminPayments.all(s, s, q, like, like, like, like, cleanLimit, cleanOffset);
    const totalRow = stmtAdminPaymentsCount.get(s, s, q, like, like, like, like) || { total: rows.length };
    return {
      total: Number(totalRow.total || 0),
      items: rows.map((row) => ({
        id: Number(row.id || 0),
        userId: Number(row.user_id || 0),
        email: String(row.email || ""),
        publicHandle: String(row.public_handle || ""),
        displayName: String(row.display_name || ""),
        isEmailVerified: !!Number(row.is_email_verified || 0),
        provider: String(row.provider || "paypal"),
        providerPaymentUrl: String(row.provider_payment_url || ""),
        providerPaymentId: String(row.provider_payment_id || ""),
        providerPayerId: String(row.provider_payer_id || ""),
        providerEmail: String(row.provider_email || ""),
        attemptId: String(row.attempt_id || ""),
        status: String(row.status || ""),
        amountEur: Number(row.amount_eur || 0),
        currency: String(row.currency || "EUR"),
        purchasedAt: row.purchased_at ? String(row.purchased_at) : null,
        expiresAt: row.expires_at ? String(row.expires_at) : null,
        createdAt: String(row.created_at || ""),
        updatedAt: String(row.updated_at || ""),
      })),
    };
  }

  function createOrReplaceVotePoll({
    pollId,
    matchKey = "",
    question = "",
    options = [],
    whiteEngine = "",
    blackEngine = "",
    openedAt,
    closesAt,
    status = "active",
    meta = {},
  }) {
    const cleanPollId = String(pollId || "").trim() || randomToken(10);
    const ts = nowIso();
    const cleanOptions = Array.isArray(options) ? options.map((v) => String(v || "").trim()).filter(Boolean).slice(0, 4) : [];
    stmtUpsertVotePoll.run(
      cleanPollId,
      String(matchKey || ""),
      String(question || "").trim(),
      JSON.stringify(cleanOptions),
      String(whiteEngine || "").trim(),
      String(blackEngine || "").trim(),
      String(status || "active"),
      String(openedAt || ts),
      String(closesAt || ts),
      null,
      null,
      null,
      "",
      JSON.stringify(meta || {}),
    );
    return getVotePollByPollId(cleanPollId);
  }

  function parseVotePollRow(row) {
    if (!row) return null;
    let options = [];
    let meta = {};
    try { options = JSON.parse(String(row.options_json || "[]")); } catch {}
    try { meta = JSON.parse(String(row.meta_json || "{}")); } catch {}
    return {
      pollId: String(row.poll_id || ""),
      matchKey: String(row.match_key || ""),
      question: String(row.question || ""),
      options: Array.isArray(options) ? options : [],
      whiteEngine: String(row.white_engine || ""),
      blackEngine: String(row.black_engine || ""),
      status: String(row.status || "active"),
      openedAt: String(row.opened_at || ""),
      closesAt: String(row.closes_at || ""),
      closedAt: row.closed_at ? String(row.closed_at) : null,
      resolvedAt: row.resolved_at ? String(row.resolved_at) : null,
      resultOptionIndex: Number.isFinite(Number(row.result_option_index)) ? Number(row.result_option_index) : null,
      resultLabel: String(row.result_label || ""),
      meta,
    };
  }

  function getVotePollByPollId(pollId) {
    return parseVotePollRow(stmtGetVotePollById.get(String(pollId || "")) || null);
  }

  function getLatestVotePoll() {
    return parseVotePollRow(stmtGetLatestVotePoll.get() || null);
  }

  function closeVotePoll(pollId, reason = "closed") {
    const poll = getVotePollByPollId(pollId);
    if (!poll) return null;
    const meta = { ...(poll.meta || {}), closeReason: String(reason || "closed") };
    stmtCloseVotePoll.run(String(reason === "resolved" ? "resolved" : "closed"), nowIso(), JSON.stringify(meta), String(pollId));
    return getVotePollByPollId(pollId);
  }

  function recordVoteChoice({ pollId, userId, optionIndex, optionLabel = "", castAt }) {
    const cleanPollId = String(pollId || "").trim();
    const cleanUserId = Number(userId || 0);
    if (!cleanPollId || !cleanUserId) return null;
    const ts = String(castAt || nowIso());
    stmtUpsertVoteChoice.run(cleanPollId, cleanUserId, Number(optionIndex || 0), String(optionLabel || ""), ts, ts);
    return stmtGetVoteChoiceByPollUser.get(cleanPollId, cleanUserId) || null;
  }

  function getVoteChoiceByPollUser(pollId, userId) {
    return stmtGetVoteChoiceByPollUser.get(String(pollId || ""), Number(userId || 0)) || null;
  }

  function getVoteCountsForPoll(pollId) {
    return stmtGetVoteCountsByPoll.all(String(pollId || "")).map((row) => ({
      optionIndex: Number(row.option_index || 0),
      votes: Number(row.votes || 0),
    }));
  }

  function getVoteScoreByUserId(userId) {
    const row = stmtGetScoreboardByUser.get(Number(userId || 0));
    if (!row) {
      return { userId: Number(userId || 0), votesTotal: 0, votesCorrect: 0, votesWrong: 0, accuracyPct: 0 };
    }
    return {
      userId: Number(row.user_id || 0),
      votesTotal: Number(row.votes_total || 0),
      votesCorrect: Number(row.votes_correct || 0),
      votesWrong: Number(row.votes_wrong || 0),
      accuracyPct: Number(row.accuracy_pct || 0),
    };
  }

  function resolveVotePoll({ pollId, resultOptionIndex, resultLabel = "", resolvedAt = nowIso(), meta = {} }) {
    const poll = getVotePollByPollId(pollId);
    if (!poll) return null;
    if (poll.resolvedAt) return poll;

    const cleanResultIndex = Number(resultOptionIndex);
    const choiceRows = stmtGetVoteChoicesByPoll.all(String(pollId || ""));

    db.exec("BEGIN");
    try {
      for (const choice of choiceRows) {
        const prev = stmtGetScoreboardByUser.get(choice.user_id);
        const votesTotal = Number(prev?.votes_total || 0) + 1;
        const isCorrect = Number(choice.option_index) === cleanResultIndex;
        const votesCorrect = Number(prev?.votes_correct || 0) + (isCorrect ? 1 : 0);
        const votesWrong = Number(prev?.votes_wrong || 0) + (isCorrect ? 0 : 1);
        const accuracyPct = votesTotal > 0 ? roundPct((votesCorrect / votesTotal) * 100) : 0;
        stmtUpsertScoreboard.run(choice.user_id, votesTotal, votesCorrect, votesWrong, accuracyPct, String(resolvedAt));
      }

      const mergedMeta = { ...(poll.meta || {}), ...(meta || {}) };
      stmtResolveVotePoll.run(String(resolvedAt), cleanResultIndex, String(resultLabel || ""), JSON.stringify(mergedMeta), String(pollId));
      db.exec("COMMIT");
    } catch (err) {
      try { db.exec("ROLLBACK"); } catch {}
      throw err;
    }

    return getVotePollByPollId(pollId);
  }

  function getPublicVoteLeaderboard(limit = 25) {
    const rows = stmtPublicLeaderboard.all(Math.max(1, Math.min(100, Number(limit || 25))));
    return rows.map((row, idx) => ({
      rank: idx + 1,
      userId: Number(row.user_id || 0),
      nickname: String(row.public_handle || row.display_name || localPartFromEmail(row.email) || "User"),
      correct: Number(row.votes_correct || 0),
      wrong: Number(row.votes_wrong || 0),
      total: Number(row.votes_total || 0),
      accuracyPct: Number(row.accuracy_pct || 0),
      badgeLabel: String(row.badge_label || ""),
    }));
  }

  try {
    const allUsers = db.prepare(`SELECT id FROM users`).all();
    for (const row of allUsers) {
      if (row && row.id) recomputeEntitlements(row.id);
    }
  } catch {}

  function close() {
    try { db.close(); } catch {}
  }

  return {
    db,
    dbPath,
    mailCodesLogPath,
    paypalEventsLogPath,
    nowIso,
    normalizeEmail,
    normalizeDisplayName,
    normalizePublicHandle,
    normalizePublicHandleKey,
    getUserByEmail,
    getUserByPublicHandle,
    getUserByIdentifier,
    getUserById: (userId) => stmtGetUserById.get(Number(userId || 0)) || null,
    resolvePremiumDurationDays,
    getViewerByEmail,
    getViewerByUserId,
    getViewerBySessionToken,
    createOrUpdatePendingUser,
    markUserEmailVerified,
    authenticateUserPassword,
    setPasswordByUserId,
    createPasswordResetToken,
    consumePasswordResetToken,
    createEmailVerificationToken,
    consumeEmailVerificationToken,
    createLoginCode,
    consumeLoginCode,
    createSessionForUser,
    destroySession,
    createPremiumAttempt,
    getPendingPremiumAttemptForUser,
    findPendingPremiumAttemptByEmail,
    markPremiumAttemptStatus,
    activatePremiumAttempt,
    grantPremiumByUserId,
    revokePremiumByUserId,
    recordPaypalEvent,
    recomputeEntitlements,
    listAdminUsers,
    listAdminPayments,
    createOrReplaceVotePoll,
    getVotePollByPollId,
    getLatestVotePoll,
    closeVotePoll,
    recordVoteChoice,
    getVoteChoiceByPollUser,
    getVoteCountsForPoll,
    resolveVotePoll,
    getVoteScoreByUserId,
    getPublicVoteLeaderboard,
    close,
  };
}
