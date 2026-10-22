'use strict';
// Test des modules « Paie » et « Fiscalité et liasse » : calculs, cycle des bulletins, comptabilité, échéances, rôles, isolation entre organisations.
// Lancez-le avec : node scripts/test-finance.js   (base temporaire, faux serveur d'IA, aucun appel externe)
const { spawn } = require('child_process');
const http = require('http');
const net = require('net');
const path = require('path');
const { startTestPg } = require('./lib/testdb');

let passed = 0;
let failed = 0;
const check = (name, cond, extra) => {
  if (cond) { passed++; console.log('  OK   ' + name); } else { failed++; console.log('  ECHEC ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); }
};
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); s.on('error', reject); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (d) => d.toISOString().slice(0, 10);
const plus = (n) => iso(new Date(Date.now() + n * 86400000));

function client(base) {
  const jar = {};
  return async (method, url, body) => {
    const headers = body !== undefined ? { 'content-type': 'application/json' } : {};
    const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie) headers.cookie = cookie;
    const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const sc of res.headers.getSetCookie()) { const [pair] = sc.split(';'); const i = pair.indexOf('='); jar[pair.slice(0, i).trim()] = pair.slice(i + 1).trim(); }
    const t = await res.text();
    let json = null;
    try { json = JSON.parse(t); } catch { /* non JSON */ }
    return { status: res.status, json, text: t };
  };
}

function fakeClaude(port) {
  const seen = { last: null };
  const srv = http.createServer((req, res) => {
    let b = '';
    req.on('data', (d) => { b += d; });
    req.on('end', () => {
      const j = JSON.parse(b || '{}');
      seen.last = { system: Array.isArray(j.system) ? j.system.map((x) => x.text).join('\n\n') : (j.system || ''), messages: j.messages };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ content: [{ type: 'text', text: 'Réponse de test.' }] }));
    });
  });
  return new Promise((resolve) => srv.listen(port, '127.0.0.1', () => resolve({ srv, seen })));
}

async function main() {
  const fport = await freePort();
  const fake = await fakeClaude(fport);
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const pgt = await startTestPg();
  const blank = ['ALLOWED_ORIGINS', 'COOKIE_SAMESITE', 'COOKIE_SECURE', 'SMTP_HOST', 'WHATSAPP_PHONE_ID', 'WHATSAPP_TOKEN', 'CAMPAY_USERNAME', 'CAMPAY_PASSWORD', 'BUSINESS_FILE', 'KNOWLEDGE_DIR'];
  const env = { ...process.env, ...Object.fromEntries(blank.map((k) => [k, ''])), NODE_ENV: 'test', PORT: String(port), JWT_SECRET: 'secret-de-test-assez-long-123456', DATABASE_URL: pgt.url,
    ANTHROPIC_API_KEY: 'cle-de-test', ANTHROPIC_BASE_URL: `http://127.0.0.1:${fport}`, ADMIN_USERNAME: 'admin-test', ADMIN_PASSWORD: 'mot-de-passe-admin-test', TRUST_PROXY: '0', WS_AI_FREE: '100', AI_PER_MINUTE: '500', SIGNUP_VERIFY: 'off', API_PUBLIC_URL: base };
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { await sleep(250); try { up = (await fetch(base + '/api/health')).ok; } catch { /* pas prêt */ } }
  if (!up) { console.log("Le serveur n'a pas démarré.\n" + out); process.exit(1); }

  try {
    const stamp = Date.now();
    const owner = client(base); const mgr = client(base); const mem = client(base); const boss2 = client(base);
    const reg = (c, name, n) => c('POST', '/api/register', { name, contact: `${name.toLowerCase()}${n}@exemple.com`, pass: 'secret123' });
    for (const [c, n] of [[owner, 'Awa'], [mgr, 'Marc'], [mem, 'Paul'], [boss2, 'Zoe']]) await reg(c, n, stamp);
    let r = await owner('POST', '/api/ws/orgs', { name: 'Boutique Awa', currency: 'FCFA' });
    const org = r.json.id;
    r = await boss2('POST', '/api/ws/orgs', { name: 'Autre Société', currency: 'FCFA' });
    const org2 = r.json.id;
    for (const [c, role] of [[mgr, 'manager'], [mem, 'member']]) {
      const inv = await owner('POST', `/api/ws/orgs/${org}/invites`, { role });
      r = await c('POST', '/api/ws/orgs/join', { code: inv.json.code });
    }
    const P = `/api/ws/orgs/${org}/payroll`; const F = `/api/ws/orgs/${org}/fiscal`;
    const P2 = `/api/ws/orgs/${org2}/payroll`; const F2 = `/api/ws/orgs/${org2}/fiscal`;

    console.log('Paie : rôles');
    for (const [who, c] of [['responsable', mgr], ['membre', mem]]) {
      r = await c('GET', P);
      check(`${who} : lecture de la paie -> 403`, r.status === 403, r.json);
      r = await c('POST', `${P}/run`, { month: '2026-09' });
      check(`${who} : lancement de la paie -> 403`, r.status === 403, r.json);
    }
    r = await owner('GET', `${P}?month=2026-09`);
    check('administrateur : paie vide, paramètres par défaut marqués « exemple »', r.status === 200 && r.json.slips.length === 0 && r.json.settings.isDefault === true && /Exemple à vérifier/.test(r.json.settings.disclaimer) && r.json.settings.rules.every((x) => /exemple/.test(x.label)), r.json);
    r = await owner('GET', `${P}?month=2026-13`);
    check('mois invalide -> 400', r.status === 400, r.json);

    console.log('Paie : paramètres');
    r = await owner('PUT', `${P}/settings`, { rules: [{ kind: 'employee', label: 'X', rate: 150, ceiling: 0 }] });
    check('taux > 100 % -> 400', r.status === 400, r.json);
    r = await owner('PUT', `${P}/settings`, { rules: [{ kind: 'employee', label: '', rate: 5 }] });
    check('ligne sans nom -> 400', r.status === 400, r.json);
    r = await owner('PUT', `${P}/settings`, { rules: [{ kind: 'autre', label: 'X', rate: 5 }] });
    check('type de ligne inconnu -> 400', r.status === 400, r.json);
    r = await owner('PUT', `${P}/settings`, { rules: 'x' });
    check('liste invalide -> 400', r.status === 400, r.json);
    r = await owner('PUT', `${P}/settings`, { rules: [{ kind: 'employee', label: 'Retenue sociale', rate: '4,2', ceiling: 750000 }, { kind: 'employee', label: 'Impôt', rate: 5, ceiling: 0 }, { kind: 'employer', label: 'Charge patronale', rate: 11.2, ceiling: 750000 }] });
    check('paramètres enregistrés (taux avec virgule accepté)', r.status === 200, r.json);
    r = await owner('GET', `${P}/settings`);
    check('paramètres relus, plus « par défaut »', r.json.isDefault === false && r.json.rules.length === 3 && r.json.rules[0].rate === 4.2, r.json);
    r = await boss2('GET', `${P2}/settings`);
    check("autre organisation : ses propres paramètres (par défaut), pas ceux d'Awa", r.json.isDefault === true, r.json);

    console.log('Paie : employés et lancement du mois');
    const emp = async (name, salary, status) => {
      const x = await owner('POST', `/api/ws/orgs/${org}/hr/employees`, { name, job: 'Poste', salary });
      if (status) await owner('PUT', `/api/ws/orgs/${org}/hr/employees/${x.json.id}`, { status });
      return x.json.id;
    };
    const eAwa = await emp('Aminata', 300000); const eBob = await emp('Bob', 900000); const eCarl = await emp('Carl', undefined); await emp('Dan', 200000, 'left');
    const eOther = (await boss2('POST', `/api/ws/orgs/${org2}/hr/employees`, { name: 'Étranger', salary: 100000 })).json.id;
    r = await owner('POST', `${P}/run`, { month: '2026-09' });
    check('lancement : 2 brouillons, 1 employé sans salaire ignoré, le parti ignoré', r.status === 201 && r.json.created === 2 && r.json.noSalary.length === 1 && r.json.noSalary[0] === 'Carl', r.json);
    r = await owner('POST', `${P}/run`, { month: '2026-09' });
    check('relancer ne crée pas de doublon', r.json.created === 0 && r.json.existing === 2, r.json);
    r = await owner('GET', `${P}?month=2026-09`);
    const sA = r.json.slips.find((s) => s.employee === 'Aminata'); const sB = r.json.slips.find((s) => s.employee === 'Bob');
    check('bulletin de 300 000 : brut, retenues 12 600 + 15 000, net 272 400, charges 33 600, coût 333 600', sA.gross === 300000 && sA.employeeDeductions === 27600 && sA.net === 272400 && sA.employerCharges === 33600 && sA.employerCost === 333600 && sA.status === 'draft', sA);
    check('plafond appliqué : 900 000 -> social sur 750 000 (31 500) + impôt 45 000, net 823 500, coût 984 000', sB.employeeDeductions === 76500 && sB.net === 823500 && sB.employerCharges === 84000 && sB.employerCost === 984000, sB);
    check('totaux du mois et 2 bulletins en attente', r.json.totals.gross === 1200000 && r.json.totals.net === 1095900 && r.json.totals.employerCost === 1317600 && r.json.pending === 2 && r.json.counts.draft === 2, [r.json.totals, r.json.pending]);
    check('Carl signalé comme sans bulletin', r.json.missing.some((m) => m.name === 'Carl'), r.json.missing);

    console.log('Paie : modification et cycle');
    r = await owner('PUT', `${P}/slips/${sA.id}`, { bonuses: 50000, overtime: 20000, advances: 30000 });
    check('modification du brouillon', r.status === 200, r.json);
    r = await owner('GET', `${P}/slips/${sA.id}`);
    check('recalcul : brut 370 000, retenues 34 040, net 305 960, coût 411 440', r.json.slip.gross === 370000 && r.json.slip.employeeDeductions === 34040 && r.json.slip.net === 305960 && r.json.slip.employerCost === 411440 && r.json.slip.lines.length === 3, r.json.slip);
    r = await owner('PUT', `${P}/slips/${sA.id}`, { advances: 5000000 });
    check('net négatif refusé -> 400', r.status === 400 && /négatif/.test(r.json.error), r.json);
    r = await owner('PUT', `${P}/slips/${sA.id}`, { bonuses: -5 });
    check('prime négative refusée -> 400', r.status === 400, r.json);
    r = await owner('POST', `${P}/slips/${sA.id}/pay`, { method: 'cash' });
    check('payer un brouillon -> 400', r.status === 400, r.json);
    r = await owner('POST', `${P}/slips/${sA.id}/budget`, {});
    check('budget avant validation -> 400', r.status === 400, r.json);
    r = await owner('POST', `${P}/slips/${sA.id}/validate`, {});
    check('validation', r.status === 200, r.json);
    r = await owner('PUT', `${P}/slips/${sA.id}`, { bonuses: 1 });
    check('modifier un bulletin validé -> 400 (verrouillé)', r.status === 400, r.json);
    r = await owner('DELETE', `${P}/slips/${sA.id}`);
    check('supprimer un bulletin validé -> 400', r.status === 400, r.json);
    r = await owner('POST', `${P}/slips/${sA.id}/validate`, {});
    check('valider deux fois -> 400', r.status === 400, r.json);
    await owner('PUT', `${P}/settings`, { rules: [{ kind: 'employee', label: 'Autre', rate: 20, ceiling: 0 }] });
    r = await owner('GET', `${P}/slips/${sA.id}`);
    check('changer les paramètres ne touche pas un bulletin validé', r.json.slip.net === 305960 && r.json.slip.lines.length === 3, r.json.slip);
    r = await owner('POST', `${P}/slips/${sA.id}/pay`, { method: 'troc' });
    check('mode de paiement inconnu -> 400', r.status === 400, r.json);
    r = await owner('POST', `${P}/slips/${sA.id}/pay`, { method: 'mobile', date: '2026-09-30' });
    check('paiement enregistré (date et mode)', r.status === 200, r.json);
    r = await owner('GET', `${P}/slips/${sA.id}`);
    check('bulletin payé : date, mode, statut', r.json.slip.status === 'paid' && r.json.slip.paidDate === '2026-09-30' && r.json.slip.payMethod === 'mobile', r.json.slip);
    r = await owner('POST', `${P}/slips/${sA.id}/pay`, { method: 'cash' });
    check('payer deux fois -> 400', r.status === 400, r.json);
    r = await owner('POST', `${P}/slips/${sA.id}/budget`, {});
    check('enregistrement au budget', r.status === 201, r.json);
    r = await owner('POST', `${P}/slips/${sA.id}/budget`, {});
    check('pas de doublon au budget -> 409', r.status === 409, r.json);
    r = await owner('GET', `/api/ws/orgs/${org}/budget?month=2026-09`);
    const be = r.json.entries.filter((e) => e.category === 'Salaires');
    check('une seule ligne de budget « Salaires » (sortie, coût employeur)', be.length === 1 && be[0].kind === 'expense' && be[0].amount === 411440, r.json.entries);
    r = await owner('DELETE', `${P}/slips/${sB.id}`);
    check('suppression d\'un brouillon', r.status === 200, r.json);
    r = await owner('POST', `${P}/slips`, { employeeId: eCarl, month: '2026-09', base: 150000, bonuses: '10 000' });
    check('bulletin manuel pour Carl (montant avec espace)', r.status === 201, r.json);
    r = await owner('POST', `${P}/slips`, { employeeId: eCarl, month: '2026-09', base: 150000 });
    check('doublon employé/mois -> 409', r.status === 409, r.json);
    r = await owner('POST', `${P}/slips`, { employeeId: eOther, month: '2026-09', base: 100000 });
    check("employé d'une autre organisation -> 404", r.status === 404, r.json);
    r = await owner('POST', `${P}/slips`, { employeeId: eBob, month: '2026-10' });
    check('sans base : reprend le salaire de la fiche employé', r.status === 201, r.json);
    r = await owner('POST', `${P}/slips`, { employeeId: eBob, month: '2026-11', base: 0 });
    check('salaire de base nul -> 400', r.status === 400, r.json);

    console.log('Paie : isolation et IA');
    r = await boss2('GET', `${P}/slips/${sA.id}`);
    check("autre organisation : bulletin inaccessible (route de l'organisation d'Awa) -> 404", r.status === 404, r.json);
    r = await boss2('GET', `${P2}/slips/${sA.id}`);
    check('autre organisation : identifiant du bulletin introuvable dans la sienne -> 404', r.status === 404, r.json);
    r = await boss2('GET', `${P2}?month=2026-09`);
    check("autre organisation : aucun bulletin d'Awa", r.json.slips.length === 0, r.json);
    r = await boss2('PUT', `${P2}/slips/${sA.id}`, { bonuses: 5 });
    check("modifier le bulletin d'une autre organisation -> 404", r.status === 404, r.json);
    r = await owner('POST', `/api/ws/orgs/${org}/ai/chat`, { module: 'payroll', message: 'Où en est la paie ?' });
    check("l'administrateur obtient la réponse IA du module paie", r.status === 200, r.json);
    check("l'IA voit les chiffres de paie (administrateur)", /PAIE 20\d\d-\d\d/.test(fake.seen.last.system) || /PAIE/.test(fake.seen.last.system), fake.seen.last.system.slice(0, 300));
    check("consignes : pas de conseil juridique définitif", /conseil juridique, fiscal ou social définitif/.test(fake.seen.last.system));
    r = await mgr('POST', `/api/ws/orgs/${org}/ai/chat`, { module: 'payroll', message: 'Salaires ?' });
    check('responsable : IA du module paie refusée -> 403', r.status === 403, r.json);
    r = await mgr('POST', `/api/ws/orgs/${org}/ai/chat`, { module: 'general', message: 'Où en suis-je ?' });
    check('responsable : discussion générale OK mais sans montants de paie', r.status === 200 && !/PAIE/.test(fake.seen.last.system) && !/net à payer/.test(fake.seen.last.system) && !/FISCALITÉ/.test(fake.seen.last.system), fake.seen.last.system.slice(-500));

    console.log('Fiscalité : rôles');
    for (const [who, c] of [['responsable', mgr], ['membre', mem]]) {
      for (const u of ['', '/liasse', '/obligations', '/vat']) { r = await c('GET', F + u); check(`${who} : GET fiscal${u} -> 403`, r.status === 403, r.json); }
      r = await c('POST', `${F}/obligations`, { title: 'X', dueDate: '2026-12-01' });
      check(`${who} : créer une échéance -> 403`, r.status === 403, r.json);
    }

    console.log('Fiscalité : liasse à partir des écritures');
    r = await owner('GET', `${F}/liasse?year=2024`);
    check('exercice sans écriture : erreur « aucune écriture » et états vides', r.status === 200 && r.json.issues.some((i) => i.code === 'no-entries') && r.json.ready === false && r.json.bilan.equilibre === true, r.json.issues);
    r = await owner('GET', `${F}/liasse?year=abc`);
    check('année invalide -> 400', r.status === 400, r.json);
    const E = `/api/ws/orgs/${org}/accounting/entries`;
    const ent = async (date, label, lines) => (await owner('POST', E, { journal: 'OD', date, label, lines })).status;
    const sts = [
      await ent('2026-01-05', 'Capital', [{ account: '521', debit: 1000000 }, { account: '101', credit: 1000000 }]),
      await ent('2026-09-10', 'Vente', [{ account: '411', debit: 1192500 }, { account: '701', credit: 1000000 }, { account: '4431', credit: 192500 }]),
      await ent('2026-09-12', 'Achat', [{ account: '601', debit: 400000 }, { account: '4452', debit: 77000 }, { account: '401', credit: 477000 }]),
      await ent('2026-09-30', 'Salaires', [{ account: '661', debit: 150000 }, { account: '571', credit: 150000 }]),
      await ent('2026-09-30', 'Taxes', [{ account: '641', debit: 20000 }, { account: '571', credit: 20000 }]),
      await ent('2026-09-30', 'Intérêts', [{ account: '671', debit: 5000 }, { account: '571', credit: 5000 }]),
      await ent('2026-09-30', 'Impôt sur le résultat', [{ account: '891', debit: 10000 }, { account: '441', credit: 10000 }]),
      await ent('2026-09-30', 'Amortissement', [{ account: '681', debit: 30000 }, { account: '2844', credit: 30000 }]),
      await ent('2026-09-30', 'Frais bancaires', [{ account: '631', debit: 10000 }, { account: '521', credit: 10000 }]),
    ];
    check('9 écritures de test enregistrées', sts.every((s) => s === 201), sts);
    r = await owner('GET', `${F}/liasse?year=2026`);
    const L = r.json;
    check('mention honnête présente sur la liasse', /Document de travail préparé par MANAGER-IA, à faire valider par un expert-comptable avant tout dépôt officiel/.test(L.notice), L.notice);
    const sig = Object.fromEntries(L.sig.lines.map((x) => [x.key, x.amount]));
    check('marge commerciale 600 000, valeur ajoutée 590 000', sig.margeCommerciale === 600000 && sig.valeurAjoutee === 590000, sig);
    check("excédent brut d'exploitation 420 000, résultat d'exploitation 390 000", sig.excedentBrutExploitation === 420000 && sig.resultatExploitation === 390000, sig);
    check('résultat net 375 000 (SIG = compte de résultat), chiffre d\'affaires 1 000 000', sig.resultatNet === 375000 && L.resultat.resultat === 375000 && L.sig.chiffreAffaires === 1000000, [sig.resultatNet, L.resultat.resultat]);
    check('compte de résultat : produits 1 000 000, charges 625 000', L.resultat.totalProduits === 1000000 && L.resultat.totalCharges === 625000, L.resultat);
    check('bilan équilibré : actif = passif = 2 229 500', L.bilan.equilibre === true && L.bilan.totalActif === 2229500 && L.bilan.totalPassif === 2229500, [L.bilan.totalActif, L.bilan.totalPassif]);
    check('aucune erreur bloquante : prête à relire', L.ready === true && L.toFix === 0 && L.entryCount === 9, L.issues);

    // Écritures anormales insérées directement (l'API refuse de les créer) : exercice 2025
    const dbx = await pgt.open();
    const eid = (await dbx.prepare("INSERT INTO acc_entries (org_id, journal, number, date, label, created_at) VALUES (?, 'OD', 'OD-2025-99999', '2025-03-01', 'Anomalie', ?)").run(org, new Date().toISOString())).lastInsertRowid;
    await dbx.prepare("INSERT INTO acc_lines (entry_id, org_id, account, debit, credit) VALUES (?, ?, '901', 5000, 0)").run(eid, org);
    await dbx.prepare("INSERT INTO acc_lines (entry_id, org_id, account, debit, credit) VALUES (?, ?, '571', 0, 3000)").run(eid, org);
    r = await owner('GET', `${F}/liasse?year=2025`);
    const codes = r.json.issues.map((i) => i.code);
    check('contrôles : débit ≠ crédit, écriture déséquilibrée, compte absent du plan, compte non classé', ['balance', 'entry-unbalanced', 'no-account', 'unclassified'].every((c) => codes.includes(c)) && r.json.ready === false && r.json.toFix >= 4, r.json.issues);
    check("liste « à corriger » : l'écriture fautive est nommée", r.json.issues.find((i) => i.code === 'entry-unbalanced').items.includes('OD-2025-99999'), r.json.issues);
    r = await boss2('GET', `${F2}/liasse?year=2026`);
    check("autre organisation : aucune écriture d'Awa dans sa liasse", r.json.entryCount === 0 && r.json.resultat.resultat === 0, r.json);

    console.log('Fiscalité : TVA du mois');
    r = await owner('GET', `${F}/vat?month=2026-09`);
    check('TVA de septembre : collectée 192 500, déductible 77 000, à payer 115 500', r.json.collected === 192500 && r.json.deductible === 77000 && r.json.due === 115500 && r.json.credit === 0 && r.json.available === true, r.json);
    r = await owner('GET', `${F}/vat?month=2026-03`);
    check('mois sans TVA : explication de ce qui manque', r.json.available === false && r.json.missing.length >= 1 && r.json.due === 0, r.json);
    r = await boss2('GET', `${F2}/vat?month=2026-09`);
    check("autre organisation : TVA à zéro, pas celle d'Awa", r.json.collected === 0 && r.json.available === false && r.json.missing.length >= 1, r.json);
    r = await owner('GET', `${F}/vat?month=9`);
    check('mois invalide -> 400', r.status === 400, r.json);

    console.log('Fiscalité : calendrier');
    r = await owner('GET', `${F}/obligations`);
    check('modèles proposés, étiquetés « à confirmer »', r.json.templates.length >= 5 && r.json.templates.every((t) => /confirmer/.test(t.note)) && r.json.items.length === 0, r.json.templates);
    r = await owner('POST', `${F}/obligations`, { title: '', dueDate: plus(3) });
    check('nom obligatoire -> 400', r.status === 400, r.json);
    r = await owner('POST', `${F}/obligations`, { title: 'X', dueDate: plus(3), kind: 'loto' });
    check('type inconnu -> 400', r.status === 400, r.json);
    r = await owner('POST', `${F}/obligations`, { title: 'X', dueDate: '31/12/2026' });
    check('date invalide -> 400', r.status === 400, r.json);
    r = await owner('POST', `${F}/obligations`, { title: 'X' });
    check('échéance obligatoire -> 400', r.status === 400, r.json);
    r = await owner('POST', `${F}/obligations`, { title: 'X', dueDate: plus(3), amount: -5 });
    check('montant négatif -> 400', r.status === 400, r.json);
    const mk = async (b) => (await owner('POST', `${F}/obligations`, b)).json.id;
    const oLate = await mk({ title: 'TVA en retard', kind: 'tva', dueDate: plus(-3), amount: 115500, recurrence: 'monthly' });
    const oSoon = await mk({ title: 'Patente', kind: 'patente', dueDate: plus(3), amount: 80000 });
    await mk({ title: 'États financiers', kind: 'etats', dueDate: plus(60) });
    r = await owner('GET', `${F}/obligations`);
    check('1 en retard, 1 dans les 7 jours, montant en attente cumulé', r.json.late.length === 1 && r.json.late[0].id === oLate && r.json.soon.length === 1 && r.json.soon[0].id === oSoon && r.json.pendingAmount === 195500, [r.json.late, r.json.soon, r.json.pendingAmount]);
    r = await owner('PUT', `${F}/obligations/${oLate}`, { status: 'paid', reference: 'Quittance 2026-0042' });
    check('marquée payée avec justificatif', r.status === 200, r.json);
    r = await owner('GET', `${F}/obligations`);
    const paid = r.json.items.find((o) => o.id === oLate);
    check('plus en retard une fois payée ; date et justificatif conservés', paid.status === 'paid' && paid.doneDate === plus(0) && paid.reference === 'Quittance 2026-0042' && r.json.late.length === 0, paid);
    r = await owner('PUT', `${F}/obligations/${oLate}`, { status: 'inconnu' });
    check('statut inconnu -> 400', r.status === 400, r.json);
    r = await owner('POST', `${F}/obligations/${oLate}/next`, {});
    check("création de l'échéance suivante (récurrence mensuelle)", r.status === 201 && r.json.dueDate > plus(-3), r.json);
    r = await owner('POST', `${F}/obligations/${oLate}/next`, {});
    check("l'échéance suivante n'est pas créée deux fois -> 409", r.status === 409, r.json);
    r = await owner('POST', `${F}/obligations/${oSoon}/next`, {});
    check('obligation non récurrente -> 400', r.status === 400, r.json);
    const o31 = await mk({ title: 'Fin de mois', dueDate: '2099-01-31', recurrence: 'monthly' });
    r = await owner('POST', `${F}/obligations/${o31}/next`, {});
    check('dates : 31 janvier + 1 mois = 28 février', r.status === 201 && r.json.dueDate === '2099-02-28', r.json);
    const oQ = await mk({ title: 'Trimestre', dueDate: '2099-11-30', recurrence: 'quarterly' });
    r = await owner('POST', `${F}/obligations/${oQ}/next`, {});
    check('dates : trimestre depuis le 30 novembre = 28 février suivant', r.json.dueDate === '2100-02-28', r.json);
    r = await boss2('PUT', `${F2}/obligations/${oSoon}`, { status: 'paid' });
    check("modifier l'échéance d'une autre organisation -> 404", r.status === 404, r.json);
    r = await boss2('DELETE', `${F2}/obligations/${oSoon}`);
    check("supprimer l'échéance d'une autre organisation -> 404", r.status === 404, r.json);
    r = await boss2('GET', `${F2}/obligations`);
    check("autre organisation : aucune échéance d'Awa", r.json.items.length === 0, r.json);
    r = await owner('GET', `${F}?year=2026`);
    check("synthèse : résultat provisoire et 1 échéance proche", r.json.kpi.resultat === 375000 && r.json.kpi.soon === 1 && r.json.kpi.late === 0, r.json.kpi);
    r = await owner('DELETE', `${F}/obligations/${oSoon}`);
    check('suppression', r.status === 200, r.json);
    r = await owner('DELETE', `${F}/obligations/${oSoon}`);
    check('supprimer deux fois -> 404', r.status === 404, r.json);

    console.log('Fiscalité : IA');
    r = await owner('POST', `/api/ws/orgs/${org}/ai/chat`, { module: 'fiscal', message: 'Où en suis-je ?' });
    check("l'administrateur voit le résultat provisoire et les échéances", r.status === 200 && /FISCALITÉ/.test(fake.seen.last.system) && /375/.test(fake.seen.last.system) && /Échéances/.test(fake.seen.last.system), fake.seen.last.system.slice(0, 300));
    check('consignes : document de travail, jamais « liasse officielle »', /DOCUMENT DE TRAVAIL/.test(fake.seen.last.system) && /jamais une liasse officielle/.test(fake.seen.last.system));
    r = await mgr('POST', `/api/ws/orgs/${org}/ai/chat`, { module: 'fiscal', message: 'Résultat ?' });
    check('responsable : IA fiscale refusée -> 403', r.status === 403, r.json);
    await dbx.close();
  } catch (e) {
    failed++;
    console.log('  ECHEC exception : ' + (e && e.stack || e));
  }

  child.kill();
  fake.srv.close();
  await pgt.stop();
  console.log(`\n${passed} réussis, ${failed} échec(s)`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
