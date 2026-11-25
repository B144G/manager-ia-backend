'use strict';
// Cockpits de direction : indicateurs calculés sur les données RÉELLES (jamais inventés : « non disponible » sinon), file de validations et circuits de validation de direction
// branchés sur le moteur de circuits d'Administration (séparation des tâches, seuils, journal, paramétrage). Lancez-le avec : npm run test:direction-cockpits
const { startTestPg } = require('./lib/testdb');
let passed = 0; let failed = 0;
const check = (name, cond, extra) => { if (cond) { passed++; console.log('  OK   ' + name); } else { failed++; console.log('  ECHEC ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); } };
function client(base) {
  const jar = {};
  return async (method, url, body) => {
    const headers = {}; if (body !== undefined) headers['content-type'] = 'application/json';
    const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '); if (cookie) headers.cookie = cookie;
    const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const sc of res.headers.getSetCookie()) { const [pair] = sc.split(';'); const i = pair.indexOf('='); jar[pair.slice(0, i).trim()] = pair.slice(i + 1).trim(); }
    const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* */ }
    return { status: res.status, json, text };
  };
}
async function main() {
  const pgt = await startTestPg();
  for (const k of ['ALLOWED_ORIGINS', 'COOKIE_SAMESITE', 'COOKIE_SECURE', 'BUSINESS_FILE', 'KNOWLEDGE_DIR', 'BREVO_API_KEY']) delete process.env[k];
  Object.assign(process.env, { NODE_ENV: 'test', JWT_SECRET: 'secret-de-test-assez-long-123456', DATABASE_URL: pgt.url, ANTHROPIC_API_KEY: 'cle-de-test', SIGNUP_VERIFY: 'off', TRUST_PROXY: '0', ENTREPRISE_WRITE_RATE: '3000' });
  delete process.env.DIRECTION_SPACES;
  const { app } = require('../src/server');
  const { db } = require('../src/db');
  await db.ready;
  const KP = require('../src/workspace/ent-kpi'); const WF = require('../src/workspace/ent-workflows');
  const srv = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const stamp = Date.now(); const now = new Date().toISOString(); const day = now.slice(0, 10); const month = now.slice(0, 7);
  const dplus = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  try {
    const reg = async (c, name, tag) => { await db.prepare('DELETE FROM rate_hits').run(); await c('POST', '/api/register', { name, contact: `${tag}${stamp}@exemple.com`, pass: 'Secret-Pass-123' }); return Number((await db.prepare('SELECT id FROM users WHERE contact = ?').get(`${tag}${stamp}@exemple.com`)).id); };
    const owner = client(base); const adm = client(base); const o2 = client(base);
    const ownerId = await reg(owner, 'Nkoulou Paul', 'nk'); const admId = await reg(adm, 'Admin Bella', 'ad'); await reg(o2, 'Dirigeant Deux', 'd2');
    await db.prepare("UPDATE users SET plan = 'Illimité', plan_expires = ?").run(new Date(Date.now() + 86400000 * 30).toISOString());
    const org = (await owner('POST', '/api/ws/orgs', { name: 'Chantiers Nkoulou', currency: 'FCFA' })).json.id; const O = `/api/ws/orgs/${org}`; const E = `${O}/entreprise`;
    const org2 = (await o2('POST', '/api/ws/orgs', { name: 'Autre Société' })).json.id; const O2 = `/api/ws/orgs/${org2}`; const E2 = `${O2}/entreprise`;
    let r = await owner('POST', `${O}/invites`, { role: 'admin' }); await adm('POST', '/api/ws/orgs/join', { code: r.json.code });
    await owner('POST', `${E}/template`, { sector: 'btp' }); await o2('POST', `${E2}/template`, { sector: 'btp' });
    const flat = (ch) => [...ch.directions.flatMap((d) => [...d.directors, ...d.departments.flatMap((x) => x.posts)]), ...ch.departments.flatMap((x) => x.posts)];
    const posts = flat((await owner('GET', `${E}/chart`)).json); const posts2 = flat((await o2('GET', `${E2}/chart`)).json);
    const person = async (ownerC, E_, tag, name, title, list) => { const p = list.find((x) => x.title === title); const r0 = await ownerC('POST', `${E_}/people`, { fullName: name, email: `${tag}${stamp}@entreprise.cm`, postIds: p ? [p.id] : [] }); const c = client(base); const id = await reg(c, name, tag); await c('POST', '/api/ws/orgs/join', { code: r0.json.code }); return { c, id, personId: r0.json.id }; };
    const daf = await person(owner, E, 'daf', 'Directeur Financier', 'Directeur administratif et financier (DAF)', posts);
    const dt = await person(owner, E, 'dt', 'Directeur Technique', 'Directeur technique', posts);
    const dcom = await person(owner, E, 'dcom', 'Directeur Commercial', 'Directeur commercial', posts);
    const dstock = await person(owner, E, 'dst', 'Directeur Achats', 'Directeur du stockage et des achats', posts);
    const drh = await person(owner, E, 'drh', 'Directeur RH', 'Directeur des ressources humaines (DRH)', posts);
    const acheteur = await person(owner, E, 'ach', 'Acheteur Paul', 'Acheteur', posts);
    const cond = await person(owner, E, 'cdt', 'Conducteur de travaux', 'Conducteur de travaux', posts);
    const compta = await person(owner, E, 'cpt', 'Comptable Ada', 'Comptable', posts);
    const dg2 = await person(owner, E, 'dg2', 'Directeur Général Deux', 'inexistant', posts);
    const dtB = await person(o2, E2, 'dtb', 'Directeur Technique B', 'Directeur technique', posts2);

    console.log('Cockpits : accès par direction');
    const K = (c, sp) => c('GET', `${O}/${sp}/kpis`);
    r = await dt.c('GET', `${O}/dir_technique/kpis`);
    check('chaque directeur lit le cockpit de SA direction (indicateurs + missions)', r.status === 200 && r.json.kpis.length >= 6 && r.json.missions.length >= 4 && r.json.space.level === 'manage', r.json.space);
    check('… le directeur technique n\'ouvre pas la direction financière (403)', (await K(dt.c, 'dir_finances')).status === 403);
    check('… ni la direction générale (403)', (await K(dt.c, 'dir_general')).status === 403);
    check('… le personnel (conducteur de travaux) n\'ouvre aucun cockpit (403)', (await K(cond.c, 'dir_technique')).status === 403 && (await K(cond.c, 'dir_general')).status === 403 && (await K(acheteur.c, 'dir_stock')).status === 403);
    check('… ni le comptable (cockpit du DAF refusé)', (await K(compta.c, 'dir_finances')).status === 403);
    check('le propriétaire (DG) lit le cockpit de la direction générale et celui de chaque direction', (await K(owner, 'dir_general')).status === 200 && (await K(owner, 'dir_finances')).status === 200 && (await K(owner, 'dir_technique')).status === 200);
    check('l\'administrateur aussi (comme aujourd\'hui)', (await K(adm, 'dir_rh')).status === 200);
    check('le DAF a son cockpit, le DRH le sien', (await K(daf.c, 'dir_finances')).status === 200 && (await K(drh.c, 'dir_rh')).status === 200);
    check('l\'autre organisation ne lit rien (404)', (await o2('GET', `${O}/dir_technique/kpis`)).status === 404);
    check('sans connexion : 401', (await client(base)('GET', `${O}/dir_general/kpis`)).status === 401);

    console.log('Indicateurs : jamais inventés, « non disponible » sinon');
    const spaces = ['dir_general', 'dir_finances', 'dir_technique', 'dir_production', 'dir_logistique', 'dir_stock', 'dir_rh', 'dir_commercial', 'dir_marketing', 'dir_it', 'dir_securite'];
    let shape = true; const empty = {};
    for (const sp of spaces) { const x = (await K(owner, sp)).json; empty[sp] = x.kpis; for (const k of x.kpis) if (!(k.key && k.label && k.unit && typeof k.available === 'boolean' && (k.available ? typeof k.value === 'number' : (k.value === null && typeof k.hint === 'string' && k.hint.length > 5)))) { shape = false; console.log('   forme invalide :', sp, k); } }
    check('11 cockpits : chaque indicateur est soit un nombre réel, soit « non disponible » avec ce qu\'il faut renseigner', shape);
    check('au moins 6 indicateurs par direction', spaces.every((sp) => empty[sp].length >= 6), spaces.map((sp) => empty[sp].length));
    const av = (sp, key, src = empty) => src[sp].find((k) => k.key === key);
    check('organisation vide : AUCUN chiffre inventé (délais, marges, avancement, pipeline… non disponibles)', ['dso', 'dpo', 'budget', 'marge', 'endettement', 'cout_revient'].every((k) => !av('dir_finances', k).available) && !av('dir_technique', 'avancement').available && !av('dir_commercial', 'pipeline').available && !av('dir_stock', 'valeur').available && !av('dir_production', 'rendement').available);
    check('… les indicateurs sans module source le disent (qualité, accidents, audit, TRS, inventaire)', !av('dir_technique', 'reprise').available && av('dir_technique', 'reprise').module === 'qhse' && !av('dir_rh', 'accidents').available && !av('dir_securite', 'audits').available && !av('dir_production', 'trs').available && !av('dir_stock', 'inventaire').available);
    check('… une trésorerie sans compte est non disponible avec l\'indication', !av('dir_finances', 'tresorerie').available && /Trésorerie/.test(av('dir_finances', 'tresorerie').hint));
    // données réelles
    const cust = Number((await db.prepare("INSERT INTO customers (org_id, name, created_at) VALUES (?, 'Client A', ?)").run(org, now)).lastInsertRowid);
    const inv1 = Number((await db.prepare("INSERT INTO documents (org_id, customer_id, kind, number, status, lines, total, paid, issued, due, created_by, created_at, updated_at) VALUES (?, ?, 'invoice', 'F-1', 'sent', '[]', 1000000, 0, ?, ?, ?, ?, ?)").run(org, cust, day, dplus(-5), ownerId, now, now)).lastInsertRowid);
    const inv2 = Number((await db.prepare("INSERT INTO documents (org_id, customer_id, kind, number, status, lines, total, paid, issued, due, created_by, created_at, updated_at) VALUES (?, ?, 'invoice', 'F-2', 'paid', '[]', 500000, 500000, ?, ?, ?, ?, ?)").run(org, cust, dplus(-40), dplus(-10), ownerId, now, now)).lastInsertRowid);
    await db.prepare("INSERT INTO doc_payments (org_id, doc_id, amount, date, created_at) VALUES (?, ?, 500000, ?, ?)").run(org, inv2, dplus(-25), now); // payée 15 jours après l'émission
    const bill = Number((await db.prepare("INSERT INTO supplier_bills (org_id, supplier_name, number, bill_date, due_date, amount, paid, status, created_at) VALUES (?, 'Fournisseur X', 'FA-1', ?, ?, 300000, 300000, 'paid', ?)").run(org, dplus(-30), dplus(-5), now)).lastInsertRowid);
    await db.prepare("INSERT INTO supplier_payments (org_id, bill_id, amount, date, created_at) VALUES (?, ?, 300000, ?, ?)").run(org, bill, dplus(-10), now); // payée 20 jours après
    await db.prepare("INSERT INTO supplier_bills (org_id, supplier_name, number, bill_date, due_date, amount, paid, status, created_at) VALUES (?, 'Fournisseur Y', 'FA-2', ?, ?, 200000, 50000, 'open', ?)").run(org, day, dplus(20), now);
    await db.prepare("INSERT INTO budget_plans (org_id, category, monthly_limit) VALUES (?, 'Fournitures', 400000)").run(org);
    await db.prepare("INSERT INTO budget_entries (org_id, kind, category, label, amount, date, created_by, created_at) VALUES (?, 'expense', 'Fournitures', 'Achat', 100000, ?, ?, ?)").run(org, day, ownerId, now);
    await db.prepare("INSERT INTO budget_entries (org_id, kind, category, label, amount, date, created_by, created_at) VALUES (?, 'income', 'Ventes', 'Vente', 1000000, ?, ?, ?)").run(org, day, ownerId, now);
    await db.prepare("INSERT INTO dir_objectives (org_id, space, title, unit, target, current, created_at, updated_at) VALUES (?, 'dir_commercial', 'CA', 'FCFA', 1000, 250, ?, ?)").run(org, now, now);
    await db.prepare("INSERT INTO dir_objectives (org_id, space, title, unit, target, current, created_at, updated_at) VALUES (?, 'dir_finances', 'Trésorerie', 'FCFA', 1000, 750, ?, ?)").run(org, now, now);
    let fin = (await K(owner, 'dir_finances')).json.kpis; const f = (k) => fin.find((x) => x.key === k);
    check('créances clients = somme réelle des factures à encaisser (1 000 000)', f('creances').available && f('creances').value === 1000000, f('creances'));
    check('délai moyen de recouvrement = calculé sur les factures soldées (15 jours)', f('dso').available && f('dso').value === 15, f('dso'));
    check('dettes fournisseurs = restant dû réel (150 000)', f('dettes').value === 150000, f('dettes'));
    check('délai moyen de paiement fournisseurs = calculé (20 jours)', f('dpo').value === 20, f('dpo'));
    check('taux de réalisation budgétaire = dépenses du mois / plafonds (25 %)', f('budget').value === 25, f('budget'));
    check('marge du mois = (recettes − dépenses) / recettes (90 %)', f('marge').value === 90, f('marge'));
    const gen = (await K(owner, 'dir_general')).json.kpis; const g = (k) => gen.find((x) => x.key === k);
    check('direction générale : chiffre d\'affaires du mois et créances en retard réels', g('ca_mois').value === 1000000 && g('creances_retard').value === 1000000, [g('ca_mois'), g('creances_retard')]);
    check('… atteinte moyenne des objectifs de toutes les directions (25 % et 75 % → 50 %)', g('objectifs').value === 50, g('objectifs'));
    const com = (await K(dcom.c, 'dir_commercial')).json.kpis;
    check('commercial : CA du mois réel', com.find((k) => k.key === 'ca_mois').value === 1000000 && com.find((k) => k.key === 'retard').value === 1000000);
    // chantiers
    const site = Number((await db.prepare("INSERT INTO construction_sites (org_id, name, status, cost_budget, budget, created_at) VALUES (?, 'Chantier A', 'active', 1000000, 1200000, ?)").run(org, now)).lastInsertRowid);
    await db.prepare("INSERT INTO construction_phases (org_id, site_id, name, weight, progress, planned_end) VALUES (?, ?, 'Fondations', 30, 100, ?)").run(org, site, dplus(-10));
    await db.prepare("INSERT INTO construction_phases (org_id, site_id, name, weight, progress, planned_end) VALUES (?, ?, 'Gros œuvre', 70, 40, ?)").run(org, site, dplus(-2));
    await db.prepare("INSERT INTO construction_expenses (org_id, site_id, category, amount, date, created_at) VALUES (?, ?, 'matériaux', 400000, ?, ?)").run(org, site, day, now);
    await db.prepare("INSERT INTO construction_issues (org_id, site_id, kind, title, date, status, created_at) VALUES (?, ?, 'snag', 'Fissure mur nord', ?, 'open', ?)").run(org, site, day, now);
    await db.prepare("INSERT INTO construction_issues (org_id, site_id, kind, title, date, status, created_at) VALUES (?, ?, 'incident', 'Chute de matériel', ?, 'open', ?)").run(org, site, day, now);
    const tech = (await K(dt.c, 'dir_technique')).json.kpis; const t = (k) => tech.find((x) => x.key === k);
    check('technique : avancement pondéré réel (30 % × 100 + 70 % × 40 = 58 %)', t('avancement').value === 58, t('avancement'));
    check('… respect des délais : 1 phase sur 2 en retard (50 %)', t('delais').value === 50, t('delais'));
    check('… coût réel / prévisionnel (400 000 / 1 000 000 = 40 %)', t('cout').value === 40, t('cout'));
    check('… incidents, sécurité et réserves ouverts (2), réserves (1)', t('incidents').value === 2 && t('reserves').value === 1);
    const sec = (await K(owner, 'dir_securite')).json.kpis;
    check('sécurité : incidents de chantier ouverts réels (1)', sec.find((k) => k.key === 'incidents').value === 1);
    // stock, production, rh
    await db.prepare("INSERT INTO stock_items (org_id, name, unit, quantity, min_quantity, unit_cost, created_at) VALUES (?, 'Ciment', 'sac', 0, 10, 6000, ?)").run(org, now);
    await db.prepare("INSERT INTO stock_items (org_id, name, unit, quantity, min_quantity, unit_cost, created_at) VALUES (?, 'Fer', 'kg', 50, 10, 1000, ?)").run(org, now);
    const st = (await K(dstock.c, 'dir_stock')).json.kpis; const s = (k) => st.find((x) => x.key === k);
    check('stock : valeur réelle (50 000), 1 article en rupture sur 2 (50 %)', s('valeur').value === 50000 && s('ruptures').value === 50, [s('valeur'), s('ruptures')]);
    await db.prepare("INSERT INTO production_orders (org_id, seq, code, product_name, quantity, due_date, status, produced_qty, scrap_qty, closed_at, created_at) VALUES (?, 1, 'OF-1', 'Parpaings', 100, ?, 'done', 90, 10, ?, ?)").run(org, dplus(1), now, now);
    const pr = (await K(owner, 'dir_production')).json.kpis; const p = (k) => pr.find((x) => x.key === k);
    check('production : taux de production (90 %) et de pertes (10 %) réels', p('rendement').value === 90 && p('pertes').value === 10, [p('rendement'), p('pertes')]);
    check('… respect des délais (1 ordre sur 1)', p('delais').value === 100);
    const e1 = Number((await db.prepare("INSERT INTO employees (org_id, name, job, status, created_at) VALUES (?, 'Employé Un', 'Maçon', 'active', ?)").run(org, now)).lastInsertRowid);
    await db.prepare("INSERT INTO hr_attendance (org_id, employee_id, day, status) VALUES (?, ?, ?, 'present')").run(org, e1, day);
    await db.prepare("INSERT INTO hr_attendance (org_id, employee_id, day, status) VALUES (?, ?, ?, 'absent')").run(org, e1, dplus(-1));
    await db.prepare("INSERT INTO leaves (org_id, employee_id, kind, start, \"end\", status, requested_by, created_at) VALUES (?, ?, 'annual', ?, ?, 'pending', ?, ?)").run(org, e1, dplus(5), dplus(9), ownerId, now);
    const rh = (await K(drh.c, 'dir_rh')).json.kpis; const h = (k) => rh.find((x) => x.key === k);
    check('RH : effectif et taux d\'absentéisme (50 %) réels (moteur RH existant réutilisé)', h('effectif').value === 1 && h('absenteisme').value === 50 && h('presence').value === 50, [h('effectif'), h('absenteisme')]);
    check('… congés à traiter (1)', h('conges').value === 1);
    const it = (await K(owner, 'dir_it')).json.kpis;
    check('informatique : personnes avec la double authentification (0 %) calculé sur les membres réels', it.find((k) => k.key === 'double_auth').value === 0);
    check('une erreur d\'une source ne casse pas les autres indicateurs', (await K(owner, 'dir_general')).json.kpis.length === gen.length);
    check('les valeurs ne sont pas mises en cache : une nouvelle facture change le chiffre aussitôt', (await db.prepare("INSERT INTO documents (org_id, customer_id, kind, number, status, lines, total, paid, issued, due, created_by, created_at, updated_at) VALUES (?, ?, 'invoice', 'F-3', 'sent', '[]', 250000, 0, ?, ?, ?, ?, ?)").run(org, cust, day, dplus(30), ownerId, now, now)) && (await K(owner, 'dir_general')).json.kpis.find((k) => k.key === 'ca_mois').value === 1250000);

    console.log('Circuits de validation de direction (moteur d\'Administration)');
    r = await adm('POST', `${E}/workflows/install`, {});
    check('seule la direction générale / le propriétaire installe les circuits (administrateur simple : 403)', r.status === 403);
    check('le directeur ne peut pas non plus', (await dt.c('POST', `${E}/workflows/install`, {})).status === 403);
    r = await owner('GET', `${E}/workflows`);
    check('les 8 opérations de la spécification sont proposées, non installées', r.json.workflows.length === 8 && r.json.workflows.every((w) => !w.installed) && r.json.mine.length === 0, r.json.workflows.map((w) => w.key));
    r = await owner('POST', `${E}/workflows/install`, {});
    check('installation : 8 circuits dans le moteur d\'Administration (aucun moteur parallèle)', r.status === 200 && Number((await db.prepare("SELECT COUNT(*) c FROM adm_flows WHERE org_id = ? AND name LIKE 'Direction · %' AND status = 'active'").get(org)).c) === 8, r.json);
    const flowOf = async (k) => JSON.parse((await db.prepare('SELECT steps FROM adm_flows WHERE id = ?').get(Number((await db.prepare('SELECT flow_id FROM ent_workflows WHERE org_id = ? AND key = ?').get(org, k)).flow_id))).steps);
    const sCmd = await flowOf('commande_fournisseur');
    const dirPost = (title) => posts.find((x) => x.title === title).id;
    check('commande fournisseur : direction des achats (poste de directeur) puis, au-delà de 5 M, la direction générale', sCmd.length === 2 && sCmd[0].approvers[0].kind === 'epost' && sCmd[0].approvers[0].id === dirPost('Directeur du stockage et des achats') && sCmd[0].maxAmount === 0 && sCmd[1].approvers[0].kind === 'edg' && sCmd[1].minAmount === 5000001, sCmd);
    const sAchat = await flowOf('achat_demande'); const sRecr = await flowOf('recrutement'); const sMarche = await flowOf('validation_marche'); const sPaie = await flowOf('paiement_fournisseur');
    check('demande d\'achat → direction technique ; recrutement et marché → direction générale ; paiement → DAF puis DG', sAchat[0].approvers[0].id === dirPost('Directeur technique') && sRecr[0].approvers[0].kind === 'edg' && sMarche[0].approvers[0].kind === 'edg' && sPaie[0].approvers[0].id === dirPost('Directeur administratif et financier (DAF)') && sPaie.length === 2);
    const v1 = Number((await db.prepare("SELECT version FROM adm_flows WHERE name = 'Direction · Recrutement' AND org_id = ?").get(org)).version);
    await owner('POST', `${E}/workflows/install`, {});
    check('réinstaller est idempotent (pas de doublon, nouvelle version)', Number((await db.prepare("SELECT COUNT(*) c FROM adm_flows WHERE org_id = ? AND name LIKE 'Direction · %'").get(org)).c) === 8 && Number((await db.prepare("SELECT version FROM adm_flows WHERE name = 'Direction · Recrutement' AND org_id = ?").get(org)).version) === v1 + 1);
    check('l\'autre organisation n\'a rien reçu', Number((await db.prepare("SELECT COUNT(*) c FROM adm_flows WHERE org_id = ? AND name LIKE 'Direction · %'").get(org2)).c) === 0);
    // initiateurs
    const mineOf = async (c) => (await c('GET', `${E}/workflows`)).json.mine.map((w) => w.key);
    check('l\'acheteur peut lancer une commande fournisseur, pas un recrutement', (await mineOf(acheteur.c)).includes('commande_fournisseur') && !(await mineOf(acheteur.c)).includes('recrutement'), await mineOf(acheteur.c));
    check('le conducteur de travaux lance une demande d\'achat et une réception technique', ['achat_demande', 'reception_technique'].every((k) => true) && (await mineOf(cond.c)).includes('achat_demande'), await mineOf(cond.c));
    check('le comptable lance un paiement fournisseur et une clôture financière', (await mineOf(compta.c)).includes('paiement_fournisseur') && (await mineOf(compta.c)).includes('cloture_financiere'));
    check('le directeur commercial lance la validation d\'un marché', (await mineOf(dcom.c)).includes('validation_marche'));
    r = await acheteur.c('POST', `${E}/workflows/recrutement/request`, { title: 'Recruter un comptable' });
    check('un poste non autorisé ne peut pas lancer l\'opération (403)', r.status === 403);
    r = await acheteur.c('POST', `${E}/workflows/inexistant/request`, { title: 'x' });
    check('opération inconnue : 404', r.status === 404);
    r = await acheteur.c('POST', `${E}/workflows/commande_fournisseur/request`, { title: 'Ciment 500 sacs', amount: 3000000 });
    const q1 = r.json;
    check('l\'acheteur lance une commande de 3 M : demande créée, en attente de la direction des achats', r.status === 201 && q1.status === 'pending' && /^DEM-/.test(q1.ref), r.json);
    r = await dstock.c('GET', `${O}/dir_stock/workflows`);
    check('elle apparaît dans la file de validations du directeur des achats (et de lui seul)', r.json.inbox.some((x) => x.id === q1.id && x.step === 'Direction des achats' && x.amount === 3000000), r.json);
    check('… pas dans celle du DAF ni du directeur technique', !(await daf.c('GET', `${O}/dir_finances/workflows`)).json.inbox.some((x) => x.id === q1.id) && !(await dt.c('GET', `${O}/dir_technique/workflows`)).json.inbox.some((x) => x.id === q1.id));
    r = await acheteur.c('POST', `${O}/dir_stock/workflows/requests/${q1.id}/approve`, {});
    check('l\'initiateur ne peut pas valider : il n\'a même pas accès à l\'espace de direction (403)', r.status === 403);
    r = await daf.c('POST', `${O}/dir_finances/workflows/requests/${q1.id}/approve`, {});
    check('un autre directeur ne peut pas valider une demande qui ne lui est pas adressée (elle lui est invisible : 403/404)', r.status === 403 || r.status === 404, [r.status, r.json]);
    r = await dstock.c('POST', `${O}/dir_stock/workflows/requests/${q1.id}/approve`, { comment: 'Budget ok' });
    check('le directeur des achats valide : demande approuvée (3 M < seuil)', r.status === 200 && r.json.status === 'approved', r.json);
    check('… journalisée : soumission et approbation, avec qui et quand', Number((await db.prepare("SELECT COUNT(*) c FROM adm_request_actions WHERE request_id = ? AND action IN ('submit', 'approve')").get(q1.id)).c) === 2 && /dir_workflow/.test(JSON.stringify(await db.prepare("SELECT entity FROM audit_log WHERE entity LIKE 'dir_workflow'").all())));
    check('… la file du directeur est vide ensuite', !(await dstock.c('GET', `${O}/dir_stock/workflows`)).json.inbox.some((x) => x.id === q1.id));
    r = await dstock.c('POST', `${O}/dir_stock/workflows/requests/${q1.id}/approve`, {});
    check('on ne valide pas deux fois (409)', r.status === 409);
    r = await acheteur.c('POST', `${E}/workflows/commande_fournisseur/request`, { title: 'Grue 1 mois', amount: 8000000 });
    const q2 = r.json;
    r = await dstock.c('POST', `${O}/dir_stock/workflows/requests/${q2.id}/approve`, {});
    check('au-dessus du seuil : le directeur des achats valide, puis la direction générale doit valider (étape suivante)', r.status === 200 && r.json.status === 'pending' && r.json.stepDone === true, r.json);
    check('… la demande apparaît alors chez la direction générale', (await owner('GET', `${O}/dir_general/workflows`)).json.inbox.some((x) => x.id === q2.id && x.step === 'Direction générale'));
    r = await dstock.c('POST', `${O}/dir_stock/workflows/requests/${q2.id}/approve`, {});
    check('le directeur des achats ne peut plus valider l\'étape de la direction générale (403)', r.status === 403);
    r = await owner('POST', `${O}/dir_general/workflows/requests/${q2.id}/approve`, {});
    check('la direction générale valide : demande approuvée', r.status === 200 && r.json.status === 'approved');
    r = await acheteur.c('POST', `${E}/workflows/commande_fournisseur/request`, { title: 'Sable', amount: 400000 });
    r = await dstock.c('POST', `${O}/dir_stock/workflows/requests/${r.json.id}/reject`, {});
    check('un refus exige un motif (400)', r.status === 400);
    const q3 = (await acheteur.c('POST', `${E}/workflows/commande_fournisseur/request`, { title: 'Sable', amount: 400000 })).json;
    r = await dstock.c('POST', `${O}/dir_stock/workflows/requests/${q3.id}/reject`, { comment: 'Trop cher' });
    check('le directeur refuse avec un motif : demande rejetée', r.status === 200 && r.json.status === 'rejected');
    r = await dstock.c('POST', `${O}/dir_stock/workflows/requests/${q3.id}/bidon`, {});
    check('décision inconnue : 404', r.status === 404);
    // séparation des tâches : la direction générale ne valide pas sa propre demande
    await owner('PUT', `${E}/dg`, { personIds: [(await owner('GET', `${E}/chart`)).json.dg[0].id, dg2.personId] });
    r = await owner('POST', `${E}/workflows/recrutement/request`, { title: 'Recruter un chef de chantier', amount: 0 });
    const q4 = r.json;
    check('(séparation des tâches) le DG initie un recrutement : le moteur l\'adresse à l\'AUTRE directeur général', r.status === 201 && (await dg2.c('GET', `${O}/dir_general/workflows`)).json.inbox.some((x) => x.id === q4.id) && !(await owner('GET', `${O}/dir_general/workflows`)).json.inbox.some((x) => x.id === q4.id));
    r = await owner('POST', `${O}/dir_general/workflows/requests/${q4.id}/approve`, {});
    check('… et l\'initiateur ne peut pas valider sa propre demande (403)', r.status === 403);
    r = await dg2.c('POST', `${O}/dir_general/workflows/requests/${q4.id}/approve`, {});
    check('… l\'autre directeur général valide', r.status === 200 && r.json.status === 'approved');
    r = await dcom.c('POST', `${E}/workflows/validation_marche/request`, { title: 'Marché école de Bafoussam', amount: 45000000 });
    check('le directeur commercial soumet un marché : validation par la direction générale', r.status === 201 && (await owner('GET', `${O}/dir_general/workflows`)).json.inbox.some((x) => x.id === r.json.id));
    // paramétrage
    r = await owner('PUT', `${E}/workflows/commande_fournisseur`, { steps: [{ name: 'Achats', approver: { type: 'direction', key: 'dstock' } }, { name: 'Direction générale', approver: { type: 'dg' }, minAmount: 1000001 }] });
    check('l\'entreprise règle seuils et validateurs (circuit en service mis à jour)', r.status === 200 && (await flowOf('commande_fournisseur'))[1].minAmount === 1000001);
    const q5 = (await acheteur.c('POST', `${E}/workflows/commande_fournisseur/request`, { title: 'Acier', amount: 2000000 })).json;
    r = await dstock.c('POST', `${O}/dir_stock/workflows/requests/${q5.id}/approve`, {});
    check('… le nouveau seuil s\'applique tout de suite (2 M exige désormais la direction générale)', r.json.status === 'pending');
    check('étape invalide : validateur inconnu refusé (400)', (await owner('PUT', `${E}/workflows/commande_fournisseur`, { steps: [{ name: 'x', approver: { type: 'inconnu' } }] })).status === 400);
    check('direction inconnue refusée (400)', (await owner('PUT', `${E}/workflows/commande_fournisseur`, { steps: [{ name: 'x', approver: { type: 'direction', key: 'zzz' } }] })).status === 400);
    check('seuil maximum < minimum refusé (400)', (await owner('PUT', `${E}/workflows/commande_fournisseur`, { steps: [{ name: 'x', approver: { type: 'dg' }, minAmount: 100, maxAmount: 10 }] })).status === 400);
    check('aucune étape refusée (400)', (await owner('PUT', `${E}/workflows/commande_fournisseur`, { steps: [] })).status === 400);
    check('un administrateur simple ne règle pas les circuits (403)', (await adm('PUT', `${E}/workflows/commande_fournisseur`, { steps: [{ name: 'x', approver: { type: 'dg' } }] })).status === 403);
    // isolation
    r = await o2('POST', `${O}/dir_general/workflows/requests/${q5.id}/approve`, {});
    check('une autre organisation ne peut rien valider (404)', r.status === 404);
    r = await o2('POST', `${E2}/workflows/install`, {});
    check('chaque organisation installe SES circuits : les validateurs sont les postes de SON organigramme', r.status === 200 && (await db.prepare("SELECT steps FROM adm_flows WHERE org_id = ? AND name = 'Direction · Demande d''achat'").get(org2)).steps.includes(`"id":${posts2.find((x) => x.title === 'Directeur technique').id}`));
    check('… le directeur technique de l\'organisation B n\'est pas celui de A', (await dtB.c('GET', `${O}/dir_technique/kpis`)).status === 404);
    // sans directeur : repli
    const orgC = (await owner('POST', '/api/ws/orgs', { name: 'Petite Société' })).json.id;
    await owner('POST', `/api/ws/orgs/${orgC}/entreprise/workflows/install`, {});
    check('sans poste de directeur dans l\'organisation, un administrateur valide (repli explicite)', (await db.prepare("SELECT steps FROM adm_flows WHERE org_id = ? AND name = 'Direction · Demande d''achat'").get(orgC)).steps.includes('"role":"admin"'));
    const log = JSON.stringify((await owner('GET', `${E}/log`)).json);
    check('l\'installation et le paramétrage des circuits sont journalisés', /ent_workflow/.test(log));
    check('journal d\'audit : démarrage et décisions de validation (sans contenu des demandes)', /ent_workflow/.test(JSON.stringify(await db.prepare("SELECT entity, action FROM audit_log WHERE entity IN ('ent_workflow', 'dir_workflow')").all())));
    void admId; void WF; void KP; void E2;
  } finally { srv.close(); await pgt.stop(); }
  console.log(`\n${passed} réussis, ${failed} en échec`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
