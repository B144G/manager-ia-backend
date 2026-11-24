# Sous-traitants et transferts de données

*Version 2026-11-16. Liste fondée sur la configuration du produit ; les contrats et régions marqués [À COMPLÉTER] doivent être confirmés auprès de chaque prestataire.*

| Prestataire | Rôle | Données concernées | Localisation du traitement | Encadrement du transfert |
|---|---|---|---|---|
| **Render** | Hébergement de l'application et de l'API | Toutes les données en transit et en mémoire ; journaux techniques | Région choisie dans le déploiement : [À COMPLÉTER : Francfort, Allemagne selon `render.yaml` — à confirmer] ; société américaine | [À COMPLÉTER] |
| **Neon** | Base de données PostgreSQL | Toutes les données stockées | [À COMPLÉTER : région de la base, ex. UE-Centre/Francfort] | [À COMPLÉTER] |
| **Vercel** | Hébergement du site, relais `/api` vers le serveur | Pages, requêtes (adresses IP, en-têtes) | Réseau mondial ; société américaine | [À COMPLÉTER] |
| **Fournisseur d'IA** (Anthropic par défaut ; tout service compatible OpenAI peut être configuré) | Génération des réponses de l'assistant | Messages de l'utilisateur, contexte résumé de l'organisation, pièces jointes soumises | États-Unis [À COMPLÉTER : selon le fournisseur retenu] | [À COMPLÉTER] ; usage pour l'entraînement : [À COMPLÉTER : condition du fournisseur] |
| **Fournisseur de voix** (service compatible OpenAI, optionnel) | Transcription et synthèse des messages vocaux | Fichiers audio | [À COMPLÉTER] | [À COMPLÉTER] |
| **Brevo** (ou serveur SMTP configuré) | Envoi d'e-mails (codes de vérification, réinitialisation, alertes, factures) | Adresse e-mail, contenu du message | France/UE [À COMPLÉTER] | [À COMPLÉTER] |
| **Meta** (WhatsApp Business Platform, Messenger, Instagram) | Messagerie avec les clients de l'organisation (API officielle) | Numéros, messages, médias | États-Unis/Irlande | [À COMPLÉTER] |
| **WhatsApp (liaison par code QR)** | Même usage, par un protocole non officiel | Idem | Idem | Voir conditions de WhatsApp ; risque de restriction du numéro |
| **Campay** | Paiements Mobile Money (MTN, Orange) | Numéro de téléphone, montant, référence | Cameroun | [À COMPLÉTER] |
| **Opérateurs MTN / Orange** | Exécution du paiement | Numéro, montant | Cameroun | — |
| **Google Fonts** (si les polices ne sont pas hébergées localement) | Affichage des polices | Adresse IP du visiteur | États-Unis | [À COMPLÉTER : héberger les polices pour supprimer ce transfert] |

**Services choisis par l'organisation (non sous-traitants de MABAH) :** outils reliés par webhook ou clé d'API (Zapier, Make, n8n, serveur propre). L'organisation en est responsable.

**Changements :** tout ajout ou remplacement est annoncé dans l'application avec [À COMPLÉTER : 30] jours de préavis.

**Principes appliqués aux transferts :** minimisation (contexte IA limité par rôle), chiffrement en transit (HTTPS, connexion SSL à la base), isolation par organisation, aucune vente de données.
