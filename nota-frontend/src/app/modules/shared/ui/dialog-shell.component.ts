import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

/**
 * Dialog layout: header (title + × close), body, footer bar (--surface-2) for actions.
 * Meant for PrimeNG's p-dialog, which the app uses most:
 *
 * <p-dialog [(visible)]="open" [modal]="true" [showHeader]="false" styleClass="nota-p-dialog">
 *   <nota-dialog-shell title="عميل جديد" closeLabel="إغلاق" (closed)="open = false">
 *     …fields…
 *     <ng-container notaDialogFooter>
 *       <button notaButton (click)="open = false">إلغاء</button>
 *       <button notaButton="primary">حفظ</button>
 *     </ng-container>
 *   </nota-dialog-shell>
 * </p-dialog>
 *
 * Works the same inside a MatDialog component.
 */
@Component({
  selector: 'nota-dialog-shell',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'nota-dialog', role: 'document' },
  styles: `.nota-dialog__footer:empty { display: none; }`,
  template: `
    <div class="nota-dialog__header">
      <h2 class="nota-dialog__title">{{ title() }}</h2>
      <button type="button" class="nota-btn nota-btn--secondary nota-btn--icon" [attr.aria-label]="closeLabel()" (click)="closed.emit()">×</button>
    </div>
    <div class="nota-dialog__body">
      <ng-content />
    </div>
    <div class="nota-dialog__footer"><ng-content select="[notaDialogFooter]" /></div>
  `,
})
export class NotaDialogShellComponent {
  readonly title = input.required<string>();
  readonly closeLabel = input('Close');
  readonly closed = output<void>();
}
