import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';
import { environment } from '../../../environments/environment';
import {
  CategoryWebsite,
  DeliveryZone,
  DeliveryZonePayload,
  EMPTY_WEBSITE_SETTINGS,
  ProductWebsite,
  VisibilityChoice,
  WebsiteSettings,
  WebsiteSettingsPayload,
} from './website.models';

/** Online Stage 3: /api/website/* (website.manage). */
@Injectable({ providedIn: 'root' })
export class WebsiteService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.api_base_url}website`;

  getSettings(): Observable<WebsiteSettings> {
    return this.http.get<any>(`${this.base}/settings`).pipe(map((raw) => this.toSettings(raw)));
  }

  saveSettings(payload: WebsiteSettingsPayload): Observable<WebsiteSettings> {
    return this.http.put<any>(`${this.base}/settings`, payload).pipe(map((raw) => this.toSettings(raw)));
  }

  listZones(): Observable<DeliveryZone[]> {
    return this.http.get<{ data: DeliveryZone[] }>(`${this.base}/delivery-zones`).pipe(map((res) => res.data));
  }

  createZone(payload: DeliveryZonePayload): Observable<DeliveryZone> {
    return this.http.post<DeliveryZone>(`${this.base}/delivery-zones`, payload);
  }

  updateZone(id: string, payload: Partial<DeliveryZonePayload>): Observable<DeliveryZone> {
    return this.http.put<DeliveryZone>(`${this.base}/delivery-zones/${id}`, payload);
  }

  deleteZone(id: string): Observable<void> {
    return this.http.delete<void>(`${this.base}/delivery-zones/${id}`);
  }

  /** The one staff endpoint that carries a product's website images (the products list and the product itself do not). */
  getProductWebsite(productId: string): Observable<{ id: string; website: ProductWebsite }> {
    return this.http.get<{ id: string; website: ProductWebsite }>(`${this.base}/products/${productId}`);
  }

  saveProductWebsite(productId: string, body: { visibility?: VisibilityChoice; description?: string; images?: string[] }): Observable<{ id: string; website: ProductWebsite }> {
    return this.http.put<{ id: string; website: ProductWebsite }>(`${this.base}/products/${productId}`, body);
  }

  saveCategoryWebsite(categoryId: string, body: { visibility?: VisibilityChoice; sortOrder?: number }): Observable<{ id: string; website: CategoryWebsite }> {
    return this.http.put<{ id: string; website: CategoryWebsite }>(`${this.base}/categories/${categoryId}`, body);
  }

  /** Saved banners come with Mongo's `_id`; the page works with `id`. */
  private toSettings(raw: any): WebsiteSettings {
    const merged = { ...EMPTY_WEBSITE_SETTINGS, ...(raw || {}) };
    return {
      ...merged,
      banners: (raw?.banners || []).map((banner: any) => ({
        id: banner.id ?? banner._id,
        image: banner.image,
        linkType: banner.linkType || 'none',
        linkId: banner.linkId ? String(banner.linkId) : null,
        sortOrder: Number(banner.sortOrder || 0),
      })),
      featuredCategoryIds: (raw?.featuredCategoryIds || []).map(String),
      minOrderAmount: raw?.minOrderAmount ?? null,
      freeDeliveryFrom: raw?.freeDeliveryFrom ?? null,
      // Online Stage 5A: every nested group keeps the default of a key the saved document does not have.
      fulfillment: { ...EMPTY_WEBSITE_SETTINGS.fulfillment, ...(raw?.fulfillment || {}) },
      payments: {
        cod: { ...EMPTY_WEBSITE_SETTINGS.payments.cod, ...(raw?.payments?.cod || {}) },
        instapay: { ...EMPTY_WEBSITE_SETTINGS.payments.instapay, ...(raw?.payments?.instapay || {}), boxId: raw?.payments?.instapay?.boxId ? String(raw.payments.instapay.boxId) : null },
        vodafoneCash: { ...EMPTY_WEBSITE_SETTINGS.payments.vodafoneCash, ...(raw?.payments?.vodafoneCash || {}), boxId: raw?.payments?.vodafoneCash?.boxId ? String(raw.payments.vodafoneCash.boxId) : null },
      },
      stock: {
        showOutOfStock: raw?.stock?.showOutOfStock ?? true,
        showRemaining: { ...EMPTY_WEBSITE_SETTINGS.stock.showRemaining, ...(raw?.stock?.showRemaining || {}) },
      },
      announcement: { ...EMPTY_WEBSITE_SETTINGS.announcement, ...(raw?.announcement || {}) },
      highlights: raw?.highlights || [],
      productVisibility: raw?.productVisibility === 'all' ? 'all' : 'marked',
      brandColor: raw?.brandColor || null,
      websiteLogo: raw?.websiteLogo || null,
    };
  }
}
