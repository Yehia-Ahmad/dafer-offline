# Stage 4 — Remove website code from kapomatic-frontend

Read docs/OFFLINE_PLAN.md first. Start in plan mode and show me the plan before changing anything.

## STEP 0 — Findings (read-only)

1. List every file and folder that belongs only to website features:
   - src/app/modules/seo
   - src/app/modules/ecommerce-settings
   - src/app/modules/website-images
   - src/app/modules/website-orders
   - src/app/core/guards/website-feature.guard.ts
   Confirm nothing outside these folders imports from them, except the places listed in STEP B.
2. List every use of isWebsiteEnabled / websiteEnabled / features.website / websiteFeatureGuard / WEBSITE_ONLY_ROUTES in src (file + line + what it hides).
3. List every remaining call to a backend route that no longer exists (compare against kapomatic-backend/src/app.js and its route files). Expected: only calls inside the folders being deleted. If any other file calls a deleted route, report it.
4. Check whether category/product forms send translations / seo / slug fields to the backend, even when websiteEnabled is false.

## STEP A — Delete

- The 4 module folders and website-feature.guard.ts above.
- Their routes in app.routes.ts (ecommerce-settings x3, website-images, website-orders).
- Any .spec.ts files that only test deleted code.

## STEP B — Clean the places that use them

Remove only the website branches; keep the offline behavior exactly as it is today (today's offline behavior = what users see when websiteEnabled is false).
- layout/custom-sidenav (ts + html): SEO form in the add/edit category dialog, WEBSITE_ONLY_ROUTES and its filter, the ecommerce-settings and website-images menu items, buildSeoFormValue, normalizeSeoExtensionPayload, SeoFormComponent import, categorySeoForm / categorySeoContext and anything only they use.
- category/add-product, category/product-edit, category/category-details (ts + html): SEO/translation tabs, fields and payload code.
- layout/home (ts + html): website orders and e-commerce settings buttons, and anything else inside @if (websiteEnabled).
- products/invoice-history (ts + html): anything website-only.
- core/runtime/app-features.ts: remove isWebsiteEnabled, keep isOfflineMainPc.
- environments (environment.ts, environment.prod.ts, environment.offline.ts, environment.model.ts): remove features.website. If `features` becomes empty, remove it entirely, as long as nothing else reads it.
- category service (cateory.service.ts) and any other service: remove methods that call deleted backend routes.
- If a WhatsApp link or any other website-only element exists in offline screens, list it and remove it only if it is behind websiteEnabled.

## STEP C — Translations

In src/assets/i18n/ar.json and en.json, remove keys that are no longer used anywhere (seo, ecommerce, website images, website orders, shipping-settings pages, storefront, etc.). Before removing each key or key group, grep src for it, including dynamic keys built with string concatenation or template literals. If a key might be built dynamically, keep it and list it in the report. Keep both files' structure aligned (same keys in ar and en).

## STEP D — Assets and leftovers (report only, do not delete)

- Images, SVGs and fonts under src/assets and public that nothing references any more (include assets/img/Kapo.jpeg).
- Old non-offline build files: electron/, electron-builder configs other than electron-builder.offline.json, the non-offline electron:* scripts in package.json, environment.prod.ts, SSR (serve:ssr script), desktop/package.json, scripts/prepare-desktop.js, scripts/electron-builder-debug.js. For each: is it still used by the offline build or tests? Your recommendation: keep or remove.
- Every place that still shows the Kapomatic / KapoMatic name or logo in the UI or the Electron app (header, home, index.html title, edition.json, electron-builder.offline.json, main.js messages, etc.). Just list them; they will be handled in a separate branding stage once the product name is decided.

## VERIFICATION (run all even if one fails)

- cd kapomatic-backend && npm test
- cd kapomatic-frontend && npm run test:offline
- cd kapomatic-frontend && npm run build:offline (no new errors; report any new warnings)
- cd kapomatic-frontend && npm run smoke:offline
- grep -rni in kapomatic-frontend/src/app for: isWebsiteEnabled, websiteEnabled, websiteFeature, WEBSITE_ONLY_ROUTES, ecommerce, website-orders, website-images, WebsiteOrders, WebsiteImages, SeoForm, seo-form, slug, storefront. Expected: no matches.
- grep -rni in kapomatic-frontend/src/environments for: website. Expected: no matches.

Do not commit.

## Final report — exactly this, in one code block

```
=== STAGE 4 REPORT ===
Files/folders deleted:
Places cleaned (file: what was removed):
Calls to deleted backend routes found outside the deleted folders:
Did category/product forms send translations/seo fields before this stage (and when):
i18n keys removed (groups) and keys kept because they may be dynamic:
Unused assets (not deleted):
Old non-offline build files: used or not, and recommendation for each:
Kapomatic branding still present (file + line + what):
Backend npm test: pass / fail, full error if any:
npm run test:offline: pass / fail, full error if any:
npm run build:offline: success / failure; any new warnings:
Smoke test (summary line + any ✗):
grep results (every matching line):
Unexpected findings or decisions needed from me:
git status --short:
```
