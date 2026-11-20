// Online Stage 7A: the events the storefront sends to the Meta and TikTok pixels, as pure data.
// Only product ids, quantities, values, the currency and the order number ever leave: no name, phone, e-mail or address (hashed or not).
export const CURRENCY = 'EGP';

export interface PixelLine { id: string; qty: number; price?: number }

export type PixelEvent =
  | { name: 'PageView' }
  | { name: 'ViewContent'; id: string; value: number }
  | { name: 'AddToCart'; id: string; value: number; qty: number }
  | { name: 'InitiateCheckout'; lines: PixelLine[]; value: number }
  | { name: 'Purchase'; lines: PixelLine[]; value: number; orderNumber: string };

const round = (value: number): number => Math.round(value * 100) / 100;
const count = (lines: PixelLine[]): number => lines.reduce((sum, line) => sum + line.qty, 0);

export interface MetaCall { name: string; params?: Record<string, unknown>; options?: { eventID: string } }
export interface TikTokCall { name: string; params?: Record<string, unknown>; options?: { event_id: string } }

/** fbq('track', name, params, options). Purchase carries `contents`, `content_type`, `value`, `currency` and eventID = the order number. */
export const metaCall = (event: PixelEvent): MetaCall => {
  switch (event.name) {
    case 'PageView':
      return { name: 'PageView' };
    case 'ViewContent':
      return { name: 'ViewContent', params: { content_ids: [event.id], contents: [{ id: event.id, quantity: 1 }], content_type: 'product', value: round(event.value), currency: CURRENCY } };
    case 'AddToCart':
      return { name: 'AddToCart', params: { content_ids: [event.id], contents: [{ id: event.id, quantity: event.qty }], content_type: 'product', value: round(event.value), currency: CURRENCY } };
    case 'InitiateCheckout':
      return { name: 'InitiateCheckout', params: { content_ids: event.lines.map((l) => l.id), contents: event.lines.map((l) => ({ id: l.id, quantity: l.qty })), content_type: 'product', num_items: count(event.lines), value: round(event.value), currency: CURRENCY } };
    case 'Purchase':
      return {
        name: 'Purchase',
        params: { content_ids: event.lines.map((l) => l.id), contents: event.lines.map((l) => ({ id: l.id, quantity: l.qty })), content_type: 'product', num_items: count(event.lines), value: round(event.value), currency: CURRENCY },
        options: { eventID: event.orderNumber },
      };
  }
};

const tiktokContent = (id: string, quantity: number, price?: number): Record<string, unknown> => ({ content_id: id, content_type: 'product', quantity, ...(price !== undefined ? { price: round(price) } : {}) });

/** ttq.track(name, params, options). TikTok's current standard names; the purchase event is "Purchase" (the older "CompletePayment" is its legacy name). */
export const tiktokCall = (event: PixelEvent): TikTokCall => {
  switch (event.name) {
    case 'PageView':
      return { name: 'PageView' }; // sent with ttq.page(), see PixelsService
    case 'ViewContent':
      return { name: 'ViewContent', params: { contents: [tiktokContent(event.id, 1)], content_type: 'product', value: round(event.value), currency: CURRENCY } };
    case 'AddToCart':
      return { name: 'AddToCart', params: { contents: [tiktokContent(event.id, event.qty)], content_type: 'product', value: round(event.value), currency: CURRENCY } };
    case 'InitiateCheckout':
      return { name: 'InitiateCheckout', params: { contents: event.lines.map((l) => tiktokContent(l.id, l.qty, l.price)), content_type: 'product', value: round(event.value), currency: CURRENCY } };
    case 'Purchase':
      return {
        name: 'Purchase',
        params: { contents: event.lines.map((l) => tiktokContent(l.id, l.qty, l.price)), content_type: 'product', value: round(event.value), currency: CURRENCY },
        options: { event_id: event.orderNumber },
      };
  }
};
