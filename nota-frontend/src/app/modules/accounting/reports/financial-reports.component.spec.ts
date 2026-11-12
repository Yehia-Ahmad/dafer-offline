import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, TestRequest, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { TranslateModule } from '@ngx-translate/core';
import { environment } from '../../../../environments/environment';
import { LanguageService } from '../../shared/services/translation.service';
import { ShopProfileService } from '../../shop-profile/services/shop-profile.service';
import { FinancialReportsComponent, REPORTS_PRINT_ENABLED } from './financial-reports.component';
import { BalanceSheet, BoxMovements, IncomeRow, IncomeStatement, PartyBalances, TrialBalance } from './reports.models';

const base = `${environment.api_base_url}reports`;
const pad = (value: number) => String(value).padStart(2, '0');
const key = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const now = new Date();
const monthStart = key(new Date(now.getFullYear(), now.getMonth(), 1));
const monthEnd = key(new Date(now.getFullYear(), now.getMonth() + 1, 0));
const lastStart = key(new Date(now.getFullYear(), now.getMonth() - 1, 1));
const lastEnd = key(new Date(now.getFullYear(), now.getMonth(), 0));

const line = (id: string, nameAr: string, nameEn: string, amount: number, extra: Partial<IncomeRow> = {}): IncomeRow => ({
  id, kind: 'line', accountId: `acc-${id}`, code: id, nameAr, nameEn, sign: 1, amount, previous: null, change: null, isZero: amount === 0, ...extra,
});
/** The design's October. */
const INCOME: IncomeStatement = {
  report: 'income-statement', period: { from: '2026-10-01', to: '2026-10-31' }, comparison: null, shopName: 'النور للأدوات الكهربائية', currency: 'EGP',
  rows: [
    line('410', 'المبيعات', 'Sales', 37450),
    line('430', 'مردودات المبيعات', 'Sales returns', 0, { sign: -1 }),
    line('420', 'خصم مسموح به', 'Sales discount', 650, { sign: -1 }),
    { id: 'netSales', kind: 'subtotal', nameAr: 'صافي المبيعات', nameEn: 'Net sales', sign: 1, amount: 36800, previous: null, change: null, isZero: false },
    line('510', 'تكلفة البضاعة المباعة', 'Cost of goods sold', 25300, { sign: -1 }),
    { id: 'grossProfit', kind: 'subtotal', nameAr: 'مجمل الربح', nameEn: 'Gross profit', sign: 1, amount: 11500, previous: null, change: null, isZero: false },
    { id: 'expenses', kind: 'group', nameAr: 'المصروفات', nameEn: 'Expenses', sign: -1, amount: 9400, previous: null, change: null, isZero: false, children: [
      { id: '520', kind: 'group', accountId: 'acc-520', code: '520', nameAr: 'مصروفات تشغيل', nameEn: 'Operating expenses', sign: -1, amount: 9400, previous: null, change: null, isZero: false, children: [
        line('521', 'مرتبات', 'Salaries', 4500, { sign: -1 }), line('522', 'إيجار', 'Rent', 3500, { sign: -1 }), line('523', 'كهرباء ومياه', 'Utilities', 650, { sign: -1 }),
        line('524', 'نقل ومشاوير', 'Transport', 420, { sign: -1 }), line('525', 'مصروفات متنوعة', 'Miscellaneous', 330, { sign: -1 }),
      ] },
      line('530', 'عجز وزيادة الخزينة', 'Cash over/short', 0, { sign: -1 }),
    ] },
    { id: 'netProfit', kind: 'total', nameAr: 'صافي الربح', nameEn: 'Net profit', sign: 1, amount: 2100, previous: null, change: null, isZero: false },
    { id: 'grossMargin', kind: 'percent', nameAr: 'هامش مجمل الربح %', nameEn: 'Gross margin %', sign: 1, amount: 31.25, previous: null, change: null, isZero: false },
  ],
  summary: { sales: 37450, netSales: 36800, cogs: 25300, grossProfit: 11500, totalExpenses: 9400, otherIncome: 0, netProfit: 2100, grossMarginPct: 31.25 },
  check: { ledgerNetProfit: 2100, difference: 0 },
};

const sheetRow = (id: string, code: string, nameEn: string, amount: number, extra: Record<string, unknown> = {}) => ({
  id, kind: 'line' as const, accountId: `acc-${code}`, code, nameAr: nameEn, nameEn, amount, balance: amount, side: 'debit' as const, absBalance: Math.abs(amount), opposite: false, isZero: amount === 0, ...extra,
});
const SHEET: BalanceSheet = {
  report: 'balance-sheet', asOf: '2026-10-31', shopName: 'النور', currency: 'EGP', periodProfit: 2100,
  sections: {
    assets: { ...sheetRow('1', '1', 'Assets', 178450), kind: 'group', children: [sheetRow('1111', '1111', 'Main cash', 69250), sheetRow('113', '113', 'Customers', 12900), sheetRow('114', '114', 'Inventory', 96300), sheetRow('115', '115', 'VAT input', 0, { isZero: true }), sheetRow('1112', '1112', 'Old box', -50, { opposite: true, side: 'credit' })] },
    liabilities: { ...sheetRow('2', '2', 'Liabilities', 14650), kind: 'group', children: [sheetRow('21', '21', 'Suppliers', 14650, { side: 'credit' })] },
    equity: { ...sheetRow('3', '3', 'Equity', 163800), kind: 'group', children: [sheetRow('31', '31', 'Capital', 150000, { side: 'credit' }), sheetRow('32', '32', 'Retained earnings', 11700, { side: 'credit' }), sheetRow('currentProfit', '', 'Current-period profit', 2100, { accountId: undefined, code: undefined })] },
  },
  totals: { assets: 178450, liabilities: 14650, equity: 163800, liabilitiesAndEquity: 178450 },
  check: { assets: 178450, liabilitiesAndEquity: 178450, difference: 0 },
};

const trialRow = (code: string, name: string, cols: number[], extra: Record<string, unknown> = {}) => ({
  id: code, kind: 'line' as const, accountId: `acc-${code}`, code, nameAr: name, nameEn: name,
  openingDebit: cols[0], openingCredit: cols[1], movementDebit: cols[2], movementCredit: cols[3], closingDebit: cols[4], closingCredit: cols[5], isZero: cols.every((v) => v === 0), ...extra,
});
const TRIAL: TrialBalance = {
  report: 'trial-balance', period: { from: '2026-10-01', to: '2026-10-31' }, shopName: 'النور', currency: 'EGP', balanced: true,
  rows: [
    { ...trialRow('5', 'Expenses', [0, 0, 9400, 0, 9400, 0]), kind: 'group', accountId: undefined, children: [trialRow('521', 'Salaries', [0, 0, 4500, 0, 4500, 0]), trialRow('522', 'Rent', [0, 0, 3500, 0, 3500, 0]), trialRow('530', 'Cash over/short', [0, 0, 0, 0, 0, 0])] },
  ],
  totals: { openingDebit: 100, openingCredit: 100, movementDebit: 9400, movementCredit: 9400, closingDebit: 9500, closingCredit: 9500 },
};

const BOXES: BoxMovements = {
  report: 'box-movements', period: { from: '2026-10-01', to: '2026-10-31' }, shopName: 'النور', currency: 'EGP',
  boxes: [
    { boxId: 'b1', accountId: 'a1', name: 'الخزنة الرئيسية', type: 'cash', isMain: true, isActive: true, accountCode: '1111', opening: 50000, in: 29600, out: 9400, closing: 70200,
      byKind: [{ key: 'sales', ar: 'مبيعات', en: 'Sales', in: 29600, out: 0 }, { key: 'expenses', ar: 'مصروفات', en: 'Expenses', in: 0, out: 9400 }] },
    { boxId: 'b2', accountId: 'a2', name: 'فودافون كاش', type: 'wallet', isMain: false, isActive: false, accountCode: '11201', opening: 0, in: 0, out: 0, closing: 0, byKind: [] },
  ],
  totals: { opening: 50000, in: 29600, out: 9400, closing: 70200, byKind: [] },
};

const aging = (current: number, d1: number, d31: number, d61: number, d90: number) => ({ current, d1_30: d1, d31_60: d31, d61_90: d61, d90plus: d90, total: current + d1 + d31 + d61 + d90 });
const PARTIES: PartyBalances = {
  report: 'party-balances', asOf: '2026-11-09', shopName: 'النور', currency: 'EGP',
  customers: {
    rows: [
      { partyId: 'c1', name: 'م. سامي', phone: null, balance: 7200, side: 'debit', absBalance: 7200, opposite: false, aging: aging(0, 0, 7200, 0, 0), advance: 0, isZero: false },
      { partyId: 'c2', name: 'عميل صفر', phone: null, balance: 0, side: 'debit', absBalance: 0, opposite: false, aging: aging(0, 0, 0, 0, 0), advance: 0, isZero: true },
      { partyId: 'c3', name: 'عميل دائن', phone: null, balance: -300, side: 'credit', absBalance: 300, opposite: true, aging: aging(0, 0, 0, 0, 0), advance: 300, isZero: false },
    ],
    totals: { count: 3, balance: 6900, current: 0, d1_30: 0, d31_60: 7200, d61_90: 0, d90plus: 0, advance: 300, openTotal: 7200 },
  },
  suppliers: {
    rows: [{ partyId: 's1', name: 'مورد المصنع', phone: null, balance: 600, side: 'credit', absBalance: 600, opposite: false, aging: aging(600, 0, 0, 0, 0), advance: 0, isZero: false }],
    totals: { count: 1, balance: 600, current: 600, d1_30: 0, d31_60: 0, d61_90: 0, d90plus: 0, advance: 0, openTotal: 600 },
  },
};

describe('FinancialReportsComponent (Stage 22)', () => {
  let http: HttpTestingController;
  let fixture: ComponentFixture<FinancialReportsComponent>;
  const el = () => fixture.nativeElement as HTMLElement;
  const settle = async () => { fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges(); };
  const q = (selector: string) => el().querySelector(selector) as HTMLElement | null;
  const qa = (selector: string) => Array.from(el().querySelectorAll(selector)) as HTMLElement[];
  const click = async (selector: string) => { (q(selector) as HTMLElement).click(); await settle(); };
  const expectGet = (path: string): TestRequest => http.expectOne((request) => request.method === 'GET' && request.url === `${base}/${path}`);

  const open = async (lang = 'en') => {
    await TestBed.configureTestingModule({
      imports: [FinancialReportsComponent, TranslateModule.forRoot()],
      providers: [provideRouter([]), provideNoopAnimations(), provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
    TestBed.inject(LanguageService).selectedLanguage.set(lang);
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(FinancialReportsComponent);
    fixture.detectChanges();
  };
  afterEach(() => http.verify());

  it('opens on the income statement for this month, with the filters and the five tabs', async () => {
    await open();
    const request = expectGet('income-statement');
    expect(request.request.params.get('from')).toBe(monthStart);
    expect(request.request.params.get('to')).toBe(monthEnd);
    expect(request.request.params.get('compare')).toBeNull();
    request.flush(INCOME);
    await settle();
    expect(qa('[data-tab]').map((tab) => tab.getAttribute('data-tab'))).toEqual(['income', 'balance', 'trial', 'boxes', 'parties']);
    expect(qa('[data-preset]').map((preset) => preset.getAttribute('data-preset'))).toEqual(['thisMonth', 'lastMonth', 'thisYear', 'custom']);
    expect(q('[data-tab="income"]')?.getAttribute('aria-selected')).toBe('true');
  });

  it('income statement: the design numbers, deductions in brackets, the percentage row, shop name, period and "بالجنيه" in the header', async () => {
    await open();
    expectGet('income-statement').flush(INCOME);
    await settle();
    const amount = (row: string) => q(`[data-row="${row}"] [data-cell="amount"]`)?.textContent?.trim();
    expect(amount('410')).toBe('37,450');
    expect(amount('420')).toBe('(650)');
    expect(amount('netSales')).toBe('36,800');
    expect(amount('510')).toBe('(25,300)');
    expect(amount('grossProfit')).toBe('11,500');
    expect(amount('expenses')).toBe('(9,400)');
    expect(amount('521')).toBe('(4,500)');
    expect(amount('netProfit')).toBe('2,100');
    expect(amount('grossMargin')).toBe('31.25%');
    expect(q('[data-test="shop-name"]')?.textContent).toContain('النور للأدوات الكهربائية');
    expect(q('[data-test="report-sub"]')?.textContent).toContain('reports.periodRange');
    expect(q('[data-test="currency"]')?.textContent).toContain('reports.currency');
    // indentation follows the chart: 521 is under 520 under المصروفات
    const pad521 = (q('[data-row="521"] td') as HTMLElement).style.paddingInlineStart;
    const pad520 = (q('[data-row="520"] td') as HTMLElement).style.paddingInlineStart;
    expect(parseInt(pad521, 10)).toBeGreaterThan(parseInt(pad520, 10));
  });

  it('zero rows are hidden behind a toggle; subtotals stay', async () => {
    await open();
    expectGet('income-statement').flush(INCOME);
    await settle();
    expect(q('[data-row="430"]')).toBeNull(); expect(q('[data-row="530"]')).toBeNull();
    expect(q('[data-row="netSales"]')).not.toBeNull();
    const toggle = q('[data-test="zero-toggle"]') as HTMLInputElement;
    toggle.click(); await settle();
    expect(q('[data-row="430"]')).not.toBeNull(); expect(q('[data-row="530"]')).not.toBeNull();
    toggle.click(); await settle();
    expect(q('[data-row="430"]')).toBeNull();
  });

  it('every account line links to its ledger for the period (and from there to the entries)', async () => {
    await open();
    expectGet('income-statement').flush(INCOME);
    await settle();
    const link = q('[data-row="410"] [data-link="ledger"]') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toContain('/accounting/accounts/acc-410/ledger');
    expect(link.getAttribute('href')).toContain('from=2026-10-01');
    expect(link.getAttribute('href')).toContain('to=2026-10-31');
    expect(link.getAttribute('href')).toContain('excludeClosing=1'); // the statement never sees the year-end closing entry, so neither does the ledger
    expect(q('[data-row="netSales"] [data-link]')).toBeNull();
  });

  it('quick picks: last month and this year ask for their own range; a custom range shows the date fields and reloads on change', async () => {
    await open();
    expectGet('income-statement').flush(INCOME);
    await settle();
    await click('[data-preset="lastMonth"]');
    let request = expectGet('income-statement');
    expect(request.request.params.get('from')).toBe(lastStart); expect(request.request.params.get('to')).toBe(lastEnd);
    request.flush(INCOME); await settle();
    await click('[data-preset="thisYear"]');
    request = expectGet('income-statement');
    expect(request.request.params.get('from')).toBe(`${now.getFullYear()}-01-01`); expect(request.request.params.get('to')).toBe(`${now.getFullYear()}-12-31`);
    request.flush(INCOME); await settle();
    expect(q('[data-test="from"]')).toBeNull();
    await click('[data-preset="custom"]');
    expectGet('income-statement').flush(INCOME); await settle();
    const from = q('[data-test="from"]') as HTMLInputElement;
    from.value = '2026-09-10'; from.dispatchEvent(new Event('input')); await settle();
    request = expectGet('income-statement');
    expect(request.request.params.get('from')).toBe('2026-09-10');
    request.flush(INCOME);
  });

  it('"this year" is the fiscal year of the closing settings: from the 1st of fiscalYearStartMonth to the day before it a year later', async () => {
    await open();
    expectGet('income-statement').flush(INCOME);
    await settle();
    TestBed.inject(ShopProfileService).refresh();
    http.expectOne(`${environment.api_base_url}shop-profile`).flush({ name: 'x', closing: { frequency: 'monthly', fiscalYearStartMonth: 7 } });
    await click('[data-preset="thisYear"]');
    const request = expectGet('income-statement');
    const year = now.getMonth() + 1 >= 7 ? now.getFullYear() : now.getFullYear() - 1;
    expect(request.request.params.get('from')).toBe(`${year}-07-01`); expect(request.request.params.get('to')).toBe(`${year + 1}-06-30`);
    request.flush(INCOME);
  });

  it('comparison: the toggle sends compare=1 and adds the previous-period and change columns', async () => {
    await open();
    expectGet('income-statement').flush(INCOME);
    await settle();
    expect(q('[data-test="prev-head"]')).toBeNull();
    (q('[data-test="compare"]') as HTMLInputElement).click(); await settle();
    const request = expectGet('income-statement');
    expect(request.request.params.get('compare')).toBe('1');
    const compared: IncomeStatement = { ...INCOME, comparison: { from: '2026-09-01', to: '2026-09-30' }, rows: INCOME.rows.map((row) => ({ ...row, previous: row.id === '410' ? 30000 : 0, change: row.id === '410' ? 7450 : 0 })) };
    request.flush(compared); await settle();
    expect(q('[data-test="prev-head"]')).not.toBeNull();
    expect(q('[data-row="410"] [data-cell="previous"]')?.textContent?.trim()).toBe('30,000');
    expect(q('[data-row="410"] [data-cell="change"]')?.textContent?.trim()).toBe('7,450');
  });

  it('a book mismatch is called out; a failed load shows the error', async () => {
    await open();
    expectGet('income-statement').flush({ ...INCOME, check: { ledgerNetProfit: 2000, difference: 100 } });
    await settle();
    expect(q('[data-test="income-check"]')).not.toBeNull();
    await click('[data-preset="lastMonth"]');
    expectGet('income-statement').flush({ message: 'x' }, { status: 500, statusText: 'Server Error' });
    await settle();
    expect(q('[data-test="error"]')?.textContent).toContain('reports.loadFailed');
  });

  it('Excel للمحاسب: the same report as an .xlsx file (format=xlsx with the same filters), a download starts; print stays hidden until Stage 23', async () => {
    await open();
    expectGet('income-statement').flush(INCOME);
    await settle();
    expect(REPORTS_PRINT_ENABLED).toBeFalse();
    expect(q('[data-action="print"]')).toBeNull();
    const created = spyOn(URL, 'createObjectURL').and.returnValue('blob:report');
    const revoked = spyOn(URL, 'revokeObjectURL');
    const clicked = spyOn(HTMLAnchorElement.prototype, 'click');
    await click('[data-action="export"]');
    const request = expectGet('income-statement');
    expect(request.request.params.get('format')).toBe('xlsx');
    expect(request.request.params.get('from')).toBe(monthStart);
    expect(request.request.responseType).toBe('blob');
    request.flush(new Blob(['x']));
    await settle();
    expect(created).toHaveBeenCalled(); expect(clicked).toHaveBeenCalled(); expect(revoked).toHaveBeenCalledWith('blob:report');
  });

  it('balance sheet: as-of date, the three sections with totals, the current-period profit, the side rule and the balanced check', async () => {
    await open();
    expectGet('income-statement').flush(INCOME);
    await settle();
    await click('[data-tab="balance"]');
    const request = expectGet('balance-sheet');
    expect(request.request.params.get('asOf')).toBe(key(now));
    request.flush(SHEET); await settle();
    expect(q('[data-test="as-of"]')).not.toBeNull();
    expect(q('[data-total="assets"]')?.textContent?.trim()).toBe('178,450');
    expect(q('[data-total="liabilities"]')?.textContent?.trim()).toBe('14,650');
    expect(q('[data-total="equity"]')?.textContent?.trim()).toBe('163,800');
    expect(q('[data-section="equity"] [data-row="currentProfit"] [data-cell="amount"]')?.textContent?.trim()).toBe('2,100');
    expect(q('[data-row="115"]')).toBeNull();
    // an account on the opposite side of its normal side gets the warning token and the side name
    const opposite = q('[data-row="1112"] [data-cell="amount"]') as HTMLElement;
    expect(opposite.classList).toContain('fr__warn'); expect(opposite.textContent).toContain('accounting.side.credit');
    expect(q('[data-test="balance-difference"]')?.textContent?.trim()).toBe('0');
    expect(q('[data-test="balance-check"]')?.classList).not.toContain('fr__check-row--bad');
    // links: the ledger up to the as-of date
    expect(q('[data-row="1111"] [data-link="ledger"]')?.getAttribute('href')).toContain('to=2026-10-31');
    // a unbalanced sheet is flagged
    await click('[data-tab="income"]'); expectGet('income-statement').flush(INCOME); await settle();
    await click('[data-tab="balance"]');
    expectGet('balance-sheet').flush({ ...SHEET, check: { assets: 10, liabilitiesAndEquity: 5, difference: 5 } }); await settle();
    expect(q('[data-test="balance-check"]')?.classList).toContain('fr__check-row--bad');
  });

  it('trial balance: opening, movement and closing debit/credit per leaf, group rows, totals that balance, hide-zero', async () => {
    await open();
    expectGet('income-statement').flush(INCOME);
    await settle();
    await click('[data-tab="trial"]');
    const request = expectGet('trial-balance');
    expect(request.request.params.get('from')).toBe(monthStart);
    request.flush(TRIAL); await settle();
    const cells = (row: string) => qa(`[data-row="${row}"] td`).map((cell) => cell.textContent?.trim());
    expect(cells('521').slice(1)).toEqual(['—', '—', '4,500', '—', '4,500', '—']);
    expect(q('[data-row="530"]')).toBeNull();
    expect(q('[data-row="5"]')).not.toBeNull();
    expect(qa('[data-test="trial-totals"] td').slice(1).map((cell) => cell.textContent?.trim())).toEqual(['100', '100', '9,400', '9,400', '9,500', '9,500']);
    expect(q('[data-test="trial-balanced"]')?.textContent).toContain('reports.trialBalanced');
    (q('[data-test="zero-toggle"]') as HTMLInputElement).click(); await settle();
    expect(q('[data-row="530"]')).not.toBeNull();
    await click('[data-tab="income"]'); expectGet('income-statement').flush(INCOME); await settle();
    await click('[data-tab="trial"]');
    expectGet('trial-balance').flush({ ...TRIAL, balanced: false }); await settle();
    expect(q('[data-test="trial-balanced"]')?.textContent).toContain('reports.trialUnbalanced');
  });

  it('box movements: opening + in - out = closing per box, expandable by kind, a link to the box ledger, totals', async () => {
    await open();
    expectGet('income-statement').flush(INCOME);
    await settle();
    await click('[data-tab="boxes"]');
    expectGet('box-movements').flush(BOXES); await settle();
    const main = qa('[data-box="b1"] td').map((cell) => cell.textContent?.trim());
    expect(main.slice(1)).toEqual(['50,000', '29,600', '9,400', '70,200']);
    expect(q('[data-box="b1"] [data-link="box"]')?.getAttribute('href')).toBe('/cashbox/b1');
    expect(q('[data-kind="b1:sales"]')).toBeNull();
    await click('[data-box="b1"]');
    expect(q('[data-kind="b1:sales"]')?.textContent).toContain('Sales'); expect(q('[data-kind="b1:expenses"] td:nth-child(4)')?.textContent?.trim()).toBe('9,400');
    expect(q('[data-box="b2"]')?.textContent).toContain('reports.inactive');
    expect(qa('[data-test="boxes-totals"] td').slice(1).map((cell) => cell.textContent?.trim())).toEqual(['50,000', '29,600', '9,400', '70,200']);
  });

  it('customer and supplier balances: aging buckets, credit balances flagged, zero parties hidden behind the toggle, links to the parties', async () => {
    await open();
    expectGet('income-statement').flush(INCOME);
    await settle();
    await click('[data-tab="parties"]');
    expectGet('party-balances').flush(PARTIES); await settle();
    expect(q('[data-test="from"]')).toBeNull(); // no period for balances: they are as of today
    const customer = qa('[data-party="c1"] td').map((cell) => cell.textContent?.trim());
    expect(customer[2]).toBe('—'); expect(customer[4]).toBe('7,200');
    expect(q('[data-party="c2"]')).toBeNull();
    expect((q('[data-party="c3"] td:nth-child(2)') as HTMLElement).classList).toContain('fr__warn');
    expect(q('[data-party="c1"] [data-link="party"]')?.getAttribute('href')).toBe('/customers/c1');
    expect(q('[data-party="s1"] [data-link="party"]')?.getAttribute('href')).toBe('/suppliers?statement=s1'); // that supplier's statement opens
    expect(qa('[data-totals="customers"] td')[1].textContent?.trim()).toBe('6,900');
    expect(qa('[data-totals="suppliers"] td')[1].textContent?.trim()).toBe('600');
    (q('[data-test="zero-toggle"]') as HTMLInputElement).click(); await settle();
    expect(q('[data-party="c2"]')).not.toBeNull();
  });

  it('Arabic names and digits when the language is Arabic', async () => {
    await open('ar');
    expectGet('income-statement').flush(INCOME);
    await settle();
    expect(q('[data-row="410"] [data-link="ledger"]')?.textContent?.trim()).toBe('المبيعات');
    expect(q('[data-row="410"] [data-cell="amount"]')?.textContent?.trim()).toBe('٣٧٬٤٥٠');
    expect(q('[data-row="grossMargin"] [data-cell="amount"]')?.textContent?.trim()).toContain('٪');
  });
});
