// Online Stage 4: website orders in the admin app (/api/orders, /api/couriers, /api/website/customers).

export type OrderStatus = 'new' | 'confirmed' | 'preparing' | 'out_for_delivery' | 'delivered' | 'cancelled' | 'rejected' | 'refused';

export const ORDER_STATUSES: readonly OrderStatus[] = ['new', 'confirmed', 'preparing', 'out_for_delivery', 'delivered', 'cancelled', 'rejected', 'refused'];

export interface OrderListRow {
  id: string;
  number: string;
  status: OrderStatus;
  createdAt: string;
  customerName: string;
  phone: string;
  zone: string;
  total: number;
  courierId: string | null;
  courierName: string | null;
}

export interface OrderListResponse {
  data: OrderListRow[];
  /** Orders per status for the other filters (the tab counts). */
  counts: Record<OrderStatus, number>;
  pagination: { page: number; limit: number; totalItems: number; totalPages: number };
}

export interface OrderListQuery {
  status?: OrderStatus | '';
  q?: string;
  from?: string;
  to?: string;
  courierId?: string;
  page?: number;
  limit?: number;
}

export interface OrderLine {
  productId: string;
  name: string;
  code?: string;
  retailPrice: number;
  discountPercentage: number;
  unitPrice: number;
  vat: number;
  vatExempt: boolean;
  qty: number;
  lineTotal: number;
  /** Stock now, and what other confirmed/preparing orders reserve. */
  inventoryCount: number | null;
  reservedByOthers: number;
}

export interface OrderHistoryEntry {
  status: OrderStatus;
  at: string;
  by: string;
  byName: string | null;
  type: 'status' | 'edit';
  note: string | null;
  details: Record<string, unknown> | null;
}

export interface OrderDetail {
  id: string;
  number: string;
  status: OrderStatus;
  createdAt: string;
  updatedAt: string;
  items: OrderLine[];
  subtotal: number;
  vat: number;
  vatRate?: number;
  vatIncluded?: boolean;
  deliveryFee: number;
  total: number;
  zone: { id: string; name: string; fee: number };
  contact: { name: string; phone: string; address: string; notes: string };
  reason: string | null;
  collectedAmount: number | null;
  courier: { id: string; name: string; phone: string } | null;
  creditSale: { id: string; number: string; totalPrice: number; paidAmount: number; remainingAmount: number; status: string; shippingFees: number } | null;
  statusHistory: OrderHistoryEntry[];
}

export interface OrderEditPayload {
  items?: Array<{ productId: string; qty: number }>;
  zoneId?: string;
  deliveryFee?: number;
  contact?: Partial<{ name: string; phone: string; address: string; notes: string }>;
}

export interface DeliverPayload {
  returns?: Array<{ productId: string; qty: number; reason?: string }>;
  collectedAmount?: number;
  note?: string;
}

export interface Courier {
  id: string;
  name: string;
  phone: string;
  isActive: boolean;
  boxId: string;
  customerId: string;
  boxBalance: number;
  amountOwed: number;
  openOrders: number;
}

export interface CourierOrderRow {
  id: string;
  number: string;
  status: OrderStatus;
  createdAt: string;
  customerName: string;
  total: number;
  collectedAmount: number | null;
}

export interface CourierDetail extends Courier {
  openOrderRows: CourierOrderRow[];
  recentOrderRows: CourierOrderRow[];
}

export interface WebsiteCustomer {
  id: string;
  name: string;
  phone: string;
  isActive: boolean;
  ordersCount: number;
  createdAt: string;
  lastLoginAt: string | null;
}
