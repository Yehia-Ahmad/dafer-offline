import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { LanguageService } from '../../modules/shared/services/translation.service';
import { HelpPanelService } from '../help-panel.service';
import type { HelpData } from '../help-data';
import { ruleText } from '../help-markdown';
import { HelpSection } from '../help.models';
import { HelpBlocksComponent } from './help-blocks.component';
import { HelpInlineComponent } from './help-inline.component';

/** One help section: title, who uses it, the blocks and the related sections. Used by /help/:section and the desktop panel. */
@Component({
  selector: 'nota-help-section-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, TranslatePipe, HelpBlocksComponent, HelpInlineComponent],
  host: { lang: 'ar', dir: 'rtl', class: 'help-section', '[attr.data-section]': 'section().id' },
  template: `
    @if (english()) { <p class="hs-lang" lang="en" dir="ltr" data-testid="help-english-note">{{ 'help.englishNote' | translate }}</p> }
    @if (showTitle()) { <h2 class="hs-title">{{ section().title }}</h2> }
    <p class="hs-summary"><nota-help-inline [text]="section().summary" [inPanel]="inPanel()" /></p>
    <p class="hs-who"><span class="hs-who__label">{{ 'help.whoUses' | translate }}</span> {{ who() }}</p>
    <nota-help-blocks [blocks]="section().blocks" [inPanel]="inPanel()" />
    @if (related().length) {
      <h3 class="hs-related__title">{{ 'help.related' | translate }}</h3>
      <div class="hs-related">
        @for (item of related(); track item.id) {
          @if (inPanel()) {
            <button type="button" class="hs-chip" (click)="panel.show(item.id)">{{ item.title }}</button>
          } @else {
            <a class="hs-chip" [routerLink]="['/help', item.id]">{{ item.title }}</a>
          }
        }
      </div>
    }
  `,
  styles: [`
    :host { display: block; }
    .hs-lang { margin: 0 0 12px; padding: 8px 12px; border-radius: 10px; background: var(--neutral-soft); color: var(--neutral-text); font-size: 13px; }
    .hs-title { font-size: 22px; font-weight: 800; margin: 0 0 6px; }
    .hs-summary { margin: 0 0 6px; color: var(--text-muted); }
    .hs-who { margin: 0 0 8px; font-size: 13px; color: var(--text-muted); }
    .hs-who__label { font-weight: 700; }
    .hs-related__title { font-size: 15px; font-weight: 800; margin: 24px 0 8px; }
    .hs-related { display: flex; flex-wrap: wrap; gap: 8px; }
    .hs-chip { display: inline-flex; align-items: center; min-height: 36px; padding: 4px 14px; border-radius: var(--radius-pill); border: 1px solid var(--border);
      background: var(--surface); color: var(--text); text-decoration: none; font: inherit; font-size: 14px; cursor: pointer; }
    .hs-chip:hover { border-color: var(--brand); color: var(--brand); }
  `],
})
export class HelpSectionViewComponent {
  protected readonly panel = inject(HelpPanelService);
  private readonly language = inject(LanguageService);

  readonly section = input.required<HelpSection>();
  readonly data = input.required<HelpData>();
  readonly inPanel = input(false);
  readonly showTitle = input(true);

  protected readonly english = computed(() => this.language.selectedLanguage() === 'en');
  protected readonly who = computed(() => ruleText(this.section().permissions, this.data().permissionLabel));
  protected readonly related = computed(() =>
    this.section().related.map((id) => this.data().byId.get(id)).filter((item): item is HelpSection => Boolean(item)));
}
