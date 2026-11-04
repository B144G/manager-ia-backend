'use strict';
// Prospection avec consentement : les coordonnées viennent d'un formulaire rempli volontairement, jamais d'un pistage.
//  - relances par e-mail (3 messages, J+1, J+3, J+7) seulement si la personne a coché la case et laissé une adresse ; lien de désinscription dans chaque message ;
//  - statistiques de visites anonymes : compteurs par jour, page, origine et type d'appareil. Ni adresse IP, ni cookie, ni identifiant n'est enregistré.
const crypto = require('crypto');
const config = require('../config');
const { db, nowISO } = require('../db');
const { log, isEmail, oneLine, addDays } = require('../util');
const { sendMail } = require('./notify');

const STATUSES = ['new', 'contacted', 'trial', 'client', 'lost'];
const STAGE_DAYS = [1, 3, 7]; // jours après la demande
const siteUrl = () => (config.siteUrl || 'https://brij-ia.vercel.app').replace(/\/+$/, '');
const apiUrl = () => (process.env.PUBLIC_API_URL || process.env.RENDER_EXTERNAL_URL || 'https://manager-ia-backend.onrender.com').replace(/\/+$/, '');
const PHONE = '+237 653 62 13 88';

/** Sépare le contact libre en e-mail et téléphone. */
function splitContact(contact) {
  const c = String(contact || '').trim();
  if (isEmail(c) && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(c)) return { email: c.toLowerCase().slice(0, 120), phone: '' };
  const d = c.replace(/[^\d+]/g, '');
  return { email: '', phone: d.replace(/\D/g, '').length >= 8 ? d.slice(0, 20) : '' };
}

function firstFollowAt(from = new Date()) { return addDays(from, STAGE_DAYS[0]).toISOString(); }

const MAILS = [
  (n) => ({ subject: 'Brij-IA : bien démarrer en 5 minutes', text: `Bonjour ${n},\n\nMerci de l'intérêt que vous portez à Brij-IA. Pour essayer sans rien payer :\n\n1. Créez votre compte (gratuit) : ${siteUrl()}\n2. Ouvrez « Clients et ventes » et ajoutez un premier client.\n3. Créez une facture : le bouton « Guide » (point d'interrogation jaune) vous montre chaque étape avec des flèches.\n\nUne question ? Répondez à cet e-mail ou écrivez-nous sur WhatsApp au ${PHONE}.\n\nL'équipe Brij-IA` }),
  (n) => ({ subject: 'Brij-IA : ce que vous pouvez faire dès aujourd\'hui', text: `Bonjour ${n},\n\nQuelques exemples de ce que Brij-IA prend en charge pour une petite entreprise :\n\n- vos factures et vos paiements reçus, avec les relances préparées pour les impayés ;\n- votre stock, avec une alerte avant la rupture ;\n- votre budget du mois, par catégorie ;\n- vos employés, leurs congés et leurs bulletins de paie (documents de travail à faire valider par un expert).\n\nEssayez gratuitement : ${siteUrl()}\n\nL'équipe Brij-IA` }),
  (n) => ({ subject: 'Brij-IA : on vous aide à démarrer ?', text: `Bonjour ${n},\n\nSi vous n'avez pas encore eu le temps d'essayer Brij-IA, nous pouvons le faire ensemble : une démonstration de 10 minutes, sur WhatsApp ou par appel, adaptée à votre activité.\n\nÉcrivez-nous au ${PHONE}, ou répondez simplement à cet e-mail.\n\nC'est notre dernier message automatique. Merci pour votre confiance.\nL'équipe Brij-IA` }),
];

const unsubText = (token) => `\n\n—\nVous recevez ce message car vous avez demandé à être contacté(e) par Brij-IA. Pour ne plus recevoir nos e-mails : ${apiUrl()}/api/unsubscribe?t=${token}`;

/** Envoie les relances arrivées à échéance. Appelé chaque heure ; 20 e-mails au plus par passage (limite d'envoi du fournisseur). */
async function sendDueFollowups(limit = 20) {
  const rows = await db.prepare(
    "SELECT * FROM leads WHERE consent = 1 AND unsubscribed = 0 AND email IS NOT NULL AND email != '' AND status IN ('new','contacted') AND follow_stage < ? AND next_follow_at IS NOT NULL AND next_follow_at <= ? ORDER BY next_follow_at LIMIT ?"
  ).all(STAGE_DAYS.length, nowISO(), limit);
  let sent = 0;
  for (const l of rows) {
    const stage = Number(l.follow_stage) || 0;
    const m = MAILS[stage](oneLine(l.name, 60).split(' ')[0] || 'Bonjour');
    const token = l.unsub_token || crypto.randomBytes(16).toString('hex');
    try {
      const ok = await sendMail({ to: l.email, subject: m.subject, text: m.text + unsubText(token), headers: { 'List-Unsubscribe': `<${apiUrl()}/api/unsubscribe?t=${token}>` } });
      if (!ok) { log.info('[e-mail non configuré] relance de prospect non envoyée'); break; }
      const next = stage + 1 < STAGE_DAYS.length ? addDays(new Date(), STAGE_DAYS[stage + 1] - STAGE_DAYS[stage]).toISOString() : null;
      await db.prepare('UPDATE leads SET follow_stage = ?, next_follow_at = ?, unsub_token = ? WHERE id = ?').run(stage + 1, next, token, l.id);
      sent += 1;
    } catch (e) { log.warn('Relance de prospect :', oneLine(e.message, 160)); }
  }
  return sent;
}

async function unsubscribe(token) {
  if (!/^[a-f0-9]{32}$/.test(String(token || ''))) return false;
  const r = await db.prepare('UPDATE leads SET unsubscribed = 1, next_follow_at = NULL WHERE unsub_token = ?').run(token);
  return r.changes > 0;
}

// ---------- Visites anonymes ----------
const PATH_RE = /^\/[a-z0-9\-_/]{0,60}$/i;
const cleanPath = (p) => { const s = String(p || '/').split(/[?#]/)[0].replace(/\/+$/, '') || '/'; return PATH_RE.test(s) && !/^\/(app|admin)(\/|$)/i.test(s) ? s : null; };
function sourceOf(ref, utm, own) {
  const u = String(utm || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 30);
  if (u) return u;
  try { const h = new URL(ref).hostname.replace(/^www\./, '').toLowerCase().slice(0, 60); return h && h !== own ? h : 'direct'; } catch { return 'direct'; }
}
async function recordVisit({ path, ref, utm, ua, own }) {
  const p = cleanPath(path); if (!p) return false;
  const device = /Mobi|Android|iPhone|iPad/i.test(String(ua || '')) ? 'mobile' : 'ordinateur';
  if (/bot|crawl|spider|slurp|preview|headless/i.test(String(ua || ''))) return false; // les robots ne comptent pas
  const day = nowISO().slice(0, 10);
  await db.prepare('INSERT INTO site_visits (day, path, source, device, n) VALUES (?, ?, ?, ?, 1) ON CONFLICT (day, path, source, device) DO UPDATE SET n = site_visits.n + 1').run(day, p, sourceOf(ref, utm, own), device);
  return true;
}
async function visitStats(days = 30) {
  const since = addDays(new Date(), -days).toISOString().slice(0, 10);
  const rows = await db.prepare('SELECT day, path, source, device, n FROM site_visits WHERE day >= ?').all(since);
  const sum = (key) => { const m = new Map(); for (const r of rows) m.set(r[key], (m.get(r[key]) || 0) + Number(r.n)); return [...m.entries()].sort((a, b) => b[1] - a[1]); };
  const byDay = sum('day').sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([day, n]) => ({ day, n }));
  return {
    days, total: rows.reduce((a, r) => a + Number(r.n), 0), byDay,
    pages: sum('path').slice(0, 10).map(([path, n]) => ({ path, n })),
    sources: sum('source').slice(0, 10).map(([source, n]) => ({ source, n })),
    devices: sum('device').map(([device, n]) => ({ device, n })),
  };
}

module.exports = { STATUSES, splitContact, firstFollowAt, sendDueFollowups, unsubscribe, recordVisit, visitStats, cleanPath };
