import { GovernmentShippingSettingsResponse } from '../models/ecommerce-settings.models';

export const GET_GOVERNMENT_SHIPPING_FEES_API =
  'GET /api/ecommerce-settings/shipping/governments';

export type GetGovernmentShippingFeesResponsePayload = GovernmentShippingSettingsResponse;
