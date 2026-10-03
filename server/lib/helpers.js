'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dbm = require('./db');
const { appConfig } = require('./config');

const TUNNEL_URL_FILE = path.join(dbm.rootDir, 'tunnel_url.txt');
const TURN_HOST_FILE = path.join(dbm.rootDir, 'turn_host.txt');

function stripBom(s) {
  return s.replace(/^\uFEFF/, '').trim();
}

function sqlNow() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
    p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

function secNow() {
  return Math.floor(Date.now() / 1000);
}

// same format as sqlNow(), but N minutes in the past (local clock) — string compare works
function sqlNowMinus(minutes) {
  const d = new Date(Date.now() - minutes * 60000);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
    p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

function e(v) {
  if (v === null || v === undefined) return '';
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function toFaDigits(n) {
  const map = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'];
  return String(n).replace(/[0-9]/g, (c) => map[Number(c)]);
}

function initials(name) {
  const parts = String(name).trim().split(/\s+/u);
  if (parts.length >= 2) return grapheme(parts[0], 0) + grapheme(parts[1], 0);
  return String(name).trim().slice(0, 2);
}

function grapheme(s, i) {
  return Array.from(String(s))[i] || '';
}

function generateRoomId(len = 16) {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let out = '';
  for (let i = 0; i < len; i++) out += chars[crypto.randomInt(0, chars.length)];
  return out;
}

function generateOtp(len = 6) {
  let out = '';
  for (let i = 0; i < len; i++) out += String(crypto.randomInt(0, 10));
  return out;
}

function timeAgo(dt) {
  const d = parseSqlDate(dt);
  if (!d) return '';
  const t = Math.max(0, (Date.now() - d.getTime()) / 1000);
  if (t < 60) return 'همین الان';
  if (t < 3600) return Math.floor(t / 60) + ' دقیقه پیش';
  if (t < 86400) return Math.floor(t / 3600) + ' ساعت پیش';
  return Math.floor(t / 86400) + ' روز پیش';
}

function parseSqlDate(dt) {
  if (!dt) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(String(dt));
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
}

function baseUrl(req) {
  const cfg = appConfig();
  let host = null;
  if (req && typeof req === 'object' && req.headers) {
    host = req.headers.host || req.get && req.get('host');
  }
if (host) {
      let proto = 'http';
      const xfp = req && req.headers && req.headers['x-forwarded-proto'];
      if (xfp) {
        proto = String(xfp).split(',')[0].trim().toLowerCase();
      } else {
        const hostname = host.split(':')[0].toLowerCase();
        if (hostname !== 'localhost' && hostname !== '127.0.0.1' && hostname !== '::1') {
          proto = 'https';
        } else if (host.indexOf('bore.pub') !== -1) {
          proto = 'http';
        }
      }
      return (proto + '://' + host + '/black-meet').replace(/\/+$/, '');
    }
  return (cfg.base_url || 'http://localhost/black-meet').replace(/\/+$/, '');
}

function publicUrl(req) {
  try {
    const u = stripBom(fs.readFileSync(TUNNEL_URL_FILE, 'utf8'));
    if (u && /^https?:\/\//i.test(u)) return u.replace(/[\/\s]+$/, '');
  } catch (e) { /* no tunnel -> fallback */ }
  return baseUrl(req);
}

const _assetCache = new Map();

function assetUrl(p, req) {
  const rel = String(p).replace(/^\/+/, '');
  const file = path.join(dbm.rootDir, rel);
  let v = 0;
  try {
    const st = fs.statSync(file);
    v = st.mtimeMs;
  } catch (e) { /* missing -> no version */ }
  return baseUrl(req) + '/' + rel + (v ? '?v=' + Math.floor(v) : '');
}

function avatarUrl(avatar, req) {
  if (!avatar) return '';
  if (/^https?:\/\//i.test(avatar)) return avatar;
  return baseUrl(req) + '/' + String(avatar).replace(/^\/+/, '');
}

function turnConfig() {
  const cfg = appConfig();
  const t = cfg.turn || null;
  const servers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ];
  if (t && t.user && t.pass) {
    let line = '';
    try { line = stripBom(fs.readFileSync(TURN_HOST_FILE, 'utf8')); } catch (e) { /* no tunnel */ }
    let th = null, tp = 3478;
    if (line !== '') {
      const m = /^([^:]+):(\d+)$/.exec(line);
      if (m) { th = m[1]; tp = Number(m[2]); }
      else th = line;
    }
    if (th) {
      servers.push({
        urls: 'turn:' + th + ':' + tp + '?transport=tcp',
        username: t.user,
        credential: t.pass,
      });
    }
  }
  servers.push({ urls: 'turn:openrelay.metered.ca:3478', username: 'openrelayproject', credential: 'openrelayproject' });
  servers.push({ urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' });
  servers.push({ urls: 'turn:openrelay.metered.ca:80?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' });
  return servers;
}

function makeSocketToken(userId, meetingId) {
  const cfg = appConfig();
  const payload = userId + '|' + (meetingId || 0) + '|' + secNow();
  const sig = crypto.createHmac('sha256', cfg.secret).update(payload).digest('hex');
  return payload + '.' + sig;
}

function verifySocketToken(token, out) {
  const cfg = appConfig();
  if (typeof token !== 'string') return false;
  const idx = token.lastIndexOf('.');
  if (idx < 0) return false;
  const payload = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  const expected = crypto.createHmac('sha256', cfg.secret).update(payload).digest('hex');
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
  const f = payload.split('|');
  if (f.length !== 3) return false;
  if (secNow() - parseInt(f[2], 10) > 86400) return false;
  const uid = parseInt(String(f[0]).replace(/^u/, ''), 10);
  out.user_id = uid;
  out.meeting_id = parseInt(f[1], 10);
  return uid > 0;
}

function isDevMode() {
  return !!(appConfig().DEV_MODE);
}

module.exports = {
  sqlNow, sqlNowMinus, secNow, e, toFaDigits, initials, grapheme, generateRoomId, generateOtp,
  timeAgo, baseUrl, publicUrl, assetUrl, avatarUrl, turnConfig,
  makeSocketToken, verifySocketToken, isDevMode,
};