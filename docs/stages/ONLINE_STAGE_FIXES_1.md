# Online — Fixes 1 (found while writing the help)

Read before starting:
- docs/ONLINE_PLAN.md, and the "Questions" list in the help-center report (this stage answers it)
- nota-backend: src/controllers/selling.controller.js (`ensureCustomerExistsForSelling`, `createSellingInvoice`), creditSale.controller.js, the customer payment/payout routes and controllers, supplier payment routes, cashbox controller (transfers, owner drawings, box activation), suppliers controller, src/services/webOrders.service.js, src/auth/permissions.js (role templates), the audit log action codes (every place that writes an audit entry)
- nota-frontend: the POS (selling) page, the new credit sale page, customers, suppliers, cashbox, purchases, users (user form), audit page, orders page, the help content (src/app/help/*) and scripts/export-help.mjs

Start in plan mode and show me the plan before changing anything. Use Node 24 and a real mongod. Run long suites with a timeout and output to a file. Leave no test processes behind. Never use git worktree on Windows. Never touch C:\ProgramData\Nota, the installed offline Nota, or ports 27017/27217. Never commit; I commit after I review.

## Hard rules
- Change only what this brief lists. No refactoring; list anything else at the end.
- Money, stock and accounting always go through the existing in-transaction functions (the Stage 4/5A pattern). No new posting logic.
- Every change has a desktop and a phone layout (6A/6B patterns), and the desktop markup outside the changed parts stays identical.
- Every change updates the help sections it touches; regenerate `docs/help/HELP_AR.md` and keep the coverage specs green.

## 1. POS default price = retail
- In the POS (نقطة البيع), every line added uses the **retail price (قطاعي)** by default. The cashier can still switch the price type as today.
- Do not change the new credit sale screen in this item; tell me in STEP 0 what it defaults to today.

## 2. A phone that already belongs to a customer (POS and new credit sale)
Today a sale with a name and a phone overwrites the existing customer's name.
- **Backend:** `ensureCustomerExistsForSelling` (and the credit-sale equivalent) never changes an existing customer's name by default: the existing customer is used as is. It renames only when the request carries `renameCustomer: true` **and** the user has `customers.manage`; otherwise that flag is refused (403). The invoice's customer name is the customer's stored name after this step. Website orders (walk-in) are untouched.
- **Lookup:** a small read endpoint for the sale screens, e.g. `GET /api/sellings/customer-by-phone?phone=` (permission `sales.create` or `credit.create`), returning only `{ exists, name }` for an exact normalized phone. No other customer data.
- **Frontend:** when the cashier finishes typing a phone that exists and the typed name differs, show a dialog:
  - "الرقم ده متسجل باسم <stored name>."
  - **"نفس العميل"** (default): use the stored name; the name field shows it.
  - **"غيّر اسمه لـ <typed name>"**: only shown with `customers.manage`; sends `renameCustomer: true`.
  - **"الرقم غلط"**: closes and focuses the phone field.
  If the name field is empty, fill it with the stored name without asking.
- Tests: no rename by default; rename only with flag + permission; 403 without the permission; lookup returns nothing else; the dialog's three choices.

## 3. "تغيير المندوب" on an order that is out for delivery
- New action on `out_for_delivery` orders (not yet delivered), permission `orders.dispatch`.
- **COD + delivery** (credit sale on the courier): in **one transaction**: a full return of the current credit sale through the existing return path (as for "refused", same shipping rule), then a new credit sale on the new courier through the existing creation path, with the order's snapshot lines, prices and delivery fee; update `courierId`, `creditSaleId` (keep the old ids in the order's links), and the history ("غيّر المندوب من X لـ Y", by, at). Also requires `credit.create` and `returns.create`, like the actions it is made of. If any step fails, nothing changes.
- **Wallet + delivery** (cash sale, the courier collects nothing): only `courierId` and the history change; no accounting.
- The order's total must equal the new invoice's total (same check as dispatch). The old courier's balance goes back to what it was before the order; the new courier owes the order total. Stock ends where it was.
- Phone and desktop: "تغيير المندوب" in the order actions, choosing the new courier (active couriers only, not the current one).
- Tests: COD path (both courier balances, stock unchanged net, the documents created, totals), wallet path (no documents), a locked period refuses it, two parallel calls change it once, permissions.

## 4. Screens for corrections the backend already supports
The backend already has these; the app has no button, and the help tells users to call support. Add the screens, using the existing endpoints, permissions and rules as they are (STEP 0: list each endpoint, its permission, and exactly what it records):
1. Cancel a customer payment (تحصيل) — from the customer page's payments list.
2. Cancel a customer payout (صرف لعميل) — same place.
3. Cancel a supplier payment — from the supplier statement.
4. Cancel a transfer between boxes — from the box movements.
5. Cancel an owner drawing — from the box movements.
6. Deactivate / reactivate a cash box — from the cash boxes page (with the backend's rules: e.g. non-zero balance, open shift).
7. Deactivate / reactivate a supplier — from the suppliers page.
8. A supplier refund without a return — from the supplier statement.
For each: a red confirm sheet/dialog with a required reason when the backend takes one, the existing lock-date rules, the voucher/print if the backend produces one, and the result visible in the lists. If an endpoint's behavior looks wrong accounting-wise, stop and tell me instead of building the screen.
- Fix the purchase screen text that says "ألغي السند لوحده" so it points to the new supplier-payment cancel action.

## 5. Text that doesn't match the code
1. **User form role descriptions** come from the backend role templates (generated, like the help's permission catalog), so "المدير" lists exactly what it can't do (users, backups, manual entries / opening balances, period closing, owner drawings, …).
2. **Audit log:** every action code the backend writes has an Arabic and English label and is in the action filter (website orders, prints, couriers, push, everything). The export script copies the backend's list of audit action codes; a spec fails if any code lacks a label.
3. `core/auth/testing/auth-fixtures.ts` matches the backend catalog and role templates.
4. docs/ONLINE_PLAN.md 6B: correct the phone-printing sentence to what the code does («الطباعة من الكمبيوتر» where there is no print button).
5. Remove the unused i18n keys the help report listed.

## STEP 0 (plan, before any change)
1. Every file you will add or edit, one line each.
2. Item 1: what the new credit sale defaults to today.
3. Item 2: every place a sale can create/rename a customer, and the lookup's exact response.
4. Item 3: the exact existing functions and the transaction order; what the documents look like for the accountant.
5. Item 4: for each correction, the endpoint, permission, what it records, the lock rule, and anything that looks wrong.
6. Anything in this brief you think is wrong or risky, with your alternative.

## Done means
- Backend `npm test`, admin `ng test` and `admin` build, storefront tests pass; the help coverage specs pass and `HELP_AR.md` is up to date.
- The phone audit for every route you touched passes at 390 and 1280 (1280 identical outside the changed parts).
- docs/ONLINE_PLAN.md has a "Fixes 1" section.
- Report: what changed, the answers to STEP 0 items 2–5, and the list of things you noticed but did not do.
