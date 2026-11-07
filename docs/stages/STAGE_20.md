# Stage 20 — Purchases, supplier payments, purchase returns, supplier statement

Read before starting:
- docs/OFFLINE_PLAN.md: the Stage 16–19 sections and the "Stage 20 must" list
- docs/design/NOTA_DESIGN_SYSTEM.md
- docs/stages/STAGE_19.md: its hard rules apply

Design references, in docs/design/screens/:
- Purchases.dc.html: the new purchase invoice, with the live journal preview
- SupplierPayment.dc.html
- Suppliers.dc.html: the list, the balance and the statement panel

Start in plan mode and show me the plan before changing anything. Use Node 24 and the bundled mongod.

Until now stock entered only by typing it on the product (an adjustment, or opening stock in setup mode). After this stage, a shop buys goods with a **purchase invoice**:
- stock goes up;
- the product cost is updated;
- the supplier's balance goes up;
- whatever was paid comes out of a box.

The shop pays suppliers with **payment vouchers (PV)**, and can return goods to a supplier. Every supplier has a statement that agrees with the ledger.

## Accounting decisions (already made; implement exactly)
1. **Cost method: moving weighted average.** On every purchase line:
   - newCost = (oldQty × oldCost + qty × lineUnitCost) / (oldQty + qty), rounded to 2 decimals;
   - if oldQty ≤ 0, then newCost = lineUnitCost;
   - product.purchasePrice becomes newCost.
   - This keeps INVENTORY = Σ stock × purchasePrice without fake adjustments.
   - Any rounding difference from the 2-decimal rounding (≤ a few piasters) posts to INVENTORY_ADJUSTMENT in the same entry, so the inventory health check stays exact. Report the largest rounding seen in the tests.
   - Sales keep snapshotting product.purchasePrice per line, so COGS uses the average at sale time.
   - A purchase is **not** a cost revaluation: don't call the Stage 17 revaluation path for it.
2. **Line unit cost** = unit price − the invoice discount allocated by line value + other costs (freight etc.) allocated by line value.
   - Allocation is by line value with the last line absorbing the rounding remainder, so Σ line costs = invoice total exactly.
   - Purchase discount and freight therefore live in the product cost, not in separate P&L accounts.
3. **Purchase invoice (PO-000001)** posting, in one transaction:
   - Dr INVENTORY = the invoice total (Σ line costs)
   - Cr box = the paid amount, if any
   - Cr SUPPLIERS (party) = the remainder, if any
   - Payment modes, following the design:
     - "كاش كله": paid = total;
     - "جزء كاش": 0 < paid < total;
     - "آجل كله": paid = 0.
   - A paid amount > 0 creates a **PV** for it (PV-000001) linked to the purchase, from a chosen box. It uses the same resolveBox/default/shift rules as an expense (direction "out", the one-box rule from Stage 19).
   - So the posting is really two entries:
     - the purchase: Dr INVENTORY / Cr SUPPLIERS = total;
     - the PV: Dr SUPPLIERS / Cr box = paid.
   - This keeps the supplier statement simple (invoice credit, payment debit), like customers. The design's single-entry preview shows the net effect; keep the preview but post the two entries.
4. **Supplier payment (PV)** from SupplierPayment.dc.html:
   - Dr SUPPLIERS (party) / Cr box;
   - optional reference (cheque/transfer number) and note;
   - it may exceed the current balance only with an explicit confirm, producing a supplier debit balance (an advance), shown as such.
5. **Purchase return (PR-000001)** to a supplier, for items of one purchase invoice:
   - quantities up to purchased − already returned, and stock must cover them;
   - value = qty × that line's unit cost;
   - stock goes down;
   - product.purchasePrice stays unchanged (removing units at their own cost doesn't change the average conceptually). INVENTORY must still equal Σ stock × purchasePrice, so:
     - Cr INVENTORY = qty × current purchasePrice;
     - the difference against the line value goes to INVENTORY_ADJUSTMENT;
     - Dr SUPPLIERS (party) = the line value. The supplier owes us that, or it reduces what we owe.
   - Optional cash refund from the supplier, received into a box: a separate receipt-type document "استرداد من مورد" (SR-000001): Dr box / Cr SUPPLIERS.
6. **Cancel a purchase invoice** (`purchases.cancel`, a reason required):
   - allowed only if no purchase return exists and stock still covers every line (otherwise → 409 `STOCK_ALREADY_USED` / `HAS_RETURNS`);
   - reverse the purchase entry;
   - stock goes down;
   - INVENTORY gets the same current-cost treatment as a return, with the difference to adjustment;
   - product.purchasePrice stays at the current average;
   - its linked PV is NOT reversed automatically. The money was paid; the supplier balance shows it as an advance. Cancel the PV separately if the money came back.
   - PV cancel = a reversal with a reason, refused into an inactive box (Stage 19 rules).
   - Editing a posted purchase is not allowed: cancel + new.
7. **Setup mode:** the first purchase ends setup mode, like the first sale (Stage 18).

## Hard rules
1. **Every purchase, PV, return and refund posts in the same transaction** as its documents, stock and counters. Stock increases use `$inc` with the session. Stock decreases are conditional (`$gte`), like sales.
2. **No change to sales, returns, customers, boxes or shifts behavior,** except that shift expected/boxEvents include PVs and supplier refunds on their box.
3. **Posted entries are never edited**; corrections are reversals.
4. **Styling:** tokens only (no hex, no `[attr.dir]`), light/dark, ar/en, RTL, 390px.
5. **Safety:**
   - Never commit.
   - Never use port 27017, the real DB or C:\ProgramData\Nota.
   - Ask before sudo.

## STEP 0 — Findings (read-only, report before planning)
1. **Product stock and cost today:** every path that changes inventoryCount or purchasePrice, and how Stage 17–19 post them.
2. **The Supplier model, the supplier PartyOpening and the SUPPLIERS party validation** (Stage 18); the current suppliers UI and its balance source.
3. **The Stage 19 box helpers** (resolveBox, direction "out", the one-box rule, lockAndTouch, boxEvents/shiftExpected) and where a new money document plugs in.
4. **Document number prefixes:** PO and PV are reserved. Add PR (purchase return) and SR (supplier refund).
5. **The health "suppliers" check today** (opening only), and the "entries" coverage check.
6. **The design screens' fields:** Purchases, SupplierPayment and Suppliers. Note anything the design shows that this brief doesn't cover.

## STEP A — Models and API
1. **`Purchase`:**
   - number, supplierId, supplierName
   - supplierInvoiceNo, date
   - items: [{ productId, name, code, qty, unitPrice, lineTotal, unitCost, returnedQty }]
   - subtotal, discountAmount, otherCosts, total
   - paidAmount, boxId, pvId
   - status: posted | cancelled, cancel fields
   - notes
   - auditFields
2. **`SupplierPayment` (PV):**
   - number, supplierId, date, amount, boxId
   - reference, note
   - purchaseId (optional)
   - status, cancel fields
   - auditFields
3. **`PurchaseReturn` (PR):**
   - number, purchaseId, supplierId, date
   - items: [{ productId, qty, unitCost, value }]
   - total, reason
   - auditFields
4. **`SupplierRefund` (SR):** number, supplierId, amount, boxId, date, note, status.
5. **Routes:**
   - `/api/purchases`: list, filter (supplier/date/number/status), detail, create, cancel;
   - `/api/purchases/:id/returns`;
   - `/api/suppliers/:id/payments`;
   - `/api/supplier-payments/:id/cancel`;
   - `/api/suppliers/:id/refunds`;
   - `/api/suppliers/:id/statement?from&to`.
   - Number search like Stage 16.
6. **New products from the purchase screen:** an inline "صنف جديد" creates a product with stock 0 (normal product validation; needs `products.manage` + `products.viewCost`), then the purchase adds its stock and sets its cost.
7. **Permissions:** `purchases.view`, `purchases.create`, `purchases.cancel`, `suppliers.pay`.
   - Templates:
     - owner: all;
     - manager: all;
     - storekeeper: purchases.view + purchases.create (paying needs `suppliers.pay`, which they don't have, so a storekeeper's purchase is "آجل كله" unless a payer does it);
     - accountant: purchases.view + suppliers.pay;
     - cashier: none.
   - Dependency: all purchase permissions require `products.viewCost` (like accounting.view).
   - Update the catalog, the route map and the router-walk test.

## STEP B — Supplier statement and balances
1. **Statement** (`suppliers.view`). Lines, oldest first:
   - opening ("رصيد أول المدة" from the PartyOpening);
   - purchase = credit (we owe more);
   - PV = debit;
   - purchase return = debit;
   - supplier refund = credit;
   - cancel lines (a cancelled purchase shows its debit reversal; a cancelled PV shows a credit).
   - Running balance: positive = we owe the supplier.
   - Totals and aging by due date. A purchase is due at date + supplier.paymentTermsDays; the opening is due at ledgerStartAt.
2. **One balance source** (like customers): the suppliers list, the purchase screen's "رصيد المورد قبل الفاتورة", the payment dialog's "علينا ليه دلوقتي" and the dashboard all use it.
3. **Supplier delete:** blocked when there are any purchases/PVs/returns/refunds (409 `SUPPLIER_HAS_BALANCE` stays, plus `SUPPLIER_HAS_DOCUMENTS`).
4. **Dashboard:** a "مستحق للموردين" KPI (total we owe), with `suppliers.view`.

## STEP C — Screens
1. **Purchase invoice (Purchases.dc.html):**
   - supplier picker with its balance;
   - supplier invoice no.;
   - date;
   - lines: product search, qty, unit price, line total, and "المخزون بعد";
   - discount and other costs (a collapsible "خصم ومصاريف");
   - total;
   - the three payment modes, paid amount and box (Stage 19 selector);
   - "يتبقى للمورد";
   - the live journal preview;
   - "رصيد المورد بعد الحفظ".
   - Show each line's resulting average cost in a small hint: "التكلفة الجديدة ≈ X".
   - Save → the detail with PO number, and the PV number if paid.
2. **Purchases list:**
   - number, supplier, supplier invoice no., date, total, paid, status, filters;
   - detail: lines, cost per unit, returns, cancel (locked pattern), "عرض القيد" (accounting.view).
3. **Purchase return:** from the purchase detail. Pick lines and quantities (≤ available), a reason, and an optional immediate refund (box). Preview the value.
4. **Supplier payment dialog (SupplierPayment.dc.html):**
   - the current balance → after;
   - amount, box with its balance, date, reference, note;
   - the advance confirm when amount > balance.
5. **Suppliers page (Suppliers.dc.html):**
   - list with balance and last purchase date;
   - the selected supplier's panel: "سداد دفعة", "فاتورة شراء", "طباعة كشف" (print in Stage 22; hidden behind a flag for now), and the statement table with totals and aging.
6. **Sidebar:** under المخزون → "المشتريات" (purchases.view); suppliers stay.

## STEP D — Boxes, shifts, health
1. **PVs and supplier refunds** are money documents on their box:
   - resolveBox (direction "out" for PV, "in" for SR);
   - lockAndTouch;
   - boxEvents and shiftExpected include them (PV = out, SR = in);
   - the shift close panel shows them as their own lines ("سداد موردين", "استرداد من موردين").
2. **Health:**
   - **suppliers**, per supplier: ledger party balance = the statement closing balance (opening + purchases − PVs − returns + refunds ± cancels), computed from documents. Report per supplier; difference = Σ|diff|.
   - **inventory** stays: INVENTORY = Σ stock × purchasePrice after purchases, returns and cancels.
   - **entries:** every PO/PV/PR/SR has its entry; no orphans.
   - **boxes/shifts** include PV/SR.
   - Can-fail tests for each.
3. **Profit/COGS:** a sale after a purchase uses the new average cost. Test it.

## STEP E — Tests
- **Backend (`test/stage20.test.js`), with real numbers:**
  - the design's invoice: 1,400 + 2,400 + 1,650 = 5,450, paid 3,000 from the main box → Dr INVENTORY 5,450 / Cr SUPPLIERS 5,450, PV 3,000 Dr SUPPLIERS / Cr main; supplier balance 4,200 → 6,650;
  - the design's payment: 2,500 from a bank → 4,150;
  - weighted average: stock 10 at 20 + purchase 10 at 30 → 25; stock 0 → the purchase price; negative stock → the purchase price; rounding (e.g. 3 at 10 + 7 at 10.33) → rounding to adjustment, health 0;
  - discount and other-cost allocation (Σ line costs = total exactly);
  - all three payment modes; a storekeeper purchase without suppliers.pay → paid must be 0 (403 if paid > 0);
  - a PV advance (with confirm), and without confirm → 409;
  - a purchase return (partial, then the rest; over-return → 409; stock already sold → 409) with the current-cost adjustment;
  - a supplier refund into a box;
  - cancel a purchase (allowed; STOCK_ALREADY_USED; HAS_RETURNS) with the PV left as an advance;
  - a PV cancel (inactive box → 409);
  - a sale after a purchase uses the average in COGS;
  - setup mode ends on the first purchase;
  - an inline new product;
  - permissions per role, incl. the viewCost dependency;
  - the statement lines, totals and aging; the dashboard KPI;
  - health all 0 after a mixed day; can-fail tests for suppliers/entries/boxes with PV and SR.
- **Legacy migration script:** after the upgrade, purchases and payments on an old supplier opening; health 0.
- **Smoke:** a supplier with an opening → a purchase (part cash, from a drawer in an open shift) → a payment from a bank → a return with a refund → cancel another purchase → a sale of the purchased product (COGS at the average) → health printed and 0 → a cashier gets 403 on purchases → a storekeeper can purchase on credit only.
- **Frontend specs:**
  - the purchase form (lines, allocation, payment modes, preview, the new-cost hint, the inline product);
  - the purchases list and detail;
  - the return dialog;
  - the payment dialog (advance confirm);
  - the suppliers page statement and aging;
  - the shift panel lines;
  - the dashboard KPI;
  - payload specs for every call.
- **Screenshots** in nota-review/stage-20/:
  - the purchase form with the preview, light/dark ar/en;
  - purchases list;
  - purchase detail with a return;
  - payment dialog;
  - suppliers page with the statement;
  - shift close with supplier lines;
  - 390px for the purchase form.

## VERIFICATION
- backend: `npm test`
- backend: `npm run test:legacy-migration`
- frontend: `npm run build:offline`
- frontend: `npx ng test --watch=false --browsers=ChromeHeadless`
- frontend: `npm run test:offline`
- frontend: `npm run smoke:offline` (every line)
- frontend: `npm run offline:stage`
- On Windows: `npm run electron:build:win:offline`

Manual check on the installed app:
- buy 2 products from a supplier, part cash;
- check the stock, the new cost on the product, the supplier statement and the box;
- pay the supplier from another box;
- return 1 unit;
- sell 1 unit of the purchased product and check the COGS in its journal entry;
- check health.

Update docs/OFFLINE_PLAN.md:
- mark Stage 20 done;
- record the weighted-average rule, the allocation rule, the two-entry posting, the return/cancel cost treatment, the prefixes (PO, PV, PR, SR), the permissions and the statement rules;
- "Stage 21 must": purchase VAT (input tax) when VAT is enabled; supplier aging in reports.

Do not commit.

## Final report — exactly this, in one code block
```
=== STAGE 20 REPORT ===
STEP 0 findings (stock/cost paths, supplier model and balance, box helpers, prefixes, health, design fields):
Weighted average (formula, rounding handling, largest rounding seen):
Allocation of discount/other costs (rule, remainder):
Purchase posting (two entries, payment modes, PV link):
Supplier payments (PV, advance confirm, cancel):
Purchase returns (rules, cost treatment, adjustment) and supplier refunds (SR):
Purchase cancel (rules, PV left as advance):
Setup mode end on first purchase:
Supplier statement / aging / one balance source / dashboard KPI:
Boxes & shifts (PV/SR in boxEvents, shift lines):
Health (suppliers, inventory, entries, boxes/shifts with PV/SR; can-fail tests):
Design numbers (exact lines and balances):
Permissions / route map:
Backend tests (new / total):
Legacy migration script:
Frontend tests (new / total):
Electron tests:
Smoke test (every line):
Screenshots (paths):
Manual installed-app check (each step, or needs Windows):
Docs updated:
Open questions / anything you didn't do:
```
