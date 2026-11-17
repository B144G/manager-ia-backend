'use strict';
// Démonstration · groupe « finance » : outils communs (dates de l'historique, montants FCFA, appels au nom du comptable).
const pad = (n) => String(n).padStart(2, '0');

const CUST = {
  sogea: 'Sogea Satom Cameroun', bati: 'Bâti Plus SARL', quinc: 'Quincaillerie du Wouri', mairie: 'Commune de Douala 5e',
  ngono: 'Entreprise Ngono & Fils', immo: 'Immobilière des Collines', particulier: 'M. Jean-Paul Etoundi', hotel: 'Hôtel La Falaise',
};
const SUPP = { cimencam: 'Cimencam', dangote: 'Dangote Cement Cameroon', alucam: 'Alucam Tôlerie', electro: 'Électro Douala', 'carrière': 'Carrière de Nkometou', transit: 'Bolloré Transit (démo)' };

function make(ctx) {
  const T = ctx.day(0);
  const Y = Number(T.slice(0, 4));
  const lastDay = (ym) => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate(); };
  const addMonth = (ym, n) => { const [y, m] = ym.split('-').map(Number); const t = y * 12 + (m - 1) + n; return `${Math.floor(t / 12)}-${pad((t % 12) + 1)}`; };
  const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
  const dow = (d) => new Date(`${d}T00:00:00Z`).getUTCDay();
  const end = (ym) => `${ym}-${pad(lastDay(ym))}`;
  /** Jour ouvré du mois (samedi → vendredi, dimanche → lundi) ; null s'il tombe après aujourd'hui. */
  const on = (ym, day) => {
    let d = `${ym}-${pad(Math.min(day, lastDay(ym)))}`;
    if (dow(d) === 6) d = addDays(d, -1); else if (dow(d) === 0) d = addDays(d, d.slice(8) === pad(lastDay(ym)) ? -2 : 1);
    return d > T ? null : d;
  };
  /** Comme on(), mais ramené à aujourd'hui au lieu de null. */
  const upTo = (ym, day) => on(ym, day) || T;
  let seed = 20260611;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const r500 = (x) => Math.max(500, Math.round(x / 500) * 500);
  const vat = (ttc) => { const ht = Math.round(ttc / 1.1925); return { ht, tva: ttc - ht }; };
  const fmt = (n) => Number(n).toLocaleString('fr-FR');
  const acc = (feature, method, url, body, opts = {}) => ctx.do(feature, method, '/accounting' + url, body, { as: 'accountant', ...opts });
  const raw = async (feature, url, check, as = 'accountant') => {
    const r = await ctx.do(feature, 'GET', url, undefined, { as, raw: true });
    if (r.status === 200 && check) ctx.check(`${feature} : contenu`, check(r), (r.text || '').slice(0, 120));
    return r;
  };
  const csv = (feature, url, head, as) => raw(feature, url, (r) => /csv/.test(r.headers.get('content-type') || '') && (!head || r.text.includes(head)), as);
  const pdf = (feature, url, as) => raw(feature, url, (r) => r.buf.slice(0, 5).toString('latin1') === '%PDF-', as);
  const months = []; // mois de l'exercice en cours jusqu'au mois actuel
  for (let m = `${Y}-01`; m <= T.slice(0, 7); m = addMonth(m, 1)) months.push(m);
  const prevQ4 = [`${Y - 1}-10`, `${Y - 1}-11`, `${Y - 1}-12`];
  return { T, Y, M0: T.slice(0, 7), lastDay, addMonth, addDays, end, on, upTo, rnd, r500, vat, fmt, acc, raw, csv, pdf, months, prevQ4, CUST, SUPP };
}

module.exports = { make, CUST, SUPP, pad };
