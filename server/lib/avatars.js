'use strict';
// server/lib/avatars.js — profile pictures stored in the DATABASE (and mirrored to Neon).
//
// Why: the old uploader wrote the file to `uploads/avatars/<id>.<ext>` and only kept that
// path in `users.avatar`. On a host with an ephemeral disk (Render free) the file was gone
// after every deploy/restart while the DB (restored from Neon) still had the path, so the
// page rendered a broken image — exactly "the picture is not saved / does not show again".
//
// Now the bytes live in `bm_avatars` (SQLite) and in the Neon mirror, and
// `GET /black-meet/uploads/avatars/<id>.<ext>` serves them from the DB, so the URL stays
// the same and every existing renderer (templates, messages.js, call.js, admin_members.js,
// socket payloads) keeps working without changes.
//
// `users.avatar` holds `uploads/avatars/<id>.<ext>?v=<epoch-ms>`: the version in the URL is
// what makes a changed picture show up immediately even though the response is cached hard.
const fs = require('fs');
const path = require('path');
const dbm = require('./db');
const neon = require('./neon');

const MAX_BYTES = 2 * 1024 * 1024;
const ALLOWED = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' };
const MIME_BY_EXT = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };
const DIR_REL = 'uploads/avatars';
const EXT_RE = '(jpg|jpeg|png|gif|webp)';

// user_id -> updated_at, so rendering a page full of avatars is not a query per image
const _ver = new Map();

function relFor(userId, ext) { return DIR_REL + '/' + Number(userId) + '.' + ext; }
function versionedRel(userId, ext, at) { return relFor(userId, ext) + '?v=' + Number(at); }

// "12.png" -> 12 (the file name of the public route)
function userIdFromFile(name) {
  const m = new RegExp('^(\\d+)\\.' + EXT_RE + '$', 'i').exec(String(name || ''));
  return m ? Number(m[1]) : 0;
}

// "uploads/avatars/12.png?v=1762…" -> 12
function userIdFromRel(rel) {
  const clean = String(rel || '').replace(/[?#].*$/, '');
  const m = new RegExp('(?:^|/)(\\d+)\\.' + EXT_RE + '$', 'i').exec(clean);
  return m ? Number(m[1]) : 0;
}

function get(userId) {
  const id = Number(userId);
  if (!id) return null;
  let row = null;
  try {
    row = dbm.get('SELECT user_id, mime, ext, data, updated_at FROM bm_avatars WHERE user_id=?', [id]);
  } catch (e) { return null; }
  if (!row || !row.data || !row.data.length) return null;
  return {
    userId: Number(row.user_id),
    mime: row.mime || 'image/png',
    ext: row.ext || 'png',
    data: Buffer.from(row.data),
    length: Number(row.data.length),
    updatedAt: Number(row.updated_at) || 0,
  };
}

function version(userId) {
  const id = Number(userId);
  if (!id) return 0;
  if (_ver.has(id)) return _ver.get(id);
  let v = 0;
  try {
    const row = dbm.get('SELECT updated_at FROM bm_avatars WHERE user_id=?', [id]);
    if (row && row.updated_at) v = Number(row.updated_at) || 0;
  } catch (e) { v = 0; }
  _ver.set(id, v);
  return v;
}

// raw row write, no side effects (used by put/import/pull)
function store(userId, mime, ext, data, updatedAt) {
  dbm.run(
    'INSERT INTO bm_avatars (user_id, mime, ext, data, updated_at) VALUES (?,?,?,?,?) ' +
    'ON CONFLICT(user_id) DO UPDATE SET mime=excluded.mime, ext=excluded.ext, ' +
    'data=excluded.data, updated_at=excluded.updated_at',
    [Number(userId), mime, ext, data, Number(updatedAt)]
  );
  _ver.set(Number(userId), Number(updatedAt));
}

// the old disk copies of this user's picture are useless now — never let one be served
// (express.static is the fallback for legacy rows, so a stale file would win a race)
function removeLegacyFiles(userId) {
  const dir = path.join(dbm.rootDir, DIR_REL);
  for (const ext of Object.keys(MIME_BY_EXT)) {
    const p = path.join(dir, Number(userId) + '.' + ext);
    try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (e) { /* ignore */ }
  }
}

// Store a new picture for one user: DB row + users.avatar + Neon mirror.
function put(userId, mime, buffer) {
  const id = Number(userId);
  const data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  const type = String(mime || '').toLowerCase().split(';')[0].trim();
  if (!id) return { ok: false, msg: 'کاربر نامعتبر است' };
  if (!data.length) return { ok: false, msg: 'فایل خالی است' };
  if (data.length > MAX_BYTES) return { ok: false, msg: 'حجم تصویر بیش از ۲ مگابایت است' };
  if (!ALLOWED[type]) return { ok: false, msg: 'فرمت تصویر پشتیبانی نمی‌شود' };
  const ext = ALLOWED[type];
  const now = Date.now();
  try {
    store(id, type, ext, data, now);
  } catch (e) {
    console.warn('[avatars] store failed: ' + e.message);
    return { ok: false, msg: 'ذخیره تصویر ناموفق بود' };
  }
  removeLegacyFiles(id);
  const rel = versionedRel(id, ext, now);
  try {
    dbm.run('UPDATE users SET avatar=? WHERE id=?', [rel, id]);
    require('./usersdb').syncUser(id);
  } catch (e) {
    // the picture itself is safe; users.avatar is repaired on the next boot by init()
    console.warn('[avatars] users.avatar update failed: ' + e.message);
  }
  neon.pushAvatar({ user_id: id, mime: type, ext: ext, data: data, updated_at: now }).catch(() => {});
  return { ok: true, rel: rel, mime: type, ext: ext, size: data.length, updatedAt: now };
}

function remove(userId) {
  const id = Number(userId);
  if (!id) return false;
  try { dbm.run('DELETE FROM bm_avatars WHERE user_id=?', [id]); } catch (e) { /* ignore */ }
  _ver.delete(id);
  removeLegacyFiles(id);
  try { dbm.run('UPDATE users SET avatar=NULL WHERE id=?', [id]); } catch (e) { /* ignore */ }
  neon.removeAvatar(id).catch(() => {});
  return true;
}

// GET /black-meet/uploads/avatars/<id>.<ext>
// Serves the DB bytes; `next()` when there is no row so express.static can still answer
// for a picture that exists only on disk (old installs / a just-uploaded legacy file).
function serve(req, res, next) {
  const id = userIdFromFile(req.params.file);
  if (!id) return next();
  const row = get(id);
  if (!row) return next();
  const tag = 'W/"av' + row.updatedAt + '-' + row.length + '"';
  res.setHeader('Content-Type', row.mime);
  res.setHeader('ETag', tag);
  // the URL carries ?v=<version> (see users.avatar), so a new picture = a new URL
  res.setHeader('Cache-Control', 'public, max-age=2592000, immutable');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.headers['if-none-match'] === tag) return res.status(304).end();
  res.setHeader('Content-Length', row.length);
  return res.end(row.data);
}

// ---- boot time: pull from Neon, adopt old files, drop paths that point at nothing -----

async function pullFromNeon() {
  if (!neon.enabled()) return { n: 0, ok: true };
  let rows = null;
  try { rows = await neon.pullAvatars(); } catch (e) { console.warn('[avatars] neon pull failed: ' + e.message); }
  // null = the mirror could not be read (unreachable/timeout). That is NOT "no pictures":
  // the caller must not adopt stale disk files over a newer remote picture.
  if (!Array.isArray(rows)) {
    console.warn('[avatars] neon pull unavailable — skipping the legacy-file import this boot');
    return { n: 0, ok: false };
  }
  let n = 0;
  for (const r of rows) {
    const id = Number(r.user_id);
    if (!id || !r.data || !r.data.length) continue;
    const local = get(id);
    if (local && local.updatedAt >= Number(r.updated_at || 0)) continue;
    const ext = String(r.ext || 'png').toLowerCase();
    const mime = r.mime || MIME_BY_EXT[ext] || 'image/png';
    try {
      store(id, mime, MIME_BY_EXT[ext] ? ext : 'png', Buffer.from(r.data), Number(r.updated_at) || Date.now());
      n++;
    } catch (e) { /* one bad row must not stop the rest */ }
  }
  return { n: n, ok: true };
}

// A file on disk is by definition at least as old as its mtime. Stamping the import with
// Date.now() made an old file beat a freshly uploaded picture in `bm_avatars` (and then get
// pushed over the newer Neon row) — the "my new photo reverted after a deploy" case.
function fileStamp(abs) {
  try {
    const st = fs.statSync(abs);
    const ms = Math.floor(Number(st.mtimeMs) || 0);
    return ms > 0 ? ms : Date.now();
  } catch (e) { return Date.now(); }
}

// Old installs kept the picture on disk only. Read it into the DB once, so it survives a
// deploy like every new one (and the served URL keeps a version, which it never had).
// Only when there is no row at all for that user, and never with a "now" timestamp.
function importLegacyFiles() {
  let rows = [];
  try {
    rows = dbm.all("SELECT id, avatar FROM users WHERE avatar IS NOT NULL AND avatar <> ''");
  } catch (e) { return 0; }
  let n = 0;
  for (const u of rows) {
    const id = Number(u.id);
    const raw = String(u.avatar || '');
    if (!id || /^https?:\/\//i.test(raw)) continue;
    if (get(id)) continue;
    if (userIdFromRel(raw) !== id) continue;      // not this user's own file
    const clean = raw.replace(/^\/+/, '').replace(/[?#].*$/, '');
    if (clean.indexOf(DIR_REL + '/') !== 0 || clean.indexOf('..') !== -1) continue;
    const abs = path.join(dbm.rootDir, clean);
    let buf;
    try { if (!fs.existsSync(abs)) continue; buf = fs.readFileSync(abs); } catch (e) { continue; }
    if (!buf.length || buf.length > MAX_BYTES) continue;
    const ext = path.extname(abs).slice(1).toLowerCase();
    const mime = MIME_BY_EXT[ext];
    if (!mime) continue;
    const at = fileStamp(abs);
    try {
      store(id, mime, ext === 'jpeg' ? 'jpg' : ext, buf, at);
      dbm.run('UPDATE users SET avatar=? WHERE id=?', [versionedRel(id, ext === 'jpeg' ? 'jpg' : ext, at), id]);
      n++;
    } catch (e) { /* keep going */ }
  }
  return n;
}

// `users.avatar` can disagree with the stored row: a database restored from the archive/Neon
// carries the path of a picture uploaded on another instance (a different extension, usually
// the file that no longer exists). The row is the truth — point the user at it.
function reconcileUsersAvatar() {
  let rows = [];
  try {
    rows = dbm.all('SELECT id, avatar FROM users');
  } catch (e) { return 0; }
  let n = 0;
  for (const u of rows) {
    const id = Number(u.id);
    if (!id) continue;
    const row = get(id);
    if (!row) continue;
    const want = versionedRel(id, row.ext, row.updatedAt);
    if (String(u.avatar || '') === want) continue;
    try {
      dbm.run('UPDATE users SET avatar=? WHERE id=?', [want, id]);
      n++;
    } catch (e) { /* keep going */ }
  }
  return n;
}

// users.avatar that has neither a DB row nor a file = the broken <img> from the report.
// Clearing it makes every renderer fall back to the initials badge instead.
function purgeDangling() {
  let rows = [];
  try {
    rows = dbm.all("SELECT id, avatar FROM users WHERE avatar IS NOT NULL AND avatar <> ''");
  } catch (e) { return 0; }
  let n = 0;
  for (const u of rows) {
    const id = Number(u.id);
    const raw = String(u.avatar || '');
    if (!id || /^https?:\/\//i.test(raw)) continue;
    if (get(id)) continue;
    const clean = raw.replace(/^\/+/, '').replace(/[?#].*$/, '');
    const abs = clean && clean.indexOf('..') === -1 ? path.join(dbm.rootDir, clean) : null;
    let onDisk = false;
    try { onDisk = !!(abs && fs.existsSync(abs)); } catch (e) { onDisk = false; }
    if (onDisk) continue;
    try {
      dbm.run('UPDATE users SET avatar=NULL WHERE id=?', [id]);
      require('./usersdb').syncUser(id);
      _ver.delete(id);
      n++;
    } catch (e) { /* keep going */ }
  }
  return n;
}

// Called once on boot (after usersdb.boot/ensureAdmin): Neon -> local, old files -> rows,
// users.avatar -> the row it actually has, dead paths -> NULL. Also pushes every local
// picture up so Neon is an exact mirror.
async function init() {
  _ver.clear();
  const pull = await pullFromNeon();
  // adopt disk files ONLY when we know the mirror has nothing newer to say
  const imported = pull.ok ? importLegacyFiles() : 0;
  const repaired = reconcileUsersAvatar();
  const purged = purgeDangling();
  let pushed = 0;
  if (neon.enabled()) {
    let rows = [];
    try { rows = dbm.all('SELECT user_id, mime, ext, data, updated_at FROM bm_avatars'); } catch (e) { rows = []; }
    if (rows.length) {
      try {
        const r = await neon.pushAvatars(rows.map((x) => ({
          user_id: Number(x.user_id), mime: x.mime, ext: x.ext,
          data: Buffer.from(x.data), updated_at: Number(x.updated_at),
        })));
        pushed = r || 0;
      } catch (e) { /* Neon is optional */ }
    }
  }
  if (pull.n || imported || repaired || purged || pushed || !pull.ok) {
    console.log('[avatars] pulled=' + pull.n + ' imported=' + imported + ' repaired=' + repaired +
      ' purged=' + purged + ' pushed=' + pushed + (pull.ok ? '' : ' (neon pull unavailable)'));
  }
  return { pulled: pull.n, imported: imported, repaired: repaired, purged: purged, pushed: pushed, pullOk: pull.ok };
}

function stats() {
  let n = 0;
  try { n = dbm.get('SELECT COUNT(*) AS n FROM bm_avatars').n; } catch (e) { n = 0; }
  return { stored: Number(n) || 0, neon: neon.enabled() };
}

module.exports = {
  put, get, version, remove, serve, init, stats,
  userIdFromFile, userIdFromRel, relFor, versionedRel,
  ALLOWED, MAX_BYTES, DIR_REL,
};
