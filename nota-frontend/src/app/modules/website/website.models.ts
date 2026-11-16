// Online Stage 3: the admin side of the customer website (GET/PUT /api/website/settings, /api/website/delivery-zones,
// PUT /api/website/products/:id and /api/website/categories/:id). All need website.manage.

export type BannerLinkType = 'none' | 'category' | 'product';

export interface WebsiteBanner {
  /** Server id of a saved banner (kept on save so its image is not re-sent). */
  id?: string;
  /** base64 data URI. */
  image: string;
  linkType: BannerLinkType;
  linkId?: string | null;
  sortOrder: number;
}

export interface WebsiteSettings {
  enabled: boolean;
  orderingEnabled: boolean;
  closedMessage: string;
  title: string;
  about: string;
  banners: WebsiteBanner[];
  featuredCategoryIds: string[];
  whatsapp: string;
  facebook: string;
  instagram: string;
  tiktok: string;
  minOrderAmount: number | null;
  freeDeliveryFrom: number | null;
  orderNote: string;
  returnsPolicy: string;
  terms: string;
}

/** The PUT body (what the page sends). Blank texts clear the value on the server. */
export type WebsiteSettingsPayload = Omit<WebsiteSettings, 'banners'> & {
  banners: Array<{ id?: string; image?: string; linkType: BannerLinkType; linkId?: string; sortOrder: number }>;
};

export interface DeliveryZone {
  id: string;
  name: string;
  fee: number;
  estimatedTime: string;
  isActive: boolean;
  sortOrder: number;
  /** An order used this zone: it can only be deactivated, not deleted. */
  used?: boolean;
}

export type DeliveryZonePayload = Pick<DeliveryZone, 'name' | 'fee' | 'estimatedTime' | 'isActive' | 'sortOrder'>;

/** The website fields of a product (Product.website). */
export interface ProductWebsite {
  visible: boolean;
  description?: string;
  images?: string[];
}

/** The website fields of a category (Category.website). */
export interface CategoryWebsite {
  visible: boolean;
  sortOrder?: number;
}

export const WEBSITE_LIMITS = {
  banners: 5,
  featured: 8,
  bannerBytes: 1024 * 1024,
  productImages: 4,
  imageBytes: 1024 * 1024,
  productDescription: 2000,
  closedMessage: 500,
  title: 150,
  about: 5000,
  orderNote: 1000,
  returnsPolicy: 5000,
  terms: 10000,
  zoneName: 120,
  zoneTime: 120,
} as const;

export const EMPTY_WEBSITE_SETTINGS: WebsiteSettings = {
  enabled: false,
  orderingEnabled: true,
  closedMessage: '',
  title: '',
  about: '',
  banners: [],
  featuredCategoryIds: [],
  whatsapp: '',
  facebook: '',
  instagram: '',
  tiktok: '',
  minOrderAmount: null,
  freeDeliveryFrom: null,
  orderNote: '',
  returnsPolicy: '',
  terms: '',
};
