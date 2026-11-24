'use strict';
// Chat interne (2e partie) : repli sans clé IA, serveurs TURN configurables, appels de groupe pleins, limites. Lancez-le avec : node scripts/test-chat-b.js
const crypto = require('crypto');
const { run } = require('./lib/wave2');

run('Chat interne : sans clé IA, TURN, appel complet', async ({ check, owner, mgr, mem, O }) => {
  const C = `${O}/chat`;
  let r;
  const users = (await owner('GET', `${O}/members`)).json.members;
  const uid = (n) => users.find((u) => u.name === n).userId;
  const paul = uid('Paul'); const marc = uid('Marc'); const awa = uid('Awa');
  r = await mem('GET', `${C}/ai/status`);
  check('sans clé IA : état clair (indisponible, avec la raison en français)', r.json.available === false && r.json.code === 'no_key' && /clé IA/.test(r.json.message), r.json);
  r = await mem('POST', `${C}/conversations/direct`, { userId: marc });
  const D = r.json.conversation.id;
  await mem('POST', `${C}/conversations/${D}/messages`, { body: 'Bonjour Marc' }); await mgr('POST', `${C}/conversations/${D}/messages`, { body: 'Bonjour Paul' });
  r = await mem('PUT', `${C}/ai/conversations/${D}`, { enabled: true });
  r = await mem('POST', `${C}/ai/conversations/${D}/summarize`, {});
  check('résumé sans clé IA : message clair, pas d’erreur brute', r.status === 200 && r.json.ok === false && r.json.code === 'no_key' && !/undefined|Error|HTTP/.test(r.json.message), r.json);
  await mem('POST', `${C}/conversations/${D}/messages`, { body: 'La facture est payée' });
  r = await mem('POST', `${C}/messages/${(await mem('GET', `${C}/conversations/${D}/messages`)).json.messages.find((m) => m.body === 'La facture est payée').id}/translate`, { lang: 'en' });
  check('traduction sans clé IA : message clair', r.status === 200 && r.json.ok === false && r.json.code === 'no_key', r.json);
  r = await mem('GET', `${C}/search?q=facture&smart=1`);
  check('recherche « intelligente » sans clé IA : repli sur le texte, avec la raison', r.json.smart.used === false && r.json.smart.reason && r.json.messages.length === 1, r.json.smart);
  r = await mem('GET', `${C}/calls/ice`);
  const turn = r.json.iceServers.find((s) => s.username);
  check('TURN configuré par variables : identifiants temporaires (jamais de secret envoyé au navigateur)', r.json.turn === true && turn && /^\d+:\d+$/.test(turn.username) && turn.credential === crypto.createHmac('sha1', 'secret-turn-test').update(turn.username).digest('base64') && !JSON.stringify(r.json).includes('secret-turn-test'), r.json);
  check('STUN personnalisé pris en compte', r.json.iceServers[0].urls[0] === 'stun:stun.test:3478' && r.json.maxParticipants === 3, r.json.iceServers[0]);
  // appel de groupe plein (3 personnes au plus)
  r = await owner('POST', `${C}/groups`, { name: 'Équipe', memberIds: [marc, paul] });
  r = await owner('POST', `${C}/calls`, { convId: r.json.conversation.id, kind: 'audio' });
  const id = r.json.call.id;
  await mgr('POST', `${C}/calls/${id}/join`, {}); await mem('POST', `${C}/calls/${id}/join`, {});
  r = await owner('GET', `${C}/calls/active`);
  check('trois personnes dans l’appel de groupe', r.json.calls[0].participants.filter((p) => p.inCall).length === 3, r.json.calls[0]);
  void awa;
}, { async setup() { return { env: { CHAT_TURN_URLS: 'turn:turn.test:3478', CHAT_TURN_SECRET: 'secret-turn-test', CHAT_STUN_URLS: 'stun:stun.test:3478', CHAT_CALL_MAX: '3', RATE_LIMIT_GLOBAL: '100000' } }; } });
