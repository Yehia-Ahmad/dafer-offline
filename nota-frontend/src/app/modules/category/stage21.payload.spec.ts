import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting, TestRequest } from '@angular/common/http/testing';
import { ActivatedRoute, convertToParamMap, provideRouter, Router } from '@angular/router';
import { Location } from '@angular/common';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { TranslateModule } from '@ngx-translate/core';
import { environment } from '../../../environments/environment';
import { CatalogStateService } from '../layout/nav/catalog-state.service';
import { ProductFormComponent } from './components/product-form/product-form.component';
import { signInAs } from '../../core/auth/testing/sign-in';

/** Stage 21: "معفى من الضريبة" on a product. Sent only when it is on (create) or when it changed (edit): otherwise the body is the Stage 12 body. */
const base = environment.api_base_url;
const body = (req: TestRequest) => JSON.stringify(req.request.body);
const page = (data: unknown[]) => ({ success: true, data, pagination: { page: 1, limit: 10, totalItems: data.length, totalPages: 1, hasNextPage: false } });

function configure(route: unknown) {
  return TestBed.configureTestingModule({
    imports: [ProductFormComponent, TranslateModule.forRoot()],
    providers: [provideRouter([]), provideNoopAnimations(), provideHttpClient(), provideHttpClientTesting(), { provide: ActivatedRoute, useValue: route }],
  }).overrideComponent(ProductFormComponent, { set: { template: '', imports: [] } }).compileComponents();
}

describe('Stage 21 — product form: vatExempt', () => {
  let http: HttpTestingController;
  let component: ProductFormComponent;
  const drain = () => http.match(() => true).forEach((r) => r.flush(r.request.url.endsWith('categories') ? [] : page([])));

  describe('create', () => {
    const baseBody = { name: 'كتاب', code: '01', inventoryCount: '10', categoryId: 'c1', wholesalePrice: '40', purchasePrice: '30', retailPrice: '50', soldItemCount: '' };
    const open = async () => {
      await configure({ snapshot: { params: {}, queryParamMap: convertToParamMap({ category: 'c1' }) } });
      http = TestBed.inject(HttpTestingController);
      spyOn(TestBed.inject(Router), 'navigate').and.resolveTo(true);
      TestBed.inject(CatalogStateService).categories.set([{ id: 'c1', label: 'كتب', category: { _id: 'c1', name: 'كتب', specifications: [] } }]);
      signInAs('owner');
      const fixture = TestBed.createComponent(ProductFormComponent);
      component = fixture.componentInstance;
      fixture.detectChanges();
      http.expectOne((r) => r.url === `${base}products` && r.method === 'GET').flush(page([]));
      component.addProductForm.patchValue({ name: 'كتاب', inventoryCount: '10', wholesalePrice: '40', purchasePrice: '30', retailPrice: '50', soldItemCount: '' });
    };
    afterEach(() => http.verify());

    it('not exempt → exactly the old body', async () => {
      await open();
      component.addNewProduct();
      const req = http.expectOne((r) => r.url === `${base}products` && r.method === 'POST');
      expect(body(req)).toBe(JSON.stringify(baseBody));
      req.flush({});
      drain();
    });

    it('a price with more than two decimals is refused before anything is sent (create)', async () => {
      await open();
      component.addProductForm.patchValue({ retailPrice: '50.555' });
      component.addNewProduct();
      http.expectNone((r) => r.url === `${base}products` && r.method === 'POST');
      expect(component.errorVisible).toBeTrue();
      expect(component.errorMessage).toBe('vat.priceDecimals');
      expect(component.isAddingProduct).toBeFalse();
    });

    it('exempt → vatExempt: true is appended', async () => {
      await open();
      component.newVatExempt = true;
      component.addNewProduct();
      const req = http.expectOne((r) => r.url === `${base}products` && r.method === 'POST');
      expect(body(req)).toBe(JSON.stringify({ ...baseBody, vatExempt: true }));
      req.flush({});
      drain();
    });
  });

  describe('edit', () => {
    const stage12Body = {
      name: 'لمبة', code: 'L-1', inventoryCount: 12, newInventory: 0, wholesalePrice: 30, purchasePrice: 22, retailPrice: 35,
      discountPercentage: 5, soldItemCount: 4, image: 'img', editProduct: true, specifications: [],
    };
    const load = async (extra: Record<string, unknown> = {}) => {
      await configure({ snapshot: { params: { id: 'p1' } } });
      http = TestBed.inject(HttpTestingController);
      spyOn(TestBed.inject(Location), 'back');
      signInAs('owner');
      component = TestBed.createComponent(ProductFormComponent).componentInstance;
      component.getProductById();
      http.expectOne(`${base}products/p1`).flush({ _id: 'p1', name: 'لمبة', code: 'L-1', inventoryCount: 12, wholesalePrice: 30, purchasePrice: 22,
        retailPrice: 35, discountPercentage: 5, soldItemCount: 4, image: 'img', specifications: [], category: { _id: 'c1', name: 'لمبات' }, ...extra });
    };
    const put = () => http.expectOne((r) => r.url === `${base}products/p1` && r.method === 'PUT');
    afterEach(() => http.verify());

    it('unchanged (not exempt before or after) → exactly the old body', async () => {
      await load();
      expect(component.editVatExempt).toBeFalse();
      component.updateProduct();
      const req = put();
      expect(body(req)).toBe(JSON.stringify(stage12Body));
      req.flush({});
    });

    it('turned on → vatExempt: true; turned off on an exempt product → vatExempt: false; unchanged exempt → not sent', async () => {
      await load();
      component.editVatExempt = true;
      component.updateProduct();
      let req = put();
      expect(req.request.body.vatExempt).toBeTrue();
      req.flush({});
      http.verify();
    });

    it('an exempt product: unchanged sends nothing, cleared sends false', async () => {
      await load({ vatExempt: true });
      expect(component.editVatExempt).toBeTrue();
      component.updateProduct();
      let req = put();
      expect(req.request.body.vatExempt).toBeUndefined();
      req.flush({});
    });

    it('a CHANGED price with more than two decimals is refused; an unchanged legacy 3-decimal price is still sent', async () => {
      await load({ retailPrice: 35.125 });
      component.product.retailPrice = 35.126;
      component.updateProduct();
      http.expectNone((r) => r.url === `${base}products/p1` && r.method === 'PUT');
      expect(component.errorMessage).toBe('vat.priceDecimals');
      component.errorVisible = false;
      component.product.retailPrice = 35.125;           // back to what the product had
      component.updateProduct();
      const req = put();
      expect(req.request.body.retailPrice).toBe(35.125);
      req.flush({});
    });

    it('clearing the flag on an exempt product sends vatExempt: false', async () => {
      await load({ vatExempt: true });
      component.editVatExempt = false;
      component.updateProduct();
      const req = put();
      expect(req.request.body.vatExempt).toBeFalse();
      req.flush({});
    });
  });
});
