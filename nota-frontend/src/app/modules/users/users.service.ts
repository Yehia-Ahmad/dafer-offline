import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';
import { AuthUser, RoleKey } from '../../core/auth/auth.models';

export interface CreateUserPayload {
  name: string;
  username: string;
  password: string;
  role: Exclude<RoleKey, 'owner'>;
  /** Sent only when the list differs from the role template (or for a custom role). */
  permissions?: string[];
}

export interface UpdateUserPayload {
  name?: string;
  role?: Exclude<RoleKey, 'owner'>;
  permissions?: string[];
}

/** Stage 14: /api/users (users.manage). There is no DELETE: users are disabled instead. */
@Injectable({ providedIn: 'root' })
export class UsersService {
  private readonly http = inject(HttpClient);

  private get base(): string {
    return `${environment.api_base_url}users`;
  }

  list(): Observable<{ users: AuthUser[] }> {
    return this.http.get<{ users: AuthUser[] }>(this.base);
  }

  create(payload: CreateUserPayload): Observable<{ user: AuthUser }> {
    return this.http.post<{ user: AuthUser }>(this.base, payload);
  }

  update(id: string, payload: UpdateUserPayload): Observable<{ user: AuthUser }> {
    return this.http.put<{ user: AuthUser }>(`${this.base}/${encodeURIComponent(id)}`, payload);
  }

  setStatus(id: string, isActive: boolean): Observable<{ user: AuthUser }> {
    return this.http.patch<{ user: AuthUser }>(`${this.base}/${encodeURIComponent(id)}/status`, { isActive });
  }

  resetPassword(id: string, newPassword: string): Observable<{ user: AuthUser }> {
    return this.http.post<{ user: AuthUser }>(`${this.base}/${encodeURIComponent(id)}/reset-password`, { newPassword });
  }
}
