// Online Stage 7A: the product catalog feed for Meta (Facebook/Instagram) Commerce Manager and TikTok Catalog Manager.
// Built from the PUBLIC API only, so it holds exactly what the website shows: website-visible products, availability as a word (never
// a stock number), the public image URLs. CSV: one file per platform because the id column is named differently (id / sku_id) and the
// product link carries a different utm_source.
import { ServerApi } from './api-client';

export type FeedPlatform = 'meta' | 'tiktok';

export const FEED_COLUMNS: Record<FeedPlatform, string[]> = {
  meta: ['id', 'title', 'description', 'availability', 'condition', 'price', 'sale_price', 'link', 'image_link', 'additional_image_link', 'brand', 'product_type'],
  tiktok: ['sku_id', 'title', 'description', 'availability', 'condition', 'price', 'sale_price', 'link', 'image_link', 'additional_image_link', 'brand', 'product_type'],
};

const SOURCE: Record<FeedPlatform, string> = { meta: 'facebook', tiktok: 'tiktok' };
const MAX_IMAGES = 10; // image_link + up to 9 additional
const MAX_PAGES = 200;

interface FeedProduct {
  id: string; name: string; slug: string; description?: string; price: number; finalPrice: number; discountPercentage?: number;
  availability: 'in_stock' | 'low' | 'out_of_stock'; images?: string[]; category?: { name?: string };
}

/** RFC 4180: a field with a comma, a quote or a line break is quoted, quotes are doubled. Line breaks are flattened first. */
export const csvField = (value: string): string => {
  const flat = value.replace(/[\r\n]+/g, ' ').trim();
  return /[",]/.test(flat) ? `"${flat.replace(/"/g, '""')}"` : flat;
};

const money = (value: number): string => `${(Math.round(value * 100) / 100).toFixed(2)} EGP`;
const absolute = (origin: string, url: string): string => (/^https?:\/\//i.test(url) ? url : `${origin}${url.startsWith('/') ? '' : '/'}${url}`);

/** The row of one product (null when it has no image: both platforms refuse an item without one). */
export const feedRow = (platform: FeedPlatform, product: FeedProduct, origin: string, brand: string): string[] | null => {
  const images = (product.images ?? []).slice(0, MAX_IMAGES).map((url) => absolute(origin, url));
  if (!images.length) return null;
  const link = `${origin}/p/${product.id}/${encodeURIComponent(product.slug)}?utm_source=${SOURCE[platform]}&utm_medium=catalog`;
  const sale = (product.discountPercentage ?? 0) > 0 && product.finalPrice < product.price;
  const title = product.name.trim().slice(0, 150);
  return [
    product.id,
    title,
    (product.description ?? '').trim().slice(0, 5000) || title,
    product.availability === 'out_of_stock' ? 'out of stock' : 'in stock', // "low" is still in stock; the count never leaves the server
    'new',
    money(product.price),
    sale ? money(product.finalPrice) : '',
    link,
    images[0],
    images.slice(1).join(','),
    brand,
    product.category?.name ?? '',
  ];
};

/** The whole CSV, or null while the website is closed. */
export const catalogFeed = async (platform: FeedPlatform, origin: string, api: ServerApi): Promise<string | null> => {
  const settings = await api.get<{ enabled?: boolean; shop?: { name?: string } }>('/settings', 30);
  if (settings.enabled === false) return null;
  const brand = settings.shop?.name?.trim() || 'Shop';
  const lines: string[] = [FEED_COLUMNS[platform].join(',')];
  let page = 1;
  let pages = 1;
  do {
    const result = await api.get<{ data: FeedProduct[]; pagination: { totalPages: number } }>(`/products?limit=48&page=${page}&sort=newest`, 60);
    for (const product of result.data) {
      const row = feedRow(platform, product, origin, brand);
      if (row) lines.push(row.map(csvField).join(','));
    }
    pages = result.pagination.totalPages;
    page += 1;
  } while (page <= pages && page <= MAX_PAGES);
  return `${lines.join('\r\n')}\r\n`;
};
