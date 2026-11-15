# Nota release checklist

For the person who builds and ships a version (the "release manager"). One command builds the installer; this list is what to do around it.
Shop-facing steps are in Arabic: `FIRST_SHOP_UPGRADE_AR.md`, `SMARTSCREEN_AR.md`, `PRINTER_CHECK_AR.md`.

## Before the build

- [ ] On the release PC: Windows, Node 24 first on PATH (`nvm use 24.22.1`), `npm ci` in `nota-frontend` and `nota-backend`, `npm run offline:vendor` once (MongoDB tools and the VC++ runtime).
- [ ] The **version** is `nota-frontend/package.json` `"version"`. Raise it (semver, `x.y.z`). Nothing else holds a version: `edition.json`, the installer name, the login footer, the About page, backups and diagnostics all read it. A version that was already released is never reused (`release:win` refuses to overwrite `release-offline/<version>/`).
- [ ] `nota-frontend/CHANGELOG.md` has a `## <version> - <date>` section with an Arabic (`### ar`) and an English (`### en`) list. This is what the "what's new" window shows once after the upgrade. The build refuses a version without it.
- [ ] A new database migration? Then it is in `nota-backend/src/migrations/index.js`, has a test, and a legacy-data test (`npm run test:legacy-migration`). The app takes a `before-upgrade-*` backup before the first pending migration on its own, and refuses data written by a newer Nota. Nothing to configure.
- [ ] The **license key pair** exists (`tools/license-gen/README.md`, step 1) and the private key is **only** on your offline USB stick(s), never in the repo, never on the build PC's disk longer than needed. The build only ever needs the **public** key file.
- [ ] Optional: a **code signing certificate** (`.pfx`). Without one the installer is unsigned and Windows SmartScreen warns (see `SMARTSCREEN_AR.md`). With one: `set CSC_LINK=C:\path\cert.pfx` and `set CSC_KEY_PASSWORD=...` in the same window, never in a file. `release:win` then turns signing on by itself.

## Build

```
set NOTA_RELEASE_PUBLIC_KEY_FILE=D:\nota-keys\public.pem
npm run release:win
```

It stops at the first failure and runs, in order: key file check, changelog check, backend `npm test` (0 skipped) and `test:legacy-migration`, `ng test`, `ng build`, `offline:vendor`, `offline:stage` (the key goes into the **staged** backend only; the repo's `keys.js` keeps its placeholder), `test:offline`, `smoke:offline`, build-guard, electron-builder.

- [ ] It ended with `[release] done: release-offline\<version>\Nota-Setup-<version>.exe`.
- [ ] `release-offline\<version>\` holds the installer, `Nota-Setup-<version>.exe.sha256`, `release-note.md` and `sourcemaps\`. Read `release-note.md`: **tests** line says all passed (not SKIPPED), the **key fingerprint** is the one you expect, **signing** says what you intended.
- [ ] Copy the whole `release-offline\<version>\` folder to a safe place (the `sourcemaps\` are how a support file's stack trace is read later; they are not in the installer). Keep them as long as the version is in use.
- [ ] `release:win` refuses to start with `NOTA_ALLOW_PLACEHOLDER_KEY`, `NOTA_NO_BUNDLE` or `NOTA_ALLOW_SKIP` set. If it complains, unset them: they exist for development only.

## Check the installer on a clean PC (once per release, 20 minutes)

Use a PC (or a Windows VM) that never had Nota. Follow `MANUAL_TESTS_STAGE24_25.md`, at least the **High** cases: install, EULA, activation with a license made for that PC, first run setup, a sale and a receipt print, backup and restore, uninstall keeping the data, install again over the kept data, and the installer in Arabic and in English.

- [ ] SHA-256 on that PC matches the `.sha256` file: `certutil -hashfile Nota-Setup-<version>.exe SHA256`.
- [ ] If the version has a migration: install it **over the previous version with some data** (the first shop's copy, on a throwaway PC or VM), confirm the `before-upgrade-*` file appears in `C:\ProgramData\Nota\backups`, and run the rollback from `FIRST_SHOP_UPGRADE_AR.md` once.
- [ ] Printer: `PRINTER_CHECK_AR.md` on the shop's real receipt printer the first time, or when the printer model changes.

## Ship

- [ ] Send the installer (USB stick or a private link) together with its SHA-256. Tell the shop to read `SMARTSCREEN_AR.md` if Windows warns.
- [ ] Every PC of a shop gets the **same** version: the client PCs show a warning when their version differs from the main PC's.
- [ ] Issue the shop's license as usual (`tools/license-gen/README.md`, step 3).
- [ ] Record: version, build number, SHA-256, date, which shops got it.

## When a shop has a problem

Ask the owner or a manager to open **Settings → About → Export diagnostics file**, save the zip and send it to you. It holds versions, status, settings (no secrets), backup file names and the tail of the logs with passwords, tokens, license text, e-mails and phone numbers removed, and no shop data. To read a stack trace in it:

```
node scripts/offline/decode-stack.js stack.txt release-offline\<version>\sourcemaps
```

## What is deliberately not in this release

Code signing (needs a certificate), automatic updates (a new version is a new installer file), mongod as a Windows service, 58 mm paper, cash paid / change in the POS, split payment, ETA e-invoice. They are listed under "Later" in `docs/OFFLINE_PLAN.md`.
