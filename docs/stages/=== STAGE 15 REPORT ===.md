=== STAGE 15 REPORT ===
STEP 0 findings (IPC handlers, backup/restore flow, discovery, session loss, discount points):
- Preflight: git pull was already up to date. Current branch is main; HEAD and origin/main are both 5db1bdc, with the Stage 14 login/users/permissions UI present.
- Existing IPC bridge: nota:runtime-config, nota:status, nota:connection, retry/retry-connection, change-address, open-logs and quit; backup:create/restore/status/choose-copy-folder/clear-copy-folder/show-file/open-folder; setup:info/generate-secret/check-port/pick-backup/discover/complete-main/complete-client. Before Stage 15 they checked only that calls came from an application page. Backup actions had no signed-in-user or permission enforcement in the main process.
- Backup/restore paused the backend while leaving mongod running. Backup used mongodump. Restore made a safety backup, replaced the database with mongorestore, rolled back on failure, then restarted the backend. Existing sessions were not invalidated after restore. Scheduled auto-backup ran entirely in the main process without a signed-in user.
- Discovery broadcast NOTA_OFFLINE_DISCOVER_V1 over UDP port 5056, three times, to directed/global broadcasts and loopback. Replies contained instanceId, shopName, HTTP port and appVersion; the sender address supplied the IP. There was no configured-main-PC runtime watcher or filtering of the PC's own answer.
- Token expiry cleared the session and navigated to login. The POS cart lived only in SellingComponent state and the new credit-sale form only in CreditSalesComponent state, so route destruction lost both.
- Cash and credit create paths calculate discountAmount against the invoice subtotal in their backend controllers; those are the max-discount enforcement points.
Auto-lock (setting, idle, overlay, verify-password, lockout, reload behavior):
- ShopProfile.autoLockMinutes supports 0, 5, 10, 15, 30 and 60; default 10. It is readable by signed-in users and editable with shop.manage in the new الأمان card.
- Mouse, keyboard, touch and wheel activity reset a per-window timer. Setting 0 disables locking.
- Locking displays an Arabic/English, light/dark overlay without unmounting the current page. The token and POS/form state remain intact.
- POST /api/auth/verify-password verifies the current user without issuing another token. It shares the normal five-attempt, five-minute username+IP lockout.
- The locked flag is kept in sessionStorage. Reloading the same window validates /auth/me so startup can reach the overlay, while closing the window still ends the session.
- New backend work waits while locked; verify-password and the read-only startup /auth/me check remain available.
IPC handler → rule table:
- backup:create → backup.manage
- backup:restore → backup.manage, then verify-password before the file picker or any maintenance
- backup:choose-copy-folder → backup.manage
- backup:clear-copy-folder → backup.manage
- backup:show-file → backup.manage
- backup:open-folder → backup.manage
- backup:status → any valid signed-in session
- Every handler receives the renderer's token. The Electron main process calls loopback GET /api/auth/me with the LAN key and refuses missing/expired tokens or insufficient permissions before doing anything.
Restore (password re-check, after-restore flow, no-users backup):
- The current user's password is rechecked before choosing the archive, stopping the backend or touching data. A wrong password leaves everything running and unchanged.
- Successful restore stores sessionsValidAfter, restarts the backend with NOTA_SESSIONS_VALID_AFTER, invalidates every older token and sends open windows to /login?reason=restored with the restored-backup message.
- If an old backup contains no users, local bootstrap reports no owner and the normal first-run owner screen is shown.
Backup audit entries (approach):
- Electron writes backup.created, backup.restored and backup.restore_failed markers into a local audit inbox while the backend is stopped.
- On startup the backend imports them into the normal audit collection, preserving the user and backup file name but not the secret path, then removes imported entries.
One main PC (setup warning, runtime banner, discovery fields):
- Selecting main-PC setup runs discovery first. Another instance produces the required strong warning with shop/address, a prefilled “use this PC as client” path and a second confirmation before continuing as another main PC.
- A configured main PC checks at startup and every few minutes. Users with shop.manage see a persistent warning banner; neither PC is stopped automatically.
- Discovery results now carry instanceId, shopName, address and port. The current instance is excluded.
UnsavedWorkService (screens registered, where it confirms):
- Registered screens: POS cart, new credit sale, product form, shop profile and open add/edit-user form.
- It confirms before logout, “دخول بمستخدم تاني” and canDeactivate route changes. “ارجع للشغل” preserves the session and state; continuing discards the work.
Token refresh and cart restore after expiry:
- POST /api/auth/refresh requires a currently valid token/tokenVersion and returns a new 12-hour token.
- User activity refreshes when less than two hours remain. A locked idle session does not refresh.
- If expiry still occurs with a POS cart, the cart remains in memory for that window. Signing in as the same user restores it with the Arabic toast; another user receives an empty cart.
Max discount (field, enforcement, UI):
- User.maxDiscountPercent is optional, 0–100, meaningful with sales.discount and never limits the owner. It appears below the discount permission in the user form.
- Cash and credit creates and discount-changing edits enforce discountAmount/subtotal × 100 with 0.01 rounding tolerance before changing invoices or stock.
- Exceeding it returns 403 DISCOUNT_LIMIT and “أقصى خصم مسموح لك X٪”.
- POS and new credit sale display “أقصى خصم: X٪” and block excessive values before sending.
Per-device login (skipped; what the design showed):
- Not planned and not implemented.
- AddUser.dc.html showed “يقدر يدخل من” with “أي جهاز في المحل” or one named device such as “جهاز الكاشير ١ بس”.
Windows drive check:
- Not run on Linux. The real-drive test now skips only outside Windows; it still must run and pass on Windows.
Backend tests (new / total):
- 10 / 76. Result: 76 passed, 0 failed, 0 skipped, using /tmp/nota-mongodb-linux-8.0.34/bin/mongod.
Frontend tests (new / total):
- 43 / 315. Result: 315 SUCCESS under Node 24.21.0.
Electron tests (new / total, skipped):
- 16 / 98; 89 passed, 0 failed, 9 skipped. The skips are expected Linux skips for Windows binaries/drive behavior.
Smoke test (every line):
> nota-frontend@0.0.0 smoke:offline
> node scripts/offline/smoke-test.js
[smoke] mongod ready on 127.0.0.1:27099 (dbpath /tmp/nota-smoke-K9lgGK/db)
[smoke] backend ready on http://127.0.0.1:5099 (LAN mode, auth on (NOTA_AUTH=1), mongodb://127.0.0.1:27099/dafer_smoke)
✓ Auth: bootstrap before the owner exists → hasOwner false — hasOwner false, shop name ""
✓ Auth: request without a token → 401 SESSION_EXPIRED — HTTP 401 "انتهت الجلسة. سجّل الدخول مرة أخرى"
✓ Auth: bootstrap from the main PC itself → isLocal true — isLocal true
✓ Auth: setup-owner from a non-loopback address (127.0.0.2) → 403 LOCAL_ONLY, isLocal false — HTTP 403 "العملية دي متاحة على الجهاز الرئيسي بس"; bootstrap isLocal false; still no owner
✓ Auth: setup-owner → 201, token and recovery code — owner 6aec655bad53cc0279c19384, 27 permissions
✓ Auth: bootstrap after setup → hasOwner true — hasOwner true
✓ Auth: second setup-owner → 409 OWNER_EXISTS — HTTP 409 "تم إنشاء حساب المالك بالفعل"
✓ Auth: owner creates a clerk (cashier, no sales.priceBelowCost) → 201, login 200 — clerk 6aec655bad53cc0279c1938d
✓ Request without LAN key is rejected — HTTP 401 "كلمة سر الشبكة غير صحيحة"
✓ Create category — id 6aec655bad53cc0279c19396
✓ Create product (stock 10, purchase 50, selling 100) — id 6aec655bad53cc0279c1939a, stock 10
✓ Max discount: manager limited to 10% is refused at 15% — HTTP 403 "أقصى خصم مسموح لك 10٪", limit 10%, stock 10
✓ Cash sale, quantity 2 → stock 8 — invoice 6aec655bad53cc0279c193b4, stock 8
✓ Sale below purchase price is rejected — HTTP 400 "سعر البيع لا يمكن أن يكون أقل من سعر الشراء للمنتج Smoke Product", stock 8
✓ Edit cash invoice to quantity 3 → stock 7 — stock 7
✓ Cash return, quantity 1 → stock 8, listed in /api/returns — stock 8, return log 6aec655bad53cc0279c193d4
✓ Credit sale to a new customer, quantity 2 → stock 6, customer created — invoice 6aec655bad53cc0279c193eb, customer 6aec655bb71b34ee04848882, stock 6
✓ Payment on credit sale (50) → remainingAmount 150 — paid 50, remaining 150, status partially_paid
✓ Payment via /api/customers/:id/payments (30) → remainingAmount 120 — paid 80, remaining 120
✓ Credit return, quantity 1 → stock 7 — stock 7, invoice total 100, remaining 20
✓ Dashboard summary: today's cash and credit sales, credit outstanding — date 2026-11-05 (Africa/Cairo), cash 200, credit 100, outstanding 20
✓ Product with lowStockThreshold 20 (stock 15) appears in dashboard low stock — low stock: SMOKE-LOW 15/20
✓ GET /api/categories → productCount 2 for the smoke category — productCount 2
✓ GET /api/products without categoryId → all products, paginated — totalItems 2
✓ Delete cash invoice → stock unchanged (7) — stock 7
✓ Delete credit invoice → stock unchanged (7) — stock 7
✓ GET /api/sellings → 200 — HTTP 200
✓ GET /api/credit-sales → 200 — HTTP 200
✓ GET /api/customers → 200 — HTTP 200
✓ GET /api/products → 200 — HTTP 200
✓ GET /api/products/profit-report → 200 — HTTP 200
✓ GET /api/dashboard/summary → 200 — HTTP 200
✓ Products Excel export → 200, non-empty file — 7039 bytes, application/vnd.openxmlformats-officedocument.spreadsheetml.sheet
✓ Shop profile before saving → 200, empty name — HTTP 200
✓ Save shop profile (name, address, phones, tax number, footer) → 200 — HTTP 200
✓ Shop profile returns the saved values — name "Smoke Shop", 2 phones
✓ Save shop profile without name → 400 — HTTP 400 "اسم المتجر مطلوب"
✓ Save shop profile with an invalid logo → 400, saved values unchanged — HTTP 400 "يجب أن يكون شعار المتجر سلسلة base64 صالحة (خام أو بصيغة data URI)"
✓ Removed route POST /api/notifications/devices → 404 — HTTP 404 "المسار غير موجود: /api/notifications/devices"
✓ Removed route POST /api/cart/checkout → 404 — HTTP 404 "المسار غير موجود: /api/cart/checkout"
✓ Removed route GET /api/website-orders/pending → 404 — HTTP 404 "المسار غير موجود: /api/website-orders/pending"
✓ Removed route GET /api/website-images/active → 404 — HTTP 404 "المسار غير موجود: /api/website-images/active"
✓ Removed route GET /api/header → 404 — HTTP 404 "المسار غير موجود: /api/header"
✓ Removed route GET /api/public/seo/sitemap/pages → 404 — HTTP 404 "المسار غير موجود: /api/public/seo/sitemap/pages"
✓ Removed route GET /api/seo/slug-availability?entityType=product&language=ar&slug=smoke → 404 — HTTP 404 "المسار غير موجود: /api/seo/slug-availability?entityType=product&language=ar&slug=smoke"
✓ Removed route GET /api/ecommerce-settings → 404 — HTTP 404 "المسار غير موجود: /api/ecommerce-settings"
✓ Auth: owner creates a cashier → 201 — cashier 6aec655cad53cc0279c1949a, role cashier
✓ Auth: cashier login → 200 with the cashier permissions — 9 permissions
✓ Auth: cashier makes a cash sale → 201, createdBy = cashier — invoice 6aec655cad53cc0279c194a8, createdByName "Smoke Cashier"
✓ Auth: cashier deletes a product → 403 FORBIDDEN — HTTP 403 "ليست لديك صلاحية للقيام بهذه العملية"
✓ Auth: cashier opens the profit report → 403 FORBIDDEN — HTTP 403 "ليست لديك صلاحية للقيام بهذه العملية"
✓ Auth: cashier sees no purchasePrice on products (the owner does) — cashier: no purchasePrice; owner: 50
✓ Auth: disable the cashier → their token gets 401 — HTTP 401 "انتهت الجلسة. سجّل الدخول مرة أخرى"
✓ Auth: owner change-password → old token 401, new token works — old token 401, new token 200
✓ Auth: recover with the recovery code → new password, new code, old code refused — recovered; old code 401; login 200
✓ Auth: audit list contains the expected actions — 20 entries, 13 actions
[smoke] backend ready on http://127.0.0.1:5099 (LAN mode, auth off, mongodb://127.0.0.1:27099/dafer_smoke_noauth)
✓ Auth off: GET /api/products without a token → 200 — HTTP 200
✓ Auth off: create a category without a token → 201 — id 6aec655da85a728c19c48818, no createdBy
✓ Auth off: /api/auth/bootstrap and /api/users are not mounted → 404 — HTTP 404 "المسار غير موجود: /api/auth/bootstrap"; HTTP 404 "المسار غير موجود: /api/users"
[smoke] stopped backend and mongod, removed /tmp/nota-smoke-K9lgGK
[smoke] summary: 59 ✓ / 0 ✗
Screenshots (paths):
- /home/yehia/nota-review/stage-15/lock-light-ar.png
- /home/yehia/nota-review/stage-15/lock-dark-ar.png
- /home/yehia/nota-review/stage-15/lock-light-en.png
- /home/yehia/nota-review/stage-15/lock-dark-en.png
- /home/yehia/nota-review/stage-15/lock-wrong-password.png
- /home/yehia/nota-review/stage-15/shop-profile-security-card.png
- /home/yehia/nota-review/stage-15/restore-password-dialog.png
- /home/yehia/nota-review/stage-15/post-restore-login-message.png
- /home/yehia/nota-review/stage-15/setup-second-main-warning.png
- /home/yehia/nota-review/stage-15/runtime-second-main-banner.png
- /home/yehia/nota-review/stage-15/user-form-max-discount.png
- /home/yehia/nota-review/stage-15/pos-max-discount-block.png
- /home/yehia/nota-review/stage-15/unsaved-work-confirm.png
Manual installed-app check (each step, or what needs Windows):
- Requires Windows installed app: set auto-lock to 5 minutes, leave two POS items, wait for lock, unlock and confirm the cart remains.
- Requires Windows installed app: lock, choose another user and confirm the unsaved-cart warning.
- Requires Windows installed app: verify Backup is hidden for cashier and try window.notaDesktop.backup.create() from DevTools if available.
- Requires Windows installed app: owner backup and password-protected restore, then verify the restored-backup login message.
- Requires Windows installed app: manager limited to 10% attempts 15% in POS and is blocked.
Installer (path, size):
- Not built on Linux. Run npm run electron:build:win:offline on Windows; installer path and size are therefore not available yet.
Docs updated:
- docs/OFFLINE_PLAN.md marks Stage 15 done, documents the implementation and security assumptions, records per-device login as not planned, and moves the future invoice-edit discount behavior to Accounting.
- Offline build passed. offline:stage passed: app 4.7 MB, backend 50.2 MB, with secret/exclusion and backend-load checks passing.
Open questions / anything you didn't do:
- No open code questions. No commit was created. git diff --check is clean; changed-component grep found no new hex colors or [attr.dir].
- Exactly what still needs Windows: the installer build, the Windows drive check, and the manual check on the installed app.