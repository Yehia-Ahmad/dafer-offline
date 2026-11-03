import {
  UpdateEcommerceGeneralSettingsPayload,
  UpdateEcommerceGeneralSettingsResponse
} from '../models/ecommerce-settings.models';

export const UPDATE_GENERAL_SETTINGS_API = 'PUT /api/ecommerce-settings/general';

export type UpdateGeneralSettingsRequestPayload = UpdateEcommerceGeneralSettingsPayload;
export type UpdateGeneralSettingsResponsePayload = UpdateEcommerceGeneralSettingsResponse;
