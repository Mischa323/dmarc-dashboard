const { sendEmail } = require('./emailSender');
const { getSetting } = require('./db');

async function sendGroupReport(group, db, period) {
  const localEmails = db.prepare(`
    SELECT u.email FROM local_users u
    JOIN group_members gm ON gm.member_type = 'local' AND gm.member_id = u.id
    WHERE gm.group_id = ? AND u.email IS NOT NULL AND u.email != ''
  `).all(group.id).map(r => r.email);

  const ssoEmails = db.prepare(`
    SELECT u.email FROM sso_users u
    JOIN group_members gm ON gm.member_type = 'sso' AND gm.member_id = u.id
    WHERE gm.group_id = ? AND u.email IS NOT NULL AND u.email != ''
  `).all(group.id).map(r => r.email);

  const recipients = [...new Set([...localEmails, ...ssoEmails])];
  if (!recipients.length) return { skipped: true, reason: 'no members with email addresses' };

  const transport = getSetting(db, 'mail_transport', 'smtp');
  if (transport === 'smtp' && !getSetting(db, 'mail_smtp_host')) {
    return { skipped: true, reason: 'mail server not configured' };
  }
  if (transport === 'graph' && !getSetting(db, 'mail_graph_tenant_id')) {
    return { skipped: true, reason: 'Graph tenant not configured' };
  }

  const data = _gatherData(group, db, period);
  const html = _buildHtml(data, period, group.name);
  const label = period === 'daily' ? 'Daily' : period === 'weekly' ? 'Weekly' : 'Monthly';
  const subject = `DMARC ${label} Report — ${data.dateRange}`;

  let graphTenant = null;
  if (transport === 'graph') {
    const gid = parseInt(getSetting(db, 'mail_graph_tenant_id'));
    graphTenant = db.prepare('SELECT * FROM sso_tenants WHERE id = ?').get(gid);
  }

  await sendEmail({
    transport,
    smtpConfig: {
      host:   getSetting(db, 'mail_smtp_host'),
      port:   parseInt(getSetting(db, 'mail_smtp_port') || '587'),
      secure: getSetting(db, 'mail_smtp_secure') === '1',
      user:   getSetting(db, 'mail_smtp_user'),
      pass:   getSetting(db, 'mail_smtp_pass'),
    },
    graphTenant,
    from:       getSetting(db, 'mail_smtp_from') || (graphTenant && graphTenant.mailbox),
    to:         recipients,
    subject,
    html,
  });

  return { sent: true, recipients: recipients.length };
}

function _gatherData(group, db, period) {
  const days = period === 'daily' ? 1 : period === 'weekly' ? 7 : 30;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);

  let domainCond = '';
  let domainParams = [];
  const tenantIds = db.prepare('SELECT tenant_id FROM group_tenants WHERE group_id = ?').all(group.id).map(r => r.tenant_id);
  if (tenantIds.length > 0) {
    const domains = db.prepare(
      `SELECT DISTINCT domain FROM tenant_domains WHERE tenant_id IN (${tenantIds.map(() => '?').join(',')})`
    ).all(...tenantIds).map(r => r.domain);
    if (domains.length > 0) {
      domainCond = ` AND r.domain IN (${domains.map(() => '?').join(',')})`;
      domainParams = domains;
    }
  }

  const where = `WHERE DATE(r.end_date) >= ?${domainCond}`;
  const p = [since, ...domainParams];

  const stats = db.prepare(`
    SELECT
      COUNT(DISTINCT r.id)                                                                          AS total_reports,
      COALESCE(SUM(rec.count), 0)                                                                   AS total_messages,
      COALESCE(SUM(CASE WHEN rec.dkim_aligned='pass' OR  rec.spf_aligned='pass'  THEN rec.count ELSE 0 END), 0) AS passed,
      COALESCE(SUM(CASE WHEN rec.dkim_aligned!='pass' AND rec.spf_aligned!='pass' THEN rec.count ELSE 0 END), 0) AS failed
    FROM reports r LEFT JOIN records rec ON rec.report_id = r.id
    ${where}
  `).get(...p) || { total_reports: 0, total_messages: 0, passed: 0, failed: 0 };

  stats.pass_rate = stats.total_messages > 0
    ? Math.round((stats.passed / stats.total_messages) * 1000) / 10 : 0;

  const domainBreakdown = db.prepare(`
    SELECT r.domain,
      COALESCE(SUM(rec.count), 0) AS total,
      COALESCE(SUM(CASE WHEN rec.dkim_aligned='pass' OR rec.spf_aligned='pass' THEN rec.count ELSE 0 END), 0) AS passed
    FROM reports r LEFT JOIN records rec ON rec.report_id = r.id
    ${where}
    GROUP BY r.domain ORDER BY total DESC
  `).all(...p);

  const failingIps = db.prepare(`
    SELECT rec.source_ip,
      SUM(CASE WHEN rec.dkim_aligned!='pass' AND rec.spf_aligned!='pass' THEN rec.count ELSE 0 END) AS fail_count
    FROM records rec JOIN reports r ON r.id = rec.report_id
    ${where}
    GROUP BY rec.source_ip HAVING fail_count > 0 ORDER BY fail_count DESC LIMIT 10
  `).all(...p);

  const failingOrgs = db.prepare(`
    SELECT r.org_name,
      SUM(CASE WHEN rec.dkim_aligned!='pass' AND rec.spf_aligned!='pass' THEN rec.count ELSE 0 END) AS fail_count
    FROM records rec JOIN reports r ON r.id = rec.report_id
    ${where}
    GROUP BY r.org_name HAVING fail_count > 0 ORDER BY fail_count DESC LIMIT 10
  `).all(...p);

  const dateRange = period === 'daily' ? today : `${since} → ${today}`;
  return { stats, domainBreakdown, failingIps, failingOrgs, dateRange };
}

function _buildHtml(data, period, groupName) {
  const { stats, domainBreakdown, failingIps, failingOrgs, dateRange } = data;
  const rateColor = stats.pass_rate >= 98 ? '#30d158' : stats.pass_rate >= 90 ? '#ff9f0a' : '#ff453a';
  const label = period === 'daily' ? 'Daily' : period === 'weekly' ? 'Weekly' : 'Monthly';

  const domainRows = domainBreakdown.map(d => {
    const rate = d.total > 0 ? Math.round((d.passed / d.total) * 1000) / 10 : 0;
    const c = rate >= 98 ? '#30d158' : rate >= 90 ? '#ff9f0a' : '#ff453a';
    return `<tr>
      <td style="padding:8px 12px;border-bottom:1px solid #1e1e1e;">${esc(d.domain)}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #1e1e1e;text-align:right;">${d.total.toLocaleString()}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #1e1e1e;text-align:right;color:#30d158;">${d.passed.toLocaleString()}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #1e1e1e;text-align:right;color:#ff453a;">${(d.total - d.passed).toLocaleString()}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #1e1e1e;text-align:right;font-weight:600;color:${c};">${rate}%</td>
    </tr>`;
  }).join('');

  const ipRows = failingIps.slice(0, 5).map(ip => `<tr>
    <td style="padding:6px 12px;border-bottom:1px solid #1e1e1e;font-family:monospace;font-size:13px;">${esc(ip.source_ip)}</td>
    <td style="padding:6px 12px;border-bottom:1px solid #1e1e1e;text-align:right;color:#ff453a;">${ip.fail_count.toLocaleString()}</td>
  </tr>`).join('');

  const orgRows = failingOrgs.slice(0, 5).map(o => `<tr>
    <td style="padding:6px 12px;border-bottom:1px solid #1e1e1e;">${esc(o.org_name || '—')}</td>
    <td style="padding:6px 12px;border-bottom:1px solid #1e1e1e;text-align:right;color:#ff453a;">${o.fail_count.toLocaleString()}</td>
  </tr>`).join('');

  const cell = (lbl, value, color = '#fff', border = '#1e1e1e') => `
    <td style="padding:0 6px 0 0;">
      <div style="background:#111;border:1px solid ${border};border-radius:10px;padding:14px 16px;text-align:center;min-width:110px;">
        <div style="font-size:10px;color:#555;text-transform:uppercase;margin-bottom:4px;">${lbl}</div>
        <div style="font-size:22px;font-weight:700;color:${color};">${value}</div>
      </div>
    </td>`;

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,sans-serif;color:#e0e0e0;">
<div style="max-width:600px;margin:32px auto;padding:0 12px;">

  <div style="background:linear-gradient(135deg,#0d0d1f 0%,#0a0a14 100%);border:1px solid #1e1e1e;border-radius:16px;padding:28px 28px 20px;margin-bottom:12px;text-align:center;">
    <div style="font-size:32px;margin-bottom:6px;">📊</div>
    <h1 style="margin:0 0 4px;font-size:20px;font-weight:700;color:#fff;">DMARC ${label} Report</h1>
    <p style="margin:0 0 2px;font-size:13px;color:#555;">${esc(groupName)}</p>
    <p style="margin:0;font-size:12px;color:#444;">${esc(dateRange)}</p>
  </div>

  <table style="width:100%;border-collapse:collapse;margin-bottom:12px;"><tr>
    ${cell('Reports', stats.total_reports)}
    ${cell('Messages', stats.total_messages.toLocaleString())}
    ${cell('Passed', stats.passed.toLocaleString(), '#30d158', 'rgba(48,209,88,.25)')}
    ${cell('Failed', stats.failed.toLocaleString(), '#ff453a', 'rgba(255,69,58,.25)')}
  </tr></table>

  <div style="background:#111;border:1px solid #1e1e1e;border-radius:12px;padding:20px;margin-bottom:12px;text-align:center;">
    <div style="font-size:11px;color:#555;text-transform:uppercase;margin-bottom:6px;">DMARC Pass Rate</div>
    <div style="font-size:44px;font-weight:700;color:${rateColor};">${stats.pass_rate}%</div>
  </div>

  ${domainBreakdown.length > 0 ? `
  <div style="background:#111;border:1px solid #1e1e1e;border-radius:12px;margin-bottom:12px;overflow:hidden;">
    <div style="padding:12px 16px;border-bottom:1px solid #1e1e1e;"><b style="font-size:13px;color:#fff;">Domain Breakdown</b></div>
    <table style="width:100%;border-collapse:collapse;">
      <thead><tr style="background:#0d0d0d;">
        <th style="padding:8px 12px;text-align:left;font-size:10px;color:#555;text-transform:uppercase;">Domain</th>
        <th style="padding:8px 12px;text-align:right;font-size:10px;color:#555;text-transform:uppercase;">Total</th>
        <th style="padding:8px 12px;text-align:right;font-size:10px;color:#555;text-transform:uppercase;">Passed</th>
        <th style="padding:8px 12px;text-align:right;font-size:10px;color:#555;text-transform:uppercase;">Failed</th>
        <th style="padding:8px 12px;text-align:right;font-size:10px;color:#555;text-transform:uppercase;">Rate</th>
      </tr></thead>
      <tbody>${domainRows}</tbody>
    </table>
  </div>` : ''}

  ${failingIps.length > 0 ? `
  <div style="background:#111;border:1px solid rgba(255,69,58,.2);border-radius:12px;margin-bottom:12px;overflow:hidden;">
    <div style="padding:12px 16px;border-bottom:1px solid #1e1e1e;"><b style="font-size:13px;color:#ff453a;">⚠ Top Failing Source IPs</b></div>
    <table style="width:100%;border-collapse:collapse;">
      <thead><tr style="background:#0d0d0d;">
        <th style="padding:8px 12px;text-align:left;font-size:10px;color:#555;text-transform:uppercase;">IP Address</th>
        <th style="padding:8px 12px;text-align:right;font-size:10px;color:#555;text-transform:uppercase;">Failed</th>
      </tr></thead>
      <tbody>${ipRows}</tbody>
    </table>
  </div>` : ''}

  ${failingOrgs.length > 0 ? `
  <div style="background:#111;border:1px solid rgba(255,159,10,.2);border-radius:12px;margin-bottom:12px;overflow:hidden;">
    <div style="padding:12px 16px;border-bottom:1px solid #1e1e1e;"><b style="font-size:13px;color:#ff9f0a;">📮 Reporting Orgs with Failures</b></div>
    <table style="width:100%;border-collapse:collapse;">
      <thead><tr style="background:#0d0d0d;">
        <th style="padding:8px 12px;text-align:left;font-size:10px;color:#555;text-transform:uppercase;">Organisation</th>
        <th style="padding:8px 12px;text-align:right;font-size:10px;color:#555;text-transform:uppercase;">Failed</th>
      </tr></thead>
      <tbody>${orgRows}</tbody>
    </table>
  </div>` : ''}

  <p style="text-align:center;font-size:11px;color:#333;margin:20px 0 0;">Sent by DMARC Dashboard &middot; Automated report</p>
</div>
</body></html>`;
}

function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

module.exports = { sendGroupReport };
