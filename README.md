# DMARC Dashboard

A self-hosted web dashboard that reads DMARC aggregate reports from a Microsoft 365 mailbox via the **Microsoft Graph API** and visualises results with interactive charts.

![Dashboard screenshot placeholder](docs/screenshot.png)

## Features

- Reads DMARC report emails (`.xml`, `.xml.gz`, `.zip` attachments) automatically from your Office 365 mailbox
- Parses RFC 7489 aggregate reports and stores them in a local SQLite database
- Interactive dashboard with:
  - Pass / fail rate doughnut chart
  - Daily message volume trend (stacked bar)
  - Failure breakdown — DKIM fail, SPF fail, both fail
  - Top source IPs by volume
  - Top reporting organisations
- Filterable report list with pagination
- Per-report drill-down showing every IP record with auth results
- Background scheduler that polls the mailbox on a configurable interval
- Manual "Fetch now" button in the UI

## Requirements

- Python 3.11+
- A **Microsoft Entra (Azure AD)** app registration with `Mail.Read` application permission on the target mailbox

## Quick start

```bash
# 1. Clone and install
git clone https://github.com/YOUR_USERNAME/dmarc-dashboard.git
cd dmarc-dashboard
python -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt

# 2. Configure
cp .env.example .env
# Edit .env with your Azure app credentials and mailbox address

# 3. Run
python run.py
# Open http://localhost:5000
```

## Azure App Registration

1. Go to **Entra admin centre → App registrations → New registration**
2. Name it (e.g. `DMARC Dashboard`), single-tenant, no redirect URI
3. **API permissions → Add → Microsoft Graph → Application permissions → Mail.Read**
4. Grant admin consent
5. **Certificates & secrets → New client secret** — copy the value
6. Copy **Tenant ID**, **Application (client) ID**, and the secret into `.env`

The mailbox must belong to the same tenant. The app uses **client-credentials flow** (no user login required).

## Configuration

| Variable | Description | Default |
|---|---|---|
| `TENANT_ID` | Azure tenant ID | required |
| `CLIENT_ID` | App registration client ID | required |
| `CLIENT_SECRET` | App client secret | required |
| `MAILBOX` | Email address receiving DMARC reports | required |
| `MAIL_FOLDER` | Folder to scan | `Inbox` |
| `SECRET_KEY` | Flask session secret | change in prod |
| `DATABASE_URL` | SQLAlchemy DB URL | `sqlite:///dmarc.db` |
| `FETCH_INTERVAL_MINUTES` | Auto-fetch interval | `60` |

## DMARC report email setup

Point your domain's `rua=` tag to the mailbox configured above:

```
_dmarc.yourdomain.com  TXT  "v=DMARC1; p=reject; rua=mailto:dmarc@yourdomain.com"
```

Major ESPs (Google, Microsoft, Yahoo) will send aggregate XML reports daily.

## Project structure

```
dmarc-dashboard/
├── run.py                          Entry point
├── config.py                       Settings from env vars
├── dmarc_dashboard/
│   ├── __init__.py                 Flask app factory
│   ├── models.py                   SQLAlchemy models (Report, Record)
│   ├── graph_client.py             Microsoft Graph API client
│   ├── dmarc_parser.py             RFC 7489 XML parser
│   ├── fetcher.py                  Fetch & persist reports
│   ├── scheduler.py                APScheduler background job
│   ├── routes.py                   Flask routes & JSON API
│   └── templates/
│       ├── base.html
│       ├── dashboard.html          Charts dashboard
│       ├── reports.html            Report list
│       └── report_detail.html      Per-report drill-down
```

## License

MIT
