// Stage 23: the A4 reports and the journal entry: PrProfitReport, PrFinancials (income statement +
// balance sheet), PrTrialBalance (also box movements and party balances), PrJournalEntry, the VAT
// return and the recovery code. Every number is a stored value from the API response.

import { BalanceSheet, BoxMovements, IncomeRow, IncomeStatement, PartyBalances, PartyRow, PartyTotals, SheetRow, TrialBalance, TrialRow } from '../../../modules/accounting/reports/reports.models';
import { VatLineGroup, VatReturnDetail } from '../../../modules/accounting/vat.models';
import { escapeHtml, formatDate, formatMoney, formatPercent, formatQty, localizeDigits } from '../print-format';
import { Cell, PrintContext, PrintDocument, a4Header, a4Page, pick, row, closing, signatures, table } from '../print-kit';
import { kpiRow } from './statements';

const money = (ctx: PrintContext, value: number | null | undefined): string => formatMoney(value ?? 0, ctx.lang);
const name = (ctx: PrintContext, item: { nameAr?: string; nameEn?: string }): string => escapeHtml((ctx.lang === 'en' ? item.nameEn || item.nameAr : item.nameAr || item.nameEn) || '');
const checkLine = (text: string, ok: boolean): string =>
  `<div class="keep" style="font-size:13px;font-weight:700;color:${ok ? 'var(--p-brand)' : 'var(--p-danger)'}" data-check>${ok ? '✓' : '✗'} ${escapeHtml(text)}</div>`;

// ---------------------------------------------------------------- PrProfitReport

export interface ProfitReportData {
  /** "آخر ٦ شهور" / the period pill label. */
  periodLabel: string;
  from?: string | null;
  to?: string | null;
  kpis: { sales: number; cost: number; profit: number; margin: number | null };
  /** Profit by month (the year chart): cash profit + credit profit. */
  months: Array<{ label: string; cashProfit: number; creditProfit: number; profit: number }>;
  products: Array<{ name: string; category: string; quantity: number; sales: number; cost: number; profit: number; margin: number | null }>;
}

function profitChart(ctx: PrintContext, months: ProfitReportData['months']): string {
  const width = 714;
  const height = 150;
  const max = Math.max(1, ...months.map((month) => Math.max(month.profit, 0)));
  const slot = width / Math.max(1, months.length);
  // The chart is drawn left to right; in an Arabic (RTL) document the first month is on the right.
  const ordered = ctx.lang === 'ar' ? [...months].reverse() : months;
  const bars = ordered
    .map((month, index) => {
      const barHeight = Math.max(0, month.profit) / max * (height - 34);
      const x = index * slot + slot * 0.2;
      return `<rect x="${x.toFixed(1)}" y="${(height - 20 - barHeight).toFixed(1)}" width="${(slot * 0.6).toFixed(1)}" height="${barHeight.toFixed(1)}" rx="3" fill="#0E4D45"/>
      <text x="${(index * slot + slot / 2).toFixed(1)}" y="${height - 5}" font-size="10" text-anchor="middle" fill="#4A5856">${escapeHtml(localizeDigits(month.label, ctx.lang))}</text>`;
    })
    .join('');
  return `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img" data-chart style="direction:ltr">${bars}<line x1="0" y1="${height - 20}" x2="${width}" y2="${height - 20}" stroke="#9A9A9A"/></svg>`;
}

export function profitReport(ctx: PrintContext, data: ProfitReportData): PrintDocument {
  const monthRows = data.months
    .map((month) => row([escapeHtml(month.label), { html: money(ctx, month.cashProfit), numeric: true }, { html: money(ctx, month.creditProfit), numeric: true }, { html: money(ctx, month.profit), numeric: true, bold: true }]))
    .join('');
  const productRows = data.products
    .map((product, index): string => {
      const cells: Cell[] = [
        { html: localizeDigits(String(index + 1), ctx.lang), numeric: true },
        escapeHtml(product.name),
        escapeHtml(product.category),
        { html: formatQty(product.quantity, ctx.lang), numeric: true },
        { html: money(ctx, product.sales), numeric: true },
        { html: money(ctx, product.cost), numeric: true },
        { html: money(ctx, product.profit), numeric: true, bold: true },
        { html: product.margin === null ? '—' : formatPercent(product.margin, ctx.lang), numeric: true },
      ];
      return row(cells);
    })
    .join('');
  const body = a4Page(`
  ${a4Header(ctx, { title: pick(ctx, 'تقرير الأرباح', 'Profit report'), no: data.periodLabel, date: formatDate(ctx.printedAt, ctx.lang), extraLabel: pick(ctx, 'الفترة', 'Period'), extra: data.from || data.to ? `${formatDate(data.from, ctx.lang)} — ${formatDate(data.to, ctx.lang)}` : pick(ctx, 'كل الفترات', 'All time') })}
  ${kpiRow([
    { label: pick(ctx, 'صافي المبيعات', 'Net sales'), value: money(ctx, data.kpis.sales) },
    { label: pick(ctx, 'تكلفة البضاعة', 'Cost of goods'), value: money(ctx, data.kpis.cost) },
    { label: pick(ctx, 'مجمل الربح', 'Gross profit'), value: money(ctx, data.kpis.profit), strong: true },
    { label: pick(ctx, 'هامش الربح', 'Profit margin'), value: data.kpis.margin === null ? '—' : formatPercent(data.kpis.margin, ctx.lang) },
  ])}
  ${data.months.length ? `<div class="col keep" style="gap:6px"><span style="font-weight:800;font-size:13px;color:var(--p-brand)">${pick(ctx, 'الربح بالشهر', 'Profit by month')}</span>${profitChart(ctx, data.months)}</div>
  ${table([{ label: pick(ctx, 'الشهر', 'Month') }, { label: pick(ctx, 'ربح كاش', 'Cash profit'), numeric: true }, { label: pick(ctx, 'ربح آجل', 'Credit profit'), numeric: true }, { label: pick(ctx, 'الربح', 'Profit'), numeric: true }], monthRows)}` : ''}
  ${table(
    [
      { label: '#', width: 36 },
      { label: pick(ctx, 'الصنف', 'Item') },
      { label: pick(ctx, 'الفئة', 'Category') },
      { label: pick(ctx, 'الكمية', 'Qty'), numeric: true, width: 62 },
      { label: pick(ctx, 'المبيعات', 'Sales'), numeric: true, width: 90 },
      { label: pick(ctx, 'التكلفة', 'Cost'), numeric: true, width: 90 },
      { label: pick(ctx, 'الربح', 'Profit'), numeric: true, width: 90 },
      { label: pick(ctx, 'الهامش', 'Margin'), numeric: true, width: 62 },
    ],
    productRows
  )}
  <div class="muted keep" style="font-size:12px">${pick(ctx, 'الربح هنا = سعر البيع − سعر الشراء، قبل المصروفات. صافي الربح بعد المصروفات في قائمة الدخل.', 'Profit here = selling price − purchase price, before expenses. Net profit after expenses is in the income statement.')}</div>
  `);
  return { paper: 'A4', title: pick(ctx, 'تقرير الأرباح', 'Profit report'), body, pageNumbers: true };
}

// ---------------------------------------------------------------- PrFinancials

const sec = (text: string): string => `<div style="font-weight:800;font-size:13px;padding:12px 0 4px;color:var(--p-brand);border-bottom:1px solid var(--p-text)">${text}</div>`;
const line = (label: string, value: string, options: { indent?: boolean; total?: boolean; bold?: boolean } = {}): string =>
  `<div class="row n" style="justify-content:space-between;padding:${options.total ? '9px 0 7px' : '7px 0'};border-bottom:${options.total ? 'none' : '1px solid var(--p-line)'};${options.total ? 'border-top:2px solid var(--p-text);font-weight:800;' : ''}${options.bold ? 'font-weight:700;' : ''}font-size:13px"><span${options.indent ? ' style="padding-inline-start:18px"' : ''}>${label}</span><span>${value}</span></div>`;
const card = (inner: string): string => `<div class="col" style="border:1px solid var(--p-border);border-radius:8px;padding:14px 18px">${inner}</div>`;

function signed(ctx: PrintContext, value: number, sign: number): string {
  return sign < 0 && value !== 0 ? `(${money(ctx, Math.abs(value))})` : money(ctx, value);
}

function incomeBlock(ctx: PrintContext, report: IncomeStatement): string {
  const out: string[] = [];
  const render = (rows: IncomeRow[], depth: number): void => {
    for (const item of rows) {
      if (item.isZero && item.kind !== 'total' && item.kind !== 'subtotal') continue;
      if (item.kind === 'group') {
        out.push(sec(name(ctx, item)));
        render(item.children || [], depth + 1);
      } else if (item.kind === 'percent') {
        out.push(line(name(ctx, item), formatPercent(item.amount, ctx.lang)));
      } else if (item.kind === 'line') {
        out.push(line(name(ctx, item), signed(ctx, item.amount, item.sign), { indent: depth > 0 }));
      } else {
        out.push(line(name(ctx, item), signed(ctx, item.amount, item.sign), { total: item.kind === 'total', bold: true }));
      }
    }
  };
  render(report.rows, 0);
  const period = `${formatDate(report.period.from, ctx.lang)} — ${formatDate(report.period.to, ctx.lang)}`;
  return card(`<div style="font-size:16px;font-weight:800" data-statement="income">${pick(ctx, 'قائمة الدخل', 'Income statement')}</div>
    <div class="muted" style="font-size:12px;margin-bottom:4px">${escapeHtml(period)} · ${pick(ctx, 'بالجنيه', 'in EGP')}</div>${out.join('')}`);
}

function balanceBlock(ctx: PrintContext, report: BalanceSheet): string {
  const sectionRows = (section: SheetRow): string =>
    (section.children || [])
      .flatMap((child) => (child.kind === 'group' ? [line(`<b>${name(ctx, child)}</b>`, '', {}), ...(child.children || []).filter((leaf) => !leaf.isZero).map((leaf) => line(name(ctx, leaf), money(ctx, leaf.amount), { indent: true }))] : child.isZero ? [] : [line(name(ctx, child), money(ctx, child.amount), { indent: true })]))
      .join('');
  const { assets, liabilities, equity } = report.sections;
  const balanced = Math.abs(report.check.difference) < 0.005;
  return card(`<div style="font-size:16px;font-weight:800" data-statement="balance">${pick(ctx, 'الميزانية', 'Balance sheet')}</div>
    <div class="muted" style="font-size:12px;margin-bottom:4px">${pick(ctx, 'في', 'As of')} ${formatDate(report.asOf, ctx.lang)} · ${pick(ctx, 'بالجنيه', 'in EGP')}</div>
    ${sec(name(ctx, assets))}${sectionRows(assets)}${line(pick(ctx, 'إجمالي الأصول', 'Total assets'), money(ctx, report.totals.assets), { total: true })}
    ${sec(name(ctx, liabilities))}${sectionRows(liabilities)}
    ${sec(name(ctx, equity))}${sectionRows(equity)}${report.periodProfit ? line(pick(ctx, 'أرباح الفترة', 'Profit for the period'), money(ctx, report.periodProfit), { indent: true }) : ''}
    ${line(pick(ctx, 'الخصوم + حقوق الملكية', 'Liabilities + equity'), money(ctx, report.totals.liabilitiesAndEquity), { total: true })}`);
}

export interface FinancialsData {
  income?: IncomeStatement | null;
  balance?: BalanceSheet | null;
  trialBalanced?: boolean | null;
}

export function financials(ctx: PrintContext, data: FinancialsData): PrintDocument {
  const period = data.income ? data.income.period : data.balance ? { from: data.balance.asOf, to: data.balance.asOf } : null;
  const balance = data.balance;
  const balanced = balance ? Math.abs(balance.check.difference) < 0.005 : true;
  const verdict = balance
    ? checkLine(
        balanced
          ? `${pick(ctx, 'الميزانية متوازنة: الأصول', 'The balance sheet balances: assets')} (${money(ctx, balance.totals.assets)}) = ${pick(ctx, 'الخصوم وحقوق الملكية', 'liabilities and equity')} (${money(ctx, balance.totals.liabilitiesAndEquity)})${data.trialBalanced ? ` · ${pick(ctx, 'ميزان المراجعة متوازن', 'the trial balance balances')}` : ''}`
          : `${pick(ctx, 'الميزانية غير متوازنة، الفرق', 'The balance sheet does not balance, difference')} ${money(ctx, balance.check.difference)}`,
        balanced
      )
    : '';
  const body = a4Page(`
  ${a4Header(ctx, {
    title: pick(ctx, 'القوائم المالية', 'Financial statements'),
    no: period ? `${formatDate(period.from, ctx.lang)}` : '',
    date: formatDate(ctx.printedAt, ctx.lang),
    extraLabel: period ? pick(ctx, 'الفترة', 'Period') : '',
    extra: period ? `${formatDate(period.from, ctx.lang)} — ${formatDate(period.to, ctx.lang)}` : '',
  })}
  <div class="keep" style="display:grid;grid-template-columns:repeat(${data.income && data.balance ? 2 : 1},minmax(0,1fr));gap:14px;align-items:start" data-statements>
    ${data.income ? incomeBlock(ctx, data.income) : ''}
    ${data.balance ? balanceBlock(ctx, data.balance) : ''}
  </div>
  ${verdict}
  <div class="grow"></div>
  ${closing(ctx, [
    { who: pick(ctx, 'المحاسب', 'Accountant'), line: pick(ctx, 'الاسم والتوقيع', 'Name and signature') },
    { who: pick(ctx, 'المالك', 'Owner'), line: pick(ctx, 'اعتماد', 'Approval') },
  ])}`);
  return { paper: 'A4', title: pick(ctx, 'القوائم المالية', 'Financial statements'), body, pageNumbers: true };
}

// ---------------------------------------------------------------- PrTrialBalance (and box movements, party balances)

export function trialBalance(ctx: PrintContext, report: TrialBalance): PrintDocument {
  const rows: string[] = [];
  const walk = (items: TrialRow[]): void => {
    for (const item of items) {
      if (item.isZero) continue;
      if (item.kind === 'group') {
        rows.push(`<tr class="group"><td colspan="4">${escapeHtml(localizeDigits(item.code, ctx.lang))} · ${name(ctx, item)}</td></tr>`);
        walk(item.children || []);
      } else {
        rows.push(row([{ html: escapeHtml(localizeDigits(item.code, ctx.lang)), numeric: false }, name(ctx, item), { html: item.closingDebit ? money(ctx, item.closingDebit) : '', numeric: true }, { html: item.closingCredit ? money(ctx, item.closingCredit) : '', numeric: true }]));
      }
    }
  };
  walk(report.rows);
  const foot = `<tr class="grand"><td colspan="2">${pick(ctx, 'الإجمالي', 'Total')}</td><td class="n" data-total-debit>${money(ctx, report.totals.closingDebit)}</td><td class="n" data-total-credit>${money(ctx, report.totals.closingCredit)}</td></tr>`;
  const diff = Math.round((report.totals.closingDebit - report.totals.closingCredit) * 100) / 100;
  const body = a4Page(`
  ${a4Header(ctx, { title: pick(ctx, 'ميزان المراجعة', 'Trial balance'), no: `${formatDate(report.period.from, ctx.lang)} — ${formatDate(report.period.to, ctx.lang)}`, date: formatDate(ctx.printedAt, ctx.lang), extraLabel: pick(ctx, 'بالأرصدة في', 'Balances as of'), extra: formatDate(report.period.to, ctx.lang) })}
  ${table([{ label: pick(ctx, 'الكود', 'Code'), width: 70 }, { label: pick(ctx, 'الحساب', 'Account') }, { label: pick(ctx, 'مدين', 'Debit'), numeric: true, width: 130 }, { label: pick(ctx, 'دائن', 'Credit'), numeric: true, width: 130 }], rows.join(''), { foot })}
  ${checkLine(report.balanced ? `${pick(ctx, 'الميزان متوازن: إجمالي المدين = إجمالي الدائن · الفرق', 'The trial balance balances: total debit = total credit · difference')} ${money(ctx, diff)}` : `${pick(ctx, 'الميزان غير متوازن، الفرق', 'The trial balance does not balance, difference')} ${money(ctx, diff)}`, report.balanced)}
  <div class="grow"></div>
  ${closing(ctx, [
    { who: pick(ctx, 'المحاسب', 'Accountant'), line: pick(ctx, 'الاسم والتوقيع', 'Name and signature') },
    { who: pick(ctx, 'راجع واعتمد', 'Reviewed and approved'), line: pick(ctx, 'الاسم والتوقيع', 'Name and signature') },
  ])}`);
  return { paper: 'A4', title: pick(ctx, 'ميزان المراجعة', 'Trial balance'), body, pageNumbers: true };
}

export function boxMovements(ctx: PrintContext, report: BoxMovements): PrintDocument {
  const rows = report.boxes
    .map((box) => row([escapeHtml(box.name), { html: money(ctx, box.opening), numeric: true }, { html: money(ctx, box.in), numeric: true }, { html: money(ctx, box.out), numeric: true }, { html: money(ctx, box.closing), numeric: true, bold: true }]))
    .join('');
  const foot = `<tr class="grand"><td>${pick(ctx, 'الإجمالي', 'Total')}</td><td class="n">${money(ctx, report.totals.opening)}</td><td class="n">${money(ctx, report.totals.in)}</td><td class="n">${money(ctx, report.totals.out)}</td><td class="n">${money(ctx, report.totals.closing)}</td></tr>`;
  const body = a4Page(`
  ${a4Header(ctx, { title: pick(ctx, 'حركة الخزائن', 'Cash box movements'), date: formatDate(ctx.printedAt, ctx.lang), extraLabel: pick(ctx, 'الفترة', 'Period'), extra: `${formatDate(report.period.from, ctx.lang)} — ${formatDate(report.period.to, ctx.lang)}` })}
  ${table([{ label: pick(ctx, 'الخزنة', 'Box') }, { label: pick(ctx, 'رصيد أول الفترة', 'Opening'), numeric: true, width: 110 }, { label: pick(ctx, 'داخل', 'In'), numeric: true, width: 110 }, { label: pick(ctx, 'خارج', 'Out'), numeric: true, width: 110 }, { label: pick(ctx, 'الرصيد', 'Closing'), numeric: true, width: 110 }], rows, { foot })}
  `);
  return { paper: 'A4', title: pick(ctx, 'حركة الخزائن', 'Cash box movements'), body, pageNumbers: true };
}

export function partyBalances(ctx: PrintContext, report: PartyBalances): PrintDocument {
  const part = (title: string, rowsOf: PartyRow[] | undefined, totals: PartyTotals): string => {
    if (!rowsOf) return '';
    const rows = rowsOf
      .filter((entry) => !entry.isZero)
      .map((entry) => row([escapeHtml(entry.name), { html: money(ctx, entry.balance), numeric: true, bold: true }, { html: money(ctx, entry.aging.current), numeric: true }, { html: money(ctx, entry.aging.d1_30), numeric: true }, { html: money(ctx, entry.aging.d31_60), numeric: true }, { html: money(ctx, entry.aging.d61_90), numeric: true }, { html: money(ctx, entry.aging.d90plus), numeric: true }]))
      .join('');
    const foot = `<tr class="grand"><td>${pick(ctx, 'الإجمالي', 'Total')} (${formatQty(totals.count, ctx.lang)})</td><td class="n">${money(ctx, totals.balance)}</td><td class="n">${money(ctx, totals.current)}</td><td class="n">${money(ctx, totals.d1_30)}</td><td class="n">${money(ctx, totals.d31_60)}</td><td class="n">${money(ctx, totals.d61_90)}</td><td class="n">${money(ctx, totals.d90plus)}</td></tr>`;
    return `<div class="col" style="gap:6px"><span style="font-weight:800;font-size:14px;color:var(--p-brand)">${title}</span>${table([{ label: pick(ctx, 'الاسم', 'Name') }, { label: pick(ctx, 'الرصيد', 'Balance'), numeric: true, width: 92 }, { label: pick(ctx, 'لم يستحق', 'Current'), numeric: true, width: 78 }, { label: '1–30', numeric: true, width: 78 }, { label: '31–60', numeric: true, width: 78 }, { label: '61–90', numeric: true, width: 78 }, { label: '90+', numeric: true, width: 78 }], rows, { foot })}</div>`;
  };
  const body = a4Page(`
  ${a4Header(ctx, { title: pick(ctx, 'أرصدة العملاء والموردين', 'Customer and supplier balances'), date: formatDate(ctx.printedAt, ctx.lang), extraLabel: pick(ctx, 'بالأرصدة في', 'Balances as of'), extra: formatDate(report.asOf, ctx.lang) })}
  ${report.customers ? part(pick(ctx, 'العملاء (مدينون لنا)', 'Customers (owe us)'), report.customers.rows, report.customers.totals) : ''}
  ${report.suppliers ? part(pick(ctx, 'الموردون (نحن مدينون لهم)', 'Suppliers (we owe)'), report.suppliers.rows, report.suppliers.totals) : ''}
  `);
  return { paper: 'A4', title: pick(ctx, 'أرصدة العملاء والموردين', 'Customer and supplier balances'), body, pageNumbers: true };
}

// ---------------------------------------------------------------- PrJournalEntry

export interface JournalEntryData {
  number: string;
  date: string | Date | null;
  typeLabel: string;
  sourceNumber?: string | null;
  partyName?: string | null;
  memo?: string | null;
  lines: Array<{ code: string; name: string; memo?: string | null; debit: number; credit: number }>;
  totalDebit: number;
  totalCredit: number;
  /** "قيود مرتبطة": text lines (the entry it reverses, the entry that reversed it, ...). */
  related: string[];
  preparedBy?: string | null;
}

export function journalEntry(ctx: PrintContext, data: JournalEntryData): PrintDocument {
  const rows = data.lines
    .map((entry, index): string => {
      const cells: Cell[] = [
        { html: localizeDigits(String(index + 1), ctx.lang), numeric: true },
        { html: escapeHtml(localizeDigits(entry.code, ctx.lang)), numeric: false },
        escapeHtml(entry.name),
        escapeHtml(entry.memo || ''),
        { html: entry.debit ? money(ctx, entry.debit) : '', numeric: true },
        { html: entry.credit ? money(ctx, entry.credit) : '', numeric: true },
      ];
      return row(cells);
    })
    .join('');
  const balanced = Math.abs(data.totalDebit - data.totalCredit) < 0.005;
  const foot = `<tr class="total"><td colspan="4">${pick(ctx, 'الإجمالي', 'Total')}</td><td class="n">${money(ctx, data.totalDebit)}</td><td class="n">${money(ctx, data.totalCredit)}</td></tr>`;
  const meta = [
    [pick(ctx, 'النوع', 'Type'), escapeHtml(data.typeLabel)],
    data.sourceNumber ? [pick(ctx, 'المستند المصدر', 'Source document'), `<span class="code n">${escapeHtml(data.sourceNumber)}</span>`] : null,
    data.partyName ? [pick(ctx, 'الطرف', 'Party'), escapeHtml(data.partyName)] : null,
  ].filter(Boolean) as string[][];
  const body = a4Page(`
  ${a4Header(ctx, { title: pick(ctx, 'قيد يومية', 'Journal entry'), no: data.number, date: formatDate(data.date, ctx.lang), extraLabel: pick(ctx, 'الحالة', 'Status'), extra: pick(ctx, 'مُرحَّل', 'Posted') })}
  <div class="row keep" style="gap:30px;flex-wrap:wrap;font-size:13px" data-meta>${meta.map(([label, value]) => `<span><span class="muted">${label}</span> <b>${value}</b></span>`).join('')}</div>
  ${data.memo ? `<div class="box keep" style="font-size:13px" data-memo><span class="muted">${pick(ctx, 'البيان', 'Memo')}:</span> ${escapeHtml(data.memo)}</div>` : ''}
  ${table([{ label: '#', width: 36 }, { label: pick(ctx, 'الكود', 'Code'), width: 64 }, { label: pick(ctx, 'الحساب', 'Account') }, { label: pick(ctx, 'البيان', 'Memo') }, { label: pick(ctx, 'مدين', 'Debit'), numeric: true, width: 100 }, { label: pick(ctx, 'دائن', 'Credit'), numeric: true, width: 100 }], rows, { foot })}
  ${checkLine(balanced ? `${pick(ctx, 'القيد متوازن · الفرق', 'The entry balances · difference')} ${money(ctx, data.totalDebit - data.totalCredit)}` : pick(ctx, 'القيد غير متوازن', 'The entry does not balance'), balanced)}
  ${data.related.length ? `<div class="box keep muted" style="font-size:13px" data-related><b>${pick(ctx, 'قيود مرتبطة', 'Related entries')}:</b> ${data.related.map(escapeHtml).join(' · ')}</div>` : ''}
  <div class="muted keep" style="font-size:12px">${pick(ctx, 'القيد المرحَّل مايتعدلش ولا يتمسح. لو فيه غلط بيتعمل قيد عكسي بنفس القيمة ويتربط بالقيد ده.', 'A posted entry cannot be edited or deleted. A mistake is corrected by a reversing entry of the same amount, linked to this one.')}</div>
  <div class="grow"></div>
  ${closing(ctx, [
    { who: `${pick(ctx, 'إعداد', 'Prepared by')} ${data.preparedBy || pick(ctx, 'النظام', 'the system')}`, line: pick(ctx, 'الاسم والتوقيع', 'Name and signature') },
    { who: pick(ctx, 'اعتماد', 'Approved by'), line: pick(ctx, 'الاسم والتوقيع', 'Name and signature') },
  ])}`);
  return { paper: 'A4', title: data.number, body, pageNumbers: true };
}

// ---------------------------------------------------------------- the VAT return

const VAT_GROUP_LABELS: Record<VatLineGroup, { ar: string; en: string }> = {
  sales: { ar: 'مبيعات (ضريبة مخرجات)', en: 'Sales (output VAT)' },
  returns: { ar: 'مرتجعات مبيعات', en: 'Sales returns' },
  purchases: { ar: 'مشتريات (ضريبة مدخلات)', en: 'Purchases (input VAT)' },
  purchaseReturns: { ar: 'مرتجعات مشتريات', en: 'Purchase returns' },
  expenses: { ar: 'مصروفات', en: 'Expenses' },
};

export function vatReturn(ctx: PrintContext, data: VatReturnDetail): PrintDocument {
  const groups = (Object.keys(VAT_GROUP_LABELS) as VatLineGroup[])
    .map((key) => {
      // The totals the API stores for the group; lines are only a fallback for an answer without them.
      const lines = data.lines[key] || [];
      const stored = data.groupTotals?.[key];
      const count = stored ? stored.count : lines.length;
      const net = stored ? stored.net : Math.round(lines.reduce((sum, entry) => sum + entry.net, 0) * 100) / 100;
      const vat = stored ? stored.vat : Math.round(lines.reduce((sum, entry) => sum + entry.vat, 0) * 100) / 100;
      return row([pick(ctx, VAT_GROUP_LABELS[key].ar, VAT_GROUP_LABELS[key].en), { html: formatQty(count, ctx.lang), numeric: true }, { html: money(ctx, net), numeric: true }, { html: money(ctx, vat), numeric: true, bold: true }]);
    })
    .join('');
  const statusLabel: Record<string, [string, string]> = { open: ['مفتوح', 'Open'], filed: ['مقدَّم', 'Filed'], paid: ['مسدَّد', 'Paid'], partial: ['مسدَّد جزئيًا', 'Partly paid'] };
  const status = statusLabel[data.status] || ['', ''];
  const summary = [
    [pick(ctx, 'ضريبة المخرجات (المبيعات − المرتجعات)', 'Output VAT (sales − returns)'), data.output],
    [pick(ctx, 'ضريبة المدخلات (مشتريات ومصروفات)', 'Input VAT (purchases and expenses)'), data.input],
    [pick(ctx, 'رصيد دائن مرحَّل من الإقرار السابق', 'Credit carried in from the previous return'), data.carriedIn],
    [pick(ctx, 'الصافي (مخرجات − مدخلات − مرحَّل)', 'Net (output − input − carried in)'), data.net],
    [pick(ctx, 'المستحق السداد', 'Payable'), data.payable],
    [pick(ctx, 'رصيد دائن يُرحَّل للشهر التالي', 'Credit carried forward'), data.credit],
    [pick(ctx, 'المسدَّد', 'Paid'), data.paid],
    [pick(ctx, 'المتبقي', 'Remaining'), data.remaining],
  ] as Array<[string, number]>;
  const payments = data.payments.length
    ? table([{ label: pick(ctx, 'سداد', 'Payment') }, { label: pick(ctx, 'التاريخ', 'Date'), numeric: true }, { label: pick(ctx, 'الخزنة', 'Box') }, { label: pick(ctx, 'المبلغ', 'Amount'), numeric: true }], data.payments.map((payment) => row([{ html: escapeHtml(payment.number), code: true }, { html: formatDate(payment.date, ctx.lang), numeric: true }, escapeHtml(payment.boxName || ''), { html: money(ctx, payment.amount), numeric: true }])).join(''))
    : '';
  const body = a4Page(`
  ${a4Header(ctx, { title: pick(ctx, 'الإقرار الضريبي', 'VAT return'), no: data.number || localizeDigits(data.period, ctx.lang), date: formatDate(ctx.printedAt, ctx.lang), extraLabel: pick(ctx, 'الفترة', 'Period'), extra: localizeDigits(data.period, ctx.lang), extra2Label: pick(ctx, 'الحالة', 'Status'), extra2: pick(ctx, status[0], status[1]) })}
  ${kpiRow([
    { label: pick(ctx, 'ضريبة المخرجات', 'Output VAT'), value: money(ctx, data.output) },
    { label: pick(ctx, 'ضريبة المدخلات', 'Input VAT'), value: money(ctx, data.input) },
    { label: data.net >= 0 ? pick(ctx, 'المستحق السداد', 'Payable') : pick(ctx, 'رصيد دائن', 'Credit'), value: money(ctx, Math.abs(data.net)), strong: true },
  ])}
  ${table([{ label: pick(ctx, 'البند', 'Item') }, { label: pick(ctx, 'المستندات', 'Documents'), numeric: true, width: 90 }, { label: pick(ctx, 'الصافي', 'Net'), numeric: true, width: 120 }, { label: pick(ctx, 'الضريبة', 'VAT'), numeric: true, width: 120 }], groups, { extraClass: 'compact' })}
  <table class="t compact" style="width:100%" data-summary><tbody>${summary.map(([label, value]) => `<tr><td>${label}</td><td class="n" style="width:140px;font-weight:700">${money(ctx, value)}</td></tr>`).join('')}</tbody></table>
  ${payments}
  ${data.filedAt ? `<div class="muted keep" style="font-size:12px">${pick(ctx, 'تاريخ التقديم', 'Filed on')} ${formatDate(data.filedAt, ctx.lang)}</div>` : ''}
  <div class="grow"></div>
  ${closing(ctx, [
    { who: pick(ctx, 'المحاسب', 'Accountant'), line: pick(ctx, 'الاسم والتوقيع', 'Name and signature') },
    { who: pick(ctx, 'المالك', 'Owner'), line: pick(ctx, 'اعتماد', 'Approval') },
  ])}`);
  return { paper: 'A4', title: `${pick(ctx, 'الإقرار الضريبي', 'VAT return')} ${data.period}`, body, pageNumbers: true };
}

// ---------------------------------------------------------------- the recovery code

/** The sign-up recovery code: the shared header style, no shop data (the shop may not exist yet). */
export function recoveryCodeSheet(ctx: PrintContext, data: { code: string }): PrintDocument {
  const body = a4Page(`
  ${a4Header({ ...ctx, shop: null }, { title: pick(ctx, 'كود استرداد الحساب', 'Account recovery code'), date: formatDate(ctx.printedAt, ctx.lang) })}
  <div class="box col" style="gap:14px;align-items:center;padding:30px">
    <span class="lbl">${pick(ctx, 'كود الاسترداد', 'Recovery code')}</span>
    <span class="code n" style="font-size:30px;font-weight:800;letter-spacing:3px" data-code>${escapeHtml(data.code)}</span>
  </div>
  <div class="col" style="gap:8px;font-size:14px;line-height:1.9">
    <span>${pick(ctx, 'احتفظ بهذه الورقة في مكان آمن. الكود يظهر مرة واحدة فقط، ومن خلاله يمكن استرداد حساب المالك لو نسيت كلمة المرور.', 'Keep this sheet somewhere safe. The code is shown only once and lets you recover the owner account if you forget the password.')}</span>
    <span>${pick(ctx, 'لا تشارك الكود مع أي شخص.', 'Do not share the code with anyone.')}</span>
  </div>`);
  return { paper: 'A4', title: pick(ctx, 'كود استرداد الحساب', 'Account recovery code'), body };
}

