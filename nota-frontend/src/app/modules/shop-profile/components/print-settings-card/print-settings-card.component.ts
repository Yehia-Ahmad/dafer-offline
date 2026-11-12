import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslatePipe } from '@ngx-translate/core';
import { PrintService } from '../../../../core/print/print.service';
import { PrintSettingsService } from '../../../../core/print/print-settings.service';
import { DesktopPrinter } from '../../../../core/runtime/runtime-config';
import { NotaButtonDirective, NotaFormFieldComponent } from '../../../shared/ui';

/**
 * Stage 23: the "الطباعة" card of the shop profile (shop.manage). The settings belong to THIS PC (the desktop app keeps
 * them in print-settings.json): the receipt printer (80mm), the A4/A5 printer, auto-print after a sale, the number of
 * receipt copies and a test page for each printer. The receipt footer text is the shop's invoice footer above.
 */
@Component({
  selector: 'app-print-settings-card',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, TranslatePipe, NotaButtonDirective, NotaFormFieldComponent],
  template: `
    <section class="psc" data-test="print-card" aria-labelledby="psc-title">
      <h2 id="psc-title" class="nota-section-title">{{ 'print.settings.title' | translate }}</h2>
      @if (!supported) {
        <p class="nota-hint" data-test="print-desktop-only">{{ 'print.settings.desktopOnly' | translate }}</p>
      } @else {
        <p class="nota-hint">{{ 'print.settings.perDevice' | translate }}</p>
        @if (loading()) {
          <p role="status">{{ 'print.settings.loading' | translate }}</p>
        } @else {
          @if (!printers().length) { <p class="nota-hint" data-test="print-no-printers">{{ 'print.settings.noPrinters' | translate }}</p> }
          <nota-form-field [label]="'print.settings.receiptPrinter' | translate" forId="psc-receipt">
            <select id="psc-receipt" class="nota-select" name="receiptPrinter" data-field="receipt-printer" [ngModel]="receiptPrinter()" (ngModelChange)="receiptPrinter.set($event)">
              <option value="">{{ 'print.settings.noneDialog' | translate }}</option>
              @for (printer of printers(); track printer.name) { <option [value]="printer.name">{{ printer.displayName }}</option> }
            </select>
          </nota-form-field>
          <button type="button" notaButton data-action="test-receipt" [disabled]="busy()" (click)="test('receipt')">{{ 'print.settings.testPage' | translate }} · 80mm</button>
          <nota-form-field [label]="'print.settings.documentPrinter' | translate" forId="psc-document">
            <select id="psc-document" class="nota-select" name="documentPrinter" data-field="document-printer" [ngModel]="documentPrinter()" (ngModelChange)="documentPrinter.set($event)">
              <option value="">{{ 'print.settings.systemDefault' | translate }}</option>
              @for (printer of printers(); track printer.name) { <option [value]="printer.name">{{ printer.displayName }}</option> }
            </select>
          </nota-form-field>
          <button type="button" notaButton data-action="test-document" [disabled]="busy()" (click)="test('document')">{{ 'print.settings.testPage' | translate }} · A4</button>
          <label class="psc__check"><input type="checkbox" name="autoPrint" data-field="auto-print" [ngModel]="autoPrint()" (ngModelChange)="autoPrint.set($event)" /> {{ 'print.settings.autoPrint' | translate }}</label>
          <nota-form-field [label]="'print.settings.copies' | translate" forId="psc-copies">
            <input id="psc-copies" class="nota-input nota-num" type="number" min="1" max="5" step="1" name="copies" data-field="copies" [ngModel]="copies()" (ngModelChange)="copies.set($event)" />
          </nota-form-field>
          <p class="nota-hint">{{ 'print.settings.footerNote' | translate }}</p>
          @if (message()) { <p role="status" data-test="print-status" [class.nota-error]="isError()">{{ message() }}</p> }
          <button type="button" notaButton="primary" data-action="save-print-settings" [disabled]="busy()" (click)="save()">{{ 'print.settings.save' | translate }}</button>
        }
      }
    </section>
  `,
  styles: [
    `
      .psc { display: flex; flex-direction: column; align-items: flex-start; gap: 12px; padding: 16px; border: 1px solid var(--border); border-radius: var(--radius-card); background: var(--surface); }
      .psc nota-form-field, .psc .nota-select, .psc .nota-input { max-width: 360px; width: 100%; }
      .psc__check { display: inline-flex; gap: 8px; align-items: center; }
    `,
  ],
})
export class PrintSettingsCardComponent implements OnInit {
  private readonly settings = inject(PrintSettingsService);
  private readonly printer = inject(PrintService);

  readonly supported = this.settings.supported;
  readonly loading = signal(true);
  readonly busy = signal(false);
  readonly printers = signal<DesktopPrinter[]>([]);
  readonly receiptPrinter = signal('');
  readonly documentPrinter = signal('');
  readonly autoPrint = signal(false);
  readonly copies = signal(1);
  readonly message = signal('');
  readonly isError = signal(false);
  readonly copiesValue = computed(() => Math.min(5, Math.max(1, Math.floor(Number(this.copies()) || 1))));

  async ngOnInit(): Promise<void> {
    if (!this.supported) return;
    const [current, printers] = await Promise.all([this.settings.load(), this.settings.printers()]);
    this.printers.set(printers);
    if (current) this.apply(current);
    this.loading.set(false);
  }

  private apply(value: { receiptPrinter: string; documentPrinter: string; autoPrintReceipt: boolean; receiptCopies: number }): void {
    this.receiptPrinter.set(value.receiptPrinter);
    this.documentPrinter.set(value.documentPrinter);
    this.autoPrint.set(value.autoPrintReceipt);
    this.copies.set(value.receiptCopies);
  }

  async save(): Promise<boolean> {
    this.busy.set(true);
    this.message.set('');
    const result = await this.settings.save({
      receiptPrinter: this.receiptPrinter(),
      documentPrinter: this.documentPrinter(),
      autoPrintReceipt: this.autoPrint(),
      receiptCopies: this.copiesValue(),
    });
    this.busy.set(false);
    if (result.ok === true) {
      this.isError.set(false);
      this.apply(result.settings);
      this.message.set('✓');
      return true;
    }
    this.isError.set(true);
    this.message.set(result.message);
    return false;
  }

  /** The test page goes to the printer that is selected in the dropdown now (sent with the request; nothing is saved by testing). */
  async test(kind: 'receipt' | 'document'): Promise<void> {
    this.busy.set(true);
    this.message.set('');
    await this.printer.testPage(kind, kind === 'receipt' ? this.receiptPrinter() : this.documentPrinter());
    this.busy.set(false);
  }
}
