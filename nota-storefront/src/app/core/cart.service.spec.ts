import { TestBed } from '@angular/core/testing';
import { CART_KEY, CartService, MAX_QTY, clampQty } from './cart.service';
import { Product } from './models';
import { storage } from './storage';

const product = (over: Partial<Product> = {}): Product => ({
  id: 'a'.repeat(24), name: 'لمبة', slug: 'لمبة', category: { id: 'c'.repeat(24), name: 'قسم' }, price: 100, discountPercentage: 0, finalPrice: 100,
  images: ['/api/store/images/product/x/0'], availability: 'in_stock', maxOrderQty: 5, ...over,
});

describe('CartService', () => {
  let cart: CartService;
  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({});
    cart = TestBed.inject(CartService);
  });

  it('adds a product and counts quantities', () => {
    cart.add(product(), 2);
    expect(cart.count()).toBe(2);
    expect(cart.lines()[0].qty).toBe(2);
    expect(cart.subtotal()).toBe(200);
  });

  it('merges the same product into one line', () => {
    cart.add(product(), 1);
    cart.add(product(), 2);
    expect(cart.lines().length).toBe(1);
    expect(cart.qtyOf('a'.repeat(24))).toBe(3);
  });

  it('never goes over the product maxOrderQty (and never over 99)', () => {
    cart.add(product({ maxOrderQty: 5 }), 4);
    expect(cart.add(product({ maxOrderQty: 5 }), 4)).toBe(5);
    cart.setQty('a'.repeat(24), 50);
    expect(cart.qtyOf('a'.repeat(24))).toBe(5);
    expect(clampQty(1000, 500)).toBe(MAX_QTY);
    expect(clampQty(0, 5)).toBe(1);
    expect(clampQty(NaN, 5)).toBe(1);
  });

  it('does not add an out-of-stock product', () => {
    cart.add(product({ availability: 'out_of_stock', maxOrderQty: 0 }), 1);
    expect(cart.isEmpty()).toBeTrue();
  });

  it('the request items are ids and quantities only', () => {
    cart.add(product({ finalPrice: 1 }), 2);
    expect(cart.requestItems()).toEqual([{ productId: 'a'.repeat(24), qty: 2 }]);
  });

  it('setMax lowers a line to the server value, or removes it at zero', () => {
    cart.add(product({ maxOrderQty: 9 }), 8);
    cart.setMax('a'.repeat(24), 3);
    expect(cart.qtyOf('a'.repeat(24))).toBe(3);
    cart.setMax('a'.repeat(24), 0);
    expect(cart.isEmpty()).toBeTrue();
  });

  it('persists to localStorage and load() restores it, dropping invalid or duplicate rows', () => {
    cart.add(product(), 2);
    expect(JSON.parse(localStorage.getItem(CART_KEY)!)[0].qty).toBe(2);
    const good = { productId: 'b'.repeat(24), qty: 1, name: 'x', price: 5, image: null, slug: 'x', max: 9 };
    storage.setJson(CART_KEY, [good, good, { productId: 'bad', qty: 1 }, { productId: 'c'.repeat(24), qty: -2 }, null]);
    const fresh = TestBed.inject(CartService);
    fresh.load();
    expect(fresh.lines().map((l) => l.productId)).toEqual(['b'.repeat(24)]);
  });

  it('is safe without storage (private window / server): nothing throws and the cart still works in memory', () => {
    spyOn(Storage.prototype, 'getItem').and.throwError('blocked');
    spyOn(Storage.prototype, 'setItem').and.throwError('blocked');
    expect(() => cart.load()).not.toThrow();
    expect(() => cart.add(product(), 1)).not.toThrow();
    expect(cart.count()).toBe(1);
  });

  it('storage is a no-op when there is no window (server rendering)', () => {
    spyOnProperty(window, 'localStorage', 'get').and.returnValue(undefined as unknown as Storage);
    expect(storage.get(CART_KEY)).toBeNull();
    expect(() => storage.set(CART_KEY, 'x')).not.toThrow();
    expect(storage.getJson(CART_KEY)).toBeNull();
  });

  it('keeps the server problems by product and clears one when its line is fixed', () => {
    cart.add(product(), 3);
    cart.setProblems([{ productId: 'a'.repeat(24), reason: 'quantity_exceeds_stock', max: 2 }]);
    expect(cart.problems()['a'.repeat(24)].max).toBe(2);
    cart.setMax('a'.repeat(24), 2);
    expect(cart.problems()['a'.repeat(24)]).toBeUndefined();
  });
});
