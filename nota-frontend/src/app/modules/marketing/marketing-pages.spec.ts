import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { environment } from '../../../environments/environment';
import { signInWith } from '../../core/auth/testing/sign-in';
import { LayoutService } from '../../core/layout/layout.service';
import { MAIN_ONLY_BOXES } from '../cashbox/testing/payment-boxes.testing';
import { provideFakeVat } from '../shop-profile/services/vat-settings.testing';
import { CampaignFormComponent } from './campaigns/campaign-form.component';
import { CampaignPageComponent } from './campaigns/campaign-page.component';
import { CampaignsComponent } from './campaigns/campaigns.component';
import { SpendDialogComponent } from './campaigns/spend-dialog.component';
import { LeadFormComponent } from './leads/lead-form.component';
import { LeadImportComponent } from './leads/lead-import.component';
import { LeadPageComponent } from './leads/lead-page.component';
import { LeadsComponent } from './leads/leads.component';
import { MarketingSettingsComponent } from './marketing-settings.component';
import { MarketingResultsComponent } from './results/marketing-results.component';

const api = environment.api_base_url;
const phone = { provide: LayoutService, useValue: { isMobile: signal(true) } };
const row = (over = {}) => ({
  clicks: 3, visits: 5, ordersPlaced: 7, ordersCompleted: 4, ordersCancelled: 1, ordersRejected: 1, ordersRefused: 1, sales: 790, deliveryRevenue: 90, conversionRate: 0.8, averageOrderValue: 197.5,
  spend: 40, costPerOrder: 10, returnOnSpend: 19.75, ...over,
});
const campaign = (over = {}) => ({
  _id: 'c1', name: 'حملة رمضان', code: 'ram123', platform: 'facebook', type: 'paid', landing: { kind: 'home' }, startDate: '2026-11-01T00:00:00.000Z', status: 'active',
  fullLink: 'https://shop.test/?utm_source=facebook&utm_medium=paid&utm_campaign=ram123', shortLink: 'https://shop.test/go/ram123', codeEditable: true, ...over,
});

async function setup<T>(component: new (...args: never[]) => T, { permissions = ['marketing.view', 'marketing.manage', 'leads.manage', 'expenses.create'], mobile = false, id = 'c1', query = {} as Record<string, string> } = {}) {
  await TestBed.configureTestingModule({
    imports: [component, TranslateModule.forRoot()],
    providers: [
      provideHttpClient(), provideHttpClientTesting(), provideNoopAnimations(), provideRouter([]), provideFakeVat(),
      ...(mobile ? [phone] : []),
      { provide: ActivatedRoute, useValue: { snapshot: { paramMap: convertToParamMap({ id }), queryParamMap: convertToParamMap(query) } } },
    ],
  }).compileComponents();
  signInWith(permissions);
  const http = TestBed.inject(HttpTestingController);
  const fixture = TestBed.createComponent(component);
  return { http, fixture, el: fixture.nativeElement as HTMLElement, c: fixture.componentInstance as any };
}
const flushBoxes = (http: HttpTestingController) => http.match((r) => r.url.endsWith('cashbox/payment-boxes')).forEach((r) => r.flush(MAIN_ONLY_BOXES));

describe('campaigns list (Online Stage 7A)', () => {
  for (const mobile of [false, true]) {
    it(`${mobile ? 'phone' : 'desktop'}: lists campaigns with their KPIs and a link to each; filters re-query`, async () => {
      const { http, fixture, el } = await setup(CampaignsComponent, { mobile });
      fixture.detectChanges();
      const first = http.expectOne((r) => r.url === `${api}campaigns`);
      expect(first.request.params.get('from')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      first.flush({ range: { from: '2026-10-22', to: '2026-11-20' }, data: [campaign({ kpis: row() }), campaign({ _id: 'c2', name: 'تيك توك', platform: 'tiktok', status: 'ended', kpis: row({ sales: 0, ordersCompleted: 0 }) })] });
      fixture.detectChanges();
      const rows = Array.from(el.querySelectorAll('[data-test="campaign-row"]'));
      expect(rows.length).toBe(2);
      expect(rows[0].textContent).toContain('حملة رمضان');
      expect(rows[0].textContent).toContain('790');
      expect(el.querySelector('[data-action="new-campaign"]')).not.toBeNull();
      const chip = el.querySelector(mobile ? '[data-platform="tiktok"]' : '[data-test="filter-platform"]') as HTMLElement;
      if (mobile) chip.click(); else { (chip as HTMLSelectElement).value = 'tiktok'; chip.dispatchEvent(new Event('change')); }
      http.expectOne((r) => r.url === `${api}campaigns` && r.params.get('platform') === 'tiktok').flush({ range: { from: '', to: '' }, data: [] });
      fixture.detectChanges();
      expect(el.textContent).toContain('marketing.campaigns.empty');
      http.verify();
    });
  }

  it('hides «حملة جديدة» without marketing.manage', async () => {
    const { http, fixture, el } = await setup(CampaignsComponent, { permissions: ['marketing.view'] });
    fixture.detectChanges();
    http.expectOne((r) => r.url === `${api}campaigns`).flush({ range: { from: '', to: '' }, data: [] });
    fixture.detectChanges();
    expect(el.querySelector('[data-action="new-campaign"]')).toBeNull();
  });
});

describe('campaign form', () => {
  it('creates a campaign with the landing, dates and an optional code; a duplicate code shows its message', async () => {
    const { http, fixture, el, c } = await setup(CampaignFormComponent, { id: '' });
    fixture.detectChanges();
    http.expectOne((r) => r.url === `${api}store/categories`).flush({ data: [{ id: 'cat1', name: 'أدوات' }] });
    c.patch('name', 'حملة جديدة'); c.patch('landingKind', 'category'); c.patch('landingRef', 'cat1'); c.patch('code', 'My-Code');
    fixture.detectChanges();
    expect(el.querySelector('[data-test="landing-category"]')).not.toBeNull();
    c.save();
    const post = http.expectOne((r) => r.url === `${api}campaigns` && r.method === 'POST');
    expect(post.request.body).toEqual(jasmine.objectContaining({ name: 'حملة جديدة', platform: 'facebook', type: 'paid', landing: { kind: 'category', ref: 'cat1' }, code: 'my-code', endDate: null, plannedBudget: null }));
    post.flush({ code: 'CODE_TAKEN', message: 'x' }, { status: 409, statusText: 'Conflict' });
    fixture.detectChanges();
    expect(c.error()).toBe('marketing.errors.CODE_TAKEN');
    http.verify();
  });

  it('cannot save a product landing without a product, or an end date before the start', async () => {
    const { http, fixture, c } = await setup(CampaignFormComponent, { id: '' });
    fixture.detectChanges();
    http.expectOne((r) => r.url === `${api}store/categories`).flush({ data: [] });
    c.patch('name', 'x');
    c.patch('landingKind', 'product');
    expect(c.canSave()).toBeFalse();
    c.patch('landingKind', 'path'); c.patch('landingPath', '//evil.com');
    expect(c.canSave()).toBeFalse();
    c.patch('landingPath', '/search'); c.patch('startDate', '2026-11-10'); c.patch('endDate', '2026-11-01');
    expect(c.canSave()).toBeFalse();
    c.patch('endDate', '2026-11-30');
    expect(c.canSave()).toBeTrue();
  });

  it('edit: a used code is shown locked and is not sent', async () => {
    const { http, fixture, el, c } = await setup(CampaignFormComponent, { id: 'c1' });
    fixture.detectChanges();
    http.expectOne((r) => r.url === `${api}store/categories`).flush({ data: [] });
    http.expectOne((r) => r.url === `${api}campaigns/c1`).flush(campaign({ codeEditable: false }));
    fixture.detectChanges();
    expect(el.querySelector('[data-test="code-locked"]')).not.toBeNull();
    expect(el.querySelector('[data-test="campaign-code"]')).toBeNull();
    c.save();
    const put = http.expectOne((r) => r.url === `${api}campaigns/c1` && r.method === 'PUT');
    expect(put.request.body.code).toBeUndefined();
    expect(put.request.body.status).toBe('active');
  });
});

describe('campaign page', () => {
  const load = (http: HttpTestingController, profit: boolean) => {
    http.expectOne((r) => r.url === `${api}campaigns/c1`).flush(campaign());
    http.expectOne((r) => r.url === `${api}campaigns/c1/results`).flush({ range: { from: '', to: '' }, includeProfit: profit, campaign: { campaignId: 'c1', ...campaign(), ...row(profit ? { grossProfit: 350, profitAfterAds: 310 } : {}) }, daily: [] });
    http.expectOne((r) => r.url === `${api}campaigns/c1/spend`).flush({ range: { from: '', to: '' }, total: 40, data: [
      { _id: 'e1', number: 'EX-1', date: '2026-11-16T00:00:00.000Z', amount: 40, vatAmount: 0, net: 40, note: 'إعلان', status: 'posted' },
      { _id: 'e2', number: 'EX-2', date: '2026-11-16T00:00:00.000Z', amount: 10, vatAmount: 0, net: 10, note: 'غلط', status: 'cancelled' },
    ] });
  };

  for (const mobile of [false, true]) {
    it(`${mobile ? 'phone' : 'desktop'}: both links with copy buttons, a QR code, the numbers and the spend (cancelled spend marked)`, async () => {
      const { http, fixture, el } = await setup(CampaignPageComponent, { mobile });
      fixture.detectChanges();
      load(http, true);
      fixture.detectChanges();
      expect(el.querySelector('[data-test="full-link"]')!.textContent).toContain('utm_campaign=ram123');
      expect(el.querySelector('[data-test="short-link"]')!.textContent).toContain('/go/ram123');
      expect(el.querySelector('[data-test="qr"] qrcode')).not.toBeNull();
      const writeText = jasmine.createSpy('writeText').and.resolveTo();
      spyOnProperty(navigator, 'clipboard').and.returnValue({ writeText } as unknown as Clipboard);
      (el.querySelector('[data-action="copy-short"]') as HTMLElement).click();
      await fixture.whenStable();
      expect(writeText).toHaveBeenCalledWith('https://shop.test/go/ram123');
      expect(el.querySelector('[data-test="campaign-kpis"]')!.textContent).toContain('790');
      expect(el.querySelector('[data-test="campaign-kpis"]')!.textContent).toContain('350');
      expect(el.querySelector('[data-test="campaign-kpis"]')!.textContent).toContain('marketing.kpi.deliveryRevenue'); // its own number
      expect(el.querySelectorAll('[data-test="spend-row"]').length).toBe(2);
      expect(el.querySelector('[data-test="spend-total"]')!.textContent).toContain('40');
      expect(el.querySelector('[data-action="record-spend"]')).not.toBeNull();
      flushBoxes(http);
      http.verify();
    });
  }

  it('profit is not shown when the server leaves it out; recording spend needs expenses.create', async () => {
    const { http, fixture, el } = await setup(CampaignPageComponent, { permissions: ['marketing.view'] });
    fixture.detectChanges();
    load(http, false);
    fixture.detectChanges();
    const kpis = el.querySelector('[data-test="campaign-kpis"]')!.textContent!;
    expect(kpis).not.toContain('grossProfit'); expect(kpis).not.toContain('profitAfterAds');
    expect(el.querySelector('[data-action="record-spend"]')).toBeNull();
    expect(el.querySelector('[data-action="edit-campaign"]')).toBeNull();
    flushBoxes(http);
  });

  it('changing the range reloads the numbers and the spend', async () => {
    const { http, fixture, c } = await setup(CampaignPageComponent);
    fixture.detectChanges();
    load(http, true);
    c.setRange('2026-11-01', '2026-11-16');
    expect(http.expectOne((r) => r.url === `${api}campaigns/c1/results`).request.params.get('from')).toBe('2026-11-01');
    expect(http.expectOne((r) => r.url === `${api}campaigns/c1/spend`).request.params.get('to')).toBe('2026-11-16');
    c.setRange('2026-11-20', '2026-11-01'); // inverted: nothing is requested
    flushBoxes(http);
    http.verify();
  });
});

describe('spend dialog', () => {
  it('records an ordinary expense in the «دعاية وإعلان» category with the campaign id, the local date and the chosen box', async () => {
    const { http, fixture } = await setup(SpendDialogComponent);
    fixture.componentRef.setInput('campaignId', 'c1');
    fixture.componentRef.setInput('campaignName', 'حملة رمضان');
    const c = fixture.componentInstance as any;
    const saved = jasmine.createSpy('saved');
    fixture.componentInstance.saved.subscribe(saved);
    fixture.componentInstance.visible.set(true);
    fixture.detectChanges();
    http.expectOne((r) => r.url === `${api}campaigns/ad-category`).flush({ accountId: 'acc-ads', code: '52001', nameAr: 'دعاية وإعلان', nameEn: 'Advertising' });
    flushBoxes(http);
    c.amount.set(40);
    expect(c.canSave()).toBeTrue();
    c.save();
    const post = http.expectOne((r) => r.url === `${api}expenses` && r.method === 'POST');
    expect(post.request.body).toEqual(jasmine.objectContaining({ accountId: 'acc-ads', amount: 40, campaignId: 'c1', note: 'حملة رمضان' }));
    expect(post.request.body.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    post.flush({ _id: 'e1' });
    flushBoxes(http);
    expect(saved).toHaveBeenCalled();
    expect(c.visible()).toBeFalse();
  });

  it('cannot be saved without an amount or the category, and shows the server error', async () => {
    const { http, fixture } = await setup(SpendDialogComponent);
    fixture.componentRef.setInput('campaignId', 'c1');
    const c = fixture.componentInstance as any;
    fixture.componentInstance.visible.set(true);
    fixture.detectChanges();
    http.expectOne((r) => r.url === `${api}campaigns/ad-category`).flush({}, { status: 500, statusText: 'x' });
    flushBoxes(http);
    c.amount.set(10);
    expect(c.canSave()).toBeFalse();
    expect(c.error()).toBe('marketing.spend.errors.category');
  });
});

describe('results page', () => {
  const results = (includeProfit: boolean) => ({
    range: { from: '2026-10-22', to: '2026-11-20' }, includeProfit,
    totals: row(includeProfit ? { grossProfit: 520, profitAfterAds: 480 } : {}),
    campaigns: [{ campaignId: 'c1', name: 'حملة رمضان', code: 'ram123', platform: 'facebook', type: 'paid', status: 'active', ...row(includeProfit ? { grossProfit: 440, profitAfterAds: 400 } : {}) }],
    platforms: [{ platform: 'facebook', ...row(includeProfit ? { grossProfit: 440, profitAfterAds: 400 } : {}) }],
    direct: row({ visits: null, ordersPlaced: 1, ordersCompleted: 1, sales: 130, spend: 0, costPerOrder: null, returnOnSpend: null, ...(includeProfit ? { grossProfit: 80, profitAfterAds: 80 } : {}) }),
    heardFrom: [{ answer: 'فيسبوك', ...row() }, { answer: '', ...row({ sales: 130 }) }],
    daily: [{ day: '2026-11-16', visits: 5, orders: 8, sales: 920 }],
  });

  for (const mobile of [false, true]) {
    it(`${mobile ? 'phone' : 'desktop'}: campaigns, platforms, direct, "heard from" and a daily chart`, async () => {
      const { http, fixture, el } = await setup(MarketingResultsComponent, { mobile });
      fixture.detectChanges();
      http.expectOne((r) => r.url === `${api}campaigns/results`).flush(results(true));
      fixture.detectChanges();
      for (const section of ['campaigns', 'platforms', 'direct', 'heard']) expect(el.querySelector(`[data-section="${section}"]`)).withContext(section).not.toBeNull();
      expect(el.querySelector('[data-section="campaigns"]')!.textContent).toContain('حملة رمضان');
      expect(el.querySelector('[data-test="daily-chart"]')).not.toBeNull();
      if (!mobile) {
        expect(el.querySelectorAll('[data-test="gross-profit"]').length).toBeGreaterThan(0);
        expect(el.querySelectorAll('[data-test="delivery-revenue"]').length).toBeGreaterThan(0);
      } else {
        expect(el.querySelector('[data-test="totals"]')!.textContent).toContain('marketing.kpi.deliveryRevenue');
      }
      expect(el.textContent).toContain('marketing.results.noAnswer');
    });
  }

  it('without the profit permission the profit columns and numbers are gone', async () => {
    const { http, fixture, el } = await setup(MarketingResultsComponent, { permissions: ['marketing.view'] });
    fixture.detectChanges();
    http.expectOne((r) => r.url === `${api}campaigns/results`).flush(results(false));
    fixture.detectChanges();
    expect(el.querySelectorAll('[data-test="gross-profit"]').length).toBe(0);
    expect(el.textContent).not.toContain('marketing.kpi.grossProfit');
    expect(el.textContent).not.toContain('marketing.kpi.profitAfterAds');
    expect(el.textContent).toContain('marketing.kpi.sales');
    expect(el.querySelectorAll('[data-test="delivery-revenue"]').length).toBeGreaterThan(0); // revenue, not profit: still shown
  });
});

describe('leads list', () => {
  const lead = (over = {}) => ({ _id: 'l1', name: 'منى', phone: '01012345678', source: 'facebook', status: 'new', campaignName: 'حملة رمضان', createdAt: '2026-11-10T10:00:00Z', ...over });
  for (const mobile of [false, true]) {
    it(`${mobile ? 'phone' : 'desktop'}: search, status/source chips and the campaign filter (from the URL) go to the server`, async () => {
      const { http, fixture, el, c } = await setup(LeadsComponent, { mobile, query: { campaign: 'c1' } });
      fixture.detectChanges();
      http.expectOne((r) => r.url === `${api}campaigns`).flush({ range: { from: '', to: '' }, data: [campaign()] });
      const first = http.expectOne((r) => r.url === `${api}leads`);
      expect(first.request.params.get('campaign')).toBe('c1');
      first.flush({ data: [lead(), lead({ _id: 'l2', name: 'علي', phone: null, status: 'contacted' })], pagination: { page: 1, limit: 30, totalItems: 2, totalPages: 1 } });
      fixture.detectChanges();
      expect(el.querySelectorAll('[data-test="lead-row"]').length).toBe(2);
      expect(el.querySelector('[data-action="new-lead"]')).not.toBeNull();
      (el.querySelector('[data-status="contacted"]') as HTMLElement).click();
      expect(http.expectOne((r) => r.url === `${api}leads` && r.params.get('status') === 'contacted').request.params.get('page')).toBe('1');
      c.q.set('01012'); c.reload();
      http.match((r) => r.url === `${api}leads`).forEach((r) => r.flush({ data: [], pagination: { page: 1, limit: 30, totalItems: 0, totalPages: 1 } }));
      http.verify();
    });
  }

  it('the cashier sees the list and the add button, no import', async () => {
    const { http, fixture, el } = await setup(LeadsComponent, { permissions: ['leads.manage'] });
    fixture.detectChanges();
    http.match((r) => r.url === `${api}campaigns`).forEach((r) => r.flush({ range: { from: '', to: '' }, data: [] }));
    http.expectOne((r) => r.url === `${api}leads`).flush({ data: [], pagination: { page: 1, limit: 30, totalItems: 0, totalPages: 1 } });
    fixture.detectChanges();
    expect(el.querySelector('[data-action="import-leads"]')).not.toBeNull();
  });
});

describe('lead form', () => {
  it('saves a lead and a duplicate phone links to the existing lead', async () => {
    const { http, fixture, el, c } = await setup(LeadFormComponent, { id: '' });
    fixture.detectChanges();
    http.expectOne((r) => r.url === `${api}campaigns`).flush({ range: { from: '', to: '' }, data: [] });
    expect(c.canSave()).toBeFalse();
    c.patch('name', 'منى'); c.patch('phone', '+20 101 234 5678');
    expect(c.canSave()).toBeTrue();
    c.save();
    const post = http.expectOne((r) => r.url === `${api}leads` && r.method === 'POST');
    expect(post.request.body).toEqual(jasmine.objectContaining({ name: 'منى', phone: '+20 101 234 5678', profileLink: null, source: 'facebook', campaignId: null }));
    post.flush({ code: 'DUPLICATE_PHONE', existingLeadId: 'l9' }, { status: 409, statusText: 'Conflict' });
    fixture.detectChanges();
    expect(el.querySelector('[data-test="duplicate-link"]')!.getAttribute('href')).toContain('/marketing/leads/l9');
  });

  it('a profile link alone is enough', async () => {
    const { http, fixture, c } = await setup(LeadFormComponent, { id: '' });
    fixture.detectChanges();
    http.expectOne((r) => r.url === `${api}campaigns`).flush({ range: { from: '', to: '' }, data: [] });
    c.patch('name', 'بلا رقم'); c.patch('profileLink', 'https://www.facebook.com/mona');
    expect(c.canSave()).toBeTrue();
  });
});

describe('lead page', () => {
  const detail = (bought: boolean) => ({
    _id: 'l1', name: 'منى', phone: '01012345678', source: 'facebook', status: 'new', campaignName: 'حملة رمضان', createdAt: '2026-11-10T10:00:00Z', noteLog: [{ at: '2026-11-11T10:00:00Z', byName: 'owner', text: 'اتصلت' }],
    whatsappLink: 'https://wa.me/201012345678', callLink: 'tel:01012345678', profileLink: null,
    purchases: bought ? { bought: true, count: 2, total: 300, documents: [{ type: 'web_order', id: 'o1', number: 'W-000001', date: '2026-11-12T10:00:00Z', total: 200 }, { type: 'cash_sale', id: 's1', number: 'S-1', date: '2026-11-13T00:00:00Z', total: 100 }] } : { bought: false, count: 0, total: 0, documents: [] },
  });

  it('WhatsApp and call buttons, «اشترى» with the documents, the notes history and adding a note', async () => {
    const { http, fixture, el, c } = await setup(LeadPageComponent, { id: 'l1' });
    fixture.detectChanges();
    http.expectOne((r) => r.url === `${api}leads/l1`).flush(detail(true));
    fixture.detectChanges();
    const wa = el.querySelector('[data-action="whatsapp"]') as HTMLAnchorElement;
    expect(wa.href).toBe('https://wa.me/201012345678'); expect(wa.rel).toContain('noopener');
    expect((el.querySelector('[data-action="call"]') as HTMLAnchorElement).href).toBe('tel:01012345678');
    expect(el.querySelector('[data-test="bought"]')).not.toBeNull();
    expect(el.querySelectorAll('[data-test="purchase-doc"]').length).toBe(2);
    expect(el.querySelectorAll('[data-test="note-row"]').length).toBe(1);
    c.note.set('رد على الواتساب'); c.addNote();
    const post = http.expectOne((r) => r.url === `${api}leads/l1/notes`);
    expect(post.request.body).toEqual({ text: 'رد على الواتساب' });
    post.flush({ noteLog: [{ at: '2026-11-11T10:00:00Z', byName: 'owner', text: 'اتصلت' }, { at: '2026-11-14T10:00:00Z', byName: 'owner', text: 'رد على الواتساب' }] });
    fixture.detectChanges();
    expect(el.querySelectorAll('[data-test="note-row"]').length).toBe(2);
  });

  it('shows «لسه ما اشترى» when nothing matches', async () => {
    const { http, fixture, el } = await setup(LeadPageComponent, { id: 'l1', mobile: true });
    fixture.detectChanges();
    http.expectOne((r) => r.url === `${api}leads/l1`).flush(detail(false));
    fixture.detectChanges();
    expect(el.querySelector('[data-test="not-bought"]')).not.toBeNull();
  });
});

describe('leads import', () => {
  const mapping = { name: 'full_name', phone: 'phone_number', createdTime: null, campaignName: null, adName: null, platform: null, profileLink: null };

  it('auto-maps, lets the user fix the mapping, previews, then imports and reports the counts', async () => {
    const { http, fixture, el, c } = await setup(LeadImportComponent);
    fixture.detectChanges();
    http.expectOne((r) => r.url === `${api}campaigns`).flush({ range: { from: '', to: '' }, data: [campaign()] });
    c.file.set({ headers: ['full_name', 'phone_number'], rows: [{ full_name: 'سلمى', phone_number: 'p:+201000000002' }, { full_name: '', phone_number: '123' }] });
    c.mapping.set({ ...mapping, phone: null });
    fixture.detectChanges();
    expect(c.mapped()).toBeFalse();
    c.setMap('phone', 'phone_number');
    expect(c.mapped()).toBeTrue();
    c.campaignId.set('c1'); c.mode.set('update');
    c.preview();
    const preview = http.expectOne((r) => r.url === `${api}leads/import/preview`);
    expect(preview.request.body).toEqual(jasmine.objectContaining({ mode: 'update', source: 'facebook', campaignId: 'c1', mapping: jasmine.objectContaining({ name: 'full_name', phone: 'phone_number' }) }));
    expect(preview.request.body.rows.length).toBe(2);
    preview.flush({ summary: { total: 2, imported: 1, updated: 0, skipped: 0, invalid: 1 }, rows: [{ index: 0, status: 'new', name: 'سلمى', phone: '01000000002' }, { index: 1, status: 'invalid', reason: 'NAME_REQUIRED', name: '', phone: null }] });
    fixture.detectChanges();
    expect(el.querySelectorAll('[data-test="preview-row"]').length).toBe(2);
    c.commit();
    http.expectOne((r) => r.url === `${api}leads/import` && r.method === 'POST').flush({ total: 2, imported: 1, updated: 0, skipped: 0, invalid: 1, invalidRows: [{ index: 1, reason: 'NAME_REQUIRED', name: '' }] });
    fixture.detectChanges();
    expect(el.querySelector('[data-test="import-result"]')).not.toBeNull();
    expect(c.previewData()).toBeNull();
  });

  it('changing the mapping throws the old preview away; a bad file shows its error', async () => {
    const { http, fixture, c } = await setup(LeadImportComponent);
    fixture.detectChanges();
    http.expectOne((r) => r.url === `${api}campaigns`).flush({ range: { from: '', to: '' }, data: [] });
    c.previewData.set({ summary: { total: 1, imported: 1, updated: 0, skipped: 0, invalid: 0 }, rows: [] });
    c.setMap('name', 'full_name');
    expect(c.previewData()).toBeNull();
    const input = { files: [new File(['x'], 'leads.pdf')] } as unknown as HTMLInputElement;
    await c.onFile({ target: input } as unknown as Event);
    expect(c.error()).toBe('marketing.import.errors.UNSUPPORTED');
    expect(c.file()).toBeNull();
  });
});

describe('marketing settings tab', () => {
  const settings = { metaPixelId: '123456789012345', tiktokPixelId: '', requireConsent: true, attributionDays: 7, askHeardFrom: true, heardFromOptions: ['فيسبوك', 'صديق'], feeds: { meta: 'https://shop.test/feeds/catalog.csv', tiktok: 'https://shop.test/feeds/tiktok.csv' } };

  for (const mobile of [false, true]) {
    it(`${mobile ? 'phone' : 'desktop'}: loads, shows both feed links with copy buttons and saves what changed`, async () => {
      const { http, fixture, el, c } = await setup(MarketingSettingsComponent, { mobile });
      fixture.detectChanges();
      http.expectOne((r) => r.url === `${api}website/marketing-settings` && r.method === 'GET').flush(settings);
      fixture.detectChanges();
      await fixture.whenStable();
      expect(el.querySelector('[data-feed="meta"]')!.textContent).toContain('/feeds/catalog.csv');
      expect(el.querySelector('[data-feed="tiktok"]')!.textContent).toContain('/feeds/tiktok.csv');
      expect((el.querySelector('[data-test="meta-pixel"]') as HTMLInputElement).value).toBe('123456789012345');
      c.tiktokPixelId.set('CABCDEF123456'); c.requireConsent.set(false); c.attributionDays.set(14); c.optionsText.set('فيسبوك\n\n  تيك توك  \n');
      c.save();
      const put = http.expectOne((r) => r.url === `${api}website/marketing-settings` && r.method === 'PUT');
      expect(put.request.body).toEqual({ metaPixelId: '123456789012345', tiktokPixelId: 'CABCDEF123456', requireConsent: false, attributionDays: 14, askHeardFrom: true, heardFromOptions: ['فيسبوك', 'تيك توك'] });
      put.flush({ ...settings, tiktokPixelId: 'CABCDEF123456', requireConsent: false, attributionDays: 14, heardFromOptions: ['فيسبوك', 'تيك توك'] });
      fixture.detectChanges();
      expect(el.querySelector('[data-test="marketing-saved"]')).not.toBeNull();
    });
  }

  it('read-only for marketing.view (no save, inputs disabled); nothing without any marketing permission', async () => {
    const view = await setup(MarketingSettingsComponent, { permissions: ['marketing.view'] });
    view.fixture.detectChanges();
    view.http.expectOne((r) => r.url === `${api}website/marketing-settings`).flush(settings);
    view.fixture.detectChanges();
    await view.fixture.whenStable();
    expect(view.el.querySelector('[data-action="save-marketing"]')).toBeNull();
    expect((view.el.querySelector('[data-test="meta-pixel"]') as HTMLInputElement).disabled).toBeTrue();
    TestBed.resetTestingModule();
    const none = await setup(MarketingSettingsComponent, { permissions: ['website.manage'] });
    none.fixture.detectChanges();
    none.http.expectNone((r) => r.url === `${api}website/marketing-settings`);
    expect(none.el.querySelector('[data-test="marketing-no-access"]')).not.toBeNull();
  });
});
