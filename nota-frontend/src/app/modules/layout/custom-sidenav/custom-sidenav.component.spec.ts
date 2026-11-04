import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { Router, provideRouter } from '@angular/router';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { TranslateModule } from '@ngx-translate/core';

import { CustomSidenavComponent, deviceLabelKey } from './custom-sidenav.component';
import { LanguageService } from '../../shared/services/translation.service';
import { ThemeService } from '../../shared/services/theme.service';

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

    fixture = TestBed.createComponent(CustomSidenavComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('renders the menu from the config with grouped links', () => {
    const hrefs = Array.from(el().querySelectorAll('a.nota-nav__link')).map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(['/home', '/selling', '/credit-sales', '/invoice-history', '/returns', '/customers', '/products', '/products/profit-report', '/shop-profile']);
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
});
