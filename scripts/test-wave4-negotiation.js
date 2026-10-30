'use strict';
// Vague 4 · Négociation des prix : plancher, paliers, prix par client, dernier prix payé, blocage sous le plancher (admin + motif), règles de l'assistant,
// validation par le serveur de tout prix annoncé, journal, seuil de validation par un responsable (circuit de décisions). Faux serveur d'IA : aucun appel externe.
// Lancez-le avec : node scripts/test-wave4-negotiation.js
const http = require('http');
const { run } = require('./lib/wave1');
const { fakeSmtp } = require('./lib/fakes');

const ai = { next: null, seen: [] };
function startAi() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let b = '';
      req.on('data', (d) => { b += d; });
      req.on('end', () => {
        const j = JSON.parse(b || '{}');
        ai.seen.push({ system: Array.isArray(j.system) ? j.system.map((x) => x.text).join('\n\n') : (j.system || '') });
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(ai.next || { reply: 'Bonjour.', action: null }) }] }));
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}
const dataOf = (s) => { const t = flat(s); return t.slice(t.lastIndexOf('<donnees>')); };
const flat = (s) => String(s).replace(/[  ]/g, ' ');

run('Vague 4 · Négociation des prix', async ({ check, owner, mgr, mem, other, org, O, dbx, base }) => {
  const S = `${O}/sales`; const C = `${O}/crm`;
  const anon = async (method, url, body) => { const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); let json = null; try { json = await r.json(); } catch { /* vide */ } return { status: r.status, json }; };
  const token = (await owner('GET', O)).json.intakeToken;

  // ---------- Catalogue : plancher, remise maximale, paliers ----------
  let r = await owner('POST', `${S}/catalog`, { name: 'Robe wax', price: 10000, floorPrice: 6000, tiers: [{ min: 10, price: 8000 }, { min: 50, price: 7000 }] });
  const robe = r.json.id;
  check('catalogue : article avec plancher et paliers', r.status === 201, r.json);
  r = await owner('POST', `${S}/catalog`, { name: 'Sac', price: 5000 });
  const sac = r.json.id;
  r = await owner('POST', `${S}/catalog`, { name: 'Casque', price: 20000, maxDiscount: 20 });
  const casque = r.json.id;
  r = await owner('POST', `${S}/catalog`, { name: 'Erreur', price: 1000, floorPrice: 2000 });
  check('plancher supérieur au prix de liste refusé', r.status === 400, r.json);
  r = await owner('POST', `${S}/catalog`, { name: 'Erreur2', price: 1000, tiers: [{ min: 5, price: 1200 }] });
  check('palier plus cher que la liste refusé', r.status === 400, r.json);
  r = await owner('POST', `${S}/catalog`, { name: 'Erreur3', price: 10000, floorPrice: 6000, tiers: [{ min: 5, price: 5000 }] });
  check('palier sous le plancher refusé', r.status === 400, r.json);
  r = await owner('GET', `${S}/catalog`);
  const itR = r.json.items.find((i) => i.id === robe); const itC = r.json.items.find((i) => i.id === casque); const itS = r.json.items.find((i) => i.id === sac);
  check('catalogue : négociable avec plancher / remise maximale (plancher = le plus strict) ; sans rien = non négociable', itR.negotiable && itR.floor === 6000 && itC.negotiable && itC.floor === 16000 && !itS.negotiable && itR.tiers.length === 2, [itR, itC, itS]);

  // ---------- Prix par client, suggestion (priceFor) ----------
  r = await mgr('POST', `${C}/customers`, { name: 'Paul Client', phone: '677 11 22 33', email: 'paul@exemple.com' });
  const paul = r.json.id;
  r = await mgr('GET', `${C}/price-suggest?itemId=${robe}&customerId=${paul}&quantity=1`);
  check('suggestion : liste, plancher, meilleur prix, raison', r.status === 200 && r.json.list === 10000 && r.json.floor === 6000 && r.json.best === 6000 && r.json.reference === 10000 && r.json.reasonCode === 'liste', r.json);
  r = await mgr('GET', `${C}/price-suggest?itemId=${robe}&customerId=${paul}&quantity=12`);
  check('suggestion : palier de quantité', r.json.reference === 8000 && r.json.reasonCode === 'palier' && r.json.tierPrice === 8000, r.json);
  r = await mem('GET', `${C}/price-suggest?itemId=${robe}`);
  check('suggestion réservée aux responsables', r.status === 403);
  r = await mgr('PUT', `${C}/customers/${paul}/prices/${robe}`, { price: 5000 });
  check('prix client sous le plancher : un responsable est refusé', r.status === 403, r.json);
  r = await owner('PUT', `${C}/customers/${paul}/prices/${robe}`, { price: 5000 });
  check('prix client sous le plancher : l\'administrateur doit donner un motif', r.status === 422, r.json);
  r = await mgr('PUT', `${C}/customers/${paul}/prices/${robe}`, { price: 9000, note: 'fidèle', validUntil: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10) });
  check('prix négocié pour un client enregistré', r.status === 200, r.json);
  r = await mgr('GET', `${C}/price-suggest?itemId=${robe}&customerId=${paul}&quantity=1`);
  check('suggestion : prix client prioritaire sur la liste', r.json.reference === 9000 && r.json.reasonCode === 'prix_client' && r.json.customerPrice.price === 9000, r.json);
  r = await mgr('PUT', `${C}/customers/${paul}/discount`, { discount: 15 });
  r = await mgr('GET', `${C}/price-suggest?itemId=${casque}&customerId=${paul}&quantity=1`);
  check('remise client par défaut appliquée (20 000 -> 17 000, jamais sous le plancher 16 000)', r.json.reference === 17000 && r.json.reasonCode === 'remise_client' && r.json.best === 16000, r.json);
  r = await mgr('PUT', `${C}/customers/${paul}/discount`, { discount: 95 });
  check('remise client invalide refusée', r.status === 400);
  await dbx.prepare("INSERT INTO customer_prices (org_id, customer_id, item_id, price, valid_until, note, created_at) VALUES (?, ?, ?, 100, '2020-01-01', 'expiré', ?) ON CONFLICT (customer_id, item_id) DO NOTHING").run(org, paul, sac, new Date().toISOString());
  r = await mgr('GET', `${C}/price-suggest?itemId=${sac}&customerId=${paul}`);
  check('un prix client expiré est ignoré (reste la remise de fidélité de 15 %)', r.json.reference === 4250 && !r.json.customerPrice && r.json.reasonCode === 'remise_client', r.json);

  // dernier prix payé (d'après les factures)
  r = await mgr('POST', `${C}/documents`, { kind: 'invoice', customerId: paul, lines: [{ label: 'Robe wax', quantity: 1, price: 9500 }] });
  await mgr('PUT', `${C}/documents/${r.json.id}`, { status: 'sent' });
  r = await mgr('GET', `${C}/price-suggest?itemId=${robe}&customerId=${paul}`);
  check('dernier prix payé par ce client (facture)', r.json.lastPaid && r.json.lastPaid.price === 9500 && /^F-/.test(r.json.lastPaid.number), r.json.lastPaid);

  // ---------- Devis / facture : blocage sous le plancher ----------
  r = await mgr('POST', `${C}/documents`, { kind: 'quote', customerId: paul, lines: [{ label: 'Robe wax', quantity: 1, price: 5000 }] });
  check('devis sous le plancher : un responsable est bloqué', r.status === 403 && /plancher/.test(r.json.error), r.json);
  r = await owner('POST', `${C}/documents`, { kind: 'quote', customerId: paul, lines: [{ label: 'Robe wax', quantity: 1, price: 5000 }] });
  check('devis sous le plancher : l\'administrateur doit donner un motif', r.status === 422 && /motif/.test(r.json.error), r.json);
  r = await owner('POST', `${C}/documents`, { kind: 'quote', customerId: paul, lines: [{ label: 'Robe wax', quantity: 1, price: 5000 }], priceOverride: { reason: 'Liquidation fin de série' } });
  check('devis sous le plancher : accepté avec motif (administrateur)', r.status === 201, r.json);
  r = await mgr('POST', `${C}/documents`, { kind: 'quote', customerId: paul, lines: [{ label: 'Robe wax', quantity: 1, price: 6500 }, { label: 'Livraison', quantity: 1, price: 1000 }] });
  check('devis au-dessus du plancher et ligne libre : accepté', r.status === 201, r.json);
  r = await owner('GET', `${S}/negotiation`);
  check('exception tracée dans le journal (auteur humain, motif)', r.json.log.some((l) => l.kind === 'override' && l.actor === 'human' && /Liquidation/.test(l.note) && l.user === 'Awa') && r.json.stats.overrides >= 1, r.json.log.slice(0, 3));
  const aud = await dbx.prepare("SELECT COUNT(*) c FROM audit_log WHERE org_id = ? AND entity = 'price_override'").get(org);
  check('exception tracée dans le journal d\'audit', Number(aud.c) === 1, aud);

  // ---------- Règles de l'assistant ----------
  r = await mgr('PUT', `${S}/negotiation/settings`, { enabled: true });
  check('règles de négociation : réservées aux administrateurs', r.status === 403);
  r = await owner('PUT', `${S}/negotiation/settings`, { enabled: true, maxCounters: 9 });
  check('nombre de contre-offres invalide refusé', r.status === 400);
  r = await owner('PUT', `${S}/negotiation/settings`, { enabled: true, maxCounters: 3, approvalPct: 10, handoffMessage: 'Un conseiller vous écrit tout de suite (message de test).' });
  check('règles : activée, 3 contre-offres, validation au-delà de 10 %, message de relais', r.status === 200 && r.json.settings.enabled && r.json.settings.maxCounters === 3, r.json);
  await owner('PUT', `${S}/settings`, { chatEnabled: true });

  // aide pour parler à l'assistant (une conversation = une session)
  const talk = async (session, message, scripted) => { ai.next = scripted; const rr = await anon('POST', `/api/ws/public/chat/${token}/message`, { message, sessionId: session }); return rr; };
  const neg = (offer, price, extra = {}) => ({ reply: 'Je regarde ce que je peux faire.', action: { type: 'negotiate', item: 'Robe wax', quantity: 1, customer_offer: offer, price, ...extra } });

  let rr = await talk(undefined, 'Bonjour, la Robe wax coûte combien ?', { reply: 'Elle est à 10 000 FCFA.', action: null });
  const session = rr.json.sessionId; const chat1 = rr.json.chatId;
  const sys = dataOf(ai.seen[ai.seen.length - 1].system);
  check('IA : contexte de négociation, prochain palier seulement (8 670), jamais le plancher', /NÉGOCIATION : autorisée/.test(sys) && /prochain palier autorisé[^\n]*8 670/.test(sys) && !/6 000|6000/.test(sys) && /paliers publics : 8 000/.test(sys), sys.split('\n').filter((l) => /Robe wax|NÉGO/.test(l)));
  rr = await talk(session, 'Je peux avoir 7000 ?', neg(7000, 8670));
  check('contre-offre 1 : palier 8 670, prix validé ajouté au message', /Prix validé/.test(rr.json.reply) && /8 670/.test(flat(rr.json.reply)) && rr.json.negotiation.decision === 'counter', rr.json);
  rr = await talk(session, 'Encore un effort, 7000', neg(7000, 7335));
  check('contre-offre 2 : palier 7 335', rr.json.negotiation.price === 7335 && rr.json.negotiation.decision === 'counter', rr.json);
  rr = await talk(session, 'Alors 6500 ?', neg(6500, 6000));
  check('le client propose 6 500 (>= plancher) : accepté à 6 500, le message du serveur remplace celui de l\'IA', rr.json.negotiation.decision === 'accept' && rr.json.negotiation.price === 6500 && /6 500/.test(flat(rr.json.reply)) && !/regarde/.test(rr.json.reply), rr.json);
  let lg = await owner('GET', `${S}/chats/${chat1}`);
  check('journal de la conversation : offres du client, contre-offres et prix accepté de l\'assistant', ['offer', 'counter', 'accept'].every((k) => lg.json.negotiation.some((e) => e.kind === k)) && lg.json.negotiation.filter((e) => e.actor === 'customer').length === 3 && lg.json.negotiation.some((e) => e.actor === 'assistant' && e.kind === 'accept' && e.price === 6500), lg.json.negotiation.map((e) => [e.actor, e.kind, e.price]));
  // Commande au prix négocié
  rr = await talk(session, 'Ok je commande, Paul Test 677 55 44 33', { reply: 'Parfait.', action: { type: 'order', items: [{ name: 'Robe wax', quantity: 1 }], note: 'Douala', name: 'Marie Test', phone: '655 44 33 22' } });
  check('commande créée au prix négocié (6 500), indicateur négocié, 35 % de remise, validation requise', rr.json.order && rr.json.order.total === 6500 && rr.json.order.negotiated === true && rr.json.order.discountPct === 35 && rr.json.order.needsApproval === true && /validée par un responsable/.test(rr.json.reply), rr.json);
  const ord = await dbx.prepare("SELECT * FROM documents WHERE id = ?").get(rr.json.order.id);
  check('commande en base : négociée, remise, à valider', Number(ord.negotiated) === 1 && Number(ord.discount_pct) === 35 && ord.approval === 'needed' && ord.status === 'pending' && ord.decision_id, ord);
  const dec = await dbx.prepare('SELECT * FROM decisions WHERE id = ?').get(ord.decision_id);
  check('lien avec le circuit de décisions existant', dec && dec.link_kind === 'order' && Number(dec.link_id) === Number(ord.id) && dec.status === 'pending', dec);
  const note = await dbx.prepare("SELECT COUNT(*) c FROM notices WHERE org_id = ? AND kind = 'decision' AND text LIKE ?").get(org, `%${ord.number}%`);
  check('notification interne aux responsables (w3.push, e-mail inclus)', Number(note.c) >= 1, note);
  r = await mgr('PUT', `${S}/orders/${ord.id}/status`, { status: 'confirmed' });
  check('confirmation bloquée tant que la remise n\'est pas validée', r.status === 409 && /validée/.test(r.json.error), r.json);
  r = await owner('GET', `${S}/orders`);
  const oview = r.json.orders.find((o) => o.id === ord.id);
  check('la commande affiche le journal de négociation', oview.negotiated && oview.approval === 'needed' && oview.negotiation.length >= 4, oview && oview.negotiation.length);
  r = await mgr('PUT', `${O}/decisions/${ord.decision_id}`, { status: 'approved', note: 'ok' });
  check('un responsable valide la remise dans les décisions', r.status === 200, r.json);
  r = await mgr('PUT', `${S}/orders/${ord.id}/status`, { status: 'confirmed' });
  check('après validation : la commande peut être confirmée', r.status === 200, r.json);
  r = await mgr('POST', `${S}/orders/${ord.id}/invoice`, {});
  check('facture issue de la commande : mêmes prix négociés (sans blocage)', r.status === 201, r.json);
  lg = await owner('GET', `${S}/chats/${chat1}`);
  check('journal : décision humaine tracée', lg.json.negotiation.some((e) => e.actor === 'human' && e.kind === 'approved') && lg.json.negotiation.some((e) => e.actor === 'human' && e.kind === 'confirmed'), lg.json.negotiation.map((e) => [e.actor, e.kind]));

  // ---------- Garde-fous : le serveur refuse tout prix sous le plancher ----------
  rr = await talk(undefined, 'Robe wax à 5000 ?', neg(5000, 5000));
  check('prix annoncé sous le plancher : refusé, repli = message de relais, conversation passée à un conseiller', /message de test/.test(rr.json.reply) && !/5 000/.test(flat(rr.json.reply)) && rr.json.handoff === true, rr.json);
  const ch2 = await dbx.prepare('SELECT status FROM chats WHERE id = ?').get(rr.json.chatId);
  const refused = await dbx.prepare("SELECT COUNT(*) c FROM neg_log WHERE org_id = ? AND kind = 'refused' AND price = 5000").get(org);
  check('relais enregistré et refus tracé', ch2.status === 'handoff' && Number(refused.c) === 1);
  const nOrd = Number((await dbx.prepare("SELECT COUNT(*) c FROM documents WHERE org_id = ? AND kind = 'order'").get(org)).c);
  rr = await talk(undefined, 'Je prends la robe', { reply: 'Voilà.', action: { type: 'order', items: [{ name: 'Robe wax', quantity: 1, price: 5000 }], name: 'Zed Test', phone: '655 00 11 22' } });
  check('commande avec un prix sous le plancher : refusée, aucune commande créée, passage de relais', !rr.json.order && /message de test/.test(rr.json.reply) && Number((await dbx.prepare("SELECT COUNT(*) c FROM documents WHERE org_id = ? AND kind = 'order'").get(org)).c) === nOrd, rr.json);
  rr = await talk(undefined, 'Et la robe ?', { reply: 'La Robe wax est à 4 000 FCFA seulement !', action: null });
  check('prix cité librement dans le message sous le plancher : message remplacé', !/4 000/.test(flat(rr.json.reply)) && /message de test/.test(rr.json.reply), rr.json.reply);
  rr = await talk(undefined, 'Un sac à 4000 ?', { reply: 'Je regarde.', action: { type: 'negotiate', item: 'Sac', quantity: 1, customer_offer: 4000, price: 4500 } });
  check('article non négociable : refus ferme, relais', rr.json.handoff === true && /message de test/.test(rr.json.reply) && !/4 500/.test(flat(rr.json.reply)), rr.json);
  // IA qui annonce un prix PLUS HAUT que celui du client : jamais plus que la référence
  rr = await talk(undefined, 'Commande 1 robe', { reply: 'OK.', action: { type: 'order', items: [{ name: 'Robe wax', quantity: 1, price: 99999 }], name: 'Ana Test', phone: '655 77 88 99' } });
  check('prix supérieur annoncé par l\'IA ignoré : prix de référence (10 000), non négocié, sans validation', rr.json.order && rr.json.order.total === 10000 && !rr.json.order.negotiated && !rr.json.order.needsApproval, rr.json);
  // Remise non confirmée par la négociation : l'IA ne peut pas baisser seule le prix (au-dessus du plancher mais sans accord du serveur)
  rr = await talk(undefined, 'Commande 1 robe à 8000', { reply: 'OK.', action: { type: 'order', items: [{ name: 'Robe wax', quantity: 1, price: 8000 }], name: 'Ben Test', phone: '655 12 12 12' } });
  check('prix de l\'IA entre plancher et référence sans accord enregistré : le serveur applique la référence', rr.json.order && rr.json.order.total === 10000 && /prix de référence appliqué/.test(rr.json.reply), rr.json);
  // Prix client appliqué à la commande de l'assistant
  const rr0 = await talk(undefined, 'Je veux un sac, Paul au 677 11 22 33', { reply: 'OK.', action: { type: 'order', items: [{ name: 'Casque', quantity: 1 }], name: 'Paul Client', phone: '677 11 22 33' } });
  check('commande d\'un client connu : remise de fidélité (17 000), non négociée donc sans validation', rr0.json.order && rr0.json.order.total === 17000 && !rr0.json.order.negotiated && !rr0.json.order.needsApproval, rr0.json);

  // ---------- Plafond de contre-offres et seuil de validation ----------
  await owner('PUT', `${S}/negotiation/settings`, { maxCounters: 1, approvalPct: 50 });
  rr = await talk(undefined, 'Robe wax 5500 ?', neg(5500, 6000));
  const s3 = rr.json.sessionId;
  check('1 seule contre-offre autorisée : elle va directement au dernier palier (6 000)', rr.json.negotiation.decision === 'counter' && rr.json.negotiation.price === 6000, rr.json.negotiation);
  rr = await talk(s3, 'Non 5500', neg(5500, 6000));
  check('plus de contre-offre : « dernier prix » et relais, jamais sous le plancher', rr.json.negotiation.decision === 'final' && rr.json.negotiation.price === 6000 && rr.json.handoff === true && !/5 500/.test(flat(rr.json.reply)), rr.json);
  await owner('PUT', `${S}/negotiation/settings`, { maxCounters: 3, approvalPct: 50 });
  rr = await talk(undefined, 'Robe wax 6000 ?', neg(6000, 8670));
  const s4 = rr.json.sessionId;
  await talk(s4, '6000', neg(6000, 7335));
  rr = await talk(s4, '6000', neg(6000, 6000));
  check('le client propose exactement le plancher : accepté', rr.json.negotiation.decision === 'accept' && rr.json.negotiation.price === 6000, rr.json.negotiation);
  rr = await talk(s4, 'Je commande', { reply: 'OK', action: { type: 'order', items: [{ name: 'Robe wax', quantity: 1 }], name: 'Eve Test', phone: '655 33 22 11' } });
  check('remise de 40 % sous un seuil réglé à 50 % : pas de validation requise, mais négociée', rr.json.order && rr.json.order.total === 6000 && rr.json.order.negotiated && !rr.json.order.needsApproval && rr.json.order.discountPct === 40, rr.json);
  // Négociation désactivée
  await owner('PUT', `${S}/negotiation/settings`, { enabled: false });
  rr = await talk(undefined, 'Robe wax moins cher ?', neg(7000, 8670));
  check('négociation désactivée : le serveur refuse toute remise (relais)', rr.json.handoff === true && !/8 670/.test(flat(rr.json.reply)) && /NÉGOCIATION : désactivée/.test(ai.seen[ai.seen.length - 1].system), rr.json.reply);

  // ---------- Contextes IA interne et droits ----------
  r = await mem('GET', `${S}/negotiation`);
  check('réglages et journal fermés aux membres', r.status === 403);
  r = await other('GET', `${S}/negotiation`);
  check('autre organisation : 404', r.status === 404);
  r = await mgr('POST', `${O}/ai/chat`, { module: 'sales', message: 'Où en est la négociation ?' });
  const sysI = dataOf(ai.seen[ai.seen.length - 1].system);
  check('contexte IA interne : règles de négociation sans aucun plancher', r.status === 200 && /NÉGOCIATION DE L'ASSISTANT : désactivée/.test(sysI) && /ne te sont pas communiqués/.test(sysI) && !/floor|plancher (de|à|:) ?\d/i.test(sysI), sysI.slice(-900));
}, {
  setup: async () => {
    const a = await startAi(); const mails = []; const smtp = await fakeSmtp(mails);
    ai.srv = a.srv; ai.smtp = smtp;
    return { env: { ANTHROPIC_API_KEY: 'cle-de-test', ANTHROPIC_BASE_URL: `http://127.0.0.1:${a.port}`, WS_AI_FREE: '500', AI_PER_MINUTE: '500', SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.port), SMTP_FROM: 'noreply@exemple.test', MAIL_DAY_FREE: '200' } };
  },
  teardown: async () => { ai.srv.close(); ai.smtp.srv.close(); },
});
