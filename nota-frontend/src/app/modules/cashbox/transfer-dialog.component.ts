import { ChangeDetectionStrategy, Component, computed, inject, input, model, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslatePipe } from '@ngx-translate/core';
import { Dialog } from 'primeng/dialog';
import { NotaButtonDirective, NotaDialogShellComponent, NotaFormFieldComponent, NotaMoneyPipe } from '../shared/ui';
import { CashboxService, TransferPayload } from './cashbox.service';
import { CashBox, TransferRow } from './cashbox.models';
import { localDateKey } from '../../core/utilities/local-date';

const round2 = (value: number) => Math.round(value * 100) / 100;

/** Stage 19: "تحويل بين الخزائن" (Transfer.dc.html): both balances before and after, as the design shows them. */
@Component({
  selector: 'app-transfer-dialog',
  standalone: true,
  imports: [FormsModule, TranslatePipe, Dialog, NotaButtonDirective, NotaDialogShellComponent, NotaFormFieldComponent, NotaMoneyPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <p-dialog [visible]="visible()" (visibleChange)="visible.set($event)" [modal]="true" [showHeader]="false" [closable]="false"
      [draggable]="false" [resizable]="false" styleClass="nota-p-dialog td-dialog">
      <nota-dialog-shell [title]="'cashbox.transfer.title' | translate" [closeLabel]="'cashbox.close' | translate" (closed)="cancel()">
        <div class="td__row">
          <div class="td__side">
            <nota-form-field [label]="'cashbox.transfer.from' | translate" forId="trFrom">
              <select id="trFrom" class="nota-select" name="from" data-test="transfer-from" [ngModel]="fromId()" (ngModelChange)="fromId.set($event)">
                <option value="">—</option>
                @for (box of boxes(); track box._id) { <option [value]="box._id">{{ box.name }}</option> }
              </select>
            </nota-form-field>
            @if (from(); as f) {
              <span class="nota-num td__bal" data-test="from-balance">{{ 'cashbox.transfer.balance' | translate }}: {{ f.balance ?? 0 | notaMoney }}
                @if (amountValue() > 0) { ← <b>{{ fromAfter() | notaMoney }}</b> }</span>
            }
          </div>
          <div class="td__arrow" aria-hidden="true">←</div>
          <div class="td__side">
            <nota-form-field [label]="'cashbox.transfer.to' | translate" forId="trTo">
              <select id="trTo" class="nota-select" name="to" data-test="transfer-to" [ngModel]="toId()" (ngModelChange)="toId.set($event)">
                <option value="">—</option>
                @for (box of boxes(); track box._id) { <option [value]="box._id">{{ box.name }}</option> }
              </select>
            </nota-form-field>
            @if (to(); as t) {
              <span class="nota-num td__bal" data-test="to-balance">{{ 'cashbox.transfer.balance' | translate }}: {{ t.balance ?? 0 | notaMoney }}
                @if (amountValue() > 0) { ← <b>{{ toAfter() | notaMoney }}</b> }</span>
            }
          </div>
        </div>
        <nota-form-field [label]="'cashbox.transfer.amount' | translate" forId="trAmount" [required]="true"
          [error]="insufficient() ? ('cashbox.errors.INSUFFICIENT_BALANCE' | translate) : (sameBox() ? ('cashbox.errors.SAME_BOX' | translate) : null)">
          <input id="trAmount" class="nota-input nota-num td__amount" type="number" min="0" step="0.01" name="amount" data-test="transfer-amount"
            [ngModel]="amount()" (ngModelChange)="amount.set($event)" />
        </nota-form-field>
        <div class="td__grid">
          <nota-form-field [label]="'cashbox.transfer.date' | translate" forId="trDate">
            <input id="trDate" class="nota-input nota-num" type="date" name="date" data-test="transfer-date" [ngModel]="date()" (ngModelChange)="date.set($event)" />
          </nota-form-field>
          <nota-form-field [label]="'cashbox.transfer.note' | translate" forId="trNote">
            <input id="trNote" class="nota-input" type="text" name="note" data-test="transfer-note" [ngModel]="note()" (ngModelChange)="note.set($event)" />
          </nota-form-field>
        </div>
        @if (error()) { <p class="nota-error" role="alert" data-test="transfer-error">{{ error() | translate }}</p> }
        <ng-container notaDialogFooter>
          <button type="button" notaButton (click)="cancel()">{{ 'cashbox.cancel' | translate }}</button>
          <button type="button" notaButton="primary" data-action="do-transfer" [disabled]="!valid() || busy()" (click)="save()">{{ 'cashbox.transfer.submit' | translate }}</button>
        </ng-container>
      </nota-dialog-shell>
    </p-dialog>
  `,
  styles: `
    .td__row { display: flex; flex-wrap: wrap; align-items: stretch; gap: 12px; margin-bottom: 16px; }
    .td__side { flex: 1 1 200px; display: flex; flex-direction: column; gap: 8px; padding: 14px; border-radius: 14px; border: 1px solid var(--border); }
    .td__arrow { display: flex; align-items: center; justify-content: center; font-size: 24px; color: var(--brand); }
    .td__bal { font-size: 13px; color: var(--text-muted); }
    .td__bal b { color: var(--text); }
    .td__amount { font-size: 22px; font-weight: 800; }
    .td__grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin-top: 12px; }
    @media (max-width: 480px) { .td__grid { grid-template-columns: minmax(0, 1fr); } .td__arrow { flex-basis: 100%; transform: rotate(-90deg); } }
  `,
})
export class TransferDialogComponent {
  private readonly cashbox = inject(CashboxService);

  readonly visible = model(false);
  /** Active boxes with their balances (cashbox.view). */
  readonly boxes = input<CashBox[]>([]);
  readonly done = output<TransferRow>();

  readonly fromId = signal('');
  readonly toId = signal('');
  readonly amount = signal<number | null>(null);
  readonly date = signal(localDateKey());
  readonly note = signal('');
  readonly error = signal('');
  readonly busy = signal(false);

  readonly from = computed(() => this.boxes().find((box) => box._id === this.fromId()) ?? null);
  readonly to = computed(() => this.boxes().find((box) => box._id === this.toId()) ?? null);
  readonly amountValue = computed(() => this.amount() ?? 0);
  readonly fromAfter = computed(() => round2((this.from()?.balance ?? 0) - this.amountValue()));
  readonly toAfter = computed(() => round2((this.to()?.balance ?? 0) + this.amountValue()));
  readonly insufficient = computed(() => Boolean(this.from()) && this.amountValue() > (this.from()?.balance ?? 0));
  readonly sameBox = computed(() => Boolean(this.fromId()) && this.fromId() === this.toId());
  readonly valid = computed(() => Boolean(this.from() && this.to()) && !this.sameBox() && this.amountValue() > 0 && !this.insufficient());

  cancel(): void {
    this.visible.set(false);
    this.error.set('');
  }

  payload(): TransferPayload {
    return {
      fromBoxId: this.fromId(), toBoxId: this.toId(), amount: this.amountValue(),
      ...(this.date() ? { date: this.date() } : {}), ...(this.note().trim() ? { note: this.note().trim() } : {}),
    };
  }

  save(): void {
    if (!this.valid()) return;
    this.busy.set(true);
    this.error.set('');
    this.cashbox.createTransfer(this.payload()).subscribe({
      next: (row) => {
        this.busy.set(false);
        this.visible.set(false);
        this.amount.set(null); this.note.set(''); this.fromId.set(''); this.toId.set('');
        this.done.emit(row);
      },
      error: (response) => {
        this.busy.set(false);
        const code = response?.error?.code;
        this.error.set(code === 'INSUFFICIENT_BALANCE' ? 'cashbox.errors.INSUFFICIENT_BALANCE' : 'cashbox.transfer.failed');
      },
    });
  }
}
