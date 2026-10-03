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
  text TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  is_read INTEGER NOT NULL DEFAULT 0,
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
);`;
  if (USE_PG) { await pool.query(schema);
    for (const col of ["ALTER TABLE lives ADD COLUMN IF NOT EXISTS live_type TEXT NOT NULL DEFAULT 'guests'",
      "ALTER TABLE lives ADD COLUMN IF NOT EXISTS likes INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE lives ADD COLUMN IF NOT EXISTS shares INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE lives ADD COLUMN IF NOT EXISTS max_guests INTEGER NOT NULL DEFAULT 8",
      "ALTER TABLE lives ADD COLUMN IF NOT EXISTS duration_s INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE lives ADD COLUMN IF NOT EXISTS peak_viewers INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE lives ADD COLUMN IF NOT EXISTS gifts_total INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE lives ADD COLUMN IF NOT EXISTS chat_total INTEGER NOT NULL DEFAULT 0",
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
    try { lite.exec(`ALTER TABLE live_summaries ADD COLUMN exchanged_usd REAL NOT NULL DEFAULT 0`); } catch (e) {} }
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
    await pool.query(`ALTER TABLE videos ADD COLUMN IF NOT EXISTS phash TEXT DEFAULT ''`);
    await pool.query(`ALTER TABLE videos ADD COLUMN IF NOT EXISTS target_countries TEXT DEFAULT ''`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS country TEXT DEFAULT ''`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS fcm_token TEXT DEFAULT ''`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS campaign_notifs INTEGER DEFAULT 1`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS tz TEXT DEFAULT 'America/Port-au-Prince'`);
    await pool.query(`ALTER TABLE notifications ADD COLUMN IF NOT EXISTS title TEXT DEFAULT ''`);
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
      created_at BIGINT NOT NULL, starts_at BIGINT, ends_at BIGINT)`); // v1.60 : badges vérifiés demandables
// v1.63 : demande de badge vérifié — critères VidiGagne :
// artiste, marque, entreprise, créateur, personnalité... doit prouver son identité
// (pièce d'identité) + son activité (site web / marque représentée / liens).
const VERIF_CATEGORIES = ['artiste', 'marque', 'entreprise', 'createur', 'personnalite', 'media', 'autre'];
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
      await notify(r.user_id, 'system', null, null, '✔️ Ton compte est maintenant vérifié !');
    } else {
      await notify(r.user_id, 'system', null, null, 'Ta demande de badge vérifié a été refusée.');
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
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
    if (Number(live.broadcaster_id) !== Number(req.userId)) return res.status(403).json({ error: 'non autorisé' });
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
      const r = await get1(`SELECT COALESCE(SUM(cost),0) AS s FROM gift_events WHERE live_id=? AND created_at>=?`,
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
    const vids = await allRows(`SELECT id, description, views, likes, ad_impressions, ad_revenue_usd,
      monetized_views, demonetized, duration, created_at FROM videos
      WHERE user_id=? AND hidden=0 ORDER BY created_at DESC LIMIT 100`, req.userId);
    const vq = [];
    for (const v of vids) vq.push({ ...v, quality: await videoQualityScore(v) });
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
    if (!['offer', 'answer', 'candidate'].includes(kind)) return res.status(400).json({ error: 'kind invalide' });
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
// v1.62 : import en masse de musiques libres de droits (admin)
// Body: { tracks: [{title, artist, genre, url}] } — télécharge chaque MP3, l'envoie
// sur Cloudinary et l'insère dans la table sounds (user_id=0 = catalogue système).
app.post('/api/admin/sounds/bulk-import', async (req, res) => {
  const t = req.headers['x-admin-token'];
  if (!process.env.ADMIN_TOKEN || t !== process.env.ADMIN_TOKEN)
    return res.status(403).json({ error: 'non autorisé' });
  if (!USE_CLOUDINARY || !cloudinary)
    return res.status(500).json({ error: 'Cloudinary non configuré' });
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
    // v1.57 : messages vocaux
    for (const t of ['messages', 'group_messages']) {
      const mc = lite.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
      if (!mc.includes('audio_url')) lite.exec(`ALTER TABLE ${t} ADD COLUMN audio_url TEXT DEFAULT ''`);
    }
    // v1.58 : recherche par image (hash perceptuel)
    lite.exec(`CREATE TABLE IF NOT EXISTS verification_requests(
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'pending',
      reason TEXT NOT NULL DEFAULT '', created_at BIGINT NOT NULL, reviewed_at BIGINT)`);
    for (const col of ['full_name','category','website','proof_links','activity','id_doc_url']) {
      try { lite.exec(`ALTER TABLE verification_requests ADD COLUMN ${col} TEXT DEFAULT ''`); } catch (_) {}
    }
    lite.exec(`CREATE TABLE IF NOT EXISTS pk_battles(
      id INTEGER PRIMARY KEY AUTOINCREMENT, live_a_id INTEGER NOT NULL, live_b_id INTEGER NOT NULL,
      user_a_id INTEGER NOT NULL, user_b_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', score_a INTEGER NOT NULL DEFAULT 0,
      score_b INTEGER NOT NULL DEFAULT 0, winner_id INTEGER,
      created_at BIGINT NOT NULL, starts_at BIGINT, ends_at BIGINT)`);
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
  // serveur v13 : replay LIVE, TTS, commentaires audio, Q&A, collections partagées
  await mig('videos', 'is_replay', `INTEGER NOT NULL DEFAULT 0`);
  await mig('videos', 'live_id', `TEXT`);
  await mig('videos', 'tts_text', `TEXT`);
  await mig('videos', 'tts_voice', `TEXT`);
  await mig('videos', 'tts_rate', `REAL NOT NULL DEFAULT 1`);
  await mig('comments', 'audio_url', `TEXT`);
  await mig('qa_questions', 'asker_id', `INTEGER`);
  // v1.84 : fonctionnalités TikTok — historique recherche, épingles, duos/collages,
  // permissions vidéo, brouillons, demandes de messages, modérateurs live,
  // statut d'activité, mode restreint, préférences notifications, effets, lieux
  await mig('videos', 'duet_of', `INTEGER NOT NULL DEFAULT 0`);
  await mig('videos', 'stitch_of', `INTEGER NOT NULL DEFAULT 0`);
  await mig('videos', 'allow_duet', `INTEGER NOT NULL DEFAULT 1`);
  await mig('videos', 'allow_stitch', `INTEGER NOT NULL DEFAULT 1`);
  await mig('videos', 'allow_download', `INTEGER NOT NULL DEFAULT 1`);
  await mig('videos', 'allow_comments', `INTEGER NOT NULL DEFAULT 1`);
  await mig('videos', 'location', `TEXT NOT NULL DEFAULT ''`);
  await mig('videos', 'effect', `TEXT NOT NULL DEFAULT ''`);
  await mig('videos', 'is_private', `INTEGER NOT NULL DEFAULT 0`);
  await mig('videos', 'visibility', `TEXT NOT NULL DEFAULT 'public'`);
  await mig('users', 'last_seen', `BIGINT NOT NULL DEFAULT 0`);
  await mig('users', 'activity_status', `TEXT NOT NULL DEFAULT 'public'`);
  await mig('users', 'restricted_mode', `INTEGER NOT NULL DEFAULT 0`);
  await mig('users', 'notif_likes', `INTEGER NOT NULL DEFAULT 1`);
  await mig('users', 'notif_comments', `INTEGER NOT NULL DEFAULT 1`);
  await mig('users', 'notif_follows', `INTEGER NOT NULL DEFAULT 1`);
  await mig('users', 'notif_mentions', `INTEGER NOT NULL DEFAULT 1`);
  await mig('users', 'notif_lives', `INTEGER NOT NULL DEFAULT 1`);
  await mig('users', 'dm_privacy', `TEXT NOT NULL DEFAULT 'everyone'`);
  await mig('users', 'comment_privacy', `TEXT NOT NULL DEFAULT 'everyone'`);
  await mig('users', 'mention_privacy', `TEXT NOT NULL DEFAULT 'everyone'`);
  await mig('users', 'download_privacy', `TEXT NOT NULL DEFAULT 'everyone'`);
  await mig('users', 'liked_visibility', `TEXT NOT NULL DEFAULT 'me'`);
  await mig('users', 'following_visibility', `TEXT NOT NULL DEFAULT 'me'`);
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
    lite.exec(`CREATE TABLE IF NOT EXISTS content_prefs(
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, topic TEXT NOT NULL,
      pref TEXT NOT NULL DEFAULT 'more', created_at BIGINT NOT NULL,
      UNIQUE(user_id, topic))`);
    lite.exec(`CREATE TABLE IF NOT EXISTS effects(
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, icon_url TEXT NOT NULL DEFAULT '',
      use_count INTEGER NOT NULL DEFAULT 0, created_at BIGINT NOT NULL)`);
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
  await mig('videos', 'visibility', `TEXT NOT NULL DEFAULT 'public'`);
  await mig('lives', 'peak_viewers', `INTEGER NOT NULL DEFAULT 0`);
  await mig('lives', 'duration_s', `INTEGER NOT NULL DEFAULT 0`);
  await mig('lives', 'gifts_total', `INTEGER NOT NULL DEFAULT 0`);
  await mig('lives', 'chat_total', `INTEGER NOT NULL DEFAULT 0`);
  await mig('gifts', 'live_id', `INTEGER`);
  // serveur v11 (V3) : boutique, live shopping, publicité, modération auto
  await mig('users', 'seller_name', `TEXT NOT NULL DEFAULT ''`);
  await mig('users', 'seller_bio', `TEXT NOT NULL DEFAULT ''`);
  await mig('users', 'seller_verified', `INTEGER NOT NULL DEFAULT 0`);
  await mig('videos', 'review_status', `TEXT NOT NULL DEFAULT 'ok'`);
  await mig('comments', 'review_status', `TEXT NOT NULL DEFAULT 'ok'`);
  // serveur v12 : photos, filtres commentaires, séries payantes, algo, famille
  await mig('videos', 'media_type', `TEXT NOT NULL DEFAULT 'video'`);
  await mig('videos', 'photos', `TEXT NOT NULL DEFAULT '[]'`);
  await mig('videos', 'captions', `TEXT NOT NULL DEFAULT '[]'`);
  await mig('videos', 'series_id', `INTEGER`);
  await mig('users', 'comment_keywords', `TEXT NOT NULL DEFAULT '[]'`);
  try {
    if (USE_PG) await pool.query('CREATE INDEX IF NOT EXISTS watch_events_user_video_idx ON watch_events(user_id,video_id)');
    else lite.exec('CREATE INDEX IF NOT EXISTS watch_events_user_video_idx ON watch_events(user_id,video_id)');
  } catch (e) {}
  // serveur v13 : replays de lives, voix de synthèse TTS, "pourquoi cette vidéo"
  await mig('videos', 'is_replay', `INTEGER NOT NULL DEFAULT 0`);
  await mig('videos', 'live_id', `INTEGER`);
  await mig('videos', 'tts_text', `TEXT NOT NULL DEFAULT ''`);
  await mig('videos', 'tts_voice', `TEXT NOT NULL DEFAULT ''`);
  await mig('videos', 'tts_rate', `REAL NOT NULL DEFAULT 1`);
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
        await runSql('UPDATE users SET coins=coins+? WHERE id=?', coins, w.creator_id);
        await runSql('INSERT INTO ledger(user_id,amount,reason,created_at) VALUES(?,?,?,?)',
          w.creator_id, coins, 'revenu pub vidéo #' + w.video_id, now());
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
async function validCoins(userId) {
  const rows = await allRows(
    'SELECT amount, created_at FROM ledger WHERE user_id=? ORDER BY created_at ASC, id ASC', userId);
  const tnow = now();
  const queue = []; // crédits [montant, timestamp]
  for (const r of rows) {
    const amt = Number(r.amount) || 0;
    if (amt > 0) {
      queue.push([amt, Number(r.created_at) || 0]);
    } else if (amt < 0) {
      let need = -amt;
      while (need > 0 && queue.length) {
        const take = Math.min(queue[0][0], need);
        queue[0][0] -= take; need -= take;
        if (queue[0][0] <= 0) queue.shift();
      }
    }
  }
  // expire les crédits de 3 mois ou plus
  let valid = 0, expired = 0;
  for (const [amt, ts] of queue) {
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
  if (!r.id_doc_url || !/^https?:\/\//.test(r.id_doc_url)) fails.push('pièce d\u2019identité manquante ou illisible');
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
async function botReviewKyc(v) {
  const fails = [];
  if (!/^[A-Z]{2}$/.test(String(v.country || ''))) fails.push('pays invalide');
  if (!v.doc_front || !/^https?:\/\//.test(v.doc_front)) fails.push('photo du document manquante');
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
        await runSql(`UPDATE verification_requests SET status=?, reviewed_at=?, reviewed_by='bot', review_reason=? WHERE id=?`,
          verdict.approved ? 'approved' : 'rejected', now(), verdict.reason, r.id);
        if (verdict.approved) {
          await runSql('UPDATE users SET verified=1 WHERE id=?', r.user_id);
          await notify(r.user_id, 'system', null, null, '🤖✔️ Ton compte est maintenant vérifié !');
        } else {
          await notify(r.user_id, 'system', null, null, '🤖 ' + verdict.reason);
        }
      } catch (_) {}
    }
    // 2. KYC
    const kycs = await allRows(`SELECT * FROM id_verifications WHERE status='pending' LIMIT 50`);
    for (const v of kycs) {
      try {
        const verdict = await botReviewKyc(v);
        await runSql(`UPDATE id_verifications SET status=?, reviewed_at=?, reviewed_by='bot', review_reason=? WHERE id=?`,
          verdict.approved ? 'approved' : 'rejected', now(), verdict.reason, v.id);
        const u = await get1('SELECT username FROM users WHERE id=?', v.user_id);
        await notify(v.user_id, 'system', null, null,
          verdict.approved ? '🤖✔️ Ton identité est vérifiée — tu peux retirer tes gains !'
                           : '🤖 ' + verdict.reason);
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
app.set('trust proxy', 1); // m10 : derrière Render, req.ip = vraie IP cliente (pas de x-forwarded-for falsifiable)
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
async function notify(userId, type, actorId, videoId, text) {
  try {
    if (!userId || Number(userId) === Number(actorId)) return;
    // v1.84 : vérifie les préférences de notification du destinataire
    try {
      const prefs = await get1('SELECT notif_likes,notif_comments,notif_follows,notif_mentions,notif_lives FROM users WHERE id=?', userId);
      if (prefs) {
        const prefMap = { like: 'notif_likes', comment: 'notif_comments', follow: 'notif_follows', mention: 'notif_mentions', live: 'notif_lives' };
        const col = prefMap[type];
        if (col && Number(prefs[col]) === 0) return; // désactivé par l'utilisateur
      }
    } catch (_) {}
    const id = await insertId('INSERT INTO notifications(user_id,type,actor_id,video_id,text,is_read,created_at) VALUES(?,?,?,?,?,0,?)',
      userId, type, actorId || null, videoId || null, String(text || '').slice(0, 200), now());
    let actorName = '';
    try { if (actorId) { const a = await get1('SELECT username FROM users WHERE id=?', actorId); if (a) actorName = a.username; } } catch (_) {}
    // push instantané si le destinataire est connecté en WebSocket
    try {
      const ws = pushSockets.get(Number(userId));
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ t: 'push', id, type, text: String(text || '').slice(0, 200), actor: actorName }));
      }
    } catch (_) {}
    // v1.84 : tentative de push FCM (fonctionne même app fermée)
    try {
      const titles = { like: 'Nouveau J\u2019aime', comment: 'Nouveau commentaire', follow: 'Nouvel abonné',
        mention: 'Mention', live: 'En direct', repost: 'Repost', default: 'VidiGagne' };
      const title = (actorName ? actorName + ' — ' : '') + (titles[type] || titles.default);
      sendFcmPush(userId, title, String(text || '').slice(0, 200),
        { type, notif_id: String(id), actor: actorName }).catch(() => {});
    } catch (_) {}
  } catch (e) {}
}
function setupPushWs(server) {
  const { WebSocketServer } = require('ws');
  const wss = new WebSocketServer({ server, path: '/api/push/ws' });
  wss.on('connection', (ws) => {
    let uid = null;
    const hb = setInterval(() => { try { if (ws.readyState === 1) ws.ping(); } catch (_) {} }, 240000);
    ws.on('message', async (buf) => {
      let m; try { m = JSON.parse(buf.toString()); } catch (e) { return; }
      if (m.t === 'auth' && m.token) {
        const id = await userIdFromToken(m.token);
        if (!id) { try { ws.close(); } catch (_) {} return; }
        uid = Number(id);
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
  return {
    id: v.id, desc: v.description, tags: v.tags, sound: v.sound || '', duration: Number(v.duration) || 0,
    url: mediaUrl, visibility: v.visibility || 'public', subscribed,
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
    user: privUser(u),
  };
}
// parse les mots-clés de filtre de commentaires (v12)
function parseKeywords(s) {
  try {
    const a = JSON.parse(s || '[]');
    return Array.isArray(a) ? a.map(x => String(x).toLowerCase()).filter(x => x.length) : [];
  } catch (e) { return []; }
}

// ---------- auth ----------
app.post('/api/auth/register', async (req, res) => {
  try {
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
    const exists = await get1('SELECT 1 FROM users WHERE username=?', username);
    if (exists) return res.status(409).json({ error: 'ce pseudo est déjà pris' }); // unicité serveur (les pseudos sont publics par design, comme TikTok)
    if (email) {
      const eExists = await get1('SELECT 1 FROM users WHERE email=?', email);
      // v1.54 : message générique pour l'e-mail (anti-énumération de comptes)
      if (eExists) return res.status(409).json({ error: 'inscription impossible avec ces informations' });
    }
    const salt = crypto.randomBytes(16).toString('hex');
    const id = await insertId(
      'INSERT INTO users(username,name,first_name,last_name,birthdate,gender,email,pass_hash,pass_salt,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
      username, (name || username).slice(0, 40), first_name, last_name, birthdate, gender, email, hashPass(password, salt), salt, now());
    // code parrain unique
    let refCode = null;
    for (let i = 0; i < 20 && !refCode; i++) {
      const c = genRefCode();
      if (!(await get1('SELECT 1 FROM users WHERE ref_code=?', c))) refCode = c;
    }
    if (refCode) await runSql('UPDATE users SET ref_code=? WHERE id=?', refCode, id);
    const token = crypto.randomBytes(32).toString('hex');
    await runSql('INSERT INTO tokens(token,user_id,created_at) VALUES(?,?,?)', token, id, now());
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
      return res.json({ token: _token, user: privUser(_u), coins: _u.coins });
    }
    const ident = ((req.body || {}).username || (req.body || {}).identifier || (req.body || {}).email || '').toLowerCase().trim();
    if (loginRateLimited(clientIp(req), ident))
      return res.status(429).json({ error: 'trop de tentatives, réessaie dans 15 minutes' });
    const u = await get1('SELECT * FROM users WHERE username=? OR email=?', ident, ident);
    if (!u || hashPass(req.body.password || '', u.pass_salt) !== u.pass_hash)
      return res.status(401).json({ error: 'pseudo ou mot de passe incorrect' });
    const token = crypto.randomBytes(32).toString('hex');
    await runSql('INSERT INTO tokens(token,user_id,created_at) VALUES(?,?,?)', token, u.id, now());
    res.json({ token, user: privUser(u), coins: u.coins });
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
  const m = mailer();
  if (m) {
    try {
      await m.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: identifier,
        subject: 'Ton code VidiGagne : ' + code,
        text: 'Ton code de vérification VidiGagne est : ' + code + ' (expire dans 60 secondes).',
        html: '<div style="font-family:sans-serif;text-align:center;padding:30px"><div style="font-size:24px;font-weight:800">VidiGagne</div><p>Ton code de vérification :</p><div style="font-size:44px;font-weight:800;letter-spacing:10px">' + code + '</div><p style="color:#888">Ce code expire dans 60 secondes.</p></div>',
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
  const { name, avatar, bio, first_name, last_name, birthdate, gender, sub_enabled, sub_price, country } = req.body || {};
  const _gender = ['male', 'female', 'other'].includes(String(gender || '')) ? String(gender) : null;
  await runSql('UPDATE users SET name=COALESCE(?,name), avatar=COALESCE(?,avatar), bio=COALESCE(?,bio), first_name=COALESCE(?,first_name), last_name=COALESCE(?,last_name), birthdate=COALESCE(?,birthdate), gender=COALESCE(?,gender), country=COALESCE(?,country) WHERE id=?',
    name ? String(name).slice(0, 40) : null,
    avatar ? String(avatar).slice(0, 8) : null,
    bio ? String(bio).slice(0, 150) : null,
    first_name !== undefined ? String(first_name).trim().slice(0, 40) : null,
    last_name !== undefined ? String(last_name).trim().slice(0, 40) : null,
    /^\d{4}-\d{2}-\d{2}$/.test(birthdate || '') ? birthdate : null,
    _gender,
    /^[A-Z]{2}$/.test(String(country || '')) ? String(country) : null, req.userId);
  // abonnement payant au créateur : activation + prix mensuel (pièces)
  if (sub_enabled !== undefined || sub_price !== undefined) {
    const se = sub_enabled ? 1 : 0;
    const sp = Math.max(0, Math.min(100000, Math.floor(Number(sub_price) || 0)));
    await runSql('UPDATE users SET sub_enabled=?, sub_price=? WHERE id=?', se, sp, req.userId);
  }
  const u = await get1('SELECT * FROM users WHERE id=?', req.userId);
  res.json({ user: privUser(u) });
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

app.post('/api/videos', auth, upload.single('video'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'aucune vidéo reçue' });
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
    // visibilité : public | subscribers (abonnés payants) | private
    let visibility = String(b.visibility || 'public');
    if (visibility === 'subscribers_only') visibility = 'subscribers'; // valeur envoyée par l'app
    if (!['public', 'subscribers', 'private'].includes(visibility)) visibility = 'public';
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
    const _tc = Array.isArray(b.target_countries) ? b.target_countries.filter(x => /^[A-Z]{2}$/.test(String(x))).slice(0, 1) : [];
    const _tcJson = JSON.stringify(_tc);
    const id = await insertId(
      'INSERT INTO videos(user_id,file,description,tags,sound,duration,scheduled_at,visibility,captions,is_replay,live_id,tts_text,tts_voice,tts_rate,target_countries,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      req.userId, fname, descText, String(b.tags || '').slice(0, 300),
      String(b.sound || '').slice(0, 120), duration, scheduledAt, visibility, captions,
      isReplay, liveId, ttsText, ttsVoice, ttsRate, _tcJson, now());
    if (_bannedRemoved.length) {
      try { await notify(req.userId, 'system', null, null,
        '🤖 Hashtags supprimés : ' + _bannedRemoved.join(' ') + ' (plateformes concurrentes interdites)'); } catch (_) {}
    }
    // pièces : +10 par publication
    await runSql('UPDATE users SET coins=coins+10 WHERE id=?', req.userId);
    await runSql('INSERT INTO ledger(user_id,amount,reason,created_at) VALUES(?,?,?,?)',
      req.userId, 10, 'publication vidéo #' + id, now());
    // modération auto V3 : scan du texte (sans IA externe)
    const badW = scanBanned(descText + ' ' + String(b.tags || ''));
    if (badW) {
      await runSql(`UPDATE videos SET hidden=1, review_status='pending' WHERE id=?`, id);
      await flagForReview('video', id, 'mot interdit : ' + badW);
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
    res.json({ video: await videoJSON(v, req.userId), pending_review: !!badW });
  } catch (e) { res.status(500).json({ error: 'échec du téléversement' }); }
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
    }
    const v = await get1('SELECT * FROM videos WHERE id=?', id);
    res.json({ video: await videoJSON(v, req.userId), pending_review: !!badW });
  } catch (e) { res.status(500).json({ error: 'échec du téléversement' }); }
});

// ==================== PHASE 2 ====================
// ---------- stories (24 h) ----------
app.post('/api/stories', auth, uploadStory.fields([{ name: 'video', maxCount: 1 }, { name: 'image', maxCount: 1 }]), async (req, res) => {
  try {
    const file = (req.files && (req.files.video || req.files.image) || [])[0];
    if (!file) return res.status(400).json({ error: 'aucune vidéo/image reçue' });
    if (!(await checkQuota(req.userId, file.size || 0)))
      return res.status(413).json({ error: 'quota de stockage atteint (2 Go)' });
    const fname = await storeVideo(file);
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
    await notify(dest.id, 'gift', req.userId, video_id || null, g.id);
    const balG = await get1('SELECT coins FROM users WHERE id=?', req.userId);
    res.json({ ok: true, coins: balG ? balG.coins : 0 });
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
  const items = await allRows(
    'SELECT v.* FROM playlist_items pi JOIN videos v ON v.id=pi.video_id WHERE pi.playlist_id=? ORDER BY pi.pos', pl.id);
  const out = [];
  for (const v of items) { const j = await videoJSON(v, 0); if (j) out.push(j); }
  res.json({ playlist: pl, videos: out });
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
  const rows = await allRows('SELECT * FROM videos WHERE hidden=0 ORDER BY created_at DESC LIMIT 500');
  const out = [];
  for (const v of rows) {
    if (!(await canSeeVideo(v, meId))) continue;
    if (extractTags((v.description || '') + ' ' + (v.tags || '')).includes(tag)) { const j = await videoJSON(v, 0); if (j) out.push(j); }
  }
  res.json({ tag, videos: out.slice(0, 50) });
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
    await runSql('UPDATE comments SET pinned=0 WHERE video_id=?', c.video_id);
    await runSql('UPDATE comments SET pinned=1 WHERE id=?', c.id);
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
  res.json({
    videos: vids.length, views, likes: Number(lr.c), followers: Number(fr.c), coins: me.coins,
    watch_time_total: watchTime, watch_time: watchTime,
    avg_duration: views ? Math.round(watchTime / views) : 0,
    views_7d: views7, last7d: views7, likes_7d: likes7, new_followers_7d: followers7, new_followers7d: followers7,
    tips_total: Number(tipsR.s) || 0, tips: Number(tipsR.s) || 0,
    gifts_total: Number(giftsR.s) || 0, gifts: Number(giftsR.s) || 0,
    top: vids.sort((a, b) => b.views - a.views).slice(0, 5)
      .map(v => ({ id: v.id, desc: v.description, views: Number(v.views) })),
  });
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
    res.json({ user: u, videos, comments, stories, playlists, withdrawals, ledger, exported_at: now() });
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
    for (const vid of vIds) {
      await runSql('DELETE FROM likes WHERE video_id=?', vid);
      const cIds = (await allRows('SELECT id FROM comments WHERE video_id=?', vid)).map(r => r.id);
      for (const cid of cIds) await runSql('DELETE FROM comment_likes WHERE comment_id=?', cid);
      await runSql('DELETE FROM comments WHERE video_id=?', vid);
      await runSql('DELETE FROM playlist_items WHERE video_id=?', vid);
      await runSql('DELETE FROM videos WHERE id=?', vid);
    }
    await runSql('DELETE FROM stories WHERE user_id=?', uid);
    await runSql('DELETE FROM playlists WHERE user_id=?', uid);
    await runSql('DELETE FROM playlist_items WHERE playlist_id NOT IN (SELECT id FROM playlists)');
    await runSql('DELETE FROM comment_likes WHERE user_id=?', uid);
    await runSql('DELETE FROM comments WHERE user_id=?', uid);
    await runSql('DELETE FROM likes WHERE user_id=?', uid);
    await runSql('DELETE FROM follows WHERE follower_id=? OR followed_id=?', uid, uid);
    await runSql('DELETE FROM gifts WHERE from_id=? OR to_id=?', uid, uid);
    await runSql('DELETE FROM ledger WHERE user_id=?', uid);
    await runSql('DELETE FROM withdrawals WHERE user_id=?', uid);
    // m9 : nettoyage complet, pas de lignes orphelines
    await runSql('DELETE FROM video_views WHERE viewer_id=?', uid);
    await runSql('DELETE FROM watch_events WHERE user_id=?', uid);
    await runSql('DELETE FROM watch_history WHERE user_id=?', uid);
    await runSql('DELETE FROM watch_rewards WHERE user_id=?', uid);
    await runSql('DELETE FROM like_rewards WHERE liker_id=?', uid);
    await runSql('DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE user1_id=? OR user2_id=?)', uid, uid);
    await runSql('DELETE FROM conversations WHERE user1_id=? OR user2_id=?', uid, uid);
    await runSql('DELETE FROM notifications WHERE user_id=?', uid);
    await runSql('DELETE FROM series WHERE creator_id=?', uid);
    await runSql('DELETE FROM series_purchases WHERE user_id=?', uid);
    await runSql('DELETE FROM id_verifications WHERE user_id=?', uid);
    await runSql('DELETE FROM payment_methods WHERE user_id=?', uid);
    await runSql('DELETE FROM family_links WHERE parent_id=? OR teen_id=?', uid, uid);
    await runSql('DELETE FROM family_settings WHERE teen_id=?', uid);
    await runSql('UPDATE lives SET ended_at=? WHERE user_id=? AND ended_at IS NULL', now(), uid);
    await runSql('DELETE FROM tokens WHERE user_id=?', uid);
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
  await runSql(`UPDATE id_verifications SET status=?, reviewed_at=? WHERE id=?`,
    approve ? 'approved' : 'rejected', now(), req.params.id);
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
async function go(){T=document.getElementById('tk').value.trim();const r=await fetch('/api/kyc/pending',{headers:{'x-admin-token':T}});if(!r.ok){document.getElementById('err').textContent='Token invalide';return}document.getElementById('gate').style.display='none';document.getElementById('main').style.display='';load()}
async function load(){const r=await fetch('/api/kyc/pending',{headers:{'x-admin-token':T}});const d=await r.json();
const box=document.getElementById('list');
if(!d.pending.length){box.innerHTML='<p>Aucune demande en attente ✅</p>';return}
box.innerHTML=d.pending.map(p=>'<div class="card" id="k'+p.id+'"><div><b>@'+p.username+'</b> <span class="meta">'+p.name+' • '+p.country+' • '+p.doc_type+' • expire : '+(p.expiry||'?')+'</span></div>'
+'<div><img src="'+p.doc_front+'"></div>'+(p.doc_back?'<div><img src="'+p.doc_back+'"></div>':'')
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
// ---------- retraits v2 : moyen enregistré + reçu ----------
app.post('/api/withdraw', auth, async (req, res) => {
  try {
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
    const vc = await validCoins(req.userId);
    if (vc.expired > 0 && n > vc.valid)
      return res.status(400).json({ error: '🤖 ' + vc.expired + ' de tes pièces ont expiré (3 mois ou plus). Seules ' + vc.valid + ' pièces sont retirables.' });
    if (n > vc.valid)
      return res.status(400).json({ error: 'pas assez de pièces valides (' + vc.valid + ' disponibles)' });
    const usd = Math.floor(n / 500 * 100) / 100;
    // débit atomique anti double-retrait (race condition)
    const debited = await runSqlChanges('UPDATE users SET coins=coins-? WHERE id=? AND coins>=?', n, req.userId, n);
    if (!debited) return res.status(400).json({ error: 'pas assez de pièces' });
    await runSql('INSERT INTO ledger(user_id,amount,reason,created_at) VALUES(?,?,?,?)',
      req.userId, -n, 'retrait ' + pm.type, now());
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
    await runSql('UPDATE users SET referred_by=? WHERE id=? AND referred_by IS NULL', parrain.id, req.userId);
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
    const cfg = paypalCfg();
    const token = cfg ? await paypalToken() : null;
    if (!token || !rc.paypal_order_id) return res.status(500).send('Paiement indisponible');
    const cr = await fetch(cfg.api + '/v2/checkout/orders/' + encodeURIComponent(rc.paypal_order_id) + '/capture', {
      method: 'POST', headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' }, body: '{}'
    });
    const cd = await cr.json().catch(() => ({}));
    const captured = cd.status === 'COMPLETED' || (cd.purchase_units || []).some(p => (p.payments || {}).captures);
    if (!captured) {
      await runSql("UPDATE coin_recharges SET status='failed' WHERE id=?", rid);
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
  const r = await get1('SELECT * FROM receipts WHERE id=? AND user_id=?', req.params.id, req.userId);
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
  const followers = Number(fol.c), views = Number(vw.s);
  const kycStatus = kyc ? kyc.status : 'none';
  return {
    eligible: followers >= 1000 && views >= 50000 && kycStatus === 'approved',
    followers, views, ad_views: Number(avw.s), kyc: kycStatus,
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
      total_earned_usd: Math.floor(Number(er.s) * 100) / 100,
      total_earned_coins: Number(er.c),
    });
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
  const wss = new WebSocketServer({ server, path: '/api/live/ws' });
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
      const room = liveRooms[liveId];
      if (!room) return;
      if (m.t === 'join') {
        peerId = 'v' + Math.random().toString(36).slice(2, 9);
        room.viewers.set(ws, peerId); role = 'viewer';
        if (room.broadcaster && room.broadcaster.readyState === 1)
          room.broadcaster.send(JSON.stringify({ t: 'viewer', id: peerId }));
        liveBroadcastViewers(liveId);
        return;
      }
      if (m.t === 'chat') {
        const uid = await userIdFromToken(m.token);
        const text = String(m.text || '').slice(0, 200);
        if (!uid || !text) return;
        const u = await get1('SELECT username FROM users WHERE id=?', uid);
        const payload = JSON.stringify({ t: 'chat', user: u ? u.username : '?', text });
        if (room.broadcaster && room.broadcaster.readyState === 1) room.broadcaster.send(payload);
        room.viewers.forEach((pid, w) => { if (w !== ws && w.readyState === 1) w.send(payload); });
        if (ws.readyState === 1) ws.send(payload);
        return;
      }
      if (m.t === 'gift') {
        // comme le chat : le cadeau doit venir d'un token valide, et le nom
        // d'expéditeur vient du serveur (pas du client)
        const uid = await userIdFromToken(m.token);
        if (!uid) return;
        const u = await get1('SELECT username FROM users WHERE id=?', uid);
        const payload = JSON.stringify({ t: 'gift', gift: String(m.gift || '').slice(0, 40), from: u ? u.username : '?' });
        if (room.broadcaster && room.broadcaster.readyState === 1) room.broadcaster.send(payload);
        room.viewers.forEach((pid, w) => { if (w.readyState === 1) w.send(payload); });
        return;
      }
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
    const score = 0.35 * affC
      + 0.25 * affTags
      + 0.25 * likeRate
      + 0.15 * recency
      + countryBoost
      + prefBoost
      + followBoost
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
    let rows;
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
      sql += ' ORDER BY v.created_at DESC LIMIT 50';
      rows = await allRows(sql, ...params);
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
      if (meId) {
        // v12 : utilisateurs connectés → score personnalisé « Pour toi »
        sql += ' ORDER BY created_at DESC LIMIT 200';
        rows = await scoreForYou(await allRows(sql, ...params), meId);
      } else {
        sql += ' ORDER BY created_at DESC LIMIT 50';
        rows = await allRows(sql, ...params);
      }
    }
    const videos = [];
    for (const v of rows) { const j = await videoJSON(v, meId); if (j) videos.push(j); }
    res.json({ mode, videos });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});

// mes vidéos, y compris celles programmées (avec leur scheduled_at)
app.get('/api/videos/mine', auth, async (req, res) => {
  try {
    const rows = await allRows('SELECT * FROM videos WHERE user_id=? ORDER BY created_at DESC', req.userId);
    const videos = [];
    for (const v of rows) {
      const j = await videoJSON(v, req.userId);
      if (!j) continue;
      j.scheduled_at = v.scheduled_at ? Number(v.scheduled_at) : null;
      videos.push(j);
    }
    res.json({ videos });
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
// ---------- suppression d'une vidéo (propriétaire uniquement) ----------
app.delete('/api/videos/:id', auth, async (req, res) => {
  try {
    const v = await get1('SELECT * FROM videos WHERE id=?', req.params.id);
    if (!v) return res.status(404).json({ error: 'vidéo introuvable' });
    if (Number(v.user_id) !== Number(req.userId)) return res.status(403).json({ error: 'non autorisé' });
    // fichier : Cloudinary ou disque local
    try {
      if (USE_CLOUDINARY && v.file) {
        const m = String(v.file).match(/\/upload\/(?:v\d+\/)?(.+?)\.[a-z0-9]+$/i);
        if (m) await cloudinary.uploader.destroy(m[1], { resource_type: 'video' });
      } else if (v.file) fs.unlink(path.join(UP, v.file), () => {});
    } catch (e) {}
    const cIds = (await allRows('SELECT id FROM comments WHERE video_id=?', v.id)).map(r => r.id);
    for (const cid of cIds) await runSql('DELETE FROM comment_likes WHERE comment_id=?', cid);
    await runSql('DELETE FROM comments WHERE video_id=?', v.id);
    await runSql('DELETE FROM likes WHERE video_id=?', v.id);
    await runSql('DELETE FROM video_views WHERE video_id=?', v.id);
    await runSql('DELETE FROM watch_events WHERE video_id=?', v.id);
    await runSql('DELETE FROM watch_history WHERE video_id=?', v.id);
    await runSql('DELETE FROM watch_rewards WHERE video_id=?', v.id);
    await runSql('DELETE FROM like_rewards WHERE video_id=?', v.id);
    await runSql('DELETE FROM tips WHERE video_id=?', v.id);
    await runSql('DELETE FROM playlist_items WHERE video_id=?', v.id);
    await runSql('DELETE FROM videos WHERE id=?', v.id);
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
    await runSql('INSERT INTO video_views(video_id,viewer_id,ip,ad_shown,created_at) VALUES(?,?,?,?,?)',
      v.id, viewerId, ip, adShown, now());
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
    const day = new Date().toISOString().slice(0, 10);
    const dayStart = new Date().setHours(0, 0, 0, 0);
    // anti-doublon : une récompense par vidéo par utilisateur par jour
    const inserted = await runSqlChanges(
      USE_PG
        ? 'INSERT INTO watch_rewards(video_id,user_id,day,created_at) VALUES(?,?,?,?) ON CONFLICT DO NOTHING'
        : 'INSERT OR IGNORE INTO watch_rewards(video_id,user_id,day,created_at) VALUES(?,?,?,?)',
      v.id, req.userId, day, now());
    if (!inserted) {
      const b0 = await get1('SELECT coins FROM users WHERE id=?', req.userId);
      return res.json({ ok: true, granted: 0, reason: 'already', coins: b0 ? b0.coins : 0 });
    }
    const earned = Number((await get1(`SELECT COALESCE(SUM(amount),0) AS s FROM ledger WHERE user_id=? AND amount>0 AND created_at>=?`, req.userId, dayStart)).s);
    if (earned >= 100) {
      const b1 = await get1('SELECT coins FROM users WHERE id=?', req.userId);
      return res.json({ ok: true, granted: 0, reason: 'daily-cap', coins: b1 ? b1.coins : 0 });
    }
    const grant = Math.min(10, 100 - earned);
    await runSql('UPDATE users SET coins=coins+? WHERE id=?', grant, req.userId);
    await runSql('INSERT INTO ledger(user_id,amount,reason,created_at) VALUES(?,?,?,?)', req.userId, grant, 'vidéo regardée #' + v.id, now());
    const b2 = await get1('SELECT coins FROM users WHERE id=?', req.userId);
    res.json({ ok: true, granted: grant, coins: b2 ? b2.coins : 0 });
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
    if (!alreadyLiked) await notify(v.user_id, 'like', req.userId, v.id, '');
    // +1 pièce au créateur quand quelqu'un aime (plafond 100/jour, une seule fois par liker/vidéo)
    const dayStart = new Date().setHours(0, 0, 0, 0);
    const firstReward = await runSqlChanges(
      USE_PG
        ? 'INSERT INTO like_rewards(liker_id,video_id,created_at) VALUES(?,?,?) ON CONFLICT DO NOTHING'
        : 'INSERT OR IGNORE INTO like_rewards(liker_id,video_id,created_at) VALUES(?,?,?)',
      req.userId, v.id, now());
    const earned = Number((await get1(
      `SELECT COALESCE(SUM(amount),0) AS s FROM ledger
       WHERE user_id=? AND reason LIKE 'like reçu%' AND created_at>=?`, v.user_id, dayStart)).s);
    if (firstReward && Number(v.user_id) !== Number(req.userId) && earned < 100) {
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
// ---------- commentaires ----------
app.get('/api/videos/:id/comments', async (req, res) => {
  const rows = await allRows(
    `SELECT c.*, u.username, u.name, u.avatar FROM comments c
     JOIN users u ON u.id=c.user_id
     WHERE c.video_id=? AND (c.review_status IS NULL OR c.review_status<>'pending')
     ORDER BY c.created_at ASC LIMIT 200`, req.params.id);
  // v12 : exclut les commentaires contenant un mot-clé filtré par le propriétaire
  let kws = [];
  try {
    const v = await get1('SELECT user_id FROM videos WHERE id=?', req.params.id);
    if (v) {
      const o = await get1('SELECT comment_keywords FROM users WHERE id=?', v.user_id);
      kws = parseKeywords(o && o.comment_keywords);
    }
  } catch (e) {}
  const filtered = kws.length
    ? rows.filter(c => !kws.some(k => String(c.text || '').toLowerCase().includes(k)))
    : rows;
  res.json({ comments: filtered });
});

app.post('/api/videos/:id/comments', auth, uploadMedia.fields([{name:'video',maxCount:1},{name:'audio',maxCount:1}]), async (req, res) => {
  try {
    let text = String((req.body || {}).text || '').trim().slice(0, 500);
    // v1.68 : filtre anti-gros mots automatique — masque au lieu de bloquer
    text = maskBadwords(text);
    const hasAudio=req.files&&req.files.audio&&req.files.audio[0];
    const hasVideo=req.files&&req.files.video&&req.files.video[0];
    if (!text&&!hasAudio&&!hasVideo) return res.status(400).json({ error: 'commentaire vide' });
    const v = await get1('SELECT * FROM videos WHERE id=?', req.params.id);
    if (!v) return res.status(404).json({ error: 'vidéo introuvable' });
    // v12 : filtres de commentaires du propriétaire (insensible à la casse)
    const owner = await get1('SELECT comment_keywords FROM users WHERE id=?', v.user_id);
    const kws = parseKeywords(owner && owner.comment_keywords);
    if (kws.length && kws.some(k => text.toLowerCase().includes(k)))
      return res.status(400).json({ error: 'comment_blocked' });
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
    // modération auto V3 : scan du texte (sans IA externe)
    const badC = scanBanned(text);
    if (badC) {
      await runSql(`UPDATE comments SET review_status='pending' WHERE id=?`, id);
      await flagForReview('comment', id, 'mot interdit : ' + badC);
    }
    const c = await get1(
      `SELECT c.*, u.username, u.name, u.avatar FROM comments c
       JOIN users u ON u.id=c.user_id WHERE c.id=?`, id);
    await notify(v.user_id, 'comment', req.userId, v.id, text.slice(0, 100));
    notifyMentions(text, req.userId, v.id); // v1.84 : notifie les @mentionnés
    res.json({ comment: c });
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
    const rows = await allRows(
      'SELECT * FROM conversations WHERE user1_id=? OR user2_id=? ORDER BY updated_at DESC',
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
      });
    }
    res.json({ conversations: out });
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
      return { id: m.id, sender_id: m.sender_id, text: m.text, audio_url: m.audio_url || '', created_at: Number(m.created_at) };
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
    if (!text && !audioUrl) return res.status(400).json({ error: 'message vide' });
    const t = now();
    const id = await insertId(
      'INSERT INTO messages(conversation_id,sender_id,text,audio_url,created_at) VALUES(?,?,?,?,?)',
      c.id, req.userId, text, audioUrl, t);
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
      await runSql('UPDATE poll_options SET votes=votes-1 WHERE id=?', old.option_id);
      await runSql('UPDATE poll_votes SET option_id=? WHERE poll_id=? AND user_id=?', optId, p.id, req.userId);
      await runSql('UPDATE poll_options SET votes=votes+1 WHERE id=?', optId);
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
    const upd = await get1('SELECT * FROM users WHERE id=?', u.id);
    res.json({ user: pubUser(upd) });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});

// ==================== SERVEUR v9 : MVP phase 2 ====================
// ---------- notifications ----------
app.get('/api/notifications', auth, async (req, res) => {
  try {
    const rows = await allRows('SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 20', req.userId);
    const out = [];
    for (const n of rows) {
      const actor = n.actor_id ? await get1('SELECT * FROM users WHERE id=?', n.actor_id) : null;
      const vid = n.video_id ? await get1('SELECT * FROM videos WHERE id=?', n.video_id) : null;
      out.push({
        id: n.id, type: n.type, text: n.text || '', is_read: !!n.is_read,
        created_at: Number(n.created_at),
        actor: actor ? pubUser(actor) : null,
        video: vid ? { id: vid.id, thumb: fileUrl(vid.file) } : null,
      });
    }
    res.json({ notifications: out });
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
app.get('/api/notifications/unread-count', auth, async (req, res) => {
  try {
    const c = await get1('SELECT COUNT(*) AS c FROM notifications WHERE user_id=? AND is_read=0', req.userId);
    res.json({ unread: Number(c.c) });
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
      await runSql("UPDATE reports SET status='dismissed' WHERE id=?", r.id);
    } else if (action === 'hide_video') {
      if (r.target_type === 'video') await runSql('UPDATE videos SET hidden=1 WHERE id=?', r.target_id);
      else if (r.target_type === 'comment') await runSql('DELETE FROM comments WHERE id=?', r.target_id);
      else if (r.target_type === 'message') await runSql('DELETE FROM messages WHERE id=?', r.target_id);
      else if (r.target_type === 'user') await runSql('UPDATE videos SET hidden=1 WHERE user_id=?', r.target_id);
      await runSql("UPDATE reports SET status='resolved' WHERE id=?", r.id);
    } else if (action === 'suspend_user') {
      const author = await reportAuthor(r);
      if (author) await runSql('UPDATE users SET suspended=1 WHERE id=?', author.id);
      await runSql("UPDATE reports SET status='resolved' WHERE id=?", r.id);
    }
    res.json({ ok: true, action });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});

// ---------- collections ----------
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
    const fname = 'vidigagne/videos/' + Date.now() + '_' + Math.random().toString(36).slice(2, 8) + '.mp4';
    let fileUrl = '';
    if (USE_CLOUDINARY && cloudinary) {
      const up = await new Promise((resolve, reject) => {
        const st = cloudinary.uploader.upload_stream(
          { resource_type: 'video', folder: 'vidigagne/videos', format: 'mp4' },
          (err, r) => err ? reject(err) : resolve(r));
        st.end(req.file.buffer);
      });
      fileUrl = up.secure_url;
    } else { fileUrl = fname; }
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
// envoie un push FCM (utilise Firebase Admin SDK si configuré, sinon log)
let _fcmAdmin = null;
async function sendFcmPush(userId, title, body, data) {
  try {
    const u = await get1('SELECT fcm_token FROM users WHERE id=?', userId);
    if (!u || !u.fcm_token) return { sent: false, reason: 'no_token' };
    // Firebase Admin SDK (nécessite GOOGLE_APPLICATION_CREDENTIALS sur Render)
    if (!_fcmAdmin) {
      try { _fcmAdmin = require('firebase-admin'); } catch (_) { return { sent: false, reason: 'admin_sdk_missing' }; }
    }
    if (_fcmAdmin.apps.length === 0) {
      _fcmAdmin.initializeApp({ credential: _fcmAdmin.credential.applicationDefault() });
    }
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
    const rows = await allRows('SELECT video_id FROM reposts WHERE user_id=? ORDER BY created_at DESC LIMIT 50', u.id);
    const videos = [];
    for (const r of rows) {
      const v = await get1('SELECT * FROM videos WHERE id=? AND hidden=0', r.video_id);
      if (v && await canSeeVideo(v, meId)) { const j = await videoJSON(v, null); if (j) videos.push(j); }
    }
    res.json({ videos });
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
    const rows = await allRows('SELECT video_id, watched_at FROM watch_history WHERE user_id=? ORDER BY watched_at DESC LIMIT 30', req.userId);
    const out = [];
    for (const r of rows) {
      const v = await get1('SELECT * FROM videos WHERE id=? AND hidden=0', r.video_id);
      if (!v) continue;
      const j = await videoJSON(v, req.userId);
      if (!j) continue;
      j.watched_at = Number(r.watched_at);
      out.push(j);
    }
    res.json({ history: out });
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
  await insertIgnore('INSERT OR IGNORE INTO follows(follower_id,followed_id,created_at) VALUES(?,?,?)',
    req.userId, u.id, now());
  await notify(u.id, 'follow', req.userId, null, '');
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
    // profil inaccessible si blocage dans un sens ou l'autre (sauf soi-même)
    const meId = await optUserId(req);
    if (meId && Number(meId) !== Number(u.id) && await isBlocked(meId, u.id))
      return res.status(403).json({ error: 'utilisateur bloqué' });
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
    res.json({ user: pubUser(u), followers, following, total_likes: likes, videos });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});

// ---------- v13 : Q&A sur le profil ----------
app.get('/api/users/:username/qa', async (req, res) => {
  try {
    const u = await get1('SELECT id FROM users WHERE username=?', String(req.params.username).toLowerCase());
    if (!u) return res.status(404).json({ error: 'utilisateur introuvable' });
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
    // v1.63 : journalise les recherches pour les insights créateurs
    if (rawQ.length >= 2) {
      runSql('INSERT INTO search_logs(query,user_id,created_at) VALUES(?,?,?)',
        rawQ, meId || null, now()).catch(() => {});
      // nettoyage : garde 30 jours
      runSql('DELETE FROM search_logs WHERE created_at<?', now() - 30 * 86400000).catch(() => {});
    }
    const users = await allRows(
      'SELECT id,username,name,avatar FROM users WHERE username LIKE ? OR name LIKE ? LIMIT 20', q, q);
    const vf = visFilter('videos', meId);
    const vids = await allRows(
      'SELECT * FROM videos WHERE (LOWER(description) LIKE ? OR LOWER(tags) LIKE ?) AND (scheduled_at IS NULL OR scheduled_at <= ?) AND hidden=0' + vf.clause + ' ORDER BY created_at DESC LIMIT 20', q, q, now(), ...vf.params);
    const videos = [];
    for (const v of vids) { const j = await videoJSON(v, null); if (j) videos.push(j); }
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
    const _pu = privUser(u); _pu.email = u.email || ''; // v1.100 : l'app envoie le code à cet e-mail
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
app.get('/privacy', (req, res) => res.type('html').send(`<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>VidiGagne — Politique de confidentialité</title>${PAGE_STYLE}</head><body>
<h1>Politique de confidentialité — VidiGagne</h1>
<p><em>Dernière mise à jour : 2 octobre 2026.</em></p>
<p>VidiGagne (« nous ») est une application de partage de vidéos courtes. La protection de tes données personnelles et ta sécurité sont au cœur de notre service. Cette politique explique quelles données nous collectons, pourquoi, avec qui nous les partageons, et les droits dont tu disposes — sur le modèle des standards des grandes plateformes vidéo.</p>

<h2>1. Les données que nous collectons</h2>
<h3>1.1. Données que tu nous fournis</h3>
<ul>
<li><strong>Informations de compte :</strong> pseudo (unique), nom affiché, adresse e-mail et/ou numéro de téléphone si tu choisis ces modes d'inscription, mot de passe (stocké sous forme chiffrée, jamais en clair).</li>
<li><strong>Connexion via un tiers :</strong> si tu te connectes avec Google, Facebook ou Apple, nous recevons les informations de base que ce service accepte de partager (nom, adresse e-mail, photo de profil).</li>
<li><strong>Profil :</strong> photo de profil, biographie et tout autre élément que tu choisis d'afficher publiquement.</li>
<li><strong>Contenu :</strong> vidéos que tu publies, descriptions, hashtags, sons associés, commentaires, stories, messages du chat des lives, playlists et cadeaux virtuels.</li>
<li><strong>Gains et retraits :</strong> solde de pièces, historique des gains, et — uniquement si tu demandes un retrait — la méthode choisie (MonCash, NatCash) et le numéro de téléphone nécessaire au paiement.</li>
<li><strong>Signalements :</strong> contenu des signalements que tu nous adresses pour la modération.</li>
</ul>
<h3>1.2. Données collectées automatiquement</h3>
<ul>
<li><strong>Utilisation :</strong> vidéos regardées, likes, abonnements, recherches et interactions, afin de personnaliser ton fil « Pour toi ».</li>
<li><strong>Données techniques :</strong> adresse IP, type d'appareil et de système d'exploitation, identifiants techniques nécessaires au fonctionnement et à la sécurité du service.</li>
<li><strong>Journaux :</strong> dates de connexion et actions liées à la sécurité du compte.</li>
</ul>
<p>Nous ne collectons pas ta localisation GPS précise. Nous n'accédons à tes contacts, ta galerie ou ton micro que si tu nous l'autorises explicitement pour une fonctionnalité précise (ex. : choisir une vidéo, enregistrer une voix off).</p>

<h2>2. Comment nous utilisons tes données</h2>
<ul>
<li>Fournir et faire fonctionner l'application : comptes, diffusion des vidéos, commentaires, lives, stories.</li>
<li>Personnaliser ton expérience : recommandations du fil « Pour toi » basées sur tes interactions.</li>
<li>Gérer ton solde de pièces, les cadeaux et les demandes de retrait.</li>
<li>Assurer la sécurité : détecter les fraudes, les faux comptes et les abus ; modérer les contenus signalés.</li>
<li>Améliorer le service et corriger les erreurs techniques.</li>
<li>Respecter nos obligations légales.</li>
</ul>
<p><strong>Nous ne vendons jamais tes données personnelles.</strong></p>

<h2>3. Avec qui nous partageons tes données</h2>
<ul>
<li><strong>Autres utilisateurs :</strong> ton pseudo, ta photo, ta bio, tes vidéos publiques, tes commentaires et tes likes publics sont visibles par tous les utilisateurs de l'application. Réfléchis avant de publier.</li>
<li><strong>Prestataires techniques</strong> (uniquement ce qui est nécessaire au service) :
  <ul>
  <li>Neon / AWS — base de données (hébergée aux États-Unis) ;</li>
  <li>Cloudinary — hébergement des vidéos ;</li>
  <li>Render — serveurs applicatifs ;</li>
  <li>Firebase / Google — vérification des numéros de téléphone et connexion Google.</li>
  </ul></li>
<li><strong>Autorités :</strong> uniquement si la loi l'exige ou pour protéger la sécurité des utilisateurs.</li>
</ul>
<p>Nous ne partageons pas tes données avec des annonceurs : VidiGagne n'affiche pas de publicité ciblée.</p>

<h2>4. Tes droits et tes choix</h2>
<p>Tu disposes à tout moment des droits suivants, directement depuis l'application :</p>
<ul>
<li><strong>Accès et rectification :</strong> consulte et modifie ton profil (Profil → Paramètres).</li>
<li><strong>Export :</strong> télécharge une copie de tes données (Profil → Paramètres → « Télécharger mes données »).</li>
<li><strong>Suppression :</strong> supprime définitivement ton compte et l'ensemble de tes données (Profil → Paramètres → « Supprimer mon compte »). Les stories sont de toute façon supprimées automatiquement 24 h après leur publication.</li>
<li><strong>Contenu :</strong> tu peux supprimer tes vidéos et commentaires à tout moment.</li>
</ul>

<h2>5. Sécurité de tes données</h2>
<ul>
<li>Les mots de passe sont chiffrés et ne sont jamais stockés en clair.</li>
<li>Toutes les communications entre l'application et nos serveurs sont chiffrées (HTTPS).</li>
<li>L'accès aux systèmes est strictement limité et journalisé.</li>
<li>Des plafonds anti-fraude protègent ton solde de pièces.</li>
</ul>
<p>Aucun système n'est infaillible : protège ton mot de passe et ne le partage avec personne.</p>

<h2>6. Conservation des données</h2>
<p>Nous conservons tes données aussi longtemps que ton compte est actif et que c'est nécessaire pour fournir le service. Les stories sont supprimées automatiquement après 24 heures. Lorsque tu supprimes ton compte, tes données personnelles, tes vidéos et tes fichiers sont définitivement effacés de nos systèmes.</p>

<h2>7. Mineurs</h2>
<p>VidiGagne est réservé aux personnes âgées d'au moins <strong>13 ans</strong>. Nous ne collectons pas sciemment de données d'enfants de moins de 13 ans ; si tu penses qu'un enfant de moins de 13 ans utilise l'application, contacte-nous pour que nous supprimions son compte.</p>

<h2>8. Transferts internationaux</h2>
<p>Tes données sont hébergées aux États-Unis par nos prestataires (Neon/AWS, Cloudinary, Render). En utilisant VidiGagne depuis un autre pays, tu acceptes ce transfert, encadré par les contrats de nos prestataires.</p>

<h2>9. Modifications de cette politique</h2>
<p>Si nous modifions cette politique de façon importante, nous t'en informerons dans l'application avant son entrée en vigueur. La date de mise à jour figure en haut de cette page.</p>

<h2>10. Nous contacter</h2>
<p>Pour toute question sur tes données personnelles, la sécurité de ton compte ou l'exercice de tes droits :<br>
<strong>ceuskewin1234@gmail.com</strong><br>
ou depuis l'application : Profil → Paramètres.</p>

<footer>VidiGagne — Ta sécurité d'abord.</footer></body></html>`));

app.get('/api/health', (req, res) => res.json({
  ok: true, name: 'VidiGagne Server v2', time: now(),
  db: USE_PG ? 'postgres' : 'sqlite',
  storage: USE_CLOUDINARY ? 'cloudinary' : 'local',
  google: GOOGLE_OK(), phone: !!process.env.FIREBASE_PROJECT_ID,
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
    const { live_id, amount_usd, method_id } = req.body || {};
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
    // débit atomique des pièces + suivi du pool du live
    const debited = await runSqlChanges('UPDATE users SET coins=coins-? WHERE id=? AND coins>=?', coins, req.userId, coins);
    if (!debited) return res.status(400).json({ error: 'pas assez de pièces' });
    await runSql('UPDATE live_summaries SET withdrawn_usd=withdrawn_usd+? WHERE live_id=?', amount, p.live.id);
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
    const amount = Math.round(Number(amount_usd) * 100) / 100;
    const p = await livePool(live_id, req.userId);
    if (p.err) return res.status(p.code).json({ error: p.err });
    if (!amount || amount <= 0) return res.status(400).json({ error: 'montant invalide' });
    if (amount > p.remaining) return res.status(400).json({ error: 'montant supérieur aux gains restants (' + p.remaining.toFixed(2) + ' $)' });
    const coins = Math.floor(amount * 500);
    if (coins < 1) return res.status(400).json({ error: 'montant trop petit' });
    await runSql('UPDATE live_summaries SET exchanged_usd=exchanged_usd+? WHERE live_id=?', amount, p.live.id);
    await runSql('INSERT INTO ledger(user_id,amount,reason,created_at) VALUES(?,?,?,?)',
      req.userId, 0, 'échange live #' + p.live.id + ' : ' + amount.toFixed(2) + ' $ → ' + coins + ' 🪙 réservées (boost / cadeaux live)', now()).catch(() => {});
    const s2 = await get1('SELECT withdrawn_usd, exchanged_usd, usd_earned FROM live_summaries WHERE live_id=?', p.live.id);
    const rem = Math.max(0, Math.round((Number(s2.usd_earned) - Number(s2.withdrawn_usd) - Number(s2.exchanged_usd)) * 100) / 100);
    const bal = await get1('SELECT coins FROM users WHERE id=?', req.userId);
    res.json({ ok: true, coins, usd: amount, coins_balance: bal ? bal.coins : 0, remaining_usd: rem,
      note: coins + ' 🪙 disponibles dans ton solde pour booster tes vidéos ou envoyer des cadeaux en live ✓' });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.get('/api/live/feed', async (req, res) => {
  try {
    const rows = await allRows(
      'SELECT l.*, u.username, u.name, u.avatar FROM lives l JOIN users u ON u.id=l.user_id WHERE l.ended_at IS NULL ORDER BY l.started_at DESC LIMIT 50');
    const lives = [];
    for (const r of rows) {
      const lj = liveJSON(r, r, await liveViewersCount(r.id));
      const maxGf = Math.max(1, Math.min(8, Number(r.max_guests) || 8));
      const guests = await allRows("SELECT user_id, username, avatar FROM live_guests WHERE live_id=? AND status='accepted' ORDER BY created_at ASC LIMIT " + maxGf, r.id);
      lj.guests = guests;
      lj.guest_slots = maxGf;
      lives.push(lj);
    }
    res.json({ lives });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.get('/api/live', async (req, res) => {
  const rows = await allRows(
    'SELECT l.*, u.username, u.name, u.avatar FROM lives l JOIN users u ON u.id=l.user_id WHERE l.ended_at IS NULL ORDER BY l.started_at DESC');
  const lives = [];
  for (const r of rows) lives.push(liveJSON(r, r, await liveViewersCount(r.id)));
  res.json({ lives });
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
      live_type: l.live_type || 'guests'
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
    const text = raw;
    const id = await insertId('INSERT INTO live_chat(live_id,user_id,text,created_at) VALUES(?,?,?,?)',
      l.id, req.userId, text, now());
    const u = await get1('SELECT username,name,avatar FROM users WHERE id=?', req.userId);
    res.json({ ok: true, id, msg: { id, user: pubUser({ ...u, id: req.userId }), text, created_at: now() } });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.get('/api/live/:id/chat', async (req, res) => {
  const l = await liveById(req.params.id);
  if (!l) return res.status(404).json({ error: 'live introuvable' });
  const since = Number(req.query.since) || 0;
  const rows = await allRows(
    'SELECT c.id, c.text, c.created_at, u.id AS uid, u.username, u.name, u.avatar, u.verified FROM live_chat c JOIN users u ON u.id=c.user_id WHERE c.live_id=? AND c.id>? ORDER BY c.id ASC LIMIT 50',
    l.id, since);
  res.json({ messages: rows.map(r => ({ id: r.id, text: r.text, created_at: Number(r.created_at),
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
      rows = await allRows("SELECT * FROM live_signals WHERE live_id=? AND id>? AND ((from_user_id=? AND (to_user_id IS NULL OR to_user_id=?) AND kind IN ('offer','answer','candidate')) OR (to_user_id=? AND kind IN ('guest_accept','guest_refuse','guest_invite','guest_invite_accept','guest_invite_refuse'))) ORDER BY id ASC LIMIT 50",
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
    try {
      const _pkb = await activePkForLive(l.id);
      if (_pkb && _pkb.status === 'active') {
        const col = Number(_pkb.user_a_id) === Number(l.user_id) ? 'score_a' : 'score_b';
        await runSql('UPDATE pk_battles SET ' + col + '=' + col + '+? WHERE id=?', g.coins || 1, _pkb.id);
      }
    } catch (_) {}
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
    const split = await applyGiftSplit(req.userId, toUserId, g.cost, g.id, l.id);
    await runSql('INSERT INTO gifts(from_id,to_id,video_id,live_id,gift,cost,created_at) VALUES(?,?,?,?,?,?,?)',
      req.userId, toUserId, null, l.id, g.id, g.cost, now());
    await runSql('UPDATE lives SET gifts_total=COALESCE(gifts_total,0)+? WHERE id=?', split.creatorShare, l.id).catch(() => {});
    await notify(toUserId, 'gift', req.userId, null, g.id);
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
      "SELECT id, user_id, username, avatar, status, created_at FROM live_guests WHERE live_id=? AND status IN " + statusFilter + " ORDER BY created_at ASC LIMIT 20",
      l.id);
    res.json({ guests: rows, is_host: isHost, max_guests: Math.max(1, Math.min(8, Number(l.max_guests) || 8)) });
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
    if (USE_PG) {
      await runSql(`INSERT INTO live_guests(live_id,user_id,username,avatar,status,created_at) VALUES(?,?,?,?,?,?)
        ON CONFLICT(live_id,user_id) DO UPDATE SET status='pending', username=EXCLUDED.username, avatar=EXCLUDED.avatar, created_at=EXCLUDED.created_at`,
        l.id, req.userId, un, av, 'pending', now());
    } else {
      await runSql(`INSERT OR REPLACE INTO live_guests(live_id,user_id,username,avatar,status,created_at) VALUES(?,?,?,?,?,?)`,
        l.id, req.userId, un, av, 'pending', now());
    }
    // notifie l'hôte en temps réel via le canal signaux
    await runSql('INSERT INTO live_signals(live_id,to_user_id,from_user_id,kind,payload,created_at) VALUES(?,?,?,?,?,?)',
      l.id, l.user_id, req.userId, 'guest_request', JSON.stringify({ username: un, avatar: av }), now()).catch(() => {});
    await notify(l.user_id, 'guest_request', req.userId, null, null).catch(() => {});
    res.json({ ok: true });
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
    const guestId = Number((req.body || {}).user_id);
    if (!guestId || guestId === Number(req.userId)) return res.status(400).json({ error: 'user_id invalide' });
    const u = await get1('SELECT username, avatar FROM users WHERE id=?', guestId);
    if (!u) return res.status(404).json({ error: 'utilisateur introuvable' });
    if (USE_PG) {
      await runSql(`INSERT INTO live_guests(live_id,user_id,username,avatar,status,created_at) VALUES(?,?,?,?,?,?)
        ON CONFLICT(live_id,user_id) DO UPDATE SET status='invited', created_at=EXCLUDED.created_at`,
        l.id, guestId, u.username, u.avatar || '', 'invited', now());
    } else {
      await runSql(`INSERT OR REPLACE INTO live_guests(live_id,user_id,username,avatar,status,created_at) VALUES(?,?,?,?,?,?)`,
        l.id, guestId, u.username, u.avatar || '', 'invited', now());
    }
    await runSql('INSERT INTO live_signals(live_id,to_user_id,from_user_id,kind,payload,created_at) VALUES(?,?,?,?,?,?)',
      l.id, guestId, req.userId, 'guest_invite', JSON.stringify({ live_id: l.id, title: l.title }), now()).catch(() => {});
    res.json({ ok: true });
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
  const rows = await allRows('SELECT * FROM sounds ORDER BY use_count DESC, created_at DESC LIMIT 20');
  res.json({ sounds: rows.map(s => soundJSON(s)) });
});
app.get('/api/sounds/search', async (req, res) => {
  const q = '%' + String(req.query.q || '').toLowerCase() + '%';
  const rows = await allRows('SELECT * FROM sounds WHERE LOWER(title) LIKE ? OR LOWER(artist) LIKE ? ORDER BY use_count DESC LIMIT 20', q, q);
  res.json({ sounds: rows.map(s => soundJSON(s)) });
});
app.get('/api/sounds/favs/mine', auth, async (req, res) => {
  const rows = await allRows('SELECT s.* FROM sound_favs f JOIN sounds s ON s.id=f.sound_id WHERE f.user_id=? ORDER BY f.created_at DESC LIMIT 50', req.userId);
  res.json({ sounds: rows.map(s => soundJSON(s, req.userId, true)) });
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
app.post('/api/sounds/:id/use', auth, async (req, res) => {
  const s = await get1('SELECT * FROM sounds WHERE id=?', req.params.id);
  if (!s) return res.status(404).json({ error: 'son introuvable' });
  await runSql('UPDATE sounds SET use_count=use_count+1 WHERE id=?', s.id);
  const u = await get1('SELECT * FROM sounds WHERE id=?', s.id);
  res.json({ sound: soundJSON(u) });
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
    // le prix est fixé par le CRÉATEUR, jamais par le client (anti-fraude)
    const price = Math.max(10, Math.min(100000, Math.floor(Number(u.sub_price) || 0)));
    if (Number(u.sub_enabled) !== 1 || !price) return res.status(400).json({ error: 'abonnement non proposé par ce créateur' });
    const debited = await runSqlChanges('UPDATE users SET coins=coins-? WHERE id=? AND coins>=?', price, req.userId, price);
    if (!debited) return res.status(400).json({ error: 'pas assez de pièces' });
    await runSql('UPDATE users SET coins=coins+? WHERE id=?', price, u.id);
    await runSql('INSERT INTO ledger(user_id,amount,reason,created_at) VALUES(?,?,?,?)',
      req.userId, -price, 'abonnement @' + u.username, now());
    await runSql('INSERT INTO ledger(user_id,amount,reason,created_at) VALUES(?,?,?,?)',
      u.id, price, 'abonnement reçu', now());
    const t = now(), exp = t + 30 * 86400000;
    const cur = await get1('SELECT * FROM creator_subs WHERE creator_id=? AND subscriber_id=? AND active=1 AND expires_at>?', u.id, req.userId, t);
    if (cur) {
      await runSql('UPDATE creator_subs SET expires_at=?, price_coins=? WHERE id=?', Number(cur.expires_at) + 30 * 86400000, price, cur.id);
    } else {
      await insertId('INSERT INTO creator_subs(creator_id,subscriber_id,price_coins,started_at,expires_at,active,created_at) VALUES(?,?,?,?,?,1,?)',
        u.id, req.userId, price, t, exp, t);
    }
    const sub = await get1('SELECT * FROM creator_subs WHERE creator_id=? AND subscriber_id=? AND active=1 ORDER BY expires_at DESC', u.id, req.userId);
    await notify(u.id, 'subscribe', req.userId, null, '');
    res.json({ ok: true, expires_at: Number(sub.expires_at) });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.get('/api/users/:username/subscription', auth, async (req, res) => {
  const u = await get1('SELECT * FROM users WHERE username=?', String(req.params.username).toLowerCase());
  if (!u) return res.status(404).json({ error: 'utilisateur introuvable' });
  const s = await get1('SELECT * FROM creator_subs WHERE creator_id=? AND subscriber_id=? AND active=1 AND expires_at>? ORDER BY expires_at DESC',
    u.id, req.userId, now());
  res.json({ subscription: s ? { active: true, expires_at: Number(s.expires_at), price_coins: Number(s.price_coins) } : { active: false } });
});
// désactive les abonnements expirés (toutes les 24 h)
async function expireSubs() {
  try { await runSql('UPDATE creator_subs SET active=0 WHERE active=1 AND expires_at<=?', now()); } catch (e) {}
}

// ==================== SERVEUR v11 — V3 ====================
// BOUTIQUE + LIVE SHOPPING + PUBLICITÉ + MODÉRATION AUTO + FINANCIER
const PLATFORM_FEE_PCT = 10;   // commission plateforme sur chaque vente
const AFFILIATE_RATE_PCT = 5;  // commission d'affiliation par défaut (% du total)
const AD_COST_IMPRESSION = 1;  // pièces débitées du budget par impression
const AD_COST_CLICK = 5;       // pièces débitées du budget par clic

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
app.get('/api/shop/search', shopSearch);
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
      if (Number(coupon.discount_pct) > 0) discount = Math.floor(subtotal * Number(coupon.discount_pct) / 100);
      else discount = Number(coupon.discount_coins);
      discount = Math.min(discount, subtotal);
    }
    const total = subtotal - discount;
    // affiliation (?ref=CODE)
    let affiliate = null;
    const ref = String((req.body || {}).ref || '').toUpperCase().trim();
    if (ref) affiliate = await get1('SELECT * FROM affiliates WHERE code=?', ref);
    // --- exécution : stocks d'abord (atomiques), puis débit acheteur ---
    const decremented = [];
    for (const it of items) {
      const okStock = await runSqlChanges('UPDATE products SET stock=stock-? WHERE id=? AND stock>=?', it.qty, it.product_id, it.qty);
      if (!okStock) {
        // restaure les stocks déjà décrémentés, aucun argent n'a bougé
        for (const r of decremented) await runSql('UPDATE products SET stock=stock+? WHERE id=?', r.qty, r.product_id);
        return res.status(400).json({ error: 'stock épuisé : ' + it.title });
      }
      decremented.push({ product_id: it.product_id, qty: it.qty });
    }
    const debited = await runSqlChanges('UPDATE users SET coins=coins-? WHERE id=? AND coins>=?', total, req.userId, total);
    if (!debited) {
      for (const r of decremented) await runSql('UPDATE products SET stock=stock+? WHERE id=?', r.qty, r.product_id);
      return res.status(400).json({ error: 'pas assez de pièces' });
    }
    await runSql('INSERT INTO ledger(user_id,amount,reason,created_at) VALUES(?,?,?,?)',
      req.userId, -total, 'commande boutique', now());
    const orderId = await insertId(
      'INSERT INTO orders(buyer_id,total_coins,status,coupon_code,affiliate_id,created_at) VALUES(?,?,?,?,?,?)',
      req.userId, total, 'completed', coupon ? coupon.code : null, affiliate ? affiliate.id : null, now());
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
    if (coupon) await runSql('UPDATE coupons SET used_count=used_count+1 WHERE id=?', coupon.id);
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
  await insertId('INSERT INTO seller_payouts(seller_id,coins,status,created_at) VALUES(?,?,?,?)',
    req.userId, amount, 'done', now());
  await runSql('UPDATE users SET coins=coins+? WHERE id=?', amount, req.userId);
  await runSql('INSERT INTO ledger(user_id,amount,reason,created_at) VALUES(?,?,?,?)',
    req.userId, amount, 'versement vendeur', now());
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
    const target = String(b.target || '').slice(0, 80);
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
  const c = rows[Math.floor(Math.random() * rows.length)];
  let product = null;
  if (c.product_id) {
    const p = await get1('SELECT * FROM products WHERE id=? AND active=1', c.product_id);
    if (p) product = productJSON(p);
  }
  res.json({ ads: [{ id: c.id, title: c.title, target: c.target || '', product }] });
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
    const already = await get1('SELECT 1 FROM series_purchases WHERE series_id=? AND user_id=?', s.id, req.userId);
    if (already) return res.status(400).json({ error: 'série déjà achetée' });
    const price = Number(s.price_coins);
    const creatorShare = Math.floor(price * 0.9); // 90 % créateur, 10 % plateforme
    const debited = await runSqlChanges('UPDATE users SET coins=coins-? WHERE id=? AND coins>=?', price, req.userId, price);
    if (!debited) return res.status(400).json({ error: 'pas assez de pièces' });
    await runSql('UPDATE users SET coins=coins+? WHERE id=?', creatorShare, s.creator_id);
    await runSql('INSERT INTO ledger(user_id,amount,reason,created_at) VALUES(?,?,?,?)',
      req.userId, -price, 'achat série #' + s.id, now());
    await runSql('INSERT INTO ledger(user_id,amount,reason,created_at) VALUES(?,?,?,?)',
      s.creator_id, creatorShare, 'vente série #' + s.id, now());
    await insertIgnore('INSERT OR IGNORE INTO series_purchases(series_id,user_id,created_at) VALUES(?,?,?)',
      s.id, req.userId, now());
    await notify(s.creator_id, 'series_buy', req.userId, null, String(price));
    const balS = await get1('SELECT coins FROM users WHERE id=?', req.userId);
    res.json({ ok: true, coins: balS ? balS.coins : 0 });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
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
    if (!still) await runSql('DELETE FROM family_settings WHERE teen_id=?', teenGone);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});

// ---------- publication programmée : publie les vidéos dont l'heure est passée ----------
async function publishDue() {
  try {
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
function clientIp(req){
  // m10 : req.ip avec trust proxy (le premier segment de x-forwarded-for est falsifiable par le client)
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
    const ipHit = await get1('SELECT id FROM ad_reward_claims WHERE ip=? AND created_at>?', ip, t-5*60*1000);
    if(ipHit) return res.status(429).json({ error: 'trop de demandes (anti-fraude)' });
    const uHit = await get1('SELECT id FROM ad_reward_claims WHERE user_id=? AND created_at>?', req.userId, t-2*60*1000);
    if(uHit) return res.status(429).json({ error: 'patiente 2 minutes' });
    // plafond journalier serveur : 100 pièces/jour max (le localStorage ne suffit pas)
    const dayStart = new Date().setHours(0,0,0,0);
    const earned = Number((await get1(`SELECT COALESCE(SUM(amount),0) AS s FROM ledger WHERE user_id=? AND amount>0 AND created_at>=?`, req.userId, dayStart)).s);
    if (earned >= 100) return res.status(429).json({ error: 'plafond journalier atteint (100 pièces)' });
    const grant = Math.min(30, 100 - earned);
    await runSql('INSERT INTO ad_reward_claims(user_id,ip,created_at) VALUES(?,?,?)', req.userId, ip, t);
    await runSql('UPDATE users SET coins=coins+? WHERE id=?', grant, req.userId);
    await runSql('INSERT INTO ledger(user_id,amount,reason,created_at) VALUES(?,?,?,?)', req.userId, grant, 'pub récompensée', t);
    await bumpDailyPoints(grant);
    const balR = await get1('SELECT coins FROM users WHERE id=?', req.userId);
    res.json({ ok:true, granted: grant, coins: balR ? balR.coins : 0 });
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
app.post('/api/videos/:id/duet', auth, async (req, res) => {
  try {
    const orig = await get1('SELECT * FROM videos WHERE id=?', req.params.id);
    if (!orig) return res.status(404).json({ error: 'vidéo introuvable' });
    if (!Number(orig.allow_duet)) return res.status(403).json({ error: 'duos non autorisés sur cette vidéo' });
    res.json({ ok: true, original: { id: orig.id, url: orig.url, user_id: orig.user_id } });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.post('/api/videos/:id/stitch', auth, async (req, res) => {
  try {
    const orig = await get1('SELECT * FROM videos WHERE id=?', req.params.id);
    if (!orig) return res.status(404).json({ error: 'vidéo introuvable' });
    if (!Number(orig.allow_stitch)) return res.status(403).json({ error: 'collages non autorisés sur cette vidéo' });
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
    const cols = ['allow_duet', 'allow_stitch', 'allow_download', 'allow_comments', 'visibility', 'location'];
    const sets = [], vals = [];
    if (b.allow_duet !== undefined) { sets.push('allow_duet=?'); vals.push(b.allow_duet ? 1 : 0); }
    if (b.allow_stitch !== undefined) { sets.push('allow_stitch=?'); vals.push(b.allow_stitch ? 1 : 0); }
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
    await runSql("UPDATE message_requests SET status='accepted' WHERE id=?", r.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.post('/api/messages/requests/:id/decline', auth, async (req, res) => {
  try { await runSql("UPDATE message_requests SET status='declined' WHERE id=? AND to_user_id=?", req.params.id, req.userId); res.json({ ok: true }); }
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

// ---------- statut d'activité (en ligne) ----------
app.post('/api/me/heartbeat', auth, async (req, res) => {
  try { await runSql('UPDATE users SET last_seen=? WHERE id=?', now(), req.userId); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.get('/api/users/:username/online', async (req, res) => {
  try {
    const u = await get1('SELECT last_seen, activity_status FROM users WHERE username=?', req.params.username);
    if (!u) return res.status(404).json({ error: 'introuvable' });
    const online = u.activity_status !== 'nobody' && (now() - Number(u.last_seen || 0)) < 120000;
    res.json({ ok: true, online });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});

// ---------- mode restreint ----------
app.post('/api/me/restricted', auth, async (req, res) => {
  try {
    await runSql('UPDATE users SET restricted_mode=? WHERE id=?', (req.body || {}).enabled ? 1 : 0, req.userId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});

// ---------- préférences de notifications ----------
app.get('/api/me/notif-prefs', auth, async (req, res) => {
  try {
    const u = await get1('SELECT notif_likes,notif_comments,notif_follows,notif_mentions,notif_lives FROM users WHERE id=?', req.userId);
    res.json({ ok: true, prefs: u || {} });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});
app.post('/api/me/notif-prefs', auth, async (req, res) => {
  try {
    const b = req.body || {}, sets = [], vals = [];
    for (const k of ['notif_likes', 'notif_comments', 'notif_follows', 'notif_mentions', 'notif_lives']) {
      if (b[k] !== undefined) { sets.push(k + '=?'); vals.push(b[k] ? 1 : 0); }
    }
    if (sets.length) { vals.push(req.userId); await runSql(`UPDATE users SET ${sets.join(',')} WHERE id=?`, ...vals); }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});

// ---------- préférences de confidentialité (façon TikTok) ----------
app.post('/api/me/privacy', auth, async (req, res) => {
  try {
    const b = req.body || {}, sets = [], vals = [];
    const allowed = { dm_privacy: ['everyone', 'friends', 'nobody'], comment_privacy: ['everyone', 'friends', 'nobody'],
      mention_privacy: ['everyone', 'friends', 'nobody'], download_privacy: ['everyone', 'friends', 'nobody'],
      liked_visibility: ['everyone', 'friends', 'me'], following_visibility: ['everyone', 'friends', 'me'],
      activity_status: ['public', 'friends', 'nobody'] };
    for (const k of Object.keys(allowed)) {
      if (b[k] !== undefined && allowed[k].includes(b[k])) { sets.push(k + '=?'); vals.push(b[k]); }
    }
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
app.post('/api/me/content-prefs', auth, async (req, res) => {
  try {
    const topic = String((req.body || {}).topic || '').trim().toLowerCase().slice(0, 50);
    const pref = (req.body || {}).pref === 'less' ? 'less' : 'more';
    if (!topic) return res.status(400).json({ error: 'sujet requis' });
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

// ---------- pages dédiées : lieux ----------
app.get('/api/places/:name/videos', async (req, res) => {
  try {
    const rows = await allRows('SELECT * FROM videos WHERE location=? AND hidden=0 ORDER BY created_at DESC LIMIT 30', req.params.name);
    res.json({ ok: true, videos: rows });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});

// ---------- mentions : notifie les @mentionnés dans un commentaire ----------
async function notifyMentions(text, actorId, videoId) {
  try {
    const mentions = String(text || '').match(/@([a-zA-Z0-9._]{2,20})/g) || [];
    const seen = new Set();
    for (const m of mentions.slice(0, 5)) {
      const uname = m.slice(1).toLowerCase();
      if (seen.has(uname)) continue; seen.add(uname);
      const u = await get1('SELECT id FROM users WHERE LOWER(username)=?', uname);
      if (u && Number(u.id) !== Number(actorId)) {
        await notify(u.id, 'mention', actorId, videoId, '@' + uname + ' vous a mentionné');
      }
    }
  } catch (_) {}
}

// ---------- téléchargement vidéo (si autorisé) ----------
app.get('/api/videos/:id/download-url', auth, async (req, res) => {
  try {
    const v = await get1('SELECT * FROM videos WHERE id=?', req.params.id);
    if (!v) return res.status(404).json({ error: 'vidéo introuvable' });
    if (!Number(v.allow_download)) return res.status(403).json({ error: 'téléchargement non autorisé' });
    res.json({ ok: true, url: v.url });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});

// ---------- vidéos privées (onglet cadenas) ----------
app.get('/api/videos/mine/private', auth, async (req, res) => {
  try {
    const rows = await allRows(`SELECT * FROM videos WHERE user_id=? AND (is_private=1 OR visibility='private') ORDER BY created_at DESC`, req.userId);
    res.json({ ok: true, videos: rows });
  } catch (e) { res.status(500).json({ error: 'erreur serveur' }); }
});

initDb().then(() => {
  publishDue();
  setInterval(publishDue, 60000); // vérifie les publications dues toutes les 60 s
  expireSubs();
  setInterval(expireSubs, 86400000); // désactive les abonnements expirés toutes les 24 h
  setInterval(runVerificationBot, 3600000); // 🤖 bot de vérification toutes les heures
  scheduleDailyCampaigns().catch(()=>{}); // campagnes notif du jour
  setInterval(()=>{scheduleDailyCampaigns().catch(()=>{})}, 3600000); // vérifie chaque heure
  setInterval(()=>{processNotifQueue().catch(()=>{})}, 600000); // traite la file toutes les 10 min
  runVerificationBot().catch(()=>{}); // + au démarrage
  const server = app.listen(PORT, () => console.log(
    `VidiGagne Server v2 sur http://localhost:${PORT} (db=${USE_PG ? 'postgres' : 'sqlite'}, storage=${USE_CLOUDINARY ? 'cloudinary' : 'local'})`));
  setupLiveWs(server); setupPushWs(server);
}).catch(e => { console.error('Échec init DB:', e.message); process.exit(1); });
