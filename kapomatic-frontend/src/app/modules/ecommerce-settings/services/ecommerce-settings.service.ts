import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { map, Observable } from 'rxjs';
import { environment } from '../../../../environments/environment';
import {
  EcommerceCategoriesSettingsResponse,
  EcommerceCategoryOption,
  EcommerceCategorySpecification,
  EcommerceCategoryWithSettings,
  EcommerceFilterItem,
  EcommerceGeneralSettings,
  EcommerceHomePageCategoriesResponse,
  EcommerceHomePageCategory,
  EcommerceProductOption,
  EcommerceSocialMediaLink,
  EcommerceSetting,
  EcommerceSettingApiPayload,
  EcommerceStoreLocation,
  GovernmentShippingFee,
  GovernmentShippingSettingsResponse,
  ResetEcommerceSettingResponse,
  UpdateEcommerceGeneralSettingsPayload,
  UpdateEcommerceGeneralSettingsResponse,
  UpdateGovernmentShippingFeesPayload,
  UpdateGovernmentShippingFeesResponse,
  UpdateEcommerceHomePageCategoriesPayload,
  UpdateEcommerceHomePageCategoriesResponse,
  UpsertEcommerceSettingPayload,
  UpsertEcommerceSettingResponse
} from '../models/ecommerce-settings.models';
import { GET_ALL_ECOMMERCE_SETTINGS_API } from '../api/get-all-ecommerce-settings.api';
import { GET_STOREFRONT_SETTINGS_API } from '../api/get-storefront-settings.api';
import {
  GET_CATEGORIES_WITH_PRODUCTS_AND_SETTINGS_API
} from '../api/get-categories-with-products-and-settings.api';
import { GET_ECOMMERCE_SETTING_BY_CATEGORY_API } from '../api/get-ecommerce-setting-by-category.api';
import {
  UPSERT_ECOMMERCE_SETTING_API
} from '../api/update-ecommerce-category-settings.api';
import {
  RESET_ECOMMERCE_SETTING_API
} from '../api/reset-ecommerce-setting.api';
import {
  UPDATE_GOVERNMENT_SHIPPING_FEES_API
} from '../api/update-government-shipping-fees.api';
import {
  GET_GOVERNMENT_SHIPPING_FEES_API
} from '../api/get-government-shipping-fees.api';
import { GET_GENERAL_SETTINGS_API } from '../api/get-general-settings.api';
import { UPDATE_GENERAL_SETTINGS_API } from '../api/update-general-settings.api';
import { GET_HOME_PAGE_CATEGORIES_API } from '../api/get-home-page-categories.api';
import { UPDATE_HOME_PAGE_CATEGORIES_API } from '../api/update-home-page-categories.api';

@Injectable({
  providedIn: 'root'
})
export class EcommerceSettingsService {
  readonly getAllSettingsApiName = GET_ALL_ECOMMERCE_SETTINGS_API;
  readonly getStorefrontSettingsApiName = GET_STOREFRONT_SETTINGS_API;
  readonly getCategoriesWithProductsApiName = GET_CATEGORIES_WITH_PRODUCTS_AND_SETTINGS_API;
  readonly getSettingByCategoryApiName = GET_ECOMMERCE_SETTING_BY_CATEGORY_API;
  readonly upsertSettingApiName = UPSERT_ECOMMERCE_SETTING_API;
  readonly resetSettingApiName = RESET_ECOMMERCE_SETTING_API;
  readonly updateGovernmentShippingFeesApiName = UPDATE_GOVERNMENT_SHIPPING_FEES_API;
  readonly getGovernmentShippingFeesApiName = GET_GOVERNMENT_SHIPPING_FEES_API;
  readonly getGeneralSettingsApiName = GET_GENERAL_SETTINGS_API;
  readonly updateGeneralSettingsApiName = UPDATE_GENERAL_SETTINGS_API;
  readonly getHomePageCategoriesApiName = GET_HOME_PAGE_CATEGORIES_API;
  readonly updateHomePageCategoriesApiName = UPDATE_HOME_PAGE_CATEGORIES_API;

  private readonly baseUrl = `${environment.api_base_url}ecommerce-settings`;

  constructor(private http: HttpClient) {}

  getCategoriesWithProductsAndSettings(): Observable<EcommerceCategoriesSettingsResponse> {
    return this.http.get<unknown>(`${this.baseUrl}/categories`).pipe(
      map((response) => ({ categories: this.normalizeCategoriesResponse(response) }))
    );
  }

  getSettingByCategory(categoryId: string): Observable<EcommerceSetting> {
    return this.http
      .get<unknown>(`${this.baseUrl}/${categoryId}`)
      .pipe(map((response) => this.normalizeSetting(response)));
  }

  upsertSetting(
    categoryId: string,
    payload: UpsertEcommerceSettingPayload
  ): Observable<UpsertEcommerceSettingResponse> {
    return this.http.put<unknown>(`${this.baseUrl}/${categoryId}`, this.toRequestPayload(payload)).pipe(
      map((response) => this.normalizeUpsertResponse(categoryId, payload, response))
    );
  }

  resetSetting(categoryId: string): Observable<ResetEcommerceSettingResponse> {
    return this.http.delete<unknown>(`${this.baseUrl}/${categoryId}`).pipe(
      map((response: any) => ({
        success: Boolean(response?.success ?? true),
        message: response?.message || 'E-commerce setting reset successfully.'
      }))
    );
  }

  updateGovernmentShippingFees(
    payload: UpdateGovernmentShippingFeesPayload
  ): Observable<UpdateGovernmentShippingFeesResponse> {
    return this.http.put<unknown>(`${this.baseUrl}/shipping/governments`, payload).pipe(
      map((response) => this.normalizeGovernmentShippingFeesResponse(payload, response))
    );
  }

  getGovernmentShippingFees(): Observable<GovernmentShippingSettingsResponse> {
    return this.http.get<unknown>(`${this.baseUrl}/shipping/governments`).pipe(
      map((response) => {
        const body = response as any;
        const governmentFees =
          body?.governmentFees ??
          body?.data?.governmentFees ??
          body?.setting?.governmentFees ??
          [];
        const freeShippingMinimumAmount =
          body?.freeShippingMinimumAmount ??
          body?.data?.freeShippingMinimumAmount ??
          body?.setting?.freeShippingMinimumAmount ??
          0;

        return {
          governmentFees: this.normalizeGovernmentShippingFees(governmentFees),
          freeShippingMinimumAmount: Number(freeShippingMinimumAmount)
        };
      })
    );
  }

  getGeneralSettings(): Observable<EcommerceGeneralSettings> {
    return this.http.get<unknown>(`${this.baseUrl}/general`).pipe(
      map((response) => this.normalizeGeneralSettings(response))
    );
  }

  updateGeneralSettings(
    payload: UpdateEcommerceGeneralSettingsPayload
  ): Observable<UpdateEcommerceGeneralSettingsResponse> {
    return this.http.put<unknown>(`${this.baseUrl}/general`, payload).pipe(
      map((response) => {
        const body = response as any;
        const settings = this.normalizeGeneralSettings(response, payload);

        return {
          ...settings,
          success: Boolean(body?.success ?? true),
          message: body?.message || 'General settings saved successfully.'
        };
      })
    );
  }

  getActiveCategories(): Observable<EcommerceHomePageCategory[]> {
    return this.http.get<unknown>(`${environment.api_base_url}categories`, {
      params: { isActive: 'true' }
    }).pipe(
      map((response) => {
        const categories = this.extractArray(response, ['categories', 'data', 'data.categories']);

        return categories
          .filter((category: any) => category?.isActive !== false && category?.active !== false)
          .map((category: any) => this.normalizeHomePageCategory(category))
          .filter((category) => category.id);
      })
    );
  }

  getHomePageCategories(): Observable<EcommerceHomePageCategoriesResponse> {
    return this.http.get<unknown>(`${this.baseUrl}/home-page/categories`).pipe(
      map((response) => this.normalizeHomePageCategoriesResponse(response))
    );
  }

  updateHomePageCategories(
    payload: UpdateEcommerceHomePageCategoriesPayload
  ): Observable<UpdateEcommerceHomePageCategoriesResponse> {
    return this.http.put<unknown>(`${this.baseUrl}/home-page/categories`, payload).pipe(
      map((response) => {
        const body = response as any;
        const normalized = this.normalizeHomePageCategoriesResponse(response, payload.categoryIds);

        return {
          ...normalized,
          success: Boolean(body?.success ?? true),
          message: body?.message || 'Home page categories saved successfully.'
        };
      })
    );
  }

  private normalizeCategoriesResponse(response: unknown): EcommerceCategoryWithSettings[] {
    const rawCategories = this.extractArray(response, ['categories', 'data', 'data.categories']);
    return rawCategories.map((item: any) => this.normalizeCategory(item));
  }

  private normalizeCategory(item: any): EcommerceCategoryWithSettings {
    const category = item?.category || item || {};
    const setting = item?.setting || item?.settings || item?.ecommerceSetting || {};
    const categoryId = String(
      category?._id ||
        category?.id ||
        item?.categoryId ||
        setting?.category ||
        setting?.categoryId ||
        ''
    );
    const selectedProducts = setting?.selectedProducts || setting?.productIds || setting?.products || [];
    const categoryFilters = this.normalizeCategorySpecifications(category?.filters || category?.specifications || []);
    const categoryOption: EcommerceCategoryOption = {
      id: categoryId,
      name: String(category?.name || category?.categoryName || setting?.categoryName || ''),
      image: category?.image ? String(category.image) : undefined,
      description: category?.description ? String(category.description) : undefined,
      filters: categoryFilters,
      specifications: categoryFilters
    };

    return {
      id: String(setting?._id || setting?.id || ''),
      categoryId,
      categoryName: categoryOption.name,
      showOnWebsite: Boolean(setting?.showOnWebsite),
      productIds: this.extractIds(selectedProducts),
      category: categoryOption,
      filters: this.normalizeFilters(setting?.filters),
      products: this.normalizeProducts(item?.products || category?.products || category?.categoryProducts || [])
    };
  }

  private normalizeSetting(response: unknown): EcommerceSetting {
    const raw = (response as any)?.data || (response as any)?.setting || response || {};
    const item = raw?.category || raw?.setting ? raw : { category: raw?.category, setting: raw };
    const normalized = this.normalizeCategory(item);

    return {
      id: normalized.id,
      categoryId: normalized.categoryId,
      categoryName: normalized.categoryName,
      showOnWebsite: normalized.showOnWebsite,
      productIds: normalized.productIds,
      filters: normalized.filters
    };
  }

  private normalizeUpsertResponse(
    categoryId: string,
    payload: UpsertEcommerceSettingPayload,
    response: unknown
  ): UpsertEcommerceSettingResponse {
    const body = response as any;
    const rawSetting = body?.setting || body?.data || body || {};
    const normalized = this.normalizeSetting({
      category: body?.category || body?.data?.category,
      setting: rawSetting
    });

    return {
      success: Boolean(body?.success ?? true),
      message: body?.message || 'E-commerce setting saved successfully.',
      setting: {
        id: normalized.id || String(rawSetting?._id || rawSetting?.id || ''),
        categoryId: normalized.categoryId || categoryId,
        categoryName: normalized.categoryName || String(body?.category?.name || body?.data?.category?.name || ''),
        showOnWebsite: Boolean(rawSetting?.showOnWebsite ?? payload.showOnWebsite),
        productIds: this.extractIds(
          rawSetting?.selectedProducts || rawSetting?.productIds || rawSetting?.products || payload.productIds
        ),
        filters: this.normalizeFilters(rawSetting?.filters || payload.filters)
      }
    };
  }

  private normalizeProducts(products: any[]): EcommerceProductOption[] {
    return products.map((product) => ({
      id: String(product?._id || product?.id || product?.productId || ''),
      name: String(product?.name || product?.productName || ''),
      code: product?.code ? String(product.code) : undefined,
      discountPercentage: Number(product?.discountPercentage ?? 0),
      priceAfterDiscount: product?.priceAfterDiscount === null || product?.priceAfterDiscount === undefined
        ? null
        : Number(product.priceAfterDiscount)
    }));
  }

  private normalizeCategorySpecifications(specifications: any[]): EcommerceCategorySpecification[] {
    if (!Array.isArray(specifications)) return [];

    return specifications
      .map((specification) => ({
        name: String(specification?.name || specification?.title || '').trim(),
        values: this.extractSpecificationValues(specification?.values || [])
      }))
      .filter((specification) => specification.name);
  }

  private extractSpecificationValues(values: any[]): string[] {
    if (!Array.isArray(values)) return [];

    return Array.from(
      new Set(
        values
          .map((value) => String(value?.value || value?.title || value?.name || value).trim())
          .filter(Boolean)
      )
    );
  }

  private normalizeFilters(filters: any[] = []): EcommerceFilterItem[] {
    if (!Array.isArray(filters)) return [];

    return filters.map((filter, index) => ({
      title: String(filter?.title || filter?.name || ''),
      values: this.extractSpecificationValues(filter?.values || []),
      isVisible: Boolean(filter?.isVisible ?? true)
    }));
  }

  private normalizeGovernmentShippingFeesResponse(
    payload: UpdateGovernmentShippingFeesPayload,
    response: unknown
  ): UpdateGovernmentShippingFeesResponse {
    const body = response as any;
    const rawGovernmentFees =
      body?.governmentFees || body?.data?.governmentFees || body?.setting?.governmentFees;

    return {
      success: Boolean(body?.success ?? true),
      message: body?.message || 'Shipping setting saved successfully.',
      governmentFees: this.normalizeGovernmentShippingFees(rawGovernmentFees || payload.governmentFees)
    };
  }

  private normalizeGovernmentShippingFees(values: any[] = []): GovernmentShippingFee[] {
    if (!Array.isArray(values)) return [];

    return values
      .map((item) => ({
        government: String(item?.government || item?.governorate || '').trim(),
        shippingFees: Number(item?.shippingFees ?? 0)
      }))
      .filter((item) => item.government);
  }

  private normalizeGeneralSettings(
    response: unknown,
    fallback: UpdateEcommerceGeneralSettingsPayload = {}
  ): EcommerceGeneralSettings {
    const body = response as any;
    const settings = body?.data || body?.settings || body?.generalSettings || body || {};

    return {
      mainLogo: String(settings?.mainLogo ?? fallback.mainLogo ?? ''),
      mainColor: String(settings?.mainColor ?? fallback.mainColor ?? '#F4D80A'),
      freeShippingMinimumAmount: Number(
        settings?.freeShippingMinimumAmount ?? fallback.freeShippingMinimumAmount ?? 0
      ),
      currency: String(settings?.currencyCode ?? settings?.currency ?? fallback.currencyCode ?? fallback.currency ?? 'EGP').trim().toUpperCase(),
      walletPhone: String(settings?.walletPhone ?? fallback.walletPhone ?? '').trim(),
      instapayLink: String(settings?.instapayLink ?? fallback.instapayLink ?? '').trim(),
      storeLocations: this.normalizeStoreLocations(
        settings?.storeLocations ?? fallback.storeLocations ?? []
      ),
      socialMediaLinks: this.normalizeSocialMediaLinks(
        settings?.socialMediaLinks ?? fallback.socialMediaLinks ?? []
      )
    };
  }

  private normalizeStoreLocations(values: EcommerceStoreLocation[] = []): EcommerceStoreLocation[] {
    if (!Array.isArray(values)) return [];

    return values.map((item: any) => ({
      name: String(item?.name || '').trim(),
      detailedLocation: String(item?.detailedLocation || '').trim(),
      mapLink: String(item?.mapLink || '').trim()
    }));
  }

  private normalizeSocialMediaLinks(
    values: EcommerceSocialMediaLink[] = []
  ): EcommerceSocialMediaLink[] {
    if (!Array.isArray(values)) return [];

    return values.map((item: any) => ({
      name: String(item?.name || '').trim(),
      link: String(item?.link || '').trim()
    }));
  }

  private normalizeHomePageCategoriesResponse(
    response: unknown,
    fallbackCategoryIds: string[] = []
  ): EcommerceHomePageCategoriesResponse {
    const body = response as any;
    const data = body?.data || body?.settings || body || {};
    const categories = Array.isArray(data?.categories)
      ? data.categories.map((category: any) => this.normalizeHomePageCategory(category))
      : [];
    const categoryIds = this.extractIds(data?.categoryIds || fallbackCategoryIds);

    return {
      categoryIds: categoryIds.length ? categoryIds : categories.map((category) => category.id),
      categories
    };
  }

  private normalizeHomePageCategory(category: any): EcommerceHomePageCategory {
    return {
      id: String(category?._id || category?.id || ''),
      name: String(category?.name || category?.categoryName || ''),
      image: category?.image ? String(category.image) : undefined
    };
  }

  private extractIds(values: any[]): string[] {
    if (!Array.isArray(values)) return [];

    return values
      .map((value) => String(value?._id || value?.id || value?.productId || value))
      .filter(Boolean);
  }

  private toRequestPayload(payload: UpsertEcommerceSettingPayload): EcommerceSettingApiPayload {
    return {
      ...payload,
      selectedProducts: payload.productIds
    };
  }

  private extractArray(response: unknown, paths: string[]): any[] {
    for (const path of paths) {
      const value = path.split('.').reduce((current: any, key) => current?.[key], response as any);
      if (Array.isArray(value)) return value;
    }

    return Array.isArray(response) ? (response as any[]) : [];
  }
}
