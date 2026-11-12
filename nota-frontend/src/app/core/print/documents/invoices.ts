// Stage 23: the A4 invoices (PrCashInvoice, PrCreditInvoice, PrPurchaseInvoice) and the A5 vouchers
// (PrReceiptVoucher, PrPaymentVoucher: PV, EX, DR, CP, VP, SR).

import { InvoiceVatInfo, vatPrintLabels } from '../../../modules/shared/vat/vat-print';
import { amountInWords, escapeHtml, formatDate, formatMoney, formatPercent, formatQty, localizeDigits } from '../print-format';
import { Cell, PrintContext, PrintDocument, a4Header, a4Page, cancelBox, copyMark, generatedText, pick, printedByText, row, closing, signatures, table } from '../print-kit';
import { CashSaleData, PaymentReceiptData, SaleLine } from './receipts';

const money = (ctx: PrintContext, value: number | null | undefined): string => formatMoney(value ?? 0, ctx.lang);
const currency = (ctx: PrintContext): string => pick(ctx, 'ج.م', 'EGP');
const ltr = (value: string): string => `<span class="ltr n">${escapeHtml(value)}</span>`;

function itemRows(ctx: PrintContext, items: SaleLine[], vat: InvoiceVatInfo | undefined): string {
  return items
    .map((line, index): string => {
      const cells: Cell[] = [
        { html: localizeDigits(String(index + 1), ctx.lang), numeric: true },
        { html: escapeHtml(line.code || ''), code: true },
        `${escapeHtml(line.name)}${vat && line.vatExempt ? ` <small>(${vatPrintLabels(ctx.lang).exempt})</small>` : ''}`,
        { html: formatQty(line.quantity, ctx.lang), numeric: true },
        { html: money(ctx, line.unitPrice), numeric: true },
        { html: money(ctx, line.total), numeric: true, bold: true },
      ];
      return row(cells);
    })
    .join('');
}

const itemHead = (ctx: PrintContext) => [
  { label: '#', width: 36 },
  { label: pick(ctx, 'الكود', 'Code'), width: 110 },
  { label: pick(ctx, 'الصنف', 'Item') },
  { label: pick(ctx, 'الكمية', 'Qty'), numeric: true, width: 70 },
  { label: pick(ctx, 'سعر الوحدة', 'Unit price'), numeric: true, width: 100 },
  { label: pick(ctx, 'الإجمالي', 'Total'), numeric: true, width: 110 },
];

const infoBox = (label: string, lines: string[]): string =>
  `<div class="box col keep" style="gap:4px"><span class="lbl">${escapeHtml(label)}</span>${lines.join('')}</div>`;

const totalsRow = (label: string, value: string, attr = ''): string => `<tr${attr ? ` ${attr}` : ''}><td>${label}</td><td class="n">${value}</td></tr>`;
const grandRow = (label: string, value: string, attr = ''): string =>
  `<tr class="grand"${attr ? ` ${attr}` : ''}><td style="font-weight:800">${label}</td><td class="n" style="font-weight:800;font-size:16px">${value}</td></tr>`;

function vatTotals(ctx: PrintContext, vat: InvoiceVatInfo | undefined): string {
  if (!vat) return '';
  const labels = vatPrintLabels(ctx.lang);
  return `${totalsRow(pick(ctx, 'الصافي قبل الضريبة', 'Net before VAT'), money(ctx, vat.netAmount), 'data-vat-net')}${totalsRow(`${labels.vat} ${formatPercent(vat.rate, ctx.lang)}`, money(ctx, vat.vatAmount), 'data-vat-amount')}`;
}

function vatCustomerLine(ctx: PrintContext, vat: InvoiceVatInfo | undefined, taxNumber: string | null | undefined): string {
  return vat && taxNumber ? `<span style="font-size:13px">${vatPrintLabels(ctx.lang).customerTaxNumber}: ${ltr(taxNumber)}</span>` : '';
}

// ---------------------------------------------------------------- PrCashInvoice

/** PrCashInvoice: cash sale invoice, A4. With VAT it is a "فاتورة ضريبية". */
export function cashInvoice(ctx: PrintContext, data: CashSaleData): PrintDocument {
  const labels = vatPrintLabels(ctx.lang);
  const title = data.vat ? labels.taxInvoice : pick(ctx, 'فاتورة بيع نقدي', 'Cash sale invoice');
  const paidInFull = data.paid === null || data.paid === undefined || data.paid >= data.total;
  const body = a4Page(`
  ${a4Header(ctx, { title, no: data.number, date: formatDate(data.date, ctx.lang), extraLabel: data.cashier ? pick(ctx, 'الكاشير', 'Cashier') : '', extra: data.cashier || '' })}
  ${cancelBox(ctx, data.cancelled)}
  <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px">
    ${infoBox(pick(ctx, 'العميل', 'Customer'), [
      `<span style="font-size:15px;font-weight:700">${escapeHtml(data.customerName || pick(ctx, 'عميل نقدي', 'Cash customer'))}</span>`,
      data.customerPhone ? `<span class="n" style="font-size:13px;direction:ltr;text-align:${ctx.lang === 'ar' ? 'right' : 'left'}">${escapeHtml(data.customerPhone)}</span>` : '',
      vatCustomerLine(ctx, data.vat, data.customerTaxNumber),
    ])}
    ${infoBox(pick(ctx, 'الدفع', 'Payment'), [
      `<span style="font-size:15px;font-weight:700">${escapeHtml(data.paymentMethod || pick(ctx, 'نقدي', 'Cash'))}${paidInFull ? ` · ${pick(ctx, 'مدفوعة بالكامل', 'paid in full')}` : ''}</span>`,
    ])}
  </div>
  ${table(itemHead(ctx), itemRows(ctx, data.items, data.vat))}
  <div class="row keep" style="justify-content:space-between;align-items:flex-start;gap:20px">
    <div class="box col grow" style="gap:4px"><span class="lbl">${pick(ctx, 'المبلغ بالحروف', 'Amount in words')}</span><span style="font-size:14px;font-weight:700" data-words>${escapeHtml(amountInWords(data.total, ctx.lang))}</span></div>
    <table class="t" style="width:300px"><tbody>
      ${totalsRow(pick(ctx, 'الإجمالي', 'Subtotal'), money(ctx, data.subtotal))}
      ${totalsRow(`${pick(ctx, 'الخصم', 'Discount')}${data.discountPercent ? ` (${formatPercent(data.discountPercent, ctx.lang)})` : ''}`, money(ctx, data.discount))}
      ${data.shipping ? totalsRow(pick(ctx, 'التوصيل', 'Delivery'), money(ctx, data.shipping)) : ''}
      ${vatTotals(ctx, data.vat)}
      ${grandRow(data.vat ? pick(ctx, 'الإجمالي شامل الضريبة', 'Total incl. VAT') : pick(ctx, 'الصافي', 'Net total'), `${money(ctx, data.total)} ${currency(ctx)}`, 'data-total')}
      ${data.returned ? `${totalsRow(pick(ctx, 'مرتجع', 'Returned'), money(ctx, data.returned), 'data-returned')}${totalsRow(pick(ctx, 'الصافي بعد المرتجع', 'Net after returns'), `<b>${money(ctx, data.netAfterReturn ?? data.total - data.returned)}</b>`, 'data-net-after-return')}` : ''}
      ${data.paid !== null && data.paid !== undefined ? totalsRow(pick(ctx, 'المدفوع', 'Paid'), money(ctx, data.paid), 'data-paid') : ''}
      ${data.change !== null && data.change !== undefined && data.change > 0 ? totalsRow(pick(ctx, 'الباقي للزبون', 'Change'), money(ctx, data.change), 'data-change') : ''}
    </tbody></table>
  </div>
  <div class="grow"></div>
  ${closing(ctx, [{ who: pick(ctx, 'البائع', 'Seller'), line: pick(ctx, 'الاسم والتوقيع', 'Name and signature') }, { who: pick(ctx, 'المستلم', 'Receiver'), line: pick(ctx, 'الاسم والتوقيع', 'Name and signature') }], true)}`);
  return { paper: 'A4', title: data.number, body, pageNumbers: true, cancelled: data.cancelled || null };
}

// ---------------------------------------------------------------- PrCreditInvoice

export interface CreditInvoiceData extends CashSaleData {
  dueDate?: string | Date | null;
  note?: string | null;
  paid: number;
  remaining: number;
  /** `label` is the payment's own note; empty = the template writes "دفعة" / "مقدم مع الفاتورة" in the print language. */
  payments?: Array<{ label?: string; kind?: 'down_payment' | 'payment'; date: string | Date | null; amount: number }>;
  balanceBefore?: number | null;
  balanceAfter?: number | null;
}

/** PrCreditInvoice: credit sale invoice + the debt acknowledgment, A4. */
export function creditInvoice(ctx: PrintContext, data: CreditInvoiceData): PrintDocument {
  const labels = vatPrintLabels(ctx.lang);
  const title = data.vat ? labels.taxInvoice : pick(ctx, 'فاتورة بيع آجل', 'Credit sale invoice');
  const due = data.dueDate ? formatDate(data.dueDate, ctx.lang) : '';
  const payments = (data.payments || []).length
    ? table(
        [{ label: pick(ctx, 'الدفعات', 'Payments') }, { label: pick(ctx, 'التاريخ', 'Date'), numeric: true }, { label: pick(ctx, 'المبلغ', 'Amount'), numeric: true }],
        (data.payments || []).map((payment) => row([escapeHtml(payment.label || (payment.kind === 'down_payment' ? pick(ctx, 'مقدم مع الفاتورة', 'Down payment with the invoice') : pick(ctx, 'دفعة', 'Payment'))), { html: formatDate(payment.date, ctx.lang), numeric: true }, { html: money(ctx, payment.amount), numeric: true }])).join('')
      )
    : '';
  const balanceBox =
    data.balanceBefore !== null && data.balanceBefore !== undefined && data.balanceAfter !== null && data.balanceAfter !== undefined
      ? infoBox(pick(ctx, 'رصيد العميل', 'Customer balance'), [
          `<span class="n" style="font-size:13px" data-balance-before>${pick(ctx, 'قبل الفاتورة', 'Before the invoice')}: ${money(ctx, data.balanceBefore)}</span>`,
          `<span class="n" style="font-size:15px;font-weight:800" data-balance-after>${pick(ctx, 'بعد الفاتورة', 'After the invoice')}: ${money(ctx, data.balanceAfter)}</span>`,
        ])
      : '';
  const acknowledgment =
    ctx.lang === 'ar'
      ? `أقر أنا الموقّع أدناه باستلام البضاعة الموضحة بالفاتورة بحالة جيدة، وبأن المتبقي عليّ مبلغ <b class="n">${money(ctx, data.remaining)} ج.م</b>${due ? ` أتعهد بسداده في موعد أقصاه <b class="n">${due}</b>` : ' أتعهد بسداده'}.`
      : `I, the undersigned, acknowledge receiving the goods listed on this invoice in good condition, and that I owe the remaining <b class="n">${money(ctx, data.remaining)} EGP</b>${due ? `, which I undertake to pay no later than <b class="n">${due}</b>` : ''}.`;
  const body = a4Page(
    `
  ${a4Header(ctx, { title, no: data.number, date: formatDate(data.date, ctx.lang), extraLabel: due ? pick(ctx, 'ميعاد السداد', 'Due date') : '', extra: due })}
  ${cancelBox(ctx, data.cancelled)}
  <div style="display:grid;grid-template-columns:${balanceBox ? '2fr 1fr' : '1fr'};gap:14px">
    ${infoBox(pick(ctx, 'العميل', 'Customer'), [
      `<span style="font-size:15px;font-weight:700">${escapeHtml(data.customerName || '')}</span>`,
      data.customerPhone ? `<span class="n" style="font-size:13px;direction:ltr;text-align:${ctx.lang === 'ar' ? 'right' : 'left'}">${escapeHtml(data.customerPhone)}</span>` : '',
      vatCustomerLine(ctx, data.vat, data.customerTaxNumber),
      data.note ? `<span style="font-size:13px">${pick(ctx, 'ملاحظة', 'Note')}: ${escapeHtml(data.note)}</span>` : '',
    ])}
    ${balanceBox}
  </div>
  ${table(itemHead(ctx), itemRows(ctx, data.items, data.vat))}
  <div class="row keep" style="justify-content:space-between;align-items:flex-start;gap:20px">
    <div class="col grow" style="gap:10px">
      <div class="box col" style="gap:4px"><span class="lbl">${pick(ctx, 'المبلغ المتبقي بالحروف', 'Remaining amount in words')}</span><span style="font-size:14px;font-weight:700" data-words>${escapeHtml(amountInWords(data.remaining, ctx.lang))}</span></div>
      ${payments}
    </div>
    <table class="t" style="width:300px"><tbody>
      ${totalsRow(pick(ctx, 'الإجمالي', 'Subtotal'), money(ctx, data.subtotal))}
      ${totalsRow(`${pick(ctx, 'الخصم', 'Discount')}${data.discountPercent ? ` (${formatPercent(data.discountPercent, ctx.lang)})` : ''}`, money(ctx, data.discount))}
      ${data.shipping ? totalsRow(pick(ctx, 'التوصيل', 'Delivery'), money(ctx, data.shipping)) : ''}
      ${vatTotals(ctx, data.vat)}
      <tr><td style="font-weight:700">${pick(ctx, 'صافي الفاتورة', 'Invoice total')}</td><td class="n" style="font-weight:700" data-total>${money(ctx, data.total)}</td></tr>
      ${totalsRow(pick(ctx, 'المدفوع', 'Paid'), money(ctx, data.paid), 'data-paid')}
      ${grandRow(pick(ctx, 'المتبقي', 'Remaining'), `${money(ctx, data.remaining)} ${currency(ctx)}`, 'data-remaining')}
    </tbody></table>
  </div>
  <div class="grow"></div>
  <div class="col keep" style="gap:16px" data-debt-block>
    <div class="box" style="font-size:13px;line-height:1.8" data-acknowledgment>${acknowledgment}</div>
    ${closing(ctx, [
      { who: pick(ctx, 'عن المحل', 'For the shop'), line: pick(ctx, 'الاسم والتوقيع', 'Name and signature') },
      { who: pick(ctx, 'العميل', 'Customer'), line: pick(ctx, 'الاسم والتوقيع والرقم القومي', 'Name, signature and national ID') },
    ], true)}
  </div>`,
    16
  );
  return { paper: 'A4', title: data.number, body, pageNumbers: true, cancelled: data.cancelled || null };
}

// ---------------------------------------------------------------- PrPurchaseInvoice

export interface PurchaseInvoiceData {
  number: string;
  date: string | Date | null;
  supplierInvoiceNo?: string | null;
  supplier: { name: string; contact?: string | null; phone?: string | null; address?: string | null; taxNumber?: string | null };
  items: Array<{ code?: string; name: string; quantity: number; unitCost: number; total: number }>;
  subtotal: number;
  discount: number;
  otherCosts: number;
  /** Stored VAT of the purchase (absent with VAT off). */
  vat?: { rate: number; amount: number; netAmount: number } | null;
  total: number;
  paid: number;
  paidBoxName?: string | null;
  remaining: number;
  balanceBefore?: number | null;
  balanceAfter?: number | null;
  /** The posted journal entry: only when the user may see accounting. */
  journal?: { number: string; lines: Array<{ name: string; debit: number; credit: number }> | null } | null;
  receivedBy?: string | null;
  notes?: string | null;
  cancelled?: { reason?: string | null; at?: string | Date | null; by?: string | null } | null;
}

export function purchaseInvoice(ctx: PrintContext, data: PurchaseInvoiceData): PrintDocument {
  const labels = vatPrintLabels(ctx.lang);
  const pieces = data.items.reduce((sum, line) => sum + Number(line.quantity || 0), 0);
  const rows = data.items
    .map((line, index) =>
      row([
        { html: localizeDigits(String(index + 1), ctx.lang), numeric: true },
        { html: escapeHtml(line.code || ''), code: true },
        escapeHtml(line.name),
        { html: formatQty(line.quantity, ctx.lang), numeric: true },
        { html: money(ctx, line.unitCost), numeric: true },
        { html: money(ctx, line.total), numeric: true, bold: true },
      ])
    )
    .join('');
  const head = [
    { label: '#', width: 36 },
    { label: pick(ctx, 'الكود', 'Code'), width: 110 },
    { label: pick(ctx, 'الصنف', 'Item') },
    { label: pick(ctx, 'الكمية', 'Qty'), numeric: true, width: 70 },
    { label: pick(ctx, 'سعر الشراء', 'Cost'), numeric: true, width: 100 },
    { label: pick(ctx, 'الإجمالي', 'Total'), numeric: true, width: 110 },
  ];
  const supplierLines = [
    `<span style="font-size:15px;font-weight:700">${escapeHtml(data.supplier.name)}</span>`,
    [data.supplier.contact, data.supplier.phone].filter(Boolean).length ? `<span class="n" style="font-size:13px">${escapeHtml([data.supplier.contact, data.supplier.phone].filter(Boolean).join(' · '))}</span>` : '',
    data.supplier.address ? `<span style="font-size:13px">${escapeHtml(data.supplier.address)}</span>` : '',
    data.supplier.taxNumber ? `<span style="font-size:13px">${pick(ctx, 'الرقم الضريبي', 'Tax no.')}: ${ltr(data.supplier.taxNumber)}</span>` : '',
  ];
  const balanceBox =
    data.balanceBefore !== null && data.balanceBefore !== undefined && data.balanceAfter !== null && data.balanceAfter !== undefined
      ? infoBox(pick(ctx, 'رصيد المورد (علينا)', 'Supplier balance (we owe)'), [
          `<span class="n" style="font-size:13px" data-balance-before>${pick(ctx, 'قبل الفاتورة', 'Before the invoice')}: ${money(ctx, data.balanceBefore)}</span>`,
          `<span class="n" style="font-size:15px;font-weight:800" data-balance-after>${pick(ctx, 'بعد الفاتورة', 'After the invoice')}: ${money(ctx, data.balanceAfter)}</span>`,
        ])
      : '';
  const journal = data.journal
    ? `<div class="box col keep" style="gap:4px;font-size:13px" data-journal>
        <span class="lbl">${pick(ctx, 'القيد المحاسبي', 'Journal entry')}</span>
        ${(data.journal.lines || [])
          .map((line) => `<div class="row" style="justify-content:space-between"><span>${line.debit ? pick(ctx, 'من حـ/', 'Dr ') : pick(ctx, 'إلى حـ/', 'Cr ')} ${escapeHtml(line.name)}</span><span class="n">${money(ctx, line.debit || line.credit)} ${line.debit ? pick(ctx, 'مدين', 'debit') : pick(ctx, 'دائن', 'credit')}</span></div>`)
          .join('')}
        <span class="muted" style="font-size:12px">${pick(ctx, 'قيد رقم', 'Entry no.')} <span class="code n" data-journal-number>${escapeHtml(data.journal.number)}</span></span>
      </div>`
    : '';
  const body = a4Page(`
  ${a4Header(ctx, { title: pick(ctx, 'فاتورة شراء', 'Purchase invoice'), no: data.number, date: formatDate(data.date, ctx.lang), extraLabel: data.supplierInvoiceNo ? pick(ctx, 'فاتورة المورد', 'Supplier invoice') : '', extra: data.supplierInvoiceNo || '' })}
  ${cancelBox(ctx, data.cancelled)}
  <div style="display:grid;grid-template-columns:${balanceBox ? '2fr 1fr' : '1fr'};gap:14px">
    ${infoBox(pick(ctx, 'المورد', 'Supplier'), supplierLines)}
    ${balanceBox}
  </div>
  ${table(head, rows)}
  <div class="row keep" style="justify-content:space-between;align-items:flex-start;gap:20px">
    <div class="col grow" style="gap:10px">${journal}${data.notes ? `<div class="box" style="font-size:13px"><span class="lbl">${pick(ctx, 'ملاحظات', 'Notes')}</span><br>${escapeHtml(data.notes)}</div>` : ''}</div>
    <table class="t" style="width:300px"><tbody>
      ${totalsRow(pick(ctx, 'عدد القطع', 'Pieces'), formatQty(pieces, ctx.lang))}
      ${totalsRow(pick(ctx, 'إجمالي الأصناف', 'Items subtotal'), money(ctx, data.subtotal))}
      ${data.discount ? totalsRow(pick(ctx, 'الخصم', 'Discount'), `− ${money(ctx, data.discount)}`) : ''}
      ${data.otherCosts ? totalsRow(pick(ctx, 'مصاريف أخرى', 'Other costs'), money(ctx, data.otherCosts)) : ''}
      ${data.vat ? `${totalsRow(pick(ctx, 'الصافي قبل الضريبة', 'Net before VAT'), money(ctx, data.vat.netAmount), 'data-vat-net')}${totalsRow(`${labels.vat} ${formatPercent(data.vat.rate, ctx.lang)}`, money(ctx, data.vat.amount), 'data-vat-amount')}` : ''}
      ${grandRow(pick(ctx, 'الإجمالي', 'Total'), `${money(ctx, data.total)} ${currency(ctx)}`, 'data-total')}
      ${totalsRow(`${pick(ctx, 'المدفوع', 'Paid')}${data.paidBoxName ? ` (${escapeHtml(data.paidBoxName)})` : ''}`, money(ctx, data.paid), 'data-paid')}
      ${totalsRow(pick(ctx, 'المتبقي للمورد', 'Remaining to supplier'), money(ctx, data.remaining), 'data-remaining')}
    </tbody></table>
  </div>
  <div class="grow"></div>
  ${closing(ctx, [
    { who: `${pick(ctx, 'استلم البضاعة', 'Goods received by')}${data.receivedBy ? ` ${data.receivedBy}` : ''}`, line: pick(ctx, 'أمين المخزن', 'Storekeeper') },
    { who: pick(ctx, 'المحاسب', 'Accountant'), line: pick(ctx, 'الاسم والتوقيع', 'Name and signature') },
    { who: pick(ctx, 'مندوب المورد', 'Supplier representative'), line: pick(ctx, 'الاسم والتوقيع', 'Name and signature') },
  ])}`);
  return { paper: 'A4', title: data.number, body, pageNumbers: true, cancelled: data.cancelled || null };
}

// ---------------------------------------------------------------- A5 vouchers

export type VoucherType = 'RC' | 'SR' | 'PV' | 'EX' | 'DR' | 'CP' | 'VP';

const VOUCHER_TITLES: Record<VoucherType, { ar: string; en: string }> = {
  RC: { ar: 'سند قبض', en: 'Receipt voucher' },
  SR: { ar: 'سند قبض (استرداد من مورد)', en: 'Receipt voucher (supplier refund)' },
  PV: { ar: 'سند صرف', en: 'Payment voucher' },
  EX: { ar: 'سند صرف مصروف', en: 'Expense voucher' },
  DR: { ar: 'سند سحب مالك', en: 'Owner drawing voucher' },
  CP: { ar: 'سند صرف رصيد عميل', en: 'Customer payout voucher' },
  VP: { ar: 'سند سداد ضريبة', en: 'VAT payment voucher' },
};
const RECEIVING_TYPES = new Set<VoucherType>(['RC', 'SR']);

export interface VoucherData {
  type: VoucherType;
  number: string;
  date: string | Date | null;
  amount: number;
  /** "استلمنا من" / "صرفنا إلى" value. */
  party: string;
  /** "وذلك عن". */
  /** "وذلك عن" as plain text: ALWAYS escaped when printed. */
  reason?: string | null;
  /** Pre-built markup for "وذلك عن" (made only inside this file from escaped parts); wins over `reason`. */
  reasonHtml?: string | null;
  /** "طريقة الدفع" (receipts) or "من خزنة" (payments). */
  method?: string | null;
  balanceLabel?: string | null;
  balanceBefore?: number | null;
  balanceAfter?: number | null;
  /** The person who prepared it (signature line of the shop's side). */
  preparedBy?: string | null;
  journalNumber?: string | null;
  cancelled?: { reason?: string | null; at?: string | Date | null; by?: string | null } | null;
}

export function voucher(ctx: PrintContext, data: VoucherData): PrintDocument {
  const receiving = RECEIVING_TYPES.has(data.type);
  const title = pick(ctx, VOUCHER_TITLES[data.type].ar, VOUCHER_TITLES[data.type].en);
  const shop = ctx.shop;
  const field = (label: string, value: string): string => `<div class="f"><span>${escapeHtml(label)}</span>${value}</div>`;
  const phones = shop && shop.phones.length ? ` · <span class="n ltr">${escapeHtml(shop.phones[0])}</span>` : '';
  const logo = shop && shop.logo ? `<img src="${escapeHtml(shop.logo)}" alt="" width="44" height="44" style="width:44px;height:44px;object-fit:contain;border-radius:8px">` : '';
  const hasBalance = data.balanceBefore !== null && data.balanceBefore !== undefined && data.balanceAfter !== null && data.balanceAfter !== undefined;
  const signatureItems = receiving
    ? [{ who: `${pick(ctx, 'المستلم (عن المحل)', 'Received (for the shop)')}`, line: data.preparedBy || pick(ctx, 'الاسم والتوقيع', 'Name and signature') }, { who: pick(ctx, 'الدافع', 'Payer'), line: pick(ctx, 'الاسم والتوقيع', 'Name and signature') }]
    : [
        { who: pick(ctx, 'أمين الخزنة', 'Cashier'), line: pick(ctx, 'التوقيع', 'Signature') },
        { who: pick(ctx, 'المدير', 'Manager'), line: pick(ctx, 'اعتماد', 'Approval') },
        { who: pick(ctx, 'المستلم', 'Receiver'), line: pick(ctx, 'الاسم والتوقيع', 'Name and signature') },
      ];
  const body = `<main class="page5" data-voucher="${data.type}">
  <div class="row keep" style="justify-content:space-between;align-items:center" data-header>
    <div class="col" style="gap:2px">
      <span style="font-size:16px;font-weight:800">${escapeHtml(shop ? shop.name : '')}</span>
      ${shop && (shop.address || phones) ? `<span class="muted" style="font-size:12px">${escapeHtml(shop.address)}${phones}</span>` : ''}
      ${shop && shop.taxNumber ? `<span class="muted" style="font-size:12px">${pick(ctx, 'الرقم الضريبي', 'Tax no.')} <span class="ltr">${escapeHtml(shop.taxNumber)}</span></span>` : ''}
    </div>
    ${logo}
  </div>
  <div style="height:3px;background:var(--p-brand);border-radius:2px"></div>
  <div class="row" style="justify-content:space-between;align-items:center">
    <span style="font-size:26px;font-weight:800;color:var(--p-brand)" data-title>${escapeHtml(title)}</span>
    <div class="col" style="align-items:flex-end;font-size:13px;gap:2px;text-align:end">
      <span>${pick(ctx, 'رقم', 'No.')} <b class="code n">${escapeHtml(data.number)}</b></span>
      <span class="n">${pick(ctx, 'التاريخ', 'Date')} <b>${formatDate(data.date, ctx.lang)}</b></span>
    </div>
  </div>
  ${copyMark(ctx)}
  ${cancelBox(ctx, data.cancelled)}
  <div class="row keep" style="align-items:center;justify-content:space-between;border:2px solid var(--p-text);border-radius:10px;padding:12px 16px" data-amount>
    <span style="font-size:14px">${pick(ctx, 'المبلغ', 'Amount')}</span>
    <span class="n" style="font-size:26px;font-weight:800">${money(ctx, data.amount)} ${currency(ctx)}</span>
  </div>
  <div class="col">
    ${field(receiving ? pick(ctx, 'استلمنا من', 'Received from') : pick(ctx, 'صرفنا إلى', 'Paid to'), `<b>${escapeHtml(data.party)}</b>`)}
    ${field(pick(ctx, 'مبلغ وقدره', 'The sum of'), `<b data-words>${escapeHtml(amountInWords(data.amount, ctx.lang))}</b>`)}
    ${data.reasonHtml || data.reason ? field(pick(ctx, 'وذلك عن', 'For'), `<span style="color:var(--p-text);min-width:0">${data.reasonHtml ?? escapeHtml(data.reason)}</span>`) : ''}
    ${data.method ? field(receiving ? pick(ctx, 'طريقة الدفع', 'Payment method') : pick(ctx, 'من خزنة', 'From box'), `<span style="color:var(--p-text);min-width:0">${escapeHtml(data.method)}</span>`) : ''}
    ${hasBalance ? field(data.balanceLabel || pick(ctx, 'الرصيد', 'Balance'), `<span class="n" style="color:var(--p-text);min-width:0" data-balance>${pick(ctx, 'قبل', 'before')} ${money(ctx, data.balanceBefore)} · ${pick(ctx, 'بعد', 'after')} <b>${money(ctx, data.balanceAfter)}</b></span>`) : ''}
  </div>
  <div class="grow"></div>
  <div class="sig keep" style="grid-template-columns:repeat(${signatureItems.length},minmax(0,1fr));gap:30px" data-signatures>${signatureItems
    .map((item) => `<div style="gap:28px"><span>${escapeHtml(item.who)}</span><span class="line">${escapeHtml(item.line)}</span></div>`)
    .join('')}</div>
  <div class="col keep muted" style="gap:3px;font-size:11px;border-top:1px solid var(--p-border);padding-top:8px">
    <div class="row" style="justify-content:space-between;gap:8px"><span>${data.journalNumber ? `${pick(ctx, 'قيد رقم', 'Entry no.')} <span class="code n" data-journal-number>${escapeHtml(data.journalNumber)}</span>` : ''}</span><span>${escapeHtml(generatedText(ctx, 'voucher'))}</span></div>
    <div data-printed-by>${escapeHtml(printedByText(ctx))}</div>
  </div>
</main>`;
  return { paper: 'A5', title: data.number, body, cancelled: data.cancelled || null };
}

/** PrReceiptVoucher: the A5 alternative to the 80mm payment receipt (same data). */
export function receiptVoucher(ctx: PrintContext, data: PaymentReceiptData & { cancelled?: VoucherData['cancelled'] }): PrintDocument {
  return voucher(ctx, {
    type: 'RC',
    number: data.number,
    date: data.date,
    amount: data.amount,
    party: data.customerName,
    reasonHtml: data.invoiceNumbers.length
      ? `${data.downPayment ? pick(ctx, 'مقدم من فاتورة آجل', 'down payment on credit invoice') : pick(ctx, 'دفعة من فاتورة آجل', 'payment on credit invoice')} <b class="code n">${escapeHtml(data.invoiceNumbers.join(' · '))}</b>`
      : data.note
        ? escapeHtml(data.note)
        : pick(ctx, 'دفعة من حساب العميل', 'payment on the customer account'),
    method: data.paymentMethod,
    balanceLabel: pick(ctx, 'رصيد العميل', 'Customer balance'),
    balanceBefore: data.balanceBefore,
    balanceAfter: data.balanceAfter,
    preparedBy: data.cashier,
    journalNumber: data.journalNumber,
    cancelled: data.cancelled,
  });
}
