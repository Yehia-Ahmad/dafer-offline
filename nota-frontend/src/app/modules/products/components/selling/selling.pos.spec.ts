import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { TranslateModule } from '@ngx-translate/core';
import { environment } from '../../../../../environments/environment';
import { CatalogStateService } from '../../../layout/nav/catalog-state.service';
import { SellingComponent } from './selling.component';

/** Stage 9 POS additions (frontend only): grid, chips, tile → line, stepper, F2 / F9. Rendered with the real template. */
describe('SellingComponent POS layout (Stage 9)', () => {
  const base = environment.api_base_url;
  let fixture: ComponentFixture<SellingComponent>;
  let component: SellingComponent;
  let http: HttpTestingController;
  const el = () => fixture.nativeElement as HTMLElement;

  const products = [
    { _id: 'p1', name: 'لمبة LED ١٨ وات', code: 'LED-18', wholesalePrice: 60, retailPrice: 75, inventoryCount: 24, category: { name: 'لمبات' } },
    { _id: 'p2', name: 'لمبة LED ١٢ وات', code: 'LED-12', wholesalePrice: 45, retailPrice: 55, inventoryCount: 2, category: { name: 'لمبات' } },
  ];

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [SellingComponent, TranslateModule.forRoot()],
      providers: [provideRouter([]), provideNoopAnimations(), provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();

    http = TestBed.inject(HttpTestingController);
    TestBed.inject(CatalogStateService).categories.set([
      { id: 'c1', label: 'لمبات', route: '/categories/c1' },
      { id: 'c2', label: 'شواحن', route: '/categories/c2' },
    ]);
    fixture = TestBed.createComponent(SellingComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  afterEach(() => http.verify());

  const typeInSearch = (value: string) => {
    const input = el().querySelector<HTMLInputElement>('.pos__search-input')!;
    input.value = value;
    input.dispatchEvent(new Event('input'));
  };

  it('top search uses GET products/search?q= and renders tiles with code, name, price and stock (low stock marked)', () => {
    typeInSearch('LED');
    const req = http.expectOne((r) => r.url === `${base}products/search`);
    expect(req.request.params.keys()).toEqual(['q']);
    expect(req.request.params.get('q')).toBe('LED');
    req.flush(products);
    fixture.detectChanges();

    const tiles = el().querySelectorAll('.pos__tile');
    expect(tiles.length).toBe(2);
    expect(tiles[0].textContent).toContain('LED-18');
    expect(tiles[0].querySelector('.pos__tile-stock')!.classList).not.toContain('is-low');
    expect(tiles[1].querySelector('.pos__tile-stock')!.classList).toContain('is-low');
  });

  it('category chips come from the shared catalog and load GET products?categoryId=&limit=100', () => {
    const chips = el().querySelectorAll<HTMLButtonElement>('.pos__chip');
    expect(Array.from(chips).map((c) => c.textContent!.trim())).toEqual(['sellingPage.pos.allCategories', 'لمبات', 'شواحن']);

    chips[2].click();
    const req = http.expectOne((r) => r.url === `${base}products`);
    expect(req.request.method).toBe('GET');
    expect(req.request.params.get('categoryId')).toBe('c2');
    expect(req.request.params.get('limit')).toBe('100');
    req.flush({ success: true, data: products, pagination: {} });
    fixture.detectChanges();
    expect(el().querySelectorAll('.pos__tile').length).toBe(2);
    expect(chips[2].classList).toContain('is-on');
  });

  it('tile click fills the empty line; a second click adds 1 to its quantity; another product gets a new line', () => {
    typeInSearch('LED');
    http.expectOne((r) => r.url === `${base}products/search`).flush(products);
    fixture.detectChanges();
    const tiles = el().querySelectorAll<HTMLButtonElement>('.pos__tile');

    tiles[0].click();
    tiles[0].click();
    tiles[1].click();
    fixture.detectChanges();

    expect(component.invoiceItems.length).toBe(2);
    expect(component.getInvoiceItem(0).getRawValue()).toEqual(jasmine.objectContaining({ productId: 'p1', price: 60, quantity: 2, lineTotal: 120 }));
    expect(component.getInvoiceItem(1).getRawValue()).toEqual(jasmine.objectContaining({ productId: 'p2', price: 45, quantity: 1 }));
    expect(component.invoiceGrandTotal).toBe(165);
  });

  it('− never goes below 1; + adds 1', () => {
    component.stepQuantity(0, -1);
    expect(component.getInvoiceItem(0).get('quantity')!.value).toBe(1);
    component.stepQuantity(0, 1);
    expect(component.getInvoiceItem(0).get('quantity')!.value).toBe(2);
  });

  it('F2 focuses the product search; F9 runs the save (no request while the form is invalid)', () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2' }));
    expect(document.activeElement).toBe(el().querySelector('.pos__search-input'));

    const save = spyOn(component, 'saveSelling').and.callThrough();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'F9' }));
    expect(save).toHaveBeenCalled();
    http.expectNone(`${base}sellings`);
  });

  it('clear invoice resets lines and customer', () => {
    component.sellingForm.patchValue({ customerName: 'زبون' });
    component.addInvoiceItem(false);
    component.clearInvoice();
    expect(component.invoiceItems.length).toBe(1);
    expect(component.sellingForm.get('customerName')!.value).toBe('');
  });

  it('has no [dir] overrides and no legacy back button', () => {
    expect(el().querySelector('[dir=rtl]')).toBeNull();
    expect(el().querySelector('nota-page-header')).not.toBeNull();
  });
});
