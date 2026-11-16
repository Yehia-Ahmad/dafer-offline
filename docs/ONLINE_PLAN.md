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
- **Brand color presets.** `docs/design/screens` has no `Web*.dc.html` / `Mob*.dc.html`, so the six presets are a PLACEHOLDER list (`BRAND_COLORS` in `websiteSettings.model.js` and `website.models.ts`) to be replaced by the design's values.
- **Tests changed because of this stage:** every test that read `website.visible`; `stage16`, `stage18`, `stage19`, `stage21-review` and `stage23` ("latest migration" 12 → 13); the Stage 3 public-whitelist test (`code` and `specifications` are public now, and the exact product / tracking key lists); `test/permissions.test.js` (`EXPECTED_ROUTES`); the frontend nav / sidenav specs (the removed item) and the order specs' fixtures.

### Not in this stage
The storefront app (Stage 5B), the PWA and phone notifications (Stage 6), card payment, automatic order acceptance and a website price list (shown as "قريبًا"), a WhatsApp API.
