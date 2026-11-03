# Warehouse Backend (Node.js)

Backend API for a warehouse system with:
- `categories`
- `credit-sales` (sale on credit invoices with payment tracking)
- `customers`
- `products` (each product belongs to one category)
- `sellings` (selling history with inventory deduction)
- `cart` (checkout endpoint that creates a selling invoice)
- `shipping settings` (government shipping fees and free-shipping threshold)
- `website image targeting` (category, product, combined, and price-based image placement)

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
- `shippingLocation` (optional for selling invoices, required for cart checkout)
- `government` (required for cart checkout and selected from the configured government shipping fees)
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
- `status` (`pending`, `partially_paid`, `paid`, `Reactionary`)
- `payments` (array of recorded payments)
- `notes` (optional)

### Shipping Setting
- `governmentFees` (array of `{ government, shippingFees }`)
- `freeShippingMinimumAmount` (non-negative number, defaults to `0`)

### General Setting

- `mainLogo` (base64 image or data URI)
- `mainColor` (six-digit hex color, for example `#1A73E8`)
- `currencyCode` (three-letter ISO 4217 currency code, defaults to `EGP`)
- `freeShippingMinimumAmount` (non-negative number, defaults to `0`)
- `storeLocations` (array of `{ name, detailedLocation, mapLink }`)
- `socialMediaLinks` (array of `{ name, link }`)
- `walletPhone` (optional phone number displayed for wallet transfers)
- `instapayLink` (optional HTTPS link displayed for InstaPay transfers)
- `homePageCategoryIds` (ordered list of categories displayed on the website home page)

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
| `KAPOMATIC_LAN_MODE` | `1` turns LAN mode on. Any other value or unset means off. |
| `KAPOMATIC_LAN_SECRET` | Shared LAN secret, at least 8 characters. Startup fails in LAN mode without it. |
| `KAPOMATIC_LISTEN_HOST` | Optional bind address. Unset means all interfaces, as before. |
| `KAPOMATIC_APP_VERSION` | Desktop app version, reported by `/api/lan/info`. |
| `KAPOMATIC_INSTANCE_ID` | Stable ID of the main PC, reported by `/api/lan/info`. |

In LAN mode:
- Every `/api/*` request must send the secret in the `X-Kapomatic-Lan-Key` header. Otherwise the response is `401 { "message": "كلمة سر الشبكة غير صحيحة", "code": "LAN_KEY_INVALID" }`. CORS preflight `OPTIONS` requests are let through.
- `GET /api/lan/info` returns `{ app, lanMode, appVersion, instanceId, backendVersion, serverTime }`, which clients use to check the connection, the secret and the version.
- `/api/notifications` is not mounted, because the offline edition ships without Firebase.
- When run as an Electron utility process, the backend posts `{ type: "ready", port }` once listening and `{ type: "error", code, message }` if listening fails. On `{ type: "shutdown" }` it stops accepting connections, gives in-flight requests up to 10 seconds, disconnects from MongoDB and exits.

## API Endpoints

### Public SEO And Sitemaps

JSON sitemap data remains available for API consumers:
- `GET /api/public/seo/sitemap/pages`
- `GET /api/public/seo/sitemap/categories`
- `GET /api/public/seo/sitemap/products`
- `GET /api/public/seo/sitemap/images`

Production XML sitemap files:
- `GET /api/public/seo/sitemaps/pages-ar.xml`
- `GET /api/public/seo/sitemaps/pages-en.xml`
- `GET /api/public/seo/sitemaps/categories-ar.xml`
- `GET /api/public/seo/sitemaps/categories-en.xml`
- `GET /api/public/seo/sitemaps/products-ar.xml`
- `GET /api/public/seo/sitemaps/products-en.xml`
- `GET /api/public/seo/sitemaps/images.xml`
- `GET /api/public/seo/sitemaps/sitemap-index.xml`

If a category, product, or image sitemap grows beyond 50,000 URLs, the sitemap index points crawlers at chunked files such as:
- `GET /api/public/seo/sitemaps/products-ar-1.xml`
- `GET /api/public/seo/sitemaps/products-ar-2.xml`
- `GET /api/public/seo/sitemaps/images-1.xml`

Required public URL environment variables:
- `WEBSITE_ORIGIN`: canonical website origin, for example `https://kapomatic.com`.
- `PUBLIC_API_ORIGIN`: public API origin used for image sitemap URLs, for example `https://api.kapomatic.com`.

If `WEBSITE_ORIGIN` is missing or points to localhost, sitemap URL generation falls back to `https://kapomatic.com`. If `PUBLIC_API_ORIGIN` is missing or points to localhost, image URLs fall back to the public website origin. Sitemap XML responses use `application/xml; charset=utf-8`, the official sitemap namespace, `xhtml:link` alternates, and the Google image sitemap namespace for `images.xml`.

### Public Home Categories

- `GET /api/public/:lang/categories/home?limit=12`
- `lang` is required and accepts only `ar` or `en`.
- `limit` is optional, defaults to `12`, must be a positive integer, and is capped at `50`.
- The endpoint is public and does not require an access token.

Successful response:

```json
{
  "success": true,
  "data": {
    "categories": [
      {
        "id": "66b0b7b5a8c197aa0adf1234",
        "name": "قطع غيار ناقل الحركة",
        "slug": "قطع-غيار-ناقل-الحركة",
        "localizedSlugs": {
          "ar": "قطع-غيار-ناقل-الحركة",
          "en": "transmission-parts"
        },
        "image": {
          "url": "https://api.kapomatic.com/api/public/images/categories/66b0b7b5a8c197aa0adf1234",
          "alt": "قطع غيار ناقل الحركة"
        },
        "productsCount": 24
      }
    ]
  }
}
```

Eligibility and ordering rules:

- Categories must be present in the ordered `GeneralSetting.homePageCategoryIds` Home configuration.
- Categories must have an `EcommerceSetting` with `showOnWebsite: true`.
- The requested language must have a stored, non-empty translation name and slug. Slugs are never generated or transliterated by this endpoint. A missing alternate slug is returned as `null`.
- The Category and Product schemas do not define separate active, archive, or soft-delete fields. Deleted records are physically absent and therefore excluded by the aggregate joins.
- Home order is exactly the order of `homePageCategoryIds`. Hidden, deleted, or untranslated entries are removed without changing the relative order of the remaining entries.
- A configured and visible Category is retained when `productsCount` is `0`; its explicit Home configuration is treated as intentional.

`productsCount` uses the existing storefront availability rule. A Product is counted only when its `_id` is in that visible Category setting's `selectedProducts` and its direct `Product.category` reference matches the Category. Products not selected for the Website and physically deleted Products are excluded. The data model has no subcategory or variant relation, so no descendants or variants are added to the count. One MongoDB aggregation performs the Category, visibility, and Product-count joins; the endpoint does not issue one Products query per Category.

Category images are normally stored as validated base64 and are returned through the existing `/api/public/images/categories/:id` route. A valid stored absolute HTTP(S) URL is preserved. Missing or invalid images return `null`; server filesystem paths are never returned.

Validation errors use HTTP `400`, for example:

```json
{
  "message": "قيمة اللغة غير صالحة"
}
```

Database/server failures use HTTP `500` with a generic message and are not converted to an empty successful response:

```json
{
  "message": "تعذر تحميل فئات الصفحة الرئيسية"
}
```

### Optimized Public Home and Header

- `GET /api/public/home-page?device=desktop&locale=ar`
- `GET /api/public/home-page?device=mobile&locale=en`
- `GET /api/header?locale=ar`
- `GET /api/header?locale=en`
- `GET /api/header/logo`

Home requires `locale=ar|en` and `device=desktop|mobile`. Its response uses the dynamic storefront envelope `{ "success": true, "data": { "sections": [] } }`. Section content is stored under `settings.categories`, `settings.products`, or `settings.slides`. Product selections retain their configured order and are sliced in MongoDB before Product lookup: 10 per Category on desktop and 6 on mobile. Category and Product cards contain localized storefront fields and public image URLs, never embedded Base64 values.

Header locale is optional for compatibility and defaults to `DEFAULT_LOCALE` when that environment value is `ar` or `en`, otherwise Arabic. Navigation contains active e-commerce Categories in setting order. A stored Base64 logo is exposed through `/api/header/logo`.

Successful public responses use a 60-second shared cache policy, Express ETags, and locale/device-specific application cache keys. Mutations to Categories, Products, e-commerce settings, general settings, or website promotions invalidate the established public cache.

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

### E-commerce Website Settings

- `GET /api/ecommerce-settings/general`
- `PUT /api/ecommerce-settings/general`
- `GET /api/ecommerce-settings/home-page/categories`
- `PUT /api/ecommerce-settings/home-page/categories`
- `GET /api/ecommerce-settings/currency`
- `PUT /api/ecommerce-settings/currency`
- `GET /api/ecommerce-settings/shipping/governments`
- `PUT /api/ecommerce-settings/shipping/governments`
- `PUT /api/ecommerce-settings/shipping/free-minimum`

The existing `GET /api/ecommerce-settings/categories/active` array contract remains available. For a bounded URL-only storefront projection use `GET /api/ecommerce-settings/categories/active?projection=storefront&productLimit=10&locale=ar`; `productLimit` accepts `1` through `50`. The bounded response preserves the same Category/Product/setting row shape but does not calculate filters or return admin-only Product fields.

Set or update the website currency using its three-letter ISO 4217 code:

```json
{
  "currency": "EGP"
}
```

General settings updates are partial. Omitted fields keep their stored values; submitted arrays replace their stored arrays.

Set the ordered categories displayed on the website home page:

```json
{
  "categoryIds": [
    "66b0b7b5a8c197aa0adf1234",
    "66b0b7b5a8c197aa0adf5678"
  ]
}
```

The response contains both `categoryIds` and populated `categories`. Populated category images are public URLs rather than embedded Base64. Send an empty array to clear the home page selection.

```json
{
  "mainLogo": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==",
  "mainColor": "#1A73E8",
  "currencyCode": "EGP",
  "freeShippingMinimumAmount": 1000,
  "walletPhone": "+201234567890",
  "instapayLink": "https://ipn.eg/S/example",
  "storeLocations": [
    {
      "name": "Nasr City Store",
      "detailedLocation": "10 Example Street, Nasr City, Cairo",
      "mapLink": "https://maps.google.com/?q=30.05,31.33"
    }
  ],
  "socialMediaLinks": [
    {
      "name": "Facebook",
      "link": "https://www.facebook.com/example"
    }
  ]
}
```

Sample government shipping fees payload:
```json
{
  "governmentFees": [
    {
      "government": "Cairo",
      "shippingFees": 50
    },
    {
      "government": "Giza",
      "shippingFees": 60
    }
  ]
}
```

Sample free shipping minimum payload:
```json
{
  "freeShippingMinimumAmount": 1000
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

### Cart
- `POST /api/cart/checkout`

Creates a pending website order from the storefront checkout form. The selected government must exist in the configured government shipping fees. The backend calculates `shippingFees` from that setting and applies free shipping when the cart subtotal reaches a configured non-zero `freeShippingMinimumAmount`.

`paymentMethod` is required. Accepted values are `cash`, `wallet`, and `instapay` (`CASH`, `E_WALLET`, and `INSTAPAY` are also accepted). Wallet and InstaPay orders require `transferPhone` and `transferImage`. `transferImage` must be a base64 image string or data URI. Cash orders ignore transfer phone/image fields.

Sample checkout payload:
```json
{
  "customerName": "Ahmed Ali",
  "customerPhone": "+201234567890",
  "government": "Cairo",
  "shippingLocation": "Cairo, Nasr City",
  "paymentMethod": "wallet",
  "transferPhone": "+201234567890",
  "transferImage": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB...",
  "products": [
    {
      "productId": "66b0b7b5a8c197aa0adf1234",
      "price": 15,
      "quantity": 2
    },
    {
      "productId": "66b0b7b5a8c197aa0adf5678",
      "price": 30
    }
  ]
}
```

`quantity` is optional for cart products and defaults to `1`.

After the order is saved and the `201` response is sent, the backend sends a "new website order" push notification to every registered admin device (see Push Notifications). Sending is fire-and-forget: it never delays or fails the checkout.

### Push Notifications
- `POST /api/notifications/devices`
- `DELETE /api/notifications/devices/:token`

Both endpoints require the `X-Notifications-Key` header to equal `NOTIFICATIONS_API_KEY`. A missing or wrong key returns `401`. If `NOTIFICATIONS_API_KEY` is not configured on the server, both endpoints return `503`.

`POST` registers or refreshes an admin device's FCM token (upsert by `token`). `platform` must be `android` or `ios`. Every call updates `lastSeenAt`.

```json
{ "token": "<fcm registration token>", "platform": "android" }
```

Response `200`:
```json
{ "token": "<fcm registration token>", "platform": "android", "createdAt": "2026-10-30T10:00:00.000Z", "lastSeenAt": "2026-10-30T10:00:00.000Z" }
```

`DELETE` removes the token and returns `204` (also when the token is not registered). URL-encode the token in the path.

New website orders are sent with `sendEachForMulticast` on the Android channel `website_orders`. The message contains no customer data:

```json
{
  "notification": { "title": "طلب جديد من الموقع", "body": "الإجمالي: 1,250 ج.م • عدد المنتجات: 3" },
  "data": { "type": "website_order", "orderId": "<order id>", "totalPrice": "1250", "itemCount": "3", "route": "/website-orders" }
}
```

Tokens that FCM rejects as `registration-token-not-registered` or `invalid-registration-token` are deleted. If `FIREBASE_SERVICE_ACCOUNT` is unset or unreadable, sending is skipped and a warning is logged once.

Environment variables:
- `FIREBASE_SERVICE_ACCOUNT`: path to the Firebase service-account JSON (never commit it). Windows paths work. In `.env`, write them unquoted, in single quotes, or with forward slashes, because dotenv turns `\n` inside double quotes into a newline.
- `NOTIFICATIONS_API_KEY`: shared secret used by the mobile admin app.

### Website Image Targeting

- `POST /api/website-images`
- `GET /api/website-images`
- `GET /api/website-images/active`
- `GET /api/website-images/active-with-products`
- `GET /api/website-images/:id`
- `GET /api/website-images/:id/image`
- `PUT /api/website-images/:id`
- `DELETE /api/website-images/:id`
- `GET /api/website-images/:id/products`

Example price-targeted image:

```json
{
  "title": "Summer offer",
  "imageBase64": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==",
  "targetType": "price",
  "categoryIds": ["66b0b7b5a8c197aa0adf1234"],
  "maxPrice": 500,
  "isActive": true
}
```

Example view-only image:

```json
{
  "imageBase64": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==",
  "viewOnly": true
}
```

Targeting rules:

- `viewOnly: true` creates a display-only website image. It only requires `imageBase64`/`image` and does not require `targetType`, categories, products, price, or specifications.
- `category` requires at least one `categoryIds` entry and resolves no products.
- `product` requires at least one `productIds` entry.
- `both` requires at least one category and one product.
- `price` requires `maxPrice` and resolves products using `retailPrice`. Optional `categoryIds` restrict the price query to those categories.
- Duplicate IDs are removed, and every referenced category and product must exist.
- `active-with-products` returns `imageUrl` instead of repeating the large `imageBase64` value. Product targets are resolved in one deduplicated projected query, and the public result is cached until a related model mutation invalidates it. Use the returned image URL directly as the image source.

### Credit Sales
- `GET /api/credit-sales`
- `GET /api/credit-sales?customerId=<customer_id>&status=<pending|partially_paid|paid|Reactionary>&sellingDate=<YYYY-MM-DD>`
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
When the full invoice is returned, the invoice `status` becomes `Reactionary`.
When a partial return makes the invoice overpaid, the backend reallocates that overpaid amount to the customer's other open credit invoices before returning any leftover cash.

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
```systemctl status mongod
sudo systemctl start mongod

uname -r  6.17.9-76061709-generic

sudo systemctl restart mongod
systemctl is-active mongod
npm run dev
