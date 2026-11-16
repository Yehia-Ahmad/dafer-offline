import { Injectable, computed, inject, signal } from '@angular/core';
import { ApiError, ApiService } from './api.service';
import { Category, StoreSettings } from './models';
import { PageStatus } from './page-status.service';

export const DEFAULT_BRAND = '#0E4D45';
const HEX = /^#[0-9a-fA-F]{6}$/;

/** The public settings, loaded once per render by the app initializer (so every page knows if the shop is closed). */
@Injectable({ providedIn: 'root' })
export class SettingsStore {
  private readonly api = inject(ApiService);
  private readonly status = inject(PageStatus);

  readonly settings = signal<StoreSettings | null>(null);
  readonly categories = signal<Category[]>([]);
  /** The API did not answer: the shell shows the "temporary problem" page with status 503. */
  readonly down = signal(false);

  readonly closed = computed(() => this.settings()?.enabled === false);
  readonly orderingOn = computed(() => !this.closed() && this.settings()?.orderingEnabled !== false);
  readonly brand = computed(() => {
    const color = this.settings()?.brandColor;
    return color && HEX.test(color) ? color : DEFAULT_BRAND;
  });
  readonly shopName = computed(() => this.settings()?.shop?.name || this.settings()?.title || '');
  readonly whatsapp = computed(() => this.settings()?.contact?.whatsapp || this.settings()?.shop?.phones?.[0] || '');

  async load(): Promise<void> {
    try {
      const settings = await this.api.settings();
      this.settings.set(settings);
      this.down.set(false);
      if (settings.enabled === false) {
        this.status.closed();
        return;
      }
      try { this.categories.set((await this.api.categories()).data); } catch { this.categories.set([]); }
    } catch (error) {
      this.down.set(true);
      this.status.unavailable();
      if (!(error instanceof ApiError)) throw error;
    }
  }
}
