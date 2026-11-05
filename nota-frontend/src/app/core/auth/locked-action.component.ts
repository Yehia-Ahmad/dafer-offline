import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';

/**
 * Design system "permission-locked action": lock icon + short note that the action needs a
 * manager/owner permission. Used where simply hiding the action would confuse (invoice delete,
 * invoice discount).
 */
@Component({
  selector: 'nota-locked-action',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslatePipe],
  host: { class: 'nota-locked', role: 'note' },
  template: `
    <svg class="nota-locked__icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
      stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3" /></svg>
    @if (label()) {
      <span class="nota-locked__label">{{ label() }}</span>
    }
    <span class="nota-locked__note">{{ (note() || 'auth.locked.default') | translate }}</span>
  `,
})
export class LockedActionComponent {
  /** The locked action's name, e.g. "حذف". */
  readonly label = input('');
  /** i18n key of the note; default "محتاج صلاحية من المدير أو المالك". */
  readonly note = input('');
}
