// assets/js/forgot_password.js
(function () {
  const BASE = window.BASE;
  let currentId = '';
  // one send at a time: hammering the send key / Enter must never queue duplicates
  let sending = false;

  function sendBtn() {
    return document.querySelector('.auth-inputrow .auth-send');
  }
  function setSending(on) {
    sending = on;
    const b = sendBtn();
    if (b) {
      b.disabled = on;
      b.classList.toggle('is-busy', on);
      b.setAttribute('aria-busy', on ? 'true' : 'false');
    }
  }

  function showToast(msg) {
    const t = document.getElementById('toast');
    document.getElementById('toast-message').textContent = msg;
    t.classList.remove('hidden');
    setTimeout(() => t.classList.add('hidden'), 4000);
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  window.openThread = function () {
    const id = document.getElementById('identifier').value.trim();
    if (!id) return showToast('شماره تلفن یا ایمیل را وارد کنید');
    currentId = id;
    fetch('api/messages/user?identifier=' + encodeURIComponent(id))
      .then(r => r.json())
      .then(d => {
        if (!d.ok) return showToast(d.msg || 'خطا');
        document.getElementById('identify-box').classList.add('hidden');
        document.getElementById('thread-box').classList.remove('hidden');
        render(d.messages || []);
      })
      .catch(() => showToast('خطای ارتباط'));
  };
  window.closeThread = function () {
    document.getElementById('thread-box').classList.add('hidden');
    document.getElementById('identify-box').classList.remove('hidden');
  };

  function render(messages) {
    const box = document.getElementById('pv-messages');
    box.innerHTML = '';
    if (!(messages || []).length) {
      const empty = document.createElement('p');
      empty.className = 'auth-thread-empty';
      empty.textContent = 'هنوز پیامی رد و بدل نشده است؛ اولین پیام را بنویسید.';
      box.appendChild(empty);
    }
    messages.forEach(m => {
      const el = document.createElement('div');
      el.className = 'auth-bubble-row ' + (m.from_manager ? 'is-them' : 'is-me');
      el.innerHTML = '<div class="auth-bubble">' + esc(m.body) + '</div>';
      box.appendChild(el);
    });
    box.scrollTop = box.scrollHeight;
    window._lastPvId = (messages || []).reduce((mx, m) => Math.max(mx, Number(m.id) || 0), 0);
  }

  // Live update: show manager replies without refresh
  function pollUserThread() {
    if (!currentId || document.getElementById('thread-box').classList.contains('hidden')) return;
    fetch('api/messages/user?identifier=' + encodeURIComponent(currentId))
      .then(r => r.json())
      .then(d => {
        if (!d.ok) return;
        const msgs = d.messages || [];
        const maxId = msgs.reduce((mx, m) => Math.max(mx, Number(m.id) || 0), 0);
        if (maxId > (window._lastPvId || 0)) render(msgs);
      })
      .catch(() => {});
  }
  setInterval(pollUserThread, 2000); // fallback; manager pushes are instant on his side
  document.addEventListener('visibilitychange', function () { if (!document.hidden) pollUserThread(); });
  window.addEventListener('focus', pollUserThread);

  window.sendPv = function () {
    if (sending) return;
    const inp = document.getElementById('pv-input');
    const body = inp.value.trim();
    if (!body || !currentId) return;
    setSending(true);
    fetch('api/messages/user', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf: window.CSRF, identifier: currentId, body })
    })
      .then(r => r.json())
      .then(d => {
        if (!d.ok) { showToast(d.msg || 'خطا'); return; }
        inp.value = '';
        return fetch('api/messages/user?identifier=' + encodeURIComponent(currentId)).then(r => r.json());
      })
      .then(d => { if (d && d.ok) render(d.messages || []); })
      .catch(() => showToast('خطای ارتباط'))
      .then(() => { setSending(false); });
  };

  window.closeHelp = function () { document.getElementById('help-modal').classList.add('hidden'); };
  document.getElementById('help-btn').addEventListener('click', () => document.getElementById('help-modal').classList.remove('hidden'));

  // Enter on identifier field triggers the same action as the confirm button
  const idInput = document.getElementById('identifier');
  if (idInput) {
    idInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        window.openThread();
      }
    });
  }

  // deep link: /forgot-password?id=<phone|email> — used by the "شروع چت با مدیر" button
  const qs = new URLSearchParams(location.search);
  const preId = (qs.get('id') || qs.get('identifier') || '').trim();
  if (preId) {
    document.getElementById('identifier').value = preId;
    openThread();
  }
})();

