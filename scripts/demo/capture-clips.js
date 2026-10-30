'use strict';
// Captures 16:9 pour la vidéo (PNG 1920x1080 @2x = 3840x2160 ; mobile 390x844 @3), en français, à partir de l'espace de démonstration.
// Chrome headless piloté par CDP (Node 24 : WebSocket et fetch natifs, aucune dépendance) ; conversion avec « sips » (macOS).
//   Usage : node scripts/demo/capture-clips.js [numéro ...]      (sans argument : les 8 captures). Sortie : CLIPS_OUT
// Prérequis : voir scripts/demo/README.md (backend sur :3100, frontend sur :5199, graine passée).
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SITE = process.env.DEMO_SITE || 'http://127.0.0.1:5199';
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DEMO_DIR = process.env.DEMO_DIR || '/private/tmp/claude-501/demo';
const PROFILE = path.join(DEMO_DIR, 'chrome-prof');
const OUT = process.env.CLIPS_OUT || path.join(os.homedir(), 'Downloads/MANAGER-IA/captures-clips');
const PORT = 9334;
const LOGIN = { contact: 'demo@exemple.com', pass: 'secret123' };
const VIEW = { width: 1920, height: 1080 };
const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';


const CSS = '#sa-btn,.ws-fab,#pwa-install,.ws-scrim{display:none!important}*{caret-color:transparent!important}';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Client CDP minimal ----------
function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0; const pending = new Map();
  ws.onmessage = (m) => { const j = JSON.parse(m.data); if (j.id && pending.has(j.id)) { const { res, rej } = pending.get(j.id); pending.delete(j.id); j.error ? rej(new Error(j.error.message)) : res(j.result); } };
  const ready = new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('WebSocket CDP')); });
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('JS : ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
    return r.result.value;
  };
  return { ready, send, evaluate, close: () => ws.close() };
}

async function startChrome() {
  fs.rmSync(PROFILE, { recursive: true, force: true });
  fs.mkdirSync(PROFILE, { recursive: true });
  const child = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1', '--hide-scrollbars', '--force-color-profile=srgb', `--window-size=${VIEW.width},${VIEW.height}`, 'about:blank',
  ], { stdio: 'ignore' });
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) return child; } catch { /* pas prêt */ }
    await sleep(250);
  }
  child.kill();
  throw new Error('Chrome ne démarre pas.');
}


// Captures : mod = module, steps = textes des boutons à cliquer dans l'ordre (dans la page entière, fenêtres comprises),
// mobile = émulation téléphone. Le script reste réutilisable : la graine de démonstration fournit les données.
const SHOTS = [
  { n: '01-tableau-de-bord', mod: 'dashboard', zoom: 0.76, css: '.ws-side{height:calc(100vh/0.76)!important}.ws-shell,.ws{min-height:calc(100vh/0.76)}' },
  { n: '02-assistant-commandes', mod: 'sales', steps: ['Commandes'] },
  { n: '03-assistant-conversations', mod: 'sales', steps: ['Conversations'], chat: true },
  { n: '04-assistant-campagnes', mod: 'sales', steps: ['Campagnes'] },
  { n: '05-assistant-catalogue', mod: 'sales', steps: ['Catalogue'] },
  { n: '06-assistant-rendez-vous', mod: 'sales', steps: ['Rendez-vous'] },
  { n: '07-alertes', mod: 'alerts', css: 'p.ai-out:empty{display:none!important}.alrow.cut{display:none!important}', hide: 'Résumé du matin', keep: ['.alrow', 7] },
  { n: '08-mobile-conversation', mod: 'sales', steps: ['Conversations'], chat: true, mobile: true },
  // Sources de la vidéo du site (sous-dossier video/) : sécurité, site public, écrans mobiles
  // Captures de la publicité (prep = données d'exemple ajoutées par l'API avant la prise de vue ; rowBtn = [texte de la ligne, texte du bouton])
  { n: '15-facture-tva', prep: 'facture', view: { width: 940, height: 1020 }, css: '.ip .bar,.ip .warn{display:none!important}.ip{padding-top:30px}' },
  { n: '16-stock-lots', mod: 'stock', prep: 'stock', rowBtn: ['Huile de palme', 'Lots'] },
  { n: '17-stock-vin', mod: 'stock', prep: 'stock', rowBtn: ['Moto utilitaire', 'Num'] },
  { n: '18-factures-paiements', mod: 'crm', steps: ['Factures'] },
  { n: 'video/09-securite', mod: 'dashboard', click: 'button[aria-label="Sécurité du compte"]', view: { width: 1440, height: 900 } },
  { n: 'video/10-site-ordinateur', url: '/', view: { width: 1440, height: 900 } },
  { n: 'video/11-site-mobile', url: '/', mobile: true },
  { n: 'video/12-mobile-tableau', mod: 'dashboard', mobile: true },
  { n: 'video/13-mobile-paie', mod: 'payroll', mobile: true },
  { n: 'video/14-mobile-chantiers', mod: 'construction', mobile: true },
];

async function waitLoaded(c) {
  let last = ''; let stable = 0;
  for (let i = 0; i < 80 && stable < 3; i++) {
    await sleep(350);
    const s = await c.evaluate(`(()=>{const m=document.querySelector('.ws-main');if(!m)return 'x';const t=m.innerText||'';return (/Chargement|Loading/.test(t)?'L':'')+t.length+':'+m.scrollHeight})()`);
    if (!/^L|^x/.test(s) && s === last) stable++; else stable = 0;
    last = s;
  }
}
const clickText = (c, txt, root) => c.evaluate(`(()=>{const t=${JSON.stringify(txt.toLowerCase())};const b=[...document.querySelectorAll(${JSON.stringify(root || '.ws-main')}+' button,'+${JSON.stringify(root || '.ws-main')}+' [role=tab],'+${JSON.stringify(root || '.ws-main')}+' a')].find(e=>(e.innerText||'').trim().toLowerCase().startsWith(t));if(!b)return false;b.click();return true})()`);

// Données d'exemple pour la publicité (idempotent) : mentions de facture, paiement Mobile Money, articles suivis par lot et par numéro de série.
async function prep(c, kind, orgId) {
  const call = (m, u, b) => c.evaluate(`fetch('/api/ws/orgs/${orgId}'+${JSON.stringify(u)},{method:${JSON.stringify(m)},credentials:'include',headers:{'content-type':'application/json'},body:${b === undefined ? 'undefined' : JSON.stringify(JSON.stringify(b))}}).then(async r=>({s:r.status,j:await r.json().catch(()=>({}))}))`);
  if (kind === 'facture' || kind === 'paiement') {
    await call('PUT', '/crm/invoice-settings', { niu: 'M000000000000A', rccm: '', address: 'Avenue exemple, Douala (adresse d\'exemple)', vatRate: '19.25', payInfo: 'MTN MoMo : 670 00 00 00 (exemple)\nOrange Money : 690 00 00 00 (exemple)', footer: 'Données d\'exemple.' });
    const docs = (await call('GET', '/crm/documents')).j.documents;
    const d = docs.find((x) => x.kind === 'invoice' && /Nad/.test(x.customer || ''));
    if (!d) throw new Error('facture d\'exemple introuvable');
    const pays = (await call('GET', '/crm/documents/' + d.id + '/payments')).j.payments || [];
    if (!pays.length) { const r = await call('POST', '/crm/documents/' + d.id + '/payments', { amount: 40000, method: 'mtn_momo', reference: 'MP260000123', status: 'confirmed' }); if (r.s >= 300) throw new Error('paiement : ' + JSON.stringify(r.j)); }
    return `/imprimer/${orgId}/${d.id}`;
  }
  if (kind === 'stock') {
    const items = (await call('GET', '/stock')).j.items || [];
    if (!items.find((i) => /Huile de palme/.test(i.name))) {
      const e = new Date(Date.now() + 200 * 864e5).toISOString().slice(0, 10), e2 = new Date(Date.now() + 25 * 864e5).toISOString().slice(0, 10);
      const a = await call('POST', '/stock/items', { name: 'Huile de palme raffinée (bidon 5 L)', unit: 'bidon', quantity: 0, minQuantity: 10, unitCost: 6500, tracking: 'lot', pickRule: 'fefo' });
      await call('POST', '/stock/items/' + a.j.id + '/move', { kind: 'in', quantity: 24, lotNo: 'LOT-2026-A', expiry: e, reason: 'Réception' });
      await call('POST', '/stock/items/' + a.j.id + '/move', { kind: 'in', quantity: 8, lotNo: 'LOT-2026-B', expiry: e2, reason: 'Réception' });
      const b = await call('POST', '/stock/items', { name: 'Moto utilitaire 125 cc', unit: 'unité', quantity: 0, minQuantity: 1, unitCost: 650000, tracking: 'serial' });
      await call('POST', '/stock/items/' + b.j.id + '/move', { kind: 'in', serials: 'EXEMPLE0000000001\nEXEMPLE0000000002\nEXEMPLE0000000003\nEXEMPLE0000000004', reason: 'Réception' });
    }
  }
  return null;
}

async function main() {
  const wanted = process.argv.slice(2);
  const list = wanted.length ? SHOTS.filter((s) => wanted.some((w) => s.n.replace(/^video\//, '').startsWith(w.padStart(2, '0')))) : SHOTS;
  fs.mkdirSync(OUT, { recursive: true });
  const chrome = await startChrome();
  try {
    const tabs = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = tabs.find((t) => t.type === 'page');
    const c = cdp(page.webSocketDebuggerUrl);
    await c.ready;
    await c.send('Page.enable'); await c.send('Runtime.enable');
    // Aucun bandeau d'installation ni bouton flottant ; langue par défaut (mia-lang jamais défini)
    await c.send('Page.addScriptToEvaluateOnNewDocument', { source: `try{localStorage.setItem('mi_pwa_no','1');localStorage.removeItem('mia-lang')}catch(e){}
      document.addEventListener('DOMContentLoaded',()=>{const s=document.createElement('style');s.textContent=${JSON.stringify(CSS)};document.head.appendChild(s);});` });
    const nav = async (url) => { await c.send('Page.navigate', { url }); await sleep(800); };

    await nav(`${SITE}/connexion`);
    const login = await c.evaluate(`fetch('/api/login',{method:'POST',credentials:'include',headers:{'content-type':'application/json'},body:JSON.stringify(${JSON.stringify(LOGIN)})}).then(r=>r.status)`);
    if (login !== 200) throw new Error('Connexion refusée (' + login + ').');
    const orgId = await c.evaluate(`fetch('/api/ws/orgs',{credentials:'include'}).then(r=>r.json()).then(j=>(j.orgs.find(o=>o.name==='Boutique Awa')||j.orgs[0]).id)`);
    console.log('Organisation ' + orgId);

    for (const s of list) {
      if (s.mobile) {
        await c.send('Emulation.setUserAgentOverride', { userAgent: MOBILE_UA });
        await c.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
      } else {
        await c.send('Emulation.setUserAgentOverride', { userAgent: '' });
        await c.send('Emulation.setDeviceMetricsOverride', { width: (s.view || VIEW).width, height: (s.view || VIEW).height, deviceScaleFactor: 2, mobile: false });
      }
      const pu = s.prep ? await prep(c, s.prep, orgId) : null;
      await nav(pu ? SITE + pu : s.url ? SITE + s.url : `${SITE}/app/${orgId}/${s.mod}`);
      await waitLoaded(c);
      if (s.click) { await c.evaluate(`document.querySelector(${JSON.stringify(s.click)}).click()`); await sleep(1200); }
      if (s.rowBtn) {
        const ok = await c.evaluate(`(()=>{const r=[...document.querySelectorAll('.ws-main .line,.ws-main tr,.ws-main li,.ws-main .card')].filter(e=>(e.innerText||'').includes(${JSON.stringify(s.rowBtn[0])})).pop();if(!r)return false;const b=[...r.querySelectorAll('button,a')].find(x=>(x.innerText||'').trim().startsWith(${JSON.stringify(s.rowBtn[1])}));if(!b)return false;b.click();return true})()`);
        if (!ok) console.log('  ! ligne/bouton introuvable : ' + s.rowBtn.join(' / '));
        await sleep(1500);
      }
      for (const step of s.steps || []) {
        if (!await clickText(c, step)) console.log('  ! introuvable : ' + step);
        await sleep(1200); await waitLoaded(c);
      }
      if (s.chat) {
        // Ouvre la conversation la plus riche : on lit chaque « Lire » et on garde celle qui compte le plus de messages
        const n = await c.evaluate(`document.querySelectorAll('.ws-main .line .link').length`);
        let best = 0; let bestLen = -1;
        for (let i = 0; i < n; i++) {
          await c.evaluate(`document.querySelectorAll('.ws-main .line .link')[${i}].click()`);
          await sleep(1200);
          const len = await c.evaluate(`(()=>{const l=document.body.innerText.length;const x=[...document.querySelectorAll('button')].find(b=>/^(fermer|close)/i.test((b.innerText||'').trim())||b.getAttribute('aria-label')==='Fermer');if(x)x.click();return l})()`);
          await sleep(500);
          if (len > bestLen) { bestLen = len; best = i; }
        }
        await c.evaluate(`document.querySelectorAll('.ws-main .line .link')[${best}].click()`);
        await sleep(1500);
        console.log('  conversation ouverte : n° ' + best + ' sur ' + n);
      }
      // zoom : l'écran entier tient dans la page 16:9 ; css : style de capture propre à l'écran
      if (s.css) await c.evaluate(`(()=>{const e=document.createElement('style');e.textContent=${JSON.stringify(s.css)};document.head.appendChild(e)})()`);
      // hide : masque la carte dont le titre commence par ce texte (hors sujet pour la vidéo)
      if (s.hide) await c.evaluate(`(()=>{const h=[...document.querySelectorAll('.ws-main h2,.ws-main h3')].find(e=>(e.innerText||'').trim().startsWith(${JSON.stringify(s.hide)}));if(h){const k=h.closest('.dc,.ws-card,section')||h.parentElement;k.style.display='none'}})()`);
      // keep : ne garde que les n premiers éléments d'une liste (fin de liste coupée proprement)
      if (s.keep) await c.evaluate(`[...document.querySelectorAll(${JSON.stringify(s.keep[0])})].slice(${s.keep[1]}).forEach(e=>e.classList.add('cut'))`);
      if (s.zoom) { await c.evaluate(`document.body.style.zoom=${s.zoom}`); await sleep(800); }
      await c.evaluate(`(()=>{document.body.classList.remove('ai-open');window.scrollTo(0,0)})()`);
      await sleep(900);
      const shot = await c.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      const file = path.join(OUT, `${s.n}.png`); fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
      console.log('  ' + s.n + '.png (' + fs.statSync(file).size + ' octets)');
    }
    c.close();
  } finally { chrome.kill(); }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
