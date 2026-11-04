import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting, TestRequest } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { TranslateModule } from '@ngx-translate/core';
import { environment } from '../../../../../environments/environment';
import { CustomersComponent } from './customers.component';

/** Stage 10 payload safety for /customers. Template-free so it runs unchanged before and after the redesign. */
describe('CustomersComponent payloads (Stage 10 safety)', () => {
  const base = environment.api_base_url;
  let component: CustomersComponent;
  let http: HttpTestingController;
  const customers = [
    { _id: 'cu1', name: 'م. سامي', phone: '01001234567', isIndebted: true },
    { _id: 'cu2', name: 'ورشة النور', phone: '01119876543', isIndebted: false },
  ];
  const params = (req: TestRequest) =>
    Object.fromEntries(req.request.params.keys().map((key) => [key, req.request.params.get(key)]));
  const expectList = (expected: Record<string, string>) => {
    const req = http.expectOne((r) => r.url === `${base}customers` && r.method === 'GET');
    expect(params(req)).toEqual(expected);
    req.flush(customers);
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [CustomersComponent, TranslateModule.forRoot()],
      providers: [provideRouter([]), provideNoopAnimations(), provideHttpClient(), provideHttpClientTesting()],
    })
      .overrideComponent(CustomersComponent, { set: { template: '', imports: [] } })
      .compileComponents();

    http = TestBed.inject(HttpTestingController);
    component = TestBed.createComponent(CustomersComponent).componentInstance;
    component.ngOnInit();
    expectList({});
  });

  afterEach(() => http.verify());

  it('search (trimmed) and clear', () => {
    component.searchTerm = '  سامي ';
    component.searchCustomers();
    expectList({ search: 'سامي' });
    component.clearSearch();
    expectList({});
  });

  it('create: POST customers {name, phone}; duplicate phone error is shown', () => {
    component.customerForm.patchValue({ name: 'أحمد', phone: '01286409921' });
    component.saveCustomer();
    const req = http.expectOne(`${base}customers`);
    expect(req.request.method).toBe('POST');
    expect(JSON.stringify(req.request.body)).toBe(JSON.stringify({ name: 'أحمد', phone: '01286409921' }));
    req.flush({ message: 'رقم الهاتف مستخدم بالفعل' }, { status: 400, statusText: 'Bad Request' });
    expect(component.errorMessage).toBe('رقم الهاتف مستخدم بالفعل');
  });

  it('create succeeds → list reloads with the current search', () => {
    component.searchTerm = 'س';
    component.customerForm.patchValue({ name: 'أحمد', phone: '0128' });
    component.saveCustomer();
    http.expectOne(`${base}customers`).flush({ _id: 'cu3' }, { status: 201, statusText: 'Created' });
    expectList({ search: 'س' });
  });

  it('no request when name or phone is missing', () => {
    component.customerForm.patchValue({ name: 'أحمد', phone: '' });
    component.saveCustomer();
    http.expectNone(`${base}customers`);
  });

  it('edit: GET customers/:id then PUT customers/:id {name, phone}', () => {
    component.editCustomer(customers[0]);
    const get = http.expectOne(`${base}customers/cu1`);
    expect(get.request.method).toBe('GET');
    get.flush(customers[0]);
    component.customerForm.patchValue({ name: 'م. سامي للمقاولات' });
    component.saveCustomer();
    const put = http.expectOne(`${base}customers/cu1`);
    expect(put.request.method).toBe('PUT');
    expect(JSON.stringify(put.request.body)).toBe(JSON.stringify({ name: 'م. سامي للمقاولات', phone: '01001234567' }));
    put.flush({});
    expectList({});
  });

  it('delete: DELETE customers/:id with no body', () => {
    component.promptDelete(customers[1]);
    component.deleteCustomer();
    const req = http.expectOne(`${base}customers/cu2`);
    expect(req.request.method).toBe('DELETE');
    expect(req.request.body).toBeNull();
    req.flush({});
    expectList({});
  });

  it('delete with credit invoices: 409 → resend with {restoreCreditInvoices}', (done) => {
    component.promptDelete(customers[0]);
    component.deleteCustomer();
    http.expectOne(`${base}customers/cu1`).flush(
      { message: 'له فواتير آجلة', requiresConfirmation: true, relatedCreditInvoiceCount: 2 },
      { status: 409, statusText: 'Conflict' }
    );
    setTimeout(() => {
      expect(component.restoreCreditInvoicesVisible).toBeTrue();
      expect(component.deleteConfirmation?.relatedCreditInvoiceCount).toBe(2);
      component.confirmDeleteWithCreditInvoices(true);
      const req = http.expectOne(`${base}customers/cu1`);
      expect(req.request.method).toBe('DELETE');
      expect(JSON.stringify(req.request.body)).toBe(JSON.stringify({ restoreCreditInvoices: true }));
      req.flush({});
      expectList({});
      done();
    });
  });
});
