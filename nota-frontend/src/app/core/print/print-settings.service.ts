import { Injectable, inject, signal } from '@angular/core';
import { AuthService } from '../auth/auth.service';
import { DesktopPrintSettings, DesktopPrinter, getDesktopBridge } from '../runtime/runtime-config';

/** Stage 23: this PC's print settings, kept by the desktop app (print-settings.json). Outside the desktop app there are none. */
@Injectable({ providedIn: 'root' })
export class PrintSettingsService {
  private readonly auth = inject(AuthService);

  /** The last settings read or saved; null until loaded (or outside the desktop app). */
  readonly settings = signal<DesktopPrintSettings | null>(null);

  /** True inside the desktop app: only there are printers listed and the settings stored. */
  get supported(): boolean {
    return Boolean(getDesktopBridge()?.print);
  }

  async load(): Promise<DesktopPrintSettings | null> {
    const bridge = getDesktopBridge()?.print;
    if (!bridge) return null;
    const result = await bridge.getSettings(this.auth.token());
    if (!result.ok || !result.value) return this.settings();
    this.settings.set(result.value);
    return result.value;
  }

  async printers(): Promise<DesktopPrinter[]> {
    const bridge = getDesktopBridge()?.print;
    if (!bridge) return [];
    const result = await bridge.printers(this.auth.token());
    return result.ok && result.value ? result.value : [];
  }

  private static readonly PREFS_KEY = 'nota.devicePrefs';

  private localPrefs(): { scanSoundMuted?: boolean; labelOptions?: unknown } {
    try {
      const parsed = JSON.parse(localStorage.getItem(PrintSettingsService.PREFS_KEY) || '{}');
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  /** Stage 26: the scan sounds are muted on this device. */
  get scanSoundMuted(): boolean {
    const saved = this.settings();
    return saved ? saved.scanSoundMuted === true : this.localPrefs().scanSoundMuted === true;
  }

  /** The remembered label content options of this device (normalised by the caller), or undefined. */
  get savedLabelOptions(): unknown {
    return this.settings()?.labelOptions ?? this.localPrefs().labelOptions;
  }

  /**
   * Stage 26: per-device preferences any signed-in user may keep (scan sound mute, label content options). In the desktop
   * app they live in print-settings.json (print:prefs-set, whitelisted keys); in the dev browser in localStorage.
   * Never throws: a failed save only means the choice is not remembered.
   */
  async savePrefs(patch: Pick<Partial<DesktopPrintSettings>, 'scanSoundMuted' | 'labelOptions'>): Promise<void> {
    const bridge = getDesktopBridge()?.print;
    try {
      if (bridge) {
        const result = await bridge.setPrefs(this.auth.token(), patch);
        if (result.ok !== false && result.value) this.settings.set(result.value as DesktopPrintSettings);
        return;
      }
      localStorage.setItem(PrintSettingsService.PREFS_KEY, JSON.stringify({ ...this.localPrefs(), ...patch }));
    } catch {
      /* not remembered */
    }
  }

  /** Saves part of the settings; resolves the saved settings or an Arabic error message. */
  async save(patch: Partial<DesktopPrintSettings>): Promise<{ ok: true; settings: DesktopPrintSettings } | { ok: false; message: string }> {
    const bridge = getDesktopBridge()?.print;
    if (!bridge) return { ok: false, message: '' };
    const result = await bridge.setSettings(this.auth.token(), patch);
    if (result.ok === false) return { ok: false, message: result.error.message };
    this.settings.set(result.value as DesktopPrintSettings);
    return { ok: true, settings: result.value as DesktopPrintSettings };
  }
}
