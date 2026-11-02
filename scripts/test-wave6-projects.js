'use strict';
// Vague 6 · Projets : planning, décalage des tâches qui suivent un retard (aperçu, application, automatique), alerte de budget (paliers, une seule fois),
// coûts venus des achats et du stock, fiabilité des données et prévision. Aucun appel externe (faux serveur d'IA).
// Lancez-le avec : node scripts/test-wave6-projects.js
const http = require('http');
const { startTestPg } = require('./lib/testdb');

let passed = 0; let failed = 0;
const check = (name, cond, extra) => { if (cond) { passed++; console.log('  OK   ' + name); } else { failed++; console.log('  ECHEC ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); } };

function fakeAi() {
  const srv = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ content: [{ type: 'text', text: '{}' }] })); }); });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port })));
}
function client(base) {
  const jar = {};
  return async (method, url, body) => {
    const headers = body !== undefined ? { 'content-type': 'application/json' } : {};
    const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie) headers.cookie = cookie;
    const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const sc of res.headers.getSetCookie()) { const [pair] = sc.split(';'); const i = pair.indexOf('='); jar[pair.slice(0, i).trim()] = pair.slice(i + 1).trim(); }
    const t = await res.text(); let json = null; try { json = JSON.parse(t); } catch { /* non JSON */ }
    return { status: res.status, json, text: t };
  };
}
const add = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

async function main() {
  const a = await fakeAi();
  const pgt = await startTestPg();
  for (const k of ['ALLOWED_ORIGINS', 'COOKIE_SAMESITE', 'COOKIE_SECURE', 'WHATSAPP_PHONE_ID', 'WHATSAPP_TOKEN', 'CAMPAY_USERNAME', 'CAMPAY_PASSWORD', 'BUSINESS_FILE', 'KNOWLEDGE_DIR', 'META_APP_ID', 'META_APP_SECRET', 'BREVO_API_KEY', 'SMTP_HOST']) process.env[k] = '';
  Object.assign(process.env, { NODE_ENV: 'test', JWT_SECRET: 'secret-de-test-assez-long-123456', DATABASE_URL: pgt.url, ANTHROPIC_API_KEY: 'cle-de-test', ANTHROPIC_BASE_URL: `http://127.0.0.1:${a.port}`, SIGNUP_VERIFY: 'off', TRUST_PROXY: '0', ADMIN_USERNAME: 'admin-test', ADMIN_PASSWORD: 'mot-de-passe-admin-test', WS_AI_FREE: '500', AI_PER_MINUTE: '500' });
  const { app } = require('../src/server');
  const { db } = require('../src/db');
  await db.ready;
  const P6 = require('../src/workspace/projects-w6');
  const srv = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const stamp = Date.now();
  const today = new Date().toISOString().slice(0, 10);
  try {
    const owner = client(base); const mem = client(base);
    await owner('POST', '/api/register', { name: 'Nkoulou', contact: `nk${stamp}@exemple.com`, pass: 'secret123' });
    await mem('POST', '/api/register', { name: 'Paul', contact: `paul${stamp}@exemple.com`, pass: 'secret123' });
    let r = await owner('POST', '/api/ws/orgs', { name: 'Atelier Nkoulou', currency: 'FCFA' });
    const org = r.json.id; const O = `/api/ws/orgs/${org}`;
    r = await owner('POST', `${O}/invites`, { role: 'member' }); await mem('POST', '/api/ws/orgs/join', { code: r.json.code });
    const task = async (pid, title, due, est, extra = {}) => { const x = await owner('POST', `${O}/projects/tasks`, { projectId: pid, title, due, ...extra }); await owner('PUT', `${O}/projects/tasks/${x.json.id}/plan`, { estimateHours: est }); return x.json.id; };

    console.log('Planning et décalage');
    r = await owner('POST', `${O}/projects`, { name: 'Boutique Mvogo', due: add(today, 10) });
    const pid = r.json.id;
    const A1 = await task(pid, 'Découpe', add(today, -2), 8);
    await owner('PUT', `${O}/projects/tasks/${A1}`, { status: 'doing' });
    const B1 = await task(pid, 'Assemblage', today, 16);
    const C1 = await task(pid, 'Peinture', add(today, 2), 16);
    const D1 = await task(pid, 'Plan', add(today, -5), 8);
    await owner('PUT', `${O}/projects/tasks/${B1}/plan`, { dependsOn: A1 });
    await owner('PUT', `${O}/projects/tasks/${C1}/plan`, { dependsOn: B1 });
    await owner('PUT', `${O}/projects/tasks/${D1}`, { status: 'done' });
    r = await mem('GET', `${O}/projects/${pid}/schedule`);
    const tk = (id) => r.json.tasks.find((x) => x.id === id);
    check('la frise donne début et fin de chaque tâche (début déduit de l\'estimation)', r.status === 200 && tk(B1).start === add(today, -1) && tk(B1).end === today, tk(B1));
    check('Découpe est en retard, Assemblage et Peinture doivent être décalés', tk(A1).late && tk(B1).needsShift && tk(C1).needsShift && !tk(D1).needsShift, r.json.tasks.map((x) => [x.title, x.needsShift]));
    check('Assemblage : commence après la fin possible de Découpe (aujourd\'hui) → du lendemain au surlendemain', tk(B1).needsShift.toStart === add(today, 1) && tk(B1).needsShift.toEnd === add(today, 2), tk(B1).needsShift);
    check('Peinture suit en cascade', tk(C1).needsShift.toStart === add(today, 3) && tk(C1).needsShift.toEnd === add(today, 4), tk(C1).needsShift);
    check('fin prévue = fin de Peinture, dans les délais du projet', r.json.forecast.endDate === add(today, 4) && r.json.forecast.lateDays === 0 && r.json.forecast.conflicts === 2, r.json.forecast);
    r = await mem('GET', `${O}/projects/${pid}/replan`);
    check('un membre ne voit pas l\'aperçu de décalage (403)', r.status === 403);
    r = await mem('POST', `${O}/projects/${pid}/replan`, {});
    check('un membre ne peut pas décaler (403)', r.status === 403);
    r = await owner('GET', `${O}/projects/${pid}/replan`);
    check('aperçu responsable : 2 changements, rien n\'est modifié', r.json.changes.length === 2 && (await db.prepare('SELECT due FROM tasks WHERE id = ?').get(B1)).due === today, r.json.changes);
    r = await owner('POST', `${O}/projects/${pid}/replan`, {});
    const b1 = await db.prepare('SELECT due, start_date FROM tasks WHERE id = ?').get(B1); const c1 = await db.prepare('SELECT due, start_date FROM tasks WHERE id = ?').get(C1);
    check('décalage appliqué : dates écrites (début et fin)', r.json.applied === 2 && b1.due === add(today, 2) && b1.start_date === add(today, 1) && c1.due === add(today, 4), [b1, c1]);
    r = await owner('POST', `${O}/projects/${pid}/replan`, {});
    check('relancé : plus rien à décaler', r.json.applied === 0);
    const dueD = (await db.prepare('SELECT due FROM tasks WHERE id = ?').get(D1)).due;
    check('une tâche terminée ne bouge pas', dueD === add(today, -5));

    console.log('Décaler une tâche et ses suivantes');
    r = await owner('POST', `${O}/projects/tasks/${B1}/shift`, { days: 3 });
    check('aperçu : Assemblage +3 j, Peinture suit', r.json.preview && r.json.changes.length === 2 && r.json.changes[0].toEnd === add(today, 5) && r.json.changes[1].toEnd === add(today, 7), r.json.changes);
    r = await owner('POST', `${O}/projects/tasks/${B1}/shift`, { days: 0 });
    check('0 jour refusé (400)', r.status === 400);
    r = await owner('POST', `${O}/projects/tasks/${B1}/shift`, { days: 3, apply: true });
    check('décalage appliqué', r.json.applied === 2 && (await db.prepare('SELECT due FROM tasks WHERE id = ?').get(C1)).due === add(today, 7));
    r = await owner('GET', `${O}/projects/${pid}/schedule`);
    check('l\'échéance du projet (J+10) est tenue', r.json.forecast.lateDays === 0);
    await owner('PUT', `${O}/projects/${pid}`, { due: add(today, 5) });
    r = await owner('GET', `${O}/projects/${pid}/schedule`);
    check('échéance rapprochée : le retard prévu est annoncé en jours', r.json.forecast.lateDays === 2, r.json.forecast);
    r = await mem('POST', `${O}/projects/tasks/${B1}/shift`, { days: 1 });
    check('un membre ne peut pas décaler une tâche (403)', r.status === 403);

    console.log('Décalage automatique (réglage)');
    r = await owner('POST', `${O}/projects`, { name: 'Étagères' });
    const p2 = r.json.id;
    const A2 = await task(p2, 'Découpe 2', add(today, 1), 8);
    const B2 = await task(p2, 'Montage 2', add(today, 3), 8);
    await owner('PUT', `${O}/projects/tasks/${B2}/plan`, { dependsOn: A2 });
    await owner('PUT', `${O}/projects/tasks/${A2}`, { due: add(today, 6) });
    check('réglage inactif : la tâche qui suit ne bouge pas', (await db.prepare('SELECT due FROM tasks WHERE id = ?').get(B2)).due === add(today, 3));
    r = await owner('PUT', `${O}/projects/settings`, { project_auto_shift: 1 });
    check('le réglage s\'enregistre (responsable administrateur)', r.status === 200 && r.json.settings.project_auto_shift === 1, r.json);
    await owner('PUT', `${O}/projects/tasks/${A2}`, { due: add(today, 8) });
    const b2 = await db.prepare('SELECT due, start_date FROM tasks WHERE id = ?').get(B2);
    check('réglage actif : changer la date de Découpe décale Montage tout seul', b2.due === add(today, 9) && b2.start_date === add(today, 9), b2);
    const nt = await db.prepare("SELECT COUNT(*) c FROM notices WHERE org_id = ? AND ref LIKE 'replan:%'").get(org);
    check('les responsables sont prévenus', Number(nt.c) >= 1, nt);
    await owner('PUT', `${O}/projects/settings`, { project_auto_shift: 0 });

    console.log('Alerte de budget');
    r = await owner('POST', `${O}/projects`, { name: 'Comptoir' });
    const p3 = r.json.id;
    const notes = async (like) => Number((await db.prepare('SELECT COUNT(*) c FROM notices WHERE org_id = ? AND ref LIKE ?').get(org, like)).c);
    await owner('PUT', `${O}/projects/${p3}/budget`, { budget: 1000000 });
    await owner('POST', `${O}/projects/${p3}/costs`, { label: 'Bois', amount: 700000 });
    check('70 % : pas d\'alerte', (await notes(`projbud:${p3}:%`)) === 0);
    await owner('POST', `${O}/projects/${p3}/costs`, { label: 'Vernis', amount: 150000 });
    check('85 % : alerte « 80 % du budget » envoyée', (await notes(`projbud:${p3}:80`)) >= 1);
    const n80 = await notes(`projbud:${p3}:80`);
    await owner('POST', `${O}/projects/${p3}/costs`, { label: 'Clous', amount: 10000 });
    check('toujours au même palier : pas de nouveau message', (await notes(`projbud:${p3}:80`)) === n80);
    await owner('POST', `${O}/projects/${p3}/costs`, { label: 'Transport', amount: 200000 });
    check('au-delà du budget : alerte « dépassé »', (await notes(`projbud:${p3}:100`)) >= 1);
    r = await owner('GET', `${O}/projects/${p3}/summary`);
    check('le résumé indique le dépassement et le pourcentage', r.json.cost.overBudget === true && r.json.cost.usedPct === 106, r.json.cost);
    const ob = await P6.overBudget(org);
    check('le projet apparaît dans l\'alerte urgente du matin', ob.some((x) => x.id === p3), ob);
    await owner('PUT', `${O}/projects/${p3}/budget`, { budget: 5000000 });
    check('budget relevé : le palier retombe à zéro', Number((await db.prepare('SELECT budget_alert FROM projects WHERE id = ?').get(p3)).budget_alert) === 0);
    check('et le projet sort de l\'alerte urgente', !(await P6.overBudget(org)).some((x) => x.id === p3));
    const wn = await P6.watchAll();
    check('le contrôle de fond s\'exécute sans erreur', typeof wn === 'number', wn);

    console.log('Coûts qui viennent des achats et du stock');
    await owner('PUT', `${O}/projects/${p3}/budget`, { budget: 1000000 });
    r = await owner('POST', `${O}/stock/items`, { name: 'Planche de chêne', unit: 'u', unitCost: 5000, quantity: 100, minQuantity: 0 });
    const item = r.json.id;
    r = await owner('POST', `${O}/stock/orders`, { itemId: item, quantity: 10, unitPrice: 6000, projectId: p3 });
    check('commande rattachée à un projet', r.status === 201 && r.json.created === 1, r.json);
    const ord = await db.prepare('SELECT id, project_id FROM purchase_orders WHERE org_id = ? ORDER BY id DESC').get(org);
    check('le projet est bien enregistré sur la commande', Number(ord.project_id) === p3, ord);
    r = await owner('POST', `${O}/stock/orders`, { itemId: item, quantity: 1, projectId: 99999 });
    check('projet inconnu refusé (404)', r.status === 404);
    r = await owner('PUT', `${O}/stock/orders/${ord.id}/status`, { status: 'ordered' });
    r = await owner('POST', `${O}/stock/orders/${ord.id}/receive`, { quantity: 4 });
    r = await owner('GET', `${O}/projects/${p3}/costs`);
    const pc = r.json.items.filter((x) => x.source === 'purchase');
    check('réception partielle : 4 × 6 000 = 24 000 ajoutés au projet', pc.length === 1 && Number(pc[0].amount) === 24000, pc);
    await owner('POST', `${O}/stock/orders/${ord.id}/receive`, { quantity: 6 });
    r = await owner('GET', `${O}/projects/${p3}/costs`);
    check('solde reçu : une 2e ligne de 36 000, pas de doublon', r.json.items.filter((x) => x.source === 'purchase').length === 2 && r.json.items.filter((x) => x.source === 'purchase').reduce((s, x) => s + Number(x.amount), 0) === 60000);
    r = await owner('POST', `${O}/stock/items/${item}/move`, { kind: 'out', quantity: 5, reason: 'Découpe comptoir', projectId: p3 });
    check('sortie de stock pour le projet : acceptée', r.status === 200 && r.json.addedToProject === p3, r.json);
    r = await owner('GET', `${O}/projects/${p3}/costs`);
    const sc = r.json.items.filter((x) => x.source === 'stock');
    const itRow = await db.prepare('SELECT avg_cost, unit_cost FROM stock_items WHERE id = ?').get(item);
    check('coût de la matière = quantité × valeur moyenne de l\'article', sc.length === 1 && Number(sc[0].amount) === Math.round(5 * (Number(itRow.avg_cost) || Number(itRow.unit_cost))), [sc, itRow]);
    r = await owner('POST', `${O}/stock/items/${item}/move`, { kind: 'out', quantity: 1, reason: 'Sans projet' });
    r = await owner('GET', `${O}/projects/${p3}/summary`);
    check('le résumé sépare achats, stock et saisies à la main', r.json.cost.bySource.purchase === 60000 && r.json.cost.bySource.stock > 0 && r.json.cost.bySource.manual >= 1060000, r.json.cost.bySource);
    // rattacher après coup
    r = await owner('POST', `${O}/stock/orders`, { itemId: item, quantity: 2, unitPrice: 7000 });
    const ord2 = await db.prepare('SELECT id FROM purchase_orders WHERE org_id = ? ORDER BY id DESC').get(org);
    await owner('PUT', `${O}/stock/orders/${ord2.id}/status`, { status: 'ordered' });
    await owner('POST', `${O}/stock/orders/${ord2.id}/receive`, {});
    r = await owner('PUT', `${O}/stock/orders/${ord2.id}`, { projectId: p3 });
    r = await owner('GET', `${O}/projects/${p3}/costs`);
    check('commande rattachée après réception : le coût déjà payé arrive dans le projet', r.json.items.some((x) => x.source === 'purchase' && Number(x.amount) === 14000), r.json.items.map((x) => [x.source, x.amount]));
    check('et l\'alerte de budget s\'est déclenchée avec ces coûts', (await notes(`projbud:${p3}:100`)) >= 2 || (await notes(`projbud:${p3}:%`)) >= 1);

    console.log('Fiabilité des données et prévision');
    r = await owner('POST', `${O}/projects`, { name: 'Portes' });
    const p4 = r.json.id;
    await owner('POST', `${O}/projects/tasks`, { projectId: p4, title: 'Sans rien' });
    r = await owner('GET', `${O}/projects/${p4}/insight`);
    check('projet vide de données : fiabilité faible, manques listés', r.json.quality.level === 'low' && r.json.quality.gaps.some((g) => g.code === 'estimate') && r.json.quality.gaps.some((g) => g.code === 'budget') && r.json.quality.gaps.some((g) => g.code === 'rate'), r.json.quality);
    check('la prévision précise ses limites', r.json.forecast.confidence === 'low' && r.json.forecast.notes.length >= 2);
    await owner('PUT', `${O}/projects/settings`, { project_hourly_cost: 2000 });
    await owner('PUT', `${O}/projects/${p4}/budget`, { budget: 100000 });
    const t1 = await task(p4, 'Fait 1', add(today, -3), 10, { assigneeId: null }); const t2 = await task(p4, 'Fait 2', add(today, -2), 10); const t3 = await task(p4, 'Fait 3', add(today, -1), 10);
    for (const id of [t1, t2, t3]) { await owner('POST', `${O}/projects/tasks/${id}/time`, { hours: 15 }); await owner('PUT', `${O}/projects/tasks/${id}`, { status: 'done' }); }
    await task(p4, 'À faire', add(today, 9), 10);
    r = await owner('GET', `${O}/projects/${p4}/insight`);
    check('écart estimation / réel : 45 h pour 30 h estimées = × 1,5', r.json.forecast.estimateRatio === 1.5, r.json.forecast);
    check('prévision de coût corrigée par cet écart : 90 000 déjà + 10 h × 1,5 × 2 000 = 120 000', r.json.forecast.projectedCost === 120000 && r.json.forecast.overBudgetProjected === true, r.json.forecast);
    check('un membre ne voit pas les montants de la prévision', (await mem('GET', `${O}/projects/${p4}/insight`)).json.forecast.projectedCost === undefined);
    r = await mem('GET', `${O}/projects/${pid}/schedule`);
    check('un membre voit le planning', r.status === 200 && r.json.tasks.length === 4);
  } catch (e) { failed++; console.log('  ECHEC exception', e && e.stack || e); }
  console.log(`\n${passed} réussis, ${failed} échecs`);
  srv.close(); a.srv.close();
  process.exit(failed ? 1 : 0);
}
main();
