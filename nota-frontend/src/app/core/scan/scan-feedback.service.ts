import { Injectable, inject } from '@angular/core';
import { Router } from '@angular/router';
import { TranslateService } from '@ngx-translate/core';
import { AuthService } from '../auth/auth.service';
import { ToastService } from '../auth/toast.service';
import { ScanResult } from './scan.service';
import { ScanSoundService } from './scan-sound.service';

/**
 * Stage 26: what every scanning screen does with a lookup result that is not a product:
 *   - nothing registered → the error sound and the toast "باركود مش متسجل: <code>"; a user who can create products
 *     (products.manage + products.viewCost, as the new-product page needs) also gets "أضف منتج بالباركود ده", which
 *     opens the product form with the barcode filled in;
 *   - an archived product's barcode → "المنتج ده متأرشف";
 *   - a server problem → its message.
 * The screen keeps the text in its box, selected, so the next scan replaces it.
 */
@Injectable({ providedIn: 'root' })
export class ScanFeedbackService {
  private readonly toast = inject(ToastService);
  private readonly sounds = inject(ScanSoundService);
  private readonly translate = inject(TranslateService);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  /** A product was found and added. */
  found(): void {
    this.sounds.ok();
  }

  /** Reports a lookup that found no usable product. Returns false for a product result (nothing to report). */
  miss(result: ScanResult, options: { add?: (code: string) => void } = {}): boolean {
    if (result.kind === 'product') return false;
    this.sounds.error();
    if (result.kind === 'archived') {
      this.toast.error(this.translate.instant('barcodes.archived'));
    } else if (result.kind === 'error') {
      this.toast.error(result.message || this.translate.instant('barcodes.lookupFailed'));
    } else {
      const code = result.code;
      const canAdd = this.auth.has('products.manage') && this.auth.has('products.viewCost');
      this.toast.show(
        this.translate.instant('barcodes.notRegistered', { code }),
        'error',
        8000,
        canAdd
          ? {
              label: this.translate.instant('barcodes.addProduct'),
              // A screen with its own "new product" form (purchases) opens that one, so its unsaved lines are not lost.
              run: () => (options.add ? options.add(code) : void this.router.navigate(['/products/new'], { queryParams: { barcode: code } })),
            }
          : undefined
      );
    }
    return true;
  }
}
