'use strict';
// Webhooks sortants : MANAGER-IA prévient un outil externe (Zapier, Make, n8n, votre propre serveur) quand quelque chose arrive.
// Sécurité : seulement des adresses publiques en HTTPS (contrôlées AU MOMENT de la connexion, donc aucune attaque par redirection DNS vers
// le réseau interne), aucune redirection suivie, corps signé HMAC-SHA256 (en-tête X-MIA-Signature), délai de 8 s, arrêt après 10 échecs de suite.
const crypto = require('crypto');
const dns = require('dns');
const http = require('http');
const https = require('https');
const net = require('net');
const { db, nowISO } = require('../db');
const { log, oneLine } = require('../util');

const EVENTS = { 'prospect.created': 'Nouveau prospect enregistré', 'order.created': 'Nouvelle commande à valider', 'payment.received': 'Paiement reçu sur une facture', 'chat.handoff': 'Conversation à reprendre par un conseiller', test: 'Message de test' };
// Les essais automatiques d'un développeur peuvent viser sa machine ; interdit en production.
const allowPrivate = () => process.env.NODE_ENV !== 'production' && process.env.WEBHOOK_ALLOW_PRIVATE === '1';

function isPublicIp(ip) {
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    if (l === '::1' || l === '::' || l.startsWith('fe8') || l.startsWith('fe9') || l.startsWith('fea') || l.startsWith('feb') || /^f[cd]/.test(l)) return false;
    const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(l); return m ? isPublicIp(m[1]) : true;
  }
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((x) => !(x >= 0 && x <= 255))) return false;
  const [a, b] = p;
  return !(a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224);
}

/** Vérifie une adresse saisie par un utilisateur. Renvoie un message d'erreur ou ''. */
function urlProblem(raw) {
  let u; try { u = new URL(String(raw || '').trim()); } catch { return "Adresse invalide (exemple : https://hooks.zapier.com/hooks/catch/123/abc/)."; }
  if (u.username || u.password) return "L'adresse ne doit pas contenir d'identifiant ni de mot de passe.";
  if (u.protocol !== 'https:' && !(allowPrivate() && u.protocol === 'http:')) return "L'adresse doit commencer par https://.";
  if (String(raw).length > 500) return 'Adresse trop longue.';
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!allowPrivate()) {
    if (net.isIP(host) && !isPublicIp(host)) return "Cette adresse pointe vers un réseau privé : non autorisée.";
    if (/^localhost$|\.localhost$|\.local$|\.internal$/i.test(host)) return "Cette adresse pointe vers un réseau privé : non autorisée.";
  }
  return '';
}

function safeLookup(hostname, opts, cb) {
  dns.lookup(hostname, { all: true }, (err, addrs) => {
    if (err) return cb(err);
    const ok = allowPrivate() ? addrs : addrs.filter((a) => isPublicIp(a.address));
    if (!ok.length) return cb(new Error('Adresse non autorisée'));
    if (opts && opts.all) return cb(null, ok);
    return cb(null, ok[0].address, ok[0].family);
  });
}

const sign = (secret, body) => 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');

function post(hook, body) {
  return new Promise((resolve) => {
    let u; try { u = new URL(hook.url); } catch { return resolve({ ok: false, status: 'adresse invalide' }); }
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.request({ method: 'POST', hostname: u.hostname.replace(/^\[|\]$/g, ''), port: u.port || undefined, path: u.pathname + u.search, lookup: safeLookup, timeout: 8000, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'user-agent': 'MANAGER-IA-Webhook/1', 'x-mia-signature': sign(hook.secret, body) } }, (res) => {
      res.resume();
      resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: String(res.statusCode) }); // une redirection (3xx) est un échec : jamais suivie
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 'délai dépassé' }); });
    req.on('error', (e) => resolve({ ok: false, status: oneLine(e.message, 60) }));
    req.end(body);
  });
}

async function deliver(hook, event, data) {
  const body = JSON.stringify({ id: crypto.randomUUID(), event, created_at: nowISO(), data });
  const r = await post({ ...hook }, body);
  if (r.ok) await db.prepare('UPDATE webhooks_out SET fails = 0, last_status = ?, last_at = ? WHERE id = ?').run(r.status, nowISO(), hook.id);
  else {
    await db.prepare('UPDATE webhooks_out SET fails = fails + 1, last_status = ?, last_at = ?, active = CASE WHEN fails + 1 >= 10 THEN 0 ELSE active END WHERE id = ?').run(`échec : ${r.status}`, nowISO(), hook.id);
  }
  return r;
}

/** Prévient les webhooks de l'organisation abonnés à cet événement. Ne bloque jamais et ne plante jamais l'action d'origine. */
async function emit(orgId, event, data) {
  try {
    const hooks = (await db.prepare('SELECT * FROM webhooks_out WHERE org_id = ? AND active = 1').all(orgId)).filter((h) => JSON.parse(h.events).includes(event));
    for (const h of hooks) setImmediate(async () => deliver(h, event, data).catch((e) => log.warn('Webhook sortant :', oneLine(e.message, 120))));
  } catch (e) { log.warn('Webhook sortant : erreur', oneLine(e.message, 120)); }
}

module.exports = { EVENTS, emit, deliver, urlProblem, isPublicIp, sign };
