import { Type } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { TranslateModule } from '@ngx-translate/core';
import { of } from 'rxjs';
import { environment } from '../environments/environment';
import { signInAs, signInWith } from './core/auth/testing/sign-in';
import { LANDING_ORDER, ROUTE_RULES, ruleAllows } from './core/auth/route-permissions';
import { CustomerDetailsComponent } from './modules/customer/components/customer-details/customer-details.component';
import { PaymentBoxesResponse } from './modules/cashbox/cashbox.models';
import { PaymentBoxService } from './modules/cashbox/payment-box.service';
import { MAIN_ONLY_BOXES } from './modules/cashbox/testing/payment-boxes.testing';
import { CatalogStateService } from './modules/layout/nav/catalog-state.service';
import { HomeComponent } from './modules/layout/components/home/home.component';
import { NAV_GROUPS, visibleNavGroups } from './modules/layout/nav/nav-menu.config';
import { SellingComponent } from './modules/products/components/selling/selling.component';
import { LanguageService } from './modules/shared/services/translation.service';

const base = environment.api_base_url;
const settle = async (fixture: ComponentFixture<unknown>) => { fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges(); };
const el = (fixture: ComponentFixture<unknown>) => fixture.nativeElement as HTMLElement;

const TWO_BOXES: PaymentBoxesResponse = {
  defaultBoxId: 'b-main', deviceId: null, mainBox: { _id: 'b-main', name: 'الخزنة الرئيسية' },
  data: [
    { _id: 'b-main', name: 'الخزنة الرئيسية', type: 'cash', isMain: true, shiftsEnabled: false, isDefault: true, openShift: null, needsShift: false },
    { _id: 'b-w1', name: 'فودافون كاش', type: 'wallet', isMain: false, shiftsEnabled: false, isDefault: false, openShift: null, needsShift: false },
  ],
};

describe('Stage 19 — sidebar and routes', () => {
  const labels = (permissions: string[]) => visibleNavGroups(NAV_GROUPS, { has: (key) => permissions.includes(key) })
    .flatMap((group) => group.items.map((item) => item.key));

  it('الخزائن والوردية and المصروفات are real links with their own permissions', () => {
    const cash = NAV_GROUPS.flatMap((group) => group.items).find((item) => item.key === 'cash')!;
    const expenses = NAV_GROUPS.flatMap((group) => group.items).find((item) => item.key === 'expenses')!;
    expect([cash.route, expenses.route]).toEqual(['/cashbox', '/expenses']);
    expect(labels(['cashbox.view'])).toEqual(jasmine.arrayContaining(['cash', 'expenses']));
    expect(labels(['expenses.create'])).toContain('expenses');
    expect(labels(['expenses.create'])).not.toContain('cash');
    expect(labels(['shift.operate'])).not.toContain('cash');
    expect(labels(['sales.create'])).not.toContain('expenses');
  });

  it('route rules: boxes need cashbox.view; expenses need create, manage or view; the landing order includes both', () => {
    const has = (...keys: string[]) => (key: string) => keys.includes(key);
    expect(ruleAllows(ROUTE_RULES.cashbox, has('cashbox.view'))).toBeTrue();
    expect(ruleAllows(ROUTE_RULES.cashbox, has('cashbox.manage'))).toBeFalse();
    expect(ruleAllows(ROUTE_RULES.expenses, has('expenses.manage'))).toBeTrue();
    expect(ruleAllows(ROUTE_RULES.expenses, has('sales.create'))).toBeFalse();
    expect(LANDING_ORDER.map((entry) => entry.path)).toEqual(jasmine.arrayContaining(['/cashbox', '/expenses']));
  });
});

describe('Stage 19 — dashboard', () => {
  const summary = {
    date: '2026-11-06', timeZone: 'Africa/Cairo',
    today: { cash: { total: 100, count: 1 }, credit: { total: 0, count: 0 } }, yesterday: { cash: { total: 0, count: 0 }, credit: { total: 0, count: 0 } },
    credit: { outstanding: 0, customersWithBalance: 0, overdueAmount: 0, overdueCount: 0 }, last7Days: [], recentInvoices: [{ id: 'i1', type: 'cash', reference: 'INV-000001', customerName: 'x', customerId: null, total: 100, sellingDate: '2026-11-06', createdAt: '2026-11-06T08:00:00Z' }], lowStock: [],
  };
  const open = async (signIn: () => void) => {
    await TestBed.configureTestingModule({
      imports: [HomeComponent, TranslateModule.forRoot()],
      providers: [provideRouter([]), provideNoopAnimations(), provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
    TestBed.inject(LanguageService).selectedLanguage.set('en');
    signIn();
    const http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(HomeComponent);
    fixture.detectChanges();
    return { fixture, http };
  };

  it('shows "كاش في الخزنة" (Σ of the cash boxes) with a link, and the "تسجيل مصروف" action', async () => {
    const { fixture, http } = await open(() => signInAs('owner'));
    http.expectOne(`${base}dashboard/summary`).flush(summary);
    http.expectOne(`${base}cashbox/boxes`).flush({ data: [], cashTotal: 25950 });
    http.match((request) => request.url.endsWith('accounting/opening')).forEach((request) => request.flush({ setupMode: false }));
    await settle(fixture);
    expect(el(fixture).querySelector('[data-kpi="cash"] [data-test="cash-total"]')!.textContent).toContain('25,950');
    expect(el(fixture).querySelector('[data-kpi="cash"] a[href="/cashbox"]')).not.toBeNull();
    expect(el(fixture).querySelector('[data-action="new-expense"]')!.getAttribute('href')).toBe('/expenses');
  });

  it('a user without cashbox.view sees no cash KPI and makes no boxes request; without expenses.create no quick action', async () => {
    const { fixture, http } = await open(() => signInWith(['dashboard.view', 'sales.create']));
    http.expectOne(`${base}dashboard/summary`).flush(summary);
    http.expectNone(`${base}cashbox/boxes`);
    await settle(fixture);
    expect(el(fixture).querySelector('[data-kpi="cash"]')).toBeNull();
    expect(el(fixture).querySelector('[data-action="new-expense"]')).toBeNull();
    expect(el(fixture).querySelector('[data-action="new-cash"]')).not.toBeNull();
  });

  it('a cashier gets the expense action but not the cash KPI', async () => {
    const { fixture, http } = await open(() => signInAs('cashier'));
    http.expectOne(`${base}dashboard/summary`).flush(summary);
    await settle(fixture);
    expect(el(fixture).querySelector('[data-action="new-expense"]')).not.toBeNull();
    expect(el(fixture).querySelector('[data-kpi="cash"]')).toBeNull();
  });
});

describe('Stage 19 — customer credit buttons', () => {
  let http: HttpTestingController;
  let component: CustomerDetailsComponent;
  const statement = (credit: object | undefined, balance = -300) => ({
    lines: [{ date: '2026-11-05T08:00:00.000Z', type: 'opening_balance', number: 'OB-000002', description: 'رصيد أول المدة', debit: 0, credit: 500, balance: -500 },
      { date: '2026-11-06T08:00:00.000Z', type: 'payout', number: 'CP-000001', description: 'صرف رصيد دائن', debit: 200, credit: 0, balance }],
    totals: { debit: 200, credit: 500, balance }, aging: { current: 0, days1to30: 0, days31to60: 0, over60: 0, total: 0, credit: 0 }, outstanding: 0, ...(credit ? { credit } : {}),
  });
  const CREDIT = { balance: -300, credit: 300, openItems: 100, unapplied: 400, applicable: 100 };

  const open = async (signIn: () => void, response: object, boxes: PaymentBoxesResponse = MAIN_ONLY_BOXES) => {
    sessionStorage.removeItem('nota.paymentBox');
    await TestBed.configureTestingModule({
      imports: [CustomerDetailsComponent, TranslateModule.forRoot()],
      providers: [provideRouter([]), provideNoopAnimations(), provideHttpClient(), provideHttpClientTesting(),
        { provide: ActivatedRoute, useValue: { paramMap: of(convertToParamMap({ id: 'cu1' })), snapshot: { paramMap: convertToParamMap({ id: 'cu1' }) } } }],
    }).compileComponents();
    TestBed.inject(LanguageService).selectedLanguage.set('en');
    signIn();
    http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(CustomerDetailsComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
    http.expectOne(`${base}shop-profile`).flush({});
    http.expectOne(`${base}customers/cu1`).flush({ _id: 'cu1', name: 'م. سامي', phone: '01001234567', createdAt: '2026-09-01T00:00:00.000Z', opening: { amount: -500, remaining: 0 }, creditSummary: { totalInvoices: 0, remainingAmount: 0 }, creditHistory: [] });
    http.expectOne(`${base}customers/cu1/statement`).flush(response);
    await settle(fixture);
    TestBed.inject(PaymentBoxService).load();
    http.match((request) => request.url.endsWith('cashbox/payment-boxes')).forEach((request) => request.flush(boxes));
    await settle(fixture);
    return fixture;
  };
  afterEach(() => { http.match((request) => request.url.endsWith('cashbox/payment-boxes')).forEach((request) => request.flush(MAIN_ONLY_BOXES)); http.verify(); sessionStorage.removeItem('nota.paymentBox'); });

  it('a credit balance shows the banner, "صرف الرصيد" and "خصمه من فواتير مفتوحة" (open items only)', async () => {
    const fixture = await open(() => signInAs('owner'), statement(CREDIT));
    expect(el(fixture).querySelector('[data-testid="credit-banner"]')!.textContent).toContain('cashbox.credit.balance');
    expect(el(fixture).querySelector('[data-action="credit-payout"]')).not.toBeNull();
    expect(el(fixture).querySelector('[data-action="credit-apply"]')).not.toBeNull();
    expect(component.credit).toEqual(CREDIT);
    expect(el(fixture).textContent).toContain('cashbox.credit.payout');
    TestBed.resetTestingModule();
    const noItems = await open(() => signInAs('owner'), statement({ ...CREDIT, openItems: 0, applicable: 0 }));
    expect(el(noItems).querySelector('[data-action="credit-payout"]')).not.toBeNull();
    expect(el(noItems).querySelector('[data-action="credit-apply"]')).toBeNull();
  });

  it('no credit, or no credit.collect: no buttons', async () => {
    const none = await open(() => signInAs('owner'), statement({ ...CREDIT, credit: 0, applicable: 0 }, 0));
    expect(el(none).querySelector('[data-testid="credit-banner"]')).toBeNull();
    expect(el(none).querySelector('[data-action="credit-payout"]')).toBeNull();
    TestBed.resetTestingModule();
    const viewer = await open(() => signInWith(['customers.view']), statement(CREDIT));
    expect(el(viewer).querySelector('[data-testid="credit-banner"]')).not.toBeNull();
    expect(el(viewer).querySelector('[data-action="credit-payout"]')).toBeNull();
    expect(el(viewer).querySelector('[data-action="credit-apply"]')).toBeNull();
  });

  it('payout: refuses more than the credit; posts amount and note (and the box when chosen); reloads the customer', async () => {
    await open(() => signInAs('owner'), statement(CREDIT), TWO_BOXES);
    component.openPayout();
    expect(component.payout.amount).toBe(300);
    component.payout.amount = 300.01;
    component.savePayout();
    http.expectNone(`${base}customers/cu1/payouts`);
    expect(component.payout.error).toBe('cashbox.credit.exceeds');
    component.payout.amount = 200; component.payout.note = ' صرف نقدي ';
    component.savePayout();
    const request = http.expectOne(`${base}customers/cu1/payouts`);
    expect(request.request.body).toEqual({ amount: 200, note: 'صرف نقدي' });
    request.flush({ payout: { _id: 'p1', number: 'CP-000001' }, credit: CREDIT });
    http.match((r) => r.url.endsWith('cashbox/payment-boxes')).forEach((r) => r.flush(TWO_BOXES));
    http.expectOne(`${base}customers/cu1`).flush({ _id: 'cu1', name: 'م. سامي', phone: '0100', opening: null, creditSummary: { totalInvoices: 0, remainingAmount: 0 }, creditHistory: [] });
    http.expectOne(`${base}customers/cu1/statement`).flush(statement({ ...CREDIT, credit: 100 }));
    expect(component.payout.open).toBeFalse();
    TestBed.inject(PaymentBoxService).select('b-w1');
    component.openPayout(); component.payout.amount = 50;
    component.savePayout();
    expect(http.expectOne(`${base}customers/cu1/payouts`).request.body).toEqual({ amount: 50, boxId: 'b-w1' });
  });

  it('a payout refused by the server shows the reason', async () => {
    await open(() => signInAs('owner'), statement(CREDIT));
    component.openPayout(); component.payout.amount = 100;
    component.savePayout();
    http.expectOne(`${base}customers/cu1/payouts`).flush({ code: 'INSUFFICIENT_BALANCE' }, { status: 409, statusText: 'Conflict' });
    expect(component.payout.error).toBe('cashbox.errors.INSUFFICIENT_BALANCE');
    expect(component.payout.open).toBeTrue();
  });

  it('apply-credit: capped at what open invoices can take; posts only the amount', async () => {
    await open(() => signInAs('owner'), statement(CREDIT));
    component.openApplyCredit();
    expect(component.applyCredit.amount).toBe(100);
    component.applyCredit.amount = 150;
    component.saveApplyCredit();
    http.expectNone(`${base}customers/cu1/apply-credit`);
    component.applyCredit.amount = 100;
    component.saveApplyCredit();
    const request = http.expectOne(`${base}customers/cu1/apply-credit`);
    expect(request.request.body).toEqual({ amount: 100 });
    request.flush({ applied: 100, credit: CREDIT });
    http.expectOne(`${base}customers/cu1`).flush({ _id: 'cu1', name: 'م. سامي', phone: '0100', opening: null, creditSummary: { totalInvoices: 0, remainingAmount: 0 }, creditHistory: [] });
    http.expectOne(`${base}customers/cu1/statement`).flush(statement({ ...CREDIT, applicable: 0, openItems: 0 }));
    expect(component.applyCredit.open).toBeFalse();
  });

  it('the statement shows the payout line like any other debit line', async () => {
    const fixture = await open(() => signInAs('owner'), statement(CREDIT));
    expect(component.statement.rows.map((row) => [row.kind, row.description, row.debit])).toEqual([['opening_balance', 'رصيد أول المدة', 0], ['payout', 'صرف رصيد دائن', 200]]);
    expect(el(fixture).textContent).toContain('صرف رصيد دائن');
  });

  describe('Fixes 1: the payment receipts list and "إلغاء الدفعة" (credit.payment.cancel)', () => {
    const RECEIPTS = [
      { _id: 'r1', number: 'RC-000001', kind: 'payment', amount: 100, paymentDate: '2026-11-06T08:00:00.000Z', note: '', status: 'posted', cancelReason: null, cancelledAt: null, boxName: 'الرئيسية', allocations: [{ amount: 100, invoiceNumber: 'CR-000001', opening: false }] },
      { _id: 'r2', number: 'RC-000002', kind: 'payment', amount: 50, paymentDate: '2026-11-05T08:00:00.000Z', note: '', status: 'cancelled', cancelReason: 'غلط', cancelledAt: '2026-11-06T09:00:00.000Z', boxName: 'الرئيسية', allocations: [] },
      { _id: 'r3', number: 'RC-000003', kind: 'down_payment', amount: 20, paymentDate: '2026-11-04T08:00:00.000Z', note: '', status: 'posted', cancelReason: null, cancelledAt: null, boxName: 'الرئيسية', allocations: [] },
    ];
    const openPayments = async (signIn: () => void = () => signInAs('owner')) => {
      const fixture = await open(signIn, statement(CREDIT));
      http.expectNone(`${base}customers/cu1/receipts`); // read when the payments tab opens
      component.setTab('payments');
      http.expectOne(`${base}customers/cu1/credit`).flush({ ...CREDIT, payouts: [] });
      http.expectOne(`${base}customers/cu1/receipts`).flush({ data: RECEIPTS });
      await settle(fixture);
      return fixture;
    };
    const dialogButton = () => document.body.querySelector<HTMLButtonElement>('[data-action="confirm-correction"]')!;

    it('lists every payment with its status; only a posted payment (not a down payment) has «إلغاء الدفعة», for the owner', async () => {
      const fixture = await openPayments();
      const rows = Array.from(el(fixture).querySelectorAll('[data-test="receipt-row"]'));
      expect(rows.length).toBe(3);
      expect(rows[0].querySelector('[data-action="cancel-receipt"]')).not.toBeNull();
      expect(rows[1].querySelector('[data-action="cancel-receipt"]')).toBeNull();
      expect(rows[1].textContent).toContain('customerDetailsPage.receipts.cancelled');
      expect(rows[2].querySelector('[data-action="cancel-receipt"]')).toBeNull();
    });

    it('the «الدفعات (n)» tab counts live payments only: the rows of a cancelled receipt stay in the list but are not counted', async () => {
      const fixture = await openPayments();
      const history = (payments: object[]) => [{ invoiceId: 'i1', number: 'CR-000001', payments, refunds: [], remainingAmount: 0 }];
      const live = { id: 'p1', number: 'RC-000001', amount: 100, paymentDate: '2026-11-06T08:00:00.000Z', note: '' };
      const gone = { id: 'p2', number: 'RC-000002', amount: 50, paymentDate: '2026-11-05T08:00:00.000Z', note: '', cancelledAt: '2026-11-06T09:00:00.000Z' };
      component.customer = { ...(component.customer as object), creditHistory: history([live, gone]) } as never;
      (component as unknown as { rebuildDerivedViews(): void }).rebuildDerivedViews();
      fixture.detectChanges();
      expect(component.allPayments.length).toBe(2); // both rows are listed (history)
      expect(component.livePaymentsCount).toBe(1);
      const tab = Array.from(el(fixture).querySelectorAll('[role="tab"]')).find((node) => node.textContent?.includes('customerDetailsPage.s10.tabs.payments'))!;
      expect(tab.textContent).toContain('(1)');
      component.customer = { ...(component.customer as object), creditHistory: history([{ ...live, cancelledAt: '2026-11-06T09:00:00.000Z' }, gone]) } as never;
      (component as unknown as { rebuildDerivedViews(): void }).rebuildDerivedViews();
      fixture.detectChanges();
      expect(component.livePaymentsCount).toBe(0);
    });

    it('a cashier or an accountant (who may collect) does not see the button: it needs credit.payment.cancel', async () => {
      const fixture = await openPayments(() => signInWith(['customers.view', 'credit.collect']));
      expect(el(fixture).querySelectorAll('[data-test="receipt-row"]').length).toBe(3);
      expect(el(fixture).querySelector('[data-action="cancel-receipt"]')).toBeNull();
    });

    it('cancelling asks for a reason, posts it, then reloads the statement, the receipts and the customer', async () => {
      const fixture = await openPayments();
      (el(fixture).querySelector('[data-action="cancel-receipt"]') as HTMLElement).click();
      await settle(fixture);
      expect(component.receiptCancel.target?._id).toBe('r1');
      expect(dialogButton().disabled).toBeTrue();
      component.confirmReceiptCancel('المبلغ اتكتب غلط');
      const request = http.expectOne(`${base}customers/cu1/receipts/r1/cancel`);
      expect(request.request.method).toBe('POST');
      expect(request.request.body).toEqual({ reason: 'المبلغ اتكتب غلط' });
      request.flush({ receipt: { _id: 'r1', status: 'cancelled' } });
      http.match((r) => r.url.endsWith('cashbox/payment-boxes')).forEach((r) => r.flush(MAIN_ONLY_BOXES));
      http.match((r) => r.url === `${base}customers/cu1`).forEach((r) => r.flush({ _id: 'cu1', name: 'م. سامي', phone: '01001234567', createdAt: '2026-09-01T00:00:00.000Z', opening: { amount: -500, remaining: 0 }, creditHistory: [] }));
      http.match((r) => r.url === `${base}customers/cu1/statement`).forEach((r) => r.flush(statement(CREDIT))); // the page and the customer reload both ask for it
      http.expectOne(`${base}customers/cu1/receipts`).flush({ data: [{ ...RECEIPTS[0], status: 'cancelled', cancelReason: 'المبلغ اتكتب غلط' }, RECEIPTS[1], RECEIPTS[2]] });
      await settle(fixture);
      expect(component.receiptCancel.target).toBeNull();
      expect(el(fixture).querySelector('[data-action="cancel-receipt"]')).toBeNull();
    });

    it('a refusal shows the reason and keeps the dialog (the paid money was handed back by a return)', async () => {
      const fixture = await openPayments();
      component.startReceiptCancel(RECEIPTS[0] as never);
      component.confirmReceiptCancel('سبب');
      http.expectOne(`${base}customers/cu1/receipts/r1/cancel`).flush({ code: 'PAYMENT_USED_BY_RETURN', message: 'مرتجع رجّع جزء من المدفوع' }, { status: 409, statusText: 'Conflict' });
      await settle(fixture);
      expect(component.receiptCancel.target).not.toBeNull();
      expect(component.receiptCancel.busy).toBeFalse();
      expect(component.receiptCancel.error).toBe('مرتجع رجّع جزء من المدفوع'); // no translations in this spec: the server message
    });
  });

  describe('Online Fixes 1: the payouts list and "إلغاء الصرف"', () => {
    const PAYOUTS = [
      { _id: 'po1', number: 'CP-000001', date: '2026-11-06T08:00:00.000Z', amount: 200, status: 'posted' },
      { _id: 'po2', number: 'CP-000002', date: '2026-11-05T08:00:00.000Z', amount: 50, status: 'cancelled', cancelReason: 'غلط' },
    ];
    const openPayments = async (signIn: () => void = () => signInAs('owner')) => {
      const fixture = await open(signIn, statement(CREDIT));
      // The payouts are read when the payments tab opens (not with every statement).
      http.expectNone(`${base}customers/cu1/credit`);
      component.setTab('payments');
      http.expectOne(`${base}customers/cu1/credit`).flush({ ...CREDIT, payouts: PAYOUTS });
      http.expectOne(`${base}customers/cu1/receipts`).flush({ data: [] });
      await settle(fixture);
      return fixture;
    };
    const dialogButton = () => document.body.querySelector<HTMLElement>('[data-action="confirm-correction"]')!;

    it('lists the payouts with their status; only a posted one has a cancel button (credit.collect)', async () => {
      const fixture = await openPayments();
      const rows = Array.from(el(fixture).querySelectorAll('[data-test="payout-row"]'));
      expect(rows.length).toBe(2);
      expect(rows[0].textContent).toContain('CP-000001');
      expect(rows[0].querySelector('[data-action="cancel-payout"]')).not.toBeNull();
      expect(rows[1].querySelector('[data-action="cancel-payout"]')).toBeNull();
      expect(rows[1].textContent).toContain('customerDetailsPage.payouts.cancelled');
    });

    it('without credit.collect there is no cancel button', async () => {
      const fixture = await openPayments(() => signInWith(['customers.view']));
      expect(el(fixture).querySelectorAll('[data-test="payout-row"]').length).toBe(2);
      expect(el(fixture).querySelector('[data-action="cancel-payout"]')).toBeNull();
    });

    it('cancelling asks for a reason (3 characters), posts it to the payout cancel route, then reloads the statement and the list', async () => {
      const fixture = await openPayments();
      (el(fixture).querySelector('[data-action="cancel-payout"]') as HTMLElement).click();
      await settle(fixture);
      expect(component.payoutCancel.target?._id).toBe('po1');
      expect(dialogButton().hasAttribute('disabled') || (dialogButton() as HTMLButtonElement).disabled).toBeTrue();
      component.confirmPayoutCancel('غلط في المبلغ');
      const request = http.expectOne(`${base}customers/cu1/payouts/po1/cancel`);
      expect(request.request.method).toBe('POST');
      expect(request.request.body).toEqual({ reason: 'غلط في المبلغ' });
      request.flush({ payout: { _id: 'po1', status: 'cancelled' }, credit: CREDIT });
      http.match((r) => r.url.endsWith('cashbox/payment-boxes')).forEach((r) => r.flush(MAIN_ONLY_BOXES));
      http.expectOne(`${base}customers/cu1/statement`).flush(statement(CREDIT));
      http.expectOne(`${base}customers/cu1/credit`).flush({ ...CREDIT, payouts: [{ ...PAYOUTS[0], status: 'cancelled', cancelReason: 'غلط في المبلغ' }, PAYOUTS[1]] });
      await settle(fixture);
      expect(component.payoutCancel.target).toBeNull();
      expect(el(fixture).querySelector('[data-action="cancel-payout"]')).toBeNull();
    });

    it('a refusal (the box is stopped) shows the server reason and keeps the dialog open', async () => {
      const fixture = await openPayments();
      component.startPayoutCancel(PAYOUTS[0] as never);
      component.confirmPayoutCancel('سبب');
      http.expectOne(`${base}customers/cu1/payouts/po1/cancel`).flush({ code: 'BOX_INACTIVE', message: 'الخزنة دي مقفولة' }, { status: 409, statusText: 'Conflict' });
      await settle(fixture);
      expect(component.payoutCancel.target).not.toBeNull();
      expect(component.payoutCancel.busy).toBeFalse();
      expect(component.payoutCancel.error).toBe('الخزنة دي مقفولة'); // no translations in this spec: the server message is the fallback
    });
  });
});

describe('Stage 19 — the POS payment box', () => {
  let http: HttpTestingController;
  let component: SellingComponent;
  const open = async (role: 'cashier' | 'manager', boxes: PaymentBoxesResponse) => {
    sessionStorage.removeItem('nota.paymentBox');
    await TestBed.configureTestingModule({
      imports: [SellingComponent as Type<SellingComponent>, TranslateModule.forRoot()],
      providers: [provideRouter([]), provideNoopAnimations(), provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
    TestBed.inject(CatalogStateService).categories.set([]);
    TestBed.inject(LanguageService).selectedLanguage.set('en');
    signInAs(role);
    http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(SellingComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
    http.match((request) => request.url.endsWith('cashbox/payment-boxes')).forEach((request) => request.flush(boxes));
    http.match(() => true).forEach((request) => request.flush([]));
    await settle(fixture);
    return fixture;
  };
  afterEach(() => sessionStorage.removeItem('nota.paymentBox'));

  const fillOneItem = () => {
    component.sellingForm.get('customerName')!.setValue('عميل');
    component.sellingForm.get('customerPhone')!.setValue('01001234567');
    component.sellingForm.get('sellingDate')!.setValue(new Date(2026, 10, 6));
    component.getInvoiceItem(0).patchValue({ productId: 'p1', quantity: 2, price: 50, priceType: 'custom' });
  };

  it('a shop with one box: no selector, the sale body has no boxId (nothing changes for the cashier)', async () => {
    const fixture = await open('cashier', MAIN_ONLY_BOXES);
    expect(el(fixture).querySelector('[data-test="payment-box"]')).toBeNull();
    fillOneItem();
    component.saveSelling();
    const request = http.expectOne(`${base}sellings`);
    expect(request.request.body.boxId).toBeUndefined();
    expect('boxId' in request.request.body).toBeFalse();
  });

  it('with several boxes the selector defaults to the default box; choosing the wallet sends its id', async () => {
    const fixture = await open('manager', TWO_BOXES);
    const select = el(fixture).querySelector('[data-test="payment-box"]') as HTMLSelectElement;
    expect(select).not.toBeNull();
    expect(select.options.length).toBe(2);
    expect(TestBed.inject(PaymentBoxService).effective()!._id).toBe('b-main');
    TestBed.inject(PaymentBoxService).select('b-w1');
    fillOneItem();
    component.saveSelling();
    expect(http.expectOne(`${base}sellings`).request.body.boxId).toBe('b-w1');
  });

  it('a drawer that needs a shift: the banner shows, the pay button is disabled and nothing is sent', async () => {
    const drawerNeedsShift: PaymentBoxesResponse = { ...TWO_BOXES, defaultBoxId: 'b-d1', data: [
      { _id: 'b-d1', name: 'درج الكاشير ١', type: 'cash', isMain: false, shiftsEnabled: true, isDefault: true, openShift: null, needsShift: true }, TWO_BOXES.data[1]] };
    const fixture = await open('cashier', drawerNeedsShift);
    expect(el(fixture).querySelector('[data-test="no-shift-banner"]')).not.toBeNull();
    expect((el(fixture).querySelector('.pos__pay') as HTMLButtonElement).disabled).toBeTrue();
    expect(el(fixture).querySelector('[data-action="shift"]')).not.toBeNull();
  });
});
