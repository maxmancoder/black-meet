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

    const raw = inp.files[0];

    // A modern phone photo is 3-8 MB; sending it untouched is why the upload felt slow
    // (and sometimes looked stuck). Shrink it in the browser first — 512px square is
    // plenty for an avatar and turns an 8 MB upload into ~60 KB.
    function shrink(file) {
      return new Promise((resolve) => {
        if (!/^image\//.test(file.type) || file.size < 400 * 1024) return resolve(file);
        if (typeof createImageBitmap !== 'function') return resolve(file);
        const url = URL.createObjectURL(file);
        const img = new Image();
        let settled = false;
        const done = (out) => {
          if (settled) return;
          settled = true;
          URL.revokeObjectURL(url);
          resolve(out || file);
        };
        // never let a broken/unsupported image block the upload
        setTimeout(() => done(file), 8000);
        img.onload = () => {
          try {
            const max = 512;
            const scale = Math.min(1, max / Math.max(img.width, img.height));
            const w = Math.max(1, Math.round(img.width * scale));
            const h = Math.max(1, Math.round(img.height * scale));
            const c = document.createElement('canvas');
            c.width = w; c.height = h;
            const ctx = c.getContext('2d');
            if (!ctx) return done(file);
            ctx.drawImage(img, 0, 0, w, h);
            const type = (file.type === 'image/png') ? 'image/png' : 'image/jpeg';
            c.toBlob((blob) => {
              if (!blob || blob.size >= file.size) return done(file);
              done(new File([blob], file.name.replace(/\.[^.]+$/, '') + (type === 'image/png' ? '.png' : '.jpg'), { type }));
            }, type, 0.86);
          } catch (e) { done(file); }
        };
        img.onerror = () => done(file);
        img.src = url;
      });
    }

    let failed = false;
    const fail = (msg) => {
      if (failed) return;
      failed = true;
      if (modal) modal.classList.add('hidden');
      showToast(msg);
      inp.value = '';
    };

    shrink(raw).then((file) => {
      if (failed) return;
      const fd = new FormData();
      fd.append('csrf', csrf);
      fd.append('avatar', file);

      const xhr = new XMLHttpRequest();
      xhr.open('POST', 'api/profile/avatar');
      xhr.timeout = 60000;           // no more "stuck at 1%" forever
      xhr.upload.onprogress = function (e) {
        if (e.lengthComputable) setPct(Math.min(99, Math.round((e.loaded / e.total) * 100)));
      };
      xhr.onload = function () {
        let d = null;
        try { d = JSON.parse(xhr.responseText); } catch (e) { return fail('پاسخ سرور قابل خواندن نبود'); }
        if (xhr.status >= 200 && xhr.status < 300 && d && d.ok) {
          setPct(100);
          failed = true;
          if (modal) modal.classList.add('hidden');
          setTimeout(() => location.reload(), 350);
        } else {
          fail((d && d.msg) || 'آپلود ناموفق');
        }
      };
      xhr.onerror = () => fail('خطای شبکه هنگام آپلود');
      xhr.ontimeout = () => fail('آپلود بیش از حد طول کشید؛ دوباره تلاش کنید');
      xhr.onabort = () => fail('آپلود لغو شد');
      try { xhr.send(fd); } catch (e) { fail('ارسال فایل ممکن نبود'); }
    });
  };
})();
