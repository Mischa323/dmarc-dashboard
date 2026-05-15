# DMARC Dashboard

A self-hosted dashboard that reads DMARC aggregate reports from a **Microsoft 365 mailbox** via the Microsoft Graph API and visualises results with interactive charts.

## Features

- Reads DMARC report emails (`.xml`, `.xml.gz`, `.zip`) automatically from an Office 365 mailbox
- Parses RFC 7489 aggregate reports and stores them in a local SQLite database
- Interactive dashboard — pass/fail rate, daily volume trend, failure breakdown, top IPs and organisations
- Multi-tenant support with per-tenant Microsoft SSO login
- Background scheduler with global and per-tenant fetch intervals
- Manual "Fetch now" button
- DMARC DNS health checks including RFC 7489 §7.1 cross-domain `rua` authorisation
- Two-factor authentication for the local admin account
- Glassmorphism UI with customisable colour themes

---

## Install with Docker (recommended)

The Docker image is built automatically and published to the **GitHub Container Registry** on every commit. No build step needed.

### 1. Create a working directory and environment file

```bash
mkdir dmarc-dashboard && cd dmarc-dashboard
```

Create a `.env` file:

```env
SECRET=replace-with-a-random-64-character-string
PORT=3443
```

Generate a secure secret:
```bash
openssl rand -hex 32
# or with Node.js:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

To use a **different port**, change `PORT` in `.env`. Both the host binding and the container update automatically.

### 2. Download docker-compose.yml

```bash
curl -O https://raw.githubusercontent.com/Mischa323/dmarc-dashboard/master/docker-compose.yml
```

Or copy it manually from the repository.

### 3. Start

```bash
docker compose up -d
```

Docker pulls the pre-built image from GHCR and starts the container. No compilation required.

### 4. Open the setup wizard

Navigate to `https://localhost:3443` (or your chosen port) and follow the 3-step setup wizard to create the admin account and configure your first Microsoft 365 tenant.

> **Self-signed certificate** — the dashboard generates a self-signed TLS certificate on first start. Your browser will show a security warning; add a permanent exception or place the container behind a reverse proxy with a real certificate.

### Reverse proxy (nginx / Traefik)

Set `HTTP_MODE=1` in `.env` to run the server on plain HTTP. The session cookie `secure` flag and `trust proxy` setting are applied automatically.

```env
PORT=3000
HTTP_MODE=1
```

### Data persistence

All data — the SQLite database and TLS certificates — is stored in the Docker volume `dmarc_data` (mounted at `/data`). Data survives container restarts and updates.

### Update to a new version

```bash
docker compose pull && docker compose up -d
```

---

## Install with Portainer

Portainer lets you deploy and manage the dashboard through a web UI using a Docker Compose stack.

### 1. Open Stacks

In Portainer, go to **Stacks → Add stack**.

### 2. Name the stack

Give it a name such as `dmarc-dashboard`.

### 3. Paste the compose file

Select **Web editor** and paste the following:

```yaml
services:
  dmarc-dashboard:
    image: ghcr.io/mischa323/dmarc-dashboard:latest
    restart: unless-stopped
    ports:
      - "3443:3443"
    volumes:
      - dmarc_data:/data
    environment:
      SECRET: "replace-with-a-random-64-character-string"
      PORT: "3443"
      DATABASE_URL: "/data/dmarc.db"
      CERTS_DIR: "/data/certs"
      # HTTP_MODE: "1"
    labels:
      - "com.centurylinklabs.watchtower.enable=true"

volumes:
  dmarc_data:
```

> To change the port, update **both** `3443:3443` (host:container) and the `PORT` environment variable to the same value.

### 4. Set environment variables

Instead of editing the compose file directly, you can use Portainer's **Environment variables** section below the editor to set `SECRET` and `PORT` — this keeps secrets out of the stack definition.

| Variable | Value |
|---|---|
| `SECRET` | A random 64-character string (see generation command below) |
| `PORT` | `3443` (or your preferred port) |

Generate a secret on any machine with Node.js or OpenSSL:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# or
openssl rand -hex 32
```

### 5. Deploy

Click **Deploy the stack**. Portainer will pull the image, create the `dmarc_data` volume, and start the container.

### 6. Open the setup wizard

Navigate to `https://<your-host>:3443` and follow the setup wizard to create the admin account and configure your Microsoft 365 tenant.

### Updating

In Portainer go to **Stacks → dmarc-dashboard → Editor**, then click **Update the stack**. Portainer will pull the latest image and recreate the container while keeping the `dmarc_data` volume intact.

---

## Automatic updates with Watchtower

[Watchtower](https://containrrr.dev/watchtower/) monitors your running containers and automatically pulls and restarts them when a new image is published.

> **Requirement:** Watchtower can only update containers that use a pre-built registry image. If you are building the image locally with `build: .`, Watchtower cannot help — use the manual update steps instead.

### Enable Watchtower

**Step 1** — Switch from a local build to a registry image in `docker-compose.yml`:

```yaml
services:
  dmarc-dashboard:
    image: ghcr.io/mischa323/dmarc-dashboard:latest   # ← replace "build: ."
```

**Step 2** — Uncomment the `watchtower` service block in `docker-compose.yml`:

```yaml
  watchtower:
    image: containrrr/watchtower
    restart: unless-stopped
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    environment:
      WATCHTOWER_LABEL_ENABLE: "true"      # only watch containers with the enable label
      WATCHTOWER_CLEANUP: "true"           # remove old images after update
      WATCHTOWER_POLL_INTERVAL: "86400"    # check every 24 hours (in seconds)
      WATCHTOWER_INCLUDE_RESTARTING: "true"
    command: --label-enable
```

The `dmarc-dashboard` service already has the label `com.centurylinklabs.watchtower.enable=true` in the compose file, so Watchtower will only manage that specific container and leave everything else on the host alone.

**Step 3** — Restart the stack:

```bash
docker compose up -d
```

### Change the update interval

Edit `WATCHTOWER_POLL_INTERVAL` in the watchtower environment block (value is in seconds):

| Interval | Value |
|---|---|
| Every hour | `3600` |
| Every 6 hours | `21600` |
| Every 24 hours | `86400` (default) |

### Watchtower in Portainer

Add the watchtower service to your Portainer stack definition the same way — paste the block into the Web editor, then click **Update the stack**.

---

## Install without Docker (Node.js)

### Requirements

- Node.js 20+
- A Microsoft Entra (Azure AD) app registration (see below)

### Steps

```bash
# 1. Clone and install dependencies
git clone https://github.com/Mischa323/dmarc-dashboard.git
cd dmarc-dashboard
npm install

# 2. Start the server — a .env file and self-signed TLS certificate are generated automatically
node server.js

# 3. Open https://localhost:3443 and follow the setup wizard
```

To change the port, set `PORT` before starting:

```bash
PORT=8443 node server.js
```

Or add it to the `.env` file that is auto-generated on first run.

---

## Azure App Registration

1. Go to **Entra admin centre → App registrations → New registration**
2. Name it (e.g. `DMARC Dashboard`), single-tenant, no redirect URI needed for mail fetching
3. **API permissions → Add → Microsoft Graph → Application permissions**
   - `Mail.Read` — to read report emails
   - `User.Read.All` — required for SSO user lookup (optional if SSO is not used)
4. Grant admin consent
5. **Certificates & secrets → New client secret** — copy the value immediately
6. Note the **Tenant ID** and **Application (client) ID** from the Overview page
7. Enter these values in the dashboard's setup wizard or tenant configuration screen

The app uses **client-credentials flow** (no interactive login required for mail fetching).

---

## Configuration

These variables can be set in `.env` (standalone) or in `docker-compose.yml` / a Docker `.env` file.

| Variable | Description | Default |
|---|---|---|
| `PORT` | Listening port | `3443` |
| `SECRET` | Session secret (use a long random string) | auto-generated |
| `DATABASE_URL` | Path to the SQLite database file | `dmarc.db` / `/data/dmarc.db` |
| `CERTS_DIR` | Directory for TLS certificate and key | `./certs` / `/data/certs` |
| `HTTP_MODE` | Set to `1` to listen on plain HTTP (reverse proxy mode) | — |

Tenant credentials (Tenant ID, Client ID, Client Secret, mailbox address) are stored in the database and managed through the admin UI — they are not environment variables.

---

## DMARC DNS setup

Point your domain's `rua` tag to the mailbox you configured:

```
_dmarc.yourdomain.com  TXT  "v=DMARC1; p=reject; rua=mailto:dmarc@yourdomain.com"
```

If the reporting mailbox is on a **different domain** than the monitored domain, you also need an authorisation record (RFC 7489 §7.1):

```
yourdomain.com._report._dmarc.mailboxdomain.com  TXT  "v=DMARC1;"
```

The dashboard's DNS health check will detect this and show the exact record to add.

---

## Project structure

```
dmarc-dashboard/
├── server.js              Entry point — starts HTTPS/HTTP server
├── src/
│   ├── app.js             Express app factory
│   ├── config.js          Environment config and .env generation
│   ├── db.js              SQLite schema, migrations, helpers
│   ├── dmarcParser.js     RFC 7489 XML parser
│   ├── fetcher.js         Fetch and persist reports
│   ├── graphClient.js     Microsoft Graph API client
│   ├── msalHelper.js      MSAL token acquisition
│   ├── scheduler.js       Background fetch scheduler
│   ├── tenantTest.js      DNS and connectivity health checks
│   └── routes/
│       ├── admin.js       Admin UI routes
│       ├── api.js         JSON API for the dashboard
│       ├── auth.js        Local login, SSO, 2FA
│       ├── main.js        Dashboard and reports pages
│       └── setup.js       First-run setup wizard
├── views/                 EJS templates
├── Dockerfile
├── docker-compose.yml
└── .env.example
```

## License

MIT
