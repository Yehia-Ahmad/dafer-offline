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

/**
 * Stage 12 payloads: all-products list (no categoryId), productCount in the catalog, per-product
 * threshold levels, and the optional discount / lowStockThreshold fields of the product form.
 * Unchanged requests stay covered by stage11.payload.spec.ts (run before and after this stage).
 */
const base = environment.api_base_url;
const params = (req: TestRequest) =>
  Object.fromEntries(req.request.params.keys().map((key) => [key, req.request.params.get(key)]));
const body = (req: TestRequest) => JSON.stringify(req.request.body);
const category = { _id: 'c1', name: 'لمبات', specifications: [], productCount: 3 };
const page = (data: unknown[]) => ({ success: true, data, pagination: { page: 1, limit: 10, totalItems: data.length, totalPages: 1, hasNextPage: false } });

function configure(component: any, route: any) {
  return TestBed.configureTestingModule({
    imports: [component, TranslateModule.forRoot()],
    providers: [provideRouter([]), provideNoopAnimations(), provideHttpClient(), provideHttpClientTesting(),
      { provide: ActivatedRoute, useValue: route }],
  }).overrideComponent(component, { set: { template: '', imports: [] } }).compileComponents();
}

describe('Stage 12 — products page "كل الأصناف"', () => {
  let http: HttpTestingController;
  let component: ProductsPageComponent;

  beforeEach(async () => {
    await configure(ProductsPageComponent, { queryParamMap: of(convertToParamMap({})) });
    http = TestBed.inject(HttpTestingController);
    TestBed.inject(CatalogStateService).categories.set([
      { id: 'c1', label: 'لمبات', productCount: 3 }, { id: 'c2', label: 'شواحن', productCount: 2 },
    ]);
    component = TestBed.createComponent(ProductsPageComponent).componentInstance;
    component.ngOnInit();
  });

  afterEach(() => http.verify());

  it('no ?category → GET products?page=1&limit=10 without categoryId; total = sum of productCount', () => {
    const req = http.expectOne((r) => r.url === `${base}products`);
    expect(params(req)).toEqual({ page: '1', limit: '10' });
    req.flush(page([]));
    expect(component.isAllProducts).toBeTrue();
    expect(component.allCount()).toBe(5);
  });

  it('levels use each product\'s lowStockThreshold (default 5); "low stock only" too', () => {
    http.expectOne((r) => r.url === `${base}products`).flush(page([
      { _id: 'a', name: 'a', inventoryCount: 15, lowStockThreshold: 20 },
      { _id: 'b', name: 'b', inventoryCount: 15 },
      { _id: 'c', name: 'c', inventoryCount: 30, lowStockThreshold: 20 },
      { _id: 'd', name: 'd', inventoryCount: 1, lowStockThreshold: 0 },
    ]));
    const [a, b, c, d] = component.products;
    expect([component.stockVariant(a), component.stockVariant(b), component.stockVariant(c), component.stockVariant(d)])
      .toEqual(['overdue', 'ok', 'due', 'ok']); // threshold 0: low ≤ 0, medium ≤ 0
    component.lowStockOnly = true;
    expect(component.filteredProducts.map((p) => p._id)).toEqual(['a']);
  });

  it('"new product" from all products opens the form without a category', () => {
    http.expectOne((r) => r.url === `${base}products`).flush(page([]));
    const navigate = spyOn(TestBed.inject(Router), 'navigate').and.resolveTo(true);
    component.newProduct();
    expect(navigate).toHaveBeenCalledWith(['/products/new']);
  });
});

describe('Stage 12 — catalog keeps productCount (same GET categories)', () => {
  it('maps productCount from GET categories', () => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    const http = TestBed.inject(HttpTestingController);
    const catalog = TestBed.inject(CatalogStateService);
    catalog.refresh();
    const req = http.expectOne(`${base}categories`);
    expect(req.request.params.keys()).toEqual([]);
    req.flush([category, { _id: 'c2', name: 'شواحن', specifications: [] }]);
    expect(catalog.categories().map((c) => c.productCount)).toEqual([3, undefined]);
    http.expectOne((r) => r.url === `${base}products`).flush(page([]));
    http.verify();
  });
});

describe('Stage 12 — product form, create: discount % and lowStockThreshold only when filled', () => {
  let http: HttpTestingController;
  let component: ProductFormComponent;
  const baseBody = { name: 'لمبة', code: '01', inventoryCount: '10', categoryId: 'c1', wholesalePrice: '40', purchasePrice: '30', retailPrice: '50', soldItemCount: '' };

  const open = async (query: Record<string, string>) => {
    await configure(ProductFormComponent, { snapshot: { params: {}, queryParamMap: convertToParamMap(query) } });
    http = TestBed.inject(HttpTestingController);
    spyOn(TestBed.inject(Router), 'navigate').and.resolveTo(true);
    TestBed.inject(CatalogStateService).categories.set([{ id: 'c1', label: 'لمبات', category }, { id: 'c2', label: 'شواحن', category: { _id: 'c2' } }]);
    const fixture = TestBed.createComponent(ProductFormComponent);
    component = fixture.componentInstance;
    fixture.detectChanges(); // ngOnInit + the category effect
  };
  const fill = () => component.addProductForm.patchValue({ name: 'لمبة', inventoryCount: '10', wholesalePrice: '40', purchasePrice: '30', retailPrice: '50', soldItemCount: '' });
  const post = () => http.expectOne((r) => r.url === `${base}products` && r.method === 'POST');
  const drain = () => http.match(() => true).forEach((r) => r.flush(r.request.url.endsWith('categories') ? [] : page([])));

  afterEach(() => http.verify());

  it('both empty → exactly the Stage 11 body', async () => {
    await open({ category: 'c1' });
    http.expectOne((r) => r.url === `${base}products` && r.method === 'GET').flush(page([]));
    fill();
    component.addNewProduct();
    const req = post();
    expect(body(req)).toBe(JSON.stringify(baseBody));
    req.flush({});
    drain();
  });

  it('both filled → appended at the end as numbers (0 counts as filled)', async () => {
    await open({ category: 'c1' });
    http.expectOne((r) => r.url === `${base}products` && r.method === 'GET').flush(page([]));
    fill();
    component.newDiscountPercentage = 10;
    component.newLowStockThreshold = 0;
    component.addNewProduct();
    const req = post();
    expect(body(req)).toBe(JSON.stringify({ ...baseBody, discountPercentage: 10, lowStockThreshold: 0 }));
    req.flush({});
    drain();
  });

  it('only the threshold → only lowStockThreshold appended; "save and add another" clears both', async () => {
    await open({ category: 'c1' });
    http.expectOne((r) => r.url === `${base}products` && r.method === 'GET').flush(page([]));
    fill();
    component.newLowStockThreshold = '12';
    component.addNewProduct(true);
    const req = post();
    expect(body(req)).toBe(JSON.stringify({ ...baseBody, lowStockThreshold: 12 }));
    req.flush({});
    drain();
    expect(component.newLowStockThreshold).toBe('');
    expect(component.newDiscountPercentage).toBe('');
  });

  it('opened from "كل الأصناف" (no ?category) → starts on the first category and loads its codes', async () => {
    await open({});
    const req = http.expectOne((r) => r.url === `${base}products` && r.method === 'GET');
    expect(params(req)).toEqual({ categoryId: 'c1', page: '1', limit: '10' });
    req.flush(page([{ _id: 'p', name: 'p', code: '07' }]));
    expect(component.categoryId).toBe('c1');
    expect(component.addProductForm.value.code).toBe('08');
  });
});

describe('Stage 12 — product form, edit: lowStockThreshold only when filled, null to clear', () => {
  let http: HttpTestingController;
  let component: ProductFormComponent;
  const stage11Body = {
    name: 'لمبة', code: 'L-1', inventoryCount: 12, newInventory: 0, wholesalePrice: 30, purchasePrice: 22, retailPrice: 35,
    discountPercentage: 5, soldItemCount: 4, image: 'img', editProduct: true, specifications: [],
  };
  const load = async (extra: Record<string, unknown> = {}) => {
    await configure(ProductFormComponent, { snapshot: { params: { id: 'p1' } } });
    http = TestBed.inject(HttpTestingController);
    spyOn(TestBed.inject(Location), 'back');
    component = TestBed.createComponent(ProductFormComponent).componentInstance;
    component.getProductById();
    http.expectOne(`${base}products/p1`).flush({ _id: 'p1', name: 'لمبة', code: 'L-1', inventoryCount: 12, wholesalePrice: 30, purchasePrice: 22,
      retailPrice: 35, discountPercentage: 5, soldItemCount: 4, image: 'img', specifications: [], category: { _id: 'c1', name: 'لمبات' }, ...extra });
  };
  const put = () => http.expectOne((r) => r.url === `${base}products/p1` && r.method === 'PUT');

  afterEach(() => http.verify());

  it('no threshold before or after → exactly the Stage 11 body', async () => {
    await load();
    expect(component.editLowStockThreshold).toBe('');
    component.updateProduct();
    const req = put();
    expect(body(req)).toBe(JSON.stringify(stage11Body));
    req.flush({});
  });

  it('threshold entered → appended', async () => {
    await load();
    component.editLowStockThreshold = 8;
    component.updateProduct();
    const req = put();
    expect(body(req)).toBe(JSON.stringify({ ...stage11Body, lowStockThreshold: 8 }));
    req.flush({});
  });

  it('existing threshold shown; kept as is; cleared → null', async () => {
    await load({ lowStockThreshold: 20 });
    expect(component.editLowStockThreshold).toBe(20);
    component.updateProduct();
    let req = put();
    expect(req.request.body.lowStockThreshold).toBe(20);
    req.flush({});
    component.editLowStockThreshold = '';
    component.updateProduct();
    req = put();
    expect(body(req)).toBe(JSON.stringify({ ...stage11Body, lowStockThreshold: null }));
    req.flush({});
  });
});
