'use strict';
// Comptabilité « niveau pro » : analytique, modèles de saisie, écritures récurrentes, clôture annuelle et à-nouveaux, comparatif, ratios,
// contrôles, exports, plan comptable étendu, synthèse. Lancez-le avec : node scripts/test-acc-pro.js
const { run } = require('./lib/wave2');

const Y = new Date().getUTCFullYear(); const P = Y - 1;
// Premier jour ouvré (lundi à vendredi) à partir d'une date : évite le signalement « week-end » là où il n'est pas voulu.
const wk = (s) => { const d = new Date(`${s}T00:00:00Z`); while ([0, 6].includes(d.getUTCDay())) d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); };
const sat = (s) => { const d = new Date(`${s}T00:00:00Z`); while (d.getUTCDay() !== 6) d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); };
const D = (m, d) => wk(`${P}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`);

run('Comptabilité pro : analytique, modèles, récurrentes, clôture annuelle, ratios, contrôles, exports', async ({ check, owner, mgr, mem, other, org, org2, O, ws, dbx }) => {
  const AC = `${O}/accounting`; const AC2 = `${ws(org2)}/accounting`;
  const sumLines = (e) => e.lines.reduce((a, l) => ({ d: a.d + l.debit, c: a.c + l.credit }), { d: 0, c: 0 });
  const balanced = (e) => { const t = sumLines(e); return t.d === t.c && t.d > 0; };
  const entryOf = async (c, base, id, q) => ((await c('GET', `${base}/entries?q=${encodeURIComponent(q)}`)).json.entries || []).find((e) => e.id === id);
  const manual = (c, base, body) => c('POST', `${base}/entries`, body);
  await dbx.prepare("UPDATE org_members SET role = 'admin' WHERE org_id = ? AND role = 'manager'").run(org); // Marc devient administrateur ; Paul reste simple membre
  let r;

  // ---------- Droits : réservé aux administrateurs ----------
  for (const [m, u] of [['GET', '/analytics/sections'], ['GET', '/templates'], ['GET', '/recurring'], ['GET', `/year-end?year=${P}`], ['GET', '/ratios'], ['GET', '/audit'], ['GET', '/insights'], ['GET', '/export/balance.csv'], ['GET', '/analytics/report'], ['POST', '/recurring/run']]) {
    r = await mem(m, `${AC}${u}`, m === 'POST' ? {} : undefined);
    check(`droits : ${m} ${u.split('?')[0]} refusé à un simple membre`, r.status === 403, r.status);
  }

  // ---------- Plan comptable étendu et recherche ----------
  r = await owner('GET', `${AC}/accounts`);
  const codes = new Set(r.json.accounts.map((a) => a.code));
  check('plan étendu : plus de 250 comptes, dont 6412 (patentes), 895 (IMF) et 2451', r.json.accounts.length >= 250 && ['6412', '895', '2451', '6611', '791', '852'].every((c) => codes.has(c)), r.json.accounts.length);
  check('plan étendu : aucun doublon de numéro', codes.size === r.json.accounts.length);
  check('plan étendu : libellé du compte de base inchangé (622)', r.json.accounts.find((a) => a.code === '622').label === 'Locations et charges locatives');
  r = await owner('GET', `${AC}/accounts?q=loyer`);
  check('recherche de comptes par libellé', r.json.accounts.length === 0 || r.json.accounts.every((a) => /loyer/i.test(a.label) || a.code.startsWith('loyer')), r.json.accounts.length);
  r = await owner('GET', `${AC}/accounts?q=locations`);
  check('recherche de comptes : « locations » trouve 622 et 6222', r.json.accounts.some((a) => a.code === '622') && r.json.accounts.some((a) => a.code === '6222'), r.json.accounts.map((a) => a.code));
  r = await owner('GET', `${AC}/accounts?q=64`);
  check('recherche de comptes par numéro : préfixe 64', r.json.accounts.length >= 5 && r.json.accounts.some((a) => a.code === '6412') && r.json.accounts.every((a) => a.code.startsWith('64') || /64/.test(a.label)), r.json.accounts.length);
  r = await owner('GET', `${AC}/accounts?q=zzzzzz`);
  check('recherche sans résultat : liste vide', r.status === 200 && r.json.accounts.length === 0);
  r = await owner('GET', `${AC}/accounts?q=6_2`);
  check('recherche : le joker « _ » n\'est pas interprété', r.status === 200 && r.json.accounts.length === 0, r.json.accounts.length);
  // Une organisation qui possédait un plan plus ancien reçoit les nouveaux comptes standard, sans toucher à ses comptes personnalisés.
  await dbx.prepare("DELETE FROM acc_accounts WHERE org_id = ? AND code IN ('6412', '6413', '895')").run(org);
  await dbx.prepare("INSERT INTO acc_accounts (org_id, code, label, custom) VALUES (?, '6413', 'Taxe maison', 1)").run(org);
  r = await owner('GET', `${AC}/accounts`);
  const a6413 = r.json.accounts.find((a) => a.code === '6413');
  check('mise à niveau du plan : 6412 et 895 reviennent', r.json.accounts.some((a) => a.code === '6412') && r.json.accounts.some((a) => a.code === '895'));
  check('mise à niveau du plan : le compte personnalisé 6413 est intact', a6413 && a6413.custom === true && a6413.label === 'Taxe maison', a6413);
  r = await owner('GET', `${AC}`);
  check('journal AN (À-nouveaux) disponible', r.json.journals.AN === 'À-nouveaux', r.json.journals);

  // ---------- Contrôles sur une comptabilité vide ----------
  r = await owner('GET', `${AC}/audit?year=${P}`);
  check('audit d\'une comptabilité vide : score 100, aucune alerte', r.status === 200 && r.json.score === 100 && r.json.issues.length === 0 && r.json.checked.length >= 12, r.json);
  r = await owner('GET', `${AC}/ratios?year=${P}`);
  check('ratios sans données : tout est « na », sans division par zéro', r.status === 200 && r.json.items.length >= 10 && r.json.items.every((i) => i.status === 'na' && i.value === null && i.explain.length > 10), r.json.items.map((i) => [i.key, i.status, i.value]));
  r = await owner('GET', `${AC}/insights?year=${P}`);
  check('synthèse sans données : 4 à 6 constats, source « rules »', r.json.points.length >= 4 && r.json.points.length <= 6 && r.json.source === 'rules' && r.json.points.every((p) => ['good', 'watch', 'alert'].includes(p.tone) && p.title && p.text), r.json);
  r = await owner('GET', `${AC}/insights?year=${P}&ai=1`);
  check('synthèse avec ai=1 sans IA disponible : repli sur les règles', r.status === 200 && r.json.source === 'rules' && r.json.points.length >= 4, r.json.source);

  // ---------- Sections analytiques ----------
  r = await mem('POST', `${AC}/analytics/sections`, { code: 'PROJ-A', label: 'Projet A', kind: 'project' });
  check('section : création refusée à un simple membre', r.status === 403);
  r = await owner('POST', `${AC}/analytics/sections`, { code: 'P', label: 'Trop court', kind: 'project' });
  check('section : code trop court refusé', r.status === 400, r.json);
  r = await owner('POST', `${AC}/analytics/sections`, { code: 'AB CD', label: 'Espace', kind: 'project' });
  check('section : caractères non autorisés refusés', r.status === 400, r.json);
  r = await owner('POST', `${AC}/analytics/sections`, { code: 'PROJ-A', label: '', kind: 'project' });
  check('section : nom obligatoire', r.status === 400, r.json);
  r = await owner('POST', `${AC}/analytics/sections`, { code: 'PROJ-A', label: 'Projet A', kind: 'inconnu' });
  check('section : type inconnu refusé', r.status === 400, r.json);
  r = await owner('POST', `${AC}/analytics/sections`, { code: 'PROJ-A', label: 'Projet A', kind: 'project' });
  const secA = r.json.id;
  check('section : projet créé', r.status === 201 && secA > 0, r.json);
  r = await owner('POST', `${AC}/analytics/sections`, { code: 'proj-a', label: 'Doublon', kind: 'project' });
  check('section : code déjà pris (même en minuscules) refusé', r.status === 409, r.json);
  r = await owner('POST', `${AC}/analytics/sections`, { code: 'ANT-NORD', label: 'Antenne Nord', kind: 'branch' });
  check('section : antenne créée', r.status === 201, r.json);
  r = await owner('POST', `${AC}/analytics/sections`, { code: 'ACT-VIDE', label: 'Activité sans mouvement', kind: 'custom' });
  const secV = r.json.id;
  r = await owner('POST', `${AC}/analytics/sections`, { code: 'ACT-OFF', label: 'Activité arrêtée', kind: 'custom' });
  const secOff = r.json.id;
  r = await owner('PUT', `${AC}/analytics/sections/${secOff}`, { active: false, label: 'Activité arrêtée (2024)' });
  check('section : désactivation et renommage', r.status === 200);
  r = await owner('PUT', `${AC}/analytics/sections/999999`, { active: false });
  check('section : inconnue = 404', r.status === 404);
  r = await owner('GET', `${AC}/analytics/sections`);
  const sOff = r.json.sections.find((s) => s.code === 'ACT-OFF');
  check('liste des sections : champs du contrat', r.json.sections.length === 4 && sOff && sOff.active === false && sOff.used === 0 && sOff.label === 'Activité arrêtée (2024)' && ['id', 'code', 'label', 'kind', 'active', 'used'].every((k) => k in sOff), r.json);
  // Écriture avec section
  const L2 = (sec) => [{ account: '521', debit: 1000 }, { account: '706', credit: 1000, section: sec }];
  r = await manual(owner, AC, { journal: 'BQ', date: D(1, 8), label: 'Test section inconnue', lines: L2('NOPE') });
  check('écriture : section inconnue refusée', r.status === 400 && /inconnue/.test(r.json.error), r.json);
  r = await manual(owner, AC, { journal: 'BQ', date: D(1, 8), label: 'Test section désactivée', lines: L2('ACT-OFF') });
  check('écriture : section désactivée refusée', r.status === 400 && /désactivée/.test(r.json.error), r.json);
  r = await manual(owner, AC, { journal: 'BQ', date: D(1, 8), label: 'Test section ok', lines: L2('ACT-VIDE') });
  check('écriture : section active acceptée', r.status === 201, r.json);
  const eSec = r.json.id;
  r = await owner('DELETE', `${AC}/analytics/sections/${secV}`);
  check('section utilisée : suppression refusée (on la désactive)', r.status === 400, r.json);
  r = await owner('POST', `${AC}/entries/${eSec}/reverse`, { date: D(1, 9) });
  check('annulation d\'une écriture avec section', r.status === 201, r.json);
  const rev = await entryOf(owner, AC, r.json.id, 'Annulation');
  check('l\'annulation reprend la section de la ligne', rev && rev.lines.some((l) => l.account === '706' && l.section === 'ACT-VIDE'), rev);
  r = await owner('PUT', `${AC}/analytics/sections/${secV}`, { active: false });
  r = await owner('GET', `${AC}/analytics/sections`);
  check('« used » compte les lignes d\'écriture (2 lignes avec section)', r.json.sections.find((s) => s.code === 'ACT-VIDE').used === 2, r.json.sections.find((s) => s.code === 'ACT-VIDE'));

  // Import des projets et antennes existants
  const now = new Date().toISOString();
  const br = (await dbx.prepare('INSERT INTO branches (org_id, name, location, created_at) VALUES (?, ?, ?, ?)').run(org, 'Antenne Sud', 'Douala', now)).lastInsertRowid;
  const pj = (await dbx.prepare("INSERT INTO projects (org_id, name, status, created_by, created_at) VALUES (?, ?, 'active', 1, ?)").run(org, 'Chantier Bonabéri', now)).lastInsertRowid;
  r = await owner('POST', `${AC}/analytics/sections/import`, {});
  check('import : une section par projet et par antenne', r.status === 200 && r.json.created === 2, r.json);
  r = await owner('POST', `${AC}/analytics/sections/import`, {});
  check('import : relancer ne crée rien de plus', r.json.created === 0, r.json);
  r = await owner('GET', `${AC}/analytics/sections`);
  check('import : sections PRJ-/ANT- de kind project/branch', r.json.sections.some((s) => s.code === `PRJ-${pj}` && s.kind === 'project' && s.label === 'Chantier Bonabéri') && r.json.sections.some((s) => s.code === `ANT-${br}` && s.kind === 'branch'), r.json.sections);

  // ---------- Modèles de saisie guidée ----------
  r = await owner('GET', `${AC}/templates`);
  const tpls = r.json.templates;
  const tid = new Set(tpls.map((t) => t.id));
  check('modèles : loyer, salaire, achat, vente, capital, emprunt, frais, TVA, avance, dépôt, retrait', ['rent_cash', 'rent_bank', 'rent_momo', 'salary_bank', 'purchase_goods', 'sale_cash', 'capital_bank', 'loan_repayment', 'bank_fees', 'momo_fees', 'vat_settlement', 'vat_payment', 'staff_advance_cash', 'cash_deposit', 'cash_withdrawal'].every((i) => tid.has(i)), [...tid]);
  check('modèles : forme du contrat (id, label, journal, hint, fields)', tpls.every((t) => t.id && t.label && JOURNALS_OK(t.journal) && typeof t.hint === 'string' && Array.isArray(t.fields) && t.fields.every((f) => f.k && f.label && ['amount', 'text', 'select'].includes(f.type) && (f.type !== 'select' || (Array.isArray(f.options) && f.options.length)))), tpls.find((t) => !t.id));
  function JOURNALS_OK(j) { return ['VT', 'AC', 'BQ', 'CA', 'MM', 'OD'].includes(j); }
  const tp = async (body, c = owner) => c('POST', `${AC}/entries/from-template`, body);
  const linesOf = async (r0, q) => { const e = await entryOf(owner, AC, r0.json.id, q); return e; };
  r = await tp({ template: 'inconnu', date: D(1, 5), amount: 1000 });
  check('modèle inconnu refusé', r.status === 400, r.json);
  r = await tp({ template: 'rent_cash', date: D(1, 5), amount: 0 });
  check('modèle : montant nul refusé', r.status === 400, r.json);
  r = await tp({ template: 'rent_cash', date: 'hier', amount: 1000 });
  check('modèle : date invalide refusée', r.status === 400, r.json);
  r = await tp({ template: 'rent_cash', date: D(1, 5), amount: 1000, section: 'NOPE' });
  check('modèle : section inconnue refusée', r.status === 400, r.json);
  r = await tp({ template: 'sale_cash', date: D(1, 5), amount: 1000, options: { mode: 'cheval' } });
  check('modèle : choix de liste invalide refusé', r.status === 400, r.json);
  r = await tp({ template: 'rent_cash', date: D(1, 5), amount: 1000 }, mem);
  check('modèle : refusé à un simple membre', r.status === 403);
  r = await tp({ template: 'capital_bank', date: D(1, 6), amount: 5000000, label: 'Apport des associés' });
  check('modèle apport en capital : 201 avec numéro BQ-', r.status === 201 && new RegExp(`^BQ-${P}-`).test(r.json.number), r.json);
  let e = await linesOf(r, 'Apport');
  check('apport : 521 au débit, 101 au crédit', balanced(e) && e.lines.some((l) => l.account === '521' && l.debit === 5000000) && e.lines.some((l) => l.account === '101' && l.credit === 5000000), e);
  r = await tp({ template: 'purchase_goods', date: D(5, 6), amount: 119250, piece: 'FA-77' });
  e = await linesOf(r, 'Achat de marchandises');
  check('achat TTC 119 250 à crédit : 601 = 100 000, 4452 = 19 250, 401 = 119 250 (taux des réglages)', e && balanced(e) && e.journal === 'AC' && e.piece === 'FA-77' && e.lines.some((l) => l.account === '601' && l.debit === 100000) && e.lines.some((l) => l.account === '4452' && l.debit === 19250) && e.lines.some((l) => l.account === '401' && l.credit === 119250), e);
  r = await tp({ template: 'sale_cash', date: D(5, 7), amount: 119250, options: { mode: 'espèces', kind: 'services' } });
  e = await linesOf(r, 'Vente au comptant');
  check('vente comptant services : 571 = 119 250, 706 = 100 000, 4432 = 19 250', e && balanced(e) && e.journal === 'VT' && e.lines.some((l) => l.account === '571' && l.debit === 119250) && e.lines.some((l) => l.account === '706' && l.credit === 100000) && e.lines.some((l) => l.account === '4432' && l.credit === 19250), e);
  r = await tp({ template: 'sale_cash', date: D(5, 8), amount: 11925, options: { mode: 'mobile money', kind: 'marchandises' } });
  e = await linesOf(r, 'Vente au comptant');
  check('vente comptant marchandises par mobile money : 589, 701, 4431', e && e.lines.some((l) => l.account === '589') && e.lines.some((l) => l.account === '701' && l.credit === 10000) && e.lines.some((l) => l.account === '4431' && l.credit === 1925), e);
  r = await tp({ template: 'salary_bank', date: D(6, 5), amount: 400000, options: { charges: 50000 } });
  e = await linesOf(r, 'Salaire');
  check('salaire : 661 + charges 664 / 431, net par la banque', e && balanced(e) && e.lines.some((l) => l.account === '661' && l.debit === 400000) && e.lines.some((l) => l.account === '664' && l.debit === 50000) && e.lines.some((l) => l.account === '431' && l.credit === 50000) && e.lines.some((l) => l.account === '521' && l.credit === 400000), e);
  r = await manual(owner, AC, { journal: 'BQ', date: D(2, 1), label: 'Emprunt bancaire reçu', lines: [{ account: '521', debit: 2000000 }, { account: '162', credit: 2000000 }] });
  r = await tp({ template: 'loan_repayment', date: D(7, 5), amount: 100000, options: { interest: 20000 } });
  e = await linesOf(r, 'Remboursement');
  check('emprunt : capital 162 + intérêts 671, total prélevé 120 000 en banque', e && balanced(e) && e.lines.some((l) => l.account === '162' && l.debit === 100000) && e.lines.some((l) => l.account === '671' && l.debit === 20000) && e.lines.some((l) => l.account === '521' && l.credit === 120000), e);
  r = await tp({ template: 'vat_settlement', date: D(7, 10), amount: 200000, options: { deductible: 80000 } });
  e = await linesOf(r, 'Liquidation');
  check('liquidation de TVA : 4431 / 4452 / TVA due 4441 = 120 000', e && balanced(e) && e.lines.some((l) => l.account === '4441' && l.credit === 120000) && e.lines.some((l) => l.account === '4452' && l.credit === 80000), e);
  r = await tp({ template: 'vat_settlement', date: D(7, 11), amount: 50000, options: { deductible: 80000 } });
  e = await linesOf(r, 'Liquidation');
  check('liquidation de TVA avec crédit : 4449 = 30 000', e && balanced(e) && e.lines.some((l) => l.account === '4449' && l.debit === 30000), e);
  r = await tp({ template: 'vat_payment', date: D(7, 12), amount: 120000 });
  check('paiement de la TVA', r.status === 201);
  r = await tp({ template: 'bank_fees', date: D(7, 13), amount: 2500 });
  r = await tp({ template: 'momo_fees', date: D(7, 14), amount: 500 });
  e = await linesOf(r, 'Frais de mobile money');
  check('frais mobile money : journal MM, 631 / 589', e && e.journal === 'MM' && e.lines.some((l) => l.account === '631') && e.lines.some((l) => l.account === '589'), e);
  r = await tp({ template: 'staff_advance_cash', date: D(8, 1), amount: 10000 });
  r = await tp({ template: 'cash_deposit', date: D(8, 2), amount: 5000 });
  r = await tp({ template: 'cash_withdrawal', date: D(8, 3), amount: 1000 });
  check('avance au personnel, dépôt et retrait enregistrés', r.status === 201);
  r = await tp({ template: 'rent_cash', date: D(8, 4), amount: 50000, label: 'Loyer août' });
  e = await linesOf(r, 'Loyer août');
  check('loyer en espèces : 622 / 571, libellé personnalisé', e && e.journal === 'CA' && e.label === 'Loyer août' && e.lines.some((l) => l.account === '622' && l.debit === 50000) && e.lines.some((l) => l.account === '571' && l.credit === 50000), e);
  r = await tp({ template: 'rent_momo', date: D(8, 5), amount: 1000, section: `PRJ-${pj}` });
  e = await linesOf(r, 'Loyer payé');
  check('modèle avec section : posée sur la ligne de charge seulement', e && e.lines.find((l) => l.account === '622').section === `PRJ-${pj}` && e.lines.find((l) => l.account === '589').section === '', e);
  r = await tp({ template: 'rent_cash', date: D(8, 4), amount: 50000, label: 'Loyer août' });
  check('modèle : pas d\'idempotence implicite sans source (deux saisies = deux écritures)', r.status === 201);

  // ---------- Jeu de données analytique ----------
  r = await manual(owner, AC, { journal: 'BQ', date: D(3, 10), label: 'Facture projet A', lines: [{ account: '521', debit: 5000000 }, { account: '706', credit: 5000000, section: 'PROJ-A' }] });
  r = await manual(owner, AC, { journal: 'BQ', date: D(3, 12), label: 'Loyer chantier A', lines: [{ account: '622', debit: 300000, section: 'PROJ-A' }, { account: '521', credit: 300000 }] });
  r = await manual(owner, AC, { journal: 'BQ', date: D(4, 2), label: 'Vente antenne nord', lines: [{ account: '521', debit: 500000 }, { account: '706', credit: 500000, section: 'ANT-NORD' }] });
  r = await manual(owner, AC, { journal: 'BQ', date: D(4, 3), label: 'Frais généraux non ventilés', lines: [{ account: '622', debit: 100000 }, { account: '521', credit: 100000 }] });
  r = await owner('GET', `${AC}/analytics/report?year=${P}`);
  const rp = r.json; const A1 = rp.sections.find((s) => s.code === 'PROJ-A'); const N1 = rp.sections.find((s) => s.code === 'ANT-NORD'); const V1 = rp.sections.find((s) => s.code === 'ACT-VIDE');
  const stP0 = (await owner('GET', `${AC}/statements?year=${P}`)).json;
  check('analytique : projet A = 5 000 000 de produits, 300 000 de charges, marge 94 %', A1 && A1.produits === 5000000 && A1.charges === 300000 && A1.resultat === 4700000 && A1.margePct === 94 && A1.kind === 'project', A1);
  check('analytique : antenne nord = 500 000 de produits, marge 100 %', N1 && N1.produits === 500000 && N1.charges === 0 && N1.margePct === 100, N1);
  check('analytique : section sans produit = marge nulle (null), pas de division par zéro', V1 && V1.produits === 0 && V1.margePct === null, V1);
  check('analytique : non ventilé = charges 100 000 + 50 000 (loyer cash) x2 + autres lignes sans section', rp.nonVentile.charges >= 100000 && rp.nonVentile.produits >= 0 && rp.nonVentile.resultat === rp.nonVentile.produits - rp.nonVentile.charges, rp.nonVentile);
  check('analytique : le total = le compte de résultat (produits, charges, résultat)', rp.total.produits === stP0.resultat.totalProduits && rp.total.charges === stP0.resultat.totalCharges && rp.total.resultat === stP0.resultat.resultat, [rp.total, stP0.resultat.totalProduits, stP0.resultat.totalCharges]);
  check('analytique : sections + non ventilé = total', rp.sections.reduce((a, s) => a + s.produits, 0) + rp.nonVentile.produits === rp.total.produits && rp.sections.reduce((a, s) => a + s.charges, 0) + rp.nonVentile.charges === rp.total.charges);
  r = await owner('GET', `${AC}/analytics/report/PROJ-A/lines?year=${P}`);
  check('analytique : lignes de la section (numéro, date, libellé, compte, débit, crédit)', r.status === 200 && r.json.lines.length === 2 && r.json.lines.every((l) => l.number && l.date && l.label && l.account && 'debit' in l && 'credit' in l) && r.json.lines.some((l) => l.account === '706' && l.credit === 5000000), r.json);
  r = await owner('GET', `${AC}/analytics/report/INCONNU/lines?year=${P}`);
  check('analytique : section inconnue = 404', r.status === 404);
  r = await owner('GET', `${AC}/analytics/report?year=abc`);
  check('analytique : année invalide = 400', r.status === 400);
  r = await owner('GET', `${AC}/analytics/report?year=${P - 5}`);
  check('analytique : année sans écriture = tout à zéro', r.json.total.produits === 0 && r.json.sections.every((s) => s.produits === 0 && s.margePct === null), r.json.total);

  // ---------- Écritures récurrentes ----------
  const rl = (amount) => [{ account: '622', debit: amount }, { account: '521', credit: amount }];
  const badRec = [
    [{ label: 'x', journal: 'BQ', frequency: 'monthly', dayOfMonth: 5, startDate: `${P}-10-05`, lines: [{ account: '622', debit: 100 }, { account: '521', credit: 90 }] }, 'déséquilibrée'],
    [{ label: 'x', journal: 'BQ', frequency: 'monthly', dayOfMonth: 5, startDate: `${P}-10-05`, lines: [{ account: '999', debit: 100 }, { account: '521', credit: 100 }] }, 'compte inconnu'],
    [{ label: 'x', journal: 'ZZ', frequency: 'monthly', dayOfMonth: 5, startDate: `${P}-10-05`, lines: rl(100) }, 'journal inconnu'],
    [{ label: 'x', journal: 'BQ', frequency: 'weekly', dayOfMonth: 5, startDate: `${P}-10-05`, lines: rl(100) }, 'fréquence'],
    [{ label: 'x', journal: 'BQ', frequency: 'monthly', dayOfMonth: 32, startDate: `${P}-10-05`, lines: rl(100) }, 'jour 32'],
    [{ label: 'x', journal: 'BQ', frequency: 'monthly', dayOfMonth: 5, startDate: `${P}-10-05`, endDate: `${P}-09-01`, lines: rl(100) }, 'fin avant début'],
    [{ label: 'x', journal: 'BQ', frequency: 'monthly', dayOfMonth: 5, startDate: `${P}-10-05`, lines: [{ account: '622', debit: 100 }] }, 'une seule ligne'],
    [{ label: 'x', journal: 'BQ', frequency: 'monthly', dayOfMonth: 5, startDate: `${P}-10-05`, lines: rl(100), section: 'NOPE' }, 'section inconnue'],
    [{ label: '', journal: 'BQ', frequency: 'monthly', dayOfMonth: 5, startDate: `${P}-10-05`, lines: rl(100) }, 'libellé vide'],
  ];
  for (const [body, why] of badRec) { r = await owner('POST', `${AC}/recurring`, body); check(`récurrente refusée : ${why}`, r.status === 400, r.json); }
  r = await owner('POST', `${AC}/recurring`, { label: 'Loyer bureau', journal: 'BQ', frequency: 'monthly', dayOfMonth: 5, startDate: `${P}-10-05`, lines: rl(150000), section: 'PROJ-A' });
  const rec1 = r.json.id;
  check('récurrente mensuelle créée', r.status === 201 && rec1 > 0, r.json);
  r = await owner('POST', `${AC}/recurring`, { label: 'Assurance trimestrielle', journal: 'BQ', frequency: 'quarterly', dayOfMonth: 31, startDate: `${P}-01-31`, lines: [{ account: '625', debit: 90000 }, { account: '521', credit: 90000 }] });
  const rec2 = r.json.id;
  r = await owner('GET', `${AC}/recurring`);
  const it1 = r.json.items.find((i) => i.id === rec1);
  check('liste : forme du contrat et prochaine échéance', r.json.items.length === 2 && it1 && it1.nextDue === `${P}-10-05` && it1.lastRun === '' && it1.lines.length === 2 && it1.dayOfMonth === 5 && it1.startDate === `${P}-10-05` && it1.active === true && it1.frequency === 'monthly', it1);
  const countBefore = (await owner('GET', `${AC}/entries?q=Loyer bureau`)).json.entries.length;
  r = await owner('POST', `${AC}/recurring/run`, { upTo: `${P}-12-31` });
  check('exécution : 3 loyers (oct, nov, déc) + 4 assurances (31/01, 30/04 borné, 31/07, 31/10)', r.status === 200 && r.json.created === 7 && r.json.skipped.length === 0, r.json);
  r = await owner('GET', `${AC}/entries?q=Assurance trimestrielle`);
  check('trimestrielle : le 31 est ramené au dernier jour du mois (30 avril)', r.json.entries.map((x) => x.date).sort().join() === [`${P}-01-31`, `${P}-04-30`, `${P}-07-31`, `${P}-10-31`].join(), r.json.entries.map((x) => x.date));
  r = await owner('GET', `${AC}/entries?q=Loyer bureau`);
  check('mensuelle : écritures du 5 octobre, novembre, décembre, équilibrées', r.json.entries.length === countBefore + 3 && r.json.entries.every(balanced) && r.json.entries.map((x) => x.date).sort().join() === [`${P}-10-05`, `${P}-11-05`, `${P}-12-05`].join(), r.json.entries.map((x) => x.date));
  check('récurrente : la section du modèle est posée sur la ligne de charge', r.json.entries[0].lines.find((l) => l.account === '622').section === 'PROJ-A' && r.json.entries[0].lines.find((l) => l.account === '521').section === '');
  const recRows = await dbx.prepare("SELECT source_id FROM acc_entries WHERE org_id = ? AND source = 'recurring' ORDER BY source_id").all(org);
  check('idempotence : source = recurring, source_id = modèle x 1 000 000 + AAAAMM', recRows.length === 7 && recRows.some((x) => Number(x.source_id) === rec1 * 1000000 + P * 100 + 10) && recRows.some((x) => Number(x.source_id) === rec2 * 1000000 + P * 100 + 4), recRows);
  r = await owner('POST', `${AC}/recurring/run`, { upTo: `${P}-12-31` });
  check('relancer ne crée rien de plus', r.json.created === 0 && r.json.skipped.length === 0, r.json);
  r = await owner('GET', `${AC}/entries?q=Loyer bureau`);
  const oct = r.json.entries.find((x) => x.date === `${P}-10-05`);
  r = await owner('POST', `${AC}/entries/${oct.id}/reverse`, { date: D(10, 6) });
  r = await owner('POST', `${AC}/recurring/run`, { upTo: `${P}-12-31` });
  check('une occurrence annulée n\'est pas régénérée', r.json.created === 0, r.json);
  r = await owner('GET', `${AC}/recurring`);
  const it1b = r.json.items.find((i) => i.id === rec1);
  check('dernière exécution et prochaine échéance mises à jour', it1b.lastRun === `${P}-12-05` && it1b.nextDue === `${Y}-01-05`, it1b);
  r = await owner('POST', `${AC}/recurring/run`, { upTo: 'demain' });
  check('exécution : date invalide refusée', r.status === 400);
  r = await owner('PUT', `${AC}/recurring/${rec2}`, { active: false });
  check('récurrente désactivée', r.status === 200);
  r = await owner('POST', `${AC}/recurring/run`, { upTo: `${P}-12-31` });
  check('une récurrente désactivée ne génère rien', r.json.created === 0);
  r = await owner('PUT', `${AC}/recurring/${rec2}`, { lines: [{ account: '625', debit: 5 }, { account: '521', credit: 6 }] });
  check('modification avec lignes déséquilibrées refusée', r.status === 400);
  r = await owner('PUT', `${AC}/recurring/${rec1}`, { label: 'Loyer bureau principal' });
  check('modification partielle (libellé seul)', r.status === 200);
  r = await owner('DELETE', `${AC}/recurring/${rec2}`);
  const nbRec = (await owner('GET', `${AC}/entries?q=Assurance trimestrielle`)).json.entries.length;
  check('suppression du modèle : les écritures déjà passées restent', r.status === 200 && nbRec === 4, nbRec);
  r = await owner('DELETE', `${AC}/recurring/${rec2}`);
  check('suppression d\'un modèle absent = 404', r.status === 404);

  // ---------- Exports ----------
  r = await manual(owner, AC, { journal: 'OD', date: D(9, 2), label: '=SOMME(A1:A9)', lines: [{ account: '658', debit: 100 }, { account: '521', credit: 100 }] });
  r = await owner('GET', `${AC}/export/balance.csv?year=${P}`);
  const bal = (await owner('GET', `${AC}/balance?year=${P}`)).json;
  check('export balance : CSV « ; », BOM UTF-8, en-têtes français', r.status === 200 && /text\/csv/.test(r.headers.get('content-type')) && r.text.charCodeAt(0) === 0xFEFF && r.text.split('\r\n')[0].replace('\uFEFF', '') === 'compte;intitule;debit;credit;solde_debiteur;solde_crediteur' && /attachment/.test(r.headers.get('content-disposition')), r.text.slice(0, 120));
  const brows = r.text.slice(1).split('\r\n').slice(1).map((l) => l.split(';').map((c) => c.replace(/^"|"$/g, '')));
  check('export balance : une ligne par compte, totaux = balance', brows.length === bal.rows.length && brows.reduce((a, x) => a + Number(x[2]), 0) === bal.totalDebit && brows.reduce((a, x) => a + Number(x[3]), 0) === bal.totalCredit, brows.length);
  check('export balance : soldes débiteur / créditeur', brows.every((x) => (Number(x[4]) === 0) !== (Number(x[5]) === 0) || Number(x[2]) === Number(x[3])));
  r = await owner('GET', `${AC}/export/ledger.csv?year=${P}&account=622`);
  const lg = r.text.slice(1).split('\r\n');
  check('export grand livre : en-têtes et solde cumulé final', lg[0] === 'date;journal;numero;piece;libelle;debit;credit;solde' && lg.length > 3, lg.slice(0, 2));
  const l622 = (await owner('GET', `${AC}/ledger?account=622&year=${P}`)).json;
  check('export grand livre : solde final = grand livre', Number(lg[lg.length - 1].split(';').pop().replace(/"/g, '')) === l622.balance, l622.balance);
  r = await owner('GET', `${AC}/export/ledger.csv?year=${P}&account=658`);
  check('export : un libellé commençant par « = » est neutralisé (pas de formule)', r.text.includes("\"'=SOMME(A1:A9)\"") && !r.text.includes(';"=SOMME'), r.text.split('\r\n')[1]);
  r = await owner('GET', `${AC}/export/ledger.csv?year=${P}&account=999999`);
  check('export grand livre : compte inconnu = 404', r.status === 404);
  r = await owner('GET', `${AC}/export/statements.csv?year=${P}`);
  check('export états : résultat et bilan', r.status === 200 && r.text.split('\r\n')[0].replace('\uFEFF', '') === 'etat;rubrique;compte;intitule;montant');
  check('export états : contient le résultat net et les totaux', r.text.includes(`"Résultat net";"${(await owner('GET', `${AC}/statements?year=${P}`)).json.resultat.resultat}"`), r.text.split('\r\n').filter((l) => /Résultat net/.test(l)));
  r = await owner('GET', `${AC}/export/journal-centralisateur.csv?year=${P}`);
  const jc = r.text.slice(1).split('\r\n');
  const jrows = jc.slice(1).map((l) => l.split(';').map((c) => c.replace(/^"|"$/g, '')));
  const tot = jrows.find((x) => x[0] === 'TOTAL');
  check('journal centralisateur : par journal et par mois, total débit = total crédit = balance', jc[0] === 'journal;intitule_journal;mois;nb_ecritures;debit;credit' && tot && Number(tot[4]) === Number(tot[5]) && Number(tot[4]) === bal.totalDebit && jrows.some((x) => x[0] === 'BQ' && x[2] === `${P}-03`), jrows.slice(0, 3));
  check('exports : année invalide refusée', (await owner('GET', `${AC}/export/balance.csv?year=20x`)).status === 400);

  // ---------- Immobilisation, état avant clôture et instantanés ----------
  r = await owner('POST', `${AC}/assets`, { label: 'Camion', category: 'transport', cost: 1200000, lifeMonths: 12, acquiredOn: `${P}-01-02`, startMonth: `${P}-01` });
  r = await owner('POST', `${AC}/bank`, { name: 'Banque Exemple', glAccount: '521' });
  const bankId = r.json.id;
  const snap = async () => ({
    st: (await owner('GET', `${AC}/statements?year=${P}`)).json,
    rt: (await owner('GET', `${AC}/ratios?year=${P}`)).json,
    cash: (await owner('GET', `${AC}/cash-counts`)).json.glBalance,
    bank: (await owner('GET', `${AC}/bank/${bankId}/summary?asOf=${Y}-12-31`)).json,
    vat: (await owner('GET', `${AC}/vat?from=${Y}-01-01&to=${Y}-12-31`)).json,
    lia: (await owner('GET', `${O}/fiscal/liasse?year=${P}`)).json,
  });
  // ---------- Ratios ----------
  const rtR = await owner('GET', `${AC}/ratios?year=${P}`);
  const items = Object.fromEntries(rtR.json.items.map((i) => [i.key, i]));
  const wantKeys = ['tresorerie_nette', 'bfr', 'delai_clients', 'delai_fournisseurs', 'marge_brute_pct', 'resultat_net_pct', 'personnel_pct', 'autonomie_financiere', 'liquidite_generale', 'seuil_rentabilite'];
  check('ratios : les 10 indicateurs du contrat, avec clé, libellé, valeur, unité, statut et phrase', wantKeys.every((k) => items[k] && items[k].label && ['fcfa', 'jours', 'pct', 'ratio'].includes(items[k].unit) && ['ok', 'watch', 'alert', 'na'].includes(items[k].status) && items[k].explain.length > 15) && typeof rtR.json.summary === 'string' && rtR.json.year === P, rtR.json);
  const balP = (await owner('GET', `${AC}/balance?year=${P}`)).json.rows;
  const sumAcc = (f) => balP.filter((x) => f(x.account)).reduce((a, x) => a + x.balance, 0);
  check('ratio trésorerie nette = somme des soldes de la classe 5', items.tresorerie_nette.value === sumAcc((a) => a[0] === '5') && items.tresorerie_nette.unit === 'fcfa', [items.tresorerie_nette.value, sumAcc((a) => a[0] === '5')]);
  check('ratio BFR = stocks + tiers (classes 3 et 4)', items.bfr.value === sumAcc((a) => a[0] === '3' || a[0] === '4'), items.bfr);
  const ventes = stP0.resultat.ventes; const mb = stP0.resultat.margeBrute;
  const stNow = (await owner('GET', `${AC}/statements?year=${P}`)).json;
  check('marge brute % et résultat net % calculés sur le chiffre d\'affaires (une décimale)', items.marge_brute_pct.value === Math.round((stNow.resultat.margeBrute / stNow.resultat.ventes) * 1000) / 10 && items.resultat_net_pct.value === Math.round((stNow.resultat.resultat / stNow.resultat.ventes) * 1000) / 10 && ventes > 0 && mb !== undefined, [items.marge_brute_pct, items.resultat_net_pct]);
  const dettes401 = -sumAcc((a) => a.startsWith('40'));
  const achatsTtc = balP.filter((x) => x.account === '401').reduce((a, x) => a + x.credit, 0);
  check('délai fournisseurs = dettes 401 / achats TTC x 365 jours', items.delai_fournisseurs.unit === 'jours' && items.delai_fournisseurs.value === Math.round((dettes401 / achatsTtc) * 365), [items.delai_fournisseurs.value, dettes401, achatsTtc]);
  check('délai clients : pas de créance, 0 jour (et non une valeur inventée)', items.delai_clients.value === 0 && items.delai_clients.status === 'ok', items.delai_clients);
  const pers = balP.filter((x) => x.account.startsWith('66')).reduce((a, x) => a + x.balance, 0);
  check('charges de personnel % du chiffre d\'affaires', items.personnel_pct.value === Math.round((pers / stNow.resultat.ventes) * 1000) / 10, items.personnel_pct);
  check('seuil de rentabilité approché positif', items.seuil_rentabilite.value > 0 && items.seuil_rentabilite.unit === 'fcfa', items.seuil_rentabilite);
  check('autonomie financière et liquidité : ratios sans unité', items.autonomie_financiere.unit === 'ratio' && items.liquidite_generale.unit === 'ratio', [items.autonomie_financiere, items.liquidite_generale]);
  r = await owner('GET', `${AC}/insights?year=${P}`);
  check('synthèse avec données : constats cohérents (bénéfice annoncé)', r.json.points.some((p) => p.tone === 'good' && /bénéficiaire/.test(p.title)) && r.json.points.length >= 4 && r.json.points.length <= 6, r.json.points.map((p) => p.title));

  // ---------- Clôture annuelle ----------
  const before = await snap();
  r = await owner('GET', `${AC}/year-end?year=${P}`);
  const pre = r.json;
  const ck = Object.fromEntries(pre.checks.map((c) => [c.code, c]));
  check('aperçu : forme du contrat (year, closed, lockedUntil, resultat, checks, carryForward, nextYear)', pre.year === P && pre.closed === false && pre.lockedUntil === '' && pre.resultat === stNow.resultat.resultat && pre.nextYear === Y && pre.checks.every((c) => c.code && typeof c.ok === 'boolean' && c.label && 'detail' in c), pre);
  check('aperçu : contrôles opérations, amortissements, mois, rapprochements, balance, écritures après le 31/12', ['operations', 'depreciation', 'months', 'bank', 'balance', 'after_year_end'].every((k) => ck[k]), Object.keys(ck));
  check('aperçu : amortissements de l\'année non comptabilisés = contrôle en échec', ck.depreciation.ok === false && /12 dotation/.test(ck.depreciation.detail), ck.depreciation);
  check('aperçu : report équilibré, avec le résultat en 131 (bénéfice)', pre.carryForward.totalDebit === pre.carryForward.totalCredit && pre.carryForward.totalDebit > 0 && pre.carryForward.lines.some((l) => l.account === '131' && l.credit >= pre.resultat) && pre.carryForward.lines.every((l) => /^[1-5]/.test(l.account) && l.label !== undefined), pre.carryForward.lines.slice(0, 3));
  const nbEntriesBefore = (await dbx.prepare('SELECT COUNT(*) c FROM acc_entries WHERE org_id = ?').get(org)).c;
  check('aperçu : n\'écrit rien', Number((await dbx.prepare('SELECT COUNT(*) c FROM acc_entries WHERE org_id = ?').get(org)).c) === Number(nbEntriesBefore));
  r = await mem('POST', `${AC}/year-end/close`, { year: P });
  check('clôture : refusée à un simple membre', r.status === 403);
  r = await mgr('POST', `${AC}/year-end/close`, {});
  check('clôture : l\'année est obligatoire', r.status === 400, r.json);
  r = await mgr('POST', `${AC}/year-end/close`, { year: Y + 3 });
  check('clôture : un exercice à venir est refusé', r.status === 400, r.json);
  r = await mgr('POST', `${AC}/year-end/close`, { year: P });
  check('clôture : contrôle bloquant en échec (amortissements) = refus', r.status === 400 && /amortissements/i.test(r.json.error), r.json);
  r = await mgr('POST', `${AC}/year-end/close`, { year: P, force: true, reason: 'On force quand même' });
  check('clôture forcée : réservée au propriétaire (un administrateur est refusé)', r.status === 403, r.json);
  r = await owner('POST', `${AC}/year-end/close`, { year: P, force: true });
  check('clôture forcée : le motif est obligatoire', r.status === 400, r.json);
  check('rien n\'a été écrit après les refus', Number((await dbx.prepare('SELECT COUNT(*) c FROM acc_entries WHERE org_id = ?').get(org)).c) === Number(nbEntriesBefore));
  r = await owner('POST', `${AC}/assets/depreciate`, { month: `${P}-12`, catchUp: true });
  check('dotations de l\'année comptabilisées (rattrapage)', r.status === 201 && r.json.entries.length === 12, r.json);
  const stBeforeClose = (await owner('GET', `${AC}/statements?year=${P}`)).json;
  const before2 = await snap();
  r = await mgr('GET', `${AC}/year-end?year=${P}`);
  check('aperçu : plus de contrôle bloquant en échec', r.json.checks.filter((c) => c.blocking && !c.ok).length === 0 && r.json.resultat === stBeforeClose.resultat.resultat, r.json.checks.filter((c) => !c.ok));
  const preCarry = r.json.carryForward;
  r = await mgr('POST', `${AC}/year-end/close`, { year: P });
  const cl = r.json;
  check('clôture par un administrateur : écriture de résultat, à-nouveaux, verrou', r.status === 201 && cl.closingEntry && /^OD-/.test(cl.closingEntry.number) && cl.openingEntries.length === 1 && new RegExp(`^AN-${Y}-`).test(cl.openingEntries[0].number) && cl.lockedUntil === `${P}-12-31`, cl);
  const ce = await entryOf(owner, AC, cl.closingEntry.id, 'Détermination');
  check('écriture de résultat au 31/12, équilibrée, journal OD, solde 6/7 contre 131', ce && ce.date === `${P}-12-31` && ce.journal === 'OD' && balanced(ce) && ce.lines.some((l) => l.account === '131' && l.credit === stBeforeClose.resultat.resultat) && ce.lines.every((l) => /^[67]|131$/.test(l.account)), ce);
  const an = await entryOf(owner, AC, cl.openingEntries[0].id, 'À-nouveaux');
  check('à-nouveaux au 01/01 suivant, journal AN, équilibrés, = report annoncé', an && an.date === `${Y}-01-01` && an.journal === 'AN' && balanced(an) && sumLines(an).d === preCarry.totalDebit && an.lines.length === preCarry.lines.length && an.lines.every((l) => /^[1-5]/.test(l.account)), [an && an.date, preCarry.totalDebit]);
  check('à-nouveaux : le bénéfice est reporté sur 131', an.lines.some((l) => l.account === '131' && l.credit === stBeforeClose.resultat.resultat));
  const after = await snap();
  check('états de l\'exercice clôturé inchangés (résultat jamais doublé, bilan équilibré)', JSON.stringify(after.st) === JSON.stringify(before2.st) && after.st.bilan.equilibre, [after.st.resultat.resultat, before2.st.resultat.resultat]);
  check('ratios inchangés après clôture', JSON.stringify(after.rt) === JSON.stringify(before2.rt));
  check('liasse fiscale inchangée après clôture (flux réels, ni clôture ni à-nouveaux)', after.lia.resultat.resultat === before2.lia.resultat.resultat && after.lia.bilan.totalActif === before2.lia.bilan.totalActif && after.lia.bilan.equilibre === true, [after.lia.resultat.resultat, before2.lia.resultat.resultat]);
  check('caisse comptée : solde de 571 inchangé malgré les à-nouveaux', after.cash === before2.cash && before2.cash !== 0, [after.cash, before2.cash]);
  check('rapprochement bancaire : solde comptable de 521 inchangé malgré les à-nouveaux', after.bank.glBalance === before2.bank.glBalance && after.bank.unmatchedGlCount === before2.bank.unmatchedGlCount && before2.bank.glBalance !== 0, [after.bank.glBalance, before2.bank.glBalance]);
  check('TVA de la période inchangée par les à-nouveaux', JSON.stringify(after.vat) === JSON.stringify(before2.vat), [after.vat, before2.vat]);
  const stY = (await owner('GET', `${AC}/statements?year=${Y}`)).json;
  check('exercice suivant : bilan d\'ouverture complet et équilibré, résultat reporté au passif', stY.bilan.equilibre && stY.bilan.totalActif === stBeforeClose.bilan.totalActif && stY.bilan.passif.some((x) => x.account === '131' && x.amount === stBeforeClose.resultat.resultat) && stY.resultat.resultat === 0, [stY.bilan.totalActif, stBeforeClose.bilan.totalActif]);
  const balAfter = (await owner('GET', `${AC}/balance?year=${P}`)).json;
  check('balance générale : débits = crédits après clôture', balAfter.totalDebit === balAfter.totalCredit);
  r = await owner('GET', `${AC}/year-end?year=${P}`);
  check('aperçu après clôture : clôturé et verrouillé', r.json.closed === true && r.json.lockedUntil === `${P}-12-31` && r.json.resultat === stBeforeClose.resultat.resultat, r.json);
  r = await owner('POST', `${AC}/year-end/close`, { year: P });
  check('idempotence : seconde clôture refusée clairement (409)', r.status === 409 && /déjà clôturé/.test(r.json.error), r.json);
  r = await manual(owner, AC, { journal: 'OD', date: D(9, 9), label: 'Écriture en période clôturée', lines: [{ account: '658', debit: 100 }, { account: '521', credit: 100 }] });
  check('période verrouillée : saisie manuelle refusée', r.status === 400 && /verrouill/.test(r.json.error), r.json);
  r = await tp({ template: 'rent_cash', date: D(9, 9), amount: 1000 });
  check('période verrouillée : modèle de saisie refusé', r.status === 400, r.json);
  r = await owner('POST', `${AC}/recurring`, { label: 'Abonnement tardif', journal: 'BQ', frequency: 'monthly', dayOfMonth: 15, startDate: `${P}-12-15`, lines: rl(7000) });
  const recLate = r.json.id;
  r = await owner('POST', `${AC}/recurring/run`, { upTo: `${P}-12-31` });
  check('récurrente dans une période verrouillée : sautée, et le dit', r.json.created === 0 && r.json.skipped.length === 1 && /verrouill/.test(r.json.skipped[0]) && /Abonnement tardif/.test(r.json.skipped[0]), r.json);
  await owner('DELETE', `${AC}/recurring/${recLate}`);
  r = await owner('PUT', `${AC}/settings`, { lockedUntil: `${P - 1}-12-31` });
  check('le verrou ne peut pas être abaissé par les réglages', r.status === 400);
  // Réouverture
  r = await mgr('POST', `${AC}/year-end/reopen`, { year: P, reason: 'Erreur de saisie à corriger' });
  check('réouverture : refusée à un administrateur (propriétaire seulement)', r.status === 403, r.json);
  r = await owner('POST', `${AC}/year-end/reopen`, { year: P, reason: '' });
  check('réouverture : motif obligatoire', r.status === 400, r.json);
  r = await owner('POST', `${AC}/year-end/reopen`, { year: P, reason: 'abc' });
  check('réouverture : motif trop court refusé', r.status === 400, r.json);
  r = await owner('POST', `${AC}/year-end/reopen`, { year: P - 3, reason: 'Exercice jamais clôturé' });
  check('réouverture : exercice non clôturé = 409', r.status === 409, r.json);
  r = await owner('POST', `${AC}/year-end/reopen`, { year: P, reason: 'Erreur de saisie à corriger' });
  check('réouverture par le propriétaire : écritures inverses, verrou levé', r.status === 200 && r.json.reversed.length === 2 && r.json.lockedUntil === '', r.json);
  r = await owner('GET', `${AC}/year-end?year=${P}`);
  check('réouverture : exercice ouvert, motif conservé', r.json.closed === false && r.json.lockedUntil === '' && r.json.reopenReason === 'Erreur de saisie à corriger', r.json);
  const rv = (await owner('GET', `${AC}/entries?q=Annulation`)).json.entries;
  const rvClose = rv.find((x) => x.reversedOf === cl.closingEntry.id); const rvOpen = rv.find((x) => x.reversedOf === cl.openingEntries[0].id);
  check('les écritures inverses annulent exactement la clôture et les à-nouveaux', rvClose && rvOpen && balanced(rvClose) && balanced(rvOpen) && sumLines(rvOpen).d === sumLines(an).d, [!!rvClose, !!rvOpen]);
  const afterReopen = await snap();
  check('après réouverture : mêmes états, mêmes ratios, bilan équilibré', JSON.stringify(afterReopen.st) === JSON.stringify(before2.st) && JSON.stringify(afterReopen.rt) === JSON.stringify(before2.rt), [afterReopen.st.resultat.resultat, before2.st.resultat.resultat]);
  check('après réouverture : l\'exercice suivant redevient vide', (await owner('GET', `${AC}/statements?year=${Y}`)).json.bilan.totalActif === 0);
  check('après réouverture : caisse et banque inchangées', afterReopen.cash === before2.cash && afterReopen.bank.glBalance === before2.bank.glBalance);
  r = await manual(owner, AC, { journal: 'OD', date: D(9, 9), label: 'Correction après réouverture', lines: [{ account: '658', debit: 100 }, { account: '521', credit: 100 }] });
  check('après réouverture : la saisie est de nouveau possible', r.status === 201, r.json);
  const stCorr = (await owner('GET', `${AC}/statements?year=${P}`)).json;
  r = await owner('POST', `${AC}/year-end/close`, { year: P });
  check('nouvelle clôture après réouverture (aucun conflit de numérotation ni de source)', r.status === 201 && r.json.closingEntry.id !== cl.closingEntry.id && r.json.openingEntries.length === 1, r.json);
  const cl2 = r.json;
  const ce2 = await entryOf(owner, AC, cl2.closingEntry.id, 'Détermination');
  check('la nouvelle écriture de résultat tient compte de la correction', ce2 && ce2.lines.some((l) => l.account === '131' && l.credit === stCorr.resultat.resultat) && stCorr.resultat.resultat === stBeforeClose.resultat.resultat - 100, [stCorr.resultat.resultat, stBeforeClose.resultat.resultat]);
  r = await manual(owner, AC, { journal: 'BQ', date: `${Y}-01-20`, label: 'Opération de janvier suivant', lines: [{ account: '521', debit: 1000 }, { account: '706', credit: 1000 }] });
  check('exercice suivant : on peut y saisir (le verrou ne va que jusqu\'au 31/12)', r.status === 201, r.json);
  r = await owner('POST', `${AC}/year-end/reopen`, { year: P, reason: 'Trop tard pour rouvrir' });
  check('réouverture refusée s\'il existe des écritures de l\'année suivante (hors à-nouveaux)', r.status === 400 && /après le 31\/12/.test(r.json.error), r.json);
  r = await owner('GET', `${AC}/year-end?year=${P}`);
  check('l\'aperçu signale l\'écriture de l\'exercice suivant sans bloquer', r.json.closed === true && r.json.checks.find((c) => c.code === 'after_year_end').ok === false && r.json.checks.find((c) => c.code === 'after_year_end').blocking === false, r.json.checks.find((c) => c.code === 'after_year_end'));

  // ---------- Comparatif N / N-1 ----------
  const plain = (await owner('GET', `${AC}/statements?year=${Y}`)).json;
  r = await owner('GET', `${AC}/statements?year=${Y}&compare=1`);
  const cmp = r.json;
  const stPrev = (await owner('GET', `${AC}/statements?year=${P}`)).json;
  const { previous, variation, ...rest } = cmp;
  check('comparatif : sans « compare », la réponse reste identique (rien ne casse)', !('previous' in plain) && !('variation' in plain) && JSON.stringify(rest) === JSON.stringify(plain));
  check('comparatif : « previous » = états de l\'année N-1', JSON.stringify(previous) === JSON.stringify(stPrev) && previous.year === String(P), previous && previous.year);
  const vv = variation.ventes;
  check('comparatif : variation des ventes (écart FCFA et %)', vv.ecart === plain.resultat.ventes - stPrev.resultat.ventes && vv.pct === Math.round(((plain.resultat.ventes - stPrev.resultat.ventes) / Math.abs(stPrev.resultat.ventes)) * 1000) / 10, vv);
  check('comparatif : achats, marge brute, résultat, totaux du bilan', ['achats', 'margeBrute', 'resultat', 'totalActif', 'totalPassif'].every((k) => variation[k] && typeof variation[k].ecart === 'number'), variation);
  const cmp0 = (await owner('GET', `${AC}/statements?year=${P - 5}&compare=1`)).json;
  check('comparatif : année précédente vide = pourcentage nul (null), pas de division par zéro', cmp0.variation.ventes.pct === null && cmp0.variation.ventes.ecart === 0 && cmp0.variation.resultat.pct === null);
  const cmpP = (await owner('GET', `${AC}/statements?year=${P}&compare=1`)).json;
  check('comparatif : N-1 vide, écart = valeur de l\'année', cmpP.variation.ventes.pct === null && cmpP.variation.ventes.ecart === stPrev.resultat.ventes);

  // ---------- Intégrité globale ----------
  const bad = await dbx.prepare('SELECT entry_id FROM acc_lines GROUP BY entry_id HAVING SUM(debit) <> SUM(credit)').all();
  check('intégrité : toutes les écritures de la base sont équilibrées', bad.length === 0, bad);
  const dup = await dbx.prepare("SELECT org_id, source, source_id, COUNT(*) c FROM acc_entries WHERE source <> '' GROUP BY org_id, source, source_id HAVING COUNT(*) > 1").all();
  check('intégrité : une opération = au plus une écriture (source + source_id)', dup.length === 0, dup);
  const nums = await dbx.prepare('SELECT number, COUNT(*) c FROM acc_entries WHERE org_id = ? GROUP BY number HAVING COUNT(*) > 1').all(org);
  check('intégrité : numérotation JOURNAL-AAAA-00001 sans doublon', nums.length === 0 && Number((await dbx.prepare("SELECT COUNT(*) c FROM acc_entries WHERE org_id = ? AND number !~ '^[A-Z]{2}-[0-9]{4}-[0-9]{5}$'").get(org)).c) === 0, nums);

  // ---------- Contrôles intelligents (organisation n°2, données choisies) ----------
  const own2 = (m, u, b) => other(m, `${AC2}${u}`, b);
  const put2 = (body) => own2('POST', '/entries', body);
  await own2('POST', '/analytics/sections', { code: 'CHANTIER-1', label: 'Chantier 1', kind: 'project' });
  await put2({ journal: 'CA', date: D(2, 10), label: 'Loyer payé sans caisse', lines: [{ account: '622', debit: 200000 }, { account: '571', credit: 200000 }] });
  await put2({ journal: 'BQ', date: D(3, 3), label: 'Acompte client reçu', lines: [{ account: '521', debit: 50000 }, { account: '411', credit: 50000 }] });
  await put2({ journal: 'BQ', date: D(3, 4), label: 'Règlement fournisseur en trop', lines: [{ account: '401', debit: 30000 }, { account: '521', credit: 30000 }] });
  await put2({ journal: 'BQ', date: D(6, 3), label: 'Dépenses diverses de juin', lines: [{ account: '622', debit: 100000 }, { account: '521', credit: 100000 }] });
  await put2({ journal: 'BQ', date: D(6, 4), label: 'Virement à classer', lines: [{ account: '471', debit: 25000 }, { account: '521', credit: 25000 }] });
  await put2({ journal: 'BQ', date: D(6, 5), label: 'Frais de tenue de compte', lines: [{ account: '631', debit: 5000 }, { account: '521', credit: 5000 }] });
  await put2({ journal: 'BQ', date: D(6, 5), label: 'Frais de tenue de compte', lines: [{ account: '631', debit: 5000 }, { account: '521', credit: 5000 }] });
  await put2({ journal: 'BQ', date: sat(`${P}-06-20`), label: 'ab', lines: [{ account: '622', debit: 1000, section: 'CHANTIER-1' }, { account: '521', credit: 1000 }] });
  await put2({ journal: 'VT', date: D(6, 8), label: 'Vente avec TVA trop faible', lines: [{ account: '589', debit: 101000 }, { account: '706', credit: 100000 }, { account: '4431', credit: 1000 }] });
  await own2('POST', '/assets', { label: 'Machine', category: 'equipment', cost: 600000, lifeMonths: 12, acquiredOn: `${P}-01-02`, startMonth: `${P}-01` });
  const cust2 = (await other('POST', `${ws(org2)}/crm/customers`, { name: 'Client Test' })).json.id;
  let inv = await other('POST', `${ws(org2)}/crm/documents`, { kind: 'invoice', customerId: cust2, issued: `${P}-09-10`, due: `${P}-10-10`, lines: [{ label: 'Prestation', quantity: 1, price: 119250 }] });
  if (inv.status === 201) await other('PUT', `${ws(org2)}/crm/documents/${inv.json.id}`, { status: 'sent' });
  r = await own2('GET', `/audit?year=${P}`);
  const codes2 = r.json.issues.map((i) => i.code);
  const sev = (c) => (r.json.issues.find((i) => i.code === c) || {}).severity;
  check('audit : caisse créditrice (erreur)', sev('cash_negative') === 'error', codes2);
  check('audit : client créditeur et fournisseur débiteur (avertissements)', sev('customer_credit') === 'warning' && sev('supplier_debit') === 'warning', codes2);
  check('audit : banque négative et comptes d\'attente non soldés', sev('bank_negative') === 'warning' && sev('suspense_open') === 'warning', codes2);
  const dupI = r.json.issues.find((i) => i.code === 'duplicates');
  check('audit : doublons probables avec les écritures concernées', dupI && dupI.severity === 'warning' && dupI.entryIds.length === 2, dupI);
  check('audit : écriture un week-end et libellé trop court (informations)', sev('weekend') === 'info' && sev('short_label') === 'info', codes2);
  check('audit : TVA collectée incohérente avec le taux des réglages (écart > 2 %)', sev('vat_mismatch') === 'warning' && /19.250/.test(r.json.issues.find((i) => i.code === 'vat_mismatch').detail), r.json.issues.find((i) => i.code === 'vat_mismatch'));
  check('audit : mois sans écriture (avril et mai)', sev('month_gap') === 'warning' && new RegExp(`${P}-04`).test(r.json.issues.find((i) => i.code === 'month_gap').detail) && new RegExp(`${P}-05`).test(r.json.issues.find((i) => i.code === 'month_gap').detail), r.json.issues.find((i) => i.code === 'month_gap'));
  check('audit : immobilisation sans dotation', sev('no_depreciation') === 'warning', codes2);
  check('audit : lignes sans section alors que des sections existent (information)', sev('no_section') === 'info', codes2);
  if (inv.status === 201) check('audit : facture non comptabilisée', sev('unposted_documents') === 'warning', codes2);
  const pen = r.json.issues.reduce((a, i) => a + { error: 15, warning: 5, info: 1 }[i.severity], 0);
  check('audit : score = 100 - 15/erreur - 5/avertissement - 1/information', r.json.score === Math.max(0, 100 - pen) && r.json.score < 100, [r.json.score, pen]);
  check('audit : chaque alerte a titre, détail, gravité et code ; liste des contrôles effectués', r.json.issues.every((i) => i.title && i.detail && i.code && ['error', 'warning', 'info'].includes(i.severity)) && r.json.checked.includes('cash_negative') && r.json.checked.includes('result_balance_gap'), r.json.checked);
  r = await own2('GET', `/insights?year=${P}`);
  check('synthèse : alerte sur la qualité de la comptabilité quand le score est bas', r.json.points.some((p) => p.tone === 'alert' && /Qualité/.test(p.title)), r.json.points);
  await put2({ journal: 'OD', date: `${Y + 1}-06-15`, label: 'Opération datée de l\'an prochain', lines: [{ account: '658', debit: 1000 }, { account: '521', credit: 1000 }] });
  r = await own2('GET', `/audit?year=${Y + 1}`);
  check('audit : écriture datée dans le futur (avertissement)', (r.json.issues.find((i) => i.code === 'future_dated') || {}).severity === 'warning', r.json.issues.map((i) => i.code));
  r = await own2('GET', '/audit?year=zzz');
  check('audit : année invalide refusée', r.status === 400);
  // Clôture forcée (propriétaire, motif) sur l'organisation n°2 : amortissement manquant = contrôle bloquant ; perte reportée en 139
  r = await other('POST', `${AC2}/year-end/close`, { year: P });
  check('clôture n°2 : contrôle bloquant en échec sans force', r.status === 400, r.json);
  r = await other('POST', `${AC2}/year-end/close`, { year: P, force: true, reason: 'Amortissements traités à part' });
  const sP2 = (await other('GET', `${AC2}/statements?year=${P}`)).json;
  check('clôture forcée par le propriétaire avec motif', r.status === 201 && r.json.closingEntry && r.json.lockedUntil === `${P}-12-31`, r.json);
  const ce3 = await entryOf(other, AC2, r.json.closingEntry.id, 'Détermination');
  check('perte : écriture de résultat au débit de 139', sP2.resultat.resultat < 0 && ce3 && balanced(ce3) && ce3.lines.some((l) => l.account === '139' && l.debit === -sP2.resultat.resultat), [sP2.resultat.resultat, ce3 && ce3.lines.filter((l) => l.account === '139')]);
  check('perte : bilan de l\'exercice suivant équilibré avec la perte au report', (await other('GET', `${AC2}/statements?year=${Y}`)).json.bilan.equilibre === true);
  const nImpact = await dbx.prepare("SELECT COUNT(*) c FROM acc_entries WHERE org_id = ? AND source IN ('year_end', 'year_open')").get(org2);
  check('audit des écritures de clôture : exclues des doublons et libellés', Number(nImpact.c) === 2 && !(await own2('GET', `/audit?year=${P}`)).json.issues.some((i) => i.code === 'short_label' && /Détermination/.test(i.detail)));

  // ---------- Isolation entre organisations ----------
  r = await other('GET', `${AC2}/analytics/sections`);
  check('isolation : les sections d\'une organisation ne se voient pas dans l\'autre', r.json.sections.length === 1 && r.json.sections[0].code === 'CHANTIER-1', r.json.sections);
  r = await other('POST', `${AC2}/recurring/run`, { upTo: `${P}-12-31` });
  check('isolation : l\'exécution des récurrentes ne touche que son organisation', r.json.created === 0);
  r = await other('GET', `${AC2}/year-end?year=${P - 1}`);
  check('isolation : l\'exercice de l\'autre organisation n\'est pas clôturé ici', r.json.closed === false && r.json.lockedUntil === `${P}-12-31`);
});
