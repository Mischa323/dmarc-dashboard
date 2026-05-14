const express = require('express');
const fs = require('fs');
const path = require('path');
const { authenticator } = require('otplib');
const qrcode = require('qrcode');
const { getDb, getSetting, setSetting } = require('../db');
const { startScheduler } = require('../scheduler');
const { testTenantConnection } = require('../tenantTest');

const router = express.Router();

// ── Guards ─────────────────────────────────────────────────────────────────

function requireAnyAdmin(req, res, next) {
  const role = req.session.user && req.session.user.role;
  if (role === 'local_admin' || role === 'admin') return next();
  res.status(403).render('error', { layout: 'layout', title: 'Access Denied', message: 'Admin access required.' });
}

function requireLocalAdmin(req, res, next) {
  if (req.session.user && req.session.user.role === 'local_admin') return next();
  res.status(403).render('error', { layout: 'layout', title: 'Access Denied', message: 'This area requires the local administrator account.' });
}

router.use(requireAnyAdmin);

// ── Admin index ────────────────────────────────────────────────────────────

router.get('/', (req, res) => {
  const db = getDb();
  const stats = {
    tenants: db.prepare('SELECT COUNT(*) as n FROM sso_tenants').get().n,
    users: db.prepare('SELECT COUNT(*) as n FROM sso_users').get().n,
    reports: db.prepare('SELECT COUNT(*) as n FROM reports').get().n,
    localAdmins: db.prepare('SELECT COUNT(*) as n FROM local_users').get().n,
  };
  res.render('admin/index', { title: 'Admin', path: '/admin', stats });
});

// ── Tenants ─────────────────────────────────────────────────────────────────

function loadTenantsWithDomains(db) {
  const tenants = db.prepare('SELECT * FROM sso_tenants ORDER BY name').all();
  const allDomains = db.prepare('SELECT * FROM tenant_domains ORDER BY id').all();
  const byTenant = {};
  for (const d of allDomains) {
    (byTenant[d.tenant_id] = byTenant[d.tenant_id] || []).push(d);
  }
  for (const t of tenants) t.domains = byTenant[t.id] || [];
  return tenants;
}

function saveDomains(db, tenantId, rawDomains) {
  db.prepare('DELETE FROM tenant_domains WHERE tenant_id = ?').run(tenantId);
  const ins = db.prepare('INSERT OR IGNORE INTO tenant_domains (tenant_id, domain, dmarc_policy) VALUES (?, ?, ?)');
  for (const d of (rawDomains || [])) {
    const dom = (d.domain || '').trim();
    if (dom) ins.run(tenantId, dom, ['none', 'quarantine', 'reject'].includes(d.policy) ? d.policy : 'none');
  }
}

router.get('/tenants', (req, res) => {
  const db = getDb();
  const tenants = loadTenantsWithDomains(db);
  const globalInterval = parseInt(getSetting(db, 'fetch_interval_minutes', '60')) || 60;
  const flash = req.session.flash || null;
  delete req.session.flash;
  res.render('admin/tenants', { title: 'Tenants', path: '/admin', tenants, globalInterval, flash });
});

router.get('/tenants/new', (req, res) => {
  const db = getDb();
  const defaultPort = process.env.PORT || 3443;
  const globalInterval = parseInt(getSetting(db, 'fetch_interval_minutes', '60')) || 60;
  res.render('admin/tenant_form', {
    title: 'Add Tenant', path: '/admin', error: null, globalInterval,
    tenant: {
      id: null, name: '', tenant_id: '', client_id: '', client_secret: '',
      redirect_uri: `https://localhost:${defaultPort}/auth/callback`,
      mailbox: '', mail_folder: 'Inbox', fetch_interval_override: null,
      sso_enabled: 1, domains: [],
    },
  });
});

router.post('/tenants', (req, res) => {
  const { name, tenant_id, client_id, client_secret, mailbox, mail_folder, redirect_uri } = req.body;
  const sso_enabled = req.body.sso_enabled === '1' ? 1 : 0;
  const rawDomains  = req.body.domains ? Object.values(req.body.domains) : [];
  const useGlobal   = req.body.use_global_interval === '1';
  const fetch_interval_override = useGlobal ? null : (parseInt(req.body.fetch_interval_override) || null);

  const db = getDb();
  const globalInterval = parseInt(getSetting(db, 'fetch_interval_minutes', '60')) || 60;

  const fail = (msg) => res.render('admin/tenant_form', {
    title: 'Add Tenant', path: '/admin', globalInterval,
    tenant: { ...req.body, sso_enabled, domains: rawDomains, fetch_interval_override },
    error: msg,
  });

  if (!name || !tenant_id || !client_id || !client_secret || !mailbox)
    return fail('Name, Tenant ID, Client ID, Client Secret, and Mailbox are required.');
  if (sso_enabled && !redirect_uri)
    return fail('Redirect URI is required when SSO login is enabled.');

  try {
    const r = db.prepare(`
      INSERT INTO sso_tenants
        (name, tenant_id, client_id, client_secret, redirect_uri, mailbox,
         mail_folder, fetch_interval_override, sso_enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(name, tenant_id, client_id, client_secret, redirect_uri || '', mailbox,
           mail_folder || 'Inbox', fetch_interval_override, sso_enabled);
    saveDomains(db, r.lastInsertRowid, rawDomains);
    startScheduler();
    req.session.flash = `Tenant "${name}" added.`;
    res.redirect('/admin/tenants');
  } catch (err) {
    fail(err.message);
  }
});

router.get('/tenants/:id/edit', (req, res) => {
  const db = getDb();
  const tenant = db.prepare('SELECT * FROM sso_tenants WHERE id = ?').get(req.params.id);
  if (!tenant) return res.status(404).render('error', { layout: 'layout', title: 'Not Found', message: 'Tenant not found.' });
  tenant.domains = db.prepare('SELECT * FROM tenant_domains WHERE tenant_id = ? ORDER BY id').all(req.params.id);
  const globalInterval = parseInt(getSetting(db, 'fetch_interval_minutes', '60')) || 60;
  res.render('admin/tenant_form', { title: 'Edit Tenant', path: '/admin', globalInterval, tenant: { ...tenant, client_secret: '' }, error: null });
});

router.post('/tenants/:id', (req, res) => {
  const { name, tenant_id, client_id, client_secret, mailbox, mail_folder, redirect_uri } = req.body;
  const sso_enabled = req.body.sso_enabled === '1' ? 1 : 0;
  const rawDomains  = req.body.domains ? Object.values(req.body.domains) : [];
  const useGlobal   = req.body.use_global_interval === '1';
  const fetch_interval_override = useGlobal ? null : (parseInt(req.body.fetch_interval_override) || null);

  const db = getDb();
  const existing = db.prepare('SELECT * FROM sso_tenants WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).send('Not found');

  const secret = (client_secret && client_secret.trim()) ? client_secret.trim() : existing.client_secret;
  db.prepare(`
    UPDATE sso_tenants SET name=?, tenant_id=?, client_id=?, client_secret=?,
      redirect_uri=?, mailbox=?, mail_folder=?, fetch_interval_override=?, sso_enabled=?
    WHERE id=?
  `).run(name, tenant_id, client_id, secret, redirect_uri || '', mailbox,
         mail_folder || 'Inbox', fetch_interval_override, sso_enabled, req.params.id);
  saveDomains(db, req.params.id, rawDomains);
  startScheduler();
  req.session.flash = `Tenant "${name}" updated.`;
  res.redirect('/admin/tenants');
});

router.post('/tenants/:id/toggle', (req, res) => {
  const db = getDb();
  const tenant = db.prepare('SELECT * FROM sso_tenants WHERE id = ?').get(req.params.id);
  if (!tenant) return res.status(404).send('Not found');
  db.prepare('UPDATE sso_tenants SET enabled = ? WHERE id = ?').run(tenant.enabled ? 0 : 1, req.params.id);
  startScheduler();
  res.redirect('/admin/tenants');
});

router.post('/tenants/:id/delete', (req, res) => {
  const db = getDb();
  const tenant = db.prepare('SELECT name FROM sso_tenants WHERE id = ?').get(req.params.id);
  db.prepare('DELETE FROM sso_tenants WHERE id = ?').run(req.params.id);
  startScheduler();
  req.session.flash = tenant ? `Tenant "${tenant.name}" deleted.` : 'Tenant deleted.';
  res.redirect('/admin/tenants');
});

router.post('/tenants/:id/test', async (req, res) => {
  const db = getDb();
  const tenant = db.prepare('SELECT * FROM sso_tenants WHERE id = ?').get(req.params.id);
  if (!tenant) return res.json({ checks: [{ label: 'Error', ok: false, error: 'Tenant not found.' }] });
  tenant.domains = db.prepare('SELECT * FROM tenant_domains WHERE tenant_id = ? ORDER BY id').all(req.params.id);
  try {
    const result = await testTenantConnection(tenant);
    res.json(result);
  } catch (err) {
    res.json({ checks: [{ label: 'Error', ok: false, error: err.message }] });
  }
});

// ── Users ───────────────────────────────────────────────────────────────────

router.get('/users', (req, res) => {
  const db = getDb();
  const ssoUsers = db.prepare(`
    SELECT u.*, t.name as tenant_name
    FROM sso_users u
    LEFT JOIN sso_tenants t ON u.tenant_db_id = t.id
    ORDER BY u.created_at DESC
  `).all();
  const localUsers = db.prepare('SELECT id, username, role, totp_enabled, created_at FROM local_users ORDER BY id').all();
  const flash = req.session.flash || null;
  delete req.session.flash;
  res.render('admin/users', { title: 'Users', path: '/admin', ssoUsers, localUsers, flash });
});

// SSO user management
router.post('/users/:id/role', (req, res) => {
  const { role } = req.body;
  if (!['viewer', 'admin'].includes(role)) return res.status(400).send('Invalid role.');
  getDb().prepare('UPDATE sso_users SET role = ? WHERE id = ?').run(role, req.params.id);
  req.session.flash = 'Role updated.';
  res.redirect('/admin/users');
});

router.post('/users/:id/delete', (req, res) => {
  getDb().prepare('DELETE FROM sso_users WHERE id = ?').run(req.params.id);
  req.session.flash = 'User removed.';
  res.redirect('/admin/users');
});

// ── Local users ─────────────────────────────────────────────────────────────

router.post('/local-users', async (req, res) => {
  const bcrypt = require('bcryptjs');
  const { username, password, confirmPassword, role } = req.body;
  const db = getDb();

  const usernameClean = (username || '').trim();
  const roleClean = ['viewer', 'admin'].includes(role) ? role : 'viewer';

  const fail = (msg) => {
    const ssoUsers = db.prepare(`SELECT u.*, t.name as tenant_name FROM sso_users u LEFT JOIN sso_tenants t ON u.tenant_db_id = t.id ORDER BY u.created_at DESC`).all();
    const localUsers = db.prepare('SELECT id, username, role, totp_enabled, created_at FROM local_users ORDER BY id').all();
    res.render('admin/users', { title: 'Users', path: '/admin', ssoUsers, localUsers, flash: null, error: msg });
  };

  if (!usernameClean || usernameClean.length < 3) return fail('Username must be at least 3 characters.');
  if (!password || password.length < 8) return fail('Password must be at least 8 characters.');
  if (password !== confirmPassword) return fail('Passwords do not match.');

  try {
    const hash = await bcrypt.hash(password, 12);
    db.prepare('INSERT INTO local_users (username, password_hash, role) VALUES (?, ?, ?)').run(usernameClean, hash, roleClean);
    req.session.flash = `Local user "${usernameClean}" created.`;
    res.redirect('/admin/users');
  } catch (err) {
    fail(err.message.includes('UNIQUE') ? `Username "${usernameClean}" is already taken.` : err.message);
  }
});

router.post('/local-users/:id/role', (req, res) => {
  const { role } = req.body;
  if (!['viewer', 'admin'].includes(role)) return res.status(400).send('Invalid role.');
  const user = getDb().prepare('SELECT role FROM local_users WHERE id = ?').get(req.params.id);
  if (!user || user.role === 'local_admin') return res.status(403).send('Cannot change the local admin role.');
  getDb().prepare('UPDATE local_users SET role = ? WHERE id = ?').run(role, req.params.id);
  req.session.flash = 'Role updated.';
  res.redirect('/admin/users');
});

router.post('/local-users/:id/delete', (req, res) => {
  const user = getDb().prepare('SELECT role, username FROM local_users WHERE id = ?').get(req.params.id);
  if (!user || user.role === 'local_admin') return res.status(403).send('Cannot delete the local admin account.');
  getDb().prepare('DELETE FROM local_users WHERE id = ?').run(req.params.id);
  req.session.flash = `User "${user.username}" deleted.`;
  res.redirect('/admin/users');
});

// ── Global settings (local admin only) ─────────────────────────────────────

router.get('/settings', requireLocalAdmin, (req, res) => {
  const db = getDb();
  const globalInterval = parseInt(getSetting(db, 'fetch_interval_minutes', '60')) || 60;
  const flash = req.session.flash || null;
  delete req.session.flash;
  res.render('admin/settings', { title: 'Settings', path: '/admin', globalInterval, flash });
});

router.post('/settings', requireLocalAdmin, (req, res) => {
  const db = getDb();
  const minutes = Math.max(5, parseInt(req.body.fetch_interval_minutes) || 60);
  setSetting(db, 'fetch_interval_minutes', String(minutes));
  startScheduler();
  req.session.flash = 'Settings saved.';
  res.redirect('/admin/settings');
});

// ── 2FA setup (local admin only) ───────────────────────────────────────────

router.get('/2fa', requireLocalAdmin, async (req, res) => {
  const user = getDb().prepare('SELECT * FROM local_users WHERE id = ?').get(req.session.userId);
  if (user.totp_enabled) {
    return res.render('admin/2fa_setup', { title: '2FA', path: '/admin', qrDataUrl: null, secret: null, enabled: true, error: null, flash: req.session.flash || null });
  }
  // Generate a new provisional secret (not saved yet)
  const secret = authenticator.generateSecret();
  req.session.provisionalTotpSecret = secret;
  const otpauth = authenticator.keyuri(user.username, 'DMARC Dashboard', secret);
  const qrDataUrl = await qrcode.toDataURL(otpauth);
  delete req.session.flash;
  res.render('admin/2fa_setup', { title: '2FA', path: '/admin', qrDataUrl, secret, enabled: false, error: null, flash: null });
});

router.post('/2fa/enable', requireLocalAdmin, (req, res) => {
  const { token } = req.body;
  const secret = req.session.provisionalTotpSecret;
  if (!secret) return res.redirect('/admin/2fa');

  if (!authenticator.verify({ token: (token || '').replace(/\s/g, ''), secret })) {
    return (async () => {
      const user = getDb().prepare('SELECT username FROM local_users WHERE id = ?').get(req.session.userId);
      const otpauth = authenticator.keyuri(user.username, 'DMARC Dashboard', secret);
      const qrDataUrl = await qrcode.toDataURL(otpauth);
      res.render('admin/2fa_setup', { title: '2FA', path: '/admin', qrDataUrl, secret, enabled: false, error: 'Invalid code — try again.', flash: null });
    })();
  }

  getDb().prepare('UPDATE local_users SET totp_secret = ?, totp_enabled = 1 WHERE id = ?').run(secret, req.session.userId);
  delete req.session.provisionalTotpSecret;
  req.session.flash = '2FA enabled successfully.';
  res.redirect('/admin/2fa');
});

router.post('/2fa/disable', requireLocalAdmin, (req, res) => {
  getDb().prepare('UPDATE local_users SET totp_secret = NULL, totp_enabled = 0 WHERE id = ?').run(req.session.userId);
  req.session.flash = '2FA has been disabled.';
  res.redirect('/admin/2fa');
});

// ── Danger zone (local admin only) ─────────────────────────────────────────

router.get('/danger', requireLocalAdmin, (req, res) => {
  const flash = req.session.flash || null;
  delete req.session.flash;
  res.render('admin/danger', { title: 'Danger Zone', path: '/admin', error: null, flash });
});

router.post('/danger/reset-reports', requireLocalAdmin, (req, res) => {
  if (req.body.confirm !== 'DELETE') {
    return res.render('admin/danger', { title: 'Danger Zone', path: '/admin', error: 'Type DELETE to confirm.' });
  }
  const db = getDb();
  db.prepare('DELETE FROM records').run();
  db.prepare('DELETE FROM reports').run();
  req.session.flash = 'All DMARC report data has been deleted.';
  res.redirect('/admin/danger');
});

router.post('/danger/reset-all', requireLocalAdmin, (req, res) => {
  if (req.body.confirm !== 'RESET') {
    return res.render('admin/danger', { title: 'Danger Zone', path: '/admin', error: 'Type RESET to confirm.' });
  }

  const dbPath = path.resolve(process.env.DATABASE_URL || 'dmarc.db');
  const envPath = path.join(__dirname, '..', '..', '.env');
  const certsPath = path.join(__dirname, '..', '..', 'certs');

  req.session.destroy(() => {
    try { if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath); } catch { /* ignore */ }
    try { if (fs.existsSync(envPath)) fs.unlinkSync(envPath); } catch { /* ignore */ }
    try { fs.rmSync(certsPath, { recursive: true, force: true }); } catch { /* ignore */ }

    // Clear in-memory DB reference so next request recreates everything
    try { require('../db')._reset && require('../db')._reset(); } catch { /* ignore */ }

    res.redirect('/setup/1');
  });
});

module.exports = router;
