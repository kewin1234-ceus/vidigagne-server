# VidiGagne Server v1 — Guide de déploiement

Le serveur tourne déjà en local et toutes les fonctions sont testées.
Pour que l'application y accède depuis les téléphones, il faut l'héberger
en ligne. Voici les options, de la plus simple à la plus pro.

## Option 1 : Render (recommandé pour commencer)
- Coût : **gratuit** (avec mise en veille après inactivité) ou ~7 $/mois en continu
- Étapes :
  1. Créer un compte sur https://render.com
  2. Mettre ce dossier sur GitHub (bouton "New" → "Web Service")
  3. Render détecte le Dockerfile automatiquement
  4. Ajouter un disque persistant monté sur `/app/data` (sinon les vidéos
     et la base sont effacées à chaque redémarrage !)
  5. Noter l'URL publique, ex. `https://vidigagne.onrender.com`

## Option 2 : Railway
- Coût : ~5 $/mois de crédit offert au départ
- https://railway.app → "Deploy from GitHub" → disque persistant sur `/app/data`

## Option 3 : VPS (le plus pro)
- Coût : ~5-6 $/mois (Hetzner, DigitalOcean, OVH)
- `git clone` le dossier, `npm install`, `node server.js` avec pm2
- Avantage : 100 % des revenus à toi, aucune limite

## Après la mise en ligne
1. Copier l'URL publique (ex. `https://vidigagne.onrender.com`)
2. Me la donner : je sors la **v1.20 de l'app** avec écran de
   création de compte / connexion branché sur cette URL
3. Le pseudo unique sera alors vérifié par le serveur (impossible
   que deux personnes aient le même @pseudo)

## Ce que le serveur fait déjà (testé le 2026-10-02)
- Création de compte + connexion (mot de passe chiffré)
- Pseudo unique garanti par la base (erreur 409 si déjà pris)
- Publication de vidéos (300 Mo max)
- Fil d'accueil (Pour toi / Suivis)
- Likes (+1 pièce au créateur, plafond 100/jour)
- Commentaires (+ réponses)
- Abonnements
- Portefeuille : pièces, historique, conversion en dollars (500 pièces = 1 $)
- Recherche (utilisateurs + vidéos)

## Ce qu'il ne fait PAS encore (phase 2+)
- Recommandations personnalisées (algorithme)
- LIVE / streaming
- Modération automatique
- Retraits d'argent réels (MonCash, virement)
- Notifications push
