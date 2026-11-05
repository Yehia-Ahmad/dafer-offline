import { ChangeDetectionStrategy, Component, inject, model, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { DialogModule } from 'primeng/dialog';
import { AuthService } from '../../../core/auth/auth.service';
import { ToastService } from '../../../core/auth/toast.service';
import { NotaButtonDirective, NotaDialogShellComponent, NotaFormFieldComponent } from '../../shared/ui';
import { authErrorText, passwordProblemKey } from '../auth-form.util';

/**
 * Stage 14: "change my password" from the sidebar user card. The backend ends the old sessions;
 * the token it returns keeps this window signed in.
 */
@Component({
  selector: 'nota-change-password-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, TranslatePipe, DialogModule, NotaDialogShellComponent, NotaFormFieldComponent, NotaButtonDirective],
  template: `
    <p-dialog [visible]="open()" (visibleChange)="open.set($event)" [modal]="true" [showHeader]="false" [closable]="false"
      [draggable]="false" [resizable]="false" styleClass="nota-p-dialog" (onHide)="reset()">
      <nota-dialog-shell [title]="'auth.changePassword.title' | translate" [closeLabel]="'auth.close' | translate" (closed)="close()">
        <form class="nota-auth-form" (ngSubmit)="submit()" novalidate>
          <nota-form-field [label]="'auth.changePassword.current' | translate" forId="cpCurrent" [required]="true"
            [error]="fieldErrors().current | translate">
            <input id="cpCurrent" type="password" class="nota-input" name="current" autocomplete="current-password"
              [ngModel]="current()" (ngModelChange)="current.set($event)" />
          </nota-form-field>
          <nota-form-field [label]="'auth.changePassword.new' | translate" forId="cpNew" [required]="true"
            [hint]="'auth.validation.passwordHint' | translate" [error]="fieldErrors().next | translate">
            <input id="cpNew" type="password" class="nota-input" name="next" autocomplete="new-password"
              [ngModel]="next()" (ngModelChange)="next.set($event)" />
          </nota-form-field>
          <nota-form-field [label]="'auth.changePassword.confirm' | translate" forId="cpConfirm" [required]="true"
            [error]="fieldErrors().confirm | translate">
            <input id="cpConfirm" type="password" class="nota-input" name="confirm" autocomplete="new-password"
              [ngModel]="confirm()" (ngModelChange)="confirm.set($event)" />
          </nota-form-field>
          <p class="nota-hint">{{ 'auth.changePassword.note' | translate }}</p>
          @if (error()) {
            <p class="nota-error" role="alert">{{ error() }}</p>
          }
          <button type="submit" hidden></button>
        </form>
        <ng-container notaDialogFooter>
          <button type="button" notaButton (click)="close()" [disabled]="saving()">{{ 'auth.cancel' | translate }}</button>
          <button type="button" notaButton="primary" data-action="save-password" (click)="submit()" [disabled]="saving()">
            {{ 'auth.changePassword.save' | translate }}
          </button>
        </ng-container>
      </nota-dialog-shell>
    </p-dialog>
  `,
})
export class ChangePasswordDialogComponent {
  private readonly auth = inject(AuthService);
  private readonly translate = inject(TranslateService);
  private readonly toast = inject(ToastService);

  readonly open = model(false);
  readonly current = signal('');
  readonly next = signal('');
  readonly confirm = signal('');
  readonly saving = signal(false);
  readonly error = signal('');
  readonly fieldErrors = signal<{ current: string; next: string; confirm: string }>({ current: '', next: '', confirm: '' });

  submit(): void {
    if (this.saving()) return;
    const errors = {
      current: this.current() ? '' : 'auth.validation.passwordRequired',
      next: passwordProblemKey(this.next()) ?? '',
      confirm: this.confirm() === this.next() ? '' : 'auth.validation.passwordMismatch',
    };
    this.fieldErrors.set(errors);
    this.error.set('');
    if (errors.current || errors.next || errors.confirm) return;
    this.saving.set(true);
    this.auth.changePassword(this.current(), this.next()).subscribe({
      next: () => {
        this.saving.set(false);
        this.toast.show(this.translate.instant('auth.changePassword.done'), 'success');
        this.close();
      },
      error: (error) => {
        this.saving.set(false);
        if ((error as { error?: { code?: string } })?.error?.code === 'WRONG_PASSWORD') {
          this.fieldErrors.set({ ...errors, current: 'auth.errors.WRONG_PASSWORD' });
        } else {
          this.error.set(authErrorText(error, this.translate));
        }
      },
    });
  }

  close(): void {
    this.open.set(false);
    this.reset();
  }

  reset(): void {
    this.current.set('');
    this.next.set('');
    this.confirm.set('');
    this.error.set('');
    this.fieldErrors.set({ current: '', next: '', confirm: '' });
  }
}
