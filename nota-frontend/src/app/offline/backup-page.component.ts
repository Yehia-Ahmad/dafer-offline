import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { NotaButtonDirective, NotaPageHeaderComponent } from '../modules/shared/ui';
import {
  BackupCreated,
  BackupProgress,
  BackupRestored,
  BackupStatus,
  DesktopResult,
  getDesktopBridge,
} from '../core/runtime/runtime-config';

type Outcome =
  | { kind: 'created'; value: BackupCreated }
  | { kind: 'restored'; value: BackupRestored }
  | { kind: 'error'; message: string; detail?: string };

const DATE_FORMAT = 'yyyy-MM-dd HH:mm';

/**
 * Offline edition, main PC only (mainPcGuard): backup status, create a backup file, restore
 * from one, and the extra folder for a copy of each daily backup. The desktop app does the
 * work: file dialogs, confirmation, safety backup, pausing the server, the daily backup.
 * Stage 11: Backup.dc.html layout, only what the bridge supports (no backup list, no auto-backup settings).
 */
@Component({
  selector: 'app-backup-page',
  imports: [TranslatePipe, DatePipe, NotaButtonDirective, NotaPageHeaderComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './backup-page.component.html',
  styleUrl: './backup-page.component.scss',
})
export class BackupPageComponent {
  private readonly bridge = getDesktopBridge()?.backup;
  protected readonly dateFormat = DATE_FORMAT;
  protected readonly busy = signal<'create' | 'restore' | 'folder' | null>(null);
  protected readonly progress = signal<BackupProgress | null>(null);
  protected readonly outcome = signal<Outcome | null>(null);
  protected readonly status = signal<BackupStatus | null>(null);

  protected readonly progressKey = computed(() => {
    const progress = this.progress();
    return this.busy() && progress ? `backupPage.progress.${progress.phase}` : null;
  });
  protected readonly progressParams = computed(() => ({
    done: this.progress()?.done ?? 0,
    total: this.progress()?.total ?? 0,
  }));

  constructor() {
    if (this.bridge) {
      const destroyRef = inject(DestroyRef);
      destroyRef.onDestroy(this.bridge.onProgress((progress) => this.progress.set(progress)));
      // The daily backup and the extra folder copy update the status while the page is open.
      destroyRef.onDestroy(this.bridge.onStatus((status) => this.status.set(status)));
      this.refreshStatus();
    }
  }

  protected async create(): Promise<void> {
    await this.run('create', () => this.bridge!.create(), (value) => this.outcome.set({ kind: 'created', value }));
    await this.refreshStatus();
  }

  protected restore(): Promise<void> {
    return this.run('restore', () => this.bridge!.restore(), (value) => this.outcome.set({ kind: 'restored', value }));
  }

  protected chooseCopyFolder(): Promise<void> {
    return this.run('folder', () => this.bridge!.chooseCopyFolder(), (status) => this.status.set(status));
  }

  protected clearCopyFolder(): Promise<void> {
    return this.run('folder', () => this.bridge!.clearCopyFolder(), (status) => this.status.set(status));
  }

  protected showFile(path: string): void {
    this.bridge?.showFile(path);
  }

  protected openFolder(): void {
    this.bridge?.openFolder();
  }

  private async refreshStatus(): Promise<void> {
    const result = await this.bridge?.status();
    if (result?.ok) {
      const { value } = result as Extract<DesktopResult<BackupStatus>, { ok: true }>;
      this.status.set(value);
    }
  }

  private async run<T>(
    kind: 'create' | 'restore' | 'folder',
    action: () => Promise<DesktopResult<T>>,
    onValue: (value: T) => void
  ): Promise<void> {
    if (!this.bridge || this.busy()) return;
    this.busy.set(kind);
    this.progress.set(null);
    this.outcome.set(null);
    try {
      const result = await action();
      // Narrowed by hand: the project compiles with strict off, where this union does not narrow.
      if (result.ok === false) {
        const { error } = result as Extract<DesktopResult<T>, { ok: false }>;
        this.outcome.set({ kind: 'error', message: error.message, detail: error.detail });
      } else {
        const { value } = result as Extract<DesktopResult<T>, { ok: true }>;
        if (value) onValue(value);
      }
      // value === null: the user cancelled the dialog; nothing to show.
    } finally {
      this.busy.set(null);
      this.progress.set(null);
    }
  }
}
