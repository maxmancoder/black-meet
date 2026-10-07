'use strict';
// server/lib/siteproxy.js — same-origin fetcher for the call page's shared website box.
//
// The iframe MUST be same-origin with the app, otherwise the call page can neither
// read its scroll position nor replay clicks on it, and the "everyone controls the
// site, live" requirement collapses. So we fetch the page server-side, rewrite every
// sub-resource URL to point back through this proxy, and strip the framing/CSP
// headers that would otherwise block embedding. Clicks and scrolls are reported back
// to the parent via postMessage so the parent (which owns the socket) can relay them.
const dns = require('dns').promises;
const net = require('net');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const MAX_BYTES = 4 * 1024 * 1024;
const TIMEOUT_MS = 15000;
const MAX_REDIRECTS = 4;

// Only public hosts: never proxy the app's own box (or anything else on the LAN).
function isPrivateHost(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h === 'metadata.google.internal') return true;
  if (net.isIPv4(h)) {
    const p = h.split('.').map(Number);
    if (p[0] === 127 || p[0] === 10 || p[0] === 0) return true;
    if (p[0] === 169 && p[1] === 254) return true;
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true;
    return false;
  }
  if (net.isIPv6(h)) {
    if (h === '::1' || h === '::') return true;
    if (/^f[cd]/.test(h)) return true;
    if (h.startsWith('fe80')) return true;
    const m = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (m) return isPrivateHost(m[1]);
    return false;
  }
  return false;
}

async function resolveHost(hostname) {
  if (net.isIP(hostname)) {
    if (isPrivateHost(hostname)) throw new Error('BLOCKED_HOST');
    return [hostname];
  }
  const recs = await dns.lookup(hostname, { all: true });
  if (!recs.length) throw new Error('DNS_EMPTY');
  for (const r of recs) {
    if (isPrivateHost(r.address)) throw new Error('BLOCKED_HOST');
  }
  return recs.map((r) => r.address);
}

async function fetchTarget(rawUrl, redirectCount = 0) {
  if (redirectCount > MAX_REDIRECTS) throw new Error('TOO_MANY_REDIRECTS');
  const u = new URL(rawUrl);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('BAD_PROTOCOL');
  await resolveHost(u.hostname);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(u.href, {
      redirect: 'manual',
      signal: ctl.signal,
      headers: { 'User-Agent': UA, 'Accept': '*/*', 'Accept-Language': 'fa,en;q=0.8' },
    });
  } finally {
    clearTimeout(timer);
  }
  if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
    const next = new URL(res.headers.get('location'), u.href).href;
    return fetchTarget(next, redirectCount + 1);
  }
  return { url: u.href, res };
}

function proxyPath(absUrl) {
  return '/black-meet/site-proxy?u=' + encodeURIComponent(absUrl);
}

function absolutize(v, baseUrl) {
  const s = String(v || '').trim();
  if (!s) return null;
  if (/^(data:|blob:|javascript:|mailto:|tel:|about:|chrome-extension:|#)/i.test(s)) return null;
  try {
    return new URL(s, baseUrl).href;
  } catch (e) {
    return null;
  }
}

// Rewrites href/src/action/srcset/style url() to the proxy so nothing 403s on framing.
function rewriteHtml(html, baseUrl) {
  let out = html;
  const SKIP = /^(#|data:|blob:|javascript:|mailto:|tel:|about:)/i;
  // quoted AND unquoted attribute values (minified pages use <script src=/x.js>)
  out = out.replace(/(\s(?:href|src|action|poster|data-src|data-href)\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi,
    (m, pre, dq, sq, uq) => {
      const val = dq !== undefined ? dq : (sq !== undefined ? sq : uq);
      if (val === undefined || SKIP.test(String(val).trim())) return m;
      const abs = absolutize(val, baseUrl);
      if (!abs || !/^https?:/i.test(abs)) return m;
      const q = dq !== undefined ? '"' : (sq !== undefined ? "'" : '');
      const close = q ? q : '';
      return pre + q + proxyPath(abs) + close;
    });
  out = out.replace(/(\ssrcset\s*=\s*)(["'])([^"']*)\2/gi, (m, pre, q, val) => {
    const parts = val.split(',').map((chunk) => {
      const bits = chunk.trim().split(/\s+/);
      const abs = absolutize(bits[0], baseUrl);
      if (!abs || !/^https?:/i.test(abs)) return chunk.trim();
      return proxyPath(abs) + (bits[1] ? ' ' + bits[1] : '');
    });
    return pre + q + parts.join(', ') + q;
  });
  out = out.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (m, q, val) => {
    const abs = absolutize(val, baseUrl);
    if (!abs || !/^https?:/i.test(abs)) return m;
    return 'url(' + proxyPath(abs) + ')';
  });
  // base href would undo our rewriting
  out = out.replace(/<base\b[^>]*>/gi, '');
  return out;
}

const BRIDGE = `<script>(function(){
  function post(m){ try{ parent.postMessage(Object.assign({__bmweb:1}, m), '*'); }catch(e){} }
  var t=null;
  function scroll(){
    var de=document.documentElement;
    var max=Math.max(1,(de.scrollHeight||0)-window.innerHeight);
    post({type:'scroll', ratio: Math.max(0,Math.min(1,(window.pageYOffset||de.scrollTop||0)/max))});
  }
  addEventListener('scroll', function(){ clearTimeout(t); t=setTimeout(scroll,120); }, {passive:true});
  addEventListener('click', function(e){
    var el=e.target; if(!el||!el.closest) return;
    var de=document.documentElement;
    var maxX=Math.max(1,(de.scrollWidth||0)-window.innerWidth);
    var maxY=Math.max(1,(de.scrollHeight||0)-window.innerHeight);
    post({type:'click', x: Math.max(0,Math.min(1,(e.pageX||0)/maxX)), y: Math.max(0,Math.min(1,(e.pageY||0)/maxY))});
  }, true);
  addEventListener('load', function(){ scroll(); post({type:'ready'}); });
  addEventListener('message', function(ev){
    var d=ev.data; if(!d||d.__bmweb!==2) return;
    var de=document.documentElement;
    if(d.type==='scroll'){
      var max=Math.max(0,(de.scrollHeight||0)-window.innerHeight);
      window.scrollTo(0, (Number(d.ratio)||0)*max);
    } else if(d.type==='click'){
      var x=(Number(d.x)||0)*(window.innerWidth||1), y=(Number(d.y)||0)*(window.innerHeight||1);
      var el=document.elementFromPoint(x,y);
      if(el&&el.click) el.click();
    }
  });
  scroll();
})();</script>`;

function injectBridge(html) {
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => m + BRIDGE);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (m) => m + '<head>' + BRIDGE + '</head>');
  return BRIDGE + html;
}

// Full router: handles ?u=<encoded absolute url>
async function handleSiteProxy(req, res) {
  const target = req.query && req.query.u;
  if (!target) return res.status(400).type('text').send('missing u');
  let abs;
  try { abs = new URL(String(target)); } catch (e) { return res.status(400).type('text').send('bad url'); }
  if (abs.protocol !== 'http:' && abs.protocol !== 'https:') return res.status(400).type('text').send('bad protocol');

  let got;
  try {
    got = await fetchTarget(abs.href);
  } catch (e) {
    const msg = (e && e.message) || 'FETCH_FAILED';
    const blocked = msg === 'BLOCKED_HOST';
    return res.status(blocked ? 403 : 502).type('html').send(
      '<meta charset="utf-8"><body style="font-family:Tahoma;background:#111;color:#eee;padding:24px">' +
      (blocked ? 'این آدرس قابل نمایش نیست (آدرس داخلی مجاز نیست).' : 'دریافت صفحه ممکن نشد: ' + msg) + '</body>'
    );
  }

  const ctype = String(got.res.headers.get('content-type') || '').toLowerCase();
  const finalUrl = got.url;

  // Non-HTML sub-resources: stream them straight through with their own type.
  if (!ctype.includes('html') && !ctype.includes('xhtml')) {
    const buf = Buffer.from(await got.res.arrayBuffer());
    if (buf.length > MAX_BYTES) return res.status(413).type('text').send('too large');
    res.setHeader('Content-Type', ctype || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.end(buf);
  }

  let html = await got.res.text();
  html = rewriteHtml(html, finalUrl);
  html = injectBridge(html);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  // strip anything that would block being framed
  res.removeHeader('X-Frame-Options');
  res.removeHeader('Content-Security-Policy');
  res.removeHeader('Content-Security-Policy-Report-Only');
  res.removeHeader('X-Content-Type-Options');
  res.setHeader('Access-Control-Allow-Origin', '*');
  return res.end(html);
}

module.exports = { handleSiteProxy, proxyPath, isPrivateHost };
