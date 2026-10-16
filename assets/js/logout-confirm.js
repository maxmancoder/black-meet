// logout-confirm.js — one logout for the whole app, behind a themed confirm dialog.
// Loaded from head.ejs so every page that has an خروج key behaves the same way; it
// must be the ONLY definition of window.logout (home.js / profile.js used to have
// their own copy that fired immediately with no question asked).
(function () {
  var BASE = window.BASE || '/black-meet';

  function ensureModal() {
    var el = document.getElementById('logout-modal');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'logout-modal';
    el.className = 'hidden fixed inset-0 z-[120] flex items-center justify-center p-4';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.innerHTML =
      '<div class="bm-modal-backdrop"></div>' +
      '<div class="relative glass-panel rounded-2xl shadow-2xl w-full max-w-[340px] p-6 text-center">' +
        '<div class="bm-modal-icon mx-auto mb-3">' + (window.bmIcon ? bmIcon('logout', 'text-[26px]', true) : '') + '</div>' +
        '<h2 class="font-headline-md text-headline-md text-on-surface mb-1">از خروج خود اطمینان دارید؟</h2>' +
        '<p class="font-body-sm text-body-sm text-on-surface-variant mb-5">برای ورود دوباره باید نام کاربری و رمز عبور را وارد کنید.</p>' +
        '<div class="flex items-center gap-3">' +
          '<button type="button" id="logout-no" class="flex-1 bg-surface-container-high text-on-surface rounded-xl py-3 font-label-md hover:opacity-80 transition-opacity">خیر</button>' +
          '<button type="button" id="logout-yes" class="flex-1 bg-primary text-white rounded-xl py-3 font-label-md hover:bg-primary-fixed transition-colors">بله</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(el);
    el.querySelector('.bm-modal-backdrop').addEventListener('click', close);
    el.querySelector('#logout-no').addEventListener('click', close);
    el.querySelector('#logout-yes').addEventListener('click', function () {
      close();
      doLogout();
    });
    return el;
  }

  function close() {
    var el = document.getElementById('logout-modal');
    if (el) el.classList.add('hidden');
  }

  function doLogout() {
    fetch(BASE + '/api/logout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'csrf=' + encodeURIComponent(window.CSRF || '')
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        try { localStorage.removeItem('blackmeet_logged_in'); } catch (e) {}
        location.href = (d && d.redirect) || BASE + '/login';
      })
      .catch(function () { location.href = BASE + '/login'; });
  }

  window.logout = function (e) {
    if (e) e.preventDefault();
    var el = ensureModal();
    el.classList.remove('hidden');
  };
  window.bmCloseLogoutModal = close;
})();