import { ComponentFixture, TestBed } from '@angular/core/testing';
import { SeoSearchPreviewComponent } from './seo-search-preview.component';

describe('SeoSearchPreviewComponent', () => {
  let fixture: ComponentFixture<SeoSearchPreviewComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [SeoSearchPreviewComponent]
    }).compileComponents();

    fixture = TestBed.createComponent(SeoSearchPreviewComponent);
    fixture.componentRef.setInput('preview', {
      brand: 'Kapomatic',
      language: 'en',
      direction: 'ltr',
      url: 'kapomatic.com/en/products/gearbox',
      title: 'Gearbox | Kapomatic',
      description: 'Transmission product',
      thumbnail: '',
      price: 1000,
      isProduct: true
    });
    fixture.detectChanges();
  });

  it('renders a product price preview', () => {
    expect(fixture.nativeElement.textContent).toContain('EGP');
  });

  it('renders the approximate preview notice', () => {
    expect(fixture.nativeElement.textContent).toContain('This preview is approximate');
  });
});

