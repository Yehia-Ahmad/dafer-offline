import { ALL_PERMISSIONS, ROLE_PERMISSIONS } from '../../core/auth/testing/auth-fixtures';
import { estimateCollect, returnsEverything } from './collect-estimate';
import { allowedOrderActions, canReturnLines, whatsappLink } from './order-actions';
import { fillWhatsappTemplate, whatsappConfirmLink } from './order-whatsapp';
import { OrderDetail, OrderStatus, PaymentMethod, PaymentStatus } from './orders.models';

describe('order actions by status and permission (Online Stage 4)', () => {
  const has = (list: readonly string[]) => (key: string) => list.includes(key);
  const everything = has(ALL_PERMISSIONS);

  it('follows the status table of the brief', () => {
    const table: Record<OrderStatus, string[]> = {
      new: ['confirm', 'edit', 'reject'],
      confirmed: ['prepare', 'dispatch', 'edit', 'reject', 'cancel'],
      preparing: ['dispatch', 'edit', 'cancel'],
      // Online Stage 5A: the pickup-only statuses offer nothing for a delivery order
      ready_for_pickup: [],
      picked_up: [],
      out_for_delivery: ['deliver', 'refuse'],
      delivered: [],
      cancelled: [],
      rejected: [],
      refused: [],
    };
    for (const [status, actions] of Object.entries(table)) {
      expect(allowedOrderActions(status as OrderStatus, everything)).withContext(status).toEqual(actions as never);
    }
  });

  it('dispatch, deliver and refuse also need the permission of the document they create', () => {
    const base = ['orders.view', 'orders.manage', 'orders.dispatch'];
    expect(allowedOrderActions('confirmed', has(base))).not.toContain('dispatch');
    expect(allowedOrderActions('confirmed', has([...base, 'credit.create']))).toContain('dispatch');
    expect(allowedOrderActions('out_for_delivery', has(base))).toEqual([]);
    expect(allowedOrderActions('out_for_delivery', has([...base, 'credit.collect']))).toEqual(['deliver']);
    expect(allowedOrderActions('out_for_delivery', has([...base, 'returns.create']))).toEqual(['refuse']);
    expect(allowedOrderActions('new', has(['orders.view']))).toEqual([]);
  });

  it('the cashier template can run the whole flow; the accountant none of it', () => {
    const cashier = has(ROLE_PERMISSIONS.cashier);
    expect(allowedOrderActions('new', cashier)).toEqual(['confirm', 'edit', 'reject']);
    expect(allowedOrderActions('confirmed', cashier)).toContain('dispatch');
    expect(allowedOrderActions('out_for_delivery', cashier)).toEqual(['deliver', 'refuse']);
    expect(canReturnLines(cashier)).toBeTrue();
    expect(allowedOrderActions('new', has(ROLE_PERMISSIONS.accountant))).toEqual([]);
  });

  it('whatsapp link: Egyptian local numbers become international', () => {
    expect(whatsappLink('01012345678')).toBe('https://wa.me/201012345678');
    expect(whatsappLink('+20 101 234 5678')).toBe('https://wa.me/201012345678');
  });
});

/** Online Stage 5A: the table after pickup and wallet transfers (delivery × pickup, cash on delivery × wallet). */
describe('order actions by fulfillment and payment (Online Stage 5A)', () => {
  const has = (list: readonly string[]) => (key: string) => list.includes(key);
  const everything = has(ALL_PERMISSIONS);
  const pickup = (status: OrderStatus, paymentMethod: PaymentMethod = 'cod', verified = false) => ({ status, fulfillment: 'pickup' as const, paymentMethod, payment: { status: (paymentMethod === 'cod' ? null : verified ? 'verified' : 'unpaid') as PaymentStatus } });
  const delivery = (status: OrderStatus, paymentMethod: PaymentMethod = 'cod', verified = false) => ({ status, fulfillment: 'delivery' as const, paymentMethod, payment: { status: (paymentMethod === 'cod' ? null : verified ? 'verified' : 'unpaid') as PaymentStatus } });

  it('pickup + cash: confirm → prepare → ready → picked up; cancel also while ready; no courier actions', () => {
    const table: Record<string, string[]> = {
      new: ['confirm', 'edit', 'reject'],
      confirmed: ['prepare', 'edit', 'reject', 'cancel'],
      preparing: ['ready', 'edit', 'cancel'],
      ready_for_pickup: ['pickup', 'cancel'],
      picked_up: [], cancelled: [], rejected: [], refused: [], out_for_delivery: [], delivered: [],
    };
    for (const [status, actions] of Object.entries(table)) expect(allowedOrderActions(pickup(status as OrderStatus), everything)).withContext(status).toEqual(actions as never);
  });

  it('wallet orders offer "verify the transfer" until it is verified; the invoice actions wait for it', () => {
    expect(allowedOrderActions(delivery('new', 'instapay'), everything)).toEqual(['verifyPayment', 'confirm', 'edit', 'reject']);
    expect(allowedOrderActions(delivery('confirmed', 'instapay'), everything)).toEqual(['verifyPayment', 'prepare', 'edit', 'reject', 'cancel']);
    expect(allowedOrderActions(delivery('confirmed', 'instapay', true), everything)).toEqual(['prepare', 'dispatch', 'edit', 'reject', 'cancel']);
    expect(allowedOrderActions(pickup('ready_for_pickup', 'vodafone_cash'), everything)).toEqual(['verifyPayment', 'cancel']);
    expect(allowedOrderActions(pickup('ready_for_pickup', 'vodafone_cash', true), everything)).toEqual(['pickup', 'cancel']);
    expect(allowedOrderActions(delivery('out_for_delivery', 'instapay', true), everything)).toEqual(['deliver', 'refuse']);
    // verifying is not offered for cash orders, nor after delivery
    expect(allowedOrderActions(delivery('confirmed'), everything)).not.toContain('verifyPayment');
    expect(allowedOrderActions(delivery('out_for_delivery', 'instapay', false), everything)).not.toContain('verifyPayment');
  });

  it('permissions by document: wallet send-out needs sales.create; cash on delivery send-out credit.create; delivery collects only for cash on delivery', () => {
    const base = ['orders.view', 'orders.manage', 'orders.dispatch'];
    expect(allowedOrderActions(delivery('confirmed', 'instapay', true), has(base))).not.toContain('dispatch');
    expect(allowedOrderActions(delivery('confirmed', 'instapay', true), has([...base, 'sales.create']))).toContain('dispatch');
    expect(allowedOrderActions(delivery('confirmed', 'instapay', true), has([...base, 'credit.create']))).not.toContain('dispatch');
    expect(allowedOrderActions(delivery('confirmed'), has([...base, 'sales.create']))).not.toContain('dispatch');
    expect(allowedOrderActions(delivery('out_for_delivery', 'instapay', true), has(base))).toEqual(['deliver']);
    expect(allowedOrderActions(delivery('out_for_delivery'), has(base))).toEqual([]);
    expect(allowedOrderActions(pickup('ready_for_pickup'), has(base))).toEqual(['cancel']);
    expect(allowedOrderActions(pickup('ready_for_pickup'), has([...base, 'sales.create']))).toEqual(['pickup', 'cancel']);
    expect(allowedOrderActions(pickup('preparing'), has(['orders.view', 'orders.dispatch']))).toEqual([]);
    expect(allowedOrderActions(pickup('preparing', 'instapay'), has(['orders.view', 'orders.manage']))).toEqual(['verifyPayment', 'ready', 'edit', 'cancel']);
  });

  it('an order without the new fields (placed before Stage 5A) is a delivery order paid on delivery', () => {
    expect(allowedOrderActions({ status: 'confirmed' }, everything)).toEqual(['prepare', 'dispatch', 'edit', 'reject', 'cancel']);
  });
});

describe('WhatsApp confirmation link builder (Online Stage 5A)', () => {
  const vars = { name: 'منى', number: 'W-000007', total: 230.5, deliveryTime: 'خلال 24 ساعة' };

  it('fills {الاسم} {رقم الطلب} {الإجمالي} {مدة التوصيل}, every occurrence, and leaves other braces alone', () => {
    expect(fillWhatsappTemplate('أهلا {الاسم}! طلب {رقم الطلب} بـ {الإجمالي} جنيه، التوصيل {مدة التوصيل}. شكرًا {الاسم} {غير معروف}', vars))
      .toBe('أهلا منى! طلب W-000007 بـ 230.5 جنيه، التوصيل خلال 24 ساعة. شكرًا منى {غير معروف}');
  });

  it('the total has at most two decimals and no trailing zeros; an empty delivery time (pickup) becomes a dash', () => {
    expect(fillWhatsappTemplate('{الإجمالي}', { ...vars, total: 230 })).toBe('230');
    expect(fillWhatsappTemplate('{الإجمالي}', { ...vars, total: 230.256 })).toBe('230.26');
    expect(fillWhatsappTemplate('{مدة التوصيل}', { ...vars, deliveryTime: '  ' })).toBe('—');
  });

  it('the link is wa.me/<international phone>?text=<encoded message>', () => {
    const link = whatsappConfirmLink('01012345678', 'أهلا {الاسم} {رقم الطلب}', vars);
    expect(link.startsWith('https://wa.me/201012345678?text=')).toBeTrue();
    expect(decodeURIComponent(link.split('?text=')[1])).toBe('أهلا منى W-000007');
    expect(link).not.toContain(' ');
    expect(whatsappConfirmLink('+20 101 234 5678', 'x', vars)).toBe('https://wa.me/201012345678?text=x');
  });
});

describe('amount to collect with returned lines (Online Stage 4)', () => {
  const line = (productId: string, unitPrice: number, qty: number, vat = 0, vatExempt = false) => ({ productId, name: productId, retailPrice: unitPrice, discountPercentage: 0, unitPrice, vat, vatExempt, qty, lineTotal: unitPrice * qty, inventoryCount: 10, reservedByOthers: 0 });
  const order = (extra: Partial<OrderDetail>): Pick<OrderDetail, 'items' | 'total' | 'vatIncluded' | 'vatRate'> => ({ items: [line('a', 100, 4)], total: 430, ...extra });

  it('no VAT: the refused lines come off, the delivery fee stays', () => {
    expect(estimateCollect(order({}), {})).toBe(430);
    expect(estimateCollect(order({}), { a: 1 })).toBe(330);
    expect(estimateCollect(order({}), { a: 3 })).toBe(130);
  });

  it('VAT included: the VAT is inside the line prices, so the same arithmetic', () => {
    const o = order({ vatRate: 14, vatIncluded: true, items: [line('a', 100, 4, 49.12)] });
    expect(estimateCollect(o, { a: 2 })).toBe(230);
  });

  it('VAT excluded: the refused lines come back with their VAT share', () => {
    // 4 × 100 + 14 % VAT on the lines (56) + 30 delivery (+4.2 VAT on it) = 490.2 ; 1 unit back = 100 + 14
    const o = { items: [line('a', 100, 4, 56)], total: 490.2, vatRate: 14, vatIncluded: false } as Pick<OrderDetail, 'items' | 'total' | 'vatIncluded' | 'vatRate'>;
    expect(estimateCollect(o, { a: 1 })).toBe(376.2);
  });

  it('an exempt line carries no VAT share; quantities are clamped to the ordered quantity', () => {
    const o = { items: [line('a', 100, 2, 0, true), line('b', 50, 1, 7)], total: 257, vatRate: 14, vatIncluded: false } as Pick<OrderDetail, 'items' | 'total' | 'vatIncluded' | 'vatRate'>;
    expect(estimateCollect(o, { a: 1 })).toBe(157);
    expect(estimateCollect(o, { a: 99 })).toBe(57);
  });

  it('returning every unit of every line is a refusal', () => {
    const o = order({ items: [line('a', 100, 2), line('b', 50, 1)] });
    expect(returnsEverything(o, { a: 2 })).toBeFalse();
    expect(returnsEverything(o, { a: 2, b: 1 })).toBeTrue();
    expect(returnsEverything(o, { a: 5, b: 5 })).toBeTrue();
  });
});
