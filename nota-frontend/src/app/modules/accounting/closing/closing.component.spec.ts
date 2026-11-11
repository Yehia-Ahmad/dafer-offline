import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { TranslateModule } from '@ngx-translate/core';
import { environment } from '../../../../environments/environment';
import { LockDateService } from '../../../core/accounting-lock/lock-date.service';
import { signInAs, signInWith } from '../../../core/auth/testing/sign-in';
import { LanguageService } from '../../shared/services/translation.service';
import { ClosingComponent } from './closing.component';
import { ChecklistItem, ChecklistKey, ClosingHistoryRow, ClosingState } from './closing.service';

const base = `${environment.api_base_url}accounting/closing`;
const OK = (key: ChecklistKey): ChecklistItem => ({ key, ok: true, items: [] });
const history = (label: string, extra: Partial<ClosingHistoryRow> = {}): ClosingHistoryRow => ({
  _id: `h-${label}`, label, periodStart: `${label}-01`, periodEnd: `${label}-30`, status: 'closed', yearEnd: false, closedAt: '2026-11-02T10:15:00.000Z', closedByName: 'أحمد',
  entryId: null, entryNumber: null, netProfit: null, reopenedAt: null, reopenedByName: null, reopenReason: null, reversalEntryId: null, ...extra,
});
const state = (extra: Partial<ClosingState> = {}): ClosingState => ({
  settings: { frequency: 'monthly', fiscalYearStartMonth: 1 }, lockedThrough: '2026-09-30',
  next: { start: '2026-10-01', end: '2026-10-31', label: '2026-10', yearEnd: false, ended: true, canClose: true, endsAfter: null },
  checklist: { blocking: [OK('openShifts'), OK('manualDrafts'), OK('health'), OK('openingNotFinalized')], warnings: [{ key: 'customerBalances', count: 2, total: 12900 }, { key: 'supplierBalances', count: 1, total: 14650 }], canClose: true },
  history: [history('2026-09')], latestClosedId: 'h-2026-09', ...extra,
});

describe('ClosingComponent (Stage 22)', () => {
  let http: HttpTestingController;
  let fixture: ComponentFixture<ClosingComponent>;
  const el = () => fixture.nativeElement as HTMLElement;
  const settle = async () => { fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges(); };
  const q = (selector: string) => el().querySelector(selector) as HTMLElement | null;
  const qa = (selector: string) => Array.from(el().querySelectorAll(selector)) as HTMLElement[];
  const click = async (selector: string) => { (q(selector) as HTMLElement).click(); await settle(); };

  const open = async (signIn: () => void, loaded: ClosingState = state()) => {
    await TestBed.configureTestingModule({
      imports: [ClosingComponent, TranslateModule.forRoot()],
      providers: [provideRouter([]), provideNoopAnimations(), provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
    TestBed.inject(LanguageService).selectedLanguage.set('en');
    signIn();
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(ClosingComponent);
    fixture.detectChanges();
    http.expectOne(base).flush(loaded);
    await settle();
  };
  const asCloser = () => signInWith(['accounting.view', 'accounting.close']);
  const asOwner = () => signInAs('owner', { permissions: ['accounting.view', 'accounting.close'] });
  afterEach(() => http.verify());

  it('shows the lock date, the oldest open period with its range, the checklist (all green) and the warnings', async () => {
    await open(asCloser);
    expect(q('[data-test="locked-through"]')?.textContent?.trim()).toBe('2026-09-30');
    expect(q('[data-test="next-period"]')?.textContent).toContain('2026-10'); expect(q('[data-test="next-period"]')?.textContent).toContain('2026-10-01 → 2026-10-31');
    expect(qa('[data-check]').map((row) => [row.getAttribute('data-check'), row.getAttribute('data-ok')])).toEqual([['openShifts', 'true'], ['manualDrafts', 'true'], ['health', 'true'], ['openingNotFinalized', 'true']]);
    expect(qa('[data-warning]').map((row) => row.getAttribute('data-warning'))).toEqual(['customerBalances', 'supplierBalances']);
    expect(q('[data-test="not-ended"]')).toBeNull();
    expect((q('[data-action="close"]') as HTMLButtonElement).disabled).toBeFalse();
  });

  it('nothing closed yet: says so; a period that has not ended cannot be closed', async () => {
    await open(asCloser, state({ lockedThrough: null, next: { start: '2026-11-01', end: '2026-11-30', label: '2026-11', yearEnd: false, ended: false, canClose: false, endsAfter: '2026-11-30' }, history: [], latestClosedId: null }));
    expect(q('[data-test="not-locked"]')).not.toBeNull(); expect(q('[data-test="locked-through"]')).toBeNull();
    expect(q('[data-test="not-ended"]')?.textContent).toContain('closing.notEnded');
    expect((q('[data-action="close"]') as HTMLButtonElement).disabled).toBeTrue();
    expect(q('tbody tr td[colspan]')?.textContent).toContain('closing.noHistory');
  });

  it('blocking items say what to fix, link to where, list the details, and disable the close button', async () => {
    const blocked = state({
      next: { start: '2026-10-01', end: '2026-10-31', label: '2026-10', yearEnd: false, ended: true, canClose: false, endsAfter: null },
      checklist: {
        blocking: [
          { key: 'openShifts', ok: false, items: [{ number: 'SH-000004', box: 'درج ١', openedAt: '2026-10-20T08:00:00Z' }] },
          { key: 'manualDrafts', ok: false, items: [{ _id: 'd1', memo: 'كهرباء مستحقة', date: '2026-10-28T00:00:00Z' }] },
          { key: 'health', ok: false, items: [{ name: 'inventory', difference: 20 }] },
          { key: 'vatUnfiled', ok: false, items: ['2026-10'] },
          { key: 'openingNotFinalized', ok: false },
        ], warnings: [], canClose: false,
      },
    });
    await open(asCloser, blocked);
    expect(qa('[data-ok="false"]').length).toBe(5);
    expect(q('[data-check="openShifts"]')?.textContent).toContain('SH-000004 · درج ١');
    expect(q('[data-check="manualDrafts"]')?.textContent).toContain('2026-10-28 · كهرباء مستحقة');
    expect(q('[data-check="health"]')?.textContent).toContain('inventory: 20');
    expect(q('[data-check="vatUnfiled"]')?.textContent).toContain('2026-10');
    expect(q('[data-check="vatUnfiled"] a')?.getAttribute('href')).toBe('/accounting/vat');
    expect(q('[data-check="openingNotFinalized"] a')?.getAttribute('href')).toBe('/accounting/opening');
    expect(q('[data-check="health"] a')).toBeNull();
    expect((q('[data-action="close"]') as HTMLButtonElement).disabled).toBeTrue();
  });

  it('closing needs a double confirm: the first click only opens the question, "متأكد" asks again, the second one POSTs { periodEnd, confirm } and reloads', async () => {
    await open(asCloser);
    await click('[data-action="close"]');
    expect(q('[data-test="confirm-text"]')?.textContent).toContain('closing.confirmText');
    expect(q('[data-action="confirm-2"]')).toBeNull();
    http.expectNone((r) => r.method === 'POST');
    await click('[data-action="confirm-1"]');
    expect(q('[data-action="confirm-1"]')).toBeNull(); expect(q('[data-action="confirm-2"]')).not.toBeNull();
    http.expectNone((r) => r.method === 'POST');
    await click('[data-action="confirm-2"]');
    const request = http.expectOne((r) => r.method === 'POST' && r.url === `${base}/close`);
    expect(request.request.body).toEqual({ periodEnd: '2026-10-31', confirm: true });
    request.flush({ close: history('2026-10'), lockedThrough: '2026-10-31', entry: null });
    http.expectOne(base).flush(state({ lockedThrough: '2026-10-31', next: { start: '2026-11-01', end: '2026-11-30', label: '2026-11', yearEnd: false, ended: false, canClose: false, endsAfter: '2026-11-30' }, history: [history('2026-10'), history('2026-09')], latestClosedId: 'h-2026-10' }));
    await settle();
    expect(TestBed.inject(LockDateService).lockedThrough()).toBe('2026-10-31');
    expect(q('[data-test="locked-through"]')?.textContent?.trim()).toBe('2026-10-31');
    expect(q('[data-test="confirm-text"]')).toBeNull();
    expect(qa('[data-close]').length).toBe(2);
  });

  it('cancelling the confirm sends nothing; the question starts over the next time', async () => {
    await open(asCloser);
    await click('[data-action="close"]'); await click('[data-action="confirm-1"]');
    (document.querySelector('nota-dialog-shell button.nota-btn--icon') as HTMLButtonElement).click(); await settle();
    http.expectNone((r) => r.method === 'POST');
    await click('[data-action="close"]');
    expect(q('[data-action="confirm-1"]')).not.toBeNull(); expect(q('[data-action="confirm-2"]')).toBeNull();
  });

  it('a year-end period is tagged and the confirm says the closing entry is posted', async () => {
    await open(asCloser, state({ next: { start: '2026-12-01', end: '2026-12-31', label: '2026-12', yearEnd: true, ended: true, canClose: true, endsAfter: null } }));
    expect(q('[data-test="year-end-note"]')).not.toBeNull();
    await click('[data-action="close"]');
    expect(q('[data-test="confirm-year-end"]')).not.toBeNull();
  });

  it('a refused close (the checklist changed, another PC closed first) shows the server message and reloads', async () => {
    await open(asCloser);
    await click('[data-action="close"]'); await click('[data-action="confirm-1"]'); await click('[data-action="confirm-2"]');
    http.expectOne((r) => r.method === 'POST' && r.url === `${base}/close`).flush({ message: 'الفترة المطلوب إقفالها اتغيرت. حدّث الصفحة', code: 'PERIOD_CHANGED' }, { status: 409, statusText: 'Conflict' });
    http.expectOne(base).flush(state());
    await settle();
    expect(q('[data-test="action-error"]')?.textContent).toContain('الفترة المطلوب إقفالها اتغيرت');
  });

  it('without accounting.close there is no close button (only a note); the screen is still readable', async () => {
    await open(() => signInWith(['accounting.view']));
    expect(q('[data-action="close"]')).toBeNull(); expect(q('[data-test="no-close-permission"]')).not.toBeNull();
    expect(q('[data-test="checklist"]')).not.toBeNull();
  });

  it('the history shows who closed when, the closing entry link, the reversal and who reopened; reopen is on the latest closed period of the owner only', async () => {
    const rows = [
      history('2026-12', { _id: 'h2', yearEnd: true, entryId: 'j1', entryNumber: 'JE-000030' }),
      history('2026-11', { _id: 'h1', status: 'reopened', entryId: 'j0', entryNumber: 'JE-000020', reversalEntryId: 'j00', reopenedAt: '2026-12-02T09:00:00.000Z', reopenedByName: 'أحمد', reopenReason: 'فاتورة ناقصة' }),
    ];
    await open(asOwner, state({ history: rows, latestClosedId: 'h2' }));
    expect(q('[data-close="2026-12"] [data-link="closing-entry"]')?.getAttribute('href')).toBe('/accounting/journal/j1');
    expect(q('[data-close="2026-11"] [data-link="reversal-entry"]')?.getAttribute('href')).toBe('/accounting/journal/j00');
    expect(q('[data-close="2026-11"] [data-test="reopen-info"]')?.textContent).toContain('closing.reopenedBy');
    expect(qa('[data-action="reopen"]').length).toBe(1);
    expect(q('[data-close="2026-12"] [data-action="reopen"]')).not.toBeNull();
  });

  it('a user with accounting.close who is not the owner cannot reopen', async () => {
    await open(() => signInAs('manager', { permissions: ['accounting.view', 'accounting.close'] }));
    expect(q('[data-action="reopen"]')).toBeNull();
  });

  it('reopen: a reason is required, the dialog names the closing entry that is reversed, the POST carries { reason, confirm }, the lock moves back', async () => {
    await open(asOwner, state({ history: [history('2026-12', { _id: 'h2', yearEnd: true, entryId: 'j1', entryNumber: 'JE-000030' })], latestClosedId: 'h2', lockedThrough: '2026-12-31' }));
    await click('[data-action="reopen"]');
    expect(q('[data-test="reopen-reverses"]')?.textContent).toContain('closing.reopenReverses');
    const confirm = () => q('[data-action="confirm-reopen"]') as HTMLButtonElement;
    expect(confirm().disabled).toBeTrue();
    const reason = q('[data-field="reopen-reason"]') as HTMLTextAreaElement;
    reason.value = 'سبب'; reason.dispatchEvent(new Event('input')); await settle();
    expect(confirm().disabled).toBeFalse();
    confirm().click();
    const request = http.expectOne((r) => r.method === 'POST' && r.url === `${base}/reopen`);
    expect(request.request.body).toEqual({ reason: 'سبب', confirm: true });
    request.flush({ reopened: history('2026-12', { status: 'reopened' }), lockedThrough: '2026-11-30' });
    http.expectOne(base).flush(state({ lockedThrough: '2026-11-30', history: [history('2026-12', { _id: 'h2', status: 'reopened' })], latestClosedId: null }));
    await settle();
    expect(TestBed.inject(LockDateService).lockedThrough()).toBe('2026-11-30');
    expect(q('[data-action="reopen"]')).toBeNull();
  });

  it('a refused reopen stays in the dialog with the message', async () => {
    await open(asOwner);
    await click('[data-action="reopen"]');
    const reason = q('[data-field="reopen-reason"]') as HTMLTextAreaElement;
    reason.value = 'سبب كافي'; reason.dispatchEvent(new Event('input')); await settle();
    (q('[data-action="confirm-reopen"]') as HTMLButtonElement).click();
    http.expectOne((r) => r.url === `${base}/reopen`).flush({ message: 'إعادة فتح الفترة للمالك فقط', code: 'OWNER_ONLY' }, { status: 403, statusText: 'Forbidden' });
    await settle();
    expect(q('[data-test="reopen-error"]')?.textContent).toContain('للمالك فقط');
  });

  it('a failed load shows the error', async () => {
    await TestBed.configureTestingModule({ imports: [ClosingComponent, TranslateModule.forRoot()], providers: [provideRouter([]), provideNoopAnimations(), provideHttpClient(), provideHttpClientTesting()] }).compileComponents();
    asCloser();
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(ClosingComponent);
    fixture.detectChanges();
    http.expectOne(base).flush({ message: 'x' }, { status: 500, statusText: 'Server Error' });
    await settle();
    expect(q('[data-test="load-error"]')).not.toBeNull();
  });
});
