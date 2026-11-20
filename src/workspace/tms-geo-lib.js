'use strict';
// Transport · géolocalisation — calculs purs (sans base de données ni route) : ancienneté d'une position, état d'un transporteur
// (disponible / indisponible et pourquoi), distance et durée estimées, et recommandation des deux meilleurs transporteurs.
// Tout est déterministe : les tests recalculent les mêmes valeurs à la main (voir docs/transport-geo.md).
const T = require('./tms-lib');

const round1 = (n) => Math.round(n * 10) / 10;
const MANUAL_STATES = ['', 'available', 'absent', 'out_of_service', 'full', 'busy'];
const SOURCES_CLIENT = ['address', 'pin', 'gps', 'manual'];
// Pondération du score (somme = 1). Voir la documentation : distance 30 %, délai 15 %, coût 20 %, fiabilité 20 %, charge 15 %.
const WEIGHTS = { distance: 0.30, time: 0.15, cost: 0.20, reliability: 0.20, capacity: 0.15 };
const STALE_PENALTY = 15; // points retirés quand la position est ancienne (mais encore affichée)
const DEFAULT_RELIABILITY = 0.75; const MIN_SAMPLE = 3;

/** Ancienneté en minutes (entier) d'un horodatage ISO ; null si inconnu. */
function ageMin(at, now = Date.now()) {
  const t = Date.parse(at || ''); if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.round((now - t) / 60000));
}
/** État d'une position : none (aucune), fresh, stale (plus vieille que `staleMin`), lost (plus vieille que `lostMin` : masquée). */
function positionState(age, { staleMin = 30, lostMin = 240 } = {}) {
  if (age === null || age === undefined) return 'none';
  if (age > lostMin) return 'lost';
  return age > staleMin ? 'stale' : 'fresh';
}

/**
 * État d'un transporteur. Ordre de priorité (le premier motif trouvé l'emporte) :
 *  1. blocages réels (fiche en pause, véhicule hors parc, papiers périmés) → indisponible « hors service » (même si le statut manuel dit disponible) ;
 *  2. statut manuel : absent / hors service / chargement plein / en mission ; « disponible » force le vert sauf blocage réel ;
 *  3. en mission (une tournée en cours aujourd'hui) ;
 *  4. chargement plein (poids, volume ou palettes de la journée ≥ capacité du véhicule) ;
 *  5. sinon disponible.
 * Renvoie { available, reason, manual } avec reason ∈ absent | on_mission | out_of_service | full | null.
 */
function driverState({ active = true, hardBlock = false, manualState = '', onMission = false, full = false } = {}) {
  if (!active || hardBlock) return { available: false, reason: 'out_of_service', manual: false };
  if (manualState === 'absent') return { available: false, reason: 'absent', manual: true };
  if (manualState === 'out_of_service') return { available: false, reason: 'out_of_service', manual: true };
  if (manualState === 'full') return { available: false, reason: 'full', manual: true };
  if (manualState === 'busy') return { available: false, reason: 'on_mission', manual: true };
  if (manualState === 'available') return { available: true, reason: null, manual: true };
  if (onMission) return { available: false, reason: 'on_mission', manual: false };
  if (full) return { available: false, reason: 'full', manual: false };
  return { available: true, reason: null, manual: false };
}

/** Trajet estimé entre deux points GPS : distance routière (haversine × coefficient) et durée (distance ÷ vitesse moyenne). */
function leg(a, b, { roadFactor = 1.3, speedKmh = 30 } = {}) {
  if (!T.hasGps(a) || !T.hasGps(b)) return null;
  const straight = T.haversine({ lat: Number(a.lat), lng: Number(a.lng) }, { lat: Number(b.lat), lng: Number(b.lng) });
  const km = round1(straight * (Number(roadFactor) > 0 ? Number(roadFactor) : 1.3));
  return { straightKm: round1(straight), km, minutes: Math.max(1, Math.round((km / Math.max(Number(speedKmh), 1)) * 60)) };
}

/**
 * Charge d'un véhicule face à une livraison : reste = capacité − charge déjà affectée ce jour-là. Capacité 0 = non renseignée (on ne bloque pas).
 * Renvoie { fits, known, remaining: {kg, m3, pallets}, over: [dimensions dépassées], ratio } ; ratio = part de la capacité (poids) occupée après ajout.
 */
function capacityFit(vehicle, loaded, delivery) {
  const dims = [['kg', 'capacityKg', 'weight'], ['m3', 'capacityM3', 'volume'], ['pallets', 'capacityPallets', 'pallets']];
  const remaining = {}; const over = []; let known = false; let ratio = null;
  for (const [k, capK, dK] of dims) {
    const cap = vehicle ? Number(vehicle[capK] || 0) : 0;
    if (cap > 0) {
      known = true;
      remaining[k] = Math.round((cap - Number(loaded[dK] || 0)) * 1000) / 1000;
      if (Number(delivery[dK] || 0) > remaining[k] + 1e-9) over.push(k);
      if (k === 'kg') ratio = Math.min(1, (Number(loaded[dK] || 0) + Number(delivery[dK] || 0)) / cap);
    } else remaining[k] = null;
  }
  return { fits: over.length === 0, known, remaining, over, ratio };
}

/** Coût estimé : (trajet jusqu'au client + retour au dépôt, ou le même trajet à défaut de dépôt) × coût au km du véhicule + indemnité du chauffeur (si aucune tournée ce jour-là). */
function estimateCost({ approachKm, backKm, costPerKm = 0, allowance = 0, hasRound = false }) {
  const km = Number(approachKm) + (backKm === null || backKm === undefined ? Number(approachKm) : Number(backKm));
  return { km: round1(km), cost: Math.round(km * Number(costPerKm || 0)) + (hasRound ? 0 : Number(allowance || 0)) };
}

/** Fiabilité historique : livraisons réussies ÷ livraisons terminées (réussies + échecs + retours). Moins de 3 : valeur neutre signalée. */
function reliability({ done = 0, failed = 0 } = {}) {
  const n = Number(done) + Number(failed);
  if (n < MIN_SAMPLE) return { rate: DEFAULT_RELIABILITY, sample: n, low: true };
  return { rate: Math.round((Number(done) / n) * 1000) / 1000, sample: n, low: false };
}

/**
 * Recommande les DEUX meilleurs transporteurs parmi des candidats { id, name, km, minutes, cost, reliability: {rate, sample, low}, capacity (capacityFit), stale }.
 * Seuls les candidats disponibles, dont la charge tient dans le véhicule, sont retenus (le choix final reste à la personne).
 * Chaque critère est ramené entre 0 et 1 face au meilleur candidat ; score = Σ poids × critère − pénalité si position ancienne.
 */
function recommend(cands, { limit = 2 } = {}) {
  const ok = cands.filter((c) => c.available && c.capacity.fits && T.hasGps({ lat: c.lat, lng: c.lng }) && c.km !== null && c.km !== undefined);
  if (!ok.length) return [];
  const minKm = Math.min(...ok.map((c) => c.km)); const minMin = Math.min(...ok.map((c) => c.minutes));
  const costs = ok.map((c) => c.cost).filter((x) => x !== null && x !== undefined); const minCost = costs.length ? Math.min(...costs) : null;
  const ratio = (best, v) => (v <= 0 ? 1 : Math.min(1, best / v));
  const scored = ok.map((c) => {
    const parts = {
      distance: ratio(minKm, c.km),
      time: ratio(minMin, c.minutes),
      cost: c.cost === null || c.cost === undefined || minCost === null ? 0.5 : (c.cost <= 0 ? 1 : ratio(minCost, c.cost)),
      reliability: c.reliability.rate,
      capacity: !c.capacity.known ? 0.6 : Math.round((0.7 + 0.3 * (1 - (c.capacity.ratio || 0))) * 1000) / 1000,
    };
    let score = 0; for (const k of Object.keys(WEIGHTS)) score += WEIGHTS[k] * parts[k];
    score = Math.round((score * 100 - (c.stale ? STALE_PENALTY : 0)) * 10) / 10;
    return { ...c, parts, score };
  });
  scored.sort((a, b) => b.score - a.score || a.km - b.km || a.id - b.id);
  return scored.slice(0, limit).map((c, i) => ({ ...c, rank: i + 1, strengths: strengths(c.parts) }));
}
/** Les deux critères où le candidat est le plus fort (pour expliquer le choix). */
function strengths(parts) { return Object.keys(parts).sort((a, b) => parts[b] - parts[a]).slice(0, 2); }

// ---------- CSV (clients / fournisseurs) : lecture tolérante (« ; » ou « , », guillemets, BOM) ----------
function parseCsv(text) {
  const s = String(text || '').replace(/^﻿/, '');
  const first = s.split(/\r?\n/, 1)[0] || '';
  const delim = (first.match(/;/g) || []).length >= (first.match(/,/g) || []).length ? ';' : ',';
  const rows = []; let row = []; let cell = ''; let q = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) { if (ch === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; continue; }
    if (ch === '"') q = true;
    else if (ch === delim) { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (ch !== '\r') cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}
/** Protège une cellule contre l'injection de formule dans un tableur. */
const csvCell = (v) => { let s = String(v == null ? '' : v); if (typeof v !== 'number' && /^[=+\-@\t\r]/.test(s)) s = "'" + s; return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const toCsv = (rows) => '﻿' + rows.map((r) => r.map(csvCell).join(';')).join('\r\n') + '\r\n';

module.exports = { MANUAL_STATES, SOURCES_CLIENT, WEIGHTS, STALE_PENALTY, DEFAULT_RELIABILITY, MIN_SAMPLE, ageMin, positionState, driverState, leg, capacityFit, estimateCost, reliability, recommend, strengths, parseCsv, toCsv, csvCell };
