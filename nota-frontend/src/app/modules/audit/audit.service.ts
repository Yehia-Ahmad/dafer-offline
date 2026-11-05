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

/** Every action the backend records (nota-backend Stage 13, OFFLINE_PLAN "Audit log"). */
export const AUDIT_ACTIONS = [
  'auth.login', 'auth.login_failed', 'auth.locked', 'auth.setup_owner', 'auth.recover', 'auth.recover_failed', 'auth.password_changed',
  'user.created', 'user.updated', 'user.status_changed', 'user.password_reset',
  'sale.created', 'sale.updated', 'sale.returned', 'sale.cancelled',
  'credit.created', 'credit.updated', 'credit.payment', 'credit.returned', 'credit.cancelled',
  'product.archived', 'product.deleted', 'product.restored', 'product.sync_purchase_price',
  'category.import', 'category.deleted', 'customer.deleted', 'shop.updated',
  'backup.created', 'backup.restored', 'backup.restore_failed', 'system.migration',
] as const;

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
