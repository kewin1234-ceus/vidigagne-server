// Tests ciblés serveur v13 : replay, TTS, "pourquoi cette vidéo"
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = 18013;
const DB = '/tmp/vg13-test.db';
const UPDIR = '/tmp/vg13-uploads';
try { fs.unlinkSync(DB); } catch (e) {}
try { fs.rmSync(UPDIR, { recursive: true }); } catch (e) {}

const env = Object.assign({}, process.env, {
  PORT: String(PORT), SQLITE_PATH: DB, UPLOAD_DIR: UPDIR,
  CLOUDINARY_CLOUD_NAME: '', CLOUDINARY_API_KEY: '', CLOUDINARY_API_SECRET: '',
});
const srv = spawn('node', ['server.js'], { cwd: __dirname, env, stdio: 'pipe' });
let out = '';
srv.stdout.on('data', d => out += d);
srv.stderr.on('data', d => out += d);

const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  OK  ' + name); }
  else { fail++; console.log('  FAIL ' + name); }
}
async function req(method, p, token, body, file) {
  const headers = {};
  if (token) headers['authorization'] = 'Bearer ' + token;
  let b;
  if (file) {
    const fd = new FormData();
    for (const k of Object.keys(body || {})) fd.append(k, body[k]);
    fd.append('video', new Blob([fs.readFileSync(file)], { type: 'video/mp4' }), 't.mp4');
    b = fd;
  } else if (body) { headers['content-type'] = 'application/json'; b = JSON.stringify(body); }
  const r = await fetch('http://127.0.0.1:' + PORT + p, { method, headers, body: b, duplex: 'half' });
  let d = null; try { d = await r.json(); } catch (e) {}
  return { ok: r.ok, status: r.status, d };
}

(async () => {
  for (let i = 0; i < 60 && !out.includes('VidiGagne Server'); i++) await sleep(500);
  await sleep(1500);
  // mini fichier vidéo factice
  const fake = '/tmp/vg13-fake.mp4';
  fs.writeFileSync(fake, Buffer.alloc(2048, 0));

  // 1. inscription créateur + spectateur
  let r = await req('POST', '/api/auth/register', null, { username: 'crea13', name: 'Crea', password: 'pass1234' });
  ok(r.ok && r.d.token, 'inscription créateur');
  const tC = r.d.token;
  r = await req('POST', '/api/auth/register', null, { username: 'view13', name: 'View', password: 'pass1234' });
  ok(r.ok && r.d.token, 'inscription spectateur');
  const tV = r.d.token;

  // 2. publication avec TTS + replay
  r = await req('POST', '/api/videos', tC, {
    desc: 'Ma vidéo #humour', tags: 'humour',
    tts_text: 'Salut les amis !', tts_voice: 'fr-1', tts_rate: '1.2',
    is_replay: '1', live_id: '42',
  }, fake);
  ok(r.ok, 'upload vidéo avec TTS+replay accepté');
  const v1 = r.d.video || {};
  ok(v1.is_replay === 1, 'is_replay=1 retourné');
  ok(v1.live_id === 42, 'live_id=42 retourné');
  ok(v1.tts && v1.tts.text === 'Salut les amis !', 'tts.text retourné');
  ok(v1.tts && v1.tts.voice === 'fr-1', 'tts.voice retourné');
  ok(Math.abs((v1.tts && v1.tts.rate) - 1.2) < 0.01, 'tts.rate=1.2 retourné');

  // 3. tts_rate borné
  r = await req('POST', '/api/videos', tC, { desc: 'x', tts_text: 'yo', tts_rate: '99' }, fake);
  ok(r.ok && Math.abs(r.d.video.tts.rate - 2) < 0.01, 'tts_rate borné à 2');

  // 4. vidéo normale sans TTS → tts vide
  r = await req('POST', '/api/videos', tC, { desc: 'normale #humour', tags: 'humour' }, fake);
  ok(r.ok && r.d.video.tts.text === '' && r.d.video.is_replay === 0, 'vidéo normale : tts vide, is_replay=0');
  const v3 = r.d.video;

  // 5. le spectateur regarde la vidéo 1 en entier (completed=1)
  r = await req('POST', '/api/watch', tV, { video_id: v1.id, watch_ms: 5000, completed: 1 });
  ok(r.ok, 'watch event completed=1 enregistré');

  // 6. feed "pour toi" du spectateur → why présent avec raison tags
  r = await req('GET', '/api/feed?mode=foryou', tV);
  ok(r.ok && Array.isArray(r.d.videos), 'feed pour-toi ok');
  const fv3 = (r.d.videos || []).find(v => v.id === v3.id);
  ok(!!fv3, 'la vidéo #humour est dans le feed');
  ok(fv3 && Array.isArray(fv3.why) && fv3.why.length > 0, 'why présent et non vide');
  ok(fv3 && fv3.why.some(w => w.includes('#humour') || w.includes('Tags')), 'why mentionne les tags aimés (affinité tags)');
  console.log('   why=' + JSON.stringify(fv3 && fv3.why));

  // 7. feed anonyme → why null
  r = await req('GET', '/api/feed?mode=foryou', null);
  const av = (r.d.videos || [])[0];
  ok(!av || av.why === null || av.why === undefined, 'feed anonyme : pas de why');

  // 8. GET vidéo directe → champs v13 présents
  r = await req('GET', '/api/videos/' + v1.id, tV);
  ok(r.ok && r.d.video.is_replay === 1 && r.d.video.tts.text === 'Salut les amis !', 'GET /api/videos/:id → champs v13');

  console.log('\n' + pass + ' réussis, ' + fail + ' échoués');
  srv.kill();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERREUR', e); srv.kill(); process.exit(2); });
