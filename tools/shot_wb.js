'use strict';
// End-to-end whiteboard test (step 8): two SEPARATE browser contexts (two accounts) in
// one meeting room, system Chrome, local server on :3100.
//   node shot_wb.js "<repo root>" [baseUrl]
// Requires: local server on BASE (default http://127.0.0.1:3100), DEV_MODE=true.
// Creates its own users via the signup API and removes every row it created at the end.
const path = require('path');
const ROOT = process.argv[2] || process.cwd();
const BASE = process.argv[3] || 'http://127.0.0.1:3100';
const MOUNT = BASE + '/black-meet';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const puppeteer = require(path.join(ROOT, 'node_modules', 'puppeteer-core'));
const dbm = require(path.join(ROOT, 'server', 'lib', 'db'));
const settings = require(path.join(ROOT, 'server', 'lib', 'settings'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;
const lines = [];
function check(n, desc, cond, reason) {
  if (cond) {
    pass++;
    lines.push('[PASS] ' + n + '. ' + desc);
    console.log('[PASS] ' + n + '. ' + desc);
  } else {
    fail++;
    lines.push('[FAIL] ' + n + '. ' + desc + ' — ' + (reason || 'failed'));
    console.log('[FAIL] ' + n + '. ' + desc + ' — ' + (reason || 'failed'));
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

const wbState = () => ({
  panel: (function () { const e = document.getElementById('content-wb'); return !!e && !e.classList.contains('hidden'); })(),
  toolbar: (function () { const e = document.getElementById('wb-toolbar'); return !!e && !e.classList.contains('hidden'); })(),
  adminPanel: (function () { const e = document.getElementById('wb-admin-panel'); return !!e && !e.classList.contains('hidden'); })(),
  badge: (function () { const e = document.getElementById('wb-viewer-badge'); return !!e && !e.classList.contains('hidden'); })(),
  pe: (function () { const e = document.getElementById('wb-canvas'); return e ? e.style.pointerEvents : null; })(),
});
const canvasHasPixels = () => {
  const c = document.getElementById('wb-canvas');
  if (!c || !c.width || !c.height) return false;
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  for (let i = 0; i < d.length; i++) if (d[i] !== 0) return true;
  return false;
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
      '--auto-select-desktop-capture-source=Entire screen',
      '--lang=fa',
    ],
  });

  const errors = { admin: [], user: [] };
  const ctxA = await browser.createBrowserContext();
  const ctxU = await browser.createBrowserContext();
  const A = await ctxA.newPage();
  const U = await ctxU.newPage();
  for (const [p, tag] of [[A, 'admin'], [U, 'user']]) {
    await p.setViewport({ width: 1440, height: 900 });
    p.on('pageerror', (e) => errors[tag].push('pageerror: ' + e.message));
    p.on('console', (m) => { if (m.type() === 'error') errors[tag].push('console: ' + m.text()); });
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
  check(1, 'admin logs in and lands on /home', !!(loginRes && loginRes.ok) && homeA.url.endsWith('/home') && homeA.dash, JSON.stringify({ loginRes, homeA }));

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
    !!(signupRes && signupRes.ok && signupRes.otp) && !!(verifyRes && verifyRes.ok) && homeU.url.endsWith('/home') && homeU.dash,
    JSON.stringify({ signupRes: signupRes && { ok: signupRes.ok, msg: signupRes.msg, hasOtp: !!signupRes.otp }, verifyRes, homeU }));

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
  check(3, 'admin creates a meeting and gets room_id', !!(created && created.ok && room && meetingId), JSON.stringify(created));

  // ---------- 4. both join the room ----------
  for (const p of [A, U]) {
    await p.goto(MOUNT + '/meeting?room=' + encodeURIComponent(room), { waitUntil: 'networkidle2', timeout: 90000 });
  }
  const inCallA = await waitFn(A, () => !!document.getElementById('video-grid') && !!document.getElementById('call-sidebar') && location.href.indexOf('/meeting') !== -1, null, 15000);
  const inCallU = await waitFn(U, () => !!document.getElementById('video-grid') && !!document.getElementById('call-sidebar') && location.href.indexOf('/meeting') !== -1, null, 15000);
  // the member is approved (open_join): no waiting overlay, and the roster has 2 people
  const joinedA = await waitFn(A, () => !!(window.bmCallRoster && window.bmCallRoster().length >= 2), null, 20000);
  const joinedU = await waitFn(U, () => !!(window.bmCallRoster && window.bmCallRoster().length >= 2), null, 20000);
  check(4, 'both users join the meeting room and see the call page', inCallA && inCallU && joinedA && joinedU,
    JSON.stringify({ inCallA, inCallU, joinedA, joinedU, urlA: A.url(), urlU: U.url() }));

  // ---------- 5-8. UI presence ----------
  const ui = async (p) => p.evaluate(() => {
    const tab = document.getElementById('tab-wb');
    const btn = document.getElementById('btn-wb');
    const panel = document.getElementById('content-wb');
    const cv = document.getElementById('wb-canvas');
    return {
      tab: !!tab && !!tab.parentElement && !!tab.parentElement.querySelector('#tab-members'),
      btn: !!btn,
      panelHidden: !!panel && panel.classList.contains('hidden'),
      canvas: !!cv,
      pe: cv ? cv.style.pointerEvents : null,
    };
  });
  const uiA = await ui(A);
  const uiU = await ui(U);
  check(5, '#tab-wb exists in the sidebar tab row for both users', uiA.tab && uiU.tab, JSON.stringify({ uiA, uiU }));
  check(6, '#btn-wb exists in the control bar for both users', uiA.btn && uiU.btn, JSON.stringify({ btnA: uiA.btn, btnU: uiU.btn }));
  check(7, '#content-wb starts hidden for both users', uiA.panelHidden && uiU.panelHidden, JSON.stringify({ a: uiA.panelHidden, u: uiU.panelHidden }));
  check(8, '#wb-canvas exists with pointer-events:none initially for both users',
    uiA.canvas && uiU.canvas && uiA.pe === 'none' && uiU.pe === 'none',
    JSON.stringify({ canvasA: uiA.canvas, peA: uiA.pe, canvasU: uiU.canvas, peU: uiU.pe }));

  // ---------- 9. admin opens: WB_STATE {open:true} really comes from the server ----------
  await A.evaluate(() => {
    window.__wbStates = [];
    if (window.BM_SOCKET) window.BM_SOCKET.on(window.BMEv.WB_STATE, (d) => window.__wbStates.push(d));
  });
  await A.click('#btn-wb');
  const gotOpenEvent = await waitFn(A, () => (window.__wbStates || []).some((d) => d && d.open === true), null, 4000);
  check(9, 'admin clicks #btn-wb and the server emits WB_STATE {open:true}', gotOpenEvent, 'no wb:state with open:true arrived');

  const winA_10 = await waitFn(A, () => !document.getElementById('content-wb').classList.contains('hidden'), null, 2000);
  check(10, "admin's #content-wb becomes visible within 2s", winA_10, JSON.stringify(await A.evaluate(wbState)));

  const winA_11 = await waitFn(A, () => !document.getElementById('wb-toolbar').classList.contains('hidden'), null, 2000);
  check(11, "admin's #wb-toolbar becomes visible within 2s", winA_11, JSON.stringify(await A.evaluate(wbState)));

  const winA_12 = await waitFn(A, () => !document.getElementById('wb-admin-panel').classList.contains('hidden'), null, 2000);
  check(12, "admin's #wb-admin-panel becomes visible within 2s", winA_12, JSON.stringify(await A.evaluate(wbState)));

  const winA_13 = await waitFn(A, () => document.getElementById('wb-canvas').style.pointerEvents === 'auto', null, 2000);
  check(13, "admin's #wb-canvas gets pointer-events:auto within 2s", winA_13, JSON.stringify(await A.evaluate(wbState)));

  // ---------- 14-16. the viewer follows (broadcast) ----------
  const winU_14 = await waitFn(U, () => !document.getElementById('content-wb').classList.contains('hidden'), null, 2000);
  check(14, "regular user's #content-wb also becomes visible within 2s", winU_14, JSON.stringify(await U.evaluate(wbState)));

  const winU_15 = await waitFn(U, () => document.getElementById('wb-canvas').style.pointerEvents === 'none', null, 2000);
  check(15, "regular user's #wb-canvas still has pointer-events:none (viewer only)", winU_15, JSON.stringify(await U.evaluate(wbState)));

  const winU_16 = await waitFn(U, () => !document.getElementById('wb-viewer-badge').classList.contains('hidden'), null, 2000);
  check(16, 'regular user sees #wb-viewer-badge («فقط مشاهده»)', winU_16, JSON.stringify(await U.evaluate(wbState)));

  // ---------- 17. admin draws ----------
  const drew = await A.evaluate(async () => {
    const c = document.getElementById('wb-canvas');
    if (!c || !c.width || !c.height) return { ok: false, reason: 'canvas has no size' };
    const r = c.getBoundingClientRect();
    const fire = (type, x, y) => c.dispatchEvent(new PointerEvent(type, {
      pointerId: 7, pointerType: 'mouse', isPrimary: true, bubbles: true, buttons: type === 'pointerup' ? 0 : 1,
      clientX: x, clientY: y,
    }));
    fire('pointerdown', r.left + r.width * 0.2, r.top + r.height * 0.25);
    for (let i = 1; i <= 15; i++) {
      fire('pointermove', r.left + r.width * (0.2 + i * 0.03), r.top + r.height * (0.25 + i * 0.03));
      await new Promise((res) => setTimeout(res, 12));
    }
    fire('pointerup', r.left + r.width * 0.65, r.top + r.height * 0.7);
    await new Promise((res) => setTimeout(res, 250));
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let painted = 0;
    for (let i = 0; i < d.length; i++) if (d[i] !== 0) painted++;
    return { ok: painted > 0, painted, size: [c.width, c.height] };
  });
  check(17, 'admin draws and the canvas pixels are not all zero', !!(drew && drew.ok), JSON.stringify(drew));

  // ---------- 18. the stroke reaches the viewer ----------
  const viewerPainted = await waitFn(U, canvasHasPixels, null, 2000);
  check(18, "regular user's canvas also gets non-zero pixels within 2s", viewerPainted,
    JSON.stringify(await U.evaluate(() => ({ pe: document.getElementById('wb-canvas').style.pointerEvents, size: [document.getElementById('wb-canvas').width, document.getElementById('wb-canvas').height] }))));

  // ---------- 19. clear wipes both ----------
  await A.click('#wb-btn-clear');
  const clearedA = await waitFn(A, () => { const c = document.getElementById('wb-canvas'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; for (let i = 0; i < d.length; i++) if (d[i] !== 0) return false; return true; }, null, 2000);
  const clearedU = await waitFn(U, () => { const c = document.getElementById('wb-canvas'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; for (let i = 0; i < d.length; i++) if (d[i] !== 0) return false; return true; }, null, 2000);
  check(19, 'admin clears and both canvases are blank within 2s', clearedA && clearedU, JSON.stringify({ clearedA, clearedU }));

  // ---------- 20. close hides the panel for both ----------
  await A.click('#btn-wb');
  const hidA = await waitFn(A, () => document.getElementById('content-wb').classList.contains('hidden'), null, 2000);
  const hidU = await waitFn(U, () => document.getElementById('content-wb').classList.contains('hidden'), null, 2000);
  check(20, 'admin closes and #content-wb is hidden again for both users', hidA && hidU, JSON.stringify({ hidA, hidU, stateA: await A.evaluate(wbState), stateU: await U.evaluate(wbState) }));

  const pageErrors = errors.admin.length + errors.user.length;
  if (pageErrors) console.log('\npage errors:\n' + errors.admin.concat(errors.user).slice(0, 8).join('\n'));

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
    dbm.run("DELETE FROM signup_requests WHERE phone=?", [phone]);
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

  console.log('\nWB TEST: ' + pass + '/20 PASS' + (pageErrors ? ' (page errors: ' + pageErrors + ')' : ''));
  if (fail) {
    console.log('\nfailures:');
    lines.filter((l) => l.startsWith('[FAIL]')).forEach((l) => console.log(l));
  }
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.log('ERROR ' + e.stack);
  try { settings.setSetting('signup_mode', process.env.__prevMode || 'approval'); } catch (err) {}
  process.exit(1);
});
