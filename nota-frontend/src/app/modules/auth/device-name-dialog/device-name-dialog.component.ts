import { ChangeDetectionStrategy, Component, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslatePipe } from '@ngx-translate/core';
import { DialogModule } from 'primeng/dialog';
import { AuthService } from '../../../core/auth/auth.service';
import { DEVICE_NAME_MAX, DeviceService } from '../../../core/device/device.service';
import { NotaButtonDirective, NotaDialogShellComponent, NotaFormFieldComponent } from '../../shared/ui';

/**
 * Decision D: the name of this device (e.g. "كاشير 1"). Asked once, the first time a signed-in user opens the app in a
 * browser that has no name stored; changed later from the sidebar user card. The state lives in DeviceService.
 */
@Component({
  selector: 'nota-device-name-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, TranslatePipe, DialogModule, NotaDialogShellComponent, NotaFormFieldComponent, NotaButtonDirective],
  template: `
    <p-dialog [visible]="device.dialogOpen()" (visibleChange)="onVisible($event)" [modal]="true" [showHeader]="false" [closable]="false"
      [draggable]="false" [resizable]="false" styleClass="nota-p-dialog" (onShow)="start()">
      <nota-dialog-shell [title]="'auth.device.title' | translate" [closeLabel]="'auth.close' | translate" (closed)="close()">
        <form class="nota-auth-form" (ngSubmit)="save()" novalidate>
          <p class="nota-hint">{{ 'auth.device.lead' | translate }}</p>
          <nota-form-field [label]="'auth.device.name' | translate" forId="deviceName" [required]="true" [error]="error() | translate">
            <input id="deviceName" type="text" class="nota-input" name="deviceName" [attr.maxlength]="max" autocomplete="off"
              [placeholder]="'auth.device.placeholder' | translate" [ngModel]="value()" (ngModelChange)="value.set($event)" />
          </nota-form-field>
          <button type="submit" hidden></button>
        </form>
        <ng-container notaDialogFooter>
          <button type="button" notaButton (click)="close()">{{ 'auth.cancel' | translate }}</button>
          <button type="button" notaButton="primary" data-action="save-device-name" (click)="save()">{{ 'auth.device.save' | translate }}</button>
        </ng-container>
      </nota-dialog-shell>
    </p-dialog>
  `,
})
export class DeviceNameDialogComponent {
  protected readonly device = inject(DeviceService);
  private readonly auth = inject(AuthService);

  readonly max = DEVICE_NAME_MAX;
  readonly value = signal('');
  readonly error = signal('');

  constructor() {
    // The first time a signed-in user opens the app on a browser with no device name: ask once.
    effect(() => {
      const needsName = this.auth.signedIn() && !this.device.name() && !this.device.skipped();
      if (needsName) untracked(() => this.device.dialogOpen.set(true));
    });
  }

  start(): void {
    this.value.set(this.device.name());
    this.error.set('');
  }

  save(): void {
    if (!this.value().trim()) {
      this.error.set('auth.device.required');
      return;
    }
    this.device.setName(this.value());
    this.device.dialogOpen.set(false);
  }

  close(): void {
    // Closing the first question without a name: not asked again until the page is reloaded.
    if (!this.device.name()) this.device.skipped.set(true);
    this.device.dialogOpen.set(false);
  }

  onVisible(visible: boolean): void {
    if (!visible) this.close();
  }
}
