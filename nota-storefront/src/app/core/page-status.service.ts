import { Injectable, RESPONSE_INIT, inject } from '@angular/core';

/**
 * The HTTP status of the server-rendered response (a no-op in the browser). 404 for a missing product / category, 503 for a
 * closed website (with X-Nota-Closed, so update.sh and Google can tell it from a failure) and for an unreachable API.
 */
@Injectable({ providedIn: 'root' })
export class PageStatus {
  private readonly init = inject(RESPONSE_INIT, { optional: true });

  private set(status: number, headers: Record<string, string> = {}): void {
    if (!this.init) return;
    this.init.status = status;
    const merged = new Headers(this.init.headers);
    for (const [k, v] of Object.entries(headers)) merged.set(k, v);
    this.init.headers = merged;
  }

  notFound(): void { this.set(404); }
  closed(): void { this.set(503, { 'X-Nota-Closed': '1', 'Retry-After': '3600', 'Cache-Control': 'no-store' }); }
  unavailable(): void { this.set(503, { 'Retry-After': '30', 'Cache-Control': 'no-store' }); }
  /** Pages that must not be indexed or cached by shared caches (cart, checkout, account, order). */
  noStore(): void { this.set(this.init?.status ?? 200, { 'Cache-Control': 'no-store' }); }
}
