'use strict';
// Vignettes des sous-applications (800x520, JPEG) pour le site vitrine, à partir de l'espace de travail de démonstration.
// Chrome headless piloté par CDP (Node 24 : WebSocket et fetch natifs, aucune dépendance) ; conversion avec « sips » (macOS).
//   Usage : node scripts/demo/capture.js [identifiant ...]      (sans argument : les 22 vignettes)
// Prérequis : voir scripts/demo/README.md (backend sur :3100, frontend sur :5199, graine passée).
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SITE = process.env.DEMO_SITE || 'http://127.0.0.1:5199';
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DEMO_DIR = process.env.DEMO_DIR || '/private/tmp/claude-501/demo';
const PROFILE = path.join(DEMO_DIR, 'chrome-prof');
const RAW = path.join(DEMO_DIR, 'raw');
const OUT = process.env.MODS_OUT || path.join(os.homedir(), 'Downloads/manager-ia-frontend/public/assets/mods');
const PORT = 9333;
const QUALITY = Number(process.env.JPEG_QUALITY) || 66; // poids total du dossier <= 1,5 Mo
const LOGIN = { contact: 'demo@exemple.com', pass: 'secret123' };
const VIEW = { width: 1280, height: 760 };

// Réglages par écran : steps = textes des boutons à cliquer dans l'ordre (onglet, fiche à ouvrir…), scroll = titre à amener en haut de la zone,
// clean = retirer les cartes vides, css = style de capture supplémentaire. Sans réglage : l'écran tel qu'il s'ouvre.
const MODS = [
  { id: 'dashboard' }, { id: 'sales', steps: ['Conversations'] }, { id: 'support', steps: ['En attente', 'Mireille'] }, { id: 'stock' }, { id: 'crm' }, { id: 'hr' }, { id: 'projects' }, { id: 'budget' },
  { id: 'accounting', css: '.kpis{grid-template-columns:repeat(3,1fr)!important}' }, { id: 'payroll' }, { id: 'fiscal' }, { id: 'marketing' }, { id: 'logistics' }, { id: 'production' }, { id: 'construction', steps: ['Ouvrir'] },
  { id: 'maintenance' }, { id: 'legal' }, { id: 'memory', scroll: 'Notes' }, { id: 'agents', scroll: 'Les agents' }, { id: 'alerts', clean: true }, { id: 'structure' }, { id: 'processes', steps: ['Réception'] },
];
// Les chiffres des tuiles ne se coupent plus au milieu d'un mot (« FC / FA ») : seul le retour à la ligne change, pas la mise en page.
const CSS = '.ws-fab,#pwa-install,.ws-scrim{display:none!important}*{caret-color:transparent!important}.kpi b,.stat b{overflow-wrap:normal!important}.kpi b{font-size:24px!important}';

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

async function main() {
  const wanted = process.argv.slice(2);
  const list = wanted.length ? MODS.filter((m) => wanted.includes(m.id)) : MODS;
  fs.mkdirSync(RAW, { recursive: true });
  fs.mkdirSync(OUT, { recursive: true });
  const chrome = await startChrome();
  try {
    const tabs = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = tabs.find((t) => t.type === 'page');
    const c = cdp(page.webSocketDebuggerUrl);
    await c.ready;
    await c.send('Page.enable'); await c.send('Runtime.enable');
    await c.send('Emulation.setDeviceMetricsOverride', { width: VIEW.width, height: VIEW.height, deviceScaleFactor: 2, mobile: false });
    // Aucun bandeau d'installation ni bouton flottant sur les captures
    await c.send('Page.addScriptToEvaluateOnNewDocument', { source: `try{localStorage.setItem('mi_pwa_no','1')}catch(e){}
      document.addEventListener('DOMContentLoaded',()=>{const s=document.createElement('style');s.textContent=${JSON.stringify(CSS)};document.head.appendChild(s);});` });
    const nav = async (url) => { await c.send('Page.navigate', { url }); await sleep(600); };

    // Connexion (même appel que le formulaire de connexion), puis ouverture de l'espace de travail
    await nav(`${SITE}/connexion`);
    const login = await c.evaluate(`fetch('/api/login',{method:'POST',credentials:'include',headers:{'content-type':'application/json'},body:JSON.stringify(${JSON.stringify(LOGIN)})}).then(r=>r.status)`);
    if (login !== 200) throw new Error('Connexion refusée (' + login + ').');
    const orgId = await c.evaluate(`fetch('/api/ws/orgs',{credentials:'include'}).then(r=>r.json()).then(j=>(j.orgs.find(o=>o.name==='Boutique Awa')||j.orgs[0]).id)`);
    await nav(`${SITE}/app`);
    console.log('Organisation ' + orgId);

    for (const m of list) {
      const cfg = m;
      await nav(`${SITE}/app/${orgId}/${m.id}`);
      // Attente de la fin du chargement : plus de « Chargement… », contenu présent et stable
      let last = ''; let stable = 0;
      for (let i = 0; i < 80 && stable < 3; i++) {
        await sleep(350);
        const s = await c.evaluate(`(()=>{const m=document.querySelector('.ws-main');if(!m)return 'x';const t=m.innerText||'';return (/Chargement/.test(t)?'L':'')+t.length+':'+m.scrollHeight})()`);
        if (!/^L|^x/.test(s) && s === last) stable++; else stable = 0;
        last = s;
      }
      for (const step of cfg.steps || []) {
        const clicked = await c.evaluate(`(()=>{const t=${JSON.stringify(step.toLowerCase())};const b=[...document.querySelectorAll('.ws-main button, .ws-main [role=tab], .ws-main a, .ws-main summary')].find(e=>(e.innerText||'').trim().toLowerCase().startsWith(t));if(!b)return false;b.click();return true})()`);
        if (!clicked) console.log('  ! élément introuvable : ' + step);
        await sleep(1300);
      }
      // Fermer panneau IA, fenêtres et bandeaux éventuels
      await c.evaluate(`(()=>{document.body.classList.remove('ai-open');document.querySelectorAll('.ws-ai .x,.ws-ai-close,[aria-label="Fermer"]').forEach(b=>{try{b.click()}catch(e){}});window.scrollTo(0,0);})()`);
      if (cfg.css) await c.evaluate(`(()=>{const s=document.createElement('style');s.textContent=${JSON.stringify(cfg.css)};document.head.appendChild(s)})()`);
      if (cfg.clean) await c.evaluate(`document.querySelectorAll('.ws-main > * *').forEach(e=>{if(!e.children.length&&!(e.innerText||'').trim()&&e.getBoundingClientRect().height>20&&e.getBoundingClientRect().height<90)e.style.display='none'})`);
      if (cfg.scroll) {
        await c.evaluate(`(()=>{const t=${JSON.stringify(cfg.scroll.toLowerCase())};const h=[...document.querySelectorAll('.ws-main h2,.ws-main h3')].find(e=>(e.innerText||'').trim().toLowerCase().startsWith(t));if(h){const bar=document.querySelector('.ws-top2').getBoundingClientRect().bottom;window.scrollBy(0,h.getBoundingClientRect().top-bar-24)}})()`);
        await sleep(400);
      }
      await sleep(cfg.settle || 900);
      // Zone de contenu = .ws-main (sans menu latéral, ni barre du haut, ni bouton flottant masqué)
      const box = await c.evaluate(`(()=>{const r=document.querySelector('.ws-main').getBoundingClientRect();const b=document.querySelector('.ws-top2').getBoundingClientRect().bottom;return {x:r.x+scrollX,y:b+scrollY,w:r.width,h:r.height}})()`);
      const cw = Math.min(cfg.cropWidth || box.w, box.w);
      const ch = Math.round(cw * 520 / 800);
      const clip = { x: box.x, y: box.y, width: cw, height: ch, scale: 1 };
      const shot = await c.send('Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: false });
      const png = path.join(RAW, `${m.id}.png`);
      fs.writeFileSync(png, Buffer.from(shot.data, 'base64'));
      // 2 x 1020 px -> 800 x 520 (même rapport 1,538 : pas de déformation), JPEG
      execFileSync('sips', ['-z', '520', '800', '--setProperty', 'format', 'jpeg', '--setProperty', 'formatOptions', String(QUALITY), png, '--out', path.join(OUT, `${m.id}.jpg`)], { stdio: 'ignore' });
      console.log(`  ${m.id}.jpg  (${Math.round(cw)}x${Math.round(clip.height)} css, ${fs.statSync(path.join(OUT, `${m.id}.jpg`)).size} octets)`);
    }
    c.close();
  } finally { chrome.kill(); }
  const total = fs.readdirSync(OUT).filter((f) => f.endsWith('.jpg')).reduce((a, f) => a + fs.statSync(path.join(OUT, f)).size, 0);
  console.log(`Dossier ${OUT} : ${Math.round(total / 1024)} Ko`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
