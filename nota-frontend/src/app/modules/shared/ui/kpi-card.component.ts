import { ChangeDetectionStrategy, Component, input } from '@angular/core';

export type NotaKpiNoteTone = 'neutral' | 'success' | 'danger' | 'warning';

/** KPI card: muted label, big tabular value (format it first, e.g. with notaMoney), optional note line. */
@Component({
  selector: 'nota-kpi-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'nota-kpi' },
  template: `
    <span class="nota-kpi__label">{{ label() }}</span>
    <span class="nota-kpi__value num">{{ value() }}</span>
    @if (note()) {
      <span [class]="'nota-kpi__note nota-kpi__note--' + noteTone()">{{ note() }}</span>
    }
  `,
})
export class NotaKpiCardComponent {
  readonly label = input.required<string>();
  readonly value = input<string | number | null>('');
  readonly note = input('');
  readonly noteTone = input<NotaKpiNoteTone>('neutral');
}
