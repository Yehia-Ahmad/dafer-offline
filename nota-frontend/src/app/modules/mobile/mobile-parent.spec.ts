import { hasInAppHistory, parentRoute } from './mobile-parent';

describe('parentRoute (Online Stage 6B)', () => {
  it('goes from a detail or edit page to its list', () => {
    expect(parentRoute('/customers/abc')).toBe('/customers');
    expect(parentRoute('/credit-sales/new')).toBe('/credit-sales');
    expect(parentRoute('/products/edit/42')).toBe('/products');
    expect(parentRoute('/purchases/new')).toBe('/purchases');
    expect(parentRoute('/purchases/abc?x=1')).toBe('/purchases');
    expect(parentRoute('/cashbox/abc')).toBe('/cashbox');
    expect(parentRoute('/website/couriers/abc')).toBe('/website/couriers');
    // Online Stage 7A: a campaign, its form and the results go back to the campaigns list; a lead, its form and the import to the leads list.
    expect(parentRoute('/marketing/campaigns/c1')).toBe('/marketing/campaigns');
    expect(parentRoute('/marketing/campaigns/new')).toBe('/marketing/campaigns');
    expect(parentRoute('/marketing/campaigns/c1/edit')).toBe('/marketing/campaigns');
    expect(parentRoute('/marketing/leads/l1')).toBe('/marketing/leads');
    expect(parentRoute('/marketing/leads/new')).toBe('/marketing/leads');
    expect(parentRoute('/marketing/leads/import')).toBe('/marketing/leads');
    expect(parentRoute('/marketing/leads/l1/edit')).toBe('/marketing/leads');
    expect(parentRoute('/marketing/campaigns')).toBe('/more');
    expect(parentRoute('/orders/abc')).toBe('/orders');
    expect(parentRoute('/accounting/journal/abc')).toBe('/accounting/journal');
    expect(parentRoute('/accounting/accounts/abc/ledger')).toBe('/accounting/accounts');
    expect(parentRoute('/accounting/manual-entry/abc')).toBe('/accounting/journal');
  });

  it('puts a list opened from the menu under المزيد, and a root tab under nothing', () => {
    expect(parentRoute('/suppliers')).toBe('/more');
    expect(parentRoute('/accounting/reports')).toBe('/more');
    expect(parentRoute('/home')).toBeNull();
    expect(parentRoute('/orders?status=new')).toBeNull();
  });

  it('knows whether the router has navigated inside the app before this page', () => {
    expect(hasInAppHistory({ navigationId: 1 })).toBeFalse();
    expect(hasInAppHistory({ navigationId: 3 })).toBeTrue();
    expect(hasInAppHistory(null)).toBeFalse();
  });
});
