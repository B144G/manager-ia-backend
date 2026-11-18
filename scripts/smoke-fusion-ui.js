'use strict';
// Test de fumée de l'interface fusionnée, dans un vrai navigateur (Chrome + puppeteer-core), sur le serveur de démonstration (scripts/demo-local.js).
// Ouvre CHAQUE module, puis chaque onglet / entrée de menu des modules nouveaux de la fusion, relève : erreurs de page, erreurs console, réponses HTTP >= 500
// (et 4xx inattendus), écrans cassés, écrans vides, débordements horizontaux, et enregistre des captures dans docs/fusion/captures/.
// Contrôle aussi le téléphone (375 px) et les textes restés en français quand la langue est l'anglais.
//
// Usage : SITE=http://127.0.0.1:5190 API=http://127.0.0.1:3130 node scripts/smoke-fusion-ui.js
//   (serveur : `PORT=3130 node scripts/demo-local.js` ; site : `npx vite --port 5190` avec le proxy vers le port du serveur — voir docs/fusion/RAPPORT-FUSION-MODULES.md)
const fs = require('fs');
const path = require('path');

const SITE = process.env.SITE || 'http://127.0.0.1:5190';
const API = process.env.API || 'http://127.0.0.1:3130';
const OUT = process.env.OUT || path.join(__dirname, '..', 'docs', 'fusion', 'captures');
const PUPPETEER = process.env.PUPPETEER_CORE || '/Users/macboockpro/Downloads/MANAGER-IA/video-brij-ia-problemes/node_modules/puppeteer-core';
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const puppeteer = require(PUPPETEER);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SHOTS = process.env.SHOTS !== '0';
const MAX_TABS = Number(process.env.MAX_TABS || 60);

// Tous les modules de l'espace de travail (ouverture simple) ; ceux de la fusion sont parcourus onglet par onglet avec captures.
const ALL = ['dashboard', 'support', 'projects', 'budget', 'stock', 'purchasing', 'crm', 'sales', 'commercial', 'aifollow', 'hr', 'talents', 'payroll', 'fiscal', 'marketing', 'logistics', 'production', 'construction', 'maintenance', 'legal', 'memory', 'library', 'agents', 'accounting', 'treasury', 'meetings', 'structure', 'processes', 'team', 'history', 'alerts', 'integrations', 'administration', 'billing'];
const NEW = (process.env.NEW_MODULES || 'projects,production,meetings,history,treasury,talents,administration,library,commercial,billing').split(',');

const issues = []; let current = ''; const seen = [];
const note = (kind, msg) => { const m = `${current} | ${kind} | ${String(msg).slice(0, 240)}`; if (!issues.includes(m)) issues.push(m); };
const slug = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'x';

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const b = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
  const p = await b.newPage();
  p.on('pageerror', (e) => note('ERREUR-PAGE', e.message));
  p.on('console', (m) => { if (m.type() === 'error' && !/status of (401|403|404)|Failed to load resource.*(401|403)/.test(m.text())) note('CONSOLE', m.text()); });
  p.on('response', (r) => { const s = r.status(); const u = r.url().replace(/^https?:\/\/[^/]+/, ''); if (s >= 500) note('HTTP-' + s, u); else if (s >= 400 && ![401, 403, 404].includes(s) && /\/api\//.test(u)) note('HTTP-' + s, u); });
  const shot = async (name, full) => { if (!SHOTS) return; try { await p.screenshot({ path: path.join(OUT, name + '.jpg'), type: 'jpeg', quality: 55, fullPage: !!full }); } catch (e) { note('CAPTURE', e.message); } };
  const closeTour = () => p.evaluate(() => { for (const t of ['Tout refuser', "C'est noté", 'Reject all']) { const y = [...document.querySelectorAll('button')].find((e) => e.textContent.trim() === t); if (y) y.click(); } const x = [...document.querySelectorAll('button')].find((e) => ['Plus tard', 'Later'].includes(e.textContent.trim())); if (x) x.click(); });
  const state = () => p.evaluate(() => ({
    broken: /n'a pas pu s'afficher|could not be displayed/.test(document.body.innerText),
    err: (document.querySelector('.ws-mod .ws-err') || {}).innerText || '',
    w: document.documentElement.scrollWidth, vw: innerWidth,
    len: (document.querySelector('.ws-main') || document.body).innerText.length,
    blank: !document.querySelector('#root') || document.querySelector('#root').children.length === 0,
  }));
  const judge = (st, ctx) => { if (st.blank) note('ECRAN-BLANC', ctx); if (st.broken) note('ECRAN-CASSE', ctx); if (st.err) note('MESSAGE-ERREUR', st.err); if (st.w > st.vw + 1) note('DEBORDEMENT', `${st.w} > ${st.vw}`); if (st.len < 60) note('VIDE', `peu de contenu (${st.len})`); };

  await p.setViewport({ width: 1280, height: 900 });
  // Vitrine et pages légales.
  current = 'VITRINE /'; await p.goto(SITE + '/', { waitUntil: 'networkidle2' }).catch((e) => note('NAV', e.message)); await sleep(1000);
  if (!(await p.evaluate(() => (document.querySelector('h1') || {}).innerText))) note('VIDE', 'pas de titre H1'); seen.push('vitrine');
  // Connexion propriétaire (comptes d'essai de demo-local.js).
  current = 'CONNEXION'; await p.goto(SITE + '/connexion', { waitUntil: 'networkidle2' }); await sleep(600);
  const inputs = await p.$$('input'); await inputs[0].type('proprietaire@exemple.com'); await inputs[1].type('Essai-2026-brij');
  await Promise.all([p.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => {}), p.click('button[type=submit]')]); await sleep(2000);
  if (!/\/app/.test(p.url())) { note('CONNEXION', 'pas de redirection vers /app : ' + p.url()); }

  await p.evaluate(() => { for (const t of ['Tout refuser', "C'est noté"]) { const x = [...document.querySelectorAll('button')].find((e) => e.textContent.trim() === t); if (x) x.click(); } });
  // 1. Tous les modules, une ouverture.
  for (const m of ALL) {
    current = 'MODULE ' + m;
    await p.goto(`${SITE}/app/1/${m}`, { waitUntil: 'networkidle2' }).catch((e) => note('NAV', e.message)); await sleep(1300); await closeTour();
    judge(await state(), m); seen.push(m);
    if (NEW.includes(m)) await shot(`${m}--accueil`);
  }

  // 2. Modules de la fusion : chaque onglet / entrée de menu, avec capture.
  for (const m of NEW) {
    await p.goto(`${SITE}/app/1/${m}`, { waitUntil: 'networkidle2' }).catch(() => {}); await sleep(1000); await closeTour();
    const TABSEL = '.msh-item, .ws-tabs .tab, .ws-tabs button, [role=tab]';
    const expandAll = () => p.evaluate(() => { document.querySelectorAll('.msh-gh[aria-expanded=false]').forEach((g) => g.click()); });
    await expandAll(); await sleep(300);
    const labels = await p.evaluate((s) => [...new Set([...document.querySelectorAll(s)].filter((e) => !/↗/.test(e.textContent) && !e.getAttribute('aria-disabled')).map((e) => e.textContent.trim().replace(/\s+/g, ' ').slice(0, 40)))], TABSEL);
    for (let i = 0; i < Math.min(labels.length, MAX_TABS); i++) {
      const label = labels[i];
      await expandAll(); await sleep(150);
      const clicked = await p.evaluate((s, l) => { const el = [...document.querySelectorAll(s)].find((e) => e.textContent.trim().replace(/\s+/g, ' ').slice(0, 40) === l); if (!el) return false; el.scrollIntoView(); el.click(); return true; }, TABSEL, label);
      if (!clicked) continue;
      current = `MODULE ${m} › ${label}`; await sleep(900);
      judge(await state(), `${m} › ${label}`); seen.push(`${m}›${label}`);
      await shot(`${m}--${String(i).padStart(2, '0')}-${slug(label)}`);
      if (!new RegExp(`/app/1/${m}`).test(p.url())) { await p.goto(`${SITE}/app/1/${m}`, { waitUntil: 'networkidle2' }).catch(() => {}); await sleep(700); await closeTour(); }
    }
  }

  // 3. Téléphone 375 px : un écran par module de la fusion (et par module nouveau), débordement + capture.
  await p.setViewport({ width: 375, height: 800, isMobile: true, hasTouch: true });
  for (const m of NEW) {
    current = 'TÉLÉPHONE ' + m; await p.goto(`${SITE}/app/1/${m}`, { waitUntil: 'networkidle2' }).catch(() => {}); await sleep(1200); await closeTour();
    const st = await state(); judge(st, 'mobile ' + m); await shot(`${m}--mobile-375`); seen.push('mobile:' + m);
  }

  // 4. Langue anglaise : textes restés en français dans les modules de la fusion (indicatif : les données d'essai sont en français).
  await p.setViewport({ width: 1280, height: 900 });
  await p.evaluate(() => { try { localStorage.setItem('mia-lang', 'en'); } catch { /* */ } });
  const FR = /\b(le|la|les|des|une|pour|avec|vous|sans|dans|votre|aucun|aucune|ajouter|enregistrer|supprimer|modifier|créer|nouveau|nouvelle)\b|[éèêàç]/i;
  for (const m of NEW) {
    current = 'ANGLAIS ' + m; await p.goto(`${SITE}/app/1/${m}`, { waitUntil: 'networkidle2' }).catch(() => {}); await sleep(1300); await closeTour();
    const bad = await p.evaluate((re) => {
      const rx = new RegExp(re.source, re.flags); const out = [];
      const root = document.querySelector('.ws-main') || document.body;
      const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      while (w.nextNode()) { const t = w.currentNode.nodeValue.trim(); if (t.length > 2 && t.length < 120 && rx.test(t) && !w.currentNode.parentElement.closest('table, .ws-data, [data-user]')) out.push(t); }
      return out.slice(0, 6);
    }, { source: FR.source, flags: FR.flags });
    if (bad.length) note('TEXTE-FR-EN-MODE-ANGLAIS', bad.join(' ¦ '));
    await shot(`${m}--en`);
  }
  await p.evaluate(() => { try { localStorage.setItem('mia-lang', 'fr'); } catch { /* */ } });

  // 5. Administration du serveur (écran /admin).
  current = 'ADMIN'; await p.goto(API + '/admin', { waitUntil: 'networkidle2' }).catch((e) => note('NAV', e.message)); await sleep(800);
  const ai = await p.$$('input');
  if (ai.length >= 2) { await ai[0].type('admin-demo'); await ai[1].type('mot-de-passe-admin-demo'); await Promise.all([p.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => {}), p.keyboard.press('Enter')]); await sleep(2500); }
  const adm = await p.evaluate(() => document.body.innerText.length); if (adm < 300) note('ADMIN', 'administration vide après connexion'); seen.push('admin');
  await shot('admin--accueil');

  const result = { vus: seen.length, problemes: issues };
  fs.writeFileSync(path.join(OUT, 'RESULTAT-SMOKE.json'), JSON.stringify(result, null, 1));
  console.log(`Écrans/pages parcourus : ${seen.length} ; problèmes relevés : ${issues.length}`);
  issues.forEach((x) => console.log(' - ' + x));
  await b.close();
  process.exit(0);
})().catch((e) => { console.error('ÉCHEC DU SCRIPT', e); process.exit(2); });
