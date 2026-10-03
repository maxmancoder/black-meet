'use strict';
const http = require('http');
const { createApp } = require('./app');
const sockets = require('./sockets');
const bus = require('./lib/bus');
const { appConfig } = require('./lib/config');
const db = require('./lib/db');
const { sqlNow } = require('./lib/helpers');
const { hashPassword } = require('./lib/pwd');

const cfg = appConfig();
const PORT = Number(process.env.PORT || cfg.socket_port || 3000);

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
  console.log('Seeded initial admin -> username: ' + username);
}
ensureAdmin();

const app = createApp();
const server = http.createServer(app);

const io = sockets.attach(server);
bus.setIo(io);

server.listen(PORT, '0.0.0.0', () => {
  console.log('Black Meet (node) listening on :' + PORT);
});