const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { authenticator } = require('otplib');
const { getDb } = require('../db');
const { getAuthCodeUrl, exchangeCode, decodeState } = require('../msalHelper');

const PENDING_TTL_MS = 5 * 60 * 1000; // 5 minutes for 2FA window

const router = express.Router();

// ── Login page ─────────────────────────────────────────────────────────────

router.get('/auth/login', (req, res) => {
  const tenants = (() => {
    try { return getDb().prepare('SELECT id, name FROM sso_tenants WHERE enabled = 1 AND sso_enabled = 1').all(); } catch { return []; }
  })();
  res.render('login', { layout: false, error: null, tenants });
});

// ── Local admin login ───────────────────────────────────────────────────────

router.post('/auth/local', async (req, res) => {
  const { username, password } = req.body;
  const tenants = (() => {
    try { return getDb().prepare('SELECT id, name FROM sso_tenants WHERE enabled = 1 AND sso_enabled = 1').all(); } catch { return []; }
  })();
  const fail = (msg) => res.render('login', { layout: false, error: msg, tenants });

  if (!username || !password) return fail('Username and password are required.');

  try {
    const db = getDb();
    const user = db.prepare('SELECT * FROM local_users WHERE username = ?').get(username.trim());
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return fail('Invalid username or password.');
    }

    const rememberMe = req.body.rememberMe === '1';

    if (user.totp_enabled) {
      // Password OK but 2FA required — store a short-lived pending state
      req.session.pending2fa = {
        userId: user.id,
        username: user.username,
        returnTo: req.session.returnTo || '/',
        expiresAt: Date.now() + PENDING_TTL_MS,
        rememberMe,
      };
      return res.redirect('/auth/2fa');
    }

    // No 2FA — establish full session immediately
    req.session.regenerate((err) => {
      if (err) return fail('Session error.');
      req.session.userId = user.id;
      req.session.userType = 'local';
      req.session.user = { name: user.username, email: null, role: user.role || 'local_admin' };
      if (rememberMe) req.session.cookie.maxAge = 30 * 24 * 60 * 60 * 1000;
      const returnTo = req.session.returnTo || '/';
      delete req.session.returnTo;
      res.redirect(returnTo);
    });
  } catch (err) {
    fail('Login failed: ' + err.message);
  }
});

// ── 2FA verification (after password, before full session) ─────────────────

router.get('/auth/2fa', (req, res) => {
  if (!req.session.pending2fa) return res.redirect('/auth/login');
  if (Date.now() > req.session.pending2fa.expiresAt) {
    delete req.session.pending2fa;
    return res.redirect('/auth/login');
  }
  res.render('2fa_verify', { layout: false, error: null });
});

router.post('/auth/2fa', (req, res) => {
  const pending = req.session.pending2fa;
  if (!pending || Date.now() > pending.expiresAt) {
    delete req.session.pending2fa;
    return res.redirect('/auth/login');
  }

  const { token } = req.body;
  const db = getDb();
  const user = db.prepare('SELECT * FROM local_users WHERE id = ?').get(pending.userId);

  if (!user || !user.totp_secret || !authenticator.verify({ token: (token || '').replace(/\s/g, ''), secret: user.totp_secret })) {
    return res.render('2fa_verify', { layout: false, error: 'Invalid code. Try again.' });
  }

  const { returnTo, rememberMe } = pending;
  req.session.regenerate((err) => {
    if (err) return res.redirect('/auth/login');
    req.session.userId = user.id;
    req.session.userType = 'local';
    req.session.user = { name: user.username, email: null, role: user.role || 'local_admin' };
    if (rememberMe) req.session.cookie.maxAge = 30 * 24 * 60 * 60 * 1000;
    res.redirect(returnTo);
  });
});

// ── SSO — redirect to Microsoft ────────────────────────────────────────────

router.get('/auth/sso/:tenantDbId', async (req, res) => {
  try {
    const tenant = getDb().prepare('SELECT * FROM sso_tenants WHERE id = ? AND enabled = 1 AND sso_enabled = 1').get(req.params.tenantDbId);
    if (!tenant) return res.status(404).send('Tenant not found or disabled.');

    const nonce = crypto.randomBytes(16).toString('hex');
    const { url } = await getAuthCodeUrl(tenant, nonce);
    req.session.oauthNonce = nonce;
    req.session.rememberMe = req.query.remember === '1';
    res.redirect(url);
  } catch (err) {
    res.status(500).send('SSO redirect failed: ' + err.message);
  }
});

// ── SSO — callback from Microsoft ──────────────────────────────────────────

router.get('/auth/callback', async (req, res) => {
  const { code, state, error, error_description } = req.query;
  if (error) return res.status(400).send(`Microsoft error: ${error_description || error}`);
  if (!code || !state) return res.status(400).send('Invalid callback.');

  const stateData = decodeState(state);
  if (!stateData) return res.status(400).send('Invalid state parameter.');

  try {
    const db = getDb();
    const tenant = db.prepare('SELECT * FROM sso_tenants WHERE id = ?').get(stateData.tenantDbId);
    if (!tenant) return res.status(400).send('Unknown tenant.');

    const { tokenResponse, serializedCache } = await exchangeCode(tenant, code);
    const account = tokenResponse.account;

    // Upsert SSO user
    let ssoUser = db.prepare('SELECT * FROM sso_users WHERE email = ?').get(account.username);
    if (!ssoUser) {
      const r = db.prepare(`
        INSERT INTO sso_users (tenant_db_id, email, display_name, home_account_id)
        VALUES (?, ?, ?, ?)
      `).run(tenant.id, account.username, account.name || account.username, account.homeAccountId);
      ssoUser = db.prepare('SELECT * FROM sso_users WHERE id = ?').get(r.lastInsertRowid);
    } else {
      db.prepare("UPDATE sso_users SET last_login = datetime('now'), home_account_id = ?, display_name = ? WHERE id = ?")
        .run(account.homeAccountId, account.name || account.username, ssoUser.id);
    }

    const rememberMe = req.session.rememberMe || false;
    req.session.regenerate((err) => {
      if (err) return res.status(500).send('Session error.');
      req.session.userId = ssoUser.id;
      req.session.userType = 'sso';
      req.session.tenantDbId = tenant.id;
      req.session.accountId = account.homeAccountId;
      req.session.msalTokenCache = serializedCache;
      req.session.user = { name: account.name || account.username, email: account.username, role: ssoUser.role };
      if (rememberMe) req.session.cookie.maxAge = 30 * 24 * 60 * 60 * 1000;
      const returnTo = req.session.returnTo || '/';
      delete req.session.returnTo;
      res.redirect(returnTo);
    });
  } catch (err) {
    res.status(500).send('Token exchange failed: ' + err.message);
  }
});

// ── Logout ─────────────────────────────────────────────────────────────────

router.get('/auth/logout', (req, res) => {
  const userType = req.session.userType;
  const tenantDbId = req.session.tenantDbId;

  req.session.destroy(() => {
    if (userType === 'sso') {
      try {
        const tenant = getDb().prepare('SELECT * FROM sso_tenants WHERE id = ?').get(tenantDbId);
        if (tenant) {
          const post = encodeURIComponent(tenant.redirect_uri.replace('/auth/callback', '/auth/login'));
          return res.redirect(
            `https://login.microsoftonline.com/${tenant.tenant_id}/oauth2/v2.0/logout?post_logout_redirect_uri=${post}`
          );
        }
      } catch { /* fall through */ }
    }
    res.redirect('/auth/login');
  });
});

module.exports = router;
