'use strict';
// Trésorerie : calculs comptables PURS (aucun accès à la base) — classement des contreparties de trésorerie, BFR / FRNG / trésorerie nette,
// DSO / DPO / DIO / CCC, interprétation. Testables avec des nombres seulement.

/** Comptes de trésorerie (classe 5) : banques 52, chèques 53, monnaie électronique 54 et 589, caisse 57. Les virements de fonds (585, 588) sont internes. */
const isCash = (acc) => /^(52|53|54|57)/.test(acc) || acc.startsWith('589');
/** Classe une contrepartie d'un mouvement de trésorerie : section du tableau des flux et groupe d'analyse. */
function classify(acc) {
  const a = String(acc);
  if (a.startsWith('585') || a.startsWith('588') || a.startsWith('58') && !a.startsWith('589')) return { section: 'internal', group: 'interne' };
  if (/^(41|70|71|72|73|74|75|76|419)/.test(a)) return { section: 'operating', group: 'clients' };
  if (/^(77)/.test(a)) return { section: 'financing', group: 'financiers' };
  if (/^(67)/.test(a)) return { section: 'financing', group: 'financiers' };
  if (/^(40|60|61|62)/.test(a)) return { section: 'operating', group: 'fournisseurs' };
  if (/^(42|43|66)/.test(a)) return { section: 'operating', group: 'personnel' };
  if (/^(44|64)/.test(a)) return { section: 'operating', group: 'impots' };
  if (/^(16|17|56|18)/.test(a)) return { section: 'financing', group: 'emprunts' };
  if (/^(10|11|12|13|14|15|465)/.test(a)) return { section: 'financing', group: 'capital' };
  if (/^(2|481|482|485|486|81|82|84|85)/.test(a)) return { section: 'investing', group: 'investissements' };
  return { section: 'operating', group: 'autres' };
}


const sumAcc = (m, test) => Object.entries(m).reduce((s, [a, b]) => (test(a) ? s + b : s), 0);

// ---------- BFR, FRNG, trésorerie nette ----------
/**
 * Fonction pure sur la balance { compte: débit − crédit }. Toute écriture étant équilibrée, la somme de tous les comptes vaut 0 :
 *   trésorerie (classe 5, y compris crédits de trésorerie 56) = FRNG − BFR   (FRNG = ressources stables − emplois stables ; BFR = stocks + créances − dettes d'exploitation, hors exploitation compris).
 */
function workingCapital(m) {
  const S = (re) => sumAcc(m, (a) => re.test(a));
  const result = -S(/^[678]/); // résultat de l'exercice non encore affecté (produits − charges)
  const equity = -S(/^1[0-5]/); const debts = -S(/^1[6-8]/); const prov = -S(/^19/);
  const fixed = S(/^2/);
  const frng = equity + debts + prov + result - fixed;
  const stocks = S(/^3/); const nonOp = S(/^(45|46|48)/);
  const bfr = S(/^[34]/); const tn = frng - bfr; const cash = S(/^5/);
  return {
    equity, financialDebts: debts, provisions: prov, result, fixedAssets: fixed, frng, stocks, receivables: S(/^41/) + S(/^409/), payables: S(/^40/) - S(/^409/), other: S(/^(42|43|44|47|49)/), nonOperating: nonOp, bfr,
    bfrOperating: bfr - nonOp, treasuryNet: tn, cashBooks: cash, check: { gap: cash - tn, ok: cash === tn },
  };
}


/** Formules pures : DSO = créances ÷ ventes TTC × jours ; DPO = dettes fournisseurs ÷ achats TTC × jours ; DIO = stock ÷ coût des achats consommés × jours ; CCC = DSO + DIO − DPO. */
function kpiFormulas({ receivables, payables, stock, sales, purchases, cogs, days }) {
  const d = (n, den) => (den > 0 ? Math.round(n / den * days * 10) / 10 : null);
  const dso = d(Math.max(receivables, 0), sales); const dpo = d(Math.max(-payables, 0), purchases); const dio = d(Math.max(stock, 0), cogs);
  const ccc = dso === null && dio === null && dpo === null ? null : Math.round(((dso || 0) + (dio || 0) - (dpo || 0)) * 10) / 10;
  return { dso, dpo, dio, ccc };
}


/** Phrase d'interprétation (code + paramètres, traduits par le site). */
function interpret(k, targets) {
  const out = [];
  if (k.dso !== null && k.dso !== undefined) out.push(k.dso <= targets.dso ? { code: 'dso_ok', p: { days: k.dso, target: targets.dso } } : k.dso <= targets.dso * 1.5 ? { code: 'dso_above', p: { days: k.dso, target: targets.dso } } : { code: 'dso_high', p: { days: k.dso, target: targets.dso } });
  if (k.dpo !== null && k.dpo !== undefined) out.push(k.dpo >= targets.dpo ? { code: 'dpo_ok', p: { days: k.dpo, target: targets.dpo } } : { code: 'dpo_short', p: { days: k.dpo, target: targets.dpo } });
  if (k.dio !== null && k.dio !== undefined) out.push(k.dio <= targets.dio ? { code: 'dio_ok', p: { days: k.dio, target: targets.dio } } : { code: 'dio_high', p: { days: k.dio, target: targets.dio } });
  if (k.ccc !== null && k.ccc !== undefined) out.push(k.ccc < 0 ? { code: 'ccc_negative', p: { days: Math.abs(k.ccc) } } : k.ccc <= targets.ccc ? { code: 'ccc_ok', p: { days: k.ccc, target: targets.ccc } } : { code: 'ccc_high', p: { days: k.ccc, target: targets.ccc } });
  return out;
}
function kpiAlerts(k, targets) {
  const a = [];
  if (k.dso !== null && k.dso > targets.dso) a.push({ code: 'dso', level: k.dso > targets.dso * 1.5 ? 'alert' : 'warn', value: k.dso, target: targets.dso });
  if (k.dpo !== null && k.dpo < targets.dpo) a.push({ code: 'dpo', level: 'info', value: k.dpo, target: targets.dpo });
  if (k.dio !== null && k.dio > targets.dio) a.push({ code: 'dio', level: k.dio > targets.dio * 1.5 ? 'alert' : 'warn', value: k.dio, target: targets.dio });
  if (k.ccc !== null && k.ccc > targets.ccc) a.push({ code: 'ccc', level: k.ccc > targets.ccc * 1.5 ? 'alert' : 'warn', value: k.ccc, target: targets.ccc });
  return a;
}


module.exports = { isCash, classify, sumAcc, workingCapital, kpiFormulas, interpret, kpiAlerts };
