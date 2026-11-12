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
