# Politique de sécurité de l'information

*Version 2026-11-16. Ce document décrit ce que Brij-IA met en œuvre et vérifie par des tests automatiques ; il ne constitue pas une certification. Un test d'intrusion indépendant reste à réaliser.*

## 1. Principes
Moindre privilège ; défense en profondeur ; sécurité par défaut ; journalisation vérifiable ; transparence (incidents notifiés) ; amélioration continue.

## 2. Gouvernance
Responsable de la sécurité : [À COMPLÉTER]. Revue de cette politique au moins une fois par an et après tout incident majeur. Tout développeur lit et applique la section 5.

## 3. Contrôle d'accès
- **Utilisateurs** : mots de passe hachés (bcrypt, coût 12) ; en production, 10 caractères minimum et refus des mots courants, suites de clavier et « mot + chiffres » ; verrouillage progressif (15 min jusqu'à 24 h) ; sessions côté serveur, révocables, liste des appareils, alerte de connexion sur appareil inconnu.
- **Double authentification** (TOTP + codes de secours) proposée à tous, recommandée aux propriétaires et administrateurs, exigible par une organisation.
- **Organisations** : un utilisateur ne voit que les organisations dont il est membre ; rôles hiérarchiques (membre, responsable, administrateur, propriétaire) ; filtre par antenne. Testé automatiquement sur toutes les routes (refus 404 pour tout étranger).
- **Administration** : compte unique, session de 12 h, limiteur, 2FA recommandée [À COMPLÉTER : rendre obligatoire].
- Les comptes sont suspendus ou supprimés sans délai au départ d'une personne.

## 4. Cryptographie et secrets
HTTPS partout ; connexion à la base chiffrée ; secrets d'intégration (jetons WhatsApp/Meta, secrets TOTP, secrets de webhooks) et identifiants sociaux des employés chiffrés en base (AES-256-GCM) ; clé `DATA_KEY` distincte de `JWT_SECRET`, rotation possible sans perte (`DATA_KEY_PREVIOUS`) ; sauvegardes chiffrées ; aucun secret dans le dépôt ni dans les journaux (les jetons présents dans les adresses sont masqués) ; démarrage refusé en production avec une configuration faible.

## 5. Développement sûr
Requêtes SQL préparées ; validation stricte des entrées ; exports CSV neutralisés ; contrôle du contenu réel des fichiers ; appels sortants uniquement vers des adresses publiques en HTTPS ; dépendances surveillées (`npm audit`) ; revue de code ; tests de sécurité exécutés à chaque `npm test` (routes, isolation, authentification, données, confidentialité, entrées hostiles).

## 6. Intelligence artificielle
Données d'une organisation jamais mélangées à celles d'une autre ; contexte limité par rôle et antenne ; texte d'un tiers traité comme donnée (balises neutralisées) ; prix et montants issus des bases, jamais inventés par l'IA ; actions sensibles validées par une personne ; plafonds de coût (global, site, par organisation) ; quotas mensuels.

## 7. Journalisation et détection
Journal d'audit chaîné et ancré (vérifiable à la demande de l'administrateur) ; points d'abus par adresse et blocage automatique ; alertes à l'administrateur pour les événements graves ; registre des accès aux données de paie et RH consultable par les administrateurs de l'organisation ; numéro de requête propagé.

## 8. Exploitation
Serveur sans état (données en base) ; conteneur exécuté en utilisateur non privilégié ; en-têtes de sécurité (HSTS, nosniff, politique de contenu, no-store sur l'API) ; configuration contrôlée par `npm run security:check`.

## 9. Gestion des incidents et continuité
Voir documents 08 (violations) et 10 (continuité et sauvegarde).

## 10. Fournisseurs
Choix sur critères de sécurité et de localisation ; liste au document 07 ; revue annuelle.

## 11. Sensibilisation
Les personnes ayant accès aux données ou à l'administration sont formées aux hameçonnages, à la gestion des mots de passe et à la procédure d'incident [À COMPLÉTER : fréquence].

## 12. Limites connues
Voir `docs/securite/AUDIT.md` (constats ouverts) : champs métier non chiffrés individuellement, 2FA non obligatoire, expiration d'inactivité des sessions, rejeu possible de webhooks signés, durée de conservation du journal d'audit à définir.
