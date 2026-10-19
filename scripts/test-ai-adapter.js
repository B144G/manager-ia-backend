'use strict';
// Vérifie l'adaptateur d'IA avec de faux serveurs (aucune clé réelle, aucun coût) : npm run test:ai
const http = require('http');
let fails = 0;
const ok = (c, m) => { console.log(`${c ? '  ✓' : '  ✗'} ${m}`); if (!c) fails++; };

function fake(handler) {
  return new Promise((res) => {
    const seen = [];
    const srv = http.createServer((req, rsp) => {
      let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => {
        const body = JSON.parse(b || '{}'); seen.push({ url: req.url, headers: req.headers, body });
        const out = handler(req.url, body); rsp.statusCode = out.error ? 401 : 200; rsp.setHeader('content-type', 'application/json'); rsp.end(JSON.stringify(out));
      });
    }).listen(0, '127.0.0.1', () => res({ srv, seen, port: srv.address().port }));
  });
}
const load = (env) => {
  Object.keys(require.cache).forEach((k) => { if (/[\\/]src[\\/]/.test(k)) delete require.cache[k]; });
  for (const k of ['AI_PROVIDER', 'AI_API_KEY', 'AI_MODEL', 'AI_MODEL_FAST', 'AI_BASE_URL', 'AI_PROMPT_CACHE', 'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL', 'ANTHROPIC_BASE_URL']) delete process.env[k];
  Object.assign(process.env, { DATABASE_URL: 'pglite://memory', ...env });
  return require('../src/services/claude');
};

(async () => {
  console.log('Anthropic (par défaut)');
  const a = await fake(() => ({ content: [{ type: 'text', text: 'Bonjour A' }], usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 900 } }));
  let c = load({ ANTHROPIC_API_KEY: 'k1', ANTHROPIC_BASE_URL: `http://127.0.0.1:${a.port}` });
  ok(c.isConfigured(), 'clé ANTHROPIC_API_KEY prise en compte (ancienne variable)');
  ok((await c.ask({ stable: 'REGLES', system: 'DONNEES', messages: [{ role: 'user', content: 'x' }] })) === 'Bonjour A', 'texte renvoyé');
  let r = a.seen[0];
  ok(r.url === '/v1/messages' && r.headers['x-api-key'] === 'k1', 'route et en-tête Anthropic');
  ok(Array.isArray(r.body.system) && r.body.system[0].text === 'REGLES' && r.body.system[0].cache_control?.type === 'ephemeral', 'partie stable en premier avec cache_control');
  ok(r.body.system[1].text === 'DONNEES' && !r.body.system[1].cache_control, 'données variables après, sans cache');
  ok((await c.stats()).cacheRead === 900, 'lecture du cache comptée');
  await c.ask({ system: 'seul', messages: [{ role: 'user', content: 'x' }], tier: 'fast' });
  ok(a.seen[1].body.model === 'claude-sonnet-5-5', 'tier fast sans AI_MODEL_FAST = modèle principal');
  c = load({ ANTHROPIC_API_KEY: 'k1', ANTHROPIC_BASE_URL: `http://127.0.0.1:${a.port}`, AI_MODEL_FAST: 'claude-haiku-5-5', AI_PROMPT_CACHE: '0' });
  await c.ask({ stable: 'S', messages: [{ role: 'user', content: 'x' }], tier: 'fast' });
  const r3 = a.seen[2];
  ok(r3.body.model === 'claude-haiku-5-5', 'tier fast utilise AI_MODEL_FAST');
  ok(!r3.body.system[0].cache_control, 'AI_PROMPT_CACHE=0 désactive le cache');
  a.srv.close();

  console.log('Compatible OpenAI');
  const o = await fake(() => ({ choices: [{ message: { content: 'Bonjour O' } }], usage: { prompt_tokens: 20, completion_tokens: 4 } }));
  c = load({ AI_PROVIDER: 'openai', AI_API_KEY: 'k2', AI_BASE_URL: `http://127.0.0.1:${o.port}/v1`, AI_MODEL: 'mistral-small' });
  ok((await c.ask({ stable: 'REGLES', system: 'DONNEES', messages: [{ role: 'user', content: 'x' }] })) === 'Bonjour O', 'texte renvoyé');
  r = o.seen[0];
  ok(r.url === '/v1/chat/completions' && r.headers.authorization === 'Bearer k2', 'route et en-tête OpenAI');
  ok(r.body.model === 'mistral-small' && r.body.messages[0].role === 'system' && r.body.messages[0].content === 'REGLES\n\nDONNEES', 'message système assemblé');
  ok((await c.stats()).provider === 'openai' && (await c.stats()).input === 20, 'compteurs OpenAI');
  const img = [{ type: 'text', text: 'Cette robe ?' }, { type: 'image', mime: 'image/png', data: 'AAAA' }, { type: 'document', mime: 'application/pdf', data: 'BBBB' }];
  await c.ask({ messages: [{ role: 'user', content: img }] });
  const parts = o.seen[o.seen.length - 1].body.messages[0].content;
  ok(parts[1].type === 'image_url' && parts[1].image_url.url === 'data:image/png;base64,AAAA' && parts[2].type === 'text' && /PDF/.test(parts[2].text), 'pièces jointes au format OpenAI (le PDF devient une note)');
  o.srv.close();

  console.log('Pièces jointes (Anthropic)');
  const im = await fake(() => ({ content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } }));
  c = load({ ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE_URL: `http://127.0.0.1:${im.port}` });
  await c.ask({ messages: [{ role: 'user', content: img }] });
  const ap = im.seen[0].body.messages[0].content;
  ok(ap[1].type === 'image' && ap[1].source.type === 'base64' && ap[1].source.media_type === 'image/png' && ap[1].source.data === 'AAAA' && ap[2].type === 'document' && ap[2].source.media_type === 'application/pdf', 'image et PDF au format Anthropic');
  im.srv.close();

  console.log('Sans clé / erreur');
  c = load({});
  ok(!c.isConfigured(), 'non configuré sans clé');
  let code = 0; try { await c.ask({ messages: [] }); } catch (e) { code = e.status; }
  ok(code === 503, 'HttpError 503 sans clé');
  const bad = await fake(() => ({ error: { message: 'cle invalide' } }));
  c = load({ ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE_URL: `http://127.0.0.1:${bad.port}` });
  let msg = ''; try { await c.ask({ messages: [{ role: 'user', content: 'x' }] }); } catch (e) { msg = e.message; }
  ok(/cle invalide/.test(msg), 'message d\'erreur du fournisseur remonté');
  bad.srv.close();
  console.log(fails ? `\n${fails} échec(s)` : '\nTout est bon');
  process.exit(fails ? 1 : 0);
})();
