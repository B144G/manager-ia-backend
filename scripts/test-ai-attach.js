'use strict';
// Pièces jointes de l'assistant IA : images, PDF, fichiers texte ; limites et refus. Aucun appel externe.
// Lancez-le avec : node scripts/test-ai-attach.js
const { startTestPg } = require('./lib/testdb');
let passed = 0; let failed = 0;
const check = (name, cond, extra) => { if (cond) { passed++; console.log('  OK   ' + name); } else { failed++; console.log('  ECHEC ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); } };
(async () => {
  const pgt = await startTestPg();
  Object.assign(process.env, { NODE_ENV: 'test', JWT_SECRET: 'secret-de-test-assez-long-123456', DATABASE_URL: pgt.url, ANTHROPIC_API_KEY: 'cle-de-test', SIGNUP_VERIFY: 'off', TRUST_PROXY: '0' });
  const { db } = require('../src/db'); await db.ready;
  const { attachmentParts: P } = require('../src/workspace/ai');
  const b64 = (s) => Buffer.from(s).toString('base64');
  check('aucune pièce jointe : rien', P(undefined).parts.length === 0 && P([]).parts.length === 0);
  const r = P([{ name: 'photo.png', mime: 'image/png', data: b64('x') }, { name: 'doc.pdf', mime: 'application/pdf', data: b64('%PDF-1.4') }, { name: 'notes.csv', mime: 'text/csv', data: b64('a;b\n1;2') }]);
  check('image, PDF et texte reconnus', r.parts[0].type === 'image' && r.parts[1].type === 'document' && r.parts[2].type === 'text' && /a;b/.test(r.parts[2].text) && /notes\.csv/.test(r.parts[2].text), r.parts);
  check('les noms sont gardés pour l\'historique', r.names.join() === 'photo.png,doc.pdf,notes.csv');
  const bad = (list) => { try { P(list); return null; } catch (e) { return e; } };
  check('vidéo ou exécutable refusés', (bad([{ name: 'v.mp4', mime: 'video/mp4', data: b64('x') }]) || {}).status === 400 && (bad([{ name: 'a.exe', mime: 'application/x-msdownload', data: b64('x') }]) || {}).status === 400);
  check('contenu qui n\'est pas du base64 refusé', (bad([{ name: 'a.png', mime: 'image/png', data: 'pas du base64 !' }]) || {}).status === 400);
  check('plus de 4 pièces refusé', (bad(Array.from({ length: 5 }, () => ({ name: 'a.png', mime: 'image/png', data: b64('x') }))) || {}).status === 400);
  check('plus de 8 Mo refusé (413)', (bad([{ name: 'gros.png', mime: 'image/png', data: Buffer.alloc(9 * 1024 * 1024, 1).toString('base64') }]) || {}).status === 413);
  check('une liste qui n\'est pas une liste est refusée', (bad('x') || {}).status === 400);
  const big = P([{ name: 'long.txt', mime: 'text/plain', data: b64('é'.repeat(30000)) }]);
  check('un texte long est coupé à 12 000 caractères', big.parts[0].text.length < 12100);
  console.log(`\n${passed} réussis, ${failed} échecs`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
