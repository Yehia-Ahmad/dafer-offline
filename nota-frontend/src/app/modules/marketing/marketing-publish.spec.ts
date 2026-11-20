import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import ar from '../../../assets/i18n/ar.json';
import en from '../../../assets/i18n/en.json';
import { environment } from '../../../environments/environment';
import { signInWith } from '../../core/auth/testing/sign-in';
import { LayoutService } from '../../core/layout/layout.service';
import { BACKEND_AUDIT_ACTIONS } from '../../help/generated/audit-actions';
import { provideFakeVat } from '../shop-profile/services/vat-settings.testing';
import { CampaignPageComponent } from './campaigns/campaign-page.component';
import { MetaCreatedListComponent } from './campaigns/meta-created-list.component';
import { MetaPublishWizardComponent, PUBLISH_ERROR_CODES } from './campaigns/meta-publish-wizard.component';
import { MarketingSettingsComponent } from './marketing-settings.component';
import { MetaConnectionComponent } from './meta-connection/meta-connection.component';

// Online Stage 7C: the wizard, the confirmation of «تشغيل», the list of campaigns Nota created, the ceiling and the card's mode and pickers.
const api = environment.api_base_url;
const phone = { provide: LayoutService, useValue: { isMobile: signal(true) } };
const PUBLISH = ['marketing.view', 'marketing.manage', 'marketing.connect', 'marketing.publish'];

const connection = (over = {}) => ({
  connected: true, adAccountId: 'act_1234567890', tokenLast4: 'mnop', hasAppSecret: false, appSecretLast4: null,
  account: { name: 'حساب المحل', currency: 'EGP', timezoneName: 'Africa/Cairo', accountStatus: 1 }, accountStatusWarning: false,
  scopes: ['ads_read', 'ads_management', 'pages_manage_ads', 'pages_read_engagement', 'pages_show_list'],
  connectedAt: '2026-11-20T00:00:00Z', lastSyncAt: null, lastSyncOkAt: null, lastError: null, paused: false, syncing: false, nextManualSyncAt: null,
  mode: 'readwrite', missingPublishScopes: [], currencySupportedForPublish: true, page: null, instagram: null, ...over,
});
const options = (over = {}) => ({
  ready: true, blockers: [], mode: 'readwrite', currency: 'EGP', timezoneName: 'Africa/Cairo', page: { id: '555', name: 'صفحة المحل' }, instagram: null,
  ceiling: { dailyEgp: 1000, totalEgp: 10000 }, rate: null, needsRate: false, minDailyBudgetMinor: null,
  pixel: { configured: false, visible: false, lastFiredTime: null }, salesAllowed: false, ctas: ['SHOP_NOW', 'ORDER_NOW', 'LEARN_MORE', 'CONTACT_US', 'GET_OFFER'], ...over,
});
const view = (over = {}) => ({ publishId: 'abc123abc123', campaignId: 'c1', status: 'draft', goal: 'traffic', steps: {}, metaCampaignId: null, ads: [], lastError: null, publishedAt: null, ...over });
const created = (over = {}) => ({ metaId: '900', name: 'حملة · ram123 [nota:abc]', status: 'PAUSED', objective: 'OUTCOME_TRAFFIC', campaignId: 'c1', linkedAt: 'x', suggested: false, createdByNota: true, dailyBudgetMinor: 30000, lifetimeBudgetMinor: null, endTime: null, ...over });

async function setup<T>(component: new (...args: never[]) => T, { permissions = PUBLISH, mobile = true } = {}) {
  await TestBed.configureTestingModule({
    imports: [component, TranslateModule.forRoot()],
    providers: [
      provideHttpClient(), provideHttpClientTesting(), provideNoopAnimations(), provideRouter([]), provideFakeVat(),
      ...(mobile ? [phone] : []),
      { provide: ActivatedRoute, useValue: { snapshot: { paramMap: convertToParamMap({ id: 'c1' }), queryParamMap: convertToParamMap({}) } } },
    ],
  }).compileComponents();
  signInWith(permissions);
  const http = TestBed.inject(HttpTestingController);
  const fixture = TestBed.createComponent(component);
  return { http, fixture, el: fixture.nativeElement as HTMLElement, c: fixture.componentInstance as any };
}
const q = (selector: string) => document.body.querySelector(selector) as HTMLElement | null;
const click = (selector: string) => (q(selector) as HTMLElement).click();
const typeInto = (selector: string, value: string) => {
  const input = q(selector) as HTMLInputElement;
  input.value = value;
  input.dispatchEvent(new Event('input'));
};

describe('«حملة فيسبوك جديدة» wizard (Online Stage 7C)', () => {
  const open = async (opts = options()) => {
    const ctx = await setup(MetaPublishWizardComponent);
    ctx.fixture.componentRef.setInput('campaignId', 'c1');
    ctx.fixture.componentRef.setInput('visible', true);
    ctx.fixture.detectChanges();
    ctx.http.expectOne((r) => r.url === `${api}campaigns/c1/publish/options`).flush(opts);
    ctx.fixture.detectChanges();
    await ctx.fixture.whenStable();
    ctx.fixture.detectChanges(); // ngModel applies [disabled] after a tick
    return ctx;
  };
  const next = (ctx: { fixture: { detectChanges(): void } }) => { click('[data-action="wizard-next"]'); ctx.fixture.detectChanges(); };

  it('when something is missing it shows every blocker with its fixed message and offers no wizard', async () => {
    const { c } = await open(options({ ready: false, blockers: [{ code: 'PUBLISH_PERMISSION_MISSING', missing: ['pages_manage_ads'] }, { code: 'PAGE_REQUIRED' }] }));
    expect(q('[data-test="publish-blockers"]')).not.toBeNull();
    expect(document.body.querySelectorAll('[data-test="publish-blocker"]').length).toBe(2);
    expect(q('[data-test="publish-blockers"]')!.textContent).toContain('pages_manage_ads');
    expect(q('[data-test="publish-steps"]')).toBeNull();
    expect(c.options().ready).toBeFalse();
  });

  it('the sales goal is unavailable without a visible pixel; the daily budget shows its ceiling and over it the next button is off; the draft body is what the owner entered', async () => {
    const ctx = await open();
    const { http, fixture } = ctx;
    // 1. goal
    expect((q('[data-test="goal-sales"]') as HTMLInputElement).disabled).toBeTrue();
    expect(q('[data-test="sales-unavailable"]')).not.toBeNull();
    next(ctx);
    // 2. budget: the ceiling is shown next to the field, over it the next button is disabled
    expect(q('[data-test="ceiling-hint"]')!.textContent).toContain('marketing.publish.budget.ceilingDaily');
    const nextBtn = () => q('[data-action="wizard-next"]') as HTMLButtonElement;
    expect(nextBtn().disabled).toBeTrue();
    typeInto('[data-test="budget-amount"]', '1500'); fixture.detectChanges();
    expect(q('[data-test="over-ceiling"]')).not.toBeNull();
    expect(nextBtn().disabled).toBeTrue();
    typeInto('[data-test="budget-amount"]', '300'); fixture.detectChanges();
    expect(q('[data-test="over-ceiling"]')).toBeNull();
    expect(nextBtn().disabled).toBeFalse();
    next(ctx);
    // 3. audience: Advantage+ on by default (min age only)
    await fixture.whenStable(); fixture.detectChanges(); // ngModel writes its value after a tick
    expect((q('[data-test="advantage"]') as HTMLInputElement).checked).toBeTrue();
    expect(q('[data-test="age-min-advantage"]')).not.toBeNull();
    expect(q('[data-test="age-max"]')).toBeNull();
    next(ctx);
    // 4. ads: the text is required
    expect(nextBtn().disabled).toBeTrue();
    const c = ctx.c;
    c.patchAd(0, { primaryText: 'عرض الجمعة', headline: 'اشتري دلوقتي', uploadData: 'AAAA', imageKind: 'upload' });
    fixture.detectChanges();
    expect(nextBtn().disabled).toBeFalse();
    next(ctx);
    const draft = http.expectOne((r) => r.url === `${api}campaigns/c1/publish` && r.method === 'POST');
    expect(draft.request.body).toEqual({
      goal: 'traffic', budget: { type: 'daily', amount: 300 }, audience: { advantage: true, ageMin: 18, locations: [] },
      ads: [{ primaryText: 'عرض الجمعة', headline: 'اشتري دلوقتي', description: '', cta: 'SHOP_NOW', image: { kind: 'upload', data: 'AAAA' }, landing: { kind: 'campaign' } }],
    });
    draft.flush({ ...view(), warnings: ['إعلان 1: الصورة أقل من 1080×1080 وممكن تطلع أقل وضوح'] }, { status: 201, statusText: 'Created' });
    fixture.detectChanges();
    // 5. review: warnings, the paused note and the payment note
    expect(q('[data-test="step-review"]')).not.toBeNull();
    expect(document.body.querySelectorAll('[data-test="publish-warning"]').length).toBe(1);
    expect(q('[data-test="paused-note"]')).not.toBeNull();
    expect(q('[data-action="preview-feed"]')).not.toBeNull();
  });

  it('a failed step shows which step failed with the fixed message; «حاول تاني» continues and «إلغاء» cancels; success is paused', async () => {
    const ctx = await open();
    const { http, fixture, c } = ctx;
    c.draft.set(view()); c.step.set(5); fixture.detectChanges();
    click('[data-action="wizard-publish"]');
    fixture.detectChanges();
    const run = () => http.expectOne((r) => r.url === `${api}campaigns/c1/publish/abc123abc123/run` && r.method === 'POST');
    run().flush(view({ status: 'failed', metaCampaignId: '900', steps: { validate: { state: 'done' }, campaign: { state: 'done' }, adset: { state: 'failed', errorCode: 'BUDGET_TOO_LOW', errorMessage: 'x' } }, lastError: { step: 'adset', code: 'BUDGET_TOO_LOW', message: 'الميزانية أقل من الحد الأدنى اللي ميتا بتقبله. زوّدها.' } }));
    fixture.detectChanges();
    expect(q('[data-test="publish-failed"]')!.textContent).toContain('الميزانية أقل من الحد الأدنى');
    expect(q('[data-step="adset"]')!.getAttribute('data-state')).toBe('failed');
    expect(q('[data-step="campaign"]')!.getAttribute('data-state')).toBe('done');
    expect(q('[data-action="publish-retry"]')).not.toBeNull();
    expect(q('[data-action="publish-cancel"]')).not.toBeNull();

    click('[data-action="publish-retry"]'); fixture.detectChanges();
    run().flush(view({ status: 'published', metaCampaignId: '900', steps: { link: { state: 'done' } } }));
    fixture.detectChanges();
    expect(q('[data-test="publish-done"]')).not.toBeNull();
    expect(q('[data-action="publish-retry"]')).toBeNull();

    // cancel path
    c.publishView.set(view({ status: 'failed', lastError: { step: 'ads', code: 'META_ERROR', message: 'm' } })); fixture.detectChanges();
    click('[data-action="publish-cancel"]'); fixture.detectChanges();
    http.expectOne((r) => r.url === `${api}campaigns/c1/publish/abc123abc123/cancel` && r.method === 'POST').flush(view({ status: 'cancelled' }));
    fixture.detectChanges();
    expect(q('[data-test="publish-cancelled"]')).not.toBeNull();
  });

  it('every code the publish screens can show has an Arabic and an English text', () => {
    const errors = (tree: unknown) => ((tree as { marketing: { publish: { errors: Record<string, string> } } }).marketing.publish.errors);
    for (const code of [...PUBLISH_ERROR_CODES, 'CONFIRM_REQUIRED', 'CAMPAIGN_CLOSED', 'NOT_CREATED_BY_NOTA', 'INVALID_STATUS']) {
      expect(errors(ar)[code]).withContext(`ar ${code}`).toBeTruthy();
      expect(errors(en)[code]).withContext(`en ${code}`).toBeTruthy();
    }
    for (const code of ['meta.publish.created', 'meta.publish.cancelled', 'meta.campaign.status', 'meta.campaign.budget', 'meta.campaign.end_time', 'meta.campaign.archived', 'meta.publish_target']) {
      expect(BACKEND_AUDIT_ACTIONS as readonly string[]).withContext(code).toContain(code);
      expect(JSON.stringify(ar)).withContext(`ar ${code}`).toContain(`"${code}"`);
      expect(JSON.stringify(en)).withContext(`en ${code}`).toContain(`"${code}"`);
    }
  });
});

describe('campaigns Nota created: «تشغيل» confirmation and actions (Online Stage 7C)', () => {
  const load = async (rows = [created()], permissions = PUBLISH) => {
    const ctx = await setup(MetaCreatedListComponent, { permissions });
    ctx.fixture.componentRef.setInput('campaignId', 'c1');
    ctx.fixture.componentRef.setInput('rows', rows);
    ctx.fixture.detectChanges();
    ctx.http.expectOne((r) => r.url === `${api}campaigns/c1/publish/options`).flush(options());
    ctx.fixture.detectChanges();
    await ctx.fixture.whenStable();
    return ctx;
  };

  it('«تشغيل» opens a confirmation with the money in words and numbers; the button stays disabled until the box is ticked; then it sends confirmSpend', async () => {
    const { http, fixture, el } = await load();
    (el.querySelector('[data-action="meta-switch-on"]') as HTMLElement).click(); fixture.detectChanges();
    const text = el.querySelector('[data-test="switch-on-text"]')!.textContent!;
    expect(text).toContain('هيتصرف لحد 300 جنيه في اليوم من بطاقة حساب الإعلانات');
    const yes = () => el.querySelector('[data-action="switch-on-yes"]') as HTMLButtonElement;
    expect(yes().disabled).toBeTrue();
    // clicking a disabled button does nothing
    yes().click();
    http.expectNone((r) => r.url.endsWith('/status'));
    const box = el.querySelector('[data-test="switch-on-understand"]') as HTMLInputElement;
    box.click(); fixture.detectChanges();
    expect(yes().disabled).toBeFalse();
    box.click(); fixture.detectChanges();
    expect(yes().disabled).toBeTrue();
    box.click(); fixture.detectChanges();
    yes().click();
    const post = http.expectOne((r) => r.url === `${api}campaigns/c1/meta-links/900/status`);
    expect(post.request.body).toEqual({ status: 'ACTIVE', confirmSpend: true });
    post.flush({ status: 'ACTIVE', summary: { type: 'daily', amountMinor: 30000, currency: 'EGP', endTime: null } });
    fixture.detectChanges();
    expect(el.querySelector('[data-test="switch-on-confirm"]')).toBeNull();
  });

  it('a total budget says the total and the end date', async () => {
    const { fixture, el } = await load([created({ dailyBudgetMinor: null, lifetimeBudgetMinor: 200000, endTime: '2026-12-10T10:00:00.000Z' })]);
    (el.querySelector('[data-action="meta-switch-on"]') as HTMLElement).click(); fixture.detectChanges();
    const text = el.querySelector('[data-test="switch-on-text"]')!.textContent!;
    expect(text).toContain('2000'); expect(text).toContain('إجمالًا'); expect(text).toContain('10/12/2026');
  });

  it('an active campaign offers «إيقاف» (no confirmation); budget and end date edits and archive call their endpoints; archived campaigns offer nothing', async () => {
    const { http, fixture, el } = await load([created({ status: 'ACTIVE' }), created({ metaId: '901', status: 'ARCHIVED' })]);
    const rows = Array.from(el.querySelectorAll('[data-test="meta-created-row"]'));
    expect(rows[1].querySelector('[data-action="meta-switch-on"]')).toBeNull();
    expect(rows[1].querySelector('[data-action="meta-archive"]')).toBeNull();
    (rows[0].querySelector('[data-action="meta-pause"]') as HTMLElement).click();
    const pause = http.expectOne((r) => r.url === `${api}campaigns/c1/meta-links/900/status`);
    expect(pause.request.body).toEqual({ status: 'PAUSED' });
    pause.flush({ status: 'PAUSED', summary: null });
    fixture.detectChanges();
  });

  it('budget, end date and archive', async () => {
    const { http, fixture, el, c } = await load();
    (el.querySelector('[data-action="meta-edit-budget"]') as HTMLElement).click(); fixture.detectChanges();
    expect(el.querySelector('[data-test="manage-ceiling"]')!.textContent).toContain('marketing.publish.budget.ceilingDaily');
    c.editValue.set(450); fixture.detectChanges();
    (el.querySelector('[data-action="meta-edit-save"]') as HTMLElement).click();
    const budget = http.expectOne((r) => r.url === `${api}campaigns/c1/meta-links/900/budget`);
    expect(budget.request.body).toEqual({ amount: 450 });
    budget.flush({ type: 'daily', oldMinor: 30000, newMinor: 45000 });
    fixture.detectChanges();

    (el.querySelector('[data-action="meta-edit-end"]') as HTMLElement).click(); fixture.detectChanges();
    c.editValue.set('2026-12-20T22:00'); fixture.detectChanges();
    (el.querySelector('[data-action="meta-edit-save"]') as HTMLElement).click();
    const end = http.expectOne((r) => r.url === `${api}campaigns/c1/meta-links/900/end-time`);
    expect(end.request.body).toEqual({ endTime: '2026-12-20T22:00' });
    end.flush({ newEndTime: '2026-12-20T20:00:00.000Z' });
    fixture.detectChanges();

    (el.querySelector('[data-action="meta-archive"]') as HTMLElement).click(); fixture.detectChanges();
    expect(el.querySelector('[data-test="archive-confirm"]')).not.toBeNull();
    (el.querySelector('[data-action="meta-archive-yes"]') as HTMLElement).click();
    http.expectOne((r) => r.url === `${api}campaigns/c1/meta-links/900/archive`).flush({ status: 'ARCHIVED' });
  });

  it('a refused ceiling or an unconfirmed switch shows the fixed message', async () => {
    const { http, fixture, el, c } = await load();
    c.askSwitchOn(created()); c.understood.set(true); fixture.detectChanges();
    c.confirmSwitchOn(created());
    http.expectOne((r) => r.url === `${api}campaigns/c1/meta-links/900/status`).flush({ code: 'BUDGET_OVER_CEILING', message: 'x' }, { status: 409, statusText: 'Conflict' });
    fixture.detectChanges();
    expect(el.querySelector('[data-test="meta-manage-error"]')).not.toBeNull();
    expect(c.error()).toBe('marketing.publish.errors.BUDGET_OVER_CEILING');
  });

  it('without marketing.publish the actions are hidden (read-only)', async () => {
    const { el } = await load([created()], ['marketing.view', 'marketing.manage']);
    expect(el.querySelector('[data-action="meta-switch-on"]')).toBeNull();
    expect(el.querySelector('[data-action="meta-archive"]')).toBeNull();
    expect(el.querySelector('[data-test="meta-created-row"]')).not.toBeNull();
  });
});

describe('campaign page (Online Stage 7C)', () => {
  const campaign = { _id: 'c1', name: 'حملة', code: 'ram123', platform: 'facebook', type: 'paid', landing: { kind: 'home' }, startDate: '2026-11-01T00:00:00.000Z', status: 'active', fullLink: 'https://shop.test/?utm_campaign=ram123', shortLink: 'https://shop.test/go/ram123', codeEditable: true };
  const loadPage = async (permissions: string[], links: object[]) => {
    const ctx = await setup(CampaignPageComponent, { permissions, mobile: false });
    ctx.fixture.detectChanges();
    ctx.http.expectOne((r) => r.url === `${api}campaigns/c1`).flush(campaign);
    ctx.http.expectOne((r) => r.url === `${api}campaigns/c1/results`).flush({ range: { from: '', to: '' }, includeProfit: false, daily: [], campaign: null, meta: { connected: true, currency: 'EGP', needsRate: false, unlinked: [] } });
    ctx.http.expectOne((r) => r.url === `${api}campaigns/c1/spend`).flush({ range: { from: '', to: '' }, total: 0, data: [] });
    ctx.http.expectOne((r) => r.url === `${api}campaigns/c1/meta-links`).flush({ data: links });
    ctx.fixture.detectChanges();
    await ctx.fixture.whenStable();
    return ctx;
  };

  it('the owner sees the new-campaign button and the Nota-created list; a campaign synced from Meta stays read-only (no switch, no budget)', async () => {
    const { http, fixture, el } = await loadPage(PUBLISH, [created(), { metaId: '1', name: 'من Ads Manager', status: 'ACTIVE', objective: '', campaignId: 'c1', linkedAt: 'x', suggested: false }]);
    http.match((r) => r.url === `${api}campaigns/c1/publish/options`).forEach((r) => r.flush(options()));
    fixture.detectChanges();
    expect(el.querySelector('[data-action="new-facebook-campaign"]')).not.toBeNull();
    expect(el.querySelectorAll('[data-test="meta-created-row"]').length).toBe(1);
    expect(el.querySelectorAll('[data-test="meta-linked-row"]').length).toBe(1);
    expect(el.querySelector('[data-test="meta-linked-row"] [data-action="meta-switch-on"]')).toBeNull();
  });

  it('a manager (no marketing.publish) has no new-campaign button', async () => {
    const { http, fixture, el } = await loadPage(['marketing.view', 'marketing.manage'], [{ metaId: '1', name: 'x', status: 'ACTIVE', objective: '', campaignId: 'c1', linkedAt: 'x', suggested: false }]);
    http.expectNone((r) => r.url === `${api}campaigns/c1/publish/options`);
    fixture.detectChanges();
    expect(el.querySelector('[data-action="new-facebook-campaign"]')).toBeNull();
    expect(el.querySelector('[data-action="link-facebook"]')).not.toBeNull();
  });
});

describe('connection card mode and pickers, and the ceiling setting (Online Stage 7C)', () => {
  const loadCard = async (v: object, permissions = PUBLISH) => {
    const ctx = await setup(MetaConnectionComponent, { permissions });
    ctx.fixture.detectChanges();
    ctx.http.expectOne((r) => r.url === `${api}website/meta-connection` && r.method === 'GET').flush(v);
    ctx.http.match((r) => r.url === `${api}website/exchange-rates`).forEach((r) => r.flush({ currency: 'EGP', required: false, data: [], groups: [] }));
    return ctx;
  };

  it('«قراءة بس» says what is missing; no pickers', async () => {
    const { http, fixture, el } = await loadCard(connection({ mode: 'read', scopes: ['ads_read'], missingPublishScopes: ['ads_management', 'pages_manage_ads'] }));
    fixture.detectChanges();
    expect(el.querySelector('[data-test="meta-mode-value"]')!.getAttribute('data-mode')).toBe('read');
    expect(el.querySelector('[data-test="meta-mode-missing"]')!.textContent).toContain('pages_manage_ads');
    expect(el.querySelector('[data-test="meta-target"]')).toBeNull();
    http.expectNone((r) => r.url.includes('meta-connection/pages'));
  });

  it('«قراءة ونشر» lists the Pages from Meta, picks one with its Instagram account and saves the target', async () => {
    const { http, fixture, el } = await loadCard(connection());
    http.expectOne((r) => r.url === `${api}website/meta-connection/pages`).flush({ data: [{ id: '555', name: 'صفحة المحل' }] });
    http.expectOne((r) => r.url === `${api}website/meta-connection/instagram-accounts`).flush({ data: [] });
    fixture.detectChanges();
    expect(el.querySelector('[data-test="meta-mode-value"]')!.getAttribute('data-mode')).toBe('readwrite');
    const save = () => el.querySelector('[data-action="meta-save-target"]') as HTMLButtonElement;
    expect(save().disabled).toBeTrue();
    const select = el.querySelector('[data-test="meta-page"]') as HTMLSelectElement;
    select.value = '555'; select.dispatchEvent(new Event('change'));
    http.expectOne((r) => r.url === `${api}website/meta-connection/instagram-accounts` && r.params.get('pageId') === '555').flush({ data: [{ id: '777', name: 'shop_eg' }] });
    fixture.detectChanges();
    expect(save().disabled).toBeFalse();
    const insta = el.querySelector('[data-test="meta-instagram"]') as HTMLSelectElement;
    insta.value = '777'; insta.dispatchEvent(new Event('change'));
    save().click();
    const put = http.expectOne((r) => r.url === `${api}website/meta-connection/publish-target` && r.method === 'PUT');
    expect(put.request.body).toEqual({ pageId: '555', instagramId: '777' });
    put.flush(connection({ page: { id: '555', name: 'صفحة المحل' }, instagram: { id: '777', name: 'shop_eg' } }));
  });

  it('the ceiling fields are read-only without marketing.publish and are only sent with it', async () => {
    const settings = { metaPixelId: '', tiktokPixelId: '', requireConsent: true, attributionDays: 7, askHeardFrom: true, heardFromOptions: [], maxDailyBudgetEgp: 1000, maxTotalBudgetEgp: 10000, feeds: { meta: 'a', tiktok: 'b' } };
    for (const [permissions, canEdit] of [[['marketing.view', 'marketing.manage'], false], [PUBLISH, true]] as const) {
      TestBed.resetTestingModule();
      const { http, fixture, el, c } = await setup(MarketingSettingsComponent, { permissions: [...permissions] });
      fixture.detectChanges();
      http.expectOne((r) => r.url === `${api}website/marketing-settings` && r.method === 'GET').flush(settings);
      http.match((r) => r.url.includes('meta-connection') || r.url.includes('exchange-rates')).forEach((r) => r.flush(connection({ connected: false, mode: 'read' })));
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();
      expect((el.querySelector('[data-test="max-daily"]') as HTMLInputElement).disabled).toBe(!canEdit);
      expect(el.querySelector('[data-test="ceiling-readonly"]') !== null).toBe(!canEdit);
      if (canEdit) {
        c.maxDaily.set(500); c.save();
        const put = http.expectOne((r) => r.url === `${api}website/marketing-settings` && r.method === 'PUT');
        expect(put.request.body.maxDailyBudgetEgp).toBe(500);
        expect(put.request.body.maxTotalBudgetEgp).toBe(10000);
        put.flush({ ...settings, maxDailyBudgetEgp: 500 });
      }
    }
  });
});
