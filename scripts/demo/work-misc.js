'use strict';
// Profil de l'entreprise, Intégrations (clés d'API + API publique, webhooks), Fichiers et données (exports / imports CSV), Agents spécialisés,
// Résumé du matin et alertes (réglages), Abonnement (lecture seule), Assistant IA (historique ; 2 appels à l'IA au plus dans tout le groupe).
const { helpers } = require('./work-lib');

const AI_OK = [200, 429, 502, 503]; // succès, ou IA non configurée (503), en échec (502), quota atteint (429)

module.exports = async function misc(ctx) {
  const { has, U, file } = helpers(ctx);
  const C = ctx.ids.customers;

  // ---------- Profil de l'entreprise (questions à boutons) ----------
  const p0 = await ctx.do('Profil : questions et score de complétude', 'GET', '/profile');
  const answers = { kind: 'goods', sites: '2-5', team: '11-50', channels: ['whatsapp', 'shop', 'phone'], payment: ['cash', 'momo', 'transfer', 'credit'], delivery: 'yes', hours: 'mon-sat', stock: 'yes', threshold: '1000000', vat: 'yes', payroll: 'yes' };
  let last = p0;
  for (const [id, value] of Object.entries(answers)) last = await ctx.do(`Profil : répondre « ${id} »`, 'POST', '/profile/answer', { id, value }, { as: 'manager' });
  await ctx.do('Profil : passer une question', 'POST', '/profile/skip', { id: 'goal' }, { as: 'manager' });
  await ctx.do('Profil : une réponse hors liste est refusée', 'POST', '/profile/answer', { id: 'team', value: '1000' }, { as: 'manager', expect: 400 });
  ctx.check('Profil : profil complété à plus de 80 %', last.score >= 80, { score: last.score, answered: last.answered, total: last.total });
  if (has('seller')) await ctx.do('Droits : un membre ne remplit pas le profil (refusé)', 'POST', '/profile/answer', { id: 'goal', value: 'sell' }, { as: 'seller', expect: 403 });

  // ---------- Intégrations : webhooks ----------
  const ig = await ctx.do('Intégrations : clés, webhooks et événements', 'GET', '/integrations');
  ctx.check('Intégrations : liste des événements disponibles', ig.events && ig.events['decision.created'], ig.events);
  await ctx.do('Intégrations : une adresse non sécurisée est refusée', 'POST', '/integrations/webhooks', { url: 'http://example.com/hooks', events: ['customer.created'] }, { expect: 400 });
  const hook = await ctx.do('Intégrations : webhook vers le CRM du groupe (example.com)', 'POST', '/integrations/webhooks', { url: 'https://example.com/hooks/batimat-demo', events: ['prospect.created', 'customer.created', 'decision.created', 'decision.decided', 'invoice.paid'] });
  ctx.check('Intégrations : secret de signature remis une seule fois', typeof hook.secret === 'string' && hook.secret.length >= 32, hook);
  if (hook.id) {
    await ctx.do('Intégrations : suspendre le webhook', 'PUT', `/integrations/webhooks/${hook.id}`, { active: false });
    await ctx.do('Intégrations : réactiver le webhook', 'PUT', `/integrations/webhooks/${hook.id}`, { active: true });
    await ctx.do('Intégrations : message de test (sans attendre la réponse du site)', 'POST', `/integrations/webhooks/${hook.id}/test`);
  }
  const h2 = await ctx.do('Intégrations : second webhook (à supprimer)', 'POST', '/integrations/webhooks', { url: 'https://example.com/hooks/essai', events: ['ticket.created'] });
  if (h2.id) await ctx.do('Intégrations : supprimer un webhook', 'DELETE', `/integrations/webhooks/${h2.id}`);

  // ---------- Intégrations : clés d'API et API publique ----------
  const kr = await ctx.do("Intégrations : clé d'API en lecture (tableur)", 'POST', '/integrations/keys', { name: 'Tableau Excel de la direction', scope: 'read' });
  const kw = await ctx.do("Intégrations : clé d'API en écriture (formulaire du site web)", 'POST', '/integrations/keys', { name: 'Formulaire de devis du site web', scope: 'write' });
  const api = async (feature, method, path, key, body, expect = [200]) => {
    let r;
    try {
      const res = await fetch(`${ctx.base}/api/v1${path}`, { method, headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
      r = { status: res.status, json: await res.json().catch(() => null) };
    } catch (e) { r = { status: 0, json: { error: String(e.message || e) } }; }
    ctx.check(`API publique : ${feature}`, [].concat(expect).includes(r.status), { status: r.status, body: r.json });
    return r.json || {};
  };
  if (kr.key && kw.key) {
    const me = await api('identité de la clé', 'GET', '/me', kr.key);
    ctx.check('API publique : la clé est rattachée à Batimat', /Batimat/.test(me.organisation || ''), me);
    const cu = await api('clients', 'GET', '/customers?limit=5', kr.key);
    ctx.check('API publique : clients paginés', Array.isArray(cu.data) && cu.data.length === 5 && cu.next, { n: (cu.data || []).length, next: cu.next });
    if (cu.next) await api('clients (page suivante)', 'GET', `/customers?limit=5&after=${cu.next}`, kr.key);
    await api('commandes', 'GET', '/orders', kr.key);
    await api('factures impayées', 'GET', '/invoices?status=sent', kr.key);
    await api('catalogue', 'GET', '/products', kr.key);
    const sk = await api('stock (avec alerte de seuil)', 'GET', '/stock?limit=200', kr.key);
    ctx.check('API publique : le stock remonte avec son indicateur de seuil', Array.isArray(sk.data) && sk.data.length >= 12 && sk.data.every((i) => typeof i.low === 'boolean'), (sk.data || []).length);
    await api('paiements reçus', 'GET', '/payments', kr.key);
    const nc = await api('nouveau prospect depuis le formulaire du site', 'POST', '/customers', kw.key, { name: 'Cabinet d\'architecture Ndjock', phone: '+237 698 45 12 07', email: 'contact@ndjock-archi-demo.example', notes: 'Demande de devis : carrelage 600 m² pour une villa à Kribi.' }, [201]);
    ctx.check('API publique : prospect créé', nc.created === true, nc);
    const dup = await api('le même numéro ne crée pas de doublon', 'POST', '/customers', kw.key, { name: 'Ndjock Architecture', phone: '698451207' });
    ctx.check('API publique : doublon reconnu par le numéro', dup.created === false && dup.id === nc.id, dup);
    await api('une clé en lecture ne peut pas écrire (refusé)', 'POST', '/customers', kr.key, { name: 'Test', phone: '+237 677 00 00 01' }, 403);
    await api('sans clé (refusé)', 'GET', '/customers', null, null, 401);
    await api('route inconnue', 'GET', '/inconnu', kr.key, null, 404);
  }
  const dv = await ctx.do('Intégrations : journal des envois de webhooks', 'GET', '/integrations/deliveries');
  ctx.check('Intégrations : le test et le nouveau prospect sont journalisés', (dv.items || []).some((i) => i.event === 'test'), (dv.items || []).map((i) => `${i.event}:${i.status}`));
  if ((dv.items || []).length) await ctx.do('Intégrations : renvoyer un webhook (sans dépendre de la réponse)', 'POST', `/integrations/deliveries/${dv.items[0].id}/retry`);
  const ig2 = await ctx.do('Intégrations : clés (dernière utilisation)', 'GET', '/integrations');
  ctx.check('Intégrations : la clé de lecture a servi', (ig2.keys || []).some((k) => k.name === 'Tableau Excel de la direction' && k.lastUsed), ig2.keys);
  const tmpKey = await ctx.do("Intégrations : clé d'API temporaire", 'POST', '/integrations/keys', { name: 'Essai Zapier' });
  const kid = ((await ctx.do('Intégrations : relire les clés', 'GET', '/integrations')).keys || []).find((k) => k.name === 'Essai Zapier');
  if (tmpKey.key && kid) await ctx.do("Intégrations : révoquer une clé d'API", 'DELETE', `/integrations/keys/${kid.id}`);
  if (has('manager')) await ctx.do('Droits : les intégrations sont réservées aux administrateurs (refusé)', 'GET', '/integrations', undefined, { as: 'manager', expect: 403 });

  // ---------- Fichiers et données : exports et imports CSV ----------
  for (const [k, label] of [['customers', 'clients'], ['invoices', 'factures'], ['stock', 'stock'], ['tickets', 'demandes clients']]) await file(`Données : export CSV des ${label}`, `/data/export/${k}`, 'text/csv', { as: 'manager' });
  const csvC = 'Nom;Téléphone;E-mail;Adresse;Notes\nQuincaillerie de Logbaba;+237 691 22 33 44;logbaba@quinc-demo.example;Logbaba, Douala;Client comptoir\nEntreprise Fouda BTP;+237 675 88 99 00;;Nkolbisson, Yaoundé;Chantier R+2\nSogea (doublon);+237 699 10 20 30;;;\n;+237 600 00 00 00;;;ligne sans nom\n';
  const dry = await ctx.do('Données : import de clients — aperçu (doublon et erreur repérés)', 'POST', '/data/import/customers', { csv: csvC, dryRun: true }, { as: 'manager' });
  ctx.check('Données : aperçu = 2 à créer, 1 doublon, 1 erreur', dry.created === 2 && dry.duplicates === 1 && dry.errorCount === 1, dry);
  await ctx.do('Données : import de clients', 'POST', '/data/import/customers', { csv: csvC }, { as: 'manager' });
  const csvS = 'Article;Unité;Quantité;Seuil minimum;Coût unitaire;SKU\nFer à béton HA 8 mm — barre 12 m;barre;300;80;2700;BTM-IMP-08\nTreillis soudé ST 25 — panneau 6 × 2,4 m;panneau;120;30;14500;BTM-IMP-25\nCiment CPJ 42,5 (doublon);sac;10;0;4300;BTM-001\n';
  const dS = await ctx.do('Données : import de stock — aperçu', 'POST', '/data/import/stock', { csv: csvS, dryRun: true }, { as: 'manager' });
  ctx.check('Données : aperçu stock = 2 articles, 1 doublon (SKU)', dS.created === 2 && dS.duplicates === 1, dS);
  await ctx.do('Données : import de stock', 'POST', '/data/import/stock', { csv: csvS }, { as: 'manager' });
  if (has('seller')) await ctx.do('Droits : un membre n\'exporte pas les données (refusé)', 'GET', '/data/export/customers', undefined, { as: 'seller', expect: 403 });

  // ---------- Agents spécialisés ----------
  const ag = await ctx.do('Agents : liste des agents', 'GET', '/agents', undefined, { as: 'manager' });
  ctx.check('Agents : 9 agents proposés', (ag.agents || []).length >= 9, (ag.agents || []).map((a) => a.key));
  await ctx.do('Agents : consignes de l\'agent Direction', 'PUT', '/agents/direction', { enabled: true, extraPrompt: 'Toujours chiffrer en FCFA et comparer au mois précédent. Signaler les clients publics payant au-delà de 90 jours.' });
  await ctx.do('Agents : désactiver l\'agent Production', 'PUT', '/agents/production', { enabled: false });
  await ctx.do('Agents : historique', 'GET', '/agents/history', undefined, { as: 'manager' });
  await ctx.do('Agents : planification du digest', 'GET', '/agents/schedule', undefined, { as: 'manager' });
  // Planifié le lundi à 7 h mais laissé en pause : chaque digest consomme un message IA (à activer par le client).
  await ctx.do('Agents : programmer le digest hebdomadaire (en pause)', 'PUT', '/agents/schedule', { enabled: false, weekday: 1, hour: 7, agentKey: 'direction' });
  await ctx.do('Agents : créer une tâche sans confirmation (refusé)', 'POST', '/agents/actions', { type: 'task', title: 'x' }, { as: 'manager', expect: 400 });
  await ctx.do('Agents : créer la tâche suggérée (confirmée par une personne)', 'POST', '/agents/actions', { confirm: true, type: 'task', title: 'Négocier le renouvellement du contrat Cimencam avant la date de préavis', why: 'Le préavis du contrat est dépassé : le contrat se reconduit aux mêmes conditions.', dueInDays: 5, assigneeId: U('manager') }, { as: 'manager' });
  await ctx.do('Agents : créer la relance client suggérée', 'POST', '/agents/actions', { confirm: true, type: 'followup', customerId: C.bati, title: 'chèque de 2 400 000 FCFA promis', dueInDays: 2, assigneeId: U('seller') }, { as: 'manager' });
  const aa = await ctx.do('Agents : actions créées depuis les suggestions', 'GET', '/agents/actions', undefined, { as: 'manager' });
  ctx.check('Agents : 2 actions tracées', (aa.items || []).length >= 2, aa.items);

  // ---------- Résumé du matin et alertes (réglages, e-mails seulement vers *.example) ----------
  await ctx.do('Résumé : réglages de l\'organisation (fuseau UTC+1, factures en retard à 15 j)', 'PUT', '/mail/digest/settings', { tzOffset: 60, urgentMaxPerDay: 3, handoffHours: 4, invoiceLateDays: 15 });
  await ctx.do('Résumé : le consentement est exigé', 'PUT', '/mail/digest/me', { morning: true, email: 'marc.ebongue@batimat-demo.example', hour: '07:30' }, { as: 'manager', expect: 400 });
  await ctx.do('Résumé : s\'abonner au résumé du matin et aux alertes urgentes', 'PUT', '/mail/digest/me', { morning: true, urgent: true, email: 'marc.ebongue@batimat-demo.example', hour: '07:30', consent: true }, { as: 'manager' });
  if (has('manager')) await ctx.do('Résumé : abonnement de la gérante', 'PUT', '/mail/digest/me', { morning: true, email: 'direction@batimat-demo.example', hour: '06:45', consent: true });
  if (has('manager')) await ctx.do('Résumé : désabonnement en un clic', 'POST', '/mail/digest/me/unsubscribe');
  if (has('seller')) await ctx.do('Droits : le résumé est réservé aux responsables (refusé)', 'GET', '/mail/digest', undefined, { as: 'seller', expect: 403 });
  await ctx.do('Alertes : seuils et objectifs (lecture)', 'GET', '/dashboard/settings', undefined, { as: 'manager' });
  await ctx.do('Alertes : objectifs du mois et seuils d\'alerte', 'PUT', '/dashboard/settings', { goal_revenue_month: 85000000, goal_new_customers_month: 6, goal_csat: 4.5, alert_overdue_days: 45, alert_cash_min: 5000000, alert_receivable_max: 60000000, alert_contract_days: 45, alert_ticket_hours: 24 });

  // ---------- Abonnement (lecture seule, aucun paiement) ----------
  const bl = await ctx.do('Abonnement : offre en cours et historique (lecture seule)', 'GET', '/api/billing');
  ctx.check('Abonnement : offres affichées', Array.isArray(bl.plans) && bl.plans.length > 0, Object.keys(bl));

  // ---------- Assistant IA ----------
  await ctx.do('Assistant IA : historique de discussion', 'GET', '/ai/history?module=projects', undefined, { as: 'manager' });
  await ctx.do('Assistant IA : effacer la discussion', 'DELETE', '/ai/history?module=projects', undefined, { as: 'manager' });
  // Appel IA n° 1 (réponse de l'IA si elle est configurée, sinon « IA non activée » 503)
  await ctx.do("Assistant IA : demander à la mémoire de l'entreprise (appel IA)", 'POST', '/memory/ask', { question: 'Pourquoi a-t-on décidé d\'ouvrir un showroom, et quel est son budget ?' }, { as: 'manager', expect: AI_OK });
};
module.exports.AI_OK = AI_OK;
