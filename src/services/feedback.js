'use strict';
// Avis et recommandations : cœur du module (validation, indicateurs, notification du fondateur, résumé quotidien, droits des personnes).
// Les routes sont dans workspace/feedback.js (utilisateurs, témoignages publics) et routes/admin-feedback.js (fondateur).
// Principes :
//  - un avis est adressé à la plateforme (le fondateur), pas à l'organisation : l'export d'organisation ne l'inclut pas ;
//  - « anonyme » : l'identité n'est jamais enregistrée dans l'avis (user_id vide, pas de nom) et n'est jamais montrée au fondateur ;
//    seule une empreinte à clé secrète (author_hash) permet à son auteur de retrouver, retirer ou supprimer SES avis et de limiter la fréquence ;
//  - un témoignage n'est public que si l'avis est approuvé par l'administrateur ET que l'auteur a consenti ; il se retire à tout moment.
const crypto = require('crypto');
const config = require('../config');
const { db, nowISO } = require('../db');
const { HttpError, cleanText, log, oneLine } = require('../util');

const KINDS = ['review', 'suggestion', 'problem', 'comment'];
const KIND_LABEL = { review: 'Avis', suggestion: 'Suggestion', problem: 'Problème', comment: 'Commentaire' };
const STATUSES = ['new', 'read', 'in_progress', 'done', 'archived'];
const STATUS_LABEL = { new: 'Nouveau', read: 'Lu', in_progress: 'En cours', done: 'Traité', archived: 'Archivé' };
const BODY_MAX = 2000;
const NOTE_MAX = 2000;
const SHOT_MAX = (Number(process.env.FEEDBACK_SHOT_MAX_MB) > 0 ? Number(process.env.FEEDBACK_SHOT_MAX_MB) : 2) * 1024 * 1024;
const PER_DAY = () => Math.max(parseInt(process.env.FEEDBACK_PER_DAY, 10) || 5, 1);
const MIN_GAP_S = () => (process.env.FEEDBACK_MIN_GAP_S !== undefined ? Math.max(parseInt(process.env.FEEDBACK_MIN_GAP_S, 10) || 0, 0) : 60);

const moduleIds = () => new Set(['general', ...require('../workspace/modules').modules.map((m) => m.id)]);
const moduleTitle = (id) => (require('../workspace/modules').modules.find((m) => m.id === id) || {}).title || (id === 'general' ? 'Ensemble du logiciel' : String(id));

/** Empreinte (HMAC) de l'auteur : sert à limiter la fréquence et à retrouver ses propres avis, même anonymes, sans jamais montrer l'identité. */
const authorHash = (userId) => crypto.createHmac('sha256', config.dataKey || config.jwtSecret).update(`feedback-author|${Number(userId)}`).digest('hex');

/** Texte libre : sans caractères de contrôle (les retours à la ligne sont gardés), sans espaces superflus. L'affichage échappe toujours (React, texte brut). */
const clean = (v, max) => cleanText(typeof v === 'string' ? v.replace(/[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f‪-‮⁦-⁩]/g, '') : '', max);

const intIn = (v, lo, hi, msg) => {
  const n = typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v) : v;
  if (!Number.isInteger(n) || n < lo || n > hi) throw new HttpError(400, msg);
  return n;
};
const bool = (v) => v === true || v === 1 || v === '1' || v === 'true';

/** « Awa N. » : prénom + initiale du nom. Jamais l'adresse, jamais le nom complet. */
function shortName(full) {
  const parts = String(full || '').replace(/[^\p{L}\p{M}\s'’.-]/gu, ' ').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '';
  const first = parts[0].slice(0, 30);
  const last = parts.length > 1 ? parts[parts.length - 1] : '';
  return last ? `${first} ${Array.from(last)[0].toUpperCase()}.` : first;
}

/** Valide une saisie d'avis. Renvoie les champs prêts à enregistrer. */
function validate(b, user, lang) {
  b = b && typeof b === 'object' ? b : {};
  const kind = KINDS.includes(b.kind) ? b.kind : (b.kind === undefined ? 'review' : null);
  if (!kind) throw new HttpError(400, 'Type inconnu : avis, suggestion, problème ou commentaire.');
  const module_ = typeof b.module === 'string' && b.module ? b.module : 'general';
  if (!moduleIds().has(module_)) throw new HttpError(400, 'Module inconnu.');
  const stars = intIn(b.stars, 1, 5, 'Donnez une note de 1 à 5 étoiles.');
  const nps = b.nps === undefined || b.nps === null || b.nps === '' ? null : intIn(b.nps, 0, 10, 'Le score de recommandation est un nombre de 0 à 10.');
  const body = clean(b.body, BODY_MAX);
  if (kind !== 'review' && body.length < 5) throw new HttpError(400, 'Décrivez votre suggestion, problème ou commentaire (5 caractères au moins).');
  if (typeof b.body === 'string' && b.body.length > BODY_MAX * 2) throw new HttpError(400, `Message trop long (${BODY_MAX} caractères au plus).`);
  const anonymous = bool(b.anonymous);
  const publicConsent = bool(b.publicConsent);
  if (publicConsent && kind !== 'review') throw new HttpError(400, "Seul un avis (pas une suggestion ni un problème) peut être proposé comme témoignage public.");
  if (publicConsent && body.length < 10) throw new HttpError(400, 'Pour un témoignage public, écrivez votre avis (10 caractères au moins).');
  const page = clean(typeof b.page === 'string' ? b.page.split('?')[0].split('#')[0].replace(/\/\d+/g, '/·') : '', 120);
  return { kind, module: module_, stars, nps, body, page, lang: ['fr', 'en', 'de', 'es'].includes(lang) ? lang : 'fr', anonymous, publicConsent, displayName: anonymous ? '' : shortName(user && user.name) };
}

/** Anti-abus : un avis toutes les minutes au plus, quelques-uns par jour, par personne (quelle que soit l'organisation). */
async function assertRate(hash) {
  const since = new Date(Date.now() - 86400000).toISOString();
  const r = await db.prepare('SELECT COUNT(*) AS n, MAX(created_at) AS last FROM fb_feedback WHERE author_hash = ? AND created_at >= ?').get(hash, since);
  if (Number(r.n) >= PER_DAY()) throw new HttpError(429, `Vous avez déjà envoyé ${PER_DAY()} avis aujourd'hui. Merci, revenez demain.`);
  if (r.last && Date.now() - Date.parse(r.last) < MIN_GAP_S() * 1000) throw new HttpError(429, 'Merci ! Patientez une minute avant un nouvel envoi.');
}

async function create(req, org, v) {
  const hash = authorHash(req.user.id);
  await assertRate(hash);
  const now = nowISO();
  const id = Number((await db.prepare('INSERT INTO fb_feedback (org_id, user_id, author_hash, kind, module, stars, nps, body, page, lang, anonymous, display_name, public_consent, consent_at, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(org.id, v.anonymous ? null : req.user.id, hash, v.kind, v.module, v.stars, v.nps, v.body, v.page, v.lang, v.anonymous ? 1 : 0, v.displayName, v.publicConsent ? 1 : 0, v.publicConsent ? now : null, 'new', now)).lastInsertRowid);
  return id;
}

// ---------- Image jointe ----------
/** Type réel de l'image d'après son contenu (jamais d'après le nom ni l'en-tête annoncé). PNG, JPEG et WebP seulement : ni SVG ni GIF animé. */
function sniffImage(b) {
  if (!Buffer.isBuffer(b) || b.length < 24) return null;
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    const w = b.readUInt32BE(16); const h = b.readUInt32BE(20);
    return w > 0 && h > 0 && w <= 10000 && h <= 10000 ? { mime: 'image/png' } : null;
  }
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: 'image/jpeg' };
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return { mime: 'image/webp' };
  return null;
}

// ---------- Vue ----------
/** Vue pour l'auteur (jamais de note interne). */
const mineView = (r) => ({
  id: Number(r.id), kind: r.kind, module: r.module, moduleTitle: moduleTitle(r.module), stars: Number(r.stars), nps: r.nps == null ? null : Number(r.nps), body: r.body, anonymous: Number(r.anonymous) === 1,
  publicConsent: Number(r.public_consent) === 1, published: Number(r.public_consent) === 1 && !!r.approved_at, status: r.status, hasScreenshot: Number(r.shot_size) > 0, createdAt: r.created_at,
});

// ---------- Indicateurs ----------
const pct1 = (x) => Math.round(x * 10) / 10;
function npsOf(rows) {
  const s = rows.filter((r) => r.nps != null);
  if (!s.length) return { score: null, n: 0, promoters: 0, passives: 0, detractors: 0 };
  const pro = s.filter((r) => Number(r.nps) >= 9).length; const det = s.filter((r) => Number(r.nps) <= 6).length;
  return { score: Math.round(100 * (pro - det) / s.length), n: s.length, promoters: pro, passives: s.length - pro - det, detractors: det };
}
const avgOf = (rows) => (rows.length ? pct1(rows.reduce((a, r) => a + Number(r.stars), 0) / rows.length) : null);

/** Indicateurs sur `days` jours : note moyenne, NPS, répartition, évolution (par jour ou par semaine), modules les plus cités. */
async function stats(days) {
  days = Math.min(Math.max(parseInt(days, 10) || 30, 1), 365);
  const from = new Date(Date.now() - days * 86400000).toISOString();
  const prevFrom = new Date(Date.now() - 2 * days * 86400000).toISOString();
  const rows = await db.prepare('SELECT id, kind, module, stars, nps, status, created_at FROM fb_feedback WHERE created_at >= ?').all(prevFrom);
  const cur = rows.filter((r) => r.created_at >= from); const prev = rows.filter((r) => r.created_at < from);
  const byModule = new Map(); const byKind = {}; const byStatus = {}; const dist = [0, 0, 0, 0, 0];
  for (const r of cur) {
    const m = byModule.get(r.module) || { module: r.module, title: moduleTitle(r.module), count: 0, sum: 0, problems: 0 };
    m.count++; m.sum += Number(r.stars); if (r.kind === 'problem') m.problems++; byModule.set(r.module, m);
    byKind[r.kind] = (byKind[r.kind] || 0) + 1; byStatus[r.status] = (byStatus[r.status] || 0) + 1; dist[Number(r.stars) - 1]++;
  }
  const step = days > 60 ? 7 : 1; const series = [];
  const end = new Date(); end.setUTCHours(0, 0, 0, 0);
  for (let i = Math.ceil(days / step) - 1; i >= 0; i--) {
    const a = new Date(end.getTime() - i * step * 86400000); const z = new Date(a.getTime() + step * 86400000);
    const sl = cur.filter((r) => r.created_at >= a.toISOString() && r.created_at < z.toISOString());
    series.push({ day: a.toISOString().slice(0, 10), count: sl.length, avg: avgOf(sl), nps: npsOf(sl).score });
  }
  const newCount = (await db.prepare("SELECT COUNT(*) AS n FROM fb_feedback WHERE status = 'new'").get()).n;
  return {
    days, total: cur.length, previousTotal: prev.length, average: avgOf(cur), previousAverage: avgOf(prev), nps: npsOf(cur), previousNps: npsOf(prev).score,
    distribution: dist, byKind, byStatus, newCount: Number(newCount), series,
    topModules: [...byModule.values()].map((m) => ({ module: m.module, title: m.title, count: m.count, average: pct1(m.sum / m.count), problems: m.problems })).sort((a, b) => b.count - a.count).slice(0, 10),
  };
}

// ---------- Notification du fondateur ----------
// Canaux : l'e-mail seulement pour l'instant. WhatsApp : PAS d'API officielle ; un point d'extension est prévu, DÉSACTIVÉ par défaut
// (le fondateur décidera plus tard). Pour l'activer il faudra enregistrer un canal avec registerChannel('whatsapp', { enabled, send }) ET FEEDBACK_WHATSAPP=on.
const channels = new Map();
function registerChannel(name, ch) { channels.set(name, ch); }
registerChannel('email', {
  enabled: () => process.env.FEEDBACK_NOTIFY !== 'off' && require('./notify').mailEnabled() && Boolean(config.admin.email),
  send: async (subject, text) => require('./notify').sendMail({ to: config.admin.email, subject, text }),
});
registerChannel('whatsapp', { enabled: () => false, send: async () => { throw new Error('Canal WhatsApp non branché.'); } }); // point d'extension, désactivé
const channelOn = (name) => { const c = channels.get(name); try { return Boolean(c && c.enabled() && (name !== 'whatsapp' || process.env.FEEDBACK_WHATSAPP === 'on')); } catch { return false; } };

const oneLineClean = (s, n) => oneLine(String(s || '').replace(/[\r\n]+/g, ' '), n);
const stars = (n) => '★'.repeat(n) + '☆'.repeat(5 - n);

function mailText(r, who) {
  const lines = [
    `${KIND_LABEL[r.kind]} — ${stars(Number(r.stars))} (${r.stars}/5)${r.nps != null ? ` — recommandation ${r.nps}/10` : ''}`,
    `Module : ${moduleTitle(r.module)}${r.page ? ` (page ${r.page})` : ''}`,
    `De : ${who}`,
    `Témoignage public : ${Number(r.public_consent) ? 'consentement donné (à approuver dans Administration > Avis)' : 'non'}`,
    ...(Number(r.shot_size) > 0 ? ["Capture d'écran jointe (visible dans l'administration)."] : []),
    '', r.body || '(aucun texte)', '', 'Répondre / traiter : Administration > Avis.'];
  return lines.join('\n');
}
const whoOf = (r, orgName) => (Number(r.anonymous) ? 'utilisateur anonyme' : `${r.display_name || 'utilisateur'}${orgName ? ` (${orgName})` : ''}`);

/** Prévient le fondateur d'un nouvel avis. Ne bloque jamais la requête, ne plante jamais (e-mail non configuré = simple trace). */
function notifyNew(id) {
  setImmediate(async () => {
    try {
      const r = await db.prepare('SELECT f.*, o.name AS org_name FROM fb_feedback f JOIN orgs o ON o.id = f.org_id WHERE f.id = ?').get(id);
      if (!r) return;
      const subject = `[MABAH] Nouvel avis ${r.stars}/5 : ${oneLineClean(KIND_LABEL[r.kind] + ' · ' + moduleTitle(r.module), 90)}`;
      const text = mailText(r, whoOf(r, r.org_name));
      const sent = [];
      for (const name of channels.keys()) {
        if (!channelOn(name)) continue;
        try { await channels.get(name).send(subject, text); sent.push(name); } catch (e) { log.warn(`Avis : notification ${name} impossible : ${oneLine(e.message, 160)}`); }
      }
      if (!sent.length) log.info(`[avis] nouvel avis ${id} (${r.stars}/5) — aucun canal de notification actif : visible dans Administration > Avis.`);
      await db.prepare('UPDATE fb_feedback SET notified_at = ? WHERE id = ?').run(nowISO(), id);
      await db.prepare('INSERT INTO notifications (type, text, channels, created_at) VALUES (?, ?, ?, ?)').run('avis', oneLineClean(`Nouvel avis ${r.stars}/5 (${KIND_LABEL[r.kind]}, ${moduleTitle(r.module)}) : ${r.body}`, 300), sent.join(','), nowISO());
    } catch (e) { log.warn('Avis : notification impossible :', oneLine(e.message, 160)); }
  });
}

// ---------- Résumé quotidien ----------
/** Résumé des avis reçus pendant la journée UTC `day` (AAAA-MM-JJ). */
async function digest(day) {
  const from = `${day}T00:00:00.000Z`; const to = new Date(Date.parse(from) + 86400000).toISOString();
  const rows = await db.prepare('SELECT * FROM fb_feedback WHERE created_at >= ? AND created_at < ? ORDER BY created_at').all(from, to);
  const st = await stats(30);
  const open = await db.prepare("SELECT COUNT(*) AS n FROM fb_feedback WHERE status IN ('new', 'read', 'in_progress')").get();
  const lines = [`Avis reçus le ${day} : ${rows.length}`, `Note moyenne du jour : ${avgOf(rows) == null ? '—' : avgOf(rows) + '/5'} · NPS du jour : ${npsOf(rows).score == null ? '—' : npsOf(rows).score}`,
    `Sur 30 jours : note moyenne ${st.average == null ? '—' : st.average + '/5'}, NPS ${st.nps.score == null ? '—' : st.nps.score}, ${st.total} avis.`, `À traiter (nouveaux, lus, en cours) : ${Number(open.n)}`];
  const mods = new Map(); for (const r of rows) mods.set(r.module, (mods.get(r.module) || 0) + 1);
  if (mods.size) lines.push('Modules cités : ' + [...mods.entries()].sort((a, b) => b[1] - a[1]).map(([m, n]) => `${moduleTitle(m)} (${n})`).join(', '));
  const prob = rows.filter((r) => r.kind === 'problem');
  if (prob.length) { lines.push('', 'Problèmes signalés :'); for (const r of prob.slice(0, 10)) lines.push(`- ${moduleTitle(r.module)} : ${oneLineClean(r.body, 160)}`); }
  return { day, count: rows.length, average: avgOf(rows), nps: npsOf(rows).score, open: Number(open.n), text: lines.join('\n') };
}

/** Appelé chaque heure par les tâches : envoie le résumé de la veille une fois par jour, après 6 h UTC, s'il y a eu des avis. Sans e-mail configuré : rien, sans erreur. */
async function runDigest() {
  const now = new Date();
  if (now.getUTCHours() < 6) return false;
  const today = now.toISOString().slice(0, 10);
  const last = await db.prepare("SELECT v FROM fb_state WHERE k = 'last_digest'").get();
  if (last && last.v >= today) return false;
  await db.prepare("INSERT INTO fb_state (k, v) VALUES ('last_digest', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v").run(today);
  const yesterday = new Date(now.getTime() - 86400000).toISOString().slice(0, 10);
  const d = await digest(yesterday);
  if (!d.count || !channelOn('email')) return false;
  try { await channels.get('email').send(`[MABAH] Résumé des avis du ${yesterday} : ${d.count} avis`, d.text); return true; } catch (e) { log.warn('Résumé quotidien des avis : envoi impossible :', oneLine(e.message, 160)); return false; }
}

// ---------- Droits des personnes ----------
/** Avis de l'utilisateur, y compris les anonymes (ils ne sont retrouvables que par l'empreinte) : pour l'export de ses données. */
async function exportAnonymousFor(userId) {
  const rows = await db.prepare('SELECT id, kind, module, stars, nps, body, page, lang, anonymous, public_consent, consent_at, status, shot_size, created_at FROM fb_feedback WHERE author_hash = ? AND anonymous = 1 ORDER BY id').all(authorHash(userId));
  return rows;
}
/** Suppression du compte : le texte, la capture et le nom disparaissent, le témoignage public est retiré ; seules les notes chiffrées restent (statistiques sans identité). */
async function eraseUser(userId) {
  const hash = authorHash(userId);
  await db.prepare("UPDATE fb_feedback SET user_id = NULL, author_hash = '', body = '', display_name = '', page = '', shot = NULL, shot_mime = '', shot_size = 0, public_consent = 0, approved_at = NULL, anonymous = 1, updated_at = ? WHERE user_id = ? OR author_hash = ?").run(nowISO(), userId, hash);
}

module.exports = {
  KINDS, KIND_LABEL, STATUSES, STATUS_LABEL, BODY_MAX, NOTE_MAX, SHOT_MAX, moduleTitle, authorHash, clean, intIn, bool, shortName, validate, create, sniffImage, mineView, stats, npsOf, avgOf,
  registerChannel, channelOn, notifyNew, digest, runDigest, mailText, whoOf, exportAnonymousFor, eraseUser,
};
