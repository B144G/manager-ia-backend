'use strict';
// Production avancée, étape 2 : Kanban (nombre de cartes, signaux de réapprovisionnement) et 5S (audits par zone, radar, plan d'actions). Calculs purs.
const r1 = (n) => Math.round(n * 10) / 10;
const num = (v, label, { min = 0, max = 1e9, def = 0 } = {}) => {
  if (v === undefined || v === null || v === '') return def;
  const n = typeof v === 'string' ? Number(v.replace(/\s/g, '').replace(',', '.')) : Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${label} : nombre invalide.`);
  return n;
};
const str = (v, max, def = '') => String(v == null ? def : v).trim().slice(0, max);
const id = (v, i, p) => str(v || `${p}${i + 1}`, 24).replace(/[^\w-]/g, '') || `${p}${i + 1}`;
const date = (v) => { const s = str(v, 10); if (!s) return ''; if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) throw new Error('Date invalide (AAAA-MM-JJ).'); return s; };

// ---------- Kanban ----------
function cleanKanban(d) {
  const items = Array.isArray(d && d.items) ? d.items : [];
  if (items.length > 30) throw new Error('30 articles au plus.');
  return { items: items.map((it, i) => ({ id: id(it.id, i, 'k'), name: str(it.name, 80) || `Article ${i + 1}`, source: it.source === 'buy' ? 'buy' : 'make', demandPerDay: num(it.demandPerDay, 'Demande par jour'), leadTimeDays: num(it.leadTimeDays, 'Délai (jours)', { max: 365 }), waitDays: num(it.waitDays, 'Attente (jours)', { max: 365 }),
    containerQty: num(it.containerQty, 'Quantité par bac', { min: 0.0001, def: 1 }), safetyPct: num(it.safetyPct, 'Sécurité (%)', { max: 300, def: 10 }), onHand: num(it.onHand, 'Stock'), inProd: num(it.inProd, 'Cartes en cours', { max: 1000 }), cards: it.cards === '' || it.cards == null ? null : Math.round(num(it.cards, 'Cartes en circulation', { max: 1000 })) })) };
}
/** Nombre de cartes N = demande × (délai + attente) × (1 + sécurité) / quantité par bac, arrondi au-dessus. */
function computeKanban(doc) {
  const items = doc.items.map((it) => {
    const raw = it.demandPerDay * (it.leadTimeDays + it.waitDays) * (1 + it.safetyPct / 100) / it.containerQty;
    const cards = it.cards !== null ? it.cards : Math.max(Math.ceil(raw - 1e-9), it.demandPerDay > 0 ? 1 : 0);
    const full = Math.min(Math.floor(it.onHand / it.containerQty + 1e-9), cards);
    const inProd = Math.min(Math.round(it.inProd), Math.max(cards - full, 0));
    const empty = Math.max(cards - full - inProd, 0);
    const reorderPoint = it.demandPerDay * it.leadTimeDays;
    const signal = empty > 0 ? 'refill' : full <= Math.max(Math.floor(cards * 0.25), 0) && cards > 0 ? 'watch' : 'ok';
    return { id: it.id, name: it.name, source: it.source, cardsComputed: Math.max(Math.ceil(raw - 1e-9), it.demandPerDay > 0 ? 1 : 0), cards, full, inProd, empty, containerQty: it.containerQty, reorderPoint: r1(reorderPoint), onHand: it.onHand, signal, refillQty: r1(empty * it.containerQty), maxStock: r1(cards * it.containerQty), coverDays: it.demandPerDay > 0 ? r1(it.onHand / it.demandPerDay) : null };
  });
  return { items, refill: items.filter((x) => x.signal === 'refill'), totalCards: items.reduce((a, x) => a + x.cards, 0) };
}

// ---------- 5S ----------
const S5 = ['sort', 'set', 'shine', 'standardize', 'sustain'];
function cleanFives(d) {
  const zones = Array.isArray(d && d.zones) ? d.zones : [];
  if (zones.length > 20) throw new Error('20 zones au plus.');
  return { zones: zones.map((z, i) => {
    const audits = (Array.isArray(z.audits) ? z.audits : []).slice(-24).map((a) => ({ date: date(a.date), note: str(a.note, 500), scores: Object.fromEntries(S5.map((k) => [k, Math.round(num(a.scores && a.scores[k], 'Note', { max: 4 }))])),
      photos: (Array.isArray(a.photos) ? a.photos : []).slice(0, 2).map((p) => String(p || '')).filter((p) => /^data:image\/(jpeg|png|webp);base64,/.test(p) && p.length <= 400000) }));
    const actions = (Array.isArray(z.actions) ? z.actions : []).slice(0, 60).map((a, j) => ({ id: id(a.id, j, 'a'), s: S5.includes(a.s) ? a.s : 'sort', text: str(a.text, 200), owner: str(a.owner, 60), due: date(a.due), status: ['todo', 'doing', 'done'].includes(a.status) ? a.status : 'todo' })).filter((a) => a.text);
    return { id: id(z.id, i, 'z'), name: str(z.name, 80) || `Zone ${i + 1}`, audits: audits.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)), actions };
  }) };
}
const pctOf = (sc) => Math.round(S5.reduce((a, k) => a + (sc[k] || 0), 0) / (S5.length * 4) * 100);
function computeFives(doc, today = new Date().toISOString().slice(0, 10)) {
  const zones = doc.zones.map((z) => {
    const last = z.audits[z.audits.length - 1] || null; const prev = z.audits.length > 1 ? z.audits[z.audits.length - 2] : null;
    const weakest = last ? [...S5].sort((a, b) => last.scores[a] - last.scores[b])[0] : null;
    const open = z.actions.filter((a) => a.status !== 'done');
    return { id: z.id, name: z.name, audits: z.audits.length, last: last ? { date: last.date, scores: last.scores, pct: pctOf(last.scores), note: last.note, photos: last.photos.length } : null, previous: prev ? { date: prev.date, scores: prev.scores, pct: pctOf(prev.scores) } : null,
      trend: z.audits.map((a) => ({ date: a.date, pct: pctOf(a.scores) })), weakest, level: last ? (pctOf(last.scores) >= 80 ? 'good' : pctOf(last.scores) >= 55 ? 'fair' : 'poor') : null, delta: last && prev ? pctOf(last.scores) - pctOf(prev.scores) : null,
      openActions: open.length, lateActions: open.filter((a) => a.due && a.due < today).length, actions: z.actions };
  });
  const scored = zones.filter((z) => z.last);
  const avg = scored.length ? Math.round(scored.reduce((a, z) => a + z.last.pct, 0) / scored.length) : null;
  const byS = S5.map((k) => ({ s: k, avg: scored.length ? r1(scored.reduce((a, z) => a + z.last.scores[k], 0) / scored.length) : null }));
  return { zones, average: avg, byS, weakestS: byS.filter((x) => x.avg !== null).sort((a, b) => a.avg - b.avg)[0] || null, lateActions: zones.reduce((a, z) => a + z.lateActions, 0), unaudited: zones.filter((z) => !z.last).map((z) => z.name) };
}

module.exports = { cleanKanban, computeKanban, cleanFives, computeFives, S5 };
