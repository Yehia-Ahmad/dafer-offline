import { buildCustomerStatement } from './customer-statement.util';
import { toCreditSaleView } from './credit-sale-view.util';

describe('buildCustomerStatement (Stage 10, frontend only)', () => {
  const view = (source: any) => toCreditSaleView(source)!;

  it('debits invoices, credits payments, debits money a refund released; closes at Σ remaining', () => {
    // Invoice A: 2,000 net after a refund; paid 1,500 then the refund released 300 (handed back) → remaining 800.
    const a = view({
      _id: 'A', sellingDate: '2026-09-01', totalPrice: 2000, paidAmount: 1200, remainingAmount: 800,
      payments: [{ _id: 'a1', amount: 1000, paymentDate: '2026-09-01' }, { _id: 'a2', amount: 500, paymentDate: '2026-09-10' }],
      refunds: [{ _id: 'r1', refundDate: '2026-09-20', totalAmount: 500, returnedPaidAmount: 300, reallocatedPaidAmount: 0, items: [{ productName: 'كشاف', quantity: 2 }] }],
      items: [],
    });
    // Invoice B: 1,000, nothing paid; a no-money refund appears as an info row.
    const b = view({
      _id: 'B', sellingDate: '2026-10-01', totalPrice: 1000, paidAmount: 0, remainingAmount: 1000, payments: [],
      refunds: [{ _id: 'r2', refundDate: '2026-10-05', totalAmount: 200, returnedPaidAmount: 0, reallocatedPaidAmount: 0, items: [{ productName: 'لمبة', quantity: 1 }] }],
      items: [],
    });

    const statement = buildCustomerStatement([b, a]);
    expect(statement.rows.map((row) => [row.kind, row.debit, row.credit, row.balance])).toEqual([
      ['invoice', 2000, 0, 2000],
      ['payment', 0, 1000, 1000],
      ['payment', 0, 500, 500],
      ['refund', 300, 0, 800],
      ['invoice', 1000, 0, 1800],
      ['refund', 0, 0, 1800],
    ]);
    expect(statement.rows[0].afterReturns).toBeTrue();
    expect(statement.rows[3].detail).toBe('كشاف × 2');
    expect(statement.totalDebit).toBe(3300);
    expect(statement.totalCredit).toBe(1500);
    expect(statement.balance).toBe(a.remainingAmount + b.remainingAmount);
  });

  it('a refund reallocated to another invoice nets to zero across the two invoices', () => {
    const source = view({ _id: 'S', sellingDate: '2026-09-01', totalPrice: 0, paidAmount: 0, remainingAmount: 0,
      payments: [{ amount: 400, paymentDate: '2026-09-01' }],
      refunds: [{ refundDate: '2026-09-05', totalAmount: 400, returnedPaidAmount: 0, reallocatedPaidAmount: 400, items: [] }], items: [] });
    const target = view({ _id: 'T', sellingDate: '2026-09-02', totalPrice: 1000, paidAmount: 400, remainingAmount: 600,
      payments: [{ amount: 400, paymentDate: '2026-09-05', note: 'من مرتجع' }], refunds: [], items: [] });
    expect(buildCustomerStatement([source, target]).balance).toBe(600);
  });

  it('empty history', () => {
    expect(buildCustomerStatement([])).toEqual({ rows: [], totalDebit: 0, totalCredit: 0, balance: 0 });
  });
});
