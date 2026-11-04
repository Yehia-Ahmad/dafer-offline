import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * Card surface (--surface, 1px --border, radius 16). Optional section title and
 * a `[notaCardActions]` slot next to it. The `.nota-card` class alone works too.
 */
@Component({
  selector: 'nota-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'nota-card' },
  styles: `
    :host { display: flex; flex-direction: column; gap: 16px; }
    .nota-card__head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  `,
  template: `
    @if (title()) {
      <div class="nota-card__head">
        <h2 class="nota-section-title">{{ title() }}</h2>
        <ng-content select="[notaCardActions]" />
      </div>
    }
    <ng-content />
  `,
})
export class NotaCardComponent {
  readonly title = input('');
}
