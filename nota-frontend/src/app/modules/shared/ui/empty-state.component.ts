import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/** Empty state: icon (Font Awesome classes), title, text, and projected actions. */
@Component({
  selector: 'nota-empty-state',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'nota-empty' },
  template: `
    <span class="nota-empty__icon" aria-hidden="true"><i [class]="icon()"></i></span>
    <h3 class="nota-empty__title">{{ title() }}</h3>
    @if (text()) {
      <p class="nota-empty__text">{{ text() }}</p>
    }
    <ng-content />
  `,
})
export class NotaEmptyStateComponent {
  readonly title = input.required<string>();
  readonly text = input('');
  readonly icon = input('fa-solid fa-inbox');
}
