# Environnement de démonstration (données fictives)

Prérequis : Node 24, Chrome installé, dépendances installées (`npm install` dans le backend et le frontend). Dossier de travail : `/private/tmp/claude-501/demo` (variable `DEMO_DIR`).

1. PostgreSQL jetable : `nohup node scripts/demo/pg.js &` (écrit son adresse dans `$DEMO_DIR/pgurl.txt` et reste actif).
2. Backend (depuis ce dépôt) : `U=$(cat $DEMO_DIR/pgurl.txt); DATABASE_URL=$U DATABASE_URL_UNPOOLED=$U NODE_ENV=development PORT=3100 ADMIN_PASSWORD='DemoAdmin#2026xx' JWT_SECRET=demo-jwt-secret-demo-jwt-secret-1234 DATA_KEY=demo-data-key-demo-data-key-demo-data-key-12 ALLOWED_ORIGINS=http://127.0.0.1:5199 node src/server.js`
3. Frontend : `cd ../manager-ia-frontend && DEV_API_TARGET=http://127.0.0.1:3100 npx vite --port 5199 --host 127.0.0.1`
4. Jeu de données : `node scripts/demo/seed.js` (base VIDE exigée ; compte `demo@exemple.com` / `secret123`, organisation « Boutique Awa », tous les modules). Relancé sur une base déjà remplie, il s'arrête proprement.
5. Vignettes des sous-applications : `node scripts/demo/capture.js` (Chrome headless, port 9333) écrit `public/assets/mods/<id>.jpg` dans le frontend.
6. Pour recommencer : arrêter backend et `pg.js`, relancer `pg.js` (nouvelle base), puis le backend et la graine.
7. Les données sont des EXEMPLES : noms génériques, aucune vraie marque ni vraie personne. Sans clé d'IA, le complément SQL de la graine ajoute les conversations et les commandes « à valider ».
