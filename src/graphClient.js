const msal = require('@azure/msal-node');
const fetch = require('node-fetch');
const zlib = require('zlib');
const AdmZip = require('adm-zip');

const GRAPH_URL = 'https://graph.microsoft.com/v1.0';

class GraphClient {
  constructor(options) {
    if (options.accessToken) {
      // Delegated: caller provides a ready access token
      this._getToken = async () => options.accessToken;
    } else {
      // App-only: client credentials flow (used by scheduler)
      const msalApp = new msal.ConfidentialClientApplication({
        auth: {
          clientId: options.clientId,
          clientSecret: options.clientSecret,
          authority: `https://login.microsoftonline.com/${options.tenantId}`,
        },
      });
      this._getToken = async () => {
        const result = await msalApp.acquireTokenByClientCredential({
          scopes: ['https://graph.microsoft.com/.default'],
        });
        if (!result || !result.accessToken) throw new Error('Token acquisition failed');
        return result.accessToken;
      };
    }
  }

  async _headers() {
    return { Authorization: `Bearer ${await this._getToken()}` };
  }

  async getDmarcMessages(mailbox, folder = 'Inbox', limit = 100) {
    // $filter and $orderby cannot be combined on mail endpoints (InefficientFilter).
    // Filter by hasAttachments here; receivedDateTime sort is done client-side.
    const params = new URLSearchParams({
      $top: limit,
      $select: 'id,subject,receivedDateTime,from,hasAttachments',
      $filter: 'hasAttachments eq true',
    });
    const url = `${GRAPH_URL}/users/${mailbox}/mailFolders/${folder}/messages?${params}`;
    const resp = await fetch(url, { headers: await this._headers(), timeout: 30000 });
    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Graph API ${resp.status}: ${body}`);
    }
    const data = await resp.json();
    return (data.value || [])
      .filter(m => _isDmarcSubject(m.subject || ''))
      .sort((a, b) => new Date(b.receivedDateTime) - new Date(a.receivedDateTime));
  }

  async getXmlAttachments(mailbox, messageId) {
    const url = `${GRAPH_URL}/users/${mailbox}/messages/${messageId}/attachments`;
    const resp = await fetch(url, { headers: await this._headers(), timeout: 30000 });
    if (!resp.ok) throw new Error(`Graph API ${resp.status}`);
    const data = await resp.json();

    const xmlPayloads = [];
    for (const att of data.value || []) {
      const name = (att.name || '').toLowerCase();
      const raw = Buffer.from(att.contentBytes || '', 'base64');
      if (name.endsWith('.xml')) {
        xmlPayloads.push(raw);
      } else if (name.endsWith('.gz')) {
        xmlPayloads.push(zlib.gunzipSync(raw));
      } else if (name.endsWith('.zip')) {
        const zip = new AdmZip(raw);
        for (const entry of zip.getEntries()) {
          if (entry.entryName.toLowerCase().endsWith('.xml')) {
            xmlPayloads.push(entry.getData());
          }
        }
      }
    }
    return xmlPayloads;
  }
}

function _isDmarcSubject(subject) {
  const s = subject.toLowerCase();
  return ['dmarc', 'report domain:', 'aggregate report'].some(kw => s.includes(kw));
}

module.exports = { GraphClient };
