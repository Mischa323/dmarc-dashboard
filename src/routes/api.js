const express = require('express');
const { getDb } = require('../db');

const router = express.Router();

router.get('/stats', (req, res) => {
  const days = Math.max(1, parseInt(req.query.days || '30', 10));
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const db = getDb();

  const records = db.prepare(`
    SELECT rec.*, rep.end_date, rep.org_name
    FROM records rec
    JOIN reports rep ON rec.report_id = rep.id
    WHERE rep.end_date >= ?
  `).all(since);

  const isPass = r => r.dkim_aligned === 'pass' || r.spf_aligned === 'pass';

  const total = records.reduce((s, r) => s + r.count, 0);
  const passed = records.filter(isPass).reduce((s, r) => s + r.count, 0);

  // Daily trend
  const daily = {};
  for (const rec of records) {
    const date = (rec.end_date || '').slice(0, 10);
    if (!daily[date]) daily[date] = { pass: 0, fail: 0 };
    if (isPass(rec)) daily[date].pass += rec.count;
    else daily[date].fail += rec.count;
  }
  const dailyTrend = Object.entries(daily)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, v]) => ({ date, ...v }));

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

  const totalReports = db.prepare('SELECT COUNT(*) as cnt FROM reports WHERE end_date >= ?').get(since).cnt;

  res.json({
    summary: {
      total_reports: totalReports,
      total_messages: total,
      pass_count: passed,
      fail_count: total - passed,
      pass_rate: total > 0 ? Math.round((passed / total) * 1000) / 10 : 0,
      unique_ips: Object.keys(ipMap).length,
    },
    daily_trend: dailyTrend,
    failure_reasons: failureReasons,
    top_sources: topSources,
    top_orgs: topOrgs,
  });
});

module.exports = router;
