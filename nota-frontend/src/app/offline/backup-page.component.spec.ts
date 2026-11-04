import { CUSTOM_ELEMENTS_SCHEMA, provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router, UrlTree } from '@angular/router';
import { provideTranslateService } from '@ngx-translate/core';
import { environment } from '../../environments/environment';
import { mainPcGuard } from '../core/guards/main-pc.guard';
import {
  BackupStatus,
  DesktopBackupBridge,
  DesktopRuntimeConfig,
  loadDesktopRuntimeConfig,
} from '../core/runtime/runtime-config';
import { SideNavComponent } from '../modules/layout/components/side-nav/side-nav.component';
import { BackupPageComponent } from './backup-page.component';

const baseStatus: BackupStatus = {
  lastBackup: null,
  lastAuto: null,
  autoCount: 0,
  keep: 14,
  autoDir: 'C:\\ProgramData\\Nota\\backups\\auto',
  autoError: null,
  dataDrive: 'C:',
  copyFolder: null,
  copyFolderSameDrive: false,
  lastCopy: null,
  lastExternal: null,
  externalMaxAgeDays: 7,
  externalOverdue: true,
};

describe('BackupPageComponent', () => {
  let backup: jasmine.SpyObj<DesktopBackupBridge>;
  let fixture: ComponentFixture<BackupPageComponent>;
  let pushStatus: (status: BackupStatus) => void;
  const original = window.notaDesktop;
  const find = (selector: string) => (fixture.nativeElement as HTMLElement).querySelector(selector);

  const text = () => (fixture.nativeElement as HTMLElement).textContent ?? '';
  const button = (key: string) =>
    Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('button')).find((b) => b.textContent?.includes(key))!;
  const settle = async () => {
    await fixture.whenStable();
    fixture.detectChanges();
    await fixture.whenStable();
  };

  beforeEach(async () => {
    backup = jasmine.createSpyObj('backup', [
      'create',
      'restore',
      'showFile',
      'openFolder',
      'onProgress',
      'status',
      'onStatus',
      'chooseCopyFolder',
      'clearCopyFolder',
    ]);
    backup.onProgress.and.returnValue(() => undefined);
    backup.status.and.resolveTo({ ok: true, value: baseStatus });
    backup.onStatus.and.callFake((callback) => {
      pushStatus = callback;
      return () => undefined;
    });
    window.notaDesktop = { getRuntimeConfig: async () => ({}) as DesktopRuntimeConfig, backup };

    await TestBed.configureTestingModule({
      imports: [BackupPageComponent],
      providers: [provideZonelessChangeDetection(), provideTranslateService()],
    })
      // The real side navigation needs the whole app; a placeholder element is enough here.
      .overrideComponent(BackupPageComponent, { remove: { imports: [SideNavComponent] }, add: { schemas: [CUSTOM_ELEMENTS_SCHEMA] } })
      .compileComponents();
    fixture = TestBed.createComponent(BackupPageComponent);
    fixture.detectChanges();
    await fixture.whenStable();
  });

  afterEach(() => {
    window.notaDesktop = original;
  });

  it('shows the saved file after a backup', async () => {
    backup.create.and.resolveTo({ ok: true, value: { path: 'C:\\Users\\shop\\Documents\\nota-backup.archive.gz', sizeMb: 1.2, collections: 9, documents: 120 } });
    button('backupPage.create.button').click();
    await settle();
    expect(backup.create).toHaveBeenCalled();
    expect(text()).toContain('nota-backup.archive.gz');
    button('backupPage.showFile').click();
    expect(backup.showFile).toHaveBeenCalledWith('C:\\Users\\shop\\Documents\\nota-backup.archive.gz');
  });

  it('shows the Arabic error from the desktop app', async () => {
    backup.restore.and.resolveTo({ ok: false, error: { message: 'فشلت استعادة النسخة الاحتياطية، وتمت إعادة البيانات السابقة كما كانت.', detail: 'tail' } });
    button('backupPage.restore.button').click();
    await settle();
    expect(text()).toContain('وتمت إعادة البيانات السابقة');
  });

  it('shows nothing when the dialog was cancelled', async () => {
    backup.restore.and.resolveTo({ ok: true, value: null });
    button('backupPage.restore.button').click();
    await settle();
    expect(fixture.nativeElement.querySelector('[role="alert"]')).toBeNull();
  });

  it('shows where the pre-restore copy was saved', async () => {
    backup.restore.and.resolveTo({ ok: true, value: { restored: 10, collections: 2, safetyPath: 'C:\\ProgramData\\Nota\\backups\\before-restore-x.archive.gz' } });
    button('backupPage.restore.button').click();
    await settle();
    expect(text()).toContain('before-restore-x.archive.gz');
  });

  it('warns gently when nothing was saved outside this PC, and not once something was', async () => {
    await settle();
    expect(find('[data-test="backup-status"]')?.textContent).toContain('backupPage.status.none');
    expect(find('[data-test="external-warning"]')?.textContent).toContain('backupPage.warning.never');

    const at = new Date(2026, 10, 2, 0, 5).toISOString();
    pushStatus({
      ...baseStatus,
      lastBackup: { at, path: 'auto.archive.gz', kind: 'auto' },
      lastExternal: { at, path: 'E:\\auto.archive.gz', kind: 'copy-folder' },
      externalOverdue: false,
    });
    await settle();
    expect(find('[data-test="backup-status"]')?.textContent).toContain('backupPage.status.kind.auto');
    expect(find('[data-test="external-warning"]')).toBeNull();
  });

  it('picks the extra folder and shows when it is not available', async () => {
    backup.chooseCopyFolder.and.resolveTo({
      ok: true,
      value: {
        ...baseStatus,
        copyFolder: 'E:\\Nota',
        lastCopy: { at: new Date().toISOString(), folder: 'E:\\Nota', name: 'x', status: 'unavailable' },
      },
    });
    await settle();
    button('backupPage.copy.choose').click();
    await settle();
    expect(backup.chooseCopyFolder).toHaveBeenCalled();
    expect(find('[data-test="copy-folder"]')?.textContent).toContain('E:\\Nota');
    expect(find('[data-test="copy-folder"]')?.textContent).toContain('backupPage.copy.unavailable');

    backup.clearCopyFolder.and.resolveTo({ ok: true, value: baseStatus });
    button('backupPage.copy.clear').click();
    await settle();
    expect(find('[data-test="copy-folder"]')?.textContent).toContain('backupPage.copy.none');
  });

  it('flags an extra folder and a manual backup on the data drive', async () => {
    pushStatus({ ...baseStatus, copyFolder: 'C:\\Backups', copyFolderSameDrive: true });
    await settle();
    expect(find('[data-test="copy-same-drive"]')?.textContent).toContain('backupPage.copy.sameDrive');

    backup.create.and.resolveTo({ ok: true, value: { path: 'C:\\Users\\shop\\Documents\\b.archive.gz', sizeMb: 1, collections: 1, documents: 1, sameDrive: true } });
    button('backupPage.create.button').click();
    await settle();
    expect(find('[data-test="same-drive-backup"]')).not.toBeNull();
  });

  it('says nothing about the drive for a backup on another drive', async () => {
    backup.create.and.resolveTo({ ok: true, value: { path: 'E:\\b.archive.gz', sizeMb: 1, collections: 1, documents: 1, sameDrive: false } });
    button('backupPage.create.button').click();
    await settle();
    expect(text()).toContain('E:\\b.archive.gz');
    expect(find('[data-test="same-drive-backup"]')).toBeNull();
    expect(find('[data-test="copy-same-drive"]')).toBeNull();
  });

  it('refreshes the status after a manual backup', async () => {
    backup.create.and.resolveTo({ ok: true, value: { path: 'D:\\b.archive.gz', sizeMb: 1, collections: 1, documents: 1 } });
    backup.status.calls.reset();
    button('backupPage.create.button').click();
    await settle();
    expect(backup.status).toHaveBeenCalled();
  });
});

describe('mainPcGuard', () => {
  let originalOffline: boolean;
  let originalApi: string;

  beforeEach(() => {
    originalOffline = environment.offline;
    originalApi = environment.api_base_url;
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection(), provideRouter([])] });
  });

  afterEach(() => {
    environment.offline = originalOffline;
    environment.api_base_url = originalApi;
  });

  const run = () => TestBed.runInInjectionContext(() => mainPcGuard({} as never, []));
  const loadRole = (role: 'main' | 'client') =>
    loadDesktopRuntimeConfig({ getRuntimeConfig: async () => ({ apiBaseUrl: 'http://127.0.0.1:5055/api/', role }) as DesktopRuntimeConfig });

  it('sends the online edition home', () => {
    environment.offline = false;
    const result = run();
    expect(result instanceof UrlTree).toBeTrue();
    expect(TestBed.inject(Router).serializeUrl(result as UrlTree)).toBe('/home');
  });

  it('sends a client PC home', async () => {
    environment.offline = true;
    await loadRole('client');
    expect(run() instanceof UrlTree).toBeTrue();
  });

  it('lets the main PC in', async () => {
    environment.offline = true;
    await loadRole('main');
    expect(run()).toBeTrue();
  });
});
