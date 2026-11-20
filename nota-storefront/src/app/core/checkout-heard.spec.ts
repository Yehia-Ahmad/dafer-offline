import { CheckoutForm, orderRequest, quoteRequest } from './checkout-form';

const form: CheckoutForm = { name: 'منى', phone: '01012345678', fulfillment: 'delivery', zoneId: 'z1', address: 'شارع 1', landmark: '', notes: '', addressId: '', paymentMethod: 'cod' };
const items = [{ productId: 'a'.repeat(24), qty: 1 }];

describe('checkout "عرفتنا منين؟"', () => {
  it('the answer goes on the order only when chosen, never on the quote', () => {
    expect(orderRequest(form, items, false).heardFrom).toBeUndefined();
    expect(orderRequest({ ...form, heardFrom: '' }, items, false).heardFrom).toBeUndefined();
    expect(orderRequest({ ...form, heardFrom: 'فيسبوك' }, items, false).heardFrom).toBe('فيسبوك');
    expect(orderRequest({ ...form, heardFrom: 'فيسبوك', addressId: 'ad1' }, items, true).heardFrom).toBe('فيسبوك');
    expect(quoteRequest({ ...form, heardFrom: 'فيسبوك' }, items, false).heardFrom).toBeUndefined();
  });
});
