'use strict';
// FAUX serveur Campay (démonstration locale et tests) : aucune connexion à Campay, aucun argent, aucune vraie clé.
// Il imite les points d'accès documentés : POST /api/token/, POST /api/collect/, GET /api/transaction/{reference}/, et envoie des webhooks signés (JWT HS256).
// Numéros de test de la documentation Campay : 237677777777 (MTN, réussit) · 237677777770 (MTN, échoue) · 237699999999 (Orange, réussit) · 237699999990 (Orange, échoue).
// Tout autre numéro « 2376XXXXXXXX » reste EN ATTENTE sans jamais répondre (cas « expiré »).
// Usage autonome : node scripts/mock-campay.js   (MOCK_CAMPAY_PORT=4010, MOCK_WEBHOOK_URL=http://127.0.0.1:3000/api/payments/webhook/campay, MOCK_CONFIRM_MS=8000)
// Pilotage manuel : POST /__mock/resolve {reference, status:"SUCCESSFUL"|"FAILED"}, POST /__mock/webhook {reference, forged?, amount?}, GET /__mock/state
const http = require('http');
const crypto = require('crypto');
// JWT HS256 fabriqué ici (le faux serveur ne dépend d'aucun code de Brij-IA : il se comporte comme Campay, indépendamment).
const b64u = (v) => Buffer.from(v).toString('base64url');
const signJwtHS256 = (payload, key) => { const h = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' })); const p = b64u(JSON.stringify(payload)); return `${h}.${p}.${crypto.createHmac('sha256', key).update(`${h}.${p}`).digest('base64url')}`; };

const FAKE = { username: 'mock-app-user', password: 'mock-app-pass', permanentToken: 'mock-permanent-token', webhookKey: 'mock-webhook-key' }; // valeurs FACTICES, propres au faux serveur
const RESULT_OF = { '237677777777': 'SUCCESSFUL', '237677777770': 'FAILED', '237699999999': 'SUCCESSFUL', '237699999990': 'FAILED' };

function start(opts = {}) {
  const o = { port: 0, webhookUrl: '', webhookMethod: 'POST', confirmMs: 1500, ...FAKE, ...opts };
  const state = { txs: new Map(), byExt: new Map(), tokens: new Set(), calls: [], webhooks: [], tokenCount: 0, amountOverride: null, extOverride: null, down: false };
  const timers = new Set();

  const send = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const readBody = (req) => new Promise((ok) => { let b = ''; req.on('data', (d) => { b += d; if (b.length > 1e5) req.destroy(); }); req.on('end', () => { try { ok(JSON.parse(b || '{}')); } catch { ok({}); } }); });
  const authed = (req) => { const m = /^Token (.+)$/.exec(req.headers.authorization || ''); return m && (m[1] === o.permanentToken || state.tokens.has(m[1])); };

  const view = (t) => ({ reference: t.reference, status: t.status, amount: String(state.amountOverride != null ? state.amountOverride : t.amount) + '.00', currency: t.currency, operator: t.operator, code: t.code, operator_reference: t.operator_reference,
    endpoint: 'collect', signature: signJwtHS256({ source: 'CamPay', reference: t.reference }, o.webhookKey), external_reference: state.extOverride != null ? state.extOverride : t.external_reference, external_user: t.external_user,
    extra_first_name: '', extra_last_name: '', extra_email: '', app_amount: String(t.amount) + '.00', phone_number: t.phone_number, redirect_url: '', failure_redirect_url: '', description: t.description, reason: t.status === 'FAILED' ? 'FAILED_BY_USER' : t.status === 'SUCCESSFUL' ? 'TESTING' : '' });

  async function sendWebhook(t, { forged = false, amount } = {}) {
    if (!o.webhookUrl) return null;
    const v = view(t); if (amount != null) v.amount = String(amount);
    v.signature = forged ? signJwtHS256({ source: 'CamPay' }, 'cle-fausse') : signJwtHS256({ source: 'CamPay', reference: t.reference, iat: Math.floor(Date.now() / 1000), nonce: crypto.randomBytes(6).toString('hex') }, o.webhookKey);
    const body = { status: t.status, reference: t.reference, amount: v.amount, currency: t.currency, operator: t.operator.toUpperCase(), code: t.code, operator_reference: t.operator_reference, signature: v.signature, endpoint: 'collect', external_reference: v.external_reference, external_user: t.external_user, phone_number: t.phone_number, description: t.description, reason: v.reason, app_amount: v.app_amount };
    let r;
    try {
      r = o.webhookMethod === 'GET'
        ? await fetch(o.webhookUrl + '?' + new URLSearchParams(body).toString())
        : await fetch(o.webhookUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    } catch (e) { state.webhooks.push({ reference: t.reference, error: e.message }); return null; }
    state.webhooks.push({ reference: t.reference, status: r.status, forged });
    return r.status;
  }
  function settle(t, status, { webhook = true } = {}) {
    if (t.status !== 'PENDING') return;
    t.status = status; t.code = 'CP' + crypto.randomBytes(5).toString('hex').toUpperCase(); t.operator_reference = status === 'SUCCESSFUL' ? 'MP' + crypto.randomInt(1e8, 1e9) : '';
    if (webhook) sendWebhook(t);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const path = url.pathname;
    state.calls.push(`${req.method} ${path}`);
    // ---- pilotage du faux serveur (tests et démonstration manuelle) ----
    if (path === '/__mock/state') return send(res, 200, { calls: state.calls, webhooks: state.webhooks, txs: [...state.txs.values()] });
    if (path === '/__mock/set' && req.method === 'POST') { const b = await readBody(req); for (const k of ['amountOverride', 'extOverride', 'down']) if (k in b) state[k] = b[k]; return send(res, 200, { ok: true }); }
    if (path === '/__mock/resolve' && req.method === 'POST') {
      const b = await readBody(req); const t = state.txs.get(b.reference);
      if (!t) return send(res, 404, { error: 'inconnue' });
      settle(t, b.status === 'FAILED' ? 'FAILED' : 'SUCCESSFUL', { webhook: b.webhook !== false });
      return send(res, 200, { ok: true, status: t.status });
    }
    if (path === '/__mock/webhook' && req.method === 'POST') {
      const b = await readBody(req); const t = state.txs.get(b.reference);
      if (!t) return send(res, 404, { error: 'inconnue' });
      return send(res, 200, { status: await sendWebhook(t, b) });
    }
    if (state.down) return send(res, 503, { message: 'Service indisponible (simulation)' });
    // ---- API Campay ----
    if (path === '/api/token/' && req.method === 'POST') {
      const b = await readBody(req);
      if (b.username !== o.username || b.password !== o.password) return send(res, 401, { detail: 'Identifiants invalides' });
      const token = 'mock-tmp-' + crypto.randomBytes(16).toString('hex'); state.tokens.add(token); state.tokenCount++;
      return send(res, 200, { token, expires_in: 3600 });
    }
    if (!authed(req)) return send(res, 401, { detail: 'Jeton absent ou invalide' });
    if (path === '/api/collect/' && req.method === 'POST') {
      const b = await readBody(req);
      if (b.external_reference && state.byExt.has(b.external_reference)) { const t = state.byExt.get(b.external_reference); return send(res, 200, { reference: t.reference, ussd_code: '*126#', operator: t.operator }); } // idempotence documentée
      if (!/^\d+$/.test(String(b.amount || '')) || Number(b.amount) < 1) return send(res, 400, { message: 'Invalid amount', error_code: 'ER201' });
      if (!/^237\d{9}$/.test(String(b.from || ''))) return send(res, 400, { message: 'Invalid phone number', error_code: 'ER101' });
      if (!/^2376\d{8}$/.test(b.from)) return send(res, 400, { message: 'Unsupported carrier', error_code: 'ER102' });
      if (b.external_reference && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(b.external_reference)) return send(res, 400, { message: 'external_reference must be a valid UUID4' });
      const operator = /^2376(5[5-9]|9)/.test(b.from) ? 'orange' : 'mtn';
      const t = { reference: crypto.randomUUID(), status: 'PENDING', amount: Number(b.amount), currency: b.currency || 'XAF', operator, code: '', operator_reference: '', external_reference: b.external_reference || '', external_user: b.external_user || '', phone_number: b.from, description: b.description || '' };
      state.txs.set(t.reference, t); if (t.external_reference) state.byExt.set(t.external_reference, t);
      const result = RESULT_OF[b.from];
      if (result) { const tm = setTimeout(() => { timers.delete(tm); settle(t, result); }, o.confirmMs); timers.add(tm); tm.unref(); }
      return send(res, 200, { reference: t.reference, ussd_code: operator === 'mtn' ? '*126#' : '#150*50#', operator });
    }
    const m = /^\/api\/transaction\/([^/]+)\/$/.exec(path);
    if (m && req.method === 'GET') { const t = state.txs.get(decodeURIComponent(m[1])); return t ? send(res, 200, view(t)) : send(res, 404, { message: 'Transaction not found' }); }
    return send(res, 404, { message: 'Not found' });
  });

  return new Promise((ok) => server.listen(o.port, '127.0.0.1', () => {
    const port = server.address().port;
    ok({ port, url: `http://127.0.0.1:${port}/api`, origin: `http://127.0.0.1:${port}`, state, creds: { username: o.username, password: o.password, token: o.permanentToken, webhookKey: o.webhookKey },
      setWebhookUrl: (u) => { o.webhookUrl = u; }, close: () => new Promise((done) => { for (const t of timers) clearTimeout(t); server.close(() => done()); server.closeAllConnections && server.closeAllConnections(); }) });
  }));
}

module.exports = { start, FAKE };

if (require.main === module) {
  const port = Number(process.env.MOCK_CAMPAY_PORT) || 4010;
  start({ port, webhookUrl: process.env.MOCK_WEBHOOK_URL || '', confirmMs: Number(process.env.MOCK_CONFIRM_MS) || 8000 }).then((m) => {
    console.log(`FAUX Campay prêt : ${m.url}`);
    console.log('Variables à donner au serveur Brij-IA :');
    console.log(`  CAMPAY_MODE=test CAMPAY_BASE_URL=${m.url} CAMPAY_APP_USERNAME=${m.creds.username} CAMPAY_APP_PASSWORD=${m.creds.password} CAMPAY_WEBHOOK_KEY=${m.creds.webhookKey}`);
    console.log('Numéros : 677777777 (MTN réussit) · 677777770 (MTN échoue) · 699999999 (Orange réussit) · 699999990 (Orange échoue) · autre 6XXXXXXXX = reste en attente');
  });
}
