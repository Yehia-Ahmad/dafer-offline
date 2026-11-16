import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

// Stroke icons in the style of the designs (24px grid, stroke 1.6, currentColor). Decorative: always aria-hidden.
const PATHS: Record<string, string> = {
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zm9 16-4-4',
  bag: 'M6 8h12l-1 12H7L6 8zm3 0V6a3 3 0 0 1 6 0v2',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  truck: 'M3 7h11v9H3V7zm11 3h4l3 3v3h-7M7 19a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zm10 0a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z',
  delivery: 'M3 7h11v9H3V7zm11 3h4l3 3v3h-7M7 19a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zm10 0a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z',
  cash: 'M3 7h18v10H3V7zm9 7.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
  exchange: 'M4 9h14l-3-3M20 15H6l3 3',
  tag: 'M3 12V4h8l10 10-8 8L3 12zm5-5h.01',
  grid: 'M4 4h7v7H4V4zm9 0h7v7h-7V4zM4 13h7v7H4v-7zm9 0h7v7h-7v-7z',
  check: 'M5 12l5 5 9-10',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm-8 8c0-4 4-6 8-6s8 2 8 6',
  chat: 'M4 5h16v11H9l-5 4V5z',
  image: 'M4 5h16v14H4V5zm0 11 5-5 4 4 3-3 4 4M9 9.5h.01',
  close: 'M6 6l12 12M18 6 6 18',
};

@Component({
  selector: 'app-icon',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<svg [attr.width]="size()" [attr.height]="size()" viewBox="0 0 24 24" fill="none" stroke="currentColor" [attr.stroke-width]="stroke()" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path [attr.d]="path()" /></svg>`,
  styles: [':host{display:inline-flex;line-height:0}'],
})
export class IconComponent {
  readonly name = input.required<string>();
  readonly size = input(20);
  readonly stroke = input(1.8);
  protected readonly path = computed(() => PATHS[this.name()] ?? PATHS['tag']);
}
