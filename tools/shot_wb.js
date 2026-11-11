'use strict';
// End-to-end whiteboard test (stage-box design): two SEPARATE browser contexts (two
// accounts) in one meeting room, system Chrome, local server on :3100.
//   node tools/shot_wb.js "<repo root>" [baseUrl]
// Requires: local server on BASE (default http://127.0.0.1:3100), DEV_MODE=true.
// Creates its own user through the signup API, removes every row it created at the end and
// writes screenshots to %TEMP%\opencode (wb-*.png).
//
// The board is NO LONGER a sidebar panel: it is a box appended to #video-grid, next to the
// shared site/video/audio box, it can be maximized into the full-viewport overlay and it is
// white (the owner's requirement: «پس‌زمینه‌اش سفید باشد»).
const path = require('path');
const ROOT = process.argv[2] || process.cwd();
const BASE = process.argv[3] || 'http://127.0.0.1:3100';
const MOUNT = BASE + '/black-meet';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const OUT = path.join(process.env.TEMP || ROOT, 'opencode');
const puppeteer = require(path.join(ROOT, 'node_modules', 'puppeteer-core'));
const dbm = require(path.join(ROOT, 'server', 'lib', 'db'));
const settings = require(path.join(ROOT, 'server', 'lib', 'settings'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;
function check(n, desc, cond, reason) {
  if (cond) {
    pass++;
    console.log('[PASS] ' + n + '. ' + desc);
  } else {
    fail++;
    console.log('[FAIL] ' + n + '. ' + desc + ' — ' + JSON.stringify(reason !== undefined ? reason : 'failed').slice(0, 400));
  }
}
async function waitFn(page, fn, arg, ms) {
  try {
    await page.waitForFunction(fn, { timeout: ms || 2000, polling: 60 }, arg);
    return true;
  } catch (e) {
    return false;
  }
}

// how many canvas pixels carry ink (alpha > 12) — the cheapest "did the stroke arrive" probe
const inkCount = () => {
  const c = document.getElementById('wb-canvas');
  if (!c || !c.width || !c.height) return -1;
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let n = 0;
  for (let i = 3; i < d.length; i += 16) if (d[i] > 12) n++;
  return n;
};
const boxInfo = () => {
  const box = document.getElementById('wb-box');
  if (!box) return null;
  const body = document.getElementById('wb-canvas-wrap');
  const cv = document.getElementById('wb-canvas');
  const head = box.querySelector('.wb-head');
  const title = box.querySelector('.wb-head-title');
  const tb = document.getElementById('wb-toolbar');
  const badge = document.getElementById('wb-viewer-badge');
  return {
    inGrid: box.parentElement ? box.parentElement.id === 'video-grid' : false,
    bodyBg: body ? getComputedStyle(body).backgroundColor : '',
    headBg: head ? getComputedStyle(head).backgroundColor : '',
    title: title ? title.textContent.trim() : '',
    canvas: cv ? { w: cv.width, h: cv.height } : null,
    pointer: cv ? cv.style.pointerEvents : '',
    toolbar: tb ? getComputedStyle(tb).display !== 'none' : null,
    viewerBadge: badge ? !badge.classList.contains('hidden') : null,
    pageScroll: document.documentElement.scrollHeight - document.documentElement.clientHeight,
  };
};

(async () => {
  const prevMode = settings.signupMode();
  settings.setSetting('signup_mode', 'open');

  const stamp = Date.now().toString(36);
  const uname = 'wb8_' + stamp;
  const phone = '0912' + String(Date.now()).slice(-7);
  const email = uname + '@example.com';
  const passwd = 'WbTest!2345';
  const full = 'Whiteboard Test User';

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    protocolTimeout: 180000,
    args: [
      '--no-sandbox',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--lang=fa',
    ],
  });

  const errors = [];
  const ctxA = await browser.createBrowserContext();
  const ctxU = await browser.createBrowserContext();
  const A = await ctxA.newPage();
  const U = await ctxU.newPage();
  for (const p of [A, U]) {
    await p.setViewport({ width: 1440, height: 900 });
    p.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  }

  // ---------- 1. admin login (credentials come from the local config, never hardcoded) ----------
  const adminCfg = require(path.join(ROOT, 'config.json')).admin || {};
  await A.goto(MOUNT + '/login', { waitUntil: 'networkidle2', timeout: 90000 });
  const csrfA0 = await A.evaluate(() => window.CSRF);
  const loginRes = await A.evaluate(async (d) => {
    const r = await fetch('/black-meet/api/login/email', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(d),
    });
    return r.json();
  }, { email: adminCfg.email, password: adminCfg.password, csrf: csrfA0 });
  await A.goto(MOUNT + '/home', { waitUntil: 'networkidle2', timeout: 90000 });
  const homeA = await A.evaluate(() => ({ url: location.pathname, dash: document.body.classList.contains('bm-dash') }));
  check(1, 'admin logs in and lands on /home', !!(loginRes && loginRes.ok) && homeA.url.endsWith('/home') && homeA.dash, { loginRes, homeA });

  // ---------- 2. regular user: signup + OTP (DEV_MODE returns the code) ----------
  await U.goto(MOUNT + '/login', { waitUntil: 'networkidle2', timeout: 90000 });
  const csrfU0 = await U.evaluate(() => window.CSRF);
  const signupRes = await U.evaluate(async (d) => {
    const r = await fetch('/black-meet/api/signup', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(d),
    });
    return r.json();
  }, { full_name: full, username: uname, email, phone, password: passwd, csrf: csrfU0 });
  let verifyRes = null;
  if (signupRes && signupRes.ok && signupRes.otp) {
    verifyRes = await U.evaluate(async (d) => {
      const r = await fetch('/black-meet/api/login/verify', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(d),
      });
      return r.json();
    }, { phone, code: signupRes.otp, purpose: 'signup', csrf: csrfU0 });
  }
  await U.goto(MOUNT + '/home', { waitUntil: 'networkidle2', timeout: 90000 });
  const homeU = await U.evaluate(() => ({ url: location.pathname, dash: document.body.classList.contains('bm-dash') }));
  check(2, 'regular user signs up, logs in and lands on /home',
    !!(signupRes && signupRes.ok && signupRes.otp) && !!(verifyRes && verifyRes.ok) && homeU.url.endsWith('/home'),
    { signupRes, verifyRes, homeU });

  // ---------- 3. admin creates the meeting (open_join so the member is approved at once) ----------
  const csrfA1 = await A.evaluate(() => window.CSRF);
  const created = await A.evaluate(async (d) => {
    const r = await fetch('/black-meet/api/meetings/create', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(d),
    });
    return r.json();
  }, { title: 'تست وایت‌برد پایانی ' + stamp, open_join: '1', csrf: csrfA1 });
  const room = created && created.room_id;
  const meetingRow = room ? dbm.get('SELECT id FROM meetings WHERE room_id=?', [room]) : null;
  const meetingId = meetingRow ? Number(meetingRow.id) : 0;
  const userRow = dbm.get('SELECT id FROM users WHERE phone=?', [phone]);
  const userId = userRow ? Number(userRow.id) : 0;
  check(3, 'admin creates a meeting and gets room_id', !!(created && created.ok && room && meetingId), created);

  // ---------- 4. both join the room ----------
  for (const p of [A, U]) {
    await p.goto(MOUNT + '/meeting?room=' + encodeURIComponent(room), { waitUntil: 'networkidle2', timeout: 90000 });
  }
  const roster2 = () => !!(window.bmCallRoster && window.bmCallRoster().length >= 2);
  const joinedA = await waitFn(A, roster2, null, 20000);
  const joinedU = await waitFn(U, roster2, null, 20000);
  check(4, 'both users join the meeting room', joinedA && joinedU, { joinedA, joinedU, urlA: A.url(), urlU: U.url() });

  // ---------- 5. the board is not in the sidebar any more ----------
  const side = await A.evaluate(() => ({
    tab: !!document.getElementById('tab-wb'),
    panel: !!document.getElementById('content-wb'),
    btn: !!document.getElementById('btn-wb'),
    inBar: !!document.querySelector('#control-bar #btn-wb'),
  }));
  check(5, 'no whiteboard tab/panel anywhere in the sidebar', side.tab === false && side.panel === false, side);
  check(6, '#btn-wb is a key in the control bar', side.btn === true && side.inBar === true, side);

  // ---------- 7-11. admin opens the box; it is a white stage box on both sides ----------
  await A.click('#btn-wb');
  const gotA = await waitFn(A, () => !!document.getElementById('wb-box'), null, 4000);
  const gotU = await waitFn(U, () => !!document.getElementById('wb-box'), null, 4000);
  const infoA = await A.evaluate(boxInfo);
  const infoU = gotU ? await U.evaluate(boxInfo) : null;
  check(7, 'the board opens as a box in #video-grid for both members',
    gotA && gotU && !!infoA && infoA.inGrid && !!infoU && infoU.inGrid, { infoA, infoU });
  check(8, 'the board body is WHITE', !!infoA && infoA.bodyBg === 'rgb(255, 255, 255)', infoA && infoA.bodyBg);
  check(9, 'the box header is themed and titled', !!infoA && infoA.headBg !== 'rgba(0, 0, 0, 0)' && infoA.title.indexOf('وایت') !== -1, infoA);
  check(10, 'the canvas has a real size on both sides',
    !!infoA && infoA.canvas && infoA.canvas.w > 100 && infoA.canvas.h > 60 &&
    !!infoU && infoU.canvas && infoU.canvas.w > 100 && infoU.canvas.h > 60, { a: infoA && infoA.canvas, u: infoU && infoU.canvas });
  check(11, 'the stage still does not scroll with the box open', !!infoA && infoA.pageScroll <= 0, infoA && infoA.pageScroll);
  if (gotA) await A.screenshot({ path: path.join(OUT, 'wb-box-admin.png') });

  // ---------- 12-13. permissions on the canvas ----------
  check(12, 'the admin can draw (toolbar shown, pointer-events auto)',
    !!infoA && infoA.toolbar === true && infoA.pointer === 'auto', infoA);
  check(13, 'the member is a viewer (no toolbar, dead canvas, badge shown)',
    !!infoU && infoU.toolbar === false && infoU.pointer === 'none' && infoU.viewerBadge === true, infoU);

  // ---------- 14-15. the admin draws and the stroke is relayed quickly ----------
  const bb = await A.evaluate(() => {
    const r = document.getElementById('wb-canvas').getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  });
  await A.mouse.move(bb.x + bb.w * 0.15, bb.y + bb.h * 0.2);
  await A.mouse.down();
  for (let i = 1; i <= 12; i++) {
    await A.mouse.move(bb.x + bb.w * (0.15 + 0.05 * i), bb.y + bb.h * (0.2 + 0.04 * i));
    await sleep(16);
  }
  await A.mouse.up();
  const t0 = Date.now();
  let seen = -1;
  let latency = -1;
  for (let i = 0; i < 75; i++) {
    seen = await U.evaluate(inkCount);
    if (seen > 0) { latency = Date.now() - t0; break; }
    await sleep(40);
  }
  const aInk = await A.evaluate(inkCount);
  check(14, 'the admin stroke reaches the member', seen > 0 && aInk > 0, { seen, aInk });
  check(15, 'the stroke arrives fast (<800ms)', latency >= 0 && latency < 800, { latency });

  // ---------- 16-18. the admin hands out draw access from the in-box panel ----------
  await A.click('#wb-btn-grant');
  await sleep(400);
  const panel = await A.evaluate(() => {
    const p = document.getElementById('wb-grant-panel');
    return {
      open: !!p && !p.classList.contains('hidden'),
      insideBox: p ? !!p.closest('#wb-box') : false,
      rows: document.querySelectorAll('#wb-grant-list .wb-grant-btn').length,
    };
  });
  check(16, 'the grant panel opens inside the box and lists the member',
    panel.open && panel.insideBox && panel.rows >= 1, panel);
  if (panel.open) await A.screenshot({ path: path.join(OUT, 'wb-box-grant.png') });
  await A.evaluate(() => {
    const b = document.querySelector('#wb-grant-list .wb-grant-btn');
    if (b) b.click();
  });
  const granted = await waitFn(U, () => {
    const t = document.getElementById('wb-toolbar');
    const c = document.getElementById('wb-canvas');
    return !!t && getComputedStyle(t).display !== 'none' && !!c && c.style.pointerEvents === 'auto';
  }, null, 4000);
  const grantedInfo = await U.evaluate(boxInfo);
  check(17, 'the granted member can draw (toolbar + live canvas, badge gone)',
    granted && grantedInfo.toolbar === true && grantedInfo.pointer === 'auto' && grantedInfo.viewerBadge === false, grantedInfo);

  const bbU = await U.evaluate(() => {
    const r = document.getElementById('wb-canvas').getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  });
  await U.mouse.move(bbU.x + bbU.w * 0.7, bbU.y + bbU.h * 0.7);
  await U.mouse.down();
  for (let i = 1; i <= 8; i++) {
    await U.mouse.move(bbU.x + bbU.w * 0.7 - i * 9, bbU.y + bbU.h * 0.7 - i * 6);
    await sleep(16);
  }
  await U.mouse.up();
  const adminSawGranted = await waitFn(A, (base) => {
    const c = document.getElementById('wb-canvas');
    if (!c || !c.width) return false;
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 16) if (d[i] > 12) n++;
    return n > base;
  }, aInk, 3000);
  check(18, 'the admin receives the granted member stroke', adminSawGranted, { aInk });

  // ---------- 19. maximize = full-viewport overlay with a white sheet ----------
  await A.evaluate(() => {
    const b = document.querySelector('#wb-box .wb-head button[title="تمام‌صفحه"]');
    if (b) b.click();
  });
  await sleep(800);
  const maximized = await A.evaluate(() => {
    const b = document.getElementById('wb-box');
    const ov = document.getElementById('max-overlay');
    return {
      parent: b && b.parentElement ? b.parentElement.id : '',
      cls: b ? b.classList.contains('maximized-el') : false,
      overlayBg: ov ? getComputedStyle(ov).backgroundColor : '',
      pageScroll: document.documentElement.scrollHeight - document.documentElement.clientHeight,
    };
  });
  check(19, 'the board maximizes into the overlay over a WHITE sheet',
    maximized.cls && maximized.parent === 'max-overlay' && maximized.overlayBg === 'rgb(255, 255, 255)', maximized);
  await A.screenshot({ path: path.join(OUT, 'wb-box-maximized.png') });
  await A.evaluate(() => window.bmExitMaximize());
  await sleep(900);
  const restored = await A.evaluate(() => {
    const b = document.getElementById('wb-box');
    return {
      inGrid: b ? (b.parentElement ? b.parentElement.id === 'video-grid' : false) : false,
      hiddenTiles: [...document.querySelectorAll('#video-grid > *')].filter((t) => t.style.display === 'none').length,
      pageScroll: document.documentElement.scrollHeight - document.documentElement.clientHeight,
    };
  });
  check(20, 'exiting puts the board back on the stage (nothing left hidden)',
    restored.inGrid && restored.hiddenTiles === 0 && restored.pageScroll <= 0, restored);

  // ---------- 21. clear, then close, for everybody ----------
  await A.click('#wb-btn-clear');
  const clearedU = await waitFn(U, () => {
    const c = document.getElementById('wb-canvas');
    if (!c) return false;
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    for (let i = 3; i < d.length; i += 16) if (d[i] > 12) return false;
    return true;
  }, null, 3000);
  check(21, 'the admin clear wipes the member canvas too', clearedU, { clearedU });

  await A.click('#btn-wb');
  const goneA = await waitFn(A, () => !document.getElementById('wb-box'), null, 4000);
  const goneU = await waitFn(U, () => !document.getElementById('wb-box'), null, 4000);
  check(22, 'closing removes the box for both members', goneA && goneU, { goneA, goneU });
  const after = await A.evaluate(() => ({
    tiles: document.querySelectorAll('#video-grid > *').length,
    hidden: [...document.querySelectorAll('#video-grid > *')].filter((t) => t.style.display === 'none').length,
    wbKey: (() => { const k = document.getElementById('btn-wb'); return k ? k.classList.contains('ctrl-live') : null; })(),
  }));
  check(23, 'every member tile is back and the key is no longer live',
    after.hidden === 0 && after.wbKey === false, after);

  // a phone pass: the box fits and nothing scrolls sideways
  await A.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await A.reload({ waitUntil: 'networkidle2' });
  await sleep(3500);
  await A.evaluate(() => window.bmWbToggle && window.bmWbToggle());
  await sleep(2500);
  const phoneView = await A.evaluate(() => {
    const b = document.getElementById('wb-box');
    return {
      box: !!b,
      scrollW: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      scrollY: document.documentElement.scrollHeight - document.documentElement.clientHeight,
    };
  });
  check(24, 'the board fits a phone without scrolling the page',
    phoneView.box === true && phoneView.scrollW <= 0 && phoneView.scrollY <= 0, phoneView);
  await A.screenshot({ path: path.join(OUT, 'wb-box-phone.png') });

  if (errors.length) console.log('\npage errors:\n' + errors.slice(0, 8).join('\n'));
  await browser.close();

  // ---------- cleanup ----------
  try {
    if (meetingId) {
      dbm.run('DELETE FROM messages WHERE meeting_id=?', [meetingId]);
      dbm.run('DELETE FROM emoji_events WHERE meeting_id=?', [meetingId]);
      dbm.run('DELETE FROM meeting_participants WHERE meeting_id=?', [meetingId]);
      dbm.run('DELETE FROM meetings WHERE id=?', [meetingId]);
    }
    if (userId) {
      dbm.run('DELETE FROM bm_sessions WHERE data LIKE ?', ['%' + userId + '%']);
      try { dbm.run('DELETE FROM user_passwords WHERE user_id=?', [userId]); } catch (e) {}
      try { dbm.run('DELETE FROM bm_avatars WHERE user_id=?', [userId]); } catch (e) {}
      dbm.run('DELETE FROM users WHERE id=?', [userId]);
    }
    dbm.run('DELETE FROM verification_codes WHERE identifier=?', [phone]);
    dbm.run('DELETE FROM signup_requests WHERE phone=?', [phone]);
    try {
      const { DatabaseSync } = require('node:sqlite');
      const arch = new DatabaseSync(path.join(ROOT, 'users_archive.db'));
      arch.prepare('DELETE FROM users WHERE phone=?').run(phone);
      arch.close();
    } catch (e) {}
    settings.setSetting('signup_mode', prevMode);
  } catch (e) {
    console.log('cleanup note: ' + e.message);
  }

  console.log('\nWB TEST: ' + pass + '/' + (pass + fail) + ' PASS' + (errors.length ? ' (page errors: ' + errors.length + ')' : ''));
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.log('ERROR ' + e.stack);
  try { settings.setSetting('signup_mode', 'approval'); } catch (err) {}
  process.exit(1);
});
