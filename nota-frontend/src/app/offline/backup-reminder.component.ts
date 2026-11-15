import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { AuthService } from '../core/auth/auth.service';
import { BackupStatus, getDesktopBridge } from '../core/runtime/runtime-config';

/**
 * Stage 25 (main PC): the home page tells whoever can back up when the last good backup (daily or manual) is more than 3 days old,
 * with a "back up now" button and the reminder to keep a copy on a USB drive or another disk. The desktop app works the number out
 * (lib/auto-backup.js summary: reminder, daysSinceGood); this only shows it. Nobody else sees it.
 */
@Component({
  selector: 'app-backup-reminder',
  imports: [RouterLink, TranslatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (visible()) {
      <div class="nota-bkr" role="alert" data-test="backup-reminder">
        <div class="nota-bkr__body">
          <p class="nota-bkr__text">
            @if (status()?.lastGood) {
              {{ 'backupReminder.old' | translate: { days: status()?.daysSinceGood } }}
            } @else {
              {{ 'backupReminder.never' | translate: { days: status()?.daysSinceGood } }}
            }
          </p>
          <p class="nota-bkr__usb">{{ 'backupReminder.usb' | translate }}</p>
          @if (failed()) { <p class="nota-bkr__usb" role="status" data-test="backup-reminder-failed">{{ 'backupReminder.failed' | translate }}</p> }
        </div>
        <div class="nota-bkr__actions">
          <button type="button" class="nota-btn nota-btn--primary" data-action="backup-now" [disabled]="busy()" (click)="backUpNow()">{{ 'backupReminder.now' | translate }}</button>
          <a class="nota-btn" routerLink="/backup" data-action="backup-open">{{ 'backupReminder.open' | translate }}</a>
        </div>
      </div>
    }
  `,
  styles: `
    :host { display: block; }
    .nota-bkr { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; justify-content: space-between; margin-block-end: 16px; padding: 14px 16px;
      border-radius: var(--radius-card); background: var(--warning-soft); color: var(--warning-text); line-height: 1.7; }
    .nota-bkr__body { flex: 1; min-width: 14rem; }
    .nota-bkr__text { margin: 0; font-weight: 700; }
    .nota-bkr__usb { margin: 4px 0 0; font-size: 0.9rem; }
    .nota-bkr__actions { display: flex; gap: 8px; flex-wrap: wrap; }
  `,
})
export class BackupReminderComponent {
  private readonly auth = inject(AuthService);
  private readonly bridge = getDesktopBridge()?.backup;
  protected readonly status = signal<BackupStatus | null>(null);
  protected readonly busy = signal(false);
  protected readonly failed = signal(false);
  protected readonly visible = computed(() => this.auth.has('backup.manage') && this.status()?.reminder === true);
  private loaded = false;

  constructor() {
    const bridge = this.bridge;
    if (!bridge) return;
    effect(() => {
      if (!this.auth.signedIn() || !this.auth.has('backup.manage') || this.loaded) return;
      this.loaded = true;
      this.refresh();
    });
    inject(DestroyRef).onDestroy(bridge.onStatus((value) => this.status.set(value)));
  }

  private async refresh(): Promise<void> {
    const result = await this.bridge?.status(this.auth.token());
    if (result?.ok) this.status.set(result.value);
  }

  protected async backUpNow(): Promise<void> {
    if (!this.bridge || this.busy()) return;
    this.busy.set(true);
    this.failed.set(false);
    try {
      const result = await this.bridge.create(this.auth.token());
      if (!result.ok) this.failed.set(true);
      await this.refresh(); // a cancelled save dialog or a failure leaves the reminder up
    } finally {
      this.busy.set(false);
    }
  }
}
