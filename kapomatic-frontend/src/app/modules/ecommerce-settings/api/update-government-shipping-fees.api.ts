import {
  UpdateGovernmentShippingFeesPayload,
  UpdateGovernmentShippingFeesResponse
} from '../models/ecommerce-settings.models';

export const UPDATE_GOVERNMENT_SHIPPING_FEES_API =
  'PUT /api/ecommerce-settings/shipping/governments';

export type UpdateGovernmentShippingFeesRequestPayload = UpdateGovernmentShippingFeesPayload;
export type UpdateGovernmentShippingFeesResponsePayload = UpdateGovernmentShippingFeesResponse;
