import { Injectable, computed, signal } from '@angular/core';

const pad = (value: number) => String(value).padStart(2, '0');
const parts = (key: string): [number, number, number] => {
  const [year, month, day] = key.split('-').map(Number);
  return [year, month, day];
};

/**
 * Stage 22: the last closed business day (YYYY-MM-DD) or null. Nothing may post on or before it (backend: 409 PERIOD_LOCKED).
 * It arrives with login, /auth/me and refresh (no extra request), and from a PERIOD_LOCKED error or the closing screen; the
 * posting forms read it to disable locked dates and to show "الفترة دي مقفولة لحد …". The backend enforces it; this only helps.
 */
@Injectable({ providedIn: 'root' })
export class LockDateService {
  readonly lockedThrough = signal<string | null>(null);

  /** The first open day (YYYY-MM-DD), for a native date input's `min`. */
  readonly minOpenKey = computed(() => {
    const locked = this.lockedThrough();
    if (!locked) return null;
    const [year, month, day] = parts(locked);
    const next = new Date(year, month - 1, day + 1);
    return `${next.getFullYear()}-${pad(next.getMonth() + 1)}-${pad(next.getDate())}`;
  });

  /** The first open day as a local Date, for PrimeNG's `minDate`. */
  readonly minOpenDate = computed(() => {
    const key = this.minOpenKey();
    if (!key) return null;
    const [year, month, day] = parts(key);
    return new Date(year, month - 1, day);
  });

  /** dd/mm/yyyy of the lock date. */
  readonly label = computed(() => {
    const locked = this.lockedThrough();
    if (!locked) return '';
    const [year, month, day] = parts(locked);
    return `${pad(day)}/${pad(month)}/${year}`;
  });

  set(value: string | null | undefined): void {
    this.lockedThrough.set(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null);
  }

  /** True when a picked day (YYYY-MM-DD, or a Date's local day) is on or before the lock date. */
  isLocked(value: string | Date | null | undefined): boolean {
    const locked = this.lockedThrough();
    if (!locked || !value) return false;
    const key = value instanceof Date ? `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}` : String(value).slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(key) && key <= locked;
  }
}
