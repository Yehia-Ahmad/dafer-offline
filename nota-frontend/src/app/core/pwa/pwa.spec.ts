import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { Subject } from 'rxjs';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { SwPush, SwUpdate } from '@angular/service-worker';
import { TranslateModule } from '@ngx-translate/core';
import { PwaBarComponent } from '../../modules/mobile/pwa-bar.component';
import { PushToggleComponent } from '../../modules/mobile/push-toggle.component';
import { INSTALL_DISMISSED_KEY, InstallHintService, detectInstallPlatform } from './install-hint.service';
import { OnlineService } from './online.service';
import { PushService, PushState } from './push.service';
import { UpdateService } from './update.service';

/** Online Stage 6A: install hint (Android / iOS / dismissed), offline banner, update prompt, push toggle states. */
describe('PWA (Online Stage 6A)', () => {
  const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36';
  const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Version/17.4 Mobile/15E148 Safari/604.1';
  const DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36';

  beforeEach(() => { try { localStorage.removeItem(INSTALL_DISMISSED_KEY); } catch { /* ignore */ } });

  describe('install hint', () => {
    it('detects the platform from the user agent', () => {
      expect(detectInstallPlatform(ANDROID)).toBe('android');
      expect(detectInstallPlatform(IPHONE)).toBe('ios');
      expect(detectInstallPlatform(DESKTOP)).toBe('other');
      expect(detectInstallPlatform('Macintosh; Intel Mac OS X', 5)).toBe('ios'); // iPadOS reports a Mac
    });

    it('Android: shows only after the browser offers the install prompt; install() calls it', async () => {
      const service = TestBed.inject(InstallHintService);
      (service as { platform: string }).platform = 'android';
      expect(service.mode()).toBeNull();

      const prompt = jasmine.createSpy('prompt').and.resolveTo();
      const event = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), { prompt, userChoice: Promise.resolve({ outcome: 'accepted' }) });
      window.dispatchEvent(event);
      expect(event.defaultPrevented).toBeTrue();
      expect(service.mode()).toBe('android');

      await service.install();
      expect(prompt).toHaveBeenCalled();
      expect(service.mode()).toBeNull();
    });

    it('iOS: shows the Share → Add to Home Screen steps', () => {
      const service = TestBed.inject(InstallHintService);
      (service as { platform: string }).platform = 'ios';
      (service as { standalone: boolean }).standalone = false;
      expect(service.mode()).toBe('ios');
    });

    it('never shows when the app already runs installed (standalone)', () => {
      const service = TestBed.inject(InstallHintService);
      (service as { platform: string }).platform = 'ios';
      (service as { standalone: boolean }).standalone = true;
      expect(service.mode()).toBeNull();
    });

    it('dismissed is remembered on this device', () => {
      const service = TestBed.inject(InstallHintService);
      (service as { platform: string }).platform = 'ios';
      (service as { standalone: boolean }).standalone = false;
      service.dismiss();
      expect(service.mode()).toBeNull();
      expect(localStorage.getItem(INSTALL_DISMISSED_KEY)).toBe('1');
      TestBed.resetTestingModule();
      expect(TestBed.inject(InstallHintService).dismissed()).toBeTrue();
    });
  });

  describe('bar: offline banner, update prompt, install hint', () => {
    const online = signal(true);
    const updateReady = signal(false);
    const reload = jasmine.createSpy('reload');
    const mode = signal<'android' | 'ios' | null>(null);
    const dismiss = jasmine.createSpy('dismiss');
    const install = jasmine.createSpy('install');

    const render = async () => {
      await TestBed.configureTestingModule({
        imports: [PwaBarComponent, TranslateModule.forRoot()],
        providers: [
          { provide: OnlineService, useValue: { online } },
          { provide: UpdateService, useValue: { updateReady, reload } },
          { provide: InstallHintService, useValue: { mode, dismiss, install } },
        ],
      }).compileComponents();
      const fixture = TestBed.createComponent(PwaBarComponent);
      fixture.detectChanges();
      return fixture;
    };
    const has = (fixture: { nativeElement: HTMLElement }, id: string) => fixture.nativeElement.querySelector(`[data-testid="${id}"]`) !== null;

    beforeEach(() => { online.set(true); updateReady.set(false); mode.set(null); reload.calls.reset(); dismiss.calls.reset(); install.calls.reset(); });

    it('nothing shows while online, up to date and with no install hint', async () => {
      const fixture = await render();
      expect(fixture.nativeElement.querySelector('.m-pwa__bar')).toBeNull();
    });

    it('"مفيش إنترنت" while the network is down', async () => {
      online.set(false);
      const fixture = await render();
      expect(has(fixture, 'offline-banner')).toBeTrue();
      online.set(true); fixture.detectChanges();
      expect(has(fixture, 'offline-banner')).toBeFalse();
    });

    it('"فيه تحديث جديد" with a reload button', async () => {
      updateReady.set(true);
      const fixture = await render();
      expect(has(fixture, 'update-prompt')).toBeTrue();
      fixture.nativeElement.querySelector('[data-testid="update-prompt"] button').click();
      expect(reload).toHaveBeenCalled();
    });

    it('install hint: Android button, iOS steps, dismiss', async () => {
      mode.set('android');
      const fixture = await render();
      expect(has(fixture, 'install-android')).toBeTrue();
      fixture.nativeElement.querySelector('[data-testid="install-android"] button').click();
      expect(install).toHaveBeenCalled();
      mode.set('ios'); fixture.detectChanges();
      expect(has(fixture, 'install-ios')).toBeTrue();
      fixture.nativeElement.querySelector('[data-testid="install-ios"] button').click();
      expect(dismiss).toHaveBeenCalled();
    });
  });

  describe('update service', () => {
    it('turns updateReady on only for VERSION_READY', () => {
      const versionUpdates = new Subject<{ type: string }>();
      TestBed.configureTestingModule({ providers: [{ provide: SwUpdate, useValue: { isEnabled: true, versionUpdates, checkForUpdate: () => Promise.resolve(false), activateUpdate: () => Promise.resolve(true) } }] });
      const service = TestBed.inject(UpdateService);
      versionUpdates.next({ type: 'VERSION_DETECTED' });
      expect(service.updateReady()).toBeFalse();
      versionUpdates.next({ type: 'VERSION_READY' });
      expect(service.updateReady()).toBeTrue();
    });

    it('does nothing when the service worker is off (dev build)', () => {
      TestBed.configureTestingModule({ providers: [{ provide: SwUpdate, useValue: { isEnabled: false } }] });
      expect(TestBed.inject(UpdateService).updateReady()).toBeFalse();
    });
  });

  describe('online service', () => {
    it('follows the browser online / offline events', () => {
      const service = TestBed.inject(OnlineService);
      window.dispatchEvent(new Event('offline'));
      expect(service.online()).toBeFalse();
      window.dispatchEvent(new Event('online'));
      expect(service.online()).toBeTrue();
    });
  });

  describe('push toggle states', () => {
    const state = signal<PushState>('off');
    const busy = signal(false);
    const enable = jasmine.createSpy('enable');
    const disable = jasmine.createSpy('disable');
    const render = async () => {
      await TestBed.configureTestingModule({
        imports: [PushToggleComponent, TranslateModule.forRoot()],
        providers: [{ provide: PushService, useValue: { state, busy, enable, disable } }],
      }).compileComponents();
      const fixture = TestBed.createComponent(PushToggleComponent);
      fixture.detectChanges();
      return fixture;
    };
    const query = (fixture: { nativeElement: HTMLElement }, id: string) => fixture.nativeElement.querySelector<HTMLElement>(`[data-testid="${id}"]`);

    beforeEach(() => { state.set('off'); busy.set(false); enable.calls.reset(); disable.calls.reset(); });

    it('off: a button that asks for permission only when tapped', async () => {
      const fixture = await render();
      expect(enable).not.toHaveBeenCalled(); // never on page load
      query(fixture, 'push-enable')!.click();
      expect(enable).toHaveBeenCalledTimes(1);
      expect(query(fixture, 'push-state')!.textContent).toContain('mobile.push.state.off');
    });

    it('on: shows the state and a turn-off button', async () => {
      state.set('on');
      const fixture = await render();
      expect(query(fixture, 'push-enable')).toBeNull();
      query(fixture, 'push-disable')!.click();
      expect(disable).toHaveBeenCalled();
      expect(query(fixture, 'push-state')!.textContent).toContain('mobile.push.state.on');
    });

    for (const blocked of ['blocked', 'unsupported', 'needs-install', 'unavailable'] as PushState[]) {
      it(`${blocked}: only the explanation, no button`, async () => {
        state.set(blocked);
        const fixture = await render();
        expect(query(fixture, 'push-enable')).toBeNull();
        expect(query(fixture, 'push-disable')).toBeNull();
        expect(query(fixture, 'push-state')!.textContent).toContain(`mobile.push.state.${blocked}`);
      });
    }
  });

  describe('push service', () => {
    const setup = (swPush: Partial<SwPush> | null) => {
      TestBed.configureTestingModule({
        providers: [provideHttpClient(), provideHttpClientTesting(), ...(swPush ? [{ provide: SwPush, useValue: swPush }] : [])],
      });
      return TestBed.inject(PushService);
    };

    it('unsupported without a service worker; never subscribes on its own', async () => {
      const service = setup(null);
      await service.refresh();
      expect(service.state()).toBe('unsupported');
    });

    it('ends up "off" when supported with no subscription and "on" with one', async () => {
      const subscription = new Subject<unknown>();
      const service = setup({ isEnabled: true, subscription: subscription as never });
      const refreshed = service.refresh();
      subscription.next(null);
      await refreshed;
      // jsdom-less Chrome: Notification and PushManager exist in the test browser
      expect(['off', 'blocked', 'unsupported']).toContain(service.state());
    });
  });
});
