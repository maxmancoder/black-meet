'use strict';
// The site icon lives in the DATABASE (bm_assets), not in a file: every page reads it
// from there, so the admin can change it from the profile page and the whole site
// (favicon, header mark, login page) follows at once. The file that ships with the app
// (icons/SiteIcon.png) is only the seed for the very first request.
const fs = require('fs');
const path = require('path');
const dbm = require('./db');
const { sqlNow } = require('./helpers');

const NAME = 'site_icon';
const MAX_BYTES = 2 * 1024 * 1024;
const ALLOWED = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
};

function defaultFile() {
  const root = dbm.rootDir;
  // the shipped default (the app icon the owner picked); the older files stay as fallbacks
  const primary = path.join(root, 'icons', 'SiteIcon.png');
  if (fs.existsSync(primary)) return { file: primary, mime: 'image/png' };
  const png = path.join(root, 'icons', 'site-icon.png');
  if (fs.existsSync(png)) return { file: png, mime: 'image/png' };
  const svg = path.join(root, 'icons', 'site-icon.svg');
  if (fs.existsSync(svg)) return { file: svg, mime: 'image/svg+xml' };
  return null;
}

function seed() {
  const d = defaultFile();
  if (!d) return { mime: 'image/svg+xml', data: Buffer.from(''), updatedAt: sqlNow(), empty: true };
  const data = fs.readFileSync(d.file);
  try {
    dbm.run(
      'INSERT INTO bm_assets (name, mime, data, updated_at) VALUES (?,?,?,?) ' +
      'ON CONFLICT(name) DO UPDATE SET mime=excluded.mime, data=excluded.data, updated_at=excluded.updated_at',
      [NAME, d.mime, data, sqlNow()]
    );
  } catch (e) { /* the table may not exist yet on a very old DB */ }
  return { mime: d.mime, data, updatedAt: sqlNow() };
}

// always read from the DB — the file is only the seed
function getIcon() {
  let row = null;
  try {
    row = dbm.get('SELECT mime, data, updated_at FROM bm_assets WHERE name=?', [NAME]);
  } catch (e) { row = null; }
  if (row && row.data && row.data.length) {
    return {
      mime: row.mime || 'image/png',
      data: Buffer.from(row.data),
      updatedAt: row.updated_at || sqlNow(),
    };
  }
  return seed();
}

function setIcon(buffer, mime) {
  const data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  if (!data || !data.length) return { ok: false, msg: 'فایل خالی است' };
  if (data.length > MAX_BYTES) return { ok: false, msg: 'حجم تصویر بیش از ۲ مگابایت است' };
  const type = String(mime || '').toLowerCase();
  if (!ALLOWED[type]) return { ok: false, msg: 'فرمت تصویر پشتیبانی نمی‌شود' };
  const now = sqlNow();
  dbm.run(
    'INSERT INTO bm_assets (name, mime, data, updated_at) VALUES (?,?,?,?) ' +
    'ON CONFLICT(name) DO UPDATE SET mime=excluded.mime, data=excluded.data, updated_at=excluded.updated_at',
    [NAME, type, data, now]
  );
  return { ok: true, mime: type, size: data.length, updatedAt: now };
}

// put the shipped icon back (the "بازگشت به پیش‌فرض" key in the profile page)
function resetToDefault() {
  try {
    dbm.run('DELETE FROM bm_assets WHERE name=?', [NAME]);
  } catch (e) { /* ignore */ }
  return seed();
}

function etag(icon) {
  let h = 0;
  const s = String(icon.updatedAt || '') + ':' + (icon.data ? icon.data.length : 0);
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return 'W/"' + (h >>> 0).toString(16) + '"';
}

module.exports = { getIcon, setIcon, resetToDefault, etag, ALLOWED, MAX_BYTES };
