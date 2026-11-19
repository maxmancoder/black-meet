'use strict';
// Per-rank, graphically editable restrictions for the whole site.
//
// Everything lives in ONE bm_settings row (`rank_restrictions`) as JSON, so the owner can
// change any value from «مدیریت اعضا» → «محدودیت کاربران» without a deploy. A restriction
// with `on:false` is NOT applied to that rank at all (unlimited / allowed).
// Defaults below reproduce the behaviour the site had before this panel existed.
const settings = require('./settings');
const dbm = require('./db');
const { sqlNow } = require('./helpers');

const KEY = 'rank_restrictions';
const RANKS = ['user', 'admin', 'premium', 'manager'];
const RANK_LABELS = {
  user: 'کاربر عادی', admin: 'ادمین', premium: 'ادمین پریمیوم', manager: 'مدیر اصلی',
};

// type: 'number' rows have {on, value}; type: 'bool' rows only have {on}.
const DEFINITIONS = [
  // ---- numbers ---------------------------------------------------------------
  { key: 'daily_meetings', label: 'سقف تماس در روز', hint: '0 یعنی نامحدود', type: 'number', min: 0, max: 500,
    defaults: { user: 2, admin: 5, premium: 15, manager: 0 } },
  { key: 'meeting_minutes', label: 'حداکثر طول تماس (دقیقه)', hint: '0 یعنی نامحدود', type: 'number', min: 0, max: 1440,
    defaults: { user: 0, admin: 0, premium: 0, manager: 0 } },
  { key: 'max_participants', label: 'حداکثر اعضای یک تماس', hint: '0 یعنی نامحدود', type: 'number', min: 0, max: 300,
    defaults: { user: 0, admin: 0, premium: 0, manager: 0 } },
  { key: 'daily_pv_messages', label: 'سقف پیام خصوصی در روز', hint: '0 یعنی نامحدود', type: 'number', min: 0, max: 2000,
    defaults: { user: 0, admin: 0, premium: 0, manager: 0 } },
  { key: 'daily_announcements', label: 'سقف پیام عمومی در روز', hint: '0 یعنی نامحدود', type: 'number', min: 0, max: 500,
    defaults: { user: 0, admin: 0, premium: 0, manager: 0 } },
  { key: 'call_file_mb', label: 'حداکثر حجم فایل در تماس (مگابایت)', hint: '0 یعنی نامحدود', type: 'number', min: 0, max: 2048,
    defaults: { user: 50, admin: 50, premium: 50, manager: 0 } },
  // ---- feature switches ------------------------------------------------------
  { key: 'can_create_meeting', label: 'ایجاد تماس', type: 'bool',
    defaults: { user: true, admin: true, premium: true, manager: true } },
  { key: 'can_open_join', label: 'ورود بدون تأیید ادمین', type: 'bool',
    defaults: { user: true, admin: true, premium: true, manager: true } },
  { key: 'can_use_messages', label: 'بخش پیام‌ها', type: 'bool',
    defaults: { user: true, admin: true, premium: true, manager: true } },
  { key: 'can_view_members', label: 'مشاهده اعضا', type: 'bool',
    defaults: { user: false, admin: false, premium: true, manager: true } },
  { key: 'can_view_requests', label: 'مشاهده درخواست‌های حساب', type: 'bool',
    defaults: { user: false, admin: true, premium: true, manager: true } },
  { key: 'can_decide_requests', label: 'تأیید / رد درخواست‌ها', type: 'bool',
    defaults: { user: false, admin: false, premium: true, manager: true } },
  { key: 'can_change_signup_mode', label: 'تغییر حالت ثبتنام', type: 'bool',
    defaults: { user: false, admin: false, premium: true, manager: true } },
  { key: 'can_manage_users', label: 'ویرایش کاربران', type: 'bool',
    defaults: { user: false, admin: false, premium: true, manager: true } },
  { key: 'can_share_screen', label: 'اشتراک صفحه', type: 'bool',
    defaults: { user: true, admin: true, premium: true, manager: true } },
  { key: 'can_whiteboard', label: 'تخته وایتبرد', type: 'bool',
    defaults: { user: true, admin: true, premium: true, manager: true } },
  { key: 'can_use_web_box', label: 'لینک سایت / ویدیو / صدا', type: 'bool',
    defaults: { user: true, admin: true, premium: true, manager: true } },
  { key: 'can_upload_call_file', label: 'آپلود فایل در تماس', type: 'bool',
    defaults: { user: true, admin: true, premium: true, manager: true } },
  { key: 'can_send_chat', label: 'ارسال پیام در تماس', type: 'bool',
    defaults: { user: true, admin: true, premium: true, manager: true } },
  { key: 'can_send_emoji', label: 'ارسال ایموجی در تماس', type: 'bool',
    defaults: { user: true, admin: true, premium: true, manager: true } },
];

const BY_KEY = Object.create(null);
DEFINITIONS.forEach((d) => { BY_KEY[d.key] = d; });

function fresh() {
  const out = {};
  RANKS.forEach((r) => {
    out[r] = {};
    DEFINITIONS.forEach((d) => {
      out[r][d.key] = d.type === 'number'
        ? { on: true, value: d.defaults[r] }
        : { on: !!d.defaults[r] };
    });
  });
  // manager is never limited by default — he can still edit every OTHER rank
  DEFINITIONS.forEach((d) => {
    if (d.type === 'number') out.manager[d.key].on = d.defaults.manager !== 0;
  });
  return out;
}

let _cache = null;
let _cacheRaw = null;
// Per-user overrides live in their own table so one member can be limited differently
// from everyone else of the same rank. A tiny cache is invalidated on every write.
let _userCache = null;
let _userCacheRev = 0;

function userOverride(userId) {
  const id = Number(userId || 0);
  if (!id) return null;
  if (_userCache && _userCache.rev === _userCacheRev && Object.prototype.hasOwnProperty.call(_userCache.map, id)) {
    return _userCache.map[id];
  }
  let raw = '';
  try {
    const row = dbm.get('SELECT data FROM user_restrictions WHERE user_id=?', [id]);
    raw = row && row.data || '';
  } catch (e) { raw = ''; }
  let data = null;
  try { if (raw) data = JSON.parse(raw) || null; } catch (e) { data = null; }
  if (!_userCache || _userCache.rev !== _userCacheRev) _userCache = { rev: _userCacheRev, map: {} };
  _userCache.map[id] = data;
  return data;
}

function saveUser(userId, payload) {
  const id = Number(userId || 0);
  if (!id || !payload || typeof payload !== 'object') return false;
  // keep only known keys/types, exactly like the rank-level save
  const clean = {};
  DEFINITIONS.forEach((d) => {
    const v = payload[d.key];
    if (!v || typeof v !== 'object') return;
    if (d.type === 'number') {
      const n = Number(v.value);
      clean[d.key] = { on: v.on !== false, value: Number.isFinite(n) ? Math.min(d.max, Math.max(d.min, Math.round(n))) : 0 };
    } else {
      clean[d.key] = { on: !!v.on };
    }
  });
  try {
    dbm.run(
      'INSERT INTO user_restrictions (user_id, data, updated_at) VALUES (?,?,?) ' +
      'ON CONFLICT(user_id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at',
      [id, JSON.stringify(clean), sqlNow()]
    );
  } catch (e) { return false; }
  _userCacheRev++;
  return true;
}

function clearUser(userId) {
  try { dbm.run('DELETE FROM user_restrictions WHERE user_id=?', [Number(userId || 0)]); } catch (e) { return false; }
  _userCacheRev++;
  return true;
}

function userOverridesList() {
  try {
    return dbm.all('SELECT user_id, data, updated_at FROM user_restrictions ORDER BY user_id');
  } catch (e) { return []; }
}

function all() {
  let raw = '';
  try { raw = settings.getSetting(KEY, ''); } catch (e) { raw = ''; }
  if (_cache && raw === _cacheRaw) return _cache;
  const out = fresh();
  let stored = {};
  try {
    if (raw) stored = JSON.parse(raw) || {};
  } catch (e) { stored = {}; }
  RANKS.forEach((r) => {
    if (!stored[r] || typeof stored[r] !== 'object') return;
    DEFINITIONS.forEach((d) => {
      const v = stored[r][d.key];
      if (!v || typeof v !== 'object') return;
      if (d.type === 'number') {
        if (typeof v.on === 'boolean') out[r][d.key].on = v.on;
        const n = Number(v.value);
        if (Number.isFinite(n)) out[r][d.key].value = Math.min(d.max, Math.max(d.min, Math.round(n)));
      } else if (typeof v.on === 'boolean') {
        out[r][d.key].on = v.on;
      }
    });
  });
  _cache = out;
  _cacheRaw = raw;
  return out;
}

function save(payload) {
  const current = all();
  if (!payload || typeof payload !== 'object') return false;
  RANKS.forEach((r) => {
    if (!payload[r] || typeof payload[r] !== 'object') return;
    DEFINITIONS.forEach((d) => {
      const v = payload[r][d.key];
      if (!v || typeof v !== 'object') return;
      if (d.type === 'number') {
        if (typeof v.on === 'boolean') current[r][d.key].on = v.on;
        if (v.value !== undefined && v.value !== '') {
          const n = Number(v.value);
          if (Number.isFinite(n)) current[r][d.key].value = Math.min(d.max, Math.max(d.min, Math.round(n)));
        }
      } else if (typeof v.on === 'boolean') {
        current[r][d.key].on = v.on;
      }
    });
  });
  settings.setSetting(KEY, JSON.stringify(current));
  _cache = null;
  _cacheRaw = null;
  return true;
}

function rankOf(u) {
  if (!u) return 'user';
  if (u.is_manager) return 'manager';
  const r = String(u.rank || 'user');
  return RANKS.indexOf(r) !== -1 && r !== 'manager' ? r : 'user';
}

function of(u, key) {
  const d = BY_KEY[key];
  if (!d) return null;
  const row = all()[rankOf(u)][key];
  // The main manager can never be locked out of the admin UI / restricted by a flag.
  if (u && u.is_manager) return d.type === 'number' ? { on: row.on, value: row.value } : { on: true };
  // a per-user override wins over the rank default for THAT member only
  const overrides = userOverride(u && u.id) || {};
  const over = overrides[key];
  if (over && typeof over === 'object') {
    if (d.type === 'number') return { on: over.on !== false, value: Number(over.value) || 0 };
    return { on: !!over.on };
  }
  return row;
}

// numeric restriction: 0/undefined when OFF means "not applied" (unlimited)
function limit(u, key) {
  const row = of(u, key);
  if (!row || !row.on) return 0;
  return Math.max(0, Number(row.value) || 0);
}

// boolean restriction: true when OFF (a switch that is off means "not restricted")
function allowed(u, key) {
  const row = of(u, key);
  return !row || row.on !== false;
}

// How much of a daily numeric restriction this user already used TODAY.
function dailyUsed(u, key) {
  const today = sqlNow().slice(0, 10);
  const uid = Number((u && u.id) || 0);
  const count = (sql, args) => Number((dbm.get(sql, args) || {}).c || 0);
  if (key === 'daily_meetings') {
    return count('SELECT COUNT(*) AS c FROM meeting_creates WHERE user_id=? AND substr(created_at,1,10)=?', [uid, today]);
  }
  if (key === 'daily_announcements') {
    return count('SELECT COUNT(*) AS c FROM announcements WHERE sender_id=? AND substr(created_at,1,10)=?', [uid, today]);
  }
  if (key === 'daily_pv_messages') {
    // pv_messages has no sender column: a regular user's outgoing rows are keyed by his id,
    // the manager's outgoing rows are all the from_manager=1 rows in every thread.
    if (u && u.is_manager) {
      return count('SELECT COUNT(*) AS c FROM pv_messages WHERE from_manager=1 AND substr(created_at,1,10)=?', [today]);
    }
    return count('SELECT COUNT(*) AS c FROM pv_messages WHERE user_id=? AND from_manager=0 AND substr(created_at,1,10)=?', [uid, today]);
  }
  return 0;
}

// {ok:true} or {ok:false,msg} — a cap of 0 (or an OFF restriction) means unlimited.
function checkDaily(u, key) {
  const cap = limit(u, key);
  if (!cap) return { ok: true };
  const used = dailyUsed(u, key);
  if (used >= cap) {
    const labels = { daily_meetings: 'تماس', daily_pv_messages: 'پیام خصوصی', daily_announcements: 'پیام عمومی' };
    return { ok: false, msg: 'سقف ' + (labels[key] || 'استفاده') + ' امروز (' + used + ') به پایان رسید. فردا دوباره تلاش کنید' };
  }
  return { ok: true, used, cap };
}

function forUser(u) {
  const r = rankOf(u);
  const data = all()[r];
  const over = userOverride(u && u.id) || {};
  const out = {};
  DEFINITIONS.forEach((d) => { out[d.key] = over[d.key] || data[d.key]; });
  return {
    rank: r, label: RANK_LABELS[r], rows: out,
    isManager: !!(u && u.is_manager), hasOverride: Object.keys(over).length > 0,
  };
}

module.exports = {
  KEY, RANKS, RANK_LABELS, DEFINITIONS, BY_KEY,
  all, save, rankOf, of, limit, allowed, dailyUsed, checkDaily, forUser,
  userOverride, saveUser, clearUser, userOverridesList,
};
