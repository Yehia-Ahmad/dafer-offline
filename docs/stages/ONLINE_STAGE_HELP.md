# Online Stage — Help center (المساعدة)

Read before starting:
- docs/ONLINE_PLAN.md (every stage and its decisions: they are the rules the help must explain)
- docs/OFFLINE_PLAN.md (accounting, VAT, closing, shifts, permissions: the rules still apply online)
- nota-frontend: app.routes.ts and every module's routes, the sidebar/nav config, every page, dialog and settings tab, core/auth (permissions catalog and labels), the mobile shell (6A/6B), i18n ar.json
- nota-backend: src/auth/permissions.js (catalog, role templates), and the controllers/services where a rule lives when the UI alone does not show it (posting, VAT, reservations, order statuses, returns, shifts, locks)
- nota-storefront: the customer pages (for the "your website" sections)

Start in plan mode and show me the plan before changing anything. Never commit; I commit after I review.

## Goal
A help page inside the admin app that explains how to use **every** part of Nota, written for a shop owner or cashier with no technical or accounting background. Nothing may be left out: every page, every tab, every dialog, every button that does something, every field whose meaning isn't obvious, every status, and every rule that can block the user ("ليه مش قادر أعمل كذا؟").

## Decisions (already made; implement exactly)

### Where and how
1. **Route `/help`** (and `/help/:section`), open to every signed-in user, in the sidebar (bottom, "المساعدة") and in the phone's المزيد page. Works on desktop and phone (6A/6B patterns: on the phone, sections are a card list and a section is a full page).
2. **Contextual help:** a "؟" button in every page header (desktop) and in the phone top bar that opens **that page's section** (desktop: side panel; phone: full page), without leaving the page. Every route maps to a section.
3. **Search** over titles, keywords and text, with Arabic normalization (أ/إ/آ → ا، ة → ه، ى → ي، remove tashkeel and tatweel, Arabic/English digits). Results show the section and the matching paragraph.
4. **Permissions:** by default a user sees the sections for what they can use; a "عرض كل الأقسام" switch shows the rest marked "محتاج صلاحية: <permission label>".
5. **Arabic only for now** (Egyptian colloquial, the same tone as the app). The content structure must allow adding English later; the English UI shows the Arabic help with a one-line note.

### Content format
- Content lives in the frontend as structured data files, one per section (JSON or TS objects, your choice in STEP 0), with: `id`, `title`, `routes` (every route it covers), `permissions`, `keywords`, `related` (section ids), and `blocks`. Block types at least: paragraph, steps (numbered), bullet list, tip, warning, "what happens behind the scenes" (accounting/stock effect), field table (field → meaning), status table (status → meaning → what you can do), FAQ (question/answer).
- **No raw HTML** is ever rendered from content. Links to app pages are a block/inline type that renders a router link.
- Shipped with the app (no backend change). Lazy-loaded so it doesn't grow the main bundle.

### What every section must contain
1. **الصفحة دي بتعمل إيه** and who uses it (the permissions).
2. **Every task on the page as numbered steps** (e.g. "إزاي تعمل فاتورة آجل", "إزاي تلغي فاتورة").
3. **Every field** whose meaning isn't obvious (field table), with the validation rules the user will hit.
4. **Every button/action**, including the ones in ⋯ menus, dialogs and sheets, and when each one is disabled or hidden.
5. **Every status** shown on the page (status table).
6. **ورا الكواليس:** for anything that touches money, stock or accounts, what Nota records, in plain words with a small example (e.g. "بيع نقدي ١٠٠ جنيه → الخزنة تزيد ١٠٠، المخزن ينقص، ويتسجل قيد: …"). Correct accounting is the priority: take it from the code, not from memory.
7. **ليه مش قادر؟** the rules that block actions (locked period, no open shift, permissions, stock reserved for website orders, payment not verified, etc.) and what to do about each.
8. **Mistakes and how to fix them** (wrong invoice → return or cancel; wrong entry → reversal; etc.).
9. **FAQ** and links to related sections.
10. **On the phone:** anything different on the phone (where the action is, what is desktop-only, printing from the phone).

### Sections (minimum; split or add where it reads better, but cover everything)
- **ابدأ هنا:** what Nota is, signing in, the screen layout (desktop sidebar, phone tabs), and a **first-day checklist** in order: shop profile → users and roles → cash boxes and devices → categories and products (including import) → opening balances → website settings, delivery zones, payment methods → couriers → install the app on the phone and turn on notifications → first sale.
- **الرئيسية** (desktop dashboard and phone home).
- **البيع (نقطة البيع)**, discounts, payment boxes/methods, price below cost, printing, the device's default cash box and device name.
- **البيع الآجل**, customer credit, collections, refunds, applying credit, cancellation.
- **سجل الفواتير**, **المرتجعات** (cash and credit returns, return wizard).
- **العملاء** (customer page, statement, aging, courier accounts and why they can't be deleted).
- **الأصناف والفئات** (product form, VAT exemption, specifications, import/export, website fields and visibility modes, reserved quantity), **تقرير الأرباح**.
- **المشتريات**, purchase returns, cancellation; **الموردين**, supplier statement and payments.
- **الخزائن والوردية** (box types, shifts, opening/closing, differences, deposits, transfers, owner drawings), **المصروفات** (categories, cancellation).
- **الحسابات:** chart of accounts, journal, ledger, **القيد اليدوي** (balanced entries, drafts, reversal), **أرصدة البداية** (the five steps), **إقفال الفترة** (monthly/yearly, lock date, reopening), **ضريبة القيمة المضافة** (monthly return, filing, paying, unfiling), **التقارير المالية** (income statement, balance sheet, trial balance, box movements, customer/supplier balances) with how to read each.
- **الموقع:** website settings (every tab and field), delivery zones, store pickup, payment methods (cash on delivery, InstaPay, Vodafone Cash and the transfer verification), stock display and product visibility, banners and highlights, opening/closing the website.
- **طلبات الموقع:** every status for delivery and pickup, every action, editing an order, reservations and priority, sending out with a courier, delivered / delivered with returns / refused, wallet orders, the WhatsApp confirmation button, the delivery note, notifications, **with the accounting of each path** (credit sale on the courier, payment into the courier's box, transfer to the main box, cash sale into the wallet box).
- **المناديب**, **عملاء الموقع** (deactivate, reset password).
- **موقعك من ناحية الزبون:** what the customer sees and does (browse, cart, checkout, account, tracking), so the owner can explain it to customers.
- **المستخدمين والصلاحيات:** roles, every permission in the catalog with what it allows (generated from the catalog so none is missed), devices, sign out everywhere.
- **بيانات المحل** (and how they appear on invoices).
- **سجل المراجعة.**
- **الطباعة** (80 mm / A4, copies, delivery note, printing from the phone).
- **تطبيق الموبايل:** install on Android and iPhone, notifications, updates, offline banner.
- **مصطلحات:** a glossary of every accounting and app term used in the app (مدين، دائن، قيد، ترحيل، إقفال، رصيد افتتاحي، آجل، تحصيل، مرتجع، عهدة/خزنة المندوب، ...).
- **محتاج مساعدة؟** what to do when something is wrong, and what to send to support (screenshot, the order/invoice number). Backups and updates are done by Nota support, not by the shop.

## Accuracy rules
- Every rule, status, permission, field and accounting effect is taken from the code. If the code and the UI text disagree, or a behavior is unclear, do not guess: list it under "Questions" in the report.
- Permission names and labels come from the catalog. Status names come from the code's enums and their i18n labels, exactly as the user sees them.
- No feature that doesn't exist is described.

## Coverage checks (required)
- A spec walks the full router config and fails if any route (except `login`, `no-access`, `ui-kit` and redirects) is not in some section's `routes`.
- A spec fails if any permission in the catalog is not explained in the permissions section, and if any `related` id or in-content link points to a missing section/route.
- A spec checks the search normalization (أ/ا, ة/ه, ى/ي, tashkeel, digits).
- In the report, a **coverage table**: route → section → the page's actions/dialogs → covered (yes/no). Every row must be yes.

## Review export
Also generate `docs/help/HELP_AR.md`: the whole help in one Markdown file, in section order, so I can review the text in one place. Generate it from the same data by a script (`scripts/export-help.mjs`), so the two never differ; a spec checks the file is up to date.

## STEP 0 (plan, before any change)
1. The section list with, for each: its routes, permissions, and the tasks/actions/dialogs it will cover (this is the coverage table's first draft).
2. The content format and how it is rendered safely and lazily.
3. Where the "؟" button goes on desktop and phone, and how a route finds its section.
4. Anything in the code you already see as unclear or contradictory.
5. Anything in this brief you think is wrong or risky, with your alternative.

## Done means
- Admin `ng test` and the `admin` production build pass; backend and storefront untouched.
- The coverage specs pass and the coverage table is all yes.
- `docs/help/HELP_AR.md` is generated and up to date.
- docs/ONLINE_PLAN.md has a "Help center" section.
- Report: the coverage table, the "Questions" list, and the list of things you noticed but did not do.
