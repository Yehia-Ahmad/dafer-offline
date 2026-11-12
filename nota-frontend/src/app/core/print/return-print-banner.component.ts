import { ChangeDetectionStrategy, Component, OnInit, inject, input, signal } from '@angular/core';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { ReturnLog } from '../../modules/returns/models/returns.model';
import { PrintActionItem, PrintActionsComponent } from './print-actions.component';
import { PrintDataService } from './print-data.service';
import { PrintService } from './print.service';

/**
 * Stage 23: shown right after a return was recorded: the new return's number and its print buttons (80mm return
 * receipt). It also prints the receipt at once when this PC has auto-print on. The create call does not always answer
 * with the return number (a credit return answers with the invoice), so the newest return of the invoice is read.
 */
@Component({
  selector: 'nota-return-print-banner',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PrintActionsComponent, TranslatePipe],
  template: `
    @if (log(); as entry) {
      <div class="nota-return-print" role="status" data-testid="return-print">
        <span>{{ 'print.returnReceipt' | translate }} <b dir="ltr">{{ entry.number }}</b></span>
        <nota-print-actions [items]="items()" />
      </div>
    }
  `,
  styles: [':host { display: block; } .nota-return-print { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; padding: 10px 14px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); margin-block: 8px; }'],
})
export class ReturnPrintBannerComponent implements OnInit {
  private readonly data = inject(PrintDataService);
  private readonly printer = inject(PrintService);
  private readonly translate = inject(TranslateService);

  readonly invoiceId = input.required<string>();
  readonly log = signal<ReturnLog | null>(null);

  items(): PrintActionItem[] {
    const entry = this.log();
    return entry ? [{ key: 'return', label: this.translate.instant('print.receipt80'), load: () => this.data.returnReceipt(entry) }] : [];
  }

  async ngOnInit(): Promise<void> {
    try {
      const entry = await this.data.latestReturnOf(this.invoiceId());
      if (!entry) return;
      this.log.set(entry);
      void this.printer.autoPrintReceipt(() => this.data.returnReceipt(entry));
    } catch {
      // the banner is a convenience: the return itself is saved
    }
  }
}
