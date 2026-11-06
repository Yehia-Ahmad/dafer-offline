# Offline Edition Plan

## Context
- This repo is a standalone offline edition: a generic product to be sold to many shops. It has no website, no mobile app, and no Firebase.
- The main PC runs a bundled MongoDB and the backend; other PCs connect to it over the shop LAN through Electron (electron-offline).
- Backend: Express + Mongoose (nota-backend). Frontend: Angular standalone components (nota-frontend).
- The full online edition lives in a different repo and must not be touched.

## General rules for every change
- Do not change any logic in selling, credit sales, returns, or inventory except lines that relate to the website or Firebase.
- No refactoring or side improvements. If you notice something worth fixing, list it at the end of your reply instead of fixing it.
- Every stage ends with: backend tests (npm test), npm run build:offline, npm run test:offline, npm run smoke:offline, npx ng test --watch=false --browsers=ChromeHeadless, and a grep review.
- Never commit. I commit after I review.

## Cleanup plan
1. Remove Firebase and push notifications. (done)
2. Remove website code from the backend. (done)
3. Remove website settings, add ShopProfile. (done)
4. Remove website code from the frontend. (done)
5. Remove leftovers: old non-offline build files, unused assets, unused stubs, unused i18n keys.
6. Branding: the product is now Nota / نوتة. The old name and logo were replaced everywhere, including internal identifiers (DB name `nota`, NOTA_* env vars, nota:* IPC channels, window.notaDesktop, X-Nota-Lan-Key header, backup file prefixes, firewall rule names, ProgramData folder, discovery/quit protocol strings, secret-store entropy, 'not-nota' state, backend health-check app name `nota-backend`). (done)

## Phase 2 — Nota design
Reference: docs/design/NOTA_DESIGN_SYSTEM.md and docs/design/screens/.
6. Branding: product name, icons and logos. (done)
7. Design foundation: color tokens, Alexandria font bundled locally, Material/PrimeNG/Tailwind theme, shared components.
8. App shell: grouped sidebar, header, user card.
9. Sales screens redesign.
10. Remaining screens redesign + dashboard.

Later phases (decisions below): Users & permissions (Stage 13 backend done; Stage 14 frontend + auth on done; Stage 15 auto-lock, protected backup, one main PC, session polish done), then Accounting.

## Agreed decisions for later phases (after cleanup)

### Users and permissions
- User model: name, username, bcrypt password, role, permissions list, isActive. Login issues a JWT; the secret is generated on the main PC and stored in secret-store.
- Fine-grained permissions (e.g. sales.cancel, products.viewCost). Roles are templates: owner, manager, cashier, storekeeper, accountant. The owner can edit anyone's permissions.
- Enforcement in the backend: a requirePermission middleware on every route. Purchase price and profit are stripped from responses for users without products.viewCost.
- Every /api route requires login, except login itself and /api/lan. No public routes.
- createdBy / updatedBy on every invoice and journal entry, plus an audit log for sensitive actions.
- The owner account is created in the main PC setup wizard, together with a recovery code.
- The "price below purchase price" error must not reveal the purchase price.

#### Stage 13 — users and permissions, backend (done)
Everything is behind the **`NOTA_AUTH` switch**. With `NOTA_AUTH=1` every rule below is enforced. Unset (or any other value), the backend behaves exactly as before: `/api/auth`, `/api/users` and `/api/audit` are not mounted (404), nothing is stripped, no token is needed, no createdBy is set and nothing is audited. Since Stage 14 the desktop app always sets `NOTA_AUTH=1` on the main PC.

- **Single source of truth:** `nota-backend/src/auth/permissions.js` (catalog with Arabic/English labels and groups, role templates, `permissionsForRole`, `effectivePermissions`, `hasPermission`).
  - **Catalog (27 keys):**
    - sales: `sales.create`, `sales.view`, `sales.edit`, `sales.delete`, `sales.discount`, `sales.priceBelowCost`
    - credit: `credit.create`, `credit.view`, `credit.edit`, `credit.delete`, `credit.collect`
    - returns: `returns.create`, `returns.view`
    - customers: `customers.view`, `customers.manage`
    - products: `products.view`, `products.manage`, `products.viewCost`, `products.syncPrice`, `products.importExport`, `categories.manage`
    - reports: `reports.profit`, `dashboard.view`
    - admin: `shop.manage`, `users.manage`, `audit.view`, `backup.manage` (Stage 15: checked by the Electron main process for every backup IPC call)
  - `sales.discount` and `sales.priceBelowCost` apply to cash **and** credit invoices.
  - `credit.collect` also covers `POST /api/customers/:id/payments`.
  - **Role templates:**
    - `owner`: everything, always, not editable.
    - `manager`: everything except `users.manage` and `backup.manage`.
    - `cashier`: sales.create, sales.view, credit.create, credit.view, credit.collect, returns.create, customers.view, products.view, dashboard.view.
    - `storekeeper`: products.view, products.manage, categories.manage, products.importExport, products.viewCost.
    - `accountant`: sales/credit/returns/customers/products/dashboard view, plus reports.profit, products.viewCost, credit.collect, audit.view.
    - `custom`: its own list.
  - **Edited roles:** a template role uses its template unless `permissionsEdited: true`, in which case the stored `permissions` list wins. Saving a list equal to the template, or changing only the role, sets it back to false.
- **Route → permission map:** `requirePermission(...)` sits on each route in `nota-backend/src/routes/*.js`. `test/permissions.test.js` walks the Express router and fails if any `/api` route has no permission, or if the map differs from `EXPECTED_ROUTES` there, which is the authoritative table. Summary:
  - `PUBLIC` (LAN key only): `/api/lan/info`, `/api/auth/bootstrap`, `/login`, `/setup-owner`, `/recover`.
  - `AUTHENTICATED` (any signed-in user): `/api/auth/me`, `/change-password`, `/permissions`, `GET /api/shop-profile`.
  - Categories: view → products.view; write → categories.manage; delete → categories.manage + products.manage (it deletes the category's products); export → products.importExport + products.viewCost; import → products.importExport + categories.manage.
  - Products: view and search → products.view; write → products.manage (Stage 14: create → products.manage + products.viewCost); Excel export → products.importExport + products.viewCost; the three profit routes → reports.profit + products.viewCost; sync-purchase-price → products.syncPrice.
  - Sellings → sales.view/create/edit/delete. Credit sales → credit.view/create/edit/delete, and `/:id/payments` → credit.collect.
  - Customers → customers.view/manage, and `/:id/payments` → credit.collect.
  - Returns → returns.view/create. Dashboard → dashboard.view. `PUT /api/shop-profile` → shop.manage. `/api/users/*` → users.manage. `/api/audit` → audit.view.
  - POST/PUT on sellings and credit sales also need `sales.discount` when they carry an invoice discount. The server applies a discount only from `discountAmount`; a sent `discountPercentage` is never used.
    - New invoice: any discount needs the permission.
    - Edit: checked against what the user controls.
      - Keeping the stored discount, or removing it (0), never needs it.
      - Stored percentage (legacy records: no `discountAmount`): a changed percentage needs it. With the same (or no) percentage, a sent `discountAmount` must equal that percentage of the new subtotal (a recomputed amount, e.g. after a quantity change), otherwise it needs the permission.
      - Stored amount: a different `discountAmount` needs it.
- **Auth endpoints (`/api/auth`):**
  - `bootstrap` returns `{hasOwner, shop:{name,logo}}`.
  - `setup-owner` works only while no user exists, otherwise 409 `OWNER_EXISTS`; the unique `one_owner` index makes this race-safe. It returns `{user, token, recoveryCode}`. The code is `XXXX-XXXX-XXXX-XXXX` without 0/O/1/I and only its bcrypt hash is stored.
  - `login` returns `{user, token, permissions}`. Unknown, wrong-password and disabled users all get the same 401 `INVALID_CREDENTIALS`.
  - `me`, `change-password` (raises `tokenVersion`, returns a new token) and `recover` (owner only; new password, raises `tokenVersion`, issues a new code).
  - `permissions` returns the catalog and role templates.
  - Errors: 401 `SESSION_EXPIRED`, 403 `FORBIDDEN`, 429 `LOGIN_LOCKED`, 400 `PASSWORD_INVALID`/`WRONG_PASSWORD`, 401 `INVALID_RECOVERY`.
- **Tokens:**
  - HS256 with `NOTA_JWT_SECRET` (at least 32 characters; startup fails without it), payload `{sub, tv}`, 12 hours, sent as `Authorization: Bearer`.
  - On every request the user is loaded. A missing or disabled user, or `tv !== tokenVersion`, gets 401 `SESSION_EXPIRED`.
- **Lockout:** 5 failed attempts for one username **from one IP** lock that (username, IP) pair for 5 minutes (429 `LOGIN_LOCKED`).
  - The same user can still sign in from another PC, so nobody on the LAN can lock the owner out of every PC.
  - Login and recover keep separate counters. A successful recovery clears that username's login locks on every IP.
  - **The counters are kept in memory** (`src/auth/loginLimiter.js`). That's enough for one main PC, but restarting the app clears them.
- **Passwords:** bcryptjs, cost 10, 6–128 characters, Arabic and spaces allowed. `toJSON` never returns `passwordHash`, `recoveryCodeHash` or `tokenVersion`.
- **Users (`/api/users`, users.manage):** list, get, create, `PUT` (name/role/permissions), `PATCH /:id/status`, `POST /:id/reset-password`. There is no DELETE; users are disabled instead. Rules and their error codes:
  - `OWNER_PROTECTED`: there's only ever one owner; nobody changes a role to or from owner; the owner can't be disabled; only the owner edits the owner.
  - `PERMISSION_NOT_HELD`: a non-owner can't grant a permission they don't hold.
  - `CANNOT_CHANGE_SELF`: nobody disables themselves, removes their own `users.manage`, or resets their own password through `/api/users` (use `/api/auth/change-password`, which needs the current password).
  - `USERNAME_TAKEN`: the username already exists.
  - Disable, reset, and role/permission changes raise `tokenVersion`, which logs the user out at once.
- **Cost stripping:** one response helper (`costStrip` in `src/auth/middleware.js`) removes `purchasePrice`, `profitAmount`, `totalProfit`, `profitValue` and `profit` from every JSON response for users without `products.viewCost`.
  - The dashboard and returns carry none of these fields.
  - `wholesalePrice` is a selling tier and stays visible.
- **Below cost:**
  - The message (`سعر البيع لا يمكن أن يكون أقل من سعر الشراء للمنتج <name>`) never contains the price, in cash or credit.
  - With auth off, everyone is blocked, as before. With auth on, users with `sales.priceBelowCost` may sell or edit below cost.
  - **Returns skip the rule** (credit; the cash return path never had it). A return keeps the original invoice prices and never sets new ones, so a cashier can partly return an invoice that was sold below cost. Before this change, credit returns re-checked the remaining items against the product's current cost, even with auth off.
- **createdBy / updatedBy** (plus `createdByName`/`updatedByName`): one Mongoose plugin (`src/auth/auditFields.plugin.js`) sets them from the signed-in user. It applies to Selling, CreditSale, each credit payment (created only), ReturnLog, Product, Category and Customer.
  - A stock-only save of a Product (from a sale or return) keeps its updatedBy.
  - They're shown in invoice responses when present.
- **Audit log:** `AuditLog` (`at` indexed newest-first, `userId`, `userName`, `action`, `entity`, `entityId`, `details`, `ip`).
  - **Actions:** `auth.login`, `auth.login_failed` (username only), `auth.locked`, `auth.setup_owner`, `auth.recover`, `auth.recover_failed`, `auth.password_changed`, `user.created`, `user.updated`, `user.status_changed`, `user.password_reset`, `sale.updated`, `sale.deleted`, `credit.updated`, `credit.deleted`, `credit.payment`, `return.created`, `product.deleted`, `product.sync_purchase_price`, `category.import`, `shop.updated`.
  - Details never hold passwords, hashes, tokens or codes.
  - `GET /api/audit` (audit.view) filters on `from`, `to`, `userId` and `action`, is paginated, and returns newest first.
- **Electron (main PC):** on the first start in main-PC mode, the app generates the session-token secret, stores it DPAPI-protected in `config.json` (`jwtSecretProtected`, separate entropy from the LAN secret), and passes it as `NOTA_JWT_SECRET` from then on. Client PCs don't need it.

**Stage 14 must** (all done in Stage 14; the invoice-edit item had nothing to attach to, see below).

#### Stage 14 — login, users page, permission-driven UI, auth on (done)
- **Backend:** `POST /api/auth/setup-owner` and `/recover` accept only loopback requests (`req.ip` 127.0.0.1, ::1, ::ffff:127.0.0.1; no `trust proxy`), otherwise 403 `LOCAL_ONLY` (`localOnly()` in `src/auth/middleware.js`). `GET /api/auth/bootstrap` adds `isLocal`. The main PC's own window calls the backend on `http://127.0.0.1:<port>` (main.js `beginRole`), client PCs on the LAN address.
- **Electron:** `buildBackendEnv` sets `NOTA_AUTH=1` (the user environment can't turn it off). `loadJwtSecret()` moved to `electron-offline/lib/jwt-secret.js` and throws; `main.js` shows the error screen `JWT_SECRET_UNREADABLE` and does not start mongod/backend without the secret. Tests: `electron-offline/test/jwt-secret.test.js`.
- **Session (frontend, `src/app/core/auth/`):** `AuthService` (signals `user`, `permissions`, `token`; `has`/`hasAll`/`hasAny`; `firstAllowedPath()`). Token in memory + `sessionStorage` (`nota.session`), never localStorage, no "remember me"; a reload keeps the session (checked with `/auth/me` before the first page), closing the window ends it.
- **Interceptor (`auth.interceptor.ts`, replaces the online edition's httpconfig/logout/request-online interceptors, all deleted):** Bearer on backend requests (the LAN key header is still added by Electron); 401 `SESSION_EXPIRED` → `/login?reason=expired&returnUrl=…`; 403 `FORBIDDEN` → toast with the server message; 429 `LOGIN_LOCKED` → toast with the minutes. Login-screen requests show their errors themselves (`HANDLES_OWN_ERRORS`). It resolves `TranslateService` lazily: the i18n files load through it.
- **Guards:** `authGuard`, `permissionGuard(rule)` (redirect to the first allowed page + one toast "مش عندك صلاحية تفتح الصفحة دي"), `guestGuard` (/login), `landingRedirect` ('' and `**`). `/backup` keeps `mainPcGuard` (canMatch) plus `backup.manage`. A user with no page at all lands on `/no-access`.
- **Login (`/login`, outside the frame):** shop name/logo from bootstrap; first run on the main PC creates the owner, then the recovery code is shown once (copy, print, "كتبت الكود وحفظته في مكان آمن" required before continuing); on a client PC "لسه مفيش حساب مالك…" with retry. "نسيت كلمة المرور؟" recovers on the main PC only (new code shown the same way). Change password from the sidebar user card keeps the session with the new token.
- **Route → permission map** (`src/app/core/auth/route-permissions.ts`; the sidebar uses the same rules):

| Route | Sidebar item | Needs |
|---|---|---|
| /login | — | nothing (guest only) |
| /home | الرئيسية | dashboard.view |
| /selling | نقطة البيع | sales.create |
| /credit-sales | البيع الآجل | credit.view |
| /credit-sales/new | — | credit.create |
| /invoice-history | سجل الفواتير | sales.view |
| /returns | المرتجعات | returns.create **or** returns.view (without view: wizard only, no log) |
| /customers, /customers/:id | العملاء | customers.view |
| /products | الأصناف والفئات | products.view |
| /products/new | — | products.manage + products.viewCost |
| /products/edit/:id | — | products.manage |
| /products/profit-report | تقرير الأرباح | reports.profit + products.viewCost |
| /users | المستخدمين والصلاحيات | users.manage |
| /audit | سجل العمليات | audit.view |
| /shop-profile | بيانات المحل | shop.manage |
| /backup | النسخ الاحتياطي | main PC + backup.manage |
| /ui-kit | — | signed in |
| /no-access | — | signed in |
| '', `**` | — | → first allowed page (sidebar order), or /login |

- **Actions:** one structural directive `*notaCan` (`core/auth/nota-can.directive.ts`; list = all keys, `any: true`, `else` template) and the permission-locked pattern `nota-locked-action`. Locked (lock + note): cash invoice delete, credit invoice delete (customer page), invoice discount (POS, new credit sale), collect on a credit invoice. Hidden: create/edit/delete buttons, Excel import/template (importExport + categories.manage) and exports (importExport + viewCost), sync purchase price, return buttons, dashboard shortcuts.
- **Cost/profit without `products.viewCost`:** purchase-price column (products list), purchase-price field, profit hints and below-cost hint (product form, edit) and the profit report link are not rendered. The product update doesn't send `purchasePrice`; the PUT keeps the stored value.
- **Creating a product requires knowing its cost:** `POST /api/products` needs `products.manage` + `products.viewCost` (backend route map, `EXPECTED_ROUTES`), and so do the "new product" button, the `/products/new` guard and the dashboard "add products" shortcut. Editing stays `products.manage`. The frontend never sends a new product without its purchase price (no server-default path).
- **Users (`/users`) and audit (`/audit`):** see Users.dc.html/AddUser.dc.html; owner row has no disable/role change and only the owner edits it; no reset on your own row; disable, reset and role/permission changes warn "هيتعمله خروج من كل الأجهزة". The audit page has date/user/action filters and paging; its user filter uses `/api/users` only with users.manage.
- **`createdByName`** shows in the cash and credit invoice detail panels when the server sends it. No print had a printed-by line, so prints are unchanged.
- **No invoice edit screen exists in the frontend** (no `PUT /sellings`; `updateCreditSale` is unused), so "resend the stored discount on edits" had nothing to attach to.

#### Stage 15 — auto-lock, protected backup, one main PC, session polish (done)
- **Rule:** the UI hides; the backend or the Electron main process enforces. A renderer check alone never counts.
- **Auto-lock:**
  - Shop setting `autoLockMinutes` (ShopProfile, additive): 0 (off), 5, 10, 15, 30, 60; default 10. Read by any signed-in user (`GET /api/shop-profile`); changed with `shop.manage` in the "الأمان" card of the shop-profile page. Not sent → the stored value is kept.
  - Idle = no mouse, keyboard, touch or wheel input in that window (`core/auth/idle-lock.service.ts`), per window, on every PC.
  - The lock screen is an overlay (`core/auth/lock-overlay.component.ts`), not a navigation: the page under it keeps its state (a POS cart survives lock/unlock).
  - Unlock: `POST /api/auth/verify-password` (login required). It shares the login lockout (per username + IP); wrong → 400 `WRONG_PASSWORD` (not 401, the session is fine); 5th wrong → 429 `LOGIN_LOCKED`; success → 204. The token is not changed.
  - While locked, new backend requests wait in the interceptor until unlock; requests already running finish. A reload keeps the lock (`sessionStorage['nota.locked']`); closing the app still signs out.
  - "دخول بمستخدم تاني" warns about unsaved work, signs out and opens /login.
- **Backup IPC, checked in the main process** (`electron-offline/lib/ipc-guard.js`, `lib/backup-handlers.js`):
  - The page passes its session token as the first argument of every `backup.*` call. Main calls `GET /api/auth/me` on the local backend (loopback, LAN key) and checks the rule. No/invalid/expired token → `SESSION_EXPIRED`; no permission → `FORBIDDEN`; backend not answering → `SERVER_BUSY`. Nothing runs then.

    | Handler | Rule |
    |---|---|
    | `backup:create` | `backup.manage` |
    | `backup:restore` | `backup.manage` + the user's password (`verify-password`), checked before the file dialog and before anything is paused |
    | `backup:choose-copy-folder`, `backup:clear-copy-folder` | `backup.manage` |
    | `backup:show-file` | `backup.manage`; only an existing absolute `*.archive.gz` path |
    | `backup:open-folder` | `backup.manage` |
    | `backup:status` | any valid session |
    | `setup:*` (incl. setup restore) | only while the app is in setup mode, before mongod, the backend or any user exist |
    | `nota:quit`, `nota:retry`, `nota:retry-connection`, `nota:change-address` | unchanged: used from the status page / connection overlay when the server is down or unreachable, so no session can be checked; quit and retry are also in the tray |
    | `nota:runtime-config`, `nota:status`, `nota:connection`, `nota:open-logs`, `nota:other-main` | read-only, unchanged |
  - Auto-backup is unchanged: it runs on main-process timers (`consistentBackup`), calls no IPC and needs no signed-in user.
- **After a restore:** the restored backup's users replace the current ones. Main stores `sessionsValidAfter` (whole seconds, restore end) in config.json and passes it as `NOTA_SESSIONS_VALID_AFTER`; the backend refuses older tokens with 401 `SESSION_EXPIRED`, `reason: DATA_RESTORED` (on every PC). Main also sends `nota:session-reset`; every window goes to `/login?reason=restored` ("تم استرجاع النسخة. سجّل الدخول بحساب من النسخة المسترجعة"). A backup with no users (from before Stage 13) shows the first-run owner screen on the main PC (bootstrap `hasOwner: false`).
- **Backup audit (marker file, not an endpoint):** the backend is stopped during every backup and restore, and a restore replaces the users, so main appends JSON lines to `run/audit-inbox.jsonl` inside the maintenance task; the backend moves them into AuditLog at startup (`NOTA_AUDIT_INBOX`, `src/auth/auditInbox.js`) and deletes the file. Actions: `backup.created`, `backup.restored`, `backup.restore_failed`, with user and file base name only (no paths).
- **One main PC:** discovery answers already carry `instanceId` and `shopName`. `otherMainPcs()` drops the PC's own answer (same instance id). Setup: "الجهاز الرئيسي" runs discovery first and warns (use as client, pre-filled; or continue after a second confirmation). Runtime: `lib/main-pc-watcher.js` checks 15 s after start and every 5 minutes; users with `shop.manage` see a banner with "إيه اللي أعمله؟". It never stops either PC.
- **Unsaved work:** `core/unsaved-work/unsaved-work.service.ts`. Registered: POS cart, new credit sale, product form (new/edit), user form dialog, shop profile. Asked on logout, "دخول بمستخدم تاني" and leaving those routes (`unsavedWorkGuard`). Forced navigations (session expired, restore) do not ask.
- **Sessions:** `POST /api/auth/refresh` returns a new 12h token for the same user and tokenVersion. The frontend refreshes on activity when less than 2h is left; a locked or idle session is not refreshed and expires normally. On a 401 with an open POS cart, the cart is kept in memory; the same user signing in again in that window gets it back ("رجعنالك الفاتورة اللي كانت مفتوحة"); another user gets an empty POS.
- **Max discount:** optional `maxDiscountPercent` (0–100) on users; none = no limit; never for the owner. Enforced in `requireDiscountPermission` (cash and credit, create and edits that change the discount, same "changed" rule as Stage 13): `discountAmount / subtotal × 100 > limit + 0.01` → 403 `DISCOUNT_LIMIT` "أقصى خصم مسموح لك X٪". A non-owner admin cannot change their own limit or give a higher one than theirs. POS and new credit sale show "أقصى خصم: X٪" and block above it. User form: field under the discount permission.
- **Per-device login ("يقدر يدخل من"): not planned.** AddUser.dc.html showed a radio "أي جهاز في المحل / جهاز الكاشير ١ بس"; there is no backend or frontend for it.
- **Assumptions (documented):**
  - The login lockout counters (login, recover, verify-password) are in memory in the backend process: an app restart clears them. One main PC runs the only backend, so one process sees every attempt.
  - There is no `trust proxy`: `req.ip` is the socket address. The lockout key (username + IP) and the loopback check of setup-owner/recover rely on no proxy being in front of the backend.

**Later (moved from Stage 15):**
- If an invoice edit screen is ever added: send the stored discount unchanged when the user didn't touch it (Stage 13 discount rule), and show "الخصم ثابت لأنك مش عندك صلاحية تعديل الخصم" without `sales.discount`. The max-discount check already applies to edits on the backend.
- Lockout counters persisted across restarts, if ever needed.

### Accounting (double-entry)
- **Stage 16 accounting foundation (done).** MongoDB now runs as a loopback-only, single-member `rs0` replica set. Existing standalone data folders are initiated in place; backend startup refuses a server without transaction support. Sale/create/edit/cancel, credit payments, returns, inventory movement, document counters, customer deletion, category import, safeguards and their business audit writes use MongoDB transactions. Login/lockout audit remains outside transactions.
- **Document numbers (done):** permanent, never-reset counters allocate `INV`, `CR`, `RT`, and `RC` numbers inside the document transaction (`PV`, `PO`, `JE`, `SH`, `EX`, `OB` are reserved). One `Receipt` document and one `RC` number represent each payment request; allocations carry that number. A credit-sale down payment also creates its own receipt. Startup migrations backfill old documents in date/creation order, and list/return searches accept normalized numbers such as `INV-12`.
- **Cancel, not delete (done):** cash and credit invoice DELETE routes are removed. Cancel keeps the invoice and reason, restores eligible stock, and records `cancelRefundAmount`. A credit invoice can be cancelled only with no return and no payment except its down payment. A down-payment cancel statement contains the original invoice debit, payment credit, matching cancel credit, and a `رد المقدم` debit referenced by the down-payment RC number.
- **Returns stay separate (done):** invoices retain original items, quantities, subtotal, discount, shipping and total. Per-item `returnedQuantity`, `refundedAmount`, `refunds[]` and ReturnLog determine `netTotal`; cash full returns keep the invoice, and fully returned credit status is `returned`. Credit overpayment is reallocated to other open invoices in the same transaction; any remainder appears as customer credit, and a negative statement balance means the shop owes the customer. A future payout of that credit must be a debit statement line.
- **Historical migration (done):** ordered migrations in `src/migrations/` record `meta.schema.version` and a `system.migration` audit entry for number/receipt backfill, original credit-line reconstruction, `Reactionary` → `returned`, leftover removal and indexes. Migration 2 (original-totals restore) is not all-or-nothing: it runs in chunks, each in its own transaction, and resumes from `meta.migrationProgress` after an interruption. It is idempotent through the per-invoice `stage16OriginalTotalsRestored` marker (already-restored invoices are skipped), and the schema version is set only when all chunks are done. Missing/ambiguous return data or a failed original-total equality check fails the migration and names the invoice; the failed chunk is rolled back, and if this happened right after a restore, Electron rolls the whole database back to the pre-restore safety backup. Every start also builds all model indexes (autoIndex is off in LAN mode); a failed index build, such as a unique index blocked by duplicate data, stops the backend with an error naming the index's collection, and no data is dropped. A legacy single-product cash sale with no stored cost, and a returned entry merged into an existing line, use the current product purchase price when needed and are marked `costEstimated`. A fully removed line without historical cost uses the current product purchase price (or zero if deleted), is marked `costEstimated`, adds an invoice migration note, and is listed in one migration audit detail. Profit viewers see `تكلفة تقديرية`.
- **Restore safety (done):** if a restored database cannot start because a migration fails, Electron automatically restores the pre-restore safety backup, starts that data again, shows the migration error with `النسخة المسترجعة محتاجة تحديث فشل. رجّعنا البيانات زي ما كانت قبل الاسترجاع`, and queues `backup.restore_failed` for the audit inbox.
- **Delete safeguards (done):** referenced products archive and can be restored; unreferenced products hard-delete. Archived products are hidden by default. Categories delete only when empty (archived products count). A customer referenced through `CreditSale.customer` cannot be deleted (`CUSTOMER_HAS_INVOICES`); cash name/phone matches do not count.
- **Customer statements (done):** `GET /api/customers/:id/statement?from&to` returns ordered opening/invoice/payment/return/cancel lines with debit, credit and running balance. `customers.view` is required.
- Journal entries are generated automatically from cash sales, credit sales, payments, returns, discounts, purchases, and expenses.
- Posted entries are never edited or deleted. Edit = reversing entry + new entry. Deleting an invoice becomes cancelling it (status: cancelled) with a reversing entry.
- New shops start with an opening-balance wizard: inventory (quantity × purchase price, auto-calculated), cash, and customer and supplier balances entered by the user; the difference goes to capital. No retroactive entries are needed because there is no historical data.
- Automatic restocking during invoice edits is recorded as an "inventory adjustment" until purchases exist, then removed.
- Optional period closing; closed periods cannot be edited. sync-purchase-price is blocked in closed periods and creates an adjustment entry in open ones.
- Multiple cash boxes and payment methods (default: one cash box), with shift closing that records cash shortages and overages.
- Two layers: a simple layer (expenses, collections, supplier payments, profit/cash/balance reports) and an accounting layer behind a permission (chart of accounts, manual entries, trial balance, income statement, balance sheet).
- VAT is an optional per-shop setting and is posted to a VAT payable account. E-invoicing is a later phase.
- Money is rounded to 2 decimals in journal entries.
- **Stage 17 must:** create the chart of accounts and journal entries; use the Stage 16 document numbers and transactions; post cancel reversals, return credits, down-payment refunds/customer-credit payouts as debits, and inventory adjustments; do not mutate or delete posted entries.
- **Stage 17 (done):** chart codes 31/32/33 are CAPITAL/RETAINED_EARNINGS/OWNER_DRAWINGS; customers remain control account 113 with virtual party rows. Automatic entries cover sales, receipts, returns, cancels, edits, auto-restock, stock/cost adjustments, category imports and hard deletes. Ledger start records `meta.ledgerStartAt` and an OB opening entry; health reconciles trial balance, inventory, customers, dashboard net sales (shipping included), line-cost COGS and source coverage. The design's old code clash is intentionally resolved in favor of 31/32/33.
- **Stage 18 must:** add the opening-balance wizard by reversing and re-posting OB-000001 for cash, inventory, customer and supplier opening balances, with the difference to capital.
- **Stage 18 (done):** the opening-balance wizard "رصيد بداية المحل" (/accounting/opening, `accounting.manage`), a minimal Supplier base and the مدين/دائن balance display.
  - **Setup mode:** `meta.opening = { status: "setup" | "finalized", entryId, savedAt, finalizedAt, finalizedBy, data }` (absent = setup). Setup mode = status `setup` AND `meta.opening.setupEndedAt` unset. Ending it is a write: the first sale, credit sale, return or receipt sets `setupEndedAt` inside its own transaction (a model hook), and every setup-mode stock posting touches `meta.opening.lastSetupPostingAt`, so a concurrent first sale and stock edit conflict on meta and the stock edit retries into INVENTORY_ADJUSTMENT. `isSetupMode` reads meta only (no collection scan); migration 6 sets `setupEndedAt` for installs that already have post-ledger documents. While in setup mode every stock posting (product create with stock, stock edit, purchase-price revaluation, category import with stock, and a hard-delete write-off) goes Dr/Cr INVENTORY against CAPITAL with source type `opening_inventory`. The first real sale, return or receipt ends it automatically; from then on the normal INVENTORY_ADJUSTMENT rules apply. Auto-restock and invoice-edit corrections always keep their accounts.
  - **Customer/supplier opening representation:** a separate `PartyOpening` document (`partyType` customer|supplier, one per party, signed `amount`, `date` = ledger start, `number` = current OB, `payments[]`), NOT a CreditSale, so edit/cancel/return/profit/COGS/dashboard sales never see it. Customer: positive = the customer owes us; negative = we owe them (shown as customer credit, never offset automatically). Supplier: positive = we owe the supplier (Cr SUPPLIERS), negative = an advance. One shared open-items service (`customerOpenItems.service`) feeds the statement ("رصيد أول المدة" pinned first), aging, outstanding, the customer list balance and the dashboard outstanding. The opening is one more open item, the oldest (a credit-return reallocation pays the other invoices first, then the opening, then refunds the remainder): `firstInvoice` pays it first, `lastInvoice` and the by-invoice route collect it last; Receipt allocations carry `opening` beside `creditSale`. Aging (current, 1–30, 31–60, over 60 days overdue; opening aged from the ledger start, invoices from dueDate or sellingDate) did not exist anywhere (backend or frontend) and is now returned by the statement API. A re-save cannot lower a customer opening below what was already collected (409 `OPENING_BELOW_COLLECTED`).
  - **Save/finalize:** `POST /api/accounting/opening` reverses the current OB and the `opening_inventory` entries (folding them in) and posts one new OB (a new number, dated `ledgerStartAt`); inventory = Σ stock × price in setup mode (minus older INVENTORY adjustments the wizard keeps), carried otherwise (previous OB INVENTORY + every folded `opening_inventory` entry, one helper for GET and save). Customer balances that came from invoices before the ledger start are carried into every new OB. `POST /api/accounting/opening/finalize` (explicit `confirm: true`) makes it read-only for good: later saves return 409 `OPENING_FINALIZED`; later corrections are manual entries (Stage 21). Banks and wallets become leaf accounts 11201, 11202, … under 112 (5-digit children, so they never collide with 113) with `kind: bank|wallet`, `isSystem: false`. Health gains `suppliers` and `opening` checks.
  - **Display rule:** the API keeps the raw signed balance and adds `side` and `absBalance`; the frontend shows one positive amount on the balance's own side labelled مدين / دائن (Dr / Cr) through the shared `notaBalance` pipe, with the warning token and a hint only when the balance is opposite to the account's normal side.
- **Stage 19 (done):** cash boxes and payment methods, shifts, transfers, expenses, owner drawings and customer credit. Every money movement now says which box it went into or out of, and posts to that box's account in the same transaction; the ledger, the box balances and the shift reports agree (health `boxes`).
  - **Box model:** `CashBox { name, type: cash|wallet|bank, accountId (unique), isMain (exactly one), deviceId (optional, unique), shiftsEnabled, isActive, sortOrder }` + audit fields. The main box is account 1111 (CASH_MAIN, "الخزنة الرئيسية"), created by migration 7 (or on first use); every 112xx bank/wallet leaf gets a box with the same name and kind (the wizard creates one for each new account). A new drawer is a leaf under 111 (11102, 11103, …); a new wallet/bank is the next 112xx. Balance = the ledger balance of the account (`accountBalances`, one aggregation). A box is deactivated only with balance 0 and no open shift (409 `BOX_NOT_EMPTY` / `BOX_HAS_OPEN_SHIFT`), the main box never; a box with ledger lines is never deleted (409 `BOX_HAS_LINES`). `shiftsEnabled` defaults to true for a new drawer, false for the main box, wallets and banks. A new box can be funded with `openingAmount`, moved in from the main box in the same transaction.
  - **Payment box on every money document:** `boxId` on Selling, Receipt (receipts and down payments), ReturnLog (cash returns), the "رد المقدم" refund (`CreditSale.cancelRefundBoxId`), Expense, Transfer, OwnerDrawing, CustomerPayout and Shift. Request field `boxId` is optional: this PC's drawer, else the main box (the box must be active: 409 `BOX_INACTIVE`; a shift-enabled box needs an open shift: 409 `NO_OPEN_SHIFT`; a user without `cashbox.manage` may pick wallets/banks, their PC's drawer, and the main box only when the PC has no drawer: 403 `BOX_NOT_ALLOWED`). Edits keep the invoice's original box (it cannot change in this stage). A cancelled cash sale reverses on its own box; a cash return's refund line is reversed on the SALE's box, so the cancel pays the customer (total − already returned) out of the sale's box and every box ends where the cash really is. Cash returns, receipts and "رد المقدم" use the request's `boxId`, else the PC's drawer, else the main box (they do not default to the original sale's box). Migration 7 sets the main box on every old money document; journal lines on 1111 and 112xx are untouched because the accounts did not change. Single method per document: split payment is out of scope.
  - **Device identity (decision):** the desktop app adds `X-Nota-Device-Id` (this PC's `config.instanceId`: the main PC's own `NOTA_INSTANCE_ID`, or the client PC's own id) and `X-Nota-Device-Name` (hostname, trimmed to 64, percent-encoded) to every backend request, the main PC's own renderer included (`electron-offline/lib/lan-auth.js`; `getRuntimeConfig()` also exposes `deviceId`/`deviceName`). **The header is NOT an authentication factor:** anyone with the LAN key can send any id. It only chooses the default box and fills the PC list. Permissions, shifts and audit stay tied to the signed-in user; an invalid id (not `[A-Za-z0-9][A-Za-z0-9._-]{7,63}`) is ignored. The backend upserts `Device { deviceId, name, role: main|client, lastSeenAt }` on authenticated requests, at most once a minute per device and outside business transactions (role main when the id is `NOTA_INSTANCE_ID`); `GET /api/devices` (`cashbox.manage`) lists them. A device is the default of at most one box (unique index; 409 `DEVICE_ALREADY_BOUND`); deactivating a drawer frees its PC.
  - **Shifts:** `Shift { number SH-000001, boxId, userId/userName, openedAt, openingFloat, openingBalance, closedAt, expected, counted, difference, differenceNote, depositBoxId, depositAmount, breakdown, status }`; one open shift per box (unique partial index); only shift-enabled boxes. `POST /api/shifts { boxId, openingFloat }`: the float is informational, posts nothing, and must equal the box balance or be confirmed (409 `FLOAT_MISMATCH` with both numbers, then `confirmFloat: true`). Any user with `sales.create` sells into an open shift; the shift belongs to the user who opened it (`shift.operate` closes your own, `shift.manage` anyone's and sees all). **Expected cash at close is computed from documents, never from the ledger:** expected = opening float + cash sales + receipts (incl. down payments) + incoming transfers − cash refunds (returns, cancels, "رد المقدم") − expenses − outgoing transfers − payouts − drawings, taking each box document's `createdAt` (cancels at `cancelledAt`, a cancelled expense/transfer/payout/drawing is its original plus a reversing event) from `openedAt`. `POST /api/shifts/:id/close { counted, differenceNote, depositBoxId?, depositAmount? }`, one transaction: difference = counted − expected; ≠ 0 needs a note (400 `NOTE_REQUIRED`) and posts a shortage as Dr CASH_OVER_SHORT (530) / Cr box, an overage the reverse; the deposit is a `shift_deposit` transfer to another box (deposit ≤ counted); the breakdown is stored, so a closed shift's report never changes. Design numbers: float 500, sales 6,820, receipts 600, refunds 120, expenses 250 → expected 7,550; counted 7,500 → shortage 50; deposit 7,000 → 500 stays. A confirmed float that differs from the ledger balance is carried inside the difference (the documents, and so health, still agree with the ledger). Printing is Stage 22 (`SHIFT_PRINT_ENABLED = false`, TODO PrShiftClose); the closed shift shows a printable summary view.
  - **Transfers / expenses / drawings / payouts:** `POST /api/cashbox/transfers` (TR-000001, Dr to / Cr from, 409 `INSUFFICIENT_BALANCE`, cancel = reversal with a reason, refused when the to-box already spent it); expense categories are leaf accounts under 520 (521–525 seeded, new ones 526, 527, …; rename a non-system category; deactivate only one with no lines); `POST /api/expenses` (EX-000001, Dr category / Cr box, balance and open shift required, cancel = reversal); `POST /api/cashbox/drawings` (DR-000001, Dr OWNER_DRAWINGS 33 / Cr box, owner only, cancel = reversal). Posted entries are never edited.
  - **Customer credit:** credit = the statement balance when it is negative. `POST /api/customers/:id/payouts { boxId, amount, note }` (`credit.collect`, CP-000001, amount ≤ credit: 409 `EXCEEDS_CREDIT`, Dr CUSTOMERS party / Cr box; a debit line "صرف رصيد دائن" on the statement; cancel is a reversal and a credit line). `POST /api/customers/:id/apply-credit { amount }` allocates credit to open items oldest first (opening first) as payments with `source: "credit_application"`, posts no entry, and the statement skips them (like `return_reallocation`): applicable = min(open items, open items − statement balance). `GET /api/customers/:id/credit` and the statement's `credit` block feed the customer page buttons.
  - **Permissions:** `cashbox.view`, `cashbox.manage`, `shift.operate`, `shift.manage`, `expenses.create`, `expenses.manage`, `owner.drawings` (group الخزنة). Templates: owner all; manager all except `owner.drawings`; cashier `shift.operate` + `expenses.create`; accountant `cashbox.view` + `expenses.create` + `expenses.manage`; storekeeper none. `cashbox.view` has no dependency on `products.viewCost`. Routes with several roles use `requireAnyPermission` (tag "a | b" in the route map).
  - **Health:** new `boxes` check: per box, the ledger balance of its account against opening amount (Stage 18 data) + cash sales, receipts and down payments − refunds − expenses ± transfers ± shift differences − drawings − payouts from documents (cancelled documents net out), plus money on a 111/112 leaf account that no box points to; difference = Σ|per-box difference| + unboxed. The other checks are unchanged. Frontend: /cashbox (cards, shift panel, add box, transfer, owner drawing), /cashbox/:id (ledger with the Stage 18 balance pipe, shifts), /expenses, the "طريقة الدفع" selector (POS, payments, down payment, cash refund, "رد المقدم", payout; hidden while the shop has one box), the POS "الوردية" button and "مفيش وردية مفتوحة" banner, the customer page "صرف الرصيد" / "خصمه من فواتير مفتوحة", the dashboard "كاش في الخزنة" KPI and "تسجيل مصروف" action.
- **Later:** split payment (one document paid through several boxes).
- **Stage 20 must:** supplier payments (PV) come out of a cash box (a `boxId` with the same default, `INSUFFICIENT_BALANCE` and open-shift rules as an expense, posting Dr SUPPLIERS party / Cr box), and purchases paid in cash come out of a box the same way; then purchases, the supplier statement, built on the Stage 18 `Supplier` model (name, phones, contact person, address, supplies, tax number, paymentTermsDays: 0 = cash) and the supplier `PartyOpening` records; SUPPLIERS ledger lines already require `partyType: "supplier"` and an existing supplier, and the health `suppliers` check (ledger party balance = the supplier opening record) must be extended to include purchases and payments.

### Other
- Selling.shippingLocation, Selling.government and the unused createSellingInvoice options parameter were removed in Stage 16. shippingFees on Selling and CreditSale remains a real POS field.
- The Admins page (modules/admin, route /admins, AdminsService) calls /users, /users/:id (GET, PATCH, DELETE) and /auth/signup and expects `res.data.users` with email/phone and roles admin/customer. That doesn't match the Stage 13 API (`/api/users` returns `{ users }`, there is no PATCH /:id, DELETE or signup). (done: Stage 14 removed it; /users replaces it.)
