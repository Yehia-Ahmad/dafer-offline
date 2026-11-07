import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { environment } from '../../../../environments/environment';
import { removeNullishFieldsParams } from '../../../core/utilities/helper-function';

export interface Customer {
  _id?: string;
  name: string;
  phone: string;
  /** Stage 21: shown on the invoice for B2B customers. */
  taxNumber?: string;
  isIndebted?: boolean;
  /** Stage 18: open invoices + the opening balance still to collect. */
  outstanding?: number;
  /** Stage 18: a negative opening (we owe the customer). */
  credit?: number;
  /** outstanding − credit: positive = the customer owes us. */
  balance?: number;
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

/** Stage 18: the customer's opening balance (رصيد أول المدة). It is never an invoice. */
export interface CustomerOpening {
  amount: number;
  date: string;
  number: string | null;
  collected: number;
  /** Still collectable (a negative opening has nothing to collect). */
  remaining: number;
}

export interface CustomerDetails extends Customer {
  opening?: CustomerOpening | null;
  outstanding?: number;
  creditSummary?: Partial<CustomerCreditSummary>;
  creditHistory?: CustomerCreditHistoryEntry[];
}

export interface CustomerQueryParams {
  search?: string;
  name?: string;
  phone?: string;
}

/** Stage 18: what the customer still owes today by days overdue. The opening balance ages from the ledger start. */
export interface CustomerAging {
  current: number;
  days1to30: number;
  days31to60: number;
  over60: number;
  total: number;
  /** Negative opening: we owe the customer. */
  credit: number;
}

export interface CustomerStatementLine {
  date: string;
  /** 'opening' is the period's start row; 'opening_balance' is the customer's رصيد أول المدة (Stage 18). */
  type: 'opening' | 'opening_balance' | 'invoice' | 'payment' | 'return' | 'cancel';
  number: string | null;
  description: string;
  debit: number;
  credit: number;
  balance: number;
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

  getCustomerStatement(id: string, params?: { from?: string; to?: string }) {
    return this._http.get(`${this._baseUrl}customers/${id}/statement`, { params: removeNullishFieldsParams({ ...(params ?? {}) }) });
  }

  /** Stage 18: collects from the customer's open items, the opening balance first (it is the oldest). */
  collectPayment(id: string, payload: { amount: number; paymentDate?: string; note?: string; boxId?: string }) {
    return this._http.post(`${this._baseUrl}customers/${id}/payments`, { ...payload, firstInvoice: true });
  }

  createCustomer(payload: Pick<Customer, 'name' | 'phone' | 'taxNumber'>) {
    return this._http.post(`${this._baseUrl}customers`, payload);
  }

  updateCustomer(id: string, payload: Pick<Customer, 'name' | 'phone' | 'taxNumber'>) {
    return this._http.put(`${this._baseUrl}customers/${id}`, payload);
  }

  deleteCustomer(id: string) {
    return this._http.delete(`${this._baseUrl}customers/${id}`);
  }
}
