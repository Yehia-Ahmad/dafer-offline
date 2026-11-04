# Stage 13 — Users & permissions (backend)

Read docs/OFFLINE_PLAN.md (section "Users and permissions") before anything else. Start in plan mode and show me the plan before changing anything. Use Node 20.

**Run this stage on the Windows PC.** It changes the backend, and the smoke test must run.

This stage is backend only, plus the small Electron plumbing in STEP F. The login screen, the users page and the permission-driven menu come in Stage 14. The owner setup wizard, recovery-code UI and auto-lock come in Stage 15.

## Hard rules
1. **Auth is behind a switch in this stage.**
   - New env var `NOTA_AUTH`. With `NOTA_AUTH=1`, every rule below is enforced.
   - When it is unset, the backend behaves exactly as today. The current frontend and installer must keep working unchanged.
   - Stage 14 turns it on by default.
2. **Existing request and response shapes do not change, with two exceptions:**
   - the new `createdBy` / `updatedBy` fields;
   - cost/profit stripping for users without `products.viewCost` (only when `NOTA_AUTH=1`).
3. **No changes to business logic:** selling, credit, payment, return and inventory logic stays as it is. Only who may call it changes.
4. **The LAN key guard stays as it is.** Auth runs after it: LAN key first, then the JWT.
5. **Dependencies:**
   - Use `bcryptjs`, not `bcrypt`. No native builds, because it must package cleanly in Electron on Windows.
   - Use `jsonwebtoken`.
   - No other new dependencies without asking me.
6. **Safety:**
   - Never commit.
   - The smoke test must never use the real DB or port 27017.
   - Ask before running anything with sudo.

## STEP 0 — Findings (read-only, report before planning)
1. **Route inventory.** Every route in src/routes/*.js (method + path + controller), including /api/lan and the category import/export. I will check the permission map against it.
2. **Cost and profit fields.** Every response that carries cost or profit:
   - `purchasePrice`, `wholesalePrice` if it means cost, `profitAmount`, `profit`, `profitValue`;
   - the profit-report endpoints;
   - dashboard fields;
   - the Excel exports.
3. **The error leak.** Where the "price below purchase price" error is built (selling.controller.js ~612, and the credit equivalent), and whether its message includes the purchase price.
4. **Electron.** How Electron starts the backend (env vars passed), and where secret-store keeps the LAN secret.
5. **Admins page.** What the frontend Admins page (modules/admin, /admins) expects from /users and /auth/signup. Don't change it now; just report it.

## STEP A — Model, catalog, roles
1. **`src/auth/permissions.js`:** a single source of truth.
   - **Permission catalog:** each key with an Arabic and English label and a group. Start with:
     - `sales.create`, `sales.view`, `sales.edit`, `sales.delete`, `sales.discount`, `sales.priceBelowCost`
     - `credit.create`, `credit.view`, `credit.edit`, `credit.delete`, `credit.collect`
     - `returns.create`, `returns.view`
     - `customers.view`, `customers.manage`
     - `products.view`, `products.manage`, `products.viewCost`, `products.syncPrice`, `products.importExport`
     - `categories.manage`
     - `reports.profit`, `dashboard.view`
     - `shop.manage`, `users.manage`, `audit.view`
     - `backup.manage`: reserved for Stage 15 (Electron IPC)
     - Adjust the list to the route inventory from STEP 0 and tell me what you changed.
   - **Role templates:**
     - `owner`: all permissions, always. Its permissions can't be edited.
     - `manager`: everything except `users.manage` and `backup.manage`.
     - `cashier`: sales.create, sales.view, credit.create, credit.view, credit.collect, returns.create, customers.view, products.view, dashboard.view.
     - `storekeeper`: products.view, products.manage, categories.manage, products.importExport, products.viewCost.
     - `accountant`: view on everything, plus reports.profit, products.viewCost, credit.collect, audit.view.
   - Export `permissionsForRole(role)` and `hasPermission(user, key)`.
2. **User model `src/models/user.model.js`:**
   - Fields:
     - `name` (required)
     - `username` (required, trimmed, lowercased, unique)
     - `passwordHash`
     - `role`: enum owner / manager / cashier / storekeeper / accountant / custom
     - `permissions`: [String], validated against the catalog
     - `isActive` (default true)
     - `tokenVersion` (Number, default 0)
     - `lastLoginAt`
     - `recoveryCodeHash`: owner only
     - timestamps
   - **One owner:** a partial unique index so that at most one user has role owner.
   - `toJSON` never returns `passwordHash`, `recoveryCodeHash` or `tokenVersion`.
   - **Password rules:** at least 6 characters. Arabic and spaces are allowed, max 128. bcrypt cost 10.
3. **Effective permissions:**
   - owner → all permissions
   - custom → its `permissions` list
   - any other role → its template, unless the owner saved an edited list. In that case the stored list wins and the role is shown as edited.
   - Report exactly how you represent "edited".

## STEP B — Auth endpoints (`/api/auth`)
1. **`GET /api/auth/bootstrap`** (no login needed): `{ hasOwner, shop: { name, logo } }`. The login screen needs the shop name/logo before login. Nothing else.
2. **`POST /api/auth/setup-owner`** (no login needed):
   - Only works while no user exists; otherwise 409 `OWNER_EXISTS`. The unique index guarantees this even with two requests racing.
   - Body: `{ name, username, password }`.
   - Creates the owner and returns `{ user, token, recoveryCode }`.
   - The recovery code is random, shown once, format like `XXXX-XXXX-XXXX-XXXX` without confusing characters (0/O, 1/I). Only its bcrypt hash is stored.
3. **`POST /api/auth/login`** `{ username, password }` → `{ user, token, permissions }`.
   - Invalid credentials and a disabled user both return the same 401 `INVALID_CREDENTIALS` with the same Arabic message, so the response doesn't reveal which usernames exist.
   - **Lockout:** after 5 failed attempts for a username, return 429 `LOGIN_LOCKED` for 5 minutes. Keep the counter in memory; that's fine for a single main PC. Document this.
   - Update `lastLoginAt` on success.
4. **`GET /api/auth/me`** → `{ user, permissions }`.
5. **`POST /api/auth/change-password`** `{ currentPassword, newPassword }`.
   - Increments `tokenVersion` (logs out other sessions) and returns a fresh token.
6. **`POST /api/auth/recover`** `{ username, recoveryCode, newPassword }`.
   - Only for the owner.
   - Sets the new password, increments `tokenVersion`, issues a **new** recovery code (returned once) and returns a token.
   - Same lockout as login.
7. **`GET /api/auth/permissions`**: catalog + role templates, for the Stage 14 users page. Needs login.
8. **JWT:**
   - HS256 with `NOTA_JWT_SECRET`, which must be at least 32 characters when `NOTA_AUTH=1`. Otherwise the backend refuses to start (fail closed, same style as the LAN guard).
   - Payload: `{ sub, tv }` only. Expiry 12h.
   - On every request: load the user, reject if missing, inactive, or `tv !== tokenVersion` → 401 `SESSION_EXPIRED`.
   - Token in `Authorization: Bearer`.

## STEP C — Enforcement (only when `NOTA_AUTH=1`)
1. **`requireAuth`** on `/api` for everything except:
   - `/api/lan/*`
   - `/api/auth/bootstrap`, `/api/auth/login`, `/api/auth/setup-owner`, `/api/auth/recover`
2. **`requirePermission(key)`** on **every** route, following one map.
   - Put the map in one place (e.g. `src/auth/routePermissions.js`) or on the routes. Either way, add a test that walks the Express router and fails if any route has no permission.
   - Show me the full route → permission table in the report.
   - Missing permission → 403 `FORBIDDEN` with an Arabic message.
3. **Strip cost and profit** for users without `products.viewCost`:
   - use one response helper, not edits scattered through every controller;
   - remove the fields from STEP 0 item 2;
   - profit endpoints themselves need `reports.profit`.
   - With `NOTA_AUTH` unset, nothing is stripped.
4. **Fix the error leak.** The "price below purchase price" error must never include the purchase price, for anyone. This change applies even when `NOTA_AUTH` is unset; it is a message-only change. A user with `sales.priceBelowCost` may sell below cost.
   - Today the sale is blocked for everyone. Keep that exact behavior when auth is off.
   - When auth is on: block unless the user has the permission.
   - Report what the credit flow does today.

## STEP D — Users endpoints (`/api/users`, need `users.manage`)
- `GET /api/users`
- `GET /api/users/:id`
- `POST /api/users` `{ name, username, password, role, permissions? }`
- `PUT /api/users/:id`: name, role, permissions
- `PATCH /api/users/:id/status` `{ isActive }`
- `POST /api/users/:id/reset-password` `{ newPassword }`

Rules (each one needs a test):
- Nobody can create a second owner, change anyone to/from owner, disable the owner, or delete users.
  - No DELETE route. Disable instead, so `createdBy` stays meaningful.
- Only the owner can edit the owner (name/password).
- A non-owner with `users.manage` can't grant a permission they don't have themselves.
- A user can't disable themselves or remove their own `users.manage`.
- Disabling a user, resetting their password, or changing their role/permissions increments their `tokenVersion`, so they're logged out immediately.
- Duplicate username → 409 `USERNAME_TAKEN`.

## STEP E — Audit trail
1. **`createdBy` / `updatedBy`**
   - What to add: optional ObjectId ref User, plus `createdByName` / `updatedByName` copies so prints still show the name after a rename.
   - Where: Selling, CreditSale, each credit payment entry, ReturnLog, Product, Category, Customer.
   - Set them from `req.user` when auth is on; leave them unset when it's off.
   - Additive only.
2. **AuditLog model:**
   - Fields: `at`, `userId`, `userName`, `action`, `entity`, `entityId`, `details` (small object), `ip`.
   - Log these actions:
     - login success/fail (fail: username only)
     - lockout
     - setup-owner and recover
     - password change/reset
     - user created/updated/status changed
     - sale/credit invoice edited or deleted
     - payment recorded
     - return
     - product deleted
     - sync-purchase-price
     - category import
     - shop profile updated
   - Never log passwords, hashes, tokens or recovery codes.
3. **`GET /api/audit`** (needs `audit.view`):
   - filters: from, to, userId, action
   - paginated, newest first
   - index on `at`

## STEP F — Electron plumbing (main PC only)
- On first start in main-PC mode:
  - generate `NOTA_JWT_SECRET` (32 random bytes, hex);
  - store it in secret-store next to the LAN secret;
  - pass it to the backend env from then on.
- Client PCs don't need it.
- Do **not** set `NOTA_AUTH=1` in Electron yet. Stage 14 does that.
- Add `NOTA_JWT_SECRET` and `NOTA_AUTH` to the docs where the other NOTA_* vars are listed.

## STEP G — Tests
1. **Backend unit/integration tests (`npm test`):**
   - catalog / roles and effective permissions
   - password hashing, and that `toJSON` hides secrets
   - setup-owner: works once, then races two requests and expects exactly one owner
   - login: success, wrong password, unknown user (same response), disabled user, lockout and its expiry (inject a clock)
   - tokens: tokenVersion invalidation after change/reset/disable, expired token, bad signature
   - recover: works, the old code stops working, lockout
   - users endpoint rules (every rule in STEP D)
   - route-coverage test (every route has a permission)
   - 403 per role on a sample of routes
   - cost stripping for a cashier vs. an owner on products, sale details, dashboard, profit report
   - "below cost" message doesn't contain the price
   - createdBy set when on, absent when off
   - audit entries written, and no secrets in them
   - with `NOTA_AUTH` unset: a sample of existing requests behaves exactly as before
   - with `NOTA_AUTH=1` and no or a short secret: startup fails
2. **Smoke test (`npm run smoke:offline`):**
   - keep all 37 existing scenarios;
   - run the backend with `NOTA_AUTH=1` and a test secret;
   - call setup-owner, then send the owner's token on every existing scenario.
   - Add these scenarios:
     - bootstrap before and after the owner exists
     - second setup-owner returns 409
     - create a cashier → cashier login → cashier can make a cash sale (and createdBy = cashier) but gets 403 on product delete and the profit report, and sees no purchasePrice
     - disable the cashier → their token gets 401
     - owner change-password
     - recover with the code
     - audit list contains the expected actions
   - Also one quick run of the old flow with `NOTA_AUTH` unset (a few requests, no token) to prove the switch.
3. **Frontend tests** must still pass untouched (`npm run test:offline`): the frontend sends no token yet, and that's fine because auth is off by default.

## VERIFICATION
- backend: `npm test`
- frontend: `npm run test:offline`
- frontend: `npm run smoke:offline` (report every line)
- frontend: `npm run build:offline`
- `npm ls bcryptjs jsonwebtoken`: confirm they're in the backend's dependencies and that the offline package includes them (check how the Electron build bundles backend node_modules).

Update docs/OFFLINE_PLAN.md:
- mark Stage 13 done;
- add the final permission catalog and the route → permission table (or a link to the file);
- describe the `NOTA_AUTH` switch;
- note what Stage 14/15 must do.

Do not commit.

## Final report — exactly this, in one code block
```
=== STAGE 13 REPORT ===
STEP 0 findings (routes, cost fields, error leak, Electron env, Admins page):
Permission catalog (final, with changes from my list):
Role templates (final):
Route → permission table:
Edited-role representation:
Auth endpoints (behavior, error codes):
JWT / tokenVersion / lockout details:
Cost stripping (helper, fields, endpoints):
Below-cost: message fix, permission behavior, credit flow:
Users endpoint rules (each → test name):
createdBy / updatedBy (models):
Audit log (actions, index, endpoint):
Electron plumbing:
New dependencies and packaging check:
Backend tests (new / total):
Smoke test (every line, auth on + the auth-off check):
Frontend tests:
npm run build:offline:
Docs updated:
Open questions / anything you didn't do:
```
