// Stage 22: the shapes of GET /api/reports/* (nota-backend src/reports/financial.js). Every amount comes from the ledger.

export type ReportTab = 'income' | 'balance' | 'trial' | 'boxes' | 'parties';
export type ReportKey = 'income-statement' | 'balance-sheet' | 'trial-balance' | 'box-movements' | 'party-balances';
export type BalanceSide = 'debit' | 'credit';

export interface ReportPeriod { from: string; to: string }

export interface IncomeRow {
  id: string;
  kind: 'line' | 'group' | 'subtotal' | 'total' | 'percent';
  accountId?: string;
  code?: string;
  nameAr: string;
  nameEn: string;
  /** +1 adds to the result, -1 is a deduction (shown in brackets). */
  sign: number;
  amount: number;
  previous: number | null;
  change: number | null;
  isZero: boolean;
  children?: IncomeRow[];
}

export interface IncomeStatement {
  report: 'income-statement';
  period: ReportPeriod;
  comparison: ReportPeriod | null;
  shopName: string;
  currency: string;
  rows: IncomeRow[];
  summary: { sales: number; netSales: number; cogs: number; grossProfit: number; totalExpenses: number; otherIncome: number; netProfit: number; grossMarginPct: number };
  check: { ledgerNetProfit: number; difference: number };
}

export interface SheetRow {
  id: string;
  kind: 'line' | 'group';
  accountId?: string;
  code?: string;
  nameAr: string;
  nameEn: string;
  /** Credit-side sections show credit - debit, assets debit - credit; owner drawings are negative (a deduction). */
  amount: number;
  balance: number;
  side: BalanceSide;
  absBalance: number;
  opposite: boolean;
  isZero: boolean;
  children?: SheetRow[];
}

export interface BalanceSheet {
  report: 'balance-sheet';
  asOf: string;
  shopName: string;
  currency: string;
  sections: { assets: SheetRow; liabilities: SheetRow; equity: SheetRow };
  totals: { assets: number; liabilities: number; equity: number; liabilitiesAndEquity: number };
  periodProfit: number;
  check: { assets: number; liabilitiesAndEquity: number; difference: number };
}

export interface TrialRow {
  id: string;
  kind: 'line' | 'group';
  accountId?: string;
  code: string;
  nameAr: string;
  nameEn: string;
  openingDebit: number; openingCredit: number;
  movementDebit: number; movementCredit: number;
  closingDebit: number; closingCredit: number;
  isZero: boolean;
  children?: TrialRow[];
}

export interface TrialBalance {
  report: 'trial-balance';
  period: ReportPeriod;
  shopName: string;
  currency: string;
  rows: TrialRow[];
  totals: Record<'openingDebit' | 'openingCredit' | 'movementDebit' | 'movementCredit' | 'closingDebit' | 'closingCredit', number>;
  balanced: boolean;
}

export interface BoxKindRow { key: string; ar: string; en: string; in: number; out: number }
export interface BoxMovementRow {
  boxId: string; accountId: string; name: string; type: string; isMain: boolean; isActive: boolean; accountCode: string | null;
  opening: number; in: number; out: number; closing: number; byKind: BoxKindRow[];
}
export interface BoxMovements {
  report: 'box-movements';
  period: ReportPeriod;
  shopName: string;
  currency: string;
  boxes: BoxMovementRow[];
  totals: { opening: number; in: number; out: number; closing: number; byKind: BoxKindRow[] };
}

export interface AgingBuckets { current: number; d1_30: number; d31_60: number; d61_90: number; d90plus: number; total: number }
export interface PartyRow {
  partyId: string; name: string; phone: string | null; balance: number; side: BalanceSide; absBalance: number; opposite: boolean;
  aging: AgingBuckets; advance: number; isZero: boolean;
}
export interface PartyTotals { count: number; balance: number; current: number; d1_30: number; d31_60: number; d61_90: number; d90plus: number; advance: number; openTotal: number }
export interface PartyBalances {
  report: 'party-balances';
  asOf: string;
  shopName: string;
  currency: string;
  customers?: { rows: PartyRow[]; totals: PartyTotals };
  suppliers?: { rows: PartyRow[]; totals: PartyTotals };
}

export const AGING_KEYS = ['current', 'd1_30', 'd31_60', 'd61_90', 'd90plus'] as const;

export type ReportQuery = Partial<{ from: string; to: string; asOf: string; compare: boolean; type: 'customers' | 'suppliers' }>;
