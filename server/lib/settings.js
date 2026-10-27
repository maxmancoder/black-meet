'use strict';
const dbm = require('./db');

function getSetting(key, fallback) {
  const row = dbm.get('SELECT value FROM bm_settings WHERE key=?', [key]);
  if (!row || row.value === undefined || row.value === null) return fallback;
  return String(row.value);
}

function setSetting(key, value) {
  dbm.run(
    'INSERT INTO bm_settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    [key, String(value)]
  );
}

// signup_mode: 'open' (anyone, no limit) | 'approval' (saved, needs admin ok) | 'closed' (disabled)
const SIGNUP_MODES = ['open', 'approval', 'closed'];

function signupMode() {
  const v = getSetting('signup_mode', 'open');
  return SIGNUP_MODES.indexOf(v) !== -1 ? v : 'open';
}

module.exports = { getSetting, setSetting, signupMode, SIGNUP_MODES };
