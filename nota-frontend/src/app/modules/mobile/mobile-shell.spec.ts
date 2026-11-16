import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { OrdersNotifierService } from '../../core/orders-notifier/orders-notifier.service';
import { signInWith } from '../../core/auth/testing/sign-in';
import { ROUTE_RULES } from '../../core/auth/route-permissions';
import { MobileShellComponent } from './mobile-shell.component';
import { MorePageComponent, moreGroups } from './more-page.component';
import { MOBILE_TABS, activeTabKey, hidesTabBar, isRootScreen, visibleTabs } from './mobile-tabs';

const allows = (permissions: string[]) => (rule: { all?: readonly string[]; any?: readonly string[] }) =>
  (!rule.all || rule.all.every((key) => permissions.includes(key))) && (!rule.any || rule.any.some((key) => permissions.includes(key)));

/** Online Stage 6A: the bottom tab bar, the top bar and المزيد follow the user's permissions. */
describe('mobile shell (Online Stage 6A)', () => {
  describe('tabs (pure)', () => {
    it('every tab but المزيد has the same rule as its route, and المزيد is always kept', () => {
      expect(MOBILE_TABS.map((tab) => tab.key)).toEqual(['home', 'pos', 'orders', 'stock', 'more']);
      expect(MOBILE_TABS.find((tab) => tab.key === 'pos')!.rule).toBe(ROUTE_RULES.selling);
      expect(MOBILE_TABS.find((tab) => tab.key === 'orders')!.rule).toBe(ROUTE_RULES.orders);
      expect(visibleTabs(allows([])).map((tab) => tab.key)).toEqual(['more']);
      expect(visibleTabs(allows(['sales.create'])).map((tab) => tab.key)).toEqual(['pos', 'more']);
      expect(visibleTabs(allows(['dashboard.view', 'sales.create', 'orders.view', 'products.view'])).map((tab) => tab.key)).toEqual(['home', 'pos', 'orders', 'stock', 'more']);
    });

    it('active tab, root screens and the tab bar on form pages', () => {
      const tabs = visibleTabs(allows(['dashboard.view', 'sales.create', 'orders.view', 'products.view']));
      expect(activeTabKey('/orders/abc', tabs)).toBe('orders');
      expect(activeTabKey('/products/edit/1', tabs)).toBe('stock');
      expect(activeTabKey('/customers', tabs)).toBe('more');
      expect(activeTabKey('/more', tabs)).toBe('more');
      expect(isRootScreen('/home', tabs)).toBeTrue();
      expect(isRootScreen('/orders?x=1', tabs)).toBeTrue();
      expect(isRootScreen('/orders/abc', tabs)).toBeFalse();
      expect(hidesTabBar('/products/new')).toBeTrue();
      expect(hidesTabBar('/products/edit/9')).toBeTrue();
      expect(hidesTabBar('/orders')).toBeFalse();
    });
  });

  describe('component', () => {
    const newCount = signal<number | null>(0);
    const setup = async (permissions: string[]) => {
      await TestBed.configureTestingModule({
        imports: [MobileShellComponent, TranslateModule.forRoot()],
        providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting(), { provide: OrdersNotifierService, useValue: { newCount } }],
      }).compileComponents();
      signInWith(permissions);
      const fixture = TestBed.createComponent(MobileShellComponent);
      fixture.detectChanges();
      await TestBed.inject(Router).navigateByUrl('/');
      fixture.detectChanges();
      return fixture;
    };
    const tabKeys = (fixture: { nativeElement: HTMLElement }) => Array.from(fixture.nativeElement.querySelectorAll<HTMLElement>('.m-tab')).map((tab) => tab.dataset['tab']);

    it('shows only the tabs the user may open (+ المزيد) and the new-orders badge on الطلبات', async () => {
      newCount.set(4);
      const fixture = await setup(['sales.create', 'orders.view']);
      expect(tabKeys(fixture)).toEqual(['pos', 'orders', 'more']);
      const badge = fixture.nativeElement.querySelector('[data-tab="orders"] [data-testid="orders-badge"]');
      expect(badge?.textContent?.trim()).toBe('4');
      expect(fixture.nativeElement.querySelector('[data-tab="pos"] .m-badge')).toBeNull();
    });

    it('no badge at zero, and a user with no permission still has المزيد', async () => {
      newCount.set(0);
      const fixture = await setup([]);
      expect(tabKeys(fixture)).toEqual(['more']);
      expect(fixture.nativeElement.querySelector('.m-badge')).toBeNull();
    });
  });

  describe('المزيد groups', () => {
    const keys = (permissions: string[]) => moreGroups((key) => permissions.includes(key)).map((group) => group.key);

    it('groups come in the design order and each item only with its permission', () => {
      const all = ['sales.create', 'credit.view', 'sales.view', 'returns.create', 'customers.view', 'orders.view', 'website.manage', 'products.view', 'purchases.view', 'suppliers.view', 'cashbox.view',
        'accounting.view', 'users.manage', 'audit.view', 'shop.manage'];
      expect(keys(all)).toEqual(['sales', 'website', 'inventory', 'treasury', 'accounting', 'admin']);
      expect(keys([])).toEqual([]);
      expect(keys(['customers.view'])).toEqual(['sales']);
      expect(moreGroups((key) => key === 'orders.view').flatMap((group) => group.items.map((item) => item.key))).toEqual(['orders', 'couriers']);
      expect(moreGroups((key) => key === 'dashboard.view')).toEqual([], 'the home tab is not repeated in المزيد');
    });

    it('the page shows the user card, the groups and (with orders.view) the push toggle', async () => {
      await TestBed.configureTestingModule({
        imports: [MorePageComponent, TranslateModule.forRoot()],
        providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()],
      }).compileComponents();
      signInWith(['customers.view', 'orders.view']);
      const fixture = TestBed.createComponent(MorePageComponent);
      fixture.detectChanges();
      const el = fixture.nativeElement as HTMLElement;
      expect(el.querySelector('[data-testid="user-card"]')).not.toBeNull();
      expect(Array.from(el.querySelectorAll<HTMLElement>('[data-group]')).map((group) => group.dataset['group'])).toEqual(['sales', 'website']);
      expect(el.querySelector('[data-testid="push-toggle"]')).not.toBeNull();
      TestBed.inject(HttpTestingController);
    });
  });
});
