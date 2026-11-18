'use strict';
// Bibliothèque — emprunts, retours, renouvellements, réservations (file d'attente), retards, rappels, pénalités et blocages.
// Une ressource est prêtée à un membre de l'organisation ; la file d'attente passe la ressource au premier réservant dès le retour.
const { db, nowISO } = require('../db');
const A = require('./access');
const W = require('./w3');
const { HttpError, cleanText, oneLine } = require('../util');

const DAY = 86400000;
const addDaysIso = (iso, n) => new Date(Date.parse(iso) + n * DAY).toISOString();
/** Jours de retard (tout jour commencé compte). */
const lateDays = (due, now = nowISO()) => (now > due ? Math.ceil((Date.parse(now) - Date.parse(due)) / DAY) : 0);

module.exports = function register(router, h) {
  const { audit } = h;
  const R = () => h.recordHelpers;
  Object.assign(h.ACTIONS, {
    loan: 'Prêt', loan_return: 'Retour', loan_renew: 'Prêt renouvelé', loan_lost: 'Ressource déclarée perdue', reserve: 'Réservation', reserve_cancel: 'Réservation annulée',
    borrower_block: 'Emprunteur bloqué', borrower_unblock: 'Blocage levé', fine_paid: 'Pénalité réglée', loan_reminders: 'Rappels de retour envoyés',
  });

  const isManager = (req) => A.can(req, 'manager');
  async function activeBlock(orgId, userId) {
    return db.prepare('SELECT * FROM lib_borrower_blocks WHERE org_id = ? AND user_id = ? AND lifted_at IS NULL AND until > ? ORDER BY until DESC LIMIT 1').get(orgId, userId, nowISO());
  }
  async function activeLoans(orgId, userId) {
    return Number((await db.prepare("SELECT COUNT(*) AS c FROM lib_loans WHERE org_id = ? AND user_id = ? AND state = 'active'").get(orgId, userId)).c);
  }
  const notify = (orgId, userId, text, ref) => W.push(orgId, userId, 'library', text, ref);

  /** Premier réservant en attente : la ressource lui est mise de côté pour N jours ; sinon elle redevient disponible. */
  async function promote(orgId, recordId) {
    const st = await R().catSettings(orgId);
    const next = await db.prepare("SELECT * FROM lib_reservations WHERE record_id = ? AND state = 'waiting' ORDER BY created_at, id LIMIT 1").get(recordId);
    const rec = await db.prepare('SELECT title, status FROM lib_records WHERE id = ?').get(recordId);
    if (!rec || ['lost', 'withdrawn'].includes(rec.status)) return null;
    if (!next) { await db.prepare("UPDATE lib_records SET status = 'available', updated_at = ? WHERE id = ?").run(nowISO(), recordId); return null; }
    const now = nowISO(); const until = addDaysIso(now, st.holdDays);
    await db.prepare("UPDATE lib_reservations SET state = 'ready', ready_at = ?, ready_until = ? WHERE id = ?").run(now, until, next.id);
    await db.prepare("UPDATE lib_records SET status = 'reserved', updated_at = ? WHERE id = ?").run(now, recordId);
    await notify(orgId, next.user_id, `« ${oneLine(rec.title, 70)} » est disponible pour vous jusqu'au ${until.slice(0, 10)}.`, `libres:${next.id}`);
    return next;
  }

  // ---------- Emprunter ----------
  router.post('/records/:id/loan', async (req, res) => {
    const b = req.body || {}; const rec = await R().loadRecord(req, req.params.id); const st = await R().catSettings(req.org.id);
    // Fusion : une ressource non prêtable donne le message clair (400) avant le refus d'accès générique (le droit « prêt » inclut « prêtable »).
    if (!Number(rec.loanable)) throw new HttpError(400, 'Cette ressource ne se prête pas.');
    if (!(await h.can(req, rec, 'loan'))) throw new HttpError(403, 'Votre accès ne permet pas cette action.');
    const target = b.userId !== undefined && b.userId !== null && b.userId !== '' ? await A.memberOf(req, b.userId) : req.user.id;
    if (Number(target) !== Number(req.user.id) && !isManager(req)) throw new HttpError(403, 'Seul un responsable peut enregistrer un prêt au nom d’une autre personne.');
    if (!Number(rec.loanable)) throw new HttpError(400, 'Cette ressource ne se prête pas.');
    if (['lost', 'withdrawn'].includes(rec.status)) throw new HttpError(400, 'Cette ressource est perdue ou retirée du catalogue.');
    const block = await activeBlock(req.org.id, target);
    if (block) throw new HttpError(403, 'Les prêts sont suspendus pour cette personne (retards non régularisés).');
    if (await activeLoans(req.org.id, target) >= st.maxLoans) throw new HttpError(400, 'Nombre maximal de prêts en cours atteint pour cette personne.');
    const mine = await db.prepare("SELECT * FROM lib_reservations WHERE record_id = ? AND user_id = ? AND state = 'ready'").get(rec.id, target);
    if (rec.status === 'loaned') throw new HttpError(400, 'Cette ressource est déjà empruntée : réservez-la pour être prévenu(e) du retour.');
    if (rec.status === 'reserved' && !mine) throw new HttpError(400, 'Cette ressource est mise de côté pour une autre personne.');
    let days = st.loanDays;
    if (b.days !== undefined && b.days !== null && b.days !== '') {
      days = Number(b.days);
      if (!Number.isInteger(days) || days < 1 || days > 365) throw new HttpError(400, 'Durée du prêt : entre 1 et 365 jours.');
      if (days > st.loanDays && !isManager(req)) throw new HttpError(403, 'Seul un responsable peut accorder une durée plus longue que la durée habituelle.');
    }
    const now = nowISO();
    const id = await db.transaction(async () => {
      const lid = Number((await db.prepare('INSERT INTO lib_loans (org_id, record_id, user_id, loaned_by, loaned_at, due_at, note) VALUES (?, ?, ?, ?, ?, ?, ?)').run(req.org.id, rec.id, target, req.user.id, now, addDaysIso(now, days), cleanText(String(b.note || ''), 200))).lastInsertRowid);
      await db.prepare("UPDATE lib_records SET status = 'loaned', updated_at = ? WHERE id = ?").run(now, rec.id);
      if (mine) await db.prepare("UPDATE lib_reservations SET state = 'done' WHERE id = ?").run(mine.id);
      return lid;
    })();
    await audit(req, 'loan', null, rec.title);
    await h.consult(req, rec.id, rec.doc_id, 'loan');
    const loan = await db.prepare('SELECT due_at FROM lib_loans WHERE id = ?').get(id);
    res.status(201).json({ id, dueAt: loan.due_at });
  });

  async function loadLoan(req, idv) {
    const l = await db.prepare('SELECT l.*, r.title, r.class_id FROM lib_loans l JOIN lib_records r ON r.id = l.record_id WHERE l.id = ? AND l.org_id = ?').get(A.id(idv, 'Prêt invalide.'), req.org.id);
    if (!l) throw new HttpError(404, 'Prêt introuvable.');
    if (!isManager(req) && Number(l.user_id) !== Number(req.user.id)) throw new HttpError(404, 'Prêt introuvable.');
    return l;
  }
  // ---------- Retour ----------
  router.post('/loans/:id/return', async (req, res) => {
    const b = req.body || {}; const l = await loadLoan(req, req.params.id);
    if (l.state !== 'active') throw new HttpError(400, 'Ce prêt est déjà clos.');
    const st = await R().catSettings(req.org.id); const now = nowISO();
    const lost = Boolean(b.lost);
    if (lost && !isManager(req)) throw new HttpError(403, 'Seul un responsable déclare une ressource perdue.');
    const cond = b.condition !== undefined && b.condition !== '' ? A.oneOf(b.condition, ['new', 'good', 'fair', 'worn', 'damaged'], undefined, 'État inconnu.') : null;
    const late = lost ? 0 : lateDays(l.due_at, now);
    const fine = late * st.finePerDay;
    await db.transaction(async () => {
      await db.prepare('UPDATE lib_loans SET state = ?, returned_at = ?, returned_by = ?, fine = ? WHERE id = ?').run(lost ? 'lost' : 'returned', now, req.user.id, fine, l.id);
      if (lost) await db.prepare("UPDATE lib_records SET status = 'lost', condition = 'lost', updated_at = ? WHERE id = ?").run(now, l.record_id);
      else {
        if (cond) await db.prepare('UPDATE lib_records SET condition = ?, updated_at = ? WHERE id = ?').run(cond, now, l.record_id);
        await promote(req.org.id, l.record_id);
      }
      if (!lost && st.blockAfterDays > 0 && late >= st.blockAfterDays && !(await activeBlock(req.org.id, l.user_id))) {
        await db.prepare('INSERT INTO lib_borrower_blocks (org_id, user_id, until, reason, auto, created_by, created_at) VALUES (?, ?, ?, ?, 1, ?, ?)').run(req.org.id, l.user_id, addDaysIso(now, st.blockDays), `Retard de ${late} jours sur « ${oneLine(l.title, 60)} »`, req.user.id, now);
      }
    })();
    await audit(req, lost ? 'loan_lost' : 'loan_return', null, l.title);
    res.json({ ok: true, lateDays: late, fine, blocked: Boolean(await activeBlock(req.org.id, l.user_id)) });
  });
  // ---------- Renouvellement ----------
  router.post('/loans/:id/renew', async (req, res) => {
    const l = await loadLoan(req, req.params.id); const st = await R().catSettings(req.org.id);
    if (l.state !== 'active') throw new HttpError(400, 'Ce prêt est déjà clos.');
    if (lateDays(l.due_at)) throw new HttpError(400, 'Ce prêt est en retard : rapportez la ressource.');
    if (Number(l.renewals) >= st.maxRenewals) throw new HttpError(400, 'Nombre maximal de renouvellements atteint.');
    if (await db.prepare("SELECT 1 FROM lib_reservations WHERE record_id = ? AND state = 'waiting'").get(l.record_id)) throw new HttpError(400, 'Une autre personne attend cette ressource : le prêt ne se renouvelle pas.');
    if (await activeBlock(req.org.id, l.user_id)) throw new HttpError(403, 'Les prêts sont suspendus pour cette personne.');
    const due = addDaysIso(l.due_at, st.loanDays);
    await db.prepare('UPDATE lib_loans SET due_at = ?, renewals = renewals + 1, reminders = 0, last_reminder_at = NULL WHERE id = ?').run(due, l.id);
    await audit(req, 'loan_renew', null, l.title);
    res.json({ ok: true, dueAt: due, renewals: Number(l.renewals) + 1 });
  });
  router.post('/loans/:id/pay', A.need('manager'), async (req, res) => {
    const l = await loadLoan(req, req.params.id);
    if (!Number(l.fine) || Number(l.fine_paid) >= Number(l.fine)) throw new HttpError(400, 'Aucune pénalité à régler sur ce prêt.');
    await db.prepare('UPDATE lib_loans SET fine_paid = fine WHERE id = ?').run(l.id);
    await audit(req, 'fine_paid', null, l.title);
    res.json({ ok: true });
  });

  // ---------- Réservations ----------
  router.post('/records/:id/reserve', async (req, res) => {
    const rec = await R().loadRecord(req, req.params.id); const b = req.body || {};
    if (!(await h.can(req, rec, 'loan'))) throw new HttpError(403, 'Votre accès ne permet pas cette action.');
    const target = b.userId !== undefined && b.userId !== null && b.userId !== '' ? await A.memberOf(req, b.userId) : req.user.id;
    if (Number(target) !== Number(req.user.id) && !isManager(req)) throw new HttpError(403, 'Seul un responsable peut réserver au nom d’une autre personne.');
    if (!Number(rec.loanable) || ['lost', 'withdrawn'].includes(rec.status)) throw new HttpError(400, 'Cette ressource ne peut pas être réservée.');
    if (rec.status === 'available') throw new HttpError(400, 'Cette ressource est disponible : empruntez-la directement.');
    if (await db.prepare("SELECT 1 FROM lib_loans WHERE record_id = ? AND user_id = ? AND state = 'active'").get(rec.id, target)) throw new HttpError(400, 'Vous avez déjà cette ressource en prêt.');
    if (await db.prepare("SELECT 1 FROM lib_reservations WHERE record_id = ? AND user_id = ? AND state IN ('waiting','ready')").get(rec.id, target)) throw new HttpError(400, 'Cette réservation existe déjà.');
    const id = Number((await db.prepare('INSERT INTO lib_reservations (org_id, record_id, user_id, created_at) VALUES (?, ?, ?, ?)').run(req.org.id, rec.id, target, nowISO())).lastInsertRowid);
    const pos = Number((await db.prepare("SELECT COUNT(*) AS c FROM lib_reservations WHERE record_id = ? AND state = 'waiting' AND id <= ?").get(rec.id, id)).c);
    await audit(req, 'reserve', null, rec.title);
    res.status(201).json({ id, position: pos });
  });
  router.delete('/reservations/:id', async (req, res) => {
    const r = await db.prepare('SELECT * FROM lib_reservations WHERE id = ? AND org_id = ?').get(A.id(req.params.id), req.org.id);
    if (!r || (!isManager(req) && Number(r.user_id) !== Number(req.user.id))) throw new HttpError(404, 'Réservation introuvable.');
    if (!['waiting', 'ready'].includes(r.state)) throw new HttpError(400, 'Cette réservation est déjà close.');
    await db.prepare("UPDATE lib_reservations SET state = 'cancelled' WHERE id = ?").run(r.id);
    if (r.state === 'ready') await promote(req.org.id, r.record_id);
    await audit(req, 'reserve_cancel', null, '');
    res.json({ ok: true });
  });

  // ---------- Listes et historiques ----------
  async function loanRows(req, where, args, { limit = 300 } = {}) {
    const vis = await R().visibility(req);
    const loans = await db.prepare(`SELECT l.* FROM lib_loans l WHERE l.org_id = ? ${where} ORDER BY l.due_at, l.id LIMIT ${limit}`).all(req.org.id, ...args);
    const ids = [...new Set(loans.map((l) => Number(l.record_id)))];
    const recs = new Map();
    if (ids.length) for (const r of await db.prepare(`${R().RECORD_SQL} WHERE r.org_id = ? AND r.id IN (${ids.map(() => '?').join(',')})`).all(req.org.id, ...ids)) recs.set(Number(r.id), r);
    // Une ressource que la personne n'a pas le droit de voir n'apparaît dans aucune liste de prêts, même pour un responsable.
    const rows = loans.filter((l) => recs.has(Number(l.record_id)) && vis.canSee(recs.get(Number(l.record_id))));
    const names = await h.namesOf(rows.map((l) => l.user_id));
    const now = nowISO();
    return rows.map((l) => {
      const r = recs.get(Number(l.record_id));
      const late = l.state === 'active' ? lateDays(l.due_at, now) : 0;
      return { id: Number(l.id), recordId: Number(l.record_id), title: r.title, inventoryNo: r.inventory_no, type: r.rtype, userId: Number(l.user_id), user: names[Number(l.user_id)] || '',
        loanedAt: l.loaned_at, dueAt: l.due_at, returnedAt: l.returned_at, renewals: Number(l.renewals), state: l.state, lateDays: late, fine: Number(l.fine), finePaid: Number(l.fine_paid), reminders: Number(l.reminders), note: l.note };
    });
  }
  router.get('/loans', async (req, res) => {
    const scope = String((req.query || {}).scope || 'mine'); const st = await R().catSettings(req.org.id);
    let rows;
    if (scope === 'mine') rows = await loanRows(req, "AND l.user_id = ? AND l.state = 'active'", [req.user.id]);
    else if (!isManager(req)) throw new HttpError(403, 'Réservé aux responsables.');
    else if (scope === 'all') rows = await loanRows(req, "AND l.state = 'active'", []);
    else if (scope === 'overdue') rows = (await loanRows(req, "AND l.state = 'active' AND l.due_at < ?", [nowISO()]));
    else if (scope === 'history') rows = await loanRows(req, "AND l.state <> 'active'", [], { limit: 500 });
    else throw new HttpError(400, 'Liste inconnue.');
    for (const r of rows) if (r.state === 'active') r.fine = r.lateDays * st.finePerDay; // pénalité estimée à ce jour
    const resa = await db.prepare(`SELECT s.*, r.title FROM lib_reservations s JOIN lib_records r ON r.id = s.record_id WHERE s.org_id = ? AND s.state IN ('waiting','ready') ${scope === 'mine' ? 'AND s.user_id = ?' : ''} ORDER BY s.created_at LIMIT 300`).all(req.org.id, ...(scope === 'mine' ? [req.user.id] : []));
    const names = await h.namesOf(resa.map((s) => s.user_id));
    res.json({ loans: rows, reservations: resa.map((s) => ({ id: Number(s.id), recordId: Number(s.record_id), title: s.title, userId: Number(s.user_id), user: names[Number(s.user_id)] || '', state: s.state, createdAt: s.created_at, readyUntil: s.ready_until })), settings: st });
  });
  /** Historique d'une ressource (responsables) ou de ses propres emprunts (membres). */
  h.recordDetails = async (req, r) => {
    const st = await R().catSettings(req.org.id);
    const where = isManager(req) ? '' : 'AND l.user_id = ?';
    const loans = await loanRows(req, `AND l.record_id = ? ${where}`, [r.id, ...(isManager(req) ? [] : [req.user.id])], { limit: 100 });
    for (const l of loans) if (l.state === 'active') l.fine = l.lateDays * st.finePerDay;
    const queue = await db.prepare("SELECT s.* FROM lib_reservations s WHERE s.record_id = ? AND s.state IN ('waiting','ready') ORDER BY s.created_at, s.id").all(r.id);
    const names = await h.namesOf(queue.map((s) => s.user_id));
    return { loans, reservations: queue.map((s, i) => ({ id: Number(s.id), position: i + 1, user: isManager(req) || Number(s.user_id) === Number(req.user.id) ? names[Number(s.user_id)] || '' : '', mine: Number(s.user_id) === Number(req.user.id), state: s.state, readyUntil: s.ready_until })) };
  };
  /** Personnes à qui prêter (responsables). */
  router.get('/people', A.need('manager'), async (req, res) => {
    const rows = await db.prepare('SELECT m.user_id, m.role, u.name FROM org_members m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? ORDER BY LOWER(u.name)').all(req.org.id);
    res.json({ people: rows.map((r) => ({ userId: Number(r.user_id), name: r.name, role: r.role })) });
  });
  router.get('/people/:userId/loans', async (req, res) => {
    const uid = await A.memberOf(req, req.params.userId);
    if (Number(uid) !== Number(req.user.id) && !isManager(req)) throw new HttpError(403, 'Réservé aux responsables.');
    const st = await R().catSettings(req.org.id);
    const loans = await loanRows(req, 'AND l.user_id = ?', [uid], { limit: 300 });
    for (const l of loans) if (l.state === 'active') l.fine = l.lateDays * st.finePerDay;
    const block = await activeBlock(req.org.id, uid);
    res.json({ loans, blocked: block ? { until: block.until, reason: block.reason, id: Number(block.id) } : null, activeCount: loans.filter((l) => l.state === 'active').length, max: st.maxLoans });
  });

  // ---------- Blocages ----------
  router.get('/borrowers/blocks', A.need('manager'), async (req, res) => {
    const rows = await db.prepare('SELECT * FROM lib_borrower_blocks WHERE org_id = ? AND lifted_at IS NULL AND until > ? ORDER BY until DESC').all(req.org.id, nowISO());
    const names = await h.namesOf(rows.map((r) => r.user_id));
    res.json({ blocks: rows.map((r) => ({ id: Number(r.id), userId: Number(r.user_id), user: names[Number(r.user_id)] || '', until: r.until, reason: r.reason, auto: Boolean(Number(r.auto)) })) });
  });
  router.post('/borrowers/:userId/block', A.need('manager'), async (req, res) => {
    const uid = await A.memberOf(req, req.params.userId); const b = req.body || {};
    const days = Number(b.days === undefined ? 30 : b.days);
    if (!Number.isInteger(days) || days < 1 || days > 365) throw new HttpError(400, 'Durée du blocage : entre 1 et 365 jours.');
    const now = nowISO();
    const id = Number((await db.prepare('INSERT INTO lib_borrower_blocks (org_id, user_id, until, reason, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(req.org.id, uid, addDaysIso(now, days), cleanText(String(b.reason || ''), 200), req.user.id, now)).lastInsertRowid);
    await audit(req, 'borrower_block', null, '');
    res.status(201).json({ id });
  });
  router.delete('/borrowers/blocks/:id', A.need('manager'), async (req, res) => {
    const r = await db.prepare('SELECT * FROM lib_borrower_blocks WHERE id = ? AND org_id = ? AND lifted_at IS NULL').get(A.id(req.params.id), req.org.id);
    if (!r) throw new HttpError(404, 'Blocage introuvable.');
    await db.prepare('UPDATE lib_borrower_blocks SET lifted_at = ? WHERE id = ?').run(nowISO(), r.id);
    await audit(req, 'borrower_unblock', null, '');
    res.json({ ok: true });
  });

  // ---------- Rappels automatiques (tâche horaire) et sur demande ----------
  /** Rappels avant échéance et de retard, expiration des réservations non retirées, blocages automatiques. Renvoie des compteurs. */
  async function maintenance(orgId) {
    const out = { before: 0, late: 0, expired: 0, blocked: 0 };
    const now = nowISO();
    const orgs = orgId ? [orgId] : (await db.prepare("SELECT DISTINCT org_id FROM lib_loans WHERE state = 'active' UNION SELECT DISTINCT org_id FROM lib_reservations WHERE state = 'ready'").all()).map((r) => Number(r.org_id));
    for (const oid of orgs) {
      const st = await R().catSettings(oid);
      for (const s of await db.prepare("SELECT * FROM lib_reservations WHERE org_id = ? AND state = 'ready' AND ready_until < ?").all(oid, now)) {
        await db.prepare("UPDATE lib_reservations SET state = 'expired' WHERE id = ?").run(s.id);
        await promote(oid, s.record_id); out.expired++;
      }
      const loans = await db.prepare("SELECT l.*, r.title FROM lib_loans l JOIN lib_records r ON r.id = l.record_id WHERE l.org_id = ? AND l.state = 'active'").all(oid);
      for (const l of loans) {
        const late = lateDays(l.due_at, now);
        if (!late) {
          if (st.remindBeforeDays > 0 && Number(l.reminders) === 0 && Date.parse(l.due_at) - Date.parse(now) <= st.remindBeforeDays * DAY) {
            await notify(oid, l.user_id, `Rappel : « ${oneLine(l.title, 70)} » est à rendre le ${l.due_at.slice(0, 10)}.`, `libloan:${l.id}`);
            await db.prepare('UPDATE lib_loans SET reminders = reminders + 1, last_reminder_at = ? WHERE id = ?').run(now, l.id); out.before++;
          }
          continue;
        }
        const last = l.last_reminder_at ? Date.parse(l.last_reminder_at) : 0;
        if (!last || Date.parse(now) - last >= st.remindEveryDays * DAY || (Number(l.reminders) === 0)) {
          await notify(oid, l.user_id, `Retard : « ${oneLine(l.title, 70)} » devait être rendu le ${l.due_at.slice(0, 10)} (${late} jour${late > 1 ? 's' : ''}).`, `libloan:${l.id}`);
          if (Number(l.reminders) === 0 || !l.last_reminder_at) await W.pushRole(oid, 'manager', 'library', `Retard de prêt : « ${oneLine(l.title, 60)} » (${late} jour${late > 1 ? 's' : ''}).`, `libloan:${l.id}`);
          await db.prepare('UPDATE lib_loans SET reminders = reminders + 1, last_reminder_at = ? WHERE id = ?').run(now, l.id); out.late++;
        }
        if (st.blockAfterDays > 0 && late >= st.blockAfterDays && !(await activeBlock(oid, l.user_id))) {
          await db.prepare('INSERT INTO lib_borrower_blocks (org_id, user_id, until, reason, auto, created_at) VALUES (?, ?, ?, ?, 1, ?)').run(oid, l.user_id, addDaysIso(now, st.blockDays), `Retard de ${late} jours sur « ${oneLine(l.title, 60)} »`, now); out.blocked++;
        }
      }
    }
    return out;
  }
  h.loanMaintenance = maintenance;
  router.post('/loans/remind', A.need('manager'), async (req, res) => {
    const out = await maintenance(req.org.id);
    await audit(req, 'loan_reminders', null, '');
    res.json({ ok: true, ...out });
  });

  // ---------- Synthèse des prêts (tableau de bord) ----------
  h.loanSummary = async (orgId, st) => {
    const now = nowISO();
    const act = await db.prepare("SELECT due_at FROM lib_loans WHERE org_id = ? AND state = 'active'").all(orgId);
    const overdue = act.filter((l) => l.due_at < now).length;
    const soon = act.filter((l) => l.due_at >= now && Date.parse(l.due_at) - Date.parse(now) <= 3 * DAY).length;
    const resa = Number((await db.prepare("SELECT COUNT(*) AS c FROM lib_reservations WHERE org_id = ? AND state IN ('waiting','ready')").get(orgId)).c);
    const unpaid = (await db.prepare("SELECT COALESCE(SUM(fine - fine_paid), 0) AS s FROM lib_loans WHERE org_id = ? AND state <> 'active' AND fine > fine_paid").get(orgId));
    const blocks = Number((await db.prepare('SELECT COUNT(*) AS c FROM lib_borrower_blocks WHERE org_id = ? AND lifted_at IS NULL AND until > ?').get(orgId, now)).c);
    return { active: act.length, overdue, dueSoon: soon, reservations: resa, finesDue: Number(unpaid.s), blocked: blocks, finePerDay: st.finePerDay };
  };
};
module.exports.lateDays = lateDays;
