import ar from '../../../assets/i18n/ar.json';
import { invoiceHintKey, itemsCountKey, mobilePillClass, orderSteps, timeAgo } from './mobile-utils';

describe('mobile utils (Online Stage 6A)', () => {
  it('order steps: delivery and pickup labels, progress by status, closed orders have none', () => {
    expect(orderSteps({ status: 'new', fulfillment: 'delivery' })).toEqual(jasmine.objectContaining({ done: 1, closed: false }));
    expect(orderSteps({ status: 'confirmed', fulfillment: 'delivery' }).done).toBe(2);
    expect(orderSteps({ status: 'preparing', fulfillment: 'delivery' }).done).toBe(2);
    expect(orderSteps({ status: 'out_for_delivery', fulfillment: 'delivery' }).done).toBe(3);
    expect(orderSteps({ status: 'delivered', fulfillment: 'delivery' }).done).toBe(4);
    expect(orderSteps({ status: 'ready_for_pickup', fulfillment: 'pickup' }).done).toBe(3);
    expect(orderSteps({ status: 'picked_up', fulfillment: 'pickup' }).done).toBe(4);
    expect(orderSteps({ status: 'cancelled', fulfillment: 'delivery' })).toEqual(jasmine.objectContaining({ done: 0, closed: true }));
    expect(orderSteps({ status: 'rejected' }).closed).toBeTrue();

    expect(orderSteps({ status: 'new', fulfillment: 'delivery' }).keys[2]).toBe('mobile.order.steps.onTheWay');
    expect(orderSteps({ status: 'new', fulfillment: 'pickup' }).keys[2]).toBe('mobile.order.steps.ready');
  });

  it('the invoice hint follows the real rule: at dispatch (delivery) or at pickup, never "when you accept"', () => {
    expect(invoiceHintKey({ status: 'new', fulfillment: 'delivery' })).toBe('mobile.order.invoiceHintDelivery');
    expect(invoiceHintKey({ status: 'preparing', fulfillment: 'delivery' })).toBe('mobile.order.invoiceHintDelivery');
    expect(invoiceHintKey({ status: 'ready_for_pickup', fulfillment: 'pickup' })).toBe('mobile.order.invoiceHintPickup');
    expect(invoiceHintKey({ status: 'out_for_delivery', fulfillment: 'delivery' })).toBeNull();
    expect(invoiceHintKey({ status: 'delivered', fulfillment: 'delivery' })).toBeNull();
    expect(invoiceHintKey({ status: 'cancelled', fulfillment: 'delivery' })).toBeNull();
  });

  it('status pill variants map to the three phone pill colours', () => {
    expect(mobilePillClass('ok')).toContain('m-pill--ok');
    expect(mobilePillClass('due')).toContain('m-pill--warn');
    expect(mobilePillClass('overdue')).toContain('m-pill--warn');
    expect(mobilePillClass('info')).toContain('m-pill--muted');
  });

  it('time ago is at least one minute and rounds up to hours and days', () => {
    const now = Date.parse('2026-11-16T12:00:00Z');
    expect(timeAgo('2026-11-16T11:59:50Z', 'en', now)).toBe('1 minute ago');
    expect(timeAgo('2026-11-16T11:30:00Z', 'en', now)).toBe('30 minutes ago');
    expect(timeAgo('2026-11-16T09:00:00Z', 'en', now)).toBe('3 hours ago');
    expect(timeAgo('2026-11-14T12:00:00Z', 'en', now)).toBe('2 days ago');
    expect(timeAgo('not a date', 'en', now)).toBe('');
  });
});

describe('itemsCountKey (Arabic count forms)', () => {
  it('picks the form for 1, 2, 3–10 and 11+', () => {
    expect(itemsCountKey(1)).toBe('mobile.home.itemsOne');
    expect(itemsCountKey(2)).toBe('mobile.home.itemsTwo');
    for (const n of [3, 4, 10]) expect(itemsCountKey(n)).toBe('mobile.home.itemsFew');
    for (const n of [11, 12, 25, 100]) expect(itemsCountKey(n)).toBe('mobile.home.itemsMany');
  });

  it('the Arabic texts read right for each form', () => {
    const texts = ar.mobile.home as Record<string, string>;
    const text = (count: number) => (texts[itemsCountKey(count).split('.').pop()!] as string).replace('{{count}}', String(count));
    expect([1, 2, 3, 10, 11].map(text)).toEqual(['صنف واحد', 'صنفين', '3 أصناف', '10 أصناف', '11 صنف']);
  });
});
