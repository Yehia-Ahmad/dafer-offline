import { Provider, computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { VatSettingsLike, vatContextFor } from '../../shared/vat/vat-math';
import { VatSettingsService } from './vat-settings.service';

/** Specs: a VatSettingsService whose settings the test sets directly (no shop-profile request). */
export class FakeVatSettings {
  readonly settings = signal<VatSettingsLike | null>(null);
  readonly enabled = computed(() => Boolean(this.settings()?.enabled));
  /** Specs read these to see that a screen refreshed the settings / applied the server's block. */
  refreshCalls = 0;
  appliedVat: Array<VatSettingsLike | null | undefined> = [];
  refresh(): void { this.refreshCalls += 1; }
  applyServerVat(vat: VatSettingsLike | null | undefined): void { this.appliedVat.push(vat); if (vat) this.settings.set(vat); }
  contextFor(date: string) {
    return vatContextFor(this.settings(), date);
  }
}

export const provideFakeVat = (): Provider => ({ provide: VatSettingsService, useClass: FakeVatSettings });

/** The fake injected into the current TestBed. */
export const fakeVat = (): FakeVatSettings => TestBed.inject(VatSettingsService) as unknown as FakeVatSettings;

export const VAT_14_INCLUDED: VatSettingsLike = { enabled: true, rate: 14, pricesIncludeVat: true, startDate: '2026-11-01' };
export const VAT_14_EXCLUDED: VatSettingsLike = { enabled: true, rate: 14, pricesIncludeVat: false, startDate: '2026-11-01' };
