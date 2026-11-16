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
    flushBoxes();
    http.expectOne((r) => r.url === url && r.method === 'GET').flush(settings);
    fixture.detectChanges();
  };

  /** Online Stage 5A: the payment tab lists the wallet / bank boxes (GET cashbox/payment-boxes). */
  const flushBoxes = () => http.match((r) => r.url.endsWith('cashbox/payment-boxes')).forEach((r) => r.flush({
    defaultBoxId: 'main', mainBox: { _id: 'main', name: 'الخزنة الرئيسية' }, deviceId: null,
    data: [{ _id: 'main', name: 'الخزنة الرئيسية', type: 'cash', isMain: true }, { _id: 'w1', name: 'محفظة 1', type: 'wallet' }, { _id: 'b1', name: 'بنك 1', type: 'bank' }],
  }));

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
    // Online Stage 5A: the cards are spread over the five tabs.
    const cardsOf: Record<string, string[]> = {
      general: ['status-card', 'identity-card', 'contact-card'],
      look: ['brand-card', 'announcement-card', 'banners-card', 'featured-card', 'highlights-card'],
      delivery: ['fulfillment-card', 'zones-card'],
      payment: ['payment-card'],
      products: ['visibility-card', 'stock-card', 'rules-card', 'whatsapp-card', 'texts-card'],
    };
    for (const [tab, cards] of Object.entries(cardsOf)) {
      component.setTab(tab);
      fixture.detectChanges();
      flushZones(); // the delivery tab embeds the zones list, which asks for its own data (leaving the tab cancels it)
      for (const card of cards) expect(root.querySelector(`[data-test="${card}"]`)).withContext(`${tab}/${card}`).not.toBeNull();
    }
    component.setTab('look');
    fixture.detectChanges();
    expect(root.querySelectorAll('[data-test="banner-row"]').length).toBe(2);
  });

  /** The التوصيل tab embeds the delivery zones, which load their own list. */
  const flushZones = () => http.match((r) => r.url.endsWith('website/delivery-zones') && r.method === 'GET').forEach((r) => r.flush({ data: [] }));

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
      // Online Stage 5A: the defaults of everything the saved document did not have
      fulfillment: { delivery: true, pickup: false },
      payments: { cod: { enabled: true }, instapay: { enabled: false, address: '', boxId: '' }, vodafoneCash: { enabled: false, number: '', boxId: '' } },
      stock: { showOutOfStock: true, showRemaining: { enabled: true, threshold: 5 } },
      productVisibility: 'marked', brandColor: '#0E4D45', announcement: { enabled: false, text: '' },
      seoDescription: '', openingHours: '', sameDayCutoff: '', highlights: [], whatsappConfirmTemplate: '',
    });
    expect('websiteLogo' in req.request.body).withContext('the logo is not re-sent when unchanged').toBeFalse();
    req.flush({ ...stored, title: 'متجري', banners: [] });
    expect(component.outcome()).toEqual({ kind: 'saved' });
  });

  it('Stage 5A save: every new setting goes into the body; the logo only when it changed; blank clears', () => {
    open();
    component.form.patchValue({
      fulfillmentPickup: true, sameDayCutoff: '14:30', codEnabled: false, instapayEnabled: true, instapayAddress: ' shop@instapay ', instapayBoxId: 'w1',
      vodafoneEnabled: true, vodafoneNumber: '01012345678', vodafoneBoxId: 'b1', productVisibility: 'all', showOutOfStock: false, showRemainingEnabled: true,
      showRemainingThreshold: '8', brandColor: component.brandColors[1], announcementEnabled: true, announcementText: ' خصم ', seoDescription: ' وصف ',
      openingHours: ' 10-10 ', whatsappConfirmTemplate: ' أهلا {الاسم} ',
    });
    component.addHighlight();
    component.patchHighlight(0, { icon: 'cash', title: ' دفع ', text: ' سهل ' });
    component.logo.set('data:image/png;base64,LOGO');
    (component as any).logoChanged = true;
    component.save();
    const req = http.expectOne((r) => r.url === url && r.method === 'PUT');
    expect(req.request.body).toEqual(jasmine.objectContaining({
      fulfillment: { delivery: true, pickup: true }, sameDayCutoff: '14:30',
      payments: { cod: { enabled: false }, instapay: { enabled: true, address: 'shop@instapay', boxId: 'w1' }, vodafoneCash: { enabled: true, number: '01012345678', boxId: 'b1' } },
      stock: { showOutOfStock: false, showRemaining: { enabled: true, threshold: 8 } }, productVisibility: 'all', brandColor: component.brandColors[1],
      announcement: { enabled: true, text: 'خصم' }, seoDescription: 'وصف', openingHours: '10-10', whatsappConfirmTemplate: 'أهلا {الاسم}',
      highlights: [{ icon: 'cash', title: 'دفع', text: 'سهل' }], websiteLogo: 'data:image/png;base64,LOGO',
    }));
    req.flush({ ...stored, websiteLogo: 'data:image/png;base64,LOGO' });
    component.removeLogo();
    component.save();
    expect(http.expectOne((r) => r.method === 'PUT').request.body.websiteLogo).toBe('');
  });

  it('Stage 5A: with neither delivery nor pickup, or no payment method, nothing is sent and the tab shows the problem', () => {
    open();
    component.form.patchValue({ fulfillmentDelivery: false, fulfillmentPickup: false });
    component.save();
    expect(component.tab()).toBe('delivery');
    http.expectNone((r) => r.method === 'PUT');
    flushZones();
    component.form.patchValue({ fulfillmentDelivery: true, codEnabled: false, instapayEnabled: false, vodafoneEnabled: false });
    component.save();
    expect(component.tab()).toBe('payment');
    http.expectNone((r) => r.method === 'PUT');
  });

  it('Stage 5A: the payment tab lists wallet and bank boxes only, shows the card option as "coming soon", and the preview follows the form', () => {
    open();
    component.setTab('payment');
    fixture.detectChanges();
    const root: HTMLElement = fixture.nativeElement;
    expect(component.walletBoxes().map((b: any) => b._id)).toEqual(['w1', 'b1']);
    expect(root.querySelectorAll('[data-field="instapay-box"] option').length).toBe(3);
    expect((root.querySelector('[data-field="card-soon"]') as HTMLInputElement).disabled).toBeTrue();
    component.setTab('look');
    component.form.patchValue({ announcementEnabled: true, announcementText: 'عرض اليوم', brandColor: component.brandColors[2] });
    fixture.detectChanges();
    expect(root.querySelector('[data-test="preview-announcement"]')!.textContent).toContain('عرض اليوم');
    component.form.patchValue({ announcementEnabled: false });
    fixture.detectChanges();
    expect(root.querySelector('[data-test="preview-announcement"]')).toBeNull();
    component.setTab('products');
    fixture.detectChanges();
    expect(root.querySelectorAll('.ws__soon [disabled]').length).toBe(2);
  });

  it('Stage 5A review: the six presets are the design\'s, in order, with their Arabic names; the first is the default', () => {
    open();
    component.setTab('look');
    fixture.detectChanges();
    expect(component.brandColors).toEqual(['#0E4D45', '#7C2D12', '#3F3F46', '#14532D', '#831843', '#4C1D95']);
    const labels = Array.from(fixture.nativeElement.querySelectorAll('[data-test="brand-swatch"]')).map((el: any) => el.textContent.trim());
    expect(labels).toEqual(['أخضر نوتة', 'بني', 'رمادي غامق', 'أخضر زرعي', 'نبيتي', 'بنفسجي']);
    expect(component.form.controls.brandColor.value).toBe('#0E4D45');
    expect(fixture.nativeElement.querySelector('[data-color="#0E4D45"]').getAttribute('aria-checked')).toBe('true');
  });

  it('Stage 5A: the site status pill follows the saved status, and "افتح الموقع" opens the site root in a new tab', () => {
    open();
    const root: HTMLElement = fixture.nativeElement;
    expect(root.querySelector('[data-test="site-status"]')).not.toBeNull();
    const link = root.querySelector<HTMLAnchorElement>('[data-action="open-site"]')!;
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('href')).toBe(`${window.location.origin}/`);
  });

  it('Stage 5A: the banner hint says up to 5, three recommended', () => {
    open();
    component.setTab('look');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-test="banners-recommended"]')).not.toBeNull();
    expect(component.limits.banners).toBe(5);
    expect(component.limits.bannersRecommended).toBe(3);
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
    flushBoxes();
    http.expectOne((r) => r.url === url).flush({}, { status: 500, statusText: 'Server Error' });
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[role="alert"]')).not.toBeNull();
  });
});
