'use strict';
// Trésorerie : rôles, réglages, comptes (banque, caisse, mobile money), taux de change, encaissements / décaissements / virements internes,
// double validation, rapprochement bancaire et journal de traçabilité.
// Chaque opération validée passe UNE écriture équilibrée par accounting.recordEntry() (mois clôturés respectés, jamais modifiée : une erreur s'annule par une écriture inverse).
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const T = require('./tre-lib');
const { HttpError } = require('../util');

const router = express.Router({ mergeParams: true });
const accounting = () => require('./accounting');
const { num, today } = T;
const any = T.need('any'); const mgr = T.need('manager'); const adm = T.need('admin');
const ROLES = ['manager', 'treasurer'];

// ---------- Moi, rôles ----------
router.get('/me', any, async (req, res) => {
  const role = await T.treRole(req); const st = await T.settings(req.org.id);
  const manager = await T.isManager(req);
  res.json({ role, canApprove: manager, canConfigure: manager, canAssign: role === 'admin', userId: req.user.id, threshold: st.approvalThreshold, strictSeparation: st.strictSeparation });
});

router.get('/roles', any, async (req, res) => {
  const members = await db.prepare('SELECT m.user_id, m.role AS org_role, m.title, u.name FROM org_members m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? ORDER BY m.id').all(req.org.id);
  const roles = new Map((await db.prepare('SELECT user_id, role FROM tre_roles WHERE org_id = ?').all(req.org.id)).map((r) => [Number(r.user_id), r.role]));
  res.json({ members: members.map((m) => ({ userId: Number(m.user_id), name: m.name, orgRole: m.org_role, title: m.title, treRole: ['owner', 'admin'].includes(m.org_role) ? 'admin' : roles.get(Number(m.user_id)) || '' })), assignable: req.member && A.can(req, 'admin') });
});

router.put('/roles/:userId', adm, async (req, res) => {
  const uid = A.id(req.params.userId, 'Personne invalide.');
  const m = await db.prepare('SELECT role FROM org_members WHERE org_id = ? AND user_id = ?').get(req.org.id, uid);
  if (!m) throw new HttpError(404, 'Personne introuvable.');
  if (['owner', 'admin'].includes(m.role)) throw new HttpError(400, 'Le propriétaire et les administrateurs ont déjà tous les droits de trésorerie.');
  const role = A.oneOf((req.body || {}).role, [...ROLES, ''], '', 'Rôle inconnu : responsable de trésorerie ou trésorier.');
  const before = (await db.prepare('SELECT role FROM tre_roles WHERE org_id = ? AND user_id = ?').get(req.org.id, uid) || {}).role || '';
  if (role === 'manager' && before !== 'manager') {
    // un seul responsable de trésorerie à la fois (en plus du propriétaire et des administrateurs)
    const cur = await db.prepare("SELECT user_id FROM tre_roles WHERE org_id = ? AND role = 'manager' AND user_id <> ?").get(req.org.id, uid);
    if (cur) throw new HttpError(409, 'Un responsable de trésorerie est déjà désigné : retirez-lui ce rôle avant d\'en nommer un autre.');
  }
  if (!role) await db.prepare('DELETE FROM tre_roles WHERE org_id = ? AND user_id = ?').run(req.org.id, uid);
  else await db.prepare('INSERT INTO tre_roles (org_id, user_id, role, created_by, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (org_id, user_id) DO UPDATE SET role = EXCLUDED.role, created_by = EXCLUDED.created_by, created_at = EXCLUDED.created_at').run(req.org.id, uid, role, req.user.id, nowISO());
  await T.log(req.org.id, req.user.id, 'role', 'user', uid, { from: before, to: role });
  require('./w3').push(req.org.id, uid, 'treasury', role ? (role === 'manager' ? 'Vous êtes désigné(e) responsable de trésorerie.' : 'Vous êtes désigné(e) trésorier(ère).') : 'Votre rôle de trésorerie a été retiré.', 'treasury').catch(() => {});
  res.json({ ok: true });
});

// ---------- Réglages ----------
router.get('/settings', any, async (req, res) => res.json({ settings: await T.settings(req.org.id), categories: T.catView() }));
router.put('/settings', mgr, async (req, res) => {
  const b = req.body || {}; const cur = await T.settings(req.org.id);
  const int = (v, d, lo, hi, msg) => { if (v === undefined) return d; const n = Math.round(Number(typeof v === 'string' ? v.replace(/\s/g, '').replace(',', '.') : v)); if (!Number.isFinite(n) || n < lo || n > hi) throw new HttpError(400, msg); return n; };
  const next = {
    approvalThreshold: int(b.approvalThreshold, cur.approvalThreshold, 0, 1e12, 'Seuil de double validation invalide.'),
    safetyMode: A.oneOf(b.safetyMode, ['days', 'amount'], cur.safetyMode, 'Fonds de sécurité : en jours de charges ou en montant.'),
    safetyDays: int(b.safetyDays, cur.safetyDays, 0, 730, 'Nombre de jours invalide (0 à 730).'),
    safetyAmount: int(b.safetyAmount, cur.safetyAmount, 0, 1e12, 'Montant du fonds de sécurité invalide.'),
    minBalance: int(b.minBalance, cur.minBalance, 0, 1e12, 'Solde minimal invalide.'),
    payday: int(b.payday, cur.payday, 1, 28, 'Jour de paie invalide (1 à 28).'),
    includeTrend: b.includeTrend === undefined ? cur.includeTrend : Boolean(b.includeTrend),
    strictSeparation: b.strictSeparation === undefined ? cur.strictSeparation : Boolean(b.strictSeparation),
    provision: { ...cur.provision }, targets: { ...cur.targets },
  };
  if (b.provision) for (const k of Object.keys(T.DEFAULT_PROVISION)) if (b.provision[k] !== undefined) next.provision[k] = int(b.provision[k], 0, 0, 100, 'Taux de provision : entre 0 et 100 %.');
  if (b.targets) for (const k of Object.keys(T.DEFAULT_TARGETS)) if (b.targets[k] !== undefined) next.targets[k] = int(b.targets[k], 0, 0, 730, 'Objectif en jours invalide (0 à 730).');
  if (b.strictSeparation === false && !A.can(req, 'admin')) throw new HttpError(403, 'Seul un administrateur peut assouplir la séparation des tâches.');
  await db.prepare(`UPDATE tre_settings SET approval_threshold = ?, safety_mode = ?, safety_days = ?, safety_amount = ?, min_balance = ?, payday = ?, include_trend = ?, strict_separation = ?, provision_json = ?, targets_json = ?, updated_by = ?, updated_at = ? WHERE org_id = ?`)
    .run(next.approvalThreshold, next.safetyMode, next.safetyDays, next.safetyAmount, next.minBalance, next.payday, next.includeTrend ? 1 : 0, next.strictSeparation ? 1 : 0, JSON.stringify(next.provision), JSON.stringify(next.targets), req.user.id, nowISO(), req.org.id);
  await T.log(req.org.id, req.user.id, 'settings', 'settings', null, { before: cur, after: next });
  res.json({ settings: await T.settings(req.org.id) });
});

// ---------- Comptes de trésorerie ----------
router.get('/accounts', any, async (req, res) => {
  const rt = await T.rates(req.org); const list = [];
  for (const a of await T.accountsOf(req.org.id, { active: false })) list.push(await T.accountView(req.org, a, rt));
  const act = list.filter((a) => a.active);
  const byCur = {}; for (const a of act) byCur[a.currency] = (byCur[a.currency] || 0) + a.nativeBalance;
  const byKind = {}; for (const a of act) byKind[a.kind] = (byKind[a.kind] || 0) + a.consolidated;
  const branches = await db.prepare('SELECT id, name FROM branches WHERE org_id = ?').all(req.org.id);
  const byBranch = {}; for (const a of act) { const n = a.branchId ? (branches.find((b) => Number(b.id) === a.branchId) || {}).name || '—' : '—'; byBranch[n] = (byBranch[n] || 0) + a.consolidated; }
  res.json({ currency: req.org.currency, accounts: list, rates: rt, consolidated: { total: act.reduce((s, a) => s + a.consolidated, 0), byCurrency: byCur, byKind, byBranch, pending: act.reduce((s, a) => s + a.pending, 0) }, kinds: Object.entries(T.KINDS).map(([k, v]) => ({ key: k, label: v.label })), providers: T.PROVIDERS });
});

router.post('/accounts', mgr, async (req, res) => {
  const b = req.body || {};
  const kind = A.oneOf(b.kind, Object.keys(T.KINDS), undefined, 'Type de compte : banque, caisse ou mobile money.');
  const name = A.text(b.name, 80, { required: true, msg: 'Indiquez le nom du compte (ex. Afriland, MTN MoMo, Caisse siège).' });
  const currency = (A.text(b.currency, 10) || req.org.currency).toUpperCase();
  const rt = await T.rates(req.org);
  if (currency !== req.org.currency && !rt[currency]) throw new HttpError(400, `Indiquez d'abord le taux de change ${currency} → ${req.org.currency} (onglet Comptes › Taux de change).`);
  const branch = await A.branchOf(req, b.branchId);
  const native = b.nativeOpen === undefined || b.nativeOpen === '' || Number(b.nativeOpen) === 0 ? 0 : A.amount(b.nativeOpen);
  if (native && currency === req.org.currency) throw new HttpError(400, "Le solde d'ouverture d'un compte en monnaie locale vient de la comptabilité (à-nouveaux).");
  const out = await db.transaction(async () => {
    const gl = await T.allocateGl(req.org.id, kind, name);
    const bankId = (await db.prepare('INSERT INTO bank_accounts (org_id, name, gl_account, account_no, created_at) VALUES (?, ?, ?, ?, ?)').run(req.org.id, name, gl, A.text(b.accountNo, 60), nowISO())).lastInsertRowid; // le rapprochement bancaire de la Comptabilité utilise ce compte
    const id = (await db.prepare('INSERT INTO tre_accounts (org_id, name, kind, provider, account_no, currency, branch_id, gl_account, bank_id, native_open, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(req.org.id, name, kind, kind === 'mobile' ? A.text(b.provider, 40) : '', A.text(b.accountNo, 60), currency, branch, gl, bankId, native, req.user.id, nowISO())).lastInsertRowid;
    return { id: Number(id), gl };
  })();
  await T.log(req.org.id, req.user.id, 'account.create', 'account', out.id, { name, kind, currency, gl: out.gl });
  res.status(201).json({ id: out.id, glAccount: out.gl });
});

router.put('/accounts/:id', mgr, async (req, res) => {
  const a = await accountOf(req, req.params.id); const b = req.body || {};
  const name = A.text(b.name, 80) || a.name; const branch = b.branchId === undefined ? a.branch_id : await A.branchOf(req, b.branchId);
  const active = b.active === undefined ? num(a.active) : (b.active ? 1 : 0);
  if (!active && num(a.active)) { const bal = await T.glBalance(req.org.id, a.gl_account, '9999-12-31'); if (bal !== 0) throw new HttpError(400, 'Ce compte a encore un solde : videz-le par un virement avant de le désactiver.'); }
  await db.prepare('UPDATE tre_accounts SET name = ?, branch_id = ?, active = ?, provider = ?, account_no = ? WHERE id = ?').run(name, branch, active, b.provider === undefined ? a.provider : A.text(b.provider, 40), b.accountNo === undefined ? a.account_no : A.text(b.accountNo, 60), a.id);
  await T.log(req.org.id, req.user.id, 'account.update', 'account', a.id, { name, active: Boolean(active) });
  res.json({ ok: true });
});

router.put('/fx/:currency', mgr, async (req, res) => {
  const cur = String(req.params.currency || '').toUpperCase().slice(0, 10);
  if (!/^[A-Z]{3,10}$/.test(cur) || cur === req.org.currency) throw new HttpError(400, 'Devise invalide.');
  const rate = Number(String((req.body || {}).rate).replace(',', '.'));
  if (!Number.isFinite(rate) || rate <= 0 || rate > 1e9) throw new HttpError(400, 'Taux invalide : indiquez combien vaut une unité de cette devise dans votre monnaie.');
  await db.prepare('INSERT INTO tre_fx (org_id, currency, rate, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (org_id, currency) DO UPDATE SET rate = EXCLUDED.rate, updated_at = EXCLUDED.updated_at').run(req.org.id, cur, rate, nowISO());
  await T.log(req.org.id, req.user.id, 'fx', 'currency', null, { currency: cur, rate });
  res.json({ ok: true });
});

async function accountOf(req, id) {
  const a = await db.prepare('SELECT * FROM tre_accounts WHERE id = ? AND org_id = ?').get(A.id(id, 'Compte invalide.'), req.org.id);
  if (!a) throw new HttpError(404, 'Compte de trésorerie introuvable.');
  return a;
}

// ---------- Opérations ----------
const opView = (o, names) => ({
  id: Number(o.id), kind: o.kind, category: String(o.category).split('|')[0], accountId: Number(o.account_id), toAccountId: o.to_account_id === null ? null : Number(o.to_account_id), date: o.date, amount: num(o.amount), amountTo: o.amount_to === null ? null : num(o.amount_to), amountBase: num(o.amount_base),
  label: o.label, counterparty: o.counterparty, refKind: o.ref_kind, refId: o.ref_id === null ? null : Number(o.ref_id), method: o.method, reference: o.reference, status: o.status, needDouble: Boolean(num(o.need_double)),
  preparedBy: Number(o.prepared_by), preparedByName: names.get(Number(o.prepared_by)) || '', preparedAt: o.prepared_at, approval1By: o.approval1_by === null ? null : Number(o.approval1_by), approval1ByName: names.get(Number(o.approval1_by)) || '', approval1At: o.approval1_at,
  approval2By: o.approval2_by === null ? null : Number(o.approval2_by), approval2ByName: names.get(Number(o.approval2_by)) || '', approval2At: o.approval2_at, rejectReason: o.reject_reason, entryId: o.entry_id === null ? null : Number(o.entry_id), postedAt: o.posted_at,
});
const namesOf = async (orgId) => new Map((await db.prepare('SELECT u.id, u.name FROM org_members m JOIN users u ON u.id = m.user_id WHERE m.org_id = ?').all(orgId)).map((r) => [Number(r.id), r.name]));

router.get('/ops', any, async (req, res) => {
  const where = ['o.org_id = ?']; const args = [req.org.id];
  const st = String(req.query.status || '');
  if (st === 'pending') where.push("o.status IN ('prepared', 'half')"); else if (st) { where.push('o.status = ?'); args.push(A.oneOf(st, ['prepared', 'half', 'posted', 'rejected', 'cancelled'], undefined, 'Statut inconnu.')); }
  if (req.query.accountId) { where.push('(o.account_id = ? OR o.to_account_id = ?)'); const id = A.id(req.query.accountId); args.push(id, id); }
  const rows = await db.prepare(`SELECT o.* FROM tre_ops o WHERE ${where.join(' AND ')} ORDER BY o.date DESC, o.id DESC LIMIT 300`).all(...args);
  const names = await namesOf(req.org.id);
  const pending = num((await db.prepare("SELECT COUNT(*) c FROM tre_ops WHERE org_id = ? AND status IN ('prepared', 'half')").get(req.org.id)).c);
  res.json({ ops: rows.map((o) => opView(o, names)), pending });
});

/** Valide et prépare une opération (sans rien comptabiliser : c'est la validation qui comptabilise). */
router.post('/ops', any, async (req, res) => {
  const b = req.body || {};
  const kind = A.oneOf(b.kind, ['receipt', 'payment', 'transfer'], undefined, 'Type d\'opération : encaissement, décaissement ou virement interne.');
  const acc = await accountOf(req, b.accountId);
  if (!num(acc.active)) throw new HttpError(400, 'Ce compte est désactivé.');
  const date = A.date(b.date) || today();
  if (date > T.addDays(today(), 365)) throw new HttpError(400, 'Date trop éloignée.');
  const amount = A.amount(b.amount);
  const rt = await T.rates(req.org); const st = await T.settings(req.org.id);
  const cur = acc.currency || req.org.currency;
  if (!rt[cur]) throw new HttpError(400, `Taux de change ${cur} manquant.`);
  let category = ''; let acct = ''; let toAcc = null; let amountTo = null; let refKind = ''; let refId = null; let counterparty = A.text(b.counterparty, 100); let label = A.text(b.label, 160);
  const amountBase = T.toBase(amount, cur, rt);
  if (kind === 'transfer') {
    toAcc = await accountOf(req, b.toAccountId);
    if (Number(toAcc.id) === Number(acc.id)) throw new HttpError(400, 'Choisissez deux comptes différents.');
    if (!num(toAcc.active)) throw new HttpError(400, 'Le compte de destination est désactivé.');
    const tcur = toAcc.currency || req.org.currency; if (!rt[tcur]) throw new HttpError(400, `Taux de change ${tcur} manquant.`);
    amountTo = tcur === cur ? amount : (b.amountTo !== undefined && b.amountTo !== '' ? A.amount(b.amountTo) : Math.round(amountBase / rt[tcur]));
    if (tcur === cur && b.amountTo !== undefined && b.amountTo !== '' && A.amount(b.amountTo) !== amount) throw new HttpError(400, 'Un virement entre deux comptes de même monnaie garde le même montant (frais : saisissez-les à part).');
    category = 'transfer'; label = label || `Virement ${acc.name} → ${toAcc.name}`;
  } else {
    category = A.oneOf(b.category, Object.keys(T.CATEGORIES).filter((k) => T.CATEGORIES[k].dir === (kind === 'receipt' ? 'in' : 'out')), undefined, 'Catégorie inconnue pour ce type d\'opération.');
    if (b.refKind) {
      refKind = A.oneOf(b.refKind, ['invoice', 'bill'], undefined, 'Lien inconnu : facture client ou dette fournisseur.');
      if (cur !== req.org.currency) throw new HttpError(400, 'Un règlement lié à une facture se fait sur un compte en monnaie locale.');
      refId = A.id(b.refId, 'Document invalide.');
      if (refKind === 'invoice') {
        if (kind !== 'receipt' || category !== 'customer') throw new HttpError(400, 'Une facture client se règle par un encaissement de catégorie « Clients ».');
        const d = await db.prepare("SELECT d.*, c.name AS customer FROM documents d JOIN customers c ON c.id = d.customer_id WHERE d.id = ? AND d.org_id = ? AND d.kind = 'invoice'").get(refId, req.org.id);
        if (!d || d.status !== 'sent') throw new HttpError(400, 'Facture introuvable ou non envoyée.');
        const left = num(d.total) - num(d.paid) - num(d.credited);
        const queued = num((await db.prepare("SELECT COALESCE(SUM(amount), 0) s FROM tre_ops WHERE org_id = ? AND ref_kind = 'invoice' AND ref_id = ? AND status IN ('prepared', 'half')").get(req.org.id, refId)).s);
        if (amount > left - queued) throw new HttpError(400, `Ce montant dépasse le reste à encaisser (${left - queued}).`);
        counterparty = counterparty || d.customer; label = label || `Encaissement facture ${d.number}`;
      } else {
        if (kind !== 'payment' || category !== 'supplier') throw new HttpError(400, 'Une dette fournisseur se règle par un décaissement de catégorie « Fournisseurs ».');
        const d = await db.prepare("SELECT b.*, COALESCE(NULLIF(b.supplier_name, ''), s.name, '') AS party FROM supplier_bills b LEFT JOIN suppliers s ON s.id = b.supplier_id WHERE b.id = ? AND b.org_id = ?").get(refId, req.org.id);
        if (!d || !['open', 'partial'].includes(d.status)) throw new HttpError(400, 'Dette introuvable ou déjà réglée.');
        const left = num(d.amount) - num(d.paid);
        const queued = num((await db.prepare("SELECT COALESCE(SUM(amount), 0) s FROM tre_ops WHERE org_id = ? AND ref_kind = 'bill' AND ref_id = ? AND status IN ('prepared', 'half')").get(req.org.id, refId)).s);
        if (amount > left - queued) throw new HttpError(400, `Ce montant dépasse le reste à payer (${left - queued}).`);
        counterparty = counterparty || d.party; label = label || `Règlement ${d.party} ${d.number}`.trim();
      }
    }
    label = label || T.CATEGORIES[category].label;
    if (b.account) { const code = String(b.account).trim(); if (!await db.prepare('SELECT 1 FROM acc_accounts WHERE org_id = ? AND code = ?').get(req.org.id, code)) throw new HttpError(400, `Compte inconnu : ${code}.`); acct = code; }
  }
  const needDouble = amountBase > st.approvalThreshold ? 1 : 0;
  const reference = A.text(b.reference, 80);
  if (kind !== 'transfer' && reference && await db.prepare("SELECT 1 FROM tre_ops WHERE org_id = ? AND account_id = ? AND reference = ? AND kind = ? AND status IN ('prepared', 'half', 'posted')").get(req.org.id, acc.id, reference, kind)) throw new HttpError(409, 'Cette référence est déjà utilisée sur ce compte.');
  const id = (await db.prepare(`INSERT INTO tre_ops (org_id, kind, category, account_id, to_account_id, date, amount, amount_to, amount_base, label, counterparty, ref_kind, ref_id, method, reference, status, need_double, prepared_by, prepared_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?, ?)`).run(req.org.id, kind, acct ? `${category}|${acct}` : category, acc.id, toAcc ? toAcc.id : null, date, amount, amountTo, amountBase, label, counterparty, refKind, refId, A.text(b.method, 30), reference, needDouble, req.user.id, nowISO())).lastInsertRowid;
  await T.log(req.org.id, req.user.id, 'op.prepare', 'op', Number(id), { kind, category, amount, cur, date, needDouble: Boolean(needDouble) });
  // prévenir les valideurs
  const mgrs = await db.prepare("SELECT user_id FROM tre_roles WHERE org_id = ? AND role = 'manager'").all(req.org.id);
  for (const m of mgrs) if (Number(m.user_id) !== req.user.id) require('./w3').push(req.org.id, Number(m.user_id), 'treasury', `Opération de trésorerie à valider : ${label} (${amount.toLocaleString('fr-FR')}).`, `op-${id}`).catch(() => {});
  res.status(201).json({ id: Number(id), needDouble: Boolean(needDouble), status: 'prepared' });
});

async function opOf(req, id) {
  const o = await db.prepare('SELECT * FROM tre_ops WHERE id = ? AND org_id = ?').get(A.id(id, 'Opération invalide.'), req.org.id);
  if (!o) throw new HttpError(404, 'Opération introuvable.');
  return o;
}

/** Comptabilise l'opération (appelé dans la transaction de la dernière validation). */
async function post(req, o) {
  const acc = await db.prepare('SELECT * FROM tre_accounts WHERE id = ?').get(o.account_id);
  const cat = String(o.category).split('|'); const catKey = cat[0]; const meta = T.CATEGORIES[catKey];
  const k = T.KINDS[acc.kind]; const gl = acc.gl_account; const base = num(o.amount_base); const date = o.date;
  const lines = []; let journal = k.journal; let source = 'tre_op'; let sourceId = Number(o.id); let payRow = null; let piece = o.reference || `TRE-${o.id}`;
  if (o.kind === 'transfer') {
    const to = await db.prepare('SELECT * FROM tre_accounts WHERE id = ?').get(o.to_account_id);
    const rt = await T.rates(req.org); const tcur = to.currency || req.org.currency;
    const inBase = T.toBase(num(o.amount_to), tcur, rt); const diff = inBase - base; journal = 'OD';
    lines.push({ account: to.gl_account, debit: inBase, memo: o.label.slice(0, 100) }, { account: gl, credit: base, memo: o.label.slice(0, 100) });
    if (diff > 0) lines.push({ account: '776', credit: diff, memo: 'Gain de change' });
    if (diff < 0) lines.push({ account: '676', debit: -diff, memo: 'Perte de change' });
  } else if (o.ref_kind === 'invoice') {
    const d = await db.prepare("SELECT d.*, c.name AS customer FROM documents d JOIN customers c ON c.id = d.customer_id WHERE d.id = ? AND d.org_id = ? FOR UPDATE OF d").get(o.ref_id, req.org.id);
    const left = num(d.total) - num(d.paid) - num(d.credited);
    if (d.status !== 'sent' || num(o.amount) > left) throw new HttpError(409, `La facture ${d.number} a changé : l'encaissement dépasse son reste dû (${left}).`);
    const method = acc.kind === 'cash' ? 'cash' : acc.kind === 'mobile' ? (/orange/i.test(acc.provider) ? 'orange_money' : 'mtn_momo') : 'transfer';
    payRow = Number((await db.prepare("INSERT INTO doc_payments (org_id, doc_id, amount, date, created_by, created_at, method, reference, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'confirmed')").run(req.org.id, d.id, o.amount, date, o.prepared_by, nowISO(), method, o.reference)).lastInsertRowid);
    const paid = num(d.paid) + num(o.amount);
    await db.prepare('UPDATE documents SET paid = ?, status = ?, updated_at = ? WHERE id = ?').run(paid, paid >= num(d.total) - num(d.credited) ? 'paid' : 'sent', nowISO(), d.id);
    lines.push({ account: gl, debit: base, memo: o.reference }, { account: '411', credit: base, memo: d.customer });
    source = 'payment'; sourceId = payRow; piece = o.reference || d.number;
  } else if (o.ref_kind === 'bill') {
    const bl = await db.prepare("SELECT b.*, COALESCE(NULLIF(b.supplier_name, ''), s.name, '') AS party FROM supplier_bills b LEFT JOIN suppliers s ON s.id = b.supplier_id WHERE b.id = ? AND b.org_id = ? FOR UPDATE OF b").get(o.ref_id, req.org.id);
    const left = num(bl.amount) - num(bl.paid);
    if (!['open', 'partial'].includes(bl.status) || num(o.amount) > left) throw new HttpError(409, `La dette ${bl.number || bl.id} a changé : le règlement dépasse son reste à payer (${left}).`);
    await db.prepare("UPDATE supplier_bills SET paid = paid + ?, status = CASE WHEN paid + ? >= amount THEN 'paid' ELSE 'partial' END WHERE id = ?").run(o.amount, o.amount, bl.id);
    payRow = Number((await db.prepare('INSERT INTO supplier_payments (org_id, bill_id, amount, date, method, reference, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(req.org.id, bl.id, o.amount, date, acc.kind === 'cash' ? 'cash' : acc.kind === 'mobile' ? 'mobile' : 'bank', o.reference, o.prepared_by, nowISO())).lastInsertRowid);
    lines.push({ account: '401', debit: base, memo: bl.party }, { account: gl, credit: base, memo: o.reference });
    source = 'supplier_payment'; sourceId = payRow; piece = o.reference || bl.number || `FF-${bl.id}`;
  } else {
    const counter = cat[1] || meta.account;
    if (o.kind === 'receipt') lines.push({ account: gl, debit: base, memo: o.counterparty.slice(0, 100) }, { account: counter, credit: base, memo: o.label.slice(0, 100) });
    else lines.push({ account: counter, debit: base, memo: o.label.slice(0, 100) }, { account: gl, credit: base, memo: o.counterparty.slice(0, 100) });
  }
  const e = await accounting().recordEntry(req.org, req.user.id, { journal, date, label: o.label.slice(0, 200), piece: String(piece).slice(0, 60), lines, source, sourceId });
  if (e.existing && source === 'tre_op') throw new HttpError(409, 'Cette opération est déjà comptabilisée.');
  await db.prepare("UPDATE tre_ops SET status = 'posted', entry_id = ?, pay_row_id = ?, posted_at = ? WHERE id = ?").run(e.id, payRow, nowISO(), o.id);
  return e;
}

router.post('/ops/:id/approve', mgr, async (req, res) => {
  const st = await T.settings(req.org.id); let entry = null; let state;
  await db.transaction(async () => {
    const o = await db.prepare('SELECT * FROM tre_ops WHERE id = ? AND org_id = ? FOR UPDATE').get(A.id(req.params.id, 'Opération invalide.'), req.org.id);
    if (!o) throw new HttpError(404, 'Opération introuvable.');
    if (!['prepared', 'half'].includes(o.status)) throw new HttpError(409, 'Cette opération est déjà traitée.');
    const uid = req.user.id; const prep = Number(o.prepared_by) === uid;
    if (o.status === 'half' && Number(o.approval1_by) === uid) throw new HttpError(403, 'Double validation : la seconde validation doit venir d\'une autre personne que la première.');
    if (prep && (st.strictSeparation || num(o.need_double))) throw new HttpError(403, 'Séparation des tâches : vous ne pouvez pas valider une opération que vous avez préparée.');
    if (o.status === 'prepared' && num(o.need_double)) {
      await db.prepare("UPDATE tre_ops SET status = 'half', approval1_by = ?, approval1_at = ? WHERE id = ?").run(uid, nowISO(), o.id);
      await T.log(req.org.id, uid, 'op.approve1', 'op', Number(o.id), { amount: num(o.amount_base) });
      state = 'half'; return;
    }
    if (o.status === 'half') await db.prepare('UPDATE tre_ops SET approval2_by = ?, approval2_at = ? WHERE id = ?').run(uid, nowISO(), o.id);
    else await db.prepare('UPDATE tre_ops SET approval1_by = ?, approval1_at = ? WHERE id = ?').run(uid, nowISO(), o.id);
    entry = await post(req, { ...o, status: o.status });
    await T.log(req.org.id, uid, 'op.post', 'op', Number(o.id), { entry: entry.number, amount: num(o.amount_base) });
    state = 'posted';
  })();
  await A.logActivity(req.org.id, req.user.id, 'treasury', state === 'posted' ? 'Opération de trésorerie validée et comptabilisée' : 'Première validation d\'une opération de trésorerie');
  res.json({ status: state, entry: entry ? entry.number : null });
});

router.post('/ops/:id/reject', mgr, async (req, res) => {
  const o = await opOf(req, req.params.id);
  if (!['prepared', 'half'].includes(o.status)) throw new HttpError(409, 'Cette opération est déjà traitée.');
  const reason = A.text((req.body || {}).reason, 200, { required: true, msg: 'Indiquez le motif du refus.' });
  await db.prepare("UPDATE tre_ops SET status = 'rejected', rejected_by = ?, rejected_at = ?, reject_reason = ? WHERE id = ? AND status IN ('prepared', 'half')").run(req.user.id, nowISO(), reason, o.id);
  await T.log(req.org.id, req.user.id, 'op.reject', 'op', Number(o.id), { reason });
  require('./w3').push(req.org.id, Number(o.prepared_by), 'treasury', `Opération refusée : ${o.label} — ${reason}`, `op-${o.id}`).catch(() => {});
  res.json({ ok: true });
});

/** Retire une opération non validée (son auteur ou un responsable) ; une opération comptabilisée s'annule par une écriture inverse (responsable). */
router.post('/ops/:id/cancel', any, async (req, res) => {
  const o = await opOf(req, req.params.id); const manager = await T.isManager(req);
  if (['rejected', 'cancelled'].includes(o.status)) throw new HttpError(409, 'Cette opération est déjà annulée.');
  if (o.status !== 'posted') {
    if (Number(o.prepared_by) !== req.user.id && !manager) throw new HttpError(403, 'Seul son auteur ou un responsable peut retirer cette opération.');
    await db.prepare("UPDATE tre_ops SET status = 'cancelled', cancelled_by = ?, cancelled_at = ? WHERE id = ?").run(req.user.id, nowISO(), o.id);
    await T.log(req.org.id, req.user.id, 'op.cancel', 'op', Number(o.id), {});
    return res.json({ ok: true });
  }
  if (!manager) throw new HttpError(403, 'Seul un responsable peut annuler une opération comptabilisée.');
  const reason = A.text((req.body || {}).reason, 200, { required: true, msg: 'Indiquez le motif de l\'annulation.' });
  await db.transaction(async () => {
    const r = await accounting().reverseEntry(req.org, req.user.id, Number(o.entry_id), today(), { source: 'tre_op_rev', sourceId: Number(o.id) });
    if (o.ref_kind === 'invoice' && o.pay_row_id) {
      await db.prepare("UPDATE doc_payments SET status = 'failed' WHERE id = ?").run(o.pay_row_id);
      await db.prepare("UPDATE documents SET paid = GREATEST(paid - ?, 0), status = 'sent', updated_at = ? WHERE id = ?").run(o.amount, nowISO(), o.ref_id);
    }
    if (o.ref_kind === 'bill' && o.pay_row_id) {
      await db.prepare('DELETE FROM supplier_payments WHERE id = ?').run(o.pay_row_id);
      await db.prepare("UPDATE supplier_bills SET paid = GREATEST(paid - ?, 0), status = CASE WHEN paid - ? <= 0 THEN 'open' ELSE 'partial' END WHERE id = ?").run(o.amount, o.amount, o.ref_id);
    }
    await db.prepare("UPDATE tre_ops SET status = 'cancelled', cancel_entry_id = ?, cancelled_by = ?, cancelled_at = ? WHERE id = ?").run(r.id, req.user.id, nowISO(), o.id);
    await T.log(req.org.id, req.user.id, 'op.reverse', 'op', Number(o.id), { reason, entry: r.number });
  })();
  res.json({ ok: true });
});

// ---------- Journal de traçabilité ----------
router.get('/log', mgr, async (req, res) => {
  const rows = await db.prepare('SELECT g.id, g.user_id, g.action, g.entity, g.entity_id, g.detail, g.hash, g.created_at, u.name FROM tre_log g LEFT JOIN users u ON u.id = g.user_id WHERE g.org_id = ? ORDER BY g.id DESC LIMIT 200').all(req.org.id);
  res.json({ log: rows.map((r) => ({ id: Number(r.id), userId: r.user_id === null ? null : Number(r.user_id), user: r.name || '', action: r.action, entity: r.entity, entityId: r.entity_id === null ? null : Number(r.entity_id), detail: r.detail, hash: r.hash.slice(0, 12), at: r.created_at })), chain: await T.verifyChain(req.org.id) });
});

// ---------- Rapprochement bancaire ----------
router.get('/reconcile', any, async (req, res) => {
  const out = [];
  for (const a of await T.accountsOf(req.org.id)) {
    const gl = await T.glBalance(req.org.id, a.gl_account, today());
    let bank = null;
    if (a.bank_id) {
      const c = await db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN status = 'unmatched' THEN 1 ELSE 0 END), 0) AS u, COALESCE(SUM(CASE WHEN status = 'unmatched' THEN amount ELSE 0 END), 0) AS ua FROM bank_lines WHERE bank_id = ? AND org_id = ?").get(a.bank_id, req.org.id);
      const last = await db.prepare('SELECT balance, date FROM bank_lines WHERE bank_id = ? AND org_id = ? AND balance IS NOT NULL ORDER BY date DESC, id DESC LIMIT 1').get(a.bank_id, req.org.id);
      const unGl = await db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(l.debit - l.credit), 0) s FROM acc_lines l JOIN acc_entries e ON e.id = l.entry_id WHERE l.org_id = ? AND l.account = ? AND NOT EXISTS (SELECT 1 FROM bank_lines b WHERE b.acc_line_id = l.id)`).get(req.org.id, a.gl_account);
      bank = { lines: num(c.n), unmatched: num(c.u), unmatchedAmount: num(c.ua), statementBalance: last ? num(last.balance) : null, statementDate: last ? last.date : null, glUnmatched: num(unGl.n), glUnmatchedAmount: num(unGl.s) };
      bank.gap = bank.statementBalance === null ? null : bank.statementBalance - (gl + bank.unmatchedAmount - bank.glUnmatchedAmount);
    }
    out.push({ accountId: Number(a.id), name: a.name, kind: a.kind, glAccount: a.gl_account, bookBalance: gl, bank });
  }
  res.json({ accounts: out, note: 'Les relevés se chargent et se pointent dans Comptabilité › Banque ; cet état reprend le résultat par compte de trésorerie.' });
});

module.exports = router;
module.exports.post = post;
