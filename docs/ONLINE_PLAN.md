# Online Edition Plan

## Context
- This is the `online` branch, taken from `main`. The offline edition stays on its own branch and must not be touched. `docs/OFFLINE_PLAN.md`, `docs/stages/*` and `nota-review/` are history.
- The online edition is the same shop system (same business logic, same pages, same permissions, same accounting) running as a normal web app: one Node backend + MongoDB on a Linux VPS (for example Contabo), one server per shop, used from a browser.
- A customer website and a mobile app (PWA) come in later stages, not in Stage 1.
- Everything that existed only because of the desktop/LAN setup is gone: Electron, the bundled mongod, main PC / client PCs, LAN discovery and the LAN key, the firewall, the setup wizard, the desktop backup/restore, the installer.

## General rules for every change
- Do not change business logic: selling, credit sales, returns, purchases, suppliers, customers, inventory, cash boxes, shifts, expenses, accounting (posting, periods, closing, opening, manual entries), VAT, reports, permissions.
- No refactoring or side improvements. If you notice something worth fixing, list it at the end of your reply instead of fixing it.
- Keep the migrations runner and all existing migrations as they are.
- Keep every existing test that covers business logic green. Delete only tests of removed desktop/LAN code, and list each one with the reason.
- Use Node 24 and a real mongod (replica set; transactions are required). Run long suites with a timeout and output to a file. Leave no test processes behind. Never use git worktree on Windows.
- Never commit. The owner of the repo commits after review.

## Stage 1 — remove the offline (desktop/LAN) layer

### Removed
- Frontend: `electron-offline/`, `electron/`, `installer-offline/`, `electron-builder.offline.json`, `scripts/offline/`, `build/icon.ico`, `src/app/offline/` (backup page, connection overlay, other-main banner, version notice), the main-PC guard, `core/runtime/` (the `window.notaDesktop` bridge), `environment.offline.ts` and the `offline` build configuration, the offline/electron scripts and the `electron` / `electron-builder` dev dependencies, the print settings card and the printer/test-print/save-PDF-through-the-desktop code, the recovery-code screen.
- Backend: LAN mode (`lanSecret` middleware, `/api/lan`, `NOTA_LAN_MODE`, `NOTA_LAN_SECRET`), the Electron hooks in `server.js` (`process.parentPort`, `NOTA_LISTEN_HOST`, graceful shutdown), the audit inbox, `localOnly()` and the HTTP `setup-owner` / `recover` routes, `autoIndex: !isLanMode()` and the LAN-only Mongo URI rule, `NOTA_AUTH`, `NOTA_APP_VERSION`, the migration runner's `killAllSessions` for the bundled mongod.

### Changed
- API base URL comes from the environment file: development `http://localhost:5000/api/`, production same origin `/api/`.
- Printing is browser printing only (hidden iframe + `window.print()`); "Save as PDF" is the browser's own destination. Print reservations (copy numbers) are unchanged.
- The login page is sign-in only. If there is no owner yet it says to run `create-owner` on the server.
- `CORS_ORIGINS` replaces the open `cors()` (the only security change in this stage).

## Decisions

### A. Auth is always on
The server is public, so the `NOTA_AUTH` switch is gone: login, permissions, cost stripping, `createdBy`/`updatedBy` and audit are always enforced. `NOTA_JWT_SECRET` (at least 32 characters) is required at start; the server fails closed without it.

### B. Creating the owner and recovery
No setup wizard, no main PC. `setup-owner` and `recover` over HTTP would let anyone on the internet claim an empty shop, so they are removed. On the server:
- `npm run create-owner -- --username <name> [--name "<Full name>"]` asks for the password, creates the owner and prints the recovery code once; it refuses if an owner exists.
- `npm run recover-owner` asks for a new password, prints a new recovery code and ends every session.
`GET /api/auth/bootstrap` stays (the login page needs `hasOwner` and the shop name/logo).

### C. `backup.manage`
Backups become the server's job (mongodump on a cron, documented in a later stage). The backup page and the desktop backup IPC are removed. The `backup.manage` permission stays in the catalog, unused, because removing it touches users' stored permission lists. **Status: still open.** For now the permission is kept; whether to remove it (and migrate stored permission lists) or give it a use is not decided.

### D. Devices and the default cash box (Stage 19)
**Decided and implemented.** The default cash box is chosen per device through `X-Nota-Device-Id` and the Device registry. In the browser the device id is a random id generated once and kept in localStorage; the device name is optional. There is no main PC / client PC role. Option (2), a default cash box per user, was not chosen. This is no longer open.

### E. Server settings
- `.env.example`: `PORT`, `MONGO_URI`, `NOTA_JWT_SECRET`, `CORS_ORIGINS` (comma-separated allow-list).
- nginx serves the built Angular app (`dist/nota`) and proxies `/api/` to the backend; the backend serves no static files.

## Backups, nginx, the PWA and the customer website
Later stages.

## Stage 2 — running Nota on a VPS

One shop = one Ubuntu 24.04 VPS = one domain. Plain packages, no Docker: MongoDB 8 (single-node replica set `rs0`, authorization + keyFile, 127.0.0.1 only), Node 24, nginx, certbot, ufw, fail2ban; the backend is the systemd service `nota-backend`. The release package is built on the Windows PC and uploaded with `scp`; the server never needs the git repo.

### App changes (backend only, no business logic)
- `NOTA_LISTEN_HOST`: listen on that address (production `127.0.0.1`); unset = all interfaces.
- `NOTA_TRUST_PROXY=1`: `app.set('trust proxy', 'loopback')`. Behind nginx `req.ip` is otherwise always 127.0.0.1, so the login lockout (per username + IP) would lock everybody after 5 wrong passwords. `req.ip` is used by the login lockout (`auth.controller.js`) and the audit log (`auth/audit.js`) only.
- `GET /health` (outside `/api`, no auth): `{ ok, version, db }`, 200 when MongoDB answers a ping, else 503. `version` comes from `release.json` (written by `make-release.js`), falling back to `package.json`. Both package.json files are at `1.0.0`; `release.json` uses the backend's version, and the release name is `release-<version>-<commit>`.
- `NODE_ENV=production`: access log without query strings (search text); dev unchanged.
- Tests: `nota-backend/test/online-stage2.test.js` (not `stage24-*`: Stage 24 is the offline licensing stage).

### Layout on the server
`/opt/nota/releases/<version>-<commit>/{backend,frontend,release.json}`, `/opt/nota/current` (symlink), `/opt/nota/bin` (the scripts), `/etc/nota/{backend.env,backup.env,mongo-admin.env}` (root:nota 750 folder; secrets generated on the server, never in the repo), `/etc/mongodb-keyfile`, `/var/backups/nota`.

### Decisions
- **F. nginx serves, the backend proxies only.** nginx serves `/opt/nota/current/frontend` (SPA fallback, `index.html` never cached, hashed js/css cached for a year) and proxies `/api/` and `/health` to 127.0.0.1. The customer website / PWA later can take `/` or get another `server` block without touching the proxy rules.
- **G. `client_max_body_size 100m` on `/api/`** (the category Excel import allows 100 MB; JSON stays limited to 10mb by the app).
- **H. nginx sends `X-Forwarded-For $remote_addr`** (not append), so a client-supplied header never reaches the backend.
- **I. Scripts:** `deploy/setup-server.sh` (once, idempotent, never replaces generated secrets), `backup.sh` (daily 03:30 Cairo; keep 14 locally, 30 off-server via rclone if `NOTA_RCLONE_REMOTE` is set, warning every run if not), `restore.sh` (type the domain, safety backup, `--drop`, `NOTA_SESSIONS_VALID_AFTER`=now), `update.sh` (backup, unpack, `npm ci --omit=dev`, switch, wait `/health` 60 s, rollback = old symlink + restore of the before-update backup, keep 3 releases), `nota-owner` (create/recover owner on the server). `deploy/make-release.js` runs on Windows.
- **J. SSH hardening is manual** (documented in `docs/deploy/NEW_SERVER_AR.md` with a test-in-a-second-window warning).
- **L. `xlsx` is vendored** (`nota-backend/vendor/xlsx-0.20.3.tgz`, `"xlsx": "file:vendor/xlsx-0.20.3.tgz"`, same integrity hash as the SheetJS CDN build), so `npm ci` on the server never needs cdn.sheetjs.com. The release includes `vendor/`.
- **M. Login rate limit in nginx** (`limit_req`, 10/minute per IP, burst 5, 429) on `POST /api/auth/login` only; nothing else is rate limited yet. The app's own lockout (5 failures per username + IP) stays.
- **N. rclone from the official installer** (`https://rclone.org/install.sh`), not apt.
- **K. Rollback loses writes made between the pre-update backup and the rollback** (seconds to a minute); update at a quiet time.
- Docs (Arabic): `docs/deploy/NEW_SERVER_AR.md`, `UPDATE_AR.md`, `BACKUP_RESTORE_AR.md`.
