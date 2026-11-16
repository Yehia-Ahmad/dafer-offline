import { ChangeDetectionStrategy, Component, forwardRef, input, signal } from '@angular/core';
import { ControlValueAccessor, NG_VALUE_ACCESSOR } from '@angular/forms';

const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';
const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';

/**
 * What the user typed → a clean text of Latin digits with at most one "." and at most `decimals` fraction digits.
 * Accepts Arabic-Indic (٠-٩) and Persian digits, the Arabic decimal separator "٫" and a comma or "،" as the decimal point, and ignores
 * thousands separators ("٬", spaces). A leading "-" is kept only when `allowNegative`. Pure: used by the phone number field.
 */
export function normalizeNumberText(raw: string, decimals: number, allowNegative: boolean): string {
  let text = '';
  for (const char of raw) {
    const arabic = ARABIC_DIGITS.indexOf(char);
    const persian = PERSIAN_DIGITS.indexOf(char);
    if (arabic >= 0) text += String(arabic);
    else if (persian >= 0) text += String(persian);
    else text += char;
  }
  text = text.replace(/[٬\s]/g, '').replace(/[٫،,]/g, '.');
  const negative = allowNegative && text.startsWith('-');
  text = text.replace(/[^0-9.]/g, '');
  const dot = text.indexOf('.');
  if (dot >= 0) {
    if (decimals <= 0) text = text.slice(0, dot);
    else text = text.slice(0, dot + 1) + text.slice(dot + 1).replace(/\./g, '').slice(0, decimals);
  }
  return (negative ? '-' : '') + text;
}

/** Normalised text → number (null when empty or just a sign / dot). */
export function numberFromText(text: string): number | null {
  if (text === '' || text === '-' || text === '.' || text === '-.') return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/** Keeps a value inside [min, max] (either may be absent). */
export function clampNumber(value: number, min: number | null | undefined, max: number | null | undefined): number {
  let result = value;
  if (min !== null && min !== undefined && result < min) result = min;
  if (max !== null && max !== undefined && result > max) result = max;
  return result;
}

/**
 * Online Stage 6B: the phone's number field. A plain text input (inputmode "decimal", or "numeric" for integers) bound to the SAME form
 * control as the desktop's PrimeNG number box: it accepts Arabic and English digits, keeps at most `decimals` fraction digits and clamps to
 * `min` / `max` when the field loses focus, exactly like the desktop field. The control always holds a number (or null when empty).
 */
@Component({
  selector: 'nota-mob-number',
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [{ provide: NG_VALUE_ACCESSOR, useExisting: forwardRef(() => MobNumberInputComponent), multi: true }],
  template: `
    <input class="m-input nota-num" type="text" [attr.id]="inputId()" [attr.inputmode]="integer() || decimals() === 0 ? 'numeric' : 'decimal'"
      autocomplete="off" [value]="text()" [disabled]="disabled()" [attr.aria-label]="ariaLabel()" [attr.placeholder]="placeholder()"
      (input)="onInput($any($event.target).value)" (blur)="onBlur()" />
  `,
  styles: [':host { display: block; min-width: 0; } input { width: 100%; }'],
})
export class MobNumberInputComponent implements ControlValueAccessor {
  readonly inputId = input<string | null>(null);
  readonly ariaLabel = input<string | null>(null);
  readonly placeholder = input<string | null>(null);
  readonly min = input<number | null>(null);
  readonly max = input<number | null>(null);
  /** Most fraction digits (PrimeNG's decimal mode allows 3 unless the desktop field sets `maxFractionDigits`). */
  readonly decimals = input(3);
  readonly integer = input(false);

  protected readonly text = signal('');
  protected readonly disabled = signal(false);
  private onChange: (value: number | null) => void = () => undefined;
  private onTouched: () => void = () => undefined;

  private places(): number { return this.integer() ? 0 : this.decimals(); }

  protected onInput(raw: string): void {
    const text = normalizeNumberText(raw, this.places(), (this.min() ?? 0) < 0);
    this.text.set(text);
    this.onChange(numberFromText(text));
  }

  protected onBlur(): void {
    const value = numberFromText(this.text());
    if (value === null) { this.text.set(''); }
    else {
      const clamped = clampNumber(value, this.min(), this.max());
      this.text.set(String(clamped));
      if (clamped !== value) this.onChange(clamped);
    }
    this.onTouched();
  }

  writeValue(value: unknown): void {
    const number = typeof value === 'number' ? value : value === null || value === undefined || value === '' ? null : Number(value);
    this.text.set(number === null || !Number.isFinite(number) ? '' : String(number));
  }
  registerOnChange(fn: (value: number | null) => void): void { this.onChange = fn; }
  registerOnTouched(fn: () => void): void { this.onTouched = fn; }
  setDisabledState(disabled: boolean): void { this.disabled.set(disabled); }
}
