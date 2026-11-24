'use strict';
// Marques des entreprises : ce que chaque entreprise a personnalisé (nom affiché, assistant, couleur, mode), lecture seule ; tentatives d'usurpation refusées.
(function () {
  const A = window.A, { h, fmtN, fmtDate, card, cardFlush, empty, table, api, phead } = A;
  const MODE = { brij: 'Brij-IA (affichage d’origine)', powered: 'Nom de l’entreprise + « Propulsé par Brij-IA »', white: 'Marque blanche' };

  async function brandsView(main) {
    main.append(phead('Marques des entreprises', 'Le nom, l’assistant et la couleur que chaque entreprise a choisis. Lecture seule : sert à repérer une usurpation ou un abus.'));
    const d = await api('/brands');
    const stack = h('div', { class: 'stack' }); main.append(stack);
    stack.append(h('div', { class: 'grid g-kpi' },
      h('div', { class: 'card kpi' }, h('div', { class: 'l' }, 'Entreprises personnalisées'), h('div', { class: 'v' }, fmtN(d.customized)), h('span'), h('div', { class: 'h' }, 'sur ' + fmtN(d.total) + ' au total')),
      h('div', { class: 'card kpi' }, h('div', { class: 'l' }, 'Noms refusés'), h('div', { class: 'v' }, fmtN(d.refused.length)), h('span'), h('div', { class: 'h' }, 'usurpation ou nom réservé'))));
    const t = table({ pageSize: 25, noun: 'entreprises', sort: { key: 'updatedAt', dir: 'desc' }, cols: [
      { key: 'org', label: 'Entreprise', main: true, render: (o) => h('b', {}, o.org) },
      { key: 'shownName', label: 'Nom affiché', render: (o) => h('span', {}, o.shownName, o.duplicateName ? h('span', { class: 'badge warn' }, ' doublon') : '') },
      { key: 'assistantName', label: 'Assistant IA', render: (o) => o.assistantName || '—' },
      { key: 'mode', label: 'Mode', render: (o) => MODE[o.mode] || o.mode },
      { key: 'color', label: 'Couleur', render: (o) => (o.color ? h('span', {}, h('i', { style: 'display:inline-block;width:12px;height:12px;border-radius:3px;margin-right:6px;background:' + o.color }), o.color) : '—') },
      { key: 'hasLogo', label: 'Logo', render: (o) => (o.hasLogo ? 'oui' : '—') },
      { key: 'updatedAt', label: 'Modifiée le', cls: 'nw mu', render: (o) => fmtDate(o.updatedAt) }],
      empty: empty('grid', 'Aucune entreprise personnalisée', 'Toutes les entreprises utilisent l’affichage d’origine.') });
    t.set(d.items);
    stack.append(cardFlush('Entreprises personnalisées', null, t.el));
    if (d.refused.length) {
      const t2 = table({ pageSize: 10, noun: 'refus', cols: [{ key: 'org', label: 'Entreprise', main: true }, { key: 'detail', label: 'Motif' }, { key: 'at', label: 'Date', cls: 'nw mu', render: (o) => fmtDate(o.at) }], empty: empty('grid', 'Aucun refus', '') });
      t2.set(d.refused);
      stack.append(cardFlush('Tentatives refusées', null, t2.el));
    }
  }
  Object.assign(A.views, { brands: brandsView });
})();
