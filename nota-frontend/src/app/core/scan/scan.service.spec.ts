import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { environment } from '../../../environments/environment';
import { ScanService } from './scan.service';
import { answerScan, tick } from './scan-testing';

const base = environment.api_base_url;

/** Stage 26: the one scan helper: an exact barcode first, then an exact product code; only exact matches count. */
describe('ScanService (Stage 26)', () => {
  let http: HttpTestingController;
  let service: ScanService;
  const p1 = { _id: 'p1', name: 'لمبة', code: 'LED-18', barcodes: ['4006381333931'] };
  const p2 = { _id: 'p2', name: 'لمبة تانية', code: 'LED-180', barcodes: [] };

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
    service = TestBed.inject(ScanService);
  });
  afterEach(() => http.verify());

  it('a barcode match comes first and no code search is made', async () => {
    const pending = service.lookup('4006381333931');
    await answerScan(http, '4006381333931', { barcode: p1 });
    expect(await pending).toEqual({ kind: 'product', product: p1, matchedBy: 'barcode', code: '4006381333931' });
  });

  it('no barcode → an exact product code (matchedBy code)', async () => {
    const pending = service.lookup('LED-18');
    await answerScan(http, 'LED-18', { code: p1 });
    expect(await pending).toEqual({ kind: 'product', product: p1, matchedBy: 'code', code: 'LED-18' });
  });

  it('a code that only matches partially is not a match: LED-18 does not find LED-180', async () => {
    const pending = service.lookup('LED-18');
    const byBarcode = http.expectOne(`${base}products/by-barcode/LED-18`);
    byBarcode.flush({ code: 'BARCODE_NOT_FOUND', archived: false }, { status: 404, statusText: 'Not Found' });
    await tick();
    // The server's search is a "contains": it returns both; only the exact code counts.
    http.expectOne((r) => r.url === `${base}products/search` && r.params.get('code') === 'LED-18').flush([p2]);
    expect(await pending).toEqual({ kind: 'notFound', code: 'LED-18' });
  });

  it('two products with the same exact code are ambiguous: not a match', async () => {
    const pending = service.lookup('LED-18');
    await answerScan(http, 'LED-18', 'notFound');
    expect((await pending).kind).toBe('notFound');
    const again = service.lookup('DUP');
    http.expectOne(`${base}products/by-barcode/DUP`).flush({ archived: false }, { status: 404, statusText: 'Not Found' });
    await tick();
    http.expectOne((r) => r.url === `${base}products/search`).flush([{ _id: 'a', code: 'DUP' }, { _id: 'b', code: 'DUP' }]);
    expect((await again).kind).toBe('notFound');
  });

  it('only an archived product has the barcode → archived (and no code search)', async () => {
    const pending = service.lookup('4006381333931');
    await answerScan(http, '4006381333931', 'archived');
    expect(await pending).toEqual({ kind: 'archived', code: '4006381333931' });
  });

  it('the code is normalised first: Arabic-Indic digits, an RLM, the Arabic layout', async () => {
    const digits = service.lookup('‏٤٠٠٦٣٨١٣٣٣٩٣١');
    await answerScan(http, '4006381333931', { barcode: p1 });
    expect((await digits).kind).toBe('product');
    const layout = service.lookup('÷آ{-000125'); // INV-000125 typed on the Arabic layout
    http.expectOne(`${base}products/by-barcode/INV-000125`).flush({ archived: false }, { status: 404, statusText: 'Not Found' });
    await tick();
    // The code search starts with the text as typed (an Arabic product code stays findable), then the layout reading.
    http.expectOne((r) => r.url === `${base}products/search` && r.params.get('code') === '÷آ{-000125').flush([]);
    await tick();
    http.expectOne((r) => r.url === `${base}products/search` && r.params.get('code') === 'INV-000125').flush([{ _id: 'x', code: 'INV-000125' }]);
    expect(await layout).toEqual(jasmine.objectContaining({ kind: 'product', matchedBy: 'code' }));
  });

  it('a product code in Arabic is looked up as typed', async () => {
    const pending = service.lookup('قلم');
    // by-barcode tries the layout readings, none matches
    for (const reading of ['rgl']) {
      http.expectOne(`${base}products/by-barcode/${reading}`).flush({ archived: false }, { status: 404, statusText: 'Not Found' });
      await tick();
    }
    // the code search starts with the text as typed
    const typed = http.expectOne((r) => r.url === `${base}products/search` && r.params.get('code') === 'قلم');
    typed.flush([{ _id: 'q', code: 'قلم' }]);
    expect(await pending).toEqual(jasmine.objectContaining({ kind: 'product', matchedBy: 'code', code: 'قلم' }));
  });

  it('empty input finds nothing and asks nothing; a server error is reported, not thrown', async () => {
    expect(await service.lookup('')).toEqual({ kind: 'notFound', code: '' });
    expect(await service.lookup('  ​ ')).toEqual({ kind: 'notFound', code: '' });
    const pending = service.lookup('ABC-123');
    http.expectOne(`${base}products/by-barcode/ABC-123`).flush({ message: 'boom' }, { status: 500, statusText: 'Server Error' });
    const result = await pending;
    expect(result.kind).toBe('error');
  });
});
