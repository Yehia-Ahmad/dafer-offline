import { ChangeDetectionStrategy, Component, OnInit, computed, inject, input, model } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslatePipe } from '@ngx-translate/core';
import { Dialog } from 'primeng/dialog';
import { NotaCanDirective } from '../../core/auth/nota-can.directive';
import { NotaButtonDirective, NotaDialogShellComponent, NotaFormFieldComponent } from '../shared/ui';
import { OpenShiftDialogComponent } from './open-shift-dialog.component';
import { PaymentBoxService } from './payment-box.service';
import { DepositOption, ShiftPanelComponent } from './shift-panel.component';

/**
 * Stage 19: the "طريقة الدفع" selector on every screen that takes or pays out money (POS, payments, down payment,
 * cash refund, "رد المقدم", credit payout). It lists the boxes this user may use and defaults as the backend does.
 * With a single box (a shop that never opened the cash page) it shows nothing, so nothing changes for the cashier.
 *
 * Under it: the "مفيش وردية مفتوحة" banner when the chosen drawer needs a shift, and the small "الوردية" button that
 * opens the shift (or its close panel).
 */
@Component({
  selector: 'nota-payment-box-select',
  standalone: true,
  imports: [FormsModule, TranslatePipe, Dialog, NotaCanDirective, NotaButtonDirective, NotaDialogShellComponent, NotaFormFieldComponent, OpenShiftDialogComponent, ShiftPanelComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'pbs' },
  template: `
    @if (service.boxes().length > 1) {
      <nota-form-field [label]="labelKey() | translate" forId="paymentBox">
        <select id="paymentBox" class="nota-select" name="paymentBox" data-test="payment-box"
          [ngModel]="service.effective()?._id" (ngModelChange)="service.select($event)">
          @for (box of service.boxes(); track box._id) {
            <option [value]="box._id">{{ box.name }} · {{ 'cashbox.types.' + box.type | translate }}</option>
          }
        </select>
      </nota-form-field>
    }
    @if (service.effective(); as box) {
      @if (box.shiftsEnabled) {
        <div class="pbs__shift">
          @if (box.needsShift) {
            <p class="pbs__banner" role="alert" data-test="no-shift-banner">{{ 'cashbox.noShiftBanner' | translate: { name: box.name } }}</p>
          }
          <button *notaCan="['shift.operate', 'shift.manage']; any: true" type="button" notaButton data-action="shift"
            (click)="box.needsShift ? openDialog.set(true) : panelDialog.set(true)">
            {{ (box.needsShift ? 'cashbox.shift.openButton' : 'cashbox.shift.button') | translate }}
          </button>
        </div>
      }
      <app-open-shift-dialog [(visible)]="openDialog" [boxId]="box._id" [boxName]="box.name" (opened)="shiftChanged()" />
      @if (box.openShift) {
        <p-dialog [(visible)]="panelDialog" [modal]="true" [showHeader]="false" [closable]="false" [draggable]="false" [resizable]="false"
          styleClass="nota-p-dialog pbs-dialog">
          <nota-dialog-shell [title]="'cashbox.shift.button' | translate" [closeLabel]="'cashbox.close' | translate" (closed)="panelDialog.set(false)">
            @if (panelDialog()) {
              <app-shift-panel [shiftId]="box.openShift._id" [depositOptions]="depositOptions()" (closed)="shiftChanged()" />
            }
          </nota-dialog-shell>
        </p-dialog>
      }
    }
  `,
  styles: `
    :host { display: flex; flex-direction: column; gap: 10px; }
    :host:empty { display: none; }
    /* The dialogs render in an overlay: their host elements must not take a flex slot (and a gap) here. */
    app-open-shift-dialog, p-dialog { display: contents; }
    .pbs__shift { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
    .pbs__banner { margin: 0; flex: 1 1 200px; padding: 10px 12px; border-radius: var(--radius-control); background: var(--warning-soft); color: var(--warning-text); font-size: 14px; font-weight: 700; }
  `,
})
export class PaymentBoxSelectComponent implements OnInit {
  protected readonly service = inject(PaymentBoxService);

  /** i18n key of the field label ("طريقة الدفع"; "من خزنة" on the expense form). */
  readonly labelKey = input('cashbox.paymentMethod');
  readonly openDialog = model(false);
  readonly panelDialog = model(false);

  readonly depositOptions = computed<DepositOption[]>(() => {
    const main = this.service.mainBox();
    const others = this.service.boxes().filter((box) => box.type !== 'cash').map((box) => ({ _id: box._id, name: box.name }));
    return [...(main ? [{ _id: main._id, name: main.name }] : []), ...others];
  });

  ngOnInit(): void {
    this.service.load();
  }

  /** A shift was opened or closed: the boxes' shift state changed. */
  shiftChanged(): void {
    this.service.load(true);
  }
}
