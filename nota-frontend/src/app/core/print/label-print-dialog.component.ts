import { ChangeDetectionStrategy, Component, computed, effect, inject, input, model, output, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { Dialog } from 'primeng/dialog';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../auth/auth.service';
import { ToastService } from '../auth/toast.service';
import { NotaButtonDirective, NotaDialogShellComponent } from '../../modules/shared/ui';
import { BarcodeApiService } from '../scan/barcode-api.service';
import { LabelItem, planLabelJob, toLabelItem } from './documents/product-label';
import { DEFAULT_LABEL_OPTIONS, LABEL_PADDING_MM, LabelOptions, LabelPrice, LabelTarget, MAX_LABELS_PER_JOB, barcodeSizing, clampStartAt, labelsPerSheet, normalizeRoll, normalizeSheet } from './label-layout';
import { PrintService } from './print.service';
import { PrintSettingsService } from './print-settings.service';

/** A product (or any product-like object) to print labels for, with its default number of labels. */
export interface LabelDialogProduct {
  _id?: string;
  id?: string;
  name?: unknown;
  code?: unknown;
  barcodes?: unknown;
  retailPrice?: unknown;
  wholesalePrice?: unknown;
  priceAfterDiscount?: unknown;
  discountPercentage?: unknown;
  vatExempt?: unknown;
  /** Default number of labels (1 when absent). */
  copies?: number;
}

interface Row {
  id: string;
  product: LabelDialogProduct;
  item: LabelItem;
  copies: number;
}

/**
 * Stage 26: "اطبع ملصقات". The labels of one or many products on the label roll or on A4 sticker sheets: content options
 * (remembered per device), quantity per product, "start at label N" for a partly used sheet, products with no barcode
 * (generate first for users who can edit products, or skipped with a warning), the 2,000-labels limit. Labels are not
 * numbered documents: no copy counter, no audit entry per print.
 */
@Component({
  selector: 'nota-label-print-dialog',
  standalone: true,
  imports: [FormsModule, TranslatePipe, Dialog, NotaButtonDirective, NotaDialogShellComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <p-dialog [visible]="visible()" (visibleChange)="visible.set($event)" [modal]="true" [showHeader]="false" [closable]="false"
      [draggable]="false" [resizable]="false" styleClass="nota-p-dialog lpd-dialog">
      <nota-dialog-shell [title]="'labels.title' | translate" [closeLabel]="'auth.close' | translate" (closed)="close()">
        <div class="lpd" data-test="label-dialog">
          <fieldset class="lpd__group">
            <legend>{{ 'labels.target' | translate }}</legend>
            <label><input type="radio" name="lpdTarget" value="roll" [ngModel]="target()" (ngModelChange)="setTarget($event)" data-test="target-roll" /> {{ 'labels.roll' | translate }}</label>
            <label><input type="radio" name="lpdTarget" value="sheet" [ngModel]="target()" (ngModelChange)="setTarget($event)" data-test="target-sheet" /> {{ 'labels.sheet' | translate }}</label>
          </fieldset>

          <fieldset class="lpd__group">
            <legend>{{ 'labels.content' | translate }}</legend>
            <label><input type="checkbox" name="lpdShop" [ngModel]="shopName()" (ngModelChange)="shopName.set($event); remember()" data-test="opt-shop" /> {{ 'labels.shopName' | translate }}</label>
            <label><input type="checkbox" name="lpdCode" [ngModel]="internalCode()" (ngModelChange)="internalCode.set($event); remember()" data-test="opt-code" /> {{ 'labels.internalCode' | translate }}</label>
            <label>{{ 'labels.price' | translate }}
              <select class="nota-input" name="lpdPrice" [ngModel]="price()" (ngModelChange)="price.set($event); remember()" data-test="opt-price">
                <option value="retail">{{ 'labels.priceRetail' | translate }}</option>
                <option value="wholesale">{{ 'labels.priceWholesale' | translate }}</option>
                <option value="discounted">{{ 'labels.priceDiscounted' | translate }}</option>
                <option value="none">{{ 'labels.priceNone' | translate }}</option>
              </select>
            </label>
          </fieldset>

          @if (target() === 'sheet') {
            <label class="lpd__start">{{ 'labels.startAt' | translate }}
              <input class="nota-input nota-num" type="number" min="1" [max]="perSheet()" step="1" name="lpdStart" data-test="start-at" [ngModel]="startAt()" (ngModelChange)="startAt.set(clampStart($event))" />
              <small>{{ 'labels.startAtHint' | translate: { max: perSheet() } }}</small>
            </label>
          }

          <table class="nota-table" data-test="label-rows">
            <thead><tr><th>{{ 'labels.product' | translate }}</th><th class="nota-num">{{ 'labels.copies' | translate }}</th></tr></thead>
            <tbody>
              @for (row of rows(); track row.id) {
                <tr [attr.data-row]="row.item.code" [class.lpd__nobar]="!row.item.barcode">
                  <td>{{ row.item.name }} <small class="code">{{ row.item.code }}</small>
                    @if (!row.item.barcode) { <span class="lpd__warn" data-test="no-barcode">{{ 'labels.noBarcode' | translate }}</span> }
                  </td>
                  <td class="nota-num"><input class="nota-input nota-num lpd__qty" type="number" min="0" step="1" [name]="'q' + row.id" data-test="copies"
                    [attr.aria-label]="'labels.copies' | translate" [ngModel]="row.copies" (ngModelChange)="setCopies(row.id, $event)" /></td>
                </tr>
              }
            </tbody>
          </table>

          @if (missing() > 0) {
            @if (canGenerate()) {
              <button type="button" notaButton data-test="generate-first" [disabled]="busy()" (click)="generateFirst()">{{ 'labels.generateFirst' | translate }}</button>
            } @else {
              <p class="lpd__warn" data-test="skip-warning">{{ 'labels.skipped' | translate: { count: missing() } }}</p>
            }
          }
          @if (tooSmall() > 0) { <p class="lpd__warn" role="alert" data-test="too-small">{{ 'labels.tooSmall' | translate }}</p> }
          <p class="lpd__total" [class.lpd__over]="job().tooMany" data-test="label-total">{{ 'labels.total' | translate: { count: job().total } }}</p>
          @if (job().tooMany) { <p class="lpd__over" role="alert" data-test="too-many">{{ 'labels.tooMany' | translate: { max: max, total: job().total } }}</p> }
          @if (target() === 'roll') { <p class="lpd__hint">{{ 'labels.noPrinterNote' | translate }}</p> }

          <div class="lpd__actions">
            <button type="button" notaButton (click)="close()">{{ 'auth.close' | translate }}</button>
            <button type="button" notaButton="primary" data-test="print-labels" [disabled]="busy() || job().tooMany || job().total === 0" (click)="print()">{{ 'labels.print' | translate }}</button>
          </div>
        </div>
      </nota-dialog-shell>
    </p-dialog>
  `,
  styles: [`
    .lpd { display: flex; flex-direction: column; gap: 12px; min-width: min(560px, 90vw); }
    .lpd__group { display: flex; flex-wrap: wrap; gap: 14px; align-items: center; border: 1px solid var(--border, #d5d1c8); border-radius: 8px; padding: 8px 12px; }
    .lpd__group label { display: inline-flex; gap: 6px; align-items: center; }
    .lpd__start { display: flex; flex-direction: column; gap: 4px; max-width: 220px; }
    .lpd__qty { width: 88px; }
    .lpd__warn, .lpd__nobar small { color: var(--danger, #b4401f); }
    .lpd__over { color: var(--danger, #b4401f); font-weight: 700; }
    .lpd__hint { color: var(--text-muted, #4a5856); font-size: 12px; margin: 0; }
    .lpd__actions { display: flex; gap: 10px; justify-content: flex-end; }
  `],
})
export class LabelPrintDialogComponent {
  private readonly printService = inject(PrintService);
  private readonly settings = inject(PrintSettingsService);
  private readonly auth = inject(AuthService);
  private readonly api = inject(BarcodeApiService);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);

  readonly visible = model(false);
  /** The products to print labels for (their `copies` is the starting quantity). */
  readonly products = input<LabelDialogProduct[]>([]);
  /** The dialog printed (or cancelled in the system dialog). */
  readonly printed = output<void>();
  /** A barcode was generated for a product: the caller may reload it. */
  readonly barcodesChanged = output<void>();

  readonly max = MAX_LABELS_PER_JOB;
  protected readonly rows = signal<Row[]>([]);
  readonly target = signal<LabelTarget>(DEFAULT_LABEL_OPTIONS.target);
  readonly shopName = signal(DEFAULT_LABEL_OPTIONS.shopName);
  readonly internalCode = signal(DEFAULT_LABEL_OPTIONS.internalCode);
  readonly price = signal<LabelPrice>(DEFAULT_LABEL_OPTIONS.price);
  readonly startAt = signal(1);
  protected readonly busy = signal(false);
  private sheetLayout = normalizeSheet({});
  private readonly rollWidthMm = signal(normalizeRoll({}).widthMm);
  private readonly sheetWidthMm = signal(normalizeSheet({}).labelWidthMm);

  protected readonly perSheet = computed(() => {
    void this.target();
    return labelsPerSheet(this.sheetLayout);
  });
  protected readonly job = computed(() => planLabelJob(this.rows().map((row) => ({ item: row.item, copies: row.copies }))));
  protected readonly missing = computed(() => this.rows().filter((row) => row.copies > 0 && !row.item.barcode).length);
  /** Labels whose barcode does not fit this label size even at the smallest bar (0.19 mm): a scanner may not read them. */
  protected readonly tooSmall = computed(() => {
    const usable = (this.target() === 'sheet' ? this.sheetWidthMm() : this.rollWidthMm()) - 2 * LABEL_PADDING_MM;
    return this.rows().filter((row) => row.copies > 0 && row.item.barcode && barcodeSizing(row.item.barcode, usable, this.target())?.tooSmall).length;
  });
  protected readonly canGenerate = computed(() => this.auth.has('products.manage'));

  constructor() {
    effect(() => {
      const open = this.visible();
      const products = this.products();
      if (open) untracked(() => void this.load(products));
    });
  }

  private async load(products: LabelDialogProduct[]): Promise<void> {
    this.rows.set(products.map((product, index) => ({
      id: String(product._id ?? product.id ?? index),
      product,
      item: toLabelItem(product as never),
      copies: Math.max(0, Math.floor(Number(product.copies ?? 1)) || 0),
    })));
    const saved = await this.printService.labelSettings();
    this.sheetLayout = saved.sheet;
    this.rollWidthMm.set(saved.roll.widthMm);
    this.sheetWidthMm.set(saved.sheet.labelWidthMm);
    this.target.set(saved.options.target);
    this.shopName.set(saved.options.shopName);
    this.internalCode.set(saved.options.internalCode);
    this.price.set(saved.options.price);
    this.startAt.set(1);
  }

  private options(): LabelOptions {
    return { target: this.target(), shopName: this.shopName(), internalCode: this.internalCode(), price: this.price() };
  }

  protected clampStart(value: unknown): number {
    return clampStartAt(value, this.sheetLayout);
  }

  protected setTarget(value: LabelTarget): void {
    this.target.set(value === 'sheet' ? 'sheet' : 'roll');
    this.remember();
  }

  protected setCopies(id: string, value: unknown): void {
    const copies = Math.max(0, Math.floor(Number(value)) || 0);
    this.rows.update((rows) => rows.map((row) => (row.id === id ? { ...row, copies } : row)));
  }

  /** Remembers the content options on this device (never throws; a failure only means they are not remembered). */
  protected remember(): void {
    void this.settings.savePrefs({ labelOptions: this.options() });
  }

  /** For users who can edit products: one generated EAN-13 for each product with no barcode, saved on the product. */
  protected async generateFirst(): Promise<void> {
    this.busy.set(true);
    try {
      for (const row of this.rows().filter((entry) => entry.copies > 0 && !entry.item.barcode && (entry.product._id ?? entry.product.id))) {
        const id = String(row.product._id ?? row.product.id);
        const generated = await firstValueFrom(this.api.generate());
        await firstValueFrom(this.api.setBarcodes(id, [generated.barcode]));
        const product = { ...row.product, barcodes: [generated.barcode] };
        this.rows.update((rows) => rows.map((entry) => (entry.id === row.id ? { ...entry, product, item: toLabelItem(product as never) } : entry)));
      }
      this.barcodesChanged.emit();
    } catch (error) {
      const message = (error as { error?: { message?: string } })?.error?.message;
      this.toast.error(message || this.translate.instant('barcodes.bulk.failed'));
    } finally {
      this.busy.set(false);
    }
  }

  protected async print(): Promise<void> {
    this.busy.set(true);
    try {
      const outcome = await this.printService.printLabels(
        this.rows().map((row) => ({ item: row.item, copies: row.copies })),
        this.options(),
        { startAt: this.target() === 'sheet' ? this.startAt() : 1 }
      );
      if (outcome.ok) {
        this.printed.emit();
        this.visible.set(false);
      }
    } finally {
      this.busy.set(false);
    }
  }

  protected close(): void {
    this.visible.set(false);
  }
}
