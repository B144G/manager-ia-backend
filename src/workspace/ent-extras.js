'use strict';
// Modules ajoutés en complément (QHSE, Audit interne, Gestion des affaires) : MASQUÉS PAR DÉFAUT. Aucun écran, aucune route, aucun menu ni espace ne les montre
// tant que le propriétaire ne les a pas activés (Entreprise › réglage) ; la variable d\'environnement EXTRA_MODULES=off les coupe pour toutes les entreprises.
const { db, nowISO } = require('../db');

const IDS = ['qhse', 'affaires', 'audit_interne'];
const globalOff = () => /^(off|0|false|no|non|disabled|desactive|désactivé)$/i.test(String(process.env.EXTRA_MODULES || '').trim());
async function enabled(orgId) {
  if (globalOff()) return false;
  const r = await db.prepare('SELECT extra_modules FROM ent_setup WHERE org_id = ?').get(orgId);
  return Boolean(r && Number(r.extra_modules));
}
async function setEnabled(orgId, userId, on) {
  await db.prepare(`INSERT INTO ent_setup (org_id, steps, template, extra_modules, updated_by, updated_at) VALUES (?, '{}', '', ?, ?, ?)
    ON CONFLICT (org_id) DO UPDATE SET extra_modules = EXCLUDED.extra_modules, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`).run(orgId, on ? 1 : 0, userId, nowISO());
}
/** Garde de route : tant que le module est masqué, il n\'existe pas (404, comme une route inconnue). */
const gate = (req, res, next) => enabled(req.org.id).then((on) => (on ? next() : res.status(404).json({ error: 'Route introuvable.' }))).catch(next);

module.exports = { IDS, enabled, setEnabled, globalOff, gate };
