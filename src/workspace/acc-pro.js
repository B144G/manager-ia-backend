'use strict';
// Comptabilité pro (1/4) : comptabilité analytique par sections (projet, antenne, activité), modèles de saisie guidée, écritures récurrentes
// et exports CSV (balance, grand livre, états, journal centralisateur). Toutes les écritures passent par accounting.post() / recordEntry() :
// équilibre, verrouillage des périodes et idempotence restent garantis. Réservé aux administrateurs (le routeur parent l'impose déjà).
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const { PLAN, JOURNALS } = require('./syscohada');
const { HttpError } = require('../util');
const L = require('./acc-pro-lib');

const router = express.Router({ mergeParams: true });
const accounting = () => require('./accounting'); // require paresseux (évite toute dépendance circulaire)

// ======================= 1. Comptabilité analytique =======================
const KINDS = ['project', 'branch', 'custom'];
const CODE_RE = /^[A-Za-z0-9-]{2,20}$/;
const secView = (s, used) => ({ id: Number(s.id), code: s.code, label: s.label, kind: s.kind, active: Boolean(s.active), used: Number(used || 0) });

router.get('/analytics/sections', async (req, res) => {
  const rows = await db.prepare(`SELECT s.*, (SELECT COUNT(*) FROM acc_lines l WHERE l.org_id = s.org_id AND l.section = s.code) AS used FROM acc_sections s WHERE s.org_id = ? ORDER BY s.kind, s.code`).all(req.org.id);
  res.json({ sections: rows.map((s) => secView(s, s.used)) });
});
router.post('/analytics/sections', async (req, res) => {
  const b = req.body || {};
  const code = String(b.code || '').trim();
  if (!CODE_RE.test(code)) throw new HttpError(400, 'Le code de la section comporte 2 à 20 caractères : lettres, chiffres ou tiret.');
  const label = A.text(b.label, 120, { required: true, msg: 'Indiquez le nom de la section.' });
  const kind = A.oneOf(b.kind, KINDS, 'custom', 'Type de section : projet, antenne ou personnalisé.');
  if (await db.prepare('SELECT 1 FROM acc_sections WHERE org_id = ? AND UPPER(code) = UPPER(?)').get(req.org.id, code)) throw new HttpError(409, 'Ce code de section existe déjà.');
  const id = (await db.prepare('INSERT INTO acc_sections (org_id, code, label, kind, active, created_at) VALUES (?, ?, ?, ?, 1, ?)').run(req.org.id, code, label, kind, nowISO())).lastInsertRowid;
  await A.logActivity(req.org.id, req.user.id, 'accounting', `Section analytique ${code} créée`);
  res.status(201).json({ id: Number(id) });
});
router.post('/analytics/sections/import', async (req, res) => {
  // Une section par projet et par antenne existants qui n'en ont pas encore (code PRJ-<id> / ANT-<id> : relancer ne crée rien de plus).
  let created = 0;
  const add = async (code, label, kind) => {
    if (await db.prepare('SELECT 1 FROM acc_sections WHERE org_id = ? AND code = ?').get(req.org.id, code)) return;
    await db.prepare('INSERT INTO acc_sections (org_id, code, label, kind, active, created_at) VALUES (?, ?, ?, ?, 1, ?)').run(req.org.id, code, label.slice(0, 120), kind, nowISO());
    created++;
  };
  for (const p of await db.prepare('SELECT id, name FROM projects WHERE org_id = ? ORDER BY id').all(req.org.id)) await add(`PRJ-${p.id}`, p.name, 'project');
  for (const br of await db.prepare('SELECT id, name FROM branches WHERE org_id = ? ORDER BY id').all(req.org.id)) await add(`ANT-${br.id}`, br.name, 'branch');
  if (created) await A.logActivity(req.org.id, req.user.id, 'accounting', `${created} section(s) analytique(s) importée(s)`);
  res.json({ created });
});
router.put('/analytics/sections/:id', async (req, res) => {
  const b = req.body || {};
  const s = await db.prepare('SELECT * FROM acc_sections WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!s) throw new HttpError(404, 'Section introuvable.');
  const label = b.label === undefined ? s.label : A.text(b.label, 120, { required: true, msg: 'Indiquez le nom de la section.' });
  const active = b.active === undefined ? s.active : (b.active ? 1 : 0);
  await db.prepare('UPDATE acc_sections SET label = ?, active = ? WHERE id = ?').run(label, active, s.id);
  res.json({ ok: true });
});
// Une section déjà utilisée par des écritures ne se supprime pas (traçabilité) : on la désactive. Une section jamais utilisée peut être supprimée.
router.delete('/analytics/sections/:id', async (req, res) => {
  const s = await db.prepare('SELECT * FROM acc_sections WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!s) throw new HttpError(404, 'Section introuvable.');
  if ((await db.prepare('SELECT COUNT(*) c FROM acc_lines WHERE org_id = ? AND section = ?').get(req.org.id, s.code)).c) throw new HttpError(400, 'Cette section est utilisée par des écritures : désactivez-la plutôt que de la supprimer.');
  if ((await db.prepare("SELECT COUNT(*) c FROM acc_recurring WHERE org_id = ? AND section = ?").get(req.org.id, s.code)).c) throw new HttpError(400, 'Cette section est utilisée par une écriture récurrente : désactivez-la plutôt que de la supprimer.');
  await db.prepare('DELETE FROM acc_sections WHERE id = ?').run(s.id);
  res.json({ ok: true });
});

/** Lignes de produits et de charges d'une année, groupées par section et par compte (hors écriture de clôture du résultat). */
async function sectionRows(orgId, year) {
  return (await db.prepare(`SELECT l.section, l.account, SUM(l.debit) AS debit, SUM(l.credit) AS credit FROM acc_lines l JOIN acc_entries e ON e.id = l.entry_id
    WHERE l.org_id = ? AND e.date >= ? AND e.date <= ? AND ${L.NOT_CLOSE} GROUP BY l.section, l.account`).all(orgId, `${year}-01-01`, `${year}-12-31`)).map((r) => ({ section: r.section, account: r.account, debit: Number(r.debit), credit: Number(r.credit) }));
}
router.get('/analytics/report', async (req, res) => {
  const year = L.yearOf(req.query.year);
  const secs = await db.prepare('SELECT * FROM acc_sections WHERE org_id = ? ORDER BY kind, code').all(req.org.id);
  const by = new Map(); const zero = () => ({ produits: 0, charges: 0 });
  for (const r of await sectionRows(req.org.id, year)) {
    if (!by.has(r.section)) by.set(r.section, zero());
    const t = by.get(r.section);
    if (L.isProduit(r.account)) t.produits += r.credit - r.debit;
    else if (L.isCharge(r.account)) t.charges += r.debit - r.credit;
  }
  const known = new Set(secs.map((s) => s.code));
  const sections = secs.map((s) => {
    const t = by.get(s.code) || zero(); const resultat = t.produits - t.charges;
    return { code: s.code, label: s.label, kind: s.kind, produits: t.produits, charges: t.charges, resultat, margePct: t.produits > 0 ? Math.round((resultat / t.produits) * 1000) / 10 : null };
  });
  const nv = zero();
  for (const [code, t] of by) if (!code || !known.has(code)) { nv.produits += t.produits; nv.charges += t.charges; }
  const total = { produits: nv.produits + sections.reduce((a, s) => a + s.produits, 0), charges: nv.charges + sections.reduce((a, s) => a + s.charges, 0) };
  res.json({ year: Number(year), sections,
    nonVentile: { produits: nv.produits, charges: nv.charges, resultat: nv.produits - nv.charges },
    total: { produits: total.produits, charges: total.charges, resultat: total.produits - total.charges } });
});
router.get('/analytics/report/:code/lines', async (req, res) => {
  const year = L.yearOf(req.query.year);
  const s = await db.prepare('SELECT * FROM acc_sections WHERE org_id = ? AND code = ?').get(req.org.id, String(req.params.code));
  if (!s) throw new HttpError(404, 'Section introuvable.');
  const rows = await db.prepare(`SELECT e.id AS entry_id, e.number, e.date, e.label, e.journal, l.account, a.label AS account_label, l.debit, l.credit FROM acc_lines l JOIN acc_entries e ON e.id = l.entry_id
    LEFT JOIN acc_accounts a ON a.org_id = l.org_id AND a.code = l.account WHERE l.org_id = ? AND l.section = ? AND e.date >= ? AND e.date <= ? AND ${L.NOT_CLOSE} ORDER BY e.date, e.id, l.id`).all(req.org.id, s.code, `${year}-01-01`, `${year}-12-31`);
  const lines = rows.map((r) => ({ entryId: Number(r.entry_id), number: r.number, date: r.date, label: r.label, journal: r.journal, account: r.account, accountLabel: r.account_label || '', debit: Number(r.debit), credit: Number(r.credit) }));
  res.json({ code: s.code, label: s.label, kind: s.kind, year: Number(year), lines, totalDebit: lines.reduce((a, x) => a + x.debit, 0), totalCredit: lines.reduce((a, x) => a + x.credit, 0) });
});

// ======================= 2. Modèles de saisie guidée =======================
const MODES = { cash: ['571', 'CA', 'espèces'], bank: ['521', 'BQ', 'banque'], momo: ['589', 'MM', 'mobile money'] };
const MODE_KEY = { 'espèces': 'cash', banque: 'bank', 'mobile money': 'momo' };
const ALIAS = { supplier: 'à crédit', credit: 'à crédit', cash: 'espèces', bank: 'banque', momo: 'mobile money', goods: 'marchandises' }; // clés techniques acceptées aussi
const split = (ttc, rate) => { const ht = rate > 0 ? Math.round(ttc / (1 + rate / 100)) : ttc; return { ht, tva: ttc - ht }; };
const T = []; // modèles : { id, label, journal, hint, amountLabel, fields, build(ctx) }
const tpl = (t) => T.push({ amountLabel: 'Montant', fields: [], ...t });
const perMode = (base, label, hint, amountLabel, modes, build, fields) => {
  for (const m of modes) tpl({ id: `${base}_${m}`, label: `${label} (${MODES[m][2]})`, journal: MODES[m][1], hint, amountLabel, fields: fields || [], build: (c) => build(c, MODES[m][0]) });
};
perMode('rent', 'Loyer payé', 'Charge de location (622) payée par le moyen choisi.', 'Montant du loyer', ['cash', 'bank', 'momo'],
  (c, t) => [{ account: '622', debit: c.amount }, { account: t, credit: c.amount }]);
perMode('salary', 'Salaire payé', 'Rémunération nette versée (661). Indiquez les charges sociales patronales si elles sont dues : elles vont en 664 contre la CNPS (431).', 'Salaire net payé', ['cash', 'bank', 'momo'],
  (c, t) => {
    const lines = [{ account: '661', debit: c.amount }];
    if (c.opts.charges > 0) lines.push({ account: '664', debit: c.opts.charges }, { account: '431', credit: c.opts.charges });
    lines.push({ account: t, credit: c.amount });
    return lines;
  }, [{ k: 'charges', label: 'Charges sociales patronales (facultatif)', type: 'amount' }]);
tpl({
  id: 'purchase_goods', label: 'Achat de marchandises avec TVA', journal: 'AC', amountLabel: 'Montant TTC', hint: 'Le montant est le TTC : la TVA récupérable (4452) est calculée avec le taux de vos réglages. Réglé comptant ou à crédit.',
  fields: [{ k: 'payment', label: 'Règlement', type: 'select', options: ['à crédit', 'espèces', 'banque', 'mobile money'] }],
  build: (c) => {
    const { ht, tva } = split(c.amount, c.vat); const cr = c.opts.payment === 'à crédit' ? '401' : MODES[MODE_KEY[c.opts.payment]][0];
    const lines = [{ account: '601', debit: ht }];
    if (tva > 0) lines.push({ account: '4452', debit: tva });
    lines.push({ account: cr, credit: c.amount });
    return lines;
  },
  defaults: { payment: 'à crédit' },
});
tpl({
  id: 'sale_cash', label: 'Vente au comptant', journal: 'VT', amountLabel: 'Montant TTC encaissé', hint: 'Le montant est le TTC encaissé : la TVA collectée est calculée avec le taux de vos réglages.',
  fields: [{ k: 'mode', label: 'Encaissement', type: 'select', options: ['espèces', 'banque', 'mobile money'] },
    { k: 'kind', label: 'Nature de la vente', type: 'select', options: ['marchandises', 'services'] }],
  build: (c) => {
    const { ht, tva } = split(c.amount, c.vat); const services = c.opts.kind === 'services';
    const lines = [{ account: MODES[MODE_KEY[c.opts.mode]][0], debit: c.amount }, { account: services ? '706' : '701', credit: ht }];
    if (tva > 0) lines.push({ account: services ? '4432' : '4431', credit: tva });
    return lines;
  },
  defaults: { mode: 'espèces', kind: 'marchandises' },
});
perMode('capital', 'Apport en capital', 'Apport des associés (101) reçu en banque ou en espèces.', "Montant de l'apport", ['bank', 'cash'],
  (c, t) => [{ account: t, debit: c.amount }, { account: '101', credit: c.amount }]);
tpl({
  id: 'loan_repayment', label: "Remboursement d'emprunt", journal: 'BQ', amountLabel: 'Capital remboursé', hint: "Capital remboursé (162) et, si vous l'indiquez, les intérêts (671). Le total est prélevé sur la banque.",
  fields: [{ k: 'interest', label: 'Intérêts (facultatif)', type: 'amount' }],
  build: (c) => {
    const lines = [{ account: '162', debit: c.amount }];
    if (c.opts.interest > 0) lines.push({ account: '671', debit: c.opts.interest });
    lines.push({ account: '521', credit: c.amount + (c.opts.interest || 0) });
    return lines;
  },
});
tpl({ id: 'bank_fees', label: 'Frais bancaires', journal: 'BQ', amountLabel: 'Montant des frais', hint: 'Frais et commissions prélevés par la banque (631).', build: (c) => [{ account: '631', debit: c.amount }, { account: '521', credit: c.amount }] });
tpl({ id: 'momo_fees', label: 'Frais de mobile money', journal: 'MM', amountLabel: 'Montant des frais', hint: 'Frais de transfert ou de retrait mobile money (631).', build: (c) => [{ account: '631', debit: c.amount }, { account: '589', credit: c.amount }] });
tpl({
  id: 'vat_settlement', label: 'Liquidation de la TVA du mois', journal: 'OD', amountLabel: 'TVA collectée', hint: "Solde la TVA collectée (4431) avec la TVA récupérable (4452) : la différence devient TVA due (4441) ou crédit de TVA (4449). Elle se règle ensuite avec « Paiement de la TVA ».",
  fields: [{ k: 'deductible', label: 'TVA récupérable du mois', type: 'amount' }],
  build: (c) => {
    const ded = c.opts.deductible || 0; const lines = [{ account: '4431', debit: c.amount }];
    if (ded > 0) lines.push({ account: '4452', credit: ded });
    if (c.amount > ded) lines.push({ account: '4441', credit: c.amount - ded });
    if (ded > c.amount) lines.push({ account: '4449', debit: ded - c.amount });
    return lines;
  },
});
tpl({ id: 'vat_payment', label: 'Paiement de la TVA', journal: 'BQ', amountLabel: 'TVA payée', hint: "Règlement à l'État de la TVA due (4441) par la banque.", build: (c) => [{ account: '4441', debit: c.amount }, { account: '521', credit: c.amount }] });
perMode('staff_advance', 'Avance au personnel', 'Avance ou acompte versé à un salarié (421), à retenir sur sa prochaine paie.', "Montant de l'avance", ['cash', 'bank', 'momo'],
  (c, t) => [{ account: '421', debit: c.amount }, { account: t, credit: c.amount }]);
tpl({ id: 'cash_deposit', label: 'Dépôt de caisse en banque', journal: 'BQ', amountLabel: 'Montant déposé', hint: 'Les espèces de la caisse (571) sont versées sur le compte bancaire (521).', build: (c) => [{ account: '521', debit: c.amount }, { account: '571', credit: c.amount }] });
tpl({ id: 'cash_withdrawal', label: 'Retrait de banque en caisse', journal: 'BQ', amountLabel: 'Montant retiré', hint: 'Les espèces retirées de la banque (521) alimentent la caisse (571).', build: (c) => [{ account: '571', debit: c.amount }, { account: '521', credit: c.amount }] });

const listView = (t) => ({ id: t.id, label: t.label, journal: t.journal, hint: t.hint, amountLabel: t.amountLabel, fields: t.fields });
router.get('/templates', (req, res) => res.json({ templates: T.map(listView) }));

/** Options du modèle : valeurs de listes contrôlées, montants entiers positifs ou nuls. */
function readOptions(t, raw) {
  const out = { ...(t.defaults || {}) }; const src = raw && typeof raw === 'object' ? raw : {};
  for (const f of t.fields) {
    const v = src[f.k];
    if (f.type === 'select') {
      const w = typeof v === 'string' ? (ALIAS[v.trim().toLowerCase()] || v.trim().toLowerCase()) : v;
      out[f.k] = A.oneOf(w, f.options, out[f.k] === undefined ? f.options[0] : out[f.k], `Choix non valide pour « ${f.label} ».`);
    } else if (f.type === 'amount') {
      out[f.k] = v === undefined || v === null || v === '' || Number(v) === 0 ? 0 : A.amount(v);
    } else out[f.k] = A.text(v, 120);
  }
  return out;
}
router.post('/entries/from-template', async (req, res) => {
  const b = req.body || {};
  const t = T.find((x) => x.id === b.template);
  if (!t) throw new HttpError(400, 'Modèle de saisie inconnu.');
  const amount = A.amount(b.amount);
  const opts = readOptions(t, b.options);
  const section = String(b.section || '').trim();
  if (section && !await db.prepare('SELECT 1 FROM acc_sections WHERE org_id = ? AND code = ?').get(req.org.id, section)) throw new HttpError(400, `Section analytique inconnue : ${section}.`);
  const lines = t.build({ amount, opts, vat: Number(req.acc.vat_rate) || 0 }).map((l) => ({ ...l, section: section && /^[678]/.test(l.account) ? section : '' }));
  const r = await accounting().recordEntry(req.org, req.user.id, { journal: t.journal, date: b.date, label: A.text(b.label, 200) || t.label, piece: b.piece, lines });
  await A.logActivity(req.org.id, req.user.id, 'accounting', `Écriture ${r.number} (modèle ${t.id})`);
  res.status(201).json({ id: r.id, number: r.number });
});

// ======================= 3. Écritures récurrentes =======================
const FREQ = { monthly: 1, quarterly: 3, yearly: 12 };
const FREQ_MSG = 'Fréquence : mensuelle (monthly), trimestrielle (quarterly) ou annuelle (yearly).';
const parseLines = (s) => { try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; } };
const SRC_BASE = 1000000;

/** Échéances du modèle jusqu'à `upTo` : { date, ym } (jour du mois borné à la fin du mois, jamais avant la date de début ni après la date de fin). */
function occurrences(r, upTo, max = 600) {
  const [sy, sm] = r.start_date.split('-').map(Number); const step = FREQ[r.frequency] || 1; const out = [];
  for (let k = 0; k < max; k++) {
    const t = sy * 12 + (sm - 1) + k * step; const y = Math.floor(t / 12); const m = (t % 12) + 1;
    const date = `${y}-${L.pad(m)}-${L.pad(Math.min(Number(r.day_of_month), L.lastDayOf(y, m)))}`;
    if (date > upTo || (r.end_date && date > r.end_date)) break;
    if (date < r.start_date) continue;
    out.push({ date, ym: y * 100 + m });
  }
  return out;
}
const generatedSet = async (orgId, id) => new Set((await db.prepare("SELECT source_id FROM acc_entries WHERE org_id = ? AND source = 'recurring' AND source_id >= ? AND source_id < ?").all(orgId, id * SRC_BASE, (id + 1) * SRC_BASE)).map((x) => Number(x.source_id)));

async function recurringView(r) {
  const done = await generatedSet(r.org_id, Number(r.id));
  const next = occurrences(r, '9999-12-31', 1200).find((o) => !done.has(Number(r.id) * SRC_BASE + o.ym));
  return { id: Number(r.id), label: r.label, journal: r.journal, frequency: r.frequency, dayOfMonth: Number(r.day_of_month), startDate: r.start_date, endDate: r.end_date || '', lines: parseLines(r.lines_json),
    section: r.section || '', active: Boolean(r.active), lastRun: r.last_run || '', nextDue: next ? next.date : '' };
}
/** Contrôle d'un modèle de récurrence (mêmes règles qu'une écriture manuelle) ; renvoie les champs prêts à enregistrer. */
async function readRecurring(req, b, cur) {
  const get = (k, d) => (b[k] === undefined ? d : b[k]);
  const label = A.text(get('label', cur && cur.label), 150, { required: true, msg: "Indiquez le libellé de l'écriture récurrente." });
  const journal = String(get('journal', cur && cur.journal) || '');
  if (!JOURNALS[journal]) throw new HttpError(400, 'Journal inconnu.');
  const frequency = A.oneOf(get('frequency', cur && cur.frequency), Object.keys(FREQ), cur ? cur.frequency : 'monthly', FREQ_MSG);
  const dom = Number(get('dayOfMonth', cur && cur.day_of_month));
  if (!Number.isInteger(dom) || dom < 1 || dom > 31) throw new HttpError(400, 'Le jour du mois est compris entre 1 et 31.');
  const start = get('startDate', cur && cur.start_date);
  if (!L.isDate(start)) throw new HttpError(400, 'Date de début invalide (AAAA-MM-JJ).');
  const endRaw = get('endDate', cur && cur.end_date);
  const end = endRaw ? String(endRaw) : null;
  if (end && !L.isDate(end)) throw new HttpError(400, 'Date de fin invalide (AAAA-MM-JJ).');
  if (end && end < start) throw new HttpError(400, 'La date de fin précède la date de début.');
  const section = String(get('section', cur && cur.section) || '').trim();
  if (section && !await db.prepare('SELECT 1 FROM acc_sections WHERE org_id = ? AND code = ?').get(req.org.id, section)) throw new HttpError(400, `Section analytique inconnue : ${section}.`);
  const rawLines = b.lines === undefined ? parseLines(cur && cur.lines_json) : b.lines;
  if (!Array.isArray(rawLines) || rawLines.length < 2 || rawLines.length > 50) throw new HttpError(400, 'Une écriture comporte au moins deux lignes.');
  const std = new Map(PLAN); let d = 0; let c = 0;
  const lines = [];
  for (const l of rawLines) {
    const debit = L.int((l && l.debit) || 0); const credit = L.int((l && l.credit) || 0);
    if (Number.isNaN(debit) || Number.isNaN(credit) || debit < 0 || credit < 0) throw new HttpError(400, 'Montants invalides.');
    if ((debit > 0) === (credit > 0)) throw new HttpError(400, 'Chaque ligne a un montant au débit OU au crédit (pas les deux, pas aucun).');
    const account = String((l && l.account) || '').trim();
    if (!(std.has(account) || await db.prepare('SELECT 1 FROM acc_accounts WHERE org_id = ? AND code = ?').get(req.org.id, account))) throw new HttpError(400, `Compte inconnu : ${account || '(vide)'}.`);
    const ls = String((l && l.section) || '').trim();
    if (ls && !await db.prepare('SELECT 1 FROM acc_sections WHERE org_id = ? AND code = ?').get(req.org.id, ls)) throw new HttpError(400, `Section analytique inconnue : ${ls}.`);
    d += debit; c += credit;
    lines.push({ account, debit, credit, memo: A.text(l && l.memo, 120), section: ls });
  }
  if (d !== c) throw new HttpError(400, `L'écriture n'est pas équilibrée : débit ${L.fmt(d)} ≠ crédit ${L.fmt(c)}.`);
  if (d === 0) throw new HttpError(400, 'Le montant ne peut pas être nul.');
  return { label, journal, frequency, dom, start, end, section, lines, active: b.active === undefined ? (cur ? cur.active : 1) : (b.active ? 1 : 0) };
}

router.get('/recurring', async (req, res) => {
  const rows = await db.prepare('SELECT * FROM acc_recurring WHERE org_id = ? ORDER BY id').all(req.org.id);
  const items = []; for (const r of rows) items.push(await recurringView(r));
  res.json({ items });
});
router.post('/recurring', async (req, res) => {
  const v = await readRecurring(req, req.body || {}, null);
  const id = (await db.prepare('INSERT INTO acc_recurring (org_id, label, journal, frequency, day_of_month, start_date, end_date, lines_json, section, active, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(req.org.id, v.label, v.journal, v.frequency, v.dom, v.start, v.end, JSON.stringify(v.lines), v.section, v.active, req.user.id, nowISO())).lastInsertRowid;
  await A.logActivity(req.org.id, req.user.id, 'accounting', `Écriture récurrente « ${v.label} » créée`);
  res.status(201).json({ id: Number(id) });
});
router.put('/recurring/:id', async (req, res) => {
  const cur = await db.prepare('SELECT * FROM acc_recurring WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!cur) throw new HttpError(404, 'Écriture récurrente introuvable.');
  const v = await readRecurring(req, req.body || {}, cur);
  await db.prepare('UPDATE acc_recurring SET label = ?, journal = ?, frequency = ?, day_of_month = ?, start_date = ?, end_date = ?, lines_json = ?, section = ?, active = ? WHERE id = ?')
    .run(v.label, v.journal, v.frequency, v.dom, v.start, v.end, JSON.stringify(v.lines), v.section, v.active, cur.id);
  res.json({ ok: true });
});
// Supprime le modèle seulement : les écritures déjà passées restent (et gardent leur référence au modèle).
router.delete('/recurring/:id', async (req, res) => {
  const cur = await db.prepare('SELECT * FROM acc_recurring WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!cur) throw new HttpError(404, 'Écriture récurrente introuvable.');
  await db.prepare('DELETE FROM acc_recurring WHERE id = ?').run(cur.id);
  await A.logActivity(req.org.id, req.user.id, 'accounting', `Écriture récurrente « ${cur.label} » supprimée`);
  res.json({ ok: true });
});
// Génère toutes les échéances dues jusqu'à `upTo`, une écriture par échéance. Idempotent : source « recurring », source_id = modèle × 1 000 000 + AAAAMM.
router.post('/recurring/run', async (req, res) => {
  const upTo = (req.body || {}).upTo === undefined || (req.body || {}).upTo === '' ? L.today() : String((req.body || {}).upTo);
  if (!L.isDate(upTo)) throw new HttpError(400, 'Date invalide (AAAA-MM-JJ).');
  const out = { created: 0, skipped: [] };
  for (const r of await db.prepare('SELECT * FROM acc_recurring WHERE org_id = ? AND active = 1 ORDER BY id').all(req.org.id)) {
    const done = await generatedSet(req.org.id, Number(r.id)); const lines = parseLines(r.lines_json); let last = null;
    for (const o of occurrences(r, upTo)) {
      const sid = Number(r.id) * SRC_BASE + o.ym;
      if (done.has(sid)) continue; // déjà passée (même annulée depuis) : jamais de doublon
      try {
        await accounting().recordEntry(req.org, req.user.id, { journal: r.journal, date: o.date, label: `${r.label} ${o.date.slice(0, 7)}`.slice(0, 200), piece: `REC-${r.id}`,
          lines: lines.map((l) => ({ ...l, section: l.section || (r.section && /^[678]/.test(l.account) ? r.section : '') })), source: 'recurring', sourceId: sid });
        out.created++; last = o.date;
      } catch (e) {
        if (!(e instanceof HttpError)) throw e;
        out.skipped.push(`${r.label} (${o.date.slice(0, 7)}) : ${e.message}`);
      }
    }
    if (last) await db.prepare('UPDATE acc_recurring SET last_run = ? WHERE id = ?').run(last, r.id);
  }
  if (out.created) await A.logActivity(req.org.id, req.user.id, 'accounting', `Écritures récurrentes : ${out.created} générée(s)`);
  res.json(out);
});

// ======================= 7. Exports CSV =======================
router.get('/export/balance.csv', async (req, res) => {
  const year = L.yearOf(req.query.year);
  const rows = await accounting().balance(req.org, `${year}-01-01`, `${year}-12-31`);
  L.sendCsv(res, `balance-${year}.csv`, ['compte', 'intitule', 'debit', 'credit', 'solde_debiteur', 'solde_crediteur'],
    rows.map((r) => [r.account, r.label, r.debit, r.credit, Math.max(r.balance, 0), Math.max(-r.balance, 0)]));
});
router.get('/export/ledger.csv', async (req, res) => {
  const year = L.yearOf(req.query.year); const account = String(req.query.account || '');
  const acc = await db.prepare('SELECT label FROM acc_accounts WHERE org_id = ? AND code = ?').get(req.org.id, account);
  if (!acc) throw new HttpError(404, 'Compte inconnu.');
  const rows = await db.prepare(`SELECT e.date, e.journal, e.number, e.piece, e.label, l.debit, l.credit FROM acc_lines l JOIN acc_entries e ON e.id = l.entry_id WHERE l.org_id = ? AND l.account = ? AND e.date >= ? AND e.date <= ? ORDER BY e.date, e.id, l.id`)
    .all(req.org.id, account, `${year}-01-01`, `${year}-12-31`);
  let run = 0;
  L.sendCsv(res, `grand-livre-${account}-${year}.csv`, ['date', 'journal', 'numero', 'piece', 'libelle', 'debit', 'credit', 'solde'],
    rows.map((r) => { run += Number(r.debit) - Number(r.credit); return [r.date, r.journal, r.number, r.piece, r.label, Number(r.debit), Number(r.credit), run]; }));
});
router.get('/export/statements.csv', async (req, res) => {
  const year = L.yearOf(req.query.year); const s = await accounting().statements(req.org, year);
  const rows = [];
  for (const r of s.resultat.produits) rows.push(['compte_de_resultat', 'produits', r.account, r.label, r.amount]);
  rows.push(['compte_de_resultat', 'total_produits', '', 'Total des produits', s.resultat.totalProduits]);
  for (const r of s.resultat.charges) rows.push(['compte_de_resultat', 'charges', r.account, r.label, r.amount]);
  rows.push(['compte_de_resultat', 'total_charges', '', 'Total des charges', s.resultat.totalCharges], ['compte_de_resultat', 'resultat', '', 'Résultat net', s.resultat.resultat]);
  for (const r of s.bilan.actif) rows.push(['bilan', 'actif', r.account, r.label, r.amount]);
  rows.push(['bilan', 'total_actif', '', "Total de l'actif", s.bilan.totalActif]);
  for (const r of s.bilan.passif) rows.push(['bilan', 'passif', r.account, r.label, r.amount]);
  rows.push(['bilan', 'resultat', '', "Résultat de l'exercice", s.bilan.resultat], ['bilan', 'total_passif', '', 'Total du passif', s.bilan.totalPassif]);
  L.sendCsv(res, `etats-${year}.csv`, ['etat', 'rubrique', 'compte', 'intitule', 'montant'], rows);
});
router.get('/export/journal-centralisateur.csv', async (req, res) => {
  const year = L.yearOf(req.query.year);
  const rows = await db.prepare(`SELECT e.journal, substr(e.date, 1, 7) AS month, COUNT(DISTINCT e.id) AS n, SUM(l.debit) AS d, SUM(l.credit) AS c FROM acc_lines l JOIN acc_entries e ON e.id = l.entry_id
    WHERE l.org_id = ? AND e.date >= ? AND e.date <= ? GROUP BY e.journal, substr(e.date, 1, 7) ORDER BY e.journal, substr(e.date, 1, 7)`).all(req.org.id, `${year}-01-01`, `${year}-12-31`);
  const out = rows.map((r) => [r.journal, JOURNALS[r.journal] || r.journal, r.month, Number(r.n), Number(r.d), Number(r.c)]);
  out.push(['TOTAL', '', '', rows.reduce((a, r) => a + Number(r.n), 0), rows.reduce((a, r) => a + Number(r.d), 0), rows.reduce((a, r) => a + Number(r.c), 0)]);
  L.sendCsv(res, `journal-centralisateur-${year}.csv`, ['journal', 'intitule_journal', 'mois', 'nb_ecritures', 'debit', 'credit'], out);
});

module.exports = router;
module.exports.TEMPLATES = T;
module.exports.occurrences = occurrences;
