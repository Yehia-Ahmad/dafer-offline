# Stage 9 — Global shell + POS + credit sales redesign

Read docs/OFFLINE_PLAN.md and docs/design/NOTA_DESIGN_SYSTEM.md first. Design references: docs/design/screens/Pos.dc.html, PosDark.dc.html, CreditSales.dc.html, NewCreditSale.dc.html. Start in plan mode and show me the plan before changing anything. Use Node 20.

Scope: (A) move the shell into app.html, (B) redesign the cash-sale screen (/selling), (C) redesign the credit-sales screen (/credit-sales). Frontend only.

## Hard rules for every redesign stage
1. **No feature may be lost.** Every input, button, dialog, print, validation, keyboard behavior and API call that exists today must still exist after the redesign (it may move or look different).
2. **No backend changes and no API contract changes.** Request URLs, methods, query params and request bodies must stay byte-for-byte the same shape. Response handling stays the same.
3. **Do not invent features the backend does not support.** If the design shows something that has no backend today (payment method choice, cash box, hold invoice, credit limit, due date, etc.), skip it, unless the field already exists in the API. List every skipped design element in the report.
4. Frontend-only conveniences that need no backend are allowed if small and safe (e.g. keyboard shortcuts F2 = focus search, F9 = pay/save). List them.
5. Use the Stage 7 tokens and shared UI (notaButton, form field, card, page header, KPI card, status pill, table classes, dialog shell, notaMoney/notaNumber). No new hardcoded colors; dark mode must work through tokens.
6. Remove the per-component `[attr.dir]` bindings and the old yellow "رجوع" buttons on the screens you redesign (the page header back link replaces them).

## STEP 0 — Findings (read-only)

1. Feature inventory for /selling and /credit-sales: every input/field, button, dialog, table, print action, validation message, keyboard handler, and every API call (method + URL + body fields). Number each item; this list is the checklist for the report.
2. Credit sale model and API: which fields exist (customer, payments, discount, shipping fees, due date?, notes?, paid amount, remaining, status…).
3. How the shell (<app-side-nav>) is used by the 13 pages and what reloads per navigation today (categories, product-exists check).

## STEP A — Shell in app.html

- Render the sidebar frame once in app.html around <router-outlet> (keep /ui-kit frameless via route data, e.g. `data: { frame: false }`). Remove the <app-side-nav> wrappers from the pages.
- Refresh strategy so behavior does not regress: reload the category list and the product-exists flag (a) on app start, (b) after any category add/edit/delete/import done from the sidebar, (c) when navigating into /categories/:id or /products/edit/:id, (d) after product create/delete/import if those events are easy to hook; otherwise on navigation to those routes.
- Fix: the version notice label must not overlap the sidebar footer in LTR or RTL.
- Keep the slim top bar (back + drawer button) for now.

## STEP B — Cash sale (/selling) → Pos.dc.html

Layout from the design: product search (large, focused on load, F2), category chips, product grid tiles (code, name, price, available stock with low-stock color), and the current-invoice panel (customer optional, line items with + / − quantity, line totals, subtotal, discount, shipping fees if the field exists, big total, paid amount and change if the screen has them today, primary "pay and print" button, cancel/clear). Dark variant = PosDark.dc.html via tokens.
- Keep every item from the STEP 0 checklist. Map each one to its new place.
- Prices and totals use notaMoney; quantities notaNumber; inputs keep accepting Latin digits.
- The "price below purchase price" error must still appear exactly when it does today.

## STEP C — Credit sales (/credit-sales) → CreditSales.dc.html + NewCreditSale.dc.html

- List view: KPI row (only KPIs computable from data the screen already loads; do not add API calls just for KPIs), search, status filter pills, table (number, customer + phone, date, total, paid, remaining, status pill, actions), and the payment side panel or dialog for the selected invoice (amount, date, note, previous payments), as far as today's features allow.
- New/edit credit invoice: follow NewCreditSale.dc.html (customer section, items table, totals, paid now, remaining), only with fields that exist.
- Keep every checklist item (create, edit, delete, add payment, print, refund/return entry points, filters, pagination, customer creation flow).

## STEP D — Payload safety specs

For every API call made by /selling and /credit-sales, add or update a spec that builds the request from sample form input and asserts the exact request body (and URL/params). Run these specs against the code BEFORE your changes (git stash or a temp worktree) and AFTER, and confirm they pass in both. This replaces the smoke test on Linux.

## STEP E — Visual check

- Serve the app and take screenshots with Playwright/Chromium headless, using route interception to return realistic fixture JSON for the API calls (categories, products, sellings, credit sales, customers), shaped exactly like the real responses.
- /selling and /credit-sales at 1440×960: light Arabic, dark Arabic, light English; /selling at 1024×768 and 390×844; the payment panel/dialog and the new credit invoice form open; one validation error state.
- Save to `~/nota-review/stage-9/`. Look at them yourself and fix obvious problems first.

## VERIFICATION (run all even if one fails)

- backend: npm test
- frontend: npm run build:offline (new warnings, bundle size before/after)
- frontend: npx ng test --watch=false --browsers=ChromeHeadless
- frontend: npm run test:offline (Windows-only drive test expected to fail on Linux)
- frontend: npm run smoke:offline — only if a mongod exists; otherwise "skipped (no mongod on this OS)"
- grep the two redesigned screens for hardcoded hex colors and `[attr.dir]`; expected none.

Do not commit.

## Final report — exactly this, in one code block

```
=== STAGE 9 REPORT ===
Shell move: what changed, refresh strategy, version-notice fix:
/selling checklist (number. feature → where it is now):
/credit-sales checklist (number. feature → where it is now):
Design elements skipped (no backend support):
Frontend-only additions (shortcuts etc.):
Payload safety specs (calls covered; before/after results):
Screenshots (paths) and problems fixed:
Backend npm test:
npm run build:offline (warnings, bundle size before/after):
ng test:
npm run test:offline:
Smoke test:
Leftover hardcoded colors / [attr.dir] in the two screens:
Unexpected findings or decisions needed from me:
git status --short:
```
