'use strict';
// Budget et Projets · calculs purs (aucun accès à la base) : prévisions de fin d'année, valeur acquise (EVM), courbe en S,
// date de fin prévue (« earned schedule »), chemin critique, charge par semaine. Tout est déterministe et testé avec des chiffres connus
// (scripts/test-budget-projets.js). Les montants sont des entiers (FCFA) : on arrondit à la sortie, jamais en cours de calcul.

const DAY = 86400000;
const dn = (d) => Math.round(Date.parse(`${d}T00:00:00Z`) / DAY); // numéro du jour (UTC)
const dd = (n) => new Date(n * DAY).toISOString().slice(0, 10);
const addDays = (d, n) => dd(dn(d) + n);
const sum = (a) => a.reduce((x, y) => x + (Number(y) || 0), 0);
const r0 = (n) => (n === null || n === undefined || !Number.isFinite(n) ? null : Math.round(n));
const r2 = (n) => (n === null || n === undefined || !Number.isFinite(n) ? null : Math.round(n * 100) / 100);
const r1 = (n) => (n === null || n === undefined || !Number.isFinite(n) ? null : Math.round(n * 10) / 10);
const Z80 = 1.2816; // quantile 90 % de la loi normale : intervalle de confiance à 80 % (10 % de chaque côté)

// =====================================================================================================================
// BUDGET : prévision de fin d'année d'une ligne (catégorie) ou d'un total
// =====================================================================================================================
/**
 * Moindres carrés ordinaires sur les points (x, y) : y = a + b·x.
 *   b = Σ(x - x̄)(y - ȳ) / Σ(x - x̄)²   ;   a = ȳ - b·x̄
 */
function linreg(xs, ys) {
  const n = xs.length;
  const mx = sum(xs) / n; const my = sum(ys) / n;
  let sxy = 0; let sxx = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; }
  const b = sxx ? sxy / sxx : 0;
  return { a: my - b * mx, b };
}

/**
 * Prévision « atterrissage » (montant attendu à la fin de l'année) d'une série mensuelle.
 * Entrées : actual[12] (réalisé), planned[12] (prévu), prev[12] ou null (réalisé de l'année précédente), closed (mois clos : 0 à 12,
 * le mois en cours n'est PAS clos), committed (engagé non encore réalisé, dépenses seulement), kind ('expense' | 'income').
 * Méthodes, pour chaque mois m non clos (m = closed+1 … 12, numérotés de 1 à 12) :
 *   - rythme (run-rate)      f(m) = moyenne des 3 derniers mois clos (ou moins s'il y en a moins)
 *   - tendance linéaire      f(m) = max(0, a + b·m), droite des moindres carrés sur les mois clos (3 mois clos au moins, sinon = rythme)
 *   - saisonnalité           f(m) = prev[m] × g, avec g = Σ réalisé des mois clos / Σ prev des mêmes mois (si l'an passé a des données
 *                            et que la série y commence au plus tard au même mois que cette année)
 *   - plan                   f(m) = planned[m]  (seule méthode possible sans mois clos)
 * Méthode retenue (« centrale ») : saisonnalité si possible, sinon tendance (≥ 3 mois clos), sinon rythme, sinon plan.
 * Atterrissage = Σ réalisé des mois clos + Σ_{m non clos} max(f(m), réalisé déjà constaté du mois m)   (le mois en cours ne descend pas
 * sous ce qui est déjà dépensé). Pour une dépense, l'atterrissage n'est jamais inférieur à « réalisé total + engagé ».
 * Fourchette à 80 % : ± 1,2816 × σ × √h, où σ est l'écart-type des résidus de la méthode retenue sur les mois clos
 * (σ = √(Σe² / (n - k)), k = 1 paramètre, 2 pour la tendance) et h le nombre de mois restant à prévoir. Sans assez de mois : σ = 0
 * et confiance « faible ».
 */
function forecastSeries({ actual, planned, prev, closed, committed = 0, kind = 'expense' }) {
  const A = Array.from({ length: 12 }, (_, i) => Number(actual[i]) || 0);
  const P = Array.from({ length: 12 }, (_, i) => Number((planned || [])[i]) || 0);
  const H = prev ? Array.from({ length: 12 }, (_, i) => Number(prev[i]) || 0) : null;
  const n = Math.max(0, Math.min(12, closed | 0));
  const hist = A.slice(0, n);
  const months = Array.from({ length: 12 - n }, (_, i) => n + i + 1); // numéros 1..12 des mois à prévoir
  const methods = {};
  const last = hist.slice(-3);
  const rr = last.length ? sum(last) / last.length : null;
  if (rr !== null) methods.runRate = { f: () => rr, resid: hist.map((y) => y - sum(hist) / n), k: 1 };
  if (n >= 3) {
    const { a, b } = linreg(hist.map((_, i) => i + 1), hist);
    methods.trend = { f: (m) => Math.max(0, a + b * m), resid: hist.map((y, i) => y - (a + b * (i + 1))), k: 2, slope: b };
  }
  // L'an passé ne sert de saisonnalité que s'il couvre la période : la série y a commencé au plus tard quand elle commence cette année
  // (une activité démarrée en octobre de l'an passé donnerait sinon un coefficient g démesuré et un atterrissage absurde).
  const firstH = H ? H.findIndex((v) => v > 0) : -1; const firstA = hist.findIndex((v) => v > 0);
  if (H && n >= 1 && sum(H.slice(0, n)) > 0 && sum(H) > 0 && (firstA < 0 || firstH <= firstA)) {
    const g = sum(hist) / sum(H.slice(0, n));
    methods.seasonal = { f: (m) => H[m - 1] * g, resid: hist.map((y, i) => y - H[i] * g), k: 1, growth: g };
  }
  if (sum(P) > 0 || !n) methods.plan = { f: (m) => P[m - 1], resid: [], k: 0 };
  const central = methods.seasonal ? 'seasonal' : methods.trend ? 'trend' : methods.runRate ? 'runRate' : 'plan';
  const closedSum = sum(hist);
  const land = (key) => {
    const M = methods[key];
    const fc = Array(12).fill(null);
    let total = closedSum;
    for (const m of months) { const v = Math.max(M.f(m), A[m - 1]); fc[m - 1] = v; total += v; }
    if (kind === 'expense') total = Math.max(total, sum(A) + committed);
    return { total, fc };
  };
  const out = {};
  for (const k of Object.keys(methods)) out[k] = r0(land(k).total);
  const c = land(central);
  const M = methods[central];
  const dof = M.resid.length - M.k;
  const sigma = dof >= 1 ? Math.sqrt(sum(M.resid.map((e) => e * e)) / dof) : 0;
  const h = months.length;
  const half = Z80 * sigma * Math.sqrt(h);
  const floor = kind === 'expense' ? sum(A) + committed : sum(A);
  const confidence = !h ? 'high' : central === 'plan' || dof < 2 ? 'low' : (n >= 6 && (!c.total || half / c.total < 0.15)) ? 'high' : 'medium';
  return {
    landing: r0(c.total), low: r0(Math.max(floor, c.total - half)), high: r0(c.total + half), halfWidth: half, sigma: r0(sigma),
    method: central, methods: out, confidence, forecast: c.fc.map(r0), remainingForecast: r0(c.total - closedSum),
    growth: methods.seasonal ? r2(methods.seasonal.growth) : null, slope: methods.trend ? r0(methods.trend.slope) : null,
  };
}

/**
 * Scénarios : la part encore à prévoir (atterrissage - réalisé des mois clos) est ajustée d'un pourcentage.
 *   dépense  : optimiste × (1 - o/100), pessimiste × (1 + p/100)
 *   recette  : optimiste × (1 + o/100), pessimiste × (1 - p/100)
 * Le réalisé et l'engagé ne bougent pas (on ne descend jamais sous réalisé total + engagé pour une dépense).
 */
function scenario(landing, closedActual, floor, kind, pct, side) {
  const rest = landing - closedActual;
  const sign = (kind === 'expense') === (side === 'optimistic') ? -1 : 1;
  const v = closedActual + rest * (1 + sign * pct / 100);
  return Math.round(kind === 'expense' ? Math.max(v, floor) : Math.max(v, 0));
}

// =====================================================================================================================
// PROJETS : valeur acquise (Earned Value Management)
// =====================================================================================================================
/** Part d'un intervalle de jours [start, end] (bornes comprises) écoulée à la fin du jour d : (d - start + 1) / (end - start + 1), bornée à [0, 1]. */
const elapsedShare = (start, end, d) => {
  const s = dn(start); const e = dn(end); const x = dn(d);
  if (x < s) return 0; if (x >= e) return 1;
  return (x - s + 1) / (e - s + 1);
};

/**
 * Valeur acquise d'un projet.
 * tasks : [{ id, status, estimate (heures), start, end (plan de référence ou plan actuel), doneAt, hours: [{ day, hours }] }]
 * costs : [{ date, amount }] (dépenses du projet : achats, stock, saisies)   rate : coût horaire   budget : budget du projet (0 = aucun)
 * window : { start, end } du projet   today : date du jour.
 *
 * Poids d'une tâche (sa part du budget) : son estimation en heures ; une tâche sans estimation reçoit la moyenne des estimations
 * des autres ; si aucune tâche n'est estimée, toutes pèsent 1. Budget à terminaison BAC = budget du projet, sinon Σ estimations × coût
 * horaire, sinon le calcul se fait « en effort » (heures ou tâches) et les indicateurs de coût ne sont pas calculés.
 * Tâche sans dates : elle s'étale sur toute la durée du projet.
 *   PV(d) (valeur planifiée)  = Σ bᵢ × part écoulée de la tâche i à la date d            (bᵢ = BAC × poidsᵢ / Σ poids)
 *   EV(d) (valeur acquise)    = Σ bᵢ × avancementᵢ(d)
 *       avancement = 1 si la tâche est terminée à la date d ; sinon, avec une estimation : min(heures saisies jusqu'à d / estimation, 0,9) ;
 *       sans estimation : 0,5 pour une tâche « en cours » (à la date du jour seulement), 0 sinon.
 *   AC(d) (coût réel)         = Σ dépenses datées ≤ d + coût horaire × Σ heures saisies ≤ d
 *   SV = EV - PV ; CV = EV - AC ; SPI = EV / PV ; CPI = EV / AC
 *   EAC (estimation à terminaison) = BAC / CPI   (si CPI inconnu : BAC)
 *       variantes : EAC « atypique » = AC + (BAC - EV) ; EAC « composite » = AC + (BAC - EV) / (CPI × SPI)
 *   ETC = EAC - AC ; VAC = BAC - EAC ; TCPI = (BAC - EV) / (BAC - AC) (efficacité nécessaire pour finir dans le budget)
 */
function evm({ tasks, costs = [], extraHours: extra = [], rate = 0, budget = 0, window, today }) {
  const est = tasks.map((t) => Math.max(0, Number(t.estimate) || 0));
  const estimated = est.filter((x) => x > 0);
  const mean = estimated.length ? sum(estimated) / estimated.length : 1;
  const w = est.map((x) => (estimated.length ? (x > 0 ? x : mean) : 1));
  const W = sum(w) || 1;
  const effortUnit = estimated.length ? 'hours' : 'tasks';
  let bac = Number(budget) > 0 ? Number(budget) : estimated.length && rate > 0 ? sum(est) * rate : null;
  const mode = bac ? 'money' : 'effort';
  const scale = bac || W; // en mode effort, la « valeur » s'exprime dans l'unité d'effort (heures ou tâches)
  const items = tasks.map((t, i) => {
    const start = t.start || window.start; const end = t.end || window.end;
    const hrs = (t.hours || []).map((h) => ({ d: dn(h.day), h: Number(h.hours) || 0 })).sort((a, b) => a.d - b.d);
    return { ...t, start: start <= end ? start : end, end, weight: w[i], b: scale * w[i] / W, est: est[i], hrs, doneN: t.status === 'done' ? dn(t.doneAt || (t.end && t.end < today ? t.end : today)) : null };
  });
  const progress = (it, d) => {
    const x = dn(d);
    if (it.doneN !== null && it.doneN <= x) return 1;
    if (it.est > 0) { let h = 0; for (const e of it.hrs) if (e.d <= x) h += e.h; return Math.min(h / it.est, 0.9); }
    return it.status === 'doing' && x >= dn(today) ? 0.5 : 0;
  };
  const pvAt = (d) => sum(items.map((it) => it.b * elapsedShare(it.start, it.end, d)));
  const evAt = (d) => sum(items.map((it) => it.b * progress(it, d)));
  const costList = costs.map((c) => ({ d: dn(c.date), a: Number(c.amount) || 0 }));
  const hourList = items.flatMap((it) => it.hrs);
  // heures saisies sans tâche, rattachées au projet seulement : comptées dans le coût réel, pas dans l'avancement
  const extraHours = extra.map((h) => ({ d: dn(h.day), h: Number(h.hours) || 0 }));
  const acAt = (d) => { const x = dn(d); return sum(costList.filter((c) => c.d <= x).map((c) => c.a)) + rate * sum(hourList.concat(extraHours).filter((h) => h.d <= x).map((h) => h.h)); };

  const PV = pvAt(today); const EV = evAt(today); const AC = mode === 'money' ? acAt(today) : null;
  const SPI = PV > 0 ? EV / PV : null;
  const CPI = mode === 'money' && AC > 0 ? EV / AC : null;
  const EAC = mode === 'money' ? (CPI ? bac / CPI : Math.max(bac, AC)) : null;
  const m = {
    mode, unit: mode === 'money' ? 'money' : effortUnit, bac: mode === 'money' ? r0(bac) : r2(W),
    pv: mode === 'money' ? r0(PV) : r2(PV), ev: mode === 'money' ? r0(EV) : r2(EV), ac: r0(AC),
    sv: mode === 'money' ? r0(EV - PV) : r2(EV - PV), cv: mode === 'money' ? r0(EV - AC) : null,
    spi: r2(SPI), cpi: r2(CPI), eac: r0(EAC), etc: mode === 'money' ? r0(EAC - AC) : null, vac: mode === 'money' ? r0(bac - EAC) : null,
    eacAtypical: mode === 'money' ? r0(AC + (bac - EV)) : null,
    eacComposite: mode === 'money' && CPI && SPI ? r0(AC + (bac - EV) / (CPI * SPI)) : null,
    tcpi: mode === 'money' ? (bac - AC > 0 ? r2((bac - EV) / (bac - AC)) : null) : null,
    budgetExhausted: mode === 'money' ? AC >= bac && EV < bac : false,
    percentComplete: r1(EV / scale * 100), percentPlanned: r1(PV / scale * 100), percentSpent: mode === 'money' ? r1(AC / bac * 100) : null,
  };
  return { metrics: m, items, pvAt, evAt, acAt, progress, scale };
}

/**
 * Date de fin prévue par la méthode du « planning acquis » (Earned Schedule, W. Lipke) :
 *   PVt(k) = PV à la fin du k-ième jour du projet (jour 1 = début), PVt(0) = 0 ; D = durée prévue en jours.
 *   ES = k + (EV - PVt(k)) / (PVt(k+1) - PVt(k)), où k est le dernier jour tel que PVt(k) ≤ EV   (planning « gagné », en jours)
 *   AT = jours écoulés depuis le début (aujourd'hui compris) ; SPI(t) = ES / AT
 *   durée prévue = D / SPI(t) ; fin prévue = début + ⌈D / SPI(t)⌉ - 1
 */
function earnedSchedule(e, window, today) {
  const D = dn(window.end) - dn(window.start) + 1;
  const AT = Math.min(Math.max(dn(today) - dn(window.start) + 1, 0), 100000);
  const EV = e.evAt(today);
  if (AT <= 0 || D <= 0) return { es: null, at: AT, spiT: null, duration: D, end: null };
  const pv = (k) => (k <= 0 ? 0 : e.pvAt(addDays(window.start, k - 1)));
  let k = 0;
  const top = Math.max(D, AT);
  while (k < top && pv(k + 1) <= EV + 1e-9) k++;
  const next = pv(k + 1); const cur = pv(k);
  let es = next > cur && k < top ? k + (EV - cur) / (next - cur) : k;
  // Palier : si la PV reste égale à l'EV sur plusieurs jours (rien de prévu ces jours-là, ou projet pas encore commencé), tout le palier
  // « vaut » l'EV ; on retient le jour du palier le plus proche d'aujourd'hui. Sinon un projet dans les temps paraîtrait en avance
  // (SPI(t) 25 pour un projet qui démarre dans 25 jours, fin prévue le lendemain).
  if (Math.abs(cur - EV) <= 1e-9) {
    let lo = k;
    while (lo > 0 && Math.abs(pv(lo - 1) - EV) <= 1e-9) lo--;
    es = Math.min(Math.max(AT, lo), k);
  }
  const spiT = es / AT;
  const dur = spiT > 0 ? Math.ceil(D / spiT - 1e-9) : null;
  return { es: r2(es), at: AT, spiT: r2(spiT), duration: D, forecastDuration: dur, end: dur ? addDays(window.start, dur - 1) : null };
}

/** Points de la courbe en S (PV, EV, AC) et du burn-down : environ 40 points du début à la fin (aujourd'hui compris). */
function curve(e, window, today, { horizon } = {}) {
  const from = window.start;
  const to = [window.end, today, horizon].filter(Boolean).reduce((a, b) => (a > b ? a : b));
  const span = dn(to) - dn(from) + 1;
  const step = Math.max(1, Math.ceil(span / 40));
  const dates = [];
  for (let k = 0; k < span; k += step) dates.push(addDays(from, k));
  if (dates[dates.length - 1] !== to) dates.push(to);
  if (!dates.includes(today) && today >= from && today <= to) { dates.push(today); dates.sort(); }
  const anyEst = e.items.some((x) => x.est > 0);
  const scope = anyEst ? sum(e.items.map((it) => it.est)) : e.items.length;
  const unitOf = (it) => (anyEst ? it.est : 1); // burn-down en heures estimées (ou en nombre de tâches si rien n'est estimé)
  return dates.map((d) => {
    const past = d <= today;
    const done = past ? sum(e.items.map((it) => unitOf(it) * (it.doneN !== null && it.doneN <= dn(d) ? 1 : 0))) : null;
    const earned = past ? sum(e.items.map((it) => unitOf(it) * e.progress(it, d))) : null;
    const pv = e.pvAt(d);
    return {
      date: d, pv: r0(pv), ev: past ? r0(e.evAt(d)) : null, ac: past && e.metrics.mode === 'money' ? r0(e.acAt(d)) : null,
      pvPct: r1(pv / e.scale * 100), evPct: past ? r1(e.evAt(d) / e.scale * 100) : null,
      idealRemaining: r1(scope * (1 - pv / e.scale)), remaining: past ? r1(scope - earned) : null, completed: done,
    };
  });
}

// =====================================================================================================================
// PROJETS : chemin critique (méthode du chemin critique, calendrier en jours entiers)
// =====================================================================================================================
/**
 * items : [{ id, start, end, dependsOn, status }] avec des dates déjà cohérentes (passe avant faite par le planning).
 * Fin du projet F = plus tardive des fins des tâches non terminées (toutes les tâches si elles sont toutes terminées).
 * Passe arrière : fin au plus tard LF(t) = min sur les successeurs s de (LS(s) - 1), ou F sans successeur ; début au plus tard
 * LS(t) = LF(t) - durée(t) + 1 ; marge totale = LF(t) - fin(t) (en jours). Une tâche non terminée à marge ≤ 0 est critique.
 */
function criticalPath(items) {
  const list = items.filter((i) => i.start && i.end);
  if (!list.length) return { projectEnd: null, tasks: [], path: [] };
  const open = list.filter((i) => i.status !== 'done');
  const F = (open.length ? open : list).map((i) => dn(i.end)).reduce((a, b) => Math.max(a, b));
  const succ = new Map();
  for (const i of list) if (i.dependsOn != null) { const k = String(i.dependsOn); if (!succ.has(k)) succ.set(k, []); succ.get(k).push(i); }
  const memo = new Map();
  const lf = (i, depth = 0) => {
    const id = String(i.id);
    if (memo.has(id)) return memo.get(id);
    let v = F;
    if (depth < 200) for (const s of succ.get(id) || []) v = Math.min(v, lf(s, depth + 1) - (dn(s.end) - dn(s.start) + 1)); // LS(s) - 1 = LF(s) - durée(s)
    memo.set(id, v);
    return v;
  };
  const tasks = list.map((i) => {
    const LF = lf(i); const dur = dn(i.end) - dn(i.start) + 1;
    const slack = LF - dn(i.end);
    return { id: i.id, start: i.start, end: i.end, duration: dur, lateStart: dd(LF - dur + 1), lateFinish: dd(LF), float: slack, critical: i.status !== 'done' && slack <= 0 };
  });
  return { projectEnd: dd(F), tasks, path: tasks.filter((x) => x.critical).sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0)).map((x) => x.id) };
}

// =====================================================================================================================
// PROJETS : charge prévue par personne et par semaine
// =====================================================================================================================
/** Lundi de la semaine d'une date (semaine ISO). */
const mondayOf = (d) => { const n = dn(d); const wd = (new Date(n * DAY).getUTCDay() + 6) % 7; return dd(n - wd); };
/**
 * Reste à faire d'une tâche = max(estimation - heures déjà saisies, 0), réparti également sur les jours de [max(début, aujourd'hui),
 * max(fin, aujourd'hui)] (une tâche en retard tombe entièrement sur aujourd'hui). Somme par personne et par semaine (lundi), comparée
 * à la capacité (heures par semaine) : charge % = heures / capacité × 100.
 */
function weeklyLoad(tasks, today, weeks, capacity) {
  const first = mondayOf(today);
  const cols = Array.from({ length: weeks }, (_, i) => addDays(first, i * 7));
  const end = dn(addDays(first, weeks * 7)) - 1;
  const rows = new Map();
  for (const t of tasks) {
    const rest = Math.max((Number(t.estimate) || 0) - (Number(t.logged) || 0), 0);
    if (!rest || t.status === 'done') continue;
    const s = Math.max(dn(t.start || t.end || today), dn(today)); const e = Math.max(dn(t.end || today), dn(today));
    const per = rest / (e - s + 1);
    const key = t.assigneeId == null ? 'none' : String(t.assigneeId);
    if (!rows.has(key)) rows.set(key, { userId: t.assigneeId == null ? null : Number(t.assigneeId), name: t.assignee || null, hours: Array(weeks).fill(0), beyond: 0, tasks: 0 });
    const r = rows.get(key); r.tasks++;
    for (let x = s; x <= e; x++) {
      if (x > end) { r.beyond += per; continue; }
      const w = Math.floor((x - dn(first)) / 7); r.hours[w] += per;
    }
  }
  const out = [...rows.values()].map((r) => ({ ...r, hours: r.hours.map(r1), beyond: r1(r.beyond), total: r1(sum(r.hours)), load: r.hours.map((h) => (capacity > 0 ? Math.round(h / capacity * 100) : null)), peak: capacity > 0 ? Math.round(Math.max(...r.hours) / capacity * 100) : null }));
  out.sort((a, b) => (a.userId === null) - (b.userId === null) || b.total - a.total);
  return { weeks: cols, capacity, rows: out };
}

// =====================================================================================================================
// PROJETS : santé (feu tricolore) et risques
// =====================================================================================================================
/** Note d'un risque : probabilité (1 à 5) × impact (1 à 5) ; élevé ≥ 15, moyen ≥ 8, faible sinon (matrice 5 × 5). */
const riskLevel = (score) => (score >= 15 ? 'high' : score >= 8 ? 'medium' : 'low');

/**
 * Feu tricolore d'un projet (raisons sous forme de codes, traduites par le site) :
 *   rouge  : SPI < 0,8 · CPI < 0,8 · coût réel > budget · fin prévue plus de 14 jours après l'échéance · échéance du projet dépassée
 *   orange : SPI < 0,95 · CPI < 0,95 · EAC > budget · fin prévue après l'échéance · tâches en retard · risque élevé ouvert
 *   vert   : aucun des cas ci-dessus ; gris : projet terminé ou sans tâche.
 */
function health({ status, tasks, spi, cpi, ac, bac, eac, lateDays, overdueTasks, highRisks, due, today, money }) {
  if (status === 'done' || !tasks) return { rag: 'grey', reasons: [] };
  const red = []; const amber = [];
  if (spi !== null && spi < 0.8) red.push('spi'); else if (spi !== null && spi < 0.95) amber.push('spi');
  if (money && cpi !== null && cpi < 0.8) red.push('cpi'); else if (money && cpi !== null && cpi < 0.95) amber.push('cpi');
  if (money && bac && ac > bac) red.push('overBudget'); else if (money && bac && eac > bac) amber.push('eac');
  if (lateDays > 14) red.push('late'); else if (lateDays > 0) amber.push('late');
  if (due && due < today) red.push('pastDue');
  if (overdueTasks > 0) amber.push('overdueTasks');
  if (highRisks > 0) amber.push('highRisks');
  return red.length ? { rag: 'red', reasons: red.concat(amber) } : amber.length ? { rag: 'amber', reasons: amber } : { rag: 'green', reasons: [] };
}

module.exports = { dn, dd, addDays, sum, r0, r1, r2, linreg, forecastSeries, scenario, elapsedShare, evm, earnedSchedule, curve, criticalPath, mondayOf, weeklyLoad, riskLevel, health, Z80 };
