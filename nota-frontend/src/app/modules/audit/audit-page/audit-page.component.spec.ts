import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, TestRequest, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { TranslateModule } from '@ngx-translate/core';
import { environment } from '../../../../environments/environment';
import { signInAs } from '../../../core/auth/testing/sign-in';
import { AuditPageComponent } from './audit-page.component';

describe('AuditPageComponent (Stage 14)', () => {
  const base = environment.api_base_url;
  let fixture: ComponentFixture<AuditPageComponent>;
  let component: AuditPageComponent;
  let http: HttpTestingController;
  const params = (req: TestRequest) => Object.fromEntries(req.request.params.keys().map((key) => [key, req.request.params.get(key)]));
  const entries = [
    { _id: 'a1', at: '2026-11-05T09:02:00Z', userId: 'u1', userName: 'محمود', action: 'auth.login', entity: 'User', details: { username: 'mahmoud' } },
    { _id: 'a2', at: '2026-11-05T08:00:00Z', userId: 'u2', userName: 'أحمد', action: 'sale.deleted', entity: 'Selling', details: null },
  ];
  const pageOf = (page: number, totalPages: number) => ({ success: true, data: entries, pagination: { page, limit: 25, totalItems: 60, totalPages } });

  const create = async (role: 'owner' | 'accountant') => {
    await TestBed.configureTestingModule({
      imports: [AuditPageComponent, TranslateModule.forRoot()],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideNoopAnimations()],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    signInAs(role);
    fixture = TestBed.createComponent(AuditPageComponent);
    component = fixture.componentInstance;
  };

  afterEach(() => http.verify());

  it('accountant (audit.view, no users.manage): GET audit?page=1&limit=25 only; users for the filter come from the entries', async () => {
    await create('accountant');
    const req = http.expectOne((r) => r.url === `${base}audit`);
    expect(params(req)).toEqual({ page: '1', limit: '25' });
    req.flush(pageOf(1, 3));
    http.expectNone(`${base}users`);
    fixture.detectChanges();
    expect(component.userOptions().map((option) => option.label)).toEqual(['محمود', 'أحمد']);
    expect(fixture.nativeElement.querySelectorAll('tbody tr').length).toBe(2);
  });

  it('owner: the user filter uses GET users', async () => {
    await create('owner');
    http.expectOne(`${base}users`).flush({ users: [{ _id: 'u1', name: 'محمود' }] });
    http.expectOne((r) => r.url === `${base}audit`).flush(pageOf(1, 1));
    expect(component.userOptions()).toEqual([{ label: 'محمود', value: 'u1' }]);
  });

  it('filters: from, to (yyyy-MM-dd), userId, action; back to page 1; reset clears them', async () => {
    await create('accountant');
    http.expectOne((r) => r.url === `${base}audit`).flush(pageOf(1, 3));
    component.dateFrom = new Date(2026, 10, 1);
    component.dateTo = new Date(2026, 10, 5);
    component.userId = 'u1';
    component.action = 'sale.deleted';
    component.search();
    const req = http.expectOne((r) => r.url === `${base}audit`);
    expect(params(req)).toEqual({ page: '1', limit: '25', from: '2026-11-01', to: '2026-11-05', userId: 'u1', action: 'sale.deleted' });
    req.flush(pageOf(1, 1));
    component.reset();
    expect(params(http.expectOne((r) => r.url === `${base}audit`))).toEqual({ page: '1', limit: '25' });
  });

  it('pagination: next page keeps the filters', async () => {
    await create('accountant');
    http.expectOne((r) => r.url === `${base}audit`).flush(pageOf(1, 3));
    component.action = 'auth.login';
    component.load(2);
    const req = http.expectOne((r) => r.url === `${base}audit`);
    expect(params(req)).toEqual({ page: '2', limit: '25', action: 'auth.login' });
    req.flush(pageOf(2, 3));
    expect(component.page()).toBe(2);
  });

  it('details summary is short and never empty-crashes', async () => {
    await create('accountant');
    http.expectOne((r) => r.url === `${base}audit`).flush(pageOf(1, 1));
    expect(component.detailsSummary(entries[0] as any)).toBe('username: mahmoud'); // no translation loaded: the raw key name
    expect(component.detailsSummary(entries[1] as any)).toBe('');
    expect(component.detailsSummary({ details: { changes: 'x'.repeat(300) } } as any).length).toBeLessThanOrEqual(120);
  });
});
