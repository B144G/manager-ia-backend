'use strict';
// Lit le fichier .env et rassemble toute la configuration au même endroit.
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT, '.env') });

const env = process.env;
const str = (k, d = '') => (env[k] !== undefined && String(env[k]).trim() !== '' ? String(env[k]).trim() : d);
const int = (k, d) => {
  const n = parseInt(env[k], 10);
  return Number.isFinite(n) ? n : d;
};
const bool = (k, d) => {
  const v = str(k);
  if (!v) return d;
  return ['1', 'true', 'yes', 'oui'].includes(v.toLowerCase());
};
const resolvePath = (p) => (path.isAbsolute(p) ? p : path.join(ROOT, p));

const isProd = str('NODE_ENV') === 'production';

// --- Secret JWT : obligatoire en production ---
let jwtSecret = str('JWT_SECRET');
if (isProd && jwtSecret.length < 16) {
  console.error(
    '\n[ERREUR] JWT_SECRET est obligatoire en production (au moins 16 caractères, idéalement 48+).\n' +
      'Générez-en un avec : node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"\n' +
      'Puis ajoutez-le dans les variables d\'environnement. Le serveur refuse de démarrer sans lui.\n'
  );
  process.exit(1);
}
if (!jwtSecret) {
  jwtSecret = crypto.randomBytes(32).toString('hex');
  console.warn('[AVERTISSEMENT] JWT_SECRET absent : un secret temporaire est utilisé (les connexions sont perdues à chaque redémarrage). OK en développement seulement.');
}

// --- Production : refuser un mot de passe administrateur faible ---
if (isProd && str('ADMIN_PASSWORD') && str('ADMIN_PASSWORD').length < 10) {
  console.error('\n[ERREUR] ADMIN_PASSWORD est trop court pour la production (10 caractères minimum, idéalement 16+).\n');
  process.exit(1);
}
if (isProd && !str('DATA_KEY')) console.warn('[AVERTISSEMENT] DATA_KEY absent : les jetons WhatsApp sont chiffrés avec une clé dérivée de JWT_SECRET. Définissez DATA_KEY (48+ caractères aléatoires) et conservez-la : sans elle, ils deviennent illisibles.');

// --- Cookies ---
let sameSite = str('COOKIE_SAMESITE', 'lax').toLowerCase();
if (!['lax', 'strict', 'none'].includes(sameSite)) sameSite = 'lax';
let cookieSecure = bool('COOKIE_SECURE', isProd);
if (sameSite === 'none') cookieSecure = true; // obligatoire pour les navigateurs

const campayUser = str('CAMPAY_USERNAME');
const campayPass = str('CAMPAY_PASSWORD');

const config = {
  ROOT,
  isProd,
  port: int('PORT', 3000),
  trustProxy: str('TRUST_PROXY', isProd ? '1' : '0'),
  siteUrl: str('SITE_URL'),
  // Inscription avec code par e-mail : 'on', 'off' ou 'auto' (actif dès que l'envoi d'e-mails est configuré).
  signupVerify: str('SIGNUP_VERIFY') || 'auto',
  // PostgreSQL : DATABASE_URL (Neon : adresse « pooled »). DATABASE_URL_UNPOOLED (adresse directe) sert aux migrations si fournie.
  // Pour les tests : DATABASE_URL=pglite://memory (ou pglite:///chemin/dossier), un vrai PostgreSQL embarqué sans installation.
  database: (() => {
    const url = str('DATABASE_URL');
    if (!url) { console.error('[ERREUR] DATABASE_URL manquant. Exemple Neon : postgresql://utilisateur:motdepasse@ep-xxx.eu-central-1.aws.neon.tech/neondb?sslmode=require'); process.exit(1); }
    if (/^pglite:/i.test(url)) { const rest = url.replace(/^pglite:\/\//i, ''); return { driver: 'pglite', pgliteDir: rest && rest !== 'memory' ? resolvePath(rest) : '', poolMax: 1 }; }
    return { driver: 'pg', url, directUrl: str('DATABASE_URL_UNPOOLED') || url, ssl: str('DATABASE_SSL') === 'false' ? false : undefined, poolMax: Math.max(1, parseInt(str('DB_POOL_MAX', '10'), 10) || 10) };
  })(),
  publicDir: path.join(ROOT, 'public'),
  adminDir: path.join(ROOT, 'admin'),

  jwtSecret,
  cookie: { sameSite, secure: cookieSecure },
  allowedOrigins: str('ALLOWED_ORIGINS')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean),

  admin: {
    username: str('ADMIN_USERNAME'),
    password: str('ADMIN_PASSWORD'),
    email: str('ADMIN_EMAIL', 'tendabrandon9@gmail.com'),
    whatsapp: str('ADMIN_WHATSAPP', '237653621388').replace(/\D/g, ''),
  },

  // E-mail par API web (HTTPS) : à utiliser quand l'hébergeur bloque les ports SMTP (plan gratuit de Render). Fournisseur géré : Brevo.
  mailApi: {
    provider: str('MAIL_API', str('BREVO_API_KEY') ? 'brevo' : '').toLowerCase(),
    key: str('MAIL_API_KEY') || str('BREVO_API_KEY'),
    baseUrl: str('MAIL_API_URL', 'https://api.brevo.com/v3').replace(/\/+$/, ''),
  },
  smtp: {
    host: str('SMTP_HOST'),
    port: int('SMTP_PORT', 587),
    user: str('SMTP_USER'),
    pass: str('SMTP_PASS'),
    from: str('SMTP_FROM'),
  },

  whatsapp: {
    phoneId: str('WHATSAPP_PHONE_ID'),
    token: str('WHATSAPP_TOKEN'),
    template: str('WHATSAPP_TEMPLATE', 'nouvelle_notification'),
  },

  meta: {
    verifyToken: str('META_VERIFY_TOKEN'),
    appSecret: str('META_APP_SECRET'),
    pageToken: str('PAGE_ACCESS_TOKEN'),
    appId: str('META_APP_ID'),                              // « Connexion WhatsApp en un clic » (Embedded Signup)
    embeddedConfigId: str('META_EMBEDDED_CONFIG_ID'),       // identifiant de configuration « Facebook Login for Business »
    webhookVerifyToken: str('META_WEBHOOK_VERIFY_TOKEN'),   // jeton de vérification du webhook commun /api/webhooks/whatsapp
    get embeddedEnabled() { return Boolean(this.appId && this.appSecret && this.embeddedConfigId); },
    graphUrl: str('META_GRAPH_URL', 'https://graph.facebook.com/v21.0').replace(/\/+$/, ''), // adresse de l'API Meta (changée seulement pour les tests)
  },
  dataKey: str('DATA_KEY'), // clé de chiffrement des jetons WhatsApp enregistrés (par défaut dérivée de JWT_SECRET)

  // Fournisseur d'IA interchangeable : 'anthropic' (par défaut) ou 'openai' (tout service compatible OpenAI :
  // OpenAI, Mistral, Gemini en mode compatible, Groq, serveur local Ollama…). Les anciennes variables ANTHROPIC_* restent valables.
  ai: (() => {
    const provider = str('AI_PROVIDER', 'anthropic').toLowerCase() === 'openai' ? 'openai' : 'anthropic';
    const a = provider === 'anthropic';
    return {
      provider,
      key: str('AI_API_KEY') || (a ? str('ANTHROPIC_API_KEY') : ''),
      model: str('AI_MODEL') || (a ? str('ANTHROPIC_MODEL', 'claude-sonnet-5-5') : 'gpt-4o-mini'),
      // Modèle plus petit et moins cher pour les tâches simples (assistant du site, agent client). Vide = même modèle.
      modelFast: str('AI_MODEL_FAST'),
      baseUrl: (str('AI_BASE_URL') || (a ? str('ANTHROPIC_BASE_URL', 'https://api.anthropic.com') : 'https://api.openai.com/v1')).replace(/\/+$/, ''),
      cache: str('AI_PROMPT_CACHE', '1') !== '0', // mise en cache des consignes répétées (Anthropic)
      // Services « compatibles OpenAI » : effort de réflexion des modèles qui réfléchissent (minimal, low, medium, high). Vide = réglage du service.
      reasoning: str('AI_REASONING_EFFORT').toLowerCase(),
      timeoutMs: Math.min(Math.max(int('AI_TIMEOUT_MS', 45000), 5000), 120000),
    };
  })(),

  // Transcription des messages vocaux (service compatible OpenAI : OpenAI, Groq…). Vide = désactivée (la dictée du navigateur reste possible).
  stt: {
    key: str('STT_API_KEY'),
    baseUrl: str('STT_BASE_URL', 'https://api.openai.com/v1').replace(/\/+$/, ''),
    model: str('STT_MODEL', 'whisper-1'),
    language: str('STT_LANGUAGE'), // vide = détection automatique (multilingue)
  },

  // Synthèse vocale (réponses en message vocal) : service compatible OpenAI (/audio/speech). Par défaut, la même clé et le même fournisseur que la transcription.
  tts: {
    key: str('TTS_API_KEY') || str('STT_API_KEY'),
    baseUrl: (str('TTS_BASE_URL') || str('STT_BASE_URL', 'https://api.openai.com/v1')).replace(/\/+$/, ''),
    model: str('TTS_MODEL', 'tts-1'),
    voice: str('TTS_VOICE', 'alloy'),
  },
  // Adresse publique (HTTPS) de CE serveur, que Meta peut joindre : sert aux photos, vidéos et voix envoyées sur Messenger et Instagram.
  apiPublicUrl: (str('API_PUBLIC_URL') || str('SITE_URL')).replace(/\/+$/, ''),

  // Espace de travail IA : limites par offre du propriétaire de l'organisation.
  // aiMonth = messages IA par mois pour TOUTE l'organisation (quota commun, remis à zéro le 1er du mois).
  workspaceLimits: {
    Gratuit: { orgs: 1, members: 3, branches: int('WS_BRANCHES_FREE', 1), aiMonth: int('WS_AI_FREE', 40), emailDay: int('MAIL_DAY_FREE', 5) },
    Pro: { orgs: 3, members: 15, branches: 5, aiMonth: int('WS_AI_PRO', 1000), emailDay: int('MAIL_DAY_PRO', 50) },
    'Pro Max': { orgs: 10, members: 100, branches: 50, aiMonth: int('WS_AI_PROMAX', 2000), emailDay: int('MAIL_DAY_PROMAX', 150) },
    'Méga Pro': { orgs: 25, members: 300, branches: 150, aiMonth: int('WS_AI_MEGAPRO', 3500), emailDay: int('MAIL_DAY_MEGAPRO', 300) },
    // « Illimité » = sans plafond pratique, sous réserve d'un usage raisonnable (le quota IA reste un garde-fou de coût).
    'Illimité': { orgs: 999, members: 9999, branches: 999, aiMonth: int('WS_AI_ILLIMITE', 6000), emailDay: int('MAIL_DAY_ILLIMITE', 500) },
  },

  knowledgeDir: resolvePath(str('KNOWLEDGE_DIR', 'knowledge')),

  businessFile: resolvePath(str('BUSINESS_FILE', 'business.json')),
  businessExampleFile: path.join(ROOT, 'business.example.json'),
  handoffSilenceHours: int('HANDOFF_SILENCE_HOURS', 2),
  assistantDailyLimit: int('ASSISTANT_DAILY_LIMIT', 200),

  campay: {
    username: campayUser,
    password: campayPass,
    baseUrl: str('CAMPAY_BASE_URL', 'https://www.campay.net/api').replace(/\/+$/, ''),
    enabled: Boolean(campayUser && campayPass),
  },

  payment: {
    mtn: str('MTN_NUMBER'),
    orange: str('ORANGE_NUMBER'),
    holder: str('PAYMENT_HOLDER_NAME'),
  },

  durationDays: int('PLAN_DURATION_DAYS', 30),
  plans: {
    pro: { id: 'pro', name: 'Pro', priceXAF: int('PRICE_PRO', 50000) },
    promax: { id: 'promax', name: 'Pro Max', priceXAF: int('PRICE_PROMAX', 75000) },
    megapro: { id: 'megapro', name: 'Méga Pro', priceXAF: int('PRICE_MEGAPRO', 100000) },
    illimite: { id: 'illimite', name: 'Illimité', priceXAF: int('PRICE_ILLIMITE', 150000) },
  },
};

module.exports = config;
