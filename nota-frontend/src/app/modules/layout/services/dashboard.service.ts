import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../../../environments/environment';

export interface DashboardDayTotals {
  total: number;
  count: number;
}

export interface DashboardSummary {
  /** Server's local calendar date, YYYY-MM-DD. */
  date: string;
  timeZone: string;
  today: { cash: DashboardDayTotals; credit: DashboardDayTotals };
  yesterday: { cash: DashboardDayTotals; credit: DashboardDayTotals };
  credit: { outstanding: number; customersWithBalance: number; overdueAmount: number; overdueCount: number };
  /** 7 entries, oldest first, the last one is `date`. */
  last7Days: Array<{ date: string; cash: number; credit: number }>;
  recentInvoices: Array<{
    id: string;
    type: 'cash' | 'credit';
    reference: string;
    customerName: string;
    customerId: string | null;
    total: number;
    sellingDate: string;
    createdAt: string;
  }>;
  /** Stage 20: what we owe suppliers; absent without suppliers.view. */
  suppliersDue?: { owed: number; suppliersWithBalance: number };
  /** Stage 21: present while the shop has VAT on (today's sales then include the VAT the customers paid). */
  vat?: { enabled: boolean; rate: number; pricesIncludeVat: boolean };
  /** Stage 21: VAT payable less input VAT; only with vat.file or accounting.view. */
  vatDue?: { amount: number; payable: number; input: number };
  lowStock: Array<{ id: string; name: string; code: string; inventoryCount: number; threshold: number }>;
}

/**
 * Online Stage 6A: GET /api/dashboard/mobile-summary (read-only). Every block is optional: the server leaves out what the user may not see.
 * today.website / today.shop need orders.view too; cashDrawer needs cashbox.view.
 */
export interface MobileSummary {
  today?: { total: number; shop?: number; website?: number };
  cashDrawer?: number;
}

/** Stage 12: GET /api/dashboard/summary (read-only). */
@Injectable({ providedIn: 'root' })
export class DashboardService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = environment.api_base_url;

  getSummary(): Observable<DashboardSummary> {
    return this.http.get<DashboardSummary>(`${this.baseUrl}dashboard/summary`);
  }

  getMobileSummary(): Observable<MobileSummary> {
    return this.http.get<MobileSummary>(`${this.baseUrl}dashboard/mobile-summary`);
  }
}
