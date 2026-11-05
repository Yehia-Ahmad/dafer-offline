import { NAV_GROUPS, NavContext, NavGroup, visibleNavGroups } from './nav-menu.config';
import { ROLE_PERMISSIONS } from '../../../core/auth/testing/auth-fixtures';

describe('nav menu config', () => {
  const keys = (groups: NavGroup[]) => groups.map((g) => [g.key, g.items.map((i) => i.key)] as const);
  const ctxFor = (permissions: readonly string[], isMainPc = true): NavContext => ({
    isMainPc,
    has: (key) => permissions.includes(key),
  });

  it('owner (main PC): every screen that exists today, in the design order, with users and audit', () => {
    expect(keys(visibleNavGroups(NAV_GROUPS, ctxFor(ROLE_PERMISSIONS.owner)))).toEqual([
      ['main', ['home']],
      ['sales', ['pos', 'credit', 'invoices', 'returns', 'customers']],
      ['inventory', ['products']],
      ['accounting', ['profit']],
      ['admin', ['users', 'audit', 'shop', 'backup']],
    ]);
  });

  it('manager: everything except users and backup', () => {
    expect(keys(visibleNavGroups(NAV_GROUPS, ctxFor(ROLE_PERMISSIONS.manager)))).toEqual([
      ['main', ['home']],
      ['sales', ['pos', 'credit', 'invoices', 'returns', 'customers']],
      ['inventory', ['products']],
      ['accounting', ['profit']],
      ['admin', ['audit', 'shop']],
    ]);
  });

  it('cashier: sales screens and products; no profit report, no admin group', () => {
    expect(keys(visibleNavGroups(NAV_GROUPS, ctxFor(ROLE_PERMISSIONS.cashier)))).toEqual([
      ['main', ['home']],
      ['sales', ['pos', 'credit', 'invoices', 'returns', 'customers']],
      ['inventory', ['products']],
    ]);
  });

  it('storekeeper: products only (no dashboard, no sales)', () => {
    expect(keys(visibleNavGroups(NAV_GROUPS, ctxFor(ROLE_PERMISSIONS.storekeeper)))).toEqual([
      ['inventory', ['products']],
    ]);
  });

  it('accountant: views, profit report and audit; no POS, no new credit sale', () => {
    expect(keys(visibleNavGroups(NAV_GROUPS, ctxFor(ROLE_PERMISSIONS.accountant)))).toEqual([
      ['main', ['home']],
      ['sales', ['credit', 'invoices', 'returns', 'customers']],
      ['inventory', ['products']],
      ['accounting', ['profit']],
      ['admin', ['audit']],
    ]);
  });

  it('profit report needs reports.profit and products.viewCost together', () => {
    const profit = NAV_GROUPS.flatMap((g) => g.items).find((i) => i.key === 'profit')!;
    expect(profit.visible(ctxFor(['reports.profit']))).toBeFalse();
    expect(profit.visible(ctxFor(['reports.profit', 'products.viewCost']))).toBeTrue();
  });

  it('hides backup on a client PC, even for the owner', () => {
    const admin = visibleNavGroups(NAV_GROUPS, ctxFor(ROLE_PERMISSIONS.owner, false)).find((g) => g.key === 'admin');
    expect(admin?.items.map((i) => i.key)).toEqual(['users', 'audit', 'shop']);
  });

  it('keeps future screens defined but hidden', () => {
    const all = NAV_GROUPS.flatMap((g) => g.items);
    for (const key of ['purchases', 'suppliers', 'cash', 'expenses', 'accounts', 'reports']) {
      const item = all.find((i) => i.key === key);
      expect(item).withContext(key).toBeDefined();
      expect(item!.visible(ctxFor(ROLE_PERMISSIONS.owner))).withContext(key).toBeFalse();
    }
  });

  it('drops a group with no visible items, so no orphan label shows; no permissions → no menu', () => {
    const groups = visibleNavGroups(NAV_GROUPS, ctxFor(ROLE_PERMISSIONS.owner));
    expect(groups.some((g) => g.key === 'treasury')).toBeFalse();
    expect(visibleNavGroups(NAV_GROUPS, ctxFor([]))).toEqual([]);
  });

  it('gives every visible item a route, plus an icon and label key', () => {
    for (const item of visibleNavGroups(NAV_GROUPS, ctxFor(ROLE_PERMISSIONS.owner)).flatMap((g) => g.items)) {
      expect(!!item.route).withContext(item.key).toBeTrue();
      expect(item.icon).withContext(item.key).toBeTruthy();
      expect(item.labelKey).withContext(item.key).toMatch(/^nav\.items\./);
    }
  });
});
