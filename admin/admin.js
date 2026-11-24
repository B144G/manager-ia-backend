'use strict';
// Administration MABAH — coque (menu, en-tête, routage, recherche Ctrl K, connexion). Les écrans sont dans views-a.js et views-b.js.
(function () {
  const A = window.A, { h, icon, fmtN, badge, api, toast, fail, initials } = A;
  const S = A.S;
  const $ = (id) => document.getElementById(id);

  // ---------- Plan du menu ----------
  const NAV = [
    ['Pilotage', [['overview', "Vue d'ensemble", 'overview'], ['clients', 'Clients', 'users'], ['orgs', 'Organisations', 'orgs'], ['geo', 'Carte des entreprises', 'map'], ['brands', 'Marques des entreprises', 'orgs'], ['payments', 'Paiements', 'payments'], ['alerts', 'Alertes', 'alerts']]],
    ['Commercial', [['plans', 'Offres et abonnements', 'plans'], ['expiring', 'Abonnements à expirer', 'clock'], ['contacts', 'Contacts reçus', 'contacts'], ['feedback', 'Avis', 'star']]],
    ['Plateforme', [['modules', 'Utilisation des modules', 'grid'], ['ai', "Utilisation de l'IA", 'ai'], ['health', 'Santé de la plateforme', 'activity'], ['notifications', 'Notifications', 'notifications'], ['security', 'Sécurité', 'security'], ['settings', 'Paramètres', 'settings']]],
  ];
  const TITLES = Object.fromEntries(NAV.flatMap(([, items]) => items.map(([k, l]) => [k, l])));
  const VIEW_OF = { overview: 'overview', clients: 'users', orgs: 'orgs', geo: 'geo', brands: 'brands', payments: 'payments', alerts: 'alerts', plans: 'plans', expiring: 'expiring', modules: 'modules', health: 'health', contacts: 'contacts', feedback: 'feedback', ai: 'ai', notifications: 'notifications', security: 'security', settings: 'settings' };

  let gen = 0, leaves = [], crumbDetail = '', route = { name: 'overview', arg: null };
  A.onLeave = (fn) => { leaves.push(fn); return fn; };
  A.crumb = (t) => { crumbDetail = t || ''; drawTop(); };

  const parseHash = () => {
    const m = /^#\/([a-z]+)(?:\/([^/?#]+))?/.exec(location.hash || '');
    const name = m && VIEW_OF[m[1]] ? m[1] : 'overview';
    return { name, arg: m ? m[2] || null : null };
  };
  A.go = (hash, extra) => { if (extra) Object.assign(S, extra); if (location.hash === hash) A.refresh(); else location.hash = hash; };

  // ---------- Compteurs du menu ----------
  const counts = () => {
    const sm = A.live.st.summary || (S.ov && S.ov.todo ? { payments: S.ov.todo.payments, leads: S.ov.todo.leads, alerts: S.ov.todo.alerts } : { payments: 0, leads: 0, alerts: 0 });
    return { payments: sm.payments || 0, alerts: sm.alerts || 0, contacts: sm.leads || 0, clients: A.live.unseen(), expiring: (S.ov && S.ov.todo && S.ov.todo.expiring) || 0 };
  };
  function setTitle() { const c = counts(); const n = c.payments + c.alerts + c.clients; document.title = (n ? '(' + n + ') ' : '') + 'Administration MABAH'; }

  // ---------- Menu latéral ----------
  function drawSide() {
    const c = counts(), cur = route.name;
    const link = ([k, l, ic]) => h('a', { href: '#/' + k, 'aria-current': cur === k ? 'page' : null, onclick: () => closeDrawer() }, icon(ic), h('span', { class: 'nl' }, l), c[k] ? h('span', { class: 'cnt ' + (k === 'clients' ? 'new' : 'hot'), 'aria-label': c[k] + (k === 'clients' ? ' nouveaux' : ' à traiter') }, String(c[k])) : null);
    $('side').replaceChildren(
      h('div', { class: 'brand' }, h('a', { href: '#/overview', 'aria-label': 'MABAH, accueil de l’administration', class: 'brand-a' }, h('img', { src: '/admin/img/logo-mabah-192.png', alt: '', width: 26, height: 26 }), 'MABAH'), h('span', { class: 'env' }, 'ADMIN')),
      ...NAV.flatMap(([title, items]) => [h('div', { class: 'nav-label' }, title), h('nav', { class: 'nav', 'aria-label': title }, items.map(link))]),
      h('div', { class: 'side-foot' },
        h('button', { class: 'btn ghost', type: 'button', onclick: () => A.theme.toggle(), 'aria-label': 'Basculer le thème clair / sombre' }, icon(A.theme.get() === 'dark' ? 'sun' : 'moon'), A.theme.get() === 'dark' ? 'Thème clair' : 'Thème sombre'),
        h('div', { class: 'me' }, h('span', { class: 'av' }, initials(S.admin || 'A')), h('div', { class: 't' }, h('b', {}, S.admin || 'Administrateur'), h('small', {}, 'Administrateur')),
          h('button', { class: 'btn ghost icon', type: 'button', title: 'Me déconnecter', 'aria-label': 'Me déconnecter', onclick: logout }, icon('out')))));
    setTitle();
  }

  // ---------- En-tête : fil d'Ariane, recherche, direct, alertes, thème ----------
  let popOpen = false;
  function drawTop() {
    const c = counts(), total = c.payments + c.alerts + c.contacts + c.clients, mode = A.live.st.mode;
    const crumbs = [['Administration', '#/overview'], [TITLES[route.name], route.arg ? '#/' + route.name : null]];
    if (crumbDetail && route.arg) crumbs.push([crumbDetail, null]);
    const bell = h('div', { class: 'pw-rel' },
      h('button', { class: 'btn ghost icon', type: 'button', 'aria-label': total ? total + ' éléments à traiter' : 'Notifications', 'aria-expanded': popOpen ? 'true' : 'false', 'aria-haspopup': 'true', onclick: (e) => { e.stopPropagation(); popOpen = !popOpen; drawTop(); } }, icon('notifications'), total ? h('span', { class: 'cnt hot' }, String(Math.min(total, 99))) : null),
      popOpen ? bellPop(c) : null);
    $('top').replaceChildren(
      h('button', { class: 'btn ghost icon menu-btn', type: 'button', 'aria-label': 'Ouvrir le menu', 'aria-expanded': $('app').classList.contains('open') ? 'true' : 'false', onclick: toggleDrawer }, icon('menu')),
      h('nav', { class: 'crumbs', 'aria-label': 'Fil d’Ariane' }, h('ol', {}, crumbs.map(([t, href], i) => h('li', {}, href ? h('a', { href }, t) : h('span', { 'aria-current': i === crumbs.length - 1 ? 'page' : null }, t))))),
      h('span', { class: 'grow' }),
      h('button', { class: 'searchbtn', type: 'button', 'aria-label': 'Rechercher (Ctrl K)', onclick: openPalette }, icon('search'), h('span', {}, 'Rechercher un utilisateur, une organisation, un paiement…'), h('span', { class: 'kbd' }, navigator.platform && /Mac/.test(navigator.platform) ? '⌘ K' : 'Ctrl K')),
      h('span', { class: 'live ' + (mode === 'sse' ? 'on' : ''), role: 'status', title: mode === 'sse' ? 'Flux en direct actif' : mode === 'poll' ? 'Flux coupé : actualisation toutes les 12 s' : 'Hors ligne' }, h('i', { class: 'dot ' + (mode === 'sse' ? '' : mode === 'poll' ? 'warn' : 'off') }), h('span', { class: 'lt' }, mode === 'sse' ? 'En direct' : mode === 'poll' ? 'Actualisation' : 'Hors ligne')),
      bell);
  }
  function bellPop(c) {
    const L = A.live, ns = L.notifState();
    const item = (ic, text, n, to) => h('button', { class: 'pi', type: 'button', onclick: () => { popOpen = false; A.go(to); drawTop(); } }, icon(ic), h('span', {}, text), n ? h('span', { class: 'cnt ' + (ic === 'userplus' ? 'new' : 'hot'), style: null }, String(n)) : null);
    return h('div', { class: 'pop', role: 'menu', onclick: (e) => e.stopPropagation() },
      h('h3', {}, 'À traiter'),
      item('userplus', 'Nouveaux comptes', c.clients, '#/clients'), item('payments', 'Paiements à valider', c.payments, '#/payments'), item('alerts', 'Alertes ouvertes', c.alerts, '#/alerts'), item('contacts', 'Demandes de contact', c.contacts, '#/contacts'),
      h('h3', {}, 'Direct'),
      L.notifSupported() ? h('button', { class: 'pi', type: 'button', role: 'menuitemcheckbox', 'aria-checked': ns === 'active' ? 'true' : 'false', onclick: () => L.setNotif(ns !== 'active').then(drawTop) }, icon('notifications'), h('span', {}, ns === 'refusée' ? 'Notifications refusées par le navigateur' : 'Notifications du navigateur'), h('span', { class: 'sw', role: 'presentation', 'aria-checked': ns === 'active' ? 'true' : 'false' })) : null,
      h('button', { class: 'pi', type: 'button', role: 'menuitemcheckbox', 'aria-checked': L.prefs.sound ? 'true' : 'false', onclick: () => { L.setSound(!L.prefs.sound); drawTop(); } }, icon(L.prefs.sound ? 'volume' : 'mute'), h('span', {}, 'Son discret à chaque compte'), h('span', { class: 'sw', role: 'presentation', 'aria-checked': L.prefs.sound ? 'true' : 'false' })));
  }
  document.addEventListener('click', () => { if (popOpen) { popOpen = false; drawTop(); } });

  // ---------- Tiroir (téléphone et tablette) ----------
  const mq = window.matchMedia('(max-width: 1023px)');
  function syncInert() { const side = $('side'); if (side) side.inert = mq.matches && !$('app').classList.contains('open'); }
  function toggleDrawer() { const app = $('app'); app.classList.toggle('open'); syncInert(); drawTop(); if (app.classList.contains('open')) { const a = $('side').querySelector('a[aria-current]') || $('side').querySelector('a'); if (a) a.focus(); } }
  function closeDrawer() { const app = $('app'); if (app.classList.contains('open')) { app.classList.remove('open'); syncInert(); drawTop(); } }
  mq.addEventListener('change', () => { $('app').classList.remove('open'); syncInert(); drawTop(); });
  $('scrim').addEventListener('click', closeDrawer);

  // ---------- Bandeau très visible « MODE TEST » (paiement automatique Campay en démonstration : aucun argent réel) ----------
  let modeLoaded = false;
  function drawModeBar() {
    const col = document.querySelector('#app .col'); if (!col) return;
    let bar = $('modeBar');
    const c = S.campay;
    if (!c || !c.enabled || !c.test) { if (bar) bar.remove(); }
    else {
      if (!bar) { bar = h('div', { id: 'modeBar', class: 'modebar', role: 'status' }); col.prepend(bar); }
      bar.replaceChildren(h('b', {}, 'MODE TEST : aucun argent réel'), h('span', {}, ' Paiements Mobile Money en démonstration (' + (c.baseHost || 'Campay') + '). Les offres s’activent, mais rien n’est encaissé.'));
    }
    if (!modeLoaded) { modeLoaded = true; api('/campay').then((d) => { S.campay = d; drawModeBar(); }).catch(() => { modeLoaded = false; }); }
  }
  A.drawModeBar = drawModeBar;

  // ---------- Routage et rendu ----------
  async function render(opts) {
    const keepScroll = opts && opts.keep;
    const my = ++gen;
    for (const f of leaves.splice(0)) { try { f(); } catch (e) { /* nettoyage */ } }
    crumbDetail = '';
    route = parseHash();
    drawSide(); drawTop(); drawModeBar();
    const main = $('main'), y = window.scrollY;
    const page = h('div', {}); main.replaceChildren(page);
    const ctx = { arg: route.arg, stale: () => my !== gen };
    try {
      if (route.name === 'overview' && !S.ov) {
        page.append(h('div', { class: 'grid g-kpi' }, Array.from({ length: 4 }, () => h('span', { class: 'sk k' }))));
        await loadOverview(true);
        if (ctx.stale()) return;
        page.replaceChildren();
      }
      const view = A.views[VIEW_OF[route.name]];
      await view(page, ctx);
      if (ctx.stale()) return;
    } catch (e) {
      if (ctx.stale() || (e && e.auth)) return;
      page.replaceChildren(A.empty('alerts', 'Impossible d’afficher cette page', (e && e.message) || 'Erreur inattendue.', h('button', { class: 'btn', type: 'button', onclick: () => A.refresh() }, icon('refresh', 'sm'), 'Réessayer')));
    }
    window.scrollTo(0, keepScroll ? y : 0);
  }
  A.refresh = () => render({ keep: true });
  window.addEventListener('hashchange', () => { render().then(() => { if (!mq.matches || true) { const m = $('main'); m.focus({ preventScroll: true }); } }); });

  async function loadOverview(silent) {
    try { S.ov = await api('/overview?days=' + S.days); if (S.ov.admin) S.admin = S.ov.admin; } catch (e) { if (!silent) fail(e); throw e; }
  }
  A.reload = async () => { try { await loadOverview(true); } catch (e) { /* l'écran gère */ } await render({ keep: true }); };

  // ---------- Direct : réactions de la coque ----------
  function wireLive() {
    const L = A.live;
    L.on('summary', () => { drawSide(); drawTop(); if (S.ov) { S.ov.todo = Object.assign(S.ov.todo || {}, { payments: L.st.summary.payments, leads: L.st.summary.leads, alerts: L.st.summary.alerts }); } });
    L.on('account', () => { drawSide(); drawTop(); });
    L.on('seen', () => { drawSide(); drawTop(); });
    L.on('mode', drawTop);
    L.on('snapshot', () => { drawSide(); setTitle(); });
  }

  // ---------- Recherche globale (Ctrl K) ----------
  let palOpen = false;
  function openPalette() {
    if (palOpen) return;
    palOpen = true;
    let release, items = [], sel = 0, seq = 0, tm;
    const input = h('input', { type: 'text', role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'palList', 'aria-autocomplete': 'list', placeholder: 'Rechercher un utilisateur, une organisation, un paiement… ou une page', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Recherche globale' });
    const list = h('div', { class: 'pal-r', id: 'palList', role: 'listbox', 'aria-label': 'Résultats' });
    const ov = h('div', { class: 'pal' }, h('div', { class: 'pal-b', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Recherche globale' }, h('div', { class: 'pal-i' }, icon('search'), input, h('span', { class: 'kbd' }, 'Échap')), list,
      h('div', { class: 'pal-f' }, h('span', {}, '↑ ↓ pour choisir'), h('span', {}, '↵ pour ouvrir'))));
    const close = () => { release(); ov.remove(); palOpen = false; };
    ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });
    const go = (it) => { close(); it.run(); };
    const draw = () => {
      list.replaceChildren(); let lastG = '';
      if (!items.length) { list.append(h('p', { class: 'muted', style: null }, input.value.trim().length < 2 ? 'Tapez au moins 2 caractères pour chercher dans les comptes, organisations et paiements.' : 'Aucun résultat.')); list.firstChild.classList.add('pal-g'); }
      items.forEach((it, i) => {
        if (it.group !== lastG) { list.append(h('div', { class: 'pal-g' }, it.group)); lastG = it.group; }
        list.append(h('button', { class: 'pal-o', type: 'button', role: 'option', id: 'pal' + i, 'aria-selected': i === sel ? 'true' : 'false', onclick: () => go(it), onmousemove: () => { if (sel !== i) { sel = i; mark(); } } }, icon(it.icon), h('div', { class: 't' }, h('b', {}, it.title), it.sub ? h('small', {}, it.sub) : null)));
      });
      input.setAttribute('aria-activedescendant', items.length ? 'pal' + sel : '');
    };
    const mark = () => { [...list.querySelectorAll('.pal-o')].forEach((b, i) => b.setAttribute('aria-selected', i === sel ? 'true' : 'false')); const cur = list.querySelector('[aria-selected="true"]'); if (cur) cur.scrollIntoView({ block: 'nearest' }); input.setAttribute('aria-activedescendant', 'pal' + sel); };
    const pages = (q) => NAV.flatMap(([, it]) => it).filter(([, l]) => !q || l.toLowerCase().includes(q.toLowerCase())).slice(0, q ? 4 : 11).map(([k, l, ic]) => ({ group: 'Aller à', icon: ic, title: l, run: () => A.go('#/' + k) }));
    const search = async () => {
      const q = input.value.trim(), my = ++seq;
      items = pages(q); sel = 0; draw();
      if (q.length < 2) return;
      try {
        const r = await api('/search?q=' + encodeURIComponent(q));
        if (my !== seq || !palOpen) return;
        items = [
          ...r.users.map((u) => ({ group: 'Utilisateurs', icon: 'users', title: u.name, sub: u.contact + ' · ' + u.plan, run: () => A.go('#/clients/' + u.id) })),
          ...r.orgs.map((o) => ({ group: 'Organisations', icon: 'orgs', title: o.name, sub: 'Propriétaire : ' + o.owner + (o.sector ? ' · ' + o.sector : ''), run: () => A.go('#/clients/' + o.ownerId) })),
          ...r.payments.map((p) => ({ group: 'Paiements', icon: 'payments', title: p.reference + ' · ' + A.fmtXAF(p.amountXAF), sub: p.user + ' · ' + p.planName + ' · ' + (A.STATUS_LABEL[p.status] || p.status), run: () => A.go('#/payments', { payFilter: '', payQ: p.reference }) })),
          ...pages(q)];
        sel = 0; draw();
      } catch (e) { if (my === seq && !(e && e.auth)) { list.replaceChildren(h('div', { class: 'pal-g' }, e.message || 'Recherche impossible.')); } }
    };
    input.addEventListener('input', () => { clearTimeout(tm); tm = setTimeout(search, 180); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); if (items.length) { sel = (sel + 1) % items.length; mark(); } }
      else if (e.key === 'ArrowUp') { e.preventDefault(); if (items.length) { sel = (sel - 1 + items.length) % items.length; mark(); } }
      else if (e.key === 'Enter') { e.preventDefault(); if (items[sel]) go(items[sel]); }
    });
    $('overlays').append(ov);
    release = A.trap(ov, close);
    items = pages(''); draw(); input.focus();
  }
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k' && !$('app').classList.contains('hidden')) { e.preventDefault(); openPalette(); }
    else if (e.key === 'Escape') { if (popOpen) { popOpen = false; drawTop(); } else closeDrawer(); }
  });

  // ---------- Connexion ----------
  const eyeBtn = $('pwToggle');
  eyeBtn.append(icon('eye'));
  eyeBtn.addEventListener('click', () => { const i = document.querySelector('#loginForm [name=password]'); const show = i.type === 'password'; i.type = show ? 'text' : 'password'; eyeBtn.replaceChildren(icon(show ? 'eyeoff' : 'eye')); eyeBtn.setAttribute('aria-label', show ? 'Masquer le mot de passe' : 'Afficher le mot de passe'); });
  $('loginTheme').addEventListener('click', () => A.theme.toggle());
  $('loginPoints').append(...[['userplus', 'Les nouveaux comptes en direct'], ['payments', 'Les paiements à valider'], ['security', 'La sécurité et le journal d’audit']].map(([ic, t]) => h('li', {}, icon(ic), t)));
  function showLogin() { A.live.stop(); S.ov = null; $('app').classList.add('hidden'); $('login').classList.remove('hidden'); document.title = 'Connexion · Administration MABAH'; const u = document.querySelector('#loginForm [name=username]'); if (u) u.focus({ preventScroll: true }); }
  function showApp() { $('login').classList.add('hidden'); $('app').classList.remove('hidden'); syncInert(); }
  A.onAuthLost = () => { if (!$('app').classList.contains('hidden') || $('login').classList.contains('hidden')) showLogin(); };
  $('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault(); $('loginError').textContent = '';
    const f = new FormData(e.target), btn = $('loginBtn');
    if (!f.get('username') || !f.get('password')) { $('loginError').textContent = 'Saisissez votre identifiant et votre mot de passe.'; return; }
    btn.disabled = true; btn.textContent = 'Connexion…';
    try {
      await api('/login', { method: 'POST', body: { username: f.get('username'), password: f.get('password'), code: f.get('code') || undefined } });
      e.target.reset(); $('codeRow').classList.add('hidden'); await start();
    } catch (err) {
      if (err.data && err.data.needCode) { $('codeRow').classList.remove('hidden'); e.target.elements.code.focus(); }
      $('loginError').textContent = err.message;
    } finally { btn.disabled = false; btn.textContent = 'Se connecter'; }
  });
  async function logout() { try { await api('/logout', { method: 'POST' }); } catch (e) { /* ignoré */ } showLogin(); }

  // ---------- Démarrage ----------
  let wired = false;
  async function start() {
    S.ov = null;
    if (!wired) { wired = true; wireLive(); }
    try { await loadOverview(true); } catch (e) { if (e && e.auth) return; showApp(); fail(e); return; }
    showApp();
    A.live.start();
    await render();
  }
  start().catch(() => showLogin());
})();
