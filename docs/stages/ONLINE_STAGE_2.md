# Online Stage 2 — Running Nota on a VPS

Read before starting:
- docs/ONLINE_PLAN.md (Stage 1 and its decisions)
- nota-backend: src/server.js, src/app.js, src/config/db.js, src/auth/loginLimiter.js, src/auth/config.js, src/utils/transaction.js, src/migrations/index.js, .env.example, package.json, the create-owner / recover-owner scripts
- nota-frontend: angular.json (production build and its output folder), src/environments/*

Start in plan mode and show me the plan before changing anything. Use Node 24 and a real mongod. Run long suites with a timeout and output to a file (never piped into head). Leave no test processes behind. Never use git worktree on Windows. Never touch C:\ProgramData\Nota, the installed offline Nota, or ports 27017/27217. Never commit; I commit after I review.

## Context
- One shop = one VPS (e.g. Contabo), Ubuntu 24.04 LTS, root access over SSH, one domain per shop (e.g. `shop.example.com`).
- No Docker. Plain packages: MongoDB 8 (official repo), Node 24 LTS (NodeSource), nginx, certbot, ufw, fail2ban. The backend runs as a systemd service.
- nginx serves the built Angular app and proxies `/api/` to the backend on 127.0.0.1. Same origin, so `CORS_ORIGINS=https://<domain>`. If Stage 1 made the backend serve the frontend itself, tell me in STEP 0 and propose which to keep.
- I develop on Windows. The release package is built on my Windows PC and uploaded to the server; the server never needs access to the git repo.
- Later stages add the customer website and a PWA on the same server; keep the layout ready for that (don't hard-code that `/` is the admin app forever, but don't build anything for it now).

## Hard rules
- **No change to business logic** (sales, credit, returns, purchases, inventory, cash boxes, shifts, accounting, VAT, reports, permissions).
- Code changes in the app are limited to what is listed under "App changes". Anything else you think is needed: list it at the end, don't do it.
- **No real secret in the repo**, ever: no passwords, JWT secrets, keyFiles, rclone configs or private keys. Templates use placeholders; real values are generated on the server.
- Server scripts are bash, `set -euo pipefail`, idempotent (running twice is safe), and pass `shellcheck` with no warnings. Scripts that run on my PC are Node (they must work on Windows).

## App changes (backend)
1. **Bind address:** listen on `NOTA_LISTEN_HOST` when set (production sets `127.0.0.1`), otherwise on all interfaces as now.
2. **Behind a proxy:** `app.set('trust proxy', 'loopback')` when `NOTA_TRUST_PROXY=1`. Check `loginLimiter` and anything else that uses `req.ip`: behind nginx without this, every request looks like 127.0.0.1 and one failed login would lock everyone out. Add a test for it.
3. **Health check:** `GET /health` (outside `/api`, no auth): `{ ok: true, version, db: "up" }` with 200 when MongoDB answers a ping, 503 otherwise. No other data.
4. **Logs:** in production (`NODE_ENV=production`) morgan uses a short combined format without query strings (they can contain search text); dev stays as it is.
5. `.env.example`: add the new variables with comments.

## Server files (new folder `deploy/`)
### `deploy/setup-server.sh <domain> <admin-email>` — run once as root on a fresh VPS
- apt update/upgrade, set timezone `Africa/Cairo`, install the packages above, enable unattended security upgrades.
- Create a system user `nota` (no login shell) and the folders: `/opt/nota/releases`, `/opt/nota/current` (symlink), `/etc/nota` (root:nota, 750), `/var/backups/nota`, `/var/log/nota` if needed.
- **MongoDB:** bind to 127.0.0.1 only, single-node replica set `rs0` (transactions need it), authorization on with a keyFile (required for a replica set with auth), an admin user and an app user limited to the `nota` database. Generate the passwords and the keyFile on the server. Initiate the replica set and wait until it is PRIMARY.
- **Backend env:** write `/etc/nota/backend.env` (root:nota, 640): `NODE_ENV=production`, `PORT`, `NOTA_LISTEN_HOST=127.0.0.1`, `NOTA_TRUST_PROXY=1`, the Mongo URI with the app user and `replicaSet=rs0`, a generated `NOTA_JWT_SECRET` (at least 48 random bytes), `CORS_ORIGINS=https://<domain>`. Never print secrets to the terminal; say where they are.
- **systemd:** `nota-backend.service`, runs `/opt/nota/current/backend` as `nota`, `EnvironmentFile=/etc/nota/backend.env`, `Restart=always`, starts after mongod, basic hardening (`NoNewPrivileges`, `ProtectSystem=full`, `PrivateTmp`).
- **nginx:** from a template: HTTP → HTTPS redirect; serve `/opt/nota/current/frontend` with SPA fallback to index.html; long cache for hashed files, no cache for index.html; proxy `/api/` and `/health` to 127.0.0.1:PORT with the usual forwarded headers; `client_max_body_size` matching the backend's 10mb JSON limit and the Excel import; gzip; security headers (HSTS, X-Content-Type-Options, Referrer-Policy, frame-ancestors none). Remove the default site.
- **HTTPS:** certbot with the nginx plugin for `<domain>`, auto-renew timer verified. If DNS doesn't point to the server yet, stop with a clear message telling me to add the A record and re-run.
- **Firewall:** ufw allow OpenSSH, 80, 443; deny the rest. fail2ban for sshd.
- **SSH hardening is NOT automated** (a mistake locks me out). The Arabic guide explains adding my SSH key and disabling password login as manual steps, with a warning to test the key login in a second window first.
- **Backups:** install the backup script and a systemd timer (see below).
- At the end print the next steps: upload the first release, run create-owner.

### `deploy/backup.sh` — daily, systemd timer at 03:30 Cairo time
- `mongodump --archive --gzip` with the app user into `/var/backups/nota/nota-YYYY-MM-DD-HHMM.archive.gz`, then verify the archive is readable (`mongorestore --dryRun` or equivalent).
- Keep the last 14 daily backups locally.
- **Off-server copy:** if `/etc/nota/backup.env` sets `NOTA_RCLONE_REMOTE`, copy the archive with rclone (e.g. Google Drive or Backblaze B2) and keep 30 there. If not set, log a warning every run. The rclone config is created by me on the server (the guide explains how); never in the repo.
- Log to journald; exit non-zero on failure so `systemctl status` shows it.

### `deploy/restore.sh <archive>` — manual
- Asks for confirmation (type the domain), takes a safety backup first, stops the backend, `mongorestore --drop`, sets `NOTA_SESSIONS_VALID_AFTER` to now in backend.env so every user signs in again, starts the backend, waits for `/health`.

### Releases and updates
- **`nota-frontend` / `nota-backend` → a Node script I run on Windows**, e.g. `node deploy/make-release.js`: builds the frontend (production), copies the backend without node_modules, tests or `.env`, writes `release.json` (version, git commit, date), and produces `release-<version>-<commit>.tar.gz` in a git-ignored folder. It refuses if the git tree is dirty (overridable with a flag for testing).
- **`deploy/update.sh <tarball>` on the server:**
  1. backup first (same as backup.sh, named `before-update-<version>`);
  2. unpack into `/opt/nota/releases/<version>-<commit>`, `npm ci --omit=dev` there;
  3. switch the `current` symlink, restart the service (migrations run at start, as today);
  4. wait for `/health` up to 60 s;
  5. if health fails: switch the symlink back, restore the before-update backup (migrations may have changed data), restart, report failure clearly;
  6. keep the last 3 releases, delete older ones.
- Upload is documented as `scp` from Windows (PowerShell), with the exact commands.

## Docs (Arabic, step by step, for me)
- `docs/deploy/NEW_SERVER_AR.md`: buy/prepare the VPS, DNS A record, upload and run setup-server, first release, create-owner, SSH key and disabling password login, checking everything works.
- `docs/deploy/UPDATE_AR.md`: make a release on Windows, upload, update, what to do if it rolls back.
- `docs/deploy/BACKUP_RESTORE_AR.md`: where backups are, setting up rclone (Google Drive), testing a restore, restoring for real.
- Update docs/ONLINE_PLAN.md with Stage 2 and its decisions.

## STEP 0 (plan, before any change)
1. Every file you will add or edit, one line each.
2. How the frontend is served today after Stage 1, and your proposal if it differs from the above.
3. Where `req.ip` is used and how trust proxy affects each place.
4. Anything in this brief you think is wrong or risky, with your alternative.

## Done means
- Backend `npm test` passes (including the new trust-proxy and health tests); frontend production build and `ng test` pass.
- `shellcheck deploy/*.sh` has no warnings.
- `node deploy/make-release.js` produces a tarball on Windows; list its contents (no `.env`, no node_modules, no tests, no secrets).
- `grep` the repo for anything that looks like a real secret (`BEGIN .*PRIVATE KEY`, `mongodb://[^<]*:[^<]*@`, long random strings in env files) and show the result.
- You cannot test on a real VPS: say exactly which parts were not run, so I test them on the first server.
- Report: what was added, what was changed, and the list of things you noticed but did not do.
