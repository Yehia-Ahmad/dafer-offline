import { TestBed } from '@angular/core/testing';
import { ApiError, ApiService } from './api.service';
import { CHECKOUT_KEY, CheckoutService, mapFailure, newKey } from './checkout.service';
import { OrderRequest, OrderView } from './models';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const request: OrderRequest = { items: [{ productId: 'a'.repeat(24), qty: 1 }], fulfillment: 'pickup', paymentMethod: 'cod' };
const placed = { id: '1', number: 'W-1', trackingToken: 'tok' } as OrderView;

describe('CheckoutService (idempotency key)', () => {
  let api: { placeOrder: jasmine.Spy; quote: jasmine.Spy };
  let service: CheckoutService;

  beforeEach(() => {
    localStorage.clear();
    api = { placeOrder: jasmine.createSpy('placeOrder'), quote: jasmine.createSpy('quote') };
    TestBed.configureTestingModule({ providers: [{ provide: ApiService, useValue: api }] });
    service = TestBed.inject(CheckoutService);
  });

  it('makes a valid UUID v4 key and keeps it until the order succeeds', () => {
    const key = service.key();
    expect(key).toMatch(UUID);
    expect(service.key()).toBe(key);
    expect(localStorage.getItem(CHECKOUT_KEY)).toBe(key);
    expect(newKey()).not.toBe(newKey());
  });

  it('a retry after a network failure sends the SAME key (so the server cannot create two orders)', async () => {
    api.placeOrder.and.rejectWith(new ApiError(0, 'UNREACHABLE', ''));
    await expectAsync(service.place(request, false)).toBeRejected();
    const first = api.placeOrder.calls.mostRecent().args[0].idempotencyKey;
    api.placeOrder.and.resolveTo(placed);
    await service.place(request, false);
    expect(api.placeOrder.calls.mostRecent().args[0].idempotencyKey).toBe(first);
  });

  it('a validation failure (409 / 400) also keeps the key: nothing was created', async () => {
    api.placeOrder.and.rejectWith(new ApiError(409, 'ORDER_ITEMS_INVALID', '', { lines: [] }));
    await expectAsync(service.place(request, false)).toBeRejected();
    const first = service.key();
    await expectAsync(service.place(request, false)).toBeRejected();
    expect(service.key()).toBe(first);
  });

  it('two clicks at once send the same key', async () => {
    api.placeOrder.and.resolveTo(placed);
    await Promise.all([service.place(request, false), service.place(request, false)]);
    const keys = api.placeOrder.calls.allArgs().map((a) => a[0].idempotencyKey);
    expect(new Set(keys).size).toBe(1);
  });

  it('success clears the key, so the next checkout starts a new attempt', async () => {
    api.placeOrder.and.resolveTo(placed);
    const key = service.key();
    await service.place(request, false);
    expect(localStorage.getItem(CHECKOUT_KEY)).toBeNull();
    expect(service.key()).not.toBe(key);
  });

  it('IDEMPOTENCY_MISMATCH (the key belonged to a different body) retries once with a new key', async () => {
    api.placeOrder.and.callFake(async (body: { idempotencyKey: string }) => {
      if (api.placeOrder.calls.count() === 1) throw new ApiError(409, 'IDEMPOTENCY_MISMATCH', '');
      return { ...placed, number: body.idempotencyKey };
    });
    const old = service.key();
    const order = await service.place(request, false);
    expect(api.placeOrder.calls.count()).toBe(2);
    expect(order.number).not.toBe(old);
  });

  it('IDEMPOTENCY_MISMATCH twice is shown, not looped', async () => {
    api.placeOrder.and.rejectWith(new ApiError(409, 'IDEMPOTENCY_MISMATCH', ''));
    await expectAsync(service.place(request, false)).toBeRejected();
    expect(api.placeOrder.calls.count()).toBe(2);
  });
});

describe('mapFailure (the server 409 line problems)', () => {
  it('maps ORDER_ITEMS_INVALID to per-line problems, with the max for a quantity over stock', () => {
    const lines = [{ productId: 'a'.repeat(24), reason: 'quantity_exceeds_stock', max: 3 }, { productId: 'b'.repeat(24), reason: 'not_available' }];
    const failure = mapFailure(new ApiError(409, 'ORDER_ITEMS_INVALID', 'x', { lines }));
    expect(failure.code).toBe('ORDER_ITEMS_INVALID');
    expect(failure.lines).toEqual(lines as never);
  });

  it('maps the other business errors to Arabic messages and keeps the minimum order amount', () => {
    expect(mapFailure(new ApiError(409, 'ORDERING_DISABLED', '')).message).toContain('متوقف');
    const min = mapFailure(new ApiError(409, 'MIN_ORDER_NOT_REACHED', '', { minOrderAmount: 500 }));
    expect(min.minOrderAmount).toBe(500);
    expect(min.message).toBeTruthy();
  });

  it('an unreachable API and an unknown error both get a safe message', () => {
    expect(mapFailure(new ApiError(0, 'UNREACHABLE', '')).message).toBeTruthy();
    expect(mapFailure(new Error('boom')).code).toBe('default');
  });
});
