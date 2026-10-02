// VidiGagne Server v2 — API sociale (comptes, vidéos, likes, commentaires, abonnements, pièces)
// Stockage persistant gratuit :
//   - Base de données : Postgres via DATABASE_URL (ex. Neon), sinon SQLite local (data/vidigagne.db)
//   - Vidéos : Cloudinary via CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET,
//              sinon disque local (data/uploads)
// Démarrage : node server.js  (port 3000 par défaut, PORT=... pour changer)
const express = require('express');
const multer = require('multer');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const PORT = process.env.PORT || 3000;
const USE_PG = !!process.env.DATABASE_URL;
const USE_CLOUDINARY = !!(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET);

// ---------- base de données ----------
let pool = null;   // pg (Postgres)
let lite = null;   // node:sqlite (repli local)
function pgQ(sql) { let i = 0; return sql.replace(/\?/g, () => '$' + (++i)); }

async function initDb() {
  if (USE_PG) {
    const { Pool } = require('pg');
    const u = new URL(process.env.DATABASE_URL);
    u.searchParams.delete('channel_binding'); // non supporté par node-postgres
    pool = new Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });
  } else {
    const { DatabaseSync } = require('node:sqlite');
    const DATA = path.join(__dirname, 'data');
    fs.mkdirSync(DATA, { recursive: true });
    lite = new DatabaseSync(path.join(DATA, 'vidigagne.db'));
  }
  const schema = `
CREATE TABLE IF NOT EXISTS users(
  id ${USE_PG ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
  username TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  pass_hash TEXT NOT NULL,
  pass_salt TEXT NOT NULL,
  avatar TEXT NOT NULL DEFAULT '🙂',
  bio TEXT NOT NULL DEFAULT '',
  coins INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS tokens(
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS videos(
  id ${USE_PG ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
  user_id INTEGER NOT NULL,
  file TEXT NOT NULL,
  desc TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '',
  views INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS likes(
  user_id INTEGER NOT NULL, video_id INTEGER NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY(user_id, video_id)
);
CREATE TABLE IF NOT EXISTS comments(
  id ${USE_PG ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
  video_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  text TEXT NOT NULL,
  reply_to INTEGER,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS follows(
  follower_id INTEGER NOT NULL, followed_id INTEGER NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY(follower_id, followed_id)
);
CREATE TABLE IF NOT EXISTS ledger(
  id ${USE_PG ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
  user_id INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  reason TEXT NOT NULL,
  created_at BIGINT NOT NULL
);`;
  if (USE_PG) { await pool.query(schema); }
  else { lite.exec(schema); }
  // migrations : colonnes d'authentification sociale
  if (USE_PG) {
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS google_id TEXT`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS users_email_uidx ON users(email)`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS users_google_uidx ON users(google_id)`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS users_phone_uidx ON users(phone)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS oauth_sessions(session TEXT PRIMARY KEY, token TEXT NOT NULL, user_id INTEGER NOT NULL, created_at BIGINT NOT NULL)`);
  } else {
    const cols = lite.prepare(`PRAGMA table_info(users)`).all().map(c => c.name);
    for (const c of ['email', 'google_id', 'phone']) {
      if (!cols.includes(c)) lite.exec(`ALTER TABLE users ADD COLUMN ${c} TEXT`);
    }
    lite.exec(`CREATE UNIQUE INDEX IF NOT EXISTS users_email_uidx ON users(email)`);
    lite.exec(`CREATE UNIQUE INDEX IF NOT EXISTS users_google_uidx ON users(google_id)`);
    lite.exec(`CREATE UNIQUE INDEX IF NOT EXISTS users_phone_uidx ON users(phone)`);
    lite.exec(`CREATE TABLE IF NOT EXISTS oauth_sessions(session TEXT PRIMARY KEY, token TEXT NOT NULL, user_id INTEGER NOT NULL, created_at BIGINT NOT NULL)`);
  }
}

// une ligne ou undefined
async function get1(sql, ...params) {
  if (USE_PG) { const r = await pool.query(pgQ(sql), params); return r.rows[0]; }
  return lite.prepare(sql).get(...params);
}
// tableau de lignes
async function allRows(sql, ...params) {
  if (USE_PG) { const r = await pool.query(pgQ(sql), params); return r.rows; }
  return lite.prepare(sql).all(...params);
}
// exécution sans retour
async function runSql(sql, ...params) {
  if (USE_PG) { await pool.query(pgQ(sql), params); return; }
  lite.prepare(sql).run(...params);
}
// INSERT + récupère l'id généré
async function insertId(sql, ...params) {
  if (USE_PG) {
    const r = await pool.query(pgQ(sql) + ' RETURNING id', params);
    return r.rows[0].id;
  }
  const r = lite.prepare(sql).run(...params);
  return Number(r.lastInsertRowid);
}
// INSERT ou ignore si conflit (likes, follows)
async function insertIgnore(sql, ...params) {
  if (USE_PG) {
    const m = sql.match(/INSERT\s+OR\s+IGNORE\s+INTO\s+(\w+)/i);
    const table = m ? m[1] : null;
    const clean = sql.replace(/INSERT\s+OR\s+IGNORE\s+INTO/i, 'INSERT INTO');
    await pool.query(pgQ(clean) + ' ON CONFLICT DO NOTHING', params);
    return;
  }
  lite.prepare(sql).run(...params);
}

// ---------- stockage vidéos ----------
const DATA = path.join(__dirname, 'data');
const UP = path.join(DATA, 'uploads');
if (!USE_CLOUDINARY) fs.mkdirSync(UP, { recursive: true });

let cloudinary = null;
if (USE_CLOUDINARY) {
  cloudinary = require('cloudinary').v2;
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });
}

async function storeVideo(file) {
  const ext = path.extname(file.originalname || '') || '.mp4';
  if (USE_CLOUDINARY) {
    const tmp = path.join(os.tmpdir(), 'vg' + Date.now() + '_' + crypto.randomBytes(6).toString('hex') + ext);
    fs.writeFileSync(tmp, file.buffer);
    try {
      const up = await cloudinary.uploader.upload(tmp, { resource_type: 'video', folder: 'vidigagne' });
      return up.secure_url; // URL publique permanente
    } finally {
      fs.unlink(tmp, () => {});
    }
  }
  const fname = 'v' + Date.now() + '_' + crypto.randomBytes(6).toString('hex') + ext;
  fs.renameSync(file.path, path.join(UP, fname));
  return fname;
}
function fileUrl(f) {
  return /^https?:\/\//.test(f) ? f : '/uploads/' + f;
}

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
async function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer (.+)$/);
  if (!m) return res.status(401).json({ error: 'token requis' });
  const row = await get1('SELECT user_id FROM tokens WHERE token=?', m[1]);
  if (!row) return res.status(401).json({ error: 'token invalide' });
  req.userId = row.user_id;
  next();
}
function pubUser(u) {
  return { id: u.id, username: u.username, name: u.name, avatar: u.avatar, bio: u.bio };
}
async function videoJSON(v, meId) {
  const u = await get1('SELECT * FROM users WHERE id=?', v.user_id);
  const likes = (await get1('SELECT COUNT(*) AS c FROM likes WHERE video_id=?', v.id)).c;
  const cmts = (await get1('SELECT COUNT(*) AS c FROM comments WHERE video_id=?', v.id)).c;
  const liked = meId ? !!(await get1('SELECT 1 FROM likes WHERE user_id=? AND video_id=?', meId, v.id)) : false;
  return {
    id: v.id, desc: v.desc, tags: v.tags,
    url: fileUrl(v.file),
    views: Number(v.views), likes: Number(likes), comments: Number(cmts), liked,
    created_at: Number(v.created_at),
    user: pubUser(u),
  };
}

// ---------- auth ----------
app.post('/api/auth/register', async (req, res) => {
  try {
    let { username, name, password, email } = req.body || {};
    username = (username || '').toLowerCase().trim();
    if (!validUsername(username))
      return res.status(400).json({ error: "pseudo invalide (lettres, chiffres, . _ — 2 à 24)" });
    if (!password || password.length < 4)
      return res.status(400).json({ error: 'mot de passe : 4 caractères minimum' });
    email = (email || '').trim().toLowerCase() || null;
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return res.status(400).json({ error: 'e-mail invalide' });
    const exists = await get1('SELECT 1 FROM users WHERE username=?', username);
    if (exists) return res.status(409).json({ error: 'ce pseudo est déjà pris' }); // unicité serveur
    if (email) {
      const eExists = await get1('SELECT 1 FROM users WHERE email=?', email);
      if (eExists) return res.status(409).json({ error: 'cet e-mail est déjà utilisé' });
    }
    const salt = crypto.randomBytes(16).toString('hex');
    const id = await insertId(
      'INSERT INTO users(username,name,email,pass_hash,pass_salt,created_at) VALUES(?,?,?,?,?,?)',
      username, (name || username).slice(0, 40), email, hashPass(password, salt), salt, now());
    const token = crypto.randomBytes(32).toString('hex');
    await runSql('INSERT INTO tokens(token,user_id,created_at) VALUES(?,?,?)', token, id, now());
    const u = await get1('SELECT * FROM users WHERE id=?', id);
    res.json({ token, user: pubUser(u), coins: u.coins });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const ident = ((req.body || {}).username || (req.body || {}).identifier || (req.body || {}).email || '').toLowerCase().trim();
    const u = await get1('SELECT * FROM users WHERE username=? OR email=?', ident, ident);
    if (!u || hashPass(req.body.password || '', u.pass_salt) !== u.pass_hash)
      return res.status(401).json({ error: 'pseudo ou mot de passe incorrect' });
    const token = crypto.randomBytes(32).toString('hex');
    await runSql('INSERT INTO tokens(token,user_id,created_at) VALUES(?,?,?)', token, u.id, now());
    res.json({ token, user: pubUser(u), coins: u.coins });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});

app.get('/api/auth/me', auth, async (req, res) => {
  const u = await get1('SELECT * FROM users WHERE id=?', req.userId);
  res.json({ user: pubUser(u), coins: u.coins });
});

app.patch('/api/auth/me', auth, async (req, res) => {
  const { name, avatar, bio } = req.body || {};
  await runSql('UPDATE users SET name=COALESCE(?,name), avatar=COALESCE(?,avatar), bio=COALESCE(?,bio) WHERE id=?',
    name ? String(name).slice(0, 40) : null,
    avatar ? String(avatar).slice(0, 8) : null,
    bio ? String(bio).slice(0, 150) : null, req.userId);
  const u = await get1('SELECT * FROM users WHERE id=?', req.userId);
  res.json({ user: pubUser(u) });
});

// ---------- vidéos ----------
const upload = multer({
  storage: USE_CLOUDINARY ? multer.memoryStorage() : multer.diskStorage({ destination: UP }),
  limits: { fileSize: 300 * 1024 * 1024 }, // 300 Mo max
  fileFilter: (req, file, cb) => {
    if (/^video\//.test(file.mimetype)) cb(null, true);
    else cb(new Error('seules les vidéos sont acceptées'));
  },
});

app.post('/api/videos', auth, upload.single('video'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'aucune vidéo reçue' });
    const fname = await storeVideo(req.file);
    const { desc, tags } = req.body || {};
    const id = await insertId(
      'INSERT INTO videos(user_id,file,desc,tags,created_at) VALUES(?,?,?,?,?)',
      req.userId, fname, String(desc || '').slice(0, 500), String(tags || '').slice(0, 300), now());
    // pièces : +10 par publication
    await runSql('UPDATE users SET coins=coins+10 WHERE id=?', req.userId);
    await runSql('INSERT INTO ledger(user_id,amount,reason,created_at) VALUES(?,?,?,?)',
      req.userId, 10, 'publication vidéo #' + id, now());
    const v = await get1('SELECT * FROM videos WHERE id=?', id);
    res.json({ video: await videoJSON(v, req.userId) });
  } catch (e) { res.status(500).json({ error: 'échec du téléversement' }); }
});

app.get('/api/feed', async (req, res) => {
  try {
    const h = req.headers.authorization || '';
    const m = h.match(/^Bearer (.+)$/);
    let meId = null;
    if (m) { const t = await get1('SELECT user_id FROM tokens WHERE token=?', m[1]); if (t) meId = t.user_id; }
    const mode = req.query.mode === 'following' && meId ? 'following' : 'foryou';
    let rows;
    if (mode === 'following') {
      rows = await allRows(
        `SELECT v.* FROM videos v JOIN follows f ON f.followed_id=v.user_id
         WHERE f.follower_id=? ORDER BY v.created_at DESC LIMIT 50`, meId);
    } else {
      rows = await allRows('SELECT * FROM videos ORDER BY created_at DESC LIMIT 50');
    }
    const videos = [];
    for (const v of rows) videos.push(await videoJSON(v, meId));
    res.json({ mode, videos });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});

app.get('/api/videos/:id', async (req, res) => {
  const v = await get1('SELECT * FROM videos WHERE id=?', req.params.id);
  if (!v) return res.status(404).json({ error: 'vidéo introuvable' });
  await runSql('UPDATE videos SET views=views+1 WHERE id=?', v.id);
  v.views = Number(v.views) + 1;
  res.json({ video: await videoJSON(v, null) });
});

// ---------- likes ----------
app.post('/api/videos/:id/like', auth, async (req, res) => {
  try {
    const v = await get1('SELECT * FROM videos WHERE id=?', req.params.id);
    if (!v) return res.status(404).json({ error: 'vidéo introuvable' });
    await insertIgnore('INSERT OR IGNORE INTO likes(user_id,video_id,created_at) VALUES(?,?,?)',
      req.userId, v.id, now());
    // +1 pièce au créateur quand quelqu'un aime (plafond 100/jour)
    const dayStart = new Date().setHours(0, 0, 0, 0);
    const earned = Number((await get1(
      `SELECT COALESCE(SUM(amount),0) AS s FROM ledger
       WHERE user_id=? AND reason LIKE 'like reçu%' AND created_at>=?`, v.user_id, dayStart)).s);
    if (Number(v.user_id) !== Number(req.userId) && earned < 100) {
      await runSql('UPDATE users SET coins=coins+1 WHERE id=?', v.user_id);
      await runSql('INSERT INTO ledger(user_id,amount,reason,created_at) VALUES(?,?,?,?)',
        v.user_id, 1, 'like reçu vidéo #' + v.id, now());
    }
    const likes = Number((await get1('SELECT COUNT(*) AS c FROM likes WHERE video_id=?', v.id)).c);
    res.json({ likes, liked: true });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});

app.delete('/api/videos/:id/like', auth, async (req, res) => {
  await runSql('DELETE FROM likes WHERE user_id=? AND video_id=?', req.userId, req.params.id);
  const likes = Number((await get1('SELECT COUNT(*) AS c FROM likes WHERE video_id=?', req.params.id)).c);
  res.json({ likes, liked: false });
});

// ---------- commentaires ----------
app.get('/api/videos/:id/comments', async (req, res) => {
  const rows = await allRows(
    `SELECT c.*, u.username, u.name, u.avatar FROM comments c
     JOIN users u ON u.id=c.user_id
     WHERE c.video_id=? ORDER BY c.created_at ASC LIMIT 200`, req.params.id);
  res.json({ comments: rows });
});

app.post('/api/videos/:id/comments', auth, async (req, res) => {
  try {
    const text = String((req.body || {}).text || '').trim().slice(0, 500);
    if (!text) return res.status(400).json({ error: 'commentaire vide' });
    const v = await get1('SELECT 1 FROM videos WHERE id=?', req.params.id);
    if (!v) return res.status(404).json({ error: 'vidéo introuvable' });
    const replyTo = (req.body || {}).reply_to || null;
    const id = await insertId(
      'INSERT INTO comments(video_id,user_id,text,reply_to,created_at) VALUES(?,?,?,?,?)',
      req.params.id, req.userId, text, replyTo, now());
    const c = await get1(
      `SELECT c.*, u.username, u.name, u.avatar FROM comments c
       JOIN users u ON u.id=c.user_id WHERE c.id=?`, id);
    res.json({ comment: c });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});

// ---------- abonnements ----------
app.post('/api/follow/:username', auth, async (req, res) => {
  const u = await get1('SELECT * FROM users WHERE username=?', String(req.params.username).toLowerCase());
  if (!u) return res.status(404).json({ error: 'utilisateur introuvable' });
  if (Number(u.id) === Number(req.userId)) return res.status(400).json({ error: 'impossible de se suivre soi-même' });
  await insertIgnore('INSERT OR IGNORE INTO follows(follower_id,followed_id,created_at) VALUES(?,?,?)',
    req.userId, u.id, now());
  res.json({ following: true });
});

app.delete('/api/follow/:username', auth, async (req, res) => {
  const u = await get1('SELECT * FROM users WHERE username=?', String(req.params.username).toLowerCase());
  if (u) await runSql('DELETE FROM follows WHERE follower_id=? AND followed_id=?', req.userId, u.id);
  res.json({ following: false });
});

app.get('/api/users/:username', async (req, res) => {
  try {
    const u = await get1('SELECT * FROM users WHERE username=?', String(req.params.username).toLowerCase());
    if (!u) return res.status(404).json({ error: 'utilisateur introuvable' });
    const vids = await allRows('SELECT * FROM videos WHERE user_id=? ORDER BY created_at DESC', u.id);
    const followers = Number((await get1('SELECT COUNT(*) AS c FROM follows WHERE followed_id=?', u.id)).c);
    const following = Number((await get1('SELECT COUNT(*) AS c FROM follows WHERE follower_id=?', u.id)).c);
    const likes = Number((await get1(
      'SELECT COUNT(*) AS c FROM likes l JOIN videos v ON v.id=l.video_id WHERE v.user_id=?', u.id)).c);
    const videos = [];
    for (const v of vids) videos.push(await videoJSON(v, null));
    res.json({ user: pubUser(u), followers, following, total_likes: likes, videos });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});

// ---------- pièces ----------
app.get('/api/wallet', auth, async (req, res) => {
  const u = await get1('SELECT coins FROM users WHERE id=?', req.userId);
  const hist = await allRows(
    'SELECT amount, reason, created_at FROM ledger WHERE user_id=? ORDER BY id DESC LIMIT 50', req.userId);
  res.json({ coins: u.coins, dollars: (u.coins / 500).toFixed(2), history: hist });
});

// ---------- recherche ----------
app.get('/api/search', async (req, res) => {
  try {
    const q = '%' + String(req.query.q || '').toLowerCase() + '%';
    const users = await allRows(
      'SELECT id,username,name,avatar FROM users WHERE username LIKE ? OR name LIKE ? LIMIT 20', q, q);
    const vids = await allRows(
      'SELECT * FROM videos WHERE LOWER(desc) LIKE ? OR LOWER(tags) LIKE ? ORDER BY created_at DESC LIMIT 20', q, q);
    const videos = [];
    for (const v of vids) videos.push(await videoJSON(v, null));
    res.json({ users, videos });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});

// ---------- Google OAuth ----------
const GOOGLE_OK = () => !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
const GOOGLE_REDIRECT = () => process.env.GOOGLE_REDIRECT_URI || 'https://vidigagne-server.onrender.com/api/auth/google/callback';
const validSession = s => typeof s === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(s);

app.get('/api/auth/google/start', (req, res) => {
  if (!GOOGLE_OK()) return res.status(503).json({ error: 'Google non configuré' });
  const session = (req.query.session || '').toString();
  if (!validSession(session)) return res.status(400).json({ error: 'session invalide' });
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: GOOGLE_REDIRECT(),
    response_type: 'code',
    scope: 'openid email profile',
    state: session,
    prompt: 'select_account',
  });
  res.redirect('https://accounts.google.com/o/oauth2/v2/auth?' + params.toString());
});

app.get('/api/auth/google/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || !validSession(state || '')) return res.status(400).send('Session invalide');
    const tRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: String(code), client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: GOOGLE_REDIRECT(), grant_type: 'authorization_code',
      }),
    });
    const tj = await tRes.json();
    if (!tj.access_token) return res.status(400).send('Échec Google');
    const uRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: 'Bearer ' + tj.access_token },
    });
    const g = await uRes.json();
    if (!g.sub || !g.email) return res.status(400).send('Profil Google incomplet');
    let u = await get1('SELECT * FROM users WHERE google_id=?', g.sub);
    if (!u) {
      const byMail = await get1('SELECT * FROM users WHERE email=?', String(g.email).toLowerCase());
      if (byMail) {
        await runSql('UPDATE users SET google_id=? WHERE id=?', g.sub, byMail.id);
        u = await get1('SELECT * FROM users WHERE id=?', byMail.id);
      } else {
        let base = String(g.email).split('@')[0].toLowerCase().replace(/[^a-z0-9._]/g, '').slice(0, 18) || 'user';
        if (base.length < 2) base = 'user';
        let username = base, n = 0;
        while (await get1('SELECT 1 FROM users WHERE username=?', username)) { n++; username = (base + n).slice(0, 24); }
        const id = await insertId(
          'INSERT INTO users(username,name,email,google_id,pass_hash,pass_salt,created_at) VALUES(?,?,?,?,?,?,?)',
          username, String(g.name || username).slice(0, 40), String(g.email).toLowerCase(), g.sub,
          crypto.randomBytes(16).toString('hex'), crypto.randomBytes(16).toString('hex'), now());
        u = await get1('SELECT * FROM users WHERE id=?', id);
      }
    }
    const token = crypto.randomBytes(32).toString('hex');
    await runSql('INSERT INTO tokens(token,user_id,created_at) VALUES(?,?,?)', token, u.id, now());
    await runSql('INSERT INTO oauth_sessions(session,token,user_id,created_at) VALUES(?,?,?,?)',
      state, token, u.id, now());
    res.send(`<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="font-family:sans-serif;text-align:center;padding:60px 20px"><div style="font-size:64px">✅</div><h2>Connexion réussie !</h2><p>Retourne dans l'application VidiGagne.</p></body></html>`);
  } catch (e) { res.status(500).send('Erreur de connexion Google'); }
});

app.get('/api/auth/google/poll', async (req, res) => {
  try {
    const s = (req.query.session || '').toString();
    await runSql('DELETE FROM oauth_sessions WHERE created_at<?', now() - 600000); // expire 10 min
    if (!validSession(s)) return res.json({ done: false });
    const row = await get1('SELECT token, user_id FROM oauth_sessions WHERE session=?', s);
    if (!row) return res.json({ done: false });
    await runSql('DELETE FROM oauth_sessions WHERE session=?', s); // usage unique
    const u = await get1('SELECT * FROM users WHERE id=?', row.user_id);
    res.json({ done: true, token: row.token, user: pubUser(u), coins: u.coins });
  } catch (e) { res.json({ done: false }); }
});

// ---------- Téléphone (Firebase) ----------
let fbCerts = null, fbCertsAt = 0;
async function verifyFirebaseToken(idToken) {
  const jwt = require('jsonwebtoken');
  if (Date.now() - fbCertsAt > 3600e3) {
    const r = await fetch('https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com');
    if (!r.ok) throw new Error('certs');
    fbCerts = await r.json(); fbCertsAt = Date.now();
  }
  const decoded = jwt.decode(idToken, { complete: true });
  if (!decoded || !decoded.header || !decoded.header.kid) throw new Error('bad token');
  const cert = fbCerts[decoded.header.kid];
  if (!cert) throw new Error('unknown key');
  const payload = jwt.verify(idToken, cert, { algorithms: ['RS256'] });
  const pid = process.env.FIREBASE_PROJECT_ID;
  if (payload.aud !== pid) throw new Error('bad audience');
  if (payload.iss !== 'https://securetoken.google.com/' + pid) throw new Error('bad issuer');
  if (!payload.phone_number) throw new Error('no phone');
  return payload;
}

app.post('/api/auth/phone', async (req, res) => {
  try {
    if (!process.env.FIREBASE_PROJECT_ID) return res.status(503).json({ error: 'téléphone non configuré' });
    const { idToken, username } = req.body || {};
    if (!idToken) return res.status(400).json({ error: 'token manquant' });
    const fb = await verifyFirebaseToken(idToken);
    const phone = fb.phone_number;
    let u = await get1('SELECT * FROM users WHERE phone=?', phone);
    if (!u) {
      let uname = (username || '').toLowerCase().trim();
      if (!validUsername(uname)) {
        const base = 'user' + phone.replace(/\D/g, '').slice(-6);
        uname = base; let n = 0;
        while (await get1('SELECT 1 FROM users WHERE username=?', uname)) { n++; uname = (base + n).slice(0, 24); }
      } else {
        const ex = await get1('SELECT 1 FROM users WHERE username=?', uname);
        if (ex) return res.status(409).json({ error: 'ce pseudo est déjà pris' });
      }
      const id = await insertId(
        'INSERT INTO users(username,name,phone,pass_hash,pass_salt,created_at) VALUES(?,?,?,?,?,?)',
        uname, uname, phone, crypto.randomBytes(16).toString('hex'), crypto.randomBytes(16).toString('hex'), now());
      u = await get1('SELECT * FROM users WHERE id=?', id);
    }
    const token = crypto.randomBytes(32).toString('hex');
    await runSql('INSERT INTO tokens(token,user_id,created_at) VALUES(?,?,?)', token, u.id, now());
    res.json({ token, user: pubUser(u), coins: u.coins });
  } catch (e) { res.status(401).json({ error: 'vérification téléphone échouée' }); }
});

app.use('/uploads', express.static(UP, { maxAge: '7d' }));

app.get('/api/health', (req, res) => res.json({
  ok: true, name: 'VidiGagne Server v2', time: now(),
  db: USE_PG ? 'postgres' : 'sqlite',
  storage: USE_CLOUDINARY ? 'cloudinary' : 'local',
  google: GOOGLE_OK(), phone: !!process.env.FIREBASE_PROJECT_ID,
  firebase: process.env.FIREBASE_PROJECT_ID || null,
  fbKey: process.env.FIREBASE_API_KEY || null,
}));

initDb().then(() => {
  app.listen(PORT, () => console.log(
    `VidiGagne Server v2 sur http://localhost:${PORT} (db=${USE_PG ? 'postgres' : 'sqlite'}, storage=${USE_CLOUDINARY ? 'cloudinary' : 'local'})`));
}).catch(e => { console.error('Échec init DB:', e.message); process.exit(1); });
