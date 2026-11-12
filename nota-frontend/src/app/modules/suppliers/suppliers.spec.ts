import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute, Router, convertToParamMap, provideRouter } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { environment } from '../../../environments/environment';
import { AuthService } from '../../core/auth/auth.service';
import { SupplierFormComponent, daysToPaymentTerms, paymentTermsToDays } from './supplier-form.component';
import { SuppliersPageComponent } from './suppliers-page.component';
import { Supplier, SuppliersService } from './suppliers.service';
import { LanguageService } from '../shared/services/translation.service';

const base = environment.api_base_url;

const supplier = (overrides: Partial<Supplier> = {}): Supplier => ({
  _id: 's1', name: 'الشركة المصرية للإضاءة', phones: ['01027784410'], contactPerson: 'م. وائل', supplies: 'لمبات', isActive: true,
  paymentTermsDays: 30, balance: 6650, openingAmount: 6650, ledgerAccountId: 'acc21', ...overrides,
});

describe('SuppliersService payloads', () => {
  let service: SuppliersService;
  let http: HttpTestingController;
  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    service = TestBed.inject(SuppliersService);
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => http.verify());

  it('list sends the trimmed search only when there is one', () => {
    service.list('  ضاءة ').subscribe();
    const req = http.expectOne((r) => r.url === `${base}suppliers`);
    expect(req.request.params.get('search')).toBe('ضاءة');
    req.flush([]);
    service.list('').subscribe();
    expect(http.expectOne((r) => r.url === `${base}suppliers`).request.params.has('search')).toBeFalse();
  });

  it('create, update and remove hit /suppliers with the exact bodies', () => {
    service.create({ name: 'مورد', phone: '010', paymentTermsDays: 0 }).subscribe();
    const create = http.expectOne(`${base}suppliers`);
    expect(create.request.method).toBe('POST');
    expect(create.request.body).toEqual({ name: 'مورد', phone: '010', paymentTermsDays: 0 });
    create.flush({});
    service.update('s1', { notes: 'x' }).subscribe();
    const update = http.expectOne(`${base}suppliers/s1`);
    expect(update.request.method).toBe('PUT');
    expect(update.request.body).toEqual({ notes: 'x' });
    update.flush({});
    service.remove('s1').subscribe();
    const remove = http.expectOne(`${base}suppliers/s1`);
    expect(remove.request.method).toBe('DELETE');
    remove.flush({});
  });
});

describe('SuppliersPageComponent', () => {
  let http: HttpTestingController;
  const create = (permissions: string[] = ['suppliers.view', 'suppliers.manage']) => {
    TestBed.configureTestingModule({ imports: [SuppliersPageComponent, TranslateModule.forRoot()], providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])] });
    const auth = TestBed.inject(AuthService);
    spyOn(auth, 'hasAll').and.callFake((...keys: string[]) => keys.every((key) => permissions.includes(key)));
    spyOn(auth, 'hasAny').and.callFake((...keys: string[]) => keys.some((key) => permissions.includes(key)));
    http = TestBed.inject(HttpTestingController);
    TestBed.inject(LanguageService).selectedLanguage.set('en');
    const fixture = TestBed.createComponent(SuppliersPageComponent);
    fixture.detectChanges();
    return fixture;
  };
  const flushList = async (fixture: ReturnType<typeof create>, rows: Supplier[]) => {
    http.expectOne((r) => r.url === `${base}suppliers`).flush(rows);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };

  it('lists suppliers with the ledger party balance and what we owe in total', async () => {
    const fixture = create();
    await flushList(fixture, [supplier(), supplier({ _id: 's2', name: 'الدلتا', balance: 0, openingAmount: 0, paymentTermsDays: 0 })]);
    const rows = fixture.nativeElement.querySelectorAll('tbody tr');
    expect(rows.length).toBe(2);
    expect(rows[0].textContent).toContain('الشركة المصرية للإضاءة');
    expect(rows[0].querySelector('[data-test="supplier-balance"]').textContent).toContain('6,650.00');
    expect(fixture.componentInstance.totalWeOwe()).toBe(6650);
    http.verify();
  });

  it("the balances report links a supplier's name here with ?statement=<id>: that supplier's statement opens", async () => {
    TestBed.configureTestingModule({
      imports: [SuppliersPageComponent, TranslateModule.forRoot()],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([]), { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: convertToParamMap({ statement: 's2' }) } } }],
    });
    http = TestBed.inject(HttpTestingController);
    TestBed.inject(LanguageService).selectedLanguage.set('en');
    const fixture = TestBed.createComponent(SuppliersPageComponent);
    fixture.detectChanges();
    expect(fixture.componentInstance.selectedId()).toBe('s2');
    http.expectOne((r) => r.url === `${base}suppliers`).flush([supplier(), supplier({ _id: 's2', name: 'الدلتا', balance: 0, openingAmount: 0, paymentTermsDays: 0 })]);
    fixture.detectChanges();
    expect(fixture.componentInstance.selected()?.name).toBe('الدلتا');
  });

  it('a supplier with a debit balance (they owe us) gets the warning hint', async () => {
    const fixture = create();
    await flushList(fixture, [supplier({ balance: -200 })]);
    expect(fixture.nativeElement.querySelector('[data-test="supplier-balance"]').classList).toContain('sp__warn');
    expect(fixture.nativeElement.querySelector('.sp__hint')).toBeTruthy();
    http.verify();
  });

  it('the row links to the ledger of account 21 filtered by that supplier', async () => {
    const fixture = create();
    await flushList(fixture, [supplier()]);
    expect(fixture.nativeElement.querySelector('[data-action="ledger"]').getAttribute('href')).toBe('/accounting/accounts/acc21/ledger?partyId=s1');
    http.verify();
  });

  it('searching sends the search text', async () => {
    const fixture = create();
    await flushList(fixture, []);
    fixture.componentInstance.search = 'نيل';
    fixture.componentInstance.load();
    expect(http.expectOne((r) => r.url === `${base}suppliers`).request.params.get('search')).toBe('نيل');
    http.verify();
  });

  it('view-only users get no add, edit or delete', async () => {
    const fixture = create(['suppliers.view']);
    await flushList(fixture, [supplier()]);
    expect(fixture.nativeElement.querySelector('[data-action="new-supplier"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('[data-action="edit"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('[data-action="delete"]')).toBeNull();
    http.verify();
  });

  it('delete: 409 SUPPLIER_HAS_BALANCE shows the blocked message', async () => {
    const fixture = create();
    await flushList(fixture, [supplier()]);
    (fixture.nativeElement.querySelector('[data-action="delete"]') as HTMLElement).click();
    http.expectOne(`${base}suppliers/s1`).flush({ code: 'SUPPLIER_HAS_BALANCE' }, { status: 409, statusText: 'Conflict' });
    fixture.detectChanges();
    expect(fixture.componentInstance.deleteError()).toBe('suppliers.deleteBlocked');
    expect(fixture.nativeElement.querySelector('[data-test="delete-error"]')).toBeTruthy();
    http.verify();
  });

  it('edit goes to the supplier form', async () => {
    const fixture = create();
    const router = TestBed.inject(Router);
    spyOn(router, 'navigate');
    await flushList(fixture, [supplier()]);
    (fixture.nativeElement.querySelector('[data-action="edit"]') as HTMLElement).click();
    expect(router.navigate).toHaveBeenCalledWith(['/suppliers/edit', 's1']);
    http.verify();
  });
});

describe('payment terms mapping', () => {
  it('maps the choice to days (0 = cash) and back', () => {
    expect(paymentTermsToDays('none', null)).toBeNull();
    expect(paymentTermsToDays('cash', null)).toBe(0);
    expect(paymentTermsToDays('30', null)).toBe(30);
    expect(paymentTermsToDays('60', null)).toBe(60);
    expect(paymentTermsToDays('custom', 45)).toBe(45);
    expect(paymentTermsToDays('custom', -1)).toBeNull();
    expect(paymentTermsToDays('custom', 1.5)).toBeNull();
    expect(daysToPaymentTerms(0)).toEqual({ choice: 'cash', custom: null });
    expect(daysToPaymentTerms(30)).toEqual({ choice: '30', custom: null });
    expect(daysToPaymentTerms(45)).toEqual({ choice: 'custom', custom: 45 });
    expect(daysToPaymentTerms(undefined)).toEqual({ choice: 'none', custom: null });
  });
});

describe('SupplierFormComponent', () => {
  let http: HttpTestingController;
  const create = (id: string | null) => {
    TestBed.configureTestingModule({
      imports: [SupplierFormComponent, TranslateModule.forRoot()],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([]), { provide: ActivatedRoute, useValue: { snapshot: { paramMap: convertToParamMap(id ? { id } : {}) } } }],
    });
    http = TestBed.inject(HttpTestingController);
    const router = TestBed.inject(Router);
    spyOn(router, 'navigate');
    const fixture = TestBed.createComponent(SupplierFormComponent);
    fixture.detectChanges();
    return { fixture, router };
  };

  it('only the name is required: an empty form is not sent', () => {
    const { fixture } = create(null);
    fixture.componentInstance.save();
    http.expectNone(`${base}suppliers`);
    expect(fixture.componentInstance.submitted()).toBeTrue();
    expect(fixture.componentInstance.form.controls.name.invalid).toBeTrue();
  });

  it('creates with the design fields and optional terms; empty optionals are sent as empty strings', () => {
    const { fixture, router } = create(null);
    fixture.componentInstance.form.patchValue({ name: ' شركة النيل ', phone: '0102', supplies: 'شواحن', taxNumber: '123', termsChoice: 'cash' });
    fixture.componentInstance.save();
    const req = http.expectOne(`${base}suppliers`);
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ name: 'شركة النيل', phone: '0102', contactPerson: '', address: '', supplies: 'شواحن', taxNumber: '123', paymentTermsDays: 0, notes: '' });
    req.flush({ _id: 's9' });
    expect(router.navigate).toHaveBeenCalledWith(['/suppliers']);
  });

  it('custom terms need a whole number of days', () => {
    const { fixture } = create(null);
    fixture.componentInstance.form.patchValue({ name: 'مورد', termsChoice: 'custom', termsCustom: null });
    fixture.componentInstance.save();
    http.expectNone(`${base}suppliers`);
    fixture.componentInstance.form.patchValue({ termsCustom: 45 });
    fixture.componentInstance.save();
    expect(http.expectOne(`${base}suppliers`).request.body.paymentTermsDays).toBe(45);
  });

  it('edit loads the supplier, shows its values and saves with PUT', () => {
    const { fixture } = create('s1');
    http.expectOne(`${base}suppliers/s1`).flush(supplier({ paymentTermsDays: 45, phones: ['0102'] }));
    const value = fixture.componentInstance.form.getRawValue();
    expect(value.name).toBe('الشركة المصرية للإضاءة');
    expect(value.phone).toBe('0102');
    expect(value.termsChoice).toBe('custom');
    expect(value.termsCustom).toBe(45);
    fixture.componentInstance.save();
    const req = http.expectOne(`${base}suppliers/s1`);
    expect(req.request.method).toBe('PUT');
    expect(req.request.body.paymentTermsDays).toBe(45);
    req.flush({});
  });
});
