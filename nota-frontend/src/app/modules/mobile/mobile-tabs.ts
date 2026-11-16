import { NAV_ICONS } from '../layout/nav/nav-menu.config';
import { ROUTE_RULES, RouteRule } from '../../core/auth/route-permissions';

/** One entry of the bottom tab bar (Online Stage 6A, MobNav). */
export interface MobileTab {
  key: 'home' | 'pos' | 'orders' | 'stock' | 'more';
  labelKey: string;
  route: string;
  icon: string;
  /** No rule = always shown (المزيد). Otherwise the same rule as the route's guard, so a hidden tab is one the user cannot open. */
  rule?: RouteRule;
  badge?: 'newOrders';
  /** Paths (prefix) on which this tab is the active one. */
  match: readonly string[];
}

export const MOBILE_TABS: readonly MobileTab[] = [
  { key: 'home', labelKey: 'nav.items.home', route: '/home', icon: NAV_ICONS.home, rule: ROUTE_RULES.home, match: ['/home'] },
  { key: 'pos', labelKey: 'mobile.tabs.pos', route: '/selling', icon: NAV_ICONS.pos, rule: ROUTE_RULES.selling, match: ['/selling'] },
  { key: 'orders', labelKey: 'mobile.tabs.orders', route: '/orders', icon: NAV_ICONS.invoices, rule: ROUTE_RULES.orders, badge: 'newOrders', match: ['/orders'] },
  { key: 'stock', labelKey: 'mobile.tabs.stock', route: '/products', icon: NAV_ICONS.products, rule: ROUTE_RULES.products, match: ['/products'] },
  { key: 'more', labelKey: 'mobile.tabs.more', route: '/more', icon: 'M5 12h.01M12 12h.01M19 12h.01', match: ['/more'] },
];

/** The tabs this user sees. المزيد is always kept. */
export function visibleTabs(allows: (rule: RouteRule) => boolean): MobileTab[] {
  return MOBILE_TABS.filter((tab) => !tab.rule || allows(tab.rule));
}

/** Pure: which tab is active for a URL. Paths that belong to no tab (inner admin pages) highlight المزيد. */
export function activeTabKey(url: string, tabs: readonly MobileTab[]): MobileTab['key'] {
  const path = url.split(/[?#]/)[0];
  const hit = tabs.find((tab) => tab.key !== 'more' && tab.match.some((prefix) => path === prefix || path.startsWith(`${prefix}/`)));
  return hit ? hit.key : 'more';
}

/** The five root screens draw their own header; every other screen gets the shell's top bar with a back button. */
export function isRootScreen(url: string, tabs: readonly MobileTab[]): boolean {
  const path = url.split(/[?#]/)[0].replace(/\/+$/, '') || '/';
  return tabs.some((tab) => tab.route === path);
}

/** Full-screen forms have their own sticky action bar, so the tab bar is hidden there. */
export function hidesTabBar(url: string): boolean {
  const path = url.split(/[?#]/)[0];
  return /\/(new|edit)(\/|$)/.test(path) || path === '/credit-sales/new';
}
