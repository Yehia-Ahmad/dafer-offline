import { PixelEvent, metaCall, tiktokCall } from './pixel-events';

const lines = [{ id: 'a'.repeat(24), qty: 2, price: 100 }, { id: 'b'.repeat(24), qty: 1, price: 50.5 }];
const events: PixelEvent[] = [
  { name: 'PageView' },
  { name: 'ViewContent', id: 'a'.repeat(24), value: 100 },
  { name: 'AddToCart', id: 'a'.repeat(24), value: 200, qty: 2 },
  { name: 'InitiateCheckout', lines, value: 250.5 },
  { name: 'Purchase', lines, value: 280.5, orderNumber: 'W-000042' },
];

// Every key that may appear in a payload. Anything else (a name, phone, e-mail, address) would fail these tests.
const ALLOWED = new Set(['content_ids', 'contents', 'content_type', 'content_id', 'quantity', 'price', 'num_items', 'value', 'currency', 'id', 'eventID', 'event_id']);
const keysOf = (value: unknown, found = new Set<string>()): Set<string> => {
  if (Array.isArray(value)) value.forEach((v) => keysOf(v, found));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) { found.add(k); keysOf(v, found); }
  return found;
};

describe('pixel events', () => {
  it('Meta: standard names, EGP, products as ids and quantities; Purchase carries the order number as eventID', () => {
    expect(events.map((e) => metaCall(e).name)).toEqual(['PageView', 'ViewContent', 'AddToCart', 'InitiateCheckout', 'Purchase']);
    const purchase = metaCall(events[4]);
    expect(purchase.params).toEqual({ content_ids: lines.map((l) => l.id), contents: [{ id: lines[0].id, quantity: 2 }, { id: lines[1].id, quantity: 1 }], content_type: 'product', num_items: 3, value: 280.5, currency: 'EGP' });
    expect(purchase.options).toEqual({ eventID: 'W-000042' });
    expect(metaCall(events[1]).options).toBeUndefined();
  });

  it('TikTok: standard names (Purchase for an order), EGP, the order number as event_id', () => {
    expect(events.slice(1).map((e) => tiktokCall(e).name)).toEqual(['ViewContent', 'AddToCart', 'InitiateCheckout', 'Purchase']);
    const purchase = tiktokCall(events[4]);
    expect(purchase.params).toEqual({ contents: [{ content_id: lines[0].id, content_type: 'product', quantity: 2, price: 100 }, { content_id: lines[1].id, content_type: 'product', quantity: 1, price: 50.5 }], content_type: 'product', value: 280.5, currency: 'EGP' });
    expect(purchase.options).toEqual({ event_id: 'W-000042' });
  });

  it('no payload holds a name, phone, e-mail or address: only ids, quantities, prices, values, currency and the order number', () => {
    for (const event of events) {
      for (const call of [metaCall(event), tiktokCall(event)]) {
        for (const key of keysOf(call.params)) expect(ALLOWED.has(key)).withContext(`${event.name}: unexpected key ${key}`).toBeTrue();
        for (const key of keysOf(call.options)) expect(ALLOWED.has(key)).toBeTrue();
        expect(JSON.stringify({ params: call.params, options: call.options })).not.toMatch(/phone|email|address|"name"|contact|01[0-9]{9}/i);
      }
    }
  });

  it('values are rounded to the piastre', () => {
    expect(metaCall({ name: 'ViewContent', id: 'x', value: 33.333333 }).params?.['value']).toBe(33.33);
  });
});
