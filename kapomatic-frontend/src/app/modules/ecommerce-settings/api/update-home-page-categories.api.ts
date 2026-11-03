import {
  UpdateEcommerceHomePageCategoriesPayload,
  UpdateEcommerceHomePageCategoriesResponse
} from '../models/ecommerce-settings.models';

export const UPDATE_HOME_PAGE_CATEGORIES_API =
  'PUT /api/ecommerce-settings/home-page/categories';

export type UpdateHomePageCategoriesRequestPayload = UpdateEcommerceHomePageCategoriesPayload;
export type UpdateHomePageCategoriesResponsePayload = UpdateEcommerceHomePageCategoriesResponse;
