// ============================================================================
// server/AuthService.js — User & Admin Authentication (Supabase + Fallback)
// ============================================================================
// Handles:
//   - Email/password signup & login persisted in Supabase Auth + public.profiles
//     (with scrypt local JSON fallback if Supabase is unconfigured/unreachable)
//   - Google OAuth flow via Supabase GoTrue + session verification
//   - Admin portal authentication with signed HttpOnly session cookies
// ============================================================================

'use strict';

const crypto = require('crypto');
const config = require('./config');

const USER_COOKIE  = 'fa_session';
const ADMIN_COOKIE = 'fa_admin_session';

const USER_SESSION_MS  = 7 * 24 * 60 * 60 * 1000; // 7 days
const ADMIN_SESSION_MS = 12 * 60 * 60 * 1000;     // 12 hours

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

class AuthError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
  }
}

class AuthService {
  /**
   * @param {import('./Database')} database
   * @param {object} [opts]
   */
  constructor(database, opts = {}) {
    this.database       = database;
    this.supabaseUrl    = (opts.supabaseUrl !== undefined ? opts.supabaseUrl : config.SUPABASE_URL).replace(/\/+$/, '');
    this.serviceRoleKey = opts.serviceRoleKey !== undefined ? opts.serviceRoleKey : config.SUPABASE_SERVICE_ROLE_KEY;
    this.anonKey        = opts.anonKey !== undefined ? opts.anonKey : config.SUPABASE_ANON_KEY;
    this.adminUsername  = opts.adminUsername !== undefined ? opts.adminUsername : config.ADMIN_USERNAME;
    this.adminPassword  = opts.adminPassword !== undefined ? opts.adminPassword : config.ADMIN_PASSWORD;
    this.adminKey       = opts.adminKey !== undefined ? opts.adminKey : config.ADMIN_KEY;
    this.sessionSecret  = opts.sessionSecret !== undefined ? opts.sessionSecret : config.SESSION_SECRET;

    this._hmacSecret = this.sessionSecret || crypto
      .createHash('sha256')
      .update(`${this.serviceRoleKey || this.anonKey || 'flash-auction-dev'}:${this.adminPassword}`)
      .digest('hex');
  }

  get hasSupabase() {
    return Boolean(this.supabaseUrl && (this.serviceRoleKey || this.anonKey));
  }

  // ── Cookie & Token Utilities ──────────────────────────────────────────

  parseCookies(cookieHeader) {
    const out = {};
    if (!cookieHeader || typeof cookieHeader !== 'string') return out;
    for (const part of cookieHeader.split(';')) {
      const idx = part.indexOf('=');
      if (idx <= 0) continue;
      const key = part.slice(0, idx).trim();
      const raw = part.slice(idx + 1).trim();
      if (!key) continue;
      try {
        out[key] = decodeURIComponent(raw);
      } catch {
        out[key] = raw;
      }
    }
    return out;
  }

  buildCookie(name, value, { maxAgeSec, httpOnly = true, sameSite = 'Lax', path = '/' } = {}) {
    const parts = [
      `${name}=${encodeURIComponent(value)}`,
      `Path=${path}`,
      `SameSite=${sameSite}`,
    ];
    if (httpOnly) parts.push('HttpOnly');
    if (typeof maxAgeSec === 'number') parts.push(`Max-Age=${Math.max(0, Math.floor(maxAgeSec))}`);
    return parts.join('; ');
  }

  clearCookie(name) {
    return this.buildCookie(name, '', { maxAgeSec: 0, httpOnly: true, sameSite: 'Lax', path: '/' });
  }

  signToken(payload) {
    const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const sig  = crypto.createHmac('sha256', this._hmacSecret).update(body).digest('base64url');
    return `${body}.${sig}`;
  }

  verifyToken(token, expectedRole) {
    if (!token || typeof token !== 'string') return null;
    const dotIdx = token.indexOf('.');
    if (dotIdx <= 0) return null;

    const body = token.slice(0, dotIdx);
    const sig  = token.slice(dotIdx + 1);
    if (!body || !sig) return null;

    const expectedSig = crypto.createHmac('sha256', this._hmacSecret).update(body).digest('base64url');
    if (!this._safeEqual(sig, expectedSig)) return null;

    try {
      const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      if (!payload || typeof payload !== 'object') return null;
      if (typeof payload.exp !== 'number' || payload.exp <= Date.now()) return null;
      if (expectedRole && payload.role !== expectedRole) return null;
      return payload;
    } catch {
      return null;
    }
  }

  getUserSessionFromReq(req) {
    const token = this._extractToken(req, USER_COOKIE);
    return this.verifyToken(token, 'bidder');
  }

  getAdminSessionFromReq(req) {
    const token = this._extractToken(req, ADMIN_COOKIE);
    const session = this.verifyToken(token, 'admin');
    if (session) return session;

    // Backward-compatible x-admin-key support when ADMIN_KEY is configured
    const headerKey = req.headers?.['x-admin-key'];
    if (this.adminKey && typeof headerKey === 'string' && this._safeEqual(headerKey, this.adminKey)) {
      return { role: 'admin', username: this.adminUsername, via: 'admin-key' };
    }
    return null;
  }

  // ── User Signup / Login / Google OAuth ────────────────────────────────

  async signup({ fullName, email, password }) {
    const cleanName  = typeof fullName === 'string' ? fullName.trim() : '';
    const cleanEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
    const rawPass    = typeof password === 'string' ? password : '';

    if (cleanName.length < 2 || cleanName.length > 50) {
      throw new AuthError(400, 'Full name must be between 2 and 50 characters.');
    }
    if (!EMAIL_REGEX.test(cleanEmail)) {
      throw new AuthError(400, 'Please enter a valid email address.');
    }
    if (rawPass.length < 6 || rawPass.length > 128) {
      throw new AuthError(400, 'Password must be between 6 and 128 characters.');
    }

    if (this.hasSupabase && this.database?.mode === 'supabase') {
      try {
        const user = await this._supabaseSignup(cleanName, cleanEmail, rawPass);
        await this.database.upsertUserProfile(user);
        const token = this._createUserToken(user);
        return { user, token, storage: 'supabase' };
      } catch (err) {
        if (err instanceof AuthError) throw err;
        if (this.database?.mode !== 'local') {
          throw new AuthError(502, `Authentication service unavailable: ${err.message}`);
        }
      }
    }

    // Local scrypt fallback
    if (this.database.findLocalUserByEmail(cleanEmail)) {
      throw new AuthError(409, 'An account with this email already exists. Please sign in.');
    }

    const { salt, hash } = this._hashPassword(rawPass);
    const userId = crypto.randomUUID();
    const nowIso = new Date().toISOString();

    await this.database.saveLocalUser({
      id:           userId,
      email:        cleanEmail,
      fullName:     cleanName,
      passwordHash: hash,
      passwordSalt: salt,
      avatarUrl:    '',
      provider:     'email',
      role:         'bidder',
      createdAt:    nowIso,
      lastLoginAt:  nowIso,
    });

    const user = {
      id:        userId,
      email:     cleanEmail,
      fullName:  cleanName,
      avatarUrl: '',
      provider:  'email',
      role:      'bidder',
    };
    const token = this._createUserToken(user);
    return { user, token, storage: 'local' };
  }

  async login({ email, password }) {
    const cleanEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
    const rawPass    = typeof password === 'string' ? password : '';

    if (!EMAIL_REGEX.test(cleanEmail) || !rawPass) {
      throw new AuthError(400, 'Email and password are required.');
    }

    if (this.hasSupabase && this.database?.mode === 'supabase') {
      try {
        const user = await this._supabasePasswordLogin(cleanEmail, rawPass);
        await this.database.upsertUserProfile(user);
        const token = this._createUserToken(user);
        return { user, token, storage: 'supabase' };
      } catch (err) {
        if (err instanceof AuthError) throw err;
        if (this.database?.mode !== 'local') {
          throw new AuthError(502, `Authentication service unavailable: ${err.message}`);
        }
      }
    }

    // Local scrypt fallback
    const localUser = this.database.findLocalUserByEmail(cleanEmail);
    if (!localUser || !localUser.passwordHash || !localUser.passwordSalt) {
      throw new AuthError(401, 'Invalid email or password.');
    }

    if (!this._verifyPassword(rawPass, localUser.passwordSalt, localUser.passwordHash)) {
      throw new AuthError(401, 'Invalid email or password.');
    }

    await this.database.updateLocalUserLogin(localUser.id);

    const user = {
      id:        localUser.id,
      email:     localUser.email,
      fullName:  localUser.fullName,
      avatarUrl: localUser.avatarUrl || '',
      provider:  localUser.provider || 'email',
      role:      localUser.role || 'bidder',
    };
    const token = this._createUserToken(user);
    return { user, token, storage: 'local' };
  }

  async getGoogleAuthInfo(origin) {
    if (!this.hasSupabase) {
      return {
        configured:    false,
        googleEnabled: false,
        authorizeUrl:  null,
        setupHint:     'Configure SUPABASE_URL and SUPABASE_ANON_KEY in .env to enable Google login.',
      };
    }

    const redirectTo   = `${origin.replace(/\/+$/, '')}/login`;
    const authorizeUrl = `${this.supabaseUrl}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(redirectTo)}`;
    const apiKey       = this.anonKey || this.serviceRoleKey;

    let googleEnabled = false;
    try {
      const res = await fetch(`${this.supabaseUrl}/auth/v1/settings`, {
        headers: { apikey: apiKey },
        signal:  AbortSignal.timeout(4000),
      });
      if (res.ok) {
        const settings = await res.json();
        googleEnabled = settings?.external?.google === true;
      }
    } catch {
      googleEnabled = false;
    }

    return {
      configured: true,
      googleEnabled,
      authorizeUrl,
      setupHint: googleEnabled
        ? null
        : `Enable Google provider in Supabase Dashboard → Authentication → Providers → Google, and add ${redirectTo} to Redirect URLs.`,
    };
  }

  async completeOAuthSession({ accessToken }) {
    if (!accessToken || typeof accessToken !== 'string') {
      throw new AuthError(400, 'Missing OAuth access token.');
    }
    if (!this.hasSupabase) {
      throw new AuthError(503, 'Supabase is not configured for OAuth sign-in.');
    }

    const apiKey = this.anonKey || this.serviceRoleKey;
    const res = await fetch(`${this.supabaseUrl}/auth/v1/user`, {
      headers: {
        apikey:        apiKey,
        Authorization: `Bearer ${accessToken}`,
      },
      signal: AbortSignal.timeout(6000),
    });

    if (!res.ok) {
      throw new AuthError(401, 'Google sign-in token is invalid or expired.');
    }

    const sbUser = await res.json();
    if (!sbUser || !sbUser.id || !sbUser.email) {
      throw new AuthError(401, 'Unable to read verified Google user profile from Supabase.');
    }

    const meta = sbUser.user_metadata || {};
    const user = {
      id:        sbUser.id,
      email:     String(sbUser.email).toLowerCase(),
      fullName:  String(meta.full_name || meta.name || sbUser.email.split('@')[0]).trim(),
      avatarUrl: meta.avatar_url || meta.picture || '',
      provider:  'google',
      role:      'bidder',
    };

    await this.database.upsertUserProfile(user);
    const token = this._createUserToken(user);
    return { user, token, storage: 'supabase' };
  }

  // ── Admin Login ───────────────────────────────────────────────────────

  loginAdmin({ username, password }) {
    const cleanUser = typeof username === 'string' ? username.trim() : '';
    const rawPass   = typeof password === 'string' ? password : '';

    if (!cleanUser || !rawPass) {
      throw new AuthError(400, 'Username and password are required.');
    }

    if (!this._safeEqual(cleanUser, this.adminUsername) || !this._safeEqual(rawPass, this.adminPassword)) {
      throw new AuthError(401, 'Invalid admin username or password.');
    }

    const token = this.signToken({
      role:     'admin',
      username: this.adminUsername,
      exp:      Date.now() + ADMIN_SESSION_MS,
    });

    return {
      admin: { username: this.adminUsername, role: 'admin' },
      token,
    };
  }

  // ── Supabase Auth Helpers ─────────────────────────────────────────────

  async _supabaseSignup(fullName, email, password) {
    if (this.serviceRoleKey) {
      const res = await fetch(`${this.supabaseUrl}/auth/v1/admin/users`, {
        method: 'POST',
        headers: {
          apikey:         this.serviceRoleKey,
          Authorization:  `Bearer ${this.serviceRoleKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email,
          password,
          email_confirm: true,
          user_metadata: { full_name: fullName, role: 'bidder' },
        }),
        signal: AbortSignal.timeout(8000),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = String(data.msg || data.message || data.error_description || data.error || 'Signup failed');
        if (res.status === 422 || /already|registered|exists/i.test(msg)) {
          throw new AuthError(409, 'An account with this email already exists. Please sign in.');
        }
        throw new AuthError(res.status >= 400 && res.status < 500 ? res.status : 400, msg);
      }

      const sbUser = data.user || data;
      return {
        id:        sbUser.id,
        email:     String(sbUser.email || email).toLowerCase(),
        fullName,
        avatarUrl: sbUser.user_metadata?.avatar_url || '',
        provider:  'email',
        role:      'bidder',
      };
    }

    // Fallback when only anonKey is provided
    const res = await fetch(`${this.supabaseUrl}/auth/v1/signup`, {
      method: 'POST',
      headers: {
        apikey:         this.anonKey,
        Authorization:  `Bearer ${this.anonKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email,
        password,
        data: { full_name: fullName, role: 'bidder' },
      }),
      signal: AbortSignal.timeout(8000),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = String(data.msg || data.message || data.error_description || data.error || 'Signup failed');
      if (res.status === 422 || /already|registered|exists/i.test(msg)) {
        throw new AuthError(409, 'An account with this email already exists. Please sign in.');
      }
      throw new AuthError(res.status >= 400 && res.status < 500 ? res.status : 400, msg);
    }

    const sbUser = data.user || data;
    if (!sbUser.id) {
      throw new AuthError(400, 'Please check your email to confirm your account before signing in.');
    }
    return {
      id:        sbUser.id,
      email:     String(sbUser.email || email).toLowerCase(),
      fullName,
      avatarUrl: sbUser.user_metadata?.avatar_url || '',
      provider:  'email',
      role:      'bidder',
    };
  }

  async _supabasePasswordLogin(email, password) {
    const apiKey = this.anonKey || this.serviceRoleKey;
    const res = await fetch(`${this.supabaseUrl}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: {
        apikey:         apiKey,
        Authorization:  `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email, password }),
      signal: AbortSignal.timeout(8000),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const errText = String(data.error_description || data.msg || data.message || data.error || '');
      if (/not confirmed/i.test(errText)) {
        throw new AuthError(403, 'Email not confirmed. Please verify your email in your inbox or Supabase Dashboard.');
      }
      throw new AuthError(401, 'Invalid email or password.');
    }

    const sbUser = data.user || {};
    const meta   = sbUser.user_metadata || {};
    let fullName = String(meta.full_name || meta.name || '').trim();
    if (!fullName && sbUser.id) {
      const profile = await this.database.getUserProfile(sbUser.id);
      if (profile?.fullName) fullName = profile.fullName;
    }
    if (!fullName) fullName = (sbUser.email || email).split('@')[0];

    return {
      id:        sbUser.id,
      email:     String(sbUser.email || email).toLowerCase(),
      fullName,
      avatarUrl: meta.avatar_url || meta.picture || '',
      provider:  sbUser.app_metadata?.provider === 'google' ? 'google' : 'email',
      role:      meta.role === 'admin' ? 'admin' : 'bidder',
    };
  }

  // ── Private Helpers ───────────────────────────────────────────────────

  _createUserToken(user) {
    return this.signToken({
      sub:       user.id,
      email:     user.email,
      fullName:  user.fullName,
      avatarUrl: user.avatarUrl || '',
      provider:  user.provider || 'email',
      role:      'bidder',
      exp:       Date.now() + USER_SESSION_MS,
    });
  }

  _extractToken(req, cookieName) {
    const authHeader = req?.headers?.authorization;
    if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
      return authHeader.slice(7).trim();
    }
    const cookies = this.parseCookies(req?.headers?.cookie);
    return cookies[cookieName] || null;
  }

  _safeEqual(a, b) {
    const hashA = crypto.createHash('sha256').update(String(a || ''), 'utf8').digest();
    const hashB = crypto.createHash('sha256').update(String(b || ''), 'utf8').digest();
    return crypto.timingSafeEqual(hashA, hashB);
  }

  _hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(password, salt, 64).toString('hex');
    return { salt, hash };
  }

  _verifyPassword(password, salt, expectedHash) {
    try {
      const derived = crypto.scryptSync(password, salt, 64);
      const target  = Buffer.from(expectedHash, 'hex');
      if (derived.length !== target.length) return false;
      return crypto.timingSafeEqual(derived, target);
    } catch {
      return false;
    }
  }
}

AuthService.USER_COOKIE      = USER_COOKIE;
AuthService.ADMIN_COOKIE     = ADMIN_COOKIE;
AuthService.USER_SESSION_MS  = USER_SESSION_MS;
AuthService.ADMIN_SESSION_MS = ADMIN_SESSION_MS;
AuthService.AuthError        = AuthError;

module.exports = AuthService;
