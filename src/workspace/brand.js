'use strict';
// Personnalisation de la marque d'une entreprise : nom affiché, nom de l'assistant IA, logo, favicon, couleur, thème, pied de page, mode « marque blanche »,
// expéditeur des e-mails, en-tête et pied des PDF, ordre et visibilité du menu, widgets du tableau de bord, vocabulaire. Valeur par défaut = comportement historique.
// Monté sur /orgs/:orgId/brand : lecture pour tout membre, modification réservée aux administrateurs et au propriétaire.
// `pub` : images (jeton secret par entreprise) et marque affichée sur les pages publiques de l'entreprise (formulaire, discussion, suivi, devis, localisation, avis).
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const B = require('../services/brand-lib');
const PRODUCT = require('../services/product');
const IMG = require('../services/image-check');
const limits = require('../middleware/limits');
const { modules } = require('./modules');
const { HttpError } = require('../util');

const router = express.Router({ mergeParams: true });
const pub = express.Router();
const moduleIds = modules.map((m) => m.id);

const audit = (req, action, detail, severity = 'info') => {
  try { require('../security').audit.record(req, action, { orgId: req.org.id, userId: req.user.id, target: 'brand', detail, severity }); } catch { /* journal indisponible */ }
};
const logBrand = async (req, action, detail) => {
  await db.prepare('INSERT INTO org_brand_log (org_id, user_id, action, detail, created_at) VALUES (?, ?, ?, ?, ?)').run(req.org.id, req.user.id, action, String(detail || '').slice(0, 300), nowISO());
  await A.logActivity(req.org.id, req.user.id, 'team', `Marque de l'entreprise : ${action}${detail ? ' (' + String(detail).slice(0, 80) + ')' : ''}`);
  audit(req, 'brand.' + action, detail);
};

/** Détection d'usurpation : le nom affiché ne doit pas être celui d'une autre entreprise de la plateforme (ni celui de la plateforme elle-même). */
async function assertNotImpersonation(req, cfg) {
  for (const [label, val] of [['nom affiché', cfg.productName], ['expéditeur des e-mails', cfg.mailFromName]]) {
    if (!val) continue;
    const n = B.norm(val);
    if (n.length < 3) continue;
    if (PRODUCT.reservedTokens.some((tk) => n.includes(tk)) && label === 'nom affiché') throw new HttpError(409, 'Ce nom est réservé à la plateforme. Choisissez le nom de votre entreprise ou celui que vous voulez, sans reprendre celui de la plateforme.');
    const first = String(val).split(/\s+/)[0].toLowerCase().replace(/[%_]/g, '');
    const others = await db.prepare('SELECT id, name, owner_id FROM orgs WHERE id <> ? AND LOWER(name) LIKE ? LIMIT 200').all(req.org.id, `%${first}%`);
    const hit = others.find((o) => B.norm(o.name) === n && Number(o.owner_id) !== Number(req.org.owner_id));
    const other = hit || (await db.prepare('SELECT b.org_id, o.owner_id FROM org_brand b JOIN orgs o ON o.id = b.org_id WHERE b.name_norm = ? AND b.org_id <> ? LIMIT 1').get(n, req.org.id));
    if (other && Number(other.owner_id) !== Number(req.org.owner_id)) {
      await logBrand(req, 'refused', `${label} refusé : nom déjà porté par une autre entreprise`);
      audit(req, 'brand.impersonation_blocked', `${label} : ${String(val).slice(0, 60)}`, 'warn');
      throw new HttpError(409, 'Ce nom est déjà utilisé par une autre entreprise de la plateforme. Choisissez un nom qui vous est propre.');
    }
  }
}

const view = async (req) => {
  const row = await B.rowOf(req.org.id);
  const eff = B.effectiveFrom(req.org, row);
  const editable = A.can(req, 'admin');
  return {
    brand: eff, editable,
    config: editable ? { mode: eff.mode, productName: eff.productName, assistantName: eff.assistantName, color: eff.color, theme: eff.theme, footerText: eff.footerText, mailFromName: eff.mailFromName, mailReplyTo: eff.mailReplyTo, pdfHeader: eff.pdfHeader, pdfFooter: eff.pdfFooter, menu: eff.menu, dashboard: eff.dashboard, vocab: eff.vocab } : undefined,
    options: { modes: B.MODES, themes: B.THEMES, langs: B.LANGS, widgets: B.DASH_WIDGETS, vocabKeys: B.VOCAB_KEYS, neverHide: B.NEVER_HIDE, limits: B.LIMITS, platformName: B.PLATFORM, defaultColor: B.DEFAULT_COLOR },
  };
};

router.get('/', async (req, res) => res.json(await view(req)));

router.get('/log', A.need('admin'), async (req, res) => {
  const rows = await db.prepare('SELECT l.id, l.action, l.detail, l.created_at, u.name AS who FROM org_brand_log l LEFT JOIN users u ON u.id = l.user_id WHERE l.org_id = ? ORDER BY l.id DESC LIMIT 50').all(req.org.id);
  res.json({ log: rows.map((r) => ({ id: Number(r.id), action: r.action, detail: r.detail, at: r.created_at, who: r.who || '' })) });
});

async function save(req, cfg, action, detail) {
  await assertNotImpersonation(req, cfg);
  await B.ensureRow(req.org.id, req.user.id);
  await db.prepare('UPDATE org_brand SET config = ?, name_norm = ?, version = version + 1, updated_by = ?, updated_at = ? WHERE org_id = ?').run(JSON.stringify(cfg), B.norm(cfg.productName), req.user.id, nowISO(), req.org.id);
  B.invalidate(req.org.id);
  await logBrand(req, action, detail);
}

router.put('/', A.need('admin'), async (req, res) => {
  const cfg = B.sanitize(req.body, { moduleIds });
  await save(req, cfg, 'update', [cfg.productName && 'nom', cfg.assistantName && 'assistant', cfg.color && 'couleur', cfg.mode !== 'brij' && cfg.mode].filter(Boolean).join(', '));
  res.json({ ok: true, ...(await view(req)) });
});

router.post('/image', A.need('admin'), async (req, res) => {
  const b = req.body || {};
  const kind = b.kind === 'favicon' ? 'favicon' : b.kind === 'logo' ? 'logo' : null;
  if (!kind) throw new HttpError(400, 'Type d\'image inconnu (logo ou favicon).');
  const img = IMG.check(b.data, kind, { maxBytes: B.LIMITS[kind], maxSide: kind === 'favicon' ? 512 : 2048 });
  await B.ensureRow(req.org.id, req.user.id);
  await db.prepare(`UPDATE org_brand SET ${kind}_mime = ?, ${kind}_data = ?, ${kind}_hash = ?, version = version + 1, updated_by = ?, updated_at = ? WHERE org_id = ?`).run(img.mime, img.buf, img.hash, req.user.id, nowISO(), req.org.id);
  B.invalidate(req.org.id);
  await logBrand(req, kind + '_set', `${img.mime}, ${img.w}x${img.h}, ${Math.round(img.buf.length / 1024)} Ko`);
  res.json({ ok: true, ...(await view(req)) });
});

router.delete('/image/:kind', A.need('admin'), async (req, res) => {
  const kind = req.params.kind === 'favicon' ? 'favicon' : req.params.kind === 'logo' ? 'logo' : null;
  if (!kind) throw new HttpError(404, 'Image inconnue.');
  await B.ensureRow(req.org.id, req.user.id);
  await db.prepare(`UPDATE org_brand SET ${kind}_mime = NULL, ${kind}_data = NULL, ${kind}_hash = NULL, version = version + 1, updated_by = ?, updated_at = ? WHERE org_id = ?`).run(req.user.id, nowISO(), req.org.id);
  B.invalidate(req.org.id);
  await logBrand(req, kind + '_removed', '');
  res.json({ ok: true, ...(await view(req)) });
});

/** Retour à la configuration de base : tout est effacé, l'entreprise retrouve exactement l'affichage d'origine. */
router.post('/reset', A.need('admin'), async (req, res) => {
  if ((req.body || {}).confirm !== true) throw new HttpError(400, 'Confirmez le retour à la configuration de base.');
  await db.prepare("UPDATE org_brand SET config = '{}', name_norm = '', logo_mime = NULL, logo_data = NULL, logo_hash = NULL, favicon_mime = NULL, favicon_data = NULL, favicon_hash = NULL, version = 0, updated_by = ?, updated_at = ? WHERE org_id = ?").run(req.user.id, nowISO(), req.org.id);
  B.invalidate(req.org.id);
  await logBrand(req, 'reset', 'retour à la configuration de base');
  res.json({ ok: true, ...(await view(req)) });
});

router.get('/export', A.need('admin'), async (req, res) => {
  const row = await db.prepare('SELECT config, logo_mime, logo_data, favicon_mime, favicon_data FROM org_brand WHERE org_id = ?').get(req.org.id);
  const cfg = B.sanitize(row ? JSON.parse(row.config || '{}') : {}, { moduleIds });
  const out = { format: 'brij-ia-marque', version: 1, exportedAt: nowISO(), config: cfg };
  if (row && row.logo_mime) out.logo = { mime: row.logo_mime, data: Buffer.from(row.logo_data).toString('base64') };
  if (row && row.favicon_mime) out.favicon = { mime: row.favicon_mime, data: Buffer.from(row.favicon_data).toString('base64') };
  audit(req, 'brand.export', '');
  res.set('Content-Disposition', 'attachment; filename="configuration-entreprise.json"').json(out);
});

router.post('/import', A.need('admin'), async (req, res) => {
  const b = req.body || {};
  if (b.format !== 'brij-ia-marque' || b.version !== 1 || !b.config) throw new HttpError(400, "Ce fichier n'est pas une configuration d'entreprise exportée.");
  const cfg = B.sanitize(b.config, { moduleIds }); // tout est revalidé : un fichier modifié à la main ne peut rien introduire de dangereux
  const imgs = {};
  for (const kind of ['logo', 'favicon']) if (b[kind] && b[kind].data) imgs[kind] = IMG.check(b[kind].data, kind, { maxBytes: B.LIMITS[kind], maxSide: kind === 'favicon' ? 512 : 2048 });
  await save(req, cfg, 'import', 'configuration importée');
  for (const [kind, img] of Object.entries(imgs)) await db.prepare(`UPDATE org_brand SET ${kind}_mime = ?, ${kind}_data = ?, ${kind}_hash = ? WHERE org_id = ?`).run(img.mime, img.buf, img.hash, req.org.id);
  B.invalidate(req.org.id);
  res.json({ ok: true, ...(await view(req)) });
});

// ---------- Public : images et marque des pages ouvertes sans compte ----------
const imgLimit = limits.make(60 * 1000, 120, 'Trop de requêtes.');
pub.get('/brand/:token/:kind(logo|favicon)', imgLimit, async (req, res) => {
  const kind = req.params.kind === 'favicon' ? 'favicon' : req.params.kind === 'logo' ? 'logo' : null;
  const t = String(req.params.token || '');
  const row = kind && /^[a-f0-9]{36}$/.test(t) ? await db.prepare(`SELECT ${kind}_mime AS mime, ${kind}_data AS data, ${kind}_hash AS hash FROM org_brand WHERE token = ?`).get(t) : null;
  if (!row || !row.mime) return res.status(404).json({ error: 'Image introuvable.' });
  res.set({ 'Content-Type': row.mime, 'Content-Length': row.data.length, 'Cache-Control': 'public, max-age=3600', ETag: `"${row.hash}"`, 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Cross-Origin-Resource-Policy': 'cross-origin' });
  return res.end(row.data);
});

// Manifeste de l'application installable (PWA) de l'entreprise : nom, couleur et icône choisis par elle ; icônes d'origine en secours.
pub.get('/brand/:token/manifest.webmanifest', imgLimit, async (req, res) => {
  const t = String(req.params.token || '');
  const row = /^[a-f0-9]{36}$/.test(t) ? await db.prepare('SELECT b.org_id, b.logo_mime, b.logo_data, b.logo_hash FROM org_brand b WHERE b.token = ?').get(t) : null;
  const org = row ? await db.prepare('SELECT id, name FROM orgs WHERE id = ?').get(row.org_id) : null;
  if (!org) return res.status(404).json({ error: 'Application introuvable.' });
  const eff = B.effectiveFrom(org, await B.rowOf(org.id));
  const icons = [{ src: '/assets/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' }, { src: '/assets/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' }];
  if (row.logo_mime) { const info = IMG.sniff(Buffer.from(row.logo_data)); icons.unshift({ src: eff.logoUrl, sizes: info ? `${info.w}x${info.h}` : '512x512', type: row.logo_mime, purpose: 'any' }); }
  const short = eff.name.slice(0, 12);
  res.set({ 'Content-Type': 'application/manifest+json; charset=utf-8', 'Cache-Control': 'public, max-age=300', 'X-Content-Type-Options': 'nosniff' })
    .send(JSON.stringify({ name: eff.name, short_name: short, description: eff.name, lang: 'fr', start_url: '/app', scope: '/', display: 'standalone', orientation: 'any', background_color: '#0a101e', theme_color: eff.color || B.DEFAULT_COLOR, icons }));
});

// Résolution du jeton d'une page publique vers son entreprise (le même jeton secret que la page utilise déjà).
const RESOLVERS = {
  intake: async (t) => (await db.prepare('SELECT id, name FROM orgs WHERE intake_token = ?').get(t.slice(0, 80))),
  chat: async (t) => (await db.prepare('SELECT id, name FROM orgs WHERE intake_token = ?').get(t.slice(0, 80))),
  csat: async (t) => (/^[a-f0-9]{24}$/.test(t) ? await db.prepare('SELECT o.id, o.name FROM tickets k JOIN orgs o ON o.id = k.org_id WHERE k.csat_token = ?').get(t) : null),
  track: async (t) => (/^[A-Za-z0-9_-]{24}$/.test(t) ? await db.prepare('SELECT o.id, o.name FROM logistics_deliveries d JOIN orgs o ON o.id = d.org_id WHERE d.track_token = ?').get(t) : null),
  geo: async (t) => (/^[a-f0-9]{48}$/.test(t) ? await db.prepare('SELECT o.id, o.name FROM tg_requests r JOIN orgs o ON o.id = r.org_id WHERE r.token = ?').get(t) : null),
  quote: async (t) => (/^[a-f0-9]{48}$/.test(t) ? await db.prepare('SELECT o.id, o.name FROM cp_quote_meta m JOIN orgs o ON o.id = m.org_id WHERE m.accept_token = ?').get(t) : null),
};
pub.get('/brand-of/:kind/:token', limits.make(60 * 1000, 60, 'Trop de requêtes.'), async (req, res) => {
  const f = RESOLVERS[req.params.kind];
  const org = f ? await f(String(req.params.token || '')) : null;
  // Pas de marque trouvée : marque d'origine (jamais d'erreur visible pour le visiteur).
  const eff = org ? B.effectiveFrom(org, await B.rowOf(org.id)) : B.effectiveFrom(null, null);
  res.set('Cache-Control', 'no-store').json({ brand: { ...B.publicView(eff), orgName: org ? org.name : '' } });
});

module.exports = router;
module.exports.pub = pub;
module.exports.assertNotImpersonation = assertNotImpersonation;
