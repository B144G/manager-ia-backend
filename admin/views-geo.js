'use strict';
// Carte des entreprises qui ont partagé leur position (facultatif). Fond OpenStreetMap (gratuit, attribution affichée), Leaflet en local (admin/vendor).
(function () {
  const A = window.A, { h, fmtN, fmtDate, planBadge, card, cardFlush, empty, table, api, phead } = A;
  const kpi = (label, value, hint) => h('div', { class: 'card kpi' }, h('div', { class: 'l' }, label), h('div', { class: 'v' }, value), h('span'), h('div', { class: 'd' }, hint || ''));

  async function geoView(main) {
    main.append(phead('Carte des entreprises', 'Les entreprises qui ont choisi de partager la position de leur siège (Équipe et antennes › Position de l’entreprise). Position arrondie à environ 100 m ; aucune donnée métier n’est affichée.'));
    const d = await api('/geo/orgs');
    const stack = h('div', { class: 'stack' }); main.append(stack);
    stack.append(h('div', { class: 'grid g-kpi' }, kpi('Entreprises localisées', fmtN(d.located), 'sur ' + fmtN(d.total) + ' au total'), kpi('Taux de partage', Math.round(d.rate * 100) + ' %', fmtN(d.notLocated) + ' entreprise(s) sans position'),
      kpi('Pays', fmtN(d.byCountry.length), d.byCountry[0] ? d.byCountry[0].name + ' en tête' : '—'), kpi('Villes', fmtN(d.byCity.length), d.byCity[0] ? d.byCity[0].name + ' en tête' : '—')));
    if (!d.located) { stack.append(card('Carte', null, empty('map', 'Aucune entreprise n’a encore partagé sa position', 'Chaque entreprise choisit de la renseigner dans son espace (Équipe et antennes).'))); return; }
    const box = h('div', { class: 'geo-box', role: 'application', 'aria-label': 'Carte des entreprises', tabindex: '0' }); box.style.height = '420px';
    stack.append(card('Carte', h('span', { class: 'sub' }, fmtN(d.located) + ' entreprise(s)'), box));
    setTimeout(() => {
      if (!window.L || !box.isConnected) return;
      const L = window.L; const map = L.map(box, { scrollWheelZoom: false }).setView([4.05, 9.7], 5);
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a>' }).addTo(map);
      const pts = d.orgs.map((o) => {
        const m = L.circleMarker([o.lat, o.lng], { radius: 9, color: '#fff', weight: 2, fillColor: '#4f46e5', fillOpacity: 0.95 }).addTo(map);
        const tip = document.createElement('div'); const b = document.createElement('b'); b.textContent = o.name; tip.append(b, document.createElement('br'), document.createTextNode([o.city, o.country].filter(Boolean).join(', ') + ' · ' + o.plan + ' · ' + o.members + ' pers.'));
        m.bindPopup(tip); return [o.lat, o.lng];
      });
      if (pts.length === 1) map.setView(pts[0], 12); else map.fitBounds(pts, { padding: [40, 40], maxZoom: 12 });
      A.onLeave(() => map.remove());
    }, 0);
    const bars = (list) => h('div', { class: 'bars' }, list.slice(0, 10).map((x) => { const i = h('i'); i.style.width = Math.max(4, Math.round((100 * x.n) / list[0].n)) + '%'; return h('div', { class: 'bar-row' }, h('span', { class: 'bl' }, x.name), h('span', { class: 'bt' }, i), h('span', { class: 'bv tnum' }, fmtN(x.n))); }));
    stack.append(h('div', { class: 'grid g-2' }, card('Par pays', null, bars(d.byCountry)), card('Par ville', h('span', { class: 'sub' }, 'les 10 premières'), bars(d.byCity))));
    const t = table({ pageSize: 25, noun: 'entreprises', sort: { key: 'name', dir: 'asc' }, cols: [
      { key: 'name', label: 'Entreprise', main: true, render: (o) => h('b', {}, o.name) }, { key: 'city', label: 'Ville', render: (o) => o.city || '—' }, { key: 'country', label: 'Pays' },
      { key: 'plan', label: 'Offre', render: (o) => planBadge(o.plan) }, { key: 'members', label: 'Personnes', cls: 'nw' }, { key: 'sharedAt', label: 'Partagée le', cls: 'nw mu', render: (o) => fmtDate(o.sharedAt) }],
      empty: empty('grid', 'Aucune entreprise', '') });
    t.set(d.orgs);
    stack.append(cardFlush('Entreprises localisées', null, t.el));
  }
  Object.assign(A.views, { geo: geoView });
})();
