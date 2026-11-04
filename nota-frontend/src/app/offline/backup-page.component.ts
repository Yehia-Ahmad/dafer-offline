import { AsyncPipe, DatePipe, NgClass } from '@angular/common';
import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { LanguageService } from '../modules/shared/services/translation.service';
import { ThemeService } from '../modules/shared/services/theme.service';
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
 */
@Component({
  selector: 'app-backup-page',
  imports: [TranslatePipe, AsyncPipe, DatePipe, NgClass],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
      <main class="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4 md:p-8" [attr.dir]="direction()">
        <header>
          <h1 class="mb-1 text-2xl font-bold">{{ 'backupPage.title' | translate }}</h1>
          <p class="text-gray-500">{{ 'backupPage.subtitle' | translate }}</p>
        </header>

        @if (status(); as s) {
          <section class="rounded-xl p-6 leading-7" [ngClass]="cardClass(isDarkMode$ | async)" data-test="backup-status">
            <h2 class="mb-2 text-lg font-semibold">{{ 'backupPage.status.title' | translate }}</h2>
            @if (s.lastBackup; as last) {
              <p>
                {{ 'backupPage.status.lastBackup' | translate: { date: (last.at | date: dateFormat) } }}
                {{ 'backupPage.status.kind.' + last.kind | translate }}
              </p>
            } @else {
              <p>{{ 'backupPage.status.none' | translate }}</p>
            }
            <p class="text-gray-500">{{ 'backupPage.status.daily' | translate: { keep: s.keep } }}</p>
            @if (s.autoError; as failure) {
              <p class="text-[#8a1c12]">
                {{ 'backupPage.status.autoError' | translate: { date: (failure.at | date: dateFormat), message: failure.message } }}
              </p>
            }
          </section>

          @if (s.externalOverdue) {
            <div class="rounded-xl bg-[#fff8e1] p-4 leading-7 text-[#5d4300]" role="note" data-test="external-warning">
              <p class="font-semibold">{{ 'backupPage.warning.title' | translate }}</p>
              <p>
                @if (s.lastExternal; as external) {
                  {{ 'backupPage.warning.since' | translate: { date: (external.at | date: dateFormat), days: s.externalMaxAgeDays } }}
                } @else {
                  {{ 'backupPage.warning.never' | translate }}
                }
                {{ 'backupPage.warning.advice' | translate: { drive: s.dataDrive } }}
              </p>
            </div>
          }
        }

        <section class="rounded-xl p-6" [ngClass]="cardClass(isDarkMode$ | async)">
          <h2 class="mb-2 text-lg font-semibold">{{ 'backupPage.create.title' | translate }}</h2>
          <p class="mb-4 leading-7">{{ 'backupPage.create.description' | translate }}</p>
          <button type="button" class="rounded-lg bg-[#FF9933] px-5 py-2 font-semibold text-[#2f2f2f] disabled:opacity-60"
            [disabled]="busy()" (click)="create()">
            {{ (busy() === 'create' ? 'backupPage.create.working' : 'backupPage.create.button') | translate }}
          </button>
        </section>

        <section class="rounded-xl p-6" [ngClass]="cardClass(isDarkMode$ | async)">
          <h2 class="mb-2 text-lg font-semibold">{{ 'backupPage.restore.title' | translate }}</h2>
          <p class="mb-4 leading-7">{{ 'backupPage.restore.description' | translate }}</p>
          <button type="button" class="rounded-lg px-5 py-2 font-semibold outline outline-1 outline-[#FF9933] disabled:opacity-60"
            [disabled]="busy()" (click)="restore()">
            {{ (busy() === 'restore' ? 'backupPage.restore.working' : 'backupPage.restore.button') | translate }}
          </button>
        </section>

        @if (progressKey(); as key) {
          <div class="flex items-center gap-3" role="status">
            <span class="h-5 w-5 animate-spin rounded-full border-4 border-gray-300 border-t-[#FF9933]"></span>
            <span>{{ key | translate: progressParams() }}</span>
          </div>
        }

        @if (outcome(); as result) {
          <div class="rounded-xl p-4 leading-7" role="alert"
            [ngClass]="result.kind === 'error' ? 'bg-[#fdecea] text-[#8a1c12]' : 'bg-[#e8f5e9] text-[#1b5e20]'">
            @switch (result.kind) {
              @case ('created') {
                <p>{{ 'backupPage.create.done' | translate: { collections: result.value.collections, documents: result.value.documents, size: result.value.sizeMb } }}</p>
                <p class="break-all font-mono text-sm" dir="ltr">{{ result.value.path }}</p>
                @if (result.value.sameDrive) {
                  <p class="mt-2 text-[#5d4300]" data-test="same-drive-backup">
                    {{ 'backupPage.create.sameDrive' | translate: { drive: status()?.dataDrive } }}
                  </p>
                }
                <button type="button" class="mt-2 underline" (click)="showFile(result.value.path)">{{ 'backupPage.showFile' | translate }}</button>
              }
              @case ('restored') {
                <p>{{ 'backupPage.restore.done' | translate: { collections: result.value.collections, documents: result.value.restored } }}</p>
                @if (result.value.safetyPath) {
                  <p>{{ 'backupPage.restore.safety' | translate }}</p>
                  <p class="break-all font-mono text-sm" dir="ltr">{{ result.value.safetyPath }}</p>
                }
              }
              @case ('error') {
                <p>{{ result.message }}</p>
                @if (result.detail) {
                  <pre class="mt-2 whitespace-pre-wrap text-xs" dir="ltr">{{ result.detail }}</pre>
                }
              }
            }
          </div>
        }

        @if (status(); as s) {
          <section class="rounded-xl p-6 leading-7" [ngClass]="cardClass(isDarkMode$ | async)" data-test="copy-folder">
            <h2 class="mb-2 text-lg font-semibold">{{ 'backupPage.copy.title' | translate }}</h2>
            <p class="mb-3">{{ 'backupPage.copy.description' | translate }}</p>
            @if (s.copyFolder) {
              <p class="break-all font-mono text-sm" dir="ltr">{{ s.copyFolder }}</p>
              @if (s.copyFolderSameDrive) {
                <p class="my-2 rounded-lg bg-[#fff8e1] p-3 text-[#5d4300]" role="note" data-test="copy-same-drive">
                  {{ 'backupPage.copy.sameDrive' | translate: { drive: s.dataDrive } }}
                </p>
              }
              @if (s.lastCopy; as copy) {
                @switch (copy.status) {
                  @case ('copied') {
                    <p class="text-[#1b5e20]">{{ 'backupPage.copy.copied' | translate: { date: (copy.at | date: dateFormat) } }}</p>
                  }
                  @case ('unavailable') {
                    <p class="text-[#5d4300]">{{ 'backupPage.copy.unavailable' | translate }}</p>
                  }
                  @case ('failed') {
                    <p class="text-[#8a1c12]">{{ 'backupPage.copy.failed' | translate: { message: copy.message } }}</p>
                  }
                }
              } @else {
                <p class="text-gray-500">{{ 'backupPage.copy.waiting' | translate }}</p>
              }
            } @else {
              <p class="text-gray-500">{{ 'backupPage.copy.none' | translate }}</p>
            }
            <div class="mt-4 flex flex-wrap gap-3">
              <button type="button" class="rounded-lg px-5 py-2 font-semibold outline outline-1 outline-[#FF9933] disabled:opacity-60"
                [disabled]="busy()" (click)="chooseCopyFolder()">
                {{ (s.copyFolder ? 'backupPage.copy.change' : 'backupPage.copy.choose') | translate }}
              </button>
              @if (s.copyFolder) {
                <button type="button" class="underline disabled:opacity-60" [disabled]="busy()" (click)="clearCopyFolder()">
                  {{ 'backupPage.copy.clear' | translate }}
                </button>
              }
            </div>
          </section>
        }

        <section class="rounded-xl p-6" [ngClass]="cardClass(isDarkMode$ | async)">
          <h2 class="mb-2 text-lg font-semibold">{{ 'backupPage.safety.title' | translate }}</h2>
          <p class="mb-4 leading-7">{{ 'backupPage.safety.description' | translate }}</p>
          <button type="button" class="underline" (click)="openFolder()">{{ 'backupPage.safety.openFolder' | translate }}</button>
        </section>
      </main>
  `,
})
export class BackupPageComponent {
  private readonly bridge = getDesktopBridge()?.backup;
  private readonly language = inject(LanguageService);
  protected readonly dateFormat = DATE_FORMAT;
  protected readonly isDarkMode$ = inject(ThemeService).isDarkMode$;
  protected readonly direction = computed(() => (this.language.selectedLanguage() === 'ar' ? 'rtl' : 'ltr'));
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

  protected cardClass(dark: boolean | null): string {
    return dark ? 'bg-gray_dark text-white' : 'bg-white shadow';
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
