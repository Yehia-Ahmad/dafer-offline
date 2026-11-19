import { BACKEND_AUDIT_ACTIONS } from '../../help/generated/audit-actions';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

export interface AuditEntry {
  _id: string;
  at: string;
  userId?: string | null;
  userName?: string | null;
  action: string;
  entity?: string | null;
  entityId?: string | null;
  details?: Record<string, unknown> | null;
  ip?: string | null;
}

export interface AuditFilters {
  from?: string;
  to?: string;
  userId?: string;
  action?: string;
  page: number;
  limit: number;
}

export interface AuditPage {
  success: boolean;
  data: AuditEntry[];
  pagination: { page: number; limit: number; totalItems: number; totalPages: number };
}

/** Every action the backend records: generated from the backend's audit calls (scripts/export-help.mjs), each with an Arabic and English label in audit.actions. */
export const AUDIT_ACTIONS: readonly string[] = BACKEND_AUDIT_ACTIONS;

/** Stage 14: GET /api/audit (audit.view): newest first, paginated. Empty filters are not sent. */
@Injectable({ providedIn: 'root' })
export class AuditService {
  private readonly http = inject(HttpClient);

  list(filters: AuditFilters): Observable<AuditPage> {
    let params = new HttpParams().set('page', String(filters.page)).set('limit', String(filters.limit));
    for (const key of ['from', 'to', 'userId', 'action'] as const) {
      const value = filters[key];
      if (value) params = params.set(key, value);
    }
    return this.http.get<AuditPage>(`${environment.api_base_url}audit`, { params });
  }
}
