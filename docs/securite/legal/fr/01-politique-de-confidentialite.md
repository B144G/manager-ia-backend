# Politique de confidentialité

*Version 2026-11-16 · Dernière mise à jour : 16 novembre 2026*

Cette politique explique quelles données MABAH collecte, pourquoi, combien de temps nous les gardons, à qui elles sont confiées et comment exercer vos droits. Elle s'appuie sur les principes du Règlement général sur la protection des données (RGPD) et sur le droit camerounais applicable, notamment la loi n° 2010/012 du 21 décembre 2010 relative à la cybersécurité et à la cybercriminalité et la loi camerounaise relative à la protection des données à caractère personnel adoptée fin 2024.

## 1. Qui est responsable ?

**MABAH** — [À COMPLÉTER : dénomination sociale, forme juridique, adresse du siège, RCCM, NIU].
Contact « vie privée » : [À COMPLÉTER : adresse e-mail dédiée] · Téléphone/WhatsApp : [À COMPLÉTER].

Deux situations à bien distinguer :

- **Votre compte MABAH** (nom, contact, mot de passe, abonnement, journal de sécurité) : MABAH est **responsable du traitement**.
- **Les données que votre organisation saisit ou reçoit dans MABAH** (clients, employés, fiches de paie, factures, conversations WhatsApp avec vos clients, etc.) : **votre organisation** en est la responsable ; MABAH agit comme **sous-traitant** et ne les utilise que pour fournir le service, selon l'accord de sous-traitance (document 06). Si vous êtes un client ou un employé d'une organisation qui utilise MABAH, adressez vos demandes à cette organisation.

## 2. Quelles données, pourquoi, sur quelle base, combien de temps ?

| Données | Finalité | Base | Durée de conservation |
|---|---|---|---|
| Nom, e-mail ou téléphone, mot de passe (stocké **haché**, jamais en clair), offre et dates d'abonnement, centres d'intérêt, progression | Créer et gérer votre compte, fournir le service | Contrat | Tant que le compte existe ; effacé/anonymisé dans les 14 jours suivant votre demande de suppression (délai de réflexion modifiable par vous) |
| Références de paiement (référence, opérateur, numéro de téléphone Mobile Money, montant, identifiant de transaction) | Encaisser et prouver les paiements, facturer | Contrat ; obligation légale | Au moins 10 ans (obligations comptables) ; **sans votre identité** après suppression de compte |
| Journal de sécurité : adresse IP, navigateur, dates de connexion, appareils connus, sessions ouvertes, actions sensibles | Protéger votre compte et la plateforme, détecter les abus, prouver l'intégrité des traces | Intérêt légitime (sécurité) ; obligation légale | Sessions fermées : supprimées après 30 jours ; journal de sécurité simple : 180 jours ; journal d'audit : voir la précision ci-dessous* |
| Consentements (type, version du texte, date, adresse IP) | Prouver ce que vous avez accepté | Obligation légale / intérêt légitime | Tant que le compte existe (y compris anonymisé : seul le lien avec votre identité disparaît) |
| Messages à l'assistant IA du site (sans compte) | Répondre à votre question | Intérêt légitime / consentement | 90 jours |
| Messages à l'assistant IA de l'espace de travail | Répondre, tenir l'historique de discussion | Contrat | 365 jours par défaut (réglable par l'organisation : 30 jours à 10 ans) |
| Formulaire de contact, demandes d'essai | Vous répondre | Mesures précontractuelles | 3 ans après réception, puis suppression automatique |
| Compteur de visites (page, origine, type d'appareil — **sans adresse IP, sans cookie, sans identifiant**) | Mesurer l'audience | Consentement (bandeau de cookies) | 13 mois, puis suppression automatique |
| Données des organisations (clients, employés, paie, comptabilité, stock, etc.) | Fournir le service à l'organisation | Contrat (sous-traitance) | Tant que l'organisation les garde ; supprimées avec l'organisation |

\* *Précision sur le journal d'audit :* certaines actions (connexions, changements de rôle, exports, suppressions) sont inscrites dans un journal **chaîné et signé** qui ne peut pas être purgé ligne par ligne sans casser la preuve d'intégrité. Il ne contient pas le contenu de vos données métier, mais des adresses IP et des identifiants. Nous le conservons [À COMPLÉTER : durée choisie, par exemple 12 mois puis archivage chiffré] et étudions une rotation par segments. Le journal de sécurité simple est purgé après 180 jours.

## 3. Intelligence artificielle

L'assistant MABAH IA envoie à un **fournisseur d'IA** (voir document 07) les messages que vous écrivez et, pour répondre avec précision, un résumé limité des données de **votre** organisation (filtré selon votre rôle et votre antenne). Les données d'une organisation ne sont jamais mélangées à celles d'une autre.
MABAH n'utilise pas vos données pour entraîner des modèles. Le fournisseur d'IA applique ses propres conditions de traitement : [À COMPLÉTER : rappeler les engagements du fournisseur retenu].
L'IA **propose** ; les actions sensibles (prix, commandes, paiements, écritures comptables, messages sortants) restent soumises à la validation d'une personne. Une réponse de l'IA peut être inexacte : vérifiez-la avant de décider.

## 4. WhatsApp, Messenger, Instagram

Si votre organisation relie un canal de messagerie, les messages de ses clients transitent par MABAH (et par Meta). Deux modes existent : l'**API officielle** de Meta, et la liaison **par code QR** (« appareils connectés »), qui est une méthode non officielle : ses clés d'accès sont chiffrées dans notre base, et WhatsApp peut restreindre un numéro qui l'utilise. L'organisation est responsable d'informer ses propres clients du traitement de leurs messages.

## 5. À qui sont confiées vos données ?

À nos **sous-traitants techniques** (hébergement, base de données, e-mail, IA, messagerie, paiement), listés avec leur rôle et leur localisation dans le document 07. Nous ne vendons pas vos données et ne les utilisons pas pour de la publicité. Nous pouvons les communiquer à une autorité si une loi ou une décision de justice l'exige.

## 6. Transferts hors du Cameroun

Selon le prestataire, vos données peuvent être traitées en Europe ou aux États-Unis (voir document 07). Chaque transfert est encadré par [À COMPLÉTER : clauses contractuelles types ou mécanisme équivalent, à confirmer prestataire par prestataire].

## 7. Sécurité

Nous appliquons notamment : mots de passe hachés (bcrypt) ; sessions révocables et liste des appareils connectés ; double authentification (TOTP) proposée à tous et exigible par une organisation ; verrouillage progressif après échecs ; alerte en cas de connexion depuis un appareil inconnu ; chiffrement des secrets et des identifiants sociaux des employés dans la base ; journal d'audit chaîné et vérifiable ; isolation stricte entre organisations (testée automatiquement) ; limites de débit et plafonds de coût de l'IA ; sauvegardes chiffrées. Voir la politique de sécurité (document 09). **Aucun système n'est infaillible** : si une violation de données vous concerne, nous vous en informons selon la procédure du document 08.

## 8. Vos droits

Vous pouvez à tout moment : **accéder** à vos données et **les exporter** (Mon compte → Confidentialité → Exporter mes données, format JSON ouvert) ; **rectifier** vos informations ; demander la **suppression** de votre compte (Mon compte → Confidentialité → Supprimer mon compte : vos données personnelles sont **anonymisées** après un délai de réflexion de 14 jours que vous pouvez annuler ; les pièces comptables sont conservées sans votre identité) ; **retirer un consentement** (cookies, communications) sans effet rétroactif ; vous **opposer** ou demander la **limitation** d'un traitement ; demander la **portabilité**.
Nous répondons dans un délai de **30 jours**. Écrivez à [À COMPLÉTER : adresse e-mail vie privée] ; nous pouvons vous demander de prouver votre identité.
Si vous estimez que vos droits ne sont pas respectés, vous pouvez saisir l'autorité camerounaise compétente en matière de protection des données [À COMPLÉTER : nom et coordonnées de l'autorité].

## 9. Enfants

MABAH s'adresse à des professionnels et n'est pas destiné aux personnes de moins de [À COMPLÉTER : 18] ans.

## 10. Cookies

Voir la politique de cookies (document 03).

## 11. Modifications

Nous datons et versionnons chaque version de ce texte. En cas de changement important, nous vous en informons dans l'application et, si nécessaire, nous vous demandons un nouveau consentement. L'historique de vos consentements (date, version) est consultable dans votre compte.
