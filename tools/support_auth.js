// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Jorge Ruiz Centelles
import crypto from "node:crypto";

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeDisplayName(value) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, 64);
}

function normalizePublicHandle(value) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, 32);
}

function hmacHex(secret, data) {
  return crypto.createHmac("sha256", String(secret)).update(String(data)).digest("hex");
}

function b64urlEncodeUtf8(text) {
  return Buffer.from(String(text), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function b64urlDecodeUtf8(text) {
  const normalized = String(text || "").replace(/-/g, "+").replace(/_/g, "/");
  const pad = normalized.length % 4 ? "=".repeat(4 - (normalized.length % 4)) : "";
  return Buffer.from(normalized + pad, "base64").toString("utf8");
}

function safeJsonParse(text, fallback = null) {
  try {
    return JSON.parse(String(text || ""));
  } catch {
    return fallback;
  }
}

function timingSafeEqualHex(aHex, bHex) {
  try {
    const a = Buffer.from(String(aHex || ""), "hex");
    const b = Buffer.from(String(bHex || ""), "hex");
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
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

function readJsonBody(req) {
  if (req && req.body && typeof req.body === "object") {
    return Promise.resolve(req.body);
  }

  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    const limit = 64 * 1024;

    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > limit) {
        reject(new Error("body_too_large"));
        try { req.destroy(); } catch {}
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      resolve(safeJsonParse(raw, {}));
    });

    req.on("error", reject);
  });
}

function writeJson(res, statusCode, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

function writeHtml(res, statusCode, html, extraHeaders = {}) {
  const body = String(html || "");
  res.writeHead(statusCode, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

function makeCookieHeader(name, value, options = {}) {
  const parts = [];
  parts.push(`${name}=${encodeURIComponent(value)}`);
  parts.push(`Path=${options.path || "/"}`);
  parts.push("HttpOnly");
  parts.push(`SameSite=${options.sameSite || "Lax"}`);
  if (options.secure) parts.push("Secure");
  if (Number.isFinite(Number(options.maxAge))) parts.push(`Max-Age=${Math.max(0, Number(options.maxAge))}`);
  if (options.expires) parts.push(`Expires=${new Date(options.expires).toUTCString()}`);
  return parts.join("; ");
}

function getClientIp(req) {
  const cf = req.headers["cf-connecting-ip"];
  if (cf) return String(cf).split(",")[0].trim();
  const xff = req.headers["x-forwarded-for"];
  if (xff) return String(xff).split(",")[0].trim();
  return String(req.socket?.remoteAddress || "").replace(/^::ffff:/, "") || "0.0.0.0";
}

function isLocalClientIp(ip) {
  return ip === "127.0.0.1" || ip === "::1" || ip === "localhost";
}

function parseQuery(reqUrl) {
  try {
    return new URL(String(reqUrl || ""), "http://localhost").searchParams;
  } catch {
    return new URLSearchParams();
  }
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildVerifyHtml({ ok, message, homeUrl = "/" }) {
  const title = ok ? "Email verified" : "Verification failed";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root{color-scheme:dark;--bg:#0d1014;--panel:#171c22;--line:rgba(255,255,255,.08);--ink:#eef2f6;--muted:rgba(238,242,246,.72)}
*{box-sizing:border-box} body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:linear-gradient(180deg,#12171d,#090c10);font-family:"Segoe UI",Arial,sans-serif;color:var(--ink)}
.card{width:min(680px,100%);padding:24px;border:1px solid var(--line);background:linear-gradient(180deg,rgba(255,255,255,.02),rgba(255,255,255,0) 18%),var(--panel)}
.title{font-size:22px;line-height:1.1;font-weight:800;margin:0 0 10px}.msg{font-size:14px;line-height:1.5;color:var(--muted);margin:0 0 16px}
.cta{display:inline-flex;align-items:center;justify-content:center;min-height:38px;padding:0 14px;text-decoration:none;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.04);color:var(--ink);font-weight:700}
</style>
</head>
<body>
<main class="card">
<h1 class="title">${escapeHtml(title)}</h1>
<p class="msg">${escapeHtml(message)}</p>
<a class="cta" href="${escapeHtml(homeUrl)}">Return to broadcast</a>
</main>
</body>
</html>`;
}

function buildResetHtml({ ok = false, message = "", token = "", homeUrl = "/" }) {
  const title = ok ? "Password reset ready" : "Password reset";
  const safeToken = escapeHtml(token);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root{color-scheme:dark;--bg:#0d1014;--panel:#171c22;--line:rgba(255,255,255,.08);--ink:#eef2f6;--muted:rgba(238,242,246,.72)}
*{box-sizing:border-box} body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:linear-gradient(180deg,#12171d,#090c10);font-family:"Segoe UI",Arial,sans-serif;color:var(--ink)}
.card{width:min(680px,100%);padding:24px;border:1px solid var(--line);background:linear-gradient(180deg,rgba(255,255,255,.02),rgba(255,255,255,0) 18%),var(--panel)}
.title{font-size:22px;line-height:1.1;font-weight:800;margin:0 0 10px}.msg{font-size:14px;line-height:1.5;color:var(--muted);margin:0 0 16px}
.input{width:100%;min-height:42px;padding:0 12px;margin:0 0 12px;border:1px solid var(--line);background:rgba(255,255,255,.03);color:var(--ink)}
.cta{display:inline-flex;align-items:center;justify-content:center;min-height:38px;padding:0 14px;text-decoration:none;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.04);color:var(--ink);font-weight:700;cursor:pointer}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.small{font-size:12px;color:var(--muted)}
</style>
</head>
<body>
<main class="card">
<h1 class="title">${escapeHtml(title)}</h1>
<p class="msg">${escapeHtml(message)}</p>
${ok ? `<div class="box"><div class="small">Token ready</div><div class="small">Use the JSON endpoint <code>/api/support/password/reset/confirm</code> with this token from the upcoming frontend or your admin test flow.</div></div><div class="box"><div class="small">Token</div><div class="small" style="word-break:break-word">${safeToken}</div></div>` : ``}
<div class="row"><a class="cta" href="${escapeHtml(homeUrl)}">Return to broadcast</a></div>
</main>
</body>
</html>`;
}

export function createSupportAuth(options = {}) {
  const store = options.store;
  if (!store) throw new Error("support_auth: store is required");

  const cookieName = String(options.cookieName || "ijccrl_support").trim() || "ijccrl_support";
  const cookieSecret = String(options.cookieSecret || "").trim();
  const sessionTtlDays = Math.max(1, Number(options.sessionTtlDays || 30));
  const loginCodeTtlMinutes = Math.max(5, Number(options.loginCodeTtlMinutes || 15));
  const secureCookies = !!options.secureCookies;
  const allowLocalCodeEcho = !!options.allowLocalCodeEcho;
  const allowLocalVerificationEcho = Object.prototype.hasOwnProperty.call(options, "allowLocalVerificationEcho")
    ? !!options.allowLocalVerificationEcho
    : allowLocalCodeEcho;
  const verificationTtlHours = Math.max(1, Number(options.verificationTtlHours || 48));
  const resetPasswordTtlHours = Math.max(1, Number(options.resetPasswordTtlHours || 2));
  const verifyEmailPath = String(options.verifyEmailPath || "/support/verify-email").trim() || "/support/verify-email";
  const resetPasswordPath = String(options.resetPasswordPath || "/support/reset-password").trim() || "/support/reset-password";
  const homeUrl = String(options.homeUrl || "/").trim() || "/";
  const mailDispatch = typeof options.mailDispatch === "function" ? options.mailDispatch : null;
  const mailEnabled = !!options.mailEnabled;
  const mailFrom = String(options.mailFrom || "").trim();
  const mailReplyTo = String(options.mailReplyTo || "").trim();

  if (!cookieSecret) throw new Error("support_auth: cookieSecret is required");

  function signSupportCookiePayload(sessionToken, expiresAtIso) {
    const ts = Date.now();
    const exp = Date.parse(String(expiresAtIso || ""));
    if (!sessionToken || !Number.isFinite(exp)) {
      throw new Error("support_auth: cannot sign support cookie payload");
    }
    const sig = hmacHex(cookieSecret, `${sessionToken}.${ts}.${exp}`);
    return b64urlEncodeUtf8(JSON.stringify({ sid: String(sessionToken), ts, exp, sig }));
  }

  function verifySupportCookieValue(rawCookieValue) {
    try {
      const decoded = b64urlDecodeUtf8(String(rawCookieValue || ""));
      const payload = safeJsonParse(decoded, null);
      if (!payload || typeof payload !== "object") return { ok: false };
      const sid = String(payload.sid || "");
      const ts = Number(payload.ts);
      const exp = Number(payload.exp);
      const sig = String(payload.sig || "");
      if (!sid || !Number.isFinite(ts) || !Number.isFinite(exp) || !sig) return { ok: false };
      if (Date.now() > exp) return { ok: false, expired: true };
      const expected = hmacHex(cookieSecret, `${sid}.${ts}.${exp}`);
      if (!timingSafeEqualHex(sig, expected)) return { ok: false };
      return { ok: true, sid, exp };
    } catch {
      return { ok: false };
    }
  }

  function setSupportSessionCookie(res, sessionToken, expiresAtIso) {
    const expMs = Date.parse(String(expiresAtIso || ""));
    const maxAge = Number.isFinite(expMs)
      ? Math.max(0, Math.floor((expMs - Date.now()) / 1000))
      : sessionTtlDays * 24 * 60 * 60;
    const signedValue = signSupportCookiePayload(sessionToken, expiresAtIso);
    const header = makeCookieHeader(cookieName, signedValue, {
      path: "/",
      sameSite: "Lax",
      secure: secureCookies,
      maxAge,
      expires: expiresAtIso,
    });
    res.setHeader("Set-Cookie", header);
    return header;
  }

  function clearSupportSessionCookie(res) {
    const header = makeCookieHeader(cookieName, "", {
      path: "/",
      sameSite: "Lax",
      secure: secureCookies,
      maxAge: 0,
      expires: new Date(0).toISOString(),
    });
    res.setHeader("Set-Cookie", header);
    return header;
  }

  function getSessionTokenFromRequest(req) {
    const cookies = parseCookies(req.headers.cookie);
    const raw = String(cookies[cookieName] || "");
    if (!raw) return "";
    const checked = verifySupportCookieValue(raw);
    return checked.ok ? checked.sid : "";
  }

  function getDefaultViewer() {
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

  function getViewerFromRequest(req) {
    const sid = getSessionTokenFromRequest(req);
    if (!sid) return getDefaultViewer();
    return store.getViewerBySessionToken(sid);
  }

  function maskEmail(value) {
    const email = normalizeEmail(value);
    const at = email.indexOf("@");
    if (at <= 1) return email || "hidden";
    const local = email.slice(0, at);
    const domain = email.slice(at + 1);
    const left = local.slice(0, 2);
    return `${left}${"*".repeat(Math.max(1, local.length - 2))}@${domain}`;
  }

  function safeDisplayName(viewerLike, fallback = "there") {
    const raw = normalizeDisplayName(
      viewerLike?.displayName ||
      viewerLike?.name ||
      viewerLike?.publicHandle ||
      viewerLike?.public_handle ||
      ""
    );
    return raw || fallback;
  }

  function buildAbsoluteSupportUrl(pathname, params = {}) {
    const base = new URL(homeUrl, "http://localhost");
    base.pathname = String(pathname || "/");
    base.search = "";
    for (const [key, value] of Object.entries(params || {})) {
      if (value == null || value === "") continue;
      base.searchParams.set(key, String(value));
    }
    return base.toString();
  }

  function buildVerifyUrl(_req, token) {
    return buildAbsoluteSupportUrl(verifyEmailPath, { token: String(token || "") });
  }

  function buildResetUrl(_req, token) {
    return buildAbsoluteSupportUrl(resetPasswordPath, { token: String(token || "") });
  }

  function formatExpiryLine(expiresAt) {
    const ts = Date.parse(String(expiresAt || ""));
    if (!Number.isFinite(ts)) return "This message expires soon.";
    return `Expires: ${new Date(ts).toUTCString()}`;
  }

  function buildVerificationMail({ viewer, verifyUrl, expiresAt }) {
    const name = safeDisplayName(viewer, "there");
    const subject = "Confirm your IJCCRL chat registration";
    const text = [
      `Hello ${name},`,
      "",
      "Your IJCCRL chat registration has been created.",
      "Confirm the email address to activate the account:",
      verifyUrl,
      "",
      formatExpiryLine(expiresAt),
      "",
      "If you did not request this registration, ignore this message.",
      "",
      homeUrl,
    ].join("\n");

    const html = `<!DOCTYPE html>
<html lang="en">
<body style="margin:0;padding:24px;background:#0d1014;color:#eef2f6;font-family:Segoe UI,Arial,sans-serif">
  <div style="max-width:680px;margin:0 auto;background:#171c22;border:1px solid rgba(255,255,255,.08);padding:24px">
    <h1 style="margin:0 0 14px;font-size:22px;line-height:1.1">Confirm your IJCCRL chat registration</h1>
    <p style="margin:0 0 12px;line-height:1.55">Hello ${escapeHtml(name)},</p>
    <p style="margin:0 0 12px;line-height:1.55">Your IJCCRL chat registration has been created. Confirm the email address to activate the account.</p>
    <p style="margin:18px 0">
      <a href="${escapeHtml(verifyUrl)}" style="display:inline-block;padding:12px 16px;background:#d7b477;color:#0d1014;text-decoration:none;font-weight:800">Confirm email</a>
    </p>
    <p style="margin:0 0 8px;line-height:1.55">Or open this link manually:</p>
    <p style="margin:0 0 12px;line-height:1.55;word-break:break-word">${escapeHtml(verifyUrl)}</p>
    <p style="margin:0 0 12px;line-height:1.55">${escapeHtml(formatExpiryLine(expiresAt))}</p>
    <p style="margin:0;line-height:1.55;color:rgba(238,242,246,.72)">If you did not request this registration, ignore this message.</p>
  </div>
</body>
</html>`;
    return { subject, text, html };
  }

  function buildLoginCodeMail({ viewer, code, expiresAt }) {
    const name = safeDisplayName(viewer, "there");
    const subject = "Your IJCCRL login code";
    const text = [
      `Hello ${name},`,
      "",
      "Use this code to access your IJCCRL chat account:",
      "",
      code,
      "",
      formatExpiryLine(expiresAt),
      "",
      "If you did not request this code, ignore this message.",
      "",
      homeUrl,
    ].join("\n");

    const html = `<!DOCTYPE html>
<html lang="en">
<body style="margin:0;padding:24px;background:#0d1014;color:#eef2f6;font-family:Segoe UI,Arial,sans-serif">
  <div style="max-width:680px;margin:0 auto;background:#171c22;border:1px solid rgba(255,255,255,.08);padding:24px">
    <h1 style="margin:0 0 14px;font-size:22px;line-height:1.1">Your IJCCRL login code</h1>
    <p style="margin:0 0 12px;line-height:1.55">Hello ${escapeHtml(name)},</p>
    <p style="margin:0 0 12px;line-height:1.55">Use this code to access your IJCCRL chat account:</p>
    <div style="display:inline-block;padding:14px 18px;background:#0d1014;border:1px solid rgba(255,255,255,.12);font-size:28px;font-weight:800;letter-spacing:.18em">${escapeHtml(code)}</div>
    <p style="margin:16px 0 12px;line-height:1.55">${escapeHtml(formatExpiryLine(expiresAt))}</p>
    <p style="margin:0;line-height:1.55;color:rgba(238,242,246,.72)">If you did not request this code, ignore this message.</p>
  </div>
</body>
</html>`;
    return { subject, text, html };
  }

  function buildResetMail({ viewer, resetUrl, expiresAt }) {
    const name = safeDisplayName(viewer, "there");
    const subject = "Reset your IJCCRL chat password";
    const text = [
      `Hello ${name},`,
      "",
      "A password reset was requested for your IJCCRL chat account.",
      "Open this link to continue:",
      resetUrl,
      "",
      formatExpiryLine(expiresAt),
      "",
      "If you did not request this reset, ignore this message.",
      "",
      homeUrl,
    ].join("\n");

    const html = `<!DOCTYPE html>
<html lang="en">
<body style="margin:0;padding:24px;background:#0d1014;color:#eef2f6;font-family:Segoe UI,Arial,sans-serif">
  <div style="max-width:680px;margin:0 auto;background:#171c22;border:1px solid rgba(255,255,255,.08);padding:24px">
    <h1 style="margin:0 0 14px;font-size:22px;line-height:1.1">Reset your IJCCRL chat password</h1>
    <p style="margin:0 0 12px;line-height:1.55">Hello ${escapeHtml(name)},</p>
    <p style="margin:0 0 12px;line-height:1.55">A password reset was requested for your IJCCRL chat account.</p>
    <p style="margin:18px 0">
      <a href="${escapeHtml(resetUrl)}" style="display:inline-block;padding:12px 16px;background:#d7b477;color:#0d1014;text-decoration:none;font-weight:800">Reset password</a>
    </p>
    <p style="margin:0 0 8px;line-height:1.55">Or open this link manually:</p>
    <p style="margin:0 0 12px;line-height:1.55;word-break:break-word">${escapeHtml(resetUrl)}</p>
    <p style="margin:0 0 12px;line-height:1.55">${escapeHtml(formatExpiryLine(expiresAt))}</p>
    <p style="margin:0;line-height:1.55;color:rgba(238,242,246,.72)">If you did not request this reset, ignore this message.</p>
  </div>
</body>
</html>`;
    return { subject, text, html };
  }

  async function dispatchSupportMail({ to, subject, text, html, route = "support" }) {
    if (!mailEnabled) {
      throw new Error(`support_mail_disabled:${route}`);
    }
    if (!mailDispatch) {
      throw new Error(`support_mail_transport_unavailable:${route}`);
    }
    await mailDispatch({
      to: normalizeEmail(to),
      subject: String(subject || "").trim(),
      text: String(text || ""),
      html: String(html || ""),
      route,
      from: mailFrom,
      replyTo: mailReplyTo || undefined,
    });
  }

  function maybeAttachDevEcho(payload, extra = {}) {
    const out = payload;
    const clientIp = getClientIp(extra.req);
    const allowEcho = !!extra.allowEcho;
    if (!allowEcho && !isLocalClientIp(clientIp)) return out;
    if (extra.verifyUrl) out.devVerifyUrl = extra.verifyUrl;
    if (extra.verifyToken) out.devVerifyToken = extra.verifyToken;
    if (extra.loginCode) out.devCode = extra.loginCode;
    if (extra.resetToken) out.devResetToken = extra.resetToken;
    if (extra.resetUrl) out.devResetUrl = extra.resetUrl;
    return out;
  }

  async function handleSupportMe(req, res) {
    const viewer = getViewerFromRequest(req);
    writeJson(res, 200, { ok: true, viewer });
  }

  async function handleSupportRegister(req, res) {
    const body = await readJsonBody(req);
    const email = normalizeEmail(body.email);
    const displayName = normalizeDisplayName(body.displayName || body.name || "");
    const publicHandle = normalizePublicHandle(body.publicHandle || body.nickname || displayName || "");
    const password = String(body.password || "");

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      writeJson(res, 400, { ok: false, error: "invalid_email" });
      return;
    }

    try {
      const user = store.createOrUpdatePendingUser({ email, displayName, publicHandle, password });
      const verification = store.createEmailVerificationToken(user.id, { ttlHours: verificationTtlHours });
      const verifyUrl = buildVerifyUrl(req, verification.token);
      const mail = buildVerificationMail({
        viewer: { displayName, publicHandle },
        verifyUrl,
        expiresAt: verification.expiresAt,
      });

      let delivery = "email";
      try {
        await dispatchSupportMail({
          to: email,
          subject: mail.subject,
          text: mail.text,
          html: mail.html,
          route: "register_verify",
        });
      } catch (mailErr) {
        if (!allowLocalVerificationEcho && !isLocalClientIp(getClientIp(req))) {
          writeJson(res, 502, {
            ok: false,
            error: "email_delivery_failed",
            message: mailErr instanceof Error ? mailErr.message : String(mailErr),
          });
          return;
        }
        delivery = "local_echo";
      }

      const payload = {
        ok: true,
        pendingVerification: true,
        email: maskEmail(email),
        expiresAt: verification.expiresAt,
        delivery,
        message: delivery === "email"
          ? "Registration saved. Check the inbox and confirm the email before the support session becomes active."
          : "Registration saved. Email delivery is not active for this route; using local verification echo.",
      };

      maybeAttachDevEcho(payload, {
        req,
        allowEcho: allowLocalVerificationEcho,
        verifyUrl,
        verifyToken: verification.token,
      });

      writeJson(res, 200, payload);
    } catch (err) {
      writeJson(res, 400, { ok: false, error: "register_failed", message: err instanceof Error ? err.message : String(err) });
    }
  }

  async function finalizeEmailVerification(token, res, { asHtml = false } = {}) {
    const viewer = store.consumeEmailVerificationToken(token);
    if (!viewer || !viewer.userId) {
      if (asHtml) {
        writeHtml(res, 400, buildVerifyHtml({ ok: false, message: "The verification link is invalid or has expired.", homeUrl }));
      } else {
        writeJson(res, 400, { ok: false, error: "invalid_or_expired_token" });
      }
      return;
    }

    const session = store.createSessionForUser(viewer.userId, { ttlDays: sessionTtlDays });
    setSupportSessionCookie(res, session.token, session.expiresAt);

    if (asHtml) {
      writeHtml(res, 200, buildVerifyHtml({ ok: true, message: "The support account is now verified and linked to a live session.", homeUrl }));
    } else {
      writeJson(res, 200, { ok: true, viewer: session.viewer, verified: true });
    }
  }

  async function handleSupportVerifyEmailGet(req, res) {
    const query = parseQuery(req.url);
    const token = String(query.get("token") || query.get("t") || "").trim();
    if (!token) {
      writeHtml(res, 400, buildVerifyHtml({ ok: false, message: "Missing verification token.", homeUrl }));
      return;
    }
    return finalizeEmailVerification(token, res, { asHtml: true });
  }

  async function handleSupportVerifyEmailPost(req, res) {
    const body = await readJsonBody(req);
    const token = String(body.token || body.t || "").trim();
    if (!token) {
      writeJson(res, 400, { ok: false, error: "missing_token" });
      return;
    }
    return finalizeEmailVerification(token, res, { asHtml: false });
  }

  async function handleSupportResetPasswordGet(req, res) {
    const query = parseQuery(req.url);
    const token = String(query.get("token") || query.get("t") || "").trim();
    if (!token) {
      writeHtml(res, 400, buildResetHtml({ ok: false, message: "Missing password reset token.", homeUrl }));
      return;
    }
    writeHtml(res, 200, buildResetHtml({ ok: true, token, message: "Set a new password for the verified support account.", homeUrl }));
  }

  async function handleSupportLoginRequestCode(req, res) {
    const body = await readJsonBody(req);
    const email = normalizeEmail(body.email);
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      writeJson(res, 400, { ok: false, error: "invalid_email" });
      return;
    }

    const existing = store.getUserByEmail(email);
    if (!existing) {
      writeJson(res, 404, { ok: false, error: "user_not_found" });
      return;
    }

    if (!Number(existing.is_email_verified || 0)) {
      const verification = store.createEmailVerificationToken(existing.id, { ttlHours: verificationTtlHours });
      const verifyUrl = buildVerifyUrl(req, verification.token);
      const mail = buildVerificationMail({
        viewer: existing,
        verifyUrl,
        expiresAt: verification.expiresAt,
      });

      let delivery = "email";
      try {
        await dispatchSupportMail({
          to: email,
          subject: mail.subject,
          text: mail.text,
          html: mail.html,
          route: "verify_before_login_code",
        });
      } catch (mailErr) {
        if (!allowLocalVerificationEcho && !isLocalClientIp(getClientIp(req))) {
          writeJson(res, 502, {
            ok: false,
            error: "email_delivery_failed",
            message: mailErr instanceof Error ? mailErr.message : String(mailErr),
          });
          return;
        }
        delivery = "local_echo";
      }

      const payload = {
        ok: false,
        error: "email_not_verified",
        email: maskEmail(email),
        expiresAt: verification.expiresAt,
        delivery,
        message: "Verify the email before requesting a login code.",
      };
      maybeAttachDevEcho(payload, {
        req,
        allowEcho: allowLocalVerificationEcho,
        verifyUrl,
        verifyToken: verification.token,
      });
      writeJson(res, 409, payload);
      return;
    }

    const codeInfo = store.createLoginCode(email, { ttlMinutes: loginCodeTtlMinutes });
    const mail = buildLoginCodeMail({
      viewer: existing,
      code: codeInfo.code,
      expiresAt: codeInfo.expiresAt,
    });

    let delivery = "email";
    try {
      await dispatchSupportMail({
        to: email,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
        route: "login_code",
      });
    } catch (mailErr) {
      if (!allowLocalCodeEcho && !isLocalClientIp(getClientIp(req))) {
        writeJson(res, 502, {
          ok: false,
          error: "email_delivery_failed",
          message: mailErr instanceof Error ? mailErr.message : String(mailErr),
        });
        return;
      }
      delivery = "local_echo";
    }

    const payload = {
      ok: true,
      delivery,
      email: maskEmail(email),
      expiresAt: codeInfo.expiresAt,
      message: delivery === "email"
        ? "Check the inbox for the login code."
        : "Email delivery is not active for this route; using local code echo.",
    };
    maybeAttachDevEcho(payload, {
      req,
      allowEcho: allowLocalCodeEcho,
      loginCode: codeInfo.code,
    });
    writeJson(res, 200, payload);
  }

  async function handleSupportLoginVerifyCode(req, res) {
    const body = await readJsonBody(req);
    const email = normalizeEmail(body.email);
    const code = String(body.code || "").trim();
    if (!email || !code) {
      writeJson(res, 400, { ok: false, error: "missing_email_or_code" });
      return;
    }
    const user = store.getUserByEmail(email);
    if (!user) {
      writeJson(res, 404, { ok: false, error: "user_not_found" });
      return;
    }
    if (!Number(user.is_email_verified || 0)) {
      writeJson(res, 409, { ok: false, error: "email_not_verified" });
      return;
    }
    const consumed = store.consumeLoginCode(email, code);
    if (!consumed) {
      writeJson(res, 401, { ok: false, error: "invalid_or_expired_code" });
      return;
    }
    const session = store.createSessionForUser(user.id, { ttlDays: sessionTtlDays });
    setSupportSessionCookie(res, session.token, session.expiresAt);
    writeJson(res, 200, { ok: true, viewer: session.viewer });
  }

  async function handleSupportLoginPassword(req, res) {
    const body = await readJsonBody(req);
    const identifier = String(body.identifier || body.email || body.nickname || body.publicHandle || "").trim();
    const password = String(body.password || "");
    if (!identifier || !password) {
      writeJson(res, 400, { ok: false, error: "missing_identifier_or_password" });
      return;
    }
    const result = store.authenticateUserPassword(identifier, password);
    if (!result || result.error === "invalid_credentials") {
      writeJson(res, 401, { ok: false, error: "invalid_credentials" });
      return;
    }
    if (result.error === "email_not_verified") {
      writeJson(res, 409, { ok: false, error: "email_not_verified" });
      return;
    }
    if (result.error === "password_not_set") {
      writeJson(res, 409, { ok: false, error: "password_not_set" });
      return;
    }
    const session = store.createSessionForUser(result.user.id, { ttlDays: sessionTtlDays });
    setSupportSessionCookie(res, session.token, session.expiresAt);
    writeJson(res, 200, { ok: true, viewer: session.viewer });
  }

  async function handleSupportPasswordResetRequest(req, res) {
    const body = await readJsonBody(req);
    const identifier = String(body.identifier || body.email || body.nickname || "").trim();
    if (!identifier) {
      writeJson(res, 400, { ok: false, error: "missing_identifier" });
      return;
    }

    const info = store.createPasswordResetToken(identifier, { ttlHours: resetPasswordTtlHours });
    if (!info || !info.token) {
      writeJson(res, 200, { ok: true, delivery: "email", requested: true });
      return;
    }

    const resetUrl = buildResetUrl(req, info.token);
    const mail = buildResetMail({
      viewer: { displayName: info.displayName || "", publicHandle: info.publicHandle || "" },
      resetUrl,
      expiresAt: info.expiresAt,
    });

    let delivery = "email";
    try {
      await dispatchSupportMail({
        to: info.email,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
        route: "password_reset",
      });
    } catch (mailErr) {
      if (!allowLocalCodeEcho && !isLocalClientIp(getClientIp(req))) {
        writeJson(res, 502, {
          ok: false,
          error: "email_delivery_failed",
          message: mailErr instanceof Error ? mailErr.message : String(mailErr),
        });
        return;
      }
      delivery = "local_echo";
    }

    const payload = {
      ok: true,
      delivery,
      requested: true,
      email: maskEmail(info.email),
      expiresAt: info.expiresAt,
      message: delivery === "email"
        ? "Check the inbox for the password reset link."
        : "Email delivery is not active for this route; using local reset echo.",
    };
    maybeAttachDevEcho(payload, {
      req,
      allowEcho: allowLocalCodeEcho,
      resetToken: info.token,
      resetUrl,
    });
    writeJson(res, 200, payload);
  }

  async function handleSupportPasswordResetConfirm(req, res) {
    let body = {};
    try {
      body = await readJsonBody(req);
    } catch {
      body = {};
    }
    const token = String(body.token || body.t || req.body?.token || "").trim();
    const newPassword = String(body.newPassword || body.password || "").trim();
    if (!token || !newPassword) {
      writeJson(res, 400, { ok: false, error: "missing_token_or_password" });
      return;
    }
    try {
      const viewer = store.consumePasswordResetToken(token, newPassword);
      if (!viewer || !viewer.userId) {
        writeJson(res, 400, { ok: false, error: "invalid_or_expired_token" });
        return;
      }
      const session = store.createSessionForUser(viewer.userId, { ttlDays: sessionTtlDays });
      setSupportSessionCookie(res, session.token, session.expiresAt);
      writeJson(res, 200, { ok: true, viewer: session.viewer, passwordReset: true });
    } catch (err) {
      writeJson(res, 400, { ok: false, error: "password_reset_failed", message: err instanceof Error ? err.message : String(err) });
    }
  }

  async function handleSupportLogout(req, res) {
    const sid = getSessionTokenFromRequest(req);
    if (sid) store.destroySession(sid);
    clearSupportSessionCookie(res);
    writeJson(res, 200, { ok: true });
  }

  async function handleSupportPaypalStart(req, res, options = {}) {
    const viewer = getViewerFromRequest(req);
    if (!viewer || !viewer.userId || !viewer.isRegistered || !viewer.isEmailVerified) {
      writeJson(res, 401, { ok: false, error: "auth_required" });
      return;
    }

    const paymentUrl = String(options.paymentUrl || "").trim();
    if (!paymentUrl) {
      writeJson(res, 500, { ok: false, error: "paypal_url_missing" });
      return;
    }

    const pending = store.getPendingPremiumAttemptForUser(viewer.userId);
    const attempt = pending || store.createPremiumAttempt(viewer.userId, {
      provider: "paypal",
      paymentUrl,
      amountEur: Number(options.amountEur || 5),
      currency: String(options.currency || "EUR"),
      status: "pending_verification",
    });

    writeJson(res, 200, {
      ok: true,
      provider: "paypal",
      mode: "hosted_link",
      redirectUrl: paymentUrl,
      attemptId: attempt ? attempt.attempt_id : "",
      viewer,
    });
  }

  return {
    cookieName,
    sessionTtlDays,
    loginCodeTtlMinutes,
    parseCookies,
    readJsonBody,
    writeJson,
    writeHtml,
    signSupportCookiePayload,
    verifySupportCookieValue,
    setSupportSessionCookie,
    clearSupportSessionCookie,
    getSessionTokenFromRequest,
    getViewerFromRequest,
    handleSupportMe,
    handleSupportRegister,
    handleSupportVerifyEmailGet,
    handleSupportVerifyEmailPost,
    handleSupportResetPasswordGet,
    handleSupportLoginRequestCode,
    handleSupportLoginVerifyCode,
    handleSupportLoginPassword,
    handleSupportPasswordResetRequest,
    handleSupportPasswordResetConfirm,
    handleSupportLogout,
    handleSupportPaypalStart,
  };
}
