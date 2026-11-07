import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { environment } from '../../../environments/environment';
import { allocateCosts, journalPreview, paymentModeOf, weightedAverage } from './purchase-math';
import { PurchasesService } from './purchases.service';

const base = environment.api_base_url;

describe('purchase-math (Stage 20: mirrors the backend cost rules)', () => {
  it('the design invoice: 1,400 + 2,400 + 1,650 = 5,450, every line cost = its value', () => {
    const { lineCosts, subtotal, total } = allocateCosts([1400, 2400, 1650]);
    expect([subtotal, total]).toEqual([5450, 5450]);
    expect(lineCosts).toEqual([1400, 2400, 1650]);
  });

  it('discount and other costs are spread by line value and Σ line costs equals the total exactly', () => {
    for (const [totals, discount, other] of [[[100, 100, 100], 10, 0], [[333.33, 666.67, 1], 7.77, 12.34], [[10, 20, 30, 40], 0.01, 0.02], [[5], 1, 0]] as const) {
      const { lineCosts, total } = allocateCosts([...totals], discount, other);
      expect(Math.round(lineCosts.reduce((sum, value) => sum + value, 0) * 100) / 100).toBe(total);
    }
    const { lineCosts } = allocateCosts([300, 100], 40, 0);
    expect(lineCosts).toEqual([270, 90]);
  });

  it('weighted average: 10 at 20 + 10 at 30 = 25; no stock or negative stock takes the purchase cost; rounding to 2 decimals', () => {
    expect(weightedAverage(10, 20, 10, 300)).toBe(25);
    expect(weightedAverage(0, 20, 10, 300)).toBe(30);
    expect(weightedAverage(-4, 20, 10, 300)).toBe(30);
    expect(weightedAverage(3, 10, 7, 72.31)).toBe(10.23);
  });

  it('payment modes and the journal preview (net effect of the purchase and its PV)', () => {
    expect([paymentModeOf(0, 5450), paymentModeOf(3000, 5450), paymentModeOf(5450, 5450)]).toEqual(['all_credit', 'part_cash', 'all_cash']);
    expect(journalPreview(5450, 3000)).toEqual([
      { account: 'inventory', side: 'debit', amount: 5450 }, { account: 'box', side: 'credit', amount: 3000 }, { account: 'supplier', side: 'credit', amount: 2450 },
    ]);
    expect(journalPreview(100, 100).map((row) => row.account)).toEqual(['inventory', 'box']);
    expect(journalPreview(100, 0).map((row) => row.account)).toEqual(['inventory', 'supplier']);
    expect(journalPreview(0, 0)).toEqual([]);
  });
});

describe('PurchasesService payloads (Stage 20)', () => {
  let service: PurchasesService;
  let http: HttpTestingController;
  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    service = TestBed.inject(PurchasesService);
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => http.verify());

  it('list sends only the filters that are set', () => {
    service.list({ supplier: 's1', from: '2026-11-01', to: '', status: 'cancelled', search: 'po-1', page: 2 }).subscribe();
    const req = http.expectOne((r) => r.url === `${base}purchases`);
    expect(req.request.method).toBe('GET');
    expect(req.request.params.keys().sort()).toEqual(['from', 'page', 'search', 'status', 'supplier']);
    expect(req.request.params.get('status')).toBe('cancelled');
    req.flush({ data: [], pagination: { page: 2, limit: 50, totalItems: 0, totalPages: 0 } });
  });

  it('get, create and cancel hit /purchases with the exact bodies', () => {
    service.get('p 1').subscribe();
    http.expectOne(`${base}purchases/p%201`).flush({});
    const payload = {
      supplierId: 's1', supplierInvoiceNo: 'EL-8841', date: '2026-11-03', items: [{ productId: 'a', qty: 20, unitPrice: 70 }], discountAmount: 10, otherCosts: 5, paidAmount: 3000, boxId: 'b1', notes: 'x',
    };
    service.create(payload).subscribe();
    const create = http.expectOne(`${base}purchases`);
    expect(create.request.method).toBe('POST');
    expect(create.request.body).toEqual(payload);
    create.flush({});
    service.cancel('p1', 'wrong supplier').subscribe();
    const cancel = http.expectOne(`${base}purchases/p1/cancel`);
    expect(cancel.request.method).toBe('POST');
    expect(cancel.request.body).toEqual({ reason: 'wrong supplier' });
    cancel.flush({});
  });

  it('return, payment, payment cancel, statement and product calls', () => {
    service.createReturn('p1', { items: [{ itemId: 'i1', qty: 2 }], reason: 'damaged', refundAmount: 480, boxId: 'b1' }).subscribe();
    const ret = http.expectOne(`${base}purchases/p1/returns`);
    expect(ret.request.body).toEqual({ items: [{ itemId: 'i1', qty: 2 }], reason: 'damaged', refundAmount: 480, boxId: 'b1' });
    ret.flush({});

    service.pay('s1', { amount: 2500, boxId: 'bank', reference: 'CHQ-7', note: 'دفعة', confirmAdvance: true }).subscribe();
    const pay = http.expectOne(`${base}suppliers/s1/payments`);
    expect(pay.request.method).toBe('POST');
    expect(pay.request.body).toEqual({ amount: 2500, boxId: 'bank', reference: 'CHQ-7', note: 'دفعة', confirmAdvance: true });
    pay.flush({});

    service.cancelPayment('pv1', 'mistake').subscribe();
    const cancelPv = http.expectOne(`${base}supplier-payments/pv1/cancel`);
    expect(cancelPv.request.body).toEqual({ reason: 'mistake' });
    cancelPv.flush({});

    service.statement('s1', { from: '2026-10-01', to: '2026-11-01' }).subscribe();
    const statement = http.expectOne((r) => r.url === `${base}suppliers/s1/statement`);
    expect([statement.request.params.get('from'), statement.request.params.get('to')]).toEqual(['2026-10-01', '2026-11-01']);
    statement.flush({});
    service.statement('s1').subscribe();
    expect(http.expectOne((r) => r.url === `${base}suppliers/s1/statement`).request.params.keys()).toEqual([]);

    service.searchProducts('led').subscribe();
    expect(http.expectOne((r) => r.url === `${base}products/search`).request.params.get('q')).toBe('led');
    const product = { name: 'صنف', code: 'N1', categoryId: 'c1', inventoryCount: 0, purchasePrice: 0, wholesalePrice: 50, retailPrice: 60 };
    service.createProduct(product).subscribe();
    const created = http.expectOne(`${base}products`);
    expect(created.request.body).toEqual(product);
    created.flush({});
    service.categories().subscribe((rows) => expect(rows).toEqual([{ _id: 'c1', name: 'إضاءة' }]));
    http.expectOne(`${base}categories`).flush([{ _id: 'c1', name: 'إضاءة', extra: 1 }]);
  });
});
