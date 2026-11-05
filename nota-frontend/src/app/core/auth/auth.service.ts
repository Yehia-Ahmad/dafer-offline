import { HttpClient, HttpContext, HttpContextToken } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { Observable, firstValueFrom, tap } from 'rxjs';
import { environment } from '../../../environments/environment';
import { isOfflineMainPc } from '../runtime/app-features';
import { AuthResult, AuthUser, BootstrapInfo, PermissionCatalog } from './auth.models';
import { LANDING_ORDER, NO_ACCESS_PATH, RouteRule, ruleAllows } from './route-permissions';
import { readStoredToken, writeStoredToken } from './session-storage';

/**
 * Requests whose errors the screen shows itself (login, first run, recover, change password):
 * the interceptor adds no toast and does not end the session on their 401.
 */
export const HANDLES_OWN_ERRORS = new HttpContextToken<boolean>(() => false);
const ownErrors = () => ({ context: new HttpContext().set(HANDLES_OWN_ERRORS, true) });

/**
 * Stage 14: the signed-in user. Token in memory + sessionStorage (see session-storage.ts).
 * The backend checks every request; these signals only drive what the UI shows.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly http = inject(HttpClient);

  readonly token = signal<string | null>(readStoredToken());
  readonly user = signal<AuthUser | null>(null);
  readonly permissions = signal<readonly string[]>([]);
  readonly signedIn = computed(() => Boolean(this.token() && this.user()));
  private readonly permissionSet = computed(() => new Set(this.permissions()));

  private get base(): string {
    return `${environment.api_base_url}auth/`;
  }

  has(key: string): boolean {
    return this.permissionSet().has(key);
  }

  hasAll(...keys: string[]): boolean {
    return keys.every((key) => this.has(key));
  }

  hasAny(...keys: string[]): boolean {
    return keys.some((key) => this.has(key));
  }

  allows(rule: RouteRule): boolean {
    return ruleAllows(rule, (key) => this.has(key), isOfflineMainPc());
  }

  /** The first page this user may open (sidebar order), e.g. /selling for a cashier without the dashboard. */
  firstAllowedPath(): string {
    if (!this.signedIn()) return '/login';
    return LANDING_ORDER.find((entry) => this.allows(entry.rule))?.path ?? NO_ACCESS_PATH;
  }

  /** App start: a token from this window's earlier load is checked with /auth/me; a bad one is dropped. */
  async restore(): Promise<void> {
    if (!this.token()) return;
    try {
      await firstValueFrom(this.refreshMe());
    } catch {
      this.clear();
    }
  }

  bootstrap(): Observable<BootstrapInfo> {
    return this.http.get<BootstrapInfo>(`${this.base}bootstrap`, ownErrors());
  }

  login(username: string, password: string): Observable<AuthResult> {
    return this.http.post<AuthResult>(`${this.base}login`, { username, password }, ownErrors()).pipe(tap((result) => this.apply(result)));
  }

  setupOwner(body: { name: string; username: string; password: string }): Observable<AuthResult> {
    return this.http.post<AuthResult>(`${this.base}setup-owner`, body, ownErrors()).pipe(tap((result) => this.apply(result)));
  }

  recover(body: { username: string; recoveryCode: string; newPassword: string }): Observable<AuthResult> {
    return this.http.post<AuthResult>(`${this.base}recover`, body, ownErrors()).pipe(tap((result) => this.apply(result)));
  }

  /** The backend raises tokenVersion; the returned token keeps this user signed in. */
  changePassword(currentPassword: string, newPassword: string): Observable<AuthResult> {
    return this.http
      .post<AuthResult>(`${this.base}change-password`, { currentPassword, newPassword }, ownErrors())
      .pipe(tap((result) => this.apply(result)));
  }

  refreshMe(): Observable<{ user: AuthUser; permissions: string[] }> {
    return this.http.get<{ user: AuthUser; permissions: string[] }>(`${this.base}me`, ownErrors()).pipe(
      tap((result) => {
        this.user.set(result.user);
        this.permissions.set(result.permissions ?? result.user.permissions ?? []);
      })
    );
  }

  permissionCatalog(): Observable<PermissionCatalog> {
    return this.http.get<PermissionCatalog>(`${this.base}permissions`);
  }

  /** Sign out on this PC (the token simply stops being sent; it expires on its own). */
  logout(): void {
    this.clear();
  }

  /** Session ended by the server (SESSION_EXPIRED) or by logout. */
  clear(): void {
    this.token.set(null);
    this.user.set(null);
    this.permissions.set([]);
    writeStoredToken(null);
  }

  private apply(result: AuthResult): void {
    this.token.set(result.token);
    this.user.set(result.user);
    this.permissions.set(result.permissions ?? result.user.permissions ?? []);
    writeStoredToken(result.token);
  }
}
