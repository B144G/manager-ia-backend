'use strict';
// Vague 4 · Centre de relances : cadence J+3/J+10/J+20, arrêt à la réponse ou au paiement, e-mail par un FAUX serveur SMTP, lien de désinscription et opposition,
// anti-doublon, quotas, modes « proposer » et « automatique », canal manuel (wa.me), repli e-mail quand WhatsApp n'est pas connecté, modèles, journal.
// Lancez-le avec : node scripts/test-wave4-followups.js
const { run } = require('./lib/wave1');
const { fakeSmtp } = require('./lib/fakes');

const mailbox = []; let smtp;
const qp = (x) => Buffer.from(String(x).replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16))), 'latin1').toString('utf8').replace(/[  ]/g, ' ');
const ago = (days) => new Date(Date.now() - days * 86400000).toISOString();
const dayAgo = (days) => ago(days).slice(0, 10);
const until = async (fn, ms = 6000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 150)); } return false; };

run('Vague 4 · Centre de relances', async ({ check, owner, mgr, mem, other, org, O, dbx, base }) => {
  const F = `${O}/sales/followups`;
  const now = new Date().toISOString();
  const mk = async (name, email, phone) => Number((await dbx.prepare('INSERT INTO customers (org_id, name, phone, email, created_at) VALUES (?, ?, ?, ?, ?)').run(org, name, phone || '', email || '', now)).lastInsertRowid);
  const doc = async (cust, kind, number, status, total, paid, issued, due, created) => Number((await dbx.prepare('INSERT INTO documents (org_id, customer_id, kind, number, status, lines, total, paid, issued, due, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)').run(org, cust, kind, number, status, '[]', total, paid, issued, due, created || now, created || now)).lastInsertRowid);
  const awa = await mk('Awa Client', 'awa.client@exemple.com', '655000111');
  const marc = await mk('Marc Debiteur', 'marc.debiteur@exemple.com', '655000222');
  const nomail = await mk('Sans Mail', '', '655000333');
  const opp = await mk('Opposé Client', 'oppose@exemple.com', '655000444');
  const pros = await mk('Prospect Silencieux', 'prospect@exemple.com', '655000555');
  const invA = await doc(awa, 'invoice', 'F-TEST-A', 'sent', 100000, 20000, dayAgo(30), dayAgo(4));
  const invB = await doc(marc, 'invoice', 'F-TEST-B', 'sent', 50000, 0, dayAgo(30), dayAgo(12));
  const invC = await doc(nomail, 'invoice', 'F-TEST-C', 'sent', 30000, 0, dayAgo(30), dayAgo(5));
  await doc(opp, 'invoice', 'F-TEST-O', 'sent', 10000, 0, dayAgo(30), dayAgo(5));
  await doc(awa, 'invoice', 'F-TEST-OK', 'sent', 10000, 0, dayAgo(3), dayAgo(-10)); // pas échue : jamais relancée
  await doc(awa, 'quote', 'D-TEST-1', 'sent', 75000, 0, dayAgo(5), null);
  await doc(marc, 'invoice', 'F-TEST-U', 'sent', 22000, 0, dayAgo(8), null); // non payée, sans échéance
  const ord = await doc(awa, 'order', 'C-TEST-1', 'pending', 40000, 0, dayAgo(2), null, ago(2));
  await dbx.prepare("UPDATE customers SET followup_optout = 1 WHERE id = ?").run(opp);
  const chat = Number((await dbx.prepare("INSERT INTO chats (org_id, session, customer_id, status, channel, contact, created_at, updated_at) VALUES (?, 'sess-fu-1', ?, 'open', 'web', '', ?, ?)").run(org, pros, ago(4), ago(3))).lastInsertRowid);
  await dbx.prepare("INSERT INTO chat_messages (chat_id, role, content, created_at) VALUES (?, 'user', 'Je voudrais des infos', ?)").run(chat, ago(3));

  // ---------- Droits ----------
  let r = await mem('GET', F);
  check('centre de relances fermé aux membres', r.status === 403);
  r = await other('GET', F);
  check('autre organisation : 404', r.status === 404);

  // ---------- File : types et cadence ----------
  r = await mgr('GET', F);
  const q = r.json.queue;
  const find = (kind, ref) => q.find((x) => x.kind === kind && x.refId === ref);
  check('file : facture échue J+3 (étape 1) avec client, montant restant, échéance', r.status === 200 && find('invoice', invA) && find('invoice', invA).step === 1 && find('invoice', invA).amount === 80000 && find('invoice', invA).days === 4, find('invoice', invA));
  check('file : facture à J+12 = étape 1 seulement (une étape à la fois)', find('invoice', invB) && find('invoice', invB).step === 1);
  check('file : devis sans réponse, prospect silencieux, facture non payée sans échéance, commande à valider', find('quote', q.find((x) => x.kind === 'quote').refId) && q.some((x) => x.kind === 'prospect' && x.refId === chat) && q.some((x) => x.kind === 'unpaid') && q.some((x) => x.kind === 'order' && x.internal && x.refId === ord), q.map((x) => x.kind));
  check('file : facture non échue exclue, client opposé exclu', !q.some((x) => x.number === 'F-TEST-OK' || x.number === 'F-TEST-O') && r.json.optouts === 1, q.map((x) => x.number));
  check('canal par défaut : e-mail ; mode par défaut : proposer', r.json.settings.mode === 'propose' && r.json.settings.channel === 'email' && r.json.settings.cadences.invoice === '3,10,20' && r.json.channels.whatsappConnected === false, r.json.settings);

  // ---------- Réglages ----------
  r = await mgr('PUT', `${F}/settings`, { mode: 'auto' });
  check('mode automatique : réservé aux administrateurs', r.status === 403);
  r = await owner('PUT', `${F}/settings`, { cadences: { invoice: '10,5' } });
  check('cadence invalide (non croissante) refusée', r.status === 400, r.json);
  r = await owner('PUT', `${F}/settings`, { hourFrom: 18, hourTo: 8 });
  check('heures d\'envoi invalides refusées', r.status === 400);

  // ---------- Envoi par e-mail ----------
  const iA = find('invoice', invA);
  r = await mgr('POST', `${F}/items/${iA.id}/send`, {});
  check('envoi par e-mail (faux SMTP) : état « envoyée », canal e-mail', r.status === 200 && r.json.channel === 'email' && r.json.state === 'sent', r.json);
  const mail = qp(mailbox[mailbox.length - 1] || '');
  check('e-mail : destinataire, objet, montant restant, échéance, lien de désinscription signé', /awa\.client@exemple\.com/.test(mail) && /Rappel : facture F-TEST-A/.test(mail) && /80 000 FCFA/.test(mail) && new RegExp(dayAgo(4)).test(mail) && /followup-stop\/\d+\.\d+\.[a-f0-9]{24}/.test(mail) && /List-Unsubscribe/.test(mail), mail.slice(0, 700));
  const mailsN = mailbox.length;
  r = await mgr('POST', `${F}/items/${iA.id}/send`, {});
  check('anti-doublon : le même élément ne part pas deux fois', r.status === 400 && /déjà/.test(r.json.error) && mailbox.length === mailsN, r.json);
  r = await mgr('GET', F);
  check('journal : qui, quand, canal, résultat', r.json.log.some((l) => l.kind === 'invoice' && l.channel === 'email' && l.result === 'sent' && l.who === 'Marc' && l.at), r.json.log[0]);
  check('étape suivante pas créée tout de suite (écart minimal)', !r.json.queue.some((x) => x.kind === 'invoice' && x.refId === invA));
  // Cadence : J+10 puis J+20, jamais plus de 3
  await dbx.prepare("UPDATE fu_items SET updated_at = ? WHERE kind = 'invoice' AND ref_id = ?").run(ago(8), invA);
  await dbx.prepare('UPDATE documents SET due = ? WHERE id = ?').run(dayAgo(11), invA);
  r = await mgr('GET', F);
  const a2 = r.json.queue.find((x) => x.kind === 'invoice' && x.refId === invA);
  check('J+11 : étape 2 créée', a2 && a2.step === 2 && /^2e rappel/.test(a2.subject), a2);
  await mgr('POST', `${F}/items/${a2.id}/send`, {});
  await dbx.prepare("UPDATE fu_items SET updated_at = ? WHERE kind = 'invoice' AND ref_id = ?").run(ago(8), invA);
  await dbx.prepare('UPDATE documents SET due = ? WHERE id = ?').run(dayAgo(25), invA);
  r = await mgr('GET', F);
  const a3 = r.json.queue.find((x) => x.kind === 'invoice' && x.refId === invA);
  check('J+25 : étape 3 créée', a3 && a3.step === 3, a3);
  await mgr('POST', `${F}/items/${a3.id}/send`, {});
  await dbx.prepare("UPDATE fu_items SET updated_at = ? WHERE kind = 'invoice' AND ref_id = ?").run(ago(8), invA);
  r = await mgr('GET', F);
  check('nombre maximum de relances par dossier : pas de 4e étape', !r.json.queue.some((x) => x.kind === 'invoice' && x.refId === invA));

  // ---------- Arrêt automatique ----------
  const iB = find('invoice', invB);
  await dbx.prepare("UPDATE documents SET status = 'paid', paid = total WHERE id = ?").run(invB);
  r = await mgr('GET', F);
  check('arrêt dès que le client paie : relance retirée de la file', !r.json.queue.some((x) => x.id === iB.id));
  const stB = await dbx.prepare('SELECT state, stop_reason FROM fu_items WHERE id = ?').get(iB.id);
  check('état « arrêtée » avec la raison, tracé au journal', stB.state === 'stopped' && /payée/.test(stB.stop_reason) && (await mgr('GET', F)).json.log.some((l) => l.result === 'stopped' && /payée/.test(l.detail)), stB);
  const iP = r.json.queue.find((x) => x.kind === 'prospect');
  await dbx.prepare("INSERT INTO chat_messages (chat_id, role, content, created_at) VALUES (?, 'user', 'Finalement oui, je veux commander', ?)").run(chat, new Date().toISOString());
  r = await mgr('GET', F);
  check('arrêt dès que le client répond (message reçu depuis)', !r.json.queue.some((x) => x.id === iP.id) && (await dbx.prepare('SELECT stop_reason FROM fu_items WHERE id = ?').get(iP.id)).stop_reason === 'le client a répondu');
  const iQ = r.json.queue.find((x) => x.kind === 'quote');
  r = await mgr('POST', `${F}/items/${iQ.id}/replied`, {});
  check('« Le client a répondu » (indiqué par une personne) arrête le dossier', r.status === 200 && (await mgr('GET', F)).json.queue.every((x) => x.id !== iQ.id));

  // ---------- Opposition ----------
  r = await mgr('GET', F);
  const iU = r.json.queue.find((x) => x.kind === 'unpaid');
  r = await mgr('POST', `${F}/items/${iU.id}/send`, {});
  const lnk = (/followup-stop\/(\d+\.\d+\.[a-f0-9]{24})/.exec(qp(mailbox[mailbox.length - 1])) || [])[1];
  check('relance « non payée » envoyée avec lien', r.status === 200 && lnk);
  let res = await fetch(`${base}/api/ws/public/followup-stop/${lnk}`);
  const c = await dbx.prepare('SELECT followup_optout FROM customers WHERE id = ?').get(marc);
  check('lien de désinscription : le client s\'oppose aux relances', res.status === 200 && Number(c.followup_optout) === 1);
  res = await fetch(`${base}/api/ws/public/followup-stop/${lnk.slice(0, -3)}abc`);
  check('lien falsifié refusé', res.status === 404);
  await dbx.prepare("INSERT INTO fu_items (org_id, kind, ref_id, step, customer_id, state, created_at, updated_at) VALUES (?, 'invoice', ?, 1, ?, 'to_send', ?, ?)").run(org, invB + 1000, marc, now, now);
  // une relance déjà en file pour un client opposé n'est jamais envoyée
  const marcInv2 = await doc(marc, 'invoice', 'F-TEST-M2', 'sent', 1000, 0, dayAgo(30), dayAgo(6));
  const it2 = Number((await dbx.prepare("INSERT INTO fu_items (org_id, kind, ref_id, step, customer_id, state, created_at, updated_at) VALUES (?, 'invoice', ?, 1, ?, 'to_send', ?, ?)").run(org, marcInv2, marc, now, now)).lastInsertRowid);
  const n0 = mailbox.length;
  r = await mgr('POST', `${F}/items/${it2}/send`, {});
  check('client opposé : envoi refusé, élément « ignorée »', r.status === 400 && /opposé/.test(r.json.error) && mailbox.length === n0 && (await dbx.prepare('SELECT state FROM fu_items WHERE id = ?').get(it2)).state === 'ignored', r.json);
  r = await mgr('PUT', `${O}/crm/customers/${marc}/followup-optout`, { optout: false });
  check('un responsable peut lever l\'opposition à la demande du client', r.status === 200 && r.json.followupOptout === false);

  // ---------- Canaux ----------
  r = await mgr('GET', F);
  const iC = r.json.queue.find((x) => x.kind === 'invoice' && x.refId === invC);
  r = await mgr('POST', `${F}/items/${iC.id}/send`, {});
  const itC = await dbx.prepare('SELECT state, attempts, last_error FROM fu_items WHERE id = ?').get(iC.id);
  check('e-mail impossible (pas d\'adresse) : échec clair, l\'élément reste à envoyer', r.status === 400 && /adresse e-mail/.test(r.json.error) && itC.state === 'to_send' && Number(itC.attempts) === 1, [r.json, itC]);
  r = await mgr('PUT', `${F}/items/${iC.id}/channel`, { channel: 'manual' });
  r = await mgr('POST', `${F}/items/${iC.id}/send`, {});
  check('copie manuelle : message prêt et lien wa.me, marqué envoyé (canal « manual »)', r.status === 200 && r.json.channel === 'manual' && /^https:\/\/wa\.me\/237655000333\?text=/.test(r.json.waLink) && /F-TEST-C/.test(r.json.text), r.json);
  check('journal : envoi manuel', (await mgr('GET', F)).json.log.some((l) => l.result === 'manual' && l.channel === 'manual'));
  await dbx.prepare("INSERT INTO fu_items (org_id, kind, ref_id, step, customer_id, state, channel, created_at, updated_at) VALUES (?, 'invoice', ?, 1, ?, 'to_send', 'whatsapp', ?, ?)").run(org, marcInv2, awa, now, now).catch(() => {});
  const invW = await doc(awa, 'invoice', 'F-TEST-W', 'sent', 9000, 0, dayAgo(30), dayAgo(6));
  const itW = Number((await dbx.prepare("INSERT INTO fu_items (org_id, kind, ref_id, step, customer_id, state, channel, created_at, updated_at) VALUES (?, 'invoice', ?, 1, ?, 'to_send', 'whatsapp', ?, ?)").run(org, invW, awa, now, now)).lastInsertRowid);
  const n1 = mailbox.length;
  r = await mgr('POST', `${F}/items/${itW}/send`, {});
  check('WhatsApp non connecté : repli automatique par e-mail', r.status === 200 && r.json.channel === 'email' && r.json.fallback === true && mailbox.length === n1 + 1 && /F-TEST-W/.test(qp(mailbox[mailbox.length - 1])), r.json);
  check('journal : « repli e-mail » avec la raison', (await mgr('GET', F)).json.log.some((l) => l.result === 'fallback_email' && /connecté/.test(l.detail)));

  // ---------- Modèles ----------
  r = await mgr('POST', `${F}/templates/preview`, { subject: 'Rappel {numero}', body: 'Bonjour {client}, {montant} avant le {echeance} : {lien}' });
  check('aperçu avec des données d\'exemple', r.status === 200 && r.json.example && /Awa Mbarga \(exemple\)/.test(r.json.body) && /125 000 FCFA/.test(r.json.body) && /F-2026-0001/.test(r.json.subject), r.json);
  r = await mgr('PUT', `${F}/templates/invoice`, { subject: '', body: 'x' });
  check('modèle sans objet refusé', r.status === 400);
  r = await mgr('PUT', `${F}/templates/invoice`, { subject: 'Paiement en attente {numero}', body: 'Chère cliente {client}, merci de régler {montant}. {entreprise}' });
  check('modèle modifiable', r.status === 200);
  const invT = await doc(awa, 'invoice', 'F-TEST-T', 'sent', 9000, 0, dayAgo(30), dayAgo(7));
  r = await mgr('GET', F);
  const iT = r.json.queue.find((x) => x.refId === invT);
  check('la file utilise le modèle modifié', iT && /^Paiement en attente F-TEST-T/.test(iT.subject) && /Chère cliente Awa Client, merci de régler 9 000 FCFA\. Boutique Awa/.test(iT.body.replace(/[\u00a0\u202f]/g, ' ')), iT);
  r = await mgr('POST', `${F}/items/${iT.id}/send`, { body: 'Texte retouché à la main pour {client}' });
  check('le texte peut être retouché avant l\'envoi', r.status === 200 && /Texte retouché à la main/.test(qp(mailbox[mailbox.length - 1])));
  r = await mgr('POST', `${F}/items/${(await mgr('GET', F)).json.queue[0].id}/draft`, {});
  check('brouillon IA : refusé proprement si l\'IA n\'est pas activée (jamais d\'envoi)', r.status === 503, r.json);

  // ---------- Reporter / ignorer ----------
  await doc(awa, 'invoice', 'F-TEST-P1', 'sent', 5000, 0, dayAgo(30), dayAgo(6));
  await doc(awa, 'invoice', 'F-TEST-P2', 'sent', 5000, 0, dayAgo(30), dayAgo(6));
  r = await mgr('GET', F);
  const left = r.json.queue.filter((x) => !x.internal);
  if (left.length >= 2) {
    r = await mgr('POST', `${F}/items/${left[0].id}/postpone`, { days: 3 });
    check('reporter : état « reportée » avec date', r.status === 200 && (await dbx.prepare('SELECT state, postponed_until FROM fu_items WHERE id = ?').get(left[0].id)).state === 'postponed');
    r = await mgr('POST', `${F}/items/${left[1].id}/ignore`, { reason: 'client prévenu par téléphone' });
    check('ignorer : état « ignorée », tracé', r.status === 200 && (await dbx.prepare('SELECT state FROM fu_items WHERE id = ?').get(left[1].id)).state === 'ignored');
    r = await mgr('POST', `${F}/items/${left[0].id}/postpone`, { days: 99 });
    check('report invalide refusé', r.status === 400);
  } else check('il reste au moins deux relances', false, left.length);

  // ---------- Commande qui traîne : rappel interne aux responsables ----------
  r = await mgr('GET', F);
  const iO = r.json.queue.find((x) => x.kind === 'order');
  const before = Number((await dbx.prepare("SELECT COUNT(*) c FROM notices WHERE org_id = ? AND kind = 'followup'").get(org)).c);
  r = await mgr('POST', `${F}/items/${iO.id}/send`, {});
  check('commande à valider : rappel interne (notice + e-mail aux responsables), pas de message au client', r.status === 200 && r.json.channel === 'team' && Number((await dbx.prepare("SELECT COUNT(*) c FROM notices WHERE org_id = ? AND kind = 'followup'").get(org)).c) > before, r.json);

  // ---------- Quota ----------
  await owner('PUT', `${F}/settings`, { dayQuota: 1 });
  const invQ = await doc(awa, 'invoice', 'F-TEST-Q', 'sent', 9000, 0, dayAgo(30), dayAgo(6));
  const itQ = Number((await dbx.prepare("INSERT INTO fu_items (org_id, kind, ref_id, step, customer_id, state, created_at, updated_at) VALUES (?, 'invoice', ?, 1, ?, 'to_send', ?, ?)").run(org, invQ, awa, now, now)).lastInsertRowid);
  const n2 = mailbox.length;
  r = await mgr('POST', `${F}/items/${itQ}/send`, {});
  check('quota par jour atteint : envoi refusé, élément conservé', r.status === 400 && /Quota/.test(r.json.error) && mailbox.length === n2 && (await dbx.prepare('SELECT state FROM fu_items WHERE id = ?').get(itQ)).state === 'to_send', r.json);
  await owner('PUT', `${F}/settings`, { dayQuota: 30 });

  // ---------- Mode automatique ----------
  const h = new Date(Date.now() + 60 * 60000).getUTCHours();
  const outFrom = h < 20 ? h + 2 : 0; const outTo = h < 20 ? h + 3 : 1;
  r = await owner('PUT', `${F}/settings`, { mode: 'auto', channel: 'email', hourFrom: outFrom, hourTo: outTo });
  check('un administrateur active le mode automatique', r.status === 200);
  const n3 = mailbox.length;
  r = await owner('POST', `${F}/run`, {});
  check('automatique : hors des heures d\'envoi, rien ne part', r.status === 200 && r.json.sent === 0 && mailbox.length === n3, r.json);
  await owner('PUT', `${F}/settings`, { hourFrom: 0, hourTo: 24 });
  r = await owner('POST', `${F}/run`, {});
  const autoN = mailbox.length - n3;
  check('automatique : dans les heures d\'envoi, les relances à envoyer partent (e-mail)', r.status === 200 && r.json.sent >= 1 && autoN >= 1, r.json);
  const lg = (await owner('GET', F)).json.log;
  check('journal : envois automatiques marqués (auteur = automatique)', lg.some((l) => l.auto && l.result === 'sent'), lg.slice(0, 3));
  const n4 = mailbox.length;
  await owner('POST', `${F}/run`, {});
  check('automatique : pas de doublon au passage suivant', mailbox.length === n4);
  // mode proposer : notification au plus une fois par jour
  await owner('PUT', `${F}/settings`, { mode: 'propose' });
  await dbx.prepare('UPDATE fu_settings SET notified_on = ? WHERE org_id = ?').run('', org);
  await doc(awa, 'invoice', 'F-TEST-N', 'sent', 9000, 0, dayAgo(30), dayAgo(6));
  const nn0 = Number((await dbx.prepare("SELECT COUNT(*) c FROM notices WHERE org_id = ? AND kind = 'followup'").get(org)).c);
  await owner('POST', `${F}/run`, {});
  const nn1 = Number((await dbx.prepare("SELECT COUNT(*) c FROM notices WHERE org_id = ? AND kind = 'followup'").get(org)).c);
  await owner('POST', `${F}/run`, {});
  const nn2 = Number((await dbx.prepare("SELECT COUNT(*) c FROM notices WHERE org_id = ? AND kind = 'followup'").get(org)).c);
  check('mode proposer : les responsables sont prévenus une seule fois par jour', nn1 > nn0 && nn2 === nn1, [nn0, nn1, nn2]);
  r = await mem('POST', `${F}/run`, {});
  check('exécution manuelle réservée aux administrateurs', r.status === 403);
  void until;
}, {
  setup: async () => { smtp = await fakeSmtp(mailbox); return { env: { SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.port), SMTP_FROM: 'noreply@exemple.test', MAIL_DAY_FREE: '500', SITE_URL: 'https://app.exemple.test' } }; },
  teardown: async () => { smtp.srv.close(); },
});
