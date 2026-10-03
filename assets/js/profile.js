// assets/js/profile.js
(function () {
  const BASE = window.BASE;
  const csrf = window.CSRF;

  function showToast(msg) {
    const t = document.getElementById('toast');
    document.getElementById('toast-message').textContent = msg;
    t.classList.remove('hidden');
    setTimeout(() => t.classList.add('hidden'), 4000);
  }

  window.saveProfile = function () {
    const name = document.getElementById('display-name').value.trim();
    if (!name) return showToast('نام نمایشی الزامی است');
    fetch('api/profile/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf, display_name: name })
    })
      .then(r => r.json())
      .then(d => { if (d.ok) showToast('ذخیره شد'); else showToast(d.msg || 'خطا'); });
  };

  window.logout = function (e) {
    if (e) e.preventDefault();
    fetch('api/logout', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'csrf=' + encodeURIComponent(csrf) })
      .then(r => r.json())
      .then(d => { localStorage.removeItem('blackmeet_logged_in'); location.href = d.redirect || BASE + '/login'; });
  };

  window.uploadAvatar = function () {
    const inp = document.getElementById('avatar-input');
    if (!inp.files || !inp.files[0]) return;
    const modal = document.getElementById('av-progress');
    const bar = document.getElementById('av-prog-bar');
    const pct = document.getElementById('av-prog-pct');
    const fa = n => String(n).replace(/[0-9]/g, d => '۰۱۲۳۴۵۶۷۸۹'[d]);
    const setPct = (v) => {
      if (bar) bar.style.width = v + '%';
      if (pct) pct.textContent = fa(v) + '٪';
    };
    if (modal) modal.classList.remove('hidden');
    setPct(0);

    const fd = new FormData();
    fd.append('csrf', csrf);
    fd.append('avatar', inp.files[0]);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', 'api/profile/avatar');
    xhr.upload.onprogress = function (e) {
      if (e.lengthComputable) setPct(Math.min(99, Math.round(e.loaded / e.total * 100)));
    };
    const fail = (msg) => {
      if (modal) modal.classList.add('hidden');
      showToast(msg);
      inp.value = '';
    };
    xhr.onload = function () {
      let d = null;
      try { d = JSON.parse(xhr.responseText); } catch (e) {}
      if (xhr.status >= 200 && xhr.status < 300 && d && d.ok) {
        setPct(100);
        setTimeout(() => location.reload(), 350);
      } else {
        fail((d && d.msg) || 'آپلود ناموفق');
      }
    };
    xhr.onerror = () => fail('خطای شبکه هنگام آپلود');
    xhr.send(fd);
  };
})();
