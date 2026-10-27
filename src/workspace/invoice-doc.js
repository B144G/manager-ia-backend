'use strict';
// Facture imprimable : données de la page d'impression (frontend), pièce jointe HTML de l'e-mail et message de partage WhatsApp.
// Les sorties sont des « documents de travail » : l'organisation les fait valider avant tout usage légal ou fiscal (aucune dépendance de PDF :
// la page d'impression du navigateur produit le PDF).
const { db } = require('../db');

const METHODS = { cash: 'Espèces', transfer: 'Virement', mtn_momo: 'MTN Mobile Money', orange_money: 'Orange Money', cheque: 'Chèque' };
const KIND_LABEL = { quote: 'Devis', invoice: 'Facture', credit: 'Avoir', order: 'Commande' };

/** Montants d'un document : { ht, vat, total }. Anciens documents (taux vide) : le total est TTC, taux = celui de l'organisation. */
function amounts(d, org) {
  const rate = d.vat_rate === null || d.vat_rate === undefined ? Number(org.vat_rate) : Number(d.vat_rate);
  if (d.vat_amount !== null && d.vat_amount !== undefined && d.subtotal_ht !== null && d.subtotal_ht !== undefined) return { rate, ht: Number(d.subtotal_ht), vat: Number(d.vat_amount), total: Number(d.total) };
  const total = Number(d.total);
  const ht = rate > 0 ? Math.round(total / (1 + rate / 100)) : total;
  return { rate, ht, vat: total - ht, total };
}

/** Calcule HT / TVA / TTC à partir des lignes saisies. incl = les prix saisis sont TTC. */
function totals(lines, rate, incl) {
  const sum = lines.reduce((a, l) => a + Math.round(l.quantity * l.price), 0);
  if (incl) { const ht = rate > 0 ? Math.round(sum / (1 + rate / 100)) : sum; return { ht, vat: sum - ht, total: sum }; }
  const vat = Math.round((sum * rate) / 100);
  return { ht: sum, vat, total: sum + vat };
}

async function printData(req, d) {
  const org = req.org;
  const cu = await db.prepare('SELECT * FROM customers WHERE id = ?').get(d.customer_id);
  const a = amounts(d, org);
  const lines = JSON.parse(d.lines);
  const incl = Number(d.prices_incl) === 1;
  const pays = d.kind === 'invoice' ? await db.prepare('SELECT * FROM doc_payments WHERE doc_id = ? ORDER BY date, id').all(d.id) : [];
  const confirmed = pays.filter((p) => p.status === 'confirmed').reduce((x, p) => x + Number(p.amount), 0);
  const parent = d.credit_of ? await db.prepare('SELECT number FROM documents WHERE id = ?').get(d.credit_of) : null;
  const credited = Number(d.credited || 0);
  const missing = [];
  if (!org.niu) missing.push('org_niu');
  if (!org.address) missing.push('org_address');
  if (!cu.niu) missing.push('customer_niu');
  return {
    workingDocument: true,
    document: { id: d.id, kind: d.kind, number: d.number, status: d.status, issued: d.issued, due: d.due, note: d.note, creditOf: parent ? parent.number : null, creditReason: d.credit_reason || '' },
    org: { name: org.name, niu: org.niu, rccm: org.rccm, address: org.address, payInfo: org.pay_info, footer: org.invoice_footer, currency: org.currency },
    customer: { name: cu.name, niu: cu.niu, address: cu.address, phone: cu.phone, email: cu.email },
    lines: lines.map((l) => ({ label: l.label, quantity: l.quantity, price: l.price, amount: Math.round(l.quantity * l.price) })),
    pricesIncl: incl,
    totals: { ht: a.ht, vatRate: a.rate, vat: a.vat, total: a.total, paid: confirmed || Number(d.paid), credited, balance: d.kind === 'invoice' ? Math.max(a.total - credited - Number(d.paid), 0) : undefined },
    payments: pays.map((p) => ({ id: p.id, date: p.date, method: p.method, methodLabel: METHODS[p.method] || '', reference: p.reference, status: p.status, amount: Number(p.amount) })),
    missing,
  };
}

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => Number(n).toLocaleString('fr-FR').replace(/[  ]/g, ' ');
const dfr = (s) => (s ? s.split('-').reverse().join('/') : '');

/** Page HTML autonome (pièce jointe d'e-mail) : s'ouvre dans n'importe quel navigateur et s'imprime en PDF. */
function html(p) {
  const cur = esc(p.org.currency);
  const t = p.totals;
  const rows = p.lines.map((l) => `<tr><td>${esc(l.label)}</td><td class="r">${esc(l.quantity)}</td><td class="r">${fmt(l.price)}</td><td class="r">${fmt(l.amount)}</td></tr>`).join('');
  const title = `${KIND_LABEL[p.document.kind] || 'Document'} ${esc(p.document.number)}`;
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font:14px/1.45 Arial,Helvetica,sans-serif;color:#111;max-width:760px;margin:24px auto;padding:0 16px}h1{font-size:22px;margin:0 0 4px}table{width:100%;border-collapse:collapse;margin:16px 0}th,td{border-bottom:1px solid #ddd;padding:6px 4px;text-align:left}.r{text-align:right}.box{display:flex;gap:24px;flex-wrap:wrap;justify-content:space-between}.small{font-size:12px;color:#555}.tot td{border:0}.wd{margin-top:24px;padding:8px;border:1px dashed #999;font-size:12px;color:#555}@media print{.wd{border-color:#bbb}}</style></head><body>
<div class="box"><div><h1>${esc(p.org.name)}</h1><div class="small">${esc(p.org.address)}<br>${p.org.niu ? `NIU : ${esc(p.org.niu)}` : ''}${p.org.rccm ? ` · RCCM : ${esc(p.org.rccm)}` : ''}</div></div>
<div><h1>${title}</h1><div class="small">Date : ${esc(dfr(p.document.issued))}${p.document.due ? `<br>Échéance : ${esc(dfr(p.document.due))}` : ''}${p.document.creditOf ? `<br>Avoir sur la facture ${esc(p.document.creditOf)}` : ''}</div></div></div>
<p><b>${esc(p.customer.name)}</b><br><span class="small">${esc(p.customer.address)}${p.customer.niu ? `<br>NIU : ${esc(p.customer.niu)}` : ''}</span></p>
${p.document.creditReason ? `<p class="small">Motif : ${esc(p.document.creditReason)}</p>` : ''}
<table><thead><tr><th>Désignation</th><th class="r">Qté</th><th class="r">Prix unit. ${p.pricesIncl ? 'TTC' : 'HT'}</th><th class="r">Montant ${p.pricesIncl ? 'TTC' : 'HT'}</th></tr></thead><tbody>${rows}</tbody></table>
<table class="tot" style="width:320px;margin-left:auto"><tr><td>Total HT</td><td class="r">${fmt(t.ht)} ${cur}</td></tr><tr><td>TVA ${esc(String(t.vatRate).replace('.', ','))} %</td><td class="r">${fmt(t.vat)} ${cur}</td></tr><tr><td><b>Total TTC</b></td><td class="r"><b>${fmt(t.total)} ${cur}</b></td></tr>${t.paid ? `<tr><td>Déjà payé</td><td class="r">${fmt(t.paid)} ${cur}</td></tr>` : ''}${t.credited ? `<tr><td>Avoirs</td><td class="r">${fmt(t.credited)} ${cur}</td></tr>` : ''}${t.balance !== undefined ? `<tr><td><b>Reste à payer</b></td><td class="r"><b>${fmt(t.balance)} ${cur}</b></td></tr>` : ''}</table>
${t.vatRate === 0 ? '<p class="small">TVA non applicable ou opération exonérée (à vérifier avec votre conseil).</p>' : ''}
${p.org.payInfo ? `<p class="small"><b>Règlement :</b><br>${esc(p.org.payInfo).replace(/\n/g, '<br>')}</p>` : ''}
${p.org.footer ? `<p class="small">${esc(p.org.footer).replace(/\n/g, '<br>')}</p>` : ''}
<div class="wd">Document de travail généré par MANAGER-IA : à faire valider par votre expert-comptable avant tout usage légal ou fiscal.</div></body></html>`;
}

/** Texte court pour WhatsApp / e-mail. */
function shareText(p) {
  const t = p.totals; const cur = p.org.currency;
  const first = String(p.customer.name || '').split(' ')[0];
  return [`Bonjour ${first},`, `Voici votre ${(KIND_LABEL[p.document.kind] || 'document').toLowerCase()} ${p.document.number} de ${p.org.name} : ${fmt(t.total)} ${cur} TTC${t.vatRate ? ` (dont TVA ${String(t.vatRate).replace('.', ',')} % : ${fmt(t.vat)} ${cur})` : ''}.`,
    t.balance !== undefined && t.balance > 0 ? `Reste à payer : ${fmt(t.balance)} ${cur}${p.document.due ? `, avant le ${dfr(p.document.due)}` : ''}.` : '',
    p.org.payInfo ? `Règlement :\n${p.org.payInfo}` : '', t.balance > 0 ? 'Merci d\'indiquer la référence de la facture et de nous envoyer la référence de la transaction après paiement.' : '', p.org.name].filter(Boolean).join('\n');
}

module.exports = { METHODS, KIND_LABEL, amounts, totals, printData, html, shareText };
