import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { NotaCanDirective } from '../../core/auth/nota-can.directive';
import { StatementLine, SupplierStatement } from '../purchases/purchases.models';
import { PurchasesService } from '../purchases/purchases.service';
import { NotaButtonDirective, NotaMoneyPipe } from '../shared/ui';
import { PrintActionItem, PrintActionsComponent } from '../../core/print/print-actions.component';
import { PrintDataService } from '../../core/print/print-data.service';
import { Supplier } from './suppliers.service';

/** "PO-000012 · EL-8841" (our number first, always); a payment shows its PV number, a line without a number (the opening) shows nothing. */
export function statementDocument(line: Pick<StatementLine, 'number' | 'supplierInvoiceNo'>): string {
  if (!line.number) return '';
  return line.supplierInvoiceNo ? `${line.number} · ${line.supplierInvoiceNo}` : line.number;
}

/**
 * Stage 20: the selected supplier's panel on the suppliers page (docs/design/screens/Suppliers.dc.html): what we owe,
 * "سداد دفعة", "فاتورة شراء", "طباعة كشف" (hidden until Stage 23), the statement table (credit = we bought, debit = we
 * paid), its totals and the aging by due date.
 */
@Component({
  selector: 'app-supplier-statement',
  standalone: true,
  imports: [PrintActionsComponent, DatePipe, RouterLink, TranslatePipe, NotaCanDirective, NotaButtonDirective, NotaMoneyPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="nota-card ss" data-test="supplier-panel">
      <header class="ss__head">
        <div>
          <h2 class="ss__name">{{ supplier().name }}</h2>
          <p class="ss__meta">{{ [supplier().contactPerson, supplier().phones.join(' · '), supplier().address].filter(present).join(' · ') }}</p>
        </div>
        <div class="ss__owe">
          <span>{{ (balance() < 0 ? 'suppliers.statement.advance' : 'suppliers.statement.weOweNow') | translate }}</span>
          <b class="nota-num" [class.ss__advance]="balance() < 0" data-test="panel-balance">{{ absBalance() | notaMoney }}</b>
        </div>
      </header>
      <div class="ss__actions">
        <button *notaCan="'suppliers.pay'" type="button" notaButton="primary" data-action="pay" (click)="pay.emit(supplier())">{{ 'suppliers.statement.pay' | translate }}</button>
        <a *notaCan="'purchases.create'" notaButton routerLink="/purchases/new" [queryParams]="{ supplier: supplier()._id }" data-action="new-purchase">{{ 'suppliers.statement.newPurchase' | translate }}</a>
        <nota-print-actions [items]="printItems()" data-test="statement-print" />
      </div>

      @if (loading()) {
        <p role="status" class="ss__empty">{{ 'suppliers.statement.loading' | translate }}</p>
      } @else if (loadError()) {
        <p class="nota-error" role="alert">{{ 'suppliers.statement.loadFailed' | translate }} <button type="button" notaButton (click)="load()">{{ 'suppliers.retry' | translate }}</button></p>
      } @else if (statement(); as st) {
        <h3 class="ss__h">{{ 'suppliers.statement.title' | translate }} <small>{{ 'suppliers.statement.legend' | translate }}</small></h3>
        <div class="nota-table-wrap">
          <table class="nota-table" data-test="statement">
            <thead><tr>
              <th>{{ 'suppliers.statement.date' | translate }}</th>
              <th>{{ 'suppliers.statement.description' | translate }}</th>
              <th>{{ 'suppliers.statement.document' | translate }}</th>
              <th class="nota-num">{{ 'suppliers.statement.debit' | translate }}</th>
              <th class="nota-num">{{ 'suppliers.statement.credit' | translate }}</th>
              <th class="nota-num">{{ 'suppliers.statement.balance' | translate }}</th>
              <th></th>
            </tr></thead>
            <tbody>
              @for (line of st.lines; track $index) {
                <tr [attr.data-line]="line.type">
                  <td class="nota-num">{{ line.date | date: 'yyyy-MM-dd' }}</td>
                  <td>{{ line.description }}@if (line.reference) { <small> · {{ line.reference }}</small> }@if (line.memo) { <small data-test="memo"> · {{ line.memo }}</small> }</td>
                  <td dir="ltr" class="ss__doc" data-test="document">{{ document(line) }}</td>
                  <td class="nota-num">{{ line.debit ? (line.debit | notaMoney) : '' }}</td>
                  <td class="nota-num">{{ line.credit ? (line.credit | notaMoney) : '' }}</td>
                  <td class="nota-num">{{ line.balance | notaMoney }}</td>
                  <td>@if (line.type === 'supplier_refund' && line.number) { <nota-print-actions [items]="refundPrintItems(line)" [pdf]="false" data-test="refund-print" /> }</td>
                </tr>
              } @empty {
                <tr><td colspan="7" class="ss__empty" data-test="statement-empty">{{ 'suppliers.statement.empty' | translate }}</td></tr>
              }
            </tbody>
            <tfoot>
              <tr data-test="statement-totals"><td colspan="3">{{ 'suppliers.statement.totals' | translate }}</td>
                <td class="nota-num">{{ st.totals.debit | notaMoney }}</td><td class="nota-num">{{ st.totals.credit | notaMoney }}</td><td class="nota-num">{{ st.totals.balance | notaMoney }}</td><td></td></tr>
            </tfoot>
          </table>
        </div>
        <h3 class="ss__h">{{ 'suppliers.statement.aging.title' | translate }}</h3>
        <dl class="ss__aging" data-test="aging">
          @for (bucket of buckets; track bucket) {
            <div [attr.data-bucket]="bucket"><dt>{{ 'suppliers.statement.aging.' + bucket | translate }}</dt><dd class="nota-num">{{ st.aging[bucket] | notaMoney }}</dd></div>
          }
          @if (st.aging.advance > 0) { <div data-bucket="advance"><dt>{{ 'suppliers.statement.aging.advance' | translate }}</dt><dd class="nota-num">{{ st.aging.advance | notaMoney }}</dd></div> }
        </dl>
      }
    </section>
  `,
  styles: `
    .ss { padding: 16px; display: flex; flex-direction: column; gap: 14px; }
    .ss__head { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 12px; }
    .ss__name { margin: 0; font-size: 18px; } .ss__meta { margin: 4px 0 0; font-size: 13px; color: var(--text-muted); }
    .ss__owe { display: flex; flex-direction: column; align-items: flex-end; gap: 2px; } .ss__owe span { font-size: 12px; color: var(--text-muted); } .ss__owe b { font-size: 24px; }
    .ss__advance { color: var(--warning-text); }
    .ss__actions { display: flex; flex-wrap: wrap; gap: 10px; }
    .ss__h { margin: 4px 0 0; font-size: 15px; } .ss__h small { font-weight: 400; color: var(--text-muted); font-size: 12px; }
    .ss__empty { text-align: center; color: var(--text-muted); padding: 16px; }
    .ss__doc { font-size: 13px; }
    .ss__aging { margin: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: 10px; }
    .ss__aging div { padding: 10px; border: 1px solid var(--border); border-radius: 12px; } .ss__aging dt { font-size: 12px; color: var(--text-muted); } .ss__aging dd { margin: 4px 0 0; font-weight: 800; }
    tfoot td { font-weight: 800; }
  `,
})
export class SupplierStatementComponent {
  private readonly service = inject(PurchasesService);

  readonly supplier = input.required<Supplier>();
  /** Bumped by the page after a payment or purchase, so the statement reloads. */
  readonly refreshKey = input(0);
  readonly pay = output<Supplier>();

  readonly statement = signal<SupplierStatement | null>(null);
  readonly loading = signal(true);
  readonly loadError = signal(false);
  private readonly printData = inject(PrintDataService);
  private readonly translate = inject(TranslateService);
  /** Stage 23: the A5 SR voucher of a supplier refund row of the statement. */
  refundPrintItems(line: { number?: string | null; balance: number; credit: number; debit: number }): PrintActionItem[] {
    const supplier = this.supplier();
    return [{ key: 'refund-' + line.number, label: this.translate.instant('print.voucherA5'), load: () => this.printData.supplierRefundVoucher(supplier._id, supplier.name, line) }];
  }

  /** Stage 23: the A4 supplier statement (PrSupplierStatement). */
  printItems(): PrintActionItem[] {
    const supplier = this.supplier();
    return [{ key: 'statement', load: () => this.printData.supplierStatement(supplier._id, null, null, { contact: supplier.contactPerson || null, phone: supplier.phones[0] || null }) }];
  }
  readonly buckets = ['current', 'd1_30', 'd31_60', 'd61_90', 'd90plus'] as const;
  readonly present = (value: string | undefined | null) => Boolean(value);
  readonly document = statementDocument;

  /** The one balance: what the supplier list shows. */
  readonly balance = computed(() => this.supplier().balance);
  readonly absBalance = computed(() => Math.abs(this.balance()));

  constructor() {
    effect(() => {
      this.supplier()._id;
      this.refreshKey();
      this.load();
    });
  }

  load(): void {
    this.loading.set(true);
    this.loadError.set(false);
    this.service.statement(this.supplier()._id).subscribe({
      next: (statement) => { this.statement.set(statement); this.loading.set(false); },
      error: () => { this.loadError.set(true); this.loading.set(false); },
    });
  }
}
