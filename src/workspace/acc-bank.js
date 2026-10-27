'use strict';
// Comptabilité · rapprochement bancaire : comptes bancaires, import CSV de relevé (format détecté), pointage manuel et suggestions
// automatiques (montant, date, référence), écarts. Document de travail : le rapprochement ne modifie jamais les écritures.
const crypto = require('crypto');
const express = require('express');
const { db, nowISO } = require('../db');
const A = require('./access');
const { HttpError } = require('../util');

const router = express.Router({ mergeParams: true });
const accounting = () => require('./accounting'); // require paresseux
const today = () => nowISO().slice(0, 10);
const GL = ['521', '589', '571'];
const JOURNAL = { 521: 'BQ', 589: 'MM', 571: 'CA' };

// ---------- Lecture d'un CSV de relevé ----------
/** Découpe un CSV en lignes de cellules (guillemets, séparateur donné). */
function splitCsv(text, delim) {
  const rows = []; let row = []; let cur = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; continue; }
    if (c === '"') q = true;
    else if (c === delim) { row.push(cur); cur = ''; } else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); if (row.some((x) => x.trim() !== '')) rows.push(row); row = []; cur = ''; } else cur += c;
  }
  row.push(cur);
  if (row.some((x) => x.trim() !== '')) rows.push(row);
  return rows;
}
const DATE_RE = /^\s*(\d{1,4})[/.\-](\d{1,2})[/.\-](\d{1,4})\s*$/;
const isDateCell = (s) => DATE_RE.test(String(s || '')) && !/^\s*\d+[.,]\d+\s*$/.test(s);
const NUM_RE = /^[\s ]*[-+(]?[\s ]*\d[\d\s .,']*[)]?[\s ]*(?:F?CFA|XAF|XOF|FCFA|F)?[\s ]*(?:CR|DB|C|D|-)?[\s ]*$/i;

function guessDelimiter(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 15);
  let best = ';'; let bestScore = -1;
  for (const d of [';', '\t', ',', '|']) {
    const counts = lines.map((l) => splitCsv(l, d)[0].length - 1);
    const mode = counts.sort((a, b) => a - b)[Math.floor(counts.length / 2)] || 0;
    const stable = counts.filter((c) => c === mode).length;
    const score = mode > 0 ? stable * 100 + mode : 0;
    if (score > bestScore) { bestScore = score; best = d; }
  }
  return best;
}

/** Détecte le format : séparateur, en-tête, colonnes, format de date, séparateur décimal. */
function detect(text, over = {}) {
  const clean = String(text || '').replace(/^﻿/, '');
  const delimiter = over.delimiter || guessDelimiter(clean);
  const rows = splitCsv(clean, delimiter);
  if (rows.length < 1) throw new HttpError(400, 'Le fichier est vide.');
  const width = Math.max(...rows.slice(0, 20).map((r) => r.length));
  const firstHasDate = rows[0].some(isDateCell);
  const hasHeader = over.skipHeader !== undefined ? Boolean(over.skipHeader) : !firstHasDate && rows[0].some((c) => /[a-zA-Zéèà]/.test(c));
  const header = hasHeader ? rows[0].map((c) => c.trim().toLowerCase()) : [];
  const body = hasHeader ? rows.slice(1) : rows;
  const find = (re, not) => header.findIndex((h, i) => re.test(h) && !(not && not.includes(i)));
  let cols = { date: -1, label: -1, ref: -1, debit: -1, credit: -1, amount: -1, balance: -1 };
  if (hasHeader) {
    cols.date = find(/^date(?!.*valeur)|^jour|^day|date op|date de l/) >= 0 ? find(/^date(?!.*valeur)|^jour|^day|date op|date de l/) : find(/date/);
    cols.balance = find(/solde|balance/);
    cols.debit = find(/d[ée]bit|retrait|sortie|withdraw|paid out|\bout\b/);
    cols.credit = find(/cr[ée]dit|d[ée]p[oô]t|entr[ée]e|deposit|paid in|\bin\b/);
    cols.amount = find(/montant|amount|somme/, [cols.debit, cols.credit]);
    cols.ref = find(/r[ée]f|pi[èe]ce|transaction|op[ée]ration n|n[°o]\s|\bid\b|num/);
    cols.label = find(/libell|label|description|d[ée]tail|intitul|motif|nature|narr|objet/, [cols.ref]);
  }
  // Colonnes manquantes : déduites du contenu.
  const sample = body.slice(0, 30);
  const col = (i) => sample.map((r) => (r[i] || '').trim()).filter(Boolean);
  if (cols.date < 0) cols.date = Array.from({ length: width }, (_, i) => i).find((i) => col(i).length && col(i).every(isDateCell));
  if (cols.date === undefined) cols.date = -1;
  const numeric = Array.from({ length: width }, (_, i) => i).filter((i) => i !== cols.date && col(i).length && col(i).every((c) => NUM_RE.test(c)));
  if (cols.amount < 0 && cols.debit < 0 && cols.credit < 0 && numeric.length) {
    if (numeric.length === 1) cols.amount = numeric[0];
    else if (numeric.length >= 2) { cols.debit = numeric[0]; cols.credit = numeric[1]; if (numeric[2] !== undefined && cols.balance < 0) cols.balance = numeric[2]; }
  }
  if (cols.label < 0) {
    const texts = Array.from({ length: width }, (_, i) => i).filter((i) => ![cols.date, cols.amount, cols.debit, cols.credit, cols.balance, cols.ref].includes(i));
    cols.label = texts.sort((a, b) => col(b).join('').length - col(a).join('').length)[0] ?? -1;
  }
  for (const k of Object.keys(cols)) if (over[k + 'Col'] !== undefined && over[k + 'Col'] !== '') cols[k] = Number(over[k + 'Col']);
  // Format de date
  const dates = sample.map((r) => r[cols.date]).filter(isDateCell).map((s) => DATE_RE.exec(s));
  let dateFormat = over.dateFormat || '';
  let ambiguous = false;
  if (!dateFormat) {
    if (dates.some((m) => m[1].length === 4)) dateFormat = 'ymd';
    else if (dates.some((m) => Number(m[1]) > 12)) dateFormat = 'dmy';
    else if (dates.some((m) => Number(m[2]) > 12)) dateFormat = 'mdy';
    else { dateFormat = 'dmy'; ambiguous = dates.length > 0; }
  }
  // Séparateur décimal
  const nums = [cols.amount, cols.debit, cols.credit, cols.balance].filter((i) => i >= 0).flatMap((i) => col(i));
  let decimal = over.decimal || '';
  if (!decimal) decimal = nums.some((n) => /,\d{1,2}\s*\D*$/.test(n)) && !nums.some((n) => /\.\d{1,2}\s*\D*$/.test(n)) ? ',' : nums.some((n) => /\.\d{1,2}\s*\D*$/.test(n)) ? '.' : ',';
  return { delimiter, hasHeader, header, cols, dateFormat, decimal, ambiguousDate: ambiguous, rows: body, total: body.length };
}

function toDate(s, fmt) {
  const m = DATE_RE.exec(String(s || ''));
  if (!m) return null;
  let y; let mo; let d;
  if (fmt === 'ymd') [y, mo, d] = [m[1], m[2], m[3]];
  else if (fmt === 'mdy') [y, mo, d] = [m[3], m[1], m[2]];
  else [y, mo, d] = [m[3], m[2], m[1]];
  if (String(y).length === 2) y = '20' + y;
  const iso = `${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const dt = new Date(iso + 'T00:00:00Z');
  return Number.isNaN(dt.getTime()) || dt.toISOString().slice(0, 10) !== iso ? null : iso;
}
function toAmount(s, decimal) {
  let t = String(s == null ? '' : s).trim();
  if (!t) return null;
  if (!NUM_RE.test(t)) return NaN;
  let neg = /^\(.*\)$/.test(t) || /^-/.test(t) || /-\s*$/.test(t) || /\bDB?\s*$/i.test(t);
  t = t.replace(/[^\d.,]/g, '');
  if (decimal === ',') t = t.replace(/\./g, '').replace(',', '.'); else t = t.replace(/,/g, '');
  const n = Number(t);
  if (!Number.isFinite(n)) return NaN;
  neg = neg && n !== 0;
  return neg ? -Math.round(n) : Math.round(n);
}

/** Transforme le CSV en lignes de relevé { date, label, reference, amount, balance } et liste les lignes refusées. */
function parseStatement(text, over) {
  const d = detect(text, over);
  if (d.cols.date < 0) throw new HttpError(400, 'Colonne « date » introuvable : vérifiez le fichier ou indiquez les colonnes.');
  if (d.cols.amount < 0 && d.cols.debit < 0 && d.cols.credit < 0) throw new HttpError(400, 'Colonne « montant » (ou débit / crédit) introuvable.');
  const lines = []; const invalid = [];
  d.rows.forEach((r, i) => {
    const n = i + 1 + (d.hasHeader ? 1 : 0);
    const date = toDate(r[d.cols.date], d.dateFormat);
    if (!date) { if (r.some((c) => String(c).trim())) invalid.push({ row: n, reason: 'date illisible' }); return; }
    let amount;
    if (d.cols.amount >= 0) amount = toAmount(r[d.cols.amount], d.decimal);
    else {
      const db_ = d.cols.debit >= 0 ? toAmount(r[d.cols.debit], d.decimal) : null; const cr = d.cols.credit >= 0 ? toAmount(r[d.cols.credit], d.decimal) : null;
      if (Number.isNaN(db_) || Number.isNaN(cr)) amount = NaN;
      else amount = (cr ? Math.abs(cr) : 0) - (db_ ? Math.abs(db_) : 0);
    }
    if (amount === null || Number.isNaN(amount) || amount === 0) { invalid.push({ row: n, reason: 'montant illisible ou nul' }); return; }
    if (Math.abs(amount) > 1e12) { invalid.push({ row: n, reason: 'montant trop élevé' }); return; }
    const bal = d.cols.balance >= 0 ? toAmount(r[d.cols.balance], d.decimal) : null;
    lines.push({ date, label: String(r[d.cols.label] || '').trim().slice(0, 200), reference: String(d.cols.ref >= 0 ? r[d.cols.ref] || '' : '').trim().slice(0, 80), amount, balance: Number.isNaN(bal) ? null : bal });
  });
  return { detected: { delimiter: d.delimiter === '\t' ? 'tab' : d.delimiter, hasHeader: d.hasHeader, columns: d.cols, header: d.header, dateFormat: d.dateFormat, decimal: d.decimal, ambiguousDate: d.ambiguousDate }, lines, invalid };
}

// ---------- Comptes bancaires ----------
const bankOf = async (req, id) => {
  const b = await db.prepare('SELECT * FROM bank_accounts WHERE id = ? AND org_id = ?').get(A.id(id), req.org.id);
  if (!b) throw new HttpError(404, 'Compte bancaire introuvable.');
  return b;
};
const bankView = (b, st) => ({ id: b.id, name: b.name, glAccount: b.gl_account, accountNo: b.account_no, ...(st || {}) });

router.get('/', async (req, res) => {
  const rows = await db.prepare('SELECT * FROM bank_accounts WHERE org_id = ? ORDER BY id').all(req.org.id);
  const out = [];
  for (const b of rows) {
    const c = await db.prepare("SELECT COUNT(*) n, COALESCE(SUM(CASE WHEN status = 'unmatched' THEN 1 ELSE 0 END), 0) u FROM bank_lines WHERE bank_id = ?").get(b.id);
    out.push(bankView(b, { lines: c.n, unmatched: c.u }));
  }
  res.json({ banks: out, notice: 'Document de travail : le rapprochement ne modifie pas vos écritures.' });
});
router.post('/', async (req, res) => {
  const b = req.body || {};
  const gl = A.oneOf(b.glAccount, GL, '521', 'Compte comptable : banque (521), mobile money (589) ou caisse (571).');
  const id = (await db.prepare('INSERT INTO bank_accounts (org_id, name, gl_account, account_no, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(req.org.id, A.text(b.name, 80, { required: true, msg: 'Indiquez le nom du compte (ex. Afriland, MTN MoMo).' }), gl, A.text(b.accountNo, 60), nowISO())).lastInsertRowid;
  res.status(201).json({ id: Number(id) });
});
router.delete('/:id', async (req, res) => {
  const b = await bankOf(req, req.params.id);
  if ((await db.prepare('SELECT COUNT(*) c FROM bank_lines WHERE bank_id = ?').get(b.id)).c) throw new HttpError(400, 'Ce compte a des lignes de relevé : supprimez-les d\'abord.');
  await db.prepare('DELETE FROM bank_accounts WHERE id = ?').run(b.id);
  res.json({ ok: true });
});

// ---------- Import ----------
const lineHash = (bankId, l, k) => crypto.createHash('sha1').update([bankId, l.date, l.amount, l.label.toLowerCase(), l.reference, k].join('|')).digest('hex');

router.post('/:id/import', async (req, res) => {
  const bank = await bankOf(req, req.params.id);
  const b = req.body || {};
  const text = typeof b.csv === 'string' ? b.csv : '';
  if (!text.trim()) throw new HttpError(400, 'Collez ou chargez le contenu du relevé (CSV).');
  if (text.length > 1.5e6) throw new HttpError(400, 'Fichier trop volumineux (1,5 Mo au plus).');
  const parsed = parseStatement(text, b.mapping || {});
  if (b.dryRun) return res.json({ dryRun: true, detected: parsed.detected, valid: parsed.lines.length, invalid: parsed.invalid.slice(0, 20), preview: parsed.lines.slice(0, 10) });
  if (!parsed.lines.length) throw new HttpError(400, 'Aucune ligne exploitable dans ce fichier.');
  const seen = new Map(); let added = 0; let dup = 0;
  await db.transaction(async () => {
    for (const l of parsed.lines) {
      const base = [l.date, l.amount, l.label.toLowerCase(), l.reference].join('|');
      const k = seen.get(base) || 0; seen.set(base, k + 1);
      const r = await db.prepare('INSERT INTO bank_lines (org_id, bank_id, date, label, reference, amount, balance, hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING')
        .run(req.org.id, bank.id, l.date, l.label, l.reference, l.amount, l.balance, lineHash(bank.id, l, k), nowISO());
      if (r.changes) added++; else dup++;
    }
  })();
  await A.logActivity(req.org.id, req.user.id, 'accounting', `Relevé importé (${bank.name}) : ${added} ligne(s)`);
  res.status(201).json({ imported: added, duplicates: dup, invalid: parsed.invalid.slice(0, 50), detected: parsed.detected });
});

// ---------- Lignes, suggestions, pointage ----------
const lineView = (l) => ({ id: l.id, bankId: l.bank_id, date: l.date, label: l.label, reference: l.reference, amount: l.amount, balance: l.balance, status: l.status, accLineId: l.acc_line_id });

router.get('/:id/lines', async (req, res) => {
  const bank = await bankOf(req, req.params.id);
  const st = ['unmatched', 'matched', 'ignored'].includes(req.query.status) ? req.query.status : null;
  const rows = await db.prepare(`SELECT * FROM bank_lines WHERE bank_id = ?${st ? ' AND status = ?' : ''} ORDER BY date DESC, id DESC LIMIT 500`).all(...(st ? [bank.id, st] : [bank.id]));
  res.json({ lines: rows.map(lineView) });
});

/** Lignes d'écriture du compte comptable lié, pas encore pointées. */
async function openGlLines(org, bank, from, to) {
  return await db.prepare(`SELECT l.id, l.entry_id, l.debit, l.credit, l.memo, e.number, e.date, e.label, e.piece, e.journal FROM acc_lines l JOIN acc_entries e ON e.id = l.entry_id
    WHERE l.org_id = ? AND l.account = ? AND e.date >= ? AND e.date <= ? AND NOT EXISTS (SELECT 1 FROM bank_lines b WHERE b.acc_line_id = l.id) ORDER BY e.date, l.id`).all(org.id, bank.gl_account, from, to);
}
const dayDiff = (a, b) => Math.abs(Math.round((Date.parse(a) - Date.parse(b)) / 86400000));
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const words = (s) => new Set(String(s || '').toLowerCase().split(/[^a-z0-9àâéèêîôûç]+/).filter((w) => w.length >= 4));

/** Suggestions : même montant (obligatoire), écart de dates (jusqu'à `window` jours), référence ou libellé en commun. */
function suggest(bankLines, glLines, window) {
  const used = new Set();
  const out = [];
  for (const bl of bankLines) {
    const cands = [];
    for (const g of glLines) {
      if (g.debit - g.credit !== bl.amount) continue;
      const days = dayDiff(bl.date, g.date);
      if (days > window) continue;
      const reasons = ['montant identique'];
      let score = 50 - days * 2;
      if (days === 0) reasons.push('même date'); else reasons.push(`${days} jour(s) d'écart`);
      const ref = norm(bl.reference);
      const targets = [g.piece, g.number, g.memo, g.label].map(norm);
      if (ref.length >= 3 && targets.some((t) => t && (t.includes(ref) || ref.includes(t)))) { score += 40; reasons.push('référence trouvée'); }
      else {
        const wb = words(bl.label); const wg = new Set([...words(g.label), ...words(g.memo), ...words(g.piece)]);
        const common = [...wb].filter((w) => wg.has(w));
        if (common.length) { score += 10 + 5 * Math.min(common.length, 3); reasons.push('libellé proche'); }
        const pn = norm(g.piece);
        if (pn.length >= 3 && norm(bl.label).includes(pn)) { score += 30; reasons.push('pièce citée dans le libellé'); }
      }
      cands.push({ accLineId: g.id, entryId: g.entry_id, number: g.number, date: g.date, label: g.label, piece: g.piece, amount: g.debit - g.credit, score, reasons });
    }
    cands.sort((a, b) => b.score - a.score);
    if (cands.length) {
      const top = cands[0];
      const confidence = top.score >= 85 || (cands.length === 1 && top.score >= 44) ? 'high' : 'medium';
      out.push({ bankLineId: bl.id, confidence, candidates: cands.slice(0, 3) });
      if (confidence === 'high' && cands.length === 1) used.add(top.accLineId);
    }
  }
  return out;
}

router.get('/:id/suggestions', async (req, res) => {
  const bank = await bankOf(req, req.params.id);
  const window = Math.min(Math.max(Number(req.query.window) || 10, 0), 60);
  const lines = await db.prepare("SELECT * FROM bank_lines WHERE bank_id = ? AND status = 'unmatched' ORDER BY date, id LIMIT 500").all(bank.id);
  if (!lines.length) return res.json({ suggestions: [] });
  const shift = (d, n) => new Date(Date.parse(d) + n * 86400000).toISOString().slice(0, 10);
  const gl = await openGlLines(req.org, bank, shift(lines[0].date, -window), shift(lines[lines.length - 1].date, window));
  res.json({ suggestions: suggest(lines, gl, window), window });
});

async function matchOne(req, bank, bankLineId, accLineId) {
  const bl = await db.prepare('SELECT * FROM bank_lines WHERE id = ? AND bank_id = ?').get(A.id(bankLineId), bank.id);
  if (!bl) throw new HttpError(404, 'Ligne de relevé introuvable.');
  if (bl.status === 'matched') throw new HttpError(409, 'Cette ligne est déjà pointée.');
  const g = await db.prepare('SELECT l.*, e.date FROM acc_lines l JOIN acc_entries e ON e.id = l.entry_id WHERE l.id = ? AND l.org_id = ?').get(A.id(accLineId), req.org.id);
  if (!g || g.account !== bank.gl_account) throw new HttpError(400, `Cette ligne d'écriture n'appartient pas au compte ${bank.gl_account}.`);
  if (g.debit - g.credit !== bl.amount) throw new HttpError(400, `Les montants diffèrent (relevé ${bl.amount}, comptabilité ${g.debit - g.credit}) : corrigez par une écriture, puis pointez.`);
  if (await db.prepare('SELECT 1 FROM bank_lines WHERE acc_line_id = ?').get(g.id)) throw new HttpError(409, 'Cette ligne comptable est déjà pointée avec une autre ligne du relevé.');
  await db.prepare("UPDATE bank_lines SET status = 'matched', acc_line_id = ?, matched_by = ?, matched_at = ? WHERE id = ? AND status <> 'matched'").run(g.id, req.user.id, nowISO(), bl.id);
}

router.post('/lines/:lineId/match', async (req, res) => {
  const bl = await db.prepare('SELECT * FROM bank_lines WHERE id = ? AND org_id = ?').get(A.id(req.params.lineId), req.org.id);
  if (!bl) throw new HttpError(404, 'Ligne de relevé introuvable.');
  await matchOne(req, await bankOf(req, bl.bank_id), bl.id, (req.body || {}).accLineId);
  res.json({ ok: true });
});
router.post('/:id/match-many', async (req, res) => {
  const bank = await bankOf(req, req.params.id);
  const pairs = Array.isArray((req.body || {}).pairs) ? req.body.pairs.slice(0, 200) : [];
  const out = { matched: 0, failed: [] };
  for (const p of pairs) {
    try { await matchOne(req, bank, (p || {}).bankLineId, (p || {}).accLineId); out.matched++; } catch (e) { if (!(e instanceof HttpError)) throw e; out.failed.push({ bankLineId: (p || {}).bankLineId, reason: e.message }); }
  }
  res.json(out);
});
router.post('/lines/:lineId/unmatch', async (req, res) => {
  const r = await db.prepare("UPDATE bank_lines SET status = 'unmatched', acc_line_id = NULL, matched_by = NULL, matched_at = NULL WHERE id = ? AND org_id = ? AND status IN ('matched', 'ignored')").run(A.id(req.params.lineId), req.org.id);
  if (!r.changes) throw new HttpError(404, 'Ligne introuvable ou non pointée.');
  res.json({ ok: true });
});
router.post('/lines/:lineId/ignore', async (req, res) => {
  const r = await db.prepare("UPDATE bank_lines SET status = 'ignored' WHERE id = ? AND org_id = ? AND status = 'unmatched'").run(A.id(req.params.lineId), req.org.id);
  if (!r.changes) throw new HttpError(404, 'Ligne introuvable ou déjà traitée.');
  res.json({ ok: true });
});
router.delete('/lines/:lineId', async (req, res) => {
  const r = await db.prepare("DELETE FROM bank_lines WHERE id = ? AND org_id = ? AND status <> 'matched'").run(A.id(req.params.lineId), req.org.id);
  if (!r.changes) throw new HttpError(404, 'Ligne introuvable ou pointée (dépointez-la d\'abord).');
  res.json({ ok: true });
});

// Crée l'écriture manquante d'une ligne du relevé (frais bancaires, intérêts…) et la pointe aussitôt.
router.post('/lines/:lineId/post', async (req, res) => {
  const bl = await db.prepare('SELECT * FROM bank_lines WHERE id = ? AND org_id = ?').get(A.id(req.params.lineId), req.org.id);
  if (!bl) throw new HttpError(404, 'Ligne de relevé introuvable.');
  if (bl.status !== 'unmatched') throw new HttpError(409, 'Cette ligne est déjà traitée.');
  const bank = await bankOf(req, bl.bank_id);
  const account = String((req.body || {}).account || '').trim();
  if (!account || account === bank.gl_account) throw new HttpError(400, 'Indiquez le compte de contrepartie (ex. 631 frais bancaires).');
  const amt = Math.abs(bl.amount);
  const lines = bl.amount < 0 ? [{ account, debit: amt, memo: bl.label.slice(0, 100) }, { account: bank.gl_account, credit: amt, memo: bl.reference }] : [{ account: bank.gl_account, debit: amt, memo: bl.reference }, { account, credit: amt, memo: bl.label.slice(0, 100) }];
  const acc = accounting();
  const r = await acc.recordEntry(req.org, req.user.id, { journal: JOURNAL[bank.gl_account], date: bl.date, label: A.text((req.body || {}).label, 200) || `Relevé : ${bl.label}`.slice(0, 200) || 'Relevé bancaire', piece: bl.reference || `REL-${bl.id}`, lines, source: 'bank_line', sourceId: bl.id });
  const gl = await db.prepare('SELECT id FROM acc_lines WHERE entry_id = ? AND account = ? ORDER BY id LIMIT 1').get(r.id, bank.gl_account);
  await matchOne(req, bank, bl.id, gl.id);
  res.status(201).json({ ok: true, entry: r.number });
});

// ---------- Écarts ----------
router.get('/:id/summary', async (req, res) => {
  const bank = await bankOf(req, req.params.id);
  const asOf = A.date(req.query.asOf) || today();
  const glRow = await db.prepare(`SELECT COALESCE(SUM(l.debit - l.credit), 0) b FROM acc_lines l JOIN acc_entries e ON e.id = l.entry_id WHERE l.org_id = ? AND l.account = ? AND e.date <= ?`).get(req.org.id, bank.gl_account, asOf);
  const last = await db.prepare('SELECT balance FROM bank_lines WHERE bank_id = ? AND balance IS NOT NULL AND date <= ? ORDER BY date DESC, id DESC LIMIT 1').get(bank.id, asOf);
  const ub = (await db.prepare("SELECT * FROM bank_lines WHERE bank_id = ? AND status = 'unmatched' AND date <= ? ORDER BY date, id").all(bank.id, asOf)).map(lineView);
  const ug = (await openGlLines(req.org, bank, '0000-01-01', asOf)).map((g) => ({ accLineId: g.id, entryId: g.entry_id, number: g.number, date: g.date, label: g.label, piece: g.piece, amount: g.debit - g.credit }));
  const ubSum = ub.reduce((a, l) => a + l.amount, 0); const ugSum = ug.reduce((a, g) => a + g.amount, 0);
  const statement = last ? Number(last.balance) : null;
  const expected = glRow.b + ubSum - ugSum; // solde du relevé attendu si tout est expliqué
  res.json({
    asOf, glAccount: bank.gl_account, glBalance: glRow.b, statementBalance: statement,
    unmatchedBank: ub.slice(0, 200), unmatchedBankTotal: ubSum, unmatchedBankCount: ub.length,
    unmatchedGl: ug.slice(0, 200), unmatchedGlTotal: ugSum, unmatchedGlCount: ug.length,
    expectedStatement: expected, gap: statement === null ? null : statement - expected,
    note: statement === null ? "Le relevé ne contient pas de colonne « solde » : l'écart ne peut pas être calculé, mais les lignes non pointées sont listées." : 'Écart nul = tout ce qui diffère entre le relevé et la comptabilité est expliqué par les lignes non pointées.',
  });
});

module.exports = router;
module.exports.parseStatement = parseStatement;
module.exports.detect = detect;
