'use strict';
// Garde-fou de coût de l'IA : compteurs par jour dans PostgreSQL (partagés entre serveurs, conservés au redémarrage).
// Plafond GLOBAL (toute la plateforme) et plafonds par « portée » (assistant du site, conversation publique d'une organisation).
// Le quota mensuel d'une organisation connectée reste dans workspace/access.js ; ceci protège contre l'abus des routes PUBLIQUES et contre une facture imprévue.
const { db } = require('../db');
const config = require('../config');
const { HttpError, log } = require('../util');

const day = () => new Date().toISOString().slice(0, 10);
const num = (k, d) => { const n = parseInt(process.env[k], 10); return Number.isFinite(n) && n >= 0 ? n : d; };
const caps = () => ({ global: num('AI_GLOBAL_DAILY_CAP', 20000), site: num('AI_SITE_DAILY_CAP', 1500), publicOrg: num('AI_PUBLIC_ORG_DAILY_CAP', 400) });

async function bump(scope) {
  const r = await db.prepare('INSERT INTO ai_budget (day, scope, calls) VALUES (?, ?, 1) ON CONFLICT (day, scope) DO UPDATE SET calls = ai_budget.calls + 1 RETURNING calls').get(day(), String(scope).slice(0, 60));
  return Number(r.calls);
}

/**
 * Compte un appel IA. Lance 429 si le plafond global ou celui de la portée est dépassé. En cas de panne de la base, l'appel passe (et c'est journalisé) :
 * mieux vaut un service qui répond qu'un service coupé par un compteur ; le quota mensuel et les limites par adresse restent actifs.
 */
async function charge(scope) {
  try {
    const c = caps();
    const g = await bump('global');
    if (g > c.global) throw new HttpError(429, "L'assistant a atteint sa limite d'utilisation pour aujourd'hui. Réessayez demain.");
    if (scope) {
      const cap = scope === 'site' ? c.site : String(scope).startsWith('org:') ? c.publicOrg : 0;
      if (cap) { const n = await bump(scope); if (n > cap) throw new HttpError(429, "Cet assistant a atteint sa limite d'utilisation pour aujourd'hui. Réessayez demain ou contactez-nous directement."); }
    }
  } catch (e) {
    if (e instanceof HttpError) throw e;
    log.warn('Budget IA : compteur indisponible (' + String(e.message).slice(0, 80) + ')');
  }
}
const sweep = async () => await db.prepare('DELETE FROM ai_budget WHERE day < ?').run(new Date(Date.now() - 40 * 86400000).toISOString().slice(0, 10));
const usage = async () => await db.prepare('SELECT scope, calls FROM ai_budget WHERE day = ? ORDER BY calls DESC LIMIT 50').all(day());

module.exports = { charge, sweep, usage, caps };
void config;
