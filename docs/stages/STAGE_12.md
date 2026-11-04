# Stage 12 — Dashboard + small backend additions

Read docs/OFFLINE_PLAN.md, docs/design/NOTA_DESIGN_SYSTEM.md and docs/stages/STAGE_9.md (its hard rules apply, EXCEPT rule 2: this stage is allowed the small, additive backend changes listed below and nothing else). Design references: docs/design/screens/Dashboard.dc.html, DashboardDark.dc.html, Products.dc.html, ProductForm.dc.html. Start in plan mode and show me the plan before changing anything. Use Node 20.

**Run this stage on the Windows PC** (or on a machine with a working mongod), because it changes the backend and the smoke test must run.

## Backend rules for this stage
- Additive only: new endpoint, new optional fields, new optional query params. Every existing request and response keeps working exactly as today (existing fields keep their names, types and meaning).
- No changes to selling, credit sale, payment, return or inventory logic.
- Every new backend behavior gets a backend test, and the smoke test gets new scenarios for it.

## STEP 0 — Findings (read-only)
1. Current /home: everything it renders (dashboard view, products view, HOME_VIEW switching, category cards, buttons) and who writes/reads HOME_VIEW (selling, credit, profit report, sidebar…).
2. Product create controller: which body fields it accepts (is discountPercentage ignored on create?).
3. GET /api/products today: why categoryId is required, pagination limits, search support.
4. GET /api/categories response shape.
5. Date handling for "today": which timezone the backend uses for sellingDate / credit sale dates.

## STEP A — Backend additions
1. `GET /api/dashboard/summary` (read-only), returning for "today" in the server's local timezone (document it):
   - cash sales today: total amount (net of discount, incl. shipping as the invoice total does), count
   - credit sales today: total, count
   - same two totals for yesterday (for the comparison note)
   - credit outstanding: sum of remainingAmount over open credit invoices, count of customers with a balance, overdue amount and count (dueDate < today and remaining > 0)
   - last 7 days: per day, cash total + credit total
   - recent invoices: the latest 5 across cash and credit (id, type, number/reference, customer name, total, createdAt)
   - low stock: up to 8 products where inventoryCount <= (product.lowStockThreshold ?? 5), lowest first (id, name, code, inventoryCount, threshold)
   Use aggregation with existing indexes; add an index only if needed and say which.
2. Product: optional field `lowStockThreshold` (Number, min 0, default undefined). Accepted on POST and PUT when sent; returned on GET. When missing, clients use 5.
3. Categories: add `productCount` to each item of GET /api/categories (additive field).
4. Products: GET /api/products without categoryId returns all products, paginated with the same page/limit rules (today this is an error; allowing it is additive). Optional `search` param if trivial; otherwise skip.
5. Product create: accept `discountPercentage` (0–100) when sent, same validation as update. If it is already accepted, just report it.

## STEP B — Dashboard (/home) → Dashboard.dc.html
- Replace /home with the dashboard: greeting with today's date, quick actions (فاتورة كاش → /selling, فاتورة آجل → /credit-sales/new, تحصيل → /credit-sales; "تسجيل مصروف" hidden until the accounting phase), KPI row (today's sales with % vs yesterday, invoice count cash/credit, credit outstanding with overdue count; the "cash in the box" KPI is hidden until the accounting phase), 7-day bar chart (CSS bars, tokens), low-stock list (links to the product), recent invoices table (links to the invoice / customer).
- Dark mode via tokens (DashboardDark.dc.html). No [attr.dir], no hex colors.
- Remove the old products view on /home and the HOME_VIEW mechanism everywhere (writers and readers), since products now live on /products. Remove now-unused i18n keys.
- Empty states for a brand-new shop (no sales yet, no products).

## STEP C — Products page and product form
- /products: add a "كل الأصناف" entry at the top of the category list (uses GET /products without categoryId), and show productCount next to each category. /products with no ?category now opens "كل الأصناف" instead of the first category.
- Stock pill and "low stock only" toggle use each product's lowStockThreshold (default 5).
- Product form: add "نبّهني لما المخزون يوصل لـ" (lowStockThreshold, optional) in the stock card, and discount % on create. Send each only when filled; with both empty the POST/PUT bodies stay exactly as today (payload specs for both cases).

## STEP D — Follow-ups from Stage 11
- Make `.nota-table-wrap { position: relative }` global and confirm /customers no longer overflows at 390px.
- Product edit: rename the sync button label from "تعديل سعر البيع" to "تحديث سعر الشراء في الفواتير" (en: "Update purchase price on invoices"); i18n only.

## STEP E — Tests
- Backend tests: dashboard summary (empty DB, today/yesterday split, overdue rule, low-stock threshold default and custom, 7-day series), categories productCount, products without categoryId, lowStockThreshold and discountPercentage on create/update, and that existing responses are unchanged.
- Smoke test new scenarios: dashboard summary numbers after the existing smoke sales (cash today, credit today, outstanding, low stock), product with a custom threshold appears in low stock, categories productCount, GET /products without categoryId.
- Frontend payload specs for every changed or new call; before/after for the unchanged ones.
- Fixture-backed screenshots: /home light-ar, dark-ar, light-en, 1024 and 390; /home empty state; /products with "كل الأصناف"; product form with the new fields. Save to `~/nota-review/stage-12/` (on Windows: `%USERPROFILE%\nota-review\stage-12\`).

## VERIFICATION
- backend: npm test
- frontend: npm run build:offline
- frontend: npx ng test --watch=false --browsers=ChromeHeadless
- frontend: npm run test:offline (all must pass on Windows)
- frontend: npm run smoke:offline (must run; report every line)
- frontend: npm run offline:stage
- grep /home for hardcoded hex colors and [attr.dir]: expected none.

Do not commit.

## Final report — exactly this, in one code block
```
=== STAGE 12 REPORT ===
Old /home features and HOME_VIEW users (→ what happened to each):
Backend additions (endpoint/field → files, behavior, index added?):
Proof existing responses are unchanged:
Dashboard checklist (KPIs, chart, low stock, recent, quick actions, empty state):
Products page and product form changes:
Stage 11 follow-ups:
Design elements still skipped:
Backend tests (new / total):
Payload specs (before/after):
Smoke test (every line):
Screenshots (paths) and problems fixed:
npm run build:offline:
ng test:
npm run test:offline:
npm run offline:stage:
Unexpected findings or decisions needed from me:
git status --short:
```
