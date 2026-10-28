'use strict';
// Critères de passation à un humain selon le type d'entreprise. Le numéro du client est connu (WhatsApp) : l'IA ne passe la main pour une vente que
// lorsque la fiche est complète, sinon elle demande ce qui manque, UNE question à la fois. Les cas urgents (réclamation, prix sous le minimum, panne d'IA)
// passent toujours tout de suite.
//  - order    : magasin, commerce (marchandises)  -> bon de commande : nom, ville, commande, prix, date de livraison, lieu de livraison
//  - service  : prestataire (garage, chantier, soin…) -> demande de service : nom, ville, service voulu, prix ou budget, date, lieu
//  - prospect : établissement (université, école, formation) -> fiche prospect : nom, ville, programme ou besoin
// Un rendez-vous demandé s'ajoute à n'importe quel type : il exige le nom, le jour et l'heure, et le message à l'humain commence par « RENDEZ-VOUS ».
const { db } = require('../db');
const L = require('./sales-assign');

const KINDS = ['order', 'service', 'prospect'];
const TITLE = { order: 'BON DE COMMANDE', service: 'DEMANDE DE SERVICE', prospect: 'NOUVEAU PROSPECT', appointment: 'RENDEZ-VOUS' };
const PROSPECT_RE = /universit|école|ecole|institut|collège|college|lycée|lycee|formation|académie|academie|faculté|faculte|campus|études|etudes|enseignement/i;
const MAX_ASKS = 4; // après 4 relances sans réponse complète, on passe quand même la main en indiquant ce qui manque

async function kindOf(org) {
  if (KINDS.includes(org.handoff_kind)) return org.handoff_kind;
  if (PROSPECT_RE.test(`${org.sector || ''} ${org.name || ''}`)) return 'prospect';
  const n = Number((await db.prepare('SELECT COUNT(*) c FROM catalog WHERE org_id = ?').get(org.id) || {}).c || 0);
  return n > 0 ? 'order' : 'service';
}

const WHAT = { name: 'votre nom', city: 'votre ville', items: 'les articles que vous souhaitez', need: 'le service ou le programme qui vous intéresse', price: 'votre budget', date: 'la date souhaitée', place: "le lieu (adresse ou quartier)", time: "l'heure du rendez-vous" };
const ASK = {
  name: "Pour finaliser, quel est votre nom complet ?", city: 'Dans quelle ville vous trouvez-vous ?',
  items: 'Quels articles souhaitez-vous commander ?', need: 'Quel service ou quel programme vous intéresse exactement ?',
  price: 'Quel budget avez-vous prévu ?', date: 'Pour quelle date le souhaitez-vous ?', place: "À quelle adresse ou dans quel quartier ?", time: 'À quelle heure vous convient-il ?',
};

/** Ce que la fiche contient déjà. Renvoie { kind, intent, missing: [clés], have: {...} }. */
async function status(org, chat) {
  const kind = await kindOf(org);
  const lead = L.cleanLead(JSON.parse(chat.lead || '{}'));
  const cu = chat.customer_id ? await db.prepare('SELECT name, phone FROM customers WHERE id = ?').get(chat.customer_id) : null;
  const order = await db.prepare("SELECT number, total, lines FROM documents WHERE org_id = ? AND chat_id = ? AND kind = 'order' ORDER BY id DESC LIMIT 1").get(org.id, chat.id);
  const appt = await db.prepare("SELECT date, time, purpose FROM appointments WHERE org_id = ? AND chat_id = ? ORDER BY id DESC LIMIT 1").get(org.id, chat.id);
  const named = cu && cu.name && !/^(visiteur|client)/i.test(cu.name);
  const have = { name: named ? cu.name : '', phone: (cu && cu.phone) || (chat.channel === 'whatsapp' ? chat.contact : ''), city: lead.city || '', need: lead.need || '', date: lead.deadline || '', place: lead.place || '', budget: lead.budget || '', order, appt };
  const intent = lead.intent || (appt ? 'rendez-vous' : order ? 'commande' : '');
  const missing = [];
  if (!have.name) missing.push('name');
  if (intent === 'rendez-vous') { if (!appt) missing.push('date', 'time'); } // un rendez-vous n'exige que le nom, le jour et l'heure
  else if (intent === 'commande' || (intent !== 'rendez-vous' && kind === 'order')) {
    if (!have.city) missing.push('city');
    if (!order && !have.need) missing.push('items'); // la commande enregistrée donne articles et prix
    if (!have.date) missing.push('date');
    if (!have.place) missing.push('place');
  } else if (kind === 'service' || intent === 'service') {
    if (!have.city) missing.push('city');
    if (!have.need) missing.push('need');
    if (!have.budget && !order) missing.push('price');
    if (!have.date) missing.push('date');
    if (!have.place) missing.push('place');
  } else {
    if (!have.city) missing.push('city');
    if (!have.need) missing.push('need');
  }
  return { kind, intent: intent || (kind === 'order' ? 'commande' : kind === 'service' ? 'service' : 'prospect'), missing: [...new Set(missing)], have, asks: lead.asks || 0 };
}

/** Titre du message envoyé à l'humain : RENDEZ-VOUS, BON DE COMMANDE, DEMANDE DE SERVICE ou NOUVEAU PROSPECT. */
const titleOf = (st) => (st.intent === 'rendez-vous' ? TITLE.appointment : st.intent === 'commande' ? TITLE.order : st.intent === 'service' ? TITLE.service : st.intent === 'prospect' ? TITLE.prospect : TITLE[st.kind]);

/** Lignes de détail du message envoyé à l'humain (uniquement ce qui est connu ; rien d'inventé). */
function detailLines(st, org) {
  const h = st.have; const out = [];
  const money = (n) => `${Number(n).toLocaleString('fr-FR')} ${org.currency}`.replace(/[\u00a0\u202f]/g, ' ');
  if (h.city) out.push(`Ville : ${h.city}`);
  if (h.appt) out.push(`Rendez-vous : ${h.appt.date} à ${h.appt.time}${h.appt.purpose ? ` (${h.appt.purpose})` : ''}`);
  if (h.order) { let labels = ''; try { labels = JSON.parse(h.order.lines).map((l) => `${l.label} × ${l.quantity}`).join(', '); } catch (e) { /* ligne illisible */ } out.push(`Bon de commande ${h.order.number} : ${labels}`, `Prix : ${money(h.order.total)}`); }
  else if (h.need) out.push(`${st.kind === 'prospect' ? 'Programme ou besoin' : 'Besoin'} : ${h.need}`);
  if (!h.order && h.budget) out.push(`Budget : ${h.budget}`);
  if (h.date && st.intent !== 'rendez-vous') out.push(`${st.intent === 'commande' ? 'Livraison le' : 'Date souhaitée'} : ${h.date}`);
  if (h.place) out.push(`Lieu : ${h.place}`);
  if (st.missing.length) out.push(`Informations non reçues : ${st.missing.map((k) => WHAT[k]).join(', ')}`);
  return out;
}

/** Texte à ajouter à la réponse du client pour obtenir l'information suivante. */
const askFor = (st) => (st.missing.length ? ASK[st.missing[0]] : '');
/** Passe la main quand la fiche est complète, ou après trop de relances. */
const ready = (st) => !st.missing.length || st.asks >= MAX_ASKS;

module.exports = { kindOf, status, titleOf, detailLines, askFor, ready, KINDS, MAX_ASKS };
