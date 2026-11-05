import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting, TestRequest } from '@angular/common/http/testing';
import { ActivatedRoute, convertToParamMap, provideRouter, Router } from '@angular/router';
import { Location } from '@angular/common';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { TranslateModule } from '@ngx-translate/core';
import { of } from 'rxjs';
import { environment } from '../../../environments/environment';
import { CatalogStateService } from '../layout/nav/catalog-state.service';
import { ProductsPageComponent } from './components/products-page/products-page.component';
import { ProductFormComponent } from './components/product-form/product-form.component';
import { CategoryToolsComponent } from './components/category-tools/category-tools.component';
import { ProductProfitReportComponent } from '../products/components/product-profit-report/product-profit-report.component';
import { signInAs } from '../../core/auth/testing/sign-in';

/**
 * Stage 11 payload safety, AFTER version. Same assertions as the BEFORE copy that ran against the old
 * components (CategoryDetailsComponent, ProductEditComponent, SidebarCategoriesComponent, old profit report),
 * plus the Stage 11 additions (period pills, chart load, save and add another, codes from the list page).
 */
const base = environment.api_base_url;
const params = (req: TestRequest) =>
  Object.fromEntries(req.request.params.keys().map((key) => [key, req.request.params.get(key)]));
const body = (req: TestRequest) => JSON.stringify(req.request.body);
const category = { _id: 'c1', name: 'لمبات', specifications: [{ title: 'القدرة' }, { title: 'اللون' }] };
const listProducts = [
  { _id: 'p2', name: 'لمبة ١٢', code: '02', inventoryCount: 3 },
  { _id: 'p1', name: 'لمبة ٩', code: '01', inventoryCount: 40 },
];
const page = (data: unknown[]) => ({ success: true, data, pagination: { page: 1, limit: 10, totalItems: data.length, totalPages: 1, hasNextPage: false } });
const product = {
  _id: 'p1', name: 'لمبة LED', code: 'LED-9', inventoryCount: 12, wholesalePrice: 30, purchasePrice: 22, retailPrice: 35,
  discountPercentage: 5, soldItemCount: 4, image: 'data:image/png;base64,AAAA',
  specifications: [{ title: 'القدرة', value: '9' }], category: { _id: 'c1', name: 'لمبات', specifications: [{ title: 'القدرة' }, { title: 'اللون' }] },
};

/** Flushes whatever follow-up requests are still open (list reloads, catalog refresh). */
function drain(http: HttpTestingController) {
  for (let i = 0; i < 5; i++) {
    const open = http.match(() => true);
    if (!open.length) return;
    open.forEach((r) => r.flush(r.request.url.endsWith('categories') ? [category] : r.request.url.endsWith('products') ? page(listProducts) : {}));
  }
}

function configure(component: any, route: any) {
  return TestBed.configureTestingModule({
    imports: [component, TranslateModule.forRoot()],
    providers: [provideRouter([]), provideNoopAnimations(), provideHttpClient(), provideHttpClientTesting(),
      { provide: ActivatedRoute, useValue: route }],
  }).overrideComponent(component, { set: { template: '', imports: [] } }).compileComponents();
}

const catalogWith = (specifications: unknown[]) =>
  TestBed.inject(CatalogStateService).categories.set([{ id: 'c1', label: 'لمبات', category: { ...category, specifications } }]);

describe('Stage 11 payloads — products list (AFTER: ProductsPageComponent)', () => {
  let http: HttpTestingController;
  let component: ProductsPageComponent;

  beforeEach(async () => {
    await configure(ProductsPageComponent, { queryParamMap: of(convertToParamMap({ category: 'c1' })) });
    http = TestBed.inject(HttpTestingController);
    signInAs('owner'); // Stage 14: as the owner, every action shows as before
    component = TestBed.createComponent(ProductsPageComponent).componentInstance;
    component.ngOnInit();
    const req = http.expectOne((r) => r.url === `${base}products` && r.params.get('page') === '1');
    expect(params(req)).toEqual({ categoryId: 'c1', page: '1', limit: '10' });
    req.flush(page(listProducts));
  });

  afterEach(() => http.verify());

  it('search by name/code and the low-stock toggle filter the loaded rows only (no request)', () => {
    component.searchTerm = ' 02 ';
    expect(component.filteredProducts.map((p) => p._id)).toEqual(['p2']);
    component.searchTerm = '';
    component.lowStockOnly = true;
    expect(component.filteredProducts.map((p) => p._id)).toEqual(['p2']);
    // Stage 12: stockVariant takes the product (its own threshold, default 5: ≤5 / ≤10 / above).
    expect(component.stockVariant({ _id: 'a', name: 'a', inventoryCount: 3 })).toBe('overdue');
    expect(component.stockVariant({ _id: 'a', name: 'a', inventoryCount: 8 })).toBe('due');
    expect(component.stockVariant({ _id: 'a', name: 'a', inventoryCount: 40 })).toBe('ok');
  });

  it('"new product" opens the form on the category and hands it the loaded codes', () => {
    const navigate = spyOn(TestBed.inject(Router), 'navigate').and.resolveTo(true);
    component.newProduct();
    expect(navigate).toHaveBeenCalledWith(['/products/new'], { queryParams: { category: 'c1' }, state: { productCodes: ['02', '01'] } });
  });
});

describe('Stage 11 payloads — create product (AFTER: ProductFormComponent, new)', () => {
  let http: HttpTestingController;
  let component: ProductFormComponent;
  let navigate: jasmine.Spy;

  const create = async (specifications: unknown[]) => {
    await configure(ProductFormComponent, { snapshot: { params: {}, queryParamMap: convertToParamMap({ category: 'c1' }) } });
    http = TestBed.inject(HttpTestingController);
    navigate = spyOn(TestBed.inject(Router), 'navigate').and.resolveTo(true);
    catalogWith(specifications);
    signInAs('owner'); // Stage 14: as the owner, every action shows as before
    component = TestBed.createComponent(ProductFormComponent).componentInstance;
    component.ngOnInit();
    const req = http.expectOne((r) => r.url === `${base}products` && r.method === 'GET');
    expect(params(req)).toEqual({ categoryId: 'c1', page: '1', limit: '10' });
    req.flush(page(listProducts));
  };

  afterEach(() => http.verify());

  it('create product: POST products, exact body (no image → no imageBase64; specs trimmed, empty titles dropped)', async () => {
    await create(category.specifications);
    expect(component.addProductForm.value.code).toBe('03');
    component.addProductForm.patchValue({ name: 'لمبة ١٨', inventoryCount: '10', wholesalePrice: '40', purchasePrice: '30', retailPrice: '50', soldItemCount: '' });
    component.newProductDetails.at(0).patchValue({ value: ' 18 ' });
    component.addNewProduct();
    const req = http.expectOne((r) => r.url === `${base}products` && r.method === 'POST');
    expect(body(req)).toBe(JSON.stringify({
      name: 'لمبة ١٨', code: '03', inventoryCount: '10', categoryId: 'c1', wholesalePrice: '40', purchasePrice: '30', retailPrice: '50', soldItemCount: '',
      specifications: [{ title: 'القدرة', value: '18' }, { title: 'اللون', value: '' }],
    }));
    req.flush({});
    // afterwards: catalog refresh, back to the list on that category
    drain(http);
    expect(navigate).toHaveBeenCalledWith(['/products'], { queryParams: { category: 'c1' } });
  });

  it('create product with image: imageBase64 kept; category without specs → no specifications key', async () => {
    await create([]);
    component.addProductForm.patchValue({ name: 'x', inventoryCount: '1', wholesalePrice: '2', purchasePrice: '1', retailPrice: '3', soldItemCount: '0', imageBase64: 'data:image/png;base64,BBBB' });
    component.addNewProduct();
    const req = http.expectOne((r) => r.url === `${base}products` && r.method === 'POST');
    expect(body(req)).toBe(JSON.stringify({
      name: 'x', code: '03', inventoryCount: '1', imageBase64: 'data:image/png;base64,BBBB', categoryId: 'c1', wholesalePrice: '2', purchasePrice: '1', retailPrice: '3', soldItemCount: '0',
    }));
    req.flush({ message: 'سعر الشراء' }, { status: 400, statusText: 'Bad Request' });
    expect(component.errorVisible).toBeTrue();
    expect(component.errorMessage).toBe('سعر الشراء');
  });

  it('save and add another: same POST, then a clean form on the same category with the next code (frontend only)', async () => {
    await create(category.specifications);
    component.addProductForm.patchValue({ name: 'a', inventoryCount: '1', wholesalePrice: '2', purchasePrice: '1', retailPrice: '3', soldItemCount: '' });
    component.addNewProduct(true);
    http.expectOne((r) => r.url === `${base}products` && r.method === 'POST').flush({});
    drain(http);
    expect(navigate).not.toHaveBeenCalled();
    expect(component.addProductForm.value).toEqual(jasmine.objectContaining({ name: '', code: '04', categoryId: 'c1' }));
    expect(component.newProductDetails.length).toBe(2);
  });
});

describe('Stage 11 — create product with codes passed by the products page', () => {
  it('uses the passed codes (no extra GET)', async () => {
    await configure(ProductFormComponent, { snapshot: { params: {}, queryParamMap: convertToParamMap({ category: 'c1' }) } });
    const http = TestBed.inject(HttpTestingController);
    catalogWith([]);
    history.replaceState({ productCodes: ['A-7', 'A-9'] }, '');
    signInAs('owner'); // Stage 14: as the owner, every action shows as before
    const component = TestBed.createComponent(ProductFormComponent).componentInstance;
    component.ngOnInit();
    history.replaceState(null, '');
    expect(component.addProductForm.value.code).toBe('A-10');
    http.verify();
  });
});

describe('Stage 11 payloads — edit product (AFTER: ProductFormComponent, edit)', () => {
  let http: HttpTestingController;
  let component: ProductFormComponent;

  beforeEach(async () => {
    await configure(ProductFormComponent, { paramMap: of(convertToParamMap({ id: 'p1' })), snapshot: { params: { id: 'p1' } } });
    http = TestBed.inject(HttpTestingController);
    spyOn(TestBed.inject(Location), 'back');
    signInAs('owner'); // Stage 14: as the owner, every action shows as before
    component = TestBed.createComponent(ProductFormComponent).componentInstance;
    component.getProductById();
    http.expectOne(`${base}products/p1`).flush(JSON.parse(JSON.stringify(product)));
  });

  afterEach(() => http.verify());

  it('update with new stock: PUT products/p1, exact body, editProduct false', () => {
    component.product.name = 'لمبة LED ٩';
    component.newInventory = 5;
    component.updateProduct();
    const req = http.expectOne((r) => r.url === `${base}products/p1` && r.method === 'PUT');
    expect(body(req)).toBe(JSON.stringify({
      name: 'لمبة LED ٩', code: 'LED-9', inventoryCount: 12, newInventory: 5, wholesalePrice: 30, purchasePrice: 22, retailPrice: 35,
      discountPercentage: 5, soldItemCount: 4, image: 'data:image/png;base64,AAAA', editProduct: false,
      specifications: [{ title: 'القدرة', value: '9' }, { title: 'اللون', value: '' }],
    }));
    req.flush({});
  });

  it('update without new stock: newInventory 0, editProduct true, discount clamped', () => {
    component.product.discountPercentage = 150;
    component.updateProduct();
    const req = http.expectOne((r) => r.url === `${base}products/p1` && r.method === 'PUT');
    expect(req.request.body.newInventory).toBe(0);
    expect(req.request.body.editProduct).toBeTrue();
    expect(req.request.body.discountPercentage).toBe(100);
    req.flush({ message: 'لا يمكن' }, { status: 400, statusText: 'Bad Request' });
    expect(component.errorVisible).toBeTrue();
  });

  it('delete: DELETE products/p1, then the catalog refresh', () => {
    component.deleteProduct();
    http.expectOne((r) => r.url === `${base}products/p1` && r.method === 'DELETE').flush({});
    const refresh = http.expectOne(`${base}categories`);
    refresh.flush([]);
  });

  it('sync purchase price: POST products/p1/sync-purchase-price with optional dates', () => {
    component.syncPurchasePriceToInvoices();
    let req = http.expectOne(`${base}products/p1/sync-purchase-price`);
    expect(body(req)).toBe('{}');
    req.flush({});
    component.syncDateFrom = new Date(2026, 0, 5);
    component.syncDateTo = new Date(2026, 1, 9);
    component.syncPurchasePriceToInvoices();
    req = http.expectOne(`${base}products/p1/sync-purchase-price`);
    expect(body(req)).toBe(JSON.stringify({ dateFrom: '2026-01-05', dateTo: '2026-02-09' }));
    req.flush({});
  });

  it('profit hint (frontend only): selling − purchase and % of the selling price', () => {
    expect(component.profitHint(35, 22)).toEqual({ amount: 13, percent: 37.1 });
    expect(component.profitHint('', 22)).toBeNull();
  });
});

describe('Stage 11 payloads — category tools (AFTER: CategoryToolsComponent)', () => {
  let http: HttpTestingController;
  let component: CategoryToolsComponent;

  beforeEach(async () => {
    await configure(CategoryToolsComponent, {});
    http = TestBed.inject(HttpTestingController);
    spyOn(HTMLAnchorElement.prototype, 'click');
    signInAs('owner'); // Stage 14: as the owner, every action shows as before
    component = TestBed.createComponent(CategoryToolsComponent).componentInstance;
    component.ngOnInit();
    http.expectOne(`${base}categories`).flush([category]);
    const flag = http.expectOne((r) => r.url === `${base}products`);
    expect(params(flag)).toEqual({ categoryId: 'c1', limit: '1' });
    flag.flush(page(listProducts));
  });

  afterEach(() => http.verify());

  it('add category: POST categories {name, specifications[{title}]} (no image key), then refresh', () => {
    component.openDialog();
    component.addCategory.patchValue({ name: 'شواحن' });
    component.addSpecification();
    component.addSpecification();
    component.specifications.at(0).setValue(' القدرة ');
    component.specifications.at(1).setValue('النوع');
    component.addNewCategory();
    const req = http.expectOne((r) => r.url === `${base}categories` && r.method === 'POST');
    expect(body(req)).toBe(JSON.stringify({ name: 'شواحن', specifications: [{ title: 'القدرة' }, { title: 'النوع' }] }));
    req.flush({});
    expect(http.match(`${base}categories`).map((r) => (r.flush([category]), r)).length).toBe(1);
    drain(http);
  });

  it('edit category: GET categories/c1, then PUT categories/c1 with the image', () => {
    component.openEditCategoryDialog({ id: 'c1', label: 'لمبات', category });
    http.expectOne(`${base}categories/c1`).flush(category);
    component.addCategory.patchValue({ name: 'لمبات LED', imageBase64: 'data:image/png;base64,CCCC' });
    component.addNewCategory();
    const req = http.expectOne((r) => r.url === `${base}categories/c1` && r.method === 'PUT');
    expect(body(req)).toBe(JSON.stringify({ name: 'لمبات LED', imageBase64: 'data:image/png;base64,CCCC', specifications: [{ title: 'القدرة' }, { title: 'اللون' }] }));
    req.flush({});
    expect(http.match(`${base}categories`).map((r) => (r.flush([category]), r)).length).toBe(1);
    drain(http);
  });

  it('delete category: DELETE categories/c1', () => {
    component.promptForCategoryDeletion({ id: 'c1', label: 'لمبات' });
    component.confirmDeleteCategory();
    http.expectOne((r) => r.url === `${base}categories/c1` && r.method === 'DELETE').flush({});
    expect(http.match(`${base}categories`).map((r) => (r.flush([category]), r)).length).toBe(1);
    drain(http);
  });

  it('CATEGORY_NOT_EMPTY shows the category-specific message', () => {
    component.promptForCategoryDeletion({ id: 'c1', label: 'لمبات' });
    component.confirmDeleteCategory();
    http.expectOne(`${base}categories/c1`).flush({ code: 'CATEGORY_NOT_EMPTY' }, { status: 409, statusText: 'Conflict' });
    expect(component.errorVisible()).toBeTrue();
    expect(component.errorMessage()).toContain('لا يمكن حذف فئة تحتوي على أصناف');
  });

  it('export categories: GET categories/export as blob; export products: GET products/export/excel as blob', () => {
    component.exportCategories();
    const a = http.expectOne(`${base}categories/export`);
    expect(a.request.responseType).toBe('blob');
    a.flush(new Blob(['x']));
    component.exportProductsExcel();
    const b = http.expectOne(`${base}products/export/excel`);
    expect(b.request.responseType).toBe('blob');
    b.flush(new Blob(['x']));
  });

  it('import categories: POST categories/import FormData{file}; a non-Excel file sends nothing', () => {
    const pick = (name: string) => {
      const input = document.createElement('input');
      Object.defineProperty(input, 'files', { value: [new File(['x'], name)] });
      component.onCategoryImportSelected({ target: input } as unknown as Event);
    };
    pick('cats.csv');
    http.expectNone(`${base}categories/import`);
    pick('cats.xlsx');
    const req = http.expectOne(`${base}categories/import`);
    expect(req.request.method).toBe('POST');
    expect((req.request.body as FormData).get('file') instanceof File).toBeTrue();
    expect(((req.request.body as FormData).get('file') as File).name).toBe('cats.xlsx');
    req.flush({ success: true, importedCount: 2, skippedCount: 0, errors: [] });
    expect(http.match(`${base}categories`).map((r) => (r.flush([category]), r)).length).toBe(1);
    drain(http);
  });

  it('all-or-nothing import keeps every error row and reports zero imported rows', () => {
    const input = document.createElement('input');
    Object.defineProperty(input, 'files', { value: [new File(['x'], 'invalid.xlsx')] });
    component.onCategoryImportSelected({ target: input } as unknown as Event);
    http.expectOne(`${base}categories/import`).flush({
      success: false, importedCount: 0, skippedCount: 2,
      errors: [{ row: 2, message: 'الاسم مطلوب' }, { row: 4, message: 'اسم مكرر' }],
    });
    expect(component.categoryImportResult()?.importedCount).toBe(0);
    expect(component.categoryImportResult()?.errors.map((error) => component.formatImportError(error)))
      .toEqual(['الاسم مطلوب', 'اسم مكرر']);
  });
});

describe('Stage 11 payloads — profit report (AFTER)', () => {
  let http: HttpTestingController;
  let component: ProductProfitReportComponent;
  const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  beforeEach(async () => {
    await configure(ProductProfitReportComponent, {});
    http = TestBed.inject(HttpTestingController);
    signInAs('owner'); // Stage 14: as the owner, every action shows as before
    component = TestBed.createComponent(ProductProfitReportComponent).componentInstance;
    component.ngOnInit();
    http.expectOne(`${base}categories`).flush([category]);
    const req = http.expectOne((r) => r.url === `${base}products/profit-report`);
    expect(params(req)).toEqual({});
    req.flush({ data: [] });
    // Stage 11: the monthly chart loads the endpoint the PDF uses, for the year field.
    const bar = http.expectOne((r) => r.url === `${base}products/profit-bar`);
    expect(params(bar)).toEqual({ year: String(new Date().getFullYear()) });
    bar.flush({ year: 2026, months: [{ month: 3, label: 'Mar', labelAr: 'مارس', profit: 300, cashProfit: 200, creditProfit: 100 }], totalProfit: 300 });
  });

  afterEach(() => http.verify());

  it('category → GET products?categoryId; apply → profit-report with categoryId/productId/dateFrom/dateTo; reset → no params', () => {
    component.onCategoryFilterChange('c1');
    const p = http.expectOne((r) => r.url === `${base}products`);
    expect(params(p)).toEqual({ categoryId: 'c1' });
    p.flush(page(listProducts));
    component.filterProductId = 'p1';
    component.filterDateFrom = new Date(2026, 5, 1);
    component.filterDateTo = new Date(2026, 10, 30);
    component.applyFilters();
    let req = http.expectOne((r) => r.url === `${base}products/profit-report`);
    expect(params(req)).toEqual({ categoryId: 'c1', productId: 'p1', dateFrom: '2026-06-01', dateTo: '2026-11-30' });
    req.flush({ data: [] });
    component.resetFilters();
    req = http.expectOne((r) => r.url === `${base}products/profit-report`);
    expect(params(req)).toEqual({});
    req.flush({ data: [] });
  });

  it('period pills only set dateFrom / dateTo; custom sends nothing until Apply', () => {
    const today = new Date();
    component.setPeriod('month');
    let req = http.expectOne((r) => r.url === `${base}products/profit-report`);
    expect(params(req)).toEqual({ dateFrom: ymd(new Date(today.getFullYear(), today.getMonth(), 1)), dateTo: ymd(today) });
    req.flush({ data: [] });
    component.setPeriod('sixMonths');
    req = http.expectOne((r) => r.url === `${base}products/profit-report`);
    expect(params(req)).toEqual({ dateFrom: ymd(new Date(today.getFullYear(), today.getMonth() - 5, 1)), dateTo: ymd(today) });
    req.flush({ data: [] });
    component.setPeriod('year');
    req = http.expectOne((r) => r.url === `${base}products/profit-report`);
    expect(params(req)).toEqual({ dateFrom: `${today.getFullYear()}-01-01`, dateTo: ymd(today) });
    req.flush({ data: [] });
    component.setPeriod('custom');
    http.expectNone((r) => r.url === `${base}products/profit-report`);
  });

  it('year field reloads the chart; KPIs, ranking and chart come from the loaded data', () => {
    component.profitYear = 2025;
    component.onProfitYearChange();
    const bar = http.expectOne((r) => r.url === `${base}products/profit-bar`);
    expect(params(bar)).toEqual({ year: '2025' });
    bar.flush({ year: 2025, months: [{ month: 1, label: 'Jan', labelAr: 'يناير', profit: 50, cashProfit: 50, creditProfit: 0 }], totalProfit: 50 });
    expect(component.chartMonths.length).toBe(12);
    expect(component.chartMonths[0].cashPct).toBe(100);

    component.applyFilters();
    http.expectOne((r) => r.url === `${base}products/profit-report`).flush({ data: [
      { productId: 'a', productName: 'A', totalProfit: 20, invoices: [{ invoiceId: 'i1', quantity: 2, purchasePrice: 10, profit: 20 }] },
      { productId: 'b', productName: 'B', totalProfit: 60, invoices: [{ invoiceId: 'i2', quantity: 1, purchasePrice: 40, profit: 60 }] },
    ] });
    expect(component.kpis).toEqual({ sales: 140, cost: 60, profit: 80, margin: 57.1 });
    expect(component.rankedReports.map((r) => [r.productId, r.quantity, r.sales])).toEqual([['b', 1, 100], ['a', 2, 40]]);
  });
});
