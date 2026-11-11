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

// meeting_create_mode: who may create a meeting (manager is always allowed, without limits)
//   all     -> everyone, subject to their normal account limits/quotas
//   premium -> only premium subscribers (rank premium / ادمین پریمیوم)
//   admin   -> only admins and premium admins (ranks admin, premium)
const MEETING_CREATE_MODES = ['all', 'premium', 'admin'];

function meetingCreateMode() {
  const v = getSetting('meeting_create_mode', 'all');
  return MEETING_CREATE_MODES.indexOf(v) !== -1 ? v : 'all';
}

module.exports = { getSetting, setSetting, signupMode, SIGNUP_MODES, meetingCreateMode, MEETING_CREATE_MODES };
