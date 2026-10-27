'use strict';
// Test du groupe « intelligence » : Mémoire de l'entreprise, Agents spécialisés, Résumé du matin et alertes (canal WhatsApp ; le canal e-mail est dans test-digest-email.js).
// Lancez-le avec : node scripts/test-intelligence.js   (base temporaire, FAUX serveur d'IA, FAUX serveur Meta/Graph, FAUX SMTP : aucun appel externe)
const { spawn } = require('child_process');
const http = require('http');
const net = require('net');
const path = require('path');
const { startTestPg } = require('./lib/testdb');

let passed = 0;
let failed = 0;
const check = (name, cond, extra) => {
  if (cond) { passed++; console.log('  OK   ' + name); } else { failed++; console.log('  ECHEC ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); }
};
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); s.on('error', reject); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(150); } return false; };

function client(base) {
  const jar = {};
  return async (method, url, body) => {
    const headers = body !== undefined ? { 'content-type': 'application/json' } : {};
    const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie) headers.cookie = cookie;
    const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const sc of res.headers.getSetCookie()) { const [pair] = sc.split(';'); const i = pair.indexOf('='); jar[pair.slice(0, i).trim()] = pair.slice(i + 1).trim(); }
    const t = await res.text();
    let json = null; try { json = JSON.parse(t); } catch { /* non JSON */ }
    return { status: res.status, json, headers: res.headers, text: t };
  };
}

// Faux serveur : IA (Anthropic) + API Graph de Meta (WhatsApp).
function fakeServer(port) {
  const seen = { calls: 0, ai: [], wa: [], memSys: '', agentCalls: [] };
  const srv = http.createServer((req, res) => {
    let b = '';
    req.on('data', (d) => { b += d; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url.startsWith('/graph/')) {
        if (req.method === 'POST' && /\/messages$/.test(req.url)) {
          const j = JSON.parse(b || '{}');
          seen.wa.push({ to: j.to, type: j.type, body: (j.text || {}).body, tpl: j.template, auth: req.headers.authorization });
          if (String(j.to).endsWith('0000')) { res.statusCode = 400; return res.end(JSON.stringify({ error: { message: '(#131047) Re-engagement message', code: 131047, type: 'OAuthException' } })); }
          if (String(j.to).endsWith('9999')) { res.statusCode = 400; return res.end(JSON.stringify({ error: { message: 'Numéro non valide chez Meta', code: 131030 } })); }
          return res.end(JSON.stringify({ messages: [{ id: 'wamid.out' }] }));
        }
        return res.end(JSON.stringify({ display_phone_number: '+237 677 11 22 33', verified_name: 'Boutique Awa' }));
      }
      const j = JSON.parse(b || '{}');
      const sys = Array.isArray(j.system) ? j.system.map((x) => x.text).join('\n\n') : (j.system || '');
      const last = ((j.messages || []).slice(-1)[0] || {}).content || '';
      seen.calls++; seen.ai.push({ sys, last });
      let text = 'Réponse de test.';
      if (sys.includes("Tu es la mémoire de l'entreprise")) {
        seen.memSys = sys;
        text = /fournisseur/i.test(last) ? 'Vous avez changé de fournisseur à cause de la hausse des prix et des retards de livraison [1].' : 'Selon la note [1], voici ce qui a été décidé.';
      } else if (sys.includes('Tu résumes une discussion')) text = JSON.stringify({ title: 'Stock de savon', content: 'Il faut commander 20 savons chez Grossiste Nord.', kind: 'decision' });
      else if (sys.includes('Tu choisis les agents')) text = JSON.stringify({ agents: ['stock'] });
      else if (sys.includes('tu animes une réunion')) text = JSON.stringify({ summary: 'Le stock et la trésorerie sont liés.', agreements: ['Commander peu et souvent'], disagreements: ['Finance veut attendre, Stock veut commander tout de suite'], actions: [{ title: 'Relancer les impayés', why: 'Libérer de la trésorerie', owner: 'Finance' }, { title: 'Commander le savon', why: 'Éviter la rupture', owner: 'Stock' }, { title: 'Négocier un délai', why: 'Étaler le paiement', owner: 'Direction' }, { title: 'Quatrième action à ignorer', why: 'x', owner: 'x' }] });
      else if (sys.includes('Tu es en LECTURE SEULE')) {
        const name = (/Tu es l'agent ([A-ZÉ ]+)/.exec(sys) || [, '?'])[1].trim();
        seen.agentCalls.push({ name, sys });
        if (/PANNE-IA/.test(last) && name === 'STOCK ET LOGISTIQUE') { res.statusCode = 500; return res.end(JSON.stringify({ error: { message: 'panne simulée' } })); }
        text = `Avis de l'agent ${name} : voici mon analyse de vos données.`;
      }
      res.end(JSON.stringify({ content: [{ type: 'text', text }] }));
    });
  });
  return new Promise((resolve) => srv.listen(port, '127.0.0.1', () => resolve({ srv, seen })));
}

/** Faux serveur SMTP : accepte tout et garde les messages reçus. */
function fakeSmtp(port, box) {
  const srv = net.createServer((sock) => {
    let data = ''; let inData = false; let buf = '';
    sock.write('220 fake ESMTP\r\n');
    sock.on('data', (chunk) => {
      buf += chunk.toString('latin1');
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (inData) { if (line === '.') { inData = false; box.push(data); data = ''; sock.write('250 OK\r\n'); } else data += line + '\n'; }
        else if (/^EHLO|^HELO/i.test(line)) sock.write('250-fake\r\n250 8BITMIME\r\n');
        else if (/^DATA/i.test(line)) { inData = true; sock.write('354 go\r\n'); }
        else if (/^QUIT/i.test(line)) { sock.write('221 bye\r\n'); sock.end(); }
        else sock.write('250 OK\r\n');
      }
    });
    sock.on('error', () => {});
  });
  return new Promise((resolve) => srv.listen(port, '127.0.0.1', () => resolve(srv)));
}

async function main() {
  const smtpPort = await freePort(); const mailbox = []; const smtp = await fakeSmtp(smtpPort, mailbox);
  const fport = await freePort(); const fake = await fakeServer(fport);
  const port = await freePort(); const base = `http://127.0.0.1:${port}`;
  const pgt = await startTestPg();
  const blank = ['ALLOWED_ORIGINS', 'COOKIE_SAMESITE', 'COOKIE_SECURE', 'SMTP_HOST', 'WHATSAPP_PHONE_ID', 'WHATSAPP_TOKEN', 'CAMPAY_USERNAME', 'CAMPAY_PASSWORD', 'BUSINESS_FILE', 'KNOWLEDGE_DIR'];
  const env = { ...process.env, ...Object.fromEntries(blank.map((k) => [k, ''])), NODE_ENV: 'test', PORT: String(port), JWT_SECRET: 'secret-de-test-assez-long-123456', DATABASE_URL: pgt.url,
    ANTHROPIC_API_KEY: 'cle-de-test', ANTHROPIC_BASE_URL: `http://127.0.0.1:${fport}`, META_GRAPH_URL: `http://127.0.0.1:${fport}/graph`, ADMIN_USERNAME: 'admin-test', ADMIN_PASSWORD: 'mot-de-passe-admin-test',
    TRUST_PROXY: '0', WS_AI_FREE: '100', AI_PER_MINUTE: '500', SIGNUP_VERIFY: 'off', API_PUBLIC_URL: base, SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtpPort), SMTP_FROM: 'noreply@manager-ia.test',
    DIGEST_TICK_MS: '300', DIGEST_URGENT_MS: '300' };
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
  let up = false;
  for (let i = 0; i < 80 && !up; i++) { await sleep(250); try { up = (await fetch(base + '/api/health')).ok; } catch { /* pas prêt */ } }
  if (!up) { console.log("Le serveur n'a pas démarré.\n" + out); process.exit(1); }

  let rawDb;
  try {
    rawDb = await pgt.open();
    const stamp = Date.now();
    const owner = client(base); const paul = client(base); const marc = client(base); const zoe = client(base);
    const reg = (c, name, contact) => c('POST', '/api/register', { name, contact: contact || `${name.toLowerCase()}${stamp}@exemple.com`, pass: 'secret123' });
    check('inscriptions', (await reg(owner, 'Awa')).status === 201 && (await reg(paul, 'Paul')).status === 201 && (await reg(marc, 'Marc', `69${String(stamp).slice(-7)}`)).status === 201 && (await reg(zoe, 'Zoe')).status === 201);
    let r = await owner('POST', '/api/ws/orgs', { name: 'Boutique Awa', currency: 'FCFA' });
    const org = r.json.id; const O = `/api/ws/orgs/${org}`;
    r = await zoe('POST', '/api/ws/orgs', { name: 'Autre Société' });
    const org2 = r.json.id; const O2 = `/api/ws/orgs/${org2}`;
    for (const [c, role] of [[paul, 'member'], [marc, 'manager']]) { const inv = await owner('POST', `${O}/invites`, { role }); r = await c('POST', '/api/ws/orgs/join', { code: inv.json.code }); if (r.status !== 200) console.log('join', r.json); }
    const aiUsed = async (c = owner, o = O) => (await c('GET', o)).json.limits.aiUsed;
    const modsOf = async (c) => (await c('GET', O)).json.modules.map((m) => m.id);
    check('modules « memory » et « agents » proposés aux membres', (await modsOf(paul)).includes('memory') && (await modsOf(paul)).includes('agents'));

    // =================== 1) MÉMOIRE ===================
    console.log('Mémoire de l\'entreprise');
    const M = `${O}/memory`;
    const sup = (await rawDb.prepare('INSERT INTO suppliers (org_id, name, created_at) VALUES (?, ?, ?)').run(org, 'Grossiste Nord', new Date().toISOString())).lastInsertRowid;
    r = await paul('POST', M, { title: '', content: 'x' });
    check('titre obligatoire -> 400', r.status === 400, r.json);
    r = await paul('POST', M, { title: 'Test', content: 'x', kind: 'inconnu' });
    check('type inconnu -> 400', r.status === 400, r.json);
    r = await paul('POST', M, { title: 'Test', content: 'x', date: '31/12/2025' });
    check('date invalide -> 400', r.status === 400, r.json);
    r = await paul('POST', M, { title: 'Test', content: 'x', linkKind: 'supplier', linkId: 999999 });
    check('lien vers un fournisseur inexistant -> 404', r.status === 404, r.json);
    r = await paul('POST', M, { title: 'Changement de fournisseur de savon', content: 'Nous avons changé de fournisseur car les prix de Grossiste Nord augmentaient et les livraisons arrivaient en retard.', kind: 'decision', tags: 'Fournisseur, prix', date: '2026-03-10', linkKind: 'supplier', linkId: sup });
    const e1 = r.json.id;
    check('un membre ajoute une décision (201)', r.status === 201 && e1 > 0, r.json);
    r = await owner('POST', M, { title: 'Panne du groupe électrogène', content: 'Le groupe est tombé en panne pendant 2 jours en juin. Leçon : faire la maintenance chaque trimestre.', kind: 'incident', tags: 'maintenance', date: '2026-06-02' });
    const e2 = r.json.id;
    r = await owner('POST', M, { title: 'Procédure de caisse', content: 'Compter la caisse chaque soir avec deux personnes.', kind: 'procedure', tags: 'caisse', date: '2025-12-01' });
    const e3 = r.json.id;
    r = await paul('POST', M, { title: 'Salaire du directeur', content: 'Négociation confidentielle du salaire du directeur.', restricted: true });
    check('un membre ne peut pas réserver une entrée aux responsables -> 403', r.status === 403, r.json);
    r = await marc('POST', M, { title: 'Négociation du salaire du directeur', content: 'Montant confidentiel discuté avec le directeur, à revoir en janvier.', kind: 'meeting', restricted: true, date: '2026-04-01' });
    const e4 = r.json.id;
    check('un responsable crée une entrée réservée', r.status === 201, r.json);

    r = await paul('GET', M);
    check('liste : KPI et types', r.status === 200 && r.json.kpis.total === 3 && r.json.kpis.decisions === 1 && r.json.kinds.decision === 'Décision', r.json.kpis);
    check('une entrée réservée est invisible pour un membre (liste)', !r.json.entries.some((e) => e.id === e4) && r.json.canRestrict === false);
    r = await marc('GET', M);
    check('… mais visible pour un responsable', r.json.kpis.total === 4 && r.json.entries.some((e) => e.id === e4));
    r = await paul('GET', `${M}/${e4}`);
    check('détail d\'une entrée réservée pour un membre -> 404', r.status === 404, r.json);
    r = await paul('GET', `${M}?q=${encodeURIComponent('salaire directeur')}`);
    check('recherche : une entrée réservée n\'est jamais trouvée par un membre', r.json.entries.length === 0, r.json.entries.map((e) => e.title));
    r = await marc('GET', `${M}?q=${encodeURIComponent('salaire directeur')}`);
    check('recherche : trouvée par un responsable', r.json.entries.length === 1 && r.json.entries[0].id === e4);

    r = await paul('GET', `${M}?q=${encodeURIComponent('fournisseur')}`);
    check('recherche plein texte « fournisseur »', r.json.entries.length === 1 && r.json.entries[0].id === e1 && r.json.entries[0].link && r.json.entries[0].link.label === 'Grossiste Nord', r.json.entries);
    r = await paul('GET', `${M}?q=${encodeURIComponent('livraison')}`);
    check('recherche en français : « livraison » trouve « livraisons » (radical)', r.json.entries.length === 1 && r.json.entries[0].id === e1, r.json.entries.map((e) => e.title));
    r = await paul('GET', `${M}?q=${encodeURIComponent('decision')}`);
    r = await paul('GET', `${M}?q=${encodeURIComponent('electrogene')}`);
    check('recherche sans accents : « electrogene » trouve « électrogène »', r.json.entries.length === 1 && r.json.entries[0].id === e2, r.json.entries.map((e) => e.title));
    r = await paul('GET', `${M}?q=${encodeURIComponent('groupe maintenance trimestre')}`);
    check('plusieurs mots : tous doivent correspondre', r.json.entries.length === 1 && r.json.entries[0].id === e2);
    r = await paul('GET', `${M}?q=${encodeURIComponent('groupe savon')}`);
    check('plusieurs mots sans entrée commune : aucun résultat', r.json.entries.length === 0, r.json.entries.map((e) => e.title));
    r = await paul('GET', `${M}?q=${encodeURIComponent("la caisse du soir")}`);
    check('mots vides et apostrophes ignorés', r.json.entries.length === 1 && r.json.entries[0].id === e3, r.json.entries.map((e) => e.title));
    r = await paul('GET', `${M}?kind=incident`);
    check('filtre par type', r.json.entries.length === 1 && r.json.entries[0].id === e2);
    r = await paul('GET', `${M}?tag=prix`);
    check('filtre par étiquette', r.json.entries.length === 1 && r.json.entries[0].id === e1 && r.json.tags.some((t) => t.tag === 'fournisseur'), r.json.tags);
    r = await paul('GET', `${M}?from=2026-01-01&to=2026-04-30`);
    check('filtre par période', r.json.entries.length === 1 && r.json.entries[0].id === e1, r.json.entries.map((e) => e.date));
    r = await paul('GET', `${M}?from=pas-une-date`);
    check('période invalide -> 400', r.status === 400);
    r = await paul('GET', `${M}?q=${encodeURIComponent("'; DROP TABLE memory_entries; --")}`);
    check('texte de recherche hostile : aucune erreur', r.status === 200, r.json);
    r = await paul('GET', `${M}?kind=inconnu`);
    check('type de filtre inconnu -> 400', r.status === 400);

    // Modification + versions
    r = await paul('PUT', `${M}/${e3}`, { title: 'Modifié par Paul' });
    check('un membre ne modifie pas la note d\'un autre -> 403', r.status === 403, r.json);
    r = await paul('PUT', `${M}/${e1}`, { content: 'Nous avons changé de fournisseur : prix en hausse et livraisons en retard. Nouveau fournisseur : Grossiste Sud.', tags: ['fournisseur', 'prix', 'sud'] });
    check('l\'auteur modifie : version 2', r.status === 200 && r.json.version === 2, r.json);
    r = await owner('PUT', `${M}/${e1}`, { title: 'Changement de fournisseur de savon (2026)' });
    check('un responsable modifie : version 3', r.status === 200 && r.json.version === 3, r.json);
    r = await paul('GET', `${M}/${e1}`);
    check('historique : 2 anciennes versions conservées, la plus récente d\'abord', r.json.version === 3 && r.json.versions.length === 2 && r.json.versions[0].version === 2 && /Grossiste Nord/.test(r.json.versions[1].content) && r.json.versions[1].version === 1, r.json.versions);
    r = await paul('PUT', `${M}/${e1}`, { content: '' });
    check('contenu vidé -> 400', r.status === 400, r.json);
    r = await paul('PUT', `${M}/${e1}`, { restricted: true });
    check('un membre ne peut pas réserver une entrée existante -> 403', r.status === 403);
    r = await marc('PUT', `${M}/${e1}`, { linkKind: '' });
    check('le lien peut être retiré', r.status === 200 && !(await paul('GET', `${M}/${e1}`)).json.link);

    // Export
    r = await paul('GET', `${M}/export`);
    check('export JSON : 3 entrées visibles pour un membre, sans l\'entrée réservée', r.status === 200 && r.json.entries.length === 3 && !r.json.entries.some((e) => e.id === e4) && /attachment/.test(r.headers.get('content-disposition')) && r.json.entries[0].content, r.json && r.json.entries && r.json.entries.length);
    r = await marc('GET', `${M}/export?format=csv`);
    check('export CSV : en-tête et 4 lignes pour un responsable', r.status === 200 && /text\/csv/.test(r.headers.get('content-type')) && r.text.split('\r\n').length === 5 && /Titre/.test(r.text), r.text.slice(0, 200));

    // Isolation
    r = await zoe('GET', `${O2}/memory`);
    check('isolation : l\'autre organisation ne voit rien', r.status === 200 && r.json.kpis.total === 0 && r.json.entries.length === 0, r.json.kpis);
    r = await zoe('GET', `${O2}/memory/${e1}`);
    check('isolation : lecture d\'une entrée d\'une autre organisation -> 404', r.status === 404);
    r = await zoe('PUT', `${O2}/memory/${e1}`, { title: 'Piratage' });
    check('isolation : modification -> 404', r.status === 404);
    r = await zoe('DELETE', `${O2}/memory/${e1}`);
    check('isolation : suppression -> 404', r.status === 404);
    r = await zoe('GET', `${O}/memory`);
    check('une personne extérieure ne peut pas lire la mémoire -> 404', r.status === 404);
    r = await zoe('POST', `${O2}/memory`, { title: 'Réunion', content: 'Autre société : choix du fournisseur de riz.', kind: 'meeting' });
    r = await paul('GET', `${M}?q=riz`);
    check('isolation : la recherche ne traverse pas les organisations', r.json.entries.length === 0);

    // Demander à la mémoire
    const u0 = await aiUsed(); const c0 = fake.seen.calls;
    r = await paul('POST', `${M}/ask`, { question: 'Pourquoi avons-nous changé de fournisseur ?' });
    check('« Demander » : réponse citant la source (titre et date)', r.status === 200 && r.json.found === true && /\[1\]/.test(r.json.answer) && r.json.sources.length === 1 && r.json.sources[0].id === e1 && /fournisseur/.test(r.json.sources[0].title) && r.json.sources[0].date === '2026-03-10', r.json);
    check('« Demander » : l\'IA a reçu l\'entrée et la consigne « uniquement à partir des entrées »', /Grossiste Sud/.test(fake.seen.memSys) && /UNIQUEMENT/.test(fake.seen.memSys) && /N'invente RIEN/.test(fake.seen.memSys));
    check('« Demander » : compté dans le quota IA (+1)', (await aiUsed()) === u0 + 1, [u0, await aiUsed()]);
    const c1 = fake.seen.calls;
    r = await paul('POST', `${M}/ask`, { question: 'Quelle est la couleur du ciel sur Mars ?' });
    check('« Demander » sans entrée pertinente : « je ne trouve pas », aucune source, aucun appel à l\'IA', r.status === 200 && r.json.found === false && /Je ne trouve pas/.test(r.json.answer) && r.json.sources.length === 0 && fake.seen.calls === c1 && (await aiUsed()) === u0 + 1, r.json);
    r = await paul('POST', `${M}/ask`, { question: 'Que dit la négociation du salaire du directeur ?' });
    check('« Demander » : une entrée réservée n\'est jamais transmise à l\'IA pour un membre', r.json.found === false && !/confidentiel/.test(fake.seen.memSys.split('<memoire>').pop() || ''), r.json);
    r = await marc('POST', `${M}/ask`, { question: 'Que dit la négociation du salaire du directeur ?' });
    check('« Demander » : un responsable y a accès', r.json.found === true && r.json.sources[0].id === e4, r.json);
    r = await paul('POST', `${M}/ask`, { question: '' });
    check('« Demander » : question vide -> 400', r.status === 400);
    r = await zoe('POST', `${O2}/memory/ask`, { question: 'Pourquoi le groupe électrogène est-il tombé en panne ?' });
    check('« Demander » : ne trouve rien chez une autre organisation', r.json.found === false && r.json.sources.length === 0, r.json);

    // Noter ceci (résumé de discussion proposé, validé par la personne)
    r = await paul('POST', `${M}/summarize`, { module: 'stock' });
    check('« Noter ceci » : sans discussion -> 400', r.status === 400, r.json);
    await paul('POST', `${O}/ai/chat`, { module: 'stock', message: 'Combien de savon commander ?' });
    const n0 = (await paul('GET', M)).json.kpis.total;
    r = await paul('POST', `${M}/summarize`, { module: 'stock' });
    check('« Noter ceci » : résumé proposé par l\'IA, rien n\'est enregistré', r.status === 200 && r.json.title === 'Stock de savon' && r.json.kind === 'decision' && (await paul('GET', M)).json.kpis.total === n0, r.json);
    r = await paul('POST', `${M}/summarize`, { module: 'nimporte' });
    check('« Noter ceci » : module inconnu -> 400', r.status === 400);

    // Suppression
    r = await paul('DELETE', `${M}/${e3}`);
    check('un membre ne supprime pas la note d\'un autre -> 403', r.status === 403);
    r = await owner('DELETE', `${M}/${e3}`);
    check('un responsable supprime -> 200', r.status === 200);
    r = await owner('GET', `${M}/${e3}`);
    check('entrée supprimée -> 404', r.status === 404);
    r = await owner('POST', `${O}/ai/chat`, { module: 'memory', message: 'Que sais-tu ?' });
    check('assistant du module « memory » disponible (ctx lu par ai.js)', r.status === 200 && /MÉMOIRE DE L'ENTREPRISE/.test(fake.seen.ai[fake.seen.ai.length - 1].sys) && /Changement de fournisseur/.test(fake.seen.ai[fake.seen.ai.length - 1].sys), r.json);

    // =================== 2) AGENTS ===================
    console.log('Agents spécialisés');
    const G = `${O}/agents`;
    r = await paul('GET', G);
    check('liste des 9 agents (membre : certains indisponibles)', r.status === 200 && r.json.agents.length === 9 && r.json.agents.find((a) => a.key === 'commercial').available && !r.json.agents.find((a) => a.key === 'finance').available && !r.json.agents.find((a) => a.key === 'hr').available && r.json.agents[0].modules.length > 0 && r.json.agents.every((a) => a.watches.length), r.json.agents.map((a) => [a.key, a.available]));
    check('liste : aucune consigne interne montrée à un membre', r.json.agents.every((a) => a.extraPrompt === undefined));
    r = await owner('GET', G);
    check('responsable/propriétaire : tous disponibles', r.json.agents.every((a) => a.available) && r.json.maxAgents === 4);
    r = await paul('POST', `${G}/ask`, { agent: 'finance', question: 'Où en est la trésorerie ?' });
    check('un membre ne peut pas interroger l\'agent Finance -> 403', r.status === 403, r.json);
    r = await paul('POST', `${G}/ask`, { agent: 'inconnu', question: 'Bonjour' });
    check('agent inconnu -> 400', r.status === 400);
    r = await paul('POST', `${G}/ask`, { agent: 'commercial', question: '' });
    check('question vide -> 400', r.status === 400);
    const ua = await aiUsed();
    r = await paul('POST', `${G}/ask`, { agent: 'commercial', question: 'Quels clients relancer ?' });
    check('un agent répond : son nom, son rôle, les données consultées', r.status === 200 && r.json.answers.length === 1 && r.json.answers[0].agent.name === 'Agent Commercial' && /Avis de l'agent COMMERCIAL/.test(r.json.answers[0].text) && r.json.answers[0].data.length > 0, r.json);
    check('données consultées : pas de module réservé aux responsables pour un membre (assistant commercial)', !r.json.answers[0].data.some((d) => d.id === 'sales') && r.json.answers[0].data.some((d) => d.id === 'crm'), r.json.answers[0].data);
    check('une réponse = un message IA', (await aiUsed()) === ua + 1, [ua, await aiUsed()]);
    check('l\'agent reçoit ses consignes propres et la règle « lecture seule »', /agent COMMERCIAL/.test(fake.seen.agentCalls[fake.seen.agentCalls.length - 1].sys) && /LECTURE SEULE/.test(fake.seen.agentCalls[fake.seen.agentCalls.length - 1].sys) && /<donnees>/.test(fake.seen.agentCalls[fake.seen.agentCalls.length - 1].sys));

    // Réunion
    const stockBefore = (await rawDb.prepare('SELECT COUNT(*) c FROM stock_items WHERE org_id = ?').get(org)).c;
    const ub = await aiUsed();
    r = await owner('POST', `${G}/meeting`, { question: 'Comment gérer le stock de savon et les factures impayées ?' });
    const nAns = r.json.answers ? r.json.answers.length : 0;
    check('réunion : agents choisis par mots-clés (stock + finance/commercial), au plus 3 spécialistes', r.status === 200 && nAns >= 2 && nAns <= 3 && r.json.answers.some((a) => a.agent.key === 'stock') && r.json.answers.some((a) => a.agent.key === 'finance') && r.json.routedByAI === false, r.json.answers && r.json.answers.map((a) => a.agent.key));
    check('réunion : chaque réponse indique l\'agent et les données consultées', r.json.answers.every((a) => a.agent.name && a.text && a.data.length > 0 && a.data.every((d) => d.id && d.title)));
    const s = r.json.synthesis;
    check('réunion : synthèse de la Direction avec accords, désaccords et exactement 3 actions priorisées', s && s.agent.key === 'direction' && s.agreements.length === 1 && s.disagreements.length === 1 && s.actions.length === 3 && s.actions[0].rank === 1 && s.actions[2].rank === 3 && s.actions[0].title === 'Relancer les impayés', s);
    check('réunion : quota = un message par agent + synthèse, 4 au plus', (await aiUsed()) === ub + nAns + 1 && nAns + 1 <= 4, [ub, await aiUsed(), nAns]);
    check('l\'IA ne modifie aucune donnée', (await rawDb.prepare('SELECT COUNT(*) c FROM stock_items WHERE org_id = ?').get(org)).c === stockBefore);
    const uc = await aiUsed();
    r = await owner('POST', `${G}/meeting`, { question: 'Ventes, stock, budget, machine en panne, marketing et employés : que faire ?' });
    check('réunion avec beaucoup de sujets : plafond de 4 agents (synthèse comprise)', r.status === 200 && r.json.answers.length === 3 && r.json.synthesis && (await aiUsed()) === uc + 4, [r.json.answers && r.json.answers.length, uc, await aiUsed()]);
    const ud = await aiUsed();
    r = await owner('POST', `${G}/meeting`, { question: 'Que dois-je faire demain ?' });
    check('sans mot-clé : l\'IA choisit l\'agent (compté), puis réponse et synthèse', r.status === 200 && r.json.routedByAI === true && r.json.answers.length === 1 && r.json.answers[0].agent.key === 'stock' && r.json.synthesis && (await aiUsed()) === ud + 3, [r.json.routedByAI, await aiUsed() - ud]);
    const ue = await aiUsed();
    r = await owner('POST', `${G}/meeting`, { question: 'PANNE-IA stock du savon' });
    check('un agent en panne : message d\'erreur clair, rien n\'est compté pour lui', r.status === 200 && r.json.answers.length >= 1 && r.json.answers[0].error && !r.json.answers[0].text && (await aiUsed()) === ue + (r.json.answers.filter((a) => a.text).length) + (r.json.synthesis && !r.json.synthesis.error ? 1 : 0), r.json.answers.map((a) => [a.agent.key, a.error]));
    r = await paul('POST', `${G}/meeting`, { question: 'Que faire du stock de savon ?' });
    check('un membre : réunion sans la Direction (rôle insuffisant), sans synthèse', r.status === 200 && r.json.synthesis === null && r.json.answers.length >= 1 && r.json.answers.every((a) => ['stock', 'commercial', 'marketing', 'production', 'construction'].includes(a.agent.key)), r.json.answers.map((a) => a.agent.key));
    r = await paul('PUT', `${G}/commercial`, { enabled: false });
    check('réglage d\'un agent réservé aux administrateurs -> 403', r.status === 403);
    r = await owner('PUT', `${G}/commercial`, { enabled: false, extraPrompt: 'Toujours proposer un rabais de 5 % aux nouveaux clients.' });
    check('un administrateur désactive un agent et ajoute des consignes', r.status === 200);
    r = await paul('POST', `${G}/ask`, { agent: 'commercial', question: 'Bonjour ?' });
    check('agent désactivé -> 409', r.status === 409, r.json);
    r = await owner('PUT', `${G}/commercial`, { enabled: true });
    r = await owner('POST', `${G}/ask`, { agent: 'commercial', question: 'Que vendre cette semaine ?' });
    check('consignes propres à l\'entreprise transmises à l\'agent', r.status === 200 && /rabais de 5 %/.test(fake.seen.agentCalls[fake.seen.agentCalls.length - 1].sys));
    r = await owner('GET', `${G}/history`);
    check('historique des réunions de la personne', r.status === 200 && r.json.history.length >= 3 && r.json.history[0].question && r.json.history[0].result);
    r = await zoe('GET', `${O2}/agents/history`);
    check('isolation : historique vide dans une autre organisation', r.json.history.length === 0);
    r = await zoe('GET', `${O}/agents`);
    check('une personne extérieure -> 404', r.status === 404);
    // Quota épuisé
    const full = new Date().toISOString();
    for (let i = 0; i < 100; i++) await rawDb.prepare('INSERT INTO ai_usage (org_id, user_id, created_at) VALUES (?, ?, ?)').run(org2, 1, full);
    r = await zoe('POST', `${O2}/agents/ask`, { agent: 'commercial', question: 'Bonjour' });
    check('quota IA épuisé : un agent refuse (429)', r.status === 429, r.json);
    r = await zoe('POST', `${O2}/agents/meeting`, { question: 'stock' });
    check('quota IA épuisé : la réunion refuse (429)', r.status === 429, r.json);
    r = await zoe('POST', `${O2}/memory/ask`, { question: 'Quel fournisseur de riz ?' });
    check('quota IA épuisé : « Demander à la mémoire » refuse (429)', r.status === 429, r.json);

    // =================== 3) RÉSUMÉ DU MATIN ET ALERTES WHATSAPP ===================
    console.log('Résumé du matin et alertes WhatsApp');
    const D = `${O}/mail/digest`;
    const PID = '109876543210';
    const TOKEN_WA = 'EAAG-jeton-de-test-0123456789';
    const APPSECRET = 'app-secret-de-test-xyz';
    r = await paul('GET', D);
    check('réservé aux responsables : un membre -> 403', r.status === 403, r.json);
    r = await owner('GET', D);
    check('réglages vides au départ ; WhatsApp non connecté ; consentement attendu', r.status === 200 && r.json.connected === false && r.json.me.consented === false && r.json.me.morning === false && /accepte/.test(r.json.consentText) && r.json.settings.tzOffset === 60 && r.json.settings.canEdit === true, r.json);
    r = await owner('PUT', `${O}/sales/whatsapp`, { phoneId: PID, number: '237 677 11 22 33', token: TOKEN_WA, appSecret: APPSECRET });
    check('WhatsApp de l\'organisation connecté', r.status === 200 && r.json.connected === true, r.json);
    // Données à résumer
    const today = new Date().toISOString().slice(0, 10);
    const old = new Date(Date.now() - 50 * 86400000).toISOString().slice(0, 10);
    const cust = (await rawDb.prepare('INSERT INTO customers (org_id, name, phone, email, created_at) VALUES (?, ?, ?, ?, ?)').run(org, 'Marie Client', '655443322', '', new Date().toISOString())).lastInsertRowid;
    await rawDb.prepare("INSERT INTO documents (org_id, customer_id, kind, number, status, total, paid, issued, due, created_by, created_at, updated_at) VALUES (?, ?, 'invoice', 'FA-9001', 'sent', 100000, 20000, ?, ?, 1, ?, ?)").run(org, cust, old, old, new Date().toISOString(), new Date().toISOString());
    await rawDb.prepare("INSERT INTO stock_items (org_id, name, unit, quantity, min_quantity, created_at) VALUES (?, 'Savon noir', 'pièce', 0, 5, ?)").run(org, new Date().toISOString());
    await rawDb.prepare("INSERT INTO stock_items (org_id, name, unit, quantity, min_quantity, created_at) VALUES (?, 'Huile', 'litre', 2, 5, ?)").run(org, new Date().toISOString());
    await rawDb.prepare("INSERT INTO tasks (org_id, title, status, due, created_by, created_at) VALUES (?, 'Livrer la commande', 'todo', ?, 1, ?)").run(org, old, new Date().toISOString());
    const oldH = new Date(Date.now() - 9 * 3600000).toISOString();
    await rawDb.prepare("INSERT INTO chats (org_id, session, status, channel, contact, created_at, updated_at) VALUES (?, 'sess-urgent-1', 'handoff', 'whatsapp', '237655000111', ?, ?)").run(org, oldH, oldH);

    const nowLocal = () => { const d = new Date(Date.now() + 60 * 60000); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
    const hm = (m) => `${String(Math.floor(((m % 1440) + 1440) % 1440 / 60)).padStart(2, '0')}:${String(((m % 1440) + 1440) % 1440 % 60).padStart(2, '0')}`;
    const future = () => hm(nowLocal() + 180); // jamais déclenché pendant les essais manuels

    r = await owner('PUT', `${D}/me`, { channel: 'whatsapp', phone: '677 11 22 33', morning: true, urgent: false, hour: future() });
    check('abonnement sans consentement -> 400 (jamais d\'envoi sans consentement)', r.status === 400 && /consentement/.test(r.json.error), r.json);
    r = await owner('PUT', `${D}/me`, { channel: 'whatsapp', phone: 'abc', morning: true, consent: true, hour: future() });
    check('numéro invalide -> 400', r.status === 400, r.json);
    r = await owner('PUT', `${D}/me`, { channel: 'whatsapp', phone: '655 44 33 22', morning: true, consent: true, hour: '25:99' });
    check('heure invalide -> 400', r.status === 400, r.json);
    r = await owner('PUT', `${D}/me`, { channel: 'whatsapp', phone: '655 44 33 22', morning: true, consent: true, hour: future(), templateName: 'Mauvais Nom' });
    check('nom de modèle invalide -> 400', r.status === 400, r.json);
    const w0 = fake.seen.wa.length;
    r = await owner('POST', `${D}/test`);
    check('« Envoyer un test » sans abonnement ni consentement -> 400, rien d\'envoyé', r.status === 400 && fake.seen.wa.length === w0, r.json);
    r = await owner('PUT', `${D}/me`, { channel: 'whatsapp', phone: '655 44 33 22', morning: true, urgent: false, consent: true, hour: future() });
    check('abonnement avec consentement', r.status === 200);
    r = await owner('GET', D);
    check('consentement enregistré avec sa date ; aucun secret renvoyé', r.json.me.consented && /^\d{4}-\d{2}-\d{2}T/.test(r.json.me.consentAt) && r.json.connected && !JSON.stringify(r.json).includes('EAAG') && !JSON.stringify(r.json).includes(APPSECRET) && !JSON.stringify(r.json).includes('v1:'), r.json.me);

    r = await owner('POST', `${D}/test`);
    const m1 = fake.seen.wa[fake.seen.wa.length - 1];
    check('test : message envoyé sur WhatsApp, statut « livré »', r.status === 200 && r.json.status === 'delivered' && r.json.channel === 'whatsapp' && m1 && m1.to === '237655443322' && m1.type === 'text', r.json);
    check('message composé par le serveur : impayés, stock, tâches, conversation en attente (sans IA)', /\[Test\]/.test(m1.body) && /Impayés : 1 facture/.test(m1.body) && /80 000 FCFA/.test(m1.body) && /Stock : 1 article en rupture, 1 sous son seuil/.test(m1.body) && /Tâches en retard : 1/.test(m1.body) && /attente d'un conseiller : 1/.test(m1.body) && m1.body.length < 1000 && !/undefined|NaN/.test(m1.body), m1.body);
    check('le jeton Meta de l\'organisation est utilisé côté serveur', m1.auth === `Bearer ${TOKEN_WA}`);
    r = await owner('GET', D);
    check('statut du dernier envoi : livré', r.json.last && r.json.last.status === 'delivered' && r.json.last.kind === 'test' && r.json.statusText.delivered, r.json.last);
    // Fenêtre de 24 h fermée -> e-mail de secours
    r = await owner('PUT', `${D}/me`, { channel: 'whatsapp', phone: '655 00 00 00', morning: true, hour: future() });
    check('changer de numéro redemande le consentement -> 400', r.status === 400 && /consentement/.test(r.json.error), r.json);
    r = await owner('PUT', `${D}/me`, { channel: 'whatsapp', phone: '237 655 00 00 00', morning: true, urgent: false, consent: true, hour: future() });
    const mail0 = mailbox.length;
    r = await owner('POST', `${D}/test`);
    check('WhatsApp refuse (fenêtre 24 h, code 131047) : bascule sur l\'e-mail, statut clair', r.status === 200 && r.json.status === 'emailed' && r.json.channel === 'email' && /24 h/.test(r.json.waError) && mailbox.length === mail0 + 1 && /point du matin/.test(mailbox[mailbox.length - 1]), r.json);
    r = await owner('GET', D);
    check('journal : dernier envoi « WhatsApp non livré → e-mail », avec l\'explication', r.json.last.status === 'emailed' && /24 h/.test(r.json.last.waError) && r.json.log.length >= 2, r.json.last);
    // Modèle approuvé
    r = await owner('PUT', `${D}/me`, { channel: 'whatsapp', phone: '237 655 00 00 00', morning: true, hour: future(), templateName: 'resume_matin' });
    check('nom du modèle approuvé enregistré (le numéro n\'a pas changé : pas de nouveau consentement)', r.status === 200, r.json);
    r = await owner('POST', `${D}/test`);
    const mt = fake.seen.wa[fake.seen.wa.length - 1];
    check('avec un modèle renseigné : envoi du modèle à la place du texte libre', mt.type === 'template' && mt.tpl.name === 'resume_matin' && mt.tpl.components[0].parameters[0].text.includes('point du matin') && !/\n/.test(mt.tpl.components[0].parameters[0].text), mt);
    // Sans e-mail (Marc s'est inscrit avec un numéro de téléphone) : « non livré (fenêtre fermée) »
    r = await marc('PUT', `${D}/me`, { channel: 'whatsapp', phone: '237 655 00 00 00', morning: true, consent: true, hour: future() });
    check('un responsable s\'abonne aussi', r.status === 200, r.json);
    const mail1 = mailbox.length;
    r = await marc('POST', `${D}/test`);
    check('sans e-mail : statut « non livré (fenêtre WhatsApp fermée) »', r.status === 200 && r.json.status === 'window_closed' && /fenêtre WhatsApp fermée/.test(r.json.statusText) && mailbox.length === mail1, r.json);
    r = await marc('GET', D);
    check('responsable non administrateur : réglages de l\'organisation en lecture seule', r.json.settings.canEdit === false && r.json.hasEmail === false && r.json.last.status === 'window_closed');
    r = await marc('PUT', `${D}/me`, { channel: 'whatsapp', phone: '237 655 99 99', morning: true, consent: true, hour: future() });
    r = await marc('POST', `${D}/test`);
    check('autre refus de Meta : statut « non livré » avec le motif', r.json.status === 'failed' && /Numéro non valide/.test(r.json.waError), r.json);
    r = await marc('PUT', `${D}/settings`, { urgentMaxPerDay: 3 });
    check('réglages de l\'organisation réservés aux administrateurs -> 403', r.status === 403);
    r = await owner('PUT', `${D}/settings`, { tzOffset: 5000 });
    check('décalage horaire invalide -> 400', r.status === 400);
    r = await owner('PUT', `${D}/settings`, { urgentMaxPerDay: 0 });
    check('nombre d\'alertes par jour invalide -> 400', r.status === 400);
    r = await owner('PUT', `${D}/settings`, { tzOffset: 60, urgentMaxPerDay: 1, handoffHours: 4, invoiceLateDays: 30 });
    check('un administrateur règle fuseau, plafond d\'alertes, délais', r.status === 200 && (await owner('GET', D)).json.settings.urgentMaxPerDay === 1);

    // Un abonné sans consentement n'est jamais servi, même si le planificateur passe (ligne forcée dans la base)
    await rawDb.prepare("UPDATE digest_subs SET phone = '237655777777', morning = 1, urgent = 1, send_minute = 0, consent_at = NULL, unsub_at = NULL WHERE org_id = ? AND user_id = (SELECT id FROM users WHERE name = 'Marc')").run(org);

    // Planificateur : envoi du résumé à l'heure choisie, une seule fois
    const wSched = fake.seen.wa.length;
    r = await owner('PUT', `${D}/me`, { channel: 'whatsapp', phone: '237 655 44 33 22', morning: true, urgent: false, consent: true, hour: hm(nowLocal() - 1) });
    check('abonnement à une heure déjà passée (rattrapage)', r.status === 200);
    const gotMorning = await until(async () => (await owner('GET', D)).json.log.some((l) => l.kind === 'morning'));
    check('planificateur : le résumé du matin part tout seul (statut livré)', gotMorning && (await owner('GET', D)).json.log.find((l) => l.kind === 'morning').status === 'delivered');
    const sentMorning = fake.seen.wa.slice(wSched).filter((x) => x.to === '237655443322' && /point du matin/.test(x.body || '') && !/Test/.test(x.body || ''));
    await sleep(2500);
    const sentMorning2 = fake.seen.wa.slice(wSched).filter((x) => x.to === '237655443322' && /point du matin/.test(x.body || '') && !/Test/.test(x.body || ''));
    const cnt = (await rawDb.prepare("SELECT COUNT(*) c FROM digest_log WHERE org_id = ? AND kind = 'morning'").get(org)).c;
    check('planificateur : jamais de doublon (verrou par personne et par jour, même après plusieurs passages)', sentMorning.length === 1 && sentMorning2.length === 1 && cnt === 1, [sentMorning.length, sentMorning2.length, cnt]);
    const dup = await rawDb.prepare("INSERT OR IGNORE INTO digest_log (org_id, user_id, kind, dedupe_key, created_at) SELECT org_id, user_id, kind, dedupe_key, created_at FROM digest_log WHERE kind = 'morning' AND org_id = ?").run(org);
    check('verrou en base : la clé unique empêche un 2e envoi par un autre serveur', dup.changes === 0, dup.changes);
    check('aucun envoi à un abonné sans consentement ni à un désabonné', !fake.seen.wa.some((x) => x.to === '237655777777') && !fake.seen.wa.slice(wSched).some((x) => x.to === '237655000000' && !/Test/.test(x.body || '')));

    // Alertes urgentes
    const wU = fake.seen.wa.length;
    r = await owner('PUT', `${D}/me`, { channel: 'whatsapp', phone: '237 655 44 33 22', morning: true, urgent: true, hour: hm(nowLocal() - 1) });
    const gotUrgent = await until(async () => fake.seen.wa.slice(wU).some((x) => /Alerte urgente/.test(x.body || '')));
    const al = fake.seen.wa.slice(wU).find((x) => /Alerte urgente/.test(x.body || ''));
    check('alerte urgente : rupture de stock, facture très en retard, conversation en attente', gotUrgent && /Rupture de stock : Savon noir/.test(al.body) && /FA-9001 .* impayée depuis 50 jours/.test(al.body) && /conversation client attend un conseiller depuis 9 h/.test(al.body), al && al.body);
    await sleep(1500);
    const alerts1 = fake.seen.wa.slice(wU).filter((x) => /Alerte urgente/.test(x.body || '')).length;
    check('alerte urgente : un seul message pour les trois événements, pas de répétition', alerts1 === 1, alerts1);
    await rawDb.prepare("INSERT INTO stock_items (org_id, name, unit, quantity, min_quantity, created_at) VALUES (?, 'Sel fin', 'kg', 0, 2, ?)").run(org, new Date().toISOString());
    await sleep(2000);
    const alerts2 = fake.seen.wa.slice(wU).filter((x) => /Alerte urgente/.test(x.body || '')).length;
    check('anti-spam : au plus N alertes par jour (ici 1) même si un nouvel événement arrive', alerts2 === 1, alerts2);
    r = await owner('PUT', `${D}/settings`, { urgentMaxPerDay: 5 });
    const got2 = await until(async () => fake.seen.wa.slice(wU).filter((x) => /Alerte urgente/.test(x.body || '')).length === 2);
    const al2 = fake.seen.wa.slice(wU).filter((x) => /Alerte urgente/.test(x.body || ''))[1];
    check('plafond relevé : la nouvelle alerte part (uniquement le nouvel événement)', got2 && /Sel fin/.test(al2.body) && !/Savon noir/.test(al2.body), al2 && al2.body);
    r = await owner('GET', D);
    check('journal des envois : date, type, statut', r.json.log.some((l) => l.kind === 'urgent' && l.status === 'delivered' && l.at) && r.json.log.some((l) => l.kind === 'morning') && r.json.log.some((l) => l.kind === 'test'), r.json.log.map((l) => [l.kind, l.status]));
    check('journal : un lot d\'alertes = une seule ligne', r.json.log.filter((l) => l.kind === 'urgent').length === 2, r.json.log.filter((l) => l.kind === 'urgent').length);

    // Désabonnement en un clic
    r = await owner('POST', `${D}/me/unsubscribe`);
    check('désabonnement en un clic', r.status === 200);
    r = await owner('GET', D);
    check('après désabonnement : plus rien d\'actif, date de désabonnement enregistrée', !r.json.me.morning && !r.json.me.urgent && !r.json.me.consented && r.json.me.unsubAt, r.json.me);
    await rawDb.prepare("INSERT INTO stock_items (org_id, name, unit, quantity, min_quantity, created_at) VALUES (?, 'Riz', 'kg', 0, 2, ?)").run(org, new Date().toISOString());
    const wAfter = fake.seen.wa.length;
    await sleep(2000);
    check('après désabonnement : aucun envoi, même avec un nouvel événement', fake.seen.wa.length === wAfter, fake.seen.wa.slice(wAfter));
    r = await owner('POST', `${D}/test`);
    check('après désabonnement : le test refuse tant qu\'il n\'y a pas de nouveau consentement', r.status === 400);
    // Isolation
    r = await zoe('GET', `${O2}/mail/digest`);
    check('isolation : une autre organisation ne voit ni abonnés ni journal', r.status === 200 && r.json.log.length === 0 && r.json.me.phone === '' && r.json.connected === false, r.json);
    r = await zoe('GET', `${O}/mail/digest`);
    check('une personne extérieure -> 404', r.status === 404);
    r = await marc('GET', D);
    check('un responsable ne voit que ses propres envois dans le journal', r.json.log.every((l) => l.who === undefined) && r.json.log.length >= 1);
    r = await owner('GET', D);
    check('un administrateur voit le journal de toute l\'équipe', r.json.log.some((l) => l.who === 'Marc') && r.json.log.some((l) => l.who === 'Awa'));
    check('le serveur n\'a pas planté', child.exitCode === null);
  } finally {
    try { if (rawDb) await rawDb.close(); } catch { /* fermée */ }
    child.kill();
    smtp.close(); fake.srv.close();
    await pgt.stop();
  }
  console.log(`\n${passed} réussis, ${failed} échec(s).`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
