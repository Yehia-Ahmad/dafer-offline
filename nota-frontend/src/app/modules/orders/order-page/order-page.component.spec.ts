import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { environment } from '../../../../environments/environment';
import { signInAs, signInWith } from '../../../core/auth/testing/sign-in';
import { OrderDetail, OrderStatus } from '../orders.models';
import { OrderPageComponent } from './order-page.component';

/** Online Stage 4: /orders/:id: the actions each status and permission allow, the dialogs and the edit mode. */
describe('OrderPageComponent (Online Stage 4)', () => {
  const url = `${environment.api_base_url}orders/o1`;
  let http: HttpTestingController;
  let fixture: any;
  let component: any;

  const line = (productId: string, name: string, unitPrice: number, qty: number, extra = {}) => ({ productId, name, retailPrice: unitPrice, discountPercentage: 0, unitPrice, vat: 0, vatExempt: false, qty, lineTotal: unitPrice * qty, inventoryCount: 20, reservedByOthers: 0, ...extra });
  const order = (status: OrderStatus, extra: Partial<OrderDetail> = {}): OrderDetail => ({
    id: 'o1', number: 'W-000001', status, createdAt: '2026-11-05T10:00:00Z', updatedAt: '2026-11-05T10:00:00Z',
    items: [line('p1', 'لمبة', 100, 2), line('p2', 'كابل', 50, 1)],
    subtotal: 250, vat: 0, deliveryFee: 30, total: 280, zone: { id: 'z1', name: 'القاهرة', fee: 30 },
    contact: { name: 'منى', phone: '01012345678', address: 'شارع 1', notes: 'اتصل قبل الوصول' }, reason: null, collectedAmount: null, courier: null, creditSale: null,
    statusHistory: [{ status: 'new', at: '2026-11-05T10:00:00Z', by: 'customer', byName: null, type: 'status', note: null, details: null }], ...extra,
  });

  async function open(role: 'cashier' | 'owner' | string[], detail: OrderDetail) {
    await TestBed.configureTestingModule({
      imports: [OrderPageComponent, TranslateModule.forRoot()],
      providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting(), provideNoopAnimations(), { provide: ActivatedRoute, useValue: { snapshot: { paramMap: convertToParamMap({ id: 'o1' }) } } }],
    }).compileComponents();
    if (Array.isArray(role)) signInWith(role); else signInAs(role);
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(OrderPageComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
    http.expectOne((r) => r.url === url && r.method === 'GET').flush(detail);
    fixture.detectChanges();
  }
  afterEach(() => http.verify());

  const actions = (): string[] => Array.from(fixture.nativeElement.querySelectorAll('[data-test="order-actions"] [data-action]')).map((el: any) => el.dataset.action).filter((a: string) => !a.startsWith('print-'));

  it('a new order offers confirm, edit and reject; the lines show stock and what others reserved; the contact can be copied and opened on WhatsApp', async () => {
    await open('cashier', order('new', { items: [line('p1', 'لمبة', 100, 2, { inventoryCount: 3, reservedByOthers: 2 }), line('p2', 'كابل', 50, 1)] }));
    expect(actions()).toEqual(['confirm', 'edit', 'reject']);
    const lines: HTMLElement[] = Array.from(fixture.nativeElement.querySelectorAll('[data-test="order-line"]'));
    expect(lines.length).toBe(2);
    expect(lines[0].textContent).toContain('3'); // stock
    expect(lines[0].classList).toContain('op__short'); // 2 ordered > 3 - 2 available
    expect(lines[1].classList).not.toContain('op__short');
    expect(fixture.nativeElement.querySelector('[data-action="whatsapp"]').getAttribute('href')).toBe('https://wa.me/201012345678');
    expect(fixture.nativeElement.querySelector('[data-action="copy-address"]')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('[data-test="order-total"]').textContent.replace(/[٠-٩]/g, (d: string) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))).toContain('280');
  });

  it('actions by status: confirmed, preparing, out for delivery, and none once it is closed', async () => {
    await open('cashier', order('confirmed'));
    expect(actions()).toEqual(['prepare', 'dispatch', 'edit', 'reject', 'cancel']);
    component.order.set(order('preparing')); fixture.detectChanges();
    expect(actions()).toEqual(['dispatch', 'edit', 'cancel']);
    component.order.set(order('out_for_delivery')); fixture.detectChanges();
    expect(actions()).toEqual(['deliver', 'refuse']);
    for (const status of ['delivered', 'cancelled', 'rejected', 'refused'] as OrderStatus[]) {
      component.order.set(order(status)); fixture.detectChanges();
      expect(actions()).withContext(status).toEqual([]);
    }
  });

  it('a user with orders.view only sees no action; dispatch needs credit.create too', async () => {
    await open(['orders.view'], order('confirmed'));
    expect(actions()).toEqual([]);
    // orders.manage alone confirms but cannot send out (credit.create is also needed)
    component.order.set(order('new')); fixture.detectChanges();
    expect(actions()).toEqual([]);
  });

  it('confirm posts and shows the order the server returns', async () => {
    await open('cashier', order('new'));
    fixture.nativeElement.querySelector('[data-action="confirm"]').click();
    const request = http.expectOne((r) => r.url === `${url}/confirm` && r.method === 'POST');
    request.flush(order('confirmed'));
    fixture.detectChanges();
    expect(component.order().status).toBe('confirmed');
    expect(actions()).toEqual(['prepare', 'dispatch', 'edit', 'reject', 'cancel']);
  });

  it('a wrong-status answer (409) shows the message and reloads the order', async () => {
    await open('cashier', order('new'));
    component.run('confirm');
    http.expectOne((r) => r.url === `${url}/confirm`).flush({ message: 'حالة الطلب اتغيرت. حدّث الصفحة', code: 'INVALID_STATUS' }, { status: 409, statusText: 'Conflict' });
    expect(component.errorMessage()).toContain('حالة الطلب اتغيرت');
    http.expectOne((r) => r.url === url && r.method === 'GET').flush(order('confirmed'));
    expect(component.order().status).toBe('confirmed');
  });

  it('a stock problem lists the products and what is available', async () => {
    await open('cashier', order('new'));
    component.run('confirm');
    http.expectOne((r) => r.url === `${url}/confirm`).flush({ message: 'بعض الأصناف الكمية فيها أكبر من المتاح', code: 'ORDER_ITEMS_INVALID', lines: [{ productId: 'p1', name: 'لمبة', available: 1 }] }, { status: 409, statusText: 'Conflict' });
    expect(component.errorMessage()).toContain('لمبة (1)');
    http.expectOne((r) => r.url === url && r.method === 'GET').flush(order('new'));
  });

  it('reject and cancel need a reason of 3+ characters; refuse does not', async () => {
    await open('cashier', order('confirmed'));
    component.run('reject');
    expect(component.reasonFor()).toBe('reject');
    component.reason.set('  ');
    fixture.detectChanges();
    component.reason.set('نفد');
    component.submitReason();
    const request = http.expectOne((r) => r.url === `${url}/reject`);
    expect(request.request.body).toEqual({ reason: 'نفد' });
    request.flush(order('rejected', { reason: 'نفد' }));
    expect(component.order().status).toBe('rejected');
  });

  it('send out asks for the courier (active ones only) and posts the courier id', async () => {
    await open('cashier', order('confirmed'));
    component.run('dispatch');
    http.expectOne(`${environment.api_base_url}couriers`).flush({ data: [
      { id: 'c1', name: 'أحمد', phone: '0100', isActive: true, boxId: 'b1', customerId: 'u1', boxBalance: 0, amountOwed: 0, openOrders: 0 },
      { id: 'c2', name: 'موقوف', phone: '0101', isActive: false, boxId: 'b2', customerId: 'u2', boxBalance: 0, amountOwed: 0, openOrders: 0 },
    ] });
    expect(component.activeCouriers().map((c: any) => c.id)).toEqual(['c1']);
    component.submitDispatch(); // nothing chosen: nothing sent
    component.courierId.set('c1');
    component.submitDispatch();
    const request = http.expectOne((r) => r.url === `${url}/dispatch` && r.method === 'POST');
    expect(request.request.body).toEqual({ courierId: 'c1' });
    request.flush(order('out_for_delivery', { courier: { id: 'c1', name: 'أحمد', phone: '0100' }, creditSale: { id: 's1', number: 'CR-000001', totalPrice: 280, paidAmount: 0, remainingAmount: 280, status: 'pending', shippingFees: 30 } }));
    expect(component.order().courier.name).toBe('أحمد');
  });

  it('delivered with returns: choose lines and quantities, see the amount to collect, post the returns without a typed amount', async () => {
    await open('cashier', order('out_for_delivery', { creditSale: { id: 's1', number: 'CR-000001', totalPrice: 280, paidAmount: 0, remainingAmount: 280, status: 'pending', shippingFees: 30 } }));
    component.run('deliver');
    expect(component.collectEstimate()).toBe(280);
    component.withReturns.set(true);
    component.setReturned('p1', 1, 2);
    expect(component.collectEstimate()).toBe(180); // one lamp (100) back, the delivery fee stays
    component.setReturned('p2', 5, 1); // clamped to the ordered 1
    expect(component.returned()['p2']).toBe(1);
    expect(component.collectEstimate()).toBe(130);
    component.setReturned('p1', 2, 2);
    expect(component.allReturned()).toBeTrue(); // everything back = a refusal
    component.submitDeliver();
    http.expectNone((r) => r.url === `${url}/deliver`);
    component.setReturned('p2', 0, 1);
    component.setReturned('p1', 1, 2);
    component.submitDeliver();
    const request = http.expectOne((r) => r.url === `${url}/deliver` && r.method === 'POST');
    expect(request.request.body).toEqual({ returns: [{ productId: 'p1', qty: 1 }] });
    request.flush(order('delivered', { collectedAmount: 180 }));
    expect(component.order().collectedAmount).toBe(180);
  });

  it('delivered without returns can type the amount the courier actually collected', async () => {
    await open('cashier', order('out_for_delivery'));
    component.run('deliver');
    component.collected.set(250);
    component.submitDeliver();
    const request = http.expectOne((r) => r.url === `${url}/deliver`);
    expect(request.request.body).toEqual({ collectedAmount: 250 });
    request.flush(order('delivered', { collectedAmount: 250 }));
  });

  it('refuse posts the (optional) reason', async () => {
    await open('cashier', order('out_for_delivery'));
    component.run('refuse');
    component.reason.set('العميل رفض');
    component.submitReason();
    const request = http.expectOne((r) => r.url === `${url}/refuse`);
    expect(request.request.body).toEqual({ reason: 'العميل رفض' });
    request.flush(order('refused'));
    expect(component.order().status).toBe('refused');
  });

  it('edit mode: change quantity, remove a line, change the zone and fee; the PUT carries only what changed', async () => {
    await open('cashier', order('confirmed'));
    component.run('edit');
    http.expectOne(`${environment.api_base_url}orders/delivery-zones`).flush({ data: [{ id: 'z1', name: 'القاهرة', fee: 30 }, { id: 'z2', name: 'الجيزة', fee: 55 }] });
    fixture.detectChanges();
    expect(component.editing()).toBeTrue();
    component.setQty('p1', 3);
    component.removeLine('p2');
    component.patchDraft({ zoneId: 'z2', address: 'عنوان جديد', deliveryFee: 55 });
    component.saveEdit();
    const request = http.expectOne((r) => r.url === url && r.method === 'PUT');
    expect(request.request.body).toEqual({
      items: [{ productId: 'p1', qty: 3 }],
      contact: { name: 'منى', phone: '01012345678', address: 'عنوان جديد', notes: 'اتصل قبل الوصول' },
      zoneId: 'z2',
      deliveryFee: 55,
    });
    request.flush(order('confirmed', { total: 355 }));
    expect(component.editing()).toBeFalse();
    expect(component.order().total).toBe(355);
  });

  it('edit mode: adding a product comes from the product search and is sent as a new line', async () => {
    await open('cashier', order('new'));
    component.run('edit');
    http.expectOne(`${environment.api_base_url}orders/delivery-zones`).flush({ data: [] });
    component.searchProducts('بطارية');
    http.expectOne((r) => r.url === `${environment.api_base_url}products/search` && r.params.get('q') === 'بطارية').flush([{ _id: 'p9', name: 'بطارية', retailPrice: 20, inventoryCount: 7 }]);
    component.addProduct(component.productResults()[0]);
    expect(component.editLines().map((l: any) => l.productId)).toEqual(['p1', 'p2', 'p9']);
    expect(component.stockOf('p9')).toBe(7);
    component.saveEdit();
    const request = http.expectOne((r) => r.url === url && r.method === 'PUT');
    expect(request.request.body.items).toEqual([{ productId: 'p1', qty: 2 }, { productId: 'p2', qty: 1 }, { productId: 'p9', qty: 1 }]);
    request.flush(order('new'));
  });

  it('history lists each step with who did it, and an edit with a summary', async () => {
    await open('cashier', order('confirmed', { statusHistory: [
      { status: 'new', at: '2026-11-05T10:00:00Z', by: 'guest', byName: null, type: 'status', note: null, details: null },
      { status: 'new', at: '2026-11-05T10:05:00Z', by: 'u1', byName: 'محمود', type: 'edit', note: null, details: { total: { from: 230, to: 280 }, lines: [{ change: 'qty' }] } },
      { status: 'confirmed', at: '2026-11-05T10:06:00Z', by: 'u1', byName: 'محمود', type: 'status', note: null, details: null },
    ] }));
    const entries: string[] = Array.from(fixture.nativeElement.querySelectorAll('[data-test="order-history"] li')).map((el: any) => el.textContent.replace(/\s+/g, ' '));
    expect(entries.length).toBe(3);
    expect(entries[1]).toContain('محمود'); expect(entries[1]).toContain('230 → 280'); expect(entries[1]).toContain('orders.page.edited');
    expect(entries[2]).toContain('orders.status.confirmed');
  });
});
