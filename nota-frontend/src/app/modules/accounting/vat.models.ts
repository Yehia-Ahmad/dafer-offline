/** Stage 21: shapes of /api/vat/returns. Money is a number with 2 decimals; a period is "YYYY-MM". */

export type VatReturnStatus = 'open' | 'filed' | 'paid' | 'partial';

export interface VatReturnRow {
  period: string;
  status: VatReturnStatus;
  /** Output VAT: sales VAT less sales-return VAT of the period. */
  output: number;
  /** Input VAT: purchases + expenses less purchase returns. */
  input: number;
  /** The credit carried in from the previous filed return. */
  carriedIn: number;
  /** output - input - carriedIn: positive = payable, negative = a credit carried forward. */
  net: number;
  /** min(output, input + carriedIn), signed: positive = Dr 22 / Cr 115; negative (returns above sales) = Dr 115 / Cr 22. */
  offset: number;
  payable: number;
  credit: number;
  paid: number;
  remaining: number;
  returnId: string | null;
  number: string | null;
  filedAt: string | null;
}

export interface VatReturnList {
  data: VatReturnRow[];
  /** The only month that may be filed next (returns are filed in month order, no gaps). */
  nextPeriod: string;
  settings: { enabled: boolean; rate: number; pricesIncludeVat: boolean; startDate: string | null };
}

export interface VatLine {
  kind: string;
  number: string | null;
  date: string;
  net: number;
  vat: number;
  sourceType: string;
  sourceId: string;
}

export type VatLineGroup = 'sales' | 'returns' | 'purchases' | 'purchaseReturns' | 'expenses';

export const VAT_LINE_GROUPS: readonly VatLineGroup[] = ['sales', 'returns', 'purchases', 'purchaseReturns', 'expenses'];

export interface VatPaymentRow {
  _id: string;
  number: string;
  date: string;
  amount: number;
  boxId: string;
  boxName: string | null;
  reference: string | null;
  note: string | null;
}

export interface VatReturnDetail extends VatReturnRow {
  lines: Record<VatLineGroup, VatLine[]>;
  payments: VatPaymentRow[];
  canFile: boolean;
  canUnfile: boolean;
  /** What a filing posts: Dr 22 / Cr 115 = offset (reversed when the offset is negative). Null once filed. */
  preview: { debit: { code: string; amount: number }; credit: { code: string; amount: number }; payable: number; credit_carried: number } | null;
}

export interface VatPayPayload {
  amount: number;
  boxId?: string;
  date?: string;
  reference?: string;
  note?: string;
}
