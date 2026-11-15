import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { signInAs, signInWith } from './core/auth/testing/sign-in';
import { ROLE_PERMISSIONS } from './core/auth/testing/auth-fixtures';
import { LabelPrintDialogComponent } from './core/print/label-print-dialog.component';
import { DEFAULT_LABEL_OPTIONS, normalizeRoll, normalizeSheet } from './core/print/label-layout';
import { PrintService } from './core/print/print.service';
import { PrintSettingsService } from './core/print/print-settings.service';
import { answerScan, enterEvent, tick } from './core/scan/scan-testing';
import { ProductsPageComponent } from './modules/category/components/products-page/products-page.component';
import { CatalogStateService } from './modules/layout/nav/catalog-state.service';
import { environment } from '../environments/environment';
import { flushPaymentBoxes } from './modules/cashbox/testing/payment-boxes.testing';

const base = environment.api_base_url;
const commonProviders = () => [provideRouter([]), provideNoopAnimations(), provideHttpClient(), provideHttpClientTesting()];

describe('Stage 26 permissions: the label and barcode buttons', () => {
  const products = [
    { _id: 'p1', name: 'لمبة', code: 'LED-9', barcodes: ['4006381333931', 'X-2'], inventoryCount: 10, retailPrice: 45, wholesalePrice: 35 },
    { _id: 'p2', name: 'كابل', code: 'CB-1', barcodes: [], inventoryCount: 3, retailPrice: 20, wholesalePrice: 15 },
  ];

  const open = async (permissions: string[], routeCategory = '') => {
    await TestBed.configureTestingModule({
      imports: [ProductsPageComponent, TranslateModule.forRoot()],
      providers: [...commonProviders(), { provide: ActivatedRoute, useValue: { queryParamMap: of(convertToParamMap(routeCategory ? { category: routeCategory } : {})) } }],
    }).compileComponents();
    signInWith(permissions);
    TestBed.inject(CatalogStateService).categories.set([{ id: 'c1', label: 'لمبات' }]);
    const http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(ProductsPageComponent);
    fixture.detectChanges();
    http.match(() => true).forEach((request) => request.flush(request.request.url.endsWith('products')
      ? { success: true, data: products, pagination: { page: 1, limit: 10, totalPages: 1, hasNextPage: false } }
      : []));
    fixture.detectChanges();
    return { fixture, http, el: fixture.nativeElement as HTMLElement, component: fixture.componentInstance };
  };

  it('without products.printLabels there is no select column and no print-labels button; the barcode column is still shown', async () => {
    const { fixture, http, el } = await open(['products.view', 'products.manage']);
    expect(el.querySelector('[data-test="select-row"]')).toBeNull();
    expect(el.querySelector('[data-test="select-all"]')).toBeNull();
    expect(el.querySelector('[data-action="print-selected-labels"]')).toBeNull();
    expect(el.querySelector('[data-action="print-category-labels"]')).toBeNull();
    expect(Array.from(el.querySelectorAll('[data-test="barcode-cell"]')).map((cell) => cell.textContent!.trim())).toEqual(['4006381333931', '—']);
    // products.manage alone still gets the bulk generate.
    expect(el.querySelector('[data-action="bulk-barcodes"]')).not.toBeNull();
    fixture.destroy();
    flushPaymentBoxes(http); http.verify();
  });

  it('without products.manage there is no bulk generate; with products.printLabels the select column and print buttons appear', async () => {
    const { fixture, http, el } = await open(['products.view', 'products.printLabels']);
    expect(el.querySelector('[data-action="bulk-barcodes"]')).toBeNull();
    expect(el.querySelectorAll('[data-test="select-row"]').length).toBe(2);
    const printSelected = el.querySelector<HTMLButtonElement>('[data-action="print-selected-labels"]')!;
    expect(printSelected).not.toBeNull();
    expect(printSelected.disabled).toBeTrue(); // nothing ticked
    el.querySelectorAll<HTMLInputElement>('[data-test="select-row"]')[0].click();
    fixture.detectChanges();
    expect(printSelected.disabled).toBeFalse();
    expect(printSelected.textContent).toContain('(1)');
    fixture.destroy();
    flushPaymentBoxes(http); http.verify();
  });

  it('"all products in this category" shows only inside a category', async () => {
    const { fixture, http, el } = await open(['products.view', 'products.printLabels'], 'c1');
    expect(el.querySelector('[data-action="print-category-labels"]')).not.toBeNull();
    fixture.destroy();
    flushPaymentBoxes(http); http.verify();
  });

  it('the typed list filter matches a barcode (and still the name and the code)', async () => {
    const { fixture, component, http, el } = await open(['products.view']);
    component.searchTerm = '4006381333931';
    expect(component.filteredProducts.map((product) => product._id)).toEqual(['p1']);
    component.searchTerm = 'X-2';
    expect(component.filteredProducts.map((product) => product._id)).toEqual(['p1']);
    component.searchTerm = 'كابل';
    expect(component.filteredProducts.map((product) => product._id)).toEqual(['p2']);
    component.searchTerm = 'CB-1';
    expect(component.filteredProducts.map((product) => product._id)).toEqual(['p2']);
    void el;
    fixture.destroy();
    flushPaymentBoxes(http); http.verify();
  });

  it('scanning into the products search finds a product that is not loaded yet, and shows only it', async () => {
    const { fixture, component, http } = await open(['products.view']);
    const remote = { _id: 'p9', name: 'بعيد', code: 'FAR-1', barcodes: ['2000000000015'], inventoryCount: 4 };
    component.searchTerm = '2000000000015';
    const { event } = enterEvent('2000000000015');
    const pending = component.onSearchEnter(event);
    await answerScan(http, '2000000000015', { barcode: remote });
    await pending;
    expect(component.products.some((product) => product._id === 'p9')).toBeTrue();
    expect(component.filteredProducts.map((product) => product._id)).toEqual(['p9']);
    fixture.destroy();
    flushPaymentBoxes(http); http.verify();
  });
});

describe('Stage 26 label print dialog', () => {
  const lamp = { _id: 'p1', name: 'لمبة', code: 'LED-9', barcodes: ['4006381333931'], retailPrice: 45, wholesalePrice: 35, purchasePrice: 20, copies: 3 };
  const bare = { _id: 'p2', name: 'بدون باركود', code: 'NB-1', barcodes: [], retailPrice: 10, wholesalePrice: 8, copies: 2 };

  const open = async (role: 'owner' | 'cashier' | 'storekeeper', products: object[]) => {
    const printLabels = jasmine.createSpy('printLabels').and.resolveTo({ ok: true });
    const savePrefs = jasmine.createSpy('savePrefs').and.resolveTo(undefined);
    await TestBed.configureTestingModule({
      imports: [LabelPrintDialogComponent, TranslateModule.forRoot()],
      providers: [
        ...commonProviders(),
        { provide: PrintService, useValue: { printLabels, labelSettings: async () => ({ roll: normalizeRoll({}), sheet: normalizeSheet({ preset: '3x8' }), options: { ...DEFAULT_LABEL_OPTIONS }, printer: '' }) } },
        { provide: PrintSettingsService, useValue: { savePrefs } },
      ],
    }).compileComponents();
    signInAs(role);
    const translate = TestBed.inject(TranslateService);
    translate.setTranslation('en', { labels: { total: 'Total {{count}}', tooMany: 'At most {{max}} labels (requested {{total}})' } }, true);
    translate.use('en');
    const http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(LabelPrintDialogComponent);
    fixture.componentRef.setInput('products', products);
    fixture.componentRef.setInput('visible', true);
    fixture.detectChanges();
    await tick();
    fixture.detectChanges();
    const q = <T extends Element>(selector: string) => document.querySelector<T>(selector);
    return { fixture, http, printLabels, savePrefs, q };
  };

  afterEach(() => { document.querySelectorAll('.p-dialog-mask, .p-overlay').forEach((node) => node.remove()); });

  it('lists the products with their quantities; the total counts only products that have a barcode', async () => {
    const { q, fixture, http } = await open('storekeeper', [lamp, bare]);
    expect(document.querySelectorAll('[data-test="copies"]').length).toBe(2);
    expect(q('[data-test="label-total"]')!.textContent).toContain('Total 3');
    expect(q('[data-test="no-barcode"]')).not.toBeNull();
    fixture.destroy(); http.verify();
  });

  it('a user who can edit products is offered "generate first"; one who cannot sees that those products are skipped', async () => {
    const withManage = await open('storekeeper', [bare]);
    expect(withManage.q('[data-test="generate-first"]')).not.toBeNull();
    expect(withManage.q('[data-test="skip-warning"]')).toBeNull();
    withManage.fixture.destroy();
    TestBed.resetTestingModule();
    const without = await open('cashier', [bare]);
    expect(without.q('[data-test="generate-first"]')).toBeNull();
    expect(without.q('[data-test="skip-warning"]')).not.toBeNull();
    without.fixture.destroy();
  });

  it('generate first: an EAN-13 per product without a barcode, saved on the product', async () => {
    const { q, fixture, http } = await open('storekeeper', [bare]);
    q<HTMLButtonElement>('[data-test="generate-first"]')!.click();
    http.expectOne(`${base}products/barcodes/generate`).flush({ barcode: '2000000000015', type: 'EAN-13' });
    await tick();
    const save = http.expectOne(`${base}products/p2`);
    expect(save.request.method).toBe('PUT');
    expect(save.request.body).toEqual({ barcodes: ['2000000000015'] });
    save.flush({ barcodes: ['2000000000015'] });
    await tick();
    fixture.detectChanges();
    expect(q('[data-test="no-barcode"]')).toBeNull();
    expect(q('[data-test="label-total"]')!.textContent).toContain('Total 2');
    fixture.destroy(); http.verify();
  });

  it('over 2,000 labels: a clear message and Print is disabled', async () => {
    const { q, fixture, http } = await open('owner', [{ ...lamp, copies: 2001 }]);
    expect(q('[data-test="too-many"]')!.textContent).toContain('At most 2000 labels (requested 2001)');
    expect(q<HTMLButtonElement>('[data-test="print-labels"]')!.disabled).toBeTrue();
    fixture.destroy(); http.verify();
  });

  it('a long Code 128 that cannot fit the label size gets a warning; an EAN-13 does not', async () => {
    const fits = await open('owner', [lamp]);
    expect(fits.q('[data-test="too-small"]')).toBeNull();
    fits.fixture.destroy();
    TestBed.resetTestingModule();
    const long = await open('owner', [{ ...lamp, barcodes: ['SKU-ABCDEFGHIJKLMNOPQRSTUVWXYZ-0123456789'] }]);
    expect(long.q('[data-test="too-small"]')).not.toBeNull();
    long.fixture.destroy();
  });

  it('"start at label" only shows for A4 sheets', async () => {
    const { q, fixture, http } = await open('owner', [lamp]);
    expect(q('[data-test="start-at"]')).toBeNull();
    q<HTMLInputElement>('[data-test="target-sheet"]')!.click();
    fixture.detectChanges();
    await tick();
    fixture.detectChanges();
    expect(q('[data-test="start-at"]')).not.toBeNull();
    fixture.destroy(); http.verify();
  });

  it('Print sends the entries (name, code, barcode and SELLING prices only) and the chosen options; options are remembered on the device', async () => {
    const { q, fixture, http, printLabels, savePrefs } = await open('owner', [lamp, bare]);
    q<HTMLInputElement>('[data-test="opt-code"]')!.click();
    fixture.detectChanges();
    expect(savePrefs).toHaveBeenCalledWith({ labelOptions: jasmine.objectContaining({ internalCode: true, target: 'roll' }) });
    q<HTMLButtonElement>('[data-test="print-labels"]')!.click();
    await tick();
    expect(printLabels).toHaveBeenCalledTimes(1);
    const [entries, options] = printLabels.calls.mostRecent().args;
    expect(entries.length).toBe(2);
    expect(entries[0]).toEqual({ item: { name: 'لمبة', code: 'LED-9', barcode: '4006381333931', retailPrice: 45, wholesalePrice: 35, priceAfterDiscount: 45, vatExempt: false }, copies: 3 });
    expect(JSON.stringify(entries)).not.toContain('purchasePrice');
    expect(JSON.stringify(entries)).not.toContain('"20"');
    expect(options).toEqual(jasmine.objectContaining({ target: 'roll', internalCode: true, price: 'retail' }));
    fixture.destroy(); http.verify();
  });
});
