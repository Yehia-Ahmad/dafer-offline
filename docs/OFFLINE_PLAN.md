# Offline Edition Plan

## Context
- This repo is a standalone offline edition: a generic product to be sold to many shops. It has no website, no mobile app, and no Firebase.
- The main PC runs a bundled MongoDB and the backend; other PCs connect to it over the shop LAN through Electron (electron-offline).
- Backend: Express + Mongoose (kapomatic-backend). Frontend: Angular standalone components (kapomatic-frontend).
- The full online edition lives in a different repo and must not be touched.

## General rules for every change
- Do not change any logic in selling, credit sales, returns, or inventory except lines that relate to the website or Firebase.
- No refactoring or side improvements. If you notice something worth fixing, list it at the end of your reply instead of fixing it.
- Every stage ends with: backend tests (npm test), npm run build:offline, npm run test:offline, npm run smoke:offline, and a grep review.
- Never commit. I commit after I review.

## Cleanup plan
1. Remove Firebase and push notifications.
2. Remove website code from the backend (website orders, website images, public pages, SEO, cart).
3. Remove settings (e-commerce, shipping, general settings) and replace them with a simple ShopProfile.
4. Remove website code from the frontend.
5. One-time migration that cleans old website data from existing databases.

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
- Start from an opening balance, not retroactive entries: inventory (quantity × purchase price), customer balances from credit sales, cash and supplier balances entered by the user, and the difference goes to capital.
- Automatic restocking during invoice edits is recorded as an "inventory adjustment" until purchases exist, then removed.
- Optional period closing; closed periods cannot be edited. sync-purchase-price is blocked in closed periods and creates an adjustment entry in open ones.
- Multiple cash boxes and payment methods (default: one cash box), with shift closing that records cash shortages and overages.
- Two layers: a simple layer (expenses, collections, supplier payments, profit/cash/balance reports) and an accounting layer behind a permission (chart of accounts, manual entries, trial balance, income statement, balance sheet).
- VAT is an optional per-shop setting and is posted to a VAT payable account. E-invoicing is a later phase.
- Money is rounded to 2 decimals in journal entries.
- Current behavior (intended, to be replaced): DELETE /api/sellings/:id and DELETE /api/credit-sales/:id remove only the invoice record and do not restore stock; the UI warns users to process returns first. In the accounting phase, delete becomes cancel: status cancelled, reversing journal entry, and restoring the units that were not already returned.
- createSellingInvoice still has an unused options param (requireShippingLocation, requireGovernment, defaultSellingDate, defaultQuantity) left over from website checkout; remove it when createSellingInvoice is modified for accounting.
