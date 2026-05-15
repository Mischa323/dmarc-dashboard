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

## Installation

Choose the method that fits your setup:

| Method | Best for |
|---|---|
| [Docker CLI](#-docker-cli) | Linux servers, NAS devices, quick installs |
| [Portainer](#-portainer) | Portainer users who prefer a web UI |
| [Node.js](#-nodejs-without-docker) | Development or servers without Docker |

> **Session secret** — a cryptographically random secret is auto-generated on first start and saved to the persistent data volume. No manual setup required.

---

## 🐳 Docker CLI

### 1. Download the compose file

```bash
mkdir dmarc-dashboard && cd dmarc-dashboard
curl -O https://raw.githubusercontent.com/Mischa323/dmarc-dashboard/master/docker-compose.yml
```

### 2. (Optional) Create a `.env` file to customise the port

```env
PORT=3443
```

Skip this step to use the default port `3443`.

### 3. Start

```bash
docker compose up -d
```

Docker pulls the pre-built image from GHCR — no compilation needed.

### 4. Open the setup wizard

Go to `https://<your-host>:3443` and follow the 3-step wizard to create the admin account and connect your first Microsoft 365 tenant.

> **Self-signed certificate** — the dashboard generates a self-signed TLS certificate on first start. Your browser will warn you; add a permanent exception or put the container behind a reverse proxy.

### Updating

```bash
docker compose pull && docker compose up -d
```

### Enable automatic updates (Watchtower)

Add the following service to `docker-compose.yml` to have Watchtower automatically pull and restart the container whenever a new image is published:

```yaml
  watchtower:
    image: containrrr/watchtower
    restart: unless-stopped
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    environment:
      WATCHTOWER_LABEL_ENABLE: "true"
      WATCHTOWER_CLEANUP: "true"
      WATCHTOWER_POLL_INTERVAL: "86400"   # seconds — 86400 = every 24 hours
    command: --label-enable
```

The `dmarc-dashboard` service already has the `watchtower.enable=true` label, so Watchtower will only manage this container.

### Reverse proxy

Set `HTTP_MODE=1` in `.env` to listen on plain HTTP (for nginx / Traefik terminating TLS):

```env
PORT=3000
HTTP_MODE=1
```

---

## 📦 Portainer

### 1. Open Stacks

In Portainer, go to **Stacks → Add stack**.

### 2. Name the stack

Enter a name such as `dmarc-dashboard`.

### 3. Paste into the Web editor

Copy the entire block below and paste it into the **Web editor**:

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
      PORT: "3443"
      DATABASE_URL: "/data/dmarc.db"
      CERTS_DIR: "/data/certs"
      # Uncomment the line below when running behind a reverse proxy (nginx/Traefik):
      # HTTP_MODE: "1"
    labels:
      - "com.centurylinklabs.watchtower.enable=true"

volumes:
  dmarc_data:
```

> To use a different port, change **both** `3443:3443` and `PORT: "3443"` to the same value.

### 4. Deploy the stack

Click **Deploy the stack**. Portainer pulls the image, creates the `dmarc_data` volume, and starts the container.

### 5. Open the setup wizard

Go to `https://<your-host>:3443` and follow the 3-step wizard to create the admin account and connect your first Microsoft 365 tenant.

### Updating

Go to **Stacks → dmarc-dashboard**, click **Pull and redeploy**. The `dmarc_data` volume is preserved.

### Enable automatic updates (Watchtower)

Add the Watchtower service to your stack in the Web editor so it sits alongside `dmarc-dashboard`:

```yaml
  watchtower:
    image: containrrr/watchtower
    restart: unless-stopped
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    environment:
      WATCHTOWER_LABEL_ENABLE: "true"
      WATCHTOWER_CLEANUP: "true"
      WATCHTOWER_POLL_INTERVAL: "86400"   # seconds — 86400 = every 24 hours
    command: --label-enable
```

Then click **Update the stack**. Watchtower will check for a new image every 24 hours and restart the container automatically.

**Change the check interval:**

| Frequency | `WATCHTOWER_POLL_INTERVAL` |
|---|---|
| Every hour | `3600` |
| Every 6 hours | `21600` |
| Every 24 hours | `86400` |

---

## 🟢 Node.js (without Docker)

### Requirements

- Node.js 20+
- A Microsoft Entra (Azure AD) app registration

### Steps

```bash
# 1. Clone and install
git clone https://github.com/Mischa323/dmarc-dashboard.git
cd dmarc-dashboard
npm install

# 2. Start — .env and a self-signed TLS certificate are generated automatically
node server.js

# 3. Open https://localhost:3443 and follow the setup wizard
```

To use a different port:

```bash
PORT=8443 node server.js
```

Or add `PORT=8443` to the `.env` file generated on first run.

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
7. Enter these values in the dashboard's tenant configuration screen

The app uses **client-credentials flow** — no interactive user login required for mail fetching.

---

## Configuration

| Variable | Description | Default |
|---|---|---|
| `PORT` | Listening port | `3443` |
| `SECRET` | Session secret | auto-generated, saved to `/data/.secret` |
| `DATABASE_URL` | Path to the SQLite database | `dmarc.db` / `/data/dmarc.db` |
| `CERTS_DIR` | Directory for TLS cert and key | `./certs` / `/data/certs` |
| `HTTP_MODE` | Set to `1` for plain HTTP (reverse proxy mode) | — |

Tenant credentials (Tenant ID, Client ID, Client Secret, mailbox) are stored in the database and managed via the Admin UI — not environment variables.

---

## DMARC DNS setup

Point your domain's `rua` tag to the configured mailbox:

```
_dmarc.yourdomain.com  TXT  "v=DMARC1; p=reject; rua=mailto:dmarc@yourdomain.com"
```

If the reporting mailbox is on a **different domain** than the monitored domain, add an authorisation record (RFC 7489 §7.1):

```
yourdomain.com._report._dmarc.mailboxdomain.com  TXT  "v=DMARC1;"
```

The dashboard's DNS health check detects missing authorisation records and shows the exact record to add.

---

## Project structure

```
dmarc-dashboard/
├── server.js              Entry point — starts HTTPS/HTTP server
├── src/
│   ├── app.js             Express app factory
│   ├── config.js          Environment config, secret and .env generation
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
