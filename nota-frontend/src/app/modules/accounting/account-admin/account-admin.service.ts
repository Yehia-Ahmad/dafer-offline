import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../../../environments/environment';

export interface AdminAccount {
  _id: string;
  code: string;
  nameAr: string;
  nameEn: string;
  type: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
  normalSide: 'debit' | 'credit';
  parentId: string | null;
  isGroup: boolean;
  isSystem: boolean;
  isActive: boolean;
}

export interface NextCode { code: string; scheme: string; type: AdminAccount['type']; normalSide: 'debit' | 'credit'; parent: { _id: string; code: string; nameAr: string } }

export interface AccountUsage {
  account: AdminAccount;
  hasLines: boolean;
  balance: number;
  openDrafts: number;
  hasChildren: boolean;
  isBox: boolean;
  canDeactivate: boolean;
  deactivateBlockedBy: string[];
  canReactivate: boolean;
  canDelete: boolean;
  deleteBlockedBy: string[];
  canEditStructure: boolean;
}

export interface NewAccountPayload { parentId: string; nameAr: string; nameEn?: string; isGroup: boolean }
export interface EditAccountPayload { nameAr?: string; nameEn?: string; parentId?: string; code?: string }

/** Stage 22: shaping the chart of accounts, /api/accounting/accounts (accounting.manage). */
@Injectable({ providedIn: 'root' })
export class AccountAdminService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.api_base_url}accounting/accounts`;

  nextCode(parentId: string): Observable<NextCode> { return this.http.get<NextCode>(`${this.base}/next-code`, { params: new HttpParams().set('parentId', parentId) }); }
  usage(id: string): Observable<AccountUsage> { return this.http.get<AccountUsage>(`${this.base}/${id}/usage`); }
  create(payload: NewAccountPayload): Observable<AdminAccount> { return this.http.post<AdminAccount>(this.base, payload); }
  update(id: string, payload: EditAccountPayload): Observable<AdminAccount> { return this.http.put<AdminAccount>(`${this.base}/${id}`, payload); }
  deactivate(id: string): Observable<AdminAccount> { return this.http.post<AdminAccount>(`${this.base}/${id}/deactivate`, {}); }
  reactivate(id: string): Observable<AdminAccount> { return this.http.post<AdminAccount>(`${this.base}/${id}/reactivate`, {}); }
  remove(id: string): Observable<void> { return this.http.delete<void>(`${this.base}/${id}`); }
}
