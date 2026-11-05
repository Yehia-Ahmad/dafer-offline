import { ChangeDetectionStrategy, Component, computed, effect, inject, input, model, output, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { DialogModule } from 'primeng/dialog';
import { AuthService } from '../../../core/auth/auth.service';
import { AuthUser, CatalogPermission, PermissionCatalog, RoleKey } from '../../../core/auth/auth.models';
import { errorCode, errorMessage } from '../../../core/auth/auth-errors';
import { LanguageService } from '../../shared/services/translation.service';
import { NotaButtonDirective, NotaDialogShellComponent, NotaFormFieldComponent } from '../../shared/ui';
import { passwordProblemKey } from '../../auth/auth-form.util';
import { CreateUserPayload, UpdateUserPayload, UsersService } from '../users.service';
import { sameKeys } from '../user-rules';

type EditableRole = Exclude<RoleKey, 'owner'>;
type FieldKey = 'name' | 'username' | 'password' | 'confirm' | 'role' | 'permissions' | 'maxDiscount' | 'general';

/** Roles offered in the form, in the design's order (no owner: there is only ever one). */
export const FORM_ROLES: readonly EditableRole[] = ['cashier', 'storekeeper', 'accountant', 'manager', 'custom'];

interface PermissionGroupView {
  key: string;
  label: string;
  items: { key: string; label: string; held: boolean }[];
}

/**
 * Stage 14 (AddUser.dc.html): create a user, or edit name / role / permissions.
 * - Choosing a role fills in its template; changing a checkbox marks the list as edited and shows
 *   "رجوع لصلاحيات الدور".
 * - Permissions the signed-in user does not hold are disabled (the backend refuses to grant them).
 * - Server errors map to their fields (USERNAME_TAKEN, PERMISSION_NOT_HELD, OWNER_PROTECTED, CANNOT_CHANGE_SELF).
 * - A role/permission change logs that user out: the admin confirms first.
 */
@Component({
  selector: 'nota-user-form-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, TranslatePipe, DialogModule, NotaDialogShellComponent, NotaFormFieldComponent, NotaButtonDirective],
  templateUrl: './user-form-dialog.component.html',
  styleUrl: './user-form-dialog.component.scss',
})
export class UserFormDialogComponent {
  private readonly auth = inject(AuthService);
  private readonly users = inject(UsersService);
  private readonly translate = inject(TranslateService);
  private readonly language = inject(LanguageService).selectedLanguage;

  readonly open = model(false);
  /** null: new user. */
  readonly user = input<AuthUser | null>(null);
  readonly catalog = input<PermissionCatalog | null>(null);
  readonly saved = output<AuthUser>();

  readonly roles = FORM_ROLES;
  readonly name = signal('');
  readonly username = signal('');
  readonly password = signal('');
  readonly confirm = signal('');
  readonly role = signal<EditableRole>('cashier');
  readonly selected = signal<readonly string[]>([]);
  /** Stage 15: "أقصى خصم مسموح" in percent; empty = no limit. Only with sales.discount. */
  readonly maxDiscount = signal('');
  readonly saving = signal(false);
  readonly confirming = signal(false);
  readonly errors = signal<Partial<Record<FieldKey, string>>>({});
  /** Keys the server refused (PERMISSION_NOT_HELD). */
  readonly refusedKeys = signal<readonly string[]>([]);

  readonly isNew = computed(() => !this.user());
  readonly isOwnerRow = computed(() => this.user()?.role === 'owner');
  readonly template = computed(() => this.catalog()?.roles.find((entry) => entry.role === this.role())?.permissions ?? []);
  /** A template role whose list no longer equals the template. */
  readonly edited = computed(() => this.role() !== 'custom' && !sameKeys(this.selected(), this.template()));
  /** Stage 15: the limit field shows under the discount permission (never for the owner). */
  readonly showMaxDiscount = computed(() => !this.isOwnerRow() && this.effectiveSelection().includes('sales.discount'));
  private initialState = '';
  readonly hasUnheld = computed(() => this.groups().some((group) => group.items.some((item) => !item.held)));

  readonly groups = computed<PermissionGroupView[]>(() => {
    const catalog = this.catalog();
    if (!catalog) return [];
    const lang = this.language() === 'en' ? 'en' : 'ar';
    const byGroup = new Map<string, CatalogPermission[]>();
    for (const permission of catalog.permissions) {
      byGroup.set(permission.group, [...(byGroup.get(permission.group) ?? []), permission]);
    }
    return [...byGroup.entries()].map(([key, items]) => ({
      key,
      label: catalog.groups[key]?.[lang] ?? key,
      items: items.map((item) => ({ key: item.key, label: item[lang], held: this.auth.has(item.key) })),
    }));
  });

  readonly roleLabel = (role: string): string => {
    const entry = this.catalog()?.roles.find((item) => item.role === role);
    return entry ? (this.language() === 'en' ? entry.en : entry.ar) : role;
  };

  constructor() {
    // Each time the dialog opens: fill the form from the row (edit) or the defaults (new).
    effect(() => {
      if (!this.open()) return;
      const user = this.user();
      untracked(() => this.fill(user));
    });
  }

  private fill(user: AuthUser | null): void {
    this.errors.set({});
    this.refusedKeys.set([]);
    this.confirming.set(false);
    this.saving.set(false);
    this.password.set('');
    this.confirm.set('');
    this.maxDiscount.set(typeof user?.maxDiscountPercent === 'number' ? String(user.maxDiscountPercent) : '');
    if (user) {
      this.name.set(user.name);
      this.username.set(user.username);
      this.role.set(user.role === 'owner' ? 'manager' : (user.role as EditableRole));
      this.selected.set([...(user.permissions ?? [])]);
    } else {
      this.name.set('');
      this.username.set('');
      this.role.set('cashier');
      this.selected.set([...this.templateFor('cashier')]);
    }
    this.initialState = this.formState();
  }

  private formState(): string {
    return JSON.stringify([this.name(), this.username(), this.password(), this.confirm(), this.role(), this.selected(), this.maxDiscount()]);
  }

  /** Stage 15: the open form has changes that were not saved (UnsavedWorkService, via the users page). */
  isDirty(): boolean {
    return this.open() && !this.saving() && this.formState() !== this.initialState;
  }

  /** The limit as a number, null for none, or undefined when the text is not 0–100. */
  private parsedMaxDiscount(): number | null | undefined {
    const text = this.maxDiscount().trim().replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace('٫', '.');
    if (!text) return null;
    const value = Number(text);
    return Number.isFinite(value) && value >= 0 && value <= 100 ? Math.round(value * 100) / 100 : undefined;
  }

  private templateFor(role: string): readonly string[] {
    return this.catalog()?.roles.find((entry) => entry.role === role)?.permissions ?? [];
  }

  isChecked(key: string): boolean {
    return this.isOwnerRow() || this.selected().includes(key);
  }

  /** Choosing a role fills in its template (custom keeps the current list as a starting point). */
  chooseRole(role: EditableRole): void {
    this.role.set(role);
    if (role !== 'custom') this.selected.set([...this.templateFor(role)]);
    this.clearError('role');
    this.clearError('permissions');
  }

  toggle(key: string, checked: boolean): void {
    if (!this.auth.has(key)) return; // disabled in the form; the backend would refuse it anyway
    const next = new Set(this.selected());
    if (checked) next.add(key);
    else next.delete(key);
    const order = this.catalog()?.permissions.map((permission) => permission.key) ?? [];
    this.selected.set(order.filter((item) => next.has(item)));
    this.clearError('permissions');
  }

  revertToTemplate(): void {
    this.selected.set([...this.template()]);
    this.clearError('permissions');
  }

  /** Effective permissions as the backend would store them. */
  effectiveSelection(): string[] {
    return this.role() === 'custom' || this.edited() ? [...this.selected()] : [...this.template()];
  }

  /** Does saving change this user's role or permissions (which logs them out everywhere)? */
  accessChanges(): boolean {
    const user = this.user();
    if (!user || user.role === 'owner') return false;
    if (user.role !== this.role()) return true;
    if (Boolean(user.permissionsEdited) !== this.edited()) return true;
    return !sameKeys(user.permissions ?? [], this.effectiveSelection());
  }

  submit(): void {
    if (this.saving()) return;
    const errors: Partial<Record<FieldKey, string>> = {};
    if (!this.name().trim()) errors.name = this.translate.instant('auth.validation.nameRequired');
    if (this.isNew()) {
      if (!this.username().trim()) errors.username = this.translate.instant('auth.validation.usernameRequired');
      else if (/\s/.test(this.username().trim())) errors.username = this.translate.instant('auth.validation.usernameSpaces');
      const problem = passwordProblemKey(this.password());
      if (problem) errors.password = this.translate.instant(problem);
      if (this.confirm() !== this.password()) errors.confirm = this.translate.instant('auth.validation.passwordMismatch');
    }
    if (this.showMaxDiscount() && this.parsedMaxDiscount() === undefined) {
      errors.maxDiscount = this.translate.instant('session.discount.limitInvalid');
    }
    this.errors.set(errors);
    this.refusedKeys.set([]);
    if (Object.keys(errors).length) return;
    if (!this.isNew() && this.accessChanges() && !this.confirming()) {
      this.confirming.set(true);
      return;
    }
    this.save();
  }

  /** The request body (also used by the payload specs). */
  buildPayload(): CreateUserPayload | UpdateUserPayload {
    const sendList = this.role() === 'custom' || this.edited();
    const limit = this.showMaxDiscount() ? this.parsedMaxDiscount() : undefined;
    if (this.isNew()) {
      return {
        name: this.name().trim(),
        username: this.username().trim(),
        password: this.password(),
        role: this.role(),
        ...(sendList ? { permissions: [...this.selected()] } : {}),
        ...(typeof limit === 'number' ? { maxDiscountPercent: limit } : {}),
      };
    }
    if (this.isOwnerRow()) return { name: this.name().trim() };
    const stored = typeof this.user()?.maxDiscountPercent === 'number' ? this.user()!.maxDiscountPercent : null;
    return {
      name: this.name().trim(),
      role: this.role(),
      ...(sendList ? { permissions: [...this.selected()] } : {}),
      ...(limit !== undefined && limit !== stored ? { maxDiscountPercent: limit } : {}),
    };
  }

  private save(): void {
    this.saving.set(true);
    const user = this.user();
    const payload = this.buildPayload();
    const request = user ? this.users.update(user._id, payload as UpdateUserPayload) : this.users.create(payload as CreateUserPayload);
    request.subscribe({
      next: (result) => {
        this.saving.set(false);
        this.confirming.set(false);
        this.saved.emit(result.user);
        this.open.set(false);
      },
      error: (error) => {
        this.saving.set(false);
        this.confirming.set(false);
        this.errors.set(mapUserError(error, this.translate));
        const refused = (error as { error?: { permissions?: unknown } })?.error?.permissions;
        this.refusedKeys.set(Array.isArray(refused) ? refused.filter((key): key is string => typeof key === 'string') : []);
      },
    });
  }

  close(): void {
    if (this.saving()) return;
    this.open.set(false);
  }

  private clearError(field: FieldKey): void {
    if (this.errors()[field]) this.errors.update((errors) => ({ ...errors, [field]: undefined }));
  }
}

/** Server error → the field it belongs to. */
export function mapUserError(error: unknown, translate: TranslateService): Partial<Record<FieldKey, string>> {
  const code = errorCode(error);
  const text = (key: string) => translate.instant(key);
  switch (code) {
    case 'USERNAME_TAKEN':
      return { username: text('users.errors.USERNAME_TAKEN') };
    case 'PERMISSION_NOT_HELD':
      return { permissions: text('users.errors.PERMISSION_NOT_HELD') };
    case 'VALIDATION_ERROR':
      return /خصم/.test(errorMessage(error)) ? { maxDiscount: errorMessage(error) } : { general: errorMessage(error) || text('auth.errors.generic') };
    case 'OWNER_PROTECTED':
      return { role: text('users.errors.OWNER_PROTECTED') };
    case 'CANNOT_CHANGE_SELF':
      return { permissions: text('users.errors.CANNOT_CHANGE_SELF') };
    case 'PASSWORD_INVALID':
      return { password: errorMessage(error) || text('auth.validation.passwordLength') };
    default:
      return { general: errorMessage(error) || text('auth.errors.generic') };
  }
}
