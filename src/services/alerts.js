'use strict';
// Alertes d'activité suspecte pour l'administrateur. Calculées par une tâche périodique (src/jobs.js), jamais pendant les requêtes des utilisateurs.
// Chaque règle lit des compteurs déjà enregistrés (journal d'audit, sessions, usage IA, paiements, blocages d'adresses) : aucun contenu de message.
// Seuils réglables par variables d'environnement (valeurs par défaut raisonnables). Dédoublonnage : une alerte ouverte par sujet, et pas de nouvelle alerte
// pour le même sujet pendant ALERT_COOLDOWN_HOURS après la dernière. E-mail à l'administrateur pour la gravité haute seulement.
const crypto = require('crypto');
const { db, nowISO } = require('../db');
const { log, oneLine } = require('../util');
const { maskIp } = require('./accounts');

const int = (k, d) => { const n = parseInt(process.env[k], 10); return Number.isFinite(n) && n > 0 ? n : d; };
/** Seuils lus à chaque calcul (modifiables sans redémarrer les tests). */
const thresholds = () => ({
  loginFails: int('ALERT_LOGIN_FAILS', 10),            // échecs de connexion sur un compte...
  loginWindowMin: int('ALERT_LOGIN_WINDOW_MIN', 60),   // ...en cette durée (minutes)
  sessionIps: int('ALERT_SESSION_IPS', 5),             // adresses différentes ayant ouvert une connexion sur un compte...
  sessionWindowH: int('ALERT_SESSION_WINDOW_H', 6),    // ...en cette durée (heures)
  signupsPerIp: int('ALERT_SIGNUPS_PER_IP', 5),        // inscriptions depuis une même adresse...
  signupWindowH: int('ALERT_SIGNUP_WINDOW_H', 24),     // ...en cette durée (heures)
  aiPerHour: int('ALERT_AI_PER_HOUR', 120),            // messages IA d'un même compte en 1 heure
  aiPerDay: int('ALERT_AI_PER_DAY', 800),              // messages IA d'un même compte en 24 heures
  payRejects: int('ALERT_PAY_REJECTS', 3),             // paiements refusés / échoués sur un compte...
  payWindowD: int('ALERT_PAY_WINDOW_D', 30),           // ...en cette durée (jours)
  abuseWindowH: int('ALERT_ABUSE_WINDOW_H', 3),        // blocages automatiques d'adresses récents (limites de débit, abus)
  cooldownH: int('ALERT_COOLDOWN_HOURS', 24),
});

const SEVERITIES = ['low', 'medium', 'high'];
const SEVERITY_LABEL = { low: 'Faible', medium: 'Moyenne', high: 'Haute' };
const KIND_LABEL = {
  login_fails: 'Échecs de connexion répétés', many_devices: 'Connexions depuis beaucoup d\'adresses', signups_same_ip: 'Nombreuses inscriptions depuis une même adresse',
  ai_spike: 'Pic de messages IA', payment_rejects: 'Paiements refusés répétés', abuse_block: 'Adresse bloquée pour abus (limites de débit)',
};
const hash = (v) => crypto.createHash('sha1').update(String(v)).digest('hex').slice(0, 12);
const ago = (ms) => new Date(Date.now() - ms).toISOString();

/** Crée une alerte si elle n'existe pas déjà (dédoublonnage), puis prévient l'administrateur par e-mail si la gravité est haute. Renvoie true si créée. */
async function raise(c, T) {
  const recent = await db.prepare('SELECT 1 FROM admin_alerts WHERE dedupe_key = ? AND created_at >= ? LIMIT 1').get(c.key, ago(T.cooldownH * 3600 * 1000));
  if (recent) return false;
  const r = await db.prepare('INSERT INTO admin_alerts (kind, severity, user_id, title, detail, dedupe_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (dedupe_key) WHERE handled_at IS NULL DO NOTHING RETURNING id')
    .get(c.kind, c.severity, c.userId || null, c.title.slice(0, 200), String(c.detail || '').slice(0, 400), c.key, nowISO());
  if (!r) return false;
  if (c.severity === 'high') {
    try {
      const n = require('./notify');
      n.notify('alerte_activite', `Alerte activité suspecte (gravité haute) : ${c.title}${c.detail ? ' - ' + c.detail : ''}. Ouvrez l'administration > Alertes.`);
      if (n.mailEnabled()) await db.prepare('UPDATE admin_alerts SET mailed_at = ? WHERE id = ?').run(nowISO(), r.id);
    } catch (e) { log.warn('Alerte : e-mail non envoyé :', oneLine(e.message, 100)); }
  }
  return true;
}

const nameOf = async (id) => { const u = await db.prepare('SELECT name FROM users WHERE id = ?').get(id); return u ? u.name : `compte ${id}`; };

/** Les règles : chacune renvoie une liste de situations anormales (compte, gravité, texte). */
const RULES = {
  async login_fails(T) {
    const rows = await db.prepare("SELECT actor_id AS uid, COUNT(*) AS n, SUM(CASE WHEN action = 'login.locked' THEN 1 ELSE 0 END) AS locked FROM audit_trail WHERE actor_type = 'user' AND actor_id IS NOT NULL AND action IN ('login.fail', 'login.locked') AND at >= ? GROUP BY actor_id HAVING COUNT(*) >= ?")
      .all(ago(T.loginWindowMin * 60000), T.loginFails);
    const out = [];
    for (const r of rows) out.push({ kind: 'login_fails', severity: Number(r.locked) > 0 || Number(r.n) >= T.loginFails * 3 ? 'high' : 'medium', userId: Number(r.uid), key: `login_fails:${r.uid}`,
      title: `${await nameOf(r.uid)} : ${r.n} échecs de connexion en ${T.loginWindowMin} min`, detail: Number(r.locked) > 0 ? 'Le compte a été verrouillé 15 minutes.' : 'Quelqu\'un essaie peut-être de deviner le mot de passe.' });
    return out;
  },
  async many_devices(T) {
    const rows = await db.prepare("SELECT user_id AS uid, COUNT(DISTINCT ip) AS n FROM sessions WHERE kind = 'user' AND user_id IS NOT NULL AND created_at >= ? GROUP BY user_id HAVING COUNT(DISTINCT ip) >= ?")
      .all(ago(T.sessionWindowH * 3600000), T.sessionIps);
    const out = [];
    for (const r of rows) out.push({ kind: 'many_devices', severity: Number(r.n) >= T.sessionIps * 2 ? 'high' : 'medium', userId: Number(r.uid), key: `many_devices:${r.uid}`,
      title: `${await nameOf(r.uid)} : connexions depuis ${r.n} adresses en ${T.sessionWindowH} h`, detail: 'Le compte est peut-être partagé ou piraté. Vous pouvez fermer ses connexions depuis sa fiche.' });
    return out;
  },
  async signups_same_ip(T) {
    const rows = await db.prepare("SELECT ip, COUNT(*) AS n FROM audit_trail WHERE action = 'account.register' AND ip <> '' AND at >= ? GROUP BY ip HAVING COUNT(*) >= ?").all(ago(T.signupWindowH * 3600000), T.signupsPerIp);
    return rows.map((r) => ({ kind: 'signups_same_ip', severity: Number(r.n) >= T.signupsPerIp * 2 ? 'high' : 'medium', userId: null, key: `signups_same_ip:${hash(r.ip)}`,
      title: `${r.n} inscriptions depuis la même adresse (${maskIp(r.ip)}) en ${T.signupWindowH} h`, detail: 'Création de comptes en série possible.' }));
  },
  async ai_spike(T) {
    const out = [];
    const q = (since, min) => db.prepare('SELECT o.owner_id AS uid, COUNT(*) AS n FROM ai_usage a JOIN orgs o ON o.id = a.org_id WHERE a.created_at >= ? GROUP BY o.owner_id HAVING COUNT(*) >= ?').all(since, min);
    for (const r of await q(ago(3600000), T.aiPerHour)) out.push({ kind: 'ai_spike', severity: Number(r.n) >= T.aiPerHour * 3 ? 'high' : 'medium', userId: Number(r.uid), key: `ai_spike:${r.uid}:h`, title: `${await nameOf(r.uid)} : ${r.n} messages IA en 1 heure`, detail: 'Usage très supérieur à la normale (automatisation ou abus possible).' });
    for (const r of await q(ago(24 * 3600000), T.aiPerDay)) out.push({ kind: 'ai_spike', severity: Number(r.n) >= T.aiPerDay * 3 ? 'high' : 'medium', userId: Number(r.uid), key: `ai_spike:${r.uid}:d`, title: `${await nameOf(r.uid)} : ${r.n} messages IA en 24 heures`, detail: 'Usage très supérieur à la normale.' });
    return out;
  },
  async payment_rejects(T) {
    const rows = await db.prepare("SELECT user_id AS uid, COUNT(*) AS n FROM payments WHERE status = 'failed' AND created_at >= ? GROUP BY user_id HAVING COUNT(*) >= ?").all(ago(T.payWindowD * 86400000), T.payRejects);
    const out = [];
    for (const r of rows) out.push({ kind: 'payment_rejects', severity: Number(r.n) >= T.payRejects * 2 ? 'high' : 'medium', userId: Number(r.uid), key: `payment_rejects:${r.uid}`,
      title: `${await nameOf(r.uid)} : ${r.n} paiements refusés ou échoués en ${T.payWindowD} jours`, detail: 'Tentatives de paiement répétées sans succès : vérifiez les identifiants de transaction.' });
    return out;
  },
  async abuse_block(T) {
    // Blocages automatiques posés par les limites de débit et le détecteur d'abus (security/abuse).
    const rows = await db.prepare("SELECT ip, reason, created_at FROM ip_blocks WHERE created_by = 'auto' AND created_at >= ?").all(ago(T.abuseWindowH * 3600000));
    return rows.map((r) => ({ kind: 'abuse_block', severity: 'high', userId: null, key: `abuse_block:${hash(r.ip)}:${String(r.created_at).slice(0, 13)}`,
      title: `Adresse ${maskIp(r.ip)} bloquée automatiquement`, detail: String(r.reason || '').slice(0, 200) }));
  },
};

/** Calcule toutes les règles et crée les nouvelles alertes. Chaque règle est isolée : une panne n'arrête pas les autres. Renvoie le nombre d'alertes créées. */
async function scan() {
  const T = thresholds();
  let created = 0;
  for (const [name, rule] of Object.entries(RULES)) {
    try { for (const c of await rule(T)) if (await raise(c, T)) created++; }
    catch (e) { log.warn(`Alertes (${name}) :`, oneLine(e.message, 140)); }
  }
  return created;
}

async function list({ status = 'open', limit = 200 } = {}) {
  const w = status === 'handled' ? 'a.handled_at IS NOT NULL' : status === 'all' ? '1=1' : 'a.handled_at IS NULL';
  const n = Math.min(Math.max(parseInt(limit, 10) || 200, 1), 500);
  const rows = await db.prepare(`SELECT a.*, u.name AS user_name, u.contact AS user_contact FROM admin_alerts a LEFT JOIN users u ON u.id = a.user_id WHERE ${w}
    ORDER BY (CASE a.severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END), a.id DESC LIMIT ${n}`).all();
  return rows.map((a) => ({ id: Number(a.id), kind: a.kind, kindLabel: KIND_LABEL[a.kind] || a.kind, severity: a.severity, severityLabel: SEVERITY_LABEL[a.severity] || a.severity, title: a.title, detail: a.detail,
    user: a.user_id ? { id: Number(a.user_id), name: a.user_name, contact: a.user_contact } : null, createdAt: a.created_at, handledAt: a.handled_at || null, mailed: Boolean(a.mailed_at) }));
}
async function handle(id) {
  const r = await db.prepare('UPDATE admin_alerts SET handled_at = ? WHERE id = ? AND handled_at IS NULL').run(nowISO(), id);
  return r.changes > 0;
}
const openCounts = async () => {
  const r = await db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN severity = 'high' THEN 1 ELSE 0 END), 0) AS high FROM admin_alerts WHERE handled_at IS NULL").get();
  return { open: Number(r.n), high: Number(r.high) };
};
async function sweep() {
  await db.prepare('DELETE FROM admin_alerts WHERE handled_at IS NOT NULL AND handled_at < ?').run(ago(90 * 86400000));
  await db.prepare('DELETE FROM admin_alerts WHERE created_at < ?').run(ago(365 * 86400000));
}

module.exports = { thresholds, scan, list, handle, openCounts, sweep, SEVERITIES, SEVERITY_LABEL, KIND_LABEL };
