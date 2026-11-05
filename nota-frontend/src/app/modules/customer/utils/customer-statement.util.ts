import { CreditSaleView } from './credit-sale-view.util';

/**
 * "كشف الحساب" for one customer, computed only from GET /customers/:id (credit invoices with payments and refunds).
 *
 * How the backend books money (creditSale.controller): a refund lowers the invoice's totalPrice; paid money the refund
 * frees is either handed back (returnedPaidAmount) or pushed as a payment onto another open invoice of the same
 * customer (reallocatedPaidAmount). So, per invoice, remaining = totalPrice − Σpayments + returned + reallocated.
 *
 * Rows: invoice → debit its current (net) total · payment → credit · refund that freed paid money → debit the freed
 * amount (the matching payment, if reallocated, appears on the other invoice) · other refunds → info row (0/0).
 * The closing balance therefore equals Σ remainingAmount. Cash sales are not part of the customer balance.
 */
export type StatementRowKind = 'opening' | 'invoice' | 'payment' | 'refund' | 'cancel';

export interface StatementRow {
  kind: StatementRowKind;
  date: string | null;
  invoiceId: string;
  number?: string | null;
  description?: string;
  /** Extra text: item list of a refund, the payment note, "after returns" flag. */
  detail: string;
  debit: number;
  credit: number;
  balance: number;
  /** The invoice's total already excludes returned items. */
  afterReturns?: boolean;
}

export interface CustomerStatement {
  rows: StatementRow[];
  totalDebit: number;
  totalCredit: number;
  balance: number;
}

const round = (value: number): number => Number((value || 0).toFixed(2));
const time = (value: string | null): number => {
  const t = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(t) ? t : 0;
};
const ORDER: Record<StatementRowKind, number> = { opening: 0, invoice: 1, refund: 2, payment: 3, cancel: 4 };

export function buildCustomerStatement(invoices: CreditSaleView[]): CustomerStatement {
  const raw: Omit<StatementRow, 'balance'>[] = [];

  for (const invoice of invoices) {
    raw.push({
      kind: 'invoice', date: invoice.sellingDate, invoiceId: invoice.invoiceId,
      detail: '', debit: round(invoice.totalPrice), credit: 0, afterReturns: invoice.refunds.length > 0,
    });
    for (const payment of invoice.payments) {
      raw.push({ kind: 'payment', date: payment.paymentDate, invoiceId: invoice.invoiceId, detail: payment.note, debit: 0, credit: round(payment.amount) });
    }
    for (const refund of invoice.refunds) {
      raw.push({
        kind: 'refund', date: refund.refundDate, invoiceId: invoice.invoiceId,
        detail: refund.items.map((item) => `${item.productName} × ${item.quantity}`).join('، '),
        debit: round(refund.returnedPaidAmount + refund.reallocatedPaidAmount), credit: 0,
      });
    }
  }

  raw.sort((a, b) => time(a.date) - time(b.date) || ORDER[a.kind] - ORDER[b.kind]);

  let balance = 0;
  let totalDebit = 0;
  let totalCredit = 0;
  const rows = raw.map((row) => {
    balance = round(balance + row.debit - row.credit);
    totalDebit = round(totalDebit + row.debit);
    totalCredit = round(totalCredit + row.credit);
    return { ...row, balance };
  });

  return { rows, totalDebit, totalCredit, balance };
}
