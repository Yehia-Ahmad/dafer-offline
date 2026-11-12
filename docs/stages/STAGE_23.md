# Stage 23 — Prints: every printable document, from the print designs

Read before starting:
- docs/OFFLINE_PLAN.md: every "print … Stage 23" note, and the *_PRINT_ENABLED flags
- docs/design/NOTA_DESIGN_SYSTEM.md
- **docs/design/prints/README.md and all Pr*.dc.html files.** This is the visual spec for every document. Match it.
- docs/stages/STAGE_22.md: its hard rules apply

Start in plan mode and show me the plan before changing anything. Use Node 24 and a real mongod (Windows: bundled; Linux: NOTA_TEST_MONGOD). Run long suites with a timeout and output to a file (never piped into head). Leave no test processes behind.

Today the app prints in three ad-hoc ways:
- HTML + window.print() for the cash and credit invoices (invoice-history-print.util.ts, credit-invoice-print.util.ts);
- a jsPDF/html2canvas raster PDF for the profit report;
- a recovery-code print.

After this stage, **every document prints from one print system**, in the designed layout, on the right paper:
- **80mm receipts:** cash sale, payment, return, shift close;
- **A4:** invoices, statements, reports, journal entry;
- **A5:** vouchers.

The output is real text (selectable, sharp Arabic), and it works offline.

## Decisions (already made; implement exactly)
1. **One print pipeline.**
   - Each document is an Angular template (or a pure render function) that produces print HTML from document data, with a shared PrintHeader/PrintFooter matching PrHeader/PrFooter. The CSS uses `@page { size: 80mm auto | A4 | A5 }`, real margins and print-only styles.
   - **In Electron:**
     - render into a hidden BrowserWindow;
     - **"طباعة":** `webContents.print()`. For 80mm documents with a configured receipt printer, use silent printing to that printer; otherwise show the system dialog;
     - **"حفظ PDF":** `webContents.printToPDF()` (vector, the right page size), saved through a save dialog.
   - **Outside Electron** (dev browser): window.print() fallback.
   - Remove jsPDF and html2canvas if nothing else uses them; report the bundle size before and after.
2. **Offline fonts.** Bundle Alexandria (the weights the designs use) as local font files in the app. Prints must never load Google Fonts. Keep a fallback stack.
3. **Prints always use the light palette** (the design colors via tokens), whatever the UI theme. Print language = the current UI language (ar RTL / en LTR). Numbers follow the designs (Arabic-Indic digits in Arabic). Money has 2 decimals with thousands separators.
4. **Page numbers on multi-page A4 documents.**
   - In printToPDF, use footerTemplate with pageNumber/totalPages.
   - For direct print, propose the best option in STEP 0 (e.g. render to PDF, then print the PDF), and choose the simplest that works offline on Windows.
   - Table headers repeat on every page; rows never split across pages; the signature block and footer stay together on the last page.
5. **Print settings** (shop profile → "الطباعة" card, shop.manage; per device where it makes sense, stored on the device):
   - **receipt printer:** from the list of installed printers (Electron `getPrintersAsync`), per device;
   - **A4/A5 printer:** default or a chosen one, per device;
   - **"اطبع الإيصال تلقائي بعد البيع":** off by default, per device;
   - **number of copies** for 80mm receipts: 1 by default;
   - **receipt footer text:** uses the existing shop footer;
   - **a "اطبع صفحة تجربة" button** for each printer.
   - **58mm:** later. Note it in OFFLINE_PLAN.md.
6. **Barcode on receipts:** a real Code 128 of the document number (INV-000125), as SVG.
   - Use a small, well-known library (e.g. jsbarcode).
   - Pin the exact version, at least 2 weeks old.
   - Report it before adding. This is the only new dependency allowed.
7. **Copies and cancelled documents:**
   - a reprint of an 80mm receipt is marked "نسخة" (copy) with the reprint time;
   - a cancelled invoice/voucher prints with a "ملغي" watermark and the cancel reason;
   - log every reprint of an 80mm receipt or A4/A5 invoice/voucher in the audit log as `document.printed`: number, type, user, copy number. This is anti-fraud: re-printing receipts.
8. **VAT** (Stage 21): when the document has VAT:
   - the title is "فاتورة ضريبية";
   - add the shop tax number, and the customer tax number when present;
   - add net/VAT/total rows and the "معفى" marks.

   VAT off = no VAT rows.
9. **Cost visibility:**
   - prints never show cost/profit to users without products.viewCost;
   - the stock list's cost/value columns are hidden for them;
   - the profit report needs reports.profit;
   - the financial reports need reports.financial;
   - the journal entry needs accounting.view.

   Each print endpoint/route checks the same permission as its screen.
10. **Data:**
    - every print takes its data from the existing API responses or a dedicated `GET …/print-data` endpoint when a screen doesn't have everything;
    - prints never recompute totals: they show stored values;
    - each document's "printed by / at" is the signed-in user and the local time.

## The documents (match each design; data source → trigger)
| # | Design | Document | Paper | Where to print from |
|---|---|---|---|---|
| 1 | PrCashReceipt | cash sale receipt (items, discount, VAT rows, total, paid/change if captured, barcode) | 80mm | after a sale (auto option); reprint from invoice history |
| 2 | PrPaymentReceipt | customer payment receipt (RC, balance before → after) | 80mm | after a receipt (both routes); customer page |
| 3 | PrReturnReceipt | return receipt (RT, items, refund, the customer balance for credit) | 80mm | after a return; returns list |
| 4 | PrShiftClose | shift close report (expected lines, counted, difference, deposit, remaining) | 80mm | shift close; shift history (SHIFT_PRINT_ENABLED → removed) |
| 5 | PrCashInvoice | cash sale invoice (A4 version) | A4 | invoice history (replaces invoice-history-print.util) |
| 6 | PrCreditInvoice | credit invoice + debt acknowledgment + due date | A4 | credit list, customer page (replaces credit-invoice-print.util) |
| 7 | PrPurchaseInvoice | purchase invoice (PO, supplier invoice no., lines, VAT, paid, supplier balance, the JE number) | A4 | purchase detail |
| 8 | PrReceiptVoucher | receipt voucher (RC) | A5 | customer page / receipts (an A5 alternative to #2) |
| 9 | PrPaymentVoucher | payment voucher. The same layout serves PV (supplier payment), EX (expense), DR (owner drawing), CP (customer payout), VP (VAT payment) and SR as a receipt-style voucher; the title changes per type | A5 | supplier payment dialog (SUPPLIER_PRINT_ENABLED → removed), expense list, drawings, payouts, VAT payments |
| 10 | PrCustomerStatement | customer statement + aging + the acknowledgment text | A4 | customer page (period filter) |
| 11 | PrSupplierStatement | supplier statement | A4 | suppliers page |
| 12 | PrStockList | stock count sheet (by category, ★ low stock, blank counted/difference columns) | A4 | products page (filter by category) |
| 13 | PrProfitReport | profit report | A4 | profit report page (replaces jsPDF) |
| 14 | PrFinancials | income statement + balance sheet | A4 | reports (REPORTS_PRINT_ENABLED → removed) |
| 15 | PrTrialBalance | trial balance | A4 | reports |
| 16 | PrJournalEntry | journal entry (lines, totals, source, reversal links, prepared/approved) | A4 | journal detail |

- Also restyle the existing recovery-code print to use the same header (no shop data needed).
- Box movements and party balances reports: print them with the PrTrialBalance table style (same header/footer).
- **The VAT return:** one A4 page with the month's figures (the summary + totals; the document lists are optional). Same style.

## STEP 0 — Findings (read-only, report before planning)
1. **Every print path today:** the files, how each one prints, what data it uses, and which jsPDF/html2canvas users exist.
2. **Electron:**
   - what the main process exposes today;
   - how a hidden-window print / printToPDF would be wired through preload IPC (with the Stage 15 IPC rule: the main process checks the token and permission when a print needs data it fetches itself);
   - how printers are listed.
   - Propose the page-number approach for direct printing (decision 4).
3. **Fonts:** where Alexandria comes from today (Google Fonts URL?), and how to bundle it offline for both the app UI and prints.
4. **For each of the 16 documents:** the data available on its screen today, and what's missing (e.g. paid/change on cash sales, the balance before/after on receipts, the JE number on a purchase). Propose `print-data` endpoints only where needed.
5. **The flags to remove:** SHIFT_PRINT_ENABLED, SUPPLIER_PRINT_ENABLED, REPORTS_PRINT_ENABLED, and any other "print later" TODOs.
6. **The barcode library proposal:** name, exact version, size, license.

## STEP A — Print system
- the shared print layout (header/footer, tokens, paper CSS, page breaks, the watermark, the copy mark);
- the Electron print/PDF IPC with printer selection and silent 80mm printing;
- the dev fallback;
- the print settings card (per device where stated);
- test pages;
- bundled fonts.

## STEP B — The 16 documents + the extras
Implement each template to match its design. Wire the buttons on each screen (permission-gated, locked pattern where relevant), with "طباعة" and "حفظ PDF". Add the auto-print after a sale (off by default). Add the reprint audit.

## STEP C — Clean-up
- Remove the old print utils and jsPDF/html2canvas (if unused).
- Remove the *_PRINT_ENABLED flags and TODOs.
- Update OFFLINE_PLAN.md.

## STEP D — Tests
- **Unit/spec, per template, with fixture data:**
  - the key text appears (title, number, totals, VAT rows when VAT is on and not when off, the "نسخة" mark, the "ملغي" watermark);
  - the cost columns are hidden without viewCost;
  - the RTL/LTR direction;
  - money formatting.
- **Electron tests (mocked webContents):**
  - print and printToPDF are called with the right page size and printer;
  - silent print only for 80mm with a configured printer;
  - the token/permission check for main-process data fetches;
  - the save dialog.
- **Backend:**
  - the print-data endpoints (permissions, numbers equal the stored ones);
  - the document.printed audit;
  - the cost hidden for cashiers.
- **Visual check:**
  - render every document with the nota-test-data fixture to PDF (printToPDF, or Playwright page.pdf for the dev build), then to PNG;
  - save them in nota-review/stage-23/;
  - compare each with its design file side by side (put the design screenshot next to it if you can render the .dc.html; otherwise describe the differences);
  - include a 3-page customer statement (repeated headers, page numbers) and a long stock list.
- **Smoke:** call the print-data endpoints for one document of each kind; a cashier gets 403 on cost-bearing prints.

## VERIFICATION
- backend: `npm test` (0 skipped)
- backend: `npm run test:legacy-migration`
- frontend: `npm run build:offline` (report the bundle size change)
- frontend: `npx ng test --watch=false --browsers=ChromeHeadless`
- frontend: `npm run test:offline`
- frontend: `npm run smoke:offline`
- frontend: `npm run offline:stage`
- On Windows: `npm run electron:build:win:offline`

**Manual check on the installed app (Windows, with a real printer if available):**
- set the receipt printer;
- turn on auto-print;
- sell → the receipt prints on 80mm;
- reprint → "نسخة";
- print a credit invoice and a customer statement on A4;
- save a PDF of the income statement;
- print a supplier payment voucher on A5;
- print a cancelled invoice → watermark;
- switch to English and print an invoice.

Update docs/OFFLINE_PLAN.md:
- mark Stage 23 done;
- record the print system, settings, fonts, barcode, the reprint audit and the page-number approach;
- "Later": 58mm paper.

Do not commit.

## Final report — exactly this, in one code block
```
=== STAGE 23 REPORT ===
STEP 0 findings (print paths, Electron wiring, fonts, data gaps per document, flags, barcode library):
Print system (pipeline, IPC, silent 80mm, PDF, page numbers, dev fallback, fonts):
Print settings (fields, per-device storage, test page):
Documents 1–16 + extras (each: template, data source/endpoint, where printed, differences from the design):
VAT, copy mark, cancelled watermark, reprint audit:
Cost visibility per document:
Removed (old utils, jsPDF/html2canvas, flags) and bundle size before/after:
Backend tests (new / total / skipped):
Frontend tests (new / total):
Electron tests (new / total / skipped):
Smoke test (summary + new lines):
Visual check (PDF/PNG paths, design differences):
Manual installed-app check (each step, or needs Windows):
Docs updated:
Open questions / anything you didn't do:
```
