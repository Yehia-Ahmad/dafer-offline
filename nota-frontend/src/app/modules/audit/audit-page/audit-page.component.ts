import { DatePipe, formatDate } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { DatePickerModule } from 'primeng/datepicker';
import { SelectModule } from 'primeng/select';
import { AuthService } from '../../../core/auth/auth.service';
import { errorMessage } from '../../../core/auth/auth-errors';
import { NotaButtonDirective, NotaFormFieldComponent, NotaNumberPipe, NotaPageHeaderComponent } from '../../shared/ui';
import { UsersService } from '../../users/users.service';
import { LanguageService } from '../../shared/services/translation.service';
import { AUDIT_ACTIONS, AuditEntry, AuditService } from '../audit.service';

/**
 * Stage 14: /audit (audit.view). Time, user, action, entity, a short details summary; filters on
 * date range, user and action; paginated, newest first. No design board: the existing table pattern.
 */
@Component({
  selector: 'app-audit-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, FormsModule, TranslatePipe, DatePickerModule, SelectModule, NotaPageHeaderComponent, NotaFormFieldComponent,
    NotaButtonDirective, NotaNumberPipe],
  templateUrl: './audit-page.component.html',
  styleUrl: './audit-page.component.scss',
})
export class AuditPageComponent {
  private readonly audit = inject(AuditService);
  private readonly auth = inject(AuthService);
  private readonly usersService = inject(UsersService);
  private readonly translate = inject(TranslateService);
  private readonly language = inject(LanguageService).selectedLanguage;

  readonly pageSize = 25;
  readonly entries = signal<AuditEntry[]>([]);
  readonly page = signal(1);
  readonly totalPages = signal(1);
  readonly totalItems = signal(0);
  readonly loading = signal(false);
  readonly error = signal('');

  // filters
  dateFrom: Date | null = null;
  dateTo: Date | null = null;
  userId: string | null = null;
  action: string | null = null;

  /** Users for the filter: the full list with users.manage, otherwise the names seen so far. */
  private readonly knownUsers = signal<{ id: string; name: string }[]>([]);
  readonly userOptions = computed(() => this.knownUsers().map((user) => ({ label: user.name, value: user.id })));
  readonly actionOptions = computed(() => {
    this.language(); // labels follow the language
    return AUDIT_ACTIONS.map((action) => ({ label: this.actionLabel(action), value: action }));
  });

  constructor() {
    if (this.auth.has('users.manage')) {
      this.usersService.list().subscribe({
        next: ({ users }) => this.knownUsers.set(users.map((user) => ({ id: user._id, name: user.name }))),
        error: () => undefined,
      });
    }
    this.load(1);
  }

  search(): void {
    this.load(1);
  }

  reset(): void {
    this.dateFrom = null;
    this.dateTo = null;
    this.userId = null;
    this.action = null;
    this.load(1);
  }

  load(page: number): void {
    this.loading.set(true);
    this.error.set('');
    this.audit
      .list({
        page,
        limit: this.pageSize,
        from: this.dateFrom ? formatDate(this.dateFrom, 'yyyy-MM-dd', 'en') : undefined,
        to: this.dateTo ? formatDate(this.dateTo, 'yyyy-MM-dd', 'en') : undefined,
        userId: this.userId ?? undefined,
        action: this.action ?? undefined,
      })
      .subscribe({
        next: (result) => {
          this.entries.set(result.data ?? []);
          this.page.set(result.pagination?.page ?? page);
          this.totalPages.set(Math.max(1, result.pagination?.totalPages ?? 1));
          this.totalItems.set(result.pagination?.totalItems ?? 0);
          this.loading.set(false);
          this.rememberUsers(result.data ?? []);
        },
        error: (error) => {
          this.loading.set(false);
          this.error.set(errorMessage(error) || this.translate.instant('auth.errors.generic'));
        },
      });
  }

  actionLabel(action: string): string {
    const key = `audit.actions.${action}`;
    const text = this.translate.instant(key);
    return text && text !== key ? text : action;
  }

  entityLabel(entity: string | null | undefined): string {
    if (!entity) return '—';
    const key = `audit.entities.${entity}`;
    const text = this.translate.instant(key);
    return text && text !== key ? text : entity;
  }

  /** "username: x · role: cashier" — short, never more than ~120 characters. */
  detailsSummary(entry: AuditEntry): string {
    const details = entry.details;
    if (!details || typeof details !== 'object') return '';
    const parts = Object.entries(details)
      .filter(([, value]) => value !== null && value !== undefined && value !== '')
      .map(([key, value]) => `${this.detailKey(key)}: ${Array.isArray(value) ? value.join('، ') : typeof value === 'object' ? JSON.stringify(value) : String(value)}`);
    const text = parts.join(' · ');
    return text.length > 120 ? `${text.slice(0, 117)}…` : text;
  }

  private detailKey(key: string): string {
    const i18nKey = `audit.details.${key}`;
    const text = this.translate.instant(i18nKey);
    return text && text !== i18nKey ? text : key;
  }

  private rememberUsers(entries: AuditEntry[]): void {
    if (this.auth.has('users.manage')) return;
    const known = new Map(this.knownUsers().map((user) => [user.id, user.name]));
    for (const entry of entries) {
      if (entry.userId && entry.userName && !known.has(entry.userId)) known.set(entry.userId, entry.userName);
    }
    this.knownUsers.set([...known.entries()].map(([id, name]) => ({ id, name })));
  }
}
