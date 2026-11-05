# Stage 14 — Login, users page, permission-driven UI, auth on

First read:
- docs/OFFLINE_PLAN.md: the Stage 13 section and its "Stage 14 must" list
- docs/design/NOTA_DESIGN_SYSTEM.md
- docs/stages/STAGE_9.md: its hard rules apply, EXCEPT rule 2. This stage may make the backend/Electron changes listed below, and nothing else.

Design references, in docs/design/screens/:
- Login.dc.html
- Users.dc.html
- AddUser.dc.html
- Sidebar.dc.html

Start in plan mode and show me the plan before changing anything. Use Node 24 (the installed 24.22.1).

**Run this stage on the Windows PC.**

## Hard rules
1. **Auth is ON by the end of this stage.**
   - Electron's main role sets `NOTA_AUTH=1`.
   - Every screen must work signed in, for every role template.
2. **Backend changes:**
   - Only the ones in STEP A. No business-logic changes.
3. **Theming:**
   - Tokens only: no hex colors, no `[attr.dir]`.
   - Light and dark, Arabic and English.
4. **The UI hides; the backend enforces.**
   - Hiding a button is a convenience. Every action must still be checked server side, as it already is.
   - Never compute or display cost/profit from data the server didn't send.
5. **Safety:**
   - Never commit.
   - The smoke test never uses the real DB or port 27017.
   - Ask before sudo.

## STEP 0 — Findings (read-only, report before planning)
1. **Online leftovers:** `core/guards/auth.guard.ts`, `core/interceptor/logout.interceptor.ts`, `httpconfig.interceptor.ts`, `modules/admin`. What each does today, and which ones you will replace or delete.
2. **Backend address:** how the main PC's renderer reaches the backend (127.0.0.1 or the LAN address?), and how client PCs do. This decides STEP A.1.
3. **Cost/profit in the frontend:** every place that reads `purchasePrice`, `profitAmount`, `totalProfit`, `profitValue` or `profit`:
   - product form
   - products list
   - POS (any below-cost hint?)
   - invoice details
   - invoice history
   - customer page
   - profit report
   - Excel export buttons
   - printing

   For each one, say what it shows when the field is missing.
4. **Discount:** where the cash and credit edit screens recompute `discountAmount` from a percentage.
5. **The user's name on prints:** where prints/PDFs build "printed by" text, if anywhere.
6. **Every route in app.routes.ts and every sidebar item,** with the permission you plan to require for it.

## STEP A — Backend / Electron changes (small, each with tests)
1. **Local-only owner actions.**
   - `POST /api/auth/setup-owner` and `POST /api/auth/recover` only accept requests from the main PC itself (`req.ip` is loopback: 127.0.0.1, ::1, ::ffff:127.0.0.1). Anything else gets 403 `LOCAL_ONLY`.
   - This keeps a client PC on the LAN from claiming the owner account or using a recovery code.
   - Tests:
     - loopback works;
     - a non-loopback IP (override it in the test) gets 403.
   - Make sure the main PC's own renderer really calls over loopback (STEP 0.2).
   - **`GET /api/auth/bootstrap` adds `isLocal`.** It tells the UI whether this request came over loopback.
2. **Electron turns auth on.**
   - `buildBackendEnv` sets `NOTA_AUTH=1` for the main role.
   - An unreadable or missing JWT secret is now fatal at startup in the main role. Show the existing error screen with a clear Arabic message; don't start the backend without it.
   - Add the `loadJwtSecret()` test listed in "Stage 14 must".
3. **Smoke test:**
   - Add two scenarios:
     - setup-owner from a non-loopback address is refused;
     - bootstrap returns `isLocal`.
   - Keep the auth-off check.

## STEP B — Session, guards, interceptor
1. **`AuthService`** (signals):
   - holds `user`, `permissions`, `token`;
   - `login()`, `logout()`, `setupOwner()`, `recover()`, `changePassword()`, `refreshMe()`;
   - `has(key)`, `hasAll(...keys)`.
2. **Token storage:**
   - in memory + `sessionStorage`. A reload keeps you signed in; closing the app signs you out.
   - No `localStorage`, and no "remember me": shared shop PCs.
   - On app start, if a token exists, call `/auth/me`. If it fails, go to /login.
3. **HTTP interceptor:**
   - adds `Authorization: Bearer` next to the existing LAN key header;
   - **401 `SESSION_EXPIRED`** → clear the session and go to /login with the message "انتهت الجلسة، سجّل الدخول تاني". Keep the URL they were on as `returnUrl`;
   - **403 `FORBIDDEN`** → a toast with the server message; stay on the page;
   - **429 `LOGIN_LOCKED`** → show the minutes left (from `retryAfterSeconds`).
   - Replace or remove the online-edition interceptors and guards from STEP 0.1. Nothing from the online edition should stay half-wired.
4. **Guards:**
   - `authGuard`: signed in, else /login.
   - `permissionGuard(...keys)`: put it on every route from STEP 0.6.
     - Without the permission, redirect to the user's first allowed page.
     - Show "مش عندك صلاحية تفتح الصفحة دي" once.
   - `/home`:
     - needs `dashboard.view`;
     - without it, the default landing page is the first allowed one (e.g. /selling for a cashier).
   - The existing `main-pc.guard` stays on /backup and is combined with the permission (`backup.manage`).

## STEP C — Login and first run (Login.dc.html)
1. **/login**, outside the layout shell:
   - shows the shop logo and name from `/auth/bootstrap`, plus username, password, show/hide password and "دخول";
   - Arabic error messages for each code;
   - language and theme toggles;
   - Enter submits;
   - the username field gets focus on open.
2. **First run:** when `hasOwner` is false.
   - On the main PC (`isLocal` true): show "إنشاء حساب المالك" (name, username, password, confirm).
   - On success, show the recovery code **once**, full screen:
     - large monospace text, with a copy button and a print button;
     - a checkbox "كتبت الكود وحفظته في مكان آمن" that must be ticked before continuing.
     - Explain in plain Arabic: this code is the only way back in if the owner forgets the password, and it can only be used on the main PC.
   - On a client PC: show "لسه مفيش حساب مالك. افتح نوتة على الجهاز الرئيسي الأول وأنشئ حساب المالك" with a retry button. No form.
3. **"نسيت كلمة المرور؟"**
   - Main PC only: username, recovery code, new password.
   - On success, show the new recovery code the same way as in C.2, and explain that the old code no longer works.
   - On a client PC, this link shows a message to use the main PC.
4. **Change my password:** from the user card in the sidebar. A dialog with current, new and confirm. Afterwards, stay signed in with the new token.
5. **Sidebar user card:**
   - name, role label (or "صلاحيات مخصصة" when edited/custom), device (main PC / client), and logout;
   - logout asks for confirmation only if a POS cart or an unsaved form would be lost. Reuse any existing unsaved-changes check; don't invent one.

## STEP D — Permission-driven UI
1. **Sidebar:**
   - show an item only if its route exists and the user has its permission;
   - hide a group with no visible items.
   - Add under الإدارة:
     - "المستخدمين والصلاحيات" (/users, `users.manage`)
     - "سجل العمليات" (/audit, `audit.view`)
   - Remove `/admins` and `modules/admin` entirely.
2. **Actions:**
   - hide create/edit/delete buttons the user can't use;
   - where a hidden action would confuse the user (e.g. delete on an invoice), use the design system's "permission-locked action" pattern instead: lock icon + note.
   - Use one directive or pipe (e.g. `*notaCan="'sales.delete'"`), not ad-hoc checks.
3. **Cost and profit without `products.viewCost`:**
   - hide the purchase-price field, columns and cards, and the profit report link;
   - hide Excel export (needs `products.importExport` + `products.viewCost`) and import (`products.importExport` + `categories.manage`).
   - A missing field must never render as 0, NaN or "—" in a profit/cost spot: the spot itself is hidden.
   - Product form: without `products.viewCost`, the purchase price is not shown, and saving a product does not send `purchasePrice`.
     - Check the PUT: today, does omitting it keep the stored value? Report it.
     - If omitting it would erase it, stop and ask me.
4. **Discount without `sales.discount`:**
   - **POS and the new credit sale:** the discount fields are locked, using the permission-locked pattern.
   - **Edit screens (cash and credit):**
     - When the user lacks `sales.discount` and the invoice already has a discount, keep the stored `discountAmount` unchanged (don't recompute from the percentage), and show a small note: "الخصم ثابت لأنك مش عندك صلاحية تعديل الخصم".
     - With the permission, the behavior is unchanged.
     - The request must resend the stored discount unchanged when the user didn't touch it (OFFLINE_PLAN "Stage 14 must").
5. **Below cost:**
   - The server's error toast is enough.
   - Add no client-side cost hint for users without `products.viewCost`.
6. **"Printed by":** prints and PDFs that have a printed-by or created-by line use the signed-in user's name. Only where such a line already exists or the design has one.

## STEP E — Users page and audit page
1. **/users (Users.dc.html):**
   - table: name, username, role (with an "مخصصة" badge when edited), status, last login, actions.
   - Actions:
     - edit
     - reset password: not shown on your own row; use "change my password" instead
     - disable/enable
   - The owner row: no disable, no role change. Only the owner sees an edit action on it.
2. **Add/edit user (AddUser.dc.html):**
   - name, username, password (create only), confirm, and role select (no owner);
   - permission checkboxes grouped by the catalog groups, with Arabic labels from `GET /api/auth/permissions`.
     - Choosing a role fills in its template.
     - Changing a checkbox marks the list as edited and shows "رجوع لصلاحيات الدور".
   - Permissions the current user doesn't hold are shown disabled, with a note.
   - Server errors map to fields: `USERNAME_TAKEN`, `PERMISSION_NOT_HELD`, `OWNER_PROTECTED`, `CANNOT_CHANGE_SELF`.
   - When a change logs that user out (disable, reset, role/permission change), tell the admin in the confirm dialog: "هيتعمله خروج من كل الأجهزة".
3. **/audit:**
   - table: time, user, action (Arabic label per action), entity, details summary;
   - filters: date range, user, action;
   - paginated.
   - Follow the existing table pattern. There's no design board; keep it simple.

## STEP F — Tests
- **Unit/spec tests:**
  - AuthService
  - interceptor: 401 → login with returnUrl; 403 toast; 429 minutes
  - guards: permission redirect, first allowed page
  - the `notaCan` directive
  - sidebar filtering for each role template: owner, manager, cashier, storekeeper, accountant
  - login, first run (local vs client), recovery-code screen (continue blocked until the checkbox is ticked), recover, change password
  - users form: template fill, edited state, disabled permissions, error mapping
  - discount lock on edit
  - product form without viewCost (no `purchasePrice` sent)
- **Payload specs:**
  - every new call;
  - before/after for the existing calls whose payload might change (product PUT without viewCost, invoice edits without `sales.discount`).
- **Fixture-backed screenshots**, saved to `%USERPROFILE%\nota-review\stage-14\`:
  - login light/dark ar/en
  - first-run owner form
  - recovery code screen
  - client-PC "no owner yet"
  - sidebar for the cashier and for the owner
  - /users
  - add user with an edited permission list
  - /audit
  - POS as a cashier (discount locked)
  - product page as a cashier (no cost)
  - 390px for login and /users
- **Manual check on the installed app** (build the installer at the end):
  1. fresh install → main PC → create the owner → recovery code
  2. create a cashier
  3. sign in as the cashier on the same PC: check the menu, the POS, and that there's no cost
  4. disable the cashier while they're signed in → they're sent to /login on their next action
  5. recover the owner with the code

  Report what you saw at each step.

## VERIFICATION
Run each of these:
- backend: `npm test`
- frontend: `npm run build:offline`
- frontend: `npx ng test --watch=false --browsers=ChromeHeadless`
- frontend: `npm run test:offline`
- frontend: `npm run smoke:offline` (report every line)
- frontend: `npm run offline:stage`
- `npm run electron:build:win:offline`: report the installer path and size.

Then:
- grep the new/changed components for hex colors and `[attr.dir]`: expected none.
- grep the frontend for `/admins`, `auth/signup` and the old online interceptors: expected none.

Update docs/OFFLINE_PLAN.md:
- mark Stage 14 done;
- list the route → permission map for the frontend;
- update the "Stage 15 must" list:
  - auto-lock
  - `backup.manage` enforced in Electron IPC (backup/restore must check the signed-in user, not just the UI)
  - warn if another main PC is on the LAN
  - anything you found.

Do not commit.

## Final report — exactly this, in one code block
```
=== STAGE 14 REPORT ===
STEP 0 findings (leftovers, backend address, cost/profit spots, discount recompute, printed-by, routes):
Backend/Electron changes (LOCAL_ONLY, isLocal, NOTA_AUTH=1, fatal JWT secret, loadJwtSecret test):
Session / interceptor / guards:
Login, first run, recovery code, recover, change password:
Sidebar and route → permission map:
notaCan usage (where actions are hidden vs locked):
Cost/profit hiding (each spot) and product PUT without purchasePrice:
Discount lock (POS, credit, edits):
Printed-by:
Users page and form (rules, error mapping):
Audit page:
Removed online leftovers:
Tests (new / total, per suite):
Payload specs (before/after):
Smoke test (every line):
Screenshots (paths):
Manual installed-app check (each step):
Installer (path, size):
Docs updated:
Open questions / anything you didn't do:
```
