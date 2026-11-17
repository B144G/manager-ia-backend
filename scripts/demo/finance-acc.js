'use strict';
// Démonstration · groupe « finance » : comptabilité SYSCOHADA de Batimat Afrique SARL sur 14 mois (dernier trimestre de l'an passé, puis
// l'exercice en cours) : ventes et encaissements, factures et règlements fournisseurs, charges, TVA, paie, emprunts, immobilisations,
// écritures récurrentes, analytique, rapprochement bancaire, lettrage, clôtures mensuelle et annuelle, contrôles et états.

const VT_PLAN = [['sogea', 11000000, 3], ['bati', 7500000, 8], ['immo', 9200000, 13], ['hotel', 3800000, 17], ['quinc', 5200000, 20], ['mairie', 6400000, 24], ['ngono', 4600000, 26]];
const SEASON = { '01': 0.9, '02': 1.0, '03': 1.15, '04': 1.1, '05': 1.05, '06': 0.95, '07': 0.75, '08': 0.7, '09': 0.8, '10': 1.0, '11': 1.1, '12': 1.2 };

async function setup(ctx, h) {
  const F = ctx.ids.finance; const { Y } = h;
  const home = await h.acc('Comptabilité : tableau de bord (plan comptable SYSCOHADA créé à la première ouverture)', 'GET', '');
  ctx.check('Comptabilité : plan comptable SYSCOHADA de base', home.journals && home.journals.VT, home.journals);
  await h.acc('Comptabilité : réglages (TVA 19,25 %, banque par défaut, TVA sur achats)', 'PUT', '/settings', { vatRate: 19.25, payAccount: '521', purchaseVat: true });
  // Les ventes, paiements et achats déjà saisis dans les autres modules entrent en comptabilité AVANT les déclarations de TVA mensuelles.
  await h.acc('Comptabilité : reprise des factures, paiements et achats déjà saisis', 'POST', '/generate');
  await ctx.do('Comptabilité : un responsable n\'accède pas à la comptabilité (refus attendu)', 'GET', '/accounting', undefined, { as: 'manager', expect: 403 });
  const accs = await h.acc('Plan comptable : liste des comptes', 'GET', '/accounts');
  ctx.check('Plan comptable : plus de 200 comptes SYSCOHADA', (accs.accounts || []).length > 200, (accs.accounts || []).length);
  await h.acc('Plan comptable : recherche « carburant »', 'GET', '/accounts?q=carbu');
  await h.acc('Plan comptable : créer le compte 6058 « Carburant et lubrifiants des camions »', 'POST', '/accounts', { code: '6058', label: 'Carburant et lubrifiants des camions' }, { expect: [201, 409] });
  await h.acc('Plan comptable : créer un compte qui existe déjà (refus attendu)', 'POST', '/accounts', { code: '601', label: 'Doublon' }, { expect: 409 });
  await h.acc('Plan comptable : numéro de compte invalide (refus attendu)', 'POST', '/accounts', { code: '9123', label: 'Hors plan' }, { expect: 400 });
  await h.acc('Comptabilité : modèles de saisie guidée', 'GET', '/templates');

  // ---------- Analytique ----------
  await h.acc('Analytique : créer une section par antenne et par projet existants', 'POST', '/analytics/sections/import');
  await h.acc('Analytique : relancer l\'import ne crée rien de plus', 'POST', '/analytics/sections/import');
  for (const [code, label, kind] of [['CHT-KOTTO', 'Chantier voirie de Kotto (Mairie Douala 5e)', 'project'], ['LIVRAISON', 'Activité livraison sur chantier', 'custom'], ['ESSAI', 'Section d\'essai', 'custom']]) {
    await h.acc(`Analytique : créer la section ${code}`, 'POST', '/analytics/sections', { code, label, kind }, { expect: [201, 409] });
  }
  await h.acc('Analytique : code de section déjà pris (refus attendu)', 'POST', '/analytics/sections', { code: 'cht-kotto', label: 'Doublon', kind: 'project' }, { expect: 409 });
  const secs = (await h.acc('Analytique : sections', 'GET', '/analytics/sections')).sections || [];
  const sec = (code) => secs.find((s) => s.code === code);
  F.sec = { douala: `ANT-${ctx.ids.branches.douala}`, yaounde: `ANT-${ctx.ids.branches.yaounde}`, kotto: 'CHT-KOTTO', liv: 'LIVRAISON' };
  if (sec('CHT-KOTTO')) await h.acc('Analytique : renommer une section', 'PUT', `/analytics/sections/${sec('CHT-KOTTO').id}`, { label: 'Chantier voirie de Kotto — lot 2 (Mairie Douala 5e)' });
  if (sec('ESSAI')) await h.acc('Analytique : supprimer une section jamais utilisée', 'DELETE', `/analytics/sections/${sec('ESSAI').id}`);
  F.secIds = { liv: sec('LIVRAISON') && sec('LIVRAISON').id, douala: sec(F.sec.douala) && sec(F.sec.douala).id };

  // ---------- Banques ----------
  const banks = (await h.acc('Banque : comptes suivis', 'GET', '/bank')).banks || [];
  const bank = async (name, glAccount, accountNo) => (banks.find((b) => b.name === name) || {}).id || (await h.acc(`Banque : ajouter le compte « ${name} »`, 'POST', '/bank', { name, glAccount, accountNo })).id;
  F.bank = { afriland: await bank('Afriland First Bank — compte courant', '521', '10005 00012 04587120000 45'), momo: await bank('MTN Mobile Money marchand', '589', '+237 677 00 11 22') };
  const tmp = await h.acc('Banque : ajouter un compte par erreur', 'POST', '/bank', { name: 'Compte ouvert par erreur', glAccount: '521' });
  if (tmp.id) await h.acc('Banque : supprimer le compte sans relevé', 'DELETE', `/bank/${tmp.id}`);

  // ---------- Écritures récurrentes ----------
  const R = (label, journal, frequency, day, start, lines, section) => h.acc(`Récurrentes : « ${label} »`, 'POST', '/recurring', { label, journal, frequency, dayOfMonth: day, startDate: start, lines, section });
  await R('Loyer du dépôt de Bonabéri', 'BQ', 'monthly', 5, `${Y - 1}-10-05`, [{ account: '622', debit: 450000, memo: 'SCI Wouri Logistique' }, { account: '521', credit: 450000 }], F.sec.douala);
  await R('Loyer du dépôt de Mvan (Yaoundé)', 'CA', 'monthly', 5, `${Y - 1}-10-05`, [{ account: '622', debit: 250000, memo: 'M. Onana (bailleur)' }, { account: '571', credit: 250000 }], F.sec.yaounde);
  await R('Assurance multirisque des dépôts (trimestre)', 'BQ', 'quarterly', 10, `${Y - 1}-10-10`, [{ account: '625', debit: 375000, memo: 'AXA Assurances Cameroun' }, { account: '521', credit: 375000 }]);
  const net = await R('Abonnement internet fibre Camtel', 'BQ', 'monthly', 12, `${Y - 1}-11-12`, [{ account: '628', debit: 65000 }, { account: '521', credit: 65000 }]);
  const press = await R('Abonnement presse (essai)', 'BQ', 'monthly', 1, `${Y}-01-01`, [{ account: '638', debit: 15000 }, { account: '521', credit: 15000 }]);
  await h.acc('Récurrentes : écriture déséquilibrée (refus attendu)', 'POST', '/recurring', { label: 'Erreur', journal: 'BQ', frequency: 'monthly', dayOfMonth: 1, startDate: `${Y}-01-01`, lines: [{ account: '622', debit: 100 }, { account: '521', credit: 90 }] }, { expect: 400 });
  F.recNet = net.id;
  if (press.id) await h.acc('Récurrentes : supprimer l\'abonnement presse', 'DELETE', `/recurring/${press.id}`);
  await h.acc('Récurrentes : liste et prochaines échéances', 'GET', '/recurring');
}

// ---------- Opérations unitaires ----------
const sale = async (ctx, h, ym, day, key, ttc) => {
  const F = ctx.ids.finance; const d = h.on(ym, day); if (!d) return null;
  F.nInv = (F.nInv || 0) + 1;
  const num = `FA-${d.slice(0, 4)}-${String(F.nInv).padStart(4, '0')}`;
  const { ht, tva } = h.vat(ttc);
  const section = key === 'mairie' ? F.sec.kotto : ['ngono', 'immo'].includes(key) ? F.sec.yaounde : F.sec.douala;
  const r = await h.acc(`Ventes : facture ${num} — ${h.CUST[key]} (${h.fmt(ttc)} FCFA TTC)`, 'POST', '/entries', { journal: 'VT', date: d, label: `Facture ${num} - ${h.CUST[key]}`, piece: num,
    lines: [{ account: '411', debit: ttc, memo: h.CUST[key] }, { account: '701', credit: ht, section, memo: 'Matériaux de construction' }, { account: '4431', credit: tva }] });
  const inv = { num, date: d, ym, key, ttc, id: r.id };
  F.invoices.push(inv);
  return inv;
};
const receive = async (ctx, h, inv, d, amount, via = 'BQ') => {
  if (!d) return;
  const F = ctx.ids.finance;
  const acct = { BQ: '521', MM: '589', CA: '571' }[via];
  const ref = via === 'BQ' ? `VIR ${h.CUST[inv.key].split(' ')[0].toUpperCase()} ${inv.num}` : via === 'MM' ? `MOMO-${inv.num.slice(-4)}${amount !== inv.ttc ? '-P' : ''}` : `REC-${inv.num.slice(-4)}`;
  await h.acc(`Encaissements : règlement ${amount === inv.ttc ? '' : 'partiel '}de ${inv.num} par ${h.CUST[inv.key]} (${via})`, 'POST', '/entries', { journal: via, date: d, label: `Règlement ${inv.num} - ${h.CUST[inv.key]}`, piece: ref,
    lines: [{ account: acct, debit: amount, memo: ref }, { account: '411', credit: amount, memo: h.CUST[inv.key] }] });
  if (via === 'CA') F.cash += amount; if (via === 'MM') F.momo += amount;
  inv.paid = (inv.paid || 0) + amount;
};
const bill = async (ctx, h, ym, day, sk, ttc, terms, label) => {
  const F = ctx.ids.finance; const d = h.on(ym, day); if (!d) return null;
  F.nBill = (F.nBill || 0) + 1;
  const number = `${sk.slice(0, 3).toUpperCase()}-${d.slice(2, 4)}${d.slice(5, 7)}-${String(F.nBill).padStart(3, '0')}`;
  const r = await h.acc(`Fournisseurs : facture ${number} de ${h.SUPP[sk]} (${h.fmt(ttc)} FCFA TTC)`, 'POST', '/payables', { supplierId: ctx.ids.suppliers[sk], number, billDate: d, termsDays: terms, amount: ttc, expenseAccount: '601', note: label });
  const b = { id: r.id, number, date: d, ym, sk, ttc, paid: 0 };
  F.bills.push(b);
  return b;
};
const payBill = async (ctx, h, b, d, amount) => {
  if (!d || !b || !b.id) return;
  await h.acc(`Fournisseurs : règlement ${amount < b.ttc - b.paid ? 'partiel ' : ''}${b.number} à ${h.SUPP[b.sk]}`, 'POST', `/payables/${b.id}/pay`, { amount, method: 'bank', date: d, reference: `VIR-${b.number}` });
  b.paid += amount;
};
const entry = (h, feature, body, opts) => h.acc(feature, 'POST', '/entries', body, opts);
const tpl = (h, feature, template, date, amount, extra = {}) => (date ? h.acc(feature, 'POST', '/entries/from-template', { template, date, amount, ...extra }) : null);

/** Liquidation de la TVA du mois (écriture datée du dernier jour) puis paiement le 15 du mois suivant. */
async function vatSettle(ctx, h, ym) {
  const F = ctx.ids.finance;
  if (F.vat[ym]) return;
  const v = await h.acc(`TVA ${ym} : calcul (collectée − déductible)`, 'GET', `/vat?from=${ym}-01&to=${h.end(ym)}`);
  if (!(v.collected > 0)) return;
  await tpl(h, `TVA ${ym} : liquidation (4431 / 4452 → 4441)`, 'vat_settlement', h.end(ym), v.collected, { options: { deductible: v.deductible }, piece: `TVA-${ym}`, label: `Liquidation de la TVA ${ym}` });
  F.vat[ym] = { collected: v.collected, deductible: v.deductible, due: v.due, paid: false };
}
async function vatPay(ctx, h, ym) {
  const F = ctx.ids.finance; const v = F.vat[ym];
  if (!v || v.paid || !(v.due > 0)) return;
  const d = h.on(h.addMonth(ym, 1), 14); if (!d) return;
  await tpl(h, `TVA ${ym} : paiement à la DGI (${h.fmt(v.due)} FCFA)`, 'vat_payment', d, v.due, { piece: `DGI-TVA-${ym}`, label: `Paiement TVA ${ym} (CIME Douala)` });
  v.paid = true;
}
/** Versement des cotisations CNPS et des retenues fiscales sur salaires du mois, le 15 du mois suivant. */
async function socialPay(ctx, h, ym) {
  const d = h.on(h.addMonth(ym, 1), 15); if (!d) return;
  const bal = await h.acc(`Paie ${ym} : soldes CNPS et impôts retenus à reverser`, 'GET', `/balance?from=${ym.slice(0, 4)}-01-01&to=${h.end(ym)}`);
  const row = (a) => (bal.rows || []).find((r) => r.account === a);
  const cnps = row('431') ? -row('431').balance : 0; const tax = row('447') ? -row('447').balance : 0;
  if (cnps > 0) await entry(h, `Paie ${ym} : versement des cotisations CNPS (${h.fmt(cnps)} FCFA)`, { journal: 'BQ', date: d, label: `Versement CNPS ${ym}`, piece: `CNPS-${ym}`, lines: [{ account: '431', debit: cnps, memo: 'CNPS Douala-Bonanjo' }, { account: '521', credit: cnps }] });
  if (tax > 0) await entry(h, `Paie ${ym} : reversement IRPP, CAC, CFC (${h.fmt(tax)} FCFA)`, { journal: 'BQ', date: d, label: `Reversement retenues sur salaires ${ym}`, piece: `DGI-ITS-${ym}`, lines: [{ account: '447', debit: tax, memo: 'DGI' }, { account: '521', credit: tax }] });
}

/** Un mois d'activité. opts : f (saisonnalité), salary ('template' : salaires saisis par modèle ; 'payroll' : bulletins de paie). */
async function month(ctx, h, ym, opts = {}) {
  const F = ctx.ids.finance; const f = (opts.f || 1) * (SEASON[ym.slice(5)] || 1);
  const prev = h.addMonth(ym, -1); const prev3 = h.addMonth(ym, -3);
  // Ventes à crédit (5 à 6 factures selon le mois)
  const k0 = Number(ym.slice(5)) % VT_PLAN.length;
  const plan = [0, 1, 2, 3, 4, 5].map((i) => VT_PLAN[(k0 + i) % VT_PLAN.length]).filter((x, i) => i < 5 || f > 1.05);
  for (const [key, base, day] of plan) await sale(ctx, h, ym, day, key, h.r500(base * f * (0.85 + 0.3 * h.rnd())));
  // Encaissements : les factures du mois précédent (la Mairie paie avec trois mois de retard ; Bâti Plus en deux fois ; le Wouri par MoMo)
  let n = 0;
  for (const inv of F.invoices.filter((x) => !x.paid && ((x.key !== 'mairie' && x.ym === prev) || (x.key === 'mairie' && x.ym === prev3)))) {
    const d = h.on(ym, 6 + 3 * n++);
    if (inv.key === 'bati') { const part = h.r500(inv.ttc * 0.6); await receive(ctx, h, inv, d, part); await receive(ctx, h, inv, h.on(ym, 27), inv.ttc - part); continue; }
    await receive(ctx, h, inv, d, inv.ttc, inv.key === 'quinc' ? 'MM' : 'BQ');
  }
  // Ventes au comptant (comptoir de Bonabéri) : espèces et mobile money
  const c1 = h.r500(1650000 * f * (0.8 + 0.4 * h.rnd())); const d1 = h.on(ym, 11);
  if (d1) { await tpl(h, `Ventes au comptoir ${ym} (espèces)`, 'sale_cash', d1, c1, { options: { mode: 'cash', kind: 'goods' }, piece: `TICKET-${ym}-A`, label: `Ventes comptoir Bonabéri ${ym} (espèces)`, section: F.sec.douala }); F.cash += c1; }
  const c2 = h.r500(780000 * f * (0.8 + 0.4 * h.rnd())); const d2 = h.on(ym, 22);
  if (d2) { await tpl(h, `Ventes au comptoir ${ym} (mobile money)`, 'sale_cash', d2, c2, { options: { mode: 'momo', kind: 'goods' }, piece: `TICKET-${ym}-B`, label: `Ventes comptoir ${ym} (MTN MoMo / Orange Money)`, section: F.sec.douala }); F.momo += c2; }
  if (ym.endsWith('-09') || ym.endsWith('-03')) { const d = h.on(ym, 16); if (d) { await tpl(h, `Ventes ${ym} : prestation de livraison facturée au comptant`, 'sale_cash', d, 350000, { options: { mode: 'cash', kind: 'services' }, piece: `LIV-${ym}`, label: 'Livraisons sur chantier facturées', section: F.sec.liv }); F.cash += 350000; } }
  // Achats : factures fournisseurs du mois et règlement de celles du mois précédent (Alucam d'il y a deux mois reste impayée : dette échue)
  await bill(ctx, h, ym, 4, 'cimencam', h.r500(12300000 * f * (0.9 + 0.2 * h.rnd())), 30, 'Ciment CPJ 42,5 (camions complets)');
  await bill(ctx, h, ym, 12, 'dangote', h.r500(6900000 * f * (0.9 + 0.2 * h.rnd())), 45, 'Ciment Dangote 42,5 R');
  await bill(ctx, h, ym, 18, Number(ym.slice(5)) % 2 ? 'alucam' : 'electro', h.r500((Number(ym.slice(5)) % 2 ? 4300000 : 2500000) * f), 30, Number(ym.slice(5)) % 2 ? 'Tôles bac alu 6/10' : 'Câbles et appareillage électrique');
  if (Number(ym.slice(5)) % 3 === 0) await bill(ctx, h, ym, 21, 'carrière', h.r500(1600000 * f), 0, 'Sable et gravier (bennes)');
  let p = 0;
  for (const b of F.bills.filter((x) => x.ym === prev && x.paid < x.ttc)) {
    if (ym === h.addMonth(h.M0, -1) && ['alucam', 'electro'].includes(b.sk)) continue; // dette échue non réglée (cas de démonstration)
    const d = h.on(ym, 9 + 4 * p++);
    await payBill(ctx, h, b, d, b.sk === 'dangote' && ym === h.addMonth(h.M0, -1) ? h.r500(b.ttc / 2) : b.ttc - b.paid);
  }
  for (const b of F.bills.filter((x) => x.ym === h.addMonth(ym, -2) && x.sk === 'carrière' && x.paid < x.ttc)) await payBill(ctx, h, b, h.on(ym, 10), b.ttc - b.paid);
  // Charges courantes
  const e = (label, journal, day, account, amount, contra, piece, memo, section) => { const d = h.on(ym, day); return d ? entry(h, `Charges ${ym} : ${label}`, { journal, date: d, label, piece, lines: [{ account, debit: amount, memo: memo || '', section: section || '' }, { account: contra, credit: amount }] }) : null; };
  await e(`Électricité ENEO ${ym}`, 'BQ', 18, '6052', h.r500(360000 * (0.9 + 0.2 * h.rnd())), '521', `ENEO-${ym}`, 'ENEO Cameroun', F.sec.douala);
  if (h.on(ym, 8)) { await e(`Eau CDE ${ym}`, 'CA', 8, '6051', 45000, '571', `CDE-${ym}`, 'Camwater / CDE'); F.cash -= 45000; }
  const fuel = h.r500(620000 * f); if (h.on(ym, 14)) { await e(`Gasoil des camions de livraison ${ym}`, 'CA', 14, '6058', fuel, '571', `CARB-${ym}`, 'Station Tradex Bonabéri', F.sec.liv); F.cash -= fuel; }
  if (h.on(ym, 9)) { await e(`Forfaits téléphoniques MTN et Orange ${ym}`, 'MM', 9, '628', 185000, '589', `MTN-${ym}`, 'MTN Cameroon'); F.momo -= 185000; }
  if (Number(ym.slice(5)) % 2 === 0 && h.on(ym, 23)) { await e(`Entretien des camions ${ym}`, 'CA', 23, '624', 280000, '571', `GAR-${ym}`, 'Garage Moderne de Bassa'); F.cash -= 280000; }
  if (Number(ym.slice(5)) % 3 === 0) await e(`Honoraires de l'expert-comptable (trimestre)`, 'BQ', 26, '632', 300000, '521', `HON-${ym}`, 'Cabinet Fotso & Associés');
  if (['03', '05', '11'].includes(ym.slice(5))) await e(`Spots radio Équinoxe et affichage Akwa ${ym}`, 'BQ', 7, '627', 420000, '521', `PUB-${ym}`, 'Radio Équinoxe');
  if (ym === `${h.Y}-02`) await e('Patente annuelle (contribution des patentes)', 'BQ', 25, '641', 1150000, '521', `PAT-${h.Y}`, 'Centre des impôts de Douala');
  await tpl(h, `Frais bancaires ${ym}`, 'bank_fees', h.on(ym, 28), 12500, { piece: `AFB-FRAIS-${ym}`, label: `Frais de tenue de compte et commissions ${ym}` });
  await tpl(h, `Frais mobile money ${ym}`, 'momo_fees', h.on(ym, 28), 4500, { piece: `MOMO-FRAIS-${ym}`, label: `Frais de transfert MoMo ${ym}` }); F.momo -= 4500;
  F.cash -= 250000; // loyer de Yaoundé (écriture récurrente)
  // Salaires avant la mise en place de la paie dans Brij-IA : saisie guidée
  if (opts.salary === 'template') await tpl(h, `Salaires ${ym} (saisie guidée, avant la paie Brij-IA)`, 'salary_bank', h.on(ym, 28), 2950000, { options: { charges: 545000 }, piece: `SAL-${ym}`, label: `Salaires nets ${ym} (virement groupé)` });
  // TVA et cotisations du mois précédent
  await vatSettle(ctx, h, prev); await vatPay(ctx, h, prev);
  await socialPay(ctx, h, prev);
  // Trésorerie : dépôt des espèces en banque, approvisionnement ou vidage du compte MoMo
  const dd = h.on(ym, 27);
  if (dd && F.cash > 1200000) { const amt = Math.floor((F.cash - 500000) / 100000) * 100000; await tpl(h, `Trésorerie ${ym} : dépôt des espèces à la banque`, 'cash_deposit', dd, amt, { piece: `BORD-${ym}`, label: `Versement espèces Afriland ${ym}` }); F.cash -= amt; }
  if (dd && F.cash < 300000) { await tpl(h, `Trésorerie ${ym} : retrait d'espèces pour la caisse`, 'cash_withdrawal', dd, 600000, { piece: `RET-${ym}`, label: `Retrait caisse ${ym}` }); F.cash += 600000; }
  const md = h.on(ym, 26);
  if (md && opts.salary === 'payroll') { await entry(h, `Trésorerie ${ym} : approvisionner MoMo pour la paie`, { journal: 'MM', date: md, label: `Approvisionnement MoMo paie ${ym}`, piece: `APP-MOMO-${ym}`, lines: [{ account: '589', debit: 1000000 }, { account: '521', credit: 1000000 }] }); F.momo += 1000000; }
  if (md && F.momo > 2500000) { const amt = Math.floor((F.momo - 800000) / 100000) * 100000; await entry(h, `Trésorerie ${ym} : virement MoMo vers la banque`, { journal: 'MM', date: md, label: `Virement MoMo vers Afriland ${ym}`, piece: `MOMO-BQ-${ym}`, lines: [{ account: '521', debit: amt }, { account: '589', credit: amt }] }); F.momo -= amt; }
}

// ---------- Exercice précédent : historique, clôtures ----------
async function prevYear(ctx, h, monthFn) {
  const F = ctx.ids.finance; const { Y } = h; const P = Y - 1;
  await tpl(h, `Capital : apport des associés (10 000 000 FCFA)`, 'capital_bank', `${P}-10-01`, 10000000, { piece: 'STATUTS-BATIMAT', label: 'Libération du capital social (Mme Kamga, M. Ebongué)' });
  await entry(h, 'Immobilisations : achat des ordinateurs du siège', { journal: 'BQ', date: `${P}-11-03`, label: 'Achat ordinateurs et imprimantes (Douala Informatique)', piece: `FA-INFO-${P}11`, lines: [{ account: '2183', debit: 2350000, memo: '3 postes + imprimante réseau' }, { account: '521', credit: 2350000 }] });
  await entry(h, 'Immobilisations : achat d\'un groupe électrogène de secours', { journal: 'BQ', date: `${P}-10-06`, label: 'Achat groupe électrogène 5 kVA (occasion)', piece: `FA-GE-${P}10`, lines: [{ account: '241', debit: 1200000 }, { account: '521', credit: 1200000 }] });
  F.assets = {};
  F.assets.it = (await h.acc('Immobilisations : enregistrer les ordinateurs (36 mois)', 'POST', '/assets', { label: 'Ordinateurs et imprimante réseau (siège)', category: 'it', acquiredOn: `${P}-11-03`, cost: 2350000, lifeMonths: 36 })).id;
  F.assets.ge = (await h.acc('Immobilisations : enregistrer le groupe électrogène (24 mois)', 'POST', '/assets', { label: 'Groupe électrogène de secours 5 kVA', category: 'equipment', acquiredOn: `${P}-10-06`, cost: 1200000, residual: 100000, lifeMonths: 24 })).id;
  await h.acc('Immobilisations : durée d\'amortissement manquante (refus attendu)', 'POST', '/assets', { label: 'Sans durée', category: 'it', cost: 500000 }, { expect: 400 });
  for (const ym of h.prevQ4) await monthFn(ym, { f: 0.6, salary: 'template' });
  await vatSettle(ctx, h, `${P}-12`);
  await h.acc(`Récurrentes : générer les loyers, assurances et abonnements jusqu'au 31/12/${P}`, 'POST', '/recurring/run', { upTo: `${P}-12-31` });
  // Clôture de l'exercice précédent : contrôles, amortissements, verrou fiscal puis clôture annuelle avec à-nouveaux
  const ye = await h.acc(`Clôture ${P} : contrôles avant clôture`, 'GET', `/year-end?year=${P}`);
  ctx.check(`Clôture ${P} : les amortissements manquants bloquent la clôture`, (ye.checks || []).some((c) => c.code === 'depreciation' && !c.ok), ye.checks);
  await h.acc(`Immobilisations : dotation de novembre ${P} seule`, 'POST', '/assets/depreciate', { month: `${P}-11` });
  await h.acc(`Immobilisations : dotations en retard jusqu'à décembre ${P}`, 'POST', '/assets/depreciate', { month: `${P}-12`, catchUp: true });
  await h.acc('Immobilisations : relancer la dotation ne double rien', 'POST', '/assets/depreciate', { month: `${P}-12`, catchUp: true }, { expect: 200 });
  const ls = await ctx.do(`Fiscalité : liasse de travail ${P} (bilan, compte de résultat, SIG, anomalies)`, 'GET', `/fiscal/liasse?year=${P}`, undefined, { as: 'accountant' });
  ctx.check(`Fiscalité : liasse ${P} équilibrée et sans anomalie bloquante`, ls.bilan && ls.bilan.equilibre && ls.toFix === 0, { equilibre: ls.bilan && ls.bilan.equilibre, toFix: ls.toFix, issues: ls.issues });
  await ctx.do('Fiscalité : exercices', 'GET', '/fiscal/exercises', undefined, { as: 'accountant' });
  await ctx.do(`Fiscalité : verrouiller l'exercice ${P}`, 'POST', `/fiscal/exercises/${P}/close`, undefined, { as: 'accountant' });
  await entry(h, `Fiscalité : écriture dans l'exercice ${P} verrouillé (refus attendu)`, { journal: 'OD', date: `${P}-12-20`, label: 'Essai après verrou', lines: [{ account: '658', debit: 1000 }, { account: '571', credit: 1000 }] }, { expect: 400 });
  await ctx.do(`Fiscalité : rouvrir l'exercice ${P} (motif obligatoire)`, 'POST', `/fiscal/exercises/${P}/reopen`, { reason: 'Passer la clôture annuelle complète (à-nouveaux) dans la Comptabilité' }, { as: 'accountant' });
  const c1 = await h.acc(`Clôture ${P} : clôture annuelle (détermination du résultat, à-nouveaux, verrou)`, 'POST', '/year-end/close', { year: P });
  ctx.check(`Clôture ${P} : écriture de résultat et à-nouveaux créés`, c1.closingEntry && (c1.openingEntries || []).length === 1, c1);
  await h.acc(`Clôture ${P} : la RAF ne peut pas rouvrir l'exercice (réservé au propriétaire, refus attendu)`, 'POST', '/year-end/reopen', { year: P, reason: 'Essai de réouverture' }, { expect: 403 });
  const later = ((await h.acc(`Clôture ${P} : écritures déjà passées sur ${Y}`, 'GET', `/entries?from=${Y}-01-01`)).entries || []).filter((x) => x.journal !== 'AN');
  if (!later.length) {
    await h.acc(`Clôture ${P} : la gérante rouvre l'exercice (facture de décembre oubliée)`, 'POST', '/year-end/reopen', { year: P, reason: 'Facture Électro Douala de décembre reçue en retard' }, { as: 'owner' });
    await bill(ctx, h, `${P}-12`, 30, 'electro', 640000, 30, 'Facture de décembre reçue en retard (projecteurs LED)');
    await h.acc(`Clôture ${P} : nouvelle clôture annuelle après correction`, 'POST', '/year-end/close', { year: P });
  } else {
    await h.acc(`Clôture ${P} : réouverture impossible quand ${Y} a déjà des écritures (refus attendu)`, 'POST', '/year-end/reopen', { year: P, reason: 'Facture de décembre reçue en retard' }, { as: 'owner', expect: 400 });
  }
  await h.acc(`Clôture ${P} : état de la clôture`, 'GET', `/year-end?year=${P}`);
  await ctx.do('Fiscalité : exercices après clôture', 'GET', '/fiscal/exercises', undefined, { as: 'accountant' });
}

// ---------- Exercice en cours : opérations de l'année (hors mois) ----------
async function yearStart(ctx, h) {
  const F = ctx.ids.finance; const { Y, T } = h;
  const at = (ym, day) => h.on(ym, day);
  if (F.recNet) await h.acc('Récurrentes : hausse de l\'abonnement internet (75 000 FCFA)', 'PUT', `/recurring/${F.recNet}`, { lines: [{ account: '628', debit: 75000, memo: 'Camtel fibre 50 Mb/s' }, { account: '521', credit: 75000 }] });
  const run = await h.acc('Récurrentes : générer les échéances de l\'année jusqu\'à aujourd\'hui', 'POST', '/recurring/run', { upTo: T });
  ctx.check('Récurrentes : loyers et abonnements générés', run.created > 0, run);
  await h.acc('Récurrentes : relancer ne crée aucun doublon', 'POST', '/recurring/run', {});
  // Emprunts
  const s1 = at(`${Y}-03`, 27) || T;
  const l1 = await h.acc('Emprunts : prêt d\'équipement Afriland First Bank (25 M FCFA, 36 mois, 11,5 %)', 'POST', '/loans', { label: 'Prêt d\'équipement camion', lender: 'Afriland First Bank Cameroun', principal: 25000000, ratePct: 11.5, months: 36, method: 'annuity', startDate: s1, firstDue: h.addDays(s1, 30), account: '521' });
  const s2 = at(`${Y}-06`, 2) || T;
  const l2 = await h.acc('Emprunts : crédit de trésorerie CCA Bank (6 M FCFA, 12 mois, capital constant)', 'POST', '/loans', { label: 'Crédit de campagne saison sèche', lender: 'CCA Bank', principal: 6000000, ratePct: '9,5', months: 12, method: 'constant_principal', startDate: s2, firstDue: h.addDays(s2, 29), account: '521' });
  await h.acc('Emprunts : durée invalide (refus attendu)', 'POST', '/loans', { label: 'Essai', principal: 1000000, months: 0 }, { expect: 400 });
  F.loans = [l1.id, l2.id].filter(Boolean);
  // Immobilisations de l'année
  const A = async (label, category, date, cost, life, residual, contraLabel, piece) => {
    if (!date) return null;
    await entry(h, `Immobilisations : achat — ${label}`, { journal: 'BQ', date, label: contraLabel, piece, lines: [{ account: { transport: '245', equipment: '241', office: '244', software: '213' }[category], debit: cost }, { account: '521', credit: cost }] });
    return (await h.acc(`Immobilisations : enregistrer « ${label} » (${life} mois)`, 'POST', '/assets', { label, category, acquiredOn: date, cost, lifeMonths: life, residual })).id;
  };
  F.assets.soft = await A('Licence logiciel de gestion de stock', 'software', at(`${Y}-01`, 20), 900000, 36, 0, 'Licence logiciel stock (3 postes)', `FA-LOG-${Y}01`);
  F.assets.truck = await A('Camion benne Mercedes Actros 6 m³', 'transport', at(`${Y}-04`, 15), 38500000, 60, 3500000, 'Achat camion benne (CFAO Motors)', `FA-CFAO-${Y}04`);
  F.assets.fork = await A('Chariot élévateur Toyota 2,5 t', 'equipment', at(`${Y}-05`, 20), 14200000, 84, 1200000, 'Achat chariot élévateur (Toyota Cameroun)', `FA-TOY-${Y}05`);
  F.assets.desk = await A('Mobilier de bureau — dépôt de Yaoundé', 'office', at(`${Y}-06`, 10), 1850000, 120, 0, 'Mobilier bureau Yaoundé (Ets Mballa)', `FA-MOB-${Y}06`);
  const dup = await h.acc('Immobilisations : climatiseur saisi en double', 'POST', '/assets', { label: 'Climatiseur (doublon)', category: 'office', acquiredOn: T, cost: 450000, lifeMonths: 60 });
  if (dup.id) await h.acc('Immobilisations : supprimer le doublon (aucune dotation)', 'DELETE', `/assets/${dup.id}`);
  // Cession du vieux groupe électrogène (fin août)
  const dsp = at(`${Y}-08`, 31);
  if (dsp && F.assets.ge) {
    await h.acc('Immobilisations : sortir le groupe électrogène du registre (vendu)', 'POST', `/assets/${F.assets.ge}/dispose`, { date: dsp });
    const pl = await h.acc('Immobilisations : plan d\'amortissement du bien cédé', 'GET', `/assets/${F.assets.ge}/plan`);
    const cum = (pl.plan || []).reduce((a, r) => a + r.amount, 0);
    await entry(h, 'Immobilisations : écriture de sortie (valeur nette comptable)', { journal: 'OD', date: dsp, label: 'Sortie du groupe électrogène 5 kVA', piece: `CESS-GE-${Y}`, lines: [{ account: '2841', debit: cum }, { account: '812', debit: 1200000 - cum }, { account: '241', credit: 1200000 }] });
    await entry(h, 'Immobilisations : produit de cession encaissé', { journal: 'CA', date: dsp, label: 'Vente groupe électrogène à la Quincaillerie du Wouri', piece: `CESS-GE-${Y}`, lines: [{ account: '571', debit: 650000 }, { account: '822', credit: 650000 }] });
    F.cash += 650000;
    await h.acc('Immobilisations : sortir deux fois le même bien (refus attendu)', 'POST', `/assets/${F.assets.ge}/dispose`, { date: dsp }, { expect: 400 });
  }
  // Modèles de saisie divers
  await tpl(h, 'Saisie guidée : achat de marchandises au comptant (quincaillerie)', 'purchase_goods', at(`${Y}-02`, 17), 238500, { options: { payment: 'cash' }, piece: `BA-${Y}02-17`, label: 'Visserie et outillage (Quincaillerie Akwa)' });
  await tpl(h, 'Saisie guidée : avance sur salaire de Samuel (espèces)', 'staff_advance_cash', at(h.addMonth(h.M0, -1), 5) || T, 50000, { piece: `AV-SAM-${h.M0}`, label: 'Avance sur salaire Samuel Fotso' });
  await tpl(h, 'Saisie guidée : loyer d\'un entrepôt de débord (MoMo)', 'rent_momo', at(`${Y}-03`, 6), 150000, { piece: `LOY-DEB-${Y}03`, label: 'Location ponctuelle entrepôt Ndokoti (mars)' });
  await h.acc('Saisie guidée : modèle inconnu (refus attendu)', 'POST', '/entries/from-template', { template: 'inconnu', date: T, amount: 1000 }, { expect: 400 });
}

// ---------- Après les mois : remboursements, amortissements, banque, lettrage, clôtures, contrôles, états ----------
async function yearEnd(ctx, h) {
  const F = ctx.ids.finance; const { Y, T, M0 } = h; const M1 = h.addMonth(M0, -1); const M2 = h.addMonth(M0, -2);
  // Remboursements d'emprunts (la dernière échéance du prêt Afriland est laissée en retard)
  for (const [i, id] of F.loans.entries()) {
    const ln = await h.acc('Emprunts : tableau d\'amortissement', 'GET', `/loans/${id}`);
    const due = (ln.lines || []).filter((g) => g.dueDate <= T);
    const toPay = i === 0 ? due.slice(0, -1) : due;
    for (const g of toPay) await h.acc(`Emprunts : échéance ${g.n}/${ln.months} « ${ln.label} » (capital ${h.fmt(g.principal)} + intérêts ${h.fmt(g.interest)})`, 'POST', `/loans/${id}/pay`, { date: g.dueDate, account: '521' });
  }
  const loans = await h.acc('Emprunts : encours et prochaines échéances', 'GET', '/loans');
  ctx.check('Emprunts : une échéance en retard signalée', (loans.loans || []).some((l) => l.next && l.next.late), (loans.loans || []).map((l) => l.next));
  // Amortissements jusqu'au mois dernier
  await h.acc(`Immobilisations : dotations aux amortissements jusqu'à ${M1}`, 'POST', '/assets/depreciate', { month: M1, catchUp: true });
  await h.acc('Immobilisations : registre (valeur brute, amortissements, valeur nette)', 'GET', '/assets');
  if (F.assets.truck) await h.acc('Immobilisations : plan d\'amortissement du camion', 'GET', `/assets/${F.assets.truck}/plan`);
  if (F.assets.it) await h.acc('Immobilisations : un bien amorti ne se supprime pas (refus attendu)', 'DELETE', `/assets/${F.assets.it}`, undefined, { expect: 400 });

  await entry(h, 'Écritures : déséquilibrée (refus attendu)', { journal: 'OD', date: T, label: 'Erreur', lines: [{ account: '658', debit: 1000 }, { account: '571', credit: 900 }] }, { expect: 400 });
  await entry(h, 'Écritures : sans justificatif (pièce manquante)', { journal: 'CA', date: h.on(M1, 21) || T, label: 'Achat de petit matériel (marché Congo)', lines: [{ account: '6056', debit: 42000 }, { account: '571', credit: 42000 }] });
  await entry(h, 'Écritures : pourboires manutention sans pièce', { journal: 'CA', date: h.on(M2, 13) || T, label: 'Manutention ponctuelle', lines: [{ account: '638', debit: 25000 }, { account: '571', credit: 25000 }] });
  if (F.secIds.liv) {
    await h.acc('Analytique : désactiver la section LIVRAISON (activité regroupée)', 'PUT', `/analytics/sections/${F.secIds.liv}`, { active: false });
    await entry(h, 'Analytique : écriture sur une section désactivée (refus attendu)', { journal: 'CA', date: T, label: 'Essai', piece: 'X', lines: [{ account: '6058', debit: 1000, section: 'LIVRAISON' }, { account: '571', credit: 1000 }] }, { expect: 400 });
    await h.acc('Analytique : supprimer une section utilisée (refus attendu)', 'DELETE', `/analytics/sections/${F.secIds.liv}`, undefined, { expect: 400 });
  }
  // Écritures automatiques depuis les factures, paiements et achats des autres modules (s'il y en a)
  await h.acc('Comptabilité : comptabiliser les factures, paiements et achats des autres modules', 'POST', '/generate');
  await h.acc('Fournisseurs : créer les dettes depuis les réceptions d\'achats du module Stock', 'POST', '/payables/from-purchases', { termsDays: 30 }, { expect: [200, 201] });
  const err = await h.acc('Fournisseurs : facture saisie en double', 'POST', '/payables', { supplierId: ctx.ids.suppliers.transit, number: 'BT-DOUBLON', billDate: h.on(M1, 3) || T, termsDays: 30, amount: 410000, expenseAccount: '611', note: 'Transit conteneur (doublon)' });
  if (err.id) await h.acc('Fournisseurs : annuler la facture en double (écriture contre-passée)', 'DELETE', `/payables/${err.id}`);
  await h.acc('Fournisseurs : facture de transit (frais sur achats)', 'POST', '/payables', { supplierName: 'Transitaire SDV Port de Douala', number: `SDV-${M1}`, billDate: h.on(M1, 3) || T, termsDays: 15, amount: 685000, expenseAccount: '611', note: 'Dédouanement groupes électrogènes' });
  const payables = await h.acc('Fournisseurs : dettes à payer (échues, à 7 jours)', 'GET', '/payables');
  ctx.check('Fournisseurs : une dette échue impayée (Alucam)', (payables.summary || {}).overdue >= 1, payables.summary);
  await h.acc('Fournisseurs : dettes partiellement réglées', 'GET', '/payables?status=partial');
  const paidB = F.bills.find((b) => b.paid >= b.ttc);
  if (paidB) await h.acc('Fournisseurs : annuler une facture réglée (refus attendu)', 'DELETE', `/payables/${paidB.id}`, undefined, { expect: 400 });

  // ---------- Rapprochement bancaire (relevé Afriland du mois dernier) ----------
  const BM = M1 >= `${Y}-01` ? M1 : M0;
  const led = await h.acc('Grand livre : banque 521 depuis l\'ouverture (pour préparer le rapprochement)', 'GET', `/ledger?account=521&from=${Y - 1}-01-01&to=${h.end(BM)}`);
  const lines = (led.lines || []).filter((l) => l.journal !== 'AN');
  const notCashed = lines.filter((l) => l.credit > 0 && l.date >= `${BM}-01`).slice(-1)[0]; // chèque émis non encore débité
  const fmtD = (d) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;
  const n = (x) => (x ? h.fmt(x).replace(/\u202f|\u00a0/g, ' ') : '');
  const rows = ['Date opération;Date valeur;Libellé;Référence;Débit;Crédit;Solde'];
  let run = 0;
  for (const l of lines) {
    if (l === notCashed) continue;
    run += l.debit - l.credit;
    rows.push([fmtD(l.date), fmtD(l.date), `"${l.label.replace(/"/g, '')}"`, l.number, n(l.credit), n(l.debit), n(run)].join(';'));
  }
  const ag = h.on(BM, 30) || h.on(BM, 28) || T; run -= 18750;
  rows.push([fmtD(ag), fmtD(ag), 'AGIOS ET INTERETS DEBITEURS', `AGI-${BM}`, n(18750), '', n(run)].join(';'));
  const csv = rows.join('\n');
  const dry = await h.acc('Banque : importer le relevé (essai : format détecté, aperçu)', 'POST', `/bank/${F.bank.afriland}/import`, { csv, dryRun: true });
  ctx.check('Banque : séparateur, en-tête et colonnes détectés', dry.detected && dry.detected.delimiter === ';' && dry.valid >= 5, dry.detected);
  await h.acc('Banque : importer le relevé Afriland', 'POST', `/bank/${F.bank.afriland}/import`, { csv });
  const again = await h.acc('Banque : réimporter le même relevé (doublons ignorés)', 'POST', `/bank/${F.bank.afriland}/import`, { csv });
  ctx.check('Banque : aucune ligne importée deux fois', again.imported === 0 && again.duplicates > 0, again);
  const sug = (await h.acc('Banque : suggestions de pointage (montant, date, référence)', 'GET', `/bank/${F.bank.afriland}/suggestions?window=5`)).suggestions || [];
  const used = new Set(); const uniq = [];
  for (const sg of sug) { const c = sg.candidates.find((x) => !used.has(x.accLineId)); if (c) { used.add(c.accLineId); uniq.push({ bankLineId: sg.bankLineId, accLineId: c.accLineId }); } }
  if (uniq[0]) await h.acc('Banque : pointer une ligne à la main', 'POST', `/bank/lines/${uniq[0].bankLineId}/match`, { accLineId: uniq[0].accLineId });
  let matched = 0; const failed = [];
  for (let i = 1; i < uniq.length; i += 200) { const mm = await h.acc('Banque : pointer toutes les suggestions retenues', 'POST', `/bank/${F.bank.afriland}/match-many`, { pairs: uniq.slice(i, i + 200) }); matched += mm.matched || 0; failed.push(...(mm.failed || [])); }
  ctx.check('Banque : lignes pointées automatiquement', matched === uniq.length - 1 && matched > 50, { matched, failed: failed.slice(0, 3) });
  if (uniq[1]) {
    await h.acc('Banque : dépointer une ligne (erreur de pointage)', 'POST', `/bank/lines/${uniq[1].bankLineId}/unmatch`);
    await h.acc('Banque : pointer à nouveau', 'POST', `/bank/lines/${uniq[1].bankLineId}/match`, { accLineId: uniq[1].accLineId });
  }
  const open = (await h.acc('Banque : lignes du relevé non pointées', 'GET', `/bank/${F.bank.afriland}/lines?status=unmatched`)).lines || [];
  const agi = open.find((l) => /AGIOS/.test(l.label));
  if (agi) await h.acc('Banque : comptabiliser les agios depuis le relevé (et pointer)', 'POST', `/bank/lines/${agi.id}/post`, { account: '671', label: `Agios et intérêts débiteurs ${BM}` });
  await h.acc('Banque : toutes les lignes du relevé', 'GET', `/bank/${F.bank.afriland}/lines`);
  const sum = await h.acc('Banque : état de rapprochement (écart expliqué)', 'GET', `/bank/${F.bank.afriland}/summary?asOf=${h.end(BM) > T ? T : h.end(BM)}`);
  ctx.check('Banque : écart de rapprochement nul (chèque non débité expliqué)', sum.gap === 0 && sum.unmatchedGlCount >= 1, { gap: sum.gap, statement: sum.statementBalance, gl: sum.glBalance, ub: sum.unmatchedBankTotal, ug: sum.unmatchedGlTotal, ubc: sum.unmatchedBankCount });
  // Relevé MoMo (sans colonne solde) : une ligne à ignorer, une ligne importée par erreur
  const mcsv = `date,description,transaction id,amount\n${h.on(BM, 9) || T},Paiement forfaits MTN,TX${BM.replace('-', '')}01,-185000\n${h.on(BM, 15) || T},Transfert interne test,TX${BM.replace('-', '')}02,-100\n${h.on(BM, 16) || T},Ligne importée par erreur,TX${BM.replace('-', '')}03,2500\n`;
  await h.acc('Mobile money : importer le relevé MTN MoMo (format différent)', 'POST', `/bank/${F.bank.momo}/import`, { csv: mcsv });
  const ml = (await h.acc('Mobile money : lignes du relevé', 'GET', `/bank/${F.bank.momo}/lines`)).lines || [];
  const t1 = ml.find((l) => /test/.test(l.label)); const t2 = ml.find((l) => /erreur/.test(l.label));
  if (t1) await h.acc('Mobile money : ignorer un transfert de test', 'POST', `/bank/lines/${t1.id}/ignore`);
  if (t2) await h.acc('Mobile money : supprimer la ligne importée par erreur', 'DELETE', `/bank/lines/${t2.id}`);
  await h.acc('Mobile money : suggestions de pointage', 'GET', `/bank/${F.bank.momo}/suggestions`);
  await h.acc('Mobile money : rapprochement sans colonne solde', 'GET', `/bank/${F.bank.momo}/summary`);
  await h.acc('Banque : un compte avec relevé ne se supprime pas (refus attendu)', 'DELETE', `/bank/${F.bank.momo}`, undefined, { expect: 400 });
  await h.acc('Banque : comptes suivis (lignes non pointées)', 'GET', '/bank');

  // Écriture erronée puis annulée par contre-passation
  const bad = await entry(h, 'Écritures : saisie erronée (mauvais compte)', { journal: 'BQ', date: h.on(M1, 19) || T, label: 'Achat cartouches imprimante', piece: `FA-BUR-${M1}`, lines: [{ account: '622', debit: 87500 }, { account: '521', credit: 87500 }] });
  if (bad.id) {
    await h.acc('Écritures : annuler l\'écriture erronée (contre-passation)', 'POST', `/entries/${bad.id}/reverse`, { date: h.on(M1, 19) || T });
    await h.acc('Écritures : annuler deux fois (refus attendu)', 'POST', `/entries/${bad.id}/reverse`, {}, { expect: 409 });
    await entry(h, 'Écritures : saisie corrigée (fournitures de bureau)', { journal: 'BQ', date: h.on(M1, 19) || T, label: 'Achat cartouches imprimante', piece: `FA-BUR-${M1}`, lines: [{ account: '6055', debit: 87500, memo: 'Bureau Vallée Akwa' }, { account: '521', credit: 87500 }] });
  }
  // ---------- Lettrage et balance âgée ----------
  const l411 = await h.acc('Lettrage clients : lignes ouvertes et propositions', 'GET', '/lettering?account=411');
  const auto = await h.acc('Lettrage clients : lettrage automatique (facture = règlement)', 'POST', '/lettering/auto', { account: '411' });
  ctx.check('Lettrage clients : factures rapprochées de leur règlement', auto.lettered >= 10, { lettered: auto.lettered, proposals: (l411.proposals || []).length });
  const openC = (await h.acc('Lettrage clients : lignes encore ouvertes', 'GET', '/lettering?account=411')).open || [];
  const bati = F.invoices.find((x) => x.key === 'bati' && x.paid >= x.ttc && x.date >= `${Y}-01-01`);
  if (bati) {
    const ids = openC.filter((l) => l.label.includes(bati.num)).map((l) => l.id);
    if (ids.length === 3) await h.acc(`Lettrage clients : lettrer à la main ${bati.num} et ses deux règlements partiels`, 'POST', '/lettering', { account: '411', lineIds: ids });
    else ctx.check('Lettrage clients : facture Bâti Plus et deux acomptes trouvés', false, ids);
  }
  await h.acc('Lettrage : lignes de tiers différents sans confirmation (refus attendu)', 'POST', '/lettering', { account: '411', lineIds: openC.filter((l) => l.debit > 0).slice(0, 2).map((l) => l.id) }, { expect: 400 });
  if (auto.codes && auto.codes[0]) await h.acc('Lettrage clients : défaire un lettrage', 'DELETE', `/lettering/411/${auto.codes[0]}`);
  await h.acc('Lettrage fournisseurs : lettrage automatique', 'POST', '/lettering/auto', { account: '401' });
  await h.acc('Lettrage fournisseurs : lignes ouvertes', 'GET', '/lettering?account=401');
  await h.acc('Balance âgée : clients (factures du module Ventes)', 'GET', '/aged?kind=customers');
  const agedS = await h.acc('Balance âgée : fournisseurs (par ancienneté)', 'GET', '/aged?kind=suppliers');
  ctx.check('Balance âgée fournisseurs : dettes réparties par ancienneté', (agedS.totals || {}).total > 0, agedS.totals);

  // ---------- Caisse ----------
  let theo = await h.acc('Caisse : solde théorique et comptages', 'GET', '/cash-counts');
  // Les autres modules (frais de tournée, carburant…) ont pu sortir de la caisse : on la réapprovisionne depuis la banque avant de compter.
  if ((theo.glBalance || 0) < 200000) {
    const need = Math.ceil((200000 - (theo.glBalance || 0)) / 1000) * 1000;
    await h.acc(`Caisse : approvisionnement depuis la banque (${need} FCFA)`, 'POST', '/entries', { journal: 'CA', date: T, label: 'Approvisionnement de la caisse (retrait Afriland)', piece: 'RET-CAISSE', lines: [{ account: '571', debit: need, memo: 'Retrait banque' }, { account: '521', credit: need, memo: 'Retrait pour la caisse' }] });
    theo = await h.acc('Caisse : solde théorique après approvisionnement', 'GET', '/cash-counts');
  }
  await h.acc('Caisse : comptage conforme (aucun écart)', 'POST', '/cash-counts', { date: T, counted: theo.glBalance || 0, note: 'Comptage de contrôle du matin', branchId: ctx.ids.branches.douala });
  await h.acc('Caisse : comptage du jour avec un manque de 12 500 FCFA (comptabilisé)', 'POST', '/cash-counts', { date: T, counted: Math.max((theo.glBalance || 0) - 12500, 0), post: true, note: 'Manque constaté par Brigitte Mbarga, rendu de monnaie' });
  await h.acc('Caisse : écart sans explication (refus attendu)', 'POST', '/cash-counts', { date: T, counted: (theo.glBalance || 0) + 5000, post: true, note: '' }, { expect: 400 });

  // ---------- Clôture mensuelle ----------
  await h.acc(`Clôture ${M1} : charge constatée d'avance (assurance payée d'avance)`, 'POST', '/closing/adjustments', { month: M1, kind: 'prepaid', amount: 250000, label: 'Assurance du trimestre payée d\'avance (part du mois suivant)', account: '625' });
  await h.acc(`Clôture ${M1} : charge à payer (facture ENEO non parvenue)`, 'POST', '/closing/adjustments', { month: M1, kind: 'accrued', amount: 390000, label: 'Électricité ENEO non facturée', account: '6052' });
  await h.acc(`Clôture ${M1} : provision pour litige client`, 'POST', '/closing/adjustments', { month: M1, kind: 'provision', amount: 1500000, label: 'Litige Hôtel La Falaise (carreaux défectueux)' });
  await h.acc('Clôture : compte de charge invalide (refus attendu)', 'POST', '/closing/adjustments', { month: M1, kind: 'prepaid', amount: 1000, label: 'Essai', account: '411' }, { expect: 400 });
  const cl = await h.acc(`Clôture ${M1} : liste de contrôle`, 'GET', `/closing?month=${M1}`);
  ctx.check(`Clôture ${M1} : contrôles automatiques et manuels`, (cl.items || []).length >= 8, cl.items);
  await h.acc(`Clôture ${M1} : clôturer avec des points ouverts (refus attendu)`, 'POST', '/closing/close', { month: M1 }, { expect: 400 });
  F.closed = [];
  for (const m of h.months.filter((x) => x < M1)) {
    for (const key of ['adjustments', 'vat', 'review']) await h.acc(`Clôture ${m} : cocher « ${key} »`, 'PUT', '/closing/check', { month: m, key, checked: true });
    const c = await h.acc(`Clôture ${m} : clôturer le mois`, 'POST', '/closing/close', { month: m, force: true, note: 'Points restants examinés par la RAF' });
    if (c.ok) F.closed.push(m);
  }
  if (F.closed.length) {
    const last = F.closed[F.closed.length - 1];
    await entry(h, `Clôture : écriture dans le mois clôturé ${last} (refus attendu)`, { journal: 'OD', date: `${last}-15`, label: 'Essai', piece: 'X', lines: [{ account: '658', debit: 1000 }, { account: '571', credit: 1000 }] }, { expect: 400 });
    await h.acc(`Clôture ${last} : cocher un contrôle d'un mois clôturé (refus attendu)`, 'PUT', '/closing/check', { month: last, key: 'vat', checked: false }, { expect: 409 });
    await h.acc(`Clôture ${last} : rouvrir le mois (avoir client à passer)`, 'POST', '/closing/reopen', { month: last, reason: 'Avoir Sogea à passer sur le mois' });
    await h.acc(`Clôture ${last} : rouvrir un mois ouvert (refus attendu)`, 'POST', '/closing/reopen', { month: last, reason: 'Encore une fois' }, { expect: 404 });
    F.closed.pop();
  }
  await h.acc('Clôture : mois à venir (refus attendu)', 'POST', '/closing/close', { month: h.addMonth(M0, 1), force: true, note: 'Essai' }, { expect: 400 });
  await h.acc(`Clôture ${M1} : état après régularisations`, 'GET', `/closing?month=${M1}`);
}

/** États, contrôles, exports et piste d'audit de l'exercice. */
async function reports(ctx, h) {
  const { Y, T, M0 } = h; const P = Y - 1;
  const home = await h.acc('Comptabilité : tableau de bord (ventes, achats, résultat, trésorerie)', 'GET', '');
  ctx.check('Comptabilité : chiffre d\'affaires et trésorerie de l\'exercice', home.kpi && home.kpi.ventes > 100000000 && home.kpi.tresorerie > 0, home.kpi);
  await h.acc('Journal : écritures du journal des ventes', 'GET', `/entries?journal=VT&from=${Y}-01-01`);
  await h.acc('Journal : recherche « ENEO »', 'GET', '/entries?q=ENEO');
  await h.acc('Grand livre : clients (411)', 'GET', `/ledger?account=411&year=${Y}`);
  await h.acc('Grand livre : caisse (571)', 'GET', `/ledger?account=571&year=${Y}`);
  await h.acc('Grand livre : compte inconnu (refus attendu)', 'GET', '/ledger?account=999', undefined, { expect: 404 });
  const bal = await h.acc(`Balance générale ${Y}`, 'GET', `/balance?year=${Y}`);
  ctx.check('Balance : total des débits = total des crédits', bal.totalDebit === bal.totalCredit && bal.totalDebit > 0, { d: bal.totalDebit, c: bal.totalCredit });
  const st = await h.acc(`États financiers ${Y} : bilan et compte de résultat`, 'GET', `/statements?year=${Y}`);
  ctx.check('Bilan : équilibré', st.bilan && st.bilan.equilibre, st.bilan && { actif: st.bilan.totalActif, passif: st.bilan.totalPassif });
  ctx.check('Compte de résultat : bénéficiaire', st.resultat && st.resultat.resultat > 0, st.resultat && st.resultat.resultat);
  await h.acc(`États financiers ${Y} comparés à ${P} (N-1)`, 'GET', `/statements?year=${Y}&compare=1`);
  await h.acc(`États financiers ${P}`, 'GET', `/statements?year=${P}`);
  // Inventaire de fin de période : le stock valorisé (coût moyen du module Stock) passe au bilan, la différence en variation de stock
  const sv = await h.acc('Stocks : valorisation à la date d\'inventaire (coût moyen pondéré)', 'GET', '/stock-valuation?nature=goods');
  ctx.check('Stocks : stock valorisé à partir du module Stock', sv.totalValue > 0 && (sv.items || []).length >= 10, sv && [sv.totalValue, (sv.items || []).length]);
  if (sv.gap) {
    await h.acc('Stocks : constater la variation de stock (311 / 6031)', 'POST', '/stock-valuation/post', { nature: 'goods' });
    const sv2 = await h.acc('Stocks : après constatation', 'GET', '/stock-valuation?nature=goods');
    ctx.check('Stocks : comptabilité à jour (aucun écart)', sv2.gap === 0 && sv2.history.length >= 1, sv2 && [sv2.gap, sv2.history.length]);
  }
  await h.acc('Stocks : matières premières (321)', 'GET', '/stock-valuation?nature=raw');
  const v = await h.acc(`TVA ${Y} : collectée, déductible, due`, 'GET', `/vat?year=${Y}`);
  void v;
  const vm = await ctx.do(`Fiscalité : TVA du mois ${h.addMonth(M0, -2)}`, 'GET', `/fiscal/vat?month=${h.addMonth(M0, -2)}`, undefined, { as: 'accountant' });
  const settled = ctx.ids.finance.vat[h.addMonth(M0, -2)];
  if (settled) ctx.check('TVA : le montant du mois reste juste après la liquidation', vm.collected === settled.collected && vm.deductible === settled.deductible, { report: { c: vm.collected, d: vm.deductible }, avantLiquidation: settled });
  const an = await h.acc(`Analytique : résultat par antenne et par chantier ${Y}`, 'GET', `/analytics/report?year=${Y}`);
  ctx.check('Analytique : produits ventilés par section', (an.sections || []).filter((s) => s.produits > 0).length >= 3, (an.sections || []).map((s) => [s.code, s.resultat]));
  await h.acc('Analytique : détail du chantier de Kotto', 'GET', `/analytics/report/CHT-KOTTO/lines?year=${Y}`);
  const ra = await h.acc(`Ratios ${Y} : marge, liquidité, délais clients et fournisseurs, seuil de rentabilité`, 'GET', `/ratios?year=${Y}`);
  ctx.check('Ratios : indicateurs calculés', (ra.items || []).filter((i) => i.status !== 'na').length >= 6, ra.summary);
  const au = await h.acc(`Contrôles ${Y} : audit automatique (note sur 100)`, 'GET', `/audit?year=${Y}`);
  ctx.check('Contrôles : note et anomalies listées', typeof au.score === 'number', { score: au.score, issues: (au.issues || []).map((i) => i.code) });
  await h.acc(`Synthèse ${Y} en clair`, 'GET', `/insights?year=${Y}`);
  await h.acc(`Synthèse ${Y} reformulée par l'IA (règles si l'IA n'est pas configurée)`, 'GET', `/insights?year=${Y}&ai=1`);
  await h.acc('Assistant IA : proposer une écriture (« payé le gardiennage 120 000 en espèces »)', 'POST', '/suggest', { text: 'payé le gardiennage du dépôt 120 000 en espèces' }, { expect: [200, 503, 502, 422] });
  const un = await h.acc('Piste d\'audit : écritures sans justificatif', 'GET', `/unsupported?year=${Y}`);
  ctx.check('Piste d\'audit : écritures sans pièce signalées', un.count >= 2, un.count);
  const tr = await h.acc('Piste d\'audit : qui a passé quoi, quand', 'GET', `/audit-trail?year=${Y}&limit=50`);
  ctx.check('Piste d\'audit : auteurs des écritures', (tr.byAuthor || []).length >= 1 && tr.count > 100, tr.byAuthor);
  await h.acc(`Clôture ${Y} : contrôles de l'exercice en cours`, 'GET', `/year-end?year=${Y}`);
  await h.acc(`Clôture ${Y} : exercice non terminé (refus attendu)`, 'POST', '/year-end/close', { year: Y + 1 }, { expect: 400 });
  await h.csv(`Export : journal ${Y} (CSV Excel)`, `/accounting/export.csv?year=${Y}`, 'journal;numero');
  await h.csv(`Export : balance ${Y} (CSV)`, `/accounting/export/balance.csv?year=${Y}`, 'compte');
  await h.csv(`Export : grand livre 401 (CSV)`, `/accounting/export/ledger.csv?year=${Y}&account=401`, 'solde');
  await h.csv(`Export : bilan et compte de résultat ${Y} (CSV)`, `/accounting/export/statements.csv?year=${Y}`, 'compte_de_resultat');
  await h.csv(`Export : journal centralisateur ${Y} (CSV)`, `/accounting/export/journal-centralisateur.csv?year=${Y}`, 'nb_ecritures');
  void T;
}

module.exports = { setup, month, prevYear, yearStart, yearEnd, reports, vatSettle, vatPay, socialPay };
