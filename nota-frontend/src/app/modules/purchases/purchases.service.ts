import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';
import { environment } from '../../../environments/environment';
import {
  Purchase, PurchaseCreated, PurchaseDetail, PurchaseFilters, PurchasePage, PurchasePayload, PurchaseProduct,
  PurchaseReturnPayload, PurchaseReturnRow, SupplierPaymentPayload, SupplierPaymentRow, SupplierRefundPayload, SupplierStatement,
} from './purchases.models';

/**
 * Stage 20: /api/purchases (purchases.view / create / cancel) and the supplier money endpoints (suppliers.pay).
 * One balance source: the supplier's `balance` from /api/suppliers (the ledger party balance), never a local sum.
 */
@Injectable({ providedIn: 'root' })
export class PurchasesService {
  private readonly http = inject(HttpClient);
  private readonly api = environment.api_base_url;

  list(filters: PurchaseFilters = {}): Observable<PurchasePage> {
    let params = new HttpParams();
    for (const [key, value] of Object.entries(filters)) {
      if (value !== undefined && value !== null && value !== '') params = params.set(key, String(value));
    }
    return this.http.get<PurchasePage>(`${this.api}purchases`, { params });
  }

  get(id: string): Observable<PurchaseDetail> {
    return this.http.get<PurchaseDetail>(`${this.api}purchases/${encodeURIComponent(id)}`);
  }

  create(payload: PurchasePayload): Observable<PurchaseCreated> {
    return this.http.post<PurchaseCreated>(`${this.api}purchases`, payload);
  }

  cancel(id: string, reason: string): Observable<Purchase> {
    return this.http.post<Purchase>(`${this.api}purchases/${encodeURIComponent(id)}/cancel`, { reason });
  }

  createReturn(id: string, payload: PurchaseReturnPayload): Observable<PurchaseReturnRow & { supplierBalanceAfter: number }> {
    return this.http.post<PurchaseReturnRow & { supplierBalanceAfter: number }>(`${this.api}purchases/${encodeURIComponent(id)}/returns`, payload);
  }

  pay(supplierId: string, payload: SupplierPaymentPayload): Observable<{ _id: string; number: string; balanceAfter: number; amount?: number; date?: string; reference?: string | null; note?: string | null }> {
    return this.http.post<{ _id: string; number: string; balanceAfter: number }>(`${this.api}suppliers/${encodeURIComponent(supplierId)}/payments`, payload);
  }

  /** Online Fixes 1: the supplier's payment vouchers, newest first (suppliers.view). */
  payments(supplierId: string): Observable<{ data: SupplierPaymentRow[] }> {
    return this.http.get<{ data: SupplierPaymentRow[] }>(`${this.api}suppliers/${encodeURIComponent(supplierId)}/payments`);
  }

  /** Online Fixes 1: POST /suppliers/:id/refunds (suppliers.pay): money the supplier gives back without a return (capped at what they owe us). */
  refund(supplierId: string, payload: SupplierRefundPayload): Observable<{ _id: string; number: string; amount: number }> {
    return this.http.post<{ _id: string; number: string; amount: number }>(`${this.api}suppliers/${encodeURIComponent(supplierId)}/refunds`, payload);
  }

  cancelPayment(id: string, reason: string): Observable<{ _id: string; status: string }> {
    return this.http.post<{ _id: string; status: string }>(`${this.api}supplier-payments/${encodeURIComponent(id)}/cancel`, { reason });
  }

  statement(supplierId: string, range: { from?: string; to?: string } = {}): Observable<SupplierStatement> {
    let params = new HttpParams();
    if (range.from) params = params.set('from', range.from);
    if (range.to) params = params.set('to', range.to);
    return this.http.get<SupplierStatement>(`${this.api}suppliers/${encodeURIComponent(supplierId)}/statement`, { params });
  }

  /** "صنف جديد" on the purchase screen: a normal product with stock 0 (products.manage + products.viewCost). */
  createProduct(payload: { name: string; code: string; categoryId: string; inventoryCount: number; purchasePrice: number; wholesalePrice: number; retailPrice: number }): Observable<PurchaseProduct> {
    return this.http.post<PurchaseProduct>(`${this.api}products`, payload);
  }

  categories(): Observable<{ _id: string; name: string }[]> {
    return this.http.get<unknown>(`${this.api}categories`).pipe(
      map((response) => {
        const rows = Array.isArray(response) ? response : ((response as { data?: unknown[] })?.data ?? (response as { categories?: unknown[] })?.categories ?? []);
        return (rows as { _id: string; name: string }[]).map((row) => ({ _id: row._id, name: row.name }));
      }),
    );
  }

  searchProducts(query: string): Observable<PurchaseProduct[]> {
    return this.http.get<PurchaseProduct[]>(`${this.api}products/search`, { params: { q: query } });
  }
}
