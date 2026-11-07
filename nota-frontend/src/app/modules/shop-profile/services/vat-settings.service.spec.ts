import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { environment } from '../../../../environments/environment';
import { ShopProfileService } from './shop-profile.service';
import { VatSettingsService } from './vat-settings.service';

/** Stage 21 review: the screens re-read the VAT settings when they open and take the server's block from a 409 answer. */
describe('VatSettingsService (Stage 21 review)', () => {
  const url = `${environment.api_base_url}shop-profile`;
  let http: HttpTestingController;
  let service: VatSettingsService;
  let profile: ShopProfileService;
  const vat = (extra: object = {}) => ({ enabled: true, rate: 14, pricesIncludeVat: false, startDate: '2026-11-01', ...extra });

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
    service = TestBed.inject(VatSettingsService);
    profile = TestBed.inject(ShopProfileService);
  });
  afterEach(() => http.verify());

  it('refresh() reads GET /api/shop-profile and the settings follow it', () => {
    expect(service.settings()).toBeNull();
    service.refresh();
    const req = http.expectOne(url);
    expect(req.request.method).toBe('GET');
    req.flush({ name: 'متجر', vat: vat() });
    expect(service.enabled()).toBeTrue();
    expect(service.contextFor('2026-11-07')).toEqual({ rate: 14, included: false });
    expect(service.contextFor('2026-10-31')).toBeNull();
  });

  it('a failed refresh keeps what was cached', () => {
    profile.getProfile().subscribe();
    http.expectOne(url).flush({ name: 'متجر', vat: vat() });
    service.refresh();
    http.expectOne(url).flush({}, { status: 500, statusText: 'Server Error' });
    expect(service.enabled()).toBeTrue();
  });

  it('applyServerVat() takes the server\'s block at once, without a request, and keeps the rest of the profile', () => {
    profile.getProfile().subscribe();
    http.expectOne(url).flush({ name: 'متجر', taxNumber: '123', vat: { enabled: false, rate: 14, pricesIncludeVat: true, startDate: null } });
    expect(service.enabled()).toBeFalse();
    service.applyServerVat(vat({ pricesIncludeVat: false }));
    http.expectNone(url);
    expect(service.enabled()).toBeTrue();
    expect(service.contextFor('2026-11-07')).toEqual({ rate: 14, included: false });
    expect(profile.profile()?.name).toBe('متجر');
    expect(profile.profile()?.taxNumber).toBe('123');
  });

  it('applyServerVat() without a block (or with no profile cached yet) falls back to reading the profile', () => {
    service.applyServerVat(vat());
    http.expectOne(url).flush({ name: 'متجر', vat: vat() });
    expect(service.enabled()).toBeTrue();
    service.applyServerVat(null);
    http.expectOne(url).flush({ name: 'متجر' });
  });
});
