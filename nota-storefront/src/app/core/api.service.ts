import { Injectable, NgZone, PLATFORM_ID, TransferState, inject, makeStateKey } from '@angular/core';
import { isPlatformServer } from '@angular/common';
import { storage } from './storage';
import {
  Category, Customer, LineProblem, OrderRequest, OrderView, Page, Product, Quote, StoreSettings, Zone, Address,
} from './models';

export const TOKEN_KEY = 'nota.store.token';

/** A failed API call. status 0 = the API did not answer (network, timeout); the server renders those as 503. */
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public data: Record<string, unknown> = {},
  ) { super(message); }
  get lines(): LineProblem[] { return Array.isArray(this.data['lines']) ? (this.data['lines'] as LineProblem[]) : []; }
  get unreachable(): boolean { return this.status === 0 || this.status >= 500 && this.code !== 'STORE_CLOSED'; }
}

/** One in-memory cache for the whole server process (not per request): a crawler or a busy hour must not hit the backend per page view. */
const serverCache = new Map<string, { exp: number; value: unknown }>();
const SERVER_TIMEOUT_MS = 3000;
const BROWSER_TIMEOUT_MS = 15000;

export const apiBase = (server: boolean): string => {
  if (!server) return '/api/store';
  const internal = (typeof process !== 'undefined' && process.env['NOTA_API_INTERNAL']) || 'http://127.0.0.1:5000';
  return `${internal.replace(/\/+$/, '')}/api/store`;
};

export interface GetOptions { ttl?: number; auth?: boolean }

@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly server = isPlatformServer(inject(PLATFORM_ID));
  private readonly transfer = inject(TransferState);
  private readonly zone = inject(NgZone);
  readonly base = apiBase(this.server);

  private async request<T>(method: string, path: string, body?: unknown, auth = false): Promise<T> {
    // AbortSignal.timeout, not setTimeout: a pending zone timer would hold the server render open until it fires (3 s).
    const signal = AbortSignal.timeout(this.server ? SERVER_TIMEOUT_MS : BROWSER_TIMEOUT_MS);
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (auth) {
      const token = storage.get(TOKEN_KEY);
      if (token) headers['Authorization'] = `Bearer ${token}`;
    }
    let response: Response;
    try {
      // Outside the Angular zone: Node's fetch (undici) keeps the socket alive with a ~3 s timer, and a timer created inside the zone
      // makes the server wait for it before it sends the page (every uncached render took 3 s). The callers await the result themselves
      // (route resolvers and the app initializer), so the render still waits for the data.
      response = await this.zone.runOutsideAngular(() => fetch(`${this.base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal }));
    } catch {
      throw new ApiError(0, 'UNREACHABLE', 'unreachable');
    }
    const text = await response.text();
    let json: Record<string, unknown> = {};
    try { json = text ? JSON.parse(text) : {}; } catch { /* not json */ }
    if (!response.ok) {
      throw new ApiError(response.status, String(json['code'] || `HTTP_${response.status}`), String(json['message'] || ''), json);
    }
    return json as T;
  }

  /** GET. On the server: cached for `ttl` seconds in memory and handed to the browser through TransferState so it does not refetch. */
  async get<T>(path: string, { ttl = 0, auth = false }: GetOptions = {}): Promise<T> {
    if (auth) return this.request<T>('GET', path, undefined, true);
    const key = makeStateKey<T>(`api:${path}`);
    if (!this.server) {
      if (this.transfer.hasKey(key)) {
        const value = this.transfer.get(key, null as T);
        this.transfer.remove(key); // only the first read after hydration; later reads are fresh
        return value;
      }
      return this.request<T>('GET', path);
    }
    const hit = serverCache.get(path);
    if (hit && hit.exp > Date.now()) {
      this.transfer.set(key, hit.value as T);
      return hit.value as T;
    }
    const value = await this.request<T>('GET', path);
    if (ttl > 0) serverCache.set(path, { exp: Date.now() + ttl * 1000, value });
    this.transfer.set(key, value);
    return value;
  }

  // --- catalog (public)
  settings(): Promise<StoreSettings> { return this.get<StoreSettings>('/settings', { ttl: 30 }); }
  categories(): Promise<{ data: Category[] }> { return this.get('/categories', { ttl: 30 }); }
  zones(): Promise<{ data: Zone[] }> { return this.get('/delivery-zones', { ttl: 30 }); }
  product(id: string): Promise<Product> { return this.get<Product>(`/products/${encodeURIComponent(id)}`, { ttl: 15 }); }
  related(id: string): Promise<{ data: Product[] }> { return this.get(`/products/${encodeURIComponent(id)}/related`, { ttl: 30 }); }
  products(query: { page?: number; limit?: number; category?: string; q?: string; sort?: string } = {}): Promise<Page<Product>> {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== '' && v !== null) params.set(k, String(v));
    const qs = params.toString();
    return this.get(`/products${qs ? `?${qs}` : ''}`, { ttl: 15 });
  }

  // --- orders
  quote(order: OrderRequest, withAuth: boolean): Promise<Quote> { return this.request('POST', '/orders/quote', order, withAuth); }
  placeOrder(order: OrderRequest & { idempotencyKey: string }, withAuth: boolean): Promise<OrderView> { return this.request('POST', '/orders', order, withAuth); }
  track(token: string): Promise<OrderView> { return this.request('GET', `/orders/track/${encodeURIComponent(token)}`); }

  // --- customer
  register(body: { name: string; phone: string; password: string }): Promise<{ token: string; customer: Customer }> { return this.request('POST', '/auth/register', body); }
  login(body: { phone: string; password: string }): Promise<{ token: string; customer: Customer }> { return this.request('POST', '/auth/login', body); }
  me(): Promise<Customer> { return this.request('GET', '/me', undefined, true); }
  updateMe(body: { name?: string; newPassword?: string }): Promise<Customer & { token?: string }> { return this.request('PUT', '/me', body, true); }
  addresses(): Promise<{ data: Address[] } | Address[]> { return this.request('GET', '/me/addresses', undefined, true); }
  addAddress(body: Partial<Address>): Promise<Record<string, unknown>> { return this.request('POST', '/me/addresses', body, true); }
  updateAddress(id: string, body: Partial<Address>): Promise<Record<string, unknown>> { return this.request('PUT', `/me/addresses/${id}`, body, true); }
  deleteAddress(id: string): Promise<Record<string, unknown>> { return this.request('DELETE', `/me/addresses/${id}`, undefined, true); }
  myOrders(page = 1): Promise<Page<OrderView>> { return this.request('GET', `/me/orders?page=${page}`, undefined, true); }
  myOrder(id: string): Promise<OrderView> { return this.request('GET', `/me/orders/${encodeURIComponent(id)}`, undefined, true); }
  cancelOrder(id: string): Promise<OrderView> { return this.request('POST', `/me/orders/${encodeURIComponent(id)}/cancel`, {}, true); }
}
