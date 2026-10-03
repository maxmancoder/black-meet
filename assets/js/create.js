// assets/js/create.js
(function () {
  const BASE = window.BASE;
  const csrf = window.CSRF;

  function showToast(msg) {
    const t = document.getElementById('toast');
    document.getElementById('toast-message').textContent = msg;
    t.classList.remove('hidden');
    setTimeout(() => t.classList.add('hidden'), 4000);
  }

  window.goBack = function () {
    if (window.history.length > 1) window.history.back();
    else location.href = BASE + '/home';
  };

  const mediaToggle = document.getElementById('default-media');
  function updateMediaHint() {
    const on = mediaToggle.checked;
    const icon = document.getElementById('media-icon');
    setBMIcon(icon, on ? 'record_voice_over' : 'mic_off', true);
    icon.classList.toggle('text-primary', on);
    icon.classList.toggle('text-on-surface-variant', !on);
    document.getElementById('media-title').textContent = on ? 'ورود با صدا و تصویر' : 'ورود بدون صدا و تصویر';
    document.getElementById('media-hint').textContent = on
      ? 'بعد از تایید ادمین، میکروفون و دوربین به‌صورت خودکار روشن می‌شوند'
      : 'میکروفون و دوربین خاموش وارد می‌شوید؛ ادمین می‌تواند برای شما روشن کند';
  }
  if (mediaToggle) mediaToggle.addEventListener('change', updateMediaHint);

  window.createMeeting = function () {
    const title = document.getElementById('meeting-title').value.trim();
    const btn = document.getElementById('create-btn');
    btn.disabled = true;
    fetch('api/meetings/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf, title, default_media: mediaToggle && mediaToggle.checked ? '1' : '0' })
    })
      .then(r => r.json())
      .then(d => {
        if (d.ok) {
          if (d.share_url) { try { localStorage.setItem('blackmeet_last_share', d.share_url); } catch (e) {} }
          location.href = d.redirect;
        }
        else { showToast(d.msg || 'خطا'); btn.disabled = false; }
      })
      .catch(() => { showToast('خطا در ارتباط'); btn.disabled = false; });
  };
})();
