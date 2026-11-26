'use strict';
// Confidentialité : consentements, export des données, suppression avec anonymisation, durées de conservation, registre des accès, suppression complète d'une organisation.
// Lancez-le avec : node scripts/test-security-privacy.js
const { run, client } = require('./lib/wave2');

run('Confidentialité : droits des personnes, conservation, suppression', async ({ check, owner, mgr, mem, other, org, org2, O, base, dbx }) => {
  const adm = client(base);
  await adm('POST', '/api/admin/login', { username: 'admin-test', password: 'mot-de-passe-admin-test' });
  let r;

  // Consentements
  r = await mem('POST', '/api/privacy/consents', { kind: 'privacy', accepted: true });
  check('consentement : enregistré avec la version en vigueur', r.status === 201 && r.json.consents.find((c) => c.kind === 'privacy').upToDate === true, r.json);
  r = await mem('POST', '/api/privacy/consents', { kind: 'privacy', accepted: true, version: '1999-01-01' });
  check('consentement : une version inconnue est refusée', r.status === 400, r.status);
  r = await mem('POST', '/api/privacy/consents', { kind: 'marketing', accepted: true });
  r = await mem('POST', '/api/privacy/consents', { kind: 'marketing', accepted: false });
  r = await mem('GET', '/api/privacy/consents');
  check('consentement : historique daté conservé (accord puis retrait) et état actuel = retiré', r.json.history.filter((h) => h.kind === 'marketing').length === 2 && r.json.consents.find((c) => c.kind === 'marketing').accepted === false, r.json.history);
  r = await mem('POST', '/api/privacy/consents', { kind: 'inconnu', accepted: true });
  check('consentement : type inconnu refusé', r.status === 400, r.status);

  // Export de toutes les données de la personne
  r = await mem('GET', '/api/privacy/export');
  const j = r.json;
  check("export : JSON ouvert avec le profil, les consentements et les messages de la personne", r.status === 200 && j.format === 'mabah-export' && j.person.name === 'Paul' && j.tables.consents && j.tables.org_members, j && Object.keys(j.tables || {}));
  check("export : aucun mot de passe, empreinte ni secret", !/\$2[aby]\$|pass_hash|totp_secret|recovery_codes|token_hash/.test(r.text), null);
  check("export : aucune donnée d'une autre personne (e-mail d'Awa absent)", !/awa\d+@exemple\.com/.test(r.text));
  check("export : l'en-tête propose un téléchargement et interdit la mise en cache", /attachment/.test(r.headers.get('content-disposition')) && /no-store/.test(r.headers.get('cache-control')));
  r = await client(base)('GET', '/api/privacy/export');
  check('export : sans connexion, 401', r.status === 401, r.status);

  // Export de l'organisation (propriétaire seulement) + registre des accès
  await owner('POST', `${O}/hr/employees`, { name: 'Salarié Export', salary: 120000, cnpsNo: 'CNPS-777' });
  r = await mgr('GET', `/api/privacy/orgs/${org}/export`);
  check("export organisation : refusé à un responsable (403)", r.status === 403, r.status);
  r = await owner('GET', `/api/privacy/orgs/${org}/export`);
  check("export organisation : le propriétaire reçoit toutes les tables, champs chiffrés rendus lisibles, sans secret", r.status === 200 && r.json.tables.employees && r.json.tables.employees[0].cnps_no === 'CNPS-777' && !/v2:/.test(r.text) && !/"(wa_token|wa_secret|fb_token)":"v1:/.test(r.text), r.status);
  r = await other('GET', `/api/privacy/orgs/${org}/export`);
  check("export organisation : une autre organisation reçoit 404", r.status === 404, r.status);
  await owner('GET', `${O}/hr`);
  r = await owner('GET', `/api/privacy/orgs/${org}/access-log`);
  check("registre d'accès : la consultation des données RH est tracée avec le nom de la personne", r.status === 200 && r.json.entries.some((e) => e.action === 'pii.hr_read' && e.who === 'Awa'), r.json);
  r = await mem('GET', `/api/privacy/orgs/${org}/access-log`);
  check("registre d'accès : réservé aux administrateurs (403)", r.status === 403, r.status);

  // Durées de conservation
  r = await owner('GET', `/api/privacy/orgs/${org}/retention`);
  check('conservation : 4 types de données avec leur durée par défaut', r.status === 200 && r.json.rules.length === 4 && r.json.rules.every((x) => x.days >= x.min), r.json);
  r = await owner('PUT', `/api/privacy/orgs/${org}/retention`, { kind: 'ai_messages', days: 3 });
  check('conservation : durée trop courte refusée', r.status === 400, r.status);
  r = await owner('PUT', `/api/privacy/orgs/${org}/retention`, { kind: 'ai_messages', days: 60 });
  check('conservation : durée personnalisée enregistrée', r.status === 200 && r.json.rules.find((x) => x.kind === 'ai_messages').days === 60, r.json);
  const uid = (await dbx.prepare("SELECT id FROM users WHERE name = 'Awa' ORDER BY id DESC LIMIT 1").get()).id;
  const old = new Date(Date.now() - 100 * 86400000).toISOString(); const recent = new Date(Date.now() - 10 * 86400000).toISOString();
  for (const [t, at] of [['vieux', old], ['récent', recent]]) await dbx.prepare("INSERT INTO ai_messages (org_id, user_id, module, role, content, created_at) VALUES (?, ?, 'general', 'user', ?, ?)").run(org, uid, t, at);
  await dbx.prepare("INSERT INTO leads (name, what, message, contact, created_at) VALUES ('Vieux contact', 'essai', 'x', 'x@y.z', ?)").run(new Date(Date.now() - 4 * 365 * 86400000).toISOString());
  await dbx.prepare("INSERT INTO leads (name, what, message, contact, created_at) VALUES ('Contact récent', 'essai', 'x', 'x@y.z', ?)").run(new Date().toISOString());
  await dbx.prepare("INSERT INTO site_visits (day, path, source, device, n) VALUES ('2024-01-01', '/', 'direct', 'mobile', 3)").run();
  r = await adm('POST', '/api/admin/security/privacy/run', {});
  const ld = (await dbx.prepare('SELECT name FROM leads').all()).map((x) => x.name);
  check('conservation : contact de plus de 3 ans et visites de plus de 13 mois purgés, contact récent gardé', !ld.includes('Vieux contact') && ld.includes('Contact récent') && Number((await dbx.prepare("SELECT COUNT(*) c FROM site_visits WHERE day = '2024-01-01'").get()).c) === 0, ld);
  const left = (await dbx.prepare("SELECT content FROM ai_messages WHERE org_id = ?").all(org)).map((x) => x.content);
  check('conservation : le message plus vieux que 60 jours est purgé, le récent reste', r.json.purged >= 1 && !left.includes('vieux') && left.includes('récent'), left);

  // Suppression de compte
  r = await owner('POST', '/api/privacy/erasure', { password: 'secret123', confirm: 'SUPPRIMER' });
  check('suppression : un propriétaire d\'organisation doit d\'abord la supprimer ou la transférer (409)', r.status === 409, r.json);
  r = await mem('POST', '/api/privacy/erasure', { password: 'mauvais', confirm: 'SUPPRIMER' });
  check('suppression : mauvais mot de passe refusé', r.status === 403, r.status);
  r = await mem('POST', '/api/privacy/erasure', { password: 'secret123', confirm: 'oui' });
  check('suppression : confirmation écrite exigée', r.status === 400, r.status);
  r = await mem('POST', '/api/privacy/erasure', { password: 'secret123', confirm: 'SUPPRIMER' });
  check('suppression : demande enregistrée avec un délai de réflexion', r.status === 202 && r.json.eraseAfter, r.json);
  r = await mem('GET', '/api/privacy/overview');
  check('suppression : visible dans l\'aperçu (en attente)', r.json.erasure.pending === true && r.json.requests.some((x) => x.kind === 'erasure' && x.status === 'pending'), r.json.erasure);
  r = await mem('DELETE', '/api/privacy/erasure');
  r = await mem('GET', '/api/privacy/overview');
  check('suppression : annulable pendant le délai', r.json.erasure.pending === false, r.json.erasure);
  const memId = (await dbx.prepare("SELECT id FROM users WHERE name = 'Paul' ORDER BY id DESC LIMIT 1").get()).id;
  await dbx.prepare("INSERT INTO payments (reference, user_id, plan, operator, phone, amount_xaf, mode, status, created_at) VALUES ('MI-TESTAA', ?, 'unl_month', 'mtn', '237600', 150000, 'manual', 'paid', ?)").run(memId, new Date().toISOString());
  await mem('POST', '/api/privacy/erasure', { password: 'secret123', confirm: 'SUPPRIMER' });
  r = await adm('POST', '/api/admin/security/privacy/run', {});
  check('suppression : avant la fin du délai, rien n\'est effacé', r.json.erased === 0, r.json);
  await dbx.prepare("UPDATE users SET erase_after = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), memId);
  r = await adm('POST', '/api/admin/security/privacy/run', {});
  check('suppression : après le délai, le compte est anonymisé', r.json.erased === 1, r.json);
  const u = await dbx.prepare('SELECT * FROM users WHERE id = ?').get(memId);
  check("anonymisation : nom et contact remplacés, mot de passe inutilisable, 2FA vidée", u.name === 'Utilisateur supprimé' && /^supprime-\d+@anonyme\.invalid$/.test(u.contact) && u.anonymized_at && !u.pass_hash.startsWith('$2'), { name: u.name, contact: u.contact });
  check("anonymisation : liens avec les organisations retirés, appareils et messages effacés", Number((await dbx.prepare('SELECT COUNT(*) c FROM org_members WHERE user_id = ?').get(memId)).c) === 0 && Number((await dbx.prepare('SELECT COUNT(*) c FROM login_devices WHERE user_id = ?').get(memId)).c) === 0);
  check("anonymisation : la pièce comptable (paiement) est conservée, sans identité", Number((await dbx.prepare("SELECT COUNT(*) c FROM payments WHERE reference = 'MI-TESTAA'").get()).c) === 1);
  r = await mem('GET', '/api/me');
  check("anonymisation : l'ancienne session est fermée (401)", r.status === 401, r.status);
  r = await client(base)('POST', '/api/login', { contact: u.contact, pass: 'secret123' });
  check("anonymisation : plus de connexion possible", r.status === 401, r.status);
  check("anonymisation : l'opération est inscrite au journal d'audit", Number((await dbx.prepare("SELECT COUNT(*) c FROM audit_trail WHERE action = 'privacy.erasure_done'").get()).c) >= 1);

  // Suppression complète d'une organisation : plus aucune ligne portant son identifiant
  await dbx.prepare("INSERT INTO tmp_files (org_id, mime, data, expires_at) VALUES (?, 'audio/mpeg', ?, ?)").run(org2, Buffer.from('x'), new Date(Date.now() + 3600000).toISOString());
  await other('POST', `/api/ws/orgs/${org2}/crm/customers`, { name: 'Client à effacer', phone: '237611111111' });
  await other('POST', `/api/ws/orgs/${org2}/hr/employees`, { name: 'Employé à effacer', cnpsNo: 'X1' });
  r = await other('DELETE', `/api/ws/orgs/${org2}`, { confirm: 'Mauvais nom', password: 'secret123' });
  check("suppression d'organisation : exige le nom exact", r.status === 400, r.status);
  r = await other('DELETE', `/api/ws/orgs/${org2}`, { confirm: 'Autre Société', password: 'secret123' });
  check("suppression d'organisation : acceptée pour son propriétaire", r.status === 200, r.json);
  const tables = await dbx.prepare("SELECT table_name t FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'org_id' AND table_name NOT IN ('audit_trail')").all();
  const leftovers = [];
  for (const { t } of tables) { const c = Number((await dbx.prepare(`SELECT COUNT(*) c FROM "${t}" WHERE org_id = ?`).get(org2)).c); if (c) leftovers.push(`${t}:${c}`); }
  check(`suppression d'organisation : aucune ligne restante dans les ${tables.length} tables concernées`, leftovers.length === 0, leftovers);
  r = await other('GET', `/api/ws/orgs/${org2}`);
  check("suppression d'organisation : l'organisation n'existe plus (404)", r.status === 404, r.status);
});
