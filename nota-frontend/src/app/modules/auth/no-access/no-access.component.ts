import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Router } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { AuthService } from '../../../core/auth/auth.service';
import { NotaButtonDirective } from '../../shared/ui';
import { LayoutService } from '../../../core/layout/layout.service';

/** Stage 14: a signed-in user who may open no page at all (custom role with an empty list). */
@Component({
  selector: 'app-no-access',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslatePipe, NotaButtonDirective],
  host: { class: 'nota-auth-page nota-auth-page--center' },
  template: `
@if (layout.isMobile()) {
    <div class="m-card" style="width:100%;display:flex;flex-direction:column;gap:14px;text-align:center;padding:24px 16px">
      <h1 class="m-head__title" style="font-size:20px">{{ 'auth.noAccess.title' | translate }}</h1>
      <p class="m-muted" style="line-height:1.7">{{ 'auth.noAccess.text' | translate: { name: auth.user()?.name ?? '' } }}</p>
      <button type="button" class="m-btn m-btn--primary m-btn--lg m-btn--block" (click)="logout()">{{ 'auth.logout' | translate }}</button>
    </div>
} @else {

    <div class="nota-card nota-auth-card">
      <h1 class="nota-auth-card__title">{{ 'auth.noAccess.title' | translate }}</h1>
      <p class="nota-auth-card__lead">{{ 'auth.noAccess.text' | translate: { name: auth.user()?.name ?? '' } }}</p>
      <button type="button" notaButton="primary" (click)="logout()">{{ 'auth.logout' | translate }}</button>
    </div>
  }
  `,
})
export class NoAccessComponent {
  protected readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  protected readonly layout = inject(LayoutService);

  logout(): void {
    this.auth.logout();
    this.router.navigate(['/login']);
  }
}
