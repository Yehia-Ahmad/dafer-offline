// The shop's own details (GET/PUT /api/shop-profile), printed on invoices.
/** Stage 21: the shop's VAT settings. Absent from the response until they were ever saved (= off, 14%, prices include VAT). */
export interface VatSettings {
  enabled: boolean;
  /** 0-100, 2 decimals. */
  rate: number;
  /** Shelf prices already include VAT (the normal retail case). */
  pricesIncludeVat: boolean;
  /** Set when VAT is turned on: documents dated before it are untouched. */
  startDate?: string | null;
}

export const DEFAULT_VAT: VatSettings = { enabled: false, rate: 14, pricesIncludeVat: true, startDate: null };

/** Stage 22: the period-closing settings (owner). Absent from the response until they were ever saved (= monthly, fiscal year from January). */
export interface ClosingSettings {
  frequency: 'monthly' | 'yearly';
  /** 1-12: the month the fiscal year starts in. */
  fiscalYearStartMonth: number;
}

export const DEFAULT_CLOSING: ClosingSettings = { frequency: 'monthly', fiscalYearStartMonth: 1 };

export interface ShopProfile {
  name: string;
  /** Stage 24: the English name from the license (absent when the license has none). */
  nameEn?: string;
  /** Stage 24: the shop name comes from the license and cannot be edited (the server refuses a different one). */
  nameLocked?: boolean;
  address: string;
  phones: string[];
  logo: string | null;
  taxNumber: string;
  commercialRegister: string;
  invoiceFooter: string;
  /** Stage 15: lock the screen after this many idle minutes (0 = off). Absent on older servers. */
  autoLockMinutes?: number;
  /** Stage 21 (absent until VAT settings were saved). */
  vat?: VatSettings;
  /** Stage 22 (absent until the closing settings were saved). */
  closing?: ClosingSettings;
}

/** The PUT body: the `vat` block is only sent once VAT is in use or the card was touched, so a shop without VAT sends what it always sent. */
export type ShopProfilePayload = Omit<ShopProfile, 'vat' | 'nameLocked'> & { vat?: Pick<VatSettings, 'enabled' | 'rate' | 'pricesIncludeVat'> };

export const SHOP_PROFILE_LIMITS = {
  name: 150,
  address: 500,
  phones: 3,
  phone: 30,
  taxNumber: 50,
  commercialRegister: 50,
  invoiceFooter: 500,
  logoBytes: 500 * 1024,
} as const;
