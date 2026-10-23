'use strict';
// Test de l'espace de travail IA : organisations, rôles, antennes, modules, IA (avec un FAUX serveur Claude local).
// Lancez-le avec : npm run smoke:ws   (rien n'est modifié chez vous : base temporaire, aucun appel externe)
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const { startTestPg } = require('./lib/testdb');

let passed = 0;
let failed = 0;
const check = (name, cond, extra) => {
  if (cond) { passed++; console.log('  OK   ' + name); } else { failed++; console.log('  ECHEC ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); }
};
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); s.on('error', reject); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function client(base) {
  const jar = {};
  const cookieOf = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
  const fn = async (method, url, body) => {
    const headers = body !== undefined ? { 'content-type': 'application/json' } : {};
    const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie) headers.cookie = cookie;
    const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const sc of res.headers.getSetCookie()) { const [pair] = sc.split(';'); const i = pair.indexOf('='); jar[pair.slice(0, i).trim()] = pair.slice(i + 1).trim(); }
    const t = await res.text();
    let json = null;
    try { json = JSON.parse(t); } catch { /* non JSON */ }
    return { status: res.status, json, headers: res.headers, text: t };
  };
  // Envoi d'octets bruts (téléversement de fichier)
  fn.raw = async (method, url, buf, type) => {
    const res = await fetch(base + url, { method, headers: { 'content-type': type || 'application/octet-stream', ...(cookieOf() ? { cookie: cookieOf() } : {}) }, body: buf });
    const t = await res.text(); let json = null; try { json = JSON.parse(t); } catch { /* non JSON */ }
    return { status: res.status, json, headers: res.headers, text: t };
  };
  return fn;
}

// Faux serveur Claude : répond selon le type de consigne reçue.
const RDV_DATE = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
const RDV_TOMORROW = new Date(Date.now() + 3600000 + 86400000).toISOString().slice(0, 10);
function fakeClaude(port) {
  const seen = { last: null };
  const srv = http.createServer((req, res) => {
    let b = '';
    req.on('data', (d) => { b += d; });
    req.on('end', () => {
      if (req.url.startsWith('/graph/') || req.url.startsWith('/media/')) {
        const auth = req.headers.authorization || '';
        res.setHeader('content-type', 'application/json');
        if (req.method === 'POST' && /\/media$/.test(req.url)) { (seen.uploads = seen.uploads || []).push({ phoneId: req.url.split('/')[2], auth, len: b.length, hasProduct: /messaging_product/.test(b), audio: /audio\/ogg/.test(b) }); return res.end(JSON.stringify({ id: 'MID' + seen.uploads.length })); }
        if (req.method === 'POST' && /\/messages$/.test(req.url)) { const j0 = JSON.parse(b || '{}'); if (j0.recipient) { (seen.ms = seen.ms || []).push({ to: j0.recipient.id, text: (j0.message || {}).text, attachment: (j0.message || {}).attachment, page: req.url.split('/')[2], auth }); return res.end(JSON.stringify({ recipient_id: j0.recipient.id, message_id: 'm.out' })); }
          (seen.wa = seen.wa || []).push({ to: j0.to, body: (j0.text || {}).body, tpl: j0.template, type: j0.type, media: j0.image || j0.video || j0.audio || null, phoneId: req.url.split('/')[2], auth }); return res.end(JSON.stringify({ messages: [{ id: 'wamid.out' }] })); }
        if (req.url === '/media/img') { res.setHeader('content-type', 'image/png'); return res.end(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(60, 7)])); }
        if (req.url === '/media/pdf') { res.setHeader('content-type', 'application/pdf'); return res.end(Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(60, 8)])); }
        if (req.url.startsWith('/media/')) { res.setHeader('content-type', 'audio/ogg'); seen.mediaAuth = auth; return res.end(Buffer.concat([Buffer.from('OggS'), Buffer.alloc(40, 1)])); }
        if (/^\/graph\/IMG/.test(req.url)) return res.end(JSON.stringify({ url: `http://127.0.0.1:${port}/media/img` }));
        if (/^\/graph\/PDF/.test(req.url)) return res.end(JSON.stringify({ url: `http://127.0.0.1:${port}/media/pdf` }));
        if (/^\/graph\/MEDIA/.test(req.url)) return res.end(JSON.stringify({ url: `http://127.0.0.1:${port}/media/1` }));
        if (/\/subscribed_apps$/.test(req.url)) { (seen.subs = seen.subs || []).push({ method: req.method, url: req.url, auth }); return res.end(req.method === 'POST' ? JSON.stringify({ success: true }) : JSON.stringify({ data: [{ whatsapp_business_api_data: { name: 'Manager-ia' } }] })); }
        return res.end(JSON.stringify({ display_phone_number: '+237 677 11 22 33', verified_name: 'Boutique Awa' }));
      }
      if (req.url.includes('/audio/speech')) { const jj = JSON.parse(b || '{}'); (seen.tts = seen.tts || []).push({ format: jj.response_format, input: jj.input, voice: jj.voice, auth: req.headers.authorization }); res.setHeader('content-type', 'audio/ogg'); return res.end(jj.response_format === 'aac' ? Buffer.concat([Buffer.from([0xff, 0xf1]), Buffer.alloc(80, 3)]) : Buffer.concat([Buffer.from('OggS'), Buffer.alloc(80, 2)])); }
      if (req.url.includes('/audio/transcriptions')) { res.setHeader('content-type', 'application/json'); seen.stt = (seen.stt || 0) + 1; return res.end(JSON.stringify({ text: 'Bonjour, ORDER pour deux robes wax svp' })); }
      const j = JSON.parse(b || '{}');
      const sys = Array.isArray(j.system) ? j.system.map((x) => x.text).join('\n\n') : (j.system || '');
      seen.last = { system: sys, messages: j.messages };
      let text = 'Réponse de test.';
      const lastRaw = ((j.messages || []).slice(-1)[0] || {}).content || '';
      const parts = Array.isArray(lastRaw) ? lastRaw : null;
      const lastUser = parts ? parts.filter((p) => p.type === 'text').map((p) => p.text).join(' ') : lastRaw;
      if (parts) seen.lastParts = parts.map((p) => ({ type: p.type, media: p.source && p.source.media_type, len: p.source && p.source.data ? p.source.data.length : 0 }));
      if (sys.includes("Tu es l'assistant commercial public")) {
        seen.publicCalls = (seen.publicCalls || 0) + 1;
        let o = { reply: 'Bonjour ! Voici nos produits.', action: null };
        if (/RDVTOM(\d)/.test(lastUser)) { const k = Number(/RDVTOM(\d)/.exec(lastUser)[1]); o = { reply: 'Très bien, je note le rendez-vous.', action: { type: 'appointment', date: RDV_TOMORROW, time: ['', '09:00', '11:00', '13:00', '15:00'][k], purpose: 'visite', name: ['', 'Léa', 'Max', 'Nina', 'Omar'][k] + ' Test', phone: '677 33 22 1' + k } }; }
        else if (/RDVBAD/.test(lastUser)) o = { reply: 'Très bien, je note le rendez-vous.', action: { type: 'appointment', date: '2020-01-01', time: '10:00', purpose: 'passé', name: 'Zoé Test', phone: '677 55 44 33' } };
        else if (/RDVSLOT/.test(lastUser)) o = { reply: 'Très bien, je note le rendez-vous.', action: { type: 'appointment', date: RDV_DATE, time: '10:30', purpose: 'visite', name: 'Chloé Test', phone: '677 99 88 77' } };
        else if (/RDV/.test(lastUser)) o = { reply: 'Très bien, je note le rendez-vous.', action: { type: 'appointment', date: RDV_DATE, time: '10:00', purpose: 'visite de la boutique', name: 'Zoé Test', phone: '677 55 44 33' } };
        else if (/SHOWPIC2/.test(lastUser)) o = { reply: 'Je vous envoie la photo.', action: { type: 'send_media', items: ['Chapeau'], kind: 'image' } };
        else if (/SHOWPIC/.test(lastUser)) o = { reply: 'Je vous envoie la photo.', action: { type: 'send_media', items: ['Robe wax Aïcha'], kind: 'all' } };
        else if (parts && /RECU/.test(lastUser)) o = { reply: 'Merci, un conseiller va vérifier votre paiement.', action: { type: 'handoff', reason: 'preuve de paiement reçue : 15000, MTN' } };
        else if (parts) o = { reply: 'Belle robe ! Elle ressemble à notre Robe wax Aïcha.', action: null };
        else if (/WAORDER/.test(lastUser)) o = { reply: 'Parfait, je confirme.', action: { type: 'order', items: [{ name: 'Robe wax Aïcha', quantity: 2 }], note: 'Akwa' } };
        else if (/REGWA/.test(lastUser)) o = { reply: 'Merci, je vous enregistre.', action: { type: 'register', name: 'Paul WA' } };
        else if (/ORDER/.test(lastUser)) o = { reply: 'Parfait, je confirme votre commande.', action: { type: 'order', items: [{ name: 'robe WAX', quantity: 2, price: 1 }, { name: 'Chapeau', quantity: 1 }], note: 'Douala, Akwa', name: 'Paul Test', phone: '677 11 22 33' } };
        else if (/REGISTER/.test(lastUser)) o = { reply: 'Merci, je vous enregistre.', action: { type: 'register', name: 'Paul Test', phone: '677 11 22 33', email: 'paul@exemple.com' } };
        else if (/HUMAIN/.test(lastUser)) o = { reply: 'Je transmets à un conseiller.', action: { type: 'handoff', reason: 'demande de remise' } };
        o.lead = { need: 'robes wax', quantity: '2 pièces', deadline: 'vendredi', place: 'Douala', budget: '', temperature: 'tiede' };
        text = JSON.stringify(o);
      } else
      if (sys.includes("Tu es l'assistant INTERNE")) { seen.briefs = (seen.briefs || 0) + 1; seen.briefInput = (j.messages[0] || {}).content; text = JSON.stringify({ summary: 'Zoé Test veut visiter la boutique. Rendez-vous demandé.', customer: { name: 'Zoé Test', phone: '677 55 44 33', email: 'zoe@exemple.com', address: 'Bonamoussadi, Douala' }, nextSteps: ['Confirmer le rendez-vous', 'Appeler la cliente'], draftReply: 'Bonjour Zoé, nous avons bien reçu votre demande. Un conseiller vous confirme très vite.' }); } else
      if (sys.includes('assistant comptable')) text = /FLOU/.test(lastUser) ? JSON.stringify({ error: 'Précisez le montant.' }) : /DESEQ/.test(lastUser) ? JSON.stringify({ journal: 'CA', label: 'x', lines: [{ account: '622', debit: 1000 }, { account: '571', credit: 900 }] }) : JSON.stringify({ journal: 'CA', date: '2026-10-15', label: 'Loyer octobre', lines: [{ account: '622', debit: 150000 }, { account: '571', credit: 150000 }] });
      else if (sys.includes('plan de projet')) text = JSON.stringify({ name: 'Lancer la boutique', description: 'Ouvrir en ligne', tasks: [{ title: 'Choisir le nom', priority: 'high', dueInDays: 3 }, { title: 'Créer la page', dueInDays: 10, description: 'x' }, { title: '' }] });
      else if (sys.includes('postes qui manquent')) text = 'Voici : ' + JSON.stringify({ positions: [{ title: 'Directeur', description: 'd', reportsTo: null }, { title: 'Responsable ventes', description: 'v', reportsTo: 'Directeur' }] });
      else if (sys.includes('procédure de fonctionnement')) text = JSON.stringify({ title: 'Accueil client', category: 'Ventes', steps: ['Saluer', 'Écouter'] });
      else if (sys.includes('limites de dépense')) text = JSON.stringify({ plans: [{ category: 'Loyer', monthlyLimit: 50000 }], advice: ['ok'] });
      else if (sys.includes('réponse au client')) text = JSON.stringify({ reply: 'Bonjour, nous revenons vers vous.', note: '' });
      else if (sys.includes('message commercial')) text = JSON.stringify({ subject: 'Proposition pour votre équipe', message: 'Bonjour Marie, voici notre offre. Prix : [prix à confirmer].', note: 'Joindre le catalogue' });
      else if (sys.includes('commandes à passer')) text = JSON.stringify({ orders: [{ item: 'Savon', quantity: 17, supplier: 'Grossiste Nord', why: 'Sous le seuil' }, { item: 'Inconnu', quantity: 1 }], advice: [] });
      else if (sys.includes('message de relance')) text = JSON.stringify({ message: 'Bonjour Marie, un rappel pour la facture.', note: '' });
      else if (sys.includes('texte-non-json')) text = 'pas de json';
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ content: [{ type: 'text', text }] }));
    });
  });
  return new Promise((resolve) => srv.listen(port, '127.0.0.1', () => resolve({ srv, seen })));
}

/** Faux serveur SMTP : accepte tout et garde les messages reçus (aucun e-mail réel ne part). */
function fakeSmtp(port, box) {
  const srv = net.createServer((sock) => {
    let data = ''; let inData = false; let buf = '';
    sock.write('220 fake ESMTP\r\n');
    sock.on('data', (chunk) => {
      buf += chunk.toString('latin1');
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (inData) {
          if (line === '.') { inData = false; box.push(data); data = ''; sock.write('250 OK\r\n'); } else data += line + '\n';
        } else if (/^EHLO|^HELO/i.test(line)) sock.write('250-fake\r\n250 8BITMIME\r\n');
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
  const smtpPort = await freePort();
  const mailbox = [];
  const smtp = await fakeSmtp(smtpPort, mailbox);
  const fport = await freePort();
  const fake = await fakeClaude(fport);
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const pgt = await startTestPg();
  const blank = ['ALLOWED_ORIGINS', 'COOKIE_SAMESITE', 'COOKIE_SECURE', 'SMTP_HOST', 'WHATSAPP_PHONE_ID', 'WHATSAPP_TOKEN', 'CAMPAY_USERNAME', 'CAMPAY_PASSWORD', 'BUSINESS_FILE', 'KNOWLEDGE_DIR'];
  const env = { ...process.env, ...Object.fromEntries(blank.map((k) => [k, ''])), NODE_ENV: 'test', PORT: String(port), JWT_SECRET: 'secret-de-test-assez-long-123456', DATABASE_URL: pgt.url,
    ANTHROPIC_API_KEY: 'cle-de-test', ANTHROPIC_BASE_URL: `http://127.0.0.1:${fport}`, META_GRAPH_URL: `http://127.0.0.1:${fport}/graph`, STT_API_KEY: 'cle-stt', STT_BASE_URL: `http://127.0.0.1:${fport}/v1`, ADMIN_USERNAME: 'admin-test', ADMIN_PASSWORD: 'mot-de-passe-admin-test', TRUST_PROXY: '0', WS_AI_FREE: '100', AI_PER_MINUTE: '500', SIGNUP_VERIFY: 'off', WEBHOOK_ALLOW_PRIVATE: '1', META_MEDIA_ALLOW_ANY: '1', API_PUBLIC_URL: `http://127.0.0.1:${port}`, REPLY_DELAY_SCALE: '20', REPLY_TICK_MS: '50', REMINDER_HOUR: '0', REMINDER_TICK_MS: '100', SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtpPort), SMTP_FROM: 'noreply@manager-ia.test', WS_BRANCHES_FREE: '2' };
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { await sleep(250); try { up = (await fetch(base + '/api/health')).ok; } catch { /* pas prêt */ } }
  if (!up) { console.log('Le serveur n\'a pas démarré.\n' + out); process.exit(1); }

  try {
    const stamp = Date.now();
    const owner = client(base);
    const boss2 = client(base);
    const staff = client(base);
    const anon = client(base);
    const reg = (c, name, n) => c('POST', '/api/register', { name, contact: `${name.toLowerCase()}${n}@exemple.com`, pass: 'secret123' });
    check('inscription propriétaire', (await reg(owner, 'Awa', stamp)).status === 201);
    check('inscription employé', (await reg(staff, 'Paul', stamp)).status === 201);
    check('inscription autre patron', (await reg(boss2, 'Zoe', stamp)).status === 201);

    let r;
    console.log('Sans connexion');
    r = await anon('GET', '/api/ws/orgs');
    check('liste des organisations sans cookie -> 401', r.status === 401, r.json);

    console.log('Organisation');
    r = await owner('POST', '/api/ws/orgs', { name: '' });
    check('nom obligatoire -> 400', r.status === 400, r.json);
    r = await owner('POST', '/api/ws/orgs', { name: 'Boutique Awa', sector: 'Commerce', currency: 'FCFA', description: 'Vente de pagnes' });
    check('création -> 201', r.status === 201 && r.json.id > 0, r.json);
    const org = r.json.id;
    await owner('PUT', `/api/ws/orgs/${org}/sales/settings`, { voiceReply: 'off', handoffOrder: false, handoffAppt: false }); // les essais plus bas les activent explicitement
    r = await owner('POST', '/api/ws/orgs', { name: 'Deuxième' });
    check('2e organisation en offre Gratuite -> 403', r.status === 403 && /organisation/.test(r.json.error), r.json);
    r = await owner('GET', `/api/ws/orgs/${org}`);
    check('détail : propriétaire + modules + budget visible', r.status === 200 && r.json.me.role === 'owner' && r.json.modules.some((m) => m.id === 'budget') && typeof r.json.intakeToken === 'string', r.json);
    const token = r.json.intakeToken;
    r = await boss2('GET', `/api/ws/orgs/${org}`);
    check('une personne extérieure ne voit pas l\'organisation -> 404', r.status === 404, r.json);

    console.log('Antennes et invitations');
    r = await owner('POST', `/api/ws/orgs/${org}/branches`, { name: 'Douala', location: 'Akwa' });
    check('antenne créée', r.status === 201, r.json);
    const br1 = r.json.id;
    r = await owner('POST', `/api/ws/orgs/${org}/branches`, { name: 'Yaoundé' });
    check('2e antenne créée (limite de test : 2)', r.status === 201, r.json);
    const br2 = r.json.id;
    r = await owner('POST', `/api/ws/orgs/${org}/branches`, { name: 'Bafoussam' });
    check('3e antenne -> 403 (limite de l\'offre)', r.status === 403 && /antenne/.test(r.json.error), r.json);
    r = await owner('POST', `/api/ws/orgs/${org}/invites`, { role: 'member', title: 'Vendeur', branchId: br1 });
    check('invitation créée', r.status === 201 && /^[0-9A-F]{10}$/.test(r.json.code), r.json);
    const code = r.json.code;
    r = await staff('POST', '/api/ws/orgs/join', { code: 'FAUX' });
    check('mauvais code -> 400', r.status === 400, r.json);
    r = await staff('POST', '/api/ws/orgs/join', { code });
    check('rejoindre avec le code', r.status === 200 && r.json.id === org, r.json);
    r = await boss2('POST', '/api/ws/orgs/join', { code });
    check('le code ne sert qu\'une fois -> 400', r.status === 400, r.json);
    r = await staff('GET', `/api/ws/orgs/${org}`);
    check('employé : rôle membre, pas de module budget, pas de jeton public', r.status === 200 && r.json.me.role === 'member' && !r.json.modules.some((m) => m.id === 'budget') && r.json.intakeToken === undefined, r.json);
    const staffId = r.json.me.userId;
    r = await owner('POST', `/api/ws/orgs/${org}/invites`, { role: 'member' });
    r = await boss2('POST', '/api/ws/orgs/join', { code: r.json.code });
    check('4e personne en offre Gratuite (3 max) -> accepté', r.status === 200, r.json);
    r = await owner('POST', `/api/ws/orgs/${org}/invites`, { role: 'member' });
    const c5 = r.json.code;
    const extra = client(base);
    await reg(extra, 'Luc', stamp);
    r = await extra('POST', '/api/ws/orgs/join', { code: c5 });
    check('au-delà de 3 personnes -> 403', r.status === 403, r.json);
    r = await staff('POST', `/api/ws/orgs/${org}/invites`, { role: 'member' });
    check('un membre ne peut pas inviter -> 403', r.status === 403, r.json);
    r = await staff('PUT', `/api/ws/orgs/${org}/members/${staffId}`, { role: 'admin' });
    check('un membre ne peut pas se promouvoir -> 403', r.status === 403, r.json);
    r = await owner('PUT', `/api/ws/orgs/${org}/members/${staffId}`, { role: 'manager', title: 'Responsable de vente' });
    check('le propriétaire promeut en responsable', r.status === 200, r.json);

    console.log('Service client');
    r = await anon('POST', `/api/ws/public/intake/${token}`, { name: 'Client Un', message: 'Ma commande est en retard', contact: '699000111' });
    check('formulaire public -> ticket', r.status === 201, r.json);
    r = await anon('POST', '/api/ws/public/intake/mauvais', { name: 'X', message: 'Y' });
    check('jeton public inconnu -> 404', r.status === 404, r.json);
    r = await owner('GET', `/api/ws/orgs/${org}/support`);
    check('ticket visible dans la boîte', r.status === 200 && r.json.tickets.length === 1 && r.json.counts.open === 1, r.json);
    const tid = r.json.tickets[0].id;
    r = await owner('POST', `/api/ws/orgs/${org}/support/${tid}/messages`, { content: 'Bonjour, nous vérifions.' });
    check('réponse de l\'équipe', r.status === 201, r.json);
    r = await owner('GET', `/api/ws/orgs/${org}/support/${tid}`);
    check('statut passé à « en attente », 2 messages', r.json.ticket.status === 'pending' && r.json.messages.length === 2, r.json);
    r = await owner('POST', `/api/ws/orgs/${org}/support`, { customerName: 'Client Deux', subject: 'Prix', channel: 'whatsapp', branchId: br1 });
    check('ticket manuel dans une antenne', r.status === 201, r.json);

    console.log('Projets et tâches');
    r = await staff('POST', `/api/ws/orgs/${org}/projects`, { name: 'Test' });
    check('responsable peut créer un projet', r.status === 201, r.json);
    const pid = r.json.id;
    r = await owner('POST', `/api/ws/orgs/${org}/projects/tasks`, { projectId: pid, title: 'Appeler le fournisseur', assigneeId: staffId, due: '2020-01-01', priority: 'high' });
    check('tâche créée', r.status === 201, r.json);
    const taskId = r.json.id;
    r = await owner('POST', `/api/ws/orgs/${org}/projects/tasks`, { title: 'X', assigneeId: 99999 });
    check('assigner à quelqu\'un d\'extérieur -> 400', r.status === 400, r.json);
    r = await owner('POST', `/api/ws/orgs/${org}/projects/tasks`, { title: 'Bad', due: '31/12/2026' });
    check('date invalide -> 400', r.status === 400, r.json);
    r = await owner('GET', `/api/ws/orgs/${org}/projects`);
    check('projet : 1 tâche en retard', r.json.projects.some((p) => p.id === pid && p.tasks === 1 && p.overdue === 1), r.json);
    r = await owner('PUT', `/api/ws/orgs/${org}/projects/tasks/${taskId}`, { status: 'done' });
    check('tâche terminée', r.status === 200, r.json);

    console.log('Budget (responsables et plus)');
    r = await boss2('GET', `/api/ws/orgs/${org}/budget`);
    check('simple membre -> 403', r.status === 403, r.json);
    r = await owner('POST', `/api/ws/orgs/${org}/budget/entries`, { kind: 'income', category: 'Ventes', amount: '250 000', date: new Date().toISOString().slice(0, 10) });
    check('entrée ajoutée (montant avec espace)', r.status === 201, r.json);
    r = await owner('POST', `/api/ws/orgs/${org}/budget/entries`, { kind: 'expense', category: 'Loyer', amount: 60000 });
    check('sortie ajoutée', r.status === 201, r.json);
    r = await owner('POST', `/api/ws/orgs/${org}/budget/entries`, { kind: 'expense', category: 'Loyer', amount: -5 });
    check('montant négatif -> 400', r.status === 400, r.json);
    r = await owner('GET', `/api/ws/orgs/${org}/budget`);
    check('totaux du mois', r.json.income === 250000 && r.json.expense === 60000 && r.json.balance === 190000 && r.json.categories[0].category === 'Loyer', r.json);

    console.log('Organisation et fonctionnement');
    r = await owner('POST', `/api/ws/orgs/${org}/structure/positions`, { title: 'Directrice', holderId: 99999 });
    check('titulaire hors équipe -> 400', r.status === 400, r.json);
    r = await owner('POST', `/api/ws/orgs/${org}/structure/positions`, { title: 'Directrice' });
    const p1 = r.json.id;
    r = await owner('POST', `/api/ws/orgs/${org}/structure/positions`, { title: 'Vendeur', parentId: p1 });
    const p2 = r.json.id;
    r = await owner('PUT', `/api/ws/orgs/${org}/structure/positions/${p1}`, { parentId: p2 });
    check('boucle hiérarchique refusée -> 400', r.status === 400, r.json);
    r = await owner('POST', `/api/ws/orgs/${org}/structure/processes`, { title: 'Ouverture', steps: [] });
    check('procédure sans étape -> 400', r.status === 400, r.json);
    r = await staff('POST', `/api/ws/orgs/${org}/structure/processes`, { title: 'Ouverture', steps: ['a'] });
    check('responsable (non admin) ne crée pas de procédure -> 403', r.status === 403, r.json);

    console.log('IA');
    r = await owner('POST', `/api/ws/orgs/${org}/ai/chat`, { module: 'general', message: 'Où en suis-je ?' });
    check('discussion générale', r.status === 200 && r.json.text === 'Réponse de test.' && r.json.remaining === 99, r.json);
    const sys = fake.seen.last.system;
    check('contexte envoyé : organisation, budget, tickets, consignes anti-injection', sys.includes('Boutique Awa') && sys.includes('BUDGET du mois') && sys.includes('Client Un') && sys.includes('DONNÉES') && sys.includes('Vouvoiement') && sys.includes('Mission et vision'), sys.slice(0, 300));
    r = await staff('POST', `/api/ws/orgs/${org}/ai/chat`, { module: 'budget', message: 'Mes sous ?' });
    check('responsable peut parler budget', r.status === 200, r.json);
    r = await boss2('POST', `/api/ws/orgs/${org}/ai/chat`, { module: 'budget', message: 'Mes sous ?' });
    check('simple membre : IA budget refusée -> 403', r.status === 403, r.json);
    r = await boss2('POST', `/api/ws/orgs/${org}/ai/chat`, { module: 'general', message: 'Où en suis-je ?' });
    check('simple membre : contexte général SANS budget', r.status === 200 && fake.seen.last.system.includes('BUDGET : non accessible') && !fake.seen.last.system.includes('BUDGET du mois'), fake.seen.last.system.slice(0, 200));
    r = await owner('POST', `/api/ws/orgs/${org}/ai/ping`);
    check("test de l'IA (administrateur) : réponse, durée, aucun secret", r.status === 200 && r.json.ok === true && typeof r.json.ms === 'number' && r.json.keySet === true && !JSON.stringify(r.json).includes('cle-de-test'), r.json);
    r = await boss2('POST', `/api/ws/orgs/${org}/ai/ping`);
    check("test de l'IA : simple membre -> 403", r.status === 403, r.json);
    r = await owner('GET', `/api/ws/orgs/${org}/ai/history?module=general`);
    check('historique conservé', r.json.messages.length === 2 && r.json.enabled === true, r.json);
    r = await owner('POST', `/api/ws/orgs/${org}/ai/chat`, { module: 'inconnu', message: 'x' });
    check('module inconnu -> 400', r.status === 400, r.json);

    r = await owner('POST', `/api/ws/orgs/${org}/ai/propose`, { kind: 'project-plan', input: { goal: 'Lancer la boutique en ligne' } });
    check('proposition de projet', r.status === 200 && r.json.proposal.tasks.length === 3, r.json);
    const plan = r.json.proposal;
    r = await owner('POST', `/api/ws/orgs/${org}/ai/apply`, { kind: 'project-plan', proposal: plan });
    check('projet appliqué (tâche vide ignorée)', r.status === 201, r.json);
    r = await owner('GET', `/api/ws/orgs/${org}/projects/${r.json.id}`);
    check('projet créé avec 2 tâches et échéances', r.json.tasks.length === 2 && r.json.tasks.every((t) => /^\d{4}-\d{2}-\d{2}$/.test(t.due)), r.json);
    r = await owner('POST', `/api/ws/orgs/${org}/ai/propose`, { kind: 'org-structure', input: {} });
    check('proposition d\'organigramme (JSON entouré de texte)', r.status === 200 && r.json.proposal.positions.length === 2, r.json);
    r = await owner('POST', `/api/ws/orgs/${org}/ai/apply`, { kind: 'org-structure', proposal: r.json.proposal });
    check('postes ajoutés avec hiérarchie', r.status === 201 && r.json.created === 2, r.json);
    r = await owner('GET', `/api/ws/orgs/${org}/structure/positions`);
    const dir = r.json.positions.find((p) => p.title === 'Directeur');
    check('« Responsable ventes » rend compte à « Directeur »', dir && r.json.positions.find((p) => p.title === 'Responsable ventes').parentId === dir.id, r.json);
    r = await owner('POST', `/api/ws/orgs/${org}/ai/propose`, { kind: 'process-draft', input: { topic: 'Accueil' } });
    r = await owner('POST', `/api/ws/orgs/${org}/ai/apply`, { kind: 'process-draft', proposal: r.json.proposal });
    check('procédure créée par l\'IA', r.status === 201, r.json);
    r = await owner('POST', `/api/ws/orgs/${org}/ai/propose`, { kind: 'budget-plan', input: {} });
    r = await owner('POST', `/api/ws/orgs/${org}/ai/apply`, { kind: 'budget-plan', proposal: r.json.proposal });
    check('limites budget appliquées', r.status === 200, r.json);
    r = await owner('GET', `/api/ws/orgs/${org}/budget`);
    check('limite visible dans le budget', r.json.categories.find((c) => c.category === 'Loyer').limit === 50000, r.json);

    r = await staff('POST', `/api/ws/orgs/${org}/ai/propose`, { kind: 'org-structure', input: {} });
    check('proposition réservée aux administrateurs -> 403', r.status === 403, r.json);
    r = await staff('POST', `/api/ws/orgs/${org}/ai/apply`, { kind: 'org-structure', proposal: { positions: [{ title: 'Pirate' }] } });
    check('application réservée aux administrateurs -> 403', r.status === 403, r.json);
    r = await staff('POST', `/api/ws/orgs/${org}/ai/propose`, { kind: 'ticket-reply', input: { ticketId: tid } });
    check('brouillon de réponse client', r.status === 200 && r.json.proposal.reply.startsWith('Bonjour'), r.json);
    r = await owner('POST', `/api/ws/orgs/${org}/ai/apply`, { kind: 'ticket-reply', proposal: {} });
    check('« ticket-reply » non applicable -> 400', r.status === 400, r.json);

    r = await owner('POST', `/api/ws/orgs/${org}/ai/briefing`);
    check('point de situation', r.status === 200 && typeof r.json.text === 'string', r.json);

    console.log('Alertes, santé, décisions');
    await owner('POST', `/api/ws/orgs/${org}/support`, { customerName: 'Urgent Un', subject: 'Panne de livraison', priority: 'high' });
    await owner('POST', `/api/ws/orgs/${org}/projects/tasks`, { title: 'Tâche en retard', due: '2020-02-02' });
    r = await owner('GET', `/api/ws/orgs/${org}/dashboard`);
    check('alerte « demande urgente » + alerte « tâche en retard »', r.json.alerts.some((x) => x.module === 'support' && x.level === 'high') && r.json.alerts.some((x) => x.module === 'projects'), r.json.alerts);
    check('score de santé calculé (25 à 100) avec libellé', r.json.health.score >= 25 && r.json.health.score < 100 && typeof r.json.health.label === 'string', r.json.health);
    check('série budget sur 6 mois pour le propriétaire', Array.isArray(r.json.series) && r.json.series.length === 6 && r.json.series[5].income === 250000, r.json.series);
    check('projets avec avancement', r.json.projects.length >= 1 && typeof r.json.projects[0].percent === 'number', r.json.projects);
    r = await boss2('GET', `/api/ws/orgs/${org}/dashboard`);
    check('membre : pas de série budget, pas d\'alerte budget', r.json.series === null && !r.json.alerts.some((x) => x.module === 'budget'), r.json);
    r = await boss2('GET', `/api/ws/orgs/${org}/dashboard/alerts`);
    check('liste des alertes', r.status === 200 && Array.isArray(r.json.alerts), r.json);

    r = await boss2('POST', `/api/ws/orgs/${org}/decisions`, { title: 'Acheter 20 mètres de tissu', amount: '45 000', detail: 'Pour la nouvelle collection' });
    check('un membre soumet une demande de validation', r.status === 201, r.json);
    const d1 = r.json.id;
    r = await boss2('PUT', `/api/ws/orgs/${org}/decisions/${d1}`, { status: 'approved' });
    check('un membre ne peut pas valider -> 403', r.status === 403, r.json);
    r = await staff('POST', `/api/ws/orgs/${org}/decisions`, { title: 'Embaucher une vendeuse' });
    const d2 = r.json.id;
    r = await staff('PUT', `/api/ws/orgs/${org}/decisions/${d2}`, { status: 'approved' });
    check('un responsable ne valide pas sa propre demande -> 403', r.status === 403, r.json);
    r = await staff('GET', `/api/ws/orgs/${org}/decisions`);
    check('le responsable voit les demandes en attente', r.json.decisions.length === 2, r.json);
    r = await boss2('GET', `/api/ws/orgs/${org}/decisions`);
    check('un membre ne voit que ses propres demandes', r.json.decisions.length === 1 && r.json.decisions[0].id === d1, r.json);
    r = await staff('PUT', `/api/ws/orgs/${org}/decisions/${d1}`, { status: 'approved', note: 'OK' });
    check('un responsable valide la demande d\'un membre', r.status === 200, r.json);
    r = await staff('PUT', `/api/ws/orgs/${org}/decisions/${d1}`, { status: 'rejected' });
    check('demande déjà traitée -> 409', r.status === 409, r.json);
    r = await owner('PUT', `/api/ws/orgs/${org}/decisions/${d2}`, { status: 'rejected', note: 'Pas maintenant' });
    check('le propriétaire refuse', r.status === 200, r.json);
    r = await owner('POST', `/api/ws/orgs/${org}/decisions`, { title: '' });
    check('titre obligatoire -> 400', r.status === 400, r.json);
    r = await staff('POST', `/api/ws/orgs/${org}/ai/chat`, { module: 'alerts', message: 'Explique-moi' });
    check('IA du module Alertes (contexte avec alertes)', r.status === 200 && fake.seen.last.system.includes('ALERTES ACTUELLES'), r.json);

    console.log('Tableau de bord, activité');
    r = await owner('GET', `/api/ws/orgs/${org}/dashboard`);
    check('tableau de bord avec budget', r.status === 200 && r.json.stats.budget.balance === 190000 && r.json.stats.team.members === 3, r.json);
    r = await boss2('GET', `/api/ws/orgs/${org}/dashboard`);
    check('tableau de bord d\'un membre : pas de budget', r.status === 200 && r.json.stats.budget === undefined, r.json);
    r = await owner('GET', `/api/ws/orgs/${org}/activity`);
    check('journal d\'activité', r.status === 200 && r.json.activity.length > 3, r.json);

    console.log('Isolation par antenne');
    r = await owner('POST', `/api/ws/orgs/${org}/projects`, { name: 'Projet Douala', branchId: br1 });
    const prDla = r.json.id;
    r = await owner('POST', `/api/ws/orgs/${org}/projects`, { name: 'Projet siège' });
    const pr0 = r.json.id;
    // boss2 est « membre sans antenne » (voit tout) ; on crée un membre rattaché à une autre antenne via rôle/antenne
    r = await owner('PUT', `/api/ws/orgs/${org}/branches/${br1}`, { name: 'Douala', location: 'Akwa' });
    check('antenne modifiée', r.status === 200, r.json);
    const leftEmp = client(base);
    await reg(leftEmp, 'Eva', stamp);
    // libérer une place (3 max) : boss2 quitte l'organisation
    r = await boss2('GET', `/api/ws/orgs/${org}`);
    const boss2Id = r.json.me.userId;
    r = await boss2('DELETE', `/api/ws/orgs/${org}/members/${boss2Id}`);
    check('un membre peut quitter l\'organisation', r.status === 200, r.json);
    r = await boss2('GET', `/api/ws/orgs/${org}`);
    check('après départ : plus d\'accès -> 404', r.status === 404, r.json);
    r = await owner('GET', `/api/ws/orgs/${org}/members`);
    check('le propriétaire voit les contacts, 2 personnes restantes', r.json.members.length === 2 && r.json.members.every((m) => m.contact), r.json);
    r = await staff('GET', `/api/ws/orgs/${org}/projects`);
    check('responsable rattaché à Douala : voit projets de son antenne + communs', r.status === 200 && r.json.projects.some((p) => p.id === prDla) && r.json.projects.some((p) => p.id === pr0), r.json);
    r = await owner('POST', `/api/ws/orgs/${org}/projects`, { name: 'Projet Yaoundé', branchId: br2 });
    const prYde = r.json.id;
    r = await staff('GET', `/api/ws/orgs/${org}/projects`);
    check('ne voit PAS le projet de l\'autre antenne', !r.json.projects.some((p) => p.id === prYde), r.json);
    r = await staff('GET', `/api/ws/orgs/${org}/projects/${prYde}`);
    check('accès direct au projet d\'une autre antenne -> 404', r.status === 404, r.json);
    r = await staff('PUT', `/api/ws/orgs/${org}/projects/${prYde}`, { name: 'Piraté' });
    check('modification d\'un projet d\'une autre antenne -> 404', r.status === 404, r.json);
    r = await owner('GET', `/api/ws/orgs/${org}/projects`);
    check('le propriétaire voit tous les projets', [prDla, pr0, prYde].every((i) => r.json.projects.some((p) => p.id === i)), r.json);

    console.log('Tableau de bord administrateur');
    const adm = client(base);
    r = await adm('GET', '/api/admin/overview');
    check('overview sans connexion admin -> 401', r.status === 401, r.json);
    r = await adm('POST', '/api/admin/login', { username: 'admin-test', password: 'mot-de-passe-admin-test' });
    check('connexion administrateur', r.status === 200, r.json);
    await anon('POST', '/api/contact', { name: 'Karim D.', what: 'Devis', message: 'Devis pour 3 antennes', contact: '699000222' });
    r = await adm('GET', '/api/admin/overview');
    const ov = r.json;
    check('overview : indicateurs', r.status === 200 && ov.kpi.users >= 5 && ov.kpi.orgs >= 1 && ov.kpi.aiToday >= 1 && typeof ov.kpi.activeOrgs === 'number', ov.kpi);
    check('overview : série de 6 mois et répartition des offres', ov.series.length === 6 && ov.plans.Gratuit >= 1 && ov.plans.prices.Pro > 0, [ov.series, ov.plans]);
    check('overview : à traiter (demande de contact non traitée)', ov.todo.leads >= 1 && ov.leads[0].name === 'Karim D.', ov.todo);
    check('overview : santé du système sans aucun secret', ov.system.length === 5 && !JSON.stringify(ov.system).includes('cle-de-test') && ov.system.find((x) => x.key === 'ai').status === 'ok', ov.system);
    check('overview : derniers inscrits sans mot de passe', ov.latestUsers.length >= 1 && !('pass_hash' in ov.latestUsers[0]), ov.latestUsers[0]);
    r = await adm('GET', '/api/admin/overview?days=7');
    check('overview : période de 7 jours', r.json.days === 7, r.json.days);
    r = await adm('GET', '/api/admin/orgs');
    check('liste des organisations', r.status === 200 && r.json.orgs.length >= 1 && typeof r.json.orgs[0].members === 'number', r.json);
    r = await adm('GET', '/api/admin/ai-usage');
    check('utilisation de l\'IA sur 14 jours', r.status === 200 && r.json.days.length === 14 && r.json.total >= 1, r.json);
    r = await adm('GET', '/api/admin/settings');
    check('paramètres : statuts seulement', r.status === 200 && Array.isArray(r.json.system) && !JSON.stringify(r.json).includes('mot-de-passe-admin-test'), r.json);
    r = await adm('GET', '/api/admin/leads');
    const lead = r.json.leads[0];
    r = await adm('POST', `/api/admin/leads/${lead.id}/handled`, {});
    check('marquer une demande comme traitée', r.status === 200, r.json);
    r = await adm('GET', '/api/admin/overview');
    check('la demande traitée sort de la liste « à traiter »', r.json.todo.leads === 0, r.json.todo);
    r = await owner('GET', '/api/admin/overview');
    check('un utilisateur simple ne peut pas voir l\'administration -> 401', r.status === 401, r.json);

    console.log('Stock et achats');
    const plain = client(base);
    await reg(plain, 'Ada', stamp);
    r = await owner('POST', `/api/ws/orgs/${org}/invites`, { role: 'member' });
    r = await plain('POST', '/api/ws/orgs/join', { code: r.json.code });
    check('un simple membre rejoint pour les essais des nouveaux modules', r.status === 200, r.json);
    const S = `/api/ws/orgs/${org}/stock`;
    r = await plain('POST', `${S}/items`, { name: 'Savon' });
    check('stock : un simple membre ne crée pas d\'article -> 403', r.status === 403, r.json);
    r = await owner('POST', `${S}/items`, { name: 'Savon', unit: 'pièce', quantity: 3, minQuantity: 10, unitCost: 500 });
    check('stock : article créé', r.status === 201, r.json);
    const savon = r.json.id;
    r = await owner('POST', `${S}/items`, { name: 'Huile', unit: 'litre', quantity: '50,5', minQuantity: 5, unitCost: 1200 });
    const huile = r.json.id;
    r = await owner('POST', `${S}/items`, { name: '', quantity: 1 });
    check('stock : nom obligatoire -> 400', r.status === 400, r.json);
    r = await owner('POST', `${S}/items`, { name: 'Neg', quantity: -2 });
    check('stock : quantité négative -> 400', r.status === 400, r.json);
    r = await owner('POST', `${S}/suppliers`, { name: 'Marché Central', contact: '699111222' });
    const supC = r.json.id;
    r = await owner('POST', `${S}/suppliers`, { name: 'Grossiste Nord' });
    const supN = r.json.id;
    r = await owner('PUT', `${S}/items/${savon}/prices`, { prices: [{ supplierId: supC, unitPrice: 450, leadDays: 2 }, { supplierId: supN, unitPrice: 400, leadDays: 7 }] });
    check('stock : prix des fournisseurs enregistrés', r.status === 200, r.json);
    r = await owner('GET', S);
    const sv = r.json.items.find((x) => x.name === 'Savon');
    check('stock : « Savon » sous le seuil, meilleur prix = Grossiste Nord', sv.state === 'low' && sv.best.supplier === 'Grossiste Nord' && sv.best.unitPrice === 400 && r.json.summary.low === 1 && r.json.items.find((x) => x.name === 'Huile').quantity === 50.5, r.json);
    check('stock : valeur du stock visible du propriétaire', r.json.summary.value === Math.round(3 * 500 + 50.5 * 1200), r.json.summary);
    r = await plain('POST', `${S}/items/${huile}/move`, { kind: 'out', quantity: 100 });
    check('stock : sortie supérieure au stock -> 400', r.status === 400 && /insuffisant/i.test(r.json.error), r.json);
    r = await plain('POST', `${S}/items/${huile}/move`, { kind: 'out', quantity: 0.5, reason: 'Vente' });
    check('stock : un membre enregistre une sortie', r.status === 200 && r.json.quantity === 50, r.json);
    r = await owner('GET', `${S}/items/${huile}/moves`);
    check('stock : historique des mouvements', r.json.moves.length === 2 && r.json.moves[0].delta === -0.5, r.json);
    r = await owner('GET', `/api/ws/orgs/${org}/dashboard`);
    check('alerte stock : « Savon » sous le seuil', r.json.alerts.some((x) => x.module === 'stock' && x.level === 'medium' && /Savon/.test(x.text)), r.json.alerts);
    r = await owner('GET', `${S}/reorder`);
    check('réapprovisionnement : 17 à commander (double du seuil - stock)', r.json.suggestions.length === 1 && r.json.suggestions[0].toOrder === 17 && r.json.suggestions[0].best.supplier === 'Grossiste Nord', r.json);

    r = await staff('POST', `/api/ws/orgs/${org}/ai/propose`, { kind: 'reorder', input: {} });
    check('IA : proposition de commandes', r.status === 200 && r.json.proposal.orders.length === 2, r.json);
    r = await plain('POST', `/api/ws/orgs/${org}/ai/apply`, { kind: 'reorder', proposal: r.json.proposal });
    check('IA : un simple membre ne peut pas appliquer -> 403', r.status === 403, r.json);
    r = await staff('POST', `/api/ws/orgs/${org}/ai/apply`, { kind: 'reorder', proposal: { orders: [{ item: 'savon', quantity: 17, supplier: 'grossiste nord' }, { item: 'Inconnu', quantity: 1 }] } });
    check('IA : commande créée (article inconnu ignoré)', r.status === 201 && r.json.created === 1, r.json);
    r = await owner('GET', `${S}/orders`);
    const po = r.json.orders[0];
    check('commande « à valider » au prix du fournisseur (17 × 400)', po.status === 'pending' && po.quantity === 17 && po.unitPrice === 400 && po.total === 6800 && po.supplier === 'Grossiste Nord', r.json);
    r = await owner('GET', `${S}/reorder`);
    check('réapprovisionnement : plus rien à proposer (déjà commandé)', r.json.suggestions.length === 0, r.json);
    r = await staff('PUT', `${S}/orders/${po.id}/status`, { status: 'ordered' });
    check('commande : on ne valide pas sa propre demande -> 403', r.status === 403, r.json);
    r = await owner('PUT', `${S}/orders/${po.id}/status`, { status: 'received' });
    check('commande : « reçue » impossible avant validation -> 400', r.status === 400, r.json);
    r = await owner('PUT', `${S}/orders/${po.id}/status`, { status: 'ordered' });
    check('commande validée par le propriétaire', r.status === 200, r.json);
    r = await owner('PUT', `${S}/orders/${po.id}/status`, { status: 'received' });
    check('commande reçue', r.status === 200, r.json);
    r = await owner('GET', S);
    check('stock augmenté à la réception (3 + 17 = 20) et coût mis à jour', r.json.items.find((x) => x.name === 'Savon').quantity === 20 && r.json.items.find((x) => x.name === 'Savon').unitCost === 400 && r.json.items.find((x) => x.name === 'Savon').state === 'ok', r.json);
    r = await owner('GET', `/api/ws/orgs/${org}/budget`);
    check('la réception inscrit une dépense « Achats » (6 800) au budget', r.json.entries.some((e) => e.category === 'Achats' && e.amount === 6800 && e.kind === 'expense'), r.json.entries);

    console.log('Clients et ventes');
    const C = `/api/ws/orgs/${org}/crm`;
    r = await plain('POST', `${C}/customers`, { name: 'Marie T.', phone: '677000111' });
    check('clients : un membre ajoute une fiche', r.status === 201, r.json);
    const cust = r.json.id;
    r = await plain('GET', `${C}/documents`);
    check('ventes : devis et factures réservés aux responsables -> 403', r.status === 403, r.json);
    r = await plain('GET', `${C}/customers`);
    check('clients : le membre ne voit pas les montants dus', r.status === 200 && r.json.customers[0].owed === undefined, r.json);
    r = await owner('POST', `${C}/documents`, { kind: 'invoice', customerId: cust, due: '2020-01-01', total: 1, lines: [{ label: 'Pagne', quantity: 2, price: 15000 }, { label: 'Livraison', quantity: 1, price: 2000 }] });
    check('facture : total recalculé par le serveur (32 000)', r.status === 201, r.json);
    const inv = r.json.id;
    r = await owner('POST', `${C}/documents/${inv}/payments`, { amount: 5000 });
    check('paiement sur facture non envoyée -> 400', r.status === 400, r.json);
    r = await owner('POST', `${C}/documents`, { kind: 'invoice', customerId: cust, lines: [] });
    check('facture sans ligne -> 400', r.status === 400, r.json);
    r = await owner('PUT', `${C}/documents/${inv}`, { status: 'sent' });
    check('facture envoyée', r.status === 200, r.json);
    r = await owner('GET', `${C}/documents?kind=invoice`);
    const idoc = r.json.documents.find((d) => d.id === inv);
    check('facture : 32 000, numérotée, en retard', idoc.total === 32000 && /^F-\d{4}-0001$/.test(idoc.number) && idoc.overdue === true && r.json.summary.owed === 32000 && r.json.summary.overdueCount === 1, r.json);
    r = await owner('GET', `/api/ws/orgs/${org}/dashboard`);
    check('alerte « facture impayée en retard » (urgente : plus de 30 jours)', r.json.alerts.some((x) => x.module === 'crm' && x.level === 'high' && /32\s?000/.test(x.text)), r.json.alerts);
    r = await owner('POST', `${C}/documents/${inv}/payments`, { amount: 12000 });
    check('paiement partiel (12 000)', r.status === 200 && r.json.paid === 12000 && r.json.status === 'sent', r.json);
    r = await owner('POST', `${C}/documents/${inv}/payments`, { amount: 30000 });
    check('paiement supérieur au solde -> 400', r.status === 400, r.json);
    r = await owner('POST', `${C}/documents/${inv}/payments`, { amount: 20000 });
    check('solde payé : facture soldée', r.status === 200 && r.json.status === 'paid', r.json);
    r = await owner('GET', `/api/ws/orgs/${org}/budget`);
    check('les paiements inscrivent 32 000 d\'entrées « Ventes » au budget', r.json.entries.filter((e) => /^Paiement/.test(e.label)).reduce((a, e) => a + e.amount, 0) === 32000, r.json.entries);
    r = await owner('PUT', `${C}/documents/${inv}`, { status: 'cancelled' });
    check('facture payée : statut figé -> 400', r.status === 400, r.json);
    r = await owner('POST', `${C}/documents`, { kind: 'quote', customerId: cust, lines: [{ label: 'Robe', quantity: 1, price: 25000 }] });
    const quote = r.json.id;
    r = await owner('POST', `${C}/documents/${quote}/convert`, {});
    check('devis non accepté : pas de conversion -> 400', r.status === 400, r.json);
    await owner('PUT', `${C}/documents/${quote}`, { status: 'accepted' });
    r = await owner('POST', `${C}/documents/${quote}/convert`, {});
    check('devis accepté -> facture brouillon', r.status === 201, r.json);
    r = await owner('GET', `${C}/customers/${cust}`);
    check('fiche client : historique des documents', r.json.documents.length === 3 && r.json.documents.some((d) => d.kind === 'invoice' && d.total === 25000 && d.status === 'draft'), r.json);
    r = await owner('POST', `${C}/documents`, { kind: 'invoice', customerId: cust, due: '2020-03-03', lines: [{ label: 'Tissu', quantity: 1, price: 9000 }] });
    await owner('PUT', `${C}/documents/${r.json.id}`, { status: 'sent' });
    r = await staff('POST', `/api/ws/orgs/${org}/ai/propose`, { kind: 'payment-reminder', input: { documentId: r.json.id } });
    check('IA : message de relance prêt à envoyer', r.status === 200 && /Marie/.test(r.json.proposal.message), r.json);
    r = await staff('POST', `/api/ws/orgs/${org}/ai/apply`, { kind: 'payment-reminder', proposal: {} });
    check('« payment-reminder » non applicable -> 400', r.status === 400, r.json);

    console.log('Ressources humaines');
    const H = `/api/ws/orgs/${org}/hr`;
    r = await plain('GET', H);
    check('RH : réservé aux responsables -> 403', r.status === 403, r.json);
    r = await staff('POST', `${H}/employees`, { name: 'Jean', job: 'Vendeur', salary: 90000 });
    check('RH : un responsable ajoute un employé', r.status === 201, r.json);
    const e1 = r.json.id;
    r = await owner('POST', `${H}/employees`, { name: 'Claire', job: 'Caissière', salary: 80000, hiredAt: '2024-01-15' });
    const e2 = r.json.id;
    r = await staff('GET', H);
    check('RH : le responsable ne voit aucun salaire', r.status === 200 && r.json.employees.every((e) => e.salary === undefined) && r.json.summary.payroll === undefined, r.json);
    r = await owner('GET', H);
    check('RH : le propriétaire voit les salaires (le salaire saisi par un responsable est ignoré)', r.json.employees.find((e) => e.name === 'Claire').salary === 80000 && r.json.employees.find((e) => e.name === 'Jean').salary === null && r.json.summary.payroll === 80000, r.json);
    r = await owner('POST', `${H}/leaves`, { employeeId: e2, start: '2030-05-06', end: '2030-05-10', kind: 'annual' });
    check('congé demandé', r.status === 201, r.json);
    const lv = r.json.id;
    r = await owner('POST', `${H}/leaves`, { employeeId: e2, start: '2030-05-08', end: '2030-05-12' });
    check('congé qui chevauche un autre -> 400', r.status === 400, r.json);
    r = await owner('POST', `${H}/leaves`, { employeeId: e2, start: '2030-05-12', end: '2030-05-01' });
    check('congé qui finit avant de commencer -> 400', r.status === 400, r.json);
    r = await owner('GET', `/api/ws/orgs/${org}/dashboard`);
    check('alerte RH : demande de congé en attente', r.json.alerts.some((x) => x.module === 'hr'), r.json.alerts);
    r = await staff('PUT', `${H}/leaves/${lv}/decision`, { decision: 'approved' });
    check('congé accepté par un responsable', r.status === 200, r.json);
    r = await staff('PUT', `${H}/leaves/${lv}/decision`, { decision: 'refused' });
    check('décision déjà prise -> 400', r.status === 400, r.json);
    r = await owner('POST', `${H}/shifts`, { employeeId: e2, day: '2030-05-07', start: '08:00', end: '16:00' });
    check('planning : pas d\'horaire pendant un congé accepté -> 400', r.status === 400 && /congé/.test(r.json.error), r.json);
    r = await owner('POST', `${H}/shifts`, { employeeId: e2, day: '2030-05-13', start: '08:00', end: '16:00' });
    check('planning : horaire ajouté', r.status === 201, r.json);
    r = await owner('POST', `${H}/shifts`, { employeeId: e2, day: '2030-05-13', start: '15:00', end: '18:00' });
    check('planning : horaire qui se chevauche -> 400', r.status === 400, r.json);
    r = await owner('POST', `${H}/shifts`, { employeeId: e2, day: '2030-05-14', start: '18:00', end: '08:00' });
    check('planning : fin avant début -> 400', r.status === 400, r.json);
    r = await owner('GET', `${H}/planning?week=2030-05-15`);
    check('planning : semaine du lundi 13 au dimanche 19 mai', r.json.start === '2030-05-13' && r.json.end === '2030-05-19' && r.json.shifts.length === 1 && r.json.shifts[0].start === '08:00', r.json);
    r = await owner('GET', `${H}/planning?week=2030-05-08`);
    check('planning : la semaine du congé le montre', r.json.leaves.length === 1 && r.json.shifts.length === 0, r.json);
    r = await staff('DELETE', `${H}/employees/${e1}`);
    check('RH : suppression d\'un employé réservée aux administrateurs -> 403', r.status === 403, r.json);

    r = await staff('POST', `/api/ws/orgs/${org}/ai/chat`, { module: 'hr', message: 'Qui est absent ?' });
    check('IA RH : accessible à un responsable', r.status === 200, r.json);
    const sysHr = fake.seen.last.system;
    check('IA RH : employés et connaissances RH dans le contexte, sans salaire pour un responsable', sysHr.includes('Claire') && sysHr.includes('Méthode — Ressources humaines') && !/salaire (80|90)/i.test(sysHr), sysHr.slice(0, 200));


    console.log('E-mails aux clients et propositions commerciales');
    const M = `/api/ws/orgs/${org}/mail`;
    const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');
    r = await plain('POST', `${M}/files`, { name: 'logo.png', data: PNG.toString('base64') });
    check('e-mails : un simple membre ne peut pas envoyer de fichier -> 403', r.status === 403, r.json);
    r = await staff('POST', `${M}/files`, { name: 'faux.png', data: Buffer.from('ceci est du texte').toString('base64') });
    check('fichier : un faux PNG (texte) est refusé -> 400', r.status === 400 && /Format/.test(r.json.error), r.json);
    r = await staff('POST', `${M}/files`, { name: 'virus.png', data: Buffer.concat([PNG, Buffer.alloc(2.2 * 1024 * 1024)]).toString('base64') });
    check('fichier : plus de 2 Mo -> 413', r.status === 413, r.json);
    r = await staff('POST', `${M}/files`, { name: 'Ma photo <b>.exe', data: PNG.toString('base64') });
    check('fichier : image valide acceptée, nom nettoyé et extension corrigée', r.status === 201 && r.json.mime === 'image/png' && /^[^<>]+\.png$/.test(r.json.name), r.json);
    const fileId = r.json.id;
    r = await staff('POST', `${M}/send`, { customerId: cust, subject: 'Votre devis', body: 'Bonjour Marie', fileIds: [fileId] });
    check('e-mail : client sans adresse e-mail -> 400', r.status === 400 && /adresse e-mail/.test(r.json.error), r.json);
    await staff('PUT', `${C}/customers/${cust}`, { email: 'marie@exemple.com' });
    r = await plain('POST', `${M}/send`, { customerId: cust, subject: 'x', body: 'y' });
    check('e-mail : un simple membre ne peut pas envoyer -> 403', r.status === 403, r.json);
    r = await staff('POST', `${M}/send`, { customerId: 99999, subject: 'x', body: 'y' });
    check('e-mail : client inconnu -> 404', r.status === 404, r.json);
    r = await staff('POST', `${M}/send`, { customerId: cust, subject: 'Votre devis\nBcc: pirate@exemple.com', body: 'Bonjour Marie, voici votre devis.', fileIds: [fileId] });
    check('e-mail envoyé au client avec une pièce jointe', r.status === 200 && r.json.sentToday === 1 && r.json.limitPerDay === 5, r.json);
    await sleep(400);
    const got = mailbox.find((m) => /marie@exemple\.com/.test(m) && /Votre devis/.test(m));
    check('e-mail reçu : destinataire, objet sans injection d\'en-tête, signature, pièce jointe PNG', got && /^To: .*marie@exemple\.com/m.test(got) && !/^Bcc:/mi.test(got) && /avec MANAGER-IA/.test(got) && /Boutique Awa/.test(got) && /Content-Type: image\/png/i.test(got) && /Reply-To:/i.test(got), got && got.slice(0, 600));
    r = await staff('GET', M);
    check('journal des envois et fichiers', r.json.enabled === true && r.json.outbox.length === 1 && r.json.outbox[0].status === 'sent' && r.json.files.length === 1 && r.json.sentToday === 1, r.json);
    const raw0 = await pgt.open();
    for (let i = 0; i < 4; i++) await raw0.prepare("INSERT INTO outbox (org_id, user_id, customer_id, to_email, subject, body, status, created_at) VALUES (?, 1, ?, 'a@b.cm', 's', 'b', 'sent', ?)").run(org, cust, new Date().toISOString());
    await raw0.close();
    r = await staff('POST', `${M}/send`, { customerId: cust, subject: 'Encore', body: 'Encore un' });
    check('quota d\'e-mails par jour (5 en Gratuit) -> 429', r.status === 429 && /5 e-mails par jour/.test(r.json.error), r.json);
    r = await staff('DELETE', `${M}/files/${fileId}`);
    check('fichier supprimé', r.status === 200, r.json);

    r = await staff('POST', `/api/ws/orgs/${org}/ai/propose`, { kind: 'sales-proposal', input: { need: 'Il veut 200 chemises pour son équipe', kind: 'tender', customerId: cust } });
    check('IA : proposition commerciale avec champs à compléter entre crochets', r.status === 200 && /\[prix à confirmer\]/.test(r.json.proposal.message) && r.json.proposal.subject && r.json.proposal.note, r.json);
    check('IA : le contexte contient le client, le type de message et la méthode « marchés »', /Marie T\./.test(fake.seen.last.messages[0].content) && /Réponse à un appel d'offres/.test(fake.seen.last.messages[0].content) && fake.seen.last.system.includes('Décrocher des clients et des marchés') && fake.seen.last.system.includes("n'invente AUCUN prix"), fake.seen.last.messages);
    r = await staff('POST', `/api/ws/orgs/${org}/ai/propose`, { kind: 'sales-proposal', input: { need: '' } });
    check('IA : besoin obligatoire -> 400', r.status === 400, r.json);
    r = await staff('POST', `/api/ws/orgs/${org}/ai/chat`, { module: 'stock', message: 'ke reste til en stok de savon stp ?' });
    check('IA : consignes de compréhension (fautes, SMS) et de raisonnement présentes', r.status === 200 && fake.seen.last.system.includes('écriture phonétique') && fake.seen.last.system.includes('Raisonner avant de répondre') && fake.seen.last.system.includes('même mal écrits'), fake.seen.last.system.slice(0, 200));

    console.log('Assistant commercial public : prospects, commandes, voix');
    const SL = `/api/ws/orgs/${org}/sales`;
    const PUB = `/api/ws/public/chat/${token}`;
    r = await anon('GET', `${PUB}/info`);
    check('public : l\'assistant est désactivé par défaut', r.status === 200 && r.json.enabled === false && r.json.name === 'Boutique Awa', r.json);
    r = await anon('POST', `${PUB}/message`, { message: 'Bonjour' });
    check('public : message refusé tant que l\'assistant est désactivé -> 403', r.status === 403, r.json);
    r = await owner('PUT', `${SL}/settings`, { chatEnabled: true });
    check('activation impossible sans catalogue -> 400', r.status === 400 && /catalogue/.test(r.json.error), r.json);
    r = await plain('GET', SL);
    check('assistant commercial réservé aux responsables -> 403', r.status === 403, r.json);
    r = await owner('POST', `${SL}/catalog`, { name: 'Robe wax Aïcha', price: 15000, unit: 'pièce', description: 'Robe longue' });
    check('catalogue : article ajouté', r.status === 201, r.json);
    r = await owner('POST', `${SL}/catalog`, { name: 'Sac Mbella', price: 9000 });
    r = await owner('POST', `${SL}/catalog`, { name: 'Gratuit', price: -5 });
    check('catalogue : prix négatif -> 400', r.status === 400, r.json);
    r = await owner('PUT', `${SL}/settings`, { chatEnabled: true, salesInfo: 'Livraison à Douala en 24 h. Paiement Mobile Money ou espèces.' });
    check('assistant public activé', r.status === 200, r.json);
    r = await anon('GET', `${PUB}/info`);
    check('public : activé, messages vocaux disponibles', r.json.enabled === true && r.json.voice === true, r.json);
    const usedBefore = (await owner('GET', `/api/ws/orgs/${org}`)).json.limits.aiUsed;

    r = await anon('POST', `${PUB}/message`, { message: 'Bonjour, je viens de voir votre pub', campaign: 'facebook-oct <script>' });
    check('prospect : première réponse, session créée', r.status === 200 && /^[a-f0-9]{32}$/.test(r.json.sessionId) && /Voici nos produits/.test(r.json.reply), r.json);
    const sess = r.json.sessionId;
    const sysPub = fake.seen.last.system;
    check('contexte IA : catalogue avec prix, infos pratiques, campagne nettoyée, règle anti-remise', /Robe wax Aïcha : 15\s?000 FCFA/.test(sysPub) && sysPub.includes('Livraison à Douala') && sysPub.includes('facebook-octscript') && !sysPub.includes('<script>') && sysPub.includes('Aucune remise'), sysPub.slice(0, 300));
    r = await anon('POST', `${PUB}/message`, { sessionId: sess, message: 'REGISTER je veux être client' });
    check('prospect enregistré dans les clients', r.status === 200 && r.json.registered === true, r.json);
    r = await owner('GET', `/api/ws/orgs/${org}/crm/customers`);
    const pr = r.json.customers.find((c) => c.name === 'Paul Test');
    check('fiche client créée : prospect, source = campagne', pr && pr.stage === 'prospect' && pr.source === 'facebook-octscript' && pr.email === 'paul@exemple.com', r.json.customers);
    r = await anon('POST', `${PUB}/message`, { sessionId: sess, message: 'ORDER oui je confirme' });
    check('commande : numéro C-…, prix du catalogue (pas celui de l\'IA), article inconnu signalé', r.status === 200 && r.json.order && /^C-\d{4}-\d{4}$/.test(r.json.order.number) && r.json.order.total === 30000 && /Chapeau/.test(r.json.reply) && /30\s?000/.test(r.json.reply), r.json);
    r = await owner('GET', `/api/ws/orgs/${org}/crm/customers`);
    check('le prospect devient client après sa commande, sans doublon', r.json.customers.filter((c) => c.name === 'Paul Test').length === 1 && r.json.customers.find((c) => c.name === 'Paul Test').stage === 'client', r.json.customers);
    r = await owner('GET', `/api/ws/orgs/${org}/dashboard`);
    check('alerte : commande de client à valider', r.json.alerts.some((x) => x.module === 'sales' && /commande/.test(x.text)), r.json.alerts);
    r = await owner('GET', `${SL}/orders`);
    const ord = r.json.orders[0];
    check('commandes : « à valider », lignes, client', ord.status === 'pending' && ord.total === 30000 && ord.lines[0].label === 'Robe wax Aïcha' && ord.lines[0].quantity === 2 && ord.customer === 'Paul Test' && /Douala/.test(ord.note), r.json);
    r = await owner('POST', `${SL}/orders/${ord.id}/invoice`, {});
    check('facture impossible avant confirmation -> 400', r.status === 400, r.json);
    r = await owner('PUT', `${SL}/orders/${ord.id}/status`, { status: 'confirmed' });
    check('commande confirmée', r.status === 200, r.json);
    r = await owner('PUT', `${SL}/orders/${ord.id}/status`, { status: 'cancelled' });
    check('commande déjà traitée -> 400', r.status === 400, r.json);
    r = await owner('POST', `${SL}/orders/${ord.id}/invoice`, {});
    check('facture créée depuis la commande', r.status === 201, r.json);
    r = await owner('GET', `/api/ws/orgs/${org}/crm/documents?kind=invoice`);
    check('la facture reprend les lignes (30 000)', r.json.documents.some((d) => d.total === 30000 && /Suite à la commande C-/.test(d.note)), r.json.documents);
    r = await owner('GET', `${SL}/chats`);
    check('conversations : campagne, client, dernier message', r.json.chats.length === 1 && r.json.chats[0].campaign === 'facebook-octscript' && r.json.chats[0].customer === 'Paul Test' && r.json.chats[0].messages >= 6, r.json);
    r = await owner('GET', `${SL}/chats/${r.json.chats[0].id}`);
    check('conversation complète lisible', r.json.messages.length >= 6 && r.json.messages[0].role === 'user', r.json.messages.length);

    // Demande de remise -> passage de la main (ticket) ; ensuite l'IA se tait
    r = await anon('POST', `${PUB}/message`, { message: 'HUMAIN je veux une remise', campaign: 'tiktok' });
    check('remise demandée : passage à un conseiller', r.status === 200 && r.json.handoff === true, r.json);
    const calls0 = fake.seen.publicCalls;
    r = await anon('POST', `${PUB}/message`, { sessionId: r.json.sessionId, message: 'Vous êtes là ?' });
    check('après passage de la main, l\'IA ne répond plus (pas de nouvel appel)', r.json.handoff === true && fake.seen.publicCalls === calls0, r.json);
    r = await owner('GET', `/api/ws/orgs/${org}/support?status=open`);
    check('un ticket « à reprendre » est créé dans le service client', JSON.stringify(r.json).includes('assistant-web') || JSON.stringify(r.json).includes('Conversation à reprendre'), JSON.stringify(r.json).slice(0, 200));

    // Voix
    const OGG = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(40, 1)]).toString('base64');
    r = await anon('POST', `${PUB}/voice`, { audio: Buffer.from('ceci n est pas un audio du tout').toString('base64') });
    check('voix : fichier qui n\'est pas un audio -> 400', r.status === 400, r.json);
    r = await anon('POST', `${PUB}/voice`, { audio: OGG, campaign: 'whatsapp-voix' });
    check('voix : message transcrit en texte puis traité comme un message (commande)', r.status === 200 && /ORDER/.test(r.json.transcript) && r.json.order && fake.seen.stt === 1, r.json);
    r = await anon('POST', `${PUB}/voice`, { audio: Buffer.alloc(3 * 1024 * 1024, 7).toString('base64') });
    check('voix : audio trop long -> 413', r.status === 413, r.json);
    r = await owner('GET', `${SL}/chats`);
    check('la transcription est conservée dans la conversation', JSON.stringify(r.json).includes('message vocal'), JSON.stringify(r.json).slice(0, 200));
    r = await owner('GET', `${SL}/campaigns`);
    const fb = r.json.campaigns.find((c) => c.campaign === 'facebook-octscript');
    check('campagnes : conversations, prospects, commandes par campagne (une commande n\'est comptée que pour sa conversation)', fb && fb.chats === 1 && fb.prospects === 1 && fb.ordered === 1 && fb.amount === 30000, r.json);
    const usedAfter = (await owner('GET', `/api/ws/orgs/${org}`)).json.limits.aiUsed;
    check('chaque message traité par l\'IA est compté dans le quota de l\'organisation', usedAfter - usedBefore >= 5, [usedBefore, usedAfter]);
    r = await owner('PUT', `${SL}/settings`, { chatEnabled: false });
    r = await anon('POST', `${PUB}/message`, { message: 'Bonjour' });
    check('assistant désactivé -> 403', r.status === 403, r.json);
    await owner('PUT', `${SL}/settings`, { chatEnabled: true });
    r = await owner('POST', `/api/ws/orgs/${org}/ai/chat`, { module: 'sales', message: 'Quelle campagne marche le mieux ?' });
    check('IA interne : module assistant commercial avec le contexte des campagnes', r.status === 200 && fake.seen.last.system.includes('Campagnes (conversations / prospects') && fake.seen.last.system.includes('facebook-octscript'), fake.seen.last.system.slice(0, 200));

    console.log('WhatsApp de l\'organisation (API officielle de Meta, simulée)');
    const WA = `/api/ws/public/whatsapp/${token}`;
    const PID = '109876543210', APPSECRET = 'secret-app-meta-123', TOKEN_WA = 'EAAG-jeton-de-test-0123456789';
    const waitFor = async (fn, ms = 4000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(50); } return false; };
    const post = (body, secret = APPSECRET, sig) => { const rawBody = JSON.stringify(body); return fetch(base + WA, { method: 'POST', headers: { 'content-type': 'application/json', ...(sig === null ? {} : { 'x-hub-signature-256': sig || 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex') }) }, body: rawBody }); };
    const payload = (from, id, msg, pid = PID) => ({ object: 'whatsapp_business_account', entry: [{ changes: [{ value: { metadata: { phone_number_id: pid }, contacts: [{ profile: { name: 'Client' }, wa_id: from }], messages: [{ from, id, timestamp: '1', ...msg }] } }] }] });
    const sent = () => (fake.seen.wa || []).length;
    r = await staff('PUT', `${SL}/whatsapp`, { phoneId: PID });
    check('WhatsApp : réglages réservés aux administrateurs -> 403', r.status === 403, r.json);
    r = await owner('PUT', `${SL}/whatsapp`, { phoneId: 'abc' });
    check('WhatsApp : identifiant sans chiffres -> 400', r.status === 400, r.json);
    r = await owner('PUT', `${SL}/whatsapp`, { phoneId: PID, number: '237 677 11 22 33', token: TOKEN_WA, appSecret: APPSECRET });
    const verifyTok = r.json.verifyToken;
    check('WhatsApp : connecté ; le jeton et le secret ne sont jamais renvoyés', r.status === 200 && r.json.connected === true && r.json.tokenSet && r.json.secretSet && /^[a-f0-9]{24}$/.test(verifyTok) && !JSON.stringify(r.json).includes('EAAG') && !JSON.stringify(r.json).includes(APPSECRET), r.json);
    const rawDb = await pgt.open();
    const row = await rawDb.prepare('SELECT wa_token, wa_secret FROM orgs WHERE id = ?').get(org);
    check('WhatsApp : jeton et secret chiffrés dans la base (illisibles sans la clé)', /^v1:/.test(row.wa_token) && !row.wa_token.includes('EAAG') && /^v1:/.test(row.wa_secret) && !row.wa_secret.includes(APPSECRET), [row.wa_token.slice(0, 8)]);
    await rawDb.close();
    r = await owner('GET', `${SL}/whatsapp`);
    check('WhatsApp : lecture des réglages sans secret', r.json.connected && !JSON.stringify(r.json).includes('EAAG') && r.json.webhookPath === WA, r.json);
    r = await owner('POST', `${SL}/whatsapp/test`);
    check('WhatsApp : test de connexion (numéro et nom vérifié)', r.status === 200 && /677/.test(r.json.number) && r.json.name === 'Boutique Awa', r.json);
    r = await owner('POST', `${SL}/whatsapp/subscribe`);
    check('WhatsApp : abonnement sans identifiant de compte -> 400', r.status === 400, r.json);
    r = await owner('PUT', `${SL}/whatsapp`, { wabaId: 'abc' });
    check('WhatsApp : identifiant de compte invalide -> 400', r.status === 400, r.json);
    r = await owner('PUT', `${SL}/whatsapp`, { wabaId: '1432309911579140' });
    check('WhatsApp : identifiant du compte enregistré', r.status === 200 && r.json.wabaId === '1432309911579140' && r.json.connected, r.json);
    r = await owner('POST', `${SL}/whatsapp/subscribe`);
    check('WhatsApp : abonnement de l\'application au compte (jeton envoyé, liste renvoyée)', r.status === 200 && r.json.subscribed === true && r.json.apps.includes('Manager-ia') && fake.seen.subs && fake.seen.subs[0].method === 'POST' && /1432309911579140\/subscribed_apps/.test(fake.seen.subs[0].url) && /^Bearer /.test(fake.seen.subs[0].auth), [r.json, fake.seen.subs]);
    let w = await fetch(`${base}${WA}?hub.mode=subscribe&hub.verify_token=${verifyTok}&hub.challenge=CH123`);
    check('webhook : vérification par Meta (jeton correct) -> renvoie le défi', w.status === 200 && (await w.text()) === 'CH123');
    w = await fetch(`${base}${WA}?hub.mode=subscribe&hub.verify_token=mauvais&hub.challenge=CH123`);
    check('webhook : mauvais jeton de vérification -> 403', w.status === 403);
    w = await post(payload('237655443322', 'wamid.0', { type: 'text', text: { body: 'x' } }), APPSECRET, null);
    check('webhook : message sans signature -> 403', w.status === 403);
    w = await post(payload('237655443322', 'wamid.0', { type: 'text', text: { body: 'x' } }), 'autre-secret');
    check('webhook : mauvaise signature -> 403, aucune réponse envoyée', w.status === 403 && sent() === 0, sent());

    w = await post(payload('237655443322', 'wamid.1', { type: 'text', text: { body: 'Bonjour #meta-oct je viens de voir votre pub' } }));
    check('webhook : message signé accepté', w.status === 200);
    await waitFor(() => sent() >= 1);
    const m1 = (fake.seen.wa || [])[0] || {};
    check('l\'IA répond sur WhatsApp au bon numéro, avec le jeton de l\'organisation', m1.to === '237655443322' && /Voici nos produits/.test(m1.body) && m1.auth === 'Bearer ' + TOKEN_WA && m1.phoneId === PID, m1);
    check('le contexte indique le canal WhatsApp et la campagne extraite du message', fake.seen.last.system.includes('Canal : WhatsApp') && fake.seen.last.system.includes('meta-oct') && !/#meta-oct/.test(fake.seen.last.messages[0].content), fake.seen.last.messages);
    await post(payload('237655443322', 'wamid.1', { type: 'text', text: { body: 'Bonjour #meta-oct je viens de voir votre pub' } }));
    await sleep(500);
    check('un message livré deux fois par Meta n\'est traité qu\'une fois', sent() === 1, sent());
    await post(payload('237655443322', 'wamid.2', { type: 'text', text: { body: 'REGWA je veux être client' } }));
    await waitFor(() => sent() >= 2);
    r = await owner('GET', `/api/ws/orgs/${org}/crm/customers`);
    const pw = r.json.customers.find((c) => c.name === 'Paul WA');
    check('prospect WhatsApp enregistré avec son numéro WhatsApp (sans le redemander) et la campagne', pw && pw.phone.replace(/\D/g, '') === '237655443322' && pw.stage === 'prospect' && pw.source === 'meta-oct', r.json.customers);
    await post(payload('237655443322', 'wamid.3', { type: 'text', text: { body: 'WAORDER oui je confirme' } }));
    await waitFor(() => sent() >= 3);
    check('commande prise sur WhatsApp : numéro, total calculé d\'après le catalogue', /C-\d{4}-\d{4}/.test(fake.seen.wa[2].body) && /30\s?000/.test(fake.seen.wa[2].body), fake.seen.wa[2]);
    r = await owner('GET', `${SL}/orders`);
    check('la commande WhatsApp attend la validation du patron', r.json.orders.some((o) => o.customer === 'Paul WA' && o.status === 'pending' && o.total === 30000), r.json.orders.map((o) => [o.customer, o.status]));

    const sttBefore = fake.seen.stt || 0;
    await post(payload('237699887766', 'wamid.4', { type: 'audio', audio: { id: 'MEDIA1', mime_type: 'audio/ogg; codecs=opus' } }));
    await waitFor(() => sent() >= 4);
    check('message vocal WhatsApp : audio téléchargé, transcrit, puis traité (commande)', (fake.seen.stt || 0) === sttBefore + 1 && fake.seen.mediaAuth === 'Bearer ' + TOKEN_WA && /J'ai compris/.test(fake.seen.wa[3].body) && /C-\d{4}-\d{4}/.test(fake.seen.wa[3].body), fake.seen.wa[3]);
    await post(payload('237699887766', 'wamid.5', { type: 'sticker', sticker: { id: 'STK1' } }));
    await waitFor(() => sent() >= 5);
    check('type non géré (autocollant) : réponse polie (texte, vocaux, photos et PDF seulement)', /messages écrits et les messages vocaux/.test(fake.seen.wa[4].body), fake.seen.wa[4]);
    await post(payload('237600000000', 'wamid.6', { type: 'text', text: { body: 'Bonjour' } }, '999999'));
    await sleep(500);
    check('message destiné à un autre numéro WhatsApp : ignoré', sent() === 5, sent());

    await post(payload('237611223344', 'wamid.7', { type: 'text', text: { body: 'HUMAIN je veux une remise' } }));
    await waitFor(() => sent() >= 6);
    check('demande de remise sur WhatsApp : passage à un conseiller', /conseiller/.test(fake.seen.wa[5].body), fake.seen.wa[5]);
    const calls1 = fake.seen.publicCalls;
    await post(payload('237611223344', 'wamid.8', { type: 'text', text: { body: 'Allô ? vous êtes là ?' } }));
    await sleep(600);
    check('après passage de la main sur WhatsApp : l\'IA se tait (aucune réponse, aucun appel IA)', sent() === 6 && fake.seen.publicCalls === calls1, [sent(), fake.seen.publicCalls, calls1]);

    r = await owner('GET', `${SL}/chats`);
    const hc = r.json.chats.find((c) => c.channel === 'whatsapp' && c.contact === '237611223344');
    check('conversations WhatsApp listées avec le canal et le numéro', hc && hc.status === 'handoff' && r.json.chats.filter((c) => c.channel === 'whatsapp').length === 3, r.json.chats.map((c) => [c.channel, c.contact]));
    r = await plain('POST', `${SL}/chats/${hc.id}/reply`, { text: 'x' });
    check('réponse humaine réservée aux responsables -> 403', r.status === 403, r.json);
    r = await owner('POST', `${SL}/chats/${hc.id}/reply`, { text: 'Bonjour, ici le responsable. Nous étudions votre demande.' });
    await waitFor(() => sent() >= 7);
    check('un responsable écrit au client sur WhatsApp depuis MANAGER-IA', r.status === 200 && fake.seen.wa[6].to === '237611223344' && /responsable/.test(fake.seen.wa[6].body), [r.json, fake.seen.wa[6]]);
    r = await owner('GET', `${SL}/chats/${hc.id}`);
    check('la réponse humaine est conservée dans la conversation', r.json.messages.some((m) => m.role === 'staff' && /responsable/.test(m.content)), r.json.messages.map((m) => m.role));
    const rawDb2 = await pgt.open();
    await rawDb2.prepare('UPDATE chat_messages SET created_at = ? WHERE chat_id = ?').run('2020-01-01T10:00:00.000Z', hc.id);
    await rawDb2.close();
    r = await owner('POST', `${SL}/chats/${hc.id}/reply`, { text: 'Encore là ?' });
    check('au-delà de 24 h sans message du client : réponse libre refusée (règle WhatsApp) -> 400', r.status === 400 && /24 h/.test(r.json.error), r.json);
    r = await owner('PUT', `${SL}/chats/${hc.id}/status`, { status: 'open' });
    check('la conversation peut être rendue à l\'IA', r.status === 200, r.json);


    console.log('Photos et documents reçus sur WhatsApp (lus par l\'IA)');
    const imgMsg = (from, id, type, mid, caption) => payload(from, id, type === 'image' ? { type: 'image', image: { id: mid, caption } } : { type: 'document', document: { id: mid, caption } });
    const mediaCalls0 = fake.seen.publicCalls; const wm0 = sent();
    w = await post(imgMsg('237677700001', 'wamid.img1', 'image', 'IMG1', 'Vous avez cette robe ?'));
    await waitFor(() => sent() >= wm0 + 1);
    check('photo reçue : l\'IA la reçoit (bloc image PNG) avec la légende, et répond', fake.seen.publicCalls === mediaCalls0 + 1 && fake.seen.lastParts.some((p) => p.type === 'image' && p.media === 'image/png' && p.len > 50) && fake.seen.lastParts.some((p) => p.type === 'text') && /Belle robe/.test(fake.seen.wa[fake.seen.wa.length - 1].body), [fake.seen.lastParts, fake.seen.wa[fake.seen.wa.length - 1]]);
    r = await owner('GET', `${SL}/chats`);
    const imgChat = r.json.chats.find((c) => c.contact === '237677700001');
    r = await owner('GET', `${SL}/chats/${imgChat.id}`);
    const imMsg = r.json.messages.find((m) => /^\[image #\d+\]/.test(m.content));
    check('la photo est rattachée à la conversation avec sa légende', imMsg && /Vous avez cette robe/.test(imMsg.content), r.json.messages);
    const mid = /#(\d+)/.exec(imMsg.content)[1];
    r = await owner('GET', `${SL}/chats/${imgChat.id}/media/${mid}`);
    check('l\'équipe peut ouvrir la photo (PNG, nosniff, sans cache, bac à sable)', r.status === 200 && /image\/png/.test(r.headers.get('content-type')) && r.headers.get('x-content-type-options') === 'nosniff' && /no-store/.test(r.headers.get('cache-control')) && /sandbox/.test(r.headers.get('content-security-policy')), [r.status, [...r.headers.keys()]]);
    r = await anon('GET', `${SL}/chats/${imgChat.id}/media/${mid}`);
    check('photo : sans connexion -> 401', r.status === 401, r.status);
    r = await plain('GET', `${SL}/chats/${imgChat.id}/media/${mid}`);
    check('photo : simple membre non concerné -> 403', r.status === 403, r.status);
    r = await owner('GET', `${SL}/chats/${imgChat.id}/media/999999`);
    check('photo inconnue -> 404', r.status === 404, r.status);

    const wm1 = sent(); const calls3 = fake.seen.publicCalls;
    w = await post(imgMsg('237677700002', 'wamid.bad1', 'image', 'MEDIAx', 'regardez'));
    await waitFor(() => sent() >= wm1 + 1);
    check('fichier déguisé (audio présenté comme image) : refusé, aucun appel IA', /photos \(JPEG, PNG, WebP\)/.test(fake.seen.wa[fake.seen.wa.length - 1].body) && fake.seen.publicCalls === calls3, fake.seen.wa[fake.seen.wa.length - 1]);

    const wm2 = sent();
    w = await post(imgMsg('237677700003', 'wamid.pay1', 'image', 'IMG2', 'RECU paiement'));
    await waitFor(() => sent() >= wm2 + 1);
    r = await owner('GET', `${SL}/chats`);
    check('reçu de paiement : l\'IA ne confirme rien et passe la main à l\'équipe', /vérifier votre paiement/.test(fake.seen.wa[fake.seen.wa.length - 1].body) && r.json.chats.find((c) => c.contact === '237677700003').status === 'handoff', r.json.chats.map((c) => [c.contact, c.status]));

    const wm3 = sent();
    w = await post(imgMsg('237677700004', 'wamid.pdf1', 'document', 'PDF1', 'Ma liste de commande'));
    await waitFor(() => sent() >= wm3 + 1);
    check('PDF reçu : transmis à l\'IA comme document', fake.seen.lastParts.some((p) => p.type === 'document' && p.media === 'application/pdf'), fake.seen.lastParts);
    const rawDb6 = await pgt.open();
    const nm = await rawDb6.prepare('SELECT COUNT(*) c, MAX(size) mx FROM chat_media').get();
    await rawDb6.close();
    check('pièces jointes conservées en base (3 : photo, reçu, PDF), le faux fichier n\'est pas gardé', nm.c === 3 && nm.mx < 5 * 1024 * 1024, nm);


    console.log('Photos et vidéos du catalogue envoyées sur WhatsApp');
    r = await owner('GET', `${SL}/catalog`);
    const robeId = r.json.items.find((x) => x.name === 'Robe wax Aïcha').id;
    const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(300, 5)]);
    const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypmp42'), Buffer.alloc(400, 6)]);
    const rawUp = async (who, id, buf, name) => who.raw('POST', `${SL}/catalog/${id}/media?name=${name || 'photo'}`, buf, 'application/octet-stream');
    r = await rawUp(plain, robeId, JPG);
    check('fichiers du catalogue : réservés aux responsables -> 403', r.status === 403, r.json);
    r = await rawUp(owner, robeId, Buffer.from('ceci est du texte et pas une image du tout'));
    check('fichier qui n\'est ni photo ni vidéo (texte déguisé) -> 400', r.status === 400, r.json);
    r = await rawUp(owner, robeId, Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(3.2 * 1024 * 1024, 1)]));
    check('photo de plus de 3 Mo -> 413', r.status === 413, r.json);
    r = await rawUp(owner, robeId, JPG, 'robe1');
    const photo1 = r.json && r.json.id;
    check('photo ajoutée à l\'article', r.status === 201 && r.json.kind === 'image', r.json);
    r = await rawUp(owner, robeId, MP4, 'defile');
    check('vidéo MP4 ajoutée à l\'article', r.status === 201 && r.json.kind === 'video', r.json);
    r = await owner('GET', `${SL}/catalog/${robeId}/media`);
    check('liste des fichiers de l\'article (1 photo, 1 vidéo)', r.json.media.length === 2 && r.json.media.some((m) => m.kind === 'image') && r.json.media.some((m) => m.kind === 'video'), r.json);
    r = await owner('GET', `${SL}/catalog/${robeId}/media/${photo1}/file`);
    check('aperçu sécurisé (type fixé, nosniff, sans cache)', r.status === 200 && /image\/jpeg/.test(r.headers.get('content-type')) && r.headers.get('x-content-type-options') === 'nosniff' && /no-store/.test(r.headers.get('cache-control')), [...r.headers.keys()]);

    const um0 = (fake.seen.uploads || []).length; const wm4 = sent();
    w = await post(payload('237677700099', 'wamid.pic1', { type: 'text', text: { body: 'SHOWPIC montre-moi la robe' } }));
    await waitFor(() => sent() >= wm4 + 3);
    const batch = fake.seen.wa.slice(wm4);
    check('le catalogue montre à l\'IA « fichiers disponibles : 1 photo(s), 1 vidéo(s) »', /fichiers disponibles : 1 photo\(s\), 1 vidéo\(s\)/.test(fake.seen.last.system), fake.seen.last.system.slice(-300));
    check('texte d\'abord, puis la photo, puis la vidéo (types WhatsApp image et video)', batch[0].type === 'text' && /vous envoie la photo/.test(batch[0].body) && batch[1].type === 'image' && batch[2].type === 'video', batch.map((x) => x.type));
    check('fichiers envoyés à Meta une seule fois chacun, puis envoyés par identifiant', (fake.seen.uploads || []).length === um0 + 2 && fake.seen.uploads[um0].hasProduct && /^MID\d+$/.test(batch[1].media.id) && batch[1].media.id !== batch[2].media.id, [fake.seen.uploads.length, batch[1].media]);
    check('la photo porte le nom et le prix de l\'article en légende', /Robe wax Aïcha/.test(batch[1].media.caption) && /15\s?000/.test(batch[1].media.caption), batch[1].media);
    check('les envois sont au bon numéro avec le jeton de l\'organisation', batch[1].to === '237677700099' && batch[1].auth === 'Bearer ' + TOKEN_WA, batch[1]);
    const wm5 = sent();
    w = await post(payload('237677700099', 'wamid.pic2', { type: 'text', text: { body: 'SHOWPIC encore une fois' } }));
    await waitFor(() => sent() >= wm5 + 3);
    check('2e demande : fichiers renvoyés SANS les renvoyer à Meta (identifiant gardé)', (fake.seen.uploads || []).length === um0 + 2 && fake.seen.wa[fake.seen.wa.length - 2].type === 'image', (fake.seen.uploads || []).length);
    r = await owner('GET', `${SL}/chats`);
    const picChat = r.json.chats.find((c) => c.contact === '237677700099');
    r = await owner('GET', `${SL}/chats/${picChat.id}`);
    check('l\'envoi est noté dans la conversation pour l\'équipe', r.json.messages.some((m) => /^\[fichier envoyé\] Robe wax Aïcha \(1 photo, 1 vidéo\)/.test(m.content)), r.json.messages.map((m) => m.content.slice(0, 40)));

    const wm6 = sent();
    w = await post(payload('237677700098', 'wamid.pic3', { type: 'text', text: { body: 'SHOWPIC2 le chapeau' } }));
    await waitFor(() => sent() >= wm6 + 1);
    await sleep(300);
    check('article sans fichier : aucune promesse, réponse honnête, rien d\'envoyé', sent() === wm6 + 1 && /pas de photo/.test(fake.seen.wa[fake.seen.wa.length - 1].body), fake.seen.wa.slice(wm6).map((x) => x.type + ':' + (x.body || '').slice(0, 60)));

    const wm7 = sent();
    r = await owner('POST', `${SL}/chats/${picChat.id}/send-media`, { itemId: robeId, kind: 'image' });
    await waitFor(() => sent() >= wm7 + 1);
    check('un responsable envoie lui-même la photo à un client', r.status === 200 && fake.seen.wa[fake.seen.wa.length - 1].type === 'image', r.json);
    r = await owner('POST', `${SL}/chats/${picChat.id}/send-media`, { itemId: robeId + 999, kind: 'image' });
    check('article inconnu -> 404', r.status === 404, r.json);

    // Page web : l'IA ne promet pas de fichier
    r = await anon('POST', `${PUB}/message`, { message: 'SHOWPIC sur le site' });
    check('sur la page web : pas d\'envoi de fichier, un conseiller sera proposé', r.status === 200 && /que sur WhatsApp/.test(r.json.reply), r.json);

    // Nettoyage : suppression d'un fichier
    r = await owner('DELETE', `${SL}/catalog/${robeId}/media/${photo1}`);
    r = await owner('GET', `${SL}/catalog/${robeId}/media`);
    check('suppression d\'un fichier', r.json.media.length === 1 && r.json.media[0].kind === 'video', r.json);

    console.log('Messages WhatsApp sortants : modèles, relances, rappels de factures, STOP');
    const WO = `${SL}/wa`;
    r = await plain('GET', WO);
    check('relances : réservées aux responsables -> 403', r.status === 403, r.json);
    r = await owner('GET', WO);
    check('relances : aucun modèle au départ, aucun prospect à relancer (conversation vieille de plus de 7 jours)', r.status === 200 && r.json.templates.length === 0 && r.json.silent.length === 0, r.json);
    r = await owner('POST', `${WO}/templates`, { name: 'Relance Prospect', purpose: 'relance', preview: 'x {{1}} {{2}}' });
    check('modèle : nom Meta invalide (majuscules, espaces) -> 400', r.status === 400, r.json);
    r = await owner('POST', `${WO}/templates`, { name: 'relance_prospect', purpose: 'relance', preview: 'Bonjour {{1}}' });
    check('modèle : mauvais nombre de variables pour une relance -> 400', r.status === 400 && /2 variable/.test(r.json.error), r.json);
    r = await owner('POST', `${WO}/templates`, { name: 'relance_prospect', purpose: 'relance', preview: "Bonjour {{1}}, c'est {{2}}. Toujours intéressé ?" });
    check('modèle de relance enregistré', r.status === 201, r.json);
    const w_tplRelance = r.json.id;
    r = await owner('POST', `${WO}/templates`, { name: 'relance_prospect', purpose: 'relance', preview: "Bonjour {{1}}, c'est {{2}}." });
    check('modèle en double -> 409', r.status === 409, r.json);
    r = await owner('POST', `${WO}/templates`, { name: 'rappel_facture', purpose: 'impaye', preview: 'Bonjour {{1}}, facture {{2}} : reste {{3}}. {{4}}' });
    check('modèle de rappel de facture enregistré', r.status === 201, r.json);
    r = await plain('POST', `${WO}/templates`, { name: 'autre', purpose: 'general', preview: 'x' });
    check('un simple membre ne peut pas créer de modèle -> 403', r.status === 403, r.json);

    const wn0 = sent();
    r = await owner('POST', `${WO}/chats/${hc.id}/template`, { templateId: w_tplRelance, params: ['Marie'] });
    check('envoi d\'un modèle : mauvais nombre de variables -> 400', r.status === 400, r.json);
    r = await owner('POST', `${WO}/chats/${hc.id}/template`, { templateId: w_tplRelance, params: ['Marie', 'Boutique Awa'] });
    await waitFor(() => sent() >= wn0 + 1);
    const w_tm = fake.seen.wa[fake.seen.wa.length - 1];
    check('modèle envoyé hors fenêtre de 24 h (type template, nom, langue, variables, bon numéro)', r.status === 200 && w_tm.type === 'template' && w_tm.tpl.name === 'relance_prospect' && w_tm.tpl.language.code === 'fr' && w_tm.tpl.components[0].parameters.map((x) => x.text).join('|') === 'Marie|Boutique Awa' && w_tm.to === '237611223344', [r.json, w_tm]);
    r = await owner('GET', `${SL}/chats/${hc.id}`);
    check('le modèle envoyé apparaît dans la conversation', r.json.messages.some((m) => m.role === 'staff' && /\[modèle relance_prospect\] Bonjour Marie, c'est Boutique Awa/.test(m.content)), r.json.messages.map((m) => m.content.slice(0, 40)));

    // Un prospect silencieux depuis 3 jours : relancé une seule fois
    w = await post(payload('237699001122', 'wamid.rel1', { type: 'text', text: { body: 'Bonjour, vous avez des robes ?' } }));
    await waitFor(() => sent() >= wn0 + 2);
    const rawDb3 = await pgt.open();
    const w_silentChat = await rawDb3.prepare("SELECT id FROM chats WHERE contact = '237699001122'").get();
    await rawDb3.prepare('UPDATE chat_messages SET created_at = ? WHERE chat_id = ?').run(new Date(Date.now() - 3 * 86400000).toISOString(), w_silentChat.id);
    await rawDb3.close();
    r = await owner('GET', WO);
    check('le prospect silencieux (3 jours) est proposé à la relance', r.json.silent.some((x) => x.contact === '237699001122'), r.json.silent);
    const wn1 = sent();
    r = await owner('POST', `${WO}/send`, { kind: 'relance' });
    await waitFor(() => sent() >= wn1 + 1);
    const relMsg = fake.seen.wa[fake.seen.wa.length - 1];
    check('relance envoyée avec le prénom et le nom de l\'entreprise', r.status === 200 && r.json.sent >= 1 && relMsg.type === 'template' && relMsg.tpl.name === 'relance_prospect' && relMsg.to === '237699001122' && relMsg.tpl.components[0].parameters[1].text === 'Boutique Awa', [r.json, relMsg]);
    const wn2 = sent();
    r = await owner('POST', `${WO}/send`, { kind: 'relance' });
    check('jamais deux relances au même prospect (0 envoi la 2e fois)', r.status === 200 && r.json.sent === 0 && sent() === wn2, r.json);

    // STOP / REPRENDRE
    const w_stopChat = (id) => payload('237688776655', id, { type: 'text', text: { body: id === 'wamid.stop' ? 'STOP' : id === 'wamid.go' ? 'Reprendre' : 'Bonjour, des chapeaux ?' } });
    w = await post(w_stopChat('wamid.hello'));
    await waitFor(() => sent() >= wn2 + 1);
    const rawDb4 = await pgt.open();
    await rawDb4.prepare("UPDATE chat_messages SET created_at = ? WHERE chat_id = (SELECT id FROM chats WHERE contact = '237688776655')").run(new Date(Date.now() - 3 * 86400000).toISOString());
    await rawDb4.close();
    r = await owner('GET', WO);
    check('avant STOP : ce prospect est relançable', r.json.silent.some((x) => x.contact === '237688776655'), r.json.silent);
    const w_calls2 = fake.seen.publicCalls; const wn3 = sent();
    w = await post(w_stopChat('wamid.stop'));
    await waitFor(() => sent() >= wn3 + 1);
    check('STOP : confirmation, aucun appel IA', /ne recevrez plus/.test(fake.seen.wa[fake.seen.wa.length - 1].body) && fake.seen.publicCalls === w_calls2, fake.seen.wa[fake.seen.wa.length - 1]);
    r = await owner('GET', WO);
    check('après STOP : plus proposé à la relance, compteur de désabonnés', !r.json.silent.some((x) => x.contact === '237688776655') && r.json.optouts === 1, [r.json.silent, r.json.optouts]);
    const w_sc = (await owner('GET', `${SL}/chats`)).json.chats.find((c) => c.contact === '237688776655');
    r = await owner('POST', `${WO}/chats/${w_sc.id}/template`, { templateId: w_tplRelance, params: ['Jean', 'Boutique Awa'] });
    check('après STOP : envoi d\'un modèle refusé -> 400', r.status === 400 && /ne plus recevoir/.test(r.json.error), r.json);
    const wn4 = sent();
    w = await post(w_stopChat('wamid.go'));
    await waitFor(() => sent() >= wn4 + 1);
    r = await owner('GET', WO);
    check('REPRENDRE : relances réactivées', /réactivés/.test(fake.seen.wa[fake.seen.wa.length - 1].body) && r.json.optouts === 0, r.json.optouts);

    // Factures impayées
    const rawDb5 = await pgt.open();
    const custDebt = (await rawDb5.prepare("INSERT INTO customers (org_id, name, phone, email, notes, created_at) VALUES (?, 'Ibrahim Debiteur', '655 12 34 56', '', '', ?)").run(org, new Date().toISOString())).lastInsertRowid;
    await rawDb5.prepare("INSERT INTO documents (org_id, customer_id, kind, number, status, lines, total, paid, issued, due, created_by, created_at, updated_at) VALUES (?, ?, 'invoice', 'F-TEST-1', 'sent', '[]', 50000, 10000, '2020-01-01', '2020-02-01', 1, ?, ?)").run(org, custDebt, new Date().toISOString(), new Date().toISOString());
    await rawDb5.close();
    r = await owner('GET', WO);
    check('la facture échue (reste 40 000) est proposée au rappel', r.json.overdue.some((i) => i.number === 'F-TEST-1' && i.left === 40000), r.json.overdue);
    const wn5 = sent();
    r = await owner('POST', `${WO}/send`, { kind: 'impaye' });
    await waitFor(() => sent() >= wn5 + 2);
    const invMsg = fake.seen.wa.slice(wn5).find((m) => m.to.endsWith('655123456')) || {};
    const ip = invMsg.tpl && invMsg.tpl.components ? invMsg.tpl.components[0].parameters.map((x) => x.text) : [];
    check('rappel de facture envoyé (prénom, numéro, reste à payer, entreprise, indicatif pays ajouté)', r.status === 200 && r.json.sent >= 1 && ip[0] === 'Ibrahim' && ip[1] === 'F-TEST-1' && /40\s?000/.test(ip[2]) && ip[3] === 'Boutique Awa' && invMsg.to === '237655123456', [r.json, invMsg]);
    r = await owner('POST', `${WO}/send`, { kind: 'impaye' });
    check('pas de second rappel avant 7 jours', r.json.sent === 0, r.json);
    r = await owner('GET', WO);
    check('journal des envois (statut envoyé)', r.json.log.length >= 4 && r.json.log.every((l) => l.status === 'sent') && r.json.sentToday >= 4, r.json.log);
    r = await owner('PUT', `${WO}/auto`, { enabled: true });
    r = await owner('GET', WO);
    check('relances automatiques activables', r.json.autoFollowup === true, r.json.autoFollowup);
    await owner('PUT', `${WO}/auto`, { enabled: false });

        console.log('Fiche prospect, attribution à un commercial, répartition automatique');
    r = await owner('GET', `${SL}/chats`);
    const webChat = r.json.chats.find((c) => c.channel === 'web' && c.campaign === 'facebook-octobre' || c.campaign === 'facebook-octscript');
    check('fiche prospect : la température monte à « chaud » après une commande', webChat && webChat.temperature === 'chaud', r.json.chats.map((c) => [c.campaign, c.temperature]));
    r = await owner('GET', `${SL}/chats/${webChat.id}`);
    check('fiche prospect lisible : besoin, quantité, pour quand, lieu (rien d\'inventé : budget absent)', r.json.lead.need === 'robes wax' && r.json.lead.quantity === '2 pièces' && r.json.lead.deadline === 'vendredi' && r.json.lead.place === 'Douala' && r.json.lead.budget === undefined && /Besoin : robes wax/.test(r.json.summary) && /chaud/.test(r.json.summary), r.json);
    check('l\'IA a reçu la consigne de qualifier (une question à la fois) et de remplir la fiche', fake.seen.last.system.includes('fiche prospect') && fake.seen.last.system.includes('UNE seule question'), fake.seen.last.system.slice(0, 120));
    r = await owner('GET', `/api/ws/orgs/${org}/support?status=open`);
    const tk = (r.json.tickets || r.json.items || []).find((t) => t.channel === 'assistant-web');
    r = tk ? await owner('GET', `/api/ws/orgs/${org}/support/${tk.id}`) : { json: {} };
    check('le ticket de passage de main contient la fiche prospect pour le commercial', JSON.stringify(r.json).includes('Fiche prospect'), JSON.stringify(r.json).slice(0, 200));

    const plainId = (await plain('GET', `/api/ws/orgs/${org}`)).json.me.userId;
    r = await plain('GET', `/api/ws/orgs/${org}`);
    check('un simple membre voit maintenant « Assistant commercial » (pour ses conversations attribuées)', r.json.modules.some((m) => m.id === 'sales'), r.json.modules.map((m) => m.id));
    r = await plain('GET', `${SL}`);
    check('mais pas la gestion complète (catalogue, commandes…) -> 403', r.status === 403, r.json);
    r = await owner('PUT', `/api/ws/orgs/${org}/members/${plainId}`, { title: 'Commercial' });
    r = await owner('GET', `${SL}/chats`);
    const hc2 = r.json.chats.find((c) => c.channel === 'whatsapp' && c.contact === '237611223344');
    const n0 = sent();
    await post(payload('237611223344', 'wamid.19', { type: 'text', text: { body: 'Bonjour, je reviens vers vous' } }));
    await waitFor(() => sent() > n0); // le client réécrit : la fenêtre de 24 h est rouverte
    await owner('PUT', `/api/ws/orgs/${org}/members/${staffId}`, { title: 'Responsable' }); // seul le commercial « Commercial » reste dans la répartition automatique
    r = await owner('PUT', `${SL}/chats/${hc2.id}/assign`, { userId: 99999 });
    check('attribution à une personne qui n\'est pas de l\'équipe -> 400', r.status === 400, r.json);
    const SLM = `/api/ws/orgs/${org}/sales-mine`;
    r = await plain('GET', `${SLM}/chats/${hc2.id}`);
    check('« mes conversations » : une conversation non attribuée est introuvable -> 404', r.status === 404, r.json);
    r = await owner('PUT', `${SL}/chats/${hc2.id}/assign`, { userId: plainId });
    check('le patron attribue la conversation à son commercial', r.status === 200, r.json);
    await sleep(400);
    const gotMail = mailbox.map((m) => m.replace(/=\r?\n/g, '')).find((m) => new RegExp('To: .*ada' + stamp).test(m) && /Assistant commercial/.test(m) && /Fiche prospect/.test(m));
    check('le commercial est prévenu par e-mail avec la fiche de la conversation', !!gotMail, mailbox.length);
    r = await plain('GET', `${SLM}/chats`);
    check('« mes conversations » : le commercial voit sa conversation (et seulement la sienne)', r.status === 200 && r.json.chats.length === 1 && r.json.chats[0].id === hc2.id, r.json);
    r = await plain('GET', `/api/ws/orgs/${org}/dashboard`);
    check('alerte du tableau de bord pour le commercial : une conversation lui est attribuée', r.json.alerts.some((a) => a.module === 'sales' && /attribu/.test(a.text)), r.json.alerts);
    const before = sent();
    r = await plain('POST', `${SLM}/chats/${hc2.id}/reply`, { text: 'Bonjour, je suis votre conseiller commercial.' });
    await waitFor(() => sent() > before);
    check('le commercial répond lui-même au client sur WhatsApp', r.status === 200 && /conseiller commercial/.test(fake.seen.wa[fake.seen.wa.length - 1].body) && fake.seen.wa[fake.seen.wa.length - 1].to === '237611223344', r.json);
    r = await plain('POST', `${SLM}/chats/${hc2.id}/release`, {});
    r = await plain('GET', `${SLM}/chats`);
    check('le commercial peut rendre la conversation à l\'équipe', r.json.chats.length === 0, r.json);
    r = await owner('PUT', `${SL}/settings`, { autoAssign: true });
    check('répartition automatique activée', r.status === 200, r.json);
    await post(payload('237622334455', 'wamid.20', { type: 'text', text: { body: 'HUMAIN je veux une remise' } }));
    await waitFor(() => sent() > before + 1);
    await sleep(300);
    r = await owner('GET', `${SL}/chats`);
    const hc3 = r.json.chats.find((c) => c.contact === '237622334455');
    check('répartition automatique : la conversation passée à un humain est attribuée au commercial', hc3 && hc3.assigneeId === plainId && hc3.assignee, hc3);
    r = await owner('PUT', `${SL}/chats/${hc3.id}/assign`, { userId: null });
    r = await owner('GET', `${SL}/chats`);
    check('le patron peut libérer une conversation attribuée', r.json.chats.find((c) => c.contact === '237622334455').assigneeId === null, r.json.chats.map((c) => c.assigneeId));
    await owner('PUT', `${SL}/settings`, { autoAssign: false });
    r = await owner('DELETE', `${SL}/whatsapp`);
    w = await post(payload('237655443322', 'wamid.9', { type: 'text', text: { body: 'Bonjour' } }));
    check('WhatsApp déconnecté : le webhook ne répond plus -> 404', r.status === 200 && w.status === 404, [r.status, w.status]);
    r = await owner('GET', `${SL}/whatsapp`);
    check('WhatsApp déconnecté : réglages effacés', r.json.connected === false && r.json.tokenSet === false && r.json.phoneId === '', r.json);



    console.log('Messenger et Instagram (messages privés, API Graph de Meta, simulée)');
    const MT = `/api/ws/public/meta/${token}`, MS = `${SL}/meta`;
    const PAGE = '112233445566', IGID = '778899001122', PAGE_TOKEN = 'EAAG-page-token-0123456789', MSECRET = 'secret-app-messenger-1';
    const msent = () => (fake.seen.ms || []).length;
    const mpost = (body, secret = MSECRET, sig) => { const raw = JSON.stringify(body); return fetch(base + MT, { method: 'POST', headers: { 'content-type': 'application/json', ...(sig === null ? {} : { 'x-hub-signature-256': sig || 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex') }) }, body: raw }); };
    const mmsg = (object, entryId, from, mid, message) => ({ object, entry: [{ id: entryId, time: 1, messaging: [{ sender: { id: from }, recipient: { id: entryId }, timestamp: 1, message: { mid, ...message } }] }] });
    r = await plain('GET', MS);
    check('Messenger : réglages réservés aux administrateurs -> 403', r.status === 403, r.json);
    r = await owner('PUT', MS, { pageId: 'abc' });
    check('Messenger : identifiant sans chiffres -> 400', r.status === 400, r.json);
    r = await owner('PUT', MS, { pageId: PAGE, instagramId: IGID, token: PAGE_TOKEN, appSecret: MSECRET });
    const mverify = r.json.verifyToken;
    check('Messenger : connecté ; jeton et secret jamais renvoyés', r.status === 200 && r.json.connected && r.json.tokenSet && r.json.secretSet && !JSON.stringify(r.json).includes('EAAG') && !JSON.stringify(r.json).includes(MSECRET) && /^[a-f0-9]{24}$/.test(mverify), r.json);
    const rawDb8 = await pgt.open();
    const mrow = await rawDb8.prepare('SELECT fb_token, fb_secret FROM orgs WHERE id = ?').get(org); await await rawDb8.close();
    check('Messenger : jeton et secret chiffrés dans la base', /^v1:/.test(mrow.fb_token) && !mrow.fb_token.includes('EAAG') && /^v1:/.test(mrow.fb_secret), mrow.fb_token.slice(0, 6));
    r = await owner('POST', `${MS}/test`, {});
    check('Messenger : test de connexion', r.status === 200, r.json);
    let mw = await fetch(`${base}${MT}?hub.mode=subscribe&hub.verify_token=${mverify}&hub.challenge=CH42`);
    check('webhook Meta : vérification avec le bon jeton -> renvoie le défi', mw.status === 200 && (await mw.text()) === 'CH42');
    mw = await fetch(`${base}${MT}?hub.mode=subscribe&hub.verify_token=faux&hub.challenge=CH42`);
    check('webhook Meta : mauvais jeton -> 403', mw.status === 403);
    mw = await mpost(mmsg('page', PAGE, '5551001', 'm.1', { text: 'x' }), MSECRET, null);
    check('Messenger : message sans signature -> 403', mw.status === 403);
    mw = await mpost(mmsg('page', PAGE, '5551001', 'm.1', { text: 'x' }), 'autre');
    check('Messenger : mauvaise signature -> 403, aucune réponse', mw.status === 403 && msent() === 0, msent());

    const mcalls = fake.seen.publicCalls;
    mw = await mpost(mmsg('page', PAGE, '5551001', 'm.2', { text: 'Bonjour #insta-oct, vous avez des robes ?' }));
    await waitFor(() => msent() >= 1);
    const mm1 = fake.seen.ms[0];
    check('Messenger : l\'IA répond à la bonne personne avec le jeton de la Page', mw.status === 200 && mm1.to === '5551001' && /Voici nos produits/.test(mm1.text) && mm1.page === PAGE && mm1.auth === 'Bearer ' + PAGE_TOKEN && fake.seen.publicCalls === mcalls + 1, mm1);
    check('Messenger : le contexte indique le canal et le numéro de téléphone à demander', fake.seen.last.system.includes('Canal : Messenger') && fake.seen.last.system.includes('numéro de téléphone'), fake.seen.last.system.slice(0, 80));
    mw = await mpost(mmsg('page', PAGE, '5551001', 'm.2', { text: 'Bonjour' }));
    await sleep(300);
    check('Messenger : un même message reçu deux fois n\'est traité qu\'une fois', msent() === 1 && fake.seen.publicCalls === mcalls + 1, [msent(), fake.seen.publicCalls]);
    mw = await mpost(mmsg('page', PAGE, '5551002', 'm.3', { text: 'écho', is_echo: true }));
    mw = await mpost(mmsg('page', '999', '5551003', 'm.4', { text: 'autre page' }));
    await sleep(300);
    check('Messenger : échos et messages d\'une autre Page ignorés', msent() === 1, msent());
    mw = await mpost(mmsg('page', PAGE, '5551004', 'm.5', { attachments: [{ type: 'image', payload: { url: 'https://x' } }] }));
    await waitFor(() => msent() >= 2);
    check('Messenger : pièce jointe illisible (adresse non reconnue) -> réponse polie, aucun appel IA', /ouvrir votre fichier/.test(fake.seen.ms[1].text) && fake.seen.publicCalls === mcalls + 1, fake.seen.ms[1]);
    mw = await mpost(mmsg('instagram', IGID, '6661001', 'm.6', { text: 'Salut, des chapeaux ?' }));
    await waitFor(() => msent() >= 3);
    check('Instagram : l\'IA répond (même assistant, canal Instagram)', /Voici nos produits/.test(fake.seen.ms[2].text) && fake.seen.ms[2].to === '6661001' && fake.seen.last.system.includes('Canal : Instagram'), fake.seen.ms[2]);
    mw = await mpost(mmsg('instagram', PAGE, '6661002', 'm.7', { text: 'mauvais compte' }));
    await sleep(300);
    check('Instagram : message d\'un autre compte ignoré', msent() === 3, msent());
    r = await owner('GET', `${SL}/chats`);
    const msChat = r.json.chats.find((c) => c.channel === 'messenger' && c.contact === '5551001');
    const igChat = r.json.chats.find((c) => c.channel === 'instagram' && c.contact === '6661001');
    check('conversations Messenger et Instagram listées avec leur canal et la campagne', msChat && igChat && msChat.campaign === 'insta-oct', r.json.chats.map((c) => [c.channel, c.contact]));

    // L'IA se tait après passage à un humain, et un responsable répond depuis MANAGER-IA
    mw = await mpost(mmsg('page', PAGE, '5551001', 'm.8', { text: 'HUMAIN je veux une remise' }));
    await waitFor(() => msent() >= 4);
    const mcalls2 = fake.seen.publicCalls;
    mw = await mpost(mmsg('page', PAGE, '5551001', 'm.9', { text: 'Vous êtes là ?' }));
    await sleep(400);
    check('Messenger : après passage à un conseiller, l\'IA se tait', msent() === 4 && fake.seen.publicCalls === mcalls2, [msent(), fake.seen.publicCalls, mcalls2]);
    r = await owner('POST', `${SL}/chats/${msChat.id}/reply`, { text: 'Bonjour, ici le responsable.' });
    await waitFor(() => msent() >= 5);
    check('un responsable répond sur Messenger depuis MANAGER-IA', r.status === 200 && fake.seen.ms[4].to === '5551001' && /responsable/.test(fake.seen.ms[4].text), [r.json, fake.seen.ms[4]]);
    r = await owner('POST', `${WO}/chats/${msChat.id}/template`, { templateId: 1, params: [] });
    check('les modèles WhatsApp ne s\'appliquent pas à Messenger -> 404', r.status === 404, r.json);

    r = await owner('DELETE', MS);
    mw = await mpost(mmsg('page', PAGE, '5551005', 'm.10', { text: 'Bonjour' }));
    check('Messenger déconnecté : le webhook ne répond plus -> 404, réglages effacés', mw.status === 404 && (await owner('GET', MS)).json.connected === false && (await owner('GET', MS)).json.tokenSet === false, mw.status);


    console.log('Réponses vocales, Messenger et Instagram au niveau de WhatsApp, délai de réponse');
    const vx_SS = `${SL}/settings`;
    await owner('PUT', `${SL}/whatsapp`, { phoneId: PID, number: '237677112233', token: TOKEN_WA, appSecret: APPSECRET }); // reconnecté (déconnecté plus haut dans le test)
    r = await owner('GET', SL);
    check('réglages : réponse vocale disponible (service de voix configuré), délai 0 par défaut', r.json.settings.ttsAvailable === true && r.json.settings.replyDelay === 0, r.json.settings);
    r = await owner('PUT', vx_SS, { voiceReply: 'mirror' });
    check('réponse vocale « en miroir » activée', r.status === 200, r.json);
    r = await owner('PUT', vx_SS, { voiceReply: 'toujours' });
    check('réponse vocale : choix inconnu -> 400', r.status === 400, r.json);

    // WhatsApp : message vocal -> texte PUIS message vocal
    const vx_v0 = sent(); const vx_t0 = (fake.seen.tts || []).length;
    w = await post(payload('237688100001', 'wamid.v1', { type: 'audio', audio: { id: 'MEDIAvx' } }));
    await waitFor(() => sent() >= vx_v0 + 2);
    const vx_vb = fake.seen.wa.slice(vx_v0);
    check('vocal reçu : réponse écrite puis réponse VOCALE (type audio) au bon numéro', vx_vb[0].type === 'text' && /J'ai compris/.test(vx_vb[0].body) && vx_vb[1].type === 'audio' && /^MID\d+$/.test(vx_vb[1].media.id) && vx_vb[1].to === '237688100001', vx_vb.map((x) => x.type));
    check('la voix lit la phrase de l\'IA (pas le récapitulatif), en Ogg/Opus pour WhatsApp, avec la voix configurée', (fake.seen.tts || []).length === vx_t0 + 1 && fake.seen.tts[vx_t0].format === 'opus' && fake.seen.tts[vx_t0].voice === 'alloy' && /Parfait, je confirme/.test(fake.seen.tts[vx_t0].input) && !/Total/.test(fake.seen.tts[vx_t0].input), fake.seen.tts[vx_t0]);
    check('le fichier vocal est envoyé à Meta comme audio/ogg', fake.seen.uploads[fake.seen.uploads.length - 1].audio === true, fake.seen.uploads[fake.seen.uploads.length - 1]);
    const vx_v1 = sent();
    w = await post(payload('237688100001', 'wamid.v2', { type: 'text', text: { body: 'Bonjour encore' } }));
    await waitFor(() => sent() >= vx_v1 + 1); await sleep(300);
    check('message écrit en mode « miroir » : réponse écrite seulement (pas de voix)', sent() === vx_v1 + 1 && fake.seen.wa[fake.seen.wa.length - 1].type === 'text', fake.seen.wa.slice(vx_v1).map((x) => x.type));
    await owner('PUT', vx_SS, { voiceReply: 'always' });
    const vx_v2 = sent();
    w = await post(payload('237688100001', 'wamid.v3', { type: 'text', text: { body: 'Et pour le prix ?' } }));
    await waitFor(() => sent() >= vx_v2 + 2);
    check('mode « toujours » : même un message écrit reçoit une réponse vocale', fake.seen.wa[fake.seen.wa.length - 1].type === 'audio', fake.seen.wa.slice(vx_v2).map((x) => x.type));
    await owner('PUT', vx_SS, { voiceReply: 'off' });
    const vx_v3 = sent();
    w = await post(payload('237688100001', 'wamid.v4', { type: 'audio', audio: { id: 'MEDIAvy' } }));
    await waitFor(() => sent() >= vx_v3 + 1); await sleep(300);
    check('réponse vocale désactivée : texte seulement', sent() === vx_v3 + 1 && fake.seen.wa[fake.seen.wa.length - 1].type === 'text', fake.seen.wa.slice(vx_v3).map((x) => x.type));

    // Messenger / Instagram : mêmes capacités (vocal reçu, photo reçue, voix envoyée, photos et vidéos envoyées)
    r = await owner('PUT', MS, { pageId: PAGE, instagramId: IGID, token: PAGE_TOKEN, appSecret: MSECRET });
    const vx_FA = `http://127.0.0.1:${fport}`;
    await owner('PUT', vx_SS, { voiceReply: 'mirror' });
    const vx_m0 = msent(); const vx_t1 = (fake.seen.tts || []).length; const vx_st0 = fake.seen.stt || 0;
    mw = await mpost(mmsg('page', PAGE, '5559001', 'mv.1', { attachments: [{ type: 'audio', payload: { url: `${vx_FA}/media/1` } }] }));
    await waitFor(() => msent() >= vx_m0 + 2);
    check('Messenger : message vocal reçu, téléchargé et transcrit, puis traité comme un écrit', (fake.seen.stt || 0) === vx_st0 + 1 && /J'ai compris/.test(fake.seen.ms[vx_m0].text), fake.seen.ms[vx_m0]);
    const vx_voiceMsg = fake.seen.ms[vx_m0 + 1];
    check('Messenger : réponse VOCALE envoyée comme pièce jointe audio (format AAC, lien signé de ce serveur)', vx_voiceMsg.attachment && vx_voiceMsg.attachment.type === 'audio' && vx_voiceMsg.attachment.payload.url.startsWith(`http://127.0.0.1:${port}/api/ws/public/file/`) && fake.seen.tts[vx_t1].format === 'aac', [vx_voiceMsg, fake.seen.tts[vx_t1]]);
    let vx_fr = await fetch(vx_voiceMsg.attachment.payload.url);
    check('le lien signé sert le fichier (audio, sans cache, nosniff)', vx_fr.status === 200 && /audio\/aac/.test(vx_fr.headers.get('content-type')) && vx_fr.headers.get('x-content-type-options') === 'nosniff' && /no-store/.test(vx_fr.headers.get('cache-control')), vx_fr.status);
    vx_fr = await fetch(vx_voiceMsg.attachment.payload.url.slice(0, -3) + 'abc');
    check('lien modifié (signature fausse) -> 404', vx_fr.status === 404, vx_fr.status);
    vx_fr = await fetch(`http://127.0.0.1:${port}/api/ws/public/file/n-importe-quoi`);
    check('lien inventé -> 404', vx_fr.status === 404, vx_fr.status);

    const vx_m1 = msent(); const vx_calls4 = fake.seen.publicCalls;
    mw = await mpost(mmsg('page', PAGE, '5559002', 'mi.1', { attachments: [{ type: 'image', payload: { url: `${vx_FA}/media/img` } }], text: undefined }));
    await waitFor(() => msent() >= vx_m1 + 1);
    check('Messenger : photo reçue -> lue par l\'IA (bloc image), réponse écrite', fake.seen.publicCalls === vx_calls4 + 1 && fake.seen.lastParts.some((p) => p.type === 'image'), [fake.seen.publicCalls, fake.seen.lastParts]);
    const vx_m2 = msent();
    mw = await mpost(mmsg('page', PAGE, '5559003', 'mp.1', { attachments: [{ type: 'file', payload: { url: `${vx_FA}/media/pdf` } }] }));
    await waitFor(() => msent() >= vx_m2 + 1);
    check('Messenger : PDF reçu -> lu par l\'IA (bloc document)', fake.seen.lastParts.some((p) => p.type === 'document'), fake.seen.lastParts);

    // photos et vidéos sur Messenger et Instagram
    const vx_jpg2 = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(300, 9)]);
    r = await owner.raw('POST', `${SL}/catalog/${robeId}/media?name=robe2`, vx_jpg2);
    const vx_m4 = msent();
    mw = await mpost(mmsg('page', PAGE, '5559005', 'ms.1', { text: 'SHOWPIC la robe' }));
    await waitFor(() => msent() >= vx_m4 + 4);
    const vx_mb = fake.seen.ms.slice(vx_m4);
    check('Messenger : texte, légende (nom et prix), puis photo et vidéo par liens signés', vx_mb[0].text && /Voici|envoie/.test(vx_mb[0].text) && /Robe wax Aïcha/.test(vx_mb[1].text) && vx_mb[2].attachment.type === 'image' && vx_mb[3].attachment.type === 'video', vx_mb.map((x) => x.text || (x.attachment && x.attachment.type)));
    vx_fr = await fetch(vx_mb[2].attachment.payload.url);
    check('le lien de la photo sert bien la photo', vx_fr.status === 200 && /image\/jpeg/.test(vx_fr.headers.get('content-type')), vx_fr.status);
    const vx_m5 = msent();
    mw = await mpost(mmsg('instagram', IGID, '6669001', 'ig.1', { text: 'SHOWPIC la robe' }));
    await waitFor(() => msent() >= vx_m5 + 4);
    check('Instagram : mêmes envois de photos et vidéos', fake.seen.ms.slice(vx_m5).some((x) => x.attachment && x.attachment.type === 'image') && fake.seen.ms.slice(vx_m5).some((x) => x.attachment && x.attachment.type === 'video'), fake.seen.ms.slice(vx_m5).map((x) => x.text || (x.attachment && x.attachment.type)));
    r = await owner('GET', `${SL}/chats`);
    const vx_igC = r.json.chats.find((c) => c.channel === 'instagram' && c.contact === '6669001');
    const vx_m6 = msent();
    r = await owner('POST', `${SL}/chats/${vx_igC.id}/send-media`, { itemId: robeId, kind: 'image' });
    await waitFor(() => msent() >= vx_m6 + 1);
    check('un responsable envoie une photo sur Instagram depuis MANAGER-IA', r.status === 200 && fake.seen.ms.slice(vx_m6).some((x) => x.attachment && x.attachment.type === 'image'), r.json);

    // Délai de réponse choisi par l'organisation
    r = await owner('PUT', vx_SS, { replyDelay: 200 });
    check('délai de plus de 3 minutes refusé -> 400', r.status === 400, r.json);
    r = await owner('PUT', vx_SS, { replyDelay: 'beaucoup' });
    check('délai invalide -> 400', r.status === 400, r.json);
    r = await owner('PUT', vx_SS, { replyDelay: 30, voiceReply: 'off' });
    r = await owner('GET', SL);
    check('délai de réponse enregistré (30 secondes)', r.json.settings.replyDelay === 30, r.json.settings);
    const vx_d0 = sent(); const vx_dc0 = fake.seen.publicCalls;
    w = await post(payload('237688100005', 'wamid.d1', { type: 'text', text: { body: 'Bonjour, première question' } }));
    await sleep(250);
    check('délai : rien n\'est envoyé tout de suite (aucune réponse, aucun appel IA)', sent() === vx_d0 && fake.seen.publicCalls === vx_dc0, [sent() - vx_d0, fake.seen.publicCalls - vx_dc0]);
    r = await owner('GET', `${SL}/chats`);
    const vx_dChat = r.json.chats.find((c) => c.contact === '237688100005');
    r = await owner('GET', `${SL}/chats/${vx_dChat.id}`);
    check('délai : le message est déjà visible par l\'équipe pendant l\'attente', r.json.messages.some((m) => /première question/.test(m.content)), r.json.messages.length);
    w = await post(payload('237688100005', 'wamid.d2', { type: 'text', text: { body: 'et une deuxième question' } }));
    await waitFor(() => sent() >= vx_d0 + 1, 3000);
    await sleep(500);
    check('délai : la réponse arrive après l\'attente, UNE seule pour les deux messages', sent() === vx_d0 + 1 && fake.seen.publicCalls === vx_dc0 + 1, [sent() - vx_d0, fake.seen.publicCalls - vx_dc0]);
    const vx_lastUsers = fake.seen.last.messages.filter((m) => m.role === 'user').map((m) => (typeof m.content === 'string' ? m.content : ''));
    check('délai : l\'IA a lu les deux messages ensemble', vx_lastUsers.some((c) => /première question/.test(c)) && vx_lastUsers.some((c) => /deuxième question/.test(c)), vx_lastUsers);
    // passage à un humain pendant l'attente : l'IA se tait
    const vx_d1 = sent();
    w = await post(payload('237688100006', 'wamid.d3', { type: 'text', text: { body: 'Bonjour' } }));
    await sleep(100);
    r = await owner('GET', `${SL}/chats`);
    const vx_hChat = r.json.chats.find((c) => c.contact === '237688100006');
    await owner('PUT', `${SL}/chats/${vx_hChat.id}/status`, { status: 'handoff' });
    await sleep(1200);
    check('délai : si un humain reprend la conversation pendant l\'attente, l\'IA ne répond pas', sent() === vx_d1, sent() - vx_d1);
    // Messenger aussi
    const vx_d2 = msent();
    mw = await mpost(mmsg('page', PAGE, '5559100', 'md.1', { text: 'Bonjour avec délai' }));
    await sleep(250);
    const vx_noReplyYet = msent() === vx_d2;
    await waitFor(() => msent() >= vx_d2 + 1, 3000);
    check('délai : appliqué aussi à Messenger (attente, puis réponse)', vx_noReplyYet && msent() === vx_d2 + 1, [vx_noReplyYet, msent() - vx_d2]);
    r = await owner('PUT', vx_SS, { replyDelay: 0 });
    const vx_d3 = sent();
    w = await post(payload('237688100007', 'wamid.d4', { type: 'text', text: { body: 'Bonjour sans délai' } }));
    await waitFor(() => sent() >= vx_d3 + 1, 1500);
    check('délai remis à 0 : réponse immédiate', sent() === vx_d3 + 1, sent() - vx_d3);


    console.log('Prospection : rendez-vous, passage à l\'équipe après commande ou rendez-vous, dossier de l\'IA interne');
    const AP = `${SL}/appointments`;
    r = await owner('PUT', `${SL}/settings`, { handoffOrder: true, handoffAppt: true, voiceReply: 'off', replyDelay: 0 });
    r = await owner('GET', SL);
    check('réglages : passage à l\'équipe après commande et après rendez-vous activés', r.json.settings.handoffOrder === true && r.json.settings.handoffAppt === true, r.json.settings);
    const ap0 = sent(); const b0 = fake.seen.briefs || 0;
    w = await post(payload('237699500001', 'wamid.rdv1', { type: 'text', text: { body: 'RDV je voudrais visiter la boutique' } }));
    await waitFor(() => sent() >= ap0 + 1);
    const apMsg = fake.seen.wa[fake.seen.wa.length - 1];
    check('rendez-vous pris par l\'IA : confirmation écrite avec le jour et l\'heure, puis « un conseiller prend le relais »', /rendez-vous est enregistrée/.test(apMsg.body) && /10h00/.test(apMsg.body) && /prendre le relais/.test(apMsg.body), apMsg.body);
    r = await owner('GET', AP);
    const rdv = r.json.appointments.find((x) => /Zoé/.test(x.customer || ''));
    check('le rendez-vous est dans l\'agenda de l\'équipe (à confirmer, client rattaché, canal WhatsApp)', rdv && rdv.status === 'pending' && rdv.time === '10:00' && rdv.date === RDV_DATE && rdv.channel === 'whatsapp' && rdv.purpose === 'visite de la boutique', r.json.appointments);
    r = await owner('GET', `${SL}/chats`);
    const rdvChat = r.json.chats.find((x) => x.contact === '237699500001');
    check('la conversation est passée à l\'équipe (« à reprendre »)', rdvChat.status === 'handoff', rdvChat);
    const calls5 = fake.seen.publicCalls; const ap1 = sent();
    w = await post(payload('237699500001', 'wamid.rdv2', { type: 'text', text: { body: 'Merci, à bientôt' } }));
    await sleep(500);
    check('après le passage à l\'équipe : l\'IA se tait (aucune réponse, aucun appel)', sent() === ap1 && fake.seen.publicCalls === calls5, [sent() - ap1, fake.seen.publicCalls - calls5]);
    await waitFor(() => (fake.seen.briefs || 0) >= b0 + 1);
    r = await owner('GET', `${SL}/chats/${rdvChat.id}`);
    check('l\'IA interne a préparé le dossier : résumé, fiche client, étapes, réponse proposée', (fake.seen.briefs || 0) === b0 + 1 && /Zoé Test veut visiter/.test(r.json.brief.summary) && r.json.brief.customer.email === 'zoe@exemple.com' && r.json.brief.nextSteps.length === 2 && /Bonjour Zoé/.test(r.json.brief.draftReply), r.json.brief);
    check('le dossier a lu la conversation et le rendez-vous (données, pas consignes)', /<donnees>/.test(fake.seen.briefInput) && /Rendez-vous demandé/.test(fake.seen.briefInput) && /CLIENT : RDV je voudrais/.test(fake.seen.briefInput), String(fake.seen.briefInput).slice(0, 200));
    check('le rendez-vous apparaît dans la conversation pour l\'équipe', r.json.appointments.length === 1 && r.json.appointments[0].status === 'pending', r.json.appointments);
    r = await owner('POST', `${SL}/chats/${rdvChat.id}/apply-brief`, {});
    check('« Appliquer » complète la fiche client (e-mail, adresse) sans rien écraser', r.status === 200 && r.json.done.includes('e-mail') && r.json.done.some((x) => /adresse/.test(x)), r.json);
    r = await owner('GET', `/api/ws/orgs/${org}/crm/customers`);
    const zoe = r.json.customers.find((x) => x.name === 'Zoé Test');
    check('fiche client mise à jour : e-mail ajouté, nom et téléphone gardés', zoe && zoe.email === 'zoe@exemple.com' && /677/.test(zoe.phone), zoe);
    r = await owner('POST', `${SL}/chats/${rdvChat.id}/apply-brief`, {});
    check('« Appliquer » une 2e fois : rien de nouveau, rien de dupliqué', r.status === 200 && r.json.done.length === 0, r.json);
    r = await plain('POST', `${SL}/chats/${rdvChat.id}/brief`, {});
    check('régénérer le dossier : réservé aux responsables -> 403', r.status === 403, r.json);
    r = await owner('POST', `${SL}/chats/${rdvChat.id}/brief`, {});
    check('régénérer le dossier (un message IA de plus)', r.status === 200 && r.json.brief.summary, r.json);

    // Créneau déjà pris, date passée : l'IA doit proposer autre chose, sans passage à l'équipe
    const ap2 = sent();
    w = await post(payload('237699500002', 'wamid.rdv3', { type: 'text', text: { body: 'RDVSLOT pareil à 10h30' } }));
    await waitFor(() => sent() >= ap2 + 1);
    check('créneau déjà pris (10h00 + 60 min) : refusé par le serveur, l\'IA propose un autre moment', /déjà pris/.test(fake.seen.wa[fake.seen.wa.length - 1].body) && !/prendre le relais/.test(fake.seen.wa[fake.seen.wa.length - 1].body), fake.seen.wa[fake.seen.wa.length - 1].body);
    const ap3 = sent();
    w = await post(payload('237699500003', 'wamid.rdv4', { type: 'text', text: { body: 'RDVBAD hier' } }));
    await waitFor(() => sent() >= ap3 + 1);
    check('date passée : refusée', /déjà passé/.test(fake.seen.wa[fake.seen.wa.length - 1].body), fake.seen.wa[fake.seen.wa.length - 1].body);
    r = await owner('GET', AP);
    check('aucun rendez-vous créé pour ces deux demandes', r.json.appointments.length === 1, r.json.appointments.length);
    r = await owner('GET', SL);
    check('le compteur « rendez-vous à confirmer » est à 1', r.json.stats.appointments === 1, r.json.stats);
    r = await owner('GET', `/api/ws/orgs/${org}/dashboard/alerts`);
    check('alerte : « 1 rendez-vous attend votre confirmation »', JSON.stringify(r.json).includes('rendez-vous attend'), JSON.stringify(r.json).slice(0, 200));

    // Équipe : confirmation avec message au client, agenda manuel
    const ap4 = sent();
    r = await owner('PUT', `${AP}/${rdv.id}`, { status: 'confirmed', notify: true });
    await waitFor(() => sent() >= ap4 + 1);
    check('confirmation : le client est prévenu sur WhatsApp (dans les 24 h)', r.status === 200 && r.json.notified === true && /est confirmé/.test(fake.seen.wa[fake.seen.wa.length - 1].body) && /10h00/.test(fake.seen.wa[fake.seen.wa.length - 1].body), [r.json, fake.seen.wa[fake.seen.wa.length - 1].body]);
    r = await owner('POST', AP, { date: RDV_DATE, time: '10:30', purpose: 'RDV équipe' });
    check('un rendez-vous ajouté à la main sur un créneau pris -> 400', r.status === 400 && /déjà pris/.test(r.json.error), r.json);
    r = await owner('POST', AP, { date: RDV_DATE, time: '14:00', purpose: 'RDV équipe' });
    check('un rendez-vous ajouté à la main sur un créneau libre -> 201', r.status === 201, r.json);
    r = await owner('POST', AP, { date: RDV_DATE, time: '23:00' });
    check('hors des heures (6h-21h) -> 400', r.status === 400, r.json);
    r = await plain('GET', AP);
    check('agenda : réservé aux responsables -> 403', r.status === 403, r.json);
    r = await owner('PUT', `${AP}/${rdv.id}`, { status: 'cancelled' });
    r = await owner('GET', `${AP}?status=cancelled`);
    check('rendez-vous annulé : visible dans l\'onglet des annulés', r.json.appointments.some((x) => x.id === rdv.id), r.json.appointments);

    // Commande -> passage à l'équipe + dossier
    const b1 = fake.seen.briefs || 0; const ap5 = sent();
    w = await post(payload('237699500004', 'wamid.ord1', { type: 'text', text: { body: 'ORDER deux robes' } }));
    await waitFor(() => sent() >= ap5 + 1);
    check('commande prise : récapitulatif exact, puis « un conseiller prend le relais »', /C-\d{4}-\d{4}/.test(fake.seen.wa[fake.seen.wa.length - 1].body) && /30\s?000/.test(fake.seen.wa[fake.seen.wa.length - 1].body) && /prendre le relais/.test(fake.seen.wa[fake.seen.wa.length - 1].body), fake.seen.wa[fake.seen.wa.length - 1].body);
    await waitFor(() => (fake.seen.briefs || 0) >= b1 + 1);
    r = await owner('GET', `${SL}/chats`);
    const ordChat = r.json.chats.find((x) => x.contact === '237699500004');
    check('commande : conversation à reprendre par l\'équipe, dossier préparé', ordChat.status === 'handoff' && (fake.seen.briefs || 0) === b1 + 1, [ordChat.status, fake.seen.briefs]);
    r = await owner('GET', `${SL}/orders`);
    check('la commande attend la validation de l\'équipe (à valider)', r.json.orders.some((o) => o.status === 'pending' && o.customer === 'Paul Test' && o.total === 30000), r.json.orders.map((o) => [o.customer, o.status, o.total]));
    // Désactivé : l'IA continue seule après la commande
    await owner('PUT', `${SL}/settings`, { handoffOrder: false });
    const ap6 = sent(); const b2 = fake.seen.briefs || 0;
    w = await post(payload('237699500005', 'wamid.ord2', { type: 'text', text: { body: 'ORDER deux robes' } }));
    await waitFor(() => sent() >= ap6 + 1);
    await sleep(300);
    const cont = await owner('GET', `${SL}/chats`);
    check('passage à l\'équipe désactivé : l\'IA reste en charge après la commande (pas de dossier)', cont.json.chats.find((x) => x.contact === '237699500005').status === 'open' && (fake.seen.briefs || 0) === b2, [(fake.seen.briefs || 0) - b2]);


    console.log('Agenda synchronisable (Google Agenda, Outlook, Apple) et rappels automatiques la veille');
    r = await plain('GET', `${SL}/calendar`);
    check('agenda : réservé aux administrateurs -> 403', r.status === 403, r.json);
    r = await owner('GET', `${SL}/calendar`);
    check('agenda : pas de lien tant qu\'il n\'est pas créé', r.json.configured === false, r.json);
    r = await owner('POST', `${SL}/calendar/regenerate`, {});
    const calPath = r.json.path;
    check('lien d\'agenda secret créé', /^\/api\/ws\/public\/calendar\/[a-f0-9]{36}\.ics$/.test(calPath), r.json);
    await owner('POST', AP, { date: RDV_DATE, time: '16:30', purpose: 'Visite; étage 2, côté mer' });
    let ics = await fetch(base + calPath);
    let icsT = await ics.text();
    check('le lien sert un agenda iCalendar (sans connexion)', ics.status === 200 && /text\/calendar/.test(ics.headers.get('content-type')) && /^BEGIN:VCALENDAR\r\n/.test(icsT) && /END:VCALENDAR\r\n$/.test(icsT) && /X-WR-CALNAME:Rendez-vous - Boutique Awa/.test(icsT), icsT.slice(0, 160));
    const hhmm = (t, d) => { const [h, m] = t.split(':').map(Number); return `${RDV_DATE.replace(/-/g, '')}T${String(h - 1).padStart(2, '0')}${String(m).padStart(2, '0')}00Z`; };
    check('heures converties en UTC (16h30 au Cameroun = 15h30 UTC), durée 60 min', icsT.includes('DTSTART:' + hhmm('16:30')) && icsT.includes('DTEND:' + hhmm('17:30')), icsT.match(/DTSTART:[^\r]*/g));
    check('les caractères spéciaux sont protégés (point-virgule et virgule)', icsT.includes('Visite\; étage 2\\, côté mer'), icsT.match(/SUMMARY:[^\r]*/g));
    check('rendez-vous confirmé, à confirmer et annulé : statuts CONFIRMED, TENTATIVE, CANCELLED', /STATUS:CONFIRMED/.test(icsT) && /STATUS:TENTATIVE|STATUS:CONFIRMED/.test(icsT) && /STATUS:CANCELLED/.test(icsT), icsT.match(/STATUS:[^\r]*/g));
    check('lignes de 75 octets au plus (norme)', icsT.split('\r\n').every((l) => Buffer.byteLength(l) <= 75), icsT.split('\r\n').filter((l) => Buffer.byteLength(l) > 75).slice(0, 2));
    ics = await fetch(base + calPath.replace(/[a-f0-9]{4}\.ics$/, 'abcd.ics'));
    check('lien deviné -> 404', ics.status === 404, ics.status);
    const old = calPath;
    r = await owner('POST', `${SL}/calendar/regenerate`, {});
    ics = await fetch(base + old);
    const ics2 = await fetch(base + r.json.path);
    check('régénérer le lien : l\'ancien cesse de marcher, le nouveau marche', ics.status === 404 && ics2.status === 200, [ics.status, ics2.status]);
    r = await owner('GET', AP);
    const apptId = r.json.appointments[0].id;
    let one = await fetch(`${base}${AP}/${apptId}/ics`, { headers: { cookie: '' } });
    check('fichier .ics d\'un rendez-vous : connexion obligatoire -> 401', one.status === 401, one.status);

    // Rappels la veille
    const tomorrowAppt = async (num, id, k) => {
      const before = sent();
      w = await post(payload(num, id, { type: 'text', text: { body: `RDVTOM${k} je veux un rendez-vous` } }));
      await waitFor(() => sent() >= before + 1);
      const l = await owner('GET', AP);
      return l.json.appointments.find((x) => x.date === RDV_TOMORROW && x.time === ['', '09:00', '11:00', '13:00', '15:00'][k]);
    };
    const rem1 = await tomorrowAppt('237699600001', 'wamid.t1', 1);
    check('rendez-vous de demain pris par l\'IA, à confirmer', rem1 && rem1.status === 'pending', rem1);
    let rm0 = sent();
    await sleep(600);
    check('à confirmer : AUCUN rappel (seuls les rendez-vous confirmés sont rappelés)', sent() === rm0, sent() - rm0);
    await owner('PUT', `${AP}/${rem1.id}`, { status: 'confirmed' });
    await waitFor(() => /Rappel : vous avez rendez-vous demain/.test((fake.seen.wa[fake.seen.wa.length - 1] || {}).body || ''), 3000);
    const remMsg = fake.seen.wa[fake.seen.wa.length - 1];
    check('confirmé : rappel envoyé au client sur WhatsApp (texte libre, il a écrit il y a moins de 24 h)', remMsg.to === '237699600001' && /09h00/.test(remMsg.body) && /Boutique Awa/.test(remMsg.body), remMsg);
    rm0 = sent();
    await sleep(700);
    check('un seul rappel par rendez-vous (aucun doublon)', sent() === rm0, sent() - rm0);
    r = await owner('GET', `${SL}/chats`);
    const remChat = r.json.chats.find((x) => x.contact === '237699600001');
    r = await owner('GET', `${SL}/chats/${remChat.id}`);
    check('le rappel est noté dans la conversation', r.json.messages.some((m) => /^\[rappel\]/.test(m.content)), r.json.messages.map((m) => m.content.slice(0, 20)));

    // Plus de 24 h : modèle WhatsApp approuvé nécessaire
    const rem2 = await tomorrowAppt('237699600002', 'wamid.t2', 2);
    const rawDb10 = await pgt.open();
    await rawDb10.prepare("UPDATE chat_messages SET created_at = ? WHERE chat_id = (SELECT id FROM chats WHERE contact = '237699600002')").run(new Date(Date.now() - 3 * 86400000).toISOString());
    await rawDb10.close();
    await owner('PUT', `${AP}/${rem2.id}`, { status: 'confirmed' });
    rm0 = sent();
    await sleep(700);
    check('plus de 24 h et aucun modèle approuvé : pas de rappel (règle de Meta)', sent() === rm0, sent() - rm0);
    r = await owner('POST', `${WO}/templates`, { name: 'rappel_rdv', purpose: 'rdv', preview: 'Bonjour {{1}}, rappel : rendez-vous {{2}} à {{3}} chez {{4}}.' });
    check('modèle « Rappel de rendez-vous » enregistré (4 variables)', r.status === 201, r.json);
    await waitFor(() => (fake.seen.wa[fake.seen.wa.length - 1] || {}).type === 'template' && /rappel_rdv/.test(JSON.stringify(fake.seen.wa[fake.seen.wa.length - 1].tpl)), 3000);
    const tmsg = fake.seen.wa[fake.seen.wa.length - 1];
    check('modèle envoyé avec prénom, jour, heure et entreprise', tmsg.type === 'template' && tmsg.to === '237699600002' && tmsg.tpl.components[0].parameters.map((x) => x.text).join('|').includes('Max') && tmsg.tpl.components[0].parameters.some((x) => x.text === '11h00') && tmsg.tpl.components[0].parameters.some((x) => x.text === 'Boutique Awa'), tmsg.tpl);

    // Rappels désactivés
    await owner('PUT', `${SL}/settings`, { apptReminder: false });
    const rem3 = await tomorrowAppt('237699600003', 'wamid.t3', 3);
    await owner('PUT', `${AP}/${rem3.id}`, { status: 'confirmed' });
    rm0 = sent();
    await sleep(700);
    check('rappels désactivés dans les réglages : aucun envoi', sent() === rm0, sent() - rm0);
    r = await owner('GET', SL);
    check('réglage lisible (rappels désactivés)', r.json.settings.apptReminder === false, r.json.settings);
    await owner('PUT', `${SL}/settings`, { apptReminder: true });
    await waitFor(() => (fake.seen.wa[fake.seen.wa.length - 1] || {}).to === '237699600003', 3000);
    check('réactivés : le rappel en attente part', (fake.seen.wa[fake.seen.wa.length - 1] || {}).to === '237699600003', fake.seen.wa[fake.seen.wa.length - 1]);

    console.log('Comptabilité (plan OHADA de base, écritures équilibrées et non modifiables)');
    const ac_AC = `/api/ws/orgs/${org}/accounting`;
    r = await plain('GET', ac_AC);
    check('comptabilité : réservée aux administrateurs -> 403', r.status === 403, r.json);
    r = await owner('GET', ac_AC);
    check('comptabilité : plan comptable de base installé, aucune écriture, TVA 19,25 %', r.status === 200 && r.json.count === 0 && r.json.settings.vatRate === 19.25 && r.json.settings.payAccount === '571', r.json);
    r = await owner('GET', `${ac_AC}/accounts`);
    check('plan comptable : comptes clés présents (411, 401, 4431, 571, 601, 701)', ['411', '401', '4431', '571', '601', '701'].every((k) => r.json.accounts.some((a) => a.code === k)) && r.json.accounts.length > 100, r.json.accounts.length);
    const ac_ent = (lines, extra = {}) => owner('POST', `${ac_AC}/entries`, { journal: 'CA', date: '2026-10-05', label: 'Test', lines, ...extra });
    r = await ac_ent([{ account: '622', debit: 1000 }, { account: '571', credit: 900 }]);
    check('écriture non équilibrée refusée -> 400', r.status === 400 && /équilibrée/.test(r.json.error), r.json);
    r = await ac_ent([{ account: '622', debit: 1000 }]);
    check('écriture à une seule ligne refusée -> 400', r.status === 400, r.json);
    r = await ac_ent([{ account: '999', debit: 1000 }, { account: '571', credit: 1000 }]);
    check('compte inconnu refusé -> 400', r.status === 400 && /inconnu/.test(r.json.error), r.json);
    r = await ac_ent([{ account: '622', debit: 1000, credit: 1000 }, { account: '571', credit: 0 }]);
    check('ligne avec débit ET crédit refusée -> 400', r.status === 400, r.json);
    r = await ac_ent([{ account: '622', debit: -5 }, { account: '571', credit: -5 }]);
    check('montants négatifs refusés -> 400', r.status === 400, r.json);
    r = await ac_ent([{ account: '622', debit: 150000 }, { account: '571', credit: 150000 }], { label: '=HYPERLINK("http://x")' });
    check('écriture valide enregistrée et numérotée par journal et année', r.status === 201 && /^CA-2026-00001$/.test(r.json.number), r.json);
    const ac_e1 = r.json.id;
    r = await owner('POST', `${ac_AC}/entries/${ac_e1}/reverse`, { date: '2026-10-06' });
    check('annulation : une écriture inverse est créée (journal OD)', r.status === 201 && /^OD-2026-/.test(r.json.number), r.json);
    r = await owner('POST', `${ac_AC}/entries/${ac_e1}/reverse`, {});
    check('annulation en double -> 409', r.status === 409, r.json);
    r = await owner('PUT', `${ac_AC}/entries/${ac_e1}`, { label: 'modif' });
    check('aucune modification d\'écriture possible (route absente)', r.status === 404, r.status);
    r = await owner('DELETE', `${ac_AC}/entries/${ac_e1}`);
    check('aucune suppression d\'écriture possible (route absente)', r.status === 404, r.status);

    // Écritures automatiques : facture (TTC 119 250 = 100 000 HT + 19 250 de TVA), paiement partiel, achat reçu
    const rawDb7 = await pgt.open();
    const ac_cAcc = (await rawDb7.prepare("INSERT INTO customers (org_id, name, phone, email, notes, created_at) VALUES (?, 'Client Compta', '', '', '', ?)").run(org, new Date().toISOString())).lastInsertRowid;
    const ac_dAcc = (await rawDb7.prepare("INSERT INTO documents (org_id, customer_id, kind, number, status, lines, total, paid, issued, due, created_by, created_at, updated_at) VALUES (?, ?, 'invoice', 'F-COMPTA-1', 'sent', '[]', 119250, 0, '2026-10-10', '2026-11-10', 1, ?, ?)").run(org, ac_cAcc, new Date().toISOString(), new Date().toISOString())).lastInsertRowid;
    await rawDb7.close();
    r = await owner('GET', ac_AC);
    check('factures à comptabiliser signalées', r.json.toPost.invoices >= 1, r.json.toPost);
    r = await owner('POST', `${ac_AC}/generate`, {});
    check('génération : la facture devient une écriture de vente', r.status === 200 && r.json.invoices >= 1, r.json);
    r = await owner('GET', `${ac_AC}/entries?q=F-COMPTA-1`);
    const ac_ve = r.json.entries[0];
    const acL = (code) => ac_ve.lines.filter((l) => l.account === code);
    check('écriture de vente : 411 débit 119 250, 701 crédit 100 000, 4431 crédit 19 250 (TVA 19,25 %)', ac_ve.journal === 'VT' && acL('411')[0].debit === 119250 && acL('701')[0].credit === 100000 && acL('4431')[0].credit === 19250, ac_ve);
    r = await owner('POST', `${ac_AC}/generate`, {});
    check('génération idempotente : aucune écriture en double', r.json.invoices === 0 && r.json.payments === 0, r.json);
    r = await owner('POST', `/api/ws/orgs/${org}/crm/documents/${ac_dAcc}/payments`, { amount: 50000 });
    check('paiement partiel de 50 000 enregistré sur la facture', r.status === 200 && r.json.paid === 50000, r.json);
    r = await owner('POST', `${ac_AC}/generate`, {});
    check('génération : le paiement devient une écriture de caisse (571 / 411)', r.json.payments === 1, r.json);
    r = await owner('GET', `${ac_AC}/ledger?account=411&year=2026`);
    const ac_my = r.json.lines.filter((l) => /F-COMPTA-1/.test(l.label));
    check('grand livre du compte 411 : facture au débit, encaissement au crédit', ac_my.length === 2 && ac_my[0].debit === 119250 && ac_my[1].credit === 50000, ac_my);
    r = await owner('GET', `${ac_AC}/balance?year=2026`);
    check('balance : total débit = total crédit', r.json.totalDebit === r.json.totalCredit && r.json.totalDebit > 0, [r.json.totalDebit, r.json.totalCredit]);
    r = await owner('GET', `${ac_AC}/statements?year=2026`);
    check('bilan : actif = passif + résultat (équilibré)', r.json.bilan.equilibre === true && r.json.bilan.totalActif === r.json.bilan.totalPassif, [r.json.bilan.totalActif, r.json.bilan.totalPassif]);
    check('compte de résultat : les ventes comptent les 100 000 HT, résultat = produits - charges', r.json.resultat.ventes >= 100000 && r.json.resultat.resultat === r.json.resultat.totalProduits - r.json.resultat.totalCharges, r.json.resultat);
    r = await owner('GET', `${ac_AC}/vat?year=2026`);
    check('TVA : 19 250 collectés au moins, TVA due = collectée - récupérable', r.json.collected >= 19250 && r.json.due === Math.max(r.json.collected - r.json.deductible, 0), r.json);
    r = await owner('GET', `${ac_AC}/export.csv?year=2026`);
    check('export Excel : en-tête, point-virgule, formule neutralisée (injection CSV)', r.status === 200 && /journal;numero;date/.test(r.text) && /'=HYPERLINK/.test(r.text) && !/;"=HYPERLINK/.test(r.text), r.text.slice(0, 200));

    // Réglages et clôture
    r = await owner('PUT', `${ac_AC}/settings`, { vatRate: 99 });
    check('TVA hors limites -> 400', r.status === 400, r.json);
    r = await owner('PUT', `${ac_AC}/settings`, { lockedUntil: '2026-10-31' });
    check('clôture de période jusqu\'au 31/10', r.status === 200, r.json);
    r = await ac_ent([{ account: '622', debit: 10 }, { account: '571', credit: 10 }], { date: '2026-10-20' });
    check('écriture dans une période clôturée refusée -> 400', r.status === 400 && /verrouill/.test(r.json.error), r.json);
    r = await owner('PUT', `${ac_AC}/settings`, { lockedUntil: '2026-09-30' });
    check('une période clôturée ne peut pas être rouverte -> 400', r.status === 400, r.json);
    r = await ac_ent([{ account: '622', debit: 10 }, { account: '571', credit: 10 }], { date: '2026-11-02' });
    check('écriture après la clôture acceptée', r.status === 201, r.json);

    // Compte personnalisé
    r = await owner('POST', `${ac_AC}/accounts`, { code: '6221', label: 'Loyer entrepôt' });
    check('compte personnalisé ajouté', r.status === 201, r.json);
    r = await owner('POST', `${ac_AC}/accounts`, { code: '6221', label: 'Doublon' });
    check('compte en double -> 409', r.status === 409, r.json);
    r = await owner('POST', `${ac_AC}/accounts`, { code: '9999', label: 'Mauvaise classe' });
    check('compte de classe 9 refusé -> 400', r.status === 400, r.json);

    // Proposition d'écriture par l'IA (vérifiée côté serveur, jamais enregistrée seule)
    const ac_usedBefore = (await owner('GET', `/api/ws/orgs/${org}`)).json.limits.aiUsed;
    r = await owner('POST', `${ac_AC}/suggest`, { text: 'payé le loyer 150 000 en espèces' });
    check('IA : proposition d\'écriture équilibrée (622 / 571) à relire', r.status === 200 && r.json.proposal.journal === 'CA' && r.json.proposal.lines.length === 2 && r.json.proposal.lines[0].debit === 150000, r.json);
    check('IA : rien n\'est enregistré avant validation, un message IA est compté', (await owner('GET', `${ac_AC}?x=1`)).json.entries.every((e) => e.label !== 'Loyer octobre') && (await owner('GET', `/api/ws/orgs/${org}`)).json.limits.aiUsed === ac_usedBefore + 1);
    r = await owner('POST', `${ac_AC}/suggest`, { text: 'FLOU' });
    check('IA : opération trop floue -> 422 avec ce qu\'il faut préciser', r.status === 422 && /montant/.test(r.json.error), r.json);
    r = await owner('POST', `${ac_AC}/suggest`, { text: 'DESEQ' });
    check('IA : proposition déséquilibrée rejetée par le serveur -> 422', r.status === 422, r.json);


    console.log('Intégrations : clés d\'API et webhooks sortants (Zapier, Make, n8n)');
    const IG = `/api/ws/orgs/${org}/integrations`;
    const received = []; const recvPort = await freePort();
    const recvSrv = http.createServer((rq, rs) => { let b = ''; rq.on('data', (d) => { b += d; }); rq.on('end', () => { received.push({ headers: rq.headers, body: b, url: rq.url }); rs.statusCode = rq.url === '/fail' ? 500 : 200; rs.end('ok'); }); });
    await new Promise((res) => recvSrv.listen(recvPort, '127.0.0.1', res));
    r = await plain('GET', IG);
    check('intégrations : réservées aux administrateurs -> 403', r.status === 403, r.json);
    r = await owner('POST', `${IG}/keys`, { name: '' });
    check('clé sans nom -> 400', r.status === 400, r.json);
    r = await owner('POST', `${IG}/keys`, { name: 'Zapier lecture', scope: 'read' });
    const keyRead = r.json.key;
    check('clé de lecture créée (affichée une seule fois, format mia_…)', r.status === 201 && /^mia_[a-f0-9]{40}$/.test(keyRead), r.json);
    r = await owner('POST', `${IG}/keys`, { name: 'Make écriture', scope: 'write' });
    const keyWrite = r.json.key;
    r = await owner('GET', IG);
    const rawDb9 = await pgt.open();
    const krow = await rawDb9.prepare('SELECT key_hash, prefix FROM api_keys ORDER BY id DESC LIMIT 1').get(); await await rawDb9.close();
    check('la clé n\'est jamais renvoyée ni stockée en clair (empreinte seulement)', !JSON.stringify(r.json).includes(keyRead) && !JSON.stringify(r.json).includes(keyWrite) && krow.key_hash.length === 64 && krow.key_hash !== keyWrite && krow.prefix === keyWrite.slice(0, 8) && r.json.keys.length === 2, r.json.keys);
    const api = (key, method, path, body) => fetch(base + '/api/v1' + path, { method, headers: { ...(key ? { authorization: 'Bearer ' + key } : {}), 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then(async (x) => ({ status: x.status, json: await x.json().catch(() => null) }));
    r = await api(null, 'GET', '/customers');
    check('API : sans clé -> 401', r.status === 401, r.json);
    r = await api('mia_' + '0'.repeat(40), 'GET', '/customers');
    check('API : fausse clé -> 401', r.status === 401, r.json);
    r = await api(keyRead, 'GET', '/me');
    check('API : /me avec une clé valide', r.status === 200 && r.json.organisation === 'Boutique Awa' && r.json.scope === 'read', r.json);
    r = await api(keyRead, 'GET', '/customers?limit=2');
    check('API : liste des clients paginée (jamais d\'autre organisation)', r.status === 200 && r.json.data.length === 2 && r.json.next > 0 && r.json.data.every((x) => x.name && !('org_id' in x)), r.json);
    r = await api(keyRead, 'POST', '/customers', { name: 'Nouveau Client', phone: '699 00 11 22' });
    check('API : écriture avec une clé en lecture seule -> 403', r.status === 403, r.json);
    r = await api(keyRead, 'GET', '/invoices?status=sent');
    check('API : factures (solde calculé)', r.status === 200 && r.json.data.every((x) => x.balance === Math.max(x.total - x.paid, 0)), r.json);

    // Webhook : adresse du récepteur local (autorisée seulement en test), signature vérifiable
    r = await owner('POST', `${IG}/webhooks`, { url: `http://127.0.0.1:${recvPort}/hook`, events: [] });
    check('webhook sans événement -> 400', r.status === 400, r.json);
    r = await owner('POST', `${IG}/webhooks`, { url: 'ftp://exemple.com/x', events: ['order.created'] });
    check('webhook : adresse non web -> 400', r.status === 400, r.json);
    r = await owner('POST', `${IG}/webhooks`, { url: `http://127.0.0.1:${recvPort}/hook`, events: ['prospect.created', 'order.created', 'payment.received', 'chat.handoff', 'evenement.inconnu'] });
    const hookId = r.json.id, hookSecret = r.json.secret;
    check('webhook créé (secret affiché une seule fois), événements inconnus ignorés', r.status === 201 && /^[a-f0-9]{48}$/.test(hookSecret), r.json);
    r = await owner('GET', IG);
    check('le secret du webhook n\'est jamais relisible', !JSON.stringify(r.json).includes(hookSecret) && r.json.webhooks[0].events.length === 4, r.json.webhooks);
    r = await owner('POST', `${IG}/webhooks/${hookId}/test`, {});
    await waitFor(() => received.length >= 1);
    const rt = received[0] || { headers: {}, body: '{}' };
    const expectSig = 'sha256=' + crypto.createHmac('sha256', hookSecret).update(rt.body).digest('hex');
    check('test du webhook : reçu, signé HMAC-SHA256 valide, événement « test »', r.status === 200 && r.json.ok === true && rt.headers['x-mia-signature'] === expectSig && JSON.parse(rt.body).event === 'test', [r.json, rt.headers['x-mia-signature']]);

    const n0r = received.length;
    r = await api(keyWrite, 'POST', '/customers', { name: 'Fatou API', phone: '699 77 88 99', email: 'fatou@exemple.com' });
    check('API : création d\'un prospect (clé en écriture)', r.status === 201 && r.json.created === true, r.json);
    await waitFor(() => received.length >= n0r + 1);
    const ev1 = JSON.parse(received[received.length - 1].body);
    check('webhook « prospect.created » envoyé avec les données', ev1.event === 'prospect.created' && ev1.data.name === 'Fatou API' && ev1.data.source === 'api' && ev1.id && ev1.created_at, ev1);
    r = await api(keyWrite, 'POST', '/customers', { name: 'Fatou Encore', phone: '0699778899' });
    check('API : même téléphone -> pas de doublon (created: false)', r.status === 200 && r.json.created === false, r.json);
    r = await api(keyWrite, 'POST', '/customers', { name: 'X' });
    check('API : données invalides -> 400', r.status === 400, r.json);

    const n1r = received.length;
    r = await anon('POST', `${PUB}/message`, { message: 'ORDER pour Zapier', campaign: 'zap' });
    await waitFor(() => received.some((x, i) => i >= n1r && JSON.parse(x.body).event === 'order.created'));
    const evo = received.slice(n1r).map((x) => JSON.parse(x.body)).find((e) => e.event === 'order.created');
    check('webhook « order.created » : numéro, total calculé, lignes', evo && /^C-\d{4}-\d{4}$/.test(evo.data.number) && evo.data.total === 30000 && evo.data.lines.length >= 1, evo);
    const n2r = received.length;
    r = await owner('POST', `/api/ws/orgs/${org}/crm/documents/${ac_dAcc}/payments`, { amount: 10000 });
    await waitFor(() => received.some((x, i) => i >= n2r && JSON.parse(x.body).event === 'payment.received'));
    const evp = received.slice(n2r).map((x) => JSON.parse(x.body)).find((e) => e.event === 'payment.received');
    check('webhook « payment.received » : facture, montant, solde', evp && evp.data.number === 'F-COMPTA-1' && evp.data.amount === 10000 && evp.data.paid === 60000, evp);

    // Échecs : un webhook qui répond 500 est compté, puis désactivé après 10 échecs de suite
    r = await owner('POST', `${IG}/webhooks`, { url: `http://127.0.0.1:${recvPort}/fail`, events: ['chat.handoff'] });
    const badId = r.json.id;
    for (let i = 0; i < 10; i++) await owner('POST', `${IG}/webhooks/${badId}/test`, {});
    r = await owner('GET', IG);
    const bw = r.json.webhooks.find((x) => x.id === badId);
    check('webhook en erreur : échecs comptés puis désactivé automatiquement (10 de suite)', bw.fails >= 10 && bw.active === false && /échec/.test(bw.lastStatus), bw);
    r = await owner('PUT', `${IG}/webhooks/${badId}`, { active: true });
    r = await owner('GET', IG);
    check('webhook réactivé : compteur remis à zéro', r.json.webhooks.find((x) => x.id === badId).active === true && r.json.webhooks.find((x) => x.id === badId).fails === 0);

    // Suppression : la clé ne marche plus aussitôt
    const kid = (await owner('GET', IG)).json.keys.find((k) => k.name === 'Make écriture').id;
    r = await owner('DELETE', `${IG}/keys/${kid}`);
    r = await api(keyWrite, 'GET', '/me');
    check('clé supprimée : refusée immédiatement -> 401', r.status === 401, r.json);
    r = await owner('DELETE', `${IG}/webhooks/${hookId}`);
    const n3r = received.length;
    await owner('POST', `/api/ws/orgs/${org}/crm/documents/${ac_dAcc}/payments`, { amount: 1000 });
    await sleep(500);
    check('webhook supprimé : plus aucun envoi', received.slice(n3r).every((x) => !/payment\.received/.test(x.body)), received.slice(n3r).length);
    recvSrv.close();

    console.log('Quota mensuel commun');
    r = await owner('GET', `/api/ws/orgs/${org}`);
    check('quota : 100 messages par mois pour toute l\'organisation (Gratuit de test), déjà en partie utilisés', r.json.limits.aiMonth === 100 && r.json.limits.aiUsed >= 10 && r.json.limits.aiUsed < 100, r.json.limits);
    const raw = await pgt.open();
    const used = r.json.limits.aiUsed;
    const ins = raw.prepare("INSERT INTO ai_usage (org_id, user_id, created_at) VALUES (?, 1, ?)");
    for (let i = used; i < 99; i++) await ins.run(org, new Date().toISOString());
    r = await owner('POST', `/api/ws/orgs/${org}/ai/chat`, { module: 'general', message: 'dernier message' });
    check('quota : le 100e message passe, il en reste 0', r.status === 200 && r.json.remaining === 0, r.json);
    r = await owner('POST', `/api/ws/orgs/${org}/ai/chat`, { module: 'general', message: 'encore' });
    check('quota mensuel épuisé -> 429', r.status === 429 && /Limite de messages IA/.test(r.json.error) && /novembre|décembre|janvier|février|mars|avril|mai|juin|juillet|août|septembre|octobre/.test(r.json.error), r.json);
    r = await staff('POST', `/api/ws/orgs/${org}/ai/chat`, { module: 'support', message: 'et moi ?' });
    check('quota commun : un autre membre est aussi bloqué -> 429', r.status === 429, r.json);
    await owner('DELETE', `/api/ws/orgs/${org}/ai/history?module=general`);
    r = await owner('POST', `/api/ws/orgs/${org}/ai/chat`, { module: 'general', message: 'encore' });
    check('effacer l\'historique ne remet pas le quota à zéro -> 429', r.status === 429, r.json);
    await raw.prepare("UPDATE ai_usage SET created_at = ? WHERE org_id = ?").run('2020-01-15T10:00:00.000Z', org);
    r = await owner('GET', `/api/ws/orgs/${org}`);
    check('quota : un nouveau mois remet le compteur à zéro', r.json.limits.aiUsed === 0, r.json.limits);
    console.log('Période du quota alignée sur l\'abonnement, et pas de changement d\'offre en cours d\'abonnement');
    const ownerId = (await owner('GET', `/api/ws/orgs/${org}`)).json.me.userId;
    const DAY = 86400000;
    const at = (n) => new Date(Date.now() + n * DAY).toISOString();
    await raw.prepare('DELETE FROM ai_usage WHERE org_id = ?').run(org);
    await raw.prepare("UPDATE users SET plan = 'Pro', plan_expires = ? WHERE id = ?").run(at(10), ownerId);
    await raw.prepare('INSERT INTO ai_usage (org_id, user_id, created_at) VALUES (?, 1, ?)').run(org, at(-25)); // avant la période : ne compte pas
    await raw.prepare('INSERT INTO ai_usage (org_id, user_id, created_at) VALUES (?, 1, ?)').run(org, at(-5));  // dans la période : compte
    r = await owner('GET', `/api/ws/orgs/${org}`);
    check('offre Pro, échéance dans 10 jours : période = 30 jours avant l\'échéance, 1 message compté sur 1 000', r.json.limits.aiMonth === 1000 && r.json.limits.aiUsed === 1 && Math.abs(Date.parse(r.json.limits.aiResetAt) - Date.parse(at(10))) < 60000, r.json.limits);
    await raw.prepare("UPDATE users SET plan_expires = ? WHERE id = ?").run(at(50), ownerId);
    r = await owner('GET', `/api/ws/orgs/${org}`);
    check('renouvellement anticipé (échéance dans 50 jours) : la période en cours se termine dans 20 jours', Math.abs(Date.parse(r.json.limits.aiResetAt) - Date.parse(at(20))) < 60000 && r.json.limits.aiUsed === 1, r.json.limits);
    await raw.prepare("UPDATE users SET plan_expires = ? WHERE id = ?").run(at(10), ownerId);
    r = await owner('POST', '/api/payments/initiate', { plan: 'promax', operator: 'mtn', phone: '677000111' });
    check('changer d\'offre en cours d\'abonnement -> 409 avec la date', r.status === 409 && /changement d'offre/.test(r.json.error) && /Pro/.test(r.json.error), r.json);
    r = await owner('POST', '/api/payments/initiate', { plan: 'pro', operator: 'mtn', phone: '677000111' });
    check('renouveler la MÊME offre reste possible', r.status < 300, r.json);
    await raw.prepare("UPDATE users SET plan = 'Gratuit', plan_expires = NULL WHERE id = ?").run(ownerId);
    r = await owner('POST', '/api/payments/initiate', { plan: 'promax', operator: 'mtn', phone: '677000111' });
    check('une fois l\'abonnement terminé (offre Gratuite), on peut choisir une autre offre', r.status < 300, r.json);

    await raw.close();

    console.log('Mot de passe oublié');
    const ru = client(base);
    const emailC = `reset${stamp}@exemple.com`;
    check('compte de test créé', (await ru('POST', '/api/register', { name: 'Rose Reset', contact: emailC, pass: 'ancien123' })).status === 201);
    r = await ru('GET', '/api/me');
    check('session ouverte avant la réinitialisation', r.status === 200, r.json);
    const a1 = await anon('POST', '/api/password/forgot', { contact: emailC });
    const a2 = await anon('POST', '/api/password/forgot', { contact: 'inconnu@exemple.com' });
    check('« mot de passe oublié » : même réponse que le compte existe ou non (pas de fuite d\'information)', a1.status === 200 && a2.status === 200 && a1.json.message === a2.json.message, [a1.json, a2.json]);
    await sleep(500);
    const resetMail = mailbox.find((m) => new RegExp('To: .*' + emailC.replace('.', '\\.')).test(m) && /reinitialiser\?t=3D|reinitialiser\?t=/.test(m));
    const tokenM = resetMail && /reinitialiser\?t=3?D?([a-f0-9]{64})/.exec(resetMail.replace(/=\r?\n/g, ''));
    check('e-mail de réinitialisation reçu avec un lien à usage unique', !!tokenM, resetMail && resetMail.slice(0, 300));
    const tk1 = tokenM && tokenM[1];
    r = await anon('POST', '/api/password/reset', { token: 'a'.repeat(64), pass: 'nouveau123' });
    check('lien inconnu -> 400', r.status === 400, r.json);
    r = await anon('POST', '/api/password/reset', { token: tk1, pass: '123' });
    check('mot de passe trop court -> 400 (le lien reste valable)', r.status === 400, r.json);
    r = await anon('POST', '/api/password/reset', { token: tk1, pass: 'nouveau123' });
    check('nouveau mot de passe enregistré', r.status === 200, r.json);
    r = await anon('POST', '/api/password/reset', { token: tk1, pass: 'autre12345' });
    check('le lien ne sert qu\'une fois -> 400', r.status === 400, r.json);
    check('ancien mot de passe refusé', (await anon('POST', '/api/login', { contact: emailC, pass: 'ancien123' })).status === 401);
    check('nouveau mot de passe accepté', (await anon('POST', '/api/login', { contact: emailC, pass: 'nouveau123' })).status === 200);
    r = await ru('GET', '/api/me');
    check('les anciennes sessions sont déconnectées après le changement -> 401', r.status === 401, r.json);
    // Compte avec téléphone : pas d'e-mail, l'administrateur est prévenu et génère le lien lui-même
    const rp = client(base);
    const phoneC = '+237 699 ' + String(stamp).slice(-6).replace(/(\d{2})(\d{2})(\d{2})/, '$1 $2 $3');
    await rp('POST', '/api/register', { name: 'Paul Phone', contact: phoneC, pass: 'ancien123' });
    await anon('POST', '/api/password/forgot', { contact: phoneC });
    await sleep(300);
    r = await adm('GET', '/api/admin/notifications');
    check('compte avec téléphone : l\'administrateur est prévenu d\'une demande de réinitialisation', r.json.notifications.some((n) => /réinitialisation/.test(n.text) && /Paul Phone/.test(n.text)), r.json.notifications.slice(0, 3));
    r = await adm('GET', '/api/admin/users?q=Paul%20Phone');
    const puid = r.json.users[0].id;
    r = await adm('POST', `/api/admin/users/${puid}/reset-link`, {});
    const tk2 = /t=([a-f0-9]{64})/.exec((r.json && r.json.link) || '');
    check('l\'administrateur génère un lien (1 h) pour envoi manuel', r.status === 200 && !!tk2 && /^https?:\/\//.test(r.json.link), r.json);
    r = await anon('POST', '/api/password/reset', { token: tk2 && tk2[1], pass: 'nouveau123' });
    check('le lien de l\'administrateur fonctionne', r.status === 200, r.json);
    check('connexion avec le nouveau mot de passe (téléphone)', (await anon('POST', '/api/login', { contact: phoneC, pass: 'nouveau123' })).status === 200);
    r = await owner('POST', `/api/admin/users/${puid}/reset-link`, {});
    check('un simple utilisateur ne peut pas générer de lien -> 401', r.status === 401, r.json);

    console.log('Suppression');
    r = await owner('DELETE', `/api/ws/orgs/${org}`, { confirm: 'mauvais nom' });
    check('suppression sans le bon nom -> 400', r.status === 400, r.json);
    r = await owner('DELETE', `/api/ws/orgs/${org}`, { confirm: 'Boutique Awa' });
    check('suppression avec confirmation', r.status === 200, r.json);
    r = await owner('GET', '/api/ws/orgs');
    check('plus aucune organisation', r.json.orgs.length === 0, r.json);
  } finally {
    if (process.env.SMOKE_LOG) console.log('--- journal du serveur ---\n' + out.split('\n').filter((l) => !/ -> 2\d\d /.test(l)).slice(-25).join('\n'));
    child.kill();
    fake.srv.close();
    smtp.close();
    await pgt.stop();
  }
  console.log(`\n${passed} réussis, ${failed} échoués`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
