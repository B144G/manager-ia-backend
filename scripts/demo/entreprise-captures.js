'use strict';
// Compte d'entreprise · captures (clair, sombre, mobile 375 px) : organigramme, personnes, assistant, informations, journal, vue d'un employé.
// Chrome headless piloté par CDP, sans dépendance. Prérequis : scripts/demo/README.md + scripts/demo/entreprise-seed.js.
//   Usage : DEMO_SITE=http://127.0.0.1:5410 node scripts/demo/entreprise-captures.js [dossier de sortie]
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const SITE = process.env.DEMO_SITE || 'http://127.0.0.1:5410';
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DEMO_DIR = process.env.DEMO_DIR || '/private/tmp/claude-501/demo';
const OUT = process.argv[2] || path.join(__dirname, '../../docs/captures-entreprise');
const PORT = 9351;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const U = (tag) => ({ contact: tag === 'demo' ? 'demo@exemple.com' : `${tag}@exemple.com`, pass: 'secret123' });

// { f: fichier, u: compte, p: chemin (ORG = n° de l'organisation), dark, mobile, js: action avant capture }
const clk = (txt) => `[...document.querySelectorAll('button,a,[role=tab]')].find((b)=>b.textContent.trim().startsWith(${JSON.stringify(txt)})).click()`;
const SHOTS = [
  { f: '01-organigramme-clair', u: 'demo', p: '/app/ORG/entreprise' },
  { f: '02-organigramme-sombre', u: 'demo', p: '/app/ORG/entreprise', dark: true },
  { f: '03-organigramme-mobile', u: 'demo', p: '/app/ORG/entreprise', mobile: true },
  { f: '04-organigramme-mobile-sombre', u: 'demo', p: '/app/ORG/entreprise', mobile: true, dark: true },
  { f: '05-personnes-clair', u: 'demo', p: '/app/ORG/entreprise', js: clk('Personnes') },
  { f: '06-personnes-mobile', u: 'demo', p: '/app/ORG/entreprise', mobile: true, js: clk('Personnes') },
  { f: '07-informations-clair', u: 'demo', p: '/app/ORG/entreprise', js: clk('Entreprise') },
  { f: '08-informations-sombre', u: 'demo', p: '/app/ORG/entreprise', dark: true, js: clk('Entreprise') },
  { f: '09-journal', u: 'demo', p: '/app/ORG/entreprise', js: clk('Journal') },
  { f: '10-assistant-reprise-clair', u: 'demo', p: '/app/ORG/entreprise', js: clk('Reprendre la configuration') },
  { f: '11-assistant-reprise-sombre', u: 'demo', p: '/app/ORG/entreprise', dark: true, js: clk('Reprendre la configuration') },
  { f: '12-assistant-reprise-mobile', u: 'demo', p: '/app/ORG/entreprise', mobile: true, js: clk('Reprendre la configuration') },
  { f: '13-assistant-informations', u: 'demo', p: '/app/ORG/entreprise', js: clk('Reprendre la configuration') + ";setTimeout(()=>" + clk("L'entreprise") + ",400)" },
  { f: '14-assistant-directions', u: 'demo', p: '/app/ORG/entreprise', js: clk('Reprendre la configuration') + ";setTimeout(()=>" + clk('Directions') + ",400)" },
  { f: '15-assistant-departements', u: 'demo', p: '/app/ORG/entreprise', js: clk('Reprendre la configuration') + ";setTimeout(()=>" + clk('Départements et postes') + ",400)" },
  { f: '16-assistant-employes-mobile', u: 'demo', p: '/app/ORG/entreprise', mobile: true, js: clk('Reprendre la configuration') },
  { f: '17-comptable-voit-organigramme', u: 'aicha', p: '/app/ORG/entreprise' },
  { f: '18-comptable-accueil-espace', u: 'aicha', p: '/app' },
  { f: '19-employe-sans-poste', u: 'hugo', p: '/app' },
  { f: '20-employe-sans-poste-organigramme', u: 'hugo', p: '/app/ORG/entreprise' },
  { f: '21-equipe-lien-configurer', u: 'demo', p: '/app/ORG/team' },
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
  const prof = path.join(DEMO_DIR, 'chrome-prof-ent'); fs.rmSync(prof, { recursive: true, force: true });
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
