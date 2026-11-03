import {
  UpsertEcommerceSettingPayload,
  UpsertEcommerceSettingResponse
} from '../models/ecommerce-settings.models';

export const UPSERT_ECOMMERCE_SETTING_API = 'PUT /api/ecommerce-settings/:categoryId';

export type UpsertEcommerceSettingRequestPayload = UpsertEcommerceSettingPayload;
export type UpsertEcommerceSettingResponsePayload = UpsertEcommerceSettingResponse;
