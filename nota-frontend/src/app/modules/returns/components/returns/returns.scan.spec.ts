import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting, TestRequest } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { TranslateModule } from '@ngx-translate/core';
import { environment } from '../../../../../environments/environment';
import { signInAs } from '../../../../core/auth/testing/sign-in';
import { ToastService } from '../../../../core/auth/toast.service';
import { ScanSoundService } from '../../../../core/scan/scan-sound.service';
import { answerScan, enterEvent } from '../../../../core/scan/scan-testing';
import { ReturnsComponent } from './returns.component';

/** Stage 26: scanning the receipt's Code 128 (the invoice number) opens that invoice; a product scan adds 1 to its return line. */
describe('ReturnsComponent scanning (Stage 26)', () => {
  const base = environment.api_base_url;
  let component: ReturnsComponent;
  let http: HttpTestingController;
  let toast: ToastService;
  let ok: jasmine.Spy;
  let error: jasmine.Spy;
  const params = (req: TestRequest) => Object.fromEntries(req.request.params.keys().map((key) => [key, req.request.params.get(key)]));
  const flushLog = () => {
    http.expectOne((r) => r.url === `${base}returns`).flush({ success: true, data: [], pagination: { page: 1, limit: 10, totalItems: 0, totalPages: 0, hasNextPage: false, hasPrevPage: false } });
    http.expectOne((r) => r.url === `${base}returns/summary`).flush({ totalCashReturns: 0, totalCreditReturns: 0, totalReturnedAmount: 0, totalReturnedItems: 0 });
  };
  const cashInvoice = {
    _id: 's1', invoiceId: 's1', number: 'INV-000125', customerName: 'زبون', customerPhone: '0100', sellingDate: '2026-11-03', totalPrice: 600,
    items: [{ _id: 'cash-lamp', productId: 'p1', productName: 'لمبة', productCode: 'LED', productQuantity: 5, returnedQuantity: 3, productPricePerEach: 60 }, { _id: 'cash-cable', productId: 'p2', productName: 'كابل', productCode: 'CB', productQuantity: 1, returnedQuantity: 0, productPricePerEach: 300 }],
    refunds: [{ items: [{ productId: 'p1', quantity: 3 }] }], // 3 of the 5 lamps came back already → 2 returnable
  };
  const creditInvoice = {
    _id: 'cs1', invoiceId: 'cs1', number: 'CR-000007', customerName: 'محمد', customerPhone: '01225550199', sellingDate: '2026-10-15', status: 'partially_paid',
    totalPrice: 1100, paidAmount: 0, remainingAmount: 1100, refunds: [],
    items: [{ _id: 'i1', productId: 'p9', productName: 'كشاف', productQuantity: 4, returnedQuantity: 0, productPricePerEach: 275, totalPrice: 1100 }],
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ReturnsComponent, TranslateModule.forRoot()],
      providers: [provideRouter([]), provideNoopAnimations(), provideHttpClient(), provideHttpClientTesting()],
    })
      .overrideComponent(ReturnsComponent, { set: { template: '', imports: [] } })
      .compileComponents();
    http = TestBed.inject(HttpTestingController);
    toast = TestBed.inject(ToastService);
    ok = spyOn(ScanSoundService.prototype, 'ok');
    error = spyOn(ScanSoundService.prototype, 'error');
    signInAs('owner');
    component = TestBed.createComponent(ReturnsComponent).componentInstance;
    component.ngOnInit();
    flushLog();
    component.openWizard();
  });
  afterEach(() => http.verify());

  it('scanning INV-000125 opens that cash invoice for return at once (searched by its number)', () => {
    component.wizardQuery = 'INV-000125';
    component.searchWizardInvoices();
    const search = http.expectOne((r) => r.url === `${base}sellings`);
    expect(params(search)).toEqual({ number: 'INV-000125', page: '1', limit: '10' });
    search.flush({ success: true, data: [cashInvoice], pagination: {} });
    expect(component.wizardStep).toBe(2);
    expect(component.wizardInvoice?.label).toBe('INV-000125');
    expect(ok).toHaveBeenCalled();
  });

  it('INV-000125 scanned on the Arabic keyboard layout ("÷آ{-000125") finds the same invoice', () => {
    component.wizardQuery = '÷آ{-000125';
    component.searchWizardInvoices();
    const search = http.expectOne((r) => r.url === `${base}sellings`);
    expect(params(search)['number']).toBe('INV-000125');
    search.flush({ success: true, data: [cashInvoice], pagination: {} });
    expect(component.wizardStep).toBe(2);
  });

  it('CR-… switches to a credit invoice (the number decides the type) and opens it', () => {
    expect(component.wizardType).toBe('cash');
    component.wizardQuery = 'CR-000007';
    component.searchWizardInvoices();
    expect(component.wizardType).toBe('credit');
    const search = http.expectOne((r) => r.url === `${base}credit-sales`);
    expect(params(search)).toEqual({ number: 'CR-000007', page: '1', limit: '10' });
    search.flush({ success: true, data: [creditInvoice], pagination: {} });
    expect(component.wizardStep).toBe(2);
    expect(component.wizardInvoice?.type).toBe('credit');
  });

  it('a typed customer name is not touched by the layout mapping (Arabic names stay Arabic); an unknown number does not open anything', () => {
    component.wizardQuery = 'محمد';
    component.searchWizardInvoices();
    const search = http.expectOne((r) => r.url === `${base}sellings`);
    expect(params(search)).toEqual({ customerName: 'محمد', page: '1', limit: '10' });
    search.flush({ success: true, data: [], pagination: {} });
    expect(component.wizardStep).toBe(1);

    component.wizardQuery = 'INV-999999';
    component.searchWizardInvoices();
    http.expectOne((r) => r.url === `${base}sellings`).flush({ success: true, data: [], pagination: {} });
    expect(component.wizardStep).toBe(1);
    expect(component.wizardSearched).toBeTrue();
  });

  describe('inside an open invoice', () => {
    beforeEach(() => {
      component.wizardQuery = 'INV-000125';
      component.searchWizardInvoices();
      http.expectOne((r) => r.url === `${base}sellings`).flush({ success: true, data: [cashInvoice], pagination: {} });
      ok.calls.reset();
    });

    const scanLine = async (code: string, outcome: Parameters<typeof answerScan>[2]) => {
      component.wizardScan = code;
      const { event } = enterEvent(code);
      const pending = component.onWizardLineScan(event);
      await answerScan(http, code, outcome);
      await pending;
    };
    const lamp = { _id: 'p1', name: 'لمبة', code: 'LED', barcodes: ['4006381333931'] };

    it('a product scan selects its line and adds 1 to the return quantity, up to what is returnable (sold 5 − returned 3 = 2)', async () => {
      const line = component.wizardLines.find((entry) => entry.productId === 'p1')!;
      expect(component.returnableOf(line)).toBe(2);
      await scanLine('4006381333931', { barcode: lamp });
      expect(line.quantity).toBe(1);
      expect(component.wizardScan).toBe('');
      await scanLine('4006381333931', { barcode: lamp });
      expect(line.quantity).toBe(2);
      expect(ok).toHaveBeenCalledTimes(2);
      // At the limit: no more, the error sound and a message.
      await scanLine('4006381333931', { barcode: lamp });
      expect(line.quantity).toBe(2);
      expect(error).toHaveBeenCalledTimes(1);
      expect(toast.toasts()[0].text).toBe('scan.returnsLimit');
    });

    it('fills repeated product lines in invoice order, clamps every quantity entry, and saves itemIds', async () => {
      const repeated = {
        ...cashInvoice,
        items: [
          { _id: 'retail-line', productId: 'p1', productName: 'لمبة', productCode: 'LED', productQuantity: 3, returnedQuantity: 2, productPricePerEach: 100 },
          { _id: 'wholesale-line', productId: 'p1', productName: 'لمبة', productCode: 'LED', productQuantity: 4, returnedQuantity: 1, productPricePerEach: 80 },
        ],
      };
      component.pickWizardInvoice((component as any).toCashWizardInvoice(repeated));
      const [retail, wholesale] = component.wizardLines;
      await scanLine('4006381333931', { barcode: lamp });
      expect([retail.quantity, wholesale.quantity]).toEqual([1, 0]);
      await scanLine('4006381333931', { barcode: lamp });
      expect([retail.quantity, wholesale.quantity]).toEqual([1, 1]);

      component.stepWizardQuantity(retail, 1);
      expect(retail.quantity).toBe(1);
      component.setWizardQuantity(wholesale, 99);
      expect(wholesale.quantity).toBe(3);
      component.wizardReturnAll();
      expect([retail.quantity, wholesale.quantity]).toEqual([1, 3]);

      component.goToWizardStep(3);
      component.confirmWizardReturn();
      const post = http.expectOne(`${base}returns`);
      expect(post.request.body.items).toEqual([
        { itemId: 'retail-line', quantity: 1 },
        { itemId: 'wholesale-line', quantity: 3 },
      ]);
      post.flush({});
      flushLog();
    });

    it('a product that is not on the invoice is refused with a message', async () => {
      await scanLine('96385074', { barcode: { _id: 'zz', name: 'غريب', code: 'ZZ' } });
      expect(component.wizardLines.every((line) => line.quantity === 0)).toBeTrue();
      expect(error).toHaveBeenCalledTimes(1);
      expect(toast.toasts()[0].text).toBe('scan.returnsNotInInvoice');
    });

    it('an unknown code gets the usual "not registered" message', async () => {
      await scanLine('9999999999994', 'notFound');
      expect(toast.toasts()[0].text).toBe('barcodes.notRegistered');
      expect(error).toHaveBeenCalled();
    });
  });
});
