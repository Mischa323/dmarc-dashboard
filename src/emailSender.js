const nodemailer = require('nodemailer');
const fetch = require('node-fetch');
const msal = require('@azure/msal-node');

async function sendEmail({ transport, smtpConfig, graphTenant, from, to, subject, html }) {
  const recipients = Array.isArray(to) ? to : [to];
  if (!recipients.length) throw new Error('No recipients');

  if (transport === 'graph') {
    await _sendViaGraph({ graphTenant, from, recipients, subject, html });
  } else {
    await _sendViaSmtp({ smtpConfig, from, recipients, subject, html });
  }
}

async function _sendViaSmtp({ smtpConfig, from, recipients, subject, html }) {
  const auth = smtpConfig.user
    ? { user: smtpConfig.user, pass: smtpConfig.pass }
    : undefined;

  const transporter = nodemailer.createTransport({
    host: smtpConfig.host,
    port: Number(smtpConfig.port) || 587,
    secure: !!smtpConfig.secure,
    auth,
  });

  await transporter.sendMail({ from, to: recipients.join(', '), subject, html });
}

async function _sendViaGraph({ graphTenant, from, recipients, subject, html }) {
  const msalApp = new msal.ConfidentialClientApplication({
    auth: {
      clientId: graphTenant.client_id,
      clientSecret: graphTenant.client_secret,
      authority: `https://login.microsoftonline.com/${graphTenant.tenant_id}`,
    },
  });

  const result = await msalApp.acquireTokenByClientCredential({
    scopes: ['https://graph.microsoft.com/.default'],
  });
  if (!result || !result.accessToken) throw new Error('Graph token acquisition failed');

  const mailbox = from || graphTenant.mailbox;
  const body = {
    message: {
      subject,
      body: { contentType: 'HTML', content: html },
      toRecipients: recipients.map(addr => ({ emailAddress: { address: addr } })),
    },
    saveToSentItems: false,
  };

  const resp = await fetch(`https://graph.microsoft.com/v1.0/users/${mailbox}/sendMail`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${result.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Graph sendMail ${resp.status}: ${text}`);
  }
}

async function testSmtpConfig({ smtpConfig, from, to }) {
  const transporter = nodemailer.createTransport({
    host: smtpConfig.host,
    port: Number(smtpConfig.port) || 587,
    secure: !!smtpConfig.secure,
    auth: smtpConfig.user ? { user: smtpConfig.user, pass: smtpConfig.pass } : undefined,
  });
  await transporter.verify();
  await transporter.sendMail({
    from,
    to,
    subject: 'DMARC Dashboard — SMTP test',
    html: '<p>SMTP connection is working correctly.</p>',
  });
}

module.exports = { sendEmail, testSmtpConfig };
