import { ChangeDetectionStrategy, Component, inject, input, model, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { firstValueFrom } from 'rxjs';
import { BarcodeApiService } from './barcode-api.service';
import { MAX_BARCODES, barcodeProblem, barcodeType, normalizeCode } from './scan-normalize';

/**
 * Stage 26: the "الباركود" list of the product form (0 to 5 barcodes).
 *   - add a barcode by typing it or by scanning into the field: a scan ends with Enter, which ADDS it to the list
 *     and never submits the form (the keydown is stopped);
 *   - an Arabic-layout scan is normalised first ("INV…" typed on the Arabic keyboard), then checked with the same rules
 *     as the server (4-48 characters, Code 128-safe ASCII, a valid EAN-13 / EAN-8 / UPC-A check digit);
 *   - remove a barcode; "ولّد باركود" (an in-store EAN-13, for users who can edit products);
 *   - each barcode shows its type (EAN-13 / EAN-8 / UPC-A / Code 128).
 * The parent owns the list (two-way `barcodes`) and sends it with the product.
 */
@Component({
  selector: 'nota-barcode-list',
  standalone: true,
  imports: [FormsModule, TranslatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="bl" data-test="barcode-list">
      <span class="bl__title">{{ 'barcodes.title' | translate }}</span>
      @if (barcodes().length) {
        <ul class="bl__list">
          @for (code of barcodes(); track code) {
            <li class="bl__item" [attr.data-barcode]="code">
              <span class="bl__code" dir="ltr">{{ code }}</span>
              <span class="bl__type" data-test="barcode-type">{{ typeOf(code) }}</span>
              <button type="button" class="bl__remove" data-test="barcode-remove" [attr.aria-label]="'barcodes.remove' | translate" (click)="remove(code)">×</button>
            </li>
          }
        </ul>
      } @else {
        <span class="bl__empty">{{ 'barcodes.empty' | translate }}</span>
      }
      <div class="bl__add">
        <input class="nota-input bl__input" type="text" dir="ltr" autocomplete="off" name="barcodeInput" data-test="barcode-input"
          [placeholder]="'barcodes.placeholder' | translate" [attr.aria-label]="'barcodes.title' | translate"
          [disabled]="readonly() || barcodes().length >= max" [ngModel]="draft()" [ngModelOptions]="{ standalone: true }"
          (ngModelChange)="draft.set($event); error.set('')" (keydown.enter)="onEnter($event)" />
        <button type="button" class="nota-btn" data-test="barcode-add" [disabled]="readonly() || !draft().trim() || barcodes().length >= max" (click)="add()">{{ 'barcodes.add' | translate }}</button>
        @if (canGenerate() && !readonly()) {
          <button type="button" class="nota-btn" data-test="barcode-generate" [disabled]="busy() || barcodes().length >= max" (click)="generate()">
            {{ (busy() ? 'barcodes.generating' : 'barcodes.generate') | translate }}
          </button>
        }
      </div>
      @if (error()) { <p class="bl__error" role="alert" data-test="barcode-error">{{ error() }}</p> }
      <p class="bl__hint">{{ (barcodes().length >= max ? 'barcodes.max' : 'barcodes.hint') | translate }}</p>
    </div>
  `,
  styles: [`
    .bl { display: flex; flex-direction: column; gap: 8px; }
    .bl__title { font-weight: 700; }
    .bl__list { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 8px; }
    .bl__item { display: inline-flex; align-items: center; gap: 8px; border: 1px solid var(--border, #d5d1c8); border-radius: 8px; padding: 4px 8px; }
    .bl__code { font-variant-numeric: tabular-nums; letter-spacing: 0.5px; }
    .bl__type { font-size: 11px; color: var(--text-muted, #4a5856); background: var(--surface-alt, #eef3f1); border-radius: 6px; padding: 1px 6px; }
    .bl__remove { border: 0; background: transparent; cursor: pointer; font-size: 18px; line-height: 1; color: inherit; }
    .bl__empty, .bl__hint { color: var(--text-muted, #4a5856); font-size: 12px; margin: 0; }
    .bl__add { display: flex; flex-wrap: wrap; gap: 8px; }
    .bl__input { flex: 1 1 240px; }
    .bl__error { color: var(--danger, #b4401f); margin: 0; font-size: 13px; }
  `],
})
export class BarcodeListComponent {
  private readonly api = inject(BarcodeApiService);
  private readonly translate = inject(TranslateService);

  /** The product's barcodes (two-way). */
  readonly barcodes = model<string[]>([]);
  readonly readonly = input(false);
  /** Show "ولّد باركود" (the parent passes whether the user may edit products). */
  readonly canGenerate = input(false);

  readonly max = MAX_BARCODES;
  protected readonly draft = signal('');
  protected readonly error = signal('');
  protected readonly busy = signal(false);

  protected typeOf(code: string): string {
    return barcodeType(code);
  }

  /** Enter (the scanner's last key) adds the barcode and does NOT submit the form. */
  protected onEnter(event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    this.add();
  }

  /** Adds the typed/scanned text (normalised) when it is valid and new. Returns whether it was added. */
  add(): boolean {
    const code = normalizeCode(this.draft());
    if (!code) return false;
    const problem = barcodeProblem(code);
    if (problem) {
      this.error.set(this.translate.instant(problem.key, problem.params));
      return false;
    }
    if (this.barcodes().includes(code)) {
      this.error.set(this.translate.instant('barcodes.duplicate'));
      return false;
    }
    if (this.barcodes().length >= this.max) {
      this.error.set(this.translate.instant('barcodes.max'));
      return false;
    }
    this.barcodes.set([...this.barcodes(), code]);
    this.draft.set('');
    this.error.set('');
    return true;
  }

  protected remove(code: string): void {
    this.barcodes.set(this.barcodes().filter((entry) => entry !== code));
  }

  protected async generate(): Promise<void> {
    this.busy.set(true);
    try {
      const generated = await firstValueFrom(this.api.generate());
      if (!this.barcodes().includes(generated.barcode)) this.barcodes.set([...this.barcodes(), generated.barcode]);
      this.error.set('');
    } catch (error) {
      this.error.set((error as { error?: { message?: string } })?.error?.message || this.translate.instant('barcodes.bulk.failed'));
    } finally {
      this.busy.set(false);
    }
  }
}
