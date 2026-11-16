import { CheckoutForm, joinAddress, orderRequest, quoteRequest, validateCheckout } from './checkout-form';

const form = (over: Partial<CheckoutForm> = {}): CheckoutForm => ({
  name: 'عميل', phone: '01012345678', fulfillment: 'delivery', zoneId: 'z1', address: 'شارع 1', landmark: '', notes: '', addressId: '', paymentMethod: 'cod', ...over,
});
const items = [{ productId: 'a'.repeat(24), qty: 2 }];

describe('checkout form validation', () => {
  it('accepts a complete delivery order', () => {
    expect(validateCheckout(form(), { signedIn: false, itemCount: 1 })).toEqual({});
  });

  it('asks for name, phone, zone and address on delivery', () => {
    const errors = validateCheckout(form({ name: ' ', phone: '', zoneId: '', address: '' }), { signedIn: false, itemCount: 1 });
    expect(Object.keys(errors).sort()).toEqual(['address', 'name', 'phone', 'zone']);
  });

  it('rejects a non-Egyptian phone', () => {
    expect(validateCheckout(form({ phone: '12345' }), { signedIn: false, itemCount: 1 }).phone).toBeTruthy();
  });

  it('pickup needs no zone and no address', () => {
    expect(validateCheckout(form({ fulfillment: 'pickup', zoneId: '', address: '' }), { signedIn: false, itemCount: 1 })).toEqual({});
  });

  it('a signed-in customer with a saved address needs no name, phone or street (but still a zone)', () => {
    const errors = validateCheckout(form({ name: '', phone: '', address: '', addressId: 'ad1' }), { signedIn: true, itemCount: 1 });
    expect(errors).toEqual({});
    expect(validateCheckout(form({ name: '', phone: '', address: '', addressId: 'ad1', zoneId: '' }), { signedIn: true, itemCount: 1 }).zone).toBeTruthy();
    // a guest cannot use a saved address
    expect(validateCheckout(form({ name: '', addressId: 'ad1' }), { signedIn: false, itemCount: 1 }).name).toBeTruthy();
  });

  it('an empty cart is an error', () => {
    expect(validateCheckout(form(), { signedIn: false, itemCount: 0 }).items).toBeTruthy();
  });
});

describe('checkout requests', () => {
  it('the quote carries ids, quantities, fulfillment, payment and zone only: no contact, no prices', () => {
    const q = quoteRequest(form({ paymentMethod: 'instapay' }), items, false) as unknown as Record<string, unknown>;
    expect(q['items']).toEqual(items);
    expect(q['zoneId']).toBe('z1');
    expect(q['paymentMethod']).toBe('instapay');
    expect(q['contact']).toBeUndefined();
    expect(JSON.stringify(q)).not.toMatch(/price|total/i);
  });

  it('pickup sends no zone', () => {
    expect(quoteRequest(form({ fulfillment: 'pickup' }), items, false).zoneId).toBeUndefined();
  });

  it('the order joins street and landmark into one address', () => {
    const o = orderRequest(form({ landmark: 'جنب الصيدلية' }), items, false);
    expect(o.contact?.address).toBe('شارع 1 - علامة مميزة: جنب الصيدلية');
    expect(joinAddress(' x ', '')).toBe('x');
    expect(joinAddress('x'.repeat(600), '').length).toBe(500);
  });

  it('a saved address is sent as addressId, with only the notes as contact', () => {
    const o = orderRequest(form({ addressId: 'ad1', notes: ' بعد الظهر ' }), items, true);
    expect(o.addressId).toBe('ad1');
    expect(o.contact).toEqual({ name: '', phone: '', notes: 'بعد الظهر' });
  });
});
