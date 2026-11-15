import { ChangeDetectionStrategy, Component, effect, inject, signal } from '@angular/core';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { AuthService } from '../core/auth/auth.service';
import { WhatsNewEntry, getDesktopBridge } from '../core/runtime/runtime-config';

/**
 * Stage 25: "what's new" after an upgrade. The desktop app answers once per version per PC (it remembers the last version it showed);
 * the window opens after sign-in, in the language the user chose, and the button marks it seen. The list comes from CHANGELOG.md.
 */
@Component({
  selector: 'app-whats-new-dialog',
  imports: [TranslatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (entry(); as current) {
      <div class="wn__backdrop" data-test="whats-new">
        <div class="wn" role="dialog" aria-modal="true" aria-labelledby="wn-title">
          <h2 id="wn-title" class="wn__title">{{ 'whatsNew.title' | translate: { version: current.version } }}</h2>
          <ul class="wn__list" data-test="whats-new-list">
            @for (line of lines(current); track $index) { <li>{{ line }}</li> }
          </ul>
          <p class="wn__note">{{ 'whatsNew.note' | translate }}</p>
          <button type="button" class="nota-btn nota-btn--primary" data-action="whats-new-close" (click)="close()">{{ 'whatsNew.close' | translate }}</button>
        </div>
      </div>
    }
  `,
  styles: `
    .wn__backdrop { position: fixed; inset: 0; z-index: 9990; display: grid; place-items: center; background: rgb(0 0 0 / 45%); padding: 16px; }
    .wn { max-width: 34rem; width: 100%; max-height: 85vh; overflow: auto; padding: 24px; border-radius: var(--radius-card); background: var(--surface, #fff); color: var(--text, inherit); box-shadow: 0 12px 40px rgb(0 0 0 / 30%); }
    .wn__title { margin: 0 0 12px; font-size: 1.25rem; }
    .wn__list { margin: 0 0 12px; padding-inline-start: 20px; line-height: 1.9; }
    .wn__note { margin: 0 0 16px; opacity: 0.7; font-size: 0.85rem; }
  `,
})
export class WhatsNewDialogComponent {
  private readonly auth = inject(AuthService);
  private readonly translate = inject(TranslateService);
  protected readonly entry = signal<WhatsNewEntry | null>(null);
  private asked = false;

  constructor() {
    const bridge = getDesktopBridge();
    effect(() => {
      if (!this.auth.signedIn() || this.asked || !bridge?.whatsNew) return;
      this.asked = true;
      bridge.whatsNew.get().then((entry) => this.entry.set(entry ?? null)).catch(() => undefined);
    });
  }

  protected lines(entry: WhatsNewEntry): string[] {
    const lang = (this.translate.currentLang || this.translate.defaultLang || 'ar') === 'en' ? 'en' : 'ar';
    return entry[lang].length ? entry[lang] : entry[lang === 'en' ? 'ar' : 'en'];
  }

  protected close(): void {
    this.entry.set(null);
    getDesktopBridge()?.whatsNew?.seen().catch(() => undefined);
  }
}
