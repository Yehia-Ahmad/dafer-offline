import { DatePipe, DecimalPipe, NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { QRCodeComponent } from 'angularx-qrcode';
import { NotaCanDirective } from '../../../core/auth/nota-can.directive';
import { LayoutService } from '../../../core/layout/layout.service';
import { localDateKey } from '../../../core/utilities/local-date';
import { MobileTopBarService } from '../../mobile/mobile-topbar.service';
import { NotaButtonDirective, NotaKpiCardComponent, NotaPageHeaderComponent } from '../../shared/ui';
import { Campaign, CampaignResultsRow, MetaCampaignRow, MetaState, SpendRow } from '../marketing.models';
import { MarketingService } from '../marketing.service';
import { MetaBannersComponent } from '../meta-banners.component';
import { MetaLinkDialogComponent } from './meta-link-dialog.component';
import { SpendDialogComponent } from './spend-dialog.component';

const daysAgo = (days: number): string => {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return localDateKey(date);
};

interface Kpi { key: string; value: string | number; tone?: 'danger' | 'success' }

/** Online Stage 7A: /marketing/campaigns/:id. Links (copy + QR), the results of the campaign, its ad spend and its leads. */
@Component({
  selector: 'app-campaign-page',
  imports: [FormsModule, NgTemplateOutlet, RouterLink, DatePipe, DecimalPipe, TranslatePipe, QRCodeComponent, NotaCanDirective, NotaButtonDirective, NotaKpiCardComponent, NotaPageHeaderComponent, SpendDialogComponent, MetaBannersComponent, MetaLinkDialogComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ng-template #links>
      @if (campaign(); as c) {
        <div class="cp__link" data-test="full-link">
          <strong>{{ 'marketing.page.fullLink' | translate }}</strong>
          <code dir="ltr" class="cp__url">{{ c.fullLink }}</code>
          <button type="button" [class]="btn()" data-action="copy-full" (click)="copy('full', c.fullLink)">{{ (copied() === 'full' ? 'marketing.page.copied' : 'marketing.page.copy') | translate }}</button>
        </div>
        <div class="cp__link" data-test="short-link">
          <strong>{{ 'marketing.page.shortLink' | translate }}</strong>
          <code dir="ltr" class="cp__url">{{ c.shortLink }}</code>
          <button type="button" [class]="btn()" data-action="copy-short" (click)="copy('short', c.shortLink)">{{ (copied() === 'short' ? 'marketing.page.copied' : 'marketing.page.copy') | translate }}</button>
        </div>
        <div class="cp__qr" data-test="qr">
          <qrcode [qrdata]="c.shortLink" [width]="168" errorCorrectionLevel="M" [margin]="2" [ariaLabel]="'marketing.page.qr' | translate" />
          <small>{{ 'marketing.page.qrHint' | translate }}</small>
        </div>
      }
    </ng-template>

    <ng-template #kpis>
      <div class="cp__range">
        <label>{{ 'marketing.range.from' | translate }}<input [class]="inputClass()" type="date" name="from" data-test="range-from" [ngModel]="from()" (ngModelChange)="setRange($event, to())" /></label>
        <label>{{ 'marketing.range.to' | translate }}<input [class]="inputClass()" type="date" name="to" data-test="range-to" [ngModel]="to()" (ngModelChange)="setRange(from(), $event)" /></label>
      </div>
      <app-meta-banners [meta]="metaState()" />
      <div class="cp__kpis" data-test="campaign-kpis">
        @for (k of kpiList(); track k.key) { <nota-kpi-card [label]="('marketing.kpi.' + k.key) | translate" [value]="k.value" /> }
      </div>
      @if (metaState()) { <p class="cp__muted" data-test="meta-no-double">{{ 'marketing.meta.noDouble' | translate }}</p> }
    </ng-template>

    <ng-template #metaLinks>
      @for (row of metaLinked(); track row.metaId) {
        <div class="cp__spend cp__meta" data-test="meta-linked-row">
          <span dir="auto">{{ row.name || row.metaId }}</span>
          <small>{{ row.status }}</small>
          <button *notaCan="'marketing.manage'" type="button" [class]="btn()" data-action="unlink-meta" (click)="unlink(row.metaId)">{{ 'marketing.meta.link.unlink' | translate }}</button>
        </div>
      } @empty { <p class="cp__muted" data-test="meta-links-empty">{{ 'marketing.meta.link.none' | translate }}</p> }
      @if (canLink()) {
        <div><button *notaCan="'marketing.manage'" type="button" [class]="layout.isMobile() ? 'm-btn m-btn--primary' : 'nota-btn nota-btn--primary'" data-action="link-facebook" (click)="linkOpen.set(true)">{{ 'marketing.meta.link.open' | translate }}</button></div>
      }
    </ng-template>

    <ng-template #spendList>
      @for (row of spendRows(); track row._id) {
        <div class="cp__spend" data-test="spend-row" [class.cp__spend--off]="row.status === 'cancelled'">
          <span class="nota-num">{{ row.date | date: 'd / M' }}</span>
          <span dir="auto">{{ row.note }}</span>
          <strong class="nota-num">{{ row.net | number: '1.0-2' }}</strong>
          @if (row.status === 'cancelled') { <span class="nota-pill nota-pill--overdue">{{ 'cashbox.expenses.cancelled' | translate }}</span> }
        </div>
      } @empty { <p class="cp__muted">{{ 'marketing.page.noSpend' | translate }}</p> }
      <p class="cp__muted" data-test="spend-total">{{ 'marketing.page.spendTotal' | translate }}: <strong class="nota-num">{{ spendTotal() | number: '1.0-2' }}</strong></p>
    </ng-template>

    @if (campaign(); as c) {
      @if (layout.isMobile()) {
        <div class="m-page">
          <div class="m-card">
            <span class="m-row__title" dir="auto">{{ c.name }}</span>
            <span class="m-row__sub" style="display:block">{{ 'marketing.platform.' + c.platform | translate }} · {{ 'marketing.type.' + c.type | translate }} · <span [class]="c.status === 'active' ? 'm-pill m-pill--ok' : 'm-pill m-pill--muted'">{{ 'marketing.status.' + c.status | translate }}</span></span>
            <span class="m-row__sub nota-num" dir="ltr" style="display:block">{{ c.code }}</span>
          </div>
          <div class="m-card cp__stack"><ng-container *ngTemplateOutlet="links" /></div>
          <div class="m-section-label">{{ 'marketing.results.title' | translate }}</div>
          <div class="m-card cp__stack"><ng-container *ngTemplateOutlet="kpis" /></div>
          @if (showMetaSection()) {
            <div class="m-section-label">{{ 'marketing.meta.link.section' | translate }}</div>
            <div class="m-card cp__stack" data-test="meta-section"><ng-container *ngTemplateOutlet="metaLinks" /></div>
          }
          <div class="m-section-label">{{ 'marketing.page.recorded' | translate }}</div>
          <div class="m-card cp__stack"><ng-container *ngTemplateOutlet="spendList" />
            <button *notaCan="'expenses.create'" type="button" class="m-btn m-btn--primary" data-action="record-spend" (click)="spendOpen.set(true)">{{ 'marketing.spend.title' | translate }}</button>
          </div>
          <div class="m-actions">
            <a class="m-btn" data-action="open-leads" [routerLink]="['/marketing/leads']" [queryParams]="{ campaign: c._id }">{{ 'marketing.page.leads' | translate }}</a>
            <a *notaCan="'marketing.manage'" class="m-btn" data-action="edit-campaign" [routerLink]="['/marketing/campaigns', c._id, 'edit']">{{ 'marketing.page.edit' | translate }}</a>
          </div>
        </div>
      } @else {
        <div class="cp">
          <nota-page-header [title]="c.name" [subtitle]="('marketing.platform.' + c.platform | translate) + ' · ' + ('marketing.type.' + c.type | translate) + ' · ' + ('marketing.status.' + c.status | translate)">
            <div notaPageActions>
              <a notaButton data-action="open-leads" [routerLink]="['/marketing/leads']" [queryParams]="{ campaign: c._id }">{{ 'marketing.page.leads' | translate }}</a>
              <a *notaCan="'marketing.manage'" notaButton data-action="edit-campaign" [routerLink]="['/marketing/campaigns', c._id, 'edit']">{{ 'marketing.page.edit' | translate }}</a>
            </div>
          </nota-page-header>
          <section class="nota-card cp__stack"><h2 class="cp__h">{{ 'marketing.page.links' | translate }}</h2><ng-container *ngTemplateOutlet="links" /></section>
          <section class="nota-card cp__stack"><h2 class="cp__h">{{ 'marketing.results.title' | translate }}</h2><ng-container *ngTemplateOutlet="kpis" /></section>
          @if (showMetaSection()) {
            <section class="nota-card cp__stack" data-test="meta-section"><h2 class="cp__h">{{ 'marketing.meta.link.section' | translate }}</h2><ng-container *ngTemplateOutlet="metaLinks" /></section>
          }
          <section class="nota-card cp__stack">
            <h2 class="cp__h">{{ 'marketing.page.recorded' | translate }}</h2>
            <ng-container *ngTemplateOutlet="spendList" />
            <div><button *notaCan="'expenses.create'" type="button" notaButton="primary" data-action="record-spend" (click)="spendOpen.set(true)">{{ 'marketing.spend.title' | translate }}</button></div>
          </section>
        </div>
      }
      <app-spend-dialog [campaignId]="c._id" [campaignName]="c.name" [(visible)]="spendOpen" (saved)="reload()" />
      <app-meta-link-dialog [campaignId]="c._id" [(visible)]="linkOpen" (changed)="reload()" />
    } @else if (loadError()) {
      <p class="nota-error" role="alert">{{ 'marketing.loadFailed' | translate }}</p>
    }
  `,
  styles: [`
    .cp { display: flex; flex-direction: column; gap: 16px; }
    .cp__stack { display: flex; flex-direction: column; gap: 12px; }
    .cp__h { font-size: 16px; margin: 0; }
    .cp__link { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
    .cp__url { flex: 1 1 240px; overflow-wrap: anywhere; font-size: 12px; }
    .cp__qr { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; }
    .cp__range { display: flex; gap: 12px; flex-wrap: wrap; }
    .cp__range label { display: flex; flex-direction: column; gap: 4px; font-size: 13px; }
    .cp__kpis { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; }
    .cp__spend { display: grid; grid-template-columns: 70px 1fr auto auto; gap: 8px; align-items: center; }
    .cp__spend--off { opacity: .55; text-decoration: line-through; }
    .cp__muted { color: var(--text-muted, #6b7280); font-size: 13px; margin: 0; }
    .cp__meta { grid-template-columns: 1fr auto auto; }
  `],
})
export class CampaignPageComponent implements OnInit {
  protected readonly layout = inject(LayoutService);
  private readonly marketing = inject(MarketingService);
  private readonly route = inject(ActivatedRoute);
  private readonly translate = inject(TranslateService);

  protected readonly campaign = signal<Campaign | null>(null);
  protected readonly results = signal<CampaignResultsRow | null>(null);
  protected readonly spendRows = signal<SpendRow[]>([]);
  protected readonly spendTotal = signal(0);
  protected readonly loadError = signal(false);
  protected readonly copied = signal<'full' | 'short' | ''>('');
  protected readonly spendOpen = signal(false);
  protected readonly linkOpen = signal(false);
  protected readonly metaState = signal<MetaState | undefined>(undefined);
  protected readonly metaLinked = signal<MetaCampaignRow[]>([]);
  /** The Meta section shows for a Facebook/Instagram campaign once Meta was ever connected (or when it already has links). */
  protected readonly canLink = computed(() => ['facebook', 'instagram'].includes(this.campaign()?.platform ?? ''));
  protected readonly showMetaSection = computed(() => this.canLink() && (Boolean(this.metaState()) || this.metaLinked().length > 0));
  protected readonly from = signal(daysAgo(29));
  protected readonly to = signal(localDateKey());
  protected readonly btn = computed(() => (this.layout.isMobile() ? 'm-btn' : 'nota-btn'));
  protected readonly inputClass = computed(() => (this.layout.isMobile() ? 'm-input nota-num' : 'nota-input nota-num'));

  private readonly bindTopBar = inject(MobileTopBarService).bind(() => this.layout.isMobile() ? { title: this.campaign()?.name || this.translate.instant('marketing.campaigns.title') } : null);

  protected readonly kpiList = computed<Kpi[]>(() => {
    const r = this.results();
    if (!r) return [];
    const needsRate = this.translate.instant('marketing.meta.needsRateShort') as string;
    // Without an exchange rate for part of the Meta spend the server sends null: say why instead of a bare dash.
    const num = (v: number | null) => (v === null ? (r.needsRate ? needsRate : '—') : v);
    const out: Kpi[] = [
      { key: 'clicks', value: r.clicks }, { key: 'visits', value: r.visits === null ? '—' : r.visits }, { key: 'ordersPlaced', value: r.ordersPlaced }, { key: 'orders', value: r.ordersCompleted },
      { key: 'notCompleted', value: r.ordersCancelled + r.ordersRejected + r.ordersRefused }, { key: 'sales', value: r.sales }, { key: 'deliveryRevenue', value: r.deliveryRevenue },
      { key: 'conversionRate', value: r.conversionRate === null ? '—' : `${Math.round(r.conversionRate * 1000) / 10}%` }, { key: 'averageOrderValue', value: r.averageOrderValue === null ? '—' : r.averageOrderValue },
    ];
    // «صرف فيسبوك» is the spend used below for a campaign linked to Meta; the expenses recorded for it are shown apart, never added.
    if (r.meta) out.push({ key: 'metaSpend', value: r.needsRate ? `${r.meta.originalSpend} ${r.meta.originalCurrency}` : r.meta.spend }, { key: 'recordedSpend', value: r.recordedSpend ?? 0 });
    else out.push({ key: 'spend', value: r.spend });
    out.push({ key: 'costPerOrder', value: num(r.costPerOrder) }, { key: 'returnOnSpend', value: num(r.returnOnSpend) });
    if (r.meta) {
      const pct = (v: number | null) => (v === null ? '—' : `${Math.round(v * 10000) / 100}%`);
      out.push(
        { key: 'impressions', value: r.meta.impressions }, { key: 'reach', value: r.meta.reach }, { key: 'linkClicks', value: r.meta.linkClicks },
        { key: 'ctr', value: pct(r.meta.ctr) }, { key: 'cpc', value: r.meta.cpc ?? (r.needsRate ? needsRate : '—') }, { key: 'cpm', value: r.meta.cpm ?? (r.needsRate ? needsRate : '—') },
      );
    }
    // Only present with the cost/profit permission (the server leaves them out otherwise).
    if (r.grossProfit !== undefined) out.push({ key: 'grossProfit', value: r.grossProfit });
    if (r.profitAfterAds !== undefined || (r.needsRate && r.grossProfit !== undefined)) out.push({ key: 'profitAfterAds', value: r.profitAfterAds === undefined ? '—' : num(r.profitAfterAds) });
    return out;
  });

  ngOnInit(): void { this.reload(); }

  protected reload(): void {
    const id = this.route.snapshot.paramMap.get('id');
    if (!id) return;
    this.loadError.set(false);
    this.marketing.campaign(id).subscribe({ next: (c) => this.campaign.set(c), error: () => this.loadError.set(true) });
    this.loadNumbers(id);
    this.marketing.metaLinks(id).subscribe({ next: (r) => this.metaLinked.set(r.data), error: () => this.metaLinked.set([]) });
  }

  protected unlink(metaId: string): void {
    const id = this.route.snapshot.paramMap.get('id');
    if (id) this.marketing.unlinkMeta(id, metaId).subscribe({ next: () => this.reload() });
  }

  private loadNumbers(id: string): void {
    const range = { from: this.from(), to: this.to() };
    this.marketing.campaignResults(id, range).subscribe({ next: (r) => { this.results.set(r.campaign); this.metaState.set(r.meta); }, error: () => this.results.set(null) });
    this.marketing.spend(id, range).subscribe({ next: (r) => { this.spendRows.set(r.data); this.spendTotal.set(r.total); }, error: () => { this.spendRows.set([]); this.spendTotal.set(0); } });
  }

  protected setRange(from: string, to: string): void {
    this.from.set(from); this.to.set(to);
    const id = this.route.snapshot.paramMap.get('id');
    if (id && from && to && from <= to) this.loadNumbers(id);
  }

  protected async copy(which: 'full' | 'short', text: string): Promise<void> {
    try { await navigator.clipboard.writeText(text); } catch { /* the text stays selectable */ }
    this.copied.set(which);
    setTimeout(() => this.copied.set(''), 1800);
  }
}
