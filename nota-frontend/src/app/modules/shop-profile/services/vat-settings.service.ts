import { Injectable, computed, inject } from '@angular/core';
import { VatSettingsLike, vatContextFor } from '../../shared/vat/vat-math';
import { ShopProfileService } from './shop-profile.service';

/**
 * Stage 21: the shop's VAT settings for the screens that sell, buy or record expenses. They come from the cached shop profile,
 * which the app reads at every sign-in (IdleLockService) and refreshes when the shop profile is saved. The server computes and
 * stores the real figures; the screens use these settings only to show the same numbers while the user types.
 */
@Injectable({ providedIn: 'root' })
export class VatSettingsService {
  private readonly shopProfile = inject(ShopProfileService);

  /** null until the profile is loaded, or when VAT was never configured. */
  readonly settings = computed<VatSettingsLike | null>(() => this.shopProfile.profile()?.vat ?? null);
  readonly enabled = computed(() => Boolean(this.settings()?.enabled));

  /** Re-reads the shop profile in the background. The sale, credit, purchase and expense screens call it when they open. */
  refresh(): void {
    this.shopProfile.refresh();
  }

  /** The `vat` block a 409 TOTAL_CHANGED / VAT_CHANGED answer carries: the server's current settings, used at once. */
  applyServerVat(vat: VatSettingsLike | null | undefined): void {
    if (vat) this.shopProfile.applyVat(vat as never);
    else this.shopProfile.refresh();
  }

  /** { rate, included } for a document dated `date` (yyyy-MM-dd), or null when it carries no VAT. */
  contextFor(date: string) {
    return vatContextFor(this.settings(), date);
  }
}
