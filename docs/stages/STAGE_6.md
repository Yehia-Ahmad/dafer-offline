# Stage 6 — Branding: Kapomatic → Nota

Read docs/OFFLINE_PLAN.md and docs/design/NOTA_DESIGN_SYSTEM.md first. Start in plan mode and show me the plan before changing anything.

Context: the product is now called **Nota** (Arabic: **نوتة**). This is a new product with no existing installs, so every identifier can change, including internal ones (DB name, env vars, IPC channels, LAN header, folders). This stage changes names, icons and logos only. No business logic changes.

## STEP 0 — Inventory (read-only)

1. grep the whole repo (excluding node_modules, dist*, release*, offline-stage, vendor, .git, docs/design) case-insensitively for: `kapomatic`, `kapo`, `okland`, `كابوماتيك`. Group the hits into:
   - A. User-visible text and assets (titles, headings, installer names, shortcuts, window titles, messages, logos, icons, Excel metadata, i18n)
   - B. Internal identifiers (DB name, env vars, header names, IPC channels, window globals, protocol strings, file prefixes, folder paths, firewall rules, health-check app name, secret-store entropy, state names)
   - C. Package / project names (package.json name/description/author, angular.json project id, appId, artifactName)
   - D. Folder names (kapomatic-backend, kapomatic-frontend) and every path that references them
   - E. Docs and READMEs
2. Show me the full grouped list with file + line before changing anything.
3. Tell me what package.json "author" currently is in both packages. If it is a person's name, keep it; if it is "Kapomatic", replace it with "Nota".

## STEP A — Single source for the product name

- Electron side: `electron-offline/edition.json` is the source. Set productName "Nota", and a description such as "Nota — sales, inventory and accounts for shops (offline)". Make sure main.js, setup/status pages, backend-manager, firewall, paths and stage.js read the name from there wherever they currently hardcode it, when that is a simple change. If a place cannot read it easily (e.g. electron-builder JSON), hardcode "Nota" and list it.
- Angular side: create one constant (e.g. `src/app/core/brand.ts` exporting `{ nameAr: 'نوتة', nameEn: 'Nota' }`) or an i18n key `app.name` in ar/en, and use it everywhere the app shows the product name.

## STEP B — Rename everything

Replace per group, using these exact new values:

| Old | New |
|---|---|
| Product name (user-visible) | Nota / نوتة |
| DB name `kapomatic_warehouse` | `nota` |
| Env vars `KAPOMATIC_*` (LAN_MODE, LAN_SECRET, LISTEN_HOST, and any other) | `NOTA_*` |
| Header `X-Kapomatic-Lan-Key` / `x-kapomatic-lan-key` | `X-Nota-Lan-Key` / `x-nota-lan-key` |
| IPC channels `kapomatic:*` | `nota:*` |
| `window.kapomaticDesktop` | `window.notaDesktop` |
| `'not-kapomatic'` state | `'not-nota'` |
| Health check `app === 'kapomatic-backend'` | `'nota-backend'` (backend and the Electron check must match) |
| Backup prefixes `kapomatic-backup-`, `kapomatic-auto-backup-` | `nota-backup-`, `nota-auto-backup-` |
| `C:\ProgramData\Kapomatic Offline` | `C:\ProgramData\Nota` |
| Firewall rule names | `Nota Server`, `Nota Discovery` (or the same pattern as today with Nota) |
| Discovery / quit protocol strings, secret-store entropy | same strings with `nota` instead of `kapomatic` |
| Service name `Kapomatic Offline Server` | `Nota Server` |
| electron-builder appId | `app.nota.offline` |
| electron-builder productName / shortcutName | `Nota` |
| artifactName | `Nota-Setup-${version}.${ext}` |
| package.json name | `nota-frontend` / `nota-backend` |
| angular.json project id `okland-warranty-system-v2` | `nota` (update every buildTarget that references it) |
| app.ts title signal | remove it if unused; otherwise `'Nota'` |
| index.html `<title>` | `نوتة` |
| "Kapomatic Store" heading in category-details | the category name or "الأصناف" (no product or shop brand) |
| Excel `workbook.creator` | `Nota` |
| runtime-config.ts error text, main.js / setup-controller.js Arabic messages, setup.html / status.html titles and headings | same text with Nota / نوتة |

Also:
- Update the smoke test, lan-mode.test.js and every electron-offline test to the new env vars, header, health-check name, prefixes and paths.
- Remove `provideClientHydration` from app.config.ts (SSR leftover; the app has no SSR).
- Update i18n strings in src/assets/i18n/ar.json and en.json that mention the old name.

## STEP C — Icons and logos

Assets are in `docs/design/brand/`.
- `kapomatic-frontend/build/icon.ico` ← `docs/design/brand/icon.ico` (installer, shortcut and window icon). Make sure the Electron BrowserWindow uses this icon (or a PNG from the same set) if it sets one.
- `kapomatic-frontend/public/favicon.ico` ← `docs/design/brand/favicon.ico`.
- Copy `nota-icon.svg`, `nota-icon-small.svg`, `nota-mark-light.svg`, `nota-mark-dark.svg` to `src/assets/svg/`.
- Header and home: replace `Kapo.svg` with the Nota logo: the tile icon (`nota-icon.svg`) followed by the word "نوتة" (Arabic) or "Nota" (English) in bold, using the current font for now (the Alexandria font comes in Stage 7). In dark mode use the same tile icon (it works on dark backgrounds).
- Electron setup.html / status.html: show the Nota icon next to the title if they currently show a logo or title.
- Delete `src/assets/svg/Kapo.svg` after nothing references it.

## STEP D — Invoice footer brand line

In both print utilities the brand-free system line becomes: "تم إنشاء هذه الفاتورة إلكترونيًا بواسطة نوتة" / "This invoice was generated electronically by Nota", taken from the i18n keys and the brand constant from STEP A. Keep the shop's invoiceFooter above it as today.

## STEP E — Docs

- READMEs, PROJECT_OVERVIEW.md, GEMINI.md: replace the old names.
- docs/OFFLINE_PLAN.md: mark Cleanup item 6 (Branding) as done, and add a new section "Phase 2 — Nota design" with the stages: 6. Branding (done), 7. Design foundation (tokens, Alexandria font bundled locally, Material/PrimeNG/Tailwind theme, shared components), 8. App shell (grouped sidebar, header, user card), 9. Sales screens redesign, 10. Remaining screens redesign + dashboard. Then list the later phases: Users & permissions, Accounting.

## STEP F — Folder rename (do this last, only after STEP A–E pass verification)

1. `git mv kapomatic-backend nota-backend` and `git mv kapomatic-frontend nota-frontend`.
2. grep the whole repo for `kapomatic-backend` and `kapomatic-frontend` and fix every path (stage.js, after-pack.js, backend-manager, smoke-test.js, run-tests.js, electron-builder.offline.json, .vscode, READMEs, docs/OFFLINE_PLAN.md, docs/design/NOTA_DESIGN_SYSTEM.md if needed).
3. Run the full verification again.
If anything in this step looks risky (absolute paths, Windows-specific scripts), stop and tell me before changing it.

## VERIFICATION (run all even if one fails; run once after STEP E and again after STEP F)

- backend: npm test
- frontend: npm run test:offline
- frontend: npm run build:offline
- frontend: npx ng test --watch=false --browsers=ChromeHeadless
- frontend: npm run smoke:offline
- frontend: npm run offline:stage, then confirm the staged app and backend contain no "kapomatic" (excluding node_modules licenses)
- grep -ri "kapomatic\|kapo\b\|okland\|كابوماتيك" across the repo (same exclusions as STEP 0). Expected: no matches.

Do not commit.

## Final report — exactly this, in one code block

```
=== STAGE 6 REPORT ===
Inventory summary (count per group A–E):
package.json author (before → after):
Single source of the product name (Electron / Angular):
Renamed identifiers (old → new, one line each):
Places that still hardcode "Nota" and why:
Icons and logos replaced (file → where used):
Invoice footer line:
Docs updated:
Folder rename: done / not done, paths fixed:
Backend npm test (after E / after F):
npm run test:offline (after E / after F):
npm run build:offline (after E / after F):
ng test (after E / after F):
Smoke test summary (after E / after F):
offline:stage check:
Final grep results (every matching line):
Unexpected findings or decisions needed from me:
git status --short (summary is fine if very long):
```
