import { AfterViewInit, ChangeDetectionStrategy, Component, ElementRef, computed, inject, signal, viewChild } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { AuthService } from '../../../core/auth/auth.service';
import { BootstrapInfo } from '../../../core/auth/auth.models';
import { errorCode } from '../../../core/auth/auth-errors';
import { getDesktopRuntimeConfig } from '../../../core/runtime/runtime-config';
import { brandName } from '../../../core/brand';
import { LanguageService } from '../../shared/services/translation.service';
import { ThemeService } from '../../shared/services/theme.service';
import { NotaButtonDirective, NotaFormFieldComponent } from '../../shared/ui';
import { toImageSrc } from '../../shop-profile/utils/invoice-branding.util';
import { RecoveryCodeComponent } from '../recovery-code/recovery-code.component';
import { authErrorText, passwordProblemKey } from '../auth-form.util';

export type LoginView = 'loading' | 'unreachable' | 'login' | 'setup' | 'noOwnerClient' | 'recover' | 'recoverClient' | 'code';

/**
 * Stage 14 (Login.dc.html): sign in, the first run (owner account, main PC only), "forgot
 * password" with the recovery code (main PC only) and the one-time recovery-code screen.
 * Outside the app frame. Nothing here is remembered across app restarts (no "remember me").
 */
@Component({
  selector: 'app-login-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, TranslatePipe, NotaButtonDirective, NotaFormFieldComponent, RecoveryCodeComponent],
  templateUrl: './login-page.component.html',
  host: { class: 'nota-auth-page' },
})
export class LoginPageComponent implements AfterViewInit {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly translate = inject(TranslateService);
  private readonly languageService = inject(LanguageService);
  private readonly themeService = inject(ThemeService);

  readonly language = this.languageService.selectedLanguage;
  readonly brand = computed(() => brandName(this.language()));
  readonly isDark = toSignal(this.themeService.isDarkMode$, { initialValue: false });
  /** Main PC or the address of the main PC this client uses. */
  readonly runtime = getDesktopRuntimeConfig();
  readonly serverAddress = (() => {
    const url = this.runtime?.apiBaseUrl;
    if (!url || this.runtime?.role !== 'client') return '';
    try {
      return new URL(url).host;
    } catch {
      return '';
    }
  })();

  readonly view = signal<LoginView>('loading');
  readonly info = signal<BootstrapInfo | null>(null);
  readonly shopName = computed(() => this.info()?.shop.name || '');
  readonly logoSrc = computed(() => toImageSrc(this.info()?.shop.logo));
  readonly expired = this.route.snapshot.queryParamMap.get('reason') === 'expired';

  // sign in
  readonly username = signal('');
  readonly password = signal('');
  readonly showPassword = signal(false);
  // first run
  readonly ownerName = signal('');
  readonly confirmPassword = signal('');
  // recover
  readonly recoveryCode = signal('');
  // result of setup / recover
  readonly issuedCode = signal('');
  readonly issuedKind = signal<'setup' | 'recover'>('setup');

  readonly busy = signal(false);
  readonly error = signal('');
  readonly fieldErrors = signal<Record<string, string>>({});

  private readonly firstInput = viewChild<ElementRef<HTMLInputElement>>('firstInput');

  constructor() {
    this.loadBootstrap();
  }

  ngAfterViewInit(): void {
    this.focusFirst();
  }

  loadBootstrap(): void {
    this.view.set('loading');
    this.error.set('');
    this.auth.bootstrap().subscribe({
      next: (info) => {
        this.info.set(info);
        this.show(info.hasOwner ? 'login' : info.isLocal ? 'setup' : 'noOwnerClient');
      },
      error: () => this.view.set('unreachable'),
    });
  }

  show(view: LoginView): void {
    this.view.set(view);
    this.error.set('');
    this.fieldErrors.set({});
    this.password.set('');
    this.confirmPassword.set('');
    this.focusFirst();
  }

  openRecover(): void {
    this.show(this.info()?.isLocal ? 'recover' : 'recoverClient');
  }

  login(): void {
    if (this.busy()) return;
    const errors: Record<string, string> = {};
    if (!this.username().trim()) errors['username'] = 'auth.validation.usernameRequired';
    if (!this.password()) errors['password'] = 'auth.validation.passwordRequired';
    this.fieldErrors.set(errors);
    this.error.set('');
    if (Object.keys(errors).length) return;
    this.busy.set(true);
    this.auth.login(this.username().trim(), this.password()).subscribe({
      next: () => {
        this.busy.set(false);
        this.goIn();
      },
      error: (error) => {
        this.busy.set(false);
        this.password.set('');
        this.error.set(authErrorText(error, this.translate));
      },
    });
  }

  setupOwner(): void {
    if (this.busy()) return;
    const errors: Record<string, string> = {};
    if (!this.ownerName().trim()) errors['name'] = 'auth.validation.nameRequired';
    if (!this.username().trim()) errors['username'] = 'auth.validation.usernameRequired';
    else if (/\s/.test(this.username().trim())) errors['username'] = 'auth.validation.usernameSpaces';
    const passwordProblem = passwordProblemKey(this.password());
    if (passwordProblem) errors['password'] = passwordProblem;
    if (this.confirmPassword() !== this.password()) errors['confirm'] = 'auth.validation.passwordMismatch';
    this.fieldErrors.set(errors);
    this.error.set('');
    if (Object.keys(errors).length) return;
    this.busy.set(true);
    this.auth.setupOwner({ name: this.ownerName().trim(), username: this.username().trim(), password: this.password() }).subscribe({
      next: (result) => {
        this.busy.set(false);
        this.issuedKind.set('setup');
        this.issuedCode.set(result.recoveryCode ?? '');
        this.view.set('code');
      },
      error: (error) => {
        this.busy.set(false);
        const code = errorCode(error);
        if (code === 'OWNER_EXISTS') {
          // Someone created the owner meanwhile: sign in instead.
          this.info.update((info) => (info ? { ...info, hasOwner: true } : info));
          this.show('login');
        } else if (code === 'LOCAL_ONLY') {
          this.show('noOwnerClient');
        }
        this.error.set(authErrorText(error, this.translate));
      },
    });
  }

  recover(): void {
    if (this.busy()) return;
    const errors: Record<string, string> = {};
    if (!this.username().trim()) errors['username'] = 'auth.validation.usernameRequired';
    if (!this.recoveryCode().trim()) errors['code'] = 'auth.validation.codeRequired';
    const passwordProblem = passwordProblemKey(this.password());
    if (passwordProblem) errors['password'] = passwordProblem;
    if (this.confirmPassword() !== this.password()) errors['confirm'] = 'auth.validation.passwordMismatch';
    this.fieldErrors.set(errors);
    this.error.set('');
    if (Object.keys(errors).length) return;
    this.busy.set(true);
    this.auth
      .recover({ username: this.username().trim(), recoveryCode: this.recoveryCode().trim(), newPassword: this.password() })
      .subscribe({
        next: (result) => {
          this.busy.set(false);
          this.recoveryCode.set('');
          this.issuedKind.set('recover');
          this.issuedCode.set(result.recoveryCode ?? '');
          this.view.set('code');
        },
        error: (error) => {
          this.busy.set(false);
          if (errorCode(error) === 'LOCAL_ONLY') this.show('recoverClient');
          this.error.set(authErrorText(error, this.translate));
        },
      });
  }

  /** After sign in, or after the recovery code was acknowledged. */
  goIn(): void {
    const returnUrl = this.route.snapshot.queryParamMap.get('returnUrl');
    const safe = returnUrl && returnUrl.startsWith('/') && !returnUrl.startsWith('//') && !returnUrl.startsWith('/login');
    this.router.navigateByUrl(safe ? returnUrl : this.auth.firstAllowedPath());
  }

  setLanguage(lang: 'ar' | 'en'): void {
    if (this.language() !== lang) this.languageService.changeLanguage(lang);
  }

  toggleTheme(): void {
    this.themeService.toggleTheme();
  }

  private focusFirst(): void {
    setTimeout(() => this.firstInput()?.nativeElement.focus());
  }
}
