'use strict';
// Administration en direct : accès refusé sans session administrateur (flux compris), nouveau compte visible dans le flux et la liste en moins de 5 s,
// inscription en attente puis validée (change de section), aucune fuite de hachage ni de code, repli par interrogation, catalogue des offres.
// Lancez : npm run test:adminlive
const http = require('http');
const { run } = require('./lib/wave2');
const { freePort } = require('./lib/testdb');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PASS = 'Cacao-Mangue-42';

run('Administration : comptes en direct, inscriptions en attente, recherche', async ({ check, owner, base, extra }) => {
  const mails = extra.mails;
  const lastCode = (to) => { const m = [...mails].reverse().find((x) => x.to && x.to[0] && x.to[0].email === to); const c = m && /: (\d{6})/.exec(m.textContent || ''); return c && c[1]; };
  const secrets = []; // tout ce que l'administration a pu lire : on y cherche les fuites à la fin
  const keep = (x) => { secrets.push(typeof x === 'string' ? x : JSON.stringify(x)); return x; };

  // ---------- Accès refusé sans connexion administrateur ----------
  for (const u of ['/api/admin/live/accounts', '/api/admin/live/stream', '/api/admin/search?q=awa']) {
    const r = await fetch(base + u);
    check(`sans connexion : ${u.split('?')[0]} refusé (401)`, r.status === 401, r.status);
    if (r.body) await r.body.cancel().catch(() => {});
  }
  const bad = await fetch(base + '/api/admin/live/stream', { headers: { cookie: 'mia_admin=faux' } });
  check('cookie administrateur falsifié : flux refusé', bad.status === 401, bad.status);
  if (bad.body) await bad.body.cancel().catch(() => {});
  // un cookie d'utilisateur ordinaire ne donne pas accès non plus
  const u1 = await owner('GET', '/api/admin/live/accounts');
  check('compte utilisateur ordinaire : accès refusé', u1.status === 401, u1.status);

  // ---------- Connexion administrateur ----------
  const lg = await fetch(base + '/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin-test', password: 'mot-de-passe-admin-test' }) });
  const cookie = lg.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  check('connexion administrateur', lg.status === 200 && /mia_admin=/.test(cookie), lg.status);
  const adm = async (u) => { const r = await fetch(base + u, { headers: { cookie } }); const t = await r.text(); keep(t); let j = null; try { j = JSON.parse(t); } catch { /* texte */ } return { status: r.status, json: j, text: t }; };

  // ---------- État de départ : les 4 inscriptions du harnais attendent leur code ----------
  let r = await adm('/api/admin/live/accounts');
  check('instantané : forme attendue', r.status === 200 && Array.isArray(r.json.accounts) && Array.isArray(r.json.pending) && r.json.totals && r.json.summary && r.json.verifyOn === true, Object.keys(r.json || {}));
  check('inscriptions en attente listées (formulaire rempli, code non saisi)', r.json.pending.length >= 4 && r.json.accounts.length === 0, [r.json.pending.length, r.json.accounts.length]);
  const p0 = r.json.pending[0];
  check('en attente : nom, ancienneté, état, essais ; adresse masquée', p0.name && typeof p0.ageSec === 'number' && p0.expired !== undefined && /\*\*\*/.test(p0.contact) && !/awa\d+@exemple/.test(p0.contact), p0);
  check('en attente : aucun champ secret (hachage, code, mot de passe)', !Object.keys(p0).some((k) => /hash|pass|code$/i.test(k)), Object.keys(p0));

  // ---------- Flux SSE ----------
  const ac = new AbortController();
  const events = [];
  const sres = await fetch(base + '/api/admin/live/stream', { headers: { cookie }, signal: ac.signal });
  check('flux : ouvert avec la session administrateur (text/event-stream)', sres.status === 200 && /text\/event-stream/.test(sres.headers.get('content-type')), sres.status);
  (async () => {
    const dec = new TextDecoder(); let buf = '';
    try { for await (const chunk of sres.body) { buf += dec.decode(chunk, { stream: true }); let i; while ((i = buf.indexOf('\n\n')) >= 0) { const raw = buf.slice(0, i); buf = buf.slice(i + 2); const ev = /^event: (.+)$/m.exec(raw); const da = /^data: (.+)$/m.exec(raw); if (ev) { keep(raw); events.push({ at: Date.now(), event: ev[1], data: da ? JSON.parse(da[1]) : null }); } } } } catch { /* fermé */ }
  })();
  const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await sleep(100); } return null; };
  const hello = await waitFor(() => events.find((e) => e.event === 'hello'), 3000);
  check('flux : message « hello » avec l’instantané', !!hello && Array.isArray(hello.data.pending), !!hello);

  // ---------- Inscription : en attente → validée ----------
  const contact = `nadia${Date.now()}@exemple.com`;
  const t0 = Date.now();
  r = await owner('POST', '/api/register', { name: 'Nadia Test', contact, pass: PASS, interests: ['ecom'] });
  check('inscription : code envoyé (202), compte pas encore créé', r.status === 202, r.status);
  const pend = await waitFor(() => events.find((e) => e.event === 'pending' && e.data.pending.some((p) => p.name === 'Nadia Test')), 5000);
  check('flux : l’inscription en attente apparaît en moins de 5 s', !!pend && pend.at - t0 < 5000, pend && pend.at - t0);
  r = await adm('/api/admin/live/accounts');
  check('liste : Nadia est en attente, pas encore dans les comptes', r.json.pending.some((p) => p.name === 'Nadia Test') && !r.json.accounts.some((a) => a.contact === contact));
  const code = lastCode(contact);
  check('code reçu par e-mail (côté client seulement)', /^\d{6}$/.test(code || ''), code);

  const t1 = Date.now();
  r = await owner('POST', '/api/register/verify', { contact, code });
  check('code saisi : compte créé', r.status === 201, r.status);
  const acc = await waitFor(() => events.find((e) => e.event === 'account' && e.data.contact === contact), 5000);
  check('flux : le nouveau compte arrive en moins de 5 s', !!acc && acc.at - t1 < 5000, acc && acc.at - t1);
  check('compte : nom, offre, centres d’intérêt, état de vérification', acc && acc.data.name === 'Nadia Test' && acc.data.plan === 'Gratuit' && acc.data.interests.includes('ecom') && acc.data.verification === 'email', acc && acc.data);
  const gone = await waitFor(() => events.find((e) => e.event === 'pending' && e.at >= t1 && !e.data.pending.some((p) => p.name === 'Nadia Test')), 5000);
  check('flux : l’inscription quitte la section « en attente de vérification »', !!gone);
  const t2 = Date.now();
  r = await adm('/api/admin/live/accounts');
  check('repli par interrogation : la liste contient le compte (instantané en moins de 5 s)', r.json.accounts.some((a) => a.contact === contact) && !r.json.pending.some((p) => p.name === 'Nadia Test') && Date.now() - t2 < 5000);
  check('totaux cohérents', r.json.totals.users === 1 && r.json.lastId === r.json.accounts[0].id, r.json.totals);

  // un second compte, uniquement vérifié par interrogation (flux ignoré) : visible au premier sondage
  const c2 = `omar${Date.now()}@exemple.com`;
  await owner('POST', '/api/register', { name: 'Omar Test', contact: c2, pass: PASS });
  await owner('POST', '/api/register/verify', { contact: c2, code: lastCode(c2) });
  let seen = null; const t3 = Date.now();
  while (!seen && Date.now() - t3 < 5000) { const s = await adm('/api/admin/live/accounts'); seen = s.json.accounts.find((a) => a.contact === c2); if (!seen) await sleep(500); }
  check('repli : sondage court, le compte apparaît en moins de 5 s', !!seen, Date.now() - t3);
  check('les comptes sont triés du plus récent au plus ancien', (await adm('/api/admin/live/accounts')).json.accounts[0].contact === c2);

  // ---------- Fuites ----------
  const all = secrets.join('\n');
  check('aucun hachage de mot de passe (bcrypt) dans ce que lit l’administration', !/\$2[aby]\$\d\d\$/.test(all));
  check('aucun mot de passe en clair', !all.includes(PASS));
  check('aucun code de vérification ni empreinte de code', !all.includes(code) && !/code_hash|pass_hash/.test(all));
  check('aucune adresse complète dans « en attente »', !(JSON.stringify(r.json.pending).match(/@exemple\.com/) || []).some((m) => /^[^*]*$/.test(m)) || r.json.pending.every((p) => /\*\*\*/.test(p.contact)));

  // ---------- Recherche globale ----------
  const sr = await adm('/api/admin/search?q=' + encodeURIComponent('Nadia'));
  check('recherche : trouve l’utilisateur', sr.status === 200 && sr.json.users.some((u) => u.name === 'Nadia Test'), sr.json);
  const sh = await adm('/api/admin/search?q=a');
  check('recherche : moins de 2 caractères → rien (pas d’énumération)', sh.status === 200 && !sh.json.users.length && !sh.json.orgs.length && !sh.json.payments.length);
  const si = await adm('/api/admin/search?q=' + encodeURIComponent("%_'; DROP TABLE users;--"));
  check('recherche : caractères spéciaux sans erreur', si.status === 200, si.status);
  check('recherche : aucun secret dans les résultats', !/pass_hash|\$2[aby]\$/.test(sr.text));

  // ---------- Catalogue des offres : une seule source (config) ----------
  const ov = await adm('/api/admin/overview?days=30');
  const cat = ov.json && ov.json.catalog;
  const price = (period) => cat && cat.sold.find((p) => p.period === period && p.name === 'Illimité') && cat.sold.find((p) => p.period === period).priceXAF;
  check('catalogue : Illimité semaine 21 500, mois 80 000, trimestre 224 000, semestre 425 000, année 800 000', price('week') === 21500 && price('month') === 80000 && price('quarter') === 224000 && price('semester') === 425000 && price('year') === 800000, cat && cat.sold);
  check('répartition : le prix mensuel d’Illimité est celui d’aujourd’hui (pas l’ancien 150 000)', ov.json.plans.prices['Illimité'] === 80000, ov.json.plans.prices);
  check('tableau de bord : séries journalières et comparaison de période', ov.json.daily.days.length === 30 && ov.json.daily.signups.length === 30 && typeof ov.json.kpi.newUsersPrev === 'number');
  const st = await adm('/api/admin/settings');
  check('paramètres : catalogue présent', st.status === 200 && st.json.catalog.sold.length === 5, st.json && Object.keys(st.json));

  // ---------- Battement de cœur (toutes les 20 s) ----------
  const ping = await waitFor(() => events.find((e) => e.event === 'ping'), 23000);
  check('flux : battement de cœur reçu dans les 20 s', !!ping);

  // ---------- Fermeture ----------
  ac.abort();
  await sleep(300);
  const after = await adm('/api/admin/live/accounts');
  check('flux fermé : le serveur répond toujours', after.status === 200);

  // ---------- Fichiers statiques et CSP ----------
  const page = await fetch(base + '/admin');
  const csp = page.headers.get('content-security-policy') || '';
  const html = await page.text();
  check('page : CSP stricte (pas de script en ligne), polices du serveur autorisées', /script-src 'self'/.test(csp) && /font-src 'self'/.test(csp) && !/unsafe-inline/.test(csp) && !/<script>[^<]/.test(html) && !/ style="/.test(html));
  const font = await fetch(base + '/admin/fonts/inter-latin-var.woff2');
  check('police Inter servie par le serveur', font.status === 200 && /font|octet/.test(font.headers.get('content-type') || ''), font.status);
}, {
  setup: async () => {
    const mails = []; const port = await freePort();
    const srv = http.createServer((req, res) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => { try { mails.push(JSON.parse(b || '{}')); } catch { /* ignoré */ } res.statusCode = 201; res.end('{"messageId":"x"}'); }); });
    await new Promise((ok) => srv.listen(port, '127.0.0.1', ok));
    return { env: { SIGNUP_VERIFY: 'on', BREVO_API_KEY: 'cle-de-test', MAIL_API_URL: `http://127.0.0.1:${port}/v3`, SMTP_FROM: 'Brij-IA <contact@exemple.com>' }, mails, srv };
  },
  teardown: async (extra) => { extra.srv.close(); },
});
