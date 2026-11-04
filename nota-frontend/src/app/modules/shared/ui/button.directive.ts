import { Directive, computed, input } from '@angular/core';

export type NotaButtonVariant = 'primary' | 'secondary' | 'danger';

/**
 * Nota button styles on a native <button> or <a>.
 * `<button notaButton="primary">Save</button>`, `<button notaButton size="lg">`, `<button notaButton icon>×</button>`.
 * Min height 44px (touch target). Secondary is the default.
 */
@Directive({
  selector: 'button[notaButton], a[notaButton]',
  host: {
    '[class]': 'classes()',
  },
})
export class NotaButtonDirective {
  readonly notaButton = input<NotaButtonVariant | ''>('secondary');
  readonly size = input<'md' | 'lg'>('md');
  /** Square icon-only button (44×44). */
  readonly icon = input(false, { transform: (v: boolean | '') => v === '' || v === true });

  protected readonly classes = computed(() => {
    const variant = this.notaButton() || 'secondary';
    return [
      'nota-btn',
      `nota-btn--${variant}`,
      this.size() === 'lg' ? 'nota-btn--lg' : '',
      this.icon() ? 'nota-btn--icon' : '',
    ]
      .filter(Boolean)
      .join(' ');
  });
}
