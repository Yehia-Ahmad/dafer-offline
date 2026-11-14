import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { environment } from '../../../../environments/environment';
import { LicenseService } from './license.service';

/** Stage 24: the license endpoints used by the shop-profile card. */
describe('LicenseService (Stage 24)', () => {
  const base = `${environment.api_base_url}license`;
  let http: HttpTestingController;
  let service: LicenseService;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
    service = TestBed.inject(LicenseService);
  });
  afterEach(() => http.verify());

  it('info: GET license/info', () => {
    let got: unknown;
    service.info().subscribe((info) => (got = info));
    const req = http.expectOne(`${base}/info`);
    expect(req.request.method).toBe('GET');
    req.flush({ licenseId: 'L1', clientsUsed: 1, clients: [] });
    expect((got as { licenseId: string }).licenseId).toBe('L1');
  });

  it('replace: POST license/activate with { license }', () => {
    service.replace('NOTA1.a.b').subscribe();
    const req = http.expectOne(`${base}/activate`);
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ license: 'NOTA1.a.b' });
    req.flush({});
  });

  it('allow: POST license/clients/:id/allow (re-allows a removed PC), id encoded', () => {
    service.allow('pc/with space').subscribe();
    const req = http.expectOne(`${base}/clients/pc%2Fwith%20space/allow`);
    expect(req.request.method).toBe('POST');
    req.flush({ allowed: true });
  });

  it('unpair: DELETE license/clients/:id with the id encoded', () => {
    service.unpair('pc/with space').subscribe();
    const req = http.expectOne(`${base}/clients/pc%2Fwith%20space`);
    expect(req.request.method).toBe('DELETE');
    req.flush({ unpaired: true });
  });
});
