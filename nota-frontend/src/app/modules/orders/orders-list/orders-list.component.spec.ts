import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { environment } from '../../../../environments/environment';
import { signInWith } from '../../../core/auth/testing/sign-in';
import { OrderListResponse, OrderListRow } from '../orders.models';
import { OrdersListComponent } from './orders-list.component';

/** Online Stage 4: /orders: tabs with counts, search, date range, courier filter. */
describe('OrdersListComponent (Online Stage 4)', () => {
  const url = `${environment.api_base_url}orders`;
  let http: HttpTestingController;
  let fixture: any;
  let component: any;

  const row = (over: Partial<OrderListRow>): OrderListRow => ({ id: 'o1', number: 'W-000001', status: 'new', createdAt: '2026-11-05T10:00:00Z', customerName: 'منى', phone: '01012345678', zone: 'القاهرة', fulfillment: 'delivery', paymentMethod: 'cod', paymentStatus: null, needsTransfer: false, total: 230, courierId: null, courierName: null, ...over });
  const response = (rows: OrderListRow[], counts: Partial<OrderListResponse['counts']> = {}): OrderListResponse => ({
    data: rows,
    counts: { new: 1, confirmed: 0, preparing: 0, ready_for_pickup: 0, picked_up: 0, out_for_delivery: 1, delivered: 3, cancelled: 0, rejected: 0, refused: 0, ...counts },
    pagination: { page: 1, limit: 20, totalItems: rows.length, totalPages: 1 },
  });
  const listRequests = () => http.match((request) => request.url === url && request.method === 'GET');

  beforeEach(async () => {
    // No orders.view here: the notifier (a separate spec) does not poll, so the only requests are the page's own.
    await TestBed.configureTestingModule({
      imports: [OrdersListComponent, TranslateModule.forRoot()],
      providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
    signInWith([]);
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(OrdersListComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
    http.expectOne(`${environment.api_base_url}couriers`).flush({ data: [{ id: 'c1', name: 'أحمد', phone: '0100', isActive: true, boxId: 'b', customerId: 'u', boxBalance: 0, amountOwed: 0, openOrders: 0 }] });
    const [first] = listRequests();
    first.flush(response([row({ id: 'o1' }), row({ id: 'o2', number: 'W-000002', status: 'out_for_delivery', customerName: 'علي', courierId: 'c1', courierName: 'أحمد' })]));
    fixture.detectChanges();
  });
  afterEach(() => http.verify());

  const text = (selector: string): string[] => Array.from(fixture.nativeElement.querySelectorAll(selector)).map((el) => (el as HTMLElement).textContent!.replace(/\s+/g, ' ').trim());

  it('shows number, time, customer, phone, zone, total, status and courier of every order', () => {
    const rows = text('[data-test="order-row"]');
    expect(rows.length).toBe(2);
    expect(rows[0]).toContain('W-000001'); expect(rows[0]).toContain('منى'); expect(rows[0]).toContain('01012345678'); expect(rows[0]).toContain('القاهرة'); expect(rows[0]).toContain('orders.status.new');
    expect(rows[1]).toContain('أحمد'); expect(rows[1]).toContain('orders.status.out_for_delivery');
  });

  it('tabs show the count of every status and the total on "all"', () => {
    const tabs = Object.fromEntries(Array.from(fixture.nativeElement.querySelectorAll('[data-tab]')).map((el: any) => [el.dataset.tab, el.textContent.replace(/\s+/g, ' ').trim()]));
    expect(tabs['all']).toContain('5');
    expect(tabs['new']).toContain('1');
    expect(tabs['delivered']).toContain('3');
    expect(tabs['refused']).toContain('0');
    expect(Object.keys(tabs).length).toBe(11); // all + the ten statuses (Online Stage 5A added ready_for_pickup and picked_up)
    expect(tabs['ready_for_pickup']).toContain('0');
  });

  it('Stage 5A: fulfillment and payment show in every row; a pickup order has no zone', () => {
    component.reload();
    listRequests()[0].flush(response([
      row({ id: 'o3', number: 'W-000003', fulfillment: 'pickup', zone: null, paymentMethod: 'instapay', paymentStatus: 'unpaid', needsTransfer: true }),
      row({ id: 'o4', number: 'W-000004', paymentMethod: 'vodafone_cash', paymentStatus: 'verified' }),
    ]));
    fixture.detectChanges();
    const rows = text('[data-test="order-row"]');
    expect(rows[0]).toContain('orders.fulfillment.pickup'); expect(rows[0]).toContain('orders.method.instapay'); expect(rows[0]).toContain('orders.payment.unpaid');
    expect(rows[1]).toContain('orders.fulfillment.delivery'); expect(rows[1]).toContain('orders.method.vodafone_cash'); expect(rows[1]).toContain('orders.payment.verified');
  });

  it('Stage 5A: the fulfillment, payment-method and "needs transfer confirmation" filters go to the server', () => {
    component.fulfillment.set('pickup');
    component.paymentMethod.set('instapay');
    component.needsTransfer.set(true);
    component.reload();
    const [request] = listRequests();
    expect(request.request.params.get('fulfillment')).toBe('pickup');
    expect(request.request.params.get('paymentMethod')).toBe('instapay');
    expect(request.request.params.get('needsTransfer')).toBe('1');
    request.flush(response([]));
    component.fulfillment.set(''); component.paymentMethod.set(''); component.needsTransfer.set(false);
    component.reload();
    const [cleared] = listRequests();
    expect(cleared.request.params.has('fulfillment')).toBeFalse();
    expect(cleared.request.params.has('paymentMethod')).toBeFalse();
    expect(cleared.request.params.has('needsTransfer')).toBeFalse();
    cleared.flush(response([]));
  });

  it('a status tab, the search, the dates and the courier filter go to the server as query parameters', () => {
    fixture.nativeElement.querySelector('[data-tab="new"]').click();
    let [request] = listRequests();
    expect(request.request.params.get('status')).toBe('new');
    request.flush(response([row({})]));

    component.q.set('منى');
    component.from.set('2026-11-01');
    component.to.set('2026-11-30');
    component.courierId.set('c1');
    component.reload();
    [request] = listRequests();
    expect(request.request.params.get('status')).toBe('new');
    expect(request.request.params.get('q')).toBe('منى');
    expect(request.request.params.get('from')).toBe('2026-11-01');
    expect(request.request.params.get('to')).toBe('2026-11-30');
    expect(request.request.params.get('courierId')).toBe('c1');
    expect(request.request.params.get('page')).toBe('1');
    request.flush(response([]));
    fixture.detectChanges();
    expect(text('[data-test="order-row"]').length).toBe(0);
    expect(fixture.nativeElement.textContent).toContain('orders.empty');
  });

  it('an error shows a retry; retry asks again', () => {
    component.reload();
    listRequests()[0].flush('x', { status: 500, statusText: 'Server Error' });
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.ol__alert')).not.toBeNull();
    component.reload();
    listRequests()[0].flush(response([]));
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.ol__alert')).toBeNull();
  });
});
