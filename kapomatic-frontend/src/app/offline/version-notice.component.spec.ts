import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { environment } from '../../environments/environment';
import { DesktopRuntimeConfig, loadDesktopRuntimeConfig } from '../core/runtime/runtime-config';
import { VersionNoticeComponent } from './version-notice.component';

describe('VersionNoticeComponent', () => {
  let originalApiBaseUrl: string;

  beforeEach(() => {
    originalApiBaseUrl = environment.api_base_url;
    TestBed.configureTestingModule({
      imports: [VersionNoticeComponent],
      providers: [provideZonelessChangeDetection()],
    });
  });

  afterEach(() => {
    environment.api_base_url = originalApiBaseUrl;
  });

  async function render(config: Partial<DesktopRuntimeConfig>): Promise<string> {
    await loadDesktopRuntimeConfig({
      getRuntimeConfig: async () =>
        ({ apiBaseUrl: 'http://127.0.0.1:5055/api/', role: 'client', ...config }) as DesktopRuntimeConfig,
    });
    const fixture = TestBed.createComponent(VersionNoticeComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    return (fixture.nativeElement as HTMLElement).textContent ?? '';
  }

  it('shows the version and no warning when both PCs match', async () => {
    const text = await render({ appVersion: '1.0.0', serverVersion: '1.0.0' });
    expect(text).toContain('v1.0.0');
    expect(text).not.toContain('يختلف');
  });

  it('warns when the main PC runs another version', async () => {
    const text = await render({ appVersion: '1.0.0', serverVersion: '1.1.0' });
    expect(text).toContain('(1.0.0)');
    expect(text).toContain('(1.1.0)');
    expect(text).toContain('يختلف');
  });

  it('does not warn when the main PC version is unknown', async () => {
    const text = await render({ appVersion: '1.0.0', serverVersion: null });
    expect(text).not.toContain('يختلف');
  });
});
