# Online Stage 7A — Campaigns, results, pixels, catalog and leads

Branch: `marketing` (taken from `online`). Read before starting:
- docs/ONLINE_PLAN.md (all stages and Fixes 1), docs/help/HELP_AR.md
- nota-backend: src/models/webOrder.model.js, src/store/* (catalog, whitelist, orderPricing), storeOrder.controller.js, storeCatalog.controller.js, src/services/webOrders.service.js (which documents an order creates), the expense module (expense.controller.js, its model and categories, how it posts), the credit/cash sale models (lines, cost, totals, returns), src/utils/clock.js (local business day), src/auth/permissions.js, test/permissions.test.js
- nota-storefront: routing, the server (server.ts: /health, sitemap, robots), the product page, cart, checkout, order success page, the settings service
- nota-frontend: the website settings page (tabs), the expenses module, customers, the help content and scripts/export-help.mjs, the mobile patterns (6A/6B)
- deploy/templates/nginx-*.conf (rate limits)

Start in plan mode and show me the plan before changing anything. Use Node 24 and a real mongod. Run long suites with a timeout and output to a file. Leave no test processes behind. Never use git worktree on Windows. Never touch C:\ProgramData\Nota, the installed offline Nota, or ports 27017/27217. Never commit; I commit after I review.

## Context
Shop owners advertise on Facebook, Instagram and TikTok but can't tell which ads bring real sales. This stage lets them: create campaigns in Nota with their own tracking links, see visits, orders, sales and real profit per campaign, record ad spend (as an accounting expense) to see what each pound returned, add the Meta and TikTok pixels to the website, publish a product catalog feed for Facebook/Instagram/TikTok, and keep a list of leads (people who asked through messages or lead-form ads). **No platform API is used in this stage**; nothing needs approval from Meta or TikTok.

## Hard rules
- **No change to how sales, orders, returns, payments or stock are priced or posted.** Results are read-only aggregations over existing documents. Ad spend goes through the existing expense path.
- Dates and "today" always use the shop's local business day (Fixes 1 rule, utils/clock.js), never UTC slices.
- The storefront sends no personal data to any platform: pixels get product ids, values and the order number, never names, phones or addresses.
- Every public endpoint is whitelisted and rate-limited like Stage 3.
- Desktop + phone layouts (6A/6B patterns); help sections for everything new (coverage specs stay green); HELP_AR.md regenerated.

## 1. Campaigns and tracking links
- Model `Campaign`: name, `code` (short, unique, URL-safe, generated, editable before first use), platform (`facebook`, `instagram`, `tiktok`, `whatsapp`, `messenger`, `other`), type (`paid`, `organic`), landing target (`home`, a product, a category, or a custom storefront path), start date, optional end date, optional planned budget, notes, status (`active`, `ended`, `archived`), createdBy.
- Two links per campaign, shown with copy buttons and a QR code:
  - the full link: the landing URL with `utm_source=<platform>&utm_medium=<paid|organic>&utm_campaign=<code>`;
  - a short link `https://<domain>/go/<code>` served by the storefront server: counts a click (server-side, no personal data: campaign, local day, a coarse device type) and redirects (302) to the full link. Unknown or archived code → home page.
- **Attribution (storefront):** on any landing with `utm_campaign` (or via `/go/`), store `{ code, source, medium, landedAt }` in first-party storage, **last click wins**, kept for an attribution window (setting, default 7 days). Quote and order placement send it; the backend checks the code exists and stores the attribution snapshot on the `WebOrder`. Orders with no or expired attribution are "direct".
- **Visits:** `POST /api/store/visits { code }` once per browser session per campaign per day (a random session id in first-party storage; no IP stored), rate-limited in nginx. Counted per campaign per local day.
- Admin screens: campaigns list (status chips, platform filter, date range, KPIs per row), campaign page (links, QR, results, spend, leads), add/edit.

## 2. Results
For a date range (local days), per campaign and per platform:
- clicks (short link), visits, orders placed, orders completed (an invoice exists: sent out / picked up and not refused), cancelled/rejected/refused orders;
- **sales** = invoice totals of the campaign's completed orders minus their returns;
- **gross profit** = those sales minus their cost of goods, from the posted invoices/returns (shown only with the existing "عرض سعر الشراء والربح" permission);
- conversion rate (completed orders ÷ visits), average order value;
- **ad spend** (section 3), **cost per order**, **return on spend** (sales ÷ spend), **profit after ads** (gross profit − spend).
- A platforms comparison and a simple daily chart (visits, orders, sales).
- The same numbers for "direct" (no campaign) and for each answer of "عرفتنا منين؟" (section 5).
- STEP 0 must show exactly which collections and fields each number reads, and prove it matches the invoices/returns (a test builds orders through the real flows and checks every number by hand).

## 3. Ad spend
- "تسجيل مصروف إعلان" on the campaign page creates an **expense through the existing expense path**: a category «دعاية وإعلان» (created if missing, as a normal expense category under operating expenses), the chosen box, the amount, the local date, optional VAT like any expense, and a link `campaignId` on the expense (optional field, not read by posting). Requires `expenses.create`.
- The expense list shows the campaign; cancelling the expense removes it from the campaign's spend.
- If the owner paid with a personal card (no box), the help explains the options with the existing features (a bank box for the card, or a manual entry); do not add new posting logic.

## 4. Pixels and catalog
- **Settings** (website settings, new "التسويق" tab): Meta Pixel ID (digits, 15–16), TikTok Pixel ID (letters/digits), "اطلب موافقة الزبون على الكوكيز" (default on), attribution window (days), show "عرفتنا منين؟" (default on) and its options.
- **Storefront:** when an ID is set, load the official pixel script after the page is interactive and, when consent is on, only after the visitor accepts a small consent bar (remembered). Never during SSR. Events:
  - Meta: PageView, ViewContent (product: id, value, currency EGP), AddToCart, InitiateCheckout, Purchase (value = order total, currency EGP, `eventID` = order number).
  - TikTok: the matching standard events (ViewContent, AddToCart, InitiateCheckout, and the order event; use TikTok's documented names), with the same values and the order number as event id.
  - No names, phones, emails or addresses, hashed or not. Lighthouse mobile on home and product must stay ≥ 90 with both pixels set.
- **Catalog feed:** `GET https://<domain>/feeds/catalog.csv` (and `.xml` if one format doesn't fit both platforms) served by the storefront server from the public API, cached for 1 hour: every website-visible product with id, title, description, availability (in stock / out of stock, never the number), condition new, price and sale price in EGP, product link with `utm_source=<facebook|tiktok>&utm_medium=catalog`, absolute image link (the public image URL), additional images, brand (shop name unless the product has one), product type (category). Use the column names Meta Commerce Manager and TikTok's catalog accept (document them in the help). The settings tab shows the feed link(s) with copy buttons and short instructions.

## 5. Leads (العملاء المحتملين)
- Model `Lead`: name, phone (normalized like StoreCustomer, optional if a profile link is given), profile link (optional, must be a facebook.com / instagram.com / tiktok.com / wa.me / m.me URL), source (`facebook`, `instagram`, `tiktok`, `whatsapp`, `messenger`, `website`, `walk_in`, `other`), campaign (optional), status (`new`, `contacted`, `interested`, `not_interested`), notes, last contact date, createdBy. Duplicate phones are refused with a link to the existing lead.
- **"اشترى؟" is computed, not stored:** a lead whose phone matches a website order, a credit-sale customer, or a cash sale with that phone shows «اشترى» with the count, total and the documents, from the lead's creation date on (read-time lookup; no hooks in sales).
- Screens: list (search by name/phone, chips by status and source, campaign filter), add/edit (full page on the phone), lead page with a WhatsApp button (`https://wa.me/<20…>`), a call button, the purchases found, and notes history.
- **Import:** upload a CSV/XLSX exported from Meta Lead Ads or TikTok lead forms; auto-map common headers (full_name / name, phone_number / phone, created_time, campaign_name, ad_name, platform), let the user fix the mapping, preview, choose skip or update for existing phones, and optionally attach all rows to a Nota campaign. Report imported / updated / skipped / invalid rows. Max 5,000 rows.
- **Website checkout:** the optional "عرفتنا منين؟" select (options from settings), stored on the order.

## Permissions
- New: `marketing.view` (campaigns, results), `marketing.manage` (create/edit campaigns, pixel and catalog settings), `leads.manage` (add/edit/import leads). Profit numbers also need the existing cost/profit permission; recording spend also needs `expenses.create`.
- Role templates: owner all; manager all; cashier `leads.manage` only. Update the catalog, labels, generated role descriptions, EXPECTED_ROUTES, the frontend, the help.

## Server
- nginx: rate limits for `POST /api/store/visits` and the storefront's `/go/` (generous, e.g. 60/min per IP), cache headers for `/feeds/`.
- No new secrets.

## Tests
- Backend (`test/online-stage7a.test.js`): attribution stored on orders (valid, unknown, expired code), last click wins, visits dedupe and rate of one per session/day, every result number checked against orders built through the real flows (delivered, refused, partly returned, wallet, pickup, cancelled, direct), spend through the expense path and cancel, leads (normalization, duplicates, computed purchases, import mapping and skip/update), feed content (only visible products, no stock numbers), permissions and the route table, local-day boundaries (pin the clock to 00:30 Cairo).
- Storefront: attribution storage and window, /go redirect and click count, pixel loading only after consent and never on the server, event payloads have no personal data, the checkout field, the feed format.
- Admin: campaigns, results (profit hidden without permission), spend dialog, leads list/import/page, settings tab; phone layouts.
- Phone audit for every new route at 390 and 1280.

## STEP 0 (plan, before any change)
1. Every file you will add or edit, one line each.
2. The exact data each result number reads, and how returns and cancellations are handled.
3. How attribution flows from the landing page to the order, and what is stored.
4. The pixel event mapping for Meta and TikTok (from their docs) and the consent flow.
5. The feed columns for Meta and TikTok.
6. How ad spend reuses the expense path, and the expense category/account.
7. Anything in this brief you think is wrong or risky, with your alternative.

## Done means
- Backend, admin, storefront tests and the admin and storefront builds pass; the help coverage specs pass and HELP_AR.md is up to date; the phone audit passes.
- docs/ONLINE_PLAN.md has the Stage 7A section.
- Report: what was added, what was changed, the parts only testable on a real server (pixels in Meta Events Manager / TikTok, the feed in Commerce Manager), and the list of things you noticed but did not do.
