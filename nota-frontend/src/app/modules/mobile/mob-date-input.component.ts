import { ChangeDetectionStrategy, Component, forwardRef, input, signal } from '@angular/core';
import { ControlValueAccessor, NG_VALUE_ACCESSOR } from '@angular/forms';

export type MobDateKind = 'date' | 'month' | 'datetime-local';

const pad = (n: number) => String(n).padStart(2, '0');

/** A Date (or ISO / yyyy-MM-dd string) → the text a native input of this kind wants, in LOCAL time (no UTC shift). '' when empty. */
export function toNativeValue(value: unknown, kind: MobDateKind): string {
  if (value === null || value === undefined || value === '') return '';
  let date: Date;
  if (value instanceof Date) date = value;
  else if (typeof value === 'string' && /^\d{4}-\d{2}(-\d{2})?$/.test(value)) {
    const [y, m, d] = value.split('-').map(Number);
    date = new Date(y, m - 1, d || 1);
  } else date = new Date(value as string | number);
  if (!Number.isFinite(date.getTime())) return '';
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}`;
  if (kind === 'month') return day;
  const full = `${day}-${pad(date.getDate())}`;
  return kind === 'date' ? full : `${full}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** The native input's text → a local Date (null when empty or incomplete). */
export function fromNativeValue(text: string, kind: MobDateKind): Date | null {
  if (!text) return null;
  const match = /^(\d{4})-(\d{2})(?:-(\d{2}))?(?:T(\d{2}):(\d{2}))?$/.exec(text);
  if (!match) return null;
  const [, y, m, d, h, mi] = match;
  const date = new Date(Number(y), Number(m) - 1, Number(d || 1), Number(h || 0), Number(mi || 0));
  return Number.isFinite(date.getTime()) ? date : null;
}

/**
 * Online Stage 6B: the phone's date field. A native <input type="date" | "month" | "datetime-local"> (the phone's own picker and locale)
 * bound to the SAME form control as the desktop's PrimeNG picker. The control keeps its value type: a Date stays a Date; a control that
 * holds a "yyyy-MM-dd" string gets a string back. Works with formControlName, [formControl] and ngModel.
 */
@Component({
  selector: 'nota-mob-date',
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [{ provide: NG_VALUE_ACCESSOR, useExisting: forwardRef(() => MobDateInputComponent), multi: true }],
  template: `
    <input class="m-input" [attr.id]="inputId()" [attr.type]="kind()" [value]="text()" [attr.min]="minText()" [attr.max]="maxText()"
      [disabled]="disabled()" [attr.aria-label]="ariaLabel()" (input)="onInput($any($event.target).value)" (blur)="touched()" />
  `,
  styles: [':host { display: block; min-width: 0; } input { width: 100%; }'],
})
export class MobDateInputComponent implements ControlValueAccessor {
  readonly kind = input<MobDateKind>('date');
  readonly inputId = input<string | null>(null);
  readonly ariaLabel = input<string | null>(null);
  /** Earliest / latest day (a Date or text), for example the accounting lock's first open day. */
  readonly min = input<Date | string | null | undefined>(null);
  readonly max = input<Date | string | null | undefined>(null);

  protected readonly text = signal('');
  protected readonly disabled = signal(false);
  private stringValued = false;
  private onChange: (value: unknown) => void = () => undefined;
  private onTouched: () => void = () => undefined;

  protected minText(): string | null { return toNativeValue(this.min(), this.kind()) || null; }
  protected maxText(): string | null { return toNativeValue(this.max(), this.kind()) || null; }
  protected touched(): void { this.onTouched(); }

  protected onInput(value: string): void {
    this.text.set(value);
    const date = fromNativeValue(value, this.kind());
    if (!date) { this.onChange(null); return; }
    this.onChange(this.stringValued ? toNativeValue(date, this.kind()) : date);
  }

  writeValue(value: unknown): void {
    this.stringValued = typeof value === 'string' && value !== '';
    this.text.set(toNativeValue(value, this.kind()));
  }
  registerOnChange(fn: (value: unknown) => void): void { this.onChange = fn; }
  registerOnTouched(fn: () => void): void { this.onTouched = fn; }
  setDisabledState(disabled: boolean): void { this.disabled.set(disabled); }
}
