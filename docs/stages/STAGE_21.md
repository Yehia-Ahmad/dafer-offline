# Stage 21 — Value-added tax (VAT): on invoices, purchases and the monthly VAT return

Read before starting:
- docs/OFFLINE_PLAN.md: the Stage 16–20 sections and the "Stage 21 must" list
- docs/design/NOTA_DESIGN_SYSTEM.md
- docs/stages/STAGE_20.md: its hard rules apply

Start in plan mode and show me the plan before changing anything. Use Node 24 and the bundled mongod, in the local timezone.

VAT is **optional per shop**:
- **A shop with VAT off sees and posts exactly what it does today.** Every existing test must pass unchanged with VAT off.
- **A shop with VAT on:**
  - charges VAT on sales;
  - recovers VAT on purchases (and on expenses, when the bill shows it);
  - prints VAT on its invoices;
  - files a **monthly VAT return**: output VAT − input VAT = what it pays, or a credit carried to next month;
  - pays it from a box.

Financial reports, manual entries, account management and period closing are **Stage 22**. This stage only adds VAT.

## Accounting decisions (already made; implement exactly)
1. **Settings** (shop profile → a new "الضريبة" card; `shop.manage` edits, everyone signed in reads):
   - `vat.enabled` (default false)
   - `vat.rate` (default 14; 0–100; 2 decimals)
   - `vat.pricesIncludeVat` (default true: shelf prices already include VAT, the normal case for retail in Egypt)
   - `vat.startDate`: set when VAT is turned on; documents dated before it are untouched
   - Turning VAT on requires the shop's tax number (`taxNumber`), otherwise → 400 `TAX_NUMBER_REQUIRED`.
   - Turning it off later is allowed. It applies from that day; posted documents keep their VAT.
   - Changing the rate applies to new documents only. Each document stores the rate it used.
2. **Product taxability:** `product.vatExempt` (default false). Also a bulk "معفى من الضريبة" toggle per category in the category form, which sets it for all products in the category.
3. **Sales (cash and credit), computed once when the invoice is saved and stored on it:**
   - taxable gross = Σ non-exempt line totals − the invoice discount allocated by line value to the taxable lines + shippingFees (shipping is taxable);
   - with prices including VAT: vatAmount = round2(taxable gross × rate / (100 + rate)); totalPrice is unchanged;
   - with prices excluding VAT: vatAmount = round2(taxable gross × rate / 100); totalPrice = the old total + vatAmount;
   - store on the invoice:
     - `vatRate`, `vatAmount`
     - `netAmount` = totalPrice − vatAmount
     - `taxableAmount`
     - `exemptAmount`
     - `vatPeriod` (see 7)
   - Posting:
     - Cr SALES = subtotal net of VAT;
     - Cr SHIPPING_INCOME = shipping net of VAT;
     - Dr SALES_DISCOUNT = discount net of VAT;
     - Cr VAT_PAYABLE (22) = vatAmount;
     - box/CUSTOMERS = totalPrice.

     The lines must balance exactly. Decide how the per-account net split is rounded and keep one rule. The remainder goes into the SALES line, never a plug account.
   - Below-cost and max-discount rules compare the same numbers as today (gross prices). Note this in the plan.
4. **Returns (cash and credit):** the VAT returned = the VAT share of the returned taxable value, computed by the same method. The final return of an invoice absorbs the remainder, so the Σ returned VAT of a fully returned invoice = its vatAmount exactly.
   - The posting mirrors the sale: Dr SALES_RETURNS net, Dr VAT_PAYABLE vat, etc.
   - Cancels reverse everything through reverseAllFor, as today.
   - Edits re-post with the new figures.
5. **Purchases:**
   - The purchase form gets "المورد مسجل ضريبيًا" (default from a new `supplier.vatRegistered` flag) and a VAT amount. It is computed at the shop rate on the purchase total (net of VAT), and editable so it matches the supplier's printed invoice.
   - Line costs (Stage 20 allocation) are computed on the amount **without VAT**. Inventory never includes recoverable VAT.
   - Posting:
     - Dr INVENTORY = net;
     - Dr VAT_INPUT = vat;
     - Cr SUPPLIERS = total (the PV part is unchanged).
   - Purchase returns reverse the VAT share proportionally, with the final return absorbing the remainder.
   - A purchase from a supplier that isn't VAT-registered has VAT 0; the whole amount is cost.
6. **Expenses:** an optional "ضريبة على الفاتورة" amount (only when VAT is on). Post Dr category (net) + Dr VAT_INPUT (vat) / Cr box (total).
7. **VAT period:**
   - Each VAT document gets `vatPeriod` = "YYYY-MM" of its business date.
   - If that month's return is already filed, it gets the first unfiled month after it. A late document never changes a filed return.
   - Returns, cancels and edits get their own vatPeriod by the same rule (their own date). They are never written back into the original month.
8. **New account:** `115 ضريبة مدخلات قابلة للخصم` (VAT_INPUT, asset, debit normal), seeded by a migration under 11.
   - VAT_PAYABLE (22) already exists.
9. **The monthly VAT return (VR-000001), in its own screen:**
   - **Prepare** for a month: output VAT (sales VAT − returns VAT for that vatPeriod), input VAT (purchases + expenses − purchase returns), carried-in credit from the previous filed return, and net = output − input − carried credit.
     - Show the lines behind each figure: a document list with number, date, net and VAT, exportable to Excel.
   - **File** (`vat.file`): one transaction.
     - Post the offset Dr VAT_PAYABLE / Cr VAT_INPUT = min(output, input + carried).
     - If net > 0, the VAT_PAYABLE balance for that period = net. If net < 0, the credit carries forward on VAT_INPUT.
     - Mark the month filed. Returns must be filed in month order, with no gaps.
   - **Pay** (`vat.file`): a payment from a box (resolveBox direction "out", Stage 19 rules).
     - Post Dr VAT_PAYABLE / Cr box.
     - Number VP-000001.
     - It may be partial; the return shows paid/remaining.
     - It is a money document in boxEvents and shiftExpected ("سداد ضريبة").
   - **Unfile:** only the latest filed return, only if it has no payment, owner only, with a reason. It reverses the offset entry.
10. **Health:**
    - a **vat** check:
      - the VAT_PAYABLE ledger balance = Σ output VAT from documents − Σ offsets − Σ VAT payments;
      - the VAT_INPUT ledger balance = Σ input VAT from documents − Σ offsets;
    - netSales and COGS keep comparing like with like: netSales now excludes VAT on both sides. Update the definitions and document them;
    - can-fail tests.
11. **Customers:** an optional `taxNumber` on Customer (shown on the invoice for B2B).

## Hard rules
1. **VAT off = today's behavior,** byte for byte in postings and API responses. New fields may be absent or 0.
2. **Every VAT amount is computed once,** at save time, stored on the document and posted from the stored value. Reports read stored values, never recompute from the current rate.
3. **Every posting is in the same transaction** as its document. Posted entries are never edited.
4. **Styling:** tokens only (no hex, no `[attr.dir]`), light/dark, ar/en, RTL, 390px.
5. **Safety:**
   - Never commit.
   - Never use port 27017, the real DB or C:\ProgramData\Nota.
   - Ask before sudo.

## STEP 0 — Findings (read-only, report before planning)
1. **Where the invoice totals are computed** (invoicePricing.js and its callers), and every reader of totalPrice/subtotal/discount/shipping that would need a net figure:
   - postings;
   - profit report/bar;
   - dashboard;
   - health netSales;
   - statements;
   - prints;
   - Excel.
2. **How returns compute subtotalReturned / discount share / shipping share / finalReturnedAmount** (cash and credit), and where a VAT share fits.
3. **The Stage 20 purchase allocation and posting,** and where the VAT split fits.
4. **The expense posting.**
5. **The current cash and credit invoice PDFs:** what they show, and where VAT lines go.
6. **The shop profile's taxNumber** and how it is used today.

## STEP A — Settings, products, accounts
- the VAT settings card and the validation above;
- `product.vatExempt` + the category bulk toggle;
- `supplier.vatRegistered`;
- `customer.taxNumber`;
- the account 115 migration;
- new permission `vat.file` (owner + accountant; manager too), in the catalog, route map and router-walk test.

## STEP B — Sales, returns, cancels, edits
- Compute and store the VAT fields as in decision 3 (cash and credit, create and edit), and post them.
- Returns and cancels as in decision 4.
- **POS and the credit form:** when VAT is on, show "الصافي" / "ضريبة القيمة المضافة 14٪" / "الإجمالي" under the total. With prices excluding VAT, the total visibly adds the tax.
- **Invoice detail panels:** show net, VAT and total.
- **Existing cash and credit invoice PDFs:**
  - add the shop tax number and "فاتورة ضريبية" in the title when VAT applies;
  - add the customer tax number when present;
  - add the net/VAT/total rows.

  The full print redesign is Stage 23; keep this change minimal.
- Exempt lines are marked "معفى" on screen and in the PDF.

## STEP C — Purchases and expenses
- Purchases as in decision 5: the form shows net, VAT and total, and the journal preview includes VAT_INPUT.
- Purchase returns reverse the VAT share.
- Expenses as in decision 6.

## STEP D — The VAT return screen (/accounting/vat)
- **List of months:**
  - period, output, input, carried, net;
  - status: open | filed | paid | partially paid;
  - filed date.
- **Month detail:** the figures with drill-down document lists (sales, returns, purchases, purchase returns, expenses) and an Excel export.
- **Buttons:**
  - "تقديم الإقرار" (file), with a confirm that shows the posting;
  - "سداد الضريبة" (pay, from a box, amount ≤ remaining);
  - "إلغاء التقديم" (unfile; owner, latest only).
- **Sidebar** under الحسابات: "الضريبة" (`vat.file` or `accounting.view` to view; filing needs `vat.file`).
- **Shift panel:** a "سداد ضريبة" line.

## STEP E — Profit, dashboard, health
- **Profit report and profit bar:** revenue and profit are net of VAT.
- **Dashboard:**
  - "مبيعات النهارده" keeps showing what the customer paid (incl. VAT), with a small "شامل الضريبة" label when VAT is on;
  - add a "ضريبة مستحقة" KPI for users with `vat.file` or `accounting.view`.
- **Health:** decision 10, plus can-fail tests.

## STEP F — Tests
- **Backend (`test/stage21.test.js`), with real numbers:**
  - VAT off: a full regression. The posted lines of a cash sale, a credit sale, a return, a purchase and an expense are identical to Stage 20. Compare with snapshots taken before your change.
  - Prices including VAT at 14%: a cash sale of 4 × 35 + 2 × 65 with discount 20 → total 250, VAT = round2(250 × 14/114) = 30.70, net 219.30. Assert the exact lines.
  - Prices excluding VAT: the same items → total 250 + VAT 35.00 = 285.00.
  - A mixed taxable/exempt invoice with shipping.
  - A credit sale + partial return + final return → Σ returned VAT = the invoice VAT exactly.
  - A cancel; an edit.
  - A purchase from a registered supplier (VAT 14% on net 5,450 = 763) and from an unregistered one. The inventory cost excludes VAT, and the average cost is correct.
  - A purchase return with VAT.
  - An expense with VAT.
  - The return for a month:
    - output − input → payable;
    - file → offset entry;
    - pay partially from a box, then the rest;
    - a month with input > output → the credit carries to the next month;
    - filing out of order → 409;
    - a late document for a filed month goes to the next period;
    - unfile rules.
  - Turning VAT on without a tax number → 400.
  - A rate change mid-month (old documents keep their rate).
  - Health vat check + can-fail; netSales/COGS still 0 with VAT on.
  - Permissions.
- **Legacy migration script:** the upgrade with VAT off (unchanged), then turn VAT on and run a day; health 0.
- **Smoke:** turn VAT on → a cash sale, a credit sale, a return, a purchase and an expense → prepare the return → file → pay from a box in a shift → health printed and 0 → a cashier can't file (403) → turn VAT off → the next sale has no VAT.
- **Frontend specs:**
  - the settings card;
  - the product/category exempt flags;
  - the POS and credit totals with VAT (both modes);
  - the invoice panels;
  - the purchase form VAT;
  - the expense VAT;
  - the VAT return screen (list, detail, file, pay, unfile);
  - the dashboard KPI;
  - the shift line;
  - payload specs.
- **Screenshots** in nota-review/stage-21/:
  - settings card;
  - POS with VAT (both modes);
  - invoice PDF with VAT;
  - purchase form with VAT;
  - VAT return list and month detail, light/dark ar/en;
  - pay dialog;
  - 390px for the VAT return.

## VERIFICATION
- backend: `npm test`
- backend: `npm run test:legacy-migration`
- frontend: `npm run build:offline`
- frontend: `npx ng test --watch=false --browsers=ChromeHeadless`
- frontend: `npm run test:offline`
- frontend: `npm run smoke:offline` (every line, local timezone)
- frontend: `npm run offline:stage`
- On Windows: `npm run electron:build:win:offline`

Manual check on the installed app:
- set the tax number and turn VAT on;
- sell, print the invoice and check the VAT rows;
- buy from a registered supplier;
- record an electricity bill with VAT;
- prepare this month's return, file it and pay it;
- check accounts 22 and 115 and health.

Update docs/OFFLINE_PLAN.md:
- mark Stage 21 done;
- record the VAT rules (inclusive/exclusive, the allocation, rounding, vatPeriod, filing order, carry-forward, payment, health);
- renumber the remaining stages:
  - 22 Reports, manual entries, accounts management, period closing;
  - 23 Prints;
  - 24 Licensing & protection;
  - 25 Release;
- "Later": the Egyptian e-invoice (ETA) integration.

Do not commit.

## Final report — exactly this, in one code block
```
=== STAGE 21 REPORT ===
STEP 0 findings (totals and their readers, returns math, purchase/expense posting, PDFs, taxNumber):
Settings, product/category exempt, supplier/customer fields, account 115, permission:
Sales VAT (inclusive/exclusive formulas, rounding rule, stored fields, posting lines):
Returns/cancels/edits VAT (remainder rule):
Purchases and expenses VAT:
vatPeriod rule and late documents:
VAT return (prepare/file/pay/unfile, carry-forward, postings, order rule):
Profit/dashboard/health changes (definitions):
VAT-off regression (how proven):
Design-number checks (exact lines):
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
