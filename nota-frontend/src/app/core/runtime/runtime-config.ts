import { environment } from '../../../environments/environment';
import { BRAND } from '../brand';

/** What the offline desktop app hands to Angular before it starts. */
export interface DesktopRuntimeConfig {
  /** Backend API base URL, e.g. http://192.168.1.10:5055/api/ */
  apiBaseUrl: string;
  /** "main" runs the database and backend, "client" connects to a main PC. */
  role: 'main' | 'client';
  /** Version of this desktop app. */
  appVersion: string;
  /** Version reported by the main PC, when known. */
  serverVersion: string | null;
}

/** Whether the server is reachable, reported by the desktop app while Angular runs. */
export interface DesktopConnectionState {
  connected: boolean;
  /**
   * Why the server cannot be used: the main PC is off, the secret changed, it is restarting,
   * or it is paused for a few seconds for the daily backup.
   */
  reason?: 'unreachable' | 'unauthorized' | 'not-nota' | 'server-restarting' | 'server-maintenance';
  role?: 'main' | 'client' | null;
  /** host:port of the main PC (client PCs). */
  address?: string;
}

/** Result of a desktop action; value is null when the user cancelled a dialog. */
export type DesktopResult<T> =
  | { ok: true; value: T | null }
  | { ok: false; error: { message: string; code?: string; detail?: string } };

export interface BackupCreated {
  path: string;
  sizeMb: number;
  collections: number;
  documents: number;
  /** Saved on the drive of the program's data, so it does not count as a copy outside this PC. */
  sameDrive?: boolean;
}

export interface BackupRestored {
  restored: number;
  collections: number;
  /** The automatic copy of the data from before the restore. */
  safetyPath: string | null;
}

export interface BackupProgress {
  phase: 'backup' | 'safety-backup' | 'restoring' | 'rolling-back';
  done?: number;
  total?: number;
}

/** Backups as the backup page shows them. Dates are ISO strings. */
export interface BackupStatus {
  /** The newest backup, daily or manual. */
  lastBackup: { at: string; path: string; kind: 'auto' | 'manual' } | null;
  lastAuto: { at: string; path: string } | null;
  autoCount: number;
  /** How many daily backups are kept. */
  keep: number;
  autoDir: string;
  /** The last daily backup attempt failed. */
  autoError: { at: string; message: string } | null;
  /** Drive of the program's data, e.g. "C:". */
  dataDrive: string;
  /** Extra folder for a copy of each daily backup (USB drive, another disk). */
  copyFolder: string | null;
  /** The extra folder is on the data drive, so its copies do not count as outside this PC. */
  copyFolderSameDrive: boolean;
  lastCopy: { at: string; folder: string; name: string; status: 'copied' | 'unavailable' | 'failed'; message?: string } | null;
  /**
   * The last backup saved outside this PC, i.e. on another drive than the data: a manual backup
   * or a copy in the extra folder.
   */
  lastExternal: { at: string; path: string; kind: 'manual' | 'copy-folder' } | null;
  externalMaxAgeDays: number;
  externalOverdue: boolean;
}

export interface DesktopBackupBridge {
  create(): Promise<DesktopResult<BackupCreated>>;
  restore(): Promise<DesktopResult<BackupRestored>>;
  showFile(path: string): Promise<DesktopResult<boolean>>;
  openFolder(): Promise<DesktopResult<boolean>>;
  onProgress(callback: (progress: BackupProgress) => void): () => void;
  status(): Promise<DesktopResult<BackupStatus>>;
  onStatus(callback: (status: BackupStatus) => void): () => void;
  chooseCopyFolder(): Promise<DesktopResult<BackupStatus>>;
  clearCopyFolder(): Promise<DesktopResult<BackupStatus>>;
}

/** Exposed by the offline edition's Electron preload script. */
export interface NotaDesktopBridge {
  getRuntimeConfig(): Promise<DesktopRuntimeConfig>;
  getConnection?(): Promise<DesktopConnectionState>;
  onConnection?(callback: (state: DesktopConnectionState) => void): () => void;
  retryConnection?(): Promise<DesktopConnectionState>;
  changeServerAddress?(): Promise<void>;
  onNavigate?(callback: (url: string) => void): () => void;
  backup?: DesktopBackupBridge;
}

/** The desktop bridge, or undefined outside the offline desktop edition. */
export function getDesktopBridge(): NotaDesktopBridge | undefined {
  return typeof window === 'undefined' ? undefined : window.notaDesktop;
}

declare global {
  interface Window {
    notaDesktop?: NotaDesktopBridge;
  }
}

let runtimeConfig: Readonly<DesktopRuntimeConfig> | null = null;

/** The loaded config, or null outside the offline desktop edition. */
export function getDesktopRuntimeConfig(): Readonly<DesktopRuntimeConfig> | null {
  return runtimeConfig;
}

export function normalizeApiBaseUrl(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('Desktop runtime config has no apiBaseUrl.');
  }

  const url = new URL(value.trim());
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Desktop runtime config apiBaseUrl must be http or https: ${value}`);
  }

  // Every service appends paths such as "categories" directly, so a trailing slash is required.
  return url.href.endsWith('/') ? url.href : `${url.href}/`;
}

/**
 * Must run before bootstrapApplication: services read environment.api_base_url
 * when they are created.
 */
export async function loadDesktopRuntimeConfig(
  bridge: NotaDesktopBridge | undefined = window.notaDesktop
): Promise<Readonly<DesktopRuntimeConfig>> {
  if (!bridge || typeof bridge.getRuntimeConfig !== 'function') {
    throw new Error(`The offline edition must run inside the ${BRAND.nameEn} desktop app.`);
  }

  const config = await bridge.getRuntimeConfig();
  const role = config?.role === 'main' ? 'main' : config?.role === 'client' ? 'client' : null;
  if (!role) {
    throw new Error('Desktop runtime config has no valid role.');
  }

  const apiBaseUrl = normalizeApiBaseUrl(config.apiBaseUrl);
  environment.api_base_url = apiBaseUrl;

  runtimeConfig = Object.freeze({
    apiBaseUrl,
    role,
    appVersion: typeof config.appVersion === 'string' ? config.appVersion : '',
    serverVersion: typeof config.serverVersion === 'string' ? config.serverVersion : null,
  });
  return runtimeConfig;
}

/** Last-resort message if the offline build is opened without its desktop app. */
export function renderRuntimeConfigError(error: unknown): void {
  console.error(error);
  const message = document.createElement('div');
  message.dir = 'rtl';
  message.lang = 'ar';
  message.style.cssText =
    'font-family:sans-serif;max-width:32rem;margin:20vh auto;padding:1.5rem;text-align:center;line-height:1.8;';
  message.textContent =
    'تعذر تشغيل البرنامج: إعدادات الاتصال غير متوفرة. أغلق البرنامج وافتحه مرة أخرى.';
  document.body.replaceChildren(message);
}
