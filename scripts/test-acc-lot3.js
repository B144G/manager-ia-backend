'use strict';
// Comptabilité lot 3 : écritures sans justificatif, piste d'audit, emprunts. Lancez-le avec : node scripts/test-acc-lot3.js
const { run } = require('./lib/wave2');

const Y = new Date().getUTCFullYear();
const wk = (s) => { const d = new Date(`${s}T00:00:00Z`); while ([0, 6].includes(d.getUTCDay())) d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); };
const D = (m, d) => wk(`${Y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`);

run('Comptabilité lot 3 : sans justificatif, piste d\'audit', async ({ check, owner, mem, other, org2, O, ws, dbx, org }) => {
  const AC = `${O}/accounting`; const AC2 = `${ws(org2)}/accounting`;
  await dbx.prepare("UPDATE org_members SET role = 'admin' WHERE org_id = ? AND role = 'manager'").run(org);
  let r;

  for (const u of [`/unsupported?year=${Y}`, `/audit-trail?year=${Y}`]) {
    r = await mem('GET', `${AC}${u}`);
    check(`droits : ${u.split('?')[0]} refusé à un simple membre`, r.status === 403, r.status);
  }

  r = await owner('GET', `${AC}/unsupported?year=${Y}`);
  check('sans justificatif : liste vide au départ', r.status === 200 && r.json.count === 0 && r.json.entries.length === 0, r.json);

  const two = (extra) => ({ journal: 'OD', date: D(2, 3), label: 'Écriture de test', lines: [{ account: '622', debit: 10000 }, { account: '571', credit: 10000 }], ...extra });
  const a = await owner('POST', `${AC}/entries`, two({ label: 'Sans pièce' }));
  const b = await owner('POST', `${AC}/entries`, two({ label: 'Avec pièce', piece: 'FAC-001' }));
  const c = await owner('POST', `${AC}/entries`, two({ label: 'Sans pièce puis annulée' }));
  check('écritures de test créées', [a, b, c].every((x) => x.status === 201 || x.status === 200), [a.status, b.status, c.status]);
  r = await owner('GET', `${AC}/unsupported?year=${Y}`);
  const labels = r.json.entries.map((e) => e.label);
  check('sans justificatif : « Sans pièce » est listée, pas celle avec pièce', labels.includes('Sans pièce') && !labels.includes('Avec pièce'), labels);
  check('sans justificatif : le total est la somme des débits listés', r.json.total === r.json.entries.reduce((s, e) => s + e.total, 0) && r.json.total >= 20000, r.json.total);

  const rev = await owner('POST', `${AC}/entries/${c.json.id}/reverse`, {});
  check('annulation de l\'écriture de test', rev.status === 200 || rev.status === 201, rev.status);
  r = await owner('GET', `${AC}/unsupported?year=${Y}`);
  const l2 = r.json.entries.map((e) => e.label);
  check('sans justificatif : une écriture annulée et son annulation ne sont plus listées', !l2.includes('Sans pièce puis annulée') && !l2.some((x) => /^Annulation de/.test(x)), l2);

  r = await owner('GET', `${AC}/audit-trail?year=${Y}`);
  const e = r.json.entries;
  check('piste : toutes les écritures de l\'année, la plus récente d\'abord', r.status === 200 && r.json.count >= 4 && e.length === r.json.shown && e[0].id > e[e.length - 1].id, r.json.count);
  check('piste : auteur renseigné', e.every((x) => x.author && x.author.length > 1), e.map((x) => x.author));
  const orig = e.find((x) => x.label === 'Sans pièce puis annulée');
  const inv = e.find((x) => /^Annulation de/.test(x.label));
  check('piste : l\'écriture annulée indique son annulation et inversement', orig && inv && orig.cancelledBy === inv.number && inv.reversesNumber === orig.number, [orig, inv]);
  check('piste : décompte par auteur cohérent', r.json.byAuthor.reduce((s, x) => s + x.count, 0) === r.json.count, r.json.byAuthor);
  r = await owner('GET', `${AC}/audit-trail?year=${Y}&limit=2`);
  check('piste : limite respectée', r.json.shown === 2 && r.json.count >= 4, [r.json.shown, r.json.count]);
  r = await owner('GET', `${AC}/audit-trail?year=abc&limit=99999`);
  check('piste : année invalide → année en cours, limite plafonnée (pas d\'erreur)', r.status === 200 && r.json.year === Y, r.json.year);

  // Cloisonnement : l'autre organisation ne voit rien de ces écritures
  r = await owner('GET', `${AC2}/audit-trail?year=${Y}`);
  check('cloisonnement : le propriétaire de la première organisation n\'accède pas à la seconde', r.status === 404, r.status);
  r = await other('GET', `${AC2}/audit-trail?year=${Y}`);
  check('cloisonnement : l\'autre organisation ne voit pas ces écritures', r.status === 200 && !r.json.entries.some((x) => /Sans pièce/.test(x.label)), r.status);

  // ---------- Emprunts ----------
  const { buildSchedule } = require('../src/workspace/acc-loan-schedule');
  const sch = (o) => buildSchedule({ principal: 1200000, rateBp: 1200, months: 12, method: 'annuity', firstDue: '2026-01-31', ...o });
  let s1 = sch({});
  check('tableau : 12 échéances, capital soldé exactement, solde final 0', s1.length === 12 && s1.reduce((a, x) => a + x.principal, 0) === 1200000 && s1[11].balanceAfter === 0, s1[11]);
  check('tableau : annuités quasi constantes (écart ≤ 12 FCFA) pour 12 % sur 12 mois', (() => { const t = s1.map((x) => x.principal + x.interest); return Math.max(...t.slice(0, 11)) - Math.min(...t.slice(0, 11)) <= 2 && Math.abs(t[11] - t[0]) <= 12; })(), s1.map((x) => x.principal + x.interest));
  check('tableau : dates mensuelles, fin de mois conservée (31 janv → 28 févr)', s1[0].dueDate === '2026-01-31' && s1[1].dueDate === '2026-02-28' && s1[2].dueDate === '2026-03-31', s1.slice(0, 3).map((x) => x.dueDate));
  s1 = sch({ rateBp: 0, principal: 1000003, months: 7 });
  check('tableau : taux 0 %, aucun intérêt, capital 1 000 003 / 7 soldé exactement', s1.every((x) => x.interest === 0) && s1.reduce((a, x) => a + x.principal, 0) === 1000003 && s1[6].balanceAfter === 0, s1.map((x) => x.principal));
  s1 = sch({ method: 'constant_principal', months: 6, principal: 600000 });
  check('tableau : capital constant 100 000, intérêts décroissants', s1.every((x) => x.principal === 100000) && s1[0].interest > s1[5].interest && s1[5].balanceAfter === 0, s1.map((x) => x.interest));
  s1 = sch({ months: 1, principal: 50000 });
  check('tableau : un seul mois : tout le capital à l\'échéance', s1.length === 1 && s1[0].principal === 50000, s1);

  r = await mem('GET', `${AC}/loans`);
  check('droits : emprunts refusés à un simple membre', r.status === 403, r.status);
  for (const [lab, body] of [['durée nulle', { months: 0 }], ['durée trop longue', { months: 400 }], ['taux négatif', { ratePct: -1 }], ['taux trop élevé', { ratePct: 80 }], ['montant nul', { principal: 0 }], ['nom vide', { label: '' }], ['mode inconnu', { method: 'x' }], ['compte inconnu', { account: '999' }], ['échéance avant déblocage', { startDate: D(3, 1), firstDue: D(2, 1) }]]) {
    r = await owner('POST', `${AC}/loans`, { label: 'Prêt test', principal: 1000000, ratePct: 10, months: 10, startDate: D(3, 1), ...body });
    check(`emprunt refusé : ${lab}`, r.status === 400, r.status);
  }
  r = await owner('GET', `${AC}/loans`);
  check('aucun emprunt créé par les refus (rien d\'orphelin)', r.json.loans.length === 0, r.json.loans.length);

  r = await owner('POST', `${AC}/loans`, { label: 'Prêt atelier', lender: 'Banque X', principal: 1200000, ratePct: 12, months: 12, method: 'annuity', startDate: D(3, 1), firstDue: D(4, 1) });
  check('emprunt créé avec écriture de déblocage', r.status === 201 && /^BQ-/.test(r.json.entry), r.json);
  const loan = r.json.id;
  const find = async (q) => ((await owner('GET', `${AC}/entries?q=${encodeURIComponent(q)}`)).json.entries || []);
  let es = await find(`EMP-${loan}`);
  const dis = es.find((x) => /Déblocage/.test(x.label));
  check('déblocage : débit 521, crédit 162, équilibré', dis && dis.lines.some((l) => l.account === '521' && l.debit === 1200000) && dis.lines.some((l) => l.account === '162' && l.credit === 1200000), dis);
  r = await owner('GET', `${AC}/loans/${loan}`);
  check('emprunt : 12 échéances, solde dû 1 200 000, aucune payée', r.json.lines.length === 12 && r.json.outstanding === 1200000 && r.json.paidCount === 0 && r.json.next.n === 1, r.json.next);
  const first = r.json.lines[0];
  r = await owner('POST', `${AC}/loans/${loan}/pay`, { date: D(4, 1) });
  check('échéance 1 comptabilisée', r.status === 201 && r.json.n === 1 && r.json.principal === first.principal && r.json.interest === first.interest, r.json);
  es = await find(`EMP-${loan}-1`);
  const pe = es[0];
  const dsum = pe.lines.reduce((a, l) => a + l.debit, 0); const csum = pe.lines.reduce((a, l) => a + l.credit, 0);
  check('échéance 1 : débit 162 (capital) + 671 (intérêts), crédit 521, équilibrée', dsum === csum && pe.lines.some((l) => l.account === '162' && l.debit === first.principal) && pe.lines.some((l) => l.account === '671' && l.debit === first.interest) && pe.lines.some((l) => l.account === '521' && l.credit === first.principal + first.interest), pe);
  r = await owner('POST', `${AC}/loans/${loan}/pay`, { date: D(5, 4), account: '571' });
  check('échéance 2 (paiement en caisse) : passe dans l\'ordre, journal CA', r.status === 201 && r.json.n === 2 && /^CA-/.test(r.json.entry), r.json);
  r = await owner('GET', `${AC}/loans/${loan}`);
  check('emprunt : 2 payées, solde dû = capital − capital remboursé, intérêts payés cumulés', r.json.paidCount === 2 && r.json.outstanding === 1200000 - r.json.lines[0].principal - r.json.lines[1].principal && r.json.paidInterest === r.json.lines[0].interest + r.json.lines[1].interest, r.json);
  // Annulation de l'échéance 1 : elle redevient à payer (le numéro d'écriture ne sert qu'une fois)
  const rv = await owner('POST', `${AC}/entries/${pe.id}/reverse`, {});
  check('annulation de l\'écriture de l\'échéance 1', rv.status === 200 || rv.status === 201, rv.status);
  r = await owner('GET', `${AC}/loans/${loan}`);
  check('après annulation : l\'échéance 1 redevient à payer', r.json.paidCount === 1 && r.json.next.n === 1, r.json.next);
  r = await owner('POST', `${AC}/loans/${loan}/pay`, { date: D(5, 5) });
  check('l\'échéance 1 peut être comptabilisée à nouveau (une seule écriture active)', r.status === 201 && r.json.n === 1, r.json);
  r = await owner('GET', `${AC}/audit`);
  check('audit : la balance reste équilibrée (aucune alerte de déséquilibre)', !r.json.issues.some((i) => /balance|équilibr/i.test(i.title + i.code) && i.severity === 'error'), r.json.issues.map((i) => i.code));
  r = await owner('GET', `${AC}/loans`);
  check('liste : un emprunt, solde dû cohérent', r.json.loans.length === 1 && r.json.outstanding === r.json.loans[0].outstanding && r.json.outstanding < 1200000, r.json);
  r = await owner('POST', `${AC}/loans/99999/pay`, {});
  check('emprunt inconnu : 404', r.status === 404, r.status);
  r = await other('GET', `${AC2}/loans/${loan}`);
  check('cloisonnement : l\'autre organisation ne voit pas cet emprunt', r.status === 404, r.status);
  r = await owner('POST', `${AC}/loans`, { label: 'Sans déblocage', principal: 300000, ratePct: 0, months: 3, startDate: D(6, 1), disburse: false });
  r = await owner('POST', `${AC}/loans/${r.json.id}/pay`, {});
  check('emprunt non débloqué : le paiement est refusé', r.status === 400, r.status);
});
