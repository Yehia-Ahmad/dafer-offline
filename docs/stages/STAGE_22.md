# Stage 22 — Financial reports, manual journal entries, accounts management, period closing

Read before starting:
- docs/OFFLINE_PLAN.md: the Stage 16–21 sections and the "Stage 22 must" list
- docs/design/NOTA_DESIGN_SYSTEM.md
- docs/stages/STAGE_21.md: its hard rules apply

Design references, in docs/design/screens/:
- Reports.dc.html: the tabs are income statement, balance sheet, trial balance, box movements, customer/supplier balances
- ManualEntry.dc.html
- Accounts.dc.html: "+ حساب" and "+ قيد يدوي"
- AddAccount.dc.html

Start in plan mode and show me the plan before changing anything. Use Node 24 and the bundled mongod, in the local timezone. Run long suites with a timeout and output to a file (never piped into head).

This is the last accounting stage. It adds no new money flows. It lets the owner and the accountant:
- read the books: reports;
- fix what has no screen: manual entries;
- shape the chart of accounts;
- close periods so posted months can't change any more.

## Accounting decisions (already made; implement exactly)

### A. Reports: read-only, from the ledger only, with one shared aggregation layer
1. **Income statement (قائمة الدخل)** for a period (from/to; quick picks for this month, last month, this year, a custom range), with an optional comparison column (the previous period of the same length):
   - sales;
   - − sales returns;
   - − discount allowed;
   - + shipping income;
   - = net sales;
   - − COGS = gross profit;
   - − each expense account (521…, 52001…, 530 shown as "عجز/زيادة الخزينة", 540 as "فروق وتسويات المخزون");
   - + other income;
   - = net profit;
   - gross margin %.

   Group rows follow the chart (the 4 and 5 trees), so new accounts appear automatically. Zero rows are hidden behind a toggle.
2. **Balance sheet (الميزانية)** as of a date:
   - assets (111 boxes, 112 banks/wallets, 113 customers, 114 inventory, 115 VAT input, 12 fixed assets);
   - liabilities (21 suppliers, 22 VAT payable, 23 accrued);
   - equity:
     - 31 capital;
     - 32 retained earnings;
     - 33 owner drawings (shown as a deduction);
     - **current-period profit** = revenue − expenses not yet closed into 32.
   - A check row: assets = liabilities + equity, with the difference (must be 0).
   - Balances use the Stage 18 side rule (positive on the normal side; the warning token when opposite).
3. **Trial balance (ميزان المراجعة)** for a period. Per leaf account:
   - opening debit/credit (before `from`);
   - period movement debit/credit;
   - closing debit/credit.

   Group subtotals, grand totals that balance, and a filter to hide zero rows. This replaces nothing; the health trialBalance check stays.
4. **Box movements (حركة الخزائن)** for a period: per box, opening + in − out = closing, with in/out broken down by document kind (sales, receipts, refunds, expenses, transfers, shift differences, PV/SR, VAT payments, drawings, payouts). It comes from the ledger, with a drill-down to the box ledger (Stage 19).
5. **Customer and supplier balances/aging (أرصدة العملاء والموردين):**
   - all customers, and all suppliers (this is the "supplier aging" item moved from Stage 21);
   - per party: balance and the aging buckets (current, 1–30, 31–60, 61–90, 90+, advance/credit);
   - totals;
   - from the existing statement/open-items services, so the numbers equal each party's statement exactly.
6. **Common rules:**
   - every report is one GET endpoint under `/api/reports/*`, needs `reports.financial` (a new permission: owner, manager, accountant), and is computed with aggregation pipelines on journal lines (no per-entry loops). Test with ~20,000 entries for timing and report it;
   - every amount links to its source: the account ledger, then the entry;
   - "Excel للمحاسب": each report exports to .xlsx with the same rows, numbers as numbers and an RTL sheet. Use the existing exceljs dependency;
   - "طباعة": hidden behind REPORTS_PRINT_ENABLED = false. The printed layouts (PrFinancials, PrTrialBalance) are Stage 23;
   - the shop name, period and "بالجنيه" appear in each report header, as in the design;
   - a cancelled/reversed pair nets to 0 automatically because reports read the ledger.

### B. Manual journal entries (ManualEntry.dc.html)
1. **Permission `accounting.manage`** (reserved since Stage 17; owner only by default, and it can be granted to the accountant).
2. **Form:**
   - number (JE, assigned on posting);
   - date (required);
   - memo (required);
   - lines: account (leaf only), line description, debit/credit, and a party when the account is CUSTOMERS or SUPPLIERS;
   - "+ سطر";
   - live totals and a balanced indicator.
   - Two buttons: "حفظ كمسودة" and "ترحيل القيد".
3. **Drafts:**
   - a `ManualEntryDraft` collection (not a JournalEntry), editable and deletable, never in reports or health;
   - posting validates the draft and creates the JournalEntry (type `manual`, source `{ type: "manual", id: draftId }`) in one transaction, then marks the draft posted.
4. **Forbidden accounts** in a manual entry, with clear Arabic errors:
   - box accounts (any account that has a CashBox: 1111, 111xx, 112xx) → "استخدم شاشة الخزائن أو المصروفات";
   - INVENTORY (114) → "استخدم تعديل الصنف";
   - VAT_INPUT (115) and VAT_PAYABLE (22) when VAT is enabled → "استخدم شاشة الضريبة".

   These have operational documents behind them, and health compares them with those documents. Allowed: capital, drawings, retained earnings, fixed assets, accrued expenses, every income/expense account, and CUSTOMERS/SUPPLIERS with a party.
5. **Party lines show on statements:**
   - a manual entry line on CUSTOMERS or SUPPLIERS with a party appears on that party's statement as "قيد يدوي JE-…", with its memo;
   - it counts in their balance, open items and aging as an unallocated debit/credit (dated on the entry date);
   - so health customers/suppliers stays 0.

   Typical use: writing off a bad debt (Dr expense / Cr CUSTOMERS party).
6. **Reversal:** posted manual entries can't be edited. "قيد عكسي" (accounting.manage, a reason required) posts the mirror, linked both ways, dated today or a chosen open date.
7. **Health:**
   - the entries check accepts manual sources (the draft exists and is marked posted);
   - customers/suppliers include manual party lines;
   - add can-fail tests.

### C. Accounts management (AddAccount.dc.html)
1. **Add** (`accounting.manage`):
   - parent (a group account) is required;
   - the code is automatic: the next free child code of the parent, using the 5-digit scheme already used for 112xx/520xx when the parent's children use it, otherwise the next child code. Report the rule per branch;
   - Arabic name required, English optional;
   - type is inherited from the parent and shown;
   - an "حساب تجميعي" checkbox makes it a group.

   A new leaf under 520 automatically becomes an expense category (Stage 19).
2. **Edit:**
   - names: any account, system included;
   - parent and code: never once it has lines;
   - type: never.
3. **Deactivate:**
   - only a non-system leaf with a 0 balance and no open drafts using it;
   - inactive accounts can't be posted to (already enforced) and are hidden from pickers;
   - a reactivate action;
   - delete only if it never had lines.
4. **Accounts tree (Accounts.dc.html):** "+ حساب" and "+ قيد يدوي" buttons (accounting.manage), an edit action per row, and an "عرض الحسابات الموقوفة" toggle.

### D. Period closing
1. **Settings (shop profile → "إقفال الفترات" card, owner):**
   - `closing.frequency`: `monthly` | `yearly` (default `monthly`);
   - `closing.fiscalYearStartMonth`: 1–12 (default 1).
2. **Lock date:** `meta.closing.lockedThrough` (a local business date).
   - Nothing may post with a business date ≤ lockedThrough: no new document, no manual entry, no edit of a document dated in a locked period → 409 PERIOD_LOCKED, with the date in the message.
   - Returns, cancels and payments on old documents are still allowed. Their entries are dated today (already the case), so they land in the open period.
   - Every existing posting path must go through one `assertOpenDate(date)` helper. List them all in the report:
     - sales, credit, receipts, returns, cancels, edits;
     - purchases, PV, PR, SR;
     - expenses, transfers, drawings, payouts;
     - shifts, VAT filing/payments, opening re-save, manual entries, product stock/cost postings;
     - migrations (exempt).
3. **Close a month** (`accounting.close`, a new permission, owner only by default):
   - closes the oldest open month only, in order, and only after the month has ended (local time);
   - sets lockedThrough to the month's last day;
   - with frequency `yearly`, only whole fiscal years can be closed (the year must have ended), and lockedThrough = the year end.
4. **Year-end closing entry:**
   - when the period being closed ends on the fiscal year end (in both frequencies), post one closing entry (type `closing`, number JE, dated the year-end day):
     - zero every revenue and expense account (4 and 5 trees);
     - post the net profit (or loss) to RETAINED_EARNINGS (32);
     - also close OWNER_DRAWINGS (33) into 32.
   - After it, the income statement for the new year starts at 0, and the balance sheet shows the profit inside 32.
5. **Pre-close checklist**, shown before confirming; blocking items must be fixed first:
   - **blocking:**
     - any open shift with openedAt ≤ the period end;
     - unposted manual drafts dated in the period;
     - health has any non-zero check;
     - (when VAT is on) unfiled VAT months inside the period;
     - the opening balance not finalized (Stage 18) → finalize first.
   - **warnings:** customers/suppliers with balances (info only).
6. **Reopen** (owner only, a reason required, audit):
   - only the latest closed period;
   - it moves lockedThrough back to the previous period end;
   - if that period's close posted a year-end closing entry, reverse it (linked);
   - a VAT return filed for a month inside a reopened period stays filed (VAT has its own order rules).
7. **Screens:**
   - "إقفال الفترات" under الحسابات: the current lock date, the next period to close with its checklist, a close button with a double confirm, the history of closes/reopens (who, when, the closing entry link), and reopen on the latest;
   - the date pickers in all posting forms show locked dates disabled, and a banner explains "الفترة دي مقفولة لحد …".
8. **Health:**
   - a "closing" check: no entry with a business date ≤ lockedThrough was created after the close (createdAt > closedAt), except closing/reversal entries of that close;
   - the year-end entry zeroes the P&L accounts for that year exactly;
   - can-fail tests.

## Hard rules
1. **Reports read only the ledger** (plus the statement services for party aging). They never recompute figures from documents.
2. **Manual entries and closing entries go through postEntry/reverseEntry,** in a transaction, and are never edited.
3. **No change to existing posting behavior,** apart from the lock-date check.
4. **Styling:** tokens only (no hex, no `[attr.dir]`), light/dark, ar/en, RTL, 390px.
5. **Safety:**
   - Never commit.
   - Never use port 27017, the real DB or C:\ProgramData\Nota.
   - Ask before sudo.
   - Leave no test processes behind.

## STEP 0 — Findings (read-only, report before planning)
1. **The existing aggregation helpers** (accounts tree balances, ledger, health) that the reports can reuse, and their indexes.
2. **Every posting path** and where a single assertOpenDate check fits. Note any path that posts with a date other than today, so that edits, cancels and returns on old documents keep working.
3. **The statement/open-items services** for customers and suppliers, and how manual party lines plug in.
4. **The existing JournalEntry types and sources,** and the entries health check.
5. **The design screens' fields** (Reports, ManualEntry, Accounts, AddAccount), and anything the design shows that this brief doesn't cover.
6. **Where the profit report** (Stage 14+) overlaps with the income statement. Propose whether it stays as a product-level report. Expected: yes, it stays.

## STEP E — Tests
- **Backend (`test/stage22.test.js`), with real numbers:**
  - Use the design's October: sales 37,450, discount 650, COGS 25,300, expenses 4,500/3,500/650/420/330 → net profit 2,100.
  - Build it through real documents (sales, returns, purchases, expenses). The income statement must match.
  - The balance sheet balances (assets = liabilities + equity) on that data, with the current-period profit shown.
  - The trial balance opening/movement/closing for a period, totals equal.
  - Box movements = the box ledgers.
  - Party aging = each statement.
  - The Excel export of each report (open the file and check a few cells).
  - Manual entries:
    - a draft (edit/delete);
    - post;
    - forbidden accounts (box, 114, VAT when on);
    - a bad-debt write-off on a customer → the statement line, balance and aging; health 0;
    - a reversal.
  - Accounts: add a leaf/group under several parents (the code rule); rename a system account; deactivate rules; reactivate; delete-if-never-used.
  - Closing:
    - monthly close in order;
    - PERIOD_LOCKED on each posting path (a test per path family);
    - returns/cancels/payments on a locked document still work, dated today;
    - the yearly frequency (only a whole year);
    - the year-end entry (P&L zeroed, profit to 32, drawings closed into 32);
    - the new year's income statement starts at 0;
    - reopen (the closing entry reversed);
    - the checklist blocks (open shift, drafts, health, VAT, opening not finalized);
    - the closing health check + can-fail.
  - Permissions: reports.financial, accounting.manage, accounting.close.
  - Timing: the reports with ~20,000 entries.
- **Legacy migration script:** after the upgrade, run the reports (the balance sheet balances), close a past month and check health.
- **Smoke:**
  - the reports (income/balance/trial/boxes/aging) return and balance;
  - an Excel export downloads;
  - a manual draft → post → reverse;
  - forbidden account → 400;
  - a bad debt;
  - close last month → posting into it → 409 PERIOD_LOCKED → a return on a locked invoice works → reopen;
  - health printed and 0;
  - a cashier gets 403 on reports/manual/close.
- **Frontend specs:**
  - each report tab (filters, comparison, the zero toggle, drill-down links, export);
  - the manual entry form (balance indicator, party lines, forbidden-account errors, draft vs post);
  - the account add/edit/deactivate dialogs;
  - the closing screen (checklist, double confirm, history, reopen);
  - locked dates in the date pickers;
  - payload specs.
- **Screenshots** in nota-review/stage-22/:
  - each report tab light ar;
  - the income statement light/dark ar/en;
  - the balance sheet;
  - the manual entry;
  - add account;
  - the closing screen with a checklist;
  - the PERIOD_LOCKED banner;
  - 390px for the income statement.

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
- open each report for last month and compare the income statement with the profit report;
- add an expense account and use it in an expense;
- post a manual entry (owner drawing correction or bad debt) and reverse it;
- close last month and try to back-date a sale into it;
- reopen.

Update docs/OFFLINE_PLAN.md:
- mark Stage 22 done;
- record the report definitions, manual entry rules (forbidden accounts, party lines), the account code rules, and the closing/lock rules (incl. the year-end entry and reopen);
- the accounting phase is complete.

Do not commit.

## Final report — exactly this, in one code block
```
=== STAGE 22 REPORT ===
STEP 0 findings (aggregation helpers, posting paths, statement services, entry types, design fields, profit report overlap):
Reports (each: definition, endpoint, rows, comparison, drill-down, Excel; timing with 20k entries):
Design October numbers (income statement and balance sheet result):
Manual entries (drafts, posting, forbidden accounts, party lines on statements, reversal):
Accounts management (code rule per branch, edit/deactivate/delete rules):
Period closing (settings, lock check paths list, monthly/yearly, year-end entry lines, checklist, reopen):
Health (entries/customers/suppliers with manual lines, closing check; can-fail tests):
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
