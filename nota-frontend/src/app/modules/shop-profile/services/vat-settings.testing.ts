import { Provider, computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { VatSettingsLike, vatContextFor } from '../../shared/vat/vat-math';
import { VatSettingsService } from './vat-settings.service';

/** Specs: a VatSettingsService whose settings the test sets directly (no shop-profile request). */
export class FakeVatSettings {
  readonly settings = signal<VatSettingsLike | null>(null);
  readonly enabled = computed(() => Boolean(this.settings()?.enabled));
  contextFor(date: string) {
    return vatContextFor(this.settings(), date);
  }
}

export const provideFakeVat = (): Provider => ({ provide: VatSettingsService, useClass: FakeVatSettings });

/** The fake injected into the current TestBed. */
export const fakeVat = (): FakeVatSettings => TestBed.inject(VatSettingsService) as unknown as FakeVatSettings;

export const VAT_14_INCLUDED: VatSettingsLike = { enabled: true, rate: 14, pricesIncludeVat: true, startDate: '2026-11-01' };
export const VAT_14_EXCLUDED: VatSettingsLike = { enabled: true, rate: 14, pricesIncludeVat: false, startDate: '2026-11-01' };
