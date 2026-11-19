import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { provideRouter } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { environment } from '../../../../../environments/environment';
import { LayoutService } from '../../../../core/layout/layout.service';
import { CatalogStateService } from '../../../layout/nav/catalog-state.service';
import { provideFakeVat } from '../../../shop-profile/services/vat-settings.testing';
import { SellingComponent } from './selling.component';

/** Online Stage 6A, MobPos: the invoice is a bottom sheet over the very same form, so its totals are the desktop POS totals. */
describe('SellingComponent on the phone (Online Stage 6A)', () => {
  const base = environment.api_base_url;
  const isMobile = signal(false);
  let http: HttpTestingController;

  const products = [
    { _id: 'p1', name: 'لمبة LED ١٨ وات', code: 'LED-18', wholesalePrice: 60, retailPrice: 75, inventoryCount: 24, category: { name: 'لمبات' } },
    { _id: 'p2', name: 'لمبة LED ١٢ وات', code: 'LED-12', wholesalePrice: 45, retailPrice: 55, inventoryCount: 20, category: { name: 'لمبات' } },
  ];

  beforeEach(async () => {
    isMobile.set(false);
    await TestBed.configureTestingModule({
      imports: [SellingComponent, TranslateModule.forRoot()],
      providers: [provideRouter([]), provideNoopAnimations(), provideHttpClient(), provideHttpClientTesting(), provideFakeVat(), { provide: LayoutService, useValue: { isMobile } }],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    TestBed.inject(CatalogStateService).categories.set([{ id: 'c1', label: 'لمبات' }]);
  });
  afterEach(() => http.verify());

  /** Opens the POS in the current layout and puts the same cart in it: 2 × LED-18 (retail 75) + 1 × LED-12 (retail 55), discount 10, shipping 5. */
  function posWithCart() {
    const fixture = TestBed.createComponent(SellingComponent);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const input = el.querySelector<HTMLInputElement>('.pos__search-input')!;
    input.value = 'LED';
    input.dispatchEvent(new Event('input'));
    http.expectOne((r) => r.url === `${base}products/search`).flush(products);
    fixture.detectChanges();
    const tiles = el.querySelectorAll<HTMLButtonElement>('.pos__tile');
    tiles[0].click(); tiles[0].click(); tiles[1].click();
    const component = fixture.componentInstance;
    component.sellingForm.patchValue({ discountAmount: 10, shippingFees: 5 });
    fixture.detectChanges();
    return { fixture, el, component };
  }

  it('desktop (≥768 px) has no phone bar, no sheet state and the original pay label', () => {
    const { el } = posWithCart();
    expect(el.querySelector('[data-testid="pos-m-bar"]')).toBeNull();
    expect(el.querySelector('.pos--m')).toBeNull();
    expect(el.querySelector('[data-testid="pos-pay-label"]')).toBeNull();
    expect(el.querySelector('.pos__pay')!.textContent).toContain('sellingPage.actions.createSelling');
  });

  it('phone: the bar total, the sheet total and the pay button equal the desktop POS total for the same cart', () => {
    const desktop = posWithCart();
    const desktopTotal = desktop.el.querySelector('.pos__grand dd')!.textContent!.trim();
    const desktopLines = desktop.component.invoiceItems.length;
    expect(desktop.component.invoiceGrandTotal).toBe(150 + 55 - 10 + 5);
    desktop.fixture.destroy();

    isMobile.set(true);
    const phone = posWithCart();
    expect(phone.el.querySelector('.pos--m')).not.toBeNull();
    const barTotal = phone.el.querySelector('[data-testid="pos-m-total"]')!.textContent!.trim();
    const sheetTotal = phone.el.querySelector('.pos__grand dd')!.textContent!.trim();
    const payLabel = phone.el.querySelector('[data-testid="pos-pay-label"]')!.textContent!;
    expect(sheetTotal).toBe(desktopTotal);
    expect(barTotal).toBe(desktopTotal);
    expect(payLabel).toContain('mobile.pos.payAndPrint');
    expect(payLabel).toContain(desktopTotal);
    expect(phone.component.invoiceItems.length).toBe(desktopLines);
    expect(phone.component.invoiceGrandTotal).toBe(200);
  });

  it('phone: the sheet opens from the bar and closes from its button, the scrim and after a sale', () => {
    isMobile.set(true);
    const { fixture, el, component } = posWithCart();
    const aside = () => el.querySelector('.pos__invoice')!;
    expect(aside().classList).not.toContain('is-open');

    el.querySelector<HTMLButtonElement>('[data-testid="pos-m-toggle"]')!.click();
    fixture.detectChanges();
    expect(aside().classList).toContain('is-open');
    expect(el.querySelector('.m-sheet__scrim')).not.toBeNull();
    // the full invoice lines with their quantity steppers are in the sheet
    expect(el.querySelectorAll('.pos__line').length).toBe(2);
    expect(el.querySelectorAll('.pos__stepper').length).toBe(2);

    el.querySelector<HTMLElement>('.m-sheet__scrim')!.click();
    fixture.detectChanges();
    expect(aside().classList).not.toContain('is-open');

    component.sheetOpen = true;
    component.closeSuccessPopup();
    expect(component.sheetOpen).toBeFalse();
  });

  it('phone: shows the cashier name and the product grid is the same one the desktop uses', () => {
    isMobile.set(true);
    const { el } = posWithCart();
    expect(el.querySelector('[data-testid="pos-cashier"]')).not.toBeNull();
    expect(el.querySelectorAll('.pos__tile').length).toBe(2);
  });
});
