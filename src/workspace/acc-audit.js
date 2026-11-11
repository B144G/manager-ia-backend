'use strict';
// Comptabilité pro (4/4) : contrôles intelligents (audit permanent). Lecture seule : rien n'est corrigé automatiquement. Chaque contrôle
// regroupe ses constats en une seule alerte ; le score baisse selon la gravité (erreur -15, avertissement -5, information -1, plancher 0).
const express = require('express');
const { db } = require('../db');
const L = require('./acc-pro-lib');

const router = express.Router({ mergeParams: true });
const accounting = () => require('./accounting');
const PENALTY = { error: 15, warning: 5, info: 1 };
const CODES = ['cash_negative', 'momo_negative', 'customer_credit', 'supplier_debit', 'bank_negative', 'suspense_open', 'duplicates', 'future_dated', 'weekend', 'short_label', 'vat_mismatch', 'unposted_documents', 'month_gap', 'no_depreciation', 'no_section', 'result_balance_gap'];

async function runAudit(req, year) {
  const org = req.org; const start = `${year}-01-01`; const end = `${year}-12-31`; const today = L.today();
  const issues = []; const add = (severity, code, title, detail, extra) => issues.push({ severity, code, title, detail, ...(extra || {}) });
  const cum = await L.balances(org.id, '0001-01-01', end, { noOpen: true });
  const yr = await L.balances(org.id, start, end, { noClose: true });
  const bal = (a) => cum.filter((r) => r.account === a).reduce((s, r) => s + r.balance, 0);

  // Soldes inhabituels (cumulés à la fin de l'exercice)
  const cash = bal('571');
  if (cash < 0) add('error', 'cash_negative', 'Caisse créditrice', `La caisse (571) est négative de ${L.fmt(-cash)} FCFA : on ne peut pas dépenser plus d'espèces qu'on n'en a. Une recette est peut-être oubliée ou une dépense mal imputée.`, { accounts: ['571'], fix: 'Vérifiez les encaissements en espèces et faites un comptage de caisse.' });
  const mm = bal('589');
  if (mm < 0) add('warning', 'momo_negative', 'Mobile money créditeur', `Le compte mobile money (589) est négatif de ${L.fmt(-mm)} FCFA.`, { accounts: ['589'], fix: 'Vérifiez les dépôts et retraits mobile money.' });
  const cust = bal('411');
  if (cust < 0) add('warning', 'customer_credit', 'Client créditeur', `Les clients (411) ont un solde créditeur de ${L.fmt(-cust)} FCFA : un paiement a peut-être été enregistré en trop ou sans facture.`, { accounts: ['411'], fix: 'Lettrez les paiements avec les factures dans le lettrage des clients.' });
  const supp = bal('401');
  if (supp > 0) add('warning', 'supplier_debit', 'Fournisseur débiteur', `Les fournisseurs (401) ont un solde débiteur de ${L.fmt(supp)} FCFA : un règlement dépasse les factures enregistrées (avance ou erreur).`, { accounts: ['401'], fix: 'Vérifiez les règlements fournisseurs et enregistrez les factures manquantes.' });
  const banks = cum.filter((r) => r.account.startsWith('52') && r.balance < 0);
  if (banks.length) add('warning', 'bank_negative', 'Banque négative', `Compte(s) bancaire(s) à découvert : ${banks.map((r) => `${r.account} (${L.fmt(-r.balance)} FCFA)`).join(', ')}. Vérifiez qu'il s'agit bien d'un découvert autorisé.`, { accounts: banks.map((r) => r.account), fix: 'Rapprochez le relevé bancaire avec les écritures.' });
  const susp = cum.filter((r) => r.account.startsWith('47') && r.balance !== 0);
  if (susp.length) add('warning', 'suspense_open', "Comptes d'attente non soldés", `Des opérations attendent d'être classées dans les comptes d'attente : ${susp.map((r) => `${r.account} (${L.fmt(Math.abs(r.balance))} FCFA)`).join(', ')}.`, { accounts: susp.map((r) => r.account), fix: "Affectez ces opérations au bon compte puis soldez le compte d'attente." });

  // Écritures de l'exercice
  const ents = (await db.prepare(`SELECT e.id, e.number, e.date, e.label, e.source, e.reversed_of, (SELECT COALESCE(SUM(l.debit), 0) FROM acc_lines l WHERE l.entry_id = e.id) AS total FROM acc_entries e
    WHERE e.org_id = ? AND e.date >= ? AND e.date <= ? AND e.source NOT IN ('year_end', 'year_end_rev', 'year_open', 'year_open_rev') ORDER BY e.date, e.id`).all(org.id, start, end)).map((e) => ({ ...e, id: Number(e.id), total: Number(e.total) }));
  const cancelled = new Set((await db.prepare('SELECT reversed_of FROM acc_entries WHERE org_id = ? AND reversed_of IS NOT NULL').all(org.id)).map((r) => Number(r.reversed_of)));
  const live = ents.filter((e) => !e.reversed_of && !cancelled.has(e.id));
  const groups = new Map();
  for (const e of live) { const k = `${e.date}|${e.total}|${e.label.trim().toLowerCase()}`; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(e); }
  const dups = [...groups.values()].filter((g) => g.length > 1 && !g.every((e) => e.source === 'recurring'));
  if (dups.length) add('warning', 'duplicates', 'Doublons probables', `${dups.length} groupe(s) d'écritures ont la même date, le même montant et le même libellé : ${dups.slice(0, 3).map((g) => `${g[0].date} « ${g[0].label.slice(0, 40)} » ${L.fmt(g[0].total)} FCFA`).join(' ; ')}${dups.length > 3 ? '…' : ''}.`,
    { entryIds: dups.flat().map((e) => e.id).slice(0, 50), fix: 'Annulez le doublon par une écriture inverse si c\'est une erreur.' });
  const future = ents.filter((e) => e.date > today && !e.reversed_of && e.source !== 'recurring');
  if (future.length) add('warning', 'future_dated', 'Écritures datées dans le futur', `${future.length} écriture(s) portent une date postérieure à aujourd'hui (${today}).`, { entryIds: future.map((e) => e.id).slice(0, 50), fix: 'Vérifiez la date saisie.' });
  const manual = live.filter((e) => !e.source);
  const weekend = manual.filter((e) => { const d = new Date(`${e.date}T00:00:00Z`).getUTCDay(); return d === 0 || d === 6; });
  if (weekend.length) add('info', 'weekend', 'Écritures un week-end', `${weekend.length} écriture(s) manuelle(s) sont datées d'un samedi ou d'un dimanche : normal si vous travaillez ces jours-là.`, { entryIds: weekend.map((e) => e.id).slice(0, 50) });
  const shortL = manual.filter((e) => e.label.trim().length < 5);
  if (shortL.length) add('info', 'short_label', 'Libellés trop courts', `${shortL.length} écriture(s) ont un libellé de moins de 5 caractères : un libellé clair aide à retrouver l'opération.`, { entryIds: shortL.map((e) => e.id).slice(0, 50), fix: 'Utilisez des libellés précis (qui, quoi, pourquoi).' });

  // TVA collectée cohérente avec les ventes au taux des réglages
  const rate = Number(req.acc.vat_rate) || 0;
  const ventes = -yr.filter((r) => r.account.startsWith('70')).reduce((a, r) => a + r.balance, 0);
  const tva = -yr.filter((r) => r.account.startsWith('443')).reduce((a, r) => a + r.balance, 0);
  if (rate > 0 && ventes > 0) {
    const expected = Math.round((ventes * rate) / 100);
    if (Math.abs(tva - expected) > expected * 0.02) add('warning', 'vat_mismatch', 'TVA collectée incohérente', `Pour ${L.fmt(ventes)} FCFA de ventes au taux de ${rate} %, la TVA collectée devrait être d'environ ${L.fmt(expected)} FCFA ; la comptabilité en affiche ${L.fmt(tva)} (écart de plus de 2 %). Si certaines ventes sont exonérées, c'est normal.`, { accounts: ['4431', '4432'], fix: 'Vérifiez le taux de TVA des réglages et les ventes sans TVA.' });
  }

  // Opérations non comptabilisées
  const pend = await L.pendingIn(org, start, end);
  if (pend.total) add('warning', 'unposted_documents', 'Opérations non comptabilisées', `${pend.total} opération(s) de ${year} ne sont pas encore en comptabilité : ${pend.invoices} facture(s) ou avoir(s), ${pend.payments} paiement(s), ${pend.purchases} achat(s).`, { fix: 'Lancez « Générer les écritures » pour les comptabiliser.' });

  // Mois sans écriture alors que l'activité existe
  const months = new Set((await db.prepare('SELECT DISTINCT substr(date, 1, 7) AS m FROM acc_entries WHERE org_id = ? AND date >= ? AND date <= ?').all(org.id, start, end)).map((r) => r.m));
  if (months.size) {
    const sorted = [...months].sort(); const first = Number(sorted[0].slice(5)); let lastM = Number(sorted[sorted.length - 1].slice(5));
    if (String(year) === today.slice(0, 4)) lastM = Math.max(lastM, Number(today.slice(5, 7)));
    const gaps = []; for (let m = first; m <= lastM; m++) if (!months.has(`${year}-${L.pad(m)}`)) gaps.push(`${year}-${L.pad(m)}`);
    if (gaps.length) add('warning', 'month_gap', 'Mois sans écriture', `Aucune écriture en ${gaps.join(', ')} alors que l'activité a commencé : des opérations sont peut-être oubliées.`, { fix: 'Saisissez ou importez les opérations de ces mois.' });
  }

  // Immobilisations sans amortissement du mois écoulé
  const ref = String(year) < today.slice(0, 4) ? `${year}-12` : (String(year) === today.slice(0, 4) && Number(today.slice(5, 7)) > 1 ? `${year}-${L.pad(Number(today.slice(5, 7)) - 1)}` : null);
  if (ref) {
    const dep = await require('./acc-ops').dueDepreciation(org.id, ref, false);
    if (dep.length) add('warning', 'no_depreciation', 'Amortissements non comptabilisés', `${dep.length} dotation(s) aux amortissements dues jusqu'en ${ref} ne sont pas comptabilisées.`, { fix: 'Lancez la dotation mensuelle dans Immobilisations.' });
  }

  // Lignes sans section alors que des sections existent
  if ((await db.prepare('SELECT COUNT(*) c FROM acc_sections WHERE org_id = ? AND active = 1').get(org.id)).c) {
    const n = Number((await db.prepare(`SELECT COUNT(*) c FROM acc_lines l JOIN acc_entries e ON e.id = l.entry_id WHERE l.org_id = ? AND e.date >= ? AND e.date <= ? AND l.section = '' AND (l.account LIKE '6%' OR l.account LIKE '7%') AND e.source NOT IN ('year_end', 'year_end_rev')`).get(org.id, start, end)).c);
    if (n) add('info', 'no_section', 'Lignes sans section analytique', `${n} ligne(s) de charges ou de produits n'ont pas de section analytique alors que vous en avez créé : elles apparaissent en « non ventilé ».`, { fix: 'Affectez une section à ces lignes à la prochaine saisie.' });
  }

  // Compte de résultat et bilan
  const st = await accounting().statements(org, String(year));
  if (!st.bilan.equilibre) add('error', 'result_balance_gap', 'Bilan déséquilibré', `L'actif (${L.fmt(st.bilan.totalActif)}) et le passif avec résultat (${L.fmt(st.bilan.totalPassif)}) diffèrent de ${L.fmt(Math.abs(st.bilan.totalActif - st.bilan.totalPassif))} FCFA : le résultat du compte de résultat ne correspond pas à l'écart du bilan (compte hors classes 1 à 8 ?).`, { fix: 'Vérifiez les comptes utilisés (classes 1 à 8) et contactez votre expert-comptable.' });

  const score = Math.max(0, 100 - issues.reduce((a, i) => a + PENALTY[i.severity], 0));
  return { score, issues, checked: CODES.slice() };
}

router.get('/audit', async (req, res) => res.json(await runAudit(req, L.yearOf(req.query.year))));

module.exports = router;
module.exports.runAudit = runAudit;
