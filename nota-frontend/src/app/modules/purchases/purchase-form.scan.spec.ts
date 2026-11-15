import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { TranslateModule } from '@ngx-translate/core';
import { environment } from '../../../environments/environment';
import { ToastService } from '../../core/auth/toast.service';
import { signInAs } from '../../core/auth/testing/sign-in';
import { ScanSoundService } from '../../core/scan/scan-sound.service';
import { answerScan, enterEvent } from '../../core/scan/scan-testing';
import { flushPaymentBoxes } from '../cashbox/testing/payment-boxes.testing';
import { provideFakeVat } from '../shop-profile/services/vat-settings.testing';
import { PurchaseFormComponent } from './purchase-form.component';

const base = environment.api_base_url;
const LED = { _id: 'p-led', name: 'لمبة LED', code: 'LED12', barcodes: ['4006381333931'], inventoryCount: 32, purchasePrice: 70 };
const CABLE = { _id: 'p-cable', name: 'كابل', code: 'CB1', barcodes: ['96385074'], inventoryCount: 5, purchasePrice: 20 };

/** Stage 26: scanning into the purchase form's product box. */
describe('PurchaseFormComponent scanning (Stage 26)', () => {
  let fixture: ComponentFixture<PurchaseFormComponent>;
  let component: PurchaseFormComponent;
  let http: HttpTestingController;
  let toast: ToastService;
  let ok: jasmine.Spy;
  let error: jasmine.Spy;

  const open = async (role: 'owner' | 'storekeeper' = 'owner') => {
    await TestBed.configureTestingModule({
      imports: [PurchaseFormComponent, TranslateModule.forRoot()],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([]), provideNoopAnimations(), provideFakeVat(),
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: convertToParamMap({}), queryParamMap: convertToParamMap({}) } } }],
    }).compileComponents();
    signInAs(role);
    http = TestBed.inject(HttpTestingController);
    toast = TestBed.inject(ToastService);
    ok = spyOn(ScanSoundService.prototype, 'ok');
    error = spyOn(ScanSoundService.prototype, 'error');
    fixture = TestBed.createComponent(PurchaseFormComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
    http.expectOne((r) => r.url === `${base}suppliers`).flush([]);
    flushPaymentBoxes(http);
    fixture.detectChanges();
    await fixture.whenStable();
  };
  afterEach(() => { flushPaymentBoxes(http); http.verify(); });

  const scan = async (code: string, outcome: Parameters<typeof answerScan>[2]) => {
    const box = fixture.nativeElement.querySelector('[data-test="product-search"]') as HTMLInputElement;
    box.value = code;
    component.query.set(code);
    const { event } = enterEvent(code);
    Object.defineProperty(event, 'target', { value: box });
    const pending = component.onScanEnter(event);
    await answerScan(http, code, outcome);
    await pending;
    fixture.detectChanges();
    return box;
  };

  it('a scan adds the product with quantity 1 at its current cost; a second scan is +1 on that line', async () => {
    await open();
    await scan('4006381333931', { barcode: LED });
    expect(component.lines().length).toBe(1);
    expect(component.lines()[0]).toEqual(jasmine.objectContaining({ qty: 1, unitPrice: 70 }));
    expect(component.query()).toBe('');
    await scan('4006381333931', { barcode: LED });
    await scan('4006381333931', { barcode: LED });
    expect(component.lines().length).toBe(1);
    expect(component.lines()[0].qty).toBe(3);
    await scan('96385074', { barcode: CABLE });
    expect(component.lines().length).toBe(2);
    expect(ok).toHaveBeenCalledTimes(4);
    expect(error).not.toHaveBeenCalled();
  });

  it('an unknown barcode: error sound, the toast, the text stays selected; the add action opens the inline "صنف جديد" with the barcode', async () => {
    await open('owner');
    const box = await scan('9999999999994', 'notFound');
    expect(error).toHaveBeenCalledTimes(1);
    const [shown] = toast.toasts();
    expect(shown.text).toBe('barcodes.notRegistered');
    expect(shown.action?.label).toBe('barcodes.addProduct');
    expect(box.selectionStart).toBe(0);
    expect(box.selectionEnd).toBe(13);
    expect(component.lines().length).toBe(0);

    toast.runAction(shown);
    http.expectOne((r) => r.url === `${base}categories`).flush([{ _id: 'c1', name: 'لمبات' }]);
    fixture.detectChanges();
    expect(component.newProductOpen()).toBeTrue();
    expect(component.np().barcode).toBe('9999999999994');
    expect(fixture.nativeElement.querySelector('[data-test="np-barcode"]').textContent).toContain('9999999999994');
  });

  it('creating that product sends its barcode and adds the new line', async () => {
    await open('owner');
    component.openNewProductForBarcode('9999999999994');
    http.expectOne((r) => r.url === `${base}categories`).flush([{ _id: 'c1', name: 'لمبات' }]);
    component.setNp('name', 'منتج جديد'); component.setNp('code', 'NEW1'); component.setNp('categoryId', 'c1');
    component.setNp('wholesalePrice', 40); component.setNp('retailPrice', 50);
    component.createProduct();
    const request = http.expectOne(`${base}products`);
    expect(request.request.body.barcodes).toEqual(['9999999999994']);
    request.flush({ _id: 'p-new', name: 'منتج جديد', code: 'NEW1' });
    expect(component.lines().length).toBe(1);
    expect(component.np().barcode).toBe('');
  });

  it('an archived barcode says so for a storekeeper too', async () => {
    await open('storekeeper');
    await scan('9999999999994', 'archived');
    expect(toast.toasts().map((entry) => entry.text)).toEqual(['barcodes.archived']);
  });
});
