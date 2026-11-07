import { HttpClient } from '@angular/common/http';
import { Injectable, signal } from '@angular/core';
import { Observable, tap } from 'rxjs';
import { environment } from '../../../../environments/environment';
import { ShopProfile, ShopProfilePayload } from '../models/shop-profile.model';

@Injectable({ providedIn: 'root' })
export class ShopProfileService {
  private readonly baseUrl = `${environment.api_base_url}shop-profile`;
  private readonly cachedProfile = signal<ShopProfile | null>(null);

  /** Last profile loaded or saved; null until the first successful request. Used when printing. */
  readonly profile = this.cachedProfile.asReadonly();

  constructor(private readonly http: HttpClient) {}

  getProfile(): Observable<ShopProfile> {
    return this.http.get<ShopProfile>(this.baseUrl).pipe(
      tap((profile) => this.cachedProfile.set(profile))
    );
  }

  saveProfile(payload: ShopProfilePayload): Observable<ShopProfile> {
    return this.http.put<ShopProfile>(this.baseUrl, payload).pipe(
      tap((profile) => this.cachedProfile.set(profile))
    );
  }

  /** The server refused a document because its VAT settings differ from the cached ones: take the server's block right away. */
  applyVat(vat: ShopProfile['vat']): void {
    const current = this.cachedProfile();
    if (current) this.cachedProfile.set({ ...current, vat });
    else this.refresh();
  }

  /** Reloads the cached profile in the background. On failure the cache stays as it was. */
  refresh(): void {
    this.getProfile().subscribe({ error: () => undefined });
  }
}
