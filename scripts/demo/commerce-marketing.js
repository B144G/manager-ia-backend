'use strict';
// Marketing : campagnes (codes suivis par l'assistant commercial), dépenses (au budget), calendrier de contenu, offres, consentement,
// segments de clients, envoi groupé (APERÇU seulement : rien n'est envoyé), codes promo appliqués à un devis.
module.exports = async function marketing(ctx, C) {
  const cu = ctx.ids.customers;
  C.campaigns = {};
  const camp = async (key, label, body) => { const r = await ctx.do(label, 'POST', '/marketing/campaigns', body, { as: 'manager' }); if (r.id) C.campaigns[key] = r.id; return r.id; };
  const have = ((await ctx.do('Marketing : tableau de bord (campagnes, calendrier, offres)', 'GET', '/marketing', undefined, { as: 'seller' })).campaigns) || [];
  const ex = (code) => (have.find((c) => c.code === code) || {}).id;
  C.campaigns.promote = ex('PROMOTE26') || await camp('promote', 'Marketing : campagne « Salon Promote 2026 »', { name: 'Salon Promote 2026 — stand Batimat', channel: 'other', objective: 'Rencontrer 150 entreprises du BTP et signer 10 comptes', budget: 1500000, startDate: ctx.day(-125), endDate: ctx.day(-118), status: 'active', code: 'PROMOTE26', notes: 'Palais des Congrès de Yaoundé, stand B12' });
  C.campaigns.fb = ex('FB-CIMENT') || await camp('fb', 'Marketing : campagne Facebook « Ciment au prix usine »', { name: 'Facebook — Ciment au prix usine', channel: 'facebook', objective: 'Prospects particuliers et petits entrepreneurs de Douala', budget: 350000, startDate: ctx.day(-30), endDate: ctx.day(30), status: 'active', code: 'FB-CIMENT' });
  C.campaigns.radio = ex('RADIO-TOLE') || await camp('radio', 'Marketing : spot radio « Tôles saison des pluies »', { name: 'Radio Balafon — spot tôles', channel: 'radio', objective: 'Faire connaître les tôles bac alu avant la saison des pluies', budget: 450000, startDate: ctx.day(-20), endDate: ctx.day(10), status: 'active', code: 'RADIO-TOLE' });
  C.campaigns.poster = await camp('poster', 'Marketing : affiches sur les chantiers de Kotto (brouillon, sans code)', { name: 'Affiches chantiers Kotto', channel: 'poster', budget: 120000, startDate: ctx.day(7), status: 'draft' });
  await ctx.do('Marketing : code de campagne avec espace refusé', 'POST', '/marketing/campaigns', { name: 'Test', code: 'CODE AVEC ESPACE' }, { as: 'manager', expect: 400 });
  await ctx.do('Marketing : code déjà utilisé refusé', 'POST', '/marketing/campaigns', { name: 'Doublon', code: 'fb-ciment' }, { as: 'manager', expect: 400 });
  await ctx.do('Marketing : dates incohérentes refusées', 'POST', '/marketing/campaigns', { name: 'Test', startDate: ctx.day(5), endDate: ctx.day(1) }, { as: 'manager', expect: 400 });
  if (ctx.users.seller) await ctx.do('Marketing : création de campagne réservée aux responsables', 'POST', '/marketing/campaigns', { name: 'Essai' }, { as: 'seller', expect: 403 });
  if (C.campaigns.promote) await ctx.do('Marketing : clôturer la campagne du salon', 'PUT', `/marketing/campaigns/${C.campaigns.promote}`, { status: 'ended', notes: 'Palais des Congrès de Yaoundé, stand B12. 162 cartes de visite collectées.' }, { as: 'manager' });
  if (C.campaigns.poster) await ctx.do('Marketing : la commerciale complète l\'objectif de la campagne', 'PUT', `/marketing/campaigns/${C.campaigns.poster}`, { objective: 'Toucher les chefs de chantier du quartier Kotto' }, { as: 'seller' });
  const t = (await ctx.do('Marketing : campagne de test', 'POST', '/marketing/campaigns', { name: 'Test à supprimer', channel: 'other' }, { as: 'manager' })).id;
  if (t) await ctx.do('Marketing : supprimer une campagne', 'DELETE', `/marketing/campaigns/${t}`, undefined, { as: 'manager' });

  // Dépenses (le stand du salon et la publicité Facebook vont au budget)
  if (C.campaigns.promote) {
    await ctx.do('Marketing : dépense « location du stand » (inscrite au budget)', 'POST', `/marketing/campaigns/${C.campaigns.promote}/expenses`, { label: 'Location du stand 18 m²', amount: 900000, date: ctx.day(-130), toBudget: true }, { as: 'manager' });
    await ctx.do('Marketing : dépense « kakémonos et flyers »', 'POST', `/marketing/campaigns/${C.campaigns.promote}/expenses`, { label: 'Kakémonos et 2 000 flyers', amount: 285000, date: ctx.day(-128), toBudget: true }, { as: 'manager' });
  }
  if (C.campaigns.fb) {
    for (const [label, amount, d] of [['Publicité Facebook — semaine 1', 85000, -28], ['Publicité Facebook — semaine 2', 85000, -21], ['Publicité Facebook — semaine 3', 90000, -14]]) await ctx.do(`Marketing : dépense « ${label} »`, 'POST', `/marketing/campaigns/${C.campaigns.fb}/expenses`, { label, amount, date: ctx.day(d), toBudget: true }, { as: 'manager' });
    const e = (await ctx.do('Marketing : dépense saisie par erreur', 'POST', `/marketing/campaigns/${C.campaigns.fb}/expenses`, { label: 'Doublon', amount: 85000, date: ctx.day(-21) }, { as: 'manager' })).id;
    if (e) await ctx.do('Marketing : supprimer une dépense', 'DELETE', `/marketing/expenses/${e}`, undefined, { as: 'manager' });
    await ctx.do("Marketing : dépenses d'une campagne", 'GET', `/marketing/campaigns/${C.campaigns.fb}/expenses`, undefined, { as: 'manager' });
  }
  if (C.campaigns.radio) await ctx.do('Marketing : dépense « spot radio, 30 passages »', 'POST', `/marketing/campaigns/${C.campaigns.radio}/expenses`, { label: 'Radio Balafon : 30 passages de 30 s', amount: 420000, date: ctx.day(-20), toBudget: true }, { as: 'manager' });

  // Calendrier de contenu (la commerciale prépare, publie)
  const posts = [
    [-10, 'facebook', 'published', 'fb', '🧱 Ciment CPJ 42,5 au prix usine chez Batimat Bonabéri ! Livraison sur chantier à Douala dès 50 sacs. Écrivez-nous.'],
    [-3, 'whatsapp', 'published', 'radio', 'Saison des pluies : protégez votre toiture. Tôles bac alu 6/10e disponibles à Bonabéri et Mvan.'],
    [2, 'facebook', 'ready', 'fb', 'Témoignage : « Batimat a livré 300 sacs en 24 h sur notre chantier de Bonapriso » — Sogea Satom.'],
    [5, 'instagram', 'idea', null, 'Avant/après : rénovation des chambres de l\'Hôtel La Falaise avec nos carreaux 60×60.'],
    [9, 'tiktok', 'idea', null, 'Vidéo : comment reconnaître un bon fer à béton HA (3 astuces de notre chef magasinier).'],
    [14, 'facebook', 'idea', 'fb', 'Offre fin d\'année : -5 % sur les tôles avec le code BTP2026.'],
  ];
  const pids = [];
  for (const [d, channel, status, ck, text] of posts) { const r = await ctx.do(`Marketing : publication ${channel} du ${ctx.day(d)}`, 'POST', '/marketing/posts', { date: ctx.day(d), channel, status, text, campaignId: ck ? C.campaigns[ck] : null }, { as: 'seller' }); if (r.id) pids.push(r.id); }
  await ctx.do('Marketing : publication sans date refusée', 'POST', '/marketing/posts', { text: 'Sans date' }, { as: 'seller', expect: 400 });
  if (pids[2]) await ctx.do('Marketing : publication marquée « publiée »', 'PUT', `/marketing/posts/${pids[2]}`, { status: 'published' }, { as: 'seller' });
  if (pids[4]) await ctx.do('Marketing : déplacer une publication', 'PUT', `/marketing/posts/${pids[4]}`, { date: ctx.day(11), status: 'ready' }, { as: 'seller' });
  const pdel = (await ctx.do('Marketing : idée de publication abandonnée', 'POST', '/marketing/posts', { date: ctx.day(20), channel: 'other', text: 'Idée abandonnée' }, { as: 'seller' })).id;
  if (pdel) await ctx.do('Marketing : supprimer une publication', 'DELETE', `/marketing/posts/${pdel}`, undefined, { as: 'seller' });

  // Offres
  const o1 = (await ctx.do('Marketing : offre « -5 % tôles saison des pluies »', 'POST', '/marketing/offers', { name: 'Saison des pluies : -5 % sur les tôles', kind: 'percent', value: 5, startDate: ctx.day(-20), endDate: ctx.day(25), description: 'Valable sur la tôle bac alu 6/10e, dès 20 feuilles.' }, { as: 'manager' })).id;
  await ctx.do('Marketing : offre « 10 000 FCFA offerts sur le carrelage »', 'POST', '/marketing/offers', { name: '10 000 FCFA offerts dès 50 cartons de carreaux', kind: 'amount', value: 10000, startDate: ctx.day(-60), endDate: ctx.day(-30), description: 'Offre terminée (rentrée).' }, { as: 'manager' });
  await ctx.do('Marketing : remise de 150 % refusée', 'POST', '/marketing/offers', { name: 'Erreur', kind: 'percent', value: 150 }, { as: 'manager', expect: 400 });
  if (o1) await ctx.do('Marketing : prolonger une offre', 'PUT', `/marketing/offers/${o1}`, { endDate: ctx.day(40) }, { as: 'manager' });
  const o3 = (await ctx.do('Marketing : offre en double', 'POST', '/marketing/offers', { name: 'Doublon', kind: 'percent', value: 5 }, { as: 'manager' })).id;
  if (o3) await ctx.do('Marketing : supprimer une offre', 'DELETE', `/marketing/offers/${o3}`, undefined, { as: 'manager' });

  // Consentement et segments
  await ctx.do('Marketing : consentement sans confirmation refusé', 'POST', '/marketing/consent', { customerIds: [cu.sogea], consent: true }, { as: 'manager', expect: 400 });
  await ctx.do('Marketing : consentement recueilli (formulaire signé au comptoir)', 'POST', '/marketing/consent', { customerIds: [cu.sogea, cu.bati, cu.quinc, cu.ngono, cu.immo, cu.hotel, cu.fouda].filter(Boolean), consent: true, confirm: true, source: 'Formulaire papier signé au comptoir (novembre 2026)' }, { as: 'manager' });
  await ctx.do('Marketing : retrait du consentement (demande du client)', 'POST', '/marketing/consent', { customerIds: [cu.ngono], consent: false, source: 'Demande orale au téléphone' }, { as: 'manager' });
  const pv = await ctx.do('Segments : aperçu « gros clients (plus de 2 M FCFA facturés) »', 'POST', '/marketing/segments/preview', { filter: { stage: 'client', minInvoiced: 2000000 } }, { as: 'manager' });
  ctx.check('Segments : les gros clients sont trouvés', pv.count >= 2, pv);
  const s1 = (await ctx.do('Segments : enregistrer « Gros clients »', 'POST', '/marketing/segments', { name: 'Gros clients (> 2 M FCFA)', filter: { minInvoiced: 2000000 } }, { as: 'manager' })).id;
  await ctx.do('Segments : enregistrer « Clients inactifs depuis 30 jours »', 'POST', '/marketing/segments', { name: 'Inactifs depuis 30 jours', filter: { inactiveDays: 30 } }, { as: 'manager' });
  const s3 = (await ctx.do('Segments : enregistrer « Joignables par e-mail, avec consentement »', 'POST', '/marketing/segments', { name: 'E-mail + consentement', filter: { hasEmail: true, consentOnly: true } }, { as: 'manager' })).id;
  const s4 = (await ctx.do('Segments : segment provisoire', 'POST', '/marketing/segments', { name: 'Provisoire', filter: { hasPhone: true } }, { as: 'manager' })).id;
  if (s4) await ctx.do('Segments : supprimer', 'DELETE', `/marketing/segments/${s4}`, undefined, { as: 'manager' });
  await ctx.do('Segments : liste avec effectifs', 'GET', '/marketing/segments', undefined, { as: 'manager' });
  await ctx.do('Marketing : quota d\'envois groupés par jour', 'PUT', '/marketing/settings', { mkt_day_quota: 80 });
  await ctx.do('Marketing : réglages', 'GET', '/marketing/settings', undefined, { as: 'manager' });
  if (s1 || s3) {
    const bp = await ctx.do('Envoi groupé : aperçu (destinataires, sans consentement, quota) — rien n\'est envoyé', 'POST', '/marketing/broadcasts', { name: 'Offre fin d\'année', channel: 'email', subject: 'Batimat : -5 % sur les tôles jusqu\'au 31 décembre', body: 'Bonjour {nom}, profitez de -5 % sur les tôles avec le code BTP2026.', segmentId: s3 || s1, preview: true }, { as: 'manager' });
    ctx.check("Envoi groupé : l'aperçu ne retient que les clients consentants", bp.preview && bp.recipients >= 1, bp);
  }
  await ctx.do('Envoi groupé : historique', 'GET', '/marketing/broadcasts', undefined, { as: 'manager' });

  // Codes promo appliqués à un devis
  const promo = (await ctx.do('Codes promo : créer BTP2026 (-5 %, 50 utilisations)', 'POST', '/marketing/promo', { code: 'btp2026', kind: 'percent', value: 5, starts: ctx.day(-5), ends: ctx.day(45), maxUses: 50 }, { as: 'manager', expect: [201, 409] })).id;
  await ctx.do('Codes promo : créer NOEL2025 (expiré)', 'POST', '/marketing/promo', { code: 'NOEL2025', kind: 'amount', value: 15000, starts: '2025-12-01', ends: '2025-12-31' }, { as: 'manager', expect: [201, 409] });
  await ctx.do('Codes promo : code en double refusé', 'POST', '/marketing/promo', { code: 'BTP2026', kind: 'percent', value: 10 }, { as: 'manager', expect: 409 });
  await ctx.do('Codes promo : liste', 'GET', '/marketing/promo', undefined, { as: 'manager' });
  const qh = C.quoteHotel;
  if (qh) {
    await ctx.do('Codes promo : code expiré refusé sur le devis', 'POST', '/marketing/promo/apply', { documentId: qh, code: 'NOEL2025' }, { as: 'manager', expect: 400 });
    const a = await ctx.do('Codes promo : appliquer BTP2026 au devis de l\'hôtel', 'POST', '/marketing/promo/apply', { documentId: qh, code: 'BTP2026' }, { as: 'manager' });
    ctx.check('Codes promo : remise de 5 % calculée', a.discount > 0, a);
    await ctx.do('Codes promo : retirer le code', 'DELETE', `/marketing/promo/apply/${qh}`, undefined, { as: 'manager' });
    await ctx.do('Codes promo : réappliquer le code', 'POST', '/marketing/promo/apply', { documentId: qh, code: 'BTP2026' }, { as: 'manager' });
    await ctx.do('Devis : envoyé avec la remise', 'PUT', `/crm/documents/${qh}`, { status: 'sent' }, { as: 'manager' });
    await ctx.do('Codes promo : un devis envoyé ne reçoit plus de code', 'POST', '/marketing/promo/apply', { documentId: qh, code: 'BTP2026' }, { as: 'manager', expect: 400 });
  }
  if (promo) await ctx.do('Codes promo : limiter à 30 utilisations', 'PUT', `/marketing/promo/${promo}`, { maxUses: 30 }, { as: 'manager' });

  // Résultats : campagnes reliées aux conversations de l'assistant
  const dash = await ctx.do('Marketing : statistiques (conversations, prospects, coût par prospect, retour sur investissement)', 'GET', '/marketing', undefined, { as: 'manager' });
  const fb = (dash.campaigns || []).find((c) => c.code === 'FB-CIMENT');
  ctx.check('Marketing : la campagne Facebook a des dépenses et des conversations', fb && fb.spent >= 260000 && (fb.chats >= 1 || !C.chats.length), fb);
};
