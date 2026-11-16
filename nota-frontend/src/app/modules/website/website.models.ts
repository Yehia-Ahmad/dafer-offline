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

/** Online Stage 5A. The six brand presets (PLACEHOLDER values: the design file WebSettings.dc.html is not in the repository; keep in sync with BRAND_COLORS in nota-backend/src/models/websiteSettings.model.js). */
export const BRAND_COLORS: readonly string[] = ['#1F6FEB', '#0E9F6E', '#D97706', '#DC2626', '#7C3AED', '#0F172A'];
export const HIGHLIGHT_ICONS = ['delivery', 'cash', 'exchange', 'shield', 'clock', 'star'] as const;
export type HighlightIcon = (typeof HIGHLIGHT_ICONS)[number];
export interface WebsiteHighlight { icon: HighlightIcon; title: string; text: string; }

/** "marked": only what is marked "show" appears. "all": everything appears unless it is marked "hide". */
export type ProductVisibilityMode = 'marked' | 'all';
/** The choice on one product / category: unset (null) lets the website's mode decide. */
export type VisibilityChoice = 'show' | 'hide' | null;

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
  // Online Stage 5A
  fulfillment: { delivery: boolean; pickup: boolean };
  payments: {
    cod: { enabled: boolean };
    instapay: { enabled: boolean; address: string; boxId: string | null };
    vodafoneCash: { enabled: boolean; number: string; boxId: string | null };
  };
  stock: { showOutOfStock: boolean; showRemaining: { enabled: boolean; threshold: number } };
  productVisibility: ProductVisibilityMode;
  brandColor: string | null;
  /** base64 data URI (or null: the shop logo is used). */
  websiteLogo: string | null;
  announcement: { enabled: boolean; text: string };
  seoDescription: string;
  openingHours: string;
  /** "HH:mm" or ''. */
  sameDayCutoff: string;
  highlights: WebsiteHighlight[];
  whatsappConfirmTemplate: string;
}

/** The PUT body (what the page sends). Blank texts clear the value on the server. */
export type WebsiteSettingsPayload = Omit<WebsiteSettings, 'banners' | 'websiteLogo' | 'payments'> & {
  banners: Array<{ id?: string; image?: string; linkType: BannerLinkType; linkId?: string; sortOrder: number }>;
  /** Only when changed: a data URI sets it, '' removes it (the logo is never re-sent otherwise). */
  websiteLogo?: string;
  payments: {
    cod: { enabled: boolean };
    instapay: { enabled: boolean; address: string; boxId: string };
    vodafoneCash: { enabled: boolean; number: string; boxId: string };
  };
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
  /** Online Stage 5A: replaces the boolean `visible`. */
  visibility: VisibilityChoice;
  description?: string;
  images?: string[];
}

/** The website fields of a category (Category.website). */
export interface CategoryWebsite {
  visibility: VisibilityChoice;
  sortOrder?: number;
}

/**
 * Is a product / category on the website, for the website's mode? "marked": only "show". "all": unless "hide".
 * (The server decides for real; this only labels the admin screens.)
 */
export const isOnWebsite = (visibility: VisibilityChoice | undefined, mode: ProductVisibilityMode): boolean =>
  mode === 'all' ? visibility !== 'hide' : visibility === 'show';

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
  // Online Stage 5A
  announcement: 160,
  seoDescription: 300,
  openingHours: 500,
  highlightTitle: 60,
  highlightText: 160,
  highlights: 3,
  bannersRecommended: 3,
  whatsappTemplate: 1000,
  instapayAddress: 100,
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
  fulfillment: { delivery: true, pickup: false },
  payments: { cod: { enabled: true }, instapay: { enabled: false, address: '', boxId: null }, vodafoneCash: { enabled: false, number: '', boxId: null } },
  stock: { showOutOfStock: true, showRemaining: { enabled: true, threshold: 5 } },
  productVisibility: 'marked',
  brandColor: null,
  websiteLogo: null,
  announcement: { enabled: false, text: '' },
  seoDescription: '',
  openingHours: '',
  sameDayCutoff: '',
  highlights: [],
  whatsappConfirmTemplate: '',
};

/** The default message of the "send confirmation on WhatsApp" button (the server sends the same text when none is saved). */
export const DEFAULT_WHATSAPP_TEMPLATE = 'أهلاً {الاسم}، تم تأكيد طلبك رقم {رقم الطلب} بإجمالي {الإجمالي} جنيه. مدة التوصيل: {مدة التوصيل}. شكرًا لاختيارك لنا.';
