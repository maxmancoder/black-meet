'use strict';
const fs = require('fs');
const path = require('path');
const { generateOtp, isDevMode, sqlNow } = require('./helpers');
const dbm = require('./db');

function devLogOtp(identifier, code, purpose) {
  if (!isDevMode()) return;
  const now = sqlNow();
  const line = '[' + now + '] ' + identifier + ' | ' + purpose + ' | ' + code + '\n';
  try {
    const dir = path.join(dbm.rootDir, 'logs');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'dev_otp.log'), line);
  } catch (e) {}
}

function otpSendAllowed(identifier) {
  const r = dbm.get(
    'SELECT COUNT(*) AS c FROM verification_codes WHERE identifier=? AND created_at > ?',
    [identifier, minutesAgo(15)]
  );
  return Number(r.c) < 5;
}

function otpVerifyAllowed(identifier) {
  const key = 'bf|' + identifier;
  const r = dbm.get(
    'SELECT COUNT(*) AS c FROM verification_codes WHERE identifier=? AND created_at > ?',
    [key, minutesAgo(15)]
  );
  return Number(r.c) < 6;
}

function otpRecordFailure(identifier) {
  const key = 'bf|' + identifier;
  dbm.run(
    'INSERT INTO verification_codes (identifier, code, purpose, expires_at, created_at) VALUES (?,?,?,?,?)',
    [key, 'x', 'login_phone', minutesAgo(-1), sqlNow()]
  );
}

function otpCleanup(identifier) {
  const key = 'bf|' + identifier;
  dbm.run(
    'DELETE FROM verification_codes WHERE (identifier=? AND expires_at < ?) OR (identifier=? AND created_at < ?)',
    [identifier, hoursAgo(1), key, minutesAgo(15)]
  );
}

function minutesAgo(m) {
  const d = new Date(Date.now() - m * 60000);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
    p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

function hoursAgo(h) {
  return minutesAgo(h * 60);
}

function insertOtp(identifier, purpose) {
  const code = generateOtp();
  dbm.run(
    'INSERT INTO verification_codes (identifier, code, purpose, expires_at, created_at) VALUES (?,?,?,?,?)',
    [identifier, code, purpose, minutesAgo(-5), sqlNow()]
  );
  dbm.run(
    'DELETE FROM verification_codes WHERE identifier=? AND purpose=? AND created_at < ?',
    [identifier, purpose, minutesAgo(15)]
  );
  return code;
}

module.exports = { devLogOtp, otpSendAllowed, otpVerifyAllowed, otpRecordFailure, otpCleanup, insertOtp };