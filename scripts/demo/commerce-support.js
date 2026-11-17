'use strict';
// Service client : délais (SLA), base de réponses (FAQ publique), demandes saisies par l'équipe ou reçues par le formulaire public,
// priorités, attribution, réponses (sans envoi au client : notes internes et réponses notées), résolution et avis de satisfaction, rapport.
module.exports = async function support(ctx, C) {
  const cu = ctx.ids.customers; const m = ctx.ids.members || {};
  const seller = m.seller && m.seller.userId; const manager = m.manager && m.manager.userId;
  C.tickets = [];

  // ---------- Réglages des délais et base de réponses ----------
  await ctx.do('Service client : délais de réponse et de résolution (SLA)', 'PUT', '/support/settings', { sla_first_high: 2, sla_first_normal: 4, sla_first_low: 24, sla_resolve_high: 24, sla_resolve_normal: 48, sla_resolve_low: 120, alert_ticket_hours: 24 });
  await ctx.do('Service client : réglage négatif refusé', 'PUT', '/support/settings', { sla_first_high: -1 }, { expect: 400 });
  await ctx.do('Service client : relire les délais', 'GET', '/support/settings', undefined, { as: 'manager' });
  const kb = [
    ['Quels sont vos délais de livraison ?', 'Douala : sous 24 h pour toute commande confirmée avant 12 h. Yaoundé : 48 h. Livraison gratuite à Douala au-delà de 500 000 FCFA HT.', 'Livraison', true],
    ['Quels moyens de paiement acceptez-vous ?', 'Virement (Afriland First Bank), MTN Mobile Money (650 12 34 56), Orange Money (699 12 34 56), chèque certifié et espèces au comptoir. Indiquez toujours le numéro de facture.', 'Paiement', true],
    ['Puis-je retourner une marchandise ?', 'Oui, sous 8 jours, marchandise non utilisée et dans son emballage d\'origine, avec la facture. Le ciment et la peinture entamés ne sont pas repris.', 'Retours', true],
    ['Quel dosage pour un béton de dalle ?', 'Pour 1 m³ : 7 sacs de ciment CPJ 42,5 (350 kg), 0,4 m³ de sable, 0,8 m³ de gravier 15/25 et 175 L d\'eau. Demandez conseil à notre équipe pour les ouvrages porteurs.', 'Conseils', true],
    ['Garantie du groupe électrogène 7,5 kVA', 'Garantie 12 mois pièces et main-d\'œuvre, première vidange offerte à 50 h. Le numéro de série figure sur la facture.', 'Garantie', true],
    ['Procédure interne : geste commercial', 'Au-delà de 25 000 FCFA, tout avoir commercial est validé par la direction (Mme Kamga).', 'Interne', false],
  ];
  const kbIds = [];
  for (const [title, body, category, published] of kb) { const r = await ctx.do(`Base de réponses : « ${title} »`, 'POST', '/support/kb', { title, body, category, published }, { as: 'manager' }); if (r.id) kbIds.push(r.id); }
  if (ctx.users.seller) await ctx.do('Base de réponses : rédaction réservée aux responsables', 'POST', '/support/kb', { title: 'x', body: 'y' }, { as: 'seller', expect: 403 });
  if (kbIds[3]) await ctx.do('Base de réponses : corriger une réponse', 'PUT', `/support/kb/${kbIds[3]}`, { body: 'Pour 1 m³ de béton de dalle : 7 sacs de ciment CPJ 42,5 (350 kg), 400 L de sable, 800 L de gravier 15/25 et environ 175 L d\'eau. Pour les ouvrages porteurs, suivez les plans de votre ingénieur.' }, { as: 'manager' });
  const tmp = (await ctx.do('Base de réponses : article en double', 'POST', '/support/kb', { title: 'Doublon délais', body: 'Doublon', published: false }, { as: 'manager' })).id;
  if (tmp) await ctx.do('Base de réponses : supprimer', 'DELETE', `/support/kb/${tmp}`, undefined, { as: 'manager' });
  const kv = (await ctx.do('Base de réponses : la commerciale cherche « paiement »', 'GET', '/support/kb?q=paiement', undefined, { as: 'seller' })).items || [];
  ctx.check('Base de réponses : recherche et articles internes masqués aux membres', kv.length >= 1 && (!ctx.users.seller || !(kv.some((a) => a.category === 'Interne'))), kv.map((a) => a.title));
  const token = (await ctx.do('Service client : lien du formulaire public', 'GET', '/sales')).settings;
  const tk = token && token.token;
  if (tk) {
    const fi = await ctx.do('Formulaire public : nom et questions fréquentes', 'GET', `/api/ws/public/intake/${tk}/info`);
    ctx.check('Formulaire public : FAQ publiée (5 questions, sans la note interne)', (fi.faq || []).length === 5, (fi.faq || []).map((f) => f.question));
    const pub = await ctx.do('Formulaire public : un client envoie une demande', 'POST', `/api/ws/public/intake/${tk}`, { name: 'Mme Christelle Ewane', email: 'c.ewane@demo.example', phone: '+237 694 55 66 77', subject: 'Disponibilité carreaux 60×60 gris', message: "Bonjour, avez-vous 35 cartons de carreaux 60×60 gris anthracite ? C'est pour une villa à Kotto, livraison souhaitée la semaine prochaine." });
    ctx.check('Formulaire public : demande enregistrée avec une référence', /^T-\d{4}-/.test(pub.ref || ''), pub);
    await ctx.do('Formulaire public : e-mail invalide refusé', 'POST', `/api/ws/public/intake/${tk}`, { name: 'Test', email: 'pas-un-email', message: 'Bonjour' }, { expect: 400 });
  }

  // ---------- Demandes saisies par l'équipe ----------
  const tickets = [
    ['bati', 'Bâti Plus SARL — M. Kenfack', '+237 677 21 43 65', 'telephone', 'Parpaings fissurés à la livraison', 'Sur la livraison de lundi, une trentaine de parpaings sont fissurés. Le chef de chantier refuse de les poser.', 'high'],
    ['sogea', 'Sogea Satom — Ing. Eyinga', 'achats@sogea-demo.example', 'email', 'Retard de livraison chantier Bonapriso', "Les 60 sacs prévus ce matin ne sont pas arrivés, l'équipe de coffrage attend.", 'high'],
    ['hotel', 'Hôtel La Falaise — Direction', 'direction@falaise-demo.example', 'email', 'Demande de facture proforma pour le conseil d\'administration', 'Merci de nous envoyer une proforma pour 80 cartons de carreaux et 12 seaux de peinture.', 'normal'],
    ['quinc', 'Quincaillerie du Wouri', '+237 655 44 11 22', 'whatsapp', 'Erreur de quantité sur la dernière facture', 'Nous avons reçu 4 rouleaux de câble mais la facture en compte 5.', 'normal'],
    ['particulier', 'M. Jean-Paul Etoundi', '+237 671 00 99 88', 'manuel', 'Conseil : dosage béton pour une dalle de 40 m²', 'Combien de sacs de ciment pour une dalle de 12 cm ?', 'low'],
    [null, 'Prospect inconnu', '', 'telephone', 'Appel publicitaire (démarchage)', "Un démarcheur propose des espaces publicitaires.", 'low'],
  ];
  for (const [ck, name, contact, channel, subject, message, priority] of tickets) {
    const r = await ctx.do(`Service client : nouvelle demande « ${subject} »`, 'POST', '/support', { customerName: name, customerContact: contact, customerId: ck ? cu[ck] : undefined, channel, subject, message, priority, branchId: ctx.ids.branches.douala }, { as: 'seller' });
    if (r.id) C.tickets.push(r.id);
  }
  await ctx.do('Service client : demande sans nom refusée', 'POST', '/support', { subject: 'x' }, { as: 'seller', expect: 400 });
  const [tBati, tSogea, tHotel, tQuinc, tPart, tSpam] = C.tickets;
  const msg = (id, content, author, label) => ctx.do(label || 'Service client : réponse de l\'équipe', 'POST', `/support/${id}/messages`, { content, author, send: false }, { as: 'seller' });
  if (tBati) {
    await ctx.do('Service client : attribuer au directeur des opérations', 'PUT', `/support/${tBati}`, { assigneeId: manager || undefined }, { as: 'manager' });
    await msg(tBati, 'Bonjour M. Kenfack, nous sommes désolés. Notre chauffeur passe récupérer les parpaings abîmés demain à 8 h et les remplace.', 'staff');
    await msg(tBati, 'Client rappelé : il accepte le remplacement mais demande un geste commercial.', 'customer', 'Service client : noter la réponse du client (reçue par téléphone)');
    await ctx.do('Service client : résoudre (avis demandé au client)', 'PUT', `/support/${tBati}`, { status: 'resolved', askFeedback: false }, { as: 'manager' });
  }
  if (tSogea) {
    await msg(tSogea, 'Le camion est parti de Bonabéri à 9 h 40, arrivée prévue vers 11 h (embouteillage au pont du Wouri).', 'staff');
    await ctx.do('Service client : laisser en attente du client', 'PUT', `/support/${tSogea}`, { status: 'pending' }, { as: 'manager' });
  }
  if (tHotel) {
    await msg(tHotel, 'Proforma envoyée ce jour (devis avec le code BTP2026). Validité 30 jours.', 'staff');
    await ctx.do('Service client : résoudre', 'PUT', `/support/${tHotel}`, { status: 'resolved', askFeedback: false }, { as: 'seller' });
  }
  if (tQuinc) {
    await ctx.do('Service client : changer la priorité (normale → haute)', 'PUT', `/support/${tQuinc}`, { priority: 'high', assigneeId: seller || undefined }, { as: 'manager' });
    await msg(tQuinc, 'Vérification faite au magasin : un avoir va être émis pour le rouleau manquant.', 'staff');
  }
  if (tPart) {
    await ctx.do("Service client : relier la demande à la fiche client", 'PUT', `/support/${tPart}`, { customerId: cu.particulier }, { as: 'manager' });
    await msg(tPart, 'Pour 40 m² × 12 cm ≈ 4,8 m³ : environ 34 sacs de ciment, 2 m³ de sable et 4 m³ de gravier. Voir notre fiche « dosage béton ».', 'staff');
    await ctx.do('Service client : résoudre', 'PUT', `/support/${tPart}`, { status: 'resolved', askFeedback: false }, { as: 'seller' });
  }
  if (tSpam) {
    if (ctx.users.seller) await ctx.do('Service client : la commerciale ne peut pas supprimer une demande', 'DELETE', `/support/${tSpam}`, undefined, { as: 'seller', expect: 403 });
    await ctx.do('Service client : supprimer un démarchage', 'DELETE', `/support/${tSpam}`, undefined, { as: 'manager' });
  }
  if (tSogea) {
    await msg(tSogea, 'Livraison reçue à 11 h 20, merci.', 'customer', 'Service client : le client répond (la demande se rouvre)');
  }

  // ---------- Avis de satisfaction (lien public envoyé à la résolution) ----------
  for (const [id, score, comment] of [[tBati, C.local ? 2 : 3, 'Remplacement fait, mais nous avons perdu une demi-journée de chantier.'], [tHotel, 5, 'Réponse très rapide, merci.'], [tPart, 4, 'Bons conseils.']]) {
    if (!id) continue;
    const d = await ctx.do('Service client : ouvrir la demande (messages, lien d\'avis)', 'GET', `/support/${id}`, undefined, { as: 'manager' });
    const tok = String((d.ticket && d.ticket.csatLink) || '').split('/').pop();
    if (!tok) { ctx.check('Satisfaction : lien d\'avis créé à la résolution', false, d.ticket); continue; }
    await ctx.do('Satisfaction : page publique d\'avis', 'GET', `/api/ws/public/csat/${tok}`);
    await ctx.do(`Satisfaction : le client note ${score}/5`, 'POST', `/api/ws/public/csat/${tok}`, { score, comment });
    if (id === tBati) await ctx.do('Satisfaction : un seul avis par demande', 'POST', `/api/ws/public/csat/${tok}`, { score: 5 }, { expect: 409 });
  }
  const list = await ctx.do('Service client : boîte des demandes (priorités, délais)', 'GET', '/support', undefined, { as: 'seller' });
  ctx.check('Service client : demandes ouvertes, en attente et résolues', list.counts && list.counts.resolved >= 3 && (list.counts.open || 0) + (list.counts.pending || 0) >= 2, list.counts);
  await ctx.do('Service client : filtre « résolues »', 'GET', '/support?status=resolved', undefined, { as: 'manager' });
  await ctx.do('Service client : demandes d\'un client', 'GET', `/support?customerId=${cu.bati}`, undefined, { as: 'manager' });
  const rep = await ctx.do('Service client : rapport (délais, satisfaction, par personne)', 'GET', `/support/report?from=${ctx.day(-30)}&to=${ctx.day(0)}`, undefined, { as: 'manager' });
  ctx.check('Service client : satisfaction moyenne calculée (3 avis)', rep.csat && rep.csat.count >= 3 && rep.total >= 6, rep.csat);
  if (ctx.users.seller) await ctx.do('Service client : rapport réservé aux responsables', 'GET', '/support/report', undefined, { as: 'seller', expect: 403 });
};
