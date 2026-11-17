'use strict';
// Clients et ventes : réglages de facturation, fiches clients, six mois de ventes (factures datées, sorties de stock, encaissements par virement,
// mobile money, chèque ou espèces), devis (accepté, refusé, sous le plancher, code promo), conversion en facture, paiement à vérifier confirmé
// ou rejeté, avoirs, annulation, impression, PDF et lien de partage. Les factures des derniers jours restent « à livrer » (logistique).
const VAT = 19.25;
const NAMES = Object.fromEntries(require('./base').ITEMS.map((i) => [i[0], i[1]]));

// Ventes : [jour (négatif), client, lignes [clé, qté, prix?], options]
// options : due (jours après émission ; null = sans échéance), pay [[part|'rest', mode, jours après émission, 'pending'?]], ttc, deliver (à livrer, pas de sortie de stock)
const T = 'transfer'; const M = 'mtn_momo'; const O = 'orange_money'; const Q = 'cheque'; const E = 'cash';
const SALES = [
  [-163, 'sogea', [['ciment', 60, 4950], ['fer12', 40, 6500], ['gravier', 2]], { due: 45, pay: [['rest', T, 38]] }],
  [-158, 'bati', [['ciment', 30], ['parpaing', 600]], { pay: [['rest', M, 12]] }],
  [-152, 'particulier', [['ciment', 15], ['fer10', 15]], { ttc: true, due: null, pay: [['rest', E, 0]] }],
  [-146, 'quinc', [['peinture', 4], ['tuyau', 30], ['cable', 3]], { pay: [['rest', O, 20]] }],
  [-141, 'hotel', [['carreau', 30], ['peinture', 5]], { pay: [['rest', Q, 25]] }],
  [-134, 'mairie', [['ciment', 40], ['parpaing', 900], ['sable', 2]], { due: 30, pay: [['rest', T, 55]] }],
  [-128, 'ngono', [['fer10', 50], ['ciment', 20]], { pay: [['rest', M, 10]] }],
  [-124, 'immo', [['carreau', 50], ['peinture', 6], ['groupe', 1]], { pay: [[0.5, T, 5], ['rest', T, 40]] }],
  [-119, 'sogea', [['fer10', 60], ['fer12', 50, 6500], ['sable', 3]], { due: 45, pay: [['rest', T, 44]] }],
  [-113, 'bati', [['tole', 40], ['ciment', 25]], { pay: [['rest', M, 15]] }],
  [-104, 'quinc', [['tuyau', 40], ['cable', 4], ['carreau', 20]], { pay: [['rest', O, 18]] }],
  [-99, 'particulier', [['tole', 18], ['ciment', 10]], { ttc: true, due: null, pay: [['rest', E, 0]] }],
  [-95, 'hotel', [['groupe', 1], ['cable', 3]], { pay: [['rest', Q, 30]] }],
  [-90, 'sogea', [['ciment', 70, 4950], ['gravier', 3]], { due: 45, pay: [['rest', T, 40]] }],
  [-86, 'ngono', [['fer12', 30], ['tole', 25]], { pay: [['rest', M, 20]] }],
  [-82, 'mairie', [['ciment', 30], ['gravier', 2]], { due: 30, pay: [] }], // impayée : plus de 50 jours de retard
  [-74, 'immo', [['carreau', 60], ['peinture', 4]], { pay: [['rest', T, 30]] }],
  [-70, 'bati', [['parpaing', 700], ['tole', 45]], { pay: [['rest', M, 9]] }],
  [-66, 'sogea', [['fer10', 50], ['fer12', 40, 6500], ['ciment', 40, 4950]], { due: 45, pay: [[0.6, T, 30], ['rest', T, 45]] }],
  [-61, 'quinc', [['peinture', 5], ['cable', 4]], { due: 30, pay: [[0.4, O, 25]] }], // reste dû : en retard
  [-57, 'particulier', [['sable', 1], ['gravier', 1]], { ttc: true, due: null, pay: [['rest', E, 0]] }],
  [-53, 'hotel', [['carreau', 25], ['tuyau', 20]], { pay: [['rest', Q, 28]] }],
  [-46, 'sogea', [['ciment', 50, 4950], ['sable', 3], ['gravier', 2]], { due: 45, pay: [['rest', T, 30]] }],
  [-43, 'mairie', [['parpaing', 800], ['ciment', 25]], { due: 30, pay: [[0.3, T, 20]] }], // acompte seulement : en retard
  [-39, 'ngono', [['fer10', 40], ['ciment', 15]], { pay: [['rest', M, 12]] }],
  [-35, 'bati', [['tole', 50], ['ciment', 20]], { pay: [['rest', M, 6, 'pending']] }], // référence à vérifier, confirmée plus bas
  [-31, 'immo', [['groupe', 1], ['cable', 4]], { pay: [['rest', T, 20]] }],
  [-27, 'quinc', [['tuyau', 30], ['carreau', 15]], { pay: [['rest', O, 10]] }],
  [-24, 'sogea', [['fer12', 30, 6500], ['tole', 30]], { due: 45, pay: [['rest', T, 20]] }],
  [-16, 'hotel', [['peinture', 4], ['carreau', 20]], { due: null, pay: [] }], // sans échéance, non payée
  [-14, 'particulier', [['ciment', 15]], { ttc: true, due: null, pay: [['rest', E, 0]] }],
  [-12, 'sogea', [['ciment', 45, 4950], ['fer10', 40]], { due: 45, pay: [[0.5, T, 7]] }],
  [-9, 'bati', [['tole', 'rest'], ['parpaing', 500]], { pay: [] }], // le reste des tôles : rupture de stock
  [-7, 'ngono', [['fer12', 25], ['gravier', 1]], { pay: [] }],
  // À livrer (logistique) : pas encore sorties du stock
  [-4, 'sogea', [['ciment', 60, 4950], ['fer10', 50], ['gravier', 2]], { due: 45, deliver: true, pay: [[0.4, T, 1]] }],
  [-3, 'immo', [['carreau', 40], ['peinture', 3], ['groupe', 1]], { deliver: true, pay: [[0.3, T, 1]] }],
  [-2, 'mairie', [['ciment', 40], ['parpaing', 800]], { deliver: true, pay: [] }],
  [-1, 'hotel', [['cable', 5], ['tuyau', 20]], { deliver: true, pay: [] }],
];

const lineTotal = (lines) => lines.reduce((a, l) => a + Math.round(l.quantity * l.price), 0);
const totalOf = (lines, ttc) => { const s = lineTotal(lines); return ttc ? s : s + Math.round((s * VAT) / 100); };

module.exports = async function ventes(ctx, C) {
  const cu = ctx.ids.customers; const it = ctx.ids.items; const P = ctx.ids.prices;
  const sk = ctx.users.storekeeper ? 'storekeeper' : 'owner';
  let refN = 0; const ref = (m, day) => { refN++; const d = ctx.day(day).replace(/-/g, '').slice(2); return { transfer: `VIR-AFB-${d}-${String(4100 + refN)}`, mtn_momo: `MP${d}.${String(1000 + refN * 7).slice(-4)}.C${String(48213 + refN * 13)}`, orange_money: `CI${d}.${String(1200 + refN * 3).slice(-4)}.B${String(30117 + refN * 11)}`, cheque: `CHQ ${String(2104500 + refN)} SGC`, cash: '' }[m]; };

  // ---------- Réglages de facturation (administratrice) ----------
  const settings = { niu: 'M052400098765K', rccm: 'RC/DLA/2019/B/4471', address: 'Zone industrielle de Bonabéri, BP 12 345 Douala — Tél. +237 233 39 00 00', payInfo: 'Virement : Afriland First Bank, compte 10005 00001 01234567890 12\nMTN MoMo marchand : 650 12 34 56 (Batimat Afrique)\nOrange Money : 699 12 34 56', footer: 'Marchandise livrée non reprise après 8 jours. Pénalités de retard : 1,5 % par mois (à valider avec votre conseil).', vatRate: VAT };
  if (ctx.users.manager) await ctx.do('Facturation : mentions réservées aux administrateurs (refus pour le directeur des opérations)', 'PUT', '/crm/invoice-settings', settings, { as: 'manager', expect: 403 });
  await ctx.do('Facturation : NIU, RCCM, coordonnées bancaires et TVA 19,25 %', 'PUT', '/crm/invoice-settings', settings, { as: 'accountant' });
  await ctx.do('Facturation : taux de TVA absurde refusé', 'PUT', '/crm/invoice-settings', { vatRate: 45 }, { as: 'accountant', expect: 400 });
  const st = await ctx.do('Facturation : relire les réglages', 'GET', '/crm/invoice-settings', undefined, { as: 'manager' });
  ctx.check('Facturation : NIU et TVA 19,25 % enregistrés', st.niu === settings.niu && st.vatRate === VAT, st);

  // ---------- Fiches clients (la commerciale saisit, le responsable nettoie) ----------
  const extra = [['fouda', 'Ets Fouda Matériaux', '+237 699 45 67 12', 'fouda.materiaux@demo.example', 'Mokolo, Yaoundé', 'M061800044556D'], ['ndjock', "Cabinet d'architecture Ndjock", '+237 677 80 90 10', 'agence@ndjock-demo.example', 'Bonamoussadi, Douala', '']];
  for (const [k, name, phone, email, address, niu] of extra) {
    const ex = ((await ctx.do('Clients : rechercher une fiche existante', 'GET', '/crm/customers', undefined, { as: 'seller' })).customers || []).find((c) => c.name === name);
    cu[k] = ex ? ex.id : (await ctx.do(`Clients : la commerciale crée « ${name} »`, 'POST', '/crm/customers', { name, phone, email, address, niu, notes: 'Rencontré au salon Promote 2026', branchId: /Yaoundé/.test(address) ? ctx.ids.branches.yaounde : ctx.ids.branches.douala }, { as: 'seller' })).id;
  }
  await ctx.do('Clients : compléter une fiche (contact, notes)', 'PUT', `/crm/customers/${cu.ndjock}`, { notes: 'Prescripteur : recommande nos carreaux sur ses chantiers de villas. Contact : Arch. Patrice Ndjock.', phone: '+237 677 80 90 11' }, { as: 'seller' });
  await ctx.do('Clients : notes de suivi Sogea', 'PUT', `/crm/customers/${cu.sogea}`, { notes: 'Grand compte. Conducteur de travaux : Ing. Eyinga (699 10 20 31). Paiement à 45 jours fin de mois.' }, { as: 'manager' });
  const dup = (await ctx.do('Clients : fiche en double créée par erreur', 'POST', '/crm/customers', { name: 'Quincaillerie Wouri (doublon)', phone: '+237 655 44 11 22' }, { as: 'seller' })).id;
  if (ctx.users.seller) await ctx.do('Clients : la commerciale ne peut pas supprimer une fiche', 'DELETE', `/crm/customers/${dup}`, undefined, { as: 'seller', expect: 403 });
  await ctx.do('Clients : supprimer le doublon', 'DELETE', `/crm/customers/${dup}`, undefined, { as: 'manager' });
  // Prospects rencontrés au salon : import d'un fichier CSV (vérification puis import)
  const csv = 'Nom;Téléphone;E-mail;Adresse;Notes\nSOCOBAT Sarl;+237 699 31 41 59;socobat@demo.example;Biyem-Assi, Yaoundé;Salon Promote : immeuble R+4\nEts Mballa & Frères;+237 677 26 53 58;;Ndokoti, Douala;Salon Promote : quincaillerie\nGIC des maçons de Bépanda;+237 655 97 93 23;;Bépanda, Douala;Groupement de 12 artisans\nSogea (déjà client);+237 699 10 20 30;;;\n;+237 690 00 00 01;;Akwa;ligne sans nom\n';
  const dry = await ctx.do('Prospects : vérifier le fichier du salon avant import', 'POST', '/data/import/customers', { csv, dryRun: true }, { as: 'manager' });
  ctx.check('Prospects : 3 nouveaux, 1 doublon, 1 ligne en erreur', dry.created + dry.duplicates === 4 && dry.duplicates >= 1 && dry.errorCount === 1, dry);
  await ctx.do('Prospects : importer les prospects du salon', 'POST', '/data/import/customers', { csv }, { as: 'manager' });
  if (ctx.users.seller) await ctx.do('Ventes : devis et factures fermés à la commerciale (droits)', 'GET', '/crm/documents', undefined, { as: 'seller', expect: 403 });

  // ---------- Stock disponible : les ventes s'y adaptent (jamais plus que ce qui est disponible) ----------
  const stock = (await ctx.do('Stock : quantités disponibles avant les ventes', 'GET', '/stock', undefined, { as: 'manager' })).items || [];
  const left = {}; for (const [k, id] of Object.entries(it)) { const s = stock.find((x) => x.id === id); left[k] = s ? Math.max(0, Math.floor(Number(s.available === undefined ? s.quantity : s.available))) : 0; }
  const want = {}; for (const [, , lines] of SALES) for (const [k, q] of lines) if (q !== 'rest') want[k] = (want[k] || 0) + q;
  const scale = {}; for (const k of Object.keys(want)) scale[k] = Math.min(1, (left[k] * 0.95) / want[k]);
  let serials = [];
  if (it.groupe) serials = ((await ctx.do('Stock : numéros de série en stock (groupes électrogènes)', 'GET', `/stock/items/${it.groupe}/lots`, undefined, { as: sk })).serials || []).filter((s) => s.status === 'in_stock').map((s) => s.serial);

  C.invoices = []; C.toDeliver = []; C.quotes = []; C.credits = [];
  const docs = {}; // index -> {id, total, lines, cust}
  let payDone = 0; let stockOuts = 0;
  for (let i = 0; i < SALES.length; i++) {
    const [day, ck, spec, o] = SALES[i];
    const lines = [];
    for (const [k, q0, price] of spec) {
      let q = q0 === 'rest' ? left[k] : Math.max(1, Math.round(q0 * scale[k]));
      q = Math.min(q, o.deliver ? left[k] : left[k]);
      if (k === 'groupe') q = Math.min(q, serials.length);
      if (!(q > 0)) continue;
      left[k] -= q;
      lines.push({ itemId: it[k], label: NAMES[k], quantity: q, price: o.ttc ? Math.round(P[k] * (1 + VAT / 100) / 5) * 5 : price || P[k] });
    }
    if (!lines.length) continue;
    const due = o.due === null ? null : ctx.day(day + (o.due || 30));
    const id = (await ctx.do(`Ventes : facture du ${ctx.day(day)} (${ck})`, 'POST', '/crm/documents', { kind: 'invoice', customerId: cu[ck], issued: ctx.day(day), due, pricesIncl: !!o.ttc, lines, note: o.deliver ? 'Livraison sur chantier à planifier' : '' }, { as: 'manager' })).id;
    if (!id) continue;
    const total = totalOf(lines, o.ttc);
    docs[i] = { id, total, lines, cust: ck, day };
    C.invoices.push(id);
    await ctx.do('Ventes : marquer la facture envoyée', 'PUT', `/crm/documents/${id}`, { status: 'sent' }, { as: 'manager' });
    if (o.deliver) C.toDeliver.push(id);
    else {
      for (const l of lines) {
        const k = Object.keys(it).find((x) => it[x] === l.itemId);
        const body = { kind: 'out', quantity: l.quantity, reason: `Vente — facture du ${ctx.day(day)} — ${ck === 'particulier' ? 'M. Etoundi' : ck}` };
        if (k === 'groupe') body.serials = serials.splice(0, l.quantity);
        const r = await ctx.do(`Stock : sortie pour la vente (${NAMES[k]})`, 'POST', `/stock/items/${l.itemId}/move`, body, { as: sk });
        if (r.quantity !== undefined) stockOuts++;
      }
    }
    let paid = 0;
    for (const [part, method, after, status] of o.pay) {
      const amount = part === 'rest' ? total - paid : Math.round(total * part / 1000) * 1000;
      const date = ctx.day(Math.min(day + after, 0));
      const r = await ctx.do(`Encaissements : ${({ transfer: 'virement', mtn_momo: 'MTN Mobile Money', orange_money: 'Orange Money', cheque: 'chèque', cash: 'espèces' })[method]}${status ? ' (à vérifier)' : ''}`, 'POST', `/crm/documents/${id}/payments`, { amount, method, reference: ref(method, day + after), date, status, payerPhone: /momo|orange/.test(method) ? '+237 677 21 43 65' : undefined, note: part === 'rest' ? '' : 'Acompte' }, { as: 'accountant' });
      if (r.id) { payDone++; if (!status) paid += amount; else docs[i].pending = r.id; }
    }
  }
  ctx.check(`Ventes : ${Object.keys(docs).length} factures sur 6 mois, ${stockOuts} sorties de stock, ${payDone} encaissements`, Object.keys(docs).length >= 30 && stockOuts >= 50, { n: Object.keys(docs).length, stockOuts });

  // ---------- Paiement à vérifier : confirmé (MoMo) ; un autre rejeté (référence inconnue chez l'opérateur) ----------
  const bp = Object.values(docs).find((d) => d.pending);
  if (bp) {
    const pl = await ctx.do('Encaissements : liste des paiements de la facture', 'GET', `/crm/documents/${bp.id}/payments`, undefined, { as: 'accountant' });
    ctx.check('Encaissements : paiement MoMo « à vérifier » en attente', (pl.payments || []).some((p) => p.status === 'pending'), pl.payments);
    await ctx.do('Encaissements : confirmer le paiement MoMo vérifié chez MTN', 'POST', `/crm/documents/${bp.id}/payments/${bp.pending}/confirm`, {}, { as: 'accountant' });
    await ctx.do('Encaissements : un paiement déjà traité ne se confirme pas deux fois', 'POST', `/crm/documents/${bp.id}/payments/${bp.pending}/confirm`, {}, { as: 'accountant', expect: 400 });
  }
  const bad = Object.values(docs).find((d) => d.cust === 'bati' && d.day === -9);
  if (bad) {
    const r = await ctx.do('Encaissements : paiement Orange Money déclaré par le client (à vérifier)', 'POST', `/crm/documents/${bad.id}/payments`, { amount: bad.total, method: 'orange_money', reference: 'CI261108.1432.B99999', status: 'pending', payerPhone: '+237 677 21 43 65', note: 'Capture envoyée par WhatsApp' }, { as: 'accountant' });
    if (r.id) await ctx.do('Encaissements : rejeter le paiement (référence introuvable chez Orange)', 'POST', `/crm/documents/${bad.id}/payments/${r.id}/reject`, {}, { as: 'accountant' });
    await ctx.do('Encaissements : virement partiel de Bâti Plus', 'POST', `/crm/documents/${bad.id}/payments`, { amount: Math.round(bad.total / 2), method: 'transfer', reference: 'VIR-UBA-261112-0091', date: ctx.day(-5) }, { as: 'accountant' });
    await ctx.do('Encaissements : même référence de transaction refusée (doublon)', 'POST', `/crm/documents/${bad.id}/payments`, { amount: 1000, method: 'transfer', reference: 'VIR-UBA-261112-0091' }, { as: 'accountant', expect: 409 });
    await ctx.do('Encaissements : paiement supérieur au solde refusé', 'POST', `/crm/documents/${bad.id}/payments`, { amount: bad.total, method: 'cash' }, { as: 'accountant', expect: 400 });
    await ctx.do('Encaissements : mobile money sans référence refusé', 'POST', `/crm/documents/${bad.id}/payments`, { amount: 1000, method: 'mtn_momo' }, { as: 'accountant', expect: 400 });
  }

  // ---------- Avoirs, annulation, suppression d'un brouillon ----------
  const sg = Object.values(docs).find((d) => d.cust === 'sogea' && d.day === -12);
  if (sg) {
    const cn = await ctx.do('Avoirs : remise commerciale pour retard de livraison (Sogea)', 'POST', `/crm/documents/${sg.id}/credit-note`, { reason: 'Livraison du 2e lot avec 3 jours de retard : geste commercial accordé par la direction', lines: [{ label: 'Remise commerciale — retard de livraison', quantity: 1, price: 25000 }] }, { as: 'manager' });
    if (cn.id) C.credits.push(cn.id);
    await ctx.do('Avoirs : motif obligatoire', 'POST', `/crm/documents/${sg.id}/credit-note`, { lines: [{ label: 'Remise', quantity: 1, price: 1000 }] }, { as: 'manager', expect: 400 });
  }
  const dupInv = (await ctx.do('Ventes : facture saisie deux fois par erreur', 'POST', '/crm/documents', { kind: 'invoice', customerId: cu.bati, issued: ctx.day(-8), due: ctx.day(22), pricesIncl: false, lines: [{ label: NAMES.parpaing, quantity: 500, price: P.parpaing }] }, { as: 'manager' })).id;
  if (dupInv) {
    await ctx.do('Ventes : facture en double envoyée au client', 'PUT', `/crm/documents/${dupInv}`, { status: 'sent' }, { as: 'manager' });
    const cn = await ctx.do('Avoirs : avoir total sur la facture en double', 'POST', `/crm/documents/${dupInv}/credit-note`, { reason: 'Facture émise en double (même livraison que la facture précédente)' }, { as: 'manager' });
    if (cn.id) C.credits.push(cn.id);
    await ctx.do('Avoirs : un avoir ne se modifie pas', 'PUT', `/crm/documents/${cn.id}`, { note: 'x' }, { as: 'manager', expect: 400 });
    await ctx.do('Avoirs : un avoir ne se supprime pas (pièce comptable)', 'DELETE', `/crm/documents/${cn.id}`, undefined, { as: 'accountant', expect: 400 });
  }
  const canc = (await ctx.do('Ventes : facture d\'une commande annulée par le client', 'POST', '/crm/documents', { kind: 'invoice', customerId: cu.quinc, issued: ctx.day(-6), due: ctx.day(24), pricesIncl: false, lines: [{ label: NAMES.cable, quantity: 10, price: P.cable }] }, { as: 'manager' })).id;
  if (canc) {
    await ctx.do('Ventes : facture envoyée', 'PUT', `/crm/documents/${canc}`, { status: 'sent' }, { as: 'manager' });
    await ctx.do('Ventes : une facture émise ne se supprime pas (numérotation continue)', 'DELETE', `/crm/documents/${canc}`, undefined, { as: 'accountant', expect: 400 });
    await ctx.do('Ventes : annuler la facture (commande annulée avant livraison)', 'PUT', `/crm/documents/${canc}`, { status: 'cancelled', note: 'Commande annulée par le client le ' + ctx.day(-5) }, { as: 'manager' });
  }
  const draft = (await ctx.do('Ventes : brouillon de facture', 'POST', '/crm/documents', { kind: 'invoice', customerId: cu.ngono, pricesIncl: false, lines: [{ label: NAMES.fer10, quantity: 5, price: P.fer10 }] }, { as: 'manager' })).id;
  if (draft) {
    await ctx.do('Ventes : modifier les lignes du brouillon', 'PUT', `/crm/documents/${draft}`, { lines: [{ label: NAMES.fer10, quantity: 8, price: P.fer10 }], due: ctx.day(30) }, { as: 'manager' });
    await ctx.do('Ventes : supprimer le brouillon (dernier numéro)', 'DELETE', `/crm/documents/${draft}`, undefined, { as: 'manager' });
  }

  // ---------- Devis ----------
  const q = async (label, body) => (await ctx.do(label, 'POST', '/crm/documents', { kind: 'quote', pricesIncl: false, ...body }, { as: 'manager' })).id;
  const qNgono = await q('Devis : chantier R+2 à Bastos (Ngono & Fils)', { customerId: cu.ngono, issued: ctx.day(-20), due: ctx.day(10), note: 'Validité 30 jours. Livraison Yaoundé incluse au-delà de 2 tonnes.', lines: [{ itemId: it.fer10, label: NAMES.fer10, quantity: Math.min(40, Math.max(1, left.fer10 - 5)), price: P.fer10 }, { itemId: it.ciment, label: NAMES.ciment, quantity: Math.min(30, Math.max(1, left.ciment - 5)), price: 5100 }] });
  if (qNgono) {
    await ctx.do('Devis : envoyé au client', 'PUT', `/crm/documents/${qNgono}`, { status: 'sent' }, { as: 'manager' });
    await ctx.do('Devis : un devis non accepté ne devient pas facture', 'POST', `/crm/documents/${qNgono}/convert`, {}, { as: 'manager', expect: 400 });
    await ctx.do('Devis : accepté par le client', 'PUT', `/crm/documents/${qNgono}`, { status: 'accepted' }, { as: 'manager' });
    const inv = (await ctx.do('Devis : conversion en facture', 'POST', `/crm/documents/${qNgono}/convert`, { due: ctx.day(30) }, { as: 'manager' })).id;
    if (inv) {
      await ctx.do('Ventes : facture issue du devis envoyée', 'PUT', `/crm/documents/${inv}`, { status: 'sent' }, { as: 'manager' });
      C.invoices.push(inv); C.toDeliver.push(inv);
      const pd = await ctx.do('Ventes : relire la facture issue du devis', 'GET', `/crm/documents/${inv}/print`, undefined, { as: 'manager' });
      ctx.check('Devis → facture : mêmes lignes, note « Suite au devis »', (pd.lines || []).length === 2 && /Suite au devis/.test(pd.document && pd.document.note), pd.document);
      const det = await ctx.do('Clients : fiche détaillée (devis et factures)', 'GET', `/crm/customers/${cu.ngono}`, undefined, { as: 'manager' });
      const d2 = (det.documents || []).find((d) => d.id === inv);
      ctx.check('Devis → facture : les lignes gardent le lien avec les articles du stock (livraison possible)', d2 && d2.lines.every((l) => l.itemId), d2 && d2.lines);
    }
    C.quotes.push(qNgono);
  }
  const qImmo = await q('Devis : carrelage et peinture résidence Odza (Immobilière des Collines)', { customerId: cu.immo, issued: ctx.day(-12), due: ctx.day(18), lines: [{ itemId: it.carreau, label: NAMES.carreau, quantity: 200, price: 12000 }, { itemId: it.peinture, label: NAMES.peinture, quantity: 20, price: P.peinture }] });
  if (qImmo) { await ctx.do('Devis : envoyé (en attente de réponse)', 'PUT', `/crm/documents/${qImmo}`, { status: 'sent' }, { as: 'manager' }); C.quotes.push(qImmo); }
  const qBati = await q('Devis : groupe électrogène pour la base vie Bâti Plus', { customerId: cu.bati, issued: ctx.day(-15), lines: [{ itemId: it.groupe, label: NAMES.groupe, quantity: 1, price: P.groupe }, { itemId: it.cable, label: NAMES.cable, quantity: 5, price: P.cable }] });
  if (qBati) { await ctx.do('Devis : envoyé', 'PUT', `/crm/documents/${qBati}`, { status: 'sent' }, { as: 'manager' }); await ctx.do('Devis : refusé par le client (prix concurrent)', 'PUT', `/crm/documents/${qBati}`, { status: 'refused', note: 'Client parti chez un concurrent à 1 690 000 FCFA' }, { as: 'manager' }); C.quotes.push(qBati); }
  // Prix sous le plancher : refus pour le responsable, exception tracée pour la direction
  const low = { customerId: cu.mairie, due: ctx.day(30), note: 'Marché public : réfection des caniveaux de Kotto', lines: [{ itemId: it.ciment, label: NAMES.ciment, quantity: 500, price: 4500 }] };
  if (ctx.users.manager) await ctx.do('Devis : prix sous le plancher refusé au responsable', 'POST', '/crm/documents', { kind: 'quote', pricesIncl: false, ...low }, { as: 'manager', expect: 403 });
  await ctx.do('Devis : prix sous le plancher sans motif refusé à la direction', 'POST', '/crm/documents', { kind: 'quote', pricesIncl: false, ...low }, { expect: 422 });
  const qLow = (await ctx.do('Devis : exception de prix accordée par la direction, avec motif', 'POST', '/crm/documents', { kind: 'quote', pricesIncl: false, ...low, priceOverride: { reason: "Alignement sur l'offre concurrente pour le marché de la commune (500 sacs), validé par Mme Kamga" } })).id;
  if (qLow) {
    C.quotes.push(qLow);
    await ctx.do('Devis : le responsable ne peut pas descendre sous le plancher en modifiant', 'PUT', `/crm/documents/${qLow}`, { lines: [{ itemId: it.ciment, label: NAMES.ciment, quantity: 500, price: 4600 }] }, { as: 'manager', expect: ctx.users.manager ? 403 : 422 });
    await ctx.do('Devis : prix remonté au plancher (4 850)', 'PUT', `/crm/documents/${qLow}`, { lines: [{ itemId: it.ciment, label: NAMES.ciment, quantity: 500, price: 4850 }] }, { as: 'manager' });
  }
  const qHotel = await q('Devis : rénovation des chambres (Hôtel La Falaise)', { customerId: cu.hotel, issued: ctx.day(-5), due: ctx.day(25), lines: [{ itemId: it.carreau, label: NAMES.carreau, quantity: 80, price: 12000 }, { itemId: it.peinture, label: NAMES.peinture, quantity: 12, price: P.peinture }] });
  if (qHotel) C.quotes.push(qHotel);
  C.quoteHotel = qHotel; // code promo appliqué dans le groupe marketing, puis envoyé
  const qDel = await q('Devis : brouillon pour un particulier', { customerId: cu.particulier, lines: [{ label: NAMES.ciment, quantity: 10, price: P.ciment }] });
  if (qDel) await ctx.do('Devis : supprimer un brouillon abandonné', 'DELETE', `/crm/documents/${qDel}`, undefined, { as: 'manager' });

  // ---------- Listes, impression, PDF, lien de partage ----------
  const list = await ctx.do('Ventes : liste des factures et indicateurs (dû, en retard, facturé du mois)', 'GET', '/crm/documents?kind=invoice', undefined, { as: 'manager' });
  ctx.check('Ventes : factures en retard présentes (Commune, Quincaillerie)', list.summary && list.summary.overdueCount >= 2 && list.summary.owed > 0, list.summary);
  await ctx.do('Ventes : liste des devis', 'GET', '/crm/documents?kind=quote', undefined, { as: 'manager' });
  await ctx.do('Ventes : liste des avoirs', 'GET', '/crm/documents?kind=credit', undefined, { as: 'manager' });
  C.numbers = Object.fromEntries((list.documents || []).map((d) => [d.id, d.number]));
  const first = docs[0] && docs[0].id;
  if (first) {
    const p = await ctx.do('Ventes : page imprimable de la facture', 'GET', `/crm/documents/${first}/print`, undefined, { as: 'manager' });
    ctx.check('Impression : NIU, TVA et mentions de paiement présents', p.org && p.org.niu === settings.niu && p.totals && p.totals.vatRate === VAT && (p.payments || []).length >= 1, p.totals);
    const pdf = await ctx.do('Ventes : télécharger la facture en PDF', 'GET', `/share/pdf/invoice/${first}`, undefined, { as: 'manager', raw: true });
    ctx.check('PDF : fichier PDF valide', pdf.buf && pdf.buf.slice(0, 4).toString() === '%PDF', pdf.status);
    const sh = await ctx.do('Ventes : lien de partage WhatsApp prêt (envoi manuel)', 'GET', `/crm/documents/${first}/share`, undefined, { as: 'manager' });
    ctx.check('Partage : lien wa.me avec le message de la facture', /^https:\/\/wa\.me\/237/.test(sh.url || ''), sh);
  }
  if (C.credits[0]) await ctx.do("Avoirs : page imprimable de l'avoir", 'GET', `/crm/documents/${C.credits[0]}/print`, undefined, { as: 'manager' });
  if (qImmo) await ctx.do('Devis : page imprimable', 'GET', `/crm/documents/${qImmo}/print`, undefined, { as: 'manager' });
  const all = await ctx.do('Clients : liste avec encours et nombre de factures', 'GET', '/crm/customers', undefined, { as: 'manager' });
  ctx.check('Clients : encours de la Commune de Douala 5e', ((all.customers || []).find((c) => c.id === cu.mairie) || {}).owed > 0, (all.customers || []).map((c) => [c.name, c.owed]));
  const pay = Object.values(docs).find((d) => d.cust === 'immo');
  if (pay) await ctx.do('Encaissements : historique des paiements (acompte + solde)', 'GET', `/crm/documents/${pay.id}/payments`, undefined, { as: 'manager' });
  C.overdue = Object.values(docs).filter((d) => ['mairie', 'quinc'].includes(d.cust) && d.day <= -43 && d.day >= -82).map((d) => d.id);
};
