'use strict';
// Vague 3 · Service client (SLA, satisfaction, base de connaissances, lien client, formulaire public, réponse par e-mail, rapports)
// et Marketing (consentement, segmentation, envoi groupé avec quotas, codes promo).
// Lancez-le avec : node scripts/test-wave3-support.js
const { run } = require('./lib/wave1');
const { fakeSmtp, fakeAi } = require('./lib/fakes');
const addDays = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

const mailbox = []; const aiSeen = [];
run('Vague 3 · Service client et Marketing', async ({ check, owner, mgr, mem, other, org, ws, O, dbx, base }) => {
  const S = `${O}/support`;
  const intake = (await owner('GET', O)).json.intakeToken;
  const anon = async (method, url, body) => { const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); let json = null; try { json = await res.json(); } catch { /* vide */ } return { status: res.status, json }; };

  // Réglages SLA
  let r = await mem('GET', `${S}/settings`);
  check('SLA : réglages fermés aux membres', r.status === 403);
  r = await mgr('PUT', `${S}/settings`, { sla_first_normal: 2 });
  check('SLA : modification réservée aux administrateurs', r.status === 403);
  r = await owner('PUT', `${S}/settings`, { sla_first_normal: 2, sla_resolve_normal: 10 });
  check('SLA : délais réglables', r.status === 200 && r.json.settings.sla_first_normal === 2, r.json);
  r = await owner('PUT', `${S}/settings`, { sla_first_normal: -5 });
  check('SLA : valeur négative refusée', r.status === 400);

  // Fiche client + formulaire public
  r = await mgr('POST', `${O}/crm/customers`, { name: 'Client Fidèle', email: 'fidele@exemple.com', phone: '655 12 34 56' });
  const cust = r.json.id;
  r = await anon('POST', `/api/ws/public/intake/${intake}`, { name: 'Client Fidèle', email: 'fidele@exemple.com', subject: 'Livraison en retard', message: 'Où est ma commande ?' });
  check('formulaire public : demande créée avec une référence', r.status === 201 && /^T-\d{4}-\d{4}$/.test(r.json.ref), r.json);
  r = await anon('POST', `/api/ws/public/intake/${intake}`, { name: 'X', email: 'pas-un-mail', message: 'Bonjour' });
  check('formulaire public : e-mail invalide refusé', r.status === 400);
  r = await anon('POST', `/api/ws/public/intake/0000`, { name: 'X', message: 'Bonjour' });
  check('formulaire public : jeton inconnu', r.status === 404);
  r = await mgr('GET', S);
  const t1 = r.json.tickets.find((t) => t.subject === 'Livraison en retard');
  check('le ticket est lié à la fiche client (même e-mail)', t1.customerId === cust, t1);
  const created = Date.parse(t1.createdAt);
  check('délais SLA calculés (2 h pour la première réponse, 10 h pour la résolution)', Math.abs(Date.parse(t1.firstDueAt) - created - 2 * 3600000) < 5000 && Math.abs(Date.parse(t1.dueAt) - created - 10 * 3600000) < 5000 && t1.slaFirst === 'pending', t1);
  r = await mgr('POST', S, { customerName: 'Marie', customerContact: '699 00 11 22', subject: 'Panne', priority: 'high', message: 'Urgent' });
  const t2 = r.json.id;
  r = await mgr('GET', `${S}/${t2}`);
  check('priorité haute : délai de 8 h par défaut pour la résolution', Math.abs(Date.parse(r.json.ticket.dueAt) - Date.parse(r.json.ticket.createdAt) - 8 * 3600000) < 5000, r.json.ticket);

  // Dépassement
  await dbx.prepare('UPDATE tickets SET first_due_at = ? WHERE id = ?').run(new Date(Date.now() - 3600000).toISOString(), t2);
  r = await mgr('GET', S);
  check('délai de première réponse dépassé signalé', r.json.tickets.find((t) => t.id === t2).slaFirst === 'breached' && r.json.breached >= 1, r.json.breached);
  r = await mgr('GET', `${O}/dashboard/alerts`);
  check('alerte SLA dans le tableau de bord', r.json.alerts.some((a) => a.module === 'support' && /délai/.test(a.text)), r.json.alerts.filter((a) => a.module === 'support'));

  // Réponses au client
  r = await mgr('POST', `${S}/${t1.id}/messages`, { content: 'Bonjour, votre colis part demain.', send: true });
  check('réponse enregistrée même si l\'e-mail n\'est pas configuré (échec expliqué)', r.status === 201 && r.json.delivery && r.json.delivery.via === 'email' && r.json.delivery.status === 'failed', r.json);
  r = await mgr('GET', `${S}/${t1.id}`);
  check('première réponse horodatée, ticket passé « en attente »', r.json.ticket.firstResponseAt && r.json.ticket.slaFirst === 'met' && r.json.ticket.status === 'pending' && r.json.messages.some((m) => m.sendStatus === 'failed'), r.json.ticket);
  r = await mgr('POST', `${S}/${t2}/messages`, { content: 'Nous arrivons.', send: true });
  check('contact téléphonique sans WhatsApp connecté : échec expliqué', r.json.delivery.via === 'whatsapp' && r.json.delivery.status === 'failed' && /WhatsApp/.test(r.json.delivery.error), r.json);
  r = await mgr('POST', `${S}/${t2}/messages`, { content: 'Note interne sans envoi.' });
  check('réponse sans envoi : aucune livraison tentée', r.status === 201 && r.json.delivery === undefined);

  // Résolution + CSAT
  r = await mgr('PUT', `${S}/${t1.id}`, { status: 'resolved' });
  check('ticket résolu', r.status === 200, r.json);
  r = await mgr('GET', `${S}/${t1.id}`);
  const link = r.json.ticket.csatLink; const token = (link || '').split('/').pop();
  check('lien de satisfaction généré, résolution horodatée', /^[a-f0-9]{24}$/.test(token) && r.json.ticket.resolvedAt && r.json.ticket.slaResolve === 'met', r.json.ticket);
  r = await anon('GET', `/api/ws/public/csat/${token}`);
  check('page publique de satisfaction : sujet et organisation', r.status === 200 && r.json.organisation === 'Boutique Awa' && r.json.answered === false, r.json);
  r = await anon('POST', `/api/ws/public/csat/${token}`, { score: 9 });
  check('note hors 1-5 refusée', r.status === 400);
  r = await anon('POST', `/api/ws/public/csat/${token}`, { score: 5, comment: 'Rapide, merci' });
  check('avis du client enregistré', r.status === 200);
  r = await anon('POST', `/api/ws/public/csat/${token}`, { score: 1 });
  check('un seul avis par demande', r.status === 409);
  r = await anon('GET', `/api/ws/public/csat/${'a'.repeat(24)}`);
  check('lien inconnu : 404', r.status === 404);
  r = await mgr('GET', `${S}/report`);
  check('rapport : volumes, délais moyens, respect des SLA, satisfaction', r.json.total === 2 && r.json.csat.average === 5 && r.json.csat.count === 1 && r.json.avgFirstResponseMinutes !== null && r.json.avgResolutionHours !== null && r.json.slaFirstRate === 50 && r.json.byChannel.formulaire === 1 && r.json.perAssignee.length >= 1, r.json);
  r = await mem('GET', `${S}/report`);
  check('rapport réservé aux responsables', r.status === 403);
  r = await mgr('PUT', `${S}/${t1.id}`, { status: 'open' });
  r = await mgr('GET', `${S}/${t1.id}`);
  check('réouverture : date de résolution effacée', r.json.ticket.resolvedAt === null);
  r = await mgr('GET', `${S}?customerId=${cust}`);
  check('tickets d\'un client', r.json.tickets.length === 1 && r.json.tickets[0].id === t1.id);
  r = await mgr('PUT', `${S}/${t2}`, { customerId: cust });
  check('lien manuel ticket - fiche client', r.status === 200);
  r = await mgr('PUT', `${S}/${t2}`, { customerId: 999999 });
  check('client inconnu refusé', r.status === 404);

  // Base de connaissances
  r = await mgr('POST', `${S}/kb`, { title: 'Quels sont les délais de livraison ?', body: 'Livraison en 48 h à Douala, 5 jours ailleurs.', category: 'Livraison', published: true });
  check('article créé', r.status === 201, r.json);
  await mgr('POST', `${S}/kb`, { title: 'Brouillon interne', body: 'Pas encore validé', published: false });
  r = await mem('POST', `${S}/kb`, { title: 'x', body: 'y' });
  check('base de connaissances : écriture réservée aux responsables', r.status === 403);
  r = await mem('GET', `${S}/kb`);
  check('un membre ne voit que les articles publiés', r.json.items.length === 1 && r.json.items[0].published === true);
  r = await mgr('GET', `${S}/kb?q=douala`);
  check('recherche dans la base', r.json.items.length === 1);
  r = await anon('GET', `/api/ws/public/intake/${intake}/info`);
  check('FAQ publique : seuls les articles publiés', r.status === 200 && r.json.faq.length === 1 && r.json.faq[0].question.includes('livraison'), r.json);

  // Isolation
  r = await other('GET', `${ws(org)}/support/kb`);
  check('autre organisation : aucun accès', r.status === 404);

  // ---------- Marketing ----------
  const M = `${O}/marketing`;
  r = await mgr('POST', `${O}/crm/customers`, { name: 'Consentant Un', email: 'c1@exemple.com', phone: '670000001' });
  const c1 = r.json.id;
  r = await mgr('POST', `${O}/crm/customers`, { name: 'Sans Accord', email: 'c2@exemple.com', phone: '670000002' });
  const c2 = r.json.id;
  r = await mgr('POST', `${O}/crm/customers`, { name: 'Sans Mail', phone: '670000003' });
  const c3 = r.json.id;
  r = await mem('POST', `${M}/consent`, { customerIds: [c1], consent: true, confirm: true });
  check('consentement : réservé aux responsables', r.status === 403);
  r = await mgr('POST', `${M}/consent`, { customerIds: [c1, c3], consent: true });
  check('consentement : confirmation exigée', r.status === 400);
  r = await mgr('POST', `${M}/consent`, { customerIds: [c1, c3], consent: true, confirm: true, source: 'Formulaire papier' });
  check('consentement enregistré (source et date)', r.json.updated === 2);
  r = await mgr('POST', `${M}/segments/preview`, { filter: { hasEmail: true } });
  check('aperçu de segment : clients avec e-mail et consentement', r.json.count === 3 && r.json.withConsent === 1, r.json);
  r = await mgr('POST', `${M}/segments`, { name: 'Avec e-mail', filter: { hasEmail: true } });
  const seg = r.json.id;
  r = await mgr('GET', `${M}/segments`);
  check('segment enregistré avec ses effectifs', r.json.items[0].count === 3);
  r = await mgr('POST', `${M}/broadcasts`, { name: 'Promo', channel: 'email', subject: 'Offre', body: 'Bonjour {nom}', segmentId: seg, preview: true });
  check('aperçu d\'envoi : 1 destinataire, 2 sans consentement ou sans adresse', r.json.preview === true && r.json.recipients === 1 && r.json.noConsent === 2 && r.json.noAddress === 0, r.json);
  r = await mgr('POST', `${M}/broadcasts`, { name: 'Promo', channel: 'email', subject: 'Offre', body: 'Bonjour {nom}', segmentId: seg });
  check('envoi groupé impossible sans service e-mail configuré', r.status === 503, r.json);
  r = await mgr('POST', `${M}/broadcasts`, { name: 'WA', channel: 'whatsapp', body: 'Salut', segmentId: seg, templateId: 1 });
  check('WhatsApp groupé : modèle inconnu refusé', r.status === 404);
  r = await mgr('POST', `${M}/consent`, { customerIds: [c1], consent: false });
  r = await mgr('POST', `${M}/segments/preview`, { filter: { consentOnly: true } });
  check('retrait du consentement pris en compte', r.json.count === 1, r.json);
  r = await mgr('POST', `${M}/broadcasts`, { name: 'Vide', channel: 'email', subject: 'S', body: 'B', filter: { stage: 'client' } });
  check('aucun destinataire consentant : refusé', r.status === 400, r.json);

  // Codes promo
  r = await mgr('POST', `${M}/promo`, { code: 'bienvenue10', kind: 'percent', value: 10, maxUses: 1 });
  check('code promo créé (majuscules)', r.status === 201);
  r = await mgr('POST', `${M}/promo`, { code: 'BIENVENUE10', kind: 'percent', value: 10 });
  check('code en double refusé', r.status === 409);
  r = await mgr('POST', `${M}/promo`, { code: 'FOU', kind: 'percent', value: 150 });
  check('remise > 100 % refusée', r.status === 400);
  r = await mgr('POST', `${O}/crm/documents`, { kind: 'invoice', customerId: cust, lines: [{ label: 'Article', quantity: 2, price: 50000 }], pricesIncl: true });
  const inv = r.json.id;
  r = await mgr('POST', `${M}/promo/apply`, { documentId: inv, code: 'bienvenue10' });
  check('code promo appliqué : -10 % (10 000), total 90 000', r.status === 200 && r.json.discount === 10000 && r.json.total === 90000, r.json);
  r = await mgr('GET', `${O}/crm/documents?kind=invoice`);
  const d = r.json.documents.find((x) => x.id === inv);
  check('la facture porte la ligne « Remise » et le bon total TTC/HT', d.total === 90000 && d.lines.some((l) => /^Remise/.test(l.label) && l.price === -10000) && d.subtotalHt === Math.round(90000 / 1.1925), d);
  r = await mgr('POST', `${M}/promo/apply`, { documentId: inv, code: 'BIENVENUE10' });
  check('un seul code par document', r.status === 409);
  r = await mgr('PUT', `${O}/crm/documents/${inv}`, { note: 'modifié' });
  check('la facture reste modifiable avec sa remise', r.status === 200);
  r = await mgr('POST', `${O}/crm/documents`, { kind: 'quote', customerId: cust, lines: [{ label: 'Autre', quantity: 1, price: 20000 }] });
  r = await mgr('POST', `${M}/promo/apply`, { documentId: r.json.id, code: 'BIENVENUE10' });
  check('nombre maximal d\'utilisations respecté', r.status === 400 && /maximal/.test(r.json.error), r.json);
  r = await mgr('DELETE', `${M}/promo/apply/${inv}`);
  check('code retiré : total d\'origine rétabli', r.json.total === 100000);
  r = await mgr('PUT', `${O}/crm/documents/${inv}`, { lines: [{ label: 'Remise (manuelle)', quantity: 1, price: -5 }] });
  r = await mgr('PUT', `${O}/crm/documents/${inv}`, { lines: [{ label: 'Article', quantity: 1, price: -5 }] });
  check('prix négatif refusé hors ligne « Remise »', r.status === 400);
  await mgr('POST', `${O}/crm/documents/${inv}/convert`, {}).catch(() => {});

  // Désinscription publique
  const crypto = require('crypto');
  r = await anon('GET', `/api/ws/public/unsubscribe/${org}.${c3}.bad`);
  check('désinscription : signature invalide refusée', r.status === 404);
  const row = await dbx.prepare('SELECT 1 FROM customers WHERE id = ? AND marketing_consent = 1').get(c3);
  check('le consentement reste en place après un lien invalide', !!row);
  void crypto; void addDays;
}, {
  setup: async () => {
    const smtp = await fakeSmtp(mailbox); const ai = await fakeAi(aiSeen);
    return { env: { SMTP_HOST: '', ANTHROPIC_API_KEY: '' }, smtp, ai };
  },
  teardown: async (x) => { x.smtp.srv.close(); x.ai.srv.close(); },
});
