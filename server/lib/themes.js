'use strict';
const fs = require('fs');
const path = require('path');

// Theme source of truth: CSS files in the design folder (دیزاین بلک میت).
// Each file may redefine any subset of the --bm-* palette variables that are
// declared in assets/css/styles.css (:root defaults).
const THEMES_DIR = path.join(__dirname, '..', '..', 'دیزاین بلک میت');

function listThemes() {
  try {
    return fs.readdirSync(THEMES_DIR)
      .filter((f) => f.toLowerCase().endsWith('.css'))
      .map((f) => f.replace(/\.css$/i, ''))
      .sort();
  } catch (e) {
    return [];
  }
}

function currentTheme(req) {
  const raw = req.headers.cookie || '';
  let want = '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === 'bm_theme') {
      want = decodeURIComponent(part.slice(i + 1).trim());
      break;
    }
  }
  const themes = listThemes();
  if (want && themes.indexOf(want) >= 0) return want;
  return themes[0] || null;
}

function readTheme(id) {
  if (!id) return '/* no theme available */';
  try {
    return fs.readFileSync(path.join(THEMES_DIR, id + '.css'), 'utf8');
  } catch (e) {
    return '/* theme read error */';
  }
}

module.exports = { THEMES_DIR, listThemes, currentTheme, readTheme };
