import { TestBed } from '@angular/core/testing';
import { TranslateModule } from '@ngx-translate/core';
import { PrintSettingsService } from '../print/print-settings.service';
import { ScanSoundToggleComponent } from './scan-sound-toggle.component';

describe('ScanSoundToggleComponent', () => {
  it('loads and flips the same per-device scanSoundMuted preference used by print settings', async () => {
    let muted = false;
    const settings = {
      get scanSoundMuted() { return muted; },
      load: jasmine.createSpy('load').and.resolveTo(null),
      savePrefs: jasmine.createSpy('savePrefs').and.callFake(async (patch: { scanSoundMuted?: boolean }) => { muted = patch.scanSoundMuted === true; }),
    };
    await TestBed.configureTestingModule({
      imports: [ScanSoundToggleComponent, TranslateModule.forRoot()],
      providers: [{ provide: PrintSettingsService, useValue: settings }],
    }).compileComponents();
    const fixture = TestBed.createComponent(ScanSoundToggleComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    const button = fixture.nativeElement.querySelector('[data-action="toggle-scan-sound"]') as HTMLButtonElement;
    expect(button.getAttribute('aria-pressed')).toBe('false');
    button.click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(settings.savePrefs).toHaveBeenCalledWith({ scanSoundMuted: true });
    expect(button.getAttribute('aria-pressed')).toBe('true');
  });
});
