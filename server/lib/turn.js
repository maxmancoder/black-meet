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
// could never connect.
//
// The relay list is built in this order:
//
//   1. config.json `turnServers`  /  env BM_TURN_SERVERS        (owner's relay)
//   2. a generic credentials endpoint — BM_TURN_CREDS_URL (+ optional
//      BM_TURN_CREDS_TOKEN). Point it at ANY free TURN provider that hands out
//      short-lived credentials as JSON; nothing about the provider is hard-coded.
//      Cloudflare Realtime TURN is the built-in variant of this step (CF_TURN_KEY_ID
//      + CF_TURN_TOKEN) but it is optional and NOT required.
//   3. the local relay advertised by turn_host.txt (LAN / same-network)
//   4. a FREE public fallback that needs no account and no card: the Jami relay.
//      Verified from an Iranian connection — full TURN Allocate succeeds over both
//      UDP and TCP 3478 and real audio+video RTP is relayed through it.
//
// Item 4 is why "no sound on the call page" is fixed out of the box: nothing has
// to be registered, bought or verified for two devices on different networks to
// hear each other. Set BM_TURN_PUBLIC=0 to drop it or =1 to force it next to an
// owner relay.
//
// `probeAll()` + `startHealthLoop()` check every shipped relay with a real TURN
// Allocate (RFC 5766, no dependency) so a dead relay shows up in the log and in
// `GET /black-meet/api/turn-status` instead of silently producing a mute call.
// Credentials are never logged.

const fs = require('fs');
const path = require('path');
const net = require('net');
const tls = require('tls');
const dgram = require('dgram');
const crypto = require('crypto');
const dbm = require('./db');
const { appConfig } = require('./config');

const TURN_HOST_FILE = path.join(dbm.rootDir, 'turn_host.txt');

const STUN = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

// Free, account-less, card-less relay. Probed from Iran: Allocate OK on UDP and
// TCP 3478, real audio+video relayed. `turns:` / :443 / :5349 do NOT answer here,
// so only these two transports are advertised.
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

// last relay health snapshot (probe results, no credentials)
const health = { at: 0, results: [], promise: null, timer: null };

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

// A free provider that hands out short-lived credentials over HTTP(S). Works with
// any service returning `{iceServers:[…]}`, `{urls,username,credential}` or a bare
// array; nothing provider-specific is assumed.
function credsUrlConfigured() {
  return !!String(process.env.BM_TURN_CREDS_URL || '').trim();
}

function providerName() {
  if (credsUrlConfigured()) return 'creds-url';
  if (cloudflareConfigured()) return 'cloudflare';
  return null;
}

function publicEnabled(hasOwner) {
  const flag = (process.env.BM_TURN_PUBLIC || '').trim().toLowerCase();
  if (flag === '0' || flag === 'false' || flag === 'no') return false;
  if (flag === '1' || flag === 'true' || flag === 'yes') return true;
  return !hasOwner;
}

// Cloudflare Realtime TURN: a TURN key + token mint short-lived credentials.
// Free tier, and its edge is NOT filtered here (probed: UDP/TCP/TLS all answer).
// OPTIONAL — the free public fallback works without it.
async function fetchCloudflare() {
  const keyId = process.env.CF_TURN_KEY_ID;
  const token = process.env.CF_TURN_TOKEN;
  if (!keyId || !token) return { list: [] };
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
  return { list: [{ urls, username: ice.username, credential: ice.credential }], ttl: ttl * 1000 };
}

async function fetchCredsUrl() {
  const url = String(process.env.BM_TURN_CREDS_URL || '').trim();
  if (!url) return { list: [] };
  const headers = { Accept: 'application/json' };
  const token = String(process.env.BM_TURN_CREDS_TOKEN || '').trim();
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const body = await res.json();
  const src = body && body.iceServers ? body.iceServers : body;
  const list = norm(src).filter((s) => /^turns?:/i.test(String([].concat(s.urls)[0])));
  if (!list.length) throw new Error('no turn: entries in response');
  // providers that hand out expiring credentials usually say for how long (seconds)
  let ttlMs = 86400000;
  const cand = [body && body.ttl, body && body.iceServers && body.iceServers.ttl];
  for (const v of cand) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) { ttlMs = n > 1e6 ? n : n * 1000; break; }
  }
  return { list, ttl: ttlMs };
}

// Refresh the dynamic list; safe to call often (in-flight calls are de-duplicated).
function warm() {
  if (!providerName()) return Promise.resolve(dynamic);
  if (warmPromise) return warmPromise;
  const fresh = dynamic.length && Date.now() - dynamicAt < dynamicTTL;
  if (fresh) return Promise.resolve(dynamic);
  const label = providerName() === 'cloudflare' ? 'Cloudflare TURN' : 'TURN provider';
  warmPromise = Promise.resolve()
    .then(() => (providerName() === 'cloudflare' ? fetchCloudflare() : fetchCredsUrl()))
    .then((res) => {
      const list = (res && res.list) || [];
      if (list.length) {
        dynamic = list;
        dynamicAt = Date.now();
        const ttl = res.ttl && res.ttl > 0 ? res.ttl : 86400000;
        dynamicTTL = Math.max(60000, ttl * 0.7);
        console.log('[turn] ' + label + ' credentials refreshed');
      }
      return dynamic;
    })
    .catch((e) => {
      console.warn('[turn] could not mint ' + label + ' credentials (' + e.message + ') — keeping the previous set');
      return dynamic;
    })
    .then((list) => { warmPromise = null; return list; });
  return warmPromise;
}

// ---------------------------------------------------------------------------
// Relay health probe — a real TURN Allocate (RFC 5766), dependency-free.
// Runs on the SERVER's network, so it proves the relay is alive, not that a
// client in Iran can reach it; a failing client shows in the in-call banner.
// ---------------------------------------------------------------------------
const MAGIC = 0x2112a442;
const ATTR_USERNAME = 0x0006;
const ATTR_MESSAGE_INTEGRITY = 0x0008;
const ATTR_ERROR_CODE = 0x0009;
const ATTR_REALM = 0x0014;
const ATTR_NONCE = 0x0015;
const ATTR_XOR_RELAYED = 0x0016;
const ATTR_REQUESTED_TRANSPORT = 0x0019;
const REQ_ALLOCATE = 0x0003;
const CLS_ERROR = 3;

function stunAttr(type, value) {
  const len = value.length;
  const pad = (4 - (len % 4)) % 4;
  const b = Buffer.alloc(4 + len + pad);
  b.writeUInt16BE(type, 0);
  b.writeUInt16BE(len, 2);
  value.copy(b, 4);
  return b;
}

function stunBuild(txid, auth) {
  const attrs = [stunAttr(ATTR_REQUESTED_TRANSPORT, Buffer.from([17, 0, 0, 0]))];
  if (auth) {
    attrs.unshift(
      stunAttr(ATTR_USERNAME, Buffer.from(auth.user)),
      stunAttr(ATTR_REALM, Buffer.from(auth.realm)),
      stunAttr(ATTR_NONCE, auth.nonce)
    );
  }
  const body = Buffer.concat(attrs);
  const head = Buffer.alloc(20);
  head.writeUInt16BE(REQ_ALLOCATE, 0);
  head.writeUInt16BE(body.length + (auth ? 24 : 0), 2);
  head.writeUInt32BE(MAGIC, 4);
  txid.copy(head, 8);
  const partial = Buffer.concat([head, body]);
  if (!auth) return partial;
  const key = crypto.createHash('md5').update(auth.user + ':' + auth.realm + ':' + auth.pass).digest();
  const hmac = crypto.createHmac('sha1', key).update(partial).digest();
  return Buffer.concat([partial, stunAttr(ATTR_MESSAGE_INTEGRITY, hmac)]);
}

function stunParse(buf) {
  if (!buf || buf.length < 20) return null;
  const type = buf.readUInt16BE(0);
  const len = buf.readUInt16BE(2);
  const out = { type, cls: (((type >> 4) & 1) << 1) | ((type >> 8) & 1), attrs: {} };
  let o = 20;
  const end = Math.min(buf.length, 20 + len);
  while (o + 4 <= end) {
    const t = buf.readUInt16BE(o);
    const l = buf.readUInt16BE(o + 2);
    out.attrs[t] = buf.slice(o + 4, o + 4 + l);
    o += 4 + l + ((4 - (l % 4)) % 4);
  }
  return out;
}

function xorAddr(v) {
  if (!v || v.length < 8) return '';
  const port = v.readUInt16BE(2) ^ (MAGIC >> 16);
  return [v[4] ^ 0x21, v[5] ^ 0x12, v[6] ^ 0xa4, v[7] ^ 0x42].join('.') + ':' + port;
}

// turn:host:port[?transport=udp|tcp] / turns:host:port
function parseTurnUrl(raw) {
  const m = /^(turns?):([^:?/]+)(?::(\d+))?(?:\?([^#]*))?$/i.exec(String(raw || '').trim());
  if (!m) return null;
  const secure = m[1].toLowerCase() === 'turns';
  const q = m[4] || '';
  const t = /(?:^|&)transport=([a-z]+)/i.exec(q);
  const transport = secure ? 'tls' : (t ? t[1].toLowerCase() : 'udp');
  if (!['udp', 'tcp', 'tls'].includes(transport)) return null;
  return { host: m[2], port: Number(m[3]) || (secure ? 5349 : 3478), transport };
}

function probeUdp(target, username, credential, timeoutMs) {
  return new Promise((resolve) => {
    const txid = crypto.randomBytes(12);
    let sock;
    try { sock = dgram.createSocket('udp4'); } catch (e) { return resolve({ ok: false, error: 'socket' }); }
    let done = false;
    let authed = false;
    const fin = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { sock.close(); } catch (e) {}
      resolve(r);
    };
    const timer = setTimeout(() => fin({ ok: false, error: 'timeout' }), timeoutMs);
    sock.on('error', (e) => fin({ ok: false, error: e.code || 'error' }));
    sock.on('message', (m) => {
      const r = stunParse(m);
      if (!r) return;
      if (r.attrs[ATTR_XOR_RELAYED]) return fin({ ok: true, relay: xorAddr(r.attrs[ATTR_XOR_RELAYED]) });
      if (r.cls === CLS_ERROR) {
        const realm = r.attrs[ATTR_REALM] ? r.attrs[ATTR_REALM].toString() : '';
        const nonce = r.attrs[ATTR_NONCE] ? r.attrs[ATTR_NONCE] : Buffer.alloc(0);
        if (!authed && username && credential) {
          authed = true;
          sock.send(stunBuild(txid, { user: username, pass: credential, realm, nonce }), target.port, target.host);
          return;
        }
        const code = r.attrs[ATTR_ERROR_CODE] ? 400 + (r.attrs[ATTR_ERROR_CODE][2] || 0) : 0;
        return fin({ ok: false, error: authed ? 'auth ' + code : 'needs credentials' + (realm ? ' (realm=' + realm + ')' : '') });
      }
      fin({ ok: false, error: 'unexpected reply' });
    });
    sock.send(stunBuild(txid, null), target.port, target.host);
  });
}

function probeStream(target, username, credential, timeoutMs) {
  return new Promise((resolve) => {
    const txid = crypto.randomBytes(12);
    let sock;
    try {
      sock = target.transport === 'tls'
        ? tls.connect({ host: target.host, port: target.port, servername: target.host, rejectUnauthorized: false })
        : net.connect({ host: target.host, port: target.port });
    } catch (e) {
      return resolve({ ok: false, error: 'socket' });
    }
    let done = false;
    let authed = false;
    let buf = Buffer.alloc(0);
    const fin = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { sock.destroy(); } catch (e) {}
      resolve(r);
    };
    const timer = setTimeout(() => fin({ ok: false, error: 'timeout' }), timeoutMs);
    const send = () => { try { sock.write(stunBuild(txid, null)); } catch (e) {} };
    sock.on('connect', send);
    sock.on('secureConnect', send);
    sock.on('error', (e) => fin({ ok: false, error: e.code || 'error' }));
    sock.on('close', () => fin({ ok: false, error: 'closed' }));
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      const r = stunParse(buf);
      if (!r) return;
      if (r.attrs[ATTR_XOR_RELAYED]) return fin({ ok: true, relay: xorAddr(r.attrs[ATTR_XOR_RELAYED]) });
      if (r.cls === CLS_ERROR) {
        const realm = r.attrs[ATTR_REALM] ? r.attrs[ATTR_REALM].toString() : '';
        const nonce = r.attrs[ATTR_NONCE] ? r.attrs[ATTR_NONCE] : Buffer.alloc(0);
        if (!authed && username && credential) {
          authed = true;
          buf = Buffer.alloc(0);
          try { sock.write(stunBuild(txid, { user: username, pass: credential, realm, nonce })); } catch (e) {}
          return;
        }
        const code = r.attrs[ATTR_ERROR_CODE] ? 400 + (r.attrs[ATTR_ERROR_CODE][2] || 0) : 0;
        return fin({ ok: false, error: authed ? 'auth ' + code : 'needs credentials' });
      }
      fin({ ok: false, error: 'unexpected reply' });
    });
  });
}

async function probeOne(rawUrl, username, credential, timeoutMs) {
  const target = parseTurnUrl(rawUrl);
  if (!target) return { url: rawUrl, ok: false, error: 'unsupported url' };
  const t0 = Date.now();
  const attempt = async () => {
    try {
      return target.transport === 'udp'
        ? await probeUdp(target, username, credential, timeoutMs)
        : await probeStream(target, username, credential, timeoutMs);
    } catch (e) {
      return { ok: false, error: e.message };
    }
  };
  let r = await attempt();
  // one retry on a transport hiccup keeps a flaky UDP path from reading as "dead";
  // an auth error is final (retrying cannot change it)
  if (!r.ok && !/credential|auth/.test(String(r.error || ''))) r = await attempt();
  return { url: rawUrl, transport: target.transport, ok: !!r.ok, ms: Date.now() - t0, relay: r.relay || null, error: r.error || null };
}

// every relay entry we could ship, flattened to single URLs
function probeTargets() {
  const out = [];
  const add = (list, source) => {
    (list || []).forEach((s) => {
      [].concat(s.urls).forEach((u) => {
        if (!/^turns?:/i.test(String(u))) return;
        out.push({ url: u, username: s.username, credential: s.credential, source });
      });
    });
  };
  try { add(ownerServers(), 'owner'); } catch (e) {}
  add(dynamic, 'dynamic');
  try { add(localServers(), 'local'); } catch (e) {}
  if (publicEnabled(out.length > 0)) add(PUBLIC_TURN, 'public');
  return out.slice(0, 12);
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

function probeTimeoutMs() {
  const n = Number(process.env.BM_TURN_PROBE_TIMEOUT_MS);
  return Number.isFinite(n) && n >= 500 ? n : 4000;
}

// Probe every shipped relay. Never throws, never blocks a request.
function probeAll() {
  if (health.promise) return health.promise;
  let targets = [];
  try { targets = probeTargets(); } catch (e) { targets = []; }
  if (!targets.length) return Promise.resolve(health);
  const ms = probeTimeoutMs();
  health.promise = mapLimit(targets, 4, (t) => probeOne(t.url, t.username, t.credential, ms))
    .then((res) => {
      health.at = Date.now();
      health.results = res;
      logHealth(res, targets);
      return health;
    })
    .catch((e) => {
      console.warn('[turn] relay probe failed: ' + e.message);
      return health;
    })
    .then((h) => { health.promise = null; return h; });
  return health.promise;
}

function logHealth(results, targets) {
  results.forEach((r) => {
    const src = (targets.find((t) => t.url === r.url) || {}).source || '?';
    if (r.ok) console.log('[turn] relay ' + r.url + ' (' + src + ') OK ' + r.ms + 'ms relay=' + r.relay);
    else console.log('[turn] relay ' + r.url + ' (' + src + ') FAILED ' + r.ms + 'ms — ' + (r.error || '?'));
  });
  const pub = results.filter((r) => (targets.find((t) => t.url === r.url) || {}).source === 'public');
  if (pub.length && !pub.some((r) => r.ok)) {
    console.warn('[turn] no public relay answered from this host — cross-network calls will show the network banner');
  }
}

function startHealthLoop() {
  if (health.timer) return health.timer;
  const min = Number(process.env.BM_TURN_PROBE_MIN);
  const everyMin = Number.isFinite(min) && min >= 0 ? min : 30;
  probeAll();
  if (!everyMin) return null;
  health.timer = setInterval(probeAll, everyMin * 60 * 1000);
  if (health.timer.unref) health.timer.unref();
  return health.timer;
}

function urlHealth(url) {
  const r = health.results.find((x) => x.url === url);
  return r ? r.ok : null; // null = never probed yet
}

// healthy (or not-yet-probed) relays first; a probe that failed pushes the entry
// to the back without removing it — the browser may still reach what the server can't
function orderedPublic() {
  if (!health.at) return PUBLIC_TURN.slice();
  const rank = (s) => {
    const states = [].concat(s.urls).map(urlHealth);
    if (states.some((v) => v === true)) return 0;
    if (states.some((v) => v === null)) return 1;
    return 2;
  };
  return PUBLIC_TURN.slice().sort((a, b) => rank(a) - rank(b));
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
  if (publicEnabled(owner.length + dyn.length > 0)) orderedPublic().forEach((s) => out.push(s));
  return out;
}

// what the client is actually being given (for the members/debug surface, no secrets)
function summary() {
  return iceServers().map((s) => {
    const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
    return { urls, auth: !!(s.username && s.credential) };
  });
}

// Manager-facing status: what we ship, where it came from and whether it answered.
// Host names and results only — never a credential.
function status() {
  const list = summary();
  return {
    ok: true,
    provider: providerName(),
    publicFallback: list.some((s) => s.urls.some((u) => /^turns?:.*jami\.net/i.test(u))),
    turnCount: list.filter((s) => s.urls.some((u) => /^turns?:/i.test(u))).length,
    iceServers: list,
    probe: {
      at: health.at || null,
      ageSec: health.at ? Math.round((Date.now() - health.at) / 1000) : null,
      results: health.results,
    },
  };
}

module.exports = {
  iceServers, warm, summary, status, probeAll, startHealthLoop, probeOne,
  parseEnvServers, norm, cloudflareConfigured, credsUrlConfigured, providerName, parseTurnUrl,
};
