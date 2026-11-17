'use strict';
// Graphiques en SVG, sans bibliothèque : axes avec valeurs et unités, grille légère, infobulles (souris, toucher et clavier), couleurs du thème.
(function () {
  const A = window.A, { h, sv, svText } = A;

  function niceStep(v) { if (v <= 0) return 1; const p = Math.pow(10, Math.floor(Math.log10(v))); const f = v / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p; }
  /** Graduations « rondes » de 0 au maximum : jamais de lignes inutiles, toujours lisibles. */
  function scale(max, want, o) {
    o = o || {};
    max = Math.max(max, o.min || 1);
    let step = niceStep(max / (want || 4));
    if (o.int) step = Math.max(1, Math.ceil(step));
    const top = Math.ceil(max / step - 1e-9) * step;
    const ticks = []; for (let v = 0; v <= top + step * 1e-6; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
    return { top, ticks };
  }

  /** Conteneur qui se redessine à la largeur réelle (texte toujours à la bonne taille, y compris sur téléphone). */
  function responsive(height, draw) {
    const box = h('div', { class: 'chart' });
    let last = 0;
    const render = () => { const W = Math.floor(box.clientWidth); if (W < 60) return; last = W; box.replaceChildren(); draw(box, W, W < 420 ? Math.round(height * 0.86) : height); };
    if (window.ResizeObserver) new ResizeObserver(() => { if (Math.abs(box.clientWidth - last) > 1) render(); }).observe(box); else setTimeout(render, 0);
    return box;
  }
  function tipper(box) {
    const tip = h('div', { class: 'tip hidden', role: 'status' });
    box.append(tip);
    return {
      show(x, y, title, lines) { tip.replaceChildren(h('b', {}, title), lines.map((l) => h('span', {}, l, h('br')))); tip.classList.remove('hidden'); const w = box.clientWidth, tw = tip.offsetWidth; tip.style.left = Math.min(Math.max(x, tw / 2 + 2), w - tw / 2 - 2) + 'px'; tip.style.top = y + 'px'; },
      hide() { tip.classList.add('hidden'); },
    };
  }
  /** Tableau de données lisible par les lecteurs d'écran (l'image seule ne dit pas les valeurs). */
  function srTable(caption, labels, series) {
    return h('table', { class: 'sr' }, h('caption', {}, caption), h('thead', {}, h('tr', {}, h('th', {}, 'Période'), series.map((s) => h('th', {}, s.name)))),
      h('tbody', {}, labels.map((l, i) => h('tr', {}, h('th', { scope: 'row' }, l), series.map((s) => h('td', {}, s.fmt(s.values[i]))))))
    );
  }

  /**
   * Barres verticales. o = { labels, values, unit, fmtAxis, fmtFull, name, height, title }
   */
  function bars(o) {
    const fmtAxis = o.fmtAxis || A.fmtCompact, fmtFull = o.fmtFull || A.fmtN;
    const box = responsive(o.height || 240, (el, W, H) => {
      const sc = scale(Math.max(...o.values, 0), 4, { min: o.minTop, int: o.int });
      const labW = Math.max(...sc.ticks.map((t) => fmtAxis(t).length)) * 6.6 + 12;
      const m = { l: Math.max(34, labW), r: 8, t: 22, b: 26 }, iw = W - m.l - m.r, ih = H - m.t - m.b;
      const n = o.values.length, band = iw / n, bw = Math.min(46, band * 0.58);
      const y = (v) => m.t + ih - (v / sc.top) * ih;
      const kids = [];
      if (o.unit) kids.push(svText({ x: 0, y: 10, class: 'ax', 'text-anchor': 'start' }, o.unit));
      sc.ticks.forEach((t) => { kids.push(sv('line', { x1: m.l, x2: W - m.r, y1: y(t), y2: y(t), class: 'g' }), svText({ x: m.l - 8, y: y(t) + 4, class: 'ax y' }, fmtAxis(t))); });
      const tp = tipper(el);
      o.values.forEach((v, i) => {
        const cx = m.l + band * i + band / 2, bh = Math.max(v > 0 ? 2 : 0, ih - (y(v) - m.t));
        const r = sv('rect', { x: cx - bw / 2, y: m.t + ih - bh, width: bw, height: bh, rx: 4, class: 'bar' });
        kids.push(r, svText({ x: cx, y: H - 8, class: 'ax x' }, o.labels[i]));
        const hit = sv('rect', { x: cx - band / 2, y: m.t, width: band, height: ih + 4, class: 'hit', tabindex: '0', 'aria-label': (o.longLabels ? o.longLabels[i] : o.labels[i]) + ' : ' + fmtFull(v) + (o.unit ? ' ' + o.unit : '') });
        const on = () => { r.classList.add('on'); tp.show(cx, y(v) + 2, o.longLabels ? o.longLabels[i] : o.labels[i], [fmtFull(v) + (o.unit ? ' ' + o.unit : '')]); };
        const off = () => { r.classList.remove('on'); tp.hide(); };
        hit.addEventListener('pointerenter', on); hit.addEventListener('pointerleave', off); hit.addEventListener('focus', on); hit.addEventListener('blur', off);
        kids.push(hit);
      });
      el.prepend(sv('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': o.title || '' }, kids));
      el.append(srTable(o.title || 'Données', o.longLabels || o.labels, [{ name: o.name || 'Valeur', values: o.values, fmt: (v) => fmtFull(v) + (o.unit ? ' ' + o.unit : '') }]));
    });
    return box;
  }

  /**
   * Courbe avec aire. o = { labels, values, longLabels, unit, name, height, title, tickEvery }
   */
  function line(o) {
    const fmtFull = o.fmtFull || A.fmtN;
    return responsive(o.height || 240, (el, W, H) => {
      const sc = scale(Math.max(...o.values, 0), 4, { min: o.minTop, int: o.int });
      const m = { l: Math.max(30, String(sc.top).length * 7 + 14), r: 12, t: 22, b: 26 }, iw = W - m.l - m.r, ih = H - m.t - m.b;
      const n = o.values.length, x = (i) => m.l + (n === 1 ? iw / 2 : (iw * i) / (n - 1)), y = (v) => m.t + ih - (v / sc.top) * ih;
      const kids = [];
      if (o.unit) kids.push(svText({ x: 0, y: 10, class: 'ax', 'text-anchor': 'start' }, o.unit));
      sc.ticks.forEach((t) => { kids.push(sv('line', { x1: m.l, x2: W - m.r, y1: y(t), y2: y(t), class: 'g' }), svText({ x: m.l - 8, y: y(t) + 4, class: 'ax y' }, A.fmtCompact(t))); });
      const every = o.tickEvery || Math.max(1, Math.ceil(n / Math.max(2, Math.floor(iw / 64))));
      o.labels.forEach((l, i) => { if (i % every === (n - 1) % every) kids.push(svText({ x: x(i), y: H - 8, class: 'ax x' }, l)); });
      const pts = o.values.map((v, i) => [x(i), y(v)]);
      kids.push(sv('path', { d: 'M' + pts.map((p) => p.join(',')).join(' L') + ` L${x(n - 1)},${m.t + ih} L${x(0)},${m.t + ih} Z`, class: 'area' }), sv('path', { d: 'M' + pts.map((p) => p.join(',')).join(' L'), class: 'ln' }));
      const cross = sv('line', { y1: m.t, y2: m.t + ih, class: 'cross hidden' }), dot = sv('circle', { r: 4.5, class: 'pt hidden' });
      kids.push(cross, dot);
      const tp = tipper(el);
      const at = (i) => { cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.classList.remove('hidden'); dot.setAttribute('cx', x(i)); dot.setAttribute('cy', y(o.values[i])); dot.classList.remove('hidden'); tp.show(x(i), y(o.values[i]), o.longLabels ? o.longLabels[i] : o.labels[i], [fmtFull(o.values[i]) + (o.unit ? ' ' + o.unit : '')]); };
      const off = () => { cross.classList.add('hidden'); dot.classList.add('hidden'); tp.hide(); };
      const hit = sv('rect', { x: m.l, y: m.t, width: iw, height: ih, class: 'hit', tabindex: '0', 'aria-label': o.title || 'Courbe' });
      const idx = (ev) => { const r = hit.getBoundingClientRect(); return Math.min(n - 1, Math.max(0, Math.round(((ev.clientX - r.left) / r.width) * (n - 1)))); };
      hit.addEventListener('pointermove', (ev) => at(idx(ev))); hit.addEventListener('pointerleave', off); hit.addEventListener('blur', off);
      let ki = n - 1; hit.addEventListener('focus', () => at(ki));
      hit.addEventListener('keydown', (ev) => { if (ev.key === 'ArrowLeft') { ki = Math.max(0, ki - 1); at(ki); ev.preventDefault(); } else if (ev.key === 'ArrowRight') { ki = Math.min(n - 1, ki + 1); at(ki); ev.preventDefault(); } });
      kids.push(hit);
      el.prepend(sv('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': o.title || '' }, kids));
      el.append(srTable(o.title || 'Données', o.longLabels || o.labels, [{ name: o.name || 'Valeur', values: o.values, fmt: (v) => fmtFull(v) + (o.unit ? ' ' + o.unit : '') }]));
    });
  }

  /** Mini-courbe d'un indicateur (sans axes). */
  function spark(values) {
    const W = 96, H = 36, p = 3;
    const mx = Math.max(...values, 1), n = values.length;
    if (n < 2) return sv('svg', { class: 'sp', viewBox: `0 0 ${W} ${H}`, 'aria-hidden': 'true' });
    const pts = values.map((v, i) => [p + ((W - 2 * p) * i) / (n - 1), H - p - ((H - 2 * p) * v) / mx]);
    const d = 'M' + pts.map((q) => q[0].toFixed(1) + ',' + q[1].toFixed(1)).join(' L');
    return sv('svg', { class: 'sp spark', viewBox: `0 0 ${W} ${H}`, 'aria-hidden': 'true', focusable: 'false' }, [sv('path', { d: d + ` L${W - p},${H - p} L${p},${H - p} Z`, class: 'a' }), sv('path', { d, class: 'l' })]);
  }

  /** Anneau. segs = [{ label, value, cls: 's1'..'s5' }] ; mid = [grand texte, petit texte] */
  function donut(segs, mid) {
    const R = 66, C = 2 * Math.PI * R, tot = Math.max(1, segs.reduce((a, s) => a + s.value, 0));
    let off = 0;
    const kids = [sv('circle', { cx: 85, cy: 85, r: R, fill: 'none', 'stroke-width': 22, class: 'trk' })];
    segs.forEach((s) => { const l = (C * s.value) / tot; if (s.value > 0) kids.push(sv('circle', { cx: 85, cy: 85, r: R, fill: 'none', 'stroke-width': 22, class: 'k ' + s.cls, 'stroke-dasharray': l.toFixed(2) + ' ' + (C - l).toFixed(2), 'stroke-dashoffset': (-off).toFixed(2), transform: 'rotate(-90 85 85)' }, [])); off += l; });
    return h('div', { class: 'donut', role: 'img', 'aria-label': segs.map((s) => s.label + ' : ' + s.value).join(', ') }, sv('svg', { viewBox: '0 0 170 170', 'aria-hidden': 'true' }, kids), h('div', { class: 'mid' }, h('b', {}, mid[0]), h('small', {}, mid[1])));
  }

  A.charts = { bars, line, spark, donut, scale };
})();
