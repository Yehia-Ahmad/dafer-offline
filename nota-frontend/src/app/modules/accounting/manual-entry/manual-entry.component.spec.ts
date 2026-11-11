import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute, Router, convertToParamMap, provideRouter } from '@angular/router';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { TranslateModule } from '@ngx-translate/core';
import { environment } from '../../../../environments/environment';
import { LockDateService } from '../../../core/accounting-lock/lock-date.service';
import { localDateKey } from '../../../core/utilities/local-date';
import { LanguageService } from '../../shared/services/translation.service';
import { ManualAccountOption, ManualEntry } from './manual-entry.service';
import { ManualEntryComponent } from './manual-entry.component';

const base = `${environment.api_base_url}accounting/manual-entries`;
const option = (id: string, code: string, nameEn: string, extra: Partial<ManualAccountOption> = {}): ManualAccountOption => ({
  _id: id, code, nameAr: nameEn, nameEn, type: 'expense', normalSide: 'debit', systemKey: null, needsParty: null, blocked: null, ...extra,
});
const OPTIONS: ManualAccountOption[] = [
  option('a523', '523', 'Utilities'), option('a525', '525', 'Miscellaneous'), option('a31', '31', 'Capital', { type: 'equity', normalSide: 'credit' }),
  option('a113', '113', 'Customers', { type: 'asset', needsParty: 'customer', systemKey: 'CUSTOMERS' }),
  option('a21', '21', 'Suppliers', { type: 'liability', normalSide: 'credit', needsParty: 'supplier', systemKey: 'SUPPLIERS' }),
  option('a1111', '1111', 'Main cash', { type: 'asset', blocked: { code: 'BOX_ACCOUNT', message: 'استخدم شاشة الخزائن أو المصروفات' } }),
  option('a410', '410', 'Sales', { type: 'revenue', normalSide: 'credit', blocked: { code: 'INVOICE_ACCOUNT', message: 'الحساب ده بيتحرك من الفواتير؛ صحّح بالمرتجع أو الإلغاء أو تعديل الفاتورة' } }),
];
const entry = (extra: Partial<ManualEntry> = {}): ManualEntry => ({
  _id: 'e1', status: 'draft', date: `${localDateKey()}T00:00:00.000Z`, memo: 'كهرباء مستحقة', totalDebit: 300, totalCredit: 300,
  lines: [{ accountId: 'a523', description: '', debit: 300, credit: 0 }, { accountId: 'a31', description: '', debit: 0, credit: 300 }], ...extra,
});

describe('ManualEntryComponent (Stage 22)', () => {
  let http: HttpTestingController;
  let fixture: ComponentFixture<ManualEntryComponent>;
  let router: Router;
  const el = () => fixture.nativeElement as HTMLElement;
  const settle = async () => { fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges(); };
  const q = (selector: string) => el().querySelector(selector) as HTMLElement | null;
  const qa = (selector: string) => Array.from(el().querySelectorAll(selector)) as HTMLElement[];
  const comp = () => fixture.componentInstance as unknown as Record<string, any>;
  const type = async (selector: string, value: string, event = 'input') => { const input = q(selector) as HTMLInputElement; input.value = value; input.dispatchEvent(new Event(event)); await settle(); };
  const lineField = (line: number, field: string) => `[data-line="${line}"] [data-field="${field}"]`;
  const pick = async (line: number, id: string) => type(lineField(line, 'account'), id, 'change');

  const open = async (id: string | null = null, loaded: ManualEntry | null = null, drafts: ManualEntry[] = []) => {
    await TestBed.configureTestingModule({
      imports: [ManualEntryComponent, TranslateModule.forRoot()],
      providers: [
        provideRouter([]), provideNoopAnimations(), provideHttpClient(), provideHttpClientTesting(),
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: convertToParamMap(id ? { id } : {}) } } },
      ],
    }).compileComponents();
    TestBed.inject(LanguageService).selectedLanguage.set('en');
    http = TestBed.inject(HttpTestingController);
    router = TestBed.inject(Router);
    spyOn(router, 'navigate').and.resolveTo(true);
    fixture = TestBed.createComponent(ManualEntryComponent);
    fixture.detectChanges();
    http.expectOne(`${base}/accounts`).flush({ data: OPTIONS });
    if (id) http.expectOne(`${base}/${id}`).flush(loaded);
    else http.expectOne((request) => request.url === base && request.params.get('status') === 'draft').flush({ data: drafts });
    await settle();
  };
  afterEach(() => http.verify());

  it('a new entry: number on posting, today, two empty lines, a balanced indicator that follows the amounts, add and remove a line', async () => {
    await open();
    expect(q('[data-test="number"]')?.textContent).toContain('manual.numberOnPost');
    expect((q('[data-test="date"]') as HTMLInputElement).value).toBe(localDateKey());
    expect(qa('[data-line]').length).toBe(2);
    expect(q('[data-test="balanced"]')?.classList).toContain('me__balance--bad');
    await pick(1, 'a523'); await type(lineField(1, 'debit'), '300');
    expect(q('[data-total="debit"]')?.textContent?.trim()).toBe('300'); expect(q('[data-total="credit"]')?.textContent?.trim()).toBe('0');
    expect(q('[data-test="balanced"]')?.textContent).toContain('manual.unbalanced');
    await pick(2, 'a31'); await type(lineField(2, 'credit'), '300');
    expect(q('[data-test="balanced"]')?.classList).toContain('me__balance--ok'); expect(q('[data-test="balanced"]')?.textContent).toContain('manual.balanced');
    (q('[data-action="add-line"]') as HTMLButtonElement).click(); await settle();
    expect(qa('[data-line]').length).toBe(3);
    (q('[data-line="3"] [data-action="remove-line"]') as HTMLButtonElement).click(); await settle();
    expect(qa('[data-line]').length).toBe(2);
    expect(q('[data-line="2"] [data-action="remove-line"]')).toBeNull(); // never fewer than two lines
  });

  it('typing a debit clears the credit of the same line (one side per line)', async () => {
    await open();
    await pick(1, 'a523'); await type(lineField(1, 'credit'), '50'); await type(lineField(1, 'debit'), '70');
    expect((q(lineField(1, 'credit')) as HTMLInputElement).value).toBe('');
    expect(q('[data-total="credit"]')?.textContent?.trim()).toBe('0');
  });

  it('accounts that have their own screens are shown, disabled, with the reason (boxes, invoice accounts)', async () => {
    await open();
    const options = qa(`${lineField(1, 'account')} option`);
    const box = options.find((node) => node.textContent?.includes('1111')) as HTMLOptionElement;
    const sales = options.find((node) => node.textContent?.includes('410')) as HTMLOptionElement;
    expect(box.disabled).toBeTrue(); expect(box.textContent).toContain('استخدم شاشة الخزائن أو المصروفات'); expect(box.getAttribute('data-blocked')).toBe('BOX_ACCOUNT');
    expect(sales.disabled).toBeTrue(); expect(sales.textContent).toContain('الحساب ده بيتحرك من الفواتير');
    expect((options.find((node) => node.textContent?.includes('523')) as HTMLOptionElement).disabled).toBeFalse();
  });

  it('a customers line needs a customer and is a CREDIT only: a debit shows the Arabic rule inline and blocks posting', async () => {
    await open();
    await pick(1, 'a113');
    http.expectOne(`${environment.api_base_url}customers`).flush([{ _id: 'c1', name: 'أحمد' }, { _id: 'c2', name: 'منى' }]);
    await settle();
    expect(q(lineField(1, 'party'))).not.toBeNull();
    expect(qa(`${lineField(1, 'party')} option`).map((node) => node.textContent?.trim())).toContain('أحمد');
    await type(lineField(1, 'credit'), '300');
    expect(q('[data-line="1"] [data-test="line-error"]')?.textContent).toContain('manual.errors.customerRequired');
    await type(lineField(1, 'party'), 'c1', 'change');
    expect(q('[data-line="1"] [data-test="line-error"]')).toBeNull();
    await type(lineField(1, 'debit'), '10'); // a debit on the customer line
    expect(q('[data-line="1"] [data-test="line-error"]')?.textContent).toContain('manual.errors.customerDebit');
    // the memo and the other side are fine, but the customer debit blocks the post
    await pick(2, 'a31'); await type(lineField(2, 'credit'), '10'); await type('[data-test="memo"]', 'x');
    expect((q('[data-action="post"]') as HTMLButtonElement).disabled).toBeTrue();
  });

  it('a supplier line asks for the supplier', async () => {
    await open();
    await pick(1, 'a21');
    http.expectOne(`${environment.api_base_url}suppliers`).flush([{ _id: 's1', name: 'مورد' }]);
    await settle();
    expect(q('[data-line="1"] [data-field="party"] option:nth-child(1)')?.textContent).toContain('manual.pickSupplier');
    await type(lineField(1, 'debit'), '5');
    expect(q('[data-line="1"] [data-test="line-error"]')?.textContent).toContain('manual.errors.supplierRequired');
  });

  it('حفظ كمسودة: POST the draft as typed (even unbalanced), with the party only on its line; it opens the saved draft', async () => {
    await open();
    await pick(1, 'a525'); await type(lineField(1, 'debit'), '300'); await type(lineField(1, 'description'), 'ديون معدومة');
    await pick(2, 'a113');
    http.expectOne(`${environment.api_base_url}customers`).flush([{ _id: 'c1', name: 'أحمد' }]);
    await settle();
    await type(lineField(2, 'party'), 'c1', 'change'); await type(lineField(2, 'credit'), '200');
    await type('[data-test="memo"]', '  إعدام دين  ');
    (q('[data-action="save-draft"]') as HTMLButtonElement).click();
    const request = http.expectOne((r) => r.method === 'POST' && r.url === base);
    expect(request.request.body).toEqual({
      date: localDateKey(), memo: 'إعدام دين',
      lines: [
        { accountId: 'a525', description: 'ديون معدومة', debit: 300, credit: 0, partyType: null, partyId: null },
        { accountId: 'a113', description: '', debit: 0, credit: 200, partyType: 'customer', partyId: 'c1' },
      ],
    });
    request.flush(entry({ _id: 'd9', totalDebit: 300, totalCredit: 200, lines: [{ accountId: 'a525', description: '', debit: 300, credit: 0 }, { accountId: 'a113', description: '', debit: 0, credit: 200, partyType: 'customer', partyId: 'c1' }] }));
    await settle();
    expect(router.navigate).toHaveBeenCalledWith(['/accounting/manual-entry', 'd9'], { replaceUrl: true });
  });

  it('ترحيل القيد needs a date, a memo and a balance; it saves then posts, and the posted entry is read-only with a reverse action', async () => {
    await open();
    await pick(1, 'a523'); await type(lineField(1, 'debit'), '300'); await pick(2, 'a31'); await type(lineField(2, 'credit'), '300');
    expect((q('[data-action="post"]') as HTMLButtonElement).disabled).toBeTrue(); // no memo yet
    await type('[data-test="memo"]', 'كهرباء مستحقة');
    expect((q('[data-action="post"]') as HTMLButtonElement).disabled).toBeFalse();
    (q('[data-action="post"]') as HTMLButtonElement).click();
    http.expectOne((r) => r.method === 'POST' && r.url === base).flush(entry({ _id: 'e7' }));
    const posted = http.expectOne(`${base}/e7/post`);
    expect(posted.request.method).toBe('POST');
    posted.flush(entry({ _id: 'e7', status: 'posted', number: 'JE-000012', entryId: 'j1' }));
    await settle();
    expect(q('[data-test="number"]')?.textContent).toContain('JE-000012');
    expect(q('[data-test="posted"]')).not.toBeNull();
    expect((q('[data-test="memo"]') as HTMLInputElement).disabled).toBeTrue();
    expect(q('[data-action="post"]')).toBeNull(); expect(q('[data-action="save-draft"]')).toBeNull();
    expect(q('[data-link="entry"]')?.getAttribute('href')).toBe('/accounting/journal/j1');
    expect(q('[data-action="reverse"]')).not.toBeNull();
  });

  it('a server refusal is shown, and the line it names is marked (a forbidden account)', async () => {
    await open();
    await pick(1, 'a523'); await type(lineField(1, 'debit'), '10'); await pick(2, 'a31'); await type(lineField(2, 'credit'), '10'); await type('[data-test="memo"]', 'x');
    (q('[data-action="post"]') as HTMLButtonElement).click();
    http.expectOne((r) => r.method === 'POST' && r.url === base).flush(entry({ _id: 'e8' }));
    http.expectOne(`${base}/e8/post`).flush({ message: '523 · Utilities: استخدم شاشة الخزائن أو المصروفات', code: 'FORBIDDEN_ACCOUNT', line: 1 }, { status: 400, statusText: 'Bad Request' });
    await settle();
    expect(q('[data-test="action-error"]')?.textContent).toContain('استخدم شاشة الخزائن أو المصروفات');
    expect(q('[data-line="1"]')?.classList).toContain('me__line--bad');
    expect(q('[data-line="2"]')?.classList).not.toContain('me__line--bad');
  });

  it('a draft opens for editing: its lines load, "حفظ كمسودة" updates it (PUT), "مسح المسودة" deletes it', async () => {
    await open('e1', entry());
    expect((q('[data-test="memo"]') as HTMLInputElement).value).toBe('كهرباء مستحقة');
    expect((q(lineField(1, 'debit')) as HTMLInputElement).value).toBe('300');
    expect(q('[data-test="drafts"]')).toBeNull();
    await type('[data-test="memo"]', 'تعديل');
    (q('[data-action="save-draft"]') as HTMLButtonElement).click();
    const put = http.expectOne((r) => r.method === 'PUT' && r.url === `${base}/e1`);
    expect(put.request.body.memo).toBe('تعديل');
    put.flush(entry({ memo: 'تعديل' }));
    await settle();
    (q('[data-action="delete-draft"]') as HTMLButtonElement).click();
    http.expectOne((r) => r.method === 'DELETE' && r.url === `${base}/e1`).flush(null, { status: 204, statusText: 'No Content' });
    await settle();
    expect(router.navigate).toHaveBeenCalledWith(['/accounting/manual-entry']);
  });

  it('the page without an entry lists the drafts to continue', async () => {
    await open(null, null, [entry({ _id: 'd1', memo: 'مسودة ١' }), entry({ _id: 'd2', memo: 'مسودة ٢', totalDebit: 90 })]);
    expect(qa('[data-draft]').map((row) => row.getAttribute('data-draft'))).toEqual(['d1', 'd2']);
    expect(q('[data-draft="d1"] a')?.getAttribute('href')).toBe('/accounting/manual-entry/d1');
  });

  it('a posted entry: what was set against the customer\'s invoices is shown; "قيد عكسي" needs a reason, posts the reversal and shows the link', async () => {
    const posted = entry({ _id: 'e20', status: 'posted', number: 'JE-000020', entryId: 'j20', allocations: [{ customerId: 'c1', kind: 'invoice', itemId: 'i1', number: 'CR-1', amount: 200 }, { customerId: 'c1', kind: 'invoice', itemId: 'i2', number: 'CR-2', amount: 100 }] });
    await open('e20', posted);
    expect(q('[data-test="allocations"]')?.textContent).toContain('manual.allocated');
    expect((q('[data-line="1"] [data-field="debit"]') as HTMLInputElement).disabled).toBeTrue();
    (q('[data-action="reverse"]') as HTMLButtonElement).click(); await settle();
    const confirm = () => document.querySelector('[data-action="confirm-reverse"]') as HTMLButtonElement;
    expect(confirm().disabled).toBeTrue();
    const reason = document.querySelector('[data-field="reason"]') as HTMLTextAreaElement;
    reason.value = 'ab'; reason.dispatchEvent(new Event('input')); await settle();
    expect(confirm().disabled).toBeTrue();
    reason.value = 'العميل سدّد'; reason.dispatchEvent(new Event('input')); await settle();
    expect(confirm().disabled).toBeFalse();
    confirm().click();
    const request = http.expectOne((r) => r.method === 'POST' && r.url === `${base}/e20/reverse`);
    expect(request.request.body).toEqual({ reason: 'العميل سدّد', date: localDateKey() });
    request.flush({ ...posted, reversal: { _id: 'j21', entryId: 'j21', number: 'JE-000021', date: `${localDateKey()}T00:00:00.000Z`, reason: 'العميل سدّد' } });
    await settle();
    expect(q('[data-test="reversal"]')?.textContent).toContain('manual.reversedBy');
    expect(q('[data-link="reversal"]')?.getAttribute('href')).toBe('/accounting/journal/j21');
    expect(q('[data-action="reverse"]')).toBeNull();
  });

  it('a refused reversal keeps the dialog open with the server message', async () => {
    await open('e21', entry({ _id: 'e21', status: 'posted', number: 'JE-000021', entryId: 'j1' }));
    (q('[data-action="reverse"]') as HTMLButtonElement).click(); await settle();
    const reason = document.querySelector('[data-field="reason"]') as HTMLTextAreaElement;
    reason.value = 'سبب كافي'; reason.dispatchEvent(new Event('input')); await settle();
    (document.querySelector('[data-action="confirm-reverse"]') as HTMLButtonElement).click();
    http.expectOne((r) => r.url === `${base}/e21/reverse`).flush({ message: 'مينفعش نعكس القيد: الفاتورة CR-1 اتغيرت بعد القيد', code: 'ALLOCATION_LOCKED' }, { status: 409, statusText: 'Conflict' });
    await settle();
    expect(document.querySelector('[data-test="reverse-error"]')?.textContent).toContain('اتغيرت بعد القيد');
  });

  it('a date inside a closed period: the banner turns into the error and posting is disabled', async () => {
    await open();
    const day = (offset: number) => { const d = new Date(); d.setDate(d.getDate() + offset); return localDateKey(d); };
    TestBed.inject(LockDateService).set(day(-1));
    await pick(1, 'a523'); await type(lineField(1, 'debit'), '10'); await pick(2, 'a31'); await type(lineField(2, 'credit'), '10'); await type('[data-test="memo"]', 'x');
    comp()['date'].set(day(-5)); await settle();
    expect(q('[data-test="lock-banner"]')?.classList).toContain('nota-lock-banner--blocked');
    expect((q('[data-action="post"]') as HTMLButtonElement).disabled).toBeTrue();
    expect((q('[data-test="date"]') as HTMLInputElement).getAttribute('min')).toBe(localDateKey());
    comp()['date'].set(localDateKey()); await settle();
    expect((q('[data-action="post"]') as HTMLButtonElement).disabled).toBeFalse();
  });
});
