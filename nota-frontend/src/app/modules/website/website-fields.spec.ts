import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TranslateModule } from '@ngx-translate/core';
import { environment } from '../../../environments/environment';
import { UnsavedWorkService } from '../../core/unsaved-work/unsaved-work.service';
import { ProductsPageComponent } from '../category/components/products-page/products-page.component';
import { CategoryWebsiteFieldsComponent } from './category-website-fields.component';
import { ProductWebsiteSectionComponent } from './product-website-section.component';
import { isOnWebsite } from './website.models';

const PNG = 'data:image/png;base64,AAAA';
const settingsUrl = `${environment.api_base_url}website/settings`;

/**
 * Online Stage 3 / 5A: the product form's "الموقع" section, the category's website fields, and the "on website" flag of the list.
 * Stage 5A: `visible` (boolean) became `visibility` ("show" / "hide" / unset) and the control follows the website's mode.
 */
describe('website fields on products and categories (Online Stage 3 / 5A)', () => {
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
    // The section reads the website's mode (GET /website/settings) and the product's website data (images included) from GET /website/products/:id.
    const open = (website?: unknown, mode: 'marked' | 'all' = 'marked') => {
      const fixture = TestBed.createComponent(ProductWebsiteSectionComponent);
      fixture.componentRef.setInput('productId', 'p1');
      fixture.detectChanges();
      http.expectOne((r) => r.url === settingsUrl && r.method === 'GET').flush({ productVisibility: mode });
      const req = http.expectOne(productUrl);
      expect(req.request.method).toBe('GET');
      req.flush({ id: 'p1', website: website ?? { visibility: null, description: '', images: [] } });
      fixture.detectChanges();
      return { fixture, component: fixture.componentInstance as any };
    };

    it('a product without website data starts unset, with no images, and nothing to save', () => {
      const { fixture, component } = open(undefined);
      expect(component.choice()).toBeNull();
      expect(component.images()).toEqual([]);
      expect(component.dirty()).toBeFalse();
      expect((fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('[data-action="save-website"]')!.disabled).toBeTrue();
    });

    it('"marked" mode: the control is "show on website"; ticking sends visibility "show", unticking sends null', () => {
      const { fixture, component } = open({ visibility: null, description: '', images: [] }, 'marked');
      const root: HTMLElement = fixture.nativeElement;
      expect(root.querySelector('[data-field="website-visible"]')).not.toBeNull();
      expect(root.querySelector('[data-field="website-hidden"]')).toBeNull();
      component.setShown(true);
      component.save();
      let req = http.expectOne((r) => r.url === productUrl && r.method === 'PUT');
      expect(req.request.body.visibility).toBe('show');
      req.flush({ id: 'p1', website: { visibility: 'show', description: '', images: [] } });
      component.setShown(false);
      component.save();
      req = http.expectOne((r) => r.url === productUrl && r.method === 'PUT');
      expect(req.request.body.visibility).toBeNull();
      req.flush({ id: 'p1', website: { visibility: null, description: '', images: [] } });
    });

    it('"all" mode: the control is "hide from website"; ticking sends visibility "hide"', async () => {
      const { fixture, component } = open({ visibility: null, description: '', images: [] }, 'all');
      const root: HTMLElement = fixture.nativeElement;
      expect(root.querySelector('[data-field="website-hidden"]')).not.toBeNull();
      expect(root.querySelector('[data-field="website-visible"]')).toBeNull();
      component.setHidden(true);
      component.save();
      const req = http.expectOne((r) => r.url === productUrl && r.method === 'PUT');
      expect(req.request.body.visibility).toBe('hide');
      req.flush({ id: 'p1', website: { visibility: 'hide', description: '', images: [] } });
      fixture.detectChanges();
      await fixture.whenStable(); // ngModel writes the checkbox state asynchronously
      expect((root.querySelector('[data-field="website-hidden"]') as HTMLInputElement).checked).toBeTrue();
    });

    it('save: PUT /website/products/:id with visibility, trimmed description and the images', () => {
      const { fixture, component } = open({ visibility: null, description: 'قديم', images: [PNG] });
      component.setShown(true);
      component.description.set('  وصف جديد ');
      component.images.update((list: string[]) => [...list, 'data:image/png;base64,BBBB']);
      expect(component.dirty()).toBeTrue();
      component.save();
      const req = http.expectOne((r) => r.url === productUrl && r.method === 'PUT');
      expect(req.request.body).toEqual({ visibility: 'show', description: 'وصف جديد', images: [PNG, 'data:image/png;base64,BBBB'] });
      req.flush({ id: 'p1', website: { visibility: 'show', description: 'وصف جديد', images: [PNG, 'data:image/png;base64,BBBB'] } });
      fixture.detectChanges();
      expect(component.outcome()).toEqual({ kind: 'saved' });
      expect(component.dirty()).toBeFalse();
      expect(component.choice()).toBe('show');
    });

    it('at most 4 extra images: the add button disappears at 4', () => {
      const { fixture, component } = open({ visibility: 'show', images: [PNG, PNG, PNG] });
      expect(fixture.nativeElement.querySelector('[data-action="add-website-image"]')).not.toBeNull();
      component.images.update((list: string[]) => [...list, PNG]);
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('[data-action="add-website-image"]')).toBeNull();
      component.removeImage(0);
      fixture.detectChanges();
      expect(component.images().length).toBe(3);
    });

    it('a server refusal shows its message and keeps the edit', () => {
      const { component } = open({ visibility: null });
      component.setShown(true);
      component.save();
      http.expectOne((r) => r.method === 'PUT').flush({ message: 'صورة غير صالحة' }, { status: 400, statusText: 'Bad Request' });
      expect(component.outcome()).toEqual({ kind: 'error', message: 'صورة غير صالحة' });
      expect(component.dirty()).toBeTrue();
    });

    it('unsaved work is reported to the shared guard while edited, and not after saving', () => {
      const unsaved = TestBed.inject(UnsavedWorkService);
      const { component } = open({ visibility: null });
      expect(unsaved.hasUnsavedWork()).toBeFalse();
      component.description.set('تعديل');
      expect(unsaved.hasUnsavedWork()).toBeTrue();
      component.save();
      http.expectOne((r) => r.method === 'PUT').flush({ id: 'p1', website: { visibility: null, description: 'تعديل', images: [] } });
      expect(unsaved.hasUnsavedWork()).toBeFalse();
    });

    it('while loading nothing can be saved, and a failed load shows an error', () => {
      const fixture = TestBed.createComponent(ProductWebsiteSectionComponent);
      fixture.componentRef.setInput('productId', 'p1');
      fixture.detectChanges();
      http.expectOne((r) => r.url === settingsUrl).flush({ productVisibility: 'marked' });
      expect((fixture.componentInstance as any).loading()).toBeTrue();
      expect(fixture.nativeElement.querySelector('[data-action="save-website"]').disabled).toBeTrue();
      http.expectOne(productUrl).flush({}, { status: 500, statusText: 'Server Error' });
      expect((fixture.componentInstance as any).loading()).toBeFalse();
      expect((fixture.componentInstance as any).outcome()).toEqual({ kind: 'error', message: '' });
    });
  });

  describe('category website fields', () => {
    const open = (website?: unknown, mode: 'marked' | 'all' = 'marked') => {
      const fixture = TestBed.createComponent(CategoryWebsiteFieldsComponent);
      fixture.componentRef.setInput('categoryId', 'c1');
      fixture.componentRef.setInput('website', website);
      fixture.detectChanges();
      http.expectOne((r) => r.url === settingsUrl && r.method === 'GET').flush({ productVisibility: mode });
      fixture.detectChanges();
      return { fixture, component: fixture.componentInstance as any };
    };

    it('save: PUT /website/categories/:id with visibility and a numeric order; an invalid order sends nothing', () => {
      const { component } = open({ visibility: null, sortOrder: 3 });
      expect(component.sortOrder()).toBe('3');
      component.choice.set('show');
      component.sortOrder.set('x');
      expect(component.orderInvalid()).toBeTrue();
      component.save();
      http.expectNone((r) => r.method === 'PUT');
      component.sortOrder.set('-2');
      component.save();
      const req = http.expectOne(`${environment.api_base_url}website/categories/c1`);
      expect(req.request.method).toBe('PUT');
      expect(req.request.body).toEqual({ visibility: 'show', sortOrder: -2 });
      req.flush({ id: 'c1', website: { visibility: 'show', sortOrder: -2 } });
      expect(component.outcome()).toBe('saved');
      expect(component.dirty()).toBeFalse();
    });

    it('a category without website data starts unset at order 0', () => {
      const { component } = open(undefined);
      expect(component.choice()).toBeNull();
      expect(component.sortOrder()).toBe('0');
      expect(component.dirty()).toBeFalse();
    });

    it('the control follows the mode: "show" in marked mode, "hide" in all mode', async () => {
      const marked = open({ visibility: 'show', sortOrder: 0 }, 'marked');
      expect(marked.fixture.nativeElement.querySelector('[data-field="category-website-visible"]')).not.toBeNull();
      expect(marked.fixture.nativeElement.querySelector('[data-field="category-website-hidden"]')).toBeNull();
      const all = open({ visibility: 'hide', sortOrder: 0 }, 'all');
      expect(all.fixture.nativeElement.querySelector('[data-field="category-website-hidden"]')).not.toBeNull();
      expect(all.fixture.nativeElement.querySelector('[data-field="category-website-visible"]')).toBeNull();
      await all.fixture.whenStable(); // ngModel writes the checkbox state asynchronously
      expect((all.fixture.nativeElement.querySelector('[data-field="category-website-hidden"]') as HTMLInputElement).checked).toBeTrue();
    });
  });

  it('isOnWebsite: "marked" shows only "show"; "all" shows everything except "hide"', () => {
    expect(isOnWebsite('show', 'marked')).toBeTrue();
    expect(isOnWebsite('hide', 'marked')).toBeFalse();
    expect(isOnWebsite(null, 'marked')).toBeFalse();
    expect(isOnWebsite(undefined, 'marked')).toBeFalse();
    expect(isOnWebsite('show', 'all')).toBeTrue();
    expect(isOnWebsite(null, 'all')).toBeTrue();
    expect(isOnWebsite('hide', 'all')).toBeFalse();
  });

  it('products list: a product is "on the website" by its visibility and the website mode', () => {
    const isOn = (product: unknown, websiteMode: 'marked' | 'all') => (ProductsPageComponent.prototype as any).isOnWebsite.call({ websiteMode }, product);
    expect(isOn({ _id: '1', name: 'أ', website: { visibility: 'show' } }, 'marked')).toBeTrue();
    expect(isOn({ _id: '2', name: 'ب', website: { visibility: 'hide' } }, 'marked')).toBeFalse();
    expect(isOn({ _id: '3', name: 'ج' }, 'marked')).toBeFalse();
    expect(isOn(null, 'marked')).toBeFalse();
    expect(isOn({ _id: '4', name: 'د' }, 'all')).toBeTrue();
    expect(isOn({ _id: '5', name: 'هـ', website: { visibility: 'hide' } }, 'all')).toBeFalse();
  });
});
