## Sécurité et confidentialité
(A = `scripts/test-security-new.js`, `smoke-security`, `src/security/*` de la ligne A ; B = branche `claude/securite-784605`, commits 44de8ad et 85a395c)

| Fonction | A | B | Décision | Test qui la prouve |
|---|---|---|---|---|
| Sécurité du stock/achats/bibliothèque face aux doubles envois, quarantaine, seuils d'approbation | oui | — | A conservé | test-security-new (28) |
| Énumération de toutes les routes : 401 sans connexion hors liste blanche, 404 pour une autre organisation | non | oui | B conservé ; liste blanche complétée de `GET /api/ws/public/track/:token` (suivi de livraison de A, jeton secret) ; contrôles de couverture ajoutés pour Transport, Budget pro, Projets pro, Entrepôt, Achats, Bibliothèque, Comptabilité (1 138 routes énumérées) | test-security-routes (13) |
| Dépendances à jour (package-lock) | — | oui | B repris (lock fusionné) ; `npm audit` non rejoué (réseau) | — non testé |
| Plafond de coût de l'IA publique (`security/aibudget.js`) | non | oui | B | test-security-data |
| Échappement du bloc `<donnees>` des prompts (`promptguard.js`) | non | oui | B | test-security-data |
| Contenu réel des pièces jointes (signatures) | non | oui | B ; `test-plan-margin` adapté (fichiers à vraie signature) | test-ai-attach, test-plan-margin |
| Chiffrement des champs sensibles (CNPS, NIU, CNI, compte de paie, secrets de webhooks, jetons) | jetons v1 seulement | v1 + v2 | B ; lecture tolérante (clair accepté), DATA_KEY absente → dérivée de JWT_SECRET, `SKIP_STARTUP_ENCRYPTION=1` pour couper le chiffrement des anciennes lignes au démarrage | test-security-data, test-fusion-integration |
| Vérification du journal d'audit (chaîne + ancrages signés) | non | oui | B | test-security-data |
| Limites de corps JSON avant connexion | non | oui | B | test-security-auth |
| Verrouillage progressif, alerte d'appareil inconnu, sessions actives, 2FA exigible par organisation | non | oui | B | test-security-auth |
| Suppression complète d'une organisation (aucune ligne restante dans aucune table `org_id`) | non | oui | B ; contrôle étendu à toutes les tables de A (215 tables) | test-security-privacy, test-fusion-integration |
| Export des données d'une personne et d'une organisation, suppression avec anonymisation et délai de réflexion, consentements versionnés, conservation configurable, registre des accès paie/RH | non | oui | B | test-security-privacy (37) |
| Sauvegardes chiffrables | non | oui (obligatoire) | **réunir** : chiffrement OPTIONNEL (BACKUP_KEY) ; sans clé, copie en clair avec avertissement ; `STRICT_PROD_CONFIG=1` en production l'exige | test-security-data |
| Démarrage en production : JWT_SECRET ≥ 32, ADMIN_PASSWORD ≥ 12, ALLOWED_ORIGINS sans joker ni http | seuils 16/10 bloquants | 32/12 bloquants | **trancher** : seuils de A bloquants (inchangés) ; seuils de B en AVERTISSEMENT très visible, bloquants seulement si `STRICT_PROD_CONFIG=1` | test-config-prod (11) |
| Durcissement du Dockerfile, .dockerignore | non | oui | B | (revue) |
| En-têtes : HSTS, Referrer-Policy, `Cache-Control: no-store` et CSP sur `/api` | partiel | oui | B (les routes de fichiers gardent leur CSP propre) | test-security-auth |
| 20 documents (AUDIT + 10 textes FR + 10 EN) | non | oui | B repris tel quel dans `docs/securite/` | — (documents) |
| Scripts `test-security-*.js` de B (routes, auth, data, idor, privacy, fuzz) | non | oui | tous conservés et dans la chaîne `npm test` | idem |
