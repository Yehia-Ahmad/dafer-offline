import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../../../environments/environment';

export interface ClosingSettings { frequency: 'monthly' | 'yearly'; fiscalYearStartMonth: number }

export interface ClosingPeriod {
  start: string;
  end: string;
  label: string;
  yearEnd: boolean;
  /** The period has ended (local time). */
  ended: boolean;
  /** It ended and nothing blocks it. */
  canClose: boolean;
  endsAfter: string | null;
}

export type ChecklistKey = 'openShifts' | 'manualDrafts' | 'health' | 'vatUnfiled' | 'openingNotFinalized';
export interface ChecklistItem { key: ChecklistKey; ok: boolean; items?: Record<string, unknown>[] | string[] }
export interface ChecklistWarning { key: 'customerBalances' | 'supplierBalances'; count: number; total: number }
export interface Checklist { blocking: ChecklistItem[]; warnings: ChecklistWarning[]; canClose: boolean }

export interface ClosingHistoryRow {
  _id: string;
  label: string;
  periodStart: string;
  periodEnd: string;
  status: 'closed' | 'reopened';
  yearEnd: boolean;
  closedAt: string;
  closedByName: string | null;
  entryId: string | null;
  entryNumber: string | null;
  netProfit: number | null;
  reopenedAt: string | null;
  reopenedByName: string | null;
  reopenReason: string | null;
  reversalEntryId: string | null;
}

export interface ClosingState {
  settings: ClosingSettings;
  lockedThrough: string | null;
  next: ClosingPeriod | null;
  checklist: Checklist | null;
  history: ClosingHistoryRow[];
  latestClosedId: string | null;
}

/** Stage 22: /api/accounting/closing (view: accounting.view; close: accounting.close; reopen: accounting.close and the owner). */
@Injectable({ providedIn: 'root' })
export class ClosingService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.api_base_url}accounting/closing`;

  state(): Observable<ClosingState> { return this.http.get<ClosingState>(this.base); }
  close(periodEnd: string): Observable<{ close: ClosingHistoryRow; lockedThrough: string; entry: { _id: string; number: string } | null }> {
    return this.http.post<{ close: ClosingHistoryRow; lockedThrough: string; entry: { _id: string; number: string } | null }>(`${this.base}/close`, { periodEnd, confirm: true });
  }
  reopen(reason: string): Observable<{ reopened: ClosingHistoryRow; lockedThrough: string | null }> {
    return this.http.post<{ reopened: ClosingHistoryRow; lockedThrough: string | null }>(`${this.base}/reopen`, { reason, confirm: true });
  }
}
