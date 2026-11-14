import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { environment } from '../../../../../environments/environment';
import { signInAs } from '../../../../core/auth/testing/sign-in';
import { ShopProfileComponent } from './shop-profile.component';

/** Stage 24: the shop name is locked to the license; the license card is the owner's. */
describe('ShopProfileComponent license lock (Stage 24)', () => {
  const url = `${environment.api_base_url}shop-profile`;
  const licenseUrl = `${environment.api_base_url}license/info`;
  let http: HttpTestingController;
  let fixture: ReturnType<typeof TestBed.createComponent<ShopProfileComponent>>;
  let component: any;
  const el = () => fixture.nativeElement as HTMLElement;
  const settle = async () => { fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges(); };
  const LOCKED = { name: 'محل النور', nameEn: 'Al Nour', nameLocked: true, address: '', phones: [], logo: null, taxNumber: '', commercialRegister: '', invoiceFooter: '' };

  const open = async (role: 'owner' | 'manager', profile: Record<string, unknown> = LOCKED) => {
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

  it('a locked name: the field is read-only, the form stays valid, and the same name (and English name) go back on save', async () => {
    await open('manager');
    const input = el().querySelector('#sp-name') as HTMLInputElement;
    expect(input.value).toBe('محل النور');
    expect(input.disabled).toBe(true);
    expect(component.form.valid).toBe(true);
    component.form.patchValue({ address: 'شارع 1' });
    component.save();
    const req = http.expectOne((r) => r.url === url && r.method === 'PUT');
    expect(req.request.body.name).toBe('محل النور');
    expect(req.request.body.nameEn).toBe('Al Nour');
    expect('nameLocked' in req.request.body).toBe(false);
    req.flush(LOCKED);
  });

  it('an unlocked profile (no license info) keeps the editable name', async () => {
    await open('manager', { ...LOCKED, nameLocked: undefined, nameEn: undefined });
    expect((el().querySelector('#sp-name') as HTMLInputElement).disabled).toBe(false);
  });

  it('a manager does not see the license card (and nothing is requested); the owner does and it asks for the license info', async () => {
    await open('manager');
    expect(el().querySelector('[data-test="license-card"]')).toBeNull();
    http.expectNone(licenseUrl);
    TestBed.resetTestingModule();
    await open('owner');
    expect(el().querySelector('[data-test="license-card"]')).not.toBeNull();
    http.expectOne(licenseUrl).flush({ licenseId: 'L', type: 'lifetime', shopName: 'محل النور', shopNameEn: null, machineId: 'AAAA-AAAA-AAAA-AAAA', maxClients: 1, issuedAt: '2026-01-01T00:00:00Z', clientsUsed: 0, clients: [] });
  });
});
