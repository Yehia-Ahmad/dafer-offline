import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { TranslateModule } from '@ngx-translate/core';
import { environment } from '../../../environments/environment';
import { signInAs, signInWith } from '../../core/auth/testing/sign-in';
import { LanguageService } from '../shared/services/translation.service';
import { ExpenseCategory, ExpensesResponse } from './cashbox.models';
import { ExpensesPageComponent } from './expenses-page.component';
import { MAIN_ONLY_BOXES } from './testing/payment-boxes.testing';
import { provideFakeVat } from '../shop-profile/services/vat-settings.testing';

const base = environment.api_base_url;

const category = (code: string, nameAr: string, nameEn: string, extra: Partial<ExpenseCategory> = {}): ExpenseCategory =>
  ({ _id: `c${code}`, code, nameAr, nameEn, isSystem: true, isActive: true, hasLines: false, ...extra });
const CATEGORIES = [category('521', 'مرتبات', 'Salaries'), category('522', 'إيجار', 'Rent'), category('523', 'كهرباء ومياه', 'Utilities'), category('526', 'صيانة', 'Maintenance', { isSystem: false })];

const LIST: ExpensesResponse = {
  month: '2026-11',
  data: [
    { _id: 'e1', number: 'EX-000001', date: '2026-11-03T00:00:00Z', accountId: 'c523', categoryName: 'كهرباء ومياه', categoryCode: '523', amount: 650, boxId: 'box-main', boxName: 'الخزنة الرئيسية', note: 'فاتورة كهرباء أكتوبر', status: 'posted', createdByName: 'أحمد' },
    { _id: 'e2', number: 'EX-000002', date: '2026-11-03T00:00:00Z', accountId: 'c526', categoryName: 'صيانة', categoryCode: '526', amount: 80, boxId: 'box-main', boxName: 'الخزنة الرئيسية', status: 'cancelled', cancelReason: 'اتسجل مرتين', createdByName: 'محمود' },
  ],
  total: 650, count: 1,
  byCategory: [{ accountId: 'c523', code: '523', nameAr: 'كهرباء ومياه', nameEn: 'Utilities', total: 650, count: 1 }],
  previous: { month: '2026-10', total: 9400, count: 9, byCategory: [
    { accountId: 'c521', code: '521', nameAr: 'مرتبات', nameEn: 'Salaries', total: 4500, count: 3 },
    { accountId: 'c522', code: '522', nameAr: 'إيجار', nameEn: 'Rent', total: 3500, count: 1 },
    { accountId: 'c523', code: '523', nameAr: 'كهرباء ومياه', nameEn: 'Utilities', total: 1400, count: 5 },
  ] },
  pagination: { page: 1, limit: 50, totalItems: 2, totalPages: 1 },
};

describe('ExpensesPageComponent (Stage 19)', () => {
  let http: HttpTestingController;
  const open = async (signIn: () => void = () => signInAs('owner')) => {
    sessionStorage.removeItem('nota.paymentBox');
    await TestBed.configureTestingModule({
      imports: [ExpensesPageComponent, TranslateModule.forRoot()],
      providers: [provideRouter([]), provideNoopAnimations(), provideHttpClient(), provideHttpClientTesting(), provideFakeVat()],
    }).compileComponents();
    TestBed.inject(LanguageService).selectedLanguage.set('en');
    signIn();
    http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(ExpensesPageComponent);
    fixture.detectChanges();
    http.expectOne(`${base}cashbox/payment-boxes`).flush(MAIN_ONLY_BOXES);
    http.expectOne(`${base}expenses/categories`).flush({ data: CATEGORIES });
    http.expectOne((r) => r.url === `${base}expenses`).flush(LIST);
    await settle(fixture);
    return fixture;
  };
  const settle = async (fixture: ComponentFixture<unknown>) => { fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges(); };
  const el = (fixture: ComponentFixture<unknown>) => fixture.nativeElement as HTMLElement;
  afterEach(() => { http.verify(); sessionStorage.removeItem('nota.paymentBox'); });

  it('lists this month with its total, and last month by category with the total', async () => {
    const fixture = await open();
    const rows = Array.from(el(fixture).querySelectorAll('[data-test="expenses-table"] tbody tr'));
    expect(rows.length).toBe(2);
    expect(rows[0].textContent).toContain('فاتورة كهرباء أكتوبر');
    expect(rows[0].textContent).toContain('650');
    expect(rows[1].classList).toContain('ex__row--cancelled');
    expect(el(fixture).querySelector('[data-test="month-total"]')!.textContent).toContain('650');
    const categories = Array.from(el(fixture).querySelectorAll('[data-test="previous-month"] [data-category]')).map((row) => row.getAttribute('data-category'));
    expect(categories).toEqual(['521', '522', '523']);
    expect(el(fixture).querySelector('[data-test="previous-total"]')!.textContent).toContain('9,400');
    expect(fixture.componentInstance.barWidth(LIST.previous.byCategory[0])).toBe('100%');
    expect(fixture.componentInstance.barWidth(LIST.previous.byCategory[1])).toBe('78%');
  });

  it('records an expense with the exact body, then reloads the month', async () => {
    const fixture = await open();
    const component = fixture.componentInstance;
    expect(component.canSave()).toBeFalse();
    component.category.set('c523'); component.amount.set(650); component.date.set('2026-11-03'); component.note.set(' فاتورة كهرباء ');
    expect(component.canSave()).toBeTrue();
    component.save();
    const post = http.expectOne(`${base}expenses`);
    expect(post.request.body).toEqual({ accountId: 'c523', amount: 650, date: '2026-11-03', note: 'فاتورة كهرباء' });
    post.flush({ _id: 'e9' });
    http.expectOne(`${base}cashbox/payment-boxes`).flush(MAIN_ONLY_BOXES);
    http.expectOne((r) => r.url === `${base}expenses`).flush(LIST);
    expect(component.amount()).toBeNull();
    expect(component.note()).toBe('');
  });

  it('a refused expense shows the reason (INSUFFICIENT_BALANCE) and keeps the form', async () => {
    const fixture = await open();
    const component = fixture.componentInstance;
    component.category.set('c523'); component.amount.set(999999);
    component.save();
    http.expectOne(`${base}expenses`).flush({ code: 'INSUFFICIENT_BALANCE' }, { status: 409, statusText: 'Conflict' });
    await settle(fixture);
    expect(component.formError()).toBe('cashbox.errors.INSUFFICIENT_BALANCE');
    expect(el(fixture).querySelector('[data-test="expense-error"]')!.textContent).toContain('cashbox.errors.INSUFFICIENT_BALANCE');
    expect(component.amount()).toBe(999999);
  });

  it('filters by month, category and box', async () => {
    const fixture = await open();
    const component = fixture.componentInstance;
    component.month.set('2026-10'); component.filterCategory.set('c522'); component.filterBox.set('box-main');
    component.load();
    const request = http.expectOne((r) => r.url === `${base}expenses`);
    expect([request.request.params.get('month'), request.request.params.get('category'), request.request.params.get('box')]).toEqual(['2026-10', 'c522', 'box-main']);
    request.flush(LIST);
  });

  it('cancel needs a reason of 3 characters, posts it and reloads; only expenses.manage sees the button', async () => {
    const fixture = await open();
    const component = fixture.componentInstance;
    expect(el(fixture).querySelectorAll('[data-action="cancel-expense"]').length).toBe(1);
    component.startCancel(LIST.data[0]);
    component.cancelReason.set('اه');
    component.confirmCancel();
    http.expectNone(`${base}expenses/e1/cancel`);
    component.cancelReason.set('اتسجل مرتين');
    component.confirmCancel();
    const request = http.expectOne(`${base}expenses/e1/cancel`);
    expect(request.request.body).toEqual({ reason: 'اتسجل مرتين' });
    request.flush({});
    http.expectOne((r) => r.url === `${base}expenses`).flush(LIST);
    expect(component.cancelTarget()).toBeNull();
    TestBed.resetTestingModule();
    const cashier = await open(() => signInWith(['expenses.create']));
    expect(el(cashier).querySelectorAll('[data-action="cancel-expense"]').length).toBe(0);
    expect(el(cashier).querySelector('[data-action="manage-categories"]')).toBeNull();
  });

  it('adds, renames and stops a category (expenses.manage); system categories are only listed', async () => {
    const fixture = await open();
    const component = fixture.componentInstance;
    component.newNameAr.set('دعاية'); component.newNameEn.set('Ads');
    component.addCategory();
    const add = http.expectOne(`${base}expenses/categories`);
    expect(add.request.method).toBe('POST');
    expect(add.request.body).toEqual({ nameAr: 'دعاية', nameEn: 'Ads' });
    add.flush({});
    http.expectOne(`${base}expenses/categories`).flush({ data: CATEGORIES });
    expect(component.newNameAr()).toBe('');
    component.renameCategory(CATEGORIES[3], 'صيانة وإصلاح');
    const rename = http.expectOne(`${base}expenses/categories/c526`);
    expect(rename.request.method).toBe('PUT');
    expect(rename.request.body).toEqual({ nameAr: 'صيانة وإصلاح' });
    rename.flush({});
    http.expectOne(`${base}expenses/categories`).flush({ data: CATEGORIES });
    component.deactivateCategory(CATEGORIES[3]);
    const stop = http.expectOne(`${base}expenses/categories/c526`);
    expect(stop.request.body).toEqual({ isActive: false });
    stop.flush({ code: 'CATEGORY_HAS_LINES' }, { status: 409, statusText: 'Conflict' });
    expect(component.categoryError()).toBe('cashbox.expenses.categoryHasLines');
    expect(component.activeCategories().length).toBe(4);
  });

  it('shows category names in the UI language', async () => {
    const fixture = await open();
    expect(fixture.componentInstance.categoryLabel(CATEGORIES[1])).toBe('Rent');
    TestBed.inject(LanguageService).selectedLanguage.set('ar');
    expect(fixture.componentInstance.categoryLabel(CATEGORIES[1])).toBe('إيجار');
  });
});
