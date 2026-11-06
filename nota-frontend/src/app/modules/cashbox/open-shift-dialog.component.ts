import { ChangeDetectionStrategy, Component, inject, input, model, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslatePipe } from '@ngx-translate/core';
import { Dialog } from 'primeng/dialog';
import { NotaButtonDirective, NotaDialogShellComponent, NotaFormFieldComponent, NotaMoneyPipe } from '../shared/ui';
import { CashboxService } from './cashbox.service';
import { ShiftSummary } from './cashbox.models';

/**
 * Stage 19: opens a shift on a drawer (CashBox.dc.html). The float is what the user counted in the drawer; it posts
 * nothing. When it differs from the balance the system holds, the backend answers FLOAT_MISMATCH with both numbers
 * and the user confirms the difference.
 */
@Component({
  selector: 'app-open-shift-dialog',
  standalone: true,
  imports: [FormsModule, TranslatePipe, Dialog, NotaButtonDirective, NotaDialogShellComponent, NotaFormFieldComponent, NotaMoneyPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <p-dialog [visible]="visible()" (visibleChange)="visible.set($event)" [modal]="true" [showHeader]="false" [closable]="false"
      [draggable]="false" [resizable]="false" styleClass="nota-p-dialog">
      <nota-dialog-shell [title]="'cashbox.shift.openTitle' | translate: { name: boxName() }" [closeLabel]="'cashbox.close' | translate" (closed)="cancel()">
        <nota-form-field [label]="'cashbox.shift.openingFloat' | translate" forId="shiftFloat" [hint]="'cashbox.shift.openingFloatHint' | translate"
          [error]="error() ? (error() | translate) : null">
          <input id="shiftFloat" class="nota-input nota-num" type="number" min="0" step="0.01" name="float" data-test="shift-float"
            [ngModel]="float()" (ngModelChange)="float.set($event); mismatch.set(null)" />
        </nota-form-field>
        @if (mismatch(); as m) {
          <div class="osd__mismatch" role="alert" data-test="float-mismatch">
            {{ 'cashbox.shift.floatMismatch' | translate: { balance: (m.balance | notaMoney), counted: (m.openingFloat | notaMoney), difference: (m.difference | notaMoney) } }}
          </div>
          <nota-form-field [label]="'cashbox.shift.openingNote' | translate" forId="shiftOpeningNote" [required]="true" [hint]="'cashbox.shift.openingNoteHint' | translate">
            <input id="shiftOpeningNote" class="nota-input" type="text" name="openingNote" data-test="opening-note" [ngModel]="note()" (ngModelChange)="note.set($event)" />
          </nota-form-field>
        }
        <ng-container notaDialogFooter>
          <button type="button" notaButton (click)="cancel()">{{ 'cashbox.cancel' | translate }}</button>
          <button type="button" notaButton="primary" [disabled]="busy() || float() === null || (mismatch() !== null && !note().trim())" data-action="open-shift" (click)="submit()">
            {{ (mismatch() ? 'cashbox.shift.confirmOpen' : 'cashbox.shift.open') | translate }}
          </button>
        </ng-container>
      </nota-dialog-shell>
    </p-dialog>
  `,
  styles: `.osd__mismatch { margin-top: 12px; padding: 12px 14px; border-radius: var(--radius-control); background: var(--warning-soft); color: var(--warning-text); font-size: 14px; line-height: 1.7; }`,
})
export class OpenShiftDialogComponent {
  private readonly cashbox = inject(CashboxService);

  readonly visible = model(false);
  readonly boxId = input.required<string>();
  readonly boxName = input('');
  readonly opened = output<ShiftSummary>();

  readonly float = signal<number | null>(null);
  readonly mismatch = signal<{ balance: number; openingFloat: number; difference: number } | null>(null);
  /** Why the drawer differs from the system (required once the difference is confirmed). */
  readonly note = signal('');
  readonly error = signal('');
  readonly busy = signal(false);

  cancel(): void {
    this.visible.set(false);
    this.mismatch.set(null);
    this.error.set('');
  }

  submit(): void {
    const openingFloat = this.float();
    if (openingFloat === null || openingFloat < 0) return;
    this.busy.set(true);
    this.error.set('');
    if (this.mismatch() && !this.note().trim()) return;
    this.cashbox.openShift({ boxId: this.boxId(), openingFloat, ...(this.mismatch() ? { confirmFloat: true, openingNote: this.note().trim() } : {}) }).subscribe({
      next: (shift) => {
        this.busy.set(false);
        this.visible.set(false);
        this.mismatch.set(null);
        this.note.set('');
        this.float.set(null);
        this.opened.emit(shift);
      },
      error: (response) => {
        this.busy.set(false);
        const body = response?.error ?? {};
        if (body.code === 'FLOAT_MISMATCH') {
          this.mismatch.set({ balance: body.balance, openingFloat: body.openingFloat, difference: body.difference });
          return;
        }
        this.error.set(body.code === 'SHIFT_ALREADY_OPEN' ? 'cashbox.shift.alreadyOpen' : 'cashbox.shift.openFailed');
      },
    });
  }
}
