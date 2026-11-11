import { LockDateService } from '../../core/accounting-lock/lock-date.service';
import { ChangeDetectionStrategy, Component, computed, inject, input, model, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslatePipe } from '@ngx-translate/core';
import { Dialog } from 'primeng/dialog';
import { NotaButtonDirective, NotaDialogShellComponent, NotaFormFieldComponent, NotaLockBannerComponent, NotaLockedDateDirective } from '../shared/ui';
import { CashboxService, DrawingPayload } from './cashbox.service';
import { CashBox, DrawingRow } from './cashbox.models';
import { localDateKey } from '../../core/utilities/local-date';

/** Stage 19: "سحب المالك" — a small dialog from the cash page, owner only (owner.drawings). Dr جاري المالك / Cr box. */
@Component({
  selector: 'app-drawing-dialog',
  standalone: true,
  imports: [NotaLockBannerComponent, NotaLockedDateDirective, FormsModule, TranslatePipe, Dialog, NotaButtonDirective, NotaDialogShellComponent, NotaFormFieldComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <p-dialog [visible]="visible()" (visibleChange)="visible.set($event)" [modal]="true" [showHeader]="false" [closable]="false"
      [draggable]="false" [resizable]="false" styleClass="nota-p-dialog">
      <nota-dialog-shell [title]="'cashbox.drawing.title' | translate" [closeLabel]="'cashbox.close' | translate" (closed)="cancel()">
        <nota-form-field [label]="'cashbox.drawing.box' | translate" forId="drBox">
          <select id="drBox" class="nota-select" name="box" data-test="drawing-box" [ngModel]="boxId()" (ngModelChange)="boxId.set($event)">
            @for (box of boxes(); track box._id) { <option [value]="box._id">{{ box.name }}</option> }
          </select>
        </nota-form-field>
        <nota-form-field [label]="'cashbox.drawing.amount' | translate" forId="drAmount" [required]="true"
          [error]="error() === 'INSUFFICIENT_BALANCE' ? ('cashbox.errors.INSUFFICIENT_BALANCE' | translate) : null">
          <input id="drAmount" class="nota-input nota-num" type="number" min="0" step="0.01" name="amount" data-test="drawing-amount" [ngModel]="amount()" (ngModelChange)="amount.set($event)" />
        </nota-form-field>
        <nota-form-field [label]="'cashbox.drawing.date' | translate" forId="drDate">
          <input id="drDate" class="nota-input nota-num" type="date" notaLockedDate name="date" data-test="drawing-date" [ngModel]="date()" (ngModelChange)="date.set($event)" />
      <nota-lock-banner [selected]="date()" />
        </nota-form-field>
        <nota-form-field [label]="'cashbox.drawing.note' | translate" forId="drNote">
          <input id="drNote" class="nota-input" type="text" name="note" data-test="drawing-note" [ngModel]="note()" (ngModelChange)="note.set($event)" />
        </nota-form-field>
        @if (error() && error() !== 'INSUFFICIENT_BALANCE') { <p class="nota-error" role="alert">{{ 'cashbox.drawing.failed' | translate }}</p> }
        <ng-container notaDialogFooter>
          <button type="button" notaButton (click)="cancel()">{{ 'cashbox.cancel' | translate }}</button>
          <button type="button" notaButton="primary" data-action="do-drawing" [disabled]="!valid() || busy()" (click)="save()">{{ 'cashbox.drawing.submit' | translate }}</button>
        </ng-container>
      </nota-dialog-shell>
    </p-dialog>
  `,
})
export class DrawingDialogComponent {
  /** Stage 22: a date inside a closed period cannot be submitted (the banner explains, the server refuses too). */
  private readonly lock = inject(LockDateService);
  private readonly cashbox = inject(CashboxService);

  readonly visible = model(false);
  readonly boxes = input<CashBox[]>([]);
  readonly done = output<DrawingRow>();

  readonly boxId = signal('');
  readonly amount = signal<number | null>(null);
  readonly date = signal(localDateKey());
  readonly note = signal('');
  readonly error = signal('');
  readonly busy = signal(false);

  readonly valid = computed(() => (this.amount() ?? 0) > 0 && Boolean(this.boxId() || this.boxes().length) && !this.lock.isLocked(this.date()));

  cancel(): void {
    this.visible.set(false);
    this.error.set('');
  }

  payload(): DrawingPayload {
    return {
      boxId: this.boxId() || this.boxes()[0]?._id, amount: this.amount() ?? 0,
      ...(this.date() ? { date: this.date() } : {}), ...(this.note().trim() ? { note: this.note().trim() } : {}),
    };
  }

  save(): void {
    if (!this.valid()) return;
    this.busy.set(true);
    this.error.set('');
    this.cashbox.createDrawing(this.payload()).subscribe({
      next: (row) => { this.busy.set(false); this.visible.set(false); this.amount.set(null); this.note.set(''); this.done.emit(row); },
      error: (response) => { this.busy.set(false); this.error.set(response?.error?.code ?? 'FAILED'); },
    });
  }
}
