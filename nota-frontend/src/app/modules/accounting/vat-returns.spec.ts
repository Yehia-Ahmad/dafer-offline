import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { TranslateModule } from '@ngx-translate/core';
import { environment } from '../../../environments/environment';
import { signInAs, signInWith } from '../../core/auth/testing/sign-in';
import { flushPaymentBoxes } from '../cashbox/testing/payment-boxes.testing';
import { LanguageService } from '../shared/services/translation.service';
import { VatReturnsComponent } from './vat-returns.component';
import { VatReturnDetail, VatReturnList, VatReturnRow } from './vat.models';

const base = environment.api_base_url;
const row = (extra: Partial<VatReturnRow>): VatReturnRow => ({
  period: '2026-11', status: 'open', output: 1430.7, input: 0, carriedIn: 732.3, net: 698.4, offset: 732.3, payable: 698.4, credit: 0, paid: 0, remaining: 0,
  returnId: null, number: null, filedAt: null, ...extra,
});
const LIST: VatReturnList = {
  data: [
    row({}),
    row({ period: '2026-10', status: 'filed', output: 30.7, input: 763, carriedIn: 0, net: -732.3, offset: 30.7, payable: 0, credit: 732.3, returnId: 'r1', number: 'VR-000001', filedAt: '2026-11-02T10:00:00Z' }),
  ],
  nextPeriod: '2026-11',
  settings: { enabled: true, rate: 14, pricesIncludeVat: true, startDate: '2026-10-10T00:00:00.000Z' },
};
const LINES = {
  sales: [{ kind: 'sale', number: 'INV-000007', date: '2026-11-05T00:00:00Z', net: 1228.07, vat: 1400, sourceType: 'sale', sourceId: 's1' }, { kind: 'sale', number: 'INV-000006', date: '2026-10-20T00:00:00Z', net: 219.3, vat: 30.7, sourceType: 'sale', sourceId: 's0' }],
  returns: [], purchases: [{ kind: 'purchase', number: 'PO-000002', date: '2026-11-06T00:00:00Z', net: 0, vat: 0, sourceType: 'purchase', sourceId: 'p1' }], purchaseReturns: [], expenses: [],
};
const detail = (extra: Partial<VatReturnDetail> = {}): VatReturnDetail => ({
  ...row({}), lines: LINES as never, payments: [], canFile: true, canUnfile: false,
  preview: { debit: { code: '22', amount: 732.3 }, credit: { code: '115', amount: 732.3 }, payable: 698.4, credit_carried: 0 }, ...extra,
});

describe('VatReturnsComponent (Stage 21)', () => {
  let http: HttpTestingController;
  let fixture: ComponentFixture<VatReturnsComponent>;
  const el = () => fixture.nativeElement as HTMLElement;
  const settle = async () => { fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges(); };

  const open = async (signIn: () => void = () => signInAs('owner'), initial: VatReturnDetail = detail()) => {
    sessionStorage.removeItem('nota.paymentBox');
    await TestBed.configureTestingModule({
      imports: [VatReturnsComponent, TranslateModule.forRoot()],
      providers: [provideRouter([]), provideNoopAnimations(), provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
    TestBed.inject(LanguageService).selectedLanguage.set('en');
    signIn();
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(VatReturnsComponent);
    fixture.detectChanges();
    http.expectOne(`${base}vat/returns`).flush(LIST);
    http.expectOne(`${base}vat/returns/2026-11`).flush(initial);
    flushPaymentBoxes(http);
    await settle();
  };
  afterEach(() => { flushPaymentBoxes(http); http.verify(); sessionStorage.removeItem('nota.paymentBox'); });

  it('the month list: period, output, input, carried, net (a credit month tagged), status, filed date', async () => {
    await open();
    const rows = Array.from(el().querySelectorAll('[data-test="months"] tbody tr'));
    expect(rows.map((r) => r.getAttribute('data-period'))).toEqual(['2026-11', '2026-10']);
    expect(rows[0].textContent).toContain('1,430.70');
    expect(rows[0].textContent).toContain('732.30');
    expect(rows[0].textContent).toContain('698.40');
    expect(rows[1].textContent).toContain('VR-000001');
    expect(rows[1].textContent).toContain('763');
    expect(rows[1].textContent).toContain('2026-11-02');
    expect(rows[1].classList).not.toContain('vr__row--on');
    expect(rows[1].querySelector('.vr__credit')).toBeTruthy();
    expect(rows[0].classList).toContain('vr__row--on');
  });

  it('opens the month that can be filed next, with its figures and the documents behind them (tabs with counts)', async () => {
    await open();
    expect(el().querySelector('[data-test="detail"]')!.getAttribute('data-period')).toBe('2026-11');
    expect(el().querySelector('[data-kpi="output"]')!.textContent).toContain('1,430.70');
    expect(el().querySelector('[data-kpi="carried"]')!.textContent).toContain('732.30');
    expect(el().querySelector('[data-kpi="net"]')!.textContent).toContain('698.40');
    expect(el().querySelector('[data-tab="sales"] .vr__count')!.textContent).toContain('2');
    expect(el().querySelector('[data-tab="returns"] .vr__count')!.textContent).toContain('0');
    expect(el().querySelectorAll('[data-test="lines"] tbody tr').length).toBe(2);
    expect(el().querySelector('[data-test="lines"] tfoot')!.textContent).toContain('1,430.70');
    (el().querySelector('[data-tab="purchases"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(el().querySelectorAll('[data-test="lines"] tbody tr').length).toBe(1);
    expect(el().querySelector('[data-test="lines"] tbody')!.textContent).toContain('PO-000002');
    (el().querySelector('[data-tab="expenses"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(el().querySelector('[data-test="lines"] tbody')!.textContent).toContain('vat.returns.noLines');
  });

  it('file: the confirm dialog shows the posting (Dr 22 / Cr 115 = the offset), then POSTs and reloads', async () => {
    await open();
    (el().querySelector('[data-action="file"]') as HTMLButtonElement).click();
    await settle();
    const posting = el().querySelector('[data-test="file-posting"]')!.textContent!;
    expect(posting).toContain('732.30');
    expect(el().querySelector('[data-test="file-figures"]')!.textContent).toContain('698.40');
    (el().querySelector('[data-action="confirm-file"]') as HTMLButtonElement).click();
    const request = http.expectOne(`${base}vat/returns/2026-11/file`);
    expect(request.request.method).toBe('POST');
    request.flush(row({ status: 'filed', number: 'VR-000002', returnId: 'r2', filedAt: '2026-12-01T00:00:00Z', remaining: 698.4 }));
    http.expectOne(`${base}vat/returns`).flush({ ...LIST, nextPeriod: '2026-12' });
    http.expectOne(`${base}vat/returns/2026-11`).flush(detail({ status: 'filed', number: 'VR-000002', returnId: 'r2', remaining: 698.4, canFile: false, preview: null }));
    await settle();
    expect(el().querySelector('[data-action="file"]')).toBeNull();
    expect(el().querySelector('[data-action="pay"]')).toBeTruthy();
  });

  it('a filing refused out of order shows the reason', async () => {
    await open();
    (el().querySelector('[data-action="file"]') as HTMLButtonElement).click();
    await settle();
    (el().querySelector('[data-action="confirm-file"]') as HTMLButtonElement).click();
    http.expectOne(`${base}vat/returns/2026-11/file`).flush({ code: 'OUT_OF_ORDER', expected: '2026-10' }, { status: 409, statusText: 'Conflict' });
    await settle();
    expect(el().querySelector('[data-test="dialog-error"]')!.textContent).toContain('vat.errors.OUT_OF_ORDER');
  });

  it('PERIOD_NOT_ENDED: filing the running month is refused with its own reason', async () => {
    await open();
    (el().querySelector('[data-action="file"]') as HTMLButtonElement).click();
    await settle();
    (el().querySelector('[data-action="confirm-file"]') as HTMLButtonElement).click();
    http.expectOne(`${base}vat/returns/2026-11/file`).flush({ code: 'PERIOD_NOT_ENDED', period: '2026-11', today: '2026-11' }, { status: 409, statusText: 'Conflict' });
    await settle();
    expect(el().querySelector('[data-test="dialog-error"]')!.textContent).toContain('vat.errors.PERIOD_NOT_ENDED');
  });

  it('a month that has not ended has no file button and says so', async () => {
    await open(() => signInAs('owner'), detail({ canFile: false }));
    expect(el().querySelector('[data-action="file"]')).toBeNull();
    expect(el().querySelector('[data-test="order-note"]')!.textContent).toContain('vat.returns.notEnded');
  });

  it('a month whose returns exceed its sales posts the offset the other way: the dialog shows Dr 115 / Cr 22 and explains it', async () => {
    await open(() => signInAs('owner'), detail({ output: -14, input: 0, carriedIn: 0, net: -14, offset: -14, payable: 0, credit: 14, preview: { debit: { code: '115', amount: 14 }, credit: { code: '22', amount: 14 }, payable: 0, credit_carried: 14 } }));
    (el().querySelector('[data-action="file"]') as HTMLButtonElement).click();
    await settle();
    const posting = el().querySelector('[data-test="file-posting"]')!;
    expect(posting.querySelector('[data-test="posting-negative"]')).not.toBeNull();
    expect(posting.textContent).toContain('vat.file.debitInput');
    expect(posting.textContent).toContain('vat.file.creditPayable');
    expect(posting.textContent).toContain('14');
    expect(posting.textContent).not.toContain('-14');
    expect(el().querySelector('[data-test="negative-note"]')).not.toBeNull();
  });

  it('pay: amount up to what remains, from a box; partial then the exact body', async () => {
    await open(() => signInAs('owner'), detail({ status: 'partial', number: 'VR-000002', returnId: 'r2', paid: 300, remaining: 398.4, canFile: false, preview: null }));
    (el().querySelector('[data-action="pay"]') as HTMLButtonElement).click();
    await settle();
    flushPaymentBoxes(http);
    expect(el().querySelector('[data-test="pay-remaining"]')!.textContent).toContain('398.40');
    expect((el().querySelector('[data-test="pay-amount"]') as HTMLInputElement).value).toBe('398.4');
    const component = fixture.componentInstance as unknown as { payAmount: { set(value: number): void }; payInvalid(): boolean; payReference: { set(value: string): void } };
    component.payAmount.set(500);
    expect(component.payInvalid()).toBeTrue();
    component.payAmount.set(0);
    expect(component.payInvalid()).toBeTrue();
    component.payAmount.set(150);
    component.payReference.set('إيصال 7');
    await settle();
    (el().querySelector('[data-action="confirm-pay"]') as HTMLButtonElement).click();
    const request = http.expectOne(`${base}vat/returns/2026-11/pay`);
    expect(request.request.method).toBe('POST');
    const body = request.request.body;
    expect(body.amount).toBe(150);
    expect(body.reference).toBe('إيصال 7');
    expect(body.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    request.flush({ payment: { number: 'VP-000002' }, return: row({ status: 'partial', paid: 450, remaining: 248.4 }) });
    http.expectOne(`${base}vat/returns`).flush(LIST);
    http.expectOne(`${base}vat/returns/2026-11`).flush(detail({ status: 'partial', paid: 450, remaining: 248.4, canFile: false, preview: null }));
    flushPaymentBoxes(http);
    await settle();
  });

  it('unfile: owner only, the latest return, a reason of at least 3 characters; POSTs the reason', async () => {
    await open(() => signInAs('owner'), detail({ status: 'filed', number: 'VR-000002', returnId: 'r2', remaining: 698.4, canFile: false, canUnfile: true, preview: null }));
    (el().querySelector('[data-action="unfile"]') as HTMLButtonElement).click();
    await settle();
    const confirm = () => el().querySelector('[data-action="confirm-unfile"]') as HTMLButtonElement;
    expect(confirm().disabled).toBeTrue();
    const component = fixture.componentInstance as unknown as { unfileReason: { set(value: string): void } };
    component.unfileReason.set('غلط في الأرقام');
    await settle();
    expect(confirm().disabled).toBeFalse();
    confirm().click();
    const request = http.expectOne(`${base}vat/returns/2026-11/unfile`);
    expect(request.request.body).toEqual({ reason: 'غلط في الأرقام' });
    request.flush(row({}));
    http.expectOne(`${base}vat/returns`).flush(LIST);
    http.expectOne(`${base}vat/returns/2026-11`).flush(detail());
    await settle();
  });

  it('an accountant with vat.file files and pays but cannot unfile (owner only)', async () => {
    await open(() => signInAs('accountant'), detail({ status: 'filed', number: 'VR-000002', returnId: 'r2', remaining: 698.4, canFile: false, canUnfile: true, preview: null }));
    expect(el().querySelector('[data-action="pay"]')).toBeTruthy();
    expect(el().querySelector('[data-action="unfile"]')).toBeNull();
  });

  it('a viewer with only accounting.view reads the return but has no buttons except the export', async () => {
    await open(() => signInWith(['accounting.view', 'products.viewCost']));
    expect(el().querySelector('[data-action="file"]')).toBeNull();
    expect(el().querySelector('[data-action="pay"]')).toBeNull();
    expect(el().querySelector('[data-action="unfile"]')).toBeNull();
    expect(el().querySelector('[data-action="export"]')).toBeTruthy();
  });

  it('export asks for the month workbook as a blob', async () => {
    await open();
    (el().querySelector('[data-action="export"]') as HTMLButtonElement).click();
    const request = http.expectOne(`${base}vat/returns/2026-11/export`);
    expect(request.request.responseType).toBe('blob');
    request.flush(new Blob(['x']));
    await settle();
  });

  it('every account of month: a month with no documents says so', async () => {
    await open(() => signInAs('owner'), detail({ lines: { sales: [], returns: [], purchases: [], purchaseReturns: [], expenses: [] } }));
    expect(el().querySelector('[data-test="lines"] tbody')!.textContent).toContain('vat.returns.noLines');
  });
});
