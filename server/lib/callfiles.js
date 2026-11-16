'use strict';
// server/lib/callfiles.js — files shared inside a call.
//
// The owner asked for "upload a file" next to the site/video/audio links: the file must be
// shown to everybody in the room, follow the same admin rights / "دسترسی همزمان" rules, and
// exist ONLY while the session is alive — when the last participant leaves the room the file
// is deleted from disk.
//
// Design:
//  * one directory per room (`uploads/call/<roomKey>/`) holding every file uploaded into it;
//  * a random id per file (never the original name) so a URL cannot be guessed and the name
//    is only ever displayed as text (escaped) — nothing of the original name touches the FS;
//  * `GET /black-meet/call-file/:id` is login-gated and only serves files whose id belongs to
//    a room the caller is actually in (a member of the meeting), so a shared link does not
//    leak the file to strangers;
//  * `purgeRoom(roomId)` is called from the room teardown (`internal.closeMeeting`) and also
//    on boot for rooms that are no longer active, so nothing survives a restart.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dbm = require('./db');

const MAX_BYTES = Number(process.env.BM_CALL_FILE_MAX || 50 * 1024 * 1024); // 50 MB

// room ids are what the call page uses; keep them filesystem-safe
function roomKey(roomId) {
  return String(roomId || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
}
function dirFor(roomId) {
  return path.join(dbm.rootDir, 'uploads', 'call', roomKey(roomId));
}
function idOf(roomId, id) {
  const s = String(id || '');
  return /^[a-f0-9]{24,64}$/.test(s) ? s : '';
}

// ---------- mime / extension ----------
const EXT_BY_MIME = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
  'image/bmp': 'bmp', 'image/svg+xml': 'svg', 'image/avif': 'avif',
  'application/pdf': 'pdf',
  'text/plain': 'txt', 'text/csv': 'csv', 'text/markdown': 'md',
  'application/msword': 'doc', 'application/vnd.ms-excel': 'xls',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/zip': 'zip', 'application/json': 'json', 'application/xml': 'xml',
  'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/ogg': 'ogg', 'audio/wav': 'wav',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
  'text/html': 'html', 'application/octet-stream': 'bin',
};
const VIEWABLE = /^(image\/|application\/pdf$|text\/plain$|text\/csv$|text\/html$|video\/|audio\/)/;
// inline is safe only for the types above; everything else is downloaded
function isViewable(mime) { return VIEWABLE.test(String(mime || '')); }

function safeName(name) {
  // keep spaces/dots/dashes (people write real file names), drop anything path- or
  // control-related; the result is only ever DISPLAYED, never used as a path
  const base = String(name || 'file')
    .replace(/[\/\\?%*:|"<>]/g, '_')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim();
  return (base || 'file').slice(0, 120);
}

// ---------- store ----------
// returns {ok, file:{id,name,mime,size,viewable,url,room}} or {ok:false,error}
function store(roomId, userId, file) {
  const key = roomKey(roomId);
  if (!key) return { ok: false, error: 'bad-room' };
  if (!file || !file.buffer || !file.buffer.length) return { ok: false, error: 'empty' };
  if (file.size > MAX_BYTES) return { ok: false, error: 'too-large', max: MAX_BYTES };

  const mime = String(file.mimetype || 'application/octet-stream').toLowerCase().split(';')[0].trim();
  const ext = EXT_BY_MIME[mime] || 'bin';
  const id = crypto.randomBytes(16).toString('hex');
  const dir = dirFor(key);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, id + '.' + ext), file.buffer);

  const meta = {
    id, name: safeName(file.originalname || 'file'), mime, ext,
    size: file.size, viewable: isViewable(mime),
    userId: Number(userId) || 0, room: key, at: new Date().toISOString(),
  };
  try {
    fs.writeFileSync(path.join(dir, id + '.json'), JSON.stringify(meta));
  } catch (e) { /* the file itself is what matters */ }
  return { ok: true, file: meta };
}

// ---------- streaming / staged uploads ----------
// The old path buffered the WHOLE file in RAM (multer memoryStorage) and then wrote it with
// a synchronous fs.writeFileSync: two full copies of a 50 MB buffer plus a blocking write
// that froze the event loop — i.e. every WebRTC packet of the call stalled while somebody
// uploaded a file. `adopt()` takes a file multer streamed to a temp path (diskStorage) and
// renames it into place: no big allocation, no blocking write. `adopt` is also what the
// chunked path finishes with.
function metaFor(id, mime, ext, size, name, userId, key) {
  return {
    id, name: safeName(name || 'file'), mime, ext,
    size, viewable: isViewable(mime),
    userId: Number(userId) || 0, room: key, at: new Date().toISOString(),
  };
}
function writeMeta(key, metaObj) {
  try {
    fs.writeFileSync(path.join(dirFor(key), metaObj.id + '.json'), JSON.stringify(metaObj));
  } catch (e) { /* the file itself is what matters */ }
}

// a single request that multer already streamed to disk (temp path) → final location
function adopt(roomId, userId, file) {
  const key = roomKey(roomId);
  if (!key) { drop(file); return { ok: false, error: 'bad-room' }; }
  if (!file || !file.path) return { ok: false, error: 'empty' };
  let size = Number(file.size) || 0;
  try { size = fs.statSync(file.path).size; } catch (e) {
    return { ok: false, error: 'empty' };
  }
  if (!size) { drop(file); return { ok: false, error: 'empty' }; }
  if (size > MAX_BYTES) { drop(file); return { ok: false, error: 'too-large', max: MAX_BYTES }; }
  const mime = String(file.mimetype || 'application/octet-stream').toLowerCase().split(';')[0].trim();
  const ext = EXT_BY_MIME[mime] || 'bin';
  const id = crypto.randomBytes(16).toString('hex');
  const dir = dirFor(key);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { return { ok: false, error: 'store' }; }
  const target = path.join(dir, id + '.' + ext);
  try {
    fs.renameSync(file.path, target);
  } catch (e) {
    // another volume (or a locked temp file): copy + unlink
    try { fs.copyFileSync(file.path, target); fs.unlinkSync(file.path); } catch (e2) {
      drop(file);
      return { ok: false, error: 'store' };
    }
  }
  const metaObj = metaFor(id, mime, ext, size, file.originalname, userId, key);
  writeMeta(key, metaObj);
  return { ok: true, file: metaObj };
}

function drop(file) {
  try { if (file && file.path) fs.unlinkSync(file.path); } catch (e) { /* already gone */ }
}

// ---------- chunked upload ----------
// A single TCP stream on a lossy Iranian uplink is far slower than the link itself, and one
// dropped connection at 90% used to lose the whole file. The client now sends ~1 MB parts
// (a few in parallel) and a part that fails is retried on its own.
const MAX_PARTS = 600;

function partKey(uploadId) {
  const s = String(uploadId || '');
  return /^[a-f0-9]{16,64}$/.test(s) ? s : '';
}
function partsDir(roomId, uploadId) {
  const k = roomKey(roomId), u = partKey(uploadId);
  if (!k || !u) return null;
  return path.join(dirFor(k), '_parts', u);
}
function partName(i) { return String(i).padStart(4, '0') + '.part'; }

function savePart(roomId, uploadId, index, total, buffer) {
  const dir = partsDir(roomId, uploadId);
  if (!dir) return { ok: false, error: 'bad-upload' };
  const i = Number(index), t = Number(total);
  if (!Number.isInteger(i) || i < 0 || i >= MAX_PARTS) return { ok: false, error: 'bad-index' };
  if (!Number.isInteger(t) || t < 1 || t > MAX_PARTS) return { ok: false, error: 'bad-total' };
  if (!buffer || !buffer.length) return { ok: false, error: 'empty' };
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, partName(i)), buffer);
  } catch (e) { return { ok: false, error: 'store' }; }
  return { ok: true, index: i };
}

// assemble the parts into one file (streamed part by part — never the whole file in RAM)
async function finishParts(roomId, userId, o) {
  o = o || {};
  const key = roomKey(roomId);
  const dir = partsDir(roomId, o.uploadId);
  if (!key || !dir) return { ok: false, error: 'bad-upload' };
  const total = Number(o.total);
  if (!Number.isInteger(total) || total < 1 || total > MAX_PARTS) return { ok: false, error: 'bad-total' };
  const claimed = Number(o.size) || 0;
  if (claimed > MAX_BYTES) return { ok: false, error: 'too-large', max: MAX_BYTES };

  let bytes = 0;
  for (let i = 0; i < total; i++) {
    try {
      const st = fs.statSync(path.join(dir, partName(i)));
      bytes += st.size;
    } catch (e) {
      return { ok: false, error: 'missing-part', index: i };
    }
  }
  if (!bytes) return { ok: false, error: 'empty' };
  if (bytes > MAX_BYTES) return { ok: false, error: 'too-large', max: MAX_BYTES };

  const mime = String(o.mime || 'application/octet-stream').toLowerCase().split(';')[0].trim();
  const ext = EXT_BY_MIME[mime] || 'bin';
  const id = crypto.randomBytes(16).toString('hex');
  const target = path.join(dirFor(key), id + '.' + ext);

  const out = fs.createWriteStream(target);
  const finished = new Promise((res, rej) => { out.on('finish', res); out.on('error', rej); });
  try {
    for (let i = 0; i < total; i++) {
      const src = path.join(dir, partName(i));
      // eslint-disable-next-line no-await-in-loop
      await new Promise((res, rej) => {
        const rs = fs.createReadStream(src);
        rs.on('error', rej);
        rs.on('end', res);
        rs.pipe(out, { end: false });
      });
    }
    out.end();
    await finished;
  } catch (e) {
    try { out.destroy(); } catch (e2) { /* noop */ }
    try { fs.unlinkSync(target); } catch (e2) { /* noop */ }
    return { ok: false, error: 'assemble' };
  }
  const metaObj = metaFor(id, mime, ext, bytes, o.name, userId, key);
  writeMeta(key, metaObj);
  removeParts(roomId, o.uploadId);
  return { ok: true, file: metaObj };
}

function removeParts(roomId, uploadId) {
  const dir = partsDir(roomId, uploadId);
  if (!dir) return;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* noop */ }
  try {
    const parent = path.join(dirFor(roomKey(roomId)), '_parts');
    if (!fs.readdirSync(parent).length) fs.rmdirSync(parent);
  } catch (e) { /* not empty / already gone */ }
}

// temp files multer wrote but nobody finished (server restarted mid-upload)
function purgeIncoming() {
  let base;
  try { base = path.join(dbm.rootDir, 'uploads', 'call', '_incoming'); } catch (e) { return 0; }
  let n = 0;
  try {
    fs.readdirSync(base).forEach((f) => {
      try { fs.unlinkSync(path.join(base, f)); n++; } catch (e) { /* noop */ }
    });
  } catch (e) { return 0; }
  if (n) console.log('[callfiles] dropped ' + n + ' unfinished upload(s)');
  return n;
}

function meta(roomId, id) {
  const k = roomKey(roomId), f = idOf(k, id);
  if (!f) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(dirFor(k), f + '.json'), 'utf8'));
  } catch (e) { return null; }
}

function filePath(roomId, id) {
  const k = roomKey(roomId), f = idOf(k, id);
  if (!f) return null;
  const dir = dirFor(k);
  let file = null;
  try { file = fs.readdirSync(dir).find((n) => n.slice(0, f.length) === f && n.slice(f.length) !== '.json'); } catch (e) { return null; }
  return file ? path.join(dir, file) : null;
}

// ---------- downloads ----------
// The owner asked the file box to show HOW MANY TIMES a file was downloaded and to open a
// window listing WHO downloaded it (display name + count). The counters live in SQLite:
// the bytes are deleted with the session, the numbers are not.
function noteDownload(roomId, id, userId, name) {
  const key = roomKey(roomId);
  const fid = idOf(key, id);
  const uid = Number(userId);
  if (!key || !fid || !Number.isInteger(uid) || uid <= 0) return null;
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  // the same `YYYY-MM-DD HH:MM:SS` shape the rest of the app stores (helpers.timeAgo parses it)
  const now = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
    p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  try {
    dbm.run(
      `INSERT INTO call_file_downloads (room, file_id, file_name, user_id, count, first_at, last_at)
       VALUES (?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT(file_id, user_id) DO UPDATE SET
         count = call_file_downloads.count + 1,
         last_at = excluded.last_at`,
      [key, fid, safeName(name || ''), uid, now, now]
    );
  } catch (e) { return null; }
  return downloadStats(key, fid);
}

// { total, users:[{ user_id, count, last_at, name, display_name, avatar }] }
function downloadStats(roomId, id) {
  const key = roomKey(roomId);
  const fid = idOf(key, id);
  if (!key || !fid) return { total: 0, users: [] };
  let rows = [];
  try {
    rows = dbm.all(
      `SELECT d.user_id, d.count, d.last_at, d.first_at,
              u.display_name, u.username, u.full_name, u.avatar, u.avatar_color, u.rank, u.is_manager
         FROM call_file_downloads d
         LEFT JOIN users u ON u.id = d.user_id
        WHERE d.room = ? AND d.file_id = ?
        ORDER BY d.count DESC, d.last_at DESC`,
      [key, fid]
    );
  } catch (e) { return { total: 0, users: [] }; }
  const users = rows.map((r) => ({
    user_id: Number(r.user_id),
    count: Number(r.count) || 0,
    last_at: r.last_at || '',
    first_at: r.first_at || '',
    name: r.display_name || r.full_name || r.username || ('کاربر ' + r.user_id),
    username: r.username || '',
    avatar: r.avatar || '',
    avatar_color: r.avatar_color || '',
    is_manager: !!r.is_manager,
    rank: r.rank || (r.is_manager ? 'manager' : 'user'),
  }));
  return { total: users.reduce((s, u) => s + u.count, 0), users };
}

function purgeDownloads(roomId) {
  const key = roomKey(roomId);
  if (!key) return 0;
  try {
    const r = dbm.run('DELETE FROM call_file_downloads WHERE room = ?', [key]);
    return r && r.changes ? r.changes : 0;
  } catch (e) { return 0; }
}

// ---------- lifecycle ----------
// delete every file of a room (called when the last member leaves)
function purgeRoom(roomId) {
  const key = roomKey(roomId);
  if (!key) return 0;
  const dir = dirFor(key);
  let n = 0;
  try {
    n = fs.readdirSync(dir).length;
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) { /* nothing to delete */ }
  if (n) console.log('[callfiles] removed ' + n + ' file(s) of room ' + key);
  purgeDownloads(key);
  return n;
}

// a file stays only as long as its session: drop everything that belongs to a room that is
// no longer active (called on boot)
function purgeInactive() {
  let rooms = [];
  try { rooms = dbm.all("SELECT room_id FROM meetings WHERE active=1").map((m) => m.room_id); } catch (e) { return 0; }
  const live = {};
  rooms.forEach((r) => { live[roomKey(r)] = true; });
  let base;
  try { base = path.join(dbm.rootDir, 'uploads', 'call'); } catch (e) { return 0; }
  let dirs = [];
  try { dirs = fs.readdirSync(base); } catch (e) { return 0; }
  let n = 0;
  dirs.forEach((d) => {
    if (!live[d]) { try { fs.rmSync(path.join(base, d), { recursive: true, force: true }); n++; } catch (e) {} }
  });
  if (n) console.log('[callfiles] purged ' + n + ' stale room folder(s) on boot');
  return n;
}

module.exports = {
  store, adopt, meta, filePath, purgeRoom, purgeInactive, purgeIncoming,
  savePart, finishParts, removeParts, MAX_PARTS,
  noteDownload, downloadStats, purgeDownloads,
  MAX_BYTES, isViewable, safeName, roomKey,
};