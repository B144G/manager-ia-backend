'use strict';
// Espaces par rôle · captures de chaque type de rôle (Chrome headless piloté par CDP, sans dépendance). Prérequis : scripts/demo/README.md + scripts/demo/espaces-seed.js.
//   Usage : DEMO_SITE=http://127.0.0.1:5399 node scripts/demo/espaces-captures.js [dossier de sortie]
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const SITE = process.env.DEMO_SITE || 'http://127.0.0.1:5399';
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DEMO_DIR = process.env.DEMO_DIR || '/private/tmp/claude-501/demo';
const OUT = process.argv[2] || path.join(__dirname, '../../docs/captures-espaces');
const PORT = 9344;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const U = (tag) => ({ contact: tag === 'demo' ? 'demo@exemple.com' : `${tag}@exemple.com`, pass: 'secret123' });

// { f: fichier, u: compte, p: chemin (ORG = n° de l'organisation), dark, mobile, js: action avant capture }
const SHOTS = [
  { f: '01-comptable-accueil-comptabilite', u: 'aicha', p: '/app' },
  { f: '02-responsable-commercial-accueil', u: 'boris', p: '/app' },
  { f: '03-responsable-stock-accueil', u: 'carine', p: '/app' },
  { f: '04-rh-accueil', u: 'david', p: '/app' },
  { f: '05-production-accueil', u: 'estelle', p: '/app' },
  { f: '06-directeur-vue-ensemble', u: 'felix', p: '/app' },
  { f: '07-multi-roles-choix-espace', u: 'gisele', p: '/app' },
  { f: '08-multi-roles-choix-espace-sombre', u: 'gisele', p: '/app', dark: true },
  { f: '09-sans-affectation-projets', u: 'hugo', p: '/app' },
  { f: '10-visiteur-consultation-seule', u: 'aicha', p: '/app/ORG/crm' },
  { f: '11-ecran-hors-espaces', u: 'aicha', p: '/app/ORG/hr' },
  { f: '12-proprietaire-direction', u: 'demo', p: '/app' },
  { f: '13-proprietaire-affectation-equipe', u: 'demo', p: '/app/ORG/team', js: "document.getElementById('spaces-admin').scrollIntoView()" },
  { f: '14-mobile-comptable-accueil', u: 'aicha', p: '/app', mobile: true },
  { f: '15-mobile-comptable-menu', u: 'aicha', p: '/app', mobile: true, js: "document.querySelector('.app-bottom button[aria-label]').click()" },
  { f: '16-mobile-visiteur', u: 'aicha', p: '/app/ORG/crm', mobile: true },
  { f: '17-comptable-sombre', u: 'aicha', p: '/app', dark: true },
  { f: '18-palette-comptable', u: 'aicha', p: '/app', js: "document.dispatchEvent(new KeyboardEvent('keydown',{key:'k',ctrlKey:true,bubbles:true}));window.dispatchEvent(new KeyboardEvent('keydown',{key:'k',ctrlKey:true,bubbles:true}))" },
];

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl); let id = 0; const pending = new Map();
  ws.onmessage = (m) => { const j = JSON.parse(m.data); if (j.id && pending.has(j.id)) { const { res, rej } = pending.get(j.id); pending.delete(j.id); j.error ? rej(new Error(j.error.message)) : res(j.result); } };
  const ready = new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('WebSocket CDP')); });
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error('JS : ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description)); return r.result.value; };
  return { ready, send, evaluate, close: () => ws.close() };
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const prof = path.join(DEMO_DIR, 'chrome-prof-esp'); fs.rmSync(prof, { recursive: true, force: true });
  const child = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${prof}`, '--no-first-run', '--disable-extensions', '--hide-scrollbars', '--force-color-profile=srgb', '--window-size=1280,800', 'about:blank'], { stdio: 'ignore' });
  try {
    for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) break; } catch { /* */ } await sleep(250); }
    const page = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page');
    const c = cdp(page.webSocketDebuggerUrl); await c.ready;
    await c.send('Page.enable'); await c.send('Runtime.enable'); await c.send('Network.enable');
    await c.send('Page.addScriptToEvaluateOnNewDocument', { source: `try{localStorage.setItem('mi_pwa_no','1')}catch(e){};document.addEventListener('DOMContentLoaded',()=>{const s=document.createElement('style');s.textContent='.ws-fab,#pwa-install{display:none!important}*{caret-color:transparent!important}';document.head.appendChild(s);});` });
    const nav = async (url) => { await c.send('Page.navigate', { url }); await sleep(700); };
    let orgId = null; const jars = {}; // une connexion par compte (la limite de connexions du serveur est volontairement basse)
    for (const s of SHOTS) {
      await c.send('Network.clearBrowserCookies');
      await c.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: s.dark ? 'dark' : 'light' }] });
      if (s.mobile) await c.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 2, mobile: true }); else await c.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 2, mobile: false });
      await nav(`${SITE}/connexion`);
      if (!jars[s.u]) {
        const st = await c.evaluate(`fetch('/api/login',{method:'POST',credentials:'include',headers:{'content-type':'application/json'},body:JSON.stringify(${JSON.stringify(U(s.u))})}).then(r=>r.status)`);
        if (st !== 200) throw new Error(`connexion ${s.u} : ${st}`);
        jars[s.u] = (await c.send('Network.getCookies', { urls: [SITE] })).cookies;
      } else await c.send('Network.setCookies', { cookies: jars[s.u].map((k) => ({ name: k.name, value: k.value, url: SITE, httpOnly: k.httpOnly, path: '/' })) });
      if (!orgId) orgId = await c.evaluate("fetch('/api/ws/orgs',{credentials:'include'}).then(r=>r.json()).then(j=>j.orgs[0].id)");
      await nav(`${SITE}${s.p.replace('ORG', orgId)}`);
      let last = ''; let stable = 0;
      for (let i = 0; i < 60 && stable < 3; i++) { await sleep(350); const v = await c.evaluate("(()=>{const m=document.querySelector('.ws-main');return m?((/Chargement/.test(m.innerText)?'L':'')+m.innerText.length):'x'})()"); if (!/^[Lx]/.test(v) && v === last) stable++; else stable = 0; last = v; }
      // bandeaux de démonstration (cookies, visite guidée, avis d'appareil) fermés comme le ferait la personne
      await c.evaluate("[...document.querySelectorAll('button')].filter((b)=>/^(Tout refuser|Plus tard|C.est noté)$/.test(b.textContent.trim())).forEach((b)=>b.click())"); await sleep(500);
      if (s.js) { await c.evaluate(`(()=>{${s.js}})()`); await sleep(700); }
      const url = await c.evaluate('location.pathname');
      const { data } = await c.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(OUT, s.f + '.png'), Buffer.from(data, 'base64'));
      console.log(s.f.padEnd(44), s.u.padEnd(8), url);
    }
    c.close();
  } finally { child.kill(); }
})().catch((e) => { console.error(e.message); process.exit(1); });
