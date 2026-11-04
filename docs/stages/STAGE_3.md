# Stage 3 — Remove website settings, add ShopProfile

Read docs/OFFLINE_PLAN.md first. Start in plan mode and show me the plan before changing anything.

## STEP 0 — Findings and baseline (read-only, plus smoke-test edits)

1. List the real paths of every route in ecommerceSetting.routes.js (all mounted under /api/ecommerce-settings).
2. Search kapomatic-frontend/src for HTTP calls to /ecommerce-settings (and any general-settings / shipping endpoints). For each call, say whether it is reachable in the offline edition (not hidden behind isWebsiteEnabled / websiteFeatureGuard). Pay special attention to the home page, the side nav, the selling screen and the invoice print utilities. If any offline-reachable screen depends on these routes, stop and tell me before deleting.
3. grep kapomatic-backend/src for every file that requires ecommerceSetting, shippingSetting, generalSetting, utils/seo, publicCatalog.service, publicPerformance, publicCacheInvalidation. List them.
4. Check the Selling and CreditSale models for website/shipping leftovers (shippingLocation, government, shippingFees, etc.). Report what exists and whether anything offline still writes or reads them. Do NOT remove them in this stage; just report.
5. Smoke test edits:
   - Add to REMOVED_ROUTES one representative GET from ecommerce-settings (pick one that returns non-404 today).
   - Add scenarios for the new ShopProfile (they will fail at baseline, which is expected):
     - GET /api/shop-profile → 200 with empty name before anything is saved
     - PUT /api/shop-profile with name, address, phones, taxNumber, invoiceFooter → 200
     - GET returns the saved values
     - PUT without name → 400
     - PUT with an invalid logo (not base64 image) → 400
6. Run the baseline. Expected: all existing scenarios pass; only the new ecommerce-settings REMOVED_ROUTES entry and the new ShopProfile scenarios fail. Report the baseline. If anything else fails, stop.

## STEP A — Delete from kapomatic-backend

- models: ecommerceSetting, shippingSetting, generalSetting
- controller and routes: ecommerceSetting (and any general/shipping settings controller or routes if separate)
- the files deferred from Stage 2: utils/seo.js, services/publicCatalog.service.js, utils/publicPerformance.js, utils/publicCacheInvalidation.js
- src/app.js: the ecommerce-settings require and app.use
- category.controller.js: the EcommerceSetting require and the EcommerceSetting.deleteOne line in deleteCategory
- Grep before deleting each file to confirm nothing outside the deleted set still uses it. If something does, stop and tell me.

## STEP B — ShopProfile backend

New model src/models/shopProfile.model.js. A single document identified by key: "default", following the style of the existing models (Arabic validation messages, trim, maxlength):
- key: String, unique, default "default"
- name: String, required, max 150
- address: String, optional, max 500
- phones: [String], optional, max 3 entries, each max 30
- logo: String, optional, validated with isBase64Image; reject logos larger than 500 KB decoded
- taxNumber: String, optional, max 50
- commercialRegister: String, optional, max 50
- invoiceFooter: String, optional, max 500
- timestamps

Routes /api/shop-profile (controller + routes in the same style as existing ones, using asyncHandler):
- GET: returns the document, or { name: "", address: "", phones: [], logo: null, taxNumber: "", commercialRegister: "", invoiceFooter: "" } if none exists. Never creates a document on GET.
- PUT: upsert by key "default" with runValidators: true. Only the fields above are accepted; ignore anything else.

Add a backend test file test/shop-profile.test.js in the same style as lan-mode.test.js, covering GET-empty, PUT, GET-after-PUT, and validation errors.

## STEP C — ShopProfile frontend

- New service: src/app/modules/shop-profile/services/shop-profile.service.ts (same style as other services, using environment.api_base_url).
- New standalone component: "Shop profile" page at route /shop-profile, styled like the existing screens (same UI libraries, translations, dark mode, RTL). Fields: name (required), address, up to 3 phones, tax number, commercial register, invoice footer, and a logo upload with preview and remove button (reuse the existing upload component or image handling pattern if there is one).
- Add it to the side nav. Add translation keys to ar.json and en.json. First check which i18n folder is actually loaded at runtime (public/i18n vs src/assets/i18n) and tell me; update the one in use (and the other only if both are used).
- Printing: update invoice-history-print.util.ts and credit-invoice-print.util.ts:
  - Fetch the shop profile once when printing (or cache it in the service).
  - Header: logo, name, address, phones, tax number, commercial register — each only if present.
  - Footer: invoiceFooter if present.
  - If there is no shop profile or the request fails, the print must still work exactly as it does today.
- Do not change anything else in these print utilities.

## STEP D — Docs and Postman

- README.md: remove the General Setting and E-commerce sections and every endpoint deleted in this stage. Remove the stray shell lines at the end of the file (systemctl status mongod, uname -r, npm run dev, etc.). Add a short "Shop profile" section documenting GET/PUT /api/shop-profile.
- Postman: remove the "Optimized Public Home and Header" folder and any ecommerce/shipping/general settings requests and their orphan variables. Add a "Shop Profile" folder with GET and PUT requests. Keep the same JSON formatting approach as Stage 2 (round-trip check first).

## VERIFICATION (run all even if one fails)

- cd kapomatic-backend && npm test
- cd kapomatic-frontend && npm run test:offline
- cd kapomatic-frontend && npm run build:offline
- cd kapomatic-frontend && npm run smoke:offline
- grep kapomatic-backend/src and kapomatic-backend/test for: ecommerceSetting, EcommerceSetting, shippingSetting, ShippingSetting, generalSetting, GeneralSetting, publicCatalog, publicPerformance, publicCacheInvalidation, clearPublicSeoCache, normalizeSeoInput, slugAliases, translations, require("../utils/seo"). Expected: no matches.

Do not commit.

## Final report — exactly this, in one code block

```
=== STAGE 3 REPORT ===
Removed route paths:
Frontend calls to removed routes, and whether each is offline-reachable:
Selling/CreditSale website leftovers found (fields, and whether anything uses them):
i18n folder actually used at runtime:
Smoke test baseline: ✓ / ✗ counts, and which ✗:
Deleted files:
New files:
Modified files (one line per file):
Backend npm test: pass / fail, full error if any:
npm run test:offline: pass / fail, full error if any:
npm run build:offline: success / failure, error if any:
Smoke test after changes (every ✓ / ✗ line as printed):
grep results (every matching line):
Unexpected findings or decisions needed from me:
git status --short:
```
