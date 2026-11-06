# Stage 18 — Opening-balance wizard ("رصيد بداية المحل") + suppliers base + balance display

Read before starting:
- docs/OFFLINE_PLAN.md: the Stage 16 and Stage 17 sections and the "Stage 18 must" list
- docs/design/NOTA_DESIGN_SYSTEM.md
- docs/stages/STAGE_17.md: its hard rules apply

Design references, in docs/design/screens/:
- Opening.dc.html: the wizard. Steps: الخزائن → المخزون → العملاء → الموردين → المراجعة
- Suppliers.dc.html and AddSupplier.dc.html: the list and the add form only; purchases come in Stage 20
- Accounts.dc.html: for the balance display fix

Start in plan mode and show me the plan before changing anything. Use Node 24 and the bundled mongod.

A new shop must start its books with what it already has today:
- cash in the box and in banks/wallets;
- goods on the shelf;
- money customers owe it;
- money it owes suppliers.

The difference between what it has and what it owes is the owner's capital. This stage builds that wizard on top of OB-000001 from Stage 17.

## Hard rules
1. **The opening entry is the only place these balances enter the ledger.**
   - Re-running the wizard reverses the current opening entry and posts a new one. Old entries are never edited.
   - Opening documents are never sales: they are excluded from sales, profit, COGS, the dashboard sales figures and the profit report.
2. **Every operational screen shows the opening balances where they belong:**
   - the customer statement, outstanding, aging and the customer list balance;
   - receipts can collect them.
   - Health stays 0.
3. **No change to existing sale/return/payment/cancel behavior** beyond what is listed here.
4. **Styling:** tokens only (no hex, no `[attr.dir]`), light/dark, ar/en, RTL, 390px.
5. **Safety:**
   - Never commit.
   - Never use port 27017 or the real DB.
   - Ask before sudo.
   - Tests never touch C:\ProgramData\Nota.

## STEP 0 — Findings (read-only, report before planning)
1. **OB-000001 today:** how the Stage 17 migration builds it, its lines, and `meta.ledgerStartAt`. What happens on a fresh install with no data.
2. **Customer payments:** how both payment routes choose which open credit invoices to allocate to (order, rules). What a payment does when there's nothing open.
3. **The customer statement, outstanding, aging, the customer list balance and the dashboard outstanding:** where each one is computed, so an opening balance can feed all of them from one source.
4. **Product stock postings after ledgerStartAt** (create with stock, stock edit, import): today they credit INVENTORY_ADJUSTMENT. Describe the exact call sites.
5. **Does any model already represent a supplier?** Report what Suppliers.dc.html and AddSupplier.dc.html show.

Propose the representation of a customer opening balance in your plan, and wait for my approval. It must:
- appear in the statement as "رصيد أول المدة";
- count in outstanding and aging (dated on the opening date);
- be collectable by both payment routes, oldest first like an invoice;
- support a negative opening (we owe the customer), shown as customer credit;
- never count as a sale.

Compare two options:
- (a) a CreditSale with `kind: "opening"`, no items, number OB-xxxxxx;
- (b) a separate `PartyOpening` document wired into the allocation, statement and aging.

Recommend one, and list every code path that must reject or skip it: edit, cancel, return, profit, dashboard sales, COGS, the low-stock stats and prints.

## STEP A — Setup mode and opening status
1. **`meta.opening`:** `{ status: "setup" | "finalized", entryId, finalizedAt, finalizedBy }`.
   - New installs and upgraded installs start in `setup`.
2. **Setup mode** = status `setup` AND no sale, credit sale, return or receipt dated ≥ ledgerStartAt exists (opening documents don't count).
3. **While in setup mode,** product stock postings go to capital instead of the adjustment account. This covers product create with stock, stock edits and category import with stock.
   - Post Dr INVENTORY / Cr CAPITAL, or the reverse when stock goes down.
   - Use source type `opening_inventory`.
   - **Why:** a new shop typing in its goods on day one is entering its opening stock, not finding a stock difference.
   - The first real sale, return or receipt ends setup mode automatically, and from then on the normal INVENTORY_ADJUSTMENT rules apply.
4. **Purchase-price changes in setup mode** revalue against CAPITAL as well. Test it.
5. **`GET /api/accounting/opening`** (`accounting.view`): the status, setup mode on/off, the current opening figures by section, and the posted entry.

## STEP B — Suppliers base (minimal; Stage 20 adds purchases and payments)
1. **Model `Supplier`:** name (required), phone(s), contact person, address, notes, isActive, timestamps, plus the auditFields plugin.
2. **CRUD** `/api/suppliers`, with new permissions `suppliers.view` and `suppliers.manage`.
   - Templates:
     - owner: both;
     - manager: both;
     - accountant: view;
     - storekeeper: view;
     - cashier: none.
   - Update the catalog, the route map and the router-walk test.
   - Delete only when the supplier has no opening balance and no ledger lines. Otherwise → 409 `SUPPLIER_HAS_BALANCE`.
3. **Ledger party:** SUPPLIERS lines require `partyType: "supplier"` and a valid `partyId`. Update the postEntry validation from Stage 17, and add a test.
4. **Frontend:**
   - /suppliers, following Suppliers.dc.html: a list with search, the balance (from the ledger party balance), and add/edit following AddSupplier.dc.html.
   - A sidebar item under المخزون, or wherever the design puts it.
   - The supplier statement is Stage 20. For now, the row links to the ledger of account 21 filtered by that supplier.
5. **Supplier opening balances:** one per supplier, positive = we owe them (Cr SUPPLIERS). A negative value is allowed (they owe us / an advance).

## STEP C — Banks and wallets
- In the wizard's cash step, the user can add banks/wallets (name + type bank|wallet + opening amount).
- Each one becomes a leaf account under 112: code 1121, 1122, … with `kind: bank|wallet` and `isSystem: false`.
- Stage 19 will attach cash boxes and payment methods to these accounts. Note this in the "Stage 19 must" list.
- CASH_MAIN (1111) gets the main cash amount.
- Additional cash boxes are Stage 19, so this stage has one cash amount.

## STEP D — The wizard (Opening.dc.html)
Route `/accounting/opening`, permission `accounting.manage` (owner only by default).

Show it:
- in the sidebar under الحسابات;
- as a banner on the dashboard for users with `accounting.manage` while the status is `setup`: "لسه مسجلتش رصيد بداية المحل".

Steps:
1. **الخزائن:**
   - the main cash amount;
   - + bank/wallet rows (STEP C);
   - fixed assets, an optional amount (furniture/equipment → 121).
2. **المخزون:**
   - **In setup mode:** a table of every product with stock: code, name, quantity, purchase price and value, editable. Edits go through the normal product update, so they post as `opening_inventory`. Add a link to add products and to the Excel import. The total updates live.
   - **Outside setup mode:** read-only. Show the inventory value carried in the opening entry, and a note that later stock changes are adjustments.
3. **العملاء:**
   - a table of customers with an opening amount: positive = the customer owes us, negative = we owe them;
   - add or pick a customer inline;
   - the opening date is the ledger start date. Show it.
4. **الموردين:** the same, for suppliers. Add or pick inline.
5. **المراجعة**, following the design:
   - اللي ليك: cash, each bank/wallet, inventory, customers, fixed assets;
   - اللي عليك: suppliers, plus customer credits (negative customers);
   - رأس مال المحل = the difference, with the formula shown;
   - a confirm checkbox "راجعت الأرقام، والمبالغ دي مطابقة للي عندي فعلًا";
   - two buttons: "حفظ الأرصدة" (posts; it can be re-run) and "اعتماد الأرصدة نهائيًا" (finalizes; a second confirm says it can't be undone; later corrections are manual entries in Stage 21).

Saving (`POST /api/accounting/opening`, `accounting.manage`, one transaction):
- Validate all amounts (2 decimals; no zero rows, which are dropped). Customers and suppliers must exist, with no duplicates.
- Create/update the opening documents chosen in STEP 0 for customers, and the supplier opening records. Remove the ones that were deleted from the wizard.
- Reverse the current opening entry, if any, and post a new one (type `opening`, a new OB number), dated ledgerStartAt:
  - Dr CASH_MAIN;
  - Dr each bank/wallet;
  - Dr INVENTORY = the inventory figure (setup mode: Σ current stock × purchasePrice; otherwise the inventory amount already in the current opening entry, unchanged);
  - Dr FIXED_ASSETS;
  - Dr CUSTOMERS per customer (Cr for a negative);
  - Cr SUPPLIERS per supplier (Dr for a negative);
  - Cr CAPITAL = the difference (Dr if negative).
- **In setup mode,** the `opening_inventory` entries already posted are folded in:
  - reverse them as part of the save;
  - the new opening entry carries the full inventory;
  - so the ledger has one clean opening entry.
  - Explain this in the plan if you'd rather keep them separate. Either way, health must be 0 and INVENTORY = Σ stock × price.
- Audit: `opening.saved` and `opening.finalized`, with totals (no per-line cost for users without viewCost).
- **After finalize:** POST returns 409 `OPENING_FINALIZED`, the wizard is read-only, and setup mode is off for good.

## STEP E — Balance display fix (accounts tree and ledger)
- Show every balance as a positive number on the account's normal side, labelled مدين / دائن (Dr/Cr in English).
  - Capital 1,756 Cr shows as "١٬٧٥٦٫٠٠ دائن", not "-1,756.00".
- Use the red/warning token only when a balance is on the opposite side of the account's normal side, e.g. a cash box with a credit balance or a supplier with a debit balance. Add a small hint for it.
- Group totals roll up by their own normal side.
- The ledger running balance uses the same rule.
- The API keeps the raw signed number. Add `side` and `absBalance` fields (additive), and compute the display in one shared pipe.
- Specs for both cases.

## STEP F — Statements, aging, health
1. **The customer statement** starts with the opening line: "رصيد أول المدة", dated ledgerStartAt, with debit or credit.
   - Outstanding, aging, the customer list balance and the dashboard outstanding all include it.
   - Receipts collect it oldest-first, and a receipt that clears it shows normally.
2. **Health:**
   - the customers check includes opening balances: the statement already does, so the ledger party balance must match;
   - add a suppliers check: the per-supplier ledger party balance = the supplier opening record (until Stage 20 adds purchases);
   - add an "opening" check: the current opening entry's lines = the stored opening data (cash, banks, fixed assets, customers, suppliers; inventory per the rule above);
   - add "health can fail" tests for the two new checks.

## STEP G — Tests
- **Backend (new `test/stage18.test.js`):**
  - setup mode on/off rules;
  - product create, stock edit, import and revaluation in setup mode → CAPITAL, and after the first sale → INVENTORY_ADJUSTMENT;
  - the wizard save with every section, including the design's numbers:
    - cash 15,000, bank 30,000, inventory 84,200, customers 6,300, suppliers 8,500 → capital 127,000;
    - assert the exact lines;
  - re-save with changed amounts → old OB reversed, new OB posted, health 0;
  - finalize → 409 on re-save;
  - a negative customer and a negative supplier;
  - a customer opening collected by a receipt (partly, then fully), in both payment routes;
  - the statement, outstanding and aging include the opening;
  - opening documents rejected or skipped by edit/cancel/return/profit/dashboard sales/COGS;
  - supplier CRUD and delete rules;
  - SUPPLIERS party validation;
  - permissions: `accounting.manage` for the wizard; suppliers view/manage per role;
  - an upgraded install (OB-000001 from Stage 17, with sales after the start) → the inventory is read-only and kept from the current opening entry;
  - the legacy migration script: run the wizard after the upgrade, health 0.
- **Smoke:**
  - a fresh shop: owner → products with stock (setup mode) → wizard save → health 0 → first sale ends setup mode → a stock edit posts to adjustment → re-save the wizard → finalize → re-save 409;
  - a customer opening collected by a receipt;
  - a cashier gets 403 on the wizard.
- **Frontend specs:**
  - each wizard step (validation, live totals, add a customer/supplier inline, read-only inventory outside setup mode);
  - the review (capital formula, the confirm checkbox, the finalize double-confirm);
  - the dashboard banner;
  - the suppliers list and form;
  - the balance display pipe and the tree/ledger rendering;
  - payload specs for every new call.
- **Screenshots** in nota-review/stage-18/ (gitignored):
  - each wizard step light ar;
  - the review light/dark ar/en;
  - finalized read-only;
  - the suppliers list;
  - the accounts tree with مدين/دائن;
  - a customer statement with the opening line;
  - the dashboard banner;
  - 390px for the wizard review.

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
1. **A fresh install** (rename C:\ProgramData\Nota first, and put it back after):
   - owner → add products → run the wizard with cash, a bank, 2 customers and 1 supplier;
   - check the accounts tree, the customer statement and health;
   - sell once → setup mode off.
2. **The upgraded install:** the wizard shows the inventory read-only; add cash and a customer opening; save; health 0.

Update docs/OFFLINE_PLAN.md:
- mark Stage 18 done;
- record setup mode, the opening representation, the finalize rule and the display rule;
- "Stage 19 must": cash boxes and methods on top of 1111 and the 112 bank/wallet accounts;
- "Stage 20 must": purchases, supplier payments and the supplier statement on top of the Supplier model and the supplier openings.

Do not commit.

## Final report — exactly this, in one code block
```
=== STAGE 18 REPORT ===
STEP 0 findings (OB-000001, payment allocation, balance readers, stock postings, supplier model/design):
Customer opening representation (option chosen, why, every path that rejects/skips it):
Setup mode (definition, CAPITAL postings, how it ends, tests):
Suppliers base (model, routes, permissions, delete rule, party validation, UI):
Banks/wallets accounts (codes, kind):
Wizard (each step, save, re-save reversal, folding of opening_inventory entries, finalize):
Opening entry lines for the design numbers (exact lines):
Balance display (side/absBalance, pipe, warning rule):
Statement/aging/outstanding with opening, receipts collecting it:
Health (new checks + "can fail" tests):
Permissions / route map changes:
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
