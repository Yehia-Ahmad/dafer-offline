import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { environment } from '../../../../environments/environment';
import { WebsiteSettingsComponent } from './website-settings.component';

/** Online Stage 3: /website/settings: GET and PUT /api/website/settings, exact body; unsaved-changes tracking; banners. */
describe('WebsiteSettingsComponent (Online Stage 3)', () => {
  const url = `${environment.api_base_url}website/settings`;
  let http: HttpTestingController;
  let component: any;
  let fixture: any;

  const stored = {
    enabled: true, orderingEnabled: true, closedMessage: '', title: 'متجر النور', about: 'نبذة',
    banners: [
      { _id: 'b2', image: 'data:image/png;base64,BBBB', linkType: 'category', linkId: 'c1', sortOrder: 1 },
      { _id: 'b1', image: 'data:image/png;base64,AAAA', linkType: 'none', sortOrder: 0 },
    ],
    featuredCategoryIds: ['c1'], whatsapp: '01012345678', facebook: '', instagram: '', tiktok: '',
    minOrderAmount: 100, freeDeliveryFrom: null, orderNote: '', returnsPolicy: '', terms: '',
  };

  const open = (settings: unknown = stored) => {
    fixture = TestBed.createComponent(WebsiteSettingsComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
    http.match((r) => r.url.endsWith('/categories') && r.method === 'GET').forEach((r) => r.flush([]));
    http.expectOne((r) => r.url === url && r.method === 'GET').flush(settings);
    fixture.detectChanges();
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [WebsiteSettingsComponent, TranslateModule.forRoot()],
      providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('loads the settings, orders the banners by sortOrder and shows the sections', () => {
    open();
    expect(component.loading()).toBeFalse();
    expect(component.banners().map((b: any) => b.id)).toEqual(['b1', 'b2']);
    expect(component.form.controls.title.value).toBe('متجر النور');
    expect(component.form.controls.minOrderAmount.value).toBe('100');
    expect(component.form.controls.freeDeliveryFrom.value).toBe('');
    const root: HTMLElement = fixture.nativeElement;
    for (const card of ['status-card', 'identity-card', 'banners-card', 'featured-card', 'contact-card', 'rules-card', 'texts-card']) {
      expect(root.querySelector(`[data-test="${card}"]`)).withContext(card).not.toBeNull();
    }
    expect(root.querySelectorAll('[data-test="banner-row"]').length).toBe(2);
  });

  it('save: PUT with trimmed texts, blank amounts as null, saved banners without their image, new ones with it', () => {
    open();
    component.form.patchValue({ title: '  متجري  ', freeDeliveryFrom: '500', minOrderAmount: '', closedMessage: ' مغلق ', facebook: 'https://facebook.com/shop' });
    component.banners.update((list: any[]) => [...list, { image: 'data:image/png;base64,CCCC', linkType: 'product', linkId: 'p9', sortOrder: 2 }]);
    component.save();
    const req = http.expectOne((r) => r.url === url && r.method === 'PUT');
    expect(req.request.body).toEqual({
      enabled: true, orderingEnabled: true, closedMessage: 'مغلق', title: 'متجري', about: 'نبذة',
      banners: [
        { id: 'b1', linkType: 'none', sortOrder: 0 },
        { id: 'b2', linkType: 'category', linkId: 'c1', sortOrder: 1 },
        { image: 'data:image/png;base64,CCCC', linkType: 'product', linkId: 'p9', sortOrder: 2 },
      ],
      featuredCategoryIds: ['c1'], whatsapp: '01012345678', facebook: 'https://facebook.com/shop', instagram: '', tiktok: '',
      minOrderAmount: null, freeDeliveryFrom: 500, orderNote: '', returnsPolicy: '', terms: '',
    });
    req.flush({ ...stored, title: 'متجري', banners: [] });
    expect(component.outcome()).toEqual({ kind: 'saved' });
  });

  it('nothing is sent for a bad link, a bad amount, or a banner link without a target', () => {
    open();
    component.form.patchValue({ facebook: 'not a link' });
    component.save();
    component.form.patchValue({ facebook: '', minOrderAmount: '-5' });
    component.save();
    component.form.patchValue({ minOrderAmount: '10' });
    component.banners.update((list: any[]) => list.map((b: any, i: number) => (i === 0 ? { ...b, linkType: 'category', linkId: null } : b)));
    component.save();
    expect(component.bannerError()).toBe('website.settings.banners.linkMissing');
    http.expectNone((r) => r.method === 'PUT');
  });

  it('a server error shows its message and keeps the form', () => {
    open();
    component.form.patchValue({ title: 'جديد' });
    component.save();
    http.expectOne((r) => r.method === 'PUT').flush({ message: 'رسالة الخادم' }, { status: 400, statusText: 'Bad Request' });
    expect(component.outcome()).toEqual({ kind: 'error', message: 'رسالة الخادم' });
    expect(component.form.controls.title.value).toBe('جديد');
    expect(component.hasUnsavedChanges()).toBeTrue();
  });

  it('unsaved-changes guard: clean after load, dirty after a field, a banner or a featured category, clean after save and after cancel', () => {
    open();
    expect(component.hasUnsavedChanges()).toBeFalse();
    component.form.patchValue({ about: 'تغيير' });
    expect(component.hasUnsavedChanges()).toBeTrue();
    component.cancel();
    expect(component.hasUnsavedChanges()).toBeFalse();
    component.removeBanner(0);
    expect(component.hasUnsavedChanges()).toBeTrue();
    component.cancel();
    expect(component.banners().length).toBe(2);
    component.toggleFeatured('c2');
    expect(component.hasUnsavedChanges()).toBeTrue();
    component.save();
    http.expectOne((r) => r.method === 'PUT').flush({ ...stored, featuredCategoryIds: ['c1', 'c2'] });
    expect(component.hasUnsavedChanges()).toBeFalse();
  });

  it('banners: reorder renumbers sortOrder, remove renumbers, at most 5, product search results can be chosen', () => {
    open();
    component.moveBanner(0, 1);
    expect(component.banners().map((b: any) => [b.id, b.sortOrder])).toEqual([['b2', 0], ['b1', 1]]);
    component.moveBanner(0, -1);
    expect(component.banners().map((b: any) => b.id)).toEqual(['b2', 'b1']);
    component.removeBanner(1);
    expect(component.banners().map((b: any) => [b.id, b.sortOrder])).toEqual([['b2', 0]]);
    for (let n = 0; n < 4; n += 1) component.banners.update((list: any[]) => [...list, { image: `data:image/png;base64,N${n}`, linkType: 'none', sortOrder: list.length }]);
    expect(component.canAddBanner()).toBeFalse();
    component.setLinkType(0, 'product');
    expect(component.banners()[0].linkId).toBeNull();
    component.searchProducts(0, 'قلم');
    http.expectOne((r) => r.url.endsWith('products/search') && r.params.get('q') === 'قلم').flush([{ _id: 'p1', name: 'قلم أزرق', code: 'X' }]);
    expect(component.productSearch().results).toEqual([{ _id: 'p1', name: 'قلم أزرق' }]);
    component.setLinkId(0, 'p1');
    expect(component.banners()[0]).toEqual(jasmine.objectContaining({ linkType: 'product', linkId: 'p1' }));
  });

  it('featured categories: at most 8', () => {
    open();
    for (const id of ['c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9', 'c10']) component.toggleFeatured(id);
    expect(component.featured().length).toBe(8);
    expect(component.featuredFull()).toBeTrue();
  });

  it('a load error shows the alert', () => {
    fixture = TestBed.createComponent(WebsiteSettingsComponent);
    fixture.detectChanges();
    http.match((r) => r.url.endsWith('/categories')).forEach((r) => r.flush([]));
    http.expectOne((r) => r.url === url).flush({}, { status: 500, statusText: 'Server Error' });
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[role="alert"]')).not.toBeNull();
  });
});
