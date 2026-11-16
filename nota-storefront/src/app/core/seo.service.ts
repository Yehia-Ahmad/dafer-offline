import { DOCUMENT } from '@angular/common';
import { Injectable, REQUEST, inject } from '@angular/core';
import { Meta, Title } from '@angular/platform-browser';
import { Product, StoreSettings } from './models';
import { SettingsStore } from './settings.store';

export interface SeoInput {
  title: string;
  description?: string;
  /** Path of this page, used for the canonical and og:url. */
  path: string;
  image?: string | null;
  type?: 'website' | 'product';
  noindex?: boolean;
  jsonLd?: object | null;
}

export const trimText = (text: string | undefined | null, max = 160): string => {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
};

const AVAILABILITY: Record<string, string> = {
  in_stock: 'https://schema.org/InStock',
  low: 'https://schema.org/LimitedAvailability',
  out_of_stock: 'https://schema.org/OutOfStock',
};

/** schema.org Product for a product page (price in EGP, availability mapped from the API). */
export const productJsonLd = (product: Product, origin: string): object => ({
  '@context': 'https://schema.org',
  '@type': 'Product',
  name: product.name,
  ...(product.images?.length ? { image: product.images.map((url) => abs(origin, url)) } : {}),
  ...(product.description ? { description: trimText(product.description, 300) } : {}),
  ...(product.code ? { sku: product.code } : {}),
  offers: {
    '@type': 'Offer',
    priceCurrency: 'EGP',
    price: product.finalPrice,
    availability: AVAILABILITY[product.availability] || AVAILABILITY['in_stock'],
    url: `${origin}/p/${product.id}/${encodeURIComponent(product.slug)}`,
  },
});

export const abs = (origin: string, url: string): string => (/^https?:\/\//.test(url) ? url : `${origin}${url.startsWith('/') ? '' : '/'}${url}`);

/** Per-page title, description, canonical, Open Graph and JSON-LD. Runs on the server too, so crawlers see it in the HTML. */
@Injectable({ providedIn: 'root' })
export class SeoService {
  private readonly title = inject(Title);
  private readonly meta = inject(Meta);
  private readonly doc = inject(DOCUMENT);
  private readonly settings = inject(SettingsStore);
  private readonly request = inject(REQUEST, { optional: true });

  /** NOTA_PUBLIC_URL (set by setup-server.sh) wins; otherwise the origin of the request / the browser. */
  origin(): string {
    const fromEnv = typeof process !== 'undefined' ? process.env['NOTA_PUBLIC_URL'] : undefined;
    if (fromEnv) return fromEnv.replace(/\/+$/, '');
    if (this.request) { try { return new URL(this.request.url).origin; } catch { /* fall through */ } }
    return this.doc.location?.origin || '';
  }

  set(input: SeoInput): void {
    const shop = this.settings.shopName();
    const settings: StoreSettings | null = this.settings.settings();
    const origin = this.origin();
    const fullTitle = shop && !input.title.includes(shop) ? `${input.title} | ${shop}` : input.title;
    const description = trimText(input.description || settings?.seoDescription || settings?.about || '');
    const url = `${origin}${input.path}`;
    const image = input.image ? abs(origin, input.image) : (settings?.logoUrl ? abs(origin, settings.logoUrl) : '');

    this.title.setTitle(fullTitle);
    const tag = (attr: 'name' | 'property', key: string, content: string): void => {
      if (content) this.meta.updateTag({ [attr]: key, content }, `${attr}='${key}'`);
      else this.meta.removeTag(`${attr}='${key}'`);
    };
    tag('name', 'description', description);
    tag('name', 'robots', input.noindex ? 'noindex, nofollow' : 'index, follow');
    tag('property', 'og:title', fullTitle);
    tag('property', 'og:description', description);
    tag('property', 'og:type', input.type === 'product' ? 'product' : 'website');
    tag('property', 'og:url', url);
    tag('property', 'og:image', image);
    tag('property', 'og:site_name', shop);
    tag('property', 'og:locale', 'ar_EG');
    tag('name', 'twitter:card', image ? 'summary_large_image' : 'summary');

    this.canonical(input.noindex ? null : url);
    this.jsonLd(input.jsonLd ?? null);
  }

  private canonical(url: string | null): void {
    const head = this.doc.head;
    let link = head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    if (!url) { link?.remove(); return; }
    if (!link) { link = this.doc.createElement('link'); link.setAttribute('rel', 'canonical'); head.appendChild(link); }
    link.setAttribute('href', url);
  }

  private jsonLd(data: object | null): void {
    const head = this.doc.head;
    head.querySelector('script[data-nota-jsonld]')?.remove();
    if (!data) return;
    const script = this.doc.createElement('script');
    script.setAttribute('type', 'application/ld+json');
    script.setAttribute('data-nota-jsonld', '');
    script.textContent = JSON.stringify(data).replace(/</g, '\\u003c');
    head.appendChild(script);
  }
}
