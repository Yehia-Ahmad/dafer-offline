# Stage 10 — Invoice history, returns, customers, credit list

Read docs/OFFLINE_PLAN.md, docs/design/NOTA_DESIGN_SYSTEM.md and docs/stages/STAGE_9.md (its "Hard rules for every redesign stage" apply here unchanged). Design references: docs/design/screens/Invoices.dc.html, Returns.dc.html, Customers.dc.html, AddCustomer.dc.html, Customer.dc.html, CreditSales.dc.html, NewCreditSale.dc.html. Start in plan mode and show me the plan before changing anything. Use Node 20.

Scope: /invoice-history, /returns, /customers, /customers/:id, a list view for /credit-sales, two optional fields on the credit invoice form, and the back-button cleanup.

## STEP 0 — Findings (read-only)
1. Numbered feature inventory (inputs, buttons, dialogs, tables, filters, pagination, prints, exports, validations, every API call with method + URL + body) for /invoice-history, /returns, /customers, /customers/:id. This is the report checklist.
2. What data /customers/:id already loads (credit sales with payments? refunds/returns? cash invoices?) and whether a customer statement with a running balance (date, description, document, debit, credit, balance) can be computed from that data on the frontend without new API calls.
3. Fields available from GET /credit-sales (list) and its query params (search, status, pagination).

## STEP A — Back controls
- Keep the shell top-bar Back (history back) as the single generic back control.
- Page-header back links only on child/detail pages, pointing to their parent: /customers/:id → /customers, /products/edit/:id → its category, the new-credit-invoice view → the credit list. Remove the page-header back link from top-level pages (/selling, /credit-sales list, /invoice-history, /returns, /customers, /shop-profile, /backup, /products/profit-report, /home) including the ones added in Stage 9.

## STEP B — /invoice-history → Invoices.dc.html
Filters card, table with type and status pills, pagination, and the invoice detail panel (items, returns lines, totals, actions). Keep every existing action (print, return, edit, delete, export, etc.) and every filter. Delete keeps today's warning text about stock (intended behavior; see OFFLINE_PLAN accounting notes). Prints keep using the existing print utils.

## STEP C — /returns → Returns.dc.html
Step indicator (choose invoice → items and quantities → confirm), items table with returnable quantity and reason, summary panel. Keep every existing behavior (cash and credit returns, partial returns, reasons, the returns log/summary views if they exist on this screen). Only show the "where does the money go" choice if the API supports it; otherwise show the outcome the API applies today as text.

## STEP D — /customers → Customers.dc.html, add/edit customer → AddCustomer.dc.html
KPI row only from data the screen already loads, search, filter pills only if the data supports them, table with balance pill, actions. Add/edit customer dialog with only the fields the API has (name, phone, others if they exist); keep the duplicate-phone error.

## STEP E — /customers/:id → Customer.dc.html
Header card (name, phone, balance due, actions), tabs. Keep every existing feature (credit invoice list, payments, print, delete, refunds, etc.). Add a "كشف الحساب" tab with a running-balance statement **only if** STEP 0.2 shows it can be computed from data already loaded (frontend-only, no new API calls). If not possible, skip it and say why.

## STEP F — /credit-sales list view + form fields
- /credit-sales becomes: list view (CreditSales.dc.html) using the existing GET /credit-sales, with search/status/pagination as the API supports, KPIs computed from the loaded page only if meaningful, and a payment panel/dialog using the existing POST /credit-sales/:id/payments (same body the customer page sends today), print via the existing credit-invoice print util. "+ فاتورة آجل جديدة" opens the Stage 9 form (as a child route such as /credit-sales/new, or a view toggle).
- New credit invoice form: add **due date** and **note** as optional fields. Send them only when filled; with both empty the request body must stay exactly as today. Cover both cases in the payload spec.
- Fix the Stage 9 finding: a product with retailPrice null must fall back to wholesalePrice for the default unit price (cover with a spec).
- If due dates exist, show "overdue" status when dueDate < today and remaining > 0 (display only).

## STEP G — Payload safety specs
Same method as Stage 9: specs asserting exact request URLs/params/bodies for every API call on the redesigned screens; run them before and after; both must pass. Include the payments POST from both the customer page and the credit list.

## STEP H — Visual check
Fixture-backed screenshots (route interception, realistic JSON) for every redesigned screen at 1440×960 light-ar, dark-ar, light-en; key dialogs open (invoice detail, return confirm, add customer, record payment); one 390×844 per screen. Save to `~/nota-review/stage-10/`. Fix obvious problems first.

## VERIFICATION
- backend: npm test
- frontend: npm run build:offline (warnings, bundle sizes). If a component style budget is exceeded, raise `anyComponentStyle` in angular.json to a sensible value (e.g. 8 kB warning / 16 kB error) instead of splitting files; report it.
- frontend: npx ng test --watch=false --browsers=ChromeHeadless
- frontend: npm run test:offline (Windows-only drive test expected to fail on Linux)
- frontend: npm run smoke:offline — only if a mongod exists; otherwise "skipped (no mongod on this OS)"
- grep the redesigned screens for hardcoded hex colors and `[attr.dir]`: expected none.

Do not commit.

## Final report — exactly this, in one code block
```
=== STAGE 10 REPORT ===
Back controls (what was removed/kept where):
/invoice-history checklist (number. feature → where now):
/returns checklist:
/customers checklist:
/customers/:id checklist (+ statement tab: done / skipped and why):
/credit-sales list (API params used, payments, print) and form fields (due date, note):
retailPrice null fix:
Design elements skipped (no backend support):
Frontend-only additions:
Payload safety specs (calls covered; before/after):
Screenshots (paths) and problems fixed:
Backend npm test:
npm run build:offline (warnings, bundle sizes, budget change if any):
ng test:
npm run test:offline:
Smoke test:
Leftover hardcoded colors / [attr.dir]:
Unexpected findings or decisions needed from me:
git status --short:
```
