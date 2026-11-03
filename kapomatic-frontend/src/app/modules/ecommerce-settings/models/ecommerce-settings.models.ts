export interface EcommerceProductOption {
  id: string;
  name: string;
  code?: string;
  discountPercentage?: number;
  priceAfterDiscount?: number | null;
}

export interface EcommerceCategorySpecification {
  name: string;
  values: string[];
}

export interface EcommerceCategoryOption {
  id: string;
  name: string;
  image?: string;
  description?: string;
  filters: EcommerceCategorySpecification[];
  specifications: EcommerceCategorySpecification[];
}

export interface EcommerceFilterItem {
  title: string;
  values: string[];
  isVisible: boolean;
}

export interface EcommerceSetting {
  id?: string;
  categoryId: string;
  categoryName: string;
  showOnWebsite: boolean;
  productIds: string[];
  filters: EcommerceFilterItem[];
}

export interface EcommerceCategoryWithSettings extends EcommerceSetting {
  category: EcommerceCategoryOption;
  products: EcommerceProductOption[];
}

export interface EcommerceSettingsResponse {
  settings: EcommerceSetting[];
}

export interface EcommerceCategoriesSettingsResponse {
  categories: EcommerceCategoryWithSettings[];
}

export interface UpsertEcommerceSettingPayload {
  showOnWebsite: boolean;
  productIds: string[];
  filters: EcommerceFilterItem[];
}

export interface EcommerceSettingApiPayload extends UpsertEcommerceSettingPayload {
  selectedProducts: string[];
}

export interface UpsertEcommerceSettingResponse {
  success: boolean;
  message: string;
  setting: EcommerceSetting;
}

export interface ResetEcommerceSettingResponse {
  success: boolean;
  message: string;
}

export interface GovernmentShippingFee {
  government: string;
  shippingFees: number;
}

export interface GovernmentShippingSettingsResponse {
  governmentFees: GovernmentShippingFee[];
  freeShippingMinimumAmount: number;
}

export interface UpdateGovernmentShippingFeesPayload {
  governmentFees: GovernmentShippingFee[];
}

export interface UpdateGovernmentShippingFeesResponse extends UpdateGovernmentShippingFeesPayload {
  success: boolean;
  message: string;
}

export interface EcommerceStoreLocation {
  name: string;
  detailedLocation: string;
  mapLink: string;
}

export interface EcommerceSocialMediaLink {
  name: string;
  link: string;
}

export interface EcommerceGeneralSettings {
  mainLogo: string;
  mainColor: string;
  freeShippingMinimumAmount: number;
  currency: string;
  walletPhone: string;
  instapayLink: string;
  storeLocations: EcommerceStoreLocation[];
  socialMediaLinks: EcommerceSocialMediaLink[];
}

export type UpdateEcommerceGeneralSettingsPayload = Partial<EcommerceGeneralSettings> & {
  currencyCode?: string;
};

export interface UpdateEcommerceGeneralSettingsResponse extends EcommerceGeneralSettings {
  success: boolean;
  message: string;
}

export interface EcommerceHomePageCategory {
  id: string;
  name: string;
  image?: string;
}

export interface EcommerceHomePageCategoriesResponse {
  categoryIds: string[];
  categories: EcommerceHomePageCategory[];
}

export interface UpdateEcommerceHomePageCategoriesPayload {
  categoryIds: string[];
}

export interface UpdateEcommerceHomePageCategoriesResponse
  extends EcommerceHomePageCategoriesResponse {
  success: boolean;
  message: string;
}
