import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { environment } from '../../../../../environments/environment';
import { LicenseCardComponent } from './license-card.component';

/** Stage 24: the "الترخيص" card (owner). */
describe('LicenseCardComponent (Stage 24)', () => {
  const base = `${environment.api_base_url}license`;
  let http: HttpTestingController;
  let fixture: ReturnType<typeof TestBed.createComponent<LicenseCardComponent>>;
  let component: any;
  const el = () => fixture.nativeElement as HTMLElement;
  const settle = async () => { fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges(); };
  const INFO = {
    licenseId: 'NOTA-ABC123', type: 'lifetime', shopName: 'محل النور', shopNameEn: null, machineId: '1A2B-3C4D-5E6F-7A8B',
    maxClients: 3, issuedAt: '2026-05-01T00:00:00.000Z', clientsUsed: 2,
    clients: [
      { deviceId: 'pc-0001-aaaa', name: 'كاشير 1', lastSeenAt: '2026-06-01T10:00:00.000Z', pairedAt: '2026-05-02T00:00:00.000Z' },
      { deviceId: 'pc-0002-bbbb', name: '', lastSeenAt: null, pairedAt: null },
    ],
  };

  const open = async (info: unknown = INFO) => {
    await TestBed.configureTestingModule({
      imports: [LicenseCardComponent, TranslateModule.forRoot()],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    TestBed.inject(TranslateService).setTranslation('ar', { license: { clientsOf: '{{used}} من {{max}}', errors: { WRONG_MACHINE: 'جهاز تاني', DEFAULT: 'فشل' }, replaced: 'تم', unpaired: 'اتفصل' } });
    TestBed.inject(TranslateService).use('ar');
    fixture = TestBed.createComponent(LicenseCardComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
    http.expectOne(`${base}/info`).flush(info);
    await settle();
  };
  afterEach(() => http.verify());

  const field = (name: string) => el().querySelector(`[data-field="${name}"]`)?.textContent?.trim();

  it('shows the shop name, license ID, lifetime type, clients used of allowed, Machine ID and issue date', async () => {
    await open();
    expect(field('license-shop')).toBe('محل النور');
    expect(field('license-id')).toBe('NOTA-ABC123');
    expect(field('license-type')).toContain('license.lifetime');
    expect(field('license-clients')).toBe('2 من 3');
    expect(field('license-machine')).toBe('1A2B-3C4D-5E6F-7A8B');
    expect(field('license-issued')).toBe('2026-05-01');
    expect(el().querySelectorAll('[data-test="license-client"]').length).toBe(2);
    expect(el().textContent).toContain('كاشير 1');
    expect(el().textContent).toContain('pc-0002-bbbb'); // no name: the id is shown
  });

  it('removed (revoked) PCs are listed separately; "allow" re-allows one and the card reloads', async () => {
    await open({ ...INFO, revoked: [{ deviceId: 'pc-0009-zzzz', name: 'كاشير قديم', revokedAt: '2026-06-02T00:00:00.000Z' }] });
    expect(el().querySelectorAll('[data-test="license-revoked"]').length).toBe(1);
    expect(el().querySelector('[data-test="license-revoked"]')?.textContent).toContain('كاشير قديم');
    (el().querySelector('[data-action="allow"]') as HTMLButtonElement).click();
    const post = http.expectOne(`${base}/clients/pc-0009-zzzz/allow`);
    expect(post.request.method).toBe('POST');
    post.flush({ allowed: true });
    http.expectOne(`${base}/info`).flush({ ...INFO, revoked: [] });
    await settle();
    expect(el().querySelector('[data-test="license-revoked"]')).toBeNull();
  });

  it('an older backend without a "revoked" list shows no removed-PCs section', async () => {
    await open(INFO);
    expect(el().querySelector('[data-test="license-revoked"]')).toBeNull();
  });

  it('no paired clients: says so and shows no list', async () => {
    await open({ ...INFO, clientsUsed: 0, clients: [] });
    expect(el().querySelector('[data-test="license-no-clients"]')).not.toBeNull();
    expect(el().querySelectorAll('[data-test="license-client"]').length).toBe(0);
  });

  it('unpair: DELETE for that device, then the card reloads and shows the freed slot', async () => {
    await open();
    (el().querySelectorAll('[data-action="unpair"]')[0] as HTMLButtonElement).click();
    const del = http.expectOne(`${base}/clients/pc-0001-aaaa`);
    expect(del.request.method).toBe('DELETE');
    del.flush({ unpaired: true });
    http.expectOne(`${base}/info`).flush({ ...INFO, clientsUsed: 1, clients: [INFO.clients[1]] });
    await settle();
    expect(field('license-clients')).toBe('1 من 3');
    expect(el().querySelectorAll('[data-test="license-client"]').length).toBe(1);
    expect(el().querySelector('[data-test="license-status"]')?.textContent).toContain('اتفصل');
  });

  it('replace: the activate button needs text; success reloads the card; a refusal shows the reason and keeps the form open', async () => {
    await open();
    (el().querySelector('[data-action="replace-license"]') as HTMLButtonElement).click();
    await settle();
    const activate = () => el().querySelector('[data-action="activate-license"]') as HTMLButtonElement;
    expect(activate().disabled).toBe(true);
    component.text.set('NOTA1.bad.sig');
    await settle();
    activate().click();
    let req = http.expectOne(`${base}/activate`);
    expect(req.request.body).toEqual({ license: 'NOTA1.bad.sig' });
    req.flush({ code: 'LICENSE_INVALID', reason: 'WRONG_MACHINE' }, { status: 400, statusText: 'Bad Request' });
    await settle();
    expect(el().querySelector('[data-test="license-status"]')?.textContent).toContain('جهاز تاني');
    expect(el().querySelector('[data-test="license-replace"]')).not.toBeNull();

    component.text.set('NOTA1.good.sig');
    await settle();
    activate().click();
    req = http.expectOne(`${base}/activate`);
    req.flush({ licensed: true });
    http.expectOne(`${base}/info`).flush({ ...INFO, maxClients: 5 });
    http.expectOne((r) => r.url === `${environment.api_base_url}shop-profile` && r.method === 'GET').flush({ name: 'محل النور' }); // the name comes from the license
    await settle();
    expect(field('license-clients')).toBe('2 من 5');
    expect(el().querySelector('[data-test="license-replace"]')).toBeNull();
  });

  it('cancel closes the replace form without a request', async () => {
    await open();
    (el().querySelector('[data-action="replace-license"]') as HTMLButtonElement).click();
    await settle();
    (el().querySelector('[data-action="cancel-replace"]') as HTMLButtonElement).click();
    await settle();
    expect(el().querySelector('[data-test="license-replace"]')).toBeNull();
    http.expectNone(`${base}/activate`);
  });

  it('a failed load shows an error instead of the details', async () => {
    await TestBed.configureTestingModule({ imports: [LicenseCardComponent, TranslateModule.forRoot()], providers: [provideHttpClient(), provideHttpClientTesting()] }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(LicenseCardComponent);
    fixture.detectChanges();
    http.expectOne(`${base}/info`).flush({}, { status: 500, statusText: 'x' });
    await settle();
    expect(el().querySelector('[data-test="license-load-failed"]')).not.toBeNull();
    expect(el().querySelector('[data-field="license-shop"]')).toBeNull();
  });
});
