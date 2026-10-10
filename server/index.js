'use strict';
const http = require('http');
const { createApp } = require('./app');
const sockets = require('./sockets');
const bus = require('./lib/bus');
const { appConfig } = require('./lib/config');
const db = require('./lib/db');
const usersdb = require('./lib/usersdb');
const { sqlNow } = require('./lib/helpers');
const { hashPassword, looksLikeHash } = require('./lib/pwd');

const cfg = appConfig();
const PORT = Number(process.env.PORT || cfg.socket_port || 3000);

// users_archive.db: a durable mirror of every account. This runs FIRST: on a fresh
// instance (ephemeral disk) the live DB is empty, so the accounts have to be restored
// from the archive before the admin seed decides whether it needs to create one.
usersdb.boot();

// Accounts that were created before hashing was fixed (approval-mode signups kept the
// plain password in password_hash) are converted to a hash now — one row at a time.
function upgradePlainPasswords() {
  try {
    const rows = db.all("SELECT id, password_hash FROM users WHERE password_hash IS NOT NULL AND password_hash <> ''");
    let n = 0;
    rows.forEach((r) => {
      if (looksLikeHash(r.password_hash)) return;
      db.run('UPDATE users SET password_hash=? WHERE id=?', [hashPassword(r.password_hash), r.id]);
      n++;
    });
    if (n) {
      console.log('[users] hashed ' + n + ' legacy plain password(s)');
      usersdb.syncAll();
    }
  } catch (e) { /* nothing to upgrade */ }
}
upgradePlainPasswords();

// Pending approval requests created before the fix still hold a plain password, and
// approving them would copy that plain text into the account. Hash them now.
function upgradePendingRequests() {
  try {
    const rows = db.all("SELECT id, password FROM signup_requests WHERE status='pending' AND password IS NOT NULL AND password <> ''");
    let n = 0;
    rows.forEach((r) => {
      if (looksLikeHash(r.password)) return;
      db.run('UPDATE signup_requests SET password=? WHERE id=?', [hashPassword(r.password), r.id]);
      n++;
    });
    if (n) console.log('[users] hashed ' + n + ' legacy pending request password(s)');
  } catch (e) { /* nothing to upgrade */ }
}
upgradePendingRequests();

// first boot on an empty DB -> create the initial manager account
// credentials come from config.json ("admin" section) or env (BM_ADMIN_*),
// never from source code. Without them the seed is skipped (DB stays empty).
function ensureAdmin() {
  const row = db.get('SELECT COUNT(*) AS n FROM users');
  if (!row || Number(row.n) !== 0) return;
  const a = cfg.admin || {};
  const username = a.username || process.env.BM_ADMIN_USER || '';
  const password = a.password || process.env.BM_ADMIN_PASS || '';
  if (!username || !password) {
    console.log('Admin seed skipped: set admin.username/admin.password in config.json (or BM_ADMIN_USER/BM_ADMIN_PASS env) to create the first manager.');
    return;
  }
  const email = a.email || process.env.BM_ADMIN_EMAIL || '';
  const phone = a.phone || process.env.BM_ADMIN_PHONE || '';
  db.run(
    'INSERT INTO users (full_name, username, email, phone, password_hash, display_name, is_manager, is_limited, avatar_color, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    ['Black Line', username, email, phone,
      hashPassword(password), 'Black Line', 1, 0, '#4f46e5', sqlNow()]
  );
  usersdb.syncUser(Number(db.get('SELECT id FROM users WHERE username=?', [username]).id));
  console.log('Seeded initial admin -> username: ' + username);
}
ensureAdmin();
const ustats = usersdb.stats();
console.log('[users] archive: ' + ustats.archived + ' account(s) at ' + ustats.path);

const app = createApp();
const server = http.createServer(app);

const io = sockets.attach(server);
bus.setIo(io);

server.listen(PORT, '0.0.0.0', () => {
  console.log('Black Meet (node) listening on :' + PORT);
});