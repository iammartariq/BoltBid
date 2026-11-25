// ============================================================================
// client/login.js — Bidder Login, Signup & Google OAuth Controller
// ============================================================================

'use strict';

(function () {
  const $ = (sel) => document.querySelector(sel);

  const dom = {
    heading:       $('#auth-heading'),
    subheading:    $('#auth-subheading'),
    tabLogin:      $('#tab-login'),
    tabSignup:     $('#tab-signup'),
    alertBox:      $('#auth-alert'),
    loginForm:     $('#login-form'),
    signupForm:    $('#signup-form'),
    loginEmail:    $('#login-email'),
    loginPass:     $('#login-password'),
    loginBtn:      $('#login-submit-btn'),
    signupName:    $('#signup-name'),
    signupEmail:   $('#signup-email'),
    signupPass:    $('#signup-password'),
    signupConfirm: $('#signup-confirm'),
    signupBtn:     $('#signup-submit-btn'),
    googleBtn:     $('#google-auth-btn'),
  };

  function showAlert(message, type = 'error') {
    dom.alertBox.textContent = message;
    dom.alertBox.className = `auth-alert ${type}`;
    dom.alertBox.hidden = false;
  }

  function clearAlert() {
    dom.alertBox.hidden = true;
    dom.alertBox.textContent = '';
  }

  function setMode(mode) {
    clearAlert();
    const isSignup = mode === 'signup';
    dom.tabLogin.classList.toggle('active', !isSignup);
    dom.tabSignup.classList.toggle('active', isSignup);
    dom.tabLogin.setAttribute('aria-selected', String(!isSignup));
    dom.tabSignup.setAttribute('aria-selected', String(isSignup));

    dom.loginForm.hidden  = isSignup;
    dom.signupForm.hidden = !isSignup;

    dom.heading.textContent    = isSignup ? 'Create Your Account' : 'Welcome Back';
    dom.subheading.textContent = isSignup
      ? 'Register once to compete in live real-time auctions'
      : 'Sign in to join live auctions and place atomic bids';
  }

  function setupPasswordToggles() {
    document.querySelectorAll('[data-toggle-target]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const input = document.getElementById(btn.dataset.toggleTarget);
        if (!input) return;
        const showing = input.type === 'text';
        input.type = showing ? 'password' : 'text';
        btn.textContent = showing ? 'Show' : 'Hide';
      });
    });
  }

  async function handleOAuthCallback() {
    const hashParams  = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    const queryParams = new URLSearchParams(window.location.search);

    const oauthError = hashParams.get('error_description')
      || hashParams.get('error')
      || queryParams.get('error_description')
      || queryParams.get('error');

    if (oauthError) {
      showAlert(`Google sign-in failed: ${oauthError}`, 'error');
      history.replaceState(null, '', window.location.pathname);
      return true;
    }

    const accessToken = hashParams.get('access_token');
    if (!accessToken) return false;

    showAlert('Completing Google sign-in...', 'info');
    dom.googleBtn.disabled = true;

    try {
      const res = await fetch('/api/auth/oauth-session', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ accessToken }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || 'Could not verify Google session');
      }
      history.replaceState(null, '', window.location.pathname);
      window.location.replace('/');
    } catch (err) {
      showAlert(err.message, 'error');
      dom.googleBtn.disabled = false;
      history.replaceState(null, '', window.location.pathname);
    }
    return true;
  }

  async function redirectIfAuthenticated() {
    try {
      const res = await fetch('/api/auth/me', { cache: 'no-store' });
      if (res.ok) {
        window.location.replace('/');
      }
    } catch {
      // Ignore network errors on pre-check
    }
  }

  async function handleLogin(e) {
    e.preventDefault();
    clearAlert();

    const email    = dom.loginEmail.value.trim();
    const password = dom.loginPass.value;
    if (!email || !password) {
      return showAlert('Please enter both your email and password.');
    }

    dom.loginBtn.disabled = true;
    dom.loginBtn.textContent = 'Signing in...';

    try {
      const res = await fetch('/api/auth/login', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ email, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Sign in failed.');
      window.location.replace('/');
    } catch (err) {
      showAlert(err.message, 'error');
      dom.loginBtn.disabled = false;
      dom.loginBtn.textContent = 'Sign In ⚡';
    }
  }

  async function handleSignup(e) {
    e.preventDefault();
    clearAlert();

    const fullName = dom.signupName.value.trim();
    const email    = dom.signupEmail.value.trim();
    const password = dom.signupPass.value;
    const confirm  = dom.signupConfirm.value;

    if (fullName.length < 2) {
      return showAlert('Please enter your full name (at least 2 characters).');
    }
    if (!email) {
      return showAlert('Please enter a valid email address.');
    }
    if (password.length < 6) {
      return showAlert('Password must be at least 6 characters.');
    }
    if (password !== confirm) {
      return showAlert('Passwords do not match.');
    }

    dom.signupBtn.disabled = true;
    dom.signupBtn.textContent = 'Creating account...';

    try {
      const res = await fetch('/api/auth/signup', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ fullName, email, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Account creation failed.');
      window.location.replace('/');
    } catch (err) {
      showAlert(err.message, 'error');
      dom.signupBtn.disabled = false;
      dom.signupBtn.textContent = 'Create Account ⚡';
    }
  }

  async function handleGoogleLogin() {
    clearAlert();
    dom.googleBtn.disabled = true;

    try {
      const res  = await fetch('/api/auth/google-url', { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));

      if (data.googleEnabled && data.authorizeUrl) {
        window.location.href = data.authorizeUrl;
        return;
      }

      showAlert(
        data.setupHint || 'Google OAuth is not enabled yet on this Supabase project.',
        'info'
      );
    } catch (err) {
      showAlert(err.message || 'Unable to start Google sign-in.', 'error');
    } finally {
      dom.googleBtn.disabled = false;
    }
  }

  document.addEventListener('DOMContentLoaded', async () => {
    setupPasswordToggles();

    const params = new URLSearchParams(window.location.search);
    if (window.location.pathname === '/signup' || params.get('mode') === 'signup') {
      setMode('signup');
    }

    dom.tabLogin.addEventListener('click', () => setMode('login'));
    dom.tabSignup.addEventListener('click', () => setMode('signup'));
    dom.loginForm.addEventListener('submit', handleLogin);
    dom.signupForm.addEventListener('submit', handleSignup);
    dom.googleBtn.addEventListener('click', handleGoogleLogin);

    const handledOAuth = await handleOAuthCallback();
    if (!handledOAuth) {
      await redirectIfAuthenticated();
    }
  });
})();
