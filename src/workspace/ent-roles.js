'use strict';
// CATALOGUE « UN ESPACE = UN RÔLE » : source unique de vérité (rôle → modules → niveau). Le département n'est qu'un regroupement d'organigramme :
// chaque poste du modèle d'entreprise ouvre l'espace de SON rôle, avec uniquement les écrans de son métier ; un module peut figurer dans plusieurs espaces de rôle.
// L'espace est la PORTE : ce que la personne voit et fait dans un module partagé dépend en plus de son niveau (visiteur / membre / responsable) et de la portée
// appliquée par le module lui-même (voir docs/architecture-directions.md). Les 9 espaces historiques restent le repli (personnes sans poste) et le « mode simple ».
// Actif seulement avec les espaces de direction (réglage de l'entreprise, ent_setup.dir_spaces) : sinon rien ne change.
const T = require('./ent-templates');

/** Métiers : à quel métier appartient chaque module (sert à détecter un recouvrement accidentel entre rôles). */
const METIER_OF = {
  commercial: 'commercial', crm: 'commercial', sales: 'commercial', support: 'commercial', parties: 'commercial',
  marketing: 'marketing', accounting: 'finances', treasury: 'finances', budget: 'finances', fiscal: 'finances',
  hr: 'rh', talents: 'rh', payroll: 'rh', stock: 'stock', purchasing: 'stock', production: 'production', construction: 'chantiers', maintenance: 'maintenance', logistics: 'logistique',
  administration: 'gestion', legal: 'gestion', audit_interne: 'gestion', qhse: 'qhse', affaires: 'commercial', dashboard: 'direction', aifollow: 'direction', structure: 'direction', processes: 'direction', memory: 'direction', history: 'direction', agents: 'direction', alerts: 'direction',
  projects: 'projets', meetings: 'projets', chat: 'projets', library: 'projets', profil: 'projets', partners: 'projets', team: 'compte', entreprise: 'compte', integrations: 'compte', billing: 'compte',
};
/** Espace historique qui sert d'aperçu (tuiles) à chaque métier. */
const PARENT = { commercial: 'commercial', marketing: 'commercial', finances: 'finances', rh: 'rh', stock: 'stock', production: 'operations', chantiers: 'operations', maintenance: 'operations', logistique: 'operations', gestion: 'gestion', direction: 'direction', projets: 'projets' };
const ICON = { commercial: 'crm', marketing: 'marketing', finances: 'accounting', rh: 'hr', stock: 'stock', production: 'production', chantiers: 'construction', maintenance: 'maintenance', logistique: 'logistics', gestion: 'legal', direction: 'dashboard', projets: 'projects' };

// tkey (département.poste) → { metier, modules : écrans du métier, shared : écrans d'un AUTRE métier, accordés en connaissance de cause }
const R = (metier, modules, shared = []) => ({ metier, modules, shared });
const CATALOGUE = {
  'finance.comptable': R('finances', ['accounting', 'fiscal', 'treasury', 'budget'], ['crm', 'parties']),
  'finance.tresorier': R('finances', ['treasury', 'budget', 'accounting'], ['crm']),
  'finance.caissier': R('finances', ['treasury'], ['crm']),
  'finance.controleur': R('finances', ['budget', 'accounting'], ['dashboard', 'aifollow', 'history']),
  'pilotage.resp_pilotage': R('direction', ['dashboard', 'aifollow', 'history', 'structure', 'processes', 'memory', 'agents'], ['budget', 'accounting', 'audit_interne']),
  'pilotage.analyste': R('direction', ['dashboard', 'aifollow', 'history'], ['budget', 'accounting']),
  'pilotage.assistant_dir': R('gestion', ['administration'], []),
  'rh.resp_rh': R('rh', ['hr', 'talents', 'payroll']),
  'rh.paie': R('rh', ['payroll', 'hr']),
  'rh.recrutement': R('rh', ['talents', 'hr']),
  'commercial.resp_com': R('commercial', ['commercial', 'crm', 'sales', 'parties', 'support', 'affaires']),
  'commercial.resp_terrain': R('commercial', ['commercial', 'crm', 'parties', 'affaires']),
  'commercial.vendeur': R('commercial', ['commercial', 'crm', 'parties', 'affaires']),
  'commercial.assist_com': R('commercial', ['sales', 'crm']),
  'commercial.service_client': R('commercial', ['support', 'crm']),
  'marketing.resp_mkt': R('marketing', ['marketing']),
  'marketing.community': R('marketing', ['marketing']),
  'production.chef_prod': R('production', ['production'], ['maintenance', 'stock', 'qhse']),
  'production.operateur': R('production', ['production']),
  'production.qualite': R('production', ['production'], ['qhse']),
  'production.conducteur': R('chantiers', ['construction'], ['stock', 'projects', 'qhse']),
  'production.metreur': R('chantiers', ['construction'], ['stock']),
  'production.chef_chantier': R('chantiers', ['construction'], ['qhse']),
  'production.chef_projet': R('projets', ['projects']),
  'production.consultant': R('projets', ['projects']),
  'achats.resp_stock': R('stock', ['stock', 'purchasing'], ['parties']),
  'achats.acheteur': R('stock', ['purchasing', 'stock'], ['parties']),
  'achats.magasinier': R('stock', ['stock', 'purchasing']),
  'logistique.resp_log': R('logistique', ['logistics'], ['maintenance', 'stock', 'qhse']),
  'logistique.dispatcheur': R('logistique', ['logistics']),
  'logistique.chef_parc': R('logistique', ['logistics'], ['maintenance']),
  'logistique.chauffeur': R('logistique', ['logistics']),
  'logistique.livreur': R('logistique', ['logistics']),
  'informatique.resp_it': R('maintenance', ['maintenance'], ['logistics', 'integrations']),
  'informatique.technicien': R('maintenance', ['maintenance']),
  'informatique.mecanicien': R('maintenance', ['maintenance']),
  'securite.resp_securite': R('gestion', ['legal', 'administration', 'audit_interne'], ['qhse']),
};

const spaceId = (tkey) => 'r_' + tkey.replace('.', '_');
const postOf = {}; // tkey → poste du modèle
for (const d of T.DEPARTMENTS_RAW) for (const p of d.posts) postOf[`${d.key}.${p.key}`] = p;

/** Espaces de rôle prêts à être ajoutés au catalogue des espaces. */
const ROLES = Object.entries(CATALOGUE).map(([tkey, c]) => {
  const p = postOf[tkey] || {};
  return { id: spaceId(tkey), tkey, title: p.title || tkey, desc: 'Espace de ce rôle : uniquement les écrans de ce métier.', icon: ICON[c.metier], metier: c.metier, parent: PARENT[c.metier],
    modules: [...c.modules, ...c.shared], own: c.modules, shared: c.shared, head: p.kind === 'head' };
});
const BY_TKEY = Object.fromEntries(ROLES.map((r) => [r.tkey, r]));
const ROLE_IDS = ROLES.map((r) => r.id);
const isRole = (id) => ROLE_IDS.includes(id);

/** Niveau donné par un poste du modèle : le plus haut de ses niveaux d'origine ; un responsable de département est « responsable » de son rôle. */
function levelOfPost(tkey, kind, spaces) {
  const LV = { none: 0, view: 1, write: 2, manage: 3 };
  let best = 'write'; let max = 0;
  for (const v of Object.values(spaces || {})) if (LV[v] > max) { max = LV[v]; best = v; }
  if (kind === 'head') return 'manage';
  return max ? best : 'write';
}
/** Le poste est-il resté tel que le modèle l'avait fait ? (un poste personnalisé par le propriétaire garde ses propres espaces) */
function untouched(tkey, spaces) {
  const o = postOf[tkey];
  return Boolean(o) && JSON.stringify(spaces || {}) === JSON.stringify(o.spaces || {});
}

module.exports = { CATALOGUE, ROLES, BY_TKEY, ROLE_IDS, isRole, METIER_OF, PARENT, levelOfPost, untouched, spaceId };
