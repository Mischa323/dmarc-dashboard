const { getDb } = require('./db');
const { GraphClient } = require('./graphClient');
const { parseReport } = require('./dmarcParser');

async function fetchAndStore(tenant, accessToken = null) {
  const client = new GraphClient(
    accessToken
      ? { accessToken }
      : { tenantId: tenant.tenant_id, clientId: tenant.client_id, clientSecret: tenant.client_secret }
  );
  const db = getDb();
  const insertReport = db.prepare(`
    INSERT INTO reports
      (report_id, org_name, org_email, domain, begin_date, end_date,
       policy_p, policy_sp, policy_pct, adkim, aspf, email_message_id, tenant_db_id)
    VALUES
      (@report_id, @org_name, @org_email, @domain, @begin_date, @end_date,
       @policy_p, @policy_sp, @policy_pct, @adkim, @aspf, @email_message_id, @tenant_db_id)
  `);
  const insertRecord = db.prepare(`
    INSERT INTO records
      (report_id, source_ip, count, disposition, dkim_aligned, spf_aligned,
       header_from, envelope_from, dkim_domain, dkim_selector, dkim_auth_result,
       spf_domain, spf_auth_result)
    VALUES
      (@report_id, @source_ip, @count, @disposition, @dkim_aligned, @spf_aligned,
       @header_from, @envelope_from, @dkim_domain, @dkim_selector, @dkim_auth_result,
       @spf_domain, @spf_auth_result)
  `);

  const messages = await client.getDmarcMessages(tenant.mailbox, tenant.mail_folder);
  let stored = 0;

  for (const msg of messages) {
    const msgId = msg.id;
    if (db.prepare('SELECT id FROM reports WHERE email_message_id = ?').get(msgId)) continue;

    const xmlPayloads = await client.getXmlAttachments(tenant.mailbox, msgId);
    for (const xml of xmlPayloads) {
      const data = parseReport(xml);
      if (!data) { console.warn(`Failed to parse XML from message ${msgId}`); continue; }
      if (db.prepare('SELECT id FROM reports WHERE report_id = ?').get(data.report_id)) continue;

      db.transaction(() => {
        const { lastInsertRowid } = insertReport.run({ ...data, email_message_id: msgId, tenant_db_id: tenant.id });
        for (const rec of data.records) insertRecord.run({ ...rec, report_id: lastInsertRowid });
      })();
      stored++;
      console.log(`[fetch] Stored report ${data.report_id} from ${data.org_name} (tenant: ${tenant.name})`);
    }
  }
  return stored;
}

module.exports = { fetchAndStore };
