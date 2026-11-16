/**
 * Online Stage 6B: the logical parent of a phone screen (list ← detail ← edit), used by the top bar's back button when the page was opened
 * directly (a link, a notification, a reload) and the browser history has nothing inside the app to go back to.
 * Pure: path in, path out (null = a root tab, nothing above it). Query strings and fragments are ignored.
 */
const RULES: readonly { test: RegExp; parent: string }[] = [
  { test: /^\/credit-sales\/new$/, parent: '/credit-sales' },
  { test: /^\/products\/(new|edit\/[^/]+|profit-report)$/, parent: '/products' },
  { test: /^\/customers\/[^/]+$/, parent: '/customers' },
  { test: /^\/orders\/[^/]+$/, parent: '/orders' },
  { test: /^\/suppliers\/(new|edit\/[^/]+)$/, parent: '/suppliers' },
  { test: /^\/purchases\/(new|[^/]+)$/, parent: '/purchases' },
  { test: /^\/cashbox\/[^/]+$/, parent: '/cashbox' },
  { test: /^\/website\/couriers\/[^/]+$/, parent: '/website/couriers' },
  { test: /^\/accounting\/accounts\/[^/]+\/ledger$/, parent: '/accounting/accounts' },
  { test: /^\/accounting\/journal\/[^/]+$/, parent: '/accounting/journal' },
  { test: /^\/accounting\/manual-entry(\/[^/]+)?$/, parent: '/accounting/journal' },
  // Online Stage Help: a help section opened directly goes back to the help list.
  { test: /^\/help\/[^/]+$/, parent: '/help' },
];

/** Root tabs (the tab bar's own screens): nothing above them. */
const ROOTS = new Set(['/home', '/selling', '/orders', '/products', '/more']);

export function parentRoute(url: string): string | null {
  const path = url.split(/[?#]/)[0].replace(/\/+$/, '') || '/';
  if (ROOTS.has(path)) return null;
  for (const rule of RULES) if (rule.test.test(path)) return rule.parent;
  return '/more'; // every other page is a menu item of المزيد
}

/** True when the router has navigated inside the app before this page (so `history.back()` stays in the app). */
export function hasInAppHistory(state: unknown): boolean {
  const id = (state as { navigationId?: number } | null)?.navigationId;
  return typeof id === 'number' && id > 1;
}
