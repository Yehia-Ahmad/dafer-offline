# Online Stage 4 — Website orders in the admin app

Read before starting:
- docs/ONLINE_PLAN.md (Stages 1–3 and their decisions)
- nota-backend: src/models/webOrder.model.js, src/store/* (catalog, orderPricing, whitelist), src/controllers/storeOrder.controller.js, src/controllers/creditSale.controller.js (how a credit sale is created, priced, posted, with shippingFees), src/controllers/customerCredit or the customer payments path (credit.collect, payment into a chosen box), src/services/returns.service.js and the credit-sale return path, src/cashbox/boxes.js and cashbox.controller.js (boxes, transfers), src/accounting/posting.js (SHIPPING_INCOME and the VAT split of shipping), src/utils/vat.js (computeSaleVat with shippingFees), src/auth/permissions.js, test/permissions.test.js
- nota-frontend: the credit-sales and customers modules, the cashbox module, core/print (documents, the print pipeline), the website module from Stage 3, the sidebar and its badges
- docs/design/NOTA_DESIGN_SYSTEM.md

Start in plan mode and show me the plan before changing anything. Use Node 24 and a real mongod. Run long suites with a timeout and output to a file (never piped into head). Leave no test processes behind. Never use git worktree on Windows. Never touch C:\ProgramData\Nota, the installed offline Nota, or ports 27017/27217. Never commit; I commit after I review.

## Context
Stage 3 lets customers place cash-on-delivery orders (`WebOrder`, status `new`). This stage gives the shop everything to handle them: see and edit orders, confirm them (stock reservation), send them out with a courier (the invoice), record delivery and collection, handle refusals, and get notified of new orders.

## Decisions (already made; implement exactly)
1. **Couriers.** A courier (new model `Courier`) has a name, phone, `isActive`, and two linked records created with it in one transaction:
   - a **cash box** of type `cash` (not main) named after the courier, created through the existing box-creation logic (with its account);
   - a **customer account** (the existing `Customer`) for the courier, marked as a courier so the customers list can label or filter it.
   A courier with open orders (out for delivery, not settled) or a non-zero box balance or customer balance cannot be deactivated.
2. **The invoice is created when the order leaves with the courier.** "Out for delivery" creates a **credit sale (آجل) on the courier's customer account** through the existing credit-sale creation path: same lines, the order's snapshot prices, and the delivery fee as the invoice's `shippingFees`. Stock is deducted and the sale is posted exactly like any credit sale. The courier now owes the order total.
3. **Delivered:** staff record delivery → a **customer payment on the courier's account for the collected amount, into the courier's cash box**, through the existing customer-payment path. The courier's debt becomes cash in his box.
4. **Courier hands in the cash:** an ordinary **transfer** from the courier's box to the main box (existing feature). Add a shortcut button on the courier page that opens the existing transfer dialog pre-filled; no new money logic.
5. **Refused or partly refused:** a **return on that credit sale** through the existing return path (full or chosen lines/quantities), then the payment for what was actually collected (if anything). Stock comes back and the posting is the existing return posting. For a full refusal the delivery fee follows the existing full-return rule for shipping; for a partial refusal the fee stays on the invoice.
6. **Stock reservation on confirmation, without touching selling logic.** Reserved quantity of a product = the sum of its quantities in orders that are `confirmed` or `preparing`. It is computed from `WebOrder`, not stored on the product, and it changes nothing in the POS, credit sales or purchases. It is used by:
   - the website: availability, `maxOrderQty` and the placement check use `inventoryCount − reserved`;
   - confirming and editing an order: each line must fit in `inventoryCount − reserved by other orders`;
   - the admin product page and list: "محجوز لطلبات الموقع: N" when N > 0.
   If the POS sold reserved stock and the credit sale at dispatch fails for lack of stock, the dispatch is refused with the per-line problem and the order stays as it was.
7. **Editing before dispatch.** While an order is `new`, `confirmed` or `preparing`, staff can change quantities, remove lines, add products (any non-archived product, not only website-visible ones), change the zone/delivery fee and the contact data. Prices of existing lines keep their snapshot; added lines take the current price. Totals are recomputed on the server with the Stage 3 pricing helper. Every edit is stored in the order history (who, when, what changed). After dispatch nothing is edited; corrections go through the return.
8. **Notifications.** Every signed-in staff member with `orders.view` sees a badge with the number of `new` orders in the sidebar and hears a short sound when the number goes up. The admin app polls a small endpoint (every 20 s, only while the tab is visible). Sound can be muted per device (localStorage). Browsers block sound until the user interacts with the page: handle it silently. Phone notifications come with the PWA (Stage 6).
9. **Delivery fee VAT is the existing shipping VAT rule.** Credit sales already split `shippingFees` for VAT (Stage 21: `SHIPPING_INCOME`, `vatShipping`). The website order must show the customer the same total the invoice will have, so **fix the Stage 3 pricing helper to pass the delivery fee as `shippingFees` to `computeSaleVat`** instead of adding it after VAT. Add a test that, for VAT-inclusive, VAT-exclusive and no-VAT shops, the order total equals the total of the credit sale created at dispatch, to the piastre.

## Order statuses and actions
| From | Action | To | Effect |
|---|---|---|---|
| new | confirm | confirmed | stock check against available, reservation starts |
| new, confirmed | reject (reason required) | rejected | reservation released |
| new, confirmed, preparing | edit | same | see decision 7 |
| confirmed | start preparing | preparing | none |
| confirmed, preparing | cancel (reason required) | cancelled | reservation released |
| confirmed, preparing | send out (choose courier) | out_for_delivery | credit sale on the courier (decision 2), reservation ends |
| out_for_delivery | delivered | delivered | payment into the courier's box (decision 3) |
| out_for_delivery | delivered with returns (lines/qty) | delivered | return, then payment for the rest (decision 5) |
| out_for_delivery | refused | refused | full return (decision 5) |

- Add `refused` to the status enum. `cancelled` by the customer (Stage 3) stays only from `new`.
- Every transition is one transaction: the status change, the history entry and every invoice/payment/return it creates commit together or not at all. A transition that does not match the current status answers 409 (two staff members clicking at once must not create two invoices).
- The order stores links to what it created: `creditSaleId`, `paymentIds`, `returnIds`, `courierId`. The credit sale stores the order number in its notes or a reference field so it can be traced from the invoice.
- Accounting dates follow the existing lock rules: if the period is locked, the action is refused with the existing message.

## Permissions
- New keys: `orders.view` (see orders and the badge), `orders.manage` (confirm, edit, prepare, reject, cancel), `orders.dispatch` (send out, delivered, returns, refused). Group "website".
- An action that creates a credit sale, payment or return also requires the existing permission for that document (`credit.create`, `credit.collect`, `returns.create`), checked the same way the existing routes check them.
- Couriers: create/edit/deactivate need `website.manage` plus `customers.manage`.
- Role templates: owner all; manager all; cashier `orders.view`, `orders.manage`, `orders.dispatch`; others none. Update the catalog, labels, templates, `EXPECTED_ROUTES` and the frontend list.

## Website customers (from Stage 3)
- A "عملاء الموقع" page (`website.manage`): list with search by name/phone, their orders count, deactivate/activate, and **reset password**: generates a temporary password shown once to the staff member, and increases `tokenVersion` so the customer's sessions end.
- The public login page will say "forgot your password? contact the shop" (Stage 5 builds it).

## Backend
- Admin API under `/api/orders` (list with filters: status, date range, search by number/phone/name, courier; detail; the actions above; `GET /api/orders/summary` → `{ newCount }` for the badge) and `/api/couriers`, `/api/website/customers`.
- **Reuse, don't rewrite.** Credit sale, customer payment, return and transfer must go through the same in-transaction functions the existing routes use, so pricing, VAT, posting, stock, audit and document numbers behave exactly as today. If a function is only reachable through an Express handler (it reads `req`/`res`), STEP 0 must show the smallest extraction that keeps its behavior identical, and every existing test must pass unchanged. **Do not change how those documents are priced or posted.**
- Price-below-cost: the dispatching user is checked by the existing rule for the lines' prices.
- The website (Stage 3 public API) shows the new statuses on the customer's order pages and tracking; `refused` shows like `cancelled` to the customer.

## Frontend (admin app)
Follow docs/design/NOTA_DESIGN_SYSTEM.md, Arabic and English, light and dark.
1. **Sidebar:** "الطلبات" in the website group with the new-orders badge; "المناديب" and "عملاء الموقع".
2. **Orders list:** tabs by status with counts, search, date range, courier filter; each row: number, time, customer, phone, zone, total, status, courier.
3. **Order page:** contact and address (with a "copy" button and a WhatsApp link to the customer's number), lines with stock and reserved info, totals, history, and the actions allowed by status and permission. The edit mode follows decision 7. "Send out" asks for the courier. "Delivered with returns" lets the user choose lines and quantities and shows the amount to collect.
4. **Print:** a **delivery note** (إذن تسليم) through the existing print pipeline: shop header, order number, customer name/phone/address, zone, lines, delivery fee, **amount to collect**, notes; 80 mm and A4 like the other documents. The credit-sale invoice prints as today.
5. **Couriers page:** list (name, phone, box balance, amount owed, open orders), add/edit/deactivate, and the "hand in cash" shortcut (decision 4). A courier page with their open and recent orders.
6. **Website customers page** (above).
7. **Product page/list:** reserved quantity (decision 6).
8. **Sound and badge** (decision 8), with a mute toggle.
9. New i18n keys in ar and en (same key count).

## Tests (backend, `test/online-stage4.test.js`)
At least:
- the full happy path: new → confirmed → preparing → out_for_delivery → delivered; check stock, the credit sale (lines, prices, shippingFees, VAT, posting), the payment into the courier's box, the courier's customer balance back to 0, and the transfer to the main box;
- order total = credit-sale total (decision 9) for VAT-inclusive, VAT-exclusive and no VAT;
- partial refusal and full refusal: stock, return posting, courier balance, delivery fee rule;
- reservation: website availability and placement use available stock; confirm/edit refuse more than available; reject/cancel/dispatch release it; POS selling is not blocked by reservations;
- dispatch fails cleanly when stock went missing (nothing created, order unchanged);
- two parallel "send out" calls create one credit sale; a wrong-status action answers 409;
- edits recompute totals, keep snapshot prices for old lines, and are in the history;
- permissions for every new route, including the extra document permissions;
- courier deactivation is blocked with open orders or balances;
- website customer password reset ends their sessions;
- locked accounting period refuses dispatch/delivery with the existing message;
- every existing test passes unchanged.
Frontend: specs for the orders list, order page actions by status, couriers page, the badge/sound service.

## STEP 0 (plan, before any change)
1. Every file you will add or edit, one line each.
2. For credit sale, customer payment, return and transfer: the exact function you will call and, if an extraction is needed, the smallest one and why it keeps behavior identical.
3. How you compute reserved quantities efficiently (indexes, aggregation) and where the website reads use them.
4. How the courier's box and customer account are created in one transaction with the courier, and how they are labeled.
5. The change to the Stage 3 pricing helper (decision 9) and which Stage 3 tests change because of it.
6. Anything in this brief you think is wrong or risky (especially accounting), with your alternative.

## Done means
- Backend `npm test` passes (old and new); frontend production build and `ng test` pass; `shellcheck deploy/*.sh` has no warnings.
- ar.json and en.json have the same keys. docs/ONLINE_PLAN.md has the Stage 4 section and decisions.
- Report: what was added, what was changed (especially any extraction from existing controllers), and the list of things you noticed but did not do.
