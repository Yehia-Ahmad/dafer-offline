import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { environment } from '../../../../environments/environment';
import { removeNullishFieldsParams } from '../../../core/utilities/helper-function';

export interface Customer {
  _id?: string;
  name: string;
  phone: string;
  isIndebted?: boolean;
  createdAt?: string;
  updatedAt?: string;
  lastCashSaleDate?: string | null;
  lastCreditSaleDate?: string | null;
  lastCreditSalePaymentDate?: string | null;
}

export interface CustomerCreditSummary {
  totalInvoices: number;
  openInvoices: number;
  totalCredit: number;
  paidAmount: number;
  remainingAmount: number;
  pendingInvoices: number;
  partiallyPaidInvoices: number;
  paidInvoices: number;
  overdueInvoices: number;
  dueSoonInvoices: number;
}

export interface CustomerCreditPayment {
  _id?: string;
  amount?: number;
  paymentDate?: string;
  note?: string | null;
}

export interface CustomerCreditHistoryItem {
  _id?: string;
  invoiceId?: string;
  productId?: string;
  productName?: string;
  categoryName?: string;
  productQuantity?: number;
  productQuentity?: number;
  productPricePerEach?: number;
  totalPrice?: number;
  productCode?: string;
}

export interface CustomerCreditHistoryEntry {
  _id?: string;
  invoiceId?: string;
  customerId?: string;
  customerName?: string;
  customerPhone?: string;
  sellingDate?: string;
  dueDate?: string | null;
  status?: 'pending' | 'partially_paid' | 'paid' | string;
  discountAmount?: number;
  discountPercentage?: number;
  shippingFees?: number;
  totalPrice?: number;
  paidAmount?: number;
  remainingAmount?: number;
  itemCount?: number;
  totalQuantity?: number;
  notes?: string | null;
  payments?: CustomerCreditPayment[];
  items?: CustomerCreditHistoryItem[];
  createdAt?: string;
  updatedAt?: string;
}

export interface CustomerDetails extends Customer {
  creditSummary?: Partial<CustomerCreditSummary>;
  creditHistory?: CustomerCreditHistoryEntry[];
}

export interface CustomerQueryParams {
  search?: string;
  name?: string;
  phone?: string;
}

export interface DeleteCustomerOptions {
  restoreCreditInvoices?: boolean;
}

@Injectable({
  providedIn: 'root'
})
export class CustomersService {
  private _baseUrl = environment.api_base_url;

  constructor(private _http: HttpClient) { }

  getCustomers(params?: CustomerQueryParams) {
    const cleanedParams = removeNullishFieldsParams({ ...(params ?? {}) });
    return this._http.get(`${this._baseUrl}customers`, { params: cleanedParams });
  }

  getCustomerById(id: string) {
    return this._http.get(`${this._baseUrl}customers/${id}`);
  }

  createCustomer(payload: Pick<Customer, 'name' | 'phone'>) {
    return this._http.post(`${this._baseUrl}customers`, payload);
  }

  updateCustomer(id: string, payload: Pick<Customer, 'name' | 'phone'>) {
    return this._http.put(`${this._baseUrl}customers/${id}`, payload);
  }

  deleteCustomer(id: string, options?: DeleteCustomerOptions) {
    const requestOptions = options ? { body: options } : undefined;
    return this._http.delete(`${this._baseUrl}customers/${id}`, requestOptions);
  }
}
