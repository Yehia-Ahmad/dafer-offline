// Stage 14: the frontend route → permission map (one place). The router guards and the sidebar
// both read it; the backend enforces the same keys on every API call (nota-backend
// test/permissions.test.js EXPECTED_ROUTES). Hiding is a convenience, never the protection.

export interface RouteRule {
  /** Every key is needed. */
  all?: readonly string[];
  /** At least one key is needed. */
  any?: readonly string[];
  /** Offline main PC only (backup). */
  mainPcOnly?: boolean;
}

export const ROUTE_RULES = {
  home: { all: ['dashboard.view'] },
  selling: { all: ['sales.create'] },
  creditSales: { all: ['credit.view'] },
  creditSaleNew: { all: ['credit.create'] },
  invoiceHistory: { all: ['sales.view'] },
  // The cashier template records returns but cannot list them.
  returns: { any: ['returns.create', 'returns.view'] },
  customers: { all: ['customers.view'] },
  products: { all: ['products.view'] },
  /** Editing: products.manage (an omitted purchase price keeps the stored one). */
  productForm: { all: ['products.manage'] },
  /** Creating a product requires knowing its cost (backend: POST /api/products, same keys). */
  productNew: { all: ['products.manage', 'products.viewCost'] },
  profitReport: { all: ['reports.profit', 'products.viewCost'] },
  shopProfile: { all: ['shop.manage'] },
  backup: { all: ['backup.manage'], mainPcOnly: true },
  users: { all: ['users.manage'] },
  audit: { all: ['audit.view'] },
  accounting: { all: ['accounting.view'] },
  /** Stage 18: the opening-balance wizard (owner only by default). */
  accountingOpening: { all: ['accounting.manage'] },
  /** Stage 21: the monthly VAT return (view with vat.file or accounting.view; filing, paying and unfiling need vat.file). */
  vat: { any: ['vat.file', 'accounting.view'] },
  suppliers: { all: ['suppliers.view'] },
  supplierForm: { all: ['suppliers.manage'] },
  /** Stage 20: purchases (the backend requires products.viewCost for every purchase permission). */
  purchases: { all: ['purchases.view'] },
  purchaseNew: { all: ['purchases.create'] },
  /** Stage 19: the cash boxes page and a box's detail. A cashier opens and closes their own shift from the POS. */
  cashbox: { all: ['cashbox.view'] },
  /** Stage 19: record expenses (create), cancel them and manage the categories (manage), or just read them (cashbox.view). */
  expenses: { any: ['expenses.create', 'expenses.manage', 'cashbox.view'] },
} as const satisfies Record<string, RouteRule>;

/**
 * Where a user lands (after login, on "/", or when a page is refused): the first of these they may
 * open, in sidebar order.
 */
export const LANDING_ORDER: readonly { path: string; rule: RouteRule }[] = [
  { path: '/home', rule: ROUTE_RULES.home },
  { path: '/selling', rule: ROUTE_RULES.selling },
  { path: '/credit-sales', rule: ROUTE_RULES.creditSales },
  { path: '/invoice-history', rule: ROUTE_RULES.invoiceHistory },
  { path: '/returns', rule: ROUTE_RULES.returns },
  { path: '/customers', rule: ROUTE_RULES.customers },
  { path: '/products', rule: ROUTE_RULES.products },
  { path: '/products/profit-report', rule: ROUTE_RULES.profitReport },
  { path: '/users', rule: ROUTE_RULES.users },
  { path: '/audit', rule: ROUTE_RULES.audit },
  { path: '/purchases', rule: ROUTE_RULES.purchases },
  { path: '/suppliers', rule: ROUTE_RULES.suppliers },
  { path: '/cashbox', rule: ROUTE_RULES.cashbox },
  { path: '/expenses', rule: ROUTE_RULES.expenses },
  { path: '/accounting/accounts', rule: ROUTE_RULES.accounting },
  { path: '/accounting/opening', rule: ROUTE_RULES.accountingOpening },
  { path: '/accounting/vat', rule: ROUTE_RULES.vat },
  { path: '/shop-profile', rule: ROUTE_RULES.shopProfile },
  { path: '/backup', rule: ROUTE_RULES.backup },
];

/** Shown when the user may open no page at all (a custom role with an empty list). */
export const NO_ACCESS_PATH = '/no-access';

export function ruleAllows(rule: RouteRule, has: (key: string) => boolean, isMainPc: boolean): boolean {
  if (rule.mainPcOnly && !isMainPc) return false;
  if (rule.all && !rule.all.every(has)) return false;
  if (rule.any && !rule.any.some(has)) return false;
  return true;
}
