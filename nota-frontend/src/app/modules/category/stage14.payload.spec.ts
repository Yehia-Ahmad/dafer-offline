import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute, convertToParamMap, provideRouter, Router } from '@angular/router';
import { Location } from '@angular/common';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { TranslateModule } from '@ngx-translate/core';
import { of } from 'rxjs';
import { environment } from '../../../environments/environment';
import { CatalogStateService } from '../layout/nav/catalog-state.service';
import { ProductFormComponent } from './components/product-form/product-form.component';
import { ProductsPageComponent } from './components/products-page/products-page.component';
import { signInAs, signInWith } from '../../core/auth/testing/sign-in';

/**
 * Stage 14: product form without products.viewCost. The purchase price is not shown and not sent.
 * BEFORE = the owner (unchanged body, as in the Stage 11/12 specs); AFTER = a user with
 * products.manage but no products.viewCost (only possible with a custom role): edit only.
 * Backend check (product.controller.js updateProduct): an omitted purchasePrice keeps the stored one.
 * Creating a product needs products.viewCost (route guard + POST /api/products), so a new product
 * always carries its purchase price.
 */
const base = environment.api_base_url;
const body = (req: { request: { body: unknown } }) => JSON.stringify(req.request.body);
const NO_COST = ['products.view', 'products.manage', 'categories.manage'];
// What the server sends to a user without products.viewCost: purchasePrice stripped.
const strippedProduct = {
  _id: 'p1', name: 'لمبة LED', code: 'LED-9', inventoryCount: 12, wholesalePrice: 30, retailPrice: 35,
  discountPercentage: 5, soldItemCount: 4, image: 'data:image/png;base64,AAAA',
  specifications: [{ title: 'القدرة', value: '9' }], category: { _id: 'c1', name: 'لمبات', specifications: [{ title: 'القدرة' }] },
};

function configure(route: unknown, template?: 'real') {
  const builder = TestBed.configureTestingModule({
    imports: [ProductFormComponent, TranslateModule.forRoot()],
    providers: [provideRouter([]), provideNoopAnimations(), provideHttpClient(), provideHttpClientTesting(),
      { provide: ActivatedRoute, useValue: route }],
  });
  if (!template) builder.overrideComponent(ProductFormComponent, { set: { template: '', imports: [] } });
  return builder.compileComponents();
}

describe('Stage 14 payloads — product PUT without products.viewCost (before/after)', () => {
  let http: HttpTestingController;

  const edit = async (signIn: () => void, product: object) => {
    await configure({ paramMap: of(convertToParamMap({ id: 'p1' })), snapshot: { params: { id: 'p1' } } });
    http = TestBed.inject(HttpTestingController);
    spyOn(TestBed.inject(Location), 'back');
    signIn();
    const component = TestBed.createComponent(ProductFormComponent).componentInstance;
    component.getProductById();
    http.expectOne(`${base}products/p1`).flush(JSON.parse(JSON.stringify(product)));
    return component;
  };

  afterEach(() => http.verify());

  it('BEFORE (owner, viewCost): purchasePrice is sent as loaded', async () => {
    const component = await edit(() => signInAs('owner'), { ...strippedProduct, purchasePrice: 22 });
    component.updateProduct();
    const req = http.expectOne((r) => r.url === `${base}products/p1` && r.method === 'PUT');
    expect(req.request.body.purchasePrice).toBe(22);
    req.flush({});
  });

  it('AFTER (no viewCost): the same body without purchasePrice (the server keeps the stored value)', async () => {
    const component = await edit(() => signInWith(NO_COST), strippedProduct);
    component.updateProduct();
    const req = http.expectOne((r) => r.url === `${base}products/p1` && r.method === 'PUT');
    expect('purchasePrice' in (req.request.body as object)).toBeFalse();
    expect(body(req)).toBe(JSON.stringify({
      name: 'لمبة LED', code: 'LED-9', inventoryCount: 12, newInventory: 0, wholesalePrice: 30, retailPrice: 35,
      discountPercentage: 5, soldItemCount: 4, image: 'data:image/png;base64,AAAA', editProduct: true,
      specifications: [{ title: 'القدرة', value: '9' }],
    }));
    req.flush({});
  });
});

describe('Stage 14 — creating a product needs products.manage + products.viewCost', () => {
  it('the owner (viewCost) still sends purchasePrice on POST, as before', async () => {
    await configure({ snapshot: { params: {}, queryParamMap: convertToParamMap({ category: 'c1' }) } });
    const http = TestBed.inject(HttpTestingController);
    spyOn(TestBed.inject(Router), 'navigate').and.resolveTo(true);
    TestBed.inject(CatalogStateService).categories.set([{ id: 'c1', label: 'لمبات', category: { _id: 'c1', name: 'لمبات', specifications: [] } }]);
    signInAs('owner');
    const component = TestBed.createComponent(ProductFormComponent).componentInstance;
    component.ngOnInit();
    http.expectOne((r) => r.url === `${base}products` && r.method === 'GET').flush({ success: true, data: [], pagination: { page: 1, limit: 10, totalItems: 0, totalPages: 1 } });
    component.addProductForm.patchValue({ name: 'x', inventoryCount: '1', wholesalePrice: '2', purchasePrice: '1', retailPrice: '3', soldItemCount: '' });
    component.addNewProduct();
    const req = http.expectOne((r) => r.url === `${base}products` && r.method === 'POST');
    expect(req.request.body.purchasePrice).toBe('1');
    req.flush({});
    http.match(() => true).forEach((r) => r.flush([]));
    http.verify();
  });

  it('a user without products.viewCost never sees "new product" (button), and edit stays available', async () => {
    await TestBed.configureTestingModule({
      imports: [ProductsPageComponent, TranslateModule.forRoot()],
      providers: [provideRouter([]), provideNoopAnimations(), provideHttpClient(), provideHttpClientTesting(),
        { provide: ActivatedRoute, useValue: { queryParamMap: of(convertToParamMap({})), snapshot: { queryParamMap: convertToParamMap({}) } } }],
    }).compileComponents();
    const http = TestBed.inject(HttpTestingController);
    TestBed.inject(CatalogStateService).categories.set([{ id: 'c1', label: 'لمبات', category: { _id: 'c1', name: 'لمبات', specifications: [] } }]);
    const render = (permissions: string[]) => {
      signInWith(permissions);
      const fixture = TestBed.createComponent(ProductsPageComponent);
      fixture.detectChanges();
      http.match(() => true).forEach((r) => r.flush(r.request.url.endsWith('products')
        ? { success: true, data: [{ _id: 'p1', name: 'x', code: '01', inventoryCount: 3, retailPrice: 5, wholesalePrice: 4 }], pagination: { page: 1, limit: 10, totalItems: 1, totalPages: 1, hasNextPage: false } }
        : []));
      fixture.detectChanges();
      return fixture.nativeElement as HTMLElement;
    };
    let el = render(NO_COST);
    expect(el.querySelector('[data-action="new-product"]')).toBeNull();
    expect(el.querySelector('a.pp__edit')).not.toBeNull();
    el = render([...NO_COST, 'products.viewCost']);
    expect(el.querySelector('[data-action="new-product"]')).not.toBeNull();
    el = render(['products.view', 'products.viewCost']);
    expect(el.querySelector('[data-action="new-product"]')).toBeNull();
  });
});

describe('Stage 14 — product form rendered without products.viewCost', () => {
  it('no purchase-price field, no profit hints, no below-cost hint, no sync button', async () => {
    await configure({ paramMap: of(convertToParamMap({ id: 'p1' })), snapshot: { params: { id: 'p1' } } }, 'real');
    const http = TestBed.inject(HttpTestingController);
    signInWith(NO_COST);
    const fixture = TestBed.createComponent(ProductFormComponent);
    fixture.componentInstance.getProductById();
    http.expectOne(`${base}products/p1`).flush(JSON.parse(JSON.stringify(strippedProduct)));
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('#purchasePrice')).toBeNull();
    expect(el.querySelector('.pf__hints')).toBeNull();
    expect(el.textContent).not.toContain('productForm.belowPurchaseHint');
    expect(el.querySelector('[data-action="sync-purchase-price"]')).toBeNull();
    expect(el.textContent).not.toContain('NaN');
    // the selling prices are still there
    expect(el.querySelector('#retailPrice')).not.toBeNull();
    http.match(() => true).forEach((r) => r.flush([]));
  });

  it('with products.viewCost (storekeeper): the purchase-price field and sync button show', async () => {
    await configure({ paramMap: of(convertToParamMap({ id: 'p1' })), snapshot: { params: { id: 'p1' } } }, 'real');
    const http = TestBed.inject(HttpTestingController);
    signInWith([...NO_COST, 'products.viewCost', 'products.syncPrice']);
    const fixture = TestBed.createComponent(ProductFormComponent);
    fixture.componentInstance.getProductById();
    http.expectOne(`${base}products/p1`).flush({ ...strippedProduct, purchasePrice: 22 });
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('#purchasePrice')).not.toBeNull();
    expect(el.querySelector('[data-action="sync-purchase-price"]')).not.toBeNull();
    http.match(() => true).forEach((r) => r.flush([]));
  });
});
