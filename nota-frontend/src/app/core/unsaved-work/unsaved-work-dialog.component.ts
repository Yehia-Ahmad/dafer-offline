import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { NotaButtonDirective } from '../../modules/shared/ui';
import { UnsavedWorkService } from './unsaved-work.service';

/** Stage 15: "you would lose unsaved work" confirmation (logout, switch user, leaving a screen). */
@Component({
  selector: 'nota-unsaved-work-dialog',
  imports: [TranslatePipe, NotaButtonDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (unsaved.prompt()) {
      <div class="nota-unsaved" role="alertdialog" aria-modal="true" aria-labelledby="notaUnsavedTitle" aria-describedby="notaUnsavedText" data-test="unsaved-dialog">
        <div class="nota-unsaved__card">
          <h2 id="notaUnsavedTitle" class="nota-unsaved__title">{{ 'session.unsaved.title' | translate }}</h2>
          <p id="notaUnsavedText" class="nota-unsaved__text">{{ 'session.unsaved.text' | translate }}</p>
          <div class="nota-unsaved__actions">
            <button type="button" notaButton="primary" (click)="unsaved.answer(false)" data-test="unsaved-stay">{{ 'session.unsaved.stay' | translate }}</button>
            <button type="button" notaButton="danger" (click)="unsaved.answer(true)" data-test="unsaved-leave">{{ 'session.unsaved.leave' | translate }}</button>
          </div>
        </div>
      </div>
    }
  `,
  styles: `
    :host { display: contents; }
    .nota-unsaved { position: fixed; inset: 0; z-index: 3100; display: grid; place-items: center; padding: 16px; background: var(--overlay); }
    .nota-unsaved__card { width: min(440px, 100%); display: flex; flex-direction: column; gap: 12px; padding: 24px; border-radius: var(--radius-dialog);
      background: var(--surface); color: var(--text); box-shadow: var(--shadow-dialog); }
    .nota-unsaved__title { margin: 0; font-size: 20px; font-weight: 800; }
    .nota-unsaved__text { margin: 0; line-height: 1.8; color: var(--text-muted); }
    .nota-unsaved__actions { display: flex; flex-wrap: wrap; gap: 10px; justify-content: flex-end; margin-block-start: 8px; }
  `,
})
export class UnsavedWorkDialogComponent {
  protected readonly unsaved = inject(UnsavedWorkService);
}
