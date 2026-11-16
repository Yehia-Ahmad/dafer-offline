// Stage 23: the print pipeline in the app: context, the server's print log (copy numbers), the browser print dialog
// (a hidden iframe + window.print()), errors and the shared print buttons.

import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { environment } from '../../../environments/environment';
import { ShopProfile } from '../../modules/shop-profile/models/shop-profile.model';
import { ToastService } from '../auth/toast.service';
import { signInAs } from '../auth/testing/sign-in';
import { PrintActionsComponent } from './print-actions.component';
import { PrintFontService } from './print-fonts.service';
import { cashInvoice } from './documents/invoices';
import { cashReceipt } from './documents/receipts';
import { customerStatement } from './documents/statements';
import { PrintDataService } from './print-data.service';
import { PrintContext, buildPrintHtml, toShopInfo } from './print-kit';
import { PrintRequest, PrintService } from './print.service';

const base = environment.api_base_url;
const PROFILE: ShopProfile = { name: 'النور', address: 'المنصورة', phones: ['010'], logo: null, taxNumber: '123', commercialRegister: '', invoiceFooter: 'شكرًا' };
const SALE = { number: 'INV-000125', date: new Date(2026, 10, 5, 12, 40), items: [{ name: 'لمبة', quantity: 1, unitPrice: 10, total: 10 }], subtotal: 10, discount: 0, shipping: 0, total: 10 };

describe('PrintService (Stage 23)', () => {
  let http: HttpTestingController;
  let service: PrintService;
  let toast: ToastService;
  /** What the page did, in order: 'reserve:<number>:<class>', 'confirm:<id>', 'release:<id>', and 'window.print'. */
  let events: string[] = [];
  /** The HTML each window.print() was asked to print. */
  let printed: string[] = [];
  let defaultDelays: number[] = [];

  /** The browser's print dialog is replaced by a recorder: `behaviour` decides what window.print() does. */
  const fakeWindow = (behaviour: () => void = () => undefined) => ({
    addEventListener: () => undefined,
    focus: () => undefined,
    print: () => { events.push('window.print'); behaviour(); },
  }) as unknown as Window;

  const setup = () => {
    events = [];
    printed = [];
    TestBed.configureTestingModule({
      imports: [TranslateModule.forRoot()],
      providers: [provideHttpClient(), provideHttpClientTesting(), { provide: PrintFontService, useValue: { css: async () => '' } }],
    });
    signInAs('cashier');
    http = TestBed.inject(HttpTestingController);
    service = TestBed.inject(PrintService);
    toast = TestBed.inject(ToastService);
    defaultDelays = [...service.confirmRetryDelaysMs];
    service.confirmRetryDelaysMs = [0, 0, 0];
    TestBed.inject(TranslateService).use('ar');
  };
  /** The iframe's window is replaced by a recorder (installed once per test, it survives resetTestingModule). */
  let frameWindow: jasmine.Spy;
  beforeEach(() => {
    frameWindow = spyOnProperty(HTMLIFrameElement.prototype, 'contentWindow', 'get').and.callFake(function (this: HTMLIFrameElement) {
      printed.push(this.srcdoc);
      return fakeWindow();
    });
  });
  /** Runs the request while answering the POSTs it makes (reserve / confirm / release) and the shop profile read. */
  const run = async (promise: Promise<unknown>, answers: { copyNo?: number; fail?: number; failConfirm?: number | boolean; failRelease?: boolean } = {}) => {
    for (let i = 0; i < 30; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      http.match(`${base}shop-profile`).forEach((request) => request.flush(PROFILE));
      http.match(`${base}print/reserve`).forEach((request) => {
        events.push(`reserve:${request.request.body.number}:${request.request.body.paperClass}`);
        if (answers.fail) request.flush({ message: 'مفيش صلاحية' }, { status: answers.fail, statusText: 'Forbidden' });
        else request.flush({ reservationId: 'r1', number: request.request.body.number, paperClass: request.request.body.paperClass, copyNo: answers.copyNo ?? 1 }, { status: 201, statusText: 'Created' });
      });
      http.match(`${base}print/confirm`).forEach((request) => {
        events.push(`confirm:${request.request.body.reservationId}`);
        if (answers.failConfirm) request.flush({ message: 'x' }, { status: typeof answers.failConfirm === 'number' ? answers.failConfirm : 500, statusText: 'Error' });
        else request.flush({ copyNo: answers.copyNo ?? 1 });
      });
      http.match(`${base}print/release`).forEach((request) => {
        events.push(`release:${request.request.body.reservationId}`);
        if (answers.failRelease) request.flush({ message: 'x' }, { status: 500, statusText: 'Error' });
        else request.flush({ status: 'released' });
      });
    }
    return promise;
  };
  afterEach(() => {
    document.querySelectorAll('iframe[aria-hidden="true"]').forEach((frame) => frame.remove()); // the print frame removes itself only after afterprint / 2 minutes
    http.verify();
  });

  it('prints a numbered 80mm receipt: reserve → window.print → confirm; the iframe gets the HTML of the document', async () => {
    setup();
    const request: PrintRequest = { number: 'INV-000125', build: (ctx) => cashReceipt(ctx, SALE) };
    const outcome = await run(service.print(request));
    expect(outcome).toEqual(jasmine.objectContaining({ ok: true, copy: 1 }));
    const html = printed.find((entry) => entry.includes('INV-000125'))!;
    expect(html).toBeTruthy();
    expect(html).toContain('النور');
    expect(html).not.toContain('data-copy-mark');
    expect(html).toContain('طُبع بواسطة <bdi>محمود</bdi>');
    expect(events).toEqual(['reserve:INV-000125:receipt', 'window.print', 'confirm:r1']);
  });

  it('a print that FAILS (the print frame has no window) releases the reserved number', async () => {
    setup();
    frameWindow.and.returnValue(null);
    const outcome = await run(service.print({ number: 'INV-000125', build: (ctx) => cashInvoice(ctx, SALE) }));
    expect(outcome).toEqual({ ok: false, message: 'print frame has no window' });
    expect(events).toEqual(['reserve:INV-000125:page', 'release:r1']);
    expect(toast.toasts().length).toBe(1);
  });

  it('if the confirm fails after a real print it is retried 3 times (4 attempts), then the user gets the warning; the print is still reported done', async () => {
    setup();
    const outcome = await run(service.print({ number: 'INV-000125', build: (ctx) => cashInvoice(ctx, SALE) }), { failConfirm: true });
    expect(outcome).toEqual(jasmine.objectContaining({ ok: true, copy: 1 }));
    expect(events.filter((event) => event === 'confirm:r1').length).toBe(4);
    expect(events.filter((event) => event.startsWith('release')).length).toBe(0, 'a printed number is never released');
    expect(toast.toasts().some((entry) => entry.text === 'print.notRecorded' || entry.text === 'تمت الطباعة لكن لم تُسجل، بلّغ المدير')).toBeTrue();
  });

  it('a confirm refused with 403 / 404 / 409 is NOT retried (it cannot succeed): one attempt, the warning at once, and no release', async () => {
    for (const status of [403, 404, 409]) {
      TestBed.resetTestingModule();
      setup();
      const outcome = await run(service.print({ number: 'INV-000125', build: (ctx) => cashInvoice(ctx, SALE) }), { failConfirm: status });
      expect(outcome).toEqual(jasmine.objectContaining({ ok: true }));
      expect(events.filter((event) => event === 'confirm:r1').length).toBe(1, `status ${status}`);
      expect(events.filter((event) => event.startsWith('release')).length).toBe(0);
      expect(toast.toasts().some((entry) => entry.text === 'print.notRecorded' || entry.text === 'تمت الطباعة لكن لم تُسجل، بلّغ المدير')).toBeTrue();
      document.querySelectorAll('iframe[aria-hidden="true"]').forEach((frame) => frame.remove());
    }
  });

  it('the retry backoff grows (300, 900, 2000 ms by default)', () => {
    setup();
    expect(defaultDelays).toEqual([300, 900, 2000]);
  });

  it('reserve before window.print(), confirm when the dialog opens', async () => {
    setup();
    const outcome = await run(service.print({ number: 'INV-000125', build: (ctx) => cashInvoice(ctx, SALE) }));
    expect(outcome).toEqual(jasmine.objectContaining({ ok: true, copy: 1 }));
    expect(events).toEqual(['reserve:INV-000125:page', 'window.print', 'confirm:r1']);
  });

  it('a reprint (the server reserves copy 2+) is rendered with the "نسخة n" mark (n = the copy number, the same as the audit) and the reprint time; the original has no mark', async () => {
    setup();
    let builds = 0;
    const outcome = await run(service.print({ number: 'INV-000125', build: (ctx) => { builds += 1; return cashInvoice(ctx, SALE); } }), { copyNo: 3 });
    expect(outcome).toEqual(jasmine.objectContaining({ ok: true, copy: 3 }));
    expect(builds).toBe(2);
    const html = printed[printed.length - 1];
    expect(html).toContain('data-copy-mark');
    expect(html).toContain('نسخة ٣');
    expect(html).not.toContain('نسخة ٢');
    expect(html).toContain('أُعيدت الطباعة');
    await run(service.print({ number: 'INV-000125', build: (ctx) => cashInvoice(ctx, SALE) }), { copyNo: 2 });
    expect(printed[printed.length - 1]).toContain('نسخة ٢');
    await run(service.print({ number: 'INV-000125', build: (ctx) => cashInvoice(ctx, SALE) }), { copyNo: 1 });
    expect(printed[printed.length - 1]).not.toContain('data-copy-mark');
  });

  it('a document without a number (a statement) is not logged; the print language is the UI language', async () => {
    setup();
    TestBed.inject(TranslateService).use('en');
    await run(service.print({ build: (ctx) => customerStatement(ctx, { customer: { name: 'S' }, lines: [], totals: { openingBalance: 0, debit: 0, credit: 0, balance: 0 }, aging: { current: 0, days1to30: 0, days31to60: 0, over60: 0, total: 0 } }) }));
    expect(printed[printed.length - 1]).toContain('<html lang="en" dir="ltr">');
    expect(events).toEqual(['window.print']);
  });

  it('if the server refuses the log (no permission) nothing prints and the user is told', async () => {
    setup();
    const outcome = await run(service.print({ number: 'JE-000001', build: (ctx) => cashInvoice(ctx, SALE) }), { fail: 403 });
    expect(outcome).toEqual({ ok: false, message: 'مفيش صلاحية' });
    expect(events).toEqual(['reserve:JE-000001:page']);
    expect(toast.toasts().some((entry) => entry.text === 'مفيش صلاحية')).toBeTrue();
  });

  it('a document with no shop data reads no shop profile (noShop)', async () => {
    setup();
    await run(service.print({ noShop: true, build: (ctx) => cashInvoice(ctx, SALE) }));
    expect(http.match(`${base}shop-profile`).length).toBe(0);
    expect(printed[printed.length - 1]).not.toContain('المنصورة');
  });

  it('a second print while one is being prepared is ignored (the buttons are disabled meanwhile)', async () => {
    setup();
    const first = service.print({ build: (ctx) => cashInvoice(ctx, SALE) });
    const second = await service.print({ build: (ctx) => cashInvoice(ctx, SALE) });
    expect(second).toEqual({ ok: false, message: '' });
    await run(first);
    expect(events.filter((event) => event === 'window.print').length).toBe(1);
  });
});

describe('print buttons (Stage 23)', () => {
  afterEach(() => document.querySelectorAll('iframe[aria-hidden="true"]').forEach((frame) => frame.remove()));

  it('each format has one "طباعة" button (no Save PDF: the browser dialog does that); the loader runs only on the click; a loader that answers null prints nothing', async () => {
    TestBed.configureTestingModule({ imports: [PrintActionsComponent, TranslateModule.forRoot()], providers: [provideHttpClient(), provideHttpClientTesting(), { provide: PrintFontService, useValue: { css: async () => '' } }] });
    signInAs('cashier');
    const http = TestBed.inject(HttpTestingController);
    const printSpy = spyOn(TestBed.inject(PrintService), 'print');
    const load = jasmine.createSpy('load').and.resolveTo(null);
    const fixture = TestBed.createComponent(PrintActionsComponent);
    fixture.componentRef.setInput('items', [{ key: 'invoice', label: 'A4', load }, { key: 'receipt', label: '80', load }]);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelectorAll('button').length).toBe(2);
    for (const action of ['print-invoice', 'print-receipt']) expect(el.querySelector(`[data-action="${action}"]`)).toBeTruthy();
    expect(el.querySelector('[data-action="pdf-invoice"]')).toBeNull();
    expect(load).not.toHaveBeenCalled();
    (el.querySelector('[data-action="print-invoice"]') as HTMLButtonElement).click();
    await fixture.whenStable();
    expect(load).toHaveBeenCalledTimes(1);
    expect(printSpy).not.toHaveBeenCalled();
    http.verify();
  });

  it('a loader that fails shows an error toast and re-enables the buttons', async () => {
    TestBed.configureTestingModule({ imports: [PrintActionsComponent, TranslateModule.forRoot()], providers: [provideHttpClient(), provideHttpClientTesting(), { provide: PrintFontService, useValue: { css: async () => '' } }] });
    signInAs('cashier');
    const fixture = TestBed.createComponent(PrintActionsComponent);
    fixture.componentRef.setInput('items', [{ key: 'x', load: () => Promise.reject({ error: { message: 'مفيش صلاحية' } }) }]);
    fixture.detectChanges();
    (fixture.nativeElement.querySelector('[data-action="print-x"]') as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(TestBed.inject(ToastService).toasts().map((entry) => entry.text)).toContain('مفيش صلاحية');
    expect(fixture.componentInstance.loading()).toBeFalse();
  });
});

describe('PrintDataService: SR voucher and the shift close summary (Stage 23)', () => {
  const setupData = () => {
    TestBed.configureTestingModule({ imports: [TranslateModule.forRoot()], providers: [provideHttpClient(), provideHttpClientTesting()] });
    signInAs('accountant');
    return { http: TestBed.inject(HttpTestingController), data: TestBed.inject(PrintDataService) };
  };
  const ctx = (): PrintContext => ({ lang: 'ar', shop: toShopInfo(PROFILE), printedBy: 'هالة', printedAt: new Date(2026, 10, 5, 12, 40), fontCss: '', copy: null });

  it('the supplier refund voucher (SR) takes the refund row from the refunds list and the balances from the statement line', async () => {
    const { http, data } = setupData();
    const promise = data.supplierRefundVoucher('s1', 'مورد الاسترداد', { number: 'SR-000003', balance: -700, credit: 300, debit: 0 });
    await new Promise((resolve) => setTimeout(resolve));
    http.expectOne(`${base}suppliers/s1/refunds`).flush({ data: [{ number: 'SR-000003', amount: 300, date: '2026-11-04', boxName: 'الخزنة الرئيسية', note: 'رد <جزء>', status: 'posted' }] });
    await new Promise((resolve) => setTimeout(resolve));
    http.expectOne(`${base}print/journal-ref/SR-000003`).flush({ number: 'SR-000003', journalNumber: 'JE-000044' });
    const request = await promise;
    expect(request.number).toBe('SR-000003');
    const doc = request.build(ctx());
    expect(doc.paper).toBe('A5');
    const out = buildPrintHtml(ctx(), doc);
    expect(out).toContain('data-voucher="SR"');
    expect(out).toContain('سند قبض (استرداد من مورد)');
    expect(out).toContain('استلمنا من');
    expect(out).toContain('مورد الاسترداد');
    expect(out).toContain('ثلاثمائة جنيهًا مصريًا فقط لا غير');
    expect(out).toContain('الخزنة الرئيسية');
    expect(out).toContain('رد &lt;جزء&gt;');
    expect(out).toContain('JE-000044');
    expect(out).toContain('−٧٠٠٫٠٠'); // the balance after (we are owed 700) ...
    expect(out).toContain('−١٬٠٠٠٫٠٠'); // ... and before: -700 - 300 = -1,000 (an advance)
    http.verify();
  });

  it('a refund that is not in the list is an error, not an empty voucher; a cancelled refund prints with the watermark', async () => {
    const { http, data } = setupData();
    const missing = data.supplierRefundVoucher('s1', 'م', { number: 'SR-000009', balance: 0, credit: 1, debit: 0 }).catch((error: Error) => error.message);
    await new Promise((resolve) => setTimeout(resolve));
    http.expectOne(`${base}suppliers/s1/refunds`).flush({ data: [] });
    expect(await missing).toBe('SR_NOT_FOUND');
    const cancelled = data.supplierRefundVoucher('s1', 'م', { number: 'SR-000010', balance: 0, credit: 1, debit: 0 });
    await new Promise((resolve) => setTimeout(resolve));
    http.expectOne(`${base}suppliers/s1/refunds`).flush({ data: [{ number: 'SR-000010', amount: 1, date: '2026-11-04', boxName: null, status: 'cancelled' }] });
    await new Promise((resolve) => setTimeout(resolve));
    http.expectOne(`${base}print/journal-ref/SR-000010`).flush({ number: 'SR-000010', journalNumber: null });
    expect(buildPrintHtml(ctx(), (await cancelled).build(ctx()))).toContain('data-cancelled-watermark');
    http.verify();
  });

  it('the shift close report prints the sales summary of the server: cash, credit (for information), returns, discounts', () => {
    const { data } = setupData();
    const request = data.shiftClose({
      _id: 'sh1', number: 'SH-000058', boxId: 'b1', boxName: 'درج الكاشير ١', userId: 'u', userName: 'محمود', openedAt: '2026-11-05T07:00:00Z', openingFloat: 500, openingBalance: 500,
      closedAt: '2026-11-05T15:00:00Z', closedByName: 'محمود', expected: 7550, counted: 7500, difference: -50, differenceNote: 'فكّة', depositBoxId: null, depositAmount: 0, status: 'closed', remaining: 7500,
      lines: [{ key: 'float', amount: 500 }, { key: 'sales', amount: 6820 }, { key: 'receipts', amount: 600 }, { key: 'refunds', amount: 120 }, { key: 'expenses', amount: 250 }],
      salesSummary: { cash: { count: 31, total: 6820 }, credit: { count: 6, total: 4980 }, returns: { count: 2, total: 120 }, discounts: 185 },
    });
    const out = buildPrintHtml(ctx(), request.build(ctx()), 200);
    expect(out).toContain('ملخص المبيعات');
    expect(out).toContain('فواتير كاش');
    expect(out).toContain('٣١ · ٦٬٨٢٠٫٠٠');
    expect(out).toContain('فواتير آجل (للعلم)');
    expect(out).toContain('٦ · ٤٬٩٨٠٫٠٠');
    expect(out).toContain('مرتجعات');
    expect(out).toContain('٢ · ١٢٠٫٠٠');
    expect(out).toContain('خصومات');
    expect(out).toContain('١٨٥٫٠٠');
    // an older server without the field: the report prints without the summary block
    const old = data.shiftClose({ number: 'SH-1', boxName: 'ب', userName: 'ك', openedAt: null, closedAt: null, lines: [], expected: 1, counted: 1, difference: 0, depositAmount: 0, remaining: 1 } as never);
    expect(buildPrintHtml(ctx(), old.build(ctx()), 200)).not.toContain('ملخص المبيعات');
  });
});
