const msal  = require('@azure/msal-node');
const fetch = require('node-fetch');

async function syncTenantUsers(tenant, db) {
  const msalApp = new msal.ConfidentialClientApplication({
    auth: {
      clientId:     tenant.client_id,
      clientSecret: tenant.client_secret,
      authority:    `https://login.microsoftonline.com/${tenant.tenant_id}`,
    },
  });
  const result = await msalApp.acquireTokenByClientCredential({ scopes: ['https://graph.microsoft.com/.default'] });
  if (!result || !result.accessToken) throw new Error('Token acquisition failed');

  let url = 'https://graph.microsoft.com/v1.0/users?$select=displayName,mail,userPrincipalName&$filter=assignedLicenses/$count+ne+0&$count=true&$top=999';
  const allUsers = [];
  while (url) {
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${result.accessToken}`, ConsistencyLevel: 'eventual' } });
    if (!resp.ok) {
      let msg = `Graph API returned ${resp.status}`;
      try {
        const body = await resp.json();
        const code = body?.error?.code;
        const detail = body?.error?.message;
        if (code === 'Authorization_RequestDenied' || resp.status === 403) {
          msg = 'Permission denied — add the User.Read.All Application permission to your Azure App Registration and grant admin consent.';
        } else if (code === 'InvalidAuthenticationToken' || resp.status === 401) {
          msg = 'Authentication failed — check that the Client ID, Client Secret, and Tenant ID are correct.';
        } else if (detail) {
          msg = detail;
        }
      } catch {}
      throw new Error(msg);
    }
    const data = await resp.json();
    allUsers.push(...(data.value || []));
    url = data['@odata.nextLink'] || null;
  }

  const upsert = db.prepare(`
    INSERT INTO sso_users (email, display_name, tenant_db_id)
    VALUES (?, ?, ?)
    ON CONFLICT(email) DO UPDATE SET display_name = excluded.display_name, tenant_db_id = excluded.tenant_db_id
  `);
  let added = 0, updated = 0;
  const importedEmails = [];
  for (const u of allUsers) {
    const email = ((u.mail || u.userPrincipalName) || '').toLowerCase().trim();
    if (!email || !email.includes('@')) continue;
    const exists = db.prepare('SELECT id FROM sso_users WHERE email = ?').get(email);
    upsert.run(email, u.displayName || null, tenant.id);
    exists ? updated++ : added++;
    importedEmails.push(email);
  }

  let removed = 0;
  if (importedEmails.length > 0) {
    const placeholders = importedEmails.map(() => '?').join(',');
    const r = db.prepare(
      `DELETE FROM sso_users WHERE tenant_db_id = ? AND email NOT IN (${placeholders})`
    ).run(tenant.id, ...importedEmails);
    removed = r.changes;
  }

  return { added, updated, removed };
}

module.exports = { syncTenantUsers };
