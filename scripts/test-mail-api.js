'use strict';
// Test de l'envoi d'e-mails par l'API web (Brevo) avec un FAUX serveur local : aucun appel externe.
// Lancez-le avec : npm run test:mail
const http = require('http');
const { freePort } = require('./lib/testdb');

let passed = 0; let failed = 0;
const check = (name, cond, extra) => { if (cond) { passed++; console.log('  OK   ' + name); } else { failed++; console.log('  ECHEC ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); } };

(async () => {
  const port = await freePort();
  const seen = [];
  let mode = 'ok';
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (d) => { b += d; });
    req.on('end', () => {
      seen.push({ url: req.url, key: req.headers['api-key'], body: JSON.parse(b || '{}') });
      if (mode === 'refus') { res.statusCode = 401; return res.end('{"message":"Key not found"}'); }
      res.statusCode = 201; return res.end('{"messageId":"x"}');
    });
  });
  await new Promise((ok) => srv.listen(port, '127.0.0.1', ok));
  Object.assign(process.env, { BREVO_API_KEY: 'cle-de-test', MAIL_API_URL: `http://127.0.0.1:${port}/v3`, SMTP_FROM: 'MANAGER-IA <contact@exemple.com>', SMTP_HOST: '', DATABASE_URL: 'pglite://memory', JWT_SECRET: 'secret-de-test-secret-de-test-secret-de-test-1234', NODE_ENV: 'test' });
  const notify = require('../src/services/notify');

  console.log('E-mail par API web');
  check('envoi activé avec la clé seule (sans SMTP)', notify.mailEnabled() === true);
  check('envoi réussi', await notify.sendMail({ to: 'client@exemple.com', subject: 'Votre code', text: 'Code : 123456' }) === true);
  const r = seen[0];
  check('adresse du service', r && r.url === '/v3/smtp/email', r && r.url);
  check('clé envoyée dans l\'en-tête api-key', r && r.key === 'cle-de-test');
  check('expéditeur repris de SMTP_FROM', r && r.body.sender.email === 'contact@exemple.com' && r.body.sender.name === 'MANAGER-IA', r && r.body.sender);
  check('destinataire, sujet et texte', r && r.body.to[0].email === 'client@exemple.com' && r.body.subject === 'Votre code' && r.body.textContent === 'Code : 123456');
  await notify.sendMail({ to: 'x@exemple.com', subject: 'PJ', text: 't', replyTo: 'a@exemple.com', fromName: 'Boutique Awa', attachments: [{ filename: 'facture.pdf', content: Buffer.from('%PDF-1.4') }] });
  const r2 = seen[1];
  check('pièce jointe en base64', r2 && r2.body.attachment && r2.body.attachment[0].name === 'facture.pdf' && Buffer.from(r2.body.attachment[0].content, 'base64').toString() === '%PDF-1.4');
  check('nom d\'expéditeur personnalisé et adresse de réponse', r2 && r2.body.sender.name === 'Boutique Awa' && r2.body.replyTo.email === 'a@exemple.com');
  mode = 'refus';
  let err = null;
  try { await notify.sendMail({ to: 'x@exemple.com', subject: 's', text: 't' }); } catch (e) { err = e; }
  check('refus du service -> erreur claire', err && /refus \(401\)/.test(err.message), err && err.message);
  srv.close();
  console.log(`\n${passed} réussis, ${failed} échoués`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
