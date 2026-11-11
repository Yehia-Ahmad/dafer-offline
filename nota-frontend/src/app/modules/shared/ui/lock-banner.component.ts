import { ChangeDetectionStrategy, Component, Directive, computed, inject, input } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { LockDateService } from '../../../core/accounting-lock/lock-date.service';

/**
 * Stage 22: on a posting form, a native date input gets `min` = the first open day (locked days are greyed out in the picker).
 * For PrimeNG's p-datepicker use `[minDate]="lock.minOpenDate()"`.
 */
@Directive({
  selector: 'input[type=date][notaLockedDate]',
  standalone: true,
  host: { '[attr.min]': 'lock.minOpenKey()' },
})
export class NotaLockedDateDirective {
  protected readonly lock = inject(LockDateService);
}

/**
 * Stage 22: "الفترة دي مقفولة لحد dd/mm/yyyy" under the date of a posting form while a period is closed. With `selected` set to a
 * locked day it turns into the error ("اختار تاريخ بعد …"). Shows nothing while no period is closed.
 */
@Component({
  selector: 'nota-lock-banner',
  imports: [TranslatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'nota-lock-banner-host' },
  template: `
    @if (lock.lockedThrough()) {
      <p class="nota-lock-banner" [class.nota-lock-banner--blocked]="blocked()" role="status" data-test="lock-banner">
        {{ (blocked() ? 'lock.selectedLocked' : 'lock.banner') | translate: { date: lock.label() } }}
      </p>
    }
  `,
  styles: `
    .nota-lock-banner { margin: 6px 0 0; padding: 8px 12px; border-radius: var(--radius-control); background: var(--warning-soft); color: var(--warning-text); font-size: 13px; }
    .nota-lock-banner--blocked { background: var(--danger-soft); color: var(--danger-text); font-weight: 700; }
  `,
})
export class NotaLockBannerComponent {
  protected readonly lock = inject(LockDateService);
  /** The day the form is about to post on (YYYY-MM-DD or a Date). */
  readonly selected = input<string | Date | null>(null);
  protected readonly blocked = computed(() => this.lock.isLocked(this.selected()));
}
