import { EcommerceCategoriesSettingsResponse } from '../models/ecommerce-settings.models';

export const GET_CATEGORIES_WITH_PRODUCTS_AND_SETTINGS_API =
  'GET /api/ecommerce-settings/categories';

export type GetCategoriesWithProductsAndSettingsResponsePayload =
  EcommerceCategoriesSettingsResponse;
