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

// v2.44-EQB-QR : QR codes côté serveur — lib Nayuki (MIT) vendored dans lib/, sans dépendance npm.
// Chargement défensif : si le fichier manque, les endpoints /api/qr* répondent 503 proprement.
let QRGEN = null;
try { QRGEN = require('./lib/qrcodegen.js'); } catch (e) { QRGEN = null; }

const PORT = process.env.PORT || 3000;
const USE_PG = !!process.env.DATABASE_URL;
const USE_CLOUDINARY = !!(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET);

// ---------- base de données ----------
let pool = null;   // pg (Postgres)
let lite = null;   // node:sqlite (repli local)
function pgQ(sql) { let i = 0; return sql.replace(/\?/g, () => '$' + (++i)); }

// v1.63 : demande de badge vérifié — critères VidiGagne :
// artiste, marque, entreprise, créateur, personnalité... doit prouver son identité
// (pièce d'identité) + son activité (site web / marque représentée / liens).
// FIX v2.42 : la constante était déclarée DANS initDb() → botReviewBadge (niveau module)
// crashait avec "VERIF_CATEGORIES is not defined" et les décisions auto badge ne partaient jamais.
const VERIF_CATEGORIES = ['artiste', 'marque', 'entreprise', 'createur', 'personnalite', 'media', 'autre'];

async function initDb() {
  if (USE_PG) {
    const { Pool } = require('pg');
    const u = new URL(process.env.DATABASE_URL);
    u.searchParams.delete('channel_binding'); // non supporté par node-postgres
    pool = new Pool({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });
  } else {
    const { DatabaseSync } = require('node:sqlite');
    // v2.47-race (Équipe 8/10) : VG_DATA_DIR permet aux bots de concurrence d'utiliser
    // une base SQLite DÉDIÉE (aucun verrou partagé avec les autres instances/bots).
    // Non défini en production → comportement inchangé (data/vidigagne.db).
    const DATA = process.env.VG_DATA_DIR || path.join(__dirname, 'data');
    fs.mkdirSync(DATA, { recursive: true });
    lite = new DatabaseSync(path.join(DATA, 'vidigagne.db'));
    // v2.31 : WAL + busy_timeout — la base locale est ouverte par 2 serveurs (3000/3100)
    // + les helpers de test ; sans WAL, "database is locked" faisait crasher les requêtes.
    try { lite.exec('PRAGMA journal_mode=WAL'); lite.exec('PRAGMA busy_timeout=5000'); } catch (_) {}
  }
  const schema = `
CREATE TABLE IF NOT EXISTS users(
  id ${USE_PG ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
  username TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  first_name TEXT NOT NULL DEFAULT '',
  last_name TEXT NOT NULL DEFAULT '',
  birthdate TEXT NOT NULL DEFAULT '',
  gender TEXT NOT NULL DEFAULT '',
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
-- v2.49 : mise à jour auto de l'app (sans Play Store) — config clé/valeur (ex: apk_url)
CREATE TABLE IF NOT EXISTS app_config(
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT '',
  updated_at BIGINT NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS devices(
  device_id TEXT PRIMARY KEY,
  user_ids TEXT NOT NULL DEFAULT '[]',
  first_seen BIGINT NOT NULL,
  last_seen BIGINT NOT NULL,
  flagged INTEGER NOT NULL DEFAULT 0
);
-- v2.41 : alertes anti-fraude (vues suspectes, vélocité de likes, vélocité IP, multi-comptes)
CREATE TABLE IF NOT EXISTS fraud_alerts(
  id ${USE_PG ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
  type TEXT NOT NULL,
  user_id INTEGER,
  ip TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL
);
-- v2.41 : réputation IP à l'inscription (fenêtre glissante de 24 h)
CREATE TABLE IF NOT EXISTS ip_reputation(
  ip TEXT PRIMARY KEY,
  accounts_count INTEGER NOT NULL DEFAULT 0,
  window_start BIGINT NOT NULL DEFAULT 0,
  first_seen BIGINT NOT NULL,
  last_seen BIGINT NOT NULL,
  flagged INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS videos(
  id ${USE_PG ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
  user_id INTEGER NOT NULL,
  file TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
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
);
CREATE TABLE IF NOT EXISTS stories(
  id ${USE_PG ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
  user_id INTEGER NOT NULL,
  file TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS gifts(
  id ${USE_PG ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
  from_id INTEGER NOT NULL,
  to_id INTEGER NOT NULL,
  video_id INTEGER,
  gift TEXT NOT NULL,
  cost INTEGER NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS playlists(
  id ${USE_PG ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS playlist_items(
  playlist_id INTEGER NOT NULL,
  video_id INTEGER NOT NULL,
  pos INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(playlist_id, video_id)
);
CREATE TABLE IF NOT EXISTS comment_likes(
  comment_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY(comment_id, user_id)
);
CREATE TABLE IF NOT EXISTS withdrawals(
  id ${USE_PG ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
  user_id INTEGER NOT NULL,
  coins INTEGER NOT NULL,
  usd REAL NOT NULL,
  method TEXT NOT NULL,
  account TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS lives(
  id ${USE_PG ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
  user_id INTEGER NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  started_at BIGINT NOT NULL,
  ended_at BIGINT,
  viewers INTEGER NOT NULL DEFAULT 0,
  live_type TEXT NOT NULL DEFAULT 'guests',
  likes INTEGER NOT NULL DEFAULT 0,
  shares INTEGER NOT NULL DEFAULT 0,
  max_guests INTEGER NOT NULL DEFAULT 8
);
CREATE TABLE IF NOT EXISTS fund_deposits(
  id ${USE_PG ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
  amount_usd REAL NOT NULL,
  creators_share_usd REAL NOT NULL,
  period TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS fund_earnings(
  id ${USE_PG ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
  deposit_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  views BIGINT NOT NULL,
  amount_usd REAL NOT NULL,
  coins INTEGER NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS fund_applications(
  id ${USE_PG ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
  user_id INTEGER UNIQUE NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at BIGINT NOT NULL,
  decided_at BIGINT,
  note TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS id_verifications(
  id ${USE_PG ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
  user_id INTEGER UNIQUE NOT NULL,
  country TEXT NOT NULL,
  doc_type TEXT NOT NULL,
  doc_front TEXT NOT NULL,
  doc_back TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  reviewed_at BIGINT,
  reviewed_by TEXT DEFAULT '',
  review_reason TEXT DEFAULT '',
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS video_views(
  id ${USE_PG ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
  video_id INTEGER NOT NULL,
  viewer_id INTEGER,
  ip TEXT NOT NULL DEFAULT '',
  ad_shown INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS ad_reward_claims(
  id ${USE_PG ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
  user_id INTEGER NOT NULL,
  ip TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS watch_rewards(
  video_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  day TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY(video_id, user_id, day)
);
CREATE TABLE IF NOT EXISTS like_rewards(
  liker_id INTEGER NOT NULL,
  video_id INTEGER NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY(liker_id, video_id)
);
CREATE TABLE IF NOT EXISTS login_streaks(
  user_id INTEGER PRIMARY KEY,
  streak INTEGER NOT NULL DEFAULT 0,
  last_day TEXT NOT NULL DEFAULT '',
  updated_at BIGINT NOT NULL
);
-- v2.48 SPEC-06 : séries d'amitié 🔥 (échange bidirectionnel entre deux amis)
CREATE TABLE IF NOT EXISTS friendship_streaks(
  user_a INTEGER NOT NULL,
  user_b INTEGER NOT NULL,
  streak INTEGER NOT NULL DEFAULT 0,
  last_day TEXT NOT NULL DEFAULT '',
  updated_at BIGINT NOT NULL,
  PRIMARY KEY(user_a, user_b)
);
CREATE TABLE IF NOT EXISTS quest_claims(
  user_id INTEGER NOT NULL,
  quest_key TEXT NOT NULL,
  day TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY(user_id, quest_key, day)
);
CREATE TABLE IF NOT EXISTS coin_transfers(
  id ${USE_PG ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
  from_id INTEGER NOT NULL,
  to_id INTEGER NOT NULL,
  coins INTEGER NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS ad_daily(
  day TEXT PRIMARY KEY,
  points_distributed INTEGER NOT NULL DEFAULT 0,
  ad_revenue_usd REAL NOT NULL DEFAULT 0,
  point_value_usd REAL,
  computed_at BIGINT
);
CREATE TABLE IF NOT EXISTS payment_methods(
  id ${USE_PG ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
  user_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  account TEXT NOT NULL,
  verified INTEGER NOT NULL DEFAULT 0,
  paypal_payer_id TEXT,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS receipts(
  id ${USE_PG ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
  withdrawal_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  receipt_no TEXT NOT NULL,
  coins INTEGER NOT NULL,
  usd REAL NOT NULL,
  method TEXT NOT NULL,
  account TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  email_status TEXT NOT NULL DEFAULT 'pending',
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS conversations(
  id ${USE_PG ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
  user1_id INTEGER NOT NULL,
  user2_id INTEGER NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS conv_pair_uidx ON conversations(user1_id, user2_id);
CREATE TABLE IF NOT EXISTS messages(
  id ${USE_PG ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
  conversation_id INTEGER NOT NULL,
  sender_id INTEGER NOT NULL,
  text TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS conversation_reads(
  conversation_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  last_read_at BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY(conversation_id, user_id)
);
CREATE TABLE IF NOT EXISTS conversation_mutes(
  conversation_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY(conversation_id, user_id)
);
CREATE TABLE IF NOT EXISTS polls(
  id ${USE_PG ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
  video_id INTEGER UNIQUE NOT NULL,
  question TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS poll_options(
  id ${USE_PG ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
  poll_id INTEGER NOT NULL,
  text TEXT NOT NULL,
  votes INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS poll_votes(
  poll_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  option_id INTEGER NOT NULL,
  PRIMARY KEY(poll_id, user_id)
);
CREATE TABLE IF NOT EXISTS notifications(
  id ${USE_PG ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
  user_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  actor_id INTEGER,
  video_id INTEGER,
  comment_id INTEGER,
  text TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS activities(
  id ${USE_PG ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
  user_id INTEGER NOT NULL,
  icon TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS notif_user_idx ON notifications(user_id, created_at);
CREATE TABLE IF NOT EXISTS reports(
  id ${USE_PG ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
  reporter_id INTEGER NOT NULL,
  target_type TEXT NOT NULL,
  target_id INTEGER NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at BIGINT NOT NULL
);
-- modération v2.39 : appels contre une sanction + file de modération auto
CREATE TABLE IF NOT EXISTS appeals(
  id ${USE_PG ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
  user_id INTEGER NOT NULL,
  report_id INTEGER NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at BIGINT NOT NULL,
  decided_at BIGINT
);
CREATE TABLE IF NOT EXISTS mod_queue(
  id ${USE_PG ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
  target_type TEXT NOT NULL,
  target_id INTEGER NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS collections(
  id ${USE_PG ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  is_private INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS collection_items(
  collection_id INTEGER NOT NULL,
  video_id INTEGER NOT NULL,
  added_at BIGINT NOT NULL,
  PRIMARY KEY(collection_id, video_id)
);
CREATE TABLE IF NOT EXISTS collection_shares(
  id ${USE_PG ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
  collection_id INTEGER NOT NULL,
  owner_id INTEGER NOT NULL,
  share_code TEXT NOT NULL UNIQUE,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS reposts(
  user_id INTEGER NOT NULL,
  video_id INTEGER NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY(user_id, video_id)
);
CREATE TABLE IF NOT EXISTS blocks(
  user_id INTEGER NOT NULL,
  blocked_id INTEGER NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY(user_id, blocked_id)
);
CREATE TABLE IF NOT EXISTS hidden_videos(
  user_id INTEGER NOT NULL,
  video_id INTEGER NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY(user_id, video_id)
);
CREATE TABLE IF NOT EXISTS watch_history(
  user_id INTEGER NOT NULL,
  video_id INTEGER NOT NULL,
  watched_at BIGINT NOT NULL,
  PRIMARY KEY(user_id, video_id)
);
CREATE TABLE IF NOT EXISTS story_views(
  story_id INTEGER NOT NULL,
  viewer_id INTEGER NOT NULL,
  viewed_at BIGINT NOT NULL,
  PRIMARY KEY(story_id, viewer_id)
);
CREATE TABLE IF NOT EXISTS live_chat(
  id ${USE_PG ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
  live_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  text TEXT NOT NULL,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS live_summaries(
  id ${USE_PG ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
  live_id INTEGER NOT NULL UNIQUE,
  user_id INTEGER NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  started_at BIGINT NOT NULL,
  ended_at BIGINT NOT NULL,
  duration_s INTEGER NOT NULL DEFAULT 0,
  peak_viewers INTEGER NOT NULL DEFAULT 0,
  unique_viewers INTEGER NOT NULL DEFAULT 0,
  likes INTEGER NOT NULL DEFAULT 0,
  shares INTEGER NOT NULL DEFAULT 0,
  chat_total INTEGER NOT NULL DEFAULT 0,
  coins_earned INTEGER NOT NULL DEFAULT 0,
  usd_earned REAL NOT NULL DEFAULT 0,
  withdrawn_usd REAL NOT NULL DEFAULT 0,
  exchanged_usd REAL NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS notif_campaigns(
  id ${USE_PG ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
  type TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  day TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'scheduled',
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS notif_queue(
  id ${USE_PG ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
  campaign_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  scheduled_at BIGINT NOT NULL,
  sent_at BIGINT DEFAULT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_nq_due ON notif_queue(scheduled_at, sent_at);
CREATE TABLE IF NOT EXISTS live_viewers(
  live_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY(live_id, user_id)
);
CREATE TABLE IF NOT EXISTS live_taps(
  live_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  tap_count INTEGER NOT NULL DEFAULT 0,
  window_start BIGINT NOT NULL,
  last_tap_at BIGINT NOT NULL DEFAULT 0,
  intervals TEXT NOT NULL DEFAULT '',
  blocked_until BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY(live_id, user_id)
);
CREATE TABLE IF NOT EXISTS live_signals(
  id ${USE_PG ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
  live_id INTEGER NOT NULL,
  to_user_id INTEGER,
  from_user_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS live_sig_idx ON live_signals(live_id, id);
CREATE TABLE IF NOT EXISTS live_guests(
  id ${USE_PG ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
  live_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  username TEXT NOT NULL DEFAULT '',
  avatar TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at BIGINT NOT NULL,
  UNIQUE(live_id, user_id)
);
CREATE INDEX IF NOT EXISTS live_guests_idx ON live_guests(live_id, status);
-- ==================== v2.38 : lives programmés ====================
CREATE TABLE IF NOT EXISTS live_scheduled(
  id ${USE_PG ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
  user_id INTEGER NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  scheduled_at BIGINT NOT NULL,
  notified INTEGER NOT NULL DEFAULT 0,
  started_live_id INTEGER,
  cancelled INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS live_sched_idx ON live_scheduled(user_id, scheduled_at);
-- ==================== v2.38 : tournois PK ====================
CREATE TABLE IF NOT EXISTS pk_tournaments(
  id ${USE_PG ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
  creator_id INTEGER NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  winner_id INTEGER,
  reward_coins INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL,
  finished_at BIGINT
);
CREATE TABLE IF NOT EXISTS pk_matches(
  id ${USE_PG ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
  tournament_id INTEGER NOT NULL,
  round TEXT NOT NULL DEFAULT 'semi1',
  player1_id INTEGER,
  player2_id INTEGER,
  winner_id INTEGER,
  player1_score INTEGER NOT NULL DEFAULT 0,
  player2_score INTEGER NOT NULL DEFAULT 0,
  live_id INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS pk_match_idx ON pk_matches(tournament_id, round);
-- ==================== v2.38 : Q&R live ====================
CREATE TABLE IF NOT EXISTS live_questions(
  id ${USE_PG ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
  live_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  username TEXT NOT NULL DEFAULT '',
  question TEXT NOT NULL DEFAULT '',
  answer TEXT NOT NULL DEFAULT '',
  answered_at BIGINT,
  likes INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS live_q_idx ON live_questions(live_id, created_at);
CREATE TABLE IF NOT EXISTS live_gifts(
  id ${USE_PG ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
  live_id INTEGER NOT NULL,
  from_id INTEGER NOT NULL,
  to_id INTEGER NOT NULL,
  gift TEXT NOT NULL,
  cost INTEGER NOT NULL,
  creator_share INTEGER NOT NULL DEFAULT 0,
  platform_share INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS coin_recharges(
  id ${USE_PG ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
  user_id INTEGER NOT NULL,
  method TEXT NOT NULL,
  coins INTEGER NOT NULL,
  amount_usd REAL NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
  status TEXT NOT NULL DEFAULT 'pending',
  paypal_order_id TEXT NOT NULL DEFAULT '',
  details TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL,
  processed_at BIGINT
);
CREATE INDEX IF NOT EXISTS recharge_user_idx ON coin_recharges(user_id, status);
CREATE TABLE IF NOT EXISTS verification_codes(
  id ${USE_PG ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
  identifier TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'email',
  code TEXT NOT NULL,
  expires_at BIGINT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  used INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS vcodes_ident_idx ON verification_codes(identifier);
CREATE TABLE IF NOT EXISTS verified_tokens(
  token TEXT PRIMARY KEY,
  identifier TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  consumed INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sounds(
  id ${USE_PG ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
  user_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  artist TEXT NOT NULL DEFAULT '',
  audio_url TEXT NOT NULL,
  use_count INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS sound_favs(
  user_id INTEGER NOT NULL,
  sound_id INTEGER NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY(user_id, sound_id)
);
CREATE TABLE IF NOT EXISTS tips(
  id ${USE_PG ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
  video_id INTEGER NOT NULL,
  from_user_id INTEGER NOT NULL,
  to_user_id INTEGER NOT NULL,
  coins INTEGER NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS creator_subs(
  id ${USE_PG ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
  creator_id INTEGER NOT NULL,
  subscriber_id INTEGER NOT NULL,
  price_coins INTEGER NOT NULL,
  started_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS csub_active_idx ON creator_subs(creator_id, subscriber_id, active);
-- ==================== SPEC-13 : PALIERS D'ABONNEMENT (façon TikTok) ====================
CREATE TABLE IF NOT EXISTS creator_sub_tiers(
  id ${USE_PG ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
  creator_id INTEGER NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  price_coins INTEGER NOT NULL DEFAULT 0,
  perks TEXT NOT NULL DEFAULT '[]',
  badge_emoji TEXT NOT NULL DEFAULT '🏅',
  position INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS csub_tiers_idx ON creator_sub_tiers(creator_id, active, position);
-- ==================== V3 : BOUTIQUE ====================
CREATE TABLE IF NOT EXISTS categories(
  id ${USE_PG ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
  name TEXT UNIQUE NOT NULL
);
CREATE TABLE IF NOT EXISTS products(
  id ${USE_PG ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
  seller_id INTEGER NOT NULL,
  category_id INTEGER,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price_coins INTEGER NOT NULL DEFAULT 0,
  stock INTEGER NOT NULL DEFAULT 0,
  image_url TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS cart(
  user_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  qty INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(user_id, product_id)
);
CREATE TABLE IF NOT EXISTS orders(
  id ${USE_PG ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
  buyer_id INTEGER NOT NULL,
  total_coins INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'completed',
  coupon_code TEXT,
  affiliate_id INTEGER,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS order_items(
  id ${USE_PG ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
  order_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  seller_id INTEGER NOT NULL,
  qty INTEGER NOT NULL,
  price_coins INTEGER NOT NULL,
  fee_coins INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS video_products(
  video_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  PRIMARY KEY(video_id, product_id)
);
CREATE TABLE IF NOT EXISTS shop_reviews(
  id ${USE_PG ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
  product_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  rating INTEGER NOT NULL,
  comment TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL,
  UNIQUE(product_id, user_id)
);
CREATE TABLE IF NOT EXISTS shop_refunds(
  id ${USE_PG ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
  order_id INTEGER NOT NULL,
  buyer_id INTEGER NOT NULL,
  seller_id INTEGER,
  reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at BIGINT NOT NULL,
  decided_at BIGINT
);
CREATE TABLE IF NOT EXISTS coupons(
  id ${USE_PG ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
  code TEXT UNIQUE NOT NULL,
  discount_pct INTEGER NOT NULL DEFAULT 0,
  discount_coins INTEGER NOT NULL DEFAULT 0,
  seller_id INTEGER,
  min_coins INTEGER NOT NULL DEFAULT 0,
  expires_at BIGINT,
  active INTEGER NOT NULL DEFAULT 1,
  max_uses INTEGER NOT NULL DEFAULT 0,
  used_count INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS affiliates(
  id ${USE_PG ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
  user_id INTEGER UNIQUE NOT NULL,
  code TEXT UNIQUE NOT NULL,
  rate_pct INTEGER NOT NULL DEFAULT 5,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS affiliate_sales(
  id ${USE_PG ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
  affiliate_id INTEGER NOT NULL,
  order_id INTEGER NOT NULL,
  commission_coins INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS platform_fees(
  id ${USE_PG ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
  order_id INTEGER NOT NULL,
  coins INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS seller_payouts(
  id ${USE_PG ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
  seller_id INTEGER NOT NULL,
  coins INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'done',
  created_at BIGINT NOT NULL
);
-- ==================== V3 : LIVE SHOPPING ====================
CREATE TABLE IF NOT EXISTS live_products(
  live_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  pinned_at BIGINT NOT NULL,
  PRIMARY KEY(live_id, product_id)
);
-- ==================== V3 : PUBLICITÉ ====================
CREATE TABLE IF NOT EXISTS ad_campaigns(
  id ${USE_PG ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
  user_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  budget_coins INTEGER NOT NULL DEFAULT 0,
  spent_coins INTEGER NOT NULL DEFAULT 0,
  product_id INTEGER,
  status TEXT NOT NULL DEFAULT 'active',
  target TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS ad_events(
  id ${USE_PG ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
  campaign_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
-- ==================== V3 : MODÉRATION AUTO ====================
CREATE TABLE IF NOT EXISTS review_queue(
  id ${USE_PG ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
  item_type TEXT NOT NULL,
  item_id INTEGER NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at BIGINT NOT NULL
);
-- ==================== V12 : GROUPES ====================
CREATE TABLE IF NOT EXISTS chat_groups(
  id ${USE_PG ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
  name TEXT NOT NULL DEFAULT '',
  avatar TEXT NOT NULL DEFAULT '',
  creator_id INTEGER NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS group_members(
  group_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  joined_at BIGINT NOT NULL,
  PRIMARY KEY(group_id, user_id)
);
CREATE TABLE IF NOT EXISTS group_messages(
  id ${USE_PG ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
  group_id INTEGER NOT NULL,
  sender_id INTEGER NOT NULL,
  text TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
-- ==================== V12 : SÉRIES PAYANTES ====================
CREATE TABLE IF NOT EXISTS series(
  id ${USE_PG ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
  creator_id INTEGER NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  cover TEXT NOT NULL DEFAULT '',
  price_coins INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS series_items(
  series_id INTEGER NOT NULL,
  video_id INTEGER NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(series_id, video_id)
);
CREATE TABLE IF NOT EXISTS series_purchases(
  series_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  created_at BIGINT NOT NULL,
  UNIQUE(series_id, user_id)
);
-- ==================== V13 : PROMOTION VIDÉO (TikTok Studio : promouvoir) ====================
CREATE TABLE IF NOT EXISTS video_promos(
  id ${USE_PG ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
  video_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  budget_coins INTEGER NOT NULL DEFAULT 0,
  spent_coins INTEGER NOT NULL DEFAULT 0,
  impressions INTEGER NOT NULL DEFAULT 0,
  clicks INTEGER NOT NULL DEFAULT 0,
  target TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS video_promos_video_idx ON video_promos(video_id);
-- ==================== V13 : COLLABORATIONS (TikTok Studio : vidéo co-signée) ====================
CREATE TABLE IF NOT EXISTS collab_invites(
  id ${USE_PG ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
  video_id INTEGER NOT NULL,
  inviter_id INTEGER NOT NULL,
  invitee_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  revenue_share_pct INTEGER NOT NULL DEFAULT 50,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS collab_invites_video_idx ON collab_invites(video_id);
-- ==================== V12 : ALGO POUR TOI ====================
CREATE TABLE IF NOT EXISTS watch_events(
  id ${USE_PG ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
  user_id INTEGER NOT NULL,
  video_id INTEGER NOT NULL,
  watch_ms INTEGER NOT NULL DEFAULT 0,
  completed INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL
);
-- ==================== V12 : JUMELAGE FAMILIAL ====================
CREATE TABLE IF NOT EXISTS family_codes(
  code TEXT PRIMARY KEY,
  parent_id INTEGER NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS family_links(
  parent_id INTEGER NOT NULL,
  teen_id INTEGER NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY(parent_id, teen_id)
);
CREATE TABLE IF NOT EXISTS family_settings(
  teen_id INTEGER PRIMARY KEY,
  screen_time_min INTEGER NOT NULL DEFAULT 60,
  restricted_mode INTEGER NOT NULL DEFAULT 0,
  dm_policy TEXT NOT NULL DEFAULT 'all'
);
-- v2.43 : journal d'audit des actions sensibles (admin + sécurité compte)
CREATE TABLE IF NOT EXISTS audit_logs(
  id ${USE_PG ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
  actor_id INTEGER,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  ip TEXT,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_logs_action_idx ON audit_logs(action, created_at);
-- v2.43 : challenge anti-abus progressif (IP ayant déclenché ≥3 rate-limits en 1h)
CREATE TABLE IF NOT EXISTS abuse_flags(
  ip TEXT PRIMARY KEY,
  user_id INTEGER,
  score INTEGER NOT NULL DEFAULT 0,
  challenged INTEGER NOT NULL DEFAULT 0,
  challenged_at BIGINT,
  created_at BIGINT NOT NULL,
  last_event_at BIGINT NOT NULL DEFAULT 0
);
-- v2.44-EQC-WH : webhooks créateurs pro (abonnements aux événements)
CREATE TABLE IF NOT EXISTS creator_webhooks(
  id ${USE_PG ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
  user_id INTEGER NOT NULL,
  url TEXT NOT NULL,
  events TEXT NOT NULL DEFAULT '[]',
  secret TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at BIGINT NOT NULL
);
-- v2.44-EQC-WH : journal des envois de webhooks
CREATE TABLE IF NOT EXISTS webhook_deliveries(
  id ${USE_PG ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
  hook_id INTEGER NOT NULL,
  event TEXT NOT NULL DEFAULT '',
  payload TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'queued',
  created_at BIGINT NOT NULL
);
-- v2.44-EQC-WH : clés API publiques développeurs tiers
CREATE TABLE IF NOT EXISTS api_keys(
  id ${USE_PG ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
  user_id INTEGER NOT NULL,
  api_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  scopes TEXT NOT NULL DEFAULT 'read',
  created_at BIGINT NOT NULL,
  last_used BIGINT
);
CREATE INDEX IF NOT EXISTS api_keys_key_idx ON api_keys(api_key);`;
  if (USE_PG) { await pool.query(schema);
    for (const col of ["ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS decided_at BIGINT",
      "ALTER TABLE lives ADD COLUMN IF NOT EXISTS live_type TEXT NOT NULL DEFAULT 'guests'",
      "ALTER TABLE lives ADD COLUMN IF NOT EXISTS likes INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE lives ADD COLUMN IF NOT EXISTS shares INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE lives ADD COLUMN IF NOT EXISTS max_guests INTEGER NOT NULL DEFAULT 8",
      "ALTER TABLE lives ADD COLUMN IF NOT EXISTS duration_s INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE lives ADD COLUMN IF NOT EXISTS peak_viewers INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE lives ADD COLUMN IF NOT EXISTS gifts_total INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE lives ADD COLUMN IF NOT EXISTS chat_total INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE videos ADD COLUMN IF NOT EXISTS shares INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE videos ADD COLUMN IF NOT EXISTS downloads INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE live_summaries ADD COLUMN IF NOT EXISTS withdrawn_usd REAL NOT NULL DEFAULT 0",
      "ALTER TABLE live_summaries ADD COLUMN IF NOT EXISTS exchanged_usd REAL NOT NULL DEFAULT 0"]) {
      try { await pool.query(col); } catch (e) {}
    }
  }
  else { lite.exec(schema); try { lite.exec(`ALTER TABLE users ADD COLUMN gender TEXT DEFAULT ''`); } catch (e) {}
    try { lite.exec(`ALTER TABLE lives ADD COLUMN live_type TEXT NOT NULL DEFAULT 'guests'`); } catch (e) {}
    try { lite.exec(`ALTER TABLE lives ADD COLUMN likes INTEGER NOT NULL DEFAULT 0`); } catch (e) {}
    try { lite.exec(`ALTER TABLE lives ADD COLUMN shares INTEGER NOT NULL DEFAULT 0`); } catch (e) {}
    try { lite.exec(`ALTER TABLE lives ADD COLUMN max_guests INTEGER NOT NULL DEFAULT 8`); } catch (e) {}
    try { lite.exec(`ALTER TABLE lives ADD COLUMN duration_s INTEGER NOT NULL DEFAULT 0`); } catch (e) {}
    try { lite.exec(`ALTER TABLE lives ADD COLUMN peak_viewers INTEGER NOT NULL DEFAULT 0`); } catch (e) {}
    try { lite.exec(`ALTER TABLE lives ADD COLUMN gifts_total INTEGER NOT NULL DEFAULT 0`); } catch (e) {}
    try { lite.exec(`ALTER TABLE lives ADD COLUMN chat_total INTEGER NOT NULL DEFAULT 0`); } catch (e) {}
    try { lite.exec(`ALTER TABLE live_summaries ADD COLUMN withdrawn_usd REAL NOT NULL DEFAULT 0`); } catch (e) {}
    try { lite.exec(`ALTER TABLE live_summaries ADD COLUMN exchanged_usd REAL NOT NULL DEFAULT 0`); } catch (e) {}
    try { lite.exec(`ALTER TABLE videos ADD COLUMN shares INTEGER NOT NULL DEFAULT 0`); } catch (e) {}
    try { lite.exec(`ALTER TABLE videos ADD COLUMN downloads INTEGER NOT NULL DEFAULT 0`); } catch (e) {}
    try { lite.exec(`ALTER TABLE withdrawals ADD COLUMN decided_at BIGINT`); } catch (e) {}
    // FIX 2026-10-04 : parité SQLite — tables/colonnes monétisation+défis (n'existaient que sur Postgres → 500 en local)
    try { lite.exec(`CREATE TABLE IF NOT EXISTS challenges(
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT NOT NULL,
      bonus_coins INTEGER NOT NULL, goal_type TEXT NOT NULL, goal_value INTEGER NOT NULL,
      start_at BIGINT NOT NULL, end_at BIGINT NOT NULL, active INTEGER DEFAULT 1)`); } catch (e) {}
    try { lite.exec(`CREATE TABLE IF NOT EXISTS challenge_claims(
      id INTEGER PRIMARY KEY AUTOINCREMENT, challenge_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
      claimed_at BIGINT NOT NULL, UNIQUE(challenge_id, user_id))`); } catch (e) {}
    try { lite.exec(`CREATE TABLE IF NOT EXISTS ad_impressions(
      id INTEGER PRIMARY KEY AUTOINCREMENT, video_id INTEGER NOT NULL, creator_id INTEGER NOT NULL,
      ad_type TEXT NOT NULL DEFAULT 'interstitial', created_at BIGINT NOT NULL)`); } catch (e) {}
    try { lite.exec(`ALTER TABLE videos ADD COLUMN ad_impressions INTEGER DEFAULT 0`); } catch (e) {}
    try { lite.exec(`ALTER TABLE videos ADD COLUMN ad_revenue_usd REAL DEFAULT 0`); } catch (e) {}
    try { lite.exec(`ALTER TABLE videos ADD COLUMN monetized_views INTEGER DEFAULT 0`); } catch (e) {}
    try { lite.exec(`ALTER TABLE videos ADD COLUMN demonetized INTEGER DEFAULT 0`); } catch (e) {}
    try { lite.exec(`ALTER TABLE videos ADD COLUMN monetization_enabled INTEGER DEFAULT 1`); } catch (e) {} }
  // migrations : colonnes d'authentification sociale
  if (USE_PG) {
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS google_id TEXT`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS sub_enabled INTEGER DEFAULT 0`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS sub_price INTEGER DEFAULT 0`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS first_name TEXT DEFAULT ''`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_name TEXT DEFAULT ''`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS birthdate TEXT DEFAULT ''`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS gender TEXT DEFAULT ''`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ref_code TEXT`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by INTEGER`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS storage_bytes BIGINT DEFAULT 0`); // v1.54 : quota stockage
    await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS audio_url TEXT DEFAULT ''`); // v1.57 : messages vocaux
    await pool.query(`ALTER TABLE group_messages ADD COLUMN IF NOT EXISTS audio_url TEXT DEFAULT ''`);
    // v2.38 : messages image/vidéo + suppression pour tous
    for (const t of ['messages', 'group_messages']) {
      await pool.query(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS image_url TEXT DEFAULT ''`);
      await pool.query(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS video_url TEXT DEFAULT ''`);
      await pool.query(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS deleted_for_all INTEGER DEFAULT 0`);
    }
    await pool.query(`CREATE TABLE IF NOT EXISTS message_reactions(
      id SERIAL PRIMARY KEY, message_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
      emoji TEXT NOT NULL, created_at BIGINT NOT NULL, UNIQUE(message_id, user_id))`);
    await pool.query(`CREATE TABLE IF NOT EXISTS call_participants(
      id SERIAL PRIMARY KEY, call_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'invited', joined_at BIGINT, UNIQUE(call_id, user_id))`);
    await pool.query(`ALTER TABLE videos ADD COLUMN IF NOT EXISTS phash TEXT DEFAULT ''`);
    await pool.query(`ALTER TABLE videos ADD COLUMN IF NOT EXISTS target_countries TEXT DEFAULT ''`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS country TEXT DEFAULT ''`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS fcm_token TEXT DEFAULT ''`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS campaign_notifs INTEGER DEFAULT 1`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS tz TEXT DEFAULT 'America/Port-au-Prince'`);
    await pool.query(`ALTER TABLE notifications ADD COLUMN IF NOT EXISTS title TEXT DEFAULT ''`);
    await pool.query(`ALTER TABLE notifications ADD COLUMN IF NOT EXISTS comment_id INTEGER`); // v2.31 : notifs mention/réponse → commentaire exact
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT DEFAULT ''`);
    await pool.query(`ALTER TABLE verification_requests ADD COLUMN IF NOT EXISTS reviewed_by TEXT DEFAULT ''`);
    await pool.query(`ALTER TABLE verification_requests ADD COLUMN IF NOT EXISTS review_reason TEXT DEFAULT ''`);
    await pool.query(`ALTER TABLE id_verifications ADD COLUMN IF NOT EXISTS reviewed_by TEXT DEFAULT ''`);
    await pool.query(`ALTER TABLE id_verifications ADD COLUMN IF NOT EXISTS review_reason TEXT DEFAULT ''`);
    await pool.query(`ALTER TABLE videos ADD COLUMN IF NOT EXISTS ad_impressions INTEGER DEFAULT 0`);
    await pool.query(`ALTER TABLE videos ADD COLUMN IF NOT EXISTS ad_revenue_usd REAL DEFAULT 0`);
    await pool.query(`ALTER TABLE videos ADD COLUMN IF NOT EXISTS monetized_views INTEGER DEFAULT 0`);
    await pool.query(`ALTER TABLE videos ADD COLUMN IF NOT EXISTS demonetized INTEGER DEFAULT 0`);
    await pool.query(`ALTER TABLE videos ADD COLUMN IF NOT EXISTS monetization_enabled INTEGER DEFAULT 1`);
    await pool.query(`CREATE TABLE IF NOT EXISTS ad_impressions(
      id SERIAL PRIMARY KEY, video_id INTEGER NOT NULL, creator_id INTEGER NOT NULL,
      ad_type TEXT NOT NULL DEFAULT 'interstitial', created_at BIGINT NOT NULL)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_adimp_video ON ad_impressions(video_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_adimp_day ON ad_impressions(created_at)`);
    await pool.query(`ALTER TABLE sounds ADD COLUMN IF NOT EXISTS license TEXT DEFAULT ''`);
    await pool.query(`ALTER TABLE sounds ADD COLUMN IF NOT EXISTS attribution TEXT DEFAULT ''`);
    await pool.query(`ALTER TABLE videos ADD COLUMN IF NOT EXISTS reply_to_comment_id INTEGER DEFAULT 0`);
    await pool.query(`ALTER TABLE comments ADD COLUMN IF NOT EXISTS video_reply_id INTEGER DEFAULT 0`);
    await pool.query(`CREATE TABLE IF NOT EXISTS live_goals(
      id SERIAL PRIMARY KEY, live_id INTEGER NOT NULL, title TEXT NOT NULL,
      target_coins INTEGER NOT NULL, created_at BIGINT NOT NULL)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS challenges(
      id SERIAL PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL,
      bonus_coins INTEGER NOT NULL, goal_type TEXT NOT NULL, goal_value INTEGER NOT NULL,
      start_at BIGINT NOT NULL, end_at BIGINT NOT NULL, active INTEGER DEFAULT 1)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS challenge_claims(
      id SERIAL PRIMARY KEY, challenge_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
      claimed_at BIGINT NOT NULL, UNIQUE(challenge_id, user_id))`);
    await pool.query(`CREATE TABLE IF NOT EXISTS search_logs(
      id SERIAL PRIMARY KEY, query TEXT NOT NULL, user_id INTEGER,
      created_at BIGINT NOT NULL)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS calls(
      id SERIAL PRIMARY KEY, caller_id INTEGER NOT NULL, callee_id INTEGER NOT NULL,
      ctype TEXT NOT NULL DEFAULT 'video', status TEXT NOT NULL DEFAULT 'ringing',
      created_at BIGINT NOT NULL, ended_at BIGINT)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS call_signals(
      id SERIAL PRIMARY KEY, call_id INTEGER NOT NULL, to_user_id INTEGER NOT NULL,
      from_user_id INTEGER NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL,
      created_at BIGINT NOT NULL)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS pk_battles(
      id SERIAL PRIMARY KEY, live_a_id INTEGER NOT NULL, live_b_id INTEGER NOT NULL,
      user_a_id INTEGER NOT NULL, user_b_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', score_a INTEGER NOT NULL DEFAULT 0,
      score_b INTEGER NOT NULL DEFAULT 0, winner_id INTEGER,
      created_at BIGINT NOT NULL, starts_at BIGINT, ends_at BIGINT)`);
  } // FIX 2026-10-04 : le if (USE_PG) des migrations n'était jamais fermé — les routes
  // ci-dessous (vérification, battles PK, appels, sons, transcription, insights) n'étaient
  // enregistrées que sur Postgres (404 en SQLite local)
  // (constante VERIF_CATEGORIES désormais au niveau module — voir FIX v2.42 en tête de fichier)
app.post('/api/verification/request', auth, uploadImg.single('id_doc'), async (req, res) => {
  try {
    const u = await get1('SELECT verified FROM users WHERE id=?', req.userId);
    if (u && u.verified) return res.status(400).json({ error: 'compte déjà vérifié' });
    const b = req.body || {};
    const fullName = String(b.full_name || '').trim().slice(0, 100);
    const category = String(b.category || '').trim().toLowerCase();
    const website = String(b.website || '').trim().slice(0, 300);
    const proofLinks = String(b.proof_links || '').trim().slice(0, 1000);
    const activity = String(b.activity || '').trim().slice(0, 1000);
    if (fullName.length < 3) return res.status(400).json({ error: 'nom complet requis' });
    if (!VERIF_CATEGORIES.includes(category)) return res.status(400).json({ error: 'catégorie invalide' });
    if (!req.file) return res.status(400).json({ error: 'photo de la pièce d\u2019identité requise' });
    if (!website && !proofLinks) return res.status(400).json({ error: 'ajoute ton site web ou tes liens de preuve' });
    if (activity.length < 20) return res.status(400).json({ error: 'décris ton activité (20 caractères min)' });
    const docUrl = await storeImage(req.file, 'vidigagne/verification');
    const reason = '[' + category + '] ' + fullName + ' — ' + activity.slice(0, 300);
    await runSql(`INSERT INTO verification_requests(user_id, status, reason, created_at,
        full_name, category, website, proof_links, activity, id_doc_url)
      VALUES(?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET status='pending', reason=excluded.reason,
        created_at=excluded.created_at, reviewed_at=NULL, full_name=excluded.full_name,
        category=excluded.category, website=excluded.website, proof_links=excluded.proof_links,
        activity=excluded.activity, id_doc_url=excluded.id_doc_url`,
      req.userId, reason, now(), fullName, category, website, proofLinks, activity, docUrl);
    res.json({ ok: true });
    runVerificationBot().catch(()=>{}); // le bot examine immédiatement
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.get('/api/verification/status', auth, async (req, res) => {
  try {
    const u = await get1('SELECT verified FROM users WHERE id=?', req.userId);
    const r = await get1('SELECT status FROM verification_requests WHERE user_id=?', req.userId);
    res.json({ verified: !!(u && u.verified), status: r ? r.status : 'none' });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.get('/api/admin/verification', async (req, res) => {
  const t = req.headers['x-admin-token'];
  if (!process.env.ADMIN_TOKEN || t !== process.env.ADMIN_TOKEN) return res.status(403).json({ error: 'non autorisé' });
  try {
    const rows = await allRows(`SELECT vr.*, u.username, u.avatar FROM verification_requests vr
      JOIN users u ON u.id=vr.user_id WHERE vr.status='pending' ORDER BY vr.created_at ASC LIMIT 100`);
    res.json({ requests: rows });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.post('/api/admin/verification/:id', async (req, res) => {
  const t = req.headers['x-admin-token'];
  if (!process.env.ADMIN_TOKEN || t !== process.env.ADMIN_TOKEN) return res.status(403).json({ error: 'non autorisé' });
  try {
    const approve = String((req.body || {}).action) === 'approve';
    const r = await get1('SELECT * FROM verification_requests WHERE id=?', req.params.id);
    if (!r) return res.status(404).json({ error: 'introuvable' });
    await runSql(`UPDATE verification_requests SET status=?, reviewed_at=? WHERE id=?`,
      approve ? 'approved' : 'rejected', now(), r.id);
    if (approve) {
      await runSql('UPDATE users SET verified=1 WHERE id=?', r.user_id);
      await insertIgnore('INSERT OR IGNORE INTO user_badges(user_id,badge,awarded_at) VALUES(?,?,?)', r.user_id, 'verified', now());
      await notify(r.user_id, 'system', null, null, '✔️ Ton compte est maintenant vérifié !');
    } else {
      await notify(r.user_id, 'system', null, null, 'Ta demande de badge vérifié a été refusée.');
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// v1.67 : sons originaux rémunérés — +2 pièces au créateur du son à chaque utilisation
app.post('/api/sounds/:id/use', auth, async (req, res) => {
  try {
    const s = await get1('SELECT * FROM sounds WHERE id=?', req.params.id);
    if (!s) return res.status(404).json({ error: 'son introuvable' });
    await runSql('UPDATE sounds SET use_count=use_count+1 WHERE id=?', s.id);
    // le créateur du son gagne +2 pièces par utilisation (max 200/jour anti-abus)
    if (Number(s.user_id) !== Number(req.userId)) {
      const dayStart = new Date().setHours(0, 0, 0, 0);
      const r = await get1(`SELECT COALESCE(SUM(amount),0) AS t FROM ledger
        WHERE user_id=? AND reason LIKE 'son utilisé%' AND created_at>=?`, s.user_id, dayStart);
      if ((Number(r.t) || 0) < 200) {
        await runSql('UPDATE users SET coins=coins+2 WHERE id=?', s.user_id);
        await runSql('INSERT INTO ledger(user_id,amount,reason,created_at) VALUES(?,?,?,?)',
          s.user_id, 2, 'son utilisé : ' + String(s.title).slice(0, 60), now());
      }
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// v1.67 : objectifs de live (barre de progression des cadeaux)
app.post('/api/live/:id/goal', auth, async (req, res) => {
  try {
    const live = await get1('SELECT * FROM lives WHERE id=?', req.params.id);
    if (!live) return res.status(404).json({ error: 'live introuvable' });
    if (Number(live.user_id) !== Number(req.userId)) return res.status(403).json({ error: 'non autorisé' });
    const title = String((req.body || {}).title || 'Objectif').slice(0, 80);
    const target = Math.max(10, Math.min(1000000, Math.floor(Number((req.body || {}).target_coins) || 100)));
    const gid = await insertId('INSERT INTO live_goals(live_id,title,target_coins,created_at) VALUES(?,?,?,?)',
      live.id, title, target, now());
    res.json({ ok: true, id: gid });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.get('/api/live/:id/goals', async (req, res) => {
  try {
    const goals = await allRows('SELECT * FROM live_goals WHERE live_id=? ORDER BY created_at DESC', req.params.id);
    const out = [];
    for (const g of goals) {
      const r = await get1(`SELECT COALESCE(SUM(cost),0) AS s FROM gifts WHERE live_id=? AND created_at>=?`,
        g.live_id, g.created_at);
      out.push({ ...g, current_coins: Number(r.s) || 0 });
    }
    res.json({ goals: out });
  } catch (e) { res.json({ goals: [] }); }
});
// v1.67 : défis créateurs (bonus en pièces)
app.get('/api/challenges', auth, async (req, res) => {
  try {
    const t = now();
    const rows = await allRows(`SELECT c.*, (SELECT 1 FROM challenge_claims cc
      WHERE cc.challenge_id=c.id AND cc.user_id=?) AS claimed FROM challenges c
      WHERE c.active=1 AND c.start_at<=? AND c.end_at>=? ORDER BY c.end_at ASC`, req.userId, t, t);
    const out = [];
    for (const c of rows) {
      let progress = 0;
      if (c.goal_type === 'videos') {
        const r = await get1('SELECT COUNT(*) AS n FROM videos WHERE user_id=? AND created_at>=? AND hidden=0',
          req.userId, c.start_at);
        progress = Number(r.n) || 0;
      } else if (c.goal_type === 'views') {
        const r = await get1('SELECT COALESCE(SUM(views),0) AS s FROM videos WHERE user_id=? AND hidden=0', req.userId);
        progress = Number(r.s) || 0;
      } else if (c.goal_type === 'followers') {
        const r = await get1('SELECT COUNT(*) AS n FROM follows WHERE followed_id=?', req.userId);
        progress = Number(r.n) || 0;
      }
      out.push({ ...c, progress, done: progress >= Number(c.goal_value) });
    }
    res.json({ challenges: out });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.post('/api/challenges/:id/claim', auth, async (req, res) => {
  try {
    const c = await get1('SELECT * FROM challenges WHERE id=? AND active=1', req.params.id);
    if (!c) return res.status(404).json({ error: 'défi introuvable' });
    const t = now();
    if (t < Number(c.start_at) || t > Number(c.end_at)) return res.status(400).json({ error: 'défi expiré' });
    const done = await get1('SELECT 1 FROM challenge_claims WHERE challenge_id=? AND user_id=?', c.id, req.userId);
    if (done) return res.status(400).json({ error: 'déjà réclamé' });
    let progress = 0;
    if (c.goal_type === 'videos') {
      const r = await get1('SELECT COUNT(*) AS n FROM videos WHERE user_id=? AND created_at>=? AND hidden=0', req.userId, c.start_at);
      progress = Number(r.n) || 0;
    } else if (c.goal_type === 'views') {
      const r = await get1('SELECT COALESCE(SUM(views),0) AS s FROM videos WHERE user_id=? AND hidden=0', req.userId);
      progress = Number(r.s) || 0;
    } else if (c.goal_type === 'followers') {
      const r = await get1('SELECT COUNT(*) AS n FROM follows WHERE followed_id=?', req.userId);
      progress = Number(r.n) || 0;
    }
    if (progress < Number(c.goal_value)) return res.status(400).json({ error: 'objectif non atteint (' + progress + '/' + c.goal_value + ')' });
    await runSql('INSERT INTO challenge_claims(challenge_id,user_id,claimed_at) VALUES(?,?,?)', c.id, req.userId, t);
    await runSql('UPDATE users SET coins=coins+? WHERE id=?', Number(c.bonus_coins), req.userId);
    await runSql('INSERT INTO ledger(user_id,amount,reason,created_at) VALUES(?,?,?,?)',
      req.userId, Number(c.bonus_coins), 'défi créateur : ' + c.title, t);
    res.json({ ok: true, bonus: Number(c.bonus_coins) });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// v2.38 : page défi — vidéos participantes (hashtag) + classement par vues
app.get('/api/challenges/:id', async (req, res) => {
  try {
    const c = await get1('SELECT * FROM challenges WHERE id=?', req.params.id);
    if (!c) return res.status(404).json({ error: 'défi introuvable' });
    const meId = await optUserId(req);
    const tag = String(c.hashtag || '').toLowerCase().replace(/^#/, '').trim();
    let videos = [];
    if (tag) {
      const rows = await allRows(
        `SELECT * FROM videos WHERE hidden=0 AND created_at>=? AND created_at<=?
         AND (LOWER(description) LIKE ? OR LOWER(tags) LIKE ?)
         ORDER BY views DESC, created_at DESC LIMIT 50`,
        Number(c.start_at), Number(c.end_at), '%#' + tag + '%', '%' + tag + '%');
      for (const v of rows) {
        if (await canSeeVideo(v, meId)) { const j = await videoJSON(v, meId); if (j) videos.push(j); }
      }
    }
    const pset = new Set();
    for (const j of videos) { const un = j.user && (j.user.username || j.user.name); if (un) pset.add(String(un)); }
    let progress = 0, claimed = false;
    if (meId) {
      if (c.goal_type === 'videos') {
        const r = await get1('SELECT COUNT(*) AS n FROM videos WHERE user_id=? AND created_at>=? AND hidden=0', meId, c.start_at);
        progress = Number(r.n) || 0;
      } else if (c.goal_type === 'views') {
        const r = await get1('SELECT COALESCE(SUM(views),0) AS s FROM videos WHERE user_id=? AND hidden=0', meId);
        progress = Number(r.s) || 0;
      } else if (c.goal_type === 'followers') {
        const r = await get1('SELECT COUNT(*) AS n FROM follows WHERE followed_id=?', meId);
        progress = Number(r.n) || 0;
      }
      claimed = !!(await get1('SELECT 1 FROM challenge_claims WHERE challenge_id=? AND user_id=?', c.id, meId));
    }
    res.json({ ok: true, challenge: { ...c, progress, done: progress >= Number(c.goal_value), claimed },
      participants: pset.size, videos });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// v1.67 : historique des gains + export
app.get('/api/earnings/history', auth, async (req, res) => {
  try {
    const rows = await allRows(`SELECT amount, reason, created_at FROM ledger
      WHERE user_id=? AND amount>0 ORDER BY created_at DESC LIMIT 200`, req.userId);
    res.json({ history: rows });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.get('/api/earnings/export', auth, async (req, res) => {
  try {
    const rows = await allRows(`SELECT amount, reason, created_at FROM ledger
      WHERE user_id=? AND amount>0 ORDER BY created_at DESC LIMIT 1000`, req.userId);
    let csv = 'date;montant_pieces;motif\n';
    for (const r of rows) {
      const d = new Date(Number(r.created_at)).toISOString().slice(0, 10);
      csv += d + ';' + r.amount + ';"' + String(r.reason || '').replace(/"/g, '""') + '"\n';
    }
    res.type('text/csv').set('Content-Disposition', 'attachment; filename="gains-vidigagne.csv"').send(csv);
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// v2.40 : historique des retraits du user connecté (avec n° de reçu joint)
app.get('/api/me/withdrawals', auth, async (req, res) => {
  try {
    const rows = await allRows(
      `SELECT w.id, w.coins, w.usd, w.method, w.account, w.status, w.created_at, w.decided_at,
              r.receipt_no FROM withdrawals w
       LEFT JOIN receipts r ON r.withdrawal_id=w.id
       WHERE w.user_id=? ORDER BY w.created_at DESC, w.id DESC LIMIT 200`, req.userId);
    res.json({ withdrawals: rows });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// v2.40 : documents fiscaux annuels — gains (ledger) + retraits payés, mensuel sur 12 mois
app.get('/api/me/tax-docs', auth, async (req, res) => {
  try {
    const year = Math.floor(+req.query.year) || new Date().getFullYear();
    const y0 = new Date(year, 0, 1).getTime(), y1 = new Date(year + 1, 0, 1).getTime();
    const coinsToUsd = c => Math.floor(Number(c) / 500 * 100) / 100;
    const gains = await allRows(
      'SELECT amount, created_at FROM ledger WHERE user_id=? AND amount>0 AND created_at>=? AND created_at<?',
      req.userId, y0, y1);
    const paid = await allRows(
      "SELECT usd, created_at FROM withdrawals WHERE user_id=? AND status='paid' AND created_at>=? AND created_at<?",
      req.userId, y0, y1);
    const byMonth = Array.from({ length: 12 }, (_, i) => ({ month: i + 1, earned_coins: 0, withdrawn_usd: 0 }));
    let totalEarned = 0, totalWithdrawn = 0;
    for (const g of gains) {
      const m = new Date(Number(g.created_at)).getMonth();
      if (m >= 0 && m < 12) { totalEarned += Number(g.amount); byMonth[m].earned_coins += Number(g.amount); }
    }
    for (const w of paid) {
      const m = new Date(Number(w.created_at)).getMonth();
      if (m >= 0 && m < 12) { totalWithdrawn += Number(w.usd); byMonth[m].withdrawn_usd += Number(w.usd); }
    }
    for (const b of byMonth) b.withdrawn_usd = Math.round(b.withdrawn_usd * 100) / 100;
    const totalEarnedUsd = coinsToUsd(totalEarned), totalWithdrawnUsd = Math.round(totalWithdrawn * 100) / 100;
    if (req.query.format === 'csv') {
      let csv = 'mois;gains_pieces;gains_usd;retraits_payes_usd\n';
      for (const b of byMonth)
        csv += String(b.month).padStart(2, '0') + '/' + year + ';' + b.earned_coins + ';'
          + coinsToUsd(b.earned_coins).toFixed(2) + ';' + b.withdrawn_usd.toFixed(2) + '\n';
      csv += 'TOTAL;' + totalEarned + ';' + totalEarnedUsd.toFixed(2) + ';' + totalWithdrawnUsd.toFixed(2) + '\n';
      return res.type('text/csv').set('Content-Disposition',
        'attachment; filename="documents-fiscaux-' + year + '.csv"').send(csv);
    }
    res.json({
      year,
      total_earned_coins: totalEarned,
      total_earned_usd: totalEarnedUsd,
      total_withdrawn_usd: totalWithdrawnUsd,
      by_month: byMonth.map(b => ({ month: b.month, earned_usd: coinsToUsd(b.earned_coins), withdrawn_usd: b.withdrawn_usd })),
      documents: [{ type: 'annual_summary', label: 'Résumé annuel des gains ' + year,
        url: '/api/me/tax-docs?year=' + year + '&format=csv' }],
    });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// v1.67 : le créateur active/coupe la monétisation d'une de ses vidéos
app.post('/api/videos/:id/monetization', auth, async (req, res) => {
  try {
    const v = await get1('SELECT * FROM videos WHERE id=?', req.params.id);
    if (!v) return res.status(404).json({ error: 'vidéo introuvable' });
    if (Number(v.user_id) !== Number(req.userId)) return res.status(403).json({ error: 'non autorisé' });
    const enabled = (req.body || {}).enabled !== false ? 1 : 0;
    await runSql('UPDATE videos SET monetization_enabled=? WHERE id=?', enabled, v.id);
    res.json({ ok: true, monetization_enabled: !!enabled });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// v1.67 : règles de démonétisation (contenus exclus des pubs)
const DEMONETIZED_KEYWORDS = ['violence','arme','drogue','sexe','porno','haine','terrorisme','suicide','automutilation'];
app.post('/api/admin/videos/:id/demonetize', async (req, res) => {
  const t = req.headers['x-admin-token'];
  if (!process.env.ADMIN_TOKEN || t !== process.env.ADMIN_TOKEN) return res.status(403).json({ error: 'non autorisé' });
  try {
    const demonetized = (req.body || {}).demonetized !== false ? 1 : 0;
    const reason = String((req.body || {}).reason || '').slice(0, 200);
    await runSql('UPDATE videos SET demonetized=? WHERE id=?', demonetized, req.params.id);
    const v = await get1('SELECT user_id FROM videos WHERE id=?', req.params.id);
    if (v) await notify(v.user_id, 'system', null, null, demonetized
      ? '⚠️ Ta vidéo a été démonétisée' + (reason ? ' : ' + reason : '') + ' — aucune pub ne sera diffusée dessus.'
      : '✅ Ta vidéo est de nouveau monétisée.');
    // v2.44-EQD-MAIL : e-mail de démonétisation (uniquement quand la vidéo est démonétisée)
    if (demonetized && v) {
      const vu = await get1('SELECT email FROM users WHERE id=?', v.user_id);
      if (vu && vu.email) sendVidiEmail(vu.email,
        '⚠️ Vidéo démonétisée — VidiGagne',
        '<p style="font-size:18px">⚠️ Vidéo démonétisée</p>'
        + '<p style="color:#ccc;font-size:14px">L\'une de tes vidéos a été démonétisée' + (reason ? ' : ' + String(reason).replace(/</g, '&lt;') : '') + ' — aucune publicité ne sera diffusée dessus.</p>'
        + '<p style="color:#999;font-size:12px">Merci de respecter les règles de la communauté. ✨</p>',
        'L\'une de tes vidéos VidiGagne a été démonétisée' + (reason ? ' : ' + reason : '') + '.').catch(() => {});
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// v1.67 : une pub s'affiche après/pendant une vidéo → impression comptabilisée pour le créateur
app.post('/api/ads/impression', auth, async (req, res) => {
  try {
    const vid = Number((req.body || {}).video_id) || 0;
    const adType = String((req.body || {}).ad_type || 'interstitial').slice(0, 30);
    if (!vid) return res.status(400).json({ error: 'video_id requis' });
    const v = await get1('SELECT id, user_id, hidden, demonetized, monetization_enabled FROM videos WHERE id=?', vid);
    if (!v || v.hidden) return res.status(404).json({ error: 'vidéo introuvable' });
    if (v.demonetized) return res.json({ ok: true, skipped: 'demonetized' }); // pas de pub = pas de revenu
    if (!v.monetization_enabled) return res.json({ ok: true, skipped: 'disabled_by_creator' });
    await runSql('INSERT INTO ad_impressions(video_id, creator_id, ad_type, created_at) VALUES(?,?,?,?)',
      vid, v.user_id, adType, now());
    await runSql('UPDATE videos SET ad_impressions=ad_impressions+1 WHERE id=?', vid);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// éligibilité + statut monétisation du créateur connecté
app.get('/api/monetization/status', auth, async (req, res) => {
  try {
    const elig = await monetizationEligibility(req.userId);
    // FIX 2026-10-04 : pas de colonne videos.likes (les likes vivent dans la table likes) — comptés par vidéo
    const vids = await allRows(`SELECT id, description, views, ad_impressions, ad_revenue_usd,
      monetized_views, demonetized, duration, created_at FROM videos
      WHERE user_id=? AND hidden=0 ORDER BY created_at DESC LIMIT 100`, req.userId);
    const vq = [];
    for (const v of vids) {
      const lc = await get1('SELECT COUNT(*) AS c FROM likes WHERE video_id=?', v.id);
      vq.push({ ...v, likes: Number(lc.c) || 0, quality: await videoQualityScore(v) });
    }
    const totalEarned = vq.reduce((s, v) => s + (Number(v.ad_revenue_usd) || 0), 0);
    const totalImp = vq.reduce((s, v) => s + (Number(v.ad_impressions) || 0), 0);
    res.json({ ...elig, total_earned_usd: +totalEarned.toFixed(4), total_impressions: totalImp, videos: vq });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// distribution quotidienne à 23h59 UTC (avec le calcul 50-50 existant)

// v1.61 : battles PK entre deux lives
const PK_DURATION_MS = 5 * 60 * 1000;
async function activePkForLive(liveId) {
  const b = await get1(`SELECT * FROM pk_battles WHERE status IN ('pending','active')
    AND (live_a_id=? OR live_b_id=?) ORDER BY id DESC LIMIT 1`, liveId, liveId);
  if (!b) return null;
  if (b.status === 'active' && b.ends_at && now() > Number(b.ends_at)) {
    const winner = Number(b.score_a) >= Number(b.score_b) ? b.user_a_id : b.user_b_id;
    await runSql('UPDATE pk_battles SET status=?, winner_id=? WHERE id=?', 'ended', winner, b.id);
    b.status = 'ended'; b.winner_id = winner;
  }
  return b;
}
async function pkPublic(b) {
  if (!b) return null;
  const ua = await get1('SELECT id,username,avatar FROM users WHERE id=?', b.user_a_id);
  const ub = await get1('SELECT id,username,avatar FROM users WHERE id=?', b.user_b_id);
  return { id: b.id, status: b.status, score_a: b.score_a, score_b: b.score_b,
    ends_at: b.ends_at ? Number(b.ends_at) : null, winner_id: b.winner_id || null,
    user_a: ua, user_b: ub, live_a_id: b.live_a_id, live_b_id: b.live_b_id };
}
// FIX 2026-10-05 : activePkForLive/pkPublic définis dans un scope non-global (v1.61) —
// le endpoint /api/live/:id/gift (hors scope) levait ReferenceError, masqué par try/catch.
// Exposition globale pour que les cadeaux alimentent le score PK.
try { globalThis.activePkForLive = activePkForLive; globalThis.pkPublic = pkPublic; } catch (_) {}
app.post('/api/live/:id/pk/invite', auth, async (req, res) => {
  try {
    const l = await liveById(req.params.id);
    if (!l || l.ended_at) return res.status(404).json({ error: 'live introuvable' });
    if (Number(l.user_id) !== Number(req.userId)) return res.status(403).json({ error: 'réservé au diffuseur' });
    if (await activePkForLive(l.id)) return res.status(400).json({ error: 'un battle est déjà en cours' });
    const targetName = String((req.body || {}).username || '').trim().replace(/^@/, '');
    if (!targetName) return res.status(400).json({ error: 'pseudo requis' });
    const tu = await get1('SELECT id,username FROM users WHERE LOWER(username)=LOWER(?)', targetName);
    if (!tu) return res.status(404).json({ error: 'utilisateur introuvable' });
    if (Number(tu.id) === Number(req.userId)) return res.status(400).json({ error: 'impossible de se défier soi-même' });
    const tl = await get1('SELECT * FROM lives WHERE user_id=? AND ended_at IS NULL ORDER BY id DESC LIMIT 1', tu.id);
    if (!tl) return res.status(400).json({ error: '@' + tu.username + " n'est pas en live" });
    if (await activePkForLive(tl.id)) return res.status(400).json({ error: 'cet utilisateur est déjà en battle' });
    const id = await insertId(`INSERT INTO pk_battles(live_a_id,live_b_id,user_a_id,user_b_id,status,created_at)
      VALUES(?,?,?,?,?,?)`, l.id, tl.id, req.userId, tu.id, 'pending', now());
    await notify(tu.id, 'system', req.userId, null, '⚔️ Défi PK reçu ! Accepte-le depuis ton live.');
    res.json({ ok: true, battle_id: id });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.post('/api/pk/:battleId/respond', auth, async (req, res) => {
  try {
    const b = await get1('SELECT * FROM pk_battles WHERE id=?', req.params.battleId);
    if (!b || b.status !== 'pending') return res.status(404).json({ error: 'défi introuvable' });
    if (Number(b.user_b_id) !== Number(req.userId)) return res.status(403).json({ error: 'non autorisé' });
    if (String((req.body || {}).action) === 'accept') {
      const ends = now() + PK_DURATION_MS;
      await runSql(`UPDATE pk_battles SET status='active', starts_at=?, ends_at=? WHERE id=?`, now(), ends, b.id);
      await notify(b.user_a_id, 'system', req.userId, null, '⚔️ Défi PK accepté ! Que le meilleur gagne !');
      res.json({ ok: true, ends_at: ends });
    } else {
      await runSql(`UPDATE pk_battles SET status='rejected' WHERE id=?`, b.id);
      await notify(b.user_a_id, 'system', req.userId, null, 'Ton défi PK a été refusé.');
      res.json({ ok: true });
    }
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.get('/api/live/:id/pk', async (req, res) => {
  try {
    const l = await liveById(req.params.id);
    if (!l) return res.status(404).json({ error: 'live introuvable' });
    res.json({ battle: await pkPublic(await activePkForLive(l.id)) });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.get('/api/pk/pending', auth, async (req, res) => {
  try {
    const rows = await allRows(`SELECT * FROM pk_battles WHERE user_b_id=? AND status='pending' ORDER BY id DESC LIMIT 10`, req.userId);
    const out = [];
    for (const b of rows) out.push(await pkPublic(b));
    res.json({ pending: out });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// v2.31 : le challenger annule son défi en attente
app.post('/api/pk/:battleId/cancel', auth, async (req, res) => {
  try {
    const b = await get1('SELECT * FROM pk_battles WHERE id=?', req.params.battleId);
    if (!b || b.status !== 'pending') return res.status(404).json({ error: 'défi introuvable' });
    if (Number(b.user_a_id) !== Number(req.userId)) return res.status(403).json({ error: 'non autorisé' });
    await runSql(`UPDATE pk_battles SET status='cancelled' WHERE id=?`, b.id);
    await notify(b.user_b_id, 'system', req.userId, null, '⚔️ Défi PK annulé.');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.post('/api/pk/:battleId/end', auth, async (req, res) => {
  try {
    const b = await get1('SELECT * FROM pk_battles WHERE id=?', req.params.battleId);
    if (!b || b.status !== 'active') return res.status(404).json({ error: 'battle introuvable' });
    if (Number(b.user_a_id) !== Number(req.userId) && Number(b.user_b_id) !== Number(req.userId))
      return res.status(403).json({ error: 'non autorisé' });
    const winner = Number(b.score_a) >= Number(b.score_b) ? b.user_a_id : b.user_b_id;
    await runSql(`UPDATE pk_battles SET status='ended', winner_id=? WHERE id=?`, winner, b.id);
    res.json({ ok: true, winner_id: winner });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// v1.61 : appels audio/vidéo 1-à-1
app.post('/api/calls/start', auth, async (req, res) => {
  try {
    const targetName = String((req.body || {}).username || '').trim().replace(/^@/, '');
    const ctype = String((req.body || {}).ctype || 'video') === 'audio' ? 'audio' : 'video';
    if (!targetName) return res.status(400).json({ error: 'pseudo requis' });
    const tu = await get1('SELECT id,username FROM users WHERE LOWER(username)=LOWER(?)', targetName);
    if (!tu) return res.status(404).json({ error: 'utilisateur introuvable' });
    if (Number(tu.id) === Number(req.userId)) return res.status(400).json({ error: 'impossible de s’appeler soi-même' });
    // v2.38 : appel bloqué si l'un a bloqué l'autre
    if (await isBlocked(req.userId, tu.id) || await isBlocked(tu.id, req.userId))
      return res.status(403).json({ error: 'appel impossible' });
    const busy = await get1(`SELECT id FROM calls WHERE status IN ('ringing','active')
      AND (caller_id=? OR callee_id=? OR caller_id=? OR callee_id=?) LIMIT 1`,
      req.userId, req.userId, tu.id, tu.id);
    if (busy) return res.status(400).json({ error: 'ligne occupée' });
    const me = await get1('SELECT username FROM users WHERE id=?', req.userId);
    const id = await insertId(`INSERT INTO calls(caller_id,callee_id,ctype,status,created_at)
      VALUES(?,?,?,?,?)`, req.userId, tu.id, ctype, 'ringing', now());
    // notifie instantanément via le WebSocket push (type=call)
    try {
      const ws = pushSockets.get(Number(tu.id));
      if (ws && ws.readyState === 1)
        ws.send(JSON.stringify({ t: 'push', type: 'call', call_id: id, ctype,
          actor: me ? me.username : '', text: 'Appel entrant' }));
    } catch (_) {}
    await notify(tu.id, 'call', req.userId, null, '📞 Appel ' + (ctype === 'audio' ? 'audio' : 'vidéo') + ' entrant');
    res.json({ ok: true, call_id: id });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.post('/api/calls/:id/respond', auth, async (req, res) => {
  try {
    const c = await get1('SELECT * FROM calls WHERE id=?', req.params.id);
    if (!c || c.status !== 'ringing') return res.status(404).json({ error: 'appel introuvable' });
    if (Number(c.callee_id) !== Number(req.userId)) return res.status(403).json({ error: 'non autorisé' });
    const action = String((req.body || {}).action);
    if (action === 'accept') {
      await runSql(`UPDATE calls SET status='active' WHERE id=?`, c.id);
      try {
        const ws = pushSockets.get(Number(c.caller_id));
        if (ws && ws.readyState === 1)
          ws.send(JSON.stringify({ t: 'call_accepted', call_id: c.id }));
      } catch (_) {}
      res.json({ ok: true });
    } else {
      await runSql(`UPDATE calls SET status='rejected', ended_at=? WHERE id=?`, now(), c.id);
      res.json({ ok: true });
    }
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.post('/api/calls/:id/end', auth, async (req, res) => {
  try {
    const c = await get1('SELECT * FROM calls WHERE id=?', req.params.id);
    if (!c) return res.status(404).json({ error: 'appel introuvable' });
    if (Number(c.caller_id) !== Number(req.userId) && Number(c.callee_id) !== Number(req.userId))
      return res.status(403).json({ error: 'non autorisé' });
    await runSql(`UPDATE calls SET status='ended', ended_at=? WHERE id=? AND status IN ('ringing','active')`, now(), c.id);
    // v2.38 : appel manqué → notif pour le destinataire si l'appel n'a jamais été décroché
    if (c.status === 'ringing' && Number(c.callee_id) === Number(req.userId)) {
      try { await notify(c.caller_id, 'call_missed', req.userId, null, '📞 Appel manqué'); } catch (_) {}
    }
    if (c.status === 'ringing' && Number(c.caller_id) === Number(req.userId)) {
      try { await notify(c.callee_id, 'call_missed', req.userId, null, '📞 Appel manqué'); } catch (_) {}
    }
    try {
      const other = Number(c.caller_id) === Number(req.userId) ? c.callee_id : c.caller_id;
      const ws = pushSockets.get(Number(other));
      if (ws && ws.readyState === 1)
        ws.send(JSON.stringify({ t: 'call_ended', call_id: c.id }));
    } catch (_) {}
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.get('/api/calls/:id', auth, async (req, res) => {
  try {
    const c = await get1('SELECT * FROM calls WHERE id=?', req.params.id);
    if (!c) return res.status(404).json({ error: 'appel introuvable' });
    if (Number(c.caller_id) !== Number(req.userId) && Number(c.callee_id) !== Number(req.userId))
      return res.status(403).json({ error: 'non autorisé' });
    res.json({ call: c });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.post('/api/calls/:id/signal', auth, async (req, res) => {
  try {
    const c = await get1('SELECT * FROM calls WHERE id=?', req.params.id);
    if (!c || c.status === 'ended') return res.status(404).json({ error: 'appel introuvable' });
    const b = req.body || {};
    const kind = String(b.kind || '');
    if (!['offer', 'answer', 'candidate', 'screen'].includes(kind)) return res.status(400).json({ error: 'kind invalide' });
    const to = Number(c.caller_id) === Number(req.userId) ? c.callee_id : c.caller_id;
    await runSql(`INSERT INTO call_signals(call_id,to_user_id,from_user_id,kind,payload,created_at)
      VALUES(?,?,?,?,?,?)`, c.id, to, req.userId, kind, String(b.payload || '').slice(0, 20000), now());
    await runSql('DELETE FROM call_signals WHERE created_at<?', now() - 600000).catch(() => {});
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.get('/api/calls/:id/signal', auth, async (req, res) => {
  try {
    const c = await get1('SELECT * FROM calls WHERE id=?', req.params.id);
    if (!c) return res.status(404).json({ error: 'appel introuvable' });
    const since = Number(req.query.since) || 0;
    const rows = await allRows(`SELECT * FROM call_signals WHERE call_id=? AND id>? AND to_user_id=?
      ORDER BY id ASC LIMIT 50`, c.id, since, req.userId);
    res.json({ signals: rows.map(s => ({ id: s.id, kind: s.kind, from: s.from_user_id, payload: s.payload })) });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// v2.38 : appel de groupe — création (créateur + liste de pseudos invités)
app.post('/api/calls/group/start', auth, async (req, res) => {
  try {
    const ctype = String((req.body || {}).ctype || 'video') === 'audio' ? 'audio' : 'video';
    const names = Array.isArray((req.body || {}).usernames) ? (req.body || {}).usernames : [];
    if (names.length < 1 || names.length > 6) return res.status(400).json({ error: '1 à 6 invités requis' });
    const busy = await get1(`SELECT id FROM calls WHERE status IN ('ringing','active') AND (caller_id=? OR callee_id=?) LIMIT 1`,
      req.userId, req.userId);
    if (busy) return res.status(400).json({ error: 'ligne occupée' });
    const invited = [];
    for (const n of names) {
      const u = await get1('SELECT id,username FROM users WHERE LOWER(username)=LOWER(?)', String(n).trim().replace(/^@/, ''));
      if (!u || Number(u.id) === Number(req.userId)) continue;
      if (await isBlocked(req.userId, u.id) || await isBlocked(u.id, req.userId)) continue;
      if (!invited.find(x => Number(x.id) === Number(u.id))) invited.push(u);
    }
    if (!invited.length) return res.status(400).json({ error: 'aucun invité valide' });
    const me = await get1('SELECT username FROM users WHERE id=?', req.userId);
    const id = await insertId(`INSERT INTO calls(caller_id,callee_id,ctype,status,created_at)
      VALUES(?,?,?,?,?)`, req.userId, invited[0].id, ctype, 'ringing', now());
    await runSql('INSERT INTO call_participants(call_id,user_id,status,joined_at) VALUES(?,?,?,?)',
      id, req.userId, 'active', now());
    for (const u of invited) {
      await runSql('INSERT INTO call_participants(call_id,user_id,status) VALUES(?,?,?)', id, u.id, 'invited');
      try {
        const ws = pushSockets.get(Number(u.id));
        if (ws && ws.readyState === 1)
          ws.send(JSON.stringify({ t: 'push', type: 'call', call_id: id, ctype, group: true,
            actor: me ? me.username : '', text: 'Appel de groupe entrant' }));
      } catch (_) {}
      await notify(u.id, 'call', req.userId, null, '📞 Appel de groupe entrant');
    }
    res.json({ ok: true, call_id: id, invited: invited.map(u => u.username) });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// v2.38 : rejoindre un appel de groupe
app.post('/api/calls/:id/join', auth, async (req, res) => {
  try {
    const c = await get1('SELECT * FROM calls WHERE id=?', req.params.id);
    if (!c || !['ringing', 'active'].includes(c.status)) return res.status(404).json({ error: 'appel introuvable' });
    const p = await get1('SELECT * FROM call_participants WHERE call_id=? AND user_id=?', c.id, req.userId);
    if (!p) return res.status(403).json({ error: 'non invité' });
    await runSql(`UPDATE call_participants SET status='active', joined_at=? WHERE call_id=? AND user_id=?`,
      now(), c.id, req.userId);
    await runSql(`UPDATE calls SET status='active' WHERE id=? AND status='ringing'`, c.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// v2.38 : participants d'un appel
app.get('/api/calls/:id/participants', auth, async (req, res) => {
  try {
    const c = await get1('SELECT * FROM calls WHERE id=?', req.params.id);
    if (!c) return res.status(404).json({ error: 'appel introuvable' });
    const mine = await get1('SELECT 1 FROM call_participants WHERE call_id=? AND user_id=?', c.id, req.userId)
      || (Number(c.caller_id) === Number(req.userId) || Number(c.callee_id) === Number(req.userId));
    if (!mine) return res.status(403).json({ error: 'non autorisé' });
    const rows = await allRows(`SELECT cp.user_id, cp.status, u.username FROM call_participants cp
      JOIN users u ON u.id=cp.user_id WHERE cp.call_id=?`, c.id);
    res.json({ participants: rows.map(r => ({ user_id: r.user_id, username: r.username, status: r.status })) });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// v1.62 : import en masse de musiques libres de droits (admin)
// Body: { tracks: [{title, artist, genre, url}] } — télécharge chaque MP3, l'envoie
// sur Cloudinary et l'insère dans la table sounds (user_id=0 = catalogue système).
app.post('/api/admin/sounds/bulk-import', async (req, res) => {
  const t = req.headers['x-admin-token'];
  if (!process.env.ADMIN_TOKEN || t !== process.env.ADMIN_TOKEN)
    return res.status(403).json({ error: 'non autorisé' });
  if (!USE_CLOUDINARY || !cloudinary)
    return res.status(503).json({ error: 'stockage audio non configuré' });
  const tracks = ((req.body || {}).tracks || []).slice(0, 60);
  if (!tracks.length) return res.status(400).json({ error: 'tracks requis' });
  const https = require('https'), http = require('http');
  const results = [];
  const dl = (url) => new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const rq = mod.get(url, { timeout: 60000, headers: { 'User-Agent': 'VidiGagne/1.0' } }, (rs) => {
      if (rs.statusCode >= 300 && rs.statusCode < 400 && rs.headers.location)
        return resolve(dl(rs.headers.location));
      if (rs.statusCode !== 200) { rs.resume(); return reject(new Error('HTTP ' + rs.statusCode)); }
      const chunks = []; let size = 0;
      rs.on('data', (c) => { size += c.length; chunks.push(c);
        if (size > 20 * 1024 * 1024) { rq.destroy(); reject(new Error('fichier trop gros')); } });
      rs.on('end', () => resolve(Buffer.concat(chunks)));
      rs.on('error', reject);
    });
    rq.on('timeout', () => { rq.destroy(); reject(new Error('timeout')); });
    rq.on('error', reject);
  });
  for (const tr of tracks) {
    const title = String(tr.title || 'Sans titre').slice(0, 200);
    try {
      // évite les doublons
      const ex = await get1('SELECT id FROM sounds WHERE title=? AND artist=?',
        title, String(tr.artist || ''));
      if (ex) { results.push({ title, status: 'doublon' }); continue; }
      const buf = await dl(String(tr.url));
      if (buf.length < 50000) throw new Error('fichier trop petit');
      // vérifie que c'est bien un MP3 (ID3 ou frame sync)
      const isMp3 = (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) ||
                    (buf[0] === 0xFF && (buf[1] & 0xE0) === 0xE0);
      if (!isMp3) throw new Error('pas un MP3');
      const up = await new Promise((resolve, reject) => {
        const st = cloudinary.uploader.upload_stream(
          { resource_type: 'video', folder: 'vidigagne/sounds', format: 'mp3' },
          (err, r) => err ? reject(err) : resolve(r));
        st.end(buf);
      });
      await runSql(`INSERT INTO sounds(user_id,title,artist,audio_url,use_count,license,attribution,created_at)
        VALUES(0,?,?,?,?,?,?,?)`, title, String(tr.artist || '').slice(0, 200),
        up.secure_url, 0, String(tr.license || '').slice(0, 100), String(tr.attribution || '').slice(0, 500), now());
      results.push({ title, status: 'ok' });
    } catch (e) {
      results.push({ title, status: 'erreur: ' + e.message });
    }
  }
  res.json({ ok: true, imported: results.filter(r => r.status === 'ok').length, results });
});
// v1.63 : transcription vocale -> sous-titres auto (Vosk FR, hors ligne)
const transcribeAudio = multer({ dest: '/tmp/', limits: { fileSize: 100 * 1024 * 1024 } });
app.post('/api/transcribe', transcribeAudio.single('video'), async (req, res) => {
  let fpath = null;
  try {
    if (req.file) fpath = req.file.path;
    else if (req.body && req.body.video_url) {
      // télécharge depuis une URL (Cloudinary)
      const https = require('https'), http = require('http'), fs = require('fs');
      fpath = '/tmp/tr_' + Date.now() + '.mp4';
      const url = String(req.body.video_url);
      await new Promise((resolve, reject) => {
        const mod = url.startsWith('https') ? https : http;
        const rq = mod.get(url, { timeout: 60000 }, (rs) => {
          if (rs.statusCode !== 200) { rs.resume(); return reject(new Error('HTTP ' + rs.statusCode)); }
          const ws = fs.createWriteStream(fpath);
          rs.pipe(ws); ws.on('finish', resolve); ws.on('error', reject);
        });
        rq.on('timeout', () => { rq.destroy(); reject(new Error('timeout')); });
        rq.on('error', reject);
      });
    } else return res.status(400).json({ error: 'vidéo requise' });
    const { execFile } = require('child_process');
    const out = await new Promise((resolve, reject) => {
      execFile('python3', [__dirname + '/transcribe.py', fpath], { timeout: 300000 },
        (err, stdout, stderr) => err ? reject(err) : resolve(stdout));
    });
    const d = JSON.parse(out);
    if (d.error) return res.status(500).json({ error: d.error });
    res.json({ words: d.words || [] });
  } catch (e) {
    res.status(500).json({ error: 'transcription impossible' });
  } finally {
    try { if (fpath && fpath.startsWith('/tmp/')) require('fs').unlinkSync(fpath); } catch (_) {}
  }
});
// v1.63 : insights de recherche pour créateurs (tendances, requêtes montantes)
app.get('/api/search/insights', async (req, res) => {
  try {
    const since7 = now() - 7 * 86400000, since1 = now() - 86400000;
    // top recherches 7 jours
    const top = await allRows(`SELECT query, COUNT(*) AS n FROM search_logs
      WHERE created_at>? GROUP BY query ORDER BY n DESC LIMIT 20`, since7);
    // requêtes en forte hausse (24h vs 7j)
    const rising = await allRows(`SELECT query,
        SUM(CASE WHEN created_at>? THEN 1 ELSE 0 END) AS d1,
        COUNT(*) AS w1
      FROM search_logs WHERE created_at>?
      GROUP BY query HAVING COUNT(*)>=3
      ORDER BY d1 DESC LIMIT 20`, since1, since7);
    // hashtags tendance (depuis les vidéos récentes)
    const tags = await allRows(`SELECT tags FROM videos
      WHERE created_at>? AND hidden=0 AND tags IS NOT NULL AND tags<>''
      ORDER BY created_at DESC LIMIT 500`, since7);
    const tagCount = {};
    for (const r of tags) {
      String(r.tags || '').split(/[\s,]+/).forEach(t => {
        t = t.trim().toLowerCase().replace(/^#/, '');
        if (t.length >= 2 && t.length <= 30) tagCount[t] = (tagCount[t] || 0) + 1;
      });
    }
    const topTags = Object.entries(tagCount).sort((a, b) => b[1] - a[1]).slice(0, 20)
      .map(([tag, n]) => ({ tag, n }));
    res.json({
      trending: top.map(r => ({ query: r.query, searches: Number(r.n) })),
      rising: rising.map(r => ({ query: r.query, day: Number(r.d1), week: Number(r.w1) })),
      hashtags: topTags
    });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// v1.58 : recherche par image
  if (USE_PG) { // FIX 2026-10-04 : ré-ouvert ici (voir fermeture au-dessus)
    await pool.query(`CREATE TABLE IF NOT EXISTS verification_requests(
      id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'pending',
      reason TEXT NOT NULL DEFAULT '', created_at BIGINT NOT NULL, reviewed_at BIGINT)`);
    for (const [col, typ] of [['full_name','TEXT'],['category','TEXT'],['website','TEXT'],
        ['proof_links','TEXT'],['activity','TEXT'],['id_doc_url','TEXT']]) {
      await pool.query(`ALTER TABLE verification_requests ADD COLUMN IF NOT EXISTS ${col} ${typ} DEFAULT ''`);
    }
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS users_email_uidx ON users(email)`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS users_google_uidx ON users(google_id)`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS users_phone_uidx ON users(phone)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS oauth_sessions(session TEXT PRIMARY KEY, token TEXT NOT NULL, user_id INTEGER NOT NULL, created_at BIGINT NOT NULL)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS password_resets(email TEXT NOT NULL, code TEXT NOT NULL, expires_at BIGINT NOT NULL, created_at BIGINT NOT NULL)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS password_resets_email_idx ON password_resets(email)`);
  } else {
    const cols = lite.prepare(`PRAGMA table_info(users)`).all().map(c => c.name);
    for (const c of ['email', 'google_id', 'phone']) {
      if (!cols.includes(c)) lite.exec(`ALTER TABLE users ADD COLUMN ${c} TEXT`);
    }
    if (!cols.includes('sub_enabled')) lite.exec(`ALTER TABLE users ADD COLUMN sub_enabled INTEGER DEFAULT 0`);
    if (!cols.includes('sub_price')) lite.exec(`ALTER TABLE users ADD COLUMN sub_price INTEGER DEFAULT 0`);
    if (!cols.includes('storage_bytes')) lite.exec(`ALTER TABLE users ADD COLUMN storage_bytes INTEGER DEFAULT 0`); // v1.54 : quota stockage
    if (!cols.includes('fcm_token')) lite.exec(`ALTER TABLE users ADD COLUMN fcm_token TEXT DEFAULT ''`);
    if (!cols.includes('campaign_notifs')) lite.exec(`ALTER TABLE users ADD COLUMN campaign_notifs INTEGER DEFAULT 1`);
    if (!cols.includes('tz')) lite.exec(`ALTER TABLE users ADD COLUMN tz TEXT DEFAULT 'America/Port-au-Prince'`);
    const ncols = lite.prepare(`PRAGMA table_info(notifications)`).all().map(c => c.name);
    if (!ncols.includes('title')) lite.exec(`ALTER TABLE notifications ADD COLUMN title TEXT DEFAULT ''`);
    if (!ncols.includes('comment_id')) lite.exec(`ALTER TABLE notifications ADD COLUMN comment_id INTEGER`); // v2.31
    // v1.57 : messages vocaux
    for (const t of ['messages', 'group_messages']) {
      const mc = lite.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
      if (!mc.includes('audio_url')) lite.exec(`ALTER TABLE ${t} ADD COLUMN audio_url TEXT DEFAULT ''`);
    }
    // v2.38 : messages image/vidéo + suppression pour tous
    for (const t of ['messages', 'group_messages']) {
      const mc2 = lite.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
      if (!mc2.includes('image_url')) lite.exec(`ALTER TABLE ${t} ADD COLUMN image_url TEXT DEFAULT ''`);
      if (!mc2.includes('video_url')) lite.exec(`ALTER TABLE ${t} ADD COLUMN video_url TEXT DEFAULT ''`);
      if (!mc2.includes('deleted_for_all')) lite.exec(`ALTER TABLE ${t} ADD COLUMN deleted_for_all INTEGER DEFAULT 0`);
    }
    lite.exec(`CREATE TABLE IF NOT EXISTS message_reactions(
      id INTEGER PRIMARY KEY AUTOINCREMENT, message_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL, emoji TEXT NOT NULL, created_at BIGINT NOT NULL,
      UNIQUE(message_id, user_id))`);
    lite.exec(`CREATE TABLE IF NOT EXISTS call_participants(
      id INTEGER PRIMARY KEY AUTOINCREMENT, call_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'invited',
      joined_at BIGINT, UNIQUE(call_id, user_id))`);
    // v1.58 : recherche par image (hash perceptuel)
    lite.exec(`CREATE TABLE IF NOT EXISTS verification_requests(
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'pending',
      reason TEXT NOT NULL DEFAULT '', created_at BIGINT NOT NULL, reviewed_at BIGINT)`);
    for (const col of ['full_name','category','website','proof_links','activity','id_doc_url','reviewed_by','review_reason']) {
      try { lite.exec(`ALTER TABLE verification_requests ADD COLUMN ${col} TEXT DEFAULT ''`); } catch (_) {}
    }
    lite.exec(`CREATE TABLE IF NOT EXISTS pk_battles(
      id INTEGER PRIMARY KEY AUTOINCREMENT, live_a_id INTEGER NOT NULL, live_b_id INTEGER NOT NULL,
      user_a_id INTEGER NOT NULL, user_b_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', score_a INTEGER NOT NULL DEFAULT 0,
      score_b INTEGER NOT NULL DEFAULT 0, winner_id INTEGER,
      created_at BIGINT NOT NULL, starts_at BIGINT, ends_at BIGINT)`);
    // FIX 2026-10-05 (audit DB) : live_goals n'existait que sur Postgres → 500 "no such table"
    // sur SQLite local pour POST /api/live/:id/goal et GET /api/live/:id/goals
    lite.exec(`CREATE TABLE IF NOT EXISTS live_goals(
      id INTEGER PRIMARY KEY AUTOINCREMENT, live_id INTEGER NOT NULL, title TEXT NOT NULL,
      target_coins INTEGER NOT NULL, created_at BIGINT NOT NULL)`);
    lite.exec(`CREATE TABLE IF NOT EXISTS calls(
      id INTEGER PRIMARY KEY AUTOINCREMENT, caller_id INTEGER NOT NULL, callee_id INTEGER NOT NULL,
      ctype TEXT NOT NULL DEFAULT 'video', status TEXT NOT NULL DEFAULT 'ringing',
      created_at BIGINT NOT NULL, ended_at BIGINT)`);
    lite.exec(`CREATE TABLE IF NOT EXISTS call_signals(
      id INTEGER PRIMARY KEY AUTOINCREMENT, call_id INTEGER NOT NULL, to_user_id INTEGER NOT NULL,
      from_user_id INTEGER NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL,
      created_at BIGINT NOT NULL)`);
    lite.exec(`CREATE TABLE IF NOT EXISTS search_logs(
      id INTEGER PRIMARY KEY AUTOINCREMENT, query TEXT NOT NULL, user_id INTEGER,
      created_at BIGINT NOT NULL)`);
    { const vc2 = lite.prepare(`PRAGMA table_info(videos)`).all().map(c => c.name);
    if (!vc2.includes('target_countries')) lite.exec(`ALTER TABLE videos ADD COLUMN target_countries TEXT DEFAULT ''`);
    const uc = lite.prepare(`PRAGMA table_info(users)`).all().map(c => c.name);
    if (!uc.includes('country')) lite.exec(`ALTER TABLE users ADD COLUMN country TEXT DEFAULT ''`); }
    { const vc = lite.prepare(`PRAGMA table_info(videos)`).all().map(c => c.name);
      if (!vc.includes('phash')) lite.exec(`ALTER TABLE videos ADD COLUMN phash TEXT DEFAULT ''`); }
    for (const c of ['first_name', 'last_name', 'birthdate']) {
      if (!cols.includes(c)) lite.exec(`ALTER TABLE users ADD COLUMN ${c} TEXT DEFAULT ''`);
    }
    for (const c of ['ref_code']) {
      if (!cols.includes(c)) lite.exec(`ALTER TABLE users ADD COLUMN ${c} TEXT`);
    }
    if (!cols.includes('referred_by')) lite.exec(`ALTER TABLE users ADD COLUMN referred_by INTEGER`);
    lite.exec(`CREATE UNIQUE INDEX IF NOT EXISTS users_email_uidx ON users(email)`);
    lite.exec(`CREATE UNIQUE INDEX IF NOT EXISTS users_google_uidx ON users(google_id)`);
    lite.exec(`CREATE UNIQUE INDEX IF NOT EXISTS users_phone_uidx ON users(phone)`);
    lite.exec(`CREATE TABLE IF NOT EXISTS oauth_sessions(session TEXT PRIMARY KEY, token TEXT NOT NULL, user_id INTEGER NOT NULL, created_at BIGINT NOT NULL)`);
    lite.exec(`CREATE TABLE IF NOT EXISTS password_resets(email TEXT NOT NULL, code TEXT NOT NULL, expires_at BIGINT NOT NULL, created_at BIGINT NOT NULL)`);
    lite.exec(`CREATE INDEX IF NOT EXISTS password_resets_email_idx ON password_resets(email)`);
  }
  // backfill : code parrain unique pour les comptes existants qui n'en ont pas
  try {
    const missing = USE_PG
      ? (await pool.query(`SELECT id FROM users WHERE ref_code IS NULL OR ref_code=''`)).rows
      : lite.prepare(`SELECT id FROM users WHERE ref_code IS NULL OR ref_code=''`).all();
    for (const m of missing) {
      let code = null;
      for (let i = 0; i < 20 && !code; i++) {
        const c = genRefCode();
        const ex = USE_PG
          ? (await pool.query(`SELECT 1 FROM users WHERE ref_code=$1`, [c])).rows[0]
          : lite.prepare(`SELECT 1 FROM users WHERE ref_code=?`).get(c);
        if (!ex) code = c;
      }
      if (code) {
        if (USE_PG) await pool.query(`UPDATE users SET ref_code=$1 WHERE id=$2`, [code, m.id]);
        else lite.prepare(`UPDATE users SET ref_code=? WHERE id=?`).run(code, m.id);
      }
    }
  } catch (e) {}
  // migrations phase 2 : nouvelles colonnes vidéos / commentaires
  const mig = async (table, column, def) => {
    try {
      if (USE_PG) await pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${def}`);
      else lite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
    } catch (e) {}
  };
  await mig('videos', 'sound', `TEXT NOT NULL DEFAULT ''`);
  await mig('videos', 'duration', `REAL NOT NULL DEFAULT 0`);
  await mig('videos', 'ad_views', `INTEGER NOT NULL DEFAULT 0`);
  await mig('id_verifications', 'expiry', `TEXT`);
  await mig('comments', 'likes', `INTEGER NOT NULL DEFAULT 0`);
  await mig('comments', 'pinned', `INTEGER NOT NULL DEFAULT 0`);
  // serveur v8 : publication programmée, badge vérifié, commentaires vidéo
  await mig('videos', 'scheduled_at', `BIGINT`);
  await mig('users', 'verified', `INTEGER NOT NULL DEFAULT 0`);
  await mig('comments', 'video_url', `TEXT`);
  // serveur v9 : modération MVP (vidéos masquées, comptes suspendus)
  await mig('videos', 'hidden', `INTEGER NOT NULL DEFAULT 0`);
  await mig('users', 'suspended', `INTEGER NOT NULL DEFAULT 0`);
  // v2.47 : source d'acquisition des abonnés (profil, vidéo, recherche, suggestion, qr, live)
  await mig('follows', 'source', `TEXT NOT NULL DEFAULT 'other'`);
  // serveur v13 : replay LIVE, TTS, commentaires audio, Q&A, collections partagées
  await mig('videos', 'is_replay', `INTEGER NOT NULL DEFAULT 0`);
  await mig('videos', 'live_id', `TEXT`);
  await mig('videos', 'tts_text', `TEXT`);
  await mig('videos', 'tts_voice', `TEXT`);
  await mig('videos', 'tts_rate', `REAL NOT NULL DEFAULT 1`);
  // analytics v2.39 : source du trafic des vues (feed|following|search|profile|deeplink|other)
  await mig('video_views', 'source', `TEXT NOT NULL DEFAULT 'feed'`);
  // v2.39 : la sanction appliquée lors du traitement d'un signalement (pour les appels)
  await mig('reports', 'action', `TEXT NOT NULL DEFAULT ''`);
  await mig('comments', 'audio_url', `TEXT`);
  await mig('qa_questions', 'asker_id', `INTEGER`);
  // v1.84 : fonctionnalités TikTok — historique recherche, épingles, duos/collages,
  // permissions vidéo, brouillons, demandes de messages, modérateurs live,
  // statut d'activité, mode restreint, préférences notifications, effets, lieux
  await mig('videos', 'duet_of', `INTEGER NOT NULL DEFAULT 0`);
  await mig('videos', 'stitch_of', `INTEGER NOT NULL DEFAULT 0`);
  // FIX 2026-10-04 : colonnes réponse-vidéo manquantes côté SQLite (n'existaient que dans le chemin Postgres)
  await mig('videos', 'reply_to_comment_id', `INTEGER NOT NULL DEFAULT 0`);
  await mig('comments', 'video_reply_id', `INTEGER NOT NULL DEFAULT 0`);
  await mig('videos', 'allow_duet', `INTEGER NOT NULL DEFAULT 1`);
  await mig('videos', 'allow_stitch', `INTEGER NOT NULL DEFAULT 1`);
  await mig('videos', 'allow_download', `INTEGER NOT NULL DEFAULT 1`);
  await mig('videos', 'allow_comments', `INTEGER NOT NULL DEFAULT 1`);
  await mig('videos', 'location', `TEXT NOT NULL DEFAULT ''`);
  await mig('videos', 'effect', `TEXT NOT NULL DEFAULT ''`);
  await mig('videos', 'sound_id', `INTEGER NOT NULL DEFAULT 0`);
  await mig('effects', 'category', `TEXT NOT NULL DEFAULT ''`);
  await mig('effects', 'css', `TEXT NOT NULL DEFAULT ''`);
  await mig('videos', 'is_private', `INTEGER NOT NULL DEFAULT 0`);
  // FIX 2026-10-04 (bot chain-profile-full) : la colonne users.is_private n'existait pas —
  // PATCH /api/auth/me {is_private} plantait (no such column) et le masquage privé ne marchait pas
  await mig('users', 'is_private', `INTEGER NOT NULL DEFAULT 0`);
  await mig('videos', 'visibility', `TEXT NOT NULL DEFAULT 'public'`);
  await mig('users', 'last_seen', `BIGINT NOT NULL DEFAULT 0`);
  await mig('users', 'activity_status', `TEXT NOT NULL DEFAULT 'public'`);
  await mig('users', 'restricted_mode', `INTEGER NOT NULL DEFAULT 0`);
  await mig('users', 'notif_likes', `INTEGER NOT NULL DEFAULT 1`);
  await mig('users', 'notif_comments', `INTEGER NOT NULL DEFAULT 1`);
  await mig('users', 'notif_follows', `INTEGER NOT NULL DEFAULT 1`);
  await mig('users', 'notif_mentions', `INTEGER NOT NULL DEFAULT 1`);
  await mig('users', 'notif_lives', `INTEGER NOT NULL DEFAULT 1`);
  // v2.34 : alertes de connexion (login_alert) + mémoire de la dernière IP de connexion
  await mig('users', 'notif_loginalert', `INTEGER NOT NULL DEFAULT 1`);
  // v2.41 (bots chain-notif-quiet / chain-notif-priority) : heures silencieuses (0-23, NULL=désactivé) + tri par priorité des notifs
  await mig('users', 'quiet_start', `INTEGER`);
  await mig('users', 'quiet_end', `INTEGER`);
  await mig('users', 'notif_priority', `INTEGER NOT NULL DEFAULT 1`);
  await mig('users', 'last_login_ip', `TEXT NOT NULL DEFAULT ''`);
  // v2.41 : notif "nouvelle vidéo" pour les abonnés quand un suivi publie
  await mig('users', 'notif_newvideos', `INTEGER NOT NULL DEFAULT 1`);
  await mig('users', 'dm_privacy', `TEXT NOT NULL DEFAULT 'everyone'`);
  // PARITÉ TIKTOK 2026-10-04 : politiques duo/collage par compte + PIN mode restreint + flag sensible
  await mig('users', 'duet_policy', `TEXT NOT NULL DEFAULT 'everyone'`);
  await mig('users', 'stitch_policy', `TEXT NOT NULL DEFAULT 'everyone'`);
  await mig('users', 'restricted_pin', `TEXT NOT NULL DEFAULT ''`);
  await mig('videos', 'sensitive', `INTEGER NOT NULL DEFAULT 0`);  await mig('users', 'comment_privacy', `TEXT NOT NULL DEFAULT 'everyone'`);
  await mig('users', 'mention_privacy', `TEXT NOT NULL DEFAULT 'everyone'`);
  await mig('users', 'download_privacy', `TEXT NOT NULL DEFAULT 'everyone'`);
  await mig('users', 'liked_visibility', `TEXT NOT NULL DEFAULT 'me'`);
  await mig('users', 'following_visibility', `TEXT NOT NULL DEFAULT 'me'`);
  // v2.32 : graphe social — synchronisation des contacts (hash de téléphone)
  await mig('users', 'phone_hash', `TEXT NOT NULL DEFAULT ''`);
  // v2.38 (bots découverte) : hashtag sur les défis créateurs + scores de tags « Pour toi » (signal likes)
  await mig('challenges', 'hashtag', `TEXT NOT NULL DEFAULT ''`);
  // v2.40 (bots profil/social avancés) : bannière profil, pronoms, liens
  await mig('users', 'cover', `TEXT NOT NULL DEFAULT ''`);
  await mig('users', 'pronouns', `TEXT NOT NULL DEFAULT ''`);
  await mig('users', 'links', `TEXT NOT NULL DEFAULT '[]'`);
  try {
    const _frt = `CREATE TABLE IF NOT EXISTS follow_requests(id ${USE_PG ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'}, requester_id INTEGER NOT NULL, target_id INTEGER NOT NULL, created_at BIGINT NOT NULL, UNIQUE(requester_id, target_id))`;
    if (USE_PG) await pool.query(_frt); else lite.exec(_frt);
  } catch (e) {}
  try {
    const _ubt = `CREATE TABLE IF NOT EXISTS user_badges(id ${USE_PG ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'}, user_id INTEGER NOT NULL, badge TEXT NOT NULL, awarded_at BIGINT NOT NULL, UNIQUE(user_id, badge))`;
    if (USE_PG) await pool.query(_ubt); else lite.exec(_ubt);
  } catch (e) {}
  // v2.41 : compteur de clics sur les liens du profil (bots profil avancés)
  try {
    const _lct = `CREATE TABLE IF NOT EXISTS link_clicks(user_id INTEGER NOT NULL, url TEXT NOT NULL, clicks INTEGER NOT NULL DEFAULT 0, updated_at BIGINT NOT NULL, UNIQUE(user_id, url))`;
    if (USE_PG) await pool.query(_lct); else lite.exec(_lct);
  } catch (e) {}
  try {
    const _sht = `CREATE TABLE IF NOT EXISTS suggestion_hidden(user_id INTEGER NOT NULL, hidden_id INTEGER NOT NULL, created_at BIGINT NOT NULL, PRIMARY KEY(user_id, hidden_id))`;
    if (USE_PG) await pool.query(_sht); else lite.exec(_sht);
  } catch (e) {}
  try {
    const _uts = `CREATE TABLE IF NOT EXISTS user_tag_scores(user_id INTEGER NOT NULL, tag TEXT NOT NULL, score INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(user_id, tag))`;
    if (USE_PG) await pool.query(_uts); else lite.exec(_uts);
  } catch (e) {}
  // Tables TikTok
  if (USE_PG) {
    await pool.query(`CREATE TABLE IF NOT EXISTS video_pins(
      id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL, video_id INTEGER NOT NULL,
      pinned_at BIGINT NOT NULL, UNIQUE(user_id, video_id))`);
    await pool.query(`CREATE TABLE IF NOT EXISTS video_drafts(
      id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL, video_url TEXT NOT NULL DEFAULT '',
      thumb_url TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '',
      created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS message_requests(
      id SERIAL PRIMARY KEY, from_user_id INTEGER NOT NULL, to_user_id INTEGER NOT NULL,
      text TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending',
      created_at BIGINT NOT NULL)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS live_moderators(
      id SERIAL PRIMARY KEY, live_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
      added_at BIGINT NOT NULL, UNIQUE(live_id, user_id))`);
    // v2.33 : bannissements / sourdines d'un live (kind='ban'|'mute') — imposés par l'hôte ou un modérateur
    await pool.query(`CREATE TABLE IF NOT EXISTS live_bans(
      id SERIAL PRIMARY KEY, live_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
      kind TEXT NOT NULL DEFAULT 'ban', created_at BIGINT NOT NULL,
      UNIQUE(live_id, user_id, kind))`);
    await pool.query(`CREATE TABLE IF NOT EXISTS content_prefs(
      id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL, topic TEXT NOT NULL,
      pref TEXT NOT NULL DEFAULT 'more', created_at BIGINT NOT NULL,
      UNIQUE(user_id, topic))`);
    await pool.query(`CREATE TABLE IF NOT EXISTS effects(
      id SERIAL PRIMARY KEY, name TEXT NOT NULL, icon_url TEXT NOT NULL DEFAULT '',
      use_count INTEGER NOT NULL DEFAULT 0, created_at BIGINT NOT NULL)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_vpins_user ON video_pins(user_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_drafts_user ON video_drafts(user_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_msgreq_to ON message_requests(to_user_id, status)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_effects_name ON effects(name)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS effect_favs(
      id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL, effect_id INTEGER NOT NULL,
      created_at BIGINT NOT NULL, UNIQUE(user_id, effect_id))`);
  } else {
    lite.exec(`CREATE TABLE IF NOT EXISTS video_pins(
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, video_id INTEGER NOT NULL,
      pinned_at BIGINT NOT NULL, UNIQUE(user_id, video_id))`);
    lite.exec(`CREATE TABLE IF NOT EXISTS video_drafts(
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, video_url TEXT NOT NULL DEFAULT '',
      thumb_url TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '',
      created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL)`);
    lite.exec(`CREATE TABLE IF NOT EXISTS message_requests(
      id INTEGER PRIMARY KEY AUTOINCREMENT, from_user_id INTEGER NOT NULL, to_user_id INTEGER NOT NULL,
      text TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending',
      created_at BIGINT NOT NULL)`);
    lite.exec(`CREATE TABLE IF NOT EXISTS live_moderators(
      id INTEGER PRIMARY KEY AUTOINCREMENT, live_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
      added_at BIGINT NOT NULL, UNIQUE(live_id, user_id))`);
    // v2.33 : bannissements / sourdines d'un live (kind='ban'|'mute') — imposés par l'hôte ou un modérateur
    lite.exec(`CREATE TABLE IF NOT EXISTS live_bans(
      id INTEGER PRIMARY KEY AUTOINCREMENT, live_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
      kind TEXT NOT NULL DEFAULT 'ban', created_at BIGINT NOT NULL,
      UNIQUE(live_id, user_id, kind))`);
    lite.exec(`CREATE TABLE IF NOT EXISTS content_prefs(
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, topic TEXT NOT NULL,
      pref TEXT NOT NULL DEFAULT 'more', created_at BIGINT NOT NULL,
      UNIQUE(user_id, topic))`);
    lite.exec(`CREATE TABLE IF NOT EXISTS effects(
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, icon_url TEXT NOT NULL DEFAULT '',
      use_count INTEGER NOT NULL DEFAULT 0, created_at BIGINT NOT NULL)`);
    lite.exec(`CREATE TABLE IF NOT EXISTS effect_favs(
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, effect_id INTEGER NOT NULL,
      created_at BIGINT NOT NULL, UNIQUE(user_id, effect_id))`);
  }
  // v2.32 : graphe social — invitations personnalisées + traces d'invitations par contacts
  if (USE_PG) {
    await pool.query(`CREATE TABLE IF NOT EXISTS invites(
      id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL, code TEXT UNIQUE NOT NULL,
      label TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending',
      invited_user_id INTEGER, created_at BIGINT NOT NULL)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS contact_invites(
      id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL, phone_hash TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '', created_at BIGINT NOT NULL,
      UNIQUE(user_id, phone_hash))`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_invites_user ON invites(user_id)`);
  } else {
    lite.exec(`CREATE TABLE IF NOT EXISTS invites(
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, code TEXT UNIQUE NOT NULL,
      label TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending',
      invited_user_id INTEGER, created_at BIGINT NOT NULL)`);
    lite.exec(`CREATE TABLE IF NOT EXISTS contact_invites(
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, phone_hash TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '', created_at BIGINT NOT NULL,
      UNIQUE(user_id, phone_hash))`);
    lite.exec(`CREATE INDEX IF NOT EXISTS idx_invites_user ON invites(user_id)`);
  }
  // Tables Q&A
  if (USE_PG) {
    await pool.query(`CREATE TABLE IF NOT EXISTS qa_questions(
      id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL, asker_id INTEGER,
      question TEXT NOT NULL, answer TEXT,
      created_at BIGINT NOT NULL, answered_at BIGINT
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS shared_collections(
      id SERIAL PRIMARY KEY, owner_id INTEGER NOT NULL,
      name TEXT NOT NULL, code TEXT UNIQUE NOT NULL,
      created_at BIGINT NOT NULL
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS shared_collection_members(
      collection_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
      joined_at BIGINT NOT NULL, PRIMARY KEY(collection_id, user_id)
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS shared_collection_videos(
      collection_id INTEGER NOT NULL, video_id INTEGER NOT NULL,
      added_by INTEGER NOT NULL, added_at BIGINT NOT NULL,
      PRIMARY KEY(collection_id, video_id)
    )`);
  } else {
    lite.exec(`CREATE TABLE IF NOT EXISTS qa_questions(
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, asker_id INTEGER,
      question TEXT NOT NULL, answer TEXT,
      created_at BIGINT NOT NULL, answered_at BIGINT
    )`);
    lite.exec(`CREATE TABLE IF NOT EXISTS shared_collections(
      id INTEGER PRIMARY KEY AUTOINCREMENT, owner_id INTEGER NOT NULL,
      name TEXT NOT NULL, code TEXT UNIQUE NOT NULL,
      created_at BIGINT NOT NULL
    )`);
    lite.exec(`CREATE TABLE IF NOT EXISTS shared_collection_members(
      collection_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
      joined_at BIGINT NOT NULL, PRIMARY KEY(collection_id, user_id)
    )`);
    lite.exec(`CREATE TABLE IF NOT EXISTS shared_collection_videos(
      collection_id INTEGER NOT NULL, video_id INTEGER NOT NULL,
      added_by INTEGER NOT NULL, added_at BIGINT NOT NULL,
      PRIMARY KEY(collection_id, video_id)
    )`);
  }
  // v2.37 : historique des vues de profil (une ligne par couple viewer/viewed)
  if (USE_PG) {
    await pool.query(`CREATE TABLE IF NOT EXISTS profile_views(
      viewer_id INTEGER NOT NULL, viewed_id INTEGER NOT NULL,
      viewed_at BIGINT NOT NULL,
      PRIMARY KEY(viewer_id, viewed_id)
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_pv_viewed ON profile_views(viewed_id)`);
  } else {
    lite.exec(`CREATE TABLE IF NOT EXISTS profile_views(
      viewer_id INTEGER NOT NULL, viewed_id INTEGER NOT NULL,
      viewed_at BIGINT NOT NULL,
      PRIMARY KEY(viewer_id, viewed_id)
    )`);
    lite.exec(`CREATE INDEX IF NOT EXISTS idx_pv_viewed ON profile_views(viewed_id)`);
  }
  // renommage desc -> description sur les anciennes bases (schéma v1)
  try {
    const hasDesc = USE_PG
      ? (await pool.query(`SELECT 1 FROM information_schema.columns WHERE table_name='videos' AND column_name='desc'`)).rowCount > 0
      : lite.prepare(`PRAGMA table_info(videos)`).all().some(c => c.name === 'desc');
    const hasDescription = USE_PG
      ? (await pool.query(`SELECT 1 FROM information_schema.columns WHERE table_name='videos' AND column_name='description'`)).rowCount > 0
      : lite.prepare(`PRAGMA table_info(videos)`).all().some(c => c.name === 'description');
    if (hasDesc && !hasDescription) {
      if (USE_PG) await pool.query(`ALTER TABLE videos RENAME COLUMN desc TO description`);
      else lite.exec(`ALTER TABLE videos RENAME COLUMN desc TO description`);
    }
  } catch (e) {}
  // serveur v10 : stories durcies, live, sons, pourboires, abonnements payants
  await mig('stories', 'privacy', `TEXT NOT NULL DEFAULT 'public'`);
  await mig('stories', 'text', `TEXT NOT NULL DEFAULT ''`);
  // FIX 2026-10-05 (audit DB) : videos.visibility déjà migré plus haut — doublon supprimé
  await mig('lives', 'peak_viewers', `INTEGER NOT NULL DEFAULT 0`);
  await mig('lives', 'duration_s', `INTEGER NOT NULL DEFAULT 0`);
  await mig('lives', 'gifts_total', `INTEGER NOT NULL DEFAULT 0`);
  await mig('lives', 'chat_total', `INTEGER NOT NULL DEFAULT 0`);
  // v2.38 : mode Q&R live + effet en direct
  await mig('lives', 'qa_mode', `INTEGER NOT NULL DEFAULT 0`);
  await mig('lives', 'current_effect', `TEXT NOT NULL DEFAULT ''`);
  await mig('gifts', 'live_id', `INTEGER`);
  await mig('gifts', 'thanked', `INTEGER NOT NULL DEFAULT 0`); // v2.37 : remerciement cadeau
  // SPEC-13 : paliers d'abonnement — palier choisi + renouvellement auto
  await mig('creator_subs', 'tier_id', `INTEGER`);
  await mig('creator_subs', 'auto_renew', `INTEGER NOT NULL DEFAULT 1`);
  // SPEC-14 : compte protégé (13-15 ans) + accord parental
  await mig('users', 'teen_protected', `INTEGER NOT NULL DEFAULT 0`);
  await mig('users', 'parental_consent', `INTEGER NOT NULL DEFAULT 0`);
  // SPEC-12 : mode audio seul pour les invités live
  await mig('live_guests', 'mode', `TEXT NOT NULL DEFAULT 'video'`);
  // Login Facebook (gratuit) : identifiant Facebook lié au compte
  await mig('users', 'facebook_id', `TEXT`);
  // v2.33 : épinglage d'un message du chat live (live_chat.pinned)
  await mig('live_chat', 'pinned', `INTEGER NOT NULL DEFAULT 0`);
  // serveur v11 (V3) : boutique, live shopping, publicité, modération auto
  await mig('users', 'seller_name', `TEXT NOT NULL DEFAULT ''`);
  await mig('users', 'seller_bio', `TEXT NOT NULL DEFAULT ''`);
  await mig('users', 'seller_verified', `INTEGER NOT NULL DEFAULT 0`);
  // v2.42 (bots ads/business) : comptes professionnels
  await mig('users', 'account_type', `TEXT NOT NULL DEFAULT 'personal'`);
  await mig('users', 'company_name', `TEXT NOT NULL DEFAULT ''`);
  await mig('users', 'contact_email', `TEXT NOT NULL DEFAULT ''`);
  try {
    const _pct = `CREATE TABLE IF NOT EXISTS promo_credits(id ${USE_PG ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'}, user_id INTEGER NOT NULL, coins INTEGER NOT NULL, reason TEXT NOT NULL DEFAULT '', expires_at BIGINT NOT NULL, used_coins INTEGER NOT NULL DEFAULT 0, created_at BIGINT NOT NULL)`;
    if (USE_PG) await pool.query(_pct); else lite.exec(_pct);
  } catch (e) {}
  await mig('videos', 'review_status', `TEXT NOT NULL DEFAULT 'ok'`);
  await mig('comments', 'review_status', `TEXT NOT NULL DEFAULT 'ok'`);
  // serveur v12 : photos, filtres commentaires, séries payantes, algo, famille
  await mig('videos', 'media_type', `TEXT NOT NULL DEFAULT 'video'`);
  await mig('videos', 'photos', `TEXT NOT NULL DEFAULT '[]'`);
  await mig('videos', 'captions', `TEXT NOT NULL DEFAULT '[]'`);
  await mig('videos', 'series_id', `INTEGER`);
  // V13 (TikTok Studio) : collaboration — vidéo co-signée par 2 créateurs
  await mig('videos', 'co_creator_id', `INTEGER NOT NULL DEFAULT 0`);
  await mig('users', 'comment_keywords', `TEXT NOT NULL DEFAULT '[]'`);
  // v2.38 : "Ne pas suggérer mon compte" — exclusion des suggestions d'amis
  await mig('users', 'discoverable', `INTEGER NOT NULL DEFAULT 1`);
  try {
    if (USE_PG) await pool.query('CREATE INDEX IF NOT EXISTS watch_events_user_video_idx ON watch_events(user_id,video_id)');
    else lite.exec('CREATE INDEX IF NOT EXISTS watch_events_user_video_idx ON watch_events(user_id,video_id)');
  } catch (e) {}
  // FIX 2026-10-05 (audit DB) : index manquants sur les requêtes les plus chaudes —
  // sans eux, Postgres fait un seq scan sur des tables à millions de lignes
  // (profils, compteurs d'abonnés/likes/commentaires, historique wallet, chat).
  for (const idxSql of [
    'CREATE INDEX IF NOT EXISTS idx_videos_user ON videos(user_id)',
    'CREATE INDEX IF NOT EXISTS idx_videos_created ON videos(created_at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_follows_followed ON follows(followed_id)',
    'CREATE INDEX IF NOT EXISTS idx_follows_follower ON follows(follower_id)',
    'CREATE INDEX IF NOT EXISTS idx_likes_video ON likes(video_id)',
    'CREATE INDEX IF NOT EXISTS idx_comments_video ON comments(video_id)',
    'CREATE INDEX IF NOT EXISTS idx_video_views_video ON video_views(video_id)',
    'CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id)',
    'CREATE INDEX IF NOT EXISTS idx_ledger_user ON ledger(user_id)',
    'CREATE INDEX IF NOT EXISTS idx_notifications_actor ON notifications(actor_id)',
    'CREATE INDEX IF NOT EXISTS idx_gifts_live ON gifts(live_id)',
    'CREATE INDEX IF NOT EXISTS idx_tips_to ON tips(to_user_id)',
  ]) {
    try { if (USE_PG) await pool.query(idxSql); else lite.exec(idxSql); } catch (e) {}
  }
  // v2.48 (bots chaîne vague 3 — 2026-10-05) : tables des 10 features
  // analytics-pro (sources de trafic), chapitres, suivi hashtags, filtres mots-clés,
  // nudges rétention, hors-ligne, premieres, traductions, commissions vidéo-shopping
  const _specTables = [
    `CREATE TABLE IF NOT EXISTS video_view_sources(
      id ${USE_PG ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
      video_id INTEGER NOT NULL, user_id INTEGER, source TEXT NOT NULL DEFAULT 'other',
      created_at BIGINT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS video_chapters(
      id ${USE_PG ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
      video_id INTEGER NOT NULL, title TEXT NOT NULL DEFAULT '',
      starts_at_sec INTEGER NOT NULL DEFAULT 0, created_at BIGINT NOT NULL,
      UNIQUE(video_id, starts_at_sec))`,
    `CREATE TABLE IF NOT EXISTS hashtag_follows(
      user_id INTEGER NOT NULL, tag TEXT NOT NULL,
      last_seen_at BIGINT NOT NULL DEFAULT 0, created_at BIGINT NOT NULL,
      PRIMARY KEY(user_id, tag))`,
    `CREATE TABLE IF NOT EXISTS comment_keyword_filters(
      id ${USE_PG ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
      user_id INTEGER NOT NULL, keyword TEXT NOT NULL,
      created_at BIGINT NOT NULL, UNIQUE(user_id, keyword))`,
    `CREATE TABLE IF NOT EXISTS comment_hold(
      id ${USE_PG ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
      comment_id INTEGER NOT NULL UNIQUE, video_id INTEGER NOT NULL,
      author_id INTEGER NOT NULL, owner_id INTEGER NOT NULL,
      keyword TEXT NOT NULL DEFAULT '', created_at BIGINT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS retention_nudges(
      id ${USE_PG ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
      user_id INTEGER NOT NULL, kind TEXT NOT NULL,
      scheduled_at BIGINT NOT NULL, sent_at BIGINT, created_at BIGINT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS offline_downloads(
      user_id INTEGER NOT NULL, video_id INTEGER NOT NULL, created_at BIGINT NOT NULL,
      PRIMARY KEY(user_id, video_id))`,
    `CREATE TABLE IF NOT EXISTS premieres(
      id ${USE_PG ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
      video_id INTEGER NOT NULL UNIQUE, creator_id INTEGER NOT NULL,
      scheduled_at BIGINT NOT NULL, status TEXT NOT NULL DEFAULT 'scheduled',
      created_at BIGINT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS premiere_reminders(
      video_id INTEGER NOT NULL, user_id INTEGER NOT NULL, created_at BIGINT NOT NULL,
      PRIMARY KEY(video_id, user_id))`,
    `CREATE TABLE IF NOT EXISTS premiere_chat(
      id ${USE_PG ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
      video_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
      text TEXT NOT NULL DEFAULT '', created_at BIGINT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS video_translations(
      id ${USE_PG ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
      video_id INTEGER NOT NULL, lang TEXT NOT NULL,
      text TEXT NOT NULL DEFAULT '', source_hash TEXT NOT NULL DEFAULT '',
      created_at BIGINT NOT NULL, UNIQUE(video_id, lang))`,
    `CREATE TABLE IF NOT EXISTS translation_quota(
      user_id INTEGER NOT NULL, day TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(user_id, day))`,
    `CREATE TABLE IF NOT EXISTS video_sale_commissions(
      id ${USE_PG ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT'},
      order_id INTEGER NOT NULL, video_id INTEGER NOT NULL,
      creator_id INTEGER NOT NULL, coins INTEGER NOT NULL DEFAULT 0,
      refunded INTEGER NOT NULL DEFAULT 0, created_at BIGINT NOT NULL)`,
  ];
  for (const tSql of _specTables) {
    try { if (USE_PG) await pool.query(tSql); else lite.exec(tSql); } catch (e) {}
  }
  for (const idxSql of [
    'CREATE INDEX IF NOT EXISTS idx_vvs_video ON video_view_sources(video_id)',
    'CREATE INDEX IF NOT EXISTS idx_vvs_created ON video_view_sources(created_at)',
    'CREATE INDEX IF NOT EXISTS idx_chapters_video ON video_chapters(video_id)',
    'CREATE INDEX IF NOT EXISTS idx_hf_user ON hashtag_follows(user_id)',
    'CREATE INDEX IF NOT EXISTS idx_ckf_user ON comment_keyword_filters(user_id)',
    'CREATE INDEX IF NOT EXISTS idx_chold_owner ON comment_hold(owner_id)',
    'CREATE INDEX IF NOT EXISTS idx_nudges_user ON retention_nudges(user_id)',
    'CREATE INDEX IF NOT EXISTS idx_od_user ON offline_downloads(user_id)',
    'CREATE INDEX IF NOT EXISTS idx_prem_status ON premieres(status, scheduled_at)',
    'CREATE INDEX IF NOT EXISTS idx_premrem_video ON premiere_reminders(video_id)',
    'CREATE INDEX IF NOT EXISTS idx_vt_video ON video_translations(video_id)',
    'CREATE INDEX IF NOT EXISTS idx_vsc_creator ON video_sale_commissions(creator_id)',
  ]) {
    try { if (USE_PG) await pool.query(idxSql); else lite.exec(idxSql); } catch (e) {}
  }
  // v2.48 (bots chaîne vague 3) : nouvelles colonnes
  await mig('users', 'comment_filter_mode', `TEXT NOT NULL DEFAULT 'off'`); // off|hold|hide
  await mig('users', 'nudge_optout', `INTEGER NOT NULL DEFAULT 0`);
  await mig('users', 'tz_offset', `INTEGER NOT NULL DEFAULT 0`); // décalage minutes vs UTC (client)
  await mig('videos', 'desc_hash', `TEXT NOT NULL DEFAULT ''`);
  await mig('retention_nudges', 'meta', `TEXT NOT NULL DEFAULT ''`); // SPEC-08 : métadonnées du nudge (autre ingé.)
  await mig('retention_nudges', 'opened_at', `BIGINT NOT NULL DEFAULT 0`); // SPEC-08 : suivi d'ouverture
  await mig('videos', 'lang', `TEXT NOT NULL DEFAULT 'fr'`); // SPEC-04 : langue d'origine de la vidéo
  await mig('offline_downloads', 'file_size', `INTEGER NOT NULL DEFAULT 0`); // SPEC-01 : taille du fichier local
  await mig('orders', 'source_video_id', `INTEGER`);
  // FIX 2026-10-05 (audit DB) : bloc de migrations dupliqué supprimé — is_replay, live_id,
  // tts_text, tts_voice, tts_rate étaient déjà migrés plus haut (avec des types TEXT) ;
  // la 2e passe ne faisait rien (colonne déjà existante) et créait une ambiguïté de type.
  // catégories de boutique par défaut
  try {
    const n = await get1('SELECT COUNT(*) AS c FROM categories');
    if (!Number(n.c)) {
      for (const c of ['Mode', 'Beauté', 'Électronique', 'Maison', 'Sport', 'Alimentation', 'Jouets', 'Autre']) {
        await runSql('INSERT INTO categories(name) VALUES(?)', c);
      }
    }
  } catch (e) {}
}

// ---------- v1.67 : PROGRAMME DE MONÉTISATION ----------
// Règles de Kewin :
// - TOUS les pays sont éligibles (aucune restriction géographique)
// - Revenu = pubs diffusées sur la vidéo × 50% créateur
// - Plus la vidéo est longue, nette, haute qualité, retient les gens → plus de pubs → plus de gains
// - Plus la vidéo est virale → plus de gains
// - MAIS : vidéo virale SANS pub = ZÉRO revenu
const MONET_MIN_FOLLOWERS = 1000;
const MONET_MIN_VIEWS = 50000;

// score de qualité d'une vidéo (détermine la priorité de diffusion des pubs)
async function videoQualityScore(v) {
  let score = 50; // base
  // longueur : plus c'est long, plus il y a de slots pubs (max 10 min)
  const dur = Number(v.duration) || 0;
  if (dur >= 600) score += 25;
  else if (dur >= 180) score += 18;
  else if (dur >= 60) score += 12;
  else if (dur >= 30) score += 6;
  // rétention : % moyen regardé (depuis watch_events)
  try {
    const wr = await get1(`SELECT AVG(completed) AS r, COUNT(*) AS n FROM watch_events WHERE video_id=?`, v.id);
    if (wr && Number(wr.n) >= 5) score += Math.round(Number(wr.r || 0) * 20); // 0-20 pts
  } catch (_) {}
  // engagement : likes / vues
  const views = Number(v.views) || 0;
  const likes = Number(v.likes) || 0;
  if (views > 100) {
    const eng = likes / views;
    if (eng > 0.1) score += 10; else if (eng > 0.05) score += 5;
  }
  // viralité : vues
  if (views >= 1000000) score += 15;
  else if (views >= 100000) score += 10;
  else if (views >= 10000) score += 5;
  return Math.min(100, Math.max(0, Math.round(score)));
}

// éligibilité monétisation : TOUS les pays ✅ + seuils + KYC
async function monetizationEligibility(userId) {
  const u = await get1('SELECT * FROM users WHERE id=?', userId);
  if (!u) return { eligible: false, reason: 'compte introuvable' };
  const followers = Number((await get1('SELECT COUNT(*) AS c FROM follows WHERE followed_id=?', userId)).c);
  const views = Number((await get1('SELECT COALESCE(SUM(views),0) AS s FROM videos WHERE user_id=? AND hidden=0', userId)).s);
  const kyc = await get1(`SELECT status FROM id_verifications WHERE user_id=?`, userId);
  const checks = {
    followers: { ok: followers >= MONET_MIN_FOLLOWERS, have: followers, need: MONET_MIN_FOLLOWERS },
    views: { ok: views >= MONET_MIN_VIEWS, have: views, need: MONET_MIN_VIEWS },
    kyc: { ok: !!(kyc && kyc.status === 'approved'), have: kyc ? kyc.status : 'none' },
    country: { ok: true, note: 'tous les pays éligibles' },
  };
  const eligible = checks.followers.ok && checks.views.ok && checks.kyc.ok;
  return { eligible, checks };
}

// distribution quotidienne des revenus pubs aux créateurs
// 50% du revenu pub du jour → réparti au prorata de (impressions pubs × score qualité)
async function distributeAdRevenue(dayStr) {
  try {
    const day = await get1('SELECT ad_revenue_usd FROM ad_daily WHERE day=?', dayStr);
    const revenue = day ? Number(day.ad_revenue_usd) || 0 : 0;
    if (revenue <= 0) return { day: dayStr, distributed: 0, note: 'aucun revenu pub' };
    const creatorPool = revenue * 0.5;
    // impressions pubs du jour par vidéo (avec score qualité)
    const rows = await allRows(`SELECT ai.video_id, COUNT(*) AS imp, v.user_id AS creator_id
      FROM ad_impressions ai JOIN videos v ON v.id=ai.video_id
      WHERE ai.created_at >= ? AND ai.created_at < ? AND v.hidden=0
      GROUP BY ai.video_id, v.user_id`,
      new Date(dayStr + 'T00:00:00Z').getTime(), new Date(dayStr + 'T00:00:00Z').getTime() + 86400000);
    if (!rows.length) return { day: dayStr, distributed: 0, note: 'aucune impression pub' };
    // calcule le poids de chaque vidéo : impressions × score qualité
    let totalWeight = 0;
    const weighted = [];
    for (const r of rows) {
      const elig = await monetizationEligibility(r.creator_id);
      if (!elig.eligible) continue; // pas éligible → pas de gains
      const v = await get1('SELECT * FROM videos WHERE id=?', r.video_id);
      if (!v) continue;
      const q = await videoQualityScore(v);
      const w = Number(r.imp) * (0.5 + q / 100); // qualité booste le poids
      totalWeight += w;
      weighted.push({ ...r, weight: w, quality: q });
    }
    if (!weighted.length || totalWeight <= 0) return { day: dayStr, distributed: 0, note: 'aucune vidéo éligible' };
    let distributed = 0;
    for (const w of weighted) {
      const share = creatorPool * (w.weight / totalWeight);
      const coins = Math.floor(share * 500); // 1 USD = 500 pièces
      if (coins > 0) {
        // V13 : partage des revenus de collaboration — la part du co-créateur
        // (revenue_share_pct de l'invitation acceptée) lui est créditée directement.
        let coId = 0, coPct = 0;
        try {
          const vv = await get1('SELECT co_creator_id FROM videos WHERE id=?', w.video_id);
          if (vv && Number(vv.co_creator_id)) {
            const inv = await get1(`SELECT revenue_share_pct FROM collab_invites
              WHERE video_id=? AND invitee_id=? AND status='accepted' ORDER BY id DESC LIMIT 1`,
              w.video_id, vv.co_creator_id);
            if (inv && Number(inv.revenue_share_pct) > 0 && Number(inv.revenue_share_pct) < 100) {
              coId = Number(vv.co_creator_id); coPct = Number(inv.revenue_share_pct);
            }
          }
        } catch (_) {}
        const coCoins = coId ? Math.floor(coins * coPct / 100) : 0;
        const myCoins = coins - coCoins;
        await runSql('UPDATE users SET coins=coins+? WHERE id=?', myCoins, w.creator_id);
        await runSql('INSERT INTO ledger(user_id,amount,reason,created_at) VALUES(?,?,?,?)',
          w.creator_id, myCoins, coId ? 'revenu pub vidéo #' + w.video_id + ' (collab ' + (100 - coPct) + '%)' : 'revenu pub vidéo #' + w.video_id, now());
        if (coId && coCoins > 0) {
          await runSql('UPDATE users SET coins=coins+? WHERE id=?', coCoins, coId);
          await runSql('INSERT INTO ledger(user_id,amount,reason,created_at) VALUES(?,?,?,?)',
            coId, coCoins, 'revenu pub vidéo #' + w.video_id + ' (collab ' + coPct + '%)', now());
        }
        await runSql('UPDATE videos SET ad_revenue_usd=ad_revenue_usd+? WHERE id=?', share, w.video_id);
        distributed += share;
      }
      await runSql('UPDATE videos SET monetized_views=monetized_views+? WHERE id=?', Number(w.imp), w.video_id);
    }
    return { day: dayStr, revenue_usd: revenue, creator_pool_usd: creatorPool, distributed_usd: +distributed.toFixed(4), videos: weighted.length };
  } catch (e) { return { error: e.message }; }
}


// ---------- v1.65 : 🤖 BOT DE VÉRIFICATION ----------
// Le bot (pas l'admin) examine automatiquement :
// 1. les demandes de badge vérifié
// 2. les vérifications d'identité KYC (monétisation)
// 3. l'expiration des pièces : les pièces gagnées il y a 3 mois ou plus
//    sont expirées → tout retrait avec des pièces expirées est rejeté à l'immédiat.
const COIN_EXPIRY_MS = 90 * 24 * 3600 * 1000; // 3 mois

// pièces valides (non expirées) d'un utilisateur — comptabilité FIFO sur le ledger
// FIX 2026-10-05 (Équipe 8/10) : les DÉBITS consomment d'abord les crédits encore
// VALIDES au moment du débit (les plus anciens d'abord), puis les expirés à défaut.
// Avant : un débit consommait les crédits les plus anciens même expirés — un retrait
// « mangeait » des pièces expirées (sans valeur) tout en versant leur contre-valeur,
// permettant de retirer au total plus que les pièces valides (ex. 3000 retirés pour
// 2000 valides, même en séquentiel).
async function validCoins(userId) {
  const rows = await allRows(
    'SELECT amount, created_at FROM ledger WHERE user_id=? ORDER BY created_at ASC, id ASC', userId);
  const tnow = now();
  const credits = []; // crédits restants [montant, timestamp]
  for (const r of rows) {
    const amt = Number(r.amount) || 0;
    const ts = Number(r.created_at) || 0;
    if (amt > 0) {
      credits.push([amt, ts]);
    } else if (amt < 0) {
      let need = -amt;
      // 1) crédits encore valides au moment du débit (plus anciens d'abord)
      for (const c of credits) {
        if (need <= 0) break;
        if (c[0] > 0 && ts - c[1] < COIN_EXPIRY_MS) {
          const take = Math.min(c[0], need);
          c[0] -= take; need -= take;
        }
      }
      // 2) à défaut, les crédits déjà expirés
      for (const c of credits) {
        if (need <= 0) break;
        if (c[0] > 0) {
          const take = Math.min(c[0], need);
          c[0] -= take; need -= take;
        }
      }
      for (let i = credits.length - 1; i >= 0; i--) if (credits[i][0] <= 0) credits.splice(i, 1);
    }
  }
  // expire les crédits de 3 mois ou plus
  let valid = 0, expired = 0;
  for (const [amt, ts] of credits) {
    if (tnow - ts >= COIN_EXPIRY_MS) expired += amt;
    else valid += amt;
  }
  return { valid: Math.floor(valid), expired: Math.floor(expired) };
}

// --- bot : badge vérifié ---
async function botReviewBadge(r) {
  const fails = [];
  if (!r.full_name || r.full_name.trim().length < 3) fails.push('nom complet manquant');
  if (!VERIF_CATEGORIES.includes(String(r.category || '').toLowerCase())) fails.push('catégorie invalide');
  if (!r.id_doc_url || !/^https?:\/\//.test(r.id_doc_url)) {
    // FIX v2.42 : sans Cloudinary, storeImage renvoie un nom de fichier local (pas une URL https) —
    // c'est bien une photo stockée (même classe de correctif que le KYC du 2026-10-04)
    if (!/^[A-Za-z0-9_\-./]+\.(png|jpe?g|webp|gif)$/i.test(String(r.id_doc_url || ''))) fails.push('pièce d\u2019identité manquante ou illisible');
  }
  if (!r.website && !r.proof_links) fails.push('aucun site web ni lien de preuve');
  if (!r.activity || r.activity.trim().length < 20) fails.push('description d\u2019activité trop courte');
  // critères d'authenticité façon TikTok
  const u = await get1('SELECT avatar, created_at FROM users WHERE id=?', r.user_id);
  if (!u || !u.avatar) fails.push('profil incomplet (photo de profil requise)');
  const nv = await get1('SELECT COUNT(*) AS c FROM videos WHERE user_id=? AND hidden=0', r.user_id);
  if (!nv || Number(nv.c) < 1) fails.push('aucune vidéo publiée');
  if (fails.length) return { approved: false, reason: 'Rejeté par le bot : ' + fails.join(' ; ') };
  return { approved: true, reason: 'Vérifié par le bot : identité + preuves + activité confirmées' };
}

// --- bot : KYC monétisation ---
// v2.42 : le bot réessaie ses écritures en cas de contention SQLite (database is locked),
// au lieu d'échouer silencieusement dans le catch — ne change rien d'autre.
async function botWriteRetry(sql, params) {
  let last = null;
  for (let i = 0; i < 15; i++) {
    try { await runSql(sql, ...(params || [])); return; }
    catch (e) { last = e; if (!/locked|busy/i.test(String((e && e.message) || e))) throw e; await new Promise(r => setTimeout(r, 400)); }
  }
  throw last;
}
async function botReviewKyc(v) {
  const fails = [];
  if (!/^[A-Z]{2}$/.test(String(v.country || ''))) fails.push('pays invalide');
  if (!v.doc_front) fails.push('photo du document manquante'); // FIX 2026-10-04 : sans Cloudinary, storeImage renvoie un nom de fichier local (pas une URL https) — c'est bien une photo stockée
  try {
    if (!kycAllowedDocs(String(v.country).toUpperCase()).includes(v.doc_type)) fails.push('document non accepté pour ce pays');
  } catch (_) { fails.push('type de document invalide'); }
  if (v.expiry) {
    const expDate = new Date(v.expiry + '-01T00:00:00Z');
    expDate.setMonth(expDate.getMonth() + 1);
    if (expDate <= new Date()) fails.push('document expiré');
  }
  if (fails.length) return { approved: false, reason: 'Rejeté par le bot : ' + fails.join(' ; ') };
  return { approved: true, reason: 'Vérifié par le bot : document valide et en cours de validité' };
}

// --- le bot traite toutes les demandes en attente ---
async function runVerificationBot() {
  try {
    // 1. badges
    const badges = await allRows(`SELECT * FROM verification_requests WHERE status='pending' LIMIT 50`);
    for (const r of badges) {
      try {
        const verdict = await botReviewBadge(r);
        await botWriteRetry(`UPDATE verification_requests SET status=?, reviewed_at=?, reviewed_by='bot', review_reason=? WHERE id=?`,
          [verdict.approved ? 'approved' : 'rejected', now(), verdict.reason, r.id]);
        if (verdict.approved) {
          await botWriteRetry('UPDATE users SET verified=1 WHERE id=?', [r.user_id]);
          // v2.42 : le bot insère aussi la ligne user_badges (comme l'endpoint admin) —
          // sinon le badge « ✓ Vérifié » n'apparaît pas sur le profil
          await insertIgnore('INSERT OR IGNORE INTO user_badges(user_id,badge,awarded_at) VALUES(?,?,?)', r.user_id, 'verified', now());
          await notify(r.user_id, 'system', null, null, '🤖✔️ Ton compte est maintenant vérifié !');
        } else {
          await notify(r.user_id, 'system', null, null, '🤖 ' + verdict.reason);
        }
        // v2.33 : e-mail de verdict badge (bot)
        {
          const be = await get1('SELECT email, username FROM users WHERE id=?', r.user_id);
          if (be && be.email) sendVidiEmail(be.email,
            verdict.approved ? '✔️ Badge vérifié obtenu — VidiGagne' : '✔️ Demande de badge — action requise',
            '<p style="font-size:18px">' + (verdict.approved ? '✔️ Compte vérifié !' : '✔️ Demande de badge rejetée') + '</p>'
            + '<p style="color:#ccc;font-size:14px">' + String(verdict.reason).replace(/</g, '&lt;') + '</p>'
            + (verdict.approved ? '<p style="color:#999;font-size:12px">Ton badge bleu apparaît désormais à côté de ton pseudo. ✨</p>' : ''),
            verdict.reason).catch(() => {});
        }
      } catch (_) {}
    }
    // 2. KYC
    const kycs = await allRows(`SELECT * FROM id_verifications WHERE status='pending' LIMIT 50`);
    for (const v of kycs) {
      try {
        const verdict = await botReviewKyc(v);
        await botWriteRetry(`UPDATE id_verifications SET status=?, reviewed_at=?, reviewed_by='bot', review_reason=? WHERE id=?`,
          [verdict.approved ? 'approved' : 'rejected', now(), verdict.reason, v.id]);
        const u = await get1('SELECT username FROM users WHERE id=?', v.user_id);
        await notify(v.user_id, 'system', null, null,
          verdict.approved ? '🤖✔️ Ton identité est vérifiée — tu peux retirer tes gains !'
                           : '🤖 ' + verdict.reason);
        // v2.33 : e-mail de verdict KYC (bot)
        {
          const ue = await get1('SELECT email FROM users WHERE id=?', v.user_id);
          if (ue && ue.email) sendVidiEmail(ue.email,
            verdict.approved ? '🪪 Identité vérifiée — VidiGagne' : '🪪 Vérification d\'identité — action requise',
            '<p style="font-size:18px">' + (verdict.approved ? '🪪✔️ Identité vérifiée !' : '🪪 Vérification rejetée') + '</p>'
            + '<p style="color:#ccc;font-size:14px">' + String(verdict.reason).replace(/</g, '&lt;') + '</p>'
            + (verdict.approved ? '<p style="color:#999;font-size:12px">Tu peux désormais retirer tes gains. ✨</p>' : ''),
            verdict.reason).catch(() => {});
        }
      } catch (_) {}
    }
  } catch (e) { console.error('bot vérification:', e.message); }
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
// exécution + nombre de lignes affectées (débits atomiques anti race-condition)
async function runSqlChanges(sql, ...params) {
  if (USE_PG) { const r = await pool.query(pgQ(sql), params); return r.rowCount; }
  return lite.prepare(sql).run(...params).changes;
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
// INSERT ou ignore si conflit (likes, follows) — retourne 1 si inséré, 0 si ignoré
async function insertIgnore(sql, ...params) {
  if (USE_PG) {
    const clean = sql.replace(/INSERT\s+OR\s+IGNORE\s+INTO/i, 'INSERT INTO');
    const r = await pool.query(pgQ(clean) + ' ON CONFLICT DO NOTHING', params);
    return r.rowCount;
  }
  return lite.prepare(sql).run(...params).changes;
}

// ---------- verrou anti-concurrence par utilisateur (2026-10-04, chantier concurrence) ----------
// Les sections critiques "lire un compteur → vérifier un plafond → créditer" ne sont PAS
// atomiques : sur Postgres (pool async, la prod), N requêtes simultanées s'intercalent entre
// la lecture et le crédit et dépassent le plafond (ou créditent 2×). Ce mutex par user_id
// sérialise ces sections dans le processus Node (instance unique en production).
// Sur SQLite local les statements node:sqlite sont synchrones donc déjà sérialisés : le verrou
// y est neutre (aucun changement de comportement, prouvé par les bots de concurrence).
const _userLocks = new Map();
async function withUserLock(userId, fn) {
  const key = 'u' + userId;
  const prev = _userLocks.get(key) || Promise.resolve();
  let release;
  const gate = new Promise(r => { release = r; });
  const cur = prev.then(() => gate);
  _userLocks.set(key, cur);
  await prev;
  try { return await fn(); }
  finally { release(); if (_userLocks.get(key) === cur) _userLocks.delete(key); }
}
// FIX race 2026-10-05 (creusage profond #3) : verrou générique par clé — pour les races
// ENTRE utilisateurs (ex : 2 inscriptions simultanées au même tournoi PK), où
// withUserLock(userId) ne suffit pas. Même pattern, clé arbitraire.
const _keyLocks = new Map();
async function withKeyLock(key, fn) {
  const prev = _keyLocks.get(key) || Promise.resolve();
  let release;
  const gate = new Promise(r => { release = r; });
  const cur = prev.then(() => gate);
  _keyLocks.set(key, cur);
  await prev;
  try { return await fn(); }
  finally { release(); if (_keyLocks.get(key) === cur) _keyLocks.delete(key); }
}

// ---------- crochet de test « race » (Équipe 8/10 — concurrence, 2026-10-05) ----------
// Simule l'entrelacement Postgres en local : node:sqlite est synchrone et sérialise
// totalement les requêtes, ce qui MASQUE les TOCTOU réels en production (pool async).
// Quand l'en-tête X-Race-Test: 1 est présent (bots de concurrence uniquement), on insère
// un vrai délai async entre la lecture et l'écriture des sections critiques, ce qui
// reproduit l'intercalage des requêtes simultanées sur Postgres.
// Sans l'en-tête : aucun effet (zéro impact en production — le délai ne ralentit que
// la requête du testeur qui l'envoie).
function raceGap(req) {
  if (req && req.headers && req.headers['x-race-test'] === '1')
    return new Promise(r => setTimeout(r, 40));
  return null;
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

// v1.54 : validation des magic bytes — le Content-Type multipart est déclaratif (contrôlé par l'attaquant),
// on vérifie le CONTENU réel du fichier. Retourne 'video' | 'audio' | 'image' | null.
function detectMediaKind(buf) {
  if (!buf || buf.length < 12) return null;
  const head = buf.slice(0, 4096).toString('latin1');
  // SVG = rejeté explicitement (JavaScript embarquable)
  if (/^\s*<\?xml/i.test(head) || /^\s*<svg/i.test(head)) return 'svg';
  // images
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image'; // JPEG
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'image'; // PNG
  if (head.startsWith('GIF87a') || head.startsWith('GIF89a')) return 'image'; // GIF
  if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') return 'image'; // WebP
  // vidéo : MP4/MOV/M4V (ftyp), WebM/MKV (EBML), AVI (RIFF+AVI )
  if (head.slice(4, 8) === 'ftyp') return buf.slice(4, 12).toString('latin1').includes('M4A') ? 'audio' : 'video';
  if (buf[0] === 0x1A && buf[1] === 0x45 && buf[2] === 0xDF && buf[3] === 0xA3) return 'video'; // WebM/MKV
  if (head.startsWith('RIFF') && head.slice(8, 12) === 'AVI ') return 'video';
  if (head.startsWith('\x00\x00\x00\x18ftyp3g') || head.includes('moov')) return 'video';
  // audio : MP3, WAV, OGG, AAC
  if (head.startsWith('ID3') || (buf[0] === 0xFF && (buf[1] & 0xE0) === 0xE0)) return 'audio'; // MP3
  if (head.startsWith('RIFF') && head.slice(8, 12) === 'WAVE') return 'audio'; // WAV
  if (head.startsWith('OggS')) return 'audio'; // OGG
  if (head.startsWith('fLaC')) return 'audio'; // FLAC
  return null;
}
function mediaBytes(file) {
  if (file.buffer) return file.buffer;
  try { const fd = fs.openSync(file.path, 'r'); const b = Buffer.alloc(8192);
    const n = fs.readSync(fd, b, 0, 8192, 0); fs.closeSync(fd); return b.slice(0, n); } catch (e) { return null; }
}
const MEDIA_EXT = { video: '.mp4', audio: '.mp3', image: '.jpg' };
// v1.54 : quota de stockage 2 Go / utilisateur (anti saturation disque / facture Cloudinary)
const STORAGE_QUOTA = 2 * 1024 * 1024 * 1024;
async function checkQuota(userId, addBytes) {
  const u = await get1('SELECT storage_bytes FROM users WHERE id=?', userId);
  const used = Number(u && u.storage_bytes) || 0;
  if (used + addBytes > STORAGE_QUOTA) return false;
  await runSql('UPDATE users SET storage_bytes=storage_bytes+? WHERE id=?', addBytes, userId);
  return true;
}
async function storeVideo(file) {
  const kind = detectMediaKind(mediaBytes(file));
  if (kind !== 'video' && kind !== 'audio') throw new Error('fichier vidéo/audio invalide (contenu non reconnu)');
  const ext = MEDIA_EXT[kind]; // extension forcée selon le contenu réel, pas le nom d'origine
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
app.disable('x-powered-by'); // ne pas annoncer la techno du serveur
app.set('trust proxy', (() => { const _tp = parseInt(process.env.TRUST_PROXY || '', 10); return Number.isFinite(_tp) ? _tp : 1; })());
// v2.47-sec : Railway ajoute la vraie IP cliente comme DERNIER segment de X-Forwarded-For,
// donc trust=1 lit exactement ce segment (segments forgés à gauche ignorés). En local/dev
// (connexion directe, aucun proxy), X-Forwarded-For EST falsifiable et contourne les
// rate-limits par IP → mettre TRUST_PROXY=0 en dev/test.
// ---------- durcissement sécurité v1.54 : headers ----------
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  // v1.54 : CSP — bloque l'exécution de scripts injectés sur les pages HTML servies
  // (privacy/terms/admin) et les fichiers statiques /uploads
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: https:; media-src 'self' https:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; frame-ancestors 'none'");
  if (req.secure || req.headers['x-forwarded-proto'] === 'https')
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});
app.use(express.json({ limit: '2mb' }));

// ---------- helpers ----------
const now = () => Date.now();
// code parrain : 8 caractères alphanumériques majuscules
function genRefCode() {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 8; i++) s += abc[crypto.randomInt(abc.length)];
  return s;
}
function hashPass(pw, salt) {
  return crypto.scryptSync(pw, salt, 32).toString('hex');
}
function validUsername(u) {
  return typeof u === 'string' && /^[a-z0-9._]{2,24}$/.test(u);
}
// FIX torture 2026-10-05 : âge minimum 13 ans VÉRIFIÉ CÔTÉ SERVEUR (l'app le fait déjà côté client,
// mais un appel API direct pouvait créer un compte pour un enfant de 10 ans ou avec une date future)
function validBirthdate(bd) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(bd || '')) return { ok: false, error: 'date de naissance invalide' };
  const d = new Date(bd + 'T12:00:00Z');
  if (isNaN(d.getTime())) return { ok: false, error: 'date de naissance invalide' };
  const nowD = new Date();
  if (d > nowD) return { ok: false, error: 'la date de naissance ne peut pas être dans le futur' };
  let age = nowD.getUTCFullYear() - d.getUTCFullYear();
  const m = nowD.getUTCMonth() - d.getUTCMonth();
  if (m < 0 || (m === 0 && nowD.getUTCDate() < d.getUTCDate())) age--;
  if (age < 13) return { ok: false, error: 'il faut avoir au moins 13 ans pour utiliser VidiGagne' };
  if (age > 120) return { ok: false, error: 'date de naissance invalide' };
  return { ok: true };
}
// SPEC-14 : âge à partir de la naissance (les 13-15 ans = compte protégé)
function teenAge(bd) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(bd || '')) return null;
  const d = new Date(bd + 'T12:00:00Z');
  if (isNaN(d.getTime())) return null;
  const n = new Date();
  let age = n.getUTCFullYear() - d.getUTCFullYear();
  const m = n.getUTCMonth() - d.getUTCMonth();
  if (m < 0 || (m === 0 && n.getUTCDate() < d.getUTCDate())) age--;
  return age;
}
// SPEC-14 : recalcule teen_protected (les anniversaires font entrer/sortir de la tranche 13-15)
async function refreshTeenProtected() {
  try {
    const rows = await allRows("SELECT id, birthdate, teen_protected FROM users WHERE birthdate<>''");
    for (const r of rows) {
      const a = teenAge(r.birthdate);
      const should = (a !== null && a >= 13 && a <= 15) ? 1 : 0;
      if (Number(r.teen_protected) !== should)
        await runSql('UPDATE users SET teen_protected=? WHERE id=?', should, r.id);
    }
  } catch (e) { console.error('refreshTeenProtected:', e.message); }
}
async function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer (.+)$/);
  if (!m) return res.status(401).json({ error: 'token requis' });
  const row = await get1('SELECT t.user_id, t.created_at, u.suspended FROM tokens t JOIN users u ON u.id=t.user_id WHERE t.token=?', m[1]);
  if (!row) return res.status(401).json({ error: 'token invalide' });
  // expiration : 90 jours
  if (Number(row.created_at) < now() - 90 * 86400000) {
    await runSql('DELETE FROM tokens WHERE token=?', m[1]);
    return res.status(401).json({ error: 'session expirée' });
  }
  if (Number(row.suspended)) return res.status(403).json({ error: 'compte suspendu' });
  req.userId = row.user_id;
  req.token = m[1];
  next();
}
// B3 (v2.48, 2026-10-05) : accepte l'auth utilisateur (Bearer) OU le token admin (x-admin-token).
// Avant, la branche `req.admin` du endpoint decide était morte : `auth` rejetait toute
// requête sans Bearer (401) et ne positionnait jamais req.admin.
async function authOrAdmin(req, res, next) {
  const t = req.headers['x-admin-token'];
  if (process.env.ADMIN_TOKEN && t === process.env.ADMIN_TOKEN) { req.admin = true; return next(); }
  return auth(req, res, next);
}
// id de l'utilisateur courant depuis le jeton, sans exiger l'auth (null si anonyme)
async function optUserId(req) {
  try {
    const h = req.headers.authorization || '';
    const m = h.match(/^Bearer (.+)$/);
    if (!m) return null;
    const t = await get1('SELECT user_id FROM tokens WHERE token=?', m[1]);
    return t ? t.user_id : null;
  } catch (e) { return null; }
}
// notifie un utilisateur (jamais soi-même)
// v1.60 : sockets push instantané (userId -> ws)
const pushSockets = new Map();
// v2.31 : commentId optionnel (notifs mention / réponse → commentaire exact)
async function notify(userId, type, actorId, videoId, text, commentId) {
  try {
    if (!userId || Number(userId) === Number(actorId)) return;
    // v2.47 : conversation en sourdine — le message est stocké mais aucun push
    // (ni WebSocket in-app ni FCM) n'est envoyé au destinataire qui a muté
    if (type === 'message' && actorId) {
      try {
        const cm = await get1(
          'SELECT id FROM conversations WHERE (user1_id=? AND user2_id=?) OR (user1_id=? AND user2_id=?)',
          userId, actorId, actorId, userId);
        if (cm) {
          const m = await get1('SELECT 1 FROM conversation_mutes WHERE conversation_id=? AND user_id=?', cm.id, userId);
          if (m) {
            // stocke la notif silencieusement (is_read=0) sans aucun push
            await insertId('INSERT INTO notifications(user_id,type,actor_id,video_id,comment_id,text,is_read,created_at) VALUES(?,?,?,?,?,?,0,?)',
              userId, type, actorId || null, videoId || null, commentId || null, String(text || '').slice(0, 200), now());
            return;
          }
        }
      } catch (_) {}
    }
    // v1.84 : vérifie les préférences de notification du destinataire
    let prefs = null;
    try {
      prefs = await get1('SELECT notif_likes,notif_comments,notif_follows,notif_mentions,notif_lives,notif_loginalert,quiet_start,quiet_end,notif_newvideos FROM users WHERE id=?', userId);
      if (prefs) {
        const prefMap = { like: 'notif_likes', comment: 'notif_comments', follow: 'notif_follows', follow_request: 'notif_follows', follow_accepted: 'notif_follows', mention: 'notif_mentions', live: 'notif_lives', login_alert: 'notif_loginalert', new_video: 'notif_newvideos' };
        const col = prefMap[type];
        if (col && Number(prefs[col]) === 0) return; // désactivé par l'utilisateur
      }
    } catch (_) {}
    // v2.41 : heures silencieuses — la notif est STOCKÉE en base (is_read=0) mais le
    // push instantané (WebSocket in-app + FCM) est supprimé si l'heure UTC actuelle
    // est dans la plage [quiet_start, quiet_end[ (plage pouvant chevaucher minuit).
    let inQuiet = false;
    try {
      const qs = prefs ? prefs.quiet_start : null, qe = prefs ? prefs.quiet_end : null;
      if (qs !== null && qs !== undefined && qe !== null && qe !== undefined) {
        const s = Number(qs), e = Number(qe);
        if (Number.isInteger(s) && Number.isInteger(e) && s >= 0 && s <= 23 && e >= 0 && e <= 23 && s !== e) {
          const h = new Date().getUTCHours();
          inQuiet = s < e ? (h >= s && h < e) : (h >= s || h < e);
        }
      }
    } catch (_) {}
    const id = await insertId('INSERT INTO notifications(user_id,type,actor_id,video_id,comment_id,text,is_read,created_at) VALUES(?,?,?,?,?,?,0,?)',
      userId, type, actorId || null, videoId || null, commentId || null, String(text || '').slice(0, 200), now());
    let actorName = '';
    try { if (actorId) { const a = await get1('SELECT username FROM users WHERE id=?', actorId); if (a) actorName = a.username; } } catch (_) {}
    // push instantané si le destinataire est connecté en WebSocket (supprimé en heures silencieuses v2.41)
    try {
      if (!inQuiet) {
        const ws = pushSockets.get(Number(userId));
        if (ws && ws.readyState === 1) {
          // v2.42 : video_id/comment_id inclus pour ouverture directe depuis le push temps réel
          ws.send(JSON.stringify({ t: 'push', id, type, text: String(text || '').slice(0, 200), actor: actorName,
            video_id: videoId || null, comment_id: commentId || null }));
        }
      }
    } catch (_) {}
    // v1.84 : tentative de push FCM (fonctionne même app fermée) — supprimée en heures silencieuses v2.41
    if (!inQuiet) try {
      const titles = { like: 'Nouveau J\u2019aime', comment: 'Nouveau commentaire', follow: 'Nouvel abonné',
        follow_request: '👤 Demande de suivi', follow_accepted: '✅ Demande acceptée',
        mention: 'Mention', live: 'En direct', new_video: '🎬 Nouvelle vidéo', repost: 'Repost', gift: '🎁 Cadeau reçu',
        withdrawal: '💸 Retrait', kyc: '🪪 Identité', badge: '✔️ Badge vérifié', report: '🛡️ Signalement',
        security: '🔐 Sécurité', login_alert: '🔐 Nouvelle connexion', default: 'VidiGagne' };
      const title = (actorName ? actorName + ' — ' : '') + (titles[type] || titles.default);
      sendFcmPush(userId, title, String(text || '').slice(0, 200),
        { type, notif_id: String(id), actor: actorName }).catch(() => {});
    } catch (_) {}
  } catch (e) {}
}
// v2.42 : registre unique des WS (voir routeur 'upgrade' après les setups — FIX du 400 sur /api/push/ws)
const wsRoute = {};
function setupPushWs(server) {
  const { WebSocketServer } = require('ws');
  const wss = new WebSocketServer({ noServer: true });
  wsRoute['/api/push/ws'] = wss;
  wss.on('connection', (ws) => {
    let uid = null;
    const hb = setInterval(() => { try { if (ws.readyState === 1) ws.ping(); } catch (_) {} }, 240000);
    ws.on('message', async (buf) => {
      let m; try { m = JSON.parse(buf.toString()); } catch (e) { return; }
      if (m.t === 'auth' && m.token) {
        const id = await userIdFromToken(m.token);
        if (!id) { try { ws.close(); } catch (_) {} return; }
        uid = Number(id);
        // COIN-05 (2026-10-05) : reconnexion → l'ANCIENNE socket du même utilisateur est fermée
        const prev = pushSockets.get(uid);
        if (prev && prev !== ws) { try { prev.close(); } catch (_) {} }
        pushSockets.set(uid, ws);
        try { ws.send(JSON.stringify({ t: 'ready' })); } catch (_) {}
      }
      if (m.t === 'ping' && ws.readyState === 1) { try { ws.send(JSON.stringify({ t: 'pong' })); } catch (_) {} }
    });
    ws.on('close', () => { clearInterval(hb); if (uid && pushSockets.get(uid) === ws) pushSockets.delete(uid); });
    ws.on('error', () => {});
  });
}
// vrai si a a bloqué b, ou b a bloqué a
async function isBlocked(a, b) {
  if (!a || !b || Number(a) === Number(b)) return false;
  const r = await get1('SELECT 1 FROM blocks WHERE (user_id=? AND blocked_id=?) OR (user_id=? AND blocked_id=?)',
    a, b, b, a);
  return !!r;
}
// filtre SQL de visibilité des vidéos : 'public' pour tous, 'subscribers' pour les
// abonnés payants (ou le propriétaire), 'private' pour le propriétaire seul.
// alias = alias SQL de la table videos. Retourne {clause, params}.
function visFilter(alias, meId) {
  const a = alias || 'videos';
  if (!meId) return { clause: ` AND (${a}.visibility IS NULL OR ${a}.visibility='public')`, params: [] };
  return {
    clause: ` AND (${a}.visibility IS NULL OR ${a}.visibility='public' OR ${a}.user_id=?` +
      ` OR (${a}.visibility='subscribers' AND EXISTS (SELECT 1 FROM creator_subs cs WHERE cs.creator_id=${a}.user_id AND cs.subscriber_id=? AND cs.active=1 AND cs.expires_at>?)))`,
    params: [meId, meId, now()],
  };
}
// vrai si meId peut voir la vidéo v (objet ligne videos)
async function canSeeVideo(v, meId) {
  const vis = v.visibility || 'public';
  // FIX 2026-10-04 (rupture #3b): compte privé → seuls le propriétaire et ses abonnés voient les vidéos
  if (Number(v.user_id) !== Number(meId)) {
    try {
      const owner = await get1('SELECT is_private FROM users WHERE id=?', v.user_id);
      if (owner && Number(owner.is_private)) {
        if (!meId) return false;
        const f = await get1('SELECT 1 FROM follows WHERE follower_id=? AND followed_id=?', meId, v.user_id);
        if (!f) return false;
      }
    } catch (e) {}
  }
  if (vis === 'public') return true;
  if (!meId) return false;
  if (Number(v.user_id) === Number(meId)) return true;
  if (vis === 'subscribers') {
    const s = await get1('SELECT 1 FROM creator_subs WHERE creator_id=? AND subscriber_id=? AND active=1 AND expires_at>?',
      v.user_id, meId, now());
    return !!s;
  }
  return false; // private
}
// upsert historique de visionnage
async function touchHistory(userId, videoId) {
  if (!userId || !videoId) return;
  try {
    if (USE_PG) {
      await runSql(`INSERT INTO watch_history(user_id,video_id,watched_at) VALUES(?,?,?)
        ON CONFLICT(user_id,video_id) DO UPDATE SET watched_at=EXCLUDED.watched_at`, userId, videoId, now());
    } else {
      await runSql('INSERT OR REPLACE INTO watch_history(user_id,video_id,watched_at) VALUES(?,?,?)',
        userId, videoId, now());
    }
  } catch (e) {}
}
function pubUser(u) {
  // v1.54 : JAMAIS de données personnelles ici (prénom/nom/naissance = privées, voir privUser)
  return { id: u.id, username: u.username, name: u.name, avatar: u.avatar, bio: u.bio, verified: !!u.verified,
    is_private: !!u.is_private,
    teen_protected: !!u.teen_protected, // SPEC-14 : badge 🛡️ « compte protégé » (13-15 ans)
    account_type: u.account_type || 'personal', company_name: u.company_name || '',
    sub_enabled: Number(u.sub_enabled) || 0, sub_price: Number(u.sub_price) || 0, ref_code: u.ref_code || '' };
}
// Données personnelles : uniquement pour le propriétaire du compte (/api/auth/me)
function privUser(u) {
  const p = pubUser(u);
  p.first_name = u.first_name || ''; p.last_name = u.last_name || ''; p.birthdate = u.birthdate || '';
  p.gender = u.gender || '';
  p.country = u.country || '';
  return p;
}
async function videoJSON(v, meId) {
  const u = await get1('SELECT * FROM users WHERE id=?', v.user_id);
  if (!u) return null; // m7 : auteur supprimé → pas de plantage, la vidéo est filtrée
  const likes = (await get1('SELECT COUNT(*) AS c FROM likes WHERE video_id=?', v.id)).c;
  const cmts = (await get1('SELECT COUNT(*) AS c FROM comments WHERE video_id=?', v.id)).c;
  const liked = meId ? !!(await get1('SELECT 1 FROM likes WHERE user_id=? AND video_id=?', meId, v.id)) : false;
  // abonné payant actif au créateur ? (sert au verrou 🔒 sur les vidéos réservées)
  let subscribed = false;
  if (meId && Number(v.user_id) !== Number(meId)) {
    subscribed = !!(await get1('SELECT 1 FROM creator_subs WHERE creator_id=? AND subscriber_id=? AND active=1 AND expires_at>?',
      v.user_id, meId, now()));
  }
  // v12 : photos (carrousel) — tableaux parsés en sécurité
  let photos = [];
  try { const p = JSON.parse(v.photos || '[]'); if (Array.isArray(p)) photos = p.filter(x => typeof x === 'string'); } catch (e) {}
  let captions = [];
  try { const c = JSON.parse(v.captions || '[]'); if (Array.isArray(c)) captions = c.map(x => String(x)); } catch (e) {}
  // v12 : série payante — verrou si la vidéo est dans une série, que je ne suis pas
  // le créateur et que je ne l'ai pas achetée (les anonymes sont verrouillés aussi)
  const seriesId = v.series_id ? Number(v.series_id) : null;
  let seriesLocked = false;
  if (seriesId && Number(v.user_id) !== Number(meId)) {
    const bought = meId ? await get1('SELECT 1 FROM series_purchases WHERE series_id=? AND user_id=?', seriesId, meId) : null;
    seriesLocked = !bought;
  }
  // paywall : jamais d'URL de fichier pour une série verrouillée (tous les flux)
  const mediaUrl = seriesLocked ? null : fileUrl(v.file);
  const mediaPhotos = seriesLocked ? [] : photos;
  // V13 (TikTok Studio) : collaboration — la vidéo affiche ses 2 créateurs
  let coCreator = null;
  try {
    if (Number(v.co_creator_id)) {
      const cu = await get1('SELECT id, username, avatar FROM users WHERE id=?', v.co_creator_id);
      if (cu) coCreator = { id: cu.id, username: cu.username, avatar: cu.avatar || '' };
    }
  } catch (_) {}
  return {
    id: v.id, desc: v.description, tags: v.tags, sound: v.sound || '', sound_id: Number(v.sound_id) || 0, duration: Number(v.duration) || 0,
    url: mediaUrl, visibility: v.visibility || 'public', subscribed,
    co_creator: coCreator,
    media_type: v.media_type || 'video', photos: mediaPhotos, captions,
    target_countries: v.target_countries || '[]',
    series_id: seriesId, series_locked: seriesLocked, locked: seriesLocked || undefined,
    // v13 : replay de live + voix de synthèse + explication "pourquoi cette vidéo"
    is_replay: Number(v.is_replay) || 0,
    live_id: v.live_id ? Number(v.live_id) : null,
    tts: { text: v.tts_text || '', voice: v.tts_voice || '', rate: Number(v.tts_rate) || 1 },
    why: Array.isArray(v._why) ? v._why : null,
    // v1.84 : duos/collages, permissions, lieu, effet (façon TikTok)
    duet_of: Number(v.duet_of) || 0, stitch_of: Number(v.stitch_of) || 0,
    allow_duet: Number(v.allow_duet ?? 1), allow_stitch: Number(v.allow_stitch ?? 1),
    allow_download: Number(v.allow_download ?? 1), allow_comments: Number(v.allow_comments ?? 1),
    location: v.location || '', effect: v.effect || '',
    views: Number(v.views), likes: Number(likes), comments: Number(cmts), liked,
    created_at: Number(v.created_at),
    // FIX sécu 2026-10-05 (équipe performance #4) : JAMAIS de données personnelles
    // (prénom/nom/naissance/genre/pays) dans les objets vidéo publics — pubUser only.
    // Les données privées restent sur /api/auth/me (privUser).
    user: pubUser(u),
  };
}
// parse les mots-clés de filtre de commentaires (v12)
function parseKeywords(s) {
  try {
    const a = JSON.parse(s || '[]');
    return Array.isArray(a) ? a.map(x => String(x).toLowerCase()).filter(x => x.length) : [];
  } catch (e) { return []; }
}

// ---------- v2.32 : 1 identité par installation (DÉTECTION anti-fraude, jamais de blocage) ----------
// L'app envoie X-Device-Id (UUID persistant par installation, voir vgDeviceId() dans index.html).
// Règle : un device vu sur ≥2 comptes DISTINCTS est marqué flagged=1 pour révision admin —
// les sessions restent fonctionnelles (faux positifs possibles : famille partageant un téléphone,
// réinstallation, revente d'appareil). Les tokens sans device (anciennes versions de l'app)
// restent valides : aucune casse rétroactive.
async function recordDevice(req, userId) {
  try {
    const raw = String(req.headers['x-device-id'] || (req.body || {}).device_id || '').trim().slice(0, 128);
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(raw)) return; // absent ou invalide : on n'enregistre rien
    const t = now();
    const row = await get1('SELECT * FROM devices WHERE device_id=?', raw);
    if (!row) {
      await runSql('INSERT INTO devices(device_id,user_ids,first_seen,last_seen,flagged) VALUES(?,?,?,?,0)',
        raw, JSON.stringify([userId]), t, t);
      return;
    }
    let ids = [];
    try { ids = JSON.parse(row.user_ids || '[]'); } catch (e) { ids = []; }
    if (!Array.isArray(ids)) ids = [];
    if (!ids.includes(userId)) ids.push(userId);
    const flagged = (ids.length > 1 || row.flagged) ? 1 : 0;
    await runSql('UPDATE devices SET user_ids=?, last_seen=?, flagged=? WHERE device_id=?',
      JSON.stringify(ids), t, flagged, raw);
  } catch (e) { /* jamais bloquant : l'auth ne doit pas échouer à cause du suivi device */ }
}

// ---------- v2.41 : anti-fraude — alertes, vélocité de vues/likes, réputation IP, blocage des gains ----------
// Insère une alerte anti-fraude avec déduplication (max 1 alerte par type+user/IP/heure) pour
// éviter le spam d'alertes quand un bot frappe un endpoint en boucle.
async function fraudAlert(type, userId, ip, detail) {
  try {
    const t = now(), hourAgo = t - 3600000;
    const ipS = String(ip || '');
    const t40 = String(type).slice(0, 40);
    // Déduplication : 1 alerte/heure max — par IP pour ip_velocity (plusieurs comptes, même IP),
    // par utilisateur pour les alertes liées à un compte (view_velocity, like_velocity),
    // par IP pour les alertes anonymes. Sans ça, un faux positif partageant la même IP
    // (ex. ::1 en local) bloquerait les alertes légitimes des autres utilisateurs.
    let dup = null;
    if (t40 === 'ip_velocity') {
      dup = await get1('SELECT 1 FROM fraud_alerts WHERE type=? AND ip=? AND created_at>?', t40, ipS, hourAgo);
    } else if (userId) {
      dup = await get1('SELECT 1 FROM fraud_alerts WHERE type=? AND user_id=? AND created_at>?', t40, userId, hourAgo);
    } else {
      dup = await get1('SELECT 1 FROM fraud_alerts WHERE type=? AND user_id IS NULL AND ip=? AND created_at>?', t40, ipS, hourAgo);
    }
    if (dup) return false;
    await runSql('INSERT INTO fraud_alerts(type,user_id,ip,detail,created_at) VALUES(?,?,?,?,?)',
      t40, userId || null, ipS, String(detail || '').slice(0, 500), t);
    return true;
  } catch (e) { return false; }
}
// Vrai si l'utilisateur est sur un device flagged avec ≥5 comptes distincts → gains bloqués
// (seuil 5 : en dessous, simple détection sans blocage — faux positifs possibles : famille, revente).
async function deviceEarningsBlocked(userId) {
  try {
    const rows = await allRows('SELECT user_ids FROM devices WHERE flagged=1');
    for (const r of rows) {
      let ids = [];
      try { ids = JSON.parse(r.user_ids || '[]'); } catch (e) { ids = []; }
      if (Array.isArray(ids) && ids.includes(Number(userId)) && ids.length >= 5) return true;
    }
  } catch (e) {}
  return false;
}
// Vélocité de vues en mémoire (fenêtre 1 h) : le compteur de hits du endpoint lui-même,
// car les vues dédupliquées n'apparaissent pas en base. Limite : par processus (mono-instance ici).
const _viewHits = new Map();
function viewVelocityHit(viewerId, ip) {
  const key = viewerId ? 'u:' + viewerId : 'ip:' + ip;
  const t = Date.now(), win = t - 3600000;
  let arr = _viewHits.get(key) || [];
  arr = arr.filter(x => x > win);
  arr.push(t);
  if (_viewHits.size > 20000) _viewHits.clear();
  _viewHits.set(key, arr);
  return arr.length;
}
// Réputation IP à l'inscription : compteur sur fenêtre glissante de 24 h.
// ≥5 comptes en 24 h → flagged=1 + alerte ip_velocity. Jamais bloquant pour l'inscription.
async function recordIpSignup(req, userId) {
  try {
    const ip = clientIp(req);
    if (!ip) return;
    const t = now();
    const row = await get1('SELECT * FROM ip_reputation WHERE ip=?', ip);
    if (!row) {
      await runSql('INSERT INTO ip_reputation(ip,accounts_count,window_start,first_seen,last_seen,flagged) VALUES(?,?,?,?,?,0)',
        ip, 1, t, t, t);
      return;
    }
    let count = Number(row.accounts_count) || 0;
    let winStart = Number(row.window_start) || 0;
    if (t - winStart > 86400000) { count = 1; winStart = t; } else { count += 1; }
    const flagged = count >= 5 ? 1 : 0;
    await runSql('UPDATE ip_reputation SET accounts_count=?, window_start=?, last_seen=?, flagged=? WHERE ip=?',
      count, winStart, t, flagged, ip);
    if (flagged) await fraudAlert('ip_velocity', userId, ip, count + ' inscriptions en 24h depuis cette IP');
  } catch (e) { /* jamais bloquant : l'inscription ne doit pas échouer à cause du suivi IP */ }
}

// ---------- v2.34 : ALERTES DE CONNEXION ----------
// Notifie l'utilisateur d'une connexion réussie, sauf si la dernière alerte
// date de moins d'1 heure ET que l'IP est identique (anti-spam).
async function maybeLoginAlert(userId, ip) {
  try {
    const u = await get1('SELECT last_login_ip, email FROM users WHERE id=?', userId);
    const prevIp = (u && u.last_login_ip) || '';
    const last = await get1("SELECT created_at FROM notifications WHERE user_id=? AND type='login_alert' ORDER BY created_at DESC LIMIT 1", userId);
    const recent = last && (now() - Number(last.created_at) < 3600000);
    if (recent && prevIp === String(ip || '')) return;
    const d = new Date();
    const dt = d.toLocaleDateString('fr-FR') + ' à ' + d.toLocaleTimeString('fr-FR');
    await notify(userId, 'login_alert', null, null,
      `Nouvelle connexion à ton compte le ${dt} (IP ${ip || 'inconnue'}). Si ce n'est pas toi, change ton mot de passe.`);
    // v2.44-EQD-MAIL : e-mail d'alerte sécurité (envoyé seulement quand l'alerte se déclenche — anti-spam déjà géré ci-dessus)
    if (u && u.email) sendVidiEmail(u.email,
      '🔐 Nouvelle connexion à ton compte VidiGagne',
      '<p style="font-size:18px">🔐 Nouvelle connexion détectée</p>'
      + '<p style="color:#ccc;font-size:14px">Quelqu\'un s\'est connecté à ton compte le ' + dt + ' (IP ' + String(ip || 'inconnue').replace(/</g, '&lt;') + ').</p>'
      + '<p style="color:#999;font-size:12px">Si ce n\'est pas toi, change ton mot de passe immédiatement.</p>',
      'Nouvelle connexion à ton compte VidiGagne le ' + dt + ' (IP ' + (ip || 'inconnue') + '). Si ce n\'est pas toi, change ton mot de passe.').catch(() => {});
    await runSql('UPDATE users SET last_login_ip=? WHERE id=?', String(ip || ''), userId);
  } catch (e) { /* jamais bloquant : le login ne doit pas échouer à cause de l'alerte */ }
}

// ---------- auth ----------
app.post('/api/auth/register', async (req, res) => {
  try {
    // v2.43 : challenge anti-abus d'abord, puis rate-limit inscription (5/heure/IP)
    // 2026-10-05 : VG_TEST_HOOKS=1 (instances locales des bots) → pas de garde-fous anti-abus.
    // Les 310 bots d'enchaînement partagent l'IP localhost et déclencheraient le challenge en
    // permanence (faux 429). Le comportement réel reste testé par chain-captcha-abuse et
    // chain-rate-limit contre l'instance :3111 (sans hooks). Sans effet en production (Railway
    // ne définit pas VG_TEST_HOOKS).
    if (!VG_TEST_HOOKS) {
      if (await abuseCheck(clientIp(req)))
        return res.status(429).json({ error: 'activité suspecte détectée : résous le petit calcul pour continuer', challenge_required: true, retry_after: 300 });
      if (registerRateLimited(clientIp(req))) {
        await abuseEvent(clientIp(req), null);
        return res.status(429).json({ error: 'trop d\u2019inscriptions depuis cette adresse — réessaie dans une heure', retry_after: 3600 });
      }
    }
    let { username, name, password, email, first_name, last_name, birthdate, gender } = req.body || {};
    gender = ['male', 'female', 'other'].includes(String(gender || '')) ? String(gender) : '';
    username = (username || '').toLowerCase().trim();
    if (!validUsername(username))
      return res.status(400).json({ error: "pseudo invalide (lettres, chiffres, . _ — 2 à 24)" });
    if (!password || password.length < 8)
      return res.status(400).json({ error: 'mot de passe : 8 caractères minimum' });
    email = (email || '').trim().toLowerCase() || null;
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return res.status(400).json({ error: 'e-mail invalide' });
    if (email) {
      const _vt = await peekVerifiedToken((req.body || {}).verification_token);
      if (!_vt || String(_vt.identifier).toLowerCase() !== email)
        return res.status(403).json({ error: 'vérifie ton e-mail avec le code reçu pour créer ton compte' });
    }
    first_name = String(first_name || '').trim().slice(0, 40);
    last_name = String(last_name || '').trim().slice(0, 40);
    birthdate = /^\d{4}-\d{2}-\d{2}$/.test(birthdate || '') ? birthdate : '';
    // FIX torture 2026-10-05 : 13 ans minimum vérifié côté serveur
    if (birthdate) {
      const _vb = validBirthdate(birthdate);
      if (!_vb.ok) return res.status(400).json({ error: _vb.error });
    }
    const exists = await get1('SELECT 1 FROM users WHERE username=?', username);
    if (exists) {
      // FIX sécu 2026-10-05 (F4) : hash factice pour aligner le temps de réponse
      // (409 immédiat vs 200 lent → énumération de pseudos par timing). Coût ~identique au hash réel.
      try { hashPass('timing-dummy-' + username, crypto.randomBytes(16).toString('hex')); } catch (_) {}
      return res.status(409).json({ error: 'ce pseudo est déjà pris' });
    }
    if (email) {
      const eExists = await get1('SELECT 1 FROM users WHERE email=?', email);
      // v1.54 : message générique pour l'e-mail (anti-énumération de comptes)
      if (eExists) return res.status(409).json({ error: 'inscription impossible avec ces informations' });
    }
    const salt = crypto.randomBytes(16).toString('hex');
    await raceGap(req); // crochet test concurrence (Équipe 8/10) : simule l'intercalage Postgres
    // FIX race 2026-10-05 (Équipe 8/10) : 2 inscriptions simultanées avec le même
    // pseudo → la 2e viole la contrainte UNIQUE : 409 propre au lieu de 500.
    let id;
    try {
      id = await insertId(
        'INSERT INTO users(username,name,first_name,last_name,birthdate,gender,email,pass_hash,pass_salt,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
        username, (name || username).slice(0, 40), first_name, last_name, birthdate, gender, email, hashPass(password, salt), salt, now());
    } catch (e) {
      if (/UNIQUE/i.test(String((e && e.message) || '')))
        return res.status(409).json({ error: 'ce pseudo est déjà pris' });
      throw e;
    }
    // SPEC-14 : 13-15 ans → compte protégé (teen_protected) + compte privé par défaut,
    // comme TikTok. Le badge 🛡️ « compte protégé » est affiché sur le profil.
    if (birthdate) {
      const _ta = teenAge(birthdate);
      if (_ta !== null && _ta >= 13 && _ta <= 15) {
        await runSql('UPDATE users SET teen_protected=1, is_private=1 WHERE id=?', id);
      }
    }
    // code parrain unique
    let refCode = null;
    for (let i = 0; i < 20 && !refCode; i++) {
      const c = genRefCode();
      if (!(await get1('SELECT 1 FROM users WHERE ref_code=?', c))) refCode = c;
    }
    if (refCode) await runSql('UPDATE users SET ref_code=? WHERE id=?', refCode, id);
    // v2.32 : inscription via lien d'invitation (?invite=CODE) → attribution + statut "inscrit" + bonus +50/+50
    const invCode = String((req.body && req.body.invite) || req.query.invite || '').trim().toUpperCase();
    if (invCode) {
      try {
        const inv = await get1('SELECT * FROM invites WHERE UPPER(code)=?', invCode);
        if (inv && !inv.invited_user_id && Number(inv.user_id) !== Number(id)) {
          await runSql('UPDATE users SET referred_by=? WHERE id=?', inv.user_id, id);
          await raceGap(req); // crochet test concurrence (Équipe 8/10) : simule l'intercalage Postgres
          // FIX race 2026-10-05 (Équipe 8/10) : double bonus — seul le premier inscrit
          // qui réclame ce code reçoit le +50/+50 (UPDATE conditionnel). Avant : 2
          // inscriptions simultanées avec le même code créditaient 2 fois (prouvé : 200 au lieu de 100).
          const invClaimed = await runSqlChanges("UPDATE invites SET invited_user_id=?, status='inscrit' WHERE id=? AND invited_user_id IS NULL", id, inv.id);
          if (invClaimed) {
            const _t = now();
            await runSql('UPDATE users SET coins=coins+50 WHERE id=?', id);
            await runSql('UPDATE users SET coins=coins+50 WHERE id=?', inv.user_id);
            await runSql('INSERT INTO ledger(user_id,amount,reason,created_at) VALUES(?,?,?,?)', id, 50, 'invitation (lien)', _t);
            await runSql('INSERT INTO ledger(user_id,amount,reason,created_at) VALUES(?,?,?,?)', inv.user_id, 50, 'invitation de @' + username, _t);
          }
        }
      } catch (_) {}
    }
    const token = crypto.randomBytes(32).toString('hex');
    await runSql('INSERT INTO tokens(token,user_id,created_at) VALUES(?,?,?)', token, id, now());
    await recordDevice(req, id); // v2.32 : 1 identité par installation (détection, jamais bloquant)
    await recordIpSignup(req, id); // v2.41 : réputation IP (fenêtre 24 h, jamais bloquant)
    const u = await get1('SELECT * FROM users WHERE id=?', id);
    if (email) await consumeVerifiedToken((req.body || {}).verification_token);
    res.json({ token, user: privUser(u), coins: u.coins });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});

// v1.54 : rate-limit anti brute-force (5 essais / 15 min par IP+identifiant)
const _loginAttempts = new Map();
function loginRateLimited(ip, ident) {
  const k = ip + '|' + ident, t = Date.now();
  let a = _loginAttempts.get(k) || [];
  a = a.filter(x => t - x < 15 * 60 * 1000);
  if (a.length >= 5) return true;
  a.push(t); _loginAttempts.set(k, a);
  if (_loginAttempts.size > 5000) _loginAttempts.clear();
  return false;
}
// ---------- v2.43 : journal d'audit des actions sensibles ----------
// Jamais bloquant : un échec d'écriture ne doit jamais casser l'action métier.
async function logAudit(actorId, action, targetType, targetId, req) {
  try {
    await runSql('INSERT INTO audit_logs(actor_id,action,target_type,target_id,ip,created_at) VALUES(?,?,?,?,?,?)',
      actorId == null ? null : Number(actorId), String(action).slice(0, 40),
      targetType ? String(targetType).slice(0, 40) : null,
      targetId == null ? null : String(targetId).slice(0, 80),
      req ? clientIp(req) : null, now());
  } catch (_) {}
}
// v2.43 : rate-limit inscription (5 / heure / IP) — anti création massive de comptes
const _registerAttempts = new Map();
function registerRateLimited(ip) {
  const k = 'rg|' + ip, t = Date.now();
  let a = _registerAttempts.get(k) || [];
  a = a.filter(x => t - x < 60 * 60 * 1000);
  if (a.length >= 5) return true;
  a.push(t); _registerAttempts.set(k, a);
  if (_registerAttempts.size > 5000) _registerAttempts.clear();
  return false;
}
// ---------- v2.43 : challenge anti-abus progressif ----------
// Quand un IP déclenche ≥3 rate-limits en 1h (login, inscription, mot de passe oublié),
// il est marqué "challenged" : les requêtes sensibles suivantes (login, register)
// répondent 429 + challenge_required jusqu'à résolution d'un petit calcul.
// Seuil haut, jamais de faux positif sur usage normal.
async function abuseEvent(ip, userId) {
  try {
    if (!ip) return;
    const t = now();
    const r = await get1('SELECT score, last_event_at, challenged FROM abuse_flags WHERE ip=?', ip);
    const inWindow = r && (t - Number(r.last_event_at || 0) < 3600 * 1000);
    const score = inWindow ? Number(r.score || 0) + 1 : 1;
    const challenged = score >= 3 ? 1 : (inWindow ? Number(r.challenged || 0) : 0);
    if (!r) {
      await runSql('INSERT INTO abuse_flags(ip,user_id,score,challenged,challenged_at,created_at,last_event_at) VALUES(?,?,?,?,?,?,?)',
        ip, userId || null, score, challenged, challenged ? t : null, t, t);
    } else {
      await runSql('UPDATE abuse_flags SET score=?, user_id=COALESCE(?,user_id), challenged=?, challenged_at=CASE WHEN ? THEN ? ELSE challenged_at END, last_event_at=? WHERE ip=?',
        score, userId || null, challenged, challenged, t, t, ip);
    }
  } catch (_) {}
}
async function abuseCheck(ip) {
  try {
    if (!ip) return false;
    const r = await get1('SELECT challenged, challenged_at FROM abuse_flags WHERE ip=?', ip);
    if (!r || Number(r.challenged) !== 1) return false;
    if (now() - Number(r.challenged_at || 0) > 24 * 3600 * 1000) {
      await runSql('UPDATE abuse_flags SET challenged=0, score=0 WHERE ip=?', ip);
      return false;
    }
    return true;
  } catch (_) { return false; }
}
function resetIpLimits(ip) {
  // Challenge résolu = preuve d'humanité : on efface les compteurs mémoire de cet IP.
  try {
    for (const k of [..._loginAttempts.keys()]) if (k.startsWith(ip + '|')) _loginAttempts.delete(k);
    for (const k of [..._registerAttempts.keys()]) if (k === 'rg|' + ip) _registerAttempts.delete(k);
  } catch (_) {}
}
app.post('/api/auth/login', async (req, res) => {
  try {
    const _vt = await peekVerifiedToken((req.body || {}).verification_token);
    if (_vt) {
      const _em = String(_vt.identifier).toLowerCase();
      const _u = await get1('SELECT * FROM users WHERE email=?', _em);
      if (!_u) return res.status(404).json({ error: 'aucun compte avec cet e-mail — inscris-toi' });
      await consumeVerifiedToken((req.body || {}).verification_token);
      const _token = crypto.randomBytes(32).toString('hex');
      await runSql('INSERT INTO tokens(token,user_id,created_at) VALUES(?,?,?)', _token, _u.id, now());
      await recordDevice(req, _u.id); // v2.32 : 1 identité par installation (détection, jamais bloquant)
      await maybeLoginAlert(_u.id, clientIp(req)); // v2.34 : alerte de connexion
      return res.json({ token: _token, user: privUser(_u), coins: _u.coins });
    }
    const ident = ((req.body || {}).username || (req.body || {}).identifier || (req.body || {}).email || '').toLowerCase().trim();
    // v2.43 : challenge anti-abus — un IP "challenged" doit d'abord résoudre le petit calcul
    // 2026-10-05 : VG_TEST_HOOKS=1 (instances locales des bots) → pas de garde-fous anti-abus
    // (même justification que sur /api/auth/register ; comportement réel testé sur :3111).
    if (!VG_TEST_HOOKS) {
      if (await abuseCheck(clientIp(req)))
        return res.status(429).json({ error: 'activité suspecte détectée : résous le petit calcul pour continuer', challenge_required: true, retry_after: 300 });
      if (loginRateLimited(clientIp(req), ident)) {
        await abuseEvent(clientIp(req), null); // v2.43 : comptabilise pour le challenge anti-abus
        return res.status(429).json({ error: 'trop de tentatives, réessaie dans 15 minutes' });
      }
    }
    const u = await get1('SELECT * FROM users WHERE username=? OR email=?', ident, ident);
    if (!u || hashPass(req.body.password || '', u.pass_salt) !== u.pass_hash)
      return res.status(401).json({ error: 'pseudo ou mot de passe incorrect' });
    const token = crypto.randomBytes(32).toString('hex');
    await runSql('INSERT INTO tokens(token,user_id,created_at) VALUES(?,?,?)', token, u.id, now());
    await recordDevice(req, u.id); // v2.32 : 1 identité par installation (détection, jamais bloquant)
    await maybeLoginAlert(u.id, clientIp(req)); // v2.34 : alerte de connexion
    res.json({ token, user: privUser(u), coins: u.coins });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});

// ---------- v2.43 : challenge anti-abus — petit calcul à résoudre ----------
// Pas de captcha visuel dans l'app : le serveur génère un calcul simple lié à un
// nonce (5 min). Une bonne réponse lève le flag "challenged" pour l'IP.
const _challenges = new Map(); // nonce -> { ans, exp }
app.get('/api/auth/challenge/nonce', async (req, res) => {
  try {
    const a = 1 + crypto.randomInt(48), b = 1 + crypto.randomInt(48);
    const nonce = crypto.randomBytes(16).toString('hex');
    _challenges.set(nonce, { ans: a + b, exp: Date.now() + 5 * 60 * 1000 });
    if (_challenges.size > 1000) _challenges.delete(_challenges.keys().next().value);
    res.json({ nonce, question: a + ' + ' + b + ' = ?' });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.post('/api/auth/challenge/solve', async (req, res) => {
  try {
    const nonce = String((req.body || {}).nonce || '');
    const c = _challenges.get(nonce);
    if (!c || Date.now() > c.exp) {
      _challenges.delete(nonce);
      return res.status(400).json({ error: 'challenge expiré — demande un nouveau calcul' });
    }
    if (Number((req.body || {}).answer) !== c.ans)
      return res.status(400).json({ error: 'mauvaise réponse — réessaie' });
    _challenges.delete(nonce);
    const ip = clientIp(req);
    await runSql('UPDATE abuse_flags SET challenged=0, score=0 WHERE ip=?', ip);
    resetIpLimits(ip); // preuve d'humanité : les compteurs repartent de zéro
    res.json({ ok: true, message: 'vérification réussie — tu peux te reconnecter' });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.get('/api/auth/me', auth, async (req, res) => {
  const u = await get1('SELECT * FROM users WHERE id=?', req.userId);
  res.json({ user: privUser(u), coins: u.coins });
});

// déconnexion : supprime le token courant côté serveur
app.post('/api/auth/logout', auth, async (req, res) => {
  try {
    await runSql('DELETE FROM tokens WHERE token=?', req.token);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});

// ---------- v2.34 : APPS CONNECTÉES — gestion des sessions ----------
// Liste les sessions (tokens) actives de l'utilisateur ; le token est masqué.
app.get('/api/me/sessions', auth, async (req, res) => {
  try {
    const rows = await allRows('SELECT token, created_at FROM tokens WHERE user_id=? ORDER BY created_at DESC', req.userId);
    res.json({ ok: true, sessions: rows.map(r => {
      const cur = String(r.token) === req.token;
      return {
        token: String(r.token).slice(0, 8) + '...',
        created_at: r.created_at,
        current: cur,
        label: cur ? 'cet appareil' : '',
      };
    }) });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// Révoque une session : doit appartenir à l'utilisateur ; pas la session courante.
app.delete('/api/me/sessions/:token', auth, async (req, res) => {
  try {
    const t = String(req.params.token || '');
    if (t === req.token)
      return res.status(400).json({ error: 'impossible de révoquer ta session actuelle — utilise la déconnexion' });
    const own = await get1('SELECT token FROM tokens WHERE token=? AND user_id=?', t, req.userId);
    if (!own) return res.status(404).json({ error: 'session introuvable' });
    await runSql('DELETE FROM tokens WHERE token=?', t);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});

// ---------- mot de passe oublié : code e-mail à 6 chiffres (10 min) ----------
const _forgotAttempts = new Map();
function forgotRateLimited(email) {
  const k = 'fg|' + email, t = Date.now();
  let a = _forgotAttempts.get(k) || [];
  a = a.filter(x => t - x < 15 * 60 * 1000);
  if (a.length >= 5) return true;
  a.push(t); _forgotAttempts.set(k, a);
  if (_forgotAttempts.size > 5000) _forgotAttempts.clear();
  return false;
}
app.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const email = String((req.body || {}).email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return res.status(400).json({ error: 'e-mail invalide' });
    if (forgotRateLimited(email)) {
      await abuseEvent(clientIp(req), null); // v2.43 : comptabilise pour le challenge anti-abus
      return res.status(429).json({ error: 'trop de tentatives, réessaie dans 15 minutes' });
    }
    const u = await get1('SELECT id FROM users WHERE email=?', email);
    if (u) {
      const code = String(Math.floor(100000 + Math.random() * 900000));
      await runSql('DELETE FROM password_resets WHERE email=?', email);
      await runSql('INSERT INTO password_resets(email,code,expires_at,created_at) VALUES(?,?,?,?)',
        email, code, now() + 10 * 60 * 1000, now());
      // v2.33 : envoi RÉEL du code (avant : le message affirmait un envoi qui n'avait jamais lieu)
      sendVidiEmail(email,
        '🔐 Réinitialise ton mot de passe VidiGagne',
        '<p style="font-size:18px">🔐 Code de réinitialisation</p>'
        + '<p style="color:#ccc;font-size:14px">Voici ton code pour créer un nouveau mot de passe :</p>'
        + bigCodeHtml(code)
        + '<p style="color:#999;font-size:12px">⏱️ Ce code expire dans 10 minutes. Si tu n\'as rien demandé, ignore cet e-mail.</p>',
        'Ton code de réinitialisation VidiGagne : ' + code + ' (expire dans 10 minutes).')
        .catch(() => {});
    }
    // message générique dans tous les cas (anti-énumération de comptes)
    res.json({ ok: true, message: 'Si un compte existe avec cet e-mail, un code vient d\u2019être envoyé.' });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const email = String((req.body || {}).email || '').trim().toLowerCase();
    const code = String((req.body || {}).code || '').trim();
    const np = String((req.body || {}).new_password || '');
    if (np.length < 8) return res.status(400).json({ error: 'mot de passe : 8 caractères minimum' });
    const row = await get1('SELECT * FROM password_resets WHERE email=? AND code=?', email, code);
    if (!row || Number(row.expires_at) < now())
      return res.status(400).json({ error: 'code invalide ou expiré' });
    const u = await get1('SELECT id FROM users WHERE email=?', email);
    if (!u) return res.status(400).json({ error: 'code invalide ou expiré' });
    const salt = crypto.randomBytes(16).toString('hex');
    await runSql('UPDATE users SET pass_hash=?, pass_salt=? WHERE id=?', hashPass(np, salt), salt, u.id);
    await runSql('DELETE FROM password_resets WHERE email=?', email);
    await logAudit(u.id, 'password_reset', 'user', u.id, req); // v2.43 : audit action sensible
    // v2.33 : confirmation par e-mail (sécurité : l'utilisateur est prévenu du changement)
    sendVidiEmail(email,
      '🔐 Ton mot de passe VidiGagne a été changé',
      '<p style="font-size:18px">🔐 Mot de passe mis à jour</p>'
      + '<p style="color:#ccc;font-size:14px">Ton mot de passe VidiGagne vient d\'être modifié avec succès.</p>'
      + '<p style="color:#999;font-size:12px">Si ce n\'est pas toi, contacte le support immédiatement.</p>',
      'Ton mot de passe VidiGagne vient d\'être modifié. Si ce n\'est pas toi, contacte le support.')
      .catch(() => {});
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});

// ---------- v1.100 : vérification par code (e-mail, 60 s) ----------
const CODE_TTL_MS = 60 * 1000;
const CODE_RESEND_MS = 30 * 1000;
const CODE_MAX_15MIN = 5;
const VTOKEN_TTL_MS = 10 * 60 * 1000;

function normIdentifier(id, kind) {
  id = String(id || '').trim();
  if (kind === 'email') return id.toLowerCase();
  let ph = id.replace(/[\s\-.()]/g, '');
  if (ph.charAt(0) !== '+') ph = '+' + ph;
  ph = '+' + ph.slice(1).replace(/\D/g, '');
  return ph;
}
function validIdentifier(id, kind) {
  if (kind === 'email') return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(id);
  return /^\+\d{7,15}$/.test(id);
}
async function issueVerifyCode(identifier, kind) {
  const t = now();
  try { await runSql('DELETE FROM verification_codes WHERE expires_at < ?', t - 3600 * 1000); } catch (e) {}
  const last = await get1('SELECT created_at FROM verification_codes WHERE identifier=? ORDER BY id DESC LIMIT 1', identifier);
  if (last && t - last.created_at < CODE_RESEND_MS)
    return { error: 'attends quelques secondes avant de renvoyer', retry_after: Math.ceil((CODE_RESEND_MS - (t - last.created_at)) / 1000), status: 429 };
  const cnt = await get1('SELECT COUNT(*) AS c FROM verification_codes WHERE identifier=? AND created_at>?', identifier, t - 15 * 60 * 1000);
  if (cnt && cnt.c >= CODE_MAX_15MIN)
    return { error: 'trop de codes demandés, réessaie dans quelques minutes', status: 429 };
  const code = String(crypto.randomInt(100000, 1000000));
  await runSql('DELETE FROM verification_codes WHERE identifier=? AND used=0', identifier);
  await runSql('INSERT INTO verification_codes(identifier,kind,code,expires_at,attempts,used,created_at) VALUES(?,?,?,?,?,?,?)',
    identifier, kind, code, t + CODE_TTL_MS, 0, 0, t);
  let sent = false, devCode = null;
  // Priorité : Brevo API (HTTP, jamais bloqué) puis SMTP
  if (process.env.BREVO_API_KEY) {
    try {
      const br = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'api-key': process.env.BREVO_API_KEY, 'Content-Type': 'application/json', 'accept': 'application/json' },
        body: JSON.stringify({
          sender: { name: process.env.BREVO_FROM_NAME || 'VidiGagne', email: process.env.BREVO_FROM_EMAIL || process.env.SMTP_USER },
          to: [{ email: identifier }],
          subject: '✨ Bienvenue sur VidiGagne — ton code de vérification',
          htmlContent: '<div style="font-family:sans-serif;max-width:480px;margin:0 auto;background:#0a0a0a;border-radius:16px;overflow:hidden">'
      + '<div style="background:linear-gradient(135deg,#b8860b,#ffd700);padding:30px;text-align:center">'
      + '<div style="font-size:32px;font-weight:900;color:#000;letter-spacing:1px">VidiGagne</div>'
      + '<div style="color:#000;font-size:14px;margin-top:6px">Regarde des vidéos. Gagne de l\'argent.</div></div>'
      + '<div style="padding:30px;text-align:center;color:#fff">'
      + '<p style="font-size:18px">👋 Bienvenue dans la famille VidiGagne !</p>'
      + '<p style="color:#ccc;font-size:14px">Nous sommes ravis de te compter parmi nous. Pour sécuriser ton compte, voici ton code de vérification :</p>'
      + '<div style="font-size:48px;font-weight:900;letter-spacing:12px;color:#ffd700;margin:20px 0">' + code + '</div>'
      + '<p style="color:#999;font-size:12px">⏱️ Ce code expire dans 60 secondes.</p>'
      + '<p style="color:#ccc;font-size:14px;margin-top:20px">💰 Des milliers de créateurs gagnent déjà de l\'argent chaque jour sur VidiGagne.<br>À ton tour de briller ! ✨</p>'
      + '</div>'
      + '<div style="padding:20px;text-align:center;color:#666;font-size:11px;border-top:1px solid #222">Si tu n\'as pas demandé ce code, ignore simplement cet e-mail.<br>© 2026 VidiGagne — Fait avec ❤️</div></div>',
        }),
      });
      if (br.ok) sent = true;
    } catch (e) { sent = false; }
  }
  const m = !sent && mailer();
  if (m) {
    try {
      await m.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: identifier,
        subject: '✨ Bienvenue sur VidiGagne — ton code de vérification',
        text: 'Bienvenue sur VidiGagne ! Ton code de vérification est : ' + code + '. Il expire dans 60 secondes. Nous sommes ravis de te compter parmi nous !',
        html: '<div style="font-family:sans-serif;max-width:480px;margin:0 auto;background:#0a0a0a;border-radius:16px;overflow:hidden">'
      + '<div style="background:linear-gradient(135deg,#b8860b,#ffd700);padding:30px;text-align:center">'
      + '<div style="font-size:32px;font-weight:900;color:#000;letter-spacing:1px">VidiGagne</div>'
      + '<div style="color:#000;font-size:14px;margin-top:6px">Regarde des vidéos. Gagne de l\'argent.</div></div>'
      + '<div style="padding:30px;text-align:center;color:#fff">'
      + '<p style="font-size:18px">👋 Bienvenue dans la famille VidiGagne !</p>'
      + '<p style="color:#ccc;font-size:14px">Nous sommes ravis de te compter parmi nous. Pour sécuriser ton compte, voici ton code de vérification :</p>'
      + '<div style="font-size:48px;font-weight:900;letter-spacing:12px;color:#ffd700;margin:20px 0">' + code + '</div>'
      + '<p style="color:#999;font-size:12px">⏱️ Ce code expire dans 60 secondes.</p>'
      + '<p style="color:#ccc;font-size:14px;margin-top:20px">💰 Des milliers de créateurs gagnent déjà de l\'argent chaque jour sur VidiGagne.<br>À ton tour de briller ! ✨</p>'
      + '</div>'
      + '<div style="padding:20px;text-align:center;color:#666;font-size:11px;border-top:1px solid #222">Si tu n\'as pas demandé ce code, ignore simplement cet e-mail.<br>© 2026 VidiGagne — Fait avec ❤️</div></div>',
      });
      sent = true;
    } catch (e) { sent = false; }
  }
  if (!sent) {
    console.log('[verify] SMTP indisponible — code pour ' + identifier + ' : ' + code);
    if (process.env.NODE_ENV !== 'production') devCode = code;
    else return { error: "l'envoi d'e-mails n'est pas encore configuré — réessaie plus tard", status: 503 };
  }
  const out = { ok: true, sent, expires_in: 60 };
  if (devCode) out.dev_code = devCode;
  return out;
}
app.get('/api/diag/smtp-test', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  const m = mailer();
  if (!m) return res.json({ ok: false, reason: 'mailer null — variables SMTP manquantes' });
  try {
    await m.verify();
    res.json({ ok: true, message: 'connexion SMTP vérifiée' });
  } catch (e) { res.json({ ok: false, reason: String(e && e.message || e).slice(0, 200) }); }
});
// v2.33 : journal des tentatives e-mails/push (les bots de test vérifient l'appel, pas l'envoi réel)
app.get('/api/diag/email-push-log', async (req, res) => {
  try {
    if (!checkAdmin(req, res)) return;
    res.json({ ok: true, test_hooks: VG_TEST_HOOKS,
      emails: _emailAttempts.slice(-100), pushes: _pushAttempts.slice(-100) });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// v2.53 : diagnostic FCM (admin) — vérifie la config sans jamais exposer le secret.
// GET /api/diag/fcm → {sdk, creds_set}. POST /api/diag/fcm {fcm_token} → envoie un push de test.
app.get('/api/diag/fcm', async (req, res) => {
  try {
    if (!checkAdmin(req, res)) return;
    let sdk = false, initErr = '';
    try { require('firebase-admin'); sdk = true; } catch (_) { sdk = false; }
    res.json({ ok: true, sdk_installed: sdk,
      creds_set: fcmCredsSet(),
      project: process.env.FIREBASE_PROJECT_ID || null });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.post('/api/diag/fcm', async (req, res) => {
  try {
    if (!checkAdmin(req, res)) return;
    const fcmToken = String((req.body || {}).fcm_token || '').slice(0, 500);
    if (!fcmToken) return res.status(400).json({ error: 'fcm_token requis' });
    let adm;
    try { adm = fcmAdmin(); }
    catch (e) {
      const m = String((e && e.message) || e);
      if (!fcmCredsSet()) return res.json({ ok: false, reason: 'no_credentials' });
      return res.json({ ok: false, reason: m.slice(0, 120) });
    }
    const msgId = await adm.messaging().send({
token: fcmToken,
      notification: { title: 'VidiGagne ✅', body: 'Push de test — tout fonctionne !' },
      data: { type: 'test' },
    });
    res.json({ ok: true, message_id: msgId });
  } catch (e) { res.json({ ok: false, reason: String((e && e.message) || e).slice(0, 200) }); }
});
app.post('/api/auth/send-code', async (req, res) => {
  try {
    const kind = ((req.body || {}).kind === 'phone') ? 'phone' : 'email';
    const identifier = normIdentifier((req.body || {}).identifier, kind);
    if (!validIdentifier(identifier, kind)) return res.status(400).json({ error: 'identifiant invalide' });
    if (kind === 'phone')
      return res.json({ ok: true, firebase: true, expires_in: 60 });
    const r = await issueVerifyCode(identifier, kind);
    if (r.error) return res.status(r.status || 400).json({ error: r.error, retry_after: r.retry_after });
    res.json(r);
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.post('/api/auth/resend-code', async (req, res) => {
  try {
    const kind = ((req.body || {}).kind === 'phone') ? 'phone' : 'email';
    const identifier = normIdentifier((req.body || {}).identifier, kind);
    if (!validIdentifier(identifier, kind)) return res.status(400).json({ error: 'identifiant invalide' });
    if (kind === 'phone')
      return res.json({ ok: true, firebase: true, expires_in: 60 });
    const prev = await get1('SELECT id FROM verification_codes WHERE identifier=? ORDER BY id DESC LIMIT 1', identifier);
    if (!prev) return res.status(400).json({ error: "aucun code précédent — demande un code d'abord" });
    const r = await issueVerifyCode(identifier, kind);
    if (r.error) return res.status(r.status || 400).json({ error: r.error, retry_after: r.retry_after });
    res.json(r);
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.post('/api/auth/verify-code', async (req, res) => {
  try {
    const kind = ((req.body || {}).kind === 'phone') ? 'phone' : 'email';
    const identifier = normIdentifier((req.body || {}).identifier, kind);
    const code = String((req.body || {}).code || '').replace(/\D/g, '');
    if (!validIdentifier(identifier, kind) || code.length !== 6)
      return res.status(400).json({ error: 'code invalide' });
    const row = await get1('SELECT * FROM verification_codes WHERE identifier=? AND used=0 ORDER BY id DESC LIMIT 1', identifier);
    if (!row) return res.status(400).json({ error: 'aucun code en attente — demande un nouveau code' });
    if (row.attempts >= 5) return res.status(429).json({ error: 'trop de tentatives — demande un nouveau code' });
    if (now() > row.expires_at) return res.status(410).json({ error: 'code expiré — demande un nouveau code', expired: true });
    if (row.code !== code) {
      await runSql('UPDATE verification_codes SET attempts=attempts+1 WHERE id=?', row.id);
      return res.status(400).json({ error: 'code incorrect', attempts_left: Math.max(0, 4 - row.attempts) });
    }
    await runSql('UPDATE verification_codes SET used=1 WHERE id=?', row.id);
    const vtoken = crypto.randomBytes(24).toString('hex');
    const t = now();
    await runSql('INSERT INTO verified_tokens(token,identifier,created_at,expires_at,consumed) VALUES(?,?,?,?,?)',
      vtoken, identifier, t, t + VTOKEN_TTL_MS, 0);
    res.json({ ok: true, verified: true, verification_token: vtoken });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
async function peekVerifiedToken(vtoken) {
  const r = await get1('SELECT * FROM verified_tokens WHERE token=? AND consumed=0', String(vtoken || ''));
  if (!r || now() > r.expires_at) return null;
  return r;
}
async function consumeVerifiedToken(vtoken) {
  await runSql('UPDATE verified_tokens SET consumed=1 WHERE token=?', String(vtoken || ''));
}

app.patch('/api/auth/me', auth, async (req, res) => {
  const { name, avatar, bio, first_name, last_name, birthdate, gender, sub_enabled, sub_price, country, is_private, username, cover, pronouns, links } = req.body || {};
  const _gender = ['male', 'female', 'other'].includes(String(gender || '')) ? String(gender) : null;
  // FIX 2026-10-04 (rupture #2): avatar accepte les data URLs (photo galerie) jusqu'à 3 Mo, pas juste 8 caractères
  const _avatar = avatar ? String(avatar).slice(0, 3 * 1024 * 1024) : null;
  const _cover = cover !== undefined && cover !== null ? String(cover).slice(0, 3 * 1024 * 1024) : null;
  const _pronouns = pronouns !== undefined && pronouns !== null ? String(pronouns).slice(0, 30) : null;
  let _links = null;
  if (links !== undefined && links !== null) {
    try {
      const arr = Array.isArray(links) ? links : JSON.parse(String(links));
      _links = JSON.stringify(arr.slice(0, 5).map(l => ({ t: String(l.t || l.title || '').slice(0, 40), u: String(l.u || l.url || '').slice(0, 200) })).filter(l => l.u));
    } catch (e) { _links = null; }
  }
  // FIX torture 2026-10-05 : 13 ans minimum aussi sur modification du profil
  let _bd = /^\d{4}-\d{2}-\d{2}$/.test(birthdate || '') ? birthdate : null;
  if (_bd) {
    const _vb = validBirthdate(_bd);
    if (!_vb.ok) return res.status(400).json({ error: _vb.error });
  }
  await runSql('UPDATE users SET name=COALESCE(?,name), avatar=COALESCE(?,avatar), bio=COALESCE(?,bio), first_name=COALESCE(?,first_name), last_name=COALESCE(?,last_name), birthdate=COALESCE(?,birthdate), gender=COALESCE(?,gender), country=COALESCE(?,country), cover=COALESCE(?,cover), pronouns=COALESCE(?,pronouns), links=COALESCE(?,links) WHERE id=?',
    name !== undefined && name !== null ? String(name).slice(0, 40) : null,
    _avatar,
    // FIX 2026-10-04 (bot chain-bio-pseudo) : une bio envoyée vide ('') doit EFFACER
    // la bio (avant : '' → null → COALESCE gardait l'ancienne → divergence local/serveur)
    bio !== undefined && bio !== null ? String(bio).slice(0, 150) : null,
    first_name !== undefined ? String(first_name).trim().slice(0, 40) : null,
    last_name !== undefined ? String(last_name).trim().slice(0, 40) : null,
    _bd,
    _gender,
    /^[A-Z]{2}$/.test(String(country || '')) ? String(country) : null,
    _cover, _pronouns, _links, req.userId);
  // abonnement payant au créateur : activation + prix mensuel (pièces)
  if (sub_enabled !== undefined || sub_price !== undefined) {
    const se = sub_enabled ? 1 : 0;
    const sp = Math.max(0, Math.min(100000, Math.floor(Number(sub_price) || 0)));
    await runSql('UPDATE users SET sub_enabled=?, sub_price=? WHERE id=?', se, sp, req.userId);
  }
  // FIX 2026-10-04 (rupture #3): compte privé/public
  if (is_private !== undefined) {
    await runSql('UPDATE users SET is_private=? WHERE id=?', is_private ? 1 : 0, req.userId);
  }
  // FIX 2026-10-04 (rupture #4): changement de pseudo (unique, format validé)
  let usernameChanged = null;
  if (username !== undefined && username !== null) {
    const un = String(username).toLowerCase().trim();
    if (/^[a-z0-9._]{2,24}$/.test(un)) {
      const existing = await get1('SELECT id FROM users WHERE username=?', un);
      if (!existing || Number(existing.id) === Number(req.userId)) {
        await runSql('UPDATE users SET username=? WHERE id=?', un, req.userId);
        usernameChanged = un;
      } else {
        return res.status(409).json({ error: 'pseudo déjà pris' });
      }
    } else {
      return res.status(400).json({ error: 'pseudo invalide' });
    }
  }
  const u = await get1('SELECT * FROM users WHERE id=?', req.userId);
  const out = { user: privUser(u) };
  if (usernameChanged) out.usernameChanged = usernameChanged;
  res.json(out);
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
// médias commentaires : vidéo OU audio (réponses vocales v13)
const uploadMedia = multer({
  storage: USE_CLOUDINARY ? multer.memoryStorage() : multer.diskStorage({ destination: UP }),
  limits: { fileSize: 300 * 1024 * 1024 }, // 300 Mo max
  fileFilter: (req, file, cb) => {
    if (/^video\//.test(file.mimetype) || /^audio\//.test(file.mimetype)) cb(null, true);
    else cb(new Error('seules les vidéos et les audios sont acceptés'));
  },
});
// médias stories : vidéo OU photo
const uploadStory = multer({
  storage: USE_CLOUDINARY ? multer.memoryStorage() : multer.diskStorage({ destination: UP }),
  limits: { fileSize: 300 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/^(video|image)\//.test(file.mimetype)) cb(null, true);
    else cb(new Error('seules les vidéos et images sont acceptées'));
  },
});
// images : pièces d'identité (KYC)
const uploadImg = multer({
  storage: USE_CLOUDINARY ? multer.memoryStorage() : multer.diskStorage({ destination: UP }),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 Mo max
  fileFilter: (req, file, cb) => {
    if (/^image\//.test(file.mimetype)) cb(null, true);
    else cb(new Error('seules les images sont acceptées'));
  },
});
async function storeImage(file, folder) {
  const kind = detectMediaKind(mediaBytes(file));
  if (kind === 'svg') throw new Error('les images SVG sont refusées (risque de script)');
  if (kind !== 'image') throw new Error('fichier image invalide (contenu non reconnu)');
  const ext = MEDIA_EXT.image; // extension forcée selon le contenu réel
  if (USE_CLOUDINARY) {
    const tmp = path.join(os.tmpdir(), 'vgimg' + Date.now() + '_' + crypto.randomBytes(6).toString('hex') + ext);
    fs.writeFileSync(tmp, file.buffer);
    try {
      const up = await cloudinary.uploader.upload(tmp, { resource_type: 'image', folder: folder || 'vidigagne' });
      return up.secure_url;
    } finally { fs.unlink(tmp, () => {}); }
  }
  const fname = 'img' + Date.now() + '_' + crypto.randomBytes(6).toString('hex') + ext;
  fs.renameSync(file.path, path.join(UP, fname));
  return fname;
}
// v1.57 : messages vocaux — upload audio (max 2 Mo, ~2 min)
const uploadVoice = multer({
  storage: USE_CLOUDINARY ? multer.memoryStorage() : multer.diskStorage({ destination: UP }),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/^audio\//.test(file.mimetype)) cb(null, true);
    else cb(new Error('seul l\u2019audio est accepté'));
  },
});
async function storeVoice(file) {
  // FIX fuzz 2026-10-05 : valider le contenu réel (le mimetype multipart est falsifiable —
  // un fichier texte déguisé en audio était accepté). WebM accepté : les vocaux de l'app
  // sont enregistrés en WebM/Opus (detectMediaKind → 'video' pour EBML).
  const kind = detectMediaKind(mediaBytes(file));
  if (kind !== 'audio' && kind !== 'video') throw new Error('fichier audio invalide (contenu non reconnu)');
  const ext = '.webm';
  if (USE_CLOUDINARY) {
    const tmp = path.join(os.tmpdir(), 'vgvoice' + Date.now() + '_' + crypto.randomBytes(6).toString('hex') + ext);
    fs.writeFileSync(tmp, file.buffer);
    try {
      const up = await cloudinary.uploader.upload(tmp, { resource_type: 'video', folder: 'vidigagne/voice' });
      return up.secure_url;
    } finally { fs.unlink(tmp, () => {}); }
  }
  const fname = 'voice' + Date.now() + '_' + crypto.randomBytes(6).toString('hex') + ext;
  fs.renameSync(file.path, path.join(UP, fname));
  return fname;
}
app.post('/api/upload/voice', auth, uploadVoice.single('audio'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'aucun fichier audio' });
    const url = await storeVoice(req.file);
    res.json({ url: fileUrl(url) });
  } catch (e) { res.status(400).json({ error: e.message || 'upload impossible' }); }
});
// v12 : photos multiples (carrousels) — max 10 images
const uploadPhotos = multer({
  storage: USE_CLOUDINARY ? multer.memoryStorage() : multer.diskStorage({ destination: UP }),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 Mo par image
  fileFilter: (req, file, cb) => {
    if (/^image\//.test(file.mimetype)) cb(null, true);
    else cb(new Error('seules les images sont acceptées'));
  },
});
// valide et normalise le champ captions (string JSON) -> string JSON sûre
function cleanCaptions(raw) {
  try {
    const c = JSON.parse(raw);
    if (Array.isArray(c)) return JSON.stringify(c.map(x => String(x).slice(0, 200)));
  } catch (e) {}
  return '[]';
}


// v1.66 : 🤖 le bot supprime à la publication tout hashtag mentionnant une plateforme concurrente
const BANNED_PLATFORM_TAGS = new Set(("tiktok,tik_tok,tiktoker,tiktokeuse,tiktokfrance,tiktokviral,tiktokdance," +
  "tiktokchallenge,doutok,douyin,facebook,fb,facebooks,youtube,youtu,youtuber,youtubeuse,instagram,insta,ig," +
  "snapchat,snap,twitter,tweet,tweets,x,whatsapp,telegram,twitch,twitchtv,reddit,pinterest,linkedin,threads," +
  "discord,kwai,triller,likee,dubsmash,vimeo,dailymotion,periscope,vine,musically,musicaly,reels,shorts,story").split(','));
// un hashtag est interdit s'il EST ou CONTIENT un nom de plateforme (ex: #tiktokfrance)
function stripBannedTags(text) {
  let removed = [];
  const clean = String(text || '').replace(/#([\p{L}\p{N}_]+)/gu, (m, tag) => {
    const t = tag.toLowerCase();
    for (const b of BANNED_PLATFORM_TAGS) {
      if (t === b || t.includes(b) || b.includes(t) && t.length > 2) { removed.push('#' + tag); return ''; }
    }
    return m;
  });
  return { clean: clean.replace(/\s{2,}/g, ' ').trim(), removed: [...new Set(removed)] };
}

app.post('/api/videos', auth, upload.single('video'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'aucune vidéo reçue' });
    // FIX torture 2026-10-05 : fichier vide → 400 explicite
    if (!req.file.size) return res.status(400).json({ error: 'fichier vide : envoie une vraie vidéo' });
    // v1.54 : quota de stockage (2 Go / utilisateur)
    if (!(await checkQuota(req.userId, req.file.size || 0)))
      return res.status(413).json({ error: 'quota de stockage atteint (2 Go)' });
    const fname = await storeVideo(req.file);
    const b = req.body || {};
    let descText = String(b.description || b.desc || '').slice(0, 500);
    // 🤖 le bot supprime les hashtags de plateformes concurrentes dès la publication
    const _bt = stripBannedTags(descText);
    descText = _bt.clean;
    const _bt2 = stripBannedTags(String(b.tags || ''));
    if (b.tags) b.tags = _bt2.clean;
    const _bannedRemoved = [...new Set([..._bt.removed, ..._bt2.removed])];
    // publication programmée : scheduled_at (ms) doit être dans le futur, sinon publication immédiate
    let scheduledAt = null;
    const schRaw = Number(b.scheduled_at);
    if (b.scheduled_at && schRaw > now()) scheduledAt = schRaw;
    // visibilité : public | subscribers (abonnés payants) | private | friends
    let visibility = String(b.visibility || 'public');
    if (visibility === 'subscribers_only') visibility = 'subscribers'; // valeur envoyée par l'app
    // FIX 2026-10-04 (rupture #1): 'friends' accepté, valeurs inconnues → 'private' (sécurisé) au lieu de 'public'
    if (!['public', 'subscribers', 'private', 'friends'].includes(visibility)) visibility = 'private';
    const captions = b.captions ? cleanCaptions(b.captions) : '[]';
    // m6 : durée max 10 minutes vérifiée côté serveur (pas seulement dans l'appli)
    const duration = Number(b.duration) || 0;
    if (duration > 600) return res.status(400).json({ error: 'vidéo trop longue (10 min max)' });
    // v13 : replay de live + voix de synthèse TTS
    const isReplay = b.is_replay ? 1 : 0;
    const liveId = b.live_id ? Number(b.live_id) : null;
    const ttsText = String(b.tts_text || '').slice(0, 500);
    const ttsVoice = String(b.tts_voice || '').slice(0, 120);
    let ttsRate = Number(b.tts_rate) || 1;
    if (ttsRate < 0.5) ttsRate = 0.5;
    if (ttsRate > 2) ttsRate = 2;
    // FIX 2026-10-04 : l'app envoie target_countries en chaîne JSON via multipart (pas un tableau)
    let _tcRaw = b.target_countries;
    if (typeof _tcRaw === 'string') { try { _tcRaw = JSON.parse(_tcRaw); } catch (_) { _tcRaw = []; } }
    const _tc = Array.isArray(_tcRaw) ? _tcRaw.filter(x => /^[A-Z]{2}$/.test(String(x))).slice(0, 1) : [];
    const _tcJson = JSON.stringify(_tc);
    // FIX 2026-10-04 : stitch_of envoyé par l'app (collage) — validé contre allow_stitch de l'original
    let _stitchOf = Math.floor(Number(b.stitch_of)) || 0;
    if (_stitchOf) { const _so = await get1('SELECT allow_stitch FROM videos WHERE id=?', _stitchOf); if (!_so || !Number(_so.allow_stitch)) _stitchOf = 0; }
    // v2.33 : duet_of envoyé par l'app (duo) — validé contre allow_duet de l'original
    // (un duo de duo reste autorisé tant que la vidéo duetée l'autorise → chaînes de duos possibles)
    let _duetOf = Math.floor(Number(b.duet_of)) || 0;
    if (_duetOf) { const _do = await get1('SELECT allow_duet FROM videos WHERE id=?', _duetOf); if (!_do || !Number(_do.allow_duet)) _duetOf = 0; }
    // FIX 2026-10-04 (parité TikTok) : l'app envoie sound='srv:<id>' quand le son vient
    // du catalogue serveur — on résout le titre + on stocke sound_id pour que la page
    // du son liste la vidéo et que le disque 💿 du feed ouvre la vraie page du son.
    let _sndVal = String(b.sound || '').slice(0, 120), _sndId = 0;
    const _sm = _sndVal.match(/^srv:(\d+)$/);
    if (_sm) {
      const _s = await get1('SELECT id,title FROM sounds WHERE id=?', Number(_sm[1]));
      if (_s) { _sndId = _s.id; _sndVal = String(_s.title).slice(0, 120); } else _sndVal = '';
    }
    const _effVal = String(b.effect || '').slice(0, 80);
    const id = await insertId(
      'INSERT INTO videos(user_id,file,description,tags,sound,sound_id,effect,duration,scheduled_at,visibility,captions,is_replay,live_id,tts_text,tts_voice,tts_rate,target_countries,stitch_of,duet_of,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      req.userId, fname, descText, String(b.tags || '').slice(0, 300),
      _sndVal, _sndId, _effVal, duration, scheduledAt, visibility, captions,
      isReplay, liveId, ttsText, ttsVoice, ttsRate, _tcJson, _stitchOf, _duetOf, now());
    if (_bannedRemoved.length) {
      try { await notify(req.userId, 'system', null, null,
        '🤖 Hashtags supprimés : ' + _bannedRemoved.join(' ') + ' (plateformes concurrentes interdites)'); } catch (_) {}
    }
    // v2.41 : notifier les abonnés d'une nouvelle vidéo publique (respecte la pref notif_newvideos via notify())
    (async () => {
      try {
        if (visibility === 'public' && !scheduledAt) {
          const me = await get1('SELECT username FROM users WHERE id=?', req.userId);
          const fols = await allRows('SELECT follower_id FROM follows WHERE followed_id=?', req.userId);
          for (const f of (fols || [])) {
            await notify(f.follower_id, 'new_video', req.userId, id,
              '🎬 @' + (me ? me.username : 'créateur') + ' a publié une nouvelle vidéo');
          }
        }
      } catch (_) {}
    })();
    // pièces : +10 par publication — FIX éco 2026-10-05 (abus B1) : AUCUN plafond avant →
    // 100 micro-vidéos = 1000 pièces = seuil de retrait (2 $). Maintenant : 100/jour max
    // (10 publications), même pattern que les watch-rewards (withUserLock anti-TOCTOU).
    const _pubDayStart = new Date().setHours(0, 0, 0, 0);
    await withUserLock(req.userId, async () => {
      const _pubEarned = Number((await get1(
        "SELECT COALESCE(SUM(amount),0) AS s FROM ledger WHERE user_id=? AND reason LIKE 'publication vidéo%' AND created_at>=?",
        req.userId, _pubDayStart)).s);
      if (_pubEarned >= 100) return;
      const _pubGrant = Math.min(10, 100 - _pubEarned);
      await runSql('UPDATE users SET coins=coins+? WHERE id=?', _pubGrant, req.userId);
      await runSql('INSERT INTO ledger(user_id,amount,reason,created_at) VALUES(?,?,?,?)',
        req.userId, _pubGrant, 'publication vidéo #' + id, now());
    });
    // modération auto V3 : scan du texte (sans IA externe)
    const badW = scanBanned(descText + ' ' + String(b.tags || ''));
    if (badW) {
      await runSql(`UPDATE videos SET hidden=1, review_status='pending' WHERE id=?`, id);
      await flagForReview('video', id, 'mot interdit : ' + badW);
      await modFlag('video', id, 'mot interdit : ' + badW); // v2.39 : file mod_queue
    }
    const v = await get1('SELECT * FROM videos WHERE id=?', id);
    // v1.58 : hash perceptuel en arrière-plan (recherche par image) — ne bloque pas la réponse
    try {
      if (!/^https?:\/\//.test(fname)) {
        const fpath = path.join(UP, fname);
        const { execFile } = require('child_process');
        execFile('python3', [__dirname + '/phash.py', fpath], { timeout: 90000 }, async (err, stdout) => {
          try {
            const h = String(stdout || '').trim();
            if (/^[0-9a-f]{16}$/.test(h)) await runSql('UPDATE videos SET phash=? WHERE id=?', h, id);
          } catch (_) {}
        });
      }
    } catch (_) {}
    // v2.40 : badge créateur — 10 vidéos publiées
    try {
      const vc = await get1('SELECT COUNT(*) AS n FROM videos WHERE user_id=?', req.userId);
      if (vc && Number(vc.n) >= 10) {
        await insertIgnore('INSERT OR IGNORE INTO user_badges(user_id,badge,awarded_at) VALUES(?,?,?)', req.userId, 'creator', now());
      }
    } catch (e) {}
    res.json({ video: await videoJSON(v, req.userId), pending_review: !!badW });
  } catch (e) {
    // FIX torture 2026-10-05 : fichier invalide (0 octet, corrompu, faux format) → 400, pas 500
    if (e && /fichier (vidéo|audio|image) invalide|contenu non reconnu/i.test(e.message || ''))
      return res.status(400).json({ error: 'fichier invalide : envoie une vraie vidéo' });
    res.status(500).json({ error: "échec du téléversement" });
  }
});

// ---------- v12 : publication photo (carrousel, max 10 images) ----------
app.post('/api/photos', auth, uploadPhotos.array('photos', 10), async (req, res) => {
  try {
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: 'aucune photo reçue (1 à 10 images)' });
    const raw = [];
    for (const f of files) raw.push(await storeImage(f, 'vidigagne/photos'));
    const urls = raw.map(fileUrl);
    const b = req.body || {};
    let descText = String(b.description || b.desc || '').slice(0, 500);
    // 🤖 le bot supprime les hashtags de plateformes concurrentes dès la publication
    const _bt = stripBannedTags(descText);
    descText = _bt.clean;
    const _bt2 = stripBannedTags(String(b.tags || ''));
    if (b.tags) b.tags = _bt2.clean;
    const _bannedRemoved = [...new Set([..._bt.removed, ..._bt2.removed])];
    const captions = b.captions ? cleanCaptions(b.captions) : '[]';
    const id = await insertId(
      `INSERT INTO videos(user_id,file,description,tags,media_type,photos,captions,visibility,created_at)
       VALUES(?,?,?,?,?,?,?,?,?)`,
      req.userId, raw[0], descText, String(b.tags || '').slice(0, 300),
      'photo', JSON.stringify(urls), captions, 'public', now());
    // modération auto : même scan que les vidéos
    const badW = scanBanned(descText + ' ' + String(b.tags || ''));
    if (badW) {
      await runSql(`UPDATE videos SET hidden=1, review_status='pending' WHERE id=?`, id);
      await flagForReview('video', id, 'mot interdit : ' + badW);
      await modFlag('video', id, 'mot interdit : ' + badW); // v2.39 : file mod_queue
    }
    const v = await get1('SELECT * FROM videos WHERE id=?', id);
    res.json({ video: await videoJSON(v, req.userId), pending_review: !!badW });
  } catch (e) {
    // FIX torture 2026-10-05 : fichier invalide → 400, pas 500
    if (e && /fichier (vidéo|audio|image) invalide|contenu non reconnu/i.test(e.message || ''))
      return res.status(400).json({ error: 'fichier invalide : envoie une vraie photo' });
    res.status(500).json({ error: 'échec du téléversement' });
  }
});

// ==================== PHASE 2 ====================
// ---------- stories (24 h) ----------
app.post('/api/stories', auth, uploadStory.fields([{ name: 'video', maxCount: 1 }, { name: 'image', maxCount: 1 }]), async (req, res) => {
  try {
    const file = (req.files && (req.files.video || req.files.image) || [])[0];
    if (!file) return res.status(400).json({ error: 'aucune vidéo/image reçue' });
    if (!(await checkQuota(req.userId, file.size || 0)))
      return res.status(413).json({ error: 'quota de stockage atteint (2 Go)' });
    // v2.35 FIX : les stories image étaient rejetées par storeVideo (contenu non vidéo)
    const isImg = /^image\//.test(file.mimetype || '');
    const fname = isImg ? await storeImage(file, 'vidigagne/stories') : await storeVideo(file);
    const t = now();
    const privacy = ['public', 'friends'].includes(String(req.body.privacy)) ? String(req.body.privacy) : 'public';
    const text = String(req.body.text || '').slice(0, 200);
    const id = await insertId('INSERT INTO stories(user_id,file,privacy,text,created_at,expires_at) VALUES(?,?,?,?,?,?)',
      req.userId, fname, privacy, text, t, t + 86400000);
    res.json({ ok: true, id });
  } catch (e) { res.status(500).json({ error: 'échec du téléversement' }); }
});
// ---------- cadeaux ----------
// Partage 50/50 VidiGagne : l'envoyeur est débité du coût total,
// le créateur reçoit 50%, la plateforme 50% (commission).
async function applyGiftSplit(fromId, toId, cost, giftId, liveId) {
  const creatorShare = Math.floor(cost / 2);
  const platformShare = cost - creatorShare;
  await runSql('UPDATE users SET coins=coins+? WHERE id=?', creatorShare, toId);
  await runSql('INSERT INTO ledger(user_id,amount,reason,created_at) VALUES(?,?,?,?)',
    fromId, -cost, 'cadeau ' + giftId, now());
  await runSql('INSERT INTO ledger(user_id,amount,reason,created_at) VALUES(?,?,?,?)',
    toId, creatorShare, 'cadeau reçu ' + giftId + ' (50%)', now());
  await runSql('INSERT INTO ledger(user_id,amount,reason,created_at) VALUES(?,?,?,?)',
    0, platformShare, 'commission cadeau ' + giftId, now());
  if (liveId) {
    await runSql('INSERT INTO live_gifts(live_id,from_id,to_id,gift,cost,creator_share,platform_share,created_at) VALUES(?,?,?,?,?,?,?,?)',
      liveId, fromId, toId, giftId, cost, creatorShare, platformShare, now()).catch(() => {});
  }
  return { creatorShare, platformShare };
}
const GIFT_CATALOG = [
  { id: 'coeur', emoji: '❤️', cost: 1, name: 'Cœur' },
  { id: 'rose', emoji: '🌹', cost: 10, name: 'Rose' },
  { id: 'cadeau', emoji: '🎁', cost: 30, name: 'Cadeau' },
  { id: 'coeurbrillant', emoji: '💖', cost: 50, name: 'Cœur brillant' },
  { id: 'cafe', emoji: '☕', cost: 100, name: 'Café' },
  { id: 'micro', emoji: '🎤', cost: 200, name: 'Micro' },
  { id: 'champagne', emoji: '🍾', cost: 300, name: 'Champagne' },
  { id: 'couronne', emoji: '👑', cost: 500, name: 'Couronne' },
  { id: 'fusee', emoji: '🚀', cost: 800, name: 'Fusée' },
  { id: 'diamant', emoji: '💎', cost: 1000, name: 'Diamant' },
  { id: 'trophee', emoji: '🏆', cost: 2000, name: 'Trophée' },
  { id: 'etoile', emoji: '🌟', cost: 5000, name: 'Superstar' },
  // v2.52 : catalogue cadeaux façon TikTok LIVE (prix mappés : 1 pièce TikTok ≈ 6 pièces
  // VidiGagne, à 500 pièces = 1 $. L'échelle de prestige est préservée : le Lion reste
  // le cadeau légendaire. Split 50/50 existant inchangé.)
  { id: 'fingerheart', emoji: '🫰', cost: 30, name: 'Cœur avec les doigts' },
  { id: 'chapeau', emoji: '🎩', cost: 594, name: 'Chapeau' },
  { id: 'moneygun', emoji: '🔫', cost: 3000, name: 'Pistolet à billets' },
  { id: 'corgi', emoji: '🐶', cost: 1794, name: 'Corgi' },
  { id: 'mineor', emoji: '⛏️', cost: 6000, name: "Mine d'or" },
  { id: 'galaxie', emoji: '🌌', cost: 6000, name: 'Galaxie' },
  { id: 'baleine', emoji: '🐋', cost: 12900, name: 'Baleine' },
  { id: 'meteore', emoji: '☄️', cost: 90000, name: 'Pluie de météores' },
  { id: 'fetef', emoji: '🎡', cost: 102000, name: 'Fête foraine' },
  { id: 'amourfou', emoji: '💘', cost: 120000, name: 'Amour fou' },
  { id: 'chateau', emoji: '🏰', cost: 120000, name: 'Château fantastique' },
  { id: 'navette', emoji: '🛸', cost: 120000, name: 'Navette TikTok' },
  { id: 'yacht', emoji: '🛥️', cost: 120000, name: 'Yacht' },
  { id: 'carrosse', emoji: '🎠', cost: 150000, name: 'Carrosse de roses' },
  { id: 'reve', emoji: '💭', cost: 156000, name: "Rêve d'Adam" },
  { id: 'phoenix', emoji: '🔥', cost: 156000, name: 'Phénix' },
  { id: 'dino', emoji: '🦕', cost: 156000, name: 'Big Dino' },
  { id: 'dragon', emoji: '🐉', cost: 162000, name: 'Flamme du dragon' },
  { id: 'sportscar', emoji: '🏎️', cost: 180000, name: 'Voiture de sport dorée' },
  { id: 'lion', emoji: '🦁', cost: 180000, name: 'Lion' },
  { id: 'gorille', emoji: '🦍', cost: 180000, name: 'Gorille' },
  { id: 'sam', emoji: '🐳', cost: 180000, name: 'Sam la baleine' },
  { id: 'leonlion', emoji: '👑', cost: 204000, name: 'Léon et le Lion' },
  { id: 'zeus', emoji: '⚡', cost: 204000, name: 'Zeus' },
  { id: 'phoque', emoji: '🦭', cost: 207000, name: 'Phoque et baleine' },
  { id: 'universeplus', emoji: '✨', cost: 210000, name: 'Univers TikTok+' },
  { id: 'faucon', emoji: '🦅', cost: 240000, name: 'Faucon tonnerre' },
  { id: 'stars', emoji: '💫', cost: 240000, name: 'Stars TikTok' },
  { id: 'hollion', emoji: '🎄', cost: 240000, name: 'Lion des fêtes' },
  { id: 'firephoenix', emoji: '🌋', cost: 252000, name: 'Phénix de feu' },
  { id: 'pegase', emoji: '🐎', cost: 258000, name: 'Pégase' },
  { id: 'universe', emoji: '🪐', cost: 270000, name: 'Univers TikTok' },
  { id: 'holiverse', emoji: '🎆', cost: 366000, name: 'Univers des fêtes' },
];
app.get('/api/gifts/catalog', (req, res) => res.json({ gifts: GIFT_CATALOG }));
app.post('/api/gifts', auth, async (req, res) => {
  try {
    const { to, video_id, gift } = req.body || {};
    const g = GIFT_CATALOG.find(x => x.id === gift);
    if (!g) return res.status(400).json({ error: 'cadeau inconnu' });
    const me = await get1('SELECT * FROM users WHERE id=?', req.userId);
    if (!me) return res.status(400).json({ error: 'compte introuvable' });
    const dest = await get1('SELECT * FROM users WHERE id=?', +to);
    if (!dest) return res.status(404).json({ error: 'destinataire inconnu' });
    if (dest.id === req.userId) return res.status(400).json({ error: 'impossible' });
    const debited = await runSqlChanges('UPDATE users SET coins=coins-? WHERE id=? AND coins>=?', g.cost, req.userId, g.cost);
    if (!debited) return res.status(400).json({ error: 'pas assez de pièces' });
    await applyGiftSplit(req.userId, dest.id, g.cost, g.id, null);
    await runSql('INSERT INTO gifts(from_id,to_id,video_id,gift,cost,created_at) VALUES(?,?,?,?,?,?)',
      req.userId, dest.id, video_id || null, g.id, g.cost, now());
    await notify(dest.id, 'gift', req.userId, video_id || null, g.emoji + ' ' + g.name + ' (+' + g.cost + ')'); // v2.31 : montant inclus
    // v2.44-EQC-WH : cadeau → webhook gift.new (créateur pro)
    fireWebhooks(dest.id, 'gift.new', { from: me.username, gift: g.id, coins: g.cost, video_id: video_id || null, at: Date.now() });
    await maybeGiftEmail(dest.id, me.username, g); // v2.33 : e-mail si gros cadeau (≥100 🪙)
    const balG = await get1('SELECT coins FROM users WHERE id=?', req.userId);
    res.json({ ok: true, coins: balG ? balG.coins : 0 });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// ---------- v2.37 : portefeuille & gains avancés (streak, quêtes, classement, transferts, remerciements, annulation retrait) ----------
// Annulation d'un retrait par l'utilisateur (uniquement si encore pending) → remboursement
app.post('/api/withdraw/:id/cancel', auth, async (req, res) => {
  try {
    const w = await get1('SELECT * FROM withdrawals WHERE id=?', req.params.id);
    if (!w) return res.status(404).json({ error: 'retrait introuvable' });
    if (Number(w.user_id) !== Number(req.userId)) return res.status(403).json({ error: 'non autorisé' });
    if (w.status !== 'pending') return res.status(400).json({ error: 'déjà traité (' + w.status + ')' });
    const t = now();
    await raceGap(req); // crochet test concurrence (Équipe 8/10) : simule l'intercalage Postgres
    // FIX race 2026-10-05 (Équipe 8/10) : double annulation — la transition
    // pending→cancelled est atomique (UPDATE conditionnel) ; seul le premier passage
    // rembourse. Avant : 5 annulations simultanées remboursaient 5 fois
    // (prouvé : 10000 au lieu de 2000).
    const cancelled = await runSqlChanges("UPDATE withdrawals SET status='cancelled', decided_at=? WHERE id=? AND status='pending'", t, w.id);
    if (!cancelled) return res.status(400).json({ error: 'déjà traité (' + w.status + ')' });
    await runSql('UPDATE users SET coins=coins+? WHERE id=?', w.coins, w.user_id);
    await runSql('INSERT INTO ledger(user_id,amount,reason,created_at) VALUES(?,?,?,?)',
      w.user_id, w.coins, 'annulation retrait #' + w.id + ' par l\'utilisateur', t);
    await runSql('UPDATE receipts SET status=? WHERE withdrawal_id=?', 'cancelled', w.id);
    await notify(w.user_id, 'withdrawal', null, null,
      '↩️ Ton retrait de ' + w.coins + ' 🪙 a été annulé. Les pièces ont été recréditées.');
    const bal = await get1('SELECT coins FROM users WHERE id=?', req.userId);
    res.json({ ok: true, id: w.id, status: 'cancelled', refunded: w.coins, coins: bal ? bal.coins : 0 });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// Série de connexion quotidienne : bonus progressif (jour N → min(N*5, 50) pièces)
function streakBonus(n) { return Math.min(Math.max(1, n) * 5, 50); }
function utcDay(ms) { return new Date(ms).toISOString().slice(0, 10); }
// FIX temps 2026-10-05 (T2) : les séries comptaient les jours en UTC. Pour Haïti (UTC-4),
// un checkin mardi 21h (= mercredi 01h UTC) « sautait » le mardi → série cassée à tort.
// Jour local du joueur quand son tz_offset est connu (envoyé par l'app, cf. T7), UTC sinon.
// (tz_offset=0 → identique à utcDay, aucun changement pour les autres.)
function userDay(ms, tzMin) {
  const off = Number(tzMin) || 0;
  return off ? new Date(ms + off * 60000).toISOString().slice(0, 10) : utcDay(ms);
}
async function userTz(userId) {
  try { const u = await get1('SELECT tz_offset FROM users WHERE id=?', userId); return Number(u && u.tz_offset) || 0; }
  catch (_) { return 0; }
}
app.post('/api/streak/checkin', auth, async (req, res) => {
  try {
    // FIX race 2026-10-05 (Équipe 8/10) : double checkin — lecture+crédit sérialisés
    // par utilisateur. Avant : 2 requêtes simultanées créditaient le bonus 2 fois
    // (prouvé : +10 au lieu de +5).
    const out = await withUserLock(req.userId, async () => {
      // T2 : jour LOCAL du joueur (pas UTC) — avec tolérance de transition : last_day peut
      // encore être au format UTC (écrit avant que l'app n'envoie tz_offset) ; on accepte
      // hier en local OU hier en UTC pour ne pas casser une série existante à la bascule.
      const tz = await userTz(req.userId);
      const t = now(), today = userDay(t, tz), yest = userDay(t - 86400000, tz), yestU = utcDay(t - 86400000);
      const row = await get1('SELECT * FROM login_streaks WHERE user_id=?', req.userId);
      if (row && row.last_day === today)
        return { ok: true, streak: row.streak, bonus: 0, already: true, day: today };
      const streak = (row && (row.last_day === yest || row.last_day === yestU)) ? row.streak + 1 : 1;
      const bonus = streakBonus(streak);
      await raceGap(req); // crochet test concurrence (Équipe 8/10) : simule l'intercalage Postgres
      await runSql('UPDATE users SET coins=coins+? WHERE id=?', bonus, req.userId);
      await runSql('INSERT INTO ledger(user_id,amount,reason,created_at) VALUES(?,?,?,?)',
        req.userId, bonus, '🔥 bonus série jour ' + streak, t);
      if (row) await runSql('UPDATE login_streaks SET streak=?, last_day=?, updated_at=? WHERE user_id=?', streak, today, t, req.userId);
      else await runSql('INSERT INTO login_streaks(user_id,streak,last_day,updated_at) VALUES(?,?,?,?)', req.userId, streak, today, t);
      return { ok: true, streak, bonus, day: today };
    });
    res.json(out);
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.get('/api/streak', auth, async (req, res) => {
  try {
    const row = await get1('SELECT * FROM login_streaks WHERE user_id=?', req.userId);
    const today = userDay(now(), await userTz(req.userId)); // T2 : jour local, pas UTC
    res.json({ streak: row ? row.streak : 0, last_day: row ? row.last_day : null,
      checked_in_today: !!(row && row.last_day === today), next_bonus: streakBonus((row ? row.streak : 0) + 1) });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// Quêtes quotidiennes (progression calculée depuis les tables existantes, sans hooks invasifs)
const DAILY_QUESTS = [
  { key: 'watch5', name: 'Regarde 5 vidéos', emoji: '👀', target: 5, reward: 10 },
  { key: 'like3', name: 'Aime 3 vidéos', emoji: '❤️', target: 3, reward: 8 },
  { key: 'comment2', name: 'Commente 2 vidéos', emoji: '💬', target: 2, reward: 8 },
  { key: 'publish1', name: 'Publie 1 vidéo', emoji: '🎬', target: 1, reward: 15 },
];
async function questProgress(userId, key, day, dayStart) {
  if (key === 'watch5') { const r = await get1('SELECT COUNT(*) AS n FROM watch_rewards WHERE user_id=? AND day=?', userId, day); return r ? r.n : 0; }
  if (key === 'like3') { const r = await get1('SELECT COUNT(*) AS n FROM likes WHERE user_id=? AND created_at>=?', userId, dayStart); return r ? r.n : 0; }
  if (key === 'comment2') { const r = await get1('SELECT COUNT(*) AS n FROM comments WHERE user_id=? AND created_at>=?', userId, dayStart); return r ? r.n : 0; }
  if (key === 'publish1') { const r = await get1('SELECT COUNT(*) AS n FROM videos WHERE user_id=? AND created_at>=?', userId, dayStart); return r ? r.n : 0; }
  return 0;
}
app.get('/api/quests', auth, async (req, res) => {
  try {
    const day = utcDay(now());
    const dayStart = new Date(day + 'T00:00:00Z').getTime();
    const out = [];
    for (const q of DAILY_QUESTS) {
      const progress = await questProgress(req.userId, q.key, day, dayStart);
      const cl = await get1('SELECT 1 AS c FROM quest_claims WHERE user_id=? AND quest_key=? AND day=?', req.userId, q.key, day);
      out.push({ ...q, progress, claimed: !!cl, done: progress >= q.target });
    }
    res.json({ day, quests: out });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.post('/api/quests/:key/claim', auth, async (req, res) => {
  try {
    const q = DAILY_QUESTS.find(x => x.key === req.params.key);
    if (!q) return res.status(404).json({ error: 'quête inconnue' });
    const day = utcDay(now());
    const dayStart = new Date(day + 'T00:00:00Z').getTime();
    const progress = await questProgress(req.userId, q.key, day, dayStart);
    if (progress < q.target) return res.status(400).json({ error: 'quête incomplète (' + progress + '/' + q.target + ')' });
    const cl = await get1('SELECT 1 AS c FROM quest_claims WHERE user_id=? AND quest_key=? AND day=?', req.userId, q.key, day);
    if (cl) return res.status(400).json({ error: 'récompense déjà réclamée aujourd\'hui' });
    const t = now();
    const ins = USE_PG
      ? 'INSERT INTO quest_claims(user_id,quest_key,day,created_at) VALUES(?,?,?,?) ON CONFLICT DO NOTHING'
      : 'INSERT OR IGNORE INTO quest_claims(user_id,quest_key,day,created_at) VALUES(?,?,?,?)';
    await runSql(ins, req.userId, q.key, day, t);
    const again = await get1('SELECT created_at FROM quest_claims WHERE user_id=? AND quest_key=? AND day=?', req.userId, q.key, day);
    if (!again || Number(again.created_at) !== t) return res.status(400).json({ error: 'récompense déjà réclamée aujourd\'hui' });
    // v2.46 : gains bloqués si l'utilisateur est sur un device flagged avec ≥5 comptes (fraud-review)
    // — même protection que les watch-rewards (cohérence anti-fraude, audit économique 2026-10-05)
    if (await deviceEarningsBlocked(req.userId)) {
      const _b = await get1('SELECT coins FROM users WHERE id=?', req.userId);
      return res.json({ ok: true, reward: 0, granted: 0, reason: 'fraud-review', coins: _b ? _b.coins : 0 });
    }
    await runSql('UPDATE users SET coins=coins+? WHERE id=?', q.reward, req.userId);
    await runSql('INSERT INTO ledger(user_id,amount,reason,created_at) VALUES(?,?,?,?)',
      req.userId, q.reward, '🎯 quête "' + q.name + '"', t);
    const bal = await get1('SELECT coins FROM users WHERE id=?', req.userId);
    res.json({ ok: true, reward: q.reward, coins: bal ? bal.coins : 0 });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// Classement hebdo : top 20 par pièces gagnées (7 derniers jours) + rang du demandeur
app.get('/api/leaderboard', auth, async (req, res) => {
  try {
    const weekAgo = now() - 7 * 86400000;
    const top = await allRows(
      `SELECT u.id, u.username, COALESCE(SUM(CASE WHEN l.amount>0 THEN l.amount ELSE 0 END),0) AS earned
       FROM users u LEFT JOIN ledger l ON l.user_id=u.id AND l.created_at>=?
       GROUP BY u.id ORDER BY earned DESC LIMIT 20`, weekAgo);
    let myRank = null, myEarned = 0;
    for (let i = 0; i < top.length; i++) {
      if (Number(top[i].id) === Number(req.userId)) { myRank = i + 1; myEarned = top[i].earned; break; }
    }
    if (myRank === null) {
      const me = await get1('SELECT COALESCE(SUM(CASE WHEN amount>0 THEN amount ELSE 0 END),0) AS e FROM ledger WHERE user_id=? AND created_at>=?', req.userId, weekAgo);
      myEarned = me ? me.e : 0;
      // FIX 2026-10-05 (creusage profond #5) : ex æquo incohérent — COUNT(earned>moi)+1
      // donnait rang=1 à un 21e ex æquo alors que le top-20 affiche des rangs séquentiels.
      // Rang = vraie position séquentielle (ordre : gains DESC, id ASC), cohérente avec le top.
      const above = await get1(
        `SELECT COUNT(*) AS n FROM (SELECT u.id, COALESCE(SUM(CASE WHEN l.amount>0 THEN l.amount ELSE 0 END),0) AS earned
          FROM users u LEFT JOIN ledger l ON l.user_id=u.id AND l.created_at>=?
          GROUP BY u.id HAVING earned > ? OR (earned = ? AND u.id < ?)) x`, weekAgo, myEarned, myEarned, req.userId);
      myRank = (above ? Number(above.n) : 0) + 1;
    }
    res.json({ top: top.map((r, i) => ({ rank: i + 1, username: r.username, earned: r.earned })), me: { rank: myRank, earned: myEarned } });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// Transfert de pièces entre utilisateurs (débit atomique)
app.post('/api/coins/transfer', auth, async (req, res) => {
  try {
    const n = Math.floor(+((req.body || {}).coins));
    const toRaw = (req.body || {}).to;
    if (!n || n < 1) return res.status(400).json({ error: 'montant invalide (min 1 pièce)' });
    if (n > 10000) return res.status(400).json({ error: 'montant trop élevé (max 10 000)' });
    const dest = await get1('SELECT * FROM users WHERE id=? OR username=?', +toRaw || -1, String(toRaw || ''));
    if (!dest) return res.status(404).json({ error: 'destinataire introuvable' });
    if (Number(dest.id) === Number(req.userId)) return res.status(400).json({ error: 'impossible' });
    const me = await get1('SELECT username, coins FROM users WHERE id=?', req.userId);
    const debited = await runSqlChanges('UPDATE users SET coins=coins-? WHERE id=? AND coins>=?', n, req.userId, n);
    if (!debited) return res.status(400).json({ error: 'pas assez de pièces' });
    await runSql('UPDATE users SET coins=coins+? WHERE id=?', n, dest.id);
    const t = now();
    await runSql('INSERT INTO ledger(user_id,amount,reason,created_at) VALUES(?,?,?,?)',
      req.userId, -n, 'transfert → @' + dest.username, t);
    await runSql('INSERT INTO ledger(user_id,amount,reason,created_at) VALUES(?,?,?,?)',
      dest.id, n, 'transfert ← @' + me.username, t);
    await runSql('INSERT INTO coin_transfers(from_id,to_id,coins,created_at) VALUES(?,?,?,?)',
      req.userId, dest.id, n, t);
    await notify(dest.id, 'transfer', req.userId, null, '💸 @' + me.username + ' t\'a envoyé ' + n + ' 🪙');
    const bal = await get1('SELECT coins FROM users WHERE id=?', req.userId);
    res.json({ ok: true, sent: n, to: dest.username, coins: bal ? bal.coins : 0 });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// Remercier l'expéditeur d'un cadeau reçu
app.post('/api/gifts/:id/thank', auth, async (req, res) => {
  try {
    const g = await get1('SELECT * FROM gifts WHERE id=?', req.params.id);
    if (!g) return res.status(404).json({ error: 'cadeau introuvable' });
    if (Number(g.to_id) !== Number(req.userId)) return res.status(403).json({ error: 'non autorisé' });
    if (g.thanked) return res.json({ ok: true, already: true });
    const me = await get1('SELECT username FROM users WHERE id=?', req.userId);
    await raceGap(req); // crochet test concurrence (Équipe 8/10) : simule l'intercalage Postgres
    // FIX race 2026-10-05 (Équipe 8/10) : 5 remerciements simultanés notifiaient 5 fois.
    // Seul le premier (UPDATE conditionnel) envoie la notification.
    const marked = await runSqlChanges('UPDATE gifts SET thanked=1 WHERE id=? AND (thanked=0 OR thanked IS NULL)', g.id);
    if (!marked) return res.json({ ok: true, already: true });
    await notify(g.from_id, 'gift_thanks', req.userId, g.video_id,
      '🙏 @' + me.username + ' te remercie pour ton cadeau !');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// ---------- playlists ----------
app.get('/api/playlists', auth, async (req, res) => {
  const pls = await allRows('SELECT * FROM playlists WHERE user_id=? ORDER BY created_at DESC', req.userId);
  res.json({ playlists: pls });
});
app.post('/api/playlists', auth, async (req, res) => {
  const name = String((req.body || {}).name || '').slice(0, 60);
  if (!name) return res.status(400).json({ error: 'nom requis' });
  const id = await insertId('INSERT INTO playlists(user_id,name,created_at) VALUES(?,?,?)',
    req.userId, name, now());
  res.json({ ok: true, id });
});
app.get('/api/playlists/:id', async (req, res) => {
  const pl = await get1('SELECT * FROM playlists WHERE id=?', req.params.id);
  if (!pl) return res.status(404).json({ error: 'introuvable' });
  // PAGINATION 2026-10-04 : ?page=N (50/page)
  const plpage = Math.max(1, parseInt(req.query.page, 10) || 1);
  const items = await allRows(
    'SELECT v.* FROM playlist_items pi JOIN videos v ON v.id=pi.video_id WHERE pi.playlist_id=? ORDER BY pi.pos LIMIT 50 OFFSET ' + ((plpage - 1) * 50), pl.id);
  const out = [];
  for (const v of items) { const j = await videoJSON(v, 0); if (j) out.push(j); }
  res.json({ playlist: pl, videos: out, page: plpage, has_more: items.length >= 50 });
});
app.post('/api/playlists/:id/items', auth, async (req, res) => {
  const pl = await get1('SELECT * FROM playlists WHERE id=? AND user_id=?', req.params.id, req.userId);
  if (!pl) return res.status(404).json({ error: 'introuvable' });
  const mx = await get1('SELECT MAX(pos) AS m FROM playlist_items WHERE playlist_id=?', pl.id);
  try {
    await runSql('INSERT INTO playlist_items(playlist_id,video_id,pos) VALUES(?,?,?)',
      pl.id, +(req.body || {}).video_id, Number((mx && mx.m) || 0) + 1);
  } catch (e) {}
  res.json({ ok: true });
});
// v2.35 : gestion des playlists (renommer / supprimer / retirer une vidéo / réordonner)
app.patch('/api/playlists/:id', auth, async (req, res) => {
  const pl = await get1('SELECT * FROM playlists WHERE id=? AND user_id=?', req.params.id, req.userId);
  if (!pl) return res.status(404).json({ error: 'introuvable' });
  const name = String((req.body || {}).name || '').trim().slice(0, 60);
  if (!name) return res.status(400).json({ error: 'nom requis' });
  await runSql('UPDATE playlists SET name=? WHERE id=?', name, pl.id);
  res.json({ ok: true });
});
app.delete('/api/playlists/:id', auth, async (req, res) => {
  const pl = await get1('SELECT * FROM playlists WHERE id=? AND user_id=?', req.params.id, req.userId);
  if (!pl) return res.status(404).json({ error: 'introuvable' });
  await runSql('DELETE FROM playlist_items WHERE playlist_id=?', pl.id);
  await runSql('DELETE FROM playlists WHERE id=?', pl.id);
  res.json({ ok: true });
});
app.delete('/api/playlists/:id/items/:video_id', auth, async (req, res) => {
  const pl = await get1('SELECT * FROM playlists WHERE id=? AND user_id=?', req.params.id, req.userId);
  if (!pl) return res.status(404).json({ error: 'introuvable' });
  const it = await get1('SELECT pos FROM playlist_items WHERE playlist_id=? AND video_id=?', pl.id, req.params.video_id);
  if (!it) return res.status(404).json({ error: 'vidéo absente' });
  await runSql('DELETE FROM playlist_items WHERE playlist_id=? AND video_id=?', pl.id, req.params.video_id);
  await runSql('UPDATE playlist_items SET pos=pos-1 WHERE playlist_id=? AND pos>?', pl.id, it.pos);
  res.json({ ok: true });
});
app.post('/api/playlists/:id/reorder', auth, async (req, res) => {
  const pl = await get1('SELECT * FROM playlists WHERE id=? AND user_id=?', req.params.id, req.userId);
  if (!pl) return res.status(404).json({ error: 'introuvable' });
  const order = (req.body || {}).order;
  if (!Array.isArray(order) || !order.length) return res.status(400).json({ error: 'ordre requis' });
  let pos = 1;
  for (const vid of order) {
    await runSql('UPDATE playlist_items SET pos=? WHERE playlist_id=? AND video_id=?', pos++, pl.id, Number(vid));
  }
  res.json({ ok: true });
});
// v2.35 : playlists publiques d'un utilisateur (profil créateur)
app.get('/api/users/:username/playlists', async (req, res) => {
  const u = await get1('SELECT * FROM users WHERE username=?', String(req.params.username).toLowerCase());
  if (!u) return res.status(404).json({ error: 'utilisateur introuvable' });
  const pls = await allRows('SELECT * FROM playlists WHERE user_id=? ORDER BY created_at DESC', u.id);
  const out = [];
  for (const pl of pls) {
    const c = await get1('SELECT COUNT(*) AS n FROM playlist_items WHERE playlist_id=?', pl.id);
    out.push({ id: pl.id, name: pl.name, count: Number((c && c.n) || 0), created_at: Number(pl.created_at) });
  }
  res.json({ playlists: out });
});
// ---------- hashtags / tendances ----------
function extractTags(text) {
  const m = String(text || '').match(/#([\p{L}\p{N}_]+)/gu);
  return m ? [...new Set(m.map(t => t.slice(1).toLowerCase()))] : [];
}
app.get('/api/trending/hashtags', async (req, res) => {
  const rows = await allRows('SELECT description, tags, views FROM videos ORDER BY created_at DESC LIMIT 500');
  const count = {};
  rows.forEach(r => extractTags((r.description || '') + ' ' + (r.tags || '')).forEach(t => { count[t] = (count[t] || 0) + 1; }));
  const top = Object.entries(count).sort((a, b) => b[1] - a[1]).slice(0, 20)
    .map(([tag, uses]) => ({ tag, uses }));
  res.json({ hashtags: top });
});
app.get('/api/hashtag/:tag', async (req, res) => {
  const tag = String(req.params.tag || '').toLowerCase();
  const meId = await optUserId(req);
  // PAGINATION 2026-10-04 : ?page=N (50/page sur les candidats)
  const hpage = Math.max(1, parseInt(req.query.page, 10) || 1);
  const rows = await allRows('SELECT * FROM videos WHERE hidden=0 ORDER BY created_at DESC LIMIT 500');
  const out = [];
  for (const v of rows) {
    if (!(await canSeeVideo(v, meId))) continue;
    if (extractTags((v.description || '') + ' ' + (v.tags || '')).includes(tag)) { const j = await videoJSON(v, 0); if (j) out.push(j); }
  }
  res.json({ tag, videos: out.slice((hpage - 1) * 50, hpage * 50), page: hpage, has_more: out.length > hpage * 50 });
});
// ---------- v2.48 SPEC-03 : suivi de hashtags ----------
// POST/DELETE /api/hashtags/:tag/follow — GET /api/hashtags/following — POST /api/hashtags/:tag/seen
app.post('/api/hashtags/:tag/follow', auth, async (req, res) => {
  try {
    const tag = String(req.params.tag || '').toLowerCase().replace(/^#/, '').trim().slice(0, 60);
    if (!tag) return res.status(400).json({ error: 'hashtag invalide' });
    const n = await get1('SELECT COUNT(*) AS c FROM hashtag_follows WHERE user_id=?', req.userId);
    const ex = await get1('SELECT 1 FROM hashtag_follows WHERE user_id=? AND tag=?', req.userId, tag);
    if (!ex && Number(n.c) >= HASHTAG_FOLLOW_LIMIT)
      return res.status(400).json({ error: 'limite de ' + HASHTAG_FOLLOW_LIMIT + ' hashtags suivis atteinte' });
    await insertIgnore('INSERT OR IGNORE INTO hashtag_follows(user_id,tag,last_seen_at,created_at) VALUES(?,?,?,?)',
      req.userId, tag, now(), now());
    res.json({ ok: true, tag });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.delete('/api/hashtags/:tag/follow', auth, async (req, res) => {
  try {
    const tag = String(req.params.tag || '').toLowerCase().replace(/^#/, '').trim().slice(0, 60);
    await runSql('DELETE FROM hashtag_follows WHERE user_id=? AND tag=?', req.userId, tag);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.get('/api/hashtags/following', auth, async (req, res) => {
  try {
    const rows = await allRows('SELECT tag, last_seen_at, created_at FROM hashtag_follows WHERE user_id=? ORDER BY created_at DESC', req.userId);
    res.json({ ok: true, tags: rows.map(r => ({ tag: r.tag, last_seen_at: Number(r.last_seen_at) || 0 })) });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.post('/api/hashtags/:tag/seen', auth, async (req, res) => {
  try {
    const tag = String(req.params.tag || '').toLowerCase().replace(/^#/, '').trim().slice(0, 60);
    await runSql('UPDATE hashtag_follows SET last_seen_at=? WHERE user_id=? AND tag=?', now(), req.userId, tag);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// ---------- commentaires : likes + épingler ----------
app.post('/api/comments/:id/like', auth, async (req, res) => {
  try {
    const c = await get1('SELECT * FROM comments WHERE id=?', req.params.id);
    if (!c) return res.status(404).json({ error: 'introuvable' });
    const ex = await get1('SELECT 1 FROM comment_likes WHERE comment_id=? AND user_id=?', c.id, req.userId);
    if (ex) {
      await runSql('DELETE FROM comment_likes WHERE comment_id=? AND user_id=?', c.id, req.userId);
      await runSql('UPDATE comments SET likes=likes-1 WHERE id=?', c.id);
    } else {
      await runSql('INSERT INTO comment_likes(comment_id,user_id,created_at) VALUES(?,?,?)', c.id, req.userId, now());
      await runSql('UPDATE comments SET likes=likes+1 WHERE id=?', c.id);
    }
    const upd = await get1('SELECT likes FROM comments WHERE id=?', c.id);
    res.json({ ok: true, likes: Number(upd.likes), liked: !ex });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.post('/api/comments/:id/pin', auth, async (req, res) => {
  try {
    const c = await get1('SELECT * FROM comments WHERE id=?', req.params.id);
    if (!c) return res.status(404).json({ error: 'introuvable' });
    const v = await get1('SELECT * FROM videos WHERE id=?', c.video_id);
    if (!v || Number(v.user_id) !== Number(req.userId))
      return res.status(403).json({ error: 'réservé au créateur' });
    // parité TikTok : bascule épingler/désépingler, un seul épinglé par vidéo
    if (Number(c.pinned)) {
      await runSql('UPDATE comments SET pinned=0 WHERE id=?', c.id);
      return res.json({ ok: true, pinned: false });
    }
    await runSql('UPDATE comments SET pinned=0 WHERE video_id=?', c.video_id);
    await runSql('UPDATE comments SET pinned=1 WHERE id=?', c.id);
    res.json({ ok: true, pinned: true });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// parité TikTok : supprimer un commentaire (son auteur ou le créateur de la vidéo)
app.delete('/api/comments/:id', auth, async (req, res) => {
  try {
    const c = await get1('SELECT * FROM comments WHERE id=?', req.params.id);
    if (!c) return res.status(404).json({ error: 'introuvable' });
    const v = await get1('SELECT user_id FROM videos WHERE id=?', c.video_id);
    const isAuthor = Number(c.user_id) === Number(req.userId);
    const isOwner = v && Number(v.user_id) === Number(req.userId);
    if (!isAuthor && !isOwner) return res.status(403).json({ error: 'non autorisé' });
    // supprime les réponses (et leurs likes) puis le commentaire
    // anti-orphelins : notifications et vidéos-réponses pointant vers le commentaire ou ses réponses
    await runSql('DELETE FROM notifications WHERE comment_id=? OR comment_id IN (SELECT id FROM comments WHERE reply_to=?)', c.id, c.id);
    await runSql('UPDATE videos SET reply_to_comment_id=0 WHERE reply_to_comment_id=? OR reply_to_comment_id IN (SELECT id FROM comments WHERE reply_to=?)', c.id, c.id);
    const kids = await allRows('SELECT id FROM comments WHERE reply_to=?', c.id);
    for (const k of kids) await runSql('DELETE FROM comment_likes WHERE comment_id=?', k.id);
    await runSql('DELETE FROM comments WHERE reply_to=?', c.id);
    await runSql('DELETE FROM comment_likes WHERE comment_id=?', c.id);
    await runSql('DELETE FROM comments WHERE id=?', c.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// ---------- retraits ----------
// (remplacé par la version v2 avec moyens de paiement + reçus ci-dessous)
app.get('/api/withdraw', auth, async (req, res) => {
  const rows = await allRows('SELECT * FROM withdrawals WHERE user_id=? ORDER BY created_at DESC', req.userId);
  res.json({ withdrawals: rows });
});
// ---------- stats créateur (étendues v10) ----------
app.get('/api/creator/stats', auth, async (req, res) => {
  const vids = await allRows('SELECT * FROM videos WHERE user_id=?', req.userId);
  const views = vids.reduce((a, v) => a + Number(v.views || 0), 0);
  const lr = await get1('SELECT COUNT(*) AS c FROM likes l JOIN videos v ON v.id=l.video_id WHERE v.user_id=?', req.userId);
  const fr = await get1('SELECT COUNT(*) AS c FROM follows WHERE followed_id=?', req.userId);
  const me = await get1('SELECT coins FROM users WHERE id=?', req.userId);
  const vidIds = vids.map(v => v.id);
  // séries sur 7 jours (regroupement en JS : compatible SQLite + Postgres)
  const dayStart = t => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const days = [];
  for (let i = 6; i >= 0; i--) days.push(dayStart(now() - i * 86400000));
  const bucket = rows => days.map(ds => rows.filter(r => Number(r.created_at) >= ds && Number(r.created_at) < ds + 86400000).length);
  let views7 = [], likes7 = [], followers7 = [];
  let watchTime = 0;
  if (vidIds.length) {
    const ph = vidIds.map(() => '?').join(',');
    const vv = await allRows(`SELECT created_at, video_id FROM video_views WHERE video_id IN (${ph}) AND created_at>=?`, ...vidIds, days[0]);
    views7 = bucket(vv);
    // temps de visionnage estimé : vues comptées × durée de la vidéo
    const durById = {};
    vids.forEach(v => { durById[v.id] = Number(v.duration) || 0; });
    watchTime = Math.round(vv.reduce((a, r) => a + (durById[r.video_id] || 0), 0));
    const lk = await allRows(`SELECT l.created_at FROM likes l WHERE l.video_id IN (${ph}) AND l.created_at>=?`, ...vidIds, days[0]);
    likes7 = bucket(lk);
  } else { views7 = days.map(() => 0); likes7 = days.map(() => 0); }
  const nf = await allRows('SELECT created_at FROM follows WHERE followed_id=? AND created_at>=?', req.userId, days[0]);
  followers7 = bucket(nf);
  const tipsR = await get1('SELECT COALESCE(SUM(coins),0) AS s FROM tips WHERE to_user_id=?', req.userId);
  const giftsR = await get1('SELECT COALESCE(SUM(cost),0) AS s FROM gifts WHERE to_id=?', req.userId);
  // v2.42 : gains publicitaires 50-50 (distribution quotidienne)
  const adEarn = await get1(`SELECT COALESCE(SUM(amount),0) AS s FROM ledger WHERE user_id=? AND reason LIKE '%revenu pub%'`, req.userId);
  res.json({
    videos: vids.length, views, likes: Number(lr.c), followers: Number(fr.c), coins: me.coins,
    watch_time_total: watchTime, watch_time: watchTime,
    avg_duration: views ? Math.round(watchTime / views) : 0,
    views_7d: views7, last7d: views7, likes_7d: likes7, new_followers_7d: followers7, new_followers7d: followers7,
    tips_total: Number(tipsR.s) || 0, tips: Number(tipsR.s) || 0,
    gifts_total: Number(giftsR.s) || 0, gifts: Number(giftsR.s) || 0,
    ad_earnings_total: Number(adEarn.s) || 0, // v2.42 : gains publicitaires 50-50 (distribution quotidienne)
    top: vids.sort((a, b) => b.views - a.views).slice(0, 5)
      .map(v => ({ id: v.id, desc: v.description, views: Number(v.views) })),
  });
});
// v2.47 : résoudre un payload de QR code (VIDIGAGNE:USER:pseudo) vers un utilisateur
app.get('/api/qr/resolve', auth, async (req, res) => {
  try {
    const p = String(req.query.payload || '').trim();
    const m = p.match(/^VIDIGAGNE:USER:([a-z0-9._]{1,30})$/i);
    if (!m) return res.status(400).json({ error: 'QR invalide' });
    const u = await get1('SELECT * FROM users WHERE username=?', m[1].toLowerCase());
    if (!u) return res.status(404).json({ error: 'utilisateur introuvable' });
    res.json({ ok: true, user: pubUser(u) });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// v2.44-EQB-QR : QR code SVG générique — GET /api/qr?text=...&size=256 (public, text ≤ 500 caractères)
app.get('/api/qr', async (req, res) => {
  try {
    if (!QRGEN) return res.status(503).json({ error: 'génération QR indisponible' });
    const text = String(req.query.text || '');
    if (!text) return res.status(400).json({ error: 'paramètre text requis' });
    if (text.length > 500) return res.status(400).json({ error: 'text limité à 500 caractères' });
    let size = parseInt(req.query.size, 10);
    if (!Number.isFinite(size) || size < 64) size = 256;
    if (size > 1024) size = 1024;
    const qr = QRGEN.QrCode.encodeText(text, QRGEN.QrCode.Ecc.MEDIUM);
    const svg = qr.toSvgString(4).replace('<svg ', '<svg width="' + size + '" height="' + size + '" ');
    res.set('Content-Type', 'image/svg+xml');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(svg);
  } catch (e) { res.status(400).json({ error: 'QR impossible à générer' }); }
});
// v2.44-EQB-QR : QR code SVG du profil de l'utilisateur connecté (https://vidigagne.app/@pseudo)
app.get('/api/me/qr', auth, async (req, res) => {
  try {
    if (!QRGEN) return res.status(503).json({ error: 'génération QR indisponible' });
    const u = await get1('SELECT username FROM users WHERE id=?', req.userId);
    if (!u) return res.status(404).json({ error: 'utilisateur introuvable' });
    const qr = QRGEN.QrCode.encodeText('https://vidigagne.app/@' + u.username, QRGEN.QrCode.Ecc.MEDIUM);
    const svg = qr.toSvgString(4).replace('<svg ', '<svg width="256" height="256" ');
    res.set('Content-Type', 'image/svg+xml');
    res.set('Cache-Control', 'private, max-age=3600');
    res.send(svg);
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// v2.47 : d'où viennent mes abonnés — répartition par source d'acquisition
app.get('/api/me/follower-sources', auth, async (req, res) => {
  try {
    const rows = await allRows(
      `SELECT source, COUNT(*) AS c FROM follows WHERE followed_id=? GROUP BY source ORDER BY c DESC`,
      req.userId);
    const total = rows.reduce((a, r) => a + Number(r.c || 0), 0);
    const labels = { profil: '👤 Profil', video: '🎬 Vidéo', search: '🔍 Recherche', suggestion: '💡 Suggestion', qr: '📱 QR code', live: '🔴 LIVE', other: '❓ Autre' };
    res.json({
      ok: true,
      total,
      sources: rows.map(r => ({
        source: r.source || 'other',
        label: labels[r.source] || labels.other,
        count: Number(r.c),
        pct: total ? Math.round(Number(r.c) / total * 100) : 0,
      })),
    });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// v2.34 : comparaison de périodes pour le dashboard créateur (7j vs 7 précédents par défaut)
app.get('/api/creator/stats/compare', auth, async (req, res) => {
  try {
    const dayMs = 86400000, t = now();
    let f1 = Number(req.query.from1), t1 = Number(req.query.to1);
    let f2 = Number(req.query.from2), t2 = Number(req.query.to2);
    if (![f1, t1, f2, t2].every(Number.isFinite) || t1 <= f1 || t2 <= f2) {
      // défaut : 7 derniers jours vs 7 jours précédents
      t1 = t; f1 = t - 7 * dayMs; t2 = f1; f2 = t2 - 7 * dayMs;
    }
    const periodStats = async (a, b) => {
      const vw = await get1(`SELECT COUNT(*) AS c FROM video_views vv JOIN videos v ON v.id=vv.video_id
        WHERE v.user_id=? AND vv.created_at>=? AND vv.created_at<?`, req.userId, a, b);
      const lk = await get1(`SELECT COUNT(*) AS c FROM likes l JOIN videos v ON v.id=l.video_id
        WHERE v.user_id=? AND l.created_at>=? AND l.created_at<?`, req.userId, a, b);
      const cn = await get1(`SELECT COALESCE(SUM(amount),0) AS s FROM ledger
        WHERE user_id=? AND amount>0 AND created_at>=? AND created_at<?`, req.userId, a, b);
      const fw = await get1(`SELECT COUNT(*) AS c FROM follows
        WHERE followed_id=? AND created_at>=? AND created_at<?`, req.userId, a, b);
      return { views: Number((vw && vw.c) || 0), likes: Number((lk && lk.c) || 0),
        coins: Number((cn && cn.s) || 0), followers_gained: Number((fw && fw.c) || 0) };
    };
    const p1 = await periodStats(f1, t1), p2 = await periodStats(f2, t2);
    const deltaOf = (a, b) => ({ abs: a - b, pct: b ? Math.round(((a - b) / b) * 1000) / 10 : (a > 0 ? null : 0) });
    const _vse = await get1('SELECT COALESCE(SUM(c.coins),0) AS s FROM video_sale_commissions c WHERE c.creator_id=? AND c.refunded=0 AND c.created_at>=?', req.userId, now() - 30 * 86400000).catch(() => ({ s: 0 }));
    const video_sales_earned = Number((_vse && _vse.s) || 0);
    res.json({ ok: true, video_sales_earned,
      period1: Object.assign({ from: f1, to: t1 }, p1),
      period2: Object.assign({ from: f2, to: t2 }, p2),
      delta: { views: deltaOf(p1.views, p2.views), likes: deltaOf(p1.likes, p2.likes),
        coins: deltaOf(p1.coins, p2.coins), followers_gained: deltaOf(p1.followers_gained, p2.followers_gained) } });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// ---------- live : démarrer (la liste et la fin sont en version v10 ci-dessous) ----------
app.post('/api/live/start', auth, async (req, res) => {
  const title = String((req.body || {}).title || '').slice(0, 80);
  const liveType = String((req.body || {}).live_type || 'guests') === 'solo' ? 'solo' : 'guests';
  let maxGuests = parseInt((req.body || {}).max_guests, 10);
  if (!Number.isFinite(maxGuests)) maxGuests = 8;
  maxGuests = Math.max(1, Math.min(8, maxGuests));
  const id = await insertId('INSERT INTO lives(user_id,title,started_at,viewers,live_type,max_guests) VALUES(?,?,?,?,?,?)',
    req.userId, title, now(), 0, liveType, maxGuests);
  // v2.33 : push aux abonnés (in-app + FCM) — respecte les prefs notif_lives via notify()
  (async () => {
    try {
      const me = await get1('SELECT username FROM users WHERE id=?', req.userId);
      const fols = await allRows('SELECT follower_id FROM follows WHERE followed_id=?', req.userId);
      for (const f of fols) {
        await notify(f.follower_id, 'live', req.userId, null,
          '🔴 @' + (me ? me.username : 'créateur') + ' est en direct' + (title ? ' : ' + title : '') + ' !');
      }
    } catch (_) {}
  })();
  res.json({ ok: true, id, live_type: liveType, max_guests: maxGuests });
});
// ---------- compte : export et suppression (droits RGPD) ----------
app.get('/api/account/export', auth, async (req, res) => {
  try {
    const u = await get1('SELECT id,username,name,email,phone,bio,coins,created_at FROM users WHERE id=?', req.userId);
    const videos = await allRows('SELECT id,description,tags,sound,views,created_at FROM videos WHERE user_id=?', req.userId);
    const comments = await allRows('SELECT id,video_id,text,created_at FROM comments WHERE user_id=?', req.userId);
    const stories = await allRows('SELECT id,created_at,expires_at FROM stories WHERE user_id=?', req.userId);
    const playlists = await allRows('SELECT * FROM playlists WHERE user_id=?', req.userId);
    const withdrawals = await allRows('SELECT coins,usd,method,status,created_at FROM withdrawals WHERE user_id=?', req.userId);
    const ledger = await allRows('SELECT amount,reason,created_at FROM ledger WHERE user_id=? ORDER BY created_at DESC LIMIT 500', req.userId);
    // v2.38 : complétude RGPD — follows, vidéos aimées, collections/favoris
    const following = await allRows('SELECT f.followed_id AS id, u.username, f.created_at FROM follows f JOIN users u ON u.id=f.followed_id WHERE f.follower_id=?', req.userId);
    const followers = await allRows('SELECT f.follower_id AS id, u.username, f.created_at FROM follows f JOIN users u ON u.id=f.follower_id WHERE f.followed_id=?', req.userId);
    const liked_videos = await allRows('SELECT video_id, created_at FROM likes WHERE user_id=?', req.userId);
    const collections = await allRows('SELECT id,name,is_private,created_at FROM collections WHERE user_id=?', req.userId);
    const collection_items = await allRows('SELECT collection_id,video_id,added_at FROM collection_items WHERE collection_id IN (SELECT id FROM collections WHERE user_id=?)', req.userId);
    // v2.44-EQB-RGPD : complétude — chaque table est lue sous try/catch pour ne jamais casser l'export si elle est absente
    const safeRows = async (fn) => { try { return await fn(); } catch (e) { return []; } };
    const safeRow = async (fn) => { try { return await fn() || {}; } catch (e) { return {}; } };
    const conversations = await safeRows(() => allRows(
      `SELECT c.id, c.created_at, c.updated_at,
        CASE WHEN c.user1_id=? THEN c.user2_id ELSE c.user1_id END AS other_id,
        u.username AS other_username
       FROM conversations c LEFT JOIN users u ON u.id=CASE WHEN c.user1_id=? THEN c.user2_id ELSE c.user1_id END
       WHERE c.user1_id=? OR c.user2_id=? ORDER BY c.updated_at DESC`, req.userId, req.userId, req.userId, req.userId));
    const messages = await safeRows(() => allRows(
      `SELECT m.id, m.conversation_id, m.sender_id, m.text, m.created_at FROM messages m
       JOIN conversations c ON c.id=m.conversation_id
       WHERE c.user1_id=? OR c.user2_id=? ORDER BY m.created_at DESC LIMIT 2000`, req.userId, req.userId));
    const search_history = await safeRows(() => allRows(
      'SELECT query, created_at FROM search_logs WHERE user_id=? ORDER BY created_at DESC LIMIT 1000', req.userId));
    const watch_history = await safeRows(() => allRows(
      'SELECT video_id, watched_at FROM watch_history WHERE user_id=? ORDER BY watched_at DESC LIMIT 2000', req.userId));
    const video_views = await safeRows(() => allRows(
      'SELECT video_id, created_at FROM video_views WHERE viewer_id=? ORDER BY created_at DESC LIMIT 2000', req.userId));
    const notifications = await safeRows(() => allRows(
      'SELECT id, type, actor_id, video_id, comment_id, text, title, is_read, created_at FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 500', req.userId));
    // sessions = tokens actifs (token masqué — jamais exposé en clair dans un export)
    const sessions = await safeRows(() => allRows(
      "SELECT substr(token,1,8)||'...' AS token_masked, created_at FROM tokens WHERE user_id=? ORDER BY created_at DESC", req.userId));
    // appareils : devices lie device_id ↔ user_ids (JSON) — on ne garde que ceux incluant cet utilisateur
    let devices = [];
    try {
      const drows = await allRows('SELECT device_id, first_seen, last_seen, flagged, user_ids FROM devices');
      devices = drows.filter(r => { try { return (JSON.parse(r.user_ids || '[]') || []).includes(req.userId); } catch (e) { return false; } })
        .map(r => ({ device_id: r.device_id, first_seen: r.first_seen, last_seen: r.last_seen, flagged: !!r.flagged }));
    } catch (e) {}
    const privacy_settings = await safeRow(() => get1(
      `SELECT is_private, activity_status, restricted_mode, dm_privacy, comment_privacy, mention_privacy,
        download_privacy, liked_visibility, following_visibility, duet_policy, stitch_policy, discoverable,
        notif_likes, notif_comments, notif_follows, notif_mentions, notif_lives, notif_loginalert,
        notif_priority, notif_newvideos, campaign_notifs, quiet_start, quiet_end, comment_keywords
       FROM users WHERE id=?`, req.userId));
    const content_prefs = await safeRows(() => allRows(
      'SELECT topic, pref, created_at FROM content_prefs WHERE user_id=?', req.userId));
    const appeals = await safeRows(() => allRows(
      'SELECT id, report_id, reason, status, created_at, decided_at FROM appeals WHERE user_id=? ORDER BY created_at DESC', req.userId));
    const verification_requests = await safeRows(() => allRows(
      `SELECT id, status, reason, created_at, reviewed_at, full_name, category, website, proof_links, activity,
        reviewed_by, review_reason FROM verification_requests WHERE user_id=?`, req.userId));
    const calls = await safeRows(() => allRows(
      'SELECT id, caller_id, callee_id, ctype, status, created_at, ended_at FROM calls WHERE caller_id=? OR callee_id=? ORDER BY created_at DESC LIMIT 500', req.userId, req.userId));
    // parrainage : mon parrain + mes filleuls + mon code
    const referrals = await safeRow(async () => {
      const me = await get1('SELECT ref_code, referred_by FROM users WHERE id=?', req.userId);
      const parrain = me && me.referred_by
        ? await get1('SELECT id, username FROM users WHERE id=?', me.referred_by) : null;
      const filleuls = await allRows('SELECT id, username, created_at FROM users WHERE referred_by=?', req.userId);
      return { ref_code: (me && me.ref_code) || null, parrain: parrain || null, filleuls };
    });
    // v2.49-RGPD (confidentialité #5) : catégories manquantes — KYC, pourboires, blocs,
    // signalements, brouillons, recharges, reçus, hashtags suivis, streaks, votes, achats séries, hors-ligne
    const kyc = await safeRow(() => get1(
      'SELECT id, country, doc_type, status, created_at, reviewed_at, review_reason FROM id_verifications WHERE user_id=?', req.userId));
    const tips = await safeRows(() => allRows(
      'SELECT id, video_id, from_user_id, to_user_id, coins, created_at FROM tips WHERE from_user_id=? OR to_user_id=? ORDER BY created_at DESC LIMIT 500', req.userId, req.userId));
    const blocked_users = await safeRows(() => allRows(
      'SELECT b.blocked_id AS id, u.username, b.created_at FROM blocks b LEFT JOIN users u ON u.id=b.blocked_id WHERE b.user_id=?', req.userId));
    const my_reports = await safeRows(() => allRows(
      'SELECT id, target_type, target_id, reason, status, created_at FROM reports WHERE reporter_id=? ORDER BY created_at DESC LIMIT 500', req.userId));
    const drafts = await safeRows(() => allRows(
      'SELECT id, description, created_at, updated_at FROM video_drafts WHERE user_id=? ORDER BY updated_at DESC', req.userId));
    const recharges = await safeRows(() => allRows(
      'SELECT id, method, coins, amount_usd, status, created_at FROM coin_recharges WHERE user_id=? ORDER BY created_at DESC LIMIT 500', req.userId));
    const my_receipts = await safeRows(() => allRows(
      'SELECT id, withdrawal_id, receipt_no, coins, usd, created_at FROM receipts WHERE user_id=? ORDER BY created_at DESC LIMIT 500', req.userId));
    const followed_hashtags = await safeRows(() => allRows(
      'SELECT tag, created_at FROM hashtag_follows WHERE user_id=?', req.userId));
    const login_streak = await safeRow(() => get1(
      'SELECT streak, last_day, updated_at FROM login_streaks WHERE user_id=?', req.userId));
    const friend_streaks = await safeRows(() => allRows(
      `SELECT CASE WHEN fs.user_a=? THEN fs.user_b ELSE fs.user_a END AS friend_id, u.username AS friend_username,
        fs.streak, fs.last_day FROM friendship_streaks fs LEFT JOIN users u ON u.id=CASE WHEN fs.user_a=? THEN fs.user_b ELSE fs.user_a END
       WHERE fs.user_a=? OR fs.user_b=?`, req.userId, req.userId, req.userId, req.userId));
    const my_poll_votes = await safeRows(() => allRows(
      'SELECT poll_id, option_id FROM poll_votes WHERE user_id=?', req.userId));
    const my_series_purchases = await safeRows(() => allRows(
      'SELECT sp.series_id, s.title, sp.created_at FROM series_purchases sp LEFT JOIN series s ON s.id=sp.series_id WHERE sp.user_id=?', req.userId));
    const my_offline = await safeRows(() => allRows(
      'SELECT video_id, created_at FROM offline_downloads WHERE user_id=?', req.userId));
    res.json({ user: u, videos, comments, stories, playlists, withdrawals, ledger,
      following, followers, liked_videos, collections, collection_items,
      conversations, messages, search_history, watch_history, video_views, notifications,
      sessions, devices, privacy_settings, content_prefs, appeals, verification_requests, calls, referrals,
      kyc, tips, blocked_users, my_reports, drafts, recharges, my_receipts, followed_hashtags,
      login_streak, friend_streaks, my_poll_votes, my_series_purchases, my_offline,
      exported_at: now() });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.delete('/api/account', auth, async (req, res) => {
  try {
    const uid = req.userId;
    // fichiers des vidéos et stories de l'utilisateur
    const vids = await allRows('SELECT file FROM videos WHERE user_id=?', uid);
    const sts = await allRows('SELECT file FROM stories WHERE user_id=?', uid);
    for (const r of vids.concat(sts)) {
      try {
        if (USE_CLOUDINARY) {
          const m = String(r.file).match(/\/upload\/(?:v\d+\/)?(.+?)\.[a-z0-9]+$/i);
          if (m) await cloudinary.uploader.destroy(m[1], { resource_type: 'video' });
        } else fs.unlink(path.join(UP, r.file), () => {});
      } catch (e) {}
    }
    const vIds = (await allRows('SELECT id FROM videos WHERE user_id=?', uid)).map(r => r.id);
    for (const vid of vIds) await deleteVideoCascade(vid);
    // stories (+ leurs vues), playlists, collections (+ items, partages)
    await runSql('DELETE FROM story_views WHERE story_id IN (SELECT id FROM stories WHERE user_id=?) OR viewer_id=?', uid, uid);
    await runSql('DELETE FROM stories WHERE user_id=?', uid);
    await runSql('DELETE FROM playlists WHERE user_id=?', uid);
    await runSql('DELETE FROM playlist_items WHERE playlist_id NOT IN (SELECT id FROM playlists)');
    await runSql('DELETE FROM collection_items WHERE collection_id IN (SELECT id FROM collections WHERE user_id=?)', uid);
    await runSql('DELETE FROM collection_shares WHERE collection_id IN (SELECT id FROM collections WHERE user_id=?) OR owner_id=?', uid, uid);
    await runSql('DELETE FROM collections WHERE user_id=?', uid);
    await runSql('DELETE FROM shared_collection_videos WHERE collection_id IN (SELECT id FROM shared_collections WHERE owner_id=?)', uid);
    await runSql('DELETE FROM shared_collection_members WHERE collection_id IN (SELECT id FROM shared_collections WHERE owner_id=?) OR user_id=?', uid, uid);
    await runSql('DELETE FROM shared_collections WHERE owner_id=?', uid);
    // interactions : les notifs pointant vers ses commentaires sont purgées AVANT les commentaires
    await runSql('DELETE FROM comment_likes WHERE user_id=?', uid);
    await runSql('DELETE FROM notifications WHERE comment_id IN (SELECT id FROM comments WHERE user_id=?)', uid);
    await runSql('DELETE FROM comments WHERE user_id=?', uid);
    await runSql('DELETE FROM likes WHERE user_id=?', uid);
    await runSql('DELETE FROM reposts WHERE user_id=?', uid);
    await runSql('DELETE FROM video_pins WHERE user_id=?', uid);
    await runSql('DELETE FROM hidden_videos WHERE user_id=?', uid);
    await runSql('DELETE FROM follows WHERE follower_id=? OR followed_id=?', uid, uid);
    await runSql('DELETE FROM blocks WHERE user_id=? OR blocked_id=?', uid, uid);
    await runSql('DELETE FROM reports WHERE reporter_id=?', uid);
    await runSql('DELETE FROM gifts WHERE from_id=? OR to_id=?', uid, uid);
    await runSql('DELETE FROM tips WHERE from_user_id=? OR to_user_id=?', uid, uid);
    await runSql('DELETE FROM ledger WHERE user_id=?', uid);
    await runSql('DELETE FROM withdrawals WHERE user_id=?', uid);
    await runSql('DELETE FROM receipts WHERE user_id=?', uid);
    await runSql('DELETE FROM coin_recharges WHERE user_id=?', uid);
    await runSql('DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE buyer_id=?)', uid);
    await runSql('DELETE FROM orders WHERE buyer_id=?', uid);
    await runSql('DELETE FROM cart WHERE user_id=? OR product_id IN (SELECT id FROM products WHERE seller_id=?)', uid, uid);
    await runSql('DELETE FROM video_products WHERE product_id IN (SELECT id FROM products WHERE seller_id=?)', uid);
    await runSql('DELETE FROM products WHERE seller_id=?', uid);
    // m9 : nettoyage complet, pas de lignes orphelines
    await runSql('DELETE FROM video_views WHERE viewer_id=?', uid);
    await runSql('DELETE FROM watch_events WHERE user_id=?', uid);
    await runSql('DELETE FROM watch_history WHERE user_id=?', uid);
    await runSql('DELETE FROM watch_rewards WHERE user_id=?', uid);
    await runSql('DELETE FROM like_rewards WHERE liker_id=?', uid);
    await runSql('DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE user1_id=? OR user2_id=?)', uid, uid);
    await runSql('DELETE FROM conversation_reads WHERE user_id=? OR conversation_id IN (SELECT id FROM conversations WHERE user1_id=? OR user2_id=?)', uid, uid, uid);
    await runSql('DELETE FROM conversation_mutes WHERE user_id=? OR conversation_id IN (SELECT id FROM conversations WHERE user1_id=? OR user2_id=?)', uid, uid, uid);
    await runSql('DELETE FROM conversations WHERE user1_id=? OR user2_id=?', uid, uid);
    await runSql('DELETE FROM message_requests WHERE from_user_id=? OR to_user_id=?', uid, uid);
    await runSql('DELETE FROM group_messages WHERE sender_id=?', uid);
    await runSql('DELETE FROM group_members WHERE user_id=?', uid);
    await runSql('DELETE FROM notifications WHERE user_id=? OR actor_id=?', uid, uid);
    await runSql('DELETE FROM series_items WHERE series_id IN (SELECT id FROM series WHERE creator_id=?)', uid);
    await runSql('DELETE FROM series_purchases WHERE user_id=? OR series_id IN (SELECT id FROM series WHERE creator_id=?)', uid, uid);
    await runSql('DELETE FROM series WHERE creator_id=?', uid);
    await runSql('DELETE FROM id_verifications WHERE user_id=?', uid);
    await runSql('DELETE FROM verification_requests WHERE user_id=?', uid);
    await runSql('DELETE FROM payment_methods WHERE user_id=?', uid);
    await runSql('DELETE FROM family_links WHERE parent_id=? OR teen_id=?', uid, uid);
    await runSql('DELETE FROM family_settings WHERE teen_id=?', uid);
    await runSql('DELETE FROM family_codes WHERE parent_id=?', uid);
    await runSql('DELETE FROM challenge_claims WHERE user_id=?', uid);
    await runSql('DELETE FROM creator_subs WHERE subscriber_id=? OR creator_id=?', uid, uid);
    await runSql('DELETE FROM effect_favs WHERE user_id=?', uid);
    await runSql('DELETE FROM sound_favs WHERE user_id=?', uid);
    await runSql('DELETE FROM qa_questions WHERE user_id=? OR asker_id=?', uid, uid);
    await runSql('DELETE FROM video_drafts WHERE user_id=?', uid);
    await runSql('DELETE FROM content_prefs WHERE user_id=?', uid);
    await runSql('DELETE FROM search_logs WHERE user_id=?', uid);
    await runSql('DELETE FROM activities WHERE user_id=?', uid);
    // FIX sécu 2026-10-05 (confidentialité #3 HAUTE) : bot_messages est créée paresseusement
    // (au premier /api/bot/chat) — sans try/catch, un utilisateur n'ayant jamais parlé à Vigi
    // faisait échouer TOUTE la suppression (500, compte conservé). Droit à l'effacement cassé.
    try { await runSql('DELETE FROM bot_messages WHERE user_id=?', uid); } catch (e) {}
    // FIX sécu 2026-10-05 (confidentialité #4 HAUTE) : 13 tables oubliées par la suppression
    await runSql('DELETE FROM hashtag_follows WHERE user_id=?', uid);
    await runSql('DELETE FROM login_streaks WHERE user_id=?', uid);
    await runSql('DELETE FROM friendship_streaks WHERE user_a=? OR user_b=?', uid, uid);
    await runSql('DELETE FROM video_translations WHERE video_id IN (SELECT id FROM videos WHERE user_id=?)', uid);
    await runSql('DELETE FROM translation_quota WHERE user_id=?', uid);
    await runSql('DELETE FROM offline_downloads WHERE user_id=?', uid);
    await runSql('DELETE FROM retention_nudges WHERE user_id=?', uid);
    await runSql('DELETE FROM premiere_reminders WHERE user_id=?', uid);
    await runSql('DELETE FROM video_view_sources WHERE user_id=?', uid);
    await runSql('DELETE FROM profile_views WHERE viewer_id=? OR viewed_id=?', uid, uid);
    await runSql('DELETE FROM live_chat WHERE user_id=?', uid);
    await runSql('DELETE FROM premiere_chat WHERE user_id=?', uid);
    // devices : user_ids est un JSON — retire l'utilisateur, supprime les lignes devenues vides
    try {
      const _drows = await allRows('SELECT device_id, user_ids FROM devices');
      for (const _dr of _drows) {
        let _ids = []; try { _ids = JSON.parse(_dr.user_ids || '[]') || []; } catch (e) {}
        const _keep = _ids.filter(x => Number(x) !== Number(uid));
        if (!_keep.length) await runSql('DELETE FROM devices WHERE device_id=?', _dr.device_id);
        else if (_keep.length !== _ids.length) await runSql('UPDATE devices SET user_ids=? WHERE device_id=?', JSON.stringify(_keep), _dr.device_id);
      }
    } catch (e) {}
    await runSql('DELETE FROM call_signals WHERE call_id IN (SELECT id FROM calls WHERE caller_id=? OR callee_id=?) OR to_user_id=? OR from_user_id=?', uid, uid, uid, uid);
    await runSql('DELETE FROM calls WHERE caller_id=? OR callee_id=?', uid, uid);
    await runSql('DELETE FROM live_signals WHERE to_user_id=? OR from_user_id=?', uid, uid);
    await runSql('UPDATE lives SET ended_at=? WHERE user_id=? AND ended_at IS NULL', now(), uid);
    await runSql('DELETE FROM tokens WHERE user_id=?', uid);
    await runSql('DELETE FROM oauth_sessions WHERE user_id=?', uid);
    // codes de vérification / resets liés à l'e-mail ou au téléphone du compte
    const idents = await get1('SELECT email, phone FROM users WHERE id=?', uid);
    if (idents) {
      const idv = [idents.email, idents.phone].filter(Boolean);
      if (idv.length) {
        const iph = idv.map(() => '?').join(',');
        await runSql(`DELETE FROM verification_codes WHERE identifier IN (${iph})`, ...idv);
        await runSql(`DELETE FROM password_resets WHERE email IN (${iph})`, ...idv);
      }
    }
    // sondages : décrémente les compteurs avant de supprimer les votes (cohérence poll_options.votes)
    const myVotes = await allRows('SELECT option_id FROM poll_votes WHERE user_id=?', uid);
    for (const vt of myVotes) await runSql('UPDATE poll_options SET votes=votes-1 WHERE id=?', vt.option_id);
    await runSql('DELETE FROM poll_votes WHERE user_id=?', uid);
    await runSql('DELETE FROM users WHERE id=?', uid);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// ---------- KYC : vérification d'identité ----------
// Règles de documents acceptés :
// - Afrique : PASSEPORT UNIQUEMENT
// - Haïti, grands pays riches et reste du monde : passeport OU carte
//   d'identité, toujours EN COURS DE VALIDITÉ (date d'expiration future).
const KYC_AFRICA = new Set(['DZ','ZA','AO','BJ','BW','BF','BI','CM','CV','CF','TD','KM','CG','CD','CI','DJ','EG','GQ','ER','SZ','ET','GA','GM','GH','GN','GW','KE','LS','LR','LY','MG','MW','ML','MR','MU','MA','MZ','NA','NE','NG','RW','ST','SN','SC','SL','SO','SS','SD','TZ','TG','TN','UG','ZM','ZW']);
function kycAllowedDocs(country) {
  if (KYC_AFRICA.has(country)) return ['passport'];
  return ['passport', 'id_card'];
}
const KYC_DOCS = ['passport', 'id_card'];
app.post('/api/kyc/submit', auth, uploadImg.fields([{ name: 'doc_front', maxCount: 1 }, { name: 'doc_back', maxCount: 1 }]), async (req, res) => {
  try {
    const country = String((req.body || {}).country || '').toUpperCase().slice(0, 2);
    const docType = String((req.body || {}).doc_type || '');
    const expiry = String((req.body || {}).expiry || '').slice(0, 7); // AAAA-MM
    if (!/^[A-Z]{2}$/.test(country)) return res.status(400).json({ error: 'pays invalide' });
    if (!kycAllowedDocs(country).includes(docType))
      return res.status(400).json({ error: 'document non accepté pour ce pays' });
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(expiry)) return res.status(400).json({ error: 'date d’expiration invalide' });
    const expDate = new Date(expiry + '-01T00:00:00Z');
    expDate.setMonth(expDate.getMonth() + 1); // fin du mois
    if (expDate <= new Date()) return res.status(400).json({ error: 'document expiré — en cours de validité exigé' });
    if (!req.files || !req.files.doc_front) return res.status(400).json({ error: 'photo du document requise' });
    const front = await storeImage(req.files.doc_front[0], 'vidigagne/kyc');
    const back = req.files.doc_back ? await storeImage(req.files.doc_back[0], 'vidigagne/kyc') : null;
    const ex = await get1('SELECT * FROM id_verifications WHERE user_id=?', req.userId);
    if (ex) {
      // m5 : détruire les anciens documents avant de les remplacer (ne pas les laisser sur Cloudinary)
      for (const oldUrl of [ex.doc_front, ex.doc_back]) {
        try {
          if (USE_CLOUDINARY && oldUrl) {
            const m = String(oldUrl).match(/\/upload\/(?:v\d+\/)?(.+?)\.[a-z0-9]+$/i);
            if (m) await cloudinary.uploader.destroy(m[1], { resource_type: 'image' });
          }
        } catch (e) {}
      }
      await runSql(`UPDATE id_verifications SET country=?, doc_type=?, doc_front=?, doc_back=?, expiry=?, status='pending', reviewed_at=NULL, created_at=? WHERE user_id=?`,
        country, docType, front, back, expiry, now(), req.userId);
    } else {
      await runSql(`INSERT INTO id_verifications(user_id,country,doc_type,doc_front,doc_back,expiry,status,created_at) VALUES(?,?,?,?,?,?,'pending',?)`,
        req.userId, country, docType, front, back, expiry, now());
    }
    res.json({ ok: true, status: 'pending' });
    runVerificationBot().catch(()=>{}); // le bot examine immédiatement
  } catch (e) { res.status(500).json({ error: 'échec de l’envoi' }); }
});
app.get('/api/kyc/status', auth, async (req, res) => {
  const r = await get1('SELECT status, country, doc_type, created_at FROM id_verifications WHERE user_id=?', req.userId);
  res.json(r ? { status: r.status, country: r.country, doc_type: r.doc_type } : { status: 'none' });
});
// règles de documents par pays (pour adapter le formulaire dans l'app)
app.get('/api/kyc/rules', async (req, res) => {
  const country = String(req.query.country || '').toUpperCase().slice(0, 2);
  const docs = kycAllowedDocs(country);
  res.json({ country, docs, note: KYC_AFRICA.has(country)
    ? 'Afrique : passeport uniquement, en cours de validité.'
    : 'Passeport ou carte d’identité, en cours de validité.' });
});
function adminAuth(req, res, next) {
  // token admin UNIQUEMENT via l'en-tête (jamais en query string : finit dans les logs)
  const t = req.headers['x-admin-token'];
  if (!process.env.ADMIN_TOKEN || t !== process.env.ADMIN_TOKEN) return res.status(403).json({ error: 'non autorisé' });
  next();
}
app.get('/api/kyc/pending', adminAuth, async (req, res) => {
  const rows = await allRows(
    `SELECT k.*, u.username, u.name FROM id_verifications k JOIN users u ON u.id=k.user_id
     WHERE k.status='pending' ORDER BY k.created_at ASC`);
  res.json({ pending: rows.map(r => ({ ...r, doc_front: fileUrl(r.doc_front), doc_back: r.doc_back ? fileUrl(r.doc_back) : null })) });
});
app.post('/api/kyc/:id/review', adminAuth, async (req, res) => {
  const approve = !!(req.body || {}).approve;
  const krow = await get1('SELECT user_id FROM id_verifications WHERE id=?', req.params.id);
  // B6 (2026-10-05) : 404 si la demande KYC n'existe pas
  if (!krow) return res.status(404).json({ error: 'demande KYC introuvable' });
  await runSql(`UPDATE id_verifications SET status=?, reviewed_at=? WHERE id=?`,
    approve ? 'approved' : 'rejected', now(), req.params.id);
  // v2.33 : notifie (in-app + push FCM) + e-mail de verdict
  if (krow) {
    const kmsg = approve
      ? '🪪✔️ Ton identité est vérifiée — tu peux retirer tes gains !'
      : '🪪 Ta vérification d\'identité a été rejetée. Vérifie ton document et renvoie une demande.';
    await notify(krow.user_id, 'kyc', null, null, kmsg);
    const ku = await get1('SELECT email, username FROM users WHERE id=?', krow.user_id);
    if (ku && ku.email) sendVidiEmail(ku.email,
      approve ? '🪪 Identité vérifiée — VidiGagne' : '🪪 Vérification d\'identité — action requise',
      '<p style="font-size:18px">' + (approve ? '🪪✔️ Identité vérifiée !' : '🪪 Vérification rejetée') + '</p>'
      + '<p style="color:#ccc;font-size:14px">' + (approve
        ? 'Félicitations @' + String(ku.username).replace(/</g, '&lt;') + ' ! Ton identité est confirmée : tu peux désormais retirer tes gains.'
        : 'Ta demande de vérification d\'identité n\'a pas pu être validée. Assure-toi que ton document est en cours de validité et bien lisible, puis renvoie une demande depuis l\'application.') + '</p>',
      kmsg).catch(() => {});
  }
  await logAudit(null, approve ? 'kyc_approve' : 'kyc_reject', 'kyc', req.params.id, req); // v2.43
  res.json({ ok: true, status: approve ? 'approved' : 'rejected' });
});
// ---------- page admin : revue des identités ----------
// v1.54 : le token admin n'est PLUS accepté en query string (finit dans les logs/historiques).
// La page affiche un champ de saisie : le token transite uniquement en en-tête HTTPS.
app.get('/admin/kyc', (req, res) => {
  res.type('html').send(`<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>VidiGagne — Vérifications d'identité</title>
<style>body{font-family:sans-serif;max-width:900px;margin:0 auto;padding:20px;background:#f5f5f5}h1{font-size:22px}.card{background:#fff;border-radius:12px;padding:16px;margin-bottom:16px;box-shadow:0 1px 4px rgba(0,0,0,.1)}.card img{max-width:100%;max-height:300px;border-radius:8px;margin:6px 0}.row{display:flex;gap:10px;margin-top:10px}button{flex:1;padding:12px;border:none;border-radius:8px;font-weight:700;cursor:pointer;font-size:15px}.ok{background:#16a34a;color:#fff}.ko{background:#dc2626;color:#fff}.meta{color:#666;font-size:14px}#gate{max-width:420px;margin:80px auto;text-align:center;background:#fff;padding:32px;border-radius:16px;box-shadow:0 2px 12px rgba(0,0,0,.12)}#gate input{width:100%;padding:12px;border:1px solid #ddd;border-radius:8px;font-size:15px;box-sizing:border-box;margin:12px 0}#gate button{background:#111;color:#fff}</style></head><body>
<div id="gate"><h1>🔐 Accès admin</h1><p style="color:#666">Colle ton token admin pour voir les vérifications d'identité.</p><input id="tk" type="password" placeholder="Token admin" autocomplete="off"><button onclick="go()">Accéder</button><p id="err" style="color:#c00"></p></div>
<div id="main" style="display:none"><h1>🔍 Vérifications d'identité en attente</h1><div id="list"><p>Chargement…</p></div></div>
<script>let T='';
const esc=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function go(){T=document.getElementById('tk').value.trim();const r=await fetch('/api/kyc/pending',{headers:{'x-admin-token':T}});if(!r.ok){document.getElementById('err').textContent='Token invalide';return}document.getElementById('gate').style.display='none';document.getElementById('main').style.display='';load()}
async function load(){const r=await fetch('/api/kyc/pending',{headers:{'x-admin-token':T}});const d=await r.json();
const box=document.getElementById('list');
if(!d.pending.length){box.innerHTML='<p>Aucune demande en attente ✅</p>';return}
box.innerHTML=d.pending.map(p=>'<div class="card" id="k'+p.id+'"><div><b>@'+esc(p.username)+'</b> <span class="meta">'+esc(p.name)+' • '+esc(p.country)+' • '+esc(p.doc_type)+' • expire : '+esc(p.expiry||'?')+'</span></div>'
+'<div><img src="'+esc(p.doc_front)+'"></div>'+(p.doc_back?'<div><img src="'+esc(p.doc_back)+'"></div>':'')
+'<div class="row"><button class="ok" onclick="rev('+p.id+',true)">✅ Approuver</button><button class="ko" onclick="rev('+p.id+',false)">❌ Rejeter</button></div></div>').join('')}
async function rev(id,ok){await fetch('/api/kyc/'+id+'/review',{method:'POST',headers:{'Content-Type':'application/json','x-admin-token':T},body:JSON.stringify({approve:ok})});
document.getElementById('k'+id).remove();const box=document.getElementById('list');if(!box.children.length)box.innerHTML='<p>Aucune demande en attente ✅</p>'}
load();</script></body></html>`);
});
// ---------- MOYENS DE PAIEMENT ----------
// PayPal : monde entier (avec autorisation OAuth PayPal quand configuré).
// MonCash / NatCash : Haïti (numéro confirmé par l'utilisateur).
const PAY_METHODS = ['paypal', 'moncash', 'natcash'];
app.get('/api/payment-methods', auth, async (req, res) => {
  const rows = await allRows('SELECT id,type,label,account,verified,created_at FROM payment_methods WHERE user_id=? ORDER BY created_at DESC', req.userId);
  res.json({ methods: rows });
});
app.post('/api/payment-methods', auth, async (req, res) => {
  try {
    const type = String((req.body || {}).type || '');
    const account = String((req.body || {}).account || '').trim();
    if (!PAY_METHODS.includes(type)) return res.status(400).json({ error: 'moyen invalide' });
    if (type === 'paypal') {
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(account)) return res.status(400).json({ error: 'e-mail PayPal invalide' });
    } else {
      if (!/^\+?[0-9]{8,15}$/.test(account.replace(/[\s-]/g, ''))) return res.status(400).json({ error: 'numéro invalide' });
    }
    const label = type === 'paypal' ? 'PayPal — Monde' : (type === 'moncash' ? 'MonCash — Haïti' : 'NatCash — Haïti');
    const id = await insertId('INSERT INTO payment_methods(user_id,type,label,account,verified,created_at) VALUES(?,?,?,?,?,?)',
      req.userId, type, label, account, 0, now()).catch(() => null);
    // l'utilisateur autorise explicitement ce moyen pour ses retraits
    res.json({ ok: true, id });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.delete('/api/payment-methods/:id', auth, async (req, res) => {
  await runSql('DELETE FROM payment_methods WHERE id=? AND user_id=?', req.params.id, req.userId);
  res.json({ ok: true });
});
// ---------- PayPal : autorisation OAuth (Log in with PayPal) ----------
function paypalCfg() {
  if (!process.env.PAYPAL_CLIENT_ID || !process.env.PAYPAL_CLIENT_SECRET) return null;
  const live = (process.env.PAYPAL_MODE || 'live') === 'live';
  return {
    id: process.env.PAYPAL_CLIENT_ID, secret: process.env.PAYPAL_CLIENT_SECRET,
    api: live ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com',
    www: live ? 'https://www.paypal.com' : 'https://www.sandbox.paypal.com',
    redirect: (process.env.PAYPAL_REDIRECT || 'https://vidigagne-server.onrender.com/api/paypal/connect/callback'),
  };
}
// v1.54 : state OAuth signé (HMAC) — empêche de forger un state pour lier un PayPal au compte d'un autre
const _stateSecret = crypto.randomBytes(32);
function signState(uid) {
  const payload = Buffer.from(JSON.stringify({ uid, t: now() })).toString('base64url');
  const sig = crypto.createHmac('sha256', _stateSecret).update(payload).digest('base64url');
  return payload + '.' + sig;
}
function verifyState(s) {
  try {
    const [payload, sig] = String(s || '').split('.');
    if (!payload || !sig) return null;
    const expect = crypto.createHmac('sha256', _stateSecret).update(payload).digest('base64url');
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
    const d = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (!d.uid || now() - d.t > 15 * 60 * 1000) return null; // 15 min max
    return d.uid;
  } catch (e) { return null; }
}
// v1.54 : code à usage unique pour le flow PayPal (le vrai token d'auth ne transite PLUS en URL)
const _ppCodes = new Map(); // code -> {uid, exp}
app.post('/api/paypal/connect/prepare', auth, async (req, res) => {
  const code = crypto.randomBytes(16).toString('hex');
  _ppCodes.set(code, { uid: req.userId, exp: now() + 5 * 60 * 1000 });
  if (_ppCodes.size > 1000) for (const [k, v] of _ppCodes) if (v.exp < now()) _ppCodes.delete(k);
  res.json({ code });
});
app.get('/api/paypal/connect/start', async (req, res) => {
  const cfg = paypalCfg();
  if (!cfg) return res.status(400).json({ error: 'PayPal non configuré' });
  // code à usage unique (nouveau flow) ou token legacy (compatibilité)
  let uid = null;
  const code = String(req.query.code || '');
  if (code) {
    const c = _ppCodes.get(code);
    if (c && c.exp > now()) { uid = c.uid; }
    _ppCodes.delete(code);
  } else {
    const token = String(req.query.token || '');
    const row = token ? await get1('SELECT user_id FROM tokens WHERE token=?', token) : null;
    if (row) uid = row.user_id;
  }
  if (!uid) return res.status(401).json({ error: 'connecte-toi d’abord dans l’application' });
  const state = signState(uid);
  const url = cfg.www + '/signin/authorize?client_id=' + encodeURIComponent(cfg.id) +
    '&response_type=code&scope=' + encodeURIComponent('openid email') +
    '&redirect_uri=' + encodeURIComponent(cfg.redirect) + '&state=' + encodeURIComponent(state);
  res.redirect(url);
});
app.get('/api/paypal/connect/callback', async (req, res) => {
  try {
    const cfg = paypalCfg();
    if (!cfg) return res.status(400).type('html').send('<h1>PayPal non configuré</h1>');
    const uid = verifyState(req.query.state);
    if (!uid || !req.query.code) return res.status(400).type('html').send('<h1>Autorisation refusée</h1>');
    const basic = Buffer.from(cfg.id + ':' + cfg.secret).toString('base64');
    const tr = await fetch(cfg.api + '/v1/oauth2/token', {
      method: 'POST', headers: { 'Authorization': 'Basic ' + basic, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=authorization_code&code=' + encodeURIComponent(req.query.code) + '&redirect_uri=' + encodeURIComponent(cfg.redirect),
    });
    const tj = await tr.json();
    if (!tj.access_token) return res.status(400).type('html').send('<h1>Échec de l’autorisation PayPal</h1>');
    const ur = await fetch(cfg.api + '/v1/identity/oauth2/userinfo?schema=paypalv1.1', {
      headers: { 'Authorization': 'Bearer ' + tj.access_token },
    });
    const u = await ur.json();
    const email = u.email || '';
    const payerId = u.payer_id || null;
    if (!email) return res.status(400).type('html').send('<h1>E-mail PayPal introuvable</h1>');
    const ex = await get1('SELECT id FROM payment_methods WHERE user_id=? AND type=? AND account=?', uid, 'paypal', email);
    if (ex) await runSql('UPDATE payment_methods SET verified=1, paypal_payer_id=? WHERE id=?', payerId, ex.id);
    else await runSql('INSERT INTO payment_methods(user_id,type,label,account,verified,paypal_payer_id,created_at) VALUES(?,?,?,?,?,?,?)',
      uid, 'paypal', 'PayPal — Monde', email, 1, payerId, now());
    res.type('html').send('<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="font-family:sans-serif;text-align:center;padding:40px"><h1>✅ PayPal connecté</h1><p>Ton compte PayPal <b>' + String(email).replace(/</g, '&lt;') + '</b> est autorisé pour tes retraits VidiGagne.</p><p>Tu peux fermer cette page et revenir dans l’application.</p></body></html>');
  } catch (e) { res.status(500).type('html').send('<h1>Erreur PayPal</h1>'); }
});
// ---------- E-MAILS : envoi des reçus ----------
let _mailer = null;
function mailer() {
  if (_mailer) return _mailer;
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER) return null;
  try {
    const nodemailer = require('nodemailer');
    _mailer = nodemailer.createTransport({
      host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587),
      secure: Number(process.env.SMTP_PORT) === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 20000,
    });
    return _mailer;
  } catch (e) { return null; }
}
function receiptHtml(r, user) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:20px">
<div style="text-align:center;margin-bottom:20px"><div style="font-size:28px;font-weight:800">VidiGagne</div><div style="color:#666">Reçu de retrait</div></div>
<div style="border:1px solid #ddd;border-radius:12px;padding:20px">
<div style="font-size:13px;color:#888">N° DE REÇU</div><div style="font-weight:800;font-size:18px;margin-bottom:12px">${r.receipt_no}</div>
<table style="width:100%;font-size:14px" cellpadding="6">
<tr><td style="color:#666">Date</td><td style="text-align:right">${new Date(r.created_at).toLocaleString('fr')}</td></tr>
<tr><td style="color:#666">Bénéficiaire</td><td style="text-align:right">@${user.username}</td></tr>
<tr><td style="color:#666">Moyen</td><td style="text-align:right">${r.method}</td></tr>
<tr><td style="color:#666">Compte</td><td style="text-align:right">${String(r.account).replace(/</g, '&lt;')}</td></tr>
<tr><td style="color:#666">Montant</td><td style="text-align:right;font-weight:800">${r.coins} 🪙 (≈ $${r.usd})</td></tr>
<tr><td style="color:#666">Statut</td><td style="text-align:right">${r.status === 'pending' ? '⏳ En attente de traitement' : r.status}</td></tr>
</table></div>
<p style="font-size:12px;color:#888;text-align:center">Une copie de ce reçu est conservée dans ton application VidiGagne (Gains → Reçus).</p>
</body></html>`;
}
async function sendReceiptEmail(user, r) {
  // v2.33 : journalise la tentative (bot de test) ; en mode test l'envoi réel est stubbé
  if (user && user.email) {
    _emailAttempts.push({ to: String(user.email), subject: '🧾 Reçu de retrait VidiGagne — ' + r.receipt_no, at: Date.now() });
    if (_emailAttempts.length > 500) _emailAttempts.shift();
  }
  if (VG_TEST_HOOKS) return 'stubbed';
  const m = mailer();
  if (!m || !user.email) return 'skipped';
  try {
    await m.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: user.email,
      subject: '🧾 Reçu de retrait VidiGagne — ' + r.receipt_no,
      html: receiptHtml(r, user),
    });
    return 'sent';
  } catch (e) { return 'failed'; }
}
// ---------- v2.33 : e-mails transactionnels (Brevo HTTP priorité, SMTP fallback) ----------
// Journal en mémoire des tentatives (e-mails + pushes) — consultable via /api/diag/email-push-log.
// Quand VG_TEST_HOOKS=1 : les envois RÉELS sont stubbés (aucun e-mail ni push ne part) — le bot
// de test vérifie que l'appel a bien été tenté, pas l'envoi réel.
const _emailAttempts = [];
const _pushAttempts = [];
const VG_TEST_HOOKS = process.env.VG_TEST_HOOKS === '1';
function emailTemplate(inner) {
  return '<div style="font-family:sans-serif;max-width:480px;margin:0 auto;background:#0a0a0a;border-radius:16px;overflow:hidden">'
    + '<div style="background:linear-gradient(135deg,#b8860b,#ffd700);padding:30px;text-align:center">'
    + '<div style="font-size:32px;font-weight:900;color:#000;letter-spacing:1px">VidiGagne</div>'
    + '<div style="color:#000;font-size:14px;margin-top:6px">Regarde des vidéos. Gagne de l\'argent.</div></div>'
    + '<div style="padding:30px;text-align:center;color:#fff">' + inner + '</div>'
    + '<div style="padding:20px;text-align:center;color:#666;font-size:11px;border-top:1px solid #222">© 2026 VidiGagne — Fait avec ❤️</div></div>';
}
function bigCodeHtml(code) {
  return '<div style="font-size:48px;font-weight:900;letter-spacing:12px;color:#ffd700;margin:20px 0">' + code + '</div>';
}
async function sendVidiEmail(to, subject, innerHtml, textBody) {
  if (!to) return 'skipped';
  _emailAttempts.push({ to: String(to), subject: String(subject), at: Date.now() });
  if (_emailAttempts.length > 500) _emailAttempts.shift();
  if (VG_TEST_HOOKS) return 'stubbed';
  const html = emailTemplate(innerHtml);
  // Priorité : Brevo API (HTTP, jamais bloqué) puis SMTP
  if (process.env.BREVO_API_KEY) {
    try {
      const br = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'api-key': process.env.BREVO_API_KEY, 'Content-Type': 'application/json', 'accept': 'application/json' },
        body: JSON.stringify({
          sender: { name: process.env.BREVO_FROM_NAME || 'VidiGagne', email: process.env.BREVO_FROM_EMAIL || process.env.SMTP_USER },
          to: [{ email: String(to) }],
          subject: String(subject),
          htmlContent: html,
        }),
      });
      if (br.ok) return 'sent';
    } catch (e) {}
  }
  const m = mailer();
  if (m) {
    try {
      await m.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: String(to), subject: String(subject), text: textBody || '', html,
      });
      return 'sent';
    } catch (e) {}
  }
  return 'failed';
}
// v2.33 : e-mail récapitulatif quand un cadeau IMPORTANT est reçu (seuil anti-spam e-mail)
const GIFT_EMAIL_MIN_COINS = 100;
async function maybeGiftEmail(destUserId, actorName, g) {
  try {
    if (Number(g.cost) < GIFT_EMAIL_MIN_COINS) return;
    const d = await get1('SELECT email FROM users WHERE id=?', destUserId);
    if (!d || !d.email) return;
    const an = String(actorName || 'un fan').replace(/</g, '&lt;');
    await sendVidiEmail(d.email,
      '🎁 Gros cadeau reçu sur VidiGagne !',
      '<p style="font-size:18px">🎁 ' + an + ' t\'a offert <b>' + String(g.emoji || '') + ' ' + String(g.name || '').replace(/</g, '&lt;') + '</b> !</p>'
      + '<p style="color:#ffd700;font-size:22px;font-weight:800">+' + g.cost + ' 🪙</p>'
      + '<p style="color:#ccc;font-size:14px">Tes fans te soutiennent — continue à briller ! ✨</p>',
      an + ' t\'a offert ' + g.name + ' (+' + g.cost + ' pièces) sur VidiGagne !');
  } catch (_) {}
}
// ---------- retraits v2 : moyen enregistré + reçu ----------
// ==================== v2.52 : RETRAITS EN ATTENTE (pas de revenus pub = pas d'argent) ====================
// Tant que les publicités ne tournent pas, il n'y a pas d'argent derrière les retraits.
// withdrawals_paused=1 (défaut) → les demandes sont refusées avec un message honnête,
// les pièces restent sur le compte et continuent de s'accumuler. L'admin réactive via
// POST /api/admin/app/withdrawals quand les revenus pub démarrent.
async function withdrawalsPaused() {
  const v = await appConfigGet('withdrawals_paused');
  return v !== '0'; // défaut : en pause (aucune valeur = pas encore de revenus)
}
const WITHDRAW_PAUSED_MSG = 'Retraits en attente : ils ouvriront quand les revenus publicitaires démarreront. Tes pièces sont en sécurité et continuent de s\u2019accumuler.';
app.post('/api/admin/app/withdrawals', adminAuth, async (req, res) => {
  try {
    const paused = (req.body || {}).paused === false || (req.body || {}).paused === '0' ? '0' : '1';
    await runSql(`INSERT INTO app_config(key,value,updated_at) VALUES('withdrawals_paused',?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
      paused, now());
    res.json({ ok: true, withdrawals_paused: paused === '1' });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.post('/api/withdraw', auth, async (req, res) => {
  try {
    if (await withdrawalsPaused())
      return res.status(403).json({ error: WITHDRAW_PAUSED_MSG, withdrawals_paused: true });
    const { coins, method, account, method_id } = req.body || {};
    const n = Math.floor(+coins);
    if (!n || n < 1000) return res.status(400).json({ error: 'minimum 1000 pièces (2 $)' });
    let pm = null;
    if (method_id) {
      pm = await get1('SELECT * FROM payment_methods WHERE id=? AND user_id=?', method_id, req.userId);
      if (!pm) return res.status(400).json({ error: 'moyen de paiement introuvable' });
    } else {
      if (!['moncash', 'natcash', 'paypal'].includes(method)) return res.status(400).json({ error: 'méthode invalide' });
      if (!String(account || '').trim()) return res.status(400).json({ error: 'compte requis' });
      pm = { type: method, label: method, account: String(account).trim() };
    }
    const me = await get1('SELECT * FROM users WHERE id=?', req.userId);
    if (!me) return res.status(400).json({ error: 'compte introuvable' });
    // 🤖 le bot rejette à l'immédiat les pièces expirées (3 mois ou plus)
    // FIX race 2026-10-05 (Équipe 8/10) : TOCTOU pièces valides — le contrôle
    // validCoins + le débit sont sérialisés par utilisateur. Avant : 2 retraits
    // simultanés passaient chacun le contrôle (ex. 2000 valides) puis débitaient
    // sur le total → retraits cumulés > pièces valides.
    const wdOut = await withUserLock(req.userId, async () => {
      const vc = await validCoins(req.userId);
      if (vc.expired > 0 && n > vc.valid) {
        const e = new Error('🤖 ' + vc.expired + ' de tes pièces ont expiré (3 mois ou plus). Seules ' + vc.valid + ' pièces sont retirables.');
        e.httpStatus = 400; throw e;
      }
      if (n > vc.valid) {
        const e = new Error('pas assez de pièces valides (' + vc.valid + ' disponibles)');
        e.httpStatus = 400; throw e;
      }
      await raceGap(req); // crochet test concurrence (Équipe 8/10) : simule l'intercalage Postgres
      // débit atomique anti double-retrait (race condition)
      const debited = await runSqlChanges('UPDATE users SET coins=coins-? WHERE id=? AND coins>=?', n, req.userId, n);
      if (!debited) { const e = new Error('pas assez de pièces'); e.httpStatus = 400; throw e; }
      await runSql('INSERT INTO ledger(user_id,amount,reason,created_at) VALUES(?,?,?,?)',
        req.userId, -n, 'retrait ' + pm.type, now());
      return { ok: true };
    }).catch(e => {
      if (e.httpStatus) return { _err: e.message, _status: e.httpStatus };
      throw e;
    });
    if (wdOut._err) return res.status(wdOut._status).json({ error: wdOut._err });
    const usd = Math.floor(n / 500 * 100) / 100;
    const wid = await insertId(
      'INSERT INTO withdrawals(user_id,coins,usd,method,account,status,created_at) VALUES(?,?,?,?,?,?,?)',
      req.userId, n, usd, pm.type, pm.account, 'pending', now());
    const rid = await insertId(
      'INSERT INTO receipts(withdrawal_id,user_id,receipt_no,coins,usd,method,account,status,email_status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
      wid, req.userId, 'TMP', n, usd, pm.label || pm.type, pm.account, 'pending', 'pending', now());
    const receiptNo = 'VG-' + new Date().getFullYear() + '-' + String(rid).padStart(6, '0');
    await runSql('UPDATE receipts SET receipt_no=? WHERE id=?', receiptNo, rid);
    const r = await get1('SELECT * FROM receipts WHERE id=?', rid);
    const emailStatus = await sendReceiptEmail(me, { ...r, receipt_no: receiptNo });
    await runSql('UPDATE receipts SET email_status=? WHERE id=?', emailStatus, rid);
    const bal = await get1('SELECT coins FROM users WHERE id=?', req.userId);
    res.json({ ok: true, id: wid, usd, status: 'pending', receipt_no: receiptNo, email: emailStatus, coins: bal ? bal.coins : 0 });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// ---------- parrainage réel : +50 pièces parrain + filleul, validé serveur ----------
app.post('/api/referral', auth, async (req, res) => {
  try {
    const code = String((req.body || {}).code || '').trim().toUpperCase();
    const me = await get1('SELECT * FROM users WHERE id=?', req.userId);
    if (!me) return res.status(400).json({ error: 'compte introuvable' });
    if (me.referred_by) return res.status(400).json({ error: 'code déjà utilisé' });
    if (!code) return res.status(400).json({ error: 'code requis' });
    const parrain = await get1('SELECT * FROM users WHERE UPPER(ref_code)=?', code);
    if (!parrain) return res.status(404).json({ error: 'code invalide' });
    if (Number(parrain.id) === Number(req.userId)) return res.status(400).json({ error: 'impossible' });
    await raceGap(req); // crochet test concurrence (Équipe 8/10) : simule l'intercalage Postgres
    // FIX race 2026-10-05 (Équipe 8/10) : double-claim — le 2e passage concurrent
    // trouve referred_by déjà renseigné (UPDATE conditionnel → 0 ligne) et est rejeté
    // AVANT de créditer. Avant : les deux requêtes passaient le test `me.referred_by`
    // puis créditaient +50/+50 chacune (prouvé : 250 au lieu de 50).
    const claimed = await runSqlChanges('UPDATE users SET referred_by=? WHERE id=? AND referred_by IS NULL', parrain.id, req.userId);
    if (!claimed) return res.status(400).json({ error: 'code déjà utilisé' });
    await runSql('UPDATE users SET coins=coins+50 WHERE id=?', req.userId);
    await runSql('UPDATE users SET coins=coins+50 WHERE id=?', parrain.id);
    const t = now();
    await runSql('INSERT INTO ledger(user_id,amount,reason,created_at) VALUES(?,?,?,?)', req.userId, 50, 'parrainage (filleul)', t);
    await runSql('INSERT INTO ledger(user_id,amount,reason,created_at) VALUES(?,?,?,?)', parrain.id, 50, 'parrainage de @' + me.username, t);
    const upd = await get1('SELECT coins FROM users WHERE id=?', req.userId);
    res.json({ ok: true, granted: 50, coins: upd.coins });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// v1.65 : solde de pièces valides vs expirées (3 mois)
// ==================== RECHARGE DE PIÈCES ====================
const RECHARGE_PACKS = [
  { coins: 100, usd: 0.99 }, { coins: 500, usd: 4.99 },
  { coins: 1000, usd: 9.99 }, { coins: 5000, usd: 49.99 },
];
const RECHARGE_METHODS = [
  { id: 'paypal', name: 'PayPal', emoji: '💙', desc: 'Paiement en ligne sécurisé', auto: true },
  { id: 'card', name: 'Carte bancaire', emoji: '💳', desc: 'Visa, Mastercard', auto: false },
  { id: 'googlepay', name: 'Google Pay', emoji: '🅖', desc: 'Paiement Google', auto: false },
  { id: 'natcash', name: 'NatCash', emoji: '📱', desc: 'Haïti — vérification manuelle', auto: false },
  { id: 'moncash', name: 'MonCash', emoji: '📲', desc: 'Haïti — vérification manuelle', auto: false },
];
app.get('/api/coins/recharge-methods', async (req, res) => {
  const cfg = paypalCfg();
  res.json({ methods: RECHARGE_METHODS.map(m => ({ ...m, available: m.id === 'paypal' ? !!cfg : true })), packs: RECHARGE_PACKS });
});
// Helper : token d'accès PayPal (cache 8 min)
let _ppToken = null, _ppTokenExp = 0;
async function paypalToken() {
  const cfg = paypalCfg();
  if (!cfg) return null;
  if (_ppToken && now() < _ppTokenExp) return _ppToken;
  const creds = Buffer.from(cfg.id + ':' + cfg.secret).toString('base64');
  const r = await fetch(cfg.api + '/v1/oauth2/token', {
    method: 'POST',
    headers: { 'Authorization': 'Basic ' + creds, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials'
  });
  const d = await r.json().catch(() => ({}));
  if (!d.access_token) return null;
  _ppToken = d.access_token;
  _ppTokenExp = now() + 8 * 60 * 1000;
  return _ppToken;
}
// Créer une recharge : PayPal (auto) ou méthodes manuelles (formulaire -> pending)
app.post('/api/coins/recharge', auth, async (req, res) => {
  try {
    const b = req.body || {};
    const method = String(b.method || 'paypal');
    const pack = RECHARGE_PACKS.find(x => x.coins === Number(b.pack));
    if (!pack) return res.status(400).json({ error: 'pack invalide' });
    const m = RECHARGE_METHODS.find(x => x.id === method);
    if (!m) return res.status(400).json({ error: 'méthode inconnue' });
    const details = String(b.details || '').slice(0, 500);
    const t = now();
    if (method === 'paypal') {
      const cfg = paypalCfg();
      if (!cfg) return res.status(400).json({ error: 'PayPal non configuré' });
      const token = await paypalToken();
      if (!token) return res.status(500).json({ error: 'PayPal indisponible pour le moment' });
      const rid = await insertId('INSERT INTO coin_recharges(user_id,method,coins,amount_usd,currency,status,created_at) VALUES(?,?,?,?,?,?,?)',
        req.userId, 'paypal', pack.coins, pack.usd, 'USD', 'awaiting_payment', t);
      const returnUrl = (process.env.SERVER_URL || 'https://vidigagne-server.onrender.com') + '/api/coins/recharge/paypal/callback?rid=' + rid;
      const or = await fetch(cfg.api + '/v2/checkout/orders', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          intent: 'CAPTURE',
          purchase_units: [{ amount: { currency_code: 'USD', value: pack.usd.toFixed(2) }, description: pack.coins + ' pièces VidiGagne', custom_id: 'recharge-' + rid }],
          application_context: { return_url: returnUrl, cancel_url: returnUrl + '&cancel=1', brand_name: 'VidiGagne', user_action: 'PAY_NOW' }
        })
      });
      const od = await or.json().catch(() => ({}));
      const approval = (od.links || []).find(x => x.rel === 'approve');
      if (!od.id || !approval) {
        await runSql("UPDATE coin_recharges SET status='failed' WHERE id=?", rid);
        return res.status(500).json({ error: 'création du paiement PayPal impossible' });
      }
      await runSql('UPDATE coin_recharges SET paypal_order_id=? WHERE id=?', od.id, rid);
      return res.json({ ok: true, recharge_id: rid, approval_url: approval.href, method: 'paypal' });
    }
    // Méthodes manuelles : formulaire fonctionnel -> demande en attente de vérification
    if (!details && (method === 'natcash' || method === 'moncash')) {
      return res.status(400).json({ error: 'numéro de téléphone et référence requis' });
    }
    const rid = await insertId('INSERT INTO coin_recharges(user_id,method,coins,amount_usd,currency,status,details,created_at) VALUES(?,?,?,?,?,?,?,?)',
      req.userId, method, pack.coins, pack.usd, method === 'natcash' || method === 'moncash' ? 'HTG' : 'USD', 'pending', details, t);
    await runSql('INSERT INTO ledger(user_id,amount,reason,created_at) VALUES(?,?,?,?)', req.userId, 0, 'recharge ' + method + ' en attente (' + pack.coins + ')', now()).catch(() => {});
    res.json({ ok: true, recharge_id: rid, status: 'pending', method,
      message: method === 'card' || method === 'googlepay'
        ? 'Demande enregistrée. Tes pièces seront créditées après vérification du paiement.'
        : 'Demande enregistrée. Envoie le paiement puis tes pièces seront créditées après vérification.' });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// Retour PayPal après approbation -> capture + crédit des pièces
app.get('/api/coins/recharge/paypal/callback', async (req, res) => {
  try {
    const rid = Number(req.query.rid);
    const rc = rid ? await get1('SELECT * FROM coin_recharges WHERE id=?', rid) : null;
    if (!rc) return res.status(404).send('Recharge introuvable');
    if (req.query.cancel) {
      await runSql("UPDATE coin_recharges SET status='cancelled' WHERE id=?", rid);
      return res.send('<html><body style="font-family:sans-serif;text-align:center;padding:40px"><h2>Paiement annulé</h2><p>Tu peux fermer cette page et revenir dans VidiGagne.</p></body></html>');
    }
    if (rc.status === 'completed') {
      return res.send('<html><body style="font-family:sans-serif;text-align:center;padding:40px"><h2>✅ Déjà crédité</h2><p>Tes pièces sont sur ton compte VidiGagne.</p></body></html>');
    }
    // FIX paiements 2026-10-06 : 2 callbacks simultanés passaient chacun le contrôle
    // 'completed' puis créditaient 2 fois les pièces. Claim atomique : un seul capture.
    const claimed = await runSqlChanges("UPDATE coin_recharges SET status='capturing' WHERE id=? AND status='awaiting_payment'", rid);
    if (!claimed) {
      const rc2 = await get1('SELECT status FROM coin_recharges WHERE id=?', rid);
      if (rc2 && rc2.status === 'completed')
        return res.send('<html><body style="font-family:sans-serif;text-align:center;padding:40px"><h2>✅ Déjà crédité</h2><p>Tes pièces sont sur ton compte VidiGagne.</p></body></html>');
      return res.status(409).send('Paiement déjà en cours de traitement. Patiente quelques secondes puis reviens.');
    }
    const cfg = paypalCfg();
    const token = cfg ? await paypalToken() : null;
    // FIX 2026-10-06 : sans ce reset, un token indisponible laissait la recharge bloquée
    // en 'capturing' pour toujours (invisible à l'admin, retry impossible → 409).
    if (!token || !rc.paypal_order_id) {
      await runSql("UPDATE coin_recharges SET status='awaiting_payment' WHERE id=? AND status='capturing'", rid);
      return res.status(500).send('Paiement indisponible');
    }
    const cr = await fetch(cfg.api + '/v2/checkout/orders/' + encodeURIComponent(rc.paypal_order_id) + '/capture', {
      method: 'POST', headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' }, body: '{}'
    });
    const cd = await cr.json().catch(() => ({}));
    const captured = cd.status === 'COMPLETED' || (cd.purchase_units || []).some(p => (p.payments || {}).captures);
    if (!captured) {
      await runSql("UPDATE coin_recharges SET status='failed' WHERE id=? AND status='capturing'", rid);
      return res.status(400).send('Le paiement n\'a pas pu être capturé. Réessaie.');
    }
    await runSql('UPDATE users SET coins=coins+? WHERE id=?', rc.coins, rc.user_id);
    await runSql("UPDATE coin_recharges SET status='completed', processed_at=? WHERE id=?", now(), rid);
    await runSql('INSERT INTO ledger(user_id,amount,reason,created_at) VALUES(?,?,?,?)',
      rc.user_id, rc.coins, 'recharge PayPal ' + rc.coins, now());
    await notify(rc.user_id, 'recharge', null, null, String(rc.coins)).catch(() => {});
    res.send('<html><body style="font-family:sans-serif;text-align:center;padding:40px"><h2>✅ Paiement réussi !</h2><p>' + rc.coins + ' pièces ont été ajoutées à ton compte VidiGagne.</p><p>Tu peux fermer cette page.</p></body></html>');
  } catch (e) { res.status(500).send('Erreur lors du traitement du paiement'); }
});
// Statut d'une recharge
app.get('/api/coins/recharge/:id/status', auth, async (req, res) => {
  try {
    const rc = await get1('SELECT id, method, coins, status, created_at FROM coin_recharges WHERE id=? AND user_id=?', Number(req.params.id), req.userId);
    if (!rc) return res.status(404).json({ error: 'introuvable' });
    const bal = await get1('SELECT coins FROM users WHERE id=?', req.userId);
    res.json({ ok: true, recharge: rc, balance: bal ? bal.coins : 0 });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// Admin : liste des recharges en attente
app.get('/api/admin/recharges', adminAuth, async (req, res) => {
  try {
    const rows = await allRows(`SELECT r.*, u.username FROM coin_recharges r JOIN users u ON u.id=r.user_id WHERE r.status IN ('pending','awaiting_payment') ORDER BY r.created_at DESC LIMIT 100`);
    res.json({ recharges: rows });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// Admin : approuver / rejeter une recharge manuelle
app.post('/api/admin/recharges/:id/approve', adminAuth, async (req, res) => {
  try {
    const rc = await get1('SELECT * FROM coin_recharges WHERE id=?', Number(req.params.id));
    if (!rc) return res.status(404).json({ error: 'introuvable' });
    if (rc.status !== 'pending') return res.status(400).json({ error: 'déjà traitée' });
    // FIX paiements 2026-10-06 : 2 approbations simultanées passaient chacune le contrôle
    // 'pending' puis créditaient 2 fois. Claim atomique : une seule gagne.
    const claimed = await runSqlChanges("UPDATE coin_recharges SET status='processing' WHERE id=? AND status='pending'", rc.id);
    if (!claimed) return res.status(400).json({ error: 'déjà traitée' });
    const approve = String((req.body || {}).action || 'approve') === 'approve';
    if (approve) {
      await runSql('UPDATE users SET coins=coins+? WHERE id=?', rc.coins, rc.user_id);
      await runSql('INSERT INTO ledger(user_id,amount,reason,created_at) VALUES(?,?,?,?)',
        rc.user_id, rc.coins, 'recharge ' + rc.method + ' ' + rc.coins + ' (validée)', now());
      await notify(rc.user_id, 'recharge', null, null, String(rc.coins)).catch(() => {});
    }
    await runSql("UPDATE coin_recharges SET status=?, processed_at=? WHERE id=?", approve ? 'completed' : 'rejected', now(), rc.id);
    res.json({ ok: true, approved: approve });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.get('/api/coins/valid', auth, async (req, res) => {
  const vc = await validCoins(req.userId);
  res.json({ valid: vc.valid, expired: vc.expired, expiry_days: 90 });
});
app.get('/api/receipts', auth, async (req, res) => {
  const rows = await allRows('SELECT * FROM receipts WHERE user_id=? ORDER BY created_at DESC LIMIT 100', req.userId);
  res.json({ receipts: rows });
});
app.get('/api/receipts/:id', auth, async (req, res) => {
  let r = await get1('SELECT * FROM receipts WHERE id=? AND user_id=?', req.params.id, req.userId);
  // v2.40 : accepte aussi le n° de reçu (format VG-AAAA-XXXXXX)
  if (!r && /VG-/i.test(String(req.params.id)))
    r = await get1('SELECT * FROM receipts WHERE receipt_no=? AND user_id=?',
      String(req.params.id).toUpperCase(), req.userId);
  if (!r) return res.status(404).json({ error: 'introuvable' });
  res.json({ receipt: r });
});
// ---------- FONDS CRÉATEURS (différent de TikTok) ----------
// Éligibilité : 1000 abonnés ET 50 000 vues ORGANIQUES issues des VIDÉOS
// uniquement (anti-triche : 1 vue/spectateur/vidéo/24h, pas d'auto-vues,
// plafond 100/jour) ET identité vérifiée (KYC approuvé, tout pays accepté).
// Paiement : seules les vues MONÉTISÉES (avec publicité affichée) sont
// payées, toujours en 50-50 des revenus publicitaires réels.
async function fundEligibility(userId) {
  const fol = await get1('SELECT COUNT(*) AS c FROM follows WHERE followed_id=?', userId);
  const vw = await get1('SELECT COALESCE(SUM(views),0) AS s FROM videos WHERE user_id=?', userId);
  const avw = await get1('SELECT COALESCE(SUM(ad_views),0) AS s FROM videos WHERE user_id=?', userId);
  const kyc = await get1('SELECT status FROM id_verifications WHERE user_id=?', userId);
  const app = await get1('SELECT status FROM fund_applications WHERE user_id=?', userId);
  const followers = Number(fol.c), views = Number(vw.s);
  const kycStatus = kyc ? kyc.status : 'none';
  const appStatus = app ? app.status : 'none'; // v2.42 : la candidature validée par l'admin est requise
  return {
    eligible: followers >= 1000 && views >= 50000 && kycStatus === 'approved' && appStatus === 'approved',
    followers, views, ad_views: Number(avw.s), kyc: kycStatus, application: appStatus,
  };
}
app.get('/api/fund/status', auth, async (req, res) => {
  try {
    const e = await fundEligibility(req.userId);
    const er = await get1('SELECT COALESCE(SUM(amount_usd),0) AS s, COALESCE(SUM(coins),0) AS c FROM fund_earnings WHERE user_id=?', req.userId);
    res.json({
      eligible: e.eligible,
      followers: e.followers, followers_needed: 1000,
      views: e.views, views_needed: 50000,
      ad_views: e.ad_views, kyc: e.kyc,
      application: e.application,
      total_earned_usd: Math.floor(Number(er.s) * 100) / 100,
      total_earned_coins: Number(er.c),
    });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// v2.42 : postuler au Fonds Créateurs (les critères doivent être remplis ; l'admin valide ensuite)
app.post('/api/fund/apply', auth, async (req, res) => {
  try {
    const fol = await get1('SELECT COUNT(*) AS c FROM follows WHERE followed_id=?', req.userId);
    const vw = await get1('SELECT COALESCE(SUM(views),0) AS s FROM videos WHERE user_id=?', req.userId);
    const kyc = await get1('SELECT status FROM id_verifications WHERE user_id=?', req.userId);
    const kycStatus = kyc ? kyc.status : 'none';
    if (!(Number(fol.c) >= 1000 && Number(vw.s) >= 50000 && kycStatus === 'approved'))
      return res.status(400).json({ error: 'critères non remplis (1000 abonnés, 50 000 vues, identité vérifiée)' });
    const ex = await get1('SELECT status FROM fund_applications WHERE user_id=?', req.userId);
    if (ex && ex.status === 'pending') return res.status(400).json({ error: 'candidature déjà en cours d\u2019examen' });
    if (ex && ex.status === 'approved') return res.status(400).json({ error: 'tu es déjà dans le Fonds Créateurs' });
    await runSql(`INSERT INTO fund_applications(user_id,status,created_at,decided_at,note) VALUES(?, 'pending', ?, NULL, '')
      ON CONFLICT(user_id) DO UPDATE SET status='pending', created_at=excluded.created_at, decided_at=NULL, note=''`, req.userId, now());
    await notify(req.userId, 'system', null, null, '💰 Candidature au Fonds Créateurs envoyée !');
    res.json({ ok: true, status: 'pending' });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.get('/api/fund/application', auth, async (req, res) => {
  try {
    const a = await get1('SELECT status, created_at, decided_at, note FROM fund_applications WHERE user_id=?', req.userId);
    res.json(a ? { status: a.status, created_at: a.created_at, decided_at: a.decided_at, note: a.note } : { status: 'none' });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.get('/api/admin/fund/applications', async (req, res) => {
  const t = req.headers['x-admin-token'];
  if (!process.env.ADMIN_TOKEN || t !== process.env.ADMIN_TOKEN) return res.status(403).json({ error: 'non autorisé' });
  try {
    const rows = await allRows(`SELECT fa.*, u.username, u.avatar,
      (SELECT COUNT(*) FROM follows WHERE followed_id=u.id) AS followers,
      (SELECT COALESCE(SUM(views),0) FROM videos WHERE user_id=u.id) AS views,
      (SELECT status FROM id_verifications WHERE user_id=u.id) AS kyc
      FROM fund_applications fa JOIN users u ON u.id=fa.user_id
      WHERE fa.status='pending' ORDER BY fa.created_at ASC LIMIT 100`);
    res.json({ applications: rows });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.post('/api/admin/fund/applications/:id', async (req, res) => {
  const t = req.headers['x-admin-token'];
  if (!process.env.ADMIN_TOKEN || t !== process.env.ADMIN_TOKEN) return res.status(403).json({ error: 'non autorisé' });
  try {
    const approve = String((req.body || {}).action) === 'approve';
    const a = await get1('SELECT * FROM fund_applications WHERE id=?', req.params.id);
    if (!a) return res.status(404).json({ error: 'introuvable' });
    await runSql('UPDATE fund_applications SET status=?, decided_at=? WHERE id=?',
      approve ? 'approved' : 'rejected', now(), a.id);
    await notify(a.user_id, 'system', null, null,
      approve ? '💰 Bienvenue dans le Fonds Créateurs !' : '💰 Ta candidature au Fonds Créateurs a été refusée.');
    // v2.44-EQD-MAIL : e-mail de décision Fonds Créateurs (approuvée / refusée)
    {
      const fu = await get1('SELECT email, username FROM users WHERE id=?', a.user_id);
      if (fu && fu.email) sendVidiEmail(fu.email,
        approve ? '💰 Bienvenue dans le Fonds Créateurs — VidiGagne' : '💰 Fonds Créateurs — candidature refusée',
        '<p style="font-size:18px">' + (approve ? '💰 Bienvenue dans le Fonds Créateurs !' : '💰 Candidature non retenue') + '</p>'
        + '<p style="color:#ccc;font-size:14px">' + (approve
          ? 'Félicitations @' + String(fu.username).replace(/</g, '&lt;') + ' ! Tu fais désormais partie du Fonds Créateurs VidiGagne : tu recevras ta part des revenus publicitaires.'
          : 'Ta candidature au Fonds Créateurs n\'a pas été retenue pour le moment. Continue à publier et à faire grandir ta communauté, puis retente ta chance !') + '</p>',
        approve ? 'Bienvenue dans le Fonds Créateurs VidiGagne !' : 'Ta candidature au Fonds Créateurs n\'a pas été retenue.').catch(() => {});
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// Dépôt des revenus publicitaires réels (admin uniquement).
// 50 % reversés aux créateurs VÉRIFIÉS, au prorata de leurs VUES MONÉTISÉES.
app.post('/api/fund/deposit', async (req, res) => {
  try {
    const token = req.headers['x-admin-token'];
    if (!process.env.ADMIN_TOKEN || token !== process.env.ADMIN_TOKEN)
      return res.status(403).json({ error: 'non autorisé' });
    const amount = Number((req.body || {}).amount_usd);
    if (!amount || amount <= 0) return res.status(400).json({ error: 'montant invalide' });
    const period = String((req.body || {}).period || '').slice(0, 40);
    const users = await allRows('SELECT id FROM users');
    const elig = [];
    for (const u of users) {
      const e = await fundEligibility(u.id);
      if (e.eligible && e.ad_views > 0) elig.push({ id: u.id, views: e.ad_views });
    }
    const totalViews = elig.reduce((a, e) => a + e.views, 0);
    const share = Math.floor(amount * 0.5 * 100) / 100; // 50-50 : moitié créateurs
    const depId = await insertId(
      'INSERT INTO fund_deposits(amount_usd,creators_share_usd,period,created_at) VALUES(?,?,?,?)',
      amount, share, period, now());
    let distributed = 0;
    for (const e of elig) {
      const usd = totalViews > 0 ? Math.floor(share * e.views / totalViews * 100) / 100 : 0;
      const coins = Math.round(usd * 500);
      if (coins > 0) {
        await runSql('UPDATE users SET coins=coins+? WHERE id=?', coins, e.id);
        await runSql('INSERT INTO ledger(user_id,amount,reason,created_at) VALUES(?,?,?,?)',
          e.id, coins, 'fonds créateurs' + (period ? ' (' + period + ')' : ''), now());
        await runSql('INSERT INTO fund_earnings(deposit_id,user_id,views,amount_usd,coins,created_at) VALUES(?,?,?,?,?,?)',
          depId, e.id, e.views, usd, coins, now());
        distributed += usd;
      }
    }
    res.json({ ok: true, deposit_id: depId, creators: elig.length, distributed_usd: Math.floor(distributed * 100) / 100 });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// ---------- signalisation WebRTC pour les LIVE ----------
const liveRooms = {}; // liveId -> { broadcaster: ws|null, viewers: Map(ws -> peerId) }
const liveChests = new Map(); // liveId -> Map(chestId -> {chestId, coins, winners, hostId, openedBy:{}}), éphémère
async function userIdFromToken(token) {
  if (!token) return null;
  const row = await get1('SELECT user_id FROM tokens WHERE token=?', String(token));
  return row ? row.user_id : null;
}
function liveBroadcastViewers(liveId) {
  const room = liveRooms[liveId];
  if (!room) return;
  runSql('UPDATE lives SET viewers=? WHERE id=?', room.viewers.size, liveId).catch(() => {});
  const msg = JSON.stringify({ t: 'viewers', n: room.viewers.size });
  if (room.broadcaster && room.broadcaster.readyState === 1) room.broadcaster.send(msg);
}
function setupLiveWs(server) {
  const { WebSocketServer } = require('ws');
  const wss = new WebSocketServer({ noServer: true });
  wsRoute['/api/live/ws'] = wss;
  wss.on('connection', (ws) => {
    let liveId = null, role = null, peerId = null;
    ws.on('message', async (buf) => {
      let m; try { m = JSON.parse(buf.toString()); } catch (e) { return; }
      liveId = String(m.liveId || liveId || '');
      if (m.t === 'start') {
        const uid = await userIdFromToken(m.token);
        if (!uid) { ws.close(); return; }
        // v1.54 : seul le PROPRIÉTAIRE du live peut devenir broadcaster (anti-détournement)
        const l = await liveById(liveId);
        if (!l || Number(l.user_id) !== Number(uid)) { ws.close(); return; }
        const room = liveRooms[liveId] = liveRooms[liveId] || { broadcaster: null, viewers: new Map() };
        room.broadcaster = ws; role = 'broadcaster';
        return;
      }
      if (m.t === 'join') {
        // COIN-04 (2026-10-05) : un viewer peut rejoindre même si le broadcaster n'a pas
        // encore ouvert sa WS — avant, `if (!room) return` ignorait silencieusement le join
        // et le chat HTTP ne trouvait personne à qui diffuser.
        const rm = liveRooms[liveId] = liveRooms[liveId] || { broadcaster: null, viewers: new Map() };
        peerId = 'v' + Math.random().toString(36).slice(2, 9);
        rm.viewers.set(ws, peerId); role = 'viewer';
        if (rm.broadcaster && rm.broadcaster.readyState === 1)
          rm.broadcaster.send(JSON.stringify({ t: 'viewer', id: peerId }));
        liveBroadcastViewers(liveId);
        return;
      }
      const room = liveRooms[liveId];
      if (!room) return;
      if (m.t === 'chat') {
        const uid = await userIdFromToken(m.token);
        const raw = String(m.text || '').trim().slice(0, 280);
        if (!uid || !raw) return;
        // FIX sécu 2026-10-05 (failles vague 2 F3) : le chat WS contournait le filtre
        // anti-gros mots et le ban/mute (appliqués sur le HTTP). Même protection ici.
        if (containsBadword(raw)) return;
        try {
          const bk = await get1('SELECT kind FROM live_bans WHERE live_id=? AND user_id=?', liveId, uid);
          if (bk) return;
        } catch (_) {}
        const text = raw;
        const u = await get1('SELECT username FROM users WHERE id=?', uid);
        const payload = JSON.stringify({ t: 'chat', user: u ? u.username : '?', text });
        if (room.broadcaster && room.broadcaster.readyState === 1) room.broadcaster.send(payload);
        room.viewers.forEach((pid, w) => { if (w !== ws && w.readyState === 1) w.send(payload); });
        if (ws.readyState === 1) ws.send(payload);
        return;
      }
      // FIX sécu 2026-10-05 (failles vague 2 F3) : le handler WS 'gift' a été SUPPRIMÉ.
      // Il diffusait un visuel de cadeau SANS aucun débit de pièces (spoof prouvé :
      // n'importe quel client WS pouvait afficher "🐉 DRAGON LÉGENDAIRE" gratuitement).
      // Les vrais cadeaux passent par POST /api/live/:id/gift (débite puis crédite le score).
      // relais WebRTC offer/answer/ice
      const from = role === 'broadcaster' ? 'broadcaster' : peerId;
      let target = null;
      if (m.to === 'broadcaster') target = room.broadcaster;
      else room.viewers.forEach((pid, w) => { if (pid === m.to) target = w; });
      if (target && target.readyState === 1) target.send(JSON.stringify({ ...m, from }));
    });
    ws.on('close', () => {
      const room = liveId && liveRooms[liveId];
      if (!room) return;
      if (role === 'broadcaster' && room.broadcaster === ws) room.broadcaster = null;
      if (role === 'viewer') { room.viewers.delete(ws); liveBroadcastViewers(liveId); }
    });
  });
}

// ---------- v12 : algo « Pour toi » personnalisé ----------
// tags d'une vidéo : texte libre séparé par des virgules -> tableau normalisé
function tagsOf(v) {
  return String(v.tags || '').split(',').map(t => t.trim().toLowerCase()).filter(t => t.length > 1);
}
// Score = 0.35*affinité_créateur + 0.25*affinité_tags + 0.25*like_rate
//         + 0.15*récence − 0.9*déjà_vu_en_entier. SQL portable PG/SQLite :
// les agrégats simples sont en SQL, le reste est calculé en JS.
async function scoreForYou(candidates, meId) {
  if (!candidates.length) return [];
  // v1.64 : pays du spectateur pour le ciblage d'audience
  let myCountry = '';
  try { const mu = await get1('SELECT country FROM users WHERE id=?', meId); if (mu) myCountry = String(mu.country || '').toUpperCase(); } catch (_) {}
  // v1.84 : préférences de contenu (sujets + / -), comptes suivis, mode restreint
  let prefMore = [], prefLess = [], followedSet = new Set(), restricted = false;
  try {
    const pr = await allRows('SELECT topic, pref FROM content_prefs WHERE user_id=?', meId);
    for (const p of pr) { if (p.pref === 'less') prefLess.push(p.topic); else prefMore.push(p.topic); }
    const fr = await allRows('SELECT followed_id FROM follows WHERE follower_id=?', meId);
    for (const f of fr) followedSet.add(Number(f.followed_id));
    const mu2 = await get1('SELECT restricted_mode FROM users WHERE id=?', meId);
    restricted = mu2 && Number(mu2.restricted_mode) === 1;
  } catch (_) {}
  // v2.38 : scores de tags issus des likes (table user_tag_scores) — signal « Pour toi » explicite
  let tagScores = {};
  try {
    const _ts = await allRows('SELECT tag, score FROM user_tag_scores WHERE user_id=?', meId);
    for (const _r of _ts) tagScores[String(_r.tag).toLowerCase()] = Number(_r.score) || 0;
  } catch (_) {}
  // affinité créateur : taux de complétion moyen de mes watch_events par créateur
  const creatorRows = await allRows(
    `SELECT v.user_id AS uid, AVG(we.completed) AS r FROM watch_events we
     JOIN videos v ON v.id=we.video_id WHERE we.user_id=? GROUP BY v.user_id`, meId);
  const affCreator = {};
  for (const r of creatorRows) affCreator[r.uid] = Number(r.r) || 0;
  // mes événements (tags + vidéos déjà vues en entier)
  const evRows = await allRows(
    `SELECT we.video_id, we.completed, v.tags AS vtags FROM watch_events we
     JOIN videos v ON v.id=we.video_id WHERE we.user_id=?`, meId);
  const seenFull = new Set();
  const evByVideo = {};
  for (const e of evRows) {
    if (Number(e.completed) === 1) seenFull.add(Number(e.video_id));
    (evByVideo[e.video_id] = evByVideo[e.video_id] || []).push(e);
  }
  const evTags = {};
  for (const vid of Object.keys(evByVideo)) evTags[vid] = tagsOf({ tags: evByVideo[vid][0].vtags });
  // likes par vidéo candidate
  const ids = candidates.map(v => v.id);
  const likeRows = await allRows(
    `SELECT video_id, COUNT(*) AS c FROM likes WHERE video_id IN (${ids.map(() => '?').join(',')}) GROUP BY video_id`,
    ...ids);
  const likeCount = {};
  for (const r of likeRows) likeCount[r.video_id] = Number(r.c);
  const tnow = now();
  const scored = candidates.map(v => {
    const vtags = tagsOf(v);
    // affinité tags : complétion moyenne de mes événements sur des vidéos partageant ≥1 tag
    // (v13 : on collecte aussi les tags partagés pour expliquer "pourquoi cette vidéo")
    let tSum = 0, tN = 0;
    const sharedTags = {};
    if (vtags.length) {
      for (const vid of Object.keys(evByVideo)) {
        if (Number(vid) === Number(v.id)) continue;
        const common = evTags[vid].filter(t => vtags.includes(t));
        if (common.length) {
          for (const e of evByVideo[vid]) { tSum += Number(e.completed) || 0; tN++; }
          for (const t of common) sharedTags[t] = (sharedTags[t] || 0) + 1;
        }
      }
    }
    const affTags = tN ? tSum / tN : 0;
    const likeRate = (likeCount[v.id] || 0) / ((Number(v.views) || 0) + 1);
    const hours = Math.max(0, (tnow - Number(v.created_at)) / 3600000);
    const recency = 1 / (1 + hours / 24);
    const affC = affCreator[v.user_id] || 0;
    const seen = seenFull.has(Number(v.id));
    // v1.64 : boost si la vidéo cible mon pays
    let countryBoost = 0;
    if (myCountry) {
      try {
        const tc = JSON.parse(v.target_countries || '[]');
        if (Array.isArray(tc) && tc.includes(myCountry)) countryBoost = 0.3;
      } catch (_) {}
    }
    // v1.84 : boost sujets aimés, malus sujets rejetés, boost suivis
    let prefBoost = 0;
    if (vtags.length) {
      for (const t of vtags) {
        if (prefMore.includes(t)) prefBoost += 0.25;
        if (prefLess.includes(t)) prefBoost -= 0.5;
      }
    }
    const followBoost = followedSet.has(Number(v.user_id)) ? 0.3 : 0;
    // v2.38 : boost des tags likés (signal explicite, plafonné à 1.5)
    let likeTagBoost = 0;
    const likeTags = [];
    if (vtags.length) {
      for (const t of vtags) {
        const sc = tagScores[t] || 0;
        if (sc > 0) { likeTagBoost += Math.min(sc, 10) * 0.15; likeTags.push(t); }
      }
      likeTagBoost = Math.min(likeTagBoost, 1.5);
    }
    const score = 0.35 * affC
      + 0.25 * affTags
      + 0.25 * likeRate
      + 0.15 * recency
      + countryBoost
      + prefBoost
      + followBoost
      + likeTagBoost
      - 0.9 * (seen ? 1 : 0);
    // v13 : explication "pourquoi cette vidéo ?" (façon TikTok)
    const why = [];
    if (followedSet.has(Number(v.user_id))) why.push('Un créateur que tu suis');
    if (affC > 0.5) why.push('Tu regardes souvent ce créateur');
    if (affTags > 0.5) {
      const top = Object.keys(sharedTags).sort((a, b) => sharedTags[b] - sharedTags[a]).slice(0, 3);
      why.push('Tags que tu aimes : ' + top.map(t => '#' + t).join(' '));
    }
    if (likeRate > 0.08) why.push('Populaire auprès des spectateurs');
    if (likeTags.length) why.push('Tu aimes : ' + likeTags.slice(0, 3).map(t => '#' + t).join(' '));
    if (recency > 0.7) why.push('Publiée récemment');
    if (countryBoost > 0) why.push('Ciblée pour ton pays');
    if (seen) why.push('Déjà vue en entier');
    if (!why.length) why.push('Sélectionnée pour toi');
    v._why = why.slice(0, 3);
    return { v, score };
  });
  // v1.84 : exclut les vidéos dont tous les tags sont rejetés
  const filtered = scored.filter(s => {
    const vtags = tagsOf(s.v);
    if (!vtags.length) return true;
    return !vtags.every(t => prefLess.includes(t));
  });
  filtered.sort((a, b) => b.score - a.score);
  return filtered.slice(0, 50).map(s => s.v);
}

app.get('/api/feed', async (req, res) => {
  try {
    const h = req.headers.authorization || '';
    const m = h.match(/^Bearer (.+)$/);
    let meId = null;
    if (m) { const t = await get1('SELECT user_id FROM tokens WHERE token=?', m[1]); if (t) meId = t.user_id; }
    const mode = req.query.mode === 'following' && meId ? 'following' : 'foryou';
    // PAGINATION 2026-10-04 : ?page=N (1-based). has_more renvoyé pour le scroll infini.
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const off = (page - 1);
    let pageSize = 50, has_more = false;
    let rows;
    // FIX 2026-10-04 (bot chain-profile-stats) : `restricted` n'était défini que dans
    // scoreForYou → ReferenceError → /api/feed renvoyait 500 systématiquement
    let restricted = false;
    if (meId) { try { const mu = await get1('SELECT restricted_mode FROM users WHERE id=?', meId); restricted = !!(mu && Number(mu.restricted_mode) === 1); } catch (e) {} }
    // les vidéos programmées (scheduled_at futur), masquées (modération) ou "pas intéressé" sont exclues ;
    // les vidéos d'utilisateurs bloqués (dans les deux sens) aussi
    const blockFilter = alias => ` AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.user_id=? AND b.blocked_id=${alias}.user_id) OR (b.user_id=${alias}.user_id AND b.blocked_id=?))`;
    if (mode === 'following') {
      let sql = `SELECT v.* FROM videos v JOIN follows f ON f.followed_id=v.user_id
         WHERE f.follower_id=? AND (v.scheduled_at IS NULL OR v.scheduled_at <= ?) AND v.hidden=0`;
      const params = [meId, now()];
      sql += ' AND NOT EXISTS (SELECT 1 FROM hidden_videos hv WHERE hv.user_id=? AND hv.video_id=v.id)';
      params.push(meId);
      sql += blockFilter('v');
      params.push(meId, meId);
      const vf = visFilter('v', meId);
      sql += vf.clause; params.push(...vf.params);
      // PARITÉ TIKTOK 2026-10-04 : mode restreint → le contenu sensible est filtré du feed
      if (restricted) { sql += ' AND v.sensitive=0'; }
      sql += ' ORDER BY v.created_at DESC LIMIT 50 OFFSET ' + (off * 50);
      rows = await allRows(sql, ...params);
      has_more = rows.length >= 50;
      // v2.35 : les reposts des comptes suivis apparaissent dans le fil « Suivis » (avec attribution)
      try {
        const rp = ['SELECT v.*, r.user_id AS reposter_id, r.created_at AS reposted_at FROM reposts r',
          'JOIN videos v ON v.id=r.video_id JOIN follows f ON f.followed_id=r.user_id',
          'WHERE f.follower_id=? AND (v.scheduled_at IS NULL OR v.scheduled_at <= ?) AND v.hidden=0',
          'AND NOT EXISTS (SELECT 1 FROM hidden_videos hv WHERE hv.user_id=? AND hv.video_id=v.id)'];
        const rpar = [meId, now(), meId];
        rp.push(blockFilter('v')); rpar.push(meId, meId);
        rp.push(blockFilter('r')); rpar.push(meId, meId);
        const rvf = visFilter('v', meId); rp.push(rvf.clause); rpar.push(...rvf.params);
        if (restricted) { rp.push('AND v.sensitive=0'); }
        rp.push('ORDER BY r.created_at DESC LIMIT 50 OFFSET ' + (off * 50));
        const rpRows = await allRows(rp.join(' '), ...rpar);
        if (rpRows.length) {
          const seen = new Set(rows.map(x => x.id));
          for (const r of rpRows) if (!seen.has(r.id)) { seen.add(r.id); rows.push(r); }
          rows.sort((a, b) => Number(b.reposted_at || b.created_at) - Number(a.reposted_at || a.created_at));
          rows = rows.slice(0, 60);
        }
      } catch (e) { /* le fil suivi reste disponible même si l'injection reposts échoue */ }
    } else {
      let sql = 'SELECT * FROM videos WHERE (scheduled_at IS NULL OR scheduled_at <= ?) AND hidden=0';
      const params = [now()];
      if (meId) {
        sql += ' AND NOT EXISTS (SELECT 1 FROM hidden_videos hv WHERE hv.user_id=? AND hv.video_id=videos.id)';
        params.push(meId);
        sql += blockFilter('videos');
        params.push(meId, meId);
      }
      const vf = visFilter('videos', meId);
      sql += vf.clause; params.push(...vf.params);
      // PARITÉ TIKTOK 2026-10-04 : mode restreint → le contenu sensible est filtré du feed
      if (restricted) { sql += ' AND videos.sensitive=0'; }
      if (meId) {
        // v12 : utilisateurs connectés → score personnalisé « Pour toi »
        pageSize = 200;
        sql += ' ORDER BY created_at DESC LIMIT 200 OFFSET ' + (off * 200);
        const rawRows = await allRows(sql, ...params);
        has_more = rawRows.length >= 200;
        rows = await scoreForYou(rawRows, meId);
      } else {
        sql += ' ORDER BY created_at DESC LIMIT 50 OFFSET ' + (off * 50);
        rows = await allRows(sql, ...params);
        has_more = rows.length >= 50;
      }
    }
    const videos = [];
    // v2.48 (SPEC-03) : hashtags suivis → marqueur via_hashtag sur les vidéos correspondantes
    let followedTags = new Set();
    if (meId) {
      try {
        const ft = await allRows('SELECT tag FROM hashtag_follows WHERE user_id=?', meId);
        for (const r of ft) followedTags.add(String(r.tag).toLowerCase());
      } catch (e) {}
    }
    for (const v of rows) {
      const j = await videoJSON(v, meId);
      if (!j) continue;
      // v2.35 : attribution du repost (fil « Suivis »)
      if (v.reposter_id && Number(v.reposter_id) !== Number(meId)) {
        const ru = await get1('SELECT id, username, name FROM users WHERE id=?', v.reposter_id);
        if (ru) j.reposted_by = { id: ru.id, username: ru.username, name: ru.name };
      }
      if (followedTags.size) {
        try {
          const vt = extractTags((v.description || '') + ' ' + (v.tags || ''));
          const hit = vt.find(t => followedTags.has(String(t).toLowerCase()));
          if (hit) j.via_hashtag = '#' + hit;
        } catch (e) {}
      }
      videos.push(j);
    }
    res.json({ mode, videos, page, has_more });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});

// mes vidéos, y compris celles programmées (avec leur scheduled_at)
app.get('/api/videos/mine', auth, async (req, res) => {
  try {
    // PAGINATION 2026-10-04 : ?page=N (30/page)
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const rows = await allRows('SELECT * FROM videos WHERE user_id=? ORDER BY created_at DESC LIMIT 30 OFFSET ' + ((page - 1) * 30), req.userId);
    const videos = [];
    for (const v of rows) {
      const j = await videoJSON(v, req.userId);
      if (!j) continue;
      j.scheduled_at = v.scheduled_at ? Number(v.scheduled_at) : null;
      videos.push(j);
    }
    res.json({ videos, page, has_more: rows.length >= 30 });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// v1.57 : statistiques détaillées d'une vidéo (propriétaire uniquement) — style TikTok Studio
app.get('/api/videos/:id/stats', auth, async (req, res) => {
  try {
    const vid = Number(req.params.id);
    const v = await get1('SELECT * FROM videos WHERE id=?', vid);
    if (!v) return res.status(404).json({ error: 'vidéo introuvable' });
    if (Number(v.user_id) !== Number(req.userId))
      return res.status(403).json({ error: 'réservé au créateur' });
    const views = (await get1('SELECT COUNT(*) AS c FROM video_views WHERE video_id=?', vid)).c || 0;
    const likes = (await get1('SELECT COUNT(*) AS c FROM likes WHERE video_id=?', vid)).c || 0;
    const comments = (await get1('SELECT COUNT(*) AS c FROM comments WHERE video_id=?', vid)).c || 0;
    const shares = Number(v.shares) || 0;
    const w = await get1('SELECT COUNT(*) AS n, AVG(watch_ms) AS avg_ms, SUM(completed) AS comp FROM watch_events WHERE video_id=?', vid);
    const watchN = Number(w.n) || 0;
    const avgWatchS = watchN ? Math.round((Number(w.avg_ms) || 0) / 1000) : 0;
    const completionPct = watchN ? Math.round(100 * (Number(w.comp) || 0) / watchN) : 0;
    // vues par jour (7 derniers jours)
    const dayMs = 86400000, t0 = now() - 7 * dayMs, perDay = [];
    for (let d = 0; d < 7; d++) {
      const a = t0 + d * dayMs, b = a + dayMs;
      const c = (await get1('SELECT COUNT(*) AS c FROM video_views WHERE video_id=? AND created_at>=? AND created_at<?', vid, a, b)).c || 0;
      perDay.push({ day: new Date(a).toISOString().slice(0, 10), views: c });
    }
    // nouveaux abonnés gagnés via cette vidéo (follows après sa publication)
    const newFollows = (await get1(
      'SELECT COUNT(*) AS c FROM follows WHERE followed_id=? AND created_at>=?', v.user_id, Number(v.created_at))).c || 0;
    res.json({ stats: { views, likes, comments, shares, watch_events: watchN,
      avg_watch_s: avgWatchS, completion_pct: completionPct, per_day: perDay, new_follows: newFollows } });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// PARITÉ TIKTOK 2026-10-04 : format attendu par openVideoAnalytics() côté app
app.get('/api/videos/:id/analytics', auth, async (req, res) => {
  try {
    const vid = Number(req.params.id);
    const v = await get1('SELECT * FROM videos WHERE id=?', vid);
    if (!v) return res.status(404).json({ error: 'vidéo introuvable' });
    if (Number(v.user_id) !== Number(req.userId))
      return res.status(403).json({ error: 'réservé au créateur' });
    const views = (await get1('SELECT COUNT(*) AS c FROM video_views WHERE video_id=?', vid)).c || 0;
    const likes = (await get1('SELECT COUNT(*) AS c FROM likes WHERE video_id=?', vid)).c || 0;
    const comments = (await get1('SELECT COUNT(*) AS c FROM comments WHERE video_id=?', vid)).c || 0;
    const shares = Number(v.shares) || 0;
    const w = await get1('SELECT AVG(watch_ms) AS avg_ms FROM watch_events WHERE video_id=?', vid);
    const avgS = Math.round((Number((w && w.avg_ms) || 0)) / 1000);
    const avg_watch = avgS >= 60 ? Math.floor(avgS / 60) + 'm ' + (avgS % 60) + 's' : avgS + ' s';
    let top_country = '—';
    try {
      const tc = await get1(`SELECT UPPER(u.country) AS c, COUNT(*) AS n FROM video_views vv
        JOIN users u ON u.id=vv.viewer_id WHERE vv.video_id=? AND u.country IS NOT NULL AND u.country<>''
        GROUP BY c ORDER BY n DESC LIMIT 1`, vid);
      if (tc && tc.c) top_country = tc.c;
    } catch (e) {}
    // v2.39 : courbe des vues heure par heure (24 dernières heures) — index 23 = heure courante
    const views_by_hour = new Array(24).fill(0);
    try {
      const nowMs = now();
      const rows24 = await allRows('SELECT created_at FROM video_views WHERE video_id=? AND created_at>=?', vid, nowMs - 24 * 3600 * 1000);
      for (const r of rows24) {
        const diff = nowMs - Number(r.created_at);
        if (diff < 0 || diff >= 24 * 3600 * 1000) continue;
        const idx = 23 - Math.floor(diff / 3600000);
        views_by_hour[idx]++;
      }
    } catch (e) {}
    // v2.39 : répartition du trafic par source
    const traffic = { feed: 0, foryou: 0, following: 0, search: 0, profile: 0, deeplink: 0, other: 0 };
    try {
      const tr = await allRows('SELECT source, COUNT(*) AS n FROM video_views WHERE video_id=? GROUP BY source', vid);
      for (const r of tr) {
        const k = String(r.source || 'feed').toLowerCase();
        if (k in traffic) traffic[k] += Number(r.n) || 0;
      }
    } catch (e) {}
    // v2.48 (SPEC analytics-pro) : traffic_sources + top_source (depuis video_view_sources, repli sur video_views)
    let traffic_sources = { ...traffic };
    try {
      const ts = await allRows('SELECT source, COUNT(*) AS n FROM video_view_sources WHERE video_id=? GROUP BY source', vid);
      if (ts.length) {
        traffic_sources = { feed: 0, foryou: 0, following: 0, search: 0, profile: 0, deeplink: 0, other: 0 };
        for (const r of ts) {
          const k = String(r.source || 'other').toLowerCase();
          if (k in traffic_sources) traffic_sources[k] += Number(r.n) || 0;
          else traffic_sources.other += Number(r.n) || 0;
        }
      }
    } catch (e) {}
    let top_source = 'other', top_n = -1;
    for (const [k, n] of Object.entries(traffic_sources)) { if (n > top_n) { top_n = n; top_source = k; } }
    // v2.48 (SPEC analytics-pro) : courbe de rétention à la seconde depuis watch_events
    // % de spectateurs ayant regardé >= chaque seconde ; échantillonnage adaptatif (≤300 points)
    let retention_curve = [];
    try {
      const dur = Number(v.duration) || 0;
      if (dur > 0) {
        const mx = await allRows('SELECT user_id, MAX(watch_ms) AS m FROM watch_events WHERE video_id=? GROUP BY user_id', vid);
        const total = mx.length;
        if (total) {
          const pts = Math.min(300, dur);
          const step = Math.max(1, Math.floor(dur / pts));
          for (let s = step; s <= dur; s += step) {
            const n = mx.filter(r => Number(r.m) >= s * 1000).length;
            retention_curve.push({ second: s, pct: Math.round(n / total * 1000) / 10 });
          }
        }
      }
    } catch (e) {}
    res.json({ views, likes, comments, shares, avg_watch, top_country, views_by_hour, traffic,
      traffic_sources, top_source, retention_curve });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// ---------- v2.39 : démographie des spectateurs (créateur uniquement) ----------
// Âge calculé depuis users.birthdate (YYYY-MM-DD) ; spectateurs distincts de video_views.
app.get('/api/videos/:id/demographics', auth, async (req, res) => {
  try {
    const vid = Number(req.params.id);
    const v = await get1('SELECT * FROM videos WHERE id=?', vid);
    if (!v) return res.status(404).json({ error: 'vidéo introuvable' });
    if (Number(v.user_id) !== Number(req.userId))
      return res.status(403).json({ error: 'réservé au créateur' });
    const viewers = await allRows(
      `SELECT vv.viewer_id AS uid, u.birthdate AS birthdate, u.gender AS gender, u.country AS country
       FROM video_views vv JOIN users u ON u.id=vv.viewer_id
       WHERE vv.video_id=? AND vv.viewer_id IS NOT NULL GROUP BY vv.viewer_id`, vid);
    const age = { '13-17': 0, '18-24': 0, '25-34': 0, '35-44': 0, '45+': 0 };
    const gender = {};
    const countries = {};
    const d = new Date(now());
    const y = d.getUTCFullYear(), mo = d.getUTCMonth() + 1, dy = d.getUTCDate();
    for (const vw of viewers) {
      const m = String(vw.birthdate || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (m) {
        let a = y - Number(m[1]);
        if (mo < Number(m[2]) || (mo === Number(m[2]) && dy < Number(m[3]))) a--;
        if (a >= 13) {
          const b = a <= 17 ? '13-17' : a <= 24 ? '18-24' : a <= 34 ? '25-34' : a <= 44 ? '35-44' : '45+';
          age[b]++;
        }
      }
      const g = String(vw.gender || '').trim().toLowerCase() || 'unknown';
      gender[g] = (gender[g] || 0) + 1;
      const c = String(vw.country || '').trim().toUpperCase() || 'unknown';
      countries[c] = (countries[c] || 0) + 1;
    }
    res.json({ age, gender, countries });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// ---------- v2.39 : courbe de rétention (créateur uniquement) ----------
// Pourcentage de spectateurs ayant regardé >= 25/50/75/100 % de la vidéo
// (max watch_ms par spectateur vs videos.duration en secondes). duration=0 → null.
app.get('/api/videos/:id/retention', auth, async (req, res) => {
  try {
    const vid = Number(req.params.id);
    const v = await get1('SELECT * FROM videos WHERE id=?', vid);
    if (!v) return res.status(404).json({ error: 'vidéo introuvable' });
    if (Number(v.user_id) !== Number(req.userId))
      return res.status(403).json({ error: 'réservé au créateur' });
    const dur = Number(v.duration) || 0;
    if (!dur) return res.json({ r25: null, r50: null, r75: null, r100: null });
    const rows = await allRows('SELECT user_id, MAX(watch_ms) AS m FROM watch_events WHERE video_id=? GROUP BY user_id', vid);
    const total = rows.length;
    const pct = (t) => {
      if (!total) return 0;
      const n = rows.filter(r => Number(r.m) >= dur * 1000 * t).length;
      return Math.round(n / total * 1000) / 10;
    };
    res.json({ r25: pct(0.25), r50: pct(0.5), r75: pct(0.75), r100: pct(1) });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// ---------- v2.48 SPEC-05 : chapitres vidéo ----------
// PUT remplace la liste complète (validation : 1er à 0, max CHAPTER_LIMIT, ordre croissant, créateur seul)
app.put('/api/videos/:id/chapters', auth, async (req, res) => {
  try {
    const vid = Number(req.params.id);
    const v = await get1('SELECT * FROM videos WHERE id=?', vid);
    if (!v) return res.status(404).json({ error: 'vidéo introuvable' });
    if (Number(v.user_id) !== Number(req.userId))
      return res.status(403).json({ error: 'réservé au créateur' });
    const list = Array.isArray((req.body || {}).chapters) ? req.body.chapters : [];
    if (list.length > CHAPTER_LIMIT)
      return res.status(400).json({ error: 'maximum ' + CHAPTER_LIMIT + ' chapitres par vidéo' });
    const dur = Number(v.duration) || 0;
    const clean = [];
    for (const c of list) {
      const title = String((c && c.title) || '').trim().slice(0, 100);
      const sec = Math.floor(Number(c && c.starts_at_sec));
      if (!title || !Number.isFinite(sec) || sec < 0) return res.status(400).json({ error: 'chapitre invalide (titre + starts_at_sec requis)' });
      if (dur && sec > dur) return res.status(400).json({ error: 'le chapitre dépasse la durée de la vidéo' });
      clean.push({ title, starts_at_sec: sec });
    }
    clean.sort((a, b) => a.starts_at_sec - b.starts_at_sec);
    for (let i = 1; i < clean.length; i++)
      if (clean[i].starts_at_sec <= clean[i - 1].starts_at_sec)
        return res.status(400).json({ error: 'les chapitres doivent être en ordre croissant' });
    if (clean.length && clean[0].starts_at_sec !== 0)
      return res.status(400).json({ error: 'le premier chapitre doit commencer à 0' });
    await runSql('DELETE FROM video_chapters WHERE video_id=?', vid);
    for (const c of clean)
      await runSql('INSERT INTO video_chapters(video_id,title,starts_at_sec,created_at) VALUES(?,?,?,?)',
        vid, c.title, c.starts_at_sec, now());
    res.json({ ok: true, chapters: clean });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.get('/api/videos/:id/chapters', async (req, res) => {
  try {
    const vid = Number(req.params.id);
    const rows = await allRows('SELECT title, starts_at_sec FROM video_chapters WHERE video_id=? ORDER BY starts_at_sec ASC', vid);
    res.json({ ok: true, chapters: rows.map(r => ({ title: r.title, starts_at_sec: Number(r.starts_at_sec) })) });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.delete('/api/videos/:id/chapters', auth, async (req, res) => {
  try {
    const vid = Number(req.params.id);
    const v = await get1('SELECT * FROM videos WHERE id=?', vid);
    if (!v) return res.status(404).json({ error: 'vidéo introuvable' });
    if (Number(v.user_id) !== Number(req.userId))
      return res.status(403).json({ error: 'réservé au créateur' });
    await runSql('DELETE FROM video_chapters WHERE video_id=?', vid);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// ---------- v2.48 SPEC-07 : premieres (sorties planifiées + compte à rebours) ----------
// POST/DELETE/GET /api/videos/:id/premiere — remind : /api/videos/:id/premiere/remind
// liste publique : GET /api/premieres/upcoming — chat éphémère : room premiere:<video_id>
app.post('/api/videos/:id/premiere', auth, async (req, res) => {
  try {
    const vid = Number(req.params.id);
    const v = await get1('SELECT * FROM videos WHERE id=?', vid);
    if (!v) return res.status(404).json({ error: 'vidéo introuvable' });
    if (Number(v.user_id) !== Number(req.userId))
      return res.status(403).json({ error: 'réservé au créateur' });
    const scheduled_at = Number((req.body || {}).scheduled_at);
    if (!scheduled_at || scheduled_at <= now())
      return res.status(400).json({ error: 'date de sortie future requise' });
    const ex = await get1('SELECT 1 FROM premieres WHERE video_id=?', vid);
    if (ex) return res.status(400).json({ error: 'premiere déjà programmée' });
    // limite anti-spam : max 3 premieres à venir par créateur
    const n = await get1(`SELECT COUNT(*) AS c FROM premieres WHERE creator_id=? AND status='scheduled' AND scheduled_at>?`, req.userId, now());
    if (Number(n.c) >= PREMIERE_LIMIT_PER_CREATOR)
      return res.status(400).json({ error: 'limite de 3 premieres à venir atteinte' });
    await runSql('INSERT INTO premieres(video_id,creator_id,scheduled_at,status,created_at) VALUES(?,?,?,\'scheduled\',?)',
      vid, req.userId, scheduled_at, now());
    await runSql('UPDATE videos SET scheduled_at=? WHERE id=?', scheduled_at, vid);
    res.json({ ok: true, scheduled_at });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.delete('/api/videos/:id/premiere', auth, async (req, res) => {
  try {
    const vid = Number(req.params.id);
    const p = await get1('SELECT * FROM premieres WHERE video_id=?', vid);
    if (!p) return res.status(404).json({ error: 'premiere introuvable' });
    if (Number(p.creator_id) !== Number(req.userId))
      return res.status(403).json({ error: 'réservé au créateur' });
    await runSql('DELETE FROM premiere_reminders WHERE video_id=?', vid);
    await runSql('DELETE FROM premieres WHERE video_id=?', vid);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.get('/api/videos/:id/premiere', async (req, res) => {
  try {
    const vid = Number(req.params.id);
    const p = await get1(
      `SELECT p.*, v.description, u.username AS creator FROM premieres p
       JOIN videos v ON v.id=p.video_id JOIN users u ON u.id=p.creator_id WHERE p.video_id=?`, vid);
    if (!p) return res.json({ ok: false });
    const meId = await optUserId(req);
    const reminded = meId ? !!(await get1('SELECT 1 FROM premiere_reminders WHERE video_id=? AND user_id=?', vid, meId)) : false;
    const rc = await get1('SELECT COUNT(*) AS c FROM premiere_reminders WHERE video_id=?', vid);
    res.json({ ok: true, premiere: {
      video_id: p.video_id, scheduled_at: Number(p.scheduled_at), status: p.status,
      creator: p.creator, description: p.description || '',
      countdown_ms: Math.max(0, Number(p.scheduled_at) - now()),
      reminded, reminder_count: Number(rc.c) || 0 } });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.post('/api/videos/:id/premiere/remind', auth, async (req, res) => {
  try {
    const vid = Number(req.params.id);
    const p = await get1('SELECT 1 FROM premieres WHERE video_id=?', vid);
    if (!p) return res.status(404).json({ error: 'premiere introuvable' });
    await insertIgnore('INSERT OR IGNORE INTO premiere_reminders(video_id,user_id,created_at) VALUES(?,?,?)',
      vid, req.userId, now());
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.delete('/api/videos/:id/premiere/remind', auth, async (req, res) => {
  try {
    await runSql('DELETE FROM premiere_reminders WHERE video_id=? AND user_id=?', Number(req.params.id), req.userId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.get('/api/premieres/upcoming', async (req, res) => {
  try {
    const meId = await optUserId(req);
    const rows = await allRows(
      `SELECT p.video_id, p.scheduled_at, p.status, p.creator_id, u.username AS creator, v.description
       FROM premieres p JOIN users u ON u.id=p.creator_id JOIN videos v ON v.id=p.video_id
       WHERE p.status='scheduled' AND p.scheduled_at>? AND v.hidden=0 ORDER BY p.scheduled_at ASC LIMIT 50`, now());
    const out = [];
    for (const r of rows) {
      const reminded = meId ? !!(await get1('SELECT 1 FROM premiere_reminders WHERE video_id=? AND user_id=?', r.video_id, meId)) : false;
      out.push({ video_id: r.video_id, scheduled_at: Number(r.scheduled_at), creator_id: r.creator_id,
        creator: r.creator, description: r.description || '', reminded,
        countdown_ms: Math.max(0, Number(r.scheduled_at) - now()) });
    }
    res.json({ ok: true, premieres: out });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// chat éphémère de la premiere — room premiere:<video_id>
app.get('/api/videos/:id/premiere/chat', async (req, res) => {
  try {
    const room = 'premiere:' + Number(req.params.id);
    const rows = await allRows(
      `SELECT c.*, u.username FROM premiere_chat c LEFT JOIN users u ON u.id=c.user_id
       WHERE c.video_id=? ORDER BY c.created_at DESC LIMIT 50`, Number(req.params.id));
    res.json({ ok: true, room, messages: rows.reverse() });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.post('/api/videos/:id/premiere/chat', auth, async (req, res) => {
  try {
    const vid = Number(req.params.id);
    const room = 'premiere:' + vid; // room éphémère premiere:<video_id>
    const text = String((req.body || {}).text || '').trim().slice(0, 300);
    if (!text) return res.status(400).json({ error: 'message vide' });
    const p = await get1('SELECT 1 FROM premieres WHERE video_id=?', vid);
    if (!p) return res.status(404).json({ error: 'premiere introuvable' });
    await runSql('INSERT INTO premiere_chat(video_id,user_id,text,created_at) VALUES(?,?,?,?)', vid, req.userId, text, now());
    res.json({ ok: true, room });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.get('/api/videos/:id', async (req, res) => {
  const v = await get1('SELECT * FROM videos WHERE id=?', req.params.id);
  if (!v) return res.status(404).json({ error: 'vidéo introuvable' });
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer (.+)$/);
  let meId = null;
  if (m) { const t = await get1('SELECT user_id FROM tokens WHERE token=?', m[1]); if (t) meId = t.user_id; }
  // vidéo programmée ou masquée par la modération : seul le propriétaire peut la voir
  if ((v.scheduled_at && Number(v.scheduled_at) > now()) || Number(v.hidden)) {
    if (!meId || Number(meId) !== Number(v.user_id)) return res.status(404).json({ error: 'vidéo introuvable' });
  }
  // visibilité : public | subscribers | private
  if (!(await canSeeVideo(v, meId))) return res.status(404).json({ error: 'vidéo introuvable' });
  res.json({ video: await videoJSON(v, meId) });
});
// ============================================================
// v2.48 — fin d'implémentation SPEC-01 / 04 / 08 / 09 / 10 (2026-10-05)
// ============================================================
const NUDGE_MIN_INTERVAL_MS = 48 * 3600000; // SPEC-08 : plafond anti-spam ABSOLU = 1 nudge / 48h
const NUDGE_KINDS = ['winback', 'creator_idle', 'streak_risk', 'quest_idle', 'follower_milestone'];
const NUDGE_PRIORITY = { streak_risk: 0, follower_milestone: 1, creator_idle: 2, quest_idle: 3, winback: 4 };
const LANG_ALLOW = ['fr','en','es','ht','pt','de','it','nl','ar','he','fa','ur','zh','hi','bn','ru','ja','ko','tr','sw','yo','ig','ha','zu','am','vi','th','id','ms','tl','pl','uk','ro','el','hu','cs','sv','no','da','fi','ca','gl'];

// ---------- v2.48 SPEC-01 : bibliothèque hors-ligne gérée ----------
// POST enregistre le téléchargement (body {file_size}) ; DELETE le retire ; GET liste.
app.post('/api/videos/:id/offline-track', auth, async (req, res) => {
  try {
    const vid = Number(req.params.id);
    const v = await get1('SELECT * FROM videos WHERE id=?', vid);
    if (!v) return res.status(404).json({ error: 'vidéo introuvable' });
    if (Number(v.allow_download) === 0) return res.status(403).json({ error: 'téléchargement désactivé par le créateur' });
    if (!(await canSeeVideo(v, req.userId))) return res.status(403).json({ error: 'vidéo non accessible' });
    const rc = await get1('SELECT COUNT(*) AS n FROM offline_downloads WHERE user_id=? AND created_at>?', req.userId, now() - 3600000);
    if ((rc.n || 0) >= 30) return res.status(429).json({ error: 'trop de téléchargements, réessaie dans une heure' });
    const cnt = await get1('SELECT COUNT(*) AS n FROM offline_downloads WHERE user_id=?', req.userId);
    if ((cnt.n || 0) >= OFFLINE_QUOTA) return res.status(409).json({ error: 'quota hors-ligne atteint (' + OFFLINE_QUOTA + ' vidéos max)' });
    const fileSize = Math.max(0, Math.floor(Number((req.body || {}).file_size) || 0));
    await runSql('INSERT INTO offline_downloads(user_id,video_id,file_size,created_at) VALUES(?,?,?,?)', req.userId, vid, fileSize, now())
      .catch(() => runSql('INSERT OR IGNORE INTO offline_downloads(user_id,video_id,created_at) VALUES(?,?,?)', req.userId, vid, now()));
    const tot = await get1('SELECT COUNT(*) AS n, COALESCE(SUM(file_size),0) AS s FROM offline_downloads WHERE user_id=?', req.userId);
    res.json({ ok: true, count: tot.n || 0, total_size: tot.s || 0 });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.delete('/api/videos/:id/offline-track', auth, async (req, res) => {
  try {
    await runSql('DELETE FROM offline_downloads WHERE user_id=? AND video_id=?', req.userId, Number(req.params.id));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.get('/api/offline/list', auth, async (req, res) => {
  try {
    const rows = await allRows(
      `SELECT o.video_id AS id, o.file_size, o.created_at AS downloaded_at, v.description AS d, NULL AS thumb, v.file AS url, v.duration
       FROM offline_downloads o JOIN videos v ON v.id=o.video_id
       WHERE o.user_id=? AND (v.hidden IS NULL OR v.hidden=0)
         AND (v.scheduled_at IS NULL OR v.scheduled_at<=?)
       ORDER BY o.created_at DESC LIMIT 60`, req.userId, now());
    const tot = await get1('SELECT COUNT(*) AS n, COALESCE(SUM(file_size),0) AS s FROM offline_downloads WHERE user_id=?', req.userId);
    res.json({ ok: true, videos: rows.map(r => ({ id: r.id, desc: r.d, thumb: r.thumb, url: r.url, duration: Number(r.duration) || 0, downloaded_at: Number(r.downloaded_at), file_size: Number(r.file_size) || 0 })), total_size: tot.s || 0, count: tot.n || 0, quota: OFFLINE_QUOTA });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});

// ---------- v2.48 SPEC-04 : traduction auto des descriptions (fournisseur gratuit MyMemory) ----------
app.get('/api/videos/:id/translate', auth, async (req, res) => {
  try {
    const vid = Number(req.params.id);
    const lang = String(req.query.lang || '').toLowerCase().slice(0, 5);
    if (!LANG_ALLOW.includes(lang)) return res.status(400).json({ error: 'langue non supportée' });
    const v = await get1('SELECT * FROM videos WHERE id=?', vid);
    if (!v) return res.status(404).json({ error: 'vidéo introuvable' });
    const desc = String(v.description || '').trim();
    if (!desc) return res.status(400).json({ error: 'rien à traduire' });
    const srcLang = String(v.lang || 'fr');
    if (lang === srcLang) return res.status(400).json({ error: 'même langue' });
    const source_hash = crypto.createHash('sha1').update('vg:' + desc).digest('hex');
    const THIRTY_D = 30 * 86400000;
    const cached = await get1('SELECT * FROM video_translations WHERE video_id=? AND lang=?', vid, lang);
    if (cached && cached.source_hash === source_hash && Number(cached.created_at) > now() - THIRTY_D)
      return res.json({ ok: true, translated_desc: cached.text, cached: true, auto: true });
    // quota 100 traductions/jour/utilisateur
    const day = new Date().toISOString().slice(0, 10);
    const q = await get1('SELECT count FROM translation_quota WHERE user_id=? AND day=?', req.userId, day);
    if (q && Number(q.count) >= TRANSLATE_QUOTA) return res.status(429).json({ error: 'quota de traductions atteint pour aujourd\'hui' });
    // fournisseur gratuit MyMemory (5 000 mots/jour, sans clé), timeout 8 s
    const toTranslate = desc.slice(0, 500);
    const mymemoryUrl = 'https://api.mymemory.translated.net/get?q=' + encodeURIComponent(toTranslate) + '&langpair=' + encodeURIComponent(srcLang + '|' + lang);
    let translated = null;
    try {
      const ctl = new AbortController();
      const to = setTimeout(() => ctl.abort(), 8000);
      const r = await fetch(mymemoryUrl, { signal: ctl.signal });
      clearTimeout(to);
      const j = await r.json();
      translated = j && j.responseData && j.responseData.translatedText;
      if (translated && /MYMEMORY WARNING|QUERY LENGTH LIMIT/i.test(translated)) translated = null;
    } catch (_) {}
    if (!translated) return res.status(503).json({ error: 'traduction indisponible pour le moment' });
    await runSql('DELETE FROM video_translations WHERE video_id=? AND lang=?', vid, lang);
    await runSql('INSERT INTO video_translations(video_id,lang,text,source_hash,created_at) VALUES(?,?,?,?,?)', vid, lang, translated, source_hash, now());
    try {
      if (USE_PG) await runSql('INSERT INTO translation_quota(user_id,day,count) VALUES(?,?,1) ON CONFLICT(user_id,day) DO UPDATE SET count=translation_quota.count+1', req.userId, day);
      else await runSql('INSERT INTO translation_quota(user_id,day,count) VALUES(?,?,1) ON CONFLICT(user_id,day) DO UPDATE SET count=count+1', req.userId, day);
    } catch (_) { await runSql('UPDATE translation_quota SET count=count+1 WHERE user_id=? AND day=?', req.userId, day); }
    res.json({ ok: true, translated_desc: translated, cached: false, auto: true });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});

// ---------- v2.48 SPEC-08 : rappels intelligents de rétention ----------
function nudgeText(kind, meta) {
  const m = meta || {};
  switch (kind) {
    case 'winback': return { title: '👋 VidiGagne te manque ?', text: 'Tes créateurs préférés ont publié 👀', deep: 'home' };
    case 'creator_idle': return { title: '🎬 Tes abonnés t\'attendent', text: 'Ça fait un moment… ta prochaine vidéo ?', deep: 'camera' };
    case 'streak_risk': return { title: '🔥 Ta flamme va s\'éteindre !', text: 'Envoie un message à @' + (m.with_username || 'ton ami') + ' pour garder la flamme 🔥', deep: 'chat:' + (m.with_id || '') };
    case 'quest_idle': return { title: '🎯 Ta quête du jour t\'attend', text: 'Encore quelques pièces à gagner aujourd\'hui !', deep: 'quests' };
    case 'follower_milestone': return { title: '🎉 ' + (m.count || '') + ' abonnés !', text: 'Félicitations, continue comme ça 🚀', deep: 'profile' };
    default: return { title: 'VidiGagne', text: 'Viens voir ce qui se passe 👀', deep: 'home' };
  }
}
async function queueNudge(userId, kind, meta) {
  // anti-doublon naturel : même kind déjà programmé/envoyé cette semaine → on skip
  const wk = await get1('SELECT id FROM retention_nudges WHERE user_id=? AND kind=? AND created_at>?', userId, kind, now() - 7 * 86400000);
  if (wk) return false;
  // plafond ABSOLU : max 1 nudge / 48h tous kinds confondus (même si le scheduler tourne 2×)
  const recent = await get1('SELECT id FROM retention_nudges WHERE user_id=? AND created_at>?', userId, now() - NUDGE_MIN_INTERVAL_MS);
  if (recent) return false;
  const u = await get1('SELECT nudge_optout, tz_offset FROM users WHERE id=?', userId);
  if (!u || Number(u.nudge_optout) === 1) return false;
  const t = nudgeText(kind, meta || {});
  // heures creuses : jamais de push 23h-7h heure locale (tz_offset en minutes) → différé à 8h
  let sendAt = now();
  try {
    const localMs = sendAt + Number(u.tz_offset || 0) * 60000;
    const h = new Date(localMs).getUTCHours();
    if (h >= 23 || h < 7) sendAt = sendAt + ((8 - h + 24) % 24) * 3600000;
  } catch (_) {}
  const id = await insertId('INSERT INTO retention_nudges(user_id,kind,meta,scheduled_at,created_at) VALUES(?,?,?,?,?)',
    userId, kind, JSON.stringify(meta || {}), sendAt, now());
  try {
    await insertId('INSERT INTO notifications(user_id,type,title,text,is_read,created_at) VALUES(?,?,?,?,0,?)',
      userId, 'nudge_' + kind, t.title, t.text + ' §deep=' + t.deep + '§nudge=' + id, now());
  } catch (_) {}
  return true;
}
// évaluation quotidienne (appelée par le scheduler)
async function evaluateNudges() {
  try {
    const t = now(), D = 86400000;
    // winback : inscrit depuis ≥3 j, rien vu depuis 72h, pas de winback depuis 30 j
    try {
      const rows = await allRows(`SELECT id FROM users WHERE created_at<? AND COALESCE(last_seen,created_at)<? AND COALESCE(nudge_optout,0)=0
        AND NOT EXISTS(SELECT 1 FROM retention_nudges WHERE user_id=users.id AND kind='winback' AND created_at>?) LIMIT 300`,
        t - 3 * D, t - 72 * 3600000, t - 30 * D);
      for (const r of rows) await queueNudge(r.id, 'winback', {});
    } catch (_) {}
    // creator_idle : ≥1 vidéo un jour, 0 publication depuis 7 j, ≥10 abonnés
    try {
      const rows = await allRows(`SELECT v.user_id AS id FROM videos v LEFT JOIN follows f ON f.followed_id=v.user_id
        GROUP BY v.user_id HAVING MAX(v.created_at)<? AND COUNT(DISTINCT f.follower_id)>=10 LIMIT 200`, t - 7 * D);
      for (const r of rows) {
        const u = await get1('SELECT nudge_optout FROM users WHERE id=?', r.id);
        if (u && !Number(u.nudge_optout)) await queueNudge(r.id, 'creator_idle', {});
      }
    } catch (_) {}
    // streak_risk (SPEC-06) : flamme allumée hier, aucun échange aujourd'hui
    try {
      const y = new Date(t - D).toISOString().slice(0, 10), today = new Date(t).toISOString().slice(0, 10);
      const rows = await allRows(`SELECT user_a, user_b FROM friendship_streaks WHERE last_day=? AND streak>0 LIMIT 300`, y);
      for (const r of rows) {
        for (const uid of [r.user_a, r.user_b]) {
          const other = Number(uid) === Number(r.user_a) ? r.user_b : r.user_a;
          const cur = await get1('SELECT last_day FROM friendship_streaks WHERE user_a=? AND user_b=?', Math.min(r.user_a, r.user_b), Math.max(r.user_a, r.user_b));
          if (!cur || cur.last_day !== today) {
            const ou = await get1('SELECT username FROM users WHERE id=?', other);
            await queueNudge(uid, 'streak_risk', { with_id: other, with_username: ou ? ou.username : 'ami' });
          }
        }
      }
    } catch (_) {}
    // quest_idle : quête quotidienne non réclamée (21h locales passées)
    try {
      const day = new Date(t).toISOString().slice(0, 10);
      const rows = await allRows(`SELECT id FROM users WHERE COALESCE(nudge_optout,0)=0 AND last_seen>? AND id NOT IN(SELECT user_id FROM quest_claims WHERE day=?) LIMIT 300`, t - D, day);
      for (const r of rows) await queueNudge(r.id, 'quest_idle', {});
    } catch (_) {}
    // follower_milestone : paliers 100 / 1 000 / 10 000 franchis cette semaine, non célébrés
    try {
      for (const palier of [100, 1000, 10000]) {
        const rows = await allRows(`SELECT followed_id AS id, COUNT(*) AS c FROM follows WHERE created_at>? GROUP BY followed_id HAVING COUNT(*)>=? LIMIT 200`, t - 7 * D, palier);
        for (const r of rows) await queueNudge(r.id, 'follower_milestone', { count: palier });
      }
    } catch (_) {}
    // envoi des nudges programmés arrivés à échéance (via la file de notifs existante si FCM, sinon table notifications déjà remplie)
    await runSql('UPDATE retention_nudges SET sent_at=? WHERE sent_at IS NULL AND scheduled_at<=?', t, t);
  } catch (e) { console.error('evaluateNudges:', e.message); }
}
app.get('/api/me/nudges', auth, async (req, res) => {
  try {
    const rows = await allRows('SELECT id, kind, meta, created_at, sent_at, opened_at FROM retention_nudges WHERE user_id=? AND created_at>? ORDER BY created_at DESC LIMIT 50', req.userId, now() - 30 * 86400000);
    const u = await get1('SELECT nudge_optout, tz_offset FROM users WHERE id=?', req.userId);
    res.json({ ok: true, nudges: rows, optout: !!Number(u && u.nudge_optout), tz_offset: Number((u && u.tz_offset) || 0) });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.post('/api/me/nudge-optout', auth, async (req, res) => {
  try {
    const v = (req.body || {}).optout ? 1 : 0;
    await runSql('UPDATE users SET nudge_optout=? WHERE id=?', v, req.userId);
    res.json({ ok: true, nudge_optout: v });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.post('/api/me/nudges/:id/opened', auth, async (req, res) => {
  try {
    const ch = await runSqlChanges('UPDATE retention_nudges SET opened_at=? WHERE id=? AND user_id=?', now(), Number(req.params.id), req.userId);
    if (!ch) return res.status(404).json({ error: 'nudge introuvable' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});

// ---------- v2.48 SPEC-09 : commission créateur sur ventes via vidéo ----------
async function creditVideoSaleCommission(orderId, sourceVideoId, buyerId, total, hasAffiliate) {
  try {
    if (!sourceVideoId || hasAffiliate) return; // non-cumul : affiliation prioritaire
    const _dup = await get1('SELECT id FROM video_sale_commissions WHERE order_id=?', orderId);
    if (_dup) return; // idempotent : jamais deux commissions pour la même commande
    const v = await get1('SELECT id, user_id FROM videos WHERE id=?', sourceVideoId);
    if (!v) return;
    const creatorId = Number(v.user_id);
    if (creatorId === Number(buyerId)) return; // auto-achat exclu
    // anti-fraude : au moins un produit de la commande doit être lié à la vidéo
    const items = await allRows('SELECT oi.product_id, oi.seller_id FROM order_items oi WHERE oi.order_id=?', orderId);
    if (!items.length) return;
    let linked = false;
    for (const it of items) {
      if (Number(it.seller_id) === creatorId) return; // vendeur = créateur : pas de commission
      const l = await get1('SELECT 1 FROM video_products WHERE video_id=? AND product_id=?', sourceVideoId, it.product_id);
      if (l) { linked = true; break; }
    }
    if (!linked) return;
    let comm = Math.floor(Number(total) * VIDEO_CREATOR_RATE_PCT / 100);
    if (comm < 1 && Number(total) >= 20) comm = 1;
    if (comm < 1) return;
    await runSql('UPDATE users SET coins=coins+? WHERE id=?', comm, creatorId);
    await runSql('INSERT INTO ledger(user_id,amount,reason,created_at) VALUES(?,?,?,?)',
      creatorId, comm, 'video_sale_commission #' + orderId, now());
    await runSql('INSERT INTO video_sale_commissions(order_id,video_id,creator_id,coins,created_at) VALUES(?,?,?,?,?)',
      orderId, sourceVideoId, creatorId, comm, now());
  } catch (e) { console.error('creditVideoSaleCommission:', e.message); }
}
// NOTE : hook appelé dans POST /api/shop/orders après création de la commande (voir plus bas).
app.get('/api/videos/:id/sales', auth, async (req, res) => {
  try {
    const vid = Number(req.params.id);
    const v = await get1('SELECT id, user_id FROM videos WHERE id=?', vid);
    if (!v) return res.status(404).json({ error: 'vidéo introuvable' });
    if (Number(v.user_id) !== Number(req.userId)) return res.status(403).json({ error: 'réservé au créateur' });
    const items = await allRows(
      `SELECT c.order_id, c.coins AS commission, o.total_coins, o.created_at, u.username AS buyer
       FROM video_sale_commissions c JOIN orders o ON o.id=c.order_id
       LEFT JOIN users u ON u.id=o.buyer_id
       WHERE c.video_id=? AND c.refunded=0 ORDER BY o.created_at DESC LIMIT 100`, vid);
    const tot = await get1('SELECT COUNT(*) AS n, COALESCE(SUM(coins),0) AS s, COALESCE(SUM(o.total_coins),0) AS t FROM video_sale_commissions c JOIN orders o ON o.id=c.order_id WHERE c.video_id=? AND c.refunded=0', vid);
    res.json({ ok: true, sales: { count: tot.n || 0, total_coins: tot.t || 0, commission_earned: tot.s || 0 }, items });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});

// ---------- v2.48 SPEC-10 : premieres (sorties planifiées + compte à rebours) ----------
app.post('/api/videos/:id/premiere', auth, async (req, res) => {
  try {
    const vid = Number(req.params.id);
    const v = await get1('SELECT * FROM videos WHERE id=?', vid);
    if (!v) return res.status(404).json({ error: 'vidéo introuvable' });
    if (Number(v.user_id) !== Number(req.userId)) return res.status(403).json({ error: 'réservé au créateur' });
    const sat = Number((req.body || {}).scheduled_at) || Number(v.scheduled_at) || 0;
    if (!sat || sat <= now() + 30 * 60000) return res.status(400).json({ error: 'la premiere doit être planifiée au moins 30 min à l\'avance' });
    if (sat > now() + 7 * 86400000) return res.status(400).json({ error: 'maximum 7 jours à l\'avance' });
    if (!Number(v.scheduled_at) || Number(v.scheduled_at) <= now()) return res.status(400).json({ error: 'la vidéo doit être programmée (non publiée)' });
    const n = await get1(`SELECT COUNT(*) AS n FROM premieres p JOIN videos vv ON vv.id=p.video_id
      WHERE p.creator_id=? AND p.status='scheduled' AND p.video_id<>?`, req.userId, vid);
    if ((n.n || 0) >= PREMIERE_LIMIT_PER_CREATOR) return res.status(429).json({ error: 'maximum ' + PREMIERE_LIMIT_PER_CREATOR + ' premieres à venir par créateur' });
    const chatMin = Math.min(120, Math.max(10, Number((req.body || {}).chat_minutes) || 30));
    await runSql('UPDATE videos SET scheduled_at=? WHERE id=?', sat, vid);
    await runSql('INSERT INTO premieres(video_id,creator_id,scheduled_at,status,created_at) VALUES(?,?,?,?,?)', vid, req.userId, sat, 'scheduled', now())
      .catch(() => runSql('UPDATE premieres SET scheduled_at=?, status=?, creator_id=? WHERE video_id=?', sat, 'scheduled', req.userId, vid));
    res.json({ ok: true, chat_minutes: chatMin });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.delete('/api/videos/:id/premiere', auth, async (req, res) => {
  try {
    const vid = Number(req.params.id);
    const p = await get1('SELECT * FROM premieres WHERE video_id=? AND creator_id=? AND status=?', vid, req.userId, 'scheduled');
    if (!p) return res.status(404).json({ error: 'premiere introuvable' });
    await runSql("UPDATE premieres SET status='cancelled' WHERE video_id=?", vid);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.get('/api/videos/:id/premiere', async (req, res) => {
  try {
    const vid = Number(req.params.id);
    const p = await get1('SELECT * FROM premieres WHERE video_id=?', vid);
    if (!p) return res.status(404).json({ error: 'pas de premiere' });
    if (p.status === 'live' || p.status === 'released') return res.json({ ok: true, is_premiere: p.status === 'live', released: p.status === 'released' });
    const rc = await get1('SELECT COUNT(*) AS n FROM premiere_reminders WHERE video_id=?', vid);
    let me = 0;
    try {
      const meId = req.userId || (req.user && req.user.id);
      if (meId) { const r = await get1('SELECT 1 AS x FROM premiere_reminders WHERE video_id=? AND user_id=?', vid, meId); me = r ? 1 : 0; }
    } catch (_) {}
    res.json({ ok: true, is_premiere: true, scheduled_at: Number(p.scheduled_at), seconds_left: Math.max(0, Math.floor((Number(p.scheduled_at) - now()) / 1000)), reminder_count: rc.n || 0, i_reminded: me });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.post('/api/videos/:id/premiere/remind', auth, async (req, res) => {
  try {
    const vid = Number(req.params.id);
    const p = await get1("SELECT * FROM premieres WHERE video_id=? AND status='scheduled'", vid);
    if (!p) return res.status(404).json({ error: 'pas de premiere à venir' });
    await runSql('INSERT INTO premiere_reminders(video_id,user_id,created_at) VALUES(?,?,?)', vid, req.userId, now())
      .catch(() => {});
    res.json({ ok: true, reminded: true });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.delete('/api/videos/:id/premiere/remind', auth, async (req, res) => {
  try {
    await runSql('DELETE FROM premiere_reminders WHERE video_id=? AND user_id=?', Number(req.params.id), req.userId);
    res.json({ ok: true, reminded: false });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.get('/api/premieres/upcoming', async (req, res) => {
  try {
    const rows = await allRows(
      `SELECT p.video_id, p.scheduled_at, p.creator_id, u.username, v.description, v.thumb,
        (SELECT COUNT(*) FROM premiere_reminders r WHERE r.video_id=p.video_id) AS reminder_count
       FROM premieres p JOIN videos v ON v.id=p.video_id JOIN users u ON u.id=p.creator_id
       WHERE p.status='scheduled' AND p.scheduled_at>? AND p.scheduled_at<?
       ORDER BY p.scheduled_at ASC LIMIT 50`, now(), now() + 7 * 86400000);
    res.json({ ok: true, premieres: rows });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// chat éphémère de la premiere — room 'premiere:<video_id>' (mêmes règles que le chat live)
app.post('/api/videos/:id/premiere/chat', auth, async (req, res) => {
  try {
    const vid = Number(req.params.id);
    const p = await get1("SELECT * FROM premieres WHERE video_id=? AND status='live'", vid);
    if (!p) return res.status(403).json({ error: 'chat fermé (premiere non diffusée)' });
    const raw = String((req.body || {}).text || '').trim();
    if (!raw) return res.status(400).json({ error: 'message vide' });
    if (raw.length > 280) return res.status(400).json({ error: 'message trop long (280 caractères max)' });
    if (typeof containsBadword === 'function' && containsBadword(raw)) return res.status(400).json({ error: 'message refusé : langage inapproprié' });
    const id = await insertId('INSERT INTO premiere_chat(video_id,user_id,text,created_at) VALUES(?,?,?,?)', vid, req.userId, raw, now());
    try {
      const room = 'premiere:' + vid; // room éphémère — diffusion WS si un relayeur est branché
      if (typeof premiereRooms !== 'undefined' && premiereRooms[room])
        for (const ws of premiereRooms[room]) { try { if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'chat', room, id, text: raw })); } catch (_) {} }
    } catch (_) {}
    res.json({ ok: true, id });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.get('/api/videos/:id/premiere/chat', async (req, res) => {
  try {
    const vid = Number(req.params.id);
    const since = Number(req.query.since) || 0;
    const rows = await allRows(`SELECT c.*, u.username FROM premiere_chat c LEFT JOIN users u ON u.id=c.user_id
      WHERE c.video_id=? AND c.id>? ORDER BY c.id ASC LIMIT 100`, vid, since);
    res.json({ ok: true, messages: rows });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// rappels H-15 (premiere_soon) — appelé par le scheduler
async function checkPremieres() {
  try {
    const t = now();
    const rows = await allRows(`SELECT p.*, v.description FROM premieres p JOIN videos v ON v.id=p.video_id
      WHERE p.status='scheduled' AND p.scheduled_at>? AND p.scheduled_at<=?`, t, t + 15 * 60000);
    for (const p of rows) {
      const subs = await allRows('SELECT user_id FROM premiere_reminders WHERE video_id=?', p.video_id);
      for (const s of subs) {
        const already = await get1("SELECT id FROM notifications WHERE user_id=? AND type='premiere_soon' AND video_id=?", s.user_id, p.video_id);
        if (!already)
          try { await insertId('INSERT INTO notifications(user_id,type,video_id,title,text,is_read,created_at) VALUES(?,?,?,?,?,0,?)',
            s.user_id, 'premiere_soon', p.video_id, '🎬 Premiere dans 15 min', String(p.description || '').slice(0, 120), t); } catch (_) {}
      }
    }
    // purge des reminders des premieres sorties/annulées depuis > 24h
    await runSql(`DELETE FROM premiere_reminders WHERE video_id IN(SELECT video_id FROM premieres WHERE status IN('released','cancelled') AND scheduled_at<?)`, t - 86400000);
  } catch (e) { console.error('checkPremieres:', e.message); }
}

// ---------- suppression d'une vidéo : cascade complète anti-orphelins ----------
// Utilisée par DELETE /api/videos/:id ET par DELETE /api/account (fonction
// hoistée : appelable depuis n'importe quel endpoint du module).
// Convention : duet_of/stitch_of/reply_to_comment_id valent 0 quand absents.
async function deleteVideoCascade(vid) {
  vid = Number(vid);
  // les vidéos-réponses / duos / stitches pointant vers la vidéo supprimée
  // retombent sur 0 (aucune) au lieu de pointer vers le vide
  await runSql('UPDATE videos SET reply_to_comment_id=0 WHERE reply_to_comment_id IN (SELECT id FROM comments WHERE video_id=?)', vid);
  await runSql('DELETE FROM comment_likes WHERE comment_id IN (SELECT id FROM comments WHERE video_id=?)', vid);
  await runSql('DELETE FROM notifications WHERE video_id=? OR comment_id IN (SELECT id FROM comments WHERE video_id=?)', vid, vid);
  await runSql('DELETE FROM comments WHERE video_id=?', vid);
  await runSql('DELETE FROM likes WHERE video_id=?', vid);
  await runSql('DELETE FROM video_views WHERE video_id=?', vid);
  await runSql('DELETE FROM watch_events WHERE video_id=?', vid);
  await runSql('DELETE FROM watch_history WHERE video_id=?', vid);
  await runSql('DELETE FROM watch_rewards WHERE video_id=?', vid);
  await runSql('DELETE FROM like_rewards WHERE video_id=?', vid);
  await runSql('DELETE FROM tips WHERE video_id=?', vid);
  await runSql('DELETE FROM playlist_items WHERE video_id=?', vid);
  await runSql('DELETE FROM collection_items WHERE video_id=?', vid);
  await runSql('DELETE FROM shared_collection_videos WHERE video_id=?', vid);
  await runSql('DELETE FROM series_items WHERE video_id=?', vid);
  await runSql('DELETE FROM reposts WHERE video_id=?', vid);
  await runSql('DELETE FROM gifts WHERE video_id=?', vid);
  await runSql('DELETE FROM video_pins WHERE video_id=?', vid);
  await runSql('DELETE FROM video_products WHERE video_id=?', vid);
  await runSql('DELETE FROM hidden_videos WHERE video_id=?', vid);
  await runSql("DELETE FROM reports WHERE target_type='video' AND target_id=?", vid);
  await runSql("DELETE FROM review_queue WHERE item_type='video' AND item_id=?", vid);
  await runSql('DELETE FROM poll_votes WHERE poll_id IN (SELECT id FROM polls WHERE video_id=?)', vid);
  await runSql('DELETE FROM poll_options WHERE poll_id IN (SELECT id FROM polls WHERE video_id=?)', vid);
  await runSql('DELETE FROM polls WHERE video_id=?', vid);
  await runSql('UPDATE videos SET duet_of=0 WHERE duet_of=?', vid);
  await runSql('UPDATE videos SET stitch_of=0 WHERE stitch_of=?', vid);
  await runSql('DELETE FROM videos WHERE id=?', vid);
}
// ---------- suppression d'une vidéo (propriétaire uniquement) ----------
app.delete('/api/videos/:id', auth, async (req, res) => {
  try {
    const v = await get1('SELECT * FROM videos WHERE id=?', req.params.id);
    if (!v) return res.status(404).json({ error: 'vidéo introuvable' });
    // v2.38 : l'admin (x-admin-token) peut supprimer n'importe quelle vidéo
    const _isAdm = process.env.ADMIN_TOKEN && req.headers['x-admin-token'] === process.env.ADMIN_TOKEN;
    if (!_isAdm && Number(v.user_id) !== Number(req.userId)) return res.status(403).json({ error: 'non autorisé' });
    // fichier : Cloudinary ou disque local
    try {
      if (USE_CLOUDINARY && v.file) {
        const m = String(v.file).match(/\/upload\/(?:v\d+\/)?(.+?)\.[a-z0-9]+$/i);
        if (m) await cloudinary.uploader.destroy(m[1], { resource_type: 'video' });
      } else if (v.file) fs.unlink(path.join(UP, v.file), () => {});
    } catch (e) {}
    await deleteVideoCascade(v.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// ---------- vues : comptage anti-triche ----------
// Règles : 1 vue comptée par spectateur et par vidéo toutes les 24 h,
// les vues de l'auteur lui-même ne comptent pas,
// plafond de 100 vues comptées par spectateur et par jour (tous vidéos).
// ad_shown=1 quand une publicité a été affichée pendant la vue (vues monétisées).
app.post('/api/videos/:id/view', async (req, res) => {
  try {
    const v = await get1('SELECT * FROM videos WHERE id=?', req.params.id);
    if (!v) return res.status(404).json({ error: 'vidéo introuvable' });
    let viewerId = null;
    const h = req.headers.authorization || '';
    const m = h.match(/^Bearer (.+)$/);
    if (m) {
      const row = await get1('SELECT user_id FROM tokens WHERE token=?', m[1]);
      if (row) viewerId = row.user_id;
    }
    if (viewerId && Number(viewerId) === Number(v.user_id)) {
      await touchHistory(viewerId, v.id);
      return res.json({ ok: true, counted: false, reason: 'self' });
    }
    const ip = (req.ip || req.socket.remoteAddress || '').trim().slice(0, 45);
    const dayAgo = now() - 86400000;
    // v2.41 : vélocité anti-fraude — >50 hits de vues/heure pour le même spectateur = comportement de bot.
    // Compté sur les hits du endpoint (les vues dédupliquées n'atteignent jamais la base).
    const _vh = viewVelocityHit(viewerId, ip);
    if (_vh > 50) await fraudAlert('view_velocity', viewerId, ip, _vh + ' vues/heure — vélocité suspecte');
    const dup = viewerId
      ? await get1('SELECT 1 FROM video_views WHERE video_id=? AND viewer_id=? AND created_at>?', v.id, viewerId, dayAgo)
      : await get1('SELECT 1 FROM video_views WHERE video_id=? AND viewer_id IS NULL AND ip=? AND created_at>?', v.id, ip, dayAgo);
    if (dup) {
      await touchHistory(viewerId, v.id);
      return res.json({ ok: true, counted: false, reason: 'duplicate' });
    }
    const cnt = viewerId
      ? await get1('SELECT COUNT(*) AS c FROM video_views WHERE viewer_id=? AND created_at>?', viewerId, dayAgo)
      : await get1('SELECT COUNT(*) AS c FROM video_views WHERE viewer_id IS NULL AND ip=? AND created_at>?', ip, dayAgo);
    if (Number(cnt.c) >= 100) {
      await touchHistory(viewerId, v.id);
      return res.json({ ok: true, counted: false, reason: 'rate-limit' });
    }
    // le serveur décide seul si la vue est monétisée (1 vue sur 6) — le client ne peut pas gonfler ad_views
    const adShown = (Number(v.views) % 6 === 5) ? 1 : 0;
    // v2.39 : source du trafic (feed|foryou|following|search|profile|deeplink|other) — valeur inconnue → 'feed'
    // v2.48 : 'foryou' ajouté (l'app l'envoie déjà) — video_view_sources enregistre chaque vue (SPEC analytics-pro)
    const VIEW_SOURCES = ['feed', 'foryou', 'following', 'search', 'profile', 'deeplink', 'other'];
    let viewSrc = 'feed';
    try {
      const s = String((req.body && req.body.source) || '').trim().toLowerCase();
      if (VIEW_SOURCES.includes(s)) viewSrc = s;
    } catch (e) {}
    await runSql('INSERT INTO video_views(video_id,viewer_id,ip,ad_shown,source,created_at) VALUES(?,?,?,?,?,?)',
      v.id, viewerId, ip, adShown, viewSrc, now());
    try {
      await runSql('INSERT INTO video_view_sources(video_id,user_id,source,created_at) VALUES(?,?,?,?)',
        v.id, viewerId, viewSrc, now());
    } catch (e) {}
    await runSql('UPDATE videos SET views=views+1' + (adShown ? ', ad_views=ad_views+1' : '') + ' WHERE id=?', v.id);
    await touchHistory(viewerId, v.id);
    res.json({ ok: true, counted: true, ad_shown: !!adShown });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});

// ---------- récompense de visionnage : +10 pièces/vidéo/jour, plafond 100/jour ----------
app.post('/api/videos/:id/watch-reward', auth, async (req, res) => {
  try {
    const v = await get1('SELECT * FROM videos WHERE id=?', req.params.id);
    if (!v) return res.status(404).json({ error: 'vidéo introuvable' });
    if (Number(v.user_id) === Number(req.userId)) return res.json({ ok: true, granted: 0, reason: 'self' });
    // v2.41 : gains bloqués si l'utilisateur est sur un device flagged avec ≥5 comptes (fraud-review)
    if (await deviceEarningsBlocked(req.userId)) {
      const _b = await get1('SELECT coins FROM users WHERE id=?', req.userId);
      return res.json({ ok: true, granted: 0, reason: 'fraud-review', coins: _b ? _b.coins : 0 });
    }
    const day = new Date().toISOString().slice(0, 10);
    // FIX temps 2026-10-05 (T3) : dayStart était minuit HEURE LOCALE serveur alors que
    // `day` (clé anti-doublon) est en UTC → à cheval sur minuit, la règle
    // « 1 récompense/vidéo/jour » était contournable. Unifié en UTC partout (comme les quêtes).
    const dayStart = new Date(day + 'T00:00:00Z').getTime();
    // anti-concurrence (2026-10-04) : la section "anti-doublon → lecture du compteur
    // journalier → crédit" doit être atomique par utilisateur. Sans sérialisation,
    // N requêtes simultanées lisent le même compteur et dépassent le plafond 100/jour
    // (TOCTOU sur `earned` — avéré sur Postgres où les requêtes s'intercalent).
    const out = await withUserLock(req.userId, async () => {
      // anti-doublon : une récompense par vidéo par utilisateur par jour
      const inserted = await runSqlChanges(
        USE_PG
          ? 'INSERT INTO watch_rewards(video_id,user_id,day,created_at) VALUES(?,?,?,?) ON CONFLICT DO NOTHING'
          : 'INSERT OR IGNORE INTO watch_rewards(video_id,user_id,day,created_at) VALUES(?,?,?,?)',
        v.id, req.userId, day, now());
      if (!inserted) return { granted: 0, reason: 'already' };
      // v2.45 : le plafond 100/jour ne compte QUE les récompenses de visionnage
      // (comme les likes ne comptent que 'like reçu%') — pas les parrainages, défis, etc.
      const earned = Number((await get1(`SELECT COALESCE(SUM(amount),0) AS s FROM ledger WHERE user_id=? AND reason LIKE 'vidéo regardée%' AND created_at>=?`, req.userId, dayStart)).s);
      if (earned >= 100) return { granted: 0, reason: 'daily-cap' };
      const grant = Math.min(10, 100 - earned);
      await runSql('UPDATE users SET coins=coins+? WHERE id=?', grant, req.userId);
      await runSql('INSERT INTO ledger(user_id,amount,reason,created_at) VALUES(?,?,?,?)', req.userId, grant, 'vidéo regardée #' + v.id, now());
      return { granted: grant, reason: '' };
    });
    const b = await get1('SELECT coins FROM users WHERE id=?', req.userId);
    const resp = { ok: true, granted: out.granted, coins: b ? b.coins : 0 };
    if (out.reason) resp.reason = out.reason;
    res.json(resp);
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});

// ---------- likes ----------
app.post('/api/videos/:id/like', auth, async (req, res) => {
  try {
    const v = await get1('SELECT * FROM videos WHERE id=?', req.params.id);
    if (!v) return res.status(404).json({ error: 'vidéo introuvable' });
    const alreadyLiked = await get1('SELECT 1 FROM likes WHERE user_id=? AND video_id=?', req.userId, v.id);
    await insertIgnore('INSERT OR IGNORE INTO likes(user_id,video_id,created_at) VALUES(?,?,?)',
      req.userId, v.id, now());
    // v2.41 : vélocité anti-fraude — >15 likes en 5 min = comportement de bot (farme de likes).
    if (!alreadyLiked) {
      try {
        const _lc = await get1('SELECT COUNT(*) AS c FROM likes WHERE user_id=? AND created_at>?', req.userId, now() - 300000);
        if (Number(_lc.c) > 15) await fraudAlert('like_velocity', req.userId, clientIp(req), Number(_lc.c) + ' likes en 5 min — vélocité suspecte');
      } catch (_e) {}
    }
    if (!alreadyLiked) await notify(v.user_id, 'like', req.userId, v.id, '');
    // v2.38 : signal « Pour toi » — un like frais incrémente les scores des tags de la vidéo
    if (!alreadyLiked) {
      try {
        const _lts = tagsOf(v).slice(0, 12);
        for (const _t of _lts) {
          await runSql('INSERT INTO user_tag_scores(user_id,tag,score) VALUES(?,?,1) ON CONFLICT(user_id,tag) DO UPDATE SET score=user_tag_scores.score+1',
            req.userId, _t);
        }
      } catch (_e) { console.error('TAG_SCORE_ERR', _e.message); }
    }
    // +1 pièce au créateur quand quelqu'un aime (plafond 100/jour, une seule fois par liker/vidéo)
    const dayStart = new Date().setHours(0, 0, 0, 0);
    const firstReward = await runSqlChanges(
      USE_PG
        ? 'INSERT INTO like_rewards(liker_id,video_id,created_at) VALUES(?,?,?) ON CONFLICT DO NOTHING'
        : 'INSERT OR IGNORE INTO like_rewards(liker_id,video_id,created_at) VALUES(?,?,?)',
      req.userId, v.id, now());
    // anti-concurrence (2026-10-04) : +1 pièce au créateur, plafond 100/jour —
    // lecture+vérification+crédit sérialisés par créateur (TOCTOU sinon).
    // v2.41 : pas de gain si le créateur est sur un device flagged avec ≥5 comptes (fraud-review).
    if (firstReward && Number(v.user_id) !== Number(req.userId) && !(await deviceEarningsBlocked(v.user_id))) {
      await withUserLock(v.user_id, async () => {
        const earned = Number((await get1(
          `SELECT COALESCE(SUM(amount),0) AS s FROM ledger
           WHERE user_id=? AND reason LIKE 'like reçu%' AND created_at>=?`, v.user_id, dayStart)).s);
        if (earned < 100) {
          await runSql('UPDATE users SET coins=coins+1 WHERE id=?', v.user_id);
          await runSql('INSERT INTO ledger(user_id,amount,reason,created_at) VALUES(?,?,?,?)',
            v.user_id, 1, 'like reçu vidéo #' + v.id, now());
        }
      });
    }
    const likes = Number((await get1('SELECT COUNT(*) AS c FROM likes WHERE video_id=?', v.id)).c);
    res.json({ likes, liked: true });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});

app.delete('/api/videos/:id/like', auth, async (req, res) => {
  await runSql('DELETE FROM likes WHERE user_id=? AND video_id=?', req.userId, req.params.id);
  // v2.38 : unlike → décrémente les scores de tags « Pour toi » (plancher 0)
  try {
    const _uv = await get1('SELECT tags FROM videos WHERE id=?', req.params.id);
    const _uts = tagsOf({ tags: _uv && _uv.tags }).slice(0, 12);
    for (const _t of _uts) {
      await runSql('UPDATE user_tag_scores SET score=CASE WHEN score>1 THEN score-1 ELSE 0 END WHERE user_id=? AND tag=?',
        req.userId, _t);
    }
  } catch (_) {}
  const likes = Number((await get1('SELECT COUNT(*) AS c FROM likes WHERE video_id=?', req.params.id)).c);
  res.json({ likes, liked: false });
});

// v2.36 : compteurs partages / téléchargements d'une vidéo (incrémentés par l'app au partage/téléchargement)
app.post('/api/videos/:id/share', auth, async (req, res) => {
  try {
    const v = await get1('SELECT * FROM videos WHERE id=?', req.params.id);
    if (!v) return res.status(404).json({ error: 'vidéo introuvable' });
    await runSql('UPDATE videos SET shares=COALESCE(shares,0)+1 WHERE id=?', v.id);
    const vj = await get1('SELECT shares FROM videos WHERE id=?', v.id);
    res.json({ ok: true, shares: Number(vj.shares) || 0 });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.post('/api/videos/:id/download', auth, async (req, res) => {
  try {
    const v = await get1('SELECT * FROM videos WHERE id=?', req.params.id);
    if (!v) return res.status(404).json({ error: 'vidéo introuvable' });
    // v2.39 : application du réglage users.download_privacy du PROPRIÉTAIRE (everyone/friends/nobody)
    if (Number(v.user_id) !== Number(req.userId)) {
      const ow = await get1('SELECT download_privacy FROM users WHERE id=?', v.user_id);
      const pol = (ow && ow.download_privacy) || 'everyone';
      if (pol === 'nobody') return res.status(403).json({ error: 'téléchargement désactivé par le créateur' });
      if (pol === 'friends' && !(await areFriends(req.userId, v.user_id)))
        return res.status(403).json({ error: 'téléchargement réservé aux amis' });
    }
    await runSql('UPDATE videos SET downloads=COALESCE(downloads,0)+1 WHERE id=?', v.id);
    const vj = await get1('SELECT downloads FROM videos WHERE id=?', v.id);
    res.json({ ok: true, downloads: Number(vj.downloads) || 0 });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// ---------- v2.48 SPEC-01 : bibliothèque hors-ligne gérée ----------
// suivi des vidéos téléchargées (quota OFFLINE_QUOTA) — pas de pièces hors-ligne (compteur serveur uniquement)
app.post('/api/videos/:id/offline-track', auth, async (req, res) => {
  try {
    const v = await get1('SELECT id FROM videos WHERE id=?', req.params.id);
    if (!v) return res.status(404).json({ error: 'vidéo introuvable' });
    const ex = await get1('SELECT 1 FROM offline_downloads WHERE user_id=? AND video_id=?', req.userId, v.id);
    if (!ex) {
      const n = await get1('SELECT COUNT(*) AS c FROM offline_downloads WHERE user_id=?', req.userId);
      if (Number(n.c) >= OFFLINE_QUOTA)
        return res.status(400).json({ error: 'quota hors-ligne atteint (' + OFFLINE_QUOTA + ' vidéos)' });
      await runSql('INSERT INTO offline_downloads(user_id,video_id,created_at) VALUES(?,?,?)', req.userId, v.id, now());
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.delete('/api/videos/:id/offline-track', auth, async (req, res) => {
  try {
    await runSql('DELETE FROM offline_downloads WHERE user_id=? AND video_id=?', req.userId, Number(req.params.id));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.get('/api/offline/list', auth, async (req, res) => {
  try {
    const rows = await allRows(
      'SELECT o.video_id, o.created_at AS saved_at FROM offline_downloads o WHERE o.user_id=? ORDER BY o.created_at DESC', req.userId);
    const videos = [];
    for (const r of rows) {
      const v = await get1('SELECT * FROM videos WHERE id=? AND hidden=0', r.video_id);
      if (!v) continue;
      const j = await videoJSON(v, req.userId);
      if (j) { j.offline_saved_at = Number(r.saved_at); videos.push(j); }
    }
    res.json({ ok: true, videos, quota: OFFLINE_QUOTA, used: rows.length });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});

// v1.68 : filtre anti-gros mots AUTOMATIQUE (pas seulement le mode protection)
const BADWORDS_FR = ['merde','putain','salope','connard','connasse','encul','bite','couille','nique','fdp','tg','pd','salop','batard','bâtard','chiant','conard','débile','attardé','mongol'];
const BADWORDS_EN = ['fuck','shit','bitch','asshole','dick','pussy','whore','slut','bastard','dumbass','retard','nigga','nigger','fag'];
const BADWORDS_HT = ['kokorat','sanmanman','bouzen','kokobe','malpwòp'];
const ALL_BADWORDS = [...BADWORDS_FR, ...BADWORDS_EN, ...BADWORDS_HT];
function containsBadword(text) {
  const low = ' ' + String(text || '').toLowerCase().replace(/[^\p{L}\p{N} ]/gu, ' ') + ' ';
  for (const w of ALL_BADWORDS) {
    if (low.includes(' ' + w + ' ') || low.includes(' ' + w + 's ')) return w;
  }
  return null;
}
function maskBadwords(text) {
  let out = String(text || '');
  for (const w of ALL_BADWORDS) {
    const re = new RegExp('\\b' + w + 's?\\b', 'gi');
    out = out.replace(re, m => '*'.repeat(m.length));
  }
  return out;
}
// parité TikTok (2026-10-04) : filtre anti-spam des commentaires — liens + répétitions
// Retourne la raison du blocage, ou null si le texte est acceptable.
function commentSpamReason(text) {
  const t = String(text || '');
  if (/(https?:\/\/|www\.)/i.test(t)) return 'les liens sont interdits dans les commentaires';
  if (/(.)\1{5,}/.test(t)) return 'caractères répétés détectés';
  const words = t.toLowerCase().split(/\s+/).filter(Boolean);
  let run = 1;
  for (let i = 1; i < words.length; i++) {
    if (words[i] === words[i - 1]) { run++; if (run >= 4) return 'répétitions détectées'; }
    else run = 1;
  }
  if (t.length >= 30) {
    const uniq = new Set(t.toLowerCase().replace(/\s/g, '').split(''));
    if (uniq.size <= 3) return 'texte répétitif détecté';
  }
  return null;
}
// ---------- commentaires ----------
app.get('/api/videos/:id/comments', async (req, res) => {
  // PAGINATION 2026-10-04 : ?page=N (50/page, ordre chronologique)
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const rows = await allRows(
    `SELECT c.*, u.username, u.name, u.avatar, u.verified FROM comments c
     JOIN users u ON u.id=c.user_id
     WHERE c.video_id=? AND (c.review_status IS NULL OR (c.review_status<>'pending' AND c.review_status<>'held'))
     ORDER BY c.created_at ASC LIMIT 50 OFFSET ` + ((page - 1) * 50), req.params.id);
  // v12 : exclut les commentaires contenant un mot-clé filtré par le propriétaire
  let kws = [];
  // v2.48 (SPEC-02) : mode 'hide' — les commentaires matchant les filtres du créateur sont masqués
  let hideKws = [];
  try {
    const v = await get1('SELECT user_id FROM videos WHERE id=?', req.params.id);
    if (v) {
      const o = await get1('SELECT comment_keywords, comment_filter_mode FROM users WHERE id=?', v.user_id);
      kws = parseKeywords(o && o.comment_keywords);
      if (o && o.comment_filter_mode === 'hide') {
        const kf = await allRows('SELECT keyword FROM comment_keyword_filters WHERE user_id=?', v.user_id);
        hideKws = kf.map(k => normalize(k.keyword)).filter(Boolean);
      }
    }
  } catch (e) {}
  const filtered = rows.filter(c => {
    const t = String(c.text || '');
    if (kws.length && kws.some(k => t.toLowerCase().includes(k))) return false;
    if (hideKws.length && hideKws.some(k => normalize(t).includes(k))) return false;
    return true;
  });
  // parité TikTok : état "aimé" du lecteur connecté sur chaque commentaire
  try {
    const meId = await optUserId(req);
    if (meId) {
      const lr = await allRows('SELECT comment_id FROM comment_likes WHERE user_id=?', meId);
      const ls = new Set(lr.map(r => Number(r.comment_id)));
      filtered.forEach(c => { c.liked = ls.has(Number(c.id)) ? 1 : 0; });
    } else filtered.forEach(c => { c.liked = 0; });
  } catch (e) { filtered.forEach(c => { c.liked = 0; }); }
  res.json({ comments: filtered, page, has_more: rows.length >= 50 });
});

// ---------- v2.48 SPEC-02 : filtres de mots-clés des commentaires (retenue) ----------
// CRUD : GET/POST/DELETE /api/settings/keyword-filters — mode : /api/settings/comment-filter-mode
// modération : GET /comments/held (liste) + POST /comments/held/:id (approve/delete)
app.get('/api/settings/keyword-filters', auth, async (req, res) => {
  try {
    const rows = await allRows('SELECT id, keyword, created_at FROM comment_keyword_filters WHERE user_id=? ORDER BY created_at ASC', req.userId);
    res.json({ ok: true, filters: rows.map(r => ({ id: r.id, keyword: r.keyword })) });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.post('/api/settings/keyword-filters', auth, async (req, res) => {
  try {
    const keyword = normalize((req.body || {}).keyword).slice(0, 60);
    if (!keyword) return res.status(400).json({ error: 'mot-clé requis' });
    if (keyword.length < 2) return res.status(400).json({ error: 'mot-clé trop court' });
    const n = await get1('SELECT COUNT(*) AS c FROM comment_keyword_filters WHERE user_id=?', req.userId);
    if (Number(n.c) >= 200) return res.status(400).json({ error: 'limite de 200 filtres atteinte' });
    const id = await insertId('INSERT INTO comment_keyword_filters(user_id,keyword,created_at) VALUES(?,?,?)',
      req.userId, keyword, now()).catch(() => null);
    if (id === null) {
      const ex = await get1('SELECT id FROM comment_keyword_filters WHERE user_id=? AND keyword=?', req.userId, keyword);
      return res.json({ ok: true, id: ex ? ex.id : null, keyword, marker: KEYWORD_FILTER });
    }
    res.json({ ok: true, id, keyword, marker: KEYWORD_FILTER });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.delete('/api/settings/keyword-filters/:id', auth, async (req, res) => {
  try {
    await runSql('DELETE FROM comment_keyword_filters WHERE id=? AND user_id=?', Number(req.params.id), req.userId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.get('/api/settings/comment-filter-mode', auth, async (req, res) => {
  try {
    const u = await get1('SELECT comment_filter_mode FROM users WHERE id=?', req.userId);
    res.json({ ok: true, mode: (u && u.comment_filter_mode) || 'off' });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.post('/api/settings/comment-filter-mode', auth, async (req, res) => {
  try {
    const mode = String((req.body || {}).mode || 'off').toLowerCase();
    if (!['off', 'hold', 'hide'].includes(mode)) return res.status(400).json({ error: 'mode invalide (off|hold|hide)' });
    await runSql('UPDATE users SET comment_filter_mode=? WHERE id=?', mode, req.userId);
    res.json({ ok: true, mode, marker: KEYWORD_FILTER });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// modération de la retenue : liste des commentaires en attente sur MES vidéos
app.get('/comments/held', auth, async (req, res) => {
  try {
    const rows = await allRows(
      `SELECT h.id AS hold_id, h.comment_id, h.video_id, h.author_id, h.keyword, h.created_at,
              c.text, u.username AS author
       FROM comment_hold h JOIN comments c ON c.id=h.comment_id
       LEFT JOIN users u ON u.id=h.author_id
       WHERE h.owner_id=? ORDER BY h.created_at DESC LIMIT 100`, req.userId);
    res.json({ ok: true, held: rows });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// approuver (publie) ou supprimer un commentaire en retenue
app.post('/comments/held/:id', auth, async (req, res) => {
  try {
    const action = String((req.body || {}).action || '').toLowerCase();
    const h = await get1('SELECT * FROM comment_hold WHERE id=? AND owner_id=?', Number(req.params.id), req.userId);
    if (!h) return res.status(404).json({ error: 'introuvable' });
    if (action === 'approve') {
      await runSql(`UPDATE comments SET review_status='ok' WHERE id=?`, h.comment_id);
      const c = await get1('SELECT * FROM comments WHERE id=?', h.comment_id);
      if (c) await notify(h.owner_id, 'comment', h.author_id, c.video_id, String(c.text || '').slice(0, 100), c.id);
    } else if (action === 'delete') {
      await runSql('DELETE FROM comments WHERE id=?', h.comment_id);
    } else return res.status(400).json({ error: 'action invalide (approve|delete)' });
    await runSql('DELETE FROM comment_hold WHERE id=?', h.id);
    res.json({ ok: true, action });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});

app.post('/api/videos/:id/comments', auth, uploadMedia.fields([{name:'video',maxCount:1},{name:'audio',maxCount:1}]), async (req, res) => {
  try {
    const rawText = String((req.body || {}).text || '').trim().slice(0, 500);
    // v2.39 : scan du texte BRUT avant masquage — maskBadwords effaçait les mots graves
    // (détectés ensuite sur un texte déjà masqué : le scan ne trouvait plus rien)
    const badC = scanBanned(rawText);
    // v1.68 : filtre anti-gros mots automatique — masque au lieu de bloquer
    let text = maskBadwords(rawText);
    if (badC) text = rawText; // contenu en attente : l'admin doit voir le texte réel
    const hasAudio=req.files&&req.files.audio&&req.files.audio[0];
    const hasVideo=req.files&&req.files.video&&req.files.video[0];
    if (!text&&!hasAudio&&!hasVideo) return res.status(400).json({ error: 'commentaire vide' });
    const v = await get1('SELECT * FROM videos WHERE id=?', req.params.id);
    if (!v) return res.status(404).json({ error: 'vidéo introuvable' });
    if (Number(v.allow_comments) === 0)
      return res.status(403).json({ error: 'commentaires désactivés sur cette vidéo' });
    // parité TikTok : "Qui peut commenter" du créateur (everyone/followers/friends/nobody)
    const owner = await get1('SELECT comment_keywords, comment_privacy, comment_filter_mode FROM users WHERE id=?', v.user_id);
    const cpol = (owner && owner.comment_privacy) || 'everyone';
    if (Number(v.user_id) !== Number(req.userId)) {
      if (cpol === 'nobody')
        return res.status(403).json({ error: 'l\'auteur a désactivé les commentaires' });
      if (cpol === 'followers') {
        const f = await get1('SELECT 1 FROM follows WHERE follower_id=? AND followed_id=?', req.userId, v.user_id);
        if (!f) return res.status(403).json({ error: 'commentaires réservés aux abonnés' });
      }
      if (cpol === 'friends') {
        const f1 = await get1('SELECT 1 FROM follows WHERE follower_id=? AND followed_id=?', req.userId, v.user_id);
        const f2 = await get1('SELECT 1 FROM follows WHERE follower_id=? AND followed_id=?', v.user_id, req.userId);
        if (!f1 || !f2) return res.status(403).json({ error: 'commentaires réservés aux amis' });
      }
    }
    // filtre anti-spam (liens, répétitions)
    const spamR = commentSpamReason(text);
    if (spamR) return res.status(400).json({ error: 'spam : ' + spamR });
    // v12 : mots muets du propriétaire — le commentaire est accepté mais masqué à la lecture
    // (retirer le mot le rend visible à nouveau)
    const kws = parseKeywords(owner && owner.comment_keywords);
    const kwHidden = kws.length > 0 && kws.some(k => text.toLowerCase().includes(k));
    // réponse vidéo optionnelle (même stockage que l'upload de vidéo)
    let videoUrl = null;
    if (hasVideo) videoUrl = fileUrl(await storeVideo(req.files.video[0]));
    // v13 : commentaire vocal (audio)
    let audioUrl = null;
    if (hasAudio) audioUrl = fileUrl(await storeVideo(req.files.audio[0]));
    // m8 : reply_to doit appartenir à la même vidéo
    let replyTo = (req.body || {}).reply_to || null;
    if (replyTo) {
      const parent = await get1('SELECT id FROM comments WHERE id=? AND video_id=?', replyTo, req.params.id);
      if (!parent) return res.status(400).json({ error: 'commentaire parent invalide' });
    }
    const id = await insertId(
      'INSERT INTO comments(video_id,user_id,text,reply_to,video_url,audio_url,created_at) VALUES(?,?,?,?,?,?,?)',
      req.params.id, req.userId, text, replyTo, videoUrl, audioUrl, now());
    // v2.48 (SPEC-02) : KEYWORD_FILTER — filtres mots-clés du créateur (normalisation unicode)
    // mode 'hold' → commentaire mis en retenue (comment_hold) au lieu d'être publié
    // mode 'hide' → publié mais masqué aux autres (comme les mots muets existants)
    let heldKw = null;
    try {
      const kfMode = (owner && owner.comment_filter_mode) || 'off';
      if (kfMode !== 'off' && Number(v.user_id) !== Number(req.userId)) {
        const kfs = await allRows('SELECT keyword FROM comment_keyword_filters WHERE user_id=?', v.user_id);
        const normText = normalize(rawText);
        const hit = kfs.find(k => normText.includes(normalize(k.keyword)));
        if (hit) {
          heldKw = normalize(hit.keyword);
          if (kfMode === 'hold') {
            await runSql(`UPDATE comments SET review_status='held' WHERE id=?`, id);
            await insertIgnore('INSERT OR IGNORE INTO comment_hold(comment_id,video_id,author_id,owner_id,keyword,created_at) VALUES(?,?,?,?,?,?)',
              id, req.params.id, req.userId, v.user_id, heldKw, now());
          }
        }
      }
    } catch (e) {}
    const kwHiddenHold = heldKw && ((owner && owner.comment_filter_mode) === 'hide');
    // modération auto V3 : scan du texte (sans IA externe) — v2.39 : scan fait sur le texte brut plus haut
    if (badC) {
      await runSql(`UPDATE comments SET review_status='pending' WHERE id=?`, id);
      await flagForReview('comment', id, 'mot interdit : ' + badC);
      await modFlag('comment', id, 'mot interdit : ' + badC); // v2.39 : file mod_queue
    }
    const c = await get1(
      `SELECT c.*, u.username, u.name, u.avatar FROM comments c
       JOIN users u ON u.id=c.user_id WHERE c.id=?`, id);
    // v2.39 : un commentaire en attente de moderation n'est ni notifie ni pousse
    // v2.48 (SPEC-02) : un commentaire en retenue (mots-clés) n'est pas notifié non plus
    const isHeld = heldKw && ((owner && owner.comment_filter_mode) === 'hold');
    if (!badC && !isHeld) {
      await notify(v.user_id, 'comment', req.userId, v.id, text.slice(0, 100), id);
      // FIX 2026-10-04 (rupture #5): notifier l'auteur du commentaire parent en cas de réponse
      if (replyTo) {
        try {
          const parentC = await get1('SELECT user_id FROM comments WHERE id=?', replyTo);
          if (parentC && Number(parentC.user_id) !== Number(req.userId) && Number(parentC.user_id) !== Number(v.user_id))
            await notify(parentC.user_id, 'reply', req.userId, v.id, text.slice(0, 100), id);
        } catch (_) {}
      }
      notifyMentions(text, req.userId, v.id, id);
    }
    res.json({ comment: c, filtered: !!kwHidden || !!kwHiddenHold, pending_review: !!badC, held: !!isHeld, keyword_filter: heldKw ? KEYWORD_FILTER : undefined });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});

// ==================== SERVEUR v8 ====================
// ---------- messages privés ----------
async function convOf(convId, userId) {
  const c = await get1('SELECT * FROM conversations WHERE id=?', convId);
  if (!c) return null;
  if (Number(c.user1_id) !== Number(userId) && Number(c.user2_id) !== Number(userId)) return null;
  return c;
}
// trouve ou crée la conversation avec un utilisateur
app.post('/api/conversations', auth, async (req, res) => {
  try {
    const username = String((req.body || {}).username || '').toLowerCase().trim();
    if (!username) return res.status(400).json({ error: 'pseudo requis' });
    const other = await get1('SELECT * FROM users WHERE username=?', username);
    if (!other) return res.status(404).json({ error: 'utilisateur introuvable' });
    if (Number(other.id) === Number(req.userId))
      return res.status(400).json({ error: 'impossible de se parler à soi-même' });
    if (await isBlocked(req.userId, other.id))
      return res.status(403).json({ error: 'utilisateur bloqué' });
    // SPEC-14 : 13-15 ans (compte protégé teen_protected) → DMs réservés aux amis
    // MUTUELS : les deux comptes doivent se suivre. Protège les ados des inconnus.
    const _tpMe = await get1('SELECT teen_protected FROM users WHERE id=?', req.userId);
    const _tpOther = await get1('SELECT teen_protected FROM users WHERE id=?', other.id);
    if (Number(_tpMe && _tpMe.teen_protected) === 1 || Number(_tpOther && _tpOther.teen_protected) === 1) {
      const _mut1 = await get1('SELECT 1 FROM follows WHERE follower_id=? AND followed_id=?', req.userId, other.id);
      const _mut2 = await get1('SELECT 1 FROM follows WHERE follower_id=? AND followed_id=?', other.id, req.userId);
      if (!_mut1 || !_mut2)
        return res.status(403).json({ error: 'compte protégé : les messages sont réservés aux amis mutuels 🛡️' });
    }
    // FIX 2026-10-04 (bot chain-security-private) : appliquer la politique DM du destinataire
    // (dm_privacy était enregistrée par /api/me/privacy mais JAMAIS appliquée — n'importe qui
    // pouvait écrire à un compte réglé sur « personne »)
    const dmpol = other.dm_privacy || 'everyone';
    if (dmpol === 'nobody')
      return res.status(403).json({ error: 'ce compte n\'accepte aucun message' });
    if (dmpol === 'friends') {
      const _f1 = await get1('SELECT 1 FROM follows WHERE follower_id=? AND followed_id=?', req.userId, other.id);
      const _f2 = await get1('SELECT 1 FROM follows WHERE follower_id=? AND followed_id=?', other.id, req.userId);
      if (!_f1 || !_f2) return res.status(403).json({ error: 'ce compte n\'accepte les messages que de ses amis' });
    }
    // (2026-10-05) Les demandes de messages restent accessibles via /api/messages/requests ;
    // POST /api/conversations garde son contrat historique : cree/retourne la conversation (200 + id).
    const a = Math.min(Number(req.userId), Number(other.id));
    const b = Math.max(Number(req.userId), Number(other.id));
    let conv = await get1('SELECT * FROM conversations WHERE user1_id=? AND user2_id=?', a, b);
    if (!conv) {
      const id = await insertId(
        'INSERT INTO conversations(user1_id,user2_id,created_at,updated_at) VALUES(?,?,?,?)',
        a, b, now(), now());
      conv = await get1('SELECT * FROM conversations WHERE id=?', id);
    }
    res.json({ id: conv.id });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// liste de mes conversations
app.get('/api/conversations', auth, async (req, res) => {
  try {
    // PAGINATION 2026-10-04 : ?page=N (20/page)
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const rows = await allRows(
      'SELECT * FROM conversations WHERE user1_id=? OR user2_id=? ORDER BY updated_at DESC LIMIT 20 OFFSET ' + ((page - 1) * 20),
      req.userId, req.userId);
    const out = [];
    for (const c of rows) {
      const otherId = Number(c.user1_id) === Number(req.userId) ? c.user2_id : c.user1_id;
      const ou = await get1('SELECT * FROM users WHERE id=?', otherId);
      const last = await get1('SELECT * FROM messages WHERE conversation_id=? ORDER BY id DESC LIMIT 1', c.id);
      const read = await get1('SELECT last_read_at FROM conversation_reads WHERE conversation_id=? AND user_id=?',
        c.id, req.userId);
      const since = read ? Number(read.last_read_at) : 0;
      const unread = Number((await get1(
        'SELECT COUNT(*) AS c FROM messages WHERE conversation_id=? AND sender_id!=? AND created_at>?',
        c.id, req.userId, since)).c);
      out.push({
        id: c.id,
        other: ou ? pubUser(ou) : null,
        last_text: last ? last.text : null,
        last_at: last ? Number(last.created_at) : Number(c.updated_at),
        unread: unread,
        // v2.47 : conversation mise en sourdine par moi
        muted: !!(await get1('SELECT 1 FROM conversation_mutes WHERE conversation_id=? AND user_id=?', c.id, req.userId)),
      });
    }
    res.json({ conversations: out, page, has_more: rows.length >= 20 });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// messages d'une conversation (50 derniers, ou avant ?before=)
app.get('/api/conversations/:id/messages', auth, async (req, res) => {
  try {
    const c = await convOf(req.params.id, req.userId);
    if (!c) return res.status(404).json({ error: 'conversation introuvable' });
    const before = Number(req.query.before) || 0;
    const rows = before > 0
      ? await allRows('SELECT * FROM messages WHERE conversation_id=? AND id<? ORDER BY id DESC LIMIT 50', c.id, before)
      : await allRows('SELECT * FROM messages WHERE conversation_id=? ORDER BY id DESC LIMIT 50', c.id);
    rows.reverse(); // ordre chronologique
    res.json({ messages: rows.map(function (m) {
      return { id: m.id, sender_id: m.sender_id, text: m.text, audio_url: m.audio_url || '',
        image_url: m.image_url || '', video_url: m.video_url || '',
        deleted_for_all: Number(m.deleted_for_all || 0), created_at: Number(m.created_at) };
    }) });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// envoyer un message
app.post('/api/conversations/:id/messages', auth, async (req, res) => {
  try {
    const c = await convOf(req.params.id, req.userId);
    if (!c) return res.status(404).json({ error: 'conversation introuvable' });
    const otherId = Number(c.user1_id) === Number(req.userId) ? c.user2_id : c.user1_id;
    if (await isBlocked(req.userId, otherId))
      return res.status(403).json({ error: 'utilisateur bloqué' });
    // FIX 2026-10-04 (bot chain-security-private) : politique DM aussi sur les conversations existantes
    const _dmo = await get1('SELECT dm_privacy FROM users WHERE id=?', otherId);
    const _dmpol = (_dmo && _dmo.dm_privacy) || 'everyone';
    if (_dmpol === 'nobody')
      return res.status(403).json({ error: 'ce compte n\'accepte aucun message' });
    if (_dmpol === 'friends') {
      const _g1 = await get1('SELECT 1 FROM follows WHERE follower_id=? AND followed_id=?', req.userId, otherId);
      const _g2 = await get1('SELECT 1 FROM follows WHERE follower_id=? AND followed_id=?', otherId, req.userId);
      if (!_g1 || !_g2) return res.status(403).json({ error: 'ce compte n\'accepte les messages que de ses amis' });
    }
    // v12 : jumelage familial — politique DM du destinataire (s'il est sous contrôle parental)
    const fset = await get1('SELECT dm_policy FROM family_settings WHERE teen_id=?', otherId);
    if (fset) {
      const pol = fset.dm_policy || 'all';
      if (pol === 'none') return res.status(400).json({ error: 'messages privés désactivés pour ce compte' });
      if (pol === 'followers') {
        const fol = await get1('SELECT 1 FROM follows WHERE follower_id=? AND followed_id=?', otherId, req.userId);
        if (!fol) return res.status(400).json({ error: 'ce compte n\'accepte les messages que de ses abonnements' });
      }
    }
    const text = String((req.body || {}).text || '').trim().slice(0, 2000);
    const audioUrl = String((req.body || {}).audio_url || '').slice(0, 500); // v1.57 : message vocal
    const imageUrl = String((req.body || {}).image_url || '').slice(0, 500); // v2.38 : message image
    const videoUrl = String((req.body || {}).video_url || '').slice(0, 500); // v2.38 : message vidéo
    if (!text && !audioUrl && !imageUrl && !videoUrl) return res.status(400).json({ error: 'message vide' });
    const t = now();
    const id = await insertId(
      'INSERT INTO messages(conversation_id,sender_id,text,audio_url,image_url,video_url,created_at) VALUES(?,?,?,?,?,?,?)',
      c.id, req.userId, text, audioUrl, imageUrl, videoUrl, t);
    await runSql('UPDATE conversations SET updated_at=? WHERE id=?', t, c.id);
    // l'expéditeur a lu son propre message
    await insertIgnore('INSERT OR IGNORE INTO conversation_reads(conversation_id,user_id,last_read_at) VALUES(?,?,?)',
      c.id, req.userId, t);
    await runSql('UPDATE conversation_reads SET last_read_at=? WHERE conversation_id=? AND user_id=?',
      t, c.id, req.userId);
    await notify(otherId, 'message', req.userId, null, text.slice(0, 100));
    const m = await get1('SELECT * FROM messages WHERE id=?', id);
    res.json({ message: { id: m.id, sender_id: m.sender_id, text: m.text, created_at: Number(m.created_at) } });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// v2.38 : supprimer un message pour tous (expéditeur uniquement)
app.delete('/api/messages/:id', auth, async (req, res) => {
  try {
    const m = await get1('SELECT * FROM messages WHERE id=?', req.params.id);
    if (!m) return res.status(404).json({ error: 'message introuvable' });
    if (Number(m.sender_id) !== Number(req.userId)) return res.status(403).json({ error: 'non autorisé' });
    await runSql('UPDATE messages SET deleted_for_all=1, text=?, audio_url=?, image_url=?, video_url=? WHERE id=?',
      '', '', '', '', m.id);
    await runSql('DELETE FROM message_reactions WHERE message_id=?', m.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// v2.38 : réagir à un message (emoji)
app.post('/api/messages/:id/react', auth, async (req, res) => {
  try {
    const m = await get1('SELECT * FROM messages WHERE id=?', req.params.id);
    if (!m) return res.status(404).json({ error: 'message introuvable' });
    const c = await convOf(m.conversation_id, req.userId);
    if (!c) return res.status(403).json({ error: 'non autorisé' });
    const emoji = String((req.body || {}).emoji || '').trim().slice(0, 8);
    if (!emoji) return res.status(400).json({ error: 'emoji requis' });
    const t = now();
    if (USE_PG) {
      await pool.query(`INSERT INTO message_reactions(message_id,user_id,emoji,created_at) VALUES($1,$2,$3,$4)
        ON CONFLICT(message_id,user_id) DO UPDATE SET emoji=$3, created_at=$4`, [m.id, req.userId, emoji, t]);
    } else {
      await runSql(`INSERT INTO message_reactions(message_id,user_id,emoji,created_at) VALUES(?,?,?,?)
        ON CONFLICT(message_id,user_id) DO UPDATE SET emoji=excluded.emoji, created_at=excluded.created_at`,
        m.id, req.userId, emoji, t);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// v2.38 : retirer sa réaction
app.delete('/api/messages/:id/react', auth, async (req, res) => {
  try {
    const m = await get1('SELECT * FROM messages WHERE id=?', req.params.id);
    if (!m) return res.status(404).json({ error: 'message introuvable' });
    await runSql('DELETE FROM message_reactions WHERE message_id=? AND user_id=?', m.id, req.userId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// v2.38 : réactions d'un message
app.get('/api/messages/:id/reactions', auth, async (req, res) => {
  try {
    const m = await get1('SELECT * FROM messages WHERE id=?', req.params.id);
    if (!m) return res.status(404).json({ error: 'message introuvable' });
    const c = await convOf(m.conversation_id, req.userId);
    if (!c) return res.status(403).json({ error: 'non autorisé' });
    const rows = await allRows('SELECT user_id, emoji FROM message_reactions WHERE message_id=?', m.id);
    res.json({ reactions: rows });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// v2.38 : rechercher dans une conversation
app.get('/api/conversations/:id/search', auth, async (req, res) => {
  try {
    const c = await convOf(req.params.id, req.userId);
    if (!c) return res.status(404).json({ error: 'conversation introuvable' });
    const q = String(req.query.q || '').trim().slice(0, 100);
    if (!q) return res.status(400).json({ error: 'requête vide' });
    const rows = await allRows(`SELECT id, sender_id, text, created_at FROM messages
      WHERE conversation_id=? AND deleted_for_all=0 AND text LIKE ? ORDER BY id DESC LIMIT 30`,
      c.id, '%' + q.replace(/[%_]/g, '') + '%');
    res.json({ results: rows.map(r => ({ id: r.id, sender_id: r.sender_id, text: r.text, created_at: Number(r.created_at) })) });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// marquer une conversation comme lue
app.post('/api/conversations/:id/read', auth, async (req, res) => {
  try {
    const c = await convOf(req.params.id, req.userId);
    if (!c) return res.status(404).json({ error: 'conversation introuvable' });
    const t = now();
    await insertIgnore('INSERT OR IGNORE INTO conversation_reads(conversation_id,user_id,last_read_at) VALUES(?,?,?)',
      c.id, req.userId, t);
    await runSql('UPDATE conversation_reads SET last_read_at=? WHERE conversation_id=? AND user_id=?',
      t, c.id, req.userId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// v2.47 : mettre une conversation en sourdine (ne pas déranger) — les messages arrivent
// toujours mais sans notification push ni badge
app.post('/api/conversations/:id/mute', auth, async (req, res) => {
  try {
    const c = await convOf(req.params.id, req.userId);
    if (!c) return res.status(404).json({ error: 'conversation introuvable' });
    await insertIgnore('INSERT OR IGNORE INTO conversation_mutes(conversation_id,user_id,created_at) VALUES(?,?,?)',
      c.id, req.userId, now());
    res.json({ ok: true, muted: true });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// v2.47 : réactiver les notifications d'une conversation
app.delete('/api/conversations/:id/mute', auth, async (req, res) => {
  try {
    const c = await convOf(req.params.id, req.userId);
    if (!c) return res.status(404).json({ error: 'conversation introuvable' });
    await runSql('DELETE FROM conversation_mutes WHERE conversation_id=? AND user_id=?', c.id, req.userId);
    res.json({ ok: true, muted: false });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});

// ---------- sondages sur les vidéos ----------
async function pollJSON(pollId, meId) {
  const p = await get1('SELECT * FROM polls WHERE id=?', pollId);
  if (!p) return null;
  const options = await allRows('SELECT id,text,votes FROM poll_options WHERE poll_id=? ORDER BY id ASC', pollId);
  const mine = meId
    ? await get1('SELECT option_id FROM poll_votes WHERE poll_id=? AND user_id=?', pollId, meId)
    : null;
  return {
    id: p.id, video_id: p.video_id, question: p.question,
    options: options.map(function (o) { return { id: o.id, text: o.text, votes: Number(o.votes) }; }),
    my_vote: mine ? mine.option_id : null,
  };
}
// créer un sondage (propriétaire de la vidéo uniquement)
app.post('/api/videos/:id/poll', auth, async (req, res) => {
  try {
    const v = await get1('SELECT * FROM videos WHERE id=?', req.params.id);
    if (!v) return res.status(404).json({ error: 'vidéo introuvable' });
    if (Number(v.user_id) !== Number(req.userId))
      return res.status(403).json({ error: 'seul le propriétaire peut créer un sondage' });
    const question = String((req.body || {}).question || '').trim().slice(0, 200);
    const opts = ((req.body || {}).options || [])
      .map(function (o) { return String(o).trim().slice(0, 80); })
      .filter(function (o) { return o; });
    if (!question) return res.status(400).json({ error: 'question requise' });
    if (opts.length < 2 || opts.length > 4)
      return res.status(400).json({ error: '2 à 4 options requises' });
    const ex = await get1('SELECT id FROM polls WHERE video_id=?', v.id);
    if (ex) return res.status(409).json({ error: 'un sondage existe déjà sur cette vidéo' });
    const pid = await insertId('INSERT INTO polls(video_id,question,created_at) VALUES(?,?,?)',
      v.id, question, now());
    for (const t of opts) await runSql('INSERT INTO poll_options(poll_id,text,votes) VALUES(?,?,0)', pid, t);
    res.json({ poll: await pollJSON(pid, req.userId) });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// lire le sondage d'une vidéo
app.get('/api/videos/:id/poll', async (req, res) => {
  try {
    const p = await get1('SELECT * FROM polls WHERE video_id=?', req.params.id);
    if (!p) return res.status(404).json({ error: 'aucun sondage' });
    const h = req.headers.authorization || '';
    const m = h.match(/^Bearer (.+)$/);
    let meId = null;
    if (m) { const t = await get1('SELECT user_id FROM tokens WHERE token=?', m[1]); if (t) meId = t.user_id; }
    res.json({ poll: await pollJSON(p.id, meId) });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// voter (1 vote par utilisateur, modifiable)
app.post('/api/polls/:id/vote', auth, async (req, res) => {
  try {
    const p = await get1('SELECT * FROM polls WHERE id=?', req.params.id);
    if (!p) return res.status(404).json({ error: 'sondage introuvable' });
    const optId = Number((req.body || {}).option_id);
    const opt = await get1('SELECT id FROM poll_options WHERE id=? AND poll_id=?', optId, p.id);
    if (!opt) return res.status(400).json({ error: 'option invalide' });
    const old = await get1('SELECT option_id FROM poll_votes WHERE poll_id=? AND user_id=?', p.id, req.userId);
    if (old && Number(old.option_id) === optId)
      return res.json({ poll: await pollJSON(p.id, req.userId) }); // déjà voté ici
    if (old) {
      // changement d'avis : on retire l'ancien vote
      await raceGap(req); // crochet test concurrence (Équipe 8/10) : simule l'intercalage Postgres
      // FIX race 2026-10-05 (Équipe 8/10) : 5 changements simultanés A→B corrompaient
      // les compteurs (prouvé : A=-4, B=5). Seule la requête qui déplace vraiment le
      // vote (UPDATE conditionnel sur l'ancienne option) ajuste les compteurs.
      const moved = await runSqlChanges('UPDATE poll_votes SET option_id=? WHERE poll_id=? AND user_id=? AND option_id=?',
        optId, p.id, req.userId, old.option_id);
      if (moved) {
        await runSql('UPDATE poll_options SET votes=votes-1 WHERE id=?', old.option_id);
        await runSql('UPDATE poll_options SET votes=votes+1 WHERE id=?', optId);
      }
    } else {
      // n'incrémente que si le vote a vraiment été inséré (anti double-vote)
      const inserted = await insertIgnore('INSERT OR IGNORE INTO poll_votes(poll_id,user_id,option_id) VALUES(?,?,?)',
        p.id, req.userId, optId);
      if (inserted) await runSql('UPDATE poll_options SET votes=votes+1 WHERE id=?', optId);
    }
    res.json({ poll: await pollJSON(p.id, req.userId) });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});

// ---------- badge vérifié (admin) ----------
// protégé comme /api/fund/deposit : en-tête x-admin-token = ADMIN_TOKEN
app.post('/api/admin/users/:id/verify', async (req, res) => {
  try {
    const token = req.headers['x-admin-token'];
    if (!process.env.ADMIN_TOKEN || token !== process.env.ADMIN_TOKEN)
      return res.status(403).json({ error: 'non autorisé' });
    const u = await get1('SELECT * FROM users WHERE id=?', req.params.id);
    if (!u) return res.status(404).json({ error: 'utilisateur introuvable' });
    const v = (req.body || {}).verified ? 1 : 0;
    await runSql('UPDATE users SET verified=? WHERE id=?', v, u.id);
    // v2.33 : notifie (in-app + push FCM) + e-mail de verdict badge (admin)
    await notify(u.id, 'badge', null, null,
      v ? '✔️ Ton compte est maintenant vérifié !' : '✔️ Ton badge vérifié a été retiré.');
    if (u.email) sendVidiEmail(u.email,
      v ? '✔️ Badge vérifié obtenu — VidiGagne' : '✔️ Badge vérifié retiré — VidiGagne',
      '<p style="font-size:18px">' + (v ? '✔️ Compte vérifié !' : '✔️ Badge retiré') + '</p>'
      + '<p style="color:#ccc;font-size:14px">' + (v
        ? 'Félicitations @' + String(u.username).replace(/</g, '&lt;') + ' ! Ton badge bleu apparaît désormais à côté de ton pseudo.'
        : 'Ton badge vérifié a été retiré par notre équipe. Si tu penses qu\'il s\'agit d\'une erreur, contacte le support.') + '</p>',
      v ? 'Ton compte VidiGagne est maintenant vérifié.' : 'Ton badge vérifié VidiGagne a été retiré.').catch(() => {});
    const upd = await get1('SELECT * FROM users WHERE id=?', u.id);
    res.json({ user: pubUser(upd) });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// v2.38 : bannir / débannir un utilisateur (admin) — suspend=true → compte suspendu (auth 403), suspend=false → réactivé
app.post('/api/admin/users/:id/suspend', adminAuth, async (req, res) => {
  try {
    const u = await get1('SELECT id, username, suspended FROM users WHERE id=?', req.params.id);
    if (!u) return res.status(404).json({ error: 'utilisateur introuvable' });
    const suspend = !!(req.body || {}).suspend;
    await runSql('UPDATE users SET suspended=? WHERE id=?', suspend ? 1 : 0, u.id);
    await notify(u.id, 'system', null, null, suspend ? '⛔ Ton compte a été suspendu par un administrateur.' : '✅ Ton compte a été réactivé.');
    await logAudit(null, suspend ? 'user_ban' : 'user_unban', 'user', u.id, req); // v2.43 (avant res.json : pas de course avec le client)
    res.json({ ok: true, id: u.id, username: u.username, suspended: suspend });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});

// ---------- retraits : validation admin (2026-10-04) ----------
// protégé comme /api/fund/deposit : en-tête x-admin-token=<redacted>
function checkAdmin(req, res) {
  const t = req.headers['x-admin-token'];
  if (!process.env.ADMIN_TOKEN || t !== process.env.ADMIN_TOKEN) { res.status(403).json({ error: 'non autorisé' }); return false; }
  return true;
}
// ---------- v2.43 : journal d'audit admin (actions sensibles) ----------
// Protégé comme /api/admin/withdrawals : en-tête x-admin-token.
app.get('/api/admin/audit-logs', adminAuth, async (req, res) => {
  try {
    const action = String(req.query.action || '').trim().slice(0, 40);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const offset = (page - 1) * limit;
    const where = action ? 'WHERE action=?' : '';
    const params = action ? [action] : [];
    const rows = await allRows(
      'SELECT * FROM audit_logs ' + where + ' ORDER BY id DESC LIMIT ? OFFSET ?', ...params, limit, offset);
    const cnt = await get1('SELECT COUNT(*) AS c FROM audit_logs ' + where, ...params);
    res.json({ ok: true, logs: rows, total: Number((cnt && cnt.c) || 0), page, limit });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.get('/api/admin/withdrawals', async (req, res) => {
  try {
    if (!checkAdmin(req, res)) return;
    const rows = await allRows(
      "SELECT w.*, u.username FROM withdrawals w LEFT JOIN users u ON u.id=w.user_id WHERE w.status='pending' ORDER BY w.created_at ASC"
    );
    res.json({ withdrawals: rows });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.post('/api/admin/withdrawals/:id/approve', async (req, res) => {
  try {
    if (!checkAdmin(req, res)) return;
    const w = await get1('SELECT * FROM withdrawals WHERE id=?', req.params.id);
    if (!w) return res.status(404).json({ error: 'retrait introuvable' });
    if (w.status !== 'pending') return res.status(400).json({ error: 'déjà traité (' + w.status + ')' });
    const t = now();
    await runSql('UPDATE withdrawals SET status=?, decided_at=? WHERE id=?', 'paid', t, w.id);
    await runSql('UPDATE receipts SET status=? WHERE withdrawal_id=?', 'paid', w.id);
    // v2.33 : notifie (in-app + push FCM) + e-mail de confirmation de paiement
    await notify(w.user_id, 'withdrawal', null, null,
      '✅ Ton retrait de ' + w.coins + ' 🪙 (≈ $' + w.usd + ') via ' + w.method + ' a été payé.');
    {
      const wu = await get1('SELECT email, username FROM users WHERE id=?', w.user_id);
      if (wu && wu.email) sendVidiEmail(wu.email,
        '💸 Ton retrait VidiGagne a été payé',
        '<p style="font-size:18px">💸 Retrait payé !</p>'
        + '<p style="color:#ccc;font-size:14px">Félicitations @' + String(wu.username).replace(/</g, '&lt;') + ' !</p>'
        + '<p style="color:#ffd700;font-size:22px;font-weight:800">' + w.coins + ' 🪙 (≈ $' + w.usd + ')</p>'
        + '<p style="color:#ccc;font-size:14px">Moyen : ' + String(w.method).replace(/</g, '&lt;')
        + '<br>Compte : ' + String(w.account || '').replace(/</g, '&lt;') + '</p>'
        + '<p style="color:#999;font-size:12px">Continue à créer et à gagner sur VidiGagne ! ✨</p>',
        'Ton retrait VidiGagne de ' + w.coins + ' pièces (≈ $' + w.usd + ') via ' + w.method + ' a été payé.')
        .catch(() => {});
    }
    await logAudit(null, 'withdraw_approve', 'withdrawal', w.id, req); // v2.43
    res.json({ ok: true, id: w.id, status: 'paid' });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.post('/api/admin/withdrawals/:id/reject', async (req, res) => {
  try {
    if (!checkAdmin(req, res)) return;
    const w = await get1('SELECT * FROM withdrawals WHERE id=?', req.params.id);
    if (!w) return res.status(404).json({ error: 'retrait introuvable' });
    if (w.status !== 'pending') return res.status(400).json({ error: 'déjà traité (' + w.status + ')' });
    const t = now();
    // REMBOURSEMENT CRITIQUE : les pièces retournent à l'utilisateur
    await runSql('UPDATE users SET coins=coins+? WHERE id=?', w.coins, w.user_id);
    await runSql('INSERT INTO ledger(user_id,amount,reason,created_at) VALUES(?,?,?,?)',
      w.user_id, w.coins, 'remboursement retrait #' + w.id + ' rejeté', t);
    await runSql('UPDATE withdrawals SET status=?, decided_at=? WHERE id=?', 'rejected', t, w.id);
    await runSql('UPDATE receipts SET status=? WHERE withdrawal_id=?', 'rejected', w.id);
    // v2.33 : notifie (in-app + push FCM) + e-mail de rejet avec mention du remboursement
    await notify(w.user_id, 'withdrawal', null, null,
      '❌ Ton retrait de ' + w.coins + ' 🪙 a été rejeté. Les pièces ont été recréditées sur ton compte.');
    {
      const wu = await get1('SELECT email, username FROM users WHERE id=?', w.user_id);
      if (wu && wu.email) sendVidiEmail(wu.email,
        '❌ Ton retrait VidiGagne a été rejeté',
        '<p style="font-size:18px">❌ Retrait rejeté</p>'
        + '<p style="color:#ccc;font-size:14px">Ton retrait de <b>' + w.coins + ' 🪙</b> via ' + String(w.method).replace(/</g, '&lt;')
        + ' n\'a pas pu être traité par notre équipe.</p>'
        + '<p style="color:#4ade80;font-size:14px">✅ Bonne nouvelle : tes <b>' + w.coins + ' pièces</b> ont été recréditées sur ton compte.</p>'
        + '<p style="color:#999;font-size:12px">Vérifie ton moyen de paiement et réessaie, ou contacte le support.</p>',
        'Ton retrait VidiGagne de ' + w.coins + ' pièces a été rejeté. Tes pièces ont été recréditées sur ton compte.')
        .catch(() => {});
    }
    await logAudit(null, 'withdraw_reject', 'withdrawal', w.id, req); // v2.43
    res.json({ ok: true, id: w.id, status: 'rejected', refunded: w.coins });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});

// ---------- v2.34 : bots d'intégrité données (admin) ----------
// Scan des lignes orphelines : FK logiques sans contrainte SQL (SQLite/PG).
// Protégé comme /api/admin/withdrawals : en-tête x-admin-token.
const ORPHAN_CHECKS = [
  { key: 'comments_video',    table: 'comments',      column: 'video_id',    ref_table: 'videos', ref_column: 'id', label: 'commentaires → vidéo manquante' },
  { key: 'comments_user',     table: 'comments',      column: 'user_id',     ref_table: 'users',  ref_column: 'id', label: 'commentaires → utilisateur manquant' },
  { key: 'likes_user',        table: 'likes',         column: 'user_id',     ref_table: 'users',  ref_column: 'id', label: 'likes → utilisateur manquant' },
  { key: 'likes_video',       table: 'likes',         column: 'video_id',    ref_table: 'videos', ref_column: 'id', label: 'likes → vidéo manquante' },
  { key: 'notifications_user',table: 'notifications', column: 'user_id',     ref_table: 'users',  ref_column: 'id', label: 'notifications → utilisateur manquant' },
  { key: 'video_views_video', table: 'video_views',   column: 'video_id',    ref_table: 'videos', ref_column: 'id', label: 'vues → vidéo manquante' },
  { key: 'follows_follower',  table: 'follows',       column: 'follower_id', ref_table: 'users',  ref_column: 'id', label: 'follows → follower manquant' },
  { key: 'follows_followed',  table: 'follows',       column: 'followed_id', ref_table: 'users',  ref_column: 'id', label: 'follows → suivi manquant' },
  { key: 'withdrawals_user',  table: 'withdrawals',   column: 'user_id',     ref_table: 'users',  ref_column: 'id', label: 'retraits → utilisateur manquant' },
  // FIX 2026-10-05 (audit DB) : couverture étendue — 60+ tables avec FK logiques n'étaient pas scannées
  { key: 'messages_conv',     table: 'messages',      column: 'conversation_id', ref_table: 'conversations', ref_column: 'id', label: 'messages → conversation manquante' },
  { key: 'messages_sender',   table: 'messages',      column: 'sender_id', ref_table: 'users',  ref_column: 'id', label: 'messages → expéditeur manquant' },
  { key: 'tips_to',           table: 'tips',          column: 'to_user_id', ref_table: 'users', ref_column: 'id', label: 'pourboires → destinataire manquant' },
  { key: 'tips_from',         table: 'tips',          column: 'from_user_id', ref_table: 'users', ref_column: 'id', label: 'pourboires → expéditeur manquant' },
  { key: 'tips_video',        table: 'tips',          column: 'video_id',  ref_table: 'videos', ref_column: 'id', label: 'pourboires → vidéo manquante' },
  { key: 'reposts_user',      table: 'reposts',       column: 'user_id',   ref_table: 'users',  ref_column: 'id', label: 'reposts → utilisateur manquant' },
  { key: 'reposts_video',     table: 'reposts',       column: 'video_id',  ref_table: 'videos', ref_column: 'id', label: 'reposts → vidéo manquante' },
  { key: 'comment_likes_comment', table: 'comment_likes', column: 'comment_id', ref_table: 'comments', ref_column: 'id', label: 'likes commentaire → commentaire manquant' },
  { key: 'comment_likes_user', table: 'comment_likes', column: 'user_id',  ref_table: 'users',  ref_column: 'id', label: 'likes commentaire → utilisateur manquant' },
  { key: 'poll_votes_poll',   table: 'poll_votes',    column: 'poll_id',   ref_table: 'polls',  ref_column: 'id', label: 'votes sondage → sondage manquant' },
  { key: 'poll_votes_user',   table: 'poll_votes',    column: 'user_id',   ref_table: 'users',  ref_column: 'id', label: 'votes sondage → utilisateur manquant' },
  { key: 'watch_events_user', table: 'watch_events',  column: 'user_id',  ref_table: 'users',  ref_column: 'id', label: 'événements vue → utilisateur manquant' },
  { key: 'watch_events_video', table: 'watch_events', column: 'video_id', ref_table: 'videos', ref_column: 'id', label: 'événements vue → vidéo manquante' },
  { key: 'video_views_viewer', table: 'video_views',  column: 'viewer_id', ref_table: 'users', ref_column: 'id', label: 'vues → spectateur manquant' },
  { key: 'gifts_to',          table: 'gifts',         column: 'to_id',     ref_table: 'users',  ref_column: 'id', label: 'cadeaux → destinataire manquant' },
  { key: 'gifts_from',        table: 'gifts',         column: 'from_id',   ref_table: 'users',  ref_column: 'id', label: 'cadeaux → expéditeur manquant' },
  { key: 'ledger_user',       table: 'ledger',        column: 'user_id',   ref_table: 'users',  ref_column: 'id', label: 'ledger → utilisateur manquant' },
];
function orphanWhere(c) {
  return `NOT EXISTS (SELECT 1 FROM ${c.ref_table} r WHERE r.${c.ref_column} = ${c.table}.${c.column})`;
}
app.get('/api/admin/integrity/orphans', async (req, res) => {
  try {
    if (!checkAdmin(req, res)) return;
    const checks = [];
    let total = 0;
    for (const c of ORPHAN_CHECKS) {
      let count = 0, sample = [];
      try {
        const r = await get1(`SELECT COUNT(*) AS c FROM ${c.table} WHERE ${orphanWhere(c)}`);
        count = Number(r ? r.c : 0);
        if (count > 0) sample = await allRows(`SELECT * FROM ${c.table} WHERE ${orphanWhere(c)} LIMIT 50`);
      } catch (e) { count = -1; } // table/colonne absente → marqué non supporté
      total += Math.max(0, count);
      checks.push({ key: c.key, label: c.label, table: c.table, column: c.column,
        ref_table: c.ref_table, ref_column: c.ref_column, count, sample });
    }
    res.json({ ok: true, total, checks });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.post('/api/admin/integrity/orphans/clean', async (req, res) => {
  try {
    if (!checkAdmin(req, res)) return;
    // B5 (2026-10-05) : SANS body (ou sans confirmation explicite) = simulation UNIQUEMENT.
    // Avant : `req.body && ...` valait undefined sans body → branche DESTRUCTRICE exécutée.
    const dry_run = !req.body || req.body.dry_run !== false; // défaut = simulation
    const cleaned = {};
    let total = 0;
    for (const c of ORPHAN_CHECKS) {
      let n = 0;
      try {
        if (dry_run) {
          const r = await get1(`SELECT COUNT(*) AS c FROM ${c.table} WHERE ${orphanWhere(c)}`);
          n = Number(r ? r.c : 0);
        } else {
          n = await runSqlChanges(`DELETE FROM ${c.table} WHERE ${orphanWhere(c)}`);
        }
      } catch (e) { n = -1; }
      cleaned[c.key] = n;
      total += Math.max(0, n);
    }
    res.json({ ok: true, dry_run, cleaned, total });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});

// ---------- v2.34 : compteurs dénormalisés vs réalité (admin) ----------
// Constat schéma (2026-10-04) : videos N'A PAS de colonne likes_count ni comments_count ;
// les seuls compteurs stockés avec table de détail sont videos.views (↔ video_views)
// et comments.likes (↔ comment_likes). users N'A PAS de followers_count.
// Les vérifications s'adaptent : toute colonne/table absente est marquée non supportée.
const COUNTER_CHECKS = [
  { key: 'videos_views',  table: 'videos',   pk: 'id', column: 'views', ref_table: 'video_views',  ref_column: 'video_id',   label: 'videos.views ↔ COUNT(video_views)' },
  { key: 'comments_likes',table: 'comments', pk: 'id', column: 'likes', ref_table: 'comment_likes',ref_column: 'comment_id', label: 'comments.likes ↔ COUNT(comment_likes)' },
];
app.get('/api/admin/integrity/counters', async (req, res) => {
  try {
    if (!checkAdmin(req, res)) return;
    const checks = [];
    let total = 0;
    for (const c of COUNTER_CHECKS) {
      let mismatches = [], supported = true, checked = 0;
      try {
        const cnt = await get1(`SELECT COUNT(*) AS c FROM ${c.table}`);
        checked = Number(cnt ? cnt.c : 0);
        mismatches = await allRows(
          `SELECT ${c.pk} AS id, COALESCE(${c.column},0) AS stored,` +
          ` (SELECT COUNT(*) FROM ${c.ref_table} r WHERE r.${c.ref_column} = t.${c.pk}) AS real` +
          ` FROM ${c.table} t WHERE COALESCE(t.${c.column},0) !=` +
          ` (SELECT COUNT(*) FROM ${c.ref_table} r WHERE r.${c.ref_column} = t.${c.pk}) LIMIT 100`);
      } catch (e) { supported = false; }
      total += mismatches.length;
      checks.push({ key: c.key, label: c.label, table: c.table, column: c.column,
        ref_table: c.ref_table, supported, checked, mismatch_count: mismatches.length, mismatches });
    }
    res.json({ ok: true, total_mismatches: total, checks });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.post('/api/admin/integrity/counters/fix', async (req, res) => {
  try {
    if (!checkAdmin(req, res)) return;
    // B5 (2026-10-05) : SANS body (ou sans confirmation explicite) = simulation UNIQUEMENT.
    const dry_run = !req.body || req.body.dry_run !== false; // défaut = simulation
    const fixed = {};
    let total = 0;
    for (const c of COUNTER_CHECKS) {
      let n = 0;
      try {
        const realExpr = `(SELECT COUNT(*) FROM ${c.ref_table} r WHERE r.${c.ref_column} = ${c.table}.${c.pk})`;
        if (dry_run) {
          const r = await get1(`SELECT COUNT(*) AS c FROM ${c.table} WHERE COALESCE(${c.column},0) != ${realExpr}`);
          n = Number(r ? r.c : 0);
        } else {
          n = await runSqlChanges(
            `UPDATE ${c.table} SET ${c.column} = ${realExpr} WHERE COALESCE(${c.column},0) != ${realExpr}`);
        }
      } catch (e) { n = -1; }
      fixed[c.key] = n;
      total += Math.max(0, n);
    }
    res.json({ ok: true, dry_run, fixed, total });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});

// ---------- v2.32 : 1 identité par installation — révision admin des doublons de device ----------
// Un device flagged=1 = vu sur ≥2 comptes distincts. Détection anti-fraude UNIQUEMENT :
// l'admin arbitre (faux positifs possibles : famille partageant un téléphone, réinstallation).
// Protégé comme /api/admin/withdrawals : en-tête x-admin-token.
app.get('/api/admin/devices/flagged', async (req, res) => {
  try {
    if (!checkAdmin(req, res)) return;
    const rows = await allRows('SELECT * FROM devices WHERE flagged=1 ORDER BY last_seen DESC');
    const out = [];
    for (const d of rows) {
      let ids = [];
      try { ids = JSON.parse(d.user_ids || '[]'); } catch (e) { ids = []; }
      const users = [];
      for (const id of ids) {
        const u = await get1('SELECT id,username,coins,created_at FROM users WHERE id=?', id);
        if (u) users.push(u);
      }
      out.push({ device_id: d.device_id, first_seen: Number(d.first_seen), last_seen: Number(d.last_seen),
        users, accounts: users.length });
    }
    res.json({ devices: out });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});

// ---------- v2.41 : anti-fraude — révision admin des alertes et de la réputation IP ----------
// Protégés comme /api/admin/withdrawals : en-tête x-admin-token.
app.get('/api/admin/fraud/alerts', async (req, res) => {
  try {
    if (!checkAdmin(req, res)) return;
    const rows = await allRows(
      'SELECT a.*, u.username FROM fraud_alerts a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.created_at DESC LIMIT 200');
    res.json({ alerts: rows.map(a => ({ id: a.id, type: a.type, user_id: a.user_id, username: a.username || null,
      ip: a.ip, detail: a.detail, created_at: Number(a.created_at) })) });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.get('/api/admin/fraud/ip', async (req, res) => {
  try {
    if (!checkAdmin(req, res)) return;
    const rows = await allRows('SELECT * FROM ip_reputation ORDER BY flagged DESC, accounts_count DESC LIMIT 200');
    res.json({ ips: rows.map(r => ({ ip: r.ip, accounts_count: Number(r.accounts_count), flagged: Number(r.flagged),
      first_seen: Number(r.first_seen), last_seen: Number(r.last_seen) })) });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});

// ==================== SERVEUR v9 : MVP phase 2 ====================
// ---------- notifications ----------
app.get('/api/notifications', auth, async (req, res) => {
  try {
    // PAGINATION 2026-10-04 : ?page=N (20/page)
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    // v2.41 : tri par priorité de type (mention > comment > like > follow > system, puis récent d'abord) ;
    // désactivable par l'utilisateur via la préf notif_priority=0 (chronologique seul).
    let prio = 1;
    try { const _up = await get1('SELECT notif_priority FROM users WHERE id=?', req.userId); if (_up && _up.notif_priority !== null && _up.notif_priority !== undefined) prio = Number(_up.notif_priority); } catch (_) {}
    const orderBy = prio
      ? `ORDER BY CASE type WHEN 'mention' THEN 0 WHEN 'comment' THEN 1 WHEN 'like' THEN 2 WHEN 'follow' THEN 3 WHEN 'follow_request' THEN 3 WHEN 'follow_accepted' THEN 3 WHEN 'system' THEN 4 ELSE 5 END, created_at DESC, id DESC`
      : `ORDER BY created_at DESC, id DESC`;
    const rows = await allRows('SELECT * FROM notifications WHERE user_id=? ' + orderBy + ' LIMIT 20 OFFSET ' + ((page - 1) * 20), req.userId);
    const out = [];
    for (const n of rows) {
      const actor = n.actor_id ? await get1('SELECT * FROM users WHERE id=?', n.actor_id) : null;
      const vid = n.video_id ? await get1('SELECT * FROM videos WHERE id=?', n.video_id) : null;
      out.push({
        id: n.id, type: n.type, text: n.text || '', title: n.title || '', is_read: !!n.is_read,
        comment_id: n.comment_id || null, // v2.31 : ouvre le commentaire exact (mention / réponse)
        created_at: Number(n.created_at),
        actor: actor ? pubUser(actor) : null,
        video: vid ? { id: vid.id, thumb: fileUrl(vid.file) } : null,
      });
    }
    res.json({ notifications: out, page, has_more: rows.length >= 20 });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// v1.56 : notifications non lues pour le poller natif (push serveur, pas seulement local)
app.get('/api/notifications/unread', auth, async (req, res) => {
  try {
    const since = Number(req.query.since) || 0;
    const rows = await allRows(
      'SELECT * FROM notifications WHERE user_id=? AND is_read=0 AND id>? ORDER BY id ASC LIMIT 10',
      req.userId, since);
    const out = [];
    for (const n of rows) {
      const actor = n.actor_id ? await get1('SELECT username FROM users WHERE id=?', n.actor_id) : null;
      out.push({ id: Number(n.id), type: n.type, title: n.title || '', text: n.text || '',
        created_at: Number(n.created_at),
        actor: actor ? { username: actor.username } : null });
    }
    res.json({ notifications: out });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});

app.post('/api/notifications/read', auth, async (req, res) => {
  try {
    const id = Number((req.body || {}).id) || 0;
    if (id) await runSql('UPDATE notifications SET is_read=1 WHERE id=? AND user_id=?', id, req.userId);
    else await runSql('UPDATE notifications SET is_read=1 WHERE user_id=?', req.userId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// v2.24 : historique d'activité sur le serveur (pas seulement local)
app.get('/api/activities', auth, async (req, res) => {
  try {
    // PAGINATION 2026-10-04 : ?page=N (50/page)
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const rows = await allRows('SELECT * FROM activities WHERE user_id=? ORDER BY created_at DESC LIMIT 50 OFFSET ' + ((page - 1) * 50), req.userId);
    res.json({ activities: rows.map(function(r){ return {i: r.icon, t: r.text, ts: Number(r.created_at)}; }), page, has_more: rows.length >= 50 });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.post('/api/activities', auth, async (req, res) => {
  try {
    const icon = String((req.body || {}).icon || '').slice(0, 10);
    const text = String((req.body || {}).text || '').slice(0, 500);
    if (!text) return res.status(400).json({ error: 'texte requis' });
    await runSql('INSERT INTO activities(user_id, icon, text, created_at) VALUES(?,?,?,?)', req.userId, icon, text, Date.now());
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.get('/api/notifications/unread-count', auth, async (req, res) => {
  try {
    const c = await get1('SELECT COUNT(*) AS c FROM notifications WHERE user_id=? AND is_read=0', req.userId);
    res.json({ unread: Number(c.c) });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// v2.31 : annonce admin → notification 'system' pour TOUS les utilisateurs (insert direct : pas de FCM de masse, pas de filtre prefs)
app.post('/api/admin/announce', async (req, res) => {
  try {
    const t = req.headers['x-admin-token'];
    if (!process.env.ADMIN_TOKEN || t !== process.env.ADMIN_TOKEN) return res.status(403).json({ error: 'non autorisé' });
    const title = String((req.body || {}).title || '').slice(0, 100);
    const text = String((req.body || {}).text || '').slice(0, 200);
    if (!text) return res.status(400).json({ error: 'texte requis' });
    const users = await allRows('SELECT id FROM users');
    const ts = now();
    let n = 0;
    for (const u of users) {
      try {
        await insertId('INSERT INTO notifications(user_id,type,actor_id,video_id,comment_id,title,text,is_read,created_at) VALUES(?,?,NULL,NULL,NULL,?,?,0,?)',
          u.id, 'system', title, text, ts);
        n++;
      } catch (_) {}
    }
    // v2.33 : push FCM de masse en arrière-plan (par vagues ~50/s, sans bloquer la réponse ;
    // en mode test les envois sont stubbés mais l'appel est journalisé pour le bot)
    (async () => {
      try {
        const targets = await allRows("SELECT id FROM users WHERE fcm_token IS NOT NULL AND fcm_token != ''");
        for (const tg of targets) {
          try { await sendFcmPush(tg.id, title || 'VidiGagne', text, { type: 'system', announce: '1' }); } catch (_) {}
          await new Promise(r => setTimeout(r, 20));
        }
      } catch (_) {}
    })();
    res.json({ ok: true, sent: n });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});

// ---------- signalements ----------
app.post('/api/reports', auth, async (req, res) => {
  try {
    const target_type = String((req.body || {}).target_type || '');
    const target_id = Number((req.body || {}).target_id) || 0;
    const reason = String((req.body || {}).reason || '').trim().slice(0, 500);
    if (!['video', 'user', 'comment', 'message'].includes(target_type))
      return res.status(400).json({ error: 'type de cible invalide' });
    if (!target_id) return res.status(400).json({ error: 'cible requise' });
    const id = await insertId(
      'INSERT INTO reports(reporter_id,target_type,target_id,reason,status,created_at) VALUES(?,?,?,?,?,?)',
      req.userId, target_type, target_id, reason, 'pending', now());
    res.json({ ok: true, id });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.get('/api/admin/reports', adminAuth, async (req, res) => {
  try {
    const status = String(req.query.status || 'pending');
    if (!['pending', 'dismissed', 'resolved'].includes(status))
      return res.status(400).json({ error: 'statut invalide' });
    const rows = await allRows('SELECT * FROM reports WHERE status=? ORDER BY created_at DESC LIMIT 100', status);
    res.json({ reports: rows.map(r => ({ ...r, created_at: Number(r.created_at) })) });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// auteur d'une cible signalée (pour suspend_user)
async function reportAuthor(r) {
  try {
    if (r.target_type === 'user') return await get1('SELECT * FROM users WHERE id=?', r.target_id);
    let uid = null;
    if (r.target_type === 'video') {
      const v = await get1('SELECT user_id FROM videos WHERE id=?', r.target_id);
      uid = v && v.user_id;
    } else if (r.target_type === 'comment') {
      const c = await get1('SELECT user_id FROM comments WHERE id=?', r.target_id);
      uid = c && c.user_id;
    } else if (r.target_type === 'message') {
      const m = await get1('SELECT sender_id FROM messages WHERE id=?', r.target_id);
      uid = m && m.sender_id;
    }
    return uid ? await get1('SELECT * FROM users WHERE id=?', uid) : null;
  } catch (e) { return null; }
}
app.post('/api/admin/reports/:id/review', adminAuth, async (req, res) => {
  try {
    const r = await get1('SELECT * FROM reports WHERE id=?', req.params.id);
    if (!r) return res.status(404).json({ error: 'signalement introuvable' });
    const action = String((req.body || {}).action || '');
    if (!['dismiss', 'hide_video', 'suspend_user'].includes(action))
      return res.status(400).json({ error: 'action invalide' });
    if (action === 'dismiss') {
      await runSql("UPDATE reports SET status='dismissed', action='dismiss' WHERE id=?", r.id);
    } else if (action === 'hide_video') {
      if (r.target_type === 'video') await runSql('UPDATE videos SET hidden=1 WHERE id=?', r.target_id);
      else if (r.target_type === 'comment') await runSql('DELETE FROM comments WHERE id=?', r.target_id);
      else if (r.target_type === 'message') await runSql('DELETE FROM messages WHERE id=?', r.target_id);
      else if (r.target_type === 'user') await runSql('UPDATE videos SET hidden=1 WHERE user_id=?', r.target_id);
      await runSql("UPDATE reports SET status='resolved', action='hide_video' WHERE id=?", r.id);
    } else if (action === 'suspend_user') {
      const author = await reportAuthor(r);
      if (author) await runSql('UPDATE users SET suspended=1 WHERE id=?', author.id);
      await runSql("UPDATE reports SET status='resolved', action='suspend_user' WHERE id=?", r.id);
    }
    // v2.33 : prévient le signaleur (e-mail + notif/push) et le compte suspendu (e-mail + notif/push)
    try {
      const rep = await get1('SELECT id, email, username FROM users WHERE id=?', r.reporter_id);
      const actionFr = action === 'dismiss' ? 'classé sans suite'
        : action === 'hide_video' ? 'validé — le contenu signalé a été retiré'
        : 'validé — le compte fautif a été suspendu';
      if (rep) {
        await notify(rep.id, 'report', null, null, '🛡️ Ton signalement a été traité : ' + actionFr + '.');
        if (rep.email) sendVidiEmail(rep.email,
          '🛡️ Ton signalement a été traité — VidiGagne',
          '<p style="font-size:18px">🛡️ Merci pour ton signalement</p>'
          + '<p style="color:#ccc;font-size:14px">Notre équipe a examiné ton signalement : il a été <b>' + actionFr + '</b>.</p>'
          + '<p style="color:#999;font-size:12px">Merci de contribuer à une communauté saine. ✨</p>',
          'Ton signalement VidiGagne a été traité : ' + actionFr + '.').catch(() => {});
      }
      if (action === 'suspend_user') {
        const sus = await reportAuthor(r);
        if (sus) {
          await notify(sus.id, 'security', null, null, '🚫 Ton compte a été suspendu suite à un signalement validé.');
          if (sus.email) sendVidiEmail(sus.email,
            '🚫 Compte suspendu — VidiGagne',
            '<p style="font-size:18px">🚫 Compte suspendu</p>'
            + '<p style="color:#ccc;font-size:14px">Ton compte VidiGagne a été suspendu suite à un signalement validé par notre équipe.</p>'
            + '<p style="color:#999;font-size:12px">Si tu penses qu\'il s\'agit d\'une erreur, contacte le support VidiGagne.</p>',
            'Ton compte VidiGagne a été suspendu.').catch(() => {});
        }
      }
    } catch (_) {}
    res.json({ ok: true, action });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});

// ---------- appels contre une sanction (v2.39) ----------
// Un compte suspendu doit pouvoir contester : auth sans le blocage "suspendu"
async function authSoft(req, res, next) {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer (.+)$/);
  if (!m) return res.status(401).json({ error: 'token requis' });
  const row = await get1('SELECT t.user_id, t.created_at FROM tokens t WHERE t.token=?', m[1]);
  if (!row) return res.status(401).json({ error: 'token invalide' });
  if (Number(row.created_at) < now() - 90 * 86400000) {
    await runSql('DELETE FROM tokens WHERE token=?', m[1]);
    return res.status(401).json({ error: 'session expirée' });
  }
  req.userId = row.user_id;
  req.token = m[1];
  next();
}
// sanction résolue visant cet utilisateur ?
function sanctionLabel(r) {
  if (r.action === 'suspend_user') return '🚫 Compte suspendu';
  if (r.action === 'hide_video') {
    if (r.target_type === 'video') return '🙈 Vidéo #' + r.target_id + ' masquée';
    if (r.target_type === 'user') return '🙈 Vidéos du compte masquées';
    return '🙈 Contenu supprimé (' + r.target_type + ' #' + r.target_id + ')';
  }
  return r.action || 'sanction';
}
app.post('/api/appeals', authSoft, async (req, res) => {
  try {
    const report_id = Number((req.body || {}).report_id) || 0;
    const reason = String((req.body || {}).reason || '').trim().slice(0, 500);
    if (!report_id) return res.status(400).json({ error: 'signalement requis' });
    if (reason.length < 3) return res.status(400).json({ error: 'explique pourquoi tu contestes (3 caractères min)' });
    const r = await get1('SELECT * FROM reports WHERE id=?', report_id);
    if (!r) return res.status(404).json({ error: 'signalement introuvable' });
    if (r.status !== 'resolved' || !['hide_video', 'suspend_user'].includes(r.action))
      return res.status(400).json({ error: 'aucune sanction à contester sur ce signalement' });
    const author = await reportAuthor(r);
    if (!author || Number(author.id) !== Number(req.userId))
      return res.status(403).json({ error: 'cette sanction ne te concerne pas' });
    const dup = await get1("SELECT id FROM appeals WHERE report_id=? AND status IN ('pending','upheld','overturned')", report_id);
    if (dup) return res.status(409).json({ error: 'un appel existe déjà pour cette sanction' });
    const id = await insertId(
      'INSERT INTO appeals(user_id,report_id,reason,status,created_at) VALUES(?,?,?,?,?)',
      req.userId, report_id, reason, 'pending', now());
    res.json({ ok: true, id });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.get('/api/appeals/mine', authSoft, async (req, res) => {
  try {
    const rows = await allRows(
      `SELECT a.*, r.target_type, r.target_id, r.action, r.reason AS report_reason, r.created_at AS sanction_at
       FROM appeals a JOIN reports r ON r.id=a.report_id
       WHERE a.user_id=? ORDER BY a.created_at DESC`, req.userId);
    const appeals = rows.map(a => ({
      id: a.id, report_id: a.report_id, reason: a.reason, status: a.status,
      created_at: Number(a.created_at), decided_at: a.decided_at ? Number(a.decided_at) : null,
      sanction: sanctionLabel(a),
    }));
    // sanctions en cours (signalements résolus avec sanction me visant)
    const srows = await allRows(
      `SELECT * FROM reports WHERE status='resolved' AND action IN ('hide_video','suspend_user') ORDER BY created_at DESC LIMIT 200`);
    const sanctions = [];
    for (const sr of srows) {
      const author = await reportAuthor(sr);
      if (author && Number(author.id) === Number(req.userId)) {
        const ap = await get1('SELECT id, status FROM appeals WHERE report_id=? ORDER BY id DESC LIMIT 1', sr.id);
        sanctions.push({
          report_id: sr.id, label: sanctionLabel(sr), action: sr.action,
          target_type: sr.target_type, target_id: sr.target_id,
          // FIX UX 2026-10-05 (parcours modération) : le motif était absent → l'utilisateur
          // sanctionné ne comprenait pas pourquoi. Maintenant affiché dans le panneau.
          reason: sr.reason || '',
          created_at: Number(sr.created_at),
          appeal_id: ap ? ap.id : null, appeal_status: ap ? ap.status : null,
        });
      }
    }
    res.json({ appeals, sanctions });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.get('/api/admin/appeals', adminAuth, async (req, res) => {
  try {
    const status = String(req.query.status || 'pending');
    if (!['pending', 'upheld', 'overturned'].includes(status))
      return res.status(400).json({ error: 'statut invalide' });
    const rows = await allRows(
      `SELECT a.*, u.username, r.target_type, r.target_id, r.action
       FROM appeals a JOIN users u ON u.id=a.user_id JOIN reports r ON r.id=a.report_id
       WHERE a.status=? ORDER BY a.created_at DESC LIMIT 100`, status);
    res.json({ appeals: rows.map(a => ({ ...a, created_at: Number(a.created_at),
      decided_at: a.decided_at ? Number(a.decided_at) : null, sanction: sanctionLabel(a) })) });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.post('/api/admin/appeals/:id/review', adminAuth, async (req, res) => {
  try {
    const a = await get1('SELECT * FROM appeals WHERE id=?', req.params.id);
    if (!a) return res.status(404).json({ error: 'appel introuvable' });
    if (a.status !== 'pending') return res.status(409).json({ error: 'appel déjà traité' });
    const action = String((req.body || {}).action || '');
    if (!['uphold', 'overturn'].includes(action))
      return res.status(400).json({ error: 'action invalide' });
    const r = await get1('SELECT * FROM reports WHERE id=?', a.report_id);
    if (action === 'overturn') {
      // lève la sanction
      if (r && r.action === 'suspend_user') {
        const author = await reportAuthor(r);
        if (author) await runSql('UPDATE users SET suspended=0 WHERE id=?', author.id);
      } else if (r && r.action === 'hide_video') {
        if (r.target_type === 'video') await runSql("UPDATE videos SET hidden=0, review_status='ok' WHERE id=?", r.target_id);
        else if (r.target_type === 'user') await runSql("UPDATE videos SET hidden=0, review_status='ok' WHERE user_id=?", r.target_id);
        // commentaire/message : supprimés définitivement, rien à restaurer
      }
      await runSql("UPDATE appeals SET status='overturned', decided_at=? WHERE id=?", now(), a.id);
      try {
        await notify(a.user_id, 'system', null, null, '✅ Appel accepté : ta sanction a été levée. Merci de ta patience.');
        const ue = await get1('SELECT email FROM users WHERE id=?', a.user_id);
        if (ue && ue.email) sendVidiEmail(ue.email, '✅ Appel accepté — VidiGagne',
          '<p style="font-size:18px">✅ Bonne nouvelle !</p>'
          + '<p style="color:#ccc;font-size:14px">Après réexamen, ta sanction a été <b>levée</b>. Ton compte / contenu est de nouveau actif.</p>',
          'Ton appel VidiGagne a été accepté : la sanction est levée.').catch(() => {});
      } catch (_) {}
    } else {
      await runSql("UPDATE appeals SET status='upheld', decided_at=? WHERE id=?", now(), a.id);
      try {
        await notify(a.user_id, 'system', null, null, '📝 Appel examiné : la sanction est maintenue.');
        const ue = await get1('SELECT email FROM users WHERE id=?', a.user_id);
        if (ue && ue.email) sendVidiEmail(ue.email, '📝 Appel examiné — VidiGagne',
          '<p style="font-size:18px">📝 Appel examiné</p>'
          + '<p style="color:#ccc;font-size:14px">Après réexamen, la sanction est <b>maintenue</b>. Merci de respecter les règles de la communauté.</p>',
          'Ton appel VidiGagne a été examiné : la sanction est maintenue.').catch(() => {});
      } catch (_) {}
    }
    res.json({ ok: true, action });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
async function collOf(id, userId) {
  const c = await get1('SELECT * FROM collections WHERE id=?', id);
  if (!c) return null;
  if (Number(c.user_id) !== Number(userId)) return null;
  return c;
}
app.post('/api/collections', auth, async (req, res) => {
  try {
    const name = String((req.body || {}).name || '').trim().slice(0, 60);
    if (!name) return res.status(400).json({ error: 'nom requis' });
    const id = await insertId('INSERT INTO collections(user_id,name,is_private,created_at) VALUES(?,?,0,?)',
      req.userId, name, now());
    res.json({ ok: true, id });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.get('/api/collections', auth, async (req, res) => {
  try {
    const rows = await allRows('SELECT * FROM collections WHERE user_id=? ORDER BY created_at DESC', req.userId);
    const out = [];
    for (const c of rows) {
      const n = await get1('SELECT COUNT(*) AS c FROM collection_items WHERE collection_id=?', c.id);
      out.push({ id: c.id, name: c.name, is_private: !!c.is_private, count: Number(n.c), created_at: Number(c.created_at) });
    }
    res.json({ collections: out });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.patch('/api/collections/:id', auth, async (req, res) => {
  try {
    const c = await collOf(req.params.id, req.userId);
    if (!c) return res.status(404).json({ error: 'collection introuvable' });
    const b = req.body || {};
    if (b.name !== undefined) {
      const name = String(b.name).trim().slice(0, 60);
      if (!name) return res.status(400).json({ error: 'nom requis' });
      await runSql('UPDATE collections SET name=? WHERE id=?', name, c.id);
    }
    if (b.is_private !== undefined)
      await runSql('UPDATE collections SET is_private=? WHERE id=?', b.is_private ? 1 : 0, c.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.delete('/api/collections/:id', auth, async (req, res) => {
  try {
    const c = await collOf(req.params.id, req.userId);
    if (!c) return res.status(404).json({ error: 'collection introuvable' });
    await runSql('DELETE FROM collection_items WHERE collection_id=?', c.id);
    await runSql('DELETE FROM collections WHERE id=?', c.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.post('/api/collections/:id/items', auth, async (req, res) => {
  try {
    const c = await collOf(req.params.id, req.userId);
    if (!c) return res.status(404).json({ error: 'collection introuvable' });
    const video_id = Number((req.body || {}).video_id) || 0;
    const v = await get1('SELECT 1 FROM videos WHERE id=?', video_id);
    if (!v) return res.status(404).json({ error: 'vidéo introuvable' });
    await insertIgnore('INSERT OR IGNORE INTO collection_items(collection_id,video_id,added_at) VALUES(?,?,?)',
      c.id, video_id, now());
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.delete('/api/collections/:id/items/:video_id', auth, async (req, res) => {
  try {
    const c = await collOf(req.params.id, req.userId);
    if (!c) return res.status(404).json({ error: 'collection introuvable' });
    await runSql('DELETE FROM collection_items WHERE collection_id=? AND video_id=?', c.id, req.params.video_id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.get('/api/collections/:id', async (req, res) => {
  try {
    const c = await get1('SELECT * FROM collections WHERE id=?', req.params.id);
    if (!c) return res.status(404).json({ error: 'collection introuvable' });
    const meId = await optUserId(req);
    if (Number(c.is_private) && (!meId || Number(meId) !== Number(c.user_id)))
      return res.status(403).json({ error: 'collection privée' });
    const items = await allRows('SELECT video_id FROM collection_items WHERE collection_id=? ORDER BY added_at DESC', c.id);
    const videos = [];
    for (const it of items) {
      const v = await get1('SELECT * FROM videos WHERE id=? AND hidden=0', it.video_id);
      if (v) { const j = await videoJSON(v, meId); if (j) videos.push(j); }
    }
    res.json({ collection: { id: c.id, name: c.name, is_private: !!c.is_private, videos } });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});

// ---------- partage de collection par code (entre 2 appareils) ----------
app.post('/api/collections/:id/share', auth, async (req, res) => {
  try {
    const c = await collOf(req.params.id, req.userId);
    if (!c) return res.status(404).json({ error: 'collection introuvable' });
    let code = '';
    for (let i = 0; i < 5 && !code; i++) {
      const cand = 'VG-SHARE-' + Math.random().toString(36).slice(2, 8).toUpperCase();
      const ex = await get1('SELECT 1 FROM collection_shares WHERE share_code=?', cand);
      if (!ex) code = cand;
    }
    if (!code) return res.status(500).json({ error: 'réessaie' });
    await runSql('INSERT INTO collection_shares(collection_id,owner_id,share_code,created_at) VALUES(?,?,?,?)',
      c.id, req.userId, code, now());
    res.json({ ok: true, code });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.get('/api/shared/:code', async (req, res) => {
  try {
    const sh = await get1('SELECT * FROM collection_shares WHERE share_code=?',
      String(req.params.code || '').trim().toUpperCase());
    if (!sh) return res.status(404).json({ error: 'code invalide' });
    const c = await get1('SELECT * FROM collections WHERE id=?', sh.collection_id);
    if (!c) return res.status(404).json({ error: 'collection introuvable' });
    const meId = await optUserId(req);
    const items = await allRows('SELECT video_id FROM collection_items WHERE collection_id=? ORDER BY added_at DESC', c.id);
    const videos = [];
    for (const it of items) {
      const v = await get1('SELECT * FROM videos WHERE id=? AND hidden=0', it.video_id);
      if (v) { const j = await videoJSON(v, meId); if (j) videos.push(j); }
    }
    res.json({ ok: true, collection: { id: c.id, name: c.name }, owner_id: Number(sh.owner_id), videos });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});

// v1.68 : réponses vidéo aux commentaires (façon TikTok)
app.post('/api/comments/:id/video-reply', auth, upload.single('video'), async (req, res) => {
  try {
    const c = await get1('SELECT * FROM comments WHERE id=?', req.params.id);
    if (!c) return res.status(404).json({ error: 'commentaire introuvable' });
    const v = await get1('SELECT user_id FROM videos WHERE id=?', c.video_id);
    if (!v || Number(v.user_id) !== Number(req.userId))
      return res.status(403).json({ error: 'seul le créateur peut répondre en vidéo' });
    if (!req.file) return res.status(400).json({ error: 'vidéo requise' });
    // upload via le même pipeline que /api/videos (simplifié : stocke et crée la vidéo)
    const fname = 'v' + Date.now() + '_' + Math.random().toString(36).slice(2, 8) + '.mp4';
    let fileUrl = '';
    if (USE_CLOUDINARY && cloudinary) {
      const up = await new Promise((resolve, reject) => {
        const st = cloudinary.uploader.upload_stream(
          { resource_type: 'video', folder: 'vidigagne/videos', format: 'mp4' },
          (err, r) => err ? reject(err) : resolve(r));
        st.end(req.file.buffer);
      });
      fileUrl = up.secure_url;
    } else { fs.renameSync(req.file.path, path.join(UP, fname)); fileUrl = fname; }
    const descText = '🎬 Réponse à @' + (c.username || 'commentaire');
    const vid = await insertId(
      `INSERT INTO videos(user_id,file,description,visibility,reply_to_comment_id,created_at)
       VALUES(?,?,?,?,?,?)`, req.userId, fileUrl, descText, 'public', c.id, now());
    await runSql('UPDATE comments SET video_reply_id=? WHERE id=?', vid, c.id);
    await notify(c.user_id, 'video_reply', req.userId, vid, String(c.id));
    res.json({ ok: true, video_id: vid });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// v1.68 : classements par pays (top vidéos + top créateurs)
app.get('/api/rankings/:country', async (req, res) => {
  try {
    const country = String(req.params.country || '').toUpperCase().slice(0, 2);
    if (!/^[A-Z]{2}$/.test(country)) return res.status(400).json({ error: 'pays invalide' });
    const meId = await optUserId(req);
    // top vidéos : celles ciblées vers ce pays OU créées par des utilisateurs de ce pays
    const vids = await allRows(`SELECT v.* FROM videos v LEFT JOIN users u ON u.id=v.user_id
      WHERE v.hidden=0 AND (v.scheduled_at IS NULL OR v.scheduled_at <= ?)
      AND (v.target_countries LIKE ? OR u.country=?)
      ORDER BY v.views DESC LIMIT 20`, now(), '%"' + country + '"%', country);
    const videos = [];
    for (const v of vids) {
      if (!(await canSeeVideo(v, meId))) continue;
      const j = await videoJSON(v, meId);
      if (j) videos.push(j);
      if (videos.length >= 10) break;
    }
    // top créateurs du pays (par abonnés)
    const creators = await allRows(`SELECT u.id, u.username, u.name, u.avatar, u.verified,
      (SELECT COUNT(*) FROM follows WHERE followed_id=u.id) AS followers,
      (SELECT COALESCE(SUM(views),0) FROM videos WHERE user_id=u.id AND hidden=0) AS views
      FROM users u WHERE u.country=? ORDER BY followers DESC LIMIT 10`, country);
    res.json({ country, videos, creators });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// v1.68 : vrai push système FCM
app.post('/api/push/fcm-token', auth, async (req, res) => {
  try {
    const token = String((req.body || {}).token || '').slice(0, 500);
    if (!token) return res.status(400).json({ error: 'token requis' });
    await runSql('UPDATE users SET fcm_token=? WHERE id=?', token, req.userId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// v2.53 : init Firebase Admin — accepte GOOGLE_APPLICATION_CREDENTIALS (chemin fichier)
// OU FIREBASE_SERVICE_ACCOUNT_JSON (contenu JSON brut, pratique sur Railway).
function fcmAdmin() {
  const adm = require('firebase-admin');
  if (adm.apps.length) return adm;
  const rawJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (rawJson) {
    const creds = JSON.parse(rawJson);
    adm.initializeApp({ credential: adm.credential.cert(creds) });
  } else {
    adm.initializeApp({ credential: adm.credential.applicationDefault() });
  }
  return adm;
}
function fcmCredsSet() {
  return !!(process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
}
// envoie un push FCM (utilise Firebase Admin SDK si configuré, sinon log)
let _fcmAdmin = null;
async function sendFcmPush(userId, title, body, data) {
  try {
    const u = await get1('SELECT fcm_token FROM users WHERE id=?', userId);
    if (!u || !u.fcm_token) return { sent: false, reason: 'no_token' };
    // v2.33 : journalise la tentative (le bot de test vérifie l'appel, pas l'envoi réel)
    _pushAttempts.push({ user_id: Number(userId), title: String(title).slice(0, 100),
      body: String(body).slice(0, 200), at: Date.now() });
    if (_pushAttempts.length > 500) _pushAttempts.shift();
    if (VG_TEST_HOOKS) return { sent: false, reason: 'stubbed' };
    // Firebase Admin SDK (GOOGLE_APPLICATION_CREDENTIALS ou FIREBASE_SERVICE_ACCOUNT_JSON)
    try { _fcmAdmin = fcmAdmin(); } catch (e) { return { sent: false, reason: 'fcm_init: ' + String((e && e.message) || e).slice(0, 80) }; }
    await _fcmAdmin.messaging().send({
      token: u.fcm_token,
      notification: { title: String(title).slice(0, 100), body: String(body).slice(0, 200) },
      data: data || {},
    });
    return { sent: true };
  } catch (e) { return { sent: false, reason: e.message.slice(0, 100) }; }
}

// ---------- notifications motivationnelles (campagnes quotidiennes par vagues) ----------
const CAMPAIGN_MSGS = {
  go_live: [
    { t: '\uD83D\uDD34 Passe en live !', b: 'Lance ton live maintenant et gagne des pi\u00E8ces avec tes fans \uD83C\uDF81' },
    { t: '\uD83C\uDF81 Tes fans t\u2019attendent', b: 'Passe en live et re\u00E7ois des cadeaux en pi\u00E8ces !' },
    { t: '\uD83D\uDCB0 Les lives rapportent gros', b: '\u00C0 toi de jouer : d\u00E9marre ton live et encaisse !' },
    { t: '\uD83D\uDD34 C\u2019est le moment !', b: 'Un live maintenant = plus de succ\u00E8s sur VidiGagne \uD83D\uDE80' },
  ],
  invite: [
    { t: '\uD83D\uDC68\u200D\uD83D\uDC69\u200D\uD83D\uDC67 Invite tes proches !', b: 'Famille et amis sur VidiGagne = +50 pi\u00E8ces par ami \uD83C\uDF89' },
    { t: '\uD83C\uDF89 Plus d\u2019amis, plus de pi\u00E8ces', b: 'Invite tes amis et gagne +50 pi\u00E8ces chacun !' },
    { t: '\uD83D\uDCB8 Tes amis = ton argent', b: 'Partage ton code parrainage et gagne +50 pi\u00E8ces par ami' },
  ]
};
function userLocalHour(tz) {
  try {
    const h = new Intl.DateTimeFormat('en-US', { timeZone: tz || 'America/Port-au-Prince', hour: 'numeric', hour12: false }).format(new Date());
    return parseInt(h, 10) % 24;
  } catch (_) { return 12; }
}
function nextMorning8(tz) {
  // prochain 8h00 heure locale de l'utilisateur (approx via offset)
  try {
    const nowMs = Date.now();
    for (let addH = 1; addH <= 30; addH++) {
      const h = new Intl.DateTimeFormat('en-US', { timeZone: tz || 'America/Port-au-Prince', hour: 'numeric', hour12: false }).format(new Date(nowMs + addH * 3600000));
      if (parseInt(h, 10) % 24 === 8) return nowMs + addH * 3600000;
    }
  } catch (_) {}
  return Date.now() + 8 * 3600000;
}
async function scheduleDailyCampaigns() {
  try {
    const day = new Date().toISOString().slice(0, 10);
    const existing = await get1('SELECT id FROM notif_campaigns WHERE day=? LIMIT 1', day);
    if (existing) return { ok: true, skipped: true };
    const users = await allRows("SELECT id FROM users WHERE fcm_token IS NOT NULL AND fcm_token != '' AND (campaign_notifs IS NULL OR campaign_notifs=1)");
    if (!users.length) return { ok: true, users: 0 };
    // mélange aléatoire
    for (let i = users.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = users[i]; users[i] = users[j]; users[j] = t; }
    const nowMs = Date.now();
    const SPREAD_H = 6, SLOTS = SPREAD_H * 6; // 6h étalées, 1 vague / 10 min
    const perSlot = Math.max(1, Math.ceil(users.length / SLOTS));
    let qi = 0;
    for (const type of ['go_live', 'invite']) {
      const pool = CAMPAIGN_MSGS[type];
      const m = pool[Math.floor(Math.random() * pool.length)];
      const cid = await insertId('INSERT INTO notif_campaigns(type,title,body,day,status,created_at) VALUES(?,?,?,?,?,?)',
        type, m.t, m.b, day, 'sending', nowMs);
      let slot = 0, inSlot = 0;
      for (const u of users) {
        const sched = nowMs + slot * 600000 + Math.floor(Math.random() * 600000);
        await runSql('INSERT INTO notif_queue(campaign_id,user_id,scheduled_at,sent_at,created_at) VALUES(?,?,?,?,?)',
          cid, u.id, sched, null, nowMs);
        if (++inSlot >= perSlot) { inSlot = 0; slot++; }
        qi++;
      }
    }
    console.log('campagnes notif du jour planifiées:', qi, 'envois en vagues');
    return { ok: true, queued: qi };
  } catch (e) { console.error('scheduleDailyCampaigns:', e.message); return { ok: false }; }
}
// ---------- v2.48 (SPEC-08) : rappels intelligents de rétention ----------
// kinds : winback (inactif 7j+), creator_idle (rien publié depuis 14j), streak_risk (flamme en danger)
// planificateur premieres : H-15 (premiere_soon) puis bascule live (premiere_live) à l'heure
async function updatePremieres() {
  try {
    const t = now();
    const dueSoon = await allRows(
      `SELECT p.video_id, p.creator_id FROM premieres p
       WHERE p.status='scheduled' AND p.scheduled_at>? AND p.scheduled_at<=?`, t, t + 15 * 60000);
    for (const p of dueSoon) {
      const rems = await allRows('SELECT user_id FROM premiere_reminders WHERE video_id=?', p.video_id);
      for (const r of rems) {
        const already = await get1(`SELECT 1 FROM notifications WHERE user_id=? AND type='premiere_soon' AND video_id=?`, r.user_id, p.video_id);
        if (!already) await notify(r.user_id, 'premiere_soon', p.creator_id, p.video_id, 'Ça commence dans 15 minutes ⏰', null);
      }
    }
    const dueLive = await allRows(`SELECT video_id, creator_id FROM premieres WHERE status='scheduled' AND scheduled_at<=?`, t);
    for (const p of dueLive) {
      // FIX temps 2026-10-05 (T1) : l'UPDATE est conditionnel mais on notifiait SANS vérifier
      // qu'il a vraiment changé une ligne → 2 exécutions concurrentes (Postgres, restart)
      // notifiaient 2×. Maintenant : on ne notifie que si la transition a eu lieu.
      const changed = await runSqlChanges(`UPDATE premieres SET status='live' WHERE video_id=? AND status='scheduled'`, p.video_id);
      if (!changed) continue;
      await runSql('UPDATE videos SET scheduled_at=NULL WHERE id=?', p.video_id);
      const rems = await allRows('SELECT user_id FROM premiere_reminders WHERE video_id=?', p.video_id);
      for (const r of rems) await notify(r.user_id, 'premiere_live', p.creator_id, p.video_id, 'La premiere commence maintenant 🔴', null);
    }
  } catch (e) { console.error('updatePremieres:', e.message); }
}
// FIX temps 2026-10-05 (T6) : les lives programmés expiraient silencieusement —
// le schéma prévoyait `notified` mais aucun traitement ne tournait à l'heure prévue.
// Maintenant : à l'heure prévue, les abonnés reçoivent « le live commence 🔴 ».
async function updateScheduledLives() {
  try {
    const t = now();
    const due = await allRows(`SELECT id, user_id, title FROM live_scheduled WHERE cancelled=0 AND notified=0 AND scheduled_at<=?`, t);
    for (const s of due) {
      const changed = await runSqlChanges(`UPDATE live_scheduled SET notified=1 WHERE id=? AND notified=0`, s.id);
      if (!changed) continue; // déjà traité par une exécution concurrente
      const followers = await allRows('SELECT follower_id FROM follows WHERE followed_id=?', s.user_id);
      const me = await get1('SELECT username FROM users WHERE id=?', s.user_id);
      for (const f of (followers || [])) {
        await notify(f.follower_id, 'live_started', s.user_id, null,
          '@' + (me ? me.username : '?') + ' est en live : ' + s.title + ' 🔴', null);
      }
    }
  } catch (e) { console.error('updateScheduledLives:', e.message); }
}
async function scheduleNudges() {
  try {
    const t = now(), D = 86400000, H = 3600000;
    // plafond anti-spam : pas plus d'1 nudge / 48h par utilisateur
    const recent = await allRows('SELECT user_id, MAX(sent_at) AS s FROM retention_nudges WHERE sent_at IS NOT NULL GROUP BY user_id');
    const recentSet = new Set(recent.filter(r => Number(r.s) > t - 48 * H).map(r => Number(r.user_id)));
    const users = await allRows('SELECT id, tz_offset, last_seen FROM users WHERE COALESCE(nudge_optout,0)=0 ORDER BY last_seen DESC LIMIT 500');
    for (const u of users) {
      if (recentSet.has(Number(u.id))) continue;
      // heures creuses : pas de push entre 23h et 7h heure locale (tz_offset en minutes)
      const localH = new Date(t + Number(u.tz_offset || 0) * 60000).getUTCHours();
      if (localH >= 23 || localH < 7) continue;
      const lastSeen = Number(u.last_seen) || 0;
      let kind = null, text = '';
      if (lastSeen && lastSeen < t - 7 * D) {
        kind = 'winback'; text = 'Tu nous manques ! Viens voir ce que tu as raté 🎬';
      } else {
        const vids = await get1('SELECT COUNT(*) AS c, MAX(created_at) AS m FROM videos WHERE user_id=?', u.id);
        if (Number(vids.c) > 0 && Number(vids.m) < t - 14 * D) {
          kind = 'creator_idle'; text = 'Tes abonnés attendent ta prochaine vidéo 🎥';
        } else {
          const st = await get1('SELECT streak FROM login_streaks WHERE user_id=?', u.id);
          if (st && Number(st.streak) >= 3 && lastSeen && lastSeen < t - 20 * H) {
            kind = 'streak_risk'; text = "Ta flamme 🔥 risque de s'éteindre — ouvre l'app !";
          }
        }
      }
      if (!kind) continue;
      const nid = await insertId('INSERT INTO retention_nudges(user_id,kind,scheduled_at,sent_at,created_at) VALUES(?,?,?,?,?)',
        u.id, kind, t, null, t);
      await notify(u.id, 'nudge_' + kind, null, null, text, null);
      await runSql('UPDATE retention_nudges SET sent_at=? WHERE id=?', now(), nid);
    }
  } catch (e) { console.error('scheduleNudges:', e.message); }
}
async function processNotifQueue() {
  try {
    const nowMs = Date.now();
    const dayStart = new Date(); dayStart.setUTCHours(0, 0, 0, 0);
    const due = await allRows(`SELECT q.id AS qid, q.user_id, q.campaign_id, c.type, c.title, c.body, u.tz,
      u.campaign_notifs, u.fcm_token FROM notif_queue q
      JOIN notif_campaigns c ON c.id=q.campaign_id JOIN users u ON u.id=q.user_id
      WHERE q.sent_at IS NULL AND q.scheduled_at <= ? ORDER BY q.scheduled_at ASC LIMIT 200`, nowMs);
    let sent = 0;
    for (const d of due) {
      try {
        if (!d.fcm_token || d.campaign_notifs === 0) { await runSql('UPDATE notif_queue SET sent_at=? WHERE id=?', nowMs, d.qid); continue; }
        // max 2/jour/utilisateur
        const c = await get1('SELECT COUNT(*) AS n FROM notif_queue WHERE user_id=? AND sent_at>=?', d.user_id, dayStart.getTime());
        if ((c.n || 0) >= 2) { await runSql('UPDATE notif_queue SET sent_at=? WHERE id=?', nowMs, d.qid); continue; }
        // pas la nuit : 8h-22h heure locale
        const h = userLocalHour(d.tz);
        if (h < 8 || h >= 22) { await runSql('UPDATE notif_queue SET scheduled_at=? WHERE id=?', nextMorning8(d.tz), d.qid); continue; }
        // voie principale : table notifications -> le poller NotifReceiver de l'app la délivre même app fermée
        try { await insertId('INSERT INTO notifications(user_id,type,actor_id,video_id,title,text,is_read,created_at) VALUES(?,?,?,?,?,?,0,?)', d.user_id, d.type, null, null, d.title, d.body, nowMs); } catch (_) {}
        const r = await sendFcmPush(d.user_id, d.title, d.body, { action: d.type === 'go_live' ? 'go_live' : 'invite', campaign_id: String(d.campaign_id) });
        await runSql('UPDATE notif_queue SET sent_at=? WHERE id=?', nowMs, d.qid);
        sent++;
      } catch (_) {}
    }
    // campagnes terminées ?
    const open = await allRows("SELECT c.id FROM notif_campaigns c WHERE c.status='sending' AND NOT EXISTS(SELECT 1 FROM notif_queue q WHERE q.campaign_id=c.id AND q.sent_at IS NULL)");
    for (const o of open) await runSql("UPDATE notif_campaigns SET status='done' WHERE id=?", o.id);
    if (sent) console.log('notifs campagne envoyées:', sent);
    return { ok: true, sent };
  } catch (e) { console.error('processNotifQueue:', e.message); return { ok: false }; }
}
// l'utilisateur règle ses notifs motivationnelles + son fuseau
app.post('/api/me/campaign-notifs', auth, async (req, res) => {
  try {
    const en = req.body && req.body.enabled === false ? 0 : 1;
    await runSql('UPDATE users SET campaign_notifs=? WHERE id=?', en, req.userId);
    res.json({ ok: true, enabled: !!en });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.post('/api/me/tz', auth, async (req, res) => {
  try {
    let tz = String((req.body || {}).tz || '').slice(0, 60);
    try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); } catch (_) { tz = 'America/Port-au-Prince'; }
    await runSql('UPDATE users SET tz=? WHERE id=?', tz, req.userId);
    res.json({ ok: true, tz });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.get('/api/me/campaign-notifs', auth, async (req, res) => {
  try {
    const u = await get1('SELECT campaign_notifs FROM users WHERE id=?', req.userId);
    res.json({ ok: true, enabled: !u || u.campaign_notifs !== 0 });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// déclenchement manuel (admin)
app.post('/api/admin/campaigns/trigger', async (req, res) => {
  try {
    const t = req.headers['x-admin-token'];
    if (!process.env.ADMIN_TOKEN || t !== process.env.ADMIN_TOKEN) return res.status(403).json({ error: 'non autorisé' });
    const a = await scheduleDailyCampaigns();
    const b = await processNotifQueue();
    res.json({ ok: true, schedule: a, process: b });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// v1.77 : biographie du profil (150 caractères max)
app.post('/api/me/bio', auth, async (req, res) => {
  try {
    const bio = String((req.body || {}).bio || '').slice(0, 150);
    await runSql('UPDATE users SET bio=? WHERE id=?', bio, req.userId);
    res.json({ ok: true, bio });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// ---------- reposts ----------
app.post('/api/videos/:id/repost', auth, async (req, res) => {
  try {
    const v = await get1('SELECT * FROM videos WHERE id=?', req.params.id);
    if (!v) return res.status(404).json({ error: 'vidéo introuvable' });
    await insertIgnore('INSERT OR IGNORE INTO reposts(user_id,video_id,created_at) VALUES(?,?,?)',
      req.userId, v.id, now());
    await notify(v.user_id, 'repost', req.userId, v.id, '');
    const c = await get1('SELECT COUNT(*) AS c FROM reposts WHERE video_id=?', v.id);
    res.json({ ok: true, reposts: Number(c.c) });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.delete('/api/videos/:id/repost', auth, async (req, res) => {
  try {
    await runSql('DELETE FROM reposts WHERE user_id=? AND video_id=?', req.userId, req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.get('/api/users/:username/reposts', async (req, res) => {
  try {
    const u = await get1('SELECT * FROM users WHERE username=?', String(req.params.username).toLowerCase());
    if (!u) return res.status(404).json({ error: 'utilisateur introuvable' });
    const meId = await optUserId(req);
    // PAGINATION 2026-10-04 : ?page=N (30/page)
    const rpage = Math.max(1, parseInt(req.query.page, 10) || 1);
    const rows = await allRows('SELECT video_id FROM reposts WHERE user_id=? ORDER BY created_at DESC LIMIT 30 OFFSET ' + ((rpage - 1) * 30), u.id);
    const videos = [];
    for (const r of rows) {
      const v = await get1('SELECT * FROM videos WHERE id=? AND hidden=0', r.video_id);
      if (v && await canSeeVideo(v, meId)) { const j = await videoJSON(v, null); if (j) videos.push(j); }
    }
    res.json({ videos, page: rpage, has_more: rows.length >= 30 });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});

// ---------- blocage ----------
app.post('/api/blocks', auth, async (req, res) => {
  try {
    const username = String((req.body || {}).username || '').toLowerCase().trim();
    const u = await get1('SELECT * FROM users WHERE username=?', username);
    if (!u) return res.status(404).json({ error: 'utilisateur introuvable' });
    if (Number(u.id) === Number(req.userId)) return res.status(400).json({ error: 'impossible' });
    await insertIgnore('INSERT OR IGNORE INTO blocks(user_id,blocked_id,created_at) VALUES(?,?,?)',
      req.userId, u.id, now());
    // le blocage coupe les abonnements dans les deux sens, façon TikTok
    await runSql('DELETE FROM follows WHERE (follower_id=? AND followed_id=?) OR (follower_id=? AND followed_id=?)',
      req.userId, u.id, u.id, req.userId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.delete('/api/blocks/:username', auth, async (req, res) => {
  try {
    const u = await get1('SELECT * FROM users WHERE username=?', String(req.params.username).toLowerCase());
    if (u) await runSql('DELETE FROM blocks WHERE user_id=? AND blocked_id=?', req.userId, u.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.get('/api/blocks', auth, async (req, res) => {
  try {
    const rows = await allRows('SELECT blocked_id FROM blocks WHERE user_id=? ORDER BY created_at DESC', req.userId);
    const out = [];
    for (const r of rows) {
      const u = await get1('SELECT * FROM users WHERE id=?', r.blocked_id);
      if (u) out.push(pubUser(u));
    }
    res.json({ blocked: out });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});

// ---------- pas intéressé ----------
app.post('/api/videos/:id/hide', auth, async (req, res) => {
  try {
    const v = await get1('SELECT 1 FROM videos WHERE id=?', req.params.id);
    if (!v) return res.status(404).json({ error: 'vidéo introuvable' });
    await insertIgnore('INSERT OR IGNORE INTO hidden_videos(user_id,video_id,created_at) VALUES(?,?,?)',
      req.userId, req.params.id, now());
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.delete('/api/videos/:id/hide', auth, async (req, res) => {
  try {
    await runSql('DELETE FROM hidden_videos WHERE user_id=? AND video_id=?', req.userId, req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});

// ---------- historique de visionnage ----------
app.get('/api/history', auth, async (req, res) => {
  try {
    // PAGINATION 2026-10-04 : ?page=N (30/page)
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const rows = await allRows('SELECT video_id, watched_at FROM watch_history WHERE user_id=? ORDER BY watched_at DESC LIMIT 30 OFFSET ' + ((page - 1) * 30), req.userId);
    const out = [];
    for (const r of rows) {
      const v = await get1('SELECT * FROM videos WHERE id=? AND hidden=0', r.video_id);
      if (!v) continue;
      const j = await videoJSON(v, req.userId);
      if (!j) continue;
      j.watched_at = Number(r.watched_at);
      out.push(j);
    }
    res.json({ history: out, page, has_more: rows.length >= 30 });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});

// ---------- dashboard admin ----------
app.get('/api/admin/stats', adminAuth, async (req, res) => {
  try {
    const cnt = async (sql, ...p) => Number((await get1(sql, ...p)).c);
    const weekAgo = now() - 7 * 86400000;
    res.json({
      users_total: await cnt('SELECT COUNT(*) AS c FROM users'),
      users_7d: await cnt('SELECT COUNT(*) AS c FROM users WHERE created_at>?', weekAgo),
      videos_total: await cnt('SELECT COUNT(*) AS c FROM videos'),
      videos_7d: await cnt('SELECT COUNT(*) AS c FROM videos WHERE created_at>?', weekAgo),
      views_total: await cnt('SELECT COUNT(*) AS c FROM video_views'),
      likes_total: await cnt('SELECT COUNT(*) AS c FROM likes'),
      comments_total: await cnt('SELECT COUNT(*) AS c FROM comments'),
      reports_pending: await cnt("SELECT COUNT(*) AS c FROM reports WHERE status='pending'"),
      kyc_pending: await cnt("SELECT COUNT(*) AS c FROM id_verifications WHERE status='pending'"),
      withdrawals_pending: await cnt("SELECT COUNT(*) AS c FROM withdrawals WHERE status='pending'"),
      gifts_7d: await cnt('SELECT COUNT(*) AS c FROM gifts WHERE created_at>?', weekAgo),
    });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});

// ---------- abonnements ----------
app.post('/api/follow/:username', auth, async (req, res) => {
  const u = await get1('SELECT * FROM users WHERE username=?', String(req.params.username).toLowerCase());
  if (!u) return res.status(404).json({ error: 'utilisateur introuvable' });
  if (Number(u.id) === Number(req.userId)) return res.status(400).json({ error: 'impossible de se suivre soi-même' });
  // FIX états 2026-10-05 (I2b) : on pouvait suivre quelqu'un qu'on a bloqué (ou qui nous a
  // bloqué) → état follow+block incohérent. Cohérent avec les DMs (403 « utilisateur bloqué »).
  if (await isBlocked(req.userId, u.id)) return res.status(403).json({ error: 'utilisateur bloqué' });
  // v2.40 : compte privé → demande de suivi au lieu d'abonnement direct
  if (Number(u.is_private) === 1) {
    const already = await get1('SELECT 1 FROM follows WHERE follower_id=? AND followed_id=?', req.userId, u.id);
    if (already) return res.json({ following: true });
    await insertIgnore('INSERT OR IGNORE INTO follow_requests(requester_id,target_id,created_at) VALUES(?,?,?)',
      req.userId, u.id, now());
    await notify(u.id, 'follow_request', req.userId, null, '');
    return res.json({ following: false, requested: true });
  }
  // v2.44-EQC-WH : nouveau follow → webhook follower.new (créateur pro)
  const _fwNew = await insertIgnore('INSERT OR IGNORE INTO follows(follower_id,followed_id,created_at) VALUES(?,?,?)',
    req.userId, u.id, now());
  // v2.47 : source d'acquisition (profil, video, search, suggestion, qr, live) pour les stats créateur
  try {
    const src = String((req.body || {}).source || '').slice(0, 20);
    if (src && ['profil', 'video', 'search', 'suggestion', 'qr', 'live', 'other'].includes(src)) {
      await runSql('UPDATE follows SET source=? WHERE follower_id=? AND followed_id=?', src, req.userId, u.id);
    }
  } catch (_) {}
  await notify(u.id, 'follow', req.userId, null, '');
  if (_fwNew) {
    const _fwMe = await get1('SELECT username FROM users WHERE id=?', req.userId);
    fireWebhooks(u.id, 'follower.new', { follower_username: _fwMe ? _fwMe.username : '', followed_username: u.username, at: Date.now() });
  }
  syncRisingStar(u.id).catch(() => {});
  res.json({ following: true });
});

// v2.42 : badge preuve sociale — synchronisé avec le seuil 1000 abonnés
// (attribué à >=1000, RETIRÉ si on redescend sous le seuil)
async function syncRisingStar(userId) {
  try {
    const c = await get1('SELECT COUNT(*) AS n FROM follows WHERE followed_id=?', userId);
    if (c && Number(c.n) >= 1000) {
      await insertIgnore('INSERT OR IGNORE INTO user_badges(user_id,badge,awarded_at) VALUES(?,?,?)',
        userId, 'rising_star', now());
    } else {
      await runSql('DELETE FROM user_badges WHERE user_id=? AND badge=?', userId, 'rising_star');
    }
  } catch (e) {}
}

// v2.40 : demandes de suivi (comptes privés)
app.get('/api/follow-requests', auth, async (req, res) => {
  const rows = await allRows(`SELECT fr.requester_id, fr.created_at, u.username, u.avatar, u.bio FROM follow_requests fr JOIN users u ON u.id=fr.requester_id WHERE fr.target_id=? ORDER BY fr.created_at DESC`, req.userId);
  res.json({ requests: rows });
});
app.post('/api/follow-requests/:userId/accept', auth, async (req, res) => {
  const rid = Number(req.params.userId);
  const fr = await get1('SELECT * FROM follow_requests WHERE requester_id=? AND target_id=?', rid, req.userId);
  if (!fr) return res.status(404).json({ error: 'demande introuvable' });
  await insertIgnore('INSERT OR IGNORE INTO follows(follower_id,followed_id,created_at) VALUES(?,?,?)', rid, req.userId, now());
  await runSql('DELETE FROM follow_requests WHERE requester_id=? AND target_id=?', rid, req.userId);
  await notify(rid, 'follow_accepted', req.userId, null, '');
  res.json({ ok: true });
});
app.post('/api/follow-requests/:userId/reject', auth, async (req, res) => {
  const rid = Number(req.params.userId);
  await runSql('DELETE FROM follow_requests WHERE requester_id=? AND target_id=?', rid, req.userId);
  res.json({ ok: true });
});

// v2.40 : masquer une suggestion d'ami ("ne plus suggérer")
app.post('/api/friends/suggestions/:userId/hide', auth, async (req, res) => {
  const hid = Number(req.params.userId);
  if (hid && hid !== Number(req.userId)) {
    await insertIgnore('INSERT OR IGNORE INTO suggestion_hidden(user_id,hidden_id,created_at) VALUES(?,?,?)',
      req.userId, hid, now());
  }
  res.json({ ok: true });
});

// v2.40 : badges gagnés par l'utilisateur
app.get('/api/me/badges', auth, async (req, res) => {
  await syncRisingStar(req.userId).catch(() => {}); // v2.42 : réconcilie le badge 1000 abonnés
  const rows = await allRows('SELECT badge, awarded_at FROM user_badges WHERE user_id=? ORDER BY awarded_at DESC', req.userId);
  const defs = {
    rising_star: { icon: '🌟', name: 'Étoile montante', desc: '1000 abonnés atteints' },
    verified: { icon: '✓', name: 'Vérifié', desc: 'Compte vérifié par VidiGagne' },
    creator: { icon: '🎬', name: 'Créateur', desc: '10 vidéos publiées' },
    generous: { icon: '🎁', name: 'Généreux', desc: '100 cadeaux envoyés' },
  };
  res.json({ badges: rows.map(r => Object.assign({ badge: r.badge, awarded_at: r.awarded_at }, defs[r.badge] || { icon: '🏅', name: r.badge, desc: '' })) });
});

// v2.41 : compteur de clics sur les liens du profil (bot chain-profile-links)
app.post('/api/links/click', auth, async (req, res) => {
  const url = String((req.body || {}).url || '').slice(0, 200);
  if (!url) return res.status(400).json({ error: 'url requise' });
  const t = now();
  await insertIgnore('INSERT OR IGNORE INTO link_clicks(user_id,url,clicks,updated_at) VALUES(?,?,0,?)', req.userId, url, t);
  await runSql('UPDATE link_clicks SET clicks=clicks+1, updated_at=? WHERE user_id=? AND url=?', t, req.userId, url);
  const row = await get1('SELECT clicks FROM link_clicks WHERE user_id=? AND url=?', req.userId, url);
  res.json({ ok: true, clicks: row ? Number(row.clicks) : 0 });
});

app.delete('/api/follow/:username', auth, async (req, res) => {
  const u = await get1('SELECT * FROM users WHERE username=?', String(req.params.username).toLowerCase());
  if (u) {
    await runSql('DELETE FROM follows WHERE follower_id=? AND followed_id=?', req.userId, u.id);
    syncRisingStar(u.id).catch(() => {}); // v2.42 : retire le badge si <1000
  }
  res.json({ following: false });
});

// ---------- graphe social : suggestions d'amis ----------
app.get('/api/friends/suggestions', auth, async (req, res) => {
  try {
    const me = req.userId;
    // 1) amis d'amis : suivis par mes abonnements, que je ne suis pas encore
    const fof = await allRows(
      `SELECT u.id, u.username, u.avatar, u.bio, MIN(v.username) AS via
       FROM follows f1
       JOIN follows f2 ON f2.follower_id=f1.followed_id
       JOIN users u ON u.id=f2.followed_id
       JOIN users v ON v.id=f1.followed_id
       LEFT JOIN follows mf ON mf.follower_id=? AND mf.followed_id=u.id
       LEFT JOIN blocks b1 ON b1.user_id=? AND b1.blocked_id=u.id
       LEFT JOIN blocks b2 ON b2.user_id=u.id AND b2.blocked_id=?
       LEFT JOIN suggestion_hidden sh ON sh.user_id=? AND sh.hidden_id=u.id
       WHERE f1.follower_id=? AND u.id<>? AND mf.followed_id IS NULL
         AND b1.blocked_id IS NULL AND b2.user_id IS NULL AND sh.hidden_id IS NULL
         AND (u.suspended IS NULL OR u.suspended=0)
         AND (u.discoverable IS NULL OR u.discoverable=1)
       GROUP BY u.id, u.username, u.avatar, u.bio
       LIMIT 20`, me, me, me, me, me, me);
    // 2) intérêts communs (préférences de contenu 'more')
    const intr = await allRows(
      `SELECT u.id, u.username, u.avatar, u.bio, GROUP_CONCAT(DISTINCT cp2.topic) AS topics
       FROM content_prefs cp1
       JOIN content_prefs cp2 ON cp2.topic=cp1.topic AND cp2.pref='more' AND cp2.user_id<>?
       JOIN users u ON u.id=cp2.user_id
       LEFT JOIN follows mf ON mf.follower_id=? AND mf.followed_id=u.id
       LEFT JOIN blocks b1 ON b1.user_id=? AND b1.blocked_id=u.id
       LEFT JOIN blocks b2 ON b2.user_id=u.id AND b2.blocked_id=?
       LEFT JOIN suggestion_hidden sh ON sh.user_id=? AND sh.hidden_id=u.id
       WHERE cp1.user_id=? AND cp1.pref='more'
         AND mf.followed_id IS NULL AND b1.blocked_id IS NULL AND b2.user_id IS NULL AND sh.hidden_id IS NULL
         AND (u.suspended IS NULL OR u.suspended=0)
         AND (u.discoverable IS NULL OR u.discoverable=1)
       GROUP BY u.id, u.username, u.avatar, u.bio
       LIMIT 20`, me, me, me, me, me, me);
    const seen = new Set(), out = [];
    for (const r of fof) {
      seen.add(Number(r.id));
      out.push({ id: Number(r.id), username: r.username, avatar: r.avatar || '🙂', bio: r.bio || '',
        reason: 'suivi par @' + (r.via || '') });
    }
    for (const r of intr) {
      if (seen.has(Number(r.id))) continue;
      seen.add(Number(r.id));
      out.push({ id: Number(r.id), username: r.username, avatar: r.avatar || '🙂', bio: r.bio || '',
        reason: 'mêmes intérêts' + (r.topics ? ' : ' + String(r.topics).split(',').slice(0, 3).join(', ') : '') });
    }
    res.json({ ok: true, suggestions: out.slice(0, 20) });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});

// ---------- v2.48 SPEC-06 : séries d'amitié 🔥 ----------
// RÈGLE D'ÉCHANGE BIDIRECTIONNEL : une journée de série n'est validée que si les deux
// amis ont échangé au moins un message chacun le même jour calendaire (dérivé des messages
// de leur conversation). Une série peut aussi être échangée explicitement via un
// commentaire OU via un code partagé entre les deux amis (endpoint /exchange ci-dessous).
function streakPair(a, b) { a = Number(a); b = Number(b); return a < b ? [a, b] : [b, a]; }
function dayBoundsMs(dayStr) { const s = new Date(dayStr + 'T00:00:00Z').getTime(); return [s, s + 86400000]; }
async function friendshipStreakTouch(a, b) {
  // Recalcule/valide la série de la paire depuis les messages (échange bidirectionnel).
  const [x, y] = streakPair(a, b);
  if (!x || !y || x === y) return null;
  // T2 : jour local de l'utilisateur qui déclenche (a), pas UTC — même tolérance de transition que les séries de connexion
  const tz = await userTz(a);
  const t = now(), today = userDay(t, tz), yest = userDay(t - 86400000, tz), yestU = utcDay(t - 86400000);
  const [ds, de] = dayBoundsMs(today);
  const conv = await get1('SELECT id FROM conversations WHERE (user1_id=? AND user2_id=?) OR (user1_id=? AND user2_id=?)', x, y, y, x);
  let bidir = false;
  if (conv) {
    const r = await get1('SELECT COUNT(DISTINCT sender_id) AS n FROM messages WHERE conversation_id=? AND created_at>=? AND created_at<?', conv.id, ds, de);
    bidir = Number(r && r.n) >= 2; // échange bidirectionnel : les deux ont écrit aujourd'hui
  }
  const row = await get1('SELECT * FROM friendship_streaks WHERE user_a=? AND user_b=?', x, y);
  if (!bidir || (row && row.last_day === today)) return row;
  const streak = (row && (row.last_day === yest || row.last_day === yestU)) ? row.streak + 1 : 1;
  if (row) await runSql('UPDATE friendship_streaks SET streak=?, last_day=?, updated_at=? WHERE user_a=? AND user_b=?', streak, today, t, x, y);
  else await runSql('INSERT INTO friendship_streaks(user_a,user_b,streak,last_day,updated_at) VALUES(?,?,?,?,?)', x, y, streak, today, t);
  return { user_a: x, user_b: y, streak, last_day: today, updated_at: t };
}
app.get('/api/friends/streaks', auth, async (req, res) => {
  try {
    const me = Number(req.userId);
    const rows = await allRows(
      `SELECT s.streak, s.last_day, u.id AS friend_id, u.username, u.avatar
       FROM friendship_streaks s
       JOIN users u ON u.id = CASE WHEN s.user_a=? THEN s.user_b ELSE s.user_a END
       WHERE s.user_a=? OR s.user_b=? ORDER BY s.streak DESC LIMIT 100`, me, me, me);
    res.json({ streaks: rows.map(r => ({ friend: { id: r.friend_id, username: r.username, avatar: r.avatar || '🙂' },
      streak: r.streak, last_day: r.last_day, flame: '🔥' })) });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.get('/api/conversations/:id/streak', auth, async (req, res) => {
  try {
    const c = await get1('SELECT * FROM conversations WHERE id=?', req.params.id);
    if (!c) return res.status(404).json({ error: 'conversation introuvable' });
    const me = Number(req.userId);
    if (Number(c.user1_id) !== me && Number(c.user2_id) !== me)
      return res.status(403).json({ error: 'non autorisé' });
    const other = Number(c.user1_id) === me ? Number(c.user2_id) : Number(c.user1_id);
    const s = await friendshipStreakTouch(me, other); // recalcule depuis les messages du jour
    res.json({ streak: s ? s.streak : 0, last_day: s ? s.last_day : null, flame: '🔥' });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.post('/api/friends/streaks/exchange', auth, async (req, res) => {
  try {
    // Échange explicite de série : via un commentaire OU via un code partagé.
    const b = req.body || {};
    const friendId = Number(b.friend_id);
    const via = String(b.via || 'comment').slice(0, 20);
    if (!friendId || friendId === Number(req.userId)) return res.status(400).json({ error: 'ami invalide' });
    if (via !== 'comment' && via !== 'code') return res.status(400).json({ error: 'via invalide (comment|code)' });
    const [x, y] = streakPair(req.userId, friendId);
    // T2 : jour local du demandeur, pas UTC (tolérance de transition comme ailleurs)
    const _stz = await userTz(req.userId);
    const t = now(), today = userDay(t, _stz), yest = userDay(t - 86400000, _stz), yestU = utcDay(t - 86400000);
    const row = await get1('SELECT * FROM friendship_streaks WHERE user_a=? AND user_b=?', x, y);
    if (row && row.last_day === today) return res.json({ ok: true, streak: row.streak, already: true, via });
    if (via === 'code') {
      // code déterministe de la paire, à partager entre les deux amis
      const expect = 'VG' + String(1000 + ((x * 31 + y * 17) % 9000));
      if (String(b.code || '').trim().toUpperCase() !== expect)
        return res.status(400).json({ error: 'code invalide' });
    }
    const streak = (row && (row.last_day === yest || row.last_day === yestU)) ? row.streak + 1 : 1;
    if (row) await runSql('UPDATE friendship_streaks SET streak=?, last_day=?, updated_at=? WHERE user_a=? AND user_b=?', streak, today, t, x, y);
    else await runSql('INSERT INTO friendship_streaks(user_a,user_b,streak,last_day,updated_at) VALUES(?,?,?,?,?)', x, y, streak, today, t);
    res.json({ ok: true, streak, last_day: today, via, flame: '🔥' });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});

// ---------- graphe social : amis communs ----------
app.get('/api/users/:username/mutual', auth, async (req, res) => {
  try {
    const u = await get1('SELECT * FROM users WHERE username=?', String(req.params.username).toLowerCase());
    if (!u) return res.status(404).json({ error: 'utilisateur introuvable' });
    if (Number(u.id) === Number(req.userId)) return res.json({ ok: true, mutual: [], count: 0 });
    const rows = await allRows(
      `SELECT u.id, u.username, u.avatar
       FROM follows f1
       JOIN follows f2 ON f2.followed_id=f1.followed_id
       JOIN users u ON u.id=f1.followed_id
       WHERE f1.follower_id=? AND f2.follower_id=?
         AND (u.suspended IS NULL OR u.suspended=0)
       ORDER BY u.username LIMIT 100`, req.userId, u.id);
    res.json({ ok: true, count: rows.length,
      mutual: rows.map(r => ({ id: Number(r.id), username: r.username, avatar: r.avatar || '🙂' })) });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});

// ---------- graphe social : synchronisation des contacts ----------
app.post('/api/contacts/sync', auth, async (req, res) => {
  try {
    const list = (req.body || {}).contacts;
    if (!Array.isArray(list)) return res.status(400).json({ error: 'contacts requis' });
    const found = [], seenH = new Set();
    for (const c of list.slice(0, 500)) {
      const h = String((c && (c.phone_hash || c.phoneHash)) || '').trim();
      if (!h || seenH.has(h)) continue;
      seenH.add(h);
      const nm = String((c && c.name) || '').slice(0, 80);
      const u = await get1("SELECT id, username, avatar FROM users WHERE phone_hash=? AND phone_hash<>''", h);
      if (u && Number(u.id) !== Number(req.userId)) {
        found.push({ user_id: Number(u.id), username: u.username, avatar: u.avatar || '🙂', name: nm });
      } else if (!u) {
        // trace l'invitation potentielle (contact sans compte)
        try { await insertIgnore('INSERT OR IGNORE INTO contact_invites(user_id,phone_hash,name,created_at) VALUES(?,?,?,?)',
          req.userId, h, nm, now()); } catch (_) {}
      }
    }
    res.json({ ok: true, found, found_count: found.length, total: list.length });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});

// ---------- graphe social : invitations personnalisées ----------
// v2.32 : lien d'invitation personnalisé (code unique, attribution +50/+50 à l'inscription)
app.post('/api/invites', auth, async (req, res) => {
  try {
    const label = String((req.body || {}).label || '').slice(0, 60);
    let code = null;
    for (let i = 0; i < 20 && !code; i++) {
      const c = genRefCode();
      if (!(await get1('SELECT 1 FROM invites WHERE code=?', c)) && !(await get1('SELECT 1 FROM users WHERE ref_code=?', c))) code = c;
    }
    if (!code) return res.status(500).json({ error: 'réessaie' });
    const id = await insertId('INSERT INTO invites(user_id,code,label,status,created_at) VALUES(?,?,?,?,?)',
      req.userId, code, label, 'pending', now());
    const me = await get1('SELECT username FROM users WHERE id=?', req.userId);
    const base = (req.protocol + '://' + req.get('host')).replace(/\/$/, '');
    res.json({ ok: true, id: Number(id), code, label, link: base + '/invite/' + code,
      inviter: me ? me.username : '' });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});

app.get('/api/invites/mine', auth, async (req, res) => {
  try {
    const rows = await allRows(
      `SELECT i.id, i.code, i.label, i.status, i.invited_user_id, i.created_at, u.username AS invited_username
       FROM invites i LEFT JOIN users u ON u.id=i.invited_user_id
       WHERE i.user_id=? ORDER BY i.created_at DESC LIMIT 100`, req.userId);
    res.json({ ok: true, invites: rows.map(r => ({
      id: Number(r.id), code: r.code, label: r.label || '',
      status: r.status === 'inscrit' ? 'inscrit' : 'en attente',
      invited_username: r.invited_username || null, created_at: Number(r.created_at) })) });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});

// page d'accueil du lien d'invitation
app.get('/invite/:code', async (req, res) => {
  try {
    const inv = await get1('SELECT i.*, u.username AS inviter FROM invites i JOIN users u ON u.id=i.user_id WHERE UPPER(i.code)=?',
      String(req.params.code).toUpperCase());
    if (!inv) return res.status(404).send("<h1>Lien d'invitation invalide</h1>");
    const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    res.send('<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>VidiGagne — invitation</title></head>'
      + '<body style="font-family:sans-serif;text-align:center;padding:40px;background:#0b0b0b;color:#fff"><h1>🎬 VidiGagne</h1>'
      + '<p><b>@' + esc(inv.inviter) + "</b> t'invite à rejoindre VidiGagne !</p>"
      + '<p>Télécharge l\u2019app, inscris-toi et entre le code :</p>'
      + '<p style="font-size:32px;letter-spacing:4px;color:#f5c518"><b>' + esc(inv.code) + '</b></p>'
      + '<p style="color:#888">Vous gagnez chacun +50 pièces 🪙</p></body></html>');
  } catch (e) { res.status(500).send('erreur'); }
});

app.get('/api/users/:username', async (req, res) => {
  try {
    const upage = Math.max(1, parseInt(req.query.page, 10) || 1); // FIX v2.42 : upage référencé mais jamais défini → 500
    const u = await get1('SELECT * FROM users WHERE username=?', String(req.params.username).toLowerCase());
    if (!u) return res.status(404).json({ error: 'utilisateur introuvable' });
    // profil inaccessible si blocage dans un sens ou l'autre (sauf soi-même)
    const meId = await optUserId(req);
    if (meId && Number(meId) !== Number(u.id) && await isBlocked(meId, u.id))
      return res.status(403).json({ error: 'utilisateur bloqué' });
    // FIX 2026-10-04 (rupture #3b): compte privé → seuls les abonnés voient le profil complet
    let isFollower = false;
    if (Number(u.is_private) && meId && Number(meId) !== Number(u.id)) {
      const f = await get1('SELECT 1 FROM follows WHERE follower_id=? AND followed_id=?', meId, u.id);
      isFollower = !!f;
      if (!isFollower) {
        const followers = Number((await get1('SELECT COUNT(*) AS c FROM follows WHERE followed_id=?', u.id)).c);
        return res.json({ user: pubUser(u), followers, following: 0, total_likes: 0, videos: [], private: true });
      }
    }
    // v2.37 : enregistre la vue de profil (viewer authentifié, pas soi-même, max 1x/heure par couple).
    // Placé APRÈS le contrôle compte privé : un profil privé visité par un non-abonné n'est pas enregistré.
    if (meId && Number(meId) !== Number(u.id)) {
      try {
        const pv = await get1('SELECT viewed_at FROM profile_views WHERE viewer_id=? AND viewed_id=?', meId, u.id);
        if (!pv || (now() - Number(pv.viewed_at)) >= 3600000) {
          await runSql(`INSERT INTO profile_views(viewer_id,viewed_id,viewed_at) VALUES(?,?,?)
            ON CONFLICT(viewer_id,viewed_id) DO UPDATE SET viewed_at=EXCLUDED.viewed_at`, meId, u.id, now());
        }
      } catch (e) {}
    }
    const vids = await allRows(
      'SELECT * FROM videos WHERE user_id=? AND hidden=0 AND (scheduled_at IS NULL OR scheduled_at <= ?) ORDER BY created_at DESC', u.id, now());
    const followers = Number((await get1('SELECT COUNT(*) AS c FROM follows WHERE followed_id=?', u.id)).c);
    const following = Number((await get1('SELECT COUNT(*) AS c FROM follows WHERE follower_id=?', u.id)).c);
    const likes = Number((await get1(
      'SELECT COUNT(*) AS c FROM likes l JOIN videos v ON v.id=l.video_id WHERE v.user_id=?', u.id)).c);
    const videos = [];
    for (const v of vids) {
      if (await canSeeVideo(v, meId)) { const j = await videoJSON(v, null); if (j) videos.push(j); }
    }
    res.json({ user: pubUser(u), followers, following, total_likes: likes, videos, page: upage, has_more: vids.length >= 30 });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});

// ---------- v2.37 : historique des vues de profil ----------
// Qui a vu mon profil : viewers récents (ordre décroissant, limite 50)
app.get('/api/me/profile-views', auth, async (req, res) => {
  try {
    const rows = await allRows(
      `SELECT u.id, u.username, u.avatar, pv.viewed_at FROM profile_views pv
       JOIN users u ON u.id=pv.viewer_id
       WHERE pv.viewed_id=? ORDER BY pv.viewed_at DESC LIMIT 50`, req.userId);
    res.json({ ok: true, views: rows.map(r => ({
      id: r.id, username: r.username, avatar: r.avatar, viewed_at: Number(r.viewed_at) })) });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// Effacer l'historique des vues de mon profil
app.delete('/api/me/profile-views', auth, async (req, res) => {
  try {
    await runSql('DELETE FROM profile_views WHERE viewed_id=?', req.userId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});

// ---------- v13 : Q&A sur le profil ----------
app.get('/api/users/:username/qa', async (req, res) => {
  try {
    const u = await get1('SELECT id, is_private FROM users WHERE username=?', String(req.params.username).toLowerCase());
    if (!u) return res.status(404).json({ error: 'utilisateur introuvable' });
    // FIX 2026-10-04 (bot chain-security-private) : compte privé → questions masquées aux non-abonnés
    const meIdQ = await optUserId(req);
    if (Number(u.is_private) && meIdQ && Number(meIdQ) !== Number(u.id)) {
      const _qf = await get1('SELECT 1 FROM follows WHERE follower_id=? AND followed_id=?', meIdQ, u.id);
      if (!_qf) return res.json({ questions: [] });
    }
    const qs = await allRows(
      `SELECT q.*, u.username AS asker_name FROM qa_questions q
       LEFT JOIN users u ON u.id=q.asker_id
       WHERE q.user_id=? ORDER BY q.created_at DESC`, u.id);
    res.json({ questions: qs });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.post('/api/users/:username/qa', auth, async (req, res) => {
  try {
    const u = await get1('SELECT id FROM users WHERE username=?', String(req.params.username).toLowerCase());
    if (!u) return res.status(404).json({ error: 'utilisateur introuvable' });
    const q = String((req.body || {}).question || '').trim().slice(0, 300);
    if (!q) return res.status(400).json({ error: 'question vide' });
    const id = await insertId(
      'INSERT INTO qa_questions(user_id,asker_id,question,created_at) VALUES(?,?,?,?)',
      u.id, req.userId, q, now());
    res.json({ id });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.post('/api/qa/:id/answer', auth, async (req, res) => {
  try {
    const q = await get1('SELECT * FROM qa_questions WHERE id=?', req.params.id);
    if (!q) return res.status(404).json({ error: 'question introuvable' });
    if (Number(q.user_id) !== Number(req.userId)) return res.status(403).json({ error: 'non autorisé' });
    const a = String((req.body || {}).answer || '').trim().slice(0, 1000);
    await runSql('UPDATE qa_questions SET answer=?, answered_at=? WHERE id=?', a, now(), req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// v2.37 : Q&R — liste perso + suppression (CRUD /api/me/qa)
app.get('/api/me/qa', auth, async (req, res) => {
  try {
    const qs = await allRows(
      `SELECT q.*, u.username AS asker_name FROM qa_questions q
       LEFT JOIN users u ON u.id=q.asker_id
       WHERE q.user_id=? ORDER BY q.created_at DESC`, req.userId);
    res.json({ questions: qs });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.delete('/api/me/qa/:id', auth, async (req, res) => {
  try {
    const q = await get1('SELECT * FROM qa_questions WHERE id=?', req.params.id);
    if (!q) return res.status(404).json({ error: 'question introuvable' });
    if (Number(q.user_id) !== Number(req.userId)) return res.status(403).json({ error: 'non autorisé' });
    await runSql('DELETE FROM qa_questions WHERE id=?', req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});

// ---------- v13 : collections partagées ----------
app.post('/api/collections/shared', auth, async (req, res) => {
  try {
    const name = String((req.body || {}).name || '').trim().slice(0, 100) || 'Collection partagée';
    const videoIds = (req.body || {}).video_ids || [];
    const code = 'VG-COLL-' + Math.random().toString(36).slice(2, 8).toUpperCase();
    const cid = await insertId(
      'INSERT INTO shared_collections(owner_id,name,code,created_at) VALUES(?,?,?,?)',
      req.userId, name, code, now());
    await runSql('INSERT INTO shared_collection_members(collection_id,user_id,joined_at) VALUES(?,?,?)',
      cid, req.userId, now());
    for (const vid of videoIds.slice(0, 100)) {
      try {
        await runSql('INSERT INTO shared_collection_videos(collection_id,video_id,added_by,added_at) VALUES(?,?,?,?)',
          cid, vid, req.userId, now());
      } catch (e) {}
    }
    res.json({ id: cid, code });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.post('/api/collections/shared/join', auth, async (req, res) => {
  try {
    const code = String((req.body || {}).code || '').trim().toUpperCase();
    const c = await get1('SELECT * FROM shared_collections WHERE code=?', code);
    if (!c) return res.status(404).json({ error: 'code invalide' });
    try {
      await runSql('INSERT INTO shared_collection_members(collection_id,user_id,joined_at) VALUES(?,?,?)',
        c.id, req.userId, now());
    } catch (e) {}
    const vids = await allRows(
      `SELECT v.* FROM shared_collection_videos scv
       JOIN videos v ON v.id=scv.video_id
       WHERE scv.collection_id=? ORDER BY scv.added_at DESC`, c.id);
    res.json({ collection: c, videos: vids });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.get('/api/collections/shared/:code', auth, async (req, res) => {
  try {
    const c = await get1('SELECT * FROM shared_collections WHERE code=?',
      String(req.params.code).toUpperCase());
    if (!c) return res.status(404).json({ error: 'collection introuvable' });
    const member = await get1(
      'SELECT 1 FROM shared_collection_members WHERE collection_id=? AND user_id=?',
      c.id, req.userId);
    if (!member && Number(c.owner_id) !== Number(req.userId))
      return res.status(403).json({ error: 'non membre' });
    const vids = await allRows(
      `SELECT v.*, u.username FROM shared_collection_videos scv
       JOIN videos v ON v.id=scv.video_id
       JOIN users u ON u.id=v.user_id
       WHERE scv.collection_id=? ORDER BY scv.added_at DESC`, c.id);
    res.json({ collection: c, videos: vids });
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
// v1.58 : recherche par image — hash perceptuel (aHash), distance de Hamming <= 12
app.post('/api/search/image', auth, uploadImg.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'aucune image' });
    const { execFile } = require('child_process');
    const fpath = req.file.path || (() => { const t = require('os').tmpdir() + '/vgq' + Date.now() + '.jpg';
      require('fs').writeFileSync(t, req.file.buffer); return t; })();
    const qhash = await new Promise((resolve) => {
      execFile('python3', [__dirname + '/phash.py', fpath], { timeout: 60000 }, (err, stdout) => {
        resolve(String(stdout || '').trim());
      });
    });
    try { if (req.file.path !== fpath) require('fs').unlink(fpath, () => {}); } catch (_) {}
    if (!/^[0-9a-f]{16}$/.test(qhash)) return res.status(400).json({ error: 'image illisible' });
    const q = BigInt('0x' + qhash);
    const rows = await allRows("SELECT id, phash FROM videos WHERE phash != '' AND hidden=0 LIMIT 5000");
    const scored = [];
    for (const r of rows) {
      try {
        const d = (BigInt('0x' + r.phash) ^ q).toString(2).split('1').length - 1;
        if (d <= 12) scored.push({ id: r.id, d });
      } catch (_) {}
    }
    scored.sort((a, b) => a.d - b.d);
    const videos = [];
    for (const s of scored.slice(0, 20)) {
      const v = await get1('SELECT * FROM videos WHERE id=?', s.id);
      if (v) videos.push(await videoJSON(v, req.userId));
    }
    res.json({ videos, hash: qhash });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.get('/api/search', async (req, res) => {
  try {
    const rawQ = String(req.query.q || '').trim().toLowerCase().slice(0, 100);
    const q = '%' + rawQ + '%';
    const meId = await optUserId(req);
    // PAGINATION 2026-10-04 : ?page=N (20/page pour users et vidéos)
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const sqOff = (page - 1) * 20;
    // v1.63 : journalise les recherches pour les insights créateurs
    if (rawQ.length >= 2) {
      runSql('INSERT INTO search_logs(query,user_id,created_at) VALUES(?,?,?)',
        rawQ, meId || null, now()).catch(() => {});
      // nettoyage : garde 30 jours
      runSql('DELETE FROM search_logs WHERE created_at<?', now() - 30 * 86400000).catch(() => {});
    }
    const users = await allRows(
      'SELECT id,username,name,avatar FROM users WHERE username LIKE ? OR name LIKE ? LIMIT 20 OFFSET ' + sqOff, q, q);
    const vf = visFilter('videos', meId);
    // v2.37 : filtres de recherche (sort=recent|popular, min_duration, max_duration en secondes)
    const sort = String(req.query.sort || 'recent');
    const orderBy = sort === 'popular' ? 'ORDER BY views DESC' : 'ORDER BY created_at DESC';
    const minD = Math.max(0, Number(req.query.min_duration) || 0);
    const maxD = Number(req.query.max_duration) || 0;
    let durClause = '';
    const durParams = [];
    if (minD > 0) { durClause += ' AND duration>=?'; durParams.push(minD); }
    if (maxD > 0) { durClause += ' AND duration<=?'; durParams.push(maxD); }
    const vids = await allRows(
      'SELECT * FROM videos WHERE (LOWER(description) LIKE ? OR LOWER(tags) LIKE ?) AND (scheduled_at IS NULL OR scheduled_at <= ?) AND hidden=0' + durClause + vf.clause + ' ' + orderBy + ' LIMIT 20 OFFSET ' + sqOff, q, q, now(), ...durParams, ...vf.params);
    const videos = [];
    for (const v of vids) { const j = await videoJSON(v, null); if (j) videos.push(j); }
    res.json({ users, videos, page, has_more: vids.length >= 20 || users.length >= 20 });
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
    await recordDevice(req, u.id); // v2.32 : 1 identité par installation (no-op ici : redirection navigateur sans en-tête)
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
    const _pu = privUser(u); _pu.email = u.email || ''; // v1.100 : l'app envoie le code à cet e-mail
    res.json({ done: true, token: row.token, user: _pu, coins: u.coins });
  } catch (e) { res.json({ done: false }); }
});

// ---------- Facebook OAuth (gratuit) ----------
// Variables d'environnement à renseigner (Meta for Developers → application) :
//   FACEBOOK_APP_ID, FACEBOOK_APP_SECRET (+ FACEBOOK_REDIRECT_URI si besoin).
// Tant qu'elles sont absentes, le bouton « Continuer avec Facebook » est masqué dans l'app.
const FACEBOOK_OK = () => !!(process.env.FACEBOOK_APP_ID && process.env.FACEBOOK_APP_SECRET);
const FACEBOOK_REDIRECT = () => process.env.FACEBOOK_REDIRECT_URI || 'https://vidigagne-server-production.up.railway.app/api/auth/facebook/callback';

app.get('/api/auth/facebook/start', (req, res) => {
  if (!FACEBOOK_OK()) return res.status(503).json({ error: 'Facebook non configuré' });
  const session = (req.query.session || '').toString();
  if (!validSession(session)) return res.status(400).json({ error: 'session invalide' });
  const params = new URLSearchParams({
    client_id: process.env.FACEBOOK_APP_ID,
    redirect_uri: FACEBOOK_REDIRECT(),
    state: session,
    scope: 'email,public_profile',
    response_type: 'code',
  });
  res.redirect('https://www.facebook.com/v19.0/dialog/oauth?' + params.toString());
});

app.get('/api/auth/facebook/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || !validSession(state || '')) return res.status(400).send('Session invalide');
    const tParams = new URLSearchParams({
      client_id: process.env.FACEBOOK_APP_ID,
      client_secret: process.env.FACEBOOK_APP_SECRET,
      redirect_uri: FACEBOOK_REDIRECT(),
      code: String(code),
    });
    const tRes = await fetch('https://graph.facebook.com/v19.0/oauth/access_token?' + tParams.toString());
    const tj = await tRes.json();
    if (!tj.access_token) return res.status(400).send('Échec Facebook');
    const uRes = await fetch('https://graph.facebook.com/me?fields=id,name,email&access_token=' + encodeURIComponent(tj.access_token));
    const fb = await uRes.json();
    if (!fb.id) return res.status(400).send('Profil Facebook incomplet');
    const fbEmail = fb.email ? String(fb.email).toLowerCase() : null;
    let u = await get1('SELECT * FROM users WHERE facebook_id=?', String(fb.id));
    if (!u && fbEmail) {
      const byMail = await get1('SELECT * FROM users WHERE email=?', fbEmail);
      if (byMail) {
        await runSql('UPDATE users SET facebook_id=? WHERE id=?', String(fb.id), byMail.id);
        u = await get1('SELECT * FROM users WHERE id=?', byMail.id);
      }
    }
    if (!u) {
      let base = (fbEmail ? fbEmail.split('@')[0] : String(fb.name || 'user')).toLowerCase().replace(/[^a-z0-9._]/g, '').slice(0, 18) || 'user';
      if (base.length < 2) base = 'user';
      let username = base, n = 0;
      while (await get1('SELECT 1 FROM users WHERE username=?', username)) { n++; username = (base + n).slice(0, 24); }
      const id = await insertId(
        'INSERT INTO users(username,name,email,facebook_id,pass_hash,pass_salt,created_at) VALUES(?,?,?,?,?,?,?)',
        username, String(fb.name || username).slice(0, 40), fbEmail,
        String(fb.id), crypto.randomBytes(16).toString('hex'), crypto.randomBytes(16).toString('hex'), now());
      u = await get1('SELECT * FROM users WHERE id=?', id);
    }
    const token = crypto.randomBytes(32).toString('hex');
    await runSql('INSERT INTO tokens(token,user_id,created_at) VALUES(?,?,?)', token, u.id, now());
    await runSql('INSERT INTO oauth_sessions(session,token,user_id,created_at) VALUES(?,?,?,?)',
      state, token, u.id, now());
    res.send(`<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="font-family:sans-serif;text-align:center;padding:60px 20px"><div style="font-size:64px">✅</div><h2>Connexion réussie !</h2><p>Retourne dans l'application VidiGagne.</p></body></html>`);
  } catch (e) { res.status(500).send('Erreur de connexion Facebook'); }
});

app.get('/api/auth/facebook/poll', async (req, res) => {
  try {
    const s = (req.query.session || '').toString();
    await runSql('DELETE FROM oauth_sessions WHERE created_at<?', now() - 600000); // expire 10 min
    if (!validSession(s)) return res.json({ done: false });
    const row = await get1('SELECT token, user_id FROM oauth_sessions WHERE session=?', s);
    if (!row) return res.json({ done: false });
    await runSql('DELETE FROM oauth_sessions WHERE session=?', s); // usage unique
    const u = await get1('SELECT * FROM users WHERE id=?', row.user_id);
    const _pu = privUser(u); _pu.email = u.email || '';
    res.json({ done: true, token: row.token, user: _pu, coins: u.coins });
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
    await recordDevice(req, u.id); // v2.32 : 1 identité par installation (détection, jamais bloquant)
    res.json({ token, user: privUser(u), coins: u.coins });
  } catch (e) { res.status(401).json({ error: 'vérification téléphone échouée' }); }
});

app.use('/uploads', express.static(UP, { maxAge: '7d' }));

// ---- pages publiques (page d'accueil + confidentialité, requises pour OAuth) ----
const PAGE_STYLE = `<style>body{font-family:system-ui,-apple-system,sans-serif;max-width:720px;margin:0 auto;padding:32px 20px;color:#111;line-height:1.6}h1{font-size:28px}a{color:#0a7aff}footer{margin-top:40px;font-size:13px;color:#888}</style>`;
app.get('/', (req, res) => res.type('html').send(`<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>VidiGagne</title>${PAGE_STYLE}</head><body>
<h1>🎬 VidiGagne</h1>
<p><strong>Regarde des vidéos, gagne des pièces.</strong> VidiGagne est une application mobile de vidéos courtes : crée ton compte (téléphone, e-mail ou Google), regarde des vidéos, publie les tiennes et accumule des pièces convertibles en gains.</p>
<ul><li>📱 Application Android (bientôt sur Google Play)</li><li>💰 1000 pièces = 2&nbsp;$ de retrait minimum</li><li>🌍 Disponible dans tous les pays</li></ul>
<p><a href="/privacy">Règles de confidentialité</a></p>
<footer>VidiGagne — contact : ceuskewin1234@gmail.com</footer></body></html>`));

app.get('/api/health', (req, res) => res.json({
  ok: true, name: 'VidiGagne Server v2', time: now(),
  db: USE_PG ? 'postgres' : 'sqlite',
  storage: USE_CLOUDINARY ? 'cloudinary' : 'local',
  google: GOOGLE_OK(), phone: !!process.env.FIREBASE_PROJECT_ID,
  facebook: FACEBOOK_OK(), // login Facebook (gratuit) — bouton masqué dans l'app si false
  firebase: process.env.FIREBASE_PROJECT_ID || null,
  fbKey: process.env.FIREBASE_API_KEY || null, // clé Web Firebase : publique par design, requise par l'appli pour l'auth téléphone
}));

// ==================== SERVEUR v10 ====================
// ---------- stories durcies : vues, confidentialité, suppression ----------
// amitié mutuelle (follow dans les deux sens)
async function isMutual(a, b) {
  if (!a || !b || Number(a) === Number(b)) return false;
  const r1 = await get1('SELECT 1 FROM follows WHERE follower_id=? AND followed_id=?', a, b);
  if (!r1) return false;
  const r2 = await get1('SELECT 1 FROM follows WHERE follower_id=? AND followed_id=?', b, a);
  return !!r2;
}
app.post('/api/stories/:id/view', auth, async (req, res) => {
  try {
    const s = await get1('SELECT * FROM stories WHERE id=?', req.params.id);
    if (!s || Number(s.expires_at) <= now()) return res.status(404).json({ error: 'story introuvable' });
    if (Number(req.userId) !== Number(s.user_id))
      await insertIgnore('INSERT OR IGNORE INTO story_views(story_id,viewer_id,viewed_at) VALUES(?,?,?)',
        s.id, req.userId, now());
    const c = await get1('SELECT COUNT(*) AS c FROM story_views WHERE story_id=?', s.id);
    res.json({ ok: true, views: Number(c.c) });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.get('/api/stories/:id/views', auth, async (req, res) => {
  try {
    const s = await get1('SELECT * FROM stories WHERE id=?', req.params.id);
    if (!s) return res.status(404).json({ error: 'story introuvable' });
    if (Number(s.user_id) !== Number(req.userId)) return res.status(403).json({ error: 'réservé au propriétaire' });
    const rows = await allRows(
      'SELECT sv.viewed_at, u.id, u.username, u.name, u.avatar, u.verified FROM story_views sv JOIN users u ON u.id=sv.viewer_id WHERE sv.story_id=? ORDER BY sv.viewed_at DESC', s.id);
    res.json({ views: rows.map(r => ({ user: pubUser(r), viewed_at: Number(r.viewed_at) })) });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.delete('/api/stories/:id', auth, async (req, res) => {
  try {
    const s = await get1('SELECT * FROM stories WHERE id=?', req.params.id);
    if (!s) return res.status(404).json({ error: 'story introuvable' });
    if (Number(s.user_id) !== Number(req.userId)) return res.status(403).json({ error: 'non autorisé' });
    await runSql('DELETE FROM story_views WHERE story_id=?', s.id);
    await runSql('DELETE FROM stories WHERE id=?', s.id);
    if (!USE_CLOUDINARY && s.file && !/^https?:\/\//.test(s.file)) {
      try { fs.unlinkSync(path.join(UP, s.file)); } catch (e) {}
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.patch('/api/stories/:id', auth, async (req, res) => {
  try {
    const s = await get1('SELECT * FROM stories WHERE id=?', req.params.id);
    if (!s) return res.status(404).json({ error: 'story introuvable' });
    if (Number(s.user_id) !== Number(req.userId)) return res.status(403).json({ error: 'non autorisé' });
    const p = String((req.body || {}).privacy || '');
    if (!['public', 'friends'].includes(p)) return res.status(400).json({ error: 'privacy invalide' });
    await runSql('UPDATE stories SET privacy=? WHERE id=?', p, s.id);
    res.json({ ok: true, privacy: p });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// remplace le feed stories : exclut expirées + respecte privacy (amis = follow mutuel)
app.get('/api/stories/feed', async (req, res) => {
  const rows = await allRows(
    'SELECT s.*, u.username, u.name, u.avatar FROM stories s JOIN users u ON u.id=s.user_id WHERE s.expires_at>? ORDER BY s.created_at DESC', now());
  const meId = await optUserId(req);
  const groups = {};
  for (const r of rows) {
    if ((r.privacy || 'public') === 'friends' && Number(r.user_id) !== Number(meId)) {
      if (!meId || !(await isMutual(meId, r.user_id))) continue;
    }
    const g = groups[r.user_id] = groups[r.user_id] || {
      user: { id: r.user_id, username: r.username, name: r.name, avatar: r.avatar }, items: [] };
    const vc = await get1('SELECT COUNT(*) AS c FROM story_views WHERE story_id=?', r.id);
    g.items.push({ id: r.id, url: fileUrl(r.file), privacy: r.privacy || 'public', text: r.text || '',
      views: Number(vc.c), created_at: Number(r.created_at) });
  }
  res.json({ groups: Object.values(groups) });
});

// ---------- live : chat, viewers, signalisation WebRTC, cadeaux, stats ----------
async function liveById(id) { return get1('SELECT * FROM lives WHERE id=?', id); }
// v2.33 : l'hôte ou un modérateur du live
async function isLiveModerator(l, userId) {
  if (!l || !userId) return false;
  if (Number(l.user_id) === Number(userId)) return true;
  const m = await get1('SELECT 1 FROM live_moderators WHERE live_id=? AND user_id=?', l.id, userId);
  return !!m;
}
async function liveViewersCount(liveId) {
  const r = await get1('SELECT COUNT(*) AS c FROM live_viewers WHERE live_id=? AND updated_at>?', liveId, now() - 35000);
  return Number(r.c);
}
function liveJSON(l, row, viewersCount) {
  return {
    id: l.id, user_id: l.user_id, title: l.title || '', started_at: Number(l.started_at),
    ended_at: l.ended_at ? Number(l.ended_at) : null,
    username: row ? row.username : undefined, name: row ? row.name : undefined, avatar: row ? row.avatar : undefined,
    viewers_count: viewersCount || 0,
    peak_viewers: Number(l.peak_viewers) || 0, duration_s: Number(l.duration_s) || 0,
    chat_total: Number(l.chat_total) || 0,
    likes: Number(l.likes) || 0, shares: Number(l.shares) || 0, live_type: l.live_type || 'guests', max_guests: Math.max(1, Math.min(8, Number(l.max_guests) || 8)),
  };
}
// Feed des lives en cours (pour les cartes LIVE dans "Pour toi")
// NOTE: déclaré AVANT /api/live/:id sinon Express capture 'history' comme :id
app.get('/api/live/history', auth, async (req, res) => {
  const rows = await allRows('SELECT * FROM live_summaries WHERE user_id=? ORDER BY created_at DESC LIMIT 100', req.userId);
  res.json({ lives: rows.map(liveSummaryJSON) });
});
// ---------- v2.05 : tableau de bord post-live enrichi ----------
async function livePool(liveId, userId) {
  const l = await liveById(liveId);
  if (!l) return { err: 'live introuvable', code: 404 };
  if (Number(l.user_id) !== Number(userId)) return { err: 'non autorisé', code: 403 };
  const s = await get1('SELECT * FROM live_summaries WHERE live_id=?', l.id);
  if (!s) return { err: 'live non terminé', code: 400 };
  const earned = Number(s.usd_earned) || 0, wd = Number(s.withdrawn_usd) || 0, ex = Number(s.exchanged_usd) || 0;
  return { live: l, summary: s, remaining: Math.max(0, Math.round((earned - wd - ex) * 100) / 100) };
}
// Résumé enrichi : top tapoteurs, top envoyeurs de cadeaux, invités montés à l'écran
app.get('/api/live/:id/summary', auth, async (req, res) => {
  try {
    const p = await livePool(req.params.id, req.userId);
    if (p.err) return res.status(p.code).json({ error: p.err });
    const lid = p.live.id;
    const tappers = await allRows(
      "SELECT u.username, u.avatar, t.tap_count AS taps FROM live_taps t JOIN users u ON u.id=t.user_id WHERE t.live_id=? AND t.tap_count>0 ORDER BY t.tap_count DESC LIMIT 20", lid);
    const gifters = await allRows(
      "SELECT u.username, u.avatar, SUM(g.cost) AS total FROM live_gifts g JOIN users u ON u.id=g.from_id WHERE g.live_id=? GROUP BY g.from_id ORDER BY total DESC LIMIT 20", lid);
    const gr = await get1("SELECT COUNT(*) AS c FROM live_guests WHERE live_id=? AND status='accepted'", lid);
    res.json({ ok: true, summary: liveSummaryJSON(p.summary),
      guests_on_screen: Number(gr && gr.c) || 0,
      top_tappers: tappers.map(r => ({ username: r.username, avatar: r.avatar, taps: Number(r.taps) || 0 })),
      top_gifters: gifters.map(r => ({ username: r.username, avatar: r.avatar, total: Number(r.total) || 0 })),
      withdrawn_usd: Number(p.summary.withdrawn_usd) || 0,
      exchanged_usd: Number(p.summary.exchanged_usd) || 0,
      remaining_usd: p.remaining });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// Retrait partiel depuis les gains du live (montant en USD)
app.post('/api/live/withdraw', auth, async (req, res) => {
  try {
    if (await withdrawalsPaused())
      return res.status(403).json({ error: WITHDRAW_PAUSED_MSG, withdrawals_paused: true });
    const { live_id, amount_usd, method_id } = req.body || {};
    if (!live_id) return res.status(400).json({ error: 'live_id requis' });
    const amount = Math.round(Number(amount_usd) * 100) / 100;
    const p = await livePool(live_id, req.userId);
    if (p.err) return res.status(p.code).json({ error: p.err });
    // Règle Kewin 2026-10-03 : gains LIVE -> retrait dès 1 $ (500 pièces), pas 2 $ comme les vidéos.
    // Les taxes/frais des plateformes (PayPal, MonCash...) ne sont pas gérés : on affiche le montant demandé.
    if (!amount || amount < 1) return res.status(400).json({ error: 'minimum 1 $ (500 pièces)' });
    if (amount > p.remaining) return res.status(400).json({ error: 'montant supérieur aux gains restants (' + p.remaining.toFixed(2) + ' $)' });
    const coins = Math.floor(amount * 500);
    if (coins < 500) return res.status(400).json({ error: 'minimum 500 pièces' });
    const pm = await get1('SELECT * FROM payment_methods WHERE id=? AND user_id=?', method_id, req.userId);
    if (!pm) return res.status(400).json({ error: 'moyen de paiement introuvable — ajoute-le dans Retirer mes gains' });
    const vc = await validCoins(req.userId);
    if (coins > vc.valid) return res.status(400).json({ error: 'pas assez de pièces valides (' + vc.valid + ' disponibles)' });
    // FIX race 2026-10-05 (Équipe 8/10) : 2 retraits live simultanés passaient chacun
    // les contrôles (gains restants + pièces valides) puis débitaient 2 fois.
    // Le pool du live est décrémenté atomiquement (UPDATE conditionnel) et le
    // contrôle des pièces valides + débit est sérialisé par utilisateur.
    const lwOut = await withUserLock(req.userId, async () => {
      const p2 = await livePool(live_id, req.userId);
      if (p2.err) { const e = new Error(p2.err); e.httpStatus = p2.code; throw e; }
      if (amount > p2.remaining) {
        const e = new Error('montant supérieur aux gains restants (' + p2.remaining.toFixed(2) + ' $)');
        e.httpStatus = 400; throw e;
      }
      const vc2 = await validCoins(req.userId);
      if (coins > vc2.valid) {
        const e = new Error('pas assez de pièces valides (' + vc2.valid + ' disponibles)');
        e.httpStatus = 400; throw e;
      }
      await raceGap(req); // crochet test concurrence (Équipe 8/10)
      const poolOk = await runSqlChanges(
        'UPDATE live_summaries SET withdrawn_usd=withdrawn_usd+? WHERE live_id=? AND (usd_earned - withdrawn_usd - exchanged_usd) >= ?',
        amount, p.live.id, amount);
      if (!poolOk) { const e = new Error('gains du live insuffisants'); e.httpStatus = 400; throw e; }
      // débit atomique des pièces + suivi du pool du live
      const debited = await runSqlChanges('UPDATE users SET coins=coins-? WHERE id=? AND coins>=?', coins, req.userId, coins);
      if (!debited) {
        await runSql('UPDATE live_summaries SET withdrawn_usd=withdrawn_usd-? WHERE live_id=?', amount, p.live.id);
        const e = new Error('pas assez de pièces'); e.httpStatus = 400; throw e;
      }
      return { ok: true };
    }).catch(e => {
      if (e.httpStatus) return { _err: e.message, _status: e.httpStatus };
      throw e;
    });
    if (lwOut._err) return res.status(lwOut._status).json({ error: lwOut._err });
    await runSql('INSERT INTO ledger(user_id,amount,reason,created_at) VALUES(?,?,?,?)',
      req.userId, -coins, 'retrait live #' + p.live.id + ' (' + pm.type + ')', now());
    const usd = Math.floor(coins / 500 * 100) / 100;
    const wid = await insertId(
      'INSERT INTO withdrawals(user_id,coins,usd,method,account,status,created_at) VALUES(?,?,?,?,?,?,?)',
      req.userId, coins, usd, pm.type, pm.account, 'pending', now());
    const rid = await insertId(
      'INSERT INTO receipts(withdrawal_id,user_id,receipt_no,coins,usd,method,account,status,email_status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
      wid, req.userId, 'TMP', coins, usd, pm.label || pm.type, pm.account, 'pending', 'pending', now());
    const receiptNo = 'VG-' + new Date().getFullYear() + '-' + String(rid).padStart(6, '0');
    await runSql('UPDATE receipts SET receipt_no=? WHERE id=?', receiptNo, rid);
    const me = await get1('SELECT * FROM users WHERE id=?', req.userId);
    const r = await get1('SELECT * FROM receipts WHERE id=?', rid);
    const emailStatus = await sendReceiptEmail(me, { ...r, receipt_no: receiptNo });
    await runSql('UPDATE receipts SET email_status=? WHERE id=?', emailStatus, rid);
    const bal = await get1('SELECT coins FROM users WHERE id=?', req.userId);
    const s2 = await get1('SELECT withdrawn_usd, exchanged_usd, usd_earned FROM live_summaries WHERE live_id=?', p.live.id);
    const rem = Math.max(0, Math.round((Number(s2.usd_earned) - Number(s2.withdrawn_usd) - Number(s2.exchanged_usd)) * 100) / 100);
    res.json({ ok: true, id: wid, usd, coins, status: 'pending', receipt_no: receiptNo,
      coins_balance: bal ? bal.coins : 0, remaining_usd: rem,
      note: 'Le reste (' + rem.toFixed(2) + ' $) reste dans ton solde principal ✓' });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// Échange : convertir des gains USD du live en pièces virtuelles (1 $ = 500 pièces)
// Les pièces sont déjà créditées au fur et à mesure des cadeaux : l'échange réserve
// une part des gains pour booster des vidéos / envoyer des cadeaux en live.
app.post('/api/live/exchange-coins', auth, async (req, res) => {
  try {
    const { live_id, amount_usd } = req.body || {};
    if (!live_id) return res.status(400).json({ error: 'live_id requis' });
    const amount = Math.round(Number(amount_usd) * 100) / 100;
    const p = await livePool(live_id, req.userId);
    if (p.err) return res.status(p.code).json({ error: p.err });
    if (!amount || amount <= 0) return res.status(400).json({ error: 'montant invalide' });
    if (amount > p.remaining) return res.status(400).json({ error: 'montant supérieur aux gains restants (' + p.remaining.toFixed(2) + ' $)' });
    const coins = Math.floor(amount * 500);
    if (coins < 1) return res.status(400).json({ error: 'montant trop petit' });
    // FIX paiements 2026-10-06 : 1) l'ancien code décrémentait le pool (exchanged_usd)
    // SANS créditer les pièces à l'utilisateur → gains perdus ! 2) race : 2 échanges
    // simultanés passaient chacun le contrôle puis dépassaient les gains restants.
    // Décrément atomique conditionnel + crédit réel des pièces.
    const poolOk = await runSqlChanges(
      'UPDATE live_summaries SET exchanged_usd=exchanged_usd+? WHERE live_id=? AND (usd_earned - withdrawn_usd - exchanged_usd) >= ?',
      amount, p.live.id, amount);
    if (!poolOk) return res.status(400).json({ error: 'montant supérieur aux gains restants' });
    await runSql('UPDATE users SET coins=coins+? WHERE id=?', coins, req.userId);
    await runSql('INSERT INTO ledger(user_id,amount,reason,created_at) VALUES(?,?,?,?)',
      req.userId, coins, 'échange live #' + p.live.id + ' : ' + amount.toFixed(2) + ' $ → ' + coins + ' 🪙', now());
    const s2 = await get1('SELECT withdrawn_usd, exchanged_usd, usd_earned FROM live_summaries WHERE live_id=?', p.live.id);
    const rem = Math.max(0, Math.round((Number(s2.usd_earned) - Number(s2.withdrawn_usd) - Number(s2.exchanged_usd)) * 100) / 100);
    const bal = await get1('SELECT coins FROM users WHERE id=?', req.userId);
    res.json({ ok: true, coins, usd: amount, coins_balance: bal ? bal.coins : 0, remaining_usd: rem,
      note: coins + ' 🪙 disponibles dans ton solde pour booster tes vidéos ou envoyer des cadeaux en live ✓' });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.get('/api/live/feed', async (req, res) => {
  try {
    // PAGINATION 2026-10-04 : ?page=N (20/page)
    const lpage = Math.max(1, parseInt(req.query.page, 10) || 1);
    const rows = await allRows(
      'SELECT l.*, u.username, u.name, u.avatar FROM lives l JOIN users u ON u.id=l.user_id WHERE l.ended_at IS NULL ORDER BY l.started_at DESC LIMIT 20 OFFSET ' + ((lpage - 1) * 20));
    const lives = [];
    for (const r of rows) {
      const lj = liveJSON(r, r, await liveViewersCount(r.id));
      const maxGf = Math.max(1, Math.min(8, Number(r.max_guests) || 8));
      const guests = await allRows("SELECT user_id, username, avatar FROM live_guests WHERE live_id=? AND status='accepted' ORDER BY created_at ASC LIMIT " + maxGf, r.id);
      lj.guests = guests;
      lj.guest_slots = maxGf;
      lives.push(lj);
    }
    res.json({ lives, page: lpage, has_more: rows.length >= 20 });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.get('/api/live', async (req, res) => {
  const rows = await allRows(
    'SELECT l.*, u.username, u.name, u.avatar FROM lives l JOIN users u ON u.id=l.user_id WHERE l.ended_at IS NULL ORDER BY l.started_at DESC');
  const lives = [];
  for (const r of rows) lives.push(liveJSON(r, r, await liveViewersCount(r.id)));
  res.json({ lives });
});
// ==================== v2.38 : LIVES PROGRAMMÉS ====================
app.post('/api/live/schedule', auth, async (req, res) => {
  try {
    const b = req.body || {};
    const title = String(b.title || '').slice(0, 100);
    const scheduledAt = Math.floor(Number(b.scheduled_at));
    if (!title) return res.status(400).json({ error: 'titre requis' });
    if (!scheduledAt || scheduledAt <= now()) return res.status(400).json({ error: 'date future requise' });
    if (scheduledAt > now() + 30 * 86400000) return res.status(400).json({ error: 'max 30 jours' });
    const id = await insertId('INSERT INTO live_scheduled(user_id,title,scheduled_at,created_at) VALUES(?,?,?,?)',
      req.userId, title, scheduledAt, now());
    // notifier les abonnés
    const followers = await allRows('SELECT follower_id FROM follows WHERE followed_id=?', req.userId);
    const me = await get1('SELECT username FROM users WHERE id=?', req.userId);
    for (const f of (followers || [])) {
      await insertId('INSERT INTO notifications(user_id,type,actor_id,text,title,is_read,created_at) VALUES(?,?,?,?,?,0,?)',
        f.follower_id, 'live_scheduled', req.userId, '@' + (me ? me.username : '?') + ' prévoit un live : ' + title, '📅 Live programmé', now());
    }
    res.json({ ok: true, id, notified: (followers || []).length });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.get('/api/live/scheduled', auth, async (req, res) => {
  try {
    const rows = await allRows(`SELECT s.*, u.username FROM live_scheduled s JOIN users u ON u.id=s.user_id
      WHERE s.cancelled=0 AND s.scheduled_at > ? AND (s.user_id=? OR s.user_id IN (SELECT followed_id FROM follows WHERE follower_id=?))
      ORDER BY s.scheduled_at ASC LIMIT 50`, now(), req.userId, req.userId);
    res.json({ ok: true, scheduled: rows || [] });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.delete('/api/live/scheduled/:id', auth, async (req, res) => {
  try {
    const s = await get1('SELECT * FROM live_scheduled WHERE id=?', req.params.id);
    if (!s) return res.status(404).json({ error: 'introuvable' });
    if (Number(s.user_id) !== Number(req.userId)) return res.status(403).json({ error: 'non autorisé' });
    await runSql('UPDATE live_scheduled SET cancelled=1 WHERE id=?', req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// ==================== v2.38 : TOURNOIS PK ====================
app.post('/api/pk/tournament', auth, async (req, res) => {
  try {
    const b = req.body || {};
    const title = String(b.title || '').slice(0, 100) || 'Tournoi PK';
    const reward = Math.floor(Number(b.reward_coins)) || 0;
    if (reward > 0) {
      const debited = await runSqlChanges('UPDATE users SET coins=coins-? WHERE id=? AND coins>=?', reward, req.userId, reward);
      if (!debited) return res.status(400).json({ error: 'pas assez de pièces pour la récompense' });
      await runSql('INSERT INTO ledger(user_id,amount,reason,created_at) VALUES(?,?,?,?)', req.userId, -reward, 'cagnotte tournoi PK', now());
    }
    const id = await insertId('INSERT INTO pk_tournaments(creator_id,title,reward_coins,created_at) VALUES(?,?,?,?)',
      req.userId, title, reward, now());
    // le créateur est le premier participant (demi-finale 1, joueur 1)
    await runSql('INSERT INTO pk_matches(tournament_id,round,player1_id,status,created_at) VALUES(?,?,?,?,?)',
      id, 'semi1', req.userId, 'waiting', now());
    res.json({ ok: true, id });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.post('/api/pk/tournament/:id/join', auth, async (req, res) => {
  try {
    // FIX race 2026-10-05 (creusage profond #3) : 2 inscriptions simultanées passaient le
    // comptage → 5e joueur dans un tournoi à 4, ou 2 joueurs sur la même place (fantôme).
    // Verrou PAR TOURNOI (la race est entre utilisateurs différents).
    const out = await withKeyLock('pk:' + req.params.id, async () => {
      const t = await get1('SELECT * FROM pk_tournaments WHERE id=?', req.params.id);
      if (!t) return { error: 'tournoi introuvable', code: 404 };
      // B8 (2026-10-05) : distinguer « tournoi complet » (4 joueurs) de « tournoi fermé ».
      // Un tournoi PLEIN répond 400 « complet » (même si le statut est passé à 'running'
      // dès le 4e joueur) ; un tournoi non plein mais non 'open' répond 403 « fermé ».
      const pc = await get1(
        `SELECT COUNT(*) AS c FROM (SELECT player1_id AS p FROM pk_matches WHERE tournament_id=?
          UNION SELECT player2_id FROM pk_matches WHERE tournament_id=? AND player2_id IS NOT NULL)`,
        req.params.id, req.params.id);
      if (pc && Number(pc.c) >= 4) return { error: 'tournoi complet', code: 400 };
      if (t.status !== 'open') return { error: 'tournoi fermé', code: 403 };
      const existing = await get1('SELECT id FROM pk_matches WHERE tournament_id=? AND (player1_id=? OR player2_id=?)',
        req.params.id, req.userId, req.userId);
      if (existing) return { error: 'déjà inscrit', code: 400 };
      await raceGap(req); // crochet test concurrence : simule l'intercalage Postgres
      // remplir les places : semi1.p2, semi2.p1, semi2.p2
      const m1 = await get1("SELECT * FROM pk_matches WHERE tournament_id=? AND round='semi1'", req.params.id);
      const m2 = await get1("SELECT * FROM pk_matches WHERE tournament_id=? AND round='semi2'", req.params.id);
      if (m1 && !m1.player2_id) {
        await runSql('UPDATE pk_matches SET player2_id=?, status=? WHERE id=?', req.userId, 'ready', m1.id);
      } else if (!m2) {
        await runSql("INSERT INTO pk_matches(tournament_id,round,player1_id,status,created_at) VALUES(?,'semi2',?,'waiting',?)",
          req.params.id, req.userId, now());
      } else if (!m2.player2_id) {
        await runSql('UPDATE pk_matches SET player2_id=?, status=? WHERE id=?', req.userId, 'ready', m2.id);
        await runSql('UPDATE pk_tournaments SET status=? WHERE id=?', 'running', req.params.id);
      } else {
        return { error: 'tournoi complet (4 joueurs)', code: 400 };
      }
      return { ok: true };
    });
    if (out.error) return res.status(out.code || 400).json({ error: out.error });
    res.json(out);
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.get('/api/pk/tournament/:id', auth, async (req, res) => {
  try {
    const t = await get1('SELECT * FROM pk_tournaments WHERE id=?', req.params.id);
    if (!t) return res.status(404).json({ error: 'tournoi introuvable' });
    const matches = await allRows('SELECT m.*, u1.username AS p1_name, u2.username AS p2_name FROM pk_matches m LEFT JOIN users u1 ON u1.id=m.player1_id LEFT JOIN users u2 ON u2.id=m.player2_id WHERE m.tournament_id=? ORDER BY m.id', req.params.id);
    res.json({ ok: true, tournament: t, matches: matches || [] });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.post('/api/pk/tournament/:id/match', auth, async (req, res) => {
  try {
    const t = await get1('SELECT * FROM pk_tournaments WHERE id=?', req.params.id);
    if (!t) return res.status(404).json({ error: 'tournoi introuvable' });
    if (Number(t.creator_id) !== Number(req.userId)) return res.status(403).json({ error: 'seul le créateur' });
    const b = req.body || {};
    const m = await get1('SELECT * FROM pk_matches WHERE id=? AND tournament_id=?', b.match_id, req.params.id);
    if (!m) return res.status(404).json({ error: 'match introuvable' });
    const winner = Number(b.winner_id);
    if (winner !== Number(m.player1_id) && winner !== Number(m.player2_id))
      return res.status(400).json({ error: 'gagnant invalide' });
    await runSql('UPDATE pk_matches SET winner_id=?, player1_score=?, player2_score=?, status=? WHERE id=?',
      winner, Math.floor(Number(b.score1)) || 0, Math.floor(Number(b.score2)) || 0, 'done', m.id);
    // si demi-finale terminée → alimenter la finale
    if (m.round === 'semi1' || m.round === 'semi2') {
      const s1 = await get1("SELECT * FROM pk_matches WHERE tournament_id=? AND round='semi1' AND status='done'", req.params.id);
      const s2 = await get1("SELECT * FROM pk_matches WHERE tournament_id=? AND round='semi2' AND status='done'", req.params.id);
      if (s1 && s2) {
        const fin = await get1("SELECT id FROM pk_matches WHERE tournament_id=? AND round='final'", req.params.id);
        if (!fin) {
          await runSql("INSERT INTO pk_matches(tournament_id,round,player1_id,player2_id,status,created_at) VALUES(?,'final',?,?,?,?)",
            req.params.id, s1.winner_id, s2.winner_id, 'ready', now());
        }
      }
    }
    // si finale terminée → clôturer le tournoi + récompense
    if (m.round === 'final') {
      await runSql('UPDATE pk_tournaments SET status=?, winner_id=?, finished_at=? WHERE id=?', 'done', winner, now(), req.params.id);
      if (Number(t.reward_coins) > 0) {
        await runSql('UPDATE users SET coins=coins+? WHERE id=?', t.reward_coins, winner);
        await runSql('INSERT INTO ledger(user_id,amount,reason,created_at) VALUES(?,?,?,?)',
          winner, t.reward_coins, '🏆 victoire tournoi PK #' + t.id, now());
        await insertId('INSERT INTO notifications(user_id,type,actor_id,text,title,is_read,created_at) VALUES(?,?,?,?,?,0,?)',
          winner, 'pk_win', t.creator_id, 'Tu as remporté le tournoi "' + t.title + '" ! +' + t.reward_coins + ' pièces', '🏆 Victoire !', now());
      }
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// ==================== v2.38 : REVANCHE PK ====================
app.post('/api/live/:id/pk/rematch', auth, async (req, res) => {
  try {
    const l = await liveById(req.params.id);
    if (!l) return res.status(404).json({ error: 'live introuvable' });
    if (l.ended_at) return res.status(403).json({ error: 'live terminé' });
    if (Number(l.user_id) !== Number(req.userId)) return res.status(403).json({ error: 'seul l\'hôte' });
    const b = req.body || {};
    const opponentId = Number(b.opponent_id);
    if (!opponentId) return res.status(400).json({ error: 'adversaire requis' });
    // vérifier qu'il y a eu un PK précédent entre ces deux joueurs (dans les 24h)
    const prevPk = await get1(`SELECT * FROM live_signals WHERE kind='pk_result' AND live_id IN
      (SELECT id FROM lives WHERE user_id IN (?,?)) AND created_at > ? ORDER BY id DESC LIMIT 1`,
      req.userId, opponentId, now() - 86400000);
    const rematchId = await insertId(`INSERT INTO live_signals(live_id,to_user_id,from_user_id,kind,payload,created_at)
      VALUES(?,?,?,?,?,?)`, l.id, opponentId, req.userId, 'pk_rematch',
      JSON.stringify({ prev_pk: prevPk ? prevPk.id : null, at: now() }), now());
    res.json({ ok: true, rematch_id: rematchId, had_previous: !!prevPk });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// ==================== v2.38 : Q&R LIVE ====================
app.post('/api/live/:id/qa', auth, async (req, res) => {
  try {
    const l = await liveById(req.params.id);
    if (!l) return res.status(404).json({ error: 'live introuvable' });
    if (Number(l.user_id) !== Number(req.userId)) return res.status(403).json({ error: 'seul l\'hôte' });
    const mode = (req.body || {}).enabled ? 1 : 0;
    await runSql('UPDATE lives SET qa_mode=? WHERE id=?', mode, l.id);
    res.json({ ok: true, qa_mode: mode });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.post('/api/live/:id/questions', auth, async (req, res) => {
  try {
    const l = await liveById(req.params.id);
    if (!l) return res.status(404).json({ error: 'live introuvable' });
    if (l.ended_at) return res.status(403).json({ error: 'live terminé' });
    const q = String((req.body || {}).question || '').slice(0, 300);
    if (!q) return res.status(400).json({ error: 'question requise' });
    const me = await get1('SELECT username FROM users WHERE id=?', req.userId);
    const id = await insertId('INSERT INTO live_questions(live_id,user_id,username,question,created_at) VALUES(?,?,?,?,?)',
      l.id, req.userId, me ? me.username : '?', q, now());
    res.json({ ok: true, id });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.get('/api/live/:id/questions', auth, async (req, res) => {
  try {
    const l = await liveById(req.params.id);
    if (!l) return res.status(404).json({ error: 'live introuvable' });
    const qs = await allRows('SELECT * FROM live_questions WHERE live_id=? ORDER BY likes DESC, created_at ASC LIMIT 100', l.id);
    res.json({ ok: true, qa_mode: Number(l.qa_mode) || 0, questions: qs || [] });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.post('/api/live/:id/questions/:qid/answer', auth, async (req, res) => {
  try {
    const l = await liveById(req.params.id);
    if (!l) return res.status(404).json({ error: 'live introuvable' });
    if (Number(l.user_id) !== Number(req.userId)) return res.status(403).json({ error: 'seul l\'hôte' });
    const a = String((req.body || {}).answer || '').slice(0, 500);
    // B4 (2026-10-05) : 404 si la question n'existe pas sur ce live
    const q = await get1('SELECT id FROM live_questions WHERE id=? AND live_id=?', req.params.qid, l.id);
    if (!q) return res.status(404).json({ error: 'question introuvable' });
    await runSql('UPDATE live_questions SET answer=?, answered_at=? WHERE id=? AND live_id=?', a, now(), req.params.qid, l.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// ==================== v2.38 : EFFET EN DIRECT ====================
app.post('/api/live/:id/effect', auth, async (req, res) => {
  try {
    const l = await liveById(req.params.id);
    if (!l) return res.status(404).json({ error: 'live introuvable' });
    if (Number(l.user_id) !== Number(req.userId)) return res.status(403).json({ error: 'seul l\'hôte' });
    const effect = String((req.body || {}).effect || '').slice(0, 50);
    await runSql('UPDATE lives SET current_effect=? WHERE id=?', effect, l.id);
    // signaler aux viewers via live_signals
    await insertId(`INSERT INTO live_signals(live_id,from_user_id,kind,payload,created_at) VALUES(?,?,?, ?,?)`,
      l.id, req.userId, 'effect', JSON.stringify({ effect }), now());
    res.json({ ok: true, effect });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.get('/api/live/:id', async (req, res) => {
  const l = await liveById(req.params.id);
  if (!l) return res.status(404).json({ error: 'live introuvable' });
  const row = await get1('SELECT username,name,avatar FROM users WHERE id=?', l.user_id);
  res.json({ live: liveJSON(l, row, await liveViewersCount(l.id)) });
});
// ---------- v2.01 : tapoter sur le live + anti-bot ----------
// CORRECTION Kewin 2026-10-03 : AUCUNE limite, AUCUN blocage — auto-clic autorisé.
// Protection serveur uniquement : le client batche les taps (1 requête / 2s avec {count}).
// CORRECTION Kewin 2026-10-03 : auto-clic AUTORISÉ — aucun blocage punitif.
// Le client envoie les taps en BATCH toutes les 2 secondes : 1 requête = N taps.
// Ça protège le serveur de la surcharge sans jamais punir un utilisateur.
app.post('/api/live/:id/tap', auth, async (req, res) => {
  try {
    const l = await liveById(req.params.id);
    if (!l) return res.status(404).json({ error: 'live introuvable' });
    if (l.ended_at) return res.status(403).json({ error: 'live terminé' });
    let n = parseInt((req.body || {}).count, 10);
    if (!Number.isFinite(n) || n < 1) n = 1;
    if (n > 10000) n = 10000; // garde-fou anti-débordement par requête
    await runSql('UPDATE lives SET likes=likes+? WHERE id=?', n, l.id);
    // v2.05 : comptabilise les taps par utilisateur pour le classement top tapoteurs
    try {
      if (USE_PG) {
        await runSql('INSERT INTO live_taps(live_id,user_id,tap_count,window_start,last_tap_at) VALUES(?,?,?,0,?) ON CONFLICT(live_id,user_id) DO UPDATE SET tap_count=live_taps.tap_count+?',
          l.id, req.userId, n, now(), n);
      } else {
        await runSql('INSERT INTO live_taps(live_id,user_id,tap_count,window_start,last_tap_at) VALUES(?,?,?,?,?) ON CONFLICT(live_id,user_id) DO UPDATE SET tap_count=tap_count+?',
          l.id, req.userId, n, 0, now(), n);
      }
    } catch (e) {}
    const lj = await get1('SELECT likes FROM lives WHERE id=?', l.id);
    res.json({ ok: true, likes: Number(lj.likes) || 0, added: n });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.get('/api/live/:id/stats', async (req, res) => {
  try {
    const l = await liveById(req.params.id);
    if (!l) return res.status(404).json({ error: 'live introuvable' });
    res.json({
      likes: Number(l.likes) || 0,
      shares: Number(l.shares) || 0,
      viewers: await liveViewersCount(l.id),
      chat_total: Number(l.chat_total) || 0,
      live_type: l.live_type || 'guests',
      peak_viewers: Number(l.peak_viewers) || 0,
      gifts_total: Number(l.gifts_total) || 0
    });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});

// Totaux cadeaux par participant — les gains du CRÉATEUR sont CONFIDENTIELS :
// seul le créateur (et le système) voit son vrai total ; les spectateurs
// voient les totaux des invités mais le total du créateur est masqué (null).
app.get('/api/live/:id/gift-totals', auth, async (req, res) => {
  try {
    const l = await liveById(req.params.id);
    if (!l) return res.status(404).json({ error: 'live introuvable' });
    const isHost = Number(l.user_id) === Number(req.userId);
    const rows = await allRows('SELECT to_id, COALESCE(SUM(cost),0) AS total FROM live_gifts WHERE live_id=? GROUP BY to_id', l.id);
    const map = {};
    (rows || []).forEach(r => { map[Number(r.to_id)] = Number(r.total) || 0; });
    const guests = await allRows("SELECT user_id, username FROM live_guests WHERE live_id=? AND status='accepted' ORDER BY created_at ASC", l.id);
    const host = await get1('SELECT id, username FROM users WHERE id=?', l.user_id);
    const totals = [];
    // hôte : total masqué pour les spectateurs
    totals.push({ user_id: Number(l.user_id), username: host ? host.username : '', total: isHost ? (map[Number(l.user_id)] || 0) : null, hidden: !isHost });
    (guests || []).forEach(g => {
      totals.push({ user_id: Number(g.user_id), username: g.username || '', total: map[Number(g.user_id)] || 0, hidden: false });
    });
    res.json({ ok: true, is_host: isHost, totals });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// Top envoyeurs de cadeaux d'un live — PUBLIC : ce sont les DONS ENVOYÉS
// par chaque spectateur (pas les gains reçus : le total reçu par le créateur
// reste confidentiel via gift-totals). Tri décroissant, 200 max.
app.get('/api/live/:id/top-gifters', async (req, res) => {
  try {
    const l = await liveById(req.params.id);
    if (!l) return res.status(404).json({ error: 'live introuvable' });
    let lim = parseInt(req.query.limit, 10) || 200;
    if (lim < 1) lim = 1; if (lim > 200) lim = 200;
    const rows = await allRows(
      'SELECT g.from_id, COALESCE(SUM(g.cost),0) AS total, u.username, u.avatar FROM live_gifts g LEFT JOIN users u ON u.id=g.from_id WHERE g.live_id=? GROUP BY g.from_id, u.username, u.avatar ORDER BY total DESC LIMIT ?',
      l.id, lim);
    res.json({ ok: true, top: (rows || []).map(r => ({
      user_id: Number(r.from_id),
      username: r.username || '',
      avatar: r.avatar || '',
      total: Number(r.total) || 0
    })) });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.post('/api/live/:id/share', auth, async (req, res) => {
  try {
    const l = await liveById(req.params.id);
    if (!l) return res.status(404).json({ error: 'live introuvable' });
    if (l.ended_at) return res.status(403).json({ error: 'live terminé' });
    await runSql('UPDATE lives SET shares=shares+1 WHERE id=?', l.id);
    const lj = await get1('SELECT shares FROM lives WHERE id=?', l.id);
    res.json({ ok: true, shares: Number(lj.shares) || 0 });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.post('/api/live/:id/chat', auth, async (req, res) => {
  try {
    const l = await liveById(req.params.id);
    if (!l) return res.status(404).json({ error: 'live introuvable' });
    if (l.ended_at) return res.status(403).json({ error: 'live terminé' });
    const raw = String((req.body || {}).text || '').trim();
    if (!raw) return res.status(400).json({ error: 'message vide' });
    if (raw.length > 280) return res.status(400).json({ error: 'message trop long (280 caractères max)' });
    // v2.42 : filtre anti-gros mots sur le chat live → rejet 400 (réutilise ALL_BADWORDS)
    if (containsBadword(raw)) return res.status(400).json({ error: 'message refusé : langage inapproprié' });
    // v2.33 : un utilisateur banni ou en sourdine ne peut plus écrire dans le chat du live
    const bk = await get1('SELECT kind FROM live_bans WHERE live_id=? AND user_id=?', l.id, req.userId);
    if (bk) return res.status(403).json({ error: bk.kind === 'mute' ? 'tu es en sourdine sur ce live' : 'tu es banni de ce live' });
    const text = raw;
    const id = await insertId('INSERT INTO live_chat(live_id,user_id,text,created_at) VALUES(?,?,?,?)',
      l.id, req.userId, text, now());
    const u = await get1('SELECT username,name,avatar FROM users WHERE id=?', req.userId);
    // v2.42 : diffusion temps réel aux clients WS du live (/api/live/ws)
    try {
      const room = liveRooms[l.id];
      if (room) {
        const cpayload = JSON.stringify({ t: 'chat', id, user: u ? u.username : '?', text, created_at: now() });
        if (room.broadcaster && room.broadcaster.readyState === 1) room.broadcaster.send(cpayload);
        // COIN-04 : viewers est une Map(ws -> peerId) — forEach(value, key) : le 2e arg est la socket
        room.viewers.forEach((pid, w) => { if (w && w.readyState === 1) w.send(cpayload); });
      }
    } catch (_) {}
    res.json({ ok: true, id, msg: { id, user: pubUser({ ...u, id: req.userId }), text, created_at: now() } });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.get('/api/live/:id/chat', async (req, res) => {
  const l = await liveById(req.params.id);
  if (!l) return res.status(404).json({ error: 'live introuvable' });
  const since = Number(req.query.since) || 0;
  const rows = await allRows(
    // v2.33 : les messages épinglés remontent en premier (pinned=1), puis ordre chronologique
    'SELECT c.id, c.text, c.created_at, COALESCE(c.pinned,0) AS pinned, u.id AS uid, u.username, u.name, u.avatar, u.verified FROM live_chat c JOIN users u ON u.id=c.user_id WHERE c.live_id=? AND c.id>? ORDER BY c.pinned DESC, c.id ASC LIMIT 50',
    l.id, since);
  res.json({ messages: rows.map(r => ({ id: r.id, text: r.text, created_at: Number(r.created_at), pinned: Number(r.pinned) || 0,
    user: pubUser({ id: r.uid, username: r.username, name: r.name, avatar: r.avatar, verified: r.verified }) })) });
});
app.post('/api/live/:id/heartbeat', auth, async (req, res) => {
  const l = await liveById(req.params.id);
  if (!l) return res.status(404).json({ error: 'live introuvable' });
  if (l.ended_at) return res.status(403).json({ error: 'live terminé' });
  if (USE_PG) {
    await runSql('INSERT INTO live_viewers(live_id,user_id,updated_at) VALUES(?,?,?) ON CONFLICT(live_id,user_id) DO UPDATE SET updated_at=EXCLUDED.updated_at',
      l.id, req.userId, now());
  } else {
    await runSql('INSERT OR REPLACE INTO live_viewers(live_id,user_id,updated_at) VALUES(?,?,?)', l.id, req.userId, now());
  }
  res.json({ ok: true, viewers_count: await liveViewersCount(l.id) });
});
// signalisation WebRTC par polling (pas de dépendance ws côté client HTTP)
app.post('/api/live/:id/signal', auth, async (req, res) => {
  try {
    const l = await liveById(req.params.id);
    if (!l) return res.status(404).json({ error: 'live introuvable' });
    if (l.ended_at) return res.status(403).json({ error: 'live terminé' });
    const b = req.body || {};
    const kind = String(b.kind || '');
    if (!['offer', 'answer', 'candidate'].includes(kind)) return res.status(400).json({ error: 'kind invalide' });
    const payload = String(b.payload || '').slice(0, 20000);
    if (!payload) return res.status(400).json({ error: 'payload requis' });
    // par défaut un viewer signale au diffuseur ; le diffuseur précise to=viewer
    const to = b.to ? +b.to : l.user_id;
    const id = await insertId('INSERT INTO live_signals(live_id,to_user_id,from_user_id,kind,payload,created_at) VALUES(?,?,?,?,?,?)',
      l.id, to, req.userId, kind, payload, now());
    // nettoyage : signaux de plus de 10 min
    await runSql('DELETE FROM live_signals WHERE created_at<?', now() - 600000).catch(() => {});
    res.json({ ok: true, id });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.get('/api/live/:id/signal', auth, async (req, res) => {
  try {
    const l = await liveById(req.params.id);
    if (!l) return res.status(404).json({ error: 'live introuvable' });
    const since = Number(req.query.since) || 0;
    await runSql('DELETE FROM live_signals WHERE created_at<?', now() - 600000).catch(() => {});
    let rows;
    if (req.query.for_broadcaster === '1') {
      // le diffuseur récupère les signaux que les viewers lui adressent
      if (Number(l.user_id) !== Number(req.userId)) return res.status(403).json({ error: 'réservé au diffuseur' });
      rows = await allRows('SELECT * FROM live_signals WHERE live_id=? AND id>? AND to_user_id=? AND from_user_id<>? ORDER BY id ASC LIMIT 50',
        l.id, since, l.user_id, l.user_id);
    } else {
      // un viewer récupère les signaux du diffuseur (offre/réponse/candidats, pour lui ou diffusés)
      // v2.38 : inclut aussi les signaux 'effect' (filtres en direct) diffusés à tous
      rows = await allRows("SELECT * FROM live_signals WHERE live_id=? AND id>? AND ((from_user_id=? AND (to_user_id IS NULL OR to_user_id=?) AND kind IN ('offer','answer','candidate','effect')) OR (to_user_id=? AND kind IN ('guest_accept','guest_refuse','guest_invite','guest_invite_accept','guest_invite_refuse'))) ORDER BY id ASC LIMIT 50",
        l.id, since, l.user_id, req.userId, req.userId);
    }
    res.json({ signals: rows.map(s => ({ id: s.id, kind: s.kind, from: s.from_user_id, payload: s.payload })) });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// cadeaux pendant un live
app.post('/api/live/:id/gift', auth, async (req, res) => {
  try {
    const l = await liveById(req.params.id);
    if (!l) return res.status(404).json({ error: 'live introuvable' });
    if (l.ended_at) return res.status(403).json({ error: 'live terminé' });
    const g = GIFT_CATALOG.find(x => x.id === String((req.body || {}).gift_id || ''));
    if (!g) return res.status(400).json({ error: 'cadeau inconnu' });
    const me = await get1('SELECT * FROM users WHERE id=?', req.userId);
    if (!me) return res.status(400).json({ error: 'compte introuvable' });
    // destinataire : créateur par défaut, ou un invité accepté (to_user_id)
    let toUserId = Number(l.user_id);
    if (req.body && req.body.to_user_id) {
      toUserId = Number(req.body.to_user_id);
      if (!toUserId || toUserId === Number(req.userId)) return res.status(400).json({ error: 'impossible' });
      if (toUserId !== Number(l.user_id)) {
        const gg = await get1("SELECT user_id FROM live_guests WHERE live_id=? AND user_id=? AND status='accepted'", l.id, toUserId);
        if (!gg) return res.status(400).json({ error: 'invité introuvable' });
      }
    } else if (Number(l.user_id) === Number(req.userId)) {
      return res.status(400).json({ error: 'impossible' });
    }
    // débit atomique anti double-envoi (race condition)
    const debited = await runSqlChanges('UPDATE users SET coins=coins-? WHERE id=? AND coins>=?', g.cost, req.userId, g.cost);
    if (!debited) return res.status(400).json({ error: 'pas assez de pièces' });
    // FIX sécu 2026-10-05 (failles vague 2 F1) : le score PK était crédité AVANT la validation
    // du cadeau et AVANT le débit → score gonflable gratuitement (même avec un cadeau invalide
    // ou 0 pièce). Maintenant : score APRÈS débit réussi uniquement.
    try {
      const _pkb = await activePkForLive(l.id);
      if (_pkb && _pkb.status === 'active') {
        const col = Number(_pkb.user_a_id) === Number(l.user_id) ? 'score_a' : 'score_b';
        await runSql('UPDATE pk_battles SET ' + col + '=' + col + '+? WHERE id=?', g.cost, _pkb.id);
      }
    } catch (_) {}
    const split = await applyGiftSplit(req.userId, toUserId, g.cost, g.id, l.id);
    await runSql('INSERT INTO gifts(from_id,to_id,video_id,live_id,gift,cost,created_at) VALUES(?,?,?,?,?,?,?)',
      req.userId, toUserId, null, l.id, g.id, g.cost, now());
    await runSql('UPDATE lives SET gifts_total=COALESCE(gifts_total,0)+? WHERE id=?', split.creatorShare, l.id).catch(() => {});
    await notify(toUserId, 'gift', req.userId, null, g.emoji + ' ' + g.name + ' (+' + g.cost + ')'); // v2.31 : montant inclus
    await maybeGiftEmail(toUserId, me.username, g); // v2.33 : e-mail si gros cadeau (≥100 🪙)
    res.json({ ok: true, coins: me.coins - g.cost, to_user_id: toUserId });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// ==================== LIVE façon TikTok : invités, feed, join ====================
// Rejoindre un live comme spectateur (enregistre la présence)
app.post('/api/live/:id/join', auth, async (req, res) => {
  try {
    const l = await liveById(req.params.id);
    if (!l) return res.status(404).json({ error: 'live introuvable' });
    if (l.ended_at) return res.status(403).json({ error: 'live terminé' });
    if (USE_PG) {
      await runSql('INSERT INTO live_viewers(live_id,user_id,updated_at) VALUES(?,?,?) ON CONFLICT(live_id,user_id) DO UPDATE SET updated_at=EXCLUDED.updated_at', l.id, req.userId, now());
    } else {
      await runSql('INSERT OR REPLACE INTO live_viewers(live_id,user_id,updated_at) VALUES(?,?,?)', l.id, req.userId, now());
    }
    const row = await get1('SELECT username,name,avatar FROM users WHERE id=?', l.user_id);
    const lj = liveJSON(l, row, await liveViewersCount(l.id));
    const maxGj = Math.max(1, Math.min(8, Number(l.max_guests) || 8));
    const guests = await allRows("SELECT user_id, username, avatar FROM live_guests WHERE live_id=? AND status='accepted' ORDER BY created_at ASC LIMIT " + maxGj, l.id);
    lj.guests = guests;
    const chat = await allRows('SELECT c.id, c.text, c.created_at, u.username, u.avatar FROM live_chat c JOIN users u ON u.id=c.user_id WHERE c.live_id=? ORDER BY c.id DESC LIMIT 30', l.id);
    res.json({ ok: true, live: lj, chat: chat.reverse() });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// Liste des invités (demandes en attente pour l'hôte, acceptés pour tous)
app.get('/api/live/:id/guests', auth, async (req, res) => {
  try {
    const l = await liveById(req.params.id);
    if (!l) return res.status(404).json({ error: 'live introuvable' });
    const isHost = Number(l.user_id) === Number(req.userId);
    const statusFilter = isHost ? "('pending','accepted')" : "('accepted')";
    const rows = await allRows(
      "SELECT id, user_id, username, avatar, status, mode, created_at FROM live_guests WHERE live_id=? AND status IN " + statusFilter + " ORDER BY created_at ASC LIMIT 20",
      l.id);
    res.json({ guests: rows.map(g => ({ ...g, mode: g.mode || 'video' })), is_host: isHost, max_guests: Math.max(1, Math.min(8, Number(l.max_guests) || 8)) });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// Demande de participation (spectateur -> hôte)
app.post('/api/live/:id/guest-request', auth, async (req, res) => {
  try {
    const l = await liveById(req.params.id);
    if (!l) return res.status(404).json({ error: 'live introuvable' });
    if (l.ended_at) return res.status(403).json({ error: 'live terminé' });
    if (Number(l.user_id) === Number(req.userId)) return res.status(400).json({ error: 'tu es l\'hôte' });
    const me = await get1('SELECT username, avatar FROM users WHERE id=?', req.userId);
    const un = me ? me.username : 'user' + req.userId;
    const av = me ? (me.avatar || '') : '';
    const existing = await get1('SELECT status FROM live_guests WHERE live_id=? AND user_id=?', l.id, req.userId);
    if (existing && existing.status === 'pending') return res.status(400).json({ error: 'demande déjà envoyée' });
    if (existing && existing.status === 'accepted') return res.status(400).json({ error: 'déjà invité' });
    const maxG = Math.max(1, Math.min(8, Number(l.max_guests) || 8));
    const nAcc = await get1("SELECT COUNT(*) AS c FROM live_guests WHERE live_id=? AND status='accepted'", l.id);
    if (Number(nAcc.c) >= maxG) return res.status(400).json({ error: 'Panel complet' });
    // SPEC-12 : mode 'audio' (audio seul, sans caméra) ou 'video' pour l'invité
    const mode = String((req.body || {}).mode || 'video') === 'audio' ? 'audio' : 'video';
    if (USE_PG) {
      await runSql(`INSERT INTO live_guests(live_id,user_id,username,avatar,status,mode,created_at) VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(live_id,user_id) DO UPDATE SET status='pending', mode=EXCLUDED.mode, username=EXCLUDED.username, avatar=EXCLUDED.avatar, created_at=EXCLUDED.created_at`,
        l.id, req.userId, un, av, 'pending', mode, now());
    } else {
      await runSql(`INSERT OR REPLACE INTO live_guests(live_id,user_id,username,avatar,status,mode,created_at) VALUES(?,?,?,?,?,?,?)`,
        l.id, req.userId, un, av, 'pending', mode, now());
    }
    // notifie l'hôte en temps réel via le canal signaux
    await runSql('INSERT INTO live_signals(live_id,to_user_id,from_user_id,kind,payload,created_at) VALUES(?,?,?,?,?,?)',
      l.id, l.user_id, req.userId, 'guest_request', JSON.stringify({ username: un, avatar: av, mode }), now()).catch(() => {});
    await notify(l.user_id, 'guest_request', req.userId, null, null).catch(() => {});
    res.json({ ok: true, mode });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// Réponse de l'hôte (accepter / refuser une demande)
app.post('/api/live/:id/guest-respond', auth, async (req, res) => {
  try {
    const l = await liveById(req.params.id);
    if (!l) return res.status(404).json({ error: 'live introuvable' });
    if (Number(l.user_id) !== Number(req.userId)) return res.status(403).json({ error: 'réservé à l\'hôte' });
    const guestId = Number((req.body || {}).user_id);
    const accept = String((req.body || {}).action || '') === 'accept';
    if (!guestId) return res.status(400).json({ error: 'user_id requis' });
    const g = await get1("SELECT * FROM live_guests WHERE live_id=? AND user_id=? AND status='pending'", l.id, guestId);
    if (!g) return res.status(404).json({ error: 'demande introuvable' });
    if (accept) {
      const n = await get1("SELECT COUNT(*) AS c FROM live_guests WHERE live_id=? AND status='accepted'", l.id);
      const maxGr = Math.max(1, Math.min(8, Number(l.max_guests) || 8));
      if (Number(n.c) >= maxGr) return res.status(400).json({ error: 'Panel complet (' + maxGr + ' invités max)' });
    }
    await runSql('UPDATE live_guests SET status=? WHERE live_id=? AND user_id=?', accept ? 'accepted' : 'refused', l.id, guestId);
    await runSql('INSERT INTO live_signals(live_id,to_user_id,from_user_id,kind,payload,created_at) VALUES(?,?,?,?,?,?)',
      l.id, guestId, req.userId, accept ? 'guest_accept' : 'guest_refuse', JSON.stringify({ live_id: l.id }), now()).catch(() => {});
    res.json({ ok: true, accepted: accept });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// L'hôte invite directement un spectateur
app.post('/api/live/:id/guest-invite', auth, async (req, res) => {
  try {
    const l = await liveById(req.params.id);
    if (!l) return res.status(404).json({ error: 'live introuvable' });
    if (Number(l.user_id) !== Number(req.userId)) return res.status(403).json({ error: 'réservé à l\'hôte' });
    // v2.38+ : accepte user_id OU username (ex. 'robot2')
    let guestId = Number((req.body || {}).user_id);
    if (!guestId) {
      const un = String((req.body || {}).username || '').trim().replace(/^@/, '');
      if (un) { const uu = await get1('SELECT id FROM users WHERE username=?', un); if (uu) guestId = Number(uu.id); }
    }
    if (!guestId || guestId === Number(req.userId)) return res.status(400).json({ error: 'user_id invalide' });
    const u = await get1('SELECT username, avatar FROM users WHERE id=?', guestId);
    if (!u) return res.status(404).json({ error: 'utilisateur introuvable' });
    // SPEC-12 : l'hôte peut inviter en mode 'audio' (audio seul) ou 'video'
    const imode = String((req.body || {}).mode || 'video') === 'audio' ? 'audio' : 'video';
    if (USE_PG) {
      await runSql(`INSERT INTO live_guests(live_id,user_id,username,avatar,status,mode,created_at) VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(live_id,user_id) DO UPDATE SET status='invited', mode=EXCLUDED.mode, created_at=EXCLUDED.created_at`,
        l.id, guestId, u.username, u.avatar || '', 'invited', imode, now());
    } else {
      await runSql(`INSERT OR REPLACE INTO live_guests(live_id,user_id,username,avatar,status,mode,created_at) VALUES(?,?,?,?,?,?,?)`,
        l.id, guestId, u.username, u.avatar || '', 'invited', imode, now());
    }
    await runSql('INSERT INTO live_signals(live_id,to_user_id,from_user_id,kind,payload,created_at) VALUES(?,?,?,?,?,?)',
      l.id, guestId, req.userId, 'guest_invite', JSON.stringify({ live_id: l.id, title: l.title, mode: imode }), now()).catch(() => {});
    res.json({ ok: true, mode: imode });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// Le spectateur répond à l'invitation de l'hôte
app.post('/api/live/:id/guest-invite-respond', auth, async (req, res) => {
  try {
    const l = await liveById(req.params.id);
    if (!l) return res.status(404).json({ error: 'live introuvable' });
    const accept = String((req.body || {}).action || '') === 'accept';
    const g = await get1("SELECT * FROM live_guests WHERE live_id=? AND user_id=? AND status='invited'", l.id, req.userId);
    if (!g) return res.status(404).json({ error: 'invitation introuvable' });
    if (accept) {
      const n = await get1("SELECT COUNT(*) AS c FROM live_guests WHERE live_id=? AND status='accepted'", l.id);
      if (Number(n.c) >= 8) return res.status(400).json({ error: 'grille complète (8 invités max)' });
    }
    await runSql('UPDATE live_guests SET status=? WHERE live_id=? AND user_id=?', accept ? 'accepted' : 'refused', l.id, req.userId);
    await runSql('INSERT INTO live_signals(live_id,to_user_id,from_user_id,kind,payload,created_at) VALUES(?,?,?,?,?,?)',
      l.id, l.user_id, req.userId, accept ? 'guest_invite_accept' : 'guest_invite_refuse', JSON.stringify({ username: g.username }), now()).catch(() => {});
    res.json({ ok: true, accepted: accept });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// Annuler sa demande / quitter la grille
app.post('/api/live/:id/guest-leave', auth, async (req, res) => {
  try {
    const l = await liveById(req.params.id);
    if (!l) return res.status(404).json({ error: 'live introuvable' });
    await runSql("UPDATE live_guests SET status='cancelled' WHERE live_id=? AND user_id=? AND status IN ('pending','invited','accepted')", l.id, req.userId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// SPEC-12 : l'hôte retire un invité (accepté, invité ou en attente)
app.post('/api/live/:id/guest-remove', auth, async (req, res) => {
  try {
    const l = await liveById(req.params.id);
    if (!l) return res.status(404).json({ error: 'live introuvable' });
    if (Number(l.user_id) !== Number(req.userId)) return res.status(403).json({ error: 'réservé à l\'hôte' });
    const guestId = Number((req.body || {}).user_id);
    if (!guestId || guestId === Number(req.userId)) return res.status(400).json({ error: 'user_id invalide' });
    const g = await get1("SELECT * FROM live_guests WHERE live_id=? AND user_id=? AND status IN ('pending','invited','accepted')", l.id, guestId);
    if (!g) return res.status(404).json({ error: 'invité introuvable' });
    await runSql("UPDATE live_guests SET status='removed' WHERE live_id=? AND user_id=?", l.id, guestId);
    // signale l'invité retiré en temps réel (l'app ferme sa tuile)
    await runSql('INSERT INTO live_signals(live_id,to_user_id,from_user_id,kind,payload,created_at) VALUES(?,?,?,?,?,?)',
      l.id, guestId, req.userId, 'guest_removed', JSON.stringify({ live_id: l.id }), now()).catch(() => {});
    await notify(guestId, 'guest_removed', req.userId, null, 'L\u2019hôte t\u2019a retiré du live.').catch(() => {});
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// ---------- coffres au trésor du live (pièces via le serveur, pas en local) ----------
app.post('/api/live/:id/chest', auth, async (req, res) => {
  try {
    const l = await liveById(req.params.id);
    if (!l) return res.status(404).json({ error: 'live introuvable' });
    if (l.ended_at) return res.status(403).json({ error: 'live terminé' });
    if (Number(l.user_id) !== Number(req.userId)) return res.status(403).json({ error: 'seul l\'hôte peut lancer un coffre' });
    const coins = Math.floor(Number((req.body || {}).coins));
    const winners = Math.floor(Number((req.body || {}).winners));
    if (!coins || coins < 10 || coins > 100000) return res.status(400).json({ error: 'montant invalide (10 à 100000 pièces)' });
    if (!winners || winners < 1 || winners > 100) return res.status(400).json({ error: 'nombre de gagnants invalide (1 à 100)' });
    const debited = await runSqlChanges('UPDATE users SET coins=coins-? WHERE id=? AND coins>=?', coins, req.userId, coins);
    if (!debited) return res.status(400).json({ error: 'pas assez de pièces' });
    await runSql('INSERT INTO ledger(user_id,amount,reason,created_at) VALUES(?,?,?,?)',
      req.userId, -coins, 'coffre trésor live #' + l.id, now());
    const chestId = 'c' + now().toString(36) + crypto.randomBytes(3).toString('hex');
    const chest = { chestId, coins, winners, hostId: Number(req.userId), openedBy: {} };
    if (!liveChests.has(String(l.id))) liveChests.set(String(l.id), new Map());
    liveChests.get(String(l.id)).set(chestId, chest);
    const bal = await get1('SELECT coins FROM users WHERE id=?', req.userId);
    res.json({ ok: true, chestId, coins, balance: bal ? bal.coins : 0 });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.post('/api/live/:id/chest/:chestId/open', auth, async (req, res) => {
  try {
    const chests = liveChests.get(String(req.params.id));
    const chest = chests ? chests.get(req.params.chestId) : null;
    if (!chest) return res.status(404).json({ error: 'coffre introuvable ou expiré' });
    if (chest.openedBy[req.userId]) return res.json({ ok: false, reason: 'already' });
    chest.openedBy[req.userId] = 1;
    const won = Math.random() < 0.33;
    const prize = won ? Math.floor(chest.coins / chest.winners) : 0;
    if (prize > 0) {
      await runSql('UPDATE users SET coins=coins+? WHERE id=?', prize, req.userId);
      await runSql('INSERT INTO ledger(user_id,amount,reason,created_at) VALUES(?,?,?,?)',
        req.userId, prize, 'coffre trésor', now());
    }
    const bal = await get1('SELECT coins FROM users WHERE id=?', req.userId);
    res.json({ ok: true, won, prize, coins: bal ? bal.coins : 0 });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// fin de live : enregistre les stats
app.post('/api/live/:id/end', auth, async (req, res) => {
  const l = await liveById(req.params.id);
  if (!l) return res.status(404).json({ error: 'live introuvable' });
  if (Number(l.user_id) !== Number(req.userId)) return res.status(403).json({ error: 'non autorisé' });
  if (l.ended_at) {
    const ex = await get1('SELECT * FROM live_summaries WHERE live_id=?', l.id);
    if (ex) return res.json({ ok: true, summary: liveSummaryJSON(ex) });
  }
  const t = now();
  const durationS = Math.max(0, Math.round((t - Number(l.started_at)) / 1000));
  const hbCount = await liveViewersCount(l.id);
  const peak = Math.max(Number(l.peak_viewers) || 0, Number(l.viewers) || 0, hbCount);
  const gr = await get1('SELECT COALESCE(SUM(cost),0) AS s FROM gifts WHERE live_id=?', l.id);
  const cr = await get1('SELECT COUNT(*) AS c FROM live_chat WHERE live_id=?', l.id);
  const uv = await get1('SELECT COUNT(DISTINCT user_id) AS c FROM live_viewers WHERE live_id=?', l.id);
  const likes = Number(l.likes) || 0, shares = Number(l.shares) || 0;
  const uniqueV = Number(uv && uv.c) || 0;
  // pièces gagnées par le créateur pendant ce live (part 50% déjà créditée à chaque cadeau)
  const ce = await get1('SELECT COALESCE(SUM(creator_share),0) AS s FROM live_gifts WHERE live_id=? AND to_id=?', l.id, l.user_id);
  const coinsEarned = Number(ce && ce.s) || 0;
  const usdEarned = Math.floor(coinsEarned / 500 * 100) / 100;
  await runSql('UPDATE lives SET ended_at=?, duration_s=?, peak_viewers=?, gifts_total=?, chat_total=? WHERE id=?',
    t, durationS, peak, Number(gr.s) || 0, Number(cr.c) || 0, l.id);
  const summ = { live_id: l.id, user_id: l.user_id, title: l.title || '', started_at: Number(l.started_at),
    ended_at: t, duration_s: durationS, peak_viewers: peak, unique_viewers: uniqueV, likes, shares,
    chat_total: Number(cr.c) || 0, coins_earned: coinsEarned, usd_earned: usdEarned, created_at: t };
  if (USE_PG) {
    await runSql(`INSERT INTO live_summaries(live_id,user_id,title,started_at,ended_at,duration_s,peak_viewers,unique_viewers,likes,shares,chat_total,coins_earned,usd_earned,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(live_id) DO UPDATE SET ended_at=EXCLUDED.ended_at,duration_s=EXCLUDED.duration_s,peak_viewers=EXCLUDED.peak_viewers,unique_viewers=EXCLUDED.unique_viewers,likes=EXCLUDED.likes,shares=EXCLUDED.shares,chat_total=EXCLUDED.chat_total,coins_earned=EXCLUDED.coins_earned,usd_earned=EXCLUDED.usd_earned`,
      summ.live_id, summ.user_id, summ.title, summ.started_at, summ.ended_at, summ.duration_s, summ.peak_viewers, summ.unique_viewers, summ.likes, summ.shares, summ.chat_total, summ.coins_earned, summ.usd_earned, summ.created_at);
  } else {
    await runSql(`INSERT OR REPLACE INTO live_summaries(live_id,user_id,title,started_at,ended_at,duration_s,peak_viewers,unique_viewers,likes,shares,chat_total,coins_earned,usd_earned,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      summ.live_id, summ.user_id, summ.title, summ.started_at, summ.ended_at, summ.duration_s, summ.peak_viewers, summ.unique_viewers, summ.likes, summ.shares, summ.chat_total, summ.coins_earned, summ.usd_earned, summ.created_at);
  }
  await runSql('INSERT INTO ledger(user_id,amount,reason,created_at) VALUES(?,?,?,?)',
    l.user_id, 0, 'récap live #' + l.id + ' : ' + coinsEarned + ' pièces (≈ $' + usdEarned.toFixed(2) + ')', t).catch(() => {});
  const room = liveRooms[req.params.id];
  if (room) {
    const msg = JSON.stringify({ t: 'ended' });
    if (room.broadcaster && room.broadcaster.readyState === 1) room.broadcaster.send(msg);
    room.viewers.forEach((pid, w) => { if (w.readyState === 1) w.send(msg); });
    delete liveRooms[req.params.id];
  }
  res.json({ ok: true, summary: summ, stats: { duration_s: durationS, peak_viewers: peak,
    gifts_total: Number(gr.s) || 0, chat_total: Number(cr.c) || 0, coins_earned: coinsEarned, usd_earned: usdEarned,
    unique_viewers: uniqueV, likes, shares } });
});

function liveSummaryJSON(s) {
  return { live_id: Number(s.live_id), title: s.title || '', started_at: Number(s.started_at), ended_at: Number(s.ended_at),
    duration_s: Number(s.duration_s), peak_viewers: Number(s.peak_viewers), unique_viewers: Number(s.unique_viewers),
    likes: Number(s.likes), shares: Number(s.shares), chat_total: Number(s.chat_total),
    coins_earned: Number(s.coins_earned), usd_earned: Number(s.usd_earned) };
}


// ---------- sons : bibliothèque ----------
// upload audio (20 Mo max)
const uploadAudio = multer({
  storage: USE_CLOUDINARY ? multer.memoryStorage() : multer.diskStorage({ destination: UP }),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/^audio\//.test(file.mimetype)) cb(null, true);
    else cb(new Error('seul l\'audio est accepté'));
  },
});
async function storeAudio(file) {
  const ext = path.extname(file.originalname || '') || '.mp3';
  if (USE_CLOUDINARY) {
    const tmp = path.join(os.tmpdir(), 'vgau' + Date.now() + '_' + crypto.randomBytes(6).toString('hex') + ext);
    fs.writeFileSync(tmp, file.buffer);
    try {
      const up = await cloudinary.uploader.upload(tmp, { resource_type: 'video', folder: 'vidigagne/sounds' });
      return up.secure_url;
    } finally { fs.unlink(tmp, () => {}); }
  }
  const fname = 'a' + Date.now() + '_' + crypto.randomBytes(6).toString('hex') + ext;
  fs.renameSync(file.path, path.join(UP, fname));
  return fname;
}
function soundJSON(s, meId, isFav, favCount) {
  return { id: s.id, title: s.title, artist: s.artist || '', url: fileUrl(s.audio_url),
    use_count: Number(s.use_count) || 0, fav_count: favCount == null ? undefined : Number(favCount),
    is_fav: !!isFav, user_id: s.user_id, created_at: Number(s.created_at) };
}
app.post('/api/sounds', auth, uploadAudio.single('audio'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'aucun audio reçu' });
    const title = String((req.body || {}).title || '').trim().slice(0, 80);
    if (!title) return res.status(400).json({ error: 'titre requis' });
    const artist = String((req.body || {}).artist || '').trim().slice(0, 80);
    const url = await storeAudio(req.file);
    const id = await insertId('INSERT INTO sounds(user_id,title,artist,audio_url,created_at) VALUES(?,?,?,?,?)',
      req.userId, title, artist, url, now());
    const s = await get1('SELECT * FROM sounds WHERE id=?', id);
    res.json({ sound: soundJSON(s) });
  } catch (e) { res.status(500).json({ error: 'échec du téléversement' }); }
});
app.get('/api/sounds/trending', async (req, res) => {
  // PAGINATION 2026-10-04 : ?page=N (20/page)
  const spage = Math.max(1, parseInt(req.query.page, 10) || 1);
  const rows = await allRows('SELECT * FROM sounds ORDER BY use_count DESC, created_at DESC LIMIT 20 OFFSET ' + ((spage - 1) * 20));
  res.json({ sounds: rows.map(s => soundJSON(s)), page: spage, has_more: rows.length >= 20 });
});
app.get('/api/sounds/search', async (req, res) => {
  const q = '%' + String(req.query.q || '').toLowerCase() + '%';
  // PAGINATION 2026-10-04 : ?page=N (20/page)
  const sq2page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const rows = await allRows('SELECT * FROM sounds WHERE LOWER(title) LIKE ? OR LOWER(artist) LIKE ? ORDER BY use_count DESC LIMIT 20 OFFSET ' + ((sq2page - 1) * 20), q, q);
  res.json({ sounds: rows.map(s => soundJSON(s)), page: sq2page, has_more: rows.length >= 20 });
});
app.get('/api/sounds/favs/mine', auth, async (req, res) => {
  // PAGINATION 2026-10-04 : ?page=N (30/page)
  const sfpage = Math.max(1, parseInt(req.query.page, 10) || 1);
  const rows = await allRows('SELECT s.* FROM sound_favs f JOIN sounds s ON s.id=f.sound_id WHERE f.user_id=? ORDER BY f.created_at DESC LIMIT 30 OFFSET ' + ((sfpage - 1) * 30), req.userId);
  res.json({ sounds: rows.map(s => soundJSON(s, req.userId, true)), page: sfpage, has_more: rows.length >= 30 });
});
app.get('/api/sounds/:id', async (req, res) => {
  const s = await get1('SELECT * FROM sounds WHERE id=?', req.params.id);
  if (!s) return res.status(404).json({ error: 'son introuvable' });
  const meId = await optUserId(req);
  const fav = meId ? await get1('SELECT 1 FROM sound_favs WHERE user_id=? AND sound_id=?', meId, s.id) : null;
  const fc = await get1('SELECT COUNT(*) AS c FROM sound_favs WHERE sound_id=?', s.id);
  // vidéos utilisant ce son (le champ videos.sound contient le titre du son)
  const vids = await allRows("SELECT * FROM videos WHERE LOWER(sound)=LOWER(?) AND hidden=0 AND (scheduled_at IS NULL OR scheduled_at<=?) ORDER BY created_at DESC LIMIT 20", s.title, now());
  const videos = [];
  for (const v of vids) { if (await canSeeVideo(v, meId)) { const j = await videoJSON(v, meId); if (j) videos.push(j); } }
  res.json({ sound: soundJSON(s, meId, !!fav, Number(fc.c)), videos });
});
app.post('/api/sounds/:id/fav', auth, async (req, res) => {
  const s = await get1('SELECT * FROM sounds WHERE id=?', req.params.id);
  if (!s) return res.status(404).json({ error: 'son introuvable' });
  await insertIgnore('INSERT OR IGNORE INTO sound_favs(user_id,sound_id,created_at) VALUES(?,?,?)', req.userId, s.id, now());
  res.json({ ok: true });
});
app.delete('/api/sounds/:id/fav', auth, async (req, res) => {
  await runSql('DELETE FROM sound_favs WHERE user_id=? AND sound_id=?', req.userId, req.params.id);
  res.json({ ok: true });
});

// ---------- pourboires sur une vidéo ----------
app.post('/api/videos/:id/tip', auth, async (req, res) => {
  try {
    const v = await get1('SELECT * FROM videos WHERE id=?', req.params.id);
    if (!v) return res.status(404).json({ error: 'vidéo introuvable' });
    if (Number(v.user_id) === Number(req.userId)) return res.status(400).json({ error: 'impossible' });
    const n = Math.floor(Number((req.body || {}).coins));
    if (!n || n < 1 || n > 10000) return res.status(400).json({ error: 'montant invalide (1 à 10000 pièces)' });
    const me = await get1('SELECT * FROM users WHERE id=?', req.userId);
    if (!me) return res.status(400).json({ error: 'compte introuvable' });
    const debited = await runSqlChanges('UPDATE users SET coins=coins-? WHERE id=? AND coins>=?', n, req.userId, n);
    if (!debited) return res.status(400).json({ error: 'pas assez de pièces' });
    await runSql('UPDATE users SET coins=coins+? WHERE id=?', n, v.user_id);
    await runSql('INSERT INTO ledger(user_id,amount,reason,created_at) VALUES(?,?,?,?)',
      req.userId, -n, 'pourboire vidéo #' + v.id, now());
    await runSql('INSERT INTO ledger(user_id,amount,reason,created_at) VALUES(?,?,?,?)',
      v.user_id, n, 'pourboire reçu vidéo #' + v.id, now());
    await runSql('INSERT INTO tips(video_id,from_user_id,to_user_id,coins,created_at) VALUES(?,?,?,?,?)',
      v.id, req.userId, v.user_id, n, now());
    await notify(v.user_id, 'tip', req.userId, v.id, String(n));
    // v2.44-EQC-WH : pourboire → webhook tip.new (créateur pro)
    fireWebhooks(v.user_id, 'tip.new', { from: me.username, coins: n, video_id: v.id, at: Date.now() });
    // v2.44-EQD-MAIL : e-mail de pourboire reçu (seuil anti-spam = même seuil que les cadeaux)
    if (n >= GIFT_EMAIL_MIN_COINS) {
      try {
        const tu = await get1('SELECT email, username FROM users WHERE id=?', v.user_id);
        if (tu && tu.email) sendVidiEmail(tu.email,
          '🪙 Pourboire reçu sur VidiGagne !',
          '<p style="font-size:18px">🪙 @' + String(me.username || 'un fan').replace(/</g, '&lt;') + ' t\'a envoyé un pourboire !</p>'
          + '<p style="color:#ffd700;font-size:22px;font-weight:800">+' + n + ' 🪙</p>'
          + '<p style="color:#ccc;font-size:14px">Merci pour ta vidéo — tes fans te soutiennent ! ✨</p>',
          '@' + (me.username || 'un fan') + ' t\'a envoyé un pourboire de ' + n + ' pièces sur VidiGagne !').catch(() => {});
      } catch (_) {}
    }
    const balT = await get1('SELECT coins FROM users WHERE id=?', req.userId);
    res.json({ ok: true, coins: balT ? balT.coins : 0 });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});

// ---------- abonnements payants aux créateurs ----------
app.post('/api/users/:username/subscribe', auth, async (req, res) => {
  try {
    const u = await get1('SELECT * FROM users WHERE username=?', String(req.params.username).toLowerCase());
    if (!u) return res.status(404).json({ error: 'utilisateur introuvable' });
    if (Number(u.id) === Number(req.userId)) return res.status(400).json({ error: 'impossible' });
    // SPEC-13 : paliers — si le créateur a des paliers actifs, le prix vient du palier choisi
    // (le prix est fixé par le CRÉATEUR, jamais par le client — anti-fraude).
    // Sinon : comportement historique (prix unique sub_price).
    let tierId = null, tierName = '';
    const tiers = await allRows('SELECT * FROM creator_sub_tiers WHERE creator_id=? AND active=1 ORDER BY position ASC', u.id);
    let price;
    if (tiers.length) {
      tierId = Number((req.body || {}).tier_id) || 0;
      const tier = tiers.find(t => Number(t.id) === tierId);
      if (!tier) return res.status(400).json({ error: 'choisis un palier d\u2019abonnement' });
      price = Math.max(10, Math.min(100000, Math.floor(Number(tier.price_coins) || 0)));
      tierName = tier.name;
    } else {
      // le prix est fixé par le CRÉATEUR, jamais par le client (anti-fraude)
      price = Math.max(10, Math.min(100000, Math.floor(Number(u.sub_price) || 0)));
    }
    if (!tiers.length && (Number(u.sub_enabled) !== 1 || !price)) return res.status(400).json({ error: 'abonnement non proposé par ce créateur' });
    if (tiers.length && !price) return res.status(400).json({ error: 'abonnement non proposé par ce créateur' });
    // FIX race 2026-10-05 (Équipe 8/10) : double-clic « S'abonner » — section
    // débit+insert sérialisée par abonné ; un 2e appel < 15 s après la création
    // (double-clic réseau) est idempotent : pas de 2e débit. Avant : 2 requêtes
    // simultanées débitaient 2 fois le prix (prouvé : 8000 au lieu de 9000).
    const subOut = await withUserLock(req.userId, async () => {
      const t0 = now();
      const dup = await get1('SELECT * FROM creator_subs WHERE creator_id=? AND subscriber_id=? AND active=1 AND expires_at>?', u.id, req.userId, t0);
      if (dup && t0 - Number(dup.created_at) < 15000)
        return { ok: true, duplicate: true, expires_at: Number(dup.expires_at) };
      await raceGap(req); // crochet test concurrence (Équipe 8/10) : simule l'intercalage Postgres
      const debited = await runSqlChanges('UPDATE users SET coins=coins-? WHERE id=? AND coins>=?', price, req.userId, price);
      if (!debited) { const e = new Error('pas assez de pièces'); e.httpStatus = 400; throw e; }
      await runSql('UPDATE users SET coins=coins+? WHERE id=?', price, u.id);
      await runSql('INSERT INTO ledger(user_id,amount,reason,created_at) VALUES(?,?,?,?)',
        req.userId, -price, 'abonnement @' + u.username, now());
      await runSql('INSERT INTO ledger(user_id,amount,reason,created_at) VALUES(?,?,?,?)',
        u.id, price, 'abonnement reçu', now());
      const t = now(), exp = t + 30 * 86400000;
      const cur = await get1('SELECT * FROM creator_subs WHERE creator_id=? AND subscriber_id=? AND active=1 AND expires_at>?', u.id, req.userId, t);
      if (cur) {
        await runSql('UPDATE creator_subs SET expires_at=?, price_coins=?, tier_id=? WHERE id=?', Number(cur.expires_at) + 30 * 86400000, price, tierId || null, cur.id);
      } else {
        await insertId('INSERT INTO creator_subs(creator_id,subscriber_id,price_coins,tier_id,auto_renew,started_at,expires_at,active,created_at) VALUES(?,?,?,?,?,?,?,1,?)',
          u.id, req.userId, price, tierId || null, 1, t, exp, t);
      }
      const sub = await get1('SELECT * FROM creator_subs WHERE creator_id=? AND subscriber_id=? AND active=1 ORDER BY expires_at DESC', u.id, req.userId);
      await notify(u.id, 'subscribe', req.userId, null, tierName ? 'Nouvel abonné palier « ' + tierName + ' » 🏅' : '');
      return { ok: true, expires_at: Number(sub.expires_at), tier_id: tierId || null, tier_name: tierName };
    }).catch(e => {
      if (e.httpStatus) return { _err: e.message, _status: e.httpStatus };
      throw e;
    });
    if (subOut._err) return res.status(subOut._status).json({ error: subOut._err });
    res.json(subOut);
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.get('/api/users/:username/subscription', auth, async (req, res) => {
  const u = await get1('SELECT * FROM users WHERE username=?', String(req.params.username).toLowerCase());
  if (!u) return res.status(404).json({ error: 'utilisateur introuvable' });
  const s = await get1('SELECT * FROM creator_subs WHERE creator_id=? AND subscriber_id=? AND active=1 AND expires_at>? ORDER BY expires_at DESC',
    u.id, req.userId, now());
  // FIX 2026-10-04 (bot chain-subscription) : l'UI (paintCrSub/openSubSettings) attend
  // enabled/price/subscribed — avant, seul {subscription} était renvoyé et le bouton « S'abonner »
  // ne s'affichait jamais. On garde {subscription} pour compatibilité.
  const price = Math.max(10, Math.min(100000, Math.floor(Number(u.sub_price) || 0)));
  const enabled = Number(u.sub_enabled) === 1 && price > 0;
  // SPEC-13 : paliers + palier actuel de l'abonné
  const tiers = await allRows('SELECT * FROM creator_sub_tiers WHERE creator_id=? AND active=1 ORDER BY position ASC', u.id);
  let tier = null;
  if (s && s.tier_id) {
    const t = tiers.find(x => Number(x.id) === Number(s.tier_id));
    if (t) tier = { id: Number(t.id), name: t.name, badge_emoji: t.badge_emoji || '🏅' };
  }
  res.json({ enabled: enabled || tiers.length > 0, price, subscribed: !!s,
    tiers: tiers.map(t => ({ id: Number(t.id), name: t.name, price_coins: Number(t.price_coins),
      perks: JSON.parse(t.perks || '[]'), badge_emoji: t.badge_emoji || '🏅', position: Number(t.position) })),
    tier,
    subscription: s ? { active: true, expires_at: Number(s.expires_at), price_coins: Number(s.price_coins) } : { active: false } });
});
// v2.36 : désabonnement d'un créateur (fin de période, sans remboursement — standard des abonnements)
app.delete('/api/users/:username/subscribe', auth, async (req, res) => {
  try {
    const u = await get1('SELECT * FROM users WHERE username=?', String(req.params.username).toLowerCase());
    if (!u) return res.status(404).json({ error: 'utilisateur introuvable' });
    const s = await get1('SELECT * FROM creator_subs WHERE creator_id=? AND subscriber_id=? AND active=1', u.id, req.userId);
    if (!s) return res.status(404).json({ error: 'aucun abonnement actif' });
    await runSql('UPDATE creator_subs SET active=0 WHERE id=?', s.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// ==================== SPEC-13 : PALIERS D'ABONNEMENT (façon TikTok) ====================
// Un créateur définit jusqu'à 3 paliers (position 1,2,3) avec nom, prix mensuel,
// perks (avantages, JSON) et badge emoji. Les fans choisissent un palier ;
// le renouvellement mensuel est automatique (renewSubs, cron quotidien).
// "Sub Space" : fil des vidéos réservées aux abonnés (visibility='subscribers').
app.get('/api/creator/sub-tiers', auth, async (req, res) => {
  try {
    const tiers = await allRows('SELECT * FROM creator_sub_tiers WHERE creator_id=? AND active=1 ORDER BY position ASC', req.userId);
    res.json({ tiers: tiers.map(t => ({ id: Number(t.id), name: t.name, price_coins: Number(t.price_coins),
      perks: JSON.parse(t.perks || '[]'), badge_emoji: t.badge_emoji || '🏅', position: Number(t.position) })) });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.put('/api/creator/sub-tiers', auth, async (req, res) => {
  try {
    const list = Array.isArray((req.body || {}).tiers) ? (req.body || {}).tiers.slice(0, 3) : [];
    const clean = [];
    for (let i = 0; i < list.length; i++) {
      const t = list[i] || {};
      const price = Math.max(10, Math.min(100000, Math.floor(Number(t.price_coins) || 0)));
      if (!price) continue;
      let perks = [];
      try { perks = Array.isArray(t.perks) ? t.perks.map(x => String(x).slice(0, 80)).slice(0, 8) : JSON.parse(String(t.perks || '[]')).slice(0, 8); }
      catch (_) { perks = []; }
      clean.push({ name: String(t.name || ('Palier ' + (i + 1))).slice(0, 30),
        price_coins: price, perks: JSON.stringify(perks),
        badge_emoji: String(t.badge_emoji || '🏅').slice(0, 8), position: i + 1 });
    }
    await runSql('UPDATE creator_sub_tiers SET active=0 WHERE creator_id=?', req.userId);
    for (const c of clean) {
      await runSql(`INSERT INTO creator_sub_tiers(creator_id,name,price_coins,perks,badge_emoji,position,active,created_at)
        VALUES(?,?,?,?,?,?,1,?)`, req.userId, c.name, c.price_coins, c.perks, c.badge_emoji, c.position, now());
    }
    // si le créateur définit des paliers, son prix unique historique est désactivé
    if (clean.length) await runSql('UPDATE users SET sub_enabled=0 WHERE id=?', req.userId);
    res.json({ ok: true, count: clean.length });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.get('/api/users/:id/sub-tiers', async (req, res) => {
  try {
    const u = await get1('SELECT id, username FROM users WHERE id=?', Number(req.params.id));
    if (!u) return res.status(404).json({ error: 'utilisateur introuvable' });
    const tiers = await allRows('SELECT * FROM creator_sub_tiers WHERE creator_id=? AND active=1 ORDER BY position ASC', u.id);
    res.json({ user_id: Number(u.id), username: u.username,
      tiers: tiers.map(t => ({ id: Number(t.id), name: t.name, price_coins: Number(t.price_coins),
        perks: JSON.parse(t.perks || '[]'), badge_emoji: t.badge_emoji || '🏅', position: Number(t.position) })) });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// Sub Space : vidéos réservées aux abonnés, des créateurs auxquels je suis abonné(e)
app.get('/api/sub-space', auth, async (req, res) => {
  try {
    const rows = await allRows(
      `SELECT v.* FROM videos v WHERE v.visibility='subscribers'
       AND EXISTS (SELECT 1 FROM creator_subs cs WHERE cs.creator_id=v.user_id AND cs.subscriber_id=? AND cs.active=1 AND cs.expires_at>?)
       ORDER BY v.created_at DESC LIMIT 50`, req.userId, now());
    const videos = [];
    for (const v of rows) { try { videos.push(await videoJSON(v, req.userId)); } catch (_) {} }
    res.json({ videos });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// Renouvellement mensuel automatique des abonnements (cron quotidien)
async function renewSubs() {
  try {
    const t = now();
    const due = await allRows('SELECT * FROM creator_subs WHERE active=1 AND auto_renew=1 AND expires_at<=?', t + 86400000);
    for (const s of due) {
      await withUserLock(s.subscriber_id, async () => {
        const cur = await get1('SELECT * FROM creator_subs WHERE id=? AND active=1', s.id);
        if (!cur || Number(cur.expires_at) > t + 86400000) return; // déjà renouvelé
        const price = Math.max(1, Math.floor(Number(cur.price_coins) || 0));
        const debited = await runSqlChanges('UPDATE users SET coins=coins-? WHERE id=? AND coins>=?', price, cur.subscriber_id, price);
        if (!debited) {
          await runSql('UPDATE creator_subs SET active=0 WHERE id=?', cur.id);
          await notify(cur.subscriber_id, 'sub_expired', cur.creator_id, null, 'Ton abonnement a expiré (pas assez de pièces pour le renouvellement).');
          return;
        }
        await runSql('UPDATE users SET coins=coins+? WHERE id=?', price, cur.creator_id);
        await runSql('INSERT INTO ledger(user_id,amount,reason,created_at) VALUES(?,?,?,?)', cur.subscriber_id, -price, 'renouvellement abonnement', t);
        await runSql('INSERT INTO ledger(user_id,amount,reason,created_at) VALUES(?,?,?,?)', cur.creator_id, price, 'abonnement renouvelé', t);
        await runSql('UPDATE creator_subs SET expires_at=? WHERE id=?', Number(cur.expires_at) + 30 * 86400000, cur.id);
        await notify(cur.subscriber_id, 'sub_renewed', cur.creator_id, null, 'Ton abonnement a été renouvelé (' + price + ' 🪙).');
      }).catch(() => {});
    }
  } catch (e) { console.error('renewSubs:', e.message); }
}
// Déclencheur admin du renouvellement (tests + forçage manuel)
app.post('/api/admin/subs/renew', async (req, res) => {
  try {
    const t = req.headers['x-admin-token'];
    if (!process.env.ADMIN_TOKEN || t !== process.env.ADMIN_TOKEN) return res.status(403).json({ error: 'non autorisé' });
    await renewSubs();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// désactive les abonnements expirés (toutes les 24 h)
async function expireSubs() {
  try { await runSql('UPDATE creator_subs SET active=0 WHERE active=1 AND expires_at<=?', now()); } catch (e) {}
}

// FIX 2026-10-05 (audit DB) : purge des tables à croissance illimitée.
// video_views/watch_events ne sont PAS purgées (les compteurs de vues et l'historique
// sont calculés en live depuis ces tables). En revanche les journaux techniques
// (audit, webhooks, alertes fraude, file de notifs, impressions pubs) n'ont aucune
// valeur après 30-90 jours et feraient exploser la base à grande échelle.
async function purgeOldLogs() {
  const t = now(), D = 86400000;
  try { await runSql('DELETE FROM audit_logs WHERE created_at<?', t - 90 * D); } catch (e) {}
  try { await runSql('DELETE FROM webhook_deliveries WHERE created_at<?', t - 30 * D); } catch (e) {}
  try { await runSql('DELETE FROM fraud_alerts WHERE created_at<?', t - 90 * D); } catch (e) {}
  try { await runSql('DELETE FROM notif_queue WHERE sent_at IS NOT NULL AND sent_at<?', t - 30 * D); } catch (e) {}
  try { await runSql('DELETE FROM ad_impressions WHERE created_at<?', t - 90 * D); } catch (e) {}
  // notifications lues de plus de 180 jours (les non-lues sont conservées)
  try { await runSql('DELETE FROM notifications WHERE is_read=1 AND created_at<?', t - 180 * D); } catch (e) {}
  // v2.48 (SPEC analytics-pro) : purge des sources de trafic > 90 jours
  try { await runSql('DELETE FROM video_view_sources WHERE created_at<?', t - 90 * D); } catch (e) {}
}

// ==================== SERVEUR v11 — V3 ====================
// BOUTIQUE + LIVE SHOPPING + PUBLICITÉ + MODÉRATION AUTO + FINANCIER
const PLATFORM_FEE_PCT = 10;   // commission plateforme sur chaque vente
const AFFILIATE_RATE_PCT = 5;  // commission d'affiliation par défaut (% du total)
const AD_COST_IMPRESSION = 1;  // pièces débitées du budget par impression
const AD_COST_CLICK = 5;       // pièces débitées du budget par clic
// v2.48 (bots chaîne vague 3 — 2026-10-05) : constantes des features
const CHAPTER_LIMIT = 20;            // SPEC-05 : max 20 chapitres par vidéo
const HASHTAG_FOLLOW_LIMIT = 200;    // SPEC-03 : max 200 hashtags suivis par utilisateur
const OFFLINE_QUOTA = 50;            // SPEC-01 : max 50 vidéos suivies hors-ligne par utilisateur
const TRANSLATE_QUOTA = 100;         // SPEC-04 : max 100 traductions/jour par utilisateur
const VIDEO_CREATOR_RATE_PCT = 5;    // SPEC-06 : commission créateur sur ventes via sa vidéo (%)
const PREMIERE_LIMIT_PER_CREATOR = 3;// SPEC-07 : max 3 premieres à venir par créateur
const KEYWORD_FILTER = 'keyword_filter'; // SPEC-02 : marqueur filtrage mots-clés (retenue)
// SPEC-07 : taxonomie des centres d'intérêt (même liste que l'app — validation serveur anti-injection)
const INTERESTS = ['Humour','Musique','Danse','Cuisine','Sport','Voyage','Mode','Gaming','Animaux','Cinéma','Tech','Beauté'];
// SPEC-02 : normalisation unicode des mots-clés (NFD + suppression diacritiques + minuscules)
function normalize(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

// ---------- modération auto (honnête : simple filtre de mots, sans IA externe) ----------
// Liste configurable : insultes graves, discriminations, menaces, arnaques courantes.
const BANNED_WORDS = [
  'connard', 'connasse', 'salope', 'salaud', 'pute', 'enculé', 'encule', 'fdp', 'ntm',
  'nique ta', 'nique ton', 'ferme ta gueule', 'tg ',
  'nègre', 'négro', 'bougnoule', 'youpin', 'bicot', 'sale arabe', 'sale juif',
  'je vais te tuer', 'va mourir', 'suicide-toi', 'je te tue',
  'argent facile', 'doublez votre argent', 'crypto x100', 'gagner de l’argent sans rien faire',
];
function scanBanned(text) {
  const t = ' ' + String(text || '').toLowerCase().normalize('NFC') + ' ';
  for (const w of BANNED_WORDS) {
    if (t.includes(w.toLowerCase())) return w;
  }
  return null;
}
async function flagForReview(itemType, itemId, reason) {
  try {
    await runSql(`INSERT INTO review_queue(item_type,item_id,reason,status,created_at) VALUES(?,?,?,'pending',?)`,
      itemType, itemId, String(reason || '').slice(0, 200), now());
  } catch (e) {}
}
// v2.39 : file de modération auto (mod_queue) — parallèle à review_queue, avec actions admin dédiées
async function modFlag(targetType, targetId, reason) {
  try {
    await runSql(`INSERT INTO mod_queue(target_type,target_id,reason,status,created_at) VALUES(?,?,?,'pending',?)`,
      targetType, targetId, String(reason || '').slice(0, 200), now());
  } catch (e) {}
}

// ---------- boutique : helpers ----------
function productJSON(p) {
  return {
    id: p.id, seller_id: p.seller_id, category_id: p.category_id || null,
    title: p.title, description: p.description || '',
    price_coins: Number(p.price_coins) || 0, stock: Number(p.stock) || 0,
    image: p.image_url ? fileUrl(p.image_url) : null,
    active: !!p.active, created_at: Number(p.created_at) || 0,
  };
}
async function requireSeller(req, res) {
  const u = await get1('SELECT * FROM users WHERE id=?', req.userId);
  if (!u || !u.seller_name) { res.status(403).json({ error: 'devenez vendeur pour continuer' }); return null; }
  return u;
}

// ---------- boutique : catégories ----------
app.get('/api/shop/categories', async (req, res) => {
  const rows = await allRows('SELECT * FROM categories ORDER BY name ASC');
  res.json({ categories: rows });
});

// ---------- boutique : devenir vendeur / profil vendeur ----------
app.get('/api/shop/seller', auth, async (req, res) => {
  const u = await get1('SELECT seller_name, seller_bio, seller_verified FROM users WHERE id=?', req.userId);
  if (!u || !u.seller_name) return res.status(404).json({ error: 'pas encore vendeur' });
  res.json({ seller: { name: u.seller_name, bio: u.seller_bio || '', verified: !!u.seller_verified } });
});
app.post('/api/shop/seller', auth, async (req, res) => {
  const name = String((req.body || {}).name || '').trim().slice(0, 60);
  const bio = String((req.body || {}).bio || '').trim().slice(0, 200);
  if (!name) return res.status(400).json({ error: 'nom de boutique requis' });
  const u = await get1('SELECT * FROM users WHERE id=?', req.userId);
  if (u.seller_name) return res.status(400).json({ error: 'déjà vendeur' });
  await runSql('UPDATE users SET seller_name=?, seller_bio=? WHERE id=?', name, bio, req.userId);
  res.json({ ok: true, seller_name: name });
});
app.get('/api/shop/sellers/:username', async (req, res) => {
  const u = await get1('SELECT * FROM users WHERE username=?', String(req.params.username).toLowerCase());
  if (!u || !u.seller_name) return res.status(404).json({ error: 'vendeur introuvable' });
  const prods = await allRows('SELECT * FROM products WHERE seller_id=? AND active=1 ORDER BY created_at DESC', u.id);
  res.json({
    seller: { username: u.username, name: u.name, avatar: u.avatar,
      seller_name: u.seller_name, seller_bio: u.seller_bio || '', seller_verified: !!u.seller_verified },
    products: prods.map(productJSON),
  });
});

// ---------- v2.42 : comptes professionnels (business) ----------
app.post('/api/me/business', auth, async (req, res) => {
  try {
    const b = req.body || {};
    const company = String(b.company_name || '').trim().slice(0, 100);
    const email = String(b.contact_email || '').trim().slice(0, 120);
    if (!company) return res.status(400).json({ error: 'nom de l’entreprise requis' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'e-mail de contact invalide' });
    await runSql(`UPDATE users SET account_type='business', company_name=?, contact_email=? WHERE id=?`,
      company, email, req.userId);
    res.json({ ok: true, account_type: 'business', company_name: company });
  } catch (e) { res.status(500).json({ error: 'échec de la mise à niveau' }); }
});
app.delete('/api/me/business', auth, async (req, res) => {
  try {
    await runSql(`UPDATE users SET account_type='personal', company_name='', contact_email='' WHERE id=?`, req.userId);
    res.json({ ok: true, account_type: 'personal' });
  } catch (e) { res.status(500).json({ error: 'échec du retour au compte personnel' }); }
});
app.get('/api/me/business', auth, async (req, res) => {
  try {
    const u = await get1('SELECT account_type, company_name, contact_email FROM users WHERE id=?', req.userId);
    res.json({ account_type: (u && u.account_type) || 'personal', company_name: (u && u.company_name) || '',
      contact_email: (u && u.contact_email) || '' });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});

// ---------- boutique : produits (CRUD vendeur) ----------
app.post('/api/shop/products', auth, uploadImg.single('image'), async (req, res) => {
  try {
    const seller = await requireSeller(req, res); if (!seller) return;
    const b = req.body || {};
    const title = String(b.title || '').trim().slice(0, 100);
    const price = Math.floor(Number(b.price_coins));
    const stock = Math.floor(Number(b.stock));
    const category_id = b.category_id ? Number(b.category_id) : null;
    if (!title) return res.status(400).json({ error: 'titre requis' });
    if (!price || price < 1 || price > 100000000) return res.status(400).json({ error: 'prix invalide (1 pièce minimum)' });
    if (!(stock >= 0) || stock > 1000000) return res.status(400).json({ error: 'stock invalide' });
    if (category_id) {
      const c = await get1('SELECT 1 FROM categories WHERE id=?', category_id);
      if (!c) return res.status(400).json({ error: 'catégorie invalide' });
    }
    let imageUrl = '';
    if (req.file) imageUrl = await storeImage(req.file, 'vidigagne/products');
    const id = await insertId(
      'INSERT INTO products(seller_id,category_id,title,description,price_coins,stock,image_url,active,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
      req.userId, category_id, title, String(b.description || '').slice(0, 1000), price, stock, imageUrl, 1, now());
    const p = await get1('SELECT * FROM products WHERE id=?', id);
    res.json({ ok: true, product: productJSON(p) });
  } catch (e) { res.status(500).json({ error: 'échec de la création du produit' }); }
});
app.put('/api/shop/products/:id', auth, uploadImg.single('image'), async (req, res) => {
  try {
    const seller = await requireSeller(req, res); if (!seller) return;
    const p = await get1('SELECT * FROM products WHERE id=?', req.params.id);
    if (!p) return res.status(404).json({ error: 'produit introuvable' });
    if (Number(p.seller_id) !== Number(req.userId)) return res.status(403).json({ error: 'non autorisé' });
    const b = req.body || {};
    const title = b.title !== undefined ? String(b.title).trim().slice(0, 100) : p.title;
    const price = b.price_coins !== undefined ? Math.floor(Number(b.price_coins)) : Number(p.price_coins);
    const stock = b.stock !== undefined ? Math.floor(Number(b.stock)) : Number(p.stock);
    const description = b.description !== undefined ? String(b.description).slice(0, 1000) : p.description;
    if (!title) return res.status(400).json({ error: 'titre requis' });
    if (!price || price < 1 || price > 100000000) return res.status(400).json({ error: 'prix invalide (1 pièce minimum)' });
    if (!(stock >= 0) || stock > 1000000) return res.status(400).json({ error: 'stock invalide' });
    let imageUrl = p.image_url;
    if (req.file) imageUrl = await storeImage(req.file, 'vidigagne/products');
    await runSql('UPDATE products SET title=?, description=?, price_coins=?, stock=?, image_url=? WHERE id=?',
      title, description, price, stock, imageUrl, p.id);
    const upd = await get1('SELECT * FROM products WHERE id=?', p.id);
    res.json({ ok: true, product: productJSON(upd) });
  } catch (e) { res.status(500).json({ error: 'échec de la modification' }); }
});
app.delete('/api/shop/products/:id', auth, async (req, res) => {
  const seller = await requireSeller(req, res); if (!seller) return;
  const p = await get1('SELECT * FROM products WHERE id=?', req.params.id);
  if (!p) return res.status(404).json({ error: 'produit introuvable' });
  if (Number(p.seller_id) !== Number(req.userId)) return res.status(403).json({ error: 'non autorisé' });
  await runSql('UPDATE products SET active=0 WHERE id=?', p.id);
  res.json({ ok: true });
});
app.get('/api/shop/products/:id', async (req, res) => {
  const p = await get1('SELECT * FROM products WHERE id=? AND active=1', req.params.id);
  if (!p) return res.status(404).json({ error: 'produit introuvable' });
  const s = await get1('SELECT username, seller_name FROM users WHERE id=?', p.seller_id);
  res.json({ product: { ...productJSON(p), seller_username: s ? s.username : null, seller_name: s ? s.seller_name : null } });
});
async function shopSearch(req, res) {
  const q = '%' + String(req.query.q || '').toLowerCase() + '%';
  const cat = (req.query.category_id || req.query.category) ? Number(req.query.category_id || req.query.category) : null;
  let sql = 'SELECT * FROM products WHERE active=1 AND stock>0 AND (LOWER(title) LIKE ? OR LOWER(description) LIKE ?)';
  const params = [q, q];
  if (cat) { sql += ' AND category_id=?'; params.push(cat); }
  sql += ' ORDER BY created_at DESC LIMIT 50';
  const rows = await allRows(sql, ...params);
  res.json({ products: rows.map(productJSON) });
}
// alias utilisé par l'app (mêmes paramètres)
app.get('/api/shop/products', shopSearch);

// ---------- boutique : panier ----------
app.get('/api/shop/cart', auth, async (req, res) => {
  const rows = await allRows('SELECT c.qty, p.* FROM cart c JOIN products p ON p.id=c.product_id WHERE c.user_id=?', req.userId);
  res.json({ items: rows.map(r => ({ qty: Number(r.qty), product: productJSON(r) })) });
});
app.post('/api/shop/cart', auth, async (req, res) => {
  const pid = Number((req.body || {}).product_id);
  const qty = Math.floor(Number((req.body || {}).qty)) || 1;
  if (!pid || qty < 1 || qty > 99) return res.status(400).json({ error: 'quantité invalide' });
  const p = await get1('SELECT * FROM products WHERE id=? AND active=1', pid);
  if (!p) return res.status(404).json({ error: 'produit introuvable' });
  if (Number(p.seller_id) === Number(req.userId)) return res.status(400).json({ error: 'vous ne pouvez pas acheter vos propres produits' });
  if (USE_PG) {
    await runSql('INSERT INTO cart(user_id,product_id,qty) VALUES(?,?,?) ON CONFLICT(user_id,product_id) DO UPDATE SET qty=EXCLUDED.qty',
      req.userId, pid, qty);
  } else {
    await runSql('INSERT OR REPLACE INTO cart(user_id,product_id,qty) VALUES(?,?,?)', req.userId, pid, qty);
  }
  res.json({ ok: true });
});
app.delete('/api/shop/cart/:product_id', auth, async (req, res) => {
  await runSql('DELETE FROM cart WHERE user_id=? AND product_id=?', req.userId, req.params.product_id);
  res.json({ ok: true });
});

// ---------- boutique : coupons (vendeur) ----------
app.post('/api/shop/coupons', auth, async (req, res) => {
  try {
    const seller = await requireSeller(req, res); if (!seller) return;
    const b = req.body || {};
    const code = String(b.code || '').toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 20);
    const discount_pct = Math.floor(Number(b.discount_pct)) || 0;
    const discount_coins = Math.floor(Number(b.discount_coins)) || 0;
    if (!code) return res.status(400).json({ error: 'code requis' });
    if (discount_pct < 0 || discount_pct > 90) return res.status(400).json({ error: 'pourcentage invalide (0 à 90)' });
    if (discount_coins < 0) return res.status(400).json({ error: 'montant invalide' });
    if (!discount_pct && !discount_coins) return res.status(400).json({ error: 'réduction requise' });
    const ex = await get1('SELECT 1 FROM coupons WHERE code=?', code);
    if (ex) return res.status(409).json({ error: 'ce code existe déjà' });
    const expires_at = b.expires_at ? Number(b.expires_at) : null;
    const id = await insertId(
      'INSERT INTO coupons(code,discount_pct,discount_coins,seller_id,min_coins,expires_at,active,max_uses,used_count,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
      code, discount_pct, discount_coins, req.userId,
      Math.max(0, Math.floor(Number(b.min_coins)) || 0), expires_at, 1,
      Math.max(0, Math.floor(Number(b.max_uses)) || 0), 0, now());
    res.json({ ok: true, id, code });
  } catch (e) { res.status(500).json({ error: 'échec de la création du coupon' }); }
});

// ---------- boutique : commande ----------
app.post('/api/shop/orders', auth, async (req, res) => {
  try {
    const items = await allRows(
      'SELECT c.qty, c.product_id, p.* FROM cart c JOIN products p ON p.id=c.product_id WHERE c.user_id=?', req.userId);
    if (!items.length) return res.status(400).json({ error: 'panier vide' });
    // --- validation complète AVANT tout débit (pas de double-débit) ---
    let subtotal = 0;
    for (const it of items) {
      if (!it.active) return res.status(400).json({ error: 'produit indisponible : ' + it.title });
      if (Number(it.seller_id) === Number(req.userId)) return res.status(400).json({ error: 'vous ne pouvez pas acheter vos propres produits' });
      if (Number(it.stock) < Number(it.qty)) return res.status(400).json({ error: 'stock insuffisant : ' + it.title });
      subtotal += Number(it.price_coins) * Number(it.qty);
    }
    // coupon
    let discount = 0, coupon = null;
    const couponCode = String((req.body || {}).coupon_code || '').toUpperCase().trim();
    if (couponCode) {
      coupon = await get1('SELECT * FROM coupons WHERE code=?', couponCode);
      if (!coupon || !Number(coupon.active)) return res.status(400).json({ error: 'coupon invalide' });
      if (coupon.expires_at && Number(coupon.expires_at) <= now()) return res.status(400).json({ error: 'coupon expiré' });
      if (Number(coupon.max_uses) > 0 && Number(coupon.used_count) >= Number(coupon.max_uses))
        return res.status(400).json({ error: 'coupon épuisé' });
      if (subtotal < Number(coupon.min_coins)) return res.status(400).json({ error: 'montant minimum non atteint pour ce coupon' });
      if (coupon.seller_id && !items.some(it => Number(it.seller_id) === Number(coupon.seller_id)))
        return res.status(400).json({ error: "ce coupon ne s'applique pas à votre panier" });
      // FIX race 2026-10-05 (creusage profond #2) : 2 commandes parallèles avec un coupon
      // à usage unique passaient toutes les deux le check used_count<max_uses → réduction
      // appliquée 2 fois. Consommation ATOMIQUE et conditionnelle : un seul gagne.
      const okCoupon = await runSqlChanges(
        'UPDATE coupons SET used_count=used_count+1 WHERE id=? AND (max_uses<=0 OR used_count<max_uses)', coupon.id);
      if (!okCoupon) return res.status(400).json({ error: 'coupon épuisé' });
      if (Number(coupon.discount_pct) > 0) discount = Math.floor(subtotal * Number(coupon.discount_pct) / 100);
      else discount = Number(coupon.discount_coins);
      discount = Math.min(discount, subtotal);
    }
    const total = subtotal - discount;
    // affiliation (?ref=CODE)
    let affiliate = null;
    const ref = String((req.body || {}).ref || '').toUpperCase().trim();
    if (ref) affiliate = await get1('SELECT * FROM affiliates WHERE code=?', ref);
    // v2.48 (SPEC-06) : attribution vente→vidéo — la vidéo doit référencer TOUS les produits du panier
    let sourceVideo = null;
    const svid = Number((req.body || {}).source_video_id);
    if (svid) {
      const sv = await get1('SELECT id, user_id FROM videos WHERE id=? AND hidden=0', svid);
      if (sv) {
        let allLinked = true;
        for (const it of items) {
          const lk = await get1('SELECT 1 FROM video_products WHERE video_id=? AND product_id=?', svid, it.product_id);
          if (!lk) { allLinked = false; break; }
        }
        if (allLinked) sourceVideo = sv;
      }
    }
    // --- exécution : stocks d'abord (atomiques), puis débit acheteur ---
    const decremented = [];
    for (const it of items) {
      const okStock = await runSqlChanges('UPDATE products SET stock=stock-? WHERE id=? AND stock>=?', it.qty, it.product_id, it.qty);
      if (!okStock) {
        // restaure les stocks déjà décrémentés, aucun argent n'a bougé
        for (const r of decremented) await runSql('UPDATE products SET stock=stock+? WHERE id=?', r.qty, r.product_id);
        // FIX race coupon : rend l'usage du coupon si la commande échoue après consommation
        if (coupon) await runSql('UPDATE coupons SET used_count=used_count-1 WHERE id=?', coupon.id);
        return res.status(400).json({ error: 'stock épuisé : ' + it.title });
      }
      decremented.push({ product_id: it.product_id, qty: it.qty });
    }
    const debited = await runSqlChanges('UPDATE users SET coins=coins-? WHERE id=? AND coins>=?', total, req.userId, total);
    if (!debited) {
      for (const r of decremented) await runSql('UPDATE products SET stock=stock+? WHERE id=?', r.qty, r.product_id);
      // FIX race coupon : rend l'usage du coupon si le débit échoue
      if (coupon) await runSql('UPDATE coupons SET used_count=used_count-1 WHERE id=?', coupon.id);
      return res.status(400).json({ error: 'pas assez de pièces' });
    }
    await runSql('INSERT INTO ledger(user_id,amount,reason,created_at) VALUES(?,?,?,?)',
      req.userId, -total, 'commande boutique', now());
    const orderId = await insertId(
      'INSERT INTO orders(buyer_id,total_coins,status,coupon_code,affiliate_id,source_video_id,created_at) VALUES(?,?,?,?,?,?,?)',
      req.userId, total, 'completed', coupon ? coupon.code : null, affiliate ? affiliate.id : null,
      sourceVideo ? sourceVideo.id : null, now());
    let platformTotal = 0;
    for (const it of items) {
      const line = Number(it.price_coins) * Number(it.qty);
      const fee = Math.floor(line * PLATFORM_FEE_PCT / 100);
      const net = line - fee;
      platformTotal += fee;
      await runSql('INSERT INTO order_items(order_id,product_id,seller_id,qty,price_coins,fee_coins) VALUES(?,?,?,?,?,?)',
        orderId, it.product_id, it.seller_id, it.qty, it.price_coins, fee);
      await runSql('UPDATE users SET coins=coins+? WHERE id=?', net, it.seller_id);
      await runSql('INSERT INTO ledger(user_id,amount,reason,created_at) VALUES(?,?,?,?)',
        it.seller_id, net, 'vente boutique #' + orderId, now());
    }
    if (platformTotal > 0) await runSql('INSERT INTO platform_fees(order_id,coins,created_at) VALUES(?,?,?)', orderId, platformTotal, now());
    // (coupon déjà consommé atomiquement avant le débit — pas de 2e incrément ici)
    if (affiliate) {
      const comm = Math.min(Math.floor(total * Number(affiliate.rate_pct) / 100), platformTotal);
      if (comm > 0) {
        await insertId('INSERT INTO affiliate_sales(affiliate_id,order_id,commission_coins,created_at) VALUES(?,?,?,?)',
          affiliate.id, orderId, comm, now());
        // M6 : la commission est VRAIMENT versée à l'affilié
        await runSql('UPDATE users SET coins=coins+? WHERE id=?', comm, affiliate.user_id);
        await runSql('INSERT INTO ledger(user_id,amount,reason,created_at) VALUES(?,?,?,?)',
          affiliate.user_id, comm, 'commission affiliation #' + orderId, now());
      }
    }
    // v2.48 (SPEC-06) : commission créateur sur ventes via sa vidéo — NON cumulable avec l'affiliation (l'affiliation prime)
    if (!affiliate && sourceVideo) {
      const vcomm = Math.min(Math.floor(total * VIDEO_CREATOR_RATE_PCT / 100), platformTotal);
      if (vcomm > 0) {
        await insertId('INSERT INTO video_sale_commissions(order_id,video_id,creator_id,coins,refunded,created_at) VALUES(?,?,?,?,0,?)',
          orderId, sourceVideo.id, sourceVideo.user_id, vcomm, now());
        await runSql('UPDATE users SET coins=coins+? WHERE id=?', vcomm, sourceVideo.user_id);
        await runSql('INSERT INTO ledger(user_id,amount,reason,created_at) VALUES(?,?,?,?)',
          sourceVideo.user_id, vcomm, 'video_sale_commission #' + orderId, now());
      }
    }
    // v2.48 SPEC-09 : attribution de la vente à la vidéo (commission créateur)
    const _svid = Number((req.body || {}).source_video_id) || null;
    if (_svid) { try { await runSql('UPDATE orders SET source_video_id=? WHERE id=?', _svid, orderId); } catch (_) {} }
    if (_svid) await creditVideoSaleCommission(orderId, _svid, req.userId, total, !!affiliate);
    await runSql('DELETE FROM cart WHERE user_id=?', req.userId);
    res.json({ ok: true, order_id: orderId, total_coins: total, discount_coins: discount });
  } catch (e) { res.status(500).json({ error: 'échec de la commande' }); }
});
app.get('/api/shop/orders', auth, async (req, res) => {
  const orders = await allRows('SELECT * FROM orders WHERE buyer_id=? ORDER BY created_at DESC LIMIT 50', req.userId);
  for (const o of orders) {
    o.items = await allRows('SELECT oi.*, p.title FROM order_items oi LEFT JOIN products p ON p.id=oi.product_id WHERE oi.order_id=?', o.id);
    o.total_coins = Number(o.total_coins);
  }
  res.json({ orders });
});
app.get('/api/shop/sales', auth, async (req, res) => {
  const seller = await requireSeller(req, res); if (!seller) return;
  const items = await allRows(
    `SELECT oi.*, p.title, o.created_at, u.username AS buyer FROM order_items oi
     JOIN orders o ON o.id=oi.order_id
     LEFT JOIN products p ON p.id=oi.product_id
     LEFT JOIN users u ON u.id=o.buyer_id
     WHERE oi.seller_id=? ORDER BY o.created_at DESC LIMIT 100`, req.userId);
  res.json({ sales: items });
});

// ---------- boutique : avis produits ----------
// Table créée par migration (voir initDb) : shop_reviews(id, product_id, user_id, rating, comment, created_at)
app.get('/api/shop/products/:id/reviews', async (req, res) => {
  try {
    const rows = await allRows(
      `SELECT r.*, u.username FROM shop_reviews r LEFT JOIN users u ON u.id=r.user_id WHERE r.product_id=? ORDER BY r.created_at DESC LIMIT 50`,
      Number(req.params.id));
    const avg = await get1('SELECT COALESCE(AVG(rating),0) AS a, COUNT(*) AS c FROM shop_reviews WHERE product_id=?', Number(req.params.id));
    res.json({ reviews: rows, average: Math.round(Number(avg.a) * 10) / 10, count: Number(avg.c) });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.post('/api/shop/products/:id/reviews', auth, async (req, res) => {
  try {
    const pid = Number(req.params.id);
    const rating = Math.max(1, Math.min(5, Math.floor(Number((req.body || {}).rating))));
    const comment = String((req.body || {}).comment || '').slice(0, 500);
    if (!rating) return res.status(400).json({ error: 'note requise (1 à 5)' });
    const prod = await get1('SELECT id FROM products WHERE id=?', pid);
    if (!prod) return res.status(404).json({ error: 'produit introuvable' });
    // l'acheteur doit avoir acheté le produit
    const bought = await get1(
      `SELECT 1 FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE oi.product_id=? AND o.buyer_id=? LIMIT 1`,
      pid, req.userId);
    if (!bought) return res.status(403).json({ error: 'achetez le produit pour le noter' });
    const ex = await get1('SELECT id FROM shop_reviews WHERE product_id=? AND user_id=?', pid, req.userId);
    if (ex) {
      await runSql('UPDATE shop_reviews SET rating=?, comment=?, created_at=? WHERE id=?', rating, comment, now(), ex.id);
      res.json({ ok: true, updated: true, id: ex.id });
    } else {
      const id = await insertId('INSERT INTO shop_reviews(product_id,user_id,rating,comment,created_at) VALUES(?,?,?,?,?)',
        pid, req.userId, rating, comment, now());
      res.json({ ok: true, id });
    }
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});

// ---------- boutique : remboursements ----------
// Table : shop_refunds(id, order_id, buyer_id, seller_id, reason, status, created_at, decided_at)
app.post('/api/shop/orders/:id/refund', auth, async (req, res) => {
  try {
    const order = await get1('SELECT * FROM orders WHERE id=? AND buyer_id=?', Number(req.params.id), req.userId);
    if (!order) return res.status(404).json({ error: 'commande introuvable' });
    if (order.status === 'refunded') return res.status(400).json({ error: 'déjà remboursée' });
    const ex = await get1("SELECT id FROM shop_refunds WHERE order_id=? AND status='pending'", order.id);
    if (ex) return res.status(409).json({ error: 'demande déjà en cours' });
    const item = await get1('SELECT seller_id FROM order_items WHERE order_id=? LIMIT 1', order.id);
    const id = await insertId(
      'INSERT INTO shop_refunds(order_id,buyer_id,seller_id,reason,status,created_at) VALUES(?,?,?,?,?,?)',
      order.id, req.userId, item ? item.seller_id : null,
      String((req.body || {}).reason || '').slice(0, 500), 'pending', now());
    res.json({ ok: true, id });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.get('/api/shop/refunds', auth, async (req, res) => {
  try {
    const rows = await allRows(
      `SELECT r.*, o.total_coins FROM shop_refunds r JOIN orders o ON o.id=r.order_id WHERE r.buyer_id=? ORDER BY r.created_at DESC LIMIT 50`,
      req.userId);
    res.json({ refunds: rows });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.post('/api/shop/refunds/:id/decide', authOrAdmin, async (req, res) => {
  try {
    const approve = !!((req.body || {}).approve);
    const rf = await get1('SELECT * FROM shop_refunds WHERE id=?', Number(req.params.id));
    if (!rf) return res.status(404).json({ error: 'demande introuvable' });
    if (rf.status !== 'pending') return res.status(400).json({ error: 'déjà traitée' });
    // FIX non-régression 2026-10-05 : le contrôle d'autorisation DOIT passer AVANT le claim
    // atomique — sinon une tentative non autorisée (403) laissait la demande bloquée en
    // 'processing' pour toujours, et le vendeur légitime recevait ensuite 400 « déjà traitée ».
    // seul le vendeur concerné ou un admin peut décider (B3 : x-admin-token accepté)
    const isAdmin = req.admin === true;
    if (Number(rf.seller_id) !== Number(req.userId) && !isAdmin)
      return res.status(403).json({ error: 'non autorisé' });
    // FIX sécu 2026-10-05 (failles vague 2 F2) : 2 décisions parallèles passaient le check
    // 'pending' → acheteur crédité 2 fois (TOCTOU). Claim atomique : un seul gagne.
    const claimed = await runSqlChanges("UPDATE shop_refunds SET status='processing' WHERE id=? AND status='pending'", rf.id);
    if (!claimed) return res.status(400).json({ error: 'déjà traitée' });
    if (approve) {
      const order = await get1('SELECT * FROM orders WHERE id=?', rf.order_id);
      const total = Number(order.total_coins);
      await runSql('UPDATE users SET coins=coins+? WHERE id=?', total, rf.buyer_id);
      await runSql('INSERT INTO ledger(user_id,amount,reason,created_at) VALUES(?,?,?,?)',
        rf.buyer_id, total, 'remboursement commande #' + rf.order_id, now());
      await runSql("UPDATE orders SET status='refunded' WHERE id=?", rf.order_id);
      // débite le vendeur du net perçu (ne peut pas passer sous zéro)
      const items = await allRows('SELECT * FROM order_items WHERE order_id=?', rf.order_id);
      for (const it of items) {
        const net = Number(it.price_coins) * Number(it.qty) - Number(it.fee_coins);
        await runSql('UPDATE users SET coins=CASE WHEN coins>=? THEN coins-? ELSE 0 END WHERE id=?', net, net, it.seller_id);
        await runSql('INSERT INTO ledger(user_id,amount,reason,created_at) VALUES(?,?,?,?)',
          it.seller_id, -net, 'remboursement vente #' + rf.order_id, now());
      }
      // v2.48 (SPEC-06) : remboursement → la commission vidéo du créateur est débitée
      const vsc = await get1('SELECT * FROM video_sale_commissions WHERE order_id=? AND refunded=0', rf.order_id);
      if (vsc) {
        const vc = Number(vsc.coins) || 0;
        await runSql('UPDATE users SET coins=CASE WHEN coins>=? THEN coins-? ELSE 0 END WHERE id=?', vc, vc, vsc.creator_id);
        await runSql('INSERT INTO ledger(user_id,amount,reason,created_at) VALUES(?,?,?,?)',
          vsc.creator_id, -vc, 'video_sale_commission_refund #' + rf.order_id, now());
        await runSql('UPDATE video_sale_commissions SET refunded=1 WHERE id=?', vsc.id);
      }
    }
    // v2.48 SPEC-09 : débit de la commission vidéo au remboursement (plafonné au solde)
    if (approve) {
      try {
        const vsc = await get1('SELECT * FROM video_sale_commissions WHERE order_id=? AND refunded=0', rf.order_id);
        if (vsc) {
          const ub = await get1('SELECT coins FROM users WHERE id=?', vsc.creator_id);
          const debit = Math.min(Number(vsc.coins) || 0, Number(ub ? ub.coins : 0));
          if (debit > 0) {
            await runSql('UPDATE users SET coins=coins-? WHERE id=?', debit, vsc.creator_id);
            await runSql('INSERT INTO ledger(user_id,amount,reason,created_at) VALUES(?,?,?,?)',
              vsc.creator_id, -debit, 'video_sale_commission_refund #' + rf.order_id, now());
          }
          await runSql('UPDATE video_sale_commissions SET refunded=1 WHERE order_id=?', rf.order_id);
        }
      } catch (_) {}
    }
    await runSql("UPDATE shop_refunds SET status=?, decided_at=? WHERE id=?",
      approve ? 'approved' : 'rejected', now(), rf.id);
    await logAudit(null, approve ? 'refund_approve' : 'refund_reject', 'refund', rf.id, req); // v2.43
    res.json({ ok: true, status: approve ? 'approved' : 'rejected' });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});

// ---------- v2.48 SPEC-06 : ventes d'une vidéo (réservé au créateur) ----------
app.get('/api/videos/:id/sales', auth, async (req, res) => {
  try {
    const vid = Number(req.params.id);
    const v = await get1('SELECT * FROM videos WHERE id=?', vid);
    if (!v) return res.status(404).json({ error: 'vidéo introuvable' });
    if (Number(v.user_id) !== Number(req.userId))
      return res.status(403).json({ error: 'réservé au créateur' });
    const rows = await allRows(
      `SELECT c.*, o.total_coins, o.created_at AS order_at, u.username AS buyer
       FROM video_sale_commissions c JOIN orders o ON o.id=c.order_id
       LEFT JOIN users u ON u.id=o.buyer_id
       WHERE c.video_id=? ORDER BY c.created_at DESC LIMIT 100`, vid);
    const total = await get1('SELECT COALESCE(SUM(coins),0) AS s FROM video_sale_commissions WHERE video_id=? AND refunded=0', vid);
    res.json({ ok: true, video_id: vid, sales: rows, total_earned: Number((total && total.s) || 0),
      rate_pct: VIDEO_CREATOR_RATE_PCT, label: 'Ventes via mes vidéos' });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// ---------- boutique : produits attachés aux vidéos ----------
app.post('/api/videos/:id/products', auth, async (req, res) => {
  const v = await get1('SELECT * FROM videos WHERE id=?', req.params.id);
  if (!v) return res.status(404).json({ error: 'vidéo introuvable' });
  const p = await get1('SELECT * FROM products WHERE id=? AND active=1', Number((req.body || {}).product_id));
  if (!p) return res.status(404).json({ error: 'produit introuvable' });
  const isOwner = Number(v.user_id) === Number(req.userId);
  const isSeller = Number(p.seller_id) === Number(req.userId);
  if (!isOwner && !isSeller) return res.status(403).json({ error: 'non autorisé' });
  await insertIgnore('INSERT OR IGNORE INTO video_products(video_id,product_id) VALUES(?,?)', v.id, p.id);
  res.json({ ok: true });
});
app.get('/api/videos/:id/products', async (req, res) => {
  const rows = await allRows(
    'SELECT p.* FROM video_products vp JOIN products p ON p.id=vp.product_id WHERE vp.video_id=? AND p.active=1',
    req.params.id);
  res.json({ products: rows.map(productJSON) });
});

// ---------- boutique : affiliation ----------
function affiliateCode() { return 'VG-' + crypto.randomBytes(4).toString('hex').toUpperCase(); }
app.post('/api/shop/affiliate', auth, async (req, res) => {
  const ex = await get1('SELECT * FROM affiliates WHERE user_id=?', req.userId);
  if (ex) return res.json({ ok: true, code: ex.code, rate_pct: Number(ex.rate_pct) });
  let code = affiliateCode();
  for (let i = 0; i < 5; i++) {
    const c = await get1('SELECT 1 FROM affiliates WHERE code=?', code);
    if (!c) break;
    code = affiliateCode();
  }
  await insertId('INSERT INTO affiliates(user_id,code,rate_pct,created_at) VALUES(?,?,?,?)',
    req.userId, code, AFFILIATE_RATE_PCT, now());
  res.json({ ok: true, code, rate_pct: AFFILIATE_RATE_PCT });
});
app.get('/api/shop/affiliate/stats', auth, async (req, res) => {
  const a = await get1('SELECT * FROM affiliates WHERE user_id=?', req.userId);
  if (!a) return res.json({ affiliate: null });
  const s = await get1('SELECT COUNT(*) AS n, COALESCE(SUM(commission_coins),0) AS t FROM affiliate_sales WHERE affiliate_id=?', a.id);
  res.json({ affiliate: { code: a.code, rate_pct: Number(a.rate_pct), sales: Number(s.n), total_commission: Number(s.t) } });
});

// ---------- boutique : financier vendeur ----------
app.get('/api/shop/payouts', auth, async (req, res) => {
  const seller = await requireSeller(req, res); if (!seller) return;
  const e = await get1('SELECT COALESCE(SUM(price_coins*qty - fee_coins),0) AS s FROM order_items WHERE seller_id=?', req.userId);
  const p = await get1('SELECT COALESCE(SUM(coins),0) AS s FROM seller_payouts WHERE seller_id=?', req.userId);
  const earned = Number(e.s), paid = Number(p.s);
  res.json({ earned_coins: earned, paid_out_coins: paid, pending_coins: earned - paid });
});
app.post('/api/shop/payout', auth, async (req, res) => {
  const seller = await requireSeller(req, res); if (!seller) return;
  const e = await get1('SELECT COALESCE(SUM(price_coins*qty - fee_coins),0) AS s FROM order_items WHERE seller_id=?', req.userId);
  const p = await get1('SELECT COALESCE(SUM(coins),0) AS s FROM seller_payouts WHERE seller_id=?', req.userId);
  const pending = Number(e.s) - Number(p.s);
  if (!pending || pending <= 0) return res.status(400).json({ error: 'aucun gain en attente' });
  let amount = (req.body && req.body.coins != null) ? Math.floor(Number(req.body.coins)) : pending;
  if (!amount || amount < 1) return res.status(400).json({ error: 'montant invalide' });
  if (amount > pending) return res.status(400).json({ error: 'montant supérieur aux gains en attente' });
  // FIX 2026-10-05 (audit économique) : les gains vendeur sont DÉJÀ crédités sur le
  // solde à la commande ('vente boutique #'). Re-créditer ici DOUBLAIT les gains
  // (création monétaire à partir de rien — prouvé : +270 pièces fantômes).
  // Le versement n'est donc qu'un enregistrement de suivi, sans mouvement de pièces.
  await insertId('INSERT INTO seller_payouts(seller_id,coins,status,created_at) VALUES(?,?,?,?)',
    req.userId, amount, 'done', now());
  res.json({ ok: true, coins: amount });
});

// ---------- financier : historique ----------
app.get('/api/finance/ledger', auth, async (req, res) => {
  const rows = await allRows('SELECT * FROM ledger WHERE user_id=? ORDER BY created_at DESC LIMIT 100', req.userId);
  res.json({ ledger: rows });
});

// ==================== V3 : LIVE SHOPPING ====================
app.post('/api/live/:id/products', auth, async (req, res) => {
  const l = await liveById(req.params.id);
  if (!l) return res.status(404).json({ error: 'live introuvable' });
  if (l.ended_at) return res.status(403).json({ error: 'live terminé' });
  if (Number(l.user_id) !== Number(req.userId)) return res.status(403).json({ error: 'réservé au diffuseur' });
  const p = await get1('SELECT * FROM products WHERE id=? AND seller_id=? AND active=1',
    Number((req.body || {}).product_id), req.userId);
  if (!p) return res.status(404).json({ error: 'produit introuvable' });
  await insertIgnore('INSERT OR IGNORE INTO live_products(live_id,product_id,pinned_at) VALUES(?,?,?)', l.id, p.id, now());
  res.json({ ok: true });
});
app.get('/api/live/:id/products', async (req, res) => {
  const l = await liveById(req.params.id);
  if (!l) return res.status(404).json({ error: 'live introuvable' });
  const rows = await allRows(
    'SELECT p.* FROM live_products lp JOIN products p ON p.id=lp.product_id WHERE lp.live_id=? AND p.active=1 ORDER BY lp.pinned_at ASC',
    l.id);
  res.json({ products: rows.map(productJSON) });
});

// ==================== V3 : PUBLICITÉ ====================
app.post('/api/ads/campaigns', auth, async (req, res) => {
  try {
    const b = req.body || {};
    const title = String(b.title || '').trim().slice(0, 80);
    const budget = Math.floor(Number(b.budget_coins));
    // v2.42 : target accepte un objet {countries:[...], age_min, age_max} (JSON stringifié) ou une chaîne legacy
    let target = '';
    if (b.target && typeof b.target === 'object') {
      const t = {};
      if (Array.isArray(b.target.countries)) t.countries = b.target.countries.map(c => String(c).toUpperCase().slice(0, 4)).slice(0, 50);
      if (Number.isFinite(Number(b.target.age_min))) t.age_min = Math.max(0, Math.floor(Number(b.target.age_min)));
      if (Number.isFinite(Number(b.target.age_max))) t.age_max = Math.max(0, Math.floor(Number(b.target.age_max)));
      target = JSON.stringify(t).slice(0, 500);
    } else {
      target = String(b.target || '').slice(0, 80);
    }
    const product_id = b.product_id ? Number(b.product_id) : null;
    if (!title) return res.status(400).json({ error: 'titre requis' });
    if (!budget || budget < 10) return res.status(400).json({ error: 'budget minimum : 10 pièces' });
    if (product_id) {
      const p = await get1('SELECT * FROM products WHERE id=? AND seller_id=? AND active=1', product_id, req.userId);
      if (!p) return res.status(400).json({ error: 'produit invalide' });
    }
    const me = await get1('SELECT coins FROM users WHERE id=?', req.userId);
    if (!me || Number(me.coins) < budget) return res.status(400).json({ error: 'pas assez de pièces' });
    await runSql('UPDATE users SET coins=coins-? WHERE id=?', budget, req.userId);
    await runSql('INSERT INTO ledger(user_id,amount,reason,created_at) VALUES(?,?,?,?)',
      req.userId, -budget, 'campagne publicitaire', now());
    const id = await insertId(
      `INSERT INTO ad_campaigns(user_id,title,budget_coins,spent_coins,product_id,status,target,created_at)
       VALUES(?,?,?,?,?,'active',?,?)`,
      req.userId, title, budget, 0, product_id, target, now());
    res.json({ ok: true, id });
  } catch (e) { res.status(500).json({ error: 'échec de la création de la campagne' }); }
});
app.get('/api/ads/campaigns', auth, async (req, res) => {
  const rows = await allRows('SELECT * FROM ad_campaigns WHERE user_id=? ORDER BY created_at DESC', req.userId);
  const out = [];
  for (const c of rows) {
    const im = await get1(`SELECT COUNT(*) AS n FROM ad_events WHERE campaign_id=? AND type='impression'`, c.id);
    const cl = await get1(`SELECT COUNT(*) AS n FROM ad_events WHERE campaign_id=? AND type='click'`, c.id);
    out.push({ id: c.id, title: c.title, budget_coins: Number(c.budget_coins), spent_coins: Number(c.spent_coins),
      product_id: c.product_id || null, status: c.status, target: c.target || '',
      impressions: Number(im.n), clicks: Number(cl.n), created_at: Number(c.created_at) });
  }
  res.json({ campaigns: out });
});
app.post('/api/ads/:id/event', async (req, res) => {
  const type = String((req.body || {}).type || '');
  if (!['impression', 'click'].includes(type)) return res.status(400).json({ error: 'type invalide' });
  const c = await get1('SELECT * FROM ad_campaigns WHERE id=?', req.params.id);
  if (!c || c.status !== 'active') return res.status(404).json({ error: 'campagne introuvable ou inactive' });
  const cost = type === 'click' ? AD_COST_CLICK : AD_COST_IMPRESSION;
  if (Number(c.spent_coins) + cost > Number(c.budget_coins)) {
    await runSql(`UPDATE ad_campaigns SET status='paused' WHERE id=?`, c.id);
    return res.status(400).json({ error: 'budget épuisé' });
  }
  await runSql('INSERT INTO ad_events(campaign_id,type,created_at) VALUES(?,?,?)', c.id, type, now());
  await runSql('UPDATE ad_campaigns SET spent_coins=spent_coins+? WHERE id=?', cost, c.id);
  res.json({ ok: true });
});
app.get('/api/ads/feed', async (req, res) => {
  const rows = await allRows(
    `SELECT * FROM ad_campaigns WHERE status='active' AND spent_coins < budget_coins ORDER BY created_at DESC LIMIT 20`);
  if (!rows.length) return res.json({ ads: [] });
  // v2.42 : ciblage pays — une campagne ciblant des pays n'est servie qu'aux viewers de ces pays
  let viewerCountry = '';
  try {
    const meId = await optUserId(req);
    if (meId) {
      const mu = await get1('SELECT country FROM users WHERE id=?', meId);
      viewerCountry = String((mu && mu.country) || '').toUpperCase();
    }
  } catch (_) {}
  const eligible = rows.filter(c => {
    const t = String(c.target || '');
    if (!t) return true;
    let tj = null;
    try { tj = JSON.parse(t); } catch (_) { return true; } // cible legacy (chaîne libre) → servie à tous
    if (!tj || !Array.isArray(tj.countries) || !tj.countries.length) return true;
    const list = tj.countries.map(x => String(x).toUpperCase());
    return !!viewerCountry && list.includes(viewerCountry);
  });
  if (!eligible.length) return res.json({ ads: [] });
  const c = eligible[Math.floor(Math.random() * eligible.length)];
  let product = null;
  if (c.product_id) {
    const p = await get1('SELECT * FROM products WHERE id=? AND active=1', c.product_id);
    if (p) product = productJSON(p);
  }
  res.json({ ads: [{ id: c.id, title: c.title, target: c.target || '', product }] });
});

// ==================== v2.39 : MODÉRATION AUTO (file mod_queue) ====================
// Liste des mots interdits : BANNED_WORDS (insultes graves, discriminations, menaces, spam)
// définie plus haut (modération auto V3) et réutilisée ici via scanBanned().
app.get('/api/admin/mod-queue', adminAuth, async (req, res) => {
  try {
    const status = String(req.query.status || 'pending');
    if (!['pending', 'resolved'].includes(status))
      return res.status(400).json({ error: 'statut invalide' });
    const rows = await allRows('SELECT * FROM mod_queue WHERE status=? ORDER BY created_at ASC LIMIT 100', status);
    const out = [];
    for (const r of rows) {
      let item = null;
      if (r.target_type === 'video') {
        const v = await get1('SELECT v.*, u.username FROM videos v LEFT JOIN users u ON u.id=v.user_id WHERE v.id=?', r.target_id);
        if (v) item = { id: v.id, desc: v.description, user_id: v.user_id, username: v.username, hidden: v.hidden };
      } else if (r.target_type === 'comment') {
        const c = await get1('SELECT c.*, u.username FROM comments c LEFT JOIN users u ON u.id=c.user_id WHERE c.id=?', r.target_id);
        if (c) item = c;
      }
      out.push({ id: r.id, target_type: r.target_type, target_id: r.target_id, reason: r.reason,
        status: r.status, created_at: Number(r.created_at), item });
    }
    res.json({ queue: out });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.post('/api/admin/mod-queue/:id/review', adminAuth, async (req, res) => {
  try {
    const q = await get1('SELECT * FROM mod_queue WHERE id=?', req.params.id);
    if (!q) return res.status(404).json({ error: 'élément introuvable' });
    if (q.status !== 'pending') return res.status(409).json({ error: 'déjà traité' });
    const action = String((req.body || {}).action || '');
    if (!['approve', 'remove'].includes(action))
      return res.status(400).json({ error: 'action invalide' });
    if (action === 'approve') {
      if (q.target_type === 'video')
        await runSql("UPDATE videos SET hidden=0, review_status='ok' WHERE id=?", q.target_id);
      else if (q.target_type === 'comment')
        await runSql("UPDATE comments SET review_status='ok' WHERE id=?", q.target_id);
    } else {
      // remove : suppression définitive + notif à l'auteur
      let authorId = null, label = '';
      if (q.target_type === 'video') {
        const v = await get1('SELECT user_id, description FROM videos WHERE id=?', q.target_id);
        if (v) { authorId = v.user_id; label = 'ta vidéo'; }
        await runSql('DELETE FROM videos WHERE id=?', q.target_id);
        await logAudit(null, 'video_delete', 'video', q.target_id, req); // v2.43 : suppression admin
      } else if (q.target_type === 'comment') {
        const c = await get1('SELECT user_id, text FROM comments WHERE id=?', q.target_id);
        if (c) { authorId = c.user_id; label = 'ton commentaire'; }
        await runSql('DELETE FROM comments WHERE id=?', q.target_id);
        await logAudit(null, 'comment_delete', 'comment', q.target_id, req); // v2.43 : suppression admin
      }
      if (authorId) {
        try {
          await notify(authorId, 'system', null, null,
            '🛡️ ' + (label ? label[0].toUpperCase() + label.slice(1) : 'Ton contenu')
            + ' a été supprimé par la modération : ' + String(q.reason || '').slice(0, 100) + '.');
          const ue = await get1('SELECT email FROM users WHERE id=?', authorId);
          if (ue && ue.email) sendVidiEmail(ue.email, '🛡️ Contenu supprimé — VidiGagne',
            '<p style="font-size:18px">🛡️ Contenu supprimé</p>'
            + '<p style="color:#ccc;font-size:14px">Ton contenu a été supprimé par notre équipe de modération (' + String(q.reason || '').replace(/</g, '&lt;') + ').</p>'
            + '<p style="color:#999;font-size:12px">Merci de respecter les règles de la communauté. ✨</p>',
            'Ton contenu VidiGagne a été supprimé par la modération.').catch(() => {});
        } catch (_) {}
      }
    }
    await runSql("UPDATE mod_queue SET status='resolved' WHERE id=?", q.id);
    res.json({ ok: true, action });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});

// ==================== V3 : MODÉRATION AUTO (file de revue admin) ====================
app.get('/api/admin/review-queue', adminAuth, async (req, res) => {
  const rows = await allRows(`SELECT * FROM review_queue WHERE status='pending' ORDER BY created_at ASC LIMIT 100`);
  const out = [];
  for (const r of rows) {
    let item = null;
    if (r.item_type === 'video') {
      const v = await get1('SELECT * FROM videos WHERE id=?', r.item_id);
      if (v) item = { id: v.id, desc: v.description, user_id: v.user_id, url: fileUrl(v.file) };
    } else if (r.item_type === 'comment') {
      const c = await get1('SELECT c.*, u.username FROM comments c LEFT JOIN users u ON u.id=c.user_id WHERE c.id=?', r.item_id);
      if (c) item = c;
    }
    out.push({ id: r.id, item_type: r.item_type, item_id: r.item_id, reason: r.reason,
      created_at: Number(r.created_at), item });
  }
  res.json({ queue: out });
});
app.post('/api/admin/review/:type/:id', adminAuth, async (req, res) => {
  const type = req.params.type;
  const decision = String((req.body || {}).decision || '');
  if (!['video', 'comment'].includes(type)) return res.status(400).json({ error: 'type invalide' });
  if (!['approve', 'reject'].includes(decision)) return res.status(400).json({ error: 'décision invalide' });
  const q = await get1(`SELECT * FROM review_queue WHERE item_type=? AND item_id=? AND status='pending' ORDER BY created_at DESC`,
    type, req.params.id);
  if (!q) return res.status(404).json({ error: 'élément introuvable dans la file' });
  if (type === 'video') {
    if (decision === 'approve') await runSql(`UPDATE videos SET hidden=0, review_status='ok' WHERE id=?`, req.params.id);
    else await runSql(`UPDATE videos SET review_status='rejected' WHERE id=?`, req.params.id);
  } else {
    await runSql(`UPDATE comments SET review_status=? WHERE id=?`, decision === 'approve' ? 'ok' : 'rejected', req.params.id);
  }
  await runSql(`UPDATE review_queue SET status=? WHERE id=?`, decision === 'approve' ? 'approved' : 'rejected', q.id);
  res.json({ ok: true, decision });
});

// ==================== SERVEUR v12 ====================
// ---------- utilitaire : id d'un utilisateur par pseudo (pour les groupes) ----------
app.get('/api/users/:username/id', auth, async (req, res) => {
  try {
    const u = await get1('SELECT id FROM users WHERE username=?', String(req.params.username || '').toLowerCase().trim());
    if (!u) return res.status(404).json({ error: 'utilisateur introuvable' });
    res.json({ id: u.id });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});

// ---------- groupes de discussion ----------
async function isGroupMember(groupId, userId) {
  const r = await get1('SELECT 1 FROM group_members WHERE group_id=? AND user_id=?', groupId, userId);
  return !!r;
}
app.post('/api/groups', auth, async (req, res) => {
  try {
    const b = req.body || {};
    const name = String(b.name || '').trim().slice(0, 60) || 'Groupe';
    const avatar = String(b.avatar || '').slice(0, 500);
    let memberIds = b.member_ids;
    if (!Array.isArray(memberIds)) memberIds = [];
    // déduplique, exclut le créateur, ne garde que des ids valides
    const uniq = [...new Set(memberIds.map(x => Number(x)).filter(x => x && x !== Number(req.userId)))];
    const gid = await insertId('INSERT INTO chat_groups(name,avatar,creator_id,created_at) VALUES(?,?,?,?)',
      name, avatar, req.userId, now());
    await insertIgnore('INSERT OR IGNORE INTO group_members(group_id,user_id,joined_at) VALUES(?,?,?)',
      gid, req.userId, now());
    for (const uid of uniq) {
      const u = await get1('SELECT id FROM users WHERE id=?', uid);
      if (u) await insertIgnore('INSERT OR IGNORE INTO group_members(group_id,user_id,joined_at) VALUES(?,?,?)',
        gid, uid, now());
    }
    res.json({ group: { id: gid, name, avatar } });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.get('/api/groups', auth, async (req, res) => {
  try {
    const rows = await allRows(
      `SELECT g.* FROM chat_groups g JOIN group_members gm ON gm.group_id=g.id
       WHERE gm.user_id=? ORDER BY g.created_at DESC`, req.userId);
    const out = [];
    for (const g of rows) {
      const members = await allRows(
        `SELECT u.id,u.username,u.avatar FROM group_members gm
         JOIN users u ON u.id=gm.user_id WHERE gm.group_id=? ORDER BY gm.joined_at ASC`, g.id);
      const last = await get1('SELECT * FROM group_messages WHERE group_id=? ORDER BY id DESC LIMIT 1', g.id);
      const unread = Number((await get1(
        'SELECT COUNT(*) AS c FROM group_messages WHERE group_id=? AND sender_id!=?', g.id, req.userId)).c);
      out.push({
        id: g.id, name: g.name, avatar: g.avatar || '',
        members: members.map(m => ({ id: m.id, username: m.username, avatar: m.avatar })),
        last_message: last ? { id: last.id, sender_id: last.sender_id, text: last.text, created_at: Number(last.created_at) } : null,
        unread,
      });
    }
    res.json({ groups: out });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.get('/api/groups/:id/messages', auth, async (req, res) => {
  try {
    if (!await isGroupMember(req.params.id, req.userId))
      return res.status(403).json({ error: 'non membre du groupe' });
    const before = Number(req.query.before) || 0;
    const rows = before > 0
      ? await allRows('SELECT * FROM group_messages WHERE group_id=? AND id<? ORDER BY id DESC LIMIT 50', req.params.id, before)
      : await allRows('SELECT * FROM group_messages WHERE group_id=? ORDER BY id DESC LIMIT 50', req.params.id);
    rows.reverse();
    res.json({ messages: rows.map(m => ({ id: m.id, sender_id: m.sender_id, text: m.text, audio_url: m.audio_url || '', created_at: Number(m.created_at) })) });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.post('/api/groups/:id/messages', auth, async (req, res) => {
  try {
    const gid = req.params.id;
    if (!await isGroupMember(gid, req.userId))
      return res.status(403).json({ error: 'non membre du groupe' });
    const text = String((req.body || {}).text || '').trim().slice(0, 2000);
    const audioUrl = String((req.body || {}).audio_url || '').slice(0, 500); // v1.57 : message vocal
    if (!text && !audioUrl) return res.status(400).json({ error: 'message vide' });
    const id = await insertId('INSERT INTO group_messages(group_id,sender_id,text,audio_url,created_at) VALUES(?,?,?,?,?)',
      gid, req.userId, text, audioUrl, now());
    const g = await get1('SELECT name FROM chat_groups WHERE id=?', gid);
    const others = await allRows('SELECT user_id FROM group_members WHERE group_id=? AND user_id!=?', gid, req.userId);
    for (const o of others) await notify(o.user_id, 'group_message', req.userId, null, (g ? g.name + ' : ' : '') + (text || '🎤 message vocal').slice(0, 100));
    res.json({ message: { id, sender_id: req.userId, text, audio_url: audioUrl, created_at: now() } });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.post('/api/groups/:id/members', auth, async (req, res) => {
  try {
    const gid = req.params.id;
    if (!await isGroupMember(gid, req.userId))
      return res.status(403).json({ error: 'non membre du groupe' });
    const uid = Number((req.body || {}).user_id);
    if (!uid) return res.status(400).json({ error: 'user_id requis' });
    const u = await get1('SELECT id,username FROM users WHERE id=?', uid);
    if (!u) return res.status(404).json({ error: 'utilisateur introuvable' });
    await insertIgnore('INSERT OR IGNORE INTO group_members(group_id,user_id,joined_at) VALUES(?,?,?)',
      gid, uid, now());
    res.json({ ok: true, user: { id: u.id, username: u.username } });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.delete('/api/groups/:id/leave', auth, async (req, res) => {
  try {
    const gid = req.params.id;
    // B7 (2026-10-05) : vérifier l'existence du groupe AVANT le contrôle d'appartenance
    const g = await get1('SELECT id FROM chat_groups WHERE id=?', gid);
    if (!g) return res.status(404).json({ error: 'groupe introuvable' });
    if (!await isGroupMember(gid, req.userId))
      return res.status(403).json({ error: 'non membre du groupe' });
    await runSql('DELETE FROM group_members WHERE group_id=? AND user_id=?', gid, req.userId);
    const rest = Number((await get1('SELECT COUNT(*) AS c FROM group_members WHERE group_id=?', gid)).c);
    if (!rest) {
      // groupe vide : on le supprime avec ses messages
      await runSql('DELETE FROM group_messages WHERE group_id=?', gid);
      await runSql('DELETE FROM chat_groups WHERE id=?', gid);
      return res.json({ ok: true, deleted: true });
    }
    res.json({ ok: true, deleted: false });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});

// ---------- filtres de commentaires (paramètres) ----------
app.get('/api/settings/comment-filters', auth, async (req, res) => {
  try {
    const u = await get1('SELECT comment_keywords FROM users WHERE id=?', req.userId);
    res.json({ keywords: parseKeywords(u && u.comment_keywords) });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.put('/api/settings/comment-filters', auth, async (req, res) => {
  try {
    let kw = (req.body || {}).keywords;
    if (!Array.isArray(kw)) return res.status(400).json({ error: 'keywords doit être un tableau' });
    kw = kw.map(x => String(x).trim().toLowerCase()).filter(x => x.length > 0 && x.length <= 30).slice(0, 50);
    await runSql('UPDATE users SET comment_keywords=? WHERE id=?', JSON.stringify(kw), req.userId);
    res.json({ keywords: kw });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});

// ---------- séries payantes ----------
app.post('/api/series', auth, async (req, res) => {
  try {
    const b = req.body || {};
    const title = String(b.title || '').trim().slice(0, 80);
    if (!title) return res.status(400).json({ error: 'titre requis' });
    const price = Math.floor(Number(b.price_coins));
    if (!price || price < 10 || price > 100000)
      return res.status(400).json({ error: 'prix invalide (10 à 100000 pièces)' });
    const id = await insertId(
      'INSERT INTO series(creator_id,title,description,cover,price_coins,created_at) VALUES(?,?,?,?,?,?)',
      req.userId, title, String(b.description || '').slice(0, 500),
      String(b.cover || '').slice(0, 500), price, now());
    res.json({ series: { id, title, price_coins: price } });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.get('/api/series/mine', auth, async (req, res) => {
  try {
    const rows = await allRows('SELECT * FROM series WHERE creator_id=? ORDER BY created_at DESC', req.userId);
    res.json({ series: rows.map(s => ({ id: s.id, title: s.title, description: s.description, cover: s.cover,
      price_coins: Number(s.price_coins), created_at: Number(s.created_at) })) });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.get('/api/series/purchased', auth, async (req, res) => {
  try {
    const rows = await allRows(
      `SELECT s.* FROM series s JOIN series_purchases p ON p.series_id=s.id
       WHERE p.user_id=? ORDER BY p.created_at DESC`, req.userId);
    res.json({ series: rows.map(s => ({ id: s.id, title: s.title, description: s.description, cover: s.cover,
      price_coins: Number(s.price_coins), creator_id: s.creator_id, created_at: Number(s.created_at) })) });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.get('/api/series/:id', async (req, res) => {
  try {
    const meId = await optUserId(req);
    const s = await get1('SELECT * FROM series WHERE id=?', req.params.id);
    if (!s) return res.status(404).json({ error: 'série introuvable' });
    const isOwner = meId && Number(s.creator_id) === Number(meId);
    const purchased = meId && !isOwner
      ? !!(await get1('SELECT 1 FROM series_purchases WHERE series_id=? AND user_id=?', s.id, meId))
      : false;
    const items = await allRows(
      `SELECT v.* FROM series_items si JOIN videos v ON v.id=si.video_id
       WHERE si.series_id=? ORDER BY si.position ASC, v.created_at ASC`, s.id);
    const videos = [];
    for (const v of items) {
      const j = await videoJSON(v, meId);
      if (!j) continue;
      j.locked = !isOwner && !purchased;
      videos.push(j);
    }
    res.json({
      series: { id: s.id, title: s.title, description: s.description, cover: s.cover,
        price_coins: Number(s.price_coins), creator_id: s.creator_id, created_at: Number(s.created_at) },
      videos, purchased: !!purchased,
    });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.post('/api/series/:id/videos', auth, async (req, res) => {
  try {
    const s = await get1('SELECT * FROM series WHERE id=?', req.params.id);
    if (!s) return res.status(404).json({ error: 'série introuvable' });
    if (Number(s.creator_id) !== Number(req.userId))
      return res.status(403).json({ error: 'réservé au créateur de la série' });
    const v = await get1('SELECT * FROM videos WHERE id=?', Number((req.body || {}).video_id));
    if (!v) return res.status(404).json({ error: 'vidéo introuvable' });
    if (Number(v.user_id) !== Number(req.userId))
      return res.status(403).json({ error: 'cette vidéo ne vous appartient pas' });
    if (v.series_id) return res.status(400).json({ error: 'vidéo déjà dans une série' });
    const pos = Number((await get1('SELECT COUNT(*) AS c FROM series_items WHERE series_id=?', s.id)).c);
    await insertIgnore('INSERT OR IGNORE INTO series_items(series_id,video_id,position) VALUES(?,?,?)',
      s.id, v.id, pos);
    await runSql('UPDATE videos SET series_id=? WHERE id=?', s.id, v.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.delete('/api/series/:id/videos/:video_id', auth, async (req, res) => {
  try {
    const s = await get1('SELECT * FROM series WHERE id=?', req.params.id);
    if (!s) return res.status(404).json({ error: 'série introuvable' });
    if (Number(s.creator_id) !== Number(req.userId))
      return res.status(403).json({ error: 'réservé au créateur de la série' });
    await runSql('DELETE FROM series_items WHERE series_id=? AND video_id=?', s.id, req.params.video_id);
    await runSql('UPDATE videos SET series_id=NULL WHERE id=? AND series_id=?', req.params.video_id, s.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.post('/api/series/:id/buy', auth, async (req, res) => {
  try {
    const s = await get1('SELECT * FROM series WHERE id=?', req.params.id);
    if (!s) return res.status(404).json({ error: 'série introuvable' });
    if (Number(s.creator_id) === Number(req.userId))
      return res.status(400).json({ error: 'impossible d\'acheter votre propre série' });
    // FIX race 2026-10-05 (creusage profond #1) : 2 achats parallèles passaient le check
    // « déjà acheté » → double débit + double crédit créateur sur Postgres. Sérialisé par utilisateur.
    const out = await withUserLock(req.userId, async () => {
      const already = await get1('SELECT 1 FROM series_purchases WHERE series_id=? AND user_id=?', s.id, req.userId);
      if (already) return { error: 'série déjà achetée', code: 400 };
      const price = Number(s.price_coins);
      const creatorShare = Math.floor(price * 0.9); // 90 % créateur, 10 % plateforme
      await raceGap(req); // crochet test concurrence : simule l'intercalage Postgres
      const debited = await runSqlChanges('UPDATE users SET coins=coins-? WHERE id=? AND coins>=?', price, req.userId, price);
      if (!debited) return { error: 'pas assez de pièces', code: 400 };
      await runSql('UPDATE users SET coins=coins+? WHERE id=?', creatorShare, s.creator_id);
      await runSql('INSERT INTO ledger(user_id,amount,reason,created_at) VALUES(?,?,?,?)',
        req.userId, -price, 'achat série #' + s.id, now());
      await runSql('INSERT INTO ledger(user_id,amount,reason,created_at) VALUES(?,?,?,?)',
        s.creator_id, creatorShare, 'vente série #' + s.id, now());
      await insertIgnore('INSERT OR IGNORE INTO series_purchases(series_id,user_id,created_at) VALUES(?,?,?)',
        s.id, req.userId, now());
      await notify(s.creator_id, 'series_buy', req.userId, null, String(price));
      const balS = await get1('SELECT coins FROM users WHERE id=?', req.userId);
      return { ok: true, coins: balS ? balS.coins : 0 };
    });
    if (out.error) return res.status(out.code || 400).json({ error: out.error });
    res.json(out);
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});

// ==================== V13 : TIKTOK STUDIO — PROMOUVOIR UNE VIDÉO ====================
// Promotion payante d'une vidéo du créateur : débit du budget en pièces,
// suivi des impressions/clics jusqu'à épuisement du budget.
// POST /api/videos/:id/promote {budget_coins, target}
app.post('/api/videos/:id/promote', auth, async (req, res) => {
  try {
    const v = await get1('SELECT id, user_id, hidden FROM videos WHERE id=?', req.params.id);
    if (!v || v.hidden) return res.status(404).json({ error: 'vidéo introuvable' });
    if (Number(v.user_id) !== Number(req.userId))
      return res.status(403).json({ error: 'seul le créateur de la vidéo peut la promouvoir' });
    const budget = Math.floor(Number((req.body || {}).budget_coins));
    if (!budget || budget < 10)
      return res.status(400).json({ error: 'budget minimum : 10 pièces' });
    const target = String((req.body || {}).target || '').slice(0, 80);
    // v2.42 : le crédit promo est déduit EN PREMIER (avant les pièces de l'utilisateur)
    const fromCredit = await consumePromoCredit(req.userId, budget);
    const remainder = budget - fromCredit;
    if (remainder > 0) {
      const debited = await runSqlChanges('UPDATE users SET coins=coins-? WHERE id=? AND coins>=?', remainder, req.userId, remainder);
      if (!debited) return res.status(400).json({ error: 'pas assez de pièces' });
      await runSql('INSERT INTO ledger(user_id,amount,reason,created_at) VALUES(?,?,?,?)',
        req.userId, -remainder, 'promotion vidéo #' + v.id, now());
    }
    if (fromCredit > 0)
      await runSql('INSERT INTO ledger(user_id,amount,reason,created_at) VALUES(?,?,?,?)',
        req.userId, 0, 'promotion vidéo #' + v.id + ' (crédit promo ' + fromCredit + ' pièces)', now());
    const id = await insertId(
      `INSERT INTO video_promos(video_id,user_id,budget_coins,spent_coins,impressions,clicks,target,status,created_at)
       VALUES(?,?,?,0,0,0,?,'active',?)`,
      v.id, req.userId, budget, target, now());
    const bal = await get1('SELECT coins FROM users WHERE id=?', req.userId);
    res.json({ ok: true, promo_id: id, coins: bal ? Number(bal.coins) : 0 });
  } catch (e) { res.status(500).json({ error: 'échec de la promotion' }); }
});
// Simule une impression ou un clic sur une vidéo promue (débite le budget).
// POST /api/videos/:id/promo/event {type: 'impression'|'click'}
app.post('/api/videos/:id/promo/event', async (req, res) => {
  try {
    const type = String((req.body || {}).type || '');
    if (!['impression', 'click'].includes(type)) return res.status(400).json({ error: 'type invalide' });
    const p = await get1(`SELECT * FROM video_promos WHERE video_id=? AND status='active' ORDER BY id DESC LIMIT 1`, req.params.id);
    if (!p) return res.status(404).json({ error: 'aucune promotion active pour cette vidéo' });
    const cost = type === 'click' ? AD_COST_CLICK : AD_COST_IMPRESSION;
    if (Number(p.spent_coins) + cost > Number(p.budget_coins)) {
      await runSql(`UPDATE video_promos SET status='paused' WHERE id=?`, p.id);
      return res.status(400).json({ error: 'budget épuisé' });
    }
    await runSql('UPDATE video_promos SET spent_coins=spent_coins+?, impressions=impressions+?, clicks=clicks+? WHERE id=?',
      cost, type === 'impression' ? 1 : 0, type === 'click' ? 1 : 0, p.id);
    const upd = await get1('SELECT budget_coins,spent_coins,impressions,clicks,status FROM video_promos WHERE id=?', p.id);
    res.json({ ok: true, remaining: Number(upd.budget_coins) - Number(upd.spent_coins),
      impressions: Number(upd.impressions), clicks: Number(upd.clicks), status: upd.status });
  } catch (e) { res.status(500).json({ error: 'échec de l\'événement promo' }); }
});
// Stats de promotion d'une vidéo (propriétaire uniquement).
// GET /api/videos/:id/promo/stats
app.get('/api/videos/:id/promo/stats', auth, async (req, res) => {
  try {
    const v = await get1('SELECT user_id FROM videos WHERE id=?', req.params.id);
    if (!v) return res.status(404).json({ error: 'vidéo introuvable' });
    if (Number(v.user_id) !== Number(req.userId))
      return res.status(403).json({ error: 'réservé au créateur de la vidéo' });
    const p = await get1(`SELECT * FROM video_promos WHERE video_id=? ORDER BY id DESC LIMIT 1`, req.params.id);
    if (!p) return res.json({ promo: null });
    res.json({ promo: { id: p.id, budget_coins: Number(p.budget_coins), spent_coins: Number(p.spent_coins),
      remaining: Number(p.budget_coins) - Number(p.spent_coins),
      impressions: Number(p.impressions), clicks: Number(p.clicks), target: p.target || '',
      status: p.status, created_at: Number(p.created_at) } });
  } catch (e) { res.status(500).json({ error: 'échec de lecture des stats' }); }
});

// ==================== V13 : TIKTOK STUDIO — COLLABORATIONS ====================
// Le créateur invite un autre utilisateur à co-signer sa vidéo (partage des revenus).
// POST /api/videos/:id/collab/invite {username, revenue_share_pct}
app.post('/api/videos/:id/collab/invite', auth, async (req, res) => {
  try {
    const v = await get1('SELECT id, user_id, hidden, co_creator_id FROM videos WHERE id=?', req.params.id);
    if (!v || v.hidden) return res.status(404).json({ error: 'vidéo introuvable' });
    if (Number(v.user_id) !== Number(req.userId))
      return res.status(403).json({ error: 'seul le créateur de la vidéo peut inviter' });
    if (Number(v.co_creator_id)) return res.status(400).json({ error: 'cette vidéo a déjà un collaborateur' });
    const targetName = String((req.body || {}).username || '').trim().replace(/^@/, '');
    if (!targetName) return res.status(400).json({ error: 'pseudo requis' });
    const tu = await get1('SELECT id, username FROM users WHERE LOWER(username)=LOWER(?)', targetName);
    if (!tu) return res.status(404).json({ error: 'utilisateur introuvable' });
    if (Number(tu.id) === Number(req.userId))
      return res.status(400).json({ error: 'impossible de collaborer avec soi-même' });
    let pct = Math.floor(Number((req.body || {}).revenue_share_pct));
    if (!pct || pct < 1 || pct > 99) pct = 50;
    const dup = await get1(`SELECT id FROM collab_invites WHERE video_id=? AND invitee_id=? AND status='pending'`, v.id, tu.id);
    if (dup) return res.status(400).json({ error: 'invitation déjà envoyée' });
    const me = await get1('SELECT username FROM users WHERE id=?', req.userId);
    const inviterName = me ? me.username : ('user' + req.userId);
    const id = await insertId(
      `INSERT INTO collab_invites(video_id,inviter_id,invitee_id,status,revenue_share_pct,created_at)
       VALUES(?,?,?,'pending',?,?)`, v.id, req.userId, tu.id, pct, now());
    await notify(tu.id, 'collab_invite', req.userId, v.id, '🤝 @' + inviterName + ' t\'invite à collaborer sur une vidéo (' + pct + '% des revenus)');
    res.json({ ok: true, invite_id: id, revenue_share_pct: pct });
  } catch (e) { res.status(500).json({ error: 'échec de l\'invitation' }); }
});
// L'invité accepte : la vidéo devient co-signée (2 créateurs).
// POST /api/collab/:id/accept
app.post('/api/collab/:id/accept', auth, async (req, res) => {
  try {
    const inv = await get1('SELECT * FROM collab_invites WHERE id=?', req.params.id);
    if (!inv || inv.status !== 'pending') return res.status(404).json({ error: 'invitation introuvable' });
    if (Number(inv.invitee_id) !== Number(req.userId))
      return res.status(403).json({ error: 'cette invitation ne t\'est pas adressée' });
    await runSql(`UPDATE collab_invites SET status='accepted' WHERE id=?`, inv.id);
    await runSql('UPDATE videos SET co_creator_id=? WHERE id=?', inv.invitee_id, inv.video_id);
    await notify(inv.inviter_id, 'collab_accepted', req.userId, inv.video_id, '🤝 Collaboration acceptée !');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'échec de l\'acceptation' }); }
});
// L'invité refuse.
// POST /api/collab/:id/decline
app.post('/api/collab/:id/decline', auth, async (req, res) => {
  try {
    const inv = await get1('SELECT * FROM collab_invites WHERE id=?', req.params.id);
    if (!inv || inv.status !== 'pending') return res.status(404).json({ error: 'invitation introuvable' });
    if (Number(inv.invitee_id) !== Number(req.userId))
      return res.status(403).json({ error: 'cette invitation ne t\'est pas adressée' });
    await runSql(`UPDATE collab_invites SET status='rejected' WHERE id=?`, inv.id);
    await notify(inv.inviter_id, 'collab_declined', req.userId, inv.video_id, '😕 Collaboration refusée.');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'échec du refus' }); }
});
// Mes invitations de collaboration en attente.
// GET /api/collab/invites
app.get('/api/collab/invites', auth, async (req, res) => {
  try {
    const rows = await allRows(
      `SELECT ci.*, u.username AS inviter_name, v.description AS video_desc
       FROM collab_invites ci
       JOIN users u ON u.id=ci.inviter_id
       JOIN videos v ON v.id=ci.video_id
       WHERE ci.invitee_id=? AND ci.status='pending' ORDER BY ci.created_at DESC`, req.userId);
    res.json({ invites: rows.map(r => ({ id: r.id, video_id: r.video_id, inviter_id: r.inviter_id,
      inviter_name: r.inviter_name, video_desc: r.video_desc,
      revenue_share_pct: Number(r.revenue_share_pct), created_at: Number(r.created_at) })) });
  } catch (e) { res.status(500).json({ error: 'échec de lecture des invitations' }); }
});

// ---------- algo « Pour toi » : événements de visionnage ----------
app.post('/api/watch', auth, async (req, res) => {
  try {
    const b = req.body || {};
    const videoId = Number(b.video_id);
    if (!videoId) return res.status(400).json({ error: 'video_id requis' });
    const v = await get1('SELECT id FROM videos WHERE id=?', videoId);
    if (!v) return res.status(404).json({ error: 'vidéo introuvable' });
    const watchMs = Math.max(0, Math.floor(Number(b.watch_ms) || 0));
    const completed = Number(b.completed) === 1 ? 1 : 0;
    await runSql('INSERT INTO watch_events(user_id,video_id,watch_ms,completed,created_at) VALUES(?,?,?,?,?)',
      req.userId, videoId, watchMs, completed, now());
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});

// ---------- jumelage familial ----------
app.post('/api/family/code', auth, async (req, res) => {
  try {
    // un seul code actif par parent + purge des expirés
    await runSql('DELETE FROM family_codes WHERE parent_id=? OR created_at<?', req.userId, now() - 15 * 60 * 1000);
    // v1.54 : code crypto-aléatoire (Math.random() = devinable)
    const code = String(100000 + crypto.randomInt(900000)).padStart(6, '0');
    await runSql('INSERT INTO family_codes(code,parent_id,created_at) VALUES(?,?,?)', code, req.userId, now());
    res.json({ code, expires_in: 900 });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.post('/api/family/pair', auth, async (req, res) => {
  try {
    // v1.54 : rate-limit anti devinette de code (10 essais / 15 min par IP)
    const k = 'fpair|' + clientIp(req), t = now();
    let a = _loginAttempts.get(k) || [];
    a = a.filter(x => t - x < 15 * 60 * 1000);
    if (a.length >= 10) return res.status(429).json({ error: 'trop de tentatives, réessaie plus tard' });
    a.push(t); _loginAttempts.set(k, a);
    const code = String((req.body || {}).code || '').trim();
    const fc = await get1('SELECT * FROM family_codes WHERE code=?', code);
    if (!fc) return res.status(400).json({ error: 'code invalide' });
    if (now() - Number(fc.created_at) > 15 * 60 * 1000) {
      await runSql('DELETE FROM family_codes WHERE code=?', code);
      return res.status(400).json({ error: 'code expiré' });
    }
    if (Number(fc.parent_id) === Number(req.userId))
      return res.status(400).json({ error: 'impossible de se jumeler à soi-même' });
    const already = await get1('SELECT 1 FROM family_links WHERE parent_id=? AND teen_id=?', fc.parent_id, req.userId);
    if (already) return res.status(400).json({ error: 'déjà jumelé' });
    await insertIgnore('INSERT OR IGNORE INTO family_links(parent_id,teen_id,created_at) VALUES(?,?,?)',
      fc.parent_id, req.userId, now());
    await insertIgnore('INSERT OR IGNORE INTO family_settings(teen_id) VALUES(?)', req.userId);
    // SPEC-14 : le jumelage familial vaut accord parental (parental_consent)
    await runSql('UPDATE users SET parental_consent=1 WHERE id=?', req.userId);
    await runSql('DELETE FROM family_codes WHERE code=?', code);
    res.json({ ok: true, parent_id: fc.parent_id });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.get('/api/family/children', auth, async (req, res) => {
  try {
    const links = await allRows('SELECT teen_id FROM family_links WHERE parent_id=?', req.userId);
    const out = [];
    for (const l of links) {
      const t = await get1('SELECT id,username,avatar FROM users WHERE id=?', l.teen_id);
      const s = await get1('SELECT * FROM family_settings WHERE teen_id=?', l.teen_id);
      if (t) out.push({
        teen: { id: t.id, username: t.username, avatar: t.avatar },
        settings: s ? { screen_time_min: Number(s.screen_time_min),
          restricted_mode: Number(s.restricted_mode), dm_policy: s.dm_policy } : null,
      });
    }
    res.json({ children: out });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.put('/api/family/children/:teen_id/settings', auth, async (req, res) => {
  try {
    const teenId = Number(req.params.teen_id);
    const link = await get1('SELECT 1 FROM family_links WHERE parent_id=? AND teen_id=?', req.userId, teenId);
    if (!link) return res.status(403).json({ error: 'non autorisé' });
    const b = req.body || {};
    const stm = Math.floor(Number(b.screen_time_min));
    if (isNaN(stm) || stm < 0 || stm > 480)
      return res.status(400).json({ error: 'screen_time_min invalide (0 à 480)' });
    const rm = Number(b.restricted_mode) === 1 ? 1 : 0;
    const dmp = String(b.dm_policy || 'all');
    if (!['all', 'followers', 'none'].includes(dmp))
      return res.status(400).json({ error: 'dm_policy invalide (all|followers|none)' });
    await runSql('UPDATE family_settings SET screen_time_min=?, restricted_mode=?, dm_policy=? WHERE teen_id=?',
      stm, rm, dmp, teenId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.get('/api/family/my-settings', auth, async (req, res) => {
  try {
    const link = await get1('SELECT parent_id FROM family_links WHERE teen_id=?', req.userId);
    if (!link) return res.json({ is_teen: false, settings: null, parent: null });
    const s = await get1('SELECT * FROM family_settings WHERE teen_id=?', req.userId);
    const p = await get1('SELECT id,username,avatar FROM users WHERE id=?', link.parent_id);
    res.json({
      is_teen: true,
      settings: s ? { screen_time_min: Number(s.screen_time_min),
        restricted_mode: Number(s.restricted_mode), dm_policy: s.dm_policy } : null,
      parent: p ? { id: p.id, username: p.username, avatar: p.avatar } : null,
    });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.delete('/api/family/children/:teen_id', auth, async (req, res) => {
  try {
    const teenId = Number(req.params.teen_id);
    // résiliable des deux côtés : le parent retire l'enfant, ou l'enfant se retire
    const asParent = await get1('SELECT 1 FROM family_links WHERE parent_id=? AND teen_id=?', req.userId, teenId);
    const asTeen = await get1('SELECT 1 FROM family_links WHERE parent_id=? AND teen_id=?', teenId, req.userId);
    if (!asParent && !asTeen) return res.status(404).json({ error: 'lien introuvable' });
    await runSql('DELETE FROM family_links WHERE (parent_id=? AND teen_id=?) OR (parent_id=? AND teen_id=?)',
      req.userId, teenId, teenId, req.userId);
    const teenGone = asParent ? teenId : req.userId;
    const still = await get1('SELECT 1 FROM family_links WHERE teen_id=?', teenGone);
    if (!still) {
      await runSql('DELETE FROM family_settings WHERE teen_id=?', teenGone);
      // SPEC-14 : plus de parent jumelé → l'accord parental tombe
      await runSql('UPDATE users SET parental_consent=0 WHERE id=?', teenGone);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});

// ---------- publication programmée : publie les vidéos dont l'heure est passée ----------
async function publishDue() {
  try {
    // FIX temps 2026-10-05 (T1) : la transition scheduled→live des premieres + les notifs
    // premiere_live étaient faites ICI et dans updatePremieres() (toutes les 60 s chacune)
    // → doubles notifications. La transition vit désormais UNIQUEMENT dans updatePremieres().
    await runSql('UPDATE videos SET scheduled_at=NULL WHERE scheduled_at IS NOT NULL AND scheduled_at <= ?', now());
  } catch (e) {}
}

// ---------- AdMob : app-ads.txt, récompenses anti-fraude, calcul 50-50 quotidien ----------
app.get('/app-ads.txt', (req, res) => {
  res.type('text/plain').send('google.com, pub-5708506559717909, DIRECT, f08c47fec0942fa0\n');
});
// Documents juridiques hébergés (exigés par Google Play)
const _legal = (f) => (req, res) => {
  try { res.type('html').send(fs.readFileSync(path.join(__dirname, 'legal', f), 'utf8')); }
  catch (e) { res.status(404).send('Document indisponible'); }
};
app.get('/privacy', _legal('privacy.html'));
app.get('/terms', _legal('terms.html'));
// SPEC-download : lib QR (MIT, Kazuhiko Arase) servie en statique pour la page /download
app.use('/pub', express.static(path.join(__dirname, 'public'), { maxAge: '30d' }));
// SPEC-download : page de téléchargement — logo, bouton APK (URL depuis /api/app/version),
// QR code vers l'URL, guide d'installation FR + créole haïtien. 100 % statique, aucun service externe.
app.get('/download', async (req, res) => {
  try {
    const apkUrl = (await appConfigGet('apk_url')) || process.env.APP_APK_URL || '';
    res.type('html').send(downloadPageHtml(apkUrl));
  } catch (e) { res.status(500).send('Page indisponible'); }
});
function downloadPageHtml(apkUrl) {
  const esc = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const dlBtn = apkUrl
    ? '<a class="dlbtn" href="' + esc(apkUrl) + '">⬇️ Télécharger VidiGagne (Android)</a>'
    : '<div class="dlbtn off">⏳ Lien de téléchargement bientôt disponible</div>';
  const qrJs = apkUrl
    ? "try{var qr=qrcode(0,'M');qr.addData(" + JSON.stringify(apkUrl) + ");qr.make();document.getElementById('qr').innerHTML=qr.createSvgTag({scalable:true});}catch(e){document.getElementById('qr').innerHTML='QR indisponible';}"
    : "document.getElementById('qr').style.display='none';";
  return '<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>Télécharger VidiGagne</title>'
    + '<style>body{margin:0;background:#0b0b0f;color:#f5f5f5;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}'
    + '.wrap{max-width:640px;margin:0 auto;padding:28px 18px 60px;text-align:center}'
    + '.logo{width:96px;height:96px;margin:10px auto;background:#000;border:2px solid #d4af37;border-radius:24px;display:flex;align-items:center;justify-content:center;font-size:56px}'
    + 'h1{color:#d4af37;margin:8px 0 2px;font-size:30px}.sub{color:#aaa;margin:0 0 22px}'
    + '.dlbtn{display:inline-block;background:linear-gradient(135deg,#d4af37,#f5d76e);color:#111;font-weight:800;font-size:19px;padding:16px 34px;border-radius:14px;text-decoration:none;margin:8px 0 4px}'
    + '.dlbtn.off{background:#333;color:#999}.note{color:#888;font-size:13px;margin:6px 0 20px}'
    + '#qr{background:#fff;display:inline-block;padding:14px;border-radius:14px;margin:10px 0}#qr svg{width:200px;height:200px;display:block}'
    + '.guide{text-align:left;background:#15151b;border:1px solid #2a2a33;border-radius:14px;padding:18px;margin:18px 0}'
    + '.guide h2{margin:0 0 10px;font-size:18px;color:#d4af37}.guide ol{margin:0;padding-left:22px}.guide li{margin:8px 0;line-height:1.5;font-size:15px}'
    + '.foot{color:#666;font-size:12px;margin-top:30px}</style></head><body><div class="wrap">'
    + '<div class="logo">🎵</div><h1>VidiGagne</h1><p class="sub">Regarde des vidéos, gagne des pièces 💰</p>'
    + dlBtn + '<p class="note">Android 8.0+ · gratuit · ~45 Mo</p>'
    + '<div id="qr"></div><p class="note">Scanne ce QR code avec ton téléphone pour télécharger</p>'
    + '<div class="guide"><h2>📲 Comment installer (sources inconnues)</h2><ol>'
    + '<li>Appuie sur le bouton <b>Télécharger</b> ci-dessus.</li>'
    + '<li>Ouvre le fichier téléchargé quand c\u2019est terminé.</li>'
    + '<li>Ton téléphone demande l\u2019autorisation d\u2019installer des applications de <b>sources inconnues</b> : appuie sur <b>Autoriser</b>.</li>'
    + '<li>Appuie sur <b>Installer</b>, puis ouvre VidiGagne et inscris-toi — c\u2019est gratuit !</li>'
    + '</ol></div>'
    + '<div class="guide"><h2>📲 Kijan pou enstale (sous enkoni)</h2><ol>'
    + '<li>Peze bouton <b>Telechaje</b> anwo a.</li>'
    + '<li>Louvri fichye a lè telechajman an fini.</li>'
    + '<li>Telefòn ou ap mande pèmisyon pou enstale aplikasyon ki pa soti nan Play Store (<b>sous enkoni</b>) : peze <b>Pèmèt</b>.</li>'
    + '<li>Peze <b>Enstale</b>, epi louvri VidiGagne epi enskri — se gratis !</li>'
    + '</ol></div>'
    + '<p class="foot">VidiGagne — 100 % gratuit, aucune carte bancaire requise.</p>'
    + '</div><script src="/pub/qrcode-lib.js"></script><script>' + qrJs + '</script></body></html>';
}

// ==================== v2.44-EQA-OG : pages publiques de partage (OG tags) — Équipe A ====================
// GET /v/:id, /u/:username, /@/:username, /live/:id → HTML avec Open Graph / Twitter Card
// pour les aperçus WhatsApp / Facebook / X. Bouton "Ouvrir dans l'app" (deep link vidigagne://).
// NOTE (2026-10-05) :
//   - sha256_cert_fingerprints : ✅ empreinte SHA-256 RÉELLE du keystore officiel (COIN-02)
//   - Apple : aucun Team ID connu (login Apple à 99 $/an, en attente du feu vert de Kewin)
//     → apple-app-site-association déclare details:[] (aucune app iOS associée), sans placeholder (COIN-03)
const escOg = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ogBaseOf = req => (req.protocol + '://' + req.get('host')).replace(/\/$/, '');
function ogHtml(req, o) {
  // o = { title, desc, image?, video?, deep?, path?, notfound? }
  const base = ogBaseOf(req);
  const T = escOg(o.title), D = escOg(o.desc || "VidiGagne — Regarde des vidéos. Gagne de l'argent.");
  const tags = ['<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>' + T + ' — VidiGagne</title>',
    '<meta property="og:site_name" content="VidiGagne">',
    '<meta property="og:type" content="' + (o.video ? 'video.other' : 'profile') + '">',
    '<meta property="og:title" content="' + T + '">',
    '<meta property="og:description" content="' + D + '">',
    '<meta property="og:url" content="' + escOg(base + (o.path || req.path)) + '">',
    '<meta name="twitter:card" content="' + (o.video ? 'player' : 'summary_large_image') + '">',
    '<meta name="twitter:title" content="' + T + '">',
    '<meta name="twitter:description" content="' + D + '">'];
  if (o.image) tags.push('<meta property="og:image" content="' + escOg(o.image) + '">',
    '<meta name="twitter:image" content="' + escOg(o.image) + '">');
  if (o.video) tags.push('<meta property="og:video" content="' + escOg(o.video) + '">',
    '<meta property="og:video:secure_url" content="' + escOg(o.video) + '">',
    '<meta property="og:video:type" content="video/mp4">');
  return '<!DOCTYPE html><html lang="fr"><head>' + tags.join('') + '</head>'
    + '<body style="margin:0;background:#0b0b0f;color:#fff;font-family:system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;text-align:center">'
    + '<div style="max-width:420px;padding:28px">'
    + '<div style="font-size:40px;margin-bottom:10px">🎵</div>'
    + '<div style="font-size:22px;font-weight:800;margin-bottom:6px">VidiGagne</div>'
    + '<div style="font-size:16px;font-weight:700;margin-bottom:6px">' + T + '</div>'
    + '<div style="color:#bbb;font-size:14px;margin-bottom:22px">' + D + '</div>'
    + (o.notfound
      ? "<p style=\"color:#888\">Ce contenu n'existe pas ou a été supprimé.</p>"
      : '<a href="' + escOg(o.deep || '') + '" style="display:inline-block;background:#d4af37;color:#111;font-weight:800;font-size:17px;padding:14px 34px;border-radius:30px;text-decoration:none">📲 Ouvrir dans l\'app</a>'
        + '<p style="color:#777;font-size:12px;margin-top:16px">Pas encore l\'app ? <a href="https://vidigagne.app" style="color:#d4af37">Découvrir VidiGagne</a></p>')
    + '</div></body></html>';
}
function og404(req, res, title) {
  res.status(404).type('html').send(ogHtml(req, { title: title || 'Contenu introuvable', notfound: true }));
}
app.get('/v/:id', async (req, res) => {
  try {
    if (!/^\d+$/.test(req.params.id)) return og404(req, res, 'Vidéo introuvable');
    const v = await get1('SELECT v.id, v.description, v.file, v.visibility, u.username, u.avatar FROM videos v JOIN users u ON u.id=v.user_id WHERE v.id=?', Number(req.params.id));
    if (!v) return og404(req, res, 'Vidéo introuvable');
    // FIX sécu 2026-10-05 (confidentialité #1 CRITIQUE) : la page publique /v/:id exposait
    // les vidéos PRIVÉES (description + URL directe du fichier) sans authentification.
    if ((v.visibility || 'public') !== 'public') return og404(req, res, 'Vidéo introuvable');
    const base = ogBaseOf(req);
    const fu = fileUrl(v.file || '');
    const absFu = /^https?:\/\//.test(fu) ? fu : base + fu;
    const isVid = /\.(mp4|webm|mov)(\?|$)/i.test(absFu);
    // NOTE : pas de miniature en base (colonne thumbnail absente) — og:image = avatar si c'est une URL,
    // sinon seul og:video est fourni (lecteur intégré FB/X).
    const av = /^https?:\/\//.test(v.avatar || '') ? v.avatar : null;
    const desc = String(v.description || '').slice(0, 200) || 'Vidéo VidiGagne';
    res.type('html').send(ogHtml(req, {
      title: desc, desc: '@' + v.username + ' sur VidiGagne',
      image: av, video: isVid ? absFu : null,
      deep: 'vidigagne://video/' + v.id, path: '/v/' + v.id,
    }));
  } catch (e) { res.status(500).send('erreur serveur'); }
});
async function ogUserPage(req, res) {
  try {
    const un = String(req.params.username || '').toLowerCase();
    if (!validUsername(un)) return og404(req, res, 'Profil introuvable');
    const u = await get1('SELECT username, bio, avatar FROM users WHERE username=?', un);
    if (!u) return og404(req, res, 'Profil introuvable');
    const av = /^https?:\/\//.test(u.avatar || '') ? u.avatar : null;
    res.type('html').send(ogHtml(req, {
      title: '@' + u.username, desc: u.bio || 'Profil VidiGagne',
      image: av, deep: 'vidigagne://user/' + encodeURIComponent(u.username), path: req.path,
    }));
  } catch (e) { res.status(500).send('erreur serveur'); }
}
app.get('/u/:username', ogUserPage);
app.get('/@/:username', ogUserPage);
app.get('/live/:id', async (req, res) => {
  try {
    if (!/^\d+$/.test(req.params.id)) return og404(req, res, 'Live introuvable');
    const l = await get1('SELECT l.id, l.title, l.ended_at, u.username FROM lives l JOIN users u ON u.id=l.user_id WHERE l.id=?', Number(req.params.id));
    if (!l) return og404(req, res, 'Live introuvable');
    const live = !l.ended_at;
    res.type('html').send(ogHtml(req, {
      title: (live ? '🔴 LIVE en cours' : 'Live terminé') + ' — @' + l.username,
      desc: l.title || 'Live VidiGagne',
      deep: 'vidigagne://live/' + l.id, path: '/live/' + l.id,
    }));
  } catch (e) { res.status(500).send('erreur serveur'); }
});
const ASSETLINKS_EQA = [{ relation: ['delegate_permission/common.handle_all_urls'],
  target: { namespace: 'android_app', package_name: 'com.vidigagne.app',
    sha256_cert_fingerprints: ['BB:A7:AC:FD:81:9C:3D:E6:13:59:FA:6E:F9:FA:D8:97:0E:63:C6:35:9A:E5:F2:47:B8:31:C4:D5:D0:B2:E2:EA'] } }];
// COIN-03 (2026-10-05) : pas d'identifiant d'équipe Apple Developer connu (login Apple non
// configuré — 99 $/an, en attente du feu vert de Kewin) → aucun placeholder factice :
// details vide = aucune app iOS associée déclarée (valide et honnête).
const AAS_EQA = { applinks: { details: [] } };
app.get('/.well-known/assetlinks.json', (req, res) => { res.type('application/json').send(JSON.stringify(ASSETLINKS_EQA)); });
app.get('/.well-known/apple-app-site-association', (req, res) => { res.type('application/json').send(JSON.stringify(AAS_EQA)); });
// ==================== fin v2.44-EQA-OG ====================
function clientIp(req){
  // v2.47-sec : req.ip = segment X-Forwarded-For à N hops de la droite (N = trust proxy).
  // Fiable uniquement derrière un proxy de confiance (Railway en prod). En connexion
  // directe, le client peut forger X-Forwarded-For → TRUST_PROXY=0 en dev.
  return (req.ip || req.socket.remoteAddress || '').trim().slice(0, 45);
}
async function bumpDailyPoints(n){
  try{
    const day = new Date().toISOString().slice(0,10);
    const r = await get1('SELECT points_distributed FROM ad_daily WHERE day=?', day);
    if(r) await runSql('UPDATE ad_daily SET points_distributed=points_distributed+? WHERE day=?', n, day);
    else await runSql('INSERT INTO ad_daily(day,points_distributed,ad_revenue_usd) VALUES(?,?,0)', day, n);
  }catch(e){}
}
// POST /api/ads/reward — récompense vidéo validée serveur (anti-fraude : 1/IP/5min, 1/user/2min)
app.post('/api/ads/reward', auth, async (req, res) => {
  try{
    const ip = clientIp(req);
    const t = now();
    // anti-concurrence (2026-10-04) : les garde-fous anti-fraude (1/IP/5min, 1/user/2min)
    // et le plafond journalier sont LUS puis ÉCRITS — sans sérialisation, 2 requêtes
    // simultanées passent les contrôles ensemble et créditent 2× (TOCTOU).
    const out = await withUserLock(req.userId, async () => {
      const ipHit = await get1('SELECT id FROM ad_reward_claims WHERE ip=? AND created_at>?', ip, t-5*60*1000);
      if(ipHit) return { error: 'trop de demandes (anti-fraude)' };
      const uHit = await get1('SELECT id FROM ad_reward_claims WHERE user_id=? AND created_at>?', req.userId, t-2*60*1000);
      if(uHit) return { error: 'patiente 2 minutes' };
      // plafond journalier serveur : 100 pièces/jour max (le localStorage ne suffit pas)
      const dayStart = new Date().setHours(0,0,0,0);
      const earned = Number((await get1(`SELECT COALESCE(SUM(amount),0) AS s FROM ledger WHERE user_id=? AND amount>0 AND created_at>=?`, req.userId, dayStart)).s);
      if (earned >= 100) return { error: 'plafond journalier atteint (100 pièces)' };
      const grant = Math.min(30, 100 - earned);
      await runSql('INSERT INTO ad_reward_claims(user_id,ip,created_at) VALUES(?,?,?)', req.userId, ip, t);
      await runSql('UPDATE users SET coins=coins+? WHERE id=?', grant, req.userId);
      await runSql('INSERT INTO ledger(user_id,amount,reason,created_at) VALUES(?,?,?,?)', req.userId, grant, 'pub récompensée', t);
      await bumpDailyPoints(grant);
      return { granted: grant };
    });
    if (out.error) return res.status(429).json({ error: out.error });
    const balR = await get1('SELECT coins FROM users WHERE id=?', req.userId);
    res.json({ ok:true, granted: out.granted, coins: balR ? balR.coins : 0 });
  }catch(e){ res.status(500).json({ error:'erreur serveur' }); }
});
// Calcul 50-50 du jour : 50% propriétaire, 50%/points = valeur du point
async function computeDaily5050(dayStr){
  try{
    const r = await get1('SELECT points_distributed, ad_revenue_usd FROM ad_daily WHERE day=?', dayStr);
    const pts = r ? Number(r.points_distributed||0) : 0;
    const rev = r ? Number(r.ad_revenue_usd||0) : 0;
    const ownerShare = +(rev*0.5).toFixed(4);
    const pointValue = pts>0 ? +((rev*0.5)/pts).toFixed(6) : 0;
    if(r) await runSql('UPDATE ad_daily SET point_value_usd=?, computed_at=? WHERE day=?', pointValue, now(), dayStr);
    else await runSql('INSERT INTO ad_daily(day,points_distributed,ad_revenue_usd,point_value_usd,computed_at) VALUES(?,0,?,?,?)', dayStr, rev, pointValue, now());
    return { day:dayStr, revenue_usd:rev, owner_share_usd:ownerShare, points:pts, point_value_usd:pointValue };
  }catch(e){ return { error:e.message }; }
}
// Tableau de bord admin 50-50
app.get('/api/admin/ads/daily', adminAuth, async (req, res) => {
  try{
    const rows = await allRows('SELECT * FROM ad_daily ORDER BY day DESC LIMIT 31');
    res.json({ ok:true, days:rows });
  }catch(e){ res.status(500).json({ error:'erreur serveur' }); }
});
// Saisie manuelle du revenu AdMob du jour (en attendant l'API AdMob OAuth)
app.post('/api/admin/ads/revenue', adminAuth, async (req, res) => {
  try{
    const day = String(req.body.day || new Date().toISOString().slice(0,10)).slice(0,10);
    const rev = Math.max(0, Number(req.body.revenue_usd||0));
    const r = await get1('SELECT day FROM ad_daily WHERE day=?', day);
    if(r) await runSql('UPDATE ad_daily SET ad_revenue_usd=? WHERE day=?', rev, day);
    else await runSql('INSERT INTO ad_daily(day,points_distributed,ad_revenue_usd) VALUES(?,0,?)', day, rev);
    res.json({ ok:true, ...(await computeDaily5050(day)) });
  }catch(e){ res.status(500).json({ error:'erreur serveur' }); }
});
// V13 : déclenchement manuel de la distribution des revenus pubs aux créateurs
// (même calcul que le cron 23h59, partage collab inclus) — utile pour les tests.
app.post('/api/admin/ads/distribute', adminAuth, async (req, res) => {
  try {
    const day = String((req.body || {}).day || new Date().toISOString().slice(0, 10)).slice(0, 10);
    res.json({ ok: true, ...(await distributeAdRevenue(day)) });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// v2.42 : crédit promo — pièces offertes utilisables UNIQUEMENT pour les promotions vidéo
// (déduites en priorité quand l'utilisateur crée une promo).
app.post('/api/admin/promo-credit', adminAuth, async (req, res) => {
  try {
    const b = req.body || {};
    const uid = Number(b.user_id);
    const coins = Math.floor(Number(b.coins));
    const reason = String(b.reason || '').trim().slice(0, 120);
    const days = Math.max(1, Math.floor(Number(b.expires_days || 30)));
    if (!uid || !coins || coins <= 0) return res.status(400).json({ error: 'user_id et coins (>0) requis' });
    const u = await get1('SELECT id FROM users WHERE id=?', uid);
    if (!u) return res.status(404).json({ error: 'utilisateur introuvable' });
    const t = now();
    const id = await insertId(
      `INSERT INTO promo_credits(user_id,coins,reason,expires_at,used_coins,created_at) VALUES(?,?,?,?,0,?)`,
      uid, coins, reason, t + days * 86400000, t);
    res.json({ ok: true, id, user_id: uid, coins, expires_at: t + days * 86400000 });
  } catch (e) { res.status(500).json({ error: 'échec du crédit promo' }); }
});
app.get('/api/me/promo-credits', auth, async (req, res) => {
  try {
    const rows = await allRows(`SELECT * FROM promo_credits WHERE user_id=? AND expires_at>? AND used_coins<coins ORDER BY created_at ASC`,
      req.userId, now());
    const total = rows.reduce((a, r) => a + (Number(r.coins) - Number(r.used_coins)), 0);
    res.json({ credits: rows.map(r => ({ id: r.id, coins: Number(r.coins), used_coins: Number(r.used_coins),
      available: Number(r.coins) - Number(r.used_coins), reason: r.reason || '',
      expires_at: Number(r.expires_at), created_at: Number(r.created_at) })), total_available: total });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// Débiter le crédit promo disponible (FIFO, plus ancien d'abord). Retourne les pièces prises sur crédit.
async function consumePromoCredit(userId, amount) {
  const t = now();
  const rows = await allRows(`SELECT id, coins, used_coins FROM promo_credits
    WHERE user_id=? AND expires_at>? AND used_coins<coins ORDER BY created_at ASC, id ASC`, userId, t);
  let need = amount, taken = 0;
  for (const r of rows) {
    if (need <= 0) break;
    const avail = Number(r.coins) - Number(r.used_coins);
    const use = Math.min(avail, need);
    await runSql('UPDATE promo_credits SET used_coins=used_coins+? WHERE id=?', use, r.id);
    taken += use; need -= use;
  }
  return taken;
}
// Déclenchement quotidien à 23h59 (heure serveur, UTC sur Render)
setInterval(async () => {
  try{
    const d = new Date();
    if(d.getUTCHours()===23 && d.getUTCMinutes()===59){
      const dayStr = d.toISOString().slice(0,10);
      if(computeDaily5050._done !== dayStr){
        computeDaily5050._done = dayStr;
        const r = await computeDaily5050(dayStr);
        const dist = await distributeAdRevenue(dayStr);
        console.log('revenus créateurs distribués pour', dayStr, JSON.stringify(dist));
        console.log('50-50 calculé pour', dayStr, JSON.stringify(r));
      }
    }
  }catch(e){}
}, 30000);


// ==================== v1.84 : FONCTIONNALITÉS TIKTOK ====================

// ---------- historique de recherche ----------
app.get('/api/search/history', auth, async (req, res) => {
  try {
    const rows = await allRows('SELECT DISTINCT query, MAX(created_at) AS ts FROM search_logs WHERE user_id=? GROUP BY query ORDER BY ts DESC LIMIT 30', req.userId);
    res.json({ ok: true, history: rows.map(r => r.query) });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.delete('/api/search/history', auth, async (req, res) => {
  try { await runSql('DELETE FROM search_logs WHERE user_id=?', req.userId); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.delete('/api/search/history/:q', auth, async (req, res) => {
  try { await runSql('DELETE FROM search_logs WHERE user_id=? AND query=?', req.userId, req.params.q); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// ---------- suggestions de recherche ----------
app.get('/api/search/suggest', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim().toLowerCase().slice(0, 50);
    if (!q) return res.json({ ok: true, suggestions: [] });
    const rows = await allRows(`SELECT query, COUNT(*) AS c FROM search_logs WHERE LOWER(query) LIKE ? GROUP BY query ORDER BY c DESC LIMIT 8`, q + '%');
    res.json({ ok: true, suggestions: rows.map(r => r.query) });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});

// ---------- vidéos épinglées (max 3, façon TikTok) ----------
app.post('/api/videos/:id/pin', auth, async (req, res) => {
  try {
    const v = await get1('SELECT * FROM videos WHERE id=?', req.params.id);
    if (!v) return res.status(404).json({ error: 'vidéo introuvable' });
    if (Number(v.user_id) !== Number(req.userId)) return res.status(403).json({ error: 'non autorisé' });
    const c = await get1('SELECT COUNT(*) AS c FROM video_pins WHERE user_id=?', req.userId);
    if (Number(c.c) >= 3) return res.status(400).json({ error: '3 vidéos épinglées maximum' });
    await insertIgnore('INSERT OR IGNORE INTO video_pins(user_id,video_id,pinned_at) VALUES(?,?,?)', req.userId, v.id, now());
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.delete('/api/videos/:id/pin', auth, async (req, res) => {
  try { await runSql('DELETE FROM video_pins WHERE user_id=? AND video_id=?', req.userId, req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.get('/api/users/:username/pinned', async (req, res) => {
  try {
    const u = await get1('SELECT id FROM users WHERE username=?', req.params.username);
    if (!u) return res.status(404).json({ error: 'utilisateur introuvable' });
    const rows = await allRows(`SELECT v.* FROM video_pins p JOIN videos v ON v.id=p.video_id WHERE p.user_id=? ORDER BY p.pinned_at DESC`, u.id);
    res.json({ ok: true, videos: rows });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});

// ---------- duos et collages ----------
// PARITÉ TIKTOK 2026-10-04 : politique par compte (everyone/friends/none) en plus du flag par vidéo
async function areFriends(a, b) {
  if (!a || !b || Number(a) === Number(b)) return true;
  const x = await get1('SELECT 1 FROM follows WHERE follower_id=? AND followed_id=?', a, b);
  const y = await get1('SELECT 1 FROM follows WHERE follower_id=? AND followed_id=?', b, a);
  return !!(x && y);
}
async function checkReusePolicy(meId, ownerId, kind) {
  // kind: 'duet' | 'stitch' → true si autorisé
  if (Number(meId) === Number(ownerId)) return true;
  let u = null;
  try { u = await get1(`SELECT ${kind}_policy FROM users WHERE id=?`, ownerId); } catch (e) {}
  const p = (u && u[`${kind}_policy`]) || 'everyone';
  if (p === 'none') return false;
  if (p === 'friends') return await areFriends(meId, ownerId);
  return true; // everyone
}
const VALID_POLICIES = ['everyone', 'friends', 'none'];
app.get('/api/me/privacy', auth, async (req, res) => {
  try {
    const u = await get1('SELECT duet_policy, stitch_policy, comment_privacy, discoverable, activity_status FROM users WHERE id=?', req.userId);
    res.json({ ok: true, duet_policy: (u && u.duet_policy) || 'everyone', stitch_policy: (u && u.stitch_policy) || 'everyone', comment_privacy: (u && u.comment_privacy) || 'everyone',
      discoverable: !u || Number(u.discoverable) !== 0, activity_status: (u && u.activity_status) || 'public' });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.post('/api/me/privacy', auth, async (req, res) => {
  try {
    const b = req.body || {};
    const sets = [], vals = [];
    if (b.duet_policy !== undefined) {
      if (!VALID_POLICIES.includes(b.duet_policy)) return res.status(400).json({ error: 'politique invalide' });
      sets.push('duet_policy=?'); vals.push(b.duet_policy);
    }
    if (b.stitch_policy !== undefined) {
      if (!VALID_POLICIES.includes(b.stitch_policy)) return res.status(400).json({ error: 'politique invalide' });
      sets.push('stitch_policy=?'); vals.push(b.stitch_policy);
    }
    // parité TikTok (2026-10-04) : préférences de confidentialité fusionnées ICI —
    // Express ne route que vers le premier handler déclaré, l'ancien doublon plus bas était inerte
    // (comment_privacy et autres n'étaient jamais persistés)
    const allowed = { dm_privacy: ['everyone', 'friends', 'nobody'], comment_privacy: ['everyone', 'followers', 'friends', 'nobody'],
      mention_privacy: ['everyone', 'friends', 'nobody'], download_privacy: ['everyone', 'friends', 'nobody'],
      liked_visibility: ['everyone', 'friends', 'me'], following_visibility: ['everyone', 'friends', 'me'],
      activity_status: ['public', 'friends', 'nobody'] };
    for (const k of Object.keys(allowed)) {
      if (b[k] !== undefined && allowed[k].includes(b[k])) { sets.push(k + '=?'); vals.push(b[k]); }
    }
    // "Ne pas suggérer mon compte" : booléen → 0/1, traité à part (pas une liste de politiques)
    if (b.discoverable !== undefined) { sets.push('discoverable=?'); vals.push(b.discoverable ? 1 : 0); }
    if (sets.length) { vals.push(req.userId); await runSql(`UPDATE users SET ${sets.join(',')} WHERE id=?`, ...vals); }
    const u = await get1('SELECT duet_policy, stitch_policy FROM users WHERE id=?', req.userId);
    res.json({ ok: true, duet_policy: u.duet_policy, stitch_policy: u.stitch_policy });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// compatibilité : l'app <v2.31 appelait /api/me/reuse (binaire) — mappé sur les politiques
app.post('/api/me/reuse', auth, async (req, res) => {
  try {
    const b = req.body || {};
    const sets = [], vals = [];
    if (b.allowDuet !== undefined) { sets.push('duet_policy=?'); vals.push(b.allowDuet ? 'everyone' : 'none'); }
    if (b.allowStitch !== undefined) { sets.push('stitch_policy=?'); vals.push(b.allowStitch ? 'everyone' : 'none'); }
    if (sets.length) { vals.push(req.userId); await runSql(`UPDATE users SET ${sets.join(',')} WHERE id=?`, ...vals); }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.post('/api/videos/:id/duet', auth, async (req, res) => {
  try {
    const orig = await get1('SELECT * FROM videos WHERE id=?', req.params.id);
    if (!orig) return res.status(404).json({ error: 'vidéo introuvable' });
    if (!Number(orig.allow_duet)) return res.status(403).json({ error: 'duos non autorisés sur cette vidéo' });
    if (!(await checkReusePolicy(req.userId, orig.user_id, 'duet')))
      return res.status(403).json({ error: 'le créateur n’autorise pas les duos' });
    res.json({ ok: true, original: { id: orig.id, url: orig.url, user_id: orig.user_id } });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.post('/api/videos/:id/stitch', auth, async (req, res) => {
  try {
    const orig = await get1('SELECT * FROM videos WHERE id=?', req.params.id);
    if (!orig) return res.status(404).json({ error: 'vidéo introuvable' });
    if (!Number(orig.allow_stitch)) return res.status(403).json({ error: 'collages non autorisés sur cette vidéo' });
    if (!(await checkReusePolicy(req.userId, orig.user_id, 'stitch')))
      return res.status(403).json({ error: 'le créateur n’autorise pas les collages' });
    res.json({ ok: true, original: { id: orig.id, url: orig.url, user_id: orig.user_id, duration: orig.duration } });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// ---------- permissions vidéo (à la publication) ----------
app.post('/api/videos/:id/permissions', auth, async (req, res) => {
  try {
    const v = await get1('SELECT * FROM videos WHERE id=?', req.params.id);
    if (!v) return res.status(404).json({ error: 'vidéo introuvable' });
    if (Number(v.user_id) !== Number(req.userId)) return res.status(403).json({ error: 'non autorisé' });
    const b = req.body || {};
    const cols = ['allow_duet', 'allow_stitch', 'allow_download', 'allow_comments', 'visibility', 'location', 'sensitive'];
    const sets = [], vals = [];
    if (b.allow_duet !== undefined) { sets.push('allow_duet=?'); vals.push(b.allow_duet ? 1 : 0); }
    if (b.allow_stitch !== undefined) { sets.push('allow_stitch=?'); vals.push(b.allow_stitch ? 1 : 0); }
    if (b.sensitive !== undefined) { sets.push('sensitive=?'); vals.push(b.sensitive ? 1 : 0); }
    if (b.allow_download !== undefined) { sets.push('allow_download=?'); vals.push(b.allow_download ? 1 : 0); }
    if (b.allow_comments !== undefined) { sets.push('allow_comments=?'); vals.push(b.allow_comments ? 1 : 0); }
    if (b.visibility && ['public', 'friends', 'private'].includes(b.visibility)) { sets.push('visibility=?'); vals.push(b.visibility); }
    if (b.location !== undefined) { sets.push('location=?'); vals.push(String(b.location).slice(0, 100)); }
    if (sets.length) { vals.push(v.id); await runSql(`UPDATE videos SET ${sets.join(',')} WHERE id=?`, ...vals); }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});

// ---------- brouillons ----------
app.get('/api/drafts', auth, async (req, res) => {
  try {
    const rows = await allRows('SELECT * FROM video_drafts WHERE user_id=? ORDER BY updated_at DESC', req.userId);
    res.json({ ok: true, drafts: rows });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.post('/api/drafts', auth, async (req, res) => {
  try {
    const b = req.body || {};
    const id = await insertId('INSERT INTO video_drafts(user_id,video_url,thumb_url,description,created_at,updated_at) VALUES(?,?,?,?,?,?)',
      req.userId, String(b.video_url || ''), String(b.thumb_url || ''), String(b.description || '').slice(0, 500), now(), now());
    res.json({ ok: true, id });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.delete('/api/drafts/:id', auth, async (req, res) => {
  try { await runSql('DELETE FROM video_drafts WHERE id=? AND user_id=?', req.params.id, req.userId); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});

// ---------- demandes de messages (inconnus) ----------
// v2.48 : un inconnu (non ami mutuel) ne crée plus directement une conversation ;
// POST /api/conversations crée une demande en attente (202), le destinataire
// accepte (→ conversation créée) ou refuse via les endpoints ci-dessous.
app.post('/api/messages/requests', auth, async (req, res) => {
  try {
    const username = String((req.body || {}).username || '').toLowerCase().trim();
    if (!username) return res.status(400).json({ error: 'pseudo requis' });
    const other = await get1('SELECT * FROM users WHERE username=?', username);
    if (!other) return res.status(404).json({ error: 'utilisateur introuvable' });
    if (Number(other.id) === Number(req.userId)) return res.status(400).json({ error: 'impossible' });
    if (await isBlocked(req.userId, other.id)) return res.status(403).json({ error: 'utilisateur bloqué' });
    const dmpol = other.dm_privacy || 'everyone';
    if (dmpol === 'nobody') return res.status(403).json({ error: "ce compte n'accepte aucun message" });
    const ex = await get1("SELECT * FROM message_requests WHERE from_user_id=? AND to_user_id=? AND status='pending'", req.userId, other.id);
    if (ex) return res.json({ ok: true, id: ex.id, request_pending: true });
    const text = String((req.body || {}).text || '').slice(0, 500);
    const id = await insertId('INSERT INTO message_requests(from_user_id,to_user_id,text,status,created_at) VALUES(?,?,?,\'pending\',?)',
      req.userId, other.id, text, now());
    try { await insertId('INSERT INTO notifications(user_id,type,actor_id,title,text,is_read,created_at) VALUES(?,?,?,?,?,0,?)',
      other.id, 'message_request', req.userId, '✉️ Nouvelle demande de message', text.slice(0, 120), now()); } catch (_) {}
    res.status(201).json({ ok: true, id, request_pending: true });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.get('/api/messages/requests', auth, async (req, res) => {
  try {
    const rows = await allRows(`SELECT mr.*, u.username FROM message_requests mr JOIN users u ON u.id=mr.from_user_id WHERE mr.to_user_id=? AND mr.status='pending' ORDER BY mr.created_at DESC`, req.userId);
    res.json({ ok: true, requests: rows });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.post('/api/messages/requests/:id/accept', auth, async (req, res) => {
  try {
    const r = await get1('SELECT * FROM message_requests WHERE id=? AND to_user_id=?', req.params.id, req.userId);
    if (!r) return res.status(404).json({ error: 'introuvable' });
    if (r.status !== 'pending') return res.status(400).json({ error: 'demande déjà traitée' });
    await runSql("UPDATE message_requests SET status='accepted' WHERE id=?", r.id);
    // la conversation n'est créée qu'APRÈS acceptation
    const a = Math.min(Number(r.from_user_id), Number(r.to_user_id));
    const b = Math.max(Number(r.from_user_id), Number(r.to_user_id));
    let conv = await get1('SELECT * FROM conversations WHERE user1_id=? AND user2_id=?', a, b);
    if (!conv) {
      const cid = await insertId('INSERT INTO conversations(user1_id,user2_id,created_at,updated_at) VALUES(?,?,?,?)', a, b, now(), now());
      conv = await get1('SELECT * FROM conversations WHERE id=?', cid);
    }
    try { await insertId('INSERT INTO notifications(user_id,type,actor_id,title,text,is_read,created_at) VALUES(?,?,?,?,?,0,?)',
      r.from_user_id, 'message_request_accepted', req.userId, '✅ Demande acceptée', 'Vous pouvez maintenant discuter 💬', now()); } catch (_) {}
    res.json({ ok: true, conversation_id: conv.id });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.post('/api/messages/requests/:id/decline', auth, async (req, res) => {
  try {
    // B2 (2026-10-05) : 404 si la demande n'existe pas (ou ne m'est pas adressée)
    const r = await get1('SELECT id FROM message_requests WHERE id=? AND to_user_id=?', req.params.id, req.userId);
    if (!r) return res.status(404).json({ error: 'demande introuvable' });
    await runSql("UPDATE message_requests SET status='declined' WHERE id=?", r.id);
    res.json({ ok: true });
  }
  catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});

// ---------- modérateurs de live ----------
app.post('/api/lives/:id/moderators', auth, async (req, res) => {
  try {
    const l = await get1('SELECT * FROM lives WHERE id=?', req.params.id);
    if (!l) return res.status(404).json({ error: 'live introuvable' });
    if (Number(l.user_id) !== Number(req.userId)) return res.status(403).json({ error: 'non autorisé' });
    const target = await get1('SELECT id FROM users WHERE username=?', String((req.body || {}).username || ''));
    if (!target) return res.status(404).json({ error: 'utilisateur introuvable' });
    await insertIgnore('INSERT OR IGNORE INTO live_moderators(live_id,user_id,added_at) VALUES(?,?,?)', l.id, target.id, now());
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.delete('/api/lives/:id/moderators/:uid', auth, async (req, res) => {
  try {
    const l = await get1('SELECT * FROM lives WHERE id=?', req.params.id);
    if (!l || Number(l.user_id) !== Number(req.userId)) return res.status(403).json({ error: 'non autorisé' });
    await runSql('DELETE FROM live_moderators WHERE live_id=? AND user_id=?', l.id, req.params.uid);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.get('/api/lives/:id/moderators', async (req, res) => {
  try {
    const rows = await allRows(`SELECT u.id, u.username FROM live_moderators m JOIN users u ON u.id=m.user_id WHERE m.live_id=?`, req.params.id);
    res.json({ ok: true, moderators: rows });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// ---------- v2.33 : modération du live (hôte ou modérateurs) ----------
// Sourdine : l'utilisateur ne peut plus écrire dans le chat de ce live
app.post('/api/lives/:id/mute', auth, async (req, res) => {
  try {
    const l = await get1('SELECT * FROM lives WHERE id=?', req.params.id);
    if (!l) return res.status(404).json({ error: 'live introuvable' });
    if (!(await isLiveModerator(l, req.userId))) return res.status(403).json({ error: 'non autorisé' });
    const uid = Number((req.body || {}).user_id);
    if (!uid) return res.status(400).json({ error: 'user_id requis' });
    if (Number(l.user_id) === uid) return res.status(400).json({ error: 'on ne mute pas l\'hôte' });
    if (await isLiveModerator(l, uid)) return res.status(400).json({ error: 'on ne mute pas un modérateur' });
    await insertIgnore('INSERT OR IGNORE INTO live_bans(live_id,user_id,kind,created_at) VALUES(?,?,?,?)', l.id, uid, 'mute', now());
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.delete('/api/lives/:id/mute/:uid', auth, async (req, res) => {
  try {
    const l = await get1('SELECT * FROM lives WHERE id=?', req.params.id);
    if (!l) return res.status(404).json({ error: 'live introuvable' });
    if (!(await isLiveModerator(l, req.userId))) return res.status(403).json({ error: 'non autorisé' });
    await runSql("DELETE FROM live_bans WHERE live_id=? AND user_id=? AND kind='mute'", l.id, req.params.uid);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// Bannissement : banni du live, ne peut plus commenter
app.post('/api/lives/:id/ban', auth, async (req, res) => {
  try {
    const l = await get1('SELECT * FROM lives WHERE id=?', req.params.id);
    if (!l) return res.status(404).json({ error: 'live introuvable' });
    if (!(await isLiveModerator(l, req.userId))) return res.status(403).json({ error: 'non autorisé' });
    const uid = Number((req.body || {}).user_id);
    if (!uid) return res.status(400).json({ error: 'user_id requis' });
    if (Number(l.user_id) === uid) return res.status(400).json({ error: 'on ne bannit pas l\'hôte' });
    if (await isLiveModerator(l, uid)) return res.status(400).json({ error: 'on ne bannit pas un modérateur' });
    await insertIgnore('INSERT OR IGNORE INTO live_bans(live_id,user_id,kind,created_at) VALUES(?,?,?,?)', l.id, uid, 'ban', now());
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.delete('/api/lives/:id/ban/:uid', auth, async (req, res) => {
  try {
    const l = await get1('SELECT * FROM lives WHERE id=?', req.params.id);
    if (!l) return res.status(404).json({ error: 'live introuvable' });
    if (!(await isLiveModerator(l, req.userId))) return res.status(403).json({ error: 'non autorisé' });
    await runSql("DELETE FROM live_bans WHERE live_id=? AND user_id=? AND kind='ban'", l.id, req.params.uid);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// ---------- v2.33 : épinglage d'un message du chat live (hôte ou modérateurs) ----------
// Un seul message épinglé à la fois ; comment_id=0 (ou absent) → désépingle tout
app.post('/api/lives/:id/pin', auth, async (req, res) => {
  try {
    const l = await get1('SELECT * FROM lives WHERE id=?', req.params.id);
    if (!l) return res.status(404).json({ error: 'live introuvable' });
    if (!(await isLiveModerator(l, req.userId))) return res.status(403).json({ error: 'non autorisé' });
    const cid = Number((req.body || {}).comment_id) || 0;
    await runSql('UPDATE live_chat SET pinned=0 WHERE live_id=?', l.id);
    if (cid) {
      const c = await get1('SELECT id FROM live_chat WHERE id=? AND live_id=?', cid, l.id);
      if (!c) return res.status(404).json({ error: 'message introuvable' });
      await runSql('UPDATE live_chat SET pinned=1 WHERE id=?', cid);
    }
    res.json({ ok: true, pinned: cid });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});

// ---------- statut d'activité (en ligne) ----------
app.post('/api/me/heartbeat', auth, async (req, res) => {
  try { await runSql('UPDATE users SET last_seen=? WHERE id=?', now(), req.userId); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.get('/api/users/:username/online', async (req, res) => {
  try {
    const u = await get1('SELECT id, last_seen, activity_status FROM users WHERE username=?', req.params.username);
    if (!u) return res.status(404).json({ error: 'introuvable' });
    // v2.37 : 'friends' → seuls les amis (abonnements mutuels) voient le statut ;
    // 'nobody' → jamais visible ; last_seen > 120s → hors ligne
    const recent = (now() - Number(u.last_seen || 0)) < 120000;
    let online = false;
    if (recent) {
      const st = u.activity_status || 'public';
      if (st === 'nobody') online = false;
      else if (st === 'friends') {
        const meId = await optUserId(req);
        online = meId ? await areFriends(meId, u.id) : false;
      } else online = true; // 'public' (ou valeur inconnue → visible)
    }
    res.json({ ok: true, online });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});

// ---------- mode restreint ----------
// PARITÉ TIKTOK 2026-10-04 : code PIN requis pour désactiver (sans PIN, impossible de désactiver)
const pinHash = pin => crypto.createHash('sha256').update('vgpin:' + String(pin)).digest('hex');
app.get('/api/me/restricted', auth, async (req, res) => {
  try {
    const u = await get1('SELECT restricted_mode, restricted_pin FROM users WHERE id=?', req.userId);
    res.json({ ok: true, enabled: !!(u && Number(u.restricted_mode)), has_pin: !!(u && u.restricted_pin) });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.post('/api/me/restricted', auth, async (req, res) => {
  try {
    const b = req.body || {};
    const enabled = !!b.enabled;
    const u = await get1('SELECT restricted_pin FROM users WHERE id=?', req.userId);
    const hasPin = !!(u && u.restricted_pin);
    const pin = String(b.pin || '').trim();
    if (enabled) {
      // activation : définit le PIN s'il est fourni (4 à 6 chiffres) ; conserve l'ancien sinon
      if (pin) {
        if (!/^\d{4,6}$/.test(pin)) return res.status(400).json({ error: 'code PIN : 4 à 6 chiffres' });
        await runSql('UPDATE users SET restricted_mode=1, restricted_pin=? WHERE id=?', pinHash(pin), req.userId);
      } else {
        await runSql('UPDATE users SET restricted_mode=1 WHERE id=?', req.userId);
      }
      return res.json({ ok: true, enabled: true });
    }
    // désactivation : PIN obligatoire si un PIN est défini
    if (hasPin) {
      if (!pin) return res.status(403).json({ error: 'pin_required' });
      if (pinHash(pin) !== u.restricted_pin) return res.status(403).json({ error: 'pin_incorrect' });
    }
    await runSql('UPDATE users SET restricted_mode=0 WHERE id=?', req.userId);
    res.json({ ok: true, enabled: false });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});

// ---------- préférences de notifications ----------
app.get('/api/me/notif-prefs', auth, async (req, res) => {
  try {
    // v2.41 : expose aussi quiet_start/quiet_end (heures silencieuses), notif_priority (tri par priorité) et notif_newvideos (nouvelles vidéos des suivis)
    const u = await get1('SELECT notif_likes,notif_comments,notif_follows,notif_mentions,notif_lives,notif_loginalert,quiet_start,quiet_end,notif_priority,notif_newvideos FROM users WHERE id=?', req.userId);
    res.json({ ok: true, prefs: u || {} });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.post('/api/me/notif-prefs', auth, async (req, res) => {
  try {
    const b = req.body || {}, sets = [], vals = [];
    for (const k of ['notif_likes', 'notif_comments', 'notif_follows', 'notif_mentions', 'notif_lives', 'notif_loginalert', 'notif_newvideos']) {
      if (b[k] !== undefined) { sets.push(k + '=?'); vals.push(b[k] ? 1 : 0); }
    }
    // v2.41 : heures silencieuses — entier 0-23 ou null (null = désactivé)
    if (b.quiet_start !== undefined || b.quiet_end !== undefined) {
      const qv = v => v === null || v === '' || (Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) <= 23);
      if (!qv(b.quiet_start) || !qv(b.quiet_end)) return res.status(400).json({ error: 'quiet_start/quiet_end : 0-23 ou null' });
      const qn = v => (v === null || v === '' ? null : Number(v));
      sets.push('quiet_start=?'); vals.push(qn(b.quiet_start));
      sets.push('quiet_end=?'); vals.push(qn(b.quiet_end));
    }
    // v2.41 : tri des notifications par priorité de type (1) ou chronologique seul (0)
    if (b.notif_priority !== undefined) { sets.push('notif_priority=?'); vals.push(b.notif_priority ? 1 : 0); }
    if (sets.length) { vals.push(req.userId); await runSql(`UPDATE users SET ${sets.join(',')} WHERE id=?`, ...vals); }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});

// ---------- préférences de contenu (sujets + / -) ----------
app.get('/api/me/content-prefs', auth, async (req, res) => {
  try {
    const rows = await allRows('SELECT topic, pref FROM content_prefs WHERE user_id=?', req.userId);
    res.json({ ok: true, prefs: rows });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// v2.48 (SPEC-08) : préférences des rappels de rétention (opt-out / opt-in)
app.post('/api/me/nudges', auth, async (req, res) => {
  try {
    const b = req.body || {};
    if ('tz_offset' in b) {
      const tz = Math.max(-840, Math.min(840, parseInt(b.tz_offset, 10) || 0)); // ±14h en minutes
      await runSql('UPDATE users SET tz_offset=? WHERE id=?', tz, req.userId);
    }
    if ('optout' in b) await runSql('UPDATE users SET nudge_optout=? WHERE id=?', b.optout ? 1 : 0, req.userId);
    const u = await get1('SELECT nudge_optout, tz_offset FROM users WHERE id=?', req.userId);
    res.json({ ok: true, optout: !!Number(u && u.nudge_optout), tz_offset: Number((u && u.tz_offset) || 0) });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.delete('/api/me/content-prefs', auth, async (req, res) => {
  try {
    const topic = String((req.query.topic || (req.body || {}).topic || '')).trim().toLowerCase().slice(0, 50);
    if (topic) await runSql('DELETE FROM content_prefs WHERE user_id=? AND topic=?', req.userId, topic);
    else await runSql('DELETE FROM content_prefs WHERE user_id=?', req.userId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// Endpoints manquants détectés par le bot de test (2026-10-03)
app.get('/api/me/followers', auth, async (req, res) => {
  try {
    // PAGINATION 2026-10-04 : ?page=N (30/page)
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const rows = await allRows(
      'SELECT u.id, u.username, u.avatar FROM follows f JOIN users u ON u.id=f.follower_id WHERE f.followed_id=? ORDER BY f.created_at DESC LIMIT 30 OFFSET ' + ((page - 1) * 30),
      req.userId
    );
    res.json({ ok: true, followers: rows, page, has_more: rows.length >= 30 });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// Abonnés d'un autre utilisateur (public — les suivis restent privés)
app.get('/api/users/:username/followers', async (req, res) => {
  try {
    const u = await get1('SELECT * FROM users WHERE username=?', String(req.params.username).toLowerCase());
    if (!u) return res.status(404).json({ error: 'utilisateur introuvable' });
    const meId = await optUserId(req);
    if (meId && Number(meId) !== Number(u.id) && await isBlocked(meId, u.id))
      return res.status(403).json({ error: 'utilisateur bloqué' });
    // FIX 2026-10-04 (bot chain-security-private) : compte privé → liste d'abonnés masquée aux non-abonnés
    if (Number(u.is_private) && (!meId || Number(meId) !== Number(u.id))) {
      const _pf = await get1('SELECT 1 FROM follows WHERE follower_id=? AND followed_id=?', meId || -1, u.id);
      if (!_pf) return res.status(403).json({ error: 'compte privé' });
    }
    // PAGINATION 2026-10-04 : ?page=N (30/page)
    const fpage = Math.max(1, parseInt(req.query.page, 10) || 1);
    const rows = await allRows(
      'SELECT u.id, u.username, u.avatar FROM follows f JOIN users u ON u.id=f.follower_id WHERE f.followed_id=? ORDER BY f.created_at DESC LIMIT 30 OFFSET ' + ((fpage - 1) * 30),
      u.id
    );
    res.json({ ok: true, followers: rows, page: fpage, has_more: rows.length >= 30 });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.get('/api/me/stats', auth, async (req, res) => {
  try {
    const fr = await get1('SELECT COUNT(*) AS c FROM follows WHERE followed_id=?', req.userId);
    const vr = await get1('SELECT COALESCE(SUM(views),0) AS s FROM videos WHERE user_id=?', req.userId);
    // v2.48 (SPEC-06) : gains des ventes via mes vidéos (commissions non remboursées)
    let video_sales_earned = 0;
    try {
      const vs = await get1('SELECT COALESCE(SUM(coins),0) AS s FROM video_sale_commissions WHERE creator_id=? AND refunded=0', req.userId);
      video_sales_earned = Number((vs && vs.s) || 0);
    } catch (e) {}
    res.json({ ok: true, followers: Number(fr.c) || 0, totalViews: Number(vr.s) || 0, views: Number(vr.s) || 0,
      video_sales_earned, video_sales_label: 'Ventes via mes vidéos' });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// PARITÉ TIKTOK 2026-10-04 : analytics profil 7/28 jours, données réelles (jamais de fausses données)
app.get('/api/me/analytics', auth, async (req, res) => {
  try {
    const days = req.query.days === '28' ? 28 : 7;
    const dayMs = 86400000, t0 = now() - days * dayMs, perDay = [];
    let tViews = 0, tLikes = 0, tFollows = 0, tShares = 0;
    for (let d = 0; d < days; d++) {
      const a = t0 + d * dayMs, b = a + dayMs;
      const vw = (await get1(`SELECT COUNT(*) AS c FROM video_views vv JOIN videos v ON v.id=vv.video_id
        WHERE v.user_id=? AND vv.created_at>=? AND vv.created_at<?`, req.userId, a, b)).c || 0;
      const lk = (await get1(`SELECT COUNT(*) AS c FROM likes l JOIN videos v ON v.id=l.video_id
        WHERE v.user_id=? AND l.created_at>=? AND l.created_at<?`, req.userId, a, b)).c || 0;
      const fo = (await get1('SELECT COUNT(*) AS c FROM follows WHERE followed_id=? AND created_at>=? AND created_at<?',
        req.userId, a, b)).c || 0;
      tViews += vw; tLikes += lk; tFollows += fo;
      perDay.push({ day: new Date(a).toISOString().slice(0, 10), views: vw, likes: lk, new_followers: fo });
    }
    const sh = await get1('SELECT COALESCE(SUM(shares),0) AS s FROM videos WHERE user_id=?', req.userId);
    tShares = Number((sh && sh.s) || 0);
    const fr = await get1('SELECT COUNT(*) AS c FROM follows WHERE followed_id=?', req.userId);
    res.json({ ok: true, days, totals: { views: tViews, likes: tLikes, new_followers: tFollows, shares: tShares,
      followers: Number((fr && fr.c) || 0) }, per_day: perDay });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});

// ---------- VIGI : cerveau côté serveur ----------
// Base de connaissances du robot (français)
const BOT_KB = [
 {k:['piece','coin','gagner','argent','gagne'], r:"Pour gagner des pièces 🪙 : regarde des vidéos (+10 par vidéo), regarde une pub récompensée (+20), ou parraine un ami (+50 pour vous deux). Limite : 100 pièces par jour. Il faut un compte pour gagner.", action:null},
 {k:['retirer','retrait','withdraw','paypal','moncash','natcash'], r:"Tu peux retirer dès 1000 pièces (= 2 $). Va dans Portefeuille → \"Retirer mes $2\" et choisis PayPal, MonCash ou NatCash. Le retrait est traité sous 24-48h.", action:'goWallet'},
 {k:['parrain','code','ami','inviter'], r:"Pour parrainer : va dans Portefeuille → Parrainage, partage ton code. Quand ton ami entre ton code, vous recevez +50 pièces chacun ! 🎁", action:'goWallet'},
 {k:['compte','inscription','creer un compte','inscrire','connexion','connecter'], r:"Pour créer un compte : va dans \"Moi\" → \"Créer un compte\". Tu peux t'inscrire par téléphone (SMS), e-mail (code), ou Google. Il faut avoir 13 ans minimum.", action:null},
 {k:['mot de passe','mdp','password','oublie'], r:"Si tu as oublié ton mot de passe, utilise la connexion par e-mail : tu recevras un code de vérification pour te reconnecter, puis tu pourras définir un nouveau mot de passe dans les paramètres.", action:'goSettings'},
 {k:['publier','poster','upload','filmer'], r:"Pour publier : tape le bouton + en bas, choisis \"Filmer\" ou \"Choisir une vidéo\". Les vidéos font 10 minutes max, de préférence en vertical 9:16.", action:null},
 {k:['live','direct','streaming','passer en live'], r:"Pour passer en live : tape le bouton 🔴 LIVE en haut, puis \"Démarrer un live\". Tu peux faire un live solo ou avec jusqu'à 8 invités. Il faut un compte et une bonne connexion.", action:null},
 {k:['lent','lag','ram','charge pas','chargement','connexion lente','rame'], r:"Je peux essayer de régler la lenteur moi-même ! 🛠️", action:'clearCache', offer:true},
 {k:['serveur','connexion','injoignable','erreur reseau'], r:"Je vais retester la connexion au serveur. 📶", action:'retryConnection', offer:true},
 {k:['notification','notif','alerte'], r:"Pour les notifications : va dans Paramètres → Notifications. Tu peux activer/désactiver les alertes.", action:'goSettings'},
 {k:['supprimer','delete mon compte'], r:"Pour supprimer ton compte : Paramètres → Compte → \"Supprimer mes données\". Attention, c'est irréversible !", action:'goSettings'},
 {k:['photo','profil','avatar'], r:"Pour changer ta photo de profil : va dans \"Moi\" → tape sur ta photo → \"Choisir depuis la galerie\".", action:null},
 {k:['bio','biographie'], r:"Pour modifier ta bio : va dans \"Moi\" → \"Modifier ma bio\". Elle s'affiche instantanément.", action:null},
 {k:['pseudo','nom d\'utilisateur'], r:"Pour changer ton pseudo : va dans \"Moi\" → \"Choisir mon pseudo\" (lettres, chiffres, . _ — 2 à 24 caractères).", action:null},
 {k:['suivre','abonn','follow'], r:"Pour suivre un créateur : va sur son profil et tape \"Suivre\". Pour voir ses abonnés, tape sur son nombre d'Abonnés.", action:null},
 {k:['message','dm','discuter'], r:"Pour envoyer un message : va sur le profil de la personne et tape \"💬 Message\".", action:null},
 {k:['monetisation','gains createur','revenus'], r:"Les créateurs éligibles (1000 abonnés + 50 000 vues) reçoivent 50% des revenus pubs. Va dans Portefeuille → Monétisation.", action:'goWallet'},
 {k:['50/50','moitie'], r:"Le 50/50 : tu reçois la moitié des revenus publicitaires réels. Pas de gains fictifs ! ⚖️", action:null},
 {k:['langue','creole','francais'], r:"Pour changer de langue : Paramètres → Langue. 42 langues dont le créole haïtien ! 🇭🇹", action:'goSettings'},
 {k:['bonjour','salut','hello','bonsoir','coucou'], r:"Salut ! 👋 Je suis Vigi, l'assistant VidiGagne. Dis-moi ton problème et je vais t'aider. Tu peux aussi m'envoyer jusqu'à 3 captures d'écran avec 📷.", action:null},
 {k:['merci','thanks','genial','super'], r:"De rien, avec plaisir ! 😊 Autre chose ?", action:null},
 {k:['bug','erreur','probleme','casse','plante','bloque','marche pas'], r:"Désolé pour ce problème ! 😟 Décris-moi ce qui se passe exactement, et envoie-moi une capture d'écran avec 📷 — ça m'aidera beaucoup.", action:null, askShot:true},
 {k:['recommande','recommandation','conseil video','suggere','quoi regarder','suggestion video'], r:"Voici des vidéos tendance que je te recommande ! 🎬 Tape sur une carte pour la regarder.", action:'recommendVideos'},
 {k:['signaler','signalement','signale','denoncer'], r:"Je peux t'aider à signaler un contenu inapproprié. 🛡️ Choisis la vidéo à signaler ci-dessous :", action:'reportFlow'},
];
const VIGI_LANGS = {creole:'ht',haitien:'ht',ht:'ht',francais:'fr',french:'fr',fr:'fr',anglais:'en',english:'en',en:'en',espagnol:'es',spanish:'es',es:'es',portugais:'pt',pt:'pt',arabe:'ar',ar:'ar'};
function botBrainLangChange(t){
  // "mets en créole", "passe en français", "change la langue en anglais", "met l'app en espagnol"
  for (const kw of Object.keys(VIGI_LANGS)){
    if ((t.includes(' met ') || t.includes(' mets ') || t.includes(' passe ') || t.includes(' passer ') || t.includes(' change ')) && t.includes(' en ' + kw + ' ')) return VIGI_LANGS[kw];
    if (t.includes('langue ' + kw) || t.includes('en ' + kw + ' stp') || t.includes('en ' + kw + ' svp')) return VIGI_LANGS[kw];
  }
  return null;
}
function botBrain(text){
  const t = ' ' + text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'') + ' ';
  // v2.25 : réponses oui/non à une action proposée
  if (/^\s*(oui|yes|ok|d'accord|vas-y|fais-le)\s*[.!]?\s*$/.test(t.trim())) {
    return {r:"Parfait ! 👍 Je m'en occupe. Dis-moi si ça a réglé ton problème.", action:'confirmYes', offer:false};
  }
  if (/^\s*(non|no|pas|annule|stop)\s*[.!]?\s*$/.test(t.trim())) {
    return {r:"Pas de souci ! 👍 Dis-moi comment je peux t'aider autrement.", action:'confirmNo', offer:false};
  }
  // v2.37 : changement de langue via Vigi ("mets en créole", "passe en français")
  const langCode = botBrainLangChange(t);
  if (langCode) return {r:"C'est fait ! ✅ L'application est maintenant en " + langCode.toUpperCase() + ".", action:'setLang:' + langCode, offer:false};
  let best = null, bestScore = 0;
  for (const e of BOT_KB){
    let score = 0;
    for (const kw of e.k){
      const k = kw.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
      if (t.includes(k)) score += k.length;
    }
    if (score > bestScore){ bestScore = score; best = e; }
  }
  if (bestScore > 2) return best;
  return {r:"Hmm, je ne suis pas sûr de comprendre. 🤔 Peux-tu me donner plus de détails ? Et si tu as une capture d'écran, envoie-la moi avec 📷.", action:null, askShot:true};
}
// Chat avec Vigi — le cerveau est sur le serveur, internet requis
app.post('/api/bot/chat', auth, async (req, res) => {
  try {
    const text = String((req.body || {}).text || '').slice(0, 2000);
    if (!text) return res.status(400).json({ error: 'texte requis' });
    const result = botBrain(text);
    // Log pour suivi (v2.25 : syntaxe compatible Postgres)
    await runSql('CREATE TABLE IF NOT EXISTS bot_messages(id ' + (USE_PG ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT') + ', user_id INTEGER, text TEXT, reply TEXT, created_at BIGINT)').catch(()=>{});
    // Log pour suivi
    await runSql('CREATE TABLE IF NOT EXISTS bot_messages(id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, text TEXT, reply TEXT, created_at INTEGER)').catch(()=>{});
    await runSql('INSERT INTO bot_messages(user_id,text,reply,created_at) VALUES(?,?,?,?)',
      req.userId, text, result.r, now()).catch(()=>{});
    res.json({ ok: true, reply: result.r, action: result.action || null, offer: !!result.offer, askShot: !!result.askShot });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// Reçoit les captures d'écran du robot (max 3, stockées pour l'équipe)
app.post('/api/bot/screenshot', auth, async (req, res) => {
  try {
    const images = ((req.body || {}).images || []).slice(0, 3).map(s => String(s).slice(0, 500000));
    const text = String((req.body || {}).text || '').slice(0, 2000);
    if (!images.length) return res.status(400).json({ error: 'image requise' });
    await runSql('CREATE TABLE IF NOT EXISTS bot_screenshots(id ' + (USE_PG ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT') + ', user_id INTEGER, images TEXT, text TEXT, created_at BIGINT)').catch(()=>{});
    await runSql('CREATE TABLE IF NOT EXISTS bot_screenshots(id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, images TEXT, text TEXT, created_at INTEGER)').catch(()=>{});
    await runSql('INSERT INTO bot_screenshots(user_id,images,text,created_at) VALUES(?,?,?,?)',
      req.userId, JSON.stringify(images), text, now());
    res.json({ ok: true, received: images.length });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});

app.post('/api/me/content-prefs', auth, async (req, res) => {
  try {
    const topic = String((req.body || {}).topic || '').trim().toLowerCase().slice(0, 50);
    const pref = (req.body || {}).pref === 'less' ? 'less' : 'more';
    if (!topic) return res.status(400).json({ error: 'sujet requis' });
    // v2.48 (SPEC-07) : anti-injection — n'accepte que lettres/chiffres/espaces/tirets ;
    // la taxonomie INTERESTS sert aux suggestions de l'app, pas de rejet ici
    // (compatibilité : les bots acceptent tout sujet normalisé en minuscules).
    if (!/^[\p{L}\p{N} _-]{1,50}$/u.test(topic)) return res.status(400).json({ error: 'sujet invalide' });
    await insertIgnore('INSERT OR IGNORE INTO content_prefs(user_id,topic,pref,created_at) VALUES(?,?,?,?)', req.userId, topic, pref, now());
    await runSql('UPDATE content_prefs SET pref=? WHERE user_id=? AND topic=?', pref, req.userId, topic);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});

// ---------- pages dédiées : effets ----------
app.get('/api/effects', async (req, res) => {
  try {
    const rows = await allRows('SELECT * FROM effects ORDER BY use_count DESC LIMIT 50');
    res.json({ ok: true, effects: rows });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.get('/api/effects/:id/videos', async (req, res) => {
  try {
    const e = await get1('SELECT * FROM effects WHERE id=?', req.params.id);
    if (!e) return res.status(404).json({ error: 'effet introuvable' });
    const rows = await allRows('SELECT * FROM videos WHERE effect=? AND hidden=0 ORDER BY created_at DESC LIMIT 30', e.name);
    res.json({ ok: true, effect: e, videos: rows });
  } catch (e2) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.post('/api/effects', auth, async (req, res) => {
  try {
    const name = String((req.body || {}).name || '').trim().slice(0, 80);
    if (!name) return res.status(400).json({ error: 'nom requis' });
    const id = await insertId('INSERT INTO effects(name,icon_url,created_at) VALUES(?,?,?)', name, String((req.body || {}).icon_url || ''), now());
    res.json({ ok: true, id });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});

function effectJSON(e, meId, isFav, favCount) {
  return { id: e.id, name: e.name, icon: e.icon_url || '', category: e.category || '',
    css: e.css || '', use_count: Number(e.use_count) || 0,
    fav_count: favCount == null ? undefined : Number(favCount),
    is_fav: !!isFav, created_at: Number(e.created_at) };
}
app.get('/api/effects/search', async (req, res) => {
  try {
    const q = '%' + String(req.query.q || '').toLowerCase() + '%';
    const rows = await allRows('SELECT * FROM effects WHERE LOWER(name) LIKE ? OR LOWER(category) LIKE ? ORDER BY use_count DESC LIMIT 20', q, q);
    res.json({ ok: true, effects: rows.map(e => effectJSON(e)) });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.get('/api/effects/favs/mine', auth, async (req, res) => {
  try {
    const rows = await allRows('SELECT e.* FROM effect_favs f JOIN effects e ON e.id=f.effect_id WHERE f.user_id=? ORDER BY f.created_at DESC LIMIT 50', req.userId);
    res.json({ ok: true, effects: rows.map(e => effectJSON(e, req.userId, true)) });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.get('/api/effects/:id', async (req, res) => {
  try {
    const e = await get1('SELECT * FROM effects WHERE id=?', req.params.id);
    if (!e) return res.status(404).json({ error: 'effet introuvable' });
    const meId = await optUserId(req);
    const fav = meId ? await get1('SELECT 1 FROM effect_favs WHERE user_id=? AND effect_id=?', meId, e.id) : null;
    const fc = await get1('SELECT COUNT(*) AS c FROM effect_favs WHERE effect_id=?', e.id);
    const rows = await allRows('SELECT * FROM videos WHERE effect=? AND hidden=0 ORDER BY created_at DESC LIMIT 30', e.name);
    const videos = [];
    for (const v of rows) { if (await canSeeVideo(v, meId)) { const j = await videoJSON(v, meId); if (j) videos.push(j); } }
    res.json({ ok: true, effect: effectJSON(e, meId, !!fav, Number(fc.c)), videos });
  } catch (e2) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.post('/api/effects/:id/use', async (req, res) => {
  try {
    const e = await get1('SELECT id FROM effects WHERE id=?', req.params.id);
    if (!e) return res.status(404).json({ error: 'effet introuvable' });
    await runSql('UPDATE effects SET use_count=use_count+1 WHERE id=?', e.id);
    res.json({ ok: true });
  } catch (e2) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.post('/api/effects/:id/fav', auth, async (req, res) => {
  try {
    const e = await get1('SELECT id FROM effects WHERE id=?', req.params.id);
    if (!e) return res.status(404).json({ error: 'effet introuvable' });
    await insertIgnore('INSERT OR IGNORE INTO effect_favs(user_id,effect_id,created_at) VALUES(?,?,?)', req.userId, e.id, now());
    res.json({ ok: true });
  } catch (e2) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.delete('/api/effects/:id/fav', auth, async (req, res) => {
  try {
    await runSql('DELETE FROM effect_favs WHERE user_id=? AND effect_id=?', req.userId, req.params.id);
    res.json({ ok: true });
  } catch (e2) { res.status(500).json({ error: 'erreur serveur' }); }
});

// catalogue d'effets maison (100% hors-ligne : filtres CSS appliqués côté app)
const EFFECT_CATALOG = [
  ['Éclat doré','✨','Beauté','saturate(1.35) contrast(1.03) brightness(1.09)'],
  ['Peau douce','🧴','Beauté','blur(0.6px) brightness(1.08) saturate(1.15)'],
  ['Glow','💫','Beauté','brightness(1.14) saturate(1.3) contrast(0.96)'],
  ['Teint frais','🌸','Beauté','sepia(0.18) saturate(1.45) brightness(1.06)'],
  ['N&B cinéma','🎬','Couleur','grayscale(1) contrast(1.12) brightness(1.02)'],
  ['Sépia rétro','📼','Couleur','sepia(0.85) contrast(0.95) brightness(0.98)'],
  ['Vif','🔥','Couleur','saturate(1.9) contrast(1.12)'],
  ['Pastel','🍬','Couleur','saturate(0.75) brightness(1.12) contrast(0.92)'],
  ['Froid polaire','❄️','Couleur','saturate(1.2) hue-rotate(18deg) brightness(1.03)'],
  ['Chaud désert','🏜️','Couleur','sepia(0.45) saturate(1.7) brightness(1.02)'],
  ['Nuit néon','🌃','Ambiance','saturate(1.6) contrast(1.25) brightness(0.92) hue-rotate(-12deg)'],
  ['Golden hour','🌅','Ambiance','sepia(0.35) saturate(1.6) contrast(1.05) brightness(1.05)'],
  ['Rêve flou','☁️','Ambiance','blur(1.2px) brightness(1.12) saturate(1.1)'],
  ['Vintage 70s','🕺','Ambiance','sepia(0.55) contrast(1.1) saturate(1.25) brightness(0.97)'],
  ['Cyberpunk','🤖','Ambiance','hue-rotate(140deg) saturate(1.8) contrast(1.15)'],
  ['Noir profond','🌑','Ambiance','grayscale(0.9) brightness(0.82) contrast(1.2)'],
  ['Miroir','🪞','Fun','saturate(1.4) contrast(1.1)'],
  ['Pop art','🎨','Fun','saturate(2.2) contrast(1.35)'],
  ['Inversé','🔄','Fun','invert(1) hue-rotate(180deg)'],
  ['Douceur lait','🥛','Fun','brightness(1.2) saturate(0.85) contrast(0.9)'],
];
async function seedEffects() {
  try {
    const c = await get1('SELECT COUNT(*) AS n FROM effects');
    if (c && Number(c.n) > 0) return;
    for (const [name, icon, cat, css] of EFFECT_CATALOG) {
      await runSql('INSERT INTO effects(name,icon_url,category,css,created_at) VALUES(?,?,?,?,?)',
        name, icon, cat, css, now());
    }
    console.log('effets catalogue seedés:', EFFECT_CATALOG.length);
  } catch (e) { console.log('seed effets ignoré:', e.message); }
}

// ---------- pages dédiées : lieux ----------
app.get('/api/places/:name/videos', async (req, res) => {
  try {
    const rows = await allRows('SELECT * FROM videos WHERE location=? AND hidden=0 ORDER BY created_at DESC LIMIT 30', req.params.name);
    res.json({ ok: true, videos: rows });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});

// ---------- mentions : notifie les @mentionnés dans un commentaire ----------
async function notifyMentions(text, actorId, videoId, commentId) {
  try {
    const mentions = String(text || '').match(/@([a-zA-Z0-9._]{2,20})/g) || [];
    const seen = new Set();
    for (const m of mentions.slice(0, 5)) {
      const uname = m.slice(1).toLowerCase();
      if (seen.has(uname)) continue; seen.add(uname);
      const u = await get1('SELECT id, mention_privacy FROM users WHERE LOWER(username)=?', uname);
      if (u && Number(u.id) !== Number(actorId)) {
        // v2.39 : application du réglage mention_privacy du mentionné (everyone/friends/nobody) —
        // on bloque SEULEMENT la notification, le commentaire reste publié.
        const mpol = (u.mention_privacy || 'everyone');
        if (mpol === 'nobody') continue;
        if (mpol === 'friends' && !(await areFriends(actorId, u.id))) continue;
        // v2.31 : texte = le commentaire lui-même (l'app compose "@acteur vous a mentionné"), + comment_id
        await notify(u.id, 'mention', actorId, videoId, String(text || '').slice(0, 100), commentId || null);
      }
    }
  } catch (_) {}
}

// ---------- v2.44-EQC-WH : webhooks créateurs pro + API publique développeurs + badges/embeds ----------
const WH_EVENTS = ['follower.new', 'tip.new', 'gift.new'];
// URL webhook : https obligatoire ; exception dev : http://localhost et http://127.0.0.1 (tests)
function whUrlOk(url) {
  try {
    const u = new URL(String(url));
    if (u.protocol === 'https:') return true;
    if (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')) return true;
    return false;
  } catch (_) { return false; }
}
// Envoi fire-and-forget : ne fait JAMAIS échouer la requête principale.
// Signature : HMAC-SHA256(secret, corps JSON brut) dans X-VG-Signature.
async function fireWebhooks(userId, event, payload) {
  try {
    const hooks = await allRows('SELECT id, url, events, secret FROM creator_webhooks WHERE user_id=? AND active=1', userId);
    for (const h of hooks) {
      let evs = []; try { evs = JSON.parse(h.events || '[]'); } catch (_) {}
      if (!Array.isArray(evs) || !evs.includes(event)) continue;
      const body = JSON.stringify({ event, payload, at: Date.now() });
      const sig = crypto.createHmac('sha256', h.secret || '').update(body).digest('hex');
      const did = crypto.randomUUID();
      const t = now();
      try {
        const ctl = new AbortController();
        const to = setTimeout(() => ctl.abort(), 5000); // timeout 5 s
        const r = await fetch(h.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-VG-Event': event, 'X-VG-Signature': sig, 'X-VG-Delivery': did },
          body, signal: ctl.signal
        });
        clearTimeout(to);
        await runSql('INSERT INTO webhook_deliveries(hook_id,event,payload,status,created_at) VALUES(?,?,?,?,?)',
          h.id, event, body.slice(0, 4000), r.ok ? 'sent' : 'failed:' + r.status, t);
      } catch (e2) {
        try { await runSql('INSERT INTO webhook_deliveries(hook_id,event,payload,status,created_at) VALUES(?,?,?,?,?)',
          h.id, event, body.slice(0, 4000), 'failed', t); } catch (_) {}
      }
    }
  } catch (_) {}
}
// --- webhooks : CRUD ---
app.post('/api/webhooks', auth, async (req, res) => {
  try {
    const { url, events } = req.body || {};
    if (!url || !whUrlOk(String(url))) return res.status(400).json({ error: 'url invalide (https requis)' });
    const evs = Array.isArray(events) ? events.filter(e => WH_EVENTS.includes(e)) : [];
    if (!evs.length) return res.status(400).json({ error: 'events invalide (' + WH_EVENTS.join(', ') + ')' });
    const secret = crypto.randomBytes(32).toString('hex');
    const id = await insertId('INSERT INTO creator_webhooks(user_id,url,events,secret,active,created_at) VALUES(?,?,?,?,1,?)',
      req.userId, String(url).slice(0, 500), JSON.stringify(evs), secret, now());
    res.json({ id, secret }); // secret montré une seule fois
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.get('/api/webhooks', auth, async (req, res) => {
  try {
    const rows = await allRows('SELECT id, url, events, active, created_at FROM creator_webhooks WHERE user_id=? ORDER BY created_at DESC', req.userId);
    res.json({ webhooks: rows }); // secrets jamais renvoyés
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.delete('/api/webhooks/:id', auth, async (req, res) => {
  try {
    const h = await get1('SELECT id, user_id FROM creator_webhooks WHERE id=?', req.params.id);
    if (!h) return res.status(404).json({ error: 'webhook introuvable' });
    if (Number(h.user_id) !== Number(req.userId)) return res.status(403).json({ error: 'non autorisé' });
    await runSql('DELETE FROM creator_webhooks WHERE id=?', h.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// --- clés API développeurs ---
const _pubRate = new Map(); // rate-limit simple : 100 requêtes / 15 min par clé
function pubRateLimited(k) {
  const t = Date.now(); let a = _pubRate.get(k) || [];
  a = a.filter(x => t - x < 15 * 60 * 1000);
  if (a.length >= 100) return true;
  a.push(t); _pubRate.set(k, a);
  if (_pubRate.size > 5000) _pubRate.clear();
  return false;
}
async function apiKeyAuth(req, res, next) {
  try {
    const k = String(req.headers['x-api-key'] || '');
    if (!k) return res.status(401).json({ error: 'clé API requise (header X-API-Key)' });
    const row = await get1('SELECT id, user_id FROM api_keys WHERE api_key=?', k);
    if (!row) return res.status(401).json({ error: 'clé API invalide' });
    if (pubRateLimited(k)) return res.status(429).json({ error: 'limite dépassée (100 requêtes / 15 min)' });
    req.apiKeyId = row.id; req.apiUserId = row.user_id;
    runSql('UPDATE api_keys SET last_used=? WHERE id=?', now(), row.id).catch(() => {});
    next();
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
}
app.post('/api/developer/keys', auth, async (req, res) => {
  try {
    const name = String((req.body || {}).name || '').slice(0, 60);
    const key = 'vg_live_' + crypto.randomBytes(16).toString('hex');
    const id = await insertId('INSERT INTO api_keys(user_id,api_key,name,scopes,created_at) VALUES(?,?,?,?,?)',
      req.userId, key, name, 'read', now());
    res.json({ id, key });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.get('/api/developer/keys', auth, async (req, res) => {
  try {
    const rows = await allRows('SELECT id, name, scopes, created_at, last_used, api_key FROM api_keys WHERE user_id=? ORDER BY created_at DESC', req.userId);
    res.json({ keys: rows.map(r => ({ id: r.id, name: r.name, scopes: r.scopes, created_at: r.created_at,
      last_used: r.last_used, key_preview: '••••' + String(r.api_key).slice(-4) })) });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.delete('/api/developer/keys/:id', auth, async (req, res) => {
  try {
    const k = await get1('SELECT id, user_id FROM api_keys WHERE id=?', req.params.id);
    if (!k) return res.status(404).json({ error: 'clé introuvable' });
    if (Number(k.user_id) !== Number(req.userId)) return res.status(403).json({ error: 'non autorisé' });
    await runSql('DELETE FROM api_keys WHERE id=?', k.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// --- namespace public v1 (auth par X-API-Key) ---
app.get('/api/public/v1/users/:username', apiKeyAuth, async (req, res) => {
  try {
    const u = await get1('SELECT id, username, bio, avatar, verified FROM users WHERE username=?', String(req.params.username).toLowerCase());
    if (!u) return res.status(404).json({ error: 'utilisateur introuvable' });
    const f = await get1('SELECT COUNT(*) AS c FROM follows WHERE followed_id=?', u.id);
    res.json({ username: u.username, bio: u.bio, avatar: u.avatar, verified: Number(u.verified) === 1,
      followers_count: Number(f.c) || 0 });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.get('/api/public/v1/videos/:id', apiKeyAuth, async (req, res) => {
  try {
    const v = await get1(`SELECT v.id, v.description, v.views, v.created_at, v.duration, u.username FROM videos v
      JOIN users u ON u.id=v.user_id WHERE v.id=? AND v.hidden=0 AND v.is_private=0`, req.params.id);
    if (!v) return res.status(404).json({ error: 'vidéo introuvable' });
    const lk = await get1('SELECT COUNT(*) AS c FROM likes WHERE video_id=?', v.id);
    res.json({ id: v.id, username: v.username, description: v.description, views: Number(v.views) || 0,
      likes: Number(lk.c) || 0, duration: Number(v.duration) || 0, created_at: Number(v.created_at) });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.get('/api/public/v1/trending', apiKeyAuth, async (req, res) => {
  try {
    const rows = await allRows(`SELECT v.id, v.description, v.views, v.created_at, u.username FROM videos v
      JOIN users u ON u.id=v.user_id WHERE v.hidden=0 AND v.is_private=0
      AND (v.visibility='public' OR v.visibility='' OR v.visibility IS NULL)
      ORDER BY v.views DESC LIMIT 20`, []);
    res.json({ videos: rows.map(v => ({ id: v.id, username: v.username, description: v.description,
      views: Number(v.views) || 0, created_at: Number(v.created_at) })) });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// --- page développeurs ---
app.get('/developers', (req, res) => {
  res.type('html').send(`<!DOCTYPE html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>VidiGagne — API Développeurs</title>
<style>body{font-family:system-ui,sans-serif;background:#0d0d0f;color:#eee;margin:0;padding:24px;max-width:860px}
h1{color:#f5c542}h2{color:#f5c542;margin-top:32px}code{background:#1c1c20;padding:2px 6px;border-radius:4px;color:#ffd75e}
pre{background:#1c1c20;padding:14px;border-radius:8px;overflow-x:auto;color:#cfe3ff}a{color:#f5c542}
table{border-collapse:collapse;width:100%}td,th{border:1px solid #333;padding:8px;text-align:left}th{background:#1c1c20}
.note{background:#1a1405;border:1px solid #f5c542;border-radius:8px;padding:12px;margin:16px 0}</style>
</head><body>
<h1>🎬 VidiGagne — API Développeurs</h1>
<p>API publique en lecture seule pour intégrer les profils, vidéos et tendances VidiGagne dans vos applications.</p>
<h2>1. Créer une clé API</h2>
<p>Connectez-vous à VidiGagne, puis :</p>
<pre>curl -X POST https://vidigagne-server-production.up.railway.app/api/developer/keys \\
  -H "Authorization: Bearer VOTRE_JETON" \\
  -H "Content-Type: application/json" \\
  -d '{"name":"mon-app"}'
# → {"id":1,"key":"vg_live_..."} — copiez la clé, elle n'est montrée qu'une fois.</pre>
<h2>2. Endpoints</h2>
<table><tr><th>Méthode</th><th>Endpoint</th><th>Description</th></tr>
<tr><td>GET</td><td><code>/api/public/v1/users/:username</code></td><td>Profil public : username, bio, avatar, verified, followers_count</td></tr>
<tr><td>GET</td><td><code>/api/public/v1/videos/:id</code></td><td>Métadonnées publiques d'une vidéo : description, views, likes, duration</td></tr>
<tr><td>GET</td><td><code>/api/public/v1/trending</code></td><td>Top 20 des vidéos publiques par vues</td></tr></table>
<h2>3. Exemple</h2>
<pre>curl https://vidigagne-server-production.up.railway.app/api/public/v1/users/kewin \\
  -H "X-API-Key: vg_live_VOTRE_CLE"</pre>
<h2>4. Authentification &amp; limites</h2>
<ul><li>Header <code>X-API-Key</code> requis sur chaque appel ; 401 si absent ou invalide.</li>
<li>Rate-limit : <b>100 requêtes / 15 minutes par clé</b> (429 au-delà).</li>
<li>Scope actuel : <code>read</code> (lecture seule).</li></ul>
<h2>5. Webhooks créateurs pro</h2>
<p>Recevez les événements en temps réel sur votre serveur :</p>
<pre>curl -X POST https://vidigagne-server-production.up.railway.app/api/webhooks \\
  -H "Authorization: Bearer VOTRE_JETON" \\
  -H "Content-Type: application/json" \\
  -d '{"url":"https://mon-site.com/vg-hook","events":["follower.new","tip.new","gift.new"]}'
# → {"id":1,"secret":"..."} — le secret n'est montré qu'une fois.</pre>
<table><tr><th>Événement</th><th>Déclenché quand</th><th>Payload</th></tr>
<tr><td><code>follower.new</code></td><td>un nouvel abonné</td><td>follower_username, followed_username, at</td></tr>
<tr><td><code>tip.new</code></td><td>un pourboire reçu</td><td>from, coins, video_id, at</td></tr>
<tr><td><code>gift.new</code></td><td>un cadeau reçu</td><td>from, gift, coins, video_id, at</td></tr></table>
<div class="note"><b>Signature :</b> chaque appel porte <code>X-VG-Event</code>, <code>X-VG-Delivery</code> (uuid)
et <code>X-VG-Signature = HMAC-SHA256(secret, corps JSON brut)</code>. Vérifiez-la avant de traiter l'événement.
Envois en fire-and-forget (timeout 5 s) : un échec de votre serveur ne bloque jamais VidiGagne.</div>
<h2>6. Badges &amp; embeds</h2>
<ul><li><code>/badge/:username.svg</code> — badge SVG 200×48 à intégrer sur votre site.</li>
<li><code>/embed/:username</code> — carte profil HTML ; <code>/api/embed/:username</code> renvoie le code iframe.</li></ul>
</body></html>`);
});
// --- badges & embeds ---
function vgXmlEsc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
app.get('/badge/:username.svg', async (req, res) => {
  try {
    const u = await get1('SELECT id, username FROM users WHERE username=?', String(req.params.username).toLowerCase());
    if (!u) return res.status(404).type('image/svg+xml').send(
      '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="48"><rect width="200" height="48" rx="8" fill="#1a1a1a"/>' +
      '<text x="100" y="28" text-anchor="middle" fill="#888" font-family="sans-serif" font-size="12">utilisateur introuvable</text></svg>');
    const f = await get1('SELECT COUNT(*) AS c FROM follows WHERE followed_id=?', u.id);
    const n = Number(f.c) || 0;
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="48">' +
      '<rect width="200" height="48" rx="8" fill="#0d0d0f"/>' +
      '<rect x="0.5" y="0.5" width="199" height="47" rx="8" fill="none" stroke="#f5c542" stroke-width="1"/>' +
      '<polygon points="14,14 14,34 30,24" fill="#f5c542"/>' +
      '<text x="38" y="20" fill="#f5c542" font-family="sans-serif" font-size="11" font-weight="bold">Suivez-moi sur VidiGagne</text>' +
      '<text x="38" y="36" fill="#ccc" font-family="sans-serif" font-size="11">@' + vgXmlEsc(u.username) + ' · ' + n + ' abonnés</text></svg>';
    res.type('image/svg+xml').send(svg);
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.get('/api/embed/:username', async (req, res) => {
  try {
    const u = await get1('SELECT username FROM users WHERE username=?', String(req.params.username).toLowerCase());
    if (!u) return res.status(404).json({ error: 'utilisateur introuvable' });
    const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0];
    const host = req.get('host') || 'vidigagne-server-production.up.railway.app';
    res.json({ html: '<iframe src="' + proto + '://' + host + '/embed/' + vgXmlEsc(u.username) +
      '" width="300" height="120" frameborder="0" style="border-radius:12px" title="VidiGagne @' + vgXmlEsc(u.username) + '"></iframe>' });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.get('/embed/:username', async (req, res) => {
  try {
    // COIN-01 (2026-10-05) : la carte profil est FAITE pour être intégrée en iframe —
    // on retire le DENY global (et le frame-ancestors 'none' de la CSP) sur cette route uniquement.
    res.removeHeader('X-Frame-Options');
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: https:; media-src 'self' https:; style-src 'self' 'unsafe-inline'; frame-ancestors *");
    const u = await get1('SELECT id, username, avatar, bio FROM users WHERE username=?', String(req.params.username).toLowerCase());
    if (!u) return res.status(404).type('html').send('<!DOCTYPE html><html><body style="font-family:sans-serif">utilisateur introuvable</body></html>');
    const f = await get1('SELECT COUNT(*) AS c FROM follows WHERE followed_id=?', u.id);
    const n = Number(f.c) || 0;
    res.type('html').send('<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>@' + vgXmlEsc(u.username) + ' sur VidiGagne</title></head>' +
      '<body style="margin:0;font-family:system-ui,sans-serif;background:#0d0d0f;color:#eee;display:flex;align-items:center;justify-content:center;height:100vh">' +
      '<div style="text-align:center;background:#16161a;border:1px solid #f5c542;border-radius:14px;padding:16px 24px">' +
      '<div style="font-size:36px">' + vgXmlEsc(u.avatar || '🙂') + '</div>' +
      '<div style="font-weight:bold;font-size:16px">@' + vgXmlEsc(u.username) + '</div>' +
      '<div style="color:#aaa;font-size:12px;margin:4px 0 10px">' + n + ' abonnés · sur VidiGagne 🎬</div>' +
      '<a href="https://vidigagne.app/@' + vgXmlEsc(u.username) + '" style="display:inline-block;background:#f5c542;color:#111;font-weight:bold;' +
      'text-decoration:none;padding:8px 18px;border-radius:20px;font-size:14px">Suivre sur VidiGagne</a></div></body></html>');
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});

// ---------- téléchargement vidéo (si autorisé) ----------
app.get('/api/videos/:id/download-url', auth, async (req, res) => {
  try {
    const v = await get1('SELECT * FROM videos WHERE id=?', req.params.id);
    if (!v) return res.status(404).json({ error: 'vidéo introuvable' });
    // FIX sécu 2026-10-05 (confidentialité #2 CRITIQUE) : download-url ignorait la visibilité —
    // tout utilisateur authentifié pouvait télécharger la vidéo privée d'un autre.
    if (!(await canSeeVideo(v, req.userId))) return res.status(403).json({ error: 'vidéo non accessible' });
    if (!Number(v.allow_download)) return res.status(403).json({ error: 'téléchargement non autorisé' });
    // B1 : la colonne s'appelle `file` (pas `url`) → construire l'URL via fileUrl()
    res.json({ ok: true, url: fileUrl(v.file || '') });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});

// ==================== v2.49 : MISE À JOUR AUTO DE L'APP (sans Play Store) ====================
// L'app appelle /api/app/version au démarrage (1x/jour) et propose le téléchargement
// si versionCode > celui installé. L'APK est hébergée sur Cloudinary (URL stable).
const APP_VERSION_CODE = 253;
const APP_VERSION_NAME = '2.53';
const APP_CHANGELOG = "Paliers d'abonnement (3 niveaux, badge abonné), badge compte protégé 🛡️ (13-15 ans), live « Audio seul » + retrait d'invité, programmation des lives, login Facebook (quand configuré), page /download.";
async function appConfigGet(key) {
  try { const r = await get1('SELECT value FROM app_config WHERE key=?', key); return r ? r.value : ''; }
  catch (e) { return ''; }
}
app.get('/api/app/version', async (req, res) => {
  try {
    const apkUrl = (await appConfigGet('apk_url')) || process.env.APP_APK_URL || '';
    res.json({ ok: true, versionCode: APP_VERSION_CODE, versionName: APP_VERSION_NAME, apkUrl, changelog: APP_CHANGELOG, mandatory: false,
      withdrawals_paused: await withdrawalsPaused() });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// Upload d'une nouvelle APK (admin) → Cloudinary (raw) → URL stable enregistrée
const uploadApk = multer({ storage: multer.memoryStorage(), limits: { fileSize: 150 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/\.apk$/i.test(file.originalname || '') || file.mimetype === 'application/vnd.android.package-archive') cb(null, true);
    else cb(new Error('seuls les fichiers .apk sont acceptés'));
  },
});
app.post('/api/admin/app/apk', adminAuth, uploadApk.single('apk'), async (req, res) => {
  try {
    if (!USE_CLOUDINARY) return res.status(500).json({ error: 'Cloudinary non configuré' });
    if (!req.file) return res.status(400).json({ error: 'fichier APK requis (champ "apk")' });
    const up = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { resource_type: 'raw', public_id: 'vidigagne-apk/VidiGagne-v' + APP_VERSION_NAME, overwrite: true },
        (err, result) => err ? reject(err) : resolve(result));
      stream.end(req.file.buffer);
    });
    await runSql(`INSERT INTO app_config(key,value,updated_at) VALUES('apk_url',?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
      up.secure_url, now());
    res.json({ ok: true, apkUrl: up.secure_url, versionCode: APP_VERSION_CODE, versionName: APP_VERSION_NAME });
  } catch (e) { res.status(500).json({ error: 'échec du téléversement : ' + String((e && e.message) || e).slice(0, 150) }); }
});

// Enregistrer directement une URL d'APK déjà hébergée (admin) — ex. GitHub Release
// (fichiers >10 Mo refusés par Cloudinary gratuit). L'URL doit être https et finir en .apk.
app.post('/api/admin/app/apk-url', adminAuth, async (req, res) => {
  try {
    const url = String((req.body || {}).url || '').trim();
    if (!/^https:\/\//i.test(url) || !/\.apk(\?|$)/i.test(url))
      return res.status(400).json({ error: 'URL https vers un fichier .apk requise' });
    await runSql(`INSERT INTO app_config(key,value,updated_at) VALUES('apk_url',?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
      url, now());
    res.json({ ok: true, apkUrl: url, versionCode: APP_VERSION_CODE, versionName: APP_VERSION_NAME });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
// FIX 2026-10-04 (chantier edge) : les erreurs multer (mauvais type de fichier, fichier
// trop gros) tombaient sur le gestionnaire d'erreurs Express par défaut → page HTML 500
// avec stack trace. → erreur JSON propre (400/413) avec message clair.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const msg = String((err && err.message) || 'erreur serveur').slice(0, 200);
  const code = err && err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
  res.status(code).json({ error: msg });
});

initDb().then(() => {
  seedEffects().catch(()=>{});
  publishDue();
  setInterval(publishDue, 60000); // vérifie les publications dues toutes les 60 s
  expireSubs();
  setInterval(expireSubs, 86400000); // désactive les abonnements expirés toutes les 24 h
  renewSubs(); // SPEC-13 : renouvellement mensuel auto des abonnements
  setInterval(renewSubs, 86400000); // toutes les 24 h
  refreshTeenProtected(); // SPEC-14 : recalcule les comptes protégés (13-15 ans)
  setInterval(refreshTeenProtected, 86400000); // toutes les 24 h
  purgeOldLogs(); // FIX 2026-10-05 (audit DB) : purge des journaux techniques
  setInterval(purgeOldLogs, 86400000); // toutes les 24 h
  setInterval(runVerificationBot, 3600000); // 🤖 bot de vérification toutes les heures
  scheduleDailyCampaigns().catch(()=>{}); // campagnes notif du jour
  setInterval(()=>{scheduleDailyCampaigns().catch(()=>{})}, 3600000); // vérifie chaque heure
  setInterval(()=>{processNotifQueue().catch(()=>{})}, 600000); // traite la file toutes les 10 min
  // v2.48 (bots chaîne vague 3) : premieres (H-15 + bascule live) + rappels rétention
  updatePremieres().catch(()=>{});
  setInterval(()=>{updatePremieres().catch(()=>{})}, 60000);
  updateScheduledLives().catch(()=>{}); // FIX T6 2026-10-05 : notifie les lives programmés à l'heure
  setInterval(()=>{updateScheduledLives().catch(()=>{})}, 60000);
  scheduleNudges().catch(()=>{});
  setInterval(()=>{scheduleNudges().catch(()=>{})}, 3600000);
  setInterval(()=>{checkPremieres().catch(()=>{})}, 600000); // v2.48 SPEC-10 : rappels H-15 premieres
  setInterval(()=>{evaluateNudges().catch(()=>{})}, 86400000); // v2.48 SPEC-08 : évaluation quotidienne des nudges
  setTimeout(()=>{evaluateNudges().catch(()=>{}); checkPremieres().catch(()=>{});}, 120000); // + 2 min après démarrage
  runVerificationBot().catch(()=>{}); // + au démarrage
  const server = app.listen(PORT, () => console.log(
    `VidiGagne Server v2 sur http://localhost:${PORT} (db=${USE_PG ? 'postgres' : 'sqlite'}, storage=${USE_CLOUDINARY ? 'cloudinary' : 'local'})`));
  setupLiveWs(server); setupPushWs(server);
  // v2.42 FIX : UN SEUL routeur 'upgrade' — avant, chaque WebSocketServer({server, path})
  // attachait son propre listener et le 1er (live) répondait 400 aux upgrades du 2nd (push),
  // ce qui cassait COMPLÈTEMENT /api/push/ws (le push temps réel n'était jamais livré).
  server.on('upgrade', (req, socket, head) => {
    try {
      const pathname = String(req.url || '').split('?')[0];
      const wss = wsRoute[pathname];
      if (!wss) { socket.destroy(); return; }
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    } catch (_) { try { socket.destroy(); } catch (_) {} }
  });
}).catch(e => { console.error('Échec init DB:', e.message); process.exit(1); });
