const express = require('express');
const fs = require('fs');
const path = require('path');
const { authenticator } = require('otplib');
const qrcode = require('qrcode');
const { getDb, getSetting, setSetting } = require('../db');
const { startScheduler } = require('../scheduler');
const { testTenantConnection } = require('../tenantTest');

const DOMAIN_PALETTE = ['#0a84ff','#30d158','#bf5af2','#ff9f0a','#64d2ff','#ff6961','#5ac8fa','#ffd60a'];

function autoColor(db) {
  const n = db.prepare('SELECT COUNT(*) as n FROM sso_tenants').get().n;
  return DOMAIN_PALETTE[n % DOMAIN_PALETTE.length];
}

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
  const color = (req.body.color || '').trim() || autoColor(db);

  const fail = (msg) => res.render('admin/tenant_form', {
    title: 'Add Tenant', path: '/admin', globalInterval,
    tenant: { ...req.body, sso_enabled, domains: rawDomains, fetch_interval_override, color },
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
         mail_folder, fetch_interval_override, sso_enabled, color)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(name, tenant_id, client_id, client_secret, redirect_uri || '', mailbox,
           mail_folder || 'Inbox', fetch_interval_override, sso_enabled, color);
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
  const color  = (req.body.color || '').trim() || existing.color || autoColor(db);
  db.prepare(`
    UPDATE sso_tenants SET name=?, tenant_id=?, client_id=?, client_secret=?,
      redirect_uri=?, mailbox=?, mail_folder=?, fetch_interval_override=?, sso_enabled=?, color=?
    WHERE id=?
  `).run(name, tenant_id, client_id, secret, redirect_uri || '', mailbox,
         mail_folder || 'Inbox', fetch_interval_override, sso_enabled, color, req.params.id);
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
  const localUsers = db.prepare('SELECT id, username, email, role, totp_enabled, created_at FROM local_users ORDER BY id').all();
  const emailGroups = db.prepare('SELECT * FROM email_report_groups ORDER BY name').all();
  for (const g of emailGroups) {
    g.member_count = db.prepare('SELECT COUNT(*) as n FROM group_members WHERE group_id = ?').get(g.id).n;
    g.tenant_count = db.prepare('SELECT COUNT(*) as n FROM group_tenants WHERE group_id = ?').get(g.id).n;
  }
  const flash = req.session.flash || null;
  delete req.session.flash;
  res.render('admin/users', { title: 'Users & Groups', path: '/admin', ssoUsers, localUsers, emailGroups, flash });
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
  const emailClean    = (req.body.email || '').trim() || null;
  const roleClean     = ['viewer', 'admin'].includes(role) ? role : 'viewer';

  const fail = (msg) => {
    const ssoUsers = db.prepare(`SELECT u.*, t.name as tenant_name FROM sso_users u LEFT JOIN sso_tenants t ON u.tenant_db_id = t.id ORDER BY u.created_at DESC`).all();
    const localUsers = db.prepare('SELECT id, username, email, role, totp_enabled, created_at FROM local_users ORDER BY id').all();
    const emailGroups = db.prepare('SELECT * FROM email_report_groups ORDER BY name').all();
    for (const g of emailGroups) g.recipient_count = db.prepare('SELECT COUNT(*) as n FROM email_report_recipients WHERE group_id = ?').get(g.id).n;
    res.render('admin/users', { title: 'Users & Groups', path: '/admin', ssoUsers, localUsers, emailGroups, flash: null, error: msg });
  };

  if (!usernameClean || usernameClean.length < 3) return fail('Username must be at least 3 characters.');
  if (!password || password.length < 8) return fail('Password must be at least 8 characters.');
  if (password !== confirmPassword) return fail('Passwords do not match.');

  try {
    const hash = await bcrypt.hash(password, 12);
    db.prepare('INSERT INTO local_users (username, password_hash, role, email) VALUES (?, ?, ?, ?)').run(usernameClean, hash, roleClean, emailClean);
    req.session.flash = `Local user "${usernameClean}" created.`;
    res.redirect('/admin/users');
  } catch (err) {
    fail(err.message.includes('UNIQUE') ? `Username "${usernameClean}" is already taken.` : err.message);
  }
});

router.post('/local-users/:id/email', (req, res) => {
  const user = getDb().prepare('SELECT role FROM local_users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).send('Not found');
  const email = (req.body.email || '').trim() || null;
  getDb().prepare('UPDATE local_users SET email = ? WHERE id = ?').run(email, req.params.id);
  req.session.flash = 'Email address updated.';
  res.redirect('/admin/users');
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
  const tenants = db.prepare('SELECT id, name FROM sso_tenants WHERE enabled = 1 ORDER BY name').all();
  const mail = {
    transport:       getSetting(db, 'mail_transport', 'smtp'),
    timezone:        getSetting(db, 'mail_timezone', 'UTC'),
    smtp_host:       getSetting(db, 'mail_smtp_host', ''),
    smtp_port:       getSetting(db, 'mail_smtp_port', '587'),
    smtp_secure:     getSetting(db, 'mail_smtp_secure', '0'),
    smtp_user:       getSetting(db, 'mail_smtp_user', ''),
    smtp_from:       getSetting(db, 'mail_smtp_from', ''),
    graph_tenant_id: getSetting(db, 'mail_graph_tenant_id', ''),
  };
  let timezones = ['UTC'];
  try { timezones = Intl.supportedValuesOf('timeZone'); } catch {}

  const { getDbPath } = require('../db');
  const fs = require('fs');
  let dbSizeBytes = 0;
  try { dbSizeBytes = fs.statSync(getDbPath()).size; } catch {}
  const storage = {
    reports:       db.prepare('SELECT COUNT(*) AS cnt FROM reports').get().cnt,
    records:       db.prepare('SELECT COUNT(*) AS cnt FROM records').get().cnt,
    dbSizeBytes,
    retentionDays: parseInt(getSetting(db, 'report_retention_days', '0')) || 0,
  };

  const flash = req.session.flash || null;
  delete req.session.flash;
  res.render('admin/settings', { title: 'Settings', path: '/admin', globalInterval, mail, tenants, timezones, storage, flash });
});

function _buildTestEmailHtml(transport) {
  const label = transport === 'graph' ? 'Microsoft Graph API' : 'SMTP';
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,sans-serif;color:#e0e0e0;">
<div style="max-width:520px;margin:40px auto;padding:0 16px;">

  <div style="background:linear-gradient(135deg,#0d0d1f 0%,#0a0a14 100%);border:1px solid rgba(255,255,255,.1);border-radius:20px;padding:36px 32px 28px;margin-bottom:16px;text-align:center;">
    <div style="font-size:36px;margin-bottom:10px;">📊</div>
    <h1 style="margin:0 0 6px;font-size:22px;font-weight:700;color:#fff;letter-spacing:-.3px;">DMARC Dashboard</h1>
    <p style="margin:0;font-size:13px;color:#555;">Mail configuration test</p>
  </div>

  <div style="background:linear-gradient(135deg,rgba(48,209,88,.08) 0%,rgba(48,209,88,.03) 100%);border:1px solid rgba(48,209,88,.25);border-radius:16px;padding:24px 28px;margin-bottom:16px;text-align:center;">
    <div style="font-size:28px;margin-bottom:10px;">✅</div>
    <div style="font-size:17px;font-weight:600;color:#30d158;margin-bottom:6px;">Connection successful</div>
    <div style="font-size:13px;color:#666;">${label} is configured correctly.<br>Your DMARC reports will be delivered.</div>
  </div>

  <div style="background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07);border-radius:12px;padding:16px 20px;margin-bottom:20px;">
    <table style="width:100%;border-collapse:collapse;font-size:12px;">
      <tr>
        <td style="color:#555;padding:4px 0;">Transport</td>
        <td style="color:#aaa;text-align:right;padding:4px 0;">${label}</td>
      </tr>
      <tr>
        <td style="color:#555;padding:4px 0;">Sent at</td>
        <td style="color:#aaa;text-align:right;padding:4px 0;">${new Date().toUTCString()}</td>
      </tr>
    </table>
  </div>

  <p style="text-align:center;font-size:11px;color:#333;margin:0;">Sent by DMARC Dashboard &middot; Automated test</p>
</div>
</body></html>`;
}

router.post('/settings/test-mail', requireLocalAdmin, async (req, res) => {
  const db = getDb();
  const transport = req.body.mail_transport === 'graph' ? 'graph' : 'smtp';
  const testTo = (req.body.test_to || '').trim();
  if (!testTo) return res.json({ ok: false, error: 'Enter a recipient address to send the test to.' });

  try {
    if (transport === 'smtp') {
      const { testSmtpConfig } = require('../emailSender');
      const pass = (req.body.mail_smtp_pass || '').trim() || getSetting(db, 'mail_smtp_pass', '');
      await testSmtpConfig({
        smtpConfig: {
          host:   (req.body.mail_smtp_host || '').trim(),
          port:   parseInt(req.body.mail_smtp_port) || 587,
          secure: req.body.mail_smtp_secure === '1',
          user:   (req.body.mail_smtp_user || '').trim() || undefined,
          pass,
        },
        from:    (req.body.mail_smtp_from || '').trim() || testTo,
        to:      testTo,
        subject: 'DMARC Dashboard — SMTP test',
        html:    _buildTestEmailHtml('smtp'),
      });
      res.json({ ok: true, message: `Test email sent to ${testTo}.` });
    } else {
      const tenantId = parseInt(req.body.mail_graph_tenant_id);
      if (!tenantId) return res.json({ ok: false, error: 'Select a tenant first.' });
      const tenant = db.prepare('SELECT * FROM sso_tenants WHERE id = ?').get(tenantId);
      if (!tenant) return res.json({ ok: false, error: 'Tenant not found.' });
      const { sendEmail } = require('../emailSender');
      await sendEmail({
        transport: 'graph',
        graphTenant: tenant,
        from: tenant.mailbox,
        to: [testTo],
        subject: 'DMARC Dashboard — Graph API test',
        html:    _buildTestEmailHtml('graph'),
      });
      res.json({ ok: true, message: `Test email sent via Graph to ${testTo}.` });
    }
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

router.post('/settings', requireLocalAdmin, (req, res) => {
  const db = getDb();
  const minutes = Math.max(5, parseInt(req.body.fetch_interval_minutes) || 60);
  setSetting(db, 'fetch_interval_minutes', String(minutes));

  // Mail transport
  const transport = req.body.mail_transport === 'graph' ? 'graph' : 'smtp';
  setSetting(db, 'mail_transport',    transport);
  setSetting(db, 'mail_smtp_host',    (req.body.mail_smtp_host || '').trim());
  setSetting(db, 'mail_smtp_port',    String(parseInt(req.body.mail_smtp_port) || 587));
  setSetting(db, 'mail_smtp_secure',  req.body.mail_smtp_secure === '1' ? '1' : '0');
  setSetting(db, 'mail_smtp_user',    (req.body.mail_smtp_user || '').trim());
  setSetting(db, 'mail_smtp_from',    (req.body.mail_smtp_from || '').trim());
  setSetting(db, 'mail_graph_tenant_id', (req.body.mail_graph_tenant_id || '').trim());
  setSetting(db, 'mail_timezone', (req.body.mail_timezone || 'UTC').trim());
  // Only overwrite password if a new value was provided
  if ((req.body.mail_smtp_pass || '').trim()) {
    setSetting(db, 'mail_smtp_pass', req.body.mail_smtp_pass.trim());
  }

  const retentionDays = Math.max(0, parseInt(req.body.report_retention_days) || 0);
  setSetting(db, 'report_retention_days', String(retentionDays));

  startScheduler();
  req.session.flash = 'Settings saved.';
  res.redirect('/admin/settings');
});

router.post('/settings/purge', requireLocalAdmin, (req, res) => {
  const db = getDb();
  const days = parseInt(getSetting(db, 'report_retention_days', '0')) || 0;
  if (!days) return res.json({ ok: false, error: 'No retention period configured.' });
  const { purgeOldReports } = require('../db');
  const deleted = purgeOldReports(db, days);
  res.json({ ok: true, deleted });
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

// ── Email report groups ─────────────────────────────────────────────────────

function loadGroupWithMembers(db, id) {
  const group = db.prepare('SELECT * FROM email_report_groups WHERE id = ?').get(id);
  if (!group) return null;
  group.member_ids = db.prepare('SELECT member_type, member_id FROM group_members WHERE group_id = ?').all(id);
  group.tenant_ids = db.prepare('SELECT tenant_id FROM group_tenants WHERE group_id = ?').all(id).map(r => r.tenant_id);
  return group;
}

function saveMembers(db, groupId, memberLocal, memberSso) {
  db.prepare('DELETE FROM group_members WHERE group_id = ?').run(groupId);
  const ins = db.prepare('INSERT OR IGNORE INTO group_members (group_id, member_type, member_id) VALUES (?, ?, ?)');
  for (const id of (memberLocal || [])) ins.run(groupId, 'local', parseInt(id));
  for (const id of (memberSso   || [])) ins.run(groupId, 'sso',   parseInt(id));
}

function saveGroupTenants(db, groupId, tenantIds) {
  db.prepare('DELETE FROM group_tenants WHERE group_id = ?').run(groupId);
  const ins = db.prepare('INSERT OR IGNORE INTO group_tenants (group_id, tenant_id) VALUES (?, ?)');
  for (const id of (tenantIds || [])) ins.run(groupId, parseInt(id));
}

function groupFormLocals(db) {
  const localUsers = db.prepare('SELECT id, username, email FROM local_users ORDER BY username').all();
  const ssoUsers   = db.prepare('SELECT id, display_name, email FROM sso_users ORDER BY display_name').all();
  const tenants    = db.prepare('SELECT id, name FROM sso_tenants WHERE enabled = 1 ORDER BY name').all();
  return { localUsers, ssoUsers, tenants };
}

router.get('/email-reports', (req, res) => {
  const db = getDb();
  const groups = db.prepare('SELECT * FROM email_report_groups ORDER BY name').all();
  for (const g of groups) {
    g.member_count = db.prepare('SELECT COUNT(*) as n FROM group_members WHERE group_id = ?').get(g.id).n;
    g.tenant_count = db.prepare('SELECT COUNT(*) as n FROM group_tenants WHERE group_id = ?').get(g.id).n;
  }
  const flash = req.session.flash || null;
  delete req.session.flash;
  res.render('admin/email_reports', { title: 'Email Reports', path: '/admin', groups, flash });
});

router.get('/email-reports/new', (req, res) => {
  const db = getDb();
  res.render('admin/email_report_form', {
    title: 'New Security Group', path: '/admin', error: null, ...groupFormLocals(db),
    group: { id: null, name: '', schedule: 'none', member_ids: [], tenant_ids: [] },
  });
});

router.post('/email-reports', (req, res) => {
  const db = getDb();
  const { name } = req.body;
  const schedule       = ['none','daily','weekly','monthly','both'].includes(req.body.schedule) ? req.body.schedule : 'none';
  const role           = req.body.role === 'admin' ? 'admin' : 'viewer';
  const send_time      = req.body.send_time || '08:00';
  const send_day       = parseInt(req.body.send_day) || 1;
  const send_month_day = Math.min(28, Math.max(1, parseInt(req.body.send_month_day) || 1));
  const memberLocal = [].concat(req.body.member_local || []);
  const memberSso   = [].concat(req.body.member_sso   || []);
  const tenantIds   = [].concat(req.body.tenant_ids   || []);

  const fail = (msg) => res.render('admin/email_report_form', {
    title: 'New Security Group', path: '/admin', error: msg, ...groupFormLocals(db),
    group: { id: null, name, schedule, role, send_time, send_day, send_month_day, member_ids: [], tenant_ids: tenantIds.map(Number) },
  });

  if (!name) return fail('Name is required.');

  const r = db.prepare('INSERT INTO email_report_groups (name, schedule, role, send_time, send_day, send_month_day) VALUES (?, ?, ?, ?, ?, ?)').run(name, schedule, role, send_time, send_day, send_month_day);
  saveMembers(db, r.lastInsertRowid, memberLocal, memberSso);
  saveGroupTenants(db, r.lastInsertRowid, tenantIds);
  req.session.flash = `Group "${name}" created.`;
  res.redirect('/admin/users');
});

router.get('/email-reports/:id/edit', (req, res) => {
  const db = getDb();
  const group = loadGroupWithMembers(db, req.params.id);
  if (!group) return res.status(404).render('error', { layout: 'layout', title: 'Not Found', message: 'Group not found.' });
  res.render('admin/email_report_form', { title: 'Edit Group', path: '/admin', error: null, ...groupFormLocals(db), group });
});

router.post('/email-reports/:id', (req, res) => {
  const db = getDb();
  const existing = db.prepare('SELECT id FROM email_report_groups WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).send('Not found');

  const { name } = req.body;
  const schedule       = ['none','daily','weekly','monthly','both'].includes(req.body.schedule) ? req.body.schedule : 'none';
  const role           = req.body.role === 'admin' ? 'admin' : 'viewer';
  const send_time      = req.body.send_time || '08:00';
  const send_day       = parseInt(req.body.send_day) || 1;
  const send_month_day = Math.min(28, Math.max(1, parseInt(req.body.send_month_day) || 1));
  const memberLocal = [].concat(req.body.member_local || []);
  const memberSso   = [].concat(req.body.member_sso   || []);
  const tenantIds   = [].concat(req.body.tenant_ids   || []);

  const fail = (msg) => res.render('admin/email_report_form', {
    title: 'Edit Group', path: '/admin', error: msg, ...groupFormLocals(db),
    group: { ...existing, id: req.params.id, name, schedule, role, send_time, send_day, send_month_day, member_ids: [], tenant_ids: tenantIds.map(Number) },
  });

  if (!name) return fail('Name is required.');

  db.prepare('UPDATE email_report_groups SET name=?, schedule=?, role=?, send_time=?, send_day=?, send_month_day=? WHERE id=?').run(name, schedule, role, send_time, send_day, send_month_day, req.params.id);
  saveMembers(db, req.params.id, memberLocal, memberSso);
  saveGroupTenants(db, req.params.id, tenantIds);
  req.session.flash = `Group "${name}" updated.`;
  res.redirect('/admin/users');
});


router.post('/email-reports/:id/delete', (req, res) => {
  const db = getDb();
  const group = db.prepare('SELECT name FROM email_report_groups WHERE id = ?').get(req.params.id);
  db.prepare('DELETE FROM email_report_groups WHERE id = ?').run(req.params.id);
  req.session.flash = group ? `Email report group "${group.name}" deleted.` : 'Group deleted.';
  res.redirect('/admin/users');
});

router.post('/email-reports/:id/send', async (req, res) => {
  const db = getDb();
  const group = loadGroupWithMembers(db, req.params.id);
  if (!group) return res.status(404).json({ error: 'Not found' });

  const allowed = ['daily', 'weekly', 'monthly'];
  const period = allowed.includes(req.body.period) ? req.body.period : 'daily';
  try {
    const { sendGroupReport } = require('../reportMailer');
    const result = await sendGroupReport(group, db, period);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
