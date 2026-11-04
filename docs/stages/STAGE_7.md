# Stage 7 — Design foundation

Read docs/OFFLINE_PLAN.md and docs/design/NOTA_DESIGN_SYSTEM.md first. Start in plan mode and show me the plan before changing anything.

Goal: put the Nota design system into the frontend as a foundation (tokens, font, library themes, shared UI building blocks, a preview page). Individual screens are NOT redesigned in this stage (that is Stages 9–10), but global changes (font, colors) will naturally show up on existing screens; that is expected, as long as nothing breaks.

No backend changes. No changes to business logic, services or API calls.

## STEP 0 — Findings (read-only)

Report before changing anything:
1. Angular version; versions of Angular Material, PrimeNG and Tailwind; how each is themed today (files, presets, custom palettes).
2. How dark mode works today: ThemeService, what class or attribute it toggles and on which element, and where it is persisted.
3. How RTL/LTR is switched today (dir attribute, where).
4. Fonts declared today (styles.scss @font-face, tailwind config, component styles) and which components use which font.
5. Existing global styles in styles.scss and any per-component overrides of Material/PrimeNG that hardcode colors (count + main files).
6. How numbers and money are formatted today (pipes, toFixed, toLocaleString, digits used).

## STEP A — Font (offline)

- Bundle **Alexandria** locally: prefer the npm package `@fontsource/alexandria` (or `@fontsource-variable/alexandria`) with weights 400, 500, 700, 800 and Arabic + Latin subsets. If no package exists, add the font files under `src/assets/fonts/alexandria/` (download via npm only; no CDN links at runtime).
- Make Alexandria the global font for the app, Material and PrimeNG (typography config, CSS variables, Tailwind `fontFamily.sans`).
- After switching, remove fonts that nothing uses any more (Montserrat, Roboto, SinkinSans, the "Azonix" alias) and their @font-face rules. Grep first and list what you removed.

## STEP B — Design tokens

- Create `src/styles/_tokens.scss` (or similar) with every color token from NOTA_DESIGN_SYSTEM.md as CSS custom properties on `:root`, plus radius, spacing and shadow tokens.
- Dark values under the same selector ThemeService already uses for dark mode (do not change how ThemeService toggles; just hook the tokens to it).
- Add `font-variant-numeric: tabular-nums` utility (e.g. `.num`) and use it in the shared components below.
- Body: background `var(--bg)`, color `var(--text)`.

## STEP C — Library themes mapped to tokens

- **Tailwind**: extend theme colors with the token names (`brand`, `surface`, `surface-2`, `border`, `text`, `muted`, `success`, `danger`, …) pointing to the CSS variables, so `bg-surface`, `text-muted`, `border-border` etc. work in both themes.
- **Angular Material**: primary = brand, warn = danger; surfaces, outline and text colors from the tokens; form-field, button, dialog, snackbar, table, menu and checkbox must look right in light and dark. Radius from tokens.
- **PrimeNG**: same mapping using the theming mechanism of the installed version (preset / CSS variables). Buttons, inputs, dialogs, dropdowns, tables, toasts.
- Remove hardcoded colors in global overrides that conflict with the tokens. Do not touch per-screen component styles yet (later stages), except where a global change makes a screen unreadable; list those.

## STEP D — Shared UI building blocks

Create a small shared UI set (standalone, under `src/app/shared/ui/` or the existing shared module folder), following the component specs in NOTA_DESIGN_SYSTEM.md. Keep them simple and reusable; prefer CSS classes or thin wrappers over heavy components where that is simpler:
- Buttons: primary, secondary, danger (classes or directive), min-height 44px.
- Form field styles: label above, input, select, textarea, hint, error text (work with Reactive Forms and with Material/PrimeNG inputs already used in the app).
- Card.
- Page header: title, optional subtitle, actions slot, optional back link.
- KPI card: label, value, note (note color variants).
- Status pill: variants ok, due, overdue, info, neutral.
- Data table styling (a CSS class usable on plain tables, plus matching overrides for mat-table / p-table): header row, row divider, numeric cells, horizontal scroll wrapper.
- Dialog shell: header with title + close button, body, footer bar with actions (to be used inside MatDialog or p-dialog, whichever the app uses most).
- Empty state.
- Money/number pipe `notaMoney` / `notaNumber`: formats with thousands separators and 0–2 decimals. Digits: Arabic-Indic (٠١٢٣) when the UI language is Arabic and Latin when English, using Intl.NumberFormat ('ar-EG' / 'en-EG'). Display only; inputs must keep accepting Latin digits. Do not replace existing formatting in screens yet; just create and test the pipe.

Each building block gets a minimal spec (renders, variants apply the right class).

## STEP E — UI kit preview page

- Add a route `/ui-kit` that shows every token (color swatches with names) and every building block in all variants, in a layout similar to the design. Not linked from the menu.
- It must work without the backend (static content only).

## STEP F — Visual check (screenshots)

- Run the dev server (`npm start` or `ng serve`), open `/ui-kit` with Playwright/Chromium headless, and take screenshots: light RTL (Arabic), dark RTL, light LTR (English), each at 1440×960. Also screenshot one existing screen that does not need the backend to render its layout (if any) in light and dark.
- Save them outside the repo (e.g. `~/nota-review/stage-7/`) and tell me the paths. Do not commit screenshots.
- Look at the screenshots yourself and fix obvious problems (unreadable text, wrong colors in dark mode, broken RTL) before reporting.

## VERIFICATION (run all even if one fails)

- backend: npm test
- frontend: npm run build:offline (report new warnings and bundle size before/after)
- frontend: npx ng test --watch=false --browsers=ChromeHeadless
- frontend: npm run test:offline (on Linux the Windows-only auto-backup drive test is expected to fail; report anything else)
- frontend: npm run smoke:offline — only if a usable mongod exists on this machine; otherwise write "skipped (no mongod on this OS)"
- grep src for hardcoded hex colors in global styles that should now be tokens; report counts before/after (screen-level component styles are expected to still have some).

Do not commit.

## Final report — exactly this, in one code block

```
=== STAGE 7 REPORT ===
Findings (versions, theming, dark mode, RTL, fonts, number formatting):
Font: package/files used, weights, fonts removed:
Tokens file and dark-mode hook:
Tailwind / Material / PrimeNG mapping (what changed):
Shared UI building blocks (name → file):
Money/number pipe behavior (examples ar / en):
UI kit route:
Screenshots (paths) and problems fixed after looking at them:
Screens that look broken or unreadable after the global change (list, not fixed):
Backend npm test:
npm run build:offline (warnings, bundle size before/after):
ng test:
npm run test:offline:
Smoke test:
Hardcoded color counts in global styles (before/after):
Unexpected findings or decisions needed from me:
git status --short:
```
