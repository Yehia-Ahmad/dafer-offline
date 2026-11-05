# Stage 15 — Auto-lock, protected backup, one main PC, session polish

Read docs/OFFLINE_PLAN.md first, especially the Stage 13 and Stage 14 sections and the "Stage 15 must" list. Then read docs/design/NOTA_DESIGN_SYSTEM.md and docs/stages/STAGE_14.md; its hard rules apply here too. Design references: Backup.dc.html, Login.dc.html, AddUser.dc.html.

Start in plan mode and show me the plan before changing anything. Use Node 24.

**Prefer the Windows PC for this stage.** It changes Electron IPC and backup/restore. If you run it on Linux, do everything you can there and list exactly what still needs Windows.

## Hard rules
1. **The UI hides; the backend or Electron main process enforces.** A renderer check alone never counts as protection.
2. **No changes to selling, credit, payment, return or inventory logic.** The only exception is the max-discount check in STEP E.
3. **Styling:** tokens only (no hex, no `[attr.dir]`), light and dark, Arabic and English.
4. **Safety:**
   - Never commit.
   - The smoke test never uses the real DB or port 27017.
   - Ask before sudo.
   - Never touch C:\ProgramData\Nota on this PC from tests.

## STEP 0 — Findings (read-only, report before planning)
1. **Backup and restore.**
   - List every Electron IPC handler (main.js, preload.js): what each one does, and which are dangerous (backup create/restore, copy folder, change server address, setup, quit).
   - How does backup and restore work today: files, where mongod is stopped and started, and what happens to the running backend and open sessions after a restore?
   - Does auto-backup run without a signed-in user? It should keep doing so.
2. **LAN discovery today.**
   - How `setup:discover` finds main PCs: the protocol, the port, and what a main PC answers.
   - Can a main PC detect another main PC that is already running?
3. **Session behavior.**
   - What a user loses today on token expiry (12h) in the middle of a sale.
   - Where the POS cart and the new credit sale form keep their state.
4. **Discount.** Where the discount is applied on create (cash and credit), for the max-discount rule.

## STEP A — Auto-lock
1. **Shop setting `autoLockMinutes`.**
   - Values: 0 (off), 5, 10, 15, 30, 60. Default 10.
   - Stored on the main PC, readable by any signed-in user, editable with `shop.manage`.
   - Put it in the shop-profile page under a "الأمان" card.
   - Backend: an additive optional field. Tests for validation and default.
2. **Idle detection.**
   - Activity means no input (mouse, keyboard, touch, wheel) in the app window for N minutes.
   - It runs per window, on every PC.
3. **The lock screen is an overlay, not a navigation.** The current page stays mounted, so a POS cart or a half-filled form is not lost.
   - It shows the shop logo, "الشاشة مقفولة", the user's name, a password field, and "فتح".
   - It also has "دخول بمستخدم تاني".
4. **Unlock.**
   - It needs a new endpoint: `POST /api/auth/verify-password { password }`. The endpoint needs login, uses the same lockout as login (per username + IP), and returns 204.
   - Five wrong attempts → the normal 429 message, and the overlay stays.
   - The token is not changed by locking or unlocking.
5. **"دخول بمستخدم تاني".**
   - It warns if there is unsaved work (see STEP D), then logs out and goes to /login.
6. **Restarts and closed windows.**
   - While locked, a reload or reopen of the window keeps the lock: store a "locked" flag in sessionStorage. Closing the app logs out as before.
   - Backend calls that are already running are allowed to finish, and nothing new is sent until unlock.
7. **Tests:**
   - idle timer with fake time;
   - activity resets the timer;
   - the overlay keeps component state: a POS cart survives lock/unlock;
   - wrong password; lockout;
   - switch user with unsaved work → confirm;
   - setting 0 disables the lock;
   - the setting is saved and read back.

## STEP B — Backup and restore protected in the main process
1. **Check permissions in the main process.**
   - Every dangerous IPC handler from STEP 0.1 is a backup/restore action. Each one must verify the caller in the main process:
     - The renderer passes its current token with the call.
     - Main calls the local backend `GET /api/auth/me` with it (loopback, with the LAN key) and checks `backup.manage` in the returned permissions.
     - Missing, invalid or expired token, or no permission → a structured error `FORBIDDEN` / `SESSION_EXPIRED`. Nothing runs.
   - Read-only status calls (`backup:status`) need only a valid session.
   - Show me the list: handler → rule.
2. **Restore asks for the password again.**
   - The restore dialog asks the current user for their password, checked with `verify-password`, before anything is stopped or replaced.
3. **After a successful restore:**
   - The users in the restored backup replace the current users.
   - So after restore the app restarts the backend and sends every window to /login with a clear message: "تم استرجاع النسخة. سجّل الدخول بحساب من النسخة المسترجعة".
   - If the restored backup has no users (made before Stage 13), the main PC shows the first-run owner screen.
   - Test both cases.
4. **Auto-backup** keeps running on its schedule without a signed-in user. It runs in the main process and calls no IPC.
5. **The setup wizard's "restore from backup"** (first setup, before any backend or user exists) stays as it is. Explain why it's safe: it runs only during setup on the main PC, before the backend starts.
6. **Audit.**
   - Log `backup.created`, `backup.restored` and `backup.restore_failed` through the backend audit log, with the user and file name and no path secrets.
   - Add a small internal endpoint, or write after restart from a marker file. Pick the simpler one and explain why.
7. **Tests:**
   - each handler: no token, an expired token, a token without `backup.manage`, an owner token;
   - restore with a wrong password → nothing stopped;
   - post-restore login message;
   - backup without users → first run.

## STEP C — One main PC per shop
1. **At setup.**
   - When the user chooses "الجهاز الرئيسي", run discovery first.
   - If another main PC answers on the LAN (different instance id), show a strong warning:
     "فيه جهاز رئيسي تاني شغال على الشبكة (<name / address>). لازم يكون فيه جهاز رئيسي واحد بس في المحل، وإلا البيانات هتتقسم على جهازين."
   - Give two buttons:
     - "استخدم الجهاز ده كجهاز فرعي" (switches to client setup, pre-filled with that address)
     - "أنا متأكد، كمّل كجهاز رئيسي" (needs a second confirmation)
2. **At runtime.**
   - The main PC checks for another main PC on the LAN at startup and then every few minutes, using the same discovery.
   - If it finds one, show a persistent banner to users with `shop.manage`: "فيه جهاز رئيسي تاني على الشبكة…". Include a link to explain what to do.
   - Never stop either PC automatically.
3. **Discovery answers carry the main PC's instance id and shop name.** Additive. Clients ignore the new fields.
4. **Tests:**
   - setup with no other main PC;
   - setup with another main PC;
   - the "use as client" path;
   - the runtime banner;
   - the PC's own answer must not count as another main PC.

## STEP D — Unsaved work and sessions
1. **One small `UnsavedWorkService`.**
   - Screens register a "has unsaved work" check: POS cart not empty, new credit sale form dirty, product form dirty, user form dirty, shop profile dirty.
   - Logout, "دخول بمستخدم تاني", and leaving those routes (canDeactivate) confirm when any check is true.
2. **Token refresh.**
   - `POST /api/auth/refresh` needs a valid token and returns a new 12h token for the same user and tokenVersion.
   - The frontend refreshes on activity when less than 2h is left, so an active cashier is never kicked out mid-shift.
   - An idle, locked session still expires normally.
   - Tests: refresh works; refresh with an old tokenVersion → 401; an expired token can't refresh.
3. **Session expiry with unsaved work.**
   - When the session expires (401) while the POS cart has items, keep the cart in memory.
   - After the same user signs in again within the same window, restore it with a toast "رجعنالك الفاتورة اللي كانت مفتوحة".
   - A different user gets an empty cart.

## STEP E — Max discount per user (design field from AddUser.dc.html)
1. **User field.**
   - Optional `maxDiscountPercent`: Number 0–100, undefined = no limit.
   - Only meaningful with `sales.discount`. Editable in the user form under the discount permission.
   - The owner has no limit.
2. **Backend enforcement** on cash and credit create, and on edits when the discount changes (same rule as Stage 13):
   - `discountAmount / subtotal * 100` must be ≤ `maxDiscountPercent`, with a 0.01 tolerance for rounding.
   - Otherwise → 403 `DISCOUNT_LIMIT` with an Arabic message: "أقصى خصم مسموح لك X٪".
3. **Frontend.**
   - POS and the new credit sale show "أقصى خصم: X٪" next to the discount field, and block higher values before sending.
4. **Tests:**
   - backend: under / at / over the limit, no limit, owner, and edits;
   - smoke: one scenario where a manager with a 10% limit is refused at 15%;
   - frontend: specs for the hint and the block.
5. **"يقدر يدخل من" (per-device login): skip.**
   - Remove it from the design notes as "not planned".
   - Report what the design showed.

## STEP F — Small items
1. **Windows drive check.** On Windows, the "real drive check" in auto-backup.test.js must pass. If it fails on Windows, fix it and explain.
2. **Docs.** Document in OFFLINE_PLAN.md:
   - the in-memory lockout counters (reset on restart);
   - the "no trust proxy / req.ip is the socket address" assumption.
3. **Keep the "resend stored discount" note for a future edit screen in the plan.**

## VERIFICATION
- backend: `npm test`
- frontend: `npm run build:offline`
- frontend: `npx ng test --watch=false --browsers=ChromeHeadless`
- frontend: `npm run test:offline` (on Windows: 0 failures, 0 unexpected skips)
- frontend: `npm run smoke:offline` (report every line)
- frontend: `npm run offline:stage`
- On Windows: `npm run electron:build:win:offline` (report the installer path and size)
- grep the changed components for hex colors and `[attr.dir]`: expected none.

Save fixture-backed screenshots to `%USERPROFILE%\nota-review\stage-15\` (or ~/nota-review/stage-15 on Linux):
- lock screen light/dark ar/en
- lock screen with a wrong password
- shop profile security card
- restore password dialog
- the post-restore login message
- the setup warning for a second main PC
- the runtime banner
- the user form with max discount
- the POS max-discount hint and its block
- the unsaved-work confirm

**Manual check on the installed app (Windows):**
1. Set auto-lock to 5 minutes. Leave the POS with 2 items in the cart → the lock screen appears → unlock → the cart is still there.
2. Lock → "دخول بمستخدم تاني" → you're warned about the cart.
3. As the cashier, open Backup: it's not in the menu. Also try calling `window.nota.backup.create()` from DevTools if DevTools is available in the build, and report the result. Otherwise say it isn't available.
4. As the owner: backup, then restore with the password. You're sent to login with the restore message.
5. Give a manager a 10% limit and try 15% in the POS.

Report what you saw at each step.

Update docs/OFFLINE_PLAN.md:
- mark Stage 15 done;
- move remaining items to the right later phase.

Do not commit.

## Final report — exactly this, in one code block
```
=== STAGE 15 REPORT ===
STEP 0 findings (IPC handlers, backup/restore flow, discovery, session loss, discount points):
Auto-lock (setting, idle, overlay, verify-password, lockout, reload behavior):
IPC handler → rule table:
Restore (password re-check, after-restore flow, no-users backup):
Backup audit entries (approach):
One main PC (setup warning, runtime banner, discovery fields):
UnsavedWorkService (screens registered, where it confirms):
Token refresh and cart restore after expiry:
Max discount (field, enforcement, UI):
Per-device login (skipped; what the design showed):
Windows drive check:
Backend tests (new / total):
Frontend tests (new / total):
Electron tests (new / total, skipped):
Smoke test (every line):
Screenshots (paths):
Manual installed-app check (each step, or what needs Windows):
Installer (path, size):
Docs updated:
Open questions / anything you didn't do:
```
