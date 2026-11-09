'use strict';
// Administration Brij-IA : aucune dépendance externe. Tout texte inséré passe par textContent (jamais de HTML injecté) ;
// aucune balise <style> ni attribut style (CSP stricte) : les tailles dynamiques passent par le CSSOM.
(function () {
  const $ = (id) => document.getElementById(id);
  const NS = 'http://www.w3.org/2000/svg';
  const MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
  const JOURS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
  const MN = ['Janv.', 'Févr.', 'Mars', 'Avr.', 'Mai', 'Juin', 'Juil.', 'Août', 'Sept.', 'Oct.', 'Nov.', 'Déc.'];
  const STATUS_LABEL = { pending: 'En attente', awaiting_validation: 'À valider', paid: 'Validé', failed: 'Refusé / échoué' };
  const ICONS = {
    overview: 'M3 3h8v8H3zM13 3h8v5h-8zM13 10h8v11h-8zM3 13h8v8H3z', users: 'M16 11a4 4 0 10-8 0M4 21a8 8 0 0116 0M20 8a3 3 0 010 6',
    orgs: 'M12 3v5M5 14v-3h14v3M5 14v4M12 14v4M19 14v4M9 3h6v5H9zM2 18h6v3H2zM9 18h6v3H9zM16 18h6v3h-6z', payments: 'M3 7h18v12H3zM3 7l3-3h12l3 3M16 13h2',
    plans: 'M12 2l3 6 6 .9-4.5 4.3 1 6.3L12 16.6 6.5 19.5l1-6.3L3 8.9 9 8z', contacts: 'M3 5h18v14H3zM3 7l9 7 9-7', ai: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z',
    notifications: 'M6 8a6 6 0 1112 0c0 7 3 9 3 9H3s3-2 3-9M10 21a2 2 0 004 0', settings: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a7 7 0 000-6l2-1.5-2-3.4-2.4.9a7 7 0 00-1.7-1L14.9 1h-4l-.4 2.5a7 7 0 00-1.7 1l-2.4-.9-2 3.4 2 1.5a7 7 0 000 6l-2 1.5 2 3.4 2.4-.9a7 7 0 001.7 1l.4 2.5h4l.4-2.5a7 7 0 001.7-1l2.4.9 2-3.4z',
    alerts: 'M12 3l10 18H2zM12 10v5M12 18v.5', shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z', security: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6zM9 12l2 2 4-4', down: 'M12 3v12M7 11l5 5 5-5M4 20h16', out: 'M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9', search: 'M11 4a7 7 0 100 14 7 7 0 000-14zM21 21l-5-5',
  };
  const NAV = [['overview', "Vue d'ensemble"], ['users', 'Clients'], ['orgs', 'Organisations'], ['payments', 'Paiements'], ['alerts', 'Alertes'], ['plans', 'Offres et abonnements'], ['contacts', 'Contacts reçus'], ['ai', "Utilisation de l'IA"], ['notifications', 'Notifications'], ['security', 'Sécurité']];

  const S = { view: 'overview', days: 30, ov: null, sum: null, payFilter: 'awaiting_validation', alertStatus: 'open', admin: 'Administrateur' };

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
    if (!res.ok) { const err = new Error((data && data.error) || 'Erreur ' + res.status); err.data = data; throw err; }
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
    try {
      await api('/login', { method: 'POST', body: { username: f.get('username'), password: f.get('password'), code: f.get('code') || undefined } });
      e.target.reset(); $('codeRow').classList.add('hidden'); await start();
    } catch (err) {
      if (err.data && err.data.needCode) { $('codeRow').classList.remove('hidden'); e.target.elements.code.focus(); }
      $('loginError').textContent = err.message;
    }
  });
  async function logout() { try { await api('/logout', { method: 'POST' }); } catch (e) { /* ignore */ } showLogin(); }

  // ---------- Coque : menu, barre du haut ----------
  function go(view, extra) { S.view = view; if (extra) Object.assign(S, extra); render(); }

  function drawShell() {
    const sum = S.sum || { payments: ((S.ov && S.ov.todo) || {}).payments || 0, leads: ((S.ov && S.ov.todo) || {}).leads || 0, alerts: ((S.ov && S.ov.todo) || {}).alerts || 0 };
    const todo = { payments: sum.payments, leads: sum.leads, alerts: sum.alerts };
    const badges = { payments: todo.payments, contacts: todo.leads, alerts: todo.alerts };
    const curNav = S.view === 'client' ? 'users' : S.view;
    const btn = (k, l) => h('button', { type: 'button', class: curNav === k ? 'on' : '', 'aria-current': curNav === k ? 'page' : null, onclick: () => go(k) }, icon(k), h('span', { class: 'nl' }, l), badges[k] ? h('span', { class: 'nb' }, String(badges[k])) : null);
    $('side').replaceChildren(
      h('div', { class: 'brand' }, h('a', { class: 'logo', href: '/admin' }, 'BRIJ', h('b', {}, '-IA')), h('span', { class: 'tag' }, 'ADMIN')),
      h('div', { class: 'org' }, icon('shield'), h('div', {}, h('b', {}, 'Administration'), h('small', {}, 'Plateforme Brij-IA'))),
      h('div', { class: 'lab' }, 'GESTION'),
      h('nav', { class: 'nav', 'aria-label': 'Administration' }, NAV.map(([k, l]) => btn(k, l)), h('hr'), btn('settings', 'Paramètres')),
      h('div', { class: 'me' }, h('span', { class: 'av gold' }, initials(S.admin)), h('div', { class: 't' }, h('b', {}, S.admin), h('small', {}, 'Administrateur')),
        h('button', { type: 'button', title: 'Me déconnecter', 'aria-label': 'Me déconnecter', onclick: logout }, icon('out'))));
    const q = h('input', { type: 'search', placeholder: 'Rechercher un utilisateur, une organisation, un paiement…', 'aria-label': 'Rechercher', autocomplete: 'off' });
    $('top').replaceChildren(
      h('form', { class: 'search', onsubmit: (e) => { e.preventDefault(); const v = q.value.trim(); if (v) go('users', { q: v }); } }, icon('search'), q),
      h('span', { class: 'grow' }),
      h('button', { type: 'button', class: 'bell', title: todo.payments + ' paiement(s) à valider · ' + todo.alerts + ' alerte(s) · ' + todo.leads + ' demande(s) de contact', 'aria-label': 'À traiter : ' + (todo.payments + todo.alerts + todo.leads), onclick: () => (todo.payments ? go('payments', { payFilter: 'awaiting_validation' }) : todo.alerts ? go('alerts', { alertStatus: 'open' }) : go('overview')) }, icon('notifications'), (todo.payments + todo.alerts + todo.leads) ? h('i') : null),
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
    if (ov.todo.alerts) prio.append(h('li', { class: 'red' }, plural(ov.todo.alerts, "alerte d'activité suspecte est ouverte", "alertes d'activité suspecte sont ouvertes")));
    if (ov.todo.leads) prio.append(h('li', {}, plural(ov.todo.leads, "demande de contact n'a pas encore de réponse", "demandes de contact n'ont pas encore de réponse")));
    if (ov.todo.expiring) prio.append(h('li', {}, plural(ov.todo.expiring, 'abonnement arrive à échéance', 'abonnements arrivent à échéance') + ' cette semaine'));
    if (!prio.children.length) prio.append(h('li', { class: 'ok' }, 'Rien à traiter : tout est à jour.'));
    const brief = h('section', { class: 'brief' },
      h('div', { class: 'bh' }, icon('ai'), h('b', {}, "À traiter aujourd'hui"), h('small', {}, "Mis à jour à l'instant")), prio,
      h('div', { class: 'row' }, h('button', { class: 'bt', type: 'button', onclick: () => go('payments', { payFilter: 'awaiting_validation' }) }, 'Valider les paiements'), ov.todo.alerts ? h('button', { class: 'bt ghost', type: 'button', onclick: () => go('alerts', { alertStatus: 'open' }) }, 'Voir les alertes') : null, h('button', { class: 'bt ghost', type: 'button', onclick: () => go('contacts') }, 'Voir les demandes')));
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
      h('td', { class: 'r' }, h('button', { class: 'bt solid sm', type: 'button', disabled: payBusy.has(p.id) ? '' : null, onclick: () => payAction(p, 'validate') }, 'Valider'), ' ', h('button', { class: 'bt out sm', type: 'button', disabled: payBusy.has(p.id) ? '' : null, onclick: () => payAction(p, 'reject') }, 'Refuser'))));
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

  // ---------- Autres vues ----------

  // ---------- Clients : liste enrichie ----------
  const STATE_PILL = { active: 'ok', expiring: 'amber', expired: 'red', free: '' };
  const statePill = (c) => h('span', { class: 'pill ' + (STATE_PILL[c.planState] || '') }, c.planStateLabel);
  const csvQuery = () => { const f = S.cf || {}; return Object.entries(f).filter(([, v]) => v).map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&'); };
  async function usersView(main) {
    const f = S.cf = Object.assign({ q: '', plan: '', state: '', sort: 'created', recent: '', suspended: '', alerts: '' }, S.cf || {});
    if (S.q) { f.q = S.q; S.q = ''; }
    const q = h('input', { type: 'search', value: f.q, placeholder: 'Rechercher un nom, un e-mail, un numéro…', 'aria-label': 'Rechercher' });
    const sel = (key, label, opts) => { const s = h('select', { 'aria-label': label }, opts.map(([v, l]) => h('option', { value: v, selected: f[key] === v ? '' : null }, l))); s.addEventListener('change', () => { f[key] = s.value; run(); }); return s; };
    const chk = (key, label) => { const c = h('input', { type: 'checkbox', checked: f[key] === '1' ? '' : null }); c.addEventListener('change', () => { f[key] = c.checked ? '1' : ''; run(); }); return h('label', { class: 'chk' }, c, label); };
    const exp = h('a', { class: 'bt solid', href: '/api/admin/export/users.csv' }, icon('down'), 'Exporter (CSV)');
    const box = h('div', { class: 'dc' }, h('p', { class: 'empty' }, 'Chargement…'));
    const count = h('p', { class: 'muted' });
    main.append(head('Clients', 'Tous les comptes : offre, échéance, activité et paiements. Cliquez sur un client pour ouvrir sa fiche.', exp),
      h('div', { class: 'filters' }, q,
        sel('plan', 'Offre', [['', 'Toutes les offres'], ...PLANS.map((p) => [p, p]), ['Sur mesure', 'Sur mesure']]),
        sel('state', 'État de l’offre', [['', 'Tous les états'], ['active', 'Active'], ['expiring', 'Expire bientôt'], ['expired', 'Expirée'], ['free', 'Gratuite']]),
        sel('recent', 'Inscription', [['', 'Toutes les dates'], ['7', 'Inscrits cette semaine'], ['30', 'Inscrits ce mois-ci']]),
        sel('sort', 'Tri', [['created', 'Plus récents d’abord'], ['login', 'Dernière connexion'], ['name', 'Nom (A à Z)'], ['expires', 'Échéance proche'], ['paid', 'Total payé'], ['orgs', 'Organisations']]),
        chk('suspended', 'Suspendus'), chk('alerts', 'Avec alertes')), count, box);
    let timer;
    const run = async () => {
      f.q = q.value; exp.setAttribute('href', '/api/admin/export/users.csv?' + csvQuery());
      try {
        const { clients, total } = await api('/clients?limit=500&' + csvQuery());
        count.textContent = total + (total > 1 ? ' clients' : ' client') + (total > clients.length ? ' (les ' + clients.length + ' premiers sont affichés ; affinez la recherche)' : '');
        const cell = (c) => h('tr', { class: 'clk' + (c.suspended ? ' sus' : ''), tabindex: '0', onclick: () => go('client', { clientId: c.id }), onkeydown: (e) => { if (e.key === 'Enter') go('client', { clientId: c.id }); } },
          h('td', {}, h('b', {}, c.name), c.suspended ? h('span', { class: 'pill red sp' }, 'Suspendu') : null, c.openAlerts ? h('span', { class: 'pill amber sp' }, c.openAlerts + (c.openAlerts > 1 ? ' alertes' : ' alerte')) : null, h('br'), h('span', { class: 'mu' }, c.contact)),
          h('td', { class: 'mu' }, fmtDate(c.createdAt)),
          h('td', { class: 'mu' }, c.lastLoginAt ? ago(c.lastLoginAt) : 'jamais'),
          h('td', {}, planPill(c.planLabel), c.planState === 'free' ? null : ' ', c.planState === 'free' ? null : statePill(c), h('br'), h('span', { class: 'mu' }, c.planExpires && c.planState !== 'free' ? (c.planState === 'expired' ? 'a expiré le ' : 'jusqu’au ') + fmtDate(c.planExpires) : '')),
          h('td', { class: 'num' }, c.orgs + ' / ' + c.members),
          h('td', { class: 'num' }, fmtN(c.aiUsed) + ' / ' + fmtN(c.aiMax)),
          h('td', { class: 'num' }, c.paidTotalXAF ? fmtXAF(c.paidTotalXAF) : '—', c.awaitingPayments ? h('div', { class: 'pill amber sp' }, 'à valider') : null),
          h('td', { class: 'r' }, h('button', { class: 'bt out sm', type: 'button', onclick: (e) => { e.stopPropagation(); go('client', { clientId: c.id }); } }, 'Voir la fiche')));
        box.replaceChildren(clients.length ? h('div', { class: 'wrap' }, h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, ['Client', 'Inscrit', 'Dernière connexion', 'Offre et échéance', 'Organisations / membres', 'Messages IA (période)', 'Total payé', ''].map((t) => h('th', {}, t)))), h('tbody', {}, clients.map(cell)))) : h('p', { class: 'empty' }, 'Aucun client ne correspond.'));
      } catch (e) { fail(e); }
    };
    q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 250); });
    run();
  }

  // ---------- Fiche client ----------
  const kv = (k, v) => h('div', { class: 'kv' }, h('small', {}, k), h('b', {}, v == null || v === '' ? '—' : v));
  async function clientView(main) {
    const id = S.clientId;
    const back = h('button', { class: 'bt out', type: 'button', onclick: () => go('users') }, '← Tous les clients');
    let d;
    try { d = await api('/clients/' + id); } catch (e) { fail(e); main.append(head('Client introuvable', '', back)); return; }
    const p = d.profile, again = () => render();
    const act = async (fn, msg) => { try { await fn(); if (msg) toast(msg); again(); } catch (e) { fail(e); } };
    main.append(head(p.name, p.contact + ' · client n° ' + p.id, back));

    // En-tête : offre, état, actions
    const planSel = h('select', { class: 'sel', 'aria-label': 'Offre de ' + p.name }, PLANS.map((x) => h('option', { value: x, selected: x === p.plan ? '' : null }, x)));
    const actions = h('div', { class: 'row' },
      p.suspended
        ? h('button', { class: 'bt solid', type: 'button', onclick: async () => { const r = await ask({ title: 'Réactiver ce compte ?', lines: [p.name + ' pourra se reconnecter. Il recevra une notice (et un e-mail s’il a une adresse e-mail).'], confirmText: 'Oui, réactiver' }); if (r) act(() => api('/clients/' + id + '/reactivate', { method: 'POST', body: {} }), 'Compte réactivé.'); } }, 'Réactiver le compte')
        : h('button', { class: 'bt out dgo', type: 'button', onclick: async () => { const r = await ask({ title: 'Suspendre ce compte ?', lines: [p.name + ' sera déconnecté de tous ses appareils, ne pourra plus se connecter (message : « Compte suspendu, contactez le support. ») et le WhatsApp de ses organisations sera coupé.'], danger: true, confirmText: 'Oui, suspendre', reason: { label: 'Motif de la suspension', placeholder: 'Ex. usage abusif signalé, paiement contesté…', min: 5, error: 'Le motif est obligatoire (au moins 5 caractères).' } }); if (r) act(() => api('/clients/' + id + '/suspend', { method: 'POST', body: { reason: r.reason } }), 'Compte suspendu.'); } }, 'Suspendre le compte'),
      h('button', { class: 'bt out', type: 'button', onclick: async () => { const r = await ask({ title: 'Déconnecter tous les appareils ?', lines: [p.name + ' devra se reconnecter avec son mot de passe.'], confirmText: 'Oui, tout déconnecter' }); if (r) act(async () => { const j = await api('/clients/' + id + '/sessions/revoke-all', { method: 'POST', body: {} }); toast(j.closed ? j.closed + ' connexion(s) fermée(s).' : 'Aucune connexion ouverte.'); }); } }, 'Déconnecter partout'),
      h('button', { class: 'bt out', type: 'button', onclick: async () => { try { const r = await api('/users/' + id + '/reset-link', { method: 'POST', body: {} }); try { await navigator.clipboard.writeText(r.link); toast('Lien copié (valable 1 h). Envoyez-le après avoir vérifié son identité.'); } catch { window.prompt('Copiez ce lien (valable 1 h) :', r.link); } } catch (e) { fail(e); } } }, 'Lien de réinitialisation'));
    if (p.suspended) main.append(h('div', { class: 'ban' }, h('b', {}, 'Compte suspendu'), ' depuis le ' + fmtDateTime(p.suspendedAt) + ' · motif : ' + p.suspendedReason));

    const u = d.usage;
    main.append(h('div', { class: 'g2' },
      card('Profil et abonnement', null, h('div', { class: 'kvs' },
        kv('Inscrit le', fmtDate(p.createdAt)), kv('Dernière connexion', p.lastLoginAt ? fmtDateTime(p.lastLoginAt) + ' (' + ago(p.lastLoginAt) + ')' : 'jamais'),
        kv('Offre', h('span', {}, planPill(p.planLabel), p.planState === 'free' ? null : ' ', p.planState === 'free' ? null : statePill(p))), kv('Échéance', p.planExpires && p.planState !== 'free' ? fmtDate(p.planExpires) : '—'),
        kv('Messages IA (période en cours)', fmtN(u.aiUsed) + ' / ' + fmtN(u.aiMax)), kv('Renouvellement du quota', fmtDate(u.periodEnd)),
        kv('Limites de l’offre', u.orgsMax + ' organisation(s) · ' + (u.membersMax > 999 ? 'équipe illimitée' : u.membersMax + ' personnes')), kv('Total payé', fmtXAF(u.paidTotalXAF)),
        kv('Double authentification', p.twofa ? 'Activée' : 'Non activée')),
        h('div', { class: 'row mt' }, planSel, h('button', { class: 'bt solid sm', type: 'button', onclick: async () => { const r = await ask({ title: 'Changer l’offre à la main ?', lines: ['Offre « ' + planSel.value + ' » pour ' + p.name + ' (durée habituelle). Pour un paiement Mobile Money, utilisez plutôt la page « Paiements ».'], confirmText: 'Oui, appliquer' }); if (r) act(() => api('/users/' + id + '/plan', { method: 'POST', body: { plan: planSel.value } }), 'Offre mise à jour.'); } }, 'Appliquer l’offre')),
        actions),
      card('Ce que vous voyez, et ce que vous ne voyez pas', null,
        h('p', { class: 'muted' }, 'La vie privée de vos clients est protégée : cette fiche ne montre que ce qui est nécessaire pour gérer les comptes.'),
        h('h3', { class: 'okh' }, '✔ Ce que vous voyez'), h('ul', { class: 'sc ok' }, d.scope.visible.map((x) => h('li', {}, x))),
        h('h3', { class: 'nokh' }, '✖ Ce que vous ne voyez pas'), h('ul', { class: 'sc no' }, d.scope.hidden.map((x) => h('li', {}, x))))));

    // Organisations
    main.append(card('Organisations (' + d.orgs.length + ')', null, d.orgs.length ? h('div', { class: 'wrap' }, h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, ['Organisation', 'Membres', 'WhatsApp', 'Messages IA (période)', 'Créée le'].map((t) => h('th', {}, t)))),
      h('tbody', {}, d.orgs.map((o) => h('tr', {}, h('td', {}, h('b', {}, o.name)), h('td', { class: 'num' }, String(o.members)), h('td', {}, WA_LABEL[o.whatsapp] || o.whatsapp), h('td', { class: 'num' }, fmtN(o.aiUsed)), h('td', { class: 'mu' }, fmtDate(o.createdAt))))))) : h('p', { class: 'empty' }, 'Aucune organisation.')));

    // Paiements
    main.append(card('Historique des paiements (' + d.payments.length + ')', null, d.payments.length ? h('div', { class: 'wrap' }, h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, ['Date', 'Offre', 'Montant', 'Opérateur', 'Référence / ID', 'Statut', ''].map((t) => h('th', {}, t)))),
      h('tbody', {}, d.payments.map((x) => h('tr', {}, h('td', { class: 'mu' }, fmtDateTime(x.createdAt)), h('td', {}, x.planName), h('td', { class: 'num' }, fmtXAF(x.amountXAF)), h('td', { class: 'mu' }, (x.operator || '—') + (x.phone ? ' · ' + x.phone : '')),
        h('td', {}, h('b', { class: 'ref' }, x.reference), h('br'), h('span', { class: 'mu' }, x.transactionId ? 'ID : ' + x.transactionId : '')),
        h('td', {}, h('span', { class: 'pill ' + (PAY_PILL[x.status] || '') }, STATUS_LABEL[x.status] || x.status), x.rejectReason ? h('div', { class: 'mu why' }, 'Motif : ' + x.rejectReason) : null),
        h('td', { class: 'r' }, payButtons({ ...x, user: p }))))))) : h('p', { class: 'empty' }, 'Aucun paiement.')));

    // Connexions ouvertes
    main.append(card('Connexions ouvertes (' + d.sessions.length + ')', d.sessions.length ? h('button', { class: 'bt out sm', type: 'button', onclick: async () => { const r = await ask({ title: 'Tout déconnecter ?', lines: ['Toutes les connexions de ' + p.name + ' seront fermées.'], confirmText: 'Oui, tout fermer' }); if (r) act(async () => { const j = await api('/clients/' + id + '/sessions/revoke-all', { method: 'POST', body: {} }); toast(j.closed + ' connexion(s) fermée(s).'); }); } }, 'Tout fermer') : null,
      d.sessions.length ? d.sessions.map((s) => h('div', { class: 'setrow' }, h('b', {}, s.device), h('span', {}, s.ip + ' · ouverte ' + ago(s.createdAt) + ' · active ' + ago(s.lastSeen)),
        h('button', { class: 'bt out sm', type: 'button', onclick: () => act(() => api('/clients/' + id + '/sessions/' + s.handle + '/revoke', { method: 'POST', body: {} }), 'Connexion fermée.') }, 'Fermer cette connexion')))
        : h('p', { class: 'empty' }, 'Aucune connexion ouverte.'), h('p', { class: 'muted' }, 'Adresses tronquées par respect de la vie privée.')));

    // Alertes du client
    if (d.alerts.length) main.append(card('Alertes d’activité suspecte', null, h('div', { class: 'mini' }, d.alerts.map((a) => h('div', { class: 'it ' + (a.severity === 'high' ? 'red' : 'amber') }, h('b', {}, a.title), h('span', {}, a.detail), h('em', {}, a.handledAt ? 'traitée' : ago(a.createdAt)))))));

    // Chronologie + notes
    const note = h('textarea', { rows: '3', maxlength: '1000', placeholder: 'Note privée (visible par vous seul) : appel, accord, remarque…', 'aria-label': 'Nouvelle note' });
    const tl = card('Chronologie d’activité (types d’événements et dates seulement)', null, d.timeline.length ? h('div', { class: 'act' }, d.timeline.map((e) => h('div', {}, h('i', { class: /refuse|suspendu|expiree/.test(e.kind) ? 'r' : /valide|reactive|inscription/.test(e.kind) ? 'g' : '' }), e.label + (e.detail ? ' : ' + e.detail : ''), h('span', {}, fmtDateTime(e.at))))) : h('p', { class: 'empty' }, 'Rien pour l’instant.'));
    const nt = card('Notes de l’administrateur', null, note, h('div', { class: 'row mt' }, h('button', { class: 'bt solid sm', type: 'button', onclick: () => { const v = note.value.trim(); if (v.length < 2) { toast('Écrivez votre note.'); return; } act(() => api('/clients/' + id + '/notes', { method: 'POST', body: { text: v } }), 'Note ajoutée.'); } }, 'Ajouter la note')),
      d.notes.length ? h('div', { class: 'mini mt' }, d.notes.map((n) => h('div', { class: 'it' }, h('b', {}, n.text), h('span', {}, fmtDateTime(n.createdAt)), h('button', { class: 'link', type: 'button', onclick: () => act(() => api('/clients/' + id + '/notes/' + n.id, { method: 'DELETE' }), 'Note supprimée.') }, 'Supprimer')))) : null);
    main.append(h('div', { class: 'g3 eq' }, tl, nt));
  }

  // ---------- Alertes d'activité suspecte ----------
  const SEV_PILL = { high: 'red', medium: 'amber', low: '' };
  const THRESH_LABEL = { loginFails: 'Échecs de connexion sur un compte', loginWindowMin: '…en (minutes)', sessionIps: 'Adresses différentes sur un compte', sessionWindowH: '…en (heures)', signupsPerIp: 'Inscriptions depuis une même adresse', signupWindowH: '…en (heures)', aiPerHour: 'Messages IA en 1 heure', aiPerDay: 'Messages IA en 24 heures', payRejects: 'Paiements refusés', payWindowD: '…en (jours)', abuseWindowH: 'Blocages d’adresses récents (heures)', cooldownH: 'Pas de nouvelle alerte identique pendant (heures)' };
  const THRESH_ENV = { loginFails: 'ALERT_LOGIN_FAILS', loginWindowMin: 'ALERT_LOGIN_WINDOW_MIN', sessionIps: 'ALERT_SESSION_IPS', sessionWindowH: 'ALERT_SESSION_WINDOW_H', signupsPerIp: 'ALERT_SIGNUPS_PER_IP', signupWindowH: 'ALERT_SIGNUP_WINDOW_H', aiPerHour: 'ALERT_AI_PER_HOUR', aiPerDay: 'ALERT_AI_PER_DAY', payRejects: 'ALERT_PAY_REJECTS', payWindowD: 'ALERT_PAY_WINDOW_D', abuseWindowH: 'ALERT_ABUSE_WINDOW_H', cooldownH: 'ALERT_COOLDOWN_HOURS' };
  async function alertsView(main) {
    const st = S.alertStatus || 'open';
    main.append(head('Alertes', 'Activité suspecte repérée automatiquement toutes les 10 minutes. Vous êtes aussi prévenu par e-mail pour les alertes de gravité haute.'));
    try {
      const { alerts, counts, thresholds } = await api('/alerts?status=' + st);
      main.append(h('div', { class: 'tabs', role: 'tablist' }, [['open', 'Ouvertes'], ['handled', 'Traitées']].map(([k, l]) => h('button', { type: 'button', role: 'tab', 'aria-selected': st === k ? 'true' : 'false', class: st === k ? 'on' : '', onclick: () => { S.alertStatus = k; render(); } }, l, k === 'open' ? h('span', { class: 'cnt' + (counts.open ? ' hot' : '') }, String(counts.open)) : null))));
      main.append(h('div', { class: 'dc' }, alerts.length ? h('div', { class: 'mini' }, alerts.map((a) => h('div', { class: 'it al ' + (a.severity === 'high' ? 'red' : a.severity === 'medium' ? 'amber' : '') },
        h('div', { class: 'row' }, h('span', { class: 'pill ' + (SEV_PILL[a.severity] || '') }, 'Gravité ' + a.severityLabel.toLowerCase()), h('b', {}, a.kindLabel), a.mailed ? h('span', { class: 'mu' }, '· e-mail envoyé') : null),
        h('b', {}, a.title), h('span', {}, a.detail), h('span', {}, 'Repérée ' + ago(a.createdAt) + (a.handledAt ? ' · traitée ' + ago(a.handledAt) : '')),
        h('div', { class: 'row' }, a.user ? h('button', { class: 'bt out sm', type: 'button', onclick: () => go('client', { clientId: a.user.id }) }, 'Voir le client : ' + a.user.name) : null,
          a.handledAt ? null : h('button', { class: 'bt solid sm', type: 'button', onclick: async () => { try { await api('/alerts/' + a.id + '/handle', { method: 'POST', body: {} }); toast('Alerte marquée comme traitée.'); await refreshSummary(); render(); } catch (e) { fail(e); } } }, 'Marquer comme traitée'))))) : h('p', { class: 'empty' }, st === 'open' ? 'Aucune alerte : rien de suspect pour l’instant.' : 'Aucune alerte traitée.')));
      main.append(card('Seuils de détection', h('small', {}, 'modifiables par variables d’environnement'), Object.entries(thresholds).map(([k, v]) => h('div', { class: 'setrow' }, h('b', {}, THRESH_LABEL[k] || k), h('span', {}, v + '  ·  ' + THRESH_ENV[k])))));
    } catch (e) { fail(e); }
  }

  const WA_LABEL = { open: 'Connecté', qr: 'QR en attente', connecting: 'Connexion…', disconnected: 'Non connecté' };
  function waCell(o) {
    const st = (o.wa && o.wa.status) || 'disconnected';
    if (st === 'disconnected') return h('span', { class: 'mu' }, WA_LABEL.disconnected);
    return h('div', {}, h('span', {}, WA_LABEL[st] || st), o.wa.number ? h('div', { class: 'mu' }, '+' + o.wa.number.replace(/\D/g, '')) : '', h('button', { class: 'bt out sm', type: 'button', onclick: async () => { if (!window.confirm('Déconnecter le WhatsApp de « ' + o.name + ' » ? La session sera fermée et le client devra rescanner le QR code.')) return; try { await api('/security/orgs/' + o.id + '/wa-disconnect', { method: 'POST', body: {} }); toast('WhatsApp de ' + o.name + ' déconnecté.'); go('orgs'); } catch (e) { fail(e); } } }, 'Déconnecter'));
  }
  async function orgsView(main) {
    main.append(head('Organisations', 'Les entreprises créées par vos utilisateurs.'));
    try {
      const { orgs } = await api('/orgs');
      main.append(h('div', { class: 'dc' }, orgs.length ? h('div', { class: 'wrap' }, h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, ['Organisation', 'Secteur', 'Propriétaire', 'Offre', 'Équipe', 'Antennes', 'WhatsApp', 'Dernière activité', 'Créée'].map((t) => h('th', {}, t)))),
        h('tbody', {}, orgs.map((o) => h('tr', {}, h('td', {}, h('b', {}, o.name)), h('td', { class: 'mu' }, o.sector || '—'), h('td', {}, o.owner, h('br'), h('span', { class: 'mu' }, o.ownerContact)), h('td', {}, planPill(o.plan)), h('td', { class: 'num' }, String(o.members)), h('td', { class: 'num' }, String(o.branches)), h('td', {}, waCell(o)), h('td', { class: 'mu' }, o.lastActivity ? ago(o.lastActivity) : '—'), h('td', { class: 'mu' }, fmtDate(o.created))))))) : h('p', { class: 'empty' }, 'Aucune organisation pour l’instant.')));
    } catch (e) { fail(e); }
  }

  // ---------- Boîte de confirmation (remplace window.confirm : permet de saisir un motif) ----------
  function ask(o) {
    return new Promise((resolve) => {
      const prev = document.activeElement;
      const esc = (e) => { if (e.key === 'Escape') close(null); };
      function close(v) { ov.remove(); document.removeEventListener('keydown', esc); if (prev && prev.focus) prev.focus(); resolve(v); }
      const ta = o.reason ? h('textarea', { rows: '3', maxlength: '300', placeholder: o.reason.placeholder || '', 'aria-label': o.reason.label || 'Motif' }) : null;
      const err = h('p', { class: 'error', role: 'alert' });
      const ok = h('button', { class: 'bt solid' + (o.danger ? ' dg' : ''), type: 'button', onclick: () => {
        if (ta) { const v = ta.value.trim(); if (v.length < (o.reason.min || 3)) { err.textContent = o.reason.error || 'Écrivez le motif.'; ta.focus(); return; } ok.disabled = true; close({ reason: v }); } else { ok.disabled = true; close({}); }
      } }, o.confirmText || 'Confirmer');
      const ov = h('div', { class: 'mdl', role: 'dialog', 'aria-modal': 'true', 'aria-label': o.title },
        h('div', { class: 'mdb' }, h('h2', {}, o.title), (o.lines || []).map((l) => h('p', {}, l)), ta, err, h('div', { class: 'row' }, ok, h('button', { class: 'bt out', type: 'button', onclick: () => close(null) }, 'Annuler'))));
      ov.addEventListener('click', (e) => { if (e.target === ov) close(null); });
      document.body.append(ov); document.addEventListener('keydown', esc); (ta || ok).focus();
    });
  }

  // ---------- Paiements : valider / refuser (confirmation, motif obligatoire pour un refus, protection contre le double clic) ----------
  const payBusy = new Set();
  async function payAction(p, what) {
    if (payBusy.has(p.id)) return;
    const who = typeof p.user === 'string' ? p.user : p.user.name;
    const r = await ask(what === 'validate'
      ? { title: 'Valider ce paiement ?', lines: [who + ' · ' + p.planName + ' · ' + fmtXAF(p.amountXAF) + ' · réf. ' + p.reference, "L'offre sera activée tout de suite et le client sera prévenu (dans l'application, et par e-mail avec son reçu s'il a une adresse e-mail)."], confirmText: 'Oui, valider et activer' }
      : { title: 'Refuser ce paiement ?', lines: [who + ' · ' + p.planName + ' · ' + fmtXAF(p.amountXAF) + ' · réf. ' + p.reference, "Aucune offre ne sera activée. Le motif ci-dessous sera envoyé au client."], danger: true, confirmText: 'Oui, refuser', reason: { label: 'Motif du refus', placeholder: 'Ex. ID de transaction introuvable, montant insuffisant…', min: 3, error: 'Le motif est obligatoire (au moins 3 caractères).' } });
    if (!r) return;
    payBusy.add(p.id); render();
    try { await api('/payments/' + p.id + '/' + what, { method: 'POST', body: r.reason ? { reason: r.reason } : {} }); toast(what === 'validate' ? 'Paiement validé : l’offre est activée et le client est prévenu.' : 'Paiement refusé : le client est prévenu avec le motif.'); }
    catch (e) { fail(e); }
    finally { payBusy.delete(p.id); await load(); }
  }
  const payButtons = (p) => (p.status === 'paid' || p.status === 'failed' ? null : [
    h('button', { class: 'bt solid sm', type: 'button', disabled: payBusy.has(p.id) ? '' : null, onclick: () => payAction(p, 'validate') }, 'Valider'), ' ',
    h('button', { class: 'bt out sm', type: 'button', disabled: payBusy.has(p.id) ? '' : null, onclick: () => payAction(p, 'reject') }, 'Refuser')]);
  const PAY_PILL = { paid: 'ok', failed: 'red', awaiting_validation: 'amber', pending: '' };
  const PAY_TABS = [['awaiting_validation', 'À valider'], ['pending', 'En attente'], ['paid', 'Validés'], ['failed', 'Refusés'], ['', 'Tous']];
  async function paymentsView(main) {
    const q = h('input', { type: 'search', value: S.payQ || '', placeholder: 'Rechercher : nom, contact, référence, ID de transaction…', 'aria-label': 'Rechercher un paiement' });
    const tabs = h('div', { class: 'tabs', role: 'tablist' });
    const box = h('div', { class: 'dc' }, h('p', { class: 'empty' }, 'Chargement…'));
    main.append(head('Paiements', 'Mobile Money et paiements automatiques. Validez ou refusez chaque paiement ; le client est prévenu dans les deux cas.'), tabs, h('div', { class: 'filters' }, q), box);
    const run = async () => {
      try {
        const { payments, counts } = await api('/payments?status=' + encodeURIComponent(S.payFilter) + '&q=' + encodeURIComponent(q.value));
        tabs.replaceChildren(...PAY_TABS.map(([k, l]) => h('button', { type: 'button', role: 'tab', 'aria-selected': S.payFilter === k ? 'true' : 'false', class: S.payFilter === k ? 'on' : '', onclick: () => { S.payFilter = k; render(); } },
          l, k === '' ? null : h('span', { class: 'cnt' + (k === 'awaiting_validation' && counts[k] ? ' hot' : '') }, String(counts[k] || 0)))));
        const rows = payments.map((p) => h('tr', {},
          h('td', { class: 'mu' }, fmtDateTime(p.created)),
          h('td', {}, h('button', { class: 'link tx', type: 'button', onclick: () => go('client', { clientId: p.user.id }) }, p.user.name), h('br'), h('span', { class: 'mu' }, p.user.contact)),
          h('td', {}, p.planName, h('br'), h('span', { class: 'mu' }, p.durationDays ? p.durationDays + ' jours' : '')),
          h('td', { class: 'num' }, fmtXAF(p.amountXAF)),
          h('td', { class: 'mu' }, (p.operator === 'orange' ? 'Orange Money' : p.operator === 'mtn' ? 'MTN Mobile Money' : p.operator || '—'), h('br'), p.phone || ''),
          h('td', {}, h('b', { class: 'ref' }, p.reference), h('br'), h('span', { class: 'mu' }, p.transactionId ? 'ID : ' + p.transactionId : p.mode === 'push' ? 'Paiement automatique' : 'ID pas encore saisi')),
          h('td', {}, h('span', { class: 'pill ' + (PAY_PILL[p.status] || '') }, STATUS_LABEL[p.status] || p.status), p.status === 'failed' && p.rejectReason ? h('div', { class: 'mu why' }, 'Motif : ' + p.rejectReason) : null, p.decidedAt ? h('div', { class: 'mu why' }, fmtDateTime(p.decidedAt)) : null),
          h('td', { class: 'r' }, payButtons(p))));
        box.replaceChildren(payments.length ? h('div', { class: 'wrap' }, h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, ['Date', 'Client', 'Offre et durée', 'Montant', 'Opérateur et numéro', 'Référence et ID', 'Statut', ''].map((t) => h('th', {}, t)))), h('tbody', {}, rows)))
          : h('p', { class: 'empty' }, S.payFilter === 'awaiting_validation' ? 'Aucun paiement à valider : tout est à jour.' : 'Aucun paiement.'));
      } catch (e) { fail(e); }
    };
    let tm; q.addEventListener('input', () => { clearTimeout(tm); tm = setTimeout(() => { S.payQ = q.value; run(); }, 250); });
    run();
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
    if (c.includes('@')) return h('a', { class: 'bt out sm', href: 'mailto:' + c + '?subject=' + encodeURIComponent('Brij-IA') + '&body=' + encodeURIComponent(text) }, 'E-mail');
    if (digits(c).length >= 8) return h('a', { class: 'bt out sm', target: '_blank', rel: 'noopener', href: 'https://wa.me/' + digits(c) + '?text=' + encodeURIComponent(text) }, 'WhatsApp');
    return null;
  }
  const LEAD_STATUS = [['new', 'Nouveau'], ['contacted', 'Contacté'], ['trial', 'En essai'], ['client', 'Client'], ['lost', 'Perdu']];
  // Statistiques de visites : anonymes (aucune adresse, aucun cookie) ; barres simples en HTML.
  function visitsCard(v) {
    const bars = (rows, key) => (rows.length ? rows.map((r) => h('div', { class: 'vb' }, h('span', {}, r[key] === '/' ? 'Accueil' : r[key]), h('i', { style: 'width:' + Math.max(4, Math.round(100 * r.n / rows[0].n)) + '%' }), h('b', {}, r.n))) : h('p', { class: 'empty' }, 'Pas encore de visite.'));
    return h('section', { class: 'dc' }, h('div', { class: 'ch' }, h('h2', {}, 'Visites du site (' + v.days + ' jours)'), h('em', {}, v.total + (v.total > 1 ? ' pages vues' : ' page vue'))),
      h('p', { class: 'muted', style: 'font-size:12px' }, 'Comptage anonyme : ni adresse, ni cookie, ni identifiant. On sait combien de pages sont lues et d\'où viennent les gens, jamais qui ils sont.'),
      h('div', { class: 'g3' }, h('div', {}, h('h3', {}, 'Origines'), bars(v.sources, 'source')), h('div', {}, h('h3', {}, 'Pages lues'), bars(v.pages, 'path')), h('div', {}, h('h3', {}, 'Appareils'), bars(v.devices, 'device'))));
  }
  async function contactsView(main) {
    main.append(head('Contacts reçus', 'Personnes qui ont laissé leurs coordonnées (formulaire, essai gratuit) : suivez chacune jusqu\'au client.'));
    try {
      const [{ leads }, vis] = await Promise.all([api('/leads'), api('/visits')]);
      main.append(visitsCard(vis));
      const counts = LEAD_STATUS.map(([k, t]) => t + ' : ' + leads.filter((l) => l.status === k).length).join(' · ');
      main.append(h('p', { class: 'muted' }, leads.length ? counts : ''));
      main.append(h('div', { class: 'dc' }, leads.length ? h('div', { class: 'mini' }, leads.map((l) => {
        const sel = h('select', { 'aria-label': 'Étape de suivi' }, LEAD_STATUS.map(([k, t]) => h('option', { value: k, selected: l.status === k ? 'selected' : false }, t)));
        const notes = h('input', { type: 'text', maxlength: '1000', placeholder: 'Notes (ex. appelé le lundi, veut une démo)', value: l.notes || '', style: 'flex:1;min-width:160px' });
        const follow = !l.consent ? 'Pas de consentement : aucune relance automatique' : l.unsubscribed ? 'Désinscrit des relances' : !l.email ? 'Pas d\'e-mail : pas de relance automatique' : l.status === 'client' || l.status === 'lost' || l.status === 'trial' ? 'Relances arrêtées (suivi manuel)' : l.followStage >= 3 ? 'Les 3 relances ont été envoyées' : 'Relances envoyées : ' + l.followStage + '/3' + (l.nextFollow ? ' · prochaine ' + fmtDateTime(l.nextFollow) : '');
        return h('div', { class: 'it ' + (l.status === 'new' ? 'red' : l.status === 'client' ? '' : 'amber') },
          h('b', {}, l.name + (l.what ? ' · ' + l.what : '')), h('span', {}, l.message || ''),
          h('span', {}, (l.contact || 'Sans contact') + (l.source ? ' · via ' + l.source : '') + ' · ' + fmtDateTime(l.created)), h('span', {}, follow),
          h('div', { class: 'row' }, contactLinks(l.contact, 'Bonjour ' + l.name + ', merci pour votre message.'), sel, notes,
            h('button', { class: 'bt solid sm', type: 'button', onclick: async () => { try { await api('/leads/' + l.id + '/status', { method: 'POST', body: { status: sel.value, notes: notes.value } }); toast('Suivi enregistré.'); await load(); } catch (e) { fail(e); } } }, 'Enregistrer')));
      })) : h('p', { class: 'empty' }, 'Aucune demande de contact.')));
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

    // ---------- Sécurité : état, double authentification, journal d'audit, adresses bloquées, sessions ----------
  const SEV = { info: ['Info', ''], warn: ['Attention', 'warn'], high: ['Grave', 'bad'], critical: ['Critique', 'bad'] };
  const sevPill = (s) => h('span', { class: 'pill ' + (SEV[s] ? SEV[s][1] : '') }, SEV[s] ? SEV[s][0] : s);
  const lvlDot = (l) => h('i', { class: l === 'ok' ? '' : 'warn', style: l === 'bad' ? 'background:#e11d48' : null });
  async function securityView(main) {
    main.append(head('Sécurité', 'Le centre de contrôle : configuration, accès, journal d’audit et protections automatiques.'));
    const box = h('div', {}, h('p', { class: 'empty' }, 'Chargement…'));
    main.append(box);
    const reload = async () => {
      let o;
      try { o = await api('/security/overview'); } catch (e) { fail(e); return; }
      const sm = o.config.summary;
      const kpi = (t, v, sub, cls) => h('div', { class: 'kpi ' + (cls || '') }, h('small', {}, t), h('b', {}, String(v)), h('span', {}, sub));
      const cfg = card('Configuration de sécurité', h('span', { class: 'mu' }, sm.ok + ' ok · ' + sm.warn + ' à améliorer · ' + sm.bad + ' dangereux'),
        o.config.items.map((x) => h('div', { class: 'setrow' }, lvlDot(x.level), h('b', {}, x.title), h('span', {}, x.text))));
      // Double authentification de l'administrateur
      const tfaBox = h('div', {});
      const drawTfa = () => {
        tfaBox.replaceChildren();
        if (o.twofa.enabled) {
          const pw = h('input', { type: 'password', placeholder: 'Mot de passe administrateur', autocomplete: 'current-password' }); const cd = h('input', { placeholder: 'Code ou code de secours', autocomplete: 'one-time-code' });
          tfaBox.append(h('p', {}, h('span', { class: 'pill ok' }, 'Active'), ' ' + o.twofa.recoveryLeft + ' code(s) de secours restant(s).'),
            h('div', { class: 'row' }, pw, cd, h('button', { class: 'bt out sm', type: 'button', onclick: async () => { try { await api('/security/2fa/disable', { method: 'POST', body: { password: pw.value, code: cd.value } }); toast('Double authentification désactivée.'); reload(); } catch (e) { fail(e); } } }, 'Désactiver')));
        } else {
          const pw = h('input', { type: 'password', placeholder: 'Mot de passe administrateur', autocomplete: 'current-password' });
          tfaBox.append(h('p', { class: 'mu' }, 'Non activée : un mot de passe volé suffirait à entrer. Utilisez une application d’authentification (Google Authenticator, Microsoft Authenticator, Authy, 2FAS…).'),
            h('div', { class: 'row' }, pw, h('button', { class: 'bt solid sm', type: 'button', onclick: async () => {
              try {
                const j = await api('/security/2fa/setup', { method: 'POST', body: { password: pw.value } });
                const cd = h('input', { placeholder: 'Code à 6 chiffres', inputmode: 'numeric', autocomplete: 'one-time-code' });
                tfaBox.replaceChildren(h('p', {}, 'Dans votre application, ajoutez un compte avec cette clé (saisie manuelle, type « basé sur le temps ») :'), h('p', {}, h('b', { style: 'word-break:break-all;font-family:ui-monospace,Menlo,monospace' }, j.secret)),
                  h('p', { class: 'mu' }, 'Ou ouvrez ce lien sur le téléphone qui a l’application : ', h('a', { href: j.uri }, 'ajouter automatiquement')),
                  h('div', { class: 'row' }, cd, h('button', { class: 'bt solid sm', type: 'button', onclick: async () => {
                    try {
                      const r = await api('/security/2fa/enable', { method: 'POST', body: { code: cd.value } });
                      tfaBox.replaceChildren(h('p', {}, h('b', {}, 'Activée.'), ' Notez ces codes de secours (chacun sert une fois, ils ne seront plus affichés) :'), h('pre', { style: 'background:var(--bg);padding:12px;border-radius:12px;columns:2' }, r.recoveryCodes.join('\n')), h('button', { class: 'bt solid sm', type: 'button', onclick: reload }, 'J’ai noté mes codes'));
                    } catch (e) { fail(e); }
                  } }, 'Confirmer et activer')));
              } catch (e) { fail(e); }
            } }, 'Activer')));
        }
      };
      drawTfa();
      // Journal d'audit
      const sev = h('select', { 'aria-label': 'Gravité' }, h('option', { value: '' }, 'Toutes gravités'), ['info', 'warn', 'high', 'critical'].map((k) => h('option', { value: k }, SEV[k][0])));
      const q = h('input', { type: 'search', placeholder: 'Adresse, cible, détail…', 'aria-label': 'Rechercher' });
      const act = h('input', { type: 'search', placeholder: 'Action (ex. login, admin, apikey)', 'aria-label': 'Action' });
      const tbl = h('div', {}, h('p', { class: 'empty' }, 'Chargement…'));
      const verifyOut = h('span', { class: 'mu' });
      const loadAudit = async () => {
        try {
          const { events } = await api('/security/audit?limit=100&severity=' + encodeURIComponent(sev.value) + '&q=' + encodeURIComponent(q.value) + '&action=' + encodeURIComponent(act.value));
          tbl.replaceChildren(events.length ? h('div', { class: 'wrap' }, h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, ['Quand', 'Gravité', 'Action', 'Qui', 'Cible / détail', 'Adresse'].map((t) => h('th', {}, t)))),
            h('tbody', {}, events.map((e) => h('tr', {}, h('td', { class: 'mu' }, fmtDateTime(e.at)), h('td', {}, sevPill(e.severity)), h('td', {}, h('b', {}, e.action)), h('td', { class: 'mu' }, e.actorType + (e.actorId ? ' #' + e.actorId : '') + (e.orgId ? ' · org ' + e.orgId : '')), h('td', { class: 'mu' }, [e.target, e.detail].filter(Boolean).join(' · ')), h('td', { class: 'mu' }, e.ip)))))) : h('p', { class: 'empty' }, 'Aucun événement.'));
        } catch (e) { fail(e); }
      };
      let tm; for (const el of [q, act]) el.addEventListener('input', () => { clearTimeout(tm); tm = setTimeout(loadAudit, 300); }); sev.addEventListener('change', loadAudit);
      const audit = card('Journal d’audit', h('span', {}, verifyOut, ' ', h('button', { class: 'bt out sm', type: 'button', onclick: async () => { verifyOut.textContent = 'Vérification…'; try { const r = await api('/security/audit/verify', { method: 'POST', body: {} }); verifyOut.textContent = r.ok ? '✔ Chaîne intacte (' + r.checked + ' lignes)' : '✖ Chaîne ROMPUE à la ligne ' + r.brokenAt; verifyOut.style.color = r.ok ? '' : '#e11d48'; } catch (e) { fail(e); } } }, 'Vérifier l’intégrité')),
        h('div', { class: 'filters' }, sev, act, q), tbl);
      loadAudit();
      // Adresses bloquées
      const ip = h('input', { placeholder: 'Adresse IP', 'aria-label': 'Adresse IP' }); const hrs = h('input', { type: 'number', value: '24', min: '1', style: 'width:90px', 'aria-label': 'Heures' }); const why = h('input', { placeholder: 'Motif', 'aria-label': 'Motif' });
      const blocks = card('Adresses bloquées', h('span', { class: 'mu' }, 'Blocage automatique après des abus répétés'),
        o.blocks.length ? h('div', { class: 'wrap' }, h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, ['Adresse', 'Motif', 'Jusqu’à', 'Par', ''].map((t) => h('th', {}, t)))), h('tbody', {}, o.blocks.map((b) => h('tr', {}, h('td', {}, h('b', {}, b.ip)), h('td', { class: 'mu' }, b.reason), h('td', { class: 'mu' }, b.permanent ? 'définitivement' : fmtDateTime(b.blockedUntil)), h('td', { class: 'mu' }, b.createdBy), h('td', { class: 'r' }, h('button', { class: 'bt out sm', type: 'button', onclick: async () => { try { await api('/security/blocks/' + encodeURIComponent(b.ip), { method: 'DELETE' }); toast('Adresse débloquée.'); reload(); } catch (e) { fail(e); } } }, 'Débloquer'))))))) : h('p', { class: 'empty' }, 'Aucune adresse bloquée.'),
        h('div', { class: 'row', style: 'margin-top:12px' }, ip, hrs, why, h('button', { class: 'bt solid sm', type: 'button', onclick: async () => { try { await api('/security/blocks', { method: 'POST', body: { ip: ip.value, hours: Number(hrs.value), reason: why.value } }); toast('Adresse bloquée.'); reload(); } catch (e) { fail(e); } } }, 'Bloquer')));
      // Sessions administrateur
      const sess = card('Sessions administrateur', h('span', { class: 'mu' }, o.activeUserSessions + ' session(s) utilisateur active(s)'),
        o.sessions.map((s) => h('div', { class: 'setrow' }, h('b', {}, s.device + (s.current ? ' (cette session)' : '')), h('span', {}, s.ip + ' · active ' + ago(s.lastSeen)), s.current ? null : h('button', { class: 'bt out sm', type: 'button', onclick: async () => { try { await api('/security/sessions/' + s.id, { method: 'DELETE' }); reload(); } catch (e) { fail(e); } } }, 'Fermer'))),
        o.sessions.length > 1 ? h('p', {}, h('button', { class: 'bt out sm', type: 'button', onclick: async () => { try { const r = await api('/security/sessions/revoke-others', { method: 'POST', body: {} }); toast(r.closed + ' session(s) fermée(s).'); reload(); } catch (e) { fail(e); } } }, 'Fermer toutes les autres sessions')) : null,
        h('p', { class: 'mu' }, 'Compte utilisateur suspect : ouvrez « Utilisateurs » et cliquez sur « Déconnecter » en face de son nom pour fermer tous ses appareils.'));
      box.replaceChildren(
        h('div', { class: 'g4' }, kpi('Alertes 24 h (graves)', o.last24h.high + o.last24h.critical, o.last24h.critical + ' critique(s)', o.last24h.high + o.last24h.critical ? 'bad' : ''), kpi('À surveiller 24 h', o.last24h.warn, 'événements « attention »'), kpi('Adresses bloquées', o.blocks.length, 'actuellement'), kpi('Lignes d’audit', o.auditRows, 'chaîne SHA-256')),
        h('div', { class: 'g3' }, cfg, card('Double authentification de l’administrateur', null, tfaBox), blocks), sess, audit);
    };
    reload();
  }

  const VIEWS = { overview, users: usersView, client: clientView, alerts: alertsView, orgs: orgsView, payments: paymentsView, plans: plansView, contacts: contactsView, ai: aiView, notifications: notifsView, settings: settingsView, security: securityView };
  function render() {
    drawShell();
    const main = $('main'); main.replaceChildren(); window.scrollTo(0, 0);
    if (!S.ov && S.view === 'overview') { main.append(h('p', { class: 'empty' }, 'Chargement…')); return; }
    (VIEWS[S.view] || overview)(main);
  }
  async function refreshSummary() {
    try {
      const prev = S.sum, sum = await api('/summary'); S.sum = sum;
      const n = sum.payments + sum.alerts;
      document.title = (n ? '(' + n + ') ' : '') + 'Administration Brij-IA';
      if (prev && sum.payments > prev.payments) toast('Nouveau paiement à valider : ouvrez « Paiements ».');
      else if (prev && sum.alerts > prev.alerts) toast('Nouvelle alerte d’activité suspecte.');
      if (prev && (prev.payments !== sum.payments || prev.alerts !== sum.alerts || prev.leads !== sum.leads)) { drawShell(); if (S.view === 'payments' || S.view === 'alerts') render(); }
    } catch (e) { /* hors ligne ou session expirée : on réessaiera */ }
  }
  async function load() {
    try { S.ov = await api('/overview?days=' + S.days); if (S.ov.admin) S.admin = S.ov.admin; await refreshSummary(); render(); } catch (e) { if (e.message !== 'Session expirée') fail(e); }
  }
  let sumTimer = null;
  async function start() { showApp(); S.ov = null; S.sum = null; await load(); if (!sumTimer) sumTimer = setInterval(refreshSummary, 60000); }

  start().catch(() => showLogin());
})();
