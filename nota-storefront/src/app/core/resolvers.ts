import { inject } from '@angular/core';
import { ResolveFn } from '@angular/router';
import { ApiError, ApiService } from './api.service';
import { Category, Page, Product, Zone } from './models';
import { PageStatus } from './page-status.service';
import { SettingsStore } from './settings.store';
import { storeSlug } from './slug';

/** What a resolver hands to its page: the data, or why there is none (the page then shows the 404 / "problem" view). */
export type Loaded<T> = { state: 'ok'; data: T } | { state: 'notfound' } | { state: 'down' };

const guard = async <T>(status: PageStatus, settings: SettingsStore, fn: () => Promise<T>): Promise<Loaded<T>> => {
  try {
    return { state: 'ok', data: await fn() };
  } catch (error) {
    if (error instanceof ApiError && (error.status === 404 || error.code === 'NOT_FOUND' || error.status === 400)) {
      status.notFound();
      return { state: 'notfound' };
    }
    if (error instanceof ApiError && error.code === 'STORE_CLOSED') {
      // closed between the settings call and this one: the shell shows the closed page
      status.closed();
      await settings.load();
      return { state: 'down' };
    }
    status.unavailable();
    settings.down.set(true);
    return { state: 'down' };
  }
};

export interface HomeData { best: Product[]; offers: Product[]; latest: Product[] }

export const homeResolver: ResolveFn<Loaded<HomeData>> = () => {
  const api = inject(ApiService);
  return guard(inject(PageStatus), inject(SettingsStore), async () => {
    const [best, latest] = await Promise.all([api.products({ sort: 'bestselling', limit: 8 }), api.products({ sort: 'newest', limit: 24 })]);
    // The API has no "offers" filter: the discounted ones among the newest.
    const offers = latest.data.filter((p) => p.discountPercentage > 0 && p.availability !== 'out_of_stock').slice(0, 8);
    return { best: best.data, offers, latest: latest.data.slice(0, 12) };
  });
};

export interface ListingData { title: string; category: Category | null; query: string; page: Page<Product>; correctSlug: string | null }

export const categoryResolver: ResolveFn<Loaded<ListingData>> = (route) => {
  const api = inject(ApiService);
  const settings = inject(SettingsStore);
  const id = route.paramMap.get('id') || '';
  return guard(inject(PageStatus), settings, async () => {
    const categories = settings.categories().length ? settings.categories() : (await api.categories()).data;
    const category = categories.find((c) => c.id === id);
    if (!category) throw new ApiError(404, 'NOT_FOUND', '');
    const page = await api.products({ category: id, limit: 24, sort: (route.queryParamMap.get('sort') || 'newest') });
    return { title: category.name, category, query: '', page, correctSlug: storeSlug(category.name) };
  });
};

export const searchResolver: ResolveFn<Loaded<ListingData>> = (route) => {
  const api = inject(ApiService);
  const q = (route.queryParamMap.get('q') || '').trim().slice(0, 100);
  return guard(inject(PageStatus), inject(SettingsStore), async () => {
    const page = q ? await api.products({ q, limit: 24, sort: route.queryParamMap.get('sort') || 'newest' }) : { data: [], pagination: { page: 1, limit: 24, totalItems: 0, totalPages: 0, hasNextPage: false, hasPrevPage: false } };
    return { title: q, category: null, query: q, page, correctSlug: null };
  });
};

export interface ProductData { product: Product; related: Product[] }

export const productResolver: ResolveFn<Loaded<ProductData>> = (route) => {
  const api = inject(ApiService);
  const id = route.paramMap.get('id') || '';
  return guard(inject(PageStatus), inject(SettingsStore), async () => {
    const product = await api.product(id);
    let related: Product[] = [];
    try { related = (await api.related(id)).data.slice(0, 4); } catch { /* related products are optional */ }
    return { product, related };
  });
};

export const zonesResolver: ResolveFn<Loaded<Zone[]>> = () => {
  const api = inject(ApiService);
  return guard(inject(PageStatus), inject(SettingsStore), async () => (await api.zones()).data);
};
