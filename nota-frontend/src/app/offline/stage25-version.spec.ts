import { provideZonelessChangeDetection, signal } from '@angular/core';
import { provideRouter } from '@angular/router';
import { TestBed } from '@angular/core/testing';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { AuthService } from '../core/auth/auth.service';
import { AboutCardComponent } from '../modules/shop-profile/components/about-card/about-card.component';
import { BackupStatus, WhatsNewEntry } from '../core/runtime/runtime-config';
import { BackupReminderComponent } from './backup-reminder.component';
import { WhatsNewDialogComponent } from './whats-new-dialog.component';

/** Stage 25: the About card and the once-per-version "what's new" window (the desktop bridge is faked). */
describe('Stage 25 version screens', () => {
  const ENTRY: WhatsNewEntry = { version: '1.1.0', date: '2026-12-01', ar: ['ميزة جديدة'], en: ['A new feature'] };
  const signedIn = signal(false);
  let permissions = new Set<string>();
  const authMock = { signedIn, has: (key: string) => permissions.has(key), token: () => 'session-token-123' };
  let seen = 0;
  let asked = 0;

  const fakeBridge = (entry: WhatsNewEntry | null) => {
    (window as unknown as { notaDesktop: unknown }).notaDesktop = {
      getRuntimeConfig: async () => ({}),
      about: async () => ({ productName: 'Nota', version: '1.1.0', build: '20261201.1000', builtAt: null, packaged: true }),
      whatsNew: {
        get: async () => { asked += 1; return entry; },
        current: async () => entry,
        seen: async () => { seen += 1; return true; },
      },
    };
  };

  const setup = async (lang: 'ar' | 'en') => {
    await TestBed.configureTestingModule({
      imports: [TranslateModule.forRoot(), AboutCardComponent, WhatsNewDialogComponent, BackupReminderComponent],
      providers: [provideZonelessChangeDetection(), provideRouter([]), { provide: AuthService, useValue: authMock }],
    }).compileComponents();
    const translate = TestBed.inject(TranslateService);
    translate.setTranslation('ar', { about: { title: 'عن البرنامج' }, diagnostics: { saved: 'تم الحفظ في {{path}}', failed: 'فشل' } });
    translate.setTranslation('en', { about: { title: 'About' }, diagnostics: { saved: 'saved to {{path}}', failed: 'failed' } });
    translate.use(lang);
  };

  beforeEach(() => { signedIn.set(false); seen = 0; asked = 0; permissions = new Set<string>(); });
  afterEach(() => { delete (window as unknown as { notaDesktop?: unknown }).notaDesktop; });

  it('the About card shows the version and the build number from the desktop app', async () => {
    fakeBridge(ENTRY);
    await setup('ar');
    const fixture = TestBed.createComponent(AboutCardComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-field="about-version"]')?.textContent?.trim()).toBe('1.1.0');
    expect(el.querySelector('[data-field="about-build"]')?.textContent?.trim()).toBe('20261201.1000');
  });

  it('the About card can show this version\'s notes in the chosen language', async () => {
    fakeBridge(ENTRY);
    await setup('en');
    const fixture = TestBed.createComponent(AboutCardComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('[data-action="about-whats-new"]')!.click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).querySelector('[data-test="about-notes"]')?.textContent).toContain('A new feature');
  });

  it('the what\'s-new window waits for sign-in AND shop.manage (it stays pending for a cashier), shows the list, and marks it seen when closed (once)', async () => {
    fakeBridge(ENTRY);
    await setup('ar');
    const fixture = TestBed.createComponent(WhatsNewDialogComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(asked).toBe(0);
    expect((fixture.nativeElement as HTMLElement).querySelector('[data-test="whats-new"]')).toBeNull();

    signedIn.set(true); // a cashier signs in: the desktop app is not even asked, so nothing is marked seen
    fixture.detectChanges();
    await fixture.whenStable();
    expect(asked).toBe(0);
    expect(seen).toBe(0);
    signedIn.set(false);
    fixture.detectChanges();
    permissions = new Set(['shop.manage']); // an owner or manager signs in on the same PC
    signedIn.set(true);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(asked).toBe(1);
    expect(el.querySelector('[data-test="whats-new-list"]')?.textContent).toContain('ميزة جديدة');

    el.querySelector<HTMLButtonElement>('[data-action="whats-new-close"]')!.click();
    fixture.detectChanges();
    expect(seen).toBe(1);
    expect(el.querySelector('[data-test="whats-new"]')).toBeNull();
  });

  it('nothing shows when the desktop app has nothing new for this version', async () => {
    fakeBridge(null);
    await setup('ar');
    permissions = new Set(['shop.manage']);
    signedIn.set(true);
    const fixture = TestBed.createComponent(WhatsNewDialogComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).querySelector('[data-test="whats-new"]')).toBeNull();
    expect(seen).toBe(0);
  });

  // ---------------------------------------------------------------- diagnostics button and backup reminder

  const bridgeWith = (extra: Record<string, unknown>) => {
    const current = (window as unknown as { notaDesktop: Record<string, unknown> }).notaDesktop ?? {};
    (window as unknown as { notaDesktop: unknown }).notaDesktop = { ...current, getRuntimeConfig: async () => ({}), ...extra };
  };
  const flush = async (fixture: { detectChanges(): void; whenStable(): Promise<unknown> }) => { fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges(); };

  it('the diagnostics button is only offered to an owner or manager (shop.manage) and sends the session token', async () => {
    const tokens: Array<string | null> = [];
    bridgeWith({
      about: async () => ({ productName: 'Nota', version: '1.0.0', build: 'dev', builtAt: null, packaged: false }),
      diagnostics: { export: async (token: string | null) => { tokens.push(token); return { ok: true, value: { path: 'C:/out/nota-diagnostics.zip', bytes: 100 } }; } },
    });
    await setup('en');
    let fixture = TestBed.createComponent(AboutCardComponent);
    await flush(fixture);
    expect((fixture.nativeElement as HTMLElement).querySelector('[data-action="export-diagnostics"]')).toBeNull();

    permissions = new Set(['shop.manage']);
    fixture = TestBed.createComponent(AboutCardComponent);
    await flush(fixture);
    const button = (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('[data-action="export-diagnostics"]')!;
    expect(button).not.toBeNull();
    button.click();
    await flush(fixture);
    expect(tokens).toEqual(['session-token-123']);
    expect((fixture.nativeElement as HTMLElement).querySelector('[data-test="diagnostics-status"]')?.textContent).toContain('nota-diagnostics.zip');
  });

  it('a refused export shows the message and not a success', async () => {
    permissions = new Set(['shop.manage']);
    bridgeWith({
      about: async () => ({ productName: 'Nota', version: '1.0.0', build: 'dev', builtAt: null, packaged: false }),
      diagnostics: { export: async () => ({ ok: false, error: { message: 'ليست لديك صلاحية', code: 'FORBIDDEN' } }) },
    });
    await setup('ar');
    const fixture = TestBed.createComponent(AboutCardComponent);
    await flush(fixture);
    (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('[data-action="export-diagnostics"]')!.click();
    await flush(fixture);
    const status = (fixture.nativeElement as HTMLElement).querySelector('[data-test="diagnostics-status"]');
    expect(status?.textContent).toContain('ليست لديك صلاحية');
    expect(status?.classList.contains('nota-error')).toBeTrue();
  });

  const status = (extra: Partial<BackupStatus>): BackupStatus => ({
    lastBackup: null, lastAuto: null, autoCount: 0, keep: 14, autoDir: 'C:/x', autoError: null, dataDrive: 'C:', copyFolder: null, copyFolderSameDrive: false,
    lastCopy: null, lastExternal: null, externalMaxAgeDays: 7, externalOverdue: true, ...extra,
  });

  it('the backup reminder shows only for someone who can back up, only when the desktop app says the last good backup is too old, and "back up now" asks for a backup', async () => {
    let created = 0;
    let current = status({ reminder: true, daysSinceGood: 5, lastGood: { at: '2026-11-09T10:00:00Z', kind: 'auto' } });
    bridgeWith({
      backup: {
        status: async () => ({ ok: true, value: current }),
        onStatus: () => () => undefined,
        create: async () => { created += 1; current = status({ reminder: false, daysSinceGood: 0 }); return { ok: true, value: { path: 'D:/b.archive.gz', sizeMb: 1, collections: 2, documents: 3 } }; },
      },
    });
    await setup('ar');
    signedIn.set(true);

    let fixture = TestBed.createComponent(BackupReminderComponent); // a cashier: no backup.manage
    await flush(fixture);
    expect((fixture.nativeElement as HTMLElement).querySelector('[data-test="backup-reminder"]')).toBeNull();

    permissions = new Set(['backup.manage']);
    fixture = TestBed.createComponent(BackupReminderComponent);
    await flush(fixture);
    const banner = (fixture.nativeElement as HTMLElement).querySelector('[data-test="backup-reminder"]');
    expect(banner).not.toBeNull();
    (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('[data-action="backup-now"]')!.click();
    await new Promise((resolve) => setTimeout(resolve, 30));
    await flush(fixture);
    expect(created).toBe(1);
    expect((fixture.nativeElement as HTMLElement).querySelector('[data-test="backup-reminder"]')).toBeNull();
  });

  it('no reminder when the desktop app reports a recent backup', async () => {
    permissions = new Set(['backup.manage']);
    bridgeWith({ backup: { status: async () => ({ ok: true, value: status({ reminder: false, daysSinceGood: 1 }) }), onStatus: () => () => undefined, create: async () => ({ ok: false, error: { message: 'x' } }) } });
    await setup('ar');
    signedIn.set(true);
    const fixture = TestBed.createComponent(BackupReminderComponent);
    await flush(fixture);
    expect((fixture.nativeElement as HTMLElement).querySelector('[data-test="backup-reminder"]')).toBeNull();
  });
});
