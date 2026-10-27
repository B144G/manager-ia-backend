'use strict';
// Sous-application « Fiscalité et liasse » (administrateurs et propriétaire) : document de travail de fin d'exercice (bilan, compte de résultat,
// soldes intermédiaires de gestion) calculé à partir des écritures de la comptabilité, contrôles de cohérence, calendrier fiscal paramétrable
// et estimation de la TVA du mois. Ce n'est PAS la liasse officielle : le format dépend du pays et le document doit être validé par un expert-comptable.
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const { HttpError } = require('../util');
const SIG = require('./syscohada-sig');

const router = express.Router({ mergeParams: true });
router.use(A.need('admin'));

const NOTICE = "Document de travail préparé par Brij-IA, à faire valider par un expert-comptable avant tout dépôt officiel.";
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
  amount: o.amount, reference: o.reference, note: o.note, recurrence: o.recurrence, doneDate: o.done_date, repeat: Boolean(o.auto_repeat), parentId: o.parent_id || null,
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
    repeat: b.repeat === undefined ? Boolean(c.auto_repeat) : Boolean(b.repeat),
  };
}

router.get('/obligations', async (req, res) => res.json({ ...(await obligations(req.org.id)), templates: templates(), kinds: KINDS, statuses: STATUSES, recurrences: RECUR }));

router.post('/obligations', async (req, res) => {
  const f = fields(req.body || {}, null);
  if (!f.title) throw new HttpError(400, "Indiquez le nom de l'obligation.");
  if (f.repeat && f.recurrence === 'none') throw new HttpError(400, 'Pour répéter automatiquement, choisissez une périodicité (chaque mois, trimestre ou année).');
  const id = (await db.prepare('INSERT INTO fiscal_obligations (org_id, title, kind, period, due_date, status, amount, reference, note, recurrence, done_date, created_by, created_at, auto_repeat) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    req.org.id, f.title, f.kind, f.period, f.due, f.status, f.amount, f.reference, f.note, f.recurrence, f.status === 'todo' ? null : today(), req.user.id, nowISO(), f.repeat ? 1 : 0)).lastInsertRowid;
  await A.logActivity(req.org.id, req.user.id, 'fiscal', `Échéance fiscale « ${f.title} » ajoutée`);
  res.status(201).json({ id: Number(id) });
});

const STEP = { monthly: 1, quarterly: 3, yearly: 12 };

/** Crée l'échéance suivante d'une obligation récurrente (à faire, mêmes réglages, sans justificatif). Renvoie null si elle existe déjà. */
async function createNext(orgId, userId, o) {
  const step = STEP[o.recurrence];
  if (!step) return null;
  const due = addMonths(o.due_date, step);
  if (await db.prepare('SELECT 1 FROM fiscal_obligations WHERE org_id = ? AND title = ? AND due_date = ?').get(orgId, o.title, due)) return null;
  const id = (await db.prepare("INSERT INTO fiscal_obligations (org_id, title, kind, period, due_date, status, amount, reference, note, recurrence, created_by, created_at, auto_repeat, parent_id) VALUES (?, ?, ?, '', ?, 'todo', ?, '', ?, ?, ?, ?, ?, ?)").run(
    orgId, o.title, o.kind, due, o.amount, o.note, o.recurrence, userId, nowISO(), o.auto_repeat ? 1 : 0, o.id)).lastInsertRowid;
  return { id: Number(id), dueDate: due };
}

router.put('/obligations/:id', async (req, res) => {
  const o = await obOf(req, req.params.id);
  const f = fields(req.body || {}, o);
  if (f.repeat && f.recurrence === 'none') throw new HttpError(400, 'Pour répéter automatiquement, choisissez une périodicité (chaque mois, trimestre ou année).');
  const done = f.status === 'todo' ? null : (o.status !== 'todo' && o.done_date ? o.done_date : today());
  await db.prepare('UPDATE fiscal_obligations SET title = ?, kind = ?, period = ?, due_date = ?, status = ?, amount = ?, reference = ?, note = ?, recurrence = ?, done_date = ?, auto_repeat = ? WHERE id = ?').run(
    f.title, f.kind, f.period, f.due, f.status, f.amount, f.reference, f.note, f.recurrence, done, f.repeat ? 1 : 0, o.id);
  // « Répéter » : en passant de « à faire » à « déposée » ou « payée », l'échéance suivante est créée (une seule fois).
  let next = null;
  if (o.status === 'todo' && f.status !== 'todo' && f.repeat) {
    next = await createNext(req.org.id, req.user.id, { ...o, title: f.title, kind: f.kind, due_date: f.due, amount: f.amount, note: f.note, recurrence: f.recurrence, auto_repeat: 1 });
    if (next) await A.logActivity(req.org.id, req.user.id, 'fiscal', `Échéance « ${f.title} » : la suivante est créée pour le ${next.dueDate}`);
  }
  res.json({ ok: true, next });
});

router.delete('/obligations/:id', async (req, res) => {
  const o = await obOf(req, req.params.id);
  await db.prepare('DELETE FROM fiscal_obligations WHERE id = ?').run(o.id);
  res.json({ ok: true });
});

// Crée à la main l'échéance suivante d'une obligation récurrente.
router.post('/obligations/:id/next', async (req, res) => {
  const o = await obOf(req, req.params.id);
  if (!STEP[o.recurrence]) throw new HttpError(400, "Cette obligation n'est pas récurrente.");
  const n = await createNext(req.org.id, req.user.id, o);
  if (!n) throw new HttpError(409, "L'échéance suivante existe déjà.");
  res.status(201).json(n);
});

// ---------- Comptabilité : états de fin d'exercice ----------
const accounting = () => require('./accounting'); // require paresseux (évite toute dépendance circulaire)

const yearOf = (v) => {
  const y = String(v || today().slice(0, 4));
  if (!/^\d{4}$/.test(y) || Number(y) < 2000 || Number(y) > 2100) throw new HttpError(400, 'Année invalide.');
  return y;
};
const pre = (a, list) => list.some((p) => a.startsWith(p));

/** Soldes intermédiaires de gestion. Classement des comptes : voir syscohada-sig.js (tableau de correspondance lisible). Montants : produit positif, charge positive dans la valeur ; le signe est géré dans les lignes. */
function sigOf(rows) {
  const v = Object.fromEntries(Object.keys(SIG.SIG_KEYS).map((k) => [k, 0]));
  for (const r of rows) {
    const k = SIG.sigKeyOf(r.account);
    if (!k) continue;
    v[k] += SIG.SIG_KEYS[k][0] === 'produit' ? -r.balance : r.balance;
  }
  const margeCommerciale = v.ventesMarch - v.achatsMarch - v.varStockMarch;
  const production = v.ventesProd + v.prodStockee + v.prodImmo;
  const consommations = v.achatsMat + v.varStockMat + v.transports + v.servicesExt;
  const valeurAjoutee = margeCommerciale + production - consommations;
  const excedentBrutExploitation = valeurAjoutee + v.subv - v.impots - v.personnel;
  const resultatExploitation = excedentBrutExploitation + v.autresProduits + v.reprises - v.autresCharges - v.dotations;
  const resultatFinancier = v.prodFin - v.chFin;
  const resultatActivitesOrdinaires = resultatExploitation + resultatFinancier;
  const hao = v.haoProd - v.haoCharges;
  const resultatNet = resultatActivitesOrdinaires + hao - v.participation - v.impotResultat;
  return {
    chiffreAffaires: v.ventesMarch + v.ventesProd,
    lines: [
      { key: 'ventesMarch', label: 'Ventes de marchandises', amount: v.ventesMarch },
      { key: 'achatsMarch', label: 'Achats de marchandises et variation de stock', amount: -(v.achatsMarch + v.varStockMarch) },
      { key: 'margeCommerciale', label: 'Marge commerciale', amount: margeCommerciale, total: true },
      { key: 'production', label: 'Production vendue, stockée et immobilisée', amount: production },
      { key: 'consoMatieres', label: 'Consommations de matières et fournitures (achats et variation de stock)', amount: -(v.achatsMat + v.varStockMat) },
      { key: 'transports', label: 'Transports', amount: -v.transports },
      { key: 'servicesExt', label: 'Services extérieurs (loyers, assurances, banque, honoraires...)', amount: -v.servicesExt },
      { key: 'valeurAjoutee', label: 'Valeur ajoutée', amount: valeurAjoutee, total: true },
      { key: 'subv', label: "Subventions d'exploitation", amount: v.subv },
      { key: 'impots', label: 'Impôts et taxes', amount: -v.impots },
      { key: 'personnel', label: 'Charges de personnel', amount: -v.personnel },
      { key: 'excedentBrutExploitation', label: "Excédent brut d'exploitation", amount: excedentBrutExploitation, total: true },
      { key: 'autresProduits', label: "Autres produits, transferts de charges et reprises d'exploitation", amount: v.autresProduits + v.reprises },
      { key: 'autresCharges', label: 'Autres charges', amount: -v.autresCharges },
      { key: 'dotations', label: "Dotations d'exploitation (amortissements et provisions)", amount: -v.dotations },
      { key: 'resultatExploitation', label: "Résultat d'exploitation", amount: resultatExploitation, total: true },
      { key: 'resultatFinancier', label: 'Résultat financier', amount: resultatFinancier },
      { key: 'resultatActivitesOrdinaires', label: 'Résultat des activités ordinaires', amount: resultatActivitesOrdinaires, total: true },
      { key: 'hao', label: 'Résultat hors activités ordinaires', amount: hao },
      { key: 'participation', label: 'Participation des travailleurs', amount: -v.participation },
      { key: 'impotResultat', label: 'Impôts sur le résultat', amount: -v.impotResultat },
      { key: 'resultatNet', label: 'Résultat net', amount: resultatNet, total: true },
    ],
    margeCommerciale, valeurAjoutee, excedentBrutExploitation, resultatExploitation, resultatActivitesOrdinaires, resultatNet,
  };
}

/** Compte de résultat par compte (produits et charges) sur les écritures de l'exercice ; bilan par grandes masses sur les soldes CUMULÉS depuis l'ouverture (cumRows), avec le résultat des exercices précédents non affecté (prior). */
function statementsOf(rows, cumRows, prior) {
  const net = (r) => r.balance;
  const produits = rows.filter((r) => r.account[0] === '7' || (r.account[0] === '8' && r.balance < 0)).map((r) => ({ account: r.account, label: r.label, amount: -r.balance }));
  const charges = rows.filter((r) => r.account[0] === '6' || (r.account[0] === '8' && r.balance >= 0)).map((r) => ({ account: r.account, label: r.label, amount: r.balance }));
  const totalProduits = produits.reduce((a, x) => a + x.amount, 0); const totalCharges = charges.reduce((a, x) => a + x.amount, 0);
  const resultat = -rows.filter((r) => '678'.includes(r.account[0])).reduce((a, r) => a + net(r), 0);

  const g = { immo: [], stocks: [], creances: [], treso: [], capitaux: [], dettesFin: [], dettesCirc: [], tresoPassif: [] };
  for (const r of cumRows) {
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
  passif.splice(1, 0, { key: 'report', label: 'Résultat des exercices précédents (non affecté)', amount: prior, rows: [] }, { key: 'resultat', label: "Résultat de l'exercice", amount: resultat, rows: [] });
  const totalActif = actif.reduce((a, x) => a + x.amount, 0); const totalPassif = passif.reduce((a, x) => a + x.amount, 0);
  return { resultat: { produits, charges, totalProduits, totalCharges, resultat }, bilan: { actif, passif, totalActif, totalPassif, equilibre: totalActif === totalPassif } };
}

async function liasse(req, year) {
  const from = `${year}-01-01`; const to = `${year}-12-31`;
  const rows = await accounting().balance(req.org, from, to);
  // Soldes cumulés depuis l'ouverture (toutes les écritures jusqu'à la fin de l'exercice) : base du bilan.
  const cum = await accounting().balance(req.org, '0001-01-01', to);
  const resultYear = -rows.filter((r) => '678'.includes(r.account[0])).reduce((a, r) => a + r.balance, 0);
  const resultToDate = -cum.filter((r) => '678'.includes(r.account[0])).reduce((a, r) => a + r.balance, 0);
  const prior = resultToDate - resultYear; // résultat des exercices précédents qui n'a pas encore été viré en réserves/report à nouveau
  const st = statementsOf(rows, cum, prior); const sig = sigOf(rows);
  const before = Number((await db.prepare('SELECT COUNT(*) c FROM acc_entries WHERE org_id = ? AND date < ?').get(req.org.id, from)).c);
  const acc = await accounting().ensure(req.org);
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
  if (tot.n && !cum.some((r) => r.account.startsWith('101'))) add('info', 'capital', "Aucune écriture sur le capital social (compte 101) depuis l'ouverture : vérifiez que le capital a bien été enregistré.");
  if (tot.n && !before) add('info', 'carry', "Aucune écriture avant cet exercice : si l'entreprise existait déjà, enregistrez dans la Comptabilité les écritures d'ouverture (soldes de départ) pour que le bilan soit complet.");
  if (prior !== 0) add('info', 'carry-result', `Le bilan cumule les écritures depuis l'ouverture et affiche ${prior.toLocaleString('fr-FR')} de résultat des exercices précédents non affecté. Brij-IA ne passe pas l'écriture d'affectation du résultat (réserves, report à nouveau, dividendes) : elle se décide en assemblée et se saisit en écriture diverse dans la Comptabilité.`);
  const todo = issues.filter((i) => i.level !== 'info');
  return { year, notice: NOTICE, entryCount: Number(tot.n), resultat: st.resultat, bilan: st.bilan, sig, carry: { priorResult: prior, hasPriorEntries: before > 0, cumulative: true }, exercise: { closed: Boolean(acc.locked_until && acc.locked_until >= to), lockedUntil: acc.locked_until || '' }, issues, toFix: todo.filter((i) => i.level === 'error').length, ready: !todo.some((i) => i.level === 'error') };
}

router.get('/liasse', async (req, res) => res.json(await liasse(req, yearOf(req.query.year))));

// Tableau de correspondance des comptes (classes 1 à 8, sous-comptes usuels, lignes des soldes intermédiaires de gestion).
router.get('/classification', (req, res) => res.json(SIG.describe()));

// ---------- Exercices : clôture et réouverture ----------
// Clôturer = verrouiller les écritures jusqu'au 31 décembre de l'année (réglage « période clôturée » de la Comptabilité). Aucune écriture
// d'affectation du résultat ni de à-nouveaux n'est générée : le bilan cumule les soldes depuis l'ouverture, donc il reste exact sans elles.
const EXERCISE_NOTES = [
  "Clôturer un exercice verrouille toutes les écritures jusqu'au 31 décembre de cette année : plus personne ne peut en ajouter, ni dans ces dates ni avant.",
  "La clôture ne génère PAS d'écriture d'affectation du résultat ni de report à nouveau : le bilan de l'exercice suivant reprend les soldes cumulés depuis l'ouverture et affiche le résultat précédent non affecté.",
  "Seul le dernier exercice clôturé peut être rouvert, avec un motif obligatoire. La réouverture est journalisée (journal d'activité et journal d'audit).",
  'Cette clôture est un verrou interne de Brij-IA : elle ne remplace ni la clôture légale ni la validation par votre expert-comptable.',
];
const lockStart = (req) => accounting().ensure(req.org);

router.get('/exercises', async (req, res) => {
  const acc = await lockStart(req);
  const rows = await db.prepare("SELECT SUBSTR(date, 1, 4) AS year, COUNT(*) AS n FROM acc_entries WHERE org_id = ? GROUP BY SUBSTR(date, 1, 4) ORDER BY year DESC").all(req.org.id);
  const cur = today().slice(0, 4);
  const years = new Map(rows.map((r) => [r.year, Number(r.n)]));
  if (!years.has(cur)) years.set(cur, 0);
  const list = [...years.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).map(([year, n]) => ({ year, entryCount: n, closed: Boolean(acc.locked_until && acc.locked_until >= `${year}-12-31`), canClose: `${year}-12-31` <= today() && !(acc.locked_until && acc.locked_until >= `${year}-12-31`), canReopen: acc.locked_until === `${year}-12-31` }));
  const history = (await db.prepare('SELECT id, year, action, reason, created_at FROM fiscal_closings WHERE org_id = ? ORDER BY id DESC LIMIT 30').all(req.org.id)).map((h) => ({ id: h.id, year: h.year, action: h.action, reason: h.reason, at: h.created_at }));
  res.json({ lockedUntil: acc.locked_until || '', years: list, history, notes: EXERCISE_NOTES });
});

const closing = async (req, year, action, reason) => {
  await db.prepare('INSERT INTO fiscal_closings (org_id, year, action, reason, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(req.org.id, year, action, reason, req.user.id, nowISO());
  await A.logActivity(req.org.id, req.user.id, 'fiscal', `Exercice ${year} ${action === 'close' ? 'clôturé' : 'rouvert'}${reason ? ' : ' + reason : ''}`);
  try { await require('../security/audit').record(req, `fiscal.exercise_${action}`, { orgId: req.org.id, target: `exercice:${year}`, severity: action === 'close' ? 'info' : 'warn', detail: reason }); } catch { /* ne bloque jamais */ }
};

router.post('/exercises/:year/close', async (req, res) => {
  const year = yearOf(req.params.year);
  const end = `${year}-12-31`;
  if (end > today()) throw new HttpError(400, "Cet exercice n'est pas terminé : il ne peut être clôturé qu'après le 31 décembre.");
  const acc = await lockStart(req);
  if (acc.locked_until && acc.locked_until >= end) throw new HttpError(409, 'Cet exercice est déjà clôturé.');
  const l = await liasse(req, year);
  if (l.toFix > 0) throw new HttpError(400, `Corrigez d'abord les ${l.toFix} anomalie(s) bloquante(s) de la liasse avant de clôturer.`);
  await db.prepare('UPDATE acc_settings SET locked_until = ? WHERE org_id = ?').run(end, req.org.id);
  await closing(req, year, 'close', '');
  res.json({ ok: true, lockedUntil: end, notes: EXERCISE_NOTES });
});

router.post('/exercises/:year/reopen', async (req, res) => {
  const year = yearOf(req.params.year);
  const end = `${year}-12-31`;
  const reason = A.text((req.body || {}).reason, 200, { required: true, msg: 'Indiquez le motif de la réouverture.' });
  if (reason.length < 5) throw new HttpError(400, 'Le motif de la réouverture est trop court (5 caractères au moins).');
  const acc = await lockStart(req);
  if (acc.locked_until !== end) throw new HttpError(409, acc.locked_until ? `Seul le dernier exercice clôturé (verrou au ${acc.locked_until}) peut être rouvert.` : "Cet exercice n'est pas clôturé.");
  const prev = String(Number(year) - 1);
  const last = await db.prepare('SELECT action FROM fiscal_closings WHERE org_id = ? AND year = ? ORDER BY id DESC LIMIT 1').get(req.org.id, prev);
  const lock = last && last.action === 'close' ? `${prev}-12-31` : null;
  await db.prepare('UPDATE acc_settings SET locked_until = ? WHERE org_id = ?').run(lock, req.org.id);
  await closing(req, year, 'reopen', reason);
  res.json({ ok: true, lockedUntil: lock || '' });
});

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
  const rateOf = (label) => { const m = /(\d+(?:[.,]\d+)?)\s*%/.exec(label || ''); return m ? Number(m[1].replace(',', '.')) : null; };
  const byAccount = { collected: col.map((x) => ({ account: x.account, label: x.label, rate: rateOf(x.label), amount: -x.balance })), deductible: ded.map((x) => ({ account: x.account, label: x.label, rate: rateOf(x.label), amount: x.balance })) };
  const rateNote = (col.length + ded.length) > 2 || byAccount.collected.some((x) => x.rate !== null) || byAccount.deductible.some((x) => x.rate !== null)
    ? 'Le détail ci-dessous est par compte de TVA. Les taux affichés viennent du nom du compte, quand il en contient un (ex. « TVA facturée 9 % »).'
    : "Le plan comptable distingue la TVA par nature (ventes, services, achats, immobilisations), pas par taux : une seule valeur de taux est réglée dans la Comptabilité et appliquée aux écritures automatiques. Si vous avez plusieurs taux, créez un compte par taux (ex. 443101 « TVA facturée 18 % », 443102 « TVA facturée 9 % ») et saisissez ces écritures à la main : elles seront additionnées dans le total et listées séparément ici.";
  return { month: r.month, collected, deductible, due: Math.max(collected - deductible, 0), credit: Math.max(deductible - collected, 0), available: col.length > 0 || ded.length > 0, missing, byAccount, rate: set ? Number(set.vat_rate) : null, rateNote, notice: 'Estimation à partir de vos écritures : à vérifier avant toute déclaration.' };
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

/** Clôture mensuelle du mois précédent et rapprochements en attente (Comptabilité, VAGUE 2). */
async function closingLine(req) {
  try {
    const prev = new Date(Date.UTC(Number(today().slice(0, 4)), Number(today().slice(5, 7)) - 2, 1)).toISOString().slice(0, 7);
    const c = await db.prepare('SELECT status FROM month_closings WHERE org_id = ? AND month = ?').get(req.org.id, prev);
    const unm = (await db.prepare("SELECT COUNT(*) c FROM bank_lines WHERE org_id = ? AND status = 'unmatched'").get(req.org.id)).c;
    return `Clôture mensuelle de ${prev} : ${c && c.status === 'closed' ? 'faite' : 'pas encore faite'}. Lignes de relevé bancaire non pointées : ${unm}.`;
  } catch { return ''; }
}

// Crochets lus par ai.js : ctx(req) = ce que l'IA voit (administrateurs seulement : aucun chiffre financier pour un rôle inférieur).
module.exports.ctx = async (req) => {
  if (!A.can(req, 'admin')) return '';
  const cur = req.org.currency; const f = (n) => `${Number(n).toLocaleString('fr-FR')} ${cur}`;
  const year = today().slice(0, 4);
  const l = await liasse(req, year); const o = await obligations(req.org.id);
  const rec = o.items.filter((x) => x.status === 'todo' && x.recurrence !== 'none');
  const noAuto = rec.filter((x) => !x.repeat);
  const show = (list) => list.slice(0, 8).map((x) => `- ${String(x.title).slice(0, 60)} (échéance ${x.dueDate}${x.amount ? ', ' + f(x.amount) : ''})`).join('\n') || '(aucune)';
  return [`FISCALITÉ ${year} : résultat provisoire ${f(l.resultat.resultat)}, chiffre d'affaires ${f(l.sig.chiffreAffaires)} (d'après ${l.entryCount} écriture(s) ; document de travail non validé).`,
    `Anomalies à corriger avant dépôt : ${l.toFix}${l.issues.filter((i) => i.level === 'error').length ? '\n' + l.issues.filter((i) => i.level === 'error').slice(0, 6).map((i) => '- ' + i.text.slice(0, 160)).join('\n') : ''}`,
    `Échéances en retard (${o.late.length}) :\n${show(o.late)}`, `Échéances dans les 7 jours (${o.soon.length}) :\n${show(o.soon)}`,
    `Échéances récurrentes ouvertes : ${rec.length}. Rappel : quand une échéance « Répéter » est marquée déposée ou payée, la suivante est créée automatiquement ; ${noAuto.length ? `${noAuto.length} échéance(s) récurrente(s) n'ont PAS « Répéter » (la suivante est à créer à la main) : ${noAuto.slice(0, 5).map((x) => String(x.title).slice(0, 40)).join(', ')}.` : 'toutes ont « Répéter ».'}`,
    await closingLine(req),
    l.carry.priorResult ? `Résultat des exercices précédents non affecté : ${f(l.carry.priorResult)} (affectation à saisir par le comptable).` : '', l.exercise.closed ? `Exercice ${year} clôturé (verrou au ${l.exercise.lockedUntil}).` : `Verrou de clôture : ${l.exercise.lockedUntil || 'aucun'}.`].filter(Boolean).join('\n').slice(0, 2900);
};
module.exports.min = 'admin';
module.exports.prompt = `Tu aides l'administrateur à PRÉPARER sa fin d'exercice et son calendrier fiscal : lire les états (bilan, compte de résultat, soldes intermédiaires de gestion), comprendre les anomalies à corriger, ne pas oublier les échéances en retard ou proches, estimer la TVA du mois.
Règles : le document produit est un DOCUMENT DE TRAVAIL, jamais une liasse officielle : le format officiel dépend du pays et doit être validé par un expert-comptable avant tout dépôt. Les échéances sont saisies par l'organisation (les modèles sont des exemples à confirmer) : ne les présente jamais comme la loi. Tu ne donnes pas de conseil fiscal ou juridique définitif ; pour un taux, un délai ou une obligation, renvoie vers l'administration fiscale ou un expert-comptable. Tu ne modifies rien toi-même : indique où corriger dans la Comptabilité.`;
