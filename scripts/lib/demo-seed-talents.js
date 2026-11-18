'use strict';
// Données d'exemple du module RH Talents pour l'entreprise de test (scripts/demo-local.js). Fictives ; chaque étape est isolée (un échec n'arrête pas les autres).
const add = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);

async function seedTalents(call, org, team = [], log = console.log) {
  const T = `/orgs/${org}/talents`; const today = new Date().toISOString().slice(0, 10); const year = Number(today.slice(0, 4));
  const failed = [];
  const must = async (method, path, body, expect = [200, 201]) => {
    const r = await call(method, T + path, body);
    if (!expect.includes(r.status)) throw new Error(`${method} ${path} → ${r.status} ${(r.json && r.json.error) || r.text || ''}`.slice(0, 200));
    return r.json || {};
  };
  const step = async (label, fn) => { try { const r = await fn(); log('  OK    ' + label); return r; } catch (e) { failed.push(label + ' : ' + e.message); log('  ECHEC ' + label + ' -> ' + e.message); return null; } };
  const hr = await call('GET', `/orgs/${org}/hr`);
  const emps = (hr.json && hr.json.employees) || [];
  if (!emps.length) { log('  (aucun employé : RH Talents non rempli)'); return { failed }; }
  const byName = (n) => emps.find((e) => e.name.startsWith(n)) || emps[0];
  const cid = {}; const jid = {}; const did = {};
  await step('Talents : compétences, services, emplois', async () => {
    for (const [n, c] of [['Menuiserie', 'Métier'], ['Lecture de plans', 'Technique'], ['Gestion de projet', 'Management'], ['Relation client', 'Comportement'], ['Sécurité au travail', 'Technique'], ['Gestion de caisse', 'Métier']]) cid[n] = (await must('POST', '/competencies', { name: n, category: c })).id;
    for (const [n, b] of [['Atelier', 6], ['Commercial', 3], ['Administration', 2]]) did[n] = (await must('POST', '/departments', { name: n, budgetHeadcount: b })).id;
    for (const [t, f, d, reqs] of [['Menuisier', 'Production', 'Atelier', [['Menuiserie', 4, 2], ['Lecture de plans', 3, 1], ['Sécurité au travail', 3, 1]]], ["Chef d'atelier", 'Production', 'Atelier', [['Menuiserie', 5, 2], ['Gestion de projet', 4, 2], ['Sécurité au travail', 4, 1], ['Lecture de plans', 4, 1]]], ['Commercial', 'Vente', 'Commercial', [['Relation client', 4, 2], ['Gestion de caisse', 3, 1]]]]) {
      jid[t] = (await must('POST', '/job-profiles', { title: t, family: f, departmentId: did[d] })).id;
      await must('PUT', `/job-profiles/${jid[t]}/competencies`, { competencies: reqs.map(([n, l, w]) => ({ competencyId: cid[n], requiredLevel: l, weight: w })) });
    }
  });
  await step('Talents : rattachement des employés, genres, compétences détenues', async () => {
    const plan = [['Éric', 'Menuisier', 'Atelier', 'M'], ['Paul', "Chef d'atelier", 'Atelier', 'M'], ['Zoé', 'Commercial', 'Commercial', 'F'], ['Awa', null, 'Administration', 'F']];
    for (const [n, job, dep, g] of plan) { const e = emps.find((x) => x.name.startsWith(n)); if (e) await must('PUT', `/profiles/${e.id}`, { jobProfileId: job ? jid[job] : null, departmentId: did[dep], gender: g, level: 1 }); }
    const sk = { Éric: { Menuiserie: 3, 'Lecture de plans': 2, 'Sécurité au travail': 3 }, Paul: { Menuiserie: 5, 'Gestion de projet': 3, 'Sécurité au travail': 4, 'Lecture de plans': 4 }, Zoé: { 'Relation client': 5, 'Gestion de caisse': 2 } };
    for (const [n, m] of Object.entries(sk)) { const e = emps.find((x) => x.name.startsWith(n)); if (e) for (const [c, l] of Object.entries(m)) await must('PUT', '/skills', { employeeId: e.id, competencyId: cid[c], level: l }); }
    const paul = emps.find((x) => x.name.startsWith('Paul')); const eric = emps.find((x) => x.name.startsWith('Éric'));
    if (paul && eric) await must('PUT', `/profiles/${eric.id}`, { managerId: paul.id });
  });
  await step('Talents : besoins futurs et plan d’actions', async () => {
    await must('PUT', '/gpec/needs', { year, jobProfileId: jid.Menuisier, needed: 4, note: 'Nouvelle ligne de production' });
    const eric = byName('Éric'); await must('POST', '/actions', { kind: 'gpec', title: 'Former Éric à la lecture de plans', employeeId: eric.id, competencyId: cid['Lecture de plans'], dueDate: add(today, 60) });
  });
  await step('Talents : objectifs en cascade (SMART)', async () => {
    const period = String(year);
    const c = await must('POST', '/goals', { level: 'company', title: "Augmenter le chiffre d'affaires de l'atelier", unit: 'FCFA', start: 20000000, target: 24000000, current: 20000000, due: add(today, 240), weight: 100, period, status: 'active' });
    const t = await must('POST', '/goals', { level: 'team', parentId: c.id, departmentId: did.Atelier, title: 'Livrer vingt meubles supplémentaires par trimestre', unit: 'meubles', start: 0, target: 20, due: add(today, 150), weight: 60, period, status: 'active' });
    const paul = byName('Paul'); const eric = byName('Éric');
    for (const [e, title, tg, cur, w] of [[paul, 'Réduire à cinq jours le délai moyen de fabrication', 5, 3, 60], [paul, 'Former trois apprentis à la sécurité', 3, 2, 40]]) {
      const g = await must('POST', '/goals', { level: 'individual', parentId: t.id, employeeId: e.id, title, unit: 'unités', start: 0, target: tg, due: add(today, 120), weight: w, period, status: 'active' });
      await must('PUT', `/goals/${g.id}/progress`, { value: cur });
    }
    const g2 = await must('POST', '/goals', { level: 'individual', parentId: t.id, employeeId: eric.id, title: 'Livrer douze meubles de qualité sans reprise', unit: 'meubles', start: 0, target: 12, due: add(today, 120), weight: 100, period, status: 'active' });
    await must('PUT', `/goals/${g2.id}/progress`, { value: 7 });
  });
  await step('Talents : recrutement par compétences', async () => {
    const j = await must('POST', '/recruitment/jobs', { profileId: jid.Menuisier, departmentId: did.Atelier, openedAt: add(today, -25), recruitCost: 150000 });
    const sc = { 'Samuel Etoa': [4, 3, 3], 'Carine Mbia': [3, 2, 2], 'Joël Fotso': [5, 4, 4] };
    for (const [n, s] of Object.entries(sc)) {
      const c = await must('POST', '/recruitment/candidates', { jobId: j.id, name: n, source: 'recommandation', expectedSalary: 140000 });
      for (const [i, k] of ['Menuiserie', 'Lecture de plans', 'Sécurité au travail'].entries()) await must('POST', `/recruitment/candidates/${c.id}/scores`, { competencyId: cid[k], score: s[i] });
      if (n === 'Joël Fotso') await must('PUT', `/recruitment/candidates/${c.id}`, { stage: 'interview' });
    }
  });
  await step('Talents : évaluation 360° (ouverte)', async () => {
    const camp = (await must('POST', '/360/campaigns', { title: `Évaluation 360° ${year}`, period: String(year), minResponses: 3, competencyIds: [cid['Gestion de projet'], cid['Relation client'], cid['Sécurité au travail']] })).id;
    const paul = byName('Paul'); const others = emps.filter((e) => e.id !== paul.id).slice(0, 4);
    await must('POST', `/360/campaigns/${camp}/subjects`, { employeeId: paul.id, raters: others.map((e) => ({ employeeId: e.id, relation: 'peer' })) });
    await must('PUT', `/360/campaigns/${camp}/status`, { status: 'open' });
  });
  await step('Talents : formation (catalogue, budget, session)', async () => {
    const co = await must('POST', '/training/courses', { title: 'Lecture de plans de menuiserie', provider: 'Centre de formation technique', hours: 16, unitCost: 60000 });
    await must('PUT', `/training/courses/${co.id}/competencies`, { competencies: [{ competencyId: cid['Lecture de plans'], targetLevel: 4 }] });
    await must('PUT', '/training/budget', { year, amount: 500000 });
    const eric = byName('Éric'); const rq = await must('POST', '/training/requests', { employeeId: eric.id, courseId: co.id, year, reason: 'Écart de compétence' });
    await must('PUT', `/training/requests/${rq.id}/decision`, { decision: 'approved' });
    const s = await must('POST', '/training/sessions', { courseId: co.id, startDate: add(today, 20), endDate: add(today, 21), place: 'Douala' });
    await must('POST', `/training/sessions/${s.id}/attendees`, { employeeIds: [eric.id] });
  });
  await step('Talents : 9-box, viviers, PDI', async () => {
    for (const [n, p, q] of [['Paul', 4.3, 4.1], ['Éric', 3.4, 4.0], ['Zoé', 4.6, 3.0], ['Awa', 3.0, 3.0]]) { const e = emps.find((x) => x.name.startsWith(n)); if (e) await must('PUT', '/talent/reviews', { employeeId: e.id, period: String(year), performance: p, potential: q }); }
    const pool = await must('POST', '/talent/pools', { name: 'Futurs responsables d’atelier' }); await must('POST', `/talent/pools/${pool.id}/members`, { employeeId: byName('Éric').id });
    const idp = await must('POST', '/talent/idp', { employeeId: byName('Éric').id, title: "Devenir chef d'atelier", targetJobProfileId: jid["Chef d'atelier"], horizon: '3 ans' });
    await must('POST', '/actions', { kind: 'pdi', refId: idp.id, employeeId: byName('Éric').id, title: 'Formation en gestion de projet', dueDate: add(today, 120) });
  });
  await step('Talents : rémunération et effectifs', async () => {
    for (const [t, mn, md, mx] of [['Menuisier', 100000, 140000, 190000], ["Chef d'atelier", 180000, 240000, 320000], ['Commercial', 90000, 130000, 180000]]) await must('POST', '/comp/grades', { jobProfileId: jid[t], level: 1, minSalary: mn, midSalary: md, maxSalary: mx });
    await must('POST', '/comp/simulate', { name: 'Révision annuelle', save: true, generalPct: 4, minToGrade: true, meritByBox: { 9: 4, 8: 3 } });
    const sc = await must('POST', '/workforce/scenarios', { name: 'Embauches de croissance', year, chargesRate: 0.2 });
    await must('POST', `/workforce/scenarios/${sc.id}/lines`, { departmentId: did.Atelier, jobProfileId: jid.Menuisier, qty: 2, startMonth: 7 });
  });
  await step('Talents : succession, rétention, engagement', async () => {
    const kp = await must('POST', '/career/key-positions', { title: "Chef d'atelier", jobProfileId: jid["Chef d'atelier"], holderId: byName('Paul').id, criticality: 3 });
    await must('PUT', `/career/key-positions/${kp.id}/successors`, { employeeId: byName('Éric').id, readiness: '1-2y' });
    await must('PUT', `/career/retention/${byName('Paul').id}`, { risk: 'medium', reason: 'Sollicité par un concurrent', plan: 'Entretien de carrière et révision salariale' });
    const sv = await must('POST', '/engagement/surveys', { title: 'Pouls du trimestre', minResponses: 3, questions: ['Je me sens soutenu par mon responsable', 'Je comprends les objectifs de mon équipe'] });
    await must('PUT', `/engagement/surveys/${sv.id}/status`, { status: 'open' });
    let k = 0; for (const m of team) { if (!m.call) continue; await m.call('POST', `${T}/engagement/surveys/${sv.id}/respond`, { answers: { enps: [10, 9, 8, 6][k % 4], q1: 4, q2: 5 } }); k++; }
  });
  return { failed };
}
module.exports = { seedTalents };
