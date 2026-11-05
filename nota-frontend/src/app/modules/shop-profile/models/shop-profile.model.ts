// The shop's own details (GET/PUT /api/shop-profile), printed on invoices.
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
}

export type ShopProfilePayload = ShopProfile;

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
