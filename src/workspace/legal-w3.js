'use strict';
// Juridique · vague 3 : registres de l'entreprise (statuts, assemblées et procès-verbaux, associés, RCCM) et calendrier de conformité
// pré-rempli pour le Cameroun. Tout est un DOCUMENT DE TRAVAIL : les exemples sont étiquetés « à vérifier » et à faire valider par un juriste.
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const W = require('./w3');
const { HttpError } = require('../util');

const router = express.Router({ mergeParams: true });
const mgr = A.need('manager'); const adm = A.need('admin');
const KINDS = ['statuts', 'ag', 'pv', 'associe', 'rccm', 'other'];
const KIND_LABEL = { statuts: 'Statuts', ag: 'Assemblée générale', pv: 'Procès-verbal', associe: 'Associé', rccm: 'RCCM', other: 'Autre' };

W.crud(router, { path: '/registers', table: 'legal_registers', entity: 'legal_register', read: 'manager', write: 'admin', order: 'kind, date DESC, id DESC', filters: ['kind'], insertExtra: (req) => ({ created_by: req.user.id }),
  fields: [{ k: 'kind', t: 'enum', opts: KINDS, req: true, msg: 'Choisissez le registre.' }, { k: 'title', t: 'text', max: 150, req: true, msg: 'Indiquez le titre.' }, { k: 'date', t: 'date' }, { k: 'ref', t: 'text', max: 80 }, { k: 'holder', t: 'text', max: 120 },
    { k: 'shares', t: 'int', min: 0, max: 1e12 }, { k: 'detail', t: 'text', max: 2000 }],
  decorate: async (req, rows) => rows.map((r) => ({ ...r, _view: { ...W.camelRow(r), kindLabel: KIND_LABEL[r.kind] } })) });

router.get('/registers-summary', mgr, async (req, res) => {
  const partners = await db.prepare("SELECT holder, SUM(shares) s FROM legal_registers WHERE org_id = ? AND kind = 'associe' GROUP BY holder ORDER BY SUM(shares) DESC").all(req.org.id);
  const total = partners.reduce((a, p) => a + Number(p.s), 0);
  const last = async (kind) => (await db.prepare('SELECT title, date FROM legal_registers WHERE org_id = ? AND kind = ? ORDER BY date DESC, id DESC LIMIT 1').get(req.org.id, kind)) || null;
  res.json({ partners: partners.map((p) => ({ holder: p.holder || '—', shares: Number(p.s), percent: total ? Math.round((1000 * Number(p.s)) / total) / 10 : 0 })), totalShares: total, lastAg: await last('ag'), lastPv: await last('pv'), statutes: await last('statuts'), rccm: await last('rccm'),
    note: "Registre de travail : la tenue légale des registres (formes, signatures, dépôts) est à faire valider par un juriste ou le greffe." });
});

// ---------- Calendrier de conformité ----------
const REC = ['once', 'monthly', 'quarterly', 'annual'];
const step = (d, rec) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCMonth(x.getUTCMonth() + (rec === 'monthly' ? 1 : rec === 'quarterly' ? 3 : 12)); return x.toISOString().slice(0, 10); };
W.crud(router, { path: '/compliance', table: 'legal_compliance', entity: 'legal_compliance', read: 'manager', write: 'admin', order: "status, COALESCE(due_date, '9999-12-31'), id", filters: ['status', 'category'],
  fields: [{ k: 'title', t: 'text', max: 200, req: true, msg: "Indiquez l'obligation." }, { k: 'category', t: 'text', max: 60 }, { k: 'dueDate', t: 'date' }, { k: 'recurrence', t: 'enum', opts: REC, def: 'once' }, { k: 'status', t: 'enum', opts: ['todo', 'done'], def: 'todo' }, { k: 'note', t: 'text', max: 500 }, { k: 'verify', t: 'bool' }],
  decorate: async (req, rows) => rows.map((r) => ({ ...r, _view: { ...W.camelRow(r), verify: Boolean(Number(r.verify)), late: r.status === 'todo' && Boolean(r.due_date) && r.due_date < W.today() } })) });

/** Exemples pour le Cameroun : échéances indicatives, TOUTES à vérifier auprès d'un expert avant usage. */
function examples(year) {
  const nextMonth15 = (() => { const d = new Date(); d.setUTCDate(15); if (W.today() > d.toISOString().slice(0, 10)) d.setUTCMonth(d.getUTCMonth() + 1); return d.toISOString().slice(0, 10); })();
  const ann = (m, d) => { const s = `${year}-${m}-${d}`; return s < W.today() ? `${year + 1}-${m}-${d}` : s; };
  return [
    ['Déclaration mensuelle des impôts et taxes (TVA, acomptes)', 'Fiscal', nextMonth15, 'monthly', "Échéance habituelle vers le 15 du mois suivant : à vérifier auprès de l'administration fiscale."],
    ['Déclaration et paiement des cotisations CNPS', 'Social', nextMonth15, 'monthly', 'Échéance habituelle vers le 15 du mois suivant : à vérifier auprès de la CNPS.'],
    ['Dépôt des états financiers annuels (DSF)', 'Fiscal', ann('03', '15'), 'annual', "Date indicative : le régime et la date dépendent de votre situation, à vérifier."],
    ["Assemblée générale d'approbation des comptes", 'Société', ann('06', '30'), 'annual', "Usuellement dans les 6 mois suivant la clôture de l'exercice (droit OHADA) : à vérifier selon votre forme sociale."],
    ['Renouvellement de la patente / licence', 'Fiscal', ann('03', '31'), 'annual', 'Date indicative : à vérifier auprès de votre centre des impôts.'],
    ['Mise à jour du RCCM après tout changement (dirigeant, siège, objet)', 'Société', null, 'once', 'À faire à chaque modification : délais à vérifier auprès du greffe.'],
  ];
}
router.post('/compliance/seed', adm, async (req, res) => {
  let n = 0;
  for (const [title, category, due, rec, note] of examples(new Date().getUTCFullYear())) {
    if (await db.prepare('SELECT 1 FROM legal_compliance WHERE org_id = ? AND title = ?').get(req.org.id, title)) continue;
    await db.prepare("INSERT INTO legal_compliance (org_id, title, category, due_date, recurrence, status, note, source, verify, created_at) VALUES (?, ?, ?, ?, ?, 'todo', ?, 'exemple', 1, ?)").run(req.org.id, title, category, due, rec, note, nowISO());
    n++;
  }
  await W.audit(req, 'legal_compliance', null, 'seed', null, { added: n });
  res.json({ added: n, note: 'Exemples pour le Cameroun, étiquetés « à vérifier » : modifiez-les ou supprimez-les.' });
});
router.post('/compliance/:id/done', adm, async (req, res) => {
  const c = await db.prepare('SELECT * FROM legal_compliance WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!c) throw new HttpError(404, 'Obligation introuvable.');
  if (c.recurrence === 'once' || !c.due_date) await db.prepare("UPDATE legal_compliance SET status = 'done' WHERE id = ?").run(c.id);
  else { let next = step(c.due_date, c.recurrence); let g = 0; while (next <= W.today() && g++ < 24) next = step(next, c.recurrence); await db.prepare("UPDATE legal_compliance SET due_date = ?, status = 'todo' WHERE id = ?").run(next, c.id); }
  await W.audit(req, 'legal_compliance', c.id, 'done', { status: c.status, dueDate: c.due_date }, { done: true });
  res.json({ ok: true });
});

/** Alertes : obligations non faites échues ou à moins de 30 jours. */
async function alertItems(req) {
  const lim = W.addDays(W.today(), 30);
  const rows = await db.prepare("SELECT * FROM legal_compliance WHERE org_id = ? AND status = 'todo' AND due_date IS NOT NULL AND due_date <= ? ORDER BY due_date LIMIT 20").all(req.org.id, lim);
  return rows.map((r) => ({ title: r.title, due: r.due_date, late: r.due_date < W.today(), verify: Boolean(Number(r.verify)) }));
}

module.exports = router;
module.exports.alertItems = alertItems;
