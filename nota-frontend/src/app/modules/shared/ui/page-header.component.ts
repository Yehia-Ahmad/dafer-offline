import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';

/**
 * Page title (28/800), optional subtitle, optional back link, and an actions slot
 * (`<div notaPageActions>…buttons…</div>`).
 */
@Component({
  selector: 'nota-page-header',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'nota-page-header' },
  template: `
    <div class="nota-page-header__text">
      @if (backLink()) {
        <a class="nota-page-header__back" [routerLink]="backLink()" [queryParams]="backQueryParams()">
          <span class="nota-page-header__back-icon" aria-hidden="true">←</span>
          {{ backLabel() }}
        </a>
      }
      <h1 class="nota-page-header__title">{{ title() }}</h1>
      @if (subtitle()) {
        <span class="nota-page-header__subtitle">{{ subtitle() }}</span>
      }
    </div>
    <div class="nota-page-header__actions">
      <ng-content select="[notaPageActions]" />
    </div>
  `,
})
export class NotaPageHeaderComponent {
  readonly title = input.required<string>();
  readonly subtitle = input('');
  readonly backLink = input<string | readonly unknown[] | null>(null);
  readonly backLabel = input('');
  /** Query params of the back link (e.g. the products list's selected category). */
  readonly backQueryParams = input<Record<string, string> | null>(null);
}
