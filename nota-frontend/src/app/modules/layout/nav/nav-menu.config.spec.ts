import { NAV_GROUPS, NavGroup, visibleNavGroups } from './nav-menu.config';

describe('nav menu config', () => {
  const keys = (groups: NavGroup[]) => groups.map((g) => [g.key, g.items.map((i) => i.key)] as const);

  it('shows only the screens that exist today, in the design order (main PC)', () => {
    expect(keys(visibleNavGroups(NAV_GROUPS, { isMainPc: true }))).toEqual([
      ['main', ['home']],
      ['sales', ['pos', 'credit', 'invoices', 'returns', 'customers']],
      ['inventory', ['products']],
      ['accounting', ['profit']],
      ['admin', ['shop', 'backup']],
    ]);
  });

  it('hides backup on a client PC', () => {
    const admin = visibleNavGroups(NAV_GROUPS, { isMainPc: false }).find((g) => g.key === 'admin');
    expect(admin?.items.map((i) => i.key)).toEqual(['shop']);
  });

  it('keeps future screens defined but hidden', () => {
    const all = NAV_GROUPS.flatMap((g) => g.items);
    const future = ['purchases', 'suppliers', 'cash', 'expenses', 'accounts', 'reports', 'users'];
    for (const key of future) {
      const item = all.find((i) => i.key === key);
      expect(item).withContext(key).toBeDefined();
      expect(item!.visible({ isMainPc: true })).withContext(key).toBeFalse();
    }
  });

  it('drops a group with no visible items, so no orphan label shows', () => {
    const groups = visibleNavGroups(NAV_GROUPS, { isMainPc: true });
    expect(groups.some((g) => g.key === 'treasury')).toBeFalse();
    expect(visibleNavGroups([{ key: 'x', labelKey: 'x', items: [{ key: 'a', labelKey: 'a', icon: '', visible: () => false }] }], { isMainPc: true })).toEqual([]);
  });

  it('gives every visible item a route or the categories expander, plus an icon and label key', () => {
    for (const item of visibleNavGroups(NAV_GROUPS, { isMainPc: true }).flatMap((g) => g.items)) {
      expect(!!item.route || item.expandable === 'categories').withContext(item.key).toBeTrue();
      expect(item.icon).withContext(item.key).toBeTruthy();
      expect(item.labelKey).withContext(item.key).toMatch(/^nav\.items\./);
    }
  });
});
