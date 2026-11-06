import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { Router, provideRouter } from '@angular/router';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { TranslateModule } from '@ngx-translate/core';

import { CustomSidenavComponent, deviceLabelKey, userRoleLabelKey } from './custom-sidenav.component';
import { AuthService } from '../../../core/auth/auth.service';
import { UnsavedWorkService } from '../../../core/unsaved-work/unsaved-work.service';
import { fakeUser } from '../../../core/auth/testing/auth-fixtures';
import { LanguageService } from '../../shared/services/translation.service';
import { ThemeService } from '../../shared/services/theme.service';
import { signInAs } from '../../../core/auth/testing/sign-in';

describe('CustomSidenavComponent (Nota sidebar)', () => {
  let component: CustomSidenavComponent;
  let fixture: ComponentFixture<CustomSidenavComponent>;
  const el = () => fixture.nativeElement as HTMLElement;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [CustomSidenavComponent, TranslateModule.forRoot()],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([]), provideNoopAnimations()]
    })
    .compileComponents();

    signInAs('owner'); // Stage 14: as the owner, every action shows as before

    fixture = TestBed.createComponent(CustomSidenavComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('renders the menu from the config with grouped links', () => {
    const hrefs = Array.from(el().querySelectorAll('a.nota-nav__link')).map((a) => a.getAttribute('href'));
    // Stage 14 (owner): users and audit under الإدارة.
    expect(hrefs).toEqual(['/home', '/selling', '/credit-sales', '/invoice-history', '/returns', '/customers', '/products', '/suppliers', '/products/profit-report', '/users', '/audit', '/shop-profile']);
    // Stage 11: no category list or tools in the sidebar any more.
    expect(el().querySelector('app-sidebar-categories')).toBeNull();
    // Not the main PC outside the desktop app: no backup link.
    expect(el().querySelector('a[href="/backup"]')).toBeNull();
  });

  it('home is a plain link to the dashboard (Stage 12: no HOME_VIEW reset any more)', () => {
    const home = el().querySelector<HTMLAnchorElement>('a[href="/home"]')!;
    expect(home).not.toBeNull();
    expect('resetHomeView' in component).toBeFalse();
  });

  it('products item: active on /products and the product form, not on the profit report (Stage 11)', () => {
    const item = { key: 'products', labelKey: 'nav.items.products', route: '/products', icon: '', visible: () => true,
      activePaths: ['/products/new', '/products/edit/'] };
    expect(component.isPathActive(item)).toBeFalse();
    for (const [url, active] of [['/products?category=c1', true], ['/products/new?category=c1', true], ['/products/edit/p1', true], ['/products/profit-report', false]] as const) {
      (component as any).url = () => url;
      expect(component.isPathActive(item)).withContext(url).toBe(active);
    }
  });

  it('footer language and theme controls call the services', () => {
    const language = TestBed.inject(LanguageService);
    const change = spyOn(language, 'changeLanguage');
    const toggle = spyOn(TestBed.inject(ThemeService), 'toggleTheme');
    component.setLanguage(language.selectedLanguage() === 'ar' ? 'en' : 'ar');
    expect(change).toHaveBeenCalled();
    component.toggleTheme();
    expect(toggle).toHaveBeenCalled();
  });

  it('device line comes from the runtime role', () => {
    expect(deviceLabelKey('main')).toBe('nav.deviceMain');
    expect(deviceLabelKey('client')).toBe('nav.deviceClient');
    expect(deviceLabelKey(null)).toBeNull();
  });

  // ---- Stage 14 ----

  it('follows the signed-in user: a cashier sees only sales screens and products', () => {
    signInAs('cashier');
    fixture.detectChanges();
    const hrefs = Array.from(el().querySelectorAll('a.nota-nav__link')).map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(['/home', '/selling', '/credit-sales', '/invoice-history', '/returns', '/customers', '/products']);
    expect(el().textContent).not.toContain('nav.groups.admin');
  });

  it('user card: name, role label and logout', () => {
    const card = el().querySelector('.nota-user-card')!;
    expect(card).not.toBeNull();
    expect(card.querySelector('.nota-user-card__name')!.textContent).toContain('أحمد');
    expect(card.querySelector('.nota-user-card__meta')!.textContent).toContain('auth.roles.owner');
    expect(card.querySelector('.nota-user-card__logout')).not.toBeNull();
  });

  it('role label: template role, edited template → "صلاحيات مخصصة", custom role → the same', () => {
    expect(userRoleLabelKey(fakeUser('cashier'))).toBe('auth.roles.cashier');
    expect(userRoleLabelKey(fakeUser('cashier', { permissionsEdited: true }))).toBe('auth.roles.customized');
    expect(userRoleLabelKey(fakeUser('custom'))).toBe('auth.roles.customized');
    expect(userRoleLabelKey(fakeUser('owner', { permissionsEdited: true }))).toBe('auth.roles.owner');
    expect(userRoleLabelKey(null)).toBe('');
  });

  it('logout with nothing unsaved clears the session without asking and goes to /login', async () => {
    const router = TestBed.inject(Router);
    const navigate = spyOn(router, 'navigate').and.resolveTo(true);
    (el().querySelector('.nota-user-card__logout') as HTMLButtonElement).click();
    await fixture.whenStable();
    const auth = TestBed.inject(AuthService);
    expect(auth.token()).toBeNull();
    expect(auth.user()).toBeNull();
    expect(navigate).toHaveBeenCalledWith(['/login']);
  });

  it('Stage 15: logout with unsaved work asks first; "back to work" keeps the session, "continue" signs out', async () => {
    const router = TestBed.inject(Router);
    const navigate = spyOn(router, 'navigate').and.resolveTo(true);
    const unsaved = TestBed.inject(UnsavedWorkService);
    const unregister = unsaved.register('pos', () => true);
    const auth = TestBed.inject(AuthService);

    (el().querySelector('.nota-user-card__logout') as HTMLButtonElement).click();
    await Promise.resolve();
    expect(unsaved.prompt()).not.toBeNull();
    unsaved.answer(false);
    await fixture.whenStable();
    expect(auth.token()).not.toBeNull();
    expect(navigate).not.toHaveBeenCalled();

    (el().querySelector('.nota-user-card__logout') as HTMLButtonElement).click();
    await Promise.resolve();
    unsaved.answer(true);
    await fixture.whenStable();
    expect(auth.token()).toBeNull();
    expect(navigate).toHaveBeenCalledWith(['/login']);
    unregister();
  });

  it('"change password" in the user card opens the dialog', () => {
    (el().querySelector('.nota-user-card__link') as HTMLButtonElement).click();
    expect(component.changePasswordOpen).toBeTrue();
  });
});
