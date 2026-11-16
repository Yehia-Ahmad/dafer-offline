import { ALL_PERMISSIONS, ROLE_PERMISSIONS } from '../../core/auth/testing/auth-fixtures';
import { estimateCollect, returnsEverything } from './collect-estimate';
import { allowedOrderActions, canReturnLines, whatsappLink } from './order-actions';
import { OrderDetail, OrderStatus } from './orders.models';

describe('order actions by status and permission (Online Stage 4)', () => {
  const has = (list: readonly string[]) => (key: string) => list.includes(key);
  const everything = has(ALL_PERMISSIONS);

  it('follows the status table of the brief', () => {
    const table: Record<OrderStatus, string[]> = {
      new: ['confirm', 'edit', 'reject'],
      confirmed: ['prepare', 'dispatch', 'edit', 'reject', 'cancel'],
      preparing: ['dispatch', 'edit', 'cancel'],
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
