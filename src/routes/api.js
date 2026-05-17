const express = require('express');
const { getDb } = require('../db');

const router = express.Router();

const DOMAIN_PALETTE = ['#0a84ff','#30d158','#bf5af2','#ff9f0a','#64d2ff','#ff6961','#5ac8fa','#ffd60a'];

router.get('/stats', (req, res) => {
  const days = Math.max(1, parseInt(req.query.days || '30', 10));
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const db = getDb();

  const isSso = req.session.userType === 'sso';
  const records = isSso
    ? db.prepare(`
        SELECT rec.*, rep.end_date, rep.org_name, rep.domain,
               t.color AS tenant_color, td.color AS domain_color
        FROM records rec
        JOIN reports rep ON rec.report_id = rep.id
        LEFT JOIN sso_tenants t ON rep.tenant_db_id = t.id
        LEFT JOIN tenant_domains td ON td.tenant_id = rep.tenant_db_id AND td.domain = rep.domain
        WHERE rep.end_date >= ? AND rep.tenant_db_id = ?
      `).all(since, req.session.tenantDbId)
    : db.prepare(`
        SELECT rec.*, rep.end_date, rep.org_name, rep.domain,
               t.color AS tenant_color, td.color AS domain_color
        FROM records rec
        JOIN reports rep ON rec.report_id = rep.id
        LEFT JOIN sso_tenants t ON rep.tenant_db_id = t.id
        LEFT JOIN tenant_domains td ON td.tenant_id = rep.tenant_db_id AND td.domain = rep.domain
        WHERE rep.end_date >= ?
      `).all(since);

  const isPass = r => r.dkim_aligned === 'pass' || r.spf_aligned === 'pass';

  const total       = records.reduce((s, r) => s + r.count, 0);
  const passed      = records.filter(isPass).reduce((s, r) => s + r.count, 0);
  const spfOnlyPass = records.filter(r => isPass(r) && r.dkim_aligned !== 'pass').reduce((s, r) => s + r.count, 0);

  // Aggregate daily trend + per-domain daily trend
  const daily       = {};
  const domainDaily = {};
  const domainColorSeen = {};

  for (const rec of records) {
    const date   = (rec.end_date || '').slice(0, 10);
    const domain = rec.domain || 'unknown';
    if (!daily[date]) daily[date] = { pass: 0, fail: 0 };
    if (!domainDaily[domain]) domainDaily[domain] = {};
    if (!domainDaily[domain][date]) domainDaily[domain][date] = { pass: 0, fail: 0 };

    if (isPass(rec)) { daily[date].pass += rec.count; domainDaily[domain][date].pass += rec.count; }
    else             { daily[date].fail += rec.count; domainDaily[domain][date].fail += rec.count; }

    if (!domainColorSeen[domain]) domainColorSeen[domain] = { tenant: rec.tenant_color || null, domain: rec.domain_color || null };
  }

  const allDates = Object.keys(daily).sort();

  const dailyTrend = allDates.map(date => ({ date, ...daily[date] }));

  // Assign palette colors to any domain without a tenant color
  const domainColors = {};
  let paletteIdx = 0;
  for (const domain of Object.keys(domainColorSeen)) {
    const tenantClr = domainColorSeen[domain].tenant || DOMAIN_PALETTE[paletteIdx++ % DOMAIN_PALETTE.length];
    const domainClr = domainColorSeen[domain].domain || tenantClr;
    domainColors[domain] = { tenant: tenantClr, domain: domainClr };
  }

  const domainTrends = {};
  for (const [domain, dateMap] of Object.entries(domainDaily)) {
    domainTrends[domain] = allDates.map(date => ({
      date,
      pass: dateMap[date]?.pass || 0,
      fail: dateMap[date]?.fail || 0,
    }));
  }

  // Failure reasons
  const failureReasons = { dkim_and_spf: 0, dkim_only: 0, spf_only: 0 };
  for (const rec of records) {
    if (isPass(rec)) continue;
    if (rec.dkim_aligned !== 'pass' && rec.spf_aligned !== 'pass') failureReasons.dkim_and_spf += rec.count;
    else if (rec.dkim_aligned !== 'pass') failureReasons.dkim_only += rec.count;
    else failureReasons.spf_only += rec.count;
  }

  // Top source IPs
  const ipMap = {};
  for (const rec of records) {
    const ip = rec.source_ip || 'unknown';
    if (!ipMap[ip]) ipMap[ip] = { pass: 0, fail: 0 };
    if (isPass(rec)) ipMap[ip].pass += rec.count;
    else ipMap[ip].fail += rec.count;
  }
  const topSources = Object.entries(ipMap)
    .map(([ip, v]) => ({ ip, ...v, total: v.pass + v.fail }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 15);

  // Top reporting orgs
  const orgMap = {};
  for (const rec of records) {
    const org = rec.org_name || 'Unknown';
    if (!orgMap[org]) orgMap[org] = { pass: 0, fail: 0 };
    if (isPass(rec)) orgMap[org].pass += rec.count;
    else orgMap[org].fail += rec.count;
  }
  const topOrgs = Object.entries(orgMap)
    .map(([org, v]) => ({ org, ...v, total: v.pass + v.fail }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 10);

  const totalReports = isSso
    ? db.prepare('SELECT COUNT(*) as cnt FROM reports WHERE end_date >= ? AND tenant_db_id = ?').get(since, req.session.tenantDbId).cnt
    : db.prepare('SELECT COUNT(*) as cnt FROM reports WHERE end_date >= ?').get(since).cnt;

  res.json({
    summary: {
      total_reports: totalReports,
      total_messages: total,
      pass_count: passed,
      fail_count: total - passed,
      pass_rate: total > 0 ? Math.round((passed / total) * 1000) / 10 : 0,
      unique_ips:    Object.keys(ipMap).length,
      spf_only_pass: spfOnlyPass,
    },
    daily_trend:     dailyTrend,
    domain_trends:   domainTrends,
    domain_colors:   domainColors,
    failure_reasons: failureReasons,
    top_sources:     topSources,
    top_orgs:        topOrgs,
  });
});

module.exports = router;
