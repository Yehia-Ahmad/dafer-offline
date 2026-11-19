import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { Dialog } from 'primeng/dialog';
import { NotaButtonDirective, NotaDialogShellComponent } from '../ui';

/**
 * Online Fixes 1: "الرقم ده متسجل باسم …" with its three choices. A PrimeNG dialog like the other POS dialogs (a bottom sheet on the phone
 * through the shared dialog CSS). Closing it with × is «الرقم غلط».
 */
@Component({
  selector: 'nota-customer-phone-dialog',
  // No box of its own: the dialog renders in the body, so a grid or flex parent must not give this element a cell.
  host: { style: 'display: contents' },
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Dialog, NotaDialogShellComponent, NotaButtonDirective, TranslatePipe],
  template: `
    <p-dialog [visible]="open()" (visibleChange)="$event ? null : wrong.emit()" [modal]="true" [showHeader]="false" [closable]="false" [draggable]="false"
      [resizable]="false" styleClass="nota-p-dialog" appendTo="body">
      <nota-dialog-shell [title]="'customerPhone.title' | translate" [closeLabel]="'customerPhone.wrong' | translate" (closed)="wrong.emit()">
        <p data-testid="phone-dialog-text">{{ 'customerPhone.text' | translate: { name: storedName() } }}</p>
        <ng-container notaDialogFooter>
          <button type="button" notaButton="primary" data-action="same" (click)="same.emit()">{{ 'customerPhone.same' | translate }}</button>
          @if (canRename()) {
            <button type="button" notaButton data-action="rename" (click)="rename.emit()">{{ 'customerPhone.rename' | translate: { name: typedName() } }}</button>
          }
          <button type="button" notaButton data-action="wrong" (click)="wrong.emit()">{{ 'customerPhone.wrong' | translate }}</button>
        </ng-container>
      </nota-dialog-shell>
    </p-dialog>
  `,
})
export class CustomerPhoneDialogComponent {
  readonly open = input(false);
  readonly storedName = input('');
  readonly typedName = input('');
  readonly canRename = input(false);
  readonly same = output<void>();
  readonly rename = output<void>();
  readonly wrong = output<void>();
}
