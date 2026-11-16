import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { HelpPanelService } from '../help-panel.service';
import { parseInline } from '../inline-parse';

/**
 * One line of help text. Tokens are rendered with interpolation and routerLink only (never innerHTML), so a help text can
 * not inject markup. Inside the desktop panel a section link switches the panel instead of leaving the page.
 */
@Component({
  selector: 'nota-help-inline',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  template: `@for (token of tokens(); track $index) {@switch (token.kind) {
    @case ('bold') {<strong>{{ token.text }}</strong>}
    @case ('page') {<a class="help-link" [routerLink]="$any(token).route" [queryParams]="$any(token).query ?? null">{{ token.text }}</a>}
    @case ('section') {@if (inPanel()) {<button type="button" class="help-link help-link--button" (click)="panel.show($any(token).id)">{{ token.text }}</button>} @else {<a class="help-link" [routerLink]="['/help', $any(token).id]">{{ token.text }}</a>}}
    @default {<span>{{ token.text }}</span>}
  }}`,
  styles: [`
    :host { display: inline; }
    .help-link { color: var(--brand); font-weight: 600; text-decoration: underline; text-underline-offset: 3px; }
    .help-link--button { background: none; border: 0; padding: 0; font: inherit; cursor: pointer; }
  `],
})
export class HelpInlineComponent {
  protected readonly panel = inject(HelpPanelService);
  readonly text = input.required<string>();
  readonly inPanel = input(false);
  protected readonly tokens = computed(() => parseInline(this.text()));
}
