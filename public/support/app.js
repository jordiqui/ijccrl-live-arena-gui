// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Jorge Ruiz Centelles
(function(){
  const api = {
    me:'/api/support/me',
    register:'/api/support/register',
    verifyEmail:'/api/support/verify-email',
    loginPassword:'/api/support/login/password',
    loginRequestCode:'/api/support/login/request-code',
    loginVerifyCode:'/api/support/login/verify-code',
    logout:'/api/support/logout',
    paypalStart:'/api/support/paypal/start',
    resetRequest:'/api/support/password/reset/request',
    resetConfirm:'/api/support/password/reset/confirm',
    adminLogin:'/chat/admin/login',
    adminLogout:'/chat/admin/logout',
    adminStatus:'/chat/admin/status',
    adminUsers:'/api/support/admin/users',
    adminPayments:'/api/support/admin/payments',
    adminGrant:'/api/support/admin/grant',
    adminRevoke:'/api/support/admin/revoke'
  };

  function byId(id){ return document.getElementById(id); }
  function text(el, value){ if (el) el.textContent = value == null ? '' : String(value); }
  function html(el, value){ if (el) el.innerHTML = value == null ? '' : String(value); }
  function escapeHtml(value){ return String(value == null ? '' : value)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
  function fmtDate(value){ if (!value) return '—'; try{ const d = new Date(value); if (Number.isNaN(d.getTime())) return String(value); return d.toLocaleString(); }catch{return String(value);} }
  function fmtBool(v){ return v ? 'Yes' : 'No'; }
  function qs(name){ return new URLSearchParams(location.search).get(name) || ''; }
  function setStatus(el, msg, kind){
    if (!el) return;
    el.className = 'status' + (kind ? ' ' + kind : '');
    el.textContent = msg || '';
  }
  async function json(url, options={}){
    const cfg = Object.assign({ method:'GET', cache:'no-store', credentials:'same-origin', headers:{} }, options || {});
    if (cfg.body && typeof cfg.body === 'object' && !(cfg.body instanceof FormData)){
      cfg.headers = Object.assign({}, cfg.headers, {'Content-Type':'application/json'});
      cfg.body = JSON.stringify(cfg.body);
    }
    const res = await fetch(url, cfg);
    let data = {};
    try { data = await res.json(); } catch { data = {}; }
    if (!res.ok || (data && data.ok === false)) {
      throw new Error(String((data && (data.message || data.error)) || ('HTTP ' + res.status)));
    }
    return data;
  }
  function viewerBadge(viewer){
    if (!viewer) return '<span class="pill">Guest</span>';
    if (viewer.isPremium) return '<span class="pill ok">Premium</span>';
    if (viewer.isRegistered) return '<span class="pill warn">Registered</span>';
    return '<span class="pill">Guest</span>';
  }
  function pickIdentifier(identifier){ return String(identifier || '').trim(); }
  window.IJSupport = { api, byId, text, html, escapeHtml, fmtDate, fmtBool, qs, setStatus, json, viewerBadge, pickIdentifier };
})();
