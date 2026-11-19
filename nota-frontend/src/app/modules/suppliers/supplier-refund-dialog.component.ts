import { ChangeDetectionStrategy, Component, computed, effect, inject, input, model, output, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { Dialog } from 'primeng/dialog';
import { LockDateService } from '../../core/accounting-lock/lock-date.service';
import { LayoutService } from '../../core/layout/layout.service';
import { localDateKey } from '../../core/utilities/local-date';
import { PaymentBoxSelectComponent } from '../cashbox/payment-box-select.component';
import { PaymentBoxService } from '../cashbox/payment-box.service';
import { round2 } from '../purchases/purchase-math';
import { PurchasesService } from '../purchases/purchases.service';
import { NotaButtonDirective, NotaDialogShellComponent, NotaFormFieldComponent, NotaLockBannerComponent, NotaLockedDateDirective, NotaMoneyPipe, correctionErrorText } from '../shared/ui';
import { Supplier } from './suppliers.service';

/**
 * Online Fixes 1: "استرداد من المورد" without a return (POST /suppliers/:id/refunds, suppliers.pay). The supplier gives money back that
 * they hold for us (an advance we paid, a credit): Dr box / Cr supplier (an SR voucher). The server caps it at what the supplier owes
 * us (409 REFUND_EXCEEDS_DUE), refuses a closed period, a box that is stopped, or a drawer without an open shift.
 */
@Component({
  selector: 'app-supplier-refund-dialog',
  host: { style: 'display: contents' }, // the dialog renders in the body: no cell in a grid or flex parent
  standalone: true,
  imports: [NotaLockBannerComponent, NotaLockedDateDirective, FormsModule, TranslatePipe, Dialog, NotaButtonDirective, NotaDialogShellComponent, NotaFormFieldComponent, NotaMoneyPipe, PaymentBoxSelectComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <p-dialog [visible]="visible()" (visibleChange)="visible.set($event)" [modal]="true" [showHeader]="false" [closable]="false"
      [draggable]="false" [resizable]="false" styleClass="nota-p-dialog">
      <nota-dialog-shell [title]="'supplierRefund.title' | translate" [closeLabel]="'purchases.close' | translate" (closed)="cancel()">
        @if (supplier(); as s) {
          <p style="margin:0 0 8px;font-weight:800;font-size:16px" dir="auto" data-test="refund-supplier">{{ s.name }}</p>
          <p style="margin:0 0 12px" data-test="refund-due">
            @if (owedToUs() > 0) { {{ 'supplierRefund.theyOweUs' | translate: { amount: (owedToUs() | notaMoney) } }} } @else { {{ 'supplierRefund.nothingDue' | translate }} }
          </p>
        }
        @if (layout.isMobile()) {
          <label class="m-field">{{ 'supplierRefund.amount' | translate }} *
            <input class="m-input nota-num" type="number" inputmode="decimal" min="0" step="0.01" name="refundAmountM" data-test="refund-amount" [ngModel]="amount()" (ngModelChange)="amount.set($event)" />
          </label>
        } @else {
          <nota-form-field [label]="'supplierRefund.amount' | translate" forId="srdAmount" [required]="true">
            <input id="srdAmount" class="nota-input nota-num" type="number" min="0" step="0.01" name="refundAmount" data-test="refund-amount" [ngModel]="amount()" (ngModelChange)="amount.set($event)" />
          </nota-form-field>
        }
        <nota-payment-box-select labelKey="supplierRefund.toBox" />
        @if (layout.isMobile()) {
          <label class="m-field" style="margin-top:12px">{{ 'supplierPay.date' | translate }}
            <input class="m-input nota-num" type="date" notaLockedDate name="refundDateM" data-test="refund-date" [ngModel]="date()" (ngModelChange)="date.set($event)" />
            <nota-lock-banner [selected]="date()" />
          </label>
          <label class="m-field">{{ 'supplierPay.note' | translate }}
            <input class="m-input" type="text" name="refundNoteM" maxlength="500" data-test="refund-note" [ngModel]="note()" (ngModelChange)="note.set($event)" />
          </label>
        } @else {
          <nota-form-field [label]="'supplierPay.date' | translate" forId="srdDate">
            <input id="srdDate" class="nota-input nota-num" type="date" notaLockedDate name="refundDate" data-test="refund-date" [ngModel]="date()" (ngModelChange)="date.set($event)" />
            <nota-lock-banner [selected]="date()" />
          </nota-form-field>
          <nota-form-field [label]="'supplierPay.note' | translate" forId="srdNote">
            <input id="srdNote" class="nota-input" type="text" name="refundNote" maxlength="500" data-test="refund-note" [ngModel]="note()" (ngModelChange)="note.set($event)" />
          </nota-form-field>
        }
        <p style="font-size:12px;color:var(--text-muted);margin:12px 0 0">{{ 'supplierRefund.entryHint' | translate }}</p>
        @if (error()) { <p class="nota-error" role="alert" data-test="refund-error">{{ error() }}</p> }
        <ng-container notaDialogFooter>
          @if (layout.isMobile()) {
            <button type="button" class="m-btn" (click)="cancel()">{{ 'purchases.cancelAction' | translate }}</button>
            <button type="button" class="m-btn m-btn--primary" data-action="save-refund" [disabled]="!valid() || busy()" (click)="save()">{{ 'supplierRefund.save' | translate }}</button>
          } @else {
            <button type="button" notaButton (click)="cancel()">{{ 'purchases.cancelAction' | translate }}</button>
            <button type="button" notaButton="primary" data-action="save-refund" [disabled]="!valid() || busy()" (click)="save()">{{ 'supplierRefund.save' | translate }}</button>
          }
        </ng-container>
      </nota-dialog-shell>
    </p-dialog>
  `,
})
export class SupplierRefundDialogComponent {
  private readonly lock = inject(LockDateService);
  protected readonly layout = inject(LayoutService);
  private readonly service = inject(PurchasesService);
  private readonly paymentBox = inject(PaymentBoxService);
  private readonly translate = inject(TranslateService);

  readonly visible = model(false);
  /** The supplier with its current balance (positive = we owe; negative = they hold an advance of ours). */
  readonly supplier = input<Supplier | null>(null);
  readonly done = output<{ number: string; amount: number }>();

  readonly amount = signal<number | null>(null);
  readonly date = signal(localDateKey());
  readonly note = signal('');
  readonly busy = signal(false);
  readonly error = signal('');

  readonly amountValue = computed(() => round2(this.amount() ?? 0));
  /** What the supplier owes us (a debit balance); a refund can only bring that back. */
  readonly owedToUs = computed(() => Math.max(0, round2(-(this.supplier()?.balance ?? 0))));
  readonly valid = computed(() => this.amountValue() > 0 && this.amountValue() <= this.owedToUs() && !this.lock.isLocked(this.date()));

  constructor() {
    effect(() => {
      if (this.visible()) untracked(() => { this.amount.set(null); this.note.set(''); this.error.set(''); this.paymentBox.load(); this.lock.refresh(); });
    });
  }

  cancel(): void {
    this.visible.set(false);
  }

  save(): void {
    const s = this.supplier();
    if (!s || !this.valid()) return;
    this.busy.set(true);
    this.error.set('');
    const payload = this.paymentBox.withBox({
      amount: this.amountValue(),
      ...(this.date() ? { date: this.date() } : {}),
      ...(this.note().trim() ? { note: this.note().trim() } : {}),
    });
    this.service.refund(s._id, payload).subscribe({
      next: (row) => { this.busy.set(false); this.visible.set(false); this.done.emit({ number: row.number, amount: row.amount ?? this.amountValue() }); },
      error: (response) => { this.busy.set(false); this.error.set(correctionErrorText(response, this.translate, 'supplierRefund.failed')); },
    });
  }
}
