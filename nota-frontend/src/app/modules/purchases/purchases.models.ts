/** Stage 20: shapes of /api/purchases and the supplier endpoints. Money is a number with 2 decimals. */

export interface PurchaseItem {
  _id: string;
  productId: string;
  name: string;
  code?: string;
  qty: number;
  unitPrice: number;
  lineTotal: number;
  lineCost: number;
  unitCost: number;
  newAverageCost?: number;
  returnedQty: number;
  returnedValue: number;
}

export interface Purchase {
  _id: string;
  number: string;
  supplierId: string;
  supplierName?: string;
  supplierInvoiceNo?: string;
  date: string;
  items: PurchaseItem[];
  subtotal: number;
  discountAmount: number;
  otherCosts: number;
  /** What we owe the supplier: with VAT, netTotal + vatAmount. */
  total: number;
  /** Stage 21 (absent for a purchase saved with VAT off): the net total (the stock value) and the recoverable VAT. */
  netTotal?: number;
  vatAmount?: number;
  vatRate?: number;
  vatRegistered?: boolean;
  /** Σ VAT already given back by purchase returns. */
  vatReturnedAmount?: number;
  paidAmount: number;
  boxId?: string;
  boxName?: string | null;
  pvId?: string;
  status: 'posted' | 'cancelled';
  cancelReason?: string;
  cancelledAt?: string;
  notes?: string;
  createdAt?: string;
}

export interface PurchaseReturnRow {
  _id: string;
  number: string;
  date: string;
  total: number;
  /** Stage 21: the net of the returned lines and the VAT given back with them (absent without VAT). */
  netTotal?: number;
  vatAmount?: number;
  reason?: string;
  items: { itemId: string; productId: string; name: string; qty: number; unitCost: number; value: number }[];
}

export interface PurchaseDetail extends Purchase {
  returns: PurchaseReturnRow[];
  payment: { _id: string; number: string; amount: number; status: string; boxId: string } | null;
}

export interface PurchasePage {
  data: Purchase[];
  pagination: { page: number; limit: number; totalItems: number; totalPages: number };
}

export interface PurchaseFilters {
  supplier?: string;
  from?: string;
  to?: string;
  status?: 'posted' | 'cancelled' | '';
  search?: string;
  page?: number;
}

export interface PurchasePayload {
  supplierId: string;
  supplierInvoiceNo?: string;
  date?: string;
  items: { productId: string; qty: number; unitPrice: number }[];
  discountAmount?: number;
  otherCosts?: number;
  paidAmount?: number;
  boxId?: string;
  notes?: string;
  /** Stage 21: only sent while VAT applies to the purchase date. vatAmount is the supplier's printed VAT (omitted = shop rate × net). */
  vatRegistered?: boolean;
  vatAmount?: number;
  /** Stage 21 review: the VAT the form showed; the server answers 409 VAT_CHANGED when its settings now give another figure. */
  expectedVat?: number;
}

export interface PurchaseCreated extends Purchase {
  pvNumber: string | null;
  supplierBalanceAfter: number;
}

export interface PurchaseReturnPayload {
  items: { itemId: string; qty: number }[];
  reason?: string;
  date?: string;
  refundAmount?: number;
  boxId?: string;
}

export interface SupplierPaymentPayload {
  amount: number;
  boxId?: string;
  date?: string;
  reference?: string;
  note?: string;
  confirmAdvance?: boolean;
}

export type StatementLineType = 'opening_balance' | 'purchase' | 'purchase_cancel' | 'payment' | 'payment_cancel' | 'purchase_return' | 'supplier_refund';

export interface StatementLine {
  date: string;
  type: StatementLineType;
  number: string | null;
  supplierInvoiceNo?: string | null;
  reference?: string | null;
  description: string;
  debit: number;
  credit: number;
  balance: number;
  docId?: string;
}

export interface SupplierStatement {
  supplier: { _id: string; name: string; paymentTermsDays: number | null };
  lines: StatementLine[];
  openingBalance: number;
  totals: { debit: number; credit: number; balance: number };
  /** Positive = we owe the supplier ("علينا"), negative = an advance ("لينا"). */
  balance: number;
  ledgerBalance: number;
  aging: { current: number; d1_30: number; d31_60: number; d61_90: number; d90plus: number; total: number; advance: number };
}

/** Product search row (GET /api/products/search). */
export interface PurchaseProduct {
  _id: string;
  name: string;
  code: string;
  inventoryCount: number;
  purchasePrice: number;
  retailPrice?: number;
}
