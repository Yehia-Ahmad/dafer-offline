// Online Stage 4: website orders in the admin app (/api/orders, /api/couriers, /api/website/customers).

export type OrderStatus = 'new' | 'confirmed' | 'preparing' | 'ready_for_pickup' | 'picked_up' | 'out_for_delivery' | 'delivered' | 'cancelled' | 'rejected' | 'refused';

export const ORDER_STATUSES: readonly OrderStatus[] = ['new', 'confirmed', 'preparing', 'ready_for_pickup', 'picked_up', 'out_for_delivery', 'delivered', 'cancelled', 'rejected', 'refused'];

/** Online Stage 5A. A missing value on an order placed before this stage means delivery / cash on delivery. */
export type Fulfillment = 'delivery' | 'pickup';
export type PaymentMethod = 'cod' | 'instapay' | 'vodafone_cash';
/** Wallet orders: whether the shop confirmed the transfer. Cash on delivery / pickup: null. */
export type PaymentStatus = 'unpaid' | 'verified' | null;
export const isWalletMethod = (method: PaymentMethod | undefined): boolean => method === 'instapay' || method === 'vodafone_cash';

export interface OrderListRow {
  id: string;
  number: string;
  status: OrderStatus;
  createdAt: string;
  customerName: string;
  phone: string;
  /** null for a pickup order. */
  zone: string | null;
  fulfillment: Fulfillment;
  paymentMethod: PaymentMethod;
  paymentStatus: PaymentStatus;
  /** A wallet order whose transfer is not confirmed yet and that is still open. */
  needsTransfer: boolean;
  total: number;
  /** Number of lines (distinct products) in the order (Stage 6A). Optional: an older backend does not send it. */
  itemsCount?: number;
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
  // Online Stage 5A
  fulfillment?: Fulfillment | '';
  paymentMethod?: PaymentMethod | '';
  /** '1' = wallet orders waiting for the transfer to be confirmed. */
  needsTransfer?: '1' | '';
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
  type: 'status' | 'edit' | 'payment';
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
  /** null for a pickup order. */
  zone: { id: string; name: string; fee: number } | null;
  contact: { name: string; phone: string; address: string; notes: string };
  reason: string | null;
  collectedAmount: number | null;
  courier: { id: string; name: string; phone: string } | null;
  creditSale: { id: string; number: string; totalPrice: number; paidAmount: number; remainingAmount: number; status: string; shippingFees: number } | null;
  // Online Stage 5A
  fulfillment: Fulfillment;
  paymentMethod: PaymentMethod;
  payment: { status: PaymentStatus; verifiedAt: string | null; verifiedByName: string | null; reference: string | null };
  /** The ONE invoice of the order: a credit sale (cash on delivery) or a cash sale (pickup / wallet). */
  invoice: { kind: 'credit' | 'cash'; id: string; number: string; totalPrice: number; shippingFees: number; refundedAmount: number; refundStatus: string | null; boxId: string | null } | null;
  /** The WhatsApp confirmation message with its {placeholders}. */
  whatsappTemplate: string;
  /** The zone's estimated delivery time ('' for pickup). */
  deliveryTime: string;
  statusHistory: OrderHistoryEntry[];
}

export interface OrderEditPayload {
  items?: Array<{ productId: string; qty: number }>;
  zoneId?: string;
  deliveryFee?: number;
  contact?: Partial<{ name: string; phone: string; address: string; notes: string }>;
}

/** POST /api/orders/:id/pickup: a cash-on-pickup order goes into the chosen box (a wallet order ignores it). */
export interface PickupPayload { boxId?: string }

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
