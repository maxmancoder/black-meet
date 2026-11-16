// assets/js/linkify.js — render a chat message as safe HTML with real, clickable links.
//
// The owner asked that a link somebody sends in a chat must be a link (click → open), not
// plain text. Everything is escaped FIRST and only http(s)/www tokens become anchors, so a
// message can never inject markup (`<img onerror=…>`, `javascript:` …) into a bubble.
(function () {
  'use strict';

  var URL_RE = /(?:https?:\/\/|www\.)[^\s<>"'`]+/gi;
  // sentence punctuation / closing brackets that belong to the sentence, not to the URL
  var TRAIL_RE = /[.,;:!?…،؛»«"'\u2019\u201d)\]}\u200c]+$/;

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function hrefOf(raw) {
    var u = raw;
    if (/^www\./i.test(u)) u = 'https://' + u;
    if (!/^https?:\/\//i.test(u)) return '';
    try {
      var parsed = new URL(u);
      if (!parsed.hostname || parsed.hostname.indexOf('.') === -1) return '';
      return parsed.href;
    } catch (e) { return ''; }
  }

  /**
   * bmLinkify(text) → escaped HTML with <a class="bm-link" target="_blank"> around URLs.
   * bmLinkifyPlain(text) → same, but keeps the raw (escaped) text when no link is found.
   */
  window.bmLinkify = function (text) {
    var out = esc(text);
    return out.replace(URL_RE, function (m) {
      var trail = '';
      var t = m.match(TRAIL_RE);
      if (t && t[0]) { trail = t[0]; m = m.slice(0, m.length - trail.length); }
      if (!m) return esc(trail);
      var href = hrefOf(m);
      if (!href) return esc(m) + esc(trail);
      return '<a class="bm-link" href="' + esc(href) + '" target="_blank" rel="noopener noreferrer nofollow" dir="ltr">' +
        esc(m) + '</a>' + esc(trail);
    });
  };
})();
