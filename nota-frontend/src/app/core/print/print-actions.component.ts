import { ChangeDetectionStrategy, Component, inject, input, signal } from '@angular/core';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { ToastService } from '../auth/toast.service';
import { NotaButtonDirective } from '../../modules/shared/ui/button.directive';
import { PrintRequest, PrintService } from './print.service';

export interface PrintActionItem {
  /** Stable id (test hooks). */
  key: string;
  /** Appended to "طباعة" when a screen offers several formats (e.g. "إيصال 80مم"). */
  label?: string;
  /** Loads the data and builds the request when the button is pressed (so nothing is fetched until it is needed). null = nothing to print. */
  load: () => Promise<PrintRequest | null>;
}

/**
 * Stage 23: the "طباعة" button of a printable document, one per format. "Save as PDF" is the browser's own
 * destination in its print dialog.
 * Place it behind *notaCan (permission-gated) like any other action: the print endpoints check the same permission.
 */
@Component({
  selector: 'nota-print-actions',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NotaButtonDirective, TranslatePipe],
  template: `
    @for (item of items(); track item.key) {
      <button type="button" notaButton="primary" [attr.data-action]="'print-' + item.key" [disabled]="disabled()" (click)="run(item)">
        {{ 'print.print' | translate }}{{ item.label ? ' · ' + item.label : '' }}
      </button>
    }
  `,
  styles: [':host { display: inline-flex; flex-wrap: wrap; gap: 8px; }'],
})
export class PrintActionsComponent {
  private readonly printer = inject(PrintService);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);

  readonly items = input.required<PrintActionItem[]>();
  readonly loading = signal(false);

  disabled(): boolean {
    return this.loading() || this.printer.busy();
  }

  async run(item: PrintActionItem): Promise<void> {
    if (this.disabled()) return;
    this.loading.set(true);
    try {
      const request = await item.load();
      if (!request) return;
      await this.printer.print(request);
    } catch (error) {
      const http = error as { error?: { message?: string }; message?: string };
      this.toast.error(http?.error?.message || http?.message || this.translate.instant('print.failed'));
    } finally {
      this.loading.set(false);
    }
  }
}
