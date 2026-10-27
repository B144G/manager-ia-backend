'use strict';
// Fiche prospect (qualification) et attribution d'une conversation à un commercial de l'équipe.
const { db, nowISO } = require('../db');
const A = require('./access');
const { mailUser } = require('../services/notify');
const { oneLine, cleanText } = require('../util');

const TEMPS = ['chaud', 'tiede', 'froid'];
const TEMP_LABEL = { chaud: 'Prospect chaud (prêt à acheter)', tiede: 'Prospect tiède (il compare ou hésite)', froid: 'Prospect froid (il se renseigne)' };
const FIELDS = [['need', 'Besoin'], ['quantity', 'Quantité'], ['deadline', 'Pour quand'], ['place', 'Lieu ou livraison'], ['budget', 'Budget']];

/** Nettoie ce que l'IA a compris : seulement des textes courts et une température connue. */
function cleanLead(l) {
  const out = {};
  if (!l || typeof l !== 'object') return out;
  for (const [k] of FIELDS) { const v = cleanText(l[k], 160); if (v) out[k] = v; }
  const t = String(l.temperature || '').toLowerCase().replace('è', 'e');
  if (TEMPS.includes(t)) out.temperature = t;
  return out;
}

/** Fusionne les nouvelles informations dans la fiche (une information vide n'efface jamais une information connue). */
async function mergeLead(chat, incoming, forceTemp) {
  const cur = cleanLead(JSON.parse(chat.lead || '{}'));
  const next = { ...cur, ...cleanLead(incoming) };
  if (forceTemp && (!next.temperature || TEMPS.indexOf(forceTemp) < TEMPS.indexOf(next.temperature))) next.temperature = forceTemp; // chaud > tiède > froid
  const json = JSON.stringify(next);
  if (json !== (chat.lead || '{}')) await db.prepare('UPDATE chats SET lead = ? WHERE id = ?').run(json, chat.id);
  chat.lead = json;
  return next;
}

function leadSummary(lead) {
  const l = cleanLead(typeof lead === 'string' ? JSON.parse(lead || '{}') : lead);
  const lines = FIELDS.filter(([k]) => l[k]).map(([k, label]) => `${label} : ${l[k]}`);
  if (l.temperature) lines.push(TEMP_LABEL[l.temperature]);
  return lines.join('\n');
}

const memberOf = async (orgId, userId) => await db.prepare('SELECT m.user_id, m.role, u.name, u.contact FROM org_members m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? AND m.user_id = ?').get(orgId, userId);

/** Attribue la conversation à un membre (ou la libère si userId est null). Une conversation attribuée est reprise par un humain : l'IA se tait. */
async function assign(org, chat, userId, byUserId) {
  let who = null;
  if (userId) { who = await memberOf(org.id, userId); if (!who) return false; }
  await db.prepare("UPDATE chats SET assignee_id = ?, assigned_at = ?, status = CASE WHEN ? = 1 THEN 'handoff' ELSE status END WHERE id = ?").run(who ? who.user_id : null, who ? nowISO() : null, who ? 1 : 0, chat.id);
  if (who) {
    const cu = chat.customer_id ? await db.prepare('SELECT name, phone FROM customers WHERE id = ?').get(chat.customer_id) : null;
    const sum = leadSummary(chat.lead);
    await A.logActivity(org.id, byUserId || null, 'sales', `Conversation attribuée à ${who.name}`);
    mailUser(who.contact, `Conversation à traiter : ${cu ? cu.name : 'nouveau prospect'}`,
      `Bonjour ${who.name},\n\nUne conversation client vous a été attribuée dans Brij-IA (${org.name}).\nClient : ${cu ? `${cu.name} ${cu.phone || ''}` : `visiteur ${chat.contact ? '+' + chat.contact : ''}`}\n${chat.campaign ? `Campagne : ${chat.campaign}\n` : ''}${sum ? `\nFiche prospect :\n${sum}\n` : ''}\nOuvrez Brij-IA > Assistant commercial pour lire la conversation et répondre.\n`);
  }
  return true;
}

/** Répartition automatique : le commercial (poste contenant « commercial », « vente »…) qui a le moins de conversations en cours. */
async function autoAssign(org, chat) {
  if (!org.auto_assign || chat.assignee_id) return null;
  const row = await db.prepare(`SELECT m.user_id FROM org_members m WHERE m.org_id = ? AND m.role IN ('member','manager') AND (lower(m.title) LIKE '%commerc%' OR lower(m.title) LIKE '%vente%' OR lower(m.title) LIKE '%vendeu%' OR lower(m.title) LIKE '%sales%')
    ORDER BY (SELECT COUNT(*) FROM chats c WHERE c.org_id = m.org_id AND c.assignee_id = m.user_id AND c.status = 'handoff'), m.id LIMIT 1`).get(org.id);
  if (!row) return null;
  await assign(org, chat, row.user_id, null);
  return row.user_id;
}

module.exports = { cleanLead, mergeLead, leadSummary, assign, autoAssign, memberOf, oneLine };
