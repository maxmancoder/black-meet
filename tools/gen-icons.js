#!/usr/bin/env node
// One-time icon builder: generates icons/sprite.svg from the bundled Material
// Symbols font (outline + FILL=1 variants). The hand-picked SVGs in icons/*.svg
// are used as the FILL variant for the names they map to (they are the classic
// filled Material glyphs).
//
// Needs dev-only deps (not saved to package.json):
//   npm i --no-save fontkit wawoff2
// Run:
//   node tools/gen-icons.js
'use strict';
const fs = require('fs');
const path = require('path');
const fk = require('fontkit');
const w2 = require('wawoff2');

const ROOT = path.join(__dirname, '..');
const FONT = path.join(ROOT, 'fonts', 'material-symbols.woff2');
const ICONS_DIR = path.join(ROOT, 'icons');
const OUT = path.join(ICONS_DIR, 'sprite.svg');

const ICONS = [
  'arrow_back', 'arrow_forward', 'badge', 'block', 'calendar_add_on', 'call_end',
  'campaign', 'check_circle', 'close', 'email', 'error', 'forum', 'fullscreen',
  'forward_10', 'fullscreen', 'fullscreen_exit', 'group',
  'group_off', 'groups', 'help', 'home', 'info', 'key', 'link', 'lock', 'login',
  'logout',   'mail', 'menu', 'mic', 'mic_off', 'more_vert', 'mood', 'movie',
  'network_check', 'notifications', 'person', 'replay_10', 'volume_down',
  'person_remove', 'phone', 'phone_iphone', 'record_voice_over', 'screen_share',
  'search', 'send', 'shield_person', 'switch_camera', 'tune', 'video_call', 'video_library',
  'videocam', 'videocam_off', 'volume_up',
];

// icons/<file> replaces the FILL=1 variant of <name>
const FILL_OVERRIDES = {
  home: 'home-icon.svg',
  mic: 'mic-icon.svg',
  mic_off: 'mic-off-icon.svg',
  mood: 'mood-icon.svg',
  call_end: 'call-end-icon.svg',
  screen_share: 'screen-share-icon.svg',
  videocam: 'video-call-icon.svg', // file name says "video-call", glyph is videocam
  videocam_off: 'videocam-off-icon.svg',
  mail: 'login-email-icon.svg',
  phone: 'login-phone-icon.svg',
  person: 'signup-icon.svg',
  check_circle: 'verify-icon.svg',
};

function symbol(id, viewBox, body) {
  return `<symbol id="${id}" viewBox="${viewBox}">${body}</symbol>`;
}

async function main() {
  const ttf = Buffer.from(await w2.decompress(fs.readFileSync(FONT)));
  const outline = fk.create(ttf);
  const filled = outline.getVariation({ FILL: 1, wght: 400 });
  const UPEM = outline.unitsPerEm; // 960
  const parts = [];
  const missing = [];

  for (const name of ICONS) {
    for (const [suffix, font] of [['', outline], ['-fill', filled]]) {
      const override = suffix === '-fill' && FILL_OVERRIDES[name];
      if (override) {
        const raw = fs.readFileSync(path.join(ICONS_DIR, override), 'utf8');
        const inner = raw.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>[\s\S]*$/, '').trim();
        const vb = (raw.match(/viewBox="([^"]+)"/) || [])[1] || '0 0 24 24';
        parts.push(symbol('ic-' + name + suffix, vb, inner));
        continue;
      }
      const glyphs = font.layout(name).glyphs;
      if (glyphs.length !== 1 || !glyphs[0] || !glyphs[0].path) {
        missing.push(name + suffix);
        continue;
      }
      const d = glyphs[0].path.toSVG();
      parts.push(symbol('ic-' + name + suffix, `0 0 ${UPEM} ${UPEM}`,
        `<path fill="currentColor" transform="translate(0,${UPEM}) scale(1,-1)" d="${d}"/>`));
    }
  }

  if (missing.length) {
    console.error('MISSING GLYPHS:', missing.join(', '));
    process.exitCode = 1;
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style="display:none">\n${parts.join('\n')}\n</svg>\n`;
  fs.writeFileSync(OUT, svg);
  console.log(`wrote ${path.relative(ROOT, OUT)} (${parts.length} symbols, ${(svg.length / 1024).toFixed(1)} KB)`);
}

main().catch((err) => { console.error(err); process.exit(1); });
