'use strict';
// Banc d'essai des deux IA : pose les questions de scripts/eval-scenarios.json avec VOTRE vraie clé Anthropic
// (ANTHROPIC_API_KEY dans .env), vérifie quelques règles simples et écrit un rapport lisible dans eval-results/.
// Lancez-le avec :  npm run eval:ai        (option : --only=site ou --only=workspace)
// Rien n'est modifié : le test utilise une base temporaire avec une organisation d'exemple.
const fs = require('fs');
const path = require('path');

process.env.DATABASE_URL = 'pglite://memory';
const config = require('../src/config');
const { db, nowISO } = require('../src/db');
const claude = require('../src/services/claude');
const knowledge = require('../src/ai/knowledge');
const wsAi = require('../src/workspace/ai');

const only = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7);
const scen = JSON.parse(fs.readFileSync(path.join(__dirname, 'eval-scenarios.json'), 'utf8'));

if (!claude.isConfigured()) {
  console.error("\nLa clé de l'IA (ANTHROPIC_API_KEY, ou AI_API_KEY) est absente. Ajoutez-la dans le fichier .env (jamais dans le code ni dans une conversation), puis relancez.\n");
  process.exit(1);
}

// ---- Organisation d'exemple (mêmes données que dans nos démonstrations) ----
let req;
async function seed() {
  const now = nowISO();
  const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  const uid = Number((await db.prepare("INSERT INTO users (name, contact, pass_hash, plan, created_at) VALUES ('Awa Kamga', 'awa@exemple.com', 'x', 'Pro', ?)").run(now)).lastInsertRowid);
  const oid = Number((await db.prepare("INSERT INTO orgs (name, sector, description, currency, owner_id, intake_token, created_at) VALUES ('Boutique Awa', 'Commerce', 'Vente de pagnes et couture à Douala', 'FCFA', ?, 'tok', ?)").run(uid, now)).lastInsertRowid);
  await db.prepare("INSERT INTO org_members (org_id, user_id, role, title, created_at) VALUES (?, ?, 'owner', 'Dirigeante', ?)").run(oid, uid, now);
  const m = day(0).slice(0, 7);
  for (const [k, c, a] of [['income', 'Ventes', 480000], ['expense', 'Loyer', 120000], ['expense', 'Transport', 45000]]) await db.prepare('INSERT INTO budget_entries (org_id, kind, category, label, amount, date, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(oid, k, c, '', a, `${m}-05`, uid, now);
  await db.prepare("INSERT INTO budget_plans (org_id, category, monthly_limit) VALUES (?, 'Loyer', 100000)").run(oid);
  await db.prepare("INSERT INTO tickets (org_id, customer_name, channel, subject, priority, created_at, updated_at) VALUES (?, 'Marie N.', 'whatsapp', 'Commande en retard', 'high', ?, ?)").run(oid, now, now);
  const pid = Number((await db.prepare("INSERT INTO projects (org_id, name, due, created_by, created_at) VALUES (?, 'Boutique en ligne', ?, ?, ?)").run(oid, day(30), uid, now)).lastInsertRowid);
  await db.prepare("INSERT INTO tasks (org_id, project_id, title, status, due, created_by, created_at) VALUES (?, ?, 'Photographier les produits', 'todo', ?, ?, ?)").run(oid, pid, day(-3), uid, now);
  await db.prepare("INSERT INTO decisions (org_id, title, amount, requested_by, created_at) VALUES (?, 'Commande fournisseur : pagne wax', 450000, ?, ?)").run(oid, uid, now);
  return { user: await db.prepare('SELECT * FROM users WHERE id = ?').get(uid), org: await db.prepare('SELECT * FROM orgs WHERE id = ?').get(oid), member: await db.prepare('SELECT * FROM org_members WHERE org_id = ? AND user_id = ?').get(oid, uid) };
}

// ---- Site : mêmes consignes que la route /api/assistant ----
const siteSystem = () => { const extra = knowledge.load('site'); return claude.SITE_PROMPT + (extra ? `\n\nConnaissances supplémentaires fournies par MANAGER-IA :\n${extra}` : ''); };

function check(text, s) {
  const fails = [];
  const rx = (p) => new RegExp(p, 'iu');
  for (const p of s.must || []) if (!rx(p).test(text)) fails.push(`devrait contenir « ${p} »`);
  for (const p of [...(s.mustNot || []), ...(scen.all.mustNot || [])]) if (rx(p).test(text)) fails.push(`ne devrait pas contenir « ${p} »`);
  if (text.length > scen.all.maxChars) fails.push(`trop long (${text.length} caractères)`);
  return fails;
}

async function run(kind, s) {
  const system = kind === 'site' ? siteSystem() : await wsAi.buildSystem(req, s.m);
  const t0 = Date.now();
  let text, err = null;
  try { text = await claude.ask({ system, messages: [{ role: 'user', content: s.q }], maxTokens: 700 }); } catch (e) { err = e.message; text = ''; }
  const fails = err ? [`erreur : ${err}`] : check(text, s);
  return { kind, module: s.m || 'site', q: s.q, text, fails, ms: Date.now() - t0 };
}

(async () => {
  await db.ready;
  req = await seed();
  const jobs = [];
  if (only !== 'workspace') scen.site.forEach((s) => jobs.push(['site', s]));
  if (only !== 'site') scen.workspace.forEach((s) => jobs.push(['workspace', s]));
  const results = [];
  for (const [kind, s] of jobs) {
    const r = await run(kind, s);
    results.push(r);
    console.log(`${r.fails.length ? 'À REVOIR' : 'OK      '} [${r.module}] ${r.q}`);
  }
  const bad = results.filter((r) => r.fails.length);
  const dir = path.join(config.ROOT, 'eval-results');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `essai-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.md`);
  let md = `# Essai des IA MANAGER-IA — ${new Date().toLocaleString('fr-FR')}\n\nModèle : ${config.ai.model}\n\n**Résultat : ${results.length - bad.length} réponses conformes sur ${results.length}. ${bad.length} à revoir.**\n\nLes vérifications automatiques sont simples (mots attendus ou interdits, longueur) : lisez aussi les réponses pour juger le ton et la justesse.\n`;
  if (bad.length) md += '\n## À revoir\n' + bad.map((r) => `- [${r.module}] « ${r.q} » : ${r.fails.join(' ; ')}`).join('\n') + '\n';
  md += '\n## Toutes les réponses\n';
  for (const r of results) md += `\n### ${r.fails.length ? '⚠️' : '✅'} [${r.module}] ${r.q}\n\n${r.text || '(aucune réponse)'}\n\n${r.fails.length ? '*Vérifications : ' + r.fails.join(' ; ') + '*\n' : ''}`;
  fs.writeFileSync(file, md);
  console.log(`\n${results.length - bad.length} / ${results.length} conformes. Rapport complet : ${file}\n`);
  process.exit(0);
})();
