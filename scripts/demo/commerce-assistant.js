'use strict';
// Assistant commercial : réglages, page publique de vente (chat), conversations et passage de relais, attribution à la commerciale,
// « Mes conversations », dossier préparé par l'IA, rendez-vous et agenda, négociation, centre de relances, relais des alertes.
// L'IA n'est appelée qu'au plus deux fois (première conversation publique, dossier) ; sans clé d'IA, la conversation passe à un conseiller.
module.exports = async function assistant(ctx, C) {
  const cu = ctx.ids.customers; const m = ctx.ids.members || {};
  const seller = m.seller && m.seller.userId; const manager = m.manager && m.manager.userId;

  // ---------- Réglages de l'assistant public ----------
  await ctx.do("Assistant commercial : réglages réservés à l'administration", 'PUT', '/sales/settings', { chatEnabled: true }, { as: 'manager', expect: ctx.users.manager ? 403 : 200 });
  await ctx.do("Assistant commercial : activer la page publique de vente", 'PUT', '/sales/settings', {
    chatEnabled: true, autoAssign: true, handoffOrder: true, handoffAppt: true, handoffKind: 'order', apptReminder: false, replyDelay: 0, voiceReply: 'off',
    salesInfo: "Batimat Afrique : matériaux de construction à Douala (Bonabéri) et Yaoundé (Mvan). Ouvert du lundi au samedi, 7 h 30 - 18 h. Livraison sur chantier dès 50 sacs de ciment (gratuite à Douala au-delà de 500 000 FCFA). Paiement : virement, MTN MoMo, Orange Money, chèque certifié. Prix HT, TVA 19,25 % en sus pour les entreprises.",
  });
  await ctx.do('Assistant commercial : délai de réponse hors limites refusé', 'PUT', '/sales/settings', { replyDelay: 600 }, { expect: 400 });
  const home = await ctx.do('Assistant commercial : tableau de bord (statistiques, réglages)', 'GET', '/sales', undefined, { as: 'manager' });
  const own = await ctx.do('Assistant commercial : lien de la page publique (administration)', 'GET', '/sales');
  const token = own.settings && own.settings.token;
  ctx.check('Assistant commercial : page publique active, catalogue rempli', home.settings && home.settings.chatEnabled && home.stats.catalog >= 12, home.stats);

  // ---------- Négociation : le serveur décide, jamais l'IA seule ----------
  await ctx.do('Négociation : réglages (3 contre-offres, validation au-delà de 8 %)', 'PUT', '/sales/negotiation/settings', { enabled: true, maxCounters: 3, approvalPct: 8, handoffMessage: 'Pour une remise plus importante, notre responsable commercial vous rappelle dans la journée.' });
  await ctx.do('Négociation : réglage invalide refusé', 'PUT', '/sales/negotiation/settings', { maxCounters: 12 }, { expect: 400 });
  const neg = await ctx.do('Négociation : journal et statistiques', 'GET', '/sales/negotiation', undefined, { as: 'manager' });
  ctx.check('Négociation : exceptions de prix de la direction tracées', neg.stats && neg.stats.overrides >= 1, neg.stats);

  // ---------- Relais des alertes (responsable joignable) ----------
  await ctx.do('Relais : réglages (6 alertes par heure, heures calmes 21 h - 6 h)', 'PUT', '/sales/relay/settings', { enabled: C.local, maxPerHour: 6, quietFrom: 21, quietTo: 6, tzOffset: 60 });
  if (manager) {
    await ctx.do("Relais : le numéro d'un client ne peut pas servir de relais", 'PUT', '/sales/relay/contacts', { contacts: [{ userId: manager, phone: '+237 699 10 20 30' }] }, { expect: 400 });
    await ctx.do('Relais : désigner le directeur des opérations', 'PUT', '/sales/relay/contacts', { contacts: [{ userId: manager, phone: '+237 677 55 44 33' }] });
  }
  await ctx.do('Relais : état et journal', 'GET', '/sales/relay', undefined, { as: 'manager' });
  await ctx.do("Relais : message d'essai (WhatsApp non connecté : rien ne part)", 'POST', '/sales/relay/test', {}, { expect: [200, 400] });

  // ---------- Page publique de vente : des prospects écrivent ----------
  C.chats = [];
  if (token) {
    const P = `/api/ws/public/chat/${token}`;
    const info = await ctx.do('Page publique de vente : informations (nom, accueil)', 'GET', `${P}/info`);
    ctx.check('Page publique : service disponible', info.enabled === true, info);
    const msgs = [
      ['FB-CIMENT', 'Bonjour, je construis à Logbessou. Quel est votre prix pour 120 sacs de ciment livrés ? Je peux payer par MoMo.'],
      ['FB-CIMENT', "Bonsoir, vous avez le fer de 12 ? J'en veux 60 barres pour vendredi à Japoma."],
      ['RADIO-TOLE', "J'ai entendu votre annonce à la radio. Les tôles bac alu sont à combien pour une toiture de 150 m² ?"],
      ['PROMOTE26', "Bonjour, nous nous sommes vus au salon Promote. Je voudrais un rendez-vous pour présenter notre projet d'immeuble à Bonamoussadi."],
    ];
    let session = null;
    for (let i = 0; i < msgs.length; i++) {
      const r = await ctx.do(`Page publique de vente : un prospect écrit (campagne ${msgs[i][0]})`, 'POST', `${P}/message`, { message: msgs[i][1], campaign: msgs[i][0] });
      if (r.chatId) C.chats.push(r.chatId);
      if (i === 0) {
        session = r.sessionId;
        if (!r.handoff) break; // IA active (production) : une seule conversation, pour ne pas consommer le quota
        await ctx.do('Page publique de vente : le prospect relance (même conversation)', 'POST', `${P}/message`, { message: 'Je laisse mon numéro : 690 22 33 44 (Martin Tchoupo).', sessionId: session });
      }
    }
    await ctx.do('Page publique : message vide refusé', 'POST', `${P}/message`, { message: '  ' }, { expect: 400 });
  }
  const chats = (await ctx.do('Conversations : liste (canal, campagne, attribution)', 'GET', '/sales/chats', undefined, { as: 'manager' })).chats || [];
  ctx.check('Conversations : les prospects de la page publique apparaissent', chats.length >= Math.min(1, C.chats.length), chats.length);
  const c1 = C.chats[0]; const c2 = C.chats[1]; const c3 = C.chats[2];
  if (c1) {
    const d = await ctx.do("Conversations : ouvrir une conversation (messages, fiche prospect)", 'GET', `/sales/chats/${c1}`, undefined, { as: 'manager' });
    await ctx.do('Conversations : nouveaux messages (mise à jour en direct)', 'GET', `/sales/chats/${c1}/live?since=0`, undefined, { as: 'manager' });
    ctx.check('Conversation : messages du prospect enregistrés', (d.messages || []).some((x) => x.role === 'user'), d.messages && d.messages.length);
    // Dossier préparé par l'IA interne : 200 avec IA, 503 si l'IA n'est pas configurée
    await ctx.do("Conversations : dossier préparé par l'IA (résumé, prochaines étapes)", 'POST', `/sales/chats/${c1}/brief`, {}, { as: 'manager', expect: [200, 503] });
    await ctx.do("Conversations : appliquer la fiche du dossier (si l'IA l'a préparée)", 'POST', `/sales/chats/${c1}/apply-brief`, {}, { as: 'manager', expect: [200, 400] });
    await ctx.do('Conversations : répondre depuis la page web est impossible (seulement WhatsApp/Messenger)', 'POST', `/sales/chats/${c1}/reply`, { text: 'Bonjour' }, { as: 'manager', expect: 400 });
    if (seller) {
      await ctx.do('Attribution : confier la conversation au directeur des opérations', 'PUT', `/sales/chats/${c1}/assign`, { userId: manager || seller }, { as: 'manager' });
      await ctx.do('Attribution : la réattribuer à la commerciale', 'PUT', `/sales/chats/${c1}/assign`, { userId: seller }, { as: 'manager' });
      await ctx.do("Attribution : une personne hors de l'équipe est refusée", 'PUT', `/sales/chats/${c1}/assign`, { userId: 999999 }, { as: 'manager', expect: 400 });
    }
  }
  if (c3) {
    await ctx.do("Attribution : libérer la conversation (personne n'en est chargé)", 'PUT', `/sales/chats/${c3}/assign`, { userId: null }, { as: 'manager' });
    await ctx.do("Conversations : rendre la main à l'assistant", 'PUT', `/sales/chats/${c3}/status`, { status: 'open' }, { as: 'manager' });
  }
  if (seller && c1) {
    const mine = (await ctx.do('Mes conversations : la commerciale voit les siennes', 'GET', '/sales-mine/chats', undefined, { as: 'seller' })).chats || [];
    ctx.check('Mes conversations : la conversation attribuée est visible', mine.some((x) => x.id === c1), mine.map((x) => x.id));
    await ctx.do('Mes conversations : ouvrir', 'GET', `/sales-mine/chats/${c1}`, undefined, { as: 'seller' });
    await ctx.do('Mes conversations : suivi en direct', 'GET', `/sales-mine/chats/${c1}/live?since=0`, undefined, { as: 'seller' });
    await ctx.do('Mes conversations : statut « pris en charge »', 'PUT', `/sales-mine/chats/${c1}/status`, { status: 'handoff' }, { as: 'seller' });
    await ctx.do('Mes conversations : dossier non préparé (rien à appliquer)', 'POST', `/sales-mine/chats/${c1}/apply-brief`, {}, { as: 'seller', expect: [200, 400] });
    await ctx.do('Mes conversations : la commerciale ne voit pas une conversation qui ne lui est pas attribuée', 'GET', `/sales-mine/chats/${c3 || 999999}`, undefined, { as: 'seller', expect: 404 });
    await ctx.do("Assistant commercial : réglages et statistiques fermés à la commerciale (droits)", 'GET', '/sales', undefined, { as: 'seller', expect: 403 });
    if (c2) {
      await ctx.do('Attribution : deuxième conversation confiée à la commerciale', 'PUT', `/sales/chats/${c2}/assign`, { userId: seller }, { as: 'manager' });
      await ctx.do("Mes conversations : rendre la conversation à l'équipe", 'POST', `/sales-mine/chats/${c2}/release`, {}, { as: 'seller' });
    }
  }
  await ctx.do('Assistant commercial : résultats par campagne (conversations → commandes)', 'GET', '/sales/campaigns', undefined, { as: 'manager' });
  await ctx.do('Assistant commercial : commandes des clients à valider', 'GET', '/sales/orders', undefined, { as: 'manager' });

  // ---------- Rendez-vous ----------
  C.appointments = [];
  const ap = async (label, body) => { const r = await ctx.do(label, 'POST', '/sales/appointments', body, { as: 'manager' }); if (r.id) C.appointments.push(r.id); return r.id; };
  const a1 = await ap('Rendez-vous : visite du chantier Sogea à Bonapriso', { customerId: cu.sogea, date: ctx.day(2), time: '09:00', purpose: 'Métré et planning des livraisons du 3e trimestre', place: 'Chantier Sogea, rue Njo-Njo, Bonapriso', note: 'Venir avec les échantillons de fer HA' });
  const a2 = await ap("Rendez-vous : présentation des carreaux à l'architecte", { customerId: cu.ndjock, date: ctx.day(3), time: '15:00', purpose: 'Présentation de la gamme grès 60×60', place: "Showroom Batimat, Bonabéri" });
  const a3 = await ap('Rendez-vous : négociation du marché de la commune', { customerId: cu.mairie, date: ctx.day(6), time: '10:30', purpose: 'Marché des caniveaux de Kotto (500 sacs)', place: 'Mairie de Douala 5e, Kotto' });
  const a4 = await ap('Rendez-vous : livraison test du groupe électrogène', { customerId: cu.hotel, date: ctx.day(8), time: '11:00', purpose: 'Mise en service du groupe 7,5 kVA', place: 'Hôtel La Falaise, Bonanjo' });
  await ctx.do('Rendez-vous : créneau déjà pris refusé', 'POST', '/sales/appointments', { customerId: cu.bati, date: ctx.day(2), time: '09:30', purpose: 'Doublon' }, { as: 'manager', expect: 400 });
  await ctx.do('Rendez-vous : créneau passé refusé', 'POST', '/sales/appointments', { customerId: cu.bati, date: ctx.day(-1), time: '10:00' }, { as: 'manager', expect: 400 });
  await ctx.do('Rendez-vous : horaire hors ouverture refusé', 'POST', '/sales/appointments', { customerId: cu.bati, date: ctx.day(4), time: '22:30' }, { as: 'manager', expect: 400 });
  if (a2) await ctx.do('Rendez-vous : déplacer (demande de l\'architecte)', 'PUT', `/sales/appointments/${a2}`, { date: ctx.day(4), time: '16:00', note: 'Déplacé à la demande du client' }, { as: 'manager' });
  if (a1) await ctx.do('Rendez-vous : marquer terminé avec compte rendu', 'PUT', `/sales/appointments/${a1}`, { status: 'done', note: 'Besoin confirmé : 300 sacs/mois et 200 barres HA 12 jusqu\'en mars' }, { as: 'manager' });
  if (a4) await ctx.do('Rendez-vous : annulé par le client', 'PUT', `/sales/appointments/${a4}`, { status: 'cancelled', note: 'Le directeur est en déplacement' }, { as: 'manager' });
  const tmp = await ap('Rendez-vous : saisi par erreur', { customerId: cu.quinc, date: ctx.day(9), time: '08:00' });
  if (tmp) await ctx.do('Rendez-vous : supprimer (administration)', 'DELETE', `/sales/appointments/${tmp}`);
  await ctx.do('Rendez-vous : à venir', 'GET', '/sales/appointments', undefined, { as: 'manager' });
  await ctx.do('Rendez-vous : terminés', 'GET', '/sales/appointments?status=done', undefined, { as: 'manager' });
  if (a3) { const ics = await ctx.do('Rendez-vous : ajouter à son agenda (.ics)', 'GET', `/sales/appointments/${a3}/ics`, undefined, { as: 'manager', raw: true }); ctx.check('Agenda : fichier iCalendar', /BEGIN:VCALENDAR/.test(ics.text || ''), ics.status); }
  await ctx.do("Agenda : lien d'abonnement (état)", 'GET', '/sales/calendar');
  const cal = await ctx.do("Agenda : générer le lien d'abonnement (Google Agenda, Outlook)", 'POST', '/sales/calendar/regenerate', {});
  if (cal.path) { const f = await ctx.do('Agenda : flux public des rendez-vous', 'GET', cal.path, undefined, { raw: true }); ctx.check('Agenda public : rendez-vous présents', /SUMMARY:Rendez-vous/.test(f.text || ''), f.status); }

  // ---------- Centre de relances (mode « proposer, je valide », envoi manuel : aucun e-mail) ----------
  await ctx.do('Relances : client opposé aux relances (à sa demande)', 'PUT', `/crm/customers/${cu.particulier}/followup-optout`, { optout: true }, { as: 'manager' });
  await ctx.do('Relances : cadence invalide refusée', 'PUT', '/sales/followups/settings', { cadences: { invoice: '10,3' } }, { expect: 400 });
  await ctx.do('Relances : réglages (proposer, envoi manuel, J+3/J+10/J+20)', 'PUT', '/sales/followups/settings', { mode: 'propose', channel: 'manual', cadences: { invoice: '3,10,20', quote: '3,7', unpaid: '7,15' }, maxPerItem: 3, dayQuota: 30, hourFrom: 8, hourTo: 18 });
  await ctx.do('Relances : personnaliser le modèle « facture échue »', 'PUT', '/sales/followups/templates/invoice', { subject: 'Rappel : facture {numero} — {entreprise}', body: "Bonjour {client},\n\nSauf erreur de notre part, la facture {numero} (reste à payer : {montant}) est échue depuis le {echeance}. Vous pouvez régler par virement ou MTN MoMo au 650 12 34 56.\n\nMerci de votre confiance,\n{entreprise}" }, { as: 'manager' });
  await ctx.do('Relances : aperçu du modèle avec des données d\'exemple', 'POST', '/sales/followups/templates/preview', { subject: 'Rappel {numero}', body: 'Bonjour {client}, reste {montant}.' }, { as: 'manager' });
  await ctx.do('Relances : modèle « devis » personnalisé', 'PUT', '/sales/followups/templates/quote', { subject: 'Votre devis {numero}', body: 'Bonjour {client}, avez-vous pu étudier notre devis {numero} ({montant}) ?' }, { as: 'manager' });
  await ctx.do('Relances : revenir au modèle par défaut (devis)', 'DELETE', '/sales/followups/templates/quote', undefined, { as: 'manager' });
  await ctx.do('Relances : mettre la file à jour', 'POST', '/sales/followups/scan', {}, { as: 'manager' });
  const fu = await ctx.do('Relances : file des relances proposées', 'GET', '/sales/followups', undefined, { as: 'manager' });
  const queue = fu.queue || [];
  ctx.check('Relances : factures échues, devis sans réponse et facture sans échéance proposés', ['invoice', 'quote', 'unpaid'].every((k) => queue.some((x) => x.kind === k)), queue.map((x) => `${x.kind}:${x.customer}`));
  ctx.check("Relances : le client opposé n'est pas relancé", !queue.some((x) => x.customerId === cu.particulier), queue.map((x) => x.customer));
  const pick = (kind, cust) => queue.find((x) => x.kind === kind && (!cust || x.customerId === cust) && !x.used);
  const use = (x) => { if (x) x.used = true; return x; };
  const fa = use(pick('invoice', cu.mairie));
  if (fa) {
    const r = await ctx.do('Relances : envoyer la relance (copie du message et lien WhatsApp, envoi manuel)', 'POST', `/sales/followups/items/${fa.id}/send`, { channel: 'manual' }, { as: 'manager' });
    ctx.check('Relances : message prêt à copier', r.channel === 'manual' && /facture/i.test(r.text || ''), r);
  }
  const fq = use(pick('invoice', cu.quinc));
  if (fq) await ctx.do('Relances : reporter de 7 jours (promesse de paiement)', 'POST', `/sales/followups/items/${fq.id}/postpone`, { days: 7 }, { as: 'manager' });
  const qi = use(pick('quote', cu.immo));
  if (qi) await ctx.do('Relances : le client a répondu (arrêt des relances du devis)', 'POST', `/sales/followups/items/${qi.id}/replied`, {}, { as: 'manager' });
  const un = use(pick('unpaid'));
  if (un) await ctx.do('Relances : ignorer (paiement prévu à la livraison du 2e lot)', 'POST', `/sales/followups/items/${un.id}/ignore`, { reason: 'Paiement prévu à la livraison du 2e lot' }, { as: 'manager' });
  const fb = use(pick('invoice', cu.mairie));
  if (fb) await ctx.do('Relances : choisir le canal de cette relance', 'PUT', `/sales/followups/items/${fb.id}/channel`, { channel: 'manual' }, { as: 'manager' });
  if (fa) await ctx.do('Relances : une relance déjà envoyée ne se reporte pas', 'POST', `/sales/followups/items/${fa.id}/postpone`, { days: 3 }, { as: 'manager', expect: 409 });
  if (C.local) await ctx.do('Relances : passage planifié immédiat (administration)', 'POST', '/sales/followups/run', {});
  const all = await ctx.do('Relances : journal complet', 'GET', '/sales/followups?state=all', undefined, { as: 'manager' });
  ctx.check('Relances : journal (envoi manuel, report, ignorée, arrêtée)', (all.log || []).length >= 4, (all.log || []).map((l) => l.result));
};
