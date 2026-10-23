'use strict';
// Jeu de données de DÉMONSTRATION (exemples fictifs) : « Boutique Awa », boutique de pagnes et vêtements, en FCFA.
// Tout passe par l'API HTTP réelle ; un complément SQL optionnel (module « pg ») ajoute des conversations et des commandes à valider,
// ce que l'assistant commercial ferait avec une clé d'IA. Aucun nom réel, aucune vraie marque.
//   Usage : node scripts/demo/seed.js [http://127.0.0.1:3100]     (base VIDE obligatoire ; adresse SQL lue dans DEMO_DIR/pgurl.txt)
const fs = require('fs');
const path = require('path');

const BASE = (process.argv[2] || process.env.DEMO_API || 'http://127.0.0.1:3100').replace(/\/$/, '');
const DEMO_DIR = process.env.DEMO_DIR || '/private/tmp/claude-501/demo';
const OWNER = { name: 'Awa Kamga', contact: 'demo@exemple.com', pass: 'secret123' };
const ORG_NAME = 'Boutique Awa';

// ---------- Outils ----------
const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => d.toISOString().slice(0, 10);
const plus = (n) => iso(new Date(Date.now() + n * 86400000));
const ymOffset = (k) => { const d = new Date(); const t = d.getUTCFullYear() * 12 + d.getUTCMonth() + k; return `${Math.floor(t / 12)}-${pad((t % 12) + 1)}`; };
const TODAY = plus(0);
const THIS_MONTH = ymOffset(0);

function client() {
  const jar = {};
  return async (method, url, body) => {
    const headers = body !== undefined ? { 'content-type': 'application/json' } : {};
    const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie) headers.cookie = cookie;
    const res = await fetch(BASE + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const sc of res.headers.getSetCookie()) { const [pair] = sc.split(';'); const i = pair.indexOf('='); jar[pair.slice(0, i).trim()] = pair.slice(i + 1).trim(); }
    const t = await res.text();
    let json = null;
    try { json = JSON.parse(t); } catch { /* pas du JSON */ }
    return { status: res.status, json, text: t };
  };
}
const owner = client();
let W = ''; // /api/ws/orgs/<id>
const stats = {};
const count = (k, n = 1) => { stats[k] = (stats[k] || 0) + n; };

/** Appel qui doit réussir (2xx) ; renvoie le JSON. */
async function call(method, url, body, label) {
  const r = await owner(method, url, body);
  if (r.status < 200 || r.status >= 300) throw new Error(`${method} ${url} -> ${r.status} ${r.text.slice(0, 300)}${label ? ' (' + label + ')' : ''}`);
  return r.json || {};
}
const post = async (p, b, k) => { const j = await call('POST', W + p, b); if (k) count(k); return j; };
const put = async (p, b) => call('PUT', W + p, b);
const get = async (p) => call('GET', W + p);
/** Appel toléré : on note l'échec sans arrêter la graine. */
async function soft(fn, what) { try { return await fn(); } catch (e) { console.log('  (ignoré) ' + what + ' : ' + e.message.slice(0, 200)); return null; } }

async function main() {
  console.log('Graine de démonstration vers ' + BASE);
  // ---------- Compte ----------
  const h = await fetch(BASE + '/api/health').catch(() => null);
  if (!h || !h.ok) { console.log("Le serveur ne répond pas. Démarrez-le d'abord (voir scripts/demo/README.md)."); process.exit(1); }
  let r = await owner('POST', '/api/login', { contact: OWNER.contact, pass: OWNER.pass });
  if (r.status !== 200) {
    const reg = await owner('POST', '/api/register', OWNER);
    if (reg.status >= 400) throw new Error('Inscription : ' + reg.status + ' ' + reg.text.slice(0, 200));
    r = await owner('POST', '/api/login', { contact: OWNER.contact, pass: OWNER.pass });
  }
  if (r.status !== 200) { console.log('Connexion impossible avec ' + OWNER.contact + ' (' + r.status + '). Il faut une base vide.'); process.exit(1); }
  const orgs = (await call('GET', '/api/ws/orgs')).orgs || [];
  if (orgs.some((o) => o.name === ORG_NAME)) {
    console.log(`L'organisation « ${ORG_NAME} » existe déjà : la graine a déjà été lancée. Il faut une base vide (redémarrez pg.js puis le backend) pour la relancer.`);
    process.exit(0);
  }
  const orgId = (await call('POST', '/api/ws/orgs', { name: ORG_NAME, sector: 'Commerce de pagnes et vêtements', description: 'Boutique de pagnes, tenues sur mesure et prêt-à-porter, avec un petit atelier de couture.', currency: 'FCFA' })).id;
  W = `/api/ws/orgs/${orgId}`;
  console.log('Organisation créée : ' + orgId);

  // ---------- Équipe (2 comptes qui rejoignent l\'organisation) ----------
  for (const [, name, contact, role, title] of [['brice', 'Brice Nkomo', 'brice.nkomo@exemple.com', 'manager', 'Gérant de la boutique'], ['fatou', 'Fatou Diallo', 'fatou.diallo@exemple.com', 'member', 'Vendeuse']]) {
    const c = client();
    let x = await c('POST', '/api/login', { contact, pass: 'secret123' });
    if (x.status !== 200) x = await c('POST', '/api/register', { name, contact, pass: 'secret123' });
    const inv = await call('POST', `${W}/invites`, { role, title });
    x = await c('POST', '/api/ws/orgs/join', { code: inv.code });
    if (x.status !== 200) throw new Error('Invitation refusée : ' + x.text.slice(0, 200));
    count('membres');
  }
  const members = (await get('/members')).members;
  const uid = (name) => (members.find((m) => m.name === name) || {}).userId;
  const U = { awa: uid('Awa Kamga'), brice: uid('Brice Nkomo'), fatou: uid('Fatou Diallo') };

  // ---------- Stock ----------
  const sup = {};
  for (const [k, name, contact, notes] of [
    ['textiles', 'Textiles Mbarga', '+237 690 00 11 01 · commandes@textiles-mbarga.exemple', 'Pagnes wax et bazin. Livraison sous 3 jours.'],
    ['mercerie', 'Mercerie Centrale', '+237 690 00 11 02', 'Boutons, fermetures, fils. Remise à partir de 50 pièces.'],
    ['dentelle', 'Dentelles du Wouri', '+237 690 00 11 03', 'Dentelle guipure, importation mensuelle.'],
    ['emballage', 'Emballages Sahel', '+237 690 00 11 04', 'Sacs et étiquettes.'],
  ]) sup[k] = (await post('/stock/suppliers', { name, contact, notes }, 'fournisseurs')).id;

  const items = {};
  const itemDefs = [
    ['wax', 'Pagne wax (coupon 6 yards)', 'coupon', 46, 15, 9800],
    ['bazin', 'Bazin riche (pièce 5 m)', 'pièce', 18, 10, 16500],
    ['doublure', 'Tissu de doublure', 'mètre', 120, 40, 800],
    ['zip', 'Fermetures éclair', 'pièce', 85, 50, 250],
    ['fil', 'Fil à coudre', 'bobine', 140, 60, 450],
    ['boutons', 'Boutons nacrés (lot de 12)', 'lot', 6, 25, 600],
    ['dentelle', 'Dentelle guipure', 'mètre', 9, 30, 3500],
    ['boubou', 'Boubou homme brodé (fini)', 'pièce', 14, 5, 26000],
    ['robe', 'Robe en pagne (finie)', 'pièce', 22, 8, 9500],
    ['kaba', 'Ensemble kaba (fini)', 'pièce', 11, 4, 17500],
    ['sacs', "Sacs d'emballage", 'pièce', 300, 100, 120],
    ['etiq', 'Étiquettes de marque', 'pièce', 450, 200, 25],
  ];
  for (const [k, name, unit, quantity, minQuantity, unitCost] of itemDefs) items[k] = (await post('/stock/items', { name, unit, quantity, minQuantity, unitCost }, 'articles')).id;
  const prices = {
    wax: [['textiles', 9800, 3], ['mercerie', 10400, 5]], bazin: [['textiles', 16500, 3]], doublure: [['textiles', 800, 3], ['mercerie', 760, 4]], zip: [['mercerie', 250, 2]],
    fil: [['mercerie', 450, 2]], boutons: [['mercerie', 600, 2], ['emballage', 680, 6]], dentelle: [['dentelle', 3500, 7], ['textiles', 3800, 4]], sacs: [['emballage', 120, 5]], etiq: [['emballage', 25, 5]],
  };
  for (const [k, list] of Object.entries(prices)) await put(`/stock/items/${items[k]}/prices`, { prices: list.map(([s, unitPrice, leadDays]) => ({ supplierId: sup[s], unitPrice, leadDays })) });
  // Mouvements de stock récents (historique)
  for (const [k, kind, quantity, reason] of [['wax', 'out', 6, 'Vente en boutique'], ['robe', 'out', 4, 'Vente en boutique'], ['boubou', 'out', 2, 'Vente : commande de Paul-Henri'], ['fil', 'out', 12, 'Atelier : semaine 42'], ['zip', 'in', 40, 'Livraison Mercerie Centrale'], ['kaba', 'out', 3, 'Vente en boutique']]) {
    await post(`/stock/items/${items[k]}/move`, { kind, quantity, reason }, 'mouvements');
  }
  // Commandes d'achat : une à valider, une passée, une reçue
  const po1 = (await post('/stock/orders', { itemId: items.boutons, supplierId: sup.mercerie, quantity: 40 }, 'commandes achat')).created;
  const po2 = (await post('/stock/orders', { itemId: items.dentelle, supplierId: sup.dentelle, quantity: 40 }, 'commandes achat')).created;
  const po3 = (await post('/stock/orders', { itemId: items.fil, supplierId: sup.mercerie, quantity: 60 }, 'commandes achat')).created;
  void po1; void po2; void po3;
  const orders = (await get('/stock/orders')).orders;
  const poOf = (itemId) => orders.find((o) => o.itemId === itemId);
  await put(`/stock/orders/${poOf(items.dentelle).id}/status`, { status: 'ordered' });
  await put(`/stock/orders/${poOf(items.fil).id}/status`, { status: 'ordered' });
  await put(`/stock/orders/${poOf(items.fil).id}/status`, { status: 'received' });

  // ---------- Clients, devis et factures ----------
  const cust = {};
  const custDefs = [
    ['mireille', 'Mireille Essomba', '+237 690 10 00 01', 'mireille.essomba@exemple.com', 'Cliente fidèle, robes de cérémonie sur mesure.'],
    ['nadege', 'Salon Nadège Couture', '+237 690 10 00 02', 'contact@salon-nadege.exemple', 'Salon de couture partenaire : achète tissus et dentelles en gros.'],
    ['hotel', 'Hôtel Les Palmiers', '+237 690 10 00 03', 'intendance@hotel-palmiers.exemple', 'Tenues de service brodées pour le personnel.'],
    ['ibrahim', 'Ibrahim Sow', '+237 690 10 00 04', '', 'Aime le bazin, passe en fin de mois.'],
    ['asso', 'Association Femmes Actives de Bonabéri', '+237 690 10 00 05', 'secretariat@femmes-actives.exemple', 'Commande groupée de pagnes pour leur fête annuelle.'],
    ['christelle', 'Christelle Fotso', '+237 690 10 00 06', '', 'Ensembles kaba, paie par mobile money.'],
    ['rose', 'Boutique Chez Maman Rose', '+237 690 10 00 07', '', 'Revendeuse au marché : achat de pagnes par 20.'],
    ['aicha', 'Aïcha Traoré', '+237 690 10 00 08', 'aicha.traore@exemple.com', 'Robes pagne prêt-à-porter.'],
    ['paulhenri', 'Paul-Henri Mvondo', '+237 690 10 00 09', '', 'Mariage prévu dans 3 semaines : boubous brodés.'],
    ['fatoumata', 'Fatoumata Bah', '+237 690 10 00 10', '', 'Prospect venue par WhatsApp.'],
    ['samuel', 'Samuel Kouam', '+237 690 10 00 11', '', 'Prospect : cherche des tenues pour une chorale.'],
    ['lucie', 'Lucie Ndzana', '+237 690 10 00 12', '', 'Prospect Facebook : intéressée par la dentelle.'],
  ];
  for (const [k, name, phone, email, notes] of custDefs) cust[k] = (await post('/crm/customers', { name, phone, email, notes }, 'clients')).id;

  const doc = async (kind, c, lines, { issued, due, note, status, pay } = {}) => {
    const id = (await post('/crm/documents', { kind, customerId: cust[c], lines, issued, due, note }, kind === 'quote' ? 'devis' : 'factures')).id;
    if (status && status !== 'draft') await put(`/crm/documents/${id}`, { status });
    if (pay) await post(`/crm/documents/${id}/payments`, { amount: pay, toBudget: false });
    return id;
  };
  const L = (label, quantity, price) => ({ label, quantity, price });
  const inv = {};
  inv.hotel = await doc('invoice', 'hotel', [L('Tenue de service brodée', 12, 14500), L('Tablier brodé', 6, 4500)], { issued: plus(-40), due: plus(-12), note: 'Uniformes saison sèche', status: 'sent' });
  inv.asso = await doc('invoice', 'asso', [L('Pagne wax, coupon 6 yards', 30, 12500), L('Confection de chemisier', 30, 3500)], { issued: plus(-50), due: plus(-25), status: 'sent', pay: 200000 });
  inv.rose = await doc('invoice', 'rose', [L('Pagne wax, coupon 6 yards', 20, 11000)], { issued: plus(-20), due: plus(-6), status: 'sent', pay: 220000 });
  inv.mireille = await doc('invoice', 'mireille', [L('Robe de cérémonie sur mesure', 1, 65000), L('Foulard assorti', 2, 5000)], { issued: plus(-15), due: plus(-1), status: 'sent', pay: 75000 });
  inv.paulhenri = await doc('invoice', 'paulhenri', [L('Boubou brodé homme', 2, 48000), L('Chéchia brodée', 2, 6000)], { issued: plus(-6), due: plus(10), status: 'sent', pay: 50000 });
  inv.nadege = await doc('invoice', 'nadege', [L('Bazin riche, pièce 5 m', 4, 21500), L('Dentelle guipure (mètre)', 10, 4500)], { issued: plus(-8), due: plus(7), status: 'sent' });
  inv.christelle = await doc('invoice', 'christelle', [L('Ensemble kaba', 1, 32000)], { issued: plus(-5), due: plus(9), status: 'sent', pay: 32000 });
  inv.ibrahim = await doc('invoice', 'ibrahim', [L('Boubou homme prêt-à-porter', 2, 24000)], { issued: plus(-1), due: plus(14) });
  inv.aicha = await doc('invoice', 'aicha', [L('Robe en pagne prête-à-porter', 3, 18000)], { issued: plus(-3), due: plus(14), status: 'sent' });
  // Devis : un accepté (converti en facture), un envoyé, un brouillon, un refusé
  const q1 = await doc('quote', 'asso', [L('Pagne wax commémoratif, coupon 6 yards', 50, 12500)], { issued: plus(-12), note: 'Deuxième commande, fête de fin d\'année', status: 'accepted' });
  await doc('quote', 'hotel', [L('Tenue de service brodée', 20, 14500)], { issued: plus(-4), status: 'sent', note: 'Uniformes pour la nouvelle saison' });
  await doc('quote', 'mireille', [L('Trousseau : 3 robes sur mesure', 3, 58000)], { issued: plus(-1) });
  await doc('quote', 'nadege', [L('Dentelle guipure (mètre)', 60, 4200)], { issued: plus(-30), status: 'refused' });
  const conv = await post(`/crm/documents/${q1}/convert`, { due: plus(20) });
  await put(`/crm/documents/${conv.id}`, { status: 'sent' });
  count('factures');

  // ---------- Support ----------
  const tickets = [
    ['Mireille Essomba', '+237 690 10 00 01', 'whatsapp', 'Retouche de la robe de cérémonie', 'Bonjour, la manche gauche est un peu serrée. Pouvez-vous la reprendre avant samedi ?', 'normal', 'pending', 'Bien sûr, passez demain à l\'atelier, nous la reprenons dans la journée.'],
    ['Aïcha Traoré', 'aicha.traore@exemple.com', 'email', 'Taille incorrecte sur ma commande', 'J\'ai commandé du 40 et la robe reçue est du 38.', 'normal', 'open', null],
    ['Hôtel Les Palmiers', 'intendance@hotel-palmiers.exemple', 'telephone', 'Broderie du logo à corriger', 'Le logo est brodé trop bas sur trois tabliers.', 'normal', 'open', null],
    ['Ibrahim Sow', '+237 690 10 00 04', 'whatsapp', 'Délai de livraison du boubou', 'Quand pourrai-je récupérer mon boubou ?', 'low', 'resolved', 'Il sera prêt jeudi après-midi, nous vous appelons.'],
    ['Christelle Fotso', '+237 690 10 00 06', 'messenger', 'Échange de couleur', 'Puis-je échanger mon kaba bleu contre le vert ?', 'normal', 'resolved', 'Oui, apportez-le avec le ticket, l\'échange est gratuit sous 7 jours.'],
    ['Lucie Ndzana', '+237 690 10 00 12', 'instagram', 'Prix de la dentelle guipure', 'Quel est le prix au mètre pour 10 mètres ?', 'normal', 'open', null],
  ];
  for (const [customerName, customerContact, channel, subject, message, priority, status, reply] of tickets) {
    const id = (await post('/support', { customerName, customerContact, channel, subject, message, priority }, 'tickets')).id;
    if (reply) await post(`/support/${id}/messages`, { content: reply });
    if (status === 'resolved') await put(`/support/${id}`, { status: 'resolved', assigneeId: U.fatou });
    else if (status === 'pending') await put(`/support/${id}`, { assigneeId: U.fatou });
  }

  // ---------- Assistant commercial : catalogue ----------
  for (const [name, description, price, unit] of [
    ['Pagne wax, coupon 6 yards', 'Motifs variés, 100 % coton, ne déteint pas.', 12500, 'coupon'],
    ['Bazin riche, pièce 5 m', 'Bazin brillant, couleurs unies, idéal boubou.', 21500, 'pièce'],
    ['Robe en pagne prête-à-porter', 'Tailles 36 à 46, coupe évasée.', 18000, 'pièce'],
    ['Ensemble kaba', 'Haut et pagne assortis, finitions soignées.', 32000, 'ensemble'],
    ['Boubou homme brodé', 'Broderie main au col, 3 couleurs disponibles.', 48000, 'pièce'],
    ['Dentelle guipure', 'Dentelle légère pour robes de cérémonie.', 4500, 'mètre'],
    ['Foulard assorti', 'Foulard en pagne assorti à votre tenue.', 5000, 'pièce'],
    ['Chéchia brodée', 'Chéchia homme brodée à la main.', 6000, 'pièce'],
  ]) await post('/sales/catalog', { name, description, price, unit }, 'catalogue');
  await put('/sales/settings', { chatEnabled: true, salesInfo: 'Boutique Awa, Douala (Bonabéri). Ouvert du lundi au samedi, 8 h à 18 h. Livraison à Douala sous 24 h, paiement mobile money ou espèces. Tenues sur mesure : délai de 5 à 7 jours.' });

  // Campagnes marketing (créées maintenant : leurs codes servent aux conversations)
  const camp = {};
  camp.fb = (await post('/marketing/campaigns', { name: 'Rentrée en pagnes', channel: 'facebook', objective: 'Faire connaître les nouvelles collections de rentrée', budget: 150000, startDate: plus(-30), endDate: plus(15), status: 'active', code: 'RENTREE-FB', notes: 'Publicités ciblées sur Douala et Yaoundé.' }, 'campagnes')).id;
  camp.wa = (await post('/marketing/campaigns', { name: 'Fidélité WhatsApp', channel: 'whatsapp', objective: 'Relancer les clientes avec une remise de fidélité', budget: 40000, startDate: plus(-20), endDate: plus(25), status: 'active', code: 'WA-FIDELITE', notes: 'Diffusion hebdomadaire aux contacts qui ont accepté.' }, 'campagnes')).id;
  camp.ig = (await post('/marketing/campaigns', { name: 'Vitrine Instagram', channel: 'instagram', objective: 'Montrer les tenues sur mesure', budget: 80000, startDate: plus(-60), endDate: plus(-10), status: 'ended', code: 'IG-PAGNES', notes: 'Photos de clientes consentantes.' }, 'campagnes')).id;
  for (const [c, amount, date, label, toBudget] of [
    [camp.fb, 60000, plus(-28), 'Publicité Facebook, semaine 1', true], [camp.fb, 45000, plus(-14), 'Publicité Facebook, semaine 3', true], [camp.fb, 30000, plus(-3), 'Boost de publication', true],
    [camp.wa, 12000, plus(-18), 'Crédit de diffusion', false], [camp.wa, 8000, plus(-6), 'Visuels', false],
    [camp.ig, 35000, plus(-55), 'Séance photo', false], [camp.ig, 40000, plus(-40), 'Publicité Instagram', false],
  ]) await post(`/marketing/campaigns/${c}/expenses`, { amount, date, label, toBudget }, 'dépenses marketing');
  for (const [date, channel, text, status, campaignId] of [
    [plus(-5), 'facebook', 'Nouvelle collection de pagnes de rentrée : motifs floraux et géométriques en boutique !', 'published', camp.fb],
    [plus(-2), 'instagram', 'Photo de la robe de cérémonie en dentelle guipure (avec accord de la cliente).', 'published', camp.ig],
    [plus(1), 'whatsapp', 'Message de fidélité : 10 % de remise sur votre prochaine tenue sur mesure.', 'ready', camp.wa],
    [plus(3), 'facebook', 'Vidéo de 30 secondes : comment nous choisissons nos tissus.', 'ready', camp.fb],
    [plus(5), 'instagram', 'Carrousel : 5 façons de porter un pagne au bureau.', 'idea', null],
    [plus(7), 'tiktok', 'Coulisses de l\'atelier : une robe de la coupe à la finition.', 'idea', null],
    [plus(9), 'whatsapp', 'Rappel : livraison gratuite à Douala pour toute commande de 50 000 FCFA.', 'idea', camp.wa],
    [plus(12), 'facebook', 'Concours : gagnez un foulard assorti en partageant la publication.', 'idea', camp.fb],
  ]) await post('/marketing/posts', { date, channel, text, status, campaignId }, 'publications');
  for (const [name, kind, value, startDate, endDate, description] of [
    ['Fidélité : 10 % de remise', 'percent', 10, plus(-10), plus(20), 'Pour toute cliente ayant déjà acheté une tenue.'],
    ['Pack mariage : 15 000 FCFA offerts', 'amount', 15000, plus(0), plus(40), 'Dès 3 tenues commandées pour une même cérémonie.'],
    ['Fin de série : 20 % sur les pagnes', 'percent', 20, plus(-40), plus(-8), 'Offre terminée : anciens motifs.'],
  ]) await post('/marketing/offers', { name, kind, value, startDate, endDate, description }, 'offres');

  // ---------- Gestion du personnel ----------
  const emp = {};
  for (const [k, name, job, phone, hiredAt, salary, userId] of [
    ['brice', 'Brice Nkomo', 'Gérant de la boutique', '+237 690 20 00 01', '2022-03-01', 250000, U.brice],
    ['fatou', 'Fatou Diallo', 'Vendeuse', '+237 690 20 00 02', '2023-06-15', 120000, U.fatou],
    ['nadine', 'Nadine Ebogo', 'Couturière', '+237 690 20 00 03', '2021-09-01', 110000],
    ['joseph', 'Joseph Tchamba', 'Couturier brodeur', '+237 690 20 00 04', '2022-11-10', 140000],
    ['chantal', 'Chantal Mbia', 'Caissière', '+237 690 20 00 05', '2024-02-05', 100000],
    ['samuel', 'Samuel Eyenga', 'Livreur', '+237 690 20 00 06', '2024-08-19', 90000],
  ]) emp[k] = (await post('/hr/employees', { name, job, phone, hiredAt, salary, userId }, 'employés')).id;
  const leave = async (e, kind, start, end, note, decision) => {
    const id = (await post('/hr/leaves', { employeeId: emp[e], kind, start, end, note }, 'congés')).id;
    if (decision) await put(`/hr/leaves/${id}/decision`, { decision });
  };
  await leave('chantal', 'annual', plus(-2), plus(3), 'Congé annuel, voyage au village', 'approved');
  await leave('nadine', 'annual', plus(12), plus(19), 'Mariage d\'une cousine', null);
  await leave('samuel', 'sick', plus(-20), plus(-17), 'Paludisme, certificat fourni', 'approved');
  await leave('fatou', 'annual', plus(30), plus(40), 'Vacances de fin d\'année', 'approved');
  await leave('joseph', 'other', plus(-35), plus(-34), 'Démarches administratives', 'refused');
  // Planning de la semaine (lundi à samedi)
  const monday = (() => { const d = new Date(); const wd = (d.getUTCDay() + 6) % 7; return new Date(d.getTime() - wd * 86400000); })();
  const dayOf = (i) => iso(new Date(monday.getTime() + i * 86400000));
  for (let i = 0; i < 6; i++) {
    for (const [e, st, en, note] of [['brice', '08:00', '17:00', 'Ouverture'], ['fatou', '08:30', '17:30', 'Vente'], ['nadine', '08:00', '16:00', 'Atelier'], ['joseph', '08:00', '16:00', 'Atelier'], ['chantal', '09:00', '18:00', 'Caisse'], ['samuel', '10:00', '16:00', 'Tournée']]) {
      if (i === 5 && ['joseph', 'chantal'].includes(e)) continue;
      await post('/hr/shifts', { employeeId: emp[e], day: dayOf(i), start: st, end: en, note }, 'horaires').catch(() => {}); // jour de congé : pas d'horaire
    }
  }

  // ---------- Projets et tâches ----------
  const proj = {};
  const T = (title, priority, due, assignee, status) => ({ title, priority, due, assignee, status });
  const projects = [
    ['Collection de fin d\'année', 'Préparer la collection de fêtes : tissus, confection de 60 pièces, photos et mise en ligne.', plus(40), [
      T('Choisir les motifs de pagnes avec Textiles Mbarga', 'high', plus(-4), U.awa, 'done'), T('Commander la dentelle guipure', 'high', plus(2), U.brice, 'doing'),
      T('Confectionner 40 robes et 20 ensembles kaba', 'high', plus(25), U.awa, 'doing'), T('Séance photo avec les clientes volontaires', 'normal', plus(18), U.fatou, 'todo'), T('Mettre en ligne le catalogue sur WhatsApp et Facebook', 'normal', plus(30), U.fatou, 'todo')]],
    ['Ouverture du point de vente de Bonabéri', 'Ouvrir un second comptoir au marché de Bonabéri avec un stock réduit.', plus(75), [
      T('Visiter les deux emplacements proposés', 'high', plus(-6), U.awa, 'done'), T('Négocier le loyer et signer le bail', 'high', plus(7), U.awa, 'doing'), T('Recruter une vendeuse', 'normal', plus(20), U.brice, 'todo'), T('Acheter les présentoirs', 'low', plus(35), U.brice, 'todo')]],
    ['Inventaire et suivi des stocks', 'Compter le stock chaque mois et fixer les seuils d\'alerte.', plus(14), [
      T('Compter les tissus et les accessoires', 'normal', plus(-1), U.fatou, 'doing'), T('Mettre à jour les seuils de réapprovisionnement', 'normal', plus(5), U.brice, 'todo'), T('Ranger la réserve par famille d\'article', 'low', plus(10), null, 'todo')]],
  ];
  projects.push(['Programme de fidélité', 'Carte de fidélité et remises pour les clientes qui reviennent.', plus(50), [
    T('Définir les paliers de remise', 'normal', plus(4), U.awa, 'doing'), T('Imprimer 200 cartes de fidélité', 'low', plus(15), U.fatou, 'todo'), T('Annoncer le programme sur WhatsApp', 'normal', plus(21), U.fatou, 'todo')]]);
  for (const [name, description, due, tasks] of projects) {
    const id = (await post('/projects', { name, description, due }, 'projets')).id;
    for (const t of tasks) {
      const tid = (await post('/projects/tasks', { projectId: id, title: t.title, priority: t.priority, due: t.due, assigneeId: t.assignee || undefined }, 'tâches')).id;
      if (t.status !== 'todo') await put(`/projects/tasks/${tid}`, { status: t.status });
    }
  }

  for (const [title, priority, due, assigneeId] of [['Relancer les deux factures impayées en retard', 'high', plus(1), U.awa], ['Appeler Textiles Mbarga pour renégocier le contrat', 'high', plus(5), U.awa], ['Valider les commandes de l\'assistant commercial', 'normal', plus(0), U.awa], ['Faire le point sur les congés de fin d\'année', 'low', plus(9), U.awa], ['Réparer la machine à broder avec le technicien', 'high', plus(2), U.brice]])
    await post('/projects/tasks', { title, priority, due, assigneeId }, 'tâches');

  // ---------- Budget (6 mois) ----------
  const inc = [[2400000, 1080000, 850000, 470000], [2550000, 1130000, 900000, 520000], [2700000, 1200000, 960000, 540000], [2850000, 1260000, 1020000, 570000], [2950000, 1320000, 1060000, 570000]];
  const tissus = [1000000, 1050000, 1100000, 1150000, 1180000];
  const transport = [58000, 61000, 66000, 72000, 91000];
  const marketing = [30000, 35000, 52000, 78000, 95000];
  for (let k = -5; k <= -1; k++) {
    const i = k + 5; const ym = ymOffset(k);
    const [, a, b, c] = inc[i];
    const e = async (kind, category, label, amount, day) => post('/budget/entries', { kind, category, label, amount, date: `${ym}-${pad(day)}` }, 'lignes de budget');
    await e('income', 'Ventes', 'Ventes en boutique, semaine 1', a, 7); await e('income', 'Ventes', 'Ventes en boutique, semaine 2', b, 14);
    await e('income', 'Couture sur mesure', 'Commandes de tenues sur mesure', c, 27);
    await e('expense', 'Achats de tissus', 'Réassort de pagnes et bazin', tissus[i], 4); await e('expense', 'Salaires', 'Salaires et charges du personnel', 890000, 28);
    await e('expense', 'Loyer', 'Loyer du local commercial', 250000, 3); await e('expense', 'Électricité et eau', 'Factures du mois', 42000 + i * 3000, 12);
    await e('expense', 'Transport', 'Livraisons et déplacements', transport[i], 18); await e('expense', 'Marketing', 'Publicité en ligne', marketing[i], 10); await e('expense', 'Divers', 'Petites fournitures', 18000 + i * 2000, 24);
  }
  { // mois en cours, jusqu'à aujourd'hui
    const day = (d) => `${THIS_MONTH}-${pad(Math.max(1, Math.min(d, Number(TODAY.slice(8)))))}`;
    const e = async (kind, category, label, amount, d) => post('/budget/entries', { kind, category, label, amount, date: day(d) }, 'lignes de budget');
    await e('income', 'Ventes', 'Ventes en boutique, semaine 1', 1350000, 7); await e('income', 'Ventes', 'Ventes en boutique, semaine 2', 1100000, 14); await e('income', 'Couture sur mesure', 'Commandes de tenues sur mesure', 600000, 20);
    await e('expense', 'Achats de tissus', 'Réassort de pagnes et bazin', 980000, 4); await e('expense', 'Loyer', 'Loyer du local commercial', 250000, 3);
    await e('expense', 'Électricité et eau', 'Factures du mois', 58000, 12); await e('expense', 'Transport', 'Livraisons et déplacements', 79000, 18); await e('expense', 'Divers', 'Petites fournitures', 27000, 20);
  }
  await put('/budget/plans', { plans: [
    { category: 'Achats de tissus', monthlyLimit: 1400000 }, { category: 'Salaires', monthlyLimit: 950000 }, { category: 'Loyer', monthlyLimit: 250000 },
    { category: 'Électricité et eau', monthlyLimit: 60000 }, { category: 'Transport', monthlyLimit: 75000 }, { category: 'Marketing', monthlyLimit: 100000 }, { category: 'Divers', monthlyLimit: 40000 },
  ] });

  // ---------- Paie ----------
  await put('/payroll/settings', {
    rules: [
      { kind: 'employee', target: 'social', label: 'Cotisation salariale', rate: 4.2, ceiling: 750000 },
      { kind: 'employee', target: 'tax', label: 'Impôt sur le salaire', rate: 3, ceiling: 0 },
      { kind: 'employer', target: 'social', label: 'Cotisation patronale', rate: 11.2, ceiling: 750000 },
    ],
    options: { ratesAsOf: plus(-30) },
  });
  const prev = ymOffset(-1);
  for (const month of [prev, THIS_MONTH]) {
    await post('/payroll/run', { month });
    const slips = (await get(`/payroll/slips?month=${month}`)).slips;
    const slip = (name) => slips.find((s) => s.employee === name);
    if (month === THIS_MONTH) {
      await put(`/payroll/slips/${slip('Fatou Diallo').id}`, { bonuses: 15000, overtime: 8000 });
      await put(`/payroll/slips/${slip('Samuel Eyenga').id}`, { bonuses: 10000, advances: 20000 });
      await put(`/payroll/slips/${slip('Joseph Tchamba').id}`, { overtime: 12000 });
    }
    const order = slips.map((s) => s.id);
    for (let i = 0; i < order.length; i++) {
      const validateUntil = month === prev ? 6 : 4; const payUntil = month === prev ? 6 : 2;
      if (i < validateUntil) await post(`/payroll/slips/${order[i]}/validate`, {});
      if (i < payUntil) {
        await post(`/payroll/slips/${order[i]}/pay`, { method: i % 2 ? 'mobile' : 'bank', date: month === prev ? `${prev}-28` : plus(-1) });
        count('bulletins payés');
        if (month === THIS_MONTH) await post(`/payroll/slips/${order[i]}/budget`, {}); // inscrit le coût au budget du mois
      }
    }
    count('bulletins', order.length);
  }

  // ---------- Comptabilité ----------
  await get('/accounting'); // crée le plan comptable
  const entry = async (journal, date, label, piece, lines) => post('/accounting/entries', { journal, date, label, piece, lines }, 'écritures');
  const yr = TODAY.slice(0, 4);
  await entry('OD', `${yr}-01-05`, 'Apport en capital de la fondatrice', 'CAP-001', [{ account: '521', debit: 5000000 }, { account: '101', credit: 5000000 }]);
  await entry('OD', `${yr}-01-08`, 'Achat de machines à coudre et mobilier', 'IMMO-001', [{ account: '244', debit: 1800000 }, { account: '521', credit: 1800000 }]);
  for (let k = -4; k <= -1; k++) {
    const ym = ymOffset(k); const i = k + 5;
    await entry('AC', `${ym}-04`, 'Achats de pagnes et bazin', `FA-${ym}-A`, [{ account: '601', debit: tissus[i] }, { account: '401', credit: tissus[i] }]);
    await entry('BQ', `${ym}-09`, 'Règlement fournisseur textiles', `VIR-${ym}`, [{ account: '401', debit: tissus[i] }, { account: '521', credit: tissus[i] }]);
    await entry('CA', `${ym}-28`, 'Ventes comptoir du mois', `Z-${ym}`, [{ account: '571', debit: inc[i][0] - 600000 }, { account: '701', credit: inc[i][0] - 600000 }]);
    await entry('BQ', `${ym}-29`, 'Dépôt des espèces en banque', `DEP-${ym}`, [{ account: '521', debit: 1400000 }, { account: '571', credit: 1400000 }]);
    await entry('CA', `${ym}-03`, 'Loyer du local commercial', `LOY-${ym}`, [{ account: '622', debit: 250000 }, { account: '571', credit: 250000 }]);
    await entry('OD', `${ym}-28`, 'Paie du mois', `PAIE-${ym}`, [{ account: '661', debit: 810000 }, { account: '664', debit: 80000 }, { account: '422', credit: 810000 }, { account: '431', credit: 80000 }]);
    await entry('BQ', `${ym}-29`, 'Paiement des salaires et cotisations', `VIR-PAIE-${ym}`, [{ account: '422', debit: 810000 }, { account: '431', debit: 80000 }, { account: '521', credit: 890000 }]);
    await entry('BQ', `${ym}-30`, 'Frais bancaires', `FB-${ym}`, [{ account: '631', debit: 6500 }, { account: '521', credit: 6500 }]);
  }
  await post('/accounting/generate', {});

  // ---------- Fiscalité ----------
  for (const [title, kind, dueDate, status, amount, recurrence, repeat, note, period] of [
    ['TVA : déclaration de septembre', 'tva', plus(-8), 'paid', 132000, 'monthly', false, 'Payée par mobile money.', 'septembre'],
    ['TVA : déclaration d\'octobre', 'tva', plus(23), 'todo', 138000, 'monthly', true, 'À déposer avant le 15.', 'octobre'],
    ['Cotisations sociales de septembre', 'social', plus(-3), 'todo', 96000, 'monthly', true, 'En retard : à régler cette semaine.', 'septembre'],
    ['Acompte d\'impôt d\'octobre', 'acompte', plus(6), 'todo', 54000, 'monthly', true, '', 'octobre'],
    ['Patente de l\'année', 'patente', plus(45), 'todo', 180000, 'yearly', false, '', 'année'],
    ['Impôt sur les bénéfices : solde', 'is', plus(70), 'todo', 420000, 'yearly', false, 'Estimation à confirmer avec l\'expert-comptable.', 'exercice'],
    ['Dépôt des états financiers', 'etats', plus(190), 'todo', 0, 'yearly', false, '', 'exercice'],
  ]) await post('/fiscal/obligations', { title, kind, dueDate, status, amount: amount || undefined, recurrence, repeat, note, period }, 'échéances fiscales');

  // ---------- Logistique ----------
  const car = {}; const zone = {};
  for (const [k, name, contact, zones, rate, note] of [['moto', 'Express Moto Douala', '+237 690 30 00 01', 'Douala', 1000, 'Livraison le jour même avant 16 h.'], ['bus', 'Transports Inter-Villes', '+237 690 30 00 02', 'Yaoundé, Kribi, Bafoussam', 4500, 'Colis déposés à la gare routière.'], ['atelier', 'Livreur de la boutique', '+237 690 20 00 06', 'Douala centre', 0, 'Samuel, avec la moto de la boutique.']])
    car[k] = (await post('/logistics/carriers', { name, contact, zones, rate, note }, 'transporteurs')).id;
  for (const [k, name, fee, delayDays, note] of [['centre', 'Douala centre', 1000, 1, 'Akwa, Bonanjo, Deido'], ['peri', 'Douala périphérie', 2500, 2, 'Bonabéri, Logbessou, Yassa'], ['autres', 'Autres villes', 5000, 4, 'Par transporteur inter-villes']])
    zone[k] = (await post('/logistics/zones', { name, fee, delayDays, note }, 'zones')).id;
  const round = (await post('/logistics/rounds', { name: 'Tournée du matin : Akwa et Bonanjo', date: TODAY, carrierId: car.atelier, note: 'Départ 9 h' }, 'tournées')).id;
  const dv = {};
  const deliv = async (k, body, steps) => {
    dv[k] = (await post('/logistics/deliveries', body, 'livraisons')).id;
    for (const s of steps || []) await put(`/logistics/deliveries/${dv[k]}/status`, s);
  };
  await deliv('rose', { docId: inv.rose, address: 'Marché Mboppi, stand 14', zoneId: zone.centre, carrierId: car.moto, plannedDate: plus(-5) }, [{ status: 'shipped' }, { status: 'on_route' }, { status: 'delivered', receivedBy: 'Mme Rose Ndongo' }]);
  await deliv('mireille', { docId: inv.mireille, address: 'Quartier Bonapriso, rue des Manguiers', zoneId: zone.centre, carrierId: car.atelier, plannedDate: plus(-12) }, [{ status: 'shipped' }, { status: 'delivered', receivedBy: 'Mireille Essomba' }]);
  await deliv('christelle', { docId: inv.christelle, address: 'Logbessou, face à la pharmacie', zoneId: zone.peri, carrierId: car.atelier, roundId: round, plannedDate: TODAY }, [{ status: 'shipped' }, { status: 'on_route' }]);
  await deliv('paulhenri', { docId: inv.paulhenri, address: 'Akwa Nord, immeuble Les Cocotiers', zoneId: zone.centre, carrierId: car.moto, roundId: round, plannedDate: plus(1) }, [{ status: 'shipped' }]);
  await deliv('aicha', { docId: inv.aicha, address: 'Bonabéri, carrefour du marché', zoneId: zone.peri, carrierId: car.atelier, plannedDate: plus(2) }, []);
  await deliv('nadege', { docId: inv.nadege, address: 'Yaoundé, Mvog-Mbi', zoneId: zone.autres, carrierId: car.bus, tracking: 'BUS-20417', plannedDate: plus(-2) }, [{ status: 'shipped' }]);
  await deliv('ibrahim', { customerName: 'Ibrahim Sow', phone: '+237 690 10 00 04', address: 'Deido, rue du stade', zoneId: zone.centre, carrierId: car.moto, plannedDate: plus(-3) }, [{ status: 'shipped' }, { status: 'failed', note: 'Client absent, à reprogrammer' }]);

  // ---------- Production ----------
  const bom = {};
  bom.robe = (await post('/production/boms', { productId: items.robe, laborCost: 2500, otherCost: 300, notes: 'Robe évasée, coupe standard.', lines: [{ itemId: items.wax, quantity: 0.5 }, { itemId: items.zip, quantity: 1 }, { itemId: items.fil, quantity: 0.3 }, { itemId: items.doublure, quantity: 1.5 }, { itemId: items.etiq, quantity: 1 }, { itemId: items.sacs, quantity: 1 }] }, 'nomenclatures')).id;
  bom.boubou = (await post('/production/boms', { productId: items.boubou, laborCost: 6500, otherCost: 500, notes: 'Broderie au col.', lines: [{ itemId: items.bazin, quantity: 1 }, { itemId: items.fil, quantity: 0.5 }, { itemId: items.boutons, quantity: 0.5 }, { itemId: items.etiq, quantity: 1 }, { itemId: items.sacs, quantity: 1 }] }, 'nomenclatures')).id;
  bom.kaba = (await post('/production/boms', { productId: items.kaba, laborCost: 5000, otherCost: 400, notes: 'Haut et pagne assortis.', lines: [{ itemId: items.wax, quantity: 1 }, { itemId: items.dentelle, quantity: 1.5 }, { itemId: items.fil, quantity: 0.4 }, { itemId: items.zip, quantity: 1 }, { itemId: items.doublure, quantity: 2 }] }, 'nomenclatures')).id;
  const of1 = (await post('/production/orders', { bomId: bom.robe, quantity: 20, dueDate: plus(-9), notes: 'Lot de rentrée' }, 'ordres de fabrication')).id;
  await post(`/production/orders/${of1}/launch`, {});
  await post(`/production/orders/${of1}/close`, { producedQty: 20, scrapQty: 1, notes: 'Une pièce de rebut (tissu taché).' });
  const of2 = (await post('/production/orders', { bomId: bom.boubou, quantity: 8, dueDate: plus(5), notes: 'Pour la commande de mariage' }, 'ordres de fabrication')).id;
  await post(`/production/orders/${of2}/launch`, {});
  await post('/production/orders', { bomId: bom.kaba, quantity: 12, dueDate: plus(12), notes: 'En attente de la dentelle commandée' }, 'ordres de fabrication');
  await post('/production/orders', { bomId: bom.robe, quantity: 15, dueDate: plus(20), notes: 'Collection de fin d\'année' }, 'ordres de fabrication');

  // ---------- Maintenance ----------
  const eq = {};
  for (const [k, name, kind, reference, location, purchasedAt, value, status, meter] of [
    ['m1', 'Machine à coudre industrielle n° 1', 'machine', 'MC-001', 'Atelier', '2022-02-10', 480000, 'running', 3200],
    ['m2', 'Machine à coudre industrielle n° 2', 'machine', 'MC-002', 'Atelier', '2022-02-10', 480000, 'running', 2900],
    ['surj', 'Surjeteuse', 'machine', 'SJ-001', 'Atelier', '2023-05-20', 360000, 'running', 1500],
    ['brod', 'Machine à broder', 'machine', 'BR-001', 'Atelier', '2023-11-03', 1250000, 'running', 980],
    ['gen', 'Groupe électrogène', 'machine', 'GE-001', 'Arrière-cour', '2022-07-01', 650000, 'running', 1840],
    ['moto', 'Moto de livraison', 'vehicle', 'MOTO-DLA-01', 'Parking', '2024-08-01', 780000, 'running', 14300],
    ['pc', 'Ordinateur de caisse', 'it', 'PC-001', 'Boutique', '2024-02-15', 420000, 'running', 0],
  ]) eq[k] = (await post('/maintenance/equipment', { name, kind, reference, location, purchasedAt, value, status, meter }, 'équipements')).id;
  const plan = {};
  for (const [k, e, task, periodKind, periodValue, lastDoneAt, lastMeter] of [
    ['p1', 'm1', 'Nettoyage et graissage', 'days', 30, plus(-38)], ['p2', 'm2', 'Nettoyage et graissage', 'days', 30, plus(-12)], ['p3', 'surj', 'Changement des aiguilles et des lames', 'days', 90, plus(-80)],
    ['p4', 'gen', 'Vidange et filtre à huile', 'hours', 250, plus(-60), 1600], ['p5', 'moto', 'Vidange et contrôle des freins', 'km', 3000, plus(-70), 11500], ['p6', 'brod', 'Contrôle des courroies et lubrification', 'days', 60, plus(-20)],
  ]) plan[k] = (await post('/maintenance/plans', { equipmentId: eq[e], task, periodKind, periodValue, lastDoneAt, lastMeter }, 'plans de maintenance')).id;
  // Panne ouverte sur la machine à broder, intervention préventive terminée sur la moto, une intervention en cours
  const ot1 = (await post('/maintenance/orders', { equipmentId: eq.brod, kind: 'corrective', title: 'Fil qui casse en continu, aiguille bloquée', description: 'La machine s\'arrête après quelques points depuis hier.', priority: 'urgent', assigneeId: U.brice }, 'interventions')).id;
  void ot1;
  const ot2 = (await post('/maintenance/orders', { equipmentId: eq.moto, kind: 'preventive', planId: plan.p5, title: 'Vidange et contrôle des freins', priority: 'normal', assigneeId: U.brice, openedAt: plus(-10) }, 'interventions')).id;
  await post(`/maintenance/orders/${ot2}/start`, {});
  await post(`/maintenance/orders/${ot2}/close`, { downtimeHours: 3, laborCost: 8000, meter: 14300, notes: 'Plaquettes avant remplacées.' });
  const ot3 = (await post('/maintenance/orders', { equipmentId: eq.m1, kind: 'preventive', planId: plan.p1, title: 'Nettoyage et graissage', priority: 'normal', assigneeId: U.brice }, 'interventions')).id;
  await post(`/maintenance/orders/${ot3}/start`, {});

  // ---------- Chantier : agrandissement de l'atelier ----------
  const site = (await post('/construction/sites', { name: 'Agrandissement de l\'atelier de couture', client: 'Boutique Awa (travaux internes)', location: 'Bonabéri, Douala', foremanId: U.brice, startDate: plus(-40), endDate: plus(35), budget: 6500000, costBudget: 6000000, remainingEstimate: 1900000, status: 'active', notes: 'Extension de 30 m² pour installer 4 postes de couture supplémentaires.' }, 'chantiers')).id;
  const phases = [['Terrassement et fondations', 15, 100, -40, -28], ['Maçonnerie et élévation des murs', 30, 85, -27, -3], ['Charpente et toiture en tôle', 20, 40, -5, 14], ['Électricité et éclairage', 15, 10, 10, 24], ['Carrelage et peinture', 20, 0, 22, 33]];
  for (const [name, weight, progress, a, b] of phases) await post(`/construction/sites/${site}/phases`, { name, weight, progress, plannedStart: plus(a), plannedEnd: plus(b) }, 'phases');
  for (const [category, label, amount, d] of [
    ['materials', 'Ciment, sable et gravier', 780000, -38], ['labor', 'Équipe de maçons : fondations', 520000, -30], ['materials', 'Fer à béton et parpaings', 910000, -26], ['equipment', 'Location de bétonnière', 120000, -24],
    ['labor', 'Équipe de maçons : élévation', 640000, -12], ['materials', 'Tôles et charpente', 880000, -4], ['transport', 'Transport des matériaux', 135000, -9], ['other', 'Autorisation et taxes communales', 90000, -35],
  ]) await post(`/construction/sites/${site}/expenses`, { category, label, amount, date: plus(d) }, 'dépenses de chantier');
  for (const [d, worker, headcount, hours, notes] of [[-3, 'Équipe maçonnerie', 5, 8, 'Finition des murs'], [-2, 'Équipe charpente', 4, 8, 'Pose des fermes'], [-1, 'Équipe charpente', 4, 7, 'Pose des tôles, face nord']])
    await post(`/construction/sites/${site}/timesheets`, { date: plus(d), worker, headcount, hours, notes }, 'pointages');
  for (const [d, weather, work, headcount, incidents] of [[-3, 'Ensoleillé', 'Enduit intérieur des murs et chaînage haut.', 7, ''], [-2, 'Nuageux', 'Livraison de la charpente et début du montage.', 6, 'Retard de livraison de 2 h.'], [-1, 'Pluie le matin', 'Pose des tôles, arrêt de 2 h à cause de la pluie.', 5, '']])
    await post(`/construction/sites/${site}/reports`, { date: plus(d), weather, work, headcount, incidents }, 'rapports de chantier');
  await post(`/construction/sites/${site}/issues`, { kind: 'safety', title: 'Casques manquants pour deux ouvriers', description: 'À acheter avant lundi.', date: plus(-2) }, 'incidents de chantier');
  await post(`/construction/sites/${site}/issues`, { kind: 'snag', title: 'Fissure fine sur le mur est', description: 'À surveiller avant la peinture.', date: plus(-1) }, 'incidents de chantier');
  const b1 = (await post(`/construction/sites/${site}/billings`, { label: 'Situation n° 1 : fondations', amount: 1500000, billedAt: plus(-28), dueDate: plus(-14) }, 'situations de travaux')).id;
  await post(`/construction/sites/${site}/billings`, { label: 'Situation n° 2 : élévation des murs', amount: 2200000, billedAt: plus(-4), dueDate: plus(10) }, 'situations de travaux');
  await soft(() => post(`/construction/billings/${b1}/pay`, { amount: 1500000, date: plus(-10) }), 'paiement de situation');

  // ---------- Juridique ----------
  const ctr = async (b) => post('/legal/contracts', b, 'contrats');
  await ctr({ type: 'lease', title: 'Bail du local commercial de Bonabéri', parties: 'Boutique Awa et M. Landlord Exemple', subject: 'Location du local de 45 m² à usage de boutique', amount: 3000000, startDate: plus(-500), endDate: plus(300), tacit: true, noticeDays: 90, status: 'active', notes: 'Loyer de 250 000 FCFA par mois.', signStatus: 'signed', signedAt: plus(-500) });
  await ctr({ type: 'supplier', title: 'Contrat d\'approvisionnement Textiles Mbarga', parties: 'Boutique Awa et Textiles Mbarga', subject: 'Fourniture de pagnes wax et de bazin, prix bloqués 12 mois', amount: 9000000, startDate: plus(-353), endDate: plus(12), tacit: false, noticeDays: 15, status: 'active', notes: 'À renégocier avant la fin : demander la remise de volume.', signStatus: 'signed', signedAt: plus(-353) });
  await ctr({ type: 'insurance', title: 'Assurance multirisque du local et du stock', parties: 'Boutique Awa et Assurances du Littoral', subject: 'Incendie, vol, dégâts des eaux', amount: 185000, startDate: plus(-200), endDate: plus(165), tacit: true, noticeDays: 60, status: 'active', signStatus: 'signed', signedAt: plus(-200) });
  await ctr({ type: 'work', title: 'Contrat de travail de Nadine Ebogo', parties: 'Boutique Awa et Nadine Ebogo', subject: 'Couturière, contrat à durée indéterminée', startDate: '2021-09-01', status: 'active', signStatus: 'signed', signedAt: '2021-09-01' });
  await ctr({ type: 'partnership', title: 'Partenariat de livraison Express Moto Douala', parties: 'Boutique Awa et Express Moto Douala', subject: 'Livraisons à la demande dans Douala, tarif fixe', amount: 600000, startDate: plus(-90), endDate: plus(275), tacit: true, noticeDays: 30, status: 'active', signStatus: 'to_sign', signers: 'Awa Kamga' });
  await ctr({ type: 'client', title: 'Convention Hôtel Les Palmiers', parties: 'Boutique Awa et Hôtel Les Palmiers', subject: 'Fourniture annuelle de tenues de service', amount: 2400000, startDate: plus(-60), endDate: plus(305), tacit: false, noticeDays: 30, status: 'active', signStatus: 'signed', signedAt: plus(-60) });
  for (const [kind, title, dueDate, recurrenceMonths, notes] of [
    ['license', 'Renouvellement de la licence commerciale', plus(40), 12, 'Dossier à déposer à la mairie.'], ['insurance', 'Attestation d\'assurance à afficher', plus(100), 12, ''],
    ['declaration', 'Déclaration mensuelle des cotisations sociales', plus(5), 1, 'À préparer avec la paie du mois.'], ['display', 'Affichage des prix et des horaires en boutique', plus(15), 0, ''],
    ['inspection', 'Contrôle des extincteurs', plus(25), 12, 'Prestataire à appeler.'],
  ]) await post('/legal/obligations', { kind, title, dueDate, recurrenceMonths, notes, responsibleId: U.awa }, 'obligations');
  await post('/legal/disputes', { kind: 'claim', title: 'Réclamation sur une commande de robes', counterparty: 'Cliente Aïcha Traoré', amount: 54000, description: 'La taille livrée ne correspond pas à la commande.', nextStep: 'Proposer un échange sous 48 h', nextDate: plus(9), assigneeId: U.brice }, 'dossiers juridiques');
  await post('/legal/disputes', { kind: 'dispute', title: 'Retard de livraison de dentelle', counterparty: 'Dentelles du Wouri', amount: 140000, description: 'Livraison attendue depuis 3 semaines.', status: 'in_progress', nextStep: 'Mise en demeure amiable par écrit', nextDate: plus(14) }, 'dossiers juridiques');
  await post('/legal/privacy', { dataKind: 'Nom et téléphone des clientes', people: 'Clientes et prospects', storedWhere: 'Fichier clients de MANAGER-IA', purpose: 'Suivi des commandes et relances', retention: '3 ans après le dernier achat', sharedWith: 'Livreurs (adresse et téléphone)' }, 'registre de données');
  await post('/legal/privacy', { dataKind: 'Mensurations pour les tenues sur mesure', people: 'Clientes', storedWhere: 'Carnet de l\'atelier', purpose: 'Confection', retention: '2 ans', sharedWith: 'Aucun' }, 'registre de données');

  // ---------- Mémoire de l'entreprise ----------
  const supplierList = (await get('/stock/suppliers')).suppliers;
  const supId = (n) => (supplierList.find((s) => s.name === n) || {}).id;
  for (const m of [
    { kind: 'decision', title: 'Fixer les prix des tenues sur mesure', content: 'Décision du comité du mois dernier : une robe de cérémonie sur mesure est facturée 65 000 FCFA minimum, avec un acompte de 50 % à la commande. Le délai annoncé est de 5 à 7 jours.', tags: 'prix, sur mesure, acompte', date: plus(-34) },
    { kind: 'procedure', title: 'Contrôle qualité avant remise d\'une tenue', content: '1) Vérifier les mesures sur la fiche. 2) Contrôler les coutures et la broderie. 3) Repasser et plier avec le papier de soie. 4) Photographier la tenue pour le dossier. 5) Faire signer la remise.', tags: 'qualité, atelier' },
    { kind: 'meeting', title: 'Réunion de préparation de la collection de fin d\'année', content: 'Présents : Awa, Brice, Fatou, Nadine. Objectif : 60 pièces prêtes pour le 15 décembre. Tissus à commander cette semaine, photos en novembre, mise en ligne le 1er décembre.', tags: 'collection, planning', date: plus(-8) },
    { kind: 'lesson', title: 'Leçon : toujours confirmer la taille par écrit', content: 'Deux réclamations en un mois viennent d\'une taille mal notée par téléphone. Désormais la taille est répétée au client et notée sur le bon de commande avant lancement.', tags: 'réclamation, taille', date: plus(-5) },
    { kind: 'history', title: 'Historique du fournisseur Textiles Mbarga', content: 'Fournisseur depuis 2022. Livraisons fiables sous 3 jours, un retard en mars. Remise de 5 % obtenue à partir de 30 coupons. Contact : service commercial.', tags: 'fournisseur, remise', linkKind: supId('Textiles Mbarga') ? 'supplier' : undefined, linkId: supId('Textiles Mbarga') },
  ]) await post('/memory', m, 'notes de mémoire');

  // ---------- Organisation et fonctionnement ----------
  const pos = {};
  pos.dir = (await post('/structure/positions', { title: 'Dirigeante', description: 'Stratégie, finances et relations avec les fournisseurs.', holderId: U.awa }, 'postes')).id;
  pos.ger = (await post('/structure/positions', { title: 'Gérant de la boutique', description: 'Organisation quotidienne, équipe et caisse.', parentId: pos.dir, holderId: U.brice }, 'postes')).id;
  pos.vend = (await post('/structure/positions', { title: 'Vendeuse', description: 'Accueil, conseil et encaissement.', parentId: pos.ger, holderId: U.fatou }, 'postes')).id;
  pos.atel = (await post('/structure/positions', { title: 'Responsable de l\'atelier', description: 'Planning de confection et qualité.', parentId: pos.dir }, 'postes')).id;
  await post('/structure/positions', { title: 'Couturière / couturier', description: 'Coupe, couture et broderie.', parentId: pos.atel }, 'postes');
  await post('/structure/positions', { title: 'Livreur', description: 'Livraisons à Douala.', parentId: pos.ger }, 'postes');
  await post('/structure/processes', { title: 'Prise de commande sur mesure', category: 'Ventes', steps: ['Accueillir la cliente et écouter son besoin', 'Prendre les mesures et les noter sur la fiche', 'Choisir le tissu et le modèle', 'Annoncer le prix et le délai, encaisser 50 % d\'acompte', 'Créer le devis dans MANAGER-IA', 'Lancer la confection'] }, 'procédures');
  await post('/structure/processes', { title: 'Clôture de caisse du soir', category: 'Finances', steps: ['Compter les espèces', 'Comparer avec le total des ventes du jour', 'Noter l\'écart éventuel', 'Mettre les espèces dans le coffre', 'Saisir le total dans le budget'] }, 'procédures');
  await post('/structure/processes', { title: 'Réception d\'une livraison de tissus', category: 'Stock', steps: ['Vérifier le bon de livraison', 'Compter les coupons et contrôler les motifs', 'Enregistrer l\'entrée dans le stock', 'Ranger par famille d\'article'] }, 'procédures');

  // ---------- Résumé WhatsApp : abonnement sans envoi ----------
  await soft(() => put('/mail/digest/me', { morning: true, urgent: false, phone: '237 690 00 12 00', hour: '07:30', consent: true }), 'abonnement au résumé');

  // ---------- Complément SQL : conversations et commandes à valider ----------
  await sqlExtras(orgId, cust, inv, U);

  await report(orgId);
}

async function sqlExtras(orgId, cust, inv, U) {
  let pg;
  let url;
  try { url = fs.readFileSync(path.join(DEMO_DIR, 'pgurl.txt'), 'utf8').trim(); pg = require('pg'); } catch (e) { console.log('Complément SQL ignoré (pgurl.txt ou module pg introuvable).'); return; }
  const pool = new pg.Pool({ connectionString: url, max: 2 });
  const now = () => new Date().toISOString();
  const at = (minutesAgo) => new Date(Date.now() - minutesAgo * 60000).toISOString();
  try {
    await pool.query("UPDATE customers SET stage = 'prospect', source = $1 WHERE id = $2", ['RENTREE-FB', cust.fatoumata]);
    await pool.query("UPDATE customers SET stage = 'prospect', source = $1 WHERE id = $2", ['WA-FIDELITE', cust.samuel]);
    await pool.query("UPDATE customers SET stage = 'prospect', source = $1 WHERE id = $2", ['RENTREE-FB', cust.lucie]);
    await pool.query("UPDATE customers SET source = $1 WHERE id = $2", ['IG-PAGNES', cust.christelle]);
    await pool.query("UPDATE customers SET source = $1 WHERE id = $2", ['WA-FIDELITE', cust.mireille]);
    const chats = [
      ['fatoumata', 'whatsapp', '+237690001010', 'RENTREE-FB', 'open', 'chaud', 300, [['user', 'Bonsoir, je voudrais 3 coupons de pagne wax pour une fête, vous livrez à Douala ?'], ['assistant', 'Bonsoir ! Oui, nous livrons à Douala sous 24 h. Un coupon de pagne wax coûte 12 500 FCFA. Quels motifs vous intéressent ?'], ['user', 'Les motifs floraux. Je peux payer par mobile money ?'], ['assistant', 'Bien sûr. Je note 3 coupons à motifs floraux, soit 37 500 FCFA. Quelle est votre adresse de livraison ?']]],
      ['samuel', 'web', '', 'WA-FIDELITE', 'open', 'tiede', 720, [['user', 'Nous sommes 25 choristes, vous pouvez faire des tenues identiques en bazin ?'], ['assistant', 'Oui, nous faisons des commandes groupées. Je transmets votre demande à un conseiller pour établir un devis précis.'], ['staff', 'Bonjour, c\'est Brice de la Boutique Awa. Pouvez-vous me donner la couleur souhaitée et la date de la prestation ?']]],
      ['lucie', 'whatsapp', '+237690001012', 'RENTREE-FB', 'open', 'froid', 1500, [['user', 'Quel est le prix de la dentelle guipure ?'], ['assistant', 'La dentelle guipure coûte 4 500 FCFA le mètre. Pour une robe, comptez 3 à 4 mètres.']]],
      ['mireille', 'whatsapp', '+237690001001', 'WA-FIDELITE', 'open', 'chaud', 90, [['user', 'Je voudrais commander deux robes sur mesure pour le mariage de ma nièce.'], ['assistant', 'Avec plaisir ! Une robe de cérémonie sur mesure est à partir de 65 000 FCFA, délai 5 à 7 jours. Voulez-vous prendre rendez-vous pour les mesures ?'], ['user', 'Oui, samedi matin si possible.']]],
      ['christelle', 'web', '', 'IG-PAGNES', 'open', 'chaud', 2900, [['user', 'Bonjour, vu sur Instagram : est-ce que l\'ensemble kaba existe en vert ?'], ['assistant', 'Oui, l\'ensemble kaba existe en vert, bleu et jaune, à 32 000 FCFA. Je peux vous le réserver.']]],
      ['ibrahim', 'whatsapp', '+237690001004', '', 'open', 'tiede', 4300, [['user', 'Mon boubou est prêt ?'], ['assistant', 'Je vérifie auprès de l\'atelier et un conseiller vous répond rapidement.']]],
    ];
    const chatId = {};
    let n = 0;
    for (const [c, channel, contact, campaign, status, temperature, minutesAgo, msgs] of chats) {
      const created = at(minutesAgo + 60);
      const r = await pool.query('INSERT INTO chats (org_id, session, customer_id, campaign, status, created_at, updated_at, channel, contact, lead, assignee_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id',
        [orgId, `demo-${orgId}-${++n}`, cust[c], campaign, status, created, at(minutesAgo), channel, contact, JSON.stringify({ temperature }), c === 'samuel' ? U.brice : null]);
      chatId[c] = r.rows[0].id;
      let k = 0;
      for (const [role, content] of msgs) await pool.query('INSERT INTO chat_messages (chat_id, role, content, created_at) VALUES ($1,$2,$3,$4)', [chatId[c], role, content, at(minutesAgo + 30 - 5 * k++)]);
    }
    const doc = async (c, number, status, lines, note, daysAgo) => {
      const total = lines.reduce((a, l) => a + l.quantity * l.price, 0);
      const r = await pool.query("INSERT INTO documents (org_id, customer_id, kind, number, status, lines, total, paid, issued, due, note, created_by, created_at, updated_at, chat_id) VALUES ($1,$2,'order',$3,$4,$5,$6,0,$7,NULL,$8,$9,$10,$10,$11) RETURNING id",
        [orgId, cust[c], number, status, JSON.stringify(lines), total, iso(new Date(Date.now() - daysAgo * 86400000)), note, U.awa, new Date(Date.now() - daysAgo * 86400000).toISOString(), chatId[c] || null]);
      return r.rows[0].id;
    };
    const year = TODAY.slice(0, 4);
    await doc('fatoumata', `C-${year}-0001`, 'pending', [{ label: 'Pagne wax, coupon 6 yards', quantity: 3, price: 12500 }], 'Livraison à Douala, paiement mobile money.', 0);
    await doc('christelle', `C-${year}-0002`, 'pending', [{ label: 'Ensemble kaba', quantity: 1, price: 32000 }], 'Couleur verte.', 1);
    const confirmed = await doc('mireille', `C-${year}-0003`, 'confirmed', [{ label: 'Robe de cérémonie sur mesure', quantity: 2, price: 65000 }, { label: 'Foulard assorti', quantity: 2, price: 5000 }], 'Mariage de la nièce, mesures samedi.', 3);
    await doc('fatoumata', `C-${year}-0005`, 'confirmed', [{ label: 'Pagne wax, coupon 6 yards', quantity: 10, price: 12500 }, { label: 'Robe en pagne prête-à-porter', quantity: 8, price: 18000 }], 'Commande de revente confirmée par WhatsApp.', 6);
    await doc('christelle', `C-${year}-0004`, 'invoiced', [{ label: 'Ensemble kaba', quantity: 2, price: 32000 }], 'Déjà facturée.', 12);
    void confirmed;
    await pool.query("INSERT INTO appointments (org_id, customer_id, chat_id, date, time, duration, purpose, place, note, status, source, created_at, updated_at) VALUES ($1,$2,$3,$4,'10:00',45,$5,$6,'',$7,'assistant',$8,$8)", [orgId, cust.mireille, chatId.mireille, plus(2), 'Prise de mesures pour deux robes', 'Atelier de Bonabéri', 'pending', now()]);
    await pool.query("INSERT INTO appointments (org_id, customer_id, chat_id, date, time, duration, purpose, place, note, status, source, created_at, updated_at) VALUES ($1,$2,$3,$4,'15:30',30,$5,$6,'',$7,'assistant',$8,$8)", [orgId, cust.samuel, chatId.samuel, plus(4), 'Devis de tenues pour la chorale', 'Boutique', 'pending', now()]);
    count('conversations', chats.length); count('commandes à valider', 2); count('rendez-vous', 2);
  } catch (e) {
    console.log('Complément SQL en échec : ' + e.message);
  } finally { await pool.end(); }
}

async function report(orgId) {
  console.log('\nVérification par l\'API (nombre d\'éléments par module) :');
  const q = async (label, p, pick) => { const r = await owner('GET', `/api/ws/orgs/${orgId}${p}`); const v = r.status === 200 ? pick(r.json) : 'ERREUR ' + r.status; console.log('  ' + label.padEnd(26) + v); };
  const n = (a) => (Array.isArray(a) ? a.length : 0);
  await q('Tableau de bord', '/dashboard', (j) => Object.keys(j).slice(0, 6).join(', '));
  await q('Service client', '/support', (j) => `${n(j.tickets)} demandes`);
  await q('Projets', '/projects', (j) => `${n(j.projects)} projets`);
  await q('Budget', `/budget?month=${THIS_MONTH}`, (j) => `entrées ${j.income}, sorties ${j.expense}, solde ${j.balance}`);
  await q('Stock', '/stock', (j) => `${n(j.items)} articles, ${j.summary.low} sous le seuil`);
  await q('Clients', '/crm/customers', (j) => `${n(j.customers)} clients`);
  await q('Devis et factures', '/crm/documents', (j) => `${n(j.documents)} documents, ${j.summary.overdueCount} en retard (${j.summary.overdue} FCFA)`);
  await q('Assistant commercial', '/sales', (j) => `catalogue ${j.stats.catalog}, conversations 7 j ${j.stats.chats7}, commandes à valider ${j.stats.pendingOrders}`);
  await q('RH', '/hr', (j) => Object.keys(j).slice(0, 5).join(', '));
  await q('Paie', `/payroll?month=${THIS_MONTH}`, (j) => `${n(j.slips)} bulletins, net ${j.totals && j.totals.net}`);
  await q('Fiscalité', '/fiscal/obligations', (j) => `${n(j.items)} échéances, ${n(j.late)} en retard`);
  await q('Comptabilité', '/accounting', (j) => `${j.count} écritures, ventes ${j.kpi.ventes}`);
  await q('Marketing', '/marketing', (j) => `${n(j.campaigns)} campagnes, ${n(j.posts)} publications, ${n(j.offers)} offres`);
  await q('Logistique', '/logistics', (j) => Object.keys(j).slice(0, 5).join(', '));
  await q('Production', '/production', (j) => Object.keys(j).slice(0, 5).join(', '));
  await q('Chantiers', '/construction', (j) => `${n(j.sites)} chantier(s)`);
  await q('Maintenance', '/maintenance', (j) => Object.keys(j).slice(0, 5).join(', '));
  await q('Juridique', '/legal/contracts', (j) => `${n(j.contracts)} contrats`);
  await q('Mémoire', '/memory', (j) => `${n(j.entries)} notes`);
  await q('Agents', '/agents', (j) => `${n(j.agents)} agents`);
  await q('Alertes', '/dashboard/alerts', (j) => `${n(j.alerts)} alertes`);
  await q('Organisation', '/structure/positions', (j) => `${n(j.positions)} postes`);
  await q('Fonctionnement', '/structure/processes', (j) => `${n(j.processes)} procédures`);
  console.log('\nCréé : ' + Object.entries(stats).map(([k, v]) => `${v} ${k}`).join(', '));
  console.log(`\nConnexion : ${OWNER.contact} / ${OWNER.pass}  ·  organisation n° ${orgId} (${ORG_NAME})`);
}

main().catch((e) => { console.error('\nÉchec de la graine : ' + e.message); process.exit(1); });
