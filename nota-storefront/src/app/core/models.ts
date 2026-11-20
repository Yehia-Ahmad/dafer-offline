// The public API shapes (nota-backend/src/store/whitelist.js). Only fields the storefront reads.
export type Availability = 'in_stock' | 'low' | 'out_of_stock';
export type Fulfillment = 'delivery' | 'pickup';
export type PaymentMethod = 'cod' | 'instapay' | 'vodafone_cash';

export interface Banner { id: string; imageUrl: string; link: { type: string; id: string } | null }
export interface Highlight { icon: string; title: string; text: string }

export interface StoreSettings {
  enabled: boolean;
  closedMessage?: string;
  shop?: { name: string; logoUrl?: string | null; phones?: string[]; address?: string };
  orderingEnabled?: boolean;
  title?: string;
  about?: string;
  banners?: Banner[];
  featuredCategoryIds?: string[];
  contact?: { whatsapp?: string; facebook?: string; instagram?: string; tiktok?: string };
  minOrderAmount?: number | null;
  freeDeliveryFrom?: number | null;
  orderNote?: string;
  returnsPolicy?: string;
  terms?: string;
  paymentMethods?: PaymentMethod[];
  paymentDetails?: { instapay?: { address: string }; vodafoneCash?: { number: string } };
  fulfillment?: { delivery: boolean; pickup: boolean };
  brandColor?: string;
  logoUrl?: string | null;
  announcement?: { text: string } | null;
  seoDescription?: string;
  openingHours?: string;
  sameDayCutoff?: string | null;
  highlights?: Highlight[];
  vat?: { rate: number; pricesIncludeVat: boolean } | null;
  /** Online Stage 7A: pixel ids (public by nature), consent, attribution window and the "عرفتنا منين؟" options ([] = do not ask). */
  marketing?: { metaPixelId: string; tiktokPixelId: string; requireConsent: boolean; attributionDays: number; heardFromOptions: string[] };
}

export interface Category { id: string; name: string; imageUrl: string | null; image: string | null; productCount: number }

export interface Product {
  id: string;
  name: string;
  code?: string;
  slug: string;
  category: { id: string; name: string };
  price: number;
  discountPercentage: number;
  finalPrice: number;
  description?: string;
  images: string[];
  availability: Availability;
  maxOrderQty: number;
  specifications?: { label: string; value: string }[];
  badges?: string[];
  remaining?: number;
}

export interface Pagination { page: number; limit: number; totalItems: number; totalPages: number; hasNextPage: boolean; hasPrevPage: boolean }
export interface Page<T> { data: T[]; pagination: Pagination }
export interface Zone { id: string; name: string; fee: number; estimatedTime?: string }

export interface Address { id: string; label: string; zoneId: string | null; address: string; notes: string }
export interface Customer { id: string; name: string; phone: string; addresses: Address[] }

export interface OrderItem { productId: string; name: string; unitPrice: number; discountPercentage: number; qty: number; lineTotal: number; vat: number }
export interface OrderView {
  id?: string;
  number: string;
  status: string;
  paymentMethod: PaymentMethod;
  fulfillment: Fulfillment;
  paymentStatus: 'verified' | 'unpaid' | null;
  items?: OrderItem[];
  subtotal: number;
  vat: number;
  deliveryFee: number;
  total: number;
  zone?: { name: string; fee: number } | null;
  contact?: { name: string; phone: string; address: string; notes: string };
  statusHistory?: { status: string; at: string }[];
  createdAt: string;
  trackingToken?: string;
}

export interface Quote {
  fulfillment: Fulfillment;
  paymentMethod: PaymentMethod;
  items: OrderItem[];
  subtotal: number;
  vat: number;
  deliveryFee: number;
  total: number;
  zone: { name: string; fee: number } | null;
}

export interface LineProblem { productId: string; reason: 'not_available' | 'quantity_exceeds_stock'; max?: number }

export interface OrderRequest {
  items: { productId: string; qty: number }[];
  fulfillment: Fulfillment;
  paymentMethod: PaymentMethod;
  zoneId?: string | null;
  addressId?: string | null;
  contact?: { name: string; phone: string; address?: string; notes?: string };
  /** Online Stage 7A: the campaign code and when the visitor landed (the server checks both), and the "عرفتنا منين؟" answer. */
  attribution?: { code: string; landedAt: string };
  heardFrom?: string;
}
