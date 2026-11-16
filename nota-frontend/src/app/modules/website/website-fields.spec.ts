import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TranslateModule } from '@ngx-translate/core';
import { environment } from '../../../environments/environment';
import { UnsavedWorkService } from '../../core/unsaved-work/unsaved-work.service';
import { ProductsPageComponent } from '../category/components/products-page/products-page.component';
import { CategoryWebsiteFieldsComponent } from './category-website-fields.component';
import { ProductWebsiteSectionComponent } from './product-website-section.component';

const PNG = 'data:image/png;base64,AAAA';

/** Online Stage 3: the product form's "الموقع" section, the category's website fields, and the "on website" flag of the list. */
describe('website fields on products and categories (Online Stage 3)', () => {
  let http: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ProductWebsiteSectionComponent, CategoryWebsiteFieldsComponent, TranslateModule.forRoot()],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  describe('product form section', () => {
    const productUrl = `${environment.api_base_url}website/products/p1`;
    // The section reads the product's website data (images included) from GET /website/products/:id.
    const open = (website?: unknown) => {
      const fixture = TestBed.createComponent(ProductWebsiteSectionComponent);
      fixture.componentRef.setInput('productId', 'p1');
      fixture.detectChanges();
      const req = http.expectOne(productUrl);
      expect(req.request.method).toBe('GET');
      req.flush({ id: 'p1', website: website ?? { visible: false, description: '', images: [] } });
      fixture.detectChanges();
      return { fixture, component: fixture.componentInstance as any };
    };

    it('a product without website data starts hidden, with no images, and nothing to save', () => {
      const { fixture, component } = open(undefined);
      expect(component.visible()).toBeFalse();
      expect(component.images()).toEqual([]);
      expect(component.dirty()).toBeFalse();
      expect((fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('[data-action="save-website"]')!.disabled).toBeTrue();
    });

    it('save: PUT /website/products/:id with visible, trimmed description and the images', () => {
      const { fixture, component } = open({ visible: false, description: 'قديم', images: [PNG] });
      component.visible.set(true);
      component.description.set('  وصف جديد ');
      component.images.update((list: string[]) => [...list, 'data:image/png;base64,BBBB']);
      expect(component.dirty()).toBeTrue();
      component.save();
      const req = http.expectOne((r) => r.url === productUrl && r.method === 'PUT');
      expect(req.request.body).toEqual({ visible: true, description: 'وصف جديد', images: [PNG, 'data:image/png;base64,BBBB'] });
      req.flush({ id: 'p1', website: { visible: true, description: 'وصف جديد', images: [PNG, 'data:image/png;base64,BBBB'] } });
      fixture.detectChanges();
      expect(component.outcome()).toEqual({ kind: 'saved' });
      expect(component.dirty()).toBeFalse();
      expect(component.visible()).toBeTrue();
    });

    it('at most 4 extra images: the add button disappears at 4', () => {
      const { fixture, component } = open({ visible: true, images: [PNG, PNG, PNG] });
      expect(fixture.nativeElement.querySelector('[data-action="add-website-image"]')).not.toBeNull();
      component.images.update((list: string[]) => [...list, PNG]);
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('[data-action="add-website-image"]')).toBeNull();
      component.removeImage(0);
      fixture.detectChanges();
      expect(component.images().length).toBe(3);
    });

    it('a server refusal shows its message and keeps the edit', () => {
      const { component } = open({ visible: false });
      component.visible.set(true);
      component.save();
      http.expectOne((r) => r.method === 'PUT').flush({ message: 'صورة غير صالحة' }, { status: 400, statusText: 'Bad Request' });
      expect(component.outcome()).toEqual({ kind: 'error', message: 'صورة غير صالحة' });
      expect(component.dirty()).toBeTrue();
    });

    it('unsaved work is reported to the shared guard while edited, and not after saving', () => {
      const unsaved = TestBed.inject(UnsavedWorkService);
      const { component } = open({ visible: false });
      expect(unsaved.hasUnsavedWork()).toBeFalse();
      component.description.set('تعديل');
      expect(unsaved.hasUnsavedWork()).toBeTrue();
      component.save();
      http.expectOne((r) => r.method === 'PUT').flush({ id: 'p1', website: { visible: false, description: 'تعديل', images: [] } });
      expect(unsaved.hasUnsavedWork()).toBeFalse();
    });

    it('while loading nothing can be saved, and a failed load shows an error', () => {
      const fixture = TestBed.createComponent(ProductWebsiteSectionComponent);
      fixture.componentRef.setInput('productId', 'p1');
      fixture.detectChanges();
      expect((fixture.componentInstance as any).loading()).toBeTrue();
      expect(fixture.nativeElement.querySelector('[data-action="save-website"]').disabled).toBeTrue();
      http.expectOne(productUrl).flush({}, { status: 500, statusText: 'Server Error' });
      expect((fixture.componentInstance as any).loading()).toBeFalse();
      expect((fixture.componentInstance as any).outcome()).toEqual({ kind: 'error', message: '' });
    });
  });

  describe('category website fields', () => {
    const open = (website?: unknown) => {
      const fixture = TestBed.createComponent(CategoryWebsiteFieldsComponent);
      fixture.componentRef.setInput('categoryId', 'c1');
      fixture.componentRef.setInput('website', website);
      fixture.detectChanges();
      return { fixture, component: fixture.componentInstance as any };
    };

    it('save: PUT /website/categories/:id with visible and a numeric order; an invalid order sends nothing', () => {
      const { component } = open({ visible: false, sortOrder: 3 });
      expect(component.sortOrder()).toBe('3');
      component.visible.set(true);
      component.sortOrder.set('x');
      expect(component.orderInvalid()).toBeTrue();
      component.save();
      http.expectNone((r) => r.method === 'PUT');
      component.sortOrder.set('-2');
      component.save();
      const req = http.expectOne(`${environment.api_base_url}website/categories/c1`);
      expect(req.request.method).toBe('PUT');
      expect(req.request.body).toEqual({ visible: true, sortOrder: -2 });
      req.flush({ id: 'c1', website: { visible: true, sortOrder: -2 } });
      expect(component.outcome()).toBe('saved');
      expect(component.dirty()).toBeFalse();
    });

    it('a category without website data starts hidden at order 0', () => {
      const { component } = open(undefined);
      expect(component.visible()).toBeFalse();
      expect(component.sortOrder()).toBe('0');
      expect(component.dirty()).toBeFalse();
    });
  });

  it('products list: a product is "on the website" only when website.visible is true', () => {
    const isOn = (product: unknown) => (ProductsPageComponent.prototype as any).isOnWebsite.call({}, product);
    expect(isOn({ _id: '1', name: 'أ', website: { visible: true } })).toBeTrue();
    expect(isOn({ _id: '2', name: 'ب', website: { visible: false } })).toBeFalse();
    expect(isOn({ _id: '3', name: 'ج' })).toBeFalse();
    expect(isOn(null)).toBeFalse();
  });
});
