// Stage 23: maps what the screens already hold (API responses and their view models) to the print documents'
// data. Pure functions. Every number is the STORED value; nothing is recomputed here.

import { CreditSaleView } from '../../modules/customer/utils/credit-sale-view.util';
import { InvoiceVatInfo, toInvoiceVat } from '../../modules/shared/vat/vat-print';
import { CreditInvoiceData } from './documents/invoices';
import { CashSaleData } from './documents/receipts';

export type InvoiceHistoryItem = {
  /** Stage 21: "معفى من الضريبة" (absent = taxable). */
  vatExempt?: boolean;
  id: string;
  invoiceId: string;
  productId: string;
  productCode: string;
  productName: string;
  categoryName: string;
  customerName: string;
  customerPhone: string;
  sellingDate: string | null;
  quantity: number | null;
  returnedQuantity?: number | null;
  unitPrice: number | null;
  totalPrice: number | null;
};

export type InvoiceHistoryRow = {
  id: string;
  /** Stage 14: who created the invoice (sent by the backend with auth on). Display only. */
  createdByName?: string | null;
  invoiceId: string;
  invoiceNumber: string;
  customerName: string;
  customerPhone: string;
  // customerAddress: string;
  sellingDate: string | null;
  itemCount: number | null;
  totalQuantity: number | null;
  subtotal: number | null;
  discountAmount: number | null;
  discountPercentage: number | null;
  shippingFees: number | null;
  totalPrice: number | null;
  netTotal?: number | null;
  /** Stage 21: the VAT stored on the invoice (absent for an invoice saved with VAT off). */
  vat?: InvoiceVatInfo;
  /** Stage 21: the customer's tax number, when the invoice has one (B2B). */
  customerTaxNumber?: string | null;
  status?: 'active' | 'cancelled' | string;
  cancellationReason?: string | null;
  /** Display only: the box that paid a cancelled cash sale's refund. */
  cancelRefundAmount?: number | null;
  cancelRefundBoxName?: string | null;
  items: InvoiceHistoryItem[];
  /** Display only (Stage 10 detail panel); not used by the print. */
  refundStatus?: 'none' | 'partial' | 'full' | string;
  refundedAmount?: number | null;
  refunds?: Array<{ id: string; refundDate: string | null; totalAmount: number | null; items: Array<{ productName: string; quantity: number | null }> }>;
};


export function buildFallbackInvoiceNumber(id: string): string {
  const normalizedId = String(id || '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
  return normalizedId ? `INV-${normalizedId.slice(-6)}` : 'INV-0000';
}

/** A cash invoice of the invoice history, as the cash receipt / cash invoice templates take it. */
export function toCashSaleData(row: InvoiceHistoryRow, options: { paymentMethod?: string | null } = {}): CashSaleData {
  return {
    number: row.invoiceNumber || buildFallbackInvoiceNumber(row.invoiceId || row.id),
    date: row.sellingDate,
    cashier: row.createdByName || null,
    customerName: row.customerName || null,
    customerPhone: row.customerPhone || null,
    customerTaxNumber: row.customerTaxNumber || null,
    items: row.items.map((item) => ({
      code: item.productCode,
      name: item.productName,
      quantity: Number(item.quantity ?? 0),
      unitPrice: Number(item.unitPrice ?? 0),
      total: Number(item.totalPrice ?? 0),
      ...(item.vatExempt ? { vatExempt: true } : {}),
    })),
    subtotal: Number(row.subtotal ?? row.totalPrice ?? 0),
    discount: Number(row.discountAmount ?? 0),
    discountPercent: row.discountPercentage ?? null,
    shipping: Number(row.shippingFees ?? 0),
    // The STORED invoice total (what the customer was charged), never the net after returns: the returns are their own rows below it.
    total: Number(row.totalPrice ?? 0),
    ...(Number(row.refundedAmount ?? 0) > 0
      ? { returned: Number(row.refundedAmount), netAfterReturn: Number(row.netTotal ?? Number(row.totalPrice ?? 0) - Number(row.refundedAmount)) }
      : {}),
    ...(row.vat ? { vat: row.vat as InvoiceVatInfo } : {}),
    paymentMethod: options.paymentMethod ?? null,
    ...(row.status === 'cancelled' ? { cancelled: { reason: row.cancellationReason || null } } : {}),
  };
}

/** A credit invoice (the customer page and the credit list share CreditSaleView). */
export function toCreditInvoiceData(
  entry: CreditSaleView,
  options: { customerTaxNumber?: string | null; balanceBefore?: number | null; balanceAfter?: number | null } = {}
): CreditInvoiceData {
  return {
    number: entry.number || entry.invoiceId || entry.id,
    date: entry.sellingDate,
    dueDate: entry.dueDate,
    cashier: entry.createdByName || null,
    customerName: entry.customerName,
    customerPhone: entry.customerPhone,
    customerTaxNumber: options.customerTaxNumber || null,
    note: entry.notes || null,
    items: entry.items.map((item) => ({
      code: item.productCode,
      name: item.productName,
      quantity: item.quantity,
      unitPrice: item.pricePerEach,
      total: item.totalPrice,
      ...(item.vatExempt ? { vatExempt: true } : {}),
    })),
    subtotal: entry.subtotal,
    discount: Number(entry.discountAmount ?? 0),
    discountPercent: entry.discountPercentage ?? null,
    shipping: Number(entry.shippingFees ?? 0),
    total: entry.totalPrice,
    paid: entry.paidAmount,
    remaining: entry.remainingAmount,
    payments: entry.payments.map((payment) => ({
      // The user's own note, or nothing: the template writes "دفعة" / "Payment" in the print language.
      label: payment.note || '',
      kind: payment.source === 'down_payment' ? ('down_payment' as const) : ('payment' as const),
      date: payment.paymentDate,
      amount: payment.amount,
    })),
    balanceBefore: options.balanceBefore ?? null,
    balanceAfter: options.balanceAfter ?? null,
    ...(entry.vat ? { vat: entry.vat } : {}),
    ...(entry.status === 'cancelled' ? { cancelled: { reason: entry.cancellationReason || null } } : {}),
  };
}

/** The answer of POST /api/sellings (a just-saved cash sale) as the cash receipt takes it. */
export function sellingResponseToCashSaleData(response: any, options: { cashier?: string | null; paymentMethod?: string | null } = {}): CashSaleData {
  const items: any[] = Array.isArray(response?.items) ? response.items : [];
  const vat = toInvoiceVat(response);
  return {
    number: response?.number || buildFallbackInvoiceNumber(response?.invoiceId || response?._id),
    date: response?.sellingDate ?? null,
    cashier: response?.createdByName || options.cashier || null,
    customerName: response?.customerName || null,
    customerPhone: response?.customerPhone || null,
    items: items.map((item) => ({
      code: item.productCode || '',
      name: item.productName,
      quantity: Number(item.productQuantity ?? item.productQuentity ?? item.quantity ?? 0),
      unitPrice: Number(item.productPricePerEach ?? item.price ?? 0),
      total: Number(item.totalPrice ?? item.total ?? 0),
      ...(item.vatExempt === true ? { vatExempt: true } : {}),
    })),
    subtotal: items.reduce((sum, item) => sum + Number(item.totalPrice ?? item.total ?? 0), 0),
    discount: Number(response?.discountAmount ?? 0),
    shipping: Number(response?.shippingFees ?? 0),
    total: Number(response?.totalPrice ?? 0),
    ...(vat ? { vat } : {}),
    paymentMethod: options.paymentMethod ?? null,
  };
}
