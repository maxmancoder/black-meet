'use strict';
// server/lib/usersdb.js — a SEPARATE, self-contained archive of every user account.
//
// Why: on hosts with an ephemeral disk (Render free) the main SQLite file is wiped on
// every deploy/restart, so accounts would disappear. This file mirrors the full `users`
// table (display name, username, email, phone, role/rank and the password HASH) into
// `users_archive.db`, restores the accounts when the main DB comes back empty, and can
// export a snapshot on every change so a copy exists outside the running container.
//
// Security notes:
//  - the password column holds the same bcrypt HASH the app already stores, never a plain
//    password (approval-mode signups used to keep the plain text — that is fixed in api.js);
//  - the archive file must NOT be served over HTTP; the export endpoints are manager-only.
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const neon = require('./neon');
const neonEnabled = neon.enabled;
const neonPushAll = neon.pushAll;
const neonPullAll = neon.pullAll;
const neonInfo = neon.info;

const rootDir = path.resolve(__dirname, '..', '..');
const ARCHIVE_PATH = process.env.BM_USERS_DB_PATH || path.join(rootDir, 'users_archive.db');
const EXPORT_DIR = process.env.BM_USERS_DB_EXPORT_DIR || '';

// every column of `users` is mirrored, so a restore rebuilds complete accounts
const COLUMNS = [
  'id', 'full_name', 'username', 'email', 'phone', 'display_name',
  'password_hash', 'is_manager', 'is_limited', 'rank',
  'avatar_color', 'avatar', 'created_at',
];

let _a = null;
let _timer = null;

function archive() {
  if (_a) return _a;
  fs.mkdirSync(path.dirname(ARCHIVE_PATH), { recursive: true });
  _a = new DatabaseSync(ARCHIVE_PATH);
  _a.exec('PRAGMA journal_mode = WAL;');
  _a.exec(`CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY,
    full_name     TEXT, username TEXT, email TEXT, phone TEXT, display_name TEXT,
    password_hash TEXT, is_manager INTEGER DEFAULT 0, is_limited INTEGER DEFAULT 0,
    rank          TEXT DEFAULT 'user', avatar_color TEXT, avatar TEXT,
    created_at    TEXT, updated_at TEXT DEFAULT (datetime('now'))
  );`);
  _a.exec(`CREATE TABLE IF NOT EXISTS sync_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    at         TEXT DEFAULT (datetime('now')),
    user_id    INTEGER, action TEXT, detail TEXT
  );`);
  // unique keys so a restore can spot conflicts by email/username/phone
  _a.exec('CREATE INDEX IF NOT EXISTS idx_archive_username ON users(username);');
  return _a;
}

function dbm() { return require('./db'); }

// --- optional Neon/Postgres mirror ---------------------------------------------
// Inert unless NEON_DATABASE_URL is set. Pushes are debounced and never awaited by the
// request path, so a slow or unreachable database can never delay a signup or a login.
let _neonTimer = null;
let _neonLast = { at: null, result: null, reason: null };

function neonSchedule(reason) {
  if (!neonEnabled()) return;
  if (_neonTimer) return;
  _neonTimer = setTimeout(async () => {
    _neonTimer = null;
    try {
      const rows = archive().prepare('SELECT ' + COLUMNS.join(',') + ' FROM users').all();
      const res = await neonPushAll(rows);
      _neonLast = { at: new Date().toISOString(), reason: reason || 'sync', result: res };
    } catch (e) { /* the mirror is a safety net, never fatal */ }
  }, 2000);
  if (_neonTimer.unref) _neonTimer.unref();
}

function neonStatus() {
  const i = neonInfo();
  return Object.assign(i, { lastSync: _neonLast.at, lastResult: _neonLast.result, lastReason: _neonLast.reason });
}

// fill the local archive from Neon (only used when BOTH the live DB and the archive are
// empty, i.e. a brand-new instance whose disk was wiped)
async function neonRestoreArchive() {
  if (!neonEnabled()) return 0;
  let rows = [];
  try { rows = await neonPullAll(); } catch (e) { return 0; }
  if (!Array.isArray(rows) || !rows.length) return 0;
  try {
    const a = archive();
    const cols = COLUMNS.concat('updated_at');
    for (const r of rows) {
      const vals = COLUMNS.map((c) => (r[c] === undefined ? null : r[c]));
      a.prepare(
        'INSERT OR REPLACE INTO users (' + cols.join(',') + ') VALUES (' + cols.map(() => '?').join(',') + ')'
      ).run(...vals.concat([new Date().toISOString().replace('T', ' ').slice(0, 19)]));
    }
    console.log('[neon] pulled ' + rows.length + ' account(s) into the local archive');
    return rows.length;
  } catch (e) {
    console.warn('[neon] could not write the pulled accounts: ' + e.message);
    return 0;
  }
}

function rowToArchive(row) {
  const out = {};
  COLUMNS.forEach((c) => { out[c] = row[c] === undefined ? null : row[c]; });
  return out;
}

// copy one account into the archive (insert or replace)
function syncUser(userId) {
  const id = parseInt(userId, 10);
  if (!Number.isInteger(id)) return false;
  let row;
  try {
    row = dbm().get('SELECT ' + COLUMNS.join(',') + ' FROM users WHERE id=?', [id]);
  } catch (e) { return false; }
  const a = archive();
  if (!row) {
    // the account was removed: drop it from the mirror (with a log entry)
    try {
      a.prepare('DELETE FROM users WHERE id=?').run(id);
      a.prepare('INSERT INTO sync_log (user_id, action, detail) VALUES (?,?,?)').run(id, 'delete', '');
    } catch (e) {}
    neon.removeUser(id);
    return true;
  }
  const r = rowToArchive(row);
  const cols = COLUMNS.concat('updated_at');
  const vals = COLUMNS.map((c) => r[c]);
  try {
    a.prepare(
      'INSERT OR REPLACE INTO users (' + cols.join(',') + ") VALUES (" + cols.map(() => '?').join(',') + ')' +
      " ON CONFLICT(id) DO UPDATE SET " + COLUMNS.slice(1).map((c) => c + '=excluded.' + c).join(',')
    ).run(...vals);
    a.prepare('INSERT INTO sync_log (user_id, action) VALUES (?,?)').run(id, 'sync');
    neonSchedule('user ' + id);
  } catch (e) {
    console.warn('[usersdb] sync failed for user ' + id + ': ' + e.message);
    return false;
  }
  return true;
}

// full mirror (boot + periodic safety net)
function syncAll() {
  let rows = [];
  try { rows = dbm().all('SELECT ' + COLUMNS.join(',') + ' FROM users'); } catch (e) { return 0; }
  const a = archive();
  let n = 0;
  rows.forEach((row) => {
    const r = rowToArchive(row);
    const cols = COLUMNS.concat('updated_at');
    try {
      a.prepare(
        'INSERT OR REPLACE INTO users (' + cols.join(',') + ") VALUES (" + cols.map(() => '?').join(',') + ')' +
        " ON CONFLICT(id) DO UPDATE SET " + COLUMNS.slice(1).map((c) => c + '=excluded.' + c).join(',')
      ).run(...COLUMNS.map((c) => r[c]));
      n++;
    } catch (e) { /* skip the broken row, keep the rest */ }
  });
  return n;
}

// write a plain .json + .db snapshot to a durable directory when one is configured
function exportSnapshot() {
  if (!EXPORT_DIR) return false;
  try {
    fs.mkdirSync(EXPORT_DIR, { recursive: true });
    const a = archive();
    const rows = a.prepare('SELECT ' + COLUMNS.join(',') + ' FROM users').all();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.writeFileSync(path.join(EXPORT_DIR, 'users-' + stamp + '.json'), JSON.stringify(rows, null, 2));
    try {
      a.exec('PRAGMA wal_checkpoint(TRUNCATE);');
      fs.copyFileSync(ARCHIVE_PATH, path.join(EXPORT_DIR, 'users_archive.db'));
    } catch (e) {}
    return true;
  } catch (e) {
    console.warn('[usersdb] export failed: ' + e.message);
    return false;
  } finally {
    neonSchedule('export');
  }
}

// restore accounts from the archive into a fresh/empty users table
function restore({ overwrite = false } = {}) {
  const a = archive();
  const archived = a.prepare('SELECT ' + COLUMNS.join(',') + ' FROM users ORDER BY id').all();
  if (!archived.length) return { restored: 0, skipped: 0 };
  let restored = 0, skipped = 0;
  const d = dbm();
  const cols = COLUMNS.join(',');
  archived.forEach((r) => {
    const existing = d.get('SELECT id FROM users WHERE id=? OR email=? OR username=? OR phone=?',
      [r.id, r.email, r.username, r.phone]);
    if (existing && !overwrite) { skipped++; return; }
    try {
      if (existing && overwrite) d.run('DELETE FROM users WHERE id=?', [existing.id]);
      const place = COLUMNS.map(() => '?').join(',');
      d.run('INSERT INTO users (' + cols + ') VALUES (' + place + ')', COLUMNS.map((c) => r[c]));
      restored++;
    } catch (e) { skipped++; }
  });
  return { restored, skipped };
}

// on boot: a brand-new instance has no users at all -> rebuild them from the archive
// (or, when the archive is empty too, from the Neon mirror). Returns a promise because the
// Neon step is network I/O and MUST finish before the admin seed runs — otherwise a wiped
// instance would create a fresh manager instead of restoring the real one.
function boot() {
  let count = 0;
  try { count = dbm().get('SELECT COUNT(*) AS c FROM users').c; } catch (e) { return Promise.resolve(); }
  let archived = 0;
  try { archived = archive().prepare('SELECT COUNT(*) AS c FROM users').get().c; } catch (e) { return Promise.resolve(); }

  return (async () => {
    if (count === 0 && archived === 0 && neonEnabled()) {
      archived = await neonRestoreArchive();
    }
    if (count === 0 && archived > 0) {
      const res = restore();
      console.log('[usersdb] restored ' + res.restored + ' account(s) from ' + path.basename(ARCHIVE_PATH));
    } else if (archived === 0 && count > 0) {
      syncAll(); // first run: seed the archive from the live database
      exportSnapshot();
      console.log('[usersdb] archive seeded with ' + count + ' account(s)');
    }
    syncAll();
    neonSchedule('boot');
    if (!_timer) {
      _timer = setInterval(() => { syncAll(); exportSnapshot(); }, 10 * 60 * 1000);
      if (_timer.unref) _timer.unref();
    }
  })();
}

function stats() {
  try {
    const a = archive();
    const n = a.prepare('SELECT COUNT(*) AS c FROM users').get().c;
    const last = a.prepare('SELECT at FROM sync_log ORDER BY id DESC LIMIT 1').get();
    return {
      path: ARCHIVE_PATH,
      exportDir: EXPORT_DIR || null,
      archived: n,
      live: dbm().get('SELECT COUNT(*) AS c FROM users').c,
      lastSync: last ? last.at : null,
      neon: neonStatus(),
    };
  } catch (e) {
    return { path: ARCHIVE_PATH, exportDir: EXPORT_DIR || null, archived: 0, live: 0, lastSync: null, error: e.message };
  }
}

function listUsers() {
  try {
    return archive().prepare(
      'SELECT id, full_name, username, display_name, email, phone, is_manager, rank, is_limited, avatar_color, avatar, created_at, updated_at,' +
      " CASE WHEN password_hash IS NOT NULL AND password_hash <> '' THEN 1 ELSE 0 END AS has_password" +
      ' FROM users ORDER BY id'
    ).all();
  } catch (e) { return []; }
}

module.exports = {
  syncUser, syncAll, restore, exportSnapshot, boot, stats, listUsers,
  ARCHIVE_PATH, EXPORT_DIR, COLUMNS,
};