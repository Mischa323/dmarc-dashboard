# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions are tagged in Git and automatically published to GHCR.

---

## [1.0.0] - 2026-05-15

First versioned release. Covers all work since the initial commit.

### Added

**Core**
- Microsoft Graph API client with client-credentials flow for reading DMARC report emails
- RFC 7489 aggregate report XML parser (`.xml`, `.xml.gz`, `.zip` attachments)
- SQLite database via `better-sqlite3` with WAL mode and safe column migrations
- Background scheduler with configurable global fetch interval and per-tenant overrides
- Manual "Fetch now" button available to all authenticated users

**Authentication**
- Local admin account with bcrypt-hashed password
- TOTP two-factor authentication for the local admin account
- Microsoft SSO login via MSAL (OAuth2 authorisation code flow) per tenant
- "Stay logged in for 30 days" remember-me on both local and SSO login
- Session secret auto-generated on first start and persisted to the data volume

**Multi-tenant**
- Multiple Azure app registrations (tenants), each with their own domains, mailbox and schedule
- Per-tenant colour picker — used in charts and the reports list
- Per-tenant SSO enable/disable toggle
- Per-tenant fetch interval override (falls back to global when not set)

**Dashboard & reports**
- Pass/fail rate doughnut chart
- Daily message volume trend — shows pass/fail split for single domain; one bar per domain (in its colour) for multi-tenant setups
- Failure breakdown doughnut (DKIM+SPF / DKIM only / SPF only)
- Top source IPs bar chart
- Top reporting organisations bar chart
- Filterable, paginated report list with coloured domain dot per row
- Per-report drill-down with every IP record and auth results

**DMARC DNS health checks**
- Checks for a valid `v=DMARC1` record on each configured domain
- Warns when `rua` tag is missing
- RFC 7489 §7.1 cross-domain authorisation check — warns when the `rua` mailbox domain differs from the monitored domain and the authorisation TXT record is missing

**DNS Records modal**
- Shows the exact DMARC TXT record (Name + Value) to add for each domain
- When the `rua` mailbox is on a different domain, also shows the cross-domain authorisation record with an explanation

**UI**
- Apple Glass design: `backdrop-filter` blur, ambient radial gradients, SF Pro font stack
- CSS custom property colour system — Accent, Pass, Fail, Warning
- Five preset themes (Cosmic, Ocean, Midnight, Ember, Forest) and individual colour pickers on the Settings page
- Theme preferences stored in `localStorage`, applied before first paint to avoid flash

**Admin**
- Setup wizard (3 steps) on first run
- Tenant list with SSO badge, interval badge, enable/disable, delete
- Tenant form with Azure credentials, domain list (multi-domain), DMARC policy per domain, colour picker, fetch interval override
- DMARC DNS Records modal on tenant list — shows all records to add including cross-domain auth
- User management (SSO users, role assignment)
- Global fetch interval setting
- Danger zone (reset / wipe data)

**Docker & deployment**
- Multi-stage Dockerfile (`node:20-alpine`); `better-sqlite3` native module handled correctly
- `docker-compose.yml` using pre-built GHCR image by default
- GitHub Actions workflow builds and pushes `linux/amd64` + `linux/arm64` images to GHCR on every push to `master` and on version tags
- `HTTP_MODE=1` env var for reverse proxy deployments (plain HTTP, `trust proxy`, secure cookie conditional)
- `CERTS_DIR` env var for custom certificate location
- Watchtower opt-in: service block and label included in compose file, documented in README
- Port configurable via `PORT` env var; both host binding and container port update together
- Data (database + TLS certs + session secret) persisted on a named Docker volume

**Documentation**
- README with separate Docker CLI and Portainer install guides
- Portainer section includes a ready-to-paste compose snippet
- Watchtower enable instructions with poll interval table
- Azure App Registration checklist
- DMARC DNS setup including cross-domain authorisation record explanation

---

## [Unreleased]

_Changes on `master` not yet tagged._

---

## [1.2.0] - 2026-05-17

### Added

**Security Groups**
- Security groups replace standalone email-report groups — each group provides both access control (which tenants members can see) and email reporting (reports delivered to member email addresses)
- Per-group role (`viewer` / `admin`) — effective role is computed at login from the highest-privilege group the user belongs to; the local admin account is always protected
- Users can be assigned to groups (local accounts and SSO accounts separately)
- Per-tenant access per group — controls which tenants' data is included in email reports
- Email address field for local user accounts

**Email reports**
- Per-group email schedule: none, daily, weekly, monthly, or daily + weekly
- Per-group send time and day (weekday for weekly, day-of-month 1–28 for monthly)
- Global timezone setting (IANA) used to interpret all send times — searchable combobox in Settings
- Monthly report option covering a 30-day window
- Branded HTML email template matching the dashboard visual style (dark background, glass cards, coloured pass/fail indicators)
- Styled test email sent when testing SMTP or Graph API connection

**Dashboard & reports**
- Warning banner on the Overview page when messages pass DMARC via SPF alignment only (no valid DKIM signature) — updates when the time-range picker changes
- Warning notification on the report detail page for the same condition, showing the affected message count
- Manual "Send daily / weekly / monthly" buttons in the Security Groups table

**Storage management**
- Storage card in Settings showing report count, record count, and database file size
- Configurable report retention: 30 days / 60 days / 90 days / 180 days / 1 year / 2 years / keep forever
- Manual "Purge old reports now" button
- Automatic daily cleanup runs in the scheduler once per calendar day

**UI**
- Glass-style chart bars: low-alpha transparent fills with coloured border edges and rounded corners
- Enhanced card glassmorphism: stronger backdrop blur, diagonal gradient background, top-edge and left-edge rim highlights
- Monthly schedule badge in the Security Groups table

### Fixed
- SMTP / Graph API transport toggle in Settings called undefined JS functions — switching transport would throw an error
- "Send monthly" button in Security Groups table sent daily reports instead of monthly

---

## [1.1.0] - 2026-05-15

### Added
- Clickable dashboard — stat cards (Reports, Passed, Failed) and all chart elements navigate to the Reports page pre-filtered by the clicked value (status, date, domain, source IP, or reporting organisation)
- Active filter chips on the Reports page — each active filter (status, date, IP, org, domain) shows a dismissible badge; clicking × removes only that filter
- Result count shown alongside active filter chips
- Pagination links on the Reports page now preserve all active filters across pages

### Fixed
- SSO enabled toggle on the tenant form never saved as enabled — caused by a hidden input with the same name creating an array that broke the server-side equality check
