'use strict';
// Administration : carte des entreprises qui ont partagé leur position (facultatif, par l'entreprise elle-même). Monté dans routes/admin.js APRÈS requireAdmin.
// Ne renvoie que : nom, ville, pays, position (≈ 100 m), offre du propriétaire, nombre de membres. Jamais de donnée métier.
const express = require('express');
const { db } = require('../db');

const router = express.Router();

router.get('/geo/orgs', async (req, res) => {
  const rows = await db.prepare(`SELECT o.id, o.name, o.geo_lat, o.geo_lng, o.geo_city, o.geo_country, o.geo_shared_at, o.created_at,
      (SELECT COUNT(*) FROM org_members m WHERE m.org_id = o.id) AS members, u.plan AS plan
    FROM orgs o LEFT JOIN users u ON u.id = o.owner_id WHERE o.geo_lat IS NOT NULL AND o.geo_lng IS NOT NULL ORDER BY o.name`).all();
  const total = Number((await db.prepare('SELECT COUNT(*) AS n FROM orgs').get()).n);
  const by = (key) => { const m = new Map(); for (const r of rows) { const k = (r[key] || '—').trim() || '—'; m.set(k, (m.get(k) || 0) + 1); } return [...m.entries()].map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n || a.name.localeCompare(b.name)); };
  res.json({
    total, located: rows.length, notLocated: total - rows.length, rate: total ? Math.round((rows.length / total) * 1000) / 1000 : 0,
    orgs: rows.map((r) => ({ id: Number(r.id), name: r.name, lat: Number(r.geo_lat), lng: Number(r.geo_lng), city: r.geo_city || '', country: r.geo_country || '', plan: r.plan || 'Gratuit', members: Number(r.members), sharedAt: r.geo_shared_at, createdAt: r.created_at })),
    byCountry: by('geo_country'), byCity: by('geo_city').slice(0, 20),
  });
});

module.exports = router;
