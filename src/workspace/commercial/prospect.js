'use strict';
// Prospection commerciale : prospects (leads) et leurs sources, scoring automatique, qualification, attribution automatique (règles par zone, produit, source, charge),
// cadences de relance (séquences, envoyées avec l'IA WhatsApp existante par code QR — jamais l'API officielle), tableau de bord et conversion par source.
const express = require('express');
const { db, nowISO } = require('../../db');
const A = require('../access');
const W = require('../w3');
const P = require('./perm');
const L = require('./lib');
const B = require('./base');
const { HttpError, oneLine, amap, log } = require('../../util');

const router = express.Router({ mergeParams: true });
const { N } = B;
const SOURCES = ['whatsapp', 'ad', 'referral', 'trade_show', 'field', 'web', 'other'];
const STATUSES = ['new', 'contacted', 'qualified', 'converted', 'lost', 'disqualified'];
const OPEN = ['new', 'contacted', 'qualified'];
const TEMPS = ['', 'chaud', 'tiede', 'froid'];
const bantOf = (s) => { try { return JSON.parse(s || '{}'); } catch { return {}; } };

const leadView = (l, names, extra = {}) => ({
  id: Number(l.id), name: l.name, company: l.company, phone: l.phone, email: l.email, source: l.source, campaign: l.campaign, product: l.product, city: l.city, zoneId: l.zone_id ? Number(l.zone_id) : null,
  ownerId: l.owner_id ? Number(l.owner_id) : null, owner: names ? names.get(Number(l.owner_id)) || '' : undefined, status: l.status, temperature: l.temperature, budgetEst: N(l.budget_est),
  score: N(l.score), grade: gradeOf(N(l.score)), bantScore: N(l.bant_score), chatId: l.chat_id ? Number(l.chat_id) : null, customerId: l.customer_id ? Number(l.customer_id) : null,
  notes: l.notes, lostReason: l.lost_reason, lastContactAt: l.last_contact_at, assignedAt: l.assigned_at, convertedAt: l.converted_at, createdAt: l.created_at, ...extra,
});
let GRADES = L.DEFAULTS.leadGrades;
const gradeOf = (s) => (s >= GRADES.A ? 'A' : s >= GRADES.B ? 'B' : s >= GRADES.C ? 'C' : 'D');

async function leadOf(req, id) {
  const l = await db.prepare('SELECT * FROM cp_leads WHERE id = ? AND org_id = ?').get(A.id(id), req.org.id);
  if (!l) throw new HttpError(404, 'Prospect introuvable.');
  await P.mustOwn(req, l);
  return l;
}
async function zoneFor(orgId, city) {
  const c = L.normName(city);
  if (!c) return null;
  for (const z of await db.prepare('SELECT * FROM cp_zones WHERE org_id = ? ORDER BY id').all(orgId)) if (String(z.cities).split(',').map(L.normName).filter(Boolean).includes(c)) return Number(z.id);
  return null;
}

// ---------- Score ----------
async function scoreOf(orgId, l, set) {
  let messages = 0; let lastIso = l.last_contact_at;
  if (l.chat_id) {
    messages = N((await db.prepare("SELECT COUNT(*) c FROM chat_messages WHERE chat_id = ? AND role = 'user'").get(l.chat_id)).c);
    const m = await db.prepare("SELECT MAX(created_at) t FROM chat_messages WHERE chat_id = ? AND role = 'user'").get(l.chat_id);
    if (m && m.t && (!lastIso || m.t > lastIso)) lastIso = m.t;
  }
  const lastContactDays = lastIso ? Math.max(0, L.daysBetween(lastIso, B.today())) : null;
  return L.scoreLead(l, { settings: set, messages, lastContactDays });
}
async function rescore(orgId, leadId) {
  const l = await db.prepare('SELECT * FROM cp_leads WHERE id = ? AND org_id = ?').get(leadId, orgId);
  if (!l) return null;
  const s = await scoreOf(orgId, l, await B.settings(orgId));
  await db.prepare('UPDATE cp_leads SET score = ?, score_detail = ? WHERE id = ?').run(s.score, JSON.stringify(s.parts), l.id);
  return s;
}

// ---------- Attribution ----------
async function loads(orgId) {
  const leads = await db.prepare(`SELECT owner_id, COUNT(*) n FROM cp_leads WHERE org_id = ? AND status IN ('new','contacted','qualified') AND owner_id IS NOT NULL GROUP BY owner_id`).all(orgId);
  const opps = await db.prepare(`SELECT owner_id, COUNT(*) n FROM cp_opps WHERE org_id = ? AND status = 'open' AND owner_id IS NOT NULL GROUP BY owner_id`).all(orgId);
  const m = new Map();
  for (const r of [...leads, ...opps]) m.set(Number(r.owner_id), (m.get(Number(r.owner_id)) || 0) + N(r.n));
  return m;
}
/** Choisit le commercial pour un prospect : première règle active qui correspond (par priorité), puis le moins chargé (ou tour de rôle). Renvoie { userId, rule } ou null. */
async function chooseOwner(orgId, lead) {
  const pool = (await db.prepare("SELECT user_id, role, zone_ids FROM cp_roles WHERE org_id = ? AND role IN ('sales_manager','sales_field')").all(orgId)).map((r) => ({ userId: Number(r.user_id), zones: (() => { try { return JSON.parse(r.zone_ids || '[]').map(Number); } catch { return []; } })() }));
  const load = await loads(orgId);
  const cand = (ids) => ids.map((u) => ({ userId: u, load: load.get(u) || 0 }));
  const rules = await db.prepare('SELECT * FROM cp_assign_rules WHERE org_id = ? AND active = 1 ORDER BY priority, id').all(orgId);
  for (const r of rules) {
    if (r.zone_id && Number(r.zone_id) !== Number(lead.zone_id)) continue;
    if (r.product && !L.normName(lead.product).includes(L.normName(r.product))) continue;
    if (r.source && r.source !== lead.source) continue;
    if (N(r.min_score) > N(lead.score)) continue;
    let ids = []; try { ids = JSON.parse(r.assignees || '[]').map(Number); } catch { ids = []; }
    if (!ids.length && r.zone_id) ids = pool.filter((p) => p.zones.includes(Number(r.zone_id))).map((p) => p.userId);
    if (!ids.length) ids = pool.map((p) => p.userId);
    const u = L.pickAssignee(cand(ids), r.strategy, r.last_user_id);
    if (u) { await db.prepare('UPDATE cp_assign_rules SET last_user_id = ? WHERE id = ?').run(u, r.id); return { userId: u, rule: { id: Number(r.id), name: r.name } }; }
  }
  const zoned = lead.zone_id ? pool.filter((p) => p.zones.includes(Number(lead.zone_id))) : [];
  const u = L.pickAssignee(cand((zoned.length ? zoned : pool).map((p) => p.userId)), 'load');
  return u ? { userId: u, rule: null } : null;
}
async function assign(req, leadId) {
  const l = await db.prepare('SELECT * FROM cp_leads WHERE id = ? AND org_id = ?').get(leadId, req.org.id);
  const pick = await chooseOwner(req.org.id, l);
  if (!pick) return null;
  await db.prepare('UPDATE cp_leads SET owner_id = ?, assigned_at = ?, updated_at = ? WHERE id = ?').run(pick.userId, nowISO(), nowISO(), l.id);
  await P.audit(req, 'lead', l.id, 'auto_assign', { to: pick.userId, rule: pick.rule ? pick.rule.name : 'charge' });
  await W.push(req.org.id, pick.userId, 'commercial', `Nouveau prospect attribué : ${l.name}${l.product ? ' (' + l.product + ')' : ''}`, 'lead:' + l.id);
  return pick;
}

// ---------- Prospects : liste, création, modification ----------
router.get('/leads', P.need('view'), async (req, res) => {
  const names = await B.names(req.org.id);
  const ow = await P.own(req, 'owner_id');
  const rows = await db.prepare(`SELECT * FROM cp_leads WHERE org_id = ?${ow.sql} ORDER BY score DESC, id DESC`).all(req.org.id, ...ow.args);
  let list = rows;
  if (req.query.status) list = list.filter((l) => l.status === req.query.status);
  else if (!req.query.all) list = list.filter((l) => OPEN.includes(l.status));
  if (req.query.source) list = list.filter((l) => l.source === req.query.source);
  if (req.query.ownerId) list = list.filter((l) => Number(l.owner_id) === Number(req.query.ownerId));
  if (req.query.unassigned) list = list.filter((l) => !l.owner_id);
  const q = L.stripAccents(String(req.query.q || '')).toLowerCase();
  if (q) list = list.filter((l) => L.stripAccents(`${l.name} ${l.company} ${l.phone} ${l.email} ${l.product}`).toLowerCase().includes(q));
  const set = await B.settings(req.org.id); GRADES = set.leadGrades;
  res.json({ total: list.length, leads: list.slice(0, B.pageLimit(req.query.limit, 200, 500)).map((l) => leadView(l, names)) });
});

const cleanLead = async (req, b, cur = {}) => {
  const pick = (k, max, col = k) => (b[k] === undefined ? cur[col] || '' : A.text(b[k], max));
  const city = pick('city', 80);
  return {
    name: b.name === undefined ? cur.name : A.text(b.name, 100, { required: true, msg: 'Indiquez le nom du prospect.' }),
    company: pick('company', 100), phone: pick('phone', 40), email: pick('email', 120), campaign: pick('campaign', 80), product: pick('product', 120), city, notes: pick('notes', 800),
    source: b.source === undefined ? cur.source || 'other' : A.oneOf(b.source, SOURCES, undefined, 'Source inconnue (WhatsApp, publicité, recommandation, salon, terrain, site, autre).'),
    temperature: b.temperature === undefined ? cur.temperature || '' : A.oneOf(b.temperature, TEMPS, undefined, 'Température inconnue.'),
    budget_est: b.budgetEst === undefined ? N(cur.budget_est) : b.budgetEst === '' || Number(b.budgetEst) === 0 ? 0 : A.amount(b.budgetEst),
    zone_id: b.zoneId === undefined ? (cur.zone_id || await zoneFor(req.org.id, city)) : b.zoneId ? A.id(b.zoneId) : null,
  };
};

router.post('/leads', P.need('write'), async (req, res) => {
  const b = req.body || {};
  const c = await cleanLead(req, b);
  if (c.zone_id && !await db.prepare('SELECT 1 FROM cp_zones WHERE id = ? AND org_id = ?').get(c.zone_id, req.org.id)) throw new HttpError(400, 'Zone inconnue.');
  const cp = await P.load(req);
  if (!b.force && (c.phone || c.email)) {
    const rows = await db.prepare("SELECT id, name, phone, email FROM cp_leads WHERE org_id = ? AND status IN ('new','contacted','qualified')").all(req.org.id);
    const hit = rows.find((r) => (c.phone && L.phoneKey(r.phone) && L.phoneKey(r.phone) === L.phoneKey(c.phone)) || (c.email && L.emailKey(r.email) && L.emailKey(r.email) === L.emailKey(c.email)));
    if (hit) return res.status(409).json({ error: `Ce prospect existe déjà : ${hit.name}.`, duplicates: [{ id: Number(hit.id), name: hit.name }] });
  }
  let owner = null;
  if (cp.scopeOwn) owner = req.user.id;
  else if (b.ownerId) owner = await A.memberOf(req, b.ownerId);
  const now = nowISO();
  const id = (await db.prepare(`INSERT INTO cp_leads (org_id, name, company, phone, email, source, campaign, product, city, zone_id, owner_id, temperature, budget_est, notes, assigned_at, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(req.org.id, c.name, c.company, c.phone, c.email, c.source, c.campaign, c.product, c.city, c.zone_id, owner, c.temperature, c.budget_est, c.notes, owner ? now : null, req.user.id, now, now)).lastInsertRowid;
  await rescore(req.org.id, Number(id));
  let assigned = null;
  if (!owner && b.autoAssign !== false) assigned = await assign(req, Number(id));
  await P.audit(req, 'lead', id, 'create', `${c.name} (${c.source})`);
  res.status(201).json({ id: Number(id), ownerId: owner || (assigned ? assigned.userId : null), rule: assigned && assigned.rule ? assigned.rule.name : null });
});

router.get('/leads/:id', P.need('view'), async (req, res) => {
  const l = await leadOf(req, req.params.id);
  const names = await B.names(req.org.id);
  const set = await B.settings(req.org.id); GRADES = set.leadGrades;
  const runs = await db.prepare('SELECT r.*, c.name AS cadence, c.steps FROM cp_cadence_runs r JOIN cp_cadences c ON c.id = r.cadence_id WHERE r.lead_id = ? ORDER BY r.id DESC LIMIT 10').all(l.id);
  const acts = N((await db.prepare('SELECT COUNT(*) c FROM cp_activities WHERE lead_id = ?').get(l.id)).c);
  let detail = {}; try { detail = JSON.parse(l.score_detail || '{}'); } catch { detail = {}; }
  res.json({ lead: leadView(l, names, { scoreParts: detail, bant: bantOf(l.bant), activities: acts }), cadences: runs.map(runView) });
});

router.put('/leads/:id', P.need('write'), async (req, res) => {
  const l = await leadOf(req, req.params.id);
  if (['converted'].includes(l.status)) throw new HttpError(400, 'Ce prospect est déjà converti : modifiez le compte ou l’opportunité.');
  const b = req.body || {};
  const c = await cleanLead(req, b, l);
  if (c.zone_id && !await db.prepare('SELECT 1 FROM cp_zones WHERE id = ? AND org_id = ?').get(c.zone_id, req.org.id)) throw new HttpError(400, 'Zone inconnue.');
  let owner = l.owner_id; let status = l.status; let lost = l.lost_reason;
  if (b.ownerId !== undefined && Number(b.ownerId || 0) !== Number(l.owner_id || 0)) {
    if (!(await P.has(req, 'rules'))) throw new HttpError(403, 'Seul le responsable commercial réattribue un prospect.');
    owner = b.ownerId ? await A.memberOf(req, b.ownerId) : null;
    await P.audit(req, 'lead', l.id, 'reassign', { from: l.owner_id, to: owner });
    if (owner) await W.push(req.org.id, owner, 'commercial', `Prospect réattribué : ${l.name}`, 'lead:' + l.id);
  }
  if (b.status !== undefined && b.status !== l.status) {
    status = A.oneOf(b.status, STATUSES.filter((s) => s !== 'converted'), undefined, 'Statut inconnu.');
    if (['lost', 'disqualified'].includes(status)) { lost = A.text(b.lostReason, 200, { required: true, msg: 'Indiquez le motif (perdu ou écarté).' }); await stopRuns(req.org.id, { lead_id: l.id }, status); }
    if (status === 'qualified') { const s = await scoreOf(req.org.id, l, await B.settings(req.org.id)); const min = (await B.settings(req.org.id)).leadGrades.C; if (s.score < min) throw new HttpError(422, `Score de ${s.score} : trop bas pour qualifier ce prospect (minimum ${min}). Complétez la fiche ou le BANT.`); }
  }
  await db.prepare('UPDATE cp_leads SET name = ?, company = ?, phone = ?, email = ?, source = ?, campaign = ?, product = ?, city = ?, zone_id = ?, temperature = ?, budget_est = ?, notes = ?, owner_id = ?, assigned_at = ?, status = ?, lost_reason = ?, updated_at = ? WHERE id = ?')
    .run(c.name, c.company, c.phone, c.email, c.source, c.campaign, c.product, c.city, c.zone_id, c.temperature, c.budget_est, c.notes, owner, owner !== l.owner_id ? nowISO() : l.assigned_at, status, lost, nowISO(), l.id);
  await rescore(req.org.id, l.id);
  if (status !== l.status) await P.audit(req, 'lead', l.id, 'status', { from: l.status, to: status });
  res.json({ ok: true });
});
router.delete('/leads/:id', P.need('delete'), async (req, res) => {
  const r = await db.prepare('DELETE FROM cp_leads WHERE id = ? AND org_id = ?').run(A.id(req.params.id), req.org.id);
  if (!r.changes) throw new HttpError(404, 'Prospect introuvable.');
  await P.audit(req, 'lead', req.params.id, 'delete', '');
  res.json({ ok: true });
});
router.post('/leads/:id/assign', P.need('rules'), async (req, res) => {
  const l = await leadOf(req, req.params.id);
  const p = await assign(req, l.id);
  if (!p) throw new HttpError(409, 'Aucun commercial disponible : désignez des commerciaux (responsable ou terrain) dans Équipe et droits.');
  res.json({ ownerId: p.userId, rule: p.rule ? p.rule.name : null });
});
router.post('/leads/rescore', P.need('rules'), async (req, res) => {
  const rows = await db.prepare("SELECT id FROM cp_leads WHERE org_id = ? AND status IN ('new','contacted','qualified')").all(req.org.id);
  for (const r of rows) await rescore(req.org.id, Number(r.id));
  res.json({ ok: true, count: rows.length });
});

// Conversion : prospect → compte client (fiche existante ou créée) + opportunité optionnelle dans la première étape.
router.post('/leads/:id/convert', P.need('write'), async (req, res) => {
  const l = await leadOf(req, req.params.id);
  if (l.status === 'converted') throw new HttpError(409, 'Ce prospect est déjà converti.');
  if (['lost', 'disqualified'].includes(l.status)) throw new HttpError(400, 'Un prospect perdu ou écarté ne se convertit pas : rouvrez-le d’abord.');
  const b = req.body || {};
  await B.ensureDefaults(req.org.id);
  const out = await db.transaction(async () => {
    let customerId = l.customer_id ? Number(l.customer_id) : null;
    if (b.customerId) { const c = await db.prepare('SELECT id FROM customers WHERE id = ? AND org_id = ?').get(A.id(b.customerId), req.org.id); if (!c) throw new HttpError(404, 'Compte introuvable.'); customerId = Number(c.id); }
    if (!customerId) {
      customerId = Number((await db.prepare("INSERT INTO customers (org_id, name, phone, email, notes, stage, source, account_kind, city, owner_id, zone_id, created_at) VALUES (?, ?, ?, ?, ?, 'prospect', ?, ?, ?, ?, ?, ?)")
        .run(req.org.id, l.company || l.name, l.phone, l.email, l.notes, l.source, l.company ? 'company' : 'person', l.city, l.owner_id || (await P.load(req)).scopeOwn ? (l.owner_id || req.user.id) : null, l.zone_id, nowISO())).lastInsertRowid);
      if (l.company) await db.prepare('INSERT INTO cp_contacts (org_id, customer_id, name, phone, email, is_primary, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)').run(req.org.id, customerId, l.name, l.phone, l.email, nowISO());
    }
    if (l.chat_id) await db.prepare('UPDATE chats SET customer_id = COALESCE(customer_id, ?) WHERE id = ?').run(customerId, l.chat_id);
    let oppId = null;
    if (b.createOpp !== false) oppId = await require('./pipeline').createOpp(req, { name: A.text(b.oppName, 120) || `${l.product || 'Affaire'} – ${l.company || l.name}`, customerId, leadId: l.id, ownerId: l.owner_id || req.user.id, amount: b.amount === undefined ? N(l.budget_est) : b.amount, product: l.product, source: l.source, zoneId: l.zone_id, bant: bantOf(l.bant), bantScore: N(l.bant_score), closeDate: b.closeDate });
    await db.prepare("UPDATE cp_leads SET status = 'converted', customer_id = ?, converted_at = ?, updated_at = ? WHERE id = ?").run(customerId, nowISO(), nowISO(), l.id);
    await stopRuns(req.org.id, { lead_id: l.id }, 'converted');
    return { customerId, oppId };
  })();
  await P.audit(req, 'lead', l.id, 'convert', out);
  res.status(201).json(out);
});

// Prospects venus de WhatsApp : une conversation (avec fiche IA) = un prospect, une seule fois.
async function syncChats(orgId) {
  const chats = await db.prepare(`SELECT c.* FROM chats c WHERE c.org_id = ? AND c.channel = 'whatsapp' AND NOT EXISTS (SELECT 1 FROM cp_leads l WHERE l.org_id = c.org_id AND l.chat_id = c.id) ORDER BY c.id DESC LIMIT 100`).all(orgId);
  let n = 0;
  for (const c of chats) {
    let lead = {}; try { lead = JSON.parse(c.lead || '{}'); } catch { lead = {}; }
    const cu = c.customer_id ? await db.prepare('SELECT name, phone, email, city, stage FROM customers WHERE id = ?').get(c.customer_id) : null;
    if (cu && cu.stage === 'client') continue; // un client existant n'est pas un prospect
    if (!cu && !Object.keys(lead).length) continue; // conversation sans information exploitable
    const temp = ['chaud', 'tiede', 'froid'].includes(lead.temperature) ? lead.temperature : '';
    const now = nowISO();
    const nm = (cu && cu.name) || (c.contact ? `+${c.contact}` : 'Contact WhatsApp');
    try {
      const id = (await db.prepare("INSERT INTO cp_leads (org_id, name, phone, email, source, campaign, product, city, zone_id, temperature, chat_id, customer_id, notes, last_contact_at, created_at, updated_at) VALUES (?, ?, ?, ?, 'whatsapp', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(orgId, nm, (cu && cu.phone) || c.contact || '', (cu && cu.email) || '', c.campaign || '', oneLine(lead.need || '', 120), (cu && cu.city) || lead.city || '', await zoneFor(orgId, (cu && cu.city) || lead.city), temp, c.id, c.customer_id || null, oneLine([lead.need, lead.quantity && `Quantité : ${lead.quantity}`, lead.deadline && `Pour : ${lead.deadline}`, lead.budget && `Budget : ${lead.budget}`].filter(Boolean).join(' – '), 600), c.updated_at, now, now)).lastInsertRowid;
      await rescore(orgId, Number(id)); n++;
    } catch (e) { log.warn('Prospect WhatsApp :', oneLine(e.message, 120)); }
  }
  return n;
}
router.post('/leads-sync-whatsapp', P.need('write'), async (req, res) => {
  const n = await syncChats(req.org.id);
  if (n) await P.audit(req, 'lead', null, 'sync_whatsapp', { created: n });
  res.json({ created: n });
});

// ---------- Règles d'attribution ----------
const ruleView = (r) => ({ id: Number(r.id), name: r.name, priority: N(r.priority), zoneId: r.zone_id ? Number(r.zone_id) : null, product: r.product, source: r.source, minScore: N(r.min_score), assignees: (() => { try { return JSON.parse(r.assignees || '[]').map(Number); } catch { return []; } })(), strategy: r.strategy, active: Boolean(Number(r.active)) });
router.get('/assign-rules', P.need('view'), async (req, res) => res.json({ rules: (await db.prepare('SELECT * FROM cp_assign_rules WHERE org_id = ? ORDER BY priority, id').all(req.org.id)).map(ruleView), load: [...(await loads(req.org.id)).entries()].map(([userId, n]) => ({ userId, open: n })) }));
const cleanRule = async (req, b, cur = {}) => {
  const ids = b.assignees === undefined ? JSON.parse(cur.assignees || '[]') : (Array.isArray(b.assignees) ? b.assignees : []);
  const assignees = []; for (const i of ids) assignees.push(await A.memberOf(req, i));
  const zone = b.zoneId === undefined ? cur.zone_id || null : b.zoneId ? A.id(b.zoneId) : null;
  if (zone && !await db.prepare('SELECT 1 FROM cp_zones WHERE id = ? AND org_id = ?').get(zone, req.org.id)) throw new HttpError(400, 'Zone inconnue.');
  return { name: b.name === undefined ? cur.name : A.text(b.name, 80, { required: true, msg: 'Nommez la règle.' }), priority: b.priority === undefined ? N(cur.priority) || 100 : Math.min(Math.max(Math.round(Number(b.priority) || 100), 1), 9999), zone, product: b.product === undefined ? cur.product || '' : A.text(b.product, 80), source: b.source === undefined ? cur.source || '' : b.source ? A.oneOf(b.source, SOURCES, undefined, 'Source inconnue.') : '', min_score: b.minScore === undefined ? N(cur.min_score) : Math.min(Math.max(Math.round(Number(b.minScore) || 0), 0), 100), assignees: JSON.stringify(assignees), strategy: b.strategy === undefined ? cur.strategy || 'load' : A.oneOf(b.strategy, ['load', 'round_robin'], undefined, 'Stratégie inconnue.'), active: b.active === undefined ? N(cur.active ?? 1) : b.active ? 1 : 0 };
};
router.post('/assign-rules', P.need('rules'), async (req, res) => {
  const c = await cleanRule(req, req.body || {});
  const id = (await db.prepare('INSERT INTO cp_assign_rules (org_id, name, priority, zone_id, product, source, min_score, assignees, strategy, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(req.org.id, c.name, c.priority, c.zone, c.product, c.source, c.min_score, c.assignees, c.strategy, c.active, nowISO())).lastInsertRowid;
  await P.audit(req, 'assign_rule', id, 'create', c.name);
  res.status(201).json({ id: Number(id) });
});
router.put('/assign-rules/:id', P.need('rules'), async (req, res) => {
  const r = await db.prepare('SELECT * FROM cp_assign_rules WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!r) throw new HttpError(404, 'Règle introuvable.');
  const c = await cleanRule(req, req.body || {}, r);
  await db.prepare('UPDATE cp_assign_rules SET name = ?, priority = ?, zone_id = ?, product = ?, source = ?, min_score = ?, assignees = ?, strategy = ?, active = ? WHERE id = ?').run(c.name, c.priority, c.zone, c.product, c.source, c.min_score, c.assignees, c.strategy, c.active, r.id);
  await P.audit(req, 'assign_rule', r.id, 'update', c.name);
  res.json({ ok: true });
});
router.delete('/assign-rules/:id', P.need('rules'), async (req, res) => {
  const x = await db.prepare('DELETE FROM cp_assign_rules WHERE id = ? AND org_id = ?').run(A.id(req.params.id), req.org.id);
  if (!x.changes) throw new HttpError(404, 'Règle introuvable.');
  await P.audit(req, 'assign_rule', req.params.id, 'delete', '');
  res.json({ ok: true });
});

// ---------- Cadences de prospection ----------
const CHANNELS = ['whatsapp', 'task'];
const TARGETS = ['lead', 'customer', 'quote'];
const DEFAULT_STEPS = [
  { day: 0, channel: 'whatsapp', text: 'Bonjour {prenom}, merci pour votre intérêt pour {produit}. Puis-je vous aider à préciser votre besoin ?' },
  { day: 2, channel: 'whatsapp', text: 'Bonjour {prenom}, je reviens vers vous au sujet de {produit}. Souhaitez-vous un devis ?' },
  { day: 5, channel: 'task', text: 'Appeler {prenom} pour qualifier le besoin' },
  { day: 9, channel: 'whatsapp', text: 'Bonjour {prenom}, dernière relance de ma part pour {produit}. Dites-moi si je peux faire quelque chose pour vous.' },
];
function cleanSteps(v) {
  if (!Array.isArray(v) || !v.length || v.length > 10) throw new HttpError(400, 'Une cadence compte de 1 à 10 étapes.');
  let prev = -1;
  return v.map((s) => {
    const day = Math.round(Number(s && s.day));
    if (!Number.isInteger(day) || day < 0 || day > 90) throw new HttpError(400, 'Le jour de chaque étape va de 0 à 90.');
    if (day < prev) throw new HttpError(400, 'Les étapes doivent être classées par jour croissant.');
    prev = day;
    return { day, channel: A.oneOf(s.channel, CHANNELS, undefined, 'Canal inconnu (WhatsApp ou tâche).'), text: A.text(s.text, 600, { required: true, msg: 'Chaque étape a un message.' }) };
  });
}
const cadView = (c) => ({ id: Number(c.id), name: c.name, target: c.target, steps: JSON.parse(c.steps || '[]'), autoSend: Boolean(Number(c.auto_send)), active: Boolean(Number(c.active)) });
router.get('/cadences', P.need('view'), async (req, res) => {
  const rows = await db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM cp_cadence_runs r WHERE r.cadence_id = c.id AND r.state = 'active') AS running FROM cp_cadences c WHERE c.org_id = ? ORDER BY c.id`).all(req.org.id);
  res.json({ cadences: rows.map((c) => ({ ...cadView(c), running: N(c.running) })), defaults: DEFAULT_STEPS });
});
router.post('/cadences', P.need('rules'), async (req, res) => {
  const b = req.body || {};
  const id = (await db.prepare('INSERT INTO cp_cadences (org_id, name, target, steps, auto_send, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(req.org.id, A.text(b.name, 80, { required: true, msg: 'Nommez la cadence.' }), A.oneOf(b.target, TARGETS, 'lead', 'Cible inconnue.'), JSON.stringify(cleanSteps(b.steps || DEFAULT_STEPS)), b.autoSend ? 1 : 0, req.user.id, nowISO())).lastInsertRowid;
  await P.audit(req, 'cadence', id, 'create', b.name);
  res.status(201).json({ id: Number(id) });
});
router.put('/cadences/:id', P.need('rules'), async (req, res) => {
  const c = await db.prepare('SELECT * FROM cp_cadences WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!c) throw new HttpError(404, 'Cadence introuvable.');
  const b = req.body || {};
  await db.prepare('UPDATE cp_cadences SET name = ?, steps = ?, auto_send = ?, active = ? WHERE id = ?').run(A.text(b.name, 80) || c.name, b.steps === undefined ? c.steps : JSON.stringify(cleanSteps(b.steps)), b.autoSend === undefined ? c.auto_send : b.autoSend ? 1 : 0, b.active === undefined ? c.active : b.active ? 1 : 0, c.id);
  await P.audit(req, 'cadence', c.id, 'update', Object.keys(b).join(','));
  res.json({ ok: true });
});
router.delete('/cadences/:id', P.need('rules'), async (req, res) => {
  const x = await db.prepare('DELETE FROM cp_cadences WHERE id = ? AND org_id = ?').run(A.id(req.params.id), req.org.id);
  if (!x.changes) throw new HttpError(404, 'Cadence introuvable.');
  res.json({ ok: true });
});

const subjectCol = (c) => (c.target === 'lead' ? 'lead_id' : c.target === 'customer' ? 'customer_id' : 'doc_id');
router.post('/cadences/:id/start', P.need('activity'), async (req, res) => {
  const c = await db.prepare('SELECT * FROM cp_cadences WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!c) throw new HttpError(404, 'Cadence introuvable.');
  if (!Number(c.active)) throw new HttpError(409, 'Cette cadence est désactivée.');
  const b = req.body || {};
  const col = subjectCol(c);
  const key = { lead_id: 'leadId', customer_id: 'customerId', doc_id: 'docId' }[col];
  const ids = (Array.isArray(b[key + 's']) ? b[key + 's'] : [b[key]]).filter((x) => x !== undefined && x !== null).map((x) => A.id(x));
  if (!ids.length || ids.length > 100) throw new HttpError(400, 'Indiquez la fiche à relancer (1 à 100).');
  const steps = JSON.parse(c.steps);
  const started = []; const skipped = [];
  for (const sid of ids) {
    if (col === 'lead_id') { const l = await leadOf(req, sid); if (!OPEN.includes(l.status)) { skipped.push({ id: sid, why: 'closed' }); continue; } }
    else if (col === 'customer_id') { const cu = await db.prepare('SELECT * FROM customers WHERE id = ? AND org_id = ?').get(sid, req.org.id); if (!cu || !A.visible(req, cu)) throw new HttpError(404, 'Compte introuvable.'); if (Number(cu.followup_optout)) { skipped.push({ id: sid, why: 'optout' }); continue; } }
    else { const d = await db.prepare("SELECT * FROM documents WHERE id = ? AND org_id = ? AND kind = 'quote'").get(sid, req.org.id); if (!d) throw new HttpError(404, 'Devis introuvable.'); if (!['sent', 'draft'].includes(d.status)) { skipped.push({ id: sid, why: 'closed' }); continue; } }
    if (await db.prepare(`SELECT 1 FROM cp_cadence_runs WHERE cadence_id = ? AND ${col} = ? AND state IN ('active','sending')`).get(c.id, sid)) { skipped.push({ id: sid, why: 'running' }); continue; }
    const at = new Date(Date.now() + steps[0].day * 86400000).toISOString();
    const id = (await db.prepare(`INSERT INTO cp_cadence_runs (org_id, cadence_id, ${col}, step_idx, next_at, started_by, started_at, updated_at) VALUES (?, ?, ?, 0, ?, ?, ?, ?)`).run(req.org.id, c.id, sid, at, req.user.id, nowISO(), nowISO())).lastInsertRowid;
    started.push(Number(id));
  }
  await P.audit(req, 'cadence', c.id, 'start', { started: started.length, skipped });
  res.status(201).json({ started, skipped });
});

async function stopRuns(orgId, where, reason) {
  const col = Object.keys(where)[0];
  await db.prepare(`UPDATE cp_cadence_runs SET state = 'stopped', stop_reason = ?, updated_at = ? WHERE org_id = ? AND ${col} = ? AND state = 'active'`).run(reason, nowISO(), orgId, where[col]);
}
const tpl = (t, v) => String(t).replace(/\{(\w+)\}/g, (m, k) => (v[k] === undefined ? m : v[k]));
async function subjectOf(org, run) {
  if (run.lead_id) {
    const l = await db.prepare('SELECT * FROM cp_leads WHERE id = ?').get(run.lead_id);
    if (!l) return null;
    return { kind: 'lead', name: l.name, phone: l.phone, vars: { prenom: first(l.name), nom: l.name, entreprise: l.company, produit: l.product || 'nos produits', organisation: org.name }, closed: !OPEN.includes(l.status) ? l.status : '', optout: false, chatId: l.chat_id, ownerId: l.owner_id, since: run.started_at };
  }
  if (run.customer_id) {
    const c = await db.prepare('SELECT * FROM customers WHERE id = ?').get(run.customer_id);
    if (!c) return null;
    return { kind: 'customer', name: c.name, phone: c.phone, vars: { prenom: first(c.name), nom: c.name, entreprise: c.name, produit: 'nos produits', organisation: org.name }, closed: '', optout: Boolean(Number(c.followup_optout)), customerId: c.id, ownerId: c.owner_id, since: run.started_at };
  }
  const d = await db.prepare('SELECT d.*, c.name, c.phone, c.followup_optout, c.owner_id FROM documents d JOIN customers c ON c.id = d.customer_id WHERE d.id = ?').get(run.doc_id);
  if (!d) return null;
  return { kind: 'quote', name: d.name, phone: d.phone, vars: { prenom: first(d.name), nom: d.name, entreprise: d.name, produit: 'votre devis', numero: d.number, montant: Number(d.total).toLocaleString('fr-FR').replace(/\s/g, ' '), organisation: org.name }, closed: ['accepted', 'refused', 'cancelled'].includes(d.status) ? d.status : '', optout: Boolean(Number(d.followup_optout)), customerId: d.customer_id, ownerId: d.owner_id, since: run.started_at };
}
const first = (n) => String(n || '').trim().split(/\s+/)[0] || '';
const intl = (x) => { let d = String(x || '').replace(/\D/g, ''); if (d.startsWith('00')) d = d.slice(2); const cc = String(process.env.DEFAULT_COUNTRY_CODE || '237').replace(/\D/g, ''); return d.length === 9 && /^[2368]/.test(d) ? cc + d : d; };
/** Raison d'arrêt d'une cadence : fiche close, opposition, ou réponse du client depuis le début. */
async function stopReasonOf(org, run, subj) {
  if (!subj) return 'subject_deleted';
  if (subj.closed) return subj.closed;
  if (subj.optout) return 'optout';
  const chatIds = [];
  if (subj.chatId) chatIds.push(subj.chatId);
  if (subj.customerId) for (const c of await db.prepare('SELECT id FROM chats WHERE org_id = ? AND customer_id = ?').all(org.id, subj.customerId)) chatIds.push(c.id);
  for (const id of chatIds) {
    const m = await db.prepare("SELECT 1 FROM chat_messages WHERE chat_id = ? AND role = 'user' AND created_at > ?").get(id, run.started_at);
    if (m) return 'replied';
  }
  return '';
}
const runView = (r, extra = {}) => ({ id: Number(r.id), cadenceId: Number(r.cadence_id), cadence: r.cadence, leadId: r.lead_id ? Number(r.lead_id) : null, customerId: r.customer_id ? Number(r.customer_id) : null, docId: r.doc_id ? Number(r.doc_id) : null, stepIdx: N(r.step_idx), steps: r.steps ? JSON.parse(r.steps).length : undefined, nextAt: r.next_at, state: r.state, stopReason: r.stop_reason, ...extra });

// File des relances à traiter : un humain relit puis envoie (ou saute) ; les cadences « automatiques » partent seules, avec les mêmes garde-fous.
router.get('/cadences-queue', P.need('view'), async (req, res) => {
  const cp = await P.load(req);
  const rows = await db.prepare(`SELECT r.*, c.name AS cadence, c.steps FROM cp_cadence_runs r JOIN cp_cadences c ON c.id = r.cadence_id WHERE r.org_id = ? AND r.state = 'active'${req.query.all ? '' : ' AND r.next_at <= ?'} ORDER BY r.next_at LIMIT 100`).all(req.org.id, ...(req.query.all ? [] : [nowISO()]));
  const out = [];
  for (const r of rows) {
    const subj = await subjectOf(req.org, r);
    if (cp.scopeOwn && (!subj || Number(subj.ownerId) !== req.user.id)) continue;
    const why = await stopReasonOf(req.org, r, subj);
    if (why) { await db.prepare("UPDATE cp_cadence_runs SET state = 'stopped', stop_reason = ?, updated_at = ? WHERE id = ? AND state = 'active'").run(why, nowISO(), r.id); continue; }
    const step = JSON.parse(r.steps)[N(r.step_idx)];
    if (!step) continue;
    const text = tpl(step.text, subj.vars);
    out.push(runView(r, { subject: subj.name, subjectKind: subj.kind, phone: subj.phone, step: { ...step, text }, due: r.next_at <= nowISO(), waLink: step.channel === 'whatsapp' && intl(subj.phone).length >= 8 ? `https://wa.me/${intl(subj.phone)}?text=${encodeURIComponent(text)}` : null }));
  }
  res.json({ queue: out });
});
router.get('/cadences-runs', P.need('view'), async (req, res) => {
  const rows = await db.prepare('SELECT r.*, c.name AS cadence, c.steps FROM cp_cadence_runs r JOIN cp_cadences c ON c.id = r.cadence_id WHERE r.org_id = ? ORDER BY r.id DESC LIMIT 100').all(req.org.id);
  res.json({ runs: rows.map((r) => runView(r)) });
});
router.get('/cadences-runs/:id/log', P.need('view'), async (req, res) => {
  const r = await db.prepare('SELECT * FROM cp_cadence_runs WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!r) throw new HttpError(404, 'Relance introuvable.');
  res.json({ log: (await db.prepare('SELECT * FROM cp_cadence_log WHERE run_id = ? ORDER BY id').all(r.id)).map((x) => ({ id: Number(x.id), stepIdx: N(x.step_idx), channel: x.channel, result: x.result, detail: x.detail, body: x.body, at: x.created_at })) });
});

/** Exécute l'étape courante d'une relance : envoi WhatsApp (QR), tâche pour le commercial, ou marquage manuel. userId null = envoi automatique. */
async function runStep(org, runId, { userId = null, action = 'send', text } = {}) {
  const claim = await db.prepare("UPDATE cp_cadence_runs SET state = 'sending', updated_at = ? WHERE id = ? AND org_id = ? AND state = 'active'").run(nowISO(), runId, org.id);
  if (!claim.changes) return { ok: false, error: 'Cette relance a déjà été traitée.' };
  const r = await db.prepare('SELECT r.*, c.steps FROM cp_cadence_runs r JOIN cp_cadences c ON c.id = r.cadence_id WHERE r.id = ?').get(runId);
  const back = async (error) => { await db.prepare("UPDATE cp_cadence_runs SET state = 'active', updated_at = ? WHERE id = ?").run(nowISO(), r.id); return { ok: false, error }; };
  const subj = await subjectOf(org, r);
  const why = await stopReasonOf(org, r, subj);
  if (why) { await db.prepare("UPDATE cp_cadence_runs SET state = 'stopped', stop_reason = ?, updated_at = ? WHERE id = ?").run(why, nowISO(), r.id); return { ok: false, stopped: why, error: 'Relance arrêtée : ' + why }; }
  const steps = JSON.parse(r.steps); const idx = N(r.step_idx); const step = steps[idx];
  const body = oneLine(text || tpl(step.text, subj.vars), 1000);
  const log1 = (result, detail, channel) => db.prepare('INSERT INTO cp_cadence_log (org_id, run_id, step_idx, channel, result, detail, body, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(org.id, r.id, idx, channel, result, detail, body, userId, nowISO());
  const advance = async () => {
    const next = steps[idx + 1];
    if (!next) await db.prepare("UPDATE cp_cadence_runs SET state = 'done', step_idx = ?, updated_at = ? WHERE id = ?").run(idx + 1, nowISO(), r.id);
    else { const t = new Date(Date.parse(r.started_at) + next.day * 86400000).toISOString(); await db.prepare("UPDATE cp_cadence_runs SET state = 'active', step_idx = ?, next_at = ?, updated_at = ? WHERE id = ?").run(idx + 1, t < nowISO() ? nowISO() : t, nowISO(), r.id); }
  };
  if (action === 'skip') { await log1('skipped', 'étape sautée', step.channel); await advance(); return { ok: true, state: 'skipped' }; }
  if (action === 'manual') { await log1('manual', 'envoyé à la main', step.channel); await advance(); return { ok: true, state: 'manual' }; }
  if (step.channel === 'task') {
    const assignee = subj.ownerId || userId || org.owner_id;
    await db.prepare('INSERT INTO cp_tasks (org_id, customer_id, lead_id, title, kind, due_at, assignee_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(org.id, subj.customerId || null, r.lead_id || null, body.slice(0, 200), 'call', nowISO(), assignee, userId, nowISO());
    await W.push(org.id, assignee, 'commercial', `Relance à faire : ${body}`, 'cadence:' + r.id);
    await log1('task', 'tâche créée', 'task'); await advance(); return { ok: true, state: 'task' };
  }
  const waOrg = require('../../services/waOrg');
  const to = intl(subj.phone);
  if (to.length < 8 || to.length > 15) return await back('Numéro de téléphone invalide ou manquant.');
  if (!waOrg.isConnected(org)) return Object.assign(await back("WhatsApp n'est pas connecté (code QR). Envoyez le message à la main, puis marquez l'étape comme faite."), { waLink: `https://wa.me/${to}?text=${encodeURIComponent(body)}` });
  const out = require('../wa-out');
  if (await out.isOptedOut(org.id, to)) { await db.prepare("UPDATE cp_cadence_runs SET state = 'stopped', stop_reason = 'optout', updated_at = ? WHERE id = ?").run(nowISO(), r.id); return { ok: false, stopped: 'optout', error: 'Cette personne a demandé à ne plus recevoir de messages WhatsApp.' }; }
  if (!userId) {
    const chat = subj.chatId ? await db.prepare('SELECT * FROM chats WHERE id = ?').get(subj.chatId) : null;
    if (await require('../ai-rules').autoBlocked(org.id, { chat, customerId: subj.customerId || null, phone: subj.phone })) return await back("L'IA est exclue pour ce contact (Suivi de l'IA) : aucune relance automatique.");
  }
  try { await waOrg.sendText(org, to, body); } catch (e) { await log1('failed', oneLine(e.message, 200), 'whatsapp'); return await back(`Envoi impossible : ${oneLine(String(e.message).replace(/^.*HTTP \d+ : /, ''), 160)}`); }
  await log1('sent', userId ? 'envoyé par un membre' : 'envoi automatique', 'whatsapp');
  if (subj.chatId) await db.prepare("INSERT INTO chat_messages (chat_id, role, content, created_at) VALUES (?, 'staff', ?, ?)").run(subj.chatId, `[relance] ${body}`.slice(0, 2000), nowISO()).catch(() => {});
  if (r.lead_id) await db.prepare("UPDATE cp_leads SET last_contact_at = ?, status = CASE WHEN status = 'new' THEN 'contacted' ELSE status END, updated_at = ? WHERE id = ?").run(nowISO(), nowISO(), r.lead_id);
  await advance();
  return { ok: true, state: 'sent' };
}
router.post('/cadences-runs/:id/:action(send|skip|manual)', P.need('activity'), async (req, res) => {
  const r = await db.prepare('SELECT * FROM cp_cadence_runs WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!r) throw new HttpError(404, 'Relance introuvable.');
  const cp = await P.load(req);
  if (cp.scopeOwn) { const s = await subjectOf(req.org, r); if (!s || Number(s.ownerId) !== req.user.id) throw new HttpError(403, 'Cette fiche est suivie par un autre commercial.'); }
  const out = await runStep(req.org, r.id, { userId: req.user.id, action: req.params.action, text: (req.body || {}).text });
  if (out.ok) await P.audit(req, 'cadence_run', r.id, req.params.action, '');
  res.status(out.ok ? 200 : out.stopped ? 409 : 422).json(out);
});
router.post('/cadences-runs/:id/stop', P.need('activity'), async (req, res) => {
  const r = await db.prepare('SELECT * FROM cp_cadence_runs WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
  if (!r) throw new HttpError(404, 'Relance introuvable.');
  await db.prepare("UPDATE cp_cadence_runs SET state = 'stopped', stop_reason = 'manual', updated_at = ? WHERE id = ? AND state IN ('active')").run(nowISO(), r.id);
  res.json({ ok: true });
});

// ---------- Tableau de bord de prospection ----------
router.get('/prospection/dashboard', P.need('view'), async (req, res) => {
  const { from, to } = B.range(req.query);
  const names = await B.names(req.org.id);
  const set = await B.settings(req.org.id); GRADES = set.leadGrades;
  const ow = await P.own(req, 'owner_id');
  const all = await db.prepare(`SELECT * FROM cp_leads WHERE org_id = ?${ow.sql}`).all(req.org.id, ...ow.args);
  const inRange = all.filter((l) => l.created_at.slice(0, 10) >= from && l.created_at.slice(0, 10) <= to);
  const rate = (a, b) => (b ? L.round((a * 100) / b, 1) : 0);
  const bySource = SOURCES.map((s) => {
    const x = inRange.filter((l) => l.source === s);
    const conv = x.filter((l) => l.status === 'converted').length; const qual = x.filter((l) => ['qualified', 'converted'].includes(l.status)).length;
    return { source: s, leads: x.length, qualified: qual, converted: conv, lost: x.filter((l) => ['lost', 'disqualified'].includes(l.status)).length, conversionRate: rate(conv, x.length), avgScore: x.length ? L.round(x.reduce((a, l) => a + N(l.score), 0) / x.length, 1) : 0 };
  }).filter((r) => r.leads > 0);
  const byStatus = STATUSES.map((s) => ({ status: s, count: inRange.filter((l) => l.status === s).length }));
  const reached = (st) => inRange.filter((l) => (st === 'new' ? true : st === 'contacted' ? l.status !== 'new' || l.last_contact_at : st === 'qualified' ? ['qualified', 'converted'].includes(l.status) : l.status === 'converted')).length;
  const funnel = ['new', 'contacted', 'qualified', 'converted'].map((s) => ({ stage: s, count: reached(s) }));
  const open = all.filter((l) => OPEN.includes(l.status));
  const byGrade = ['A', 'B', 'C', 'D'].map((g) => ({ grade: g, count: open.filter((l) => gradeOf(N(l.score)) === g).length }));
  const owners = [...new Set(all.map((l) => Number(l.owner_id)).filter(Boolean))].map((u) => {
    const x = all.filter((l) => Number(l.owner_id) === u);
    return { userId: u, name: names.get(u) || '', open: x.filter((l) => OPEN.includes(l.status)).length, converted: x.filter((l) => l.status === 'converted' && l.converted_at && l.converted_at.slice(0, 10) >= from && l.converted_at.slice(0, 10) <= to).length };
  });
  const stale = open.filter((l) => (l.last_contact_at ? L.daysBetween(l.last_contact_at, B.today()) : L.daysBetween(l.created_at, B.today())) >= set.staleLeadDays);
  const weekly = {};
  for (const l of inRange) { const w = L.addDays(l.created_at.slice(0, 10), -((new Date(`${l.created_at.slice(0, 10)}T00:00:00Z`).getUTCDay() + 6) % 7)); weekly[w] = weekly[w] || { week: w, created: 0, converted: 0 }; weekly[w].created++; if (l.status === 'converted') weekly[w].converted++; }
  const conv = inRange.filter((l) => l.status === 'converted').length;
  res.json({
    from, to, total: inRange.length, openTotal: open.length, unassigned: open.filter((l) => !l.owner_id).length, converted: conv, conversionRate: rate(conv, inRange.length),
    avgScore: inRange.length ? L.round(inRange.reduce((a, l) => a + N(l.score), 0) / inRange.length, 1) : 0, bySource, byStatus, funnel, byGrade, owners,
    stale: stale.slice(0, 20).map((l) => leadView(l, names)), staleCount: stale.length, weekly: Object.values(weekly).sort((a, b) => a.week.localeCompare(b.week)),
    bestSource: [...bySource].filter((s) => s.leads >= 1).sort((a, b) => b.conversionRate - a.conversionRate || b.leads - a.leads)[0] || null,
  });
});

// ---------- Tâches automatiques ----------
async function tickOrg(org) {
  await syncChats(org.id);
  const due = await db.prepare("SELECT t.* FROM cp_tasks t WHERE t.org_id = ? AND t.status = 'open' AND t.due_at IS NOT NULL AND t.due_at <= ? AND t.notified_at IS NULL LIMIT 100").all(org.id, nowISO());
  for (const t of due) {
    if (t.assignee_id) await W.push(org.id, Number(t.assignee_id), 'commercial', `Rappel : ${t.title}`, 'task:' + t.id);
    await db.prepare('UPDATE cp_tasks SET notified_at = ? WHERE id = ?').run(nowISO(), t.id);
  }
  const autos = await db.prepare("SELECT r.id FROM cp_cadence_runs r JOIN cp_cadences c ON c.id = r.cadence_id WHERE r.org_id = ? AND r.state = 'active' AND r.next_at <= ? AND c.auto_send = 1 AND c.active = 1 ORDER BY r.next_at LIMIT 20").all(org.id, nowISO());
  for (const r of autos) await runStep(org, Number(r.id), { userId: null }).catch((e) => log.warn('Cadence automatique :', oneLine(e.message, 120)));
  for (const l of await db.prepare("SELECT id FROM cp_leads WHERE org_id = ? AND status IN ('new','contacted','qualified') ORDER BY updated_at LIMIT 200").all(org.id)) await rescore(org.id, Number(l.id));
}
async function tickAll() {
  for (const org of await db.prepare('SELECT * FROM orgs').all()) await tickOrg(org).catch((e) => log.warn('Commercial (tâches automatiques) :', oneLine(e.message, 160)));
}

module.exports = { router, rescore, assign, chooseOwner, syncChats, leadView, runStep, tickOrg, tickAll, stopRuns, SOURCES, STATUSES };
