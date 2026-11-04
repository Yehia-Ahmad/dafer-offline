import { CreditInvoicePrintData } from '../components/customer-details/credit-invoice-print.util';

/**
 * One credit invoice as the screens show it (moved unchanged from CustomerDetailsComponent in Stage 10 so the
 * customer page and the /credit-sales list read GET responses the same way). Refund fields are display only.
 */
export type CreditSaleStatusView = 'pending' | 'partially_paid' | 'paid' | 'reactionary' | 'unknown';

export type CreditSaleView = {
  id: string;
  invoiceId: string;
  customerId: string;
  customerName: string;
  customerPhone: string;
  sellingDate: string | null;
  dueDate: string | null;
  status: CreditSaleStatusView;
  subtotal: number;
  discountAmount: number | null;
  discountPercentage: number | null;
  shippingFees: number | null;
  totalPrice: number;
  paidAmount: number;
  remainingAmount: number;
  itemCount: number;
  totalQuantity: number;
  notes: string;
  paymentsCount: number;
  items: Array<{
    id: string;
    productId: string;
    productName: string;
    productCode: string;
    categoryName: string;
    quantity: number;
    pricePerEach: number;
    totalPrice: number;
  }>;
  payments: Array<{
    id: string;
    amount: number;
    paymentDate: string | null;
    note: string;
  }>;
  refunds: Array<{
    id: string;
    refundDate: string | null;
    note: string;
    totalQuantity: number;
    totalAmount: number;
    returnedPaidAmount: number;
    reallocatedPaidAmount: number;
    items: Array<{ productId: string; productName: string; productCode: string; quantity: number; totalPrice: number }>;
  }>;
  refundedAmount: number;
};

const toNumber = (value: unknown): number => {
  const normalized = Number(value);
  return Number.isFinite(normalized) ? normalized : 0;
};
const toNumberOrNull = (value: unknown): number | null => {
  const normalized = Number(value);
  return Number.isFinite(normalized) ? normalized : null;
};
const toOptionalNonNegativeNumber = (value: unknown): number | null => {
  const normalized = toNumberOrNull(value);
  return normalized === null ? null : Math.max(0, normalized);
};
const toOptionalBoundedPercentage = (value: unknown): number | null => {
  const normalized = toOptionalNonNegativeNumber(value);
  return normalized === null ? null : Math.min(100, normalized);
};
const roundCurrency = (value: number): number => Number((value || 0).toFixed(2));
const toInteger = (value: unknown): number => {
  const normalized = Number(value);
  return Number.isFinite(normalized) ? Math.max(0, Math.floor(normalized)) : 0;
};
const calculateDiscountPercentageFromAmount = (subtotal: number, discountAmount: number | null): number | null => {
  if (discountAmount === null || subtotal <= 0) return null;
  return roundCurrency(Math.min((discountAmount / subtotal) * 100, 100));
};

export function normalizeCreditSaleStatus(value: unknown): CreditSaleStatusView {
  if (value === 'pending' || value === 'partially_paid' || value === 'paid' || value === 'reactionary') return value;
  if (value === 'partiallyPaid') return 'partially_paid';
  if (value === 'Reactionary') return 'reactionary';
  return 'unknown';
}

function normalizeItems(source: any): CreditSaleView['items'] {
  if (!Array.isArray(source)) return [];
  return source
    .map((item: any, index: number) => {
      const quantity = toInteger(item?.productQuantity ?? item?.productQuentity);
      const productName = String(item?.productName || '').trim();
      const productCode = String(item?.productCode || '').trim();
      const categoryName = String(item?.categoryName || '').trim();
      if (!productName && !productCode && !categoryName) return null;
      return {
        id: String(item?._id || item?.productId || `${index}`),
        productId: String(item?.productId || '').trim(),
        productName,
        productCode,
        categoryName,
        quantity,
        pricePerEach: toNumber(item?.productPricePerEach),
        totalPrice: toNumber(item?.totalPrice)
      };
    })
    .filter((item): item is CreditSaleView['items'][number] => item !== null);
}

function normalizePayments(source: any): CreditSaleView['payments'] {
  if (!Array.isArray(source)) return [];
  return source
    .map((payment: any, index: number) => {
      const amount = toNumber(payment?.amount);
      const paymentDate = payment?.paymentDate ? String(payment.paymentDate) : null;
      const note = String(payment?.note || '').trim();
      if (amount <= 0 && !paymentDate && !note) return null;
      return { id: String(payment?._id || `${index}`), amount, paymentDate, note };
    })
    .filter((item): item is CreditSaleView['payments'][number] => item !== null);
}

function normalizeRefunds(source: any): CreditSaleView['refunds'] {
  if (!Array.isArray(source)) return [];
  return source.map((refund: any, index: number) => ({
    id: String(refund?._id || `${index}`),
    refundDate: refund?.refundDate ? String(refund.refundDate) : null,
    note: String(refund?.note || '').trim(),
    totalQuantity: toInteger(refund?.totalQuantity),
    totalAmount: toNumber(refund?.totalAmount),
    returnedPaidAmount: toNumber(refund?.returnedPaidAmount),
    reallocatedPaidAmount: toNumber(refund?.reallocatedPaidAmount),
    items: (Array.isArray(refund?.items) ? refund.items : []).map((item: any) => ({
      productId: String(item?.productId || ''),
      productName: String(item?.productName || ''),
      productCode: String(item?.productCode || ''),
      quantity: toInteger(item?.quantity),
      totalPrice: toNumber(item?.totalPrice)
    }))
  }));
}

/** Same normalization CustomerDetailsComponent used before Stage 10 (plus customer and refund fields). */
export function toCreditSaleView(source: any): CreditSaleView | null {
  if (!source) return null;

  const id = String(source._id || source.id || source.invoiceId || '').trim();
  const invoiceId = String(source.invoiceId || source._id || source.id || '').trim();
  if (!id && !invoiceId) return null;

  const items = normalizeItems(source.items);
  const subtotal = toNumber(source.subtotal ?? items.reduce((sum, item) => sum + toNumber(item.totalPrice), 0));
  const discountAmountValue = toOptionalNonNegativeNumber(source.discountAmount);
  const discountPercentageValue =
    toOptionalBoundedPercentage(source.discountPercentage) ??
    calculateDiscountPercentageFromAmount(subtotal, discountAmountValue);
  const shippingFeesValue = toOptionalNonNegativeNumber(source.shippingFees);
  const discountPercentage = discountPercentageValue ?? 0;
  const discountAmount = discountAmountValue ?? roundCurrency((subtotal * discountPercentage) / 100);
  const shippingFees = shippingFeesValue ?? 0;
  const totalPrice = toNumber(source.totalPrice ?? Math.max(subtotal - discountAmount + shippingFees, 0));
  const paidAmount = toNumber(source.paidAmount);
  const remainingAmount = toNumber(source.remainingAmount ?? Math.max(totalPrice - paidAmount, 0));
  const payments = normalizePayments(source.payments);

  return {
    id: id || invoiceId,
    invoiceId: invoiceId || id,
    customerId: String(source.customerId?._id || source.customerId || source.customer?._id || source.customer || ''),
    customerName: String(source.customerName || ''),
    customerPhone: String(source.customerPhone || ''),
    sellingDate: source.sellingDate ? String(source.sellingDate) : null,
    dueDate: source.dueDate ? String(source.dueDate) : null,
    status: normalizeCreditSaleStatus(source.status),
    subtotal,
    discountAmount: discountAmountValue ?? discountAmount,
    discountPercentage: discountPercentageValue,
    shippingFees: shippingFeesValue,
    totalPrice,
    paidAmount,
    remainingAmount,
    itemCount: toInteger(source.itemCount ?? source.items?.length),
    totalQuantity: toInteger(source.totalQuantity),
    notes: String(source.notes || '').trim(),
    paymentsCount: payments.length,
    items,
    payments,
    refunds: normalizeRefunds(source.refunds),
    refundedAmount: toNumber(source.refundedAmount)
  };
}

/** Overdue = due date before today with money still owed (display only). */
export function isCreditSaleOverdue(entry: Pick<CreditSaleView, 'dueDate' | 'remainingAmount'>, now = new Date()): boolean {
  if (!entry.dueDate || entry.remainingAmount <= 0) return false;
  const dueDate = new Date(entry.dueDate);
  if (Number.isNaN(dueDate.getTime())) return false;
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  dueDate.setHours(0, 0, 0, 0);
  return dueDate < today;
}

/** The printable shape the credit-invoice print util expects (moved unchanged from CustomerDetailsComponent). */
export function toCreditInvoicePrintData(
  entry: CreditSaleView,
  customerName: string,
  customerPhone: string,
  statusLabel: string
): CreditInvoicePrintData {
  return {
    id: entry.id,
    invoiceId: entry.invoiceId || entry.id,
    invoiceNumber: entry.invoiceId || entry.id,
    customerName: customerName || '',
    customerPhone: customerPhone || '',
    sellingDate: entry.sellingDate,
    dueDate: entry.dueDate,
    statusLabel,
    itemCount: entry.itemCount,
    totalQuantity: entry.totalQuantity,
    subtotal: entry.subtotal,
    discountPercentage: entry.discountPercentage,
    shippingFees: entry.shippingFees,
    totalPrice: entry.totalPrice,
    paidAmount: entry.paidAmount,
    remainingAmount: entry.remainingAmount,
    items: entry.items.map((item) => ({
      id: item.id,
      productCode: item.productCode,
      productName: item.productName,
      categoryName: item.categoryName,
      quantity: item.quantity,
      unitPrice: item.pricePerEach,
      totalPrice: item.totalPrice
    }))
  };
}

/** Pill class for a credit invoice status (tokens only). */
export function creditSaleStatusPill(status: CreditSaleStatusView, overdue: boolean): string {
  if (overdue) return 'nota-pill nota-pill--overdue';
  switch (status) {
    case 'paid': return 'nota-pill nota-pill--ok';
    case 'partially_paid': return 'nota-pill nota-pill--info';
    case 'pending': return 'nota-pill nota-pill--due';
    case 'reactionary': return 'nota-pill nota-pill--neutral';
    default: return 'nota-pill nota-pill--neutral';
  }
}
