import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { AuthService } from '../../core/auth/auth.service';
import { LayoutService } from '../../core/layout/layout.service';
import { MobileTopBarService } from '../../modules/mobile/mobile-topbar.service';
import { LanguageService } from '../../modules/shared/services/translation.service';
import { HelpContentService } from '../help-content.service';
import type { HelpData } from '../help-data';
import { ruleText } from '../help-markdown';
import { searchHelp } from '../help-search';
import { HelpSection } from '../help.models';

export interface HelpCard {
  section: HelpSection;
  allowed: boolean;
  /** "محتاج صلاحية: …" (only for a section the user cannot use). */
  needs: string;
}

/** Pure: the cards to show. By default only the sections the user may use; with `showAll` the rest too, marked. */
export function helpCards(data: HelpData, allows: (section: HelpSection) => boolean, showAll: boolean): HelpCard[] {
  return data.sections
    .map((section) => {
      const allowed = allows(section);
      return { section, allowed, needs: allowed ? '' : ruleText(section.permissions, data.permissionLabel) };
    })
    .filter((card) => showAll || card.allowed);
}

/** /help: search, the "عرض كل الأقسام" switch and the section cards (a card list on the phone). */
@Component({
  selector: 'nota-help-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, TranslatePipe],
  template: `
    <div class="help-page" [class.help-page--phone]="layout.isMobile()">
      @if (!layout.isMobile()) {
        <header class="help-page__head">
          <h1 class="help-page__title">{{ 'help.title' | translate }}</h1>
          <p class="help-page__sub">{{ 'help.subtitle' | translate }}</p>
        </header>
      }
      @if (english()) { <p class="help-page__lang" data-testid="help-english-note">{{ 'help.englishNote' | translate }}</p> }

      <div class="help-page__tools">
        <input class="help-page__search" type="search" [value]="query()" (input)="query.set($any($event.target).value)"
          [placeholder]="'help.searchPlaceholder' | translate" [attr.aria-label]="'help.searchPlaceholder' | translate" data-testid="help-search" />
        <label class="help-page__switch">
          <input type="checkbox" [checked]="showAll()" (change)="showAll.set($any($event.target).checked)" data-testid="help-show-all" />
          <span>{{ 'help.showAll' | translate }}</span>
        </label>
      </div>

      @if (!data()) {
        <p>{{ 'help.loading' | translate }}</p>
      } @else if (query().trim()) {
        <section class="help-results" lang="ar" dir="rtl" data-testid="help-results">
          @for (hit of results(); track $index) {
            <a class="help-result" [routerLink]="['/help', hit.section.id]">
              <span class="help-result__section">{{ hit.section.title }}</span>
              <span class="help-result__text">@for (part of hit.parts; track $index) {@if (part.mark) {<mark>{{ part.text }}</mark>} @else {<span>{{ part.text }}</span>}}</span>
            </a>
          } @empty {
            <p class="help-page__empty">{{ 'help.noResults' | translate }}</p>
          }
        </section>
      } @else {
        <section class="help-cards" lang="ar" dir="rtl">
          @for (card of cards(); track card.section.id) {
            <a class="help-card" [class.help-card--locked]="!card.allowed" [routerLink]="['/help', card.section.id]" [attr.data-section]="card.section.id">
              <span class="help-card__title">{{ card.section.title }}</span>
              <span class="help-card__summary">{{ plain(card.section.summary) }}</span>
              @if (!card.allowed) { <span class="help-card__needs" data-testid="help-needs">{{ 'help.needsPermission' | translate: { permission: card.needs } }}</span> }
            </a>
          }
        </section>
      }
    </div>
  `,
  styles: [`
    .help-page { max-width: 1100px; }
    .help-page__title { font-size: 28px; font-weight: 800; margin: 0; }
    .help-page__sub { margin: 4px 0 16px; color: var(--text-muted); }
    .help-page__lang { padding: 8px 12px; border-radius: 10px; background: var(--neutral-soft); color: var(--neutral-text); font-size: 13px; }
    .help-page__tools { display: flex; flex-wrap: wrap; align-items: center; gap: 12px 20px; margin-bottom: 16px; }
    .help-page__search { flex: 1 1 280px; min-height: 44px; padding: 8px 14px; border-radius: var(--radius-control); border: 1px solid var(--border-strong);
      background: var(--surface); color: var(--text); font: inherit; }
    .help-page__switch { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; min-height: 44px; }
    .help-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 12px; }
    .help-card { display: flex; flex-direction: column; gap: 4px; padding: 14px 16px; border-radius: var(--radius-card); border: 1px solid var(--border);
      background: var(--surface); color: var(--text); text-decoration: none; }
    .help-card:hover { border-color: var(--brand); }
    .help-card__title { font-weight: 800; }
    .help-card__summary { font-size: 13px; color: var(--text-muted); line-height: 1.7; }
    .help-card--locked { opacity: .78; border-style: dashed; }
    .help-card__needs { font-size: 12px; color: var(--warning-text); background: var(--warning-soft); border-radius: 8px; padding: 2px 8px; align-self: flex-start; }
    .help-results { display: flex; flex-direction: column; gap: 8px; }
    .help-result { display: flex; flex-direction: column; gap: 4px; padding: 12px 14px; border-radius: 12px; border: 1px solid var(--border); background: var(--surface);
      color: var(--text); text-decoration: none; line-height: 1.8; }
    .help-result__section { font-size: 12px; font-weight: 700; color: var(--brand); }
    .help-result mark { background: var(--warning-soft); color: inherit; border-radius: 3px; }
    .help-page--phone { padding: 12px 16px 24px; }
    .help-page--phone .help-cards { grid-template-columns: 1fr; }
  `],
})
export class HelpPageComponent {
  protected readonly layout = inject(LayoutService);
  private readonly auth = inject(AuthService);
  private readonly language = inject(LanguageService);
  private readonly content = inject(HelpContentService);

  protected readonly data = signal<HelpData | null>(null);
  protected readonly query = signal('');
  protected readonly showAll = signal(false);
  protected readonly english = computed(() => this.language.selectedLanguage() === 'en');

  protected readonly cards = computed(() => {
    const data = this.data();
    if (!data) return [];
    this.auth.permissions();
    return helpCards(data, (section) => !section.permissions || this.auth.allows(section.permissions), this.showAll());
  });

  protected readonly results = computed(() => {
    const data = this.data();
    if (!data) return [];
    const allowedIds = new Set(this.cards().map((card) => card.section.id));
    return searchHelp(data.index, this.query()).filter((hit) => allowedIds.has(hit.section.id));
  });

  constructor() {
    const translate = inject(TranslateService);
    inject(MobileTopBarService).bind(() => ({ title: translate.instant('help.title') }));
    void this.content.load().then((data) => this.data.set(data));
  }

  protected plain(text: string): string {
    return text.replace(/\*\*/g, '').replace(/\[\[[^\]|]+\|([^\]]+)\]\]/g, '$1');
  }
}
