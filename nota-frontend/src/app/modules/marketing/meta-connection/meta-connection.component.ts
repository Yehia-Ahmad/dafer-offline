import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslatePipe } from '@ngx-translate/core';
import { LayoutService } from '../../../core/layout/layout.service';
import { localDateKey } from '../../../core/utilities/local-date';
import { ExchangeRateRow, MetaConnectionView, MetaTestResult } from '../marketing.models';
import { MarketingService } from '../marketing.service';
import { META_ERROR_CODES } from '../meta-banners.component';

const FORM_ERRORS = [...META_ERROR_CODES, 'INVALID_ACCOUNT_ID', 'INVALID_TOKEN', 'INVALID_APP_SECRET', 'SYNC_TOO_SOON', 'SYNC_RUNNING', 'NOT_CONNECTED', 'RATE_NOT_NEEDED', 'INVALID_RATE', 'INVALID_DATE', 'PAGE_NOT_ALLOWED', 'INSTAGRAM_NOT_FOUND'];
const OK_STATUSES = [1, 9];

/**
 * Online Stage 7B: «ربط حساب إعلانات فيسبوك» in the website settings «التسويق» tab (owner only: marketing.connect).
 * The token and app secret are typed once and sent to the server; they are never shown again, only their last 4 characters.
 * Nothing here writes to Meta: Nota only reads spend, impressions, reach and clicks. Saving is only possible after a successful test.
 */
@Component({
  selector: 'app-meta-connection',
  imports: [FormsModule, DatePipe, TranslatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section [class]="card()" data-test="meta-connection">
      <h2 class="mc__h">{{ 'marketing.meta.title' | translate }}</h2>
      <p class="mc__muted">{{ 'marketing.meta.intro' | translate }}</p>

      @if (view(); as v) {
        @if (v.connected) {
          <div class="mc__box" data-test="meta-connected">
            <strong>{{ v.account?.name }}</strong>
            <span class="nota-num" dir="ltr">{{ v.adAccountId }}</span>
            <span>{{ 'marketing.meta.currency' | translate }}: <b class="nota-num">{{ v.account?.currency }}</b> · {{ 'marketing.meta.timezone' | translate }}: <b dir="ltr">{{ v.account?.timezoneName }}</b></span>
            <span>{{ 'marketing.meta.tokenEnding' | translate }}: <b class="nota-num" dir="ltr" data-test="token-last4">…{{ v.tokenLast4 }}</b>
              @if (v.hasAppSecret) { · {{ 'marketing.meta.appSecretEnding' | translate }}: <b class="nota-num" dir="ltr" data-test="secret-last4">…{{ v.appSecretLast4 }}</b> }</span>
            <span data-test="last-sync">{{ 'marketing.meta.lastSync' | translate }}: @if (v.lastSyncOkAt) { <b class="nota-num">{{ v.lastSyncOkAt | date: 'd/M HH:mm' }}</b> } @else { — }
              @if (v.syncing) { · {{ 'marketing.meta.syncing' | translate }} }</span>
          </div>
          <div class="mc__box" data-test="meta-mode">
            <span>{{ 'marketing.meta.mode.label' | translate }}: <b data-test="meta-mode-value" [attr.data-mode]="v.mode">{{ (v.mode === 'readwrite' ? 'marketing.meta.mode.readwrite' : 'marketing.meta.mode.read') | translate }}</b></span>
            @if (v.mode === 'read') {
              <small class="mc__muted" data-test="meta-mode-missing">{{ 'marketing.meta.mode.missing' | translate }}: <b dir="ltr">{{ v.missingPublishScopes.join(', ') }}</b>. {{ 'marketing.meta.mode.missingHelp' | translate }}</small>
            } @else if (!v.currencySupportedForPublish) {
              <small class="mc__warn" data-test="meta-mode-currency">{{ 'marketing.publish.errors.CURRENCY_NOT_SUPPORTED' | translate }}</small>
            }
          </div>
          @if (v.mode === 'readwrite') {
            <div class="mc__form" data-test="meta-target">
              <label class="mc__f">{{ 'marketing.meta.target.page' | translate }}
                <select [class]="input()" name="metaPage" data-test="meta-page" [ngModel]="pageId()" (ngModelChange)="pickPage($event)">
                  <option value="">{{ 'marketing.meta.target.choose' | translate }}</option>
                  @for (p of pages(); track p.id) { <option [value]="p.id">{{ p.name }}</option> }
                </select>
                @if (pagesLoaded() && !pages().length) { <small class="mc__warn" data-test="meta-no-pages">{{ 'marketing.meta.target.noPages' | translate }}</small> }
              </label>
              <label class="mc__f">{{ 'marketing.meta.target.instagram' | translate }}
                <select [class]="input()" name="metaInstagram" data-test="meta-instagram" [ngModel]="instagramId()" (ngModelChange)="instagramId.set($event)">
                  <option value="">{{ 'marketing.meta.target.none' | translate }}</option>
                  @for (i of instagramAccounts(); track i.id) { <option [value]="i.id">{{ i.name }}</option> }
                </select>
              </label>
              <div class="mc__actions"><button type="button" [class]="btnPrimary()" data-action="meta-save-target" [disabled]="busy() || !pageId()" (click)="saveTarget()">{{ 'marketing.meta.target.save' | translate }}</button></div>
            </div>
          }
          @if (v.lastError) { <p class="nota-error" role="alert" data-test="meta-last-error">{{ errorKey(v.lastError.code) | translate }}@if (v.paused) { {{ 'marketing.meta.paused' | translate }} }</p> }
          @if (v.accountStatusWarning) { <p class="mc__warn" data-test="meta-status-warning">{{ 'marketing.meta.banner.accountStatus' | translate }}</p> }
          <div class="mc__actions">
            <button type="button" [class]="btn()" data-action="meta-sync-now" [disabled]="busy() || v.syncing || !!v.nextManualSyncAt" (click)="syncNow()">{{ 'marketing.meta.syncNow' | translate }}</button>
            <button type="button" [class]="btn()" data-action="meta-disconnect" [disabled]="busy()" (click)="confirmDisconnect.set(true)">{{ 'marketing.meta.disconnect' | translate }}</button>
          </div>
          @if (v.nextManualSyncAt) { <p class="mc__muted" data-test="meta-sync-wait">{{ 'marketing.meta.syncWait' | translate }}</p> }
          @if (confirmDisconnect()) {
            <div class="mc__box" role="alertdialog" data-test="meta-disconnect-confirm">
              <p>{{ 'marketing.meta.disconnectConfirm' | translate }}</p>
              <div class="mc__actions">
                <button type="button" [class]="btn()" (click)="confirmDisconnect.set(false)">{{ 'mobile.common.cancel' | translate }}</button>
                <button type="button" [class]="btnPrimary()" data-action="meta-disconnect-yes" [disabled]="busy()" (click)="disconnect()">{{ 'marketing.meta.disconnect' | translate }}</button>
              </div>
            </div>
          }
          <h3 class="mc__h3">{{ 'marketing.meta.replaceTitle' | translate }}</h3>
        }

        <div class="mc__form">
          <label class="mc__f">{{ 'marketing.meta.accountId' | translate }}
            <input [class]="input() + ' nota-num'" dir="ltr" name="metaAccountId" data-test="meta-account-id" autocomplete="off" placeholder="act_1234567890" [ngModel]="accountId()" (ngModelChange)="edit(accountId, $event)" />
          </label>
          <label class="mc__f">{{ 'marketing.meta.token' | translate }}
            <input [class]="input() + ' nota-num'" dir="ltr" type="password" name="metaToken" data-test="meta-token" autocomplete="new-password" [ngModel]="token()" (ngModelChange)="edit(token, $event)" />
            <small>{{ 'marketing.meta.tokenHint' | translate }}</small>
          </label>
          <label class="mc__f">{{ 'marketing.meta.appSecret' | translate }}
            <input [class]="input() + ' nota-num'" dir="ltr" type="password" name="metaAppSecret" data-test="meta-app-secret" autocomplete="new-password" [ngModel]="appSecret()" (ngModelChange)="edit(appSecret, $event)" />
            <small>{{ 'marketing.meta.appSecretHint' | translate }}</small>
          </label>
        </div>
        <p class="mc__muted">{{ 'marketing.meta.readOnlyNote' | translate }}</p>
        <p class="mc__muted">{{ 'marketing.meta.publishNote' | translate }}</p>

        @if (error()) { <p class="nota-error" role="alert" data-test="meta-error">{{ error() | translate }}</p> }
        @if (tested(); as t) {
          <div class="mc__box" data-test="meta-test-result" [class.mc__box--bad]="!t.ok">
            <strong>{{ t.account.name }}</strong>
            <span>{{ 'marketing.meta.currency' | translate }}: <b class="nota-num">{{ t.account.currency }}</b> · {{ 'marketing.meta.timezone' | translate }}: <b dir="ltr">{{ t.account.timezoneName }}</b></span>
            <span data-test="meta-test-status">{{ 'marketing.meta.accountStatus' | translate }}: {{ statusKey(t.account.accountStatus) | translate }}</span>
            <span data-test="meta-test-scopes">{{ 'marketing.meta.permissions' | translate }}: <b dir="ltr">{{ t.scopes.join(', ') || '—' }}</b></span>
            @if (!t.hasAdsRead) { <span class="nota-error" role="alert">{{ 'marketing.meta.errors.PERMISSION_MISSING' | translate }}</span> }
            @if (t.accountStatusWarning) { <span class="mc__warn">{{ 'marketing.meta.banner.accountStatus' | translate }}</span> }
            @if (t.account.currency && t.account.currency !== 'EGP') { <span class="mc__warn">{{ 'marketing.meta.rateNeeded' | translate: { currency: t.account.currency } }}</span> }
          </div>
        }
        @if (saved()) { <p class="mc__ok" role="status" data-test="meta-saved">{{ 'marketing.meta.saved' | translate }}</p> }
        <div class="mc__actions">
          <button type="button" [class]="btn()" data-action="meta-test" [disabled]="busy() || !canTest()" (click)="runTest()">{{ 'marketing.meta.test' | translate }}</button>
          <button type="button" [class]="btnPrimary()" data-action="meta-save" [disabled]="busy() || !canSave()" (click)="save()">{{ 'mobile.common.save' | translate }}</button>
        </div>
        <p class="mc__muted">{{ 'marketing.meta.saveNeedsTest' | translate }}</p>

        @if (v.connected && groups().length) {
          <h3 class="mc__h3">{{ 'marketing.meta.rates.title' | translate }}</h3>
          <p class="mc__muted">{{ 'marketing.meta.rates.hintMany' | translate }}</p>
          @for (g of groups(); track g.currency) {
            <div class="mc__rates" [attr.data-currency]="g.currency" data-test="rate-group">
              <strong>{{ g.currency }}{{ g.currency === v.account?.currency ? ' (' + ('marketing.meta.rates.current' | translate) + ')' : '' }}</strong>
              @for (r of g.data; track r._id) {
                <div class="mc__rate" data-test="rate-row">
                  <span class="nota-num">{{ r.effectiveFrom }}</span>
                  <strong class="nota-num" dir="ltr">1 {{ r.currency }} = {{ r.rate }} EGP</strong>
                  <button type="button" [class]="btn()" data-action="delete-rate" [disabled]="busy()" (click)="deleteRate(r)">{{ 'marketing.meta.rates.delete' | translate }}</button>
                </div>
              } @empty { <p class="mc__muted" data-test="rates-empty">{{ 'marketing.meta.rates.empty' | translate }}</p> }
            </div>
          }
          <div class="mc__form mc__form--row">
            @if (groups().length > 1) {
              <label class="mc__f">{{ 'marketing.meta.rates.currency' | translate }}
                <select [class]="input()" name="rateCurrency" data-test="rate-currency" [ngModel]="rateCurrency()" (ngModelChange)="rateCurrency.set($event)">
                  @for (g of groups(); track g.currency) { <option [value]="g.currency">{{ g.currency }}</option> }
                </select>
              </label>
            }
            <label class="mc__f">{{ 'marketing.meta.rates.rate' | translate }}
              <input [class]="input() + ' nota-num'" type="number" inputmode="decimal" min="0" step="0.0001" name="rateValue" data-test="rate-value" [ngModel]="rateValue()" (ngModelChange)="rateValue.set($event)" />
            </label>
            <label class="mc__f">{{ 'marketing.meta.rates.from' | translate }}
              <input [class]="input() + ' nota-num'" type="date" name="rateFrom" data-test="rate-from" [ngModel]="rateFrom()" (ngModelChange)="rateFrom.set($event)" />
            </label>
            <button type="button" [class]="btnPrimary()" data-action="save-rate" [disabled]="busy() || !(rateValue() && rateFrom())" (click)="saveRate()">{{ 'marketing.meta.rates.add' | translate }}</button>
          </div>
        }
      } @else if (loadError()) {
        <p class="nota-error" role="alert">{{ 'marketing.loadFailed' | translate }}</p>
      }
    </section>
  `,
  styles: [`
    :host { display: block; }
    .mc__h { font-size: 16px; margin: 0 0 8px; }
    .mc__h3 { font-size: 14px; margin: 16px 0 6px; }
    .mc__muted, .mc__f small { color: var(--text-muted, #6b7280); font-size: 12px; margin: 4px 0; }
    .mc__f { display: flex; flex-direction: column; gap: 4px; font-size: 13px; margin-bottom: 10px; }
    .mc__form--row { display: flex; flex-wrap: wrap; gap: 12px; align-items: end; }
    .mc__box { display: flex; flex-direction: column; gap: 4px; padding: 10px 12px; border-radius: 8px; background: var(--surface-muted, #f1f5f9); font-size: 13px; margin: 8px 0; }
    .mc__box--bad { background: #fee2e2; }
    .mc__actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 8px 0; }
    .mc__ok { color: var(--success, #15803d); margin: 0; }
    .mc__warn { color: #92400e; font-size: 12px; }
    .mc__rate { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; justify-content: space-between; padding: 4px 0; }
    .mc__box span, .mc__box strong { overflow-wrap: anywhere; }
  `],
})
export class MetaConnectionComponent implements OnInit, OnDestroy {
  private readonly marketing = inject(MarketingService);
  protected readonly layout = inject(LayoutService);

  protected readonly view = signal<MetaConnectionView | null>(null);
  protected readonly loadError = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly saved = signal(false);
  protected readonly tested = signal<MetaTestResult | null>(null);
  protected readonly confirmDisconnect = signal(false);
  /** One exchange-rate list per non-EGP currency in the synced numbers (a replaced ad account can leave days in another currency). */
  protected readonly groups = signal<{ currency: string; data: ExchangeRateRow[] }[]>([]);
  protected readonly rateCurrency = signal('');
  /** Online Stage 7C: the Page and Instagram account ads are published as (Meta's own lists). */
  protected readonly pages = signal<{ id: string; name: string }[]>([]);
  protected readonly pagesLoaded = signal(false);
  protected readonly instagramAccounts = signal<{ id: string; name: string }[]>([]);
  protected readonly pageId = signal('');
  protected readonly instagramId = signal('');

  protected readonly accountId = signal('');
  protected readonly token = signal('');
  protected readonly appSecret = signal('');
  protected readonly rateValue = signal<number | null>(null);
  protected readonly rateFrom = signal(localDateKey());

  protected readonly card = computed(() => (this.layout.isMobile() ? 'm-card' : 'nota-card'));
  protected readonly input = computed(() => (this.layout.isMobile() ? 'm-input' : 'nota-input'));
  protected readonly btn = computed(() => (this.layout.isMobile() ? 'm-btn' : 'nota-btn'));
  protected readonly btnPrimary = computed(() => (this.layout.isMobile() ? 'm-btn m-btn--primary' : 'nota-btn nota-btn--primary'));
  /** A test needs the account id and a token (or a saved one to re-test). */
  protected readonly canTest = computed(() => Boolean(this.accountId().trim()) && (Boolean(this.token().trim()) || Boolean(this.view()?.connected)));
  /** Saving is only allowed after a successful test of exactly what is typed now (any edit clears the test). */
  protected readonly canSave = computed(() => Boolean(this.tested()?.ok) && Boolean(this.token().trim()) && Boolean(this.accountId().trim()));

  private timer: ReturnType<typeof setTimeout> | null = null;
  private polls = 0;

  ngOnInit(): void { this.load(); }
  ngOnDestroy(): void { if (this.timer) clearTimeout(this.timer); }

  protected errorKey(code: string): string { return `marketing.meta.errors.${META_ERROR_CODES.includes(code) ? code : 'META_ERROR'}`; }
  protected statusKey(status: number): string { return OK_STATUSES.includes(status) ? 'marketing.meta.status.ok' : 'marketing.meta.status.notActive'; }

  protected edit(target: { set(value: string): void }, value: string): void {
    target.set(value);
    this.tested.set(null); this.saved.set(false); this.error.set('');
  }

  private load(): void {
    this.marketing.metaConnection().subscribe({
      next: (v) => { this.view.set(v); if (v.connected && !this.accountId()) this.accountId.set(v.adAccountId ?? ''); this.loadRates(v); this.loadTarget(v); this.pollWhileSyncing(v); },
      error: () => this.loadError.set(true),
    });
  }

  private loadTarget(v: MetaConnectionView): void {
    this.pageId.set(v.page?.id ?? ''); this.instagramId.set(v.instagram?.id ?? '');
    if (!v.connected || v.mode !== 'readwrite') { this.pages.set([]); this.instagramAccounts.set([]); this.pagesLoaded.set(false); return; }
    this.marketing.metaPages().subscribe({ next: (r) => { this.pages.set(r.data); this.pagesLoaded.set(true); }, error: () => { this.pages.set([]); this.pagesLoaded.set(true); } });
    this.loadInstagram(v.page?.id ?? '');
  }

  private loadInstagram(pageId: string): void {
    this.marketing.metaInstagram(pageId).subscribe({ next: (r) => this.instagramAccounts.set(r.data), error: () => this.instagramAccounts.set([]) });
  }

  protected pickPage(id: string): void {
    this.pageId.set(id); this.instagramId.set(''); this.error.set('');
    if (id) this.loadInstagram(id);
  }

  protected saveTarget(): void {
    if (this.busy() || !this.pageId()) return;
    this.busy.set(true); this.error.set('');
    this.marketing.saveMetaTarget({ pageId: this.pageId(), ...(this.instagramId() ? { instagramId: this.instagramId() } : {}) }).subscribe({
      next: (v) => { this.busy.set(false); this.view.set(v); this.saved.set(true); },
      error: (response) => this.fail(response),
    });
  }

  private loadRates(v: MetaConnectionView): void {
    if (!v.connected) { this.groups.set([]); return; }
    this.marketing.exchangeRates().subscribe({
      next: (r) => {
        const groups = r.groups ?? [];
        this.groups.set(groups);
        if (!groups.some((g) => g.currency === this.rateCurrency())) this.rateCurrency.set(groups.find((g) => g.currency === v.account?.currency)?.currency ?? groups[0]?.currency ?? '');
      },
      error: () => this.groups.set([]),
    });
  }

  // After connecting or «مزامنة دلوقتي» the sync runs on the server: look again a few times until it is done.
  private pollWhileSyncing(v: MetaConnectionView): void {
    if (this.timer) clearTimeout(this.timer);
    if (!v.syncing || this.polls >= 8) { this.polls = 0; return; }
    this.polls += 1;
    this.timer = setTimeout(() => this.load(), 2500);
  }

  private fail(response: { error?: { code?: string } }): void {
    this.busy.set(false);
    const code = response?.error?.code ?? '';
    this.error.set(FORM_ERRORS.includes(code) ? `marketing.meta.errors.${code}` : 'marketing.errors.GENERIC');
  }

  private payload() {
    return { adAccountId: this.accountId().trim(), ...(this.token().trim() ? { token: this.token().trim() } : {}), ...(this.appSecret().trim() ? { appSecret: this.appSecret().trim() } : {}) };
  }

  protected runTest(): void {
    if (this.busy() || !this.canTest()) return;
    this.busy.set(true); this.error.set(''); this.saved.set(false); this.tested.set(null);
    this.marketing.metaTest(this.payload()).subscribe({
      next: (result) => { this.busy.set(false); this.tested.set(result); },
      error: (response) => this.fail(response),
    });
  }

  protected save(): void {
    if (this.busy() || !this.canSave()) return;
    this.busy.set(true); this.error.set('');
    this.marketing.metaConnect(this.payload()).subscribe({
      next: (v) => {
        this.busy.set(false);
        // The secrets leave the page the moment they are saved.
        this.token.set(''); this.appSecret.set(''); this.tested.set(null); this.saved.set(true);
        this.view.set(v); this.loadRates(v); this.pollWhileSyncing(v);
      },
      error: (response) => this.fail(response),
    });
  }

  protected disconnect(): void {
    if (this.busy()) return;
    this.busy.set(true); this.error.set('');
    this.marketing.metaDisconnect().subscribe({
      next: (v) => { this.busy.set(false); this.confirmDisconnect.set(false); this.view.set(v); this.groups.set([]); this.token.set(''); this.appSecret.set(''); this.tested.set(null); this.saved.set(false); },
      error: (response) => { this.confirmDisconnect.set(false); this.fail(response); },
    });
  }

  protected syncNow(): void {
    if (this.busy()) return;
    this.busy.set(true); this.error.set('');
    this.marketing.metaSyncNow().subscribe({
      next: (v) => { this.busy.set(false); this.view.set(v); this.pollWhileSyncing(v); },
      error: (response) => this.fail(response),
    });
  }

  protected saveRate(): void {
    const rate = Number(this.rateValue());
    if (this.busy() || !(rate > 0) || !this.rateFrom()) return;
    this.busy.set(true); this.error.set('');
    this.marketing.saveExchangeRate({ currency: this.rateCurrency(), rate, effectiveFrom: this.rateFrom() }).subscribe({
      next: () => { this.busy.set(false); this.rateValue.set(null); this.load(); },
      error: (response) => this.fail(response),
    });
  }

  protected deleteRate(row: ExchangeRateRow): void {
    if (this.busy()) return;
    this.busy.set(true); this.error.set('');
    this.marketing.deleteExchangeRate(row._id).subscribe({
      next: () => { this.busy.set(false); this.load(); },
      error: (response) => this.fail(response),
    });
  }
}
