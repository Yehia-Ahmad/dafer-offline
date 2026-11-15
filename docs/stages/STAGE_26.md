# Stage 26 — Product barcodes, labels and scanning

Read before starting:
- docs/OFFLINE_PLAN.md (Stage 23 print system, Stage 25 release process)
- nota-backend/src/models/product.model.js, the products controller/routes, the permission catalog and role templates
- nota-frontend: core/print (the pipeline, barcode.ts, print settings), the products pages, selling (POS), credit-sales, returns, purchases
- docs/stages/STAGE_22.md–STAGE_25.md: their hard rules apply (accounting rules, print rules, protection, release)

Start in plan mode and show me the plan before changing anything. Use Node 24 and a real mongod. Run long suites with a timeout and output to a file (never piped into head). Leave no test processes behind. Never use git worktree on Windows. Never touch C:\ProgramData\Nota, the installed Nota, or ports 27017/27217. Never put a real private key in the repo; keys.js keeps the placeholder.

## Goal
A shop can:
- record each product's barcode, by scanning the factory barcode or generating one;
- print barcode stickers on a label printer or on A4 sticker sheets;
- sell, return and purchase by scanning with an ordinary USB barcode scanner.

## Decisions (already made; implement exactly)

### 1. Barcodes on the product
- New field `barcodes`: an array of strings, 0 to 5 per product. The existing `code` stays as it is: it's the shop's internal code, separate from barcodes.
- Each barcode is trimmed, 4–48 characters, digits and Latin letters plus `-` `.` `/` `+` (Code 128-safe ASCII).
- If a barcode is all digits with 8, 12 or 13 digits, its check digit must be valid (EAN-8 / UPC-A / EAN-13). A wrong check digit → refused with a clear message. Real scanned barcodes always pass this check.
- **Unique across all non-archived products.** No two products share a barcode, and one product can't list the same barcode twice. Enforce it in the database (a unique index on the barcode values, excluding archived products; STEP 0: propose the exact index, e.g. a separate collection or a multikey partial unique index, and prove it with a race test). Error: 409 BARCODE_TAKEN with the other product's name and code.
- Archiving a product frees its barcodes. Unarchiving re-checks them; a conflict blocks the unarchive with a clear message.
- A migration adds the field (empty) to existing products. Nothing is generated automatically.
- Audit: barcode changes are recorded in the product's audit log like other field changes.

### 2. Generating barcodes
- **"ولّد باركود"** on the product form generates an in-store EAN-13: `2` + 11 digits from an atomic counter (the existing Counter model) + the check digit. Prefix 2 is the GS1 range reserved for in-store use, so it never collides with a factory barcode.
- If a generated number is already taken (e.g. typed in by hand earlier), skip to the next one.
- **Bulk action** on the products page: "ولّد باركود للمنتجات اللي ملهاش" for the current filter (category / all). It shows the count first and asks to confirm. It adds one generated barcode to each product with none, in batches, and reports how many were done.
- Permission: the same as editing products.

### 3. Entering barcodes
- The product form has a "الباركود" list:
  - add a barcode by typing it or by scanning into the field (a scan ends with Enter, which adds it to the list instead of submitting the form);
  - remove a barcode;
  - the generate button;
  - each barcode shows its type (EAN-13 / EAN-8 / UPC-A / Code 128).
- The products list shows the first barcode and searches barcodes too.

### 4. Scanner input
- Scanners act as a keyboard (HID keyboard wedge): they type the code fast, then press Enter. No driver and no new dependency.
- **Arabic keyboard layout:** if the Windows layout is Arabic while scanning, letters arrive as Arabic characters. Normalise all scanned/typed codes before lookup:
  - map the Arabic (101) layout characters back to the Latin key in the same position;
  - map Arabic-Indic and Persian digits to ASCII;
  - strip invisible characters (RLM/LRM, zero-width).
  Apply it to barcode lookups, the product form's barcode field and the invoice-number scan. Test it with "INV-000125" typed on the Arabic layout.
- One shared scan helper in the frontend: a lookup by exact barcode first, then by exact product `code`. Only exact matches count, never a partial match.
- Backend: `GET /api/products/by-barcode/:code` → the product (non-archived only), with the same fields and permission as the POS product search; 404 BARCODE_NOT_FOUND. The existing product search also matches barcodes exactly.

### 5. Scanning in each screen
- **POS (cash) and credit sales:**
  - focus stays on the search box after every add;
  - Enter with an exact match adds the product with quantity 1. If the same product with the same price type is already a line, its quantity goes up by 1 instead of a new line;
  - the existing stock, price and VAT rules apply unchanged (a scan is just a faster add);
  - no match → a short error sound plus a toast "باركود مش متسجل: <code>", and the box keeps the text, selected, so the next scan replaces it. For a user who can manage products, the toast offers "أضف منتج بالباركود ده" (opens the product form with the barcode filled in);
  - an archived product's barcode → "المنتج ده متأرشف".
  - The plain typing search (partial matches in the grid) keeps working as today when the text isn't an exact match.
- **Returns:**
  - scanning the Code 128 on a receipt (the invoice number, e.g. INV-000125 / CR-…) opens that invoice for return;
  - inside an open invoice, scanning a product's barcode selects that line and adds 1 to the return quantity, up to what's returnable.
- **Purchases:** scanning adds the product to the purchase with quantity 1, or +1 on an existing line. An unknown barcode offers "أضف منتج" (for users who can).
- **Products page:** scanning into the search box finds the product.
- Sounds: one short "ok" and one "error" sound, bundled locally (no network), with a mute option in the print/device settings, stored per device.

### 6. Labels (stickers)
- **A new print document, PrProductLabel,** in the Stage 23 pipeline: pure render, real text, offline fonts, light palette, RTL/LTR by UI language.
- **Content options,** chosen in the print dialog and remembered per device:
  - shop name (on/off);
  - product name (always; long names wrap to 2 lines, then ellipsis);
  - price: retail (default), wholesale, the price after discount, or none. It's the stored selling price as shown in the POS, never a cost; follow the VAT display rules from Stage 21;
  - the barcode, with its digits under it (always);
  - the internal code (on/off).
- **Barcode symbology:** EAN-13 / EAN-8 / UPC-A when the barcode is a valid one of those, otherwise Code 128 (jsbarcode already bundled; no new dependency). Size the bars so the label printer and sheets scan reliably: report the module width and quiet zones you chose.
- **Which barcode is printed:** the product's first barcode. If the product has none, the dialog offers to generate one first (users who can edit products) or skips it with a warning.
- **Two ways to print:**
  - **(a) Label printer** (a roll of stickers): a new per-device printer setting "طابعة الملصقات" next to the receipt and A4/A5 printers, with a test label button.
    - Presets: 38×25, 40×30, 50×25, 50×30, 58×40 mm, plus custom W×H in mm.
    - One label per page (`@page` = the label size).
    - Horizontal/vertical offset (mm) and a gap setting, per device, like the receipt calibration.
    - Silent printing to the label printer when it's configured.
  - **(b) A4 sticker sheets** on the A4/A5 printer.
    - Presets: 3×7 (21, 70×42.3), 3×8 (24, 70×37), 4×10 (40, 52.5×29.7), 5×13 (65, 38.1×21.2), plus custom: columns, rows, label width/height, top/side margins, horizontal/vertical gaps.
    - **"Start at label N"**, so a partly used sheet can be reused.
    - A "print an outline test sheet" button (label borders only) to check the alignment on plain paper.
  - Settings are per device, stored with the other print settings. All values are validated and clamped (numbers only, sane ranges), the same way as the receipt width/offset; no CSS injection.
- **Where to print labels from:**
  - **product page:** "اطبع ملصقات" with a quantity;
  - **products list:** multi-select products, a quantity per product (default 1), then print;
  - **purchase detail:** "اطبع ملصقات للكميات المستلمة": one label per received unit by default, editable per line before printing;
  - **a category filter:** "all products in this category", quantity per product.
- **Limits:** at most 2,000 labels per print job, with a clear message above that. A large job renders in pages without freezing the UI.
- Labels are not numbered documents: no copy counter, no audit entry per print.
- **Permission:** a new `products.printLabels` in the catalog. Templates: owner, manager and storekeeper have it; cashier doesn't by default. The router-walk test covers any new route.

### 7. Cost visibility
Labels and scans never expose cost or profit. by-barcode returns the same fields as the POS search for the same user.

## STEP 0 — Findings (read-only, report before planning)
1. The product model and every place a product is created, edited, archived, imported or searched (backend and frontend).
2. The best way to enforce unique barcodes across non-archived products in MongoDB 8 (multikey partial unique index vs a separate barcode collection), with the trade-offs; how archive/unarchive interacts with it.
3. How the POS, credit sales, returns and purchases add a product today (functions, focus handling, the line-merge rule), and where the scan helper hooks in.
4. How the return screen finds an invoice today (by number?), and how a scanned invoice number would open it.
5. The Stage 23 print pipeline pieces to reuse for labels (settings storage, printer list, silent print, calibration), and jsbarcode's support for EAN-13/EAN-8/UPC with the bundled version.
6. The Arabic (101) keyboard map you'll use for normalisation (show the table).
7. The existing price fields (retailPrice, wholesalePrice, discountPercentage, priceAfterDiscount) and how the POS shows prices with VAT.

## STEPS
- A — Backend: field, validation, unique index, migration, generate (single + bulk), by-barcode, search, permission.
- B — Frontend: product form barcode list, products list column/search, bulk generate, the scan helper + normalisation, sounds.
- C — Scanning in POS, credit sales, returns (invoice + line), purchases, products page.
- D — Labels: the PrProductLabel template, label-printer and A4-sheet layouts, settings + calibration/outline tests, print entry points.
- E — Tests, docs, manual test cases.

## Tests
- **Backend:**
  - barcode validation, including check digits (valid and invalid EAN-13/EAN-8/UPC-A);
  - 0–5 per product; no duplicates within a product;
  - uniqueness across products, including a parallel race test (two products saving the same barcode at once: exactly one wins), 409 BARCODE_TAKEN with the other product's name;
  - archive frees the barcode; unarchive with a conflict is blocked;
  - generate: EAN-13, prefix 2, valid check digit, skips taken numbers; bulk generate only touches products with none and reports the count;
  - by-barcode: exact match only, archived → 404, the same fields and permission as the POS search, no cost for a cashier;
  - the search matches barcodes exactly;
  - the migration;
  - the new permission and the router walk.
- **Frontend:**
  - normalisation: Arabic-layout letters, Arabic-Indic digits, invisible characters, "INV-000125" from the Arabic layout;
  - the scan helper (barcode first, then code, exact only);
  - POS and credit sales: a scan adds qty 1, a second scan merges +1, an unknown code → the toast and the selected text, archived → the message, a non-exact typed search still filters the grid;
  - returns: an invoice-number scan opens the invoice; a product scan adds 1 up to the returnable quantity;
  - purchases: a scan adds/merges;
  - the product form: Enter in the barcode field adds to the list and doesn't submit;
  - labels:
    - each content option on/off;
    - the symbology choice (EAN-13 vs Code 128);
    - the label-printer page size per preset and custom;
    - the A4 grid per preset and custom;
    - start at label N;
    - the 2,000 limit;
    - long names;
    - RTL/LTR;
    - no cost ever;
    - clamped settings;
  - permissions: the buttons are hidden without products.printLabels.
- **Electron:** the label printer setting, silent print to it, the test label, and the outline sheet use the right page size and printer.
- **Visual check:** render to PNG in nota-review/stage-26/:
  - a 38×25 and a 50×30 label (Arabic and English, EAN-13 and Code 128, long name);
  - an A4 3×8 sheet starting at label 5;
  - a 5×13 sheet;
  - the outline test sheet.
  Check that the barcodes decode: use a decoder library in the test only (dev dependency, exact version, report it) or another reliable offline check, and report how.
- **Smoke:** by-barcode for a known product, BARCODE_TAKEN, generate, and a cashier without printLabels.

## VERIFICATION
- backend: `npm test` (0 skipped), `npm run test:legacy-migration`
- frontend: `npm run build:offline`, `npx ng test --watch=false --browsers=ChromeHeadless`
- frontend: `NOTA_ALLOW_PLACEHOLDER_KEY=1 npm run offline:stage`, then `npm run test:offline` and `npm run smoke:offline` (on the bundle)

**Manual check (Windows, with a USB scanner and, if available, a label printer):**
- scan a factory barcode into a product; generate one for another;
- print labels on the label printer and on an A4 sticker sheet (the outline test first);
- scan the printed labels in the POS (qty merges), credit sales, purchases and returns;
- scan a receipt's invoice barcode in returns;
- switch Windows to the Arabic keyboard and scan again.

Update docs/OFFLINE_PLAN.md:
- mark Stage 26 done;
- record barcodes, generation, scanning, labels and the settings;
- "Later": weighted/price-embedded barcodes (scales), QR codes.

Add the manual test cases to docs/release/MANUAL_TESTS_STAGE26.md (case, user, steps, expected, priority) and update CHANGELOG.md (ar/en) for the next version (1.1.0).

Do not commit.

## Final report — exactly this, in one code block
```
=== STAGE 26 REPORT ===
STEP 0 findings (product touchpoints, unique-index choice, add-product flows, return lookup, print pieces + jsbarcode, Arabic key map, prices):
Backend (field, validation, unique index + race proof, migration, generate single/bulk, by-barcode, search, permission):
Scanning (helper, normalisation, POS, credit sales, returns invoice/line, purchases, products page, sounds):
Labels (template, symbology + bar sizes, label printer presets/offsets/silent, A4 presets/start-at-N/outline, entry points, limits):
Cost visibility:
New dependencies (name, exact version, why; dev-only?):
Backend tests (new / total / skipped):
Frontend tests (new / total):
Electron tests (new / total / skipped):
Smoke test (summary + new lines):
Visual check (PNG paths, how barcodes were decoded):
Manual check (each step, or needs a scanner/label printer):
Docs updated (OFFLINE_PLAN, MANUAL_TESTS_STAGE26, CHANGELOG):
Open questions / anything you didn't do:
```
