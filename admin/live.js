'use strict';
// Nouveaux comptes en direct : flux d'événements serveur (SSE, session administrateur) avec repli automatique par interrogation courte.
//  - le serveur envoie un battement de cœur toutes les 20 s (le proxy de Render coupe les connexions muettes) ;
//  - sans nouvelle depuis 45 s, ou en cas d'erreur, on interroge /live/accounts toutes les 12 s et on retente le flux toutes les 30 s ;
//  - notifications : message dans la page, notification du navigateur (après un clic de permission), son discret activable.
(function () {
  const A = window.A;
  const POLL_MS = 12000, DEAD_MS = 45000, RETRY_MS = 30000;
  const L = (A.live = {
    st: { accounts: [], pending: [], totals: { users: 0, pending: 0 }, lastId: 0, summary: null, verifyOn: false, mode: 'off', receivedAt: 0, ready: false },
    seenId: A.store.get('seen', null),
    prefs: { sound: A.store.get('sound', false), notif: A.store.get('notif', false) },
  });
  const subs = {};
  L.on = (evt, fn) => { (subs[evt] = subs[evt] || new Set()).add(fn); return () => subs[evt].delete(fn); };
  const emit = (evt, d) => { for (const fn of [...(subs[evt] || [])]) { try { fn(d); } catch (e) { /* un abonné fautif ne bloque pas les autres */ } } };

  let es = null, poll = null, dead = null, retry = null, running = false, lastEvt = 0;

  function setMode(m) { if (L.st.mode !== m) { L.st.mode = m; emit('mode', m); } }
  L.unseen = () => (L.seenId == null ? 0 : L.st.accounts.filter((a) => a.id > L.seenId).length);
  L.markSeen = () => { const m = Math.max(L.st.lastId, L.seenId || 0); if (L.seenId !== m) { L.seenId = m; A.store.set('seen', m); emit('seen'); } };
  L.pendingAge = (p) => p.ageSec + Math.max(0, (Date.now() - L.st.receivedAt) / 1000);

  function ingestSnapshot(s) {
    const first = !L.st.ready;
    Object.assign(L.st, { pending: s.pending, totals: s.totals, summary: s.summary, verifyOn: s.verifyOn, receivedAt: Date.now() });
    const known = new Set(L.st.accounts.map((a) => a.id));
    const fresh = s.accounts.filter((a) => !known.has(a.id));
    if (first) { L.st.accounts = s.accounts; L.st.lastId = s.lastId; L.st.ready = true; if (L.seenId == null) { L.seenId = s.lastId; A.store.set('seen', s.lastId); } }
    else for (const a of fresh.sort((x, y) => x.id - y.id)) addAccount(a, true, true);
    emit('pending', L.st.pending); emit('summary', L.st.summary); emit('snapshot', L.st);
  }
  function addAccount(a, announce, inTotals) {
    if (L.st.accounts.some((x) => x.id === a.id)) return;
    L.st.accounts = [a, ...L.st.accounts].sort((x, y) => y.id - x.id).slice(0, 20);
    if (!inTotals) L.st.totals.users++; L.st.lastId = Math.max(L.st.lastId, a.id);
    if (announce) { announceAccount(a); emit('account', a); }
  }

  // ---------- Notifications ----------
  function beep() {
    try {
      const C = window.AudioContext || window.webkitAudioContext; if (!C) return;
      const ctx = L.ctx || (L.ctx = new C()); if (ctx.state === 'suspended') ctx.resume();
      const t = ctx.currentTime;
      [[660, 0], [880, 0.13]].forEach(([f, d]) => { const o = ctx.createOscillator(), g = ctx.createGain(); o.type = 'sine'; o.frequency.value = f; o.connect(g); g.connect(ctx.destination); g.gain.setValueAtTime(0.0001, t + d); g.gain.exponentialRampToValueAtTime(0.06, t + d + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.22); o.start(t + d); o.stop(t + d + 0.25); });
    } catch (e) { /* son indisponible */ }
  }
  function announceAccount(a) {
    A.toast('Nouveau compte : ' + a.name + ' (' + a.plan + ')', 'ok');
    if (L.prefs.sound) beep();
    if (L.prefs.notif && 'Notification' in window && Notification.permission === 'granted' && (document.hidden || !document.hasFocus())) {
      try { new Notification('Nouveau compte Brij-IA', { body: a.name + ' · ' + a.plan + (a.interests.length ? ' · ' + a.interests.slice(0, 3).join(', ') : ''), tag: 'brij-acc-' + a.id }); } catch (e) { /* ignoré */ }
    }
  }
  L.notifSupported = () => 'Notification' in window;
  L.notifState = () => (!L.notifSupported() ? 'indisponible' : Notification.permission === 'denied' ? 'refusée' : Notification.permission === 'granted' && L.prefs.notif ? 'active' : 'inactive');
  L.setNotif = async (on) => {
    if (!L.notifSupported()) { A.toast('Votre navigateur ne gère pas les notifications.', 'bad'); return; }
    if (on && Notification.permission !== 'granted') { const p = await Notification.requestPermission(); if (p !== 'granted') { A.toast('Notifications refusées : autorisez-les dans les réglages du navigateur.', 'bad'); L.prefs.notif = false; A.store.set('notif', false); emit('prefs'); return; } }
    L.prefs.notif = on; A.store.set('notif', on); emit('prefs');
    if (on) A.toast('Notifications du navigateur activées.', 'ok');
  };
  L.setSound = (on) => { L.prefs.sound = on; A.store.set('sound', on); if (on) beep(); emit('prefs'); };

  // ---------- Transport ----------
  async function fetchSnapshot() {
    try { const s = await A.api('/live/accounts'); ingestSnapshot(s); return true; } catch (e) { if (e.auth) L.stop(); return false; }
  }
  function startPoll() { if (poll || !running) return; setMode('poll'); poll = setInterval(fetchSnapshot, POLL_MS); }
  function stopPoll() { if (poll) { clearInterval(poll); poll = null; } }
  function armDead() { clearTimeout(dead); dead = setTimeout(() => { closeEs(); startPoll(); scheduleRetry(); }, DEAD_MS); }
  function closeEs() { if (es) { es.onopen = es.onerror = null; es.close(); es = null; } clearTimeout(dead); }
  function scheduleRetry() { clearTimeout(retry); if (running) retry = setTimeout(openEs, RETRY_MS); }
  function openEs() {
    if (!running || es) return;
    if (!window.EventSource) { startPoll(); return; }
    es = new EventSource('/api/admin/live/stream');
    es.onopen = () => { lastEvt = Date.now(); armDead(); };
    const on = (evt, fn) => es.addEventListener(evt, (m) => { lastEvt = Date.now(); armDead(); stopPoll(); setMode('sse'); try { fn(JSON.parse(m.data)); } catch (e) { /* message illisible */ } });
    on('hello', ingestSnapshot);
    on('account', (a) => addAccount(a, true));
    on('pending', (p) => { L.st.pending = p.pending; L.st.totals.pending = p.totals.pending; L.st.receivedAt = Date.now(); emit('pending', L.st.pending); });
    on('summary', (s) => { L.st.summary = s; emit('summary', s); });
    on('ping', () => {});
    es.addEventListener('bye', () => { closeEs(); fetchSnapshot(); startPoll(); scheduleRetry(); });
    es.onerror = () => {
      // Le navigateur retente seul tant que le flux n'est pas fermé ; en attendant, on interroge. Fermé (401, 429…) : on revérifie la session puis on retente plus tard.
      startPoll();
      if (es && es.readyState === 2) { closeEs(); scheduleRetry(); }
    };
    armDead();
  }

  L.start = async () => {
    if (running) return;
    running = true;
    await fetchSnapshot();
    openEs();
    document.addEventListener('visibilitychange', onVis);
  };
  L.stop = () => {
    running = false; closeEs(); stopPoll(); clearTimeout(retry); setMode('off'); L.st.ready = false; L.st.accounts = []; L.st.pending = [];
    document.removeEventListener('visibilitychange', onVis);
  };
  function onVis() { if (!document.hidden && running) { fetchSnapshot(); if (!es) openEs(); } }
  /** Pour les tests de navigateur : simule une coupure du flux. */
  L._cut = () => { closeEs(); startPoll(); };
})();
