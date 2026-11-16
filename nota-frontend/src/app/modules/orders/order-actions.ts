import { OrderStatus } from './orders.models';

export type OrderAction = 'confirm' | 'edit' | 'reject' | 'prepare' | 'cancel' | 'dispatch' | 'deliver' | 'refuse';

/** The statuses each action may start from (the backend table: nota-backend/src/services/webOrders.service.js). */
const FROM: Record<OrderAction, readonly OrderStatus[]> = {
  confirm: ['new'],
  reject: ['new', 'confirmed'],
  edit: ['new', 'confirmed', 'preparing'],
  prepare: ['confirmed'],
  cancel: ['confirmed', 'preparing'],
  dispatch: ['confirmed', 'preparing'],
  deliver: ['out_for_delivery'],
  refuse: ['out_for_delivery'],
};

/** What an action needs besides its own permission: the document it creates (checked the same way on the server). */
const KEYS: Record<OrderAction, readonly string[]> = {
  confirm: ['orders.manage'],
  reject: ['orders.manage'],
  edit: ['orders.manage'],
  prepare: ['orders.manage'],
  cancel: ['orders.manage'],
  dispatch: ['orders.dispatch', 'credit.create'],
  deliver: ['orders.dispatch', 'credit.collect'],
  refuse: ['orders.dispatch', 'returns.create'],
};

export const ORDER_ACTION_ORDER: readonly OrderAction[] = ['confirm', 'prepare', 'dispatch', 'deliver', 'refuse', 'edit', 'reject', 'cancel'];

/** The actions a user may offer for an order in `status`: allowed by the status AND by the user's permissions. */
export function allowedOrderActions(status: OrderStatus, has: (key: string) => boolean): OrderAction[] {
  return ORDER_ACTION_ORDER.filter((action) => FROM[action].includes(status) && KEYS[action].every((key) => has(key)));
}

/** Delivered with returned lines also needs returns.create. */
export const canReturnLines = (has: (key: string) => boolean): boolean => has('returns.create');

/** Phone → wa.me link digits (Egyptian local 01… becomes 201…). */
export function whatsappLink(phone: string): string {
  const digits = (phone || '').replace(/\D/g, '');
  const international = digits.startsWith('0') ? `20${digits.slice(1)}` : digits;
  return `https://wa.me/${international}`;
}
