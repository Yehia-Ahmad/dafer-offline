import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { environment } from '../../../environments/environment';
import { CashboxService } from './cashbox.service';
import { ExpensesService } from './expenses.service';
import { CreditSalesService } from '../products/services/credit-sales.service';
import { CustomersService } from '../customer/services/customers.service';
import { ReturnsService } from '../returns/services/returns.service';
import { ProductsService } from '../products/services/products.service';

const base = environment.api_base_url;

/** Stage 19: the exact request of every new call. */
describe('Stage 19 payloads — cash boxes, shifts, devices', () => {
  let service: CashboxService;
  let http: HttpTestingController;
  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    service = TestBed.inject(CashboxService);
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => http.verify());

  const expectCall = (method: string, url: string, body?: unknown) => {
    const request = http.expectOne(url);
    expect(request.request.method).toBe(method);
    if (body !== undefined) expect(request.request.body).toEqual(body);
    request.flush({});
  };

  it('reads: boxes, one box, its ledger, payment boxes, devices', () => {
    service.boxes().subscribe(); expectCall('GET', `${base}cashbox/boxes`);
    service.box('b1').subscribe(); expectCall('GET', `${base}cashbox/boxes/b1`);
    service.boxLedger('b1').subscribe(); expectCall('GET', `${base}cashbox/boxes/b1/ledger`);
    service.paymentBoxes().subscribe(); expectCall('GET', `${base}cashbox/payment-boxes`);
    service.devices().subscribe(); expectCall('GET', `${base}devices`);
  });

  it('create box: drawer bound to a PC with an opening amount; a wallet sends no device and no shifts flag', () => {
    service.createBox({ name: 'درج ٢', type: 'cash', deviceId: 'device-aaaa-0001', shiftsEnabled: true, openingAmount: 500 }).subscribe();
    expectCall('POST', `${base}cashbox/boxes`, { name: 'درج ٢', type: 'cash', deviceId: 'device-aaaa-0001', shiftsEnabled: true, openingAmount: 500 });
    service.createBox({ name: 'فودافون', type: 'wallet' }).subscribe();
    expectCall('POST', `${base}cashbox/boxes`, { name: 'فودافون', type: 'wallet' });
  });

  it('update box: rename, unbind the PC, stop it', () => {
    service.updateBox('b1', { name: 'جديد', deviceId: null, isActive: false }).subscribe();
    expectCall('PUT', `${base}cashbox/boxes/b1`, { name: 'جديد', deviceId: null, isActive: false });
  });

  it('transfers and drawings: create and cancel with a reason', () => {
    service.createTransfer({ fromBoxId: 'a', toBoxId: 'b', amount: 100, date: '2026-11-06', note: 'إيداع' }).subscribe();
    expectCall('POST', `${base}cashbox/transfers`, { fromBoxId: 'a', toBoxId: 'b', amount: 100, date: '2026-11-06', note: 'إيداع' });
    service.cancelTransfer('t1', 'غلط').subscribe(); expectCall('POST', `${base}cashbox/transfers/t1/cancel`, { reason: 'غلط' });
    service.createDrawing({ boxId: 'a', amount: 50, note: 'شخصي' }).subscribe(); expectCall('POST', `${base}cashbox/drawings`, { boxId: 'a', amount: 50, note: 'شخصي' });
    service.cancelDrawing('d1', 'غلط').subscribe(); expectCall('POST', `${base}cashbox/drawings/d1/cancel`, { reason: 'غلط' });
    service.transfers('a').subscribe();
    const list = http.expectOne((r) => r.url === `${base}cashbox/transfers`);
    expect(list.request.params.get('boxId')).toBe('a');
    list.flush({ data: [] });
  });

  it('shifts: open (and confirm the float), read, close with a note and a deposit', () => {
    service.openShift({ boxId: 'b1', openingFloat: 500 }).subscribe(); expectCall('POST', `${base}shifts`, { boxId: 'b1', openingFloat: 500 });
    service.openShift({ boxId: 'b1', openingFloat: 480, confirmFloat: true }).subscribe(); expectCall('POST', `${base}shifts`, { boxId: 'b1', openingFloat: 480, confirmFloat: true });
    service.openShift({ boxId: 'b1', openingFloat: 930, confirmFloat: true, openingNote: '30 ناقصة' }).subscribe(); expectCall('POST', `${base}shifts`, { boxId: 'b1', openingFloat: 930, confirmFloat: true, openingNote: '30 ناقصة' });
    service.shift('s1').subscribe(); expectCall('GET', `${base}shifts/s1`);
    service.closeShift('s1', { counted: 7500, differenceNote: 'عجز', depositBoxId: 'main', depositAmount: 7000 }).subscribe();
    expectCall('POST', `${base}shifts/s1/close`, { counted: 7500, differenceNote: 'عجز', depositBoxId: 'main', depositAmount: 7000 });
    service.shifts({ boxId: 'b1', status: 'open' }).subscribe();
    const list = http.expectOne((r) => r.url === `${base}shifts`);
    expect([list.request.params.get('boxId'), list.request.params.get('status')]).toEqual(['b1', 'open']);
    list.flush({ data: [] });
  });

  it('customer credit: read, pay out of a box, apply to open invoices', () => {
    service.customerCredit('c1').subscribe(); expectCall('GET', `${base}customers/c1/credit`);
    service.payoutCredit('c1', { boxId: 'b1', amount: 200, note: 'صرف' }).subscribe(); expectCall('POST', `${base}customers/c1/payouts`, { boxId: 'b1', amount: 200, note: 'صرف' });
    service.applyCredit('c1', 100).subscribe(); expectCall('POST', `${base}customers/c1/apply-credit`, { amount: 100 });
  });
});

describe('Stage 19 payloads — expenses', () => {
  let service: ExpensesService;
  let http: HttpTestingController;
  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    service = TestBed.inject(ExpensesService);
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => http.verify());

  it('list sends only the filters that are set', () => {
    service.list({ month: '2026-11', category: 'c1', box: 'b1' }).subscribe();
    const full = http.expectOne((r) => r.url === `${base}expenses`);
    expect([full.request.params.get('month'), full.request.params.get('category'), full.request.params.get('box')]).toEqual(['2026-11', 'c1', 'b1']);
    full.flush({});
    service.list({}).subscribe();
    const empty = http.expectOne((r) => r.url === `${base}expenses`);
    expect(empty.request.params.keys()).toEqual([]);
    empty.flush({});
  });

  it('create, cancel and the category calls', () => {
    const call = (method: string, url: string, body: unknown) => { const request = http.expectOne(url); expect(request.request.method).toBe(method); expect(request.request.body).toEqual(body); request.flush({}); };
    service.create({ accountId: 'c1', amount: 650, boxId: 'b1', date: '2026-11-03', note: 'كهرباء' }).subscribe();
    call('POST', `${base}expenses`, { accountId: 'c1', amount: 650, boxId: 'b1', date: '2026-11-03', note: 'كهرباء' });
    service.cancel('e1', 'اتسجل مرتين').subscribe(); call('POST', `${base}expenses/e1/cancel`, { reason: 'اتسجل مرتين' });
    service.createCategory({ nameAr: 'صيانة', nameEn: 'Maintenance' }).subscribe(); call('POST', `${base}expenses/categories`, { nameAr: 'صيانة', nameEn: 'Maintenance' });
    service.updateCategory('c9', { isActive: false }).subscribe(); call('PUT', `${base}expenses/categories/c9`, { isActive: false });
    service.categories().subscribe(); const get = http.expectOne(`${base}expenses/categories`); expect(get.request.method).toBe('GET'); get.flush({ data: [] });
  });
});

describe('Stage 19 payloads — the box on existing money calls', () => {
  let http: HttpTestingController;
  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => http.verify());

  const body = (url: string) => { const request = http.expectOne(url); const sent = request.request.body; request.flush({}); return sent; };

  it('a cash sale, a credit payment, a down payment and a customer collection carry boxId only when it is given', () => {
    const products = TestBed.inject(ProductsService);
    products.createSelling({ customerName: 'x', sellingDate: '2026-11-06', items: [{ productId: 'p', quantity: 1, price: 5 }], boxId: 'w1' }).subscribe();
    expect(body(`${base}sellings`).boxId).toBe('w1');
    const credit = TestBed.inject(CreditSalesService);
    credit.recordPayment('i1', { amount: 50, boxId: 'w1' }).subscribe();
    expect(body(`${base}credit-sales/i1/payments`)).toEqual({ amount: 50, boxId: 'w1' });
    credit.recordPayment('i1', { amount: 50 }).subscribe();
    expect(body(`${base}credit-sales/i1/payments`)).toEqual({ amount: 50 });
    credit.createCreditSale({ sellingDate: '2026-11-06', initialPaidAmount: 100, boxId: 'w1', items: [{ productId: 'p', quantity: 1, price: 5 }] }).subscribe();
    expect(body(`${base}credit-sales`).boxId).toBe('w1');
    TestBed.inject(CustomersService).collectPayment('c1', { amount: 10, boxId: 'w1' }).subscribe();
    expect(body(`${base}customers/c1/payments`)).toEqual({ amount: 10, boxId: 'w1', firstInvoice: true });
  });

  it('a cancel with a down payment names the box ("رد المقدم"); without one the body is just the reason', () => {
    const credit = TestBed.inject(CreditSalesService);
    credit.cancelCreditSale('i1', 'سبب', 'w1').subscribe();
    expect(body(`${base}credit-sales/i1/cancel`)).toEqual({ reason: 'سبب', boxId: 'w1' });
    credit.cancelCreditSale('i1', 'سبب').subscribe();
    expect(body(`${base}credit-sales/i1/cancel`)).toEqual({ reason: 'سبب' });
  });

  it('a cash-sale cancel names the box that pays the refund; without one the body is just the reason', () => {
    const products = TestBed.inject(ProductsService);
    products.cancelSelling('s1', 'سبب', 'w1').subscribe();
    expect(body(`${base}sellings/s1/cancel`)).toEqual({ reason: 'سبب', boxId: 'w1' });
    products.cancelSelling('s1', 'سبب').subscribe();
    expect(body(`${base}sellings/s1/cancel`)).toEqual({ reason: 'سبب' });
  });

  it('a cash return carries the box it is refunded from', () => {
    TestBed.inject(ReturnsService).createReturn({ returnType: 'cash', invoiceId: 'i1', returnDate: '2026-11-06', boxId: 'w1', items: [{ productId: 'p', quantity: 1 }] }).subscribe();
    expect(body(`${base}returns`).boxId).toBe('w1');
  });
});
