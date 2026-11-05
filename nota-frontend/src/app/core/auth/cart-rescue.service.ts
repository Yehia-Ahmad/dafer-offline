import { Injectable } from '@angular/core';

/**
 * Stage 15: when the session expires (401) while the POS has an open invoice, the invoice is kept
 * in memory (this window only, never in storage). When the same user signs in again, the POS puts
 * it back ("رجعنالك الفاتورة اللي كانت مفتوحة"); another user gets an empty POS.
 */
@Injectable({ providedIn: 'root' })
export class CartRescueService {
  private provider: (() => unknown | null) | null = null;
  private saved: { userId: string; data: unknown } | null = null;

  /** The POS registers a snapshot function while it is open; the returned function unregisters it. */
  register(provider: () => unknown | null): () => void {
    this.provider = provider;
    return () => {
      if (this.provider === provider) this.provider = null;
    };
  }

  /** Called by the interceptor on SESSION_EXPIRED, before the session is cleared. */
  capture(userId: string | null | undefined): void {
    if (!userId || !this.provider) return;
    const data = this.provider();
    if (data) this.saved = { userId, data };
  }

  /** The kept invoice for this user (then forgotten); another user discards it. */
  take<T>(userId: string | null | undefined): T | null {
    const saved = this.saved;
    this.saved = null;
    return saved && userId && saved.userId === userId ? (saved.data as T) : null;
  }

  hasSaved(): boolean {
    return this.saved !== null;
  }
}
