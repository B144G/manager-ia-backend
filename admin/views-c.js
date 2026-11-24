'use strict';
// Étape 2 : utilisation des modules, santé de la plateforme, abonnements à expirer, posture de sécurité.
(function () {
  const A = window.A, { h, icon, fmtN, fmtXAF, fmtDate, ago, initials, badge, planBadge, card, cardFlush, empty, table, api, phead } = A;
  const S = A.S;
  const MODULE_LABEL = { sales: 'Ventes', accounting: 'Comptabilité', payroll: 'Paie', stock: 'Stock', purchasing: 'Achats', crm: 'Clients (CRM)', budget: 'Budget', team: 'Équipe', projects: 'Projets', legal: 'Juridique', production: 'Production', memory: 'Mémoire', logistics: 'Logistique', construction: 'Chantiers', aifollow: 'Relances IA', support: 'Support', marketing: 'Marketing', maintenance: 'Maintenance', integrations: 'Intégrations', fiscal: 'Fiscalité', structure: 'Structure', hr: 'Ressources humaines', dashboard: 'Tableau de bord', alerts: 'Alertes', agents: 'Agents', processes: 'Processus', documents: 'Documents' };
  const modName = (m) => MODULE_LABEL[m] || m.charAt(0).toUpperCase() + m.slice(1);
  const kpi = (label, value, unit, hint) => h('div', { class: 'card kpi' }, h('div', { class: 'l' }, label), h('div', { class: 'v' }, value, unit ? h('small', {}, unit) : null), h('span'), h('div', { class: 'd' }, hint || ''));
  const pct = (x) => Math.round(100 * x) + ' %';
  const evo = (cur, prev) => { if (!prev) return cur ? h('span', { class: 'delta up' }, icon('aup'), 'nouveau') : h('span', { class: 'muted' }, '—'); const p = Math.round((100 * (cur - prev)) / prev); return h('span', { class: 'delta ' + (p > 0 ? 'up' : p < 0 ? 'down' : 'flat') }, p === 0 ? null : icon(p > 0 ? 'aup' : 'adown'), Math.abs(p) + ' %'); };

  // ---------- Utilisation des modules ----------
  async function modulesView(main) {
    const days = S.modDays || 30;
    const period = A.select('Période', [[7, '7 derniers jours'], [30, '30 derniers jours'], [90, '90 derniers jours']], days, (v) => { S.modDays = Number(v); A.refresh(); }); period.classList.add('sm');
    main.append(phead('Utilisation des modules', 'Quels modules vos clients utilisent vraiment : volume d’actions, organisations actives et évolution. Comptage seulement, jamais de contenu.', period));
    const d = await api('/insights/modules?days=' + days);
    const stack = h('div', { class: 'stack' }); main.append(stack);
    const top = d.modules[0];
    stack.append(h('div', { class: 'grid g-kpi' },
      kpi('Actions enregistrées', fmtN(d.total), '', 'sur ' + days + ' jours'), kpi('Organisations actives', fmtN(d.activeOrgs), '', 'sur ' + fmtN(d.totalOrgs) + ' au total'),
      kpi('Modules utilisés', fmtN(d.modules.length), '', 'au moins une action'), kpi('Module le plus utilisé', top ? modName(top.module) : '—', '', top ? pct(top.share) + ' des actions' : 'aucune action')));
    const bars = d.modules.length ? h('div', { class: 'bars' }, d.modules.slice(0, 12).map((m) => { const b = h('i'); b.style.width = Math.max(3, Math.round((100 * m.events) / d.modules[0].events)) + '%'; return h('div', {}, h('span', {}, modName(m.module)), h('div', { class: 'tr' }, b), h('b', {}, fmtN(m.events))); })) : empty('grid', 'Aucune action sur la période', 'Les actions des clients dans leurs modules apparaîtront ici.');
    stack.append(h('div', { class: 'grid g-2' }, card('Actions par module', h('span', { class: 'sub' }, 'les 12 premiers'), bars),
      card('Activité par jour', h('span', { class: 'sub' }, 'toutes organisations'), A.charts.line({ labels: d.daily.days.map(A.fmtDay), values: d.daily.events, unit: 'actions', minTop: 4, int: true, name: 'Actions', title: 'Actions par jour sur ' + days + ' jours' }))));
    const t = table({ pageSize: 25, noun: 'modules', sort: { key: 'events', dir: 'desc' }, cols: [
      { key: 'module', label: 'Module', main: true, sort: (m) => modName(m.module), render: (m) => h('b', {}, modName(m.module)) },
      { key: 'events', label: 'Actions', cls: 'nw', render: (m) => h('span', { class: 'tnum' }, fmtN(m.events)) },
      { key: 'orgs', label: 'Organisations', cls: 'nw' }, { key: 'adoption', label: 'Adoption', cls: 'nw', render: (m) => pct(m.adoption) },
      { key: 'users', label: 'Personnes', cls: 'nw' }, { key: 'previous', label: 'Évolution', cls: 'nw', sort: (m) => m.events - m.previous, render: (m) => evo(m.events, m.previous) }],
      empty: empty('grid', 'Aucune donnée', '') });
    t.set(d.modules);
    stack.append(cardFlush('Détail par module', h('span', { class: 'sub' }, 'évolution par rapport aux ' + days + ' jours précédents'), t.el));
  }

  // ---------- Santé de la plateforme ----------
  const upt = (s) => { const d = Math.floor(s / 86400), hh = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60); return d ? d + ' j ' + hh + ' h' : hh ? hh + ' h ' + m + ' min' : m + ' min'; };
  async function healthView(main, ctx) {
    main.append(phead('Santé de la plateforme', 'État du serveur, de la base de données et des services, actualisé toutes les 15 secondes.'));
    const box = h('div', { class: 'stack' }, A.skRows(4)); main.append(box);
    const draw = async () => {
      let d; try { d = await api('/insights/health'); } catch (e) { return; }
      if (ctx.stale()) return;
      const V = { ok: ['Tout est opérationnel', 'ok'], warn: ['À surveiller', 'warn'], bad: ['Dégradé : agissez', 'bad'] }[d.verdict];
      box.replaceChildren(
        h('div', { class: 'note ' + (d.verdict === 'ok' ? 'ok' : d.verdict === 'bad' ? 'bad' : '') }, h('b', {}, V[0]), ' · mesuré ' + ago(d.now)),
        h('div', { class: 'grid g-kpi' }, kpi('En ligne depuis', upt(d.process.uptimeSec), '', 'Node ' + d.process.node), kpi('Base de données', String(d.db.latencyMs).replace('.', ','), 'ms', fmtN(d.db.sizeMB).replace(/^/, '') + ' Mo'), kpi('Réactivité du serveur', String(d.loopLagMs), 'ms', 'délai de la boucle d’événements'), kpi('Mémoire', fmtN(d.process.rssMB), 'Mo', 'dont ' + fmtN(d.process.heapMB) + ' Mo utilisés')),
        h('div', { class: 'grid g-2' },
          card('Services', null, d.services.map((x) => h('div', { class: 'sr-row' }, h('i', { class: 'dot ' + (x.ok ? '' : 'warn') }), h('b', {}, x.label), h('span', { class: 'v' }, x.text)))),
          card('Dernières 24 heures', null, [['Inscriptions', d.last24h.signups], ['Messages IA', d.last24h.aiMessages], ['Événements de sécurité graves', d.last24h.securityEvents], ['Inscriptions en attente de code', d.last24h.pendingSignups]].map(([l, v]) => h('div', { class: 'sr-row' }, h('b', {}, l), h('span', { class: 'v tnum' }, fmtN(v)))))),
        card('Volumes', null, h('div', { class: 'kv' }, [['Utilisateurs', d.volumes.users], ['Organisations', d.volumes.orgs], ['Actions enregistrées', d.volumes.activity], ['Lignes d’audit', d.volumes.audit]].map(([l, v]) => h('div', {}, h('small', {}, l), h('b', {}, fmtN(v)))))));
    };
    await draw();
    const iv = setInterval(draw, 15000); A.onLeave(() => clearInterval(iv));
  }

  // ---------- Abonnements à expirer ----------
  async function expiringView(main) {
    const days = S.expDays || 30;
    const win = A.select('Fenêtre', [[7, '7 prochains jours'], [14, '14 prochains jours'], [30, '30 prochains jours'], [60, '60 prochains jours']], days, (v) => { S.expDays = Number(v); A.refresh(); }); win.classList.add('sm');
    main.append(phead('Abonnements à expirer', 'Relancez à temps : chaque abonnement qui s’arrête, c’est un revenu récurrent en jeu. Le montant est celui du dernier paiement validé de la personne.', win));
    const d = await api('/insights/expiring?days=' + days);
    const stack = h('div', { class: 'stack' }); main.append(stack);
    stack.append(h('div', { class: 'grid g-kpi' }, kpi('À expirer', fmtN(d.list.length), '', 'dans les ' + days + ' jours'), kpi('Revenu en jeu', fmtN(d.atRiskXAF), 'FCFA', 'dernier paiement validé'), kpi('Expirés récemment', fmtN(d.lapsed.length), '', 'ces 14 derniers jours'), kpi('Dans la semaine', fmtN((d.buckets[0] || {}).n || 0), '', 'à relancer en priorité')));
    stack.append(card('Par échéance', null, h('div', { class: 'bars' }, d.buckets.map((b) => { const bar = h('i'); bar.style.width = Math.max(3, Math.round((100 * b.n) / Math.max(1, ...d.buckets.map((x) => x.n)))) + '%'; return h('div', {}, h('span', {}, b.label), h('div', { class: 'tr' }, bar), h('b', {}, b.n + (b.xaf ? ' · ' + fmtXAF(b.xaf) : ''))); }))));
    const msg = (u, gone) => 'Bonjour ' + u.name + ', votre abonnement MABAH ' + (gone ? 'a pris fin le ' : 'arrive à échéance le ') + fmtDate(u.planExpires) + '. Souhaitez-vous le renouveler ?';
    const link = (u, gone) => { const c = String(u.contact || ''); if (c.includes('@')) return h('a', { class: 'btn sm', href: 'mailto:' + c + '?subject=' + encodeURIComponent('Votre abonnement MABAH') + '&body=' + encodeURIComponent(msg(u, gone)) }, icon('contacts', 'sm'), 'Relancer par e-mail'); if (A.digits(c).length >= 8) return h('a', { class: 'btn sm', target: '_blank', rel: 'noopener', href: 'https://wa.me/' + A.digits(c) + '?text=' + encodeURIComponent(msg(u, gone)) }, 'Relancer sur WhatsApp'); return null; };
    const mk = (gone) => table({ pageSize: 25, noun: 'abonnements', sort: { key: 'planExpires', dir: gone ? 'desc' : 'asc' }, onRow: (u) => A.go('#/clients/' + u.id), cols: [
      { key: 'name', label: 'Abonné', main: true, render: (u) => h('div', { class: 'who' }, h('span', { class: 'av' }, initials(u.name)), h('div', {}, h('b', {}, u.name), h('small', {}, u.contact))) },
      { key: 'plan', label: 'Offre', render: (u) => planBadge(u.plan) }, { key: 'planExpires', label: gone ? 'A expiré le' : 'Expire le', cls: 'nw mu', render: (u) => fmtDate(u.planExpires) },
      { key: 'daysLeft', label: 'Reste', cls: 'nw', render: (u) => (gone ? badge('expiré', 'bad') : badge(u.daysLeft + ' j', u.daysLeft <= 7 ? 'bad' : u.daysLeft <= 14 ? 'warn' : 'ok')) },
      { key: 'lastPaidXAF', label: 'Dernier paiement', cls: 'nw r', render: (u) => (u.lastPaidXAF ? h('span', { class: 'tnum' }, fmtXAF(u.lastPaidXAF)) : '—') },
      { key: 'act', label: '', act: true, cls: 'r', render: (u) => link(u, gone) }],
      empty: empty(gone ? 'check' : 'clock', gone ? 'Aucun abonnement expiré récemment' : 'Aucun abonnement à expirer', gone ? '' : 'Rien à relancer sur cette période.') });
    const t1 = mk(false); t1.set(d.list); const t2 = mk(true); t2.set(d.lapsed);
    stack.append(cardFlush('À expirer (' + d.list.length + ')', null, t1.el), cardFlush('Expirés ces 14 derniers jours (' + d.lapsed.length + ')', h('span', { class: 'sub' }, 'à reconquérir'), t2.el));
  }

  // ---------- Posture de sécurité (haut de la page Sécurité) ----------
  const baseSecurity = A.views.security;
  async function securityWithPosture(main, ctx) {
    await baseSecurity(main, ctx);
    let d; try { d = await api('/insights/security'); } catch (e) { return; }
    if (ctx.stale()) return;
    const el = h('div', { class: 'stack', style: null }, h('div', { class: 'grid g-kpi' },
      kpi('Comptes avec 2FA', pct(d.twofa.rate), '', fmtN(d.twofa.users) + ' sur ' + fmtN(d.twofa.total) + ' · administrateur : ' + (d.twofa.admin ? 'protégé' : 'sans 2FA')),
      kpi('Échecs de connexion 24 h', fmtN(d.failures24h), '', fmtN(d.severe24h) + ' événement(s) grave(s)'), kpi('Comptes suspendus', fmtN(d.suspended), '', fmtN(d.activeSessions) + ' sessions actives'), kpi('Alertes ouvertes', fmtN(d.alertsOpen), '', fmtN(d.blocks) + ' adresse(s) bloquée(s)')),
      h('div', { class: 'grid g-2' }, card('Échecs de connexion, 7 jours', null, A.charts.bars({ labels: d.failuresDaily.days.map(A.fmtDay), values: d.failuresDaily.values, unit: 'échecs', minTop: 4, int: true, name: 'Échecs', title: 'Échecs de connexion par jour' , height: 200 })),
        card('Événements à surveiller, 7 jours', null, d.topActions.length ? d.topActions.map((t) => h('div', { class: 'sr-row' }, h('b', {}, t.action), h('span', { class: 'v tnum' }, fmtN(t.count)))) : empty('check', 'Rien à signaler', ''))));
    el.classList.add('mt');
    main.insertBefore(el, main.children[1] || null);
  }

  Object.assign(A.views, { modules: modulesView, health: healthView, expiring: expiringView, security: securityWithPosture });
})();
