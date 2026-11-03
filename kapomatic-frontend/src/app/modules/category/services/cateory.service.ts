import { Injectable } from '@angular/core';
import { environment } from '../../../../environments/environment';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable, map } from 'rxjs';

export interface Product {
  _id: string;
  name: string;
  code?: string;
  image?: string;
  inventoryCount?: number;
  discountPercentage?: number;
  priceAfterDiscount?: number;
  [key: string]: unknown;
}

export interface CategoryPayload {
  name?: string;
  imageBase64?: string;
  specifications?: Array<{ title: string }>;
}

export interface ProductPayload {
  name?: string;
  code?: string;
  inventoryCount?: number | string;
  newInventory?: number | string;
  imageBase64?: string;
  image?: string;
  categoryId?: string;
  wholesalePrice?: number | string;
  purchasePrice?: number | string;
  retailPrice?: number | string;
  discountPercentage?: number;
  soldItemCount?: number | string;
  editProduct?: boolean;
  specifications?: Array<{ title: string; value: string }>;
}

export interface ProductsPagination {
  hasNextPage: boolean;
  page: number;
  totalPages: number;
}

export interface ProductsPage {
  products: Product[];
  pagination: ProductsPagination;
}

interface RawProductsResponse {
  products?: Product[];
  pagination?: Partial<ProductsPagination>;
  data?: Product[] | {
    products?: Product[];
    pagination?: Partial<ProductsPagination>;
  };
}

export interface CategoryImportResult {
  success: boolean;
  importedCount: number;
  skippedCount: number;
  errors: unknown[];
}

interface RawCategoryImportResponse extends Partial<CategoryImportResult> {
  data?: Partial<CategoryImportResult>;
}

@Injectable({
  providedIn: 'root'
})
export class CateoryService {
  private _baseUrl = environment.api_base_url

  constructor(private _http: HttpClient) { }

  getCategories() {
    return this._http.get(`${this._baseUrl}categories`);
  }

  getCategoryById(id: number | string) {
    return this._http.get(`${this._baseUrl}categories/${id}`);
  }

  createCategory(category: CategoryPayload) {
    return this._http.post(`${this._baseUrl}categories`, category);
  }

  updateCategory(id: string, category: CategoryPayload) {
    return this._http.put(`${this._baseUrl}categories/${id}`, category);
  }

  deleteCategory(id: string) {
    return this._http.delete(`${this._baseUrl}categories/${id}`);
  }

  exportCategories(): Observable<Blob> {
    return this._http.get(`${this._baseUrl}categories/export`, {
      responseType: 'blob'
    });
  }

  importCategories(file: File): Observable<CategoryImportResult> {
    const formData = new FormData();
    formData.append('file', file, file.name);

    return this._http
      .post<RawCategoryImportResponse>(`${this._baseUrl}categories/import`, formData)
      .pipe(map((response) => this.normalizeCategoryImportResult(response)));
  }

  getProducts(categoryId: number | string, params?: Record<string, string | number>) {
    return this._http.get(`${this._baseUrl}products`, { params });
  }

  getProductsPage(
    categoryId: number | string,
    options: { page?: number; limit?: number } = {}
  ): Observable<ProductsPage> {
    const page = options.page ?? 1;
    const limit = options.limit ?? 10;
    const params = new HttpParams()
      .set('categoryId', String(categoryId))
      .set('page', page)
      .set('limit', limit);

    return this._http
      .get<RawProductsResponse | Product[]>(`${this._baseUrl}products`, { params })
      .pipe(map((response) => this.normalizeProductsPage(response, page)));
  }

  addNewProduct(product: ProductPayload) {
    return this._http.post(`${this._baseUrl}products`, product);
  }

  getProductById(id: number) {
    return this._http.get(`${this._baseUrl}products/${id}`);
  }

  updateProduct(id: number, payload: ProductPayload) {
    return this._http.put(`${this._baseUrl}products/${id}`, payload);
  }

  syncProductPurchasePrice(id: number | string, payload: {
    dateFrom?: string;
    dateTo?: string;
  }) {
    return this._http.post(`${this._baseUrl}products/${id}/sync-purchase-price`, payload);
  }

  deleteProduct(id: number) {
    return this._http.delete(`${this._baseUrl}products/${id}`);
  }

  private normalizeProductsPage(
    response: RawProductsResponse | Product[],
    requestedPage: number
  ): ProductsPage {
    if (Array.isArray(response)) {
      return {
        products: response,
        pagination: { hasNextPage: false, page: requestedPage, totalPages: requestedPage }
      };
    }

    const nestedData = response.data && !Array.isArray(response.data) ? response.data : undefined;
    const products = response.products
      ?? (Array.isArray(response.data) ? response.data : nestedData?.products)
      ?? [];
    const pagination = response.pagination ?? nestedData?.pagination ?? {};
    const currentPage = Number(pagination.page ?? requestedPage);
    const totalPages = Number(pagination.totalPages ?? currentPage);

    return {
      products,
      pagination: {
        hasNextPage: Boolean(pagination.hasNextPage),
        page: Number.isFinite(currentPage) ? currentPage : requestedPage,
        totalPages: Number.isFinite(totalPages) ? totalPages : requestedPage
      }
    };
  }

  private normalizeCategoryImportResult(response: RawCategoryImportResponse): CategoryImportResult {
    const result = response.data ?? response;
    return {
      success: (result.success ?? response.success) === true,
      importedCount: this.toNonNegativeNumber(result.importedCount),
      skippedCount: this.toNonNegativeNumber(result.skippedCount),
      errors: Array.isArray(result.errors) ? result.errors : []
    };
  }

  private toNonNegativeNumber(value: unknown): number {
    const parsedValue = Number(value);
    return Number.isFinite(parsedValue) && parsedValue >= 0 ? parsedValue : 0;
  }
}
