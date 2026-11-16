import { Fulfillment, OrderDetail, OrderStatus, PaymentMethod, PaymentStatus, isWalletMethod } from './orders.models';

export type OrderAction = 'confirm' | 'edit' | 'reject' | 'prepare' | 'ready' | 'verifyPayment' | 'cancel' | 'dispatch' | 'pickup' | 'deliver' | 'refuse';

/** What the action table needs to know about an order (an order placed before Stage 5A is a delivery order paid on delivery). */
export type OrderActionContext = Pick<OrderDetail, 'status'> & Partial<{ fulfillment: Fulfillment; paymentMethod: PaymentMethod; payment: { status: PaymentStatus } }>;

/**
 * The statuses each action may start from (the backend table: nota-backend/src/services/webOrders.service.js).
 * `fulfillment` says which kind of order the action exists for (undefined = both).
 */
const FROM: Record<OrderAction, { from: readonly OrderStatus[]; fulfillment?: Fulfillment }> = {
  confirm: { from: ['new'] },
  reject: { from: ['new', 'confirmed'] },
  edit: { from: ['new', 'confirmed', 'preparing'] },
  prepare: { from: ['confirmed'] },
  ready: { from: ['preparing'], fulfillment: 'pickup' },
  verifyPayment: { from: ['new', 'confirmed', 'preparing', 'ready_for_pickup'] },
  cancel: { from: ['confirmed', 'preparing'] }, // a pickup order can also be cancelled when it is ready (see CANCEL_PICKUP)
  dispatch: { from: ['confirmed', 'preparing'], fulfillment: 'delivery' },
  pickup: { from: ['ready_for_pickup'], fulfillment: 'pickup' },
  deliver: { from: ['out_for_delivery'], fulfillment: 'delivery' },
  refuse: { from: ['out_for_delivery'], fulfillment: 'delivery' },
};
const CANCEL_PICKUP: readonly OrderStatus[] = ['confirmed', 'preparing', 'ready_for_pickup'];

/**
 * What an action needs besides its own permission: the document it creates (checked the same way on the server). It depends on
 * the payment: cash on delivery sends out a credit sale on the courier and collects; a wallet order is a cash sale and collects nothing.
 */
const keysOf = (action: OrderAction, wallet: boolean): readonly string[] => {
  switch (action) {
    case 'confirm': case 'reject': case 'edit': case 'prepare': case 'ready': case 'verifyPayment': case 'cancel': return ['orders.manage'];
    case 'dispatch': return wallet ? ['orders.dispatch', 'sales.create'] : ['orders.dispatch', 'credit.create'];
    case 'pickup': return ['orders.dispatch', 'sales.create'];
    case 'deliver': return wallet ? ['orders.dispatch'] : ['orders.dispatch', 'credit.collect'];
    case 'refuse': return ['orders.dispatch', 'returns.create'];
  }
};

export const ORDER_ACTION_ORDER: readonly OrderAction[] = ['verifyPayment', 'confirm', 'prepare', 'ready', 'pickup', 'dispatch', 'deliver', 'refuse', 'edit', 'reject', 'cancel'];

/**
 * The actions a user may offer for an order: allowed by its status, its fulfillment and payment, AND by the user's permissions.
 * The first argument may be a bare status (a delivery order paid on delivery: the Stage 4 call).
 * A wallet order's invoice is not offered before the transfer is confirmed; "تأكيد استلام التحويل" is offered instead.
 */
export function allowedOrderActions(order: OrderStatus | OrderActionContext, has: (key: string) => boolean): OrderAction[] {
  const ctx: OrderActionContext = typeof order === 'string' ? { status: order } : order;
  const fulfillment: Fulfillment = ctx.fulfillment === 'pickup' ? 'pickup' : 'delivery';
  const wallet = isWalletMethod(ctx.paymentMethod);
  const verified = ctx.payment?.status === 'verified';
  return ORDER_ACTION_ORDER.filter((action) => {
    const rule = FROM[action];
    if (rule.fulfillment && rule.fulfillment !== fulfillment) return false;
    const statuses = action === 'cancel' && fulfillment === 'pickup' ? CANCEL_PICKUP : rule.from;
    if (!statuses.includes(ctx.status)) return false;
    if (action === 'verifyPayment' && (!wallet || verified)) return false;
    if ((action === 'dispatch' || action === 'pickup') && wallet && !verified) return false;
    return keysOf(action, wallet).every((key) => has(key));
  });
}

/** Delivered with returned lines also needs returns.create. */
export const canReturnLines = (has: (key: string) => boolean): boolean => has('returns.create');

/** Phone → wa.me link digits (Egyptian local 01… becomes 201…). */
export function whatsappLink(phone: string): string {
  const digits = (phone || '').replace(/\D/g, '');
  const international = digits.startsWith('0') ? `20${digits.slice(1)}` : digits;
  return `https://wa.me/${international}`;
}
