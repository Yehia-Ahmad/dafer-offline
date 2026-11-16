import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { map } from 'rxjs';
import { LayoutService } from '../../core/layout/layout.service';
import { MobileTopBarService } from '../../modules/mobile/mobile-topbar.service';
import { HelpContentService } from '../help-content.service';
import type { HelpData } from '../help-data';
import { HelpSectionViewComponent } from '../components/help-section-view.component';

/** /help/:section: one section as a page (a full page on the phone; the top bar shows its title). */
@Component({
  selector: 'nota-help-section-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, TranslatePipe, HelpSectionViewComponent],
  template: `
    <div class="help-sp" [class.help-sp--phone]="layout.isMobile()">
      @if (!layout.isMobile()) { <a class="help-sp__back" routerLink="/help">{{ 'help.allSections' | translate }}</a> }
      @if (!data()) {
        <p>{{ 'help.loading' | translate }}</p>
      } @else if (section(); as current) {
        <nota-help-section-view [section]="current" [data]="data()!" [showTitle]="!layout.isMobile()" />
      } @else {
        <p data-testid="help-missing">{{ 'help.missing' | translate }} <a routerLink="/help">{{ 'help.allSections' | translate }}</a></p>
      }
    </div>
  `,
  styles: [`
    .help-sp { max-width: 900px; }
    .help-sp__back { display: inline-block; margin-bottom: 12px; color: var(--brand); }
    .help-sp--phone { padding: 12px 16px 32px; }
  `],
})
export class HelpSectionPageComponent {
  protected readonly layout = inject(LayoutService);
  private readonly content = inject(HelpContentService);
  protected readonly data = signal<HelpData | null>(null);
  private readonly id = toSignal(inject(ActivatedRoute).paramMap.pipe(map((params) => params.get('section') ?? '')), { initialValue: '' });
  protected readonly section = computed(() => this.data()?.byId.get(this.id()) ?? null);

  constructor() {
    const translate = inject(TranslateService);
    inject(MobileTopBarService).bind(() => ({ title: this.section()?.title ?? translate.instant('help.title') }));
    void this.content.load().then((data) => this.data.set(data));
  }
}
