'use strict';
// Trésorerie : socle commun. Droits (responsable de trésorerie, trésoriers), réglages, journal chaîné, comptes de trésorerie,
// taux de change, catégories de flux et classement des contreparties comptables (SYSCOHADA). Aucune route ici.
const crypto = require('crypto');
const { db, nowISO } = require('../db');
const A = require('./access');
const { HttpError } = require('../util');

const today = () => nowISO().slice(0, 10);
const { isCash, classify } = require('./tre-calc');
const { toMs, addDays, diffDays, addMonths, lastDay, num, isMonth } = require('./tre-dates');

// ---------- Droits ----------
// Propriétaire et administrateurs : accès complet (ils nomment le responsable et les trésoriers). Responsable de trésorerie : valide, fixe seuils et fonds
// de sécurité. Trésorier : prépare les encaissements, décaissements et virements, consulte soldes, calendrier et prévisions. Les autres : aucun accès.
async function treRole(req) {
  if (req.treRole !== undefined) return req.treRole;
  let role = '';
  if (A.can(req, 'admin')) role = 'admin';
  else {
    const r = await db.prepare('SELECT role FROM tre_roles WHERE org_id = ? AND user_id = ?').get(req.org.id, req.user.id);
    role = r ? r.role : '';
  }
  req.treRole = role;
  return role;
}
async function hasAccess(req) { return Boolean(await treRole(req)); }
/** Peut valider / régler : propriétaire, administrateur, responsable de trésorerie. */
const isManager = async (req) => { const r = await treRole(req); return r === 'admin' || r === 'manager'; };
/** Garde de route : 'any' (tout rôle de trésorerie), 'manager' (valider, régler), 'admin' (désigner les rôles). */
const need = (level) => async (req, res, next) => {
  const r = await treRole(req);
  const ok = level === 'any' ? Boolean(r) : level === 'manager' ? r === 'admin' || r === 'manager' : r === 'admin';
  if (!ok) throw new HttpError(403, "Votre rôle ne permet pas cette action : la trésorerie est réservée au responsable de trésorerie, aux trésoriers et aux administrateurs.");
  next();
};

// ---------- Réglages ----------
const DEFAULT_PROVISION = { notDue: 0, d30: 1, d60: 5, d90: 25, d90p: 50 }; // % du reste dû, par tranche de retard
const DEFAULT_TARGETS = { dso: 45, dpo: 45, dio: 60, ccc: 60 }; // objectifs en jours
async function settings(orgId) {
  await db.prepare('INSERT INTO tre_settings (org_id) VALUES (?) ON CONFLICT DO NOTHING').run(orgId);
  const r = await db.prepare('SELECT * FROM tre_settings WHERE org_id = ?').get(orgId);
  const j = (s, d) => { try { return { ...d, ...(JSON.parse(s) || {}) }; } catch { return { ...d }; } };
  return {
    approvalThreshold: num(r.approval_threshold), safetyMode: r.safety_mode, safetyDays: num(r.safety_days), safetyAmount: num(r.safety_amount),
    minBalance: num(r.min_balance), provision: j(r.provision_json, DEFAULT_PROVISION), targets: j(r.targets_json, DEFAULT_TARGETS), payday: num(r.payday) || 28, strictSeparation: Boolean(num(r.strict_separation)),
    includeTrend: Boolean(num(r.include_trend)), updatedAt: r.updated_at || null,
  };
}

// ---------- Journal de traçabilité chaîné ----------
const hashOf = (prev, row) => crypto.createHash('sha256').update([prev, row.orgId, row.userId || '', row.action, row.entity, row.entityId || '', row.detail, row.at].join('|')).digest('hex');
/** Ajoute une ligne : son empreinte inclut celle de la précédente (toute modification ou suppression après coup se voit). */
async function log(orgId, userId, action, entity, entityId, detail) {
  const d = typeof detail === 'string' ? detail : JSON.stringify(detail || {});
  const at = nowISO();
  await db.transaction(async () => {
    await db.prepare('SELECT pg_advisory_xact_lock(?)').get(7700000 + (Number(orgId) % 1000000));
    const prev = await db.prepare('SELECT hash FROM tre_log WHERE org_id = ? ORDER BY id DESC LIMIT 1').get(orgId);
    const row = { orgId, userId, action, entity: entity || '', entityId: entityId || null, detail: d.slice(0, 1500), at };
    await db.prepare('INSERT INTO tre_log (org_id, user_id, action, entity, entity_id, detail, prev_hash, hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(orgId, userId || null, action, row.entity, row.entityId, row.detail, prev ? prev.hash : '', hashOf(prev ? prev.hash : '', row), at);
  })();
}
/** Relit la chaîne : renvoie la première ligne dont l'empreinte ne correspond plus (null = chaîne intacte). */
async function verifyChain(orgId) {
  const rows = await db.prepare('SELECT * FROM tre_log WHERE org_id = ? ORDER BY id').all(orgId);
  let prev = '';
  for (const r of rows) {
    const row = { orgId: Number(r.org_id), userId: r.user_id === null ? null : Number(r.user_id), action: r.action, entity: r.entity, entityId: r.entity_id === null ? null : Number(r.entity_id), detail: r.detail, at: r.created_at };
    if (r.prev_hash !== prev || r.hash !== hashOf(prev, row)) return { ok: false, brokenAt: Number(r.id), count: rows.length };
    prev = r.hash;
  }
  return { ok: true, brokenAt: null, count: rows.length };
}

// ---------- Catégories de flux ----------
// section : exploitation / investissement / financement (tableau des flux). account : contrepartie comptable par défaut.
const CATEGORIES = {
  customer: { label: 'Clients', dir: 'in', account: '411', section: 'operating', group: 'clients' },
  advance_in: { label: 'Acompte client', dir: 'in', account: '419', section: 'operating', group: 'clients' },
  other_income: { label: 'Autre encaissement', dir: 'in', account: '758', section: 'operating', group: 'autres' },
  interest_in: { label: 'Intérêts reçus', dir: 'in', account: '771', section: 'financing', group: 'financiers' },
  loan_in: { label: 'Emprunt reçu', dir: 'in', account: '162', section: 'financing', group: 'emprunts' },
  capital_in: { label: 'Apport en capital', dir: 'in', account: '101', section: 'financing', group: 'capital' },
  asset_sale: { label: 'Cession d\'immobilisation', dir: 'in', account: '821', section: 'investing', group: 'investissements' },
  supplier: { label: 'Fournisseurs', dir: 'out', account: '401', section: 'operating', group: 'fournisseurs' },
  advance_out: { label: 'Acompte fournisseur', dir: 'out', account: '409', section: 'operating', group: 'fournisseurs' },
  salary: { label: 'Salaires', dir: 'out', account: '422', section: 'operating', group: 'personnel' },
  social: { label: 'Cotisations sociales', dir: 'out', account: '431', section: 'operating', group: 'personnel' },
  tax: { label: 'Impôts et taxes', dir: 'out', account: '447', section: 'operating', group: 'impots' },
  vat: { label: 'TVA reversée', dir: 'out', account: '4441', section: 'operating', group: 'impots' },
  rent: { label: 'Loyers', dir: 'out', account: '622', section: 'operating', group: 'fournisseurs' },
  fees: { label: 'Frais bancaires', dir: 'out', account: '631', section: 'operating', group: 'autres' },
  other_expense: { label: 'Autre décaissement', dir: 'out', account: '658', section: 'operating', group: 'autres' },
  loan_repay: { label: 'Remboursement d\'emprunt', dir: 'out', account: '162', section: 'financing', group: 'emprunts' },
  interest_out: { label: 'Intérêts payés', dir: 'out', account: '671', section: 'financing', group: 'financiers' },
  dividends: { label: 'Dividendes', dir: 'out', account: '465', section: 'financing', group: 'capital' },
  capex: { label: 'Investissement', dir: 'out', account: '244', section: 'investing', group: 'investissements' },
};
const catView = () => Object.entries(CATEGORIES).map(([k, v]) => ({ key: k, label: v.label, dir: v.dir, account: v.account, section: v.section }));
const GROUPS = { clients: 'Clients', fournisseurs: 'Fournisseurs', personnel: 'Personnel', impots: 'Impôts et taxes', emprunts: 'Emprunts', financiers: 'Produits et frais financiers', capital: 'Capital', investissements: 'Investissements', autres: 'Autres' };

// ---------- Comptes de trésorerie ----------
const KINDS = { bank: { root: '521', journal: 'BQ', label: 'Banque' }, cash: { root: '571', journal: 'CA', label: 'Caisse' }, mobile: { root: '589', journal: 'MM', label: 'Mobile money' } };
const PROVIDERS = ['MTN MoMo', 'Orange Money', 'Autre'];

/** Choisit le compte comptable d'un nouveau compte de trésorerie : le compte racine s'il est libre, sinon un sous-compte (5212, 5213…) créé au plan de l'organisation. */
async function allocateGl(orgId, kind, label) {
  const root = KINDS[kind].root;
  const used = new Set((await db.prepare('SELECT gl_account FROM tre_accounts WHERE org_id = ?').all(orgId)).map((r) => r.gl_account));
  let code = root;
  for (let n = 2; used.has(code); n++) code = `${root}${n}`;
  if (!await db.prepare('SELECT 1 FROM acc_accounts WHERE org_id = ? AND code = ?').get(orgId, code)) {
    await db.prepare('INSERT OR IGNORE INTO acc_accounts (org_id, code, label, custom) VALUES (?, ?, ?, ?)').run(orgId, code, String(label).slice(0, 80), code === root ? 0 : 1);
  }
  return code;
}

async function accountsOf(orgId, { active = true } = {}) {
  return await db.prepare(`SELECT * FROM tre_accounts WHERE org_id = ?${active ? ' AND active = 1' : ''} ORDER BY id`).all(orgId);
}

/** Solde comptable (en monnaie de l'organisation) d'un compte de classe 5 à une date. */
async function glBalance(orgId, gl, date) {
  const r = await db.prepare('SELECT COALESCE(SUM(l.debit), 0) - COALESCE(SUM(l.credit), 0) AS b FROM acc_lines l JOIN acc_entries e ON e.id = l.entry_id WHERE l.org_id = ? AND l.account = ? AND e.date <= ?').get(orgId, gl, date);
  return num(r.b);
}

// ---------- Taux de change ----------
async function rates(org) {
  const rows = await db.prepare('SELECT currency, rate FROM tre_fx WHERE org_id = ?').all(org.id);
  const m = { [org.currency]: 1 };
  for (const r of rows) m[r.currency] = Number(r.rate);
  return m;
}
const toBase = (native, cur, rt) => Math.round(Number(native) * (rt[cur] || 0));

/** Vue d'un compte : solde comptable, solde en devise d'origine (comptes étrangers), solde consolidé converti au taux courant. */
async function accountView(org, a, rt, date = today()) {
  const gl = await glBalance(org.id, a.gl_account, date);
  const cur = a.currency || org.currency;
  const foreign = cur !== org.currency;
  let native = gl;
  if (foreign) {
    const r = await db.prepare(`SELECT COALESCE(SUM(CASE WHEN account_id = ? THEN -amount WHEN to_account_id = ? THEN COALESCE(amount_to, 0) END), 0) AS n FROM tre_ops WHERE org_id = ? AND status = 'posted' AND date <= ? AND kind = 'transfer' AND (account_id = ? OR to_account_id = ?)`)
      .get(a.id, a.id, org.id, date, a.id, a.id);
    const io = await db.prepare(`SELECT COALESCE(SUM(CASE WHEN kind = 'receipt' THEN amount ELSE -amount END), 0) AS n FROM tre_ops WHERE org_id = ? AND status = 'posted' AND date <= ? AND account_id = ? AND kind <> 'transfer'`).get(org.id, date, a.id);
    native = num(a.native_open) + num(r.n) + num(io.n);
  }
  const rate = rt[cur];
  const consolidated = foreign ? (rate ? Math.round(native * rate) : gl) : gl;
  const pend = await db.prepare(`SELECT COALESCE(SUM(CASE WHEN kind = 'receipt' THEN amount_base WHEN kind = 'payment' THEN -amount_base WHEN kind = 'transfer' AND account_id = ? THEN -amount_base ELSE 0 END), 0) AS p FROM tre_ops WHERE org_id = ? AND status IN ('prepared', 'half') AND (account_id = ? OR to_account_id = ?)`).get(a.id, org.id, a.id, a.id);
  const pendIn = await db.prepare("SELECT COALESCE(SUM(amount_base), 0) AS p FROM tre_ops WHERE org_id = ? AND status IN ('prepared', 'half') AND kind = 'transfer' AND to_account_id = ?").get(org.id, a.id);
  return {
    id: Number(a.id), name: a.name, kind: a.kind, provider: a.provider, accountNo: a.account_no, currency: cur, branchId: a.branch_id === null ? null : Number(a.branch_id),
    glAccount: a.gl_account, bankId: a.bank_id === null ? null : Number(a.bank_id), active: Boolean(num(a.active)),
    bookBalance: gl, nativeBalance: native, consolidated, rate: rate || null, fxGap: foreign && rate ? consolidated - gl : 0, pending: num(pend.p) + num(pendIn.p),
  };
}

module.exports = {
  today, addDays, diffDays, addMonths, lastDay, toMs, num, isMonth, treRole, hasAccess, isManager, need, settings, log, verifyChain, CATEGORIES, catView, GROUPS, isCash, classify,
  KINDS, PROVIDERS, allocateGl, accountsOf, glBalance, rates, toBase, accountView, DEFAULT_PROVISION, DEFAULT_TARGETS,
};
