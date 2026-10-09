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