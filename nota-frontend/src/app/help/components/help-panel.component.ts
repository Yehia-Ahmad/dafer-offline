import { ChangeDetectionStrategy, Component, ElementRef, computed, effect, inject, signal, viewChild } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { HelpContentService } from '../help-content.service';
import type { HelpData } from '../help-data';
import { HelpPanelService } from '../help-panel.service';
import { HelpSectionViewComponent } from './help-section-view.component';

/** Desktop: the page's help section in a side panel over the page (the page keeps its state). Loaded with @defer. */
@Component({
  selector: 'nota-help-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, TranslatePipe, HelpSectionViewComponent],
  host: { '(document:keydown.escape)': 'panel.close()' },
  template: `
    @if (panel.sectionId()) {
      <div class="hp-scrim" (click)="panel.close()" aria-hidden="true"></div>
      <aside class="hp" role="dialog" aria-modal="true" [attr.aria-label]="'help.title' | translate" data-testid="help-panel" tabindex="-1" #box>
        <header class="hp__head">
          <span class="hp__title">{{ section()?.title ?? ('help.title' | translate) }}</span>
          <a class="hp__open" [routerLink]="['/help', panel.sectionId()]">{{ 'help.openPage' | translate }}</a>
          <button type="button" class="hp__close" (click)="panel.close()" [attr.aria-label]="'help.close' | translate">×</button>
        </header>
        <div class="hp__body">
          @if (section(); as current) {
            <nota-help-section-view [section]="current" [data]="data()!" [inPanel]="true" [showTitle]="false" />
          } @else {
            <p>{{ 'help.loading' | translate }}</p>
          }
        </div>
      </aside>
    }
  `,
  styles: [`
    .hp-scrim { position: fixed; inset: 0; background: rgba(15, 23, 42, .28); z-index: 1000; }
    .hp { position: fixed; inset-block: 0; inset-inline-end: 0; width: min(480px, 100vw); z-index: 1001; display: flex; flex-direction: column;
      background: var(--surface); border-inline-start: 1px solid var(--border); box-shadow: var(--shadow-md); outline: none; }
    .hp__head { display: flex; align-items: center; gap: 12px; padding: 14px 16px; border-bottom: 1px solid var(--line); }
    .hp__title { flex: 1; font-weight: 800; font-size: 17px; }
    .hp__open { font-size: 13px; color: var(--brand); white-space: nowrap; }
    .hp__close { width: 36px; height: 36px; border-radius: 10px; border: 1px solid var(--border); background: var(--surface); font-size: 20px; cursor: pointer; color: var(--text); }
    .hp__body { flex: 1; overflow-y: auto; padding: 16px 20px 32px; }
  `],
})
export class HelpPanelComponent {
  protected readonly panel = inject(HelpPanelService);
  private readonly content = inject(HelpContentService);
  protected readonly data = signal<HelpData | null>(null);
  private readonly box = viewChild<ElementRef<HTMLElement>>('box');
  protected readonly section = computed(() => {
    const id = this.panel.sectionId();
    return id ? this.data()?.byId.get(id) ?? null : null;
  });

  constructor() {
    void this.content.load().then((data) => this.data.set(data));
    // Focus the panel when it opens or switches section, so the keyboard and screen readers start there.
    effect(() => {
      if (this.panel.sectionId()) queueMicrotask(() => this.box()?.nativeElement.focus());
    });
  }
}
