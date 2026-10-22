'use strict';
// Registre des sous-applications de l'espace de travail. Le frontend construit son menu à partir de cette liste :
// pour ajouter une sous-application, ajoutez une ligne ici, un fichier de routes et un fichier côté site.
const modules = [
  { id: 'dashboard', title: 'Tableau de bord', min: 'member', ai: true },
  { id: 'support', title: 'Service client', min: 'member', ai: true },
  { id: 'projects', title: 'Projets et tâches', min: 'member', ai: true },
  { id: 'budget', title: 'Budget', min: 'manager', ai: true },
  { id: 'stock', title: 'Stock et achats', min: 'member', ai: true },
  { id: 'crm', title: 'Clients et ventes', min: 'member', ai: true },
  { id: 'sales', title: 'Assistant commercial', min: 'member', ai: true },
  { id: 'hr', title: 'Ressources humaines', min: 'manager', ai: true },
  { id: 'payroll', title: 'Paie', min: 'admin', ai: true },
  { id: 'fiscal', title: 'Fiscalité et liasse', min: 'admin', ai: true },
  { id: 'marketing', title: 'Marketing', min: 'member', ai: true },
  { id: 'logistics', title: 'Logistique', min: 'member', ai: true },
  { id: 'production', title: 'Production', min: 'member', ai: true },
  { id: 'construction', title: 'Chantiers (BTP)', min: 'member', ai: true },
  { id: 'maintenance', title: 'Maintenance', min: 'member', ai: true },
  { id: 'legal', title: 'Juridique et conformité', min: 'manager', ai: true },
  { id: 'memory', title: "Mémoire de l'entreprise", min: 'member', ai: true },
  { id: 'agents', title: 'Agents spécialisés', min: 'member', ai: false },
  { id: 'accounting', title: 'Comptabilité', min: 'admin', ai: false },
  { id: 'structure', title: 'Organisation', min: 'member', ai: true },
  { id: 'processes', title: 'Fonctionnement', min: 'member', ai: true },
  { id: 'team', title: 'Équipe et antennes', min: 'member', ai: true },
  { id: 'alerts', title: 'Alertes', min: 'member', ai: true },
  { id: 'integrations', title: 'Intégrations', min: 'admin', ai: false },
  { id: 'billing', title: 'Abonnement', min: 'owner', ai: false },
];
module.exports = { modules, ids: modules.map((m) => m.id) };
