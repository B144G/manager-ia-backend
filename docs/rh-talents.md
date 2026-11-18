# RH Talents — rapport

Branches `rh-talents` (serveur : worktree MANAGER-IA/rh-serveur, depuis 47a83d0 ; site : MANAGER-IA/rh-site, depuis 3b9b93c). Non poussées.

## Livré
Routes `/api/ws/orgs/:id/talents/*` + module site « Talents et compétences » (menu, accessible aux membres ; chaque route contrôle ses droits) :
GPEC (référentiel, matrice heatmap, écarts, besoins futurs, plan d'actions), recrutement par compétences (offres, grille, score de correspondance, entretiens, kanban, embauche),
MBO/SMART (cascade, assistant, avancement, score), 360° (anonymisation sans déduction par soustraction), KPI RH + alertes, formation (budget, sessions, à chaud/à froid, certificats → hr_trainings),
9-box/viviers/PDI, rémunération (grilles, compa-ratio, primes, simulation appliquable à employees.salary, prévision), effectifs/scénarios, succession/rétention, engagement (eNPS anonyme).
Droits : rôles RH rh/recrut/talent/remun désignés par le propriétaire seul ; un administrateur non désigné n'a pas accès ; journal `rh_*` dans audit_log (GET /audit).
Migrations : `src/migrations/rh-talents.js` ajouté en fin de tableau (db.js). La table employees n'est pas modifiée (profil RH dans rh_emp_profile).

## Tests
`scripts/test-rh-talents.js` (197 contrôles, dans test:chain via test:rh) ; non-régression OK : wave3-hr 58, fusion 20, privacy 37 ; smoke démo `scripts/smoke-rh-talents.js` 42/42. Site : eslint propre, i18n-check 100 %, vite build OK.
Non relancés après les derniers commits : security-routes, idor, wave3-ops (lancés en arrière-plan, logs dans le scratchpad), chaîne complète test:chain.

## Fusion
Serveur : `git merge rh-talents` — si d'autres sessions ont ajouté des migrations, les garder AVANT la ligne rh-talents (ajouter la nôtre en dernier dans db.js).
Site : `git merge rh-talents` (fichiers nouveaux + registry.js, fa.jsx d'une ligne).

## Limites
Pas d'écran « employé lié » pour les membres sans fiche ; pas de contrôle visuel mobile ; calendrier d'évaluation à froid non imposé.
