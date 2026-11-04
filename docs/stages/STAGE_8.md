# Stage 8 — App shell (sidebar, language, theme)

Read docs/OFFLINE_PLAN.md and docs/design/NOTA_DESIGN_SYSTEM.md first. Design reference: docs/design/screens/Sidebar.dc.html (sidebar) and any screen file for the page frame (e.g. Dashboard.dc.html). Start in plan mode and show me the plan before changing anything.

Use Node 20 for every command (nvm use 20).

Goal: replace the app frame (sidebar, header, page container, language/direction, theme switching) with the Nota design, using the Stage 7 tokens and shared UI. Screen contents are NOT redesigned here (Stages 9–10). No backend changes, no business-logic changes.

## STEP 0 — Findings (read-only)

1. Structure of the current shell: app.html, layout components (header, side-nav, custom-sidenav, home), what each one renders and owns.
2. Everything the current custom-sidenav does besides navigation (category list, add/edit/delete category dialog, Excel import/export of categories and products, product-exists checks, etc.). List each feature with the methods involved. **None of these features may be lost in this stage.**
3. What the header contains today (logo, theme toggle, language toggle, logout, other) and which of those still make sense offline.
4. Offline-specific shell parts (connection overlay, version notice, main-PC-only backup, runtime config role) and where they are mounted.
5. How collapse/expand of the sidebar works today and how it behaves on narrow windows.

## STEP A — Language and direction (global)

- Default UI language = Arabic for new installs (no saved choice). Keep the saved choice when one exists.
- Set `lang` and `dir` on `<html>` from LanguageService whenever the language changes (ar → rtl, en → ltr). Keep the existing per-component `[attr.dir]` bindings for now (they become redundant; remove them in Stages 9–10).
- index.html: `lang="ar" dir="rtl"` as the initial value.

## STEP B — Theme

- ThemeService: a theme the user picked and saved must win; the OS `prefers-color-scheme` change listener may only apply when the user has never picked one. Do not change how the class is applied (`html.dark`).

## STEP C — New sidebar

Build the sidebar from Sidebar.dc.html using the tokens:
- Width 248px, `--sidebar-bg`, logo tile + "نوتة"/"Nota" at the top, grouped items with group labels, active item style, inline SVG stroke icons (take the icon paths from Sidebar.dc.html), `aria-current="page"` on the active link, visible focus outline.
- Groups and items exactly as the table in NOTA_DESIGN_SYSTEM.md, **showing only items whose route exists today**:
  - (no group) الرئيسية → /home
  - المبيعات: نقطة البيع → /selling · البيع الآجل → /credit-sales · سجل الفواتير → /invoice-history · المرتجعات → /returns · العملاء → /customers
  - المخزون: الأصناف والفئات (see STEP D)
  - الحسابات: تقرير الأرباح → /products/profit-report
  - الإدارة: بيانات المحل → /shop-profile · النسخ الاحتياطي → /backup (main PC only, as today)
  - Hide a group label when the group has no visible items. Items for future screens (purchases, suppliers, cash boxes, expenses, accounts, financial reports, users) must NOT appear yet; define them in the config as disabled/hidden so later stages just flip them on.
- Drive the menu from one config array (group, key, label i18n key, route, icon, visibility rule) so later stages can add items and permission checks in one place.
- Footer of the sidebar (instead of the old header controls): language toggle (عربي / English), theme toggle (light/dark), and a device line showing "الجهاز الرئيسي" or "جهاز فرعي" from the runtime config. The user card (name, role, logout) comes in the users phase; leave a clearly marked slot for it, render nothing for now.
- Collapse: keep a collapse button; collapsed = icon-only rail (72px) with tooltips. On windows narrower than 1024px the sidebar starts collapsed; below 768px it becomes an overlay drawer with a menu button. Remember the collapsed state per device (localStorage, wrapped in try/catch).

## STEP D — Categories inside the new sidebar (temporary)

Category management moves into the Products page in Stage 10. Until then nothing may be lost:
- "الأصناف والفئات" is an expandable item; its children are the category list (each → /categories/:id), exactly like today.
- Keep every existing category action reachable from there (add category, edit, delete, Excel import/export, template download), restyled with the shared UI (notaButton, dialog shell, form field). Move the code into its own component/service if that is cleaner, but do not change the logic or API calls.
- The add/edit category dialog follows docs/design/screens/AddCategory.dc.html visually (name, image, specifications list).

## STEP E — Header and page frame

- Remove the old header if everything it had now lives in the sidebar footer; otherwise keep a slim top bar with only what is still needed, and list what stayed.
- Page container: background `--bg`, padding 28px 32px (16px on narrow windows), max content width none (screens are fluid), scrolls independently from the sidebar.
- Offline overlays (connection overlay, version notice) keep working and sit above the shell.

## STEP F — Visual check (screenshots)

- Serve the app, open these routes with Playwright/Chromium headless (no backend needed for the shell; data errors are fine): /home, /selling, /customers, /shop-profile, /ui-kit.
- Screenshots at 1440×960: light Arabic, dark Arabic, light English; plus /home at 1024×768 (collapsed rail) and 390×844 (drawer closed and open).
- Save outside the repo: `~/nota-review/stage-8/`. Look at them yourself and fix obvious problems before reporting.

## VERIFICATION (run all even if one fails)

- backend: npm test
- frontend: npm run build:offline (new warnings, bundle size before/after)
- frontend: npx ng test --watch=false --browsers=ChromeHeadless (update specs of components you changed; add specs for the menu config visibility rules and the theme preference rule)
- frontend: npm run test:offline (the Windows-only drive test is expected to fail on Linux; report anything else)
- frontend: npm run smoke:offline — only if a mongod exists; otherwise "skipped (no mongod on this OS)"
- Manual-logic check in a spec or small test: every category feature listed in STEP 0.2 is still callable from the new UI.

Do not commit.

## Final report — exactly this, in one code block

```
=== STAGE 8 REPORT ===
Old shell structure and custom-sidenav features found (list):
Where each custom-sidenav feature lives now:
Header: removed / kept (what stayed and why):
Language & direction changes:
Theme preference fix:
Sidebar: files, menu config location, visible items, hidden future items:
Collapse / narrow-window behavior:
Offline overlays check:
Screenshots (paths) and problems fixed:
Backend npm test:
npm run build:offline (warnings, bundle size before/after):
ng test:
npm run test:offline:
Smoke test:
Unexpected findings or decisions needed from me:
git status --short:
```
