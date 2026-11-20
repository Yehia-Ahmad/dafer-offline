import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { AR } from '../core/i18n/ar';
import { PixelsService } from '../core/pixels.service';

/** Online Stage 7A: the small cookie bar. Rendered only in the browser after start() (never part of the server HTML). */
@Component({
  selector: 'app-consent-bar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (pixels.needsConsent()) {
      <div class="bar" role="dialog" aria-live="polite" [attr.aria-label]="t.consent.title">
        <p>{{ t.consent.text }}</p>
        <div class="actions">
          <button type="button" class="btn" (click)="pixels.accept()">{{ t.consent.accept }}</button>
          <button type="button" class="btn ghost" (click)="pixels.decline()">{{ t.consent.decline }}</button>
        </div>
      </div>
    }
  `,
  styles: [`
    .bar { position: fixed; inset-inline: 12px; bottom: 12px; z-index: 50; display: flex; flex-wrap: wrap; align-items: center; gap: 10px 16px; justify-content: space-between;
      background: var(--surface, #fff); color: var(--text, #111); border: 1px solid var(--border, #ddd); border-radius: 12px; padding: 12px 14px; box-shadow: 0 6px 24px rgba(0, 0, 0, .15); max-width: 720px; margin-inline: auto; }
    p { margin: 0; font-size: 13px; flex: 1 1 260px; }
    .actions { display: flex; gap: 8px; }
  `],
})
export class ConsentBarComponent {
  protected readonly t = AR;
  protected readonly pixels = inject(PixelsService);
}
