# Gestion des organisations (tableau, transfert, suppression)

## Écran
Espace Compte › **Entreprise et organigramme › Organisations** : tableau de toutes les organisations de la personne (celles dont elle est membre) **et**, si elle gère l'entreprise (propriétaire de l'organisation principale, ou direction générale administratrice de celle-ci), toutes les organisations de cette entreprise, même si elle n'en est pas membre (lecture seule : ni ouverture, ni action). Colonnes : nom et secteur, type (principale / liée), mon rôle, personnes, antennes (avec la limite de l'offre), offre, date de création, état (active / limite atteinte). Recherche, filtres par type et par rôle, tri sur chaque colonne, ligne cliquable. Sur téléphone, le tableau devient des cartes.
La **zone de danger** (propriétaire seulement) est dans l'onglet *Entreprise*.

## Routes
| Route | Droit | Rôle |
|---|---|---|
| `GET /api/ws/organisations` | connecté | tableau avec compteurs (jamais une organisation d'une autre entreprise) |
| `GET /api/ws/orgs/:id/deletion-impact` | propriétaire | nombres réels de ce qui sera effacé ; `blocked: 'linked_orgs'` si l'organisation principale a des organisations liées |
| `POST /api/ws/orgs/:id/ownership-transfer` | propriétaire | transfert (nom exact exigé) ; l'ancien propriétaire devient administrateur |
| `DELETE /api/ws/orgs/:id` | propriétaire | suppression : **nom exact + mot de passe**, limitée à 10 par heure |
| `GET /api/security/activity` | connecté | journal de ses propres événements de sécurité (sans détail brut) |

## Règles
- On ne supprime pas l'organisation **principale** tant que des organisations liées existent (409) : transférer sa propriété, ou supprimer d'abord les liées (chacune par son propriétaire).
- Dernière organisation de l'entreprise : l'entreprise (structure, direction générale, personnes, liens) disparaît avec elle ; l'écran l'annonce avant (`lastOfCompany`).
- Transfert de l'organisation **principale** : le titulaire de l'entreprise (`entreprises.owner_user_id`, qui porte l'abonnement des organisations liées) suit la propriété ; refusé si l'offre du nouveau propriétaire ne permet pas autant d'organisations que l'entreprise en compte.
- Audit : `org.delete` (critique, journal central), `org.ownership_transfer` (haute gravité) et le journal d'audit d'organisation (`ownership`/`transfer`).

## Limites connues
- Le mot de passe est demandé à la suppression, pas au transfert (le nom exact l'est dans les deux cas).
- Le tableau compte les antennes et les personnes ; l'usage de l'IA reste dans « Abonnement et usage ».
