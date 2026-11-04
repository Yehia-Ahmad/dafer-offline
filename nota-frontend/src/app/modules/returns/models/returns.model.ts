export type ReturnType = 'cash' | 'credit';

export interface ReturnItem {
  productId: string;
  productName: string;
  productCode: string;
  quantity: number;
  price: number;
  total: number;
  returnReason: string;
}

export interface ReturnLog {
  _id: string;
  returnType: ReturnType;
  invoiceId: string;
  invoiceNumber: string;
  customerName: string;
  customerPhone: string;
  returnDate: string;
  note: string;
  items: ReturnItem[];
  subtotalReturnedAmount: number;
  discountAmount: number;
  shippingFees: number;
  finalReturnedAmount: number;
  createdAt: string;
}

export interface ReturnsFilters {
  returnType?: ReturnType;
  customerName?: string;
  customerPhone?: string;
  productId?: string;
  productCode?: string;
  dateFrom?: string;
  dateTo?: string;
  invoiceId?: string;
  page?: number;
  limit?: number;
}

export interface ReturnsPagination {
  page: number;
  limit: number;
  totalItems: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPrevPage: boolean;
}

export interface ReturnsListResponse {
  success: boolean;
  data: ReturnLog[];
  pagination: ReturnsPagination;
}

export interface ReturnsSummary {
  totalCashReturns: number;
  totalCreditReturns: number;
  totalReturnedAmount: number;
  totalReturnedItems: number;
}

export interface ApiDataResponse<T> {
  success: boolean;
  data: T;
}

export interface CreateReturnItemPayload {
  productId: string;
  quantity: number;
  returnReason?: string;
}

export interface CreateReturnPayload {
  returnType: ReturnType;
  invoiceId: string;
  returnDate?: string;
  refundDate?: string;
  note?: string;
  items: CreateReturnItemPayload[];
}
