import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { AuthService } from '../core/auth/auth.service';
import { UnsavedWorkService } from '../core/unsaved-work/unsaved-work.service';
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
  imports: [TranslatePipe, DatePipe, FormsModule, NotaButtonDirective, NotaPageHeaderComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './backup-page.component.html',
  styleUrl: './backup-page.component.scss',
})
export class BackupPageComponent {
  private readonly bridge = getDesktopBridge()?.backup;
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly unsaved = inject(UnsavedWorkService);
  private readonly translate = inject(TranslateService);
  /** Stage 15: the main process checks this token (backup.manage) before anything runs. */
  private readonly token = () => this.auth.token();

  /** Stage 15: restore asks for the signed-in user's password first. */
  protected readonly passwordOpen = signal(false);
  protected readonly restorePassword = signal('');
  protected readonly passwordError = signal('');
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
    await this.run('create', () => this.bridge!.create(this.token()), (value) => this.outcome.set({ kind: 'created', value }));
    await this.refreshStatus();
  }

  /** Stage 15: "استعادة" opens the password step; nothing is stopped or replaced before it is checked. */
  protected restore(): void {
    if (!this.bridge || this.busy()) return;
    this.outcome.set(null);
    this.restorePassword.set('');
    this.passwordError.set('');
    this.passwordOpen.set(true);
  }

  protected cancelRestore(): void {
    if (this.busy()) return;
    this.passwordOpen.set(false);
    this.restorePassword.set('');
    this.passwordError.set('');
  }

  protected async confirmRestore(): Promise<void> {
    if (!this.bridge || this.busy()) return;
    const password = this.restorePassword();
    if (!password) {
      this.passwordError.set(this.translate.instant('auth.validation.passwordRequired'));
      return;
    }
    this.passwordError.set('');
    let refused: { code?: string; message: string } | null = null;
    await this.run(
      'restore',
      () => this.bridge!.restore(this.token(), password),
      (value) => {
        this.outcome.set({ kind: 'restored', value });
        this.afterRestore();
      },
      (error) => {
        // A wrong password keeps the dialog open; the backend lockout gives LOGIN_LOCKED.
        if (error.code === 'WRONG_PASSWORD' || error.code === 'LOGIN_LOCKED') {
          refused = error;
          return true;
        }
        return false;
      }
    );
    this.restorePassword.set('');
    const wrong = refused as { code?: string; message: string } | null;
    if (wrong) {
      this.passwordError.set(
        wrong.code === 'WRONG_PASSWORD' ? this.translate.instant('session.lock.wrongPassword') : wrong.message
      );
    } else {
      this.passwordOpen.set(false);
    }
  }

  /** Stage 15: the restored backup's users replaced ours: sign in again with an account from it. */
  private afterRestore(): void {
    this.unsaved.allowNextNavigation();
    this.auth.clear();
    this.router.navigate(['/login'], { queryParams: { reason: 'restored' } });
  }

  protected chooseCopyFolder(): Promise<void> {
    return this.run('folder', () => this.bridge!.chooseCopyFolder(this.token()), (status) => this.status.set(status));
  }

  protected clearCopyFolder(): Promise<void> {
    return this.run('folder', () => this.bridge!.clearCopyFolder(this.token()), (status) => this.status.set(status));
  }

  protected showFile(path: string): void {
    this.bridge?.showFile(this.token(), path);
  }

  protected openFolder(): void {
    this.bridge?.openFolder(this.token());
  }

  private async refreshStatus(): Promise<void> {
    const result = await this.bridge?.status(this.token());
    if (result?.ok) {
      const { value } = result as Extract<DesktopResult<BackupStatus>, { ok: true }>;
      this.status.set(value);
    }
  }

  private async run<T>(
    kind: 'create' | 'restore' | 'folder',
    action: () => Promise<DesktopResult<T>>,
    onValue: (value: T) => void,
    /** Stage 15: true when the caller shows this error itself (e.g. a wrong password in the dialog). */
    ownError?: (error: { message: string; code?: string; detail?: string }) => boolean
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
        if (!ownError?.(error)) this.outcome.set({ kind: 'error', message: error.message, detail: error.detail });
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
