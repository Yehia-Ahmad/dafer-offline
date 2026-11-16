# Online Edition Plan

## Context
- This is the `online` branch, taken from `main`. The offline edition stays on its own branch and must not be touched. `docs/OFFLINE_PLAN.md`, `docs/stages/*` and `nota-review/` are history.
- The online edition is the same shop system (same business logic, same pages, same permissions, same accounting) running as a normal web app: one Node backend + MongoDB on a Linux VPS (for example Contabo), one server per shop, used from a browser.
- A customer website and a mobile app (PWA) come in later stages, not in Stage 1.
- Everything that existed only because of the desktop/LAN setup is gone: Electron, the bundled mongod, main PC / client PCs, LAN discovery and the LAN key, the firewall, the setup wizard, the desktop backup/restore, the installer.

## General rules for every change
- Do not change business logic: selling, credit sales, returns, purchases, suppliers, customers, inventory, cash boxes, shifts, expenses, accounting (posting, periods, closing, opening, manual entries), VAT, reports, permissions.
- No refactoring or side improvements. If you notice something worth fixing, list it at the end of your reply instead of fixing it.
- Keep the migrations runner and all existing migrations as they are.
- Keep every existing test that covers business logic green. Delete only tests of removed desktop/LAN code, and list each one with the reason.
- Use Node 24 and a real mongod (replica set; transactions are required). Run long suites with a timeout and output to a file. Leave no test processes behind. Never use git worktree on Windows.
- Never commit. The owner of the repo commits after review.

## Stage 1 — remove the offline (desktop/LAN) layer

### Removed
- Frontend: `electron-offline/`, `electron/`, `installer-offline/`, `electron-builder.offline.json`, `scripts/offline/`, `build/icon.ico`, `src/app/offline/` (backup page, connection overlay, other-main banner, version notice), the main-PC guard, `core/runtime/` (the `window.notaDesktop` bridge), `environment.offline.ts` and the `offline` build configuration, the offline/electron scripts and the `electron` / `electron-builder` dev dependencies, the print settings card and the printer/test-print/save-PDF-through-the-desktop code, the recovery-code screen.
- Backend: LAN mode (`lanSecret` middleware, `/api/lan`, `NOTA_LAN_MODE`, `NOTA_LAN_SECRET`), the Electron hooks in `server.js` (`process.parentPort`, `NOTA_LISTEN_HOST`, graceful shutdown), the audit inbox, `localOnly()` and the HTTP `setup-owner` / `recover` routes, `autoIndex: !isLanMode()` and the LAN-only Mongo URI rule, `NOTA_AUTH`, `NOTA_APP_VERSION`, the migration runner's `killAllSessions` for the bundled mongod.

### Changed
- API base URL comes from the environment file: development `http://localhost:5000/api/`, production same origin `/api/`.
- Printing is browser printing only (hidden iframe + `window.print()`); "Save as PDF" is the browser's own destination. Print reservations (copy numbers) are unchanged.
- The login page is sign-in only. If there is no owner yet it says to run `create-owner` on the server.
- `CORS_ORIGINS` replaces the open `cors()` (the only security change in this stage).

## Decisions

### A. Auth is always on
The server is public, so the `NOTA_AUTH` switch is gone: login, permissions, cost stripping, `createdBy`/`updatedBy` and audit are always enforced. `NOTA_JWT_SECRET` (at least 32 characters) is required at start; the server fails closed without it.

### B. Creating the owner and recovery
No setup wizard, no main PC. `setup-owner` and `recover` over HTTP would let anyone on the internet claim an empty shop, so they are removed. On the server:
- `npm run create-owner -- --username <name> [--name "<Full name>"]` asks for the password, creates the owner and prints the recovery code once; it refuses if an owner exists.
- `npm run recover-owner` asks for a new password, prints a new recovery code and ends every session.
`GET /api/auth/bootstrap` stays (the login page needs `hasOwner` and the shop name/logo).

### C. `backup.manage`
Backups become the server's job (mongodump on a cron, documented in a later stage). The backup page and the desktop backup IPC are removed. The `backup.manage` permission stays in the catalog, unused, because removing it touches users' stored permission lists. **Status: still open.** For now the permission is kept; whether to remove it (and migrate stored permission lists) or give it a use is not decided.

### D. Devices and the default cash box (Stage 19)
**Decided and implemented.** The default cash box is chosen per device through `X-Nota-Device-Id` and the Device registry. In the browser the device id is a random id generated once and kept in localStorage; the device name is optional. There is no main PC / client PC role. Option (2), a default cash box per user, was not chosen. This is no longer open.

### E. Server settings
- `.env.example`: `PORT`, `MONGO_URI`, `NOTA_JWT_SECRET`, `CORS_ORIGINS` (comma-separated allow-list).
- nginx serves the built Angular app (`dist/nota`) and proxies `/api/` to the backend; the backend serves no static files.

## Backups, nginx, the PWA and the customer website
Later stages.

## Stage 2 — running Nota on a VPS

One shop = one Ubuntu 24.04 VPS = one domain. Plain packages, no Docker: MongoDB 8 (single-node replica set `rs0`, authorization + keyFile, 127.0.0.1 only), Node 24, nginx, certbot, ufw, fail2ban; the backend is the systemd service `nota-backend`. The release package is built on the Windows PC and uploaded with `scp`; the server never needs the git repo.

### App changes (backend only, no business logic)
- `NOTA_LISTEN_HOST`: listen on that address (production `127.0.0.1`); unset = all interfaces.
- `NOTA_TRUST_PROXY=1`: `app.set('trust proxy', 'loopback')`. Behind nginx `req.ip` is otherwise always 127.0.0.1, so the login lockout (per username + IP) would lock everybody after 5 wrong passwords. `req.ip` is used by the login lockout (`auth.controller.js`) and the audit log (`auth/audit.js`) only.
- `GET /health` (outside `/api`, no auth): `{ ok, version, db }`, 200 when MongoDB answers a ping, else 503. `version` comes from `release.json` (written by `make-release.js`), falling back to `package.json`. Both package.json files are at `1.0.0`; `release.json` uses the backend's version, and the release name is `release-<version>-<commit>`.
- `NODE_ENV=production`: access log without query strings (search text); dev unchanged.
- Tests: `nota-backend/test/online-stage2.test.js` (not `stage24-*`: Stage 24 is the offline licensing stage).

### Layout on the server
`/opt/nota/releases/<version>-<commit>/{backend,frontend,release.json}`, `/opt/nota/current` (symlink), `/opt/nota/bin` (the scripts), `/etc/nota/{backend.env,backup.env,mongo-admin.env}` (root:nota 750 folder; secrets generated on the server, never in the repo), `/etc/mongodb-keyfile`, `/var/backups/nota`.

### Decisions
- **F. nginx serves, the backend proxies only.** nginx serves `/opt/nota/current/frontend` (SPA fallback, `index.html` never cached, hashed js/css cached for a year) and proxies `/api/` and `/health` to 127.0.0.1. The customer website / PWA later can take `/` or get another `server` block without touching the proxy rules.
- **G. `client_max_body_size 100m` on `/api/`** (the category Excel import allows 100 MB; JSON stays limited to 10mb by the app).
- **H. nginx sends `X-Forwarded-For $remote_addr`** (not append), so a client-supplied header never reaches the backend.
- **I. Scripts:** `deploy/setup-server.sh` (once, idempotent, never replaces generated secrets), `backup.sh` (daily 03:30 Cairo; keep 14 locally, 30 off-server via rclone if `NOTA_RCLONE_REMOTE` is set, warning every run if not), `restore.sh` (type the domain, safety backup, `--drop`, `NOTA_SESSIONS_VALID_AFTER`=now), `update.sh` (backup, unpack, `npm ci --omit=dev`, switch, wait `/health` 60 s, rollback = old symlink + restore of the before-update backup, keep 3 releases), `nota-owner` (create/recover owner on the server). `deploy/make-release.js` runs on Windows.
- **J. SSH hardening is manual** (documented in `docs/deploy/NEW_SERVER_AR.md` with a test-in-a-second-window warning).
- **L. `xlsx` is vendored** (`nota-backend/vendor/xlsx-0.20.3.tgz`, `"xlsx": "file:vendor/xlsx-0.20.3.tgz"`, same integrity hash as the SheetJS CDN build), so `npm ci` on the server never needs cdn.sheetjs.com. The release includes `vendor/`.
- **M. Login rate limit in nginx** (`limit_req`, 10/minute per IP, burst 5, 429) on `POST /api/auth/login` only; nothing else is rate limited yet. The app's own lockout (5 failures per username + IP) stays.
- **N. rclone from the official installer** (`https://rclone.org/install.sh`), not apt.
- **K. Rollback loses writes made between the pre-update backup and the rollback** (seconds to a minute); update at a quiet time.
- Docs (Arabic): `docs/deploy/NEW_SERVER_AR.md`, `UPDATE_AR.md`, `BACKUP_RESTORE_AR.md`.

## Stage 3 — website backend and website settings

The online edition gets a customer website. This stage is the backend (public catalog API, customer accounts, placing an order) and the admin screens that control it. There is no storefront UI yet: Stage 4 is website orders in the admin app, Stage 5 the storefront app (`nota-storefront`, SSR, admin app moves to `/admin/`), Stage 6 the PWA.

### Decisions (made in the brief)
1. **Same domain.** Later the storefront is at `https://<domain>/` and the admin app at `/admin/`. The public API is under `/api/store/`. Nothing in this stage moves the admin app.
2. **Payment: cash on delivery only.** `paymentMethod` is an enum with the single value `cod`.
3. **Customer accounts are optional.** A guest orders with name, phone and address; a customer with an account also sees their own orders and saved addresses (up to 5).
4. **Stock.** Placing an order reserves and deducts nothing. Reservation happens when the shop confirms the order and the deduction when it becomes an invoice (Stage 4). At placement the server only checks: product on the website, not archived, quantity ≤ current stock.
5. **Delivery fee by zone.** The zone fee is the final amount the customer pays for delivery; `freeDeliveryFrom` makes it 0 when the products subtotal reaches it. How the fee is split for VAT and accounting is decided in Stage 4.
6. The old Kapomatic website is reference only; nothing is copied.

### What was built
- **Public API** `/api/store/*`, mounted before the staff `requireAuth` (with its own 64 kb JSON limit). Every answer is built field by field in `src/store/whitelist.js`, never from a model with fields removed. Images are served as binary from `/api/store/images/...` (strong ETag, `Cache-Control: public, max-age=86400`, `?v=<updatedAt>` in the URLs, 404 for anything not visible, raster types only). Routes: `settings`, `categories`, `products`, `products/:id`, `delivery-zones`, `images/product/:id/:index`, `images/category/:id`, `images/banner/:id`, `images/logo`, `auth/register`, `auth/login`, `orders`, `orders/track/:token`, and for a signed-in customer `me`, `me/addresses`, `me/orders`, `me/orders/:id`, `me/orders/:id/cancel`.
- **Website off.** When `WebsiteSettings.enabled` is false every `/api/store/*` route except `GET settings` answers 503 `STORE_CLOSED` (so the closed page has no logo URL). `orderingEnabled=false` blocks only `POST orders` (409 `ORDERING_DISABLED`).
- **Customer tokens** use their own secret `NOTA_STORE_JWT_SECRET` (required at start, at least 32 characters, different from `NOTA_JWT_SECRET`; `setup-server.sh` and `update.sh` generate it only when missing) and the audience `nota-store`. A customer token is refused by every staff route and a staff token by every customer route. Customer login lockout: 5 failures per phone + IP for 5 minutes, its own counters.
- **Models:** `WebsiteSettings` (single document), `DeliveryZone`, `StoreCustomer` (not linked to the shop's `Customer`), `WebOrder`. Product gets `website.{visible, description, images≤4}`, Category `website.{visible, sortOrder}`. No schema defaults: a missing field means hidden, so the staff API answers do not change; migration 12 writes the explicit defaults (`visible: false`) and shows nothing.
- **Permission** `website.manage` (group "website"): owner always, manager yes, others no. Admin API `/api/website/*`: `settings` (GET/PUT), `delivery-zones` (CRUD; a zone an order used can only be deactivated), and `PUT /api/website/products/:id` and `/categories/:id` for the website fields, so website staff do not need `products.manage` and the existing product/category controllers are untouched.
- **Placing an order** (`POST /api/store/orders`, guest or customer): body is only product ids + quantities, the zone id, contact (or a saved address id) and a UUID `idempotencyKey`. Everything else is computed on the server in one transaction: unit price = `calculatePriceAfterDiscount`, VAT = `loadVatSettings` + `vatContext` + `computeSaleVat` with the same inputs a cash sale uses (verified against a real cash sale by a test), delivery fee from the zone, total. 409 with a per-line list (`not_available`, `quantity_exceeds_stock` with the current max); 409 `MIN_ORDER_NOT_REACHED`, `ZONE_UNAVAILABLE`. Order number `W-000001` from its own counter (`PREFIXES.WEB_ORDER`), separate from every invoice type. Idempotency: unique key; the same key returns the same order (200, same tracking token); the same key with a different request is 409 `IDEMPOTENCY_MISMATCH`. The stored order is a snapshot, never recalculated.
- **Tracking.** The `trackingToken` is derived from the idempotency key with an HMAC of the store secret and only its SHA-256 is stored; `GET orders/track/:token` shows status, items, totals and zone, no contact data. A customer can cancel their own order while it is `new`; all other status changes are Stage 4.
- **Prices on the website** follow the shop's VAT settings: with VAT on and `pricesIncludeVat`, shown prices include VAT (same as the POS); with prices excluding VAT, the product carries `vat: { rate, included: false }` and the order total adds VAT exactly like a cash sale; VAT off: no VAT block. The delivery fee is outside the VAT calculation in this stage.
- **nginx:** `POST /api/store/orders`, `auth/login` and `auth/register` are rate limited (10/min per IP, burst 5, zones `nota_store_order` and `nota_store_auth`), `client_max_body_size 64k` for `/api/store/`. An existing server needs `setup-server.sh` re-run to get the new nginx files; `update.sh` alone only generates the secret.
- **Admin app:** sidebar group "الموقع", pages "إعدادات الموقع" (status, identity, banners with reorder and link, featured categories, contact and social, ordering rules, texts; unsaved-changes guard) and "مناطق التوصيل", a "الموقع" section in the product form (edit mode, saves on its own), "show on website" and order in the category edit dialog, an "on website" badge column and filter in the products list.

### Not in this stage
Admin order screens, stock reservation, turning an order into an invoice, notifications and staff password reset for website customers (Stage 4); the storefront app (Stage 5); the PWA (Stage 6); SMS/OTP and self-service password reset (not planned).

## Stage 4 — website orders in the admin app

The shop can now see and edit website orders, confirm them (stock reservation), send them out with a courier (the invoice), record delivery and collection, handle refusals, and gets a badge and a sound for new orders. Brief: `docs/stages/ONLINE_STAGE_4.md`.

### Decisions (made in the brief)
1. **Couriers.** A `Courier` (name, phone, `isActive`) is created in ONE transaction with a cash box (type `cash`, not main, named "مندوب – <name>", created by `boxes.createBoxAccount`) and a customer account (`Customer.isCourier`, `courierId`). A courier with open orders (out for delivery), a non-zero box balance or a non-zero customer balance cannot be deactivated.
2. **The invoice is made when the order leaves with the courier**: a credit sale on the courier's customer account, same lines at the order's snapshot prices, the delivery fee as `shippingFees`. Stock and posting are the credit sale's own.
3. **Delivered** = a customer payment on the courier's account into the courier's box.
4. **Hand in cash** = the ordinary transfer from the courier's box to the main box. The courier page only opens the existing transfer dialog pre-filled. No new money logic.
5. **Refused / partly refused** = a return on that credit sale (full or by line), then the payment for what was collected. A full return gives the delivery fee back by the existing full-return rule; a partial one keeps it.
6. **Reservation without touching selling logic.** Reserved = Σ quantities in `confirmed` and `preparing` orders, computed from `WebOrder` (index `{status, items.productId}`), never stored on the product. Used by the website (availability, `maxOrderQty`, the placement check), by confirm and edit (`inventoryCount − reserved by other orders`) and by the admin product list/detail ("محجوز لطلبات الموقع: N", only when N > 0). The POS, credit sales and purchases do not read it.
7. **Editing** while `new` / `confirmed` / `preparing`: quantities, lines (any non-archived product), zone / fee, contact. Old lines keep their snapshot price, added lines take the current one, totals are recomputed by the server, every edit is a history entry (who, when, what).
8. **Notifications.** Everyone with `orders.view` gets the sidebar badge (new orders) and a short sound when it goes up; `GET /api/orders/summary` is polled every 20 s only while the tab is visible; the sound can be muted per device (localStorage); a blocked audio context is handled silently. Phone notifications come with the PWA (Stage 6).
9. **Delivery fee VAT** is the existing shipping rule. `priceWebOrder` now passes the fee to `computeSaleVat` as `shippingFees`, so the order total is the invoice total to the piastre in all three VAT modes.

### What was built
- **Backend.** `src/services/webOrders.service.js` holds every transition (confirm, reject, prepare, cancel, edit, dispatch, deliver, refuse). Each one is one transaction; the first write is a conditional update on the expected status (a second click answers 409 `INVALID_STATUS` and creates nothing). The order stores `courierId`, `creditSaleId`, `paymentIds`, `returnIds`, `collectedAmount`; the credit sale's notes carry the order number. Routes: `/api/orders` (list with status / dates / search / courier filters and per-status counts, `summary`, `delivery-zones`, detail, the actions), `/api/couriers`, `/api/website/customers` (search, deactivate, reset password: a temporary password shown once, `tokenVersion + 1`).
- **Documents go through the existing functions.** Dispatch calls `createCreditSaleInTransaction`, delivery calls `addCreditSalePaymentInTransaction`, a return calls `refundCreditSaleInTransaction`, all from `creditSale.controller.js`. They read `req`/`res`, so the service hands them a request-shaped object (the dispatching user, so `canSellBelowCost`, audit and permissions are the user's) and a tiny `res` that records the status code they set before throwing. Changes to that file: the two functions and the new third one are exported; the body of the refund handler became the named `refundCreditSaleInTransaction` (a pure move, same order of operations); `addCreditSalePaymentInTransaction` takes an optional fourth argument `{ box }` (see below). Pricing and posting code is untouched.
- **Permissions** `orders.view`, `orders.manage`, `orders.dispatch` (group "website"): owner and manager all, cashier all three, others none. Dispatch also needs `credit.create`, delivery `credit.collect`, refusal `returns.create` (and delivery with returned lines `returns.create`), checked as every route checks permissions. Couriers: write needs `website.manage` + `customers.manage`, read `orders.view` or `website.manage`.
- **Website (customer) views.** The new statuses show on the order pages and tracking; `refused` shows as `cancelled`; staff edits, notes and names never reach the customer (`publicHistory`).
- **Admin app.** Sidebar: "الطلبات" (with the badge), "المناديب", "عملاء الموقع". Pages: orders list (tabs with counts, search, dates, courier filter), order page (contact with copy and WhatsApp, lines with stock and reserved-by-others, totals, history, actions by status and permission, edit mode, send out, delivered with returns showing the amount to collect), couriers list and courier page, website customers, delivery note (إذن تسليم, 80 mm and A4), reserved quantity on the product list and form, sound mute toggle.

### Decisions taken while building (not in the brief)
- **A cashier could not pay into a courier's box**: `resolveBox` → `assertBoxAllowed` refuses a non-`cashbox.manage` user any non-main cash box that is not their device's drawer. The payment function got the optional `{ box }` argument (default behaviour identical); the order service resolves the courier's box itself and checks it is active.
- **Courier boxes have shifts off.** The box-creation handler defaults a cash box to shifts on, which would demand an open shift for every delivery payment (`NO_OPEN_SHIFT`).
- **Dispatch passes `expectedTotal: order.total`.** If VAT settings changed after the order was placed, dispatch is refused with the credit sale's own 409 `TOTAL_CHANGED`; staff edit the order (totals are recomputed) and send it out again.
- **A courier's phone is the unique key of `Customer`**: a courier phone that already belongs to another customer is refused (409 `PHONE_IN_USE`).
- **Collecting less than due**: `collectedAmount` may be lower than the invoice balance; the difference stays as the courier's debt (which blocks deactivation). Returning every unit while "delivered" answers 400 `USE_REFUSE`.
- **No migration.** The indexes are in the schemas, so "latest migration = 12" assertions are unchanged.
- **Tests changed because of this stage:** `test/permissions.test.js` (catalog, cashier template, `EXPECTED_ROUTES`), `test/stage13.test.js` (owner has 49 permissions, was 46), `test/online-stage3.test.js` (the VAT comparison sale now carries the delivery fee as `shippingFees` and compares the whole total: decision 9), and the frontend nav / sidebar / fixtures specs (the new items and permissions).

### Not in this stage
The storefront app (Stage 5), the PWA and phone notifications (Stage 6), SMS/OTP and self-service password reset (not planned), the "forgot your password? contact the shop" text on the login page (Stage 5 builds the page).

## Stage 5A — align the website backend and settings with the design

Backend and admin app only; no storefront UI (Stage 5B builds the storefront app from the designs). Brief: `docs/stages/ONLINE_STAGE_5A.md`.

### Decisions (made in the brief)
1. **Pickup from the shop.** Setting `fulfillment {delivery, pickup}` (at least one on). A pickup order has no zone, delivery fee 0 and an optional address. Statuses `new → confirmed → preparing → ready_for_pickup → picked_up`, and `ready_for_pickup → cancelled` (reason required) when the customer never comes. `ready_for_pickup` reserves stock like `confirmed` / `preparing`. **Picked up = a cash sale** (the POS's own function) with the order's snapshot prices: cash on pickup into the box the staff member chose (`resolveBox`, their device's box by default), a wallet order into the wallet's box.
2. **Wallet transfers (InstaPay, Vodafone Cash).** `payments.cod / instapay {enabled, address, boxId} / vodafoneCash {enabled, number, boxId}`; `boxId` must be an active wallet or bank box; at least one method on; card is shown as "قريبًا" only. `paymentMethod` is `cod | instapay | vodafone_cash`. Staff press "تأكيد استلام التحويل" (optional reference): `payment {status unpaid|verified, verifiedAt, verifiedBy, reference}`. **Verifying posts nothing**: the money is posted when the invoice is created. Delivery + wallet: at send-out a **cash sale** (not a credit sale on the courier) into the wallet's box with the delivery fee as `shippingFees`; the courier collects nothing; "delivered" only changes the status; send-out is refused until verified. Pickup + wallet: the cash sale at pickup, refused until verified. A refusal or returned lines after a wallet sale are the existing cash-sale return, refunded from the box the sale went into. A verified order cancelled before any invoice posted nothing, so nothing is reversed (the refund to the customer happens outside Nota; the cancel reason records it). Cash on delivery + delivery is exactly Stage 4.
3. **Stock on the website.** `stock.showOutOfStock` (default true: shown as "out_of_stock" and not orderable; false: hidden, including products whose whole stock is reserved) and `stock.showRemaining {enabled (true), threshold (5)}`: a public product carries `remaining` when the AVAILABLE stock (inventory − reserved) is between 1 and the threshold.
4. **Which products show.** `productVisibility: "marked" | "all"` (default marked). `website.visible` (boolean) on products and categories is replaced by `website.visibility: "show" | "hide" | unset`. "marked" shows only "show"; "all" shows everything except "hide"; archived products and hidden categories never show. **Migration 13**: `visible: true → "show"`; `false` and missing → unset (migration 12 wrote `false` for everything, so it carries no choice); the old field is removed. The admin API refuses the old `visible` key (400).
5. **Other settings.** Look: `brandColor` (one of six presets), `websiteLogo` (falls back to the shop logo), `announcement {enabled, text ≤ 160}`, banners max 5 with a "حتى ٣ مستحسن" hint. General: `seoDescription` (≤ 300), `openingHours`. Delivery: `sameDayCutoff` ("HH:mm", information only). `highlights` (≤ 3, icons delivery / cash / exchange / shield / clock / star; three built from the settings when empty). Orders: `whatsappConfirmTemplate` with `{الاسم} {رقم الطلب} {الإجمالي} {مدة التوصيل}`; the order page's "ابعت تأكيد على واتساب" opens `https://wa.me/<phone>?text=<filled template>` in a new tab (no WhatsApp API). Disabled "قريبًا": website price list, automatic order acceptance, card payment. No subdomain field.
6. **Public data for the design.** `code` of a visible product, `specifications` (label / value strings only), `badges` (`discount`, `new` = created in the last 14 days, `out_of_stock`), `GET /api/store/products/:id/related` (up to 8 visible products of the same category, in stock first), sort `bestselling` (never exposing the count), category `image`, and the public settings the design needs.

### What was built
- **Backend.** `WebOrder` gets `fulfillment`, `paymentMethod` (3 values), `payment {status, verifiedAt, verifiedBy, verifiedByName, reference, boxId}` and `cashSaleId`; `zone` and `contact.address` are required only for delivery; a missing field on an old order means delivery / cash on delivery (read through helpers, no data migration). Every transition keeps the Stage 4 pattern (one transaction, the conditional status update first, 409 `INVALID_STATUS`); the guard also carries the fulfillment (`{$ne: "pickup"}` for delivery so old orders match). New service functions `markReady`, `verifyPayment`, `pickup`; `dispatch`, `deliver`, `refuse`, `cancel` and `edit` are fulfillment- and payment-aware. Routes `POST /api/orders/:id/ready`, `/verify-payment`, `/pickup`; the order list filters `fulfillment`, `paymentMethod`, `payment`, `needsTransfer`; the detail view carries `fulfillment`, `payment`, `invoice` (the one credit or cash sale), the WhatsApp template and the zone's delivery time. Placement takes `fulfillment` and `paymentMethod`, refuses a disabled option (409 `FULFILLMENT_UNAVAILABLE` / `PAYMENT_UNAVAILABLE`), and the idempotency hash includes the two fields only when they are not the defaults (a Stage 3 request keeps its hash). The public API is still built field by field in `src/store/whitelist.js`; `src/store/catalog.js` holds the visibility modes, the out-of-stock rule (counting reservations) and the effective settings (documented defaults for a settings document saved before this stage).
- **The cash sale and its return are the existing functions.** `createSelling`'s transaction body became `createCashSaleInTransaction(req, res, session)` and `addSellingRefund`'s became `refundSellingInTransaction(req, res, session)` in `selling.controller.js`, both exported: a pure move (same order of operations; the handlers call them), the way Stage 4 did for the credit-sale refund. `createSellingInvoice` alone only builds the document; the box, number, audit, posting, VAT event and auto-restock live in the handler's transaction, so calling it alone would have made an unposted sale. The order service calls them through the Stage 4 request-shaped object, with `expectedTotal: order.total`, so the invoice total IS the order total (or nothing is created: 409 `TOTAL_CHANGED`).
- **Admin app.** The website settings page is rebuilt in five tabs (عام / الشكل / التوصيل / الدفع / المنتجات والطلبات) with a side preview (brand color, announcement, logo), "افتح الموقع", the site status pill and the "قريبًا" items; the delivery zones live in the التوصيل tab (the API is unchanged; the separate page and its sidebar item are gone, the old URL redirects to the settings). The order page has the pickup actions (جاهز للاستلام, اتسلّم للعميل with the box choice for cash), "تأكيد استلام التحويل", method / transfer badges, the WhatsApp confirmation button and the right actions per fulfillment and payment. The orders list has fulfillment and payment columns and filters, and "محتاج تأكيد تحويل". The product form and the category dialog follow the mode ("marked": "إظهار على الموقع"; "all": "إخفاء من الموقع"). i18n ar / en have the same keys.

### Decisions taken while building (not in the brief)
- **Wallet box at verification.** The order stores `payment.boxId` = the box configured for the method when the transfer is verified, and the invoice goes there, so a later settings change cannot move a sale. A return uses the sale's own `boxId`.
- **Edit after verification.** An edit that changes the total of a verified order is refused (409 `PAYMENT_VERIFIED`: the customer paid the old amount); contact-only edits are fine; staff cancel and refund outside Nota.
- **Permissions of the document.** `dispatch` and `deliver` are `orders.dispatch` on the route plus a service check by payment (cash on delivery: `credit.create` / `credit.collect`; wallet: `sales.create`, nothing to collect); `pickup` is `orders.dispatch + sales.create`; `ready` and `verify-payment` are `orders.manage`; `refuse` stays `orders.dispatch + returns.create` for both.
- **Public settings.** `paymentMethods` stays an array of method keys (now the enabled ones) and the transfer details are `paymentDetails {instapay: {address}, vodafoneCash: {number}}`, never a box id. The fields Stage 3 already exposed (min order, free delivery, policies, social links) stay, because Stage 3 tests and the storefront rely on them; `sameDayCutoff` is public because the brief says it is shown on the website. Category `image` is the same URL as `imageUrl`.
- **Brand color presets** (review fix): the design's six, in order, `#0E4D45 أخضر نوتة` (the default), `#7C2D12 بني`, `#3F3F46 رمادي غامق`, `#14532D أخضر زرعي`, `#831843 نبيتي`, `#4C1D95 بنفسجي` (`BRAND_COLORS` in `websiteSettings.model.js` and `website.models.ts`; the settings page labels them with the Arabic names; an unset color is public as the default).
- **A website order never touches shop customers** (review fix). The cash sale of an order is a walk-in sale: the order service passes neither name nor phone, and `createSellingInvoice` takes two options that only the service sets (`walkIn`, `sourceRef`, never read from a request body): no customer is looked up, created or renamed (`ensureCustomerExistsForSelling` is unchanged), the sale's customer label is "عميل الموقع", and the new optional `Selling.sourceRef` ("طلب موقع W-000001", not read by pricing or posting) links it to the order and is shown on the sale (`toSellingInvoice`).
- **Customer cancel** (review fix): a customer cannot cancel their own order once the transfer is verified (409 `PAYMENT_VERIFIED`, "contact the shop").
- **Tests changed because of this stage:** every test that read `website.visible`; `stage16`, `stage18`, `stage19`, `stage21-review` and `stage23` ("latest migration" 12 → 13); the Stage 3 public-whitelist test (`code` and `specifications` are public now, and the exact product / tracking key lists); `test/permissions.test.js` (`EXPECTED_ROUTES`); the frontend nav / sidenav specs (the removed item) and the order specs' fixtures.

### Not in this stage
The storefront app (Stage 5B), the PWA and phone notifications (Stage 6), card payment, automatic order acceptance and a website price list (shown as "قريبًا"), a WhatsApp API.

## Stage 5B — the storefront app

A separate Angular 20 app `nota-storefront/` (server-side rendered with `@angular/ssr`, plain components, no PrimeNG / Material), the admin app moved to `/admin/`, one new backend endpoint, and the deploy changes for two services. Brief: `docs/stages/ONLINE_STAGE_5B.md`. Designs (source of truth for the look): `WebHome.dc.html`, `WebProduct.dc.html`, `WebCheckout.dc.html`, found in `docs/design/` (the brief says `docs/design/screens/`; they were not there when this stage was built).

### Decisions (made in the brief)
1. **Arabic only, RTL**, every text in `src/app/core/i18n/ar.ts` (no language switcher; English later is another file with the same shape). Alexandria bundled locally from `@fontsource-variable/alexandria`. The brand colour is the public `brandColor`, set as the CSS variable `--brand` on the app root (the tints are derived with `color-mix`, because the designs hard-code them for the default green only).
2. **URLs:** `/`, `/c/:id/:slug`, `/search?q=`, `/p/:id/:slug`, `/cart`, `/checkout`, `/order/:token`, `/login`, `/register`, `/account` (orders, order detail, addresses, profile), `/policies/returns`, `/policies/terms`, `/delivery`, 404. A wrong or missing slug is a real 301. `/admin/` is the admin app, `/api/` the backend.
3. **Cart in the browser only** (localStorage, `nota.store.cart`: product id, quantity and the last-seen name / price / image for display); the checkout always sends ids and quantities. The server's 409 `ORDER_ITEMS_INVALID` lines are shown on the lines with a fix action ("خليها N" / "حذف"). **One idempotency key per checkout attempt**, kept in localStorage until an order succeeds.
4. **`POST /api/store/orders/quote`** (the only backend change): the same body as placing, no idempotency key and no contact needed, creates nothing, returns the same totals (`publicQuote`) and the same business errors / line problems as placing.
5. **Signed-in customers:** phone + password, the token in localStorage sent as a Bearer header (never read on the server), saved addresses in the checkout, order history, cancel.
6. **After placing**, `/order/:token` shows the number, status, totals; for wallet payments the transfer instructions (InstaPay address / Vodafone number from `paymentDetails`, the exact amount, the order number) and a WhatsApp button for the screenshot; for cash on delivery / pickup what happens next.
7. **Closed website:** the closed page (shop logo + `closedMessage`) with HTTP **503** and `X-Nota-Closed: 1`. **Ordering off:** browsing works, every add-to-cart / checkout button is disabled with the message.
8. **SEO:** server-rendered home, category, product, policies and delivery; per-page title and description, Open Graph (product image), JSON-LD `Product` (EGP, availability), canonical, `/sitemap.xml` (home, categories, every product; closed website: 503) and `/robots.txt` (disallow `/cart /checkout /account /order/ /admin/`) from the storefront server using the public API. The visitor's own pages are `noindex` and `no-store`.

### What was built
- **Backend.** `storeOrder.controller.js`: `readOrderRequest(body, customer, {quote})` and `buildOrder` split into `validateAndPrice` (scope, fulfillment, payment, zone, lines, pricing, minimum order; writes nothing) + the persisting part; `quoteOrder` uses only the first. `placeOrder` is unchanged in behaviour (its tests are untouched). `whitelist.publicQuote`. Route `POST /api/store/orders/quote` (optional customer, after the closed-website gate). `test/online-stage5b.test.js` (10 tests).
- **Storefront.** `nota-storefront/`: `src/server.ts` (Express: `/health`, `/robots.txt`, `/sitemap.xml`, slug 301s, noindex headers for private paths, static files with a one-year cache for hashed files, SIGTERM drain, a last-resort 503 page), `src/server/` (`api-client.ts` internal fetch client with timeout, one retry and a cache; `slug-redirect.ts`; `seo-files.ts`), `src/app/core/` (API, settings, cart, auth, checkout, SEO, page status, slug, formats, translations, route resolvers), `src/app/layout|ui|pages/`. Every page is a lazy route; cart, checkout, order, login, register and account are client-rendered.
- **Server side rendering.** The browser calls `/api/store`; the server calls `NOTA_API_INTERNAL` (default `http://127.0.0.1:5000`) with a 3 s timeout. Settings, categories and zones are cached 30 s in memory, product lists 15 s, the sitemap 10 min; errors are never cached. An API 404 is a real 404 page; an API that does not answer is a 503 page (no stack trace, the process stays up); data reaches the browser through `TransferState`, so the first render does not fetch twice. The settings are loaded by an app initializer before the first render.
- **Admin app.** New build configuration `admin` (`baseHref: /admin/`); `make-release.js` builds it into `dist/nota-admin`. Audited: `index.html` base, i18n files (`./assets/i18n/`), fonts and the print iframe (`document.baseURI`, `srcdoc`) are base-relative; `/api/` stays absolute; nothing else needed changing. The plain `production` configuration (offline app) is unchanged and stays at `/`.
- **Deploy.** `nota-storefront.service` (same hardening as the backend, `TimeoutStopSec=20`); `/etc/nota/storefront.env` (port 4000, `NOTA_API_INTERNAL`, `NOTA_PUBLIC_URL`); nginx: `/api/` + `/health` → backend, `/admin/` → static files with the SPA fallback to `/admin/index.html` and the same caching rules, everything else → the storefront with a one-year cache for its hashed files; a separate rate-limit zone `nota_store_quote` (60 requests a minute per IP, burst 20); an access-log format that masks `/order/<token>` and `/api/store/orders/track/<token>` and has no Referer. `make-release.js` packs `frontend/admin/` and `storefront/` (server + browser, no `node_modules`: the SSR bundle includes its dependencies). `update.sh` checks the release layout and that `setup-server.sh` was re-run (unit + nginx `/admin/`) before touching anything, restarts both services, waits for the backend `/health`, then the storefront `/health` and `GET /` (200 or the closed page), and rolls both back on any failure. `setup-server.sh` installs the unit and the env file. `docs/deploy/NEW_SERVER_AR.md` and `UPDATE_AR.md` updated (the admin app is at `https://<domain>/admin/`).

### Decisions taken while building (not in the brief)
- **The quote's own rate limit.** The quote is called on every cart / zone / payment change, so it has its own zone (60 requests a minute) instead of sharing the order zone's 10 a minute. Node tests cannot run nginx, so the test reads the template.
- **A closed website answers 503**, not 200, so it is not indexed; `update.sh` accepts it by the `X-Nota-Closed` header. A 503 without that header means the storefront cannot reach the backend and fails the update.
- **Real 301s come from Express**, not from Angular's router (it can only redirect with 302 while rendering). Categories have no slug in the API, so the storefront builds theirs with a copy of the backend `storeSlug` (a spec pins the same results as the backend for eight names).
- **Host validation.** This Angular version does not treat `*` as a wildcard in `allowedHosts`, and refuses (or renders client-side) a Host it does not know, so the server lists `localhost`, `127.0.0.1`, the host of `NOTA_PUBLIC_URL` and `NOTA_STOREFRONT_HOSTS`; it trusts `X-Forwarded-For` / `-Proto` (nginx sets them) and not `-Host`.
- **Server fetch outside the Angular zone.** Node's `fetch` keeps its socket alive with a ~3 s timer; created inside the zone it held every uncached server render for 3 s. The API service calls `fetch` through `NgZone.runOutsideAngular` (the resolvers and the initializer still await the data).
- **The "offers" list** is the discounted products among the newest 24 (the API has no offers filter); **"الأكثر طلبًا"** uses `sort=bestselling`; the **landmark** field is joined into the address (`شارع - علامة مميزة: …`) because the order has no landmark field; related products use the existing `/products/:id/related`.
- **The tracking token** is in the URL of `/order/:token`: the page sends `Referrer-Policy: no-referrer` and `no-store`, and nginx does not log it.
- **No runtime packages on the server:** the SSR bundle (`server.mjs` + chunks) imports only Node built-ins, so `update.sh` has no `npm ci` step for the storefront.

### Measured locally
Lighthouse 12, mobile, production build behind a local stand-in for nginx (gzip, long cache for hashed files), seed data of three products: **home performance 95 / accessibility 100 / best practices 100 / SEO 100; product page 95 / 100 / 100 / 100** (FCP 2.3 s, LCP 2.4 s, TBT 20-50 ms, CLS ≤ 0.02 on Lighthouse's simulated slow 4G). Real numbers on the server depend on its network and on real product photos.

### Not in this stage
The PWA and phone notifications (Stage 6), English, card payment, automatic order acceptance, a website price list, product variants / reviews / coupons (none exist in the data), a WhatsApp API.

## Stage 6A — the admin app on the phone (PWA shell, push, core screens)

### Decisions (made in the brief)
1. **One app, two layouts.** Below 768 px (`LayoutService`, the same media query as the CSS) the admin app uses the phone shell; at 768 px and above nothing changes. Every rule, API call, permission and validation is the existing one.
2. **PWA:** manifest for `/admin/` (standalone, RTL, theme `#0E4D45`), a service worker that caches the app shell and static files only, update prompt, install hint (Android button / iOS steps, dismissible), offline banner, no offline queue.
3. **Push** for new website orders (Web Push, VAPID, `web-push`): title `طلب جديد #<number>`, body total + delivery/pickup, no personal data. Sent after the order commits, fire-and-forget.
4. **Core screens:** home, POS, orders + order page, stock + product form, customers + add/edit, المزيد. Every other page opens inside the phone shell (6B converts them).

### What was built
- **Backend.** Model `PushSubscription` (user, deviceId, endpoint unique, keys, userAgent, lastSuccessAt). Routes (any signed-in user, own rows only): `GET /api/push/public-key`, `POST /api/push/subscribe`, `DELETE /api/push/subscribe`. `src/push/pushService.js`: reads `NOTA_VAPID_PUBLIC_KEY` / `NOTA_VAPID_PRIVATE_KEY` / `NOTA_VAPID_SUBJECT`, loads `web-push` lazily, takes the recipients at send time (active user AND `orders.view` right now), deletes a subscription on 404/410, has an injectable sender for tests. `placeOrder` calls it only when the order was newly created, after `withTransaction` returned, without `await`. One read-only endpoint `GET /api/dashboard/mobile-summary` (signed-in; each block filtered inside): `today.total` (`dashboard.view`), `today.website` / `today.shop` (also `orders.view`; website = invoices linked from website orders, dated today), `cashDrawer` (`cashbox.view`). Tests: `test/online-stage6a.test.js`; the route table in `permissions.test.js`.
- **Frontend.** `@angular/service-worker` configured by hand (`ngsw-config.json`, no `dataGroups`, so `/api` is never cached; `provideServiceWorker` is off in dev builds), `public/manifest.webmanifest`, icons generated from `docs/design/brand/png` (192, 512, maskable 512, apple-touch 180). `core/layout`, `core/pwa` (update, install hint, online, push), `modules/mobile` (shell, tab bar, المزيد, home, push toggle, utils), `styles/_mobile.scss`. The phone versions of the screens are template blocks inside the existing components (`@if (layout.isMobile())`), so forms, services, guards and totals are the same code; the desktop markup sits in the `@else` unchanged. Dialogs are bottom sheets on the phone (CSS).
- **Deploy.** `ensure_vapid` in `nota-lib.sh`, called by `update.sh` (keys generated once when missing, kept in `/etc/nota/backend.env`); nginx exact-match locations so `ngsw-worker.js`, `ngsw.json` and `manifest.webmanifest` are never served from a cache. Arabic guide: `docs/deploy/PHONE_APP_AR.md`.

### Decisions taken while building (not in the brief)
- **Push click** uses the Angular service worker's notification envelope (`onActionClick` → `navigateLastFocusedOrOpen`) instead of a hand-written worker. If a real phone does not focus the open app reliably, the fallback is a small wrapper worker.
- **Subscriptions move with the browser:** the same endpoint signing in as another user re-assigns the row, so a shared phone never notifies the previous user.
- **Website-vs-shop split:** `Selling` / `CreditSale` have no source field, so the split is computed through `WebOrder.cashSaleId` / `creditSaleId`. No field was added.
- **MobPos is the real POS form**, with the invoice panel as a bottom sheet (CSS + a bar), so the totals, payment box, discount limits and VAT are the desktop ones by construction.
- **MobAddCustomer** is the existing customer dialog shown as a bottom sheet (the customer form has no page route and only name, phone, tax number).
- **Karma's window is narrower than 768 px**, so `test-setup.spec.ts` now answers the phone breakpoint with "not mobile" for every spec that does not provide its own `LayoutService`.

### Not in this stage
Barcode scanning with the camera, an offline queue, printer setup on the phone, the remaining screens in the phone design (6B), the invoice number in the POS header (it exists only after saving), a second phone / credit limit on customers (not in the backend).

## Stage 6B — every remaining admin screen on the phone

### Decisions (made in the brief)
1. **Same pattern as 6A.** Each remaining admin screen gets a phone layout as a template block inside the existing component (`@if (layout.isMobile()) { … } @else { <desktop markup, byte for byte> }`), over the same services, forms, guards, permissions, validations and totals. No backend change. Desktop (768 px and up) is unchanged.
2. **Phone rules** (set by review, applied to every group): the top bar shows the page title (no in-page title or breadcrumb); the whole list card opens the item, edit and delete live in the ⋯ menu and delete asks in a red confirm sheet; money as `٢٥ ج.م`; Arabic dates (`mobDate`) and the native date/month input on the phone; a native text number input (`nota-mob-number`, Arabic and English digits, same min/max/decimals) in place of the PrimeNG number inputs; a sheet that submits stays open while saving and closes only on success, with errors inside it and the values kept; forms are full pages with a fixed إلغاء / حفظ bar, switches instead of checkboxes and the tab bar hidden; tables become cards, except the financial reports, which scroll inside their card with a sticky first column.
3. **Built and reviewed in groups:** A shared pieces, B sales, C stock, D cash, E accounting, F website and admin.

### What was built
- **Shared (`modules/mobile`).** `MobSheetComponent`, `MobFilterSheetComponent` + `MobFilterChipsComponent`, `MobConfirmComponent`, `MobBarComponent` (form bar), `MobileTopBarService` (title, subtitle, back, hide tabs; cleared on every navigation), `mobile-parent` (back goes to the logical parent when the page was opened directly), `mobDate` pipe, `nota-mob-date`, `nota-mob-number`. About 200 `m-*` rules appended to `styles/_mobile.scss`, all under the phone query.
- **Screens.** B: customer details, credit sales list and new credit sale, invoice history (+ detail sheet), returns. C: products list with the category tools, profit report, purchases (list, form, detail, return sheet), suppliers (list, form, payment, statement). D: cash box list, box detail with the shift panel and dialogs, expenses. E: accounts + account dialog, ledger, journal, journal entry, manual entry, opening wizard, closing, VAT, financial reports. F: website settings (sections as chips, preview in a sheet), delivery zones, couriers and the courier page, website customers (deactivate and reset password as short sheets), the order page's edit mode (steppers, add-product sheet, remove, save), users (cards, ⋯ menu, full-page form with permission groups as switches), shop profile (cards, VAT and closing as switches/chips, invoice preview as a sheet), the product and category website sections, the VAT and closing dialogs' field styling, and a login/no-access check.
- **Tooling (not in the build).** `scripts/mobile-audit.mjs` (every route at 390 and 1280: page-level horizontal scroll, clipping outside 0…innerWidth with `.mob-hscroll, .m-chips, .m-scroll` exempt, edge-hugging under 8 px as a warning, console errors, tab bar present/absent, viewport and full-page shots), `scripts/mobile-audit-seed.mjs` (seeds through the public API only), `scripts/mobile-shot.mjs`, `scripts/verify-desktop-markup.mjs` (proves the `@else` branch of every converted template equals the pre-6B template; collapses the small inline phone branches of three files). `playwright-core` is a devDependency of `nota-frontend`; `mobile-audit/` is git-ignored.
- **Specs.** `mobile-parent`, `mob-sheet`, `mob-topbar-date`, `mob-date-input`, `mob-number-input`, `sheets-submit`, and `group-b/c/d/e/f-phone` (actions per permission, filter sheets, manual-entry totals and the balanced-only post rule, credit-sale and purchase totals equal to the desktop ones, category delete rule, sheets that stay open on error, website sections as switches).

### Decisions taken while building (not in the brief)
- **No `Mob*.dc.html` design files exist in the repo** (only the desktop designs), so each phone screen follows the 6A spec and patterns, with the desktop design for content. Review the screenshots before treating the visuals as final.
- **Category delete** on the phone follows the desktop rule: `CategoryToolsComponent` got an `openCategoryId` input, so the phone list can open the same delete flow.
- **Order edit mode:** the 6A header condition `!layout.isMobile() || editing()` became `!layout.isMobile()`, because the phone now has its own edit layout. The desktop result is the same.
- **Print:** prints that need the desktop print settings say so on the phone; nothing about printing changed.
- **The 1280 reference is the pre-6B code (`ae9deb30`) served against the same audit data**, not a screenshot from an earlier run.

### Design fields the phone design asks for that the backend does not have
None added. No Mob design file exists to compare against; the two known cases are from 6A (a second phone and a credit limit on customers).

### Design texts that contradict Nota's rules
None found, for the same reason. Where a phone text was written it follows the code (credit-sale and return hints, the shift close text, the website customer one-time password).

### Verification
Admin `ng test` 934 of 934; admin production build (`--configuration admin`) passes (the `exceljs` ESM warning was already there); `scripts/verify-desktop-markup.mjs` 48 templates, 0 differing; the audit ran 85 route/size checks with 0 failing and 1 warning (below); at 1280, 41 of 43 routes are pixel-identical to the pre-6B reference and the other two (`/audit`, `/users`) differ only by the sign-in rows the audit run itself created. Backend `npm test` 492 of 492 (nothing skipped); storefront `ng test` 53 of 53.

### Noticed, not done
- `/selling` (6A) has an edge-hugging warning at 390 (the POS header and chips start at the screen edge). Not part of 6B.
- `categories/:id` is a redirect to `/products?category=<id>`, not a page.
- The nav config is missing a line break before `],` after the website-settings and shop items (cosmetic).
- `docs/stages/ONLINE_STAGE_6B.md` is untracked in git.
- Printing a shift or a statement from a phone still depends on the desktop print settings.

## Help center (المساعدة)

A help page inside the admin app that explains every page, dialog, action, status, blocking rule and accounting effect in Egyptian Arabic, for a shop owner or cashier with no technical or accounting background. Frontend only: no backend or storefront change. Brief: `docs/stages/ONLINE_STAGE_HELP.md`.

### Decisions (made in the brief)
1. **Route `/help` and `/help/:section`**, any signed-in user (`authGuard`), the sidebar ("المساعدة") and the phone's المزيد page. On the phone the sections are a card list and a section is a full page.
2. **Contextual "؟"**: opens the current page's section without leaving it (desktop side panel, phone full page). Every route maps to a section.
3. **Search** over titles, keywords and text with Arabic normalization (أ/إ/آ/ٱ → ا، ة → ه، ى → ي، tashkeel U+064B–065F and U+0670 and tatweel removed, Arabic-Indic and Eastern digits → ASCII). Results show the section and the matching paragraph with the matches highlighted.
4. **Permissions**: by default only the sections whose rule the user passes; "عرض كل الأقسام" shows the rest marked "محتاج صلاحية: <label>" (labels from the catalog).
5. **Arabic only** for now; the English UI shows the Arabic help (`lang="ar" dir="rtl"`) with a one-line note (`help.englishNote`).

### What was built
- **Content** `nota-frontend/src/app/help/content/ar/*.ts`: 31 sections, one TS object each (`HelpSection { id, title, summary, kind: page|guide, routes, permissions, keywords, related, blocks }`), listed in reading order by `content/ar/index.ts`. Block types: heading (with the ten fixed parts of a page section), paragraph, steps, bullets, tip, warning, behind (ورا الكواليس, with an optional example entry), fields, actions, statuses, blockers (ليه مش قادر؟), faq, table. Every rule, message, status label and accounting line was taken from the code (controllers, services, `accounting/posting.js`, the i18n files) at the time of writing.
- **Safe rendering**: text carries a tiny inline markup (`**bold**`, `[[/route|label]]`, `[[#section|label]]`) parsed by `inline-parse.ts` into tokens; templates render tokens with interpolation and `routerLink` only, never `innerHTML` (a spec renders `<img onerror>` / `<script>` text and checks no element is created).
- **Lazy**: all content and the search index are one lazy chunk (`help-data.ts`, ~640 kB raw / ~56 kB transfer), loaded by `HelpContentService` on first use; `/help` pages are `loadComponent` routes; the desktop panel is inside `@defer`. Admin build initial total 963.75 kB → 974.53 kB raw (231.14 → 236.31 kB transfer).
- **"؟" placement**: desktop, in the shell top bar (`side-nav.component.html`), so every framed page has it from one place (many pages have no `nota-page-header`); phone, in the shell's `m-top` for inner screens and in the headers of the five root screens (home, POS, orders, stock, المزيد). Route → section: `help-route-match.ts` (segment match, `:param` = any segment, most literal segments wins). The sidebar link sits in the sidebar footer (not in `NAV_GROUPS`, so the nav specs and the landing order are unchanged); المزيد has an "المساعدة" row; `mobile-parent` sends `/help/x` back to `/help`.
- **Permission catalog copy**: `scripts/export-help.mjs` writes `src/app/help/generated/permission-catalog.ts` from `nota-backend/src/auth/permissions.js` (the browser specs cannot read the backend). The permissions section's table is generated from it, with a plain-words line per key in `content/ar/users.ts` (`PERMISSION_HELP`).
- **Review export**: `node scripts/export-help.mjs` writes `docs/help/HELP_AR.md` (the whole help in section order) with the same `helpToMarkdown` the spec uses (bundled with esbuild); `--check` writes nothing and exits 1 when the catalog copy or the Markdown is stale.
- **Specs** (`src/app/help/*.spec.ts`): route coverage (walks `app.routes.ts`; excludes `login`, `no-access`, `ui-kit`, redirects), no stale or doubly-claimed routes, every page section has its parts, every catalog permission explained, every `related` id and in-content link resolves, normalization and search, the Markdown is up to date (imported as text through the karma `loader: { ".md": "text" }` in `angular.json` and `src/typings.d.ts`), and the screens (permission filter, show-all, desktop panel, phone full page, English note, safe rendering).

### Decisions taken while building (not in the brief)
- **"؟" in the shell bars, not in each page header** (see above). The desktop markup of the converted 6A/6B templates is unchanged (the phone-aware templates touched here, `orders-list` and the POS, are identical to HEAD with their phone branches removed; `scripts/verify-desktop-markup.mjs` cannot parse these two 6A templates and reports them as differing).
- **Reserved stock is not described as a POS blocker**: by design the POS, credit sales and purchases do not read reservations (Stage 4 decision 6); the help says so.
- **The audit page keeps its app label "سجل العمليات"** (the brief says "سجل المراجعة").
- **"Sign out everywhere"** is described as what exists (disable / reset / role change sign the user out on every device; changing your own password ends the other sessions); there is no separate button.

### Not in this stage
English content, screenshots or videos inside the help, in-page anchors per field.
