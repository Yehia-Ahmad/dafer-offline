# Warehouse Backend (Node.js)

Backend API for a warehouse system with:
- `categories`
- `credit-sales` (sale on credit invoices with payment tracking)
- `customers`
- `products` (each product belongs to one category)
- `sellings` (selling history with inventory deduction)

## Data Model

### Category
- `name` (required, unique)
- `image` (required, base64 string in raw or data URI format)
- `description` (required)
- `specifications` (optional, array of objects)

### Product
- `name` (required)
- `code` (required)
- `inventoryCount` (required)
- `image` (required, base64 string in raw or data URI format)
- `categoryId` (required, must exist in categories)
- `wholesalePrice` (required)
- `purchasePrice` (optional, defaults to `wholesalePrice`)
- `retailPrice` (required, must be >= wholesale price)
- `soldItemCount` (optional, defaults to `0`)
- `specifications` (optional, array of objects; defaults to a copied snapshot of the category specifications)

### Customer
- `name` (required)
- `phone` (required, unique)

### Selling
- `productId` (required, must exist in products)
- `customerName` (required)
- `customerPhone` (required)
- `shippingLocation` (optional)
- `government` (optional)
- `sellingDate` (required)
- `quantity` (required, positive integer, can also be sent as `quentity`)
- `price` (required, non-negative number, price per each sold item)
- `discountAmount` (optional, non-negative number, defaults to `0`)
- `shippingFees` (optional, non-negative number, defaults to `0`)
- `totalPrice` (auto = subtotal - discount + shipping fees)

### Credit Sale
- `customer` (required relation to `Customer`)
- `customerName` (stored snapshot for invoice history)
- `customerPhone` (stored snapshot for invoice history)
- `sellingDate` (required)
- `dueDate` (optional)
- `items` (required, one or more products)
- `totalQuantity` (auto)
- `discountAmount` (optional, non-negative number, defaults to `0`)
- `shippingFees` (optional, non-negative number, defaults to `0`)
- `totalPrice` (auto = subtotal - discount + shipping fees)
- `paidAmount` (auto from payments)
- `remainingAmount` (auto)
- `returnedPaidAmount` (cash returned to the customer because of refunds)
- `reallocatedPaidAmount` (paid amount moved from this invoice to later open invoices after a refund)
- `status` (`pending`, `partially_paid`, `paid`, `returned`)
- `payments` (array of recorded payments)
- `notes` (optional)

### Shop Profile
- `name` (required, up to 150 characters)
- `address` (optional, up to 500 characters)
- `phones` (optional, up to 3 phone numbers, each up to 30 characters)
- `logo` (optional, base64 image string in raw or data URI format, up to 500 KB decoded)
- `taxNumber` (optional, up to 50 characters)
- `commercialRegister` (optional, up to 50 characters)
- `invoiceFooter` (optional, up to 500 characters, printed at the bottom of invoices)

## Setup

1. Install dependencies:
```bash
npm install
```

2. Create `.env` file from `.env.example`:
```bash
cp .env.example .env
```

3. Run in development:
```bash
npm run dev
```

4. Run in production:
```bash
npm start
```

## Offline LAN Mode (desktop edition only)

The offline desktop edition of the admin app bundles this backend and starts it itself on the shop's main PC. It sets these variables in the process environment. They never go in `.env`, and the online deployment leaves them unset, which keeps its behavior unchanged.

| Variable | Meaning |
|---|---|
| `NOTA_LAN_MODE` | `1` turns LAN mode on. Any other value or unset means off. |
| `NOTA_LAN_SECRET` | Shared LAN secret, at least 8 characters. Startup fails in LAN mode without it. |
| `NOTA_LISTEN_HOST` | Optional bind address. Unset means all interfaces, as before. |
| `NOTA_APP_VERSION` | Desktop app version, reported by `/api/lan/info`. |
| `NOTA_INSTANCE_ID` | Stable ID of the main PC, reported by `/api/lan/info`. |
| `NOTA_AUTH` | Stage 13. `1` turns users and permissions on (login, `requirePermission` on every route, cost stripping, audit log). Any other value or unset means off, and the backend behaves exactly as before. The desktop app does not set it yet (Stage 14 does). |
| `NOTA_JWT_SECRET` | Stage 13. Signing secret of the session tokens, at least 32 characters. Startup fails with `NOTA_AUTH=1` without it. The desktop app generates it on the main PC (32 random bytes, hex), keeps it DPAPI-protected in `config.json` and always passes it. |
| `MONGO_URI` | Required in LAN mode: the backend refuses to start without it instead of falling back to `127.0.0.1:27017`. |

In LAN mode:
- Every `/api/*` request must send the secret in the `X-Nota-Lan-Key` header. Otherwise the response is `401 { "message": "كلمة سر الشبكة غير صحيحة", "code": "LAN_KEY_INVALID" }`. CORS preflight `OPTIONS` requests are let through.
- `GET /api/lan/info` returns `{ app, lanMode, appVersion, instanceId, backendVersion, serverTime }`, which clients use to check the connection, the secret and the version.
- When run as an Electron utility process, the backend posts `{ type: "ready", port }` once listening and `{ type: "error", code, message }` if listening fails. On `{ type: "shutdown" }` it stops accepting connections, gives in-flight requests up to 10 seconds, disconnects from MongoDB and exits.

With `NOTA_AUTH=1` (Stage 13), after the LAN key every `/api/*` request also needs `Authorization: Bearer <token>`, except `/api/lan/*` and `GET /api/auth/bootstrap`, `POST /api/auth/login`, `/setup-owner` and `/recover`. See `docs/OFFLINE_PLAN.md` ("Stage 13 — users and permissions") for the endpoints, the permission catalog and the route → permission table.

Stage 19: the desktop app also sends `X-Nota-Device-Id` (this PC's id) and `X-Nota-Device-Name` (its hostname, percent-encoded, at most 64 characters). The backend uses them only to pick the default cash box of that PC and to list the PCs (`GET /api/devices`, `cashbox.manage`). **They are not authentication**: permissions, shifts and the audit log follow the signed-in user, and an id that is not 8-64 letters, digits, dots, dashes or underscores is ignored.

## API Endpoints

### Categories
- `GET /api/categories`
- `GET /api/categories/export`
- `GET /api/categories/:id`
- `POST /api/categories`
- `POST /api/categories/import` (multipart form-data with an `.xlsx` file in the `file` field)
- `PUT /api/categories/:id`
- `DELETE /api/categories/:id`

Category exports contain a `Categories` sheet and a `Products` sheet. The
`Products` sheet contains one row per product with its complete inventory,
pricing, image, specifications, timestamps, and category details. Oversized
Base64 values are continued in numbered columns such as `ImageBase64_2`.
Category imports process both worksheets, link products using `CategoryName`,
and return `productImportedCount`, `productSkippedCount`, and `productErrors`
alongside the category import result.

Sample category payload:
```json
{
  "name": "Electronics",
  "imageBase64": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAUA",
  "description": "Electronic devices and accessories",
  "specifications": [
    {
      "name": "Color",
      "value": "Black"
    },
    {
      "name": "Size",
      "value": "Medium"
    }
  ]
}
```

### Products
- `GET /api/products?categoryId=<category_id>`
- `GET /api/products/search?q=<code_or_part_of_name>`
- `GET /api/products/export/excel`
- `GET /api/products/:id`
- `GET /api/products/profit-report?categoryId=<category_id>&productId=<product_id>&dateFrom=<YYYY-MM-DD>&dateTo=<YYYY-MM-DD>`
- `GET /api/products/:id/profit-report?dateFrom=<YYYY-MM-DD>&dateTo=<YYYY-MM-DD>`
- `POST /api/products/:id/sync-purchase-price`
- `POST /api/products`
- `PUT /api/products/:id`
- `DELETE /api/products/:id`

Sample product payload:
```json
{
  "name": "Wireless Mouse",
  "code": "WM-001",
  "inventoryCount": 100,
  "imageBase64": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAUA",
  "categoryId": "66b0b7b5a8c197aa0adf1234",
  "wholesalePrice": 8.5,
  "purchasePrice": 7.25,
  "retailPrice": 15,
  "soldItemCount": 10,
  "specifications": [
    {
      "name": "Color",
      "value": "Black"
    },
    {
      "name": "Size",
      "value": "Medium"
    }
  ]
}
```

Product profit report rows contain:
- `productName`
- `categoryName`
- `totalProfit`
- `profitValue`
- `lastSellingDate`
- `lastSellingPrice`
- `invoices` array with `invoiceId`, `type`, `sellingDate`, `sellingPrice`, `quantity`, `revenue`, `purchasePrice`, and `profit`

Profit is calculated from each product invoice item using the stored `purchasePrice`. If `dateFrom` and `dateTo` are omitted, the report includes all invoices.

`POST /api/products/:id/sync-purchase-price` copies the product's current `purchasePrice` into matching cash and credit invoice items, then recalculates each matched item's stored `profitAmount`. Send optional JSON body:

```json
{
  "dateFrom": "2026-03-01",
  "dateTo": "2026-03-31"
}
```

If `dateFrom` and `dateTo` are omitted, all invoices for that product are updated across the system.

### Shop Profile
- `GET /api/shop-profile`
- `PUT /api/shop-profile`

The shop's own details, printed on invoices. There is a single profile document.

`GET` returns the saved profile. Before anything is saved it returns empty values and does not create a document:

```json
{
  "name": "",
  "address": "",
  "phones": [],
  "logo": null,
  "taxNumber": "",
  "commercialRegister": "",
  "invoiceFooter": ""
}
```

`PUT` replaces the whole profile and returns it. Only the fields below are read; anything else in the body is ignored, and an optional field that is left out (or sent empty) is cleared. `name` is required. Validation errors return `400` with a `message`.

Sample shop profile payload:
```json
{
  "name": "Al Noor Auto Parts",
  "address": "10 Example Street, Nasr City, Cairo",
  "phones": ["+201234567890", "+201098765432"],
  "logo": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAUA",
  "taxNumber": "123-456-789",
  "commercialRegister": "98765",
  "invoiceFooter": "Items can be exchanged within 14 days with the invoice."
}
```

### Customers
- `GET /api/customers`
- `GET /api/customers?search=<name_or_phone>`
- `GET /api/customers?name=<customer_name>&phone=<customer_phone>`
- `GET /api/customers/:id`
- `POST /api/customers`
- `PUT /api/customers/:id`
- `POST /api/customers/:id/payments`
- `DELETE /api/customers/:id`

Sample customer payload:
```json
{
  "name": "Ahmed Ali",
  "phone": "+201234567890"
}
```

The customer create/update endpoints also accept `customerName` and `customerPhone` as aliases.

`GET /api/customers/:id` now returns the customer document plus:
- `lastCreditSaleDate`
- `lastCashSaleDate`
- `lastCreditSalePaymentDate`
- `creditSummary`
- `creditHistory`

`GET /api/customers` returns each customer with:
- `isIndebted`: `true` when the customer has at least one open credit invoice with a remaining balance

Each entry in `creditHistory` is a normalized credit-sale invoice tied to that customer.

`creditSummary` includes:
- `debtStatusSummary`
- `totalDebtAmount`
- `paidAmount`
- `remainingAmount`
- `totalRefundDueAmount`
- `totalReturnedPaidAmount`
- `totalReallocatedPaidAmount`

If a customer has related credit-sale records, deleting that customer is blocked.

`POST /api/customers/:id/payments` adds a payment to either the customer's first open invoice or last open invoice.
Send exactly one of `firstInvoice` or `lastInvoice` as `true` together with the payment `amount`.
If `firstInvoice` is selected, the entered `amount` cannot be greater than that invoice `remainingAmount`.
If `lastInvoice` is selected and the entered `amount` is greater than the last invoice `remainingAmount`, the backend automatically distributes the extra amount to the customer's other open invoices in newest-to-oldest order.
If the entered `amount` is greater than the total remaining balance across all open invoices, the API returns `400` with `message`, `invoiceId`, `remainingAmount`, and `totalRemainingAmount`.

Sample customer payment payload:
```json
{
  "amount": 150,
  "firstInvoice": false,
  "lastInvoice": true,
  "paymentDate": "2026-03-20",
  "note": "Customer installment"
}
```

### Credit Sales
- `GET /api/credit-sales`
- `GET /api/credit-sales?customerId=<customer_id>&status=<pending|partially_paid|paid|returned>&sellingDate=<YYYY-MM-DD>`
- `GET /api/credit-sales/:id`
- `POST /api/credit-sales`
- `PUT /api/credit-sales/:id`
- `DELETE /api/credit-sales/:id`
- `POST /api/credit-sales/:id/payments`
- `POST /api/credit-sales/:id/refunds`

All credit-sale filters are optional and can be combined together. Supported filters are:
- `customerId`
- `customerName`
- `customerPhone`
- `status`
- `sellingDate`
- `dueDate`

Creating a credit sale accepts either `customerId` for an existing customer, or `customerName` + `customerPhone` to link or create the customer automatically.

Credit-sale refunds support:
- partial returns by sending specific `items`
- full returns by sending `refundAll: true`
- automatic inventory restoration
- recalculating `totalPrice`, `remainingAmount`, and `refundDueAmount`
- when a partial return makes the source invoice overpaid, the excess is applied automatically to the customer's other open credit invoices in ascending order
- any remaining excess after settling other open credit invoices is returned to the customer and stored in `returnedPaidAmount`
- auto-transferred paid amounts are stored in `reallocatedPaidAmount`

Sample credit-sale payload:
```json
{
  "customerId": "67d0b7b5a8c197aa0adf1234",
  "sellingDate": "2026-03-14",
  "dueDate": "2026-04-14",
  "notes": "Monthly installment",
  "discountAmount": 10,
  "shippingFees": 25,
  "initialPaidAmount": 100,
  "items": [
    {
      "productId": "66b0b7b5a8c197aa0adf1234",
      "quantity": 2,
      "price": 150
    },
    {
      "productId": "66b0b7b5a8c197aa0adf5678",
      "quantity": 1,
      "price": 300
    }
  ]
}
```

Sample credit-sale response:
```json
{
  "_id": "67d0b7b5a8c197aa0adf9999",
  "invoiceId": "67d0b7b5a8c197aa0adf9999",
  "customerId": "67d0b7b5a8c197aa0adf1234",
  "customerName": "Ahmed Ali",
  "customerPhone": "+201234567890",
  "sellingDate": "2026-03-14T00:00:00.000Z",
  "dueDate": "2026-04-14T00:00:00.000Z",
  "status": "partially_paid",
  "notes": "Monthly installment",
  "itemCount": 2,
  "refundCount": 0,
  "totalQuantity": 3,
  "discountAmount": 10,
  "shippingFees": 25,
  "totalPrice": 615,
  "paidAmount": 100,
  "remainingAmount": 515,
  "refundDueAmount": 0,
  "refundStatus": "none",
  "refundedQuantity": 0,
  "refundedAmount": 0,
  "returnedPaidAmount": 0,
  "reallocatedPaidAmount": 0,
  "payments": [
    {
      "_id": "67d0b7b5a8c197aa0adf7777",
      "amount": 100,
      "paymentDate": "2026-03-14T00:00:00.000Z",
      "note": null
    }
  ],
  "refunds": [],
  "items": [
    {
      "_id": "67d0b7b5a8c197aa0adf1111",
      "invoiceId": "67d0b7b5a8c197aa0adf9999",
      "productId": "66b0b7b5a8c197aa0adf1234",
      "productName": "Wireless Mouse",
      "categoryName": "Electronics",
      "productQuantity": 2,
      "productQuentity": 2,
      "sellingDate": "2026-03-14T00:00:00.000Z",
      "dueDate": "2026-04-14T00:00:00.000Z",
      "customerId": "67d0b7b5a8c197aa0adf1234",
      "customerName": "Ahmed Ali",
      "customerPhone": "+201234567890",
      "productPricePerEach": 150,
      "totalPrice": 300
    }
  ],
  "createdAt": "2026-03-14T08:00:00.000Z",
  "updatedAt": "2026-03-14T08:00:00.000Z"
}
```

Sample payment payload:
```json
{
  "amount": 150,
  "paymentDate": "2026-03-20",
  "note": "Second installment"
}
```

`POST /api/credit-sales/:id/payments` pays the selected invoice first.
If the entered `amount` is greater than that invoice `remainingAmount`, the backend automatically distributes the extra amount to the customer's other open invoices in newest-to-oldest order.
If the entered `amount` is greater than the total remaining balance across all of the customer's open invoices, the API returns `400` with `message`, `invoiceId`, `remainingAmount`, and `totalRemainingAmount`.

Sample partial refund payload:
```json
{
  "refundDate": "2026-03-21",
  "note": "Customer returned one unit",
  "items": [
    {
      "productId": "66b0b7b5a8c197aa0adf1234",
      "quantity": 1
    }
  ]
}
```

Sample full refund payload:
```json
{
  "refundDate": "2026-03-22",
  "note": "Customer returned the full invoice",
  "refundAll": true
}
```

When the full invoice is returned, the backend also returns the invoice `paidAmount` automatically and stores it in `returnedPaidAmount`, so the invoice net `paidAmount` becomes `0`.
When the full invoice is returned, the invoice `status` becomes `returned`.
When a partial return makes the invoice overpaid, the backend reallocates that overpaid amount to the customer's other open credit invoices before returning any leftover cash.

### Cash boxes, shifts, expenses (Stage 19)
- `GET /api/cashbox/boxes`, `POST /api/cashbox/boxes`, `GET|PUT|DELETE /api/cashbox/boxes/:id`, `GET /api/cashbox/boxes/:id/ledger`, `GET /api/cashbox/payment-boxes`
- `GET|POST /api/cashbox/transfers`, `POST /api/cashbox/transfers/:id/cancel`
- `GET|POST /api/cashbox/drawings`, `POST /api/cashbox/drawings/:id/cancel` (owner only)
- `GET|POST /api/shifts`, `GET /api/shifts/:id`, `POST /api/shifts/:id/close`
- `GET|POST /api/expenses`, `POST /api/expenses/:id/cancel`, `GET|POST /api/expenses/categories`, `PUT /api/expenses/categories/:id`
- `GET /api/devices`
- `GET /api/customers/:id/credit`, `POST /api/customers/:id/payouts`, `POST /api/customers/:id/payouts/:payoutId/cancel`, `POST /api/customers/:id/apply-credit`
- Money documents take an optional `boxId` (sales, receipts and payments, down payments, cash returns, the down-payment refund of a cancelled credit invoice).

### Sellings
- `GET /api/sellings`
- `GET /api/sellings?categoryId=<category_id>&productId=<product_id>&customerName=<customer_name>&sellingDate=<YYYY-MM-DD>`
- `GET /api/sellings/:id`
- `POST /api/sellings`
- `PUT /api/sellings/:id`
- `DELETE /api/sellings/:id`

All selling filters are optional and can be combined together.

When creating a selling, the backend checks the customer by `customerName` and `customerPhone`. If no exact match exists, it creates the customer record. If the phone already exists with a different name, the customer name is updated to match the selling payload.

`POST /api/sellings` accepts either the legacy single-item payload or the new invoice-style payload with one or more entries inside `items`. The backend stores the whole request as a single invoice document, and each line item is kept inside `items`.

Sample bulk selling payload:
```json
{
  "customerName": "Ahmed Ali",
  "customerPhone": "+201234567890",
  "sellingDate": "2026-03-12",
  "discountAmount": 10,
  "shippingFees": 25,
  "items": [
    {
      "productId": "66b0b7b5a8c197aa0adf1234",
      "quantity": 2,
      "price": 150
    },
    {
      "productId": "66b0b7b5a8c197aa0adf5678",
      "quantity": 1,
      "price": 300
    }
  ]
}
```

Sample bulk selling response:
```json
{
  "_id": "67d0b7b5a8c197aa0adf9999",
  "invoiceId": "67d0b7b5a8c197aa0adf9999",
  "customerName": "Ahmed Ali",
  "customerPhone": "+201234567890",
  "sellingDate": "2026-03-12T00:00:00.000Z",
  "itemCount": 2,
  "totalQuantity": 3,
  "discountAmount": 10,
  "shippingFees": 25,
  "totalPrice": 615,
  "items": [
    {
      "_id": "67d0b7b5a8c197aa0adf1111",
      "invoiceId": "67d0b7b5a8c197aa0adf9999",
      "productId": "66b0b7b5a8c197aa0adf1234",
      "productName": "Wireless Mouse",
      "categoryName": "Electronics",
      "productQuantity": 2,
      "productQuentity": 2,
      "sellingDate": "2026-03-12T00:00:00.000Z",
      "customerName": "Ahmed Ali",
      "customerPhone": "+201234567890",
      "productPricePerEach": 150,
      "totalPrice": 300
    },
    {
      "_id": "67d0b7b5a8c197aa0adf2222",
      "invoiceId": "67d0b7b5a8c197aa0adf9999",
      "productId": "66b0b7b5a8c197aa0adf5678",
      "productName": "Keyboard",
      "categoryName": "Electronics",
      "productQuantity": 1,
      "productQuentity": 1,
      "sellingDate": "2026-03-12T00:00:00.000Z",
      "customerName": "Ahmed Ali",
      "customerPhone": "+201234567890",
      "productPricePerEach": 300,
      "totalPrice": 300
    }
  ]
}
```

Sample selling invoice from `GET /api/sellings`:
```json
{
  "_id": "67d0b7b5a8c197aa0adf9999",
  "invoiceId": "67d0b7b5a8c197aa0adf9999",
  "customerName": "Ahmed Ali",
  "customerPhone": "+201234567890",
  "sellingDate": "2026-03-12T00:00:00.000Z",
  "itemCount": 2,
  "totalQuantity": 3,
  "discountAmount": 10,
  "shippingFees": 25,
  "totalPrice": 615,
  "items": [
    {
      "_id": "67d0b7b5a8c197aa0adf1111",
      "invoiceId": "67d0b7b5a8c197aa0adf9999",
      "productId": "66b0b7b5a8c197aa0adf1234",
      "productCode": "WM-001",
      "productName": "Wireless Mouse",
      "categoryName": "Electronics",
      "productQuantity": 2,
      "productQuentity": 2,
      "sellingDate": "2026-03-12T00:00:00.000Z",
      "customerName": "Ahmed Ali",
      "customerPhone": "+201234567890",
      "productPricePerEach": 150,
      "totalPrice": 300
    }
  ]
}
```
