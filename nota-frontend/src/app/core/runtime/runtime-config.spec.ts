import { environment } from '../../../environments/environment';
import {
  DesktopRuntimeConfig,
  NotaDesktopBridge,
  getDesktopRuntimeConfig,
  loadDesktopRuntimeConfig,
  normalizeApiBaseUrl,
} from './runtime-config';

const bridgeReturning = (config: Partial<DesktopRuntimeConfig>): NotaDesktopBridge => ({
  getRuntimeConfig: async () => config as DesktopRuntimeConfig,
});

describe('runtime-config', () => {
  let originalApiBaseUrl: string;

  beforeEach(() => {
    originalApiBaseUrl = environment.api_base_url;
  });

  afterEach(() => {
    environment.api_base_url = originalApiBaseUrl;
  });

  describe('normalizeApiBaseUrl', () => {
    it('adds the trailing slash the services rely on', () => {
      expect(normalizeApiBaseUrl('http://192.168.1.10:5055/api')).toBe('http://192.168.1.10:5055/api/');
    });

    it('keeps an existing trailing slash and trims spaces', () => {
      expect(normalizeApiBaseUrl('  http://127.0.0.1:5055/api/ ')).toBe('http://127.0.0.1:5055/api/');
    });

    it('rejects empty, relative and non-http values', () => {
      expect(() => normalizeApiBaseUrl('')).toThrowError(/apiBaseUrl/);
      expect(() => normalizeApiBaseUrl(undefined)).toThrowError(/apiBaseUrl/);
      expect(() => normalizeApiBaseUrl('/api/')).toThrow();
      expect(() => normalizeApiBaseUrl('file:///C:/api/')).toThrowError(/http or https/);
    });
  });

  describe('loadDesktopRuntimeConfig', () => {
    it('sets environment.api_base_url and exposes the config', async () => {
      const config = await loadDesktopRuntimeConfig(
        bridgeReturning({
          apiBaseUrl: 'http://192.168.1.10:5055/api',
          role: 'client',
          appVersion: '1.0.0',
          serverVersion: '1.0.1',
        })
      );

      expect(environment.api_base_url).toBe('http://192.168.1.10:5055/api/');
      expect(config).toEqual({
        apiBaseUrl: 'http://192.168.1.10:5055/api/',
        role: 'client',
        appVersion: '1.0.0',
        serverVersion: '1.0.1',
      });
      expect(getDesktopRuntimeConfig()).toBe(config);
      expect(Object.isFrozen(config)).toBeTrue();
    });

    it('defaults missing versions', async () => {
      const config = await loadDesktopRuntimeConfig(
        bridgeReturning({ apiBaseUrl: 'http://127.0.0.1:5055/api/', role: 'main' })
      );

      expect(config.appVersion).toBe('');
      expect(config.serverVersion).toBeNull();
    });

    it('fails without the desktop bridge', async () => {
      await expectAsync(loadDesktopRuntimeConfig(undefined)).toBeRejectedWithError(
        /Nota desktop app/
      );
    });

    it('fails on an unknown role without touching the API address', async () => {
      await expectAsync(
        loadDesktopRuntimeConfig(
          bridgeReturning({ apiBaseUrl: 'http://127.0.0.1:5055/api/', role: 'admin' as never })
        )
      ).toBeRejectedWithError(/role/);
      expect(environment.api_base_url).toBe(originalApiBaseUrl);
    });
  });
});
