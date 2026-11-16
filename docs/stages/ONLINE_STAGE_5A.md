# Online Stage 5A — Align the website backend and settings with the design

Read before starting:
- docs/ONLINE_PLAN.md (Stages 1–4 and their decisions)
- The designs: docs/design/screens/WebHome.dc.html, WebProduct.dc.html, WebCheckout.dc.html, WebSettings.dc.html (and Sidebar.dc.html, MobOrders.dc.html, MobOrder.dc.html, MobSite.dc.html for reference). They are the source of truth for what the website and its settings page show.
- nota-backend: src/models/websiteSettings.model.js, webOrder.model.js, product.model.js, category.model.js, src/store/* (catalog, whitelist, orderPricing, reservations), src/controllers/storeOrder.controller.js, storeCatalog.controller.js, website.controller.js, src/services/webOrders.service.js, src/controllers/selling.controller.js (cash sale creation, `createSellingInvoice`, and the cash-sale refund), src/controllers/creditSale.controller.js (the functions Stage 4 exported), src/cashbox/boxes.js (`resolveBox`, wallet/bank boxes), src/auth/permissions.js, test/permissions.test.js
- nota-frontend: src/app/modules/website/* (settings page, delivery zones page), the orders module from Stage 4

Start in plan mode and show me the plan before changing anything. Use Node 24 and a real mongod. Run long suites with a timeout and output to a file (never piped into head). Leave no test processes behind. Never use git worktree on Windows. Never touch C:\ProgramData\Nota, the installed offline Nota, or ports 27017/27217. Never commit; I commit after I review.

## Context
The website designs contain features Stages 3–4 did not build. This stage adds them to the backend and the admin app, so Stage 5B can build the storefront app straight from the designs. No storefront UI in this stage.

## Decisions (already made; implement exactly)

### 1. Pickup from the shop
- Website setting `fulfillment: { delivery: bool, pickup: bool }` (at least one on). The checkout offers the enabled ones.
- An order has `fulfillment: "delivery" | "pickup"`. Pickup: no zone, delivery fee 0, address optional.
- Pickup statuses: `new → confirmed → preparing → ready_for_pickup → picked_up`, and `ready_for_pickup → cancelled` (reason required) when the customer never comes. `confirmed`/`preparing` can also be cancelled or rejected as today. Reservation covers `confirmed`, `preparing` and `ready_for_pickup`.
- **Picked up = a cash sale** created through the existing cash-sale creation path (`createSellingInvoice` or the smallest extraction around it), with the order's snapshot prices, into:
  - cash on pickup: the box chosen by the staff member, resolved by the existing `resolveBox` rules (their device's default box);
  - wallet payment (decision 2): the box configured for that wallet.
  Stock is deducted and the sale is posted like any cash sale.

### 2. Wallet transfers: InstaPay and Vodafone Cash
- Settings per method: `payments.cod.enabled` (on by default), `payments.instapay: { enabled, address (IPA), boxId }`, `payments.vodafoneCash: { enabled, number, boxId }`. `boxId` must be an active box of type `wallet` or `bank`. At least one method on. A card option is shown in the settings page as "قريبًا" only.
- `paymentMethod` enum: `cod`, `instapay`, `vodafone_cash`.
- Flow: the customer places the order, the success page shows the transfer details (IPA or number, exact amount, order number) and a WhatsApp link to the shop with a prefilled message. Staff check the transfer and press **"تأكيد استلام التحويل"** (optional transfer reference). The order stores `payment: { status: "unpaid" | "verified", verifiedAt, verifiedBy, reference }`.
- **Nothing is posted when the transfer is verified.** The money is posted when the invoice is created:
  - delivery + wallet: at "send out", a **cash sale** (not a credit sale on the courier) into the wallet's box, with the delivery fee as `shippingFees`. The courier collects nothing; "delivered" only changes the status. "Send out" is refused until the payment is verified.
  - pickup + wallet: the cash sale at pickup into the wallet's box; refused until verified.
  - Refusal or returns after a wallet sale: the existing cash-sale return, refunding from the wallet's box.
  - If a verified order is cancelled before any invoice, nothing was posted, so nothing is reversed; the refund to the customer happens outside Nota and the cancel reason records it.
- COD + delivery stays exactly as Stage 4 (credit sale on the courier, payment into the courier's box). The design's "box for COD collection" selector is NOT built: COD collection always goes to the courier's box.

### 3. Showing stock on the website
- Settings: `stock.showOutOfStock` (default true: out-of-stock products show with "خلصت" and cannot be ordered; false: they are hidden), `stock.showRemaining: { enabled (default true), threshold (default 5) }`.
- Public product: when `showRemaining.enabled` and available stock (inventory − reserved) is between 1 and the threshold, add `remaining` (the number). Otherwise no number, as today.

### 4. Which products show
- Setting `productVisibility: "marked" | "all"`, default `"marked"`.
- Replace the boolean `website.visible` on products and categories with `website.visibility: "show" | "hide"` (unset allowed). `"marked"`: shows only when `"show"`. `"all"`: shows unless `"hide"`. Archived products and hidden categories never show.
- Migration: `visible: true → visibility: "show"`; `visible: false` and missing → unset (migration 12 wrote `false` for everything, so it carries no choice). Remove the old field. Every Stage 3/4 read, filter, whitelist rule, test and admin control moves to the new field.

### 5. Other settings from the design
- Look: `brandColor` (one of the six presets in WebSettings.dc.html), optional `websiteLogo` (base64, same rules as the shop logo; falls back to the shop logo), `announcement: { enabled, text (≤ 160) }`, banners stay (the design says up to 3: keep the max at 5, show "حتى ٣ مستحسن" as a hint).
- General: `seoDescription` (≤ 300), `openingHours` (text), `facebook` (already exists), `whatsapp` (already exists).
- Delivery: `sameDayCutoff` (optional "HH:mm"), shown on the website as information only.
- Home highlights: `highlights` up to 3 items `{ icon (one of a small preset list: delivery, cash, exchange, shield, clock, star), title, text }`, defaulting to three items built from the settings (delivery, payment methods, returns) when empty.
- Orders: `whatsappConfirmTemplate` (text with placeholders `{الاسم}`, `{رقم الطلب}`, `{الإجمالي}`, `{مدة التوصيل}`). The admin order page gets **"ابعت تأكيد على واتساب"**: opens `https://wa.me/<customer phone>?text=<filled template>` in a new tab. No WhatsApp API.
- Shown in the settings page as disabled "قريبًا" (not built): website price list, automatic order acceptance, card payment.
- Not built: the design's subdomain field (each shop has its own domain and server).

### 6. Public product data for the design
- `code` becomes public (the design shows "كود الصنف"); still never for archived products.
- `specifications` (the product's existing specifications, as `[{ label, value }]` strings only).
- Badges: `discount` when the discount > 0, `new` when created in the last 14 days, `out_of_stock`.
- `GET /api/store/products/:id/related` → up to 8 visible products from the same category (excluding itself), in-stock first.
- Sort `bestselling` (by `soldItemCount`, never exposing the number).
- Category: `image` URL when it has one (the storefront shows a generic icon otherwise).
- Public settings: everything the designs need (brand color, logo URL, announcement, highlights, opening hours, fulfillment options, enabled payment methods with their public details — IPA address / wallet number — but never box ids, sameDayCutoff, min order, free delivery, policies, social links). Whitelisted as before.

## Hard rules
- **Do not change how existing documents are priced or posted.** Cash sales, credit sales, payments and returns go through the existing in-transaction functions; any extraction is the smallest possible and keeps behavior identical; every existing test passes unchanged except tests that read the renamed `website.visible`.
- Every order transition stays one transaction with the status guard first (Stage 4 pattern); 409 on a wrong status.
- The order total must equal the total of the invoice created for it (credit sale or cash sale), for VAT-inclusive, VAT-exclusive and no VAT, with and without delivery fee.
- The public API stays whitelisted field by field.

## Permissions
- Verifying a transfer: `orders.manage`. Picked up: `orders.dispatch` + `sales.create`. Delivery + wallet "send out": `orders.dispatch` + `sales.create` (it creates a cash sale). Returns on cash sales: `returns.create`.
- Update `EXPECTED_ROUTES` and the frontend list.

## Admin app
1. **Website settings page rebuilt to match WebSettings.dc.html**: tabs عام / الشكل / التوصيل / الدفع / المنتجات والطلبات, the quick preview on the side (brand color, announcement, logo), "افتح الموقع" button, the site status pill. Delivery zones move into the التوصيل tab as in the design (keep the API; the separate page and its sidebar item go away).
2. **Order page:** pickup actions (جاهز للاستلام / اتسلّم مع اختيار الخزنة for COD), "تأكيد استلام التحويل", payment method and status badges, the WhatsApp confirmation button, and the right actions per fulfillment and payment.
3. **Orders list:** fulfillment and payment columns/filters, and a "محتاج تأكيد تحويل" filter.
4. Product form and categories: the visibility control follows the mode (`"marked"`: "اظهر على الموقع"; `"all"`: "اخفي من الموقع").
5. i18n ar and en, same key count.

## Tests (backend, `test/online-stage5a.test.js`)
At least:
- pickup COD: full flow, cash sale into the resolved box, stock, posting; never-collected cancel releases the reservation;
- pickup wallet and delivery wallet: refused before verification; after verification the cash sale goes into the wallet's box with the right total (shippingFees for delivery); the courier collects nothing; refusal refunds from the wallet's box;
- order total = invoice total in all combinations (fulfillment × payment × VAT mode);
- visibility modes on products and categories, including the migration;
- `showOutOfStock` and `remaining` rules (reserved stock counted);
- public settings, product (code, specifications, badges), related and bestselling are whitelisted;
- disabled fulfillment or payment method is refused at placement; a wallet `boxId` must be an active wallet/bank box;
- permissions for every new or changed route.
Frontend: specs for the settings tabs, the order page actions per fulfillment/payment, the WhatsApp link builder.

## STEP 0 (plan, before any change)
1. Every file you will add or edit, one line each.
2. The exact existing function for the cash sale and the cash-sale return, and any extraction (smallest, behavior identical).
3. The full status/transition table after this stage (delivery × pickup, COD × wallet).
4. The migration for `visibility` and every place that read `website.visible`.
5. Anything in this brief you think is wrong or risky (especially accounting), with your alternative.

## Done means
- Backend `npm test` passes; frontend production build and `ng test` pass; `shellcheck deploy/*.sh` has no warnings at warning level.
- docs/ONLINE_PLAN.md has the Stage 5A section and decisions.
- Report: what was added, what was changed (especially any extraction), and the list of things you noticed but did not do.
