import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { environment } from '../../../../environments/environment';
import { signInAs, signInWith } from '../../../core/auth/testing/sign-in';
import { LayoutService } from '../../../core/layout/layout.service';
import { OrderDetail, OrderStatus } from '../orders.models';
import { OrderPageComponent } from './order-page.component';

/** Online Stage 6A, MobOrder: the same actions as the desktop page, laid out for the phone. */
describe('OrderPageComponent on the phone (Online Stage 6A)', () => {
  const url = `${environment.api_base_url}orders/o1`;
  let http: HttpTestingController;
  let fixture: any;
  let component: any;
  const isMobile = signal(true);

  const line = (productId: string, name: string, unitPrice: number, qty: number) => ({ productId, name, retailPrice: unitPrice, discountPercentage: 0, unitPrice, vat: 0, vatExempt: false, qty, lineTotal: unitPrice * qty, inventoryCount: 20, reservedByOthers: 0 });
  const order = (status: OrderStatus, extra: Partial<OrderDetail> = {}): OrderDetail => ({
    id: 'o1', number: 'W-000001', status, createdAt: '2026-11-05T10:00:00Z', updatedAt: '2026-11-05T10:00:00Z',
    items: [line('p1', 'لمبة', 100, 2), line('p2', 'كابل', 50, 1)],
    subtotal: 250, vat: 0, deliveryFee: 30, total: 280, zone: { id: 'z1', name: 'القاهرة', fee: 30 },
    contact: { name: 'منى', phone: '01012345678', address: 'شارع 1', notes: '' }, reason: null, collectedAmount: null, courier: null, creditSale: null,
    fulfillment: 'delivery', paymentMethod: 'cod', payment: { status: null, verifiedAt: null, verifiedByName: null, reference: null }, invoice: null,
    whatsappTemplate: 'أهلاً {الاسم}', deliveryTime: 'خلال 24 ساعة',
    statusHistory: [{ status: 'new', at: '2026-11-05T10:00:00Z', by: 'customer', byName: null, type: 'status', note: null, details: null }], ...extra,
  });

  async function open(role: 'cashier' | string[], detail: OrderDetail) {
    isMobile.set(true);
    await TestBed.configureTestingModule({
      imports: [OrderPageComponent, TranslateModule.forRoot()],
      providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting(), provideNoopAnimations(),
        { provide: LayoutService, useValue: { isMobile } },
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: convertToParamMap({ id: 'o1' }) } } }],
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

  const el = (): HTMLElement => fixture.nativeElement;
  const bar = () => Array.from(el().querySelectorAll<HTMLElement>('[data-testid="m-order-actions"] [data-action]')).map((button) => button.dataset['action']);
  const text = (selector: string) => el().querySelector(selector)?.textContent ?? '';

  it('renders the phone layout: steps, contact card with call and WhatsApp, lines and totals', async () => {
    await open('cashier', order('new'));
    expect(el().querySelector('[data-testid="m-order"]')).not.toBeNull();
    expect(el().querySelectorAll('[data-testid="m-steps"] .m-step').length).toBe(4);
    expect(el().querySelectorAll('[data-testid="m-steps"] .m-step.is-done').length).toBe(1);
    expect(el().querySelector('[data-action="call"]')!.getAttribute('href')).toBe('tel:01012345678');
    expect(el().querySelector('[data-action="whatsapp"]')!.getAttribute('href')).toBe('https://wa.me/201012345678');
    expect(el().querySelectorAll('[data-test="order-line"]').length).toBe(2);
    expect(el().querySelector('.op__actions')).toBeNull();
  });

  it('the sticky bar offers the same actions per status as the desktop page', async () => {
    await open('cashier', order('new'));
    expect(bar()).toEqual(['confirm', 'edit', 'reject']);
    component.order.set(order('confirmed')); fixture.detectChanges();
    expect(bar()).toEqual(['prepare', 'dispatch', 'edit', 'reject', 'cancel']);
    component.order.set(order('out_for_delivery')); fixture.detectChanges();
    expect(bar()).toEqual(['deliver', 'refuse', 'changeCourier']);
    for (const status of ['delivered', 'cancelled', 'rejected', 'refused'] as OrderStatus[]) {
      component.order.set(order(status)); fixture.detectChanges();
      expect(bar()).withContext(status).toEqual([]);
    }
  });

  it('a pickup order shows the pickup steps and its own actions', async () => {
    await open('cashier', order('preparing', { fulfillment: 'pickup', zone: null }));
    expect(bar()).toEqual(['ready', 'edit', 'cancel']);
    expect(text('[data-testid="m-steps"]')).toContain('mobile.order.steps.ready');
    expect(text('[data-testid="m-steps"]')).not.toContain('mobile.order.steps.onTheWay');
  });

  it('permissions are the same: orders.view alone sees no action', async () => {
    await open(['orders.view'], order('confirmed'));
    expect(bar()).toEqual([]);
    expect(el().querySelector('[data-testid="m-order-actions"]')).toBeNull();
  });

  it('the hint states the real invoice rule, not "when you accept"', async () => {
    await open('cashier', order('new'));
    expect(text('[data-testid="invoice-hint"]')).toContain('mobile.order.invoiceHintDelivery');
    component.order.set(order('ready_for_pickup', { fulfillment: 'pickup', zone: null })); fixture.detectChanges();
    expect(text('[data-testid="invoice-hint"]')).toContain('mobile.order.invoiceHintPickup');
    component.order.set(order('out_for_delivery')); fixture.detectChanges();
    expect(el().querySelector('[data-testid="invoice-hint"]')).toBeNull();
  });

  it('confirm from the bar posts the same request as the desktop button', async () => {
    await open('cashier', order('new'));
    (el().querySelector('[data-testid="m-order-actions"] [data-action="confirm"]') as HTMLElement).click();
    http.expectOne((r) => r.url === `${url}/confirm` && r.method === 'POST').flush(order('confirmed'));
    fixture.detectChanges();
    expect(component.order().status).toBe('confirmed');
    expect(bar()).toEqual(['prepare', 'dispatch', 'edit', 'reject', 'cancel']);
  });
});
