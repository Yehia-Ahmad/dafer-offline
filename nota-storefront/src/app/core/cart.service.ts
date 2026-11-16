import { Injectable, computed, signal } from '@angular/core';
import { LineProblem, Product } from './models';
import { storage } from './storage';

export const CART_KEY = 'nota.store.cart';
export const MAX_QTY = 99;

/** A cart line. Only the id and quantity are ever sent to the server; name / price / image are for display until it re-prices. */
export interface CartLine {
  productId: string;
  qty: number;
  name: string;
  price: number;
  image: string | null;
  slug: string;
  /** The last-seen maxOrderQty (caps the stepper). */
  max: number;
}

export const clampQty = (qty: number, max: number): number => {
  const cap = Math.max(1, Math.min(MAX_QTY, Math.floor(max) || MAX_QTY));
  if (!Number.isFinite(qty)) return 1;
  return Math.max(1, Math.min(cap, Math.floor(qty)));
};

/**
 * The cart lives in the browser only. `load()` is called after the first render in the browser (so server and browser render the same
 * empty cart first and hydration matches); on the server nothing here touches storage.
 */
@Injectable({ providedIn: 'root' })
export class CartService {
  private readonly state = signal<CartLine[]>([]);
  readonly lines = this.state.asReadonly();
  readonly count = computed(() => this.state().reduce((sum, line) => sum + line.qty, 0));
  readonly subtotal = computed(() => Math.round(this.state().reduce((sum, line) => sum + line.price * line.qty, 0) * 100) / 100);
  readonly isEmpty = computed(() => this.state().length === 0);
  /** Problems the server reported for lines (409 ORDER_ITEMS_INVALID), by product id. */
  readonly problems = signal<Record<string, LineProblem>>({});

  load(): void {
    const stored = storage.getJson<CartLine[]>(CART_KEY);
    if (!Array.isArray(stored)) return;
    const seen = new Set<string>();
    const lines = stored.filter((line) => {
      const ok = line && typeof line.productId === 'string' && /^[0-9a-f]{24}$/.test(line.productId) && Number.isInteger(line.qty) && line.qty > 0 && !seen.has(line.productId);
      if (ok) seen.add(line.productId);
      return ok;
    }).map((line) => ({ ...line, qty: clampQty(line.qty, line.max || MAX_QTY), max: line.max || MAX_QTY }));
    this.state.set(lines);
  }

  private commit(lines: CartLine[]): void {
    this.state.set(lines);
    storage.setJson(CART_KEY, lines);
  }

  /** Adds `qty`, merging with an existing line and never going over the product's maxOrderQty. Returns the quantity now in the cart. */
  add(product: Product, qty = 1): number {
    const max = product.maxOrderQty > 0 ? product.maxOrderQty : 0;
    if (max === 0 || product.availability === 'out_of_stock') return this.qtyOf(product.id);
    const existing = this.state().find((line) => line.productId === product.id);
    const image = product.images?.[0] ?? null;
    if (existing) {
      const next = clampQty(existing.qty + qty, max);
      this.commit(this.state().map((line) => (line.productId === product.id ? { ...line, qty: next, max, price: product.finalPrice, name: product.name, image, slug: product.slug } : line)));
      return next;
    }
    const next = clampQty(qty, max);
    this.commit([...this.state(), { productId: product.id, qty: next, name: product.name, price: product.finalPrice, image, slug: product.slug, max }]);
    return next;
  }

  qtyOf(productId: string): number { return this.state().find((line) => line.productId === productId)?.qty ?? 0; }

  setQty(productId: string, qty: number): void {
    this.commit(this.state().map((line) => (line.productId === productId ? { ...line, qty: clampQty(qty, line.max) } : line)));
    this.clearProblem(productId);
  }

  /** The fix action for "quantity over stock": lower the line to what the server says is left. */
  setMax(productId: string, max: number): void {
    if (max < 1) { this.remove(productId); return; }
    this.commit(this.state().map((line) => (line.productId === productId ? { ...line, max, qty: Math.min(line.qty, max) } : line)));
    this.clearProblem(productId);
  }

  remove(productId: string): void {
    this.commit(this.state().filter((line) => line.productId !== productId));
    this.clearProblem(productId);
  }

  clear(): void {
    this.commit([]);
    this.problems.set({});
  }

  /** Display-only refresh after the server priced the cart. */
  refreshDisplay(items: { productId: string; unitPrice: number; name: string }[]): void {
    const byId = new Map(items.map((item) => [item.productId, item]));
    const next = this.state().map((line) => { const hit = byId.get(line.productId); return hit ? { ...line, price: hit.unitPrice, name: hit.name } : line; });
    if (JSON.stringify(next) !== JSON.stringify(this.state())) this.commit(next);
  }

  setProblems(lines: LineProblem[]): void {
    this.problems.set(Object.fromEntries(lines.map((line) => [line.productId, line])));
  }

  private clearProblem(productId: string): void {
    const { [productId]: _gone, ...rest } = this.problems();
    this.problems.set(rest);
  }

  /** The request body items: ids and quantities only. */
  requestItems(): { productId: string; qty: number }[] {
    return this.state().map((line) => ({ productId: line.productId, qty: line.qty }));
  }
}
