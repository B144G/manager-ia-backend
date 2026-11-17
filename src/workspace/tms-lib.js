'use strict';
// Transport (TMS) — calculs purs, sans base de données ni route : distances (haversine ou matrice de zones), ordre de passage
// (plus proche voisin puis 2-opt, avec pénalité pour les créneaux manqués), heures d'arrivée estimées, chargement des véhicules,
// tarifs de transport et répartition d'un coût. Tout est déterministe : les tests recalculent les mêmes valeurs à la main.

const R_EARTH = 6371; // km
const round1 = (n) => Math.round(n * 10) / 10;
const round3 = (n) => Math.round(n * 1000) / 1000;
const hasGps = (p) => p && p.lat !== null && p.lat !== undefined && p.lng !== null && p.lng !== undefined && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng));

/** Distance à vol d'oiseau (km) entre deux points GPS. */
function haversine(a, b) {
  const rad = (d) => (Number(d) * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat); const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Fabrique la fonction de distance routière (km) entre deux points { lat, lng, zoneId, depot }.
 *  1. Les deux points ont des coordonnées GPS : haversine × coefficient routier (1,3 par défaut : les routes ne sont pas droites).
 *  2. Sinon, par les zones : même zone → distance interne de la zone ; dépôt ↔ zone → « distance depuis le dépôt » de la zone ;
 *     deux zones → matrice saisie (dans un sens ou dans l'autre), à défaut |dépôt→A − dépôt→B| (estimation basse).
 *  3. Rien de connu : null (la distance est inconnue).
 * ctx : { roadFactor, zones: Map(id → { depotKm, intraKm }), matrix: Map('a-b' → km) }
 */
function distanceFn(ctx) {
  const f = Number(ctx.roadFactor) > 0 ? Number(ctx.roadFactor) : 1.3;
  const zones = ctx.zones || new Map(); const matrix = ctx.matrix || new Map();
  const zkm = (z) => { const x = zones.get(Number(z)); return x && x.depotKm !== null && x.depotKm !== undefined ? Number(x.depotKm) : null; };
  return (a, b) => {
    if (hasGps(a) && hasGps(b)) return round1(haversine(a, b) * f);
    if (a.depot && b.depot) return 0;
    if (a.depot || b.depot) { const s = a.depot ? b : a; return s.zoneId ? zkm(s.zoneId) : null; }
    if (!a.zoneId || !b.zoneId) return null;
    if (Number(a.zoneId) === Number(b.zoneId)) { const z = zones.get(Number(a.zoneId)); return z ? Number(z.intraKm || 0) : 0; }
    const m = matrix.get(`${a.zoneId}-${b.zoneId}`) ?? matrix.get(`${b.zoneId}-${a.zoneId}`);
    if (m !== undefined && m !== null) return Number(m);
    const x = zkm(a.zoneId); const y = zkm(b.zoneId);
    return x !== null && y !== null ? round1(Math.abs(x - y)) : null;
  };
}

/** Matrice des distances : point 0 = dépôt, puis les arrêts. complete = toutes les distances sont connues. */
function matrixOf(depot, stops, dist) {
  const pts = [{ ...depot, depot: true }, ...stops];
  let complete = true;
  const m = pts.map((p) => pts.map((q) => { if (p === q) return 0; const d = dist(p, q); if (d === null || d === undefined) { complete = false; return 0; } return d; }));
  return { m, complete };
}

const toMin = (hhmm) => { const r = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '')); return r ? Number(r[1]) * 60 + Number(r[2]) : null; };
const toHHMM = (min) => { const m = ((Math.round(min) % 1440) + 1440) % 1440; return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };

/**
 * Heures d'arrivée le long d'un ordre (indices dans la matrice, 0 = dépôt exclu de `order`).
 * Arrivée = départ précédent + trajet (km ÷ vitesse) ; attente si on arrive avant le début du créneau ; départ = arrivée + temps d'arrêt.
 * Renvoie { km (aller + retour au dépôt), stops: [{ idx, arrive, leave, late }], late (nombre de créneaux manqués), endMin }.
 */
function schedule(order, m, stops, { startMin = 480, speed = 30, serviceMin = 10, returnToDepot = true } = {}) {
  let t = startMin; let prev = 0; let km = 0; let late = 0;
  const out = [];
  for (const idx of order) {
    const d = m[prev][idx]; km += d;
    t += (d / Math.max(speed, 1)) * 60;
    const s = stops[idx - 1];
    const ws = toMin(s.windowStart); const we = toMin(s.windowEnd);
    if (ws !== null && t < ws) t = ws;
    const isLate = we !== null && t > we + 1e-9;
    if (isLate) late++;
    out.push({ idx, arrive: Math.round(t), leave: Math.round(t + serviceMin), late: isLate });
    t += serviceMin; prev = idx;
  }
  if (returnToDepot && order.length) km += m[prev][0];
  return { km: round1(km), stops: out, late, endMin: Math.round(t) };
}

/** Coût d'un ordre : kilomètres + forte pénalité par créneau manqué (on préfère quelques km de plus à un client livré en retard). */
const LATE_PENALTY = 1000;
const costOf = (order, m, stops, opt) => { const s = schedule(order, m, stops, opt); return s.km + LATE_PENALTY * s.late; };

/** Plus proche voisin depuis le dépôt ; à distance égale, la priorité la plus haute puis le créneau qui ferme le plus tôt. */
function nearestNeighbour(m, stops) {
  const left = new Set(stops.map((_, i) => i + 1)); const order = []; let cur = 0;
  while (left.size) {
    let best = null;
    for (const j of left) {
      const s = stops[j - 1]; const b = best === null ? null : stops[best - 1];
      const better = best === null || m[cur][j] < m[cur][best] - 1e-9 || (Math.abs(m[cur][j] - m[cur][best]) <= 1e-9 && ((s.priority || 0) > (b.priority || 0) || ((s.priority || 0) === (b.priority || 0) && (toMin(s.windowEnd) ?? 9999) < (toMin(b.windowEnd) ?? 9999))));
      if (better) best = j;
    }
    order.push(best); left.delete(best); cur = best;
  }
  return order;
}

/** 2-opt : inverse un segment tant que le coût (km + pénalités de retard) baisse. */
function twoOpt(order, m, stops, opt) {
  let best = order.slice(); let bestCost = costOf(best, m, stops, opt); let improved = true; let guard = 0;
  while (improved && guard++ < 200) {
    improved = false;
    for (let i = 0; i < best.length - 1; i++) {
      for (let k = i + 1; k < best.length; k++) {
        const cand = best.slice(0, i).concat(best.slice(i, k + 1).reverse(), best.slice(k + 1));
        const c = costOf(cand, m, stops, opt);
        if (c < bestCost - 1e-9) { best = cand; bestCost = c; improved = true; }
      }
    }
  }
  return best;
}

/**
 * Ordre de passage d'une tournée. stops = [{ id, lat, lng, zoneId, zoneOrder, priority, windowStart, windowEnd }].
 * Si toutes les distances sont connues : plus proche voisin puis 2-opt (méthode « route ») ; sinon ordre des zones
 * (rang de la zone, puis distance depuis le dépôt), priorité, fin de créneau (méthode « zones »).
 * Renvoie { method, order: [stop], km (null si inconnu), etas: [{ id, arrive 'HH:MM', leave, late }], late, endTime }.
 */
function sequence(depot, stops, dist, opt = {}) {
  if (!stops.length) return { method: 'none', order: [], km: 0, etas: [], late: 0, endTime: toHHMM(opt.startMin || 480) };
  const { m, complete } = matrixOf(depot, stops, dist);
  let order; let method;
  if (complete) { method = 'route'; order = twoOpt(nearestNeighbour(m, stops), m, stops, opt); }
  else {
    method = 'zones';
    order = stops.map((_, i) => i + 1).sort((a, b) => {
      const x = stops[a - 1]; const y = stops[b - 1];
      return (x.zoneOrder ?? 1e9) - (y.zoneOrder ?? 1e9) || (y.priority || 0) - (x.priority || 0) || (toMin(x.windowEnd) ?? 9999) - (toMin(y.windowEnd) ?? 9999) || x.id - y.id;
    });
  }
  const s = schedule(order, m, stops, opt);
  return { method, order: order.map((i) => stops[i - 1]), km: complete ? s.km : null, etas: s.stops.map((x) => ({ id: stops[x.idx - 1].id, arrive: toHHMM(x.arrive), leave: toHHMM(x.leave), late: x.late })), late: s.late, endTime: toHHMM(s.endMin) };
}

// ---------- Chargement ----------
/** Somme des charges et taux d'occupation (%) par rapport aux capacités (0 = capacité non renseignée → non contrôlée). */
function load(list, veh) {
  const t = list.reduce((a, d) => ({ kg: a.kg + Number(d.weight || 0), m3: a.m3 + Number(d.volume || 0), pal: a.pal + Number(d.pallets || 0) }), { kg: 0, m3: 0, pal: 0 });
  const pct = (v, c) => (Number(c) > 0 ? Math.round((1000 * v) / Number(c)) / 10 : null);
  const v = veh || {};
  const over = [];
  if (Number(v.capacityKg) > 0 && t.kg > Number(v.capacityKg) + 1e-9) over.push('kg');
  if (Number(v.capacityM3) > 0 && t.m3 > Number(v.capacityM3) + 1e-9) over.push('m3');
  if (Number(v.capacityPallets) > 0 && t.pal > Number(v.capacityPallets) + 1e-9) over.push('pallets');
  return { weight: round3(t.kg), volume: round3(t.m3), pallets: round3(t.pal), pctKg: pct(t.kg, v.capacityKg), pctM3: pct(t.m3, v.capacityM3), pctPallets: pct(t.pal, v.capacityPallets), over };
}
const fits = (cur, d, veh) => load(cur.concat([d]), veh).over.length === 0;

/**
 * Répartit des livraisons entre véhicules (premier qui convient, livraisons triées par priorité puis poids décroissant),
 * en gardant ensemble une même zone tant que possible : on remplit d'abord le véhicule qui dessert déjà la zone.
 * vehicles = [{ id, capacityKg, capacityM3, capacityPallets }] ; renvoie { bins: [{ vehicle, deliveries }], unassigned: [{ delivery, reason }] }.
 */
function pack(deliveries, vehicles) {
  const bins = vehicles.map((v) => ({ vehicle: v, deliveries: [], zones: new Set() }));
  const unassigned = [];
  const list = deliveries.slice().sort((a, b) => (b.priority || 0) - (a.priority || 0) || Number(b.weight || 0) - Number(a.weight || 0) || a.id - b.id);
  for (const d of list) {
    const ordered = bins.slice().sort((x, y) => Number(y.zones.has(d.zoneId)) - Number(x.zones.has(d.zoneId)) || Number(y.deliveries.length > 0) - Number(x.deliveries.length > 0));
    const bin = ordered.find((b) => fits(b.deliveries, d, b.vehicle));
    if (!bin) { unassigned.push({ delivery: d, reason: vehicles.length ? 'capacity' : 'no_vehicle' }); continue; }
    bin.deliveries.push(d); if (d.zoneId) bin.zones.add(d.zoneId);
  }
  return { bins: bins.filter((b) => b.deliveries.length).map((b) => ({ vehicle: b.vehicle, deliveries: b.deliveries })), unassigned };
}

// ---------- Tarifs ----------
/**
 * Prix d'une course selon une grille :
 *   fret = base + prix au kg × poids + prix au km × distance + prix par palette × palettes ;
 *   fret retenu = max(fret, minimum de perception) ; total = arrondi(fret retenu × (1 + surcharge carburant % ÷ 100)).
 * Tous les montants sont des FCFA entiers ; le poids et la distance peuvent avoir des décimales.
 */
function priceOf(card, { weight = 0, km = 0, pallets = 0 }) {
  const parts = { base: Number(card.base || 0), weight: Math.round(Number(card.perKg || 0) * Number(weight || 0)), distance: Math.round(Number(card.perKm || 0) * Number(km || 0)), pallets: Math.round(Number(card.perPallet || 0) * Number(pallets || 0)) };
  const freight = parts.base + parts.weight + parts.distance + parts.pallets;
  const kept = Math.max(freight, Number(card.minCharge || 0));
  const fuel = Math.round((kept * Number(card.fuelPct || 0)) / 100);
  return { ...parts, freight, minimumApplied: kept > freight, kept, fuel, total: kept + fuel };
}

/**
 * Grille applicable : active, dans ses dates, même transporteur (ou flotte propre si carrierId nul), zone exacte ou toutes zones,
 * tranche de poids [min, max[. La plus précise gagne (zone exacte avant « toutes zones »), puis la tranche la plus étroite, puis la plus récente.
 */
function pickCard(cards, { carrierId = null, zoneId = null, weight = 0, date }) {
  const w = Number(weight || 0);
  const ok = cards.filter((c) => Number(c.active) && (c.carrierId ? Number(c.carrierId) === Number(carrierId || 0) : !carrierId)
    && (!c.zoneId || Number(c.zoneId) === Number(zoneId || 0)) && w >= Number(c.minKg || 0) - 1e-9 && (c.maxKg === null || c.maxKg === undefined || w < Number(c.maxKg) - 1e-9)
    && (!date || ((!c.validFrom || c.validFrom <= date) && (!c.validTo || c.validTo >= date))));
  ok.sort((a, b) => Number(Boolean(b.zoneId)) - Number(Boolean(a.zoneId)) || ((a.maxKg ?? 1e12) - Number(a.minKg || 0)) - ((b.maxKg ?? 1e12) - Number(b.minKg || 0)) || b.id - a.id);
  return ok[0] || null;
}

/**
 * Répartit un montant entier entre des parts proportionnelles aux poids (méthode du plus fort reste : la somme tombe juste).
 * Poids tous nuls → parts égales.
 */
function allocate(total, weights) {
  const n = weights.length; if (!n) return [];
  const w = weights.map((x) => Math.max(0, Number(x) || 0)); const sum = w.reduce((a, x) => a + x, 0);
  const base = sum > 0 ? w.map((x) => (total * x) / sum) : w.map(() => total / n);
  const fl = base.map(Math.floor); let rest = total - fl.reduce((a, x) => a + x, 0);
  const order = base.map((x, i) => [x - Math.floor(x), i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let k = 0; rest > 0; k = (k + 1) % n, rest--) fl[order[k][1]]++;
  return fl;
}

module.exports = { haversine, distanceFn, matrixOf, schedule, nearestNeighbour, twoOpt, sequence, load, pack, priceOf, pickCard, allocate, toMin, toHHMM, hasGps, round1, round3, LATE_PENALTY };
