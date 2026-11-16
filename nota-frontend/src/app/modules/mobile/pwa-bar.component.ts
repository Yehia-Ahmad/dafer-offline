import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { InstallHintService } from '../../core/pwa/install-hint.service';
import { OnlineService } from '../../core/pwa/online.service';
import { UpdateService } from '../../core/pwa/update.service';

/**
 * Online Stage 6A: the strip at the top of the phone layout.
 * - "مفيش إنترنت" while the network is down (the screens disable what needs the server; nothing is queued).
 * - "فيه تحديث جديد" + reload once the service worker has a new version ready.
 * - The install hint (Android button / iOS steps), dismissible and remembered on this device.
 */
@Component({
  selector: 'nota-pwa-bar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslatePipe],
  template: `
    <div class="m-pwa">
      @if (!net.online()) {
        <div class="m-pwa__bar m-pwa__bar--offline" role="status" data-testid="offline-banner">
          <span>{{ 'mobile.pwa.offline' | translate }}</span>
        </div>
      }
      @if (update.updateReady()) {
        <div class="m-pwa__bar m-pwa__bar--update" role="status" data-testid="update-prompt">
          <span>{{ 'mobile.pwa.updateReady' | translate }}</span>
          <button type="button" (click)="update.reload()">{{ 'mobile.pwa.reload' | translate }}</button>
        </div>
      }
      @if (install.mode() === 'android') {
        <div class="m-pwa__bar m-pwa__bar--install" data-testid="install-android">
          <span>{{ 'mobile.pwa.installAndroid' | translate }}</span>
          <button type="button" (click)="install.install()">{{ 'mobile.pwa.install' | translate }}</button>
          <button type="button" (click)="install.dismiss()" [attr.aria-label]="'mobile.pwa.dismiss' | translate">✕</button>
        </div>
      }
      @if (install.mode() === 'ios') {
        <div class="m-pwa__bar m-pwa__bar--install" data-testid="install-ios">
          <span>{{ 'mobile.pwa.installIos' | translate }}</span>
          <button type="button" (click)="install.dismiss()" [attr.aria-label]="'mobile.pwa.dismiss' | translate">✕</button>
        </div>
      }
    </div>
  `,
})
export class PwaBarComponent {
  protected readonly net = inject(OnlineService);
  protected readonly update = inject(UpdateService);
  protected readonly install = inject(InstallHintService);
}
