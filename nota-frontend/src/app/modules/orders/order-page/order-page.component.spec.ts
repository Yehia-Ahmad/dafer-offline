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
    // Online Stage 5A: an order placed before Stage 5A is a delivery order paid on delivery
    fulfillment: 'delivery', paymentMethod: 'cod', payment: { status: null, verifiedAt: null, verifiedByName: null, reference: null }, invoice: null,
    whatsappTemplate: 'أهلاً {الاسم}، طلبك {رقم الطلب} بإجمالي {الإجمالي}. مدة التوصيل {مدة التوصيل}', deliveryTime: 'خلال 24 ساعة',
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
    expect(actions()).toEqual(['deliver', 'refuse', 'changeCourier']);
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

  describe('تغيير المندوب (Online Fixes 1)', () => {
    const couriers = { data: [
      { id: 'c1', name: 'أحمد', phone: '0100', isActive: true, boxId: 'b1', customerId: 'u1', boxBalance: 0, amountOwed: 280, openOrders: 1 },
      { id: 'c2', name: 'محمود', phone: '0101', isActive: true, boxId: 'b2', customerId: 'u2', boxBalance: 0, amountOwed: 0, openOrders: 0 },
      { id: 'c3', name: 'موقوف', phone: '0102', isActive: false, boxId: 'b3', customerId: 'u3', boxBalance: 0, amountOwed: 0, openOrders: 0 },
    ] };
    const outWith = (extra = {}) => order('out_for_delivery', { courier: { id: 'c1', name: 'أحمد', phone: '0100' }, creditSale: { id: 's1', number: 'CR-000001', totalPrice: 280, paidAmount: 0, remainingAmount: 280, status: 'pending', shippingFees: 30 }, ...extra });

    it('is offered on an order out for delivery; the dialog lists the active couriers except the current one and posts to change-courier', async () => {
      await open('cashier', outWith());
      expect(actions()).toContain('changeCourier');
      component.run('changeCourier');
      http.expectOne(`${environment.api_base_url}couriers`).flush(couriers);
      fixture.detectChanges();
      expect(component.dispatchMode()).toBe('changeCourier');
      expect(component.courierChoices().map((c: any) => c.id)).toEqual(['c2']);
      component.submitDispatch(); // nothing chosen: nothing sent
      component.courierId.set('c2');
      component.submitDispatch();
      const request = http.expectOne((r) => r.url === `${url}/change-courier` && r.method === 'POST');
      expect(request.request.body).toEqual({ courierId: 'c2' });
      request.flush(outWith({ courier: { id: 'c2', name: 'محمود', phone: '0101' }, statusHistory: [
        { status: 'new', at: '2026-11-05T10:00:00Z', by: 'customer', byName: null, type: 'status', note: null, details: null },
        { status: 'out_for_delivery', at: '2026-11-05T12:00:00Z', by: 'u1', byName: 'منى', type: 'courier_change', note: 'غيّر المندوب من أحمد لـ محمود', details: null },
      ] }));
      expect(component.order().courier.name).toBe('محمود');
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('[data-test="order-history"]').textContent).toContain('غيّر المندوب من أحمد لـ محمود');
    });

    it('when the only active courier is the current one the dialog says «مفيش مندوب تاني متاح», not the no-couriers text', async () => {
      await open('cashier', outWith());
      component.run('changeCourier');
      http.expectOne(`${environment.api_base_url}couriers`).flush({ data: [couriers.data[0], couriers.data[2]] }); // the current courier and an inactive one
      fixture.detectChanges();
      expect(component.courierChoices().length).toBe(0);
      expect(document.body.querySelector('[data-test="no-couriers"]')!.textContent).toContain('orders.page.noOtherCourier');
    });

    it('with no couriers at all the old text stays', async () => {
      await open('cashier', order('confirmed'));
      component.run('dispatch');
      http.expectOne(`${environment.api_base_url}couriers`).flush({ data: [] });
      fixture.detectChanges();
      expect(document.body.querySelector('[data-test="no-couriers"]')!.textContent).toContain('orders.page.noCouriers');
    });

    it('dispatch still lists every active courier (the mode is reset)', async () => {
      await open('cashier', order('confirmed'));
      component.run('dispatch');
      http.expectOne(`${environment.api_base_url}couriers`).flush(couriers);
      expect(component.dispatchMode()).toBe('dispatch');
      expect(component.courierChoices().map((c: any) => c.id)).toEqual(['c1', 'c2']);
    });

    it('a refusal keeps the dialog and shows the server message; a cash-on-delivery order needs credit.create and returns.create', async () => {
      await open(['orders.view', 'orders.dispatch', 'credit.create'], outWith());
      expect(actions()).not.toContain('changeCourier');
      TestBed.resetTestingModule();
      await open(['orders.view', 'orders.dispatch', 'credit.create', 'returns.create'], outWith());
      component.run('changeCourier');
      http.expectOne(`${environment.api_base_url}couriers`).flush(couriers);
      component.courierId.set('c2');
      component.submitDispatch();
      http.expectOne((r) => r.url === `${url}/change-courier`).flush({ code: 'HAS_PAYMENTS', message: 'اتسجل تحصيل على فاتورة المندوب' }, { status: 409, statusText: 'Conflict' });
      http.expectOne((r) => r.url === url && r.method === 'GET').flush(outWith());
      expect(component.errorMessage()).toContain('تحصيل');
    });
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

  // ------------------------------------------------------------------ Online Stage 5A

  const pickupOrder = (status: OrderStatus, extra: Partial<OrderDetail> = {}) => order(status, { fulfillment: 'pickup', zone: null, deliveryFee: 0, total: 250, contact: { name: 'منى', phone: '01012345678', address: '', notes: '' }, deliveryTime: '', ...extra });
  const wallet = (verified: boolean): Partial<OrderDetail> => ({ paymentMethod: 'instapay', payment: { status: verified ? 'verified' : 'unpaid', verifiedAt: null, verifiedByName: null, reference: null } });

  it('a pickup order follows new → confirmed → preparing → ready → picked up, with cancel (reason) while ready', async () => {
    await open('cashier', pickupOrder('new'));
    expect(actions()).toEqual(['confirm', 'edit', 'reject']);
    expect(fixture.nativeElement.querySelector('[data-test="order-pickup"]')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('[data-action="copy-address"]')).toBeNull();
    component.order.set(pickupOrder('confirmed')); fixture.detectChanges();
    expect(actions()).toEqual(['prepare', 'edit', 'reject', 'cancel']);
    component.order.set(pickupOrder('preparing')); fixture.detectChanges();
    expect(actions()).toEqual(['ready', 'edit', 'cancel']);
    component.order.set(pickupOrder('ready_for_pickup')); fixture.detectChanges();
    expect(actions()).toEqual(['pickup', 'cancel']);
    for (const status of ['picked_up', 'cancelled'] as OrderStatus[]) { component.order.set(pickupOrder(status)); fixture.detectChanges(); expect(actions()).withContext(status).toEqual([]); }
  });

  it('ready posts to /ready; a pickup order has no delivery fee, no zone field and no delivery note to print', async () => {
    await open('cashier', pickupOrder('preparing'));
    expect(fixture.nativeElement.querySelector('nota-print-actions')).toBeNull();
    fixture.nativeElement.querySelector('[data-action="ready"]').click();
    http.expectOne((r) => r.url === `${url}/ready` && r.method === 'POST').flush(pickupOrder('ready_for_pickup'));
    fixture.detectChanges();
    expect(component.order().status).toBe('ready_for_pickup');
    component.run('edit');
    http.expectOne(`${environment.api_base_url}orders/delivery-zones`).flush({ data: [] });
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-test="edit-zone"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('[data-test="edit-fee"]')).toBeNull();
    component.saveEdit();
    const body = http.expectOne((r) => r.url === url && r.method === 'PUT').request.body;
    expect('zoneId' in body).toBeFalse(); expect('deliveryFee' in body).toBeFalse();
  });

  it('picked up with cash opens the box choice and posts it only when it is not the default; a wallet order sends none', async () => {
    await open('cashier', pickupOrder('ready_for_pickup'));
    component.run('pickup');
    fixture.detectChanges();
    http.match((r) => r.url.endsWith('cashbox/payment-boxes')).forEach((r) => r.flush({ defaultBoxId: 'main', mainBox: { _id: 'main', name: 'الخزنة الرئيسية' }, deviceId: null, data: [{ _id: 'main', name: 'الخزنة الرئيسية', type: 'cash', isMain: true, shiftsEnabled: false, isDefault: true, openShift: null, needsShift: false }] }));
    fixture.detectChanges();
    expect(component.pickupOpen()).toBeTrue();
    component.submitPickup();
    let request = http.expectOne((r) => r.url === `${url}/pickup` && r.method === 'POST');
    expect(request.request.body).toEqual({});
    request.flush(pickupOrder('picked_up', { invoice: { kind: 'cash', id: 's1', number: 'INV-1', totalPrice: 250, shippingFees: 0, refundedAmount: 0, refundStatus: 'none', boxId: 'main' } }));
    fixture.detectChanges();
    expect(component.pickupOpen()).toBeFalse();
    expect(fixture.nativeElement.querySelector('[data-test="order-invoice"]').textContent).toContain('INV-1');

    component.order.set(pickupOrder('ready_for_pickup', wallet(true))); fixture.detectChanges();
    component.run('pickup'); fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-test="pickup-wallet"]')).not.toBeNull();
    component.submitPickup();
    request = http.expectOne((r) => r.url === `${url}/pickup`);
    expect(request.request.body).toEqual({});
    request.flush(pickupOrder('picked_up', wallet(true)));
  });

  it('a wallet order offers "تأكيد استلام التحويل" first; send out / pickup appear only after it, and the badges show method and status', async () => {
    await open('cashier', order('confirmed', wallet(false)));
    expect(actions()).toEqual(['verifyPayment', 'prepare', 'edit', 'reject', 'cancel']);
    expect(fixture.nativeElement.querySelector('[data-test="order-method"]')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('[data-test="order-payment"]')).not.toBeNull();
    component.order.set(order('confirmed', wallet(true))); fixture.detectChanges();
    expect(actions()).toEqual(['prepare', 'dispatch', 'edit', 'reject', 'cancel']);
    component.order.set(pickupOrder('ready_for_pickup', wallet(false))); fixture.detectChanges();
    expect(actions()).toEqual(['verifyPayment', 'cancel']);
    component.order.set(pickupOrder('ready_for_pickup', wallet(true))); fixture.detectChanges();
    expect(actions()).toEqual(['pickup', 'cancel']);
  });

  it('verify posts the optional reference; nothing is typed = an empty body', async () => {
    await open('cashier', order('new', wallet(false)));
    component.run('verifyPayment');
    expect(component.verifyOpen()).toBeTrue();
    component.reference.set('  TX-77 ');
    component.submitVerify();
    const request = http.expectOne((r) => r.url === `${url}/verify-payment` && r.method === 'POST');
    expect(request.request.body).toEqual({ reference: 'TX-77' });
    request.flush(order('new', { ...wallet(true), payment: { status: 'verified', verifiedAt: '2026-11-05T11:00:00Z', verifiedByName: 'محمود', reference: 'TX-77' } }));
    fixture.detectChanges();
    expect(component.verifyOpen()).toBeFalse();
    expect(actions()).toEqual(['confirm', 'edit', 'reject']);
    expect(fixture.nativeElement.textContent).toContain('TX-77');
  });

  it('a wallet order delivers without collecting anything (no amount to collect, no typed amount)', async () => {
    await open('cashier', order('out_for_delivery', wallet(true)));
    expect(actions()).toEqual(['deliver', 'refuse', 'changeCourier']);
    component.run('deliver');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-test="amount-to-collect"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('[data-test="nothing-to-collect"]')).not.toBeNull();
    component.submitDeliver();
    const request = http.expectOne((r) => r.url === `${url}/deliver`);
    expect(request.request.body).toEqual({});
    request.flush(order('delivered', wallet(true)));
  });

  it('permissions: a wallet send-out needs sales.create (not credit.create); a cash-on-delivery send-out still needs credit.create', async () => {
    await open(['orders.view', 'orders.dispatch', 'sales.create'], order('confirmed', wallet(true)));
    expect(actions()).toEqual(['dispatch']);
    component.order.set(order('confirmed')); fixture.detectChanges();
    expect(actions()).toEqual([]);
    component.order.set(pickupOrder('ready_for_pickup')); fixture.detectChanges();
    expect(actions()).toEqual(['pickup']);
  });

  it('the WhatsApp confirmation link: wa.me/<customer phone>?text=<the filled template>, opened in a new tab; not shown for a closed order', async () => {
    await open('cashier', order('confirmed'));
    const link: HTMLAnchorElement = fixture.nativeElement.querySelector('[data-test="whatsapp-confirm"]');
    expect(link.getAttribute('target')).toBe('_blank');
    const href = link.getAttribute('href')!;
    expect(href.startsWith('https://wa.me/201012345678?text=')).toBeTrue();
    expect(decodeURIComponent(href.split('?text=')[1])).toBe('أهلاً منى، طلبك W-000001 بإجمالي 280. مدة التوصيل خلال 24 ساعة');
    component.order.set(order('cancelled')); fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-test="whatsapp-confirm"]')).toBeNull();
  });
});
