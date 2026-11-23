'use strict';
// Administration de la plateforme : marque effective de chaque entreprise (lecture seule), pour repérer une usurpation ou un abus.
// Monté dans routes/admin.js APRÈS requireAdmin. Aucune donnée métier : noms affichés, couleur, mode, présence d'un logo, tentatives refusées.
const express = require('express');
const { db } = require('../db');
const B = require('../services/brand-lib');

const router = express.Router();

router.get('/brands', async (req, res) => {
  const rows = await db.prepare(`SELECT o.id, o.name, o.owner_id, u.name AS owner, b.config, b.logo_mime, b.favicon_mime, b.version, b.updated_at, b.token, b.logo_hash, b.favicon_hash
    FROM org_brand b JOIN orgs o ON o.id = b.org_id LEFT JOIN users u ON u.id = o.owner_id WHERE b.version > 0 ORDER BY b.updated_at DESC LIMIT 500`).all();
  const norms = new Map();
  const items = rows.map((r) => {
    const e = B.effectiveFrom({ id: r.id, name: r.name }, r);
    const n = B.norm(e.productName);
    if (n) norms.set(n, (norms.get(n) || 0) + 1);
    return { orgId: Number(r.id), org: r.name, owner: r.owner || '', mode: e.mode, productName: e.productName, assistantName: e.assistantName, shownName: e.name, color: e.color, theme: e.theme, hasLogo: e.hasLogo, hasFavicon: e.hasFavicon, version: Number(r.version), updatedAt: r.updated_at, n };
  }).map(({ n, ...x }) => ({ ...x, duplicateName: Boolean(n) && norms.get(n) > 1 }));
  const refused = await db.prepare("SELECT l.org_id, o.name AS org, l.detail, l.created_at FROM org_brand_log l JOIN orgs o ON o.id = l.org_id WHERE l.action = 'refused' ORDER BY l.id DESC LIMIT 50").all();
  const total = Number((await db.prepare('SELECT COUNT(*) AS n FROM orgs').get()).n);
  res.json({ total, customized: items.length, items, refused: refused.map((r) => ({ orgId: Number(r.org_id), org: r.org, detail: r.detail, at: r.created_at })) });
});

router.get('/brands/:orgId', async (req, res) => {
  const id = Number(req.params.orgId);
  const org = Number.isInteger(id) ? await db.prepare('SELECT id, name FROM orgs WHERE id = ?').get(id) : null;
  if (!org) return res.status(404).json({ error: 'Entreprise introuvable.' });
  const eff = B.effectiveFrom(org, await B.rowOf(id));
  const log = await db.prepare('SELECT action, detail, created_at FROM org_brand_log WHERE org_id = ? ORDER BY id DESC LIMIT 30').all(id);
  res.json({ org: { id: Number(org.id), name: org.name }, brand: { ...eff, vocab: undefined }, log: log.map((l) => ({ action: l.action, detail: l.detail, at: l.created_at })) });
});

module.exports = router;
