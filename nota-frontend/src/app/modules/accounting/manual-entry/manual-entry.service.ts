import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';
import { environment } from '../../../../environments/environment';

export type PartyKind = 'customer' | 'supplier';

/** One account the manual entry form may offer; `blocked` says why it cannot be used (box, inventory, VAT, invoice accounts). */
export interface ManualAccountOption {
  _id: string;
  code: string;
  nameAr: string;
  nameEn: string;
  type: string;
  normalSide: 'debit' | 'credit';
  systemKey: string | null;
  needsParty: PartyKind | null;
  blocked: { code: string; message: string } | null;
}

export interface ManualLine {
  accountId: string;
  description?: string;
  debit: number;
  credit: number;
  partyType?: PartyKind | null;
  partyId?: string | null;
  partyName?: string | null;
  accountCode?: string | null;
  accountNameAr?: string | null;
  accountNameEn?: string | null;
}

export interface ManualAllocation { customerId: string; kind: 'invoice' | 'opening'; itemId: string; number: string | null; amount: number }
export interface ManualReversal { _id?: string; entryId?: string; number?: string; date?: string; reason?: string; byName?: string }

export interface ManualEntry {
  _id: string;
  status: 'draft' | 'posted';
  date: string;
  memo: string;
  lines: ManualLine[];
  totalDebit: number;
  totalCredit: number;
  number?: string;
  entryId?: string;
  postedByName?: string;
  allocations?: ManualAllocation[];
  reversal?: ManualReversal;
  entry?: { _id: string; number: string };
}

export interface ManualEntryPayload {
  date: string;
  memo: string;
  lines: { accountId: string; description: string; debit: number; credit: number; partyType: PartyKind | null; partyId: string | null }[];
}

export interface PartyOption { _id: string; name: string }

/** Stage 22: /api/accounting/manual-entries (accounting.manage). Drafts are editable; a posted entry is only reversed. */
@Injectable({ providedIn: 'root' })
export class ManualEntryService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.api_base_url}accounting/manual-entries`;

  accounts(): Observable<ManualAccountOption[]> {
    return this.http.get<{ data: ManualAccountOption[] }>(`${this.base}/accounts`).pipe(map((response) => response.data));
  }

  list(status?: 'draft' | 'posted'): Observable<ManualEntry[]> {
    let params = new HttpParams();
    if (status) params = params.set('status', status);
    return this.http.get<{ data: ManualEntry[] }>(this.base, { params }).pipe(map((response) => response.data));
  }

  get(id: string): Observable<ManualEntry> { return this.http.get<ManualEntry>(`${this.base}/${id}`); }
  create(payload: ManualEntryPayload): Observable<ManualEntry> { return this.http.post<ManualEntry>(this.base, payload); }
  update(id: string, payload: ManualEntryPayload): Observable<ManualEntry> { return this.http.put<ManualEntry>(`${this.base}/${id}`, payload); }
  remove(id: string): Observable<void> { return this.http.delete<void>(`${this.base}/${id}`); }
  post(id: string): Observable<ManualEntry> { return this.http.post<ManualEntry>(`${this.base}/${id}/post`, {}); }
  reverse(id: string, body: { reason: string; date?: string }): Observable<ManualEntry> { return this.http.post<ManualEntry>(`${this.base}/${id}/reverse`, body); }

  customers(): Observable<PartyOption[]> {
    return this.http.get<PartyOption[]>(`${environment.api_base_url}customers`).pipe(map((rows) => rows.map((row) => ({ _id: row._id, name: row.name }))));
  }

  suppliers(): Observable<PartyOption[]> {
    return this.http.get<PartyOption[]>(`${environment.api_base_url}suppliers`).pipe(map((rows) => rows.map((row) => ({ _id: row._id, name: row.name }))));
  }
}
