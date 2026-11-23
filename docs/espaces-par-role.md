# Espaces par rôle

Chaque personne a **son espace** (Comptabilité, Commercial, Stock…) selon son compte et sa fonction dans l'entreprise cliente, au lieu d'un menu général où tous les modules sont listés pour tout le monde.

Réglage d'entreprise **« Espaces par rôle »** : **désactivé par défaut**. Tant qu'il l'est, rien ne change (ancien menu, mêmes droits). Le propriétaire l'active dans *Équipe et antennes › Espaces par rôle* ; le fondateur décidera plus tard d'en faire le défaut.

---

## 1. Audit de l'existant

### 1.1 Rôles de l'organisation (serveur : `src/workspace/access.js`)

| Rôle | Rang | Remarque |
|---|---|---|
| `member` Membre | 1 | tâches, demandes, lecture de la plupart des modules |
| `manager` Responsable | 2 | + projets, budget, RH, juridique… |
| `admin` Administrateur | 3 | + comptabilité, paie, fiscalité, intégrations, équipe ; **voit toutes les antennes** |
| `owner` Propriétaire | 4 | + abonnement, transfert de propriété, suppression ; désigne les rôles propres des modules |

Un seul rôle par personne et par organisation (`org_members.role`), une antenne facultative (`branch_id`), un intitulé libre (`title`). Un compte peut appartenir à plusieurs organisations (une ligne `org_members` par organisation).

### 1.2 Comment les droits par module sont décidés aujourd'hui

1. **Registre des modules** (`src/workspace/modules.js`) : chaque module a un rang minimum `min`. L'API `GET /orgs/:id` renvoie `modules` = ceux dont `min` ≤ rang de la personne. **La plupart sont à `member` : tout le monde voit presque tout.** `manager` : budget, suivi de l'IA, RH, juridique. `admin` : paie, fiscalité, comptabilité, intégrations. `owner` : abonnement.
2. **Gardes de route** : `A.need('manager'|'admin'|'owner')` sur ~300 routes, `A.can(req, …)` à l'intérieur des handlers. Le menu du site n'est qu'un reflet : le serveur refuse indépendamment.
3. **Rôles propres à certains modules, posés par-dessus** (désignés par le propriétaire ou un administrateur) :
   - Trésorerie : `tre_roles` (responsable de trésorerie, trésoriers) ; l'administrateur a tout.
   - RH Talents : `rh_roles` (`rh`, `recrut`, `talent`, `remun`) ; **un administrateur non désigné n'a aucun accès aux évaluations**.
   - Commercial : `cp_roles` (`sales_manager`, `sales_assistant`, `sales_field`, + `viewer` / `none` implicites) avec périmètre (équipe, zones).
   - Bibliothèque : `lib_role_perms`, `lib_user_perms`, `lib_delegations` (droits par rôle, par personne, délégations).
   - Réunions, Administration, Achats : règles par rôle / utilisateur (`users[]`, `roles[]`), seuils d'approbation d'achat par rôle (`pur_thresholds`).
   - Décisions : délégations de validation (`decision_delegations`).
4. **Antennes** : `A.scope` / `A.visible` filtrent les données par antenne (sauf administrateurs et personnes sans antenne).

### 1.3 Ce que l'API renvoie sur l'utilisateur

- `GET /api/me` : `{ user: { id, name, contact, plan, planExpires, interests, progress, project, created } }`.
- `GET /api/ws/orgs` : organisations de la personne avec son rôle.
- `GET /api/ws/orgs/:id` : `org`, `me { role, roleLabel, title, branchId, userId }`, `branches`, `modules` (filtrés par rang + Trésorerie selon `tre_roles`), `limits`, `features`, et **(nouveau) `spaces`**.

Côté site : `WsContext.can(min)` compare le rang ; `registry.js` associe chaque module à une icône ; `Frame.jsx` dessine le menu à partir de `info.modules`.

### 1.4 Ce qui manquait dans le modèle

1. **Aucune notion de fonction** : « comptable », « responsable stock »… n'existent pas. Seuls Trésorerie, RH et Commercial ont un rôle propre, chacun dans sa table.
2. **Un employé qui gère la comptabilité ne peut pas y accéder** s'il est « membre » (la comptabilité exige `admin`) : il faudrait en faire un administrateur de toute l'organisation (donc voir toutes les antennes, l'équipe, les intégrations…).
3. **Pas de lecture seule par module** : le rang donne la lecture *et* l'écriture ensemble.
4. **Pas de regroupement** des modules en espaces de travail, ni d'espace « par défaut » par personne.
5. Aucune mémoire du dernier espace choisi.

---

## 2. Correspondance « rôle / droits → espaces »

### 2.1 Les 9 espaces (un module appartient à un seul espace)

| Espace | Modules |
|---|---|
| `direction` Direction et pilotage | dashboard, aifollow, structure, processes, memory, history, agents, alerts |
| `commercial` Commercial | commercial, crm, sales, parties, marketing, support |
| `finances` Comptabilité et finances | accounting, treasury, budget, fiscal |
| `stock` Stock et achats | stock, purchasing |
| `rh` Ressources humaines | hr, talents, payroll |
| `operations` Opérations | production, logistics, construction, maintenance |
| `projets` Projets et réunions *(de base : ouvert à tous)* | projects, meetings, library |
| `gestion` Administration et juridique | administration, legal |
| `compte` Administration du compte | team, integrations, billing |

### 2.2 Niveaux d'accès à un espace

| Niveau | Nom affiché | Effet **serveur** |
|---|---|---|
| `view` | Visiteur (consultation seule) | lecture seulement ; toute écriture → **403 `space_readonly`** |
| `write` | Membre de l'espace | droits habituels (rôle d'organisation + rôles propres) |
| `manage` | Responsable de l'espace | dans les écrans **de cet espace seulement**, droits relevés au niveau administrateur pour la requête (jamais pour l'espace `compte`) ; la visibilité par antenne est conservée |
| (rien) | — | **403 `space_denied`** (sauf réglage « consultation ouverte », lecture seule) |

Le niveau `view` relève aussi les droits **en lecture** (un visiteur peut lire une comptabilité que son rang « membre » ne montrerait pas) : c'est ce que le propriétaire a accordé, personne par personne.

### 2.3 D'où vient l'accès d'une personne (ordre de priorité)

1. **Propriétaire / administrateur** : tous les espaces, niveau `manage` (non modifiable : on ne verrouille jamais le propriétaire).
2. **Affectation explicite** (`member_spaces`, écran Équipe) : remplace tout le reste pour cet espace (y compris « aucun »).
3. **Dérivé de l'ancien modèle** (rétrocompatibilité, sans rien affecter) :
   - `tre_roles` → Comptabilité et finances (`write`) ; `rh_roles` → Ressources humaines (`write`) ; `cp_roles` → Commercial (`write`, `manage` pour le responsable commercial) ;
   - rôle `manager` → Direction en visiteur ;
4. **De base, pour tous** : Projets et réunions (`write`).

Une personne sans affectation n'a donc que « Projets et réunions » (et ce que ses rôles propres lui donnent). L'écran d'activation le rappelle au propriétaire.

### 2.4 Rôles fonctionnels (modèles d'affectation)

Choisir une fonction pré-remplit les espaces ; le propriétaire ajuste ensuite espace par espace. Les fonctions sont mémorisées (`member_func_roles`) et affichées dans l'équipe.

| Fonction | Espaces proposés |
|---|---|
| Directeur / dirigeant | Direction `manage` + tous les autres en visiteur |
| Pilotage / contrôle de gestion | Direction `write` + tous les autres en visiteur |
| Comptable | Comptabilité `manage`, Commercial visiteur |
| Trésorier | Comptabilité `manage` |
| Responsable commercial | Commercial `manage`, Stock visiteur |
| Commercial / vendeur | Commercial `write`, Stock visiteur |
| Responsable stock et achats | Stock `manage`, Commercial visiteur |
| Acheteur / magasinier | Stock `write` |
| Responsable RH | RH `manage` (les rôles RH Talents restent désignés par le propriétaire) |
| Responsable opérations / production | Opérations `manage`, Stock visiteur |
| Chef de projet | Projets `manage`, Commercial visiteur |
| Juriste / conformité | Administration et juridique `manage` |
| Assistant administratif | Administration et juridique `write` |
| Administrateur du compte | Administration du compte `write` |

Projets et réunions reste `write` pour tout le monde (jamais rétrogradé par un modèle).

---

## 3. Modèle de données (migrations 170 à 173, additives)

Les emplacements 146 à 169 sont réservés aux autres sessions (migrations vides `SELECT n AS reserve`, remplacées sur place à la fusion). Aucune migration existante modifiée ; aucune destructive.

| N° | Tables | Rôle |
|---|---|---|
| 170 | `space_settings` (`enabled`, `open_read`), `space_log` | réglage par entreprise (défaut : désactivé) et journal |
| 171 | `member_spaces` (org, user, space, access), `member_func_roles` | affectations et fonctions |
| 172 | `member_space_prefs` | dernier espace choisi (d'un appareil à l'autre) |
| 173 | `member_photos` | photo de profil (PNG / JPEG / WebP, 400 Ko max) |

## 4. Routes (`/api/ws/orgs/:orgId/spaces/…`, `src/workspace/spaces.js`)

| Route | Droit | Rôle |
|---|---|---|
| `GET /me` | membre | espaces, niveaux, modules, atterrissage (aussi dans `GET /orgs/:id` → `spaces`) |
| `PUT /last` | membre | mémoriser l'espace courant (refusé s'il n'est pas accordé) |
| `GET /dashboard/:space` | accès à l'espace | indicateurs, nom et photo de la personne, mes tâches |
| `GET /overview` | direction ou administrateur | une carte par espace consultable |
| `GET /settings`, `PUT /settings` | admin ; **propriétaire** pour écrire | activer, « consultation ouverte », catalogues |
| `GET /assignments`, `PUT /assignments/:userId` | admin | affecter fonctions et niveaux |
| `GET /log` | admin | journal |
| `PUT / DELETE /photo`, `GET /photo/:userId` | membre (la sienne) / même organisation | photo |

**Garde serveur** (`guard`, montée une seule fois avant les routes de sous-applications dans `index.js`) : chaque requête vers un module est rattachée à son espace (table `SEG` chemin → module). Ensuite : visiteur + écriture → 403 ; aucun accès → 403 ; `manage` (ou visiteur en lecture) → relèvement du rôle **pour cette requête seulement**. Chemins communs (dashboard, décisions, IA, notifications, profil, partage…) : non bloqués, ils gardent leurs règles propres. Un chemin inconnu est traité comme commun : **tout nouveau module doit être ajouté à `modules.js`, à `SPACES` et à `SEG`** (voir §7).

Changements du cadre commun, volontairement minimes : `index.js` (3 lignes), `access.js` (`scope` / `visible` ne considèrent pas « administrateur » une personne relevée temporairement : elle garde sa visibilité par antenne), `db.js` (migrations).

## 5. Site

- Adresses : `/app/<org>/home/<espace>` (tableau de bord d'un espace), `/app/<org>/espaces` (choix), `/app/<org>/<module>` inchangé (les liens entre modules existants continuent de marcher).
- À la connexion : dernier espace mémorisé → sinon direction pour le propriétaire / direction → sinon l'unique espace de travail → sinon **écran de choix** (icône, nom, rôle).
- Menu d'espace (`SpaceSidebar`) : tableau de bord de l'espace puis ses écrans ; barre compacte « Mes espaces » (icônes, œil = visiteur) ; changement d'espace sans déconnexion ; mode réduit, tiroir sur tablette / téléphone.
- Barre basse mobile : Accueil de l'espace, ses deux premiers écrans, assistant, menu.
- **Visiteur** : bandeau « Consultation seule » + retour à mon espace, boutons d'écriture désactivés, et l'interface n'envoie aucune écriture (le serveur les refuse de toute façon).
- Un écran hors de ses espaces affiche un refus clair (pas de fuite) ; la palette Ctrl K ne propose que les écrans accordés (espace courant d'abord, les autres avec « consultation seule ») et « Aller à l'espace … ».
- Tableau de bord de chaque espace : **nom et photo de la personne** (initiales à défaut ; ajout / changement / retrait en un clic), indicateurs, prochaines tâches ; la direction ajoute la vue d'ensemble de tous les espaces consultables.
- Équipe › **Espaces par rôle** : activation (propriétaire), « consultation ouverte », affectation fonctions + niveaux par personne.
- i18n FR / EN / DE / ES (`src/i18n/*/ws-espaces.js`, contrôle `scripts/i18n-check.mjs` : 12 277 / 12 277).

## 6. Sécurité

- Droits **toujours appliqués côté serveur** ; l'interface reflète.
- Le visiteur ne peut ni écrire ni contourner : test sur POST / PUT / DELETE, y compris en rang « responsable » (relevé seulement en lecture).
- Relèvement limité à la requête et à l'espace ; jamais dans `compte` ; ne donne pas les rôles propres (Trésorerie reste soumise à `tre_roles` sauf pour qui a l'espace Finances en `manage`, RH Talents reste soumis à `rh_roles`).
- Un administrateur ne peut pas nommer un responsable de l'espace `compte` (propriétaire seulement) ; personne ne peut modifier ses propres affectations (admin requis) ni activer / désactiver le réglage (propriétaire).
- Isolation : toutes les tables sont filtrées par `org_id` ; photo lisible des seuls membres de la même organisation, servie en bac à sable.
- Tests : `npm run test:espaces` (65 vérifications) — redirection par rôle, choix multi-rôles et mémorisation, visiteur lecture seule, écritures refusées, propriétaire / direction, isolation entre entreprises, retour arrière, photo.

## 7. Ajouter un module plus tard

1. `modules.js` (registre existant) ; 2. `spaces.js` : l'ajouter à l'espace voulu (`SPACES[].modules`) **et** à `SEG` (segment d'URL → module) ; 3. fichier site `modules/<id>.jsx` et icône (`registry.js`).

## 8. Limites connues

- Le mode visiteur désactive les boutons d'écriture reconnus par leur style / libellé (primaire, danger, « Modifier », « Supprimer »…) ; un bouton d'écriture à l'apparence atypique peut rester cliquable : l'appel est alors refusé (message « Consultation seule »).
- Un module qui lit un autre module (liste de clients dans un formulaire de projet…) échoue en 403 si la personne n'a pas cet espace même en visiteur : accorder la consultation (ou activer « consultation ouverte »). C'est le prix d'une isolation stricte.
- Une personne sans affectation perd l'accès aux modules « membre » qui ne sont pas dans Projets et réunions dès l'activation : à affecter avant d'activer.
- Aucune migration de données automatique : les entreprises existantes ne sont pas touchées tant que le réglage reste désactivé.
- La messagerie interne, l'IA et les notifications restent communes à tous les espaces.

## 9. Démonstration

`scripts/demo/espaces-seed.js` (membres de démonstration par rôle, comptes `<prénom>@exemple.com` / `secret123`) puis `scripts/demo/espaces-captures.js` ; captures dans `docs/captures-espaces/`.
