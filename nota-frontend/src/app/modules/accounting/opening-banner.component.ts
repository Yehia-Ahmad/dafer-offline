import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { NotaButtonDirective } from '../shared/ui';
import { OpeningService } from './opening.service';

/**
 * Stage 18: the dashboard banner "لسه مسجلتش رصيد بداية المحل". The dashboard shows it only to users with
 * accounting.manage (and accounting.view, which the status request needs) while the opening is still in `setup`.
 * A failed request shows nothing: the banner is a nudge, never an error.
 */
@Component({
  selector: 'app-opening-banner',
  standalone: true,
  imports: [RouterLink, TranslatePipe, NotaButtonDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (pending()) {
      <section class="nota-card ob" role="status" data-test="opening-banner">
        <span class="ob__text">{{ 'openingWizard.banner.text' | translate }}</span>
        <a notaButton="primary" routerLink="/accounting/opening" data-action="open-wizard">{{ 'openingWizard.banner.action' | translate }}</a>
      </section>
    }
  `,
  styles: [`
    :host { display: block; }
    .ob { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 18px; border-color: var(--accent); }
    .ob__text { font-weight: 700; }
  `],
})
export class OpeningBannerComponent implements OnInit {
  private readonly opening = inject(OpeningService);
  readonly pending = signal(false);

  ngOnInit(): void {
    this.opening.get().subscribe({
      next: (state) => this.pending.set(state.status === 'setup'),
      error: () => this.pending.set(false),
    });
  }
}
