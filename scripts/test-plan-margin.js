'use strict';
// Rentabilité des forfaits : aucun forfait vendu ne doit coûter plus cher à servir que ce qu'il rapporte, même si l'usage est maximal.
// Sans base de données ni réseau. Lancez-le avec : node scripts/test-plan-margin.js
const { execFileSync } = require('child_process');
const path = require('path');
Object.assign(process.env, { NODE_ENV: 'test', JWT_SECRET: 'secret-de-test-assez-long-123456', DATABASE_URL: 'postgresql://t:t@localhost:5432/t' });
delete process.env.AI_COST_PER_MSG_XAF; delete process.env.PLAN_TARGET_MARGIN; delete process.env.PLAN_MIN_MARGIN; delete process.env.PAYMENT_FEE_PCT;
const config = require('../src/config');
const C = require('../src/services/custom-plan');
const E = require('../src/services/plan-economics');

let passed = 0; let failed = 0;
const check = (name, cond, extra) => { if (cond) { passed++; console.log('  OK   ' + name); } else { failed++; console.log('  ECHEC ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); } };
const PER = Object.values(C.PERIODS);
const blocks = (name, days) => Math.max(1, Math.ceil(days / C.quotaDays(name) - 1e-9));
const marginOf = (name, price, days) => E.marginOf(price, C.limitsFor(name).aiMonth, blocks(name, days));

console.log('Hypothèses');
check('coût d\'un message par défaut : 13 FCFA (Claude Sonnet 5.5, le cas le plus cher prévu)', E.COST_XAF === 13, E.COST_XAF);
check('frais de paiement 3 %, marge visée 50 %, plancher 30 %', E.FEE === 0.03 && E.TARGET === 0.5 && E.FLOOR === 0.3, [E.FEE, E.TARGET, E.FLOOR]);

console.log('Offres Illimité');
for (const p of Object.values(config.plans)) {
  const name = C.illimiteName(p.id);
  const m = marginOf(name, p.priceXAF, p.days);
  check(`Illimité / ${p.period} (${p.priceXAF} FCFA) : marge au pire cas ≥ marge visée (${Math.round(m * 100)} %)`, m >= E.TARGET - 0.001, m);
  check(`Illimité / ${p.period} : tout reste ouvert (équipe, organisations)`, C.limitsFor(name).members === 9999 && C.limitsFor(name).orgs === 999);
}
const perMonth = Object.values(config.plans).map((p) => C.limitsFor(C.illimiteName(p.id)).aiMonth);
check('messages par mois : la semaine (ramenée au mois) ≥ mois ≥ trimestre ≥ semestre ≥ an', perMonth[0] * 30 / 7 >= perMonth[1] && perMonth.slice(1).every((v, i, a) => i === 0 || v <= a[i - 1]), perMonth);
check('Illimité d\'un mois : jamais plus de 6 000 messages (plafond d\'origine)', C.limitsFor('Illimité').aiMonth <= 6000, C.limitsFor('Illimité').aiMonth);

console.log('Forfaits sur mesure : toutes les sommes (pas de 500 FCFA) de toutes les durées');
let worst = { m: 9, w: '' }; let belowTarget = 0; let n = 0; const issues = [];
for (const p of PER) {
  const max = C.info().periods.find((x) => x.id === p.id).max;
  let prev = -1; let prevDay = Infinity;
  for (let a = C.info().minAmount; a <= max; a += 500) {
    const name = C.nameOf(a, p.days); const q = C.quote(a, p.id);
    const m = marginOf(name, a, p.days); n++;
    if (m < worst.m) worst = { m, w: `${a}/${p.id}` };
    if (m < E.FLOOR) issues.push(`marge ${Math.round(m * 100)} % : ${a} / ${p.id}`);
    if (m < E.TARGET - 0.001) { belowTarget++; if (q.limits.aiMonth > (p.id === 'week' ? 20 : config.workspaceLimits.Gratuit.aiMonth)) issues.push(`sous la marge visée sans la garantie Gratuit : ${a} / ${p.id}`); }
    if (q.limits.aiMonth < prev) issues.push(`quota qui baisse avec la somme : ${a} / ${p.id}`);
    if (C.limitsFor(name).aiMonth !== q.limits.aiMonth) issues.push(`limites incohérentes : ${a} / ${p.id}`);
    prev = q.limits.aiMonth;
  }
}
check(`${n} forfaits : aucun sous le plancher de marge (${Math.round(E.FLOOR * 100)} %) même à usage maximal (pire cas ${Math.round(worst.m * 100)} % : ${worst.w})`, issues.length === 0, issues.slice(0, 5));
check('le quota IA ne baisse jamais quand la somme augmente (pour chaque durée)', !issues.some((x) => /baisse/.test(x)));
check(`les seuls forfaits sous la marge visée (${belowTarget}) sont ceux qui garantissent le quota de l'offre Gratuite (petites sommes, très longue durée)`, !issues.some((x) => /garantie Gratuit/.test(x)), issues.filter((x) => /garantie/.test(x)).slice(0, 3));
check('chaque forfait payant a au moins le quota de l\'offre Gratuite (tant que le plancher le permet)', PER.every((p) => C.quote(10000, p.id).limits.aiMonth >= (p.id === 'week' ? 20 : config.workspaceLimits.Gratuit.aiMonth)));
for (const p of PER) {
  const a = Math.min(20000, C.info().periods.find((x) => x.id === p.id).max);
  const q = C.quote(a, p.id);
  check(`${a} FCFA / ${p.label} : bornée par la marge visée sauf garantie Gratuit (${q.limits.aiMonth} messages)`, q.limits.aiMonth <= Math.max(E.targetCap(a, p.blocks), config.workspaceLimits.Gratuit.aiMonth, 20));
}
const wk = [10000, 20000, 40000].map((a) => C.quote(a, 'week').limits.aiMonth); const mo = [10000, 20000, 40000].map((a) => C.quote(a, 'month').limits.aiMonth);
check('même somme : une semaine donne plus de messages par jour qu\'un mois', [10000, 20000, 40000].every((a) => C.quote(a, 'week').aiPerDay > C.quote(a, 'month').aiPerDay), [wk, mo]);
check('somme maximale d\'une durée = Illimité de cette durée : même quota et même nom lisible', PER.every((p) => { const max = C.info().periods.find((x) => x.id === p.id).max; return C.label(C.nameOf(max, p.days)).startsWith('Illimité') && C.quote(max, p.id).rank === 4; }));
check('offres historiques toujours rentables au pire cas (Pro, Pro Max, Méga Pro)', Object.values(config.legacyPlans).every((p) => E.marginOf(p.priceXAF, config.workspaceLimits[p.name].aiMonth, 1) >= E.TARGET - 0.001));

console.log('Pièces jointes');
const { attachmentParts } = require('../src/workspace/ai');
const b64 = Buffer.from('x'.repeat(100)).toString('base64');
check('une image compte 1 message en plus, un PDF 8, un fichier texte 1', attachmentParts([{ name: 'a.png', mime: 'image/png', data: b64 }]).extra === 1 && attachmentParts([{ name: 'a.pdf', mime: 'application/pdf', data: b64 }]).extra === 8 && attachmentParts([{ name: 'a.txt', mime: 'text/plain', data: b64 }]).extra === 1);
check('sans pièce jointe : aucun supplément', attachmentParts(undefined).extra === 0);

console.log('Le garde-fou suit le coût du modèle (autres hypothèses, nouvelle exécution du script d\'audit)');
const audit = path.join(__dirname, 'audit-plan-margin.js');
for (const cost of ['6', '13', '25']) {
  let ok = true; let out = '';
  try { out = execFileSync(process.execPath, [audit, '--tous', '--echec'], { env: { ...process.env, AI_COST_PER_MSG_XAF: cost }, encoding: 'utf8' }); } catch (e) { ok = false; out = String(e.stdout || e.message); }
  check(`coût d'un message ${cost} FCFA : aucune marge sous le plancher (${(out.match(/Sous le plancher \(\d+ %\) : (\d+)/) || [])[1]} cas)`, ok && /Sous le plancher \(\d+ %\) : 0\./.test(out), out.split('\n').slice(-4));
}

console.log(`\n${passed} réussis, ${failed} échecs`);
process.exit(failed ? 1 : 0);
