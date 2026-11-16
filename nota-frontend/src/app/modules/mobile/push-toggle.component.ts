import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { PushService } from '../../core/pwa/push.service';

/**
 * Online Stage 6A: "فعّل إشعارات الطلبات". The permission prompt appears only on the tap, never on page load.
 * Shows the current state: on / off / blocked in the browser / not supported / iOS needs the installed app.
 */
@Component({
  selector: 'nota-push-toggle',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslatePipe],
  template: `
    <div class="m-toggle-row" data-testid="push-toggle">
      <div class="m-row__body">
        <div class="m-row__title">{{ 'mobile.push.title' | translate }}</div>
        <div class="m-row__sub" data-testid="push-state">{{ stateKey() | translate }}</div>
      </div>
      @switch (push.state()) {
        @case ('off') {
          <button type="button" class="m-btn m-btn--primary" [disabled]="push.busy()" (click)="push.enable()" data-testid="push-enable">
            {{ 'mobile.push.enable' | translate }}
          </button>
        }
        @case ('on') {
          <button type="button" class="m-btn" [disabled]="push.busy()" (click)="push.disable()" data-testid="push-disable">
            {{ 'mobile.push.disable' | translate }}
          </button>
        }
      }
    </div>
  `,
})
export class PushToggleComponent {
  protected readonly push = inject(PushService);

  protected stateKey(): string {
    return `mobile.push.state.${this.push.state()}`;
  }
}
