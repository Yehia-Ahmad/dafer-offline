// Stage 23: the A4 statements and lists: PrCustomerStatement, PrSupplierStatement, PrStockList.

import { escapeHtml, formatDate, formatDayMonth, formatMoney, formatQty } from '../print-format';
import { Cell, PrintContext, PrintDocument, a4Header, a4Page, pick, row, closing, signatures, table } from '../print-kit';

const money = (ctx: PrintContext, value: number | null | undefined): string => formatMoney(value ?? 0, ctx.lang);
const currency = (ctx: PrintContext): string => pick(ctx, 'ج.م', 'EGP');
const ltr = (value: string): string => `<span class="ltr n">${escapeHtml(value)}</span>`;

/** A row of summary boxes (label over a number). */
export function kpiRow(items: Array<{ label: string; value: string; strong?: boolean }>): string {
  return `<div style="display:grid;grid-template-columns:repeat(${items.length},minmax(0,1fr));gap:12px" class="keep" data-kpis>${items
    .map(
      (item) =>
        `<div class="box col" style="gap:2px;padding:10px 12px"><span class="lbl">${escapeHtml(item.label)}</span><span class="n" style="font-size:${item.strong ? 20 : 17}px;font-weight:800;${item.strong ? 'color:var(--p-brand)' : ''}">${item.value}</span></div>`
    )
    .join('')}</div>`;
}

export interface StatementLine {
  date: string | Date | null;
  type?: string;
  description: string;
  memo?: string | null;
  number?: string | null;
  debit: number;
  credit: number;
  balance: number;
}

function statementRows(ctx: PrintContext, lines: StatementLine[]): string {
  return lines
    .map((line): string => {
      const description = `${escapeHtml(line.description)}${line.memo ? ` <span class="muted" style="font-size:12px">· ${escapeHtml(line.memo)}</span>` : ''}`;
      const cells: Cell[] = [
        { html: formatDayMonth(line.date, ctx.lang), numeric: true },
        description,
        { html: escapeHtml(line.number || ''), code: true },
        { html: line.debit ? money(ctx, line.debit) : '', numeric: true },
        { html: line.credit ? money(ctx, line.credit) : '', numeric: true },
        { html: money(ctx, line.balance), numeric: true, bold: true },
      ];
      return row(cells, line.type === 'opening' ? 'group' : '');
    })
    .join('');
}

const statementHead = (ctx: PrintContext) => [
  { label: pick(ctx, 'التاريخ', 'Date'), width: 62, numeric: true },
  { label: pick(ctx, 'البيان', 'Description') },
  { label: pick(ctx, 'المستند', 'Document'), width: 100 },
  { label: pick(ctx, 'مدين', 'Debit'), numeric: true, width: 84 },
  { label: pick(ctx, 'دائن', 'Credit'), numeric: true, width: 84 },
  { label: pick(ctx, 'الرصيد', 'Balance'), numeric: true, width: 92 },
];

const periodText = (ctx: PrintContext, from: string | null | undefined, to: string | null | undefined): string => {
  if (from && to) return `${formatDate(from, ctx.lang)} — ${formatDate(to, ctx.lang)}`;
  if (from) return `${pick(ctx, 'من', 'From')} ${formatDate(from, ctx.lang)}`;
  if (to) return `${pick(ctx, 'حتى', 'Until')} ${formatDate(to, ctx.lang)}`;
  return pick(ctx, 'كل الفترات', 'All time');
};

// ---------------------------------------------------------------- PrCustomerStatement

export interface CustomerStatementData {
  customer: { name: string; phone?: string | null; taxNumber?: string | null; creditLimit?: number | null };
  from?: string | null;
  to?: string | null;
  lines: StatementLine[];
  totals: { openingBalance: number; debit: number; credit: number; balance: number };
  aging: { current: number; days1to30: number; days31to60: number; over60: number; total: number };
}

export function customerStatement(ctx: PrintContext, data: CustomerStatementData): PrintDocument {
  const info = [
    `${pick(ctx, 'العميل', 'Customer')}: <b>${escapeHtml(data.customer.name)}</b>`,
    data.customer.phone ? `${pick(ctx, 'التليفون', 'Phone')}: ${ltr(data.customer.phone)}` : '',
    data.customer.taxNumber ? `${pick(ctx, 'الرقم الضريبي', 'Tax no.')}: ${ltr(data.customer.taxNumber)}` : '',
    data.customer.creditLimit ? `${pick(ctx, 'حد الآجل', 'Credit limit')}: <span class="n">${money(ctx, data.customer.creditLimit)}</span>` : '',
  ].filter(Boolean);
  const totalsFoot = `<tr class="total"><td colspan="3">${pick(ctx, 'الإجمالي', 'Total')}</td><td class="n">${money(ctx, data.totals.debit)}</td><td class="n">${money(ctx, data.totals.credit)}</td><td class="n" data-balance>${money(ctx, data.totals.balance)}</td></tr>`;
  const agingRows = [
    [pick(ctx, 'لسه ما استحقش', 'Not due yet'), data.aging.current],
    [pick(ctx, 'متأخر ١–٣٠ يوم', 'Overdue 1–30 days'), data.aging.days1to30],
    [pick(ctx, 'متأخر ٣١–٦٠ يوم', 'Overdue 31–60 days'), data.aging.days31to60],
    [pick(ctx, 'متأخر أكتر من ٦٠ يوم', 'Overdue over 60 days'), data.aging.over60],
  ] as Array<[string, number]>;
  const acknowledgment =
    ctx.lang === 'ar'
      ? `نرجو مراجعة الكشف، وإبلاغنا بأي ملاحظة خلال ٧ أيام من تاريخه. بعد كده يُعتبر الرصيد الموضح <b class="n">${money(ctx, data.totals.balance)} ج.م</b> صحيحًا ونهائيًا.`
      : `Please review this statement and tell us of any remark within 7 days of its date. After that the balance shown, <b class="n">${money(ctx, data.totals.balance)} EGP</b>, is considered correct and final.`;
  const body = a4Page(`
  ${a4Header(ctx, { title: pick(ctx, 'كشف حساب عميل', 'Customer statement'), date: formatDate(ctx.printedAt, ctx.lang), extraLabel: pick(ctx, 'العميل', 'Customer'), extra: data.customer.name, extra2Label: pick(ctx, 'الفترة', 'Period'), extra2: periodText(ctx, data.from, data.to) })}
  ${kpiRow([
    { label: pick(ctx, 'رصيد أول الفترة', 'Opening balance'), value: money(ctx, data.totals.openingBalance) },
    { label: pick(ctx, 'إجمالي المدين', 'Total debit'), value: money(ctx, data.totals.debit) },
    { label: pick(ctx, 'إجمالي الدائن', 'Total credit'), value: money(ctx, data.totals.credit) },
    { label: pick(ctx, 'الرصيد المستحق', 'Balance due'), value: money(ctx, data.totals.balance), strong: true },
  ])}
  <div class="row keep" style="gap:24px;flex-wrap:wrap;font-size:13px" data-party>${info.map((text) => `<span>${text}</span>`).join('')}</div>
  ${table(statementHead(ctx), statementRows(ctx, data.lines), { foot: totalsFoot })}
  <div class="col keep" style="gap:6px">
    <span style="font-weight:800;font-size:13px;color:var(--p-brand)">${pick(ctx, 'أعمار الدين', 'Aging of the debt')}</span>
    <table class="t" style="width:380px" data-aging><tbody>${agingRows.map(([label, value]) => `<tr><td>${label}</td><td class="n">${money(ctx, value)}</td></tr>`).join('')}</tbody></table>
  </div>
  <div class="box keep" style="font-size:13px;line-height:1.8" data-acknowledgment>${acknowledgment}</div>
  ${closing(ctx, [{ who: pick(ctx, 'توقيع العميل بالموافقة', 'Customer signature (approval)'), line: '.....................' }].concat([{ who: pick(ctx, 'عن المحل', 'For the shop'), line: pick(ctx, 'الاسم والتوقيع', 'Name and signature') }]))}`);
  return { paper: 'A4', title: `${pick(ctx, 'كشف حساب', 'Statement')} ${data.customer.name}`, body, pageNumbers: true };
}

// ---------------------------------------------------------------- PrSupplierStatement

export interface SupplierStatementData {
  supplier: { name: string; contact?: string | null; phone?: string | null };
  from?: string | null;
  to?: string | null;
  lines: StatementLine[];
  totals: { openingBalance: number; debit: number; credit: number; balance: number };
}

export function supplierStatement(ctx: PrintContext, data: SupplierStatementData): PrintDocument {
  const info = [
    `${pick(ctx, 'المورد', 'Supplier')}: <b>${escapeHtml(data.supplier.name)}</b>`,
    data.supplier.contact ? `${pick(ctx, 'المسؤول', 'Contact')}: ${escapeHtml(data.supplier.contact)}` : '',
    data.supplier.phone ? `${pick(ctx, 'التليفون', 'Phone')}: ${ltr(data.supplier.phone)}` : '',
  ].filter(Boolean);
  const totalsFoot = `<tr class="total"><td colspan="3">${pick(ctx, 'الإجمالي', 'Total')}</td><td class="n">${money(ctx, data.totals.debit)}</td><td class="n">${money(ctx, data.totals.credit)}</td><td class="n" data-balance>${money(ctx, data.totals.balance)}</td></tr>`;
  const body = a4Page(`
  ${a4Header(ctx, { title: pick(ctx, 'كشف حساب مورد', 'Supplier statement'), date: formatDate(ctx.printedAt, ctx.lang), extraLabel: pick(ctx, 'المورد', 'Supplier'), extra: data.supplier.name, extra2Label: pick(ctx, 'الفترة', 'Period'), extra2: periodText(ctx, data.from, data.to) })}
  ${kpiRow([
    { label: pick(ctx, 'رصيد أول الفترة', 'Opening balance'), value: money(ctx, data.totals.openingBalance) },
    { label: pick(ctx, 'مشتريات (دائن)', 'Purchases (credit)'), value: money(ctx, data.totals.credit) },
    { label: pick(ctx, 'مدفوعات (مدين)', 'Payments (debit)'), value: money(ctx, data.totals.debit) },
    { label: pick(ctx, 'الرصيد المستحق له', 'Balance owed to supplier'), value: money(ctx, data.totals.balance), strong: true },
  ])}
  <div class="row keep" style="gap:24px;flex-wrap:wrap;font-size:13px" data-party>${info.map((text) => `<span>${text}</span>`).join('')}</div>
  ${table(statementHead(ctx), statementRows(ctx, data.lines), { foot: totalsFoot })}
  <div class="muted keep" style="font-size:12px">${pick(ctx, 'دائن = بضاعة اشتريناها من المورد · مدين = فلوس دفعناها له. الرصيد الموجب = مبلغ مستحق للمورد علينا.', 'Credit = goods we bought from the supplier · Debit = money we paid them. A positive balance = an amount we owe the supplier.')}</div>
  <div class="grow"></div>
  ${closing(ctx, [
    { who: pick(ctx, 'عن المحل', 'For the shop'), line: pick(ctx, 'الاسم والتوقيع', 'Name and signature') },
    { who: pick(ctx, 'عن المورد (مطابقة الرصيد)', 'For the supplier (balance confirmation)'), line: pick(ctx, 'الاسم والتوقيع والختم', 'Name, signature and stamp') },
  ])}`);
  return { paper: 'A4', title: `${pick(ctx, 'كشف حساب', 'Statement')} ${data.supplier.name}`, body, pageNumbers: true };
}

// ---------------------------------------------------------------- PrStockList

export interface StockRow {
  code: string;
  name: string;
  categoryName: string;
  inventoryCount: number;
  lowStock: boolean;
  /** Absent for a user without products.viewCost: the cost and value columns are then not printed. */
  purchasePrice?: number | null;
}

export interface StockListData {
  rows: StockRow[];
  /** "الكل" or the chosen category's name. */
  categoryLabel: string;
  preparedBy?: string | null;
}

export function stockList(ctx: PrintContext, data: StockListData): PrintDocument {
  const showCost = data.rows.some((entry) => typeof entry.purchasePrice === 'number');
  const groups = new Map<string, StockRow[]>();
  for (const entry of data.rows) {
    const key = entry.categoryName || pick(ctx, 'بدون فئة', 'No category');
    groups.set(key, [...(groups.get(key) || []), entry]);
  }
  const value = (entry: StockRow): number => Math.round(entry.inventoryCount * Number(entry.purchasePrice || 0) * 100) / 100;
  const columns = showCost ? 7 : 5;
  let totalQty = 0;
  let totalValue = 0;
  const bodyRows: string[] = [];
  for (const [name, rows] of groups) {
    const qty = rows.reduce((sum, entry) => sum + entry.inventoryCount, 0);
    const cost = rows.reduce((sum, entry) => sum + value(entry), 0);
    totalQty += qty;
    totalValue += cost;
    bodyRows.push(`<tr class="group"><td colspan="${columns}">${escapeHtml(name)}</td></tr>`);
    for (const entry of rows) {
      bodyRows.push(
        row([
          { html: escapeHtml(entry.code), code: true },
          `${escapeHtml(entry.name)}${entry.lowStock ? ' <b data-low-stock>★</b>' : ''}`,
          { html: formatQty(entry.inventoryCount, ctx.lang), numeric: true },
          ...(showCost ? ([{ html: money(ctx, entry.purchasePrice), numeric: true }, { html: money(ctx, value(entry)), numeric: true }] as Cell[]) : []),
          { html: '&nbsp;', numeric: true },
          { html: '&nbsp;', numeric: true },
        ])
      );
    }
    bodyRows.push(
      `<tr class="total"><td colspan="2">${pick(ctx, 'إجمالي', 'Total')} ${escapeHtml(name)}</td><td class="n">${formatQty(qty, ctx.lang)}</td>${showCost ? `<td></td><td class="n">${money(ctx, cost)}</td>` : ''}<td></td><td></td></tr>`
    );
  }
  const head = [
    { label: pick(ctx, 'الكود', 'Code'), width: 90 },
    { label: pick(ctx, 'الصنف', 'Item') },
    { label: pick(ctx, 'الكمية', 'Qty'), numeric: true, width: 64 },
    ...(showCost ? [{ label: pick(ctx, 'سعر الشراء', 'Cost'), numeric: true, width: 84 }, { label: pick(ctx, 'القيمة', 'Value'), numeric: true, width: 92 }] : []),
    { label: pick(ctx, 'المعدود', 'Counted'), numeric: true, width: 78 },
    { label: pick(ctx, 'الفرق', 'Difference'), numeric: true, width: 70 },
  ];
  const grandFoot = `<tr class="grand"><td colspan="2">${pick(ctx, 'الإجمالي العام', 'Grand total')}</td><td class="n">${formatQty(totalQty, ctx.lang)}</td>${showCost ? `<td></td><td class="n">${money(ctx, totalValue)}</td>` : ''}<td></td><td></td></tr>`;
  const lowCount = data.rows.filter((entry) => entry.lowStock).length;
  const kpis = [
    { label: pick(ctx, 'عدد الأصناف', 'Items'), value: formatQty(data.rows.length, ctx.lang) },
    { label: pick(ctx, 'إجمالي القطع', 'Total pieces'), value: formatQty(totalQty, ctx.lang) },
    ...(showCost ? [{ label: pick(ctx, 'قيمة المخزون بسعر الشراء', 'Stock value at cost'), value: money(ctx, totalValue) }] : []),
    { label: pick(ctx, 'تحت حد التنبيه', 'Below alert level'), value: formatQty(lowCount, ctx.lang) },
  ];
  const body = a4Page(`
  ${a4Header(ctx, { title: pick(ctx, 'كشف جرد المخزون', 'Stock count sheet'), date: formatDate(ctx.printedAt, ctx.lang), extraLabel: pick(ctx, 'الفئات', 'Categories'), extra: data.categoryLabel })}
  ${kpiRow(kpis)}
  ${table(head, bodyRows.join(''), { foot: grandFoot })}
  <div class="muted keep" style="font-size:12px">${pick(ctx, '★ = تحت حد التنبيه · عمود "المعدود" و"الفرق" فاضيين عشان تكتب فيهم وأنت بتعدّ البضاعة على الرف.', '★ = below the alert level · the "Counted" and "Difference" columns are blank for you to fill in while counting the shelf.')}</div>
  <div class="grow"></div>
  ${closing(ctx, [
    { who: `${pick(ctx, 'قام بالجرد', 'Counted by')}${data.preparedBy ? ` ${data.preparedBy}` : ''}`, line: pick(ctx, 'الاسم والتوقيع', 'Name and signature') },
    { who: pick(ctx, 'راجع واعتمد', 'Reviewed and approved'), line: pick(ctx, 'الاسم والتوقيع', 'Name and signature') },
  ])}`);
  return { paper: 'A4', title: pick(ctx, 'كشف جرد المخزون', 'Stock count sheet'), body, pageNumbers: true };
}

