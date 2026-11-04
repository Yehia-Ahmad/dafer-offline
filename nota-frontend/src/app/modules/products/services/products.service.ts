import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { environment } from '../../../../environments/environment';
import { removeNullishFieldsParams } from '../../../core/utilities/helper-function';
import { Observable } from 'rxjs';

export interface ProductProfitReportInvoice {
  id: string;
  invoiceNumber: string | null;
  type: string;
  sellingDate: string | null;
  sellingPrice: number | null;
  quantity: number | null;
  purchasePrice: number | null;
  profit: number | null;
  customerName: string | null;
}

export interface ProductProfitReportRow {
  productId: string;
  productName: string;
  categoryName: string;
  totalProfit: number;
  lastSellingDate: string | null;
  lastSellingPrice: number | null;
  invoices: ProductProfitReportInvoice[];
}

@Injectable({
  providedIn: 'root'
})
export class ProductsService {
  private _baseUrl = environment.api_base_url;

  constructor(private _http: HttpClient) { }

  searchProducts(query: string) {
    return this._http.get(`${this._baseUrl}products/search`, {
      params: { q: query }
    });
  }

  createSelling(payload: {
    customerName: string;
    customerPhone?: string;
    sellingDate: string;
    discountAmount?: number;
    discountPercentage?: number;
    shippingFees?: number;
    confirmInsufficientInventory?: boolean;
    items: Array<{
      productId: string;
      quantity: number;
      price: number;
    }>;
  }) {
    return this._http.post(`${this._baseUrl}sellings`, payload);
  }

  getSellings(params?: {
    categoryId?: string;
    productId?: string;
    customerName?: string;
    customerPhone?: string;
    sellingDate?: string;
    page?: number;
    limit?: number;
  }) {
    return this._http.get(`${this._baseUrl}sellings`, { params });
  }

  deleteSelling(id: string) {
    return this._http.delete(`${this._baseUrl}sellings/${id}`);
  }

  getProductsProfitReport(params?: {
    categoryId?: string;
    productId?: string;
    dateFrom?: string;
    dateTo?: string;
  }) {
    const cleanedParams = removeNullishFieldsParams({ ...(params ?? {}) });
    return this._http.get(`${this._baseUrl}products/profit-report`, { params: cleanedParams });
  }

  exportProductsExcel(): Observable<Blob> {
    return this._http.get(`${this._baseUrl}products/export/excel`, { responseType: 'blob' });
  }
}
