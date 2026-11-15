# Manual tests — Stage 26 (barcodes, labels, scanning)

For a Windows PC with the installed (or staged) Nota, a **USB barcode scanner** (keyboard wedge: it types the code and presses Enter),
and, if available, a **label printer** and a sheet of **A4 stickers**. Everything marked "no hardware" can be done without them by typing
the code and pressing Enter. Nothing here needs the real license key beyond a normal install.

Barcodes used below: factory EAN-13 `4006381333931`, EAN-8 `96385074`, UPC-A `036000291452`. Any scanner test pack works too.

Users: **Owner**, **Cashier** (default cashier template), **Storekeeper** (default template).

| # | Case | User | Steps | Expected | Priority |
|---|------|------|-------|----------|----------|
| 1 | Scan a factory barcode into a product | Owner | Products → open a product → click the "الباركود" field → scan a factory barcode | The scan ends with Enter: the code is added to the list with its type (EAN-13 / EAN-8 / UPC-A / Code 128); the form is **not** saved or submitted. Save → reopen: it is still there | High |
| 2 | Wrong check digit is refused | Owner | Type `4006381333932` in the barcode field, Enter | A clear message about the check digit; nothing is added | High |
| 3 | A barcode cannot be shared | Owner | Give product B the barcode of product A, save | Refused: "الباركود … مستخدم بالفعل في المنتج «A»" (409); product B unchanged | High |
| 4 | Generate an in-store barcode | Owner / Storekeeper | Product form → "ولّد باركود" → save | A 13-digit number starting with `2` appears, type EAN-13; saved on the product | High |
| 5 | At most 5 barcodes | Owner | Add 5 barcodes, try a 6th | The field is disabled and the message says 5 is the maximum | Medium |
| 6 | Bulk generate | Owner / Storekeeper | Products page (all, then one category) → "ولّد باركود للمنتجات اللي ملهاش" | It shows the count first and asks to confirm; after OK only products with no barcode got one; the toast says how many | High |
| 7 | Bulk generate is hidden without edit rights | Cashier | Open Products | No "ولّد باركود…" button, no barcode field editing | Medium |
| 8 | Archive frees, unarchive re-checks | Owner | Archive product A (it has invoices, so it is archived); give its barcode to product C; restore A | Restore is blocked with a message naming C; free the barcode on C and restore A works | Medium |
| 9 | Search by barcode | Owner | Products page: scan a barcode into the search box | The product is found (even if not on the first page); the list shows the first barcode in its column | Medium |
| 10 | Cash sale: scan adds qty 1 | Cashier | POS → scan a product | It is added with quantity 1 and the wholesale price; the search box is empty and still focused; a short OK sound | High |
| 11 | Cash sale: second scan merges | Cashier | Scan the same product 3 times | One line, quantity 3 | High |
| 12 | Same product, other price type | Cashier | Change the first line to retail, scan the same product | A new wholesale line (the retail line is untouched); the next scan raises that new line | Medium |
| 13 | Unknown barcode in the POS | Cashier | Scan a barcode that is not registered | Error sound + "باركود مش متسجل: …"; the text stays selected in the box; **no** "add product" button for a cashier | High |
| 14 | Unknown barcode, user who can add | Owner | Same scan | The toast also has "أضف منتج بالباركود ده": it opens the product form with the barcode already in the list | Medium |
| 15 | Archived product | Cashier | Scan the barcode of an archived product | "المنتج ده متأرشف"; nothing is added | Medium |
| 16 | Typing still searches | Cashier | Type part of a product name in the POS box | The grid filters as before (no error); Enter on a partial name does nothing | Medium |
| 17 | Credit sale scan | Cashier | Credit sale → scan two products, one twice | Lines with quantities 1+1 and 2; a fresh empty line stays focused for the next scan | High |
| 18 | Purchase scan | Storekeeper | New purchase → scan a product twice | One line, quantity 2, at the product's cost | High |
| 19 | Purchase: unknown barcode | Owner | New purchase → scan an unregistered barcode → "أضف منتج بالباركود ده" | The inline "صنف جديد" opens with the barcode shown; create → the product is added to the purchase with its barcode saved | Medium |
| 20 | Returns: scan the receipt | Cashier | Print a cash receipt (INV-…) and a credit invoice (CR-…); Returns → new return → scan the printed Code 128 | The invoice opens at the lines step (INV- is cash, CR- is credit, whatever type was selected) | High |
| 21 | Returns: scan a product | Cashier | Inside that invoice scan a product that was sold | Its return quantity goes +1 per scan and stops at what is returnable (sold − already returned), with a message | High |
| 22 | Returns: product not in the invoice | Cashier | Scan a product that is not on the invoice | "المنتج ده مش في الفاتورة دي"; nothing changes | Low |
| 23 | Arabic keyboard layout | Cashier | Switch Windows to the Arabic keyboard; repeat 10, 11 and 20 | Same results (the scanner's letters arrive as Arabic characters and are mapped back; a receipt `INV-000125` still opens) | High |
| 24 | Scan sounds + mute | Owner | Settings → Print → "ملصقات الباركود" → mute → Save; scan | No sounds on this PC; unticking brings them back; another PC is not affected | Low |
| 25 | Label printer setup | Owner | Settings → Print → "ملصقات الباركود": pick the label printer and its size → "اطبع ملصق تجربة" | One test label comes out silently at the right size; the text and barcode are inside the edges. Adjust the offsets until centred | High (needs a label printer) |
| 26 | Print labels from a product | Storekeeper | Product page → "اطبع ملصقات" → quantity 3 → Print | 3 stickers on the roll, one per page, silently; they scan | High (needs a label printer) |
| 27 | Print labels for the selection / a category | Storekeeper | Products → tick products → "اطبع ملصقات للمحدد" (and inside a category "اطبع ملصقات كل منتجات الفئة") | The dialog lists each product with a quantity (default 1); the total is shown; Print works | Medium |
| 28 | Labels for received quantities | Storekeeper | Open a posted purchase → "اطبع ملصقات للكميات المستلمة" | One label per received unit of each line by default, editable per line | Medium |
| 29 | Product with no barcode in a print job | Storekeeper / Cashier-like custom user | Include a product with no barcode | A user who can edit products is offered "generate first"; one who cannot sees that those products are skipped | Medium |
| 30 | The 2,000 limit | Storekeeper | Enter a quantity that makes the total over 2,000 | A clear message and Print is disabled; 2,000 exactly prints | Medium |
| 31 | Label content options | Storekeeper | Toggle shop name, internal code, the price choice (retail / wholesale / after discount / none) | The label changes accordingly; the choices are remembered next time on this PC; **no cost or profit ever appears** | High |
| 32 | VAT on labels | Owner | Turn VAT on (prices including VAT) and print a label; then prices excluding VAT; then an exempt product | "شامل الضريبة", then "+ ض.ق.م 14%", nothing for the exempt product | Low |
| 33 | A4 outline sheet | Owner | Settings → pick the sheet layout → "اطبع ورقة اختبار الحدود" on plain A4; hold it over the sticker sheet against the light | The borders line up with the stickers; if not, use the custom grid margins | High (needs a printer + stickers) |
| 34 | A4 labels, start at N | Storekeeper | Print labels on A4 with "ابدأ من الملصق رقم" = 5 on a sheet whose first 4 stickers are used | Labels start at the 5th sticker and fill the rest; more labels continue on the next sheet from its first sticker | High (needs a printer + stickers) |
| 35 | Scan the printed labels | Cashier | Scan the stickers you printed (roll and A4, EAN-13 and Code 128) in the POS, credit sales, purchases and returns | Every sticker scans on the first try; the POS merges repeated scans | High (needs the scanner) |
| 36 | Permissions | Cashier | Open Products and a product | No select column, no "اطبع ملصقات", no bulk generate; scanning in the POS still works | High |
| 37 | Customers' view of prices | Cashier | Scan a product in the POS and open the network inspector / or just look at the screen | Only selling prices and stock; never the purchase price | Medium |
| 38 | Excel export / import | Owner | Export the categories workbook; open the Products sheet; import a copy with a repeated barcode | A "Barcodes" column (space separated); the import refuses the row whose barcode another product has, naming it | Low |
| 39 | Upgrade keeps data | Owner | Install this version over 1.0.0 with products | Every product still opens; barcodes are empty; nothing was generated automatically; a before-upgrade backup exists | High |
