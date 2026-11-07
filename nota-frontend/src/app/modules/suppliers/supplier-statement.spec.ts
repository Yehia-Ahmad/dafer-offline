import { ComponentFixture, TestBed } from '@angular/core/testing';
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
import { SupplierStatementComponent, statementDocument } from './supplier-statement.component';
import { SUPPLIER_PRINT_ENABLED } from './supplier-print';
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
    http.verify();
  });

  it('an advance shows as "لينا" with the advance line in the aging', async () => {
    const { fixture, http } = await open('owner', supplier({ balance: -800 }));
    http.expectOne((r) => r.url === `${base}suppliers/s1/statement`).flush({ ...STATEMENT, balance: -800, aging: { ...STATEMENT.aging, total: 0, current: 0, d90plus: 0, advance: 800 } });
    await settle(fixture);
    expect(fixture.nativeElement.querySelector('[data-test="panel-balance"]').classList).toContain('ss__advance');
    expect(fixture.nativeElement.textContent).toContain('suppliers.statement.advance');
    expect(fixture.nativeElement.querySelector('[data-bucket="advance"]').textContent).toContain('800');
    http.verify();
  });

  it('pay, new-purchase and print buttons: permissions decide, and print stays hidden behind its flag', async () => {
    const owner = await open();
    owner.http.expectOne((r) => r.url === `${base}suppliers/s1/statement`).flush(STATEMENT);
    await settle(owner.fixture);
    const el = owner.fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-action="pay"]')).toBeTruthy();
    expect(el.querySelector('[data-action="new-purchase"]')!.getAttribute('href')).toBe('/purchases/new?supplier=s1');
    expect(SUPPLIER_PRINT_ENABLED).toBeFalse();
    expect(el.querySelector('[data-action="print-statement"]')).toBeNull();
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

  it("the design's payment: 6,650 now, 2,500 from the bank, 4,150 after; saves the exact body", async () => {
    const { fixture, http, component } = await open();
    component.amount.set(2500); component.date.set('2026-11-04'); component.reference.set(' CHQ-77 '); component.note.set('دفعة');
    await settle(fixture);
    expect(component.after()).toBe(4150);
    expect(document.body.querySelector('[data-test="balance-now"]')!.textContent).toContain('6,650');
    expect(document.body.querySelector('[data-test="balance-after"]')!.textContent).toContain('4,150');
    expect(component.valid()).toBeTrue();
    expect(component.isAdvance()).toBeFalse();
    const done: { number: string; balanceAfter: number }[] = [];
    component.done.subscribe((row) => done.push(row));
    component.save();
    const req = http.expectOne(`${base}suppliers/s1/payments`);
    expect(req.request.body).toEqual({ amount: 2500, date: '2026-11-04', reference: 'CHQ-77', note: 'دفعة' });
    req.flush({ _id: 'pv2', number: 'PV-000002', balanceAfter: 4150 });
    expect(done).toEqual([{ number: 'PV-000002', balanceAfter: 4150 }]);
    expect(component.visible()).toBeFalse();
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
