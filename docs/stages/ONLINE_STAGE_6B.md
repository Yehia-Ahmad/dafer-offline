# Online Stage 6B — Every remaining admin screen on the phone

Read before starting:
- docs/ONLINE_PLAN.md (especially the Stage 6A section and its decisions)
- docs/stages/ONLINE_STAGE_6A.md: the "Mobile design spec" and decisions 2 and 6 apply to this stage unchanged
- The mobile designs in docs/design/screens/Mob*.dc.html if present (they are the source of truth for the screens they cover); otherwise the 6A spec plus the patterns already built in 6A
- nota-frontend/src/app/modules/mobile/* (the shell, tabs, more page, utils), the 6A phone templates (home, POS, orders list and order page, products, customers) as the reference for structure and naming, and every module listed below

Start in plan mode and show me the plan before changing anything. Use Node 24. Run long suites with a timeout and output to a file. Leave no test processes behind. Never use git worktree on Windows. Never touch C:\ProgramData\Nota, the installed offline Nota, or ports 27017/27217. Never commit; I commit after I review.

## Context
6A built the phone shell, the PWA, push notifications and the core screens. Every other admin page still opens as its desktop layout inside the phone shell. This stage gives every one of them a proper phone layout, so the whole admin app works from a phone.

## Hard rules (same as 6A)
- **No change to business logic, permissions, validations or API behavior.** Phone layouts are new templates and styles over the same components, services and forms (the `@if (layout.isMobile())` / `@else` pattern from 6A). No backend change in this stage, unless STEP 0 shows a screen cannot work without a read-only field; then stop and explain.
- **Desktop (≥ 768 px) stays exactly as it is.** The desktop markup sits in the `@else` branch unchanged.
- Fields the design shows that the backend does not have are not added; list them at the end.
- Text on every phone screen describes what Nota really does (like the 6A order-page hint fix). If a design text contradicts the real rule, use the real rule and list it.

## Screens (each one gets a phone layout)
Use the design file when it exists (name in brackets); otherwise build it from the 6A patterns (list = card rows with avatar/icon, title, subtitle, end pill; form = full page with field cards and the sticky bottom bar; detail = header card + sections + sticky actions).

**Sign-in and access**
1. Login (MobLogin) and the no-access page.

**Sales**
2. Credit sales list (MobCredit) and new credit sale (MobNewCredit). The new credit sale follows the 6A POS pattern: product search/grid, the invoice as a bottom sheet, same service and totals as desktop.
3. Invoice history (MobInvoices) and the invoice detail view/dialog.
4. Returns (MobReturns), including choosing the invoice and the lines/quantities to return.
5. Customer detail and statement (MobCustomer): balance card, invoices, payments, "تحصيل" action.

**Website**
6. Website settings (MobSite): the five tabs become a segmented row (horizontally scrollable chips) with one section visible at a time; the preview panel is a "معاينة" button opening a bottom sheet.
7. Couriers list and courier page (balances, open orders, "تسليم الفلوس" shortcut).
8. Website customers (search, deactivate, reset password with the one-time password shown in a sheet).
9. The order page's **edit mode** (left on the desktop layout in 6A): line quantity steppers, add product (search sheet), remove line, zone/fee and contact fields, sticky "حفظ التعديلات".

**Stock**
10. Category management on the phone products screen: categories as chips with a "إدارة الفئات" entry; add/edit category (MobAddCategory) as a full page; the category detail page (`categories/:id`).
11. Purchases list, new purchase, purchase detail (MobPurchases). New purchase follows the POS pattern (supplier, product lines as cards with quantity and cost, totals sheet).
12. Suppliers list, add/edit supplier (MobSuppliers, MobAddSupplier), supplier payment (MobSupplierPay).
13. Profit report (MobProfit).

**Cash**
14. Cash boxes list and box detail with its movements and shift (MobCash), add cash box (MobAddCash), transfer (MobTransfer), shift open/close.
15. Expenses (MobExpenses), add expense.

**Accounting**
16. Chart of accounts (MobAccounts) as a collapsible tree of cards, add account (MobAddAccount), account ledger (statement-style card list with running balance).
17. Journal list and journal entry detail; manual entry (MobEntry): lines as cards (account, debit/credit), a sticky footer showing total debit, total credit and the difference; save disabled until balanced (same validation as desktop).
18. Opening balances, period closing, VAT return.
19. Financial reports (MobReports): report picker as chips, each report as sections with subtotal rows; long tables scroll inside their card, never the page.

**Admin**
20. Users list, add/edit user with roles/permissions (MobUsers, MobAddUser): permission groups as collapsible cards with switches.
21. Shop profile (MobShop).
22. Audit log: filters in a bottom sheet, entries as cards.

**Everything else**
23. Any route not listed here (check `app.routes.ts` and every module's routes): give it a phone layout using the patterns and list it in STEP 0. `ui-kit` is excluded (dev page). `website/delivery-zones` redirects to the website settings' delivery tab if it isn't already.

## Common phone rules
- Filters and date ranges open in a bottom sheet with "تطبيق" / "مسح", and the active filters show as removable chips above the list.
- Tables that must stay tables (financial reports only) scroll horizontally **inside their card**, with the first column sticky. The page itself never scrolls horizontally.
- Dialogs: forms open as full pages or bottom sheets (6A already made dialogs bottom sheets in CSS; check each one is usable: the keyboard must not hide the save button, long dialogs scroll inside the sheet).
- Confirmation dialogs (delete, close period, reset password) are short bottom sheets with the destructive action in red.
- Printing: the existing browser print. Where a print depends on desktop print settings, show "الطباعة من الكمبيوتر" instead of a broken print (6A decision 6).
- Every list has an empty state and a loading skeleton consistent with 6A.
- Back button goes to the logical parent (list ← detail ← edit), not just browser history, when the page was opened directly from a link or a notification.
- Inputs: numeric fields use `inputmode="decimal"` (or `numeric` for integers) so the phone shows the number keyboard; phone fields `inputmode="tel"`; Arabic and English digits are both accepted where the desktop accepts them.

## Phone audit script (required)
Add `nota-frontend/scripts/mobile-audit.mjs` (a dev script, not part of the build; Playwright as a devDependency, using the installed Chrome channel so it does not download browsers):
- signs in as an owner against a running local backend with seed data;
- opens **every** admin route (including detail routes with a seeded id) at 390×844 and at 1280×800;
- at 390: fails if `document.documentElement.scrollWidth > innerWidth`, if any console error appears, or if the phone shell (tab bar) is missing; saves a full-page screenshot per route to `nota-frontend/mobile-audit/` (git-ignored);
- at 1280: fails if the phone shell appears, and saves one screenshot per route too, so desktop regressions are visible;
- prints a table of routes with pass/fail.
Run it and include the table in the report. Zip the 390 screenshots into `mobile-audit/phone-screenshots.zip` so I can send them for review.

## Tests
- Specs for each new phone template's key behavior: the right actions per permission, the bottom-sheet filters, manual entry balance footer, the credit-sale and purchase totals equal the desktop totals for the same lines, website settings section switching, the order edit mode on the phone.
- Existing specs pass unchanged (6A's test setup already defaults to desktop).

## STEP 0 (plan, before any change)
1. The full route list with, for each route: the design file (or "pattern"), the template(s) you will add, and anything that cannot work on a phone as-is.
2. Which design fields don't exist in the backend.
3. Which design texts contradict Nota's real rules.
4. How you will keep the desktop markup untouched (and how you'll prove it: the 1280 screenshots plus the existing specs).
5. Anything in this brief you think is wrong or risky, with your alternative.

## Done means
- Admin `ng test` and the `admin` production build pass; backend `npm test` unchanged and passing; storefront tests still pass.
- The audit script passes for every route at both sizes; the report includes its table and the screenshots zip path.
- docs/ONLINE_PLAN.md has the Stage 6B section.
- Report: what was added, what was changed, the missing design fields, the contradicting design texts, and the list of things you noticed but did not do.
