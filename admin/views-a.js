'use strict';
// Écrans : tableau de bord (avec « Nouveaux comptes » en direct), clients, fiche client, paiements (actions partagées).
(function () {
  const A = window.A, { h, icon, fmtN, fmtXAF, fmtDate, fmtDateTime, ago, agoEl, plural, initials, badge, planBadge, card, cardFlush, empty, table, ask, toast, fail, api } = A;
  const S = (A.S = A.S || { days: 30, ov: null, cf: null, payFilter: 'awaiting_validation', alertStatus: 'open', payQ: '' });

  const phead = (title, sub, ...acts) => h('div', { class: 'phead' }, h('div', {}, h('h1', {}, title), sub ? h('p', {}, sub) : null), acts.length ? h('div', { class: 'acts' }, acts) : null);
  A.phead = phead;
  const fmtDay = (k) => Number(k.slice(8)) + ' ' + A.MN[Number(k.slice(5, 7)) - 1];

  // ---------- Paiements : valider / refuser (confirmation, motif obligatoire pour un refus, protection contre le double clic) ----------
  const payBusy = new Set();
  async function payAction(p, what) {
    if (payBusy.has(p.id)) return;
    const who = typeof p.user === 'string' ? p.user : p.user.name;
    const r = await ask(what === 'validate'
      ? { title: 'Valider ce paiement ?', lines: [who + ' · ' + p.planName + ' · ' + fmtXAF(p.amountXAF) + ' · réf. ' + p.reference, "L'offre sera activée tout de suite et le client sera prévenu (dans l'application, et par e-mail avec son reçu s'il a une adresse e-mail)."], confirmText: 'Oui, valider et activer' }
      : { title: 'Refuser ce paiement ?', lines: [who + ' · ' + p.planName + ' · ' + fmtXAF(p.amountXAF) + ' · réf. ' + p.reference, 'Aucune offre ne sera activée. Le motif ci-dessous sera envoyé au client.'], danger: true, confirmText: 'Oui, refuser', reason: { label: 'Motif du refus', placeholder: 'Ex. ID de transaction introuvable, montant insuffisant…', min: 3, error: 'Le motif est obligatoire (au moins 3 caractères).' } });
    if (!r) return;
    payBusy.add(p.id); A.refresh();
    try { await api('/payments/' + p.id + '/' + what, { method: 'POST', body: r.reason ? { reason: r.reason } : {} }); toast(what === 'validate' ? 'Paiement validé : l’offre est activée et le client est prévenu.' : 'Paiement refusé : le client est prévenu avec le motif.', 'ok'); }
    catch (e) { fail(e); } finally { payBusy.delete(p.id); await A.reload(); }
  }
  const payButtons = (p) => (p.status === 'paid' || p.status === 'failed' ? null : [
    h('button', { class: 'btn sm primary', type: 'button', disabled: payBusy.has(p.id) ? '' : null, onclick: () => payAction(p, 'validate') }, icon('check', 'sm'), 'Valider'),
    h('button', { class: 'btn sm danger-o', type: 'button', disabled: payBusy.has(p.id) ? '' : null, onclick: () => payAction(p, 'reject') }, 'Refuser')]);
  const STATUS_LABEL = { pending: 'En attente', awaiting_validation: 'À valider', paid: 'Validé', failed: 'Refusé / échoué' };
  const PAY_KIND = { paid: 'ok', failed: 'bad', awaiting_validation: 'warn', pending: '' };
  const payBadge = (s) => badge(STATUS_LABEL[s] || s, PAY_KIND[s] || '');
  const OPERATOR = { orange: 'Orange Money', mtn: 'MTN Mobile Money' };
  Object.assign(A, { payAction, payButtons, payBadge, STATUS_LABEL, OPERATOR, fmtDay });

  // ---------- Indicateurs ----------
  function deltaChip(cur, prev) {
    if (!prev) return cur ? h('span', { class: 'delta up' }, icon('aup'), 'nouveau') : h('span', { class: 'delta flat' }, '—');
    const pct = Math.round((100 * (cur - prev)) / Math.abs(prev));
    return h('span', { class: 'delta ' + (pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat'), 'aria-label': (pct >= 0 ? 'hausse de ' : 'baisse de ') + Math.abs(pct) + ' pour cent' }, pct === 0 ? null : icon(pct > 0 ? 'aup' : 'adown'), Math.abs(pct) + ' %');
  }
  function kpi(label, value, unit, chip, hint, series) {
    return h('div', { class: 'card kpi' },
      h('div', { class: 'l' }, label),
      h('div', { class: 'v' }, value, unit ? h('small', {}, unit) : null),
      series ? A.charts.spark(series) : h('span'),
      h('div', { class: 'd' }, chip, hint ? h('span', {}, hint) : null));
  }

  // ---------- Nouveaux comptes (en direct) ----------
  const VERIF = { email: ['E-mail vérifié', 'ok'], none: ['Sans code', ''] };
  function accountsTable(opts) {
    const L = A.live;
    const t = table({
      pager: false, pageSize: 20, rowKey: (a) => a.id, noun: 'comptes',
      sort: null,
      cols: [
        { key: 'id', label: 'Arrivée', sort: (a) => a.id, render: (a) => h('span', { class: 'nw' }, A.agoEl(a.createdAt), L.seenId != null && a.id > L.seenId ? [' ', badge('Nouveau', 'new')] : null), cls: 'nw' },
        { key: 'name', label: 'Nom', main: true, render: (a) => h('div', { class: 'who' }, h('span', { class: 'av' }, initials(a.name)), h('div', {}, h('b', {}, a.name), h('small', {}, a.contact))) },
        { key: 'plan', label: 'Offre', render: (a) => planBadge(a.plan) },
        { key: 'interests', label: 'Centres d’intérêt', sort: false, render: (a) => (a.interests.length ? a.interests.slice(0, 3).join(', ') + (a.interests.length > 3 ? ' +' + (a.interests.length - 3) : '') : h('span', { class: 'muted' }, 'Aucun')) },
        { key: 'verification', label: 'Vérification', render: (a) => badge(VERIF[a.verification][0], VERIF[a.verification][1]) },
      ],
      rowClass: (a) => (L.seenId != null && a.id > L.seenId ? 'fresh ' : '') + (L.flashId === a.id ? 'flash' : ''),
      onRow: (a) => { L.markSeen(); A.go('#/clients/' + a.id); },
      empty: empty('userplus', 'Aucun compte pour l’instant', 'Dès qu’une personne crée son compte, elle apparaît ici sans rechargement.'),
    });
    t.set(L.st.accounts);
    return t;
  }
  function liveBadge() {
    const L = A.live;
    const m = L.st.mode;
    return h('span', { class: 'live ' + (m === 'sse' ? 'on' : ''), role: 'status' }, h('i', { class: 'dot ' + (m === 'sse' ? '' : m === 'poll' ? 'warn' : 'off') }), h('span', { class: 'lt' }, m === 'sse' ? 'En direct' : m === 'poll' ? 'Actualisation toutes les 12 s' : 'Hors ligne'));
  }
  function prefsControls() {
    const L = A.live;
    const ns = L.notifState();
    return h('div', { class: 'row' },
      L.notifSupported() ? h('button', { class: 'btn sm', type: 'button', 'aria-pressed': ns === 'active' ? 'true' : 'false', title: ns === 'refusée' ? 'Refusées par le navigateur : autorisez-les dans ses réglages.' : 'Recevoir une notification du navigateur à chaque nouveau compte', onclick: () => L.setNotif(ns !== 'active') }, icon('notifications', 'sm'), ns === 'active' ? 'Notifications activées' : ns === 'refusée' ? 'Notifications refusées' : 'Activer les notifications') : null,
      h('button', { class: 'btn sm icon', type: 'button', 'aria-pressed': L.prefs.sound ? 'true' : 'false', 'aria-label': L.prefs.sound ? 'Désactiver le son' : 'Activer le son discret', title: L.prefs.sound ? 'Son activé' : 'Son désactivé', onclick: () => L.setSound(!L.prefs.sound) }, icon(L.prefs.sound ? 'volume' : 'mute', 'sm')));
  }
  /** Panneau « Nouveaux comptes » : se met à jour seul à chaque événement du direct. */
  function newAccountsPanel(opts) {
    const L = A.live;
    const host = h('section', { class: 'card live-card', 'aria-label': 'Nouveaux comptes' });
    let tbl = null;
    const draw = () => {
      const un = L.unseen();
      tbl = accountsTable();
      host.replaceChildren(
        h('div', { class: 'card-h' }, h('h2', {}, icon('userplus'), 'Nouveaux comptes', un ? h('span', { class: 'cnt new' }, un + (un > 1 ? ' nouveaux' : ' nouveau')) : null),
          h('div', { class: 'row' }, liveBadge(), prefsControls(), un ? h('button', { class: 'btn sm', type: 'button', onclick: () => { L.markSeen(); } }, icon('check', 'sm'), 'Tout marquer comme vu') : null)),
        h('div', { class: 'cb flush' }, L.st.ready ? tbl.el : A.skRows(4)),
        h('div', { class: 'tfoot' }, h('span', {}, 'Les ' + Math.min(20, L.st.accounts.length) + ' derniers sur ' + fmtN(L.st.totals.users) + ' comptes.'), h('button', { class: 'link', type: 'button', onclick: () => A.go('#/clients') }, 'Voir tous les clients')));
    };
    draw();
    const offs = [L.on('account', (a) => { L.flashId = a.id; draw(); setTimeout(() => { if (L.flashId === a.id) L.flashId = null; }, 3000); }), L.on('snapshot', draw), L.on('seen', draw), L.on('mode', draw), L.on('prefs', draw)];
    A.onLeave(() => offs.forEach((f) => f()));
    return host;
  }

  // ---------- En attente de vérification ----------
  function pendingTable() {
    const L = A.live;
    const t = table({
      pager: false, pageSize: 50, rowKey: (p) => p.key, noun: 'inscriptions',
      cols: [
        { key: 'age', label: 'Ancienneté', sort: (p) => L.pendingAge(p), render: (p) => h('span', { class: 'nw' }, A.duration(L.pendingAge(p))), cls: 'nw' },
        { key: 'name', label: 'Nom', main: true, render: (p) => h('div', { class: 'who' }, h('span', { class: 'av' }, initials(p.name)), h('div', {}, h('b', {}, p.name), h('small', {}, p.contact))) },
        { key: 'interests', label: 'Centres d’intérêt', sort: false, render: (p) => (p.interests.length ? p.interests.slice(0, 3).join(', ') : h('span', { class: 'muted' }, 'Aucun')) },
        { key: 'state', label: 'État du code', sort: (p) => (p.expired ? 1 : 0), render: (p) => (p.expired ? badge('Code expiré', 'warn') : badge('Code envoyé', 'info')) },
        { key: 'attempts', label: 'Essais / envois', sort: (p) => p.attempts, render: (p) => p.attempts + ' essai' + (p.attempts > 1 ? 's' : '') + ' · ' + p.sends + ' envoi' + (p.sends > 1 ? 's' : '') },
      ],
      empty: empty('hourglass', 'Personne en attente', 'Les personnes qui ont rempli le formulaire sans encore saisir leur code e-mail apparaissent ici.'),
    });
    t.set(L.st.pending);
    return t;
  }
  function pendingPanel() {
    const L = A.live;
    const host = h('section', { class: 'card', 'aria-label': 'En attente de vérification' });
    const draw = () => {
      const t = pendingTable(); const n = L.st.pending.length;
      host.replaceChildren(
        h('div', { class: 'card-h' }, h('h2', {}, icon('hourglass'), 'En attente de vérification', n ? h('span', { class: 'cnt' }, String(n)) : null), h('span', { class: 'sub' }, 'Formulaire rempli, code e-mail pas encore saisi')),
        h('div', { class: 'cb flush' }, L.st.ready ? t.el : A.skRows(2)),
        h('div', { class: 'tfoot' }, h('span', {}, L.st.verifyOn ? 'Le compte n’est créé qu’après la saisie du code. Adresses masquées ; mot de passe et code jamais affichés.' : 'La vérification par e-mail est désactivée sur ce serveur : les comptes sont créés directement.')));
    };
    draw();
    const offs = [L.on('pending', draw), L.on('snapshot', draw)];
    const iv = setInterval(draw, 15000); // l'ancienneté avance
    A.onLeave(() => { offs.forEach((f) => f()); clearInterval(iv); });
    return host;
  }
  A.newAccountsPanel = newAccountsPanel; A.pendingPanel = pendingPanel; A.pendingTable = pendingTable;

  // ---------- Vue d'ensemble ----------
  function overview(main) {
    const ov = S.ov, now = new Date(), k = ov.kpi, cat = ov.catalog, P = ov.plans;
    const period = A.select('Période', [[7, '7 derniers jours'], [30, '30 derniers jours'], [90, '90 derniers jours']], S.days, (v) => { S.days = Number(v); A.reload(); });
    period.classList.add('sm');
    const sub = A.MOIS[now.getMonth()];
    main.append(phead("Vue d'ensemble", now.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).replace(/^./, (c) => c.toUpperCase()) + ' · données des ' + ov.days + ' derniers jours.', period,
      h('a', { class: 'btn sm', href: '/api/admin/export/users.csv', download: '' }, icon('down', 'sm'), 'Exporter les clients')));

    const stack = h('div', { class: 'stack' });
    main.append(stack);
    stack.append(newAccountsPanel(), pendingPanel());

    // Indicateurs
    const pm = ov.series[4] ? A.MN[Number(ov.series[4].month.slice(5)) - 1] : '';
    stack.append(h('div', { class: 'grid g-kpi' },
      kpi('Utilisateurs', fmtN(k.users), '', deltaChip(k.newUsers, k.newUsersPrev), '+' + fmtN(k.newUsers) + ' sur ' + ov.days + ' j · ' + fmtN(k.activeOrgs) + ' organisations actives', ov.daily.signups),
      kpi('Abonnés payants', fmtN(k.payers), '', h('span', { class: 'delta flat' }, Math.round((100 * k.payers) / Math.max(1, k.users)) + ' %'), 'des comptes · ' + (Object.entries(k.payersByPlan).filter(([, n]) => n).map(([n, c]) => c + ' ' + n).join(' · ') || 'aucun pour l’instant'), null),
      kpi('Revenus du mois', fmtN(ov.revenueMonth), 'FCFA', deltaChip(ov.revenueMonth, ov.revenuePrev), 'vs ' + pm, ov.daily.revenue),
      kpi("Messages IA aujourd'hui", fmtN(k.aiToday), '', deltaChip(k.aiToday, k.aiYesterday), 'vs hier', ov.daily.ai)));

    // Graphiques
    const revChart = A.charts.bars({ labels: ov.series.map((s) => A.MN[Number(s.month.slice(5)) - 1]), longLabels: ov.series.map((s) => A.MOIS[Number(s.month.slice(5)) - 1] + ' ' + s.month.slice(0, 4)), values: ov.series.map((s) => s.revenue), unit: 'FCFA', minTop: 100000, name: 'Revenus', title: 'Revenus des six derniers mois, en FCFA' });
    const sigChart = A.charts.line({ labels: ov.daily.days.map(fmtDay), values: ov.daily.signups, unit: 'inscrits', minTop: 4, int: true, name: 'Inscriptions', title: 'Inscriptions par jour sur ' + ov.days + ' jours' });
    stack.append(h('div', { class: 'grid g-2' },
      card('Revenus', h('span', { class: 'sub' }, '6 derniers mois'), revChart),
      card('Inscriptions', h('span', { class: 'sub' }, 'par jour · ' + fmtN(ov.daily.signups.reduce((a, b) => a + b, 0)) + ' sur ' + ov.days + ' jours'), sigChart)));

    // À traiter + santé
    const T = ov.todo;
    const item = (ic, kind, text, go, label) => h('li', { class: kind }, icon(ic), h('span', {}, text), h('button', { class: 'btn sm', type: 'button', onclick: go }, label));
    const todo = h('ul', { class: 'todo' });
    if (T.payments) todo.append(item('payments', 'bad', plural(T.payments, 'paiement Mobile Money attend', 'paiements Mobile Money attendent') + ' votre validation', () => A.go('#/payments', { payFilter: 'awaiting_validation' }), 'Valider'));
    if (T.alerts) todo.append(item('alerts', 'bad', plural(T.alerts, "alerte d'activité suspecte est ouverte", "alertes d'activité suspecte sont ouvertes"), () => A.go('#/alerts', { alertStatus: 'open' }), 'Voir'));
    if (T.leads) todo.append(item('contacts', '', plural(T.leads, "demande de contact sans réponse", 'demandes de contact sans réponse'), () => A.go('#/contacts'), 'Répondre'));
    if (T.expiring) todo.append(item('clock', '', plural(T.expiring, 'abonnement arrive à échéance', 'abonnements arrivent à échéance') + ' cette semaine', () => A.go('#/plans'), 'Voir'));
    if (!todo.children.length) todo.append(h('li', { class: 'ok' }, icon('check'), h('span', {}, 'Rien à traiter : tout est à jour.')));
    const warn = ov.system.filter((x) => x.status !== 'ok').length;
    const sys = h('div', {}, ov.system.map((x) => h('div', { class: 'sr-row' }, h('i', { class: 'dot ' + (x.status === 'ok' ? '' : 'warn') }), h('b', {}, x.label), h('span', { class: 'v' }, x.text))));
    stack.append(h('div', { class: 'grid g-2' }, card('À traiter', null, todo), card('Santé du système', h('span', { class: 'sub' }, warn ? warn + ' à configurer' : 'Tout est opérationnel'), sys)));

    // Répartition des offres : les prix viennent de la configuration (src/config.js), jamais du code de la page
    const PN = ['Pro', 'Pro Max', 'Méga Pro', 'Illimité'].filter((n) => (P[n] || 0) > 0 || n === 'Illimité');
    const cls = { Gratuit: 's5', Pro: 's1', 'Pro Max': 's3', 'Méga Pro': 's4', 'Illimité': 's2' };
    const tot = Math.max(1, P.Gratuit + ['Pro', 'Pro Max', 'Méga Pro', 'Illimité'].reduce((a, n) => a + (P[n] || 0), 0));
    const priceOf = (n) => { const s = cat.sold.find((x) => x.name === n && x.period === 'month'); if (s) return fmtXAF(s.priceXAF) + ' / ' + s.periodLabel; const l = cat.legacy.find((x) => x.name === n); return l ? fmtXAF(l.priceXAF) + ' / mois (ancienne offre)' : ''; };
    const segs = [{ label: 'Gratuit', value: P.Gratuit, cls: cls.Gratuit }, ...['Pro', 'Pro Max', 'Méga Pro', 'Illimité'].map((n) => ({ label: n, value: P[n] || 0, cls: cls[n] }))];
    const payPct = ((100 * (tot - P.Gratuit)) / tot).toFixed(1).replace('.', ',');
    const legend = h('ul', { class: 'dleg' }, segs.filter((s) => s.value > 0 || s.label === 'Gratuit' || s.label === 'Illimité').map((s) => h('li', {}, h('i', { class: 'sq ' + s.cls }), h('b', {}, s.label), h('span', { class: 'n' }, fmtN(s.value)), h('small', {}, s.label === 'Gratuit' ? Math.round((100 * s.value) / tot) + ' % des comptes' : priceOf(s.label)))));
    const unl = h('div', { class: 'note mt' }, h('b', {}, 'Tarifs Illimité'), h('div', { class: 'row mt' }, cat.sold.map((s) => h('span', { class: 'badge plain' }, s.periodLabel.replace(/^./, (c) => c.toUpperCase()) + ' : ' + fmtXAF(s.priceXAF)))));
    const donut = card('Répartition des offres', h('span', { class: 'sub' }, fmtN(tot) + ' comptes'), h('div', { class: 'donut-w' }, A.charts.donut(segs, [payPct + ' %', 'payants']), legend), unl);

    // Paiements à valider
    const payTbl = table({ pager: false, pageSize: 5, noun: 'paiements', sort: null,
      cols: [
        { key: 'reference', label: 'Référence', sort: false, render: (p) => h('b', { class: 'mono' }, p.reference) },
        { key: 'user', label: 'Utilisateur', main: true, sort: false, render: (p) => h('b', {}, p.user) },
        { key: 'planName', label: 'Offre', sort: false },
        { key: 'amountXAF', label: 'Montant', sort: false, cls: 'nw', render: (p) => h('span', { class: 'tnum' }, fmtXAF(p.amountXAF)) },
        { key: 'act', label: '', act: true, cls: 'r', render: (p) => h('div', { class: 'row' }, payButtons(p)) }],
      empty: empty('check', 'Aucun paiement en attente', 'Tout est à jour.') });
    payTbl.set(ov.payments);
    stack.append(h('div', { class: 'grid g-12' }, donut,
      cardFlush('Paiements à valider', h('button', { class: 'link', type: 'button', onclick: () => A.go('#/payments') }, 'Tout voir (' + T.payments + ')'), payTbl.el)));

    // Demandes de contact + activité
    const leads = ov.leads.length ? h('div', { class: 'list' }, ov.leads.map((l) => h('div', { class: 'li' }, h('span', { class: 'av' }, initials(l.name)), h('div', { class: 't' }, h('b', {}, l.name), h('small', {}, l.text.slice(0, 90))), agoEl(l.created, 'muted')))) : empty('inbox', 'Aucune demande en attente', '');
    const TONE = { paiement_confirme: 'ok', paiement_a_valider: 'warn', inscription: 'info', contact: 'warn', conseiller: 'bad' };
    const act = ov.activity.length ? h('div', { class: 'list' }, ov.activity.map((a) => h('div', { class: 'li' }, h('i', { class: 'dot ' + (TONE[a.type] === 'warn' ? 'warn' : TONE[a.type] === 'bad' ? 'bad' : '') }), h('div', { class: 't' }, h('b', {}, a.text.slice(0, 90))), agoEl(a.created, 'muted')))) : empty('activity', 'Rien pour l’instant', '');
    stack.append(h('div', { class: 'grid g-2' }, cardFlush('Demandes de contact', h('button', { class: 'link', type: 'button', onclick: () => A.go('#/contacts') }, 'Voir tout'), leads), cardFlush('Activité récente', null, act)));
  }

  // ---------- Clients : liste ----------
  const PLANS = ['Gratuit', 'Pro', 'Pro Max', 'Méga Pro', 'Illimité'];
  const STATE_KIND = A.STATE_KIND;
  const csvQuery = () => { const f = S.cf || {}; return Object.entries(f).filter(([k, v]) => v && k !== 'tab').map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&'); };
  async function usersView(main) {
    const f = S.cf = Object.assign({ q: '', plan: '', state: '', sort: 'created', recent: '', suspended: '', alerts: '' }, S.cf || {});
    if (S.q) { f.q = S.q; S.q = ''; }
    const L = A.live;
    const exp = h('a', { class: 'btn sm', href: '/api/admin/export/users.csv?' + csvQuery(), download: '' }, icon('down', 'sm'), 'Exporter (CSV)');
    main.append(phead('Clients', 'Tous les comptes : offre, échéance, activité et paiements. Ouvrez une ligne pour afficher la fiche du client.', exp));
    const tabsHost = h('div', {}), body = h('div', {});
    const tab = f.tab || 'all';
    const setTab = (k) => { f.tab = k; A.refresh(); };
    tabsHost.append(h('div', { class: 'tabs', role: 'tablist' }, [['all', 'Tous les clients', null], ['pending', 'En attente de vérification', L.st.pending.length]].map(([k, l, n]) => h('button', { type: 'button', role: 'tab', 'aria-selected': tab === k ? 'true' : 'false', onclick: () => setTab(k) }, l, n ? h('span', { class: 'cnt' }, String(n)) : null))));
    main.append(tabsHost, body);
    if (tab === 'pending') {
      const host = h('div', { class: 'card' });
      const draw = () => host.replaceChildren(h('div', { class: 'cb flush' }, A.pendingTable().el), h('div', { class: 'tfoot' }, h('span', {}, 'Adresses masquées ; mot de passe et code jamais affichés.')));
      draw(); A.onLeave(L.on('pending', draw));
      body.append(host); return;
    }
    const tbl = table({
      pageSize: 25, noun: 'clients', rowKey: (c) => c.id, sort: null,
      cols: [
        { key: 'name', label: 'Client', main: true, render: (c) => h('div', { class: 'who' }, h('span', { class: 'av' }, initials(c.name)), h('div', {}, h('b', {}, c.name, c.suspended ? [' ', badge('Suspendu', 'bad')] : null, c.openAlerts ? [' ', badge(c.openAlerts + (c.openAlerts > 1 ? ' alertes' : ' alerte'), 'warn')] : null, L.seenId != null && c.id > L.seenId ? [' ', badge('Nouveau', 'new')] : null), h('small', {}, c.contact))) },
        { key: 'createdAt', label: 'Inscrit', cls: 'nw mu', render: (c) => fmtDate(c.createdAt) },
        { key: 'lastLoginAt', label: 'Dernière connexion', cls: 'nw mu', render: (c) => (c.lastLoginAt ? ago(c.lastLoginAt) : 'jamais') },
        { key: 'planLabel', label: 'Offre et échéance', render: (c) => h('div', {}, planBadge(c.planLabel), c.planState === 'free' ? null : [' ', badge(c.planStateLabel, STATE_KIND[c.planState] || '')], c.planExpires && c.planState !== 'free' ? h('small', { class: 'muted', style: null }, ' ' + (c.planState === 'expired' ? 'a expiré le ' : 'jusqu’au ') + fmtDate(c.planExpires)) : null) },
        { key: 'orgs', label: 'Orgs / membres', cls: 'nw', render: (c) => c.orgs + ' / ' + c.members },
        { key: 'aiUsed', label: 'Messages IA', cls: 'nw', render: (c) => fmtN(c.aiUsed) + ' / ' + fmtN(c.aiMax) },
        { key: 'paidTotalXAF', label: 'Total payé', cls: 'nw r', render: (c) => h('span', { class: 'tnum' }, c.paidTotalXAF ? fmtXAF(c.paidTotalXAF) : '—', c.awaitingPayments ? [' ', badge('à valider', 'warn')] : null) },
      ],
      onRow: (c) => A.go('#/clients/' + c.id),
      empty: empty('users', 'Aucun client ne correspond', 'Essayez d’autres mots ou retirez un filtre.'),
    });
    const count = h('span', { class: 'muted' });
    const q = A.searchBox('Rechercher un nom, un e-mail, un numéro…', (v) => { f.q = v; run(); }, f.q);
    const sel = (key, label, opts) => A.select(label, opts, f[key], (v) => { f[key] = v; run(); });
    const bar = h('div', { class: 'toolbar' }, q.el,
      sel('plan', 'Offre', [['', 'Toutes les offres'], ...PLANS.map((p) => [p, p]), ['Sur mesure', 'Sur mesure']]),
      sel('state', 'État de l’offre', [['', 'Tous les états'], ['active', 'Active'], ['expiring', 'Expire bientôt'], ['expired', 'Expirée'], ['free', 'Gratuite']]),
      sel('recent', 'Inscription', [['', 'Toutes les dates'], ['7', 'Inscrits cette semaine'], ['30', 'Inscrits ce mois-ci']]),
      sel('sort', 'Tri', [['created', 'Plus récents d’abord'], ['login', 'Dernière connexion'], ['name', 'Nom (A à Z)'], ['expires', 'Échéance proche'], ['paid', 'Total payé'], ['orgs', 'Organisations']]),
      A.checkbox('Suspendus', f.suspended === '1', (c) => { f.suspended = c ? '1' : ''; run(); }), A.checkbox('Avec alertes', f.alerts === '1', (c) => { f.alerts = c ? '1' : ''; run(); }));
    const box = h('section', { class: 'card' }, bar, h('div', { class: 'cb flush' }, A.skRows(6)), h('div', { class: 'tfoot' }, count));
    body.append(box);
    let seq = 0;
    async function run() {
      const my = ++seq;
      exp.setAttribute('href', '/api/admin/export/users.csv?' + csvQuery());
      try {
        const { clients, total } = await api('/clients?limit=500&' + csvQuery());
        if (my !== seq) return;
        tbl.set(clients);
        box.children[1].replaceChildren(tbl.el);
        count.textContent = fmtN(total) + (total > 1 ? ' clients' : ' client') + (total > clients.length ? ' (les ' + clients.length + ' premiers sont affichés ; affinez la recherche)' : '');
        if (f.tab !== 'pending' && !f.q && !f.plan && !f.state && !f.recent && !f.suspended && !f.alerts) L.markSeen();
      } catch (e) { fail(e); }
    }
    run();
    A.onLeave(L.on('account', () => { if (!f.q) run(); }));
  }

  // ---------- Fiche client ----------
  const WA_LABEL = { open: 'Connecté', qr: 'QR en attente', connecting: 'Connexion…', disconnected: 'Non connecté' };
  A.WA_LABEL = WA_LABEL;
  const kv = (k, v) => h('div', {}, h('small', {}, k), h('b', {}, v == null || v === '' ? '—' : v));
  async function clientView(main, ctx) {
    const id = Number(ctx.arg);
    const back = h('button', { class: 'btn sm', type: 'button', onclick: () => A.go('#/clients') }, icon('back', 'sm'), 'Tous les clients');
    main.append(A.skRows(6));
    let d;
    try { d = await api('/clients/' + id); } catch (e) { fail(e); main.replaceChildren(phead('Client introuvable', '', back), empty('users', 'Ce client n’existe pas', 'Il a peut-être été supprimé.')); return; }
    if (ctx.stale()) return;
    main.replaceChildren();
    A.crumb(d.profile.name);
    const p = d.profile, again = () => A.refresh();
    const act = async (fn, msg) => { try { await fn(); if (msg) toast(msg, 'ok'); again(); } catch (e) { fail(e); } };
    A.live.markSeen();
    main.append(phead(p.name, p.contact + ' · client n° ' + p.id, back));
    if (p.suspended) main.append(h('div', { class: 'note bad' }, h('b', {}, 'Compte suspendu'), ' depuis le ' + fmtDateTime(p.suspendedAt) + ' · motif : ' + p.suspendedReason));
    const stack = h('div', { class: 'stack mt' }); main.append(stack);

    const planSel = h('select', { class: 'select', 'aria-label': 'Offre de ' + p.name }, PLANS.map((x) => h('option', { value: x, selected: x === p.plan ? '' : null }, x)));
    const actions = h('div', { class: 'row mt' },
      p.suspended
        ? h('button', { class: 'btn primary', type: 'button', onclick: async () => { const r = await ask({ title: 'Réactiver ce compte ?', lines: [p.name + ' pourra se reconnecter. Il recevra une notice (et un e-mail s’il a une adresse e-mail).'], confirmText: 'Oui, réactiver' }); if (r) act(() => api('/clients/' + id + '/reactivate', { method: 'POST', body: {} }), 'Compte réactivé.'); } }, 'Réactiver le compte')
        : h('button', { class: 'btn danger-o', type: 'button', onclick: async () => { const r = await ask({ title: 'Suspendre ce compte ?', lines: [p.name + ' sera déconnecté de tous ses appareils, ne pourra plus se connecter (message : « Compte suspendu, contactez le support. ») et le WhatsApp de ses organisations sera coupé.'], danger: true, confirmText: 'Oui, suspendre', reason: { label: 'Motif de la suspension', placeholder: 'Ex. usage abusif signalé, paiement contesté…', min: 5, error: 'Le motif est obligatoire (au moins 5 caractères).' } }); if (r) act(() => api('/clients/' + id + '/suspend', { method: 'POST', body: { reason: r.reason } }), 'Compte suspendu.'); } }, icon('ban', 'sm'), 'Suspendre le compte'),
      h('button', { class: 'btn', type: 'button', onclick: async () => { const r = await ask({ title: 'Déconnecter tous les appareils ?', lines: [p.name + ' devra se reconnecter avec son mot de passe.'], confirmText: 'Oui, tout déconnecter' }); if (r) act(async () => { const j = await api('/clients/' + id + '/sessions/revoke-all', { method: 'POST', body: {} }); toast(j.closed ? j.closed + ' connexion(s) fermée(s).' : 'Aucune connexion ouverte.', 'ok'); }); } }, 'Déconnecter partout'),
      h('button', { class: 'btn', type: 'button', onclick: async () => { try { const r = await api('/users/' + id + '/reset-link', { method: 'POST', body: {} }); try { await navigator.clipboard.writeText(r.link); toast('Lien copié (valable 1 h). Envoyez-le après avoir vérifié son identité.', 'ok'); } catch { window.prompt('Copiez ce lien (valable 1 h) :', r.link); } } catch (e) { fail(e); } } }, 'Lien de réinitialisation'));

    const u = d.usage;
    stack.append(h('div', { class: 'grid g-2' },
      card('Profil et abonnement', null, h('div', { class: 'kv' },
        kv('Inscrit le', fmtDate(p.createdAt)), kv('Dernière connexion', p.lastLoginAt ? fmtDateTime(p.lastLoginAt) + ' (' + ago(p.lastLoginAt) + ')' : 'jamais'),
        kv('Offre', h('span', {}, planBadge(p.planLabel), p.planState === 'free' ? null : [' ', badge(p.planStateLabel, STATE_KIND[p.planState] || '')])), kv('Échéance', p.planExpires && p.planState !== 'free' ? fmtDate(p.planExpires) : '—'),
        kv('Messages IA (période en cours)', fmtN(u.aiUsed) + ' / ' + fmtN(u.aiMax)), kv('Renouvellement du quota', fmtDate(u.periodEnd)),
        kv('Limites de l’offre', u.orgsMax + ' organisation(s) · ' + (u.membersMax > 999 ? 'équipe illimitée' : u.membersMax + ' personnes')), kv('Total payé', fmtXAF(u.paidTotalXAF)),
        kv('Double authentification', p.twofa ? 'Activée' : 'Non activée')),
        h('div', { class: 'row mt' }, planSel, h('button', { class: 'btn primary', type: 'button', onclick: async () => { const r = await ask({ title: 'Changer l’offre à la main ?', lines: ['Offre « ' + planSel.value + ' » pour ' + p.name + ' (durée habituelle). Pour un paiement Mobile Money, utilisez plutôt la page « Paiements ».'], confirmText: 'Oui, appliquer' }); if (r) act(() => api('/users/' + id + '/plan', { method: 'POST', body: { plan: planSel.value } }), 'Offre mise à jour.'); } }, 'Appliquer l’offre')),
        actions),
      card('Ce que vous voyez, et ce que vous ne voyez pas', null,
        h('p', { class: 'muted' }, 'La vie privée de vos clients est protégée : cette fiche ne montre que ce qui est nécessaire pour gérer les comptes.'),
        h('h3', { class: 'mt' }, '✔ Ce que vous voyez'), h('ul', {}, d.scope.visible.map((x) => h('li', {}, x))),
        h('h3', { class: 'mt' }, '✖ Ce que vous ne voyez pas'), h('ul', {}, d.scope.hidden.map((x) => h('li', {}, x))))));

    const orgs = table({ pageSize: 10, noun: 'organisations', sort: null, cols: [
      { key: 'name', label: 'Organisation', main: true, render: (o) => h('b', {}, o.name) }, { key: 'members', label: 'Membres', cls: 'nw' }, { key: 'whatsapp', label: 'WhatsApp', render: (o) => WA_LABEL[o.whatsapp] || o.whatsapp },
      { key: 'aiUsed', label: 'Messages IA (période)', cls: 'nw', render: (o) => fmtN(o.aiUsed) }, { key: 'createdAt', label: 'Créée le', cls: 'nw mu', render: (o) => fmtDate(o.createdAt) }], empty: empty('orgs', 'Aucune organisation', '') });
    orgs.set(d.orgs);
    stack.append(cardFlush('Organisations (' + d.orgs.length + ')', null, orgs.el));

    const pays = table({ pageSize: 10, noun: 'paiements', sort: null, cols: [
      { key: 'createdAt', label: 'Date', cls: 'nw mu', render: (x) => fmtDateTime(x.createdAt) }, { key: 'planName', label: 'Offre', main: true, render: (x) => h('b', {}, x.planName) },
      { key: 'amountXAF', label: 'Montant', cls: 'nw', render: (x) => h('span', { class: 'tnum' }, fmtXAF(x.amountXAF)) },
      { key: 'operator', label: 'Opérateur', cls: 'mu', render: (x) => (x.operator || '—') + (x.phone ? ' · ' + x.phone : '') },
      { key: 'reference', label: 'Référence / ID', render: (x) => h('div', {}, h('b', { class: 'mono' }, x.reference), x.transactionId ? h('small', { class: 'muted' }, ' ID : ' + x.transactionId) : null) },
      { key: 'status', label: 'Statut', render: (x) => h('div', {}, payBadge(x.status), x.rejectReason ? h('small', { class: 'muted' }, ' Motif : ' + x.rejectReason) : null) },
      { key: 'act', label: '', act: true, cls: 'r', render: (x) => h('div', { class: 'row' }, payButtons({ ...x, user: p })) }], empty: empty('payments', 'Aucun paiement', '') });
    pays.set(d.payments);
    stack.append(cardFlush('Historique des paiements (' + d.payments.length + ')', null, pays.el));

    stack.append(card('Connexions ouvertes (' + d.sessions.length + ')', d.sessions.length ? h('button', { class: 'btn sm', type: 'button', onclick: async () => { const r = await ask({ title: 'Tout déconnecter ?', lines: ['Toutes les connexions de ' + p.name + ' seront fermées.'], confirmText: 'Oui, tout fermer' }); if (r) act(async () => { const j = await api('/clients/' + id + '/sessions/revoke-all', { method: 'POST', body: {} }); toast(j.closed + ' connexion(s) fermée(s).', 'ok'); }); } }, 'Tout fermer') : null,
      d.sessions.length ? d.sessions.map((s) => h('div', { class: 'sr-row' }, h('b', {}, s.device), h('span', { class: 'muted' }, s.ip + ' · ouverte ' + ago(s.createdAt) + ' · active ' + ago(s.lastSeen)), h('span', { class: 'v' }, h('button', { class: 'btn sm', type: 'button', onclick: () => act(() => api('/clients/' + id + '/sessions/' + s.handle + '/revoke', { method: 'POST', body: {} }), 'Connexion fermée.') }, 'Fermer cette connexion'))))
        : empty('lock', 'Aucune connexion ouverte', ''), h('p', { class: 'muted mt' }, 'Adresses tronquées par respect de la vie privée.')));

    if (d.alerts.length) stack.append(card('Alertes d’activité suspecte', null, h('div', { class: 'list' }, d.alerts.map((a) => h('div', { class: 'li' }, h('i', { class: 'dot ' + (a.severity === 'high' ? 'bad' : 'warn') }), h('div', { class: 't' }, h('b', {}, a.title), h('small', {}, a.detail)), h('span', { class: 'muted' }, a.handledAt ? 'traitée' : ago(a.createdAt)))))));

    const note = h('textarea', { class: 'textarea', rows: '3', maxlength: '1000', placeholder: 'Note privée (visible par vous seul) : appel, accord, remarque…', 'aria-label': 'Nouvelle note' });
    const tl = card('Chronologie d’activité', h('span', { class: 'sub' }, 'types d’événements et dates seulement'), d.timeline.length ? h('div', { class: 'list' }, d.timeline.map((e) => h('div', { class: 'li' }, h('i', { class: 'dot ' + (/refuse|suspendu|expiree/.test(e.kind) ? 'bad' : /valide|reactive|inscription/.test(e.kind) ? '' : 'off') }), h('div', { class: 't' }, h('b', {}, e.label + (e.detail ? ' : ' + e.detail : ''))), h('span', { class: 'muted' }, fmtDateTime(e.at))))) : empty('activity', 'Rien pour l’instant', ''));
    const nt = card('Notes de l’administrateur', null, note, h('div', { class: 'row mt' }, h('button', { class: 'btn primary sm', type: 'button', onclick: () => { const v = note.value.trim(); if (v.length < 2) { toast('Écrivez votre note.', 'bad'); return; } act(() => api('/clients/' + id + '/notes', { method: 'POST', body: { text: v } }), 'Note ajoutée.'); } }, 'Ajouter la note')),
      d.notes.length ? h('div', { class: 'list mt' }, d.notes.map((n) => h('div', { class: 'li' }, h('span'), h('div', { class: 't' }, h('b', {}, n.text), h('small', {}, fmtDateTime(n.createdAt))), h('button', { class: 'btn sm ghost', type: 'button', onclick: () => act(() => api('/clients/' + id + '/notes/' + n.id, { method: 'DELETE' }), 'Note supprimée.') }, 'Supprimer')))) : null);
    stack.append(h('div', { class: 'grid g-2' }, tl, nt));
  }

  Object.assign(A.views = A.views || {}, { overview, users: usersView, client: clientView });
})();
