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
Backups become the server's job (mongodump on a cron, documented in a later stage). The backup page and the desktop backup IPC are removed. The `backup.manage` permission stays in the catalog, unused, because removing it touches users' stored permission lists. Decision: keep it for now.

### D. Devices and the default cash box (Stage 19)
Open: the default cash box is chosen per PC through `X-Nota-Device-Id` and the Device registry; in a browser there is no PC id. Options: (1) the browser generates a random device id once in localStorage and the user types a device name, or (2) a default cash box per user. Not implemented until chosen.

### E. Server settings
- `.env.example`: `PORT`, `MONGO_URI`, `NOTA_JWT_SECRET`, `CORS_ORIGINS` (comma-separated allow-list).
- nginx serves the built Angular app (`dist/nota`) and proxies `/api/` to the backend; the backend serves no static files.

## Backups, nginx, the PWA and the customer website
Later stages.
