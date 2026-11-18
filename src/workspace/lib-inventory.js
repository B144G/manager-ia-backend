'use strict';
// Bibliothèque — inventaire (récolement) et suivi des ressources : campagnes avec lecture de codes, écarts (manquants, en trop, mal placés),
// pertes, acquisitions, statistiques d'usage (les plus empruntés, jamais empruntés ni consultés).
// Une campagne photographie les ressources PHYSIQUES attendues au départ ; chaque lecture de code est comparée à cette liste.
const { db, nowISO } = require('../db');
const A = require('./access');
const T = require('./lib-text');
const { HttpError, cleanText } = require('../util');

const DAY = 86400000;

module.exports = function register(router, h) {
  const { audit } = h;
  const R = () => h.recordHelpers;
  Object.assign(h.ACTIONS, { inventory_start: 'Inventaire ouvert', inventory_scan: 'Lecture d’inventaire', inventory_close: 'Inventaire clos' });

  async function loadInv(req, idv) {
    const inv = await db.prepare('SELECT * FROM lib_inventories WHERE id = ? AND org_id = ?').get(A.id(idv, 'Inventaire invalide.'), req.org.id);
    if (!inv) throw new HttpError(404, 'Inventaire introuvable.');
    return inv;
  }
  async function report(req, inv) {
    const vis = await R().visibility(req);
    const lines = await db.prepare('SELECT l.*, r.title, r.inventory_no, r.call_number, r.location AS cur_location, r.status, r.acquired_price FROM lib_inventory_lines l LEFT JOIN lib_records r ON r.id = l.record_id WHERE l.inventory_id = ? ORDER BY l.id').all(inv.id);
    const recs = new Map();
    const ids = lines.filter((l) => l.record_id).map((l) => Number(l.record_id));
    if (ids.length) for (const r of await db.prepare(`${R().RECORD_SQL} WHERE r.org_id = ? AND r.id IN (${ids.map(() => '?').join(',')})`).all(req.org.id, ...ids)) recs.set(Number(r.id), r);
    const out = { ok: [], misplaced: [], missing: [], onLoan: [], extra: [], unknown: [] };
    const norm = (s) => T.norm(s);
    for (const l of lines) {
      const base = { id: Number(l.id), recordId: l.record_id ? Number(l.record_id) : null, title: l.title || '', inventoryNo: l.inventory_no || l.unknown_code || '', expectedLocation: l.expected_location, foundLocation: l.found_location, scannedAt: l.scanned_at, value: Number(l.acquired_price || 0) };
      if (!l.record_id) { out.unknown.push({ ...base, code: l.unknown_code }); continue; }
      const rec = recs.get(Number(l.record_id)); if (!rec || !vis.canSee(rec)) continue; // un écart sur une ressource invisible n'est pas montré
      if (!Number(l.expected)) { out.extra.push(base); continue; }
      if (l.scanned_at) { (l.found_location && norm(l.expected_location) && norm(l.found_location) !== norm(l.expected_location) ? out.misplaced : out.ok).push(base); continue; }
      (['loaned', 'reserved'].includes(l.status) ? out.onLoan : out.missing).push({ ...base, status: l.status });
    }
    const expectedN = out.ok.length + out.misplaced.length + out.missing.length + out.onLoan.length;
    return { ...out, counts: { expected: expectedN, found: out.ok.length + out.misplaced.length, ok: out.ok.length, misplaced: out.misplaced.length, missing: out.missing.length, onLoan: out.onLoan.length, extra: out.extra.length, unknown: out.unknown.length }, progress: expectedN ? Math.round(((out.ok.length + out.misplaced.length + out.onLoan.length) / expectedN) * 100) : 100 };
  }
  const view = (i, names) => ({ id: Number(i.id), name: i.name, scopeType: i.scope_type, scopeValue: i.scope_value, status: i.status, startedBy: names[Number(i.started_by)] || '', startedAt: i.started_at, closedAt: i.closed_at, note: i.note });

  router.get('/inventories', A.need('manager'), async (req, res) => {
    const rows = await db.prepare('SELECT * FROM lib_inventories WHERE org_id = ? ORDER BY id DESC LIMIT 100').all(req.org.id);
    const names = await h.namesOf(rows.map((x) => x.started_by)); const out = [];
    for (const i of rows) out.push({ ...view(i, names), counts: (await report(req, i)).counts });
    res.json({ inventories: out });
  });
  router.post('/inventories', A.need('manager'), async (req, res) => {
    const b = req.body || {};
    const name = A.text(b.name, 120, { required: true, msg: 'Indiquez le nom de l’inventaire.' });
    const scopeType = A.oneOf(b.scopeType, ['all', 'location', 'class'], 'all', 'Périmètre inconnu.');
    const scopeValue = scopeType === 'all' ? '' : cleanText(String(b.scopeValue || ''), 120);
    if (scopeType !== 'all' && !scopeValue) throw new HttpError(400, 'Précisez l’emplacement ou la classe de l’inventaire.');
    const vis = await R().visibility(req); const cls = await R().classMap(req.org.id);
    let classSet = null;
    if (scopeType === 'class') { classSet = R().subtree(cls, A.id(scopeValue, 'Classe invalide.')); if (!cls.has(Number(scopeValue))) throw new HttpError(400, 'Classe inconnue.'); }
    const recs = (await R().visibleRecords(req, vis)).filter((r) => !r.doc_id && r.status !== 'withdrawn' && (scopeType === 'all' || (scopeType === 'location' ? T.norm(r.location).startsWith(T.norm(scopeValue)) : r.class_id && classSet.has(Number(r.class_id)))));
    if (!recs.length) throw new HttpError(400, 'Aucune ressource physique dans ce périmètre.');
    const now = nowISO();
    const id = await db.transaction(async () => {
      const iid = Number((await db.prepare('INSERT INTO lib_inventories (org_id, name, scope_type, scope_value, started_by, started_at) VALUES (?, ?, ?, ?, ?, ?)').run(req.org.id, name, scopeType, scopeValue, req.user.id, now)).lastInsertRowid);
      for (const r of recs) await db.prepare('INSERT INTO lib_inventory_lines (org_id, inventory_id, record_id, expected, expected_location) VALUES (?, ?, ?, 1, ?)').run(req.org.id, iid, r.id, r.location);
      return iid;
    })();
    await audit(req, 'inventory_start', null, name);
    res.status(201).json({ id, expected: recs.length });
  });
  router.get('/inventories/:id', A.need('manager'), async (req, res) => {
    const inv = await loadInv(req, req.params.id); const names = await h.namesOf([inv.started_by]);
    res.json({ inventory: view(inv, names), report: await report(req, inv) });
  });
  router.post('/inventories/:id/scan', A.need('manager'), async (req, res) => {
    const inv = await loadInv(req, req.params.id);
    if (inv.status !== 'open') throw new HttpError(409, 'Cet inventaire est clos.');
    const code = cleanText(String((req.body || {}).code || ''), 60); if (!code) throw new HttpError(400, 'Code vide.');
    const location = cleanText(String((req.body || {}).location || ''), 120);
    const vis = await R().visibility(req);
    const rec = (await db.prepare(`${R().RECORD_SQL} WHERE r.org_id = ? AND r.deleted_at IS NULL AND (LOWER(r.inventory_no) = LOWER(?) OR LOWER(r.call_number) = LOWER(?)) LIMIT 5`).all(req.org.id, code, code)).filter(vis.canSee)[0];
    const now = nowISO(); let kind;
    if (!rec) {
      if (!await db.prepare('SELECT 1 FROM lib_inventory_lines WHERE inventory_id = ? AND unknown_code = ?').get(inv.id, code)) await db.prepare('INSERT INTO lib_inventory_lines (org_id, inventory_id, record_id, unknown_code, expected, scanned_at, scanned_by, found_location) VALUES (?, ?, NULL, ?, 0, ?, ?, ?)').run(req.org.id, inv.id, code, now, req.user.id, location || null);
      kind = 'unknown';
    } else {
      const line = await db.prepare('SELECT * FROM lib_inventory_lines WHERE inventory_id = ? AND record_id = ?').get(inv.id, rec.id);
      if (!line) { await db.prepare('INSERT INTO lib_inventory_lines (org_id, inventory_id, record_id, expected, expected_location, found_location, scanned_at, scanned_by) VALUES (?, ?, ?, 0, ?, ?, ?, ?)').run(req.org.id, inv.id, rec.id, rec.location, location || rec.location, now, req.user.id); kind = 'extra'; }
      else if (line.scanned_at) kind = 'already';
      else {
        await db.prepare('UPDATE lib_inventory_lines SET found_location = ?, scanned_at = ?, scanned_by = ? WHERE id = ?').run(location || line.expected_location, now, req.user.id, line.id);
        kind = Number(line.expected) && location && T.norm(line.expected_location) && T.norm(location) !== T.norm(line.expected_location) ? 'misplaced' : 'ok';
      }
    }
    res.json({ ok: true, kind, record: rec ? { id: Number(rec.id), title: rec.title, inventoryNo: rec.inventory_no, location: rec.location } : null });
  });
  router.post('/inventories/:id/close', A.need('manager'), async (req, res) => {
    const inv = await loadInv(req, req.params.id); const b = req.body || {};
    if (inv.status !== 'open') throw new HttpError(409, 'Cet inventaire est clos.');
    const rep = await report(req, inv); const now = nowISO(); let lost = 0; let moved = 0;
    await db.transaction(async () => {
      if (b.applyMissing) for (const m of rep.missing) { await db.prepare("UPDATE lib_records SET status = 'lost', condition = 'lost', lost_at = ?, updated_at = ? WHERE id = ? AND org_id = ? AND status = 'available'").run(now, now, m.recordId, req.org.id); lost++; }
      if (b.applyLocations) for (const m of rep.misplaced) { await db.prepare('UPDATE lib_records SET location = ?, updated_at = ? WHERE id = ? AND org_id = ?').run(m.foundLocation, now, m.recordId, req.org.id); moved++; }
      await db.prepare("UPDATE lib_inventories SET status = 'closed', closed_by = ?, closed_at = ?, note = ? WHERE id = ?").run(req.user.id, now, cleanText(String(b.note || ''), 300), inv.id);
    })();
    await audit(req, 'inventory_close', null, `${inv.name} : ${rep.counts.missing} manquant(s), ${rep.counts.misplaced} mal placé(s), ${rep.counts.extra} en trop`);
    res.json({ ok: true, markedLost: lost, relocated: moved, counts: rep.counts });
  });

  // ---------- Statistiques d'usage, acquisitions, pertes ----------
  router.get('/usage', A.need('manager'), async (req, res) => {
    const vis = await R().visibility(req); const recs = await R().visibleRecords(req, vis);
    const ids = new Set(recs.map((r) => Number(r.id))); const byId = new Map(recs.map((r) => [Number(r.id), r]));
    const now = Date.now(); const old = (r, days) => now - Date.parse(r.created_at) > days * DAY;
    const loans = (await db.prepare('SELECT record_id, loaned_at FROM lib_loans WHERE org_id = ?').all(req.org.id)).filter((l) => ids.has(Number(l.record_id)));
    const lc = new Map(); for (const l of loans) lc.set(Number(l.record_id), (lc.get(Number(l.record_id)) || 0) + 1);
    const cons = (await db.prepare("SELECT record_id, COUNT(*) AS c FROM lib_consult WHERE org_id = ? AND record_id IS NOT NULL GROUP BY record_id").all(req.org.id)).filter((x) => ids.has(Number(x.record_id)));
    const cc = new Map(cons.map((x) => [Number(x.record_id), Number(x.c)]));
    const top = (m, n) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([id, count]) => ({ id, title: byId.get(id).title, count }));
    const never = (cond) => recs.filter(cond).map((r) => ({ id: Number(r.id), title: r.title, inventoryNo: r.inventory_no, createdAt: r.created_at }));
    const neverBorrowed = never((r) => Number(r.loanable) && !r.doc_id && !lc.has(Number(r.id)) && old(r, 90));
    const neverConsulted = never((r) => !cc.has(Number(r.id)) && !lc.has(Number(r.id)) && old(r, 30));
    const acqYear = new Map(); for (const r of recs) if (r.acquired_at) { const y = r.acquired_at.slice(0, 4); const e = acqYear.get(y) || { year: y, count: 0, value: 0 }; e.count++; e.value += Number(r.acquired_price || 0); acqYear.set(y, e); }
    const lostRecs = recs.filter((r) => r.status === 'lost');
    const perMonth = new Map(); const d0 = new Date(); d0.setUTCDate(1);
    for (let i = 11; i >= 0; i--) { const d = new Date(d0); d.setUTCMonth(d0.getUTCMonth() - i); perMonth.set(d.toISOString().slice(0, 7), 0); }
    for (const l of loans) { const k = l.loaned_at.slice(0, 7); if (perMonth.has(k)) perMonth.set(k, perMonth.get(k) + 1); }
    const cond = new Map(); for (const r of recs.filter((x) => !x.doc_id)) cond.set(r.condition, (cond.get(r.condition) || 0) + 1);
    const lastInv = await db.prepare("SELECT * FROM lib_inventories WHERE org_id = ? AND status = 'closed' ORDER BY id DESC LIMIT 1").get(req.org.id);
    res.json({
      topBorrowed: top(lc, 10), topConsulted: top(cc, 10), neverBorrowed: neverBorrowed.length, neverBorrowedList: neverBorrowed.slice(0, 20), neverConsulted: neverConsulted.length, neverConsultedList: neverConsulted.slice(0, 20),
      acquisitions: [...acqYear.values()].sort((a, b) => a.year.localeCompare(b.year)), acquiredValue: [...acqYear.values()].reduce((a, e) => a + e.value, 0),
      recentAcquisitions: recs.filter((r) => r.acquired_at).sort((a, b) => b.acquired_at.localeCompare(a.acquired_at)).slice(0, 8).map((r) => ({ id: Number(r.id), title: r.title, acquiredAt: r.acquired_at, price: Number(r.acquired_price || 0) })),
      lost: { count: lostRecs.length, value: lostRecs.reduce((a, r) => a + Number(r.acquired_price || 0), 0), list: lostRecs.slice(0, 20).map((r) => ({ id: Number(r.id), title: r.title, inventoryNo: r.inventory_no, lostAt: r.lost_at, price: Number(r.acquired_price || 0) })) },
      loansPerMonth: [...perMonth.entries()].map(([month, count]) => ({ month, count })), conditions: [...cond.entries()].map(([value, count]) => ({ value, count })),
      lastInventory: lastInv ? { id: Number(lastInv.id), name: lastInv.name, closedAt: lastInv.closed_at, counts: (await report(req, lastInv)).counts } : null,
    });
  });
};
