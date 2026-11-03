import { FormBuilder } from '@angular/forms';
import {
  buildSeoFormValue,
  buildSeoPreviewData,
  extractDuplicateSlugMatch,
  generateArabicSlug,
  generateEnglishSlug,
  generateSeoSuggestions,
  normalizeKeywords,
  normalizeSeoExtensionPayload
} from './seo.utils';

describe('SEO utilities', () => {
  const fb = new FormBuilder();

  it('generates Arabic slugs while preserving Arabic letters', () => {
    expect(generateArabicSlug(' قطع غيار فتيس / أوتوماتيك  ')).toBe('قطع-غيار-فتيس-أوتوماتيك');
  });

  it('generates English slugs safely', () => {
    expect(generateEnglishSlug(' Transmission Parts ++ Egypt ')).toBe('transmission-parts-egypt');
  });

  it('preserves manually entered slugs when generating SEO without overwrite', () => {
    const form = buildSeoFormValue(fb, 'category');
    form.controls.translations.controls.en.controls.name.setValue('Transmission Parts');
    form.controls.translations.controls.en.controls.slug.setValue('manual-slug');

    generateSeoSuggestions(form, { entityType: 'category', legacyName: 'Transmission Parts' }, false);

    expect(form.controls.translations.controls.en.controls.slug.value).toBe('manual-slug');
  });

  it('normalizes keywords by trimming empty and duplicate values', () => {
    expect(normalizeKeywords('gearbox, gearbox, , transmission, Gearbox').keywords)
      .toEqual(['gearbox', 'transmission']);
  });

  it('preserves boolean false values and priority zero in normalized SEO payload', () => {
    const form = buildSeoFormValue(fb, 'product');
    form.controls.seo.patchValue({
      robotsIndex: false,
      robotsFollow: false,
      includeInSitemap: false,
      sitemapPriority: 0
    });

    const payload = normalizeSeoExtensionPayload(form);

    expect(payload.seo?.robotsIndex).toBeFalse();
    expect(payload.seo?.robotsFollow).toBeFalse();
    expect(payload.seo?.includeInSitemap).toBeFalse();
    expect(payload.seo?.sitemapPriority).toBe(0);
  });

  it('loads an existing category without SEO safely', () => {
    const form = buildSeoFormValue(
      fb,
      'category',
      {},
      { entityType: 'category', legacyName: 'قطع غيار' }
    );

    expect(form.controls.translations.controls.ar.controls.name.value).toBe('قطع غيار');
    expect(form.controls.seo.controls.robotsIndex.value).toBeTrue();
    expect(form.controls.seo.controls.sitemapPriority.value).toBe(0.7);
  });

  it('loads an existing product without SEO safely', () => {
    const form = buildSeoFormValue(
      fb,
      'product',
      {},
      { entityType: 'product', legacyName: 'Gearbox', price: 1200 }
    );

    expect(form.controls.translations.controls.ar.controls.name.value).toBe('Gearbox');
    expect(form.controls.seo.controls.sitemapPriority.value).toBe(0.8);
  });

  it('keeps existing category payload fields intact when SEO is appended', () => {
    const form = buildSeoFormValue(fb, 'category');
    const categoryPayload = {
      name: 'قطع غيار',
      imageBase64: 'data:image/png;base64,abc',
      specifications: [{ title: 'Brand' }],
      ...normalizeSeoExtensionPayload(form)
    };

    expect(categoryPayload.name).toBe('قطع غيار');
    expect(categoryPayload.imageBase64).toBe('data:image/png;base64,abc');
    expect(categoryPayload.specifications).toEqual([{ title: 'Brand' }]);
  });

  it('keeps existing product payload fields intact when SEO is appended', () => {
    const form = buildSeoFormValue(fb, 'product');
    const productPayload = {
      name: 'Gearbox',
      code: 'GB-01',
      inventoryCount: 5,
      newInventory: 0,
      editProduct: true,
      retailPrice: 100,
      specifications: [{ title: 'Brand', value: 'Kapomatic' }],
      ...normalizeSeoExtensionPayload(form)
    };

    expect(productPayload.inventoryCount).toBe(5);
    expect(productPayload.newInventory).toBe(0);
    expect(productPayload.editProduct).toBeTrue();
    expect(productPayload.retailPrice).toBe(100);
  });

  it('does not alter inventory values for an SEO-only product edit payload', () => {
    const form = buildSeoFormValue(fb, 'product');
    form.controls.seo.controls.en.controls.metaTitle.setValue('Gearbox | Kapomatic');

    const before = { inventoryCount: 11, newInventory: 0, editProduct: true };
    const after = { ...before, ...normalizeSeoExtensionPayload(form) };

    expect(after.inventoryCount).toBe(before.inventoryCount);
    expect(after.newInventory).toBe(before.newInventory);
    expect(after.editProduct).toBe(before.editProduct);
  });

  it('maps duplicate slug backend errors to the correct language', () => {
    const match = extractDuplicateSlugMatch({
      status: 409,
      error: {
        field: 'translations.en.slug',
        message: 'Duplicate slug',
        slug: 'gearbox'
      }
    });

    expect(match).toEqual({ language: 'en', slug: 'gearbox', message: 'Duplicate slug' });
  });

  it('builds an Arabic preview with RTL direction', () => {
    const form = buildSeoFormValue(fb, 'category');
    form.controls.translations.controls.ar.controls.name.setValue('قطع غيار');
    form.controls.seo.controls.ar.controls.metaTitle.setValue('قطع غيار في مصر | كابوماتيك');

    const preview = buildSeoPreviewData(form, { entityType: 'category' }, 'ar');

    expect(preview.direction).toBe('rtl');
    expect(preview.title).toBe('قطع غيار في مصر | كابوماتيك');
  });

  it('builds an English preview with LTR direction', () => {
    const form = buildSeoFormValue(fb, 'category');
    form.controls.translations.controls.en.controls.name.setValue('Transmission Parts');

    const preview = buildSeoPreviewData(form, { entityType: 'category' }, 'en');

    expect(preview.direction).toBe('ltr');
    expect(preview.title).toBe('Transmission Parts in Egypt | Kapomatic');
  });

  it('includes product price in product preview', () => {
    const form = buildSeoFormValue(fb, 'product');

    const preview = buildSeoPreviewData(form, { entityType: 'product', price: 2500 }, 'en');

    expect(preview.isProduct).toBeTrue();
    expect(preview.price).toBe(2500);
  });

  it('omits price in category preview', () => {
    const form = buildSeoFormValue(fb, 'category');

    const preview = buildSeoPreviewData(form, { entityType: 'category', price: 2500 }, 'en');

    expect(preview.isProduct).toBeFalse();
    expect(preview.price).toBeNull();
  });
});

