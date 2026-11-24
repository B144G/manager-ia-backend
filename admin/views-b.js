'use strict';
// Écrans : paiements, alertes, organisations, offres, contacts, IA, notifications, paramètres, sécurité.
(function () {
  const A = window.A, { h, icon, fmtN, fmtXAF, fmtDate, fmtDateTime, ago, plural, initials, badge, planBadge, card, cardFlush, empty, table, ask, toast, fail, api, phead } = A;
  const S = A.S;

  // ---------- Paiements ----------
  const PAY_TABS = [['needs_review', 'Bloqués (encaissés)'], ['awaiting_validation', 'À vérifier'], ['pending', 'En attente'], ['paid', 'Validés'], ['failed', 'Refusés / échoués'], ['expired', 'Expirés'], ['', 'Tous']];
  async function paymentsView(main, ctx) {
    main.append(phead('Paiements', 'Mobile Money (validation à la main) et paiements automatiques Campay. Les paiements « à vérifier » ou bloqués en attente passent en premier.'));
    const hookNote = h('div', { class: 'note' });
    main.append(hookNote);
    api('/campay').then((c) => { S.campay = c; A.drawModeBar && A.drawModeBar(); if (!c.enabled) hookNote.replaceChildren(h('b', {}, 'Paiement automatique Campay inactif'), ' : renseignez CAMPAY_APP_USERNAME, CAMPAY_APP_PASSWORD et CAMPAY_WEBHOOK_KEY (voir docs/paiement-campay.md).'); else hookNote.replaceChildren(h('b', {}, 'Campay : ' + (c.test ? 'MODE TEST (démonstration)' : 'MODE RÉEL')), ' · clé du webhook ' + (c.hasWebhookKey ? 'présente' : 'ABSENTE') + ' · URL du webhook à déclarer chez Campay : ', h('span', { class: 'mono' }, c.webhookUrl)); }).catch(() => hookNote.remove());
    const statBox = h('div', { class: 'grid g-kpi' });
    const filt = h('div', { class: 'pay-filters' });
    const tabs = h('div', { class: 'tabs', role: 'tablist' });
    const q = A.searchBox('Rechercher : nom, contact, référence, ID de transaction…', (v) => { S.payQ = v; run(); }, S.payQ);
    const tbl = table({
      pageSize: 25, noun: 'paiements', sort: null, rowKey: (p) => p.id,
      cols: [
        { key: 'created', label: 'Date', cls: 'nw mu', render: (p) => fmtDateTime(p.created) },
        { key: 'user', label: 'Client', main: true, sort: (p) => p.user.name, render: (p) => h('div', { class: 'who' }, h('span', { class: 'av' }, initials(p.user.name)), h('div', {}, h('button', { class: 'link', type: 'button', onclick: () => A.go('#/clients/' + p.user.id) }, p.user.name), h('small', {}, p.user.contact))) },
        { key: 'planName', label: 'Offre et durée', render: (p) => h('div', {}, p.planName, p.durationDays ? h('small', { class: 'muted' }, ' · ' + p.durationDays + ' jours') : null) },
        { key: 'amountXAF', label: 'Montant', cls: 'nw', render: (p) => h('b', { class: 'tnum' }, fmtXAF(p.amountXAF)) },
        { key: 'operator', label: 'Opérateur et numéro', cls: 'mu', render: (p) => (A.OPERATOR[p.operator] || p.operator || '—') + (p.phone ? ' · ' + p.phone : '') },
        { key: 'reference', label: 'Référence et ID', render: (p) => h('div', {}, h('b', { class: 'mono' }, p.reference), p.testMode ? h('span', { class: 'badge warn' }, ' TEST') : null, h('small', { class: 'muted' }, ' ' + (p.transactionId ? 'ID : ' + p.transactionId + (p.payerName ? ' · payeur : ' + p.payerName : '') : p.mode === 'push' ? 'Paiement automatique' + (p.operatorRef ? ' · ' + p.operatorRef : '') : 'ID pas encore saisi')), p.paidVia ? h('small', { class: 'muted' }, ' confirmé par ' + ({ webhook: 'webhook', reconciliation: 'réconciliation', admin: 'administrateur', poll: 'suivi', suivi: 'suivi' }[p.paidVia] || p.paidVia)) : null) },
        { key: 'status', label: 'Statut', render: (p) => h('div', {}, A.payBadge(p.status), p.status === 'failed' && p.rejectReason ? h('small', { class: 'muted' }, ' Motif : ' + p.rejectReason) : null, p.decidedAt ? h('small', { class: 'muted' }, ' ' + fmtDateTime(p.decidedAt)) : null, p.stuck ? h('small', { class: 'muted' }, ' bloqué : en attente depuis plus de ' + 'quelques minutes') : null, p.lastError && p.status !== 'paid' ? h('small', { class: 'muted' }, ' ' + p.lastError) : null, p.adminNote ? h('small', { class: 'muted' }, ' Motif admin : ' + p.adminNote) : null, p.decidedBy ? h('small', { class: 'muted' }, ' par ' + p.decidedBy) : null) },
        { key: 'act', label: '', act: true, cls: 'r', render: (p) => h('div', { class: 'row' }, A.payButtons(p)) },
      ],
      empty: empty('payments', S.payFilter === 'awaiting_validation' ? 'Aucun paiement à valider' : 'Aucun paiement', S.payFilter === 'awaiting_validation' ? 'Tout est à jour.' : ''),
    });
    const box = h('section', { class: 'card' }, h('div', { class: 'toolbar' }, q.el), filt, h('div', { class: 'cb flush' }, A.skRows(5)));
    main.append(statBox, tabs, box);
    const opSel = h('select', { class: 'select', 'aria-label': 'Opérateur', onchange: (e) => { S.payOp = e.target.value; run(); } }, [['', 'Tous les opérateurs'], ['mtn', 'MTN Mobile Money'], ['orange', 'Orange Money']].map(([v, l]) => h('option', { value: v, selected: (S.payOp || '') === v ? '' : null }, l)));
    const dFrom = h('input', { class: 'input', type: 'date', value: S.payFrom || '', 'aria-label': 'Du', onchange: (e) => { S.payFrom = e.target.value; run(); } });
    const dTo = h('input', { class: 'input', type: 'date', value: S.payTo || '', 'aria-label': 'Au', onchange: (e) => { S.payTo = e.target.value; run(); } });
    filt.append(opSel, h('label', {}, 'Du', dFrom), h('label', {}, 'au', dTo));
    let seq = 0;
    async function run() {
      const my = ++seq;
      try {
        const { payments, counts, stats, campay } = await api('/payments?status=' + encodeURIComponent(S.payFilter) + '&q=' + encodeURIComponent(S.payQ || '') + '&operator=' + encodeURIComponent(S.payOp || '') + '&from=' + encodeURIComponent(S.payFrom || '') + '&to=' + encodeURIComponent(S.payTo || ''));
        if (my !== seq || ctx.stale()) return;
        tabs.replaceChildren(...PAY_TABS.map(([k, l]) => h('button', { type: 'button', role: 'tab', 'aria-selected': S.payFilter === k ? 'true' : 'false', onclick: () => { S.payFilter = k; A.refresh(); } }, l, k === '' ? null : h('span', { class: 'cnt' + ((k === 'awaiting_validation' || k === 'needs_review') && counts[k] ? ' hot' : '') }, String(counts[k] || 0)))));
        if (campay) { S.campay = campay; A.drawModeBar && A.drawModeBar(); }
        if (stats) statBox.replaceChildren(
          h('div', { class: 'card kpi' }, h('div', { class: 'l' }, 'Encaissé (réel)'), h('div', { class: 'v tnum' }, fmtXAF(stats.paidXAF)), h('small', { class: 'muted' }, 'ce mois : ' + fmtXAF(stats.paidMonthXAF) + (stats.paidTestXAF ? ' · test (sans argent) : ' + fmtXAF(stats.paidTestXAF) : ''))),
          h('div', { class: 'card kpi' }, h('div', { class: 'l' }, 'Payés'), h('div', { class: 'v tnum' }, String(stats.paidCount))),
          h('div', { class: 'card kpi' }, h('div', { class: 'l' }, 'Échoués ou expirés'), h('div', { class: 'v tnum' }, String(stats.failedCount))),
          h('div', { class: 'card kpi' }, h('div', { class: 'l' }, 'En attente'), h('div', { class: 'v tnum' }, String(stats.pendingCount)), stats.stuckCount ? h('small', { class: 'muted' }, stats.stuckCount + ' bloqué(s) : revérifiez chez Campay') : null),
          stats.reviewCount ? h('div', { class: 'card kpi' }, h('div', { class: 'l' }, 'Encaissés à vérifier'), h('div', { class: 'v tnum' }, String(stats.reviewCount)), h('small', { class: 'muted' }, 'argent reçu, offre non activée')) : null);
        tbl.set(payments); box.children[2].replaceChildren(tbl.el);
      } catch (e) { fail(e); }
    }
    run();
    A.onLeave(A.live.on('summary', () => run()));
  }

  // ---------- Alertes ----------
  const SEV_KIND = { high: 'bad', medium: 'warn', low: '' };
  const THRESH_LABEL = { loginFails: 'Échecs de connexion sur un compte', loginWindowMin: '…en (minutes)', sessionIps: 'Adresses différentes sur un compte', sessionWindowH: '…en (heures)', signupsPerIp: 'Inscriptions depuis une même adresse', signupWindowH: '…en (heures)', aiPerHour: 'Messages IA en 1 heure', aiPerDay: 'Messages IA en 24 heures', payRejects: 'Paiements refusés', payWindowD: '…en (jours)', abuseWindowH: 'Blocages d’adresses récents (heures)', cooldownH: 'Pas de nouvelle alerte identique pendant (heures)' };
  const THRESH_ENV = { loginFails: 'ALERT_LOGIN_FAILS', loginWindowMin: 'ALERT_LOGIN_WINDOW_MIN', sessionIps: 'ALERT_SESSION_IPS', sessionWindowH: 'ALERT_SESSION_WINDOW_H', signupsPerIp: 'ALERT_SIGNUPS_PER_IP', signupWindowH: 'ALERT_SIGNUP_WINDOW_H', aiPerHour: 'ALERT_AI_PER_HOUR', aiPerDay: 'ALERT_AI_PER_DAY', payRejects: 'ALERT_PAY_REJECTS', payWindowD: 'ALERT_PAY_WINDOW_D', abuseWindowH: 'ALERT_ABUSE_WINDOW_H', cooldownH: 'ALERT_COOLDOWN_HOURS' };
  async function alertsView(main) {
    const st = S.alertStatus || 'open';
    main.append(phead('Alertes', 'Activité suspecte repérée automatiquement toutes les 10 minutes. Vous êtes aussi prévenu par e-mail pour les alertes de gravité haute.'));
    const { alerts, counts, thresholds } = await api('/alerts?status=' + st);
    main.append(h('div', { class: 'tabs', role: 'tablist' }, [['open', 'Ouvertes'], ['handled', 'Traitées']].map(([k, l]) => h('button', { type: 'button', role: 'tab', 'aria-selected': st === k ? 'true' : 'false', onclick: () => { S.alertStatus = k; A.refresh(); } }, l, k === 'open' ? h('span', { class: 'cnt' + (counts.open ? ' hot' : '') }, String(counts.open)) : null))));
    const stack = h('div', { class: 'stack' }); main.append(stack);
    stack.append(cardFlush(st === 'open' ? 'Alertes ouvertes' : 'Alertes traitées', null, alerts.length ? h('div', { class: 'list' }, alerts.map((a) => h('div', { class: 'li' },
      h('i', { class: 'dot ' + (a.severity === 'high' ? 'bad' : a.severity === 'medium' ? 'warn' : 'off') }),
      h('div', { class: 't' }, h('div', { class: 'row' }, badge('Gravité ' + a.severityLabel.toLowerCase(), SEV_KIND[a.severity] || ''), h('span', { class: 'muted' }, a.kindLabel + (a.mailed ? ' · e-mail envoyé' : ''))), h('b', {}, a.title), h('small', {}, a.detail), h('small', {}, 'Repérée ' + ago(a.createdAt) + (a.handledAt ? ' · traitée ' + ago(a.handledAt) : ''))),
      h('div', { class: 'row' }, a.user ? h('button', { class: 'btn sm', type: 'button', onclick: () => A.go('#/clients/' + a.user.id) }, 'Voir le client : ' + a.user.name) : null,
        a.handledAt ? null : h('button', { class: 'btn sm primary', type: 'button', onclick: async () => { try { await api('/alerts/' + a.id + '/handle', { method: 'POST', body: {} }); toast('Alerte marquée comme traitée.', 'ok'); await A.reload(); } catch (e) { fail(e); } } }, 'Marquer comme traitée'))))) : empty('check', st === 'open' ? 'Aucune alerte' : 'Aucune alerte traitée', st === 'open' ? 'Rien de suspect pour l’instant.' : '')));
    stack.append(card('Seuils de détection', h('span', { class: 'sub' }, 'modifiables par variables d’environnement'), Object.entries(thresholds).map(([k, v]) => h('div', { class: 'sr-row' }, h('b', {}, THRESH_LABEL[k] || k), h('span', { class: 'v' }, v + '  ·  ' + THRESH_ENV[k])))));
  }

  // ---------- Organisations ----------
  async function orgsView(main) {
    main.append(phead('Organisations', 'Les entreprises créées par vos utilisateurs.'));
    const { orgs } = await api('/orgs');
    let filter = '';
    const waCell = (o) => {
      const st = (o.wa && o.wa.status) || 'disconnected';
      if (st === 'disconnected') return h('span', { class: 'muted' }, A.WA_LABEL.disconnected);
      return h('div', { class: 'row' }, h('span', {}, A.WA_LABEL[st] || st, o.wa.number ? h('small', { class: 'muted' }, ' +' + o.wa.number.replace(/\D/g, '')) : null), h('button', { class: 'btn sm', type: 'button', onclick: async () => { const r = await ask({ title: 'Déconnecter ce WhatsApp ?', lines: ['La session de « ' + o.name + ' » sera fermée et le client devra rescanner le QR code.'], confirmText: 'Oui, déconnecter', danger: true }); if (!r) return; try { await api('/security/orgs/' + o.id + '/wa-disconnect', { method: 'POST', body: {} }); toast('WhatsApp de ' + o.name + ' déconnecté.', 'ok'); A.refresh(); } catch (e) { fail(e); } } }, 'Déconnecter'));
    };
    const tbl = table({ pageSize: 25, noun: 'organisations', sort: null, cols: [
      { key: 'name', label: 'Organisation', main: true, render: (o) => h('div', { class: 'who' }, h('span', { class: 'av' }, initials(o.name)), h('div', {}, h('b', {}, o.name), h('small', {}, o.sector || '—'))) },
      { key: 'owner', label: 'Propriétaire', render: (o) => h('div', {}, o.owner, h('small', { class: 'muted' }, ' ' + o.ownerContact)) },
      { key: 'plan', label: 'Offre', render: (o) => planBadge(o.plan) },
      { key: 'members', label: 'Équipe', cls: 'nw' }, { key: 'branches', label: 'Antennes', cls: 'nw' },
      { key: 'wa', label: 'WhatsApp', sort: false, render: waCell },
      { key: 'lastActivity', label: 'Dernière activité', cls: 'nw mu', render: (o) => (o.lastActivity ? ago(o.lastActivity) : '—') },
      { key: 'created', label: 'Créée', cls: 'nw mu', render: (o) => fmtDate(o.created) }],
      empty: empty('orgs', 'Aucune organisation', 'Les entreprises créées par vos utilisateurs apparaîtront ici.') });
    const apply = () => tbl.set(orgs.filter((o) => !filter || (o.name + ' ' + o.owner + ' ' + o.ownerContact + ' ' + (o.sector || '')).toLowerCase().includes(filter)));
    apply();
    main.append(h('section', { class: 'card' }, h('div', { class: 'toolbar' }, A.searchBox('Rechercher une organisation ou un propriétaire…', (v) => { filter = v.toLowerCase(); apply(); }).el), h('div', { class: 'cb flush' }, tbl.el)));
  }

  // ---------- Offres et abonnements ----------
  async function plansView(main) {
    main.append(phead('Offres et abonnements', 'Abonnés payants et dates d’échéance. Les prix viennent de la configuration du serveur.'));
    const PLANS = ['Pro', 'Pro Max', 'Méga Pro', 'Illimité'];
    const [ov, ...res] = await Promise.all([S.ov ? Promise.resolve(S.ov) : api('/overview?days=' + S.days), ...PLANS.map((n) => api('/users?plan=' + encodeURIComponent(n)))]);
    const cat = ov.catalog, P = ov.plans;
    const list = res.flatMap((r) => r.users).sort((x, y) => String(x.planExpires || '9').localeCompare(String(y.planExpires || '9')));
    const price = (n) => { const s = cat.sold.find((x) => x.name === n && x.period === 'month'); if (s) return fmtXAF(s.priceXAF) + ' / ' + s.periodLabel; const l = cat.legacy.find((x) => x.name === n); return l ? fmtXAF(l.priceXAF) + ' / mois · ancienne offre' : ''; };
    const stack = h('div', { class: 'stack' }); main.append(stack);
    stack.append(h('div', { class: 'grid g-kpi' }, [['Gratuit', 'Aucun paiement']].concat(PLANS.filter((n) => n === 'Illimité' || (P[n] || 0) > 0).map((n) => [n, price(n)])).map(([n, s]) => h('div', { class: 'card kpi' }, h('div', { class: 'l' }, n), h('div', { class: 'v' }, fmtN(P[n] || 0)), h('span'), h('div', { class: 'd' }, s)))));
    stack.append(cardFlush('Offres en vente', h('span', { class: 'sub' }, 'Illimité, selon la durée'), table({ pageSize: 10, pager: false, sort: null, noun: 'offres', cols: [
      { key: 'name', label: 'Offre', main: true, render: (p) => planBadge(p.name) }, { key: 'periodLabel', label: 'Durée', render: (p) => p.periodLabel.replace(/^./, (c) => c.toUpperCase()) },
      { key: 'days', label: 'Jours', cls: 'nw' }, { key: 'priceXAF', label: 'Prix', cls: 'nw r', render: (p) => h('b', { class: 'tnum' }, fmtXAF(p.priceXAF)) }], rows: cat.sold }).el));
    const tbl = table({ pageSize: 25, noun: 'abonnés', sort: { key: 'planExpires', dir: 'asc' }, onRow: (u) => A.go('#/clients/' + u.id), cols: [
      { key: 'name', label: 'Abonné', main: true, render: (u) => h('div', { class: 'who' }, h('span', { class: 'av' }, initials(u.name)), h('div', {}, h('b', {}, u.name), h('small', {}, u.contact))) },
      { key: 'plan', label: 'Offre', render: (u) => planBadge(u.plan) }, { key: 'planExpires', label: 'Expire le', cls: 'nw mu', sort: (u) => u.planExpires || '9', render: (u) => fmtDate(u.planExpires) },
      { key: 'left', label: 'Reste', sort: (u) => (u.planExpires ? new Date(u.planExpires).getTime() : 1e15), cls: 'nw', render: (u) => { const d = u.planExpires ? Math.ceil((new Date(u.planExpires) - Date.now()) / 86400000) : null; return d === null ? '—' : badge(d < 0 ? 'expiré' : d + ' j', d < 0 ? 'bad' : d <= 7 ? 'warn' : 'ok'); } }],
      empty: empty('plans', 'Aucun abonné payant', 'Les abonnés apparaîtront ici dès leur premier paiement validé.') });
    tbl.set(list);
    stack.append(cardFlush('Abonnés (' + list.length + ')', null, tbl.el));
  }

  // ---------- Contacts reçus ----------
  const LEAD_STATUS = [['new', 'Nouveau'], ['contacted', 'Contacté'], ['trial', 'En essai'], ['client', 'Client'], ['lost', 'Perdu']];
  function contactLinks(contact, text) {
    const c = String(contact || '');
    if (c.includes('@')) return h('a', { class: 'btn sm', href: 'mailto:' + c + '?subject=' + encodeURIComponent('MABAH') + '&body=' + encodeURIComponent(text) }, icon('contacts', 'sm'), 'E-mail');
    if (A.digits(c).length >= 8) return h('a', { class: 'btn sm', target: '_blank', rel: 'noopener', href: 'https://wa.me/' + A.digits(c) + '?text=' + encodeURIComponent(text) }, 'WhatsApp');
    return null;
  }
  function visitsCard(v) {
    const bars = (rows, key) => (rows.length ? h('div', { class: 'bars' }, rows.map((r) => { const bar = h('i'); bar.style.width = Math.max(4, Math.round((100 * r.n) / rows[0].n)) + '%'; return h('div', {}, h('span', {}, r[key] === '/' ? 'Accueil' : r[key]), h('div', { class: 'tr' }, bar), h('b', {}, fmtN(r.n))); })) : h('p', { class: 'muted' }, 'Pas encore de visite.'));
    return card('Visites du site (' + v.days + ' jours)', h('span', { class: 'sub' }, fmtN(v.total) + (v.total > 1 ? ' pages vues' : ' page vue')),
      h('p', { class: 'muted' }, 'Comptage anonyme : ni adresse, ni cookie, ni identifiant. On sait combien de pages sont lues et d’où viennent les gens, jamais qui ils sont.'),
      h('div', { class: 'grid g-3 mt' }, h('div', {}, h('h3', {}, 'Origines'), h('div', { class: 'mt' }, bars(v.sources, 'source'))), h('div', {}, h('h3', {}, 'Pages lues'), h('div', { class: 'mt' }, bars(v.pages, 'path'))), h('div', {}, h('h3', {}, 'Appareils'), h('div', { class: 'mt' }, bars(v.devices, 'device')))));
  }
  async function contactsView(main) {
    main.append(phead('Contacts reçus', 'Personnes qui ont laissé leurs coordonnées (formulaire, essai gratuit) : suivez chacune jusqu’au client.'));
    const [{ leads }, vis] = await Promise.all([api('/leads'), api('/visits')]);
    const stack = h('div', { class: 'stack' }); main.append(stack);
    stack.append(visitsCard(vis));
    const counts = LEAD_STATUS.map(([k, t]) => t + ' : ' + leads.filter((l) => l.status === k).length).join(' · ');
    const items = leads.length ? h('div', { class: 'list' }, leads.map((l) => {
      const sel = h('select', { class: 'select sm', 'aria-label': 'Étape de suivi' }, LEAD_STATUS.map(([k, t]) => h('option', { value: k, selected: l.status === k ? '' : null }, t)));
      const notes = h('input', { class: 'input sm', type: 'text', maxlength: '1000', placeholder: 'Notes (ex. appelé le lundi, veut une démo)', value: l.notes || '', 'aria-label': 'Notes' });
      const follow = !l.consent ? 'Pas de consentement : aucune relance automatique' : l.unsubscribed ? 'Désinscrit des relances' : !l.email ? 'Pas d’e-mail : pas de relance automatique' : l.status === 'client' || l.status === 'lost' || l.status === 'trial' ? 'Relances arrêtées (suivi manuel)' : l.followStage >= 3 ? 'Les 3 relances ont été envoyées' : 'Relances envoyées : ' + l.followStage + '/3' + (l.nextFollow ? ' · prochaine ' + fmtDateTime(l.nextFollow) : '');
      return h('div', { class: 'li' }, h('i', { class: 'dot ' + (l.status === 'new' ? 'bad' : l.status === 'client' ? '' : 'warn') }),
        h('div', { class: 't' }, h('b', {}, l.name + (l.what ? ' · ' + l.what : '')), h('small', {}, l.message || ''), h('small', {}, (l.contact || 'Sans contact') + (l.source ? ' · via ' + l.source : '') + ' · ' + fmtDateTime(l.created)), h('small', {}, follow),
          h('div', { class: 'row mt' }, contactLinks(l.contact, 'Bonjour ' + l.name + ', merci pour votre message.'), sel, notes, h('button', { class: 'btn sm primary', type: 'button', onclick: async () => { try { await api('/leads/' + l.id + '/status', { method: 'POST', body: { status: sel.value, notes: notes.value } }); toast('Suivi enregistré.', 'ok'); await A.reload(); } catch (e) { fail(e); } } }, 'Enregistrer'))), h('span'));
    })) : empty('contacts', 'Aucune demande de contact', 'Les demandes du formulaire du site arrivent ici.');
    stack.append(cardFlush('Demandes (' + leads.length + ')', h('span', { class: 'sub' }, leads.length ? counts : ''), items));
  }

  // ---------- Utilisation de l'IA ----------
  async function aiView(main) {
    main.append(phead("Utilisation de l'IA", 'Messages envoyés à l’IA de l’espace de travail, sur 14 jours.'));
    const u = await api('/ai-usage');
    main.append(h('div', { class: 'grid g-21' },
      card('Messages par jour', h('span', { class: 'sub' }, fmtN(u.total) + ' au total'), A.charts.bars({ labels: u.days.map((d) => A.fmtDay(d.day)), values: u.days.map((d) => d.count), unit: 'messages', minTop: 4, int: true, name: 'Messages', title: 'Messages IA par jour sur 14 jours' })),
      card('Organisations les plus actives', null, u.top.length ? h('div', { class: 'list' }, u.top.map((o) => h('div', { class: 'li' }, h('span', { class: 'av' }, initials(o.name)), h('div', { class: 't' }, h('b', {}, o.name)), h('b', { class: 'tnum' }, fmtN(o.count) + ' msg')))) : empty('ai', 'Aucune utilisation pour l’instant', ''),
        h('p', { class: 'muted mt' }, u.enabled ? 'IA connectée (' + u.model + ').' : 'IA non configurée : ajoutez ANTHROPIC_API_KEY.'))));
  }

  // ---------- Notifications ----------
  async function notifsView(main) {
    main.append(phead('Notifications', 'Inscriptions, contacts, paiements : ce que le serveur vous a signalé.'));
    const { notifications } = await api('/notifications');
    const types = [...new Set(notifications.map((n) => n.type))];
    let filter = '';
    const host = h('div', {});
    const draw = () => {
      const rows = notifications.filter((n) => !filter || n.type === filter);
      host.replaceChildren(rows.length ? h('div', { class: 'list' }, rows.map((n) => h('div', { class: 'li' }, h('i', { class: 'dot off' }), h('div', { class: 't' }, h('b', {}, n.text), h('small', {}, n.type + ' · ' + (n.channels.length ? n.channels.join(', ') : 'aucun canal'))), h('span', { class: 'muted' }, fmtDateTime(n.created))))) : empty('notifications', 'Aucune notification', ''));
    };
    draw();
    main.append(h('section', { class: 'card' }, h('div', { class: 'toolbar' }, A.select('Type', [['', 'Tous les types'], ...types.map((t) => [t, t])], '', (v) => { filter = v; draw(); })), host));
  }

  // ---------- Paramètres ----------
  async function settingsView(main) {
    main.append(phead('Paramètres', 'État de la configuration du serveur (aucun secret n’est affiché).'));
    const s = await api('/settings');
    const stack = h('div', { class: 'stack' }); main.append(stack);
    stack.append(h('div', { class: 'grid g-2' },
      card('Services connectés', null, s.system.map((x) => h('div', { class: 'sr-row' }, h('i', { class: 'dot ' + (x.status === 'ok' ? '' : 'warn') }), h('b', {}, x.label), h('span', { class: 'v' }, x.text)))),
      card('Offres en vente', h('span', { class: 'sub' }, 'durée habituelle : ' + s.plans.durationDays + ' jours'), s.catalog.sold.map((p) => h('div', { class: 'sr-row' }, h('b', {}, p.name + ' · ' + p.periodLabel), h('span', { class: 'v tnum' }, fmtXAF(p.priceXAF)))), h('p', { class: 'muted mt' }, 'Les prix se modifient dans les variables d’environnement (voir le README).'))));
    stack.append(card('Limites des offres', null, h('div', { class: 'tw' }, h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, ['Offre', 'Organisations', 'Personnes', 'Antennes', 'Messages IA / mois'].map((t) => h('th', {}, t)))),
      h('tbody', {}, Object.entries(s.workspaceLimits).map(([n, l]) => h('tr', {}, h('td', { class: 'main-c' }, h('b', {}, n)), h('td', { 'data-label': 'Organisations' }, l.orgs), h('td', { 'data-label': 'Personnes' }, l.members), h('td', { 'data-label': 'Antennes' }, l.branches), h('td', { 'data-label': 'Messages IA / mois' }, fmtN(l.aiMonth)))))))));
  }

  // ---------- Sécurité : état, double authentification, journal d'audit, adresses bloquées, sessions ----------
  const SEV = { info: ['Info', ''], warn: ['Attention', 'warn'], high: ['Grave', 'bad'], critical: ['Critique', 'bad'] };
  const sevBadge = (s) => badge(SEV[s] ? SEV[s][0] : s, SEV[s] ? SEV[s][1] : '');
  async function securityView(main, ctx) {
    main.append(phead('Sécurité', 'Le centre de contrôle : configuration, accès, journal d’audit et protections automatiques.'));
    const box = h('div', { class: 'stack' }, A.skRows(5));
    main.append(box);
    const reload = async () => {
      let o;
      try { o = await api('/security/overview'); } catch (e) { fail(e); return; }
      if (ctx.stale()) return;
      const sm = o.config.summary;
      const kpi = (t, v, sub, bad) => h('div', { class: 'card kpi' }, h('div', { class: 'l' }, t), h('div', { class: 'v' }, String(v)), h('span'), h('div', { class: 'd' }, bad ? badge(sub, 'bad') : sub));
      const lvl = (l) => h('i', { class: 'dot ' + (l === 'ok' ? '' : l === 'bad' ? 'bad' : 'warn') });
      const cfg = card('Configuration de sécurité', h('span', { class: 'sub' }, sm.ok + ' ok · ' + sm.warn + ' à améliorer · ' + sm.bad + ' dangereux'), o.config.items.map((x) => h('div', { class: 'sr-row stk' }, lvl(x.level), h('b', {}, x.title), h('span', { class: 'v' }, x.text))));
      const tfaBox = h('div', {});
      const drawTfa = () => {
        tfaBox.replaceChildren();
        if (o.twofa.enabled) {
          const pw = h('input', { class: 'input', type: 'password', placeholder: 'Mot de passe administrateur', autocomplete: 'current-password', 'aria-label': 'Mot de passe administrateur' }); const cd = h('input', { class: 'input', placeholder: 'Code ou code de secours', autocomplete: 'one-time-code', 'aria-label': 'Code' });
          tfaBox.append(h('p', {}, badge('Active', 'ok'), ' ' + o.twofa.recoveryLeft + ' code(s) de secours restant(s).'),
            h('div', { class: 'stack mt' }, pw, cd, h('div', { class: 'row' }, h('button', { class: 'btn danger-o', type: 'button', onclick: async () => { try { await api('/security/2fa/disable', { method: 'POST', body: { password: pw.value, code: cd.value } }); toast('Double authentification désactivée.', 'ok'); reload(); } catch (e) { fail(e); } } }, 'Désactiver'))));
        } else {
          const pw = h('input', { class: 'input', type: 'password', placeholder: 'Mot de passe administrateur', autocomplete: 'current-password', 'aria-label': 'Mot de passe administrateur' });
          tfaBox.append(h('p', { class: 'muted' }, 'Non activée : un mot de passe volé suffirait à entrer. Utilisez une application d’authentification (Google Authenticator, Microsoft Authenticator, Authy, 2FAS…).'),
            h('div', { class: 'stack mt' }, pw, h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'button', onclick: async () => {
              try {
                const j = await api('/security/2fa/setup', { method: 'POST', body: { password: pw.value } });
                const cd = h('input', { class: 'input', placeholder: 'Code à 6 chiffres', inputmode: 'numeric', autocomplete: 'one-time-code', 'aria-label': 'Code à 6 chiffres' });
                tfaBox.replaceChildren(h('p', {}, 'Dans votre application, ajoutez un compte avec cette clé (saisie manuelle, type « basé sur le temps ») :'), h('p', { class: 'pre mt' }, j.secret),
                  h('p', { class: 'muted mt' }, 'Ou ouvrez ce lien sur le téléphone qui a l’application : ', h('a', { href: j.uri }, 'ajouter automatiquement')),
                  h('div', { class: 'stack mt' }, cd, h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'button', onclick: async () => {
                    try {
                      const r = await api('/security/2fa/enable', { method: 'POST', body: { code: cd.value } });
                      tfaBox.replaceChildren(h('p', {}, h('b', {}, 'Activée.'), ' Notez ces codes de secours (chacun sert une fois, ils ne seront plus affichés) :'), h('pre', { class: 'pre mt' }, r.recoveryCodes.join('\n')), h('div', { class: 'row mt' }, h('button', { class: 'btn primary', type: 'button', onclick: reload }, 'J’ai noté mes codes')));
                    } catch (e) { fail(e); }
                  } }, 'Confirmer et activer'))));
              } catch (e) { fail(e); }
            } }, 'Activer'))));
        }
      };
      drawTfa();
      // Journal d'audit
      const sev = h('select', { class: 'select', 'aria-label': 'Gravité' }, h('option', { value: '' }, 'Toutes gravités'), ['info', 'warn', 'high', 'critical'].map((k) => h('option', { value: k }, SEV[k][0])));
      const act = A.searchBox('Action (ex. login, admin, apikey)', () => loadAudit()), q = A.searchBox('Adresse, cible, détail…', () => loadAudit());
      const auditTbl = table({ pageSize: 25, noun: 'événements', sort: null, cols: [
        { key: 'at', label: 'Quand', cls: 'nw mu', render: (e) => fmtDateTime(e.at) }, { key: 'severity', label: 'Gravité', render: (e) => sevBadge(e.severity) },
        { key: 'action', label: 'Action', main: true, render: (e) => h('b', {}, e.action) },
        { key: 'actorType', label: 'Qui', cls: 'mu', render: (e) => e.actorType + (e.actorId ? ' #' + e.actorId : '') + (e.orgId ? ' · org ' + e.orgId : '') },
        { key: 'target', label: 'Cible / détail', sort: false, cls: 'mu', render: (e) => [e.target, e.detail].filter(Boolean).join(' · ') }, { key: 'ip', label: 'Adresse', cls: 'mu' }],
        empty: empty('security', 'Aucun événement', '') });
      const verifyOut = h('span', { class: 'sub' });
      const loadAudit = async () => {
        try { const { events } = await api('/security/audit?limit=200&severity=' + encodeURIComponent(sev.value) + '&q=' + encodeURIComponent(q.input.value) + '&action=' + encodeURIComponent(act.input.value)); auditTbl.set(events); } catch (e) { fail(e); }
      };
      sev.addEventListener('change', loadAudit);
      const audit = h('section', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', {}, 'Journal d’audit'), h('div', { class: 'row' }, verifyOut, h('button', { class: 'btn sm', type: 'button', onclick: async () => { verifyOut.textContent = 'Vérification…'; try { const r = await api('/security/audit/verify', { method: 'POST', body: {} }); verifyOut.textContent = r.ok ? '✔ Chaîne intacte (' + r.checked + ' lignes)' : '✖ Chaîne ROMPUE à la ligne ' + r.brokenAt; } catch (e) { fail(e); } } }, 'Vérifier l’intégrité'))),
        h('div', { class: 'toolbar' }, sev, act.el, q.el), h('div', { class: 'cb flush' }, auditTbl.el));
      loadAudit();
      // Adresses bloquées
      const ip = h('input', { class: 'input', placeholder: 'Adresse IP', 'aria-label': 'Adresse IP' }); const hrs = h('input', { class: 'input', type: 'number', value: '24', min: '1', 'aria-label': 'Heures' }); const why = h('input', { class: 'input', placeholder: 'Motif', 'aria-label': 'Motif' });
      const blocksTbl = table({ pageSize: 10, pager: false, sort: null, cols: [
        { key: 'ip', label: 'Adresse', main: true, render: (b) => h('b', {}, b.ip) }, { key: 'reason', label: 'Motif', cls: 'mu' }, { key: 'blockedUntil', label: 'Jusqu’à', cls: 'nw mu', render: (b) => (b.permanent ? 'définitivement' : fmtDateTime(b.blockedUntil)) }, { key: 'createdBy', label: 'Par', cls: 'mu' },
        { key: 'act', label: '', act: true, cls: 'r', render: (b) => h('button', { class: 'btn sm', type: 'button', onclick: async () => { try { await api('/security/blocks/' + encodeURIComponent(b.ip), { method: 'DELETE' }); toast('Adresse débloquée.', 'ok'); reload(); } catch (e) { fail(e); } } }, 'Débloquer') }],
        empty: empty('check', 'Aucune adresse bloquée', '') });
      blocksTbl.set(o.blocks);
      const blocks = card('Adresses bloquées', h('span', { class: 'sub' }, 'Blocage automatique après des abus répétés'), blocksTbl.el,
        h('div', { class: 'stack mt' }, ip, hrs, why, h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'button', onclick: async () => { try { await api('/security/blocks', { method: 'POST', body: { ip: ip.value, hours: Number(hrs.value), reason: why.value } }); toast('Adresse bloquée.', 'ok'); reload(); } catch (e) { fail(e); } } }, 'Bloquer'))));
      const sess = card('Sessions administrateur', h('span', { class: 'sub' }, o.activeUserSessions + ' session(s) utilisateur active(s)'),
        o.sessions.map((s) => h('div', { class: 'sr-row' }, h('b', {}, s.device + (s.current ? ' (cette session)' : '')), h('span', { class: 'muted' }, s.ip + ' · active ' + ago(s.lastSeen)), s.current ? null : h('span', { class: 'v' }, h('button', { class: 'btn sm', type: 'button', onclick: async () => { try { await api('/security/sessions/' + s.id, { method: 'DELETE' }); reload(); } catch (e) { fail(e); } } }, 'Fermer')))),
        o.sessions.length > 1 ? h('div', { class: 'row mt' }, h('button', { class: 'btn sm', type: 'button', onclick: async () => { try { const r = await api('/security/sessions/revoke-others', { method: 'POST', body: {} }); toast(r.closed + ' session(s) fermée(s).', 'ok'); reload(); } catch (e) { fail(e); } } }, 'Fermer toutes les autres sessions')) : null,
        h('p', { class: 'muted mt' }, 'Compte utilisateur suspect : ouvrez sa fiche dans « Clients » et utilisez « Déconnecter partout ».'));
      box.replaceChildren(
        h('div', { class: 'grid g-kpi' }, kpi('Alertes 24 h (graves)', o.last24h.high + o.last24h.critical, o.last24h.critical + ' critique(s)', o.last24h.high + o.last24h.critical > 0), kpi('À surveiller 24 h', o.last24h.warn, 'événements « attention »'), kpi('Adresses bloquées', o.blocks.length, 'actuellement'), kpi('Lignes d’audit', fmtN(o.auditRows), 'chaîne SHA-256')),
        h('div', { class: 'grid g-3' }, cfg, card('Double authentification de l’administrateur', null, tfaBox), blocks), sess, audit);
    };
    reload();
  }

  Object.assign(A.views, { payments: paymentsView, alerts: alertsView, orgs: orgsView, plans: plansView, contacts: contactsView, ai: aiView, notifications: notifsView, settings: settingsView, security: securityView });
})();
