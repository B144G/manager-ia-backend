# Éducation des deux IA

Chaque fichier `.md` déposé ici est ajouté automatiquement aux consignes de l'IA concernée (relu dès qu'il change, sans redémarrer). 14 000 caractères au maximum sont lus par IA et par module : écrivez court et précis.

## `site/` : l'assistant du site (visiteurs)
Tous les fichiers `.md` (sauf `README.md` et ceux qui commencent par `_`) sont lus. Idéal pour : offres et prix à jour, questions fréquentes, façon de parler, ce qu'il ne faut jamais promettre.

## `workspace/` : l'IA de l'espace de travail (gère l'activité des utilisateurs)
- `general*.md` : lu pour tous les modules (ex : `general-methode.md`, `general-vocabulaire.md`).
- `<module>*.md` : lu seulement pour ce module : `support`, `projects`, `budget`, `structure`, `processes`, `team`
  (ex : `support-ton-des-reponses.md`, `budget-regles-de-gestion.md`).

Bonnes pratiques : décrivez des **méthodes** et des **exemples de bonnes réponses**, pas des chiffres propres à un client (l'IA reçoit déjà les données de l'organisation). Ne mettez ici aucun secret ni donnée personnelle.

## État actuel (version 1)
Une première version complète est en place avec des choix par défaut prudents (vouvoiement, ton professionnel et chaleureux, pas d'émojis, jamais de promesse de gain, renvoi vers un professionnel pour le juridique et le fiscal). Elle est à corriger avec les réponses du fondateur au questionnaire d'éducation.

## Tester les IA avec votre vraie clé
1. Mettez `ANTHROPIC_API_KEY=...` dans le fichier `.env` (jamais dans le code ni dans une conversation).
2. Lancez `npm run eval:ai` (ou `npm run eval:ai -- --only=site`).
3. Ouvrez le rapport créé dans `eval-results/` : 40 questions (20 pour l'assistant du site, 20 pour l'IA de gestion), avec les réponses complètes et des vérifications automatiques simples.
Pour ajouter vos propres questions de test, modifiez `scripts/eval-scenarios.json`.
