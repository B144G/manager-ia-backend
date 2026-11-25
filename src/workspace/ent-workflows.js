'use strict';
// Circuits de validation de DIRECTION : le tableau « opération → initiateur → validateur » de la spécification, branché sur le moteur de circuits d'Administration (adm_flows / adm_requests :
// étapes séquentielles, seuils de montant, délégations avec plafond, intérim, escalade, journal). AUCUN moteur parallèle : ce module ne fait qu'INSTALLER ces circuits (validateurs = postes de directeur
// ou direction générale) et les proposer aux initiateurs. Séparation des tâches : le moteur interdit d'approuver sa propre demande ; chaque validation est journalisée ; l'entreprise règle seuils et validateurs.
const { db, nowISO } = require('../db');
const A = require('./access');
const W = require('./w3');
const { HttpError, parseJSON } = require('../util');

const THRESHOLD = 5000000; // seuil par défaut (FCFA) au-delà duquel la direction générale valide à son tour
/** Opérations de la spécification. initiator : espaces dont un membre (écriture) peut lancer la demande ; steps : validateurs par défaut. */
const WORKFLOWS = [
  { key: 'achat_demande', label: "Demande d'achat", kind: 'purchase', initiator: 'Chef de chantier / responsable', initiatorSpaces: ['operations', 'stock', 'dir_technique', 'dir_production'], desc: "Une demande d'achat de matériaux ou de matériel est validée par la direction technique.", steps: [{ name: 'Responsable technique', approver: { type: 'direction', key: 'dtech' } }] },
  { key: 'budget_check', label: 'Vérification du budget', kind: 'expense', initiator: 'DAF / contrôle de gestion', initiatorSpaces: ['finances'], desc: 'Le budget est vérifié par la direction administrative et financière (ou son délégataire).', steps: [{ name: 'DAF ou délégataire', approver: { type: 'direction', key: 'daf' } }] },
  { key: 'commande_fournisseur', label: 'Commande fournisseur', kind: 'purchase', initiator: 'Achats', initiatorSpaces: ['stock'], desc: "La commande est validée par la direction des achats ; au-delà du seuil, la direction générale valide aussi.", steps: [{ name: 'Direction des achats', approver: { type: 'direction', key: 'dstock' } }, { name: 'Direction générale', approver: { type: 'dg' }, minAmount: THRESHOLD + 1 }] },
  { key: 'recrutement', label: 'Recrutement', kind: 'other', initiator: 'DRH', initiatorSpaces: ['rh', 'dir_rh'], desc: 'Un recrutement est validé par la direction générale ou son délégataire.', steps: [{ name: 'Direction générale', approver: { type: 'dg' } }] },
  { key: 'paiement_fournisseur', label: 'Paiement fournisseur', kind: 'expense', initiator: 'Comptabilité', initiatorSpaces: ['finances'], desc: "Le paiement est validé par la direction financière ; au-delà du seuil, la direction générale signe aussi.", steps: [{ name: 'DAF / signataire habilité', approver: { type: 'direction', key: 'daf' } }, { name: 'Direction générale', approver: { type: 'dg' }, minAmount: THRESHOLD + 1 }] },
  { key: 'validation_marche', label: "Validation d'un marché", kind: 'contract', initiator: 'Direction commerciale', initiatorSpaces: ['dir_commercial'], desc: "Un marché négocié par la direction commerciale est validé par la direction générale.", steps: [{ name: 'Direction générale', approver: { type: 'dg' } }] },
  { key: 'reception_technique', label: 'Réception technique', kind: 'other', initiator: 'Chef de projet', initiatorSpaces: ['operations', 'projets'], desc: 'La réception technique des travaux est validée par la direction technique.', steps: [{ name: 'Direction technique', approver: { type: 'direction', key: 'dtech' } }] },
  { key: 'cloture_financiere', label: 'Clôture financière du projet', kind: 'other', initiator: 'Comptabilité / contrôle de gestion', initiatorSpaces: ['finances'], desc: 'La clôture financière est validée par la direction administrative et financière.', steps: [{ name: 'DAF', approver: { type: 'direction', key: 'daf' } }] },
];
const BY = Object.fromEntries(WORKFLOWS.map((w) => [w.key, w]));
const DIRECTION_KEYS = ['dtech', 'daf', 'dstock', 'drh', 'dcom', 'dprod', 'dlog', 'dit', 'dsec', 'dmkt'];

const cfgOf = async (orgId, key) => { const r = await db.prepare('SELECT * FROM ent_workflows WHERE org_id = ? AND key = ?').get(orgId, key); return r ? { ...parseJSON(r.config, {}), flowId: r.flow_id ? Number(r.flow_id) : null, custom: true } : { flowId: null, custom: false }; };

/** Étapes effectives : réglage de l'entreprise, sinon défaut. Chaque étape : { name, approver:{type,key|role}, minAmount, maxAmount }. */
async function stepsOf(orgId, key) { const c = await cfgOf(orgId, key); return Array.isArray(c.steps) && c.steps.length ? c.steps : BY[key].steps; }

async function approverSpec(orgId, a) {
  if (a.type === 'dg') return { kind: 'edg' };
  if (a.type === 'direction') {
    const p = await db.prepare("SELECT id FROM ent_posts WHERE org_id = ? AND tkey = ? AND active = 1").get(orgId, 'dir_' + a.key);
    if (p) return { kind: 'epost', id: Number(p.id) };
    return { kind: 'role', role: 'admin' }; // pas de poste de directeur dans cette organisation : un administrateur valide
  }
  if (a.type === 'role') return { kind: 'role', role: A.oneOf(a.role, ['manager', 'admin', 'owner'], 'admin', 'Rôle inconnu.') };
  throw new HttpError(400, 'Validateur inconnu.');
}

/** Installe (ou met à jour) le circuit d'Administration correspondant à une opération. Idempotent. */
async function install(req, key) {
  const w = BY[key]; const o = req.org.id; const now = nowISO();
  const steps = [];
  for (const s of await stepsOf(o, key)) steps.push({ name: A.text(s.name, 100) || w.label, mode: 'any', approvers: [await approverSpec(o, s.approver)], minAmount: Number(s.minAmount) || 0, maxAmount: Number(s.maxAmount) || 0, delayHours: Number(s.delayHours) || 0, escalateTo: { kind: 'role', role: 'owner' }, deputy: null });
  const name = `Direction · ${w.label}`;
  const cur = await cfgOf(o, key);
  let fid = cur.flowId && await db.prepare('SELECT id, version FROM adm_flows WHERE id = ? AND org_id = ?').get(cur.flowId, o);
  if (fid) await db.prepare("UPDATE adm_flows SET steps = ?, name = ?, status = 'active', version = version + 1, updated_at = ? WHERE id = ?").run(JSON.stringify(steps), name, now, fid.id);
  else {
    const id = Number((await db.prepare("INSERT INTO adm_flows (org_id, name, kind, description, steps, min_amount, max_amount, status, version, created_by, validated_by, validated_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, 0, 'active', 1, ?, ?, ?, ?, ?)").run(o, name, w.kind, w.desc, JSON.stringify(steps), req.user.id, req.user.id, now, now, now)).lastInsertRowid);
    fid = { id };
  }
  await db.prepare(`INSERT INTO ent_workflows (org_id, key, config, flow_id, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (org_id, key) DO UPDATE SET flow_id = EXCLUDED.flow_id, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`).run(o, key, JSON.stringify({ steps: cur.steps || undefined }), Number(fid.id), req.user.id, now);
  return Number(fid.id);
}

/** Vue pour l'écran : opération, validateurs réglés, circuit installé. */
async function listFor(req) {
  const out = [];
  for (const w of WORKFLOWS) {
    const c = await cfgOf(req.org.id, w.key);
    const fl = c.flowId ? await db.prepare('SELECT id, status, version FROM adm_flows WHERE id = ? AND org_id = ?').get(c.flowId, req.org.id) : null;
    out.push({ key: w.key, label: w.label, desc: w.desc, kind: w.kind, initiator: w.initiator, steps: await stepsOf(req.org.id, w.key), installed: Boolean(fl && fl.status === 'active'), flowId: fl ? Number(fl.id) : null });
  }
  return out;
}

function cleanSteps(steps) {
  if (!Array.isArray(steps) || !steps.length || steps.length > 4) throw new HttpError(400, 'Un circuit compte de 1 à 4 étapes.');
  return steps.map((s, i) => {
    const a = s && s.approver ? s.approver : {};
    if (a.type === 'direction' && !DIRECTION_KEYS.includes(a.key)) throw new HttpError(400, 'Direction inconnue.');
    if (!['dg', 'direction', 'role'].includes(a.type)) throw new HttpError(400, 'Validateur inconnu.');
    const min = Math.max(0, Math.round(Number(s.minAmount) || 0)); const max = Math.max(0, Math.round(Number(s.maxAmount) || 0));
    if (max && max < min) throw new HttpError(400, `Étape ${i + 1} : le seuil maximum est inférieur au minimum.`);
    return { name: A.text(s.name, 100) || `Étape ${i + 1}`, approver: a.type === 'direction' ? { type: 'direction', key: a.key } : a.type === 'role' ? { type: 'role', role: A.oneOf(a.role, ['manager', 'admin', 'owner'], 'admin', 'Rôle inconnu.') } : { type: 'dg' }, minAmount: min, maxAmount: max, delayHours: Math.min(Math.max(Number(s.delayHours) || 0, 0), 1440) };
  });
}

/** Initiateur autorisé ? (espaces dont il est membre, ou administrateur ; sans espaces par rôle : tout membre) */
async function mayInitiate(req, w) {
  if (A.can(req, 'admin')) return true;
  const eff = await require('./spaces').effective(req);
  if (!eff.enabled) return true;
  return w.initiatorSpaces.some((sp) => eff.levels[sp] === 'write' || eff.levels[sp] === 'manage');
}
async function initiable(req) {
  const out = [];
  for (const w of WORKFLOWS) {
    const c = await cfgOf(req.org.id, w.key);
    if (!c.flowId) continue; // circuit pas encore installé par l'entreprise
    const fl = await db.prepare("SELECT id FROM adm_flows WHERE id = ? AND org_id = ? AND status = 'active'").get(c.flowId, req.org.id);
    if (fl && await mayInitiate(req, w)) out.push({ key: w.key, label: w.label, desc: w.desc, kind: w.kind });
  }
  return out;
}

/** Lance une demande : le moteur de circuits crée la demande et ses étapes. L'initiateur ne pourra pas l'approuver lui-même. */
async function start(req, res, key, next) {
  const w = BY[key];
  if (!w) throw new HttpError(404, 'Opération introuvable.');
  const c = await cfgOf(req.org.id, key);
  const fl = c.flowId ? await db.prepare("SELECT id FROM adm_flows WHERE id = ? AND org_id = ? AND status = 'active'").get(c.flowId, req.org.id) : null;
  if (!fl) throw new HttpError(409, "Le circuit de cette opération n'est pas encore installé : demandez à la direction générale ou au propriétaire de l'installer.");
  if (!await mayInitiate(req, w)) throw new HttpError(403, "Votre poste ne permet pas de lancer cette demande.");
  const b = req.body || {};
  req.body = { flowId: Number(fl.id), kind: w.kind, title: b.title, amount: b.amount, detail: b.detail, linkType: b.linkType, linkId: b.linkId };
  await W.audit(req, 'ent_workflow', Number(fl.id), 'start', null, { operation: key });
  return require('./adm-flow').handlers.create(req, res, next);
}

/** File « à valider » de la personne (étape en cours dont elle est approbatrice) : lecture directe du moteur de circuits. */
async function inboxOf(req) {
  const rows = await db.prepare(`SELECT r.id, r.ref, r.kind, r.title, r.detail, r.amount, r.created_at, u.name AS requester, s.name AS step, s.groups, s.due_at, f.name AS flow
    FROM adm_requests r JOIN adm_request_steps s ON s.request_id = r.id AND s.status = 'active' LEFT JOIN users u ON u.id = r.requester_id LEFT JOIN adm_flows f ON f.id = r.flow_id
    WHERE r.org_id = ? AND r.status = 'pending' ORDER BY r.id DESC LIMIT 200`).all(req.org.id);
  return rows.filter((r) => parseJSON(r.groups, []).some((g) => (g.userIds || []).includes(req.user.id) && !g.approvedBy)).map((r) => ({ id: Number(r.id), ref: r.ref, kind: r.kind, title: r.title, detail: r.detail, amount: Number(r.amount), requester: r.requester, step: r.step, flow: r.flow, dueAt: r.due_at, createdAt: r.created_at, mine: Number(r.requester_id) === req.user.id }));
}

module.exports = { WORKFLOWS, BY, DIRECTION_KEYS, THRESHOLD, listFor, install, cleanSteps, stepsOf, cfgOf, initiable, start, inboxOf, mayInitiate };
