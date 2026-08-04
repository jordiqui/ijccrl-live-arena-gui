// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Jorge Ruiz Centelles
import { URL } from "node:url";

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function parseQuery(reqUrl) {
  try {
    const u = new URL(String(reqUrl || ""), "http://localhost");
    return u.searchParams;
  } catch {
    return new URLSearchParams();
  }
}

function readJsonBody(req) {
  if (req && req.body && typeof req.body === "object") {
    return Promise.resolve(req.body);
  }

  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    const limit = 128 * 1024;

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
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
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

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function firstString(...values) {
  for (const value of values) {
    const s = String(value || "").trim();
    if (s) return s;
  }
  return "";
}

function looksLikeSuccessStatus(raw) {
  const s = String(raw || "").trim().toUpperCase();
  return s === "COMPLETED" || s === "COMPLETED_PAYMENT" || s === "SUCCESS" || s === "SUCCEEDED" || s === "PAID" || s === "APPROVED";
}

function extractPaypalEmail(body) {
  return normalizeEmail(
    body?.payer_email ||
    body?.payerEmail ||
    body?.email ||
    body?.resource?.payer?.email_address ||
    body?.resource?.payer_email ||
    body?.resource?.email ||
    body?.payer?.email_address ||
    ""
  );
}

function extractAttemptId(body) {
  return firstString(
    body?.attempt_id,
    body?.attemptId,
    body?.custom_id,
    body?.customId,
    body?.resource?.custom_id,
    body?.resource?.customId,
    body?.resource?.purchase_units?.[0]?.custom_id,
  );
}

function extractProviderPaymentId(body) {
  return firstString(
    body?.providerPaymentId,
    body?.payment_id,
    body?.paymentId,
    body?.id,
    body?.resource?.id,
    body?.resource?.capture_id,
  );
}

function extractProviderPayerId(body) {
  return firstString(
    body?.providerPayerId,
    body?.payer_id,
    body?.payerId,
    body?.resource?.payer?.payer_id,
    body?.payer?.payer_id,
  );
}

export function createPaypalSupport(options = {}) {
  const store = options.store;
  if (!store) throw new Error("paypal_support: store is required");

  const paymentUrl = String(options.paymentUrl || "").trim();
  const amountEur = Number(options.amountEur || 5);
  const currency = String(options.currency || "EUR").trim() || "EUR";
  const returnPath = String(options.returnPath || "/support/paypal/return").trim() || "/support/paypal/return";
  const homeUrl = String(options.homeUrl || "/").trim() || "/";
  const premiumDurationDays = Number.isFinite(Number(options.premiumDurationDays)) ? Number(options.premiumDurationDays) : 31;

  if (!paymentUrl) throw new Error("paypal_support: paymentUrl is required");

  function getConfig() {
    return {
      provider: "paypal",
      mode: "hosted_link",
      paymentUrl,
      amountEur,
      currency,
      returnPath,
      homeUrl,
      premiumDurationDays,
    };
  }

  function getStartOptions() {
    return { paymentUrl, amountEur, currency };
  }

  function buildPaypalReturnHtml({ attemptId = "", status = "pending_verification", homeHref = "/" }) {
    const safeAttemptId = escapeHtml(attemptId);
    const safeStatus = escapeHtml(status);
    const safeHomeHref = escapeHtml(homeHref);
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>IJCCRL Premium Payment</title>
<style>
  :root{color-scheme:dark;--bg:#0c0d10;--panel:#171a1f;--line:rgba(255,255,255,.08);--ink:#eef2f6;--muted:rgba(238,242,246,.68)}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:linear-gradient(180deg,#11151a,#090b0e);color:var(--ink);font-family:"Segoe UI",Arial,sans-serif;padding:24px}
  .card{width:min(680px,100%);border:1px solid var(--line);background:linear-gradient(180deg,rgba(255,255,255,.02),rgba(255,255,255,0) 18%),var(--panel);padding:24px}
  .title{font-size:22px;line-height:1.1;font-weight:800;margin:0 0 8px}.sub{font-size:14px;line-height:1.45;color:var(--muted);margin:0 0 18px}
  .box{border:1px solid var(--line);padding:14px 16px;margin:0 0 16px;background:rgba(255,255,255,.02)}
  .label{font-size:12px;line-height:1;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin-bottom:8px}
  .value{font-size:14px;line-height:1.45;word-break:break-word}
  .cta{display:inline-flex;align-items:center;justify-content:center;min-height:38px;padding:0 14px;text-decoration:none;border:1px solid rgba(255,209,64,.28);background:rgba(255,209,64,.10);color:var(--ink);font-weight:700}
</style>
</head>
<body>
  <main class="card">
    <h1 class="title">Premium payment recorded</h1>
    <p class="sub">Your return has been recorded by the broadcast support layer. Premium access remains <strong>pending verification</strong> until the payment is confirmed in backend.</p>
    <div class="box"><div class="label">Status</div><div class="value">${safeStatus}</div></div>
    <div class="box"><div class="label">Attempt ID</div><div class="value">${safeAttemptId || "Not provided"}</div></div>
    <a class="cta" href="${safeHomeHref}">Return to broadcast</a>
  </main>
</body>
</html>`;
  }

  function markAttemptReturned(attemptId) {
    const clean = String(attemptId || "").trim();
    if (!clean) return null;
    return store.markPremiumAttemptStatus(clean, { status: "returned_unverified" });
  }

  async function handlePaypalReturn(req, res) {
    const query = parseQuery(req.url);
    const attemptId = String(query.get("attempt_id") || query.get("attemptId") || "").trim();
    const updated = attemptId ? markAttemptReturned(attemptId) : null;
    const status = updated ? String(updated.status || "returned_unverified") : "pending_verification";
    writeHtml(res, 200, buildPaypalReturnHtml({ attemptId, status, homeHref: homeUrl }));
  }

  async function handlePaypalWebhook(req, res) {
    let body = {};
    try {
      body = await readJsonBody(req);
    } catch {
      writeJson(res, 400, { ok: false, error: "invalid_body" });
      return;
    }

    const eventType = String(body.event_type || body.eventType || body.txn_type || body.type || "paypal_webhook").trim();
    store.recordPaypalEvent(eventType, body);

    const attemptId = extractAttemptId(body);
    const payerEmail = extractPaypalEmail(body);
    const providerPaymentId = extractProviderPaymentId(body);
    const providerPayerId = extractProviderPayerId(body);
    const status = firstString(body.status, body.payment_status, body.paymentStatus, body.resource?.status, body.resource?.state, body.txn_status);

    let viewer = null;
    let linkedBy = "none";

    try {
      if (attemptId && looksLikeSuccessStatus(status)) {
        viewer = store.activatePremiumAttempt(attemptId, {
          providerEmail: payerEmail,
          providerPaymentId,
          providerPayerId,
          purchasedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + premiumDurationDays * 24 * 60 * 60 * 1000).toISOString(),
        });
        linkedBy = viewer ? "attempt_id" : linkedBy;
      }

      if (!viewer && payerEmail && looksLikeSuccessStatus(status)) {
        const pending = store.findPendingPremiumAttemptByEmail(payerEmail);
        if (pending) {
          viewer = store.activatePremiumAttempt(pending.attempt_id, {
            providerEmail: payerEmail,
            providerPaymentId,
            providerPayerId,
            purchasedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + premiumDurationDays * 24 * 60 * 60 * 1000).toISOString(),
          });
          linkedBy = viewer ? "email" : linkedBy;
        }
      }
    } catch (err) {
      writeJson(res, 500, {
        ok: false,
        error: "paypal_reconcile_failed",
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    writeJson(res, 200, {
      ok: true,
      recorded: true,
      linkedBy,
      viewer,
      attemptId,
      payerEmail,
      paymentStatus: status || "",
    });
  }

  function grantPremiumByEmail(email, grantOptions = {}) {
    const cleanEmail = normalizeEmail(email);
    if (!cleanEmail) throw new Error("paypal_support: email is required for grant");
    const user = store.getUserByEmail(cleanEmail);
    if (!user) throw new Error("paypal_support: user not found");
    const expiresAt = grantOptions.expiresAt
      ? String(grantOptions.expiresAt)
      : new Date(Date.now() + premiumDurationDays * 24 * 60 * 60 * 1000).toISOString();
    return store.grantPremiumByUserId(user.id, {
      provider: "paypal",
      paymentUrl,
      amountEur,
      currency,
      providerEmail: cleanEmail,
      providerPaymentId: String(grantOptions.providerPaymentId || ""),
      providerPayerId: String(grantOptions.providerPayerId || ""),
      expiresAt,
      force: !!grantOptions.force,
    });
  }

  function revokePremiumByEmail(email) {
    const cleanEmail = normalizeEmail(email);
    if (!cleanEmail) throw new Error("paypal_support: email is required for revoke");
    const user = store.getUserByEmail(cleanEmail);
    if (!user) throw new Error("paypal_support: user not found");
    return store.revokePremiumByUserId(user.id);
  }

  async function handleAdminGrant(req, res) {
    let body = {};
    try {
      body = await readJsonBody(req);
    } catch {
      writeJson(res, 400, { ok: false, error: "invalid_body" });
      return;
    }

    const email = normalizeEmail(body.email);
    if (!email) {
      writeJson(res, 400, { ok: false, error: "email_required" });
      return;
    }

    try {
      const viewer = grantPremiumByEmail(email, {
        providerPaymentId: String(body.providerPaymentId || ""),
        providerPayerId: String(body.providerPayerId || ""),
        expiresAt: body.expiresAt ? String(body.expiresAt) : undefined,
        force: Object.prototype.hasOwnProperty.call(body, "force") ? !!body.force : true,
      });
      writeJson(res, 200, { ok: true, viewer });
    } catch (err) {
      writeJson(res, 404, {
        ok: false,
        error: "grant_failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function handleAdminRevoke(req, res) {
    let body = {};
    try {
      body = await readJsonBody(req);
    } catch {
      writeJson(res, 400, { ok: false, error: "invalid_body" });
      return;
    }

    const email = normalizeEmail(body.email);
    if (!email) {
      writeJson(res, 400, { ok: false, error: "email_required" });
      return;
    }

    try {
      const viewer = revokePremiumByEmail(email);
      writeJson(res, 200, { ok: true, viewer });
    } catch (err) {
      writeJson(res, 404, {
        ok: false,
        error: "revoke_failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    getConfig,
    getStartOptions,
    handlePaypalReturn,
    handlePaypalWebhook,
    handleAdminGrant,
    handleAdminRevoke,
    grantPremiumByEmail,
    revokePremiumByEmail,
  };
}
