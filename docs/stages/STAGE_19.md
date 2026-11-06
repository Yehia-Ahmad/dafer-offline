# Stage 19 — Cash boxes & payment methods, shifts, transfers, expenses, owner drawings, customer credit

Read before starting:
- docs/OFFLINE_PLAN.md: the Stage 16–18 sections and the "Stage 19 must" list
- docs/design/NOTA_DESIGN_SYSTEM.md
- docs/stages/STAGE_18.md: its hard rules apply

Design references, in docs/design/screens/:
- CashBox.dc.html: boxes and shift close
- AddCashBox.dc.html
- Transfer.dc.html
- Expenses.dc.html
- Dashboard.dc.html: the "cash in the box" KPI and the "تسجيل مصروف" quick action, hidden until now

Start in plan mode and show me the plan before changing anything. Use Node 24 and the bundled mongod.

Until now every cash movement posted to CASH_MAIN (1111). After this stage, every movement of money says **which box** it went into or out of. A box can be:
- a cashier drawer;
- the main box;
- an e-wallet like Vodafone Cash or InstaPay;
- a bank account.

The ledger, the box balances and the shift reports always agree.

## Hard rules
1. **Every money movement goes through a box, and posts to that box's account** in the same transaction:
   - cash sale, down payment, receipt, cash return refund, cash cancel refund, "رد المقدم";
   - expense, transfer, shift difference, owner drawing, customer credit payout.

   No posting to CASH_MAIN remains except through the main box.
2. **Default behavior stays as today:** a shop that never opens this page keeps working with one main box and no shifts, and nothing changes for the cashier.
3. **Prices, stock, statement, discount, permissions and below-cost rules stay unchanged.**
4. **Posted entries are never edited.** Cancelling an expense, transfer or payout is a reversal with a reason.
5. **Styling:** tokens only (no hex, no `[attr.dir]`), light/dark, ar/en, RTL, 390px.
6. **Safety:**
   - Never commit.
   - Never use port 27017, the real DB or C:\ProgramData\Nota.
   - Ask before sudo.

## STEP 0 — Findings (read-only, report before planning)
1. **Every posting of CASH_MAIN today:** list each route and function. Also list where the frontend sends any "payment method" today, if anywhere.
2. **Device identity:**
   - What identifies a PC: NOTA_INSTANCE_ID on the main PC, and what on client PCs?
   - Does the backend know which device a request comes from (a header, the LAN key)?
   - This decides how a drawer is bound to a device.
3. **The Stage 18 bank/wallet accounts** (11201…, `kind`) and how the wizard creates them.
4. **The 520 expense accounts and the 530 CASH_OVER_SHORT account** from Stage 17.
5. **How "رد المقدم", cancel refunds and cash return refunds post today.**
6. **The dashboard's hidden "cash in the box" KPI and the "تسجيل مصروف" action.**

## STEP A — Cash boxes
1. **Model `CashBox`:**
   - `name`
   - `type`: `cash` | `wallet` | `bank`
   - `accountId` (unique)
   - `isMain`: exactly one box
   - `deviceId` (optional default device)
   - `shiftsEnabled`
   - `isActive`
   - `sortOrder`
   - the auditFields plugin
2. **Accounts:**
   - the main box = account 1111, created by migration with the name "الخزنة الرئيسية";
   - each existing 112xx bank/wallet leaf gets a box with the same name and type;
   - a new `cash` box creates a leaf under 111: codes 11102, 11103, … (5-digit, like the banks);
   - a new bank or wallet box creates a leaf under 112 (next 112xx).
3. **Box balance** = the ledger balance of its account, as one aggregation helper.
4. **Deactivating a box:** only when its balance is 0 and it has no open shift. Otherwise → 409 `BOX_NOT_EMPTY` / `BOX_HAS_OPEN_SHIFT`. A box is never deleted once it has ledger lines.
5. **Device binding** (AddCashBox.dc.html: "الجهاز اللي بيستخدمها تلقائي"):
   - a box can be the default box of one device;
   - a cash sale made from that device defaults to that box;
   - with no binding, the main box is the default;
   - implement the device identity from STEP 0.2, and report the choice.
6. **Permissions:**
   - `cashbox.view`: see boxes and balances;
   - `cashbox.manage`: create/edit boxes, transfers, deposits;
   - `shift.operate`: open/close your own shift;
   - `shift.manage`: see all shifts and close someone else's;
   - `expenses.create`;
   - `expenses.manage`: cancel expenses, manage categories;
   - `owner.drawings`: owner only.

   Templates:
   - owner: all;
   - manager: all except `owner.drawings`;
   - cashier: `shift.operate` + `expenses.create`;
   - accountant: `cashbox.view` + `expenses.create` + `expenses.manage`;
   - storekeeper: none.

   Update the catalog, the route map and the router-walk test.
   - Dependency (like Stage 17's): `cashbox.view` doesn't require `products.viewCost`.

## STEP B — Payment box on every money document
1. **Each money document stores `boxId`:**
   - Selling (cash sales);
   - Receipt (receipts and down payments);
   - ReturnLog (cash refunds);
   - the cancel refund on cash invoices and credit invoices with a down payment;
   - Expense, Transfer, Shift, OwnerDrawing, CustomerPayout (new).
2. **Request field `boxId`, optional.** When it's missing: the device's default box → the main box.
   - The box must be active.
   - If shiftsEnabled, it must have an open shift (see STEP C).
   - Validation errors: `BOX_INACTIVE`, `NO_OPEN_SHIFT`.
3. **Posting:** replace every CASH_MAIN line with the document's box account. CASH_MAIN stays as the main box's account. Update posting.js, the cancel/legacy reversal helpers and the opening entry (cash = main box, banks = their boxes).
4. **Migration:** set `boxId` = the main box on every existing money document. Existing journal lines on 1111 and 112xx stay as they are, because the accounts didn't change.
5. **POS and the receipt screens:**
   - a "طريقة الدفع" selector with the active boxes, defaulting as in 2;
   - a cashier sees the boxes available to them: their device's drawer + wallets/banks;
   - the main box shows only with `cashbox.manage`;
   - the choice is remembered per device for the session.
   - Single method per document in this stage. Split payment is out of scope; note it as later.

## STEP C — Shifts (CashBox.dc.html, the shift close panel)
1. **Model `Shift`:**
   - `number` (SH-000001)
   - `boxId`, `userId`, `userName`
   - `openedAt`, `openingFloat`
   - `closedAt`
   - `expected`, `counted`, `difference`
   - `differenceNote`
   - `depositBoxId`, `depositAmount`
   - `status`: open | closed
   - the auditFields plugin
2. **Rules:**
   - one open shift per box at a time;
   - only boxes with `shiftsEnabled` (default: true for new cash boxes, false for the main box and for wallet/bank boxes);
   - open: `POST /api/shifts` `{ boxId, openingFloat }`. openingFloat is informational: it must equal the box's current balance, otherwise show the difference and let the user confirm. It posts no entry, because the money is already in the box;
   - selling to a shift-enabled box needs an open shift on that box (any user with `sales.create` can sell into an open shift; the shift belongs to the user who opened it).
3. **Expected cash at close.** Compute it from operational documents in the shift period for that box, never from the ledger:
   - expected = opening balance + cash sales + receipts + incoming transfers − cash refunds (returns, cancels, "رد المقدم") − expenses − outgoing transfers − payouts − drawings.

   Show each line as in the design.
4. **Close:** `POST /api/shifts/:id/close` `{ counted, differenceNote, depositBoxId?, depositAmount? }`. One transaction:
   - difference = counted − expected. If ≠ 0, post:
     - a shortage: Dr CASH_OVER_SHORT / Cr box;
     - an overage: the reverse;
   - a note is required when the difference ≠ 0;
   - an optional deposit is a transfer (STEP D) from the box to depositBox;
   - "الباقي يفضل في الدرج رصيد للوردية الجاية".
5. **Visibility:**
   - `shift.operate` closes your own shift;
   - `shift.manage` closes anyone's and sees all shifts.
6. **Printing** the shift report is Stage 22 (PrShiftClose). For now: a "طباعة" button hidden behind a TODO flag, and a printable summary view in the page.
7. **Audit:** `shift.opened`, `shift.closed` (with the difference).

## STEP D — Transfers (Transfer.dc.html)
- `POST /api/cashbox/transfers` `{ fromBoxId, toBoxId, amount, date, note }` (`cashbox.manage`). Number `TR-000001`; add the TR prefix.
- Post Dr to-box / Cr from-box.
- The from-box's balance must cover the amount. Otherwise → 409 `INSUFFICIENT_BALANCE`.
- Cancel with a reason = a reversal (`cashbox.manage`).
- Show the balances before and after, as in the design.

## STEP E — Expenses (Expenses.dc.html)
1. **Categories** = leaf accounts under 520 (521–525 seeded).
   - With `expenses.manage`, a user can add a category: a new leaf 526, 527, …, name ar/en.
   - A user can rename a non-system category and deactivate it if it has no lines.
2. **Model `Expense`:**
   - `number` (EX-000001)
   - `date`
   - `accountId` (the category)
   - `amount`, `boxId`, `note`
   - `status`: posted | cancelled
   - `cancelReason`
   - the auditFields plugin
3. **Posting:** Dr category / Cr box. The box must cover the amount → 409 `INSUFFICIENT_BALANCE`.
   - The box must have an open shift if shiftsEnabled (a drawer expense).
4. **Cancel** (`expenses.manage`, a reason) = a reversal.
5. **Screen:**
   - the form: category, amount, box, date, note;
   - this month's list with a total;
   - the by-category breakdown for last month, as in the design;
   - filters: month, category, box;
   - `expenses.create` can add; `expenses.manage` can cancel.
6. **Dashboard:** enable the "تسجيل مصروف" quick action (`expenses.create`).

## STEP F — Owner drawings and customer credit
1. **Owner drawing (سحب المالك):**
   - `POST /api/cashbox/drawings` `{ boxId, amount, date, note }` (`owner.drawings`);
   - Dr OWNER_DRAWINGS (33) / Cr box;
   - number `DR-000001` (add the prefix);
   - cancel = a reversal.
2. **Customer credit** (from the "Stage 19 must" list): a customer whose statement balance is a credit (we owe them, e.g. a negative opening or a refundDue):
   - **Pay out:** `POST /api/customers/:id/payouts` `{ boxId, amount, note }` (`credit.collect`).
     - The amount must be ≤ the customer's credit.
     - Post Dr CUSTOMERS (party) / Cr box.
     - Number `CP-000001`.
     - It shows on the statement as a debit line "صرف رصيد دائن".
   - **Apply to an open invoice / opening:** `POST /api/customers/:id/apply-credit` `{ amount }`.
     - It allocates the credit to the customer's open items, oldest first, like a receipt with no money.
     - It posts no entry (same party).
     - The statement shows nothing new; the open items and aging change.
     - Test that the ledger = the statement.
   - **Customer page:** when the balance is a credit, show "صرف الرصيد" and "خصمه من فواتير مفتوحة" (if there are open items).

## STEP G — Screens
1. **/cashbox (CashBox.dc.html), `cashbox.view`:**
   - cards per box: name, type, balance, open shift (user, since);
   - "+ خزنة جديدة" (AddCashBox.dc.html) and "تحويل بين الخزائن" (`cashbox.manage`);
   - a box detail page: its ledger (movements with source links, running balance, using the Stage 18 balance pipe), plus its shifts.
2. **The shift panel:**
   - open shift;
   - close shift, with expected lines, counted, the live difference with a عجز/زيادة label, note, deposit, and "الباقي يفضل في الدرج";
   - a cashier with `shift.operate` sees their own drawer's shift from the POS: a small "الوردية" button and a banner "مفيش وردية مفتوحة" when the drawer needs one.
3. **/expenses (Expenses.dc.html).**
4. **Owner drawing:** a small dialog from /cashbox (owner only).
5. **Sidebar** under الخزنة: "الخزائن والوردية" and "المصروفات", each with its permission.
6. **Dashboard:**
   - the "كاش في الخزنة" KPI = Σ cash-type boxes (`cashbox.view`), plus a link;
   - the quick action "تسجيل مصروف".

## STEP H — Health
1. **New "boxes" check.** Per box: the ledger balance of its account = an independent total from operational documents, i.e. Σ of:
   - its cash sales, receipts and down payments;
   - minus refunds (returns, cancels, "رد المقدم");
   - minus expenses;
   - ± transfers;
   - ± shift differences;
   - minus drawings and payouts;
   - plus its opening amount from the Stage 18 opening data;
   - excluding cancelled/reversed documents.

   Report per box, with difference = Σ|per-box difference|.
2. **The existing checks stay 0.** Net sales and COGS are unaffected.
3. **"Can fail" tests:** tamper with a box line; post an expense without a box line.

## STEP I — Tests
- **Backend (`test/stage19.test.js`):**
  - the migration creates the main box + boxes for 112xx, and sets boxId on old documents;
  - box create/deactivate rules;
  - device default;
  - every money document posts to its box (cash sale, down payment, receipt, cash return, cash cancel, "رد المقدم");
  - NO_OPEN_SHIFT and BOX_INACTIVE;
  - a shift open/close with shortage, overage and zero;
  - expected computed from documents, not the ledger (a can-fail style test);
  - deposit on close;
  - transfer + cancel;
  - INSUFFICIENT_BALANCE;
  - expense + cancel; a new category;
  - an owner drawing;
  - a customer payout and apply-credit (ledger = statement after each);
  - permissions per role;
  - health boxes = 0 after a mixed day.
  - Use the design's shift numbers: float 500, cash sales 6,820, receipts 600, refunds 120, expenses 250 → expected 7,550; counted 7,500 → shortage 50; deposit 7,000 → 500 stays.
- **Legacy migration script:** after the upgrade, every old document has the main box, and health (incl. boxes) is 0.
- **Smoke:**
  - create a drawer bound to the device with shifts;
  - a cash sale without a shift → NO_OPEN_SHIFT;
  - open a shift; sell; receive a payment into the drawer; record an expense from the drawer;
  - close with a shortage and a deposit;
  - a transfer to a wallet box;
  - an owner drawing;
  - a customer payout;
  - health 0 (print every check);
  - a cashier can't see /cashbox management, a storekeeper gets 403.
- **Frontend specs:**
  - the box cards and detail;
  - add box;
  - transfer (balances before/after);
  - the shift open/close (live difference, note required, deposit);
  - the POS payment selector (defaults, available boxes per role, NO_OPEN_SHIFT banner);
  - expenses (form, list, totals, cancel, new category);
  - drawings;
  - customer payout/apply buttons;
  - the dashboard KPI and action;
  - payload specs for every new call.
- **Screenshots** in nota-review/stage-19/:
  - /cashbox light/dark ar/en;
  - add box;
  - transfer;
  - the shift close with a shortage;
  - the POS with the payment selector and the no-shift banner;
  - /expenses;
  - customer payout;
  - the dashboard KPI;
  - 390px for the shift close.

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
- add a cashier drawer bound to this PC with shifts;
- sell without a shift (refused), then open a shift, sell, take an expense;
- close with a small shortage and a deposit to the main box;
- check the box balances, the 530 account and health.

Update docs/OFFLINE_PLAN.md:
- mark Stage 19 done;
- record the box model, the device default, the shift rules, the expected formula, the new prefixes (TR, DR, CP) and the permissions;
- "Later": split payment;
- "Stage 20 must": supplier payments come from a box (PV), and purchases paid in cash come from a box.

Do not commit.

## Final report — exactly this, in one code block
```
=== STAGE 19 REPORT ===
STEP 0 findings (CASH_MAIN postings, device identity, bank/wallet accounts, 520/530, refunds, dashboard):
Cash boxes (model, accounts/codes, main box, device binding choice, deactivate rules):
Payment box on documents (fields, defaults, validation, posting changes, migration):
POS / receipt payment selector (defaults, visibility per role):
Shifts (model, open/close rules, expected formula, over/short posting, deposit):
Transfers:
Expenses (categories, posting, cancel, screen):
Owner drawings:
Customer credit (payout, apply-credit, statement lines):
Permissions / route map:
Health (boxes check + can-fail tests):
Shift numbers from the design (exact result):
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
