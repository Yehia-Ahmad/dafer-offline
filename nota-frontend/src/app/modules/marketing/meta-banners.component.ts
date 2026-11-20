import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { MetaState } from './marketing.models';

export const META_ERROR_CODES = ['TOKEN_INVALID', 'PERMISSION_MISSING', 'RATE_LIMITED', 'ACCOUNT_NOT_FOUND', 'NETWORK', 'META_ERROR', 'SECRETS_KEY_MISSING'];
// ACTIVE and IN_GRACE_PERIOD are fine; anything else (disabled, unsettled, closed...) only shows a note: its numbers are still read.
const OK_STATUSES = [1, 9];

/**
 * Online Stage 7B: the notes on the marketing pages about the Meta numbers. Failed last sync, spend with no exchange rate, Meta's days
 * in another time zone, an ad account that is not active. Read-only text.
 */
@Component({
  selector: 'app-meta-banners',
  imports: [TranslatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (meta(); as m) {
      @if (m.lastError) {
        <p class="mb mb--bad" role="alert" data-test="meta-banner-error">{{ errorKey() | translate }}</p>
      }
      @if (m.needsRate) {
        <p class="mb mb--warn" role="status" data-test="meta-banner-rate">{{ 'marketing.meta.banner.needsRate' | translate: { currency: m.currency } }}</p>
      }
      @if (m.timezoneNote) {
        <p class="mb" role="note" data-test="meta-banner-timezone">{{ 'marketing.meta.banner.timezone' | translate: { zone: m.timezoneName } }}</p>
      }
      @if (statusWarning()) {
        <p class="mb mb--warn" role="status" data-test="meta-banner-status">{{ 'marketing.meta.banner.accountStatus' | translate }}</p>
      }
    }
  `,
  styles: [`
    :host { display: contents; }
    .mb { margin: 0; padding: 8px 12px; border-radius: 8px; font-size: 13px; background: var(--surface-muted, #f1f5f9); }
    .mb--bad { background: #fee2e2; color: #991b1b; }
    .mb--warn { background: #fef3c7; color: #92400e; }
  `],
})
export class MetaBannersComponent {
  readonly meta = input<MetaState | null | undefined>();

  protected readonly errorKey = computed(() => {
    const code = this.meta()?.lastError?.code ?? '';
    return `marketing.meta.errors.${META_ERROR_CODES.includes(code) ? code : 'META_ERROR'}`;
  });
  protected readonly statusWarning = computed(() => {
    const status = this.meta()?.accountStatus;
    return this.meta()?.connected === true && typeof status === 'number' && !OK_STATUSES.includes(status);
  });
}
