# Procédure de notification des violations de données

*Version 2026-11-16.*

## 1. Définition
Une violation est un incident de sécurité entraînant la destruction, la perte, l'altération, la divulgation ou l'accès non autorisés à des données personnelles (fuite de base, compte compromis, sauvegarde perdue, message envoyé à la mauvaise organisation…).

## 2. Rôles
| Rôle | Responsabilité | Titulaire |
|---|---|---|
| Responsable de l'incident | Pilote, décide, tient le registre | [À COMPLÉTER] |
| Référent protection des données | Évalue le risque pour les personnes, rédige les notifications | [À COMPLÉTER] |
| Responsable technique | Contient, investigue, corrige | [À COMPLÉTER] |
| Direction | Valide les notifications à l'autorité et au public | [À COMPLÉTER] |

## 3. Délais
| Étape | Délai visé |
|---|---|
| Détection → qualification (gravité) | 4 heures ouvrées |
| Confinement (couper l'accès, révoquer sessions et clés, fermer l'adresse bloquée) | Immédiat |
| Information des **organisations clientes** dont les données sont concernées (Brij-IA sous-traitant) | **Au plus tard 72 h** après la connaissance, dès que possible |
| Notification à l'**autorité de protection des données** (Brij-IA responsable) | Dans le délai fixé par la loi applicable [À COMPLÉTER : délai exact] et visé à **72 h** |
| Information des **personnes concernées** si risque élevé | Sans délai injustifié |
| Retour d'expérience | 10 jours ouvrés |

## 4. Étapes
1. **Détecter** : alertes du journal (« Alerte sécurité » : rupture de chaîne d'audit, verrouillage administrateur, blocage d'IP), signalement d'un client ou d'un chercheur, contrôle `npm run security:check`.
2. **Qualifier** : quelles données, combien de personnes, quelle organisation, quel risque (identité, finances, paie = élevé). Ouvrir une fiche d'incident (modèle ci-dessous).
3. **Contenir** : révoquer les sessions (`Administration → Sécurité`), faire tourner les secrets (`JWT_SECRET`, `DATA_KEY` via `DATA_KEY_PREVIOUS` et `npm run security:rotate-keys`), désactiver les clés d'API et webhooks, bloquer les adresses, couper la liaison WhatsApp d'une organisation (`wa-disconnect`).
4. **Préserver les preuves** : exporter le journal d'audit, vérifier sa chaîne (`POST /api/admin/security/audit/verify`), conserver les journaux du serveur.
5. **Évaluer** puis **notifier** (modèles ci-dessous).
6. **Corriger** la cause, tester, documenter dans le registre des violations (même sans notification).
7. **Retour d'expérience** et mise à jour des documents.

## 5. Modèle de fiche d'incident
Date/heure de détection · Détecté par · Description · Données et catégories de personnes · Nombre de personnes (estimé) · Organisations concernées · Cause probable · Mesures prises · Risque évalué (faible/moyen/élevé) et justification · Notifications faites (qui, quand) · Actions correctives.

## 6. Modèle de message à une organisation cliente
> **Objet : Incident de sécurité concernant vos données Brij-IA**
> Le [date] à [heure], nous avons détecté [nature de l'incident]. Il concerne [catégories de données] de [nombre approximatif] personnes de votre organisation. Cause connue : [cause ou « en cours d'analyse »]. Mesures déjà prises : [mesures]. Ce que nous vous recommandons : [actions]. Nous vous tiendrons informé(e) au plus tard le [date]. Contact : [référent].

## 7. Modèle de message aux personnes concernées
> **Objet : Information importante sur vos données**
> Nous avons constaté le [date] que [description claire]. Les données concernées : [liste]. Conséquences possibles : [risques]. Ce que nous avons fait : [mesures]. Ce que vous pouvez faire : [changer votre mot de passe, vérifier vos comptes, être vigilant face aux messages suspects]. Pour toute question : [contact].

## 8. Modèle de notification à l'autorité
Nature de la violation (catégories et nombre approximatif de personnes et d'enregistrements) · Coordonnées du référent · Conséquences probables · Mesures prises ou proposées · Date de la violation et de sa découverte · Motif d'un éventuel retard.

## 9. Exercices
Un exercice de simulation par an (fuite d'une clé d'API ; compte administrateur compromis) ; résultats consignés.
