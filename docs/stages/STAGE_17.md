# Stage 17 — Chart of accounts + automatic journal entries

Read before starting:
- docs/OFFLINE_PLAN.md: the "Accounting (double-entry)" section and the Stage 16 decisions
- docs/design/NOTA_DESIGN_SYSTEM.md
- docs/stages/STAGE_16.md: its hard rules apply

Design references, in docs/design/screens/:
- Accounts.dc.html
- ManualEntry.dc.html, for the journal detail layout only. Manual entries are NOT in this stage.

Start in plan mode and show me the plan before changing anything. Use Node 24.

**Start this stage only after Stage 16 is reviewed, fixed and pushed.** Work on the same branch.

This stage adds the general ledger:
- a chart of accounts;
- one journal entry posted automatically, in the same transaction, for every financial event the app already has;
- a ledger that agrees with the operational data.

It adds no new business features:
- no cash boxes (Stage 19);
- no purchases or suppliers (Stage 20);
- no manual entries, trial balance UI or financial statements (Stage 21);
- no opening-balance wizard (Stage 18).

## Hard rules
1. **Every financial event posts its entry inside the same `withTransaction`** as the document. If the entry fails, the sale, return, payment or cancel fails too.
2. **Every entry balances exactly.** Σdebit = Σcredit after rounding every line to 2 decimals. An unbalanced entry is a bug and aborts the transaction; never "fix" a difference silently.
3. **Posted entries are never edited or deleted.** A correction is a reversing entry (an exact mirror, linked both ways) plus a new entry.
4. **Postings use accounts by `systemKey`, never by code or name,** so users can rename accounts later.
5. **No change to operational behavior:** prices, stock, balances, statements and the dashboard stay as they are. The ledger is added next to them, and it must agree with them (STEP F).
6. **Styling:** tokens only (no hex, no `[attr.dir]`), light and dark, Arabic and English.
7. **Safety:**
   - Never commit.
   - The smoke test never uses the real DB or port 27017.
   - Ask before sudo.

## STEP 0 — Findings (read-only, report before planning)
1. **Every place that changes money, stock value or a customer balance.** For each one, give the route/function and what changes:
   - cash sale create/edit/cancel
   - credit sale create/edit/cancel
   - down payment and receipts (RC)
   - cash and credit returns, including overpayment reallocation and refundDue
   - "رد المقدم" on cancel
   - the confirmed auto-restock in a cash sale
   - product create with stock, and stock edits in the product form
   - purchasePrice change on a product that has stock
   - sync-purchase-price on past invoices
   - category import with stock
   - product hard delete with stock
   - anything else you find
2. **How invoice totals break down:** subtotal, discount, shippingFees, total. Also the return amounts: subtotalReturned, discount share, shipping share, finalReturnedAmount. And the cost/profit per line, including costEstimated lines.
3. **What cost the app uses for COGS** at sale time (product.purchasePrice at that moment?), and what cost a return puts back into stock.
4. **The withTransaction helper, the counter (JE is reserved), and the migrations framework** from Stage 16. Where a posting call fits in each flow.

## STEP A — Chart of accounts
1. **Model `Account`:**
   - `code` (unique)
   - `nameAr`, `nameEn`
   - `type`: asset | liability | equity | revenue | expense
   - `normalSide`: debit | credit
   - `parentId`
   - `isGroup`: only non-group accounts can be posted to
   - `isSystem`: can't be deleted; its code and type can't change, but its names can
   - `systemKey` (unique when set)
   - `isActive`
   - timestamps
2. **Seed through a migration.** Codes follow the design (Accounts.dc.html):

   ```
   1    الأصول                                group
   11     أصول متداولة                         group
   111      الخزائن                           group
   1111       الخزنة الرئيسية                  CASH_MAIN
   112      البنوك والمحافظ                    group   (sub-accounts in Stage 19)
   113      العملاء                           CUSTOMERS   (control account; customer = party on the line)
   114      المخزون                           INVENTORY
   12     أصول ثابتة                           group
   121      أثاث ومعدات                        FIXED_ASSETS
   2    الخصوم                                group
   21     الموردين                             SUPPLIERS   (used in Stage 20)
   22     ضريبة القيمة المضافة المستحقة          VAT_PAYABLE (used in Stage 21)
   23     مصروفات مستحقة                       ACCRUED_EXPENSES
   3    حقوق الملكية                           group
   31     رأس المال                            CAPITAL
   32     الأرباح المحتجزة                      RETAINED_EARNINGS
   33     جاري المالك                          OWNER_DRAWINGS
   4    الإيرادات                              group
   410    المبيعات                             SALES
   420    خصم مسموح به                         SALES_DISCOUNT   (contra-revenue, debit normal)
   430    مردودات المبيعات                     SALES_RETURNS    (contra-revenue, debit normal)
   440    إيراد الشحن                          SHIPPING_INCOME
   450    إيرادات أخرى                         OTHER_INCOME
   5    المصروفات                              group
   510    تكلفة البضاعة المباعة                 COGS
   520    مصروفات تشغيل                        group
   521      مرتبات                             EXP_SALARIES
   522      إيجار                              EXP_RENT
   523      كهرباء ومياه                       EXP_UTILITIES
   524      نقل ومشاوير                        EXP_TRANSPORT
   525      مصروفات متنوعة                     EXP_MISC
   530    عجز وزيادة الخزينة                   CASH_OVER_SHORT  (used in Stage 19)
   540    فروق وتسويات المخزون                 INVENTORY_ADJUSTMENT
   ```

   - Give English names too.
   - In the report, tell me if a code clashes with something the design showed.
3. **Accounts API:**
   - `GET /api/accounting/accounts`: the tree, with each account's balance as of a date (`?asOf=`), rolled up for groups.
   - `GET /api/accounting/accounts/:id/ledger?from&to&partyId`: opening balance, lines, running balance.
   - Creating, editing and deleting accounts is Stage 21, so this stage has no write routes.

## STEP B — Journal entries
1. **Model `JournalEntry`:**
   - `number`: JE-000001, from the transactional counter, gapless;
   - `date`: the business date of the source document;
   - `type`: auto | reversal | opening (manual comes in Stage 21);
   - `source { type, id, number }`: e.g. `{ "sale", <id>, "INV-000012" }`;
   - `lines[]`: `{ accountId, accountCode, accountName (snapshots), debit, credit, partyType (customer|supplier|null), partyId, partyName, description }`;
   - `totalDebit`, `totalCredit`;
   - `status: posted`;
   - `reversalOf` / `reversedBy`;
   - `memo`;
   - `createdBy` / `createdByName` (the plugin);
   - timestamps.

   Validation:
   - at least 2 lines;
   - each line has exactly one of debit or credit > 0;
   - no posting to a group or inactive account;
   - a party is required on CUSTOMERS lines and forbidden elsewhere, except on SUPPLIERS lines, which are Stage 20;
   - the totals are equal.
2. **One posting service `src/accounting/posting.js`.**
   - It has one function per event, each building the lines from the document. Each takes `{ session }`.
   - `postEntry()` validates, numbers and saves.
   - `reverseEntry(id, { date, memo, session })` creates the mirror and links both.
   - `reverseAllFor(sourceType, sourceId)` reverses every not-yet-reversed entry of a document and of its returns.
3. **Indexes:** source (type+id), date, `lines.accountId` + date, `lines.partyId` + date, number.

## STEP C — Posting rules (the accounting core; implement exactly, and test each one with numbers)
"Cash" means CASH_MAIN in this stage. Stage 19 will route it to the selected cash box or payment method.

1. **Cash sale (INV).** Here total = subtotal − discount + shipping.
   - Dr CASH_MAIN = total
   - Dr SALES_DISCOUNT = discount (if > 0)
   - Cr SALES = subtotal (Σ line price × qty)
   - Cr SHIPPING_INCOME = shippingFees (if > 0)
   - Dr COGS / Cr INVENTORY = Σ line cost × qty (if > 0)
2. **Credit sale (CR).**
   - The same as a cash sale, except Dr CUSTOMERS (party = the customer) = total instead of cash.
   - The down payment is not part of this entry. It is its own receipt (rule 3).
3. **Customer receipt (RC), including the down payment.**
   - Dr CASH_MAIN / Cr CUSTOMERS (party) = the amount.
   - One entry per receipt, even when it is allocated across several invoices.
4. **Return (RT).** Here final = subtotalReturned − discountShare + shippingShare.
   - Dr SALES_RETURNS = subtotalReturned
   - Dr SHIPPING_INCOME = shippingShare (if > 0)
   - Cr SALES_DISCOUNT = discountShare (if > 0)
   - Cr CASH_MAIN (cash return) or Cr CUSTOMERS (party, credit return) = final
   - Dr INVENTORY / Cr COGS = Σ returned qty × the cost recorded on the original line
   - **Reallocation of a credit overpayment to the same customer's other invoices posts nothing,** because it is the same party account. Any refundDue simply stays as a credit balance on the customer's party account.
5. **Cancel (cash or credit).**
   - Use `reverseAllFor()`: reverse the sale entry and every return entry of that invoice, dated on the cancel date.
   - The net effect equals the operational effect:
     - for cash, Cr CASH_MAIN = cancelRefundAmount;
     - stock comes back only for the units not returned.
   - Test this with numbers.
   - **A receipt (RC) is never reversed by a cancel.**
6. **"رد المقدم" on a credit cancel.** Dr CUSTOMERS (party) / Cr CASH_MAIN = the down payment. It is its own entry, with source `{ "refund", cancelId, <RC number of the down payment> }`.
7. **Invoice edit (PUT) on a cash or credit sale.** Reverse the current entry, then post a new entry for the edited invoice, dated on the edit date. If the invoice has returns, only its sale entry is reversed and re-posted; the return entries stay.
8. **Inventory adjustments.** For each case, Dr INVENTORY / Cr INVENTORY_ADJUSTMENT when value increases, and the opposite when it decreases. Value = qty × product purchasePrice.
   - the confirmed auto-restock in a cash sale (inside the sale transaction, in the same entry or its own entry; say which);
   - product create with stock > 0 after the ledger start;
   - stock edits in the product form;
   - category import with stock;
   - hard delete of a product that still has stock (write-off).
9. **Cost revaluation.** When a product's purchasePrice changes while it has stock: the amount is stock × (new − old). Post Dr/Cr INVENTORY vs INVENTORY_ADJUSTMENT by that amount. This keeps INVENTORY = Σ stock × purchasePrice.
10. **sync-purchase-price on past invoices.** It changes the recorded cost of sold lines. For each affected invoice the amount is Σ qty × (new − old cost). Post one entry for the whole sync, with Dr/Cr COGS vs INVENTORY_ADJUSTMENT by the total and one line per invoice in the description, or an aggregated line. Explain the choice.
    - Rationale: the stock already left at the old cost, so the correction goes to adjustment, not to inventory.
11. **costEstimated lines from the Stage 16 migration** post at their estimated cost. Add no special handling, only the note.
12. **Rounding.** Compute each line from stored, already-rounded document values. If the parts don't add up to the stored total because of the source data, stop and report it. Don't plug a rounding line.

## STEP D — Ledger start and opening entry
- History before this stage is **not** re-posted.
- A migration records `meta.ledgerStartAt` (the time it runs) and posts one **opening entry** (type `opening`, OB number reserved in Stage 16; use `OB-000001`) as of that moment:
  - Dr INVENTORY = Σ current stock × purchasePrice (non-archived and archived products with stock)
  - Dr CUSTOMERS, one line per customer with a balance:
    - Dr their current outstanding (statement closing balance);
    - a negative balance (we owe them) → a Cr line.
  - Cr CAPITAL = the difference, so the entry balances. If the difference is negative, it goes to Dr CAPITAL. Report the sign.
  - CASH_MAIN is 0. Opening cash, suppliers and fixed assets come with the Stage 18 wizard, which adjusts this opening entry by reversing and re-posting it.
- A fresh install with no data gets an opening entry with no lines → skip it, and record `ledgerStartAt` only.
- Documents dated before `ledgerStartAt`, such as an edit or a return on an old invoice:
  - the event itself is posted on its own date, which is ≥ ledgerStartAt;
  - a return on a pre-ledger invoice posts normally (rule 4);
  - an edit or cancel of a pre-ledger invoice has no sale entry to reverse. Post the difference instead:
    - for a cancel: the reversal of what the original entry would have been;
    - for an edit: new minus old.
  - Report how you implement it, and test it.

## STEP E — Permissions and UI (read-only this stage)
1. **New permission keys:**
   - `accounting.view`: the accounts tree, ledgers and journal;
   - `accounting.manage`: reserved for Stage 21.

   Role templates:
   - owner: all;
   - accountant: `accounting.view`;
   - manager: `accounting.view`;
   - cashier and storekeeper: none.

   Update the catalog, the route map and the router-walk test.
2. **Routes:**
   - `GET /api/accounting/journal?from&to&type&sourceType&number&accountId&partyId`: paginated, newest first;
   - `GET /api/accounting/journal/:id`;
   - plus the accounts routes from STEP A.
3. **Frontend, under the sidebar group الحسابات:**
   - **"دليل الحسابات" (/accounting/accounts),** following Accounts.dc.html: the tree with codes, names and balances, and an as-of date. Clicking a leaf opens its ledger. For CUSTOMERS, the ledger can be filtered by a customer.
   - **"القيود اليومية" (/accounting/journal):**
     - a list with number, date, type, source (a link to the invoice, return or receipt), memo and total;
     - filters;
     - a detail view with the lines (code, account, party, debit, credit), totals, the reversal links and createdBy.
   - A "عرض القيد" link from the cash/credit invoice panels, returns and receipts to their entries. Show it only with `accounting.view`.
   - Light/dark, ar/en, and 390px usable.

## STEP F — Reconciliation (the ledger must agree with the app)
1. **`GET /api/accounting/health`** (`accounting.view`) returns each check with expected, actual and the difference:
   - **trial balance:** Σ all debits = Σ all credits;
   - **INVENTORY balance** = Σ product stock × purchasePrice;
   - **CUSTOMERS balance per party** = that customer's statement closing balance (Stage 16 endpoint), and the total = Σ outstanding − Σ customer credits;
   - **SALES − SALES_RETURNS − SALES_DISCOUNT + SHIPPING_INCOME for a period** = the dashboard/profit-report net sales for the same period (from ledgerStart);
   - **COGS for a period** = the profit report's cost for the same period;
   - every financial document since ledgerStart has its entry (count by source type), and no entry points to a missing document.
2. **The smoke test calls health at the end, and every check must be 0 difference.**

## STEP G — Tests
- **Backend, one test per posting rule with real numbers.** Use the shop data from the test sheet where possible:
  - a cash sale with discount and shipping;
  - a credit sale with a down payment of 200 on 790;
  - receipts allocated across invoices;
  - a cash partial return with discount and shipping shares;
  - a credit return with an overpayment reallocation and refundDue;
  - cash cancel after a partial return (the net equals cancelRefundAmount, and stock value is back for the not-returned units only);
  - credit cancel with a down payment ("رد المقدم", net 0);
  - an edit (reverse + new);
  - auto-restock;
  - product stock edit;
  - purchasePrice revaluation;
  - sync-purchase-price;
  - a category import with stock;
  - a hard delete with stock;
  - the opening entry (with a negative customer balance);
  - an event on a pre-ledger invoice;
  - a rollback when posting fails (forced error → no document, no stock change, no counter gap);
  - entry validation (unbalanced, a group account, a missing party);
  - the reversal links;
  - the health checks all 0 after a mixed scenario.
- **Smoke:** after the existing scenarios, check:
  - JE numbers exist for each document;
  - the journal list;
  - one entry's lines for the cash sale;
  - the health endpoint all 0;
  - a cashier gets 403 on /api/accounting.
- **Frontend specs:**
  - the accounts tree (balances, roll-up, as-of);
  - a ledger with a party filter;
  - the journal list filters and detail;
  - "عرض القيد" links hidden without `accounting.view`;
  - the sidebar per role.
- **Screenshots** in `nota-review/stage-17/` (gitignored):
  - the accounts tree light/dark ar/en;
  - the customers ledger filtered;
  - the journal list;
  - an entry detail with a reversal;
  - the health result (there's no screen; save the JSON output in the report instead).

## VERIFICATION
- backend: `npm test` (0 skipped tests that need mongod)
- frontend: `npm run build:offline`
- frontend: `npx ng test --watch=false --browsers=ChromeHeadless`
- frontend: `npm run test:offline`
- frontend: `npm run smoke:offline` (every line)
- frontend: `npm run offline:stage`
- On Windows: `npm run electron:build:win:offline`. Then a manual check on the installed app over existing data:
  1. the opening entry appears;
  2. a cash sale with discount, then a return, then a cancel → check the entries;
  3. a credit sale with a down payment, then a cancel → "رد المقدم";
  4. health is all 0.

Update docs/OFFLINE_PLAN.md:
- mark Stage 17 done;
- record the chart, the posting rules table, the ledger start and the health checks;
- add a "Stage 18 must" list (opening wizard adjusts OB-000001) and a "Stage 19 must" list (route CASH_MAIN to the selected box/method).

Do not commit.

## Final report — exactly this, in one code block
```
=== STAGE 17 REPORT ===
STEP 0 findings (money/stock events, totals breakdown, COGS cost, where posting fits):
Chart of accounts (final codes, systemKeys, clashes):
JournalEntry model and validation:
Posting rules (each rule → function, lines, test name):
Cancel = reverseAllFor (numeric proof):
Edits (reverse + new) and pre-ledger invoice events:
Inventory adjustments and revaluation (each case):
sync-purchase-price entry (choice):
Ledger start and opening entry (sign of capital line):
Permissions, routes, route map:
Frontend (accounts tree, ledger, journal, links):
Health checks (each check → result in smoke):
Backend tests (new / total, skipped):
Frontend tests (new / total):
Electron tests (total, skipped):
Smoke test (every line):
Screenshots (paths):
Manual installed-app check (each step, or needs Windows):
Docs updated:
Open questions / anything you didn't do:
```
