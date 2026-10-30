'use strict';
// Protection contre le SSRF des webhooks sortants : adresses privées refusées, y compris à la connexion (rebinding DNS). Lancez : npm run test:webhooks
process.env.NODE_ENV = 'production'; process.env.JWT_SECRET = 'x'.repeat(40); process.env.ADMIN_PASSWORD = ''; process.env.WEBHOOK_ALLOW_PRIVATE = '1'; // ce réglage doit être ignoré en production
process.env.DATABASE_URL = 'pglite://memory';
const wh = require('../src/services/webhooks');
let fails = 0;
const ok = (c, m) => { console.log(`${c ? '  ✓' : '  ✗'} ${m}`); if (!c) fails++; };
for (const ip of ['127.0.0.1', '10.0.0.5', '172.16.3.4', '172.31.255.1', '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:10.1.1.1', '224.0.0.1']) ok(!wh.isPublicIp(ip), `adresse privée refusée : ${ip}`);
for (const ip of ['8.8.8.8', '104.16.0.1', '172.32.0.1', '2606:4700:4700::1111']) ok(wh.isPublicIp(ip), `adresse publique acceptée : ${ip}`);
const bad = ['http://exemple.com/x', 'https://127.0.0.1/x', 'https://localhost/x', 'https://app.localhost/x', 'https://[::1]/x', 'https://169.254.169.254/latest/meta-data', 'https://user:pw@exemple.com/x', 'https://10.0.0.1/', 'ftp://exemple.com', 'pas une adresse', 'https://service.internal/x'];
for (const u of bad) ok(wh.urlProblem(u) !== '', `adresse refusée (production) : ${u}`);
ok(wh.urlProblem('https://hooks.zapier.com/hooks/catch/123/abc/') === '', 'adresse Zapier acceptée');
ok(wh.sign('s', 'corps') === wh.sign('s', 'corps') && wh.sign('s', 'corps') !== wh.sign('t', 'corps') && /^sha256=[a-f0-9]{64}$/.test(wh.sign('s', 'corps')), 'signature HMAC stable et dépendante du secret');
// Pièces jointes Messenger / Instagram : seules les adresses de Meta sont téléchargées (protection contre les adresses piégées)
const metaChat = require('../src/services/metaChat');
(async () => {
  for (const u of ['https://exemple-pirate.test/x.jpg', 'http://scontent.xx.fbcdn.net/x.jpg', 'https://127.0.0.1/x', 'https://fbcdn.net.pirate.test/x.jpg', 'file:///etc/passwd', 'pas une adresse']) {
    let err = ''; try { await metaChat.downloadUrl(u); } catch (e) { err = e.message; }
    ok(/refusée|invalide/.test(err), `pièce jointe refusée : ${u}`);
  }
})();
// Connexion réelle : un nom de domaine qui pointe vers 127.0.0.1 (localtest.me) doit être bloqué au moment de la connexion
(async () => {
  const r = await Promise.race([await wh.deliver({ id: 0, url: 'https://localtest.me/x', secret: 's' }, 'test', {}), new Promise((res) => setTimeout(() => res({ ok: false, status: 'attente' }), 6000))]);
  ok(r.ok === false, `domaine résolu vers le réseau interne : connexion refusée (${r.status})`);
  console.log(fails ? `\n${fails} échec(s)` : '\nTout est bon');
  process.exit(fails ? 1 : 0);
})();
