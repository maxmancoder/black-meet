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

module.exports = { store, meta, filePath, purgeRoom, purgeInactive, MAX_BYTES, isViewable, safeName, roomKey };