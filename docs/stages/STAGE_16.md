# Stage 16 — Accounting foundation: transactions, document numbers, cancel instead of delete, refunds kept separately

Read before starting:
- docs/OFFLINE_PLAN.md, especially the "Accounting (double-entry)" and "Other" sections and every item moved to the accounting phase
- docs/design/NOTA_DESIGN_SYSTEM.md
- docs/stages/STAGE_14.md: its hard rules apply

Start in plan mode and show me the plan before changing anything. Use Node 24. On Linux, use the mongod in ~/.local/nota-mongo/bin/mongod through NOTA_TEST_MONGOD and NOTA_MONGOD_PATH.

This stage prepares the data for double-entry accounting. **It creates no journal entries and no chart of accounts.** Those come in Stage 17. After this stage, every document has a number, and every multi-document write is atomic. Invoices are never deleted, and a return is a separate line, not an edit of the invoice.

## Hard rules
1. **Behavior change in this stage is limited to the items below.** Prices, the below-cost rule, discount permissions, max discount and stock arithmetic all stay as they are.
2. **Every write that touches more than one document runs in one MongoDB transaction.** If any part fails, nothing is saved: invoice, stock, customer balance, counter, return log, audit.
3. **Money is rounded to 2 decimals at the point it is stored,** with one shared helper.
4. **Styling:** tokens only (no hex, no `[attr.dir]`), light and dark, Arabic and English.
5. **Safety:**
   - Never commit.
   - The smoke test never uses the real DB or port 27017.
   - Ask before sudo.
   - Tests never touch C:\ProgramData\Nota.

## STEP 0 — Findings (read-only, report before planning)
1. **mongod startup.** How mongod-manager starts mongod today: the args and the dbPath. Also how the test helpers, smoke and setup-restore tests start it.
2. **Every multi-document write in the backend.** List each route, the documents it touches, and the order:
   - cash sale create/edit/delete
   - credit sale create/edit/delete
   - credit payments (both routes)
   - cash and credit returns
   - product sync-purchase-price
   - category import
   - product/category delete
   - user changes + audit
3. **How returns change an invoice today.** For a cash invoice and for a credit invoice:
   - which fields change: totalPrice, remainingAmount, refundedAmount, refunds[], refundStatus, status;
   - what ReturnLog stores;
   - whether `original total = current totalPrice + refundedAmount` holds exactly for every case, including discount and shipping share on returns. Show the formula from the code.
4. **Delete today.**
   - What DELETE does for sellings, credit sales, products, categories and customers.
   - Which other documents reference a product, a category or a customer.
5. **Everywhere invoice totals are read:**
   - the dashboard
   - customer balance / outstanding
   - the profit report and profit bar
   - invoice history
   - the customer page
   - prints
   - Excel exports

   These must keep showing correct numbers after STEP D.
6. **Leftovers.** Where `Selling.shippingLocation`, `Selling.government` and the createSellingInvoice `options` param are used.

## STEP A — Replica set and transactions
1. **Run mongod as a single-member replica set.**
   - Name it `rs0`. Bind to 127.0.0.1 only, as today. No keyfile is needed because it is loopback only; document why.
   - On the first start with the new args, run `replSetInitiate` with this one member (127.0.0.1:<port>) and wait until it is PRIMARY. Later starts must be idempotent.
   - An existing standalone data folder (dev and test machines) must be converted on its first start, with no data loss. Test it.
2. **Connection.**
   - MONGO_URI gets `replicaSet=rs0&directConnection=true`, or the equivalent.
   - The backend checks at startup that transactions are supported. If they aren't, it refuses to start with a clear error. It must not fall back silently.
3. **All mongod starters use the replica set:** test helpers, the smoke test, setup-restore and the backup/restore paths (mongodump/mongorestore against a replica set). A restore must leave the replica set healthy.
4. **One helper** `withTransaction(fn)` (session, retries on TransientTransactionError / UnknownTransactionCommitResult). Every route from STEP 0.2 uses it, with every read and write inside passing the session.
5. **Tests:**
   - forced failure in the middle of a cash sale, credit sale, payment, return and cancel → nothing changed (stock, invoice, customer, counter, return log);
   - two concurrent sales of the last unit → exactly one succeeds, and stock never goes below 0.

## STEP B — Sequential document numbers
1. **Counter collection** `{ _id: <prefix>, seq }`, incremented with `findOneAndUpdate($inc)` **inside the same transaction** as the document. An aborted transaction leaves no gap.
2. **Prefixes and format:** `<PREFIX>-000001`, with 6 digits that grow past 999999 if needed, never reset.
   - `INV` cash sale
   - `CR` credit sale
   - `RT` return (cash and credit)
   - `RC` customer receipt (each credit payment, both routes, plus the down payment on a new credit sale if it is recorded as a payment; report how it works today)
   - Reserve `PV`, `PO`, `JE`, `SH`, `EX` and `OB` in the constants with no use yet.
3. **Fields:**
   - `number` (String) on Selling, CreditSale, ReturnLog and each payment entry. It has a unique index; for payments use a separate collection or a unique compound index, and explain the choice.
   - Responses include `number`.
4. **Backfill on startup.**
   - Existing documents without a number get one, ordered by their date and then createdAt. It runs once, inside a migration, and is recorded (see STEP F).
5. **Search by number:** `GET /api/sellings`, `/api/credit-sales` and `/api/returns` accept `number` (exact match, case-insensitive, and `INV-12` matches `INV-000012`).

## STEP C — Cancel instead of delete
1. **Invoices are never deleted.**
   - Remove `DELETE /api/sellings/:id` and `DELETE /api/credit-sales/:id`.
   - Add `POST /api/sellings/:id/cancel` and `POST /api/credit-sales/:id/cancel` with `{ reason }`. The reason is required, 3–500 characters.
2. **Cancel cash invoice:**
   - status becomes `cancelled`, with cancelledAt, cancelledBy and cancelledByName;
   - restore to stock only the units that were not already returned;
   - already-cancelled → 409 `ALREADY_CANCELLED`.
   - The cash refund itself is recorded in Stage 19 (cash boxes). For now, store `cancelRefundAmount` (what the customer gets back = net invoice minus already refunded).
3. **Cancel credit invoice:**
   - Allowed only when there are no payments other than the down payment, and no returns. Otherwise → 409 `HAS_PAYMENTS` / `HAS_RETURNS` with an Arabic message: "اعمل مرتجع بدل الإلغاء".
   - With the down payment only: cancel, restore all stock, and set `cancelRefundAmount` = the down payment. The customer balance drops by the remaining amount.
4. **Cancelled invoices.** They:
   - stay readable;
   - are excluded from the dashboard, outstanding balances, overdue, the profit report/bar, low-stock-related sales stats and customer totals;
   - show in history with a "ملغية" badge and the reason.
   - They can't be edited, paid or returned (409 `CANCELLED`).
5. **Permissions:** keep the keys `sales.delete` and `credit.delete`. Relabel them "إلغاء فاتورة كاش" / "إلغاء فاتورة آجل" in the catalog. Update the route map and the router-walk test.
6. **Audit:** `sale.cancelled` and `credit.cancelled`, with the reason. Remove `sale.deleted` and `credit.deleted`.

## STEP D — Refunds kept separately (invoice keeps its original total)
1. **The invoice keeps its original values.** `totalPrice`, `subtotal`, `discountAmount` and `shippingFees` stay as sold.
   - Returns are recorded on ReturnLog (with `number`) and summed on the invoice as `refundedAmount` / `refundedQuantity` / `refunds[]`, as today.
   - Add a computed `netTotal = totalPrice − refundedAmount`, included in responses.
   - Credit: `remainingAmount = totalPrice − paidAmount − refundedAmount`, never below 0. If refunds and payments exceed the total, the excess stays in `refundDueAmount`, as today. Report how it is used.
2. **Everything from STEP 0.5 uses `netTotal`** where it used the returned-adjusted `totalPrice` before:
   - **Sales figures** (dashboard today/7 days, profit) = net of returns.
   - **Profit:**
     - Use the invoice profit minus the returned items' profit at their original cost, as today if that's what the code does. Report it.
     - Returned stock re-enters at its original purchase price.
3. **Migration for existing data** (STEP F): for each invoice with refunds, set `totalPrice` back to `totalPrice + refundedAmount`. Do this only if STEP 0.3 shows the formula is exact. Otherwise stop and tell me before writing the migration.
   - Test it with fixtures for:
     - a cash partial return
     - a cash full return
     - a credit return with payments
     - returns with a discount share
4. **Customer statement data.** `GET /api/customers/:id/statement?from&to` returns ordered lines:
   - `{ date, type: opening|invoice|payment|return|cancel, number, description, debit, credit, balance }`
   - an opening balance before `from`;
   - totals.
   - Invoice = debit of its original total. A payment or a return = credit. A cancelled invoice appears with its debit and a matching cancel credit line, so the balance is right.
   - It is read-only, follows PrCustomerStatement in the design, and needs `customers.view`.

## STEP E — Delete safeguards and leftovers
1. **Products.**
   - DELETE is a hard delete only if no invoice, return or credit sale references the product.
   - Otherwise it archives: `isArchived: true`, `archivedAt`, `archivedBy`. Archived products are hidden from lists, search and the POS by default, with `?includeArchived=1` for admins. They keep their history and can be restored with `POST /api/products/:id/restore` (needs `products.manage`).
   - Report which one happened in the response.
2. **Categories.** Only an empty category can be deleted; archived products count. Otherwise → 409 `CATEGORY_NOT_EMPTY`. This replaces "delete the category and all its products".
3. **Customers.** A customer with any invoice → 409 `CUSTOMER_HAS_INVOICES`. Otherwise delete.
4. **Leftovers.** Remove `Selling.shippingLocation`, `Selling.government` and the createSellingInvoice `options` param. Keep `shippingFees`.

## STEP F — Migrations framework
1. **A `meta` collection** `{ _id: "schema", version }`, plus an ordered list of migrations in `src/migrations/`. Each migration is idempotent, runs inside a transaction where possible, and is logged in the audit log as `system.migration`.
2. **When they run:** at backend startup, before listen, after the replica-set check. A failed migration → the backend refuses to start with a clear error, and the data is unchanged.
3. **Restore.** After restoring an older backup, the migrations run on the next start. Test it with a fixture DB in the pre-Stage-16 format.
4. **This stage's migrations:**
   1. numbers backfill;
   2. original totals;
   3. remove leftover fields;
   4. indexes.

## STEP G — Frontend
1. **Numbers.**
   - Show the document number in invoice history, the customer page, the credit sales list, returns, the invoice detail panels and the existing cash/credit invoice prints. Replace the current ad-hoc invoice codes where they exist.
   - Add search by number in invoice history and in the returns wizard. This is the "returns wizard can search by invoice number" item from the plan.
2. **Cancel.**
   - Replace the delete actions with "إلغاء الفاتورة": a dialog with a required reason and a summary of what happens (stock back, refund amount, or why it can't be cancelled).
   - Use the permission-locked pattern as today.
   - Show the cancelled badge and reason. Remove the old "deleting doesn't restore stock" warning.
3. **Totals.**
   - Invoice panels show the original total, returns and net.
   - The customer page uses the statement endpoint for its account tab: date, number, description, debit, credit, balance.
4. **Products.**
   - The product delete dialog says whether the product will be archived or deleted.
   - An "عرض المؤرشف" toggle and "استرجاع" button appear for `products.manage`.
   - The category delete shows the not-empty message.

## STEP H — Tests
- **Backend:**
  - the replica-set start and conversion (Electron tests where mongod-manager lives);
  - transactions rollback for each write;
  - concurrency on the last unit;
  - numbering: sequence, no gaps after an aborted transaction, backfill order, search;
  - cancel rules: cash, credit with/without payments or returns, double cancel, edits/payments/returns on cancelled;
  - netTotal and remaining;
  - statement lines and balance, including cancel and returns;
  - each migration on fixtures (and that running it twice changes nothing);
  - product archive vs delete, category not empty, customer with invoices;
  - the route map and router-walk test.
- **Smoke:**
  - replace "Delete cash invoice → stock unchanged" and "Delete credit invoice → stock unchanged" with cancel scenarios (stock restored by the not-returned units, and cancelRefundAmount);
  - add:
    - numbers on every document;
    - search by number;
    - a credit invoice with a payment can't be cancelled;
    - the statement for the smoke customer matches the expected lines;
    - archive of a product with sales;
    - deleting a non-empty category → 409;
    - the dashboard figures after a return and a cancel.
- **Frontend specs:**
  - number display and search;
  - cancel dialog (reason required, each blocked case);
  - statement table;
  - archive toggle and restore;
  - payload specs for every new or changed call.
- **Screenshots** in `nota-review/stage-16/`:
  - invoice history with numbers and a cancelled row
  - cancel dialog
  - customer statement tab
  - returns search by number
  - archived products
  - light/dark and ar/en for the two main screens

## VERIFICATION
- backend: `npm test` (0 skipped tests that need mongod)
- frontend: `npm run build:offline`
- frontend: `npx ng test --watch=false --browsers=ChromeHeadless`
- frontend: `npm run test:offline`
- frontend: `npm run smoke:offline` (report every line)
- frontend: `npm run offline:stage`
- On Windows only: `npm run electron:build:win:offline`. Otherwise list it under "needs Windows".
- **Manual check on the installed app (Windows):**
  1. Upgrade an existing install that has test data. The replica set converts and the numbers backfill; check that the totals didn't change.
  2. Do a cash sale, a partial return, and then cancel it. Check stock and the history badge.
  3. Credit sale with a payment → cancel is refused → do a return instead → the statement shows the invoice, payment and return lines.
  4. Restore a backup taken before this stage → the app starts and the migrations run.

Update docs/OFFLINE_PLAN.md:
- mark Stage 16 done;
- record the decisions: numbering, cancel rules, netTotal, migrations, archive;
- remove the items this stage closed;
- add "Stage 17 must" items you discover.

Do not commit.

## Final report — exactly this, in one code block
```
=== STAGE 16 REPORT ===
STEP 0 findings (mongod start, multi-document writes, returns formula, delete today, totals readers, leftovers):
Replica set (args, initiate, conversion, URI, startup check, backup/restore):
withTransaction (helper, routes using it, rollback tests):
Concurrency test result:
Numbering (counter, prefixes, payment numbers choice, backfill, search):
Cancel (routes, rules, error codes, cancelRefundAmount, excluded from which figures):
Refunds separate (fields, netTotal, remaining, refundDueAmount, profit rule):
Migration of original totals (formula proof, fixtures):
Customer statement endpoint (lines, opening, cancel lines):
Products/categories/customers delete rules:
Leftovers removed:
Migrations framework (meta, order, failure behavior, restore of old backup):
Frontend changes (each screen):
Permissions/catalog/route map changes:
Backend tests (new / total, skipped):
Frontend tests (new / total):
Electron tests (new / total, skipped):
Smoke test (every line):
Screenshots (paths):
Manual installed-app check (each step, or needs Windows):
Docs updated:
Open questions / anything you didn't do:
```
