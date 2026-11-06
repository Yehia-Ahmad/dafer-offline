import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { environment } from '../../../environments/environment';
import { OpeningService } from './opening.service';

/** Payload specs for every Stage 18 opening call. */
describe('OpeningService payloads', () => {
  const base = environment.api_base_url;
  let service: OpeningService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    service = TestBed.inject(OpeningService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('GET accounting/opening', () => {
    service.get().subscribe();
    const req = http.expectOne(`${base}accounting/opening`);
    expect(req.request.method).toBe('GET');
    req.flush({});
  });

  it('POST accounting/opening sends exactly the wizard amounts', () => {
    const payload = {
      cash: 15000, fixedAssets: 0,
      banks: [{ name: 'بنك مصر', type: 'bank' as const, amount: 30000 }, { accountId: 'a1', amount: 10 }],
      customers: [{ customerId: 'c1', amount: 4000 }],
      suppliers: [{ supplierId: 's1', amount: -200 }],
    };
    service.save(payload).subscribe();
    const req = http.expectOne(`${base}accounting/opening`);
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual(payload);
    req.flush({});
  });

  it('POST accounting/opening/finalize sends the explicit confirmation', () => {
    service.finalize().subscribe();
    const req = http.expectOne(`${base}accounting/opening/finalize`);
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ confirm: true });
    req.flush({});
  });

  it('GET products pages by 100 (the API maximum) for the inventory table', () => {
    service.listProducts(3).subscribe();
    const req = http.expectOne((r) => r.url === `${base}products`);
    expect(req.request.params.get('page')).toBe('3');
    expect(req.request.params.get('limit')).toBe('100');
    req.flush({ data: [], pagination: { page: 3, totalPages: 3, hasNextPage: false } });
  });

  it('PUT products/:id sends only the stock and the purchase price', () => {
    service.updateProduct('p 1', { inventoryCount: 20, purchasePrice: 99.5 }).subscribe();
    const req = http.expectOne(`${base}products/p%201`);
    expect(req.request.method).toBe('PUT');
    expect(req.request.body).toEqual({ inventoryCount: 20, purchasePrice: 99.5 });
    req.flush({});
  });
});
