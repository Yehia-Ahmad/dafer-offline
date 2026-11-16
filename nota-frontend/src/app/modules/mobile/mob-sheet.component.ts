import { ChangeDetectionStrategy, Component, HostListener, input, model, output } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';

/** One removable chip above a list (Online Stage 6B): the active filters. */
export interface FilterChip {
  key: string;
  label: string;
}

/**
 * Online Stage 6B: the phone's bottom sheet (scrim + sheet + grip + title). Content goes in the default slot; a footer (action buttons)
 * in `[mobSheetFooter]`. Closes on the scrim, the ✕ button and Escape. Presentation only: the page keeps all state and logic.
 */
@Component({
  selector: 'nota-mob-sheet',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslatePipe],
  template: `
    @if (open()) {
      <div class="m-sheet__scrim" (click)="open.set(false)" data-testid="m-sheet-scrim"></div>
      <div class="m-sheet" role="dialog" aria-modal="true" [attr.aria-label]="title()" data-testid="m-sheet">
        <div class="m-sheet__grip"></div>
        <div class="m-sheet__head">
          <strong class="m-sheet__title">{{ title() }}</strong>
          <button type="button" class="m-sheet__close" (click)="open.set(false)" [attr.aria-label]="'mobile.common.close' | translate" data-testid="m-sheet-close">✕</button>
        </div>
        <div class="m-sheet__body"><ng-content /></div>
        <div class="m-sheet__foot"><ng-content select="[mobSheetFooter]" /></div>
      </div>
    }
  `,
})
export class MobSheetComponent {
  readonly open = model(false);
  readonly title = input('');

  @HostListener('document:keydown.escape')
  protected onEscape(): void {
    if (this.open()) this.open.set(false);
  }
}

/** Filters in a bottom sheet with "تطبيق" / "مسح". The page binds its own filter fields inside; it decides what apply / clear do. */
@Component({
  selector: 'nota-mob-filter-sheet',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MobSheetComponent, TranslatePipe],
  template: `
    <nota-mob-sheet [(open)]="open" [title]="title()">
      <ng-content />
      <div mobSheetFooter class="m-actions m-actions--sheet">
        <button type="button" class="m-btn" (click)="clear.emit()" data-testid="m-filter-clear">{{ 'mobile.common.clear' | translate }}</button>
        <button type="button" class="m-btn m-btn--primary" (click)="apply.emit(); open.set(false)" data-testid="m-filter-apply">{{ 'mobile.common.apply' | translate }}</button>
      </div>
    </nota-mob-sheet>
  `,
})
export class MobFilterSheetComponent {
  readonly open = model(false);
  readonly title = input('');
  readonly apply = output<void>();
  readonly clear = output<void>();
}

/** The active filters as removable chips above the list. Renders nothing when there are none. */
@Component({
  selector: 'nota-mob-filter-chips',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslatePipe],
  template: `
    @if (chips().length) {
      <div class="m-chips" data-testid="m-filter-chips">
        @for (chip of chips(); track chip.key) {
          <button type="button" class="m-chip is-active" (click)="remove.emit(chip.key)" [attr.aria-label]="('mobile.common.removeFilter' | translate) + ' ' + chip.label" [attr.data-chip]="chip.key">
            {{ chip.label }} <span aria-hidden="true">✕</span>
          </button>
        }
      </div>
    }
  `,
})
export class MobFilterChipsComponent {
  readonly chips = input<FilterChip[]>([]);
  readonly remove = output<string>();
}

/** A short confirmation sheet; the destructive action (delete, close period, reset password) is red. */
@Component({
  selector: 'nota-mob-confirm',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MobSheetComponent, TranslatePipe],
  template: `
    <nota-mob-sheet [(open)]="open" [title]="title()">
      <p class="m-confirm__text">{{ message() }}</p>
      <div mobSheetFooter class="m-actions m-actions--sheet">
        <button type="button" class="m-btn" (click)="open.set(false)" data-testid="m-confirm-cancel">{{ 'mobile.common.cancel' | translate }}</button>
        <button type="button" class="m-btn" [class.m-btn--danger]="destructive()" [class.m-btn--primary]="!destructive()" (click)="confirmed.emit(); open.set(false)" data-testid="m-confirm-ok">{{ confirmLabel() }}</button>
      </div>
    </nota-mob-sheet>
  `,
})
export class MobConfirmComponent {
  readonly open = model(false);
  readonly title = input('');
  readonly message = input('');
  readonly confirmLabel = input('');
  readonly destructive = input(true);
  readonly confirmed = output<void>();
}
