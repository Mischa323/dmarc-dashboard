const { ensureEnvFile } = require('./src/config');
ensureEnvFile();            // create .env with PORT/SECRET if missing
require('dotenv').config(); // load it into process.env

const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');

const { createApp }     = require('./src/app');
const { getConfig }     = require('./src/config');
const { startScheduler } = require('./src/scheduler');

const CERTS_DIR = process.env.CERTS_DIR || path.join(__dirname, 'certs');
const CERT_PATH = path.join(CERTS_DIR, 'cert.pem');
const KEY_PATH  = path.join(CERTS_DIR, 'key.pem');

function ensureCerts() {
  if (fs.existsSync(CERT_PATH) && fs.existsSync(KEY_PATH)) return;
  console.log('Generating self-signed TLS certificate...');
  const selfsigned = require('selfsigned');
  const pems = selfsigned.generate([{ name: 'commonName', value: 'localhost' }], { days: 3650, keySize: 2048, algorithm: 'sha256' });
  fs.mkdirSync(CERTS_DIR, { recursive: true });
  fs.writeFileSync(CERT_PATH, pems.cert, 'utf8');
  fs.writeFileSync(KEY_PATH, pems.private, 'utf8');
  console.log(`Certificate written to ${CERTS_DIR}/`);
}

startScheduler();

const app = createApp();
const { port } = getConfig();

if (process.env.HTTP_MODE === '1') {
  http.createServer(app).listen(port, () => {
    console.log(`DMARC Dashboard → http://0.0.0.0:${port}`);
    console.log('Running in HTTP mode (reverse proxy expected to terminate TLS).');
  });
} else {
  ensureCerts();
  https.createServer({ cert: fs.readFileSync(CERT_PATH), key: fs.readFileSync(KEY_PATH) }, app)
    .listen(port, () => {
      console.log(`DMARC Dashboard → https://localhost:${port}`);
      console.log('First run? Open the URL and follow the setup wizard.');
    });
}
