/** Small pure helpers shared by the phone screens (Online Stage 6A). */

/** "منذ 5 دقائق" / "5 minutes ago" from an ISO date, to the minute (never "now": a new row says 1 minute). */
export function timeAgo(iso: string | Date, lang: string, now: number = Date.now()): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const rtf = new Intl.RelativeTimeFormat(lang === 'ar' ? 'ar-EG' : 'en', { numeric: 'always' });
  const minutes = Math.max(1, Math.round((now - then) / 60_000));
  if (minutes < 60) return rtf.format(-minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (hours < 24) return rtf.format(-hours, 'hour');
  return rtf.format(-Math.round(hours / 24), 'day');
}

/** The existing status-pill variants (ok / due / overdue / info / neutral) mapped to the three phone pill colours. */
export function mobilePillClass(variant: string): string {
  switch (variant) {
    case 'ok': return 'm-pill m-pill--ok';
    case 'due':
    case 'overdue': return 'm-pill m-pill--warn';
    default: return 'm-pill m-pill--muted';
  }
}

/** First letter of a name for the round avatar. */
export function initialOf(name: string | null | undefined): string {
  return (name ?? '').trim().charAt(0) || '؟';
}

/** The status steps of the order page (MobOrder): جديد · بيتجهز · في الطريق (or جاهز للاستلام) · اتسلّم. */
export interface OrderSteps {
  /** i18n keys of the four labels. */
  keys: string[];
  /** How many of the four segments are done (0 when the order was closed without being delivered). */
  done: number;
  /** cancelled / rejected / refused: no steps, the status pill says why. */
  closed: boolean;
}

export function orderSteps(order: { status: string; fulfillment?: string }): OrderSteps {
  const pickup = order.fulfillment === 'pickup';
  const keys = [
    'mobile.order.steps.new',
    'mobile.order.steps.preparing',
    pickup ? 'mobile.order.steps.ready' : 'mobile.order.steps.onTheWay',
    'mobile.order.steps.done',
  ];
  switch (order.status) {
    case 'new': return { keys, done: 1, closed: false };
    case 'confirmed':
    case 'preparing': return { keys, done: 2, closed: false };
    case 'ready_for_pickup':
    case 'out_for_delivery': return { keys, done: 3, closed: false };
    case 'delivered':
    case 'picked_up': return { keys, done: 4, closed: false };
    default: return { keys, done: 0, closed: true };
  }
}

/**
 * The real invoice rule (the design's "لما تقبل، نوتة بتعمل فاتورة بيع" is wrong for Nota):
 * the invoice is made when the order leaves with the courier, or at pickup.
 */
export function invoiceHintKey(order: { status: string; fulfillment?: string }): string | null {
  const open = ['new', 'confirmed', 'preparing', 'ready_for_pickup'].includes(order.status);
  if (!open) return null;
  return order.fulfillment === 'pickup' ? 'mobile.order.invoiceHintPickup' : 'mobile.order.invoiceHintDelivery';
}
