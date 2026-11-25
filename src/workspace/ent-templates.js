'use strict';
// Compte d'entreprise : modèles par secteur (directions du pilotage, départements, postes). Texte en français (traduit côté site, clé = texte français).
// Tout est modifiable ensuite par l'entreprise (renommer, ajouter, désactiver) : un modèle n'impose jamais rien.
// Les niveaux d'accès d'un poste (champ `spaces`) sont ceux du système d'espaces par rôle : view = visiteur, write = membre, manage = responsable de l'espace.

const SECTORS = [
  { id: 'commerce', title: 'Commerce', desc: 'Boutique, négoce, distribution : ventes, achats, stock, livraisons.' },
  { id: 'btp', title: 'BTP et construction', desc: 'Chantiers, métrés, conduite de travaux, matériaux.' },
  { id: 'transport', title: 'Transport et logistique', desc: 'Flotte, chauffeurs, dispatching, entretien du parc.' },
  { id: 'services', title: 'Services', desc: 'Conseil, projets clients, prestations, équipes de terrain.' },
  { id: 'autre', title: 'Autre activité', desc: 'Les départements de base, à adapter librement.' },
];
const SECTOR_IDS = SECTORS.map((s) => s.id);

// Directions du pilotage. `on` = secteurs où la direction est active d'emblée (les autres sont proposées, désactivées : on peut les activer).
const DIRECTIONS = [
  { key: 'daf', name: 'Direction administrative et financière', director: { title: 'Directeur administratif et financier (DAF)', spaces: { dir_finances: 'manage', finances: 'view', direction: 'view', commercial: 'view' } } },
  { key: 'dtech', name: 'Direction technique', on: ['btp'], director: { title: 'Directeur technique', spaces: { dir_technique: 'manage', operations: 'view', direction: 'view', stock: 'view' } } },
  { key: 'dcom', name: 'Direction commerciale', director: { title: 'Directeur commercial', spaces: { dir_commercial: 'manage', commercial: 'view', stock: 'view', direction: 'view' } } },
  { key: 'dprod', name: 'Direction de la production', director: { title: 'Directeur de production', spaces: { dir_production: 'manage', operations: 'view', stock: 'view', direction: 'view' } } },
  { key: 'dlog', name: 'Direction de la logistique', director: { title: 'Directeur de la logistique', spaces: { dir_logistique: 'manage', operations: 'view', stock: 'view', direction: 'view' } } },
  { key: 'dit', name: 'Direction informatique et maintenance', director: { title: 'Directeur informatique et maintenance', spaces: { dir_it: 'manage', operations: 'view', direction: 'view' } } },
  { key: 'dstock', name: 'Direction du stockage et des achats', director: { title: 'Directeur du stockage et des achats', spaces: { dir_stock: 'manage', stock: 'view', finances: 'view', direction: 'view' } } },
  { key: 'dsec', name: 'Direction de la sécurité', director: { title: 'Directeur de la sécurité', spaces: { dir_securite: 'manage', gestion: 'view', direction: 'view' } } },
  { key: 'drh', name: 'Direction des ressources humaines', director: { title: 'Directeur des ressources humaines (DRH)', spaces: { dir_rh: 'manage', rh: 'view', direction: 'view' } } },
  { key: 'dmkt', name: 'Direction marketing', director: { title: 'Directeur marketing', spaces: { dir_marketing: 'manage', commercial: 'view', direction: 'view' } } },
];

const ALL = ['commerce', 'btp', 'transport', 'services', 'autre'];
const VIEW_ALL = { finances: 'view', commercial: 'view', stock: 'view', rh: 'view', operations: 'view' };

// Départements. `on` = secteurs où il est actif d'emblée. Les huit départements de base existent pour tous les secteurs.
// Postes : kind = head (responsable du département) ou staff ; `only` = secteurs concernés (par défaut tous) ; `hc` = nombre de places.
const DEPARTMENTS = [
  { key: 'finance', name: 'Finance', direction: 'daf', on: ALL, posts: [
    { key: 'comptable', title: 'Comptable', spaces: { finances: 'manage', commercial: 'view' } },
    { key: 'tresorier', title: 'Trésorier', spaces: { finances: 'manage' } },
    { key: 'controleur', title: 'Contrôleur de gestion', spaces: { finances: 'write', direction: 'view' } },
    { key: 'caissier', title: 'Caissier', spaces: { finances: 'write' } },
  ] },
  { key: 'pilotage', name: 'Pilotage', direction: null, on: ALL, posts: [
    { key: 'resp_pilotage', title: 'Responsable du pilotage', kind: 'head', spaces: { direction: 'manage', ...VIEW_ALL } },
    { key: 'analyste', title: 'Analyste de gestion', spaces: { direction: 'write', finances: 'view' } },
    { key: 'assistant_dir', title: 'Assistant(e) de direction', spaces: { direction: 'write', gestion: 'write' } },
  ] },
  { key: 'rh', name: 'Ressources humaines', direction: 'drh', on: ALL, posts: [
    { key: 'resp_rh', title: 'Responsable des ressources humaines', kind: 'head', spaces: { rh: 'manage' } },
    { key: 'paie', title: 'Gestionnaire de paie', spaces: { rh: 'write' } },
    { key: 'recrutement', title: 'Chargé(e) de recrutement', spaces: { rh: 'write' } },
  ] },
  { key: 'commercial', name: 'Commercial', direction: 'dcom', on: ALL, posts: [
    { key: 'resp_com', title: 'Responsable commercial', kind: 'head', spaces: { commercial: 'manage', stock: 'view' } },
    { key: 'vendeur', title: 'Commercial / vendeur', hc: 3, spaces: { commercial: 'write', stock: 'view' } },
    { key: 'assist_com', title: 'Assistant(e) commercial(e)', spaces: { commercial: 'write' } },
    { key: 'service_client', title: 'Agent du service client', spaces: { commercial: 'write' } },
  ] },
  { key: 'marketing', name: 'Marketing', direction: 'dmkt', on: ['commerce', 'services', 'autre'], posts: [
    { key: 'resp_mkt', title: 'Responsable marketing', kind: 'head', spaces: { commercial: 'manage' } },
    { key: 'community', title: 'Community manager', spaces: { commercial: 'write' } },
  ] },
  { key: 'production', name: 'Production', direction: 'dprod', on: ['btp', 'services', 'autre'], posts: [
    { key: 'chef_prod', title: 'Chef de production', kind: 'head', not: ['services'], spaces: { operations: 'manage', stock: 'view' } },
    { key: 'operateur', title: 'Opérateur de production', hc: 5, not: ['services', 'btp'], spaces: { operations: 'write' } },
    { key: 'qualite', title: 'Contrôleur qualité', not: ['services', 'btp'], spaces: { operations: 'write' } },
    { key: 'conducteur', title: 'Conducteur de travaux', kind: 'head', only: ['btp'], spaces: { operations: 'manage', stock: 'view' } },
    { key: 'metreur', title: 'Métreur', only: ['btp'], spaces: { operations: 'write', stock: 'view' } },
    { key: 'chef_chantier', title: 'Chef de chantier', only: ['btp'], hc: 2, spaces: { operations: 'write' } },
    { key: 'chef_projet', title: 'Chef de projet', kind: 'head', only: ['services'], spaces: { projets: 'manage', commercial: 'view' } },
    { key: 'consultant', title: 'Consultant(e)', only: ['services'], hc: 3, spaces: { projets: 'write' } },
  ] },
  { key: 'achats', name: 'Achats', direction: 'dstock', on: ['commerce', 'btp', 'transport', 'autre'], posts: [
    { key: 'resp_stock', title: 'Responsable stock et achats', kind: 'head', spaces: { stock: 'manage', finances: 'view' } },
    { key: 'acheteur', title: 'Acheteur', spaces: { stock: 'write' } },
    { key: 'magasinier', title: 'Magasinier', spaces: { stock: 'write' } },
  ] },
  { key: 'logistique', name: 'Logistique', direction: 'dlog', on: ['commerce', 'btp', 'transport', 'autre'], posts: [
    { key: 'resp_log', title: 'Responsable logistique', kind: 'head', spaces: { operations: 'manage', stock: 'view' } },
    { key: 'dispatcheur', title: 'Dispatcheur', only: ['transport'], spaces: { operations: 'write' } },
    { key: 'chef_parc', title: 'Chef de parc', kind: 'head', only: ['transport'], spaces: { operations: 'manage' } },
    { key: 'chauffeur', title: 'Chauffeur', only: ['transport'], hc: 5, spaces: { operations: 'write' } },
    { key: 'livreur', title: 'Livreur', only: ['commerce'], hc: 2, spaces: { operations: 'write' } },
  ] },
  { key: 'informatique', name: 'Informatique et maintenance', direction: 'dit', on: ['transport', 'services'], posts: [
    { key: 'resp_it', title: 'Responsable informatique et maintenance', kind: 'head', spaces: { operations: 'manage' } },
    { key: 'technicien', title: 'Technicien(ne)', hc: 2, spaces: { operations: 'write' } },
    { key: 'mecanicien', title: 'Mécanicien', only: ['transport'], hc: 2, spaces: { operations: 'write' } },
  ] },
  { key: 'securite', name: 'Sécurité', direction: 'dsec', on: ['btp', 'transport'], posts: [
    { key: 'resp_securite', title: 'Responsable sécurité', kind: 'head', spaces: { gestion: 'manage' } },
    { key: 'agent_securite', title: 'Agent de sécurité', hc: 3, spaces: {} },
  ] },
];

/** Plan complet pour un secteur : ce que « Appliquer le modèle » crée (seul ce qui manque est ajouté, jamais d'écrasement). */
function planFor(sector) {
  const sec = SECTOR_IDS.includes(sector) ? sector : 'autre';
  const deps = DEPARTMENTS.map((d, i) => ({
    key: d.key, name: d.name, direction: d.direction, sort: i, active: d.on.includes(sec),
    posts: d.posts.filter((p) => (!p.only || p.only.includes(sec)) && !(p.not || []).includes(sec)).map((p, j) => ({ key: p.key, title: p.title, kind: p.kind || 'staff', spaces: p.spaces, hc: p.hc || 1, sort: j })),
  }));
  const dirs = DIRECTIONS.map((d, i) => {
    const active = (d.on ? d.on.includes(sec) : false) || deps.some((x) => x.direction === d.key && x.active) || d.key === 'daf' || d.key === 'drh';
    return { key: d.key, name: d.name, sort: i, active, director: { key: 'dir_' + d.key, title: d.director.title, kind: 'director', spaces: d.director.spaces, hc: 1 } };
  });
  return { sector: sec, directions: dirs, departments: deps };
}

/** Anciens accès des postes de directeur (avant les espaces de direction) : sert à convertir un poste NON personnalisé quand le propriétaire active les espaces de direction. */
const LEGACY_DIRECTOR_SPACES = {
  dir_daf: { finances: 'manage', direction: 'view', commercial: 'view' }, dir_dtech: { operations: 'manage', direction: 'view', stock: 'view' }, dir_dcom: { commercial: 'manage', stock: 'view', direction: 'view' },
  dir_dprod: { operations: 'manage', stock: 'view', direction: 'view' }, dir_dlog: { operations: 'manage', stock: 'view', direction: 'view' }, dir_dit: { operations: 'manage', direction: 'view' },
  dir_dstock: { stock: 'manage', finances: 'view', direction: 'view' }, dir_dsec: { gestion: 'manage', direction: 'view' }, dir_drh: { rh: 'manage', direction: 'view' }, dir_dmkt: { commercial: 'manage', direction: 'view' },
};
module.exports = { LEGACY_DIRECTOR_SPACES, SECTORS, SECTOR_IDS, DIRECTIONS, DEPARTMENTS, planFor };
