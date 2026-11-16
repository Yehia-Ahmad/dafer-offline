import { AfterViewInit, ChangeDetectionStrategy, Component, ElementRef, computed, inject, signal, viewChild } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { AuthService } from '../../../core/auth/auth.service';
import { BootstrapInfo } from '../../../core/auth/auth.models';
import { brandName } from '../../../core/brand';
import { LanguageService } from '../../shared/services/translation.service';
import { ThemeService } from '../../shared/services/theme.service';
import { NotaButtonDirective, NotaFormFieldComponent } from '../../shared/ui';
import { toImageSrc } from '../../shop-profile/utils/invoice-branding.util';
import { authErrorText } from '../auth-form.util';

export type LoginView = 'loading' | 'unreachable' | 'login' | 'noOwner';

import { LayoutService } from '../../../core/layout/layout.service';

/**
 * Stage 14 (Login.dc.html): sign in. The owner account is created on the server
 * (`npm run create-owner`), never from this screen; until it exists the page says so.
 * Outside the app frame. Nothing here is remembered across app restarts (no "remember me").
 */
@Component({
  selector: 'app-login-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, TranslatePipe, NotaButtonDirective, NotaFormFieldComponent],
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
  protected readonly layout = inject(LayoutService);

  readonly language = this.languageService.selectedLanguage;
  readonly brand = computed(() => brandName(this.language()));
  readonly isDark = toSignal(this.themeService.isDarkMode$, { initialValue: false });

  readonly view = signal<LoginView>('loading');
  readonly info = signal<BootstrapInfo | null>(null);
  readonly shopName = computed(() => this.info()?.shop.name || '');
  readonly logoSrc = computed(() => toImageSrc(this.info()?.shop.logo));
  readonly expired = this.route.snapshot.queryParamMap.get('reason') === 'expired';

  // sign in
  readonly username = signal('');
  readonly password = signal('');
  readonly showPassword = signal(false);

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
        this.show(info.hasOwner ? 'login' : 'noOwner');
      },
      error: () => this.view.set('unreachable'),
    });
  }

  show(view: LoginView): void {
    this.view.set(view);
    this.error.set('');
    this.fieldErrors.set({});
    this.password.set('');
    this.focusFirst();
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

  /** After sign in. */
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
