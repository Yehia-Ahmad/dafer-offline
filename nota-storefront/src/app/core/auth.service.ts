import { Injectable, computed, inject, signal } from '@angular/core';
import { ApiError, ApiService, TOKEN_KEY } from './api.service';
import { Address, Customer } from './models';
import { storage } from './storage';

/** The signed-in customer. The token lives in localStorage and goes out as a Bearer header; the server never reads it. */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly api = inject(ApiService);
  readonly customer = signal<Customer | null>(null);
  readonly signedIn = computed(() => this.customer() !== null);
  /** True once the stored token was checked (so pages do not flash "sign in" before it is known). */
  readonly ready = signal(false);

  hasToken(): boolean { return !!storage.get(TOKEN_KEY); }

  /** Called after the first render in the browser. */
  async load(): Promise<void> {
    if (!this.hasToken()) { this.ready.set(true); return; }
    try {
      this.customer.set(await this.api.me());
    } catch (error) {
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) storage.remove(TOKEN_KEY);
    } finally {
      this.ready.set(true);
    }
  }

  private accept(result: { token: string; customer: Customer }): Customer {
    storage.set(TOKEN_KEY, result.token);
    this.customer.set(result.customer);
    return result.customer;
  }

  async login(phone: string, password: string): Promise<Customer> { return this.accept(await this.api.login({ phone, password })); }
  async register(name: string, phone: string, password: string): Promise<Customer> { return this.accept(await this.api.register({ name, phone, password })); }

  logout(): void {
    storage.remove(TOKEN_KEY);
    this.customer.set(null);
  }

  async refresh(): Promise<void> { this.customer.set(await this.api.me()); }

  /** A 401 anywhere means the session ended. */
  expire(): void { this.logout(); }

  addressById(id: string | null | undefined): Address | undefined { return this.customer()?.addresses.find((a) => a.id === id); }
}
