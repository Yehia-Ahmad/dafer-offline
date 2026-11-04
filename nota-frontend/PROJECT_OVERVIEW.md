# Nota

## 1. Project Overview

Nota is an Angular-based inventory, sales, customer, returns, and e-commerce administration application. The codebase is a frontend application with optional Electron desktop packaging for Windows.

The project helps a product-based business manage its internal stock catalog, cash sales, credit sales, customers, returns, profit reporting, website orders, storefront settings, and website promotional images from one administrative interface.

Target users are business staff and administrators who manage products, categories, customer records, invoices, credit payments, returns, and e-commerce operational settings. The main value is operational control over inventory and sales activity, with supporting reports, printable invoices, exports, localization, and desktop distribution.

Verified from: `README.md`, `package.json`, `src/app/app.routes.ts`, `src/app/modules/**`.

## 2. Main Features

### Authentication and Authorization

| Feature | What It Does | Who Uses It | Main Capabilities | Related Pages or Modules | Status |
|---|---|---|---|---|---|
| Token storage | Stores an access token, user profile, and permissions in browser local storage. | Authenticated users, administrators | Save/remove access token, read user profile, check named permissions. | `src/app/modules/shared/services/disk.service.ts` | Partial |
| Auth guard | Redirects unauthenticated users to `/login` and prevents logged-in users from visiting `/login`. | Application routes | Checks `access_token` from local storage. | `src/app/core/guards/auth.guard.ts` | In Progress |
| Bearer token interceptor | Adds `Authorization: Bearer <token>` to outgoing requests. | API communication layer | Reads token from `DiskService` and clones HTTP requests with an auth header. | `src/app/core/interceptor/httpconfig.interceptor.ts` | In Progress |
| Logout interceptor | Clears local storage and redirects to `/login` on HTTP 401. | API communication layer | Handles unauthorized API responses. | `src/app/core/interceptor/logout.interceptor.ts` | In Progress |
| Offline retry interceptor | Retries network-status-related failed requests with backoff. | API communication layer | Detects browser online/offline state and retries status `0` failures. | `src/app/core/interceptor/request-online.interceptor.ts` | In Progress |

Important limitation: routes and interceptors are currently not active. `canActivate: [authGuard]` is commented out in `src/app/app.routes.ts`, and `withInterceptors([...])` is commented out in `src/app/app.config.ts`. No login route or login component is present in the inspected routing.

### User Management

| Feature | What It Does | Who Uses It | Main Capabilities | Related Pages or Modules | Status |
|---|---|---|---|---|---|
| Admin/user list | Displays users returned from the backend. | Administrators | Load users, show create/update dialogs, delete users. | `/admins`, `src/app/modules/admin/components/admins/admins.component.ts` | Complete |
| Create user | Creates a user through the signup API. | Administrators | Username, email, phone, password, role. | `src/app/modules/admin/services/admins.service.ts` | Complete |
| Update user | Updates user fields with empty values removed before sending. | Administrators | Patch user record. | `src/app/modules/admin/services/admins.service.ts` | Complete |
| Delete user | Deletes a user by ID. | Administrators | Delete confirmation and refresh list. | `src/app/modules/admin/components/admins/admins.component.ts` | Complete |

### Inventory, Categories, Products, and Models

| Feature | What It Does | Who Uses It | Main Capabilities | Related Pages or Modules | Status |
|---|---|---|---|---|---|
| Category management | Manages product categories from the side navigation. | Administrators, inventory staff | Create, update, delete categories; upload category image as Base64; define category specifications. | `src/app/modules/layout/custom-sidenav/custom-sidenav.component.ts` | Complete |
| Category import/export | Imports categories from Excel and exports categories to Excel. | Administrators, inventory staff | Generate import template, validate `.xlsx`/`.xls`, show import result, export category file. | `src/app/modules/layout/custom-sidenav/custom-sidenav.component.ts`, `src/app/modules/category/services/cateory.service.ts` | Complete |
| Product listing by category | Shows products under a category with infinite scroll and local search. | Inventory staff | Load paginated products, search by name/code, open product editor. | `/categories/:id`, `src/app/modules/category/components/category-details/category-details.component.ts` | Complete |
| Product creation | Creates products inside a category. | Inventory staff | Product name, code, inventory count, image, wholesale/purchase/retail prices, sold count, specifications. | `src/app/modules/category/components/category-details/category-details.component.ts` | Complete |
| Product editing | Edits product fields and inventory adjustments. | Inventory staff | Update product, upload image, cap discount percentage between 0 and 100, delete product. | `/products/edit/:id`, `src/app/modules/category/components/product-edit/product-edit.component.ts` | Complete |
| Purchase price sync | Sends a product-level request to sync purchase price to invoices for an optional date range. | Administrators, finance staff | Date range selection and backend sync call. | `src/app/modules/category/components/product-edit/product-edit.component.ts` | Complete |
| Product export | Exports products to Excel. | Administrators, inventory staff | Calls product export endpoint. | `src/app/modules/products/services/products.service.ts`, side navigation | Complete |
| Model and QR operations | Provides API calls for models, QR verification, and QR printing. | Inventory staff | Create/update/delete models, verify QR, print QR codes. | `src/app/modules/category/services/cateory.service.ts` | Partial |

The standalone `AddProduct` component exists but contains no implementation. Verified from `src/app/modules/category/components/add-product/add-product.ts`. Status: In Progress.

### Sales and Invoices

| Feature | What It Does | Who Uses It | Main Capabilities | Related Pages or Modules | Status |
|---|---|---|---|---|---|
| Cash selling | Creates cash sale invoices from selected products. | Sales staff | Customer search, product search, multiple items, wholesale/retail/custom price, quantity, discount, shipping fees, totals. | `/selling`, `src/app/modules/products/components/selling/selling.component.ts` | Complete |
| Insufficient inventory confirmation | Handles backend inventory shortage responses during cash sale creation. | Sales staff, managers | Detects `INSUFFICIENT_INVENTORY` conflict and resubmits with confirmation. | `src/app/modules/products/components/selling/selling.component.ts` | Complete |
| Invoice history | Lists cash sales with filters and infinite scrolling. | Sales staff, administrators | Filter by category, product, customer, phone, date; delete sale; print invoice; WhatsApp link. | `/invoice-history`, `src/app/modules/products/components/invoice-history/invoice-history.component.ts` | Complete |
| Cash returns from invoice history | Creates cash return records for selected invoice items. | Sales staff, administrators | Select returned items, cap quantity to sold quantity, set return date and note. | `src/app/modules/products/components/invoice-history/invoice-history.component.ts` | Complete |
| Invoice printing | Generates printable invoice HTML in a new browser window. | Sales staff | Bilingual invoice document support. | `src/app/modules/products/components/invoice-history/invoice-history-print.util.ts` | Complete |

### Credit Sales and Customer Debt

| Feature | What It Does | Who Uses It | Main Capabilities | Related Pages or Modules | Status |
|---|---|---|---|---|---|
| Credit sale creation | Creates credit invoices for existing or new customer details. | Sales staff, finance staff | Customer search, product search, line items, discount, shipping fees, down payment, review dialog, total receivable and financed amount. | `/credit-sales`, `src/app/modules/products/components/credit-sales/credit-sales.component.ts` | Complete |
| Credit sale records API | Supports list, detail, create, update, delete, and payment endpoints. | Credit sales UI, customer detail UI | Status filters, due dates, payments. | `src/app/modules/products/services/credit-sales.service.ts` | Complete |
| Customer credit summary | Shows credit totals and invoice status counts on the customer detail page. | Finance staff, administrators | Total invoices, open invoices, total credit, paid/remaining amounts, pending/partial/paid/overdue/due-soon counts. | `/customers/:id`, `src/app/modules/customer/components/customer-details/customer-details.component.ts` | Complete |
| Credit payment recording | Records payments against a selected credit invoice or selected first/last payable invoice for a customer. | Finance staff | Payment amount, payment date, note, remaining amount validation. | `src/app/modules/customer/components/customer-details/customer-details.component.ts` | Complete |
| Credit refunds | Creates credit return records for selected invoice items. | Finance staff, administrators | Select returned items, validate max refundable quantity, refund date, note. | `src/app/modules/customer/components/customer-details/customer-details.component.ts` | Complete |
| Credit invoice printing | Opens printable credit invoice document. | Finance staff, sales staff | Bilingual print document. | `src/app/modules/customer/components/credit-invoice-print.util.ts` | Complete |
| Credit invoice deletion | Deletes a credit sale invoice from customer detail. | Administrators, finance staff | Confirmation dialog and reload customer record. | `src/app/modules/customer/components/customer-details/customer-details.component.ts` | Complete |

### Custom / Workshop Sales

| Feature | What It Does | Who Uses It | Main Capabilities | Related Pages or Modules | Status |
|---|---|---|---|---|---|
| Custom sales list | Lists workshop/custom sales with search, status/date filters, sorting, and pagination. | Sales staff, workshop staff | View, edit, delete, cancel, mark delivered, add payment, print. | `/custom-sales`, `src/app/modules/custom-sales/components/custom-sales-list/custom-sales-list.component.ts` | In Progress |
| Custom sale form | Creates or edits a custom sale built from materials, additional components, labor, discounts, and initial payment. | Workshop staff, sales staff | Customer lookup, product lookup, materials, additional components, labor cost, delivery date, totals and remaining amount validation. | `/custom-sales/create`, `/custom-sales/:id/edit`, `src/app/modules/custom-sales/components/custom-sales-form/custom-sales-form.component.ts` | In Progress |
| Custom sale detail | Shows one custom sale and supports print/edit navigation. | Workshop staff, sales staff | Load sale details, status display, print current page. | `/custom-sales/:id`, `src/app/modules/custom-sales/components/custom-sales-detail/custom-sales-detail.component.ts` | In Progress |

This area is marked In Progress because the custom-sales files are newly added or modified in the current worktree, even though the UI routes and service methods are implemented.

### Customers

| Feature | What It Does | Who Uses It | Main Capabilities | Related Pages or Modules | Status |
|---|---|---|---|---|---|
| Customer directory | Manages customer records. | Sales staff, finance staff | List, search, create, edit, delete, open details. | `/customers`, `src/app/modules/customer/components/customers/customers.component.ts` | Complete |
| Customer deletion confirmation | Handles backend conflict when deleting a customer with related credit invoices. | Administrators, finance staff | Optional `restoreCreditInvoices` deletion request after confirmation. | `src/app/modules/customer/components/customers/customers.component.ts` | Complete |
| Customer detail | Shows customer profile and credit history. | Sales staff, finance staff | Credit summary, credit invoices, payments, refunds, invoice print, overdue/due-soon detection. | `/customers/:id`, `src/app/modules/customer/components/customer-details/customer-details.component.ts` | Complete |

### Returns

| Feature | What It Does | Who Uses It | Main Capabilities | Related Pages or Modules | Status |
|---|---|---|---|---|---|
| Returns log | Lists return records. | Administrators, sales staff, finance staff | Filter by return type, customer, phone, product code, invoice, date range; pagination; details dialog. | `/returns`, `src/app/modules/returns/components/returns/returns.component.ts` | Complete |
| Returns summary | Shows aggregate return totals. | Administrators, finance staff | Total cash returns, credit returns, returned amount, returned items. | `src/app/modules/returns/services/returns.service.ts` | Complete |
| Returns Excel export | Exports the currently loaded return rows to Excel. | Administrators, finance staff | Uses `exceljs`, translated headers, currency formatting. | `src/app/modules/returns/components/returns/returns.component.ts` | Complete |

### Reports and Analytics

| Feature | What It Does | Who Uses It | Main Capabilities | Related Pages or Modules | Status |
|---|---|---|---|---|---|
| Product profit report | Shows profit by product and invoice details. | Business owners, administrators, finance staff | Filter by category, product, date range; inspect invoice-level rows. | `/products/profit-report`, `src/app/modules/products/components/product-profit-report/product-profit-report.component.ts` | Complete |
| Profit bar PDF | Generates a yearly profit bar chart PDF. | Business owners, finance staff | Calls profit bar endpoint, renders Chart.js chart, exports with `jspdf` and `html2canvas`. | `src/app/modules/products/components/product-profit-report/product-profit-report.component.ts`, `src/app/modules/products/services/profit-bar.service.ts` | Complete |

### E-Commerce Administration

| Feature | What It Does | Who Uses It | Main Capabilities | Related Pages or Modules | Status |
|---|---|---|---|---|---|
| Category website settings | Controls whether categories/products/filters appear on the website. | E-commerce administrators | Toggle category visibility, select products, configure visible filters/specifications, reset settings. | `/ecommerce-settings`, `src/app/modules/ecommerce-settings/components/ecommerce-settings/ecommerce-settings.component.ts` | Complete |
| Government shipping fees | Configures shipping fee rows by government/governorate. | E-commerce administrators | Add/remove shipping rows, validate unique government names, non-negative fees. | `/ecommerce-settings/shipping/governments`, ecommerce settings module | Complete |
| Website general settings | Configures storefront general data. | E-commerce administrators | Logo upload, main color, free shipping minimum amount, currency, wallet phone, InstaPay link, store locations, social links. | `/ecommerce-settings/shipping/general`, ecommerce settings module | Complete |
| Home page categories | Chooses and orders active categories for the website home page. | E-commerce administrators | Load active categories, add/remove/reorder selected categories, save selection. | `/ecommerce-settings`, ecommerce settings module | Complete |
| Website images | Manages promotional or targeted website images. | E-commerce administrators | Create/edit/delete images, target by category/product/both/price/specification, view-only images, product resolution preview. | `/website-images`, `src/app/modules/website-images/**` | Complete |
| Website orders | Moderates e-commerce orders. | E-commerce administrators, sales staff | List by all/pending/accepted/refunded, infinite scroll, expand items, view transfer details, confirm, refund. | `/website-orders`, `src/app/modules/website-orders/**` | Complete |

### Localization, Theme, and Shell

| Feature | What It Does | Who Uses It | Main Capabilities | Related Pages or Modules | Status |
|---|---|---|---|---|---|
| Localization | Provides translation support for English and Arabic assets. | All users | Language stored in local storage, direction switches to RTL for Arabic. | `src/app/modules/shared/services/translation.service.ts`, `src/assets/i18n/en.json`, `src/assets/i18n/ar.json` | Partial |
| Theme | Provides dark/light mode. | All users | Saves selected theme, respects browser dark preference, adds/removes `dark` class. | `src/app/modules/shared/services/theme.service.ts` | Complete |
| Home/dashboard shell | Restores the selected home view and routes to main operational areas. | All users | Dashboard, inventory, products, e-commerce settings, website orders shortcuts. | `/home`, `src/app/modules/layout/components/home/home.component.ts` | Complete |
| Side navigation | Displays categories and administrative navigation. | All users | Category list, category CRUD, exports/imports, dynamic route links. | `src/app/modules/layout/custom-sidenav/custom-sidenav.component.ts` | Complete |

Localization is Partial because the service registers `en`, `ar`, and `zh`, but only English and Arabic translation JSON files were found in the inspected assets.

### Desktop Packaging

| Feature | What It Does | Who Uses It | Main Capabilities | Related Pages or Modules | Status |
|---|---|---|---|---|---|
| Electron desktop app | Packages the Angular build as a desktop application. | Business users on desktop | Loads built Angular output, sets window sizing, supports Windows build targets. | `electron-offline/main.js`, `electron-builder.offline.json`, `scripts/offline/` | Complete |

## 3. User Roles

Confirmed roles in the UI:

| Role | Confirmed Access | Confirmed Actions | Permission Restrictions |
|---|---|---|---|
| `admin` | Appears in admin/user create and update UI. | Can be assigned to a user through the admin management form. | Needs Verification. No active route-level role restriction was found. |
| `customer` | Appears in admin/user create and update UI. | Can be assigned to a user through the admin management form. | Needs Verification. No active route-level role restriction was found. |

Other role references:

- Translation files mention `moderator`, but the active admin component role list contains `admin` and `customer`.
- `DiskService.checkPermission()` can check named permissions stored in local storage, but no active page-level permission checks were found in the inspected routes/components.
- The route guard is present but commented out across routes, so access control cannot be confirmed as active.

Verified from: `src/app/modules/admin/components/admins/admins.component.ts`, `src/app/modules/shared/services/disk.service.ts`, `src/app/app.routes.ts`.

## 4. Main User Flows

### Registration and Login

1. Admin/user creation is available from `/admins`.
2. The form collects username, email, phone, password, and role.
3. The frontend sends the user to `auth/signup` through `AdminsService.createUser()`.
4. Login cannot be confirmed. No `/login` route or login component is present in the inspected routing.
5. Authentication support is partially present through token storage, auth guard, and interceptors, but those are not currently active in app routing/bootstrap.

### Managing Categories and Products

1. User opens the home shell and side navigation.
2. Side navigation loads categories from the categories API.
3. User can add or edit a category with name, image, and specifications.
4. User opens a category page at `/categories/:id`.
5. The page loads products by category using pagination/infinite scroll.
6. User can add a product with price, inventory, image, and specification values.
7. User can open `/products/edit/:id` to edit, delete, or sync product purchase price to invoice history.

### Cash Sale

1. User opens `/selling`.
2. User searches/selects an existing customer or enters customer details.
3. User adds one or more invoice items by searching products.
4. User chooses wholesale, retail, or custom price, sets quantity, discount, and shipping fees.
5. The UI calculates subtotal, discount percentage, shipping, and final total.
6. User submits the sale.
7. If the backend reports insufficient inventory, the UI shows shortages and allows confirmed resubmission.
8. On success, the form resets and shows a success dialog.

### Credit Sale and Payment

1. User opens `/credit-sales`.
2. User searches/selects a customer or enters customer name/phone.
3. User selects products and quantities.
4. The UI calculates subtotal, discount, shipping, total receivable, down payment, and financed amount.
5. User reviews and submits the credit sale.
6. Customer detail at `/customers/:id` shows credit history.
7. User records invoice-specific or customer-level payments.
8. Payment is posted to `credit-sales/:id/payments`.

### Customer Management

1. User opens `/customers`.
2. User searches customers or loads all customers.
3. User creates or edits customer name and phone.
4. User opens customer details to review credit summary/history.
5. User deletes a customer.
6. If backend requires confirmation because of related credit invoices, the UI asks whether to delete with `restoreCreditInvoices`.

### Returns

1. Cash returns can be started from invoice history by selecting returnable cash sale items.
2. Credit returns can be started from a customer detail credit invoice.
3. User selects item quantities, date, and optional note.
4. The UI posts a return with return type `cash` or `credit`.
5. User opens `/returns` to filter, review, inspect, and export return logs.

### Website Order Management

1. User opens `/website-orders`.
2. User switches between all, pending, accepted, and refunded scopes.
3. User expands orders to inspect line items.
4. User views transfer details where available.
5. Pending orders can be confirmed.
6. Non-refunded/non-cancelled orders can be refunded with an optional note.

### E-Commerce Settings

1. User opens `/ecommerce-settings`.
2. User selects a category and controls website visibility, selected products, and visible filters.
3. User can reset category e-commerce settings.
4. User opens shipping/general/home page sections to manage government shipping fees, storefront details, and home page category order.
5. User saves changes through the ecommerce settings API.

### Custom / Workshop Sale

1. User opens `/custom-sales`.
2. User searches, filters, sorts, or pages through workshop sales.
3. User creates a sale at `/custom-sales/create`.
4. User selects or enters customer details, final product details, material lines, additional components, labor, discount, and initial payment.
5. The UI calculates total, remaining amount, and profit amount.
6. User can view, edit, print, add payment, cancel, mark delivered, or delete the sale.
7. Status: In Progress because this feature set is currently in changed/new files in the worktree.

## 5. Pages and Modules

| Page/Module | Purpose | Main Features | Access/Role | Status |
|---|---|---|---|---|
| `/home` | Main application shell/dashboard | Restores current view, opens inventory/products/customers/e-commerce/orders/sales pages | No active guard; intended authenticated users | Complete |
| `/admins` | User administration | List, create, update, delete users | Needs Verification; admin role implied | Complete |
| `/customers` | Customer management | Search, create, edit, delete, open details | No active guard | Complete |
| `/customers/:id` | Customer details and credit history | Credit summary, payments, refunds, invoice print, delete credit invoice | No active guard | Complete |
| `/selling` | Cash sale creation | Customer/product search, multi-item invoice, discounts, shipping, inventory confirmation | No active guard | Complete |
| `/credit-sales` | Credit sale creation | Customer/product search, down payment, totals, review and submit | No active guard | Complete |
| `/custom-sales` | Custom/workshop sales list | Search, filter, sort, payment, print, delete/cancel/deliver | No active guard | In Progress |
| `/custom-sales/create` | Custom/workshop sale creation | Materials, components, labor, payment, validation | No active guard | In Progress |
| `/custom-sales/:id` | Custom/workshop sale detail | Detail view, print, edit navigation | No active guard | In Progress |
| `/custom-sales/:id/edit` | Custom/workshop sale editing | Loads existing sale into form and updates it | No active guard | In Progress |
| `/invoice-history` | Cash invoice history | Filters, infinite scroll, print, delete, cash returns, WhatsApp link | No active guard | Complete |
| `/returns` | Returns log | Filters, summary, details dialog, pagination, Excel export | No active guard | Complete |
| `/categories/:id` | Category product listing | Infinite scroll, local product search, create product, open edit | No active guard | Complete |
| `/products/edit/:id` | Product editing | Product update, delete, image upload, sync purchase price | No active guard | Complete |
| `/products/profit-report` | Product profit reporting | Category/product/date filters, invoice detail dialog, PDF chart export | No active guard | Complete |
| `/ecommerce-settings` | E-commerce category/home page settings | Category website visibility, selected products, filters, home page categories | No active guard | Complete |
| `/ecommerce-settings/shipping/general` | Storefront general settings | Logo, color, currency, wallet, InstaPay, locations, social links | No active guard | Complete |
| `/ecommerce-settings/shipping/governments` | Shipping fee settings | Government shipping fees and duplicate validation | No active guard | Complete |
| `/website-images` | Website image management | Create/edit/delete targeted images, preview resolved products | No active guard | Complete |
| `/website-orders` | Website order moderation | Scopes, item expansion, transfer details, confirm/refund | No active guard | Complete |
| `src/app/modules/assets` | Shared icon/dialog asset components | SVG/icon wrappers, warning/error components, invoice card | Shared UI | Partial |

## 6. Technical Architecture

- Frontend framework: Angular 20.3.x with standalone components. Verified in `package.json`, `src/main.ts`, and `src/app/app.config.ts`.
- UI libraries: PrimeNG 20, Angular Material, Angular SVG Icon, Font Awesome assets, Tailwind CSS styling.
- Backend technology: Not included in this repository. The frontend calls an external REST API through `environment.api_base_url`.
- Database: Not identifiable from the frontend code. Needs Verification.
- Architecture: Feature folders under `src/app/modules`, shared services under `src/app/modules/shared`, core guards/interceptors under `src/app/core`, and environment configuration under `src/environments`.
- State management: No NgRx, Akita, Redux, or similar global store was found. State is managed with Angular component state, Angular signals, RxJS subscriptions, local storage, and service calls.
- API communication: Angular `HttpClient` services per domain. Many services normalize backend response shapes to support arrays, `data`, nested `data.*`, or named collections.
- Authentication method: Bearer token support exists through local storage and an HTTP interceptor, but the interceptor is not currently registered.
- Routing: `src/app/app.routes.ts` uses direct and lazy-loaded standalone components.
- Guards and interceptors: Present but inactive in current routing/bootstrap configuration.
- Server-side rendering: not used. The SSR dependencies were removed; `provideClientHydration` is still listed in `app.config.ts`.
- Desktop: Electron wrapper loads built Angular files from `dist` and electron-builder is configured for Windows NSIS/zip/unpacked outputs.
- Testing tools: Jasmine, Karma, Karma Chrome Launcher, and Angular test builder. Many component/service spec files exist.
- Build/deployment: Angular CLI build scripts plus Electron build scripts in `package.json`. No CI/CD pipeline was found in the inspected files.

## 7. API Integrations

Base API configuration is provided by `api_base_url` in `src/environments/environment.ts` and `src/environments/environment.offline.ts`. Actual URL values are intentionally not documented here.

| API Area | Purpose | Used By | Authentication Required |
|---|---|---|---|
| `users` | List, retrieve, update, delete users | Admin module | Needs Verification; bearer support exists but inactive |
| `auth/signup` | Create users | Admin module | Needs Verification |
| `categories` | Category CRUD, active categories, export/import | Side navigation, category pages, ecommerce settings, website images | Needs Verification |
| `products` | Product CRUD, category product lists, product search, export | Category, selling, credit sales, reports, website images, custom sales | Needs Verification |
| `models` | Model CRUD, QR verification, QR printing | Category service | Needs Verification |
| `sellings` | Cash sale creation, invoice history, deletion | Selling and invoice history modules | Needs Verification |
| `credit-sales` | Credit sale CRUD and payments | Credit sales and customer detail modules | Needs Verification |
| `customers` | Customer CRUD/search/detail | Customers, sales, credit sales, custom sales | Needs Verification |
| `returns` | Create returns, list returns, return details, summary | Invoice history, customer detail, returns module | Needs Verification |
| `products/profit-report` | Product profit reporting | Product profit report module | Needs Verification |
| `products/profit-bar` | Yearly profit chart data | Profit PDF generation | Needs Verification |
| `products/export/excel` | Product export | Side navigation/products service | Needs Verification |
| `ecommerce-settings` | Category storefront settings and reset | Ecommerce settings module | Needs Verification |
| `ecommerce-settings/shipping/governments` | Government shipping fee configuration | Ecommerce settings module | Needs Verification |
| `ecommerce-settings/general` | Storefront general settings | Ecommerce settings module | Needs Verification |
| `ecommerce-settings/home-page/categories` | Home page category ordering | Ecommerce settings module | Needs Verification |
| `website-images` | Website promotional/targeted image management | Website images module | Needs Verification |
| `website-orders` | Website order list, confirm, refund | Website orders module | Needs Verification |
| `workshop-sales` | Custom/workshop sales CRUD, payments, cancellation, delivery | Custom sales module | Needs Verification |

## 8. Key Business Rules

- Cash sale requires customer name, selling date, at least one product item, product ID, quantity >= 1, and price >= 0.01. Source: `src/app/modules/products/components/selling/selling.component.ts`.
- Cash sale totals are calculated as item subtotal minus discount amount plus shipping fees, never below zero. Source: `selling.component.ts`.
- Cash sale discount percentage is derived from subtotal and discount amount. Source: `selling.component.ts`.
- Cash sale can proceed after backend insufficient-inventory confirmation only when the backend returns status `409`, code `INSUFFICIENT_INVENTORY`, `requiresConfirmation: true`, and shortages. Source: `selling.component.ts`.
- Credit sale requires customer name, customer phone, selling date, at least one item, product ID, quantity >= 1, and price >= 0.01. Source: `src/app/modules/products/components/credit-sales/credit-sales.component.ts`.
- Credit sale down payment cannot exceed total receivable. Source: `credit-sales.component.ts`.
- Product discount percentage is normalized to the range 0-100 when updating a product. Source: `src/app/modules/category/components/product-edit/product-edit.component.ts`.
- Product inventory update sends both current inventory and `newInventory`; negative new inventory is clamped to zero in the UI. Source: `product-edit.component.ts`.
- Return filters require `dateFrom <= dateTo`; otherwise a translated snack bar error is shown. Source: `src/app/modules/returns/components/returns/returns.component.ts`.
- Cash and credit return quantities are capped to available invoice quantities in the UI. Sources: `invoice-history.component.ts`, `customer-details.component.ts`.
- Customer deletion can require backend confirmation when deleting a customer with related credit invoices. Source: `src/app/modules/customer/components/customers/customers.component.ts`.
- Customer detail flags invoices as overdue when due date is before today and remaining amount is greater than zero. Source: `customer-details.component.ts`.
- Customer detail flags invoices as due soon when due date is within the next seven days, not overdue, and remaining amount is greater than zero. Source: `customer-details.component.ts`.
- E-commerce government shipping fee names must be unique and fees must be non-negative. Source: `src/app/modules/ecommerce-settings/components/ecommerce-settings/ecommerce-settings.component.ts`.
- E-commerce main color must be a six-character hex color, currency must be a three-letter code, map/InstaPay/social URLs must be HTTP(S), and wallet phone must match the configured phone pattern. Source: `ecommerce-settings.component.ts`.
- WhatsApp social links can be entered as URLs or phone numbers and are normalized to `wa.me` links. Source: `ecommerce-settings.component.ts`.
- Website image title max length is 150. Image is required on create but optional on edit. Categories/products/price/specification validators change based on target type and view-only mode. Source: `src/app/modules/website-images/components/website-images/website-images.component.ts`.
- Website orders can be confirmed only when status is `pending`; orders with `refunded`, `cancelled`, or `canceled` status cannot be refunded. Source: `src/app/modules/website-orders/components/website-orders/website-orders.component.ts`.
- Custom sale discount cannot exceed subtotal, and initial paid amount cannot exceed total price. Source: `src/app/modules/custom-sales/components/custom-sales-form/custom-sales-form.component.ts`.
- Custom sale payment cannot exceed remaining amount. Source: `src/app/modules/custom-sales/components/custom-sales-list/custom-sales-list.component.ts`.

## 9. What the Project Provides

For end users and operational staff:

- Faster product lookup, customer lookup, invoice creation, and return processing.
- Printable invoices and direct WhatsApp customer contact links.
- Arabic/English UI support and dark/light theme support.

For administrators:

- User management, category/product management, imports/exports, website settings, website image targeting, and website order moderation.
- Ability to configure storefront shipping and general settings without changing code.

For business owners and finance staff:

- Product profit reporting, yearly profit PDF generation, credit balances, payment tracking, returns summaries, and customer debt visibility.

For e-commerce operators:

- Control over website-visible categories/products/filters, promotional images, home page category order, shipping fees, and order confirmation/refund workflows.

## 10. Current Project Status

### Completed Functionality

- Angular application shell and routing for operational pages.
- Category CRUD, category import/export, and product CRUD flows.
- Cash sales, invoice history, invoice printing, cash returns, and insufficient inventory confirmation flow.
- Customer CRUD, customer credit details, credit payments, credit refunds, and credit invoice printing/deletion.
- Credit sale creation.
- Returns log with filters, details, pagination, summary, and Excel export.
- Product profit report and yearly profit PDF generation.
- E-commerce category settings, shipping settings, general settings, home page category ordering.
- Website images management.
- Website orders moderation.
- Theme support and English/Arabic localization assets.
- Electron desktop packaging scripts.

### Partially Implemented / In Progress

- Authentication and authorization: guard/interceptors exist but are not active, and no login route is present.
- Permission checks: local-storage permission support exists, but active component/route restrictions were not confirmed.
- SSR: not used (dependencies removed).
- Custom/workshop sales: feature files and routes are implemented but currently appear as new/modified worktree changes, so this area should be treated as In Progress until merged and tested.
- Model/QR workflows: service methods exist, but no complete dedicated page flow was confirmed.
- Localization: English and Arabic assets exist; `zh` is registered in code but no Chinese translation asset was found.
- Warranties: asset components and translation text exist, but no active warranty route or full warranty workflow was found in `src/app/app.routes.ts`.

### Mock or Placeholder Data

- The admin component uses a hard-coded pagination display array (`[1, 2, 3, 4, '...', 10]`) instead of backend pagination state. Source: `src/app/modules/admin/components/admins/admins.component.ts`.
- The `AddProduct` standalone component is empty. Source: `src/app/modules/category/components/add-product/add-product.ts`.
- Some translation entries reference older warranty/admin/moderator labels that are not backed by active routes or active role logic in the inspected code.

### Known Limitations

- No backend implementation is included.
- API authentication requirements cannot be confirmed from frontend code alone.
- The production and development API base URLs exist in environment files, but their values are intentionally omitted from this document.
- Route access is currently unrestricted because guard usage is commented out.
- Interceptors are currently not registered in `app.config.ts`, so bearer token injection and 401 logout behavior are not active.
- Profit PDF generation dynamically imports `html2canvas`; it is present in `package-lock.json` as a transitive dependency but not declared directly in `package.json`.
- No CI/CD workflow was found.

## 11. Project Structure

| Path | Purpose |
|---|---|
| `src/app` | Main Angular application source. |
| `src/app/app.routes.ts` | Application route definitions. |
| `src/app/app.config.ts` | Angular providers, router, HTTP client, translation, PrimeNG, hydration, and theme setup. |
| `src/app/core/guards` | Route guard support. |
| `src/app/core/interceptor` | HTTP interceptor support for authorization, logout, and offline retry behavior. |
| `src/app/core/utilities` | Shared helper functions for params, FormData, parsing, and date formatting. |
| `src/app/modules/layout` | Home shell, header, side navigation, and home view constants. |
| `src/app/modules/admin` | User/admin management components and service. |
| `src/app/modules/category` | Category/product pages and category/product/model API service. |
| `src/app/modules/products` | Selling, credit sales, invoice history, profit reports, and related services. |
| `src/app/modules/customer` | Customer list, customer details, credit history, payments, refunds, and print utilities. |
| `src/app/modules/returns` | Returns log, return models, and return API service. |
| `src/app/modules/ecommerce-settings` | Storefront/category/shipping/general/home page settings models, API constants, service, and component. |
| `src/app/modules/website-images` | Website image targeting models, service, and management UI. |
| `src/app/modules/website-orders` | Website order models, service, and moderation UI. |
| `src/app/modules/custom-sales` | Custom/workshop sales models, service, list, form, and detail UI. |
| `src/app/modules/shared` | Theme, translation, disk/local-storage services, and pagination component. |
| `src/app/modules/assets` | Reusable visual components and icon wrappers. |
| `src/assets` | App assets copied by Angular build: fonts, images, SVGs, translations. |
| `public` | Public favicon used by build/test configuration. |
| `src/environments` | Environment-specific configuration names, including `api_base_url` and `baseHREF`. |
| `electron` | electron-builder beforeBuild hook used by the offline packaging. |
| `electron-offline` | Electron main process and desktop app bootstrap for the offline edition. |
| `package.json` | Dependencies, Angular scripts, and Electron scripts. |
| `angular.json` | Angular CLI build, serve, and test configuration. |

Generated/dependency folders such as `node_modules`, `dist`, `build`, `coverage`, cache folders, and `release` are intentionally excluded.

## 12. Running the Project

### Requirements

- Node.js 20.19+ or 22.12+ for Angular 20, as noted in `README.md`.
- npm.
- Angular CLI through project scripts.
- For desktop builds: Electron/electron-builder dependencies from `package.json`.
- For Windows installer generation on Linux: Wine may be required, as noted in `README.md`.

### Commands

| Task | Command |
|---|---|
| Install dependencies | `npm install` |
| Development server | `npm start` or `ng serve` |
| Production build | `npm run build` |
| Offline Angular build | `npm run build:offline` |
| Run Electron desktop app | `npm run electron:start:offline` |
| Build Windows unpacked desktop folder | `npm run electron:build:win:offline:dir` |
| Build Windows installer | `npm run electron:build:win:offline` |
| Unit tests | `npm test` or `ng test` |

### Required Environment Variables / Configuration Names

No shell `.env` file was found. The application uses Angular environment configuration files with these names:

- `production`
- `api_base_url`
- `baseHREF`

Actual values are intentionally not included.

## 13. Summary

Nota is a business operations frontend for inventory, sales, customers, returns, reporting, and e-commerce administration. It is built with Angular 20 and can also be packaged as an Electron desktop application. The strongest implemented areas are product/category management, cash sales, credit sales, customer credit tracking, returns, profit reporting, website settings, website image targeting, and website order moderation.

The project is best suited for administrators, sales staff, finance staff, warehouse/inventory staff, and e-commerce operators who need a unified interface for day-to-day product and order operations. Authentication scaffolding exists, but active route protection and interceptor-based token usage need verification or completion before the application can be considered access-controlled.
