#!/usr/bin/env node
/* Renommage « Brij-IA » -> « MABAH » : codemod REJOUABLE et IDEMPOTENT (le même fichier est utilisé dans le serveur et dans le site).

   Usage (depuis la racine du dépôt, serveur ou site : le mode est détecté tout seul) :
     node scripts/rename-brand.mjs --dry-run            liste les remplacements, ne modifie rien
     node scripts/rename-brand.mjs                      applique (relancé une 2e fois : « aucun changement »)
     node scripts/rename-brand.mjs --check              échoue (code 1) s'il reste une occurrence hors liste blanche
     node scripts/rename-brand.mjs --inventory out.md   écrit l'inventaire classé (à lancer AVANT d'appliquer)
   Options : --root <dossier>  --verbose

   Principe : chaque fichier texte suivi par git passe par la MÊME suite de règles. Comme les textes français servent de clés aux
   dictionnaires EN/DE/ES (src/i18n/*), une clé du code et la même clé du dictionnaire reçoivent exactement le même remplacement
   (les règles ne dépendent que du texte voisin, jamais du fichier) : les traductions ne cassent pas.
   La liste blanche (URL techniques, jeton Search Console, identifiants de données existantes, historique) est masquée pendant les
   remplacements puis restituée telle quelle. Détails et mode d'emploi : docs/renommage-mabah.md. */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const NEW = 'MABAH';
export const NEW_AI = 'MABAH IA';

/* ---------- Fichiers ignorés (historique : on ne réécrit pas le passé) ---------- */
export const SKIP_PATHS = [
  /(^|\/)node_modules\//, /(^|\/)dist\//, /(^|\/)\.git\//,
  /^docs\/fusion\//,                         // rapports et journaux de déploiement de la fusion (historique)
  /(^|\/)TESTS[^/]*\.txt$/,                  // anciens journaux de tests
  /^src\/migrations\//,                      // historique des migrations : jamais modifié (append-only)
  /^docs\/(mise-en-ligne-mabah|fusion-mabah-resultats)\.md$/,      // procédure de mise en ligne et résultats de la fusion : citent l'ancien nom (redirection, alias, message aux clients)
  /^docs\/renommage-mabah/,                  // la documentation du renommage cite évidemment l'ancien nom
  /^scripts\/rename-brand\.mjs$/,            // ce script
  /^scripts\/test-no-legacy-brand\.(js|mjs)$/, // le test de la liste blanche
  /^src\/lib\/legacy-keys\.js$/,             // lecture des anciennes clés de stockage (migration douce) : doit garder l'ancien nom
  /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|otf|mp4|webm|mp3|wav|zip|gz|pdf|db|sqlite|lock)$/i,
  /^package-lock\.json$/,
];

/* ---------- Liste blanche : texte conservé tel quel (masqué pendant les règles) ---------- */
export const WHITELIST = [
  { id: 'ancienne-adresse', re: /"value": "brij-ia\.vercel\.app"|legacyUrls: \['https:\/\/brij-ia\.vercel\.app'\]/g, why: 'ANCIENNE adresse du site (brij-ia.vercel.app) : redirigée vers https://mabah.vercel.app (vercel.json, par l\'hôte) et acceptée comme origine pendant la transition (product.js > legacyUrls)' },
  { id: 'chemin-local', re: /video-brij-ia-problemes/g, why: 'dossier local de l\'ordinateur du fondateur (outil de captures), pas du produit' },
  { id: 'mot-de-passe-demo', re: /Essai-2026-brij(?:-x)?/g, why: 'mot de passe de comptes de démonstration/tests existants' },
  { id: 'sel-chiffrement', re: /brij-ia-fields-v2/g, why: 'sel de dérivation de la clé de chiffrement des champs : le changer rendrait les données illisibles' },
  { id: 'uid-calendrier', re: /@brij-ia(?![\w-])/g, why: 'UID des événements .ics déjà abonnés : le changer créerait des doublons dans les agendas' },
  { id: 'alias-transition', re: /"alternateName":\s*\[?\s*"Brij-IA"(?:\s*,\s*"BRIJ-IA")?\s*\]?/g, why: 'nom alternatif JSON-LD : relie l\'ancien nom au nouveau pour Google (transition)' },
  { id: 'ancien-code-paiement', re: /BRIJ-(?=(?:\\d|NNNNNN|\[))/g, why: 'références de paiement déjà émises (BRIJ-123456) : toujours acceptées en lecture' },
  { id: 'mots-de-passe-faibles', re: /'brijia123'|\bbrijia brij /g, why: 'listes de mots de passe trop courants : l\'ancien nom y reste (le nouveau y est ajouté)' },
  { id: 'mode-marque', re: /(?<=\bmode\s{0,2}(?:===|!==|=|:)\s{0,2})'brij'|MODES = \['brij'|<ModeOpt id="brij"|\{ brij: '|`brij`|\? 'brij' :|\/\/ brij :|ou « Brij »/g, why: 'valeur interne du réglage « mode » de la marque d\'entreprise (brij | powered | white) : enregistrée en base, jamais affichée' },
  { id: 'champs-a-completer', re: /\[À COMPLÉTER[^\]\n]*\]/g, why: 'champs à remplir par le fondateur dans les textes légaux : jamais modifiés, même quand ils citent l\'ancien nom' },
  { id: 'annonce-transition', re: /MABAH est le nouveau nom de Brij-IA[^\n]*/g, why: 'phrase de transition de la base de connaissances de l\'IA : elle doit citer l\'ancien nom pour que MABAH IA sache répondre à « c\'est quoi Brij-IA ? »' },
  { id: 'jetons-reserves', re: /reservedTokens: \['mabah', 'brij'\]/g, why: 'noms interdits pour une entreprise cliente : l\'ancien nom reste réservé (usurpation)' },
  { id: 'ancien-nom-legacy', re: /\(\?:MABAH\|BRIJ\)|\|BRIJ\|/g, why: 'motif qui accepte les anciennes références' },
];

/* ---------- Règles ----------
   « when » limite une règle à certains fichiers ; « to » peut être une fonction. Ordre = priorité. */
const R = [];
const rule = (id, re, to, extra = {}) => R.push({ id, re, to, ...extra });
const FR = 'Brij-IA';
const isIndex = (f) => /(^|\/)index\.html$/.test(f) && !/steve-brandon/.test(f);

/* 0. Adresse publique : https://mabah.vercel.app (l'ancienne brij-ia.vercel.app n'est conservée que pour sa redirection et comme origine acceptée) */
rule('url-site-defaut', /https:\/\/manager-ia-frontend\.vercel\.app/g, 'https://mabah.vercel.app', { when: (f) => /(^|\/)(vite\.config\.js|\.env\.example)$/.test(f), pre: true });
rule('product-ancienne-adresse', /(  publicUrl:[^\n]*\n)/g, "$1  legacyUrls: ['https://brij-ia.vercel.app'], // ancienne adresse : redirigée vers publicUrl (vercel.json) et acceptée comme origine pendant la transition\n", { when: (f) => /(services|lib)\/product\.js$/.test(f), pre: true, unless: /legacyUrls/ });
rule('vercel-redirection-ancien-hote', /("redirects": \[\n)/g, '$1    { "source": "/:path((?!api(?:/|$)).*)", "has": [{ "type": "host", "value": "brij-ia.vercel.app" }], "destination": "https://mabah.vercel.app/:path", "permanent": true },\n', { when: (f) => /(^|\/)vercel\.json$/.test(f), pre: true, unless: /"type": "host"/ });
rule('index-nouvelle-verification', /(<meta name="google-site-verification" content="[^"]+">\n)/g, '$1<!-- Search Console, NOUVELLE propriété (mabah.vercel.app) : collez ici la balise google-site-verification fournie par Google. Gardez aussi la balise ci-dessus (ancienne propriété). -->\n', { when: isIndex, pre: true, unless: /NOUVELLE propriété/ });
rule('url-publique', /brij-ia\.vercel\.app/g, 'mabah.vercel.app');

/* 1. Structures de logo texte « Brij<b>-IA</b> » (le logo image porte la marque ; le texte devient MABAH) */
rule('logo-texte-balises', /(?:Brij|BRIJ)<b>-IA<\/b>/g, NEW);
rule('logo-texte-admin', /'BRIJ', h\('b', \{\}, '-IA'\)/g, `'${NEW}'`);
rule('logo-texte-fragments', /logoMarkup: \['Brij', '-IA'\]/g, `logoMarkup: ['${NEW}', '']`, { when: (f) => /product\.js$/.test(f) });

rule('regex-test-ancien-nom', /(?<=\/)Brij(?=\/[a-z]*\.test\()/g, NEW);
rule('doc-brij-seul', /(?<!ou )« Brij »/g, `« ${NEW} » ou « Brij »`);
rule('product-commentaire-logo', /\/\/ logo texte : « Brij » \+ partie accentuée « -IA »/g, '// logo texte (le logo image est public/logo.svg)', { when: (f) => /product\.js$/.test(f) });

/* 2. Fichiers « point central » (product.js) : valeurs par défaut */
rule('product-assistant', /assistantName: 'Brij-IA'/g, `assistantName: '${NEW_AI}'`, { when: (f) => /product\.js$/.test(f) });
rule('product-reserved', /reservedTokens: \['brij'\]/g, "reservedTokens: ['mabah', 'brij']", { when: (f) => /product\.js$/.test(f) });

/* 3. Marque d'entreprise (branche marque-entreprise fusionnée) : les textes « assistant » portent maintenant « MABAH IA » */
rule('marque-assistant-regexp', /new RegExp\('\^\(Demandez à\|Demander à\|Point de situation de\|Alertes de\|Ce que\) ' \+ PRODUCT\.name\.replace/g,
  "new RegExp('^(Demandez à|Demander à|Point de situation de|Alertes de|Ce que) ' + PRODUCT.assistantName.replace", { when: (f) => /(^|\/)brand\.js$/.test(f) });
rule('marque-assistant-remplacement', /if \(ASSISTANT_TEXT\.test\(s\) && out\.includes\(PLATFORM\)\) return out\.split\(PLATFORM\)\.join\(b\.assistantName\);/g,
  'if (ASSISTANT_TEXT.test(s) && out.includes(PRODUCT.assistantName)) return out.split(PRODUCT.assistantName).join(b.assistantName);', { when: (f) => /(^|\/)brand\.js$/.test(f) });

/* 4. Invites de l'IA : le nom de l'assistant est « MABAH IA » et l'IA ne prétend jamais être humaine */
const NOT_HUMAN = 'Tu es une intelligence artificielle : tu ne prétends jamais être une personne ni un humain, et tu dis que tu es une IA si on te le demande.';
rule('prompt-gestion', /Tu es l['’]IA de gestion de Brij-IA : tu aides/g, `Tu es ${NEW_AI}, l'IA de gestion de ${NEW}. ${NOT_HUMAN} Tu aides`, { when: (f) => /workspace-prompts\.js$/.test(f) });
rule('prompt-site', /Tu es l['’]assistant de Brij-IA, une plateforme camerounaise de gestion d['’]activité assistée par l['’]IA\./g,
  `Tu es ${NEW_AI}, l'assistant de ${NEW}, une plateforme camerounaise de gestion d'activité (ERP) assistée par l'IA. ${NOT_HUMAN}`, { when: (f) => /services\/claude\.js$/.test(f) });
rule('prompt-app', /Tu aides un futur client de Brij-IA à préparer/g, `Tu es ${NEW_AI}. ${NOT_HUMAN} Tu aides un futur client de ${NEW} à préparer`, { when: (f) => /services\/claude\.js$/.test(f) });

rule('prompt-vente', /(Tu es l['’]assistant commercial public d['’]une organisation\.)/g, `$1 Tu es une intelligence artificielle : tu ne prétends jamais être une personne ni un humain, et tu le dis clairement si on te le demande.`,
  { when: (f) => /ai\/sales-agent\.js$/.test(f), pre: true, unless: /ne prétends jamais être|jamais prétendre être|never (?:claim|pretend)/i });

/* 5. Adresse publique : une seule constante (src/services/product.js -> publicUrl) au lieu d'un littéral dans le code */
rule('url-prospects', /config\.siteUrl \|\| 'https:\/\/brij-ia\.vercel\.app'/g, "config.siteUrl || require('./product').publicUrl", { when: (f) => /services\/(prospects|claude)\.js$/.test(f), pre: true });

/* 6. Mots de passe trop courants : on AJOUTE le nouveau nom, on garde l'ancien */
rule('mdp-communs', /\bbrijia brij (?!mabah)/g, 'brijia brij mabah mabahia ', { when: (f) => /services\/security\.js$/.test(f), pre: true });

/* 7. Références de paiement : les nouvelles commencent par MABAH- ; les anciennes BRIJ-123456 restent acceptées (liste blanche) */
rule('paiement-prefixe', /'BRIJ-' \+ String\(crypto/g, `'${NEW}-' + String(crypto`, { when: (f) => /routes\/payments\.js$/.test(f), pre: true });
rule('paiement-regex-test', /\|BRIJ-\\d\{6\}\)/g, '|(?:MABAH|BRIJ)-\\d{6})', { when: (f) => /smoke\.js$/.test(f), pre: true });
rule('paiement-regex-test2', /\/\^BRIJ-\\d\{6\}\$\//g, '/^MABAH-\\d{6}$/', { when: (f) => /test-payment-manual\.js$/.test(f), pre: true });
rule('paiement-doc-points', /`BRIJ-…`/g, `\`${NEW}-…\``, { pre: true });
rule('paiement-doc', /\bBRIJ-NNNNNN\b/g, `${NEW}-NNNNNN`, { pre: true });

/* 8. Identifiants techniques renommés SANS risque (pas de donnée persistée) */
rule('id-export', /'brij-ia-export'/g, "'mabah-export'");
rule('id-export-org', /'brij-ia-org-export'/g, "'mabah-org-export'");
rule('id-export-fichier', /mes-donnees-brij-ia(?=[-.$`])/g, 'mes-donnees-mabah');
rule('id-notification-tag', /'brij-acc-'/g, "'mabah-acc-'");
rule('id-plugin-vite', /name: 'brij-(site-url|preload-font)'/g, "name: 'mabah-$1'");
rule('id-evenements', /(['"])brij:(twofa-required|cookies-open|cookies-change)\1/g, '$1mabah:$2$1');
rule('id-demo-projet', /\bP\.brij\b/g, 'P.mabah');
rule('id-demo-projet-cle', /mk\('brij'/g, "mk('mabah'");
rule('id-ancre-profil', /(id="|href="#)brij-ia"/g, '$1mabah"', { when: (f) => /steve-brandon/.test(f) });
/* Clés de stockage du navigateur : renommées, avec lecture de l'ancienne (src/lib/legacy-keys.js) pour ne déconnecter ni redemander rien */
rule('cle-stockage', /(['"`])brij-(cookies|guide-seen|guide-done|2fa-nudge|seen:)/g, '$1mabah-$2');

/* 9. Index.html : titre/description/JSON-LD (nom du site, alias de transition) */
rule('seo-jsonld-nom', /("@type":"SoftwareApplication","@id":"%SITE_URL%\/#software","name":)"Brij-IA"/g, '$1"MABAH","alternateName":["Brij-IA","BRIJ-IA"]', { when: isIndex, pre: true });
rule('seo-jsonld-website', /(<script type="application\/ld\+json">\{"@context":"https:\/\/schema\.org","@type":"SoftwareApplication")/g,
  '<script type="application/ld+json">{"@context":"https://schema.org","@type":"WebSite","@id":"%SITE_URL%/#website","name":"MABAH","alternateName":["Brij-IA","BRIJ-IA"],"url":"%SITE_URL%/","inLanguage":"fr"}</script>\n$1',
  { when: isIndex, pre: true, unless: /"@type":"WebSite"/ });
const SEO_DESC = 'MABAH réunit ventes, stock, factures, comptabilité, paie et équipe dans un seul outil, avec MABAH IA en renfort. Gratuit pour commencer, paiement MTN et Orange Money.';
const SEO_OG = "Ventes, stock, factures, comptabilité, paie et équipe dans un seul outil. MABAH IA répond à vos clients sur WhatsApp : elle propose, vous validez.";
rule('seo-description', /(<meta name="description" content=")Brij-IA répond à vos clients sur WhatsApp[^"]*(")/g, `$1${SEO_DESC}$2`, { when: isIndex, pre: true });
rule('seo-og-description', /(<meta property="og:description" content=")Réponses aux clients sur WhatsApp[^"]*(")/g, `$1${SEO_OG}$2`, { when: isIndex, pre: true });
rule('seo-json-description', /("description":")ERP assisté par l['’]intelligence artificielle : réponses aux clients sur WhatsApp, stock/g, `$1ERP de gestion d'entreprise avec MABAH IA en renfort : ventes, stock`, { when: isIndex, pre: true });
rule('manifest-description', /("description": ")L['’]agent IA qui gère votre activité avec vous : stock, clients, ventes, équipe, comptabilité\./g,
  "$1L'outil de gestion de votre entreprise, avec MABAH IA en renfort : ventes, stock, factures, équipe, comptabilité.", { when: (f) => /manifest\.webmanifest$/.test(f), pre: true });
rule('og-image', /(<meta property="og:image" content="%SITE_URL%)\/video\/poster\.jpg"/g, '$1/assets/og-mabah.png"', { when: isIndex, pre: true });

/* 10. Phrases où le nom désigne l'ASSISTANT IA -> « MABAH IA » (FR, EN, DE, ES) */
const A = NEW_AI;
/* Dictionnaires : les textes dont la CLÉ française parle de l'assistant portent « MABAH IA » dans toutes les langues (le crochet de marque repère le nom de l'assistant dans la valeur traduite) */
rule('ia-dict-lignes', /^(\s*"(?:Demandez à|Demander à|Point de situation de|Alertes de|Ce que Brij-IA a repéré)[^"]*": ")(.*)$/gm, (m, k, v) => k + v.replace(/Brij-IA/g, A), { when: (f) => /^src\/i18n\//.test(f) });
rule('ia-assistant-fr', /(?<![A-Za-z])Assistant Brij-IA\b/g, A);
rule('ia-assistant-en', /\bBrij-IA assistant\b/g, A);
rule('ia-assistant-de', /\bBrij-IA-Assistent(?:in)?\b/g, A);
rule('ia-assistant-es', /\b[Aa]sistente (?:de )?Brij-IA\b/g, A);
rule('ia-lassistant-fr', /\b([Ll])['’]assistant de Brij-IA\b/g, `$1'assistant ${A}`);
rule('ia-lia-fr', /\b[Ll]['’]IA de Brij-IA\b/g, A);
rule('ia-demander', /\b(Demandez|Demander|Interrogez) à Brij-IA\b/g, `$1 à ${A}`);
rule('ia-ask-en', /\b(Ask|ask) Brij-IA\b/g, `$1 ${A}`);
rule('ia-ask-de', /\b(Fragen Sie|Frag|Frage|Fragen) Brij-IA\b/g, `$1 ${A}`);
rule('ia-ask-es', /\b(Pregunte|Pregunta|Preguntar) a Brij-IA\b/g, `$1 a ${A}`);
rule('ia-sections-fr', /\b(Point de situation de|Alertes de|Alerts from|Alertes d['’]) ?Brij-IA\b/g, (m, p) => `${p}${/['’]$/.test(p) ? '' : ' '}${A}`);
rule('ia-ce-que', /\bCe que Brij-IA(?= a repéré)/g, `Ce que ${A}`);

/* 11. Cas général : le produit */
rule('domaine-test', /\bbrij-ia\.(exemple|example)\.com/g, 'mabah.$1.com');
rule('general-casse', /(?<![A-Za-z])BRIJ-IA(?![A-Za-z])/g, NEW);
rule('general', /(?<![A-Za-z])Brij-IA(?![A-Za-z])/g, NEW);
rule('general-espace', /\bBrij IA\b/g, NEW);
rule('general-coquille', /(?<![A-Za-z])(?:Brij-AI|BRIJ-AI|Brij AI)(?![A-Za-z])/g, NEW); // coquille « AI » au lieu de « IA » vue dans des dictionnaires anglais
rule('general-colle', /\bBrijIA\b/g, NEW);
rule('general-minuscule', /(?<![\w./:-])brij-ia(?![\w.-]*\.(?:vercel|onrender))(?![\w])/g, 'mabah'); // identifiants restants en minuscules (les adresses sont masquées)

/* ---------- Ajouts de texte (idempotents : seulement si la phrase n'y est pas déjà) ---------- */
export const APPENDS = [
  { file: 'knowledge/site/faq.md', unless: /nouveau nom de Brij-IA/, text: "\n**MABAH, c'est nouveau ?** MABAH est le nouveau nom de Brij-IA : c'est la même plateforme, avec les mêmes comptes et les mêmes données. Si quelqu'un te parle de « Brij-IA », c'est de MABAH qu'il s'agit ; ton nom à toi est MABAH IA.\n" },
];

/* ---------- Mécanique ---------- */
const MASK = '\u0001';
function mask(text) {
  const store = [];
  let out = text;
  for (const w of WHITELIST) out = out.replace(w.re, (m) => { store.push(m); return `${MASK}${store.length - 1}${MASK}`; });
  return { out, store };
}
const unmask = (text, store) => text.replace(new RegExp(`${MASK}(\\d+)${MASK}`, 'g'), (_, i) => store[Number(i)]);

const lineAt = (text, idx) => text.slice(0, idx).split('\n').length;

/** Applique toutes les règles à un texte. Renvoie { out, hits }. */
export function transform(file, text) {
  const hits = [];
  const applyRules = (src, pre) => {
    let cur = src;
    for (const r of R) {
      if (Boolean(r.pre) !== pre) continue;
      if (r.when && !r.when(file)) continue;
      if (r.unless && r.unless.test(cur)) continue;
      r.re.lastIndex = 0;
      cur = cur.replace(r.re, (...a) => {
        const m = a[0]; const oi = a.findIndex((x, i) => i > 0 && typeof x === 'number'); const off = a[oi];
        const to = typeof r.to === 'function' ? r.to(...a) : r.to.replace(/\$(\d)/g, (_, n) => (a[Number(n)] === undefined ? '' : a[Number(n)]));
        if (to !== m) hits.push({ rule: r.id, line: lineAt(cur, off), before: m.length > 90 ? m.slice(0, 90) + '…' : m, after: to.length > 90 ? to.slice(0, 90) + '…' : to });
        return to;
      });
    }
    return cur;
  };
  // 1) règles qui travaillent sur le texte brut (SEO, constantes, références) ; 2) masque de la liste blanche ; 3) règles générales
  let cur = applyRules(text, true);
  const { out, store } = mask(cur);
  cur = unmask(applyRules(out, false), store);
  return { out: cur, hits };
}

/** Reste-t-il une occurrence de l'ancien nom (hors liste blanche) dans ce texte ? Renvoie les lignes fautives. */
export function leftovers(text) {
  const { out } = mask(text);
  const bad = [];
  out.split('\n').forEach((l, i) => { if (/brij/i.test(l)) bad.push({ line: i + 1, text: l.replace(/\u0001\d+\u0001/g, '·').trim().slice(0, 200) }); });
  return bad;
}

export function listFiles(root) {
  let files;
  try { files = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 }).split('\n').filter(Boolean); }
  catch { files = []; const walk = (d) => { for (const e of fs.readdirSync(path.join(root, d), { withFileTypes: true })) { const p = path.posix.join(d, e.name); if (e.isDirectory()) { if (!/node_modules|\.git|dist/.test(e.name)) walk(p); } else files.push(p); } }; walk('.'); }
  return [...new Set(files)].filter((f) => fs.existsSync(path.join(root, f)));
}
export const skipped = (f) => SKIP_PATHS.some((re) => re.test(f));
function readText(abs) {
  const b = fs.readFileSync(abs);
  if (b.includes(0)) return null;
  return b.toString('utf8');
}

/* ---------- Classement pour l'inventaire ---------- */
const CATS = [
  ['Dictionnaires i18n (EN/DE/ES : clés françaises et valeurs)', /^src\/i18n\//],
  ['Textes légaux (conditions, confidentialité, registre…)', /^src\/legal\/|^docs\/securite\/legal\//],
  ['Page de présentation, pages publiques et profil du fondateur', /^src\/pages\/|^public\/(steve-brandon-tenda|vitrine)\//],
  ['index.html, manifeste, service worker, hors-ligne, SEO', /^index\.html$|^public\/(manifest|sw|offline)|^seo\/|^vite\.config|^vercel\.json/],
  ['Logo / identité visuelle (balises de logo, favicon)', /logo|favicon|Logo|BrandMark/i],
  ['Invites et connaissances de l\'IA', /^src\/ai\/|^src\/services\/claude\.js|^knowledge\//],
  ['E-mails', /services\/(notify|accounts|payments|prospects|feedback)\.js|routes\/auth\.js|^src\/jobs\.js|security\/devices|workspace\/(mail|digest|share|w3|sales-assign|crm)\.js/],
  ['PDF et documents imprimables', /services\/pdf\.js|invoice-doc|adm-report|wms-hu|fiscal\.js/],
  ['WhatsApp / canaux', /relay\.js|waWeb|channels\//],
  ['Administration (interface)', /^admin\//],
  ['Interface de l\'application (composants)', /^src\/(ws|components|privacy|lib)\//],
  ['Tests, scripts et démonstrations', /^scripts\//],
  ['Documentation', /^docs\/|\.md$|^README/],
];
const catOf = (f) => (CATS.find(([, re]) => re.test(f)) || ['Autre code et configuration'])[0];

export function inventory(root) {
  const rows = []; const ignored = [];
  for (const f of listFiles(root)) {
    const abs = path.join(root, f);
    const text = readText(abs);
    if (text === null || !/brij/i.test(text)) continue;
    if (skipped(f)) { const n = text.split('\n').filter((l) => /brij/i.test(l)).length; if (n) ignored.push({ file: f, n }); continue; }
    const lines = text.split('\n');
    // on classe ligne par ligne : on transforme la ligne seule pour savoir si elle est renommée, conservée ou mixte
    lines.forEach((l, i) => {
      if (!/brij/i.test(l)) return;
      const { out, hits } = transform(f, l);
      const left = leftovers(out);
      const kept = WHITELIST.filter((w) => { w.re.lastIndex = 0; return w.re.test(l); }).map((w) => w.id);
      let cls;
      if (!hits.length && kept.length && !left.length) cls = 'CONSERVER';
      else if (hits.length && !left.length) cls = kept.length ? 'RENOMMER (+ partie conservée)' : 'RENOMMER';
      else cls = 'À EXAMINER';
      rows.push({ file: f, line: i + 1, cat: catOf(f), cls, rules: [...new Set(hits.map((h) => h.rule))], kept, text: l.trim().slice(0, 170) });
    });
  }
  return { rows, ignored };
}

function inventoryMarkdown(root, kind) {
  const { rows, ignored } = inventory(root);
  const by = (k) => rows.reduce((a, r) => ((a[r[k]] = (a[r[k]] || 0) + 1), a), {});
  const md = [];
  md.push(`# Inventaire des occurrences de « Brij » : ${kind}`, '', `Généré par \`scripts/rename-brand.mjs --inventory\` sur l'état d'origine du dépôt. ${rows.length} lignes concernées, dans ${new Set(rows.map((r) => r.file)).size} fichiers.`, '');
  md.push('## Synthèse par classe', '', '| Classe | Lignes |', '|---|---|');
  for (const [k, v] of Object.entries(by('cls'))) md.push(`| ${k} | ${v} |`);
  md.push('', '## Synthèse par domaine', '', '| Domaine | Lignes | dont à conserver |', '|---|---|---|');
  for (const [k, v] of Object.entries(by('cat'))) md.push(`| ${k} | ${v} | ${rows.filter((r) => r.cat === k && r.cls === 'CONSERVER').length} |`);
  md.push('', '## Éléments conservés volontairement (liste blanche)', '', '| Motif | Raison |', '|---|---|');
  for (const w of WHITELIST) md.push(`| \`${w.id}\` | ${w.why} |`);
  md.push('', '## Fichiers historiques ignorés (jamais réécrits)', '', '| Fichier | Lignes |', '|---|---|');
  for (const g of ignored) md.push(`| \`${g.file}\` | ${g.n} |`);
  md.push('', '## Détail', '', '| Fichier:ligne | Domaine | Classe | Règles / conservé | Extrait |', '|---|---|---|---|---|');
  for (const r of rows) md.push(`| \`${r.file}:${r.line}\` | ${r.cat.split(' (')[0]} | ${r.cls} | ${[...r.rules, ...r.kept.map((k) => 'conservé:' + k)].join(', ')} | ${r.text.replace(/\|/g, '\\|').replace(/`/g, "'")} |`);
  return md.join('\n') + '\n';
}

/* ---------- Échafaudage : fichiers que le script crée s'ils n'existent pas (base de production) ---------- */
const SERVER_PRODUCT = `'use strict';
// SEUL endroit où le nom du produit par défaut et ses variantes sont écrits pour le code (créé par scripts/rename-brand.mjs).
// Renommer le produit ou changer son adresse = changer ce fichier (et src/lib/product.js côté site).
module.exports = Object.freeze({
  name: '${NEW}',                    // nom du produit affiché par défaut
  shortName: '${NEW}',               // nom court (manifeste, étiquettes)
  assistantName: '${NEW_AI}',        // nom de l'assistant IA
  mailFromName: '${NEW}',            // nom d'expéditeur par défaut des e-mails de la plateforme
  poweredByLabel: 'Propulsé par',    // « Propulsé par <nom> » (mention discrète)
  publicUrl: process.env.SITE_URL || 'https://mabah.vercel.app', // adresse publique par défaut (une seule ligne à changer quand le domaine définitif sera choisi)
  legacyUrls: ['https://brij-ia.vercel.app'], // ancienne adresse : redirigée vers publicUrl (vercel.json) et acceptée comme origine pendant la transition
  reservedTokens: ['mabah', 'brij'], // fragments interdits dans le nom d'une entreprise cliente (usurpation de la plateforme)
});
`;
const SITE_PRODUCT = `/* SEUL endroit où le nom du produit par défaut et ses variantes sont écrits pour le site (créé par scripts/rename-brand.mjs).
   Renommer le produit = changer ce fichier (et src/services/product.js côté serveur). L'adresse publique du site se règle avec SITE_URL (voir vite.config.js). */
export const PRODUCT = Object.freeze({
  name: '${NEW}',                 // nom du produit affiché par défaut
  shortName: '${NEW}',            // nom court
  assistantName: '${NEW_AI}',     // nom de l'assistant IA
  poweredByLabel: 'Propulsé par', // « Propulsé par <nom> »
  publicUrl: 'https://mabah.vercel.app',
  legacyUrls: ['https://brij-ia.vercel.app'], // ancienne adresse (redirigée par vercel.json)
  logoMarkup: ['${NEW}', ''],     // logo texte (le logo image est public/logo.svg)
});
`;
const LEGACY_KEYS = `/* Migration douce des clés de stockage du navigateur : « brij-… » devient « mabah-… » (créé par scripts/rename-brand.mjs).
   Les anciennes valeurs sont COPIÉES (jamais effacées) vers les nouvelles clés au démarrage : personne n'est déconnecté, le choix des cookies
   et les guides déjà vus sont conservés. Ce fichier est la seule exception « Brij » autorisée du code du site. */
const EXACT = [['brij-cookies', 'mabah-cookies'], ['brij-guide-seen', 'mabah-guide-seen'], ['brij-guide-done', 'mabah-guide-done'], ['brij-2fa-nudge', 'mabah-2fa-nudge']];
const PREFIX = [['brij-seen:', 'mabah-seen:']];

function migrate(store) {
  if (!store) return;
  for (const [o, n] of EXACT) if (store.getItem(n) === null && store.getItem(o) !== null) store.setItem(n, store.getItem(o));
  for (let i = 0; i < store.length; i++) {
    const k = store.key(i);
    for (const [o, n] of PREFIX) if (k && k.startsWith(o) && store.getItem(n + k.slice(o.length)) === null) store.setItem(n + k.slice(o.length), store.getItem(k));
  }
}

export function migrateLegacyKeys() {
  for (const get of [() => window.localStorage, () => window.sessionStorage]) {
    try { migrate(get()); } catch { /* stockage indisponible : on continue */ }
  }
}

if (typeof window !== 'undefined') migrateLegacyKeys();
`;
const scaffold = (root, kind, apply, log) => {
  const put = (rel, content) => {
    const abs = path.join(root, rel);
    if (fs.existsSync(abs)) return;
    log(`+ crée ${rel}`);
    if (apply) { fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, content); }
  };
  if (kind === 'serveur') put('src/services/product.js', SERVER_PRODUCT);
  else {
    put('src/lib/product.js', SITE_PRODUCT);
    put('src/lib/legacy-keys.js', LEGACY_KEYS);
    const main = path.join(root, 'src/main.jsx');
    if (fs.existsSync(main)) {
      const t = fs.readFileSync(main, 'utf8');
      if (!/legacy-keys/.test(t)) {
        log("~ src/main.jsx : import './lib/legacy-keys.js' en première ligne d'import");
        if (apply) fs.writeFileSync(main, t.replace(/^(?=import )/m, "import './lib/legacy-keys.js'; // migration douce des clés de stockage (ancien nom -> MABAH)\n"));
      }
    }
  }
};

/* ---------- Programme principal ---------- */
function main() {
  const argv = process.argv.slice(2);
  const flag = (n) => argv.includes(n);
  const val = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
  const root = path.resolve(val('--root') || process.cwd());
  const kind = fs.existsSync(path.join(root, 'vite.config.js')) ? 'site' : 'serveur';
  const dry = flag('--dry-run'); const verbose = flag('--verbose');

  if (val('--inventory')) { fs.mkdirSync(path.dirname(path.resolve(val('--inventory'))), { recursive: true }); fs.writeFileSync(val('--inventory'), inventoryMarkdown(root, kind)); console.log(`Inventaire écrit : ${val('--inventory')}`); return; }

  if (flag('--check')) {
    let bad = 0;
    for (const f of listFiles(root)) {
      if (skipped(f)) continue;
      const t = readText(path.join(root, f)); if (t === null) continue;
      for (const l of leftovers(t)) { bad++; console.log(`${f}:${l.line}: ${l.text}`); }
    }
    console.log(bad ? `\n${bad} occurrence(s) de « Brij » hors liste blanche.` : 'OK : aucune occurrence de « Brij » hors liste blanche.');
    process.exit(bad ? 1 : 0);
  }

  const changed = []; const unresolved = []; let total = 0; const perRule = {};
  const log = (s) => console.log(s);
  scaffold(root, kind, !dry, (s) => { log(s); total++; });
  for (const f of listFiles(root)) {
    if (skipped(f)) continue;
    const abs = path.join(root, f);
    const text = readText(abs); if (text === null) continue;
    const { out, hits } = transform(f, text);
    if (out === text) continue;
    changed.push(f); total += hits.length;
    for (const l of leftovers(out)) unresolved.push(`${f}:${l.line}: ${l.text}`);
    for (const h of hits) { perRule[h.rule] = (perRule[h.rule] || 0) + 1; if (dry && (verbose || perRule[h.rule] <= 3)) log(`${f}:${h.line} [${h.rule}] ${JSON.stringify(h.before)} -> ${JSON.stringify(h.after)}`); }
    if (!dry) fs.writeFileSync(abs, out);
  }
  for (const a of APPENDS) {
    const abs = path.join(root, a.file);
    if (!fs.existsSync(abs)) continue;
    const t = fs.readFileSync(abs, 'utf8');
    if (a.unless.test(t)) continue;
    changed.push(a.file); total++; log(`+ ${a.file} : phrase de transition ajoutée`);
    if (!dry) fs.writeFileSync(abs, t.replace(/\s*$/, '\n') + a.text);
  }
  log(`\nMode ${kind} : ${dry ? 'SIMULATION (rien n\'est modifié)' : 'application'}.`);
  log(`Fichiers ${dry ? 'à modifier' : 'modifiés'} : ${changed.length} · remplacements : ${total}`);
  for (const [k, v] of Object.entries(perRule).sort((a, b) => b[1] - a[1])) log(`  ${String(v).padStart(5)}  ${k}`);
  if (unresolved.length) { log(`\nÀ EXAMINER : ${unresolved.length} ligne(s) gardent « brij » après les règles :`); unresolved.slice(0, 60).forEach((u) => log('  ' + u)); }
  if (!changed.length && !total) log('Aucun changement : le renommage est déjà appliqué.');
  else if (dry) log('(les 3 premiers exemples de chaque règle sont affichés ; --verbose pour tout voir)');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
