// assets/js/auth.js
(function () {
  const csrf = window.CSRF;
  let currentPhone = '';
  let currentPurpose = '';
  let lastOtp = '';
  let timerInterval = null;

  const VIEWS = ['view-login-options', 'view-login-email', 'view-login-phone', 'view-signup', 'view-signup-pending', 'view-otp'];
  let pendingPhone = '';

  window.switchView = function (id) {
    VIEWS.forEach(v => {
      const el = document.getElementById(v);
      el.classList.add('hidden');
      el.classList.remove('view');
    });
    const t = document.getElementById(id);
    t.classList.remove('hidden');
    // retrigger animation
    void t.offsetWidth;
    t.classList.add('view');
    if (id === 'view-otp') {
      window.__BMResetBtn && window.__BMResetBtn();
      const disp = document.getElementById('otp-display');
      if (lastOtp) {
        document.getElementById('otp-code').textContent = lastOtp;
        disp.classList.remove('hidden');
      }
      startTimer();
    }
  };

  function startTimer() {
    clearInterval(timerInterval);
    let t = 30;
    const span = document.getElementById('countdown');
    const txt = document.getElementById('timer-text');
    const fa = n => n.toString().replace(/\d/g, d => '۰۱۲۳۴۵۶۷۸۹'[d]);
    span.textContent = fa(t);
    timerInterval = setInterval(() => {
      t--;
      if (t <= 0) {
        clearInterval(timerInterval);
        txt.innerHTML = '<button class="text-primary hover:text-primary-fixed" onclick="resendOtp()">ارسال مجدد کد تأیید</button>';
        return;
      }
      span.textContent = fa(t);
    }, 1000);
  }

  window.resendOtp = function () {
    postJSON('api/login/resend', { csrf, phone: currentPhone, purpose: currentPurpose })
      .then(d => {
        if (d.ok) {
          lastOtp = d.otp || '';
          if (lastOtp) {
            document.getElementById('otp-code').textContent = lastOtp;
            document.getElementById('otp-display').classList.remove('hidden');
          }
          startTimer();
          showToast('کد جدید ارسال شد', 3000);
        } else showToast(d.msg || 'خطا');
      });
  };

  function postJSON(url, data) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(data)
    }).then(r => r.json());
  }

  function showToast(msg, dur = 10000) {
    const toast = document.getElementById('toast');
    document.getElementById('toast-message').textContent = msg;
    toast.classList.remove('translate-y-20', 'opacity-0');
    toast.classList.add('show');
    setTimeout(() => {
      toast.classList.add('translate-y-20', 'opacity-0');
      toast.classList.remove('show');
    }, dur);
  }
  window.showToast = showToast;

  function persistSession() {
    localStorage.setItem('blackmeet_logged_in', '1');
  }

  window.loginPhone = function () {
    const phone = document.getElementById('lp-phone').value.trim();
    if (!phone) return showToast('شماره تلفن را وارد کنید');
    postJSON('api/login/phone', { csrf, phone })
      .then(d => {
        if (d.ok) {
          currentPhone = d.phone; currentPurpose = d.purpose; lastOtp = d.otp;
          switchView('view-otp');
        } else showToast(d.msg || 'خطا');
      });
  };

  window.signup = function () {
    const data = {
      csrf,
      full_name: document.getElementById('su-name').value.trim(),
      username: document.getElementById('su-user').value.trim(),
      email: document.getElementById('su-email').value.trim(),
      phone: document.getElementById('su-phone').value.trim(),
      password: document.getElementById('su-pass').value
    };
    if (!data.full_name || !data.username || !data.email || !data.phone || !data.password)
      return showToast('تمام فیلدها را پر کنید');
    postJSON('api/signup', data)
      .then(d => {
        if (d.ok && d.pending) {
          // admin approval mode: no account yet, show the notice + chat button
          pendingPhone = d.phone || data.phone;
          document.getElementById('su-pending-msg').textContent = d.msg || '';
          switchView('view-signup-pending');
          return;
        }
        if (d.ok) {
          currentPhone = d.phone; currentPurpose = d.purpose; lastOtp = d.otp || '';
          switchView('view-otp');
        } else showToast(d.msg || 'خطا'); // closed mode shows its message for 10s
      });
  };

  window.openPendingChat = function () {
    location.href = window.BASE + '/forgot-password?id=' + encodeURIComponent(pendingPhone);
  };

  window.verifyOtp = function () {
    const cells = otpCells();
    let code = '';
    if (cells.length) code = cells.map((c) => c.value.trim()).join('');
    else code = document.getElementById('otp-input').value.trim();
    if (!code) return showToast('کد تأیید را وارد کنید');
    if (code.length < 6) return showToast('کد ۶ رقمی را کامل وارد کنید');
    postJSON('api/login/verify', { csrf, phone: currentPhone, code, purpose: currentPurpose })
      .then(d => {
        if (d.ok) { celebrateOtp(d.redirect); }
        else { flashOtpError(); showToast(d.msg || 'خطا'); }
      });
  };

  // success: green sweep + check mark, then we enter the app (never a bare jump)
  function celebrateOtp(redirect) {
    const box = document.getElementById('otp-boxes');
    if (box) {
      box.classList.add('otp-success');
      otpCells().forEach((c, i) => {
        setTimeout(() => c.classList.add('otp-ok'), 60 * i);
      });
      const mark = document.createElement('div');
      mark.className = 'otp-mark';
      mark.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12.5l5 5L20 6.5"/></svg>';
      box.appendChild(mark);
    }
    persistSession();
    setTimeout(() => { location.href = redirect; }, 1100);
  }

  // ---------- segmented OTP input (CuteOtp style) ----------
  function otpCells() {
    return Array.from(document.querySelectorAll('#otp-boxes .otp-cell'));
  }
  function otpValue() {
    return otpCells().map((c) => c.value.trim()).join('');
  }
  function otpSubmit() {
    const v = otpValue();
    if (v.length === 6) window.verifyOtp();
  }
  function flashOtpError() {
    otpCells().forEach((c) => {
      c.classList.add('otp-error');
      setTimeout(() => c.classList.remove('otp-error'), 450);
      c.value = '';
    });
    const f = otpCells()[0];
    if (f) f.focus();
  }
  function setupOtpBoxes() {
    const cells = otpCells();
    if (!cells.length) return;
    cells.forEach((cell, i) => {
      cell.addEventListener('input', () => {
        cell.value = cell.value.replace(/\D/g, '').slice(0, 1);
        cell.classList.remove('otp-error');
        if (cell.value && i < cells.length - 1) cells[i + 1].focus();
        otpSubmit();
      });
      cell.addEventListener('keydown', (e) => {
        if (e.key === 'Backspace' && !cell.value && i > 0) {
          e.preventDefault();
          cells[i - 1].value = '';
          cells[i - 1].focus();
        } else if (e.key === 'ArrowLeft' && i < cells.length - 1) {
          e.preventDefault();
          cells[i + 1].focus();
        } else if (e.key === 'ArrowRight' && i > 0) {
          e.preventDefault();
          cells[i - 1].focus();
        } else if (e.key === 'Enter') {
          e.preventDefault();
          window.verifyOtp();
        }
      });
      cell.addEventListener('focus', () => cell.select());
      cell.addEventListener('paste', (e) => {
        e.preventDefault();
        const txt = (e.clipboardData || window.clipboardData).getData('text').replace(/\D/g, '').slice(0, 6);
        cells.forEach((c, k) => { c.value = txt[k] || ''; });
        const next = cells[Math.min(txt.length, cells.length - 1)];
        if (next) next.focus();
        otpSubmit();
      });
    });
    const first = cells[0];
    if (first) setTimeout(() => first.focus(), 80);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setupOtpBoxes);
  else setupOtpBoxes();

  window.loginEmail = function () {
    const email = document.getElementById('le-email').value.trim();
    const password = document.getElementById('le-pass').value;
    if (!email || !password) return showToast('ایمیل و رمز عبور را وارد کنید');
    postJSON('api/login/email', { csrf, email, password })
      .then(d => {
        if (d.ok) { persistSession(); location.href = d.redirect; }
        else showToast(d.msg || 'خطا');
      });
  };
})();
