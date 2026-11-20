import { Injectable, inject } from '@angular/core';
import { ApiError, ApiService } from './api.service';
import { AttributionService } from './attribution.service';
import { SettingsStore } from './settings.store';
import { LineProblem, OrderRequest, OrderView, Quote } from './models';
import { storage } from './storage';
import { AR } from './i18n/ar';

export const CHECKOUT_KEY = 'nota.store.checkout-key';

export const newKey = (): string => {
  const c = typeof crypto !== 'undefined' ? crypto : undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (c) c.getRandomValues(bytes); else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

export interface CheckoutFailure { code: string; message: string; lines: LineProblem[]; minOrderAmount?: number }

/** Turns an API error into what the checkout shows: a message, and the per-line problems of a 409 ORDER_ITEMS_INVALID. */
export const mapFailure = (error: unknown): CheckoutFailure => {
  if (!(error instanceof ApiError)) return { code: 'default', message: AR.checkout.errors['default'], lines: [] };
  const known = AR.checkout.errors[error.code];
  const failure: CheckoutFailure = { code: error.code, message: known || (error.status === 0 ? AR.checkout.quoteFailed : AR.checkout.errors['default']), lines: error.lines };
  const min = error.data['minOrderAmount'];
  if (typeof min === 'number') failure.minOrderAmount = min;
  return failure;
};

/**
 * One idempotency key per checkout attempt. It is kept in localStorage until an order succeeds, so a double click, a retry after a
 * network failure or a reload sends the same key and the server returns the same order instead of creating a second one.
 */
@Injectable({ providedIn: 'root' })
export class CheckoutService {
  private readonly api = inject(ApiService);
  private readonly attribution = inject(AttributionService);
  private readonly settings = inject(SettingsStore);

  key(): string {
    const stored = storage.get(CHECKOUT_KEY);
    if (stored) return stored;
    const key = newKey();
    storage.set(CHECKOUT_KEY, key);
    return key;
  }

  resetKey(): void { storage.remove(CHECKOUT_KEY); }

  quote(request: OrderRequest, signedIn: boolean): Promise<Quote> { return this.api.quote(request, signedIn); }

  /**
   * Places the order. The same key is reused for every retry. Only an IDEMPOTENCY_MISMATCH (the key was used for a different body,
   * so nothing was created for this one) starts a new key, once. A success clears the key.
   */
  async place(request: OrderRequest, signedIn: boolean): Promise<OrderView> {
    // Online Stage 7A: the campaign the visitor came from (code + landing time) rides along; the server decides if it still counts.
    const attribution = this.attribution.forOrder(this.settings.settings()?.marketing?.attributionDays);
    const attempt = async (): Promise<OrderView> => this.api.placeOrder({ ...request, ...(attribution ? { attribution } : {}), idempotencyKey: this.key() }, signedIn);
    let order: OrderView;
    try {
      order = await attempt();
    } catch (error) {
      if (error instanceof ApiError && error.code === 'IDEMPOTENCY_MISMATCH') {
        this.resetKey();
        order = await attempt();
      } else {
        throw error;
      }
    }
    this.resetKey();
    return order;
  }
}
