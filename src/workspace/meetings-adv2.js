'use strict';
// Réunions avancées (2/2) : procès-verbaux numérotés et signatures électroniques (compte rendu et PV), statistiques et taux de décision,
// suivi des performances, historique des responsabilités, engagements non tenus.
const express = require('express');
const { db, nowISO } = require('../db');
const limits = require('../middleware/limits');
const A = require('./access');
const M = require('./meetings-lib');
const X = require('./meetings-adv-lib');
const { HttpError, oneLine } = require('../util');

const router = express.Router({ mergeParams: true });
const signLimit = limits.make(10 * 60 * 1000, 60, 'Trop de demandes. Réessayez dans quelques minutes.');
const pdfLimit = limits.make(10 * 60 * 1000, 60, 'Trop de téléchargements. Réessayez dans quelques minutes.');
const label = (m) => (Number(m.confidential) ? 'réunion confidentielle' : `« ${m.title} »`);
const RESP = { pending: 'Sans réponse', present: 'Présent', absent: 'Absent', excused: 'Excusé' };

// =====================================================================================================================
// Procès-verbal : document formel numéroté (PV-AAAA-NNN), distinct du compte rendu libre ; présences, quorum, résolutions et votes ; signé électroniquement.
// =====================================================================================================================
async function names(ids) {
  const list = [...new Set(ids.filter(Boolean).map(Number))];
  if (!list.length) return new Map();
  return new Map((await db.prepare(`SELECT id, name FROM users WHERE id IN (${list.map(() => '?').join(',')})`).all(...list)).map((u) => [Number(u.id), u.name]));
}
async function buildPvContent(req, m, cfg, parts) {
  const MM = require('./meetings-minutes');
  const live = await MM.liveContent(m);
  const q = await X.quorumState(req, m, parts, cfg);
  const nm = await names([m.organizer_id, m.secretary_id, m.chair_id]);
  const per = await X.perimeter(m, parts);
  const sites = per.sites.length ? (await db.prepare(`SELECT name FROM branches WHERE org_id = ? AND id IN (${per.sites.map(() => '?').join(',')}) ORDER BY name`).all(req.org.id, ...per.sites)).map((x) => x.name) : [];
  const depts = per.depts.length ? (await db.prepare(`SELECT name FROM rh_departments WHERE org_id = ? AND id IN (${per.depts.map(() => '?').join(',')}) ORDER BY name`).all(req.org.id, ...per.depts)).map((x) => x.name) : [];
  const rows = await db.prepare('SELECT * FROM mtg_resolutions WHERE meeting_id = ? ORDER BY position, id').all(m.id);
  const resolutions = [];
  for (const r of rows) {
    const result = r.result ? JSON.parse(r.result) : null;
    let details = null;
    if (r.vote_mode !== 'secret' && r.vote_state === 'closed') {
      const v = await db.prepare('SELECT participant_id, choice, weight FROM mtg_votes WHERE resolution_id = ?').all(r.id);
      const by = new Map(v.map((x) => [Number(x.participant_id), x]));
      details = parts.filter((p) => by.has(Number(p.id))).map((p) => ({ name: p.uname || p.name, choice: by.get(Number(p.id)).choice, weight: Number(by.get(Number(p.id)).weight) }));
    }
    const carrier = r.carrier_id ? (await names([r.carrier_id])).get(Number(r.carrier_id)) : r.carrier_name;
    resolutions.push({ number: r.number, title: r.title, text: r.text, carrier: carrier || '', due: r.due || null, status: r.status, majority: r.majority, threshold: Number(r.threshold), weighted: Boolean(Number(r.weighted)),
      mode: r.vote_mode, result, resultHash: r.result_hash || '', postponedReason: r.postponed_reason, details });
  }
  let child = null; let parent = null;
  const c = await db.prepare('SELECT id, date, start_time FROM mtg_meetings WHERE parent_id = ? AND org_id = ? ORDER BY id LIMIT 1').get(m.id, req.org.id);
  if (c) child = { id: Number(c.id), date: c.date, time: c.start_time };
  if (m.parent_id) { const p = await db.prepare('SELECT id, date, title FROM mtg_meetings WHERE id = ? AND org_id = ?').get(m.parent_id, req.org.id); if (p) parent = { id: Number(p.id), date: p.date }; }
  return {
    meta: { title: m.title, type: m.type, date: m.date, time: m.start_time, endTime: M.endTime(m), durationMin: Number(m.duration_min), place: m.place, link: m.link, objective: m.objective, urgency: m.urgency,
      organizer: nm.get(Number(m.organizer_id)) || '', secretary: nm.get(Number(m.secretary_id)) || '', chair: nm.get(Number(m.chair_id)) || '', org: req.org.name, startedAt: m.started_at, endedAt: m.ended_at, sites, services: depts },
    quorum: { required: q.required, ok: q.ok, present: q.present, base: q.base, need: q.need, mode: q.mode, noQuorum: m.status === 'no_quorum', reason: m.no_quorum_reason || '', reconvened: child, followsMeeting: parent },
    attendance: parts.map((p) => ({ name: p.uname || p.name, kind: p.user_id == null ? 'guest' : 'member', required: Boolean(Number(p.required)), response: p.response, attended: p.attended, lateMin: Number(p.late_min), reason: p.reason })),
    agenda: live.agenda.filter((a) => a.accepted !== false).map((a) => ({ title: a.title, kind: a.kind, owner: a.owner, spentMin: a.spentMin || 0 })),
    summary: live.summary, resolutions,
    decisions: live.decisions.map((d) => d.text), actions: live.actions.filter((a) => a.status !== 'cancelled').map((a) => ({ text: a.text, assignee: a.assignee, due: a.due })),
    nextMeeting: live.nextMeeting,
  };
}
async function currentPv(meetingId) { return await db.prepare("SELECT * FROM mtg_pv WHERE meeting_id = ? AND status <> 'superseded' ORDER BY version DESC LIMIT 1").get(meetingId); }
const pvHash = (pv) => X.sha({ number: pv.number, version: Number(pv.version), narrative: pv.narrative, content: JSON.parse(pv.content) });
async function sigsOf(kind, docId) {
  return await db.prepare('SELECT s.*, u.name AS uname FROM mtg_signatures s LEFT JOIN users u ON u.id = s.user_id WHERE s.doc_kind = ? AND s.doc_id = ? ORDER BY s.position, s.id').all(kind, docId);
}
const sigView = (s) => ({ id: Number(s.id), userId: Number(s.user_id), name: s.uname || '', role: s.role, position: Number(s.position), signed: Boolean(s.signed_at), signedAt: s.signed_at || null, hash: s.content_hash || '', comment: s.comment });
function pvCanSee(ctx, pv) { return ctx.draftVisible || (pv.status === 'signed' && Boolean(ctx.mine)) || pv.status === 'signed' && ctx.see; }
async function pvPayload(req, m, ctx, pv) {
  if (!pv) return { pv: null, canCreate: ctx.write && m.status !== 'cancelled' && (m.status !== 'planned' || Boolean(m.started_at)) };
  const sigs = (await sigsOf('pv', pv.id)).map(sigView);
  const versions = (await db.prepare('SELECT version, number, status, created_at, signed_at, reason FROM mtg_pv WHERE meeting_id = ? ORDER BY version DESC').all(m.id)).map((v) => ({ version: Number(v.version), number: v.number, status: v.status, createdAt: v.created_at, signedAt: v.signed_at, reason: v.reason }));
  const mine = sigs.find((s) => s.userId === req.user.id);
  const next = pv.ordered ? sigs.find((s) => !s.signed) : null;
  const intact = pv.content_hash ? pvHash(pv) === pv.content_hash : null;
  return { pv: { id: Number(pv.id), number: pv.number, version: Number(pv.version), status: pv.status, ordered: Boolean(Number(pv.ordered)), narrative: pv.narrative, content: JSON.parse(pv.content), hash: pv.content_hash, intact, createdAt: pv.created_at, lockedAt: pv.locked_at, signedAt: pv.signed_at, reason: pv.reason },
    signatures: sigs, versions,
    rights: { edit: pv.status === 'draft' && ctx.write, request: pv.status === 'draft' && ctx.write, sign: pv.status === 'signing' && Boolean(mine) && !mine.signed && (!pv.ordered || (next && next.userId === req.user.id)), newVersion: ['signed', 'signing'].includes(pv.status) && (ctx.validate || ctx.owner) } };
}
router.get('/:id/pv', async (req, res) => {
  const { m, ctx } = await M.load(req, req.params.id);
  const pv = await currentPv(m.id);
  if (pv && !pvCanSee(ctx, pv) && !(await sigsOf('pv', pv.id)).some((s) => Number(s.user_id) === req.user.id)) return res.json({ pv: null, canCreate: false });
  res.json(await pvPayload(req, m, ctx, pv));
});
router.post('/:id/pv', async (req, res) => {
  const { m, cfg, ctx, parts } = await M.load(req, req.params.id);
  M.needWrite(ctx); M.needNotCancelled(m);
  if (m.status === 'planned' && !m.started_at) throw new HttpError(409, "Le procès-verbal se rédige une fois la séance ouverte ou tenue.");
  if (await currentPv(m.id)) throw new HttpError(409, 'Cette réunion a déjà un procès-verbal. Modifiez-le ou créez une nouvelle version.');
  const narrative = A.text((req.body || {}).narrative, 8000);
  const content = await buildPvContent(req, m, cfg, parts);
  const year = Number(m.date.slice(0, 4));
  const id = await X.numbered('mtg_pv', 'PV', req, year, async (seq, number) => Number((await db.prepare('INSERT INTO mtg_pv (org_id, meeting_id, year, seq, number, version, status, narrative, content, created_by, created_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)')
    .run(req.org.id, m.id, year, seq, number, 'draft', narrative, JSON.stringify(content), req.user.id, nowISO())).lastInsertRowid));
  await M.mlog(req, m.id, 'pv', 'Procès-verbal créé (brouillon)');
  res.status(201).json({ id });
});
router.put('/:id/pv', async (req, res) => {
  const { m, cfg, ctx, parts } = await M.load(req, req.params.id);
  M.needWrite(ctx);
  const pv = await currentPv(m.id);
  if (!pv) throw new HttpError(404, 'Pas de procès-verbal pour cette réunion.');
  if (pv.status !== 'draft') throw new HttpError(409, 'Le procès-verbal est verrouillé (signature demandée ou signé).');
  const b = req.body || {};
  const narrative = b.narrative === undefined ? pv.narrative : A.text(b.narrative, 8000);
  const content = b.refresh === false ? pv.content : JSON.stringify(await buildPvContent(req, m, cfg, parts));
  await db.prepare('UPDATE mtg_pv SET narrative = ?, content = ?, ordered = ? WHERE id = ?').run(narrative, content, b.ordered === undefined ? Number(pv.ordered) : (b.ordered ? 1 : 0), pv.id);
  await M.mlog(req, m.id, 'pv', 'Procès-verbal mis à jour');
  res.json({ ok: true });
});
router.post('/:id/pv/request-signatures', async (req, res) => {
  const { m, cfg, ctx } = await M.load(req, req.params.id);
  M.needWrite(ctx); M.needNotCancelled(m);
  const pv = await currentPv(m.id);
  if (!pv) throw new HttpError(404, 'Pas de procès-verbal pour cette réunion.');
  if (pv.status !== 'draft') throw new HttpError(409, 'Les signatures ont déjà été demandées.');
  const b = req.body || {};
  let list = Array.isArray(b.signers) ? b.signers : null;
  if (!list || !list.length) list = [['chair', m.chair_id], ['secretary', m.secretary_id], ['organizer', m.organizer_id]].filter(([, u]) => u).map(([role, userId]) => ({ userId, role }));
  if (list.length > 12) throw new HttpError(400, '12 signataires au maximum.');
  const seen = new Set(); const signers = [];
  for (const s of list) { const uid = await A.memberOf(req, s && s.userId); if (!uid || seen.has(uid)) continue; seen.add(uid); signers.push({ userId: uid, role: A.text(s.role, 40) }); }
  if (!signers.length) throw new HttpError(400, 'Indiquez au moins un signataire.');
  const ordered = b.ordered === undefined ? Boolean(Number(pv.ordered)) || cfg.signOrdered : Boolean(b.ordered);
  const now = nowISO();
  const content = JSON.stringify(await buildPvContent(req, m, cfg, await M.participantsOf(m.id)));
  const locked = { ...pv, content, ordered: ordered ? 1 : 0 };
  const hash = pvHash(locked);
  await db.transaction(async () => {
    await db.prepare("UPDATE mtg_pv SET status = 'signing', content = ?, content_hash = ?, ordered = ?, locked_at = ? WHERE id = ?").run(content, hash, ordered ? 1 : 0, now, pv.id);
    let pos = 0;
    for (const s of signers) await db.prepare('INSERT INTO mtg_signatures (org_id, meeting_id, doc_kind, doc_id, position, user_id, role) VALUES (?, ?, ?, ?, ?, ?, ?)').run(req.org.id, m.id, 'pv', pv.id, pos++, s.userId, s.role);
    await M.mlog(req, m.id, 'pv_locked', `Procès-verbal ${pv.number} verrouillé : signature demandée à ${signers.length} personne(s)${ordered ? ' (dans l’ordre)' : ''}`);
  })();
  for (const [i, s] of signers.entries()) if (s.userId !== req.user.id && (!ordered || i === 0)) await M.notice(req.org.id, s.userId, 'meeting_sign', `Procès-verbal à signer : ${pv.number} — ${label(m)}.`, `meeting:${m.id}`);
  res.json({ ok: true, hash, signers: signers.length });
});
router.post('/:id/pv/sign', signLimit, async (req, res) => {
  const { m, ctx } = await M.load(req, req.params.id);
  const pv = await currentPv(m.id);
  if (!pv || pv.status !== 'signing') throw new HttpError(409, "Aucun procès-verbal n'attend de signature.");
  const sigs = await sigsOf('pv', pv.id);
  const mine = sigs.find((s) => Number(s.user_id) === req.user.id);
  if (!mine) throw new HttpError(403, "Vous n'êtes pas signataire de ce procès-verbal.");
  if (mine.signed_at) throw new HttpError(409, 'Vous avez déjà signé.');
  if (Number(pv.ordered)) { const before = sigs.filter((s) => Number(s.position) < Number(mine.position) && !s.signed_at); if (before.length) throw new HttpError(409, `La signature se fait dans l'ordre : ${before[0].uname || 'la personne précédente'} doit signer avant vous.`); }
  if (pvHash(pv) !== pv.content_hash) throw new HttpError(409, "Le contenu du procès-verbal ne correspond plus à son empreinte : signature refusée.");
  const now = nowISO();
  let done = false;
  await db.transaction(async () => {
    await db.prepare('UPDATE mtg_signatures SET signed_at = ?, content_hash = ?, comment = ? WHERE id = ?').run(now, pv.content_hash, A.text((req.body || {}).comment, 300), mine.id);
    const left = Number((await db.prepare('SELECT COUNT(*) c FROM mtg_signatures WHERE doc_kind = ? AND doc_id = ? AND signed_at IS NULL').get('pv', pv.id)).c);
    if (!left) { await db.prepare("UPDATE mtg_pv SET status = 'signed', signed_at = ? WHERE id = ?").run(now, pv.id); done = true; }
    await M.mlog(req, m.id, 'pv_signed', `Procès-verbal ${pv.number} signé${done ? ' par tous : verrouillé' : ''}`);
  })();
  if (done) { if (pv.created_by && Number(pv.created_by) !== req.user.id) await M.notice(req.org.id, pv.created_by, 'meeting', `Procès-verbal ${pv.number} signé par tous : ${label(m)}.`, `meeting:${m.id}`); }
  else if (Number(pv.ordered)) { const nxt = sigs.find((s) => !s.signed_at && Number(s.user_id) !== req.user.id); if (nxt) await M.notice(req.org.id, nxt.user_id, 'meeting_sign', `À votre tour de signer le procès-verbal ${pv.number} : ${label(m)}.`, `meeting:${m.id}`); }
  void ctx;
  res.json({ ok: true, complete: done, signedAt: now, hash: pv.content_hash });
});
router.post('/:id/pv/new-version', async (req, res) => {
  const { m, cfg, ctx, parts } = await M.load(req, req.params.id);
  if (!(ctx.validate || ctx.owner)) throw new HttpError(403, 'Seule une personne autorisée à valider rouvre un procès-verbal.');
  const pv = await currentPv(m.id);
  if (!pv || pv.status === 'draft') throw new HttpError(409, "Le procès-verbal n'est pas encore verrouillé : il se modifie directement.");
  if (m.archived_at) throw new HttpError(409, 'La réunion est archivée : sortez-la des archives avant de corriger son procès-verbal.');
  const reason = A.text((req.body || {}).reason, 500, { required: true, msg: 'Indiquez pourquoi vous rouvrez le procès-verbal.' });
  const version = Number(pv.version) + 1;
  const number = `${String(pv.number).replace(/-R\d+$/, '')}-R${version}`;
  await db.transaction(async () => {
    await db.prepare("UPDATE mtg_pv SET status = 'superseded' WHERE id = ?").run(pv.id);
    await db.prepare('INSERT INTO mtg_pv (org_id, meeting_id, year, seq, number, version, status, narrative, content, reason, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(req.org.id, m.id, pv.year, pv.seq, number, version, 'draft', pv.narrative, JSON.stringify(await buildPvContent(req, m, cfg, parts)), reason, req.user.id, nowISO());
    await M.mlog(req, m.id, 'pv', `Procès-verbal rouvert (version ${version}) : ${oneLine(reason, 200)}`);
  })();
  res.json({ ok: true, version, number });
});

const CH = { for: 'Pour', against: 'Contre', abstain: 'Abstention' };
const RST = { pending: 'En attente', adopted: 'Adoptée', rejected: 'Rejetée', postponed: 'Reportée', no_quorum: 'Sans quorum' };
const MJ = { simple: 'majorité simple', qualified: 'majorité qualifiée', unanimity: 'unanimité' };
const MD = { hand: 'à main levée', named: 'nominatif', secret: 'à bulletin secret' };
async function renderPvPdf(req, pv, sigs) {
  const pdf = require('../services/pdf');
  const c = JSON.parse(pv.content);
  const b = [];
  b.push({ type: 'kv', rows: [['Réunion', c.meta.title], ['Date', `${pdf.dfr(c.meta.date)} · ${c.meta.time}–${c.meta.endTime}`], ['Lieu / lien', c.meta.place || c.meta.link || '—'], ['Président de séance', c.meta.chair || '—'], ['Organisateur', c.meta.organizer || '—'], ['Secrétaire de séance', c.meta.secretary || '—'],
    ...(c.meta.sites.length ? [['Sites', c.meta.sites.join(', ')]] : []), ...(c.meta.services.length ? [['Services', c.meta.services.join(', ')]] : [])] });
  if (c.meta.objective) b.push({ type: 'text', text: `Objet : ${c.meta.objective}` });
  b.push({ type: 'heading', text: 'Présences' });
  b.push({ type: 'table', cols: [{ key: 'n', label: 'Nom', width: 190 }, { key: 'r', label: 'Réponse', width: 90 }, { key: 'a', label: 'Présence réelle', width: 100 }, { key: 'l', label: 'Retard', width: 70 }], rows: c.attendance.map((p) => ({ n: p.name || '—', r: RESP[p.response] || '', a: p.attended === 'yes' ? 'Présent' : p.attended === 'no' ? 'Absent' : '—', l: p.lateMin ? `${p.lateMin} min` : '' })) });
  b.push({ type: 'heading', text: 'Quorum' });
  b.push({ type: 'text', text: c.quorum.required ? `${c.quorum.present} présent(s) sur ${c.quorum.base} convoqué(s) ayant voix ; ${c.quorum.need} requis${c.quorum.mode === 'reduced' ? ' (quorum réduit, deuxième convocation)' : ''}. Quorum ${c.quorum.ok ? 'atteint' : 'NON atteint'}.` : "Aucune règle de quorum n'est définie pour ce type de réunion." });
  if (c.quorum.noQuorum) {
    b.push({ type: 'note', text: `SÉANCE DÉCLARÉE SANS QUORUM${c.quorum.reason ? ` : ${c.quorum.reason}` : ''}. Aucune décision prise lors de cette séance n'est valable.` });
    if (c.quorum.reconvened) b.push({ type: 'text', text: `Nouvelle convocation à quorum réduit : ${pdf.dfr(c.quorum.reconvened.date)} à ${c.quorum.reconvened.time}.` });
  }
  if (c.quorum.followsMeeting) b.push({ type: 'text', text: `Cette séance fait suite à la réunion du ${pdf.dfr(c.quorum.followsMeeting.date)} qui n'avait pas atteint le quorum.` });
  if (pv.narrative) { b.push({ type: 'heading', text: 'Exposé' }); b.push({ type: 'text', text: pv.narrative }); }
  if (c.agenda.length) { b.push({ type: 'heading', text: "Ordre du jour" }); c.agenda.forEach((a, i) => b.push({ type: 'text', text: `${i + 1}. ${a.title}${a.owner ? ` (${a.owner})` : ''}` })); }
  if (c.resolutions.length) {
    b.push({ type: 'heading', text: 'Résolutions et votes' });
    for (const r of c.resolutions) {
      b.push({ type: 'text', text: `${r.number}${r.title ? ` — ${r.title}` : ''} : ${RST[r.status] || r.status}` });
      b.push({ type: 'note', text: r.text });
      const res = r.result;
      b.push({ type: 'text', text: [`Vote ${MD[r.mode] || ''}, ${MJ[r.majority] || ''}${r.majority === 'qualified' ? ` (${r.threshold} %)` : ''}${r.weighted ? ', pondéré' : ''}.`, res && res.for !== undefined ? `Pour : ${res.for} · Contre : ${res.against} · Abstention : ${res.abstain}.` : '', r.carrier ? `Porteur : ${r.carrier}${r.due ? ` · échéance ${pdf.dfr(r.due)}` : ''}.` : '', r.postponedReason ? `Report : ${r.postponedReason}.` : ''].filter(Boolean).join(' ') });
      if (r.details && r.details.length) b.push({ type: 'table', cols: [{ key: 'n', label: 'Votant', width: 260 }, { key: 'c', label: 'Vote', width: 120 }], rows: r.details.map((d) => ({ n: d.name, c: CH[d.choice] || d.choice })) });
      else if (r.mode === 'secret') b.push({ type: 'text', text: 'Vote à bulletin secret : seul le résultat est consigné.' });
    }
  }
  if (c.decisions.length) { b.push({ type: 'heading', text: 'Décisions' }); b.push({ type: 'table', cols: [{ key: 'n', label: '#', width: 30 }, { key: 't', label: 'Décision', width: 460 }], rows: c.decisions.map((d, i) => ({ n: String(i + 1), t: d })) }); }
  if (c.actions.length) { b.push({ type: 'heading', text: 'Actions' }); b.push({ type: 'table', cols: [{ key: 't', label: 'Action', width: 280 }, { key: 'r', label: 'Responsable', width: 110 }, { key: 'd', label: 'Échéance', width: 80 }], rows: c.actions.map((a) => ({ t: a.text, r: a.assignee || '—', d: a.due ? pdf.dfr(a.due) : '—' })) }); }
  if (c.nextMeeting) b.push({ type: 'text', text: `Prochaine réunion : ${c.nextMeeting}` });
  b.push({ type: 'heading', text: 'Signatures électroniques' });
  b.push({ type: 'table', cols: [{ key: 'n', label: 'Signataire', width: 150 }, { key: 'r', label: 'Qualité', width: 90 }, { key: 'd', label: 'Signé le', width: 130 }, { key: 'h', label: 'Empreinte', width: 110 }],
    rows: sigs.map((s) => ({ n: s.uname || '', r: s.role || '', d: s.signed_at ? new Date(s.signed_at).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : 'en attente', h: s.content_hash ? s.content_hash.slice(0, 16) : '' })) });
  if (pv.content_hash) b.push({ type: 'text', text: `Empreinte SHA-256 du contenu : ${pv.content_hash}` });
  return await pdf.render({ title: `Procès-verbal n° ${pv.number}`, subtitle: c.meta.title, org: req.org.name, meta: [['Version', String(pv.version)], ['Statut', pv.status === 'signed' ? 'Signé par tous' : pv.status === 'signing' ? 'En cours de signature' : 'PROJET — non signé']], blocks: b, footer: pv.status === 'signed' ? 'Signé électroniquement' : 'Projet non signé' });
}
router.get('/:id/pv.pdf', pdfLimit, async (req, res) => {
  const { m, ctx } = await M.load(req, req.params.id);
  const ver = req.query.version ? A.id(req.query.version) : null;
  const pv = ver ? await db.prepare('SELECT * FROM mtg_pv WHERE meeting_id = ? AND version = ?').get(m.id, ver) : await currentPv(m.id);
  if (!pv || (!ctx.draftVisible && pv.status !== 'signed')) throw new HttpError(404, 'Procès-verbal introuvable.');
  const buf = await renderPvPdf(req, pv, await sigsOf('pv', pv.id));
  await M.mlog(req, m.id, 'pdf', `Procès-verbal ${pv.number} exporté en PDF`);
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="proces-verbal-${pv.number}.pdf"`, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
  res.send(buf);
});

/** Signature électronique du compte rendu : posée par la validation (horodatage + empreinte du contenu figé). */
async function signMinutes(req, m, sub) {
  const content = JSON.parse(sub.content);
  await db.prepare('INSERT INTO mtg_signatures (org_id, meeting_id, doc_kind, doc_id, position, user_id, role, signed_at, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (doc_kind, doc_id, user_id) DO NOTHING')
    .run(req.org.id, m.id, 'minutes', sub.id, 0, req.user.id, 'validator', nowISO(), X.sha(content));
}
router.get('/:id/signatures', async (req, res) => {
  const { m, ctx } = await M.load(req, req.params.id);
  const out = [];
  const mins = await db.prepare("SELECT * FROM mtg_minutes WHERE meeting_id = ? AND status IN ('validated', 'superseded') ORDER BY version DESC").all(m.id);
  for (const v of mins) for (const s of await sigsOf('minutes', v.id)) out.push({ kind: 'minutes', version: Number(v.version), ...sigView(s), intact: X.sha(JSON.parse(v.content)) === s.content_hash });
  const pvs = await db.prepare('SELECT * FROM mtg_pv WHERE meeting_id = ? ORDER BY version DESC').all(m.id);
  for (const pv of pvs) { if (!ctx.draftVisible && pv.status !== 'signed') continue; for (const s of await sigsOf('pv', pv.id)) out.push({ kind: 'pv', version: Number(pv.version), number: pv.number, ...sigView(s), intact: pvHash(pv) === s.content_hash }); }
  res.json({ signatures: out.filter((s) => s.signed) });
});

// =====================================================================================================================
// Statistiques : taux de décision, présence, durée, tâches, répartitions par type / service / site (mêmes règles de visibilité que les fiches)
// =====================================================================================================================
function filters(req, cfg, q) {
  const vis = M.visibleSql(req, cfg);
  const year = new Date().getUTCFullYear();
  const from = q.from ? A.date(q.from) : `${year}-01-01`;
  const to = q.to ? A.date(q.to) : `${year}-12-31`;
  if (from > to) throw new HttpError(400, 'La période est invalide : la date de début suit la date de fin.');
  const where = ['m.org_id = ?', 'm.date >= ?', 'm.date <= ?']; const args = [req.org.id, from, to];
  if (q.type) { where.push('m.type = ?'); args.push(M.type(q.type)); }
  if (q.typeId) { where.push('m.type_id = ?'); args.push(A.id(q.typeId)); }
  if (q.branchId) { where.push("(m.branch_id = ? OR EXISTS (SELECT 1 FROM mtg_scope s WHERE s.meeting_id = m.id AND s.kind = 'site' AND s.ref_id = ?))"); const b = A.id(q.branchId); args.push(b, b); }
  if (q.departmentId) { where.push("(m.department_id = ? OR EXISTS (SELECT 1 FROM mtg_scope s WHERE s.meeting_id = m.id AND s.kind = 'dept' AND s.ref_id = ?))"); const d = A.id(q.departmentId); args.push(d, d); }
  if (q.urgency) { where.push('m.urgency = ?'); args.push(A.oneOf(q.urgency, X.URGENCY, undefined, "Niveau d'urgence inconnu.")); }
  return { from, to, sql: where.join(' AND ') + vis.sql, args: [...args, ...vis.args] };
}
const pct = (a, b) => (b ? Math.round((a / b) * 100) : null);
const num = (v) => Number(v || 0);
router.get('/stats', async (req, res) => {
  const cfg = await M.getConfig(req.org.id);
  const f = filters(req, cfg, req.query);
  const today = M.today();
  const byStatus = await db.prepare(`SELECT m.status, COUNT(*) c FROM mtg_meetings m WHERE ${f.sql} GROUP BY m.status`).all(...f.args);
  const st = { planned: 0, held: 0, cancelled: 0, no_quorum: 0 }; for (const r of byStatus) st[r.status] = num(r.c);
  const live = `${f.sql} AND m.status <> 'cancelled'`;
  const byType = await db.prepare(`SELECT m.type, COUNT(*) c FROM mtg_meetings m WHERE ${live} GROUP BY m.type ORDER BY c DESC`).all(...f.args);
  const byCustom = await db.prepare(`SELECT t.id, t.name, COUNT(*) c FROM mtg_meetings m JOIN mtg_types t ON t.id = m.type_id WHERE ${live} GROUP BY t.id, t.name ORDER BY c DESC`).all(...f.args);
  const byDept = await db.prepare(`SELECT d.id, d.name, COUNT(*) c FROM mtg_meetings m JOIN rh_departments d ON d.id = m.department_id WHERE ${live} GROUP BY d.id, d.name ORDER BY c DESC`).all(...f.args);
  const bySite = await db.prepare(`SELECT b.id, b.name, COUNT(*) c FROM mtg_meetings m JOIN branches b ON b.id = m.branch_id WHERE ${live} GROUP BY b.id, b.name ORDER BY c DESC`).all(...f.args);
  const byUrg = await db.prepare(`SELECT m.urgency, COUNT(*) c FROM mtg_meetings m WHERE ${live} GROUP BY m.urgency`).all(...f.args);
  const multi = await db.prepare(`SELECT COUNT(*) c FROM mtg_meetings m WHERE ${live} AND (SELECT COUNT(DISTINCT z.s) FROM (SELECT ref_id AS s FROM mtg_scope WHERE meeting_id = m.id AND kind = 'site' UNION SELECT m.branch_id AS s WHERE m.branch_id IS NOT NULL) z) > 1`).get(...f.args);
  const inter = await db.prepare(`SELECT COUNT(*) c FROM mtg_meetings m WHERE ${live} AND (SELECT COUNT(DISTINCT z.s) FROM (SELECT ref_id AS s FROM mtg_scope WHERE meeting_id = m.id AND kind = 'dept' UNION SELECT m.department_id AS s WHERE m.department_id IS NOT NULL) z) > 1`).get(...f.args);

  const att = await db.prepare(`SELECT COALESCE(SUM(CASE WHEN p.attended = 'yes' THEN 1 ELSE 0 END), 0) y, COALESCE(SUM(CASE WHEN p.attended = 'no' THEN 1 ELSE 0 END), 0) n,
      COALESCE(SUM(CASE WHEN p.attended = 'yes' AND p.late_min > 0 THEN 1 ELSE 0 END), 0) late, COALESCE(AVG(CASE WHEN p.attended = 'yes' AND p.late_min > 0 THEN p.late_min END), 0) avg_late
    FROM mtg_participants p JOIN mtg_meetings m ON m.id = p.meeting_id WHERE ${f.sql} AND m.status IN ('held', 'no_quorum') AND p.required = 1`).get(...f.args);
  const dur = await db.prepare(`SELECT AVG(m.duration_min) planned, COUNT(*) n,
      AVG(CASE WHEN m.started_at IS NOT NULL AND m.ended_at IS NOT NULL THEN EXTRACT(EPOCH FROM (m.ended_at::timestamptz - m.started_at::timestamptz)) / 60 END) real,
      COALESCE(SUM(CASE WHEN m.started_at IS NOT NULL AND m.ended_at IS NOT NULL THEN 1 ELSE 0 END), 0) n_real,
      COALESCE(SUM(CASE WHEN m.started_at IS NOT NULL AND m.ended_at IS NOT NULL AND EXTRACT(EPOCH FROM (m.ended_at::timestamptz - m.started_at::timestamptz)) / 60 > m.duration_min THEN 1 ELSE 0 END), 0) n_over
    FROM mtg_meetings m WHERE ${f.sql} AND m.status = 'held'`).get(...f.args);
  const rs = await db.prepare(`SELECT r.status, COUNT(*) c FROM mtg_resolutions r JOIN mtg_meetings m ON m.id = r.meeting_id WHERE ${f.sql} GROUP BY r.status`).all(...f.args);
  const R = { pending: 0, adopted: 0, rejected: 0, postponed: 0, no_quorum: 0 }; for (const r of rs) R[r.status] = num(r.c);
  const decided = R.adopted + R.rejected + R.postponed + R.no_quorum;
  const tk = await db.prepare(`SELECT COUNT(*) total,
      COALESCE(SUM(CASE WHEN a.status = 'done' OR t.status = 'done' THEN 1 ELSE 0 END), 0) done,
      COALESCE(SUM(CASE WHEN (a.status = 'done' OR t.status = 'done') AND a.due IS NOT NULL AND t.done_at IS NOT NULL AND t.done_at > a.due THEN 1 ELSE 0 END), 0) done_late,
      COALESCE(SUM(CASE WHEN a.status = 'open' AND (t.id IS NULL OR t.status <> 'done') AND a.due IS NOT NULL AND a.due < ? THEN 1 ELSE 0 END), 0) late
    FROM mtg_actions a JOIN mtg_meetings m ON m.id = a.meeting_id LEFT JOIN tasks t ON t.id = a.task_id WHERE ${f.sql} AND a.task_id IS NOT NULL AND a.status <> 'cancelled'`).get(today, ...f.args);
  const months = {};
  const bump = (mo, k, v) => { (months[mo] = months[mo] || { month: mo, meetings: 0, attendance: null, adopted: 0, rejected: 0, postponed: 0, noQuorum: 0, _y: 0, _n: 0 })[k] += v; };
  for (const r of await db.prepare(`SELECT substr(m.date, 1, 7) mo, COUNT(*) c FROM mtg_meetings m WHERE ${live} GROUP BY 1`).all(...f.args)) bump(r.mo, 'meetings', num(r.c));
  for (const r of await db.prepare(`SELECT substr(m.date, 1, 7) mo, COALESCE(SUM(CASE WHEN p.attended = 'yes' THEN 1 ELSE 0 END), 0) y, COALESCE(SUM(CASE WHEN p.attended = 'no' THEN 1 ELSE 0 END), 0) n FROM mtg_participants p JOIN mtg_meetings m ON m.id = p.meeting_id WHERE ${f.sql} AND m.status IN ('held', 'no_quorum') AND p.required = 1 GROUP BY 1`).all(...f.args)) { bump(r.mo, '_y', num(r.y)); bump(r.mo, '_n', num(r.n)); }
  for (const r of await db.prepare(`SELECT substr(m.date, 1, 7) mo, r.status, COUNT(*) c FROM mtg_resolutions r JOIN mtg_meetings m ON m.id = r.meeting_id WHERE ${f.sql} GROUP BY 1, 2`).all(...f.args)) {
    const k = { adopted: 'adopted', rejected: 'rejected', postponed: 'postponed', no_quorum: 'noQuorum' }[r.status]; if (k) bump(r.mo, k, num(r.c));
  }
  const trend = Object.values(months).sort((a, b) => a.month.localeCompare(b.month)).map((x) => ({ month: x.month, meetings: x.meetings, attendance: pct(x._y, x._y + x._n), adopted: x.adopted, rejected: x.rejected, postponed: x.postponed, noQuorum: x.noQuorum, decisionRate: pct(x.adopted, x.adopted + x.rejected + x.postponed + x.noQuorum) }));
  res.json({
    period: { from: f.from, to: f.to },
    meetings: { total: st.planned + st.held + st.cancelled + st.no_quorum, ...st, multiSite: num(multi.c), interService: num(inter.c) },
    byType: byType.map((r) => ({ type: r.type, count: num(r.c) })), byCustomType: byCustom.map((r) => ({ id: Number(r.id), name: r.name, count: num(r.c) })),
    byService: byDept.map((r) => ({ id: Number(r.id), name: r.name, count: num(r.c) })), bySite: bySite.map((r) => ({ id: Number(r.id), name: r.name, count: num(r.c) })),
    byUrgency: byUrg.map((r) => ({ urgency: r.urgency, count: num(r.c) })),
    resolutions: { ...R, total: decided + R.pending, decisionRate: pct(R.adopted, decided), adoptionRate: pct(R.adopted, R.adopted + R.rejected) },
    attendance: { rate: pct(num(att.y), num(att.y) + num(att.n)), present: num(att.y), absent: num(att.n), lateCount: num(att.late), punctualityRate: pct(num(att.y) - num(att.late), num(att.y)), avgLateMin: Math.round(num(att.avg_late)) },
    duration: { avgPlannedMin: dur.planned === null ? null : Math.round(num(dur.planned)), avgRealMin: dur.real === null ? null : Math.round(num(dur.real)), measured: num(dur.n_real), overrunRate: pct(num(dur.n_over), num(dur.n_real)) },
    tasks: { total: num(tk.total), done: num(tk.done), doneLate: num(tk.done_late), open: num(tk.total) - num(tk.done), late: num(tk.late), doneRate: pct(num(tk.done), num(tk.total)) },
    trend,
  });
});

// =====================================================================================================================
// Suivi des performances et historique des responsabilités
// =====================================================================================================================
async function privileged(req, cfg) { return req.member.role === 'owner' || M.allowedTypes(req, cfg, 'convene').length > 0 || M.allowedTypes(req, cfg, 'validate').length > 0; }
async function targetUser(req, cfg, v) {
  const prv = await privileged(req, cfg);
  if (v === undefined || v === null || v === '') return prv ? null : req.user.id;
  const u = await A.memberOf(req, v);
  if (u !== req.user.id && !prv) throw new HttpError(403, "Vous ne pouvez consulter que votre propre suivi. Les personnes qui convoquent ou valident voient celui de l'équipe.");
  return u;
}
router.get('/performance', async (req, res) => {
  const cfg = await M.getConfig(req.org.id);
  const uid = await targetUser(req, cfg, req.query.userId);
  const f = filters(req, cfg, req.query);
  const today = M.today();
  const ua = uid ? ' AND a.assignee_id = ?' : ''; const up = uid ? ' AND p.user_id = ?' : ''; const ur = uid ? ' AND r.carrier_id = ?' : '';
  const acts = await db.prepare(`SELECT a.assignee_id uid, COUNT(*) total,
      COALESCE(SUM(CASE WHEN a.status = 'done' OR t.status = 'done' THEN 1 ELSE 0 END), 0) done,
      COALESCE(SUM(CASE WHEN (a.status = 'done' OR t.status = 'done') AND a.due IS NOT NULL AND t.done_at IS NOT NULL AND t.done_at > a.due THEN 1 ELSE 0 END), 0) done_late,
      COALESCE(SUM(CASE WHEN a.status = 'open' AND (t.id IS NULL OR t.status <> 'done') AND a.due IS NOT NULL AND a.due < ? THEN 1 ELSE 0 END), 0) late
    FROM mtg_actions a JOIN mtg_meetings m ON m.id = a.meeting_id LEFT JOIN tasks t ON t.id = a.task_id
    WHERE ${f.sql} AND a.task_id IS NOT NULL AND a.status <> 'cancelled' AND a.assignee_id IS NOT NULL${ua} GROUP BY a.assignee_id`).all(today, ...f.args, ...(uid ? [uid] : []));
  const pres = await db.prepare(`SELECT p.user_id uid, COUNT(*) convoked, COALESCE(SUM(CASE WHEN p.attended = 'yes' THEN 1 ELSE 0 END), 0) present,
      COALESCE(SUM(CASE WHEN p.response IN ('absent', 'excused') THEN 1 ELSE 0 END), 0) announced_absent,
      COALESCE(SUM(CASE WHEN p.attended = 'yes' AND p.late_min > 0 THEN 1 ELSE 0 END), 0) late, COALESCE(AVG(CASE WHEN p.attended = 'yes' AND p.late_min > 0 THEN p.late_min END), 0) avg_late
    FROM mtg_participants p JOIN mtg_meetings m ON m.id = p.meeting_id WHERE ${f.sql} AND m.status IN ('held', 'no_quorum') AND p.user_id IS NOT NULL${up} GROUP BY p.user_id`).all(...f.args, ...(uid ? [uid] : []));
  const rsl = await db.prepare(`SELECT r.carrier_id uid, COUNT(*) total, COALESCE(SUM(CASE WHEN r.status = 'adopted' THEN 1 ELSE 0 END), 0) adopted FROM mtg_resolutions r JOIN mtg_meetings m ON m.id = r.meeting_id WHERE ${f.sql} AND r.carrier_id IS NOT NULL${ur} GROUP BY r.carrier_id`).all(...f.args, ...(uid ? [uid] : []));
  const roles = await db.prepare(`SELECT x.uid, x.role, COUNT(*) c FROM (SELECT m.organizer_id uid, 'organizer' role, m.id FROM mtg_meetings m WHERE ${f.sql} AND m.status <> 'cancelled' UNION ALL SELECT m.secretary_id, 'secretary', m.id FROM mtg_meetings m WHERE ${f.sql} AND m.status <> 'cancelled' UNION ALL SELECT m.chair_id, 'chair', m.id FROM mtg_meetings m WHERE ${f.sql} AND m.status <> 'cancelled') x WHERE x.uid IS NOT NULL${uid ? ' AND x.uid = ?' : ''} GROUP BY x.uid, x.role`).all(...f.args, ...f.args, ...f.args, ...(uid ? [uid] : []));
  const ids = new Set([...acts, ...pres, ...rsl, ...roles].map((r) => Number(r.uid)));
  const nm = await names([...ids]);
  const rows = [...ids].map((id) => {
    const a = acts.find((x) => Number(x.uid) === id) || {}; const p = pres.find((x) => Number(x.uid) === id) || {}; const r = rsl.find((x) => Number(x.uid) === id) || {};
    const ro = Object.fromEntries(roles.filter((x) => Number(x.uid) === id).map((x) => [x.role, num(x.c)]));
    const total = num(a.total); const done = num(a.done); const conv = num(p.convoked); const present = num(p.present);
    return { userId: id, name: nm.get(id) || '',
      commitments: { total, done, doneLate: num(a.done_late), open: total - done, late: num(a.late), completionRate: pct(done, total), onTimeRate: pct(done - num(a.done_late), total) },
      attendance: { convoked: conv, present, announcedAbsent: num(p.announced_absent), late: num(p.late), avgLateMin: Math.round(num(p.avg_late)), presenceRate: pct(present, conv), punctualityRate: pct(present - num(p.late), present) },
      resolutions: { carried: num(r.total), adopted: num(r.adopted) }, roles: { organizer: ro.organizer || 0, secretary: ro.secretary || 0, chair: ro.chair || 0 } };
  }).sort((a, b) => (b.commitments.late - a.commitments.late) || a.name.localeCompare(b.name));
  res.json({ period: { from: f.from, to: f.to }, scope: uid ? 'person' : 'team', people: rows });
});

/** Historique chronologique : qui a été responsable de quoi (rôles de séance, actions, résolutions), par personne et par sujet. */
router.get('/responsibilities', async (req, res) => {
  const cfg = await M.getConfig(req.org.id);
  const uid = await targetUser(req, cfg, req.query.userId);
  const vis = M.visibleSql(req, cfg);
  const q = req.query;
  const where = ['r.org_id = ?']; const args = [req.org.id];
  if (uid) { where.push('r.user_id = ?'); args.push(uid); }
  if (q.meetingId) { where.push('r.meeting_id = ?'); args.push(A.id(q.meetingId)); }
  if (q.kind) { where.push('r.kind = ?'); args.push(A.oneOf(q.kind, ['role', 'action', 'resolution'], undefined, 'Nature inconnue.')); }
  if (q.from) { where.push('r.at >= ?'); args.push(A.date(q.from)); }
  if (q.to) { where.push('r.at < ?'); args.push(M.addDays(A.date(q.to), 1)); }
  if (q.projectId) { where.push('m.project_id = ?'); args.push(A.id(q.projectId)); }
  if (q.q) { where.push("(r.subject ILIKE ? ESCAPE '\\' OR m.title ILIKE ? ESCAPE '\\')"); const l = `%${A.text(q.q, 100).replace(/[\\%_]/g, '\\$&')}%`; args.push(l, l); }
  const rows = await db.prepare(`SELECT r.*, m.title AS mtitle, m.date AS mdate, m.confidential AS mconf, u.name AS uname, b.name AS by_name,
      a.status AS a_status, t.status AS t_status, a.due AS a_due, rs.status AS res_status, rs.number AS res_number
    FROM mtg_resp r LEFT JOIN mtg_meetings m ON m.id = r.meeting_id LEFT JOIN users u ON u.id = r.user_id LEFT JOIN users b ON b.id = r.by_user
    LEFT JOIN mtg_actions a ON r.kind = 'action' AND a.id = r.ref_id LEFT JOIN tasks t ON t.id = a.task_id LEFT JOIN mtg_resolutions rs ON r.kind = 'resolution' AND rs.id = r.ref_id
    WHERE ${where.join(' AND ')}${vis.sql} ORDER BY r.at DESC, r.id DESC LIMIT 500`).all(...args, ...vis.args);
  const events = rows.map((r) => ({ id: Number(r.id), at: r.at, kind: r.kind, role: r.role, event: r.event, userId: r.user_id == null ? null : Number(r.user_id), person: r.uname || r.user_name || '',
    subject: Number(r.mconf) && !(req.member.role === 'owner') ? oneLine(r.subject, 300) : r.subject, meetingId: r.meeting_id == null ? null : Number(r.meeting_id), meetingTitle: r.mtitle || '', meetingDate: r.mdate || null, by: r.by_name || '',
    state: r.kind === 'action' ? (r.a_status === 'cancelled' ? 'cancelled' : r.a_status === 'done' || r.t_status === 'done' ? 'done' : r.a_due && r.a_due < M.today() ? 'late' : 'open') : r.kind === 'resolution' ? r.res_status : null, number: r.res_number || null }));
  // Responsables actuels : dernier événement par sujet et par rôle (une personne « déchargée » n'est plus responsable).
  const seen = new Set(); const current = [];
  for (const e of [...events].sort((a, b) => (b.at < a.at ? -1 : b.at > a.at ? 1 : b.id - a.id))) {
    const key = `${e.kind}:${e.role}:${e.subject}:${e.meetingId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (e.event === 'assigned') current.push(e);
  }
  res.json({ events, current: current.slice(0, 200), scope: uid ? 'person' : 'team' });
});

/** Engagements non tenus (action échue et non faite), par personne : sert de base au rappel et à l'aide de l'IA. */
async function lateCommitments(req, cfg, userId) {
  const vis = M.visibleSql(req, cfg);
  const rows = await db.prepare(`SELECT a.id, a.text, a.due, a.assignee_id, a.assignee_name, a.meeting_id, m.title AS mtitle, m.date AS mdate, u.name AS uname
    FROM mtg_actions a JOIN mtg_meetings m ON m.id = a.meeting_id LEFT JOIN tasks t ON t.id = a.task_id LEFT JOIN users u ON u.id = a.assignee_id
    WHERE m.org_id = ? AND a.task_id IS NOT NULL AND a.status = 'open' AND (t.id IS NULL OR t.status <> 'done') AND a.due IS NOT NULL AND a.due < ?${userId ? ' AND a.assignee_id = ?' : ''}${vis.sql} ORDER BY a.due, a.id LIMIT 200`)
    .all(req.org.id, M.today(), ...(userId ? [userId] : []), ...vis.args);
  return rows.map((a) => ({ id: Number(a.id), text: a.text, due: a.due, assigneeId: a.assignee_id == null ? null : Number(a.assignee_id), assignee: a.uname || a.assignee_name || '', meetingId: Number(a.meeting_id), meetingTitle: a.mtitle, meetingDate: a.mdate,
    daysLate: Math.round((Date.parse(M.today()) - Date.parse(a.due)) / 86400000) }));
}
router.get('/commitments/late', async (req, res) => {
  const cfg = await M.getConfig(req.org.id);
  const uid = await targetUser(req, cfg, req.query.userId);
  res.json({ commitments: await lateCommitments(req, cfg, uid) });
});
/** Relance : notice dans l'application aux personnes en retard (réservé à ceux qui convoquent ou valident). */
router.post('/commitments/remind', async (req, res) => {
  const cfg = await M.getConfig(req.org.id);
  if (!(await privileged(req, cfg))) throw new HttpError(403, "Vous n'avez pas le droit de relancer l'équipe.");
  const late = (await lateCommitments(req, cfg, null)).filter((a) => a.assigneeId);
  const by = new Map();
  for (const a of late) { if (!by.has(a.assigneeId)) by.set(a.assigneeId, []); by.get(a.assigneeId).push(a); }
  for (const [uid, list] of by) await M.notice(req.org.id, uid, 'meeting_action', `Engagements en retard (${list.length}) : ${oneLine(list.slice(0, 3).map((x) => x.text).join(' ; '), 220)}`, 'meetings');
  await M.mlog(req, null, 'remind', `Relance des engagements non tenus : ${by.size} personne(s)`, by.size);
  res.json({ ok: true, people: by.size, commitments: late.length });
});

module.exports = { router, buildPvContent, signMinutes, lateCommitments, currentPv, pvHash, filters, privileged };
