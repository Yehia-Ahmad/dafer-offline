import { ChangeDetectionStrategy, Component, inject, input, output, signal } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { NotaButtonDirective } from '../../shared/ui';
import { recoveryCodeSheet } from '../../../core/print/documents/reports';
import { PrintService } from '../../../core/print/print.service';

/**
 * Stage 14: the owner's recovery code, shown once (after setup-owner, and after a recovery).
 * Copy and print; "متابعة" stays disabled until the owner ticks that they wrote it down.
 */
@Component({
  selector: 'nota-recovery-code',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslatePipe, NotaButtonDirective],
  host: { class: 'nota-rc' },
  template: `
    <div class="nota-rc__box">
      <h1 class="nota-rc__title">{{ 'auth.recoveryCode.title' | translate }}</h1>
      <p class="nota-rc__lead">{{ 'auth.recoveryCode.explain' | translate }}</p>
      @if (kind() === 'recover') {
        <p class="nota-rc__warn" role="note">{{ 'auth.recoveryCode.oldCodeInvalid' | translate }}</p>
      }
      <div class="nota-rc__code-wrap nota-rc-print">
        <span class="nota-rc__print-title">{{ 'auth.recoveryCode.printTitle' | translate: { shop: shopName() } }}</span>
        <code class="nota-rc__code" dir="ltr" data-testid="recovery-code">{{ code() }}</code>
        <span class="nota-rc__print-note">{{ 'auth.recoveryCode.printNote' | translate }}</span>
      </div>
      <div class="nota-rc__actions">
        <button type="button" notaButton data-action="copy-code" (click)="copy()">
          {{ (copied() ? 'auth.recoveryCode.copied' : 'auth.recoveryCode.copy') | translate }}
        </button>
        <button type="button" notaButton data-action="print-code" (click)="print()">{{ 'auth.recoveryCode.print' | translate }}</button>
      </div>
      <p class="nota-rc__main-only">{{ 'auth.recoveryCode.mainPcOnly' | translate }}</p>
      <label class="nota-rc__ack">
        <input type="checkbox" data-testid="ack" [checked]="acknowledged()" (change)="acknowledged.set($any($event.target).checked)" />
        <span>{{ 'auth.recoveryCode.ack' | translate }}</span>
      </label>
      <button type="button" notaButton="primary" class="nota-btn--lg nota-rc__continue" data-action="continue"
        [disabled]="!acknowledged()" (click)="continued.emit()">{{ 'auth.recoveryCode.continue' | translate }}</button>
    </div>
  `,
})
export class RecoveryCodeComponent {
  private readonly printService = inject(PrintService);
  readonly code = input.required<string>();
  /** setup: first run. recover: a new code after a recovery (the old one stopped working). */
  readonly kind = input<'setup' | 'recover'>('setup');
  readonly shopName = input('');
  readonly continued = output<void>();

  readonly acknowledged = signal(false);
  readonly copied = signal(false);

  async copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.code());
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 2500);
    } catch {
      // clipboard blocked: the code is on screen and can be printed
    }
  }

  /** Stage 23: the same print system as every document (shared header, no shop data: the shop may not exist yet). */
  async print(): Promise<void> {
    const code = this.code();
    await this.printService.print({ noShop: true, build: (ctx) => recoveryCodeSheet(ctx, { code }) });
  }
}
