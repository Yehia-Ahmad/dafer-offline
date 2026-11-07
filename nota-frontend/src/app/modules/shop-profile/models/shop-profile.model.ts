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

export interface ShopProfile {
  name: string;
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
}

/** The PUT body: the `vat` block is only sent once VAT is in use or the card was touched, so a shop without VAT sends what it always sent. */
export type ShopProfilePayload = Omit<ShopProfile, 'vat'> & { vat?: Pick<VatSettings, 'enabled' | 'rate' | 'pricesIncludeVat'> };

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
