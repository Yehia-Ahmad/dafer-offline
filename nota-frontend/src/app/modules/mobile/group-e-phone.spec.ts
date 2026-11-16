import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { TranslateModule } from '@ngx-translate/core';
import { environment } from '../../../environments/environment';
import { LayoutService } from '../../core/layout/layout.service';
import { signInWith } from '../../core/auth/testing/sign-in';
import { LanguageService } from '../shared/services/translation.service';
import { ManualEntryComponent } from '../accounting/manual-entry/manual-entry.component';
import { JournalComponent } from '../accounting/journal.component';

/** Online Stage 6B, group E: the accounting screens on the phone (LayoutService says "mobile"). */
const phone = { provide: LayoutService, useValue: { isMobile: signal(true) } };
const base = environment.api_base_url;
const OPTIONS = [
  { _id: 'a523', code: '523', nameAr: 'مرافق', nameEn: 'Utilities', type: 'expense', normalSide: 'debit', systemKey: null, needsParty: null, blocked: null },
  { _id: 'a31', code: '31', nameAr: 'رأس المال', nameEn: 'Capital', type: 'equity', normalSide: 'credit', systemKey: null, needsParty: null, blocked: null },
];

describe('manual journal entry on the phone (Online Stage 6B)', () => {
  let fixture: ComponentFixture<ManualEntryComponent>;
  let el: HTMLElement;
  const settle = async () => { fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges(); };
  const q = (selector: string) => el.querySelector<HTMLElement>(selector);
  const type = async (selector: string, value: string, event = 'input') => { const field = q(selector) as HTMLInputElement; field.value = value; field.dispatchEvent(new Event(event)); await settle(); };
  const total = (kind: string) => (q(`[data-total="${kind}"]`)?.textContent ?? '').replace(/[^\d]/g, '');

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ManualEntryComponent, TranslateModule.forRoot()],
      providers: [provideRouter([]), provideNoopAnimations(), provideHttpClient(), provideHttpClientTesting(), phone,
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: convertToParamMap({}) } } }],
    }).compileComponents();
    TestBed.inject(LanguageService).selectedLanguage.set('en');
    signInWith(['accounting.manage']);
    const http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(ManualEntryComponent);
    fixture.detectChanges();
    http.expectOne(`${base}accounting/manual-entries/accounts`).flush({ data: OPTIONS });
    http.expectOne((r) => r.url === `${base}accounting/manual-entries` && r.params.get('status') === 'draft').flush({ data: [] });
    await settle();
    el = fixture.nativeElement as HTMLElement;
  });

  it('shows the lines as cards (not a table) and a sticky footer with total debit, total credit and the difference', async () => {
    expect(el.querySelectorAll('table').length).toBe(0);
    expect(el.querySelectorAll('[data-test="lines"] .m-card').length).toBe(2);
    expect(q('[data-test="entry-footer"]')).not.toBeNull();
    await type('[data-line="1"] [data-field="debit"]', '100');
    await type('[data-line="2"] [data-field="credit"]', '60');
    expect(total('debit')).toBe('100');
    expect(total('credit')).toBe('60');
    expect(q('[data-test="balance-state"]')?.classList).toContain('m-pill--warn');
    expect((fixture.componentInstance as unknown as { totals: () => { diff: number } }).totals().diff).toBe(40); // the same totals as the desktop
  });

  it('keeps "ترحيل القيد" disabled until the entry is balanced (the desktop rule), and enables it when it is', async () => {
    const post = () => q('[data-action="post"]') as HTMLButtonElement;
    await type('[data-test="memo"]', 'كهرباء');
    await type('[data-line="1"] [data-field="account"]', 'a523', 'change');
    await type('[data-line="2"] [data-field="account"]', 'a31', 'change');
    await type('[data-line="1"] [data-field="debit"]', '100');
    await type('[data-line="2"] [data-field="credit"]', '60');
    expect(post().disabled).withContext('unbalanced').toBeTrue();
    await type('[data-line="2"] [data-field="credit"]', '100');
    expect(post().disabled).withContext('balanced').toBeFalse();
    expect((q('[data-action="save-draft"]') as HTMLButtonElement).disabled).toBeFalse();
  });
});

describe('journal on the phone (Online Stage 6B)', () => {
  it('shows the entries as cards and each active filter as a removable chip that reloads', async () => {
    await TestBed.configureTestingModule({
      imports: [JournalComponent, TranslateModule.forRoot()],
      providers: [provideRouter([]), provideNoopAnimations(), provideHttpClient(), provideHttpClientTesting(), phone,
        { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: convertToParamMap({}) } } }],
    }).compileComponents();
    signInWith(['accounting.view']);
    const http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(JournalComponent);
    fixture.detectChanges();
    http.expectOne((r) => r.url === `${base}accounting/journal`).flush({ data: [{ _id: 'j1', number: 'JE-000001', date: '2026-11-16', type: 'auto', totalDebit: 20, source: { type: 'sale', number: 'INV-1' } }], pagination: { page: 1, totalPages: 1, totalItems: 1 } });
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelectorAll('table').length).toBe(0);
    expect(el.querySelectorAll('[data-test="journal-row"]').length).toBe(1);
    const component = fixture.componentInstance as unknown as { filters: { type: string } };
    component.filters.type = 'reversal';
    fixture.detectChanges();
    const chip = el.querySelector<HTMLElement>('[data-testid="m-filter-chips"] [data-chip="type"]');
    expect(chip).not.toBeNull();
    chip!.click();
    http.expectOne((r) => r.url === `${base}accounting/journal` && !r.params.has('type')).flush({ data: [], pagination: { page: 1, totalPages: 1, totalItems: 0 } });
    expect(component.filters.type).toBe('');
  });
});
