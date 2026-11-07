import { ChangeDetectionStrategy, Component, computed, effect, inject, input, model, output, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslatePipe } from '@ngx-translate/core';
import { Dialog } from 'primeng/dialog';
import { AuthService } from '../../core/auth/auth.service';
import { PaymentBoxSelectComponent } from '../cashbox/payment-box-select.component';
import { PaymentBoxService } from '../cashbox/payment-box.service';
import { NotaButtonDirective, NotaDialogShellComponent, NotaFormFieldComponent, NotaMoneyPipe } from '../shared/ui';
import { round2 } from './purchase-math';
import { PurchaseDetail, PurchaseReturnRow } from './purchases.models';
import { PurchasesService } from './purchases.service';

/** The value of returning `qty` units of a line: qty × the line's unit cost; the last units take the remainder (same as the backend). */
export function returnValue(item: { qty: number; lineCost: number; returnedQty: number; returnedValue: number }, qty: number): number {
  const available = item.qty - item.returnedQty;
  if (qty <= 0) return 0;
  return qty === available ? round2(item.lineCost - item.returnedValue) : round2((item.lineCost * qty) / item.qty);
}

/**
 * Stage 20: "مرتجع لمورد", from the purchase detail. Pick lines and quantities (up to purchased − already returned),
 * a reason, and an optional immediate cash refund into a box (suppliers.pay). The value is previewed live.
 */
@Component({
  selector: 'app-purchase-return-dialog',
  standalone: true,
  imports: [FormsModule, TranslatePipe, Dialog, NotaButtonDirective, NotaDialogShellComponent, NotaFormFieldComponent, NotaMoneyPipe, PaymentBoxSelectComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <p-dialog [visible]="visible()" (visibleChange)="visible.set($event)" [modal]="true" [showHeader]="false" [closable]="false"
      [draggable]="false" [resizable]="false" styleClass="nota-p-dialog prd-dialog">
      <nota-dialog-shell [title]="'purchases.return.title' | translate" [closeLabel]="'purchases.close' | translate" (closed)="cancel()">
        @if (purchase(); as p) {
          <table class="nota-table" data-test="return-lines">
            <thead><tr>
              <th>{{ 'purchases.new.item' | translate }}</th>
              <th class="nota-num">{{ 'purchases.return.available' | translate }}</th>
              <th class="nota-num">{{ 'purchases.return.qty' | translate }}</th>
              <th class="nota-num">{{ 'purchases.return.value' | translate }}</th>
            </tr></thead>
            <tbody>
              @for (item of p.items; track item._id) {
                <tr [attr.data-item]="item.code">
                  <td>{{ item.name }}</td>
                  <td class="nota-num">{{ item.qty - item.returnedQty }}</td>
                  <td class="nota-num"><input class="nota-input nota-num prd__qty" type="number" min="0" step="1" [max]="item.qty - item.returnedQty" [name]="'rq' + item._id" data-test="return-qty"
                    [disabled]="item.qty - item.returnedQty === 0" [attr.aria-label]="'purchases.return.qty' | translate" [ngModel]="qtys()[item._id] ?? null" (ngModelChange)="setQty(item._id, $event)" /></td>
                  <td class="nota-num">{{ valueOf(item._id) | notaMoney }}</td>
                </tr>
              }
            </tbody>
          </table>
          <nota-form-field [label]="'purchases.return.reason' | translate" forId="prdReason">
            <input id="prdReason" class="nota-input" type="text" name="reason" maxlength="500" data-test="return-reason" [ngModel]="reason()" (ngModelChange)="reason.set($event)" />
          </nota-form-field>
          <p class="prd__total" data-test="return-total">{{ 'purchases.return.total' | translate }}: <b class="nota-num">{{ total() | notaMoney }}</b></p>
          @if (canRefund()) {
            <nota-form-field [label]="'purchases.return.refund' | translate" forId="prdRefund" [error]="refundInvalid() ? ('purchases.errors.refundRange' | translate) : null">
              <input id="prdRefund" class="nota-input nota-num" type="number" min="0" step="0.01" name="refund" data-test="refund" [ngModel]="refund()" (ngModelChange)="refund.set($event)" />
            </nota-form-field>
            @if ((refund() ?? 0) > 0) { <nota-payment-box-select labelKey="purchases.return.refundBox" /> }
          }
        }
        @if (error()) { <p class="nota-error" role="alert" data-test="return-error">{{ error() | translate }}</p> }
        <ng-container notaDialogFooter>
          <button type="button" notaButton (click)="cancel()">{{ 'purchases.cancelAction' | translate }}</button>
          <button type="button" notaButton="primary" data-action="do-return" [disabled]="!valid() || busy()" (click)="save()">{{ 'purchases.return.submit' | translate }}</button>
        </ng-container>
      </nota-dialog-shell>
    </p-dialog>
  `,
  styles: `
    .prd__qty { width: 90px; }
    .prd__total { margin: 12px 0; font-size: 15px; } .prd__total b { font-size: 18px; }
  `,
})
export class PurchaseReturnDialogComponent {
  private readonly service = inject(PurchasesService);
  private readonly auth = inject(AuthService);
  private readonly paymentBox = inject(PaymentBoxService);

  readonly visible = model(false);
  readonly purchase = input<PurchaseDetail | null>(null);
  readonly done = output<PurchaseReturnRow & { supplierBalanceAfter: number }>();

  readonly qtys = signal<Record<string, number | null>>({});
  readonly reason = signal('');
  readonly refund = signal<number | null>(null);
  readonly busy = signal(false);
  readonly error = signal('');

  readonly canRefund = computed(() => this.auth.has('suppliers.pay'));
  readonly picked = computed(() => {
    const p = this.purchase();
    if (!p) return [];
    return p.items.map((item) => ({ item, qty: Number(this.qtys()[item._id] ?? 0) })).filter((row) => row.qty > 0);
  });
  readonly total = computed(() => round2(this.picked().reduce((sum, row) => sum + returnValue(row.item, row.qty), 0)));
  readonly overAvailable = computed(() => this.picked().some((row) => !Number.isInteger(row.qty) || row.qty > row.item.qty - row.item.returnedQty));
  readonly refundInvalid = computed(() => (this.refund() ?? 0) < 0 || (this.refund() ?? 0) > this.total());
  readonly valid = computed(() => this.picked().length > 0 && !this.overAvailable() && !this.refundInvalid());

  constructor() {
    // A fresh dialog each time it opens.
    effect(() => {
      if (this.visible()) untracked(() => { this.qtys.set({}); this.reason.set(''); this.refund.set(null); this.error.set(''); this.paymentBox.load(); });
    });
  }

  setQty(id: string, value: number | null): void {
    this.qtys.update((current) => ({ ...current, [id]: value === null || (value as unknown) === '' ? null : Number(value) }));
  }

  valueOf(id: string): number {
    const row = this.picked().find((entry) => entry.item._id === id);
    return row ? returnValue(row.item, row.qty) : 0;
  }

  cancel(): void {
    this.visible.set(false);
  }

  save(): void {
    const p = this.purchase();
    if (!p || !this.valid()) return;
    this.busy.set(true);
    this.error.set('');
    const refund = this.refund() ?? 0;
    const payload = {
      items: this.picked().map((row) => ({ itemId: row.item._id, qty: row.qty })),
      ...(this.reason().trim() ? { reason: this.reason().trim() } : {}),
      ...(refund > 0 ? this.paymentBox.withBox({ refundAmount: refund }) : {}),
    };
    this.service.createReturn(p._id, payload).subscribe({
      next: (row) => { this.busy.set(false); this.visible.set(false); this.done.emit(row); },
      error: (response) => {
        this.busy.set(false);
        const code = response?.error?.code;
        const known = ['OVER_RETURN', 'STOCK_ALREADY_USED', 'REFUND_EXCEEDS_RETURN', 'INSUFFICIENT_BALANCE', 'NO_OPEN_SHIFT', 'BOX_INACTIVE', 'PURCHASE_CANCELLED'];
        this.error.set(known.includes(code) ? `purchases.errors.${code}` : 'purchases.errors.returnFailed');
      },
    });
  }
}
