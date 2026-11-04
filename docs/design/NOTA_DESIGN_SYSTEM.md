# Nota — Design System

Reference for every UI change in the offline edition. The approved screen designs are in `docs/design/screens/*.dc.html` (read their markup for layout, spacing and copy; the data inside them is sample data, never real data). Brand assets are in `docs/design/brand/`.

## Brand
- Product name: **Nota** / **نوتة** (Arabic is the primary name in the UI).
- Logo mark: the bowl of the Arabic letter noon (ن) with its dot as an orange coin. SVGs: `nota-icon.svg` (with green tile), `nota-icon-small.svg` (thicker strokes, for 16–32 px), `nota-mark-light.svg` / `nota-mark-dark.svg` (no tile).
- Wordmark: the text "نوتة" in Alexandria 800, color `--brand`. Latin "nota" in Alexandria 700, lowercase.
- Never use yellow or blue as primary colors (avoid confusion with Fawry).

## Color tokens
Define as CSS custom properties on `:root` and override under the dark theme class already used by ThemeService.

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | #F5F3EE | #0B1F1C | app background |
| `--surface` | #FFFFFF | #122B27 | cards, dialogs, tables |
| `--surface-2` | #FAF9F6 | #0F2522 | table header, subtle fills |
| `--border` | #E6E2D9 | #1F3D38 | card borders |
| `--border-strong` | #CFCAC0 | #2C4D47 | inputs, secondary buttons |
| `--line` | #F0EDE6 | #1A3631 | table row dividers |
| `--text` | #142321 | #E8F0EE | primary text |
| `--text-muted` | #4A5856 | #9DB5B0 | secondary text (passes 4.5:1) |
| `--brand` | #0E4D45 | #2E8C7A | primary buttons, active nav, links |
| `--brand-soft` | #E6EFEC | #173A34 | selected states, positive pills |
| `--brand-strong-text` | #0E4D45 | #7FD1BE | text on brand-soft |
| `--accent` | #E4572E | #E4572E | logo coin and tiny highlights only, never body text |
| `--sidebar-bg` | #0E4D45 | #081815 | sidebar |
| `--sidebar-text` | #E3EFEB | #E3EFEB | sidebar items |
| `--sidebar-group` | #9FC9BE | #9FC9BE | sidebar group labels |
| `--success` | #11795F | #7FD1BE | money in, paid |
| `--danger` | #B4401F | #F4A58A | errors, shortages, overdue |
| `--danger-soft` | #FBE9E3 | #3A2620 | danger pill bg (text #9A3412 light) |
| `--warning-soft` | #FBF1D6 | #3A3220 | due / partial pill bg (text #7A5B00 light) |
| `--info-soft` | #E3EDF7 | #1D2E3D | info pill bg (text #1F4E79 light) |

## Typography
- Font: **Alexandria** (Arabic + Latin), weights 400/500/700/800. The app is offline: bundle it locally (e.g. `@fontsource/alexandria` from npm, or the font files under `src/assets/fonts`). No Google Fonts CDN.
- Use `font-variant-numeric: tabular-nums` on every money/quantity cell.
- Scale: page title 28/800 · section title 18/700 · body 14–15/400 · labels 13/400 muted · KPI value 26–30/800 · big total (POS) 32/800.

## Shape and spacing
- Radius: cards 16px · dialogs 20px · inputs/buttons 10px (large primary 12–14px) · pills 999px.
- Page padding 28px 32px; gap between blocks 18–20px; card padding 18–22px.
- Minimum touch target 44px for buttons, inputs, checkboxes rows.

## Components
- **Primary button**: bg `--brand`, white text, 700. **Secondary**: white surface, `--border-strong` border. **Danger action**: secondary style with `--danger` text.
- **Input**: 15px, padding 11px 12px, `--border-strong` border, label above (13px muted).
- **Card**: `--surface`, 1px `--border`, radius 16.
- **Table**: header row `--surface-2`, 13px/700 muted; rows divided by `--line`; numbers tabular; wide tables scroll horizontally inside the card.
- **Status pill**: 12px/700, radius 999; colors: ok/paid = brand-soft, due/partial = warning-soft, overdue/cancelled = danger-soft, info/returned = info-soft, neutral = #EFEDE8.
- **KPI card**: label 13–14 muted, value 26–30/800, optional note line.
- **Dialog**: max-width 540–640, radius 20, header with title + close (×) button, footer bar `--surface-2` with Cancel + primary action, overlay rgba(11,31,28,0.5).
- **Permission-locked action**: lock icon + short note that it needs a manager/owner permission.

## Layout shell
- RTL first (Arabic default), LTR when English is selected.
- Sidebar 248px on the right (RTL), `--sidebar-bg`, logo + "نوتة" at top, grouped items, user card at the bottom (name, role, device, logout).
- Sidebar groups and items (show an item only if its route exists in the app and, later, if the user has the permission):

| Group | Item | Route today | Status |
|---|---|---|---|
| — | الرئيسية | /home | exists (redesign as dashboard) |
| المبيعات | نقطة البيع | /selling | exists |
| | البيع الآجل | /credit-sales | exists |
| | سجل الفواتير | /invoice-history | exists |
| | المرتجعات | /returns | exists |
| | العملاء | /customers | exists |
| المخزون | الأصناف والفئات | /categories/:id, /products/edit/:id | exists |
| | المشتريات | — | accounting phase |
| | الموردين | — | accounting phase |
| الخزنة | الخزائن والوردية | — | accounting phase |
| | المصروفات | — | accounting phase |
| الحسابات | دليل الحسابات والقيود | — | accounting phase |
| | التقارير المالية | — | accounting phase |
| | تقرير الأرباح | /products/profit-report | exists |
| الإدارة | المستخدمين والصلاحيات | /admins (stub) | users phase |
| | بيانات المحل | /shop-profile | exists |
| | النسخ الاحتياطي | /backup | exists (main PC only) |

## Screen → design file
| Screen | Design file |
|---|---|
| Login | Login.dc.html |
| Opening balance wizard | Opening.dc.html |
| Dashboard (light/dark) | Dashboard.dc.html, DashboardDark.dc.html |
| POS (light/dark) | Pos.dc.html, PosDark.dc.html |
| Credit sales / new credit invoice | CreditSales.dc.html, NewCreditSale.dc.html |
| Invoice history | Invoices.dc.html |
| Returns | Returns.dc.html |
| Customers / add customer / statement | Customers.dc.html, AddCustomer.dc.html, Customer.dc.html |
| Products & categories / add category / product form | Products.dc.html, AddCategory.dc.html, ProductForm.dc.html |
| Purchases / suppliers / add supplier / pay supplier | Purchases.dc.html, Suppliers.dc.html, AddSupplier.dc.html, SupplierPayment.dc.html |
| Cash boxes & shift / add box / transfer / expenses | CashBox.dc.html, AddCashBox.dc.html, Transfer.dc.html, Expenses.dc.html |
| Chart of accounts / add account / manual entry / reports / profit | Accounts.dc.html, AddAccount.dc.html, ManualEntry.dc.html, Reports.dc.html, Profit.dc.html |
| Users / add user / shop profile / backup | Users.dc.html, AddUser.dc.html, ShopProfile.dc.html, Backup.dc.html |
| Sidebar component | Sidebar.dc.html |

The `.dc.html` files are design mockups (a custom component format with `{{holes}}` and `<sc-for>` loops). Use them as a visual and structural reference; never copy them into the app as-is.
