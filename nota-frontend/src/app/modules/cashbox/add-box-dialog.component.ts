import { ChangeDetectionStrategy, Component, inject, model, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslatePipe } from '@ngx-translate/core';
import { Dialog } from 'primeng/dialog';
import { NotaButtonDirective, NotaDialogShellComponent, NotaFormFieldComponent } from '../shared/ui';
import { CashboxService, CreateBoxPayload } from './cashbox.service';
import { BoxType, CashBox, DeviceRow } from './cashbox.models';

/**
 * Stage 19: "خزنة جديدة" (AddCashBox.dc.html). A drawer, an e-wallet or a bank account. A drawer can be bound to a PC
 * ("الجهاز اللي بيستخدمها تلقائي"): the list comes from the PCs the backend has seen, with "الجهاز ده" marked.
 * "رصيد البداية" is moved in from the main box.
 */
@Component({
  selector: 'app-add-box-dialog',
  standalone: true,
  imports: [FormsModule, TranslatePipe, Dialog, NotaButtonDirective, NotaDialogShellComponent, NotaFormFieldComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <p-dialog [visible]="visible()" (visibleChange)="onVisible($event)" [modal]="true" [showHeader]="false" [closable]="false"
      [draggable]="false" [resizable]="false" styleClass="nota-p-dialog abd-dialog">
      <nota-dialog-shell [title]="'cashbox.add.title' | translate" [closeLabel]="'cashbox.close' | translate" (closed)="cancel()">
        <fieldset class="abd__types">
          <legend class="nota-label">{{ 'cashbox.add.type' | translate }}</legend>
          <div class="abd__options">
            @for (option of types; track option) {
              <label class="abd__opt" [class.is-on]="type() === option">
                <input type="radio" name="boxType" [value]="option" [checked]="type() === option" (change)="type.set(option)" [attr.data-type]="option" />
                {{ 'cashbox.add.types.' + option | translate }}
              </label>
            }
          </div>
        </fieldset>
        <nota-form-field [label]="'cashbox.add.name' | translate" forId="boxName" [required]="true">
          <input id="boxName" class="nota-input" type="text" name="name" data-test="box-name" [ngModel]="name()" (ngModelChange)="name.set($event)" />
        </nota-form-field>
        @if (type() === 'cash') {
          <nota-form-field [label]="'cashbox.add.device' | translate" forId="boxDevice" [hint]="'cashbox.add.deviceHint' | translate"
            [error]="error() === 'DEVICE_ALREADY_BOUND' ? ('cashbox.errors.DEVICE_ALREADY_BOUND' | translate) : null">
            <select id="boxDevice" class="nota-select" name="device" data-test="box-device" [ngModel]="deviceId()" (ngModelChange)="deviceId.set($event)">
              <option value="">{{ 'cashbox.add.anyDevice' | translate }}</option>
              @for (device of devices(); track device.deviceId) {
                <option [value]="device.deviceId" [disabled]="!!device.boxId">
                  {{ device.name }}{{ device.isCurrent ? (' · ' + ('cashbox.add.thisDevice' | translate)) : '' }}{{ device.boxName ? (' · ' + device.boxName) : '' }}
                </option>
              }
            </select>
          </nota-form-field>
          <label class="abd__check">
            <input type="checkbox" name="shifts" data-test="box-shifts" [ngModel]="shifts()" (ngModelChange)="shifts.set($event)" />
            {{ 'cashbox.add.shifts' | translate }}
          </label>
        }
        <nota-form-field [label]="'cashbox.add.openingAmount' | translate" forId="boxOpening" [hint]="'cashbox.add.openingHint' | translate"
          [error]="error() === 'INSUFFICIENT_BALANCE' ? ('cashbox.errors.INSUFFICIENT_BALANCE' | translate) : null">
          <input id="boxOpening" class="nota-input nota-num" type="number" min="0" step="0.01" name="opening" data-test="box-opening"
            [ngModel]="opening()" (ngModelChange)="opening.set($event)" />
        </nota-form-field>
        @if (error() && error() !== 'DEVICE_ALREADY_BOUND' && error() !== 'INSUFFICIENT_BALANCE') {
          <p class="nota-error" role="alert" data-test="add-error">{{ 'cashbox.add.failed' | translate }}</p>
        }
        <ng-container notaDialogFooter>
          <button type="button" notaButton (click)="cancel()">{{ 'cashbox.cancel' | translate }}</button>
          <button type="button" notaButton="primary" data-action="save-box" [disabled]="busy() || !name().trim()" (click)="save()">{{ 'cashbox.add.save' | translate }}</button>
        </ng-container>
      </nota-dialog-shell>
    </p-dialog>
  `,
  styles: `
    .abd__types { border: none; margin: 0 0 14px; padding: 0; }
    .abd__options { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin-top: 8px; }
    .abd__opt { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 14px 8px; min-height: 44px; border-radius: var(--radius-control-lg); border: 1px solid var(--border-strong); font-size: 14px; cursor: pointer; text-align: center; }
    .abd__opt.is-on { border: 2px solid var(--brand); background: var(--brand-soft); color: var(--brand-strong-text); font-weight: 700; }
    .abd__opt input { accent-color: var(--brand); }
    .abd__check { display: flex; align-items: center; gap: 8px; min-height: 44px; font-size: 14px; }
    @media (max-width: 480px) { .abd__options { grid-template-columns: minmax(0, 1fr); } }
  `,
})
export class AddBoxDialogComponent {
  private readonly cashbox = inject(CashboxService);

  readonly visible = model(false);
  readonly created = output<CashBox>();

  readonly types: readonly BoxType[] = ['cash', 'wallet', 'bank'];
  readonly type = signal<BoxType>('cash');
  readonly name = signal('');
  readonly deviceId = signal('');
  readonly shifts = signal(true);
  readonly opening = signal<number | null>(null);
  readonly devices = signal<DeviceRow[]>([]);
  readonly error = signal('');
  readonly busy = signal(false);

  onVisible(open: boolean): void {
    this.visible.set(open);
    if (open) this.loadDevices();
  }

  /** Called by the page when it opens the dialog. */
  loadDevices(): void {
    this.cashbox.devices().subscribe({ next: (response) => this.devices.set(response.data), error: () => this.devices.set([]) });
  }

  cancel(): void {
    this.visible.set(false);
    this.error.set('');
  }

  payload(): CreateBoxPayload {
    const type = this.type();
    const opening = this.opening() ?? 0;
    return {
      name: this.name().trim(),
      type,
      ...(type === 'cash' && this.deviceId() ? { deviceId: this.deviceId() } : {}),
      ...(type === 'cash' ? { shiftsEnabled: this.shifts() } : {}),
      ...(opening > 0 ? { openingAmount: opening } : {}),
    };
  }

  save(): void {
    if (!this.name().trim()) return;
    this.busy.set(true);
    this.error.set('');
    this.cashbox.createBox(this.payload()).subscribe({
      next: (box) => {
        this.busy.set(false);
        this.visible.set(false);
        this.name.set(''); this.deviceId.set(''); this.opening.set(null); this.type.set('cash'); this.shifts.set(true);
        this.created.emit(box);
      },
      error: (response) => {
        this.busy.set(false);
        this.error.set(response?.error?.code ?? 'FAILED');
      },
    });
  }
}
