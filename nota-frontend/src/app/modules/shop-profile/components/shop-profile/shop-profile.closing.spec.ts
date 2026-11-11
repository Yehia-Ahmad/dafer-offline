import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { environment } from '../../../../../environments/environment';
import { signInAs } from '../../../../core/auth/testing/sign-in';
import { ShopProfileComponent } from './shop-profile.component';

/** Stage 22: the "إقفال الفترات" card of the shop profile (owner). */
describe('ShopProfileComponent closing card (Stage 22)', () => {
  const url = `${environment.api_base_url}shop-profile`;
  let http: HttpTestingController;
  let fixture: ReturnType<typeof TestBed.createComponent<ShopProfileComponent>>;
  let component: any;
  const el = () => fixture.nativeElement as HTMLElement;
  const settle = async () => { fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges(); };
  const PROFILE = { name: 'النور', address: '', phones: [], logo: null, taxNumber: '', commercialRegister: '', invoiceFooter: '' };

  const open = async (role: 'owner' | 'manager', profile: Record<string, unknown> = PROFILE) => {
    await TestBed.configureTestingModule({
      imports: [ShopProfileComponent, TranslateModule.forRoot()],
      providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
    signInAs(role);
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(ShopProfileComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
    http.expectOne((r) => r.url === url && r.method === 'GET').flush(profile);
    await settle();
  };
  afterEach(() => http.verify());

  it('only the owner sees the card; it shows the stored frequency and fiscal year start', async () => {
    await open('manager');
    expect(el().querySelector('[data-test="closing-card"]')).toBeNull();
  });

  it('the owner: monthly from January by default, the stored values when saved before', async () => {
    await open('owner');
    expect(el().querySelector('[data-test="closing-card"]')).not.toBeNull();
    expect((el().querySelector('[data-field="closing-monthly"]') as HTMLInputElement).checked).toBeTrue();
    expect((el().querySelector('[data-field="closing-month"]') as HTMLSelectElement).value).toContain('1');
  });

  it('a shop that never touched the card sends exactly what it always sent (no closing block)', async () => {
    await open('owner');
    component.save();
    const req = http.expectOne((r) => r.url === url && r.method === 'PUT');
    expect('closing' in req.request.body).toBeFalse();
    req.flush(PROFILE);
  });

  it('touching the card sends { frequency, fiscalYearStartMonth }; once saved it keeps being sent', async () => {
    await open('owner');
    (el().querySelector('[data-field="closing-yearly"]') as HTMLInputElement).click();
    component.form.controls.closingStartMonth.setValue(7); component.form.controls.closingStartMonth.markAsDirty();
    component.save();
    const req = http.expectOne((r) => r.url === url && r.method === 'PUT');
    expect(req.request.body.closing).toEqual({ frequency: 'yearly', fiscalYearStartMonth: 7 });
    req.flush({ ...PROFILE, closing: { frequency: 'yearly', fiscalYearStartMonth: 7 } });
    await settle();
    component.save();
    const again = http.expectOne((r) => r.url === url && r.method === 'PUT');
    expect(again.request.body.closing).toEqual({ frequency: 'yearly', fiscalYearStartMonth: 7 });
    again.flush({ ...PROFILE, closing: { frequency: 'yearly', fiscalYearStartMonth: 7 } });
  });

  it('a stored closing block fills the card', async () => {
    await open('owner', { ...PROFILE, closing: { frequency: 'yearly', fiscalYearStartMonth: 7 } });
    expect((el().querySelector('[data-field="closing-yearly"]') as HTMLInputElement).checked).toBeTrue();
    expect(component.form.controls.closingStartMonth.value).toBe(7);
  });

  it('a manager never sends the closing block, even when the shop has one stored', async () => {
    await open('manager', { ...PROFILE, closing: { frequency: 'yearly', fiscalYearStartMonth: 1 } });
    component.save();
    const req = http.expectOne((r) => r.url === url && r.method === 'PUT');
    expect('closing' in req.request.body).toBeFalse();
    req.flush(PROFILE);
  });
});
