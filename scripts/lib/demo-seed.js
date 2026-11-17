'use strict';
// Entreprise de test « Atelier Nkoulou (TEST) » : remplit toutes les sous-applications avec des données d'exemple, par l'API (comme le ferait un utilisateur).
// Utilisé par scripts/demo-local.js (base locale, plusieurs comptes) et scripts/seed-demo.js (un compte existant sur un serveur). Chaque section est isolée :
// si une section échoue, le message est affiché et les autres continuent. Toutes les données sont fictives.
const add = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);

/**
 * call(method, path, body) → { status, json } pour le propriétaire (déjà connecté) ; chemin relatif à /api/ws (ex. '/orgs').
 * opts.team : [{ name, role, job, call }] comptes déjà créés et connectés (mode local) ; absent = salariés sans compte.
 * opts.log : fonction d'affichage.
 */
async function seed(call, opts = {}) {
  const log = opts.log || console.log;
  const today = new Date().toISOString().slice(0, 10);
  const report = { ok: [], failed: [] };
  const step = async (label, fn) => {
    try { const r = await fn(); report.ok.push(label); log('  OK    ' + label); return r; } catch (e) { report.failed.push(label + ' : ' + e.message); log('  ECHEC ' + label + ' -> ' + e.message); return null; }
  };
  const must = async (method, path, body, expect = [200, 201]) => {
    const r = await call(method, path, body);
    if (!expect.includes(r.status)) throw new Error(`${method} ${path} → ${r.status} ${(r.json && r.json.error) || r.text || ''}`.slice(0, 220));
    return r.json || {};
  };
  const ids = {};

  // ---------- Organisation ----------
  const org = await step('Organisation « Atelier Nkoulou (TEST) »', async () => {
    const j = await must('POST', '/orgs', { name: 'Atelier Nkoulou (TEST)', currency: 'FCFA', sector: 'Menuiserie et fabrication de mobilier', description: "Atelier de menuiserie à Douala (Akwa) : mobilier de boutique, comptoirs, étagères, portes. Une douzaine de personnes. Livraison à Douala et Yaoundé. Paiement par Mobile Money, virement et espèces." });
    return j.id;
  });
  if (!org) return report;
  const O = `/orgs/${org}`; ids.org = org;
  await step('Informations légales (NIU, adresse, TVA)', async () => {
    await must('PUT', `${O}/crm/invoice-settings`, { niu: 'M012345678901A', rccm: 'RC/DLA/2024/B/1234', address: 'Rue des Palmiers, Akwa, Douala', vatRate: 19.25, payInfo: 'MTN Mobile Money 6 50 00 00 00 · Orange Money 6 90 00 00 00 · Virement : banque exemple, compte fictif', footer: 'Atelier Nkoulou (TEST) : données fictives pour essai.' });
  });
  await step('Profil de l\'entreprise (questions à boutons)', async () => {
    for (const [id, value] of [['kind', 'factory'], ['sites', '2-5'], ['team', '11-50'], ['channels', ['whatsapp', 'shop']], ['payment', ['momo', 'cash', 'bank']]]) await call('POST', `${O}/profile/answer`, { id, value });
  });

  // ---------- Équipe (comptes) ----------
  const team = opts.team || [];
  const uid = {};
  await step(`Équipe : ${team.length} compte(s) invité(s)`, async () => {
    for (const m of team) {
      const inv = await must('POST', `${O}/invites`, { role: m.role });
      const r = await m.call('POST', '/orgs/join', { code: inv.code });
      if (r.status !== 200 && r.status !== 201) throw new Error(`${m.name} : ${r.status} ${(r.json && r.json.error) || ''}`);
      uid[m.name] = m.userId;
    }
  });

  // ---------- Structure ----------
  await step('Organigramme et processus', async () => {
    const dir = (await must('POST', `${O}/structure/positions`, { title: 'Directeur général' })).id;
    const chef = (await must('POST', `${O}/structure/positions`, { title: "Chef d'atelier", parentId: dir })).id;
    await must('POST', `${O}/structure/positions`, { title: 'Menuisier', parentId: chef });
    await must('POST', `${O}/structure/positions`, { title: 'Comptable', parentId: dir });
    await must('POST', `${O}/structure/processes`, { title: 'Commande client à la livraison', steps: ['Devis accepté', 'Acompte reçu', 'Découpe', 'Assemblage', 'Peinture', 'Livraison', 'Facture soldée'] });
    await must('POST', `${O}/structure/processes`, { title: 'Achat de matière première', steps: ['Demande', 'Validation', 'Commande', 'Réception', 'Paiement'] });
  });

  // ---------- Catalogue et clients ----------
  const cust = [];
  await step('Clients (6)', async () => {
    for (const c of [['Mme Mvogo', '237650000001', 'mvogo@exemple.com'], ['Boutique Élégance', '237650000002', 'elegance@exemple.com'], ['Hôtel Les Palmiers', '237650000003', 'palmiers@exemple.com'], ['M. Fotso', '237650000004', 'fotso@exemple.com'], ['École Les Cèdres', '237650000005', 'cedres@exemple.com'], ['Restaurant Chez Mama', '237650000006', 'mama@exemple.com']]) {
      cust.push((await must('POST', `${O}/crm/customers`, { name: c[0], phone: c[1], email: c[2], address: 'Douala', notes: 'Client de test' })).id);
    }
  });
  await step('Catalogue de vente (6 articles)', async () => {
    for (const [name, price, unit, description] of [['Comptoir en bois clair', 450000, 'pièce', 'Comptoir de boutique 2 m, bois clair verni'], ['Étagère murale', 60000, 'pièce', 'Étagère 1,2 m, 4 niveaux'], ['Porte intérieure', 95000, 'pièce', 'Porte pleine 80 cm'], ['Bureau directeur', 220000, 'pièce', 'Bureau 1,6 m avec tiroirs'], ['Chaise de salle à manger', 35000, 'pièce', 'Chaise bois et assise tissu'], ['Armoire 3 portes', 380000, 'pièce', 'Armoire de chambre']]) await must('POST', `${O}/sales/catalog`, { name, price, unit, description });
  });

  // ---------- Stock et achats ----------
  const sup = []; const item = {};
  await step('Fournisseurs (3) et articles de stock (8)', async () => {
    for (const s of [['Scierie du Littoral', '237660000001'], ['Quincaillerie Moderne', '237660000002'], ['Peintures et Vernis SARL', '237660000003']]) sup.push((await must('POST', `${O}/stock/suppliers`, { name: s[0], contact: s[1] })).id);
    for (const [k, name, unit, qty, min, cost] of [['chene', 'Planche de chêne', 'pièce', 120, 40, 6000], ['contre', 'Contreplaqué 18 mm', 'feuille', 30, 20, 14500], ['vis', 'Vis à bois (boîte)', 'boîte', 15, 20, 2500], ['vernis', 'Vernis incolore 5 L', 'bidon', 4, 6, 18000], ['peinture', 'Peinture blanche 5 L', 'bidon', 12, 5, 15000], ['colle', 'Colle à bois 1 L', 'flacon', 25, 10, 3200], ['charn', 'Charnières (paire)', 'paire', 200, 60, 900], ['poignee', 'Poignées en laiton', 'pièce', 18, 30, 1500]]) item[k] = (await must('POST', `${O}/stock/items`, { name, unit, quantity: qty, minQuantity: min, unitCost: cost })).id;
    await must('PUT', `${O}/stock/items/${item.chene}/prices`, { prices: [{ supplierId: sup[0], unitPrice: 6000, leadDays: 3 }] }, [200, 201, 400]);
  });

  // ---------- RH ----------
  const emp = {};
  await step('Employés (8), congés, planning', async () => {
    const list = [['Paul Essomba', "Chef d'atelier", 320000, 'Paul'], ['Moussa Bell', 'Menuisier', 230000], ['Éric Ndongo', 'Menuisier', 230000, 'Éric'], ['Awa Tchamba', 'Comptable', 300000, 'Awa'], ['Zoé Manga', 'Commerciale', 260000, 'Zoé'], ['Hervé Kamga', 'Peintre', 210000], ['Alain Mbarga', 'Livreur', 150000], ['Sandra Nana', 'Assistante', 180000]];
    for (const [name, job, salary, who] of list) emp[name] = (await must('POST', `${O}/hr/employees`, { name, job, salary, phone: '2376500' + String(Math.floor(Math.random() * 90000) + 10000), hiredAt: add(today, -400), userId: who && uid[who] ? uid[who] : undefined })).id;
    const l1 = (await must('POST', `${O}/hr/leaves`, { employeeId: emp['Moussa Bell'], kind: 'annual', start: add(today, 20), end: add(today, 27) })).id;
    await must('PUT', `${O}/hr/leaves/${l1}/decision`, { decision: 'approved' }, [200, 201]);
    await must('POST', `${O}/hr/leaves`, { employeeId: emp['Hervé Kamga'], kind: 'annual', start: add(today, 40), end: add(today, 45) });
    for (let i = 1; i <= 5; i++) await call('POST', `${O}/hr/shifts`, { employeeId: emp['Éric Ndongo'], day: add(today, i), start: '08:00', end: '17:00' });
  });
  await step('Paie du mois : bulletins lancés, validés, payés', async () => {
    const month = today.slice(0, 7);
    await must('POST', `${O}/payroll/run`, { month });
    const slips = (await must('GET', `${O}/payroll/slips?month=${month}`)).slips || [];
    for (const s of slips) await must('POST', `${O}/payroll/slips/${s.id}/validate`, {}, [200, 201]);
    for (const s of slips.slice(0, 3)) await call('POST', `${O}/payroll/slips/${s.id}/pay`, { method: 'cash' });
  });

  // ---------- Projets (l'histoire du film) ----------
  await step('Projet « Boutique Mvogo » : tâches, dépendances, jalons, budget, coûts, temps', async () => {
    const pid = (await must('POST', `${O}/projects`, { name: 'Boutique Mvogo', description: 'Mobilier complet de la boutique de Mme Mvogo : comptoir, étagères, portes.', due: add(today, 9) })).id; ids.project = pid;
    const T = async (title, due, est, dep, assignee) => { const id = (await must('POST', `${O}/projects/tasks`, { projectId: pid, title, due, assigneeId: assignee, priority: 'high' })).id; await must('PUT', `${O}/projects/tasks/${id}/plan`, { estimateHours: est, dependsOn: dep || null }); return id; };
    const plans = await T('Plans et mesures validés', add(today, -8), 8); await must('PUT', `${O}/projects/tasks/${plans}`, { status: 'done' });
    const cut = await T('Découpe des planches', add(today, -2), 16); await must('PUT', `${O}/projects/tasks/${cut}`, { status: 'doing' });
    const asm = await T('Assemblage des comptoirs', add(today, 1), 24, cut); const paint = await T('Peinture et vernis', add(today, 3), 16, asm); await T('Livraison et installation', add(today, 6), 8, paint);
    await must('POST', `${O}/projects/tasks`, { projectId: pid, title: 'Point hebdomadaire avec la cliente', due: add(today, 2) });
    for (const [title, due] of [['Découpe terminée', add(today, -1)], ['Assemblage terminé', add(today, 2)], ['Livraison', add(today, 6)]]) await must('POST', `${O}/projects/${pid}/milestones`, { title, due });
    await must('PUT', `${O}/projects/${pid}/budget`, { budget: 2400000 });
    await must('PUT', `${O}/projects/settings`, { project_hourly_cost: 3000, project_budget_alert_pct: 80 });
    await must('POST', `${O}/projects/${pid}/costs`, { label: 'Transport du bois', amount: 140000 });
    await must('POST', `${O}/projects/tasks/${plans}/time`, { hours: 10 });
    await must('POST', `${O}/projects/tasks/${cut}/time`, { hours: 12 });
  });
  await step('Projet « Hôtel Les Palmiers » : budget dépassé (alerte)', async () => {
    const pid = (await must('POST', `${O}/projects`, { name: 'Hôtel Les Palmiers : 12 chambres', description: 'Lits, armoires et tables de chevet.', due: add(today, 30) })).id;
    const t1 = (await must('POST', `${O}/projects/tasks`, { projectId: pid, title: 'Prototype de lit', due: add(today, 7) })).id; await must('PUT', `${O}/projects/tasks/${t1}/plan`, { estimateHours: 20 });
    await must('POST', `${O}/projects/tasks`, { projectId: pid, title: 'Série de 12 lits', due: add(today, 25) });
    await must('PUT', `${O}/projects/${pid}/budget`, { budget: 1000000 });
    await must('POST', `${O}/projects/${pid}/costs`, { label: 'Bois (acompte fournisseur)', amount: 850000 });
    await must('POST', `${O}/projects/${pid}/costs`, { label: 'Ferrures importées', amount: 260000 });
    await must('POST', `${O}/projects/tasks`, { projectId: pid, title: 'Contrôle qualité hebdomadaire', due: add(today, 3) }).then(async (r) => { await must('PUT', `${O}/projects/tasks/${r.id}/plan`, { recurrence: 'weekly' }); });
  });
  await step('Achat de bois rattaché au projet, puis sortie de stock', async () => {
    if (!ids.project || !item.chene) throw new Error('projet ou article manquant');
    await must('POST', `${O}/stock/orders`, { itemId: item.chene, quantity: 40, supplierId: sup[0], unitPrice: 6000, projectId: ids.project });
    const od = (await must('GET', `${O}/stock/orders`)).orders[0];
    await must('PUT', `${O}/stock/orders/${od.id}/status`, { status: 'ordered' });
    await must('POST', `${O}/stock/orders/${od.id}/receive`, { quantity: 40 });
    await must('POST', `${O}/stock/items/${item.chene}/move`, { kind: 'out', quantity: 25, reason: 'Découpe comptoir', projectId: ids.project });
    await must('POST', `${O}/stock/orders`, { orders: [{ itemId: item.vernis, quantity: 10, supplierId: sup[2] }, { itemId: item.vis, quantity: 40, supplierId: sup[1] }] });
  });

  // ---------- Ventes : devis, factures, paiements ----------
  await step('Devis, factures, paiements, avoir', async () => {
    const line = (label, quantity, price) => ({ label, quantity, price });
    const q1 = (await must('POST', `${O}/crm/documents`, { kind: 'quote', customerId: cust[3], lines: [line('Bureau directeur', 1, 220000), line('Chaise de bureau', 4, 35000)] })).id;
    await call('PUT', `${O}/crm/documents/${q1}`, { status: 'sent' });
    const q2 = (await must('POST', `${O}/crm/documents`, { kind: 'quote', customerId: cust[2], lines: [line('Armoire 3 portes', 12, 380000)] })).id;
    await call('PUT', `${O}/crm/documents/${q2}`, { status: 'sent' }); await call('PUT', `${O}/crm/documents/${q2}`, { status: 'accepted' });
    await call('POST', `${O}/crm/documents/${q2}/convert`, {});
    const inv = async (cu, lines, status, due) => { const id = (await must('POST', `${O}/crm/documents`, { kind: 'invoice', customerId: cu, lines, due })).id; if (status) await call('PUT', `${O}/crm/documents/${id}`, { status }); return id; };
    const i1 = await inv(cust[0], [line('Comptoir en bois clair', 1, 450000), line('Étagère murale', 3, 60000)], 'sent', add(today, 10));
    await call('POST', `${O}/crm/documents/${i1}/payments`, { amount: 300000, method: 'cash' });
    const i2 = await inv(cust[1], [line('Porte intérieure', 4, 95000)], 'sent', add(today, -20));
    const i3 = await inv(cust[4], [line('Chaise de salle à manger', 20, 35000)], 'sent', add(today, 5));
    await call('POST', `${O}/crm/documents/${i3}/payments`, { amount: 700000, method: 'bank' });
    const i4 = await inv(cust[5], [line('Étagère murale', 2, 60000)], 'sent', add(today, 15));
    await call('POST', `${O}/crm/documents/${i4}/credit-note`, { reason: 'Une étagère retournée', lines: [line('Étagère murale', 1, 60000)] });
    ids.invoice = i1;
    void i2;
  });

  // ---------- Budget, décisions, service client ----------
  await step('Budget : entrées et sorties des 3 derniers mois', async () => {
    for (let m = 0; m < 3; m++) {
      const d = add(today, -30 * m);
      await must('POST', `${O}/budget/entries`, { kind: 'income', category: 'Ventes', label: 'Ventes de mobilier', amount: 2800000 - m * 250000, date: d });
      for (const [cat, amt] of [['Loyer', 250000], ['Matières premières', 900000 + m * 50000], ['Électricité et eau', 120000], ['Transport', 90000]]) await must('POST', `${O}/budget/entries`, { kind: 'expense', category: cat, amount: amt, date: d });
    }
    await call('PUT', `${O}/budget/plans`, { plans: [{ category: 'Matières premières', amount: 900000 }, { category: 'Loyer', amount: 250000 }] });
  });
  await step('Décisions à valider', async () => {
    await must('POST', `${O}/decisions`, { title: 'Achat supplémentaire de bois', amount: '350 000', detail: 'Pour terminer le comptoir de la boutique Mvogo.' });
    await must('POST', `${O}/decisions`, { title: 'Recruter un deuxième peintre', detail: 'Charge de travail en hausse.' });
  });
  await step('Service client : demandes et base de réponses', async () => {
    const t1 = (await must('POST', `${O}/support`, { customerName: 'Mme Mvogo', customerContact: 'mvogo@exemple.com', subject: 'Où en est ma commande ?', message: 'Bonjour, je souhaite connaître la date exacte de livraison.', priority: 'high', channel: 'whatsapp' })).id;
    await must('POST', `${O}/support/${t1}/messages`, { content: 'Bonjour Madame, la découpe est terminée, livraison prévue dans 7 jours.' });
    await must('POST', `${O}/support`, { customerName: 'M. Fotso', subject: 'Devis bureau', message: 'Pouvez-vous réduire le prix ?', channel: 'whatsapp' });
    const t3 = (await must('POST', `${O}/support`, { customerName: 'Hôtel Les Palmiers', subject: 'Facture', message: 'Merci de renvoyer la facture.' })).id; await call('PUT', `${O}/support/${t3}`, { status: 'resolved' });
    await call('POST', `${O}/support/kb`, { title: 'Quels moyens de paiement acceptez-vous ?', body: 'Mobile Money, virement et espèces.', published: true });
    await call('POST', `${O}/support/kb`, { title: 'Quel est le délai de fabrication ?', body: 'Entre 2 et 4 semaines selon la commande.', published: true });
  });

  // ---------- Autres sous-applications ----------
  await step('Juridique : contrat, obligation, dossier', async () => {
    await must('POST', `${O}/legal/contracts`, { title: 'Bail de l\'atelier', party: 'Propriétaire', startDate: add(today, -300), endDate: add(today, 65), amount: 250000 });
    await must('POST', `${O}/legal/obligations`, { title: 'Déclaration mensuelle des impôts', dueDate: add(today, 12) });
    await must('POST', `${O}/legal/disputes`, { title: 'Retard de paiement : Boutique Élégance', party: 'Boutique Élégance', status: 'open' });
  });
  await step('Marketing : campagne, dépenses, publication, offre', async () => {
    const c = (await must('POST', `${O}/marketing/campaigns`, { name: 'Rentrée : mobilier scolaire', channel: 'whatsapp', budget: 150000, startDate: add(today, -5), endDate: add(today, 25), objective: '10 commandes' })).id;
    await must('POST', `${O}/marketing/campaigns/${c}/expenses`, { label: 'Affiches', amount: 40000, date: today });
    await must('POST', `${O}/marketing/posts`, { text: 'Nouveau : comptoirs en bois clair sur mesure à Douala. Écrivez-nous sur WhatsApp !', date: add(today, 3), campaignId: c });
    await must('POST', `${O}/marketing/offers`, { name: '-10 % sur les étagères', kind: 'percent', value: 10, startDate: today, endDate: add(today, 30), description: 'Offre de la rentrée' });
  });
  await step('Logistique : transporteur, zone, livraison', async () => {
    await call('POST', `${O}/logistics/carriers`, { name: 'Transport Express', contact: '237670000001', rate: 15000 });
    await call('POST', `${O}/logistics/zones`, { name: 'Douala centre', fee: 5000, delayDays: 1 });
    await must('POST', `${O}/logistics/deliveries`, { docId: ids.invoice, plannedDate: add(today, 4), customerName: 'Mme Mvogo' });
  });
  await step('Production : nomenclature et ordre de fabrication', async () => {
    const prod = (await must('POST', `${O}/stock/items`, { name: 'Étagère murale (produit fini)', unit: 'pièce', quantity: 0, minQuantity: 0, unitCost: 25000 })).id;
    const bom = (await must('POST', `${O}/production/boms`, { productId: prod, notes: 'Étagère murale 1,2 m', laborCost: 12000, otherCost: 2000, lines: [{ itemId: item.chene, quantity: 3 }, { itemId: item.vis, quantity: 1 }] })).id;
    await must('POST', `${O}/production/orders`, { bomId: bom, quantity: 10, dueDate: add(today, 14) });
  });
  await step('Maintenance : équipement, plan, ordre', async () => {
    const e = (await must('POST', `${O}/maintenance/equipment`, { name: 'Scie à ruban', kind: 'machine' })).id;
    await must('POST', `${O}/maintenance/plans`, { equipmentId: e, task: 'Graissage mensuel', periodKind: 'days', periodValue: 30 });
    await must('POST', `${O}/maintenance/orders`, { equipmentId: e, title: 'Remplacer la lame', priority: 'high' });
  });
  await step('Chantiers (BTP) : chantier, phase, dépense', async () => {
    const s = (await must('POST', `${O}/construction/sites`, { name: 'Extension de l\'atelier', budget: 3500000 })).id;
    await call('POST', `${O}/construction/sites/${s}/phases`, { name: 'Fondations', title: 'Fondations', startDate: add(today, -10), endDate: add(today, 10) });
    await call('POST', `${O}/construction/sites/${s}/expenses`, { label: 'Ciment (50 sacs)', amount: 300000, date: today });
  });

  // ---------- Comptabilité : écritures automatiques, banque, rapprochement ----------
  await step('Comptabilité : écritures automatiques et relevé bancaire à rapprocher', async () => {
    await must('POST', `${O}/accounting/generate`, {});
    const bank = (await must('POST', `${O}/accounting/bank`, { name: 'Afriland (compte courant)', glAccount: '521', accountNo: '00012345678' })).id;
    const csv = ['Date;Libellé;Montant', `${add(today, -9)};VIREMENT RECU Mme Mvogo;300000`, `${add(today, -7)};VIREMENT RECU Ecole Les Cedres;700000`, `${add(today, -6)};PAIEMENT SCIERIE DU LITTORAL;-240000`, `${add(today, -4)};FRAIS TENUE DE COMPTE;-5500`, `${add(today, -2)};REGLEMENT LOYER ATELIER;-250000`].join('\n');
    await must('POST', `${O}/accounting/bank/${bank}/import`, { csv });
  });

  // ---------- Documents PDF partagés (si des comptes existent) ----------
  if (ids.project && team.length) {
    await step('Rapport de projet partagé au poste « Menuisier »', async () => { await must('POST', `${O}/share/send`, { kind: 'project', sourceId: ids.project, jobs: ['Menuisier'], message: 'Voici le point du projet Boutique Mvogo.' }); });
    await step('Bulletins de paie envoyés à chaque salarié avec un compte', async () => { await must('POST', `${O}/share/payslips`, {}); });
  }
  log(`\n  ${report.ok.length} section(s) remplie(s), ${report.failed.length} en échec.`);
  report.org = org; report.ids = ids;
  return report;
}

module.exports = { seed };
