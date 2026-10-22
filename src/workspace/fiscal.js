'use strict';
// Sous-application « Fiscalité et liasse » (administrateurs et propriétaire) : document de travail de fin d'exercice (bilan, compte de résultat,
// soldes intermédiaires de gestion) calculé à partir des écritures de la comptabilité, contrôles de cohérence, calendrier fiscal paramétrable
// et estimation de la TVA du mois. Ce n'est PAS la liasse officielle : le format dépend du pays et le document doit être validé par un expert-comptable.
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const { HttpError } = require('../util');

const router = express.Router({ mergeParams: true });
router.use(A.need('admin'));

const NOTICE = "Document de travail préparé par MANAGER-IA, à faire valider par un expert-comptable avant tout dépôt officiel.";
const KINDS = { tva: 'TVA', acompte: 'Acompte', is: 'Impôt sur les sociétés ou sur le revenu', patente: 'Patente', social: 'Déclaration sociale', etats: 'Dépôt des états financiers', other: 'Autre' };
const STATUSES = { todo: 'À faire', filed: 'Déposée', paid: 'Payée' };
const RECUR = { none: 'Une seule fois', monthly: 'Chaque mois', quarterly: 'Chaque trimestre', yearly: 'Chaque année' };
const today = () => nowISO().slice(0, 10);

// ---------- Dates ----------
const pad = (n) => String(n).padStart(2, '0');
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m = 1..12
/** Ajoute des mois à une date AAAA-MM-JJ en gardant le jour quand c'est possible (31 janvier + 1 mois = fin février). */
function addMonths(d, n) {
  const [y, m, day] = d.split('-').map(Number);
  const t = (y * 12 + (m - 1)) + n;
  const ny = Math.floor(t / 12); const nm = (t % 12) + 1;
  return `${ny}-${pad(nm)}-${pad(Math.min(day, lastDay(ny, nm)))}`;
}
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const nextAnnual = (md, from) => { const y = Number(from.slice(0, 4)); const c = `${y}-${md}`; return c >= from ? c : `${y + 1}-${md}`; };
const nextMonthly = (day, from) => { const [y, m] = from.split('-').map(Number); const c = `${y}-${pad(m)}-${pad(Math.min(day, lastDay(y, m)))}`; return c >= from ? c : addMonths(c, 1); };

/** Modèles d'exemple : ils ne sont PAS des règles officielles. Chaque pays, régime et entreprise a ses propres échéances. */
function templates() {
  const t = today();
  const base = [
    { key: 'tva', title: 'Déclaration et paiement de la TVA', kind: 'tva', recurrence: 'monthly', due: nextMonthly(15, t), period: 'mois précédent' },
    { key: 'acompte', title: 'Acompte d\'impôt', kind: 'acompte', recurrence: 'monthly', due: nextMonthly(15, t), period: 'mois précédent' },
    { key: 'social', title: 'Déclaration et versement des cotisations sociales', kind: 'social', recurrence: 'monthly', due: nextMonthly(15, t), period: 'mois précédent' },
    { key: 'is', title: 'Impôt sur les sociétés / sur le revenu', kind: 'is', recurrence: 'yearly', due: nextAnnual('04-30', t), period: 'exercice' },
    { key: 'patente', title: 'Patente (contribution des patentes)', kind: 'patente', recurrence: 'yearly', due: nextAnnual('03-31', t), period: 'année' },
    { key: 'etats', title: 'Dépôt des états financiers', kind: 'etats', recurrence: 'yearly', due: nextAnnual('04-30', t), period: 'exercice' },
  ];
  return base.map((x) => ({ ...x, kindLabel: KINDS[x.kind], note: 'Exemple à confirmer : vérifiez la date et la règle auprès de votre administration ou de votre expert-comptable.' }));
}

const view = (o, t) => ({
  id: o.id, title: o.title, kind: o.kind, kindLabel: KINDS[o.kind] || '', period: o.period, dueDate: o.due_date, status: o.status, statusLabel: STATUSES[o.status],
  amount: o.amount, reference: o.reference, note: o.note, recurrence: o.recurrence, doneDate: o.done_date,
  late: o.status === 'todo' && o.due_date < t, soon: o.status === 'todo' && o.due_date >= t && o.due_date <= addDays(t, 7),
});

const obOf = async (req, id) => {
  const o = await db.prepare('SELECT * FROM fiscal_obligations WHERE id = ? AND org_id = ?').get(A.id(id), req.org.id);
  if (!o) throw new HttpError(404, 'Échéance introuvable.');
  return o;
};

async function obligations(orgId) {
  const t = today();
  const rows = (await db.prepare("SELECT * FROM fiscal_obligations WHERE org_id = ? ORDER BY CASE status WHEN 'todo' THEN 0 ELSE 1 END, due_date, id").all(orgId)).map((o) => view(o, t));
  const open = rows.filter((o) => o.status === 'todo');
  return { today: t, items: rows, late: rows.filter((o) => o.late), soon: rows.filter((o) => o.soon), pendingAmount: open.reduce((a, o) => a + o.amount, 0) };
}

const MAXAMT = 1e12;
function fields(b, cur) {
  const c = cur || {};
  const status = b.status === undefined ? (c.status || 'todo') : A.oneOf(b.status, Object.keys(STATUSES), undefined, 'Statut inconnu.');
  const amount = b.amount === undefined ? (c.amount || 0) : (b.amount === null || b.amount === '' || Number(b.amount) === 0 ? 0 : A.amount(b.amount));
  if (amount > MAXAMT) throw new HttpError(400, 'Montant trop élevé.');
  const due = b.dueDate === undefined ? c.due_date : A.date(b.dueDate);
  if (!due) throw new HttpError(400, "Indiquez la date d'échéance.");
  return {
    title: b.title === undefined ? c.title : A.text(b.title, 120, { required: true, msg: "Indiquez le nom de l'obligation." }),
    kind: b.kind === undefined ? (c.kind || 'other') : A.oneOf(b.kind, Object.keys(KINDS), undefined, 'Type inconnu.'),
    period: b.period === undefined ? (c.period || '') : A.text(b.period, 40),
    due, status, amount,
    reference: b.reference === undefined ? (c.reference || '') : A.text(b.reference, 200),
    note: b.note === undefined ? (c.note || '') : A.text(b.note, 300),
    recurrence: b.recurrence === undefined ? (c.recurrence || 'none') : A.oneOf(b.recurrence, Object.keys(RECUR), undefined, 'Répétition inconnue.'),
  };
}

router.get('/obligations', async (req, res) => res.json({ ...(await obligations(req.org.id)), templates: templates(), kinds: KINDS, statuses: STATUSES, recurrences: RECUR }));

router.post('/obligations', async (req, res) => {
  const f = fields(req.body || {}, null);
  if (!f.title) throw new HttpError(400, "Indiquez le nom de l'obligation.");
  const id = (await db.prepare('INSERT INTO fiscal_obligations (org_id, title, kind, period, due_date, status, amount, reference, note, recurrence, done_date, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    req.org.id, f.title, f.kind, f.period, f.due, f.status, f.amount, f.reference, f.note, f.recurrence, f.status === 'todo' ? null : today(), req.user.id, nowISO())).lastInsertRowid;
  await A.logActivity(req.org.id, req.user.id, 'fiscal', `Échéance fiscale « ${f.title} » ajoutée`);
  res.status(201).json({ id: Number(id) });
});

router.put('/obligations/:id', async (req, res) => {
  const o = await obOf(req, req.params.id);
  const f = fields(req.body || {}, o);
  const done = f.status === 'todo' ? null : (o.status !== 'todo' && o.done_date ? o.done_date : today());
  await db.prepare('UPDATE fiscal_obligations SET title = ?, kind = ?, period = ?, due_date = ?, status = ?, amount = ?, reference = ?, note = ?, recurrence = ?, done_date = ? WHERE id = ?').run(
    f.title, f.kind, f.period, f.due, f.status, f.amount, f.reference, f.note, f.recurrence, done, o.id);
  res.json({ ok: true });
});

router.delete('/obligations/:id', async (req, res) => {
  const o = await obOf(req, req.params.id);
  await db.prepare('DELETE FROM fiscal_obligations WHERE id = ?').run(o.id);
  res.json({ ok: true });
});

// Crée l'échéance suivante d'une obligation récurrente (à faire, mêmes réglages, sans justificatif).
router.post('/obligations/:id/next', async (req, res) => {
  const o = await obOf(req, req.params.id);
  const step = { monthly: 1, quarterly: 3, yearly: 12 }[o.recurrence];
  if (!step) throw new HttpError(400, "Cette obligation n'est pas récurrente.");
  const due = addMonths(o.due_date, step);
  if (await db.prepare('SELECT 1 FROM fiscal_obligations WHERE org_id = ? AND title = ? AND due_date = ?').get(req.org.id, o.title, due)) throw new HttpError(409, "L'échéance suivante existe déjà.");
  const id = (await db.prepare("INSERT INTO fiscal_obligations (org_id, title, kind, period, due_date, status, amount, reference, note, recurrence, created_by, created_at) VALUES (?, ?, ?, '', ?, 'todo', ?, '', ?, ?, ?, ?)").run(
    req.org.id, o.title, o.kind, due, o.amount, o.note, o.recurrence, req.user.id, nowISO())).lastInsertRowid;
  res.status(201).json({ id: Number(id), dueDate: due });
});

// ---------- Comptabilité : états de fin d'exercice ----------
const accounting = () => require('./accounting'); // require paresseux (évite toute dépendance circulaire)

const yearOf = (v) => {
  const y = String(v || today().slice(0, 4));
  if (!/^\d{4}$/.test(y) || Number(y) < 2000 || Number(y) > 2100) throw new HttpError(400, 'Année invalide.');
  return y;
};
const pre = (a, list) => list.some((p) => a.startsWith(p));

/** Soldes intermédiaires de gestion (classement simplifié des comptes SYSCOHADA par leur numéro). Montants en « résultat positif = produit ». */
function sigOf(rows) {
  const v = { ventesMarch: 0, ventesProd: 0, prodAutre: 0, subv: 0, prodFin: 0, reprises: 0, autresProduits: 0, achatsMarch: 0, varStockMarch: 0, conso: 0, impots: 0, personnel: 0, chFin: 0, dotations: 0, autresCharges: 0, hao: 0, impotResultat: 0 };
  for (const r of rows) {
    const a = r.account; const b = r.balance; const c = a[0];
    if (c === '7') {
      if (a.startsWith('701')) v.ventesMarch -= b;
      else if (a.startsWith('70')) v.ventesProd -= b;
      else if (pre(a, ['72', '73'])) v.prodAutre -= b;
      else if (a.startsWith('71')) v.subv -= b;
      else if (a.startsWith('77')) v.prodFin -= b;
      else if (pre(a, ['78', '79'])) v.reprises -= b;
      else v.autresProduits -= b;
    } else if (c === '6') {
      if (a.startsWith('601')) v.achatsMarch += b;
      else if (a.startsWith('6031')) v.varStockMarch += b;
      else if (pre(a, ['60', '61', '62', '63'])) v.conso += b;
      else if (a.startsWith('64')) v.impots += b;
      else if (a.startsWith('66')) v.personnel += b;
      else if (a.startsWith('67')) v.chFin += b;
      else if (pre(a, ['68', '69'])) v.dotations += b;
      else v.autresCharges += b;
    } else if (c === '8') {
      if (a.startsWith('89')) v.impotResultat += b; else v.hao -= b;
    }
  }
  const margeCommerciale = v.ventesMarch - v.achatsMarch - v.varStockMarch;
  const production = v.ventesProd + v.prodAutre;
  const valeurAjoutee = margeCommerciale + production - v.conso;
  const excedentBrutExploitation = valeurAjoutee + v.subv - v.impots - v.personnel;
  const resultatExploitation = excedentBrutExploitation + v.autresProduits + v.reprises - v.autresCharges - v.dotations;
  const resultatFinancier = v.prodFin - v.chFin;
  const resultatActivitesOrdinaires = resultatExploitation + resultatFinancier;
  const resultatNet = resultatActivitesOrdinaires + v.hao - v.impotResultat;
  return {
    chiffreAffaires: v.ventesMarch + v.ventesProd,
    lines: [
      { key: 'ventesMarch', label: 'Ventes de marchandises', amount: v.ventesMarch },
      { key: 'achatsMarch', label: 'Achats de marchandises et variation de stock', amount: -(v.achatsMarch + v.varStockMarch) },
      { key: 'margeCommerciale', label: 'Marge commerciale', amount: margeCommerciale, total: true },
      { key: 'production', label: 'Production vendue et autre production', amount: production },
      { key: 'conso', label: 'Consommations (matières, transports, services extérieurs)', amount: -v.conso },
      { key: 'valeurAjoutee', label: 'Valeur ajoutée', amount: valeurAjoutee, total: true },
      { key: 'subv', label: "Subventions d'exploitation", amount: v.subv },
      { key: 'impots', label: 'Impôts et taxes', amount: -v.impots },
      { key: 'personnel', label: 'Charges de personnel', amount: -v.personnel },
      { key: 'excedentBrutExploitation', label: "Excédent brut d'exploitation", amount: excedentBrutExploitation, total: true },
      { key: 'autres', label: 'Autres produits, reprises, autres charges et dotations', amount: v.autresProduits + v.reprises - v.autresCharges - v.dotations },
      { key: 'resultatExploitation', label: "Résultat d'exploitation", amount: resultatExploitation, total: true },
      { key: 'resultatFinancier', label: 'Résultat financier', amount: resultatFinancier },
      { key: 'hao', label: 'Résultat hors activités ordinaires', amount: v.hao },
      { key: 'impotResultat', label: 'Impôts sur le résultat', amount: -v.impotResultat },
      { key: 'resultatNet', label: 'Résultat net', amount: resultatNet, total: true },
    ],
    margeCommerciale, valeurAjoutee, excedentBrutExploitation, resultatExploitation, resultatNet,
  };
}

/** Compte de résultat par compte (produits et charges) et bilan par grandes masses, calculés sur les écritures de l'exercice. */
function statementsOf(rows) {
  const net = (r) => r.balance;
  const produits = rows.filter((r) => r.account[0] === '7' || (r.account[0] === '8' && r.balance < 0)).map((r) => ({ account: r.account, label: r.label, amount: -r.balance }));
  const charges = rows.filter((r) => r.account[0] === '6' || (r.account[0] === '8' && r.balance >= 0)).map((r) => ({ account: r.account, label: r.label, amount: r.balance }));
  const totalProduits = produits.reduce((a, x) => a + x.amount, 0); const totalCharges = charges.reduce((a, x) => a + x.amount, 0);
  const resultat = -rows.filter((r) => '678'.includes(r.account[0])).reduce((a, r) => a + net(r), 0);

  const g = { immo: [], stocks: [], creances: [], treso: [], capitaux: [], dettesFin: [], dettesCirc: [], tresoPassif: [] };
  for (const r of rows) {
    const a = r.account; const b = r.balance; const c = a[0];
    const item = { account: a, label: r.label, amount: 0 };
    if (c === '2') g.immo.push({ ...item, amount: b });
    else if (c === '3') g.stocks.push({ ...item, amount: b });
    else if (c === '1') (pre(a, ['16', '17', '18', '19']) ? g.dettesFin : g.capitaux).push({ ...item, amount: -b });
    else if (c === '4') { if (a.startsWith('49')) g.creances.push({ ...item, amount: b }); else if (b >= 0) g.creances.push({ ...item, amount: b }); else g.dettesCirc.push({ ...item, amount: -b }); }
    else if (c === '5') { if (a.startsWith('59')) g.treso.push({ ...item, amount: b }); else if (b >= 0) g.treso.push({ ...item, amount: b }); else g.tresoPassif.push({ ...item, amount: -b }); }
  }
  const tot = (l) => l.reduce((a, x) => a + x.amount, 0);
  const actif = [['immo', 'Actif immobilisé (net)'], ['stocks', 'Stocks (net)'], ['creances', 'Créances et emplois assimilés'], ['treso', 'Trésorerie-actif']].map(([k, label]) => ({ key: k, label, amount: tot(g[k]), rows: g[k] }));
  const passif = [['capitaux', 'Capitaux propres (avant résultat)'], ['dettesFin', 'Dettes financières'], ['dettesCirc', 'Passif circulant'], ['tresoPassif', 'Trésorerie-passif']].map(([k, label]) => ({ key: k, label, amount: tot(g[k]), rows: g[k] }));
  passif.splice(1, 0, { key: 'resultat', label: "Résultat de l'exercice", amount: resultat, rows: [] });
  const totalActif = actif.reduce((a, x) => a + x.amount, 0); const totalPassif = passif.reduce((a, x) => a + x.amount, 0);
  return { resultat: { produits, charges, totalProduits, totalCharges, resultat }, bilan: { actif, passif, totalActif, totalPassif, equilibre: totalActif === totalPassif } };
}

async function liasse(req, year) {
  const from = `${year}-01-01`; const to = `${year}-12-31`;
  const rows = await accounting().balance(req.org, from, to);
  const st = statementsOf(rows); const sig = sigOf(rows);
  const issues = [];
  const add = (level, code, text, items) => issues.push({ level, code, text, items: items || [] });

  const tot = await db.prepare('SELECT COALESCE(SUM(l.debit),0) d, COALESCE(SUM(l.credit),0) c, COUNT(DISTINCT e.id) n FROM acc_lines l JOIN acc_entries e ON e.id = l.entry_id WHERE l.org_id = ? AND e.date >= ? AND e.date <= ?').get(req.org.id, from, to);
  if (!tot.n) add('error', 'no-entries', `Aucune écriture comptable sur l'exercice ${year} : les états sont vides. Enregistrez vos écritures dans le module Comptabilité.`);
  if (Number(tot.d) !== Number(tot.c)) add('error', 'balance', `Le total des débits (${Number(tot.d).toLocaleString('fr-FR')}) ne correspond pas au total des crédits (${Number(tot.c).toLocaleString('fr-FR')}).`);
  const bad = await db.prepare('SELECT e.number FROM acc_lines l JOIN acc_entries e ON e.id = l.entry_id WHERE l.org_id = ? AND e.date >= ? AND e.date <= ? GROUP BY e.id, e.number HAVING SUM(l.debit) <> SUM(l.credit) ORDER BY e.number LIMIT 10').all(req.org.id, from, to);
  if (bad.length) add('error', 'entry-unbalanced', `${bad.length} écriture(s) déséquilibrée(s) : corrigez-les par une écriture inverse puis une nouvelle écriture.`, bad.map((b) => b.number));
  const noAcc = await db.prepare("SELECT DISTINCT l.account FROM acc_lines l JOIN acc_entries e ON e.id = l.entry_id LEFT JOIN acc_accounts a ON a.org_id = l.org_id AND a.code = l.account WHERE l.org_id = ? AND e.date >= ? AND e.date <= ? AND (l.account = '' OR a.id IS NULL) ORDER BY l.account LIMIT 10").all(req.org.id, from, to);
  if (noAcc.length) add('error', 'no-account', `Des lignes d'écriture utilisent un compte absent du plan comptable (ou vide) : ${noAcc.length} compte(s).`, noAcc.map((x) => x.account || '(vide)'));
  const unclassified = rows.filter((r) => !/^[1-8]/.test(r.account));
  if (unclassified.length) add('error', 'unclassified', 'Des comptes ne sont rattachés à aucune classe (1 à 8) : ils sont exclus des états.', unclassified.slice(0, 10).map((r) => r.account));
  const unnamed = rows.filter((r) => /^[1-8]/.test(r.account) && !r.label);
  if (unnamed.length) add('warn', 'unnamed', 'Des comptes n\'ont pas de nom dans le plan comptable.', unnamed.slice(0, 10).map((r) => r.account));
  if (!st.bilan.equilibre) add('error', 'bilan', `Le bilan n'est pas équilibré (actif ${st.bilan.totalActif.toLocaleString('fr-FR')} contre passif ${st.bilan.totalPassif.toLocaleString('fr-FR')}).`);
  if (sig.resultatNet !== st.resultat.resultat) add('error', 'result-gap', 'Le résultat net des soldes de gestion ne correspond pas au résultat du compte de résultat.');
  if (tot.n && !rows.some((r) => r.account.startsWith('101'))) add('info', 'capital', "Aucune écriture sur le capital social (compte 101) cet exercice : normal si le capital a été constaté les années précédentes (les à-nouveaux ne sont pas reportés automatiquement).");
  if (tot.n) add('info', 'carry', "Les états reprennent uniquement les écritures datées de l'exercice : les soldes des exercices précédents (reports à nouveau, immobilisations anciennes) doivent avoir été passés en écritures d'ouverture.");
  const todo = issues.filter((i) => i.level !== 'info');
  return { year, notice: NOTICE, entryCount: Number(tot.n), resultat: st.resultat, bilan: st.bilan, sig, issues, toFix: todo.filter((i) => i.level === 'error').length, ready: !todo.some((i) => i.level === 'error') };
}

router.get('/liasse', async (req, res) => res.json(await liasse(req, yearOf(req.query.year))));

// TVA du mois : collectée (comptes 443) moins déductible (comptes 445), à partir des écritures.
async function vatMonth(req, monthParam) {
  const r = A.monthRange(monthParam);
  const [y, m] = r.month.split('-').map(Number);
  const to = `${r.month}-${pad(lastDay(y, m))}`;
  const rows = await accounting().balance(req.org, r.from, to);
  const col = rows.filter((x) => x.account.startsWith('443')); const ded = rows.filter((x) => x.account.startsWith('445'));
  const collected = -col.reduce((a, x) => a + x.balance, 0); const deductible = ded.reduce((a, x) => a + x.balance, 0);
  const missing = [];
  const planned = Number((await db.prepare('SELECT COUNT(*) c FROM acc_accounts WHERE org_id = ?').get(req.org.id)).c);
  const set = await db.prepare('SELECT vat_rate, purchase_vat FROM acc_settings WHERE org_id = ?').get(req.org.id);
  if (!planned) missing.push("Le plan comptable n'existe pas encore : ouvrez le module Comptabilité pour le créer, puis enregistrez vos écritures.");
  if (set && Number(set.vat_rate) === 0) missing.push('Le taux de TVA est à 0 % dans les réglages de la Comptabilité : aucune TVA n\'est séparée sur vos factures.');
  if (!col.length) missing.push(`Aucune TVA collectée (comptes 443) enregistrée en ${r.month} : vos factures du mois ne sont peut-être pas encore comptabilisées (Comptabilité, écritures automatiques).`);
  if (!ded.length) missing.push(`Aucune TVA déductible (comptes 445) enregistrée en ${r.month}${set && !set.purchase_vat ? ' : la TVA sur les achats n\'est pas activée dans les réglages de la Comptabilité' : ''}.`);
  return { month: r.month, collected, deductible, due: Math.max(collected - deductible, 0), credit: Math.max(deductible - collected, 0), available: col.length > 0 || ded.length > 0, missing, notice: 'Estimation à partir de vos écritures : à vérifier avant toute déclaration.' };
}
router.get('/vat', async (req, res) => res.json(await vatMonth(req, req.query.month)));

router.get('/', async (req, res) => {
  const year = yearOf(req.query.year);
  const l = await liasse(req, year);
  const o = await obligations(req.org.id);
  res.json({ year, notice: NOTICE, kpi: { resultat: l.resultat.resultat, chiffreAffaires: l.sig.chiffreAffaires, toFix: l.toFix, late: o.late.length, soon: o.soon.length }, late: o.late, soon: o.soon });
});

module.exports = router;
module.exports.sigOf = sigOf;
module.exports.addMonths = addMonths;
module.exports.NOTICE = NOTICE;

// Crochets lus par ai.js : ctx(req) = ce que l'IA voit (administrateurs seulement : aucun chiffre financier pour un rôle inférieur).
module.exports.ctx = async (req) => {
  if (!A.can(req, 'admin')) return '';
  const cur = req.org.currency; const f = (n) => `${Number(n).toLocaleString('fr-FR')} ${cur}`;
  const year = today().slice(0, 4);
  const l = await liasse(req, year); const o = await obligations(req.org.id);
  const show = (list) => list.slice(0, 8).map((x) => `- ${String(x.title).slice(0, 60)} (échéance ${x.dueDate}${x.amount ? ', ' + f(x.amount) : ''})`).join('\n') || '(aucune)';
  return [`FISCALITÉ ${year} : résultat provisoire ${f(l.resultat.resultat)}, chiffre d'affaires ${f(l.sig.chiffreAffaires)} (d'après ${l.entryCount} écriture(s) ; document de travail non validé).`,
    `Anomalies à corriger avant dépôt : ${l.toFix}${l.issues.filter((i) => i.level === 'error').length ? '\n' + l.issues.filter((i) => i.level === 'error').slice(0, 6).map((i) => '- ' + i.text.slice(0, 160)).join('\n') : ''}`,
    `Échéances en retard (${o.late.length}) :\n${show(o.late)}`, `Échéances dans les 7 jours (${o.soon.length}) :\n${show(o.soon)}`].join('\n').slice(0, 2900);
};
module.exports.min = 'admin';
module.exports.prompt = `Tu aides l'administrateur à PRÉPARER sa fin d'exercice et son calendrier fiscal : lire les états (bilan, compte de résultat, soldes intermédiaires de gestion), comprendre les anomalies à corriger, ne pas oublier les échéances en retard ou proches, estimer la TVA du mois.
Règles : le document produit est un DOCUMENT DE TRAVAIL, jamais une liasse officielle : le format officiel dépend du pays et doit être validé par un expert-comptable avant tout dépôt. Les échéances sont saisies par l'organisation (les modèles sont des exemples à confirmer) : ne les présente jamais comme la loi. Tu ne donnes pas de conseil fiscal ou juridique définitif ; pour un taux, un délai ou une obligation, renvoie vers l'administration fiscale ou un expert-comptable. Tu ne modifies rien toi-même : indique où corriger dans la Comptabilité.`;
