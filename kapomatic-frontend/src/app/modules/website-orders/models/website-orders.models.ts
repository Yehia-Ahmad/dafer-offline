export type WebsiteOrderScope = 'all' | 'pending' | 'accepted' | 'refunded';
export type WebsiteOrderStatus = 'pending' | 'accepted' | 'refunded' | string;

export interface WebsiteOrderItem {
  id: string;
  productId: string;
  productName: string;
  productCode: string;
  categoryName: string;
  quantity: number | null;
  unitPrice: number | null;
  totalPrice: number | null;
}

export interface WebsiteOrder {
  id: string;
  orderNumber: string;
  status: WebsiteOrderStatus;
  customerName: string;
  customerPhone: string;
  shippingLocation: string;
  government: string;
  createdAt: string | null;
  acceptedAt: string | null;
  refundedAt: string | null;
  sellingInvoiceId: string;
  itemCount: number | null;
  totalQuantity: number | null;
  subtotal: number | null;
  discountAmount: number | null;
  shippingFees: number | null;
  totalPrice: number | null;
  refundNote: string;
  paymentMethod: string;
  transferPhone: string;
  transferImage: string;
  items: WebsiteOrderItem[];
}

export interface WebsiteOrdersPagination {
  page: number;
  limit: number;
  totalItems: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPrevPage: boolean;
}

export interface WebsiteOrdersPage {
  orders: WebsiteOrder[];
  pagination: WebsiteOrdersPagination;
}

export interface WebsiteOrderConfirmPayload {
  confirmInsufficientInventory: boolean;
}

export interface WebsiteOrderRefundPayload {
  note?: string;
}
