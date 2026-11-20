import { ServerApi } from './api-client';
import { FEED_COLUMNS, catalogFeed, csvField, feedRow } from './catalog-feed';

const product = (over: Record<string, unknown> = {}): any => ({
  id: 'a'.repeat(24), name: 'قميص "قطن", أزرق', slug: 'قميص', description: 'سطر 1\nسطر 2', price: 150, finalPrice: 150, discountPercentage: 0,
  availability: 'in_stock', images: ['/api/store/images/product/a/0?v=1', '/api/store/images/product/a/1?v=1'], category: { name: 'ملابس' }, ...over,
});
const apiFor = (settings: unknown, pages: unknown[]): ServerApi => new ServerApi({
  base: 'http://api.test',
  fetchImpl: (async (url: string) => {
    if (url.endsWith('/settings')) return new Response(JSON.stringify(settings));
    const page = Number(new URL(url).searchParams.get('page'));
    return new Response(JSON.stringify(pages[page - 1]));
  }) as typeof fetch,
});
const rows = (csv: string): string[] => csv.trim().split('\r\n');

describe('catalog feed', () => {
  it('quotes commas and quotes and flattens line breaks (RFC 4180)', () => {
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('x\ny\r\nz')).toBe('x y z');
    expect(csvField('plain')).toBe('plain');
  });

  it('Meta: its columns, in stock / out of stock only, EGP prices, sale price only on a discount, utm on the link, absolute images, brand = the shop', async () => {
    const api = apiFor({ enabled: true, shop: { name: 'متجر الهدى' } }, [{ data: [product(), product({ id: 'b'.repeat(24), discountPercentage: 20, finalPrice: 120, availability: 'out_of_stock', category: { name: 'x' } })], pagination: { totalPages: 1 } }]);
    const csv = (await catalogFeed('meta', 'https://shop.example', api))!;
    const lines = rows(csv);
    expect(lines[0]).toBe('id,title,description,availability,condition,price,sale_price,link,image_link,additional_image_link,brand,product_type');
    expect(lines.length).toBe(3);
    expect(lines[1]).toBe(`${'a'.repeat(24)},"قميص ""قطن"", أزرق",سطر 1 سطر 2,in stock,new,150.00 EGP,,https://shop.example/p/${'a'.repeat(24)}/${encodeURIComponent('قميص')}?utm_source=facebook&utm_medium=catalog,https://shop.example/api/store/images/product/a/0?v=1,https://shop.example/api/store/images/product/a/1?v=1,متجر الهدى,ملابس`);
    expect(lines[2]).toContain(',out of stock,new,150.00 EGP,120.00 EGP,');
  });

  it('TikTok: sku_id instead of id and utm_source=tiktok', async () => {
    const api = apiFor({ enabled: true, shop: { name: 'S' } }, [{ data: [product()], pagination: { totalPages: 1 } }]);
    const lines = rows((await catalogFeed('tiktok', 'https://shop.example', api))!);
    expect(lines[0].split(',')[0]).toBe('sku_id');
    expect(lines[0]).toBe(FEED_COLUMNS.tiktok.join(','));
    expect(lines[1]).toContain('utm_source=tiktok&utm_medium=catalog');
  });

  it('never exposes a stock number: "low" is in stock and no count column exists', () => {
    const row = feedRow('meta', product({ availability: 'low', remaining: 3, inventoryCount: 3 } as never), 'https://s', 'B')!;
    expect(row[3]).toBe('in stock');
    expect(row.join('|')).not.toMatch(/remaining|inventory/);
    expect(FEED_COLUMNS.meta.join(',')).not.toMatch(/quantity|inventory|stock_/);
  });

  it('skips a product without an image and follows every page of the API', async () => {
    const api = apiFor({ enabled: true, shop: { name: 'S' } }, [
      { data: [product({ images: [] })], pagination: { totalPages: 2 } },
      { data: [product({ id: 'c'.repeat(24) })], pagination: { totalPages: 2 } },
    ]);
    const lines = rows((await catalogFeed('meta', 'https://s', api))!);
    expect(lines.length).toBe(2);
    expect(lines[1].startsWith('c'.repeat(24))).toBeTrue();
  });

  it('a closed website has no feed', async () => {
    expect(await catalogFeed('meta', 'https://s', apiFor({ enabled: false }, []))).toBeNull();
  });
});
