import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { ApiError } from '../core/api.service';
import { AuthService } from '../core/auth.service';
import { isEgyptianMobile, whatsappLink } from '../core/format';
import { AR } from '../core/i18n/ar';
import { SeoService } from '../core/seo.service';
import { SettingsStore } from '../core/settings.store';

/** /login and /register (route data `mode`): phone + password. */
@Component({
  selector: 'app-auth',
  imports: [FormsModule, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="wrap page narrow" style="max-width:460px">
      <h1 class="h1">{{ register() ? t.auth.registerTitle : t.auth.loginTitle }}</h1>
      <form class="card" (ngSubmit)="submit()" novalidate>
        @if (register()) {
          <label class="lb">{{ t.auth.name }}<input class="in" name="name" autocomplete="name" [(ngModel)]="name" /></label>
        }
        <label class="lb">{{ t.auth.phone }}<input class="in ltr" name="phone" type="tel" inputmode="tel" autocomplete="tel" [(ngModel)]="phone" /></label>
        <label class="lb">{{ t.auth.password }}<input class="in ltr" name="password" type="password" [autocomplete]="register() ? 'new-password' : 'current-password'" [(ngModel)]="password" />
          @if (register()) { <span class="muted" style="font-size:12px">{{ t.auth.passwordHint }}</span> }
        </label>
        @if (error()) { <p class="alert" role="alert">{{ error() }}</p> }
        <button type="submit" class="btn big block" [disabled]="busy()">{{ register() ? t.auth.register : t.auth.login }}</button>
        <p class="center">
          {{ register() ? t.auth.haveAccount : t.auth.noAccount }}
          <a [routerLink]="register() ? '/login' : '/register'">{{ register() ? t.auth.login : t.auth.register }}</a>
        </p>
        @if (!register() && forgot(); as link) { <a class="center" [href]="link" target="_blank" rel="noopener">{{ t.auth.forgot }}</a> }
      </form>
    </div>
  `,
})
export class AuthPage {
  protected readonly t = AR;
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly settings = inject(SettingsStore);
  readonly mode = input<'login' | 'register'>('login');
  protected readonly register = computed(() => this.mode() === 'register');
  protected name = '';
  protected phone = '';
  protected password = '';
  protected readonly error = signal('');
  protected readonly busy = signal(false);
  protected readonly forgot = computed(() => whatsappLink(this.settings.whatsapp(), `${AR.auth.forgotText} ${this.phone}`.trim()));

  constructor() {
    inject(SeoService).set({ title: AR.auth.loginTitle, path: '/login', noindex: true });
  }

  protected async submit(): Promise<void> {
    if (this.busy()) return;
    this.error.set('');
    if (!isEgyptianMobile(this.phone)) { this.error.set(AR.auth.errors['INVALID_PHONE']); return; }
    if (this.register() && !this.name.trim()) { this.error.set(AR.checkout.required); return; }
    this.busy.set(true);
    try {
      if (this.register()) await this.auth.register(this.name.trim(), this.phone.trim(), this.password);
      else await this.auth.login(this.phone.trim(), this.password);
      await this.router.navigateByUrl(history.state?.['returnUrl'] || '/account');
    } catch (error) {
      this.error.set(error instanceof ApiError ? (AR.auth.errors[error.code] || error.message || AR.auth.errors['default']) : AR.auth.errors['default']);
      this.busy.set(false);
    }
  }
}
