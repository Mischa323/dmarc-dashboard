const msal = require('@azure/msal-node');

const AUTH_SCOPES = [
  'openid', 'profile', 'email', 'offline_access',
  'https://graph.microsoft.com/Mail.Read',
];

const GRAPH_SCOPES = ['https://graph.microsoft.com/Mail.Read'];

function createMsalInstance(tenant) {
  return new msal.ConfidentialClientApplication({
    auth: {
      clientId: tenant.client_id,
      clientSecret: tenant.client_secret,
      authority: `https://login.microsoftonline.com/${tenant.tenant_id}`,
    },
  });
}

function encodeState(data) {
  return Buffer.from(JSON.stringify(data)).toString('base64url');
}

function decodeState(str) {
  try { return JSON.parse(Buffer.from(str, 'base64url').toString()); } catch { return null; }
}

async function getAuthCodeUrl(tenant, nonce) {
  const msalInstance = createMsalInstance(tenant);
  const state = encodeState({ nonce, tenantDbId: tenant.id });
  const url = await msalInstance.getAuthCodeUrl({
    scopes: AUTH_SCOPES,
    redirectUri: tenant.redirect_uri,
    state,
  });
  return { url, state };
}

async function exchangeCode(tenant, code) {
  const msalInstance = createMsalInstance(tenant);
  const tokenResponse = await msalInstance.acquireTokenByCode({
    code,
    scopes: AUTH_SCOPES,
    redirectUri: tenant.redirect_uri,
  });
  return {
    tokenResponse,
    serializedCache: msalInstance.getTokenCache().serialize(),
  };
}

async function getUserAccessToken(tenant, session) {
  const msalInstance = createMsalInstance(tenant);
  const cache = msalInstance.getTokenCache();
  if (session.msalTokenCache) cache.deserialize(session.msalTokenCache);

  const accounts = await cache.getAllAccounts();
  const account = accounts.find(a => a.homeAccountId === session.accountId);
  if (!account) {
    const err = new Error('Session expired — please sign in again.');
    err.code = 'interaction_required';
    throw err;
  }

  const result = await msalInstance.acquireTokenSilent({ account, scopes: GRAPH_SCOPES });
  session.msalTokenCache = cache.serialize();
  return result.accessToken;
}

module.exports = { createMsalInstance, getAuthCodeUrl, exchangeCode, getUserAccessToken, decodeState, AUTH_SCOPES };
