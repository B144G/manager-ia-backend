'use strict';
// Administration MANAGER-IA : aucune dépendance externe. Tout texte inséré passe par textContent (jamais de HTML injecté) ;
// aucune balise <style> ni attribut style (CSP stricte) : les tailles dynamiques passent par le CSSOM.
(function () {
  const $ = (id) => document.getElementById(id);
  const NS = 'http://www.w3.org/2000/svg';
  const MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
  const JOURS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
  const MN = ['Janv.', 'Févr.', 'Mars', 'Avr.', 'Mai', 'Juin', 'Juil.', 'Août', 'Sept.', 'Oct.', 'Nov.', 'Déc.'];
  const STATUS_LABEL = { pending: 'En attente', awaiting_validation: 'À valider', paid: 'Payé', failed: 'Refusé / échoué' };
  const ICONS = {
    overview: 'M3 3h8v8H3zM13 3h8v5h-8zM13 10h8v11h-8zM3 13h8v8H3z', users: 'M16 11a4 4 0 10-8 0M4 21a8 8 0 0116 0M20 8a3 3 0 010 6',
    orgs: 'M12 3v5M5 14v-3h14v3M5 14v4M12 14v4M19 14v4M9 3h6v5H9zM2 18h6v3H2zM9 18h6v3H9zM16 18h6v3h-6z', payments: 'M3 7h18v12H3zM3 7l3-3h12l3 3M16 13h2',
    plans: 'M12 2l3 6 6 .9-4.5 4.3 1 6.3L12 16.6 6.5 19.5l1-6.3L3 8.9 9 8z', contacts: 'M3 5h18v14H3zM3 7l9 7 9-7', ai: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z',
    notifications: 'M6 8a6 6 0 1112 0c0 7 3 9 3 9H3s3-2 3-9M10 21a2 2 0 004 0', settings: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a7 7 0 000-6l2-1.5-2-3.4-2.4.9a7 7 0 00-1.7-1L14.9 1h-4l-.4 2.5a7 7 0 00-1.7 1l-2.4-.9-2 3.4 2 1.5a7 7 0 000 6l-2 1.5 2 3.4 2.4-.9a7 7 0 001.7 1l.4 2.5h4l.4-2.5a7 7 0 001.7-1l2.4.9 2-3.4z',
    shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z', down: 'M12 3v12M7 11l5 5 5-5M4 20h16', out: 'M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9', search: 'M11 4a7 7 0 100 14 7 7 0 000-14zM21 21l-5-5',
  };
  const NAV = [['overview', "Vue d'ensemble"], ['users', 'Utilisateurs'], ['orgs', 'Organisations'], ['payments', 'Paiements'], ['plans', 'Offres et abonnements'], ['contacts', 'Contacts reçus'], ['ai', "Utilisation de l'IA"], ['notifications', 'Notifications']];

  const S = { view: 'overview', days: 30, ov: null, payFilter: '', admin: 'Administrateur' };

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) el.setAttribute(k, v);
    }
    for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return el;
  }
  function sv(tag, attrs, kids) { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v); (kids || []).forEach((x) => e.appendChild(x)); return e; }
  const svText = (attrs, t) => { const e = sv('text', attrs); e.textContent = t; return e; };
  function icon(k) { return sv('svg', { viewBox: '0 0 24 24', class: 'ic', 'aria-hidden': 'true' }, [sv('path', { d: ICONS[k] })]); }

  async function api(path, opts) {
    const o = Object.assign({ credentials: 'same-origin', headers: {} }, opts || {});
    if (o.body && typeof o.body !== 'string') { o.body = JSON.stringify(o.body); o.headers['Content-Type'] = 'application/json'; }
    const res = await fetch('/api/admin' + path, o);
    let data = null;
    try { data = await res.json(); } catch (e) { /* vide */ }
    if (res.status === 401 && path !== '/login') { showLogin(); throw new Error('Session expirée'); }
    if (!res.ok) throw new Error((data && data.error) || 'Erreur ' + res.status);
    return data;
  }
  let toastTimer;
  function toast(msg) { const t = $('toast'); t.textContent = msg; t.classList.remove('hidden'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), 3500); }
  const fail = (e) => toast(e.message || 'Erreur');

  const fmtN = (n) => new Intl.NumberFormat('fr-FR').format(n || 0).replace(/[\u202f\u00a0]/g, ' ');
  const fmtXAF = (n) => fmtN(n) + ' FCFA';
  const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
  const fmtDateTime = (iso) => (iso ? new Date(iso).toLocaleString('fr-FR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
  function ago(iso) {
    if (!iso) return '';
    const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (m < 1) return "à l'instant"; if (m < 60) return 'il y a ' + m + ' min';
    const hh = Math.round(m / 60); if (hh < 24) return 'il y a ' + hh + ' h';
    const d = Math.round(hh / 24); if (d === 1) return 'hier'; if (d < 7) return 'il y a ' + d + ' j';
    return fmtDate(iso);
  }
  const plural = (n, a, b) => n + ' ' + (n > 1 ? b : a);
  const initials = (s) => String(s || '?').split(/[\s._-]+/).slice(0, 2).map((w) => w.charAt(0).toUpperCase()).join('');
  const digits = (s) => String(s || '').replace(/\D/g, '');
  const PLANS = ['Gratuit', 'Pro', 'Pro Max', 'Méga Pro', 'Illimité'];
  const planPill = (p) => h('span', { class: 'pill ' + (p === 'Pro' ? 'pro' : p === 'Pro Max' || p === 'Méga Pro' ? 'max' : p === 'Illimité' ? 'ok' : '') }, p);

  function delta(cur, prev, label) {
    if (!prev) return { text: label, cls: '' };
    const pct = Math.round((100 * (cur - prev)) / Math.abs(prev));
    return { text: (pct >= 0 ? '▲ ' : '▼ ') + Math.abs(pct) + ' % ' + label, cls: pct >= 0 ? 'up' : 'down' };
  }

  // ---------- Mise en page : identique à la maquette de 640 à 1400 px (réduite pour tenir) ----------
  function fit() {
    const w = window.innerWidth, z = w >= 640 && w < 1400 ? w / 1400 : 1;
    document.documentElement.style.setProperty('--z', String(z));
    $('app').style.zoom = z === 1 ? '' : String(z);
  }
  window.addEventListener('resize', fit);

  // ---------- Connexion ----------
  function showLogin() { $('app').classList.add('hidden'); $('login').classList.remove('hidden'); }
  function showApp() { $('login').classList.add('hidden'); $('app').classList.remove('hidden'); fit(); }
  $('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault(); $('loginError').textContent = '';
    const f = new FormData(e.target);
    try { await api('/login', { method: 'POST', body: { username: f.get('username'), password: f.get('password') } }); e.target.reset(); await start(); } catch (err) { $('loginError').textContent = err.message; }
  });
  async function logout() { try { await api('/logout', { method: 'POST' }); } catch (e) { /* ignore */ } showLogin(); }

  // ---------- Coque : menu, barre du haut ----------
  function go(view, extra) { S.view = view; if (extra) Object.assign(S, extra); render(); }

  function drawShell() {
    const todo = (S.ov && S.ov.todo) || { payments: 0, leads: 0 };
    const badges = { payments: todo.payments, contacts: todo.leads };
    const btn = (k, l) => h('button', { type: 'button', class: S.view === k ? 'on' : '', 'aria-current': S.view === k ? 'page' : null, onclick: () => go(k) }, icon(k), h('span', { class: 'nl' }, l), badges[k] ? h('span', { class: 'nb' }, String(badges[k])) : null);
    $('side').replaceChildren(
      h('div', { class: 'brand' }, h('a', { class: 'logo', href: '/admin' }, 'MANAGER', h('b', {}, '-IA')), h('span', { class: 'tag' }, 'ADMIN')),
      h('div', { class: 'org' }, icon('shield'), h('div', {}, h('b', {}, 'Administration'), h('small', {}, 'Plateforme MANAGER-IA'))),
      h('div', { class: 'lab' }, 'GESTION'),
      h('nav', { class: 'nav', 'aria-label': 'Administration' }, NAV.map(([k, l]) => btn(k, l)), h('hr'), btn('settings', 'Paramètres')),
      h('div', { class: 'me' }, h('span', { class: 'av gold' }, initials(S.admin)), h('div', { class: 't' }, h('b', {}, S.admin), h('small', {}, 'Administrateur')),
        h('button', { type: 'button', title: 'Me déconnecter', 'aria-label': 'Me déconnecter', onclick: logout }, icon('out'))));
    const q = h('input', { type: 'search', placeholder: 'Rechercher un utilisateur, une organisation, un paiement…', 'aria-label': 'Rechercher', autocomplete: 'off' });
    $('top').replaceChildren(
      h('form', { class: 'search', onsubmit: (e) => { e.preventDefault(); const v = q.value.trim(); if (v) go('users', { q: v }); } }, icon('search'), q),
      h('span', { class: 'grow' }),
      h('button', { type: 'button', class: 'bell', 'aria-label': 'À traiter', onclick: () => go('overview') }, icon('notifications'), (todo.payments + todo.leads) ? h('i') : null),
      h('div', { class: 'user' }, h('span', { class: 'av blue' }, initials(S.admin)), h('div', {}, h('b', {}, S.admin), h('small', {}, 'Administrateur'))));
  }

  const head = (title, sub, ...acts) => h('div', { class: 'head' }, h('div', {}, h('h1', {}, title), sub ? h('p', {}, sub) : null), h('div', { class: 'acts' }, acts));
  const card = (title, right, ...body) => h('section', { class: 'dc' }, h('div', { class: 'ch' }, h('h2', {}, title), right || null), body);

  // ---------- Vue d'ensemble (identique à la maquette) ----------
  function overview(main) {
    const ov = S.ov, now = new Date(), k = ov.kpi;
    const exportBtn = h('a', { class: 'bt solid', href: '/api/admin/export/users.csv' }, icon('down'), 'Exporter');
    const period = h('select', { class: 'sel', 'aria-label': 'Période', onchange: (e) => { S.days = Number(e.target.value); load(); } }, [7, 30, 90].map((d) => h('option', { value: d, selected: d === S.days ? '' : null }, d + ' derniers jours')));
    main.append(head("Vue d'ensemble de la plateforme", JOURS[now.getDay()].replace(/^./, (c) => c.toUpperCase()) + ' ' + now.getDate() + ' ' + MOIS[now.getMonth()] + ' ' + now.getFullYear() + ' · données des ' + ov.days + ' derniers jours.', period, exportBtn));

    // À traiter + santé du système
    const prio = h('ul', { class: 'prio' });
    if (ov.todo.payments) prio.append(h('li', { class: 'red' }, plural(ov.todo.payments, 'paiement Mobile Money attend', 'paiements Mobile Money attendent') + ' votre validation'));
    if (ov.todo.leads) prio.append(h('li', {}, plural(ov.todo.leads, "demande de contact n'a pas encore de réponse", "demandes de contact n'ont pas encore de réponse")));
    if (ov.todo.expiring) prio.append(h('li', {}, plural(ov.todo.expiring, 'abonnement arrive à échéance', 'abonnements arrivent à échéance') + ' cette semaine'));
    if (!prio.children.length) prio.append(h('li', { class: 'ok' }, 'Rien à traiter : tout est à jour.'));
    const brief = h('section', { class: 'brief' },
      h('div', { class: 'bh' }, icon('ai'), h('b', {}, "À traiter aujourd'hui"), h('small', {}, "Mis à jour à l'instant")), prio,
      h('div', { class: 'row' }, h('button', { class: 'bt', type: 'button', onclick: () => go('payments', { payFilter: 'awaiting_validation' }) }, 'Valider les paiements'), h('button', { class: 'bt ghost', type: 'button', onclick: () => go('contacts') }, 'Voir les demandes')));
    const warn = ov.system.filter((x) => x.status !== 'ok').length;
    const sys = card('Santé du système', h('small', {}, warn ? warn + ' à configurer' : 'Tout est opérationnel'), h('div', { class: 'sys' }, ov.system.map((x) => h('div', {}, h('i', { class: x.status === 'ok' ? '' : 'warn' }), h('b', {}, x.label), h('span', {}, x.text)))));
    main.append(h('div', { class: 'g2' }, brief, sys));

    // Indicateurs
    const pm = MOIS[Number(ov.series[4].month.slice(5)) - 1];
    const kpi = (cls, t, v, sub) => h('div', { class: 'kpi ' + cls }, h('small', {}, t), h('b', {}, v), h('span', { class: 'sub ' + (sub.cls || '') }, sub.text));
    main.append(h('div', { class: 'g5' },
      kpi('blue', 'Utilisateurs', fmtN(k.users), { text: '▲ ' + fmtN(k.newUsers) + ' sur ' + ov.days + ' jours', cls: k.newUsers ? 'up' : '' }),
      kpi('green', 'Organisations actives', fmtN(k.activeOrgs), { text: fmtN(k.orgs) + ' au total', cls: '' }),
      kpi('amber', 'Revenus du mois', fmtXAF(ov.revenueMonth), delta(ov.revenueMonth, ov.revenuePrev, 'vs ' + pm)),
      kpi('red', 'Abonnés payants', fmtN(k.payers), { text: Object.entries(k.payersByPlan).filter(([, n]) => n).map(([n, c]) => c + ' ' + n).join(' · ') || 'aucun pour l’instant', cls: '' }),
      kpi('blue', "Messages IA aujourd'hui", fmtN(k.aiToday), delta(k.aiToday, k.aiYesterday, 'vs hier'))));

    // Graphique + répartition des offres
    const maxRev = Math.max(1, ...ov.series.map((s) => s.revenue)), unit = maxRev >= 1000000 ? 1000000 : 1000, maxSig = Math.max(1, ...ov.series.map((s) => s.signups));
    const niceStep = (v) => { const p = Math.pow(10, Math.floor(Math.log10(v))); const f = v / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p; };
    const step = niceStep(maxRev / unit / 4), top = Math.max(step, Math.ceil(maxRev / unit / step) * step);
    const W = 640, H = 250, base = 210, sc = 170 / (top * unit), kids = [];
    for (let g = 0; g <= top + 1e-9; g += step) { const y = base - g * unit * sc; kids.push(sv('line', { x1: 40, y1: y, x2: W, y2: y, class: 'grid' }), svText({ x: 32, y: y + 4, 'text-anchor': 'end', class: 'ax' }, String(Math.round(g * 100) / 100))); }
    const pts = [];
    ov.series.forEach((s, i) => {
      const x = 70 + i * 92;
      kids.push(sv('rect', { x, y: base - s.revenue * sc, width: 44, height: Math.max(s.revenue * sc, 0), rx: 6, class: 'bar' }), svText({ x: x + 22, y: base + 22, 'text-anchor': 'middle', class: 'ax' }, MN[Number(s.month.slice(5)) - 1]));
      pts.push([x + 22, base - (s.signups / maxSig) * 160]);
    });
    kids.push(sv('polyline', { points: pts.map((p) => p.join(',')).join(' '), class: 'ln' }), ...pts.map((p) => sv('circle', { cx: p[0], cy: p[1], r: 5, class: 'pt' })));
    const chart = card('Inscriptions et revenus', h('small', {}, '6 derniers mois'),
      h('div', { class: 'legend' }, h('i'), 'Revenus (' + (unit === 1000000 ? 'millions' : 'milliers') + ' de FCFA)', h('i', { class: 'l' }), 'Nouveaux inscrits'),
      sv('svg', { viewBox: '0 0 ' + W + ' ' + H, class: 'chart', role: 'img', 'aria-label': 'Revenus et inscriptions des six derniers mois' }, kids));

    const P = ov.plans, PN = ['Pro', 'Pro Max', 'Méga Pro', 'Illimité'], tot = Math.max(1, P.Gratuit + PN.reduce((a, n) => a + (P[n] || 0), 0)), R = 66, C = 2 * Math.PI * R;
    let off = 0;
    const segs = [['Gratuit', P.Gratuit, '#a9c1ff'], ['Pro', P.Pro, '#1d4ed8'], ['Pro Max', P['Pro Max'], '#f5b730'], ['Méga Pro', P['Méga Pro'] || 0, '#e8466f'], ['Illimité', P['Illimité'] || 0, '#13a37f']];
    const ring = [sv('circle', { cx: 85, cy: 85, r: R, fill: 'none', stroke: '#e1e8f3', 'stroke-width': 24 })];
    segs.forEach(([, v, c]) => { const l = (C * v) / tot; if (v) ring.push(sv('circle', { cx: 85, cy: 85, r: R, fill: 'none', stroke: c, 'stroke-width': 24, 'stroke-dasharray': l.toFixed(1) + ' ' + (C - l).toFixed(1), 'stroke-dashoffset': (-off).toFixed(1), transform: 'rotate(-90 85 85)' })); off += l; });
    const payPct = (((tot - P.Gratuit) / tot) * 100).toFixed(1).replace('.', ',');
    const subs = [Math.round((P.Gratuit / tot) * 100) + ' % des comptes', ...PN.map((n) => fmtN(P.prices[n]) + ' FCFA / mois')];
    const donut = card('Répartition des offres', h('small', {}, fmtN(tot) + ' comptes'), h('div', { class: 'donut' },
      h('div', { class: 'dn-c' }, sv('svg', { viewBox: '0 0 170 170', 'aria-hidden': 'true' }, ring), h('div', { class: 'mid' }, h('b', {}, payPct + ' %'), h('small', {}, 'payants'))),
      h('div', { class: 'dl' }, segs.map(([n, v, c], i) => { const d = h('div', {}, h('i'), h('b', {}, n), h('em', {}, fmtN(v)), h('small', {}, subs[i])); d.firstChild.style.background = c; return d; }))));
    main.append(h('div', { class: 'g3' }, chart, donut));

    // Paiements à valider + demandes de contact
    const payRows = ov.payments.map((p) => h('tr', {}, h('td', { class: 'ref' }, p.reference), h('td', {}, p.user), h('td', {}, p.planName), h('td', { class: 'mu' }, p.operator || '—'), h('td', { class: 'num' }, fmtXAF(p.amountXAF)),
      h('td', { class: 'r' }, h('button', { class: 'bt solid sm', type: 'button', onclick: () => payAction(p.id, 'validate') }, 'Valider'), ' ', h('button', { class: 'bt out sm', type: 'button', onclick: () => payAction(p.id, 'reject') }, 'Refuser'))));
    const pays = card('Paiements à valider', h('small', {}, ov.todo.payments + ' en attente'),
      payRows.length ? h('div', { class: 'wrap' }, h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, ['Référence', 'Utilisateur', 'Offre', 'Opérateur', 'Montant', ''].map((t) => h('th', {}, t)))), h('tbody', {}, payRows))) : h('p', { class: 'empty' }, 'Aucun paiement en attente.'));
    const leads = card('Demandes de contact', h('button', { class: 'link', type: 'button', onclick: () => go('contacts') }, 'Voir tout'),
      ov.leads.length ? h('div', { class: 'mini' }, ov.leads.map((l, i) => h('div', { class: 'it ' + (i === 0 ? 'red' : i === 1 ? 'amber' : '') }, h('b', {}, l.name), h('span', {}, l.text.slice(0, 70)), h('em', {}, ago(l.created))))) : h('p', { class: 'empty' }, 'Aucune demande en attente.'));
    main.append(h('div', { class: 'g3' }, pays, leads));

    // Derniers inscrits + activité récente
    const users = card('Derniers inscrits', h('button', { class: 'link', type: 'button', onclick: () => go('users') }, 'Voir tous les utilisateurs'),
      h('div', { class: 'wrap' }, h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, ['Nom', 'Contact', 'Offre', 'Inscrit'].map((t) => h('th', {}, t)))),
        h('tbody', {}, ov.latestUsers.map((u) => h('tr', {}, h('td', {}, h('b', {}, u.name)), h('td', { class: 'mu' }, u.contact), h('td', {}, planPill(u.plan)), h('td', { class: 'mu' }, ago(u.created))))))));
    const TONE = { paiement_confirme: 'g', paiement_a_valider: 'a', inscription: '', contact: 'a', conseiller: 'r' };
    const act = card('Activité récente', null, ov.activity.length ? h('div', { class: 'act' }, ov.activity.map((a) => h('div', {}, h('i', { class: TONE[a.type] || '' }), a.text.slice(0, 80), h('span', {}, ago(a.created))))) : h('p', { class: 'empty' }, 'Rien pour l’instant.'));
    main.append(h('div', { class: 'g3' }, users, act));
  }

  async function payAction(id, what) {
    try { await api('/payments/' + id + '/' + what, { method: 'POST' }); toast(what === 'validate' ? 'Paiement validé : l’offre est activée.' : 'Paiement refusé.'); await load(); } catch (e) { fail(e); }
  }

  // ---------- Autres vues ----------
  async function usersView(main) {
    const q = h('input', { type: 'search', value: S.q || '', placeholder: 'Rechercher un nom, un e-mail, un numéro…', 'aria-label': 'Rechercher' });
    const plan = h('select', { 'aria-label': 'Offre' }, h('option', { value: '' }, 'Toutes les offres'), PLANS.map((p) => h('option', { value: p }, p)));
    const box = h('div', { class: 'dc' }, h('p', { class: 'empty' }, 'Chargement…'));
    main.append(head('Utilisateurs', 'Tous les comptes de la plateforme.', h('a', { class: 'bt solid', href: '/api/admin/export/users.csv' }, icon('down'), 'Exporter (CSV)')), h('div', { class: 'filters' }, q, plan), box);
    let timer;
    const run = async () => {
      try {
        const { users } = await api('/users?q=' + encodeURIComponent(q.value) + '&plan=' + encodeURIComponent(plan.value));
        box.replaceChildren(users.length ? h('div', { class: 'wrap' }, h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, ['Nom', 'Contact', 'Offre', 'Expire', 'Inscrit', 'Changer l’offre', 'Mot de passe'].map((t) => h('th', {}, t)))),
          h('tbody', {}, users.map((u) => { const sel = h('select', { class: 'sel', 'aria-label': 'Offre de ' + u.name }, PLANS.map((p) => h('option', { value: p, selected: p === u.plan ? '' : null }, p)));
            return h('tr', {}, h('td', {}, h('b', {}, u.name)), h('td', { class: 'mu' }, u.contact), h('td', {}, planPill(u.plan)), h('td', { class: 'mu' }, fmtDate(u.planExpires)), h('td', { class: 'mu' }, fmtDate(u.created)),
              h('td', {}, sel, ' ', h('button', { class: 'bt solid sm', type: 'button', onclick: async () => { try { await api('/users/' + u.id + '/plan', { method: 'POST', body: { plan: sel.value } }); toast('Offre mise à jour.'); run(); } catch (e) { fail(e); } } }, 'Appliquer')), h('td', {}, h('button', { class: 'bt sm', type: 'button', onclick: async () => { try { const r = await api('/users/' + u.id + '/reset-link', { method: 'POST', body: {} }); try { await navigator.clipboard.writeText(r.link); toast('Lien copié (valable 1 h). Envoyez-le à ' + u.name + ' après avoir vérifié son identité.'); } catch { window.prompt('Copiez ce lien (valable 1 h) et envoyez-le à ' + u.name + ' :', r.link); } } catch (e) { fail(e); } } }, 'Lien de réinitialisation'))); })))) : h('p', { class: 'empty' }, 'Aucun utilisateur trouvé.'));
      } catch (e) { fail(e); }
    };
    q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 250); }); plan.addEventListener('change', run);
    S.q = ''; run();
  }

  async function orgsView(main) {
    main.append(head('Organisations', 'Les entreprises créées par vos utilisateurs.'));
    try {
      const { orgs } = await api('/orgs');
      main.append(h('div', { class: 'dc' }, orgs.length ? h('div', { class: 'wrap' }, h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, ['Organisation', 'Secteur', 'Propriétaire', 'Offre', 'Équipe', 'Antennes', 'Dernière activité', 'Créée'].map((t) => h('th', {}, t)))),
        h('tbody', {}, orgs.map((o) => h('tr', {}, h('td', {}, h('b', {}, o.name)), h('td', { class: 'mu' }, o.sector || '—'), h('td', {}, o.owner, h('br'), h('span', { class: 'mu' }, o.ownerContact)), h('td', {}, planPill(o.plan)), h('td', { class: 'num' }, String(o.members)), h('td', { class: 'num' }, String(o.branches)), h('td', { class: 'mu' }, o.lastActivity ? ago(o.lastActivity) : '—'), h('td', { class: 'mu' }, fmtDate(o.created))))))) : h('p', { class: 'empty' }, 'Aucune organisation pour l’instant.')));
    } catch (e) { fail(e); }
  }

  async function paymentsView(main) {
    const sel = h('select', { class: 'sel', 'aria-label': 'Statut' }, [['', 'Tous les statuts'], ['awaiting_validation', 'À valider'], ['pending', 'En attente'], ['paid', 'Payés'], ['failed', 'Refusés / échoués']].map(([v, l]) => h('option', { value: v, selected: v === S.payFilter ? '' : null }, l)));
    sel.addEventListener('change', () => { S.payFilter = sel.value; render(); });
    main.append(head('Paiements', 'Mobile Money et paiements automatiques.', sel));
    try {
      const { payments } = await api('/payments' + (S.payFilter ? '?status=' + S.payFilter : ''));
      main.append(h('div', { class: 'dc' }, payments.length ? h('div', { class: 'wrap' }, h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, ['Référence', 'Utilisateur', 'Offre', 'Opérateur', 'Montant', 'Statut', 'Date', ''].map((t) => h('th', {}, t)))),
        h('tbody', {}, payments.map((p) => h('tr', {}, h('td', { class: 'ref' }, p.reference), h('td', {}, p.user.name, h('br'), h('span', { class: 'mu' }, p.user.contact)), h('td', {}, p.planName), h('td', { class: 'mu' }, (p.operator || '—') + (p.phone ? ' · ' + p.phone : '')), h('td', { class: 'num' }, fmtXAF(p.amountXAF)),
          h('td', {}, h('span', { class: 'pill ' + (p.status === 'paid' ? 'ok' : p.status === 'failed' ? 'red' : 'amber') }, STATUS_LABEL[p.status] || p.status)), h('td', { class: 'mu' }, fmtDateTime(p.created)),
          h('td', { class: 'r' }, p.status === 'paid' || p.status === 'failed' ? null : [h('button', { class: 'bt solid sm', type: 'button', onclick: () => payAction(p.id, 'validate') }, 'Valider'), ' ', h('button', { class: 'bt out sm', type: 'button', onclick: () => payAction(p.id, 'reject') }, 'Refuser')])))))) : h('p', { class: 'empty' }, 'Aucun paiement.')));
    } catch (e) { fail(e); }
  }

  async function plansView(main) {
    main.append(head('Offres et abonnements', 'Abonnés payants et dates d’échéance.'));
    try {
      const res = await Promise.all(PLANS.slice(1).map((n) => api('/users?plan=' + encodeURIComponent(n))));
      const list = res.flatMap((r) => r.users).sort((x, y) => String(x.planExpires || '9').localeCompare(String(y.planExpires || '9')));
      const P = S.ov ? S.ov.plans : null;
      if (P) main.append(h('div', { class: 'g5' }, [['blue', 'Gratuit', fmtN(P.Gratuit), 'comptes'], ...PLANS.slice(1).map((n, i) => [['blue', 'amber', 'red', 'blue'][i], n, fmtN(P[n] || 0), fmtN(P.prices[n]) + ' FCFA / mois'])].map(([c, t, v, s]) => h('div', { class: 'kpi ' + c }, h('small', {}, t), h('b', {}, v), h('span', { class: 'sub' }, s)))));
      main.append(h('div', { class: 'dc' }, list.length ? h('div', { class: 'wrap' }, h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, ['Abonné', 'Contact', 'Offre', 'Expire le', 'Reste'].map((t) => h('th', {}, t)))),
        h('tbody', {}, list.map((u) => { const d = u.planExpires ? Math.ceil((new Date(u.planExpires) - Date.now()) / 86400000) : null;
          return h('tr', {}, h('td', {}, h('b', {}, u.name)), h('td', { class: 'mu' }, u.contact), h('td', {}, planPill(u.plan)), h('td', { class: 'mu' }, fmtDate(u.planExpires)), h('td', {}, d === null ? '—' : h('span', { class: 'pill ' + (d <= 7 ? 'amber' : 'ok') }, d + ' j'))); })))) : h('p', { class: 'empty' }, 'Aucun abonné payant pour l’instant.')));
    } catch (e) { fail(e); }
  }

  function contactLinks(contact, text) {
    const c = String(contact || '');
    if (c.includes('@')) return h('a', { class: 'bt out sm', href: 'mailto:' + c + '?subject=' + encodeURIComponent('MANAGER-IA') + '&body=' + encodeURIComponent(text) }, 'E-mail');
    if (digits(c).length >= 8) return h('a', { class: 'bt out sm', target: '_blank', rel: 'noopener', href: 'https://wa.me/' + digits(c) + '?text=' + encodeURIComponent(text) }, 'WhatsApp');
    return null;
  }
  async function contactsView(main) {
    main.append(head('Contacts reçus', 'Demandes envoyées depuis le formulaire de contact du site.'));
    try {
      const { leads } = await api('/leads');
      main.append(h('div', { class: 'dc' }, leads.length ? h('div', { class: 'mini' }, leads.map((l) => h('div', { class: 'it ' + (l.handled ? '' : 'red') },
        h('b', {}, l.name + (l.what ? ' · ' + l.what : '')), h('span', {}, l.message || ''), h('span', {}, (l.contact || 'Sans contact') + ' · ' + fmtDateTime(l.created)),
        h('div', { class: 'row' }, contactLinks(l.contact, 'Bonjour ' + l.name + ', merci pour votre message.'), h('button', { class: 'bt ' + (l.handled ? 'out' : 'solid') + ' sm', type: 'button', onclick: async () => { try { await api('/leads/' + l.id + '/handled', { method: 'POST', body: { handled: !l.handled } }); await load(); } catch (e) { fail(e); } } }, l.handled ? 'Rouvrir' : 'Marquer comme traitée'))))) : h('p', { class: 'empty' }, 'Aucune demande de contact.')));
    } catch (e) { fail(e); }
  }

  async function aiView(main) {
    main.append(head("Utilisation de l'IA", 'Messages envoyés à l’IA de l’espace de travail, sur 14 jours.'));
    try {
      const u = await api('/ai-usage');
      const max = Math.max(1, ...u.days.map((d) => d.count)), W = 700, H = 220, base = 180, kids = [];
      u.days.forEach((d, i) => { const x = 20 + i * 48, hgt = (d.count / max) * 150; kids.push(sv('rect', { x, y: base - hgt, width: 30, height: hgt, rx: 5, class: 'bar' }), svText({ x: x + 15, y: base + 20, 'text-anchor': 'middle', class: 'ax' }, d.day.slice(8))); if (d.count) kids.push(svText({ x: x + 15, y: base - hgt - 6, 'text-anchor': 'middle', class: 'ax' }, String(d.count))); });
      main.append(h('div', { class: 'g3' }, card('Messages par jour', h('small', {}, u.total + ' au total'), sv('svg', { viewBox: '0 0 ' + W + ' ' + H, class: 'chart', role: 'img', 'aria-label': 'Messages IA par jour' }, kids)),
        card('Organisations les plus actives', null, u.top.length ? h('table', { class: 'tbl' }, h('tbody', {}, u.top.map((o) => h('tr', {}, h('td', {}, h('b', {}, o.name)), h('td', { class: 'num r' }, o.count + ' msg')))))
          : h('p', { class: 'empty' }, 'Aucune utilisation pour l’instant.'), h('p', { class: 'muted' }, u.enabled ? 'IA connectée (' + u.model + ').' : 'IA non configurée : ajoutez ANTHROPIC_API_KEY.'))));
    } catch (e) { fail(e); }
  }

  async function notifsView(main) {
    main.append(head('Notifications', 'Inscriptions, contacts, paiements : ce que le serveur vous a signalé.'));
    try {
      const { notifications } = await api('/notifications');
      main.append(h('div', { class: 'dc' }, notifications.length ? h('div', { class: 'mini' }, notifications.map((n) => h('div', { class: 'it' }, h('b', {}, n.text), h('span', {}, n.type + ' · ' + (n.channels.length ? n.channels.join(', ') : 'aucun canal') + ' · ' + fmtDateTime(n.created))))) : h('p', { class: 'empty' }, 'Aucune notification.')));
    } catch (e) { fail(e); }
  }

  async function settingsView(main) {
    main.append(head('Paramètres', 'État de la configuration du serveur (aucun secret n’est affiché).'));
    try {
      const s = await api('/settings');
      main.append(h('div', { class: 'g3' }, card('Services connectés', null, s.system.map((x) => h('div', { class: 'setrow' }, h('i', { class: x.status === 'ok' ? '' : 'warn' }), h('b', {}, x.label), h('span', {}, x.text)))),
        card('Offres et limites', null,
          PLANS.slice(1).map((n) => h('div', { class: 'setrow' }, h('b', {}, n), h('span', {}, fmtXAF(s.plans[n]) + ' / ' + s.plans.durationDays + ' jours'))),
          Object.entries(s.workspaceLimits).map(([n, l]) => h('div', { class: 'setrow' }, h('b', {}, n), h('span', {}, l.orgs + ' org. · ' + l.members + ' pers. · ' + l.branches + ' antenne(s) · ' + l.aiMonth + ' msg IA/mois'))),
          h('p', { class: 'muted' }, 'Ces valeurs se modifient dans les variables d’environnement (voir le README).'))));
    } catch (e) { fail(e); }
  }

  const VIEWS = { overview, users: usersView, orgs: orgsView, payments: paymentsView, plans: plansView, contacts: contactsView, ai: aiView, notifications: notifsView, settings: settingsView };
  function render() {
    drawShell();
    const main = $('main'); main.replaceChildren(); window.scrollTo(0, 0);
    if (!S.ov && S.view === 'overview') { main.append(h('p', { class: 'empty' }, 'Chargement…')); return; }
    (VIEWS[S.view] || overview)(main);
  }
  async function load() {
    try { S.ov = await api('/overview?days=' + S.days); if (S.ov.admin) S.admin = S.ov.admin; render(); } catch (e) { if (e.message !== 'Session expirée') fail(e); }
  }
  async function start() { showApp(); S.ov = null; await load(); }

  start().catch(() => showLogin());
})();
