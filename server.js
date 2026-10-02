// VidiGagne Server v1 — API sociale (comptes, vidéos, likes, commentaires, abonnements, pièces)
// Démarrage : node server.js  (port 3000 par défaut, PORT=... pour changer)
const express = require('express');
const multer = require('multer');
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');

const PORT = process.env.PORT || 3000;
const DATA = path.join(__dirname, 'data');
const UP = path.join(DATA, 'uploads');
fs.mkdirSync(UP, { recursive: true });

const db = new DatabaseSync(path.join(DATA, 'vidigagne.db'));
db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  pass_hash TEXT NOT NULL,
  pass_salt TEXT NOT NULL,
  avatar TEXT NOT NULL DEFAULT '🙂',
  bio TEXT NOT NULL DEFAULT '',
  coins INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tokens(
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS videos(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  file TEXT NOT NULL,
  desc TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '',
  views INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS likes(
  user_id INTEGER NOT NULL, video_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(user_id, video_id)
);
CREATE TABLE IF NOT EXISTS comments(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  text TEXT NOT NULL,
  reply_to INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS follows(
  follower_id INTEGER NOT NULL, followed_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(follower_id, followed_id)
);
CREATE TABLE IF NOT EXISTS ledger(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`);

const app = express();
app.use(express.json({ limit: '2mb' }));

// ---------- helpers ----------
const now = () => Date.now();
function hashPass(pw, salt) {
  return crypto.scryptSync(pw, salt, 32).toString('hex');
}
function validUsername(u) {
  return typeof u === 'string' && /^[a-z0-9._]{2,24}$/.test(u);
}
function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer (.+)$/);
  if (!m) return res.status(401).json({ error: 'token requis' });
  const row = db.prepare('SELECT user_id FROM tokens WHERE token=?').get(m[1]);
  if (!row) return res.status(401).json({ error: 'token invalide' });
  req.userId = row.user_id;
  next();
}
function pubUser(u) {
  return { id: u.id, username: u.username, name: u.name, avatar: u.avatar, bio: u.bio };
}
function videoJSON(v, meId) {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(v.user_id);
  const likes = db.prepare('SELECT COUNT(*) c FROM likes WHERE video_id=?').get(v.id).c;
  const cmts = db.prepare('SELECT COUNT(*) c FROM comments WHERE video_id=?').get(v.id).c;
  const liked = meId ? !!db.prepare('SELECT 1 FROM likes WHERE user_id=? AND video_id=?').get(meId, v.id) : false;
  return {
    id: v.id, desc: v.desc, tags: v.tags,
    url: '/uploads/' + v.file,
    views: v.views, likes, comments: cmts, liked,
    created_at: v.created_at,
    user: pubUser(u),
  };
}

// ---------- auth ----------
app.post('/api/auth/register', (req, res) => {
  let { username, name, password } = req.body || {};
  username = (username || '').toLowerCase().trim();
  if (!validUsername(username))
    return res.status(400).json({ error: "pseudo invalide (lettres, chiffres, . _ — 2 à 24)" });
  if (!password || password.length < 4)
    return res.status(400).json({ error: 'mot de passe : 4 caractères minimum' });
  const exists = db.prepare('SELECT 1 FROM users WHERE username=?').get(username);
  if (exists) return res.status(409).json({ error: 'ce pseudo est déjà pris' }); // unicité serveur
  const salt = crypto.randomBytes(16).toString('hex');
  const r = db.prepare(
    'INSERT INTO users(username,name,pass_hash,pass_salt,created_at) VALUES(?,?,?,?,?)'
  ).run(username, (name || username).slice(0, 40), hashPass(password, salt), salt, now());
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO tokens(token,user_id,created_at) VALUES(?,?,?)').run(token, r.lastInsertRowid, now());
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(r.lastInsertRowid);
  res.json({ token, user: pubUser(u), coins: u.coins });
});

app.post('/api/auth/login', (req, res) => {
  const username = ((req.body || {}).username || '').toLowerCase().trim();
  const u = db.prepare('SELECT * FROM users WHERE username=?').get(username);
  if (!u || hashPass(req.body.password || '', u.pass_salt) !== u.pass_hash)
    return res.status(401).json({ error: 'pseudo ou mot de passe incorrect' });
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO tokens(token,user_id,created_at) VALUES(?,?,?)').run(token, u.id, now());
  res.json({ token, user: pubUser(u), coins: u.coins });
});

app.get('/api/auth/me', auth, (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.userId);
  res.json({ user: pubUser(u), coins: u.coins });
});

app.patch('/api/auth/me', auth, (req, res) => {
  const { name, avatar, bio } = req.body || {};
  db.prepare('UPDATE users SET name=COALESCE(?,name), avatar=COALESCE(?,avatar), bio=COALESCE(?,bio) WHERE id=?')
    .run(name ? String(name).slice(0, 40) : null,
         avatar ? String(avatar).slice(0, 8) : null,
         bio ? String(bio).slice(0, 150) : null, req.userId);
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.userId);
  res.json({ user: pubUser(u) });
});

// ---------- vidéos ----------
const upload = multer({
  dest: UP,
  limits: { fileSize: 300 * 1024 * 1024 }, // 300 Mo max
  fileFilter: (req, file, cb) => {
    if (/^video\//.test(file.mimetype)) cb(null, true);
    else cb(new Error('seules les vidéos sont acceptées'));
  },
});

app.post('/api/videos', auth, upload.single('video'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'aucune vidéo reçue' });
  const ext = path.extname(req.file.originalname || '') || '.mp4';
  const fname = 'v' + now() + '_' + crypto.randomBytes(6).toString('hex') + ext;
  fs.renameSync(req.file.path, path.join(UP, fname));
  const { desc, tags } = req.body || {};
  const r = db.prepare(
    'INSERT INTO videos(user_id,file,desc,tags,created_at) VALUES(?,?,?,?,?)'
  ).run(req.userId, fname, String(desc || '').slice(0, 500), String(tags || '').slice(0, 300), now());
  // pièces : +10 par publication (plafond géré côté retrait/quotas plus tard)
  db.prepare('UPDATE users SET coins=coins+10 WHERE id=?').run(req.userId);
  db.prepare('INSERT INTO ledger(user_id,amount,reason,created_at) VALUES(?,?,?,?)')
    .run(req.userId, 10, 'publication vidéo #' + r.lastInsertRowid, now());
  const v = db.prepare('SELECT * FROM videos WHERE id=?').get(r.lastInsertRowid);
  res.json({ video: videoJSON(v, req.userId) });
});

app.get('/api/feed', (req, res) => {
  const meId = (() => {
    const h = req.headers.authorization || '';
    const m = h.match(/^Bearer (.+)$/);
    if (!m) return null;
    const t = db.prepare('SELECT user_id FROM tokens WHERE token=?').get(m[1]);
    return t ? t.user_id : null;
  })();
  const mode = req.query.mode === 'following' && meId ? 'following' : 'foryou';
  let rows;
  if (mode === 'following') {
    rows = db.prepare(
      `SELECT v.* FROM videos v JOIN follows f ON f.followed_id=v.user_id
       WHERE f.follower_id=? ORDER BY v.created_at DESC LIMIT 50`).all(meId);
  } else {
    rows = db.prepare('SELECT * FROM videos ORDER BY created_at DESC LIMIT 50').all();
  }
  res.json({ mode, videos: rows.map(v => videoJSON(v, meId)) });
});

app.get('/api/videos/:id', (req, res) => {
  const v = db.prepare('SELECT * FROM videos WHERE id=?').get(req.params.id);
  if (!v) return res.status(404).json({ error: 'vidéo introuvable' });
  db.prepare('UPDATE videos SET views=views+1 WHERE id=?').run(v.id);
  v.views += 1;
  res.json({ video: videoJSON(v, null) });
});

// ---------- likes ----------
app.post('/api/videos/:id/like', auth, (req, res) => {
  const v = db.prepare('SELECT * FROM videos WHERE id=?').get(req.params.id);
  if (!v) return res.status(404).json({ error: 'vidéo introuvable' });
  db.prepare('INSERT OR IGNORE INTO likes(user_id,video_id,created_at) VALUES(?,?,?)')
    .run(req.userId, v.id, now());
  // +1 pièce au créateur quand quelqu'un aime (plafond 100/jour)
  const dayStart = new Date().setHours(0, 0, 0, 0);
  const earned = db.prepare(
    `SELECT COALESCE(SUM(amount),0) s FROM ledger
     WHERE user_id=? AND reason LIKE 'like reçu%' AND created_at>=?`).get(v.user_id, dayStart).s;
  if (v.user_id !== req.userId && earned < 100) {
    db.prepare('UPDATE users SET coins=coins+1 WHERE id=?').run(v.user_id);
    db.prepare('INSERT INTO ledger(user_id,amount,reason,created_at) VALUES(?,?,?,?)')
      .run(v.user_id, 1, 'like reçu vidéo #' + v.id, now());
  }
  const likes = db.prepare('SELECT COUNT(*) c FROM likes WHERE video_id=?').get(v.id).c;
  res.json({ likes, liked: true });
});

app.delete('/api/videos/:id/like', auth, (req, res) => {
  db.prepare('DELETE FROM likes WHERE user_id=? AND video_id=?').run(req.userId, req.params.id);
  const likes = db.prepare('SELECT COUNT(*) c FROM likes WHERE video_id=?').get(req.params.id).c;
  res.json({ likes, liked: false });
});

// ---------- commentaires ----------
app.get('/api/videos/:id/comments', (req, res) => {
  const rows = db.prepare(
    `SELECT c.*, u.username, u.name, u.avatar FROM comments c
     JOIN users u ON u.id=c.user_id
     WHERE c.video_id=? ORDER BY c.created_at ASC LIMIT 200`).all(req.params.id);
  res.json({ comments: rows });
});

app.post('/api/videos/:id/comments', auth, (req, res) => {
  const text = String((req.body || {}).text || '').trim().slice(0, 500);
  if (!text) return res.status(400).json({ error: 'commentaire vide' });
  const v = db.prepare('SELECT 1 FROM videos WHERE id=?').get(req.params.id);
  if (!v) return res.status(404).json({ error: 'vidéo introuvable' });
  const replyTo = (req.body || {}).reply_to || null;
  const r = db.prepare(
    'INSERT INTO comments(video_id,user_id,text,reply_to,created_at) VALUES(?,?,?,?,?)'
  ).run(req.params.id, req.userId, text, replyTo, now());
  const c = db.prepare(
    `SELECT c.*, u.username, u.name, u.avatar FROM comments c
     JOIN users u ON u.id=c.user_id WHERE c.id=?`).get(r.lastInsertRowid);
  res.json({ comment: c });
});

// ---------- abonnements ----------
app.post('/api/follow/:username', auth, (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE username=?')
    .get(String(req.params.username).toLowerCase());
  if (!u) return res.status(404).json({ error: 'utilisateur introuvable' });
  if (u.id === req.userId) return res.status(400).json({ error: 'impossible de se suivre soi-même' });
  db.prepare('INSERT OR IGNORE INTO follows(follower_id,followed_id,created_at) VALUES(?,?,?)')
    .run(req.userId, u.id, now());
  res.json({ following: true });
});

app.delete('/api/follow/:username', auth, (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE username=?')
    .get(String(req.params.username).toLowerCase());
  if (u) db.prepare('DELETE FROM follows WHERE follower_id=? AND followed_id=?').run(req.userId, u.id);
  res.json({ following: false });
});

app.get('/api/users/:username', (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE username=?')
    .get(String(req.params.username).toLowerCase());
  if (!u) return res.status(404).json({ error: 'utilisateur introuvable' });
  const vids = db.prepare('SELECT * FROM videos WHERE user_id=? ORDER BY created_at DESC').all(u.id);
  const followers = db.prepare('SELECT COUNT(*) c FROM follows WHERE followed_id=?').get(u.id).c;
  const following = db.prepare('SELECT COUNT(*) c FROM follows WHERE follower_id=?').get(u.id).c;
  const likes = db.prepare(
    'SELECT COUNT(*) c FROM likes l JOIN videos v ON v.id=l.video_id WHERE v.user_id=?').get(u.id).c;
  res.json({
    user: pubUser(u), followers, following, total_likes: likes,
    videos: vids.map(v => videoJSON(v, null)),
  });
});

// ---------- pièces ----------
app.get('/api/wallet', auth, (req, res) => {
  const u = db.prepare('SELECT coins FROM users WHERE id=?').get(req.userId);
  const hist = db.prepare(
    'SELECT amount, reason, created_at FROM ledger WHERE user_id=? ORDER BY id DESC LIMIT 50'
  ).all(req.userId);
  res.json({ coins: u.coins, dollars: (u.coins / 500).toFixed(2), history: hist });
});

// ---------- recherche ----------
app.get('/api/search', (req, res) => {
  const q = '%' + String(req.query.q || '').toLowerCase() + '%';
  const users = db.prepare(
    'SELECT id,username,name,avatar FROM users WHERE username LIKE ? OR name LIKE ? LIMIT 20').all(q, q);
  const videos = db.prepare(
    'SELECT * FROM videos WHERE LOWER(desc) LIKE ? OR LOWER(tags) LIKE ? ORDER BY created_at DESC LIMIT 20').all(q, q);
  res.json({ users, videos: videos.map(v => videoJSON(v, null)) });
});

app.use('/uploads', express.static(UP, { maxAge: '7d' }));

app.get('/api/health', (req, res) => res.json({ ok: true, name: 'VidiGagne Server v1', time: now() }));

app.listen(PORT, () => console.log('VidiGagne Server v1 sur http://localhost:' + PORT));
