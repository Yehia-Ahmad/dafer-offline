import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/** ok = paid, due = due/partial, overdue = overdue/cancelled, info = returned/info, neutral. */
export type NotaPillVariant = 'ok' | 'due' | 'overdue' | 'info' | 'neutral';

/** Status pill: `<nota-status-pill variant="due">جزئي</nota-status-pill>`. */
@Component({
  selector: 'nota-status-pill',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '[class]': 'classes()' },
  template: `<ng-content />`,
})
export class NotaStatusPillComponent {
  readonly variant = input<NotaPillVariant>('neutral');
  protected readonly classes = computed(() => `nota-pill nota-pill--${this.variant()}`);
}
