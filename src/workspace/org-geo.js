'use strict';
// Position de l'entreprise (siège ou établissement principal), saisie PAR l'entreprise et partagée volontairement avec l'administration de la plateforme
// (carte des entreprises, statistiques par pays et par ville). Facultative, modifiable et retirable à tout moment ; jamais visible des autres entreprises.
// Monté sur /orgs/:orgId/geo : lecture pour tout membre, modification pour les administrateurs de l'entreprise.
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const { HttpError } = require('../util');

const router = express.Router({ mergeParams: true });
const view = (o) => ({ shared: o.geo_lat !== null && o.geo_lat !== undefined && o.geo_lng !== null && o.geo_lng !== undefined,
  lat: o.geo_lat === null || o.geo_lat === undefined ? null : Number(o.geo_lat), lng: o.geo_lng === null || o.geo_lng === undefined ? null : Number(o.geo_lng),
  city: o.geo_city || '', country: o.geo_country || '', sharedAt: o.geo_shared_at || null, address: o.address || '' });
const num = (v, min, max, msg) => { const n = Number(v); if (v === null || v === undefined || v === '' || !Number.isFinite(n) || n < min || n > max) throw new HttpError(400, msg); return n; };

router.get('/', (req, res) => res.json({ geo: view(req.org), notice: { visibleTo: 'platform_admin', purpose: 'statistics' } }));

router.put('/', A.need('admin'), async (req, res) => {
  const b = req.body || {};
  if (b.consent !== true) throw new HttpError(400, 'Cochez la case pour accepter de partager la position de votre entreprise avec MABAH.');
  const la = num(b.lat, -90, 90, 'Latitude invalide (entre -90 et 90).'); const ln = num(b.lng, -180, 180, 'Longitude invalide (entre -180 et 180).');
  const city = A.text(b.city, 80); const country = A.text(b.country, 60);
  if (!country) throw new HttpError(400, 'Indiquez le pays de votre entreprise.');
  // Précision limitée à environ 100 m (3 décimales) : suffisante pour une carte, sans désigner une porte.
  const r3 = (x) => Math.round(x * 1000) / 1000;
  await db.prepare('UPDATE orgs SET geo_lat = ?, geo_lng = ?, geo_city = ?, geo_country = ?, geo_shared_at = ?, geo_shared_by = ? WHERE id = ?').run(r3(la), r3(ln), city, country, nowISO(), req.user.id, req.org.id);
  await A.logActivity(req.org.id, req.user.id, 'team', 'Position de l\'entreprise partagée avec MABAH');
  res.json({ ok: true, geo: view(await db.prepare('SELECT * FROM orgs WHERE id = ?').get(req.org.id)) });
});

router.delete('/', A.need('admin'), async (req, res) => {
  await db.prepare("UPDATE orgs SET geo_lat = NULL, geo_lng = NULL, geo_city = '', geo_country = '', geo_shared_at = NULL, geo_shared_by = NULL WHERE id = ?").run(req.org.id);
  await A.logActivity(req.org.id, req.user.id, 'team', 'Position de l\'entreprise retirée');
  res.json({ ok: true });
});

module.exports = router;
