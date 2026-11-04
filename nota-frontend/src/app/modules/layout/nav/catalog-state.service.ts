import { Injectable, PLATFORM_ID, inject, signal } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { CateoryService } from '../../category/services/cateory.service';

export interface SidebarCategory {
  label: string;
  id: string;
  /** Stage 12: products in the category (GET categories productCount). */
  productCount?: number;
  category?: any;
}

/**
 * Category list + "any product exists" flag, shared by the products page (Stage 11), the product form
 * and the POS category chips. The requests are the ones the old sidebar made:
 * GET categories, then GET products?categoryId=<first>&limit=1.
 * Refreshed on app start (sidebar), on entering /products, after category changes and after product create/delete.
 */
@Injectable({ providedIn: 'root' })
export class CatalogStateService {
  private readonly _cateoryService = inject(CateoryService);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  readonly categories = signal<SidebarCategory[]>([]);
  readonly hasProducts = signal(false);
  private loading = false;

  /** Reloads both values. A call while a reload is running is ignored. `onError` gets the categories error. */
  refresh(onError?: (err: unknown) => void): void {
    if (this.loading) return;
    this.loading = true;
    this._cateoryService.getCategories().subscribe({
      next: (res: any) => {
        this.loading = false;
        const categories = Array.isArray(res) ? res : (res?.data ?? res?.categories ?? []);
        this.categories.set(categories.map((category: any) => ({
          label: category.name,
          id: category._id,
          productCount: Number.isFinite(Number(category.productCount)) ? Number(category.productCount) : undefined,
          category
        })));
        this.checkHasAnyProducts();
      },
      error: (err) => {
        this.loading = false;
        onError?.(err);
      }
    });
  }

  private checkHasAnyProducts(): void {
    if (!this.isBrowser) return;

    const categoryIdHint = this.categories()?.[0]?.id;
    if (!categoryIdHint) {
      this.hasProducts.set(false);
      return;
    }

    this._cateoryService.getProducts(categoryIdHint, { categoryId: categoryIdHint, limit: 1 }).subscribe({
      next: (res: any) => this.hasProducts.set(extractList(res).length > 0),
      error: () => this.hasProducts.set(false)
    });
  }
}

function extractList(response: any): any[] {
  if (Array.isArray(response)) return response;
  if (Array.isArray(response?.data)) return response.data;
  if (Array.isArray(response?.products)) return response.products;
  if (Array.isArray(response?.data?.products)) return response.data.products;
  return [];
}
