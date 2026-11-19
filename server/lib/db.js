'use strict';
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const rootDir = path.resolve(__dirname, '..', '..');
const DB_PATH = process.env.BM_DB_PATH || path.join(rootDir, 'black_meet.db');

// ---------- persistence helper ----------
// Ephemeral hosts (Render free) lose the disk on every restart/deploy. If BM_DB_BACKUP_DIR
// points at a persistent mount (or a synced folder) we restore the newest snapshot on boot
// and refresh it every BM_DB_BACKUP_MIN minutes, so accounts survive a restart.
const BACKUP_DIR = process.env.BM_DB_BACKUP_DIR || '';
const BACKUP_MIN = parseInt(process.env.BM_DB_BACKUP_MIN || '30', 10);
let _backupTimer = null;

function restoreFromBackup() {
  if (!BACKUP_DIR) return false;
  try {
    const names = fs.readdirSync(BACKUP_DIR).filter((n) => /^black_meet-.*\.db$/.test(n)).sort();
    if (!names.length) return false;
    const src = path.join(BACKUP_DIR, names[names.length - 1]);
    // only restore when the live file is missing or obviously empty (fresh disk)
    let size = 0;
    try { size = fs.statSync(DB_PATH).size; } catch (e) { size = 0; }
    if (size > 65536) return false;
    fs.copyFileSync(src, DB_PATH);
    try { fs.copyFileSync(src, DB_PATH + '-wal'); } catch (e) {}
    console.log('[db] restored snapshot ' + names[names.length - 1]);
    return true;
  } catch (e) {
    console.warn('[db] snapshot restore failed: ' + e.message);
    return false;
  }
}

function backupNow() {
  if (!BACKUP_DIR) return false;
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(BACKUP_DIR, 'black_meet-' + stamp + '.db');
    db().exec('PRAGMA wal_checkpoint(TRUNCATE);');
    fs.copyFileSync(DB_PATH, dest);
    // keep only the 5 newest snapshots
    const names = fs.readdirSync(BACKUP_DIR).filter((n) => /^black_meet-.*\.db$/.test(n)).sort();
    names.slice(0, Math.max(0, names.length - 5)).forEach((n) => {
      try { fs.unlinkSync(path.join(BACKUP_DIR, n)); } catch (e) {}
    });
    console.log('[db] snapshot written: ' + path.basename(dest));
    return true;
  } catch (e) {
    console.warn('[db] snapshot failed: ' + e.message);
    return false;
  }
}

function startBackupLoop() {
  if (!BACKUP_DIR || _backupTimer) return;
  const mins = Math.max(1, BACKUP_MIN);
  _backupTimer = setInterval(backupNow, mins * 60 * 1000);
  if (_backupTimer.unref) _backupTimer.unref();
  // take one as soon as the process is up, then keep the newest on disk
  setTimeout(backupNow, 15000);
  process.on('exit', () => { try { backupNow(); } catch (e) {} });
}

let _db = null;

function db() {
  if (_db) return _db;
  restoreFromBackup();
  _db = new DatabaseSync(DB_PATH);
  _db.exec('PRAGMA journal_mode = WAL;');
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  _db.exec(schema);
  // lightweight idempotent migrations for DBs created before a column existed
  const cols = _db.prepare('PRAGMA table_info(users)').all().map((r) => r.name);
  if (cols.indexOf('rank') === -1) {
    _db.exec("ALTER TABLE users ADD COLUMN rank TEXT NOT NULL DEFAULT 'user'");
  }
  // meetings.open_join: when on, anybody with the link joins without waiting for approval
  const mcols = _db.prepare('PRAGMA table_info(meetings)').all().map((r) => r.name);
  if (mcols.indexOf('open_join') === -1) {
    _db.exec('ALTER TABLE meetings ADD COLUMN open_join INTEGER NOT NULL DEFAULT 0');
  }
  // persist sender identity on messages so attribution survives user changes/restarts
  const pvcols = _db.prepare('PRAGMA table_info(pv_messages)').all().map((r) => r.name);
  if (pvcols.indexOf('sender_username') === -1) {
    _db.exec("ALTER TABLE pv_messages ADD COLUMN sender_username TEXT NOT NULL DEFAULT ''");
  }
  if (pvcols.indexOf('sender_email') === -1) {
    _db.exec("ALTER TABLE pv_messages ADD COLUMN sender_email TEXT NOT NULL DEFAULT ''");
  }
  // Batch 31 — both ends of every message + reply/forward/soft-delete. Each column is
  // added only when missing so an older database is upgraded in place, never rebuilt.
  const PV_ADD = {
    sender_id: 'INTEGER NOT NULL DEFAULT 0',
    sender_display_name: "TEXT NOT NULL DEFAULT ''",
    recipient_id: 'INTEGER NOT NULL DEFAULT 0',
    recipient_username: "TEXT NOT NULL DEFAULT ''",
    recipient_display_name: "TEXT NOT NULL DEFAULT ''",
    peer_id: 'INTEGER NOT NULL DEFAULT 0',
    reply_to: 'INTEGER',
    forwarded_from: "TEXT NOT NULL DEFAULT ''",
    deleted: 'INTEGER NOT NULL DEFAULT 0',
    deleted_at: 'TEXT',
  };
  Object.keys(PV_ADD).forEach((k) => {
    if (pvcols.indexOf(k) === -1) _db.exec('ALTER TABLE pv_messages ADD COLUMN ' + k + ' ' + PV_ADD[k]);
  });
  const acols = _db.prepare('PRAGMA table_info(announcements)').all().map((r) => r.name);
  const ANN_ADD = {
    reply_to: 'INTEGER',
    forwarded_from: "TEXT NOT NULL DEFAULT ''",
    deleted: 'INTEGER NOT NULL DEFAULT 0',
    deleted_at: 'TEXT',
  };
  Object.keys(ANN_ADD).forEach((k) => {
    if (acols.indexOf(k) === -1) _db.exec('ALTER TABLE announcements ADD COLUMN ' + k + ' ' + ANN_ADD[k]);
  });
  if (acols.indexOf('sender_id') === -1) {
    _db.exec('ALTER TABLE announcements ADD COLUMN sender_id INTEGER NOT NULL DEFAULT 0');
  }
  if (acols.indexOf('sender_username') === -1) {
    _db.exec("ALTER TABLE announcements ADD COLUMN sender_username TEXT NOT NULL DEFAULT ''");
  }
  if (acols.indexOf('sender_email') === -1) {
    _db.exec("ALTER TABLE announcements ADD COLUMN sender_email TEXT NOT NULL DEFAULT ''");
  }
  if (acols.indexOf('sender_display_name') === -1) {
    _db.exec("ALTER TABLE announcements ADD COLUMN sender_display_name TEXT NOT NULL DEFAULT ''");
  }
  // the new indexes can only be created now: on an older database the columns did not
  // exist when schema.sql ran, so putting these there broke boot ("no such column").
  _db.exec('CREATE INDEX IF NOT EXISTS idx_pv_thread ON pv_messages (user_id, peer_id, id)');
  _db.exec('CREATE INDEX IF NOT EXISTS idx_pv_sender ON pv_messages (sender_id, created_at)');
  // One-time product migration: regular users AND plain admins must be able to open
  // «پیام‌ها» and DM the manager / premium admins. Older saved restriction rows had
  // can_use_messages OFF for `user`, which silently redirected them away from the page.
  try {
    const marker = _db.prepare("SELECT value FROM bm_settings WHERE key='chat_access_migrated_v31'").get();
    if (!marker) {
      const row = _db.prepare("SELECT value FROM bm_settings WHERE key='rank_restrictions'").get();
      if (row && row.value) {
        const j = JSON.parse(row.value);
        ['user', 'admin'].forEach((r) => {
          if (j[r] && j[r].can_use_messages) j[r].can_use_messages.on = true;
        });
        _db.prepare("UPDATE bm_settings SET value=? WHERE key='rank_restrictions'").run(JSON.stringify(j));
      }
      _db.prepare("INSERT OR REPLACE INTO bm_settings (key, value) VALUES ('chat_access_migrated_v31','1')").run();
    }
  } catch (e) { /* best-effort migration */ }
  // backfill sender identity for rows created before these columns existed
  try {
    _db.exec(`
      UPDATE pv_messages SET
        sender_username = COALESCE((SELECT u.username FROM users u WHERE u.id = pv_messages.user_id), ''),
        sender_email    = COALESCE((SELECT u.email    FROM users u WHERE u.id = pv_messages.user_id), '')
      WHERE from_manager = 0 AND (sender_username = '' AND sender_email = '');
    `);
    _db.exec(`
      UPDATE pv_messages SET
        sender_username = COALESCE((SELECT u.username FROM users u WHERE u.is_manager = 1 ORDER BY u.id LIMIT 1), ''),
        sender_email    = COALESCE((SELECT u.email    FROM users u WHERE u.is_manager = 1 ORDER BY u.id LIMIT 1), '')
      WHERE from_manager = 1 AND (sender_username = '' AND sender_email = '');
    `);
    // Batch 31 backfill: derive both ends of legacy rows. `user_id` is always the
    // non-manager side of a thread; `peer_id` the privileged side (legacy = main manager).
    _db.exec(`
      UPDATE pv_messages SET
        sender_id   = CASE WHEN from_manager=1
                        THEN COALESCE((SELECT u.id FROM users u WHERE u.is_manager=1 ORDER BY u.id LIMIT 1),0)
                        ELSE user_id END,
        recipient_id = CASE WHEN from_manager=1 THEN user_id
                        ELSE COALESCE((SELECT u.id FROM users u WHERE u.is_manager=1 ORDER BY u.id LIMIT 1),0) END,
        peer_id     = CASE WHEN from_manager=0
                        THEN COALESCE((SELECT u.id FROM users u WHERE u.is_manager=1 ORDER BY u.id LIMIT 1),0)
                        ELSE user_id END
      WHERE sender_id = 0 AND recipient_id = 0 AND peer_id = 0;
    `);
    _db.exec(`
      UPDATE pv_messages SET
        recipient_username     = COALESCE((SELECT u.username      FROM users u WHERE u.id = pv_messages.recipient_id), ''),
        recipient_display_name = COALESCE((SELECT u.display_name  FROM users u WHERE u.id = pv_messages.recipient_id), ''),
        sender_display_name    = COALESCE((SELECT u.display_name  FROM users u WHERE u.id = pv_messages.sender_id), '')
      WHERE recipient_username = '' AND recipient_id > 0;
    `);
    _db.exec(`
      UPDATE announcements SET
        sender_id = COALESCE((SELECT u.id FROM users u WHERE u.is_manager = 1 ORDER BY u.id LIMIT 1), 0),
        sender_username = COALESCE((SELECT u.username FROM users u WHERE u.is_manager = 1 ORDER BY u.id LIMIT 1), ''),
        sender_email    = COALESCE((SELECT u.email    FROM users u WHERE u.is_manager = 1 ORDER BY u.id LIMIT 1), ''),
        sender_display_name = COALESCE((SELECT u.display_name FROM users u WHERE u.is_manager = 1 ORDER BY u.id LIMIT 1), '')
      WHERE sender_username = '' AND sender_email = '' AND sender_display_name = '';
    `);
  } catch (e) { /* best-effort backfill */ }
  // A meeting created before the quota ledger existed must still count towards today's
  // limit. INSERT OR IGNORE keeps the ledger exact on every later boot.
  try {
    _db.exec(`
      INSERT OR IGNORE INTO meeting_creates (user_id, meeting_id, room_id, created_at)
      SELECT creator_id, id, room_id, created_at FROM meetings
    `);
  } catch (e) { /* best-effort backfill */ }
  startBackupLoop();
  return _db;
}

function rowToPlain(row) {
  if (row === undefined || row === null) return null;
  return Object.assign({}, row);
}

function get(sql, params) {
  const s = db().prepare(sql);
  const r = params ? s.get(...params) : s.get();
  return rowToPlain(r);
}

function all(sql, params) {
  const s = db().prepare(sql);
  const rows = params ? s.all(...params) : s.all();
  return rows.map(rowToPlain);
}

function run(sql, params) {
  const s = db().prepare(sql);
  const r = params ? s.run(...params) : s.run();
  return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
}

function lastId() {
  return Number(db().prepare('SELECT last_insert_rowid() AS id').get().id);
}

module.exports = { db, get, all, run, lastId, rootDir, DB_PATH, backupNow, restoreFromBackup };