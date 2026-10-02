# VidiGagne Server v1 — Documentation API

Base : `http://localhost:3000` (ou l'URL publique après déploiement).
Authentification : header `Authorization: Bearer <token>`.

## Comptes
- `POST /api/auth/register` — `{username, name, password}` → `{token, user, coins}`
  - `username` : 2-24 caractères, lettres/chiffres/._ — **unique** (409 si pris)
- `POST /api/auth/login` — `{username, password}` → `{token, user, coins}`
- `GET /api/auth/me` 🔒 — profil + pièces
- `PATCH /api/auth/me` 🔒 — `{name, avatar, bio}`

## Vidéos
- `POST /api/videos` 🔒 — multipart `video` (fichier) + `desc`, `tags` → +10 pièces
- `GET /api/feed?mode=foryou|following` — fil (suivis = avec token)
- `GET /api/videos/:id` — détail (+1 vue)

## Interactions
- `POST /api/videos/:id/like` 🔒 / `DELETE` — like/unlike (+1 pièce au créateur, max 100/jour)
- `GET /api/videos/:id/comments` — liste
- `POST /api/videos/:id/comments` 🔒 — `{text, reply_to?}`
- `POST /api/follow/:username` 🔒 / `DELETE` — suivre/ne plus suivre
- `GET /api/users/:username` — profil public + vidéos + stats

## Pièces & recherche
- `GET /api/wallet` 🔒 — `{coins, dollars, history}`
- `GET /api/search?q=...` — utilisateurs + vidéos
- `GET /api/health` — état du serveur

🔒 = token requis. 500 pièces = 1 $.
