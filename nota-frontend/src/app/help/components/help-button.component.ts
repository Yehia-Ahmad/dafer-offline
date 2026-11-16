import { ChangeDetectionStrategy, Component, inject, input } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { HelpPanelService } from '../help-panel.service';

/**
 * The contextual "؟" (desktop shell top bar, phone top bar, the phone root screens' headers). It opens THIS page's help
 * section: a side panel on the desktop, a full page on the phone. Small on purpose: it is in the main bundle; the content is not.
 */
@Component({
  selector: 'nota-help-button',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslatePipe],
  template: `
    <button type="button" [class]="variant() === 'phone' ? 'help-btn help-btn--phone' : 'nota-btn nota-btn--secondary nota-btn--icon help-btn'"
      (click)="open()" [attr.aria-label]="'help.pageHelp' | translate" [title]="'help.pageHelp' | translate" data-testid="help-button">
      <span aria-hidden="true">؟</span>
    </button>
  `,
  styles: [`
    :host { display: inline-flex; }
    .help-btn { font-weight: 800; font-size: 18px; line-height: 1; }
    .help-btn--phone { width: 40px; height: 40px; border-radius: 50%; border: 1px solid var(--border); background: var(--surface); color: var(--text); cursor: pointer; font-family: inherit; }
  `],
})
export class HelpButtonComponent {
  private readonly panel = inject(HelpPanelService);
  /** desktop = the shell's secondary icon button; phone = a round button for the phone headers. */
  readonly variant = input<'desktop' | 'phone'>('desktop');

  protected open(): void {
    void this.panel.openForCurrentPage();
  }
}
