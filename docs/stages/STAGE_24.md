# Stage 24 — Licensing and code protection

Read before starting:
- docs/OFFLINE_PLAN.md (the "Licensing" / "Protection" notes, the LAN/main/client model, Stage 15 auth + IPC rules)
- nota-frontend/electron-offline/ (main process, backend fork, mongod start-up, installer config)
- nota-backend/src/server.js, the migrations runner, the backup/restore code
- docs/stages/STAGE_22.md and STAGE_23.md: their hard rules apply

Start in plan mode and show me the plan before changing anything. Use Node 24 and a real mongod (Windows: bundled; Linux: NOTA_TEST_MONGOD). Run long suites with a timeout and output to a file (never piped into head). Leave no test processes behind. Never use git worktree on Windows. Never touch C:\ProgramData\Nota, the installed Nota, or port 27017.

## Goal
Nota is sold to many shops. After this stage:
- Nota runs only on the main PC its license was issued for, under the shop name in the license.
- Copying the installed app, the data folder or the license file to another PC does not give a working copy.
- Nobody at the shop can read or patch the backend code, open DevTools, or edit the database with another tool.
- The vendor (me) issues licenses with a private tool. The private key never ships and never enters the repo.

## Decisions (already made; implement exactly)

### 1. License model: lifetime only
- One license per shop, for the **main PC** only. Client PCs need no license; they work through the main PC, which enforces the client limit.
- Every license is **lifetime**: no expiry, no subscription, no trial, no grace period, no read-only mode. Keep a `type` field in the format so other types can come later, but accept only `"lifetime"` now (any other type → invalid).
- The first shop gets a free lifetime license like any other; it's just issued at no cost. No special code path.

### 2. Machine ID
- Source: Windows `HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid` (read with `reg query`, no native module).
- Machine ID = first 16 hex chars of SHA-256("nota-machine-v1:" + MachineGuid), uppercase, shown as `XXXX-XXXX-XXXX-XXXX`.
- On Linux (dev only): `/etc/machine-id`, same formula.
- A Windows reinstall changes the ID: the shop sends the new ID and gets a new license. The data on disk is untouched.
- STEP 0: confirm the backend process (forked by Electron) can read it, or have the main process pass it in.

### 3. License format and verification
- Ed25519 (Node `crypto`, no new dependency).
- Payload (JSON, canonical key order): `{ v: 1, licenseId, type: "lifetime", shopName, shopNameEn (optional), machineId, maxClients, issuedAt }`.
- License text: `NOTA1.<base64url(payload)>.<base64url(signature)>`. One line, so it can be pasted or saved as `nota.lic`.
- The **public key is compiled into the code** (backend and Electron main). No env var, setting or file can replace it.
- A license is valid only if: the signature verifies with the embedded key, `v` and `type` are known, and `machineId` equals this PC's ID.
- **Test key:** tests need to sign licenses. A test public key is accepted only when a build-time constant marks a dev/test build. It's baked in at build time, not read from a runtime env var. The production build (offline:stage / electron:build) contains only the production key. A test must assert that the staged backend rejects a test-key license.
- Storage: `C:\ProgramData\Nota\license\nota.lic` (Linux dev: the data dir), plus a copy in the database (`settings`) so client PCs can show the license info. The file is the source of truth, and it's re-verified on every start.

### 4. Enforcement
- **Backend** (server.js, on start and on every request through a middleware):
  - no valid license → every route answers `402 LICENSE_REQUIRED`, except `GET /api/license/status`, `POST /api/license/activate`, the health check, and what the activation screen needs;
  - verification runs once at start and again when the license changes, cached in memory (not per request).
- **Electron main:** checks the license too, and shows the activation screen instead of the app when it's missing or invalid. The backend check is the real lock; the main-process check is for the UI.
- **Activation screen** (ar/en, Nota design):
  - shows this PC's Machine ID with a copy button, and a "send this to the vendor" note;
  - a field to paste the license text, or a button to load `nota.lic`;
  - on success, shows the shop name and continues to first-run setup or login.
- **Who can activate:** with no license installed, activation is open (first run, before any owner exists). Replacing an existing valid license needs the owner (permission `shop.manage` + owner).
- Data is never deleted or changed by an invalid license. Reactivating with a new license on the same database works.
- **Order on first run:** install → activation → main/client choice → owner setup. Client PCs skip activation; they connect to a licensed main. If the main is unlicensed, the client shows "the main PC isn't activated".

### 5. Shop name locked to the license
- The shop profile's name (and the English name if the license has one) comes from the license and is read-only in the UI. The server rejects changes to it.
- Prints, the header and backups use the license name.
- **Existing database:** if the stored shop name differs from the license name, the license name wins after activation. The old name is kept in the audit log.

### 6. Client limit
- `maxClients` = how many client PCs may be connected/paired to this main at once.
- STEP 0: show how client PCs pair/identify today (X-Nota-Device-Id is not an auth factor; find what the pairing actually records).
- Enforce at pairing: pairing a new client beyond `maxClients` → refused with a clear message.
- The owner can see the paired clients and unpair one to free a slot.
- `maxClients: 0` = main PC only.

### 7. License info in the app
- Shop profile → "الترخيص" card (owner only; others see the shop name only): shop name, license ID, type (مدى الحياة), max clients and how many are used, Machine ID, issue date, and a "replace license" action.

### 8. The vendor's license tool (`tools/license-gen/`)
- A Node CLI in the repo (code only):
  - `keygen --out <dir>`: creates the Ed25519 key pair; refuses to overwrite.
  - `issue --key <private.pem> --machine XXXX-XXXX-XXXX-XXXX --shop "اسم المحل" [--shop-en "..."] --max-clients N [--out file.lic]`: prints the license text, writes the file, and appends a line to `issued-licenses.csv` next to the key (licenseId, date, shop, machine, maxClients).
  - `verify --pub <public.pem> <file.lic>`: decodes and checks a license.
- `.gitignore` covers `*.pem`, `*.key`, `issued-licenses.csv` and the key dir. A test fails if any private key appears anywhere in the repo or in the staged app.
- README in `tools/license-gen/`: how I create the keys once, keep the private key offline (USB plus a backup), put the public key into the code, and issue a license for a shop.
- I'll generate the production key myself. Ship with a clearly marked placeholder production public key, plus a step in the README to replace it. **Build guard:** `electron:build:win:offline` fails if the production key is still the placeholder.

### 9. Code protection
- **Backend code:** the shipped backend must not be readable JS.
  - STEP 0: propose between bytenode (V8 bytecode, compiled with the exact Electron/Node that runs the backend) and javascript-obfuscator, and how each fits the current fork/asar/resources layout.
  - Preference: bytenode if the backend runs on Electron's Node and works reliably; otherwise obfuscation.
  - At most these new dev dependencies, with exact versions at least two weeks old, reported before adding: bytenode and/or javascript-obfuscator, @electron/fuses.
  - The license check code and the embedded public key must be inside the protected code, not in a plain JS file.
- **Electron hardening:**
  - DevTools can't be opened in production builds: no menu item, no shortcut, and `devTools: false` in webPreferences;
  - no reload/zoom-reset shortcuts that expose internals;
  - context menu off in production.
- **Electron fuses** (@electron/fuses, applied in the build):
  - `EnableEmbeddedAsarIntegrityValidation` and `OnlyLoadAppFromAsar` on;
  - `EnableNodeOptionsEnvironmentVariable` and `EnableNodeCliInspectArguments` off;
  - `RunAsNode` off **only if** the backend no longer needs it. STEP 0: check how the backend is forked (ELECTRON_RUN_AS_NODE?). If it needs RunAsNode, propose moving it to `utilityProcess` or keep the fuse on and say why.
- **Tamper check:** at start, the main process verifies the protected backend files against hashes recorded at build time. A mismatch → a "the installation is damaged, reinstall" screen.

### 10. Database protection
- mongod runs with `--auth`. The replica set needs a `keyFile`, so generate one per install.
- On first start of this version:
  - generate a random admin user and a random app user (readWrite on the Nota DB only), each with a 32+ byte random password, plus the keyFile;
  - store the passwords encrypted with Electron `safeStorage` (DPAPI on Windows), in the data dir, and the keyFile with restricted file permissions;
  - the main process decrypts the password and passes the connection string to the backend fork in memory (env of the child is acceptable; never written to disk in plain text, never logged).
- mongod listens on 127.0.0.1 only. STEP 0: confirm the current bind and that LAN clients only ever talk to the backend, never to mongod.
- **Upgrade of an existing install** (the first shop already has data):
  - start mongod without auth on a random local port;
  - create the users;
  - restart with `--auth` + keyFile;
  - verify the connection, then continue.
  - A crash in the middle must be recoverable: re-running finishes the job, with no data loss and no locked-out database.
  - Cover this in `test:legacy-migration` (or a new upgrade test) on a real mongod.
- Backups and restore keep working with auth on, including restoring a pre-Stage-24 backup.

### 11. EULA
- An Arabic + English EULA text in the installer (NSIS license page), and accepted once on first run (stored with the date).
- Content (plain language): licensed for one shop and its main PC; no copying, resale, reverse-engineering or sharing; data belongs to the shop; no warranty beyond what the law requires; the vendor's contact.
- I'll review the wording; mark it as a draft in the report.

### 12. Left-over from Stage 23
- migrations/index.js ~617 and ~649: reword the comment and the migration name to "drop the old key_1_copyNo_1 index (unique or not)". The recorded name changes only for new runs; a database that already recorded the old name must not re-run or fail.

## STEP 0 — Findings (read-only, report before planning)
1. How the backend is started (fork / ELECTRON_RUN_AS_NODE / utilityProcess), where its code sits in the installed app, and what's readable today.
2. Machine ID: can the backend read MachineGuid itself; the Linux dev path.
3. mongod start-up: arguments, bind address, replica-set init, data dir; the safest upgrade path to `--auth` + keyFile for an existing install.
4. Client pairing today: what's recorded per client, where to enforce `maxClients`.
5. Where the shop name is stored and every place it's edited or used.
6. bytenode vs javascript-obfuscator for this layout (with sizes, start-up time, risks), and the fuses that are safe to set.
7. The first-run flow today (main/client choice, owner setup) and where activation fits.
8. The test setup: how tests will get a license (test key, build-time constant) without weakening production.

## STEP A — License core
Format, verification, the embedded key + build-time test key, machine ID, storage, backend middleware, status/activate endpoints, the Electron check, the activation screen, the shop-name lock, the license card, client limit.

## STEP B — Vendor tool
`tools/license-gen` (keygen / issue / verify), .gitignore, README, the no-private-key test, the placeholder build guard.

## STEP C — Protection
Backend code protection, DevTools/context menu off, fuses, tamper check.

## STEP D — Database auth
`--auth` + keyFile, generated users, safeStorage, the upgrade path, backups/restore.

## STEP E — EULA, docs, Stage 23 left-over

## STEP F — Tests
- **Backend:**
  - valid license → works;
  - no license, bad signature, wrong machine, unknown type or version, a tampered payload (shop name or maxClients changed) → 402 everywhere except the allowed routes;
  - activation open only when no license exists, and owner-only to replace;
  - the shop name is locked (UI field and server);
  - the client limit (pair up to N, N+1 refused, unpair frees a slot);
  - a test-key license is rejected by the production key set.
- **License tool:** keygen, issue → verify round trip; the backend accepts what the tool issues (with the test key); it refuses to overwrite keys; the CSV line is written.
- **Repo/staging:**
  - no private key in the repo or the staged app;
  - the staged backend is not plain JS (no readable source of a known file such as the license module);
  - the build fails with the placeholder key.
- **Electron:**
  - the activation screen when unlicensed;
  - DevTools blocked in production;
  - the tamper check catches a modified backend file;
  - fuses are set on the built binary (read them back with @electron/fuses).
- **Database:**
  - a fresh install starts with auth and works;
  - the upgrade of an existing database with data (real mongod), including a crash-in-the-middle resume;
  - an unauthenticated connection to mongod is refused;
  - backup + restore with auth on, including a pre-Stage-24 backup.
- **Existing suites** keep passing. The test helper installs a test license automatically, so the old tests don't change behaviour.
- **Smoke:** the license status, an unlicensed 402, activation, and the client limit.

## VERIFICATION
- backend: `npm test` (0 skipped)
- backend: `npm run test:legacy-migration`
- frontend: `npm run build:offline`
- frontend: `npx ng test --watch=false --browsers=ChromeHeadless`
- frontend: `npm run test:offline`
- frontend: `npm run smoke:offline`
- frontend: `npm run offline:stage`
- On Windows: `npm run electron:build:win:offline` with a test production key, made with the tool in a temp dir and never committed. Then put the placeholder back.

**Manual check on Windows** (only on a test PC or VM, never on the shop's PC):
- fresh install → EULA → activation screen with the Machine ID;
- issue a license with the tool → activate → owner setup → sell;
- copy the license to another PC → refused;
- edit a backend file in the installed app → the "damaged" screen;
- try DevTools shortcuts → nothing;
- try to connect to mongod with Compass/mongosh → refused;
- install over a Stage 23 install with data → everything is still there and works;
- pair clients up to the limit; one more is refused.

Update docs/OFFLINE_PLAN.md:
- mark Stage 24 done;
- record the license format, machine ID, enforcement, the vendor tool, the protection layers and DB auth;
- "Later": subscription licenses, trials, online activation.

Do not commit.

## Final report — exactly this, in one code block
```
=== STAGE 24 REPORT ===
STEP 0 findings (backend start, machine ID, mongod, pairing, shop name, protection choice, first-run flow, test license):
License core (format, key handling, verification, enforcement, activation, shop-name lock, license card, client limit):
Vendor tool (commands, files, README, guards):
Code protection (method, fuses, DevTools, tamper check, size/start-up impact):
Database auth (users, keyFile, safeStorage, upgrade path, backups):
EULA (draft text location):
Stage 23 left-over:
New dependencies (name, exact version, why):
Backend tests (new / total / skipped):
Frontend tests (new / total):
Electron tests (new / total / skipped):
Smoke test (summary + new lines):
Build (staged size before/after, installer built?):
Manual check (each step, or needs Windows):
Docs updated:
Open questions / anything you didn't do:
```
