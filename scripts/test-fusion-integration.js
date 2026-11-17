'use strict';
// Fusion A + B : des données de plusieurs modules (stock, achats, bibliothèque, entrepôt, RH chiffrée) dans une même organisation ;
// export complet de l'organisation (données lisibles, champs sensibles déchiffrés), lecture tolérante d'une ancienne valeur en clair,
// puis suppression complète : plus aucune ligne dans AUCUNE table portant org_id (y compris les tables de la ligne A).
// Lancez-le avec : node scripts/test-fusion-integration.js
const { run } = require('./lib/wave2');

run('Fusion : export et suppression complète d\'une organisation multi-modules', async ({ check, owner, org, O, dbx }) => {
  let r;
  // --- RH : champ sensible chiffré au repos, lisible par l'API ; une ancienne valeur en clair reste lisible ---
  r = await owner('POST', `${O}/hr/employees`, { name: 'Employé chiffré', cnpsNo: 'CNPS-777', niu: 'M0123456789' });
  const emp = r.json.id;
  check('RH : employé créé', r.status === 201 && emp, r.json);
  const raw = await dbx.prepare('SELECT cnps_no, niu FROM employees WHERE id = ?').get(emp);
  check('RH : CNPS et NIU chiffrés au repos (préfixe v2:)', String(raw.cnps_no).startsWith('v2:') && String(raw.niu).startsWith('v2:'), raw);
  r = await owner('POST', `${O}/hr/employees`, { name: 'Ancien employé' });
  const old = r.json.id;
  await dbx.prepare("UPDATE employees SET cnps_no = 'CLAIR-123' WHERE id = ?").run(old); // ligne d'avant la fusion : en clair
  r = await owner('GET', `${O}/hr`);
  const list = r.json.employees || r.json;
  const e1 = list.find((x) => x.id === emp); const e2 = list.find((x) => x.id === old);
  check('RH : lecture tolérante — la valeur chiffrée est rendue en clair par l\'API', e1 && JSON.stringify(e1).includes('CNPS-777'), e1);
  check('RH : lecture tolérante — une ancienne valeur en clair reste lisible', e2 && JSON.stringify(e2).includes('CLAIR-123'), e2);

  // --- Données de plusieurs modules ---
  r = await owner('POST', `${O}/stock/items`, { name: 'Ciment fusion', unit: 'sac', quantity: 10, unitCost: 5000 });
  check('stock : article créé', r.status === 201, r.json);
  r = await owner('POST', `${O}/purchasing/suppliers`, { name: 'Fournisseur fusion', email: 'f@exemple.com' });
  check('achats : fournisseur créé', r.status === 201, r.json);
  const sup = r.json.id;
  r = await owner('POST', `${O}/purchasing/requests`, { title: 'Demande fusion', lines: [{ description: 'Ciment', quantity: 5, estPrice: 5000 }] });
  check('achats : demande créée', r.status === 201, r.json);
  r = await owner('POST', `${O}/stock/wms/warehouses`, { name: 'Dépôt fusion', code: 'FUS' });
  check('entrepôt : dépôt créé', r.status === 201 || r.status === 200, r.json);
  r = await owner('POST', `${O}/library/blocks`, { name: 'Bloc fusion', color: '#2f6f5e' });
  check('bibliothèque : bloc créé', r.status === 201 || r.status === 200, r.json);
  void sup;

  // --- Export complet ---
  r = await owner('GET', `/api/privacy/orgs/${org}/export`);
  const ex = r.json || {};
  const tables = Object.keys(ex.tables || {});
  check('export d\'organisation : 200 et format Brij-IA', r.status === 200 && ex.format, [r.status, ex.format]);
  for (const t of ['stock_items', 'pur_requests', 'suppliers', 'wms_warehouses', 'lib_blocks', 'employees']) {
    check(`export d'organisation : contient ${t}`, tables.includes(t), tables.length);
  }
  check('export d\'organisation : les champs sensibles sont lisibles (déchiffrés) et aucun secret', JSON.stringify(ex.tables.employees || []).includes('CNPS-777') && !JSON.stringify(ex).includes('v2:'), null);

  // --- Suppression complète ---
  r = await owner('DELETE', `/api/ws/orgs/${org}`, { confirm: 'Boutique Awa' });
  check('suppression d\'organisation acceptée', r.status === 200, r.json);
  const tabs = await dbx.prepare("SELECT table_name t FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'org_id' AND table_name NOT IN ('audit_trail')").all();
  const left = [];
  for (const { t } of tabs) { const c = Number((await dbx.prepare(`SELECT COUNT(*) c FROM "${t}" WHERE org_id = ?`).get(org)).c); if (c) left.push(`${t}:${c}`); }
  check(`suppression : aucune ligne restante dans les ${tabs.length} tables portant org_id`, left.length === 0, left);
  check('suppression : le fournisseur et les lignes liées ont disparu', Number((await dbx.prepare('SELECT COUNT(*) c FROM suppliers WHERE org_id = ?').get(org)).c) === 0, null);
});
