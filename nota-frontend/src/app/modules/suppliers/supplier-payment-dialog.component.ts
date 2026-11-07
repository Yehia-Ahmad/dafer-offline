import { ChangeDetectionStrategy, Component, computed, effect, inject, input, model, output, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslatePipe } from '@ngx-translate/core';
import { Dialog } from 'primeng/dialog';
import { PaymentBoxSelectComponent } from '../cashbox/payment-box-select.component';
import { PaymentBoxService } from '../cashbox/payment-box.service';
import { round2 } from '../purchases/purchase-math';
import { PurchasesService } from '../purchases/purchases.service';
import { NotaButtonDirective, NotaDialogShellComponent, NotaFormFieldComponent, NotaMoneyPipe } from '../shared/ui';
import { Supplier } from './suppliers.service';

/**
 * Stage 20: "سداد دفعة لمورد" (docs/design/screens/SupplierPayment.dc.html). Shows what we owe now and after the payment,
 * the amount, the box, date, reference (cheque / transfer number) and note. A payment above what we owe becomes an
 * advance ("لينا") and needs an explicit confirm. Saving posts a payment voucher (PV): Dr supplier / Cr box.
 */
@Component({
  selector: 'app-supplier-payment-dialog',
  standalone: true,
  imports: [FormsModule, TranslatePipe, Dialog, NotaButtonDirective, NotaDialogShellComponent, NotaFormFieldComponent, NotaMoneyPipe, PaymentBoxSelectComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <p-dialog [visible]="visible()" (visibleChange)="visible.set($event)" [modal]="true" [showHeader]="false" [closable]="false"
      [draggable]="false" [resizable]="false" styleClass="nota-p-dialog spd-dialog">
      <nota-dialog-shell [title]="'supplierPay.title' | translate" [closeLabel]="'purchases.close' | translate" (closed)="cancel()">
        @if (supplier(); as s) {
          <p class="spd__name" data-test="payment-supplier">{{ s.name }}</p>
          <div class="spd__balances">
            <div><span>{{ 'supplierPay.owedNow' | translate }}</span><b class="nota-num" data-test="balance-now">{{ s.balance | notaMoney }}</b></div>
            <div><span>{{ 'supplierPay.afterPayment' | translate }}</span><b class="nota-num" [class.spd__advance]="after() < 0" data-test="balance-after">{{ after() | notaMoney }}</b></div>
          </div>
          @if (after() < 0) { <p class="spd__advance-note" data-test="advance-note">{{ 'supplierPay.advanceNote' | translate: { amount: (-after() | notaMoney) } }}</p> }
        }
        <nota-form-field [label]="'supplierPay.amount' | translate" forId="spdAmount" [required]="true">
          <input id="spdAmount" class="nota-input nota-num spd__amount" type="number" min="0" step="0.01" name="amount" data-test="payment-amount" [ngModel]="amount()" (ngModelChange)="amount.set($event)" />
        </nota-form-field>
        <nota-payment-box-select labelKey="supplierPay.fromBox" />
        <div class="spd__grid">
          <nota-form-field [label]="'supplierPay.date' | translate" forId="spdDate">
            <input id="spdDate" class="nota-input nota-num" type="date" name="date" data-test="payment-date" [ngModel]="date()" (ngModelChange)="date.set($event)" />
          </nota-form-field>
          <nota-form-field [label]="'supplierPay.reference' | translate" forId="spdRef">
            <input id="spdRef" class="nota-input" type="text" name="reference" maxlength="100" data-test="payment-reference" [ngModel]="reference()" (ngModelChange)="reference.set($event)" />
          </nota-form-field>
        </div>
        <nota-form-field [label]="'supplierPay.note' | translate" forId="spdNote">
          <input id="spdNote" class="nota-input" type="text" name="note" maxlength="500" data-test="payment-note" [ngModel]="note()" (ngModelChange)="note.set($event)" />
        </nota-form-field>
        @if (isAdvance()) {
          <label class="spd__confirm"><input type="checkbox" name="confirmAdvance" data-test="confirm-advance" [ngModel]="confirmAdvance()" (ngModelChange)="confirmAdvance.set($event)" /> {{ 'supplierPay.confirmAdvance' | translate }}</label>
        }
        <p class="spd__hint">{{ 'supplierPay.entryHint' | translate }}</p>
        @if (error()) { <p class="nota-error" role="alert" data-test="payment-error">{{ error() | translate }}</p> }
        <ng-container notaDialogFooter>
          <button type="button" notaButton (click)="cancel()">{{ 'purchases.cancelAction' | translate }}</button>
          <button type="button" notaButton="primary" data-action="save-payment" [disabled]="!valid() || busy()" (click)="save()">{{ 'supplierPay.save' | translate }}</button>
        </ng-container>
      </nota-dialog-shell>
    </p-dialog>
  `,
  styles: `
    .spd__name { margin: 0 0 8px; font-weight: 800; font-size: 16px; }
    .spd__balances { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin-bottom: 12px; }
    .spd__balances div { display: flex; flex-direction: column; gap: 4px; padding: 12px; border: 1px solid var(--border); border-radius: 14px; }
    .spd__balances span { font-size: 12px; color: var(--text-muted); } .spd__balances b { font-size: 20px; }
    .spd__advance, .spd__advance-note { color: var(--warning-text); }
    .spd__advance-note { margin: 0 0 12px; font-size: 13px; font-weight: 700; }
    .spd__amount { font-size: 22px; font-weight: 800; }
    .spd__grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin: 12px 0; }
    .spd__confirm { display: flex; gap: 8px; align-items: center; padding: 10px 12px; border-radius: var(--radius-control); background: var(--warning-soft); color: var(--warning-text); font-weight: 700; margin-top: 12px; }
    .spd__hint { font-size: 12px; color: var(--text-muted); margin: 12px 0 0; }
    @media (max-width: 480px) { .spd__balances, .spd__grid { grid-template-columns: minmax(0, 1fr); } }
  `,
})
export class SupplierPaymentDialogComponent {
  private readonly service = inject(PurchasesService);
  private readonly paymentBox = inject(PaymentBoxService);

  readonly visible = model(false);
  /** The supplier with its current balance (positive = we owe). */
  readonly supplier = input<Supplier | null>(null);
  readonly done = output<{ number: string; balanceAfter: number }>();

  readonly amount = signal<number | null>(null);
  readonly date = signal(new Date().toISOString().slice(0, 10));
  readonly reference = signal('');
  readonly note = signal('');
  readonly confirmAdvance = signal(false);
  readonly busy = signal(false);
  readonly error = signal('');

  readonly amountValue = computed(() => round2(this.amount() ?? 0));
  readonly after = computed(() => round2((this.supplier()?.balance ?? 0) - this.amountValue()));
  /** More than we owe (or anything when we owe nothing). */
  readonly isAdvance = computed(() => this.amountValue() > Math.max(0, this.supplier()?.balance ?? 0));
  readonly valid = computed(() => this.amountValue() > 0 && (!this.isAdvance() || this.confirmAdvance()));

  constructor() {
    effect(() => {
      if (this.visible()) untracked(() => { this.amount.set(null); this.reference.set(''); this.note.set(''); this.confirmAdvance.set(false); this.error.set(''); this.paymentBox.load(); });
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
      ...(this.reference().trim() ? { reference: this.reference().trim() } : {}),
      ...(this.note().trim() ? { note: this.note().trim() } : {}),
      ...(this.isAdvance() ? { confirmAdvance: true } : {}),
    });
    this.service.pay(s._id, payload).subscribe({
      next: (row) => { this.busy.set(false); this.visible.set(false); this.done.emit({ number: row.number, balanceAfter: row.balanceAfter }); },
      error: (response) => {
        this.busy.set(false);
        const code = response?.error?.code;
        const known = ['INSUFFICIENT_BALANCE', 'NO_OPEN_SHIFT', 'BOX_INACTIVE', 'BOX_NOT_ALLOWED', 'ADVANCE_NOT_CONFIRMED'];
        this.error.set(known.includes(code) ? `supplierPay.errors.${code}` : 'supplierPay.errors.failed');
      },
    });
  }
}
