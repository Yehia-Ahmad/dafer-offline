import { EcommerceGeneralSettings } from '../models/ecommerce-settings.models';

export const GET_GENERAL_SETTINGS_API = 'GET /api/ecommerce-settings/general';

export type GetGeneralSettingsResponsePayload = EcommerceGeneralSettings;
