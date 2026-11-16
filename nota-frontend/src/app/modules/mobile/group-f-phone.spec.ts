import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TranslateModule } from '@ngx-translate/core';
import { environment } from '../../../environments/environment';
import { LayoutService } from '../../core/layout/layout.service';
import { ProductWebsiteSectionComponent } from '../website/product-website-section.component';
import { CategoryWebsiteFieldsComponent } from '../website/category-website-fields.component';

/** Online Stage 6B, group F: the product / category website sections show switches on the phone, and behave the same. */
const phone = { provide: LayoutService, useValue: { isMobile: signal(true) } };
const settingsUrl = `${environment.api_base_url}website/settings`;

describe('website sections on the phone (Online Stage 6B)', () => {
  let http: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ProductWebsiteSectionComponent, CategoryWebsiteFieldsComponent, TranslateModule.forRoot()],
      providers: [provideHttpClient(), provideHttpClientTesting(), phone],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('product section: the visibility control is a switch (same data-field), a card, and ticking it marks the section changed', async () => {
    const fixture = TestBed.createComponent(ProductWebsiteSectionComponent);
    fixture.componentRef.setInput('productId', 'p1');
    fixture.detectChanges();
    http.expectOne((r) => r.url === settingsUrl && r.method === 'GET').flush({ productVisibility: 'marked' });
    http.expectOne(`${environment.api_base_url}website/products/p1`).flush({ id: 'p1', website: { visibility: null, description: '', images: [] } });
    fixture.detectChanges();
    const root: HTMLElement = fixture.nativeElement;
    expect(root.querySelector('label.m-switch [data-field="website-visible"]')).not.toBeNull();
    expect(root.querySelector('section.m-card')).not.toBeNull();
    const box = root.querySelector<HTMLInputElement>('[data-field="website-visible"]')!;
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(root.querySelector<HTMLButtonElement>('[data-action="save-website"]')!.disabled).toBeFalse();
  });

  it('category fields: "all" mode shows the hide switch, not the show one', () => {
    const fixture = TestBed.createComponent(CategoryWebsiteFieldsComponent);
    fixture.componentRef.setInput('categoryId', 'c1');
    fixture.detectChanges();
    http.expectOne((r) => r.url === settingsUrl && r.method === 'GET').flush({ productVisibility: 'all' });
    fixture.detectChanges();
    const root: HTMLElement = fixture.nativeElement;
    expect(root.querySelector('label.m-switch [data-field="category-website-hidden"]')).not.toBeNull();
    expect(root.querySelector('[data-field="category-website-visible"]')).toBeNull();
  });
});
