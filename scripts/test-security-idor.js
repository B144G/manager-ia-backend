'use strict';
// Sécurité : accès par identifiant à une ressource d'une AUTRE organisation (IDOR). L'organisation B crée de vraies ressources ; l'organisation A,
// qui connaît leurs identifiants, tente de les lire, modifier, supprimer ou de s'y référencer : toujours 404 (ou 400), jamais 200. Lancez-le avec : node scripts/test-security-idor.js
const { run } = require('./lib/wave2');

run('Sécurité : accès par identifiant à une autre organisation', async ({ check, owner, other, org, org2, O, ws }) => {
  const B = ws(org2);
  const mk = async (label, path, body) => { const r = await other('POST', `${B}${path}`, body); check(`B crée : ${label}`, r.status === 201 || r.status === 200, [r.status, r.json]); return r.json && (r.json.id || (r.json.customer && r.json.customer.id) || (r.json.item && r.json.item.id)); };
  const customer = await mk('client', '/crm/customers', { name: 'Client secret de B', phone: '237655555555' });
  const project = await mk('projet', '/projects', { name: 'Projet secret de B' });
  const item = await mk('article de stock', '/stock/items', { name: 'Article secret de B', unit: 'pièce', quantity: 5 });
  const emp = await mk('employé', '/hr/employees', { name: 'Employé secret de B', salary: 100000, cnpsNo: 'B-CNPS-1' });
  const entry = await mk('opération de budget', '/budget/entries', { kind: 'income', category: 'Vente', label: 'Recette secrète de B', amount: 50000, date: new Date().toISOString().slice(0, 10) });
  const ticket = await mk('demande d\'assistance', '/support', { customerName: 'Secret B', subject: 'Sujet secret de B', message: 'Contenu secret de B' });
  const branch = await mk('antenne', '/branches', { name: 'Antenne secrète de B' });
  const doc = customer ? await mk('devis', '/crm/documents', { customerId: customer, kind: 'quote', lines: [{ label: 'Prestation secrète de B', quantity: 1, price: 1000 }] }) : null;

  const deny = async (label, method, path, body) => { const r = await owner(method, `${O}${path}`, body); check(`A → ${label} : refusé (404/400)`, r.status === 404 || r.status === 400, [r.status, JSON.stringify(r.json).slice(0, 120)]); };
  const leak = (r, marker) => JSON.stringify(r.json || '').includes(marker);

  if (customer) { await deny('lire le client de B', 'GET', `/crm/customers/${customer}`); await deny('modifier le client de B', 'PUT', `/crm/customers/${customer}`, { name: 'piraté' }); await deny('supprimer le client de B', 'DELETE', `/crm/customers/${customer}`); }
  if (customer) await deny('créer un devis pour le client de B', 'POST', '/crm/documents', { customerId: customer, kind: 'quote', lines: [{ label: 'x', quantity: 1, price: 1 }] });
  if (doc) { await deny('modifier le devis de B', 'PUT', `/crm/documents/${doc}`, { note: 'piraté' }); await deny('supprimer le devis de B', 'DELETE', `/crm/documents/${doc}`); }
  if (project) { await deny('lire le projet de B', 'GET', `/projects/${project}`); await deny('modifier le projet de B', 'PUT', `/projects/${project}`, { name: 'piraté' }); await deny('supprimer le projet de B', 'DELETE', `/projects/${project}`); await deny('lire le résumé du projet de B', 'GET', `/projects/${project}/summary`);
    await deny('créer une tâche dans le projet de B', 'POST', '/projects/tasks', { title: 'intrus', projectId: project }); }
  if (item) { await deny('modifier l\'article de B', 'PUT', `/stock/items/${item}`, { name: 'piraté' }); await deny('mouvement sur l\'article de B', 'POST', `/stock/items/${item}/move`, { type: 'out', quantity: 1 }); await deny('lire les mouvements de l\'article de B', 'GET', `/stock/items/${item}/moves`); await deny('supprimer l\'article de B', 'DELETE', `/stock/items/${item}`); }
  if (emp) { await deny('modifier l\'employé de B', 'PUT', `/hr/employees/${emp}`, { salary: 1 }); await deny('lire le dossier RH de B', 'GET', `/hr/employees/${emp}/file`); await deny('supprimer l\'employé de B', 'DELETE', `/hr/employees/${emp}`); }
  if (entry) { await deny('modifier l\'opération de B', 'PUT', `/budget/entries/${entry}`, { amount: 1 }); await deny('supprimer l\'opération de B', 'DELETE', `/budget/entries/${entry}`); }
  if (ticket) { await deny('lire la demande de B', 'GET', `/support/${ticket}`); await deny('répondre à la demande de B', 'POST', `/support/${ticket}/messages`, { message: 'intrus' }); await deny('supprimer la demande de B', 'DELETE', `/support/${ticket}`); }
  if (branch) { await deny('modifier l\'antenne de B', 'PUT', `/branches/${branch}`, { name: 'piratée' }); await deny('supprimer l\'antenne de B', 'DELETE', `/branches/${branch}`); }
  if (branch) await deny('créer un client dans l\'antenne de B', 'POST', '/crm/customers', { name: 'Intrus', branchId: branch });
  if (project) await deny('créer une demande d\'achat liée au projet de B', 'POST', '/purchasing/requests', { title: 'Intrus', projectId: project, lines: [{ description: 'x', quantity: 1, unitPrice: 1 }] });
  if (customer) await deny('créer un ticket pour le client de B', 'POST', '/support', { customerId: customer, subject: 'intrus', message: 'x' });

  // Les listes de A ne contiennent aucune donnée de B
  const markers = ['secret de B', 'B-CNPS-1', 'Secret B'];
  for (const p of ['/crm/customers', '/projects', '/hr', '/budget', '/support', '/stock', '/branches', '/crm/documents']) {
    const r = await owner('GET', `${O}${p}`);
    check(`liste ${p} de A : aucune donnée de B`, r.status === 200 && !markers.some((m) => leak(r, m)), r.status);
  }
  // Et B garde ses données intactes
  const r2 = await other('GET', `${B}/crm/customers/${customer}`);
  check('les données de B sont intactes après les tentatives de A', r2.status === 200 && JSON.stringify(r2.json).includes('Client secret de B'), r2.status);
});
