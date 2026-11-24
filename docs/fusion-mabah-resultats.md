# Résultats de la fusion « fusion-mabah »

## Lot 1 — Réunions avancées + Espaces par rôle (activés par défaut) + Marque + slogan + renommage MABAH
- Suite complète serveur (`TEST_START_TRIES=200 npm test`, lancée seule) : **79/79 étapes réussies** en 1 679 s (journal : `docs/fusion-mabah-suite-lot1.log`).
- Premier lancement interrompu et refait : `test:commercial` a révélé un défaut réel de ma première version des espaces par défaut (un niveau « responsable » dérivé des droits actuels relevait les droits). Corrigé : le relèvement ne s'applique qu'aux espaces affectés par le propriétaire. `smoke:central` a échoué une fois au premier essai (journal d'audit lu avant écriture, sans lien avec les changements) et passé au second dans ce premier lancement ; le lancement final n'a eu aucun second essai.
- Migrations : 1–145 identiques à la production, 146–149 (réunions), 170–173 (espaces), 200–201 (marque) identiques à leurs branches ; autres numéros = migrations vides réservées ; aucune ancienne modifiée.
- Site : i18n 12 742/12 742 en EN, DE, ES ; eslint 0 erreur ; `vite build` réussi ; `test:brand` 36/36.
