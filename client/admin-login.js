// ============================================================================
// client/admin-login.js — Admin Portal Login Controller
// ============================================================================

'use strict';

(function () {
  const $ = (sel) => document.querySelector(sel);

  const dom = {
    form:      $('#admin-login-form'),
    username:  $('#admin-username'),
    password:  $('#admin-password'),
    toggleBtn: $('#toggle-admin-pass'),
    submitBtn: $('#admin-submit-btn'),
    alertBox:  $('#admin-alert'),
  };

  function showError(message) {
    dom.alertBox.textContent = message;
    dom.alertBox.className = 'auth-alert error';
    dom.alertBox.hidden = false;
  }

  async function redirectIfAdminAuthenticated() {
    try {
      const res = await fetch('/api/admin/me', { cache: 'no-store' });
      if (res.ok) {
        window.location.replace('/admin');
      }
    } catch {
      // Ignore pre-check error
    }
  }

  document.addEventListener('DOMContentLoaded', async () => {
    await redirectIfAdminAuthenticated();

    dom.toggleBtn.addEventListener('click', () => {
      const showing = dom.password.type === 'text';
      dom.password.type = showing ? 'password' : 'text';
      dom.toggleBtn.textContent = showing ? 'Show' : 'Hide';
    });

    dom.form.addEventListener('submit', async (e) => {
      e.preventDefault();
      dom.alertBox.hidden = true;

      const username = dom.username.value.trim();
      const password = dom.password.value;

      if (!username || !password) {
        return showError('Please enter both admin username and password.');
      }

      dom.submitBtn.disabled = true;
      dom.submitBtn.textContent = 'Verifying...';

      try {
        const res = await fetch('/api/admin/login', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ username, password }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(data.error || 'Invalid admin username or password.');
        }
        window.location.replace('/admin');
      } catch (err) {
        showError(err.message);
        dom.submitBtn.disabled = false;
        dom.submitBtn.textContent = 'Access Admin Dashboard →';
      }
    });
  });
})();
