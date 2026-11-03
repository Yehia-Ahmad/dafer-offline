import { EcommerceSetting } from '../models/ecommerce-settings.models';

export const GET_ECOMMERCE_SETTING_BY_CATEGORY_API = 'GET /api/ecommerce-settings/:categoryId';

export type GetEcommerceSettingByCategoryResponsePayload = EcommerceSetting;
