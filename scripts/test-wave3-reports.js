'use strict';
// Vague 3 · Tableau de bord (KPI, seuils, objectifs, CSV), export / import CSV, agents (digest planifié, actions confirmées), contextes IA,
// envois groupés réels (faux SMTP), réponse de ticket par e-mail, API publique étendue, historique des webhooks, reçu d'abonnement.
// Lancez-le avec : node scripts/test-wave3-reports.js
const http = require('http');
const { run, client } = require('./lib/wave1');
const { fakeSmtp, fakeAi } = require('./lib/fakes');
const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const mailbox = []; const aiSeen = []; const hits = []; let hookStatus = 200;
const flat = (m) => m.replace(/=\r?\n/g, '').replace(/=3D/g, '=');

run('Vague 3 · Tableau de bord, CSV, agents, API, webhooks, reçu', async ({ check, owner, mgr, mem, other, org, ws, O, dbx, base, extra }) => {
  const members = (await owner('GET', `${O}/members`)).json.members;
  const memId = members.find((m) => m.name === 'Paul').userId; const ownerId = members.find((m) => m.name === 'Awa').userId;
  const anon = async (method, url) => { const res = await fetch(base + url, { method }); return { status: res.status, text: await res.text() }; };

  // ---------- Tableau de bord ----------
  let r = await mgr('POST', `${O}/crm/customers`, { name: '=HYPERLINK("http://x")', email: 'a@exemple.com', phone: '671111111' });
  const cA = r.json.id;
  r = await mgr('POST', `${O}/crm/documents`, { kind: 'invoice', customerId: cA, issued: day(-50), due: day(-45), lines: [{ label: 'Vente', quantity: 1, price: 119250 }], pricesIncl: true });
  const inv = r.json.id;
  await mgr('PUT', `${O}/crm/documents/${inv}`, { status: 'sent' });
  r = await mgr('GET', `${O}/dashboard/kpis`);
  check('KPI : créances par âge (31 à 60 jours)', r.status === 200 && r.json.receivables.aging.d31_60 === 119250 && r.json.receivables.total === 119250, r.json.receivables);
  const m0 = day(-50).slice(0, 7);
  r = await mgr('GET', `${O}/dashboard/kpis?month=${m0}`);
  check('KPI : chiffre d\'affaires HT du mois de la facture', r.json.revenue === 100000, r.json);
  await mgr('POST', `${O}/crm/documents/${inv}/payments`, { amount: 19250, method: 'cash' });
  r = await mgr('GET', `${O}/dashboard/kpis?month=${m0}`);
  check('KPI : créances après paiement partiel', r.json.receivables.total === 100000, r.json.receivables);
  check('KPI : série sur 6 mois et marge estimée', r.json.series.length === 6 && typeof r.json.margin === 'number' && /Estimation/.test(r.json.marginNote));
  r = await mem('GET', `${O}/dashboard/kpis`);
  check('KPI : réservé aux responsables', r.status === 403);
  r = await mgr('PUT', `${O}/dashboard/settings`, { goal_revenue_month: 1 });
  check('seuils et objectifs : modification réservée aux administrateurs', r.status === 403);
  r = await owner('PUT', `${O}/dashboard/settings`, { alert_receivable_max: 50000, goal_revenue_month: 200000, alert_overdue_days: 90 });
  check('seuils et objectifs enregistrés', r.status === 200 && r.json.settings.alert_receivable_max === 50000);
  r = await mgr('GET', `${O}/dashboard/kpis?month=${m0}`);
  check('objectif de CA : progression en %', r.json.goals.revenue.percent === 50, r.json.goals);
  r = await mgr('GET', `${O}/dashboard/alerts`);
  check('alerte : créances au-dessus du seuil configuré', r.json.alerts.some((a) => /dépassent votre seuil/.test(a.text)), r.json.alerts.map((a) => a.text));
  check('seuil de retard réglable (90 j) : alerte moyenne et non urgente', r.json.alerts.find((a) => a.module === 'crm' && /impayée/.test(a.text)).level === 'medium');
  r = await mgr('GET', `${O}/dashboard/kpis.csv?month=${m0}`);
  check('export CSV du tableau de bord', r.status === 200 && /text\/csv/.test(r.headers.get('content-type')) && r.text.includes('Chiffre d\'affaires HT;100000'), r.text.slice(0, 200));

  // ---------- Export / import CSV ----------
  r = await mgr('GET', `${O}/data/export/customers`);
  check('export clients : CSV avec en-tête UTF-8', r.status === 200 && r.text.charCodeAt(0) === 0xfeff && r.text.includes('Nom;Téléphone'));
  check('export : cellule commençant par « = » neutralisée (pas de formule)', r.text.includes(`'=HYPERLINK`) && !/;=HYPERLINK|^=HYPERLINK/m.test(r.text.replace(`'=HYPERLINK`, '')), r.text.slice(0, 300));
  r = await mgr('GET', `${O}/data/export/invoices`);
  check('export factures', r.status === 200 && r.text.includes('F-') && r.text.includes('119250'));
  r = await mgr('GET', `${O}/data/export/tickets`);
  check('export tickets', r.status === 200 && r.text.startsWith('﻿Référence'));
  r = await mgr('GET', `${O}/data/export/inconnu`);
  check('export inconnu refusé', r.status === 404);
  r = await mem('GET', `${O}/data/export/customers`);
  check('export réservé aux responsables', r.status === 403);
  const csv = 'Nom;Téléphone;E-mail;Notes\nAlice Import;655000111;alice@exemple.com;VIP\nDoublon;;A@exemple.com;\nBad Mail;;pas-un-mail;\n;655000222;;sans nom\nBob Import;655000333;;\n';
  r = await mgr('POST', `${O}/data/import/customers`, { csv, dryRun: true });
  check('import clients : aperçu sans écriture', r.json.dryRun === true && r.json.created === 2 && r.json.duplicates === 1 && r.json.errorCount === 2, r.json);
  r = await mgr('GET', `${O}/crm/customers`);
  const before = r.json.customers.length;
  r = await mgr('POST', `${O}/data/import/customers`, { csv });
  check('import clients : 2 créés, 1 doublon, 2 erreurs avec numéro de ligne', r.json.created === 2 && r.json.errors.some((e) => e.line === 4) && r.json.errors.some((e) => e.line === 5), r.json);
  r = await mgr('GET', `${O}/crm/customers`);
  check('les clients importés existent (prospects, consentement non importé)', r.json.customers.length === before + 2 && r.json.customers.find((c) => c.name === 'Alice Import').source === 'import');
  r = await mgr('POST', `${O}/data/import/customers`, { csv });
  check('ré-import : tout est repéré comme doublon', r.json.created === 0 && r.json.duplicates >= 3, r.json);
  r = await mgr('POST', `${O}/data/import/customers`, { csv: 'Prénom;Autre\nA;B' });
  check('colonne « Nom » absente : explication', r.status === 400);
  r = await mgr('POST', `${O}/data/import/stock`, { csv: 'Article;SKU;Unité;Quantité;Seuil minimum;Coût unitaire\nSavon;SAV-1;pièce;40;10;500\nHuile;HUI-1;litre;5,5;2;1200\nSavon bis;SAV-1;pièce;1;1;1\nCassé;CAS-1;pièce;abc;;\n' });
  check('import stock : 2 créés, 1 doublon de SKU, 1 erreur', r.json.created === 2 && r.json.duplicates === 1 && r.json.errorCount === 1, r.json);
  r = await mgr('GET', `${O}/data/export/stock`);
  check('stock importé avec quantités (virgule décimale comprise)', r.text.includes('Savon;SAV-1;;pièce;40') && r.text.includes('Huile;HUI-1;;litre;5.5'), r.text);

  // ---------- Envoi groupé réel (faux SMTP) ----------
  const ids = [];
  for (const [n, e] of [['Cons Un', 'u1@exemple.com'], ['Cons Deux', 'u2@exemple.com'], ['Cons Trois', 'u3@exemple.com'], ['Pas Accord', 'u4@exemple.com']]) ids.push((await mgr('POST', `${O}/crm/customers`, { name: n, email: e })).json.id);
  await mgr('POST', `${O}/marketing/consent`, { customerIds: ids.slice(0, 3), consent: true, confirm: true });
  const filter = { source: '' , hasEmail: true, consentOnly: true };
  r = await mgr('POST', `${O}/marketing/broadcasts`, { name: 'Soldes', channel: 'email', subject: 'Soldes', body: 'Bonjour {nom}, -20 % cette semaine.', filter });
  check('envoi groupé : seuls les clients consentants reçoivent', r.status === 201 && r.json.sent === 3 && r.json.failed === 0, r.json);
  await new Promise((s) => setTimeout(s, 500));
  const mails = mailbox.map(flat).filter((m) => /Soldes/.test(m));
  check('3 e-mails reçus, personnalisés, avec lien de désinscription', mails.length === 3 && mails.every((m) => /unsubscribe\//.test(m)) && mails.some((m) => /Bonjour Cons/.test(m)) && !mails.some((m) => /u4@exemple/.test(m)), mails.length);
  r = await owner('PUT', `${O}/marketing/settings`, { mkt_day_quota: 4 });
  r = await mgr('POST', `${O}/marketing/broadcasts`, { name: 'Relance', channel: 'email', subject: 'Relance', body: 'Encore un message', filter, preview: true });
  check('quota journalier : 1 envoi restant, 2 refusés', r.json.recipients === 1 && r.json.overQuota === 2 && r.json.quotaLeft === 1, r.json);
  const tok = /unsubscribe\/(\d+\.\d+\.[a-f0-9]{24})/.exec(mails[0])[1];
  r = await anon('GET', `/api/ws/public/unsubscribe/${tok}`);
  check('désinscription en un clic', r.status === 200 && /Vous ne recevrez plus/.test(r.text));
  const cid = Number(tok.split('.')[1]);
  const row = await dbx.prepare('SELECT marketing_consent c, consent_source s FROM customers WHERE id = ?').get(cid);
  check('le consentement est retiré et la source consignée', Number(row.c) === 0 && /désinscription/.test(row.s));
  r = await mgr('GET', `${O}/marketing/broadcasts`);
  check('historique des envois groupés', r.json.items[0].sent === 3 && r.json.quotaToday === 3);

  // ---------- Réponse de ticket par e-mail ----------
  r = await mgr('POST', `${O}/support`, { customerName: 'Client Mail', customerContact: 'client.mail@exemple.com', subject: 'Question facture', message: 'Bonjour' });
  const tk = r.json.id;
  r = await mgr('POST', `${O}/support/${tk}/messages`, { content: 'Votre facture est jointe.', send: true });
  check('réponse envoyée au client par e-mail', r.json.delivery.status === 'sent' && r.json.delivery.via === 'email', r.json);
  await mgr('PUT', `${O}/support/${tk}`, { status: 'resolved' });
  await new Promise((s) => setTimeout(s, 500));
  const got = mailbox.map(flat);
  check('le client reçoit la réponse et la demande d\'avis avec son lien', got.some((m) => /Votre facture est jointe/.test(m)) && got.some((m) => /satisfaction\/[a-f0-9]{24}/.test(m)), got.length);

  // ---------- Contextes IA ----------
  r = await owner('POST', `${O}/support/kb`, { title: 'Quels moyens de paiement ?', body: 'Mobile Money et espèces.', published: true });
  const chat = async (module) => { aiSeen.length = 0; const res = await owner('POST', `${O}/ai/chat`, { module, message: 'Fais le point' }); return { res, sys: (aiSeen[aiSeen.length - 1] || {}).sys || '' }; };
  let c = await chat('support');
  check('IA service client : lit la base de connaissances et les délais', c.res.status === 200 && /BASE DE CONNAISSANCES/.test(c.sys) && /Mobile Money et espèces/.test(c.sys) && /DÉLAIS \(SLA\)/.test(c.sys), c.res.json);
  c = await chat('hr');
  check('IA RH : soldes de congés, échéances, recrutement', /CONGÉS/.test(c.sys) && /ÉCHÉANCES RH/.test(c.sys) && /RECRUTEMENT/.test(c.sys));
  c = await chat('legal');
  check('IA juridique : calendrier de conformité (à vérifier) et registres', /CONFORMITÉ/.test(c.sys) && /REGISTRES/.test(c.sys));
  c = await chat('marketing');
  check('IA marketing : consentements et codes promo', /ENVOIS GROUPÉS/.test(c.sys) && /CODES PROMO/.test(c.sys));
  c = await chat('projects');
  check('IA projets : temps et coûts', /TEMPS ET COÛT/.test(c.sys));
  c = await chat('structure');
  check('IA organisation : postes vacants', /POSTES VACANTS/.test(c.sys));

  // ---------- Agents : digest planifié et actions ----------
  const AG = `${O}/agents`;
  r = await mgr('PUT', `${AG}/schedule`, { enabled: true });
  check('digest planifié : réglage réservé aux administrateurs', r.status === 403);
  r = await owner('PUT', `${AG}/schedule`, { enabled: true, weekday: 7, hour: 0, agentKey: 'direction' });
  check('digest planifié enregistré', r.status === 200);
  r = await owner('PUT', `${AG}/schedule`, { agentKey: 'inconnu' });
  check('agent inconnu refusé', r.status === 400);
  const used0 = (await dbx.prepare('SELECT COUNT(*) c FROM ai_usage WHERE org_id = ?').get(org)).c;
  r = await owner('POST', `${AG}/schedule/run`, {});
  check('lancement du digest : réponse de l\'agent', r.json.status === 'ok', r.json);
  const used1 = (await dbx.prepare('SELECT COUNT(*) c FROM ai_usage WHERE org_id = ?').get(org)).c;
  check('le digest compte pour un message IA', Number(used1) === Number(used0) + 1);
  const lg = await dbx.prepare("SELECT mode FROM agents_log WHERE org_id = ? AND mode = 'scheduled'").get(org);
  check('le digest est conservé dans l\'historique des agents', !!lg);
  r = await owner('GET', `${O}/notices`);
  check('notification « digest prêt »', r.json.items.some((n) => /Digest de/.test(n.text)));
  const tasks0 = (await owner('GET', `${O}/projects/tasks`)).json.tasks.length;
  r = await mgr('POST', `${AG}/actions`, { type: 'task', title: 'Relancer les impayés' });
  check('création depuis une suggestion : confirmation humaine obligatoire', r.status === 400 && (await owner('GET', `${O}/projects/tasks`)).json.tasks.length === tasks0);
  r = await mgr('POST', `${AG}/actions`, { type: 'task', title: 'Relancer les impayés', why: 'Trésorerie', dueInDays: 2, confirm: true });
  check('tâche créée après confirmation', r.status === 201 && r.json.taskId, r.json);
  r = await mem('POST', `${AG}/actions`, { type: 'followup', title: 'Facture', customerId: cA, confirm: true });
  check('relance client : réservée aux responsables', r.status === 403);
  r = await mgr('POST', `${AG}/actions`, { type: 'followup', title: 'facture en retard', customerId: cA, confirm: true });
  check('relance créée (tâche avec coordonnées et reste à payer)', r.status === 201);
  r = await owner('GET', `${O}/projects/tasks`);
  const fu = r.json.tasks.find((t) => /^Relancer/.test(t.title) && /facture en retard/.test(t.title));
  check('la tâche de relance mentionne le reste à payer', !!fu);
  r = await mgr('GET', `${AG}/actions`);
  check('journal des actions confirmées', r.json.items.length === 2);

  // ---------- API publique + webhooks ----------
  r = await owner('POST', `${O}/integrations/keys`, { name: 'Test', scope: 'read' });
  const key = r.json.key;
  const api = async (p) => { const res = await fetch(base + '/api/v1' + p, { headers: { authorization: `Bearer ${key}` } }); return { status: res.status, json: await res.json() }; };
  r = await api('/stock');
  check('API publique : stock', r.status === 200 && r.json.data.some((s) => s.sku === 'SAV-1' && s.quantity === 40), r.json);
  r = await api('/products');
  check('API publique : produits (catalogue)', r.status === 200 && Array.isArray(r.json.data));
  r = await api('/payments');
  check('API publique : paiements confirmés', r.status === 200 && r.json.data.some((p) => p.amount === 19250 && /^F-/.test(p.invoice)), r.json);
  r = await owner('GET', `${O}/integrations`);
  check('nouveaux événements de webhook proposés', ['ticket.created', 'invoice.paid', 'decision.decided', 'leave.requested', 'customer.created'].every((e) => e in r.json.events), Object.keys(r.json.events));
  r = await owner('POST', `${O}/integrations/webhooks`, { url: `http://127.0.0.1:${extra.hookPort}/hook`, events: ['ticket.created', 'customer.created'] });
  check('webhook créé', r.status === 201, r.json);
  const hook = r.json.id;
  await mgr('POST', `${O}/support`, { customerName: 'Hook', subject: 'Test webhook', message: 'x' });
  await new Promise((s) => setTimeout(s, 700));
  check('événement ticket.created livré avec signature', hits.some((h) => h.body.event === 'ticket.created' && /^sha256=/.test(h.sig) && h.body.data.subject === 'Test webhook'), hits.length);
  r = await owner('GET', `${O}/integrations/deliveries`);
  check('historique de livraison : succès', r.json.items.some((d) => d.event === 'ticket.created' && d.ok === true && d.status === '200'), r.json);
  hookStatus = 500;
  await mgr('POST', `${O}/crm/customers`, { name: 'Webhook Client', phone: '655999888' });
  await new Promise((s) => setTimeout(s, 700));
  r = await owner('GET', `${O}/integrations/deliveries`);
  const bad = r.json.items.find((d) => d.event === 'customer.created');
  check('historique de livraison : échec enregistré', bad && bad.ok === false && bad.status === '500', r.json.items.map((d) => [d.event, d.status]));
  hookStatus = 200;
  r = await owner('POST', `${O}/integrations/deliveries/${bad.id}/retry`, {});
  check('nouvel essai manuel : succès', r.json.ok === true, r.json);
  r = await owner('GET', `${O}/integrations/deliveries`);
  check('le nouvel essai est tracé (2e tentative)', r.json.items.some((d) => d.event === 'customer.created' && d.ok && d.attempts === 2));
  r = await mgr('GET', `${O}/integrations/deliveries`);
  check('historique réservé aux administrateurs', r.status === 403);
  void hook;

  // ---------- Reçu d'abonnement ----------
  const ref = 'PAY-TEST-' + Date.now();
  await dbx.prepare("INSERT INTO payments (reference, user_id, plan, operator, phone, amount_xaf, mode, status, created_at) VALUES (?, ?, 'pro', 'mtn', '670000000', 50000, 'manual', 'pending', ?)").run(ref, ownerId, new Date().toISOString());
  r = await owner('GET', `/api/payments/${ref}/receipt`);
  check('reçu : introuvable tant que le paiement n\'est pas confirmé', r.status === 404);
  const adm = client(base);
  r = await adm('POST', '/api/admin/login', { username: 'admin-test', password: 'mot-de-passe-admin-test' });
  const pid = (await dbx.prepare('SELECT id FROM payments WHERE reference = ?').get(ref)).id;
  r = await adm('POST', `/api/admin/payments/${pid}/validate`, {});
  check('paiement validé par l\'administrateur', r.status === 200, r.json);
  r = await owner('GET', `/api/payments/${ref}/receipt`);
  check('reçu : numéro, offre, montant, document de travail', r.status === 200 && /^R-\d{4}-\d{5}$/.test(r.json.receipt.number) && r.json.receipt.plan === 'Pro' && r.json.receipt.amountXAF === 50000 && /document de travail/i.test(r.json.receipt.note), r.json);
  r = await other('GET', `/api/payments/${ref}/receipt`);
  check('reçu : visible seulement par son titulaire', r.status === 404);
  await new Promise((s) => setTimeout(s, 800));
  check('e-mail de confirmation avec le reçu en pièce jointe', mailbox.some((m) => /recu-R-\d{4}-\d{5}\.html/.test(m)), mailbox.length);
  void ws; void memId;
}, {
  setup: async () => {
    const smtp = await fakeSmtp(mailbox); const ai = await fakeAi(aiSeen);
    const hookPort = await new Promise((resolve) => { const s = http.createServer((req, res) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => { try { hits.push({ body: JSON.parse(b), sig: req.headers['x-mia-signature'] }); } catch { /* ignoré */ } res.statusCode = hookStatus; res.end('ok'); }); }); s.listen(0, '127.0.0.1', () => resolve(s)); });
    return { env: { SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.port), SMTP_FROM: 'noreply@manager-ia.test', ANTHROPIC_API_KEY: 'cle-de-test', ANTHROPIC_BASE_URL: `http://127.0.0.1:${ai.port}`, WS_AI_FREE: '200', AI_PER_MINUTE: '500', WEBHOOK_ALLOW_PRIVATE: '1' }, smtp, ai, hook: hookPort, hookPort: hookPort.address().port };
  },
  teardown: async (x) => { x.smtp.srv.close(); x.ai.srv.close(); x.hook.close(); },
});
