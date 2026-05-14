const { XMLParser } = require('fast-xml-parser');

const parser = new XMLParser({
  ignoreAttributes: false,
  parseTagValue: true,
  trimValues: true,
  isArray: (name) => name === 'record',
});

function parseReport(xmlBuffer) {
  let root;
  try {
    const parsed = parser.parse(xmlBuffer.toString('utf8'));
    root = parsed.feedback;
    if (!root) return null;
  } catch {
    return null;
  }

  const meta = root.report_metadata;
  const policy = root.policy_published;
  if (!meta || !policy) return null;

  const beginTs = meta.date_range && meta.date_range.begin;
  const endTs = meta.date_range && meta.date_range.end;

  const report = {
    report_id: String(meta.report_id || ''),
    org_name: meta.org_name || '',
    org_email: meta.email || '',
    domain: policy.domain || '',
    begin_date: beginTs ? new Date(beginTs * 1000).toISOString() : null,
    end_date: endTs ? new Date(endTs * 1000).toISOString() : null,
    policy_p: policy.p || 'none',
    policy_sp: policy.sp || '',
    policy_pct: policy.pct != null ? policy.pct : 100,
    adkim: policy.adkim || 'r',
    aspf: policy.aspf || 'r',
    records: [],
  };

  for (const rec of root.record || []) {
    report.records.push(_parseRecord(rec));
  }

  return report;
}

function _parseRecord(rec) {
  const row = rec.row || {};
  const pe = row.policy_evaluated || {};
  const ids = rec.identifiers || {};
  const auth = rec.auth_results || {};

  const dkimRaw = auth.dkim;
  const dkim = Array.isArray(dkimRaw) ? dkimRaw[0] || {} : dkimRaw || {};
  const spf = auth.spf || {};

  return {
    source_ip: row.source_ip != null ? String(row.source_ip) : null,
    count: row.count || 1,
    disposition: pe.disposition || 'none',
    dkim_aligned: pe.dkim || 'fail',
    spf_aligned: pe.spf || 'fail',
    header_from: ids.header_from || null,
    envelope_from: ids.envelope_from || null,
    dkim_domain: dkim.domain || null,
    dkim_selector: dkim.selector || null,
    dkim_auth_result: dkim.result || null,
    spf_domain: spf.domain || null,
    spf_auth_result: spf.result || null,
  };
}

module.exports = { parseReport };
