import { ChangeDetectionStrategy, Component, effect, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslatePipe } from '@ngx-translate/core';
import { Dialog } from 'primeng/dialog';
import { LayoutService } from '../../../core/layout/layout.service';
import { NotaButtonDirective } from './button.directive';
import { NotaDialogShellComponent } from './dialog-shell.component';
import { NotaFormFieldComponent } from './form-field.component';

/**
 * Online Fixes 1: the red confirm dialog of every correction screen (cancel a payout, a supplier payment, a transfer, a drawing, a supplier
 * refund voucher…, and deactivating a box or a supplier). A PrimeNG dialog like the other ones (a bottom sheet on the phone through the
 * shared dialog CSS); the destructive button is red. With `requireReason` it asks for a reason (3 to 500 characters, the backend rule)
 * and `confirmed` carries it; without it the button just confirms (`confirmed` carries '').
 */
@Component({
  selector: 'nota-cancel-reason-dialog',
  host: { style: 'display: contents' }, // the dialog renders in the body: no cell in a grid or flex parent
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, Dialog, TranslatePipe, NotaButtonDirective, NotaDialogShellComponent, NotaFormFieldComponent],
  template: `
    <p-dialog [visible]="open()" (visibleChange)="$event ? null : closed.emit()" [modal]="true" [showHeader]="false" [closable]="false" [draggable]="false"
      [resizable]="false" styleClass="nota-p-dialog" appendTo="body">
      <nota-dialog-shell [title]="title()" [closeLabel]="'corrections.close' | translate" (closed)="closed.emit()">
        @if (text()) { <p data-testid="correction-text">{{ text() }}</p> }
        @if (requireReason()) {
          @if (layout.isMobile()) {
            <label class="m-field">{{ reasonLabel() || ('corrections.reason' | translate) }} *
              <input class="m-input" type="text" maxlength="500" name="correctionReasonM" data-test="cancel-reason" [ngModel]="reason()" (ngModelChange)="reason.set($event)" />
            </label>
          } @else {
            <nota-form-field [label]="reasonLabel() || ('corrections.reason' | translate)" forId="correctionReason" [required]="true">
              <input id="correctionReason" class="nota-input" type="text" maxlength="500" name="correctionReason" data-test="cancel-reason" [ngModel]="reason()" (ngModelChange)="reason.set($event)" />
            </nota-form-field>
          }
        }
        @if (error()) { <p class="nota-error" role="alert" data-testid="correction-error">{{ error() }}</p> }
        <ng-container notaDialogFooter>
          @if (layout.isMobile()) {
            <button type="button" class="m-btn" (click)="closed.emit()" [disabled]="busy()">{{ 'corrections.back' | translate }}</button>
            <button type="button" class="m-btn m-btn--danger" data-action="confirm-correction" [disabled]="!canConfirm()" (click)="confirm()">{{ confirmLabel() }}</button>
          } @else {
            <button type="button" notaButton (click)="closed.emit()" [disabled]="busy()">{{ 'corrections.back' | translate }}</button>
            <button type="button" notaButton="danger" data-action="confirm-correction" [disabled]="!canConfirm()" (click)="confirm()">{{ confirmLabel() }}</button>
          }
        </ng-container>
      </nota-dialog-shell>
    </p-dialog>
  `,
})
export class NotaCancelReasonDialogComponent {
  protected readonly layout = inject(LayoutService);

  readonly open = input(false);
  readonly title = input('');
  readonly text = input('');
  readonly confirmLabel = input('');
  readonly reasonLabel = input('');
  readonly requireReason = input(true);
  readonly busy = input(false);
  /** An already-translated error message (what the server refused, in Arabic). */
  readonly error = input('');
  readonly confirmed = output<string>();
  readonly closed = output<void>();

  protected readonly reason = signal('');

  constructor() {
    // A fresh reason every time the dialog opens.
    effect(() => { if (this.open()) this.reason.set(''); });
  }

  protected canConfirm(): boolean {
    if (this.busy()) return false;
    return !this.requireReason() || this.reason().trim().length >= 3;
  }

  protected confirm(): void {
    if (!this.canConfirm()) return;
    this.confirmed.emit(this.requireReason() ? this.reason().trim() : '');
  }
}
