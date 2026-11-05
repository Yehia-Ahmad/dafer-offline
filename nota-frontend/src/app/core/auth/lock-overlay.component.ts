import { ChangeDetectionStrategy, Component, ElementRef, computed, effect, inject, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { NotaButtonDirective } from '../../modules/shared/ui';
import { toImageSrc } from '../../modules/shop-profile/utils/invoice-branding.util';
import { UnsavedWorkService } from '../unsaved-work/unsaved-work.service';
import { AuthService } from './auth.service';
import { errorCode, errorMessage, lockedMinutes } from './auth-errors';
import { IdleLockService } from './idle-lock.service';

/**
 * Stage 15: the lock screen. An overlay over the app, not a navigation: the page under it (a POS
 * cart, a half-filled form) stays mounted and keeps its state. Unlocking needs the same user's
 * password (POST /api/auth/verify-password: same lockout as login, 5 tries → 429). "دخول بمستخدم
 * تاني" warns about unsaved work, signs out and opens the sign-in screen.
 */
@Component({
  selector: 'nota-lock-overlay',
  imports: [FormsModule, TranslatePipe, NotaButtonDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './lock-overlay.component.html',
  styleUrl: './lock-overlay.component.scss',
})
export class LockOverlayComponent {
  private readonly idle = inject(IdleLockService);
  private readonly auth = inject(AuthService);
  private readonly unsaved = inject(UnsavedWorkService);
  private readonly router = inject(Router);
  private readonly translate = inject(TranslateService);

  readonly visible = computed(() => this.idle.locked() && this.auth.signedIn());
  readonly userName = computed(() => this.auth.user()?.name || '');
  readonly logoSrc = computed(() => toImageSrc(this.idle.shopLogo()));
  readonly shopName = computed(() => this.idle.shopName());

  readonly password = signal('');
  readonly showPassword = signal(false);
  readonly busy = signal(false);
  readonly error = signal('');

  private readonly input = viewChild<ElementRef<HTMLInputElement>>('passwordInput');

  constructor() {
    effect(() => {
      if (!this.visible()) return;
      const input = this.input();
      if (input) setTimeout(() => input.nativeElement.focus());
    });
  }

  unlock(): void {
    if (this.busy()) return;
    if (!this.password()) {
      this.error.set(this.translate.instant('auth.validation.passwordRequired'));
      return;
    }
    this.busy.set(true);
    this.error.set('');
    this.idle.unlock(this.password()).subscribe({
      next: () => {
        this.busy.set(false);
        this.password.set('');
        this.showPassword.set(false);
      },
      error: (error) => {
        this.busy.set(false);
        this.password.set('');
        const code = errorCode(error);
        if (code === 'LOGIN_LOCKED') {
          this.error.set(this.translate.instant('auth.errors.LOGIN_LOCKED', { minutes: lockedMinutes(error) }));
        } else if (code === 'WRONG_PASSWORD') {
          this.error.set(this.translate.instant('session.lock.wrongPassword'));
        } else {
          this.error.set(errorMessage(error) || this.translate.instant('session.lock.failed'));
        }
      },
    });
  }

  /** Signs out (after the unsaved-work warning) and opens the sign-in screen. */
  async switchUser(): Promise<void> {
    if (this.busy()) return;
    if (!(await this.unsaved.confirm())) return;
    this.unsaved.allowNextNavigation();
    this.password.set('');
    this.error.set('');
    this.auth.logout();
    await this.router.navigate(['/login']);
  }
}
