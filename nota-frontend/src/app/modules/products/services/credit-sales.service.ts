import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { environment } from '../../../../environments/environment';
import { removeNullishFieldsParams } from '../../../core/utilities/helper-function';

export type CreditSaleStatus = 'pending' | 'partially_paid' | 'paid';

export interface CreditSaleFilters {
  customerId?: string;
  customerName?: string;
  customerPhone?: string;
  status?: CreditSaleStatus;
  sellingDate?: string;
  dueDate?: string;
}

export interface CreditSaleItemPayload {
  productId: string;
  quantity: number;
  price: number;
}

export interface CreateCreditSalePayload {
  customerId?: string;
  customerName?: string;
  customerPhone?: string;
  sellingDate: string;
  dueDate?: string;
  notes?: string;
  discountAmount?: number;
  discountPercentage?: number;
  shippingFees?: number;
  initialPaidAmount?: number;
  items: CreditSaleItemPayload[];
}

export interface CreditSalePaymentPayload {
  amount: number;
  paymentDate?: string;
  note?: string;
}

@Injectable({
  providedIn: 'root'
})
export class CreditSalesService {
  private _baseUrl = environment.api_base_url;

  constructor(private _http: HttpClient) {}

  getCreditSales(params?: CreditSaleFilters) {
    const cleanedParams = removeNullishFieldsParams({ ...(params ?? {}) });
    return this._http.get(`${this._baseUrl}credit-sales`, { params: cleanedParams });
  }

  getCreditSaleById(id: string) {
    return this._http.get(`${this._baseUrl}credit-sales/${id}`);
  }

  createCreditSale(payload: CreateCreditSalePayload) {
    return this._http.post(`${this._baseUrl}credit-sales`, payload);
  }

  updateCreditSale(id: string, payload: Partial<CreateCreditSalePayload>) {
    return this._http.put(`${this._baseUrl}credit-sales/${id}`, payload);
  }

  deleteCreditSale(id: string) {
    return this._http.delete(`${this._baseUrl}credit-sales/${id}`);
  }

  recordPayment(id: string, payload: CreditSalePaymentPayload) {
    return this._http.post(`${this._baseUrl}credit-sales/${id}/payments`, payload);
  }

}
