import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { signInWith } from '../core/auth/testing/sign-in';
import { LayoutService } from '../core/layout/layout.service';
import { LanguageService } from '../modules/shared/services/translation.service';
import { HelpBlocksComponent } from './components/help-blocks.component';
import { HelpButtonComponent } from './components/help-button.component';
import { HelpSectionViewComponent } from './components/help-section-view.component';
import { HelpContentService } from './help-content.service';
import { createHelpData } from './help-data';
import { HelpPanelService } from './help-panel.service';
import { HelpPageComponent, helpCards } from './pages/help-page.component';

@Component({ selector: 'nota-dummy', template: '' })
class DummyComponent {}

const setup = (isMobile = false) => {
  TestBed.configureTestingModule({
    imports: [TranslateModule.forRoot()],
    providers: [
      provideRouter([{ path: 'selling', component: DummyComponent }, { path: 'help/:section', component: DummyComponent }, { path: 'help', component: DummyComponent }]),
      provideHttpClient(), provideHttpClientTesting(),
      { provide: LayoutService, useValue: { isMobile: signal(isMobile) } },
    ],
  });
};

describe('help screens (Online Stage Help)', () => {
  it('cards: by default only the sections the user may use; "عرض كل الأقسام" adds the rest marked with the permission label', () => {
    const data = createHelpData();
    const allows = (section: { permissions?: { all?: readonly string[]; any?: readonly string[] } }) =>
      !section.permissions || (section.permissions.all ?? []).every((key) => key === 'sales.create');
    const mine = helpCards(data, allows, false);
    expect(mine.map((card) => card.section.id)).toContain('selling');
    expect(mine.map((card) => card.section.id)).toContain('start');
    expect(mine.map((card) => card.section.id)).not.toContain('users');
    const all = helpCards(data, allows, true);
    expect(all.length).toBe(data.sections.length);
    const users = all.find((card) => card.section.id === 'users')!;
    expect(users.allowed).toBeFalse();
    expect(users.needs).toBe('إدارة المستخدمين والصلاحيات');
  });

  it('the help page lists the allowed sections and the switch shows the locked ones', async () => {
    setup();
    signInWith(['sales.create']);
    const fixture = TestBed.createComponent(HelpPageComponent);
    await TestBed.inject(HelpContentService).load();
    await fixture.whenStable();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const ids = () => Array.from(fixture.nativeElement.querySelectorAll('[data-section]')).map((node) => (node as HTMLElement).dataset['section']);
    expect(ids()).toContain('selling');
    expect(ids()).not.toContain('users');
    expect(fixture.nativeElement.querySelector('[data-testid="help-needs"]')).toBeNull();
    const toggle = fixture.nativeElement.querySelector('[data-testid="help-show-all"]') as HTMLInputElement;
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    expect(ids()).toContain('users');
    expect(fixture.nativeElement.querySelectorAll('[data-testid="help-needs"]').length).toBeGreaterThan(0);
  });

  it('desktop "؟" opens the side panel on the current page’s section', async () => {
    setup(false);
    await TestBed.inject(Router).navigateByUrl('/selling');
    const fixture = TestBed.createComponent(HelpButtonComponent);
    fixture.detectChanges();
    const panel = TestBed.inject(HelpPanelService);
    await panel.openForCurrentPage();
    expect(panel.sectionId()).toBe('selling');
    (fixture.nativeElement.querySelector('[data-testid="help-button"]') as HTMLButtonElement).click();
    expect(panel.sectionId()).toBe('selling');
  });

  it('phone "؟" opens the section as a full page', async () => {
    setup(true);
    const router = TestBed.inject(Router);
    await router.navigateByUrl('/selling');
    await TestBed.inject(HelpPanelService).openForCurrentPage();
    expect(router.url).toBe('/help/selling');
    expect(TestBed.inject(HelpPanelService).sectionId()).toBeNull();
  });

  it('help text can never become HTML: tags are shown as text, links are router links', () => {
    setup();
    const fixture = TestBed.createComponent(HelpBlocksComponent);
    fixture.componentRef.setInput('blocks', [
      { type: 'paragraph', text: '<img src=x onerror=alert(1)> افتح [[/selling|نقطة البيع]] و**مهم**' },
      { type: 'table', head: ['أ', 'ب'], rows: [['<script>x</script>', '[[#returns|المرتجعات]]']] },
    ]);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelector('script')).toBeNull();
    expect(el.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(el.querySelector('a[href="/selling"]')?.textContent).toBe('نقطة البيع');
    expect(el.querySelector('a[href="/help/returns"]')).not.toBeNull();
    expect(el.querySelector('strong')?.textContent).toBe('مهم');
  });

  it('the English UI shows the Arabic help with a one-line note', () => {
    setup();
    const data = createHelpData();
    TestBed.inject(LanguageService).selectedLanguage.set('en');
    const fixture = TestBed.createComponent(HelpSectionViewComponent);
    fixture.componentRef.setInput('section', data.byId.get('selling')!);
    fixture.componentRef.setInput('data', data);
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('[data-testid="help-english-note"]')).not.toBeNull();
    expect(host.getAttribute('lang')).toBe('ar');
    expect(host.getAttribute('dir')).toBe('rtl');
    TestBed.inject(LanguageService).selectedLanguage.set('ar');
  });
});
