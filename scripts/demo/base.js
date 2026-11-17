'use strict';
// Socle de l'entreprise de démonstration « Batimat Afrique SARL » (distribution de matériaux de construction, Douala et Yaoundé) :
// fiche de l'entreprise, antennes, équipe (rôles), catalogue d'articles, clients et fournisseurs. Les autres groupes s'appuient sur ctx.ids.
const ITEMS = [
  // clé, nom, unité, quantité de départ, coût unitaire, seuil mini, prix de vente, suivi
  ['ciment', 'Ciment CPJ 42,5 — sac 50 kg', 'sac', 800, 4300, 200, 5200],
  ['fer10', 'Fer à béton HA 10 mm — barre 12 m', 'barre', 600, 3900, 150, 4800],
  ['fer12', 'Fer à béton HA 12 mm — barre 12 m', 'barre', 450, 5600, 120, 6800],
  ['tole', 'Tôle bac alu 6/10 — 3 m', 'feuille', 300, 7200, 80, 8900],
  ['peinture', 'Peinture vinylique blanche 20 L', 'seau', 120, 28000, 30, 34500, 'lot'],
  ['carreau', 'Carreau grès 60×60 — carton 1,44 m²', 'carton', 400, 9800, 100, 12500],
  ['parpaing', 'Parpaing creux 15×20×40', 'pièce', 5000, 330, 1500, 450],
  ['sable', 'Sable de rivière — benne 6 m³', 'benne', 25, 65000, 5, 85000],
  ['gravier', 'Gravier 15/25 — benne 6 m³', 'benne', 20, 90000, 5, 115000],
  ['tuyau', 'Tube PVC pression Ø 50 — 6 m', 'tube', 350, 3600, 80, 4700],
  ['cable', 'Câble électrique 2,5 mm² — rouleau 100 m', 'rouleau', 90, 32000, 20, 39500],
  ['groupe', 'Groupe électrogène 7,5 kVA', 'pièce', 6, 1450000, 2, 1790000, 'serial'],
];
const CUSTOMERS = [
  ['sogea', 'Sogea Satom Cameroun', '+237 699 10 20 30', 'achats@sogea-demo.example', 'Bonapriso, Douala', 'M011500012345A'],
  ['bati', 'Bâti Plus SARL', '+237 677 21 43 65', 'contact@batiplus-demo.example', 'Akwa, Douala', 'M021600054321B'],
  ['quinc', 'Quincaillerie du Wouri', '+237 655 44 11 22', 'wouri@quinc-demo.example', 'Marché Central, Douala', ''],
  ['mairie', 'Commune de Douala 5e', '+237 233 40 50 60', 'travaux@cud5-demo.example', 'Kotto, Douala', ''],
  ['ngono', 'Entreprise Ngono & Fils', '+237 690 33 22 11', 'ngono@demo.example', 'Bastos, Yaoundé', ''],
  ['immo', 'Immobilière des Collines', '+237 222 20 30 40', 'projets@collines-demo.example', 'Odza, Yaoundé', 'M031700099887C'],
  ['particulier', 'M. Jean-Paul Etoundi', '+237 671 00 99 88', '', 'Logpom, Douala', ''],
  ['hotel', 'Hôtel La Falaise', '+237 233 42 00 00', 'direction@falaise-demo.example', 'Bonanjo, Douala', ''],
];
const SUPPLIERS = [
  ['cimencam', 'Cimencam', 'Matériaux', 'Bonabéri, Douala', 30],
  ['dangote', 'Dangote Cement Cameroon', 'Matériaux', 'Douala-Bonabéri', 45],
  ['alucam', 'Alucam Tôlerie', 'Couverture', 'Edéa', 30],
  ['electro', 'Électro Douala', 'Électricité', 'Akwa, Douala', 15],
  ['carrière', 'Carrière de Nkometou', 'Granulats', 'Nkometou', 0],
  ['transit', 'Bolloré Transit (démo)', 'Transport', 'Port de Douala', 30],
];
const TEAM = [
  // rôle de démonstration, nom, rôle dans l'application, fonction
  ['manager', 'Marc Ebongué', 'manager', 'Directeur des opérations'],
  ['accountant', 'Clarisse Ngo Bassa', 'admin', 'Responsable administrative et financière'],
  ['storekeeper', 'Paul Tchinda', 'member', 'Chef magasinier'],
  ['seller', 'Aïcha Mohamadou', 'member', 'Commerciale'],
  ['driver', 'Samuel Fotso', 'member', 'Chauffeur-livreur'],
];

module.exports = async function base(ctx, opts) {
  const { client } = require('./lib');
  const owner = client(ctx.base);
  ctx.users.owner = owner;
  // ---------- Compte du dirigeant ----------
  if (opts.local) {
    await owner('POST', '/api/register', { name: 'Awa Kamga', contact: opts.contact, pass: opts.pass });
    const adm = client(ctx.base);
    await adm('POST', '/api/admin/login', { username: 'admin-demo', password: 'mot-de-passe-demo' });
    const me = await owner('GET', '/api/me');
    const uid = me.json && (me.json.user ? me.json.user.id : me.json.id);
    if (uid) await adm('POST', `/api/admin/users/${uid}/plan`, { plan: 'unl_year', days: 365 }); // toutes les fonctions et limites de l'offre Illimité
  }
  const lg = await owner('POST', '/api/login', { contact: opts.contact, pass: opts.pass });
  if (lg.status !== 200) throw new Error(`Connexion impossible pour ${opts.contact} : ${JSON.stringify(lg.json)}`);

  // ---------- L'entreprise ----------
  if (opts.org) ctx.org = Number(opts.org);
  else {
    const r = await ctx.do('Entreprise : créer l\'organisation', 'POST', '/api/ws/orgs', { name: 'Batimat Afrique SARL', sector: 'Distribution de matériaux de construction', currency: 'FCFA', description: 'Vente en gros et au détail de matériaux de construction, livraison sur chantier à Douala et Yaoundé. 18 employés, 2 dépôts.' });
    if (!r.id) throw new Error("Création de l'organisation impossible : " + JSON.stringify(r) + ' (utilisez --org ID pour remplir une organisation existante).');
    ctx.org = r.id;
  }
  ctx.O = `/api/ws/orgs/${ctx.org}`;
  await ctx.do('Entreprise : fiche (secteur, description, devise)', 'PUT', '', { name: 'Batimat Afrique SARL', sector: 'Distribution de matériaux de construction', currency: 'FCFA', description: 'Vente en gros et au détail de matériaux de construction, livraison sur chantier à Douala et Yaoundé. 18 employés, 2 dépôts.' });
  ctx.ids.branches = {};
  const have = (await ctx.do('Antennes : liste', 'GET', '/branches')).branches || [];
  for (const [k, name, location] of [['douala', 'Dépôt de Douala (siège)', 'Zone industrielle de Bonabéri, Douala'], ['yaounde', 'Dépôt de Yaoundé', 'Mvan, Yaoundé']]) {
    const ex = have.find((b) => b.name === name);
    ctx.ids.branches[k] = ex ? ex.id : (await ctx.do(`Antennes : créer « ${name} »`, 'POST', '/branches', { name, location })).id;
  }

  // ---------- L'équipe ----------
  ctx.ids.members = {};
  const stamp = Date.now().toString(36);
  for (const [key, name, role, title] of TEAM) {
    const inv = await ctx.do(`Équipe : inviter ${title}`, 'POST', '/invites', { role, title, branchId: key === 'driver' || key === 'storekeeper' ? ctx.ids.branches.douala : undefined });
    if (!opts.local) continue; // en ligne : les codes d'invitation restent à donner aux vraies personnes
    const c = client(ctx.base);
    const contact = `${key}.${stamp}@batimat-demo.example`;
    const reg = await c('POST', '/api/register', { name, contact, pass: opts.pass });
    if (reg.status >= 300) continue;
    const j = await c('POST', '/api/ws/orgs/join', { code: inv.code });
    if (j.status < 300) { ctx.users[key] = c; ctx.ids.members[key] = { name, contact, role, title }; }
  }
  const mem = (await ctx.do('Équipe : liste des membres', 'GET', '/members')).members || [];
  for (const k of Object.keys(ctx.ids.members)) { const m = mem.find((x) => x.contact === ctx.ids.members[k].contact); if (m) ctx.ids.members[k].userId = m.userId; }
  const me = mem.find((m) => m.role === 'owner'); ctx.ids.ownerId = me && me.userId;

  // ---------- Catalogue ----------
  ctx.ids.items = {}; ctx.ids.prices = {};
  const existing = ((await ctx.do('Stock : liste des articles', 'GET', '/stock')).items || []);
  let n = 0;
  for (const [key, name, unit, quantity, unitCost, minQuantity, price, tracking] of ITEMS) {
    n++;
    ctx.ids.prices[key] = price;
    const ex = existing.find((i) => i.name === name);
    if (ex) { ctx.ids.items[key] = ex.id; continue; }
    const body = { name, unit, unitCost, minQuantity, sku: `BTM-${String(n).padStart(3, '0')}`, barcode: `61${String(1000000000 + n * 7919).slice(0, 11)}`, tracking: tracking || 'none' };
    if (tracking === 'lot') Object.assign(body, { quantity, lotNo: 'PV-2611-A', expiry: ctx.day(540) });
    else if (tracking === 'serial') Object.assign(body, { quantity, serials: Array.from({ length: quantity }, (_, i) => `GE75-${2026}${String(i + 1).padStart(4, '0')}`) });
    else body.quantity = quantity;
    ctx.ids.items[key] = (await ctx.do(`Stock : créer l'article « ${name} »`, 'POST', '/stock/items', body)).id;
  }

  // ---------- Clients ----------
  ctx.ids.customers = {};
  const cust = ((await ctx.do('Clients : liste', 'GET', '/crm/customers')).customers || []);
  for (const [key, name, phone, email, address, niu] of CUSTOMERS) {
    const ex = cust.find((c) => c.name === name);
    ctx.ids.customers[key] = ex ? ex.id : (await ctx.do(`Clients : créer « ${name} »`, 'POST', '/crm/customers', { name, phone, email, address, niu, branchId: /Yaoundé/.test(address) ? ctx.ids.branches.yaounde : ctx.ids.branches.douala })).id;
  }

  // ---------- Fournisseurs ----------
  ctx.ids.suppliers = {};
  const sup = ((await ctx.do('Achats : liste des fournisseurs', 'GET', '/purchasing/suppliers')).suppliers || []);
  for (const [key, name, category, city, paymentDays] of SUPPLIERS) {
    const ex = sup.find((s) => s.name === name);
    ctx.ids.suppliers[key] = ex ? ex.id : (await ctx.do(`Achats : créer le fournisseur « ${name} »`, 'POST', '/purchasing/suppliers', { name, category, city, address: city, paymentDays, phone: '+237 233 00 00 00', email: `${key}@fournisseur-demo.example`, status: 'active' })).id;
  }
};
module.exports.ITEMS = ITEMS;
