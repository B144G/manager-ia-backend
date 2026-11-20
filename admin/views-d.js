'use strict';
// Avis et recommandations : liste filtrable, détail avec statut et réponse interne, approbation des témoignages, indicateurs, export CSV, résumé quotidien.
(function () {
  const A = window.A, { h, icon, fmtN, fmtDateTime, badge, card, cardFlush, empty, table, api, phead, toast, fail } = A;
  const S = A.S;
  A.ICONS.star = 'M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z';
  const KINDS = [['', 'Tous les types'], ['review', 'Avis'], ['suggestion', 'Suggestion'], ['problem', 'Problème'], ['comment', 'Commentaire']];
  const STATUS = [['', 'Tous les statuts'], ['new', 'Nouveau'], ['read', 'Lu'], ['in_progress', 'En cours'], ['done', 'Traité'], ['archived', 'Archivé']];
  const STATUS_KIND = { new: 'bad', read: 'info', in_progress: 'warn', done: 'ok', archived: '' };
  const stars = (n) => '★'.repeat(n) + '☆'.repeat(5 - n);
  const kpi = (label, value, hint) => h('div', { class: 'card kpi' }, h('div', { class: 'l' }, label), h('div', { class: 'v' }, value), h('span'), h('div', { class: 'd' }, hint || ''));
  const delta = (cur, prev, unit) => (cur == null || prev == null ? '' : (cur - prev > 0 ? '+' : '') + (Math.round((cur - prev) * 10) / 10) + (unit || '') + ' vs période précédente');
  const qs = (f) => Object.entries(f).filter(([, v]) => v !== '' && v != null).map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');

  async function feedbackView(main) {
    const F = S.fb = S.fb || { days: 30, kind: '', module: '', stars: '', status: '', public: '', q: '' };
    main.append(phead('Avis et recommandations', 'Ce que vos utilisateurs pensent du logiciel : notes, score de recommandation, suggestions et problèmes. Les avis anonymes n’affichent ni nom ni organisation.',
      h('a', { class: 'btn', href: '/api/admin/feedback/export.csv?' + qs({ kind: F.kind, module: F.module, stars: F.stars, status: F.status, public: F.public, q: F.q }), download: '' }, icon('down', 'sm'), 'Exporter en CSV')));
    const [st, dg] = await Promise.all([api('/feedback/stats?days=' + F.days), api('/feedback/digest?day=' + new Date().toISOString().slice(0, 10))]);
    const stack = h('div', { class: 'stack' }); main.append(stack);
    const period = A.select('Période', [[7, '7 derniers jours'], [30, '30 derniers jours'], [90, '90 derniers jours'], [365, '12 mois']], F.days, (v) => { F.days = Number(v); A.refresh(); }); period.classList.add('sm');
    stack.append(h('div', { class: 'row' }, period));
    stack.append(h('div', { class: 'grid g-kpi' },
      kpi('Note moyenne', st.average == null ? '—' : st.average + ' / 5', delta(st.average, st.previousAverage)),
      kpi('Score de recommandation (NPS)', st.nps.score == null ? '—' : String(st.nps.score), st.nps.n ? st.nps.promoters + ' promoteurs · ' + st.nps.passives + ' passifs · ' + st.nps.detractors + ' détracteurs' : 'aucun score sur la période'),
      kpi('Avis reçus', fmtN(st.total), delta(st.total, st.previousTotal)),
      kpi('À lire', fmtN(st.newCount), 'avis nouveaux, tous statuts confondus')));
    const maxD = Math.max(1, ...st.distribution);
    const dist = h('div', { class: 'bars' }, [5, 4, 3, 2, 1].map((n) => { const b = h('i'); b.style.width = Math.max(st.distribution[n - 1] ? 3 : 0, Math.round(100 * st.distribution[n - 1] / maxD)) + '%'; return h('div', {}, h('span', {}, n + ' ★'), h('div', { class: 'tr' }, b), h('b', {}, fmtN(st.distribution[n - 1]))); }));
    const mods = st.topModules.length ? h('div', { class: 'bars' }, st.topModules.map((m) => { const b = h('i'); b.style.width = Math.max(3, Math.round(100 * m.count / st.topModules[0].count)) + '%'; return h('div', {}, h('span', {}, m.title), h('div', { class: 'tr' }, b), h('b', {}, m.count + ' · ' + m.average + '★' + (m.problems ? ' · ' + m.problems + ' pb' : ''))); })) : empty('star', 'Aucun avis sur la période', '');
    stack.append(h('div', { class: 'grid g-2' },
      card('Évolution de la note moyenne', h('span', { class: 'sub' }, st.days > 60 ? 'par semaine' : 'par jour'), st.total ? h('div', { class: 'fb-chart' }, A.charts.bars({ labels: st.series.map((p) => A.fmtDay(p.day)), values: st.series.map((p) => p.avg == null ? 0 : p.avg), unit: '★', minTop: 5, name: 'Note moyenne', title: 'Note moyenne des avis (une barre vide = aucun avis ce jour-là)' })) : empty('star', 'Pas encore d’avis', 'La courbe apparaît dès le premier avis.')),
      card('Répartition des notes', null, dist)));
    stack.append(h('div', { class: 'grid g-2' }, card('Modules les plus cités', h('span', { class: 'sub' }, 'avis · note moyenne · problèmes'), mods),
      card('Résumé du jour (' + dg.day + ')', h('span', { class: 'sub' }, dg.channels.email ? 'celui de la veille part chaque matin par e-mail' : 'e-mail non configuré : à lire ici'), h('pre', { class: 'fb-digest' }, dg.text))));

    // ----- Liste filtrable -----
    const meta = await api('/feedback?limit=1'); void meta;
    const listHost = h('div', {});
    const search = A.searchBox('Rechercher dans les messages', (v) => { F.q = v; load(); }, F.q);
    const modOpts = [['', 'Tous les modules'], ...[...new Map(st.topModules.map((m) => [m.module, m.title])).entries()]];
    if (F.module && !modOpts.some(([v]) => v === F.module)) modOpts.push([F.module, F.module]);
    const filt = h('div', { class: 'toolbar' }, search.el,
      A.select('Type', KINDS, F.kind, (v) => { F.kind = v; load(); }), A.select('Module', modOpts, F.module, (v) => { F.module = v; load(); }),
      A.select('Note', [['', 'Toutes les notes'], ...[5, 4, 3, 2, 1].map((n) => [n, n + ' ★'])], F.stars, (v) => { F.stars = v; load(); }),
      A.select('Statut', STATUS, F.status, (v) => { F.status = v; load(); }),
      A.select('Témoignage', [['', 'Tous'], ['pending', 'À approuver'], ['approved', 'Publiés']], F.public, (v) => { F.public = v; load(); }));
    const tb = table({ pageSize: 25, noun: 'avis', rows: [], onRow: (r) => openDetail(r.id), rowKey: (r) => r.id, empty: empty('star', 'Aucun avis', 'Aucun avis ne correspond à ces filtres.'), cols: [
      { key: 'createdAt', label: 'Date', cls: 'nw', render: (r) => fmtDateTime(r.createdAt) },
      { key: 'stars', label: 'Note', cls: 'nw', render: (r) => h('span', {}, h('span', { class: 'fb-stars', 'aria-label': r.stars + ' sur 5' }, stars(r.stars)), r.nps == null ? null : h('small', { class: 'muted' }, ' · ' + r.nps + '/10')) },
      { key: 'kindLabel', label: 'Type et module', sort: (r) => r.kindLabel, render: (r) => h('span', {}, r.kindLabel, h('small', { class: 'muted' }, ' · ' + r.moduleTitle)) },
      { key: 'body', label: 'Message', main: true, sort: false, render: (r) => h('span', {}, (r.body || '(sans texte)') + (r.truncated ? '…' : '')) },
      { key: 'author', label: 'De', sort: (r) => (r.author ? r.author.name : ''), render: (r) => (r.anonymous ? h('span', { class: 'muted' }, 'Anonyme') : h('span', {}, r.author.name, h('small', { class: 'muted' }, ' · ' + r.author.org))) },
      { key: 'status', label: 'Statut', cls: 'nw', render: (r) => h('span', {}, badge(r.statusLabel, STATUS_KIND[r.status]), r.publicConsent ? h('span', { title: r.approved ? 'Témoignage publié' : 'Consentement donné : à approuver' }, ' ', badge(r.approved ? 'Public' : 'À approuver', r.approved ? 'ok' : 'warn', true)) : null) }] });
    const load = async () => { try { const d = await api('/feedback?limit=100&' + qs({ kind: F.kind, module: F.module, stars: F.stars, status: F.status, public: F.public, q: F.q })); tb.set(d.items); count.textContent = d.total > 100 ? '100 premiers sur ' + fmtN(d.total) : fmtN(d.total) + ' avis'; } catch (e) { fail(e); } };
    const count = h('span', { class: 'sub' });
    stack.append(cardFlush('Tous les avis', count, h('div', { class: 'cb' }, filt), tb.el));
    await load();
    void listHost;
  }

  async function openDetail(id) {
    let d;
    try { d = await api('/feedback/' + id); } catch (e) { fail(e); return; }
    let release;
    const close = () => { release(); ov.remove(); A.refresh(); };
    const render = (x) => {
      const it = x.item;
      const status = h('select', { class: 'select', 'aria-label': 'Statut' }, STATUS.slice(1).map(([v, l]) => h('option', { value: v, selected: it.status === v ? '' : null }, l)));
      const note = h('textarea', { class: 'textarea', rows: '3', maxlength: '2000', placeholder: 'Réponse interne (visible de vous seul, jamais de l’utilisateur)', 'aria-label': 'Réponse interne' });
      const save = async (body, msg) => { try { const r = await api('/feedback/' + id, { method: 'PUT', body }); toast(msg, 'ok'); body = null; render(r); } catch (e) { fail(e); } };
      const shot = it.hasScreenshot ? h('a', { href: '/api/admin/feedback/' + id + '/screenshot', target: '_blank', rel: 'noopener' }, h('img', { class: 'fb-shot', src: '/api/admin/feedback/' + id + '/screenshot', alt: 'Capture d’écran jointe à l’avis' })) : null;
      const pub = it.publicConsent ? h('div', { class: 'row' }, badge(it.approved ? 'Témoignage publié' : 'Consentement donné', it.approved ? 'ok' : 'warn'),
        h('button', { class: 'btn sm ' + (it.approved ? '' : 'primary'), type: 'button', onclick: () => save({ approved: !it.approved }, it.approved ? 'Témoignage retiré.' : 'Témoignage publié.') }, it.approved ? 'Retirer de l’affichage public' : 'Approuver et publier'),
        h('small', { class: 'muted' }, it.anonymous ? 'Affiché sans nom.' : 'Affiché sous le nom « ' + it.publicName + ' ».')) : h('small', { class: 'muted' }, 'Pas de consentement à l’affichage public : cet avis ne sera jamais publié.');
      box.replaceChildren(
        h('div', { class: 'row' }, h('h2', { id: 'fbT' }, it.kindLabel + ' · ' + it.moduleTitle), h('button', { class: 'btn ghost icon', type: 'button', 'aria-label': 'Fermer', onclick: close }, icon('x'))),
        h('p', {}, h('b', { class: 'fb-stars' }, stars(it.stars)), '  ', it.nps == null ? '' : 'Recommandation ' + it.nps + '/10', '  ', h('small', { class: 'muted' }, fmtDateTime(it.createdAt) + (it.page ? ' · page ' + it.page : '') + ' · ' + it.lang)),
        h('p', {}, it.anonymous ? h('i', {}, 'Utilisateur anonyme') : h('span', {}, h('b', {}, it.author.name), ' · ', it.author.org)),
        h('blockquote', { class: 'fb-body' }, it.body || '(sans texte)'), shot || [], pub,
        h('div', { class: 'row' }, h('label', {}, 'Statut ', status), h('button', { class: 'btn sm', type: 'button', onclick: () => save({ status: status.value }, 'Statut enregistré.') }, 'Enregistrer le statut')),
        h('h3', {}, 'Réponses internes'),
        x.notes.length ? h('div', { class: 'list' }, x.notes.map((n) => h('div', { class: 'li' }, h('div', { class: 't' }, h('span', { class: 'fb-body' }, n.body), h('small', {}, fmtDateTime(n.createdAt)))))) : h('p', { class: 'muted' }, 'Aucune réponse interne.'),
        note, h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'button', onclick: () => { if (!note.value.trim()) { note.focus(); return; } save({ note: note.value }, 'Note enregistrée.'); } }, 'Ajouter la note')));
    };
    const box = h('div', { class: 'mdb fb-detail', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'fbT' });
    const ov = h('div', { class: 'mdl' }, box);
    ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });
    render(d);
    document.getElementById('overlays').append(ov);
    release = A.trap(ov, close);
  }

  Object.assign(A.views, { feedback: feedbackView });
})();
