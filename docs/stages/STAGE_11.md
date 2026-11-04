# Stage 11 — Products & categories, product form, profit report, shop profile, backup, cleanup

Read docs/OFFLINE_PLAN.md, docs/design/NOTA_DESIGN_SYSTEM.md and docs/stages/STAGE_9.md (its "Hard rules for every redesign stage" apply unchanged). Design references: docs/design/screens/Products.dc.html, AddCategory.dc.html, ProductForm.dc.html, Profit.dc.html, ShopProfile.dc.html, Backup.dc.html. Start in plan mode and show me the plan before changing anything. Use Node 20.

Frontend only. The dashboard (/home) is NOT part of this stage (Stage 12, it needs a backend endpoint); leave /home working as today.

## STEP 0 — Findings (read-only)
1. Numbered feature inventory (inputs, buttons, dialogs, tables, filters, pagination, prints, PDF/Excel exports, validations, every API call with method + URL + body) for: /categories/:id (category details + add product), /products/edit/:id, the sidebar category tools (add/edit/delete category, import/export categories, template, export products), /products/profit-report, /shop-profile, /backup. This is the report checklist.
2. Which product fields the API supports (name, code, category, inventoryCount, purchasePrice, wholesalePrice, retailPrice, discountPercentage, image, specifications, anything else).
3. Everything on /home that is products-related (the "products view", HOME_VIEW, category cards) and what still links to it.

## STEP A — Products & categories page → Products.dc.html
- New route `/products` (optional `?category=<id>`). Layout: categories list on the side (with counts if available), products table on the main side (code, name, stock pill with low/medium/ok levels, purchase price, retail, wholesale, discount, edit), search, "low stock only" toggle (frontend filter on the loaded data, threshold 5 for now), page-header actions.
- Move ALL category management from the sidebar into this page: add / edit / delete category (AddCategory.dc.html dialog), import / export categories, template download, export products. Same service calls and logic (reuse the Stage 8 sidebar-categories code; do not rewrite logic).
- `/categories/:id` redirects to `/products?category=:id` (keep old links working).
- Sidebar: "الأصناف والفئات" becomes a plain link to /products (no expandable list, no tools). Keep CatalogStateService for anything still using it; remove what becomes unused.
- Purchase price column visibility stays as today (the permissions phase will hide it from cashiers later).

## STEP B — Product form → ProductForm.dc.html
- Full-page form for add and edit: `/products/new?category=<id>` and `/products/edit/:id`. Sections: basic data, prices (with the profit hint computed on the frontend), category specifications (dynamic fields from the category), image, stock.
- Only fields the API supports. The "notify me when stock reaches" field is skipped in this stage (Stage 12 decides).
- Same create/update request bodies as today (payload specs before/after). Keep today's validation including price-below-purchase-price, sync-purchase-price action if it exists on this screen, delete product, and any other existing action.
- "Save and add another" is allowed as a frontend-only addition (resets the form, keeps the category).

## STEP C — Profit report → Profit.dc.html
KPI row, monthly chart, top products table, period selector — using only the existing profit endpoints and their params. Keep the existing PDF/Excel export and every filter.

## STEP D — Shop profile and backup
- /shop-profile → ShopProfile.dc.html: form + live invoice preview (reuse the print branding util for the preview content if practical; otherwise a static preview built from the form values).
- /backup → Backup.dc.html: status card, manual backup, auto-backup settings, destination, saved backups list with restore — only what the Electron bridge supports today. Keep every existing safety confirmation.

## STEP E — Cleanup carried over from earlier stages
1. /selling: a product with retailPrice or wholesalePrice null must not become price 0; fall back retail → wholesale like the credit form (spec).
2. /customers/:id: restore the per-invoice "إضافة دفعة" button on each open invoice card (same POST /credit-sales/:id/payments body as the credit list). Keep the first/last picker hidden.
3. Remove `[attr.dir]` bindings and hardcoded hex colors from every remaining screen except /home (Stage 12).
4. Version-notice mismatch banner: tokens instead of #fff3cd / #664d03.
5. Remove the unused Router injection in product-profit-report and any other dead code left by Stages 8–10 (list it).
6. Remove i18n keys that are now unused (same grep rules as Stage 4/5; keep dynamic ones).
7. resetHomeView: wrap localStorage access in try/catch.

## STEP F — Plan file notes
Add to docs/OFFLINE_PLAN.md under the accounting decisions:
- Returns currently lower the invoice's totalPrice. In the accounting phase, store each refund's final amount and create a credit entry, so statements show the original invoice plus a separate return line.
- Credit invoices have no invoice number. In the accounting phase add sequential document numbers for all document types (cash sale, credit sale, return, receipt, payment, purchase, journal entry), and allow the returns wizard to search by invoice number.

## STEP G — Payload safety specs and visual check
- Specs asserting exact URLs/params/bodies for every API call on the redesigned screens and the moved category tools; run before and after; both must pass.
- Fixture-backed screenshots: /products (with a category selected), add-category dialog, product form (new + edit), /products/profit-report, /shop-profile, /backup at 1440×960 light-ar, dark-ar, light-en, plus 390×844 light-ar each. Save to `~/nota-review/stage-11/`. Fix obvious problems first.

## VERIFICATION
- backend: npm test
- frontend: npm run build:offline (warnings, bundle sizes)
- frontend: npx ng test --watch=false --browsers=ChromeHeadless
- frontend: npm run test:offline (Windows-only drive test expected to fail on Linux)
- frontend: npm run smoke:offline — only if a mongod exists; otherwise "skipped (no mongod on this OS)"
- grep all screens except /home for hardcoded hex colors and `[attr.dir]`: expected none.

Do not commit.

## Final report — exactly this, in one code block
```
=== STAGE 11 REPORT ===
Products & categories checklist (number. feature → where now):
Category tools moved from the sidebar (each → where now):
Product form checklist:
Profit report checklist:
Shop profile checklist:
Backup checklist:
Route changes and redirects:
Sidebar changes:
Cleanup items 1–7 (done / not done and why):
Plan file notes added:
Design elements skipped (no backend support):
Frontend-only additions:
Payload safety specs (calls covered; before/after):
Screenshots (paths) and problems fixed:
Backend npm test:
npm run build:offline (warnings, bundle sizes):
ng test:
npm run test:offline:
Smoke test:
Leftover hardcoded colors / [attr.dir] (outside /home):
Unexpected findings or decisions needed from me:
git status --short:
```
