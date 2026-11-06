// Stage 19: shapes of /api/cashbox, /api/shifts, /api/expenses and /api/devices (nota-backend).

export type BoxType = 'cash' | 'wallet' | 'bank';

export interface OpenShiftInfo {
  _id: string;
  number: string;
  userId: string | null;
  userName: string | null;
  openedAt: string;
  openingFloat: number;
}

export interface CashBox {
  _id: string;
  name: string;
  type: BoxType;
  accountId: string;
  accountCode?: string;
  isMain: boolean;
  deviceId: string | null;
  deviceName: string | null;
  shiftsEnabled: boolean;
  isActive: boolean;
  sortOrder: number;
  /** Only with cashbox.view. */
  balance?: number;
  openShift: OpenShiftInfo | null;
}

export interface BoxesResponse {
  data: CashBox[];
  /** Σ of the active cash-type boxes (the dashboard's "كاش في الخزنة"). */
  cashTotal: number;
}

export interface ShiftSummary {
  _id: string;
  number: string;
  boxId: string;
  boxName?: string | null;
  userId: string | null;
  userName: string | null;
  openedAt: string;
  openingFloat: number;
  openingBalance: number;
  closedAt: string | null;
  closedByName: string | null;
  expected: number | null;
  counted: number | null;
  difference: number | null;
  differenceNote: string | null;
  depositBoxId: string | null;
  depositAmount: number;
  status: 'open' | 'closed';
}

export type ShiftLineKey = 'float' | 'sales' | 'receipts' | 'transfersIn' | 'refunds' | 'expenses' | 'transfersOut' | 'payouts' | 'drawings';

export interface ShiftReport extends ShiftSummary {
  lines: { key: ShiftLineKey; amount: number }[];
  /** What stays in the drawer after the deposit (closed shifts). */
  remaining: number | null;
  boxName?: string | null;
}

export interface BoxDetail extends CashBox {
  shifts: ShiftSummary[];
}

export interface LedgerLine {
  entryId: string;
  number: string;
  date: string;
  source?: { type: string; id: string; number: string | null };
  memo?: string;
  debit: number;
  credit: number;
  balance: number;
  side?: 'debit' | 'credit';
  absBalance?: number;
}

export interface BoxLedger {
  openingBalance: number;
  balance: number;
  side: 'debit' | 'credit';
  absBalance: number;
  lines: LedgerLine[];
}

export interface PaymentBox {
  _id: string;
  name: string;
  type: BoxType;
  isMain: boolean;
  shiftsEnabled: boolean;
  isDefault: boolean;
  openShift: { _id: string; number: string; userName: string | null; openedAt: string } | null;
  needsShift: boolean;
}

export interface PaymentBoxesResponse {
  defaultBoxId: string;
  mainBox: { _id: string; name: string } | null;
  deviceId: string | null;
  data: PaymentBox[];
}

export interface DeviceRow {
  deviceId: string;
  name: string;
  role: 'main' | 'client';
  lastSeenAt: string;
  isCurrent: boolean;
  boxId: string | null;
  boxName: string | null;
}

export interface DevicesResponse {
  currentDeviceId: string | null;
  data: DeviceRow[];
}

export interface TransferRow {
  _id: string;
  number: string;
  fromBoxId: string;
  toBoxId: string;
  fromBoxName: string | null;
  toBoxName: string | null;
  amount: number;
  date: string;
  note?: string;
  kind: 'transfer' | 'shift_deposit';
  fromBefore?: number;
  fromAfter?: number;
  toBefore?: number;
  toAfter?: number;
  status: 'posted' | 'cancelled';
  cancelReason?: string;
}

export interface DrawingRow {
  _id: string;
  number: string;
  boxId: string;
  boxName: string | null;
  amount: number;
  date: string;
  note?: string;
  status: 'posted' | 'cancelled';
}

export interface ExpenseCategory {
  _id: string;
  code: string;
  nameAr: string;
  nameEn: string;
  isSystem: boolean;
  isActive: boolean;
  hasLines?: boolean;
}

export interface ExpenseRow {
  _id: string;
  number: string;
  date: string;
  accountId: string;
  categoryName: string | null;
  categoryCode: string | null;
  amount: number;
  boxId: string;
  boxName: string | null;
  note?: string;
  status: 'posted' | 'cancelled';
  cancelReason?: string;
  createdByName?: string;
}

export interface CategoryTotal {
  accountId: string;
  code?: string;
  nameAr?: string;
  nameEn?: string;
  total: number;
  count: number;
}

export interface ExpensesResponse {
  month: string;
  data: ExpenseRow[];
  total: number;
  count: number;
  byCategory: CategoryTotal[];
  previous: { month: string; total: number; count: number; byCategory: CategoryTotal[] };
  pagination: { page: number; limit: number; totalItems: number; totalPages: number };
}

export interface CustomerCredit {
  balance: number;
  credit: number;
  openItems: number;
  unapplied: number;
  applicable: number;
}

/** Error codes the cash endpoints send in `error.code`. */
export type CashErrorCode =
  | 'BOX_INACTIVE' | 'NO_OPEN_SHIFT' | 'BOX_NOT_ALLOWED' | 'INSUFFICIENT_BALANCE' | 'BOX_NOT_EMPTY' | 'BOX_HAS_OPEN_SHIFT'
  | 'DEVICE_ALREADY_BOUND' | 'FLOAT_MISMATCH' | 'SHIFT_ALREADY_OPEN' | 'NOTE_REQUIRED' | 'INVALID_DEPOSIT' | 'EXCEEDS_CREDIT'
  | 'SAME_BOX' | 'SHIFT_CLOSED' | 'SHIFTS_DISABLED' | 'INVALID_CATEGORY' | 'CATEGORY_HAS_LINES' | 'SYSTEM_CATEGORY';
