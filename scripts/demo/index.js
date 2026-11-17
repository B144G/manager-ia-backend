'use strict';
// Démonstration complète de Brij-IA : crée l'entreprise « Batimat Afrique SARL » et utilise toutes les fonctions du site (sauf l'assistant WhatsApp).
//
//   Essai local (base jetable, rien n'est envoyé) :   node scripts/demo/index.js --local [--keep] [--port 3000] [--only base,stock]
//   Sur le site en ligne :                             node scripts/demo/index.js --url https://VOTRE-SERVEUR.onrender.com --contact VOTRE@EMAIL --pass MOT_DE_PASSE [--org ID]
//
// --keep : garde le serveur local allumé à la fin (pour visiter la démo avec le site sur http://localhost:5173).
// Résultat : la liste des fonctions utilisées, et celles qui ont échoué (avec le message d'erreur).
const { startLocal, makeCtx } = require('./lib');

const GROUPS = ['base', 'stock', 'commerce', 'operations', 'finance', 'work'];

function args() {
  const a = process.argv.slice(2); const o = {};
  for (let i = 0; i < a.length; i++) { if (!a[i].startsWith('--')) continue; const k = a[i].slice(2); const v = a[i + 1] && !a[i + 1].startsWith('--') ? a[++i] : true; o[k] = v; }
  return o;
}

(async () => {
  const o = args();
  const local = !!o.local || !o.url;
  let srv = null;
  if (local) srv = await startLocal(o.port ? Number(o.port) : undefined);
  const base = local ? srv.base : String(o.url).replace(/\/+$/, '');
  const contact = o.contact || (local ? 'awa.kamga@batimat-demo.example' : null);
  const pass = o.pass || (local ? 'Demo-Batimat-2026' : null);
  if (!contact || !pass) { console.log('Indiquez --contact et --pass (le compte du dirigeant).'); process.exit(2); }
  const ctx = makeCtx({ base, verbose: !!o.verbose });
  const only = o.only ? String(o.only).split(',') : GROUPS;
  const t0 = Date.now();
  try {
    for (const g of GROUPS) {
      if (g !== 'base' && !only.includes(g)) continue;
      ctx.group = g;
      console.log(`\n== ${g}`);
      try {
        if (g === 'base') await require('./base')(ctx, { local, contact, pass, org: o.org });
        else await require(`./${g}`)(ctx);
      } catch (e) {
        ctx.results.push({ group: g, feature: `${g} : arrêt inattendu`, ok: false, error: String(e.stack || e) });
        console.log(`  ECHEC ${g} : arrêt inattendu -> ${e.stack || e}`);
        if (g === 'base') throw e;
      }
    }
  } finally {
    const ok = ctx.results.filter((r) => r.ok).length; const ko = ctx.results.filter((r) => !r.ok);
    console.log(`\n${'='.repeat(60)}\nBatimat Afrique SARL — organisation n° ${ctx.org}\n${ok} fonctions utilisées avec succès, ${ko.length} en échec (${Math.round((Date.now() - t0) / 1000)} s)`);
    const byGroup = {};
    for (const r of ctx.results) { byGroup[r.group] = byGroup[r.group] || [0, 0]; byGroup[r.group][r.ok ? 0 : 1]++; }
    for (const [g, [a, b]] of Object.entries(byGroup)) console.log(`  ${g.padEnd(12)} ${a} OK${b ? `, ${b} ECHEC` : ''}`);
    if (ko.length) { console.log('\nÉchecs :'); for (const r of ko) console.log(`  - [${r.group}] ${r.feature} : ${r.status || ''} ${r.error || ''}`.slice(0, 400)); }
    if (local) {
      console.log(`\nCompte du dirigeant : ${contact} / ${pass}`);
      if (o.keep) { console.log(`Serveur local allumé sur ${base} (Ctrl+C pour arrêter).`); process.on('SIGINT', async () => { await srv.stop(); process.exit(0); }); await new Promise(() => {}); }
      await srv.stop();
    }
    process.exitCode = ko.length ? 1 : 0;
  }
})().catch((e) => { console.error(e); process.exit(1); });
