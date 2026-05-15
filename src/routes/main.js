const express = require('express');
const { getDb } = require('../db');
const { getUserAccessToken } = require('../msalHelper');
const { fetchAndStore } = require('../fetcher');

const router = express.Router();

router.get('/', (req, res) => {
  res.render('dashboard', { title: 'Dashboard — DMARC', path: '/' });
});

router.get('/reports', (req, res) => {
  const db = getDb();
  const page = Math.max(1, parseInt(req.query.page || '1', 10));
  const domain = req.query.domain || '';
  const perPage = 25;
  const offset = (page - 1) * perPage;

  let where = '';
  const params = [];
  if (domain) { where = 'WHERE domain LIKE ?'; params.push(`%${domain}%`); }

  const total = db.prepare(`SELECT COUNT(*) as cnt FROM reports ${where}`).get(...params).cnt;
  const reports = db.prepare(`SELECT * FROM reports ${where} ORDER BY end_date DESC LIMIT ? OFFSET ?`).all(...params, perPage, offset);
  const domains = db.prepare('SELECT DISTINCT domain FROM reports ORDER BY domain').all().map(r => r.domain);

  let enriched = [];
  if (reports.length > 0) {
    const ph = reports.map(() => '?').join(',');
    const stats = db.prepare(`
      SELECT report_id,
        SUM(count) as total,
        SUM(CASE WHEN dkim_aligned='pass' OR spf_aligned='pass' THEN count ELSE 0 END) as passed
      FROM records WHERE report_id IN (${ph}) GROUP BY report_id
    `).all(...reports.map(r => r.id));
    const sm = {};
    for (const s of stats) sm[s.report_id] = s;
    enriched = reports.map(r => {
      const s = sm[r.id] || { total: 0, passed: 0 };
      const tot = s.total || 0, pass = s.passed || 0;
      return { ...r, total_messages: tot, passed_messages: pass, failed_messages: tot - pass, pass_rate: tot > 0 ? Math.round((pass / tot) * 1000) / 10 : 0 };
    });
  }

  // Build domain → color map from tenant colours
  const DOMAIN_PALETTE = ['#0a84ff','#30d158','#bf5af2','#ff9f0a','#64d2ff','#ff6961','#5ac8fa','#ffd60a'];
  const tenantRows = db.prepare(`
    SELECT td.domain, COALESCE(t.color, ?) AS color, t.id
    FROM tenant_domains td
    JOIN sso_tenants t ON td.tenant_id = t.id
  `).all(null);
  const domainColors = {};
  let pi = 0;
  for (const row of tenantRows) {
    domainColors[row.domain] = row.color || DOMAIN_PALETTE[pi++ % DOMAIN_PALETTE.length];
  }

  res.render('reports', { title: 'Reports — DMARC', path: '/reports', reports: enriched, domains, domainColors, selectedDomain: domain, page, totalPages: Math.ceil(total / perPage), total });
});

router.get('/reports/:id', (req, res) => {
  const db = getDb();
  const report = db.prepare('SELECT * FROM reports WHERE id = ?').get(req.params.id);
  if (!report) return res.status(404).render('error', { layout: 'layout', title: 'Not Found', message: 'Report not found.' });

  const records = db.prepare('SELECT * FROM records WHERE report_id = ? ORDER BY count DESC').all(report.id);
  const enrichedRecords = records.map(rec => ({
    ...rec,
    dmarc_pass: rec.dkim_aligned === 'pass' || rec.spf_aligned === 'pass',
    failure_reason: _failureReason(rec),
  }));
  const total = records.reduce((s, r) => s + r.count, 0);
  const passed = records.filter(r => r.dkim_aligned === 'pass' || r.spf_aligned === 'pass').reduce((s, r) => s + r.count, 0);

  res.render('report_detail', {
    title: `${report.domain} — DMARC Report`, path: '/reports',
    report: { ...report, records: enrichedRecords, total_messages: total, passed_messages: passed, failed_messages: total - passed, pass_rate: total > 0 ? Math.round((passed / total) * 1000) / 10 : 0 },
  });
});

router.post('/fetch', async (req, res) => {
  try {
    const db = getDb();
    let stored = 0;

    if (req.session.userType === 'sso') {
      const tenant = db.prepare('SELECT * FROM sso_tenants WHERE id = ? AND enabled = 1').get(req.session.tenantDbId);
      if (!tenant) return res.status(400).json({ error: 'Your tenant is not configured or disabled.' });
      const accessToken = await getUserAccessToken(tenant, req.session);
      stored = await fetchAndStore(tenant, accessToken);
    } else {
      // Local admin: fetch all enabled tenants via client credentials
      const tenants = db.prepare('SELECT * FROM sso_tenants WHERE enabled = 1').all();
      if (tenants.length === 0) return res.status(400).json({ error: 'No SSO tenants configured yet. Add one in Admin → Tenants.' });
      for (const tenant of tenants) stored += await fetchAndStore(tenant, null);
    }

    res.json({ stored });
  } catch (err) {
    if (err.code === 'interaction_required' || err.name === 'InteractionRequiredAuthError') {
      return res.status(401).json({ error: 'Session expired — please reload and sign in again.' });
    }
    res.status(500).json({ error: err.message });
  }
});

function _failureReason(rec) {
  if (rec.dkim_aligned === 'pass' || rec.spf_aligned === 'pass') return null;
  if (rec.dkim_aligned !== 'pass' && rec.spf_aligned !== 'pass') return 'dkim_and_spf';
  if (rec.dkim_aligned !== 'pass') return 'dkim_only';
  return 'spf_only';
}

module.exports = router;
