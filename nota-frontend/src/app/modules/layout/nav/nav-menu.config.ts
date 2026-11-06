// Sidebar menu: one config for every group and item (docs/design/NOTA_DESIGN_SYSTEM.md, "Layout shell").
// Later stages turn future items on by changing `visible`.
// Stage 14: an item shows only if its route exists and the user may open it (the same rule as the
// route's guard, core/auth/route-permissions.ts).
import { ROUTE_RULES, RouteRule } from '../../../core/auth/route-permissions';

/** Everything an item's visibility rule may look at. */
export interface NavContext {
  /** Offline main PC (backup lives there only). */
  isMainPc: boolean;
  /** The signed-in user has this permission. */
  has: (key: string) => boolean;
}

export interface NavItem {
  key: string;
  /** i18n key of the label. */
  labelKey: string;
  route?: string;
  /** SVG path `d` (24×24, stroke icon) from docs/design/screens/Sidebar.dc.html. */
  icon: string;
  visible: (ctx: NavContext) => boolean;
  /**
   * Extra paths that keep the item active (prefix match), e.g. the product form under /products.
   * Without it the item is active on its route only (routerLinkActive, exact: false).
   */
  activePaths?: readonly string[];
}

export interface NavGroup {
  key: string;
  /** i18n key of the group label; none = no label row. */
  labelKey?: string;
  items: NavItem[];
}

export const NAV_ICONS = {
  home: 'M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  pos: 'M4 5h16v11H4zM8 20h8M12 16v4M8 9h3',
  credit: 'M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z',
  invoices: 'M7 3h10v18l-2.5-1.5L12 21l-2.5-1.5L7 21zM10 8h4M10 12h4',
  returns: 'M9 14L4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3',
  customers: 'M16 19v-1a4 4 0 0 0-8 0v1M12 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  products: 'M3 7l9-4 9 4v10l-9 4-9-4zM3 7l9 4 9-4M12 11v10',
  purchases: 'M3 6h11v10H3zM14 10h4l3 3v3h-7M7 19h.01M17 19h.01',
  suppliers: 'M4 21V5h10v16M14 9h6v12M8 9h2M8 13h2M8 17h2',
  cash: 'M4 5h16v14H4zM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM4 9h2M4 15h2',
  expenses: 'M12 4v12M7 11l5 5 5-5M5 20h14',
  accounts: 'M5 4h5v4H5zM14 10h5v4h-5zM14 17h5v4h-5zM7.5 8v11h6.5M7.5 12h6.5',
  reports: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  profit: 'M3 17l6-6 4 4 8-8M15 7h6v6',
  users: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6zM9 12l2 2 4-4',
  shop: 'M3 9l2-5h14l2 5M4 9v11h16V9M3 9h18M9 20v-6h6v6',
  audit: 'M9 4h6v3H9zM7 5H5v16h14V5h-2M8 11h8M8 15h8M8 19h5',
  backup: 'M12 3c4.4 0 8 1.3 8 3v12c0 1.7-3.6 3-8 3s-8-1.3-8-3V6c0-1.7 3.6-3 8-3zM4 6c0 1.7 3.6 3 8 3s8-1.3 8-3M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
} as const;

/** Screen not built yet (accounting phase). */
const notYet = () => false;
/** The route's permission rule, as its guard checks it. */
const allowed = (rule: RouteRule) => (ctx: NavContext) =>
  (!rule.mainPcOnly || ctx.isMainPc) &&
  (!rule.all || rule.all.every((key) => ctx.has(key))) &&
  (!rule.any || rule.any.some((key) => ctx.has(key)));

export const NAV_GROUPS: readonly NavGroup[] = [
  {
    key: 'main',
    items: [
      { key: 'home', labelKey: 'nav.items.home', route: '/home', icon: NAV_ICONS.home, visible: allowed(ROUTE_RULES.home) },
    ],
  },
  {
    key: 'sales',
    labelKey: 'nav.groups.sales',
    items: [
      { key: 'pos', labelKey: 'nav.items.pos', route: '/selling', icon: NAV_ICONS.pos, visible: allowed(ROUTE_RULES.selling) },
      { key: 'credit', labelKey: 'nav.items.credit', route: '/credit-sales', icon: NAV_ICONS.credit, visible: allowed(ROUTE_RULES.creditSales) },
      { key: 'invoices', labelKey: 'nav.items.invoices', route: '/invoice-history', icon: NAV_ICONS.invoices, visible: allowed(ROUTE_RULES.invoiceHistory) },
      { key: 'returns', labelKey: 'nav.items.returns', route: '/returns', icon: NAV_ICONS.returns, visible: allowed(ROUTE_RULES.returns) },
      { key: 'customers', labelKey: 'nav.items.customers', route: '/customers', icon: NAV_ICONS.customers, visible: allowed(ROUTE_RULES.customers) },
    ],
  },
  {
    key: 'inventory',
    labelKey: 'nav.groups.inventory',
    items: [
      // Stage 11: plain link; /products/profit-report belongs to "تقرير الأرباح", not here.
      { key: 'products', labelKey: 'nav.items.products', route: '/products', icon: NAV_ICONS.products, visible: allowed(ROUTE_RULES.products),
        activePaths: ['/products/new', '/products/edit/'] },
      { key: 'purchases', labelKey: 'nav.items.purchases', icon: NAV_ICONS.purchases, visible: notYet },
      { key: 'suppliers', labelKey: 'nav.items.suppliers', route: '/suppliers', icon: NAV_ICONS.suppliers, visible: allowed(ROUTE_RULES.suppliers) },
    ],
  },
  {
    key: 'treasury',
    labelKey: 'nav.groups.treasury',
    items: [
      { key: 'cash', labelKey: 'nav.items.cash', route: '/cashbox', icon: NAV_ICONS.cash, visible: allowed(ROUTE_RULES.cashbox), activePaths: ['/cashbox/'] },
      { key: 'expenses', labelKey: 'nav.items.expenses', route: '/expenses', icon: NAV_ICONS.expenses, visible: allowed(ROUTE_RULES.expenses) },
    ],
  },
  {
    key: 'accounting',
    labelKey: 'nav.groups.accounting',
    items: [
      { key: 'accounts', labelKey: 'nav.items.accounts', route: '/accounting/accounts', icon: NAV_ICONS.accounts, visible: allowed(ROUTE_RULES.accounting) },
      { key: 'opening', labelKey: 'nav.items.opening', route: '/accounting/opening', icon: NAV_ICONS.shop, visible: allowed(ROUTE_RULES.accountingOpening) },
      { key: 'journal', labelKey: 'nav.items.journal', route: '/accounting/journal', icon: NAV_ICONS.reports, visible: allowed(ROUTE_RULES.accounting) },
      { key: 'profit', labelKey: 'nav.items.profit', route: '/products/profit-report', icon: NAV_ICONS.profit, visible: allowed(ROUTE_RULES.profitReport) },
    ],
  },
  {
    key: 'admin',
    labelKey: 'nav.groups.admin',
    items: [
      { key: 'users', labelKey: 'nav.items.users', route: '/users', icon: NAV_ICONS.users, visible: allowed(ROUTE_RULES.users) },
      { key: 'audit', labelKey: 'nav.items.audit', route: '/audit', icon: NAV_ICONS.audit, visible: allowed(ROUTE_RULES.audit) },
      { key: 'shop', labelKey: 'nav.items.shop', route: '/shop-profile', icon: NAV_ICONS.shop, visible: allowed(ROUTE_RULES.shopProfile) },
      { key: 'backup', labelKey: 'nav.items.backup', route: '/backup', icon: NAV_ICONS.backup, visible: allowed(ROUTE_RULES.backup) },
    ],
  },
];

/** Groups with only their visible items; groups left empty are dropped (no orphan label). */
export function visibleNavGroups(groups: readonly NavGroup[], ctx: NavContext): NavGroup[] {
  return groups
    .map((group) => ({ ...group, items: group.items.filter((item) => item.visible(ctx)) }))
    .filter((group) => group.items.length > 0);
}
