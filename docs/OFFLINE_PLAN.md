# Offline Edition Plan

## Context
- This repo is a standalone offline edition: a generic product to be sold to many shops. It has no website, no mobile app, and no Firebase.
- The main PC runs a bundled MongoDB and the backend; other PCs connect to it over the shop LAN through Electron (electron-offline).
- Backend: Express + Mongoose (nota-backend). Frontend: Angular standalone components (nota-frontend).
- The full online edition lives in a different repo and must not be touched.

## General rules for every change
- Do not change any logic in selling, credit sales, returns, or inventory except lines that relate to the website or Firebase.
- No refactoring or side improvements. If you notice something worth fixing, list it at the end of your reply instead of fixing it.
- Every stage ends with: backend tests (npm test), npm run build:offline, npm run test:offline, npm run smoke:offline, npx ng test --watch=false --browsers=ChromeHeadless, and a grep review.
- Never commit. I commit after I review.

## Cleanup plan
1. Remove Firebase and push notifications. (done)
2. Remove website code from the backend. (done)
3. Remove website settings, add ShopProfile. (done)
4. Remove website code from the frontend. (done)
5. Remove leftovers: old non-offline build files, unused assets, unused stubs, unused i18n keys.
6. Branding: the product is now Nota / نوتة. The old name and logo were replaced everywhere, including internal identifiers (DB name `nota`, NOTA_* env vars, nota:* IPC channels, window.notaDesktop, X-Nota-Lan-Key header, backup file prefixes, firewall rule names, ProgramData folder, discovery/quit protocol strings, secret-store entropy, 'not-nota' state, backend health-check app name `nota-backend`). (done)

## Phase 2 — Nota design
Reference: docs/design/NOTA_DESIGN_SYSTEM.md and docs/design/screens/.
6. Branding: product name, icons and logos. (done)
7. Design foundation: color tokens, Alexandria font bundled locally, Material/PrimeNG/Tailwind theme, shared components.
8. App shell: grouped sidebar, header, user card.
9. Sales screens redesign.
10. Remaining screens redesign + dashboard.

Later phases (decisions below): Users & permissions, then Accounting.

## Agreed decisions for later phases (after cleanup)

### Users and permissions
- User model: name, username, bcrypt password, role, permissions list, isActive. Login issues a JWT; the secret is generated on the main PC and stored in secret-store.
- Fine-grained permissions (e.g. sales.cancel, products.viewCost). Roles are templates: owner, manager, cashier, storekeeper, accountant. The owner can edit anyone's permissions.
- Enforcement in the backend: a requirePermission middleware on every route. Purchase price and profit are stripped from responses for users without products.viewCost.
- Every /api route requires login, except login itself and /api/lan. No public routes.
- createdBy / updatedBy on every invoice and journal entry, plus an audit log for sensitive actions.
- The owner account is created in the main PC setup wizard, together with a recovery code.
- The "price below purchase price" error must not reveal the purchase price.

### Accounting (double-entry)
- MongoDB runs as a single-member replica set so transactions work. An invoice and its journal entry are saved together or not at all.
- Journal entries are generated automatically from cash sales, credit sales, payments, returns, discounts, purchases, and expenses.
- Posted entries are never edited or deleted. Edit = reversing entry + new entry. Deleting an invoice becomes cancelling it (status: cancelled) with a reversing entry.
- New shops start with an opening-balance wizard: inventory (quantity × purchase price, auto-calculated), cash, and customer and supplier balances entered by the user; the difference goes to capital. No retroactive entries are needed because there is no historical data.
- Automatic restocking during invoice edits is recorded as an "inventory adjustment" until purchases exist, then removed.
- Optional period closing; closed periods cannot be edited. sync-purchase-price is blocked in closed periods and creates an adjustment entry in open ones.
- Multiple cash boxes and payment methods (default: one cash box), with shift closing that records cash shortages and overages.
- Two layers: a simple layer (expenses, collections, supplier payments, profit/cash/balance reports) and an accounting layer behind a permission (chart of accounts, manual entries, trial balance, income statement, balance sheet).
- VAT is an optional per-shop setting and is posted to a VAT payable account. E-invoicing is a later phase.
- Money is rounded to 2 decimals in journal entries.
- Current behavior (intended, to be replaced): DELETE /api/sellings/:id and DELETE /api/credit-sales/:id remove only the invoice record and do not restore stock; the UI warns users to process returns first. In the accounting phase, delete becomes cancel: status cancelled, reversing journal entry, and restoring the units that were not already returned.
- createSellingInvoice still has an unused options param (requireShippingLocation, requireGovernment, defaultSellingDate, defaultQuantity) left over from website checkout; remove it when createSellingInvoice is modified for accounting.
- Returns currently lower the invoice's totalPrice. In the accounting phase, store each refund's final amount and create a credit entry, so statements show the original invoice plus a separate return line.
- Credit invoices have no invoice number. In the accounting phase add sequential document numbers for all document types (cash sale, credit sale, return, receipt, payment, purchase, journal entry), and allow the returns wizard to search by invoice number.

### Other
- Selling.shippingLocation and Selling.government are website leftovers (the offline frontend never sends or reads them). Remove them together with the createSellingInvoice options param in the accounting phase. shippingFees on Selling and CreditSale is a real POS field and stays.
- The Admins page (modules/admin, route /admins, AdminsService) calls /users, /users/:id and /auth/signup, which do not exist yet. Replace or reuse it in the users/permissions phase.
