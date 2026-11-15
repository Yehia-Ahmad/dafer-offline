import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { TranslateModule } from '@ngx-translate/core';
import { environment } from '../../../../../environments/environment';
import { ToastService } from '../../../../core/auth/toast.service';
import { signInAs } from '../../../../core/auth/testing/sign-in';
import { ScanSoundService } from '../../../../core/scan/scan-sound.service';
import { answerScan, enterEvent } from '../../../../core/scan/scan-testing';
import { flushPaymentBoxes } from '../../../cashbox/testing/payment-boxes.testing';
import { provideFakeVat } from '../../../shop-profile/services/vat-settings.testing';
import { CreditSalesComponent } from './credit-sales.component';

/** Stage 26: a barcode scanner types the code and presses Enter in a credit sale line's product box. */
describe('CreditSalesComponent scanning (Stage 26)', () => {
  const base = environment.api_base_url;
  let fixture: ComponentFixture<CreditSalesComponent>;
  let component: CreditSalesComponent;
  let http: HttpTestingController;
  let toast: ToastService;
  let ok: jasmine.Spy;
  let error: jasmine.Spy;
  const el = () => fixture.nativeElement as HTMLElement;
  const boxes = () => Array.from(el().querySelectorAll<HTMLInputElement>('[data-test="line-search"]'));
  const led18 = { _id: 'p1', name: 'لمبة LED ١٨ وات', code: 'LED-18', barcodes: ['4006381333931'], wholesalePrice: 60, retailPrice: 75, inventoryCount: 24, category: { _id: 'c1', name: 'لمبات' } };
  const led12 = { _id: 'p2', name: 'لمبة LED ١٢ وات', code: 'LED-12', barcodes: ['96385074'], wholesalePrice: 45, retailPrice: 55, inventoryCount: 20, category: { _id: 'c1', name: 'لمبات' } };

  const setup = async (role: 'owner' | 'cashier' = 'owner') => {
    await TestBed.configureTestingModule({
      imports: [CreditSalesComponent, TranslateModule.forRoot()],
      providers: [provideRouter([]), provideNoopAnimations(), provideHttpClient(), provideHttpClientTesting(), provideFakeVat()],
    }).compileComponents();
    signInAs(role);
    http = TestBed.inject(HttpTestingController);
    toast = TestBed.inject(ToastService);
    ok = spyOn(ScanSoundService.prototype, 'ok');
    error = spyOn(ScanSoundService.prototype, 'error');
    fixture = TestBed.createComponent(CreditSalesComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  };
  afterEach(() => { flushPaymentBoxes(http); http.verify(); });

  /** The code is in the first empty line's box and Enter is pressed. */
  const scan = async (code: string, outcome: Parameters<typeof answerScan>[2]) => {
    const box = boxes()[0];
    box.value = code;
    const { event } = enterEvent(code);
    Object.defineProperty(event, 'target', { value: box });
    const index = component.lineItemStates.findIndex((state) => !state.selectedProduct);
    component.lineItemStates[index].searchInputValue = code; // what typing did (the box shows the component's text)
    fixture.detectChanges();
    const pending = component.onLineScanEnter(index, event);
    await answerScan(http, code, outcome);
    await pending;
    fixture.detectChanges();
    return box;
  };

  it('Enter with an exact barcode puts the product on the line with quantity 1, and focuses a fresh empty line', async () => {
    await setup();
    await scan('4006381333931', { barcode: led18 });
    expect(component.lineItemStates[0].selectedProduct?.id).toBe('p1');
    expect(component.lineItemControls[0].get('quantity')!.value).toBe(1);
    expect(component.lineItemControls[0].get('price')!.value).toBe(75); // credit lines price at retail
    expect(component.lineItems.length).toBe(2);
    expect(component.lineItemStates[1].selectedProduct).toBeNull();
    expect(boxes().length).toBe(1);
    expect(document.activeElement).toBe(boxes()[0]);
    expect(ok).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
  });

  it('a second scan of the same product is +1 on its line (no new product line), the box is cleared and keeps the focus', async () => {
    await setup();
    await scan('4006381333931', { barcode: led18 });
    const box = await scan('4006381333931', { barcode: led18 });
    await scan('4006381333931', { barcode: led18 });
    expect(component.lineItemControls[0].get('quantity')!.value).toBe(3);
    expect(component.lineItems.length).toBe(2); // the product line + the empty one
    expect(box.value).toBe('');
    expect(document.activeElement).toBe(boxes()[0]);
    await scan('96385074', { barcode: led12 });
    expect(component.lineItemStates[1].selectedProduct?.id).toBe('p2');
    expect(component.lineItemControls[1].get('quantity')!.value).toBe(1);
    expect(component.lineItems.length).toBe(3);
  });

  it('an exact internal code works too', async () => {
    await setup();
    await scan('LED-12', { code: led12 });
    expect(component.lineItemStates[0].selectedProduct?.id).toBe('p2');
  });

  it('an unknown code: error sound, the toast (with the add action for a user who can), and the text stays selected', async () => {
    await setup('owner');
    const box = await scan('9999999999994', 'notFound');
    expect(component.lineItemStates[0].selectedProduct).toBeNull();
    expect(error).toHaveBeenCalledTimes(1);
    const [shown] = toast.toasts();
    expect(shown.text).toBe('barcodes.notRegistered');
    expect(shown.action?.label).toBe('barcodes.addProduct');
    expect(box.value).toBe('9999999999994');
    expect(box.selectionStart).toBe(0);
    expect(box.selectionEnd).toBe(13);
  });

  it('a cashier gets no add action; an archived barcode says so', async () => {
    await setup('cashier');
    await scan('9999999999994', 'notFound');
    expect(toast.toasts()[0].action).toBeUndefined();
    toast.dismiss(toast.toasts()[0].id);
    await scan('4006381333931', 'archived');
    expect(toast.toasts().map((entry) => entry.text)).toEqual(['barcodes.archived']);
  });

  it('typing a name still gives suggestions; Enter on a name that has suggestions is left to the list (no error)', async () => {
    await setup();
    const box = boxes()[0];
    box.value = 'LED';
    box.dispatchEvent(new Event('input'));
    http.expectOne((request) => request.url === `${base}products/search` && request.params.get('q') === 'LED').flush([led18, led12]);
    fixture.detectChanges();
    expect(component.lineItemStates[0].productOptions.length).toBe(2);
    const { event } = enterEvent('LED');
    Object.defineProperty(event, 'target', { value: box });
    const pending = component.onLineScanEnter(0, event);
    await answerScan(http, 'LED', 'notFound');
    await pending;
    expect(error).not.toHaveBeenCalled();
    expect(toast.toasts().length).toBe(0);
  });
});
