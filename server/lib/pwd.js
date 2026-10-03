'use strict';
const bcrypt = require('bcryptjs');

function hashPassword(plain) {
  return bcrypt.hashSync(plain, 10);
}

function looksLikeHash(stored) {
  return stored !== '' &&
    (stored.indexOf('$2a$') === 0 || stored.indexOf('$2b$') === 0 ||
     stored.indexOf('$2y$') === 0 || stored.indexOf('$argon') === 0);
}

function verifyAndUpgradePassword(plain, stored) {
  stored = String(stored || '');
  if (looksLikeHash(stored)) {
    // bcrypt family verified here; argon hashes fail compare (as in PHP fallback)
    return { ok: bcrypt.compareSync(plain || '', stored), upgradeHash: null };
  }
  if (stored !== '' && stored === String(plain)) {
    return { ok: true, upgradeHash: hashPassword(plain) };
  }
  return { ok: false, upgradeHash: null };
}

function storeUpgradedPassword(userId, newHash) {
  const db = require('./db');
  db.run('UPDATE users SET password_hash=? WHERE id=?', [newHash, userId]);
}

module.exports = { hashPassword, verifyAndUpgradePassword, storeUpgradedPassword };