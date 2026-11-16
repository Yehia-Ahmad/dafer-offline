import { Injectable, signal } from '@angular/core';

/** Same rule as the backend (middlewares/device.middleware.js DEVICE_ID_PATTERN). */
export const DEVICE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{7,63}$/;
export const DEVICE_NAME_MAX = 64;

const ID_KEY = 'nota.deviceId';
const NAME_KEY = 'nota.deviceName';

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null; // blocked, private window, ...
  }
}

function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* the value then lives in memory for this page only */
  }
}

function randomDeviceId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `web-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Decision D (online edition): this browser is a "device". It gets a random id once (kept in localStorage) that the
 * HTTP layer sends as X-Nota-Device-Id, and a name the user gives it once (X-Nota-Device-Name). The backend uses them
 * only to pick the default cash box. If localStorage is unavailable or cleared, the browser is simply a new device
 * with no default cash box and the user picks the box. Not an authentication factor.
 */
@Injectable({ providedIn: 'root' })
export class DeviceService {
  readonly deviceId: string = this.loadId();
  /** The name of this device; '' until the user gives one. */
  readonly name = signal<string>((readStorage(NAME_KEY) ?? '').trim().slice(0, DEVICE_NAME_MAX));
  /** The name dialog (asked once after sign in, and from the sidebar to change it). */
  readonly dialogOpen = signal(false);
  /** The user closed the first-time question without a name: do not ask again until the page is reloaded. */
  readonly skipped = signal(false);

  setName(value: string): void {
    const name = value.trim().slice(0, DEVICE_NAME_MAX);
    this.name.set(name);
    writeStorage(NAME_KEY, name);
  }

  private loadId(): string {
    const stored = readStorage(ID_KEY);
    if (stored && DEVICE_ID_PATTERN.test(stored)) return stored;
    const created = randomDeviceId();
    writeStorage(ID_KEY, created);
    return created;
  }
}
