import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { AuthService } from '../core/auth/auth.service';
import { OtherMainPc, getDesktopBridge } from '../core/runtime/runtime-config';

/**
 * Stage 15 (main PC): the desktop app looks for another main PC on the LAN at startup and every few
 * minutes. If one answers, users with shop.manage see this banner until it is gone. It only warns;
 * neither PC is ever stopped.
 */
@Component({
  selector: 'app-other-main-banner',
  imports: [TranslatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (visible()) {
      <div class="nota-other-main" role="alert" data-test="other-main-banner">
        <svg class="nota-other-main__icon" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M12 8v5M12 16.5v.5M10.3 3.9 2.4 17.5A2 2 0 0 0 4.1 20.5h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
        </svg>
        <div class="nota-other-main__body">
          <p class="nota-other-main__text">
            {{ 'session.otherMain.banner' | translate }}
            <span class="nota-other-main__who"><bdi>{{ names() }}</bdi></span>
          </p>
          <button type="button" class="nota-other-main__link" (click)="open.set(!open())" [attr.aria-expanded]="open()" data-test="other-main-help">
            {{ 'session.otherMain.whatToDo' | translate }}
          </button>
          @if (open()) {
            <div class="nota-other-main__help" data-test="other-main-explain">
              <p>{{ 'session.otherMain.why' | translate }}</p>
              <ol>
                <li>{{ 'session.otherMain.step1' | translate }}</li>
                <li>{{ 'session.otherMain.step2' | translate }}</li>
                <li>{{ 'session.otherMain.step3' | translate }}</li>
              </ol>
            </div>
          }
        </div>
      </div>
    }
  `,
  styles: `
    :host { display: block; }
    .nota-other-main { display: flex; gap: 12px; align-items: flex-start; margin-block-end: 16px; padding: 14px 16px;
      border-radius: var(--radius-card); background: var(--danger-soft); color: var(--danger-text); line-height: 1.7; }
    .nota-other-main__icon { flex: none; margin-block-start: 2px; }
    .nota-other-main__body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
    .nota-other-main__text { margin: 0; font-weight: 700; }
    .nota-other-main__who { font-weight: 800; }
    .nota-other-main__link { align-self: flex-start; padding: 0; border: none; background: none; color: inherit; font: inherit;
      text-decoration: underline; cursor: pointer; }
    .nota-other-main__link:focus-visible { outline: 2px solid var(--danger); outline-offset: 2px; }
    .nota-other-main__help p, .nota-other-main__help ol { margin: 4px 0; }
    .nota-other-main__help ol { padding-inline-start: 20px; }
  `,
})
export class OtherMainBannerComponent {
  private readonly auth = inject(AuthService);
  protected readonly others = signal<OtherMainPc[]>([]);
  protected readonly open = signal(false);
  protected readonly visible = computed(() => this.others().length > 0 && this.auth.has('shop.manage'));
  protected readonly names = computed(() =>
    this.others().map((pc) => `${pc.shopName ? `${pc.shopName} / ` : ''}${pc.address}:${pc.port}`).join('، ')
  );

  constructor() {
    const bridge = getDesktopBridge();
    if (!bridge?.getOtherMainPcs || !bridge.onOtherMainPcs) return;
    bridge.getOtherMainPcs().then((list) => this.others.set(Array.isArray(list) ? list : [])).catch(() => undefined);
    inject(DestroyRef).onDestroy(bridge.onOtherMainPcs((list) => this.others.set(Array.isArray(list) ? list : [])));
  }
}
