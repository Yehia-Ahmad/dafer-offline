import { ComponentFixture, TestBed } from '@angular/core/testing';
import { lockRefreshSpy } from '../../test-setup.spec';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { TranslateModule } from '@ngx-translate/core';
import { environment } from '../../../environments/environment';
import { LockDateService } from '../../core/accounting-lock/lock-date.service';
import { localDateKey } from '../../core/utilities/local-date';
import { LanguageService } from '../shared/services/translation.service';
import { CashBox } from './cashbox.models';
import { DrawingDialogComponent } from './drawing-dialog.component';

const day = (offset: number) => { const date = new Date(); date.setDate(date.getDate() + offset); return localDateKey(date); };
const BOX = { _id: 'b1', name: 'الخزنة الرئيسية', type: 'cash', isMain: true, isActive: true } as CashBox;

/** Stage 22: the posting forms disable locked dates (min on the date, the banner) and refuse to submit one. */
describe('posting forms and the closed period (Stage 22)', () => {
  let http: HttpTestingController;
  let fixture: ComponentFixture<DrawingDialogComponent>;
  const q = (selector: string) => document.querySelector(selector) as HTMLElement | null;
  const settle = async () => { fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges(); };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [DrawingDialogComponent, TranslateModule.forRoot()],
      providers: [provideRouter([]), provideNoopAnimations(), provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
    TestBed.inject(LanguageService).selectedLanguage.set('en');
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(DrawingDialogComponent);
    fixture.componentRef.setInput('boxes', [BOX]);
    fixture.componentRef.setInput('visible', true);
    fixture.detectChanges();
    await settle();
  });
  afterEach(() => http.verify());

  const amount = async (value: string) => { const input = q('[data-test="drawing-amount"]') as HTMLInputElement; input.value = value; input.dispatchEvent(new Event('input')); await settle(); };
  const setDate = async (value: string) => { const input = q('[data-test="drawing-date"]') as HTMLInputElement; input.value = value; input.dispatchEvent(new Event('input')); await settle(); };

  it('re-reads the lock date each time the dialog opens (Stage 22 review)', async () => {
    expect(lockRefreshSpy()).toHaveBeenCalledTimes(1);
    fixture.componentRef.setInput('visible', false); await settle();
    fixture.componentRef.setInput('visible', true); await settle();
    expect(lockRefreshSpy()).toHaveBeenCalledTimes(2);
  });

  it('no closed period: no banner, no min on the date, the drawing can be submitted', async () => {
    expect(q('[data-test="lock-banner"]')).toBeNull();
    expect(q('[data-test="drawing-date"]')?.getAttribute('min')).toBeNull();
    await amount('50');
    expect((q('[data-action="do-drawing"]') as HTMLButtonElement).disabled).toBeFalse();
  });

  it('a closed period: the date starts at the first open day, the banner explains, and a locked date cannot be submitted', async () => {
    TestBed.inject(LockDateService).set(day(-3));
    await settle();
    expect(q('[data-test="drawing-date"]')?.getAttribute('min')).toBe(day(-2));
    expect(q('[data-test="lock-banner"]')?.textContent).toContain('lock.banner');
    await amount('50');
    expect((q('[data-action="do-drawing"]') as HTMLButtonElement).disabled).toBeFalse(); // today is open
    await setDate(day(-5));
    expect(q('[data-test="lock-banner"]')?.classList).toContain('nota-lock-banner--blocked');
    expect((q('[data-action="do-drawing"]') as HTMLButtonElement).disabled).toBeTrue();
    await setDate(day(-2));
    expect((q('[data-action="do-drawing"]') as HTMLButtonElement).disabled).toBeFalse();
    void environment;
  });
});
