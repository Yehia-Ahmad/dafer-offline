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
import { answerScan, enterEvent, tick } from '../../../../core/scan/scan-testing';
import { flushPaymentBoxes } from '../../../cashbox/testing/payment-boxes.testing';
import { CatalogStateService } from '../../../layout/nav/catalog-state.service';
import { provideFakeVat } from '../../../shop-profile/services/vat-settings.testing';
import { SellingComponent } from './selling.component';

/** Stage 26: a barcode scanner types the code and presses Enter in the POS product box. */
describe('SellingComponent scanning (Stage 26)', () => {
  const base = environment.api_base_url;
  let fixture: ComponentFixture<SellingComponent>;
  let component: SellingComponent;
  let http: HttpTestingController;
  let toast: ToastService;
  let ok: jasmine.Spy;
  let error: jasmine.Spy;
  const el = () => fixture.nativeElement as HTMLElement;

  const led18 = { _id: 'p1', name: 'لمبة LED ١٨ وات', code: 'LED-18', barcodes: ['4006381333931'], wholesalePrice: 60, retailPrice: 75, inventoryCount: 24, category: { name: 'لمبات' } };
  const led12 = { _id: 'p2', name: 'لمبة LED ١٢ وات', code: 'LED-12', barcodes: ['96385074'], wholesalePrice: 45, retailPrice: 55, inventoryCount: 2, category: { name: 'لمبات' } };

  const setup = async (role: 'owner' | 'cashier' = 'owner') => {
    await TestBed.configureTestingModule({
      imports: [SellingComponent, TranslateModule.forRoot()],
      providers: [provideRouter([]), provideNoopAnimations(), provideHttpClient(), provideHttpClientTesting(), provideFakeVat()],
    }).compileComponents();
    signInAs(role);
    http = TestBed.inject(HttpTestingController);
    toast = TestBed.inject(ToastService);
    ok = spyOn(ScanSoundService.prototype, 'ok');
    error = spyOn(ScanSoundService.prototype, 'error');
    TestBed.inject(CatalogStateService).categories.set([{ id: 'c1', label: 'لمبات' }]);
    fixture = TestBed.createComponent(SellingComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  };
  afterEach(() => { flushPaymentBoxes(http); http.verify(); });

  /** A scan: the code is typed into the box (the grid asks the server once) and Enter is pressed. */
  const scan = async (code: string, outcome: Parameters<typeof answerScan>[2]) => {
    const box = el().querySelector<HTMLInputElement>('.pos__search-input')!;
    const { event } = enterEvent(code);
    Object.defineProperty(event, 'target', { value: box });
    box.value = code;
    const pending = component.onGridSearchEnter(event);
    await answerScan(http, code, outcome);
    await pending;
    fixture.detectChanges();
    return box;
  };

  it('Enter with an exact barcode adds the product with quantity 1 at the default retail price; the box is cleared and keeps the focus', async () => {
    await setup();
    const box = await scan('4006381333931', { barcode: led18 });
    expect(component.invoiceItems.length).toBe(1);
    expect(component.getInvoiceItem(0).getRawValue()).toEqual(jasmine.objectContaining({ productId: 'p1', quantity: 1, priceType: 'retailPrice', price: 75 }));
    expect(ok).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
    expect(box.value).toBe('');
    expect(document.activeElement).toBe(box);
    expect(toast.toasts().length).toBe(0);
  });

  it('a second scan of the same product on the same price type is +1 on that line, not a new line', async () => {
    await setup();
    await scan('4006381333931', { barcode: led18 });
    await scan('4006381333931', { barcode: led18 });
    await scan('4006381333931', { barcode: led18 });
    expect(component.invoiceItems.length).toBe(1);
    expect(component.getInvoiceItem(0).get('quantity')!.value).toBe(3);
    expect(component.invoiceGrandTotal).toBe(225);
    // Another product gets its own line.
    await scan('96385074', { barcode: led12 });
    expect(component.invoiceItems.length).toBe(2);
    expect(component.getInvoiceItem(1).getRawValue()).toEqual(jasmine.objectContaining({ productId: 'p2', quantity: 1 }));
  });

  it('the same product on another price type is a new line (a scan uses the configured retail default)', async () => {
    await setup();
    await scan('4006381333931', { barcode: led18 });
    component.getInvoiceItem(0).get('priceType')!.setValue('wholesalePrice');
    await scan('4006381333931', { barcode: led18 });
    expect(component.invoiceItems.length).toBe(2);
    expect(component.getInvoiceItem(0).getRawValue()).toEqual(jasmine.objectContaining({ priceType: 'wholesalePrice', price: 60, quantity: 1 }));
    expect(component.getInvoiceItem(1).getRawValue()).toEqual(jasmine.objectContaining({ priceType: 'retailPrice', price: 75, quantity: 1 }));
    await scan('4006381333931', { barcode: led18 }); // now the retail line exists: +1 on it
    expect(component.invoiceItems.length).toBe(2);
    expect(component.getInvoiceItem(1).get('quantity')!.value).toBe(2);
  });

  it('an exact internal product code adds it too (barcode first, then code)', async () => {
    await setup();
    await scan('LED-18', { code: led18 });
    expect(component.getInvoiceItem(0).getRawValue()).toEqual(jasmine.objectContaining({ productId: 'p1', quantity: 1 }));
    expect(ok).toHaveBeenCalled();
  });

  it('an Arabic-layout scan is normalised before the lookup', async () => {
    await setup();
    const box = el().querySelector<HTMLInputElement>('.pos__search-input')!;
    const { event } = enterEvent('');
    Object.defineProperty(event, 'target', { value: box });
    box.value = '٤٠٠٦٣٨١٣٣٣٩٣١'; // Arabic-Indic digits
    const pending = component.onGridSearchEnter(event);
    await answerScan(http, '4006381333931', { barcode: led18 });
    await pending;
    expect(component.getInvoiceItem(0).getRawValue()).toEqual(jasmine.objectContaining({ productId: 'p1' }));
  });

  it('an unknown code: the error sound, the toast "باركود مش متسجل" with the add action for a user who can manage products, the text stays selected', async () => {
    await setup('owner');
    const box = await scan('9999999999994', 'notFound');
    expect(component.invoiceItems.length).toBe(1);
    expect(component.getInvoiceItem(0).get('productId')!.value ?? '').toBe('');
    expect(error).toHaveBeenCalledTimes(1);
    expect(ok).not.toHaveBeenCalled();
    const [shown] = toast.toasts();
    expect(shown.kind).toBe('error');
    expect(shown.text).toBe('barcodes.notRegistered'); // the key (no translations in the spec)
    expect(shown.action?.label).toBe('barcodes.addProduct');
    expect(box.value).toBe('9999999999994');
    expect(box.selectionStart).toBe(0);
    expect(box.selectionEnd).toBe(13);
    expect(document.activeElement).toBe(box);
  });

  it('a cashier gets the error but no "add product" action', async () => {
    await setup('cashier');
    await scan('9999999999994', 'notFound');
    const [shown] = toast.toasts();
    expect(shown.text).toBe('barcodes.notRegistered');
    expect(shown.action).toBeUndefined();
  });

  it('an archived product\'s barcode says it is archived and adds nothing', async () => {
    await setup();
    await scan('4006381333931', 'archived');
    expect(toast.toasts().map((entry) => entry.text)).toEqual(['barcodes.archived']);
    expect(error).toHaveBeenCalled();
    expect(component.getInvoiceItem(0).get('productId')!.value ?? '').toBe('');
  });

  it('the plain typing search still filters the grid with partial matches; Enter on a partial name does not raise the error', async () => {
    await setup();
    const box = el().querySelector<HTMLInputElement>('.pos__search-input')!;
    box.value = 'LED';
    box.dispatchEvent(new Event('input'));
    http.expectOne((request) => request.url === `${base}products/search` && request.params.get('q') === 'LED').flush([led18, led12]);
    fixture.detectChanges();
    expect(el().querySelectorAll('.pos__tile').length).toBe(2);

    const { event } = enterEvent('LED');
    Object.defineProperty(event, 'target', { value: box });
    const pending = component.onGridSearchEnter(event);
    await answerScan(http, 'LED', 'notFound');
    await pending;
    expect(error).not.toHaveBeenCalled();
    expect(toast.toasts().length).toBe(0);
    expect(el().querySelectorAll('.pos__tile').length).toBe(2); // the grid keeps its partial matches
  });

  it('the existing stock rules still apply to a scanned line (a scan is just a faster add)', async () => {
    await setup();
    await scan('96385074', { barcode: led12 }); // only 2 in stock
    expect(component.getInvoiceItem(0).get('quantity')!.value).toBe(1);
    await scan('96385074', { barcode: led12 });
    await scan('96385074', { barcode: led12 });
    expect(component.getInvoiceItem(0).get('quantity')!.value).toBe(3); // added; the save asks to confirm insufficient stock as before
    await tick();
  });
});
