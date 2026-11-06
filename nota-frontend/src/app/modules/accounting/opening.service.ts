import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

export interface OpeningBankFigure {
  accountId: string;
  code: string;
  name: string;
  kind: 'bank' | 'wallet' | null;
  amount: number;
}

export interface OpeningPartyFigure {
  customerId?: string;
  supplierId?: string;
  name: string;
  phone?: string;
  /** Customers: positive = the customer owes us. Suppliers: positive = we owe the supplier. */
  amount: number;
  collected?: number;
}

export interface OpeningFigures {
  cash: number;
  banks: OpeningBankFigure[];
  fixedAssets: number;
  inventory: { mode: 'live' | 'carried'; editable: boolean; amount: number; stockValue?: number };
  customers: OpeningPartyFigure[];
  suppliers: OpeningPartyFigure[];
  /** Customer balances from invoices before the ledger start; carried as they are. */
  carriedCustomers: { customerId: string; amount: number }[];
}

export interface OpeningTotals {
  cash: number;
  banks: number;
  inventory: number;
  fixedAssets: number;
  customers: number;
  customerCredits: number;
  suppliers: number;
  supplierDebits: number;
  assets: number;
  liabilities: number;
  capital: number;
}

export interface OpeningState {
  status: 'setup' | 'finalized';
  setupMode: boolean;
  ledgerStartAt: string | null;
  finalizedAt: string | null;
  savedAt: string | null;
  figures: OpeningFigures;
  totals: OpeningTotals;
  entry: { _id: string; number: string } | null;
}

export interface OpeningProduct {
  _id: string;
  code?: string;
  name: string;
  inventoryCount?: number;
  purchasePrice?: number;
}

export interface OpeningSavePayload {
  cash: number;
  fixedAssets: number;
  banks: { accountId?: string; name?: string; type?: 'bank' | 'wallet'; amount: number }[];
  customers: { customerId: string; amount: number }[];
  suppliers: { supplierId: string; amount: number }[];
}

/** Stage 18: /api/accounting/opening (read: accounting.view; save and finalize: accounting.manage). */
@Injectable({ providedIn: 'root' })
export class OpeningService {
  private readonly http = inject(HttpClient);

  private get base(): string {
    return `${environment.api_base_url}accounting/opening`;
  }

  get(): Observable<OpeningState> {
    return this.http.get<OpeningState>(this.base);
  }

  save(payload: OpeningSavePayload): Observable<OpeningState & { number: string | null }> {
    return this.http.post<OpeningState & { number: string | null }>(this.base, payload);
  }

  finalize(): Observable<OpeningState> {
    return this.http.post<OpeningState>(`${this.base}/finalize`, { confirm: true });
  }

  /** The inventory step's table: every product, 100 per page (the API maximum). */
  listProducts(page: number): Observable<{ data: OpeningProduct[]; pagination: { page: number; totalPages: number; hasNextPage: boolean } }> {
    return this.http.get<{ data: OpeningProduct[]; pagination: { page: number; totalPages: number; hasNextPage: boolean } }>(
      `${environment.api_base_url}products`, { params: { page, limit: 100 } });
  }

  /** The normal product update: in setup mode the backend posts the stock change as opening_inventory. */
  updateProduct(id: string, payload: { inventoryCount?: number; purchasePrice?: number }): Observable<unknown> {
    return this.http.put(`${environment.api_base_url}products/${encodeURIComponent(id)}`, payload);
  }
}
