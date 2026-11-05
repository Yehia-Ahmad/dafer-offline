import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { DialogModule } from 'primeng/dialog';
import { forkJoin } from 'rxjs';
import { AuthService } from '../../../core/auth/auth.service';
import { AuthUser, PermissionCatalog } from '../../../core/auth/auth.models';
import { errorMessage } from '../../../core/auth/auth-errors';
import { ToastService } from '../../../core/auth/toast.service';
import { LanguageService } from '../../shared/services/translation.service';
import { NotaButtonDirective, NotaDialogShellComponent, NotaFormFieldComponent, NotaPageHeaderComponent } from '../../shared/ui';
import { passwordProblemKey } from '../../auth/auth-form.util';
import { UserFormDialogComponent, mapUserError } from '../user-form-dialog/user-form-dialog.component';
import { UsersService } from '../users.service';
import { RowActions, rowActions } from '../user-rules';

/**
 * Stage 14: /users (users.manage), Users.dc.html as a table. Edit, reset password (not on your own
 * row), disable/enable. The owner row has no disable and no role change; only the owner edits it.
 * Disable and reset log that user out everywhere: the confirm dialog says so.
 */
@Component({
  selector: 'app-users-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, FormsModule, TranslatePipe, DialogModule, NotaPageHeaderComponent, NotaButtonDirective, NotaDialogShellComponent,
    NotaFormFieldComponent, UserFormDialogComponent],
  templateUrl: './users-page.component.html',
  styleUrl: './users-page.component.scss',
})
export class UsersPageComponent {
  private readonly auth = inject(AuthService);
  private readonly usersService = inject(UsersService);
  private readonly translate = inject(TranslateService);
  private readonly toast = inject(ToastService);
  private readonly language = inject(LanguageService).selectedLanguage;

  readonly me = this.auth.user;
  readonly users = signal<AuthUser[]>([]);
  readonly catalog = signal<PermissionCatalog | null>(null);
  readonly loading = signal(true);
  readonly loadError = signal('');

  // add / edit
  readonly formOpen = signal(false);
  readonly editing = signal<AuthUser | null>(null);

  // disable / enable
  readonly statusTarget = signal<AuthUser | null>(null);
  readonly statusBusy = signal(false);

  // reset password
  readonly resetTarget = signal<AuthUser | null>(null);
  readonly resetPassword = signal('');
  readonly resetConfirm = signal('');
  readonly resetError = signal('');
  readonly resetBusy = signal(false);

  readonly rows = computed(() => this.users().map((user) => ({ user, actions: rowActions(user, this.me()) as RowActions })));

  constructor() {
    this.load();
  }

  load(): void {
    this.loading.set(true);
    this.loadError.set('');
    forkJoin({ list: this.usersService.list(), catalog: this.auth.permissionCatalog() }).subscribe({
      next: ({ list, catalog }) => {
        this.users.set(list.users);
        this.catalog.set(catalog);
        this.loading.set(false);
      },
      error: (error) => {
        this.loading.set(false);
        this.loadError.set(errorMessage(error) || this.translate.instant('auth.errors.generic'));
      },
    });
  }

  roleLabel(user: AuthUser): string {
    const entry = this.catalog()?.roles.find((item) => item.role === user.role);
    if (!entry) return user.role;
    return this.language() === 'en' ? entry.en : entry.ar;
  }

  /** Edited template list (custom roles are their own list, not "edited"). */
  isCustomized(user: AuthUser): boolean {
    return user.role === 'custom' || (user.role !== 'owner' && user.permissionsEdited);
  }

  isMe(user: AuthUser): boolean {
    return user._id === this.me()?._id;
  }

  openCreate(): void {
    this.editing.set(null);
    this.formOpen.set(true);
  }

  openEdit(user: AuthUser): void {
    this.editing.set(user);
    this.formOpen.set(true);
  }

  onSaved(saved: AuthUser): void {
    const exists = this.users().some((user) => user._id === saved._id);
    this.users.update((list) => (exists ? list.map((user) => (user._id === saved._id ? saved : user)) : [...list, saved]));
    this.toast.show(this.translate.instant(exists ? 'users.messages.updated' : 'users.messages.created', { name: saved.name }), 'success');
    // Editing yourself (e.g. your own name): refresh the sidebar card and permissions.
    if (this.isMe(saved)) this.auth.refreshMe().subscribe({ error: () => undefined });
  }

  // ---- disable / enable ----
  askStatus(user: AuthUser): void {
    if (user.isActive) {
      this.statusTarget.set(user); // disabling logs them out: confirm first
    } else {
      this.applyStatus(user, true);
    }
  }

  confirmDisable(): void {
    const user = this.statusTarget();
    if (user) this.applyStatus(user, false);
  }

  private applyStatus(user: AuthUser, isActive: boolean): void {
    this.statusBusy.set(true);
    this.usersService.setStatus(user._id, isActive).subscribe({
      next: ({ user: saved }) => {
        this.statusBusy.set(false);
        this.statusTarget.set(null);
        this.users.update((list) => list.map((item) => (item._id === saved._id ? saved : item)));
        this.toast.show(this.translate.instant(isActive ? 'users.messages.enabled' : 'users.messages.disabled', { name: saved.name }), 'success');
      },
      error: (error) => {
        this.statusBusy.set(false);
        this.statusTarget.set(null);
        const mapped = mapUserError(error, this.translate);
        this.toast.error(Object.values(mapped).find(Boolean) ?? this.translate.instant('auth.errors.generic'));
      },
    });
  }

  // ---- reset password ----
  askReset(user: AuthUser): void {
    this.resetPassword.set('');
    this.resetConfirm.set('');
    this.resetError.set('');
    this.resetTarget.set(user);
  }

  closeReset(): void {
    if (!this.resetBusy()) this.resetTarget.set(null);
  }

  confirmReset(): void {
    const user = this.resetTarget();
    if (!user || this.resetBusy()) return;
    const problem = passwordProblemKey(this.resetPassword());
    if (problem) return this.resetError.set(this.translate.instant(problem));
    if (this.resetPassword() !== this.resetConfirm()) return this.resetError.set(this.translate.instant('auth.validation.passwordMismatch'));
    this.resetError.set('');
    this.resetBusy.set(true);
    this.usersService.resetPassword(user._id, this.resetPassword()).subscribe({
      next: () => {
        this.resetBusy.set(false);
        this.resetTarget.set(null);
        this.toast.show(this.translate.instant('users.messages.passwordReset', { name: user.name }), 'success');
      },
      error: (error) => {
        this.resetBusy.set(false);
        const mapped = mapUserError(error, this.translate);
        this.resetError.set(mapped.password || Object.values(mapped).find(Boolean) || this.translate.instant('auth.errors.generic'));
      },
    });
  }
}
