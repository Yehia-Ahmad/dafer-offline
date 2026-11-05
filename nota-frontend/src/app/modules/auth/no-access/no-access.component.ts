import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Router } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { AuthService } from '../../../core/auth/auth.service';
import { NotaButtonDirective } from '../../shared/ui';

/** Stage 14: a signed-in user who may open no page at all (custom role with an empty list). */
@Component({
  selector: 'app-no-access',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslatePipe, NotaButtonDirective],
  host: { class: 'nota-auth-page nota-auth-page--center' },
  template: `
    <div class="nota-card nota-auth-card">
      <h1 class="nota-auth-card__title">{{ 'auth.noAccess.title' | translate }}</h1>
      <p class="nota-auth-card__lead">{{ 'auth.noAccess.text' | translate: { name: auth.user()?.name ?? '' } }}</p>
      <button type="button" notaButton="primary" (click)="logout()">{{ 'auth.logout' | translate }}</button>
    </div>
  `,
})
export class NoAccessComponent {
  protected readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  logout(): void {
    this.auth.logout();
    this.router.navigate(['/login']);
  }
}
