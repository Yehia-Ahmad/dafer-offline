# Stage 25 — Release: the first shippable Nota

Read before starting:
- docs/OFFLINE_PLAN.md (Stage 23–24 blocks, the "Later" list)
- docs/stages/STAGE_24.md and the Stage 24 code: the license, protection, integrity, db-auth, build guards
- tools/license-gen/README.md
- nota-frontend/electron-offline/ (installer config, afterPack, stage scripts), the backup/restore code, the migrations runner
- docs/stages/STAGE_22.md–STAGE_24.md: their hard rules apply

Start in plan mode and show me the plan before changing anything. Use Node 24 and a real mongod. Run long suites with a timeout and output to a file (never piped into head). Leave no test processes behind. Never use git worktree on Windows. Never touch C:\ProgramData\Nota, the installed Nota, or ports 27017/27217. Never put a real private key anywhere in the repo or the build; keys.js keeps the placeholder in the repo.

## Goal
After this stage I can:
- build a release installer with my real key;
- install it on a clean PC and on the first shop's PC (over their current version, keeping their data);
- send later versions as installer files;
- support shops with a diagnostics file they send me on WhatsApp.

## Decisions (already made; implement exactly)

### 1. No code signing yet
- Don't buy or configure a certificate. Keep the build ready for one: a documented `CSC_LINK` / `CSC_KEY_PASSWORD` path in the builder config, unused while they're unset, and the build must still succeed without them.
- Write a one-page Arabic guide for shop owners (docs/release/SMARTSCREEN_AR.md): the blue "Windows protected your PC" screen → "More info" → "Run anyway", with the installer's exact name and size so they can check it's the real file.
- "Later": code signing.

### 2. Updates = a new installer file
- No auto-update, no network calls, no update server.
- **Installing over an older version** keeps the data, the license, the settings, the DB credentials and the device pairing.
- **Before the new version runs any migration**, it takes an automatic backup (`before-upgrade-<from>-<to>-*`) with the existing backup service. If the backup fails, the upgrade stops with a clear message and the old data is untouched.
- **Downgrade guard:** an older installer over a newer database (a schema version higher than the app knows) refuses to start, with a clear ar/en message ("this data needs a newer Nota"). It must not migrate down or touch anything.
- **Version display:** the app version and build number on the login screen footer, in the license card and in Settings → "عن البرنامج". The installer file name has the version: `Nota-Setup-<version>.exe`.
- **What's new:** after an upgrade, the owner sees a short "what's new" dialog once, from `CHANGELOG.md` (ar/en sections for that version).
- Version: 1.0.0 for this release. One source of truth (package.json), shown everywhere and written into backups and diagnostics.

### 3. Faster cold start: bundle the backend
Opus measured the tamper check at about 7 s on a cold start (Defender scans each of ~4,300 files on first read), and the backend's own start opens ~1,400 files.
- **Spike first:** bundle the backend and its dependencies into one file with esbuild (the only new dependency allowed; exact version at least 2 weeks old; report it before adding), then compile that file to bytecode with the existing bytenode step.
  - Keep external: mongodb's optional packages (kerberos, snappy, zstd, mongodb-client-encryption, the AWS/GCP credential providers, etc.), anything native, and anything that breaks bundled (report which).
  - Watch out for libraries that read their own source (`Function.prototype.toString`), dynamic `require` paths, `__dirname`-relative file reads (templates, fonts, migrations), and the license module's load order (it must still load first and capture its references).
  - Error stack traces: keep them useful. Emit a source map for the build, but never ship it; keep it with the release artifacts for me.
- **If bundling works:** the tamper check covers the bundle, the stub loader, package.json and whatever stays in node_modules. Remove the files the bundle replaced from the staged backend.
- **If it doesn't work reliably:** report why, keep the current layout, and do the fallback below.
- **Either way:** strip docs, types, maps, tests and examples from the staged node_modules (README*, CHANGELOG*, *.md, *.d.ts, *.map, test/, docs/, example/; never LICENSE files, which must stay for license compliance). Then re-run the whole suite set on the staged backend.
- **Measure and report:** cold and warm tamper-check time, backend start time and file count, before and after, on a fresh copy (same method as Opus: first read in a new process, Defender on).

### 4. Diagnostics file for support
- Settings → "عن البرنامج" → "تصدير ملف تشخيص" (owner and manager). It saves a zip through a save dialog.
- **Contents:**
  - the app version and build number, Windows version, main/client mode;
  - license ID, shop name, maxClients and the paired count;
  - schema version and the migration log;
  - the last N days of app and backend logs;
  - the health-check results (all the accounting health checks, pass/fail with numbers);
  - disk free space, the backup list (names, dates, sizes) and the time of the last backup;
  - mongod's last log lines.
- **Never included:** passwords, the DB credentials, the keyFile, the JWT secret, LAN keys, the main token, the license text, recovery codes, customer/supplier names and phones, invoice contents, any document data.
- A redaction pass over the logs removes anything shaped like a token, key, password, phone number or email. Tests feed known secrets into the logs and assert none of them appear in the zip.
- The file name has the shop's license ID and the date, so I can tell files apart on WhatsApp.

### 5. Backup reminders
- STEP 0: report what backup scheduling exists today (automatic? where? how many kept?).
- If there's no automatic daily backup on the main PC, add one: once a day at the first start after midnight (or a set time in Settings), keep the last 14, plus the before-restore and before-upgrade ones.
- If the last successful backup is older than 3 days, the owner sees a banner on the home page with a "take a backup now" button, and a strong note to copy backups to a USB or another PC.
- The backup folder can be changed in Settings (for example to a second drive). Test that a backup taken there restores.

### 6. Installer behaviour
- The NSIS installer has Arabic and English (it follows Windows' language, with a picker), the EULA page, a desktop and Start-menu shortcut, and installs per machine.
- **Uninstall:** keeps C:\ProgramData\Nota (data, backups, license, security) by default. A separate, clearly marked checkbox "delete all my data" (off by default) deletes it only after a second confirmation. Test both.
- **Installing while Nota is running:** the installer asks to close Nota, and closes the backend and mongod cleanly before replacing files.

### 7. The first shop's upgrade
The first shop runs a pre-Stage-24 build with real data. Write an Arabic runbook (docs/release/FIRST_SHOP_UPGRADE_AR.md), step by step, for me to follow at the shop:
1. On the old version: take a backup and copy it to a USB. Note the key numbers (cash box balances, customer balances total, stock value, last invoice number), with the exact screens to read them from.
2. Install the new version over the old one.
3. EULA → the activation screen → send me the Machine ID on WhatsApp → I issue the license → paste it.
4. Check the same numbers and run the health checks; all must match.
5. Set the receipt printer, print a test page and a receipt (the 80mm checklist in decision 8).
6. Client PCs: install the same version, connect, check the limit.
7. **Rollback:** if anything doesn't match, uninstall without deleting data, reinstall the old installer, restore the backup from step 1. Write exactly how, and test this path on a throwaway copy (a pre-Stage-24 database with data → upgrade → restore the pre-upgrade backup on the old version).

### 8. The real 80mm printer test (at the first shop)
- Add a "calibration" test page for the receipt printer: a ruler across the full width (mm marks), the shop header, Arabic and English text, a Code 128 barcode, a long item line, and a "cut here" line.
- Add receipt print settings if they're missing: horizontal offset (mm) and printable width (72/76/80 mm), per device, applied to every 80mm document.
- Write a short Arabic checklist (docs/release/PRINTER_CHECK_AR.md): the width is right, nothing is cut off on either side, the paper cuts after the receipt (driver setting), the barcode scans with the shop's scanner, Arabic is sharp, a reprint shows "نسخة ٢".

### 9. The production key and the release build
- Use the existing tools/license-gen. Write docs/release/RELEASE_CHECKLIST.md, the steps I follow for every release:
  - the key: generate once, store offline (USB + a second copy), put the public key into keys.js only in a local release checkout, never commit it;
  - build: `npm run release:win` (new), which runs every suite, stages, builds, runs the build guard, and writes `release-offline/<version>/` with the installer, its SHA-256, the source map, and a short release note;
  - verify: install on a clean Windows (Windows Sandbox steps included), the manual checks list, the printer check;
  - deliver: the installer file + its SHA-256 (for the SmartScreen guide), the changelog.
- Decide and document how keys.js gets the real public key for a release without it ever being committed (e.g. `NOTA_RELEASE_PUBLIC_KEY_FILE` read only by the release script, which writes it into the staged copy only; the build guard checks the staged key is not the placeholder and not the test key). The repo's keys.js stays the placeholder.

### 10. Clean-up
- Fix the DEP0190 warning (child_process with shell and args) and any other Node deprecation warnings printed during the suites or at app start.
- Run `npm audit` in the backend and frontend. Report the findings. Fix the ones in shipped (non-dev) dependencies when a patch release exists; list the rest.
- The EULA: put the full Arabic and English text in your final report so I can review it. **Keep the draft mark**; I'll remove it after review.

### 11. Manual test files
- Add the Stage 24 cases (activation, license card, client limit, revoke/allow, DevTools blocked, tamper check, second Windows account, installing over an old version) and the Stage 25 cases (upgrade backup, downgrade guard, what's new, diagnostics, backup reminder, uninstall with/without data, calibration page) to docs/release/MANUAL_TESTS_STAGE24_25.md as a table (case, user, steps, expected, priority). I'll merge them into my Excel/Word files.

## STEP 0 — Findings (read-only, report before planning)
1. The backend's file layout, the dynamic requires, the file reads relative to `__dirname`, and what would stop an esbuild bundle. Propose the externals list.
2. How the version is defined and shown today.
3. What happens today when an older app opens a newer database, and when a newer one opens an older one (the backup before migrations?).
4. Backup scheduling today (automatic? retention? folder?).
5. The installer config: languages, per-machine, uninstall behaviour, shortcuts, closing a running Nota.
6. The current receipt print settings (width/offset?).
7. Every Node deprecation warning printed during the suites and at start.
8. `npm audit` summary (counts by severity, shipped vs dev).
9. How the release key would reach the staged copy without being committed.

## STEPS
- A — Bundling spike + strip (decision 3), with measurements.
- B — Upgrade safety: the pre-migration backup, the downgrade guard, the version everywhere, what's new.
- C — Diagnostics + backup reminders.
- D — Installer behaviour + uninstall.
- E — Printer calibration page + receipt settings.
- F — Release script, checklist, runbooks (first shop, SmartScreen, printer), key handling.
- G — Clean-up (deprecations, audit), manual test cases, docs.

## Tests
- **Bundled backend:** all backend suites, smoke and the staged-backend tests pass on the bundled staged build; the tamper check catches a changed bundle; the license module still loads first (the forged-license-after-load test still passes).
- **Upgrade:**
  - a pre-Stage-24 database with data → the new version: a backup is taken first, then the migrations, then the auth upgrade, with all data intact;
  - a backup failure stops the upgrade without changes;
  - the downgrade guard refuses and changes nothing;
  - "what's new" shows once.
- **Diagnostics:** the zip contents match the list; a redaction test with planted secrets (token, key, password, phone, email, a customer name) finds none of them; permissions (owner/manager only).
- **Backups:** the daily automatic backup, retention 14, the 3-day banner, a custom folder backup + restore.
- **Uninstall:** the default keeps the data; the checkbox + confirm deletes it (test the uninstaller logic; the real uninstall is in the manual list).
- **Printer:** the calibration page renders; the offset and width settings apply to every 80mm document (spec per document).
- **Release script:** it fails with the placeholder key, fails with the test key, and passes with a temp key (deleted afterwards); it writes the SHA-256 and does not put the source map in the installer.
- **Existing suites** keep passing.

## VERIFICATION
- backend: `npm test` (0 skipped)
- backend: `npm run test:legacy-migration`
- frontend: `npm run build:offline`
- frontend: `npx ng test --watch=false --browsers=ChromeHeadless`
- frontend: `npm run test:offline` (stage first)
- frontend: `npm run smoke:offline`
- frontend: `NOTA_ALLOW_PLACEHOLDER_KEY=1 npm run offline:stage`
- On Windows: `npm run release:win` with a temp key from the tool in a temp dir, deleted afterwards. Report the installer size and the measurements.

Update docs/OFFLINE_PLAN.md:
- mark Stage 25 done;
- record the bundling, upgrade safety, diagnostics, backups, installer, the release process;
- "Later": code signing, auto-update, mongod as a Windows service, 58mm paper, cash paid/change in the POS, split payment, ETA e-invoice.

Do not commit.

## Final report — exactly this, in one code block
```
=== STAGE 25 REPORT ===
STEP 0 findings (bundling blockers + externals, version, old/new DB behaviour, backups today, installer, receipt settings, deprecations, audit, release key path):
Bundling (result, externals, removed files, measurements before/after: cold/warm tamper check, backend start, file count, installer size):
Upgrade safety (pre-migration backup, downgrade guard, version display, what's new):
Diagnostics (contents, redaction, permissions):
Backups (automatic daily, retention, banner, custom folder):
Installer (languages, shortcuts, uninstall keep/delete, closing a running Nota):
Printer (calibration page, offset/width settings):
Release (release:win, key handling, artefacts, checklist, runbooks written):
Clean-up (deprecations fixed, npm audit before/after, what's left):
EULA full text (ar + en, still marked draft):
Manual test cases file:
New dependencies (name, exact version, why):
Backend tests (new / total / skipped):
Frontend tests (new / total):
Electron tests (new / total / skipped):
Smoke test (summary + new lines):
Manual check (each step, or needs Windows/clean PC):
Docs updated:
Open questions / anything you didn't do:
```
