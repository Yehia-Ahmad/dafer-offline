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

Later phases (decisions below): Users & permissions (Stage 13 backend done; Stages 14–15 next), then Accounting.

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
Everything is behind the **`NOTA_AUTH` switch**. With `NOTA_AUTH=1` every rule below is enforced. Unset (or any other value), the backend behaves exactly as before: `/api/auth`, `/api/users` and `/api/audit` are not mounted (404), nothing is stripped, no token is needed, no createdBy is set and nothing is audited. The desktop app passes `NOTA_JWT_SECRET` but does not set `NOTA_AUTH` yet.

- **Single source of truth:** `nota-backend/src/auth/permissions.js` (catalog with Arabic/English labels and groups, role templates, `permissionsForRole`, `effectivePermissions`, `hasPermission`).
  - **Catalog (27 keys):**
    - sales: `sales.create`, `sales.view`, `sales.edit`, `sales.delete`, `sales.discount`, `sales.priceBelowCost`
    - credit: `credit.create`, `credit.view`, `credit.edit`, `credit.delete`, `credit.collect`
    - returns: `returns.create`, `returns.view`
    - customers: `customers.view`, `customers.manage`
    - products: `products.view`, `products.manage`, `products.viewCost`, `products.syncPrice`, `products.importExport`, `categories.manage`
    - reports: `reports.profit`, `dashboard.view`
    - admin: `shop.manage`, `users.manage`, `audit.view`, `backup.manage` (reserved for Stage 15)
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
  - Products: view and search → products.view; write → products.manage; Excel export → products.importExport + products.viewCost; the three profit routes → reports.profit + products.viewCost; sync-purchase-price → products.syncPrice.
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

**Stage 14 must:**
- Set `NOTA_AUTH=1` in `buildBackendEnv`.
- Make an unreadable session-token secret **fatal at startup when `NOTA_AUTH=1`**, like `SECRET_UNREADABLE`. Today `loadJwtSecret()` in `electron-offline/main.js` only logs it and starts the backend without a secret.
- Add a test for `loadJwtSecret()`: first start generates and stores the secret, later starts read it back, and an unreadable value fails. Today only its parts (secret-store, config-store, `buildBackendEnv`) are tested.
- Make the invoice edit UI send the stored discount unchanged when the user didn't touch it (same `discountAmount`, or for a percentage invoice the same percentage and its recomputed amount). Otherwise users without `sales.discount` get 403 on ordinary edits.
- Build the login screen (`/api/auth/bootstrap` before login), the users page (`/api/auth/permissions` + `/api/users`; replaces the old Admins page), and the permission-driven menu.
- Send `Authorization: Bearer` on every request and handle `SESSION_EXPIRED` (back to login), `FORBIDDEN`, and the missing cost/profit fields.
- Show `createdByName` on invoices.

**Stage 15 must:**
- Build the owner setup wizard (setup-owner + showing the recovery code once), the recovery-code UI (`/api/auth/recover`) and auto-lock.
- Put backup and restore behind `backup.manage` (Electron IPC).

### Accounting (double-entry)
- MongoDB runs as a single-member replica set so transactions work. An invoice and its journal entry are saved together or not at all.
- Journal entries are generated automatically from cash sales, credit sales, payments, returns, discounts, purchases, and expenses.
- Posted entries are never edited or deleted. Edit = reversing entry + new entry. Deleting an invoice becomes cancelling it (status: cancelled) with a reversing entry.
- New shops start with an opening-balance wizard: inventory (quantity × purchase price, auto-calculated), cash, and customer and supplier balances entered by the user; the difference goes to capital. No retroactive entries are needed because there is no historical data.
- Automatic restocking during invoice edits is recorded as an "inventory adjustment" until purchases exist, then removed.
- Optional period closing; closed periods cannot be edited. sync-purchase-price is blocked in closed periods and creates an adjustment entry in open ones.
- Multiple cash boxes and payment methods (default: one cash box), with shift closing that records cash shortages and overages.
- Two layers: a simple layer (expenses, collections, supplier payments, profit/cash/balance reports) and an accounting layer behind a permission (chart of accounts, manual entries, trial balance, income statement, balance sheet).
- VAT is an optional per-shop setting and is posted to a VAT payable account. E-invoicing is a later phase.
- Money is rounded to 2 decimals in journal entries.
- Current behavior (intended, to be replaced): DELETE /api/sellings/:id and DELETE /api/credit-sales/:id remove only the invoice record and do not restore stock; the UI warns users to process returns first. In the accounting phase, delete becomes cancel: status cancelled, reversing journal entry, and restoring the units that were not already returned.
- createSellingInvoice still has an unused options param (requireShippingLocation, requireGovernment, defaultSellingDate, defaultQuantity) left over from website checkout; remove it when createSellingInvoice is modified for accounting.
- Returns currently lower the invoice's totalPrice. In the accounting phase, store each refund's final amount and create a credit entry, so statements show the original invoice plus a separate return line.
- DELETE /api/categories/:id deletes the category **and every product in it** (`Product.deleteMany`). In the accounting phase, replace it with "only an empty category can be deleted" (or archive the category), together with the deleted-product safeguards (invoices and journal entries must keep pointing at real products).
- Credit invoices have no invoice number. In the accounting phase add sequential document numbers for all document types (cash sale, credit sale, return, receipt, payment, purchase, journal entry), and allow the returns wizard to search by invoice number.

### Other
- Selling.shippingLocation and Selling.government are website leftovers (the offline frontend never sends or reads them). Remove them together with the createSellingInvoice options param in the accounting phase. shippingFees on Selling and CreditSale is a real POS field and stays.
- The Admins page (modules/admin, route /admins, AdminsService) calls /users, /users/:id (GET, PATCH, DELETE) and /auth/signup and expects `res.data.users` with email/phone and roles admin/customer. That doesn't match the Stage 13 API (`/api/users` returns `{ users }`, there is no PATCH /:id, DELETE or signup). Stage 14 replaces it.
