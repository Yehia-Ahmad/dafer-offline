# Online Stage 5B — The storefront app

Read before starting:
- docs/ONLINE_PLAN.md (Stages 1–5A)
- The designs: docs/design/screens/WebHome.dc.html, WebProduct.dc.html, WebCheckout.dc.html (source of truth for layout, spacing, colors, copy tone), docs/design/NOTA_DESIGN_SYSTEM.md, docs/design/brand/
- The public API: nota-backend/src/routes/store.routes.js, src/store/whitelist.js (every field the storefront gets)
- The old Kapomatic website at `<KAPOMATIC_WEBSITE_PATH>`: reference for features and flows only, never copy its code
- deploy/: setup-server.sh, update.sh, make-release.js, templates/ (nginx, systemd)
- nota-frontend/angular.json (the admin app's build) and src/environments/*

Start in plan mode and show me the plan before changing anything. Use Node 24. Run long suites with a timeout and output to a file. Leave no test processes behind. Never use git worktree on Windows. Never touch C:\ProgramData\Nota, the installed offline Nota, or ports 27017/27217. Never commit; I commit after I review.

## Context
The backend and admin side of the website are done (Stages 3, 4, 5A). This stage builds what the customer sees: a separate Angular app, `nota-storefront`, with server-side rendering so Google can read the shop's products, and moves the admin app to `/admin/`.

## Decisions (already made; implement exactly)
1. **New folder `nota-storefront/`**: Angular 20 (same major as the admin app), standalone components, `@angular/ssr`. Its own package.json. No PrimeNG/Material: plain components styled from the designs (CSS variables, Alexandria bundled locally like the admin app, RTL).
2. **Arabic only for now**, `dir="rtl"`. Keep every text in one translations file so English can be added later; no language switcher.
3. **Brand color** from the public settings (`brandColor`) as a CSS variable; every place the designs use `{{brand}}` uses it.
4. **URLs** (same domain):
   - `/` home, `/c/:id/:slug` category, `/search?q=` search, `/p/:id/:slug` product, `/cart`, `/checkout`, `/order/:token` order placed + tracking, `/login`, `/register`, `/account` (orders, order detail, addresses, profile), `/policies/returns`, `/policies/terms`, `/delivery` (zones and fees), and a 404 page.
   - A wrong slug redirects (301) to the right one.
   - `/admin/` is the admin app; `/api/` the backend.
5. **Pages not in the designs** (category/search list, cart, order placed/tracking, login/register, account, policies, delivery, closed, 404): build them from the same visual language as the three designs (header, cards, buttons, inputs, spacing, colors). Keep them simple.
6. **Cart** lives in the browser (localStorage, SSR-safe: never touched on the server), with product id, quantity, and the last-seen name/price/image only for display. The checkout always sends ids and quantities; the server's 409 line problems (not available, quantity over stock) are shown on the lines with a fix action.
7. **Checkout** follows WebCheckout.dc.html: contact, fulfillment (delivery with zone + address, or pickup, only the enabled ones), payment (only the enabled methods), notes, the summary with the server-confirmed totals. Before placing, the summary is priced by the server: add `POST /api/store/orders/quote` (same body as placing, no idempotency key, creates nothing, returns the same totals and line problems) — this is the only backend change in this stage, with tests. One idempotency key per checkout attempt (kept until the order succeeds), so a double click or retry never creates two orders.
8. **Signed-in customers**: login/register by phone + password, "forgot your password? contact the shop" with the shop's WhatsApp link, saved addresses in the checkout, order history. The token is kept in localStorage and sent as a Bearer header; never read on the server.
9. **After placing**: `/order/:token` shows the number, status, totals, and for wallet payments the transfer instructions (IPA / number, exact amount, order number) with a WhatsApp button to send the transfer screenshot; for COD what happens next. A guest can bookmark this page to track the order.
10. **Closed website / ordering off**: the closed page with the shop logo and `closedMessage`; with ordering off, browsing works and every add-to-cart / checkout button is disabled with the message.
11. **SEO**: server-rendered home, category, product and policy pages; per-page `<title>` and meta description (the product's name + description, the shop's `seoDescription`); Open Graph tags with the product image; JSON-LD `Product` (name, image, price, currency EGP, availability) on product pages; `/sitemap.xml` (home, visible categories, visible products) and `/robots.txt` (disallow `/cart`, `/checkout`, `/account`, `/order/`, `/admin/`) served by the storefront server from the public API; canonical URLs.
12. **Performance**: images through the public image URLs with `loading="lazy"`, width/height set, and the main product image eager; no image base64 anywhere; initial JS kept small (lazy routes). Target: Lighthouse mobile ≥ 90 for performance and accessibility on home and product pages (report the numbers you get locally).
13. **Accessibility** as in the designs: labels, focus states, 44 px touch targets, `aria-live` on cart count and quantity.

## Server and deploy
- The storefront SSR server listens on `127.0.0.1:4000` (env `NOTA_STOREFRONT_PORT`), runs as the `nota` user under a new systemd unit `nota-storefront.service` (same hardening as the backend, `TimeoutStopSec=20`). On the server it calls the API at `http://127.0.0.1:<backend port>` (env `NOTA_API_INTERNAL`); in the browser it calls `/api/`.
- nginx: `/api/` and `/health` → backend (as now); `/admin/` → the admin app's static files with SPA fallback to `/admin/index.html` and the same caching rules; everything else → the storefront server (proxy), with long cache for its hashed static files.
- Admin app: built with `baseHref` `/admin/`; check every absolute path in it (assets, i18n files, fonts, print iframe, links).
- `make-release.js` builds and packs `storefront/` too (server bundle + browser files, no node_modules; `npm ci --omit=dev` on the server if the SSR bundle needs runtime packages). `release.json` unchanged.
- `update.sh` restarts both services and waits for both health checks (backend `/health`, storefront `GET /` answering 200 or the closed page); rollback switches both back. `setup-server.sh` installs the new unit. The storefront also gets a `/health` route.
- Docs: update `docs/deploy/NEW_SERVER_AR.md` and `UPDATE_AR.md` (the admin app is now at `https://<domain>/admin/`).

## Tests
- Storefront unit tests: cart service (add, merge, max quantity, SSR safety), price/total display, checkout form validation, idempotency key reuse, the 409 line-problem mapping, slug redirect, SEO tags on product and home.
- Backend: `online-stage5b.test.js` for `POST /api/store/orders/quote` (same totals as placing, creates nothing, whitelisted, rate-limited in nginx like orders).
- A smoke script that builds the storefront, starts it against a running backend with seed data, and fetches `/`, a category, a product, `/sitemap.xml`, `/robots.txt`, checking status codes and that product names are in the server-rendered HTML.

## STEP 0 (plan, before any change)
1. Folder structure of `nota-storefront` and every file added or edited elsewhere.
2. How SSR calls the API (internal URL, timeouts, errors) and how the closed website is rendered on the server.
3. The nginx config after the change and the `/admin/` baseHref changes in the admin app.
4. How the release and update scripts handle two services and rollback.
5. Anything in this brief you think is wrong or risky, with your alternative.

## Done means
- Backend `npm test`, admin `ng test` and production build, storefront tests and production build all pass; the smoke script passes; `shellcheck deploy/*.sh` has no warnings at warning level.
- docs/ONLINE_PLAN.md has the Stage 5B section.
- Report: what was added, what was changed, the Lighthouse numbers, the parts only testable on a real server, and the list of things you noticed but did not do.
