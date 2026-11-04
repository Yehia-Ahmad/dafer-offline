import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/** Stroke icon from one SVG path (24×24 grid), drawn in currentColor. Decorative: label the parent instead. */
@Component({
  selector: 'nota-nav-icon',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'nota-nav-icon', 'aria-hidden': 'true' },
  styles: `:host { display: inline-flex; flex: none; } svg { display: block; }`,
  template: `
    <svg [attr.width]="size()" [attr.height]="size()" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" focusable="false">
      <path [attr.d]="path()" />
    </svg>
  `,
})
export class NavIconComponent {
  readonly path = input.required<string>();
  readonly size = input(18);
}
