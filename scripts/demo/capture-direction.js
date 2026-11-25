'use strict';
// Captures des espaces de direction (clair / sombre / mobile) depuis la démonstration (scripts/demo-direction.js, site sur :5420).
// Chrome headless piloté par CDP, sans dépendance.  Usage : node scripts/demo/capture-direction.js
const { spawn } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path');
const SITE = process.env.DEMO_SITE || 'http://127.0.0.1:5420';
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DEMO_DIR = process.env.DEMO_DIR || '/private/tmp/claude-501/demo-direction';
const OUT = process.env.OUT || path.join(__dirname, '../../docs/captures-direction');
const PORT = 9334; const PASS = 'Essai-2026-brij';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SCENES = [
  { id: '01-directeur-commercial', user: 'dcom@exemple.com', path: 'dir_commercial' },
  { id: '02-vendeur-espace-role', user: 'vendeur@exemple.com', path: 'crm' },
  { id: '03-directeur-visiteur-equipe', user: 'dcom@exemple.com', path: 'commercial' },
  { id: '04-assistante-espace-role', user: 'assist@exemple.com', path: 'sales' },
  { id: '05-marketeuse-espace-role', user: 'mkt@exemple.com', path: 'marketing' },
  { id: '06-comptable-espace-role', user: 'cpt@exemple.com', path: 'accounting' },
  { id: '07-affaires', user: 'respco@exemple.com', path: 'affaires' },
];
const MODES = [['clair', 1280, 800, false, 'light'], ['sombre', 1280, 800, false, 'dark'], ['mobile', 390, 844, true, 'light']];
function cdp(url) {
  const ws = new WebSocket(url); let id = 0; const pend = new Map();
  ws.onmessage = (m) => { const j = JSON.parse(m.data); if (j.id && pend.has(j.id)) { const { res, rej } = pend.get(j.id); pend.delete(j.id); j.error ? rej(new Error(j.error.message)) : res(j.result); } };
  const ready = new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDP')); });
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async (e) => { const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error('JS ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description)); return r.result.value; };
  return { ready, send, evaluate };
}
async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const prof = path.join(DEMO_DIR, 'chrome-prof'); fs.rmSync(prof, { recursive: true, force: true }); fs.mkdirSync(prof, { recursive: true });
  const child = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${prof}`, '--no-first-run', '--disable-extensions', '--hide-scrollbars', '--force-color-profile=srgb', 'about:blank'], { stdio: 'ignore' });
  try {
    for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) break; } catch { /* */ } await sleep(250); }
    const page = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page');
    const c = cdp(page.webSocketDebuggerUrl); await c.ready; await c.send('Page.enable'); await c.send('Runtime.enable');
    await c.send('Page.addScriptToEvaluateOnNewDocument', { source: `try{localStorage.setItem('mi_pwa_no','1')}catch(e){};document.addEventListener('DOMContentLoaded',()=>{const s=document.createElement('style');s.textContent='.ws-fab,#pwa-install{display:none!important}*{caret-color:transparent!important}';document.head.appendChild(s)})` });
    const nav = async (u) => { await c.send('Page.navigate', { url: u }); await sleep(800); };
    let current = '';
    for (const sc of SCENES) {
      if (current !== sc.user) {
        await nav(`${SITE}/connexion`);
        const st = await c.evaluate(`fetch('/api/logout',{method:'POST',credentials:'include'}).catch(()=>0).then(()=>fetch('/api/login',{method:'POST',credentials:'include',headers:{'content-type':'application/json'},body:JSON.stringify({contact:${JSON.stringify(sc.user)},pass:${JSON.stringify(PASS)}})}).then(r=>r.status))`);
        if (st !== 200) throw new Error('Connexion refusée ' + sc.user + ' ' + st);
        current = sc.user;
      }
      for (const [name, w, h, mobile, scheme] of MODES) {
        await c.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1.5, mobile });
        await c.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
        await c.evaluate(`try{localStorage.setItem('theme',${JSON.stringify(scheme)});localStorage.setItem('mi_theme',${JSON.stringify(scheme)})}catch(e){}`);
        await nav(`${SITE}/app/1/${sc.path}`);
        for (let i = 0; i < 40; i++) { await sleep(400); const s = await c.evaluate(`(document.querySelector('.ws-main')?document.querySelector('.ws-main').innerText.length:0)+':'+/Chargement/.test(document.body.innerText)`); if (!/true$/.test(s) && Number(s.split(':')[0]) > 80) break; }
        await c.evaluate(`(()=>{for(const t of ['tout refuser','plus tard',"c'est noté","j'ai compris"]){for(const b of document.querySelectorAll('button')){if((b.innerText||'').trim().toLowerCase()===t)b.click()}}})()`);
        await sleep(1800);
        await c.evaluate(`(()=>{for(const t of ['tout refuser','plus tard',"c'est noté","j'ai compris"]){for(const b of document.querySelectorAll('button')){if((b.innerText||'').trim().toLowerCase()===t)b.click()}}})()`);
        await sleep(500);
        await sleep(900);
        const shot = await c.send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(path.join(OUT, `${sc.id}-${name}.png`), Buffer.from(shot.data, 'base64'));
        console.log('OK ' + sc.id + '-' + name);
      }
    }
  } finally { child.kill(); }
}
main().catch((e) => { console.error(e); process.exit(1); });
void os;
