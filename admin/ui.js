'use strict';
// Administration Brij-IA — briques d'interface (aucune dépendance externe).
// Tout texte inséré passe par textContent ; jamais de HTML injecté, jamais d'attribut style (CSP stricte) : les tailles dynamiques passent par le CSSOM.
(function () {
  const A = (window.A = window.A || {});
  const NS = 'http://www.w3.org/2000/svg';

  // ---------- Création d'éléments ----------
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return el;
  }
  function sv(tag, attrs, kids) { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v); (kids || []).forEach((x) => e.appendChild(x)); return e; }
  const svText = (attrs, t) => { const e = sv('text', attrs); e.textContent = t; return e; };

  // ---------- Icônes (un seul jeu, tracé 1,75 px) ----------
  const ICONS = {
    overview: 'M3 3h7v9H3z M14 3h7v5h-7z M14 12h7v9h-7z M3 16h7v5H3z',
    users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M22 21v-2a4 4 0 0 0-3-3.87 M16 3.13a4 4 0 0 1 0 7.75',
    orgs: 'M3 21h18 M5 21V7l7-4 7 4v14 M9 9h1 M9 13h1 M9 17h1 M14 9h1 M14 13h1 M14 17h1',
    payments: 'M2 5h20v14H2z M2 10h20 M6 15h4',
    alerts: 'M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z M12 9v4 M12 17h.01',
    plans: 'M12 2 2 7l10 5 10-5-10-5z M2 17l10 5 10-5 M2 12l10 5 10-5',
    contacts: 'M3 5h18v14H3z M3 7l9 6 9-6',
    ai: 'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z',
    notifications: 'M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9 M10.3 21a1.94 1.94 0 0 0 3.4 0',
    settings: 'M4 21v-7 M4 10V3 M12 21v-9 M12 8V3 M20 21v-5 M20 12V3 M1 14h6 M9 8h6 M17 16h6',
    security: 'M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z M9 12l2 2 4-4',
    search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z M21 21l-4.3-4.3',
    down: 'M12 3v12 M7 11l5 5 5-5 M4 20h16',
    out: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4 M16 17l5-5-5-5 M21 12H9',
    menu: 'M4 6h16 M4 12h16 M4 18h16', x: 'M18 6 6 18 M6 6l12 12',
    sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10z M12 1v2 M12 21v2 M4.2 4.2l1.4 1.4 M18.4 18.4l1.4 1.4 M1 12h2 M21 12h2 M4.2 19.8l1.4-1.4 M18.4 5.6l1.4-1.4',
    moon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z',
    cdown: 'M6 9l6 6 6-6', cup: 'M18 15l-6-6-6 6', cleft: 'M15 18l-6-6 6-6', cright: 'M9 18l6-6-6-6',
    aup: 'M12 19V5 M5 12l7-7 7 7', adown: 'M12 5v14 M19 12l-7 7-7-7', sort: 'M7 15l5 5 5-5 M7 9l5-5 5 5',
    check: 'M20 6 9 17l-5-5', clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 7v5l3 2',
    userplus: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M19 8v6 M22 11h-6',
    eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
    eyeoff: 'M17.9 17.9A10 10 0 0 1 12 19c-6 0-10-7-10-7a18 18 0 0 1 4.1-4.9 M9.9 5.1A9 9 0 0 1 12 5c6 0 10 7 10 7a18 18 0 0 1-2.2 3.2 M2 2l20 20',
    plus: 'M12 5v14 M5 12h14', refresh: 'M21 12a9 9 0 0 1-15.5 6.2L3 16 M3 12a9 9 0 0 1 15.5-6.2L21 8 M21 3v5h-5 M3 21v-5h5',
    volume: 'M11 5 6 9H2v6h4l5 4z M15.5 8.5a5 5 0 0 1 0 7 M19 5a10 10 0 0 1 0 14', mute: 'M11 5 6 9H2v6h4l5 4z M22 9l-6 6 M16 9l6 6',
    info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 16v-5 M12 8h.01',
    hourglass: 'M6 2h12 M6 22h12 M6 2v4a6 6 0 0 0 3 5 6 6 0 0 1-3 5v6 M18 2v4a6 6 0 0 1-3 5 6 6 0 0 0 3 5v6',
    inbox: 'M22 12h-6l-2 3h-4l-2-3H2 M5.5 5.1 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.7 4H7.3a2 2 0 0 0-1.8 1.1z',
    activity: 'M22 12h-4l-3 9L9 3l-3 9H2', trend: 'M22 7l-8.5 8.5-5-5L2 17 M16 7h6v6',
    lock: 'M5 11h14v10H5z M8 11V7a4 4 0 0 1 8 0v4', globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M3 12h18 M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18',
    external: 'M15 3h6v6 M10 14 21 3 M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6',
    wifi: 'M5 12.5a10 10 0 0 1 14 0 M8.5 16a5 5 0 0 1 7 0 M12 20h.01 M2 9a15 15 0 0 1 20 0',
    back: 'M19 12H5 M12 19l-7-7 7-7', ban: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M5.6 5.6l12.8 12.8',
    wallet: 'M3 7h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z M3 7l2-3h12 M16 13h2',
  };
  function icon(k, cls) { return sv('svg', { viewBox: '0 0 24 24', class: 'ic' + (cls ? ' ' + cls : ''), 'aria-hidden': 'true', focusable: 'false' }, ICONS[k] ? ICONS[k].split(' M').map((d, i) => sv('path', { d: (i ? 'M' : '') + d })) : []); }

  // ---------- Formats ----------
  const MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
  const MN = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
  const fmtN = (n) => new Intl.NumberFormat('fr-FR').format(Number(n) || 0).replace(/[  ]/g, ' ');
  const fmtXAF = (n) => fmtN(n) + ' FCFA';
  /** 1 250 000 → « 1,25 M » ; 80 000 → « 80 k » : lisible sur un axe. */
  const fmtCompact = (n) => {
    const v = Math.abs(Number(n) || 0), s = n < 0 ? '-' : '';
    const f = (x) => String(Math.round(x * 100) / 100).replace('.', ',');
    if (v >= 1e9) return s + f(v / 1e9) + ' Md'; if (v >= 1e6) return s + f(v / 1e6) + ' M'; if (v >= 1e3) return s + f(v / 1e3) + ' k'; return s + String(Math.round(v));
  };
  const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
  const fmtDateTime = (iso) => (iso ? new Date(iso).toLocaleString('fr-FR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
  const fmtTime = (iso) => (iso ? new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : '');
  function ago(iso) {
    if (!iso) return '';
    const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 45) return s < 5 ? "à l'instant" : 'il y a ' + Math.max(s, 5) + ' s';
    const m = Math.round(s / 60); if (m < 60) return 'il y a ' + m + ' min';
    const hh = Math.round(m / 60); if (hh < 24) return 'il y a ' + hh + ' h';
    const d = Math.round(hh / 24); if (d === 1) return 'hier'; if (d < 7) return 'il y a ' + d + ' j';
    return fmtDate(iso);
  }
  const duration = (sec) => { sec = Math.max(0, Math.round(sec)); if (sec < 60) return sec + ' s'; const m = Math.round(sec / 60); if (m < 60) return m + ' min'; const hh = Math.round(m / 60); return hh < 24 ? hh + ' h' : Math.round(hh / 24) + ' j'; };
  const plural = (n, a, b) => fmtN(n) + ' ' + (n > 1 ? b : a);
  const initials = (s) => String(s || '?').trim().split(/[\s._@-]+/).filter(Boolean).slice(0, 2).map((w) => w.charAt(0).toUpperCase()).join('') || '?';
  const digits = (s) => String(s || '').replace(/\D/g, '');
  /** Heure relative qui se met à jour seule (toutes les 20 s). */
  function agoEl(iso, cls) { return h('span', { class: 'ago' + (cls ? ' ' + cls : ''), 'data-t': iso, title: iso ? new Date(iso).toLocaleString('fr-FR') : '' }, ago(iso)); }
  setInterval(() => { for (const e of document.querySelectorAll('.ago[data-t]')) { const t = ago(e.getAttribute('data-t')); if (e.textContent !== t) e.textContent = t; } }, 20000);

  // ---------- Stockage (par visiteur ; peut échouer en navigation privée) ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem('adm-' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('adm-' + k, JSON.stringify(v)); } catch (e) { /* ignoré */ } },
  };

  // ---------- Thème ----------
  const theme = {
    get() { const t = document.documentElement.getAttribute('data-theme'); return t || (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'); },
    set(t) { document.documentElement.setAttribute('data-theme', t); try { localStorage.setItem('adm-theme', t); } catch (e) { /* ignoré */ } document.dispatchEvent(new CustomEvent('themechange')); },
    toggle() { theme.set(theme.get() === 'dark' ? 'light' : 'dark'); },
  };

  // ---------- Réseau ----------
  async function api(path, opts) {
    const o = Object.assign({ credentials: 'same-origin', headers: {} }, opts || {});
    if (o.body && typeof o.body !== 'string') { o.body = JSON.stringify(o.body); o.headers['Content-Type'] = 'application/json'; }
    let res;
    try { res = await fetch('/api/admin' + path, o); } catch (e) { const err = new Error('Connexion impossible : vérifiez votre réseau.'); err.offline = true; throw err; }
    let data = null;
    try { data = await res.json(); } catch (e) { /* vide */ }
    if (res.status === 401 && path !== '/login') { if (A.onAuthLost) A.onAuthLost(); const err = new Error('Session expirée : reconnectez-vous.'); err.auth = true; throw err; }
    if (!res.ok) { const err = new Error((data && data.error) || 'Erreur ' + res.status); err.data = data; err.status = res.status; throw err; }
    return data;
  }

  // ---------- Messages ----------
  function toast(msg, kind) {
    const host = document.getElementById('toasts');
    const t = h('div', { class: 'toast' + (kind ? ' ' + kind : '') }, icon(kind === 'bad' ? 'alerts' : kind === 'ok' ? 'check' : 'info'), h('span', {}, msg), h('button', { type: 'button', 'aria-label': 'Fermer' }, '×'));
    const close = () => t.remove();
    t.querySelector('button').addEventListener('click', close);
    host.append(t); while (host.children.length > 4) host.firstChild.remove();
    setTimeout(close, kind === 'bad' ? 6500 : 4200);
    return t;
  }
  const fail = (e) => { if (!(e && e.auth)) toast((e && e.message) || 'Erreur', 'bad'); };

  // ---------- Boîtes de dialogue (focus piégé, Échap, retour du focus) ----------
  function trap(root, onEsc) {
    const prev = document.activeElement;
    const sel = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
    const key = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); onEsc(); return; }
      if (e.key !== 'Tab') return;
      const f = [...root.querySelectorAll(sel)].filter((x) => x.offsetParent !== null);
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('keydown', key, true); if (prev && prev.focus && document.contains(prev)) prev.focus(); };
  }
  function ask(o) {
    return new Promise((resolve) => {
      let release;
      const close = (v) => { release(); ov.remove(); resolve(v); };
      const ta = o.reason ? h('textarea', { class: 'textarea', rows: '3', maxlength: '300', placeholder: o.reason.placeholder || '', 'aria-label': o.reason.label || 'Motif' }) : null;
      const err = h('p', { class: 'err', role: 'alert' });
      const ok = h('button', { class: 'btn ' + (o.danger ? 'danger' : 'primary'), type: 'button', onclick: () => {
        if (ta) { const v = ta.value.trim(); if (v.length < (o.reason.min || 3)) { err.textContent = o.reason.error || 'Écrivez le motif.'; ta.focus(); return; } ok.disabled = true; close({ reason: v }); } else { ok.disabled = true; close({}); }
      } }, o.confirmText || 'Confirmer');
      const ov = h('div', { class: 'mdl' }, h('div', { class: 'mdb', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'dlgT' },
        h('h2', { id: 'dlgT' }, o.title), (o.lines || []).map((l) => h('p', {}, l)), ta, err, h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: () => close(null) }, 'Annuler'), ok)));
      ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(null); });
      document.getElementById('overlays').append(ov);
      release = trap(ov, () => close(null));
      (ta || ok).focus();
    });
  }

  // ---------- Pastilles ----------
  const badge = (text, kind, plain) => h('span', { class: 'badge' + (kind ? ' ' + kind : '') + (plain ? ' plain' : '') }, text);
  const PLAN_KIND = { Gratuit: '', Pro: 'info', 'Pro Max': 'accent', 'Méga Pro': 'accent', 'Illimité': 'ok' };
  const planBadge = (p) => badge(p, PLAN_KIND[p] || 'accent', true);
  const STATE_KIND = { active: 'ok', expiring: 'warn', expired: 'bad', free: '' };
  const statusBadge = (st, labels, kinds) => badge(labels[st] || st, kinds[st] || '');

  // ---------- États vides et chargement ----------
  const empty = (ic, title, text, action) => h('div', { class: 'empty' }, h('div', { class: 'ei' }, icon(ic || 'inbox', 'lg')), h('b', {}, title), text ? h('p', {}, text) : null, action || null);
  const sk = (w, hh) => { const e = h('span', { class: 'sk' }); if (w) e.style.width = w; if (hh) e.style.height = hh; return e; };
  const skRows = (n) => h('div', { class: 'sk-rows', 'aria-busy': 'true', 'aria-label': 'Chargement' }, Array.from({ length: n || 5 }, () => h('span', { class: 'sk h' })));

  // ---------- Carte ----------
  const card = (title, right, ...body) => h('section', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', {}, title), right || null), h('div', { class: 'cb' }, body));
  const cardFlush = (title, right, ...body) => h('section', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', {}, title), right || null), h('div', { class: 'cb flush' }, body));

  // ---------- Tableau professionnel : tri, pagination, en-têtes collants, carte sur téléphone ----------
  function table(o) {
    const st = { sort: o.sort || null, page: 0, size: o.pageSize || 10, rows: o.rows || [] };
    const wrap = h('div', {});
    const tw = h('div', { class: 'tw' });
    const foot = h('div', { class: 'tfoot' });
    wrap.append(tw, foot);
    const val = (c, r) => (typeof c.sort === 'function' ? c.sort(r) : r[c.key]);
    function draw() {
      let rows = st.rows.slice();
      if (st.sort) {
        const c = o.cols.find((x) => x.key === st.sort.key);
        if (c) rows.sort((a, b) => { const x = val(c, a), y = val(c, b); const r = (x == null ? 1 : y == null ? -1 : typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'fr', { numeric: true })); return st.sort.dir === 'desc' ? -r : r; });
      }
      const total = rows.length, pages = Math.max(1, Math.ceil(total / st.size));
      if (st.page >= pages) st.page = pages - 1;
      const slice = rows.slice(st.page * st.size, st.page * st.size + st.size);
      if (!total) { tw.replaceChildren(o.empty || empty('inbox', 'Rien à afficher', '')); foot.classList.add('hidden'); return; }
      foot.classList.toggle('hidden', o.pager === false);
      const head = h('tr', {}, o.cols.map((c) => {
        const sortable = !!c.sort || (c.sort === undefined && c.key && c.sortable !== false && !c.act);
        const on = st.sort && st.sort.key === c.key;
        return h('th', { scope: 'col', class: c.cls || '', 'aria-sort': on ? (st.sort.dir === 'asc' ? 'ascending' : 'descending') : null },
          sortable && c.key ? h('button', { type: 'button', onclick: () => { st.sort = on && st.sort.dir === 'asc' ? { key: c.key, dir: 'desc' } : { key: c.key, dir: 'asc' }; draw(); } }, c.label, icon(on ? (st.sort.dir === 'asc' ? 'aup' : 'adown') : 'sort')) : (c.label || h('span', { class: 'sr' }, 'Actions')));
      }));
      const body = slice.map((r) => {
        const tr = h('tr', { class: (o.onRow ? 'clk ' : '') + (o.rowClass ? o.rowClass(r) : ''), tabindex: o.onRow ? '0' : null, 'data-k': o.rowKey ? o.rowKey(r) : null });
        if (o.onRow) { tr.addEventListener('click', (e) => { if (!e.target.closest('a,button,input,select,label')) o.onRow(r); }); tr.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target === tr) o.onRow(r); }); }
        for (const c of o.cols) tr.append(h('td', { class: [c.cls, c.main ? 'main-c' : '', c.act ? 'act-c' : ''].filter(Boolean).join(' '), 'data-label': c.main || c.act ? null : c.label }, c.render ? c.render(r) : r[c.key]));
        return tr;
      });
      tw.replaceChildren(h('table', { class: 'tbl' }, h('thead', {}, head), h('tbody', {}, body)));
      const from = st.page * st.size + 1, to = Math.min(total, from + st.size - 1);
      const sizeSel = h('select', { class: 'select sm', 'aria-label': 'Lignes par page', onchange: (e) => { st.size = Number(e.target.value); st.page = 0; draw(); } }, [10, 25, 50, 100].map((n) => h('option', { value: n, selected: n === st.size ? '' : null }, n + ' par page')));
      foot.replaceChildren(h('span', {}, fmtN(from) + '–' + fmtN(to) + ' sur ' + fmtN(total) + (o.noun ? ' ' + o.noun : '')),
        h('div', { class: 'pager' }, total > 10 ? sizeSel : null,
          h('button', { class: 'btn sm icon', type: 'button', 'aria-label': 'Page précédente', disabled: st.page === 0 ? '' : null, onclick: () => { st.page--; draw(); } }, icon('cleft')),
          h('span', { class: 'tnum' }, (st.page + 1) + ' / ' + pages),
          h('button', { class: 'btn sm icon', type: 'button', 'aria-label': 'Page suivante', disabled: st.page >= pages - 1 ? '' : null, onclick: () => { st.page++; draw(); } }, icon('cright'))));
    }
    draw();
    return { el: wrap, set(rows) { st.rows = rows || []; draw(); }, redraw: draw, state: st };
  }

  // ---------- Barre d'outils des listes ----------
  function searchBox(ph, onInput, value) {
    const i = h('input', { class: 'input', type: 'search', placeholder: ph, 'aria-label': ph, value: value || '', autocomplete: 'off' });
    let t; i.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => onInput(i.value.trim()), 220); });
    return { el: h('div', { class: 'search-in' }, icon('search'), i), input: i };
  }
  function select(label, opts, value, onChange) {
    const s = h('select', { class: 'select', 'aria-label': label }, opts.map(([v, l]) => h('option', { value: v, selected: String(v) === String(value) ? '' : null }, l)));
    s.addEventListener('change', () => onChange(s.value)); return s;
  }
  function checkbox(label, on, onChange) { const c = h('input', { type: 'checkbox', checked: on ? '' : null }); c.addEventListener('change', () => onChange(c.checked)); return h('label', { class: 'check' }, c, label); }

  Object.assign(A, { h, sv, svText, icon, ICONS, MOIS, MN, fmtN, fmtXAF, fmtCompact, fmtDate, fmtDateTime, fmtTime, ago, agoEl, duration, plural, initials, digits, store, theme, api, toast, fail, trap, ask, badge, planBadge, statusBadge, STATE_KIND, empty, sk, skRows, card, cardFlush, table, searchBox, select, checkbox });
})();
