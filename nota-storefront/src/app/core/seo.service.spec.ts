import { DOCUMENT } from '@angular/common';
import { TestBed } from '@angular/core/testing';
import { Product, StoreSettings } from './models';
import { SeoService, productJsonLd, trimText } from './seo.service';
import { SettingsStore } from './settings.store';

const settings: StoreSettings = {
  enabled: true, shop: { name: 'النور' }, title: 'النور للأدوات الكهربائية', seoDescription: 'متجر أدوات كهربائية', logoUrl: '/api/store/images/logo?v=1',
};
const product: Product = {
  id: 'a'.repeat(24), name: 'لمبة ليد ١٨ وات', slug: 'لمبة-ليد-١٨-وات', code: 'L1', category: { id: 'c'.repeat(24), name: 'لمبات' }, price: 100, discountPercentage: 20, finalPrice: 80,
  description: 'لمبة موفرة بتنوّر زي لمبة ١٠٠ وات', images: ['/api/store/images/product/x/0?v=1', '/api/store/images/product/x/1?v=1'], availability: 'low', maxOrderQty: 4, remaining: 4,
};

describe('SeoService', () => {
  let seo: SeoService;
  let doc: Document;
  const meta = (selector: string): string | null => doc.head.querySelector(selector)?.getAttribute('content') ?? null;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    TestBed.inject(SettingsStore).settings.set(settings);
    seo = TestBed.inject(SeoService);
    doc = TestBed.inject(DOCUMENT);
    spyOn(seo, 'origin').and.returnValue('https://shop.example.com');
  });

  it('home: title, description (the shop\'s seoDescription), canonical, Open Graph with the logo', () => {
    seo.set({ title: 'النور للأدوات الكهربائية', path: '/' });
    expect(doc.title).toBe('النور للأدوات الكهربائية');
    expect(meta('meta[name="description"]')).toBe('متجر أدوات كهربائية');
    expect(doc.head.querySelector('link[rel="canonical"]')?.getAttribute('href')).toBe('https://shop.example.com/');
    expect(meta('meta[property="og:title"]')).toBe('النور للأدوات الكهربائية');
    expect(meta('meta[property="og:image"]')).toBe('https://shop.example.com/api/store/images/logo?v=1');
    expect(meta('meta[property="og:type"]')).toBe('website');
    expect(meta('meta[name="robots"]')).toBe('index, follow');
    expect(doc.head.querySelector('script[data-nota-jsonld]')).toBeNull();
  });

  it('product: title with the shop, the product description, the product image, canonical with id and slug, and JSON-LD Product', () => {
    seo.set({ title: product.name, description: `${product.name}. ${product.description}`, path: `/p/${product.id}/${encodeURIComponent(product.slug)}`, image: product.images[0], type: 'product', jsonLd: productJsonLd(product, 'https://shop.example.com') });
    expect(doc.title).toBe('لمبة ليد ١٨ وات | النور');
    expect(meta('meta[name="description"]')).toContain('لمبة موفرة');
    expect(meta('meta[property="og:image"]')).toBe('https://shop.example.com/api/store/images/product/x/0?v=1');
    expect(meta('meta[property="og:type"]')).toBe('product');
    expect(doc.head.querySelector('link[rel="canonical"]')?.getAttribute('href')).toBe(`https://shop.example.com/p/${product.id}/${encodeURIComponent(product.slug)}`);
    const ld = JSON.parse(doc.head.querySelector('script[data-nota-jsonld]')!.textContent!);
    expect(ld['@type']).toBe('Product');
    expect(ld.name).toBe(product.name);
    expect(ld.sku).toBe('L1');
    expect(ld.image.length).toBe(2);
    expect(ld.offers).toEqual(jasmine.objectContaining({ priceCurrency: 'EGP', price: 80, availability: 'https://schema.org/LimitedAvailability' }));
  });

  it('a second page replaces the first one\'s tags and JSON-LD (no duplicates)', () => {
    seo.set({ title: 'أ', path: '/a', jsonLd: { a: 1 } });
    seo.set({ title: 'ب', path: '/b', jsonLd: { b: 1 } });
    expect(doc.head.querySelectorAll('script[data-nota-jsonld]').length).toBe(1);
    expect(doc.head.querySelectorAll('link[rel="canonical"]').length).toBe(1);
    expect(doc.head.querySelectorAll('meta[property="og:title"]').length).toBe(1);
  });

  it('noindex pages get a robots tag and no canonical', () => {
    seo.set({ title: 'السلة', path: '/cart', noindex: true });
    expect(meta('meta[name="robots"]')).toBe('noindex, nofollow');
    expect(doc.head.querySelector('link[rel="canonical"]')).toBeNull();
  });

  it('JSON-LD is safe inside a script tag', () => {
    seo.set({ title: 'x', path: '/', jsonLd: { name: '</script><script>alert(1)</script>' } });
    expect(doc.head.querySelector('script[data-nota-jsonld]')!.textContent).not.toContain('</script>');
  });

  it('availability maps in_stock / out_of_stock and trimText shortens long text', () => {
    expect((productJsonLd({ ...product, availability: 'in_stock' }, 'https://x') as { offers: { availability: string } }).offers.availability).toBe('https://schema.org/InStock');
    expect((productJsonLd({ ...product, availability: 'out_of_stock' }, 'https://x') as { offers: { availability: string } }).offers.availability).toBe('https://schema.org/OutOfStock');
    expect(trimText('a'.repeat(300), 160).length).toBe(160);
    expect(trimText('  a   b  ')).toBe('a b');
  });
});
