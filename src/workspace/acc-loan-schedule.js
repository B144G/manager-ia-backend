'use strict';
// Calcul pur du tableau d'amortissement d'un emprunt (sans accès à la base : testable seul).

const addMonths = (iso, k) => { // même jour du mois, ramené au dernier jour si le mois est plus court
  const [y, m, d] = iso.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1 + k, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
};

/** Tableau d'amortissement. Montants entiers (FCFA) ; la dernière échéance absorbe l'arrondi pour solder exactement le capital. */
function buildSchedule({ principal, rateBp, months, method, firstDue }) {
  const r = rateBp / 10000 / 12;
  const fixed = method === 'annuity' ? (r === 0 ? principal / months : (principal * r) / (1 - Math.pow(1 + r, -months))) : 0;
  const rows = []; let balance = principal;
  for (let n = 1; n <= months; n++) {
    const interest = Math.round(balance * r);
    let cap = method === 'annuity' ? Math.round(fixed) - interest : Math.round(principal / months);
    if (n === months || cap > balance) cap = balance;
    if (cap < 0) cap = 0;
    balance -= cap;
    rows.push({ n, dueDate: addMonths(firstDue, n - 1), principal: cap, interest, balanceAfter: balance });
  }
  return rows;
}

module.exports = { addMonths, buildSchedule };
