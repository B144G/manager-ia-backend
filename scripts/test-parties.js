'use strict';
// Clients et fournisseurs typés (simple, temporaire, permanent, haut de gamme) : extension des tables existantes, fiches, recherche, filtres,
// changement de type avec historique, conditions propres au type et leur report dans la facturation / les achats, import et export CSV,
// liens avec Commercial / Achats / Trésorerie sans duplication, rôles, cloisonnement entre entreprises.
// Lancez-le avec : node scripts/test-parties.js
const { run } = require('./lib/wave1');

const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

run('Clients et fournisseurs typés : fiches, types, historique, conditions, CSV, liens', async ({ check, owner, mgr, mem, other, org, org2, ws, O, dbx }) => {
  const P = `${O}/parties`;
  let r;

  // ---------- Types et conditions ----------
  r = await mem('GET', `${P}/types`);
  check('types : simple, temporaire, permanent, haut de gamme', r.status === 200 && r.json.types.join() === 'simple,temporary,permanent,vip' && r.json.counts.customers && !r.json.counts.suppliers, r.json);
  r = await mem('PUT', `${P}/terms/customers/vip`, { discountPct: 10 }); check('conditions d\'un type : réservées aux responsables', r.status === 403, r.status);
  r = await mgr('PUT', `${P}/terms/customers/vip`, { discountPct: 150 }); check('remise > 100 % refusée', r.status === 400, r.json);
  r = await mgr('PUT', `${P}/terms/customers/vip`, { discountPct: 10, paymentDays: 45, deliveryDays: 1, creditLimit: 5000000, note: 'Livraison prioritaire' });
  check('conditions du type haut de gamme enregistrées', r.status === 200 && r.json.terms.vip.discountPct === 10 && r.json.terms.vip.paymentDays === 45, r.json);
  await mgr('PUT', `${P}/terms/customers/permanent`, { discountPct: 5, paymentDays: 30 });
  await mgr('PUT', `${P}/terms/suppliers/vip`, { paymentDays: 60, discountPct: 3 });

  // ---------- Clients : création par type ----------
  const mk = async (c, b) => c('POST', `${P}/customers`, b);
  r = await mk(mem, { name: 'Boutique Simple', phone: '690000001', email: 'simple@ex.com', city: 'Douala', tags: 'Quartier, Akwa ,quartier' });
  const C1 = r.json.id; check('client simple créé par un membre', r.status === 201 && C1, r.json);
  r = await mk(mem, { name: 'Boutique Simple' }); check('doublon de nom refusé', r.status === 409, r.json);
  r = await mk(mem, { name: 'Salon Temp', type: 'temporary' }); check('temporaire sans date de fin refusé', r.status === 400, r.json);
  r = await mk(mem, { name: 'Salon Temp', type: 'temporary', validUntil: day(30), phone: '690000002', lat: 4.05, lng: 9.7, geoSource: 'pin' }); const C2 = r.json.id;
  check('client temporaire avec date de fin et position GPS', r.status === 201, r.json);
  r = await mk(mem, { name: 'Hôtel Perm', type: 'permanent', discountPct: 7, address: 'Bonanjo' }); const C3 = r.json.id;
  r = await mk(mem, { name: 'Cabinet VIP', type: 'vip', phone: '690000004' }); const C4 = r.json.id;
  r = await mk(mem, { name: 'Mauvais', email: 'pas-un-mail' }); check('e-mail invalide refusé', r.status === 400, r.json);
  r = await mk(mem, { name: 'Mauvais', type: 'gold' }); check('type inconnu refusé', r.status === 400, r.json);

  // ---------- Liste, recherche, filtres ----------
  r = await mem('GET', `${P}/customers`);
  check('liste : 4 clients, dernier ajouté inclus', r.status === 200 && r.json.total === 4 && r.json.items.some((x) => x.name === 'Cabinet VIP'), r.json.total);
  check('étiquettes nettoyées et dédoublonnées', r.json.items.find((x) => x.id === C1).tags.join() === 'quartier,akwa', r.json.items.find((x) => x.id === C1).tags);
  r = await mem('GET', `${P}/customers?type=vip`); check('filtre par type : VIP', r.json.total === 1 && r.json.items[0].id === C4, r.json);
  r = await mem('GET', `${P}/customers?q=bonanjo`); check('recherche sur l\'adresse', r.json.total === 1 && r.json.items[0].id === C3, r.json);
  r = await mem('GET', `${P}/customers?q=690000002`); check('recherche sur le téléphone', r.json.total === 1 && r.json.items[0].id === C2, r.json);
  r = await mem('GET', `${P}/customers?tag=akwa`); check('filtre par étiquette', r.json.total === 1 && r.json.items[0].id === C1, r.json);
  r = await mem('GET', `${P}/customers?located=1`); check('filtre « localisés » (adresse géolocalisable)', r.json.total === 1 && r.json.items[0].location.lat === 4.05, r.json);
  r = await mem('GET', `${P}/customers?type=nimporte`); check('filtre de type inconnu refusé', r.status === 400, r.status);
  r = await mem('GET', `${P}/customers?q=%25`); check('recherche : caractères joker neutralisés', r.status === 200 && r.json.total === 0, r.json.total);

  // ---------- Fiche, conditions effectives ----------
  r = await mem('GET', `${P}/customers/${C4}`);
  const p4 = r.json.party;
  check('fiche VIP : conditions du type (remise 10 %, 45 jours, plafond) héritées', p4.type === 'vip' && p4.terms.discountPct.value === 10 && p4.terms.discountPct.from === 'type' && p4.terms.paymentDays.value === 45 && p4.terms.creditLimit.value === 5000000, p4.terms);
  r = await mem('GET', `${P}/customers/${C3}`);
  check('fiche permanent : la remise propre (7 %) l\'emporte sur celle du type (5 %)', r.json.party.terms.discountPct.value === 7 && r.json.party.terms.discountPct.from === 'own' && r.json.party.terms.paymentDays.value === 30, r.json.party.terms);
  r = await mem('GET', `${P}/customers/${C1}`);
  check('fiche simple : aucune condition inventée (null)', r.json.party.terms.discountPct.value === null && r.json.party.terms.paymentDays.from === null, r.json.party.terms);
  check('fiche : liens Clients et ventes, Commercial, Transport (sans duplication)', r.json.party.links.crm.invoices === 0 && r.json.party.links.commercial.contacts === 0 && r.json.party.links.transport.deliveries === 0, r.json.party.links);

  // ---------- Modification ----------
  r = await mem('PUT', `${P}/customers/${C1}`, { phone: '699999999', notes: 'Paye comptant', status: 'inactive' });
  check('modification de la fiche (téléphone, notes, statut)', r.status === 200, r.json);
  r = await mem('GET', `${P}/customers/${C1}`); check('modifications visibles dans la fiche ET dans le CRM existant', r.json.party.phone === '699999999' && r.json.party.status === 'inactive' && (await mem('GET', `${O}/crm/customers`)).json.customers.find((x) => x.id === C1).phone === '699999999');
  r = await mem('PUT', `${P}/customers/${C1}`, { type: 'permanent' }); check('un membre ne change pas le type', r.status === 403, r.status);
  r = await mem('GET', `${P}/customers`); check('liste : les inactifs restent visibles, les archivés sont masqués', r.json.total === 4);
  await mem('PUT', `${P}/customers/${C1}`, { status: 'archived' });
  r = await mem('GET', `${P}/customers`); check('client archivé masqué de la liste par défaut', r.json.total === 3);
  r = await mem('GET', `${P}/customers?status=archived`); check('… et retrouvé par le filtre « archivés »', r.json.total === 1);
  await mem('PUT', `${P}/customers/${C1}`, { status: 'active' });

  // ---------- Changement de type avec historique ----------
  r = await mem('POST', `${P}/customers/${C1}/type`, { type: 'vip' }); check('changement de type : réservé aux responsables', r.status === 403, r.status);
  r = await mgr('POST', `${P}/customers/${C1}/type`, { type: 'temporary' }); check('vers temporaire : date de fin obligatoire', r.status === 400, r.json);
  r = await mgr('POST', `${P}/customers/${C1}/type`, { type: 'temporary', validUntil: day(-1) }); check('date de fin passée refusée', r.status === 400, r.json);
  r = await mgr('POST', `${P}/customers/${C1}/type`, { type: 'simple' }); check('même type : refusé', r.status === 400, r.json);
  r = await mgr('POST', `${P}/customers/${C1}/type`, { type: 'permanent', reason: 'Contrat annuel signé' }); check('simple → permanent', r.status === 200, r.json);
  r = await mgr('POST', `${P}/customers/${C1}/type`, { type: 'vip', reason: 'Gros volume' });
  r = await mgr('GET', `${P}/customers/${C1}`);
  const h = r.json.party.history;
  check('historique : création, puis permanent, puis VIP (du plus récent au plus ancien) avec motif et auteur', h.length === 3 && h[0].to === 'vip' && h[0].from === 'permanent' && h[0].reason === 'Gros volume' && h[0].author === 'Marc' && h[1].to === 'permanent' && h[2].reason === 'Création', h);
  check('fiche : conditions VIP après changement de type', r.json.party.terms.discountPct.value === 10, r.json.party.terms);

  // ---------- Temporaires expirés ----------
  await dbx.prepare('UPDATE customers SET valid_until = ? WHERE id = ?').run(day(-2), C2);
  r = await mem('GET', `${P}/customers?expired=1`); check('filtre « expirés » : temporaire dont la date de fin est passée', r.json.total === 1 && r.json.items[0].id === C2 && r.json.items[0].expired === true, r.json);
  r = await mem('POST', `${P}/customers/revert-expired`, {}); check('retour automatique réservé aux responsables', r.status === 403, r.status);
  r = await mgr('POST', `${P}/customers/revert-expired`, {}); check('temporaires expirés ramenés à « simple »', r.status === 200 && r.json.reverted === 1, r.json);
  r = await mgr('GET', `${P}/customers/${C2}`); check('… avec trace dans l\'historique', r.json.party.type === 'simple' && r.json.party.validUntil === null && r.json.party.history[0].reason === 'Fin de validité atteinte', r.json.party);

  // ---------- Position géographique ----------
  r = await mem('POST', `${P}/customers/${C3}/location`, { lat: 4.04, lng: 9.69, source: 'pin', address: 'Bonanjo, rue 1' });
  check('adresse géolocalisable : point posé sur la carte', r.status === 200, r.json);
  r = await mem('POST', `${P}/customers/${C3}/location`, { lat: 4.04, lng: 999 }); check('longitude invalide refusée', r.status === 400, r.json);
  r = await mem('GET', `${P}/customers/${C3}`); check('position et adresse enregistrées', r.json.party.location.lat === 4.04 && r.json.party.location.source === 'pin' && r.json.party.address === 'Bonanjo, rue 1', r.json.party);

  // ---------- Notes ----------
  r = await mem('POST', `${P}/customers/${C3}/notes`, { body: 'Rappeler en janvier' }); check('note datée ajoutée', r.status === 201, r.json);
  r = await mem('POST', `${P}/customers/${C3}/notes`, { body: '   ' }); check('note vide refusée', r.status === 400, r.json);
  r = await mem('GET', `${P}/customers/${C3}`); check('notes listées avec leur auteur', r.json.party.notes.length === 1 && r.json.party.notes[0].author === 'Paul', r.json.party.notes);

  // ---------- Application des conditions : facturation (remise par défaut) ----------
  r = await mgr('POST', `${P}/customers/${C4}/apply-terms`, {}); check('conditions du VIP reportées dans la remise par défaut de la facturation', r.status === 200 && r.json.applied.defaultDiscount === 10, r.json);
  check('la remise par défaut du client (table existante) vaut 10', Number((await dbx.prepare('SELECT default_discount FROM customers WHERE id = ?').get(C4)).default_discount) === 10);
  r = await mgr('GET', `${O}/crm/customers/${C4}`); check('fiche CRM : remise par défaut 10', r.json.customer.defaultDiscount === 10, r.json.customer);
  r = await mgr('POST', `${P}/customers/${C2}/apply-terms`, {}); check('aucune condition à appliquer : message clair', r.status === 400, r.json);

  // ---------- Fournisseurs ----------
  r = await mem('GET', `${P}/suppliers`); check('fournisseurs : réservés aux responsables (comme Achats)', r.status === 403, r.status);
  r = await mgr('POST', `${P}/suppliers`, { name: 'Brasseries du Cameroun', type: 'permanent', contactPerson: 'M. Eto', phone: '699000111', taxId: 'M0123', category: 'Boissons', paymentDays: 30 }); const S1 = r.json.id;
  check('fournisseur permanent créé', r.status === 201, r.json);
  r = await mgr('POST', `${P}/suppliers`, { name: 'Marché de Mboppi', type: 'temporary', validUntil: day(10), city: 'Douala' }); const S2 = r.json.id;
  r = await mgr('POST', `${P}/suppliers`, { name: 'Importateur VIP', type: 'vip', lat: 4.03, lng: 9.71 }); const S3 = r.json.id;
  r = await mgr('POST', `${P}/suppliers`, { name: 'Simple SARL' }); const S4 = r.json.id;
  r = await mgr('GET', `${P}/suppliers?type=vip`); check('fournisseurs : filtre par type', r.json.total === 1 && r.json.items[0].id === S3 && r.json.items[0].location.lng === 9.71, r.json);
  r = await mgr('GET', `${P}/suppliers?q=eto`); check('fournisseurs : recherche par personne à contacter', r.json.total === 1 && r.json.items[0].id === S1, r.json);
  check('les fournisseurs créés ici apparaissent dans le module Achats existant', (await mgr('GET', `${O}/purchasing/suppliers`)).json.suppliers.some((x) => x.id === S1 && x.paymentDays === 30));
  r = await mgr('GET', `${P}/suppliers/${S3}`); check('fiche fournisseur VIP : délai de paiement et remise du type', r.json.party.terms.paymentDays.value === 60 && r.json.party.terms.discountPct.value === 3, r.json.party.terms);
  r = await mgr('POST', `${P}/suppliers/${S3}/apply-terms`, {}); check('délai de paiement reporté dans Achats (suppliers.payment_days)', r.status === 200 && Number((await dbx.prepare('SELECT payment_days FROM suppliers WHERE id = ?').get(S3)).payment_days) === 60, r.json);
  await dbx.prepare('INSERT INTO tre_terms (org_id, supplier_id, discount_pct, discount_days, priority) VALUES (?, ?, 2, 10, 1)').run(org, S1);
  r = await mgr('GET', `${P}/suppliers/${S1}`); check('fiche fournisseur : conditions de Trésorerie lues, non dupliquées', r.json.party.links.treasury.discountPct === 2 && r.json.party.links.treasury.discountDays === 10 && r.json.party.links.purchasing.orders === 0, r.json.party.links);
  r = await mgr('POST', `${P}/suppliers/${S4}/type`, { type: 'vip', reason: 'Meilleur prix' }); check('fournisseur : changement de type', r.status === 200, r.json);
  r = await mgr('PUT', `${P}/suppliers/${S4}`, { status: 'blocked' }); check('fournisseur bloqué (champ existant « blocked »)', r.status === 200 && Number((await dbx.prepare('SELECT blocked FROM suppliers WHERE id = ?').get(S4)).blocked) === 1, r.json);
  r = await mgr('GET', `${P}/suppliers?status=blocked`); check('filtre « bloqués »', r.json.total === 1 && r.json.items[0].status === 'blocked', r.json);
  r = await mgr('GET', `${P}/types`); check('compteurs par type (clients et fournisseurs)', r.json.counts.customers.vip === 2 && r.json.counts.suppliers.vip === 2 && r.json.counts.suppliers.permanent === 1, r.json.counts);

  // ---------- Export CSV ----------
  r = await mem('GET', `${P}/customers/export.csv`); check('export CSV réservé aux responsables', r.status === 403, r.status);
  r = await mgr('GET', `${P}/customers/export.csv`);
  const lines = r.text.replace(/^﻿/, '').split(/\r\n/).filter(Boolean);
  check('export CSV : en-têtes et une ligne par client, type en clair', r.status === 200 && r.headers.get('content-type').includes('text/csv') && lines[0].startsWith('Nom;Type;Fin de validité;Statut') && lines.length === 5 && lines.some((l) => l.startsWith('Cabinet VIP;vip')), lines);
  await mgr('PUT', `${P}/customers/${C4}`, { notes: '=HYPERLINK("http://x","clic")' });
  r = await mgr('GET', `${P}/customers/export.csv`);
  check('export CSV : cellule commençant par « = » neutralisée (injection de formule)', r.text.includes("\"'=HYPERLINK") || r.text.includes("'=HYPERLINK"), r.text.slice(-300));

  // ---------- Import CSV ----------
  const csv = [
    'Nom;Type;Fin de validité;Statut;Téléphone;E-mail;Ville;Étiquettes;Latitude;Longitude;Remise %',
    'Nouveau Client;vip;;actif;690111222;nc@ex.com;Yaoundé;grossiste;3,86;11,52;12',
    `Client Provisoire;temporaire;${day(20)};actif;690333444;;Douala;;;;`,
    'Cabinet VIP;permanent;;actif;690000004;;;;;;',
    'Sans Date;temporaire;;;690;;;;;;',
    'Mail Faux;simple;;;;faux;;;;;',
    'Nouveau Client;simple;;;;;;;;;',
    ';simple;;;;;;;;;',
  ].join('\n');
  r = await mgr('POST', `${P}/customers/import`, { csv, dryRun: true });
  check('import (simulation) : 2 créations, 1 mise à jour, 4 lignes refusées avec leur numéro', r.status === 200 && r.json.dryRun === true && r.json.created === 2 && r.json.updated === 1 && r.json.skipped === 4 && r.json.errors.map((e) => e.line).join() === '5,6,7,8', r.json);
  check('import (simulation) : rien n\'est écrit', (await mgr('GET', `${P}/customers?q=nouveau`)).json.total === 0);
  r = await mem('POST', `${P}/customers/import`, { csv }); check('import réservé aux responsables', r.status === 403, r.status);
  r = await mgr('POST', `${P}/customers/import`, { csv });
  check('import : clients créés et fiche existante mise à jour', r.status === 201 && r.json.created === 2 && r.json.updated === 1, r.json);
  r = await mgr('GET', `${P}/customers?q=nouveau`);
  const nc = r.json.items[0];
  check('import : type, position (virgule décimale), remise propre, étiquette lus', nc.type === 'vip' && nc.location.lat === 3.86 && nc.location.lng === 11.52 && nc.own.discountPct === 12 && nc.tags[0] === 'grossiste', nc);
  r = await mgr('GET', `${P}/customers/${C4}`); check('import : « Cabinet VIP » passé permanent, avec historique « Import CSV »', r.json.party.type === 'permanent' && r.json.party.history[0].reason === 'Import CSV', r.json.party.history[0]);
  r = await mgr('POST', `${P}/customers/import`, { csv: 'Téléphone\n690' }); check('import : colonne « Nom » obligatoire', r.status === 400, r.json);
  r = await mgr('POST', `${P}/suppliers/import`, { csv: 'Nom,Type,Contact\nFournisseur CSV,permanent,Mme Eyenga' });
  check('import de fournisseurs (séparateur virgule)', r.status === 201 && r.json.created === 1, r.json);
  r = await mgr('GET', `${O}/purchasing/suppliers/${(await mgr('GET', `${P}/suppliers?q=csv`)).json.items[0].id}`); check('… visible dans Achats', r.json.supplier.contactPerson === 'Mme Eyenga', r.json.supplier);

  // ---------- Cloisonnement ----------
  r = await other('GET', `${P}/customers`); check('autre entreprise : pas d\'accès (404)', r.status === 404, r.status);
  r = await other('GET', `${ws(org2)}/parties/customers`); check('autre entreprise : liste vide, jamais nos clients', r.status === 200 && r.json.total === 0, r.json);
  r = await other('GET', `${ws(org2)}/parties/customers/${C1}`); check('fiche d\'un client d\'une autre entreprise : 404', r.status === 404, r.status);
  r = await other('PUT', `${ws(org2)}/parties/suppliers/${S1}`, { name: 'Piraté' }); check('modification inter-entreprises impossible', [403, 404].includes(r.status), r.status);
  r = await mgr('GET', `${P}/clients`); check('type de liste inconnu : 404', r.status === 404, r.status);
}, {});
