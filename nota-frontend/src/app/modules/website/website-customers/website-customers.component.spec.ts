import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { TranslateModule } from '@ngx-translate/core';
import { environment } from '../../../../environments/environment';
import { signInAs } from '../../../core/auth/testing/sign-in';
import { WebsiteCustomersComponent } from './website-customers.component';

/** Online Stage 4: /website/customers: search, orders count, deactivate, and a reset password that shows the temporary one once. */
describe('WebsiteCustomersComponent (Online Stage 4)', () => {
  const url = `${environment.api_base_url}website/customers`;
  let http: HttpTestingController;
  let fixture: any;
  let component: any;
  const customers = [
    { id: 'u1', name: 'منى', phone: '01012345678', isActive: true, ordersCount: 3, createdAt: '2026-10-01T10:00:00Z', lastLoginAt: null },
    { id: 'u2', name: 'علي', phone: '01111111111', isActive: false, ordersCount: 0, createdAt: '2026-10-02T10:00:00Z', lastLoginAt: null },
  ];
  const page = (data = customers) => ({ data, pagination: { page: 1, totalPages: 1, totalItems: data.length } });

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [WebsiteCustomersComponent, TranslateModule.forRoot()],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideNoopAnimations()],
    }).compileComponents();
    signInAs('owner');
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(WebsiteCustomersComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
    http.expectOne((r) => r.url === url && r.method === 'GET').flush(page());
    fixture.detectChanges();
  });
  afterEach(() => http.verify());

  it('lists the customers with their order count and status', () => {
    const rows: HTMLElement[] = Array.from(fixture.nativeElement.querySelectorAll('[data-test="customer-row"]'));
    expect(rows.length).toBe(2);
    expect(rows[0].textContent).toContain('منى');
    expect(rows[0].textContent).toContain('3');
    expect(rows[1].classList).toContain('is-off');
  });

  it('search sends q; deactivate/activate sends isActive', () => {
    component.q.set('منى');
    component.reload();
    const search = http.expectOne((r) => r.url === url && r.method === 'GET');
    expect(search.request.params.get('q')).toBe('منى');
    search.flush(page([customers[0]]));
    component.toggle(customers[0]);
    const put = http.expectOne((r) => r.url === `${url}/u1` && r.method === 'PUT');
    expect(put.request.body).toEqual({ isActive: false });
    put.flush({});
    http.expectOne((r) => r.url === url && r.method === 'GET').flush(page());
  });

  it('reset password: asks first, shows the temporary password once, and forgets it when the dialog closes', () => {
    component.askReset(customers[0]);
    expect(component.resetting().id).toBe('u1');
    expect(component.temporaryPassword()).toBe('');
    component.confirmReset();
    http.expectOne((r) => r.url === `${url}/u1/reset-password` && r.method === 'POST').flush({ temporaryPassword: 'abcd2345Xy' });
    fixture.detectChanges();
    expect(component.temporaryPassword()).toBe('abcd2345Xy');
    expect(document.body.textContent).toContain('abcd2345Xy');
    component.closeReset();
    fixture.detectChanges();
    expect(component.temporaryPassword()).toBe('');
    expect(document.body.textContent).not.toContain('abcd2345Xy');
  });
});
