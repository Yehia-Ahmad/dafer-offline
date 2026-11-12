import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../../environments/environment';
import { BalanceSheet, BoxMovements, IncomeStatement, PartyBalances, TrialBalance } from '../../modules/accounting/reports/reports.models';
import { VatReturnDetail } from '../../modules/accounting/vat.models';
import { ShiftReport } from '../../modules/cashbox/cashbox.models';
import { CreditSaleView } from '../../modules/customer/utils/credit-sale-view.util';
import { ReturnLog } from '../../modules/returns/models/returns.model';
import { PrintRequest } from './print.service';
import { InvoiceHistoryRow, sellingResponseToCashSaleData, toCashSaleData, toCreditInvoiceData } from './print-adapters';
import { cashInvoice, creditInvoice, purchaseInvoice, receiptVoucher, voucher, VoucherData } from './documents/invoices';
import { cashReceipt, paymentReceipt, PaymentReceiptData, returnReceipt, shiftClose } from './documents/receipts';
import { boxMovements, financials, journalEntry, partyBalances, profitReport, ProfitReportData, trialBalance, vatReturn } from './documents/reports';
import { customerStatement, StatementLine, stockList, supplierStatement } from './documents/statements';
import { pick } from './print-kit';

const url = (path: string): string => `${environment.api_base_url}${path}`;
const n = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * Stage 23: loads what a document needs that its screen does not already hold (API reads, all permission-checked by the
 * backend like the screens) and returns the PrintRequest. Nothing is fetched until the user presses a print button.
 */
@Injectable({ providedIn: 'root' })
export class PrintDataService {
  private readonly http = inject(HttpClient);

  private get<T>(path: string, params?: Record<string, string | undefined>): Promise<T> {
    let httpParams = new HttpParams();
    for (const [key, value] of Object.entries(params || {})) if (value) httpParams = httpParams.set(key, value);
    return firstValueFrom(this.http.get<T>(url(path), { params: httpParams }));
  }

  /** The journal entry number of a document (voucher footer). null without permission or when there is none. */
  async journalNumber(documentNumber: string): Promise<string | null> {
    try {
      return (await this.get<{ journalNumber: string | null }>(`print/journal-ref/${encodeURIComponent(documentNumber)}`)).journalNumber;
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------ sales

  cashInvoice(row: InvoiceHistoryRow): PrintRequest {
    const data = toCashSaleData(row);
    return { number: data.number, build: (ctx) => cashInvoice(ctx, data) };
  }

  cashReceipt(row: InvoiceHistoryRow, extra: { paid?: number | null; change?: number | null } = {}): PrintRequest {
    const data = { ...toCashSaleData(row), ...extra };
    return { number: data.number, build: (ctx) => cashReceipt(ctx, data) };
  }

  /** The 80mm receipt of a sale that was just saved (the POST /api/sellings answer). */
  savedSaleReceipt(response: unknown, paymentMethod?: string | null): PrintRequest {
    const data = sellingResponseToCashSaleData(response, { paymentMethod });
    return { number: data.number, build: (ctx) => cashReceipt(ctx, data) };
  }

  /** The customer's balance before/after an invoice or document number, from their statement (stored running balance). */
  private async balancesAt(customerId: string, number: string, type: string): Promise<{ before: number | null; after: number | null }> {
    try {
      const statement = await this.get<{ lines: StatementLine[] }>(`customers/${customerId}/statement`);
      const line = statement.lines.find((entry) => entry.number === number && (!type || entry.type === type));
      return line ? { before: Math.round((line.balance - line.debit + line.credit) * 100) / 100, after: line.balance } : { before: null, after: null };
    } catch {
      return { before: null, after: null };
    }
  }

  async creditInvoice(entry: CreditSaleView, customerTaxNumber?: string | null): Promise<PrintRequest> {
    const balances = entry.customerId ? await this.balancesAt(entry.customerId, entry.number, 'invoice') : { before: null, after: null };
    const data = toCreditInvoiceData(entry, { customerTaxNumber, balanceBefore: balances.before, balanceAfter: balances.after });
    return { number: data.number, build: (ctx) => creditInvoice(ctx, data) };
  }

  // ------------------------------------------------------------ receipts and vouchers

  private async receiptData(customerId: string, number: string): Promise<PaymentReceiptData> {
    const result = await this.get<{
      receipt: { number: string; amount: number; paymentDate: string; note: string; kind: string; boxName: string | null; createdByName: string | null; createdAt: string; allocations: Array<{ amount: number; invoiceNumber: string | null; opening: boolean }> };
      customer: { name: string; phone: string } | null;
      balanceBefore: number | null;
      balanceAfter: number | null;
    }>(`customers/${customerId}/receipts/${encodeURIComponent(number)}/print-data`);
    return {
      number: result.receipt.number,
      date: result.receipt.createdAt || result.receipt.paymentDate,
      cashier: result.receipt.createdByName,
      customerName: result.customer?.name || '',
      customerPhone: result.customer?.phone || null,
      invoiceNumbers: result.receipt.allocations.map((row) => row.invoiceNumber).filter((value): value is string => Boolean(value)),
      amount: result.receipt.amount,
      paymentMethod: result.receipt.boxName,
      balanceBefore: result.balanceBefore,
      balanceAfter: result.balanceAfter,
      note: result.receipt.note || null,
      downPayment: result.receipt.kind === 'down_payment',
    };
  }

  /** The customer payment receipt: 80mm (PrPaymentReceipt) or the A5 receipt voucher (PrReceiptVoucher). */
  async paymentReceipt(customerId: string, number: string, format: '80mm' | 'A5'): Promise<PrintRequest> {
    const data = await this.receiptData(customerId, number);
    if (format === '80mm') return { number, build: (ctx) => paymentReceipt(ctx, data) };
    const journalNumber = await this.journalNumber(number);
    return { number, build: (ctx) => receiptVoucher(ctx, { ...data, journalNumber }) };
  }

  /** A return receipt from a ReturnLog (the returns list and the screens that just created one). */
  async returnReceipt(log: ReturnLog): Promise<PrintRequest> {
    let balances: { before: number | null; after: number | null } = { before: null, after: null };
    if (log.returnType === 'credit' && log.customerName) {
      try {
        // the credit invoice names its customer: find the statement line of this return by number
        const invoice = await this.get<{ customerId?: string; customer?: string | { _id: string } }>(`credit-sales/${log.invoiceId}`);
        const customer = invoice.customerId || (typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?._id);
        if (customer) balances = await this.balancesAt(customer, log.number, 'return');
      } catch {
        balances = { before: null, after: null };
      }
    }
    const credit = log.returnType === 'credit';
    return {
      number: log.number,
      build: (ctx) =>
        returnReceipt(ctx, {
          number: log.number,
          date: log.createdAt || log.returnDate,
          invoiceNumber: log.invoiceNumber || null,
          invoiceKind: log.returnType,
          customerName: log.customerName,
          cashier: (log as ReturnLog & { createdByName?: string }).createdByName || null,
          items: log.items.map((item) => ({ name: item.productName, quantity: item.quantity, unitPrice: item.price, total: item.total, reason: item.returnReason || null })),
          total: log.finalReturnedAmount,
          settlement: credit ? pick(ctx, 'خصم من رصيد العميل', 'Deducted from the customer balance') : pick(ctx, 'رد نقدي', 'Cash refund'),
          balanceBefore: balances.before,
          balanceAfter: balances.after,
          stockNote: pick(ctx, 'رجع للمخزون', 'Returned to stock'),
        }),
    };
  }

  /** The newest return of an invoice (called right after creating one; the create call does not answer with the return number for credit). */
  async latestReturnOf(invoiceId: string): Promise<ReturnLog | null> {
    const list = await this.get<{ data: ReturnLog[] }>('returns', { invoiceId, limit: '50' });
    const rows = [...(list.data || [])].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return rows[0] || null;
  }

  voucher(data: VoucherData): PrintRequest {
    return { number: data.number, build: (ctx) => voucher(ctx, data) };
  }

  // ------------------------------------------------------------ shifts

  shiftClose(report: ShiftReport, depositBoxName?: string | null): PrintRequest {
    const lineLabels: Record<string, [string, string]> = {
      float: ['رصيد أول الوردية', 'Opening float'], sales: ['مبيعات كاش', 'Cash sales'], receipts: ['تحصيل من عملاء', 'Customer collections'],
      transfersIn: ['تحويلات واردة', 'Incoming transfers'], refunds: ['مرتجعات كاش', 'Cash refunds'], expenses: ['مصروفات', 'Expenses'],
      transfersOut: ['تحويلات صادرة', 'Outgoing transfers'], payouts: ['صرف أرصدة عملاء', 'Customer payouts'], drawings: ['سحب المالك', 'Owner drawings'],
      supplierPayments: ['سداد موردين', 'Supplier payments'], vatPayments: ['سداد ضريبة', 'VAT payments'], supplierRefunds: ['استرداد من موردين', 'Supplier refunds'],
    };
    const minus = new Set(['refunds', 'expenses', 'transfersOut', 'payouts', 'drawings', 'supplierPayments', 'vatPayments']);
    const always = new Set(['float', 'sales', 'receipts', 'refunds', 'expenses']);
    return {
      number: report.number,
      build: (ctx) =>
        shiftClose(ctx, {
          number: report.number,
          boxName: report.boxName || '',
          cashier: report.userName || report.closedByName || '',
          openedAt: report.openedAt,
          closedAt: report.closedAt,
          summary: report.salesSummary
            ? [
                { label: pick(ctx, 'فواتير كاش', 'Cash invoices'), count: report.salesSummary.cash.count, amount: report.salesSummary.cash.total },
                { label: pick(ctx, 'فواتير آجل (للعلم)', 'Credit invoices (for information)'), count: report.salesSummary.credit.count, amount: report.salesSummary.credit.total },
                { label: pick(ctx, 'مرتجعات', 'Returns'), count: report.salesSummary.returns.count, amount: report.salesSummary.returns.total },
                { label: pick(ctx, 'خصومات', 'Discounts'), amount: report.salesSummary.discounts },
              ]
            : [],
          movement: report.lines
            .filter((line) => always.has(line.key) || line.amount !== 0)
            .map((line) => ({ label: pick(ctx, (lineLabels[line.key] || [line.key, line.key])[0], (lineLabels[line.key] || [line.key, line.key])[1]), amount: line.amount, sign: line.key === 'float' ? ('' as const) : minus.has(line.key) ? ('−' as const) : ('+' as const) })),
          expected: n(report.expected),
          counted: n(report.counted),
          difference: n(report.difference),
          differenceNote: report.differenceNote,
          deposit: report.depositAmount ? { boxName: depositBoxName || '', amount: report.depositAmount } : null,
          remaining: report.remaining,
        }),
    };
  }

  // ------------------------------------------------------------ purchases and suppliers

  async purchaseInvoice(purchaseId: string): Promise<PrintRequest> {
    const result = await this.get<{
      purchase: {
        number: string; date: string; supplierInvoiceNo?: string; items: Array<{ code?: string; name: string; qty: number; unitPrice: number; lineTotal: number }>;
        subtotal: number; discountAmount: number; otherCosts: number; total: number; netTotal?: number; vatAmount?: number; vatRate?: number; paidAmount: number;
        status: string; cancelReason?: string; cancelledAt?: string; cancelledByName?: string; notes?: string; createdByName?: string;
      };
      supplier: { name: string; phone: string; address: string; taxNumber: string } | null;
      boxName: string | null;
      balanceBefore: number | null;
      balanceAfter: number | null;
      journal: { number: string; lines: Array<{ accountNameAr: string | null; accountNameEn: string | null; debit: number; credit: number }> | null } | null;
    }>(`purchases/${purchaseId}/print-data`);
    const purchase = result.purchase;
    const data = {
      number: purchase.number,
      date: purchase.date,
      supplierInvoiceNo: purchase.supplierInvoiceNo || null,
      supplier: result.supplier || { name: '' },
      items: purchase.items.map((item) => ({ code: item.code, name: item.name, quantity: item.qty, unitCost: item.unitPrice, total: item.lineTotal })),
      subtotal: purchase.subtotal,
      discount: purchase.discountAmount || 0,
      otherCosts: purchase.otherCosts || 0,
      vat: purchase.vatAmount && purchase.vatRate !== undefined ? { rate: purchase.vatRate, amount: purchase.vatAmount, netAmount: n(purchase.netTotal) } : null,
      total: purchase.total,
      paid: purchase.paidAmount || 0,
      paidBoxName: result.boxName,
      remaining: Math.round((purchase.total - (purchase.paidAmount || 0)) * 100) / 100,
      balanceBefore: result.balanceBefore,
      balanceAfter: result.balanceAfter,
      notes: purchase.notes || null,
      receivedBy: purchase.createdByName || null,
      cancelled: purchase.status === 'cancelled' ? { reason: purchase.cancelReason || null, at: purchase.cancelledAt || null, by: purchase.cancelledByName || null } : null,
    };
    return {
      number: purchase.number,
      build: (ctx) =>
        purchaseInvoice(ctx, {
          ...data,
          journal: result.journal ? { number: result.journal.number, lines: result.journal.lines ? result.journal.lines.map((line) => ({ name: (ctx.lang === 'en' ? line.accountNameEn || line.accountNameAr : line.accountNameAr || line.accountNameEn) || '', debit: line.debit, credit: line.credit })) : null } : null,
        }),
    };
  }

  /**
   * The A5 SR voucher of a supplier refund (money the supplier gave back). The refund row comes from the refunds list (amount, box, note,
   * status); the supplier balance before/after is the statement line's own running balance (positive = we owe).
   */
  async supplierRefundVoucher(supplierId: string, supplierName: string, line: { number?: string | null; balance: number; credit: number; debit: number }): Promise<PrintRequest> {
    const number = line.number || '';
    const list = await this.get<{ data: Array<{ number: string; amount: number; date: string; boxName: string | null; note?: string; status: string }> }>(`suppliers/${supplierId}/refunds`);
    const refund = list.data.find((row) => row.number === number);
    if (!refund) throw new Error('SR_NOT_FOUND');
    const journalNumber = await this.journalNumber(number);
    return this.voucher({
      type: 'SR', number, date: refund.date, amount: refund.amount, party: supplierName,
      reason: refund.note || null, method: refund.boxName,
      balanceBefore: Math.round((line.balance - line.credit + line.debit) * 100) / 100, balanceAfter: line.balance, journalNumber,
      ...(refund.status === 'cancelled' ? { cancelled: {} } : {}),
    });
  }

  async supplierStatement(supplierId: string, from: string | null, to: string | null, info: { contact?: string | null; phone?: string | null } = {}): Promise<PrintRequest> {
    const result = await this.get<{ supplier: { name: string }; lines: StatementLine[]; openingBalance: number; totals: { debit: number; credit: number }; balance: number }>(`suppliers/${supplierId}/statement`, { from: from || undefined, to: to || undefined });
    return {
      build: (ctx) =>
        supplierStatement(ctx, {
          supplier: { name: result.supplier.name, contact: info.contact, phone: info.phone },
          from,
          to,
          lines: result.lines,
          totals: { openingBalance: result.openingBalance, debit: result.totals.debit, credit: result.totals.credit, balance: result.balance },
        }),
    };
  }

  // ------------------------------------------------------------ customers

  async customerStatement(customerId: string, from: string | null, to: string | null, extra: { taxNumber?: string | null } = {}): Promise<PrintRequest> {
    const result = await this.get<{
      customer: { name: string; phone: string; creditLimit?: number | null; taxNumber?: string | null };
      lines: StatementLine[];
      totals: { openingBalance: number; debit: number; credit: number; balance: number };
      aging: { current: number; days1to30: number; days31to60: number; over60: number; total: number };
    }>(`customers/${customerId}/statement`, { from: from || undefined, to: to || undefined });
    return {
      build: (ctx) =>
        customerStatement(ctx, {
          customer: { ...result.customer, taxNumber: result.customer.taxNumber || extra.taxNumber || null },
          from,
          to,
          lines: result.lines,
          totals: result.totals,
          aging: result.aging,
        }),
    };
  }

  // ------------------------------------------------------------ stock, reports

  async stockList(categoryId: string | null, categoryLabel: string): Promise<PrintRequest> {
    const result = await this.get<{ products: Array<{ code: string; name: string; categoryName: string; inventoryCount: number; lowStock: boolean; purchasePrice?: number }> }>('products/print-data', { categoryId: categoryId || undefined });
    return { build: (ctx) => stockList(ctx, { rows: result.products, categoryLabel: categoryLabel || pick(ctx, 'الكل', 'All'), preparedBy: ctx.printedBy }) };
  }

  profitReport(data: ProfitReportData): PrintRequest {
    return { build: (ctx) => profitReport(ctx, data) };
  }

  async journalEntry(entryId: string): Promise<PrintRequest> {
    const entry = await this.get<{
      number: string; date: string; type: string; source?: { type: string; number?: string | null }; memo?: string; totalDebit: number; totalCredit: number;
      reversalOf?: string | null; reversedBy?: string | null; createdByName?: string | null;
      lines: Array<{ accountCode?: string; accountName?: string; accountNameAr?: string; accountNameEn?: string; memo?: string; debit: number; credit: number; partyName?: string }>;
    }>(`accounting/journal/${entryId}`);
    const numberOf = async (id: string | null | undefined): Promise<string | null> => {
      if (!id) return null;
      try {
        return (await this.get<{ number: string }>(`accounting/journal/${id}`)).number;
      } catch {
        return null;
      }
    };
    const [reverses, reversedBy] = await Promise.all([numberOf(entry.reversalOf), numberOf(entry.reversedBy)]);
    return {
      build: (ctx) => {
        const typeLabels: Record<string, [string, string]> = { auto: ['تلقائي من مستند', 'Automatic, from a document'], reversal: ['قيد عكسي', 'Reversal'], opening: ['أرصدة افتتاحية', 'Opening balances'], manual: ['قيد يدوي', 'Manual entry'], closing: ['قيد إقفال', 'Closing entry'], legacy_reversal: ['قيد عكسي', 'Reversal'] };
        const label = typeLabels[entry.type] || [entry.type, entry.type];
        const related: string[] = [];
        if (reverses) related.push(`${pick(ctx, 'عكس للقيد', 'Reverses entry')} ${reverses}`);
        if (reversedBy) related.push(`${pick(ctx, 'عُكس بالقيد', 'Reversed by entry')} ${reversedBy}`);
        return journalEntry(ctx, {
          number: entry.number,
          date: entry.date,
          typeLabel: pick(ctx, label[0], label[1]),
          sourceNumber: entry.source?.number || null,
          memo: entry.memo || null,
          lines: entry.lines.map((line) => ({
            code: line.accountCode || '',
            name: (ctx.lang === 'en' ? line.accountNameEn || line.accountName : line.accountNameAr || line.accountName) || '',
            memo: line.memo || null,
            debit: line.debit,
            credit: line.credit,
          })),
          totalDebit: entry.totalDebit,
          totalCredit: entry.totalCredit,
          related,
          preparedBy: entry.createdByName || null,
        });
      },
    };
  }

  financials(income: IncomeStatement | null, balance: BalanceSheet | null, trialBalanced?: boolean | null): PrintRequest {
    return { build: (ctx) => financials(ctx, { income, balance, trialBalanced }) };
  }
  trialBalance(report: TrialBalance): PrintRequest {
    return { build: (ctx) => trialBalance(ctx, report) };
  }
  boxMovements(report: BoxMovements): PrintRequest {
    return { build: (ctx) => boxMovements(ctx, report) };
  }
  partyBalances(report: PartyBalances): PrintRequest {
    return { build: (ctx) => partyBalances(ctx, report) };
  }
  vatReturn(detail: VatReturnDetail): PrintRequest {
    return { build: (ctx) => vatReturn(ctx, detail) };
  }

}
