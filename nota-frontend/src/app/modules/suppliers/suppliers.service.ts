import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

export interface Supplier {
  _id: string;
  name: string;
  phones: string[];
  contactPerson?: string;
  address?: string;
  supplies?: string;
  taxNumber?: string;
  /** 0 = cash; 30, 60 or a custom number of days. */
  paymentTermsDays?: number | null;
  notes?: string;
  isActive: boolean;
  /** Ledger party balance: positive = we owe the supplier. */
  balance: number;
  openingAmount: number;
  /** Stage 20: the date of the last posted purchase, null when there is none. */
  lastPurchaseAt?: string | null;
  /** Account 21: the supplier row links to its ledger filtered by this supplier. */
  ledgerAccountId?: string | null;
}

export interface SupplierPayload {
  name: string;
  phone?: string;
  contactPerson?: string;
  address?: string;
  supplies?: string;
  taxNumber?: string;
  paymentTermsDays?: number | null;
  notes?: string;
  isActive?: boolean;
}

/** Stage 18: /api/suppliers (suppliers.view / suppliers.manage). Purchases and the statement are Stage 20. */
@Injectable({ providedIn: 'root' })
export class SuppliersService {
  private readonly http = inject(HttpClient);

  private get base(): string {
    return `${environment.api_base_url}suppliers`;
  }

  list(search?: string): Observable<Supplier[]> {
    let params = new HttpParams();
    if (search?.trim()) params = params.set('search', search.trim());
    return this.http.get<Supplier[]>(this.base, { params });
  }

  get(id: string): Observable<Supplier> {
    return this.http.get<Supplier>(`${this.base}/${encodeURIComponent(id)}`);
  }

  create(payload: SupplierPayload): Observable<Supplier> {
    return this.http.post<Supplier>(this.base, payload);
  }

  update(id: string, payload: Partial<SupplierPayload>): Observable<Supplier> {
    return this.http.put<Supplier>(`${this.base}/${encodeURIComponent(id)}`, payload);
  }

  remove(id: string): Observable<{ message: string }> {
    return this.http.delete<{ message: string }>(`${this.base}/${encodeURIComponent(id)}`);
  }
}
