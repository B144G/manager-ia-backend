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
  { id: 'commercial', title: 'Commercial', min: 'member', ai: false },
  { id: 'aifollow', title: "Suivi de l'IA", min: 'manager', ai: false },
  { id: 'hr', title: 'Ressources humaines', min: 'manager', ai: true },
  { id: 'talents', title: 'Talents et compétences', min: 'member', ai: false }, // RH Talents : droits propres (rôles RH désignés par le propriétaire)
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
  { id: 'treasury', title: 'Trésorerie', min: 'member', ai: false },
  { id: 'library', title: 'Bibliothèque', min: 'member', ai: false },
  { id: 'purchasing', title: 'Achats', min: 'member', ai: false },
  { id: 'parties', title: 'Clients et fournisseurs', min: 'member', ai: false }, // clients / fournisseurs typés (simple, temporaire, permanent, haut de gamme) : étend customers et suppliers
  { id: 'meetings', title: 'Réunions', min: 'member', ai: false },
  { id: 'chat', title: 'Chat interne', min: 'member', ai: false, perm: 'chat' }, // clé de permission dédiée « chat » (espaces par rôle : à rattacher à cette clé)
  { id: 'structure', title: 'Organisation', min: 'member', ai: true },
  { id: 'processes', title: 'Fonctionnement', min: 'member', ai: true },
  { id: 'team', title: 'Équipe et antennes', min: 'member', ai: true },
  // Espaces de direction de département (chaque module n'existe que dans son espace de direction, jamais dans le menu général)
  { id: 'dir_commercial', title: 'Direction commerciale', min: 'member', ai: false },
  { id: 'dir_finances', title: 'Direction administrative et financière', min: 'member', ai: false },
  { id: 'dir_rh', title: 'Direction des ressources humaines', min: 'member', ai: false },
  { id: 'dir_production', title: 'Direction de la production', min: 'member', ai: false },
  { id: 'dir_logistique', title: 'Direction de la logistique', min: 'member', ai: false },
  { id: 'dir_stock', title: 'Direction du stockage et des achats', min: 'member', ai: false },
  { id: 'dir_marketing', title: 'Direction marketing', min: 'member', ai: false },
  { id: 'dir_it', title: 'Direction informatique et maintenance', min: 'member', ai: false },
  { id: 'dir_securite', title: 'Direction de la sécurité', min: 'member', ai: false },
  { id: 'partners', title: 'Partenaires et espaces partagés', min: 'member', ai: false }, // compte d'entreprise, étape 5
  { id: 'profil', title: 'Mon espace de travail', min: 'member', ai: false }, // profil de rôle du poste (compte d'entreprise, étape 3)
  { id: 'entreprise', title: 'Entreprise et organigramme', min: 'member', ai: false }, // compte d'entreprise : structure, postes, affectations
  { id: 'history', title: "Histoire de l'entreprise", min: 'member', ai: false },
  { id: 'alerts', title: 'Alertes', min: 'member', ai: true },
  { id: 'integrations', title: 'Intégrations', min: 'admin', ai: false },
  { id: 'administration', title: 'Administration', min: 'member', ai: false },
  { id: 'billing', title: 'Abonnement', min: 'owner', ai: false },
];
module.exports = { modules, ids: modules.map((m) => m.id) };
