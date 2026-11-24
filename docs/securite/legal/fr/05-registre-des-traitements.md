# Registre des traitements

*Version 2026-11-16 — registre tenu par MABAH en tant que **responsable de traitement** (partie A) et en tant que **sous-traitant** pour le compte de ses clients (partie B).*

Responsable : [À COMPLÉTER : dénomination, adresse] · Référent protection des données : [À COMPLÉTER].

## A. Traitements dont MABAH est responsable

| N° | Traitement | Finalité | Personnes | Données | Base | Destinataires | Transferts | Durée | Sécurité |
|---|---|---|---|---|---|---|---|---|---|
| A1 | Gestion des comptes | Créer, authentifier, gérer les comptes et abonnements | Utilisateurs | Nom, contact, mot de passe haché, offre, centres d'intérêt | Contrat | Hébergeur, base de données, e-mail | Voir doc 07 | Vie du compte ; anonymisation à la demande (14 j) | Hachage bcrypt, sessions révocables, 2FA, verrouillage |
| A2 | Paiements | Encaisser, prouver, facturer | Utilisateurs payeurs | Référence, opérateur, téléphone Mobile Money, montant, identifiant de transaction | Contrat ; obligation légale | Prestataire de paiement | Cameroun | ≥ 10 ans, sans identité après suppression | Webhook non cru : statut relu chez le prestataire |
| A3 | Sécurité et journal d'audit | Détecter les abus, prouver l'intégrité des traces | Utilisateurs, visiteurs | IP, navigateur, actions, appareils connus | Intérêt légitime | Hébergeur | Voir doc 07 | Sessions fermées 30 j ; journal de sécurité 180 j ; audit : [À COMPLÉTER] | Chaîne de hachage et ancrages signés |
| A4 | Consentements et droits | Prouver les consentements, traiter les demandes | Utilisateurs | Type, version, date, IP, demandes | Obligation légale | — | — | Vie du compte | Accès restreint |
| A5 | Assistant du site | Répondre aux visiteurs | Visiteurs | Messages | Intérêt légitime | Fournisseur d'IA | Voir doc 07 | 90 j | Plafonds de coût, pas de donnée d'organisation |
| A6 | Contact et essais | Répondre aux demandes | Prospects | Nom, contact, message | Mesures précontractuelles | E-mail | Voir doc 07 | 3 ans | — |
| A7 | Mesure d'audience | Statistiques de visites | Visiteurs (si consentement) | Page, origine, appareil — sans IP ni identifiant | Consentement | — | — | 13 mois | Agrégation |

## B. Traitements pour le compte des organisations (MABAH = sous-traitant)

L'organisation (responsable) décide des finalités ; MABAH fournit l'outil. Catégories de données et personnes concernées :

| N° | Module | Personnes | Données (exemples) | Sensibilité | Protection particulière |
|---|---|---|---|---|---|
| B1 | Clients et ventes | Clients, prospects | Nom, téléphone, e-mail, NIU, adresse, historique, conversations WhatsApp/Messenger/Instagram | Moyenne | Isolation par organisation, filtre par antenne |
| B2 | Ressources humaines | Employés, candidats | Identité, poste, CNI, date de naissance, urgence, contrats, évaluations | **Élevée** | Accès administrateurs, **chiffrement des identifiants (CNPS, NIU, CNI, compte, téléphone d'urgence)**, registre des accès |
| B3 | Paie | Employés | Salaire, retenues, CNPS, NIU, compte de paiement | **Élevée** | Idem + registre des consultations et exports |
| B4 | Comptabilité, facturation, achats | Clients, fournisseurs | Pièces, écritures, coordonnées | Moyenne | Piste d'audit comptable, verrouillage de période |
| B5 | Assistant IA de l'organisation | Utilisateurs de l'organisation | Questions, contexte résumé de l'organisation (limité par rôle) | Moyenne | Quota, validation humaine des actions |
| B6 | Canaux de messagerie | Clients de l'organisation | Messages, médias, numéros | Moyenne | Jetons chiffrés, médias purgés après 90 jours |

Durées : fixées par l'organisation (historique IA 365 j par défaut, réglable de 30 j à 10 ans ; journal de webhooks 90 j ; fil d'activité 730 j ; journal des agents IA 365 j). Fin de contrat : suppression complète de l'organisation sur demande de son propriétaire.

## C. Mesures techniques et organisationnelles communes

Voir le document 09 (politique de sécurité). Registre mis à jour à chaque nouveau traitement ou changement de sous-traitant.
