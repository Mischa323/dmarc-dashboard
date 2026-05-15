const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ENV_PATH = path.join(__dirname, '..', '.env');
const PLACEHOLDER = 'change-me-to-a-random-64-char-string';

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
  if (process.env.SECRET && process.env.SECRET !== PLACEHOLDER) return;
  if (fs.existsSync(ENV_PATH)) return;
  const secret = crypto.randomBytes(32).toString('hex');
  const lines = [`PORT=3443`, `DATABASE_URL=dmarc.db`, `SECRET=${secret}`];
  fs.writeFileSync(ENV_PATH, lines.join('\n') + '\n', 'utf8');
  process.env.SECRET = secret;
}

function ensureSecret() {
  if (process.env.SECRET && process.env.SECRET !== PLACEHOLDER) return;

  // Persist the secret next to the database so it survives container restarts
  const dbPath = path.resolve(process.env.DATABASE_URL || 'dmarc.db');
  const secretFile = path.join(path.dirname(dbPath), '.secret');

  if (fs.existsSync(secretFile)) {
    process.env.SECRET = fs.readFileSync(secretFile, 'utf8').trim();
    return;
  }

  const secret = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(path.dirname(secretFile), { recursive: true });
    fs.writeFileSync(secretFile, secret, { encoding: 'utf8', mode: 0o600 });
    console.log('Session secret auto-generated and saved to', secretFile);
  } catch (e) {
    console.warn('Warning: could not persist session secret —', e.message);
  }
  process.env.SECRET = secret;
}

module.exports = { getConfig, isConfigured, ensureEnvFile, ensureSecret };
