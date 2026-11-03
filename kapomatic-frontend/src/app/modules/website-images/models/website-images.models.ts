export type WebsiteImageTargetType = 'category' | 'product' | 'both' | 'price' | 'specification';

export interface WebsiteImage {
  id: string;
  title: string;
  image: string;
  targetType: WebsiteImageTargetType;
  categoryIds: string[];
  productIds: string[];
  maxPrice: number | null;
  specificationFilters: WebsiteImageSpecificationFilter[];
  viewOnly: boolean;
  isActive: boolean;
  createdAt: string | null;
}

export interface WebsiteImagePayload {
  title?: string;
  imageBase64?: string;
  targetType?: WebsiteImageTargetType;
  categoryIds?: string[];
  productIds?: string[];
  maxPrice?: number;
  specificationFilters?: WebsiteImageSpecificationFilter[];
  viewOnly?: boolean;
  isActive: boolean;
}

export interface WebsiteImageCategoryOption {
  id: string;
  name: string;
}

export interface WebsiteImageSpecificationFilter {
  specificationName: string;
  values: string[];
}

export type WebsiteImageSpecificationOption = WebsiteImageSpecificationFilter;

export interface WebsiteImageProductOption {
  id: string;
  name: string;
  code: string;
  image: string;
  categoryId: string;
  categoryName: string;
  retailPrice: number;
  discountPercentage: number;
  priceAfterDiscount: number | null;
}
