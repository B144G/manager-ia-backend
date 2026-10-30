'use strict';
// Marketing · vague 3 : consentement, segmentation des clients, envoi groupé (e-mail ou WhatsApp) avec quotas, codes promo appliqués aux devis et factures.
// Règle d'or : AUCUN envoi groupé sans consentement enregistré du client, jamais à quelqu'un qui s'est désinscrit ou a écrit « STOP », avec quotas par jour.
const crypto = require('crypto');
const express = require('express');
const { db, nowISO } = require('../db');
const config = require('../config');
const A = require('./access');
const W = require('./w3');
const D = require('./invoice-doc');
const { sendMail, mailEnabled } = require('../services/notify');
const { HttpError, isEmail, oneLine, parseJSON, log, safeEqual } = require('../util');

const router = express.Router({ mergeParams: true });
const pub = express.Router();
const mgr = A.need('manager');
W.settingsRoutes(router, ['mkt_day_quota'], 'admin', 'manager');
const digits = (v) => String(v || '').replace(/\D/g, '');

// ---------- Consentement ----------
router.post('/consent', mgr, async (req, res) => {
  const b = req.body || {};
  const ids = Array.isArray(b.customerIds) ? [...new Set(b.customerIds.map(Number))].filter((n) => Number.isInteger(n) && n > 0).slice(0, 500) : [];
  if (!ids.length) throw new HttpError(400, 'Choisissez au moins un client.');
  const consent = b.consent ? 1 : 0;
  const source = A.text(b.source, 80) || (consent ? 'saisi par un membre de l\'équipe' : 'retrait');
  if (consent && !b.confirm) throw new HttpError(400, 'Confirmez que ces clients ont donné leur accord pour recevoir vos messages.');
  let n = 0;
  for (const id of ids) {
    const c = await db.prepare('SELECT * FROM customers WHERE id = ? AND org_id = ?').get(id, req.org.id);
    if (!c || !A.visible(req, c)) continue;
    await db.prepare('UPDATE customers SET marketing_consent = ?, consent_at = ?, consent_source = ? WHERE id = ?').run(consent, nowISO(), source, c.id);
    await W.audit(req, 'consent', c.id, consent ? 'grant' : 'withdraw', { consent: c.marketing_consent }, { consent, source });
    n++;
  }
  res.json({ updated: n });
});

// ---------- Segmentation ----------
async function segment(req, f) {
  const sc = A.scope(req, 'c.branch_id');
  const rows = await db.prepare(`SELECT c.*, COALESCE((SELECT SUM(d.total - d.credited) FROM documents d WHERE d.customer_id = c.id AND d.kind = 'invoice' AND d.status NOT IN ('draft','cancelled')), 0) AS invoiced,
      (SELECT MAX(d.issued) FROM documents d WHERE d.customer_id = c.id AND d.kind = 'invoice' AND d.status NOT IN ('draft','cancelled')) AS last_invoice FROM customers c WHERE c.org_id = ?${sc.sql} ORDER BY c.id`).all(req.org.id, ...sc.args);
  const cut = f.inactiveDays ? W.addDays(W.today(), -Number(f.inactiveDays)) : null;
  return rows.filter((c) => (!f.stage || c.stage === f.stage) && (!f.source || String(c.source).toLowerCase() === String(f.source).toLowerCase())
    && (!f.hasEmail || isEmail(c.email)) && (!f.hasPhone || digits(c.phone).length >= 8)
    && (!f.minInvoiced || Number(c.invoiced) >= Number(f.minInvoiced)) && (!cut || (c.last_invoice && c.last_invoice < cut)) && (!f.consentOnly || Number(c.marketing_consent) === 1));
}
const cleanFilter = (f) => {
  const o = f && typeof f === 'object' ? f : {};
  return { stage: ['prospect', 'client'].includes(o.stage) ? o.stage : '', source: A.text(o.source, 40), hasEmail: Boolean(o.hasEmail), hasPhone: Boolean(o.hasPhone), minInvoiced: Math.max(Number(o.minInvoiced) || 0, 0), inactiveDays: Math.min(Math.max(Math.round(Number(o.inactiveDays) || 0), 0), 3650), consentOnly: Boolean(o.consentOnly) };
};
const summary = (list) => ({ count: list.length, withConsent: list.filter((c) => Number(c.marketing_consent) === 1).length, withEmail: list.filter((c) => isEmail(c.email)).length, withPhone: list.filter((c) => digits(c.phone).length >= 8).length, sample: list.slice(0, 5).map((c) => c.name) });
router.post('/segments/preview', mgr, async (req, res) => res.json(summary(await segment(req, cleanFilter((req.body || {}).filter)))));
router.get('/segments', mgr, async (req, res) => {
  const rows = await db.prepare('SELECT * FROM marketing_segments WHERE org_id = ? ORDER BY id DESC').all(req.org.id);
  const out = [];
  for (const r of rows) out.push({ id: r.id, name: r.name, filter: parseJSON(r.filter, {}), ...summary(await segment(req, parseJSON(r.filter, {}))) });
  res.json({ items: out });
});
router.post('/segments', mgr, async (req, res) => {
  const b = req.body || {};
  const id = Number((await db.prepare('INSERT INTO marketing_segments (org_id, name, filter, created_by, created_at) VALUES (?, ?, ?, ?, ?)').run(req.org.id, A.text(b.name, 80, { required: true, msg: 'Donnez un nom au segment.' }), JSON.stringify(cleanFilter(b.filter)), req.user.id, nowISO())).lastInsertRowid);
  res.status(201).json({ id });
});
router.delete('/segments/:id', mgr, async (req, res) => {
  const r = await db.prepare('DELETE FROM marketing_segments WHERE id = ? AND org_id = ?').run(A.id(req.params.id), req.org.id);
  if (!r.changes) throw new HttpError(404, 'Segment introuvable.');
  res.json({ ok: true });
});

// ---------- Désinscription (lien dans chaque e-mail groupé) ----------
const sign = (orgId, custId) => crypto.createHmac('sha256', config.jwtSecret).update(`unsub:${orgId}:${custId}`).digest('hex').slice(0, 24);
const unsubToken = (orgId, custId) => `${orgId}.${custId}.${sign(orgId, custId)}`;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
pub.get('/unsubscribe/:token', async (req, res) => {
  const [o, c, sig] = String(req.params.token).split('.');
  const ok = /^\d+$/.test(o || '') && /^\d+$/.test(c || '') && sig && safeEqual(sig, sign(o, c));
  const cu = ok ? await db.prepare('SELECT c.id, o.name AS org FROM customers c JOIN orgs o ON o.id = c.org_id WHERE c.id = ? AND c.org_id = ?').get(Number(c), Number(o)) : null;
  res.set({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" });
  if (!cu) return res.status(404).send('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><p style="font-family:sans-serif;padding:24px">Lien invalide.</p>');
  await db.prepare('UPDATE customers SET marketing_consent = 0, consent_at = ?, consent_source = ? WHERE id = ?').run(nowISO(), 'désinscription par lien', cu.id);
  await A.logActivity(Number(o), null, 'marketing', 'Un client s\'est désinscrit des messages groupés');
  res.send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Désinscription</title><body style="font-family:sans-serif;padding:24px;max-width:520px;margin:auto"><h1 style="font-size:20px">C'est fait</h1><p>Vous ne recevrez plus de messages promotionnels de ${esc(cu.org)}.</p></body>`);
});

// ---------- Envoi groupé ----------
const dayCount = async (orgId) => Number((await db.prepare("SELECT COUNT(*) c FROM broadcast_sends WHERE org_id = ? AND status = 'sent' AND created_at >= ?").get(orgId, `${W.today()}T00:00:00.000Z`)).c);
router.post('/broadcasts', mgr, async (req, res) => {
  const b = req.body || {};
  const name = A.text(b.name, 100, { required: true, msg: 'Donnez un nom à cet envoi.' });
  const channel = A.oneOf(b.channel, ['email', 'whatsapp'], undefined, 'Choisissez e-mail ou WhatsApp.');
  const body = A.text(b.body, 3000, { required: true, msg: 'Écrivez le message.' });
  const subject = channel === 'email' ? A.text(b.subject, 150, { required: true, msg: "Indiquez l'objet de l'e-mail." }) : '';
  let filter = cleanFilter(b.filter);
  if (b.segmentId) { const sg = await db.prepare('SELECT filter FROM marketing_segments WHERE id = ? AND org_id = ?').get(A.id(b.segmentId), req.org.id); if (!sg) throw new HttpError(404, 'Segment introuvable.'); filter = cleanFilter(parseJSON(sg.filter, {})); }
  let tpl = null;
  if (channel === 'whatsapp') {
    tpl = await db.prepare("SELECT * FROM wa_templates WHERE id = ? AND org_id = ? AND purpose = 'general'").get(A.id(b.templateId, 'Choisissez un modèle WhatsApp (usage « autre message »).'), req.org.id);
    if (!tpl) throw new HttpError(404, 'Modèle WhatsApp introuvable (créez-en un approuvé par Meta, usage « autre message »).');
  }
  const all = await segment(req, filter);
  const consenting = all.filter((c) => Number(c.marketing_consent) === 1);
  const reachable = consenting.filter((c) => (channel === 'email' ? isEmail(c.email) : digits(c.phone).length >= 8));
  const st = await W.settings(req.org.id);
  const planLeft = channel === 'email' ? Math.max(A.limitsFor(await A.ownerPlan(req.org)).emailDay - Number((await db.prepare("SELECT COUNT(*) c FROM outbox WHERE org_id = ? AND status = 'sent' AND created_at >= ?").get(req.org.id, `${W.today()}T00:00:00.000Z`)).c), 0) : 200;
  const quota = Math.max(Math.min(st.mkt_day_quota - await dayCount(req.org.id), planLeft, 200), 0);
  const plan = { segment: all.length, noConsent: all.length - consenting.length, noAddress: consenting.length - reachable.length, recipients: Math.min(reachable.length, quota), overQuota: Math.max(reachable.length - quota, 0), quotaLeft: quota };
  if (b.preview) return res.json({ preview: true, ...plan });
  if (!plan.recipients) throw new HttpError(400, all.length && !consenting.length ? "Aucun client de ce segment n'a donné son consentement : l'envoi est impossible." : `Aucun destinataire possible (quota restant aujourd'hui : ${quota}).`);
  const waOrg = require('../services/waOrg'); const out = require('./wa-out');
  if (channel === 'email' && !mailEnabled()) throw new HttpError(503, "L'envoi d'e-mails n'est pas encore activé sur ce serveur.");
  if (channel === 'whatsapp' && (!waOrg.isConnected(req.org) || waOrg.modeOf(req.org) === 'qr')) throw new HttpError(409, "L'envoi groupé WhatsApp demande la connexion officielle (Meta) et un modèle approuvé : la connexion par QR code n'est pas utilisée pour des envois groupés.");
  const bid = Number((await db.prepare('INSERT INTO broadcasts (org_id, name, channel, subject, body, filter, template_id, total, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(req.org.id, name, channel, subject, body, JSON.stringify(filter), tpl ? tpl.id : null, plan.recipients, req.user.id, nowISO())).lastInsertRowid);
  let sent = 0; let failed = 0; let skipped = 0;
  const rec = (cid, status, reason) => db.prepare('INSERT INTO broadcast_sends (broadcast_id, org_id, customer_id, status, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(bid, req.org.id, cid, status, reason || '', nowISO());
  for (const c of reachable.slice(0, plan.recipients)) {
    try {
      if (channel === 'email') {
        const link = `${config.apiPublicUrl || ''}/api/ws/public/unsubscribe/${unsubToken(req.org.id, c.id)}`;
        await sendMail({ to: c.email, subject, text: `${body.replace(/\{nom\}/g, c.name.split(/\s+/)[0])}\n\n—\n${req.org.name}\nPour ne plus recevoir nos messages : ${link}`, fromName: req.org.name });
        await db.prepare('INSERT INTO outbox (org_id, user_id, customer_id, to_email, subject, body, attachments, status, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(req.org.id, req.user.id, c.id, c.email, subject, body, '[]', 'sent', '', nowISO());
        sent++; await rec(c.id, 'sent');
      } else {
        if (await out.isOptedOut(req.org.id, c.phone)) { skipped++; await rec(c.id, 'skipped', 'a demandé à ne plus être contacté'); continue; }
        const r = await out.sendTemplate(req.org, { phone: c.phone, tpl, params: [out.firstName(c.name), req.org.name, oneLine(body, 280)].slice(0, Number(tpl.params) || 3), refKind: 'broadcast', refId: bid });
        if (r.ok) { sent++; await rec(c.id, 'sent'); } else { failed++; await rec(c.id, 'failed', r.error); if (/Plafond|connecté/.test(r.error)) break; }
      }
    } catch (e) { failed++; await rec(c.id, 'failed', oneLine(e.message, 120)); log.warn('Envoi groupé :', oneLine(e.message, 120)); }
  }
  await db.prepare('UPDATE broadcasts SET sent = ?, failed = ?, skipped = ? WHERE id = ?').run(sent, failed, skipped + plan.noConsent + plan.noAddress + plan.overQuota, bid);
  await A.logActivity(req.org.id, req.user.id, 'marketing', `Envoi groupé « ${name} » : ${sent} message(s)`);
  await W.audit(req, 'broadcast', bid, 'send', null, { channel, sent, failed, plan });
  res.status(201).json({ id: bid, sent, failed, skipped, ...plan });
});
router.get('/broadcasts', mgr, async (req, res) => {
  const rows = await db.prepare('SELECT * FROM broadcasts WHERE org_id = ? ORDER BY id DESC LIMIT 50').all(req.org.id);
  res.json({ items: rows.map((r) => ({ id: r.id, name: r.name, channel: r.channel, subject: r.subject, total: Number(r.total), sent: Number(r.sent), failed: Number(r.failed), skipped: Number(r.skipped), at: r.created_at })), quotaToday: await dayCount(req.org.id) });
});
router.get('/broadcasts/:id', mgr, async (req, res) => {
  const b = await db.prepare('SELECT * FROM broadcasts WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!b) throw new HttpError(404, 'Envoi introuvable.');
  const sends = await db.prepare('SELECT s.status, s.reason, c.name FROM broadcast_sends s JOIN customers c ON c.id = s.customer_id WHERE s.broadcast_id = ? ORDER BY s.id LIMIT 500').all(b.id);
  res.json({ broadcast: { id: b.id, name: b.name, channel: b.channel, body: b.body, sent: Number(b.sent), failed: Number(b.failed) }, sends });
});

// ---------- Codes promo ----------
W.crud(router, { path: '/promo', table: 'promo_codes', entity: 'promo', read: 'manager', write: 'manager', order: 'active DESC, id DESC',
  fields: [{ k: 'code', t: 'text', max: 30, req: true, msg: 'Indiquez le code.' }, { k: 'kind', t: 'enum', opts: ['percent', 'amount'], def: 'percent' }, { k: 'value', t: 'int', min: 1, max: 1e9, req: true, msg: 'Indiquez la valeur de la remise.' },
    { k: 'starts', t: 'date' }, { k: 'ends', t: 'date' }, { k: 'maxUses', t: 'int', min: 0, max: 1e6 }, { k: 'active', t: 'bool', def: 1 }],
  validate: async (req, v, cur) => {
    if (v.code !== undefined) {
      if (!/^[A-Za-z0-9_-]{3,30}$/.test(v.code)) throw new HttpError(400, 'Code : 3 à 30 lettres, chiffres, « - » ou « _ ».');
      v.code = v.code.toUpperCase();
      const dup = await db.prepare('SELECT id FROM promo_codes WHERE org_id = ? AND code = ?').get(req.org.id, v.code);
      if (dup && (!cur || dup.id !== cur.id)) throw new HttpError(409, 'Ce code existe déjà.');
    }
    const kind = v.kind !== undefined ? v.kind : cur ? cur.kind : 'percent'; const value = v.value !== undefined ? v.value : cur ? Number(cur.value) : 0;
    if (kind === 'percent' && (value < 1 || value > 100)) throw new HttpError(400, 'Une remise en pourcentage va de 1 à 100.');
    const s = v.starts !== undefined ? v.starts : cur && cur.starts; const e = v.ends !== undefined ? v.ends : cur && cur.ends;
    if (s && e && e < s) throw new HttpError(400, 'La fin de validité est avant son début.');
  },
  decorate: async (req, rows) => rows.map((r) => ({ ...r, _view: { ...W.camelRow(r), active: Boolean(Number(r.active)), expired: Boolean(r.ends && r.ends < W.today()) } })) });

const subtotal = (lines) => lines.filter((l) => l.price > 0).reduce((a, l) => a + Math.round(l.quantity * l.price), 0);
router.post('/promo/apply', mgr, async (req, res) => {
  const b = req.body || {};
  const d = await db.prepare('SELECT * FROM documents WHERE id = ? AND org_id = ?').get(A.id(b.documentId, 'Choisissez le devis ou la facture.'), req.org.id);
  if (!d || !A.visible(req, d)) throw new HttpError(404, 'Document introuvable.');
  if (!['quote', 'invoice'].includes(d.kind) || d.status !== 'draft') throw new HttpError(400, 'Un code promo s\'applique à un devis ou une facture en brouillon.');
  if (d.promo_code) throw new HttpError(409, `Le code ${d.promo_code} est déjà appliqué : retirez-le d'abord.`);
  const code = String(b.code || '').trim().toUpperCase();
  const p = await db.prepare('SELECT * FROM promo_codes WHERE org_id = ? AND code = ?').get(req.org.id, code);
  if (!p || !Number(p.active)) throw new HttpError(404, 'Code promo inconnu ou désactivé.');
  if ((p.starts && p.starts > W.today()) || (p.ends && p.ends < W.today())) throw new HttpError(400, "Ce code n'est pas valable à cette date.");
  if (Number(p.max_uses) > 0 && Number(p.used) >= Number(p.max_uses)) throw new HttpError(400, "Ce code a atteint son nombre maximal d'utilisations.");
  const lines = JSON.parse(d.lines);
  const base = subtotal(lines);
  const discount = Math.min(p.kind === 'percent' ? Math.round((base * Number(p.value)) / 100) : Number(p.value), base);
  if (discount <= 0) throw new HttpError(400, 'La remise est nulle pour ce document.');
  const next = [...lines, { label: `Remise (${code})`, quantity: 1, price: -discount }];
  const rate = d.vat_rate === null ? Number(req.org.vat_rate) : Number(d.vat_rate); const t = D.totals(next, rate, Number(d.prices_incl) === 1);
  await db.transaction(async () => {
    await db.prepare('UPDATE documents SET lines = ?, total = ?, subtotal_ht = ?, vat_amount = ?, promo_code = ?, discount = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(next), t.total, t.ht, t.vat, code, discount, nowISO(), d.id);
    await db.prepare('UPDATE promo_codes SET used = used + 1 WHERE id = ?').run(p.id);
  })();
  await W.audit(req, 'promo', p.id, 'apply', null, { document: d.number, discount });
  res.json({ ok: true, discount, total: t.total });
});
router.delete('/promo/apply/:docId', mgr, async (req, res) => {
  const d = await db.prepare('SELECT * FROM documents WHERE id = ? AND org_id = ?').get(A.id(req.params.docId), req.org.id);
  if (!d || !d.promo_code) throw new HttpError(404, 'Aucun code promo sur ce document.');
  if (d.status !== 'draft') throw new HttpError(400, 'Seul un brouillon peut être modifié.');
  const lines = JSON.parse(d.lines).filter((l) => !(l.price < 0 && /^Remise/.test(l.label)));
  const rate = d.vat_rate === null ? Number(req.org.vat_rate) : Number(d.vat_rate); const t = D.totals(lines, rate, Number(d.prices_incl) === 1);
  await db.transaction(async () => {
    await db.prepare("UPDATE documents SET lines = ?, total = ?, subtotal_ht = ?, vat_amount = ?, promo_code = '', discount = 0, updated_at = ? WHERE id = ?").run(JSON.stringify(lines), t.total, t.ht, t.vat, nowISO(), d.id);
    await db.prepare('UPDATE promo_codes SET used = GREATEST(used - 1, 0) WHERE org_id = ? AND code = ?').run(req.org.id, d.promo_code);
  })();
  res.json({ ok: true, total: t.total });
});

module.exports = router;
module.exports.pub = pub;
module.exports.segment = segment;
