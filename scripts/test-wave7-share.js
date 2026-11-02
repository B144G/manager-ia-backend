'use strict';
// Vague 7 · Documents PDF : fabrication (facture, rapport de projet, bulletin de paie), partage par personne / poste / rôle, boîte de réception, ouverture suivie,
// bulletins envoyés à chaque salarié (jamais aux autres), droits et suppression. Aucun appel externe.
// Lancez-le avec : node scripts/test-wave7-share.js
const zlib = require('zlib');
const { startTestPg } = require('./lib/testdb');

let passed = 0; let failed = 0;
const check = (name, cond, extra) => { if (cond) { passed++; console.log('  OK   ' + name); } else { failed++; console.log('  ECHEC ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); } };

function client(base) {
  const jar = {};
  return async (method, url, body, raw) => {
    const headers = body !== undefined ? { 'content-type': 'application/json' } : {};
    const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie) headers.cookie = cookie;
    const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const sc of res.headers.getSetCookie()) { const [pair] = sc.split(';'); const i = pair.indexOf('='); jar[pair.slice(0, i).trim()] = pair.slice(i + 1).trim(); }
    if (raw) return { status: res.status, buf: Buffer.from(await res.arrayBuffer()), headers: res.headers };
    const t = await res.text(); let json = null; try { json = JSON.parse(t); } catch { /* non JSON */ }
    return { status: res.status, json, text: t };
  };
}
/** Texte d'un PDF produit par pdfkit : on décompresse les flux et on relit les chaînes hexadécimales (polices standard, codage Windows-1252). */
function pdfText(buf) {
  let out = '';
  const s = buf.toString('latin1');
  for (const m of s.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    let c = Buffer.from(m[1], 'latin1');
    try { c = zlib.inflateSync(c); } catch { /* flux non compressé */ }
    for (const h of c.toString('latin1').matchAll(/<([0-9a-fA-F]+)>/g)) out += Buffer.from(h[1], 'hex').toString('latin1');
    out += '\n';
  }
  return out;
}
const isPdf = (b) => b.length > 200 && b.toString('latin1', 0, 5) === '%PDF-' && b.toString('latin1', b.length - 8).includes('%%EOF');

async function main() {
  const pgt = await startTestPg();
  for (const k of ['ALLOWED_ORIGINS', 'COOKIE_SAMESITE', 'COOKIE_SECURE', 'WHATSAPP_PHONE_ID', 'WHATSAPP_TOKEN', 'CAMPAY_USERNAME', 'CAMPAY_PASSWORD', 'BUSINESS_FILE', 'KNOWLEDGE_DIR', 'META_APP_ID', 'META_APP_SECRET', 'BREVO_API_KEY', 'SMTP_HOST']) process.env[k] = '';
  Object.assign(process.env, { NODE_ENV: 'test', JWT_SECRET: 'secret-de-test-assez-long-123456', DATABASE_URL: pgt.url, ANTHROPIC_API_KEY: 'cle-de-test', SIGNUP_VERIFY: 'off', TRUST_PROXY: '0', ADMIN_USERNAME: 'admin-test', ADMIN_PASSWORD: 'mot-de-passe-admin-test', WS_AI_FREE: '500', AI_PER_MINUTE: '500' });
  const { app } = require('../src/server');
  const { db } = require('../src/db');
  await db.ready;
  const PDF = require('../src/services/pdf');
  const srv = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const stamp = Date.now();
  try {
    console.log('Fabrication du PDF');
    const sample = await PDF.render({ org: 'Atelier Nkoulou', title: 'Essai é à ç — 2 400 000 FCFA', blocks: [{ type: 'table', cols: [{ key: 'a', label: 'Désignation', width: 3 }, { key: 'b', label: 'Montant', width: 1, align: 'right' }], rows: Array.from({ length: 70 }, (_, i) => ({ a: `Ligne ${i + 1} déjà`, b: '1 000' })), totals: [['Total', '70 000 FCFA', true]] }] }, { compress: false });
    const txt = pdfText(sample); const pages2 = (b) => (b.toString('latin1').match(/\/Type \/Page\b/g) || []).length;
    check('un PDF valide (en-tête, fin de fichier)', isPdf(sample), sample.length);
    check('les accents sont conservés (é, à, ç) et les espaces fines remplacées', /Essai é à ç/.test(txt) && /2 400 000 FCFA/.test(txt), txt.slice(0, 120));
    check('un long tableau passe sur plusieurs pages, avec numéro de page', pages2(sample) >= 2 && /Page 2 \/ \d/.test(txt), pages2(sample));
    const pages = (b) => (b.toString('latin1').match(/\/Type \/Page\b/g) || []).length;
    const one = await PDF.render({ org: 'Atelier', title: 'Court', blocks: [{ type: 'text', text: 'Une seule page.' }] }, { compress: false });
    check('un document court fait exactement 1 page (le pied de page n\'ajoute pas de page vide)', pages(one) === 1 && /Page 1 \/ 1/.test(pdfText(one)), pages(one));
    check('le nombre de pages annoncé est le nombre réel', new RegExp('Page ' + pages(sample) + ' / ' + pages(sample)).test(pdfText(sample)), pages(sample));
    check('un signe hors Windows-1252 devient « ? » (pas de caractère cassé)', PDF.clean('ok ✓ 世界') === 'ok ? ??');

    const owner = client(base); const paul = client(base); const awa = client(base); const eric = client(base); const zoe = client(base);
    const reg = async (c, name, tag) => { await c('POST', '/api/register', { name, contact: `${tag}${stamp}@exemple.com`, pass: 'secret123' }); return Number((await db.prepare('SELECT id FROM users WHERE contact = ?').get(`${tag}${stamp}@exemple.com`)).id); };
    const ownerId = await reg(owner, 'Nkoulou', 'nk'); const paulId = await reg(paul, 'Paul', 'paul'); const awaId = await reg(awa, 'Awa', 'awa'); const ericId = await reg(eric, 'Éric', 'eric'); const zoeId = await reg(zoe, 'Zoé', 'zoe');
    let r = await owner('POST', '/api/ws/orgs', { name: 'Atelier Nkoulou', currency: 'FCFA' });
    const org = r.json.id; const O = `/api/ws/orgs/${org}`;
    await db.prepare("UPDATE users SET plan = 'Illimité', plan_expires = ? WHERE id = ?").run(new Date(Date.now() + 86400000 * 30).toISOString(), ownerId); // plus de membres autorisés
    for (const [c, role] of [[paul, 'member'], [awa, 'manager'], [eric, 'member'], [zoe, 'member']]) { r = await owner('POST', `${O}/invites`, { role }); await c('POST', '/api/ws/orgs/join', { code: r.json.code }); }
    const emp = (name, job, userId, salary) => owner('POST', `${O}/hr/employees`, { name, job, userId, salary });
    await emp('Paul', 'Menuisier', paulId, 250000); await emp('Éric', 'Menuisier', ericId, 230000); await emp('Moussa', 'Menuisier', undefined, 220000); await emp('Awa', 'Comptable', awaId, 300000);

    console.log('Destinataires');
    r = await paul('GET', `${O}/share/audience`);
    check('un simple membre ne peut pas partager (403)', r.status === 403);
    r = await owner('GET', `${O}/share/audience`);
    const mj = r.json.jobs.find((j) => j.job === 'Menuisier');
    check('les postes sont listés avec le nombre de salariés et ceux qui ont un compte', mj && mj.employees === 3 && mj.withAccount === 2, r.json.jobs);
    check('les membres listés ne contiennent pas l\'expéditeur', r.json.members.length === 4 && !r.json.members.some((m) => m.userId === ownerId), r.json.members.length);
    r = await owner('POST', `${O}/share/preview`, { jobs: ['Menuisier'] });
    check('aperçu par poste : 2 personnes recevront, Moussa (sans compte) est signalé', r.json.count === 2 && r.json.noAccount.length === 1 && r.json.noAccount[0].name === 'Moussa', r.json);

    console.log('Rapport de projet partagé');
    r = await owner('POST', `${O}/projects`, { name: 'Boutique Mvogo', due: '2099-01-10' }); const pid = r.json.id;
    await owner('POST', `${O}/projects/tasks`, { projectId: pid, title: 'Découpe des planches', due: '2099-01-05', assigneeId: paulId });
    await owner('PUT', `${O}/projects/${pid}/budget`, { budget: 2400000 });
    await owner('POST', `${O}/projects/${pid}/costs`, { label: 'Bois', amount: 1200000 });
    r = await owner('POST', `${O}/share/send`, { kind: 'project', sourceId: pid, jobs: ['Menuisier'], userIds: [awaId, paulId], message: 'Voici le point du projet.' });
    const shareId = r.json && r.json.id;
    check('envoi : 3 destinataires distincts (Paul compté une fois), PDF créé', r.status === 201 && r.json.recipients === 3 && r.json.size > 500, r.json);
    check('Moussa (sans compte) est signalé dans la réponse', r.json.noAccount.length === 1);
    const nt = await db.prepare("SELECT user_id, text FROM notices WHERE org_id = ? AND ref = ?").all(org, 'share:' + shareId);
    check('chacun est prévenu dans l\'application (pas l\'expéditeur)', nt.length === 3 && !nt.some((n) => Number(n.user_id) === ownerId) && /Boutique Mvogo/.test(nt[0].text), nt.map((n) => n.user_id));
    r = await paul('GET', `${O}/share/inbox`);
    check('boîte de réception de Paul : 1 document non lu, avec le message', r.json.items.length === 1 && r.json.unread === 1 && r.json.items[0].message === 'Voici le point du projet.' && r.json.items[0].sender === 'Nkoulou', r.json);
    r = await paul('GET', `${O}/share/${shareId}/file`, undefined, true);
    const ptxt = pdfText(r.buf);
    check('Paul télécharge un vrai PDF', r.status === 200 && isPdf(r.buf) && /pdf/.test(r.headers.get('content-type')) && /no-store/.test(r.headers.get('cache-control')), r.status);
    check('le PDF contient le projet et la tâche, sans les coûts par défaut', /Boutique Mvogo/.test(ptxt) && /Découpe des planches/.test(ptxt) && !/Budget et coûts/.test(ptxt), ptxt.slice(0, 200));
    r = await paul('GET', `${O}/share/inbox`);
    check('après ouverture : lu', r.json.unread === 0 && r.json.items[0].opened === true);
    r = await zoe('GET', `${O}/share/${shareId}/file`, undefined, true);
    check('une personne qui n\'est pas destinataire ne peut pas l\'ouvrir (404)', r.status === 404);
    r = await owner('GET', `${O}/share/sent`);
    check('l\'expéditeur voit qui a ouvert : Paul oui, Éric non', r.json.items[0].recipients.find((x) => x.name === 'Paul').opened === true && r.json.items[0].recipients.find((x) => x.name === 'Éric').opened === false, r.json.items[0].recipients);
    r = await owner('POST', `${O}/share/send`, { kind: 'project', sourceId: pid, roles: ['manager'], includeCosts: true });
    const awaShare = r.json.id;
    check('envoi par rôle (responsables) : Awa seule', r.json.recipients === 1 && r.json.names[0] === 'Awa', r.json);
    r = await awa('GET', `${O}/share/${awaShare}/file`, undefined, true);
    check('avec les coûts demandés, le PDF contient le budget', /Budget et coûts/.test(pdfText(r.buf)) && /1 200 000/.test(pdfText(r.buf)));
    r = await owner('POST', `${O}/share/send`, { kind: 'project', sourceId: pid });
    check('sans destinataire : refus (400)', r.status === 400);
    r = await owner('POST', `${O}/share/send`, { kind: 'project', sourceId: 99999, userIds: [paulId] });
    check('projet inconnu : refus (404)', r.status === 404);

    console.log('Facture en PDF');
    r = await owner('POST', `${O}/crm/customers`, { name: 'Mme Mvogo', phone: '237650000000', email: 'mvogo@exemple.com' }); const cid = r.json.id;
    r = await owner('POST', `${O}/crm/documents`, { kind: 'invoice', customerId: cid, lines: [{ label: 'Comptoir en bois', quantity: 1, price: 450000 }, { label: 'Étagère', quantity: 3, price: 60000 }] });
    const did = r.json.id;
    check('facture créée', r.status === 201 && did, r.json);
    r = await owner('GET', `${O}/share/pdf/invoice/${did}`, undefined, true);
    const itxt = pdfText(r.buf);
    check('téléchargement du PDF de la facture (pièce jointe)', r.status === 200 && isPdf(r.buf) && /attachment/.test(r.headers.get('content-disposition')), r.status);
    check('le PDF contient le client, les lignes et le total', /Mme Mvogo/.test(itxt) && /Comptoir en bois/.test(itxt) && /Étagère/.test(itxt) && /630 000/.test(itxt) && /Total TTC/.test(itxt), itxt.slice(0, 300));
    check('la mention « document de travail » figure sur le PDF', /Document de travail/.test(itxt));
    r = await paul('GET', `${O}/share/pdf/invoice/${did}`, undefined, true);
    check('un membre ne peut pas produire la facture (403)', r.status === 403);
    r = await owner('POST', `${O}/share/send`, { kind: 'invoice', sourceId: did, userIds: [awaId], message: 'À vérifier' });
    check('la facture se partage à une collègue', r.status === 201 && r.json.recipients === 1);
    r = await owner('POST', `${O}/share/send`, { kind: 'payslip', sourceId: 1, userIds: [awaId] });
    check('un bulletin ne se partage pas comme un document ordinaire (400)', r.status === 400);

    console.log('Bulletins de paie : un par salarié');
    const month = new Date().toISOString().slice(0, 7);
    r = await owner('POST', `${O}/payroll/run`, { month });
    check('paie lancée : 4 brouillons', r.json.created === 4, r.json);
    r = await owner('POST', `${O}/share/payslips`, { month });
    check('brouillons : rien n\'est envoyé, raison donnée', r.json.sent === 0 && r.json.skipped.length === 4 && /brouillon/.test(r.json.skipped[0].reason), r.json);
    const slips = await db.prepare('SELECT id, employee_name FROM payroll_slips WHERE org_id = ?').all(org);
    for (const s of slips) await owner('POST', `${O}/payroll/slips/${s.id}/validate`, {});
    r = await owner('POST', `${O}/share/payslips`, { month });
    check('bulletins validés : envoyés à Paul, Éric et Awa ; Moussa (sans compte) signalé', r.json.sent === 3 && r.json.skipped.length === 1 && r.json.skipped[0].employee === 'Moussa' && /compte/.test(r.json.skipped[0].reason), r.json);
    r = await owner('POST', `${O}/share/payslips`, { month });
    check('deuxième envoi : « déjà envoyé », pas de doublon', r.json.sent === 0 && r.json.skipped.filter((x) => /déjà/.test(x.reason)).length === 3, r.json);
    r = await paul('GET', `${O}/share/inbox`);
    const slipItem = r.json.items.find((x) => x.kind === 'payslip');
    check('Paul reçoit son bulletin', slipItem && /Bulletin de paie/.test(slipItem.title), r.json.items.map((x) => x.title));
    r = await paul('GET', `${O}/share/${slipItem.id}/file`, undefined, true);
    const stxt = pdfText(r.buf);
    check('son PDF porte son nom et le net à payer, pas celui des autres', isPdf(r.buf) && /Paul/.test(stxt) && /Net à payer/.test(stxt) && !/Éric/.test(stxt) && !/Moussa/.test(stxt), stxt.slice(0, 200));
    const ericSlip = (await eric('GET', `${O}/share/inbox`)).json.items.find((x) => x.kind === 'payslip');
    r = await paul('GET', `${O}/share/${ericSlip.id}/file`, undefined, true);
    check('Paul ne peut pas ouvrir le bulletin d\'Éric (404)', r.status === 404);
    r = await awa('POST', `${O}/share/payslips`, { month });
    check('un responsable (non administrateur) ne peut pas envoyer les bulletins (403)', r.status === 403);
    r = await owner('GET', `${O}/share/${slipItem.id}/file`, undefined, true);
    check('l\'administrateur peut relire un bulletin envoyé', r.status === 200 && isPdf(r.buf));

    console.log('Retirer un partage');
    r = await awa('DELETE', `${O}/share/${shareId}`);
    check('un responsable ne peut pas retirer le partage d\'un autre (404 ou 403)', r.status === 403 || r.status === 404, r.status);
    r = await owner('DELETE', `${O}/share/${shareId}`);
    check('l\'expéditeur retire le partage', r.status === 200);
    r = await paul('GET', `${O}/share/inbox`);
    check('le document a disparu de la boîte de Paul, son bulletin reste', !r.json.items.some((x) => x.id === shareId) && r.json.items.some((x) => x.kind === 'payslip'));
    const left = Number((await db.prepare("SELECT COUNT(*) c FROM legal_files WHERE parent_type = 'share' AND parent_id = ?").get(shareId)).c);
    check('le fichier chiffré est supprimé aussi', left === 0);
    const raw = await db.prepare("SELECT data FROM legal_files WHERE parent_type = 'share' LIMIT 1").get();
    check('le PDF est stocké chiffré (pas de « %PDF » en clair)', raw && Buffer.from(raw.data).toString('latin1', 0, 5) !== '%PDF-');
    void zoeId;
  } catch (e) { failed++; console.log('  ECHEC exception', e && e.stack || e); }
  console.log(`\n${passed} réussis, ${failed} échecs`);
  srv.close();
  process.exit(failed ? 1 : 0);
}
main();
