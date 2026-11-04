import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * Label above, any control below (native .nota-input/.nota-select/.nota-textarea,
 * PrimeNG p-select/p-inputnumber/..., Reactive Forms bindings unchanged), then hint or error.
 *
 * <nota-form-field label="Name" forId="name" [error]="nameError">
 *   <input id="name" class="nota-input" formControlName="name" />
 * </nota-form-field>
 */
@Component({
  selector: 'nota-form-field',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'nota-field',
    '[class.nota-field--invalid]': '!!error()',
  },
  template: `
    @if (label()) {
      <label class="nota-label" [attr.for]="forId() || null">
        {{ label() }}@if (required()) {<span aria-hidden="true"> *</span>}
      </label>
    }
    <ng-content />
    @if (error()) {
      <span class="nota-error" role="alert">{{ error() }}</span>
    } @else if (hint()) {
      <span class="nota-hint">{{ hint() }}</span>
    }
  `,
})
export class NotaFormFieldComponent {
  readonly label = input('');
  /** id of the projected control, so clicking the label focuses it. */
  readonly forId = input('');
  readonly hint = input('');
  /** Error text; when set the field turns red and the hint is hidden. */
  readonly error = input<string | null | undefined>(null);
  readonly required = input(false);
}
