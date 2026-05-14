const { ConfidentialClientApplication } = require('@azure/msal-node');
const fetch = require('node-fetch');
const dns   = require('dns').promises;

const GRAPH = 'https://graph.microsoft.com/v1.0';

/**
 * Runs all connectivity checks for a tenant.
 * Returns { checks: [{ label, ok, detail?, error? }] }
 */
async function testTenantConnection(tenant) {
  const checks = [];

  // ── 1. Acquire client-credentials token ────────────────────────────────────
  let accessToken;
  try {
    const app = new ConfidentialClientApplication({
      auth: {
        clientId:     tenant.client_id,
        clientSecret: tenant.client_secret,
        authority:    `https://login.microsoftonline.com/${tenant.tenant_id}`,
      },
    });
    const result = await app.acquireTokenByClientCredential({
      scopes: ['https://graph.microsoft.com/.default'],
    });
    if (!result || !result.accessToken) throw new Error('No access token returned.');
    accessToken = result.accessToken;
    checks.push({ label: 'Azure credentials', ok: true, detail: 'Token acquired successfully.' });
  } catch (err) {
    checks.push({ label: 'Azure credentials', ok: false, error: credentialMessage(err) });
    // Can't continue without a token — but still run DNS checks independently
    const domains = tenant.domains || [];
    if (domains.length === 0) {
      checks.push({ label: 'DMARC DNS record', ok: null, detail: 'No domains configured — skipped.' });
    } else {
      for (const d of domains) {
        for (const c of await checkDns(d.domain, tenant.mailbox)) checks.push(c);
      }
    }
    return { checks };
  }

  // ── 2. Verify mailbox access ────────────────────────────────────────────────
  const folder = encodeURIComponent(tenant.mail_folder || 'Inbox');
  const url    = `${GRAPH}/users/${encodeURIComponent(tenant.mailbox)}/mailFolders/${folder}`;
  try {
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      timeout: 12000,
    });

    if (resp.ok) {
      checks.push({ label: 'Mailbox access (Mail.Read)', ok: true, detail: `Mailbox "${tenant.mailbox}" is accessible.` });
    } else {
      checks.push({ label: 'Mailbox access (Mail.Read)', ok: false, error: await graphError(resp, tenant.mailbox) });
    }
  } catch (err) {
    checks.push({ label: 'Mailbox access (Mail.Read)', ok: false, error: 'Network error reaching Microsoft Graph: ' + err.message });
  }

  // ── 3. DNS check per domain ────────────────────────────────────────────────
  const domains = tenant.domains || [];
  if (domains.length === 0) {
    checks.push({ label: 'DMARC DNS record', ok: null, detail: 'No domains configured — skipped.' });
  } else {
    for (const d of domains) {
      for (const c of await checkDns(d.domain, tenant.mailbox)) checks.push(c);
    }
  }

  return { checks };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Checks the DMARC DNS record for a domain and returns an array of check objects.
 * May return more than one check when rua points to a different domain
 * (cross-domain reporting requires an extra authorization record).
 */
async function checkDns(domain, mailbox) {
  const host = `_dmarc.${domain}`;
  let dmarc;

  try {
    const records = await dns.resolveTxt(host);
    const txts    = records.map(r => r.join(''));
    dmarc = txts.find(r => r.trim().toUpperCase().startsWith('V=DMARC1'));

    if (!dmarc) {
      return [{
        label: `DMARC DNS — ${domain}`,
        ok: false,
        error: `TXT records exist at ${host} but none start with v=DMARC1. Found: ${txts.join(' | ')}`,
      }];
    }
  } catch (err) {
    if (['ENOTFOUND', 'ENODATA', 'ESERVFAIL', 'ENONAME'].includes(err.code)) {
      return [{
        label: `DMARC DNS — ${domain}`,
        ok: false,
        error: `No TXT record found at ${host}. Add the DMARC TXT record to your DNS and wait for propagation.`,
      }];
    }
    return [{
      label: `DMARC DNS — ${domain}`,
      ok: false,
      error: `DNS lookup failed for ${host}: ${err.message}`,
    }];
  }

  // Parse tags — split on ; and trim whitespace
  const tags = {};
  dmarc.split(';').forEach(part => {
    const eq = part.indexOf('=');
    if (eq !== -1) tags[part.slice(0, eq).trim().toLowerCase()] = part.slice(eq + 1).trim();
  });

  if (!tags.rua) {
    const suggest = mailbox ? `rua=mailto:${mailbox}` : 'rua=mailto:dmarc@yourdomain.com';
    return [{
      label: `DMARC DNS — ${domain}`,
      ok: 'warn',
      detail: dmarc,
      error: `Record found but the rua tag is missing — mail servers won't know where to send aggregate reports. Add ${suggest} to the record.`,
    }];
  }

  const results = [{ label: `DMARC DNS — ${domain}`, ok: true, detail: dmarc }];

  // ── Cross-domain reporting authorization check ──────────────────────────────
  // If rua points to a different domain, that domain must publish an authorization
  // record at: <monitored-domain>._report._dmarc.<rua-domain>  (RFC 7489 §7.1)
  const ruaAddresses = tags.rua.split(',').map(s => s.trim());
  for (const rua of ruaAddresses) {
    const match = rua.match(/^mailto:[^@]+@(.+)$/i);
    if (!match) continue;
    const ruaDomain = match[1].toLowerCase().trim();
    if (ruaDomain === domain.toLowerCase()) continue; // same domain — no auth record needed

    const authHost = `${domain}._report._dmarc.${ruaDomain}`;
    try {
      const authRecords = await dns.resolveTxt(authHost);
      const authTxts    = authRecords.map(r => r.join(''));
      const authorized  = authTxts.some(r => r.trim().toUpperCase().startsWith('V=DMARC1'));

      if (authorized) {
        results.push({
          label: `Cross-domain auth — ${ruaDomain}`,
          ok: true,
          detail: `${ruaDomain} is authorized to receive reports for ${domain} (record found at ${authHost}).`,
        });
      } else {
        results.push({
          label: `Cross-domain auth — ${ruaDomain}`,
          ok: 'warn',
          detail: authTxts.join(' | '),
          error: `A record exists at ${authHost} but it doesn't start with v=DMARC1 — it may not be recognized as a valid authorization.`,
        });
      }
    } catch (err) {
      if (['ENOTFOUND', 'ENODATA', 'ESERVFAIL', 'ENONAME'].includes(err.code)) {
        results.push({
          label: `Cross-domain auth — ${ruaDomain}`,
          ok: 'warn',
          error: `rua points to ${ruaDomain} but no authorization record was found. `
            + `Add a TXT record to ${ruaDomain}'s DNS:\n`
            + `  Name:  ${authHost}\n`
            + `  Value: v=DMARC1;\n`
            + `This tells mail servers that ${ruaDomain} accepts DMARC reports for ${domain}.`,
        });
      } else {
        results.push({
          label: `Cross-domain auth — ${ruaDomain}`,
          ok: false,
          error: `DNS lookup failed for ${authHost}: ${err.message}`,
        });
      }
    }
  }

  return results;
}

async function graphError(resp, mailbox) {
  const body   = await resp.json().catch(() => ({}));
  const code   = body.error?.code    || '';
  const detail = firstLine(body.error?.message || resp.statusText);

  if (resp.status === 401) {
    return 'Token rejected by Microsoft Graph. Verify your Client ID and Secret are correct.';
  }
  if (resp.status === 403) {
    const isConsent = code === 'Authorization_RequestDenied' || detail.toLowerCase().includes('consent');
    return isConsent
      ? 'Admin consent not granted. In Azure Portal → App registrations → API permissions, grant admin consent for the Mail.Read Application permission.'
      : `Access denied (${code || 403}): ${detail}. Make sure the app has Mail.Read Application permission with admin consent.`;
  }
  if (resp.status === 404) {
    if (code === 'MailboxNotEnabledForRESTAPI' || detail.includes('REST API')) {
      return `Mailbox "${mailbox}" is not enabled for Microsoft Graph (requires an Exchange Online licence).`;
    }
    return `Mailbox "${mailbox}" not found. Verify the email address exists in this tenant.`;
  }
  return `Graph API returned ${resp.status}: ${detail}`;
}

function credentialMessage(err) {
  const msg = err.message || '';
  if (msg.includes('AADSTS90002'))   return 'Tenant not found. Check your Tenant ID.';
  if (msg.includes('AADSTS700016'))  return 'Application not found in this tenant. Check your Client ID and Tenant ID.';
  if (msg.includes('AADSTS7000215')) return 'Invalid client secret. Generate a new one in Azure (Certificates & secrets).';
  if (msg.includes('AADSTS700082'))  return 'Client secret has expired. Generate a new one in Azure (Certificates & secrets).';
  if (msg.includes('AADSTS70011'))   return 'Invalid scope. Verify the app registration is configured correctly.';
  return 'Authentication failed: ' + firstLine(err.errorMessage || msg);
}

function firstLine(s) {
  return (s || '').split(/[\r\n]/)[0].trim();
}

module.exports = { testTenantConnection };
