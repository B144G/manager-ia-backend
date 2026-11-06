'use strict';
// Audit de rentabilité des forfaits, SANS appel réseau ni base de données.
// Pour chaque forfait (Illimité de chaque durée, forfaits sur mesure de 10 000 FCFA au prix d'Illimité, offres historiques, offre Gratuite) :
// quota de messages IA réellement accordé x nombre de périodes de quota dans la durée payée = messages maximum possibles ;
// coût au pire cas = messages x coût d'un message ; marge = (somme encaissée nette des frais de paiement - coût) / somme nette.
// Lancez-le avec : node scripts/audit-plan-margin.js [--tous] [--echec]   (--echec : code de sortie 1 si une marge est sous le plancher)
// Réglages (variables d'environnement) : AI_COST_PER_MSG_XAF (coût d'un message, défaut 13 = Claude Sonnet 5.5), PAYMENT_FEE_PCT (défaut 3),
// PLAN_TARGET_MARGIN (marge visée en %, défaut 50), PLAN_MIN_MARGIN (plancher absolu en %, défaut 30).
Object.assign(process.env, { NODE_ENV: 'test', JWT_SECRET: process.env.JWT_SECRET || 'audit-secret-assez-long-1234567890', DATABASE_URL: process.env.DATABASE_URL || 'postgresql://audit:audit@localhost:5432/audit' });
const config = require('../src/config');
const C = require('../src/services/custom-plan');

const num = (k, d) => { const n = parseFloat(process.env[k]); return Number.isFinite(n) && n >= 0 ? n : d; };
const FEE = num('PAYMENT_FEE_PCT', 3) / 100;
const TARGET = num('PLAN_TARGET_MARGIN', 50) / 100;
const FLOOR = num('PLAN_MIN_MARGIN', 30) / 100;
const MODELS = [['Qwen (actuel)', 0.2], ['Sonnet 5.5', num('AI_COST_PER_MSG_XAF', 13)]];
const W = config.workspaceLimits;
const fmt = (n) => Math.round(n).toLocaleString('fr-FR').replace(/[  ]/g, ' ');

const limitsOf = (name) => W[name] || C.limitsOf(name) || W.Gratuit;
/** Nombre maximum de périodes de quota (blocs alignés sur l'échéance) dans la durée payée. */
const blocks = (name, days) => Math.max(1, Math.ceil(days / C.quotaDays(name) - 1e-9));
const illName = (key) => (C.illimiteName ? C.illimiteName(key) : 'Illimité');

function row(label, name, price, days) {
  const lim = limitsOf(name);
  const msgs = lim.aiMonth * blocks(name, days);
  const net = price * (1 - FEE);
  const out = { label, price, days, perBlock: lim.aiMonth, msgs, net, cells: MODELS.map(([m, c]) => { const cost = msgs * c; return { m, cost, margin: (net - cost) / net }; }) };
  out.sonnet = out.cells[1];
  return out;
}

const rows = [];
for (const p of Object.values(config.plans)) rows.push(row('Illimité / ' + p.period, illName(p.id), p.priceXAF, p.days));
const custom = [];
const all = process.argv.includes('--tous');
for (const p of Object.values(C.PERIODS)) {
  const max = C.info().periods.find((x) => x.id === p.id).max;
  const amounts = new Set(); for (let a = C.info().minAmount; a <= max; a += all ? 500 : 2500) amounts.add(a); amounts.add(max);
  for (const a of amounts) custom.push(row(`${fmt(a)} / ${p.label}`, C.nameOf(a, p.days), a, p.days));
}
const legacy = Object.values(config.legacyPlans).map((p) => row('(ancien) ' + p.name, p.name, p.priceXAF, config.durationDays));

const line = (r) => `${r.label.padEnd(26)} ${fmt(r.price).padStart(10)}  ${String(r.perBlock).padStart(5)}/pér. x${blocks(r.name || '', r.days)}`;
const show = (title, list) => {
  console.log('\n' + title);
  console.log('forfait'.padEnd(26) + ' ' + 'prix'.padStart(10) + '  ' + 'msgs max'.padStart(9) + '  ' + MODELS.map(([m]) => m.padStart(24)).join(' '));
  for (const r of list) console.log(`${r.label.padEnd(26)} ${fmt(r.price).padStart(10)}  ${fmt(r.msgs).padStart(9)}  ` + r.cells.map((c) => `${(fmt(c.cost) + ' (' + Math.round(c.margin * 100) + ' %)').padStart(24)}`).join(' '));
};
show('Offres Illimité (coût en FCFA, marge entre parenthèses)', rows);
show('Offres historiques (plus vendues)', legacy);
const interesting = all ? custom : custom.filter((r) => r.cells.some((c) => c.margin < TARGET) || /^(10 000|20 000|50 000|100 000)/.test(r.label));
show(`Forfaits sur mesure${all ? '' : ' (extraits : marge < ' + Math.round(TARGET * 100) + ' % ou montants repères)'}`, interesting);

const free = W.Gratuit.aiMonth;
console.log(`\nOffre Gratuite : ${free} messages/mois, coût max par compte et par mois : ` + MODELS.map(([m, c]) => `${m} ${fmt(free * c)} FCFA`).join(' ; '));

const everything = [...rows, ...custom, ...legacy];
const bad = everything.filter((r) => r.cells.some((c) => c.margin < FLOOR));
const under = everything.filter((r) => r.cells.some((c) => c.margin < TARGET));
const worst = (cell) => everything.reduce((a, r) => (r.cells[cell].margin < a.margin ? { margin: r.cells[cell].margin, label: r.label } : a), { margin: 9, label: '' });
console.log(`\nParamètres : frais de paiement ${FEE * 100} %, marge visée ${TARGET * 100} %, plancher ${FLOOR * 100} %.`);
console.log(`Pire marge : Qwen ${Math.round(worst(0).margin * 100)} % (${worst(0).label}) ; Sonnet ${Math.round(worst(1).margin * 100)} % (${worst(1).label}).`);
console.log(`Forfaits sous la marge visée (${Math.round(TARGET * 100)} %) : ${under.length} sur ${everything.length}. Sous le plancher (${Math.round(FLOOR * 100)} %) : ${bad.length}.`);
for (const r of bad.slice(0, 12)) console.log('  DÉFICIT/TROP FAIBLE : ' + r.label + ' -> ' + r.cells.map((c) => `${c.m} ${Math.round(c.margin * 100)} %`).join(' ; '));
if (process.argv.includes('--echec') && bad.length) process.exit(1);
