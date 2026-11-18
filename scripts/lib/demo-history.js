'use strict';
// Données d'essai du module « Histoire de l'entreprise » (organigramme sur 15 ans, frise avec moments forts et durs, une rencontre, deux images).
// Utilisé par scripts/demo-local.js. N'appelle que le serveur local.
const zlib = require('zlib');

function crc32(buf) {
  let c; let crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; }
  return (crc ^ 0xffffffff) >>> 0;
}
/** PNG uni (couleur RGB) de w × h pixels — vraie image, lisible par un navigateur. */
function png(w, h, rgb) {
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body)); return Buffer.concat([len, body, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => rgb).flat())]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

async function seedHistory({ base, cookie, orgId, log = console.log }) {
  const H = `/api/ws/orgs/${orgId}/history`;
  const call = async (method, path, body) => {
    const r = await fetch(base + H + path, { method, headers: { cookie, ...(body && !Buffer.isBuffer(body) ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : (Buffer.isBuffer(body) ? body : JSON.stringify(body)) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`${method} ${path} : ${r.status} ${j.error || ''}`);
    return j;
  };
  const P = async (b) => (await call('POST', '/people', b)).id;
  const fond = await P({ name: 'Jean-Pierre Nkoulou', title: 'Fondateur', level: 0, startDate: '2009-03-01' });
  const dg = await P({ name: 'Sylvie Mbarga', title: 'Directrice générale', level: 1, parentId: fond, startDate: '2011-01-10' });
  const dt = await P({ name: 'Paul Etoga', title: 'Directeur technique', level: 2, parentId: dg, startDate: '2012-06-01', endDate: '2019-12-31', departureReason: 'Départ à la retraite' });
  const dc = await P({ name: 'Zoé Manga', title: 'Directrice commerciale', level: 2, parentId: dg, startDate: '2013-09-01' });
  const daf = await P({ name: 'Awa Tchamba', title: 'Responsable administrative et financière', level: 3, parentId: dg, startDate: '2014-02-01' });
  const atelier = await P({ name: 'Paul Essomba', title: "Chef d'atelier", level: 3, parentId: dt, startDate: '2014-05-01' });
  const menu1 = await P({ name: 'Éric Ndongo', title: 'Menuisier', level: 5, parentId: atelier, startDate: '2016-09-01' });
  const menu2 = await P({ name: 'Joseph Biyiha', title: 'Menuisier', level: 5, parentId: atelier, startDate: '2015-01-15', endDate: '2018-06-30', departureReason: 'Création de son propre atelier' });
  const vend = await P({ name: 'Carine Fotso', title: 'Commerciale', level: 4, parentId: dc, startDate: '2018-03-01' });
  await P({ name: 'Rose Tchoua', title: 'Comptable', level: 5, parentId: daf, startDate: '2019-04-01' });
  await P({ name: 'Marie Kamdem', title: 'Apprentie', level: 6, parentId: atelier, startDate: '2022-10-03' });
  const E = async (b) => (await call('POST', '/events', b)).id;
  const e1 = await E({ title: "Création de l'atelier", date: '2009-03-01', category: 'creation', nature: 'good', place: 'Douala, Bonabéri', description: "Jean-Pierre ouvre l'atelier avec deux établis et un seul client.", successFactors: 'Un travail soigné et le bouche-à-oreille des premiers clients.', peopleIds: [fond] });
  await E({ title: 'Premier recrutement', date: '2011-01-10', category: 'recruitment', nature: 'good', description: 'Sylvie rejoint l’atelier pour structurer la gestion.', successFactors: 'Une personne de confiance qui complète le fondateur.', peopleIds: [fond, dg] });
  await E({ title: 'Déménagement dans le nouvel atelier', date: '2013-04-15', category: 'move', nature: 'good', place: 'Douala, Zone industrielle', description: "Trois fois plus d'espace et une machine à bois neuve.", peopleIds: [fond, dg] });
  await E({ title: 'Incendie du dépôt de bois', date: '2015-11-20', category: 'incident', nature: 'bad', place: 'Douala', description: "Un court-circuit détruit le stock de bois et deux machines. Personne n'est blessé.", lesson: 'Assurer les stocks, installer des extincteurs et former l’équipe aux gestes de sécurité.', peopleIds: [fond, atelier] });
  await E({ title: 'Grand contrat avec la mairie', date: '2016-05-10', category: 'contract', nature: 'good', description: 'Mobilier de trois écoles : 600 tables et bancs.', successFactors: 'Devis très précis et livraison avant la rentrée.', peopleIds: [dg, dc] });
  const rv = await E({ title: 'Rencontre avec la Scierie du Centre', date: '2016-09-02', category: 'meeting', nature: 'good', place: 'Yaoundé', description: 'Premier rendez-vous avec notre futur fournisseur de bois.', minutes: 'Accord sur un tarif annuel et une livraison mensuelle. Prochaine rencontre en janvier.', guests: [{ name: 'M. Ondoa', org: 'Scierie du Centre', role: 'Directeur' }], peopleIds: [dg, atelier] });
  await E({ title: 'Départ de Joseph, notre meilleur menuisier', date: '2018-06-30', category: 'departure', nature: 'bad', description: 'Joseph ouvre son propre atelier et emmène deux clients.', lesson: 'Proposer des responsabilités et une part des résultats à ceux qui comptent.', peopleIds: [menu2] });
  await E({ title: 'Crise de trésorerie', date: '2019-03-15', category: 'financial', nature: 'bad', description: "Trois gros clients paient avec cinq mois de retard : l'atelier ne peut plus acheter son bois.", lesson: 'Garder trois mois de réserve et exiger un acompte de 30 % à la commande.', peopleIds: [dg, daf] });
  await E({ title: 'Retraite de Paul Etoga', date: '2019-12-31', category: 'departure', nature: 'good', description: 'Après sept ans à la direction technique, Paul transmet son savoir à Paul Essomba.', successFactors: 'Une passation préparée pendant un an.', peopleIds: [dt, atelier] });
  await E({ title: 'Perte de notre plus gros client', date: '2020-04-20', category: 'loss', nature: 'bad', description: 'La pandémie arrête tous les chantiers : 60 % du chiffre d’affaires disparaît en un mois.', lesson: 'Ne jamais dépendre d’un seul secteur : développer les particuliers.', visibility: 'internal', peopleIds: [fond, dg, dc] });
  await E({ title: 'Prix régional de l’artisanat', date: '2021-10-10', category: 'award', nature: 'good', place: 'Yaoundé', description: 'Le jury récompense la qualité du mobilier scolaire.', successFactors: "L'équipe a refait tout le lot défectueux à ses frais.", peopleIds: [fond, atelier, menu1] });
  await E({ title: 'Lancement de la gamme « Maison »', date: '2023-02-14', category: 'launch', nature: 'good', description: 'Premiers meubles pour particuliers, vendus en ligne et sur WhatsApp.', successFactors: 'Des photos soignées et des délais tenus.', peopleIds: [dc, vend] });
  await E({ title: 'Formation à la sécurité au travail', date: '2024-06-05', category: 'training', nature: 'good', description: 'Toute l’équipe suit deux jours de formation.', peopleIds: [atelier, menu1] });
  const up = (name, color, params) => fetch(`${base}${H}/media?name=${name}&${params}`, { method: 'POST', headers: { cookie, 'content-type': 'application/octet-stream' }, body: png(320, 220, color) }).then((r) => r.json());
  await up('atelier-2009.png', [196, 140, 80], `eventId=${e1}&caption=${encodeURIComponent("L'atelier à l'ouverture")}&takenOn=2009-03-02`);
  await up('rencontre.png', [90, 140, 120], `eventId=${rv}&caption=${encodeURIComponent('Rencontre à Yaoundé')}&hasPeople=1&consent=1`);
  await up('portrait-fondateur.png', [120, 110, 200], `personId=${fond}&avatar=1&consent=1`);
  log('Histoire de l’entreprise : 11 personnes, 13 événements et 3 images ajoutés.');
}
module.exports = { seedHistory };
