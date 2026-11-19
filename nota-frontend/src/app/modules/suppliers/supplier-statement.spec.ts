import { ComponentFixture, TestBed } from '@angular/core/testing';
import { lockRefreshSpy } from '../../test-setup.spec';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { TranslateModule } from '@ngx-translate/core';
import { environment } from '../../../environments/environment';
import { signInAs, signInWith } from '../../core/auth/testing/sign-in';
import { flushPaymentBoxes } from '../cashbox/testing/payment-boxes.testing';
import { SupplierStatement } from '../purchases/purchases.models';
import { LanguageService } from '../shared/services/translation.service';
import { SupplierPaymentDialogComponent } from './supplier-payment-dialog.component';
import { SupplierRefundDialogComponent } from './supplier-refund-dialog.component';
import { SupplierStatementComponent, statementDocument } from './supplier-statement.component';
import { SuppliersPageComponent } from './suppliers-page.component';
import { Supplier } from './suppliers.service';

const base = environment.api_base_url;
const settle = async (fixture: ComponentFixture<unknown>) => { fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges(); };

const supplier = (overrides: Partial<Supplier> = {}): Supplier => ({
  _id: 's1', name: 'الشركة المصرية للإضاءة', phones: ['01027784410'], contactPerson: 'م. وائل', address: 'العبور', isActive: true, paymentTermsDays: 30, balance: 6650, openingAmount: 4200, ledgerAccountId: 'acc21',
  lastPurchaseAt: '2026-11-03T00:00:00.000Z', ...overrides,
});

/** The design's statement: opening 4,200, the design invoice 5,450, its PV 3,000. */
const STATEMENT: SupplierStatement = {
  supplier: { _id: 's1', name: 'الشركة المصرية للإضاءة', paymentTermsDays: 30 },
  lines: [
    { date: '2026-09-01', type: 'opening_balance', number: null, description: 'رصيد أول المدة', debit: 0, credit: 4200, balance: 4200 },
    { date: '2026-11-03', type: 'purchase', number: 'PO-000012', supplierInvoiceNo: 'EL-8841', description: 'فاتورة شراء', debit: 0, credit: 5450, balance: 9650 },
    { date: '2026-11-03', type: 'payment', number: 'PV-000017', description: 'دفعة مع الفاتورة', debit: 3000, credit: 0, balance: 6650 },
  ],
  openingBalance: 0, totals: { debit: 3000, credit: 9650, balance: 6650 }, balance: 6650, ledgerBalance: 6650,
  aging: { current: 2450, d1_30: 0, d31_60: 0, d61_90: 0, d90plus: 4200, total: 6650, advance: 0 },
};

/** Online Fixes 1: the statement panel also reads the supplier's payment vouchers (the old specs answer that request with an empty list). */
const answerPayments = (http: HttpTestingController): void => http.match((request) => /suppliers\/[^/]+\/payments$/.test(request.url)).forEach((request) => request.flush({ data: [] }));

describe('statementDocument (our number first, always)', () => {
  it('"PO-000012 · EL-8841", a payment shows only its PV number, the opening shows nothing', () => {
    expect(statementDocument({ number: 'PO-000012', supplierInvoiceNo: 'EL-8841' })).toBe('PO-000012 · EL-8841');
    expect(statementDocument({ number: 'PO-000013', supplierInvoiceNo: null })).toBe('PO-000013');
    expect(statementDocument({ number: 'PV-000017' })).toBe('PV-000017');
    expect(statementDocument({ number: null })).toBe('');
  });
});

describe('SupplierStatementComponent (Stage 20)', () => {
  const open = async (permissions: string[] | 'owner' = 'owner', data: Supplier = supplier()) => {
    await TestBed.configureTestingModule({
      imports: [SupplierStatementComponent, TranslateModule.forRoot()], providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([]), provideNoopAnimations()],
    }).compileComponents();
    if (permissions === 'owner') signInAs('owner'); else signInWith(permissions);
    TestBed.inject(LanguageService).selectedLanguage.set('en');
    const http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(SupplierStatementComponent);
    fixture.componentRef.setInput('supplier', data);
    fixture.detectChanges();
    return { fixture, http, component: fixture.componentInstance };
  };

  it('loads the statement of the supplier: lines, running balance, the document column, totals and the aging', async () => {
    const { fixture, http } = await open();
    http.expectOne((r) => r.url === `${base}suppliers/s1/statement`).flush(STATEMENT);
    await settle(fixture);
    const rows = fixture.nativeElement.querySelectorAll('[data-test="statement"] tbody tr');
    expect(rows.length).toBe(3);
    expect(rows[0].textContent).toContain('رصيد أول المدة'); expect(rows[0].textContent).toContain('4,200');
    expect(rows[1].querySelector('[data-test="document"]').textContent.trim()).toBe('PO-000012 · EL-8841');
    expect(rows[2].querySelector('[data-test="document"]').textContent.trim()).toBe('PV-000017');
    expect(rows[2].textContent).toContain('6,650');
    const totals = fixture.nativeElement.querySelector('[data-test="statement-totals"]').textContent;
    expect(totals).toContain('3,000'); expect(totals).toContain('9,650'); expect(totals).toContain('6,650');
    expect(fixture.nativeElement.querySelector('[data-bucket="d90plus"]').textContent).toContain('4,200');
    expect(fixture.nativeElement.querySelector('[data-bucket="current"]').textContent).toContain('2,450');
    expect(fixture.nativeElement.querySelector('[data-bucket="advance"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('[data-test="panel-balance"]').textContent).toContain('6,650');
    answerPayments(http);
    http.verify();
  });

  it('a supplier refund line (SR) has its A5 voucher print button; no other line has one (Stage 23)', async () => {
    const { fixture, http } = await open();
    http.expectOne((r) => r.url === `${base}suppliers/s1/statement`).flush({ ...STATEMENT, lines: [...STATEMENT.lines, { date: '2026-11-04', type: 'supplier_refund', number: 'SR-000003', description: 'استرداد من مورد', debit: 0, credit: 300, balance: 6950 }] });
    await settle(fixture);
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelectorAll('[data-test="refund-print"]').length).toBe(1);
    expect(el.querySelector('[data-test="refund-print"] [data-action="print-refund-SR-000003"]')).toBeTruthy();
    expect(el.querySelector('[data-line="supplier_refund"] [data-test="refund-print"]')).toBeTruthy();
    expect(el.querySelector('[data-line="purchase"] [data-test="refund-print"]')).toBeNull();
    answerPayments(http);
    http.verify();
  });

  it('an advance shows as "لينا" with the advance line in the aging', async () => {
    const { fixture, http } = await open('owner', supplier({ balance: -800 }));
    http.expectOne((r) => r.url === `${base}suppliers/s1/statement`).flush({ ...STATEMENT, balance: -800, aging: { ...STATEMENT.aging, total: 0, current: 0, d90plus: 0, advance: 800 } });
    await settle(fixture);
    expect(fixture.nativeElement.querySelector('[data-test="panel-balance"]').classList).toContain('ss__advance');
    expect(fixture.nativeElement.textContent).toContain('suppliers.statement.advance');
    expect(fixture.nativeElement.querySelector('[data-bucket="advance"]').textContent).toContain('800');
    answerPayments(http);
    http.verify();
  });

  it('pay, new-purchase and print buttons: permissions decide, and print stays hidden behind its flag', async () => {
    const owner = await open();
    owner.http.expectOne((r) => r.url === `${base}suppliers/s1/statement`).flush(STATEMENT);
    await settle(owner.fixture);
    const el = owner.fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-action="pay"]')).toBeTruthy();
    expect(el.querySelector('[data-action="new-purchase"]')!.getAttribute('href')).toBe('/purchases/new?supplier=s1');
    // Stage 23: the statement has its print buttons (PrSupplierStatement)
    expect(el.querySelector('[data-action="print-statement"]')).toBeTruthy();
    expect(el.querySelector('[data-action="pdf-statement"]')).toBeNull(); // the browser dialog saves PDFs
    const paid: unknown[] = [];
    owner.component.pay.subscribe((row) => paid.push(row));
    (el.querySelector('[data-action="pay"]') as HTMLButtonElement).click();
    expect(paid.length).toBe(1);

    TestBed.resetTestingModule();
    const viewer = await open(['suppliers.view']);
    viewer.http.expectOne((r) => r.url === `${base}suppliers/s1/statement`).flush(STATEMENT);
    await settle(viewer.fixture);
    expect(viewer.fixture.nativeElement.querySelector('[data-action="pay"]')).toBeNull();
    expect(viewer.fixture.nativeElement.querySelector('[data-action="new-purchase"]')).toBeNull();
  });

  it('reloads when the supplier changes or the page asks (refreshKey) and shows a retry on failure', async () => {
    const { fixture, http } = await open();
    http.expectOne((r) => r.url === `${base}suppliers/s1/statement`).flush({}, { status: 500, statusText: 'Server Error' });
    await settle(fixture);
    expect(fixture.nativeElement.textContent).toContain('suppliers.statement.loadFailed');
    fixture.componentRef.setInput('refreshKey', 1);
    fixture.detectChanges();
    http.expectOne((r) => r.url === `${base}suppliers/s1/statement`).flush(STATEMENT);
    await settle(fixture);
    expect(fixture.nativeElement.querySelector('[data-test="statement"]')).toBeTruthy();
    answerPayments(http);
    http.verify();
  });
});

describe('SupplierPaymentDialogComponent (Stage 20)', () => {
  const open = async (data: Supplier = supplier({ balance: 6650 })) => {
    await TestBed.configureTestingModule({
      imports: [SupplierPaymentDialogComponent, TranslateModule.forRoot()], providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([]), provideNoopAnimations()],
    }).compileComponents();
    signInAs('owner');
    TestBed.inject(LanguageService).selectedLanguage.set('en');
    const http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(SupplierPaymentDialogComponent);
    fixture.componentRef.setInput('supplier', data);
    fixture.detectChanges();
    fixture.componentInstance.visible.set(true);
    await settle(fixture);
    flushPaymentBoxes(http);
    await settle(fixture);
    return { fixture, http, component: fixture.componentInstance };
  };

  it('re-reads the lock date each time the dialog opens (Stage 22 review)', async () => {
    const { fixture, component } = await open();
    expect(lockRefreshSpy()).toHaveBeenCalledTimes(1);
    component.visible.set(false); await settle(fixture);
    component.visible.set(true); await settle(fixture);
    expect(lockRefreshSpy()).toHaveBeenCalledTimes(2);
  });

  it("the design's payment: 6,650 now, 2,500 from the bank, 4,150 after; saves the exact body", async () => {
    const { fixture, http, component } = await open();
    component.amount.set(2500); component.date.set('2026-11-04'); component.reference.set(' CHQ-77 '); component.note.set('دفعة');
    await settle(fixture);
    expect(component.after()).toBe(4150);
    expect(document.body.querySelector('[data-test="balance-now"]')!.textContent).toContain('6,650');
    expect(document.body.querySelector('[data-test="balance-after"]')!.textContent).toContain('4,150');
    expect(component.valid()).toBeTrue();
    expect(component.isAdvance()).toBeFalse();
    const done: { number: string; balanceAfter: number; amount?: number }[] = [];
    component.done.subscribe((row) => done.push(row));
    component.save();
    const req = http.expectOne(`${base}suppliers/s1/payments`);
    expect(req.request.body).toEqual({ amount: 2500, date: '2026-11-04', reference: 'CHQ-77', note: 'دفعة' });
    req.flush({ _id: 'pv2', number: 'PV-000002', balanceAfter: 4150, amount: 2500, date: '2026-11-04' });
    // Stage 23: the event also carries what the PV voucher prints (amount, date, box name, reference, note)
    expect(done).toEqual([jasmine.objectContaining({ number: 'PV-000002', balanceAfter: 4150, amount: 2500, date: '2026-11-04', reference: 'CHQ-77', note: 'دفعة' })]);
    expect(component.visible()).toBeFalse();
    answerPayments(http);
    http.verify();
  });

  it('an amount above what we owe is an advance: it needs the confirm, then sends confirmAdvance', async () => {
    const { fixture, http, component } = await open(supplier({ balance: 1000 }));
    component.amount.set(1500);
    await settle(fixture);
    expect(component.isAdvance()).toBeTrue();
    expect(component.after()).toBe(-500);
    expect(component.valid()).toBeFalse();
    expect(document.body.querySelector('[data-test="advance-note"]')).toBeTruthy();
    component.confirmAdvance.set(true);
    expect(component.valid()).toBeTrue();
    component.save();
    const req = http.expectOne(`${base}suppliers/s1/payments`);
    expect(req.request.body.confirmAdvance).toBeTrue();
    expect(req.request.body.amount).toBe(1500);
    req.flush({ _id: 'pv3', number: 'PV-000003', balanceAfter: -500 });
    answerPayments(http);
    http.verify();
  });

  it('a supplier we owe nothing needs the confirm for any payment; zero and empty amounts are invalid', async () => {
    const { component } = await open(supplier({ balance: 0 }));
    expect(component.valid()).toBeFalse();
    component.amount.set(10);
    expect(component.isAdvance()).toBeTrue(); expect(component.valid()).toBeFalse();
    component.amount.set(0);
    expect(component.valid()).toBeFalse();
  });

  it('server errors are shown by code (box has no money, no open shift, advance not confirmed)', async () => {
    const { http, component } = await open();
    component.amount.set(100);
    component.save();
    http.expectOne(`${base}suppliers/s1/payments`).flush({ code: 'INSUFFICIENT_BALANCE' }, { status: 409, statusText: 'Conflict' });
    expect(component.error()).toBe('supplierPay.errors.INSUFFICIENT_BALANCE');
    component.save();
    http.expectOne(`${base}suppliers/s1/payments`).flush({ code: 'NO_OPEN_SHIFT' }, { status: 409, statusText: 'Conflict' });
    expect(component.error()).toBe('supplierPay.errors.NO_OPEN_SHIFT');
    expect(component.busy()).toBeFalse();
  });
});

describe('SuppliersPageComponent with the statement panel (Stage 20)', () => {
  it('shows the last purchase, opens the selected supplier\'s statement and reloads the list and the statement after a payment', async () => {
    await TestBed.configureTestingModule({
      imports: [SuppliersPageComponent, TranslateModule.forRoot()], providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([]), provideNoopAnimations()],
    }).compileComponents();
    signInAs('owner');
    TestBed.inject(LanguageService).selectedLanguage.set('en');
    const http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(SuppliersPageComponent);
    fixture.detectChanges();
    http.expectOne((r) => r.url === `${base}suppliers`).flush([supplier(), supplier({ _id: 's2', name: 'الدلتا', balance: 0, lastPurchaseAt: null })]);
    await settle(fixture);
    const first = fixture.nativeElement.querySelector('[data-supplier="الشركة المصرية للإضاءة"]');
    expect(first.querySelector('[data-test="last-purchase"]').textContent).toContain('2026-11-03');
    expect(fixture.nativeElement.querySelector('[data-supplier="الدلتا"] [data-test="last-purchase"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('[data-test="supplier-panel"]')).toBeNull();
    (first.querySelector('[data-action="statement"]') as HTMLButtonElement).click();
    await settle(fixture);
    http.expectOne((r) => r.url === `${base}suppliers/s1/statement`).flush(STATEMENT);
    flushPaymentBoxes(http);
    await settle(fixture);
    expect(fixture.nativeElement.querySelector('[data-test="supplier-panel"]')).toBeTruthy();
    fixture.componentInstance.paid();
    http.expectOne((r) => r.url === `${base}suppliers`).flush([supplier({ balance: 4150 })]);
    await settle(fixture);
    http.expectOne((r) => r.url === `${base}suppliers/s1/statement`).flush({ ...STATEMENT, balance: 4150 });
    answerPayments(http);
    http.verify();
  });

  it('deleting a supplier with documents shows its own message', async () => {
    await TestBed.configureTestingModule({
      imports: [SuppliersPageComponent, TranslateModule.forRoot()], providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([]), provideNoopAnimations()],
    }).compileComponents();
    signInAs('owner');
    const http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(SuppliersPageComponent);
    fixture.detectChanges();
    http.expectOne((r) => r.url === `${base}suppliers`).flush([supplier()]);
    fixture.componentInstance.remove(supplier());
    http.expectOne(`${base}suppliers/s1`).flush({ code: 'SUPPLIER_HAS_DOCUMENTS' }, { status: 409, statusText: 'Conflict' });
    expect(fixture.componentInstance.deleteError()).toBe('suppliers.deleteHasDocuments');
  });
});

describe('Supplier payment dialog: box balances (Stage 20 review)', () => {
  const boxes = (withBalance: boolean) => ({
    defaultBoxId: 'b-main', deviceId: null, mainBox: { _id: 'b-main', name: 'الخزنة الرئيسية' },
    data: [
      { _id: 'b-main', name: 'الخزنة الرئيسية', type: 'cash', isMain: true, shiftsEnabled: false, isDefault: true, openShift: null, needsShift: false, ...(withBalance ? { balance: 18400 } : {}) },
      { _id: 'b-bank', name: 'بنك مصر', type: 'bank', isMain: false, shiftsEnabled: false, isDefault: false, openShift: null, needsShift: false, ...(withBalance ? { balance: 41000 } : {}) },
    ],
  });
  const open = async (withBalance: boolean) => {
    await TestBed.configureTestingModule({
      imports: [SupplierPaymentDialogComponent, TranslateModule.forRoot()], providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([]), provideNoopAnimations()],
    }).compileComponents();
    signInAs('owner');
    TestBed.inject(LanguageService).selectedLanguage.set('en');
    const http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(SupplierPaymentDialogComponent);
    fixture.componentRef.setInput('supplier', supplier({ balance: 6650 }));
    fixture.detectChanges();
    fixture.componentInstance.visible.set(true);
    await settle(fixture);
    http.match((r) => r.url.endsWith('cashbox/payment-boxes')).forEach((r) => r.flush(boxes(withBalance)));
    await settle(fixture);
    return Array.from(document.body.querySelectorAll('[data-test="payment-box"] option')).map((option) => option.textContent?.replace(/\s+/g, ' ').trim() ?? '');
  };

  it('with cashbox.view each box shows its balance, like the design (بنك مصر · 41,000)', async () => {
    const options = await open(true);
    expect(options.length).toBe(2);
    expect(options[0]).toContain('18,400'); expect(options[1]).toContain('بنك مصر'); expect(options[1]).toContain('41,000');
  });

  it('without balances (no cashbox.view) the list shows names only', async () => {
    const options = await open(false);
    expect(options.length).toBe(2);
    expect(options.every((text) => !/\d/.test(text))).withContext(options.join('|')).toBeTrue();
  });
});

describe('Online Fixes 1: supplier payment vouchers and the refund button', () => {
  const open = async (permissions: string[] | 'owner' = 'owner') => {
    await TestBed.configureTestingModule({
      imports: [SupplierStatementComponent, TranslateModule.forRoot()], providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([]), provideNoopAnimations()],
    }).compileComponents();
    if (permissions === 'owner') signInAs('owner'); else signInWith(permissions);
    TestBed.inject(LanguageService).selectedLanguage.set('en');
    const http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(SupplierStatementComponent);
    fixture.componentRef.setInput('supplier', supplier());
    fixture.detectChanges();
    http.expectOne(`${base}suppliers/s1/payments`).flush({ data: [
      { _id: 'pv1', number: 'PV-000017', date: '2026-11-03T00:00:00.000Z', amount: 3000, boxName: 'الرئيسية', status: 'posted' },
      { _id: 'pv2', number: 'PV-000018', date: '2026-11-04T00:00:00.000Z', amount: 500, status: 'cancelled', cancelReason: 'غلط' },
    ] });
    http.expectOne(`${base}suppliers/s1/statement`).flush(STATEMENT);
    await settle(fixture);
    return { fixture, http, component: fixture.componentInstance };
  };

  it('lists the vouchers; only a posted one has a cancel button (suppliers.pay)', async () => {
    const { fixture } = await open();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelectorAll('[data-test="payment-row"]').length).toBe(2);
    expect(el.querySelectorAll('[data-action="cancel-payment"]').length).toBe(1);
  });

  it('without suppliers.pay there is no cancel and no refund button', async () => {
    const { fixture } = await open(['suppliers.view']);
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-action="cancel-payment"]')).toBeNull();
    expect(el.querySelector('[data-action="refund"]')).toBeNull();
  });

  it('cancelling posts the reason, announces the change and reloads', async () => {
    const { fixture, http, component } = await open();
    let changed = 0;
    component.changed.subscribe(() => changed++);
    component.startCancel({ _id: 'pv1', number: 'PV-000017', date: '2026-11-03', amount: 3000, status: 'posted' });
    component.confirmCancel('دفعة غلط');
    const request = http.expectOne(`${base}supplier-payments/pv1/cancel`);
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({ reason: 'دفعة غلط' });
    request.flush({ _id: 'pv1', status: 'cancelled' });
    http.expectOne(`${base}suppliers/s1/payments`).flush({ data: [] });
    http.expectOne(`${base}suppliers/s1/statement`).flush(STATEMENT);
    await settle(fixture);
    expect(changed).toBe(1);
    expect(component.cancelTarget()).toBeNull();
  });

  it('a refusal keeps the dialog open and shows the reason', async () => {
    const { fixture, http, component } = await open();
    component.startCancel({ _id: 'pv1', number: 'PV-000017', date: '2026-11-03', amount: 3000, status: 'posted' });
    component.confirmCancel('سبب');
    http.expectOne(`${base}supplier-payments/pv1/cancel`).flush({ code: 'BOX_INACTIVE', message: 'الخزنة موقوفة' }, { status: 409, statusText: 'Conflict' });
    await settle(fixture);
    expect(component.cancelTarget()).not.toBeNull();
    expect(component.cancelBusy()).toBeFalse();
    expect(component.cancelError()).not.toBe('');
  });

  it('the refund button asks the page to open the refund dialog', async () => {
    const { fixture, component } = await open();
    const asked: string[] = [];
    component.refund.subscribe((row) => asked.push(row._id));
    (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>('[data-action="refund"]')!.click();
    expect(asked).toEqual(['s1']);
  });
});

describe('Online Fixes 1: stop / restart a supplier from the list', () => {
  const open = async (permissions: string[] | 'owner' = 'owner', rows: Supplier[] = [supplier(), supplier({ _id: 's2', name: 'الدلتا', isActive: false, balance: 0, lastPurchaseAt: null })]) => {
    await TestBed.configureTestingModule({
      imports: [SuppliersPageComponent, TranslateModule.forRoot()], providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([]), provideNoopAnimations()],
    }).compileComponents();
    if (permissions === 'owner') signInAs('owner'); else signInWith(permissions);
    TestBed.inject(LanguageService).selectedLanguage.set('en');
    const http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(SuppliersPageComponent);
    fixture.detectChanges();
    http.expectOne((r) => r.url === `${base}suppliers`).flush(rows);
    await settle(fixture);
    return { fixture, http, component: fixture.componentInstance };
  };
  const toggle = (fixture: ComponentFixture<unknown>, name: string) => (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>(`[data-supplier="${name}"] [data-action="toggle-active"]`);

  it('every row has the button (suppliers.manage); a stopped supplier shows the stopped pill', async () => {
    const { fixture } = await open();
    expect(toggle(fixture, 'الشركة المصرية للإضاءة')).not.toBeNull();
    expect(toggle(fixture, 'الدلتا')).not.toBeNull();
    expect((fixture.nativeElement as HTMLElement).querySelector('[data-supplier="الدلتا"]')!.textContent).toContain('suppliers.inactive');
  });

  it('without suppliers.manage there is no button', async () => {
    const { fixture } = await open(['suppliers.view']);
    expect(toggle(fixture, 'الشركة المصرية للإضاءة')).toBeNull();
  });

  it('stopping asks first (no reason needed), PUTs isActive false, then reloads the list', async () => {
    const { fixture, http, component } = await open();
    toggle(fixture, 'الشركة المصرية للإضاءة')!.click();
    await settle(fixture);
    expect(component.activeRow()?._id).toBe('s1');
    http.expectNone((r) => r.method === 'PUT');
    const confirm = document.body.querySelector<HTMLButtonElement>('[data-action="confirm-correction"]')!;
    expect(confirm.disabled).toBeFalse(); // requireReason is off
    component.confirmToggleActive();
    const request = http.expectOne((r) => r.url === `${base}suppliers/s1` && r.method === 'PUT');
    expect(request.request.body).toEqual({ isActive: false });
    request.flush(supplier({ isActive: false }));
    http.expectOne((r) => r.url === `${base}suppliers`).flush([supplier({ isActive: false })]);
    await settle(fixture);
    expect(component.activeRow()).toBeNull();
  });

  it('restarting a stopped supplier PUTs isActive true; a refusal keeps the dialog open with a message', async () => {
    const { fixture, http, component } = await open();
    toggle(fixture, 'الدلتا')!.click();
    await settle(fixture);
    component.confirmToggleActive();
    const request = http.expectOne((r) => r.url === `${base}suppliers/s2` && r.method === 'PUT');
    expect(request.request.body).toEqual({ isActive: true });
    request.flush({ code: 'FORBIDDEN', message: 'مش عندك صلاحية' }, { status: 403, statusText: 'Forbidden' });
    await settle(fixture);
    expect(component.activeRow()).not.toBeNull();
    expect(component.activeBusy()).toBeFalse();
    expect(component.activeError()).not.toBe('');
  });
});

describe('Online Fixes 1: the supplier refund dialog', () => {
  const open = async (balance = -500) => {
    await TestBed.configureTestingModule({
      imports: [SupplierRefundDialogComponent, TranslateModule.forRoot()], providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([]), provideNoopAnimations()],
    }).compileComponents();
    signInAs('owner');
    TestBed.inject(LanguageService).selectedLanguage.set('en');
    const http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(SupplierRefundDialogComponent);
    fixture.componentRef.setInput('supplier', supplier({ balance }));
    fixture.detectChanges();
    fixture.componentInstance.visible.set(true);
    await settle(fixture);
    flushPaymentBoxes(http);
    await settle(fixture);
    return { fixture, http, component: fixture.componentInstance };
  };

  it('the cap is what the supplier owes us (a negative balance); more than that, zero or a locked date blocks Save', async () => {
    const { component } = await open(-500);
    expect(component.owedToUs()).toBe(500);
    component.amount.set(501);
    expect(component.valid()).toBeFalse();
    component.amount.set(0);
    expect(component.valid()).toBeFalse();
    component.amount.set(500);
    expect(component.valid()).toBeTrue();
  });

  it('a supplier we owe (positive balance) can not be refunded at all', async () => {
    const { component } = await open(6650);
    expect(component.owedToUs()).toBe(0);
    component.amount.set(1);
    expect(component.valid()).toBeFalse();
  });

  it('saving POSTs amount, date and note to suppliers/:id/refunds and announces the voucher', async () => {
    const { fixture, http, component } = await open(-500);
    const done: Array<{ number: string; amount: number }> = [];
    component.done.subscribe((value) => done.push(value));
    component.amount.set(300);
    component.note.set('رجّع نقدية');
    component.save();
    const request = http.expectOne(`${base}suppliers/s1/refunds`);
    expect(request.request.method).toBe('POST');
    expect(request.request.body.amount).toBe(300);
    expect(request.request.body.note).toBe('رجّع نقدية');
    expect(request.request.body.date).toBeTruthy();
    request.flush({ _id: 'sr1', number: 'SR-000001', amount: 300 });
    await settle(fixture);
    expect(done).toEqual([{ number: 'SR-000001', amount: 300 }]);
    expect(component.visible()).toBeFalse();
  });

  it('REFUND_EXCEEDS_DUE from the server stays on the form with its message', async () => {
    const { fixture, http, component } = await open(-500);
    component.amount.set(300);
    component.save();
    http.expectOne(`${base}suppliers/s1/refunds`).flush({ code: 'REFUND_EXCEEDS_DUE', message: 'أكبر من المستحق' }, { status: 409, statusText: 'Conflict' });
    await settle(fixture);
    expect(component.visible()).toBeTrue();
    expect(component.busy()).toBeFalse();
    expect(component.error()).not.toBe('');
  });
});
