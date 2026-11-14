// Stage 23: the print pipeline in the app: context, the server's print log (copy numbers), the desktop bridge calls
// (page size, token, "طباعة" / "حفظ PDF"), auto-print off by default, errors, the shared buttons and the settings card.

import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { environment } from '../../../environments/environment';
import { PrintSettingsCardComponent } from '../../modules/shop-profile/components/print-settings-card/print-settings-card.component';
import { ShopProfile } from '../../modules/shop-profile/models/shop-profile.model';
import { ToastService } from '../auth/toast.service';
import { signInAs } from '../auth/testing/sign-in';
import { DesktopPrintBridge, DesktopPrintSettings, NotaDesktopBridge } from '../runtime/runtime-config';
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
const SETTINGS: DesktopPrintSettings = { receiptPrinter: 'EPSON', documentPrinter: '', autoPrintReceipt: false, receiptCopies: 1 };

type Fake = { [K in keyof DesktopPrintBridge]: jasmine.Spy };
function fakeBridge(settings: DesktopPrintSettings = SETTINGS): Fake {
  return {
    printers: jasmine.createSpy('printers').and.resolveTo({ ok: true, value: [{ name: 'EPSON', displayName: 'Epson TM', isDefault: false }, { name: 'HP', displayName: 'HP LaserJet', isDefault: true }] }),
    getSettings: jasmine.createSpy('getSettings').and.callFake(async () => ({ ok: true, value: settings })),
    setSettings: jasmine.createSpy('setSettings').and.callFake(async (_token: string, patch: Partial<DesktopPrintSettings>) => ({ ok: true, value: { ...settings, ...patch } })),
    testPage: jasmine.createSpy('testPage').and.resolveTo({ ok: true, value: { printed: true, printer: 'EPSON' } }),
    print: jasmine.createSpy('print').and.resolveTo({ ok: true, value: { printed: true, silent: true, printer: 'EPSON' } }),
    savePdf: jasmine.createSpy('savePdf').and.resolveTo({ ok: true, value: { saved: true, path: 'C:\\x.pdf' } }),
  };
}

describe('PrintService (Stage 23)', () => {
  let http: HttpTestingController;
  let service: PrintService;
  let bridge: Fake;
  let toast: ToastService;
  /** What the page asked the server, in order: 'reserve:<number>:<class>', 'confirm:<id>', 'release:<id>', mixed with 'bridge:print' / 'bridge:pdf'. */
  let events: string[] = [];
  let defaultDelays: number[] = [];

  const setup = (settings?: DesktopPrintSettings) => {
    events = [];
    bridge = fakeBridge(settings);
    bridge['print'].and.callFake(async () => { events.push('bridge:print'); return { ok: true, value: { printed: true, silent: true, printer: 'EPSON' } }; });
    bridge['savePdf'].and.callFake(async () => { events.push('bridge:pdf'); return { ok: true, value: { saved: true, path: 'C:\\x.pdf' } }; });
    (window as unknown as { notaDesktop?: Partial<NotaDesktopBridge> }).notaDesktop = { print: bridge as unknown as DesktopPrintBridge };
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
  const profile = async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve));
    http.match(`${base}shop-profile`).forEach((request) => request.flush(PROFILE));
  };
  /** Runs the request while answering the POSTs it makes (reserve / confirm / release) and the shop profile read. */
  const run = async (promise: Promise<unknown>, answers: { copyNo?: number; fail?: number; failConfirm?: boolean; failRelease?: boolean } = {}) => {
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
        if (answers.failConfirm) request.flush({ message: 'x' }, { status: 500, statusText: 'Error' });
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
    delete (window as unknown as { notaDesktop?: unknown }).notaDesktop;
    http.verify();
  });

  it('prints a numbered 80mm receipt: reserve → print → confirm; sends the HTML, paper and measured height with the session token', async () => {
    setup();
    const request: PrintRequest = { number: 'INV-000125', build: (ctx) => cashReceipt(ctx, SALE) };
    const outcome = await run(service.print(request));
    expect(outcome).toEqual(jasmine.objectContaining({ ok: true, silent: true, copy: 1 }));
    expect(bridge['print']).toHaveBeenCalledTimes(1);
    const [token, job] = bridge['print'].calls.mostRecent().args;
    expect(token).toBe('test-token-cashier');
    expect(job.paper).toBe('80mm');
    expect(job.heightMm).toBeGreaterThan(40);
    expect(job.html).toContain('INV-000125');
    expect(job.html).toContain('النور');
    expect(job.html).not.toContain('data-copy-mark');
    expect(job.html).toContain('طُبع بواسطة محمود');
    expect(events).toEqual(['reserve:INV-000125:receipt', 'bridge:print', 'confirm:r1']);
  });

  it('a cancelled print dialog releases the reserved number (nothing is confirmed)', async () => {
    setup();
    bridge['print'].and.callFake(async () => { events.push('bridge:print'); return { ok: true, value: { printed: false, cancelled: true, silent: false, printer: null } }; });
    const outcome = await run(service.print({ number: 'INV-000125', build: (ctx) => cashInvoice(ctx, SALE) }));
    expect(outcome).toEqual(jasmine.objectContaining({ ok: true, cancelled: true }));
    expect(events).toEqual(['reserve:INV-000125:page', 'bridge:print', 'release:r1']);
  });

  it('a print that FAILS (the printer says no, or the bridge throws) releases the number too', async () => {
    setup();
    bridge['print'].and.callFake(async () => { events.push('bridge:print'); return { ok: false, error: { message: 'الطابعة غير متصلة', code: 'PRINT_FAILED' } }; });
    const outcome = await run(service.print({ number: 'INV-000125', build: (ctx) => cashInvoice(ctx, SALE) }));
    expect(outcome).toEqual({ ok: false, message: 'الطابعة غير متصلة' });
    expect(events).toEqual(['reserve:INV-000125:page', 'bridge:print', 'release:r1']);
    events.length = 0;
    bridge['print'].and.callFake(async () => { events.push('bridge:print'); throw new Error('boom'); });
    const thrown = await run(service.print({ number: 'INV-000125', build: (ctx) => cashInvoice(ctx, SALE) }));
    expect(thrown).toEqual({ ok: false, message: 'boom' });
    expect(events).toEqual(['reserve:INV-000125:page', 'bridge:print', 'release:r1']);
  });

  it('a PDF save is confirmed (in the paper class of the document); a cancelled save dialog releases', async () => {
    setup();
    const saved = await run(service.savePdf({ number: 'INV-000125', build: (ctx) => cashInvoice(ctx, SALE) }));
    expect(saved).toEqual(jasmine.objectContaining({ ok: true, cancelled: false }));
    expect(events).toEqual(['reserve:INV-000125:page', 'bridge:pdf', 'confirm:r1']);
    events.length = 0;
    bridge['savePdf'].and.callFake(async () => { events.push('bridge:pdf'); return { ok: true, value: { saved: false } }; });
    const cancelled = await run(service.savePdf({ number: 'INV-000125', build: (ctx) => cashInvoice(ctx, SALE) }));
    expect(cancelled).toEqual(jasmine.objectContaining({ ok: true, cancelled: true }));
    expect(events).toEqual(['reserve:INV-000125:page', 'bridge:pdf', 'release:r1']);
  });

  it('if the confirm fails after a real print it is retried 3 times (4 attempts), then the user gets the warning; the print is still reported done', async () => {
    setup();
    const outcome = await run(service.print({ number: 'INV-000125', build: (ctx) => cashInvoice(ctx, SALE) }), { failConfirm: true });
    expect(outcome).toEqual(jasmine.objectContaining({ ok: true, copy: 1 }));
    expect(events.filter((event) => event === 'confirm:r1').length).toBe(4);
    expect(events.filter((event) => event.startsWith('release')).length).toBe(0, 'a printed number is never released');
    expect(toast.toasts().some((entry) => entry.text === 'print.notRecorded' || entry.text === 'تمت الطباعة لكن لم تُسجل، بلّغ المدير')).toBeTrue();
  });

  it('the retry backoff grows (300, 900, 2000 ms by default)', () => {
    setup();
    expect(defaultDelays).toEqual([300, 900, 2000]);
  });

  it('a failed release is harmless: the cancel is still reported cancelled', async () => {
    setup();
    bridge['print'].and.resolveTo({ ok: true, value: { printed: false, cancelled: true } });
    const outcome = await run(service.print({ number: 'INV-000125', build: (ctx) => cashInvoice(ctx, SALE) }), { failRelease: true });
    expect(outcome).toEqual(jasmine.objectContaining({ ok: true, cancelled: true }));
  });

  it('dev browser (no desktop bridge): reserve before window.print(), confirm when the dialog opens', async () => {
    setup();
    delete (window as unknown as { notaDesktop?: unknown }).notaDesktop;
    spyOnProperty(HTMLIFrameElement.prototype, 'contentWindow', 'get').and.returnValue({ addEventListener: () => undefined, focus: () => undefined, print: () => { events.push('window.print'); } } as unknown as Window);
    const outcome = await run(service.print({ number: 'INV-000125', build: (ctx) => cashInvoice(ctx, SALE) }));
    expect(outcome).toEqual(jasmine.objectContaining({ ok: true, copy: 1 }));
    expect(events).toEqual(['reserve:INV-000125:page', 'window.print', 'confirm:r1']);
    document.querySelectorAll('iframe[aria-hidden="true"]').forEach((frame) => frame.remove()); // the dev print frame removes itself only after afterprint / 2 minutes
  });

  it('a reprint (the server reserves copy 2+) is rendered with the "نسخة" mark and the reprint time; the original has no mark', async () => {
    setup();
    let builds = 0;
    const outcome = await run(service.print({ number: 'INV-000125', build: (ctx) => { builds += 1; return cashInvoice(ctx, SALE); } }), { copyNo: 3 });
    expect(outcome).toEqual(jasmine.objectContaining({ ok: true, copy: 3 }));
    expect(builds).toBe(2);
    const job = bridge['print'].calls.mostRecent().args[1];
    expect(job.paper).toBe('A4');
    expect(job.html).toContain('data-copy-mark');
    expect(job.html).toContain('نسخة ٢');
    expect(job.html).toContain('أُعيدت الطباعة');
    bridge['print'].calls.reset();
    await run(service.print({ number: 'INV-000125', build: (ctx) => cashInvoice(ctx, SALE) }), { copyNo: 2 });
    expect(bridge['print'].calls.mostRecent().args[1].html).toContain('data-copy-mark');
    expect(bridge['print'].calls.mostRecent().args[1].html).not.toContain('نسخة ٢');
    bridge['print'].calls.reset();
    await run(service.print({ number: 'INV-000125', build: (ctx) => cashInvoice(ctx, SALE) }), { copyNo: 1 });
    expect(bridge['print'].calls.mostRecent().args[1].html).not.toContain('data-copy-mark');
  });

  it('"حفظ PDF" goes through savePdf with the document title as the suggested name', async () => {
    setup();
    const outcome = await run(service.savePdf({ number: 'INV-000125', build: (ctx) => cashInvoice(ctx, SALE) }));
    expect(outcome).toEqual(jasmine.objectContaining({ ok: true, cancelled: false }));
    expect(bridge['savePdf']).toHaveBeenCalledTimes(1);
    expect(bridge['print']).not.toHaveBeenCalled();
    expect(bridge['savePdf'].calls.mostRecent().args[2]).toEqual({ suggestedName: 'INV-000125' });
  });

  it('a document without a number (a statement) is not logged; the print language is the UI language', async () => {
    setup();
    TestBed.inject(TranslateService).use('en');
    await run(service.print({ build: (ctx) => customerStatement(ctx, { customer: { name: 'S' }, lines: [], totals: { openingBalance: 0, debit: 0, credit: 0, balance: 0 }, aging: { current: 0, days1to30: 0, days31to60: 0, over60: 0, total: 0 } }) }));
    expect(bridge['print'].calls.mostRecent().args[1].html).toContain('<html lang="en" dir="ltr">');
    expect(bridge['print'].calls.mostRecent().args[1].paper).toBe('A4');
  });

  it('if the server refuses the log (no permission) nothing prints and the user is told', async () => {
    setup();
    const outcome = await run(service.print({ number: 'JE-000001', build: (ctx) => cashInvoice(ctx, SALE) }), { fail: 403 });
    expect(outcome).toEqual({ ok: false, message: 'مفيش صلاحية' });
    expect(bridge['print']).not.toHaveBeenCalled();
    expect(toast.toasts().some((entry) => entry.text === 'مفيش صلاحية')).toBeTrue();
  });

  it('a desktop error (no session, printer offline) is shown, not thrown', async () => {
    setup();
    bridge['print'].and.resolveTo({ ok: false, error: { message: 'انتهت الجلسة', code: 'SESSION_EXPIRED' } });
    const outcome = await run(service.print({ build: (ctx) => cashInvoice(ctx, SALE) }));
    expect(outcome).toEqual({ ok: false, message: 'انتهت الجلسة' });
    expect(toast.toasts().length).toBe(1);
  });

  it('auto-print after a sale is OFF by default and prints only when this PC has it on', async () => {
    setup(SETTINGS);
    const loader = jasmine.createSpy('load').and.callFake(() => ({ number: 'INV-000125', build: (ctx: never) => cashReceipt(ctx, SALE) }));
    expect(await run(service.autoPrintReceipt(loader))).toBeNull();
    expect(loader).not.toHaveBeenCalled();
    expect(bridge['print']).not.toHaveBeenCalled();
    http.verify();
    TestBed.resetTestingModule();
    setup({ ...SETTINGS, autoPrintReceipt: true });
    const on = await run(service.autoPrintReceipt(loader));
    expect(on).toEqual(jasmine.objectContaining({ ok: true }));
    expect(bridge['print']).toHaveBeenCalledTimes(1);
  });

  it('auto-print outside the desktop app (no bridge) does nothing and never throws', async () => {
    setup();
    delete (window as unknown as { notaDesktop?: unknown }).notaDesktop;
    expect(await service.autoPrintReceipt(() => ({ build: (ctx) => cashReceipt(ctx, SALE) }))).toBeNull();
  });

  it('the recovery code sheet reads no shop profile (the shop may not exist yet)', async () => {
    setup();
    await run(service.print({ noShop: true, build: (ctx) => cashInvoice(ctx, SALE) }));
    expect(http.match(`${base}shop-profile`).length).toBe(0);
    expect(bridge['print'].calls.mostRecent().args[1].html).not.toContain('المنصورة');
  });

  it('a test page goes to the printer picked in the dropdown (sent with the request); without a pick, the saved one', async () => {
    setup();
    await run(service.testPage('receipt', 'HP'));
    expect(bridge['testPage'].calls.mostRecent().args[1].printer).toBe('HP');
    expect(bridge['testPage'].calls.mostRecent().args[1].html).toContain('HP');
    await run(service.testPage('receipt', ''));
    expect(bridge['testPage'].calls.mostRecent().args[1].printer).toBe('');
    await run(service.testPage('receipt'));
    expect(bridge['testPage'].calls.mostRecent().args[1].printer).toBe('EPSON');
  });

  it('test pages go to the desktop app with the page kind and the HTML', async () => {
    setup();
    const outcome = await run(service.testPage('receipt'));
    expect(outcome).toEqual(jasmine.objectContaining({ ok: true }));
    const [, request] = bridge['testPage'].calls.mostRecent().args;
    expect(request.kind).toBe('receipt');
    expect(request.html).toContain('EPSON');
    expect(request.heightMm).toBeGreaterThan(40);
    await run(service.testPage('document'));
    expect(bridge['testPage'].calls.mostRecent().args[1].kind).toBe('document');
  });

  it('a second print while one is being prepared is ignored (the buttons are disabled meanwhile)', async () => {
    setup();
    const first = service.print({ build: (ctx) => cashInvoice(ctx, SALE) });
    const second = await service.print({ build: (ctx) => cashInvoice(ctx, SALE) });
    expect(second).toEqual({ ok: false, message: '' });
    await run(first);
    expect(bridge['print']).toHaveBeenCalledTimes(1);
    void profile;
  });
});

describe('print buttons and the print settings card (Stage 23)', () => {
  afterEach(() => delete (window as unknown as { notaDesktop?: unknown }).notaDesktop);

  it('each format has a "طباعة" and a "حفظ PDF" button; the loader runs only on the click; a loader that answers null prints nothing', async () => {
    const bridge = fakeBridge();
    (window as unknown as { notaDesktop?: Partial<NotaDesktopBridge> }).notaDesktop = { print: bridge as unknown as DesktopPrintBridge };
    TestBed.configureTestingModule({ imports: [PrintActionsComponent, TranslateModule.forRoot()], providers: [provideHttpClient(), provideHttpClientTesting(), { provide: PrintFontService, useValue: { css: async () => '' } }] });
    signInAs('cashier');
    const http = TestBed.inject(HttpTestingController);
    const load = jasmine.createSpy('load').and.resolveTo(null);
    const fixture = TestBed.createComponent(PrintActionsComponent);
    fixture.componentRef.setInput('items', [{ key: 'invoice', label: 'A4', load }, { key: 'receipt', label: '80', load }]);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelectorAll('button').length).toBe(4);
    for (const action of ['print-invoice', 'pdf-invoice', 'print-receipt', 'pdf-receipt']) expect(el.querySelector(`[data-action="${action}"]`)).toBeTruthy();
    expect(load).not.toHaveBeenCalled();
    (el.querySelector('[data-action="print-invoice"]') as HTMLButtonElement).click();
    await fixture.whenStable();
    expect(load).toHaveBeenCalledTimes(1);
    expect(bridge['print']).not.toHaveBeenCalled();
    fixture.componentRef.setInput('pdf', false);
    fixture.detectChanges();
    expect(el.querySelectorAll('button').length).toBe(2);
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

  it('the settings card lists the printers, saves the choice per device, and the test page uses the selected printer without saving; outside the desktop app it says so', async () => {
    const bridge = fakeBridge();
    (window as unknown as { notaDesktop?: Partial<NotaDesktopBridge> }).notaDesktop = { print: bridge as unknown as DesktopPrintBridge };
    const testPage = jasmine.createSpy('testPage').and.resolveTo({ ok: true });
    TestBed.configureTestingModule({ imports: [PrintSettingsCardComponent, TranslateModule.forRoot()], providers: [provideHttpClient(), provideHttpClientTesting(), { provide: PrintService, useValue: { testPage } }] });
    signInAs('owner');
    const http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(PrintSettingsCardComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const receipt = el.querySelector('[data-field="receipt-printer"]') as HTMLSelectElement;
    expect(Array.from(receipt.options).map((option) => option.value)).toEqual(['', 'EPSON', 'HP']);
    const component = fixture.componentInstance;
    expect(component.receiptPrinter()).toBe('EPSON'); // the saved choice of this PC
    component.receiptPrinter.set('HP');
    component.autoPrint.set(true);
    component.copies.set(3);
    fixture.detectChanges();
    (el.querySelector('[data-action="save-print-settings"]') as HTMLButtonElement).click();
    await fixture.whenStable();
    expect(bridge['setSettings']).toHaveBeenCalledWith('test-token-owner', { receiptPrinter: 'HP', documentPrinter: '', autoPrintReceipt: true, receiptCopies: 3 });
    bridge['setSettings'].calls.reset();
    // the test page goes to the printer selected NOW in the dropdown, saved or not, and saves nothing
    component.documentPrinter.set('HP');
    await component.test('document');
    expect(bridge['setSettings']).not.toHaveBeenCalled();
    expect(testPage).toHaveBeenCalledOnceWith('document', 'HP');
    testPage.calls.reset();
    component.receiptPrinter.set('EPSON');
    await component.test('receipt');
    expect(testPage).toHaveBeenCalledOnceWith('receipt', 'EPSON');
    testPage.calls.reset();
    component.receiptPrinter.set('');
    await component.test('receipt');
    expect(testPage).toHaveBeenCalledOnceWith('receipt', '');
    http.verify();
  });

  it('outside the desktop app the card explains that print settings need the desktop app', async () => {
    TestBed.configureTestingModule({ imports: [PrintSettingsCardComponent, TranslateModule.forRoot()], providers: [provideHttpClient(), provideHttpClientTesting()] });
    signInAs('owner');
    const fixture = TestBed.createComponent(PrintSettingsCardComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).querySelector('[data-test="print-desktop-only"]')).toBeTruthy();
    expect((fixture.nativeElement as HTMLElement).querySelector('[data-action="save-print-settings"]')).toBeNull();
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
