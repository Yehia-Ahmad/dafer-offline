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
import { provideFakeVat } from '../shop-profile/services/vat-settings.testing';
import { CampaignPageComponent } from './campaigns/campaign-page.component';
import { CampaignsComponent } from './campaigns/campaigns.component';
import { MetaLinkDialogComponent } from './campaigns/meta-link-dialog.component';
import { MarketingSettingsComponent } from './marketing-settings.component';
import { MetaBannersComponent } from './meta-banners.component';
import { MetaConnectionComponent } from './meta-connection/meta-connection.component';
import { MarketingResultsComponent } from './results/marketing-results.component';

// Online Stage 7B: the Meta ad account connection card, the link dialog, the banners and the results with the Meta numbers.
const api = environment.api_base_url;
const TOKEN = 'EAAB-SECRET-token-0123456789abcdefghijklmnop';
const phone = { provide: LayoutService, useValue: { isMobile: signal(true) } };

const state = (over = {}) => ({
  connected: true, currency: 'EGP', timezoneName: 'Africa/Cairo', timezoneNote: false, accountStatus: 1, lastSyncAt: '2026-11-20T04:15:00Z', lastSyncOkAt: '2026-11-20T04:15:00Z',
  lastError: null, paused: false, needsRate: false, unlinked: [], unlinkedSpend: 0, ...over,
});
const view = (over = {}) => ({
  connected: true, adAccountId: 'act_1234567890', tokenLast4: TOKEN.slice(-4), hasAppSecret: false, appSecretLast4: null,
  account: { name: 'حساب المحل', currency: 'EGP', timezoneName: 'Africa/Cairo', accountStatus: 1 }, accountStatusWarning: false, scopes: ['ads_read'],
  connectedAt: '2026-11-20T00:00:00Z', lastSyncAt: '2026-11-20T04:15:00Z', lastSyncOkAt: '2026-11-20T04:15:00Z', lastError: null, paused: false, syncing: false, nextManualSyncAt: null,
  mode: 'read', missingPublishScopes: ['ads_management', 'pages_manage_ads', 'pages_read_engagement', 'pages_show_list'], currencySupportedForPublish: true, page: null, instagram: null, ...over,
});
const disconnected = () => view({ connected: false, adAccountId: null, tokenLast4: null, account: null, scopes: [], lastSyncAt: null, lastSyncOkAt: null, connectedAt: null });
const testOk = (over = {}) => ({ ok: true, account: { name: 'حساب المحل', currency: 'EGP', timezoneName: 'Africa/Cairo', accountStatus: 1 }, accountStatusWarning: false, scopes: ['ads_read', 'public_profile'], hasAdsRead: true, neverExpires: true, expiresAt: null, ...over });
const meta = (over = {}) => ({ spend: 170.5, originalSpend: 170.5, originalCurrency: 'EGP', needsRate: false, impressions: 3500, reach: 2600, linkClicks: 105, ctr: 0.03, cpc: 1.62, cpm: 48.71, ...over });
const row = (over = {}) => ({
  clicks: 3, visits: 5, ordersPlaced: 7, ordersCompleted: 4, ordersCancelled: 1, ordersRejected: 1, ordersRefused: 1, sales: 790, deliveryRevenue: 90, conversionRate: 0.8, averageOrderValue: 197.5,
  spend: 40, costPerOrder: 10, returnOnSpend: 19.75, ...over,
});
const campaign = (over = {}) => ({
  _id: 'c1', name: 'حملة رمضان', code: 'ram123', platform: 'facebook', type: 'paid', landing: { kind: 'home' }, startDate: '2026-11-01T00:00:00.000Z', status: 'active',
  fullLink: 'https://shop.test/?utm_campaign=ram123', shortLink: 'https://shop.test/go/ram123', codeEditable: true, ...over,
});

async function setup<T>(component: new (...args: never[]) => T, { permissions = ['marketing.view', 'marketing.manage', 'marketing.connect'], mobile = false, id = 'c1' } = {}) {
  await TestBed.configureTestingModule({
    imports: [component, TranslateModule.forRoot()],
    providers: [
      provideHttpClient(), provideHttpClientTesting(), provideNoopAnimations(), provideRouter([]), provideFakeVat(),
      ...(mobile ? [phone] : []),
      { provide: ActivatedRoute, useValue: { snapshot: { paramMap: convertToParamMap({ id }), queryParamMap: convertToParamMap({}) } } },
    ],
  }).compileComponents();
  signInWith(permissions);
  const http = TestBed.inject(HttpTestingController);
  const fixture = TestBed.createComponent(component);
  return { http, fixture, el: fixture.nativeElement as HTMLElement, c: fixture.componentInstance as any };
}
const type = (el: HTMLElement, selector: string, value: string) => {
  const input = el.querySelector(selector) as HTMLInputElement;
  input.value = value;
  input.dispatchEvent(new Event('input'));
};
// A connected card also asks for the exchange-rate lists (one per currency in the numbers).
const flushRates = (http: HttpTestingController, groups: unknown[] = []) => http.match((r) => r.url === `${api}website/exchange-rates` && r.method === 'GET').forEach((r) => r.flush({ currency: 'EGP', required: false, data: [], groups }));
const click = (el: HTMLElement, selector: string) => (el.querySelector(selector) as HTMLElement).click();

describe('Meta connection card (Online Stage 7B)', () => {
  for (const mobile of [false, true]) {
    it(`${mobile ? 'phone' : 'desktop'}: test, then save; the token never comes back (last 4 only) and leaves the page after saving`, async () => {
      const { http, fixture, el } = await setup(MetaConnectionComponent, { mobile });
      fixture.detectChanges();
      http.expectOne((r) => r.url === `${api}website/meta-connection` && r.method === 'GET').flush(disconnected());
      fixture.detectChanges();
      await fixture.whenStable();
      expect(el.querySelector('[data-test="meta-connected"]')).toBeNull();
      const save = () => el.querySelector('[data-action="meta-save"]') as HTMLButtonElement;
      expect(save().disabled).toBeTrue();
      expect((el.querySelector('[data-test="meta-token"]') as HTMLInputElement).type).toBe('password');

      type(el, '[data-test="meta-account-id"]', '1234567890');
      type(el, '[data-test="meta-token"]', TOKEN);
      fixture.detectChanges();
      expect(save().disabled).toBeTrue(); // not tested yet
      click(el, '[data-action="meta-test"]');
      const test = http.expectOne((r) => r.url === `${api}website/meta-connection/test`);
      expect(test.request.method).toBe('POST');
      expect(test.request.body).toEqual({ adAccountId: '1234567890', token: TOKEN });
      test.flush(testOk());
      fixture.detectChanges();
      const result = el.querySelector('[data-test="meta-test-result"]')!.textContent!;
      expect(result).toContain('حساب المحل'); expect(result).toContain('EGP'); expect(result).toContain('Africa/Cairo');
      expect(el.querySelector('[data-test="meta-test-scopes"]')!.textContent).toContain('ads_read');
      expect(save().disabled).toBeFalse();

      // changing anything clears the test: it must be tested again
      type(el, '[data-test="meta-token"]', `${TOKEN}x`);
      fixture.detectChanges();
      expect(el.querySelector('[data-test="meta-test-result"]')).toBeNull();
      expect(save().disabled).toBeTrue();
      type(el, '[data-test="meta-token"]', TOKEN);
      click(el, '[data-action="meta-test"]');
      http.expectOne((r) => r.url === `${api}website/meta-connection/test`).flush(testOk());
      fixture.detectChanges();

      click(el, '[data-action="meta-save"]');
      const put = http.expectOne((r) => r.url === `${api}website/meta-connection` && r.method === 'PUT');
      expect(put.request.body).toEqual({ adAccountId: '1234567890', token: TOKEN });
      put.flush(view());
      flushRates(http);
      fixture.detectChanges();
      await fixture.whenStable(); // ngModel writes the cleared value into the input asynchronously
      expect(el.querySelector('[data-test="meta-saved"]')).not.toBeNull();
      expect(el.querySelector('[data-test="token-last4"]')!.textContent).toContain(TOKEN.slice(-4));
      expect((el.querySelector('[data-test="meta-token"]') as HTMLInputElement).value).toBe('');
      // the token is nowhere in the page text
      expect(el.textContent).not.toContain(TOKEN);
      expect(el.innerHTML).not.toContain(TOKEN);
      http.verify();
    });
  }

  it('a failed test shows a fixed message and keeps saving disabled; a token without ads_read cannot be saved', async () => {
    const { http, fixture, el } = await setup(MetaConnectionComponent);
    fixture.detectChanges();
    http.expectOne((r) => r.url === `${api}website/meta-connection`).flush(disconnected());
    fixture.detectChanges();
    type(el, '[data-test="meta-account-id"]', 'act_1234567890'); type(el, '[data-test="meta-token"]', TOKEN);
    fixture.detectChanges();
    click(el, '[data-action="meta-test"]');
    http.expectOne((r) => r.url === `${api}website/meta-connection/test`).flush({ code: 'TOKEN_INVALID', message: 'x' }, { status: 400, statusText: 'Bad Request' });
    fixture.detectChanges();
    expect(el.querySelector('[data-test="meta-error"]')!.textContent).toContain('marketing.meta.errors.TOKEN_INVALID');
    expect((el.querySelector('[data-action="meta-save"]') as HTMLButtonElement).disabled).toBeTrue();

    click(el, '[data-action="meta-test"]');
    http.expectOne((r) => r.url === `${api}website/meta-connection/test`).flush(testOk({ ok: false, hasAdsRead: false, scopes: ['public_profile'] }));
    fixture.detectChanges();
    expect((el.querySelector('[data-action="meta-save"]') as HTMLButtonElement).disabled).toBeTrue();
    expect(el.querySelector('[data-test="meta-test-result"]')!.textContent).toContain('marketing.meta.errors.PERMISSION_MISSING');
    http.verify();
  });

  it('connected: shows the account and only the last 4; disconnect asks first; the sync button waits 5 minutes after a sync', async () => {
    const { http, fixture, el } = await setup(MetaConnectionComponent);
    fixture.detectChanges();
    http.expectOne((r) => r.url === `${api}website/meta-connection`).flush(view({ hasAppSecret: true, appSecretLast4: 'abcd', nextManualSyncAt: '2099-01-01T00:00:00Z' }));
    flushRates(http);
    fixture.detectChanges();
    const box = el.querySelector('[data-test="meta-connected"]')!.textContent!;
    expect(box).toContain('حساب المحل'); expect(box).toContain('act_1234567890'); expect(box).toContain(TOKEN.slice(-4));
    expect(el.querySelector('[data-test="secret-last4"]')!.textContent).toContain('abcd');
    expect((el.querySelector('[data-action="meta-sync-now"]') as HTMLButtonElement).disabled).toBeTrue();
    expect(el.querySelector('[data-test="meta-sync-wait"]')).not.toBeNull();
    expect(el.textContent).not.toContain(TOKEN);

    click(el, '[data-action="meta-disconnect"]');
    fixture.detectChanges();
    http.expectNone((r) => r.method === 'DELETE');
    click(el, '[data-action="meta-disconnect-yes"]');
    const del = http.expectOne((r) => r.url === `${api}website/meta-connection` && r.method === 'DELETE');
    del.flush(disconnected());
    fixture.detectChanges();
    expect(el.querySelector('[data-test="meta-connected"]')).toBeNull();
    http.verify();
  });

  it('sync now posts, and an error from the last sync shows with its fixed message', async () => {
    const { http, fixture, el } = await setup(MetaConnectionComponent);
    fixture.detectChanges();
    http.expectOne((r) => r.url === `${api}website/meta-connection`).flush(view({ lastError: { code: 'TOKEN_INVALID', message: 'm', at: '2026-11-20T00:00:00Z' }, paused: true }));
    flushRates(http);
    fixture.detectChanges();
    expect(el.querySelector('[data-test="meta-last-error"]')!.textContent).toContain('marketing.meta.errors.TOKEN_INVALID');
    expect(el.querySelector('[data-test="meta-last-error"]')!.textContent).toContain('marketing.meta.paused');
    click(el, '[data-action="meta-sync-now"]');
    http.expectOne((r) => r.url === `${api}website/meta-connection/sync` && r.method === 'POST').flush(view({ nextManualSyncAt: '2099-01-01T00:00:00Z' }), { status: 202, statusText: 'Accepted' });
    fixture.detectChanges();
    expect((el.querySelector('[data-action="meta-sync-now"]') as HTMLButtonElement).disabled).toBeTrue();
    http.verify();
  });

  it('a non-EGP account shows the exchange-rate history; adding and deleting a rate reload it', async () => {
    const { http, fixture, el } = await setup(MetaConnectionComponent);
    fixture.detectChanges();
    const usd = view({ account: { name: 'حساب', currency: 'USD', timezoneName: 'America/Los_Angeles', accountStatus: 1 } });
    http.expectOne((r) => r.url === `${api}website/meta-connection`).flush(usd);
    http.expectOne((r) => r.url === `${api}website/exchange-rates`).flush({ currency: 'USD', required: true, data: [], groups: [{ currency: 'USD', data: [{ _id: 'r1', currency: 'USD', rate: 48.5, effectiveFrom: '2026-11-01', createdByName: 'x' }] }] });
    fixture.detectChanges();
    expect(el.querySelectorAll('[data-test="rate-row"]').length).toBe(1);
    expect(el.querySelector('[data-test="rate-row"]')!.textContent).toContain('48.5');
    type(el, '[data-test="rate-value"]', '50');
    type(el, '[data-test="rate-from"]', '2026-11-10');
    fixture.detectChanges();
    click(el, '[data-action="save-rate"]');
    const post = http.expectOne((r) => r.url === `${api}website/exchange-rates` && r.method === 'POST');
    expect(post.request.body).toEqual({ currency: 'USD', rate: 50, effectiveFrom: '2026-11-10' });
    post.flush({});
    http.expectOne((r) => r.url === `${api}website/meta-connection`).flush(usd);
    http.expectOne((r) => r.url === `${api}website/exchange-rates`).flush({ currency: 'USD', required: true, data: [], groups: [{ currency: 'USD', data: [] }] });
    fixture.detectChanges();
    expect(el.querySelector('[data-test="rates-empty"]')).not.toBeNull();
    http.verify();
  });

  it('an EGP account with no foreign-currency numbers shows no exchange-rate section', async () => {
    const { http, fixture, el } = await setup(MetaConnectionComponent);
    fixture.detectChanges();
    http.expectOne((r) => r.url === `${api}website/meta-connection`).flush(view());
    http.expectOne((r) => r.url === `${api}website/exchange-rates`).flush({ currency: 'EGP', required: false, data: [], groups: [] });
    fixture.detectChanges();
    expect(el.querySelector('[data-test="rate-value"]')).toBeNull();
    expect(el.querySelector('[data-test="rate-group"]')).toBeNull();
  });

  it('after replacing a USD account by an EGP one: one rate list per currency in the numbers, the currency is chosen when adding', async () => {
    const { http, fixture, el } = await setup(MetaConnectionComponent);
    fixture.detectChanges();
    http.expectOne((r) => r.url === `${api}website/meta-connection`).flush(view());
    http.expectOne((r) => r.url === `${api}website/exchange-rates`).flush({
      currency: 'EGP', required: false, data: [],
      groups: [{ currency: 'EUR', data: [] }, { currency: 'USD', data: [{ _id: 'r1', currency: 'USD', rate: 48.5, effectiveFrom: '2026-11-01', createdByName: 'x' }] }],
    });
    fixture.detectChanges();
    await fixture.whenStable();
    expect(el.querySelectorAll('[data-test="rate-group"]').length).toBe(2);
    expect(el.querySelector('[data-currency="USD"]')!.textContent).toContain('48.5');
    expect(el.querySelector('[data-currency="EUR"] [data-test="rates-empty"]')).not.toBeNull();
    const select = el.querySelector('[data-test="rate-currency"]') as HTMLSelectElement;
    select.value = 'USD'; select.dispatchEvent(new Event('change'));
    type(el, '[data-test="rate-value"]', '50'); type(el, '[data-test="rate-from"]', '2026-11-10');
    fixture.detectChanges();
    click(el, '[data-action="save-rate"]');
    const post = http.expectOne((r) => r.url === `${api}website/exchange-rates` && r.method === 'POST');
    expect(post.request.body).toEqual({ currency: 'USD', rate: 50, effectiveFrom: '2026-11-10' });
  });

  it('inside the marketing settings tab: only with marketing.connect (owner), never for a manager', async () => {
    const owner = await setup(MarketingSettingsComponent, { permissions: ['marketing.view', 'marketing.manage', 'marketing.connect'] });
    owner.fixture.detectChanges();
    owner.http.expectOne((r) => r.url === `${api}website/marketing-settings`).flush({ metaPixelId: '', tiktokPixelId: '', requireConsent: true, attributionDays: 7, askHeardFrom: true, heardFromOptions: [], feeds: { meta: 'a', tiktok: 'b' } });
    owner.http.expectOne((r) => r.url === `${api}website/meta-connection`).flush(disconnected());
    owner.fixture.detectChanges();
    expect(owner.el.querySelector('[data-test="meta-connection"]')).not.toBeNull();
    TestBed.resetTestingModule();
    const manager = await setup(MarketingSettingsComponent, { permissions: ['marketing.view', 'marketing.manage'] });
    manager.fixture.detectChanges();
    manager.http.expectOne((r) => r.url === `${api}website/marketing-settings`).flush({ metaPixelId: '', tiktokPixelId: '', requireConsent: true, attributionDays: 7, askHeardFrom: true, heardFromOptions: [], feeds: { meta: 'a', tiktok: 'b' } });
    manager.fixture.detectChanges();
    expect(manager.el.querySelector('[data-test="meta-connection"]')).toBeNull();
    manager.http.expectNone((r) => r.url === `${api}website/meta-connection`);
  });
});

describe('Meta banners', () => {
  it('shows only what applies: failed sync, missing rate, other time zone, inactive account', async () => {
    const { fixture, el } = await setup(MetaBannersComponent);
    const show = (m: unknown) => { fixture.componentRef.setInput('meta', m); fixture.detectChanges(); };
    show(state());
    expect(el.querySelector('.mb')).toBeNull();
    show(undefined);
    expect(el.querySelector('.mb')).toBeNull();
    show(state({ lastError: { code: 'RATE_LIMITED', message: 'm', at: 'x' }, needsRate: true, currency: 'USD', timezoneNote: true, timezoneName: 'America/Los_Angeles', accountStatus: 2 }));
    expect(el.querySelector('[data-test="meta-banner-error"]')!.textContent).toContain('marketing.meta.errors.RATE_LIMITED');
    expect(el.querySelector('[data-test="meta-banner-rate"]')).not.toBeNull();
    expect(el.querySelector('[data-test="meta-banner-timezone"]')).not.toBeNull();
    expect(el.querySelector('[data-test="meta-banner-status"]')).not.toBeNull();
    show(state({ accountStatus: 9 }));
    expect(el.querySelector('[data-test="meta-banner-status"]')).toBeNull(); // in grace period: fine
    show(state({ lastError: { code: 'SOMETHING_NEW', message: 'm', at: 'x' } }));
    expect(el.querySelector('[data-test="meta-banner-error"]')!.textContent).toContain('marketing.meta.errors.META_ERROR');
  });
});

describe('link dialog', () => {
  const rows = [
    { metaId: '1', name: 'Ramadan sale ram123', status: 'ACTIVE', objective: '', campaignId: null, linkedAt: null, suggested: true },
    { metaId: '2', name: 'Other', status: 'PAUSED', objective: '', campaignId: null, linkedAt: null, suggested: false },
    { metaId: '3', name: 'Taken', status: 'ACTIVE', objective: '', campaignId: 'c9', linkedAt: 'x', suggested: false },
    { metaId: '4', name: 'Mine', status: 'ACTIVE', objective: '', campaignId: 'c1', linkedAt: 'x', suggested: false },
  ];
  for (const mobile of [false, true]) {
    it(`${mobile ? 'phone' : 'desktop'}: lists Meta campaigns (suggested first), links one, shows taken ones as linked elsewhere`, async () => {
      const { http, fixture } = await setup(MetaLinkDialogComponent, { mobile });
      fixture.componentRef.setInput('campaignId', 'c1');
      fixture.componentRef.setInput('visible', true);
      fixture.detectChanges();
      const list = http.expectOne((r) => r.url === `${api}campaigns/meta-campaigns`);
      expect(list.request.params.get('campaignId')).toBe('c1');
      list.flush({ data: rows });
      fixture.detectChanges();
      await fixture.whenStable();
      const body = document.body;
      const items = Array.from(body.querySelectorAll('[data-test="meta-row"]'));
      expect(items.length).toBe(4);
      expect(items[0].textContent).toContain('Ramadan sale');
      expect(items[0].querySelector('[data-test="meta-suggested"]')).not.toBeNull();
      expect(items[1].querySelector('[data-test="meta-suggested"]')).toBeNull();
      expect(items[2].querySelector('[data-test="meta-taken"]')).not.toBeNull();
      expect(items[2].querySelector('[data-action="link-meta"]')).toBeNull();
      expect(items[3].querySelector('[data-test="meta-here"]')).not.toBeNull();

      (items[0].querySelector('[data-action="link-meta"]') as HTMLElement).click();
      const post = http.expectOne((r) => r.url === `${api}campaigns/c1/meta-links` && r.method === 'POST');
      expect(post.request.body).toEqual({ metaId: '1' });
      post.flush({ ...rows[0], campaignId: 'c1' }, { status: 201, statusText: 'Created' });
      http.expectOne((r) => r.url === `${api}campaigns/meta-campaigns`).flush({ data: rows });
      fixture.detectChanges();
      fixture.componentRef.setInput('visible', false);
      fixture.detectChanges();
      await fixture.whenStable();
    });
  }

  it('an already-linked error shows its message and reloads', async () => {
    const { http, fixture } = await setup(MetaLinkDialogComponent);
    fixture.componentRef.setInput('campaignId', 'c1');
    fixture.componentRef.setInput('visible', true);
    fixture.detectChanges();
    http.expectOne((r) => r.url === `${api}campaigns/meta-campaigns`).flush({ data: rows });
    fixture.detectChanges();
    const c = fixture.componentInstance as any;
    c.link(rows[1]);
    http.expectOne((r) => r.url === `${api}campaigns/c1/meta-links` && r.method === 'POST').flush({ code: 'ALREADY_LINKED', message: 'x' }, { status: 409, statusText: 'Conflict' });
    expect(c.error()).toBe('marketing.meta.link.errors.ALREADY_LINKED');
    http.expectOne((r) => r.url === `${api}campaigns/meta-campaigns`).flush({ data: rows });
  });
});

describe('campaign page with Meta numbers', () => {
  const load = (http: HttpTestingController, over: { results?: object; links?: object[]; meta?: object | undefined } = {}) => {
    http.expectOne((r) => r.url === `${api}campaigns/c1`).flush(campaign());
    http.expectOne((r) => r.url === `${api}campaigns/c1/results`).flush({
      range: { from: '', to: '' }, includeProfit: true, daily: [], meta: 'meta' in over ? over.meta : state(),
      campaign: { campaignId: 'c1', ...campaign(), ...row({ spend: 170.5, recordedSpend: 40, meta: meta(), costPerOrder: 42.63, returnOnSpend: 4.63, grossProfit: 350, profitAfterAds: 179.5 }), ...over.results },
    });
    http.expectOne((r) => r.url === `${api}campaigns/c1/spend`).flush({ range: { from: '', to: '' }, total: 40, data: [] });
    http.expectOne((r) => r.url === `${api}campaigns/c1/meta-links`).flush({ data: over.links ?? [] });
  };
  const kpiText = (el: HTMLElement) => el.querySelector('[data-test="campaign-kpis"]')!.textContent!;

  for (const mobile of [false, true]) {
    it(`${mobile ? 'phone' : 'desktop'}: Facebook spend and the recorded payments side by side, the Meta numbers, a link button and the no-double-count note`, async () => {
      const { http, fixture, el } = await setup(CampaignPageComponent, { mobile });
      fixture.detectChanges();
      load(http, { links: [{ metaId: '1', name: 'Ramadan', status: 'ACTIVE', objective: '', campaignId: 'c1', linkedAt: 'x', suggested: false }] });
      fixture.detectChanges();
      const text = kpiText(el);
      for (const key of ['metaSpend', 'recordedSpend', 'impressions', 'reach', 'linkClicks', 'ctr', 'cpc', 'cpm']) expect(text).toContain(`marketing.kpi.${key}`);
      expect(text).not.toContain('marketing.kpi.spend');
      expect(text).toContain('170.5'); expect(text).toContain('3500'); expect(text).toContain('3%');
      expect(el.querySelector('[data-test="meta-no-double"]')).not.toBeNull();
      expect(el.querySelectorAll('[data-test="meta-linked-row"]').length).toBe(1);
      expect(el.querySelector('[data-action="link-facebook"]')).not.toBeNull();
      expect(el.querySelector('[data-action="unlink-meta"]')).not.toBeNull();
      // unlinking calls the API and reloads
      click(el, '[data-action="unlink-meta"]');
      http.expectOne((r) => r.url === `${api}campaigns/c1/meta-links/1` && r.method === 'DELETE').flush({ ok: true });
      http.match(() => true).forEach((r) => r.flush({}));
    });
  }

  it('without an exchange rate cost per order, return and profit say «محتاج سعر صرف» and the original spend shows', async () => {
    const { http, fixture, el } = await setup(CampaignPageComponent);
    fixture.detectChanges();
    load(http, {
      results: { needsRate: true, costPerOrder: null, returnOnSpend: null, profitAfterAds: null, spend: 0, meta: meta({ spend: 0, originalSpend: 30, originalCurrency: 'USD', needsRate: true, cpc: null, cpm: null }) },
      meta: state({ currency: 'USD', needsRate: true }),
    });
    fixture.detectChanges();
    const text = kpiText(el);
    expect(text).toContain('30 USD');
    expect(text.match(/marketing\.meta\.needsRateShort/g)!.length).toBeGreaterThanOrEqual(5); // cost per order, return, cpc, cpm, profit after ads
    expect(el.querySelector('[data-test="meta-banner-rate"]')).not.toBeNull();
  });

  it('a campaign never linked and with Meta never connected looks exactly like 7A (spend, no Meta section)', async () => {
    const { http, fixture, el } = await setup(CampaignPageComponent);
    fixture.detectChanges();
    load(http, { results: { meta: undefined, recordedSpend: undefined, spend: 40 }, meta: undefined });
    fixture.detectChanges();
    expect(kpiText(el)).toContain('marketing.kpi.spend');
    expect(kpiText(el)).not.toContain('marketing.kpi.metaSpend');
    expect(el.querySelector('[data-test="meta-section"]')).toBeNull();
    expect(el.querySelector('[data-test="meta-no-double"]')).toBeNull();
  });

  it('linking is for Facebook/Instagram campaigns with marketing.manage only', async () => {
    const view = await setup(CampaignPageComponent, { permissions: ['marketing.view'] });
    view.fixture.detectChanges();
    load(view.http);
    view.fixture.detectChanges();
    expect(view.el.querySelector('[data-action="link-facebook"]')).toBeNull();
    TestBed.resetTestingModule();
    const tiktok = await setup(CampaignPageComponent);
    tiktok.fixture.detectChanges();
    tiktok.http.expectOne((r) => r.url === `${api}campaigns/c1`).flush(campaign({ platform: 'tiktok' }));
    tiktok.http.expectOne((r) => r.url === `${api}campaigns/c1/results`).flush({ range: { from: '', to: '' }, includeProfit: false, campaign: { campaignId: 'c1', ...campaign({ platform: 'tiktok' }), ...row() }, daily: [], meta: state() });
    tiktok.http.expectOne((r) => r.url === `${api}campaigns/c1/spend`).flush({ range: { from: '', to: '' }, total: 0, data: [] });
    tiktok.http.expectOne((r) => r.url === `${api}campaigns/c1/meta-links`).flush({ data: [] });
    tiktok.fixture.detectChanges();
    expect(tiktok.el.querySelector('[data-action="link-facebook"]')).toBeNull();
    expect(tiktok.el.querySelector('[data-test="meta-section"]')).toBeNull();
  });
});

describe('campaigns list with Meta', () => {
  it('shows the sync banner and «محتاج سعر صرف» instead of a return that cannot be computed', async () => {
    const { http, fixture, el } = await setup(CampaignsComponent);
    fixture.detectChanges();
    http.expectOne((r) => r.url === `${api}campaigns`).flush({
      range: { from: '', to: '' }, meta: state({ lastError: { code: 'TOKEN_INVALID', message: 'm', at: 'x' } }),
      data: [{ ...campaign(), kpis: row({ needsRate: true, returnOnSpend: null }) }],
    });
    fixture.detectChanges();
    expect(el.querySelector('[data-test="meta-banner-error"]')).not.toBeNull();
    expect(el.querySelector('[data-test="needs-rate"]')).not.toBeNull();
  });
});

describe('results with Meta numbers', () => {
  const linked = { campaignId: 'c1', name: 'حملة رمضان', code: 'ram123', platform: 'facebook', type: 'paid', status: 'active', ...row({ spend: 170.5, recordedSpend: 40, meta: meta(), grossProfit: 350, profitAfterAds: 179.5 }) };
  const plain = { campaignId: 'c2', name: 'عادية', code: 'plain1', platform: 'instagram', type: 'paid', status: 'active', ...row({ spend: 25 }) };
  const results = (over = {}) => ({
    range: { from: '2026-10-22', to: '2026-11-20' }, includeProfit: true,
    meta: state({ unlinked: [{ metaId: '9', name: 'حملة مش مربوطة', status: 'ACTIVE', spend: 7, originalSpend: 7, originalCurrency: 'EGP', needsRate: false, impressions: 10, linkClicks: 1 }], unlinkedSpend: 7 }),
    totals: row({ spend: 195.5, recordedSpend: 65, meta: meta(), grossProfit: 400, profitAfterAds: 204.5 }),
    campaigns: [linked, plain], platforms: [{ platform: 'facebook', ...row({ spend: 170.5, meta: meta(), recordedSpend: 40 }) }], direct: row({ spend: 0 }), heardFrom: [],
    daily: [{ day: '2026-11-19', visits: 5, orders: 2, sales: 100, metaSpend: 120 }, { day: '2026-11-20', visits: 3, orders: 1, sales: 50, metaSpend: 50.5 }], ...over,
  });

  it('desktop: new columns, «من ميتا» mark, recorded payments apart, unlinked list, Meta bar in the chart', async () => {
    const { http, fixture, el } = await setup(MarketingResultsComponent);
    fixture.detectChanges();
    http.expectOne((r) => r.url === `${api}campaigns/results`).flush(results());
    fixture.detectChanges();
    const section = el.querySelector('[data-section="campaigns"]')!;
    const head = section.querySelector('thead')!.textContent!;
    for (const key of ['recordedSpend', 'impressions', 'reach', 'linkClicks', 'ctr', 'cpc', 'cpm']) expect(head).toContain(`marketing.kpi.${key}`);
    const rows = Array.from(section.querySelectorAll('[data-test="result-row"]'));
    expect(rows[0].querySelector('[data-test="row-spend"]')!.textContent).toContain('170.5');
    expect(rows[0].querySelector('[data-test="meta-spend-mark"]')).not.toBeNull();
    expect(rows[0].querySelector('[data-test="recorded-spend"]')!.textContent).toContain('40');
    expect(rows[1].querySelector('[data-test="meta-spend-mark"]')).toBeNull();
    expect(rows[1].querySelector('[data-test="recorded-spend"]')!.textContent).toContain('—');
    expect(el.querySelectorAll('[data-test="meta-unlinked-row"]').length).toBe(1);
    expect(el.querySelector('[data-test="meta-unlinked"]')!.textContent).toContain('حملة مش مربوطة');
    expect(el.querySelectorAll('[data-test="meta-bar"]').length).toBe(2);
    expect(el.querySelector('[data-test="meta-banner-error"]')).toBeNull();
    http.verify();
  });

  it('desktop: without Meta nothing new appears (the 7A table, no Meta bar)', async () => {
    const { http, fixture, el } = await setup(MarketingResultsComponent);
    fixture.detectChanges();
    http.expectOne((r) => r.url === `${api}campaigns/results`).flush(results({ meta: undefined, totals: row(), campaigns: [plain], platforms: [], daily: [{ day: '2026-11-20', visits: 1, orders: 1, sales: 10 }] }));
    fixture.detectChanges();
    expect(el.querySelector('thead')!.textContent).not.toContain('marketing.kpi.impressions');
    expect(el.querySelector('[data-test="meta-bar"]')).toBeNull();
    expect(el.querySelector('[data-test="meta-unlinked"]')).toBeNull();
    expect(el.querySelector('[data-test="meta-banner-error"]')).toBeNull();
  });

  it('desktop: needs-rate rows say so instead of cost per order, return and profit; banners show', async () => {
    const { http, fixture, el } = await setup(MarketingResultsComponent);
    fixture.detectChanges();
    const needs = { ...linked, needsRate: true, costPerOrder: null, returnOnSpend: null, profitAfterAds: null, meta: meta({ needsRate: true, spend: 0, originalSpend: 30, originalCurrency: 'USD', cpc: null, cpm: null }) };
    http.expectOne((r) => r.url === `${api}campaigns/results`).flush(results({ campaigns: [needs], meta: state({ currency: 'USD', needsRate: true, timezoneNote: true, timezoneName: 'America/Los_Angeles' }) }));
    fixture.detectChanges();
    const cells = el.querySelector('[data-section="campaigns"] [data-test="result-row"]')!.textContent!;
    expect(cells.match(/marketing\.meta\.needsRateShort/g)!.length).toBe(3);
    expect(el.querySelector('[data-test="meta-banner-rate"]')).not.toBeNull();
    expect(el.querySelector('[data-test="meta-banner-timezone"]')).not.toBeNull();
  });

  it('phone: banners, Facebook spend with link clicks on the card, the unlinked list, the Meta bar', async () => {
    const { http, fixture, el } = await setup(MarketingResultsComponent, { mobile: true });
    fixture.detectChanges();
    http.expectOne((r) => r.url === `${api}campaigns/results`).flush(results({ meta: { ...results().meta, lastError: { code: 'NETWORK', message: 'm', at: 'x' } } }));
    fixture.detectChanges();
    expect(el.querySelector('[data-test="meta-banner-error"]')).not.toBeNull();
    const first = el.querySelector('[data-section="campaigns"] [data-test="result-row"]')!.textContent!;
    expect(first).toContain('marketing.kpi.metaSpend'); expect(first).toContain('170.5'); expect(first).toContain('marketing.kpi.linkClicks');
    expect(el.querySelectorAll('[data-test="meta-unlinked-row"]').length).toBe(1);
    expect(el.querySelectorAll('[data-test="meta-bar"]').length).toBe(2);
  });
});
