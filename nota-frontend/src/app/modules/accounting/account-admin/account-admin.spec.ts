import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { TranslateModule } from '@ngx-translate/core';
import { environment } from '../../../../environments/environment';
import { signInWith } from '../../../core/auth/testing/sign-in';
import { LanguageService } from '../../shared/services/translation.service';
import { AccountsComponent } from '../accounts.component';
import { AccountUsage, AdminAccount } from './account-admin.service';
import { AccountDialogComponent, TreeAccount } from './account-dialog.component';

const base = `${environment.api_base_url}accounting/accounts`;
const tree = (code: string, nameEn: string, extra: Partial<TreeAccount> = {}): TreeAccount => ({ _id: `a${code}`, code, nameAr: nameEn, nameEn, isGroup: false, isActive: true, ...extra });
const CHART: TreeAccount[] = [
  tree('5', 'Expenses', { isGroup: true }), tree('520', 'Operating expenses', { isGroup: true }), tree('111', 'Cash', { isGroup: true }), tree('112', 'Banks', { isGroup: true }),
  tree('4', 'Revenue', { isGroup: true }), tree('99', 'Old group', { isGroup: true, isActive: false }), tree('113', 'Customers'),
];
const account = (extra: Partial<AdminAccount> = {}): AdminAccount => ({ _id: 'x1', code: '52001', nameAr: 'صيانة', nameEn: 'Maintenance', type: 'expense', normalSide: 'debit', parentId: 'a520', isGroup: false, isSystem: false, isActive: true, ...extra });
const usage = (extra: Partial<AccountUsage> = {}): AccountUsage => ({
  account: account(), hasLines: false, balance: 0, openDrafts: 0, hasChildren: false, isBox: false, canDeactivate: true, deactivateBlockedBy: [], canReactivate: false, canDelete: true, deleteBlockedBy: [], canEditStructure: true, ...extra,
});

describe('AccountDialogComponent (Stage 22)', () => {
  let http: HttpTestingController;
  let fixture: ComponentFixture<AccountDialogComponent>;
  const el = () => fixture.nativeElement as HTMLElement;
  const settle = async () => { fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges(); };
  const q = (selector: string) => el().querySelector(selector) as HTMLElement | null;
  const type = async (selector: string, value: string, event = 'input') => { const input = q(selector) as HTMLInputElement; input.value = value; input.dispatchEvent(new Event(event)); await settle(); };

  const open = async (inputs: { account?: AdminAccount | null; usage?: AccountUsage } = {}) => {
    await TestBed.configureTestingModule({
      imports: [AccountDialogComponent, TranslateModule.forRoot()],
      providers: [provideRouter([]), provideNoopAnimations(), provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
    TestBed.inject(LanguageService).selectedLanguage.set('en');
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(AccountDialogComponent);
    fixture.componentRef.setInput('chart', CHART);
    fixture.componentRef.setInput('account', inputs.account ?? null);
    fixture.detectChanges();
    if (inputs.account) http.expectOne(`${base}/${inputs.account._id}/usage`).flush(inputs.usage ?? usage());
    await settle();
  };
  afterEach(() => http.verify());

  it('add: only active group parents are offered (never the box branches), picking one asks for the next code and shows the inherited type', async () => {
    await open();
    expect(Array.from(el().querySelectorAll('[data-field="parent"] option')).map((node) => node.textContent?.trim().split(' ')[0])).toEqual(['accountsAdmin.pickParent', '5', '520', '4']);
    expect(q('[data-test="auto-code"]')?.textContent).toContain('accountsAdmin.codeAuto');
    await type('[data-field="parent"]', 'a520', 'change');
    const request = http.expectOne((r) => r.url === `${base}/next-code`);
    expect(request.request.params.get('parentId')).toBe('a520');
    request.flush({ code: '52001', scheme: 'five-digit-520', type: 'expense', normalSide: 'debit', parent: { _id: 'a520', code: '520', nameAr: 'مصروفات تشغيل' } });
    await settle();
    expect(q('[data-test="auto-code"]')?.textContent).toContain('52001');
    expect(q('[data-test="inherited-type"]')?.textContent).toContain('accountsAdmin.typeInherited');
    expect(q('[data-test="category-hint"]')).not.toBeNull(); // a new leaf under 520 becomes an expense category
  });

  it('add: saving needs a parent and an Arabic name, then POSTs { parentId, nameAr, nameEn, isGroup }', async () => {
    await open();
    const saved: (AdminAccount | null)[] = [];
    fixture.componentInstance.saved.subscribe((value) => saved.push(value));
    const save = () => q('[data-action="save"]') as HTMLButtonElement;
    expect(save().disabled).toBeTrue();
    await type('[data-field="parent"]', 'a4', 'change');
    http.expectOne((r) => r.url === `${base}/next-code`).flush({ code: '460', scheme: 'tens', type: 'revenue', normalSide: 'credit', parent: { _id: 'a4', code: '4', nameAr: 'الإيرادات' } });
    await settle();
    expect(q('[data-test="category-hint"]')).toBeNull();
    expect(save().disabled).toBeTrue(); // no name yet
    await type('[data-field="nameAr"]', '  إيراد خدمات  '); await type('[data-field="nameEn"]', 'Services');
    (q('[data-field="isGroup"]') as HTMLInputElement).click(); await settle();
    expect(save().disabled).toBeFalse();
    save().click();
    const request = http.expectOne((r) => r.method === 'POST' && r.url === base);
    expect(request.request.body).toEqual({ parentId: 'a4', nameAr: 'إيراد خدمات', nameEn: 'Services', isGroup: true });
    request.flush(account({ code: '460', type: 'revenue' }));
    await settle();
    expect(saved.length).toBe(1);
  });

  it('add: an empty English name is not sent; a server refusal stays in the dialog', async () => {
    await open();
    await type('[data-field="parent"]', 'a5', 'change');
    http.expectOne((r) => r.url === `${base}/next-code`).flush({ code: '550', scheme: 'tens', type: 'expense', normalSide: 'debit', parent: { _id: 'a5', code: '5', nameAr: 'المصروفات' } });
    await settle();
    await type('[data-field="nameAr"]', 'بند');
    (q('[data-action="save"]') as HTMLButtonElement).click();
    const request = http.expectOne((r) => r.method === 'POST' && r.url === base);
    expect(request.request.body).toEqual({ parentId: 'a5', nameAr: 'بند', isGroup: false });
    request.flush({ message: 'مفيش أكواد فاضلة تحت الحساب ده', code: 'CODE_EXHAUSTED' }, { status: 409, statusText: 'Conflict' });
    await settle();
    expect(q('[data-test="dialog-error"]')?.textContent).toContain('مفيش أكواد فاضلة');
  });

  it('edit: names always; the code and parent only while the account has no lines (PUT sends what changed)', async () => {
    await open({ account: account() });
    const saved: (AdminAccount | null)[] = [];
    fixture.componentInstance.saved.subscribe((value) => saved.push(value));
    expect((q('[data-field="nameAr"]') as HTMLInputElement).value).toBe('صيانة');
    expect(q('[data-field="code"]')).not.toBeNull(); expect(q('[data-test="fixed-type"]')).not.toBeNull();
    expect(q('[data-test="structure-locked"]')).toBeNull();
    await type('[data-field="nameAr"]', 'صيانة المحل'); await type('[data-field="code"]', '52009');
    (q('[data-action="save"]') as HTMLButtonElement).click();
    const request = http.expectOne((r) => r.method === 'PUT' && r.url === `${base}/x1`);
    expect(request.request.body).toEqual({ nameAr: 'صيانة المحل', nameEn: 'Maintenance', code: '52009' });
    request.flush(account({ nameAr: 'صيانة المحل', code: '52009' }));
    await settle();
    expect(saved.length).toBe(1);
  });

  it('edit: a system account (or one with lines) can only be renamed: the code is fixed with the reason, and only the names go out', async () => {
    await open({ account: account({ _id: 's1', code: '410', nameAr: 'المبيعات', nameEn: 'Sales', isSystem: true }), usage: usage({ canEditStructure: false, canDeactivate: false, deactivateBlockedBy: ['SYSTEM_ACCOUNT'], canDelete: false, deleteBlockedBy: ['SYSTEM_ACCOUNT'] }) });
    expect(q('[data-field="code"]')).toBeNull();
    expect(q('[data-test="fixed-code"]')?.textContent).toContain('410');
    expect(q('[data-test="structure-locked"]')?.textContent).toContain('accountsAdmin.structureSystem');
    expect(q('[data-action="deactivate"]')).toBeNull(); expect(q('[data-action="delete"]')).toBeNull();
    expect(q('[data-test="deactivate-blocked"]')?.textContent).toContain('SYSTEM_ACCOUNT');
    await type('[data-field="nameAr"]', 'مبيعات البضاعة');
    (q('[data-action="save"]') as HTMLButtonElement).click();
    const request = http.expectOne((r) => r.method === 'PUT' && r.url === `${base}/s1`);
    expect(request.request.body).toEqual({ nameAr: 'مبيعات البضاعة', nameEn: 'Sales' });
    request.flush(account({ _id: 's1', nameAr: 'مبيعات البضاعة' }));
    await settle();
  });

  it('edit: stop, start again and delete follow what the server allows', async () => {
    await open({ account: account() });
    const saved: (AdminAccount | null)[] = [];
    fixture.componentInstance.saved.subscribe((value) => saved.push(value));
    (q('[data-action="deactivate"]') as HTMLButtonElement).click();
    http.expectOne((r) => r.method === 'POST' && r.url === `${base}/x1/deactivate`).flush(account({ isActive: false }));
    await settle();
    (q('[data-action="delete"]') as HTMLButtonElement).click();
    http.expectOne((r) => r.method === 'DELETE' && r.url === `${base}/x1`).flush(null, { status: 204, statusText: 'No Content' });
    await settle();
    expect(saved.length).toBe(2); expect(saved[1]).toBeNull();
  });

  it('edit: an account with a balance cannot be stopped (the reason is shown); a stopped account offers "start again"', async () => {
    await open({ account: account(), usage: usage({ canDeactivate: false, deactivateBlockedBy: ['HAS_BALANCE'], balance: 50, canDelete: false, deleteBlockedBy: ['HAS_LINES'], hasLines: true, canEditStructure: false }) });
    expect(q('[data-action="deactivate"]')).toBeNull();
    expect(q('[data-test="deactivate-blocked"]')?.textContent).toContain('HAS_BALANCE');
    expect(q('[data-test="balance-note"]')).not.toBeNull();
    expect(q('[data-test="structure-locked"]')?.textContent).toContain('accountsAdmin.structureLines');
  });

  it('a stopped account can be started again', async () => {
    await open({ account: account({ isActive: false }), usage: usage({ account: account({ isActive: false }), canDeactivate: false, deactivateBlockedBy: ['ALREADY_INACTIVE'], canReactivate: true }) });
    (q('[data-action="reactivate"]') as HTMLButtonElement).click();
    http.expectOne((r) => r.method === 'POST' && r.url === `${base}/x1/reactivate`).flush(account());
    await settle();
  });
});

describe('AccountsComponent actions (Stage 22)', () => {
  let http: HttpTestingController;
  let fixture: ComponentFixture<AccountsComponent>;
  const el = () => fixture.nativeElement as HTMLElement;
  const node = (id: string, code: string, extra: Record<string, unknown> = {}) => ({ _id: id, code, nameAr: code, nameEn: `Account ${code}`, normalSide: 'debit', balance: 0, isGroup: false, isActive: true, children: [], ...extra });
  const ACCOUNTS = [node('a5', '5', { isGroup: true, children: [node('a520', '520', { isGroup: true, children: [node('a52001', '52001'), node('a52002', '52002', { isActive: false })] })] })];

  const open = async (permissions: string[]) => {
    await TestBed.configureTestingModule({
      imports: [AccountsComponent, TranslateModule.forRoot()],
      providers: [provideRouter([]), provideNoopAnimations(), provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
    TestBed.inject(LanguageService).selectedLanguage.set('en');
    signInWith(permissions);
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(AccountsComponent);
    fixture.detectChanges();
    http.expectOne((r) => r.url === base && r.method === 'GET').flush({ accounts: ACCOUNTS });
    (fixture.componentInstance as unknown as { expanded: Set<string> }).expanded.add('a520'); // the roots start expanded, this group is opened by a click
    fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges();
  };
  afterEach(() => http.verify());
  const codes = () => Array.from(el().querySelectorAll('.tree-row .code')).map((node) => node.textContent?.trim());

  it('"+ حساب", "+ قيد يدوي" and the edit action need accounting.manage; a read-only user sees none of them', async () => {
    await open(['accounting.view']);
    expect(el().querySelector('[data-action="new-account"]')).toBeNull();
    expect(el().querySelector('[data-action="new-entry"]')).toBeNull();
    expect(el().querySelector('[data-action="edit-account"]')).toBeNull();
  });

  it('with accounting.manage: both buttons, an edit action on every row, and "+ قيد يدوي" opens the manual entry', async () => {
    await open(['accounting.view', 'accounting.manage']);
    expect(el().querySelector('[data-action="new-account"]')).not.toBeNull();
    expect(el().querySelector('[data-action="new-entry"]')?.getAttribute('href')).toBe('/accounting/manual-entry');
    expect(el().querySelectorAll('[data-action="edit-account"]').length).toBe(codes().length);
  });

  it('stopped accounts are hidden until "عرض الحسابات الموقوفة" is on; then they show tagged', async () => {
    await open(['accounting.view', 'accounting.manage']);
    expect(codes()).toEqual(['5', '520', '52001']);
    (el().querySelector('[data-test="show-inactive"]') as HTMLInputElement).click();
    fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges();
    expect(codes()).toEqual(['5', '520', '52001', '52002']);
    expect(el().querySelectorAll('[data-test="inactive-tag"]').length).toBe(1);
  });

  it('the edit action opens the account dialog; saving closes it and reloads the tree', async () => {
    await open(['accounting.view', 'accounting.manage']);
    (el().querySelectorAll('[data-action="edit-account"]')[2] as HTMLButtonElement).click();
    fixture.detectChanges();
    http.expectOne(`${base}/a52001/usage`).flush(usage({ account: account({ _id: 'a52001' }) }));
    fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges();
    expect(el().querySelector('app-account-dialog')).not.toBeNull();
    (fixture.componentInstance as unknown as { saved(value: unknown): void }).saved(account());
    fixture.detectChanges();
    http.expectOne((r) => r.url === base && r.method === 'GET').flush({ accounts: ACCOUNTS });
    fixture.detectChanges();
    expect(el().querySelector('app-account-dialog')).toBeNull();
  });

  it('"+ حساب" opens the add dialog with the groups of the chart as parents', async () => {
    await open(['accounting.view', 'accounting.manage']);
    (el().querySelector('[data-action="new-account"]') as HTMLButtonElement).click();
    fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges();
    const parents = Array.from(el().querySelectorAll('[data-field="parent"] option')).map((option) => option.textContent?.trim().split(' ')[0]);
    expect(parents).toEqual(['accountsAdmin.pickParent', '5', '520']);
  });
});
