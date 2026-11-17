'use strict';
// Chiffrement au repos : liste des colonnes protégées, mise à niveau des anciennes données en clair, et rotation de la clé (DATA_KEY).
// Idempotent : on peut relancer sans risque ; une valeur déjà chiffrée avec la clé actuelle n'est pas touchée.
const { db } = require('../db');
const vault = require('../services/vault');
const { log } = require('../util');

// [table, colonne, type] : « field » = donnée personnelle (v2), « secret » = secret technique (v1).
const COLUMNS = [
  ['employees', 'cnps_no', 'field'], ['employees', 'niu', 'field'], ['employees', 'pay_account', 'field'], ['employees', 'cni_no', 'field'], ['employees', 'emergency_phone', 'field'],
  ['webhooks_out', 'secret', 'secret'], ['users', 'totp_secret', 'secret'], ['orgs', 'wa_token', 'secret'], ['orgs', 'wa_secret', 'secret'], ['orgs', 'fb_token', 'secret'], ['orgs', 'fb_secret', 'secret'],
];

/** Chiffre ce qui est encore en clair et rechiffre avec la clé actuelle ce qui l'était avec une ancienne. Renvoie { upgraded, rewrapped, unreadable }. */
async function run() {
  const out = { upgraded: 0, rewrapped: 0, unreadable: 0 };
  for (const [table, col, type] of COLUMNS) {
    let rows;
    try { rows = await db.prepare(`SELECT id, ${col} AS v FROM ${table} WHERE ${col} IS NOT NULL AND ${col} <> ''`).all(); } catch { continue; } // table absente : ignorée
    for (const r of rows) {
      let next;
      if (!vault.isEncrypted(r.v)) next = type === 'field' ? vault.encryptField(r.v) : vault.encrypt(r.v);
      else { next = vault.rewrap(r.v); if (next === null) { out.unreadable++; continue; } }
      if (next === r.v) continue;
      if (vault.isEncrypted(r.v)) { // rechiffrement : seulement si le texte clair est identique (garde-fou), la valeur change forcément (IV aléatoire)
        const same = (type === 'field' ? vault.decryptField(next) : vault.decrypt(next)) === (type === 'field' ? vault.decryptField(r.v) : vault.decrypt(r.v));
        if (!same) { out.unreadable++; continue; }
        if (process.env.SECURITY_REWRAP !== '1') continue; // sans demande explicite, on ne réécrit pas les valeurs déjà chiffrées
        out.rewrapped++;
      } else out.upgraded++;
      await db.prepare(`UPDATE ${table} SET ${col} = ? WHERE id = ?`).run(next, r.id);
    }
  }
  return out;
}

/** Lancé au démarrage : met à niveau les données en clair sans jamais bloquer le serveur. */
function startupUpgrade() {
  if (process.env.SKIP_STARTUP_ENCRYPTION === '1') { log.warn('Chiffrement au repos au démarrage désactivé (SKIP_STARTUP_ENCRYPTION=1) : les anciennes données en clair le restent.'); return; }
  run().then((r) => { if (r.upgraded) log.info(`Chiffrement au repos : ${r.upgraded} valeur(s) ancienne(s) chiffrée(s).`); if (r.unreadable) log.warn(`Chiffrement au repos : ${r.unreadable} valeur(s) illisible(s) avec les clés actuelles (DATA_KEY / DATA_KEY_PREVIOUS).`); })
    .catch((e) => log.warn('Chiffrement au repos : mise à niveau impossible : ' + String(e.message).slice(0, 120)));
}

module.exports = { COLUMNS, run, startupUpgrade };
