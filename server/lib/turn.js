'use strict';
// ICE server configuration for the call page.
//
// WHY THIS FILE EXISTS
// --------------------
// Two people on DIFFERENT networks (phone on mobile data + laptop on home wifi,
// or any two symmetric/CGNAT connections) cannot always connect with STUN alone.
// ICE then finds no working pair, the peer connection never leaves `checking`,
// and the call page looks *completely dead*: no remote video, no audio in either
// direction, no error message. Only a relay (TURN) fixes that.
//
// The app used to ship ONLY `openrelay.metered.ca`, which is unreachable from
// Iranian networks (all three URLs time out — measured), so cross-network calls
// could never connect. This module builds a relay list that actually works and
// lets the owner plug in their own:
//
//   1. config.json `turnServers`  /  env BM_TURN_SERVERS        (owner's relay)
//   2. Cloudflare TURN (free tier) — credentials minted here when
//      CF_TURN_KEY_ID + CF_TURN_TOKEN are set
//   3. the local relay advertised by turn_host.txt (LAN / same-network)
//   4. a public fallback that is reachable + allocates from Iran (probed)
//
// Credentials are never logged.

const fs = require('fs');
const path = require('path');
const dbm = require('./db');
const { appConfig } = require('./config');

const TURN_HOST_FILE = path.join(dbm.rootDir, 'turn_host.txt');

const STUN = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

// Verified from an Iranian connection: a full TURN Allocate succeeds over UDP 3478
// and real audio+video RTP is relayed through it. Used as a last resort only —
// set BM_TURN_PUBLIC=0 to drop it, or BM_TURN_PUBLIC=1 to force it even when an
// owner-configured relay exists.
const PUBLIC_TURN = [
  {
    urls: ['turn:turn.jami.net:3478?transport=udp', 'turn:turn.jami.net:3478?transport=tcp'],
    username: 'ring',
    credential: 'ring',
  },
];

const CF_URLS = [
  'turn:turn.cloudflare.com:3478?transport=udp',
  'turn:turn.cloudflare.com:3478?transport=tcp',
  'turns:turn.cloudflare.com:5349',
];

// dynamic (short-lived) servers, fetched in the background and served from cache
let dynamic = [];
let dynamicAt = 0;
let dynamicTTL = 0;
let warmPromise = null;

function stripBom(s) {
  return String(s).replace(/^\uFEFF/, '').trim();
}

function norm(list) {
  const out = [];
  (Array.isArray(list) ? list : [list]).forEach((s) => {
    if (!s) return;
    if (typeof s === 'string') {
      const u = s.trim();
      if (u) out.push({ urls: u });
      return;
    }
    if (!s.urls) return;
    const urls = Array.isArray(s.urls) ? s.urls.filter(Boolean) : [s.urls];
    if (!urls.length) return;
    const entry = { urls: urls.length === 1 ? urls[0] : urls };
    if (s.username) entry.username = String(s.username);
    if (s.credential) entry.credential = String(s.credential);
    out.push(entry);
  });
  return out;
}

// `turn:host:3478|user|pass` or a JSON array, same shape as RTCPeerConnection.iceServers
function parseEnvServers(raw) {
  if (!raw) return [];
  const txt = stripBom(raw);
  if (!txt) return [];
  if (txt[0] === '[' || txt[0] === '{') {
    try {
      const j = JSON.parse(txt);
      return norm(j && j.iceServers ? j.iceServers : j);
    } catch (e) {
      console.warn('[turn] BM_TURN_SERVERS is not valid JSON — ignored');
      return [];
    }
  }
  // compact form: one server per line or ';', fields separated by '|'
  return txt.split(/[;\n\r]+/).map((row) => {
    const f = row.split('|').map((x) => x.trim()).filter((x) => x !== '');
    if (!f.length) return null;
    return { urls: f[0], username: f[1] || undefined, credential: f[2] || undefined };
  }).filter(Boolean);
}

// the relay advertised by the local tunnel/turn setup (turn_host.txt is only read
// here — nothing writes it any more, so it stays a manual/legacy override)
function localServers() {
  const t = appConfig().turn;
  if (!t || !t.user || !t.pass) return [];
  let line = '';
  try { line = stripBom(fs.readFileSync(TURN_HOST_FILE, 'utf8')); } catch (e) { return []; }
  if (!line) return [];
  let host = line, port = 3478;
  const m = /^([^:]+):(\d+)$/.exec(line);
  if (m) { host = m[1]; port = Number(m[2]); }
  // both transports: a DPI'd client can reach TCP while UDP is dropped
  return [
    { urls: 'turn:' + host + ':' + port + '?transport=udp', username: t.user, credential: t.pass },
    { urls: 'turn:' + host + ':' + port + '?transport=tcp', username: t.user, credential: t.pass },
  ];
}

function ownerServers() {
  const fromEnv = parseEnvServers(process.env.BM_TURN_SERVERS);
  if (fromEnv.length) return fromEnv;
  const cfg = appConfig();
  return norm(cfg.turnServers || []);
}

function cloudflareConfigured() {
  return !!(process.env.CF_TURN_KEY_ID && process.env.CF_TURN_TOKEN);
}

function publicEnabled(hasOwner) {
  const flag = (process.env.BM_TURN_PUBLIC || '').trim().toLowerCase();
  if (flag === '0' || flag === 'false' || flag === 'no') return false;
  if (flag === '1' || flag === 'true' || flag === 'yes') return true;
  return !hasOwner;
}

// Cloudflare Realtime TURN: a TURN key + token mint short-lived credentials.
// Free tier, and its edge is NOT filtered here (probed: UDP/TCP/TLS all answer).
async function fetchCloudflare() {
  const keyId = process.env.CF_TURN_KEY_ID;
  const token = process.env.CF_TURN_TOKEN;
  if (!keyId || !token) return [];
  const ttl = 86400;
  const res = await fetch('https://rtc.live.cloudflare.com/v1/turn/keys/' + encodeURIComponent(keyId) + '/credentials/generate', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ttl }),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const body = await res.json();
  const ice = body && body.iceServers;
  if (!ice || !ice.credential) throw new Error('no iceServers in response');
  const urls = ice.urls ? (Array.isArray(ice.urls) ? ice.urls : [ice.urls]) : CF_URLS;
  return [{ urls, username: ice.username, credential: ice.credential }];
}

// Refresh the dynamic list; safe to call often (in-flight calls are de-duplicated).
function warm() {
  if (!cloudflareConfigured()) return Promise.resolve(dynamic);
  if (warmPromise) return warmPromise;
  const fresh = dynamic.length && Date.now() - dynamicAt < dynamicTTL;
  if (fresh) return Promise.resolve(dynamic);
  warmPromise = fetchCloudflare()
    .then((list) => {
      if (list.length) {
        dynamic = list;
        dynamicAt = Date.now();
        dynamicTTL = Math.max(60000, 86400000 * 0.7);
        console.log('[turn] Cloudflare TURN credentials refreshed');
      }
      return dynamic;
    })
    .catch((e) => {
      console.warn('[turn] could not mint Cloudflare TURN credentials (' + e.message + ') — keeping the previous set');
      return dynamic;
    })
    .then((list) => { warmPromise = null; return list; });
  return warmPromise;
}

// The list handed to the browser. Never throws: a broken relay config must not
// take the call page down.
function iceServers() {
  const out = STUN.slice();
  let owner = [];
  try { owner = ownerServers(); } catch (e) { owner = []; }
  const local = localServers();
  const dyn = dynamic.slice();
  owner.forEach((s) => out.push(s));
  dyn.forEach((s) => out.push(s));
  local.forEach((s) => out.push(s));
  if (publicEnabled(owner.length + dyn.length > 0)) PUBLIC_TURN.forEach((s) => out.push(s));
  return out;
}

// what the client is actually being given (for the members/debug surface, no secrets)
function summary() {
  return iceServers().map((s) => {
    const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
    return { urls, auth: !!(s.username && s.credential) };
  });
}

module.exports = { iceServers, warm, summary, parseEnvServers, norm, cloudflareConfigured };
