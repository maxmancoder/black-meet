// assets/js/icons.js — SVG icon helpers backed by icons/sprite.svg
// bmIcon(name, cls, fill, extra)      -> html string
// setBMIcon(el, name, fill)           -> swap the <use> href of an icon element
(function () {
  var NS = 'http://www.w3.org/2000/svg';
  var SPRITE = window.BM_SPRITE || '/black-meet/icons/sprite.svg';

  function href(name, fill) {
    return SPRITE + '#ic-' + name + (fill ? '-fill' : '');
  }

  function bmIcon(name, cls, fill, extra) {
    return '<svg class="bm-ico' + (cls ? ' ' + cls : '') + '"' +
      (extra ? ' ' + extra : '') +
      ' aria-hidden="true" focusable="false"><use href="' + href(name, fill) + '"></use></svg>';
  }

  function setBMIcon(el, name, fill) {
    if (!el) return;
    var use = el.querySelector && el.querySelector('use');
    if (use) { use.setAttribute('href', href(name, fill)); return; }
    if (el.namespaceURI === NS) {
      use = document.createElementNS(NS, 'use');
      el.appendChild(use);
      use.setAttribute('href', href(name, fill));
      return;
    }
    el.innerHTML = bmIcon(name, '', fill);
  }

  window.bmIcon = bmIcon;
  window.setBMIcon = setBMIcon;
})();
