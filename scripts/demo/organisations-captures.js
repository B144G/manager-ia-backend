'use strict';
// Organisations et confidentialité · captures (clair, sombre, mobile 375 px) par Chrome headless piloté par CDP, sans dépendance.
// Prérequis : scripts/demo/README.md + scripts/demo/seed.js + scripts/demo/organisations-seed.js.
//   Usage : DEMO_SITE=http://127.0.0.1:5611 node scripts/demo/organisations-captures.js <orgs|privacy> <dossier de sortie> [prefixe]
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const SITE = process.env.DEMO_SITE || 'http://127.0.0.1:5611';
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DEMO_DIR = process.env.DEMO_DIR || '/private/tmp/claude-501/demo';
const GROUP = process.argv[2]; const OUT = process.argv[3]; const PREFIX = process.argv[4] || '';
const PORT = 9361;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clk = (txt) => `[...document.querySelectorAll('button,a,[role=tab]')].find((b)=>b.textContent.trim().startsWith(${JSON.stringify(txt)})).click()`;
const sec = `document.querySelector('[aria-label="Sécurité du compte"]').click()`;
const U = { contact: 'demo@exemple.com', pass: 'secret123' };

// f : fichier ; p : chemin (ORG = n° de l'organisation) ; dark, mobile, full (page entière) ; js : action avant capture ; u : autre compte
const variants = (f, p, o = {}) => [{ f: f + '-clair', p, ...o }, { f: f + '-sombre', p, dark: true, ...o }, { f: f + '-mobile', p, mobile: true, ...o }];
const SHOTS = {
  orgs: [
    ...variants('01-entreprise-onglets', '/app/ORG/entreprise'),
    ...variants('02-tableau-organisations', '/app/ORG/entreprise', { js: clk('Organisations') + ";setTimeout(()=>document.querySelector('.og-bar').scrollIntoView(),500)" }),
    { f: '03-tableau-recherche-clair', p: '/app/ORG/entreprise', js: clk('Organisations') + ";setTimeout(()=>{const i=document.querySelector('.orgs-search input');const s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;s.call(i,'douala');i.dispatchEvent(new Event('input',{bubbles:true}))},500)" },
    ...variants('04-transfert', '/app/ORG/entreprise', { js: clk('Organisations') + ";setTimeout(()=>" + clk('Transférer') + ",600)" }),
    ...variants('05-suppression', '/app/ORG/entreprise', { js: clk('Organisations') + ";setTimeout(()=>" + clk('Supprimer') + ",600)" }),
    ...variants('05b-suppression-liee', '/app/ORG/entreprise', { js: clk('Organisations') + ";setTimeout(()=>document.querySelector('[aria-label=\"Supprimer Atelier Awa\"]').click(),600)" }),
    ...variants('06-zone-danger', '/app/ORG/entreprise', { js: "[...document.querySelectorAll('[role=tab]')].find((b)=>b.textContent.trim()==='Entreprise').click()" + ";setTimeout(()=>document.querySelector('.org-danger').scrollIntoView(),600)", full: true }),
    { f: '07-membre-lecture-seule-clair', p: '/app/ORG/entreprise', u: 'lea', js: clk('Organisations') },
  ],
  privacy: [
    ...variants('01-apercu', '/app/confidentialite', { full: true }),
    ...variants('02-consentements', '/app/confidentialite/consentements', { full: true }),
    ...variants('03-export', '/app/confidentialite/export', { full: true }),
    ...variants('04-suppression', '/app/confidentialite/suppression', { full: true }),
    ...variants('05-mot-de-passe', '/app/confidentialite/securite', { full: true }),
    ...variants('06-double-authentification', '/app/confidentialite/securite', { full: true, js: clk('Activer la double') }),
    ...variants('07-sessions-appareils', '/app/confidentialite/securite', { full: true, js: "document.querySelector('#sec-sessions')&&document.querySelector('#sec-sessions').scrollIntoView()" }),
    ...variants('08-journal', '/app/confidentialite/journal', { full: true }),
    ...variants('09-organisation', '/app/confidentialite/organisation', { full: true }),
    ...variants('10-fenetre-securite-compte', '/app/ORG/dashboard', { js: sec }),
  ],
  'privacy-avant': [
    ...variants('01-centre-confidentialite', '/app/confidentialite', { full: true }),
    ...variants('02-fenetre-securite-compte', '/app/ORG/dashboard', { js: sec }),
    ...variants('03-confidentialite-organisation', '/app/confidentialite/organisation', { full: true }),
  ],
  'orgs-avant': [
    ...variants('01-ecran-entreprise', '/app/ORG/entreprise'),
    ...variants('02-entreprise-informations', '/app/ORG/entreprise', { js: clk('Entreprise') }),
  ],
}[GROUP];
const ONLY = process.env.ONLY ? new RegExp(process.env.ONLY) : null;
if (ONLY && SHOTS) for (let i = SHOTS.length - 1; i >= 0; i--) if (!ONLY.test(SHOTS[i].f)) SHOTS.splice(i, 1);
if (!SHOTS || !OUT) { console.error('Usage : organisations-captures.js <orgs|privacy|privacy-avant|orgs-avant> <dossier> [prefixe]'); process.exit(1); }

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
  const prof = path.join(DEMO_DIR, 'chrome-prof-orgs'); fs.rmSync(prof, { recursive: true, force: true });
  const child = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${prof}`, '--no-first-run', '--disable-extensions', '--hide-scrollbars', '--force-color-profile=srgb', '--window-size=1280,800', 'about:blank'], { stdio: 'ignore' });
  try {
    for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) break; } catch { /* */ } await sleep(250); }
    const page = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page');
    const c = cdp(page.webSocketDebuggerUrl); await c.ready;
    await c.send('Page.enable'); await c.send('Runtime.enable'); await c.send('Network.enable');
    await c.send('Page.addScriptToEvaluateOnNewDocument', { source: `try{localStorage.setItem('mi_pwa_no','1')}catch(e){};document.addEventListener('DOMContentLoaded',()=>{const s=document.createElement('style');s.textContent='.ws-fab,#pwa-install{display:none!important}*{caret-color:transparent!important}';document.head.appendChild(s);});` });
    const nav = async (url) => { await c.send('Page.navigate', { url }); await sleep(700); };
    const jars = {}; let orgId = null;
    for (const s of SHOTS) {
      await c.send('Network.clearBrowserCookies');
      await c.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: s.dark ? 'dark' : 'light' }] });
      const W = s.mobile ? 375 : 1280; const H = s.mobile ? 812 : 800;
      await c.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: s.mobile ? 2 : 1.5, mobile: Boolean(s.mobile) });
      await nav(`${SITE}/connexion`);
      const who = s.u || 'demo'; const cred = who === 'demo' ? U : { contact: `${who}@exemple.com`, pass: 'secret123' };
      if (!jars[who]) {
        const st = await c.evaluate(`fetch('/api/login',{method:'POST',credentials:'include',headers:{'content-type':'application/json'},body:JSON.stringify(${JSON.stringify(cred)})}).then(r=>r.status)`);
        if (st !== 200) throw new Error(`connexion ${who} : ${st}`);
        jars[who] = (await c.send('Network.getCookies', { urls: [SITE] })).cookies;
      } else await c.send('Network.setCookies', { cookies: jars[who].map((k) => ({ name: k.name, value: k.value, url: SITE, httpOnly: k.httpOnly, path: '/' })) });
      const myOrgs = await c.evaluate("fetch('/api/ws/orgs',{credentials:'include'}).then(r=>r.json()).then(j=>j.orgs.map(o=>o.id))");
      orgId = myOrgs[0];
      // thème : la préférence de la personne (clair / sombre) suit le système ; on force aussi l'attribut pour les écrans qui le lisent
      await nav(`${SITE}${s.p.replace('ORG', orgId)}`);
      await c.evaluate(`document.documentElement.setAttribute('data-theme','${s.dark ? 'dark' : 'light'}')`);
      let last = ''; let stable = 0;
      for (let i = 0; i < 60 && stable < 3; i++) { await sleep(350); const v = await c.evaluate("(()=>{const m=document.querySelector('.ws-main')||document.querySelector('.ws-center')||document.body;return (/Chargement/.test(m.innerText)?'L':'')+m.innerText.length})()"); if (!/^L/.test(v) && v === last) stable++; else stable = 0; last = v; }
      await c.evaluate("[...document.querySelectorAll('button')].filter((b)=>/^(Tout refuser|Plus tard|C.est noté)$/.test(b.textContent.trim())).forEach((b)=>b.click())"); await sleep(500);
      if (s.js) { await c.evaluate(`(()=>{${s.js}})()`); await sleep(1000); }
      const params = { format: 'png' };
      if (s.full) {
        const h = await c.evaluate("Math.max(document.documentElement.scrollHeight,document.body.scrollHeight,...[...document.querySelectorAll('.ws-center,.ws-main,main')].map(e=>e.scrollHeight))");
        const hh = Math.min(Math.max(h, H), 3200);
        await c.send('Emulation.setDeviceMetricsOverride', { width: W, height: hh, deviceScaleFactor: s.mobile ? 2 : 1.5, mobile: Boolean(s.mobile) }); await sleep(400);
      }
      const { data } = await c.send('Page.captureScreenshot', params);
      fs.writeFileSync(path.join(OUT, PREFIX + s.f + '.png'), Buffer.from(data, 'base64'));
      console.log((PREFIX + s.f).padEnd(48), await c.evaluate('location.pathname'));
    }
    c.close();
  } finally { child.kill(); }
})().catch((e) => { console.error(e.message); process.exit(1); });
