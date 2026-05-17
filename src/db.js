const Database = require('better-sqlite3');
const path = require('path');

let _db = null;

function getDb() {
  if (!_db) {
    const dbPath = process.env.DATABASE_URL || 'dmarc.db';
    _db = new Database(path.resolve(dbPath));
    _db.pragma('journal_mode = WAL');
    _db.pragma('foreign_keys = ON');
    _createSchema(_db);
    _migrate(_db);
  }
  return _db;
}

function _createSchema(db) {
  db.exec(`
    -- Auth
    CREATE TABLE IF NOT EXISTS local_users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      totp_secret   TEXT,
      totp_enabled  INTEGER DEFAULT 0,
      role          TEXT DEFAULT 'local_admin',
      created_at    TEXT DEFAULT (datetime('now'))
    );

    -- SSO tenants (one per Azure app registration)
    CREATE TABLE IF NOT EXISTS sso_tenants (
      id                       INTEGER PRIMARY KEY AUTOINCREMENT,
      name                     TEXT NOT NULL,
      tenant_id                TEXT NOT NULL,
      client_id                TEXT NOT NULL,
      client_secret            TEXT NOT NULL,
      redirect_uri             TEXT NOT NULL,
      mailbox                  TEXT NOT NULL,
      mail_folder              TEXT DEFAULT 'Inbox',
      fetch_interval_minutes   INTEGER DEFAULT 60,
      fetch_interval_override  INTEGER,
      enabled                  INTEGER DEFAULT 1,
      created_at               TEXT DEFAULT (datetime('now'))
    );

    -- SSO users (auto-created on first login)
    CREATE TABLE IF NOT EXISTS sso_users (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_db_id    INTEGER REFERENCES sso_tenants(id) ON DELETE SET NULL,
      email           TEXT UNIQUE NOT NULL,
      display_name    TEXT,
      home_account_id TEXT,
      role            TEXT DEFAULT 'viewer',
      last_login      TEXT,
      created_at      TEXT DEFAULT (datetime('now'))
    );

    -- DMARC data
    CREATE TABLE IF NOT EXISTS reports (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      report_id        TEXT UNIQUE NOT NULL,
      org_name         TEXT,
      org_email        TEXT,
      domain           TEXT,
      begin_date       TEXT,
      end_date         TEXT,
      policy_p         TEXT,
      policy_sp        TEXT,
      policy_pct       INTEGER,
      adkim            TEXT,
      aspf             TEXT,
      email_message_id TEXT,
      tenant_db_id     INTEGER REFERENCES sso_tenants(id) ON DELETE SET NULL,
      fetched_at       TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_reports_domain   ON reports(domain);
    CREATE INDEX IF NOT EXISTS idx_reports_end_date ON reports(end_date);

    CREATE TABLE IF NOT EXISTS records (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      report_id        INTEGER NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
      source_ip        TEXT,
      count            INTEGER DEFAULT 1,
      disposition      TEXT,
      dkim_aligned     TEXT,
      spf_aligned      TEXT,
      header_from      TEXT,
      envelope_from    TEXT,
      dkim_domain      TEXT,
      dkim_selector    TEXT,
      dkim_auth_result TEXT,
      spf_domain       TEXT,
      spf_auth_result  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_records_report_id ON records(report_id);

    -- Per-tenant domains (one tenant can protect multiple domains)
    CREATE TABLE IF NOT EXISTS tenant_domains (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id    INTEGER NOT NULL REFERENCES sso_tenants(id) ON DELETE CASCADE,
      domain       TEXT NOT NULL,
      dmarc_policy TEXT DEFAULT 'none',
      created_at   TEXT DEFAULT (datetime('now')),
      UNIQUE(tenant_id, domain)
    );
    CREATE INDEX IF NOT EXISTS idx_tenant_domains_tenant ON tenant_domains(tenant_id);

    -- Global key/value settings
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- Email report groups (transport + schedule are global settings)
    CREATE TABLE IF NOT EXISTS email_report_groups (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      name             TEXT NOT NULL,
      domains_filter   TEXT DEFAULT 'all',
      enabled          INTEGER DEFAULT 1,
      last_sent_daily  TEXT,
      last_sent_weekly TEXT,
      created_at       TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS email_report_recipients (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id INTEGER NOT NULL REFERENCES email_report_groups(id) ON DELETE CASCADE,
      email    TEXT NOT NULL,
      UNIQUE(group_id, email)
    );

    CREATE TABLE IF NOT EXISTS group_members (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id    INTEGER NOT NULL REFERENCES email_report_groups(id) ON DELETE CASCADE,
      member_type TEXT NOT NULL,
      member_id   INTEGER NOT NULL,
      UNIQUE(group_id, member_type, member_id)
    );

    CREATE TABLE IF NOT EXISTS group_tenants (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id  INTEGER NOT NULL REFERENCES email_report_groups(id) ON DELETE CASCADE,
      tenant_id INTEGER NOT NULL REFERENCES sso_tenants(id) ON DELETE CASCADE,
      UNIQUE(group_id, tenant_id)
    );

    -- System activity log (rolling window, trimmed to 1000 entries)
    CREATE TABLE IF NOT EXISTS admin_logs (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT DEFAULT (datetime('now')),
      level      TEXT NOT NULL DEFAULT 'info',
      category   TEXT NOT NULL DEFAULT 'system',
      message    TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_admin_logs_id ON admin_logs(id DESC);
  `);
}

function _migrate(db) {
  // local_users
  const localCols = db.pragma('table_info(local_users)').map(c => c.name);
  if (!localCols.includes('totp_secret'))  db.exec('ALTER TABLE local_users ADD COLUMN totp_secret TEXT');
  if (!localCols.includes('totp_enabled')) db.exec('ALTER TABLE local_users ADD COLUMN totp_enabled INTEGER DEFAULT 0');
  if (!localCols.includes('role'))         db.exec("ALTER TABLE local_users ADD COLUMN role TEXT DEFAULT 'local_admin'");
  if (!localCols.includes('email'))          db.exec('ALTER TABLE local_users ADD COLUMN email TEXT');
  if (!localCols.includes('invite_token'))   db.exec('ALTER TABLE local_users ADD COLUMN invite_token TEXT');
  if (!localCols.includes('invite_expires')) db.exec('ALTER TABLE local_users ADD COLUMN invite_expires TEXT');

  // email_report_groups
  const groupCols = db.pragma('table_info(email_report_groups)').map(c => c.name);
  if (!groupCols.includes('email_notifications')) db.exec('ALTER TABLE email_report_groups ADD COLUMN email_notifications INTEGER DEFAULT 0');
  if (!groupCols.includes('schedule'))            db.exec("ALTER TABLE email_report_groups ADD COLUMN schedule TEXT DEFAULT 'none'");
  if (!groupCols.includes('role'))                db.exec("ALTER TABLE email_report_groups ADD COLUMN role TEXT DEFAULT 'viewer'");
  if (!groupCols.includes('send_time'))           db.exec("ALTER TABLE email_report_groups ADD COLUMN send_time TEXT DEFAULT '08:00'");
  if (!groupCols.includes('send_day'))            db.exec('ALTER TABLE email_report_groups ADD COLUMN send_day INTEGER DEFAULT 1');
  if (!groupCols.includes('send_month_day'))      db.exec('ALTER TABLE email_report_groups ADD COLUMN send_month_day INTEGER DEFAULT 1');

  // sso_tenants
  const tenantCols = db.pragma('table_info(sso_tenants)').map(c => c.name);
  if (!tenantCols.includes('sso_enabled'))             db.exec('ALTER TABLE sso_tenants ADD COLUMN sso_enabled INTEGER DEFAULT 1');
  if (!tenantCols.includes('domain'))                  db.exec('ALTER TABLE sso_tenants ADD COLUMN domain TEXT DEFAULT ""');
  if (!tenantCols.includes('dmarc_policy'))            db.exec("ALTER TABLE sso_tenants ADD COLUMN dmarc_policy TEXT DEFAULT 'none'");
  if (!tenantCols.includes('fetch_interval_override')) db.exec('ALTER TABLE sso_tenants ADD COLUMN fetch_interval_override INTEGER');
  if (!tenantCols.includes('color'))                   db.exec('ALTER TABLE sso_tenants ADD COLUMN color TEXT');

  // reports
  if (!db.pragma('table_info(reports)').map(c => c.name).includes('tenant_db_id')) {
    try { db.exec('ALTER TABLE reports ADD COLUMN tenant_db_id INTEGER REFERENCES sso_tenants(id) ON DELETE SET NULL'); } catch {}
  }

  // Migrate single domain/dmarc_policy from sso_tenants → tenant_domains
  try {
    const migrate = db.prepare(
      "INSERT OR IGNORE INTO tenant_domains (tenant_id, domain, dmarc_policy) VALUES (?, ?, ?)"
    );
    db.prepare("SELECT id, domain, dmarc_policy FROM sso_tenants WHERE domain IS NOT NULL AND domain != ''")
      .all().forEach(t => migrate.run(t.id, t.domain, t.dmarc_policy || 'none'));
  } catch { /* ignore if columns don't exist yet */ }

  // Seed default global settings
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('fetch_interval_minutes', '60')").run();
}

function getSetting(db, key, defaultValue = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : defaultValue;
}

function setSetting(db, key, value) {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, String(value));
}

function purgeOldReports(db, days) {
  const d = parseInt(days, 10);
  if (!d || d <= 0) return 0;
  const result = db.prepare(
    `DELETE FROM reports WHERE end_date < datetime('now', ?)`
  ).run(`-${d} days`);
  return result.changes;
}

function getDbPath() {
  return path.resolve(process.env.DATABASE_URL || 'dmarc.db');
}

function _reset() {
  if (_db) { try { _db.close(); } catch { /* ignore */ } }
  _db = null;
}

module.exports = { getDb, getSetting, setSetting, purgeOldReports, getDbPath, _reset };
