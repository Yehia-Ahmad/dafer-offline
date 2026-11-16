# Online Stage 6A — The admin app on the phone (PWA shell, push, core screens)

Read before starting:
- docs/ONLINE_PLAN.md (Stages 1–5B)
- docs/design/NOTA_DESIGN_SYSTEM.md and the mobile designs in docs/design/screens/Mob*.dc.html if present (MobNav, MobTop, MobMore, MobHome, MobPos, MobOrders, MobOrder, MobStock, MobProductForm, MobCustomers, MobAddCustomer, …). If they are not in the repo, the "Mobile design spec" below is the source of truth.
- nota-frontend: the app shell (layout, custom sidenav, top bar), routing, core/auth (permission guards and menu filtering), the orders module and its poller/sound service (Stage 4), the selling (POS) page, products list/form, customers list/form, the dashboard/home page, angular.json, src/index.html
- nota-backend: src/services/webOrders.service.js and storeOrder.controller.js (where a website order is created), src/auth/permissions.js, test/permissions.test.js
- deploy/: setup-server.sh, update.sh, templates/nginx-nota.conf.template (the admin app is at /admin/)

Start in plan mode and show me the plan before changing anything. Use Node 24 and a real mongod. Run long suites with a timeout and output to a file. Leave no test processes behind. Never use git worktree on Windows. Never touch C:\ProgramData\Nota, the installed offline Nota, or ports 27017/27217. Never commit; I commit after I review.

## Context
Shop owners and staff will use the same admin app from their phones. There is no separate mobile app: the admin app (at `/admin/`) becomes an installable PWA, and below a phone breakpoint it switches to the mobile layout from the designs. This stage (6A) builds the mobile shell, the PWA, push notifications for new website orders, and the core screens. Stage 6B converts every remaining screen.

## Decisions (already made; implement exactly)
1. **One app, two layouts.** Below 768 px wide (CSS media query + a `LayoutService` signal for templates that need it) the app uses the mobile shell; at 768 px and above, nothing changes from today. Every business rule, API call, permission and validation stays exactly as it is: the mobile screens are new templates/styles over the same services and forms, not new logic.
2. **Mobile shell** (MobNav, MobTop, MobMore):
   - Bottom tab bar (76 px + safe-area inset): الرئيسية, البيع, الطلبات (badge = new orders count from the Stage 4 poller), المخزون, المزيد. A tab the user has no permission for is hidden; the bar always keeps المزيد.
   - Top bar on inner screens: back button (right side in RTL, chevron), title, optional subtitle. Root tabs have their own header (see home/POS).
   - "المزيد": the user card (avatar letter, name, role · shop name, خروج) and grouped icon grids (المبيعات, الموقع, المخزون, الخزنة, الحسابات, الإدارة), 4 per row, each item shown only with its permission. Every admin page is reachable from here.
   - Lists become cards with rows (avatar/icon, title, subtitle, a status pill at the end) instead of tables; a floating "+ add" button (bottom-left in RTL, above the tab bar) where the desktop page has an add button.
   - Forms become full-screen pages with cards of fields and a sticky bottom bar (إلغاء / حفظ). Dialogs that are forms on desktop open as full-screen pages or bottom sheets on mobile.
   - Touch targets ≥ 44 px, inputs ≥ 16 px font on mobile (no iOS zoom), safe-area insets respected, no horizontal scrolling anywhere.
3. **PWA:**
   - Web app manifest for `/admin/`: name "نوتة", short_name "نوتة", `start_url` and `scope` `/admin/`, `display: standalone`, `dir: rtl`, `lang: ar`, theme color `#0E4D45`, background `#F5F3EE`, icons from docs/design/brand (192, 512, maskable 512), plus `apple-touch-icon` and the iOS meta tags.
   - A service worker for the admin app (`@angular/service-worker` or a small hand-written one, your choice in STEP 0) that caches the app shell and static assets only. **API responses are never cached** (`/api/` always goes to the network). New releases: the app detects a new version and shows "فيه تحديث جديد" with a reload button.
   - An install hint: on Android a "ثبّت نوتة على موبايلك" button using `beforeinstallprompt`; on iOS Safari a short instruction (Share → Add to Home Screen). Dismissible, remembered per device.
   - Offline: when the network is down, a clear "مفيش إنترنت" banner; actions that need the server are disabled. No offline queue.
4. **Push notifications for new website orders:**
   - Web Push with VAPID. Keys are generated on the server by `setup-server.sh` / `update.sh` when missing (`NOTA_VAPID_PUBLIC_KEY`, `NOTA_VAPID_PRIVATE_KEY`, `NOTA_VAPID_SUBJECT=mailto:` or the shop URL) and never committed. Use the `web-push` npm package.
   - New model `PushSubscription`: user, deviceId (Stage 1 device id), endpoint (unique), keys, userAgent, createdAt, lastSuccessAt. Routes: `GET /api/push/public-key`, `POST /api/push/subscribe`, `DELETE /api/push/subscribe` (own subscriptions only; any signed-in user).
   - When a website order is placed, after the transaction commits, send a push to every active subscription whose user has `orders.view`: title "طلب جديد #<number>", body "<total> ج.م · <delivery/pickup>", data `{ url: "/admin/orders/<id>" }`. No customer name, phone or address in the payload. Sending is fire-and-forget: it never delays or fails the order. 404/410 from the push service deletes that subscription.
   - The service worker shows the notification and opens/focuses `/admin/orders/<id>` on click.
   - UI: on the mobile home and in the user menu, "فعّل إشعارات الطلبات" asks for permission only on that tap (never on page load). It shows the current state (on / blocked / not supported). iOS: only offered when the app is installed (standalone), with a hint otherwise.
   - Signing out removes this device's subscription. Deactivating a user or removing `orders.view` stops their pushes (checked at send time).
5. **Core screens in this stage** (mobile layout):
   - **الرئيسية (MobHome):** greeting + shop name, notifications bell with the new-orders count; a dark card "مبيعات النهارده" (total, then من المحل / من الموقع / في الخزنة); "طلبات جديدة من الموقع" (up to 3 cards: number, customer, items count, delivery/pickup, time ago, total, with "تأكيد الطلب" and "التفاصيل"); "أصناف قربت تخلص" (from the existing low-stock data). Each block shows only with its permission. If a number does not exist in today's APIs, add ONE read-only endpoint `GET /api/dashboard/mobile-summary` that computes it from existing data (permission-filtered; never posts anything), and list exactly what it returns in STEP 0.
   - **البيع (MobPos):** title + invoice number + cashier; search by name/code; category chips; product grid (2 columns: code, name, price, available); a bottom sheet with the current invoice (items count, customer, a line summary, discount), the payment box/method choice the desktop POS already supports, and "دفع وطباعة · <total>". Opening the sheet shows the full invoice lines with quantity steppers. Same POS service and rules as desktop. Barcode scanning with the camera is NOT in this stage.
   - **الطلبات (MobOrders) and the order page (MobOrder):** status chips with counts, order cards; the order page with the status steps (جديد · بيتجهز · في الطريق · اتسلّم, or the pickup steps), customer card with call and WhatsApp buttons, address, lines and totals, payment line, and a sticky bottom bar with the actions allowed by status and permission (same rules as Stage 4/5A). **The design's hint "لما تقبل، نوتة بتعمل فاتورة بيع" is wrong for Nota's flow**: write the hint from the real rule (the invoice is created when the order leaves with the courier, or at pickup).
   - **المخزون (MobStock)** and the product form (**MobProductForm**).
   - **العملاء (MobCustomers)** and the add/edit customer page (**MobAddCustomer**). Fields that the design shows but the backend does not have (for example a second phone or a credit limit, if missing) are NOT added: leave them out and list them at the end.
   - **المزيد (MobMore)** with every item; items whose mobile screen is not done yet (6B) open the desktop page inside the mobile shell (it must at least be usable: no horizontal page scroll; tables may scroll inside their card).
6. **Printing from the phone:** the existing browser print path; if a print needs the desktop print settings, show "الطباعة من الكمبيوتر" instead of a broken print. No printer setup on mobile.

## Mobile design spec (use when the Mob*.dc.html files are not in the repo)
- Page background `#F5F3EE`, text `#142321`, secondary text `#4A5856`, borders `#E6E2D9`/`#CFCAC0`, brand `#0E4D45`, brand tint `#E6EFEC`, warning pill `#FDECE4`/`#9A3412`, muted pill `#EEEAE2`/`#3B4A47`, accent `#E4572E`, badge `#C2410C`. Font Alexandria. Numbers use tabular figures.
- Cards: white, 1 px border, radius 16, padding 14–16. Buttons: min height 44 (52 for primary actions at the bottom), radius 10–12; primary = brand background, white bold text. Inputs: radius 10, padding 11×12, 1 px `#CFCAC0`.
- Tab bar: 5 items, icon in a 52×30 pill (tint background when active), 11 px label, active = brand + bold; badge top-left, 18 px, `#C2410C`.
- Top bar: 64 px, back button 44×44, title 19 px bold, subtitle 12 px.
- Lists: row 13×14 padding, 40 px round avatar with the first letter, bold 14 px title, 12 px subtitle, pill at the end.
- Floating add button: bottom-left, 52 px high, radius 16, brand, shadow, label "+ <item> جديد".
- Bottom action bar: white, top border, padding 12×18 + safe area, buttons side by side (secondary 1 part, primary 2 parts).
- Status steps: a row of 4 equal segments, 4 px bars, done = brand, pending = `#E2DED5`, label under each.
- Dark mode follows the app's existing dark tokens.

## Hard rules
- **No change to business logic, permissions, validations or API behavior** for existing features. The only backend additions are the push subscription routes and sender, the VAPID setup, and (only if needed) the read-only mobile summary endpoint.
- Desktop (≥ 768 px) must look and behave exactly as before. Existing specs must pass unchanged except where they assert layout that the shell now wraps (list them).
- Push payloads contain no personal data. Subscriptions belong to the signed-in user; nobody can list or delete another user's subscriptions.

## Tests
- Backend (`test/online-stage6a.test.js`): subscribe/unsubscribe (own only, validation), the send-on-order hook (only users with `orders.view`, inactive users skipped, 410 removes the subscription, a push failure never fails or delays the order — use a fake sender), payload has no personal data, the mobile summary (if added) is read-only and permission-filtered, route table.
- Frontend: LayoutService breakpoint; tab bar items by permission and the orders badge; MobMore groups by permission; the install hint (Android/iOS/dismissed); the push toggle states; the order page actions per status on mobile; POS bottom sheet totals equal the desktop POS totals for the same cart; the "new version" prompt.
- A manual check list in the report: Android Chrome install + push, iOS Safari install + push (16.4+), offline banner, update prompt.

## STEP 0 (plan, before any change)
1. Every file you will add or edit, one line each.
2. How the mobile shell wraps the existing routes (one shell component or per-page templates) and how the desktop layout stays untouched.
3. Service worker choice and its caching rules (what is cached, what never is), and how updates are detected.
4. The push flow end to end, where the VAPID keys live, and how the order hook stays outside the order transaction.
5. For MobHome: which numbers come from existing APIs and what the mobile summary endpoint would return.
6. Anything in this brief you think is wrong or risky, with your alternative.

## Done means
- Backend `npm test`, admin `ng test` and production (`admin`) build pass; storefront tests still pass; `bash -n` on deploy scripts.
- Lighthouse PWA/installability checks pass for `/admin/` locally (report what you could run).
- docs/ONLINE_PLAN.md has the Stage 6A section; docs/deploy guides mention the VAPID keys and how to install the app on a phone (Arabic).
- Report: what was added, what was changed, which design fields don't exist in the backend, what only a real phone can test, and the list of things you noticed but did not do.
