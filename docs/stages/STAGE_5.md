# Stage 5 — Remove leftovers (old builds, unused assets, stubs)

Read docs/OFFLINE_PLAN.md first. Start in plan mode and show me the plan before changing anything.

This stage only deletes things the Stage 4 report found unused. No behavior change for users.

## STEP 0 — Update the plan file

In docs/OFFLINE_PLAN.md, replace the "Cleanup plan" list with:
1. Remove Firebase and push notifications. (done)
2. Remove website code from the backend. (done)
3. Remove website settings, add ShopProfile. (done)
4. Remove website code from the frontend. (done)
5. Remove leftovers: old non-offline build files, unused assets, unused stubs, unused i18n keys.
6. One-time migration that cleans old website data from existing databases.
7. Branding: replace user-visible Kapomatic name/logo with the final product name (after the name is decided). Internal identifiers (kapomatic:* IPC channels, window.kapomaticDesktop, KAPOMATIC_* env vars, X-Kapomatic-Lan-Key, kapomatic_warehouse DB name, backup file prefixes, discovery/quit protocol strings, secret-store entropy, 'not-kapomatic' state, backend health check app name) stay unchanged so existing installs keep working.

Under "Agreed decisions for later phases", add:
- Selling.shippingLocation and Selling.government are website leftovers (the offline frontend never sends or reads them). Remove them together with the createSellingInvoice options param in the accounting phase. shippingFees on Selling and CreditSale is a real POS field and stays.
- The Admins page (modules/admin, route /admins, AdminsService) calls /users, /users/:id and /auth/signup, which do not exist yet. Replace or reuse it in the users/permissions phase.

## STEP A — Old non-offline build files (delete)

Before deleting each item, grep the whole kapomatic-frontend (excluding node_modules, dist*, release*, offline-stage) to confirm only the items below reference it.
- electron/main.js (keep electron/before-build.js; it is used by electron-builder.offline.json)
- package.json: "main" field (only if nothing offline uses it; stage.js writes its own package.json), the non-offline "build" block, and the scripts build:desktop, prepare:desktop, electron:start, electron:build:dir, electron:build:win:dir, electron:build:win:zip, electron:build:win, serve:ssr:okland-warranty-system
- desktop/ folder
- scripts/prepare-desktop.js, scripts/electron-builder-debug.js
- src/environments/environment.prod.ts (confirm angular.json has no fileReplacements pointing to it)
- angular.json: any configuration that only served the deleted desktop/SSR builds (report what you remove)
- Keep build/icon.ico.
- Do NOT change package.json "name", "description", "author" yet (branding stage).
- If .vscode/launch.json or tasks.json reference deleted scripts, update them.

## STEP B — Unused assets (delete)

Delete exactly the unused assets listed in the Stage 4 report, after re-checking each one has zero references in src, angular.json, styles, index.html and electron-offline:
- src/assets/img: Kapo.jpeg, qr.png, Okland Typography (Orange).png. Also remove the commented-out HTML in header.component.html that references the Okland image.
- src/assets/svg: Admins, Arrow, Categories, Door Open (Log out), Hamburger Menu (Closed), Hamburger Menu (Opened), Invoice, lion, moon, Okland Typography, Sun, Upload, Upload 2, Warranty
- src/assets/fonts: Azonix.otf, MajorMonoDisplay-Regular.ttf, Roboto-Italic-VariableFont_wdth,wght.ttf, the sinkin-sans/ folder (keep the top-level SinkinSans-500Medium.otf)
- public/: everything except favicon.ico. Check angular.json test config: if it copies public/**, make sure no spec depends on those files; adjust the test config if needed and report it.
- Keep: svg/Kapo.svg, img/lion.png (splash), Montserrat, Roboto variable, SinkinSans-500Medium.otf, favicon.ico.
- Do not rename or touch the "Azonix" font-face; just report what it loads.

## STEP C — Unused stubs (delete)

- modules/category/components/add-product (empty, unused stub)
- modules/assets/admins (unused stub component)
- Any other component under modules/assets or elsewhere that nothing imports or routes to (e.g. warranties, if unused). List each one with proof (grep) before deleting. Do NOT delete modules/admin (the Admins page) — it is kept for the permissions phase.

## STEP D — Unused i18n keys (pre-existing)

In src/assets/i18n/ar.json and en.json, remove keys that nothing uses (the Stage 4 report mentioned warranty, validationForm, logout, errors, product, upload, warrant, and some admin/category/tableHeaders keys). Same rules as Stage 4:
- grep src for each key and its prefix, including dynamic keys built with string concatenation or template literals; keep anything that might be dynamic and list it.
- Keep every key used by the Admins page (modules/admin).
- Keep ar and en aligned. ar has 2 extra keys (category.editProduct.watt, category.editProduct.lumen): if they are used, add the missing en translations ("Watt", "Lumen"); if unused, remove them from ar.

## STEP E — Angular unit specs (report only)

Try to run the Angular specs once in headless mode (e.g. ng test --watch=false --browsers=ChromeHeadless). Do not fix anything. Report: whether it runs at all, how many specs pass/fail, and whether the failures look like long-standing stale default specs or real breakage from Stages 1–4. If it cannot run (no Chrome, Karma config issue), say why and stop there.

## VERIFICATION (run all even if one fails)

- cd kapomatic-backend && npm test
- cd kapomatic-frontend && npm run test:offline
- cd kapomatic-frontend && npm run build:offline (no new errors or warnings; report the bundle size before and after if the build prints it)
- cd kapomatic-frontend && npm run smoke:offline
- cd kapomatic-frontend && npm run offline:stage, then confirm the staged output still contains the app, the backend and the icon, and nothing deleted in this stage is referenced by it.
- grep kapomatic-frontend (excluding node_modules, dist*, release*, offline-stage) for: prepare-desktop, electron-builder-debug, desktop/, environment.prod, okland, Okland, Warranty, warranties, MajorMono, sinkin-sans. Expected: no matches (except docs/OFFLINE_PLAN.md if it mentions them).

Do not commit.

## Final report — exactly this, in one code block

```
=== STAGE 5 REPORT ===
Plan file updated (yes/no):
Deleted files/folders (grouped: build files, assets, stubs):
package.json changes (fields and scripts removed):
angular.json / .vscode changes:
i18n keys removed (groups), keys kept because they may be dynamic, and what happened to watt/lumen:
Angular specs (ng test): ran or not, pass/fail counts, assessment:
Backend npm test: pass / fail, full error if any:
npm run test:offline: pass / fail, full error if any:
npm run build:offline: success / failure; warnings; bundle size before/after:
Smoke test (summary line + any ✗):
offline:stage check:
grep results (every matching line):
Unexpected findings or decisions needed from me:
git status --short:
```
