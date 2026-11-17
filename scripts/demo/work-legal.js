'use strict';
// Juridique et conformité : contrats (échéances, préavis, signature, historique, pièces jointes), obligations récurrentes, litiges,
// registre des données personnelles, modèles, registres de la société (associés, AG, RCCM) et calendrier de conformité (Cameroun).
const { pdf, helpers } = require('./work-lib');

module.exports = async function legal(ctx) {
  const { has, U, q, file } = helpers(ctx);
  const L = (ctx.ids.work.legal = {});
  const S = ctx.ids.suppliers; const C = ctx.ids.customers;

  // ---------- Contrats ----------
  const contract = async (key, body, as = 'accountant') => { L[key] = (await ctx.do(`Juridique : enregistrer le contrat « ${body.title} »`, 'POST', '/legal/contracts', body, { as })).id; return L[key]; };
  await contract('bail', { type: 'lease', title: 'Bail commercial — showroom de Bonamoussadi', parties: 'Batimat Afrique SARL / SCI Les Palmiers de Bonamoussadi', subject: 'Local commercial de 400 m² et parking, carrefour de Bonamoussadi, Douala', amount: 1250000, startDate: ctx.day(-78), endDate: ctx.day(3 * 365 - 78), tacit: true, noticeDays: 180, status: 'active', signStatus: 'to_sign', signers: 'Awa Kamga (gérante), M. Ekwalla (SCI)', assigneeId: U('accountant'), docRef: 'Classeur Juridique n° 3', notes: 'Loyer mensuel HT ; révision triennale.' });
  await contract('cimencam', { type: 'supplier', title: "Contrat d'approvisionnement en ciment — Cimencam", parties: 'Batimat Afrique SARL / Cimencam', subject: 'Remise de 4 % sur volume annuel de 24 000 sacs, paiement à 30 jours', amount: 98000000, startDate: ctx.day(-340), endDate: ctx.day(25), tacit: true, noticeDays: 30, status: 'active', signStatus: 'signed', signedAt: ctx.day(-345), assigneeId: U('manager') });
  await contract('assurance', { type: 'insurance', title: 'Assurance multirisque des dépôts de Douala et Yaoundé', parties: 'Batimat Afrique SARL / Compagnie d\'assurances (démo)', subject: 'Incendie, vol, dégâts des eaux, responsabilité civile', amount: 2850000, startDate: ctx.day(-375), endDate: ctx.day(-10), noticeDays: 60, status: 'active', signStatus: 'signed', signedAt: ctx.day(-376), assigneeId: U('accountant') });
  await contract('sogea', { type: 'client', title: 'Contrat-cadre de fourniture — Sogea Satom Cameroun', parties: 'Batimat Afrique SARL / Sogea Satom Cameroun', subject: 'Fourniture de ciment, fer et granulats pour les chantiers routiers du Littoral', amount: 120000000, startDate: ctx.day(-200), endDate: ctx.day(165), noticeDays: 90, status: 'active', signStatus: 'signed', signedAt: ctx.day(-200), assigneeId: U('seller') });
  await contract('transport', { type: 'other', title: 'Sous-traitance du transport Douala–Yaoundé', parties: 'Batimat Afrique SARL / Transporteur (démo)', status: 'draft' });
  if (L.bail) await ctx.do('Juridique : le bail est signé (date de signature)', 'PUT', `/legal/contracts/${L.bail}`, { signStatus: 'signed', signedAt: ctx.day(-76), docRef: 'Classeur Juridique n° 3, original chez le notaire' });
  await ctx.do('Juridique : une signature dans le futur est refusée', 'PUT', `/legal/contracts/${L.sogea}`, { signStatus: 'signed', signedAt: ctx.day(5) }, { expect: 400 });
  await ctx.do('Juridique : modifier le contrat-cadre Sogea (avenant de montant)', 'PUT', `/legal/contracts/${L.sogea}`, { amount: 135000000, notes: 'Avenant n° 1 : ajout des chantiers de Yaoundé.' }, { as: 'manager' });
  const h = await ctx.do('Juridique : historique du contrat (qui a changé quoi)', 'GET', `/legal/contracts/${L.bail}/history`);
  ctx.check('Juridique : historique de création et de signature', (h.history || []).length >= 2, h);
  const cl = await ctx.do('Juridique : liste des contrats et alertes', 'GET', '/legal/contracts', undefined, { as: 'manager' });
  const ci = (cl.contracts || []).find((c) => c.id === L.cimencam);
  ctx.check('Juridique : préavis dépassé sur le contrat Cimencam', ci && ci.alerts.some((a) => a.code === 'notice_passed'), ci && ci.alerts);
  ctx.check('Juridique : assurance expirée repérée', (cl.contracts || []).some((c) => c.id === L.assurance && c.expired), null);
  await ctx.do('Juridique : supprimer le brouillon de contrat', 'DELETE', `/legal/contracts/${L.transport}`);
  // Pièces jointes (PDF chiffrés)
  const fu = await ctx.do('Juridique : joindre le bail signé (PDF)', 'POST', `/legal/files${q({ parentType: 'contract', parentId: L.bail, name: 'Bail showroom signé.pdf' })}`, pdf('Bail commercial - Showroom Bonamoussadi', ['Duree : 3 ans renouvelable', 'Loyer : 1 250 000 FCFA HT par mois']), { as: 'accountant' });
  const fx = await ctx.do('Juridique : joindre un scan en double', 'POST', `/legal/files${q({ parentType: 'contract', parentId: L.bail, name: 'scan double.pdf' })}`, pdf('Scan'), { as: 'accountant' });
  await ctx.do('Juridique : pièces jointes du contrat', 'GET', `/legal/files${q({ parentType: 'contract', parentId: L.bail })}`);
  if (fu.id) await file('Juridique : télécharger une pièce jointe', `/legal/files/${fu.id}/file`, 'application/pdf', { as: 'manager' });
  if (fx.id) await ctx.do('Juridique : supprimer une pièce jointe', 'DELETE', `/legal/files/${fx.id}`, undefined, { as: 'accountant' });

  // ---------- Obligations récurrentes ----------
  const ob = async (key, body) => { L[key] = (await ctx.do(`Juridique : obligation « ${body.title} »`, 'POST', '/legal/obligations', body, { as: 'accountant' })).id; return L[key]; };
  await ob('patente', { kind: 'license', title: 'Patente 2027 — dépôts de Douala et Yaoundé', dueDate: ctx.day(40), recurrenceMonths: 12, responsibleId: U('accountant'), notes: 'Centre des impôts des moyennes entreprises (CIME) de Douala.' });
  await ob('tva', { kind: 'inspection', title: 'Visite technique des camions LT 482 AB et LT 517 CD', dueDate: ctx.day(-3), recurrenceMonths: 6, responsibleId: U('driver') });
  await ob('extincteurs', { kind: 'inspection', title: 'Vérification des extincteurs des dépôts', dueDate: ctx.day(12), recurrenceMonths: 6, responsibleId: U('storekeeper') });
  await ob('affichage', { kind: 'display', title: 'Affichage du règlement intérieur et des horaires', responsibleId: U('manager') });
  await ob('doublon', { kind: 'other', title: 'Obligation en double' });
  await ctx.do('Juridique : modifier une obligation (preuve attendue)', 'PUT', `/legal/obligations/${L.extincteurs}`, { proof: 'PV de vérification signé par le prestataire', docRef: 'Classeur Sécurité' }, { as: 'accountant' });
  const d1 = await ctx.do('Juridique : obligation récurrente faite (visite technique : prochaine dans 6 mois)', 'POST', `/legal/obligations/${L.tva}/done`, { proof: 'Procès-verbaux de visite technique (centre agréé de Bonabéri)' }, { as: 'accountant' });
  ctx.check('Juridique : l\'obligation semestrielle se répète', d1.repeats === true, d1);
  await ctx.do('Juridique : obligation ponctuelle faite', 'POST', `/legal/obligations/${L.affichage}/done`, {}, { as: 'manager' });
  await ctx.do('Juridique : une obligation déjà faite ne se refait pas', 'POST', `/legal/obligations/${L.affichage}/done`, {}, { as: 'manager', expect: 400 });
  await ctx.do('Juridique : supprimer une obligation', 'DELETE', `/legal/obligations/${L.doublon}`, undefined, { as: 'accountant' });
  await ctx.do('Juridique : liste des obligations', 'GET', '/legal/obligations', undefined, { as: 'manager' });

  // ---------- Litiges et incidents ----------
  const dis = async (key, body) => { L[key] = (await ctx.do(`Juridique : dossier « ${body.title} »`, 'POST', '/legal/disputes', body, { as: 'manager' })).id; return L[key]; };
  await dis('batiplus', { kind: 'dispute', title: 'Impayé Bâti Plus SARL — factures de septembre', counterparty: 'Bâti Plus SARL (Akwa)', openedAt: ctx.day(-35), status: 'in_progress', amount: 2400000, description: 'Deux factures échues depuis 60 jours, chèque promis non reçu.', nextStep: 'Mise en demeure par huissier', nextDate: ctx.day(6), assigneeId: U('accountant') });
  await dis('casse', { kind: 'claim', title: 'Réclamation : 14 cartons de carreaux cassés à la livraison', counterparty: 'Hôtel La Falaise', openedAt: ctx.day(-8), amount: 175000, nextStep: 'Constat contradictoire et avoir', nextDate: ctx.day(-2), assigneeId: U('seller') });
  await dis('accident', { kind: 'incident', title: 'Accrochage du camion LT 482 AB à Ndokoti', counterparty: 'Assureur du tiers', openedAt: ctx.day(-50), status: 'in_progress', amount: 650000, nextStep: 'Expertise du véhicule', nextDate: ctx.day(-30), assigneeId: U('driver') });
  await dis('tmp', { kind: 'inspection', title: 'Dossier en double' });
  await ctx.do('Juridique : clore un dossier (indemnisé)', 'PUT', `/legal/disputes/${L.accident}`, { status: 'closed', outcome: "Indemnisation de 620 000 FCFA par l'assureur du tiers." });
  await ctx.do('Juridique : supprimer un dossier', 'DELETE', `/legal/disputes/${L.tmp}`);
  await ctx.do('Juridique : liste des litiges', 'GET', '/legal/disputes', undefined, { as: 'manager' });

  // ---------- Données personnelles ----------
  const pv = [];
  for (const b of [{ dataKind: 'Nom, téléphone et adresse de chantier des clients', people: 'Clients', storedWhere: 'Brij-IA (Clients et ventes)', purpose: 'Livrer, facturer, relancer', retention: '10 ans (pièces comptables)', sharedWith: 'Chauffeurs-livreurs' },
    { dataKind: 'Dossier du personnel (CNI, contrat, salaire, CNPS)', people: 'Employés', storedWhere: 'Brij-IA (RH, paie) et classeur RH', purpose: 'Gestion du personnel et paie', retention: 'Durée du contrat + 5 ans', sharedWith: 'Cabinet comptable' },
    { dataKind: 'Images de vidéosurveillance des dépôts', people: 'Clients, employés, visiteurs', storedWhere: 'Enregistreur du poste de garde', purpose: 'Sécurité des marchandises', retention: '30 jours' },
    { dataKind: 'Ligne en double', people: '—' }]) pv.push((await ctx.do(`Juridique : registre des données « ${b.dataKind.slice(0, 40)} »`, 'POST', '/legal/privacy', b, { as: 'manager' })).id);
  await ctx.do('Juridique : modifier une ligne du registre des données', 'PUT', `/legal/privacy/${pv[2]}`, { notes: 'Panneau d\'information à l\'entrée du dépôt.' }, { as: 'manager' });
  await ctx.do('Juridique : supprimer une ligne du registre des données', 'DELETE', `/legal/privacy/${pv[3]}`, undefined, { as: 'manager' });
  await ctx.do('Juridique : registre des données personnelles', 'GET', '/legal/privacy', undefined, { as: 'manager' });

  // ---------- Modèles de documents ----------
  const tl = await ctx.do('Juridique : modèles fournis et de l\'entreprise', 'GET', '/legal/templates', undefined, { as: 'manager' });
  const builtin = (tl.templates || []).find((t) => t.builtin && t.kind === 'document');
  const own = (await ctx.do('Juridique : créer un modèle (mise en demeure)', 'POST', '/legal/templates', { kind: 'document', title: 'Mise en demeure de payer', body: "Douala, le {{date}}\n\nMadame, Monsieur,\n\nMalgré nos relances, la somme de {{montant}} FCFA reste due par {{client}} au titre des factures {{factures}}. Nous vous mettons en demeure de la régler sous huit jours.\n\nLa gérante, Awa Kamga" }, { as: 'accountant' })).id;
  await ctx.do('Juridique : créer un modèle d\'obligation', 'POST', '/legal/templates', { kind: 'obligation', title: 'Visite technique annuelle des camions', data: { title: 'Visite technique des camions', kind: 'inspection', recurrenceMonths: 12 } }, { as: 'accountant' });
  if (own) await ctx.do('Juridique : modifier un modèle', 'PUT', `/legal/templates/${own}`, { title: 'Mise en demeure de payer (avant huissier)' }, { as: 'accountant' });
  if (builtin) {
    const dup = (await ctx.do('Juridique : dupliquer un modèle fourni', 'POST', `/legal/templates/${encodeURIComponent(builtin.id)}/duplicate`, undefined, { as: 'accountant' })).id;
    await ctx.do('Juridique : un modèle fourni ne se modifie pas (refusé)', 'PUT', `/legal/templates/${encodeURIComponent(builtin.id)}`, { title: 'x' }, { as: 'accountant', expect: 403 });
    if (dup) await ctx.do('Juridique : supprimer la copie du modèle', 'DELETE', `/legal/templates/${dup}`, undefined, { as: 'accountant' });
  }

  // ---------- Registres de la société ----------
  const reg = async (b) => (await ctx.do(`Registres : ${b.kind} « ${b.title} »`, 'POST', '/legal/registers', b, { as: 'accountant' })).id;
  await reg({ kind: 'statuts', title: 'Statuts de Batimat Afrique SARL (capital 10 000 000 FCFA)', date: '2019-03-12', ref: 'Acte notarié n° 1452', detail: 'SARL au capital de 10 000 000 FCFA, siège à Bonabéri, Douala.' });
  await reg({ kind: 'rccm', title: 'Immatriculation au RCCM', date: '2019-04-02', ref: 'RC/DLA/2019/B/1234 (démo)' });
  await reg({ kind: 'associe', title: 'Parts sociales — Awa Kamga', holder: 'Awa Kamga', shares: 600, date: '2019-03-12' });
  await reg({ kind: 'associe', title: 'Parts sociales — Marc Ebongué', holder: 'Marc Ebongué', shares: 250, date: '2021-06-30' });
  const a3 = await reg({ kind: 'associe', title: 'Parts sociales — Société Financière du Littoral', holder: 'Société Financière du Littoral (démo)', shares: 150, date: '2021-06-30' });
  await reg({ kind: 'ag', title: 'AGO d\'approbation des comptes 2025', date: `${new Date().getUTCFullYear()}-06-27`, detail: 'Comptes approuvés, bénéfice de 38 400 000 FCFA mis en réserve à 70 %.' });
  await reg({ kind: 'pv', title: 'PV de l\'AGO du 27 juin', date: `${new Date().getUTCFullYear()}-06-27`, ref: 'PV n° 2026-01' });
  const tmpR = await reg({ kind: 'other', title: 'Ligne en double' });
  if (a3) await ctx.do('Registres : modifier une ligne', 'PUT', `/legal/registers/${a3}`, { detail: 'Cession de 50 parts envisagée en 2027.' }, { as: 'accountant' });
  if (tmpR) await ctx.do('Registres : supprimer une ligne', 'DELETE', `/legal/registers/${tmpR}`, undefined, { as: 'accountant' });
  await ctx.do('Registres : filtrer les associés', 'GET', '/legal/registers?kind=associe', undefined, { as: 'manager' });
  const rs = await ctx.do('Registres : synthèse (répartition du capital)', 'GET', '/legal/registers-summary', undefined, { as: 'manager' });
  ctx.check('Registres : la gérante détient 60 % des parts', (rs.partners || []).some((p) => p.holder === 'Awa Kamga' && p.percent === 60), rs.partners);

  // ---------- Calendrier de conformité (exemples Cameroun à vérifier) ----------
  const seed = await ctx.do('Conformité : pré-remplir le calendrier (exemples Cameroun)', 'POST', '/legal/compliance/seed', undefined, { as: 'accountant' });
  ctx.check('Conformité : exemples ajoutés (DSF, CNPS, TVA…)', typeof seed.added === 'number', seed);
  const cpl = await ctx.do('Conformité : calendrier', 'GET', '/legal/compliance', undefined, { as: 'manager' });
  const cnps = (cpl.items || []).find((c) => /CNPS/.test(c.title));
  if (cnps) await ctx.do('Conformité : déclaration CNPS faite (passe au mois suivant)', 'POST', `/legal/compliance/${cnps.id}/done`, undefined, { as: 'accountant' });
  const own2 = (await ctx.do('Conformité : ajouter une obligation (agrément d\'importateur)', 'POST', '/legal/compliance', { title: "Renouvellement de la carte d'importateur", category: 'Commerce', dueDate: ctx.day(-2), recurrence: 'annual', note: 'Ministère du Commerce' }, { as: 'accountant' })).id;
  if (own2) await ctx.do('Conformité : modifier une obligation', 'PUT', `/legal/compliance/${own2}`, { note: 'Dossier déposé, en attente du récépissé.' }, { as: 'accountant' });
  const tmpC = (await ctx.do('Conformité : obligation en double', 'POST', '/legal/compliance', { title: 'Doublon conformité' }, { as: 'accountant' })).id;
  if (tmpC) await ctx.do('Conformité : supprimer une obligation', 'DELETE', `/legal/compliance/${tmpC}`, undefined, { as: 'accountant' });

  // ---------- Tableau de bord juridique ----------
  const sum = await ctx.do('Juridique : tableau de bord (échéances, à renouveler, en retard)', 'GET', '/legal', undefined, { as: 'manager' });
  ctx.check('Juridique : contrats à renouveler, expirés et étapes en retard', sum.summary && sum.summary.toRenew >= 1 && sum.summary.expired >= 1 && (sum.lateSteps || []).length >= 1, sum.summary);
  if (has('seller')) await ctx.do('Droits : un membre n\'accède pas au juridique (refusé)', 'GET', '/legal', undefined, { as: 'seller', expect: 403 });
  void S; void C;
};
