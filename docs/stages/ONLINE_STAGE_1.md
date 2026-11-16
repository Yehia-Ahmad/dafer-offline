# Online Stage 1 — Remove the offline (desktop/LAN) layer

Read before starting:
- docs/OFFLINE_PLAN.md (what each stage built, especially Stages 13–15, 19, 23)
- nota-backend/src/app.js, src/server.js, src/config/db.js, src/auth/*, src/middlewares/*, src/migrations/index.js
- nota-frontend/src/app/core/runtime/*, src/app/core/print/*, src/app/offline/*, src/main.ts, src/app/app.ts, angular.json, package.json

Start in plan mode and show me the plan before changing anything. Use Node 24 and a real mongod (replica set, transactions are required). Run long suites with a timeout and output to a file (never piped into head). Leave no test processes behind. Never use git worktree on Windows. Never touch C:\ProgramData\Nota, the installed Nota, or ports 27017/27217. Never commit; I commit after I review.

## Context
- This is the `online` branch, taken from `main`. The offline edition stays on its own branch and must not be touched.
- The online edition is the same shop system (same business logic, same pages, same permissions, same accounting) running as a normal web app: one Node backend + MongoDB on a Linux VPS (e.g. Contabo), one server per shop, used from a browser. A customer website and a mobile app (PWA) come in later stages, **not in this stage**.
- So everything that exists only because of the desktop/LAN setup goes: Electron, the bundled mongod, main PC / client PCs, LAN discovery and the LAN key, the firewall, the setup wizard, the desktop backup/restore, the installer.

## Hard rules
- **Do not change business logic**: selling, credit sales, returns, purchases, suppliers, customers, inventory, cash boxes, shifts, expenses, accounting (posting, periods, closing, opening, manual entries), VAT, reports, permissions. Only remove code paths that exist for the desktop/LAN setup.
- No refactoring or side improvements. If you notice something worth fixing, list it at the end of your reply instead of fixing it.
- Keep the migrations runner and all existing migrations as they are.
- Keep every existing test that covers business logic green. Delete only tests that test removed desktop/LAN code, and list each one with the reason.

## What to remove

### Frontend (nota-frontend)
1. `electron-offline/` (all of it, including pages/, lib/, test/), `electron/`, `installer-offline/`, `electron-builder.offline.json`, `scripts/offline/`, `build/icon.ico` (move the icon to `public/` only if the web app uses it).
2. `src/app/offline/` (backup page, connection overlay, other-main banner, version notice) and every place that uses them (routes, app.ts, sidenav entries, i18n keys).
3. `src/environments/environment.offline.ts`, the `offline` configuration in angular.json, the `environment.offline` flag in environment.model.ts.
4. package.json: the `build:offline`, `offline:*`, `test:offline`, `smoke:offline`, `electron:*` scripts, and the `electron` / `electron-builder` devDependencies. Regenerate package-lock.json.
5. `core/runtime/runtime-config.ts` and `app-features.ts`: remove the desktop bridge (`window.notaDesktop`, DesktopRuntimeConfig, connection state, backup types, `isOfflineMainPc`). The API base URL comes from the environment file (production: same origin `/api/`). Remove every `X-Nota-Lan-Key` / desktop header the HTTP layer adds.
6. Login page: remove the main-PC-only parts (setup owner from the wizard, recover only on the main PC). See decision B for what replaces them.
7. Printing (`core/print`): keep every document template, the print settings that still make sense in a browser, and the print reservation/count calls to the backend. Replace the Electron transport with browser printing only (the iframe + `window.print()` path that already exists for the dev browser). Remove "save PDF through the desktop dialog", the silent test print to a chosen printer, and printer selection; "save PDF" becomes the browser's print-to-PDF. Remove the `print.desktopOnly` paths and keys.
8. Remove i18n keys that are no longer used, in both ar and en.

### Backend (nota-backend)
1. LAN mode: `middlewares/lanSecret.middleware.js`, `routes/lan.routes.js`, `controllers/lan.controller.js`, the `NOTA_LAN_MODE` / `NOTA_LAN_SECRET` handling in app.js, and `test/lan-mode.test.js`.
2. Electron hooks in server.js: `process.parentPort` messages, `NOTA_LISTEN_HOST` (keep listening on `PORT`; if you think a bind host is needed behind nginx, say so at the end).
3. Audit inbox (`auth/auditInbox.js`, `NOTA_AUDIT_INBOX`, the drain in server.js): it only existed for backup/restore entries the desktop app wrote while the backend was stopped.
4. `localOnly()` on `/api/auth/setup-owner` and `/api/auth/recover`: see decision B.
5. config/db.js: remove what exists only for the bundled mongod (e.g. autoIndex off in LAN mode, local-only connection assumptions). The connection string comes from `MONGODB_URI` (or the existing variable name, say which).
6. `test/mongod-helper.test.js` and any helper that starts the bundled mongod, only if the remaining tests don't need them; tests may keep using a real local mongod.
7. `NOTA_APP_VERSION` only if it is used just by the desktop version check.

## Decisions

### A. Auth is always on
The online server is public, so the `NOTA_AUTH` switch goes: login, permissions, cost stripping, createdBy/updatedBy and audit are always enforced, as with `NOTA_AUTH=1` today. Remove the "auth off" code paths and update tests that run with auth off so they sign in. `NOTA_JWT_SECRET` is required at start (fail closed, as today).

### B. Creating the owner and recovery
There is no setup wizard and no "main PC". `setup-owner` and `recover` over HTTP would let anyone on the internet claim an empty shop, so:
- Add a server CLI script, e.g. `npm run create-owner -- --username ... ` (asks for the password on the terminal), that creates the owner and prints the recovery code once. It refuses if an owner already exists.
- Add `npm run recover-owner` on the server for a lost owner password (prints a new recovery code).
- The HTTP `setup-owner` and `recover` routes are removed (or answer 404). `bootstrap` stays only if the login page still needs it; update the permission route table test accordingly.

### C. `backup.manage`
Backups become the server's job (mongodump on a cron, documented in a later stage), not a screen in the app. Remove the backup page and the desktop backup IPC. In STEP 0, tell me whether to remove the `backup.manage` permission from the catalog or keep it unused; don't decide alone, because it touches users' stored permission lists.

### D. Devices and the default cash box (Stage 19)
Today the default cash box is chosen per PC through `X-Nota-Device-Id` and the Device registry. In a browser there is no PC id. In STEP 0, show me where `deviceId` is used (cashbox, print reservations, selling/credit-sale controllers, Device model) and propose one of:
1. keep the mechanism, with the browser generating a random device id once and storing it in localStorage (device name = a name the user types), or
2. replace it with a default cash box per user.
Do not implement either until I choose.

### E. Server settings
- One `.env.example` for the online backend: `PORT`, the Mongo URI, `NOTA_JWT_SECRET`, `CORS_ORIGINS` (comma-separated). Replace the open `cors()` with an allow-list from `CORS_ORIGINS` (the only security change in this stage).
- The backend can serve the built Angular app (`dist/`) from the same origin, or nginx serves it; propose one in STEP 0.

## Docs
- Create `docs/ONLINE_PLAN.md`: context (above), the general rules, this stage, and the decisions.
- `docs/OFFLINE_PLAN.md`, `docs/stages/*`, `nota-review/`: leave them as history; add one line at the top of OFFLINE_PLAN.md saying this branch is the online edition and the file describes the offline edition.
- Update `nota-frontend/README.md`, `PROJECT_OVERVIEW.md`, `GEMINI.md` so nothing describes Electron, the main PC or LAN anymore.

## STEP 0 (plan, before any change)
1. The full list of files and folders you will delete.
2. Every file you will edit, with one line per file on what changes.
3. Your answers for decisions C, D and E.
4. The tests you will delete, and why.

## Done means
- `grep -rniE "electron|notaDesktop|lan[-_ ]?(key|mode|secret)|X-Nota-Lan|main ?pc|client ?pc|parentPort|NOTA_LAN|NOTA_AUTH|auditInbox|offline" nota-backend/src nota-frontend/src` returns nothing except lines you list and justify (e.g. comments in migrations).
- Backend: `npm test` passes.
- Frontend: `npm run build` (production) passes, `npx ng test --watch=false --browsers=ChromeHeadless` passes.
- Manual check: start the backend with a `.env`, run `create-owner`, `ng serve`, log in, make a cash sale, a credit sale, a return, and print a receipt from the browser.
- Report at the end: what was removed, what was changed, the grep output, and the list of things you noticed but did not fix.
