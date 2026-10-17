'use strict';
// Prépare le serveur en une commande : npm run setup
// Crée le fichier .env à partir de .env.example avec des secrets aléatoires générés sur VOTRE machine (jamais envoyés ailleurs).
// Si .env existe déjà, il n'est JAMAIS modifié.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.join(__dirname, '..');
const target = path.join(root, '.env');
if (fs.existsSync(target)) {
  console.log('Le fichier .env existe déjà : rien n\'a été modifié.');
  process.exit(0);
}
const rnd = (n) => crypto.randomBytes(n).toString('hex');
const adminPass = crypto.randomBytes(15).toString('base64url');
let txt = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
const set = (key, value) => { txt = txt.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${value}`); };
set('JWT_SECRET', rnd(48));
set('DATA_KEY', rnd(32));
set('ADMIN_USERNAME', 'admin');
set('ADMIN_PASSWORD', adminPass);
fs.writeFileSync(target, txt, { mode: 0o600 });
console.log('Fichier .env créé avec des secrets aléatoires.');
console.log('');
console.log('  Administration : http://localhost:3000/admin');
console.log('  Identifiant    : admin');
console.log('  Mot de passe   : ' + adminPass + '   (notez-le maintenant, changez-le dans .env si vous voulez)');
console.log('');
console.log('Ensuite : npm install   puis   npm start');
console.log('Pour l\'IA, ajoutez votre clé dans .env (ANTHROPIC_API_KEY) : saisissez-la vous-même, ne l\'envoyez à personne.');
