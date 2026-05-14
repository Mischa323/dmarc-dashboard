const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ENV_PATH = path.join(__dirname, '..', '.env');

function getConfig() {
  return {
    port: parseInt(process.env.PORT || '3443', 10),
    databaseUrl: process.env.DATABASE_URL || 'dmarc.db',
    sessionSecret: process.env.SECRET || '',
  };
}

function isConfigured() {
  try {
    const { getDb } = require('./db');
    const db = getDb();
    return !!db.prepare('SELECT id FROM local_users LIMIT 1').get();
  } catch {
    return false;
  }
}

function ensureEnvFile() {
  if (process.env.SECRET) return; // already set via environment (e.g. Docker) — skip file creation
  if (fs.existsSync(ENV_PATH)) return;
  const secret = crypto.randomBytes(32).toString('hex');
  const lines = [
    `PORT=3443`,
    `DATABASE_URL=dmarc.db`,
    `SECRET=${secret}`,
  ];
  fs.writeFileSync(ENV_PATH, lines.join('\n') + '\n', 'utf8');
  process.env.SECRET = secret;
}

module.exports = { getConfig, isConfigured, ensureEnvFile };
