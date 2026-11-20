import { DecimalPipe, NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { LayoutService } from '../../../core/layout/layout.service';
import { localDateKey } from '../../../core/utilities/local-date';
import { NotaPageHeaderComponent } from '../../shared/ui';
import { ResultsRow, Results } from '../marketing.models';
import { MarketingService } from '../marketing.service';

const daysAgo = (days: number): string => {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return localDateKey(date);
};

interface Line { label: string; link?: string[]; row: ResultsRow }
interface Section { key: string; titleKey: string; lines: Line[] }

/** Online Stage 7A: /marketing/results. Every campaign, the platforms side by side, direct orders, "عرفتنا منين؟" and a daily chart. */
@Component({
  selector: 'app-marketing-results',
  imports: [FormsModule, NgTemplateOutlet, RouterLink, DecimalPipe, TranslatePipe, NotaPageHeaderComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ng-template #range>
      <div class="mr__range">
        <label>{{ 'marketing.range.from' | translate }}<input [class]="inputClass()" type="date" name="from" data-test="range-from" [ngModel]="from()" (ngModelChange)="setRange($event, to())" /></label>
        <label>{{ 'marketing.range.to' | translate }}<input [class]="inputClass()" type="date" name="to" data-test="range-to" [ngModel]="to()" (ngModelChange)="setRange(from(), $event)" /></label>
      </div>
    </ng-template>

    <ng-template #chart>
      @if (daily().length) {
        <div class="mr__chart" data-test="daily-chart" role="img" [attr.aria-label]="'marketing.results.daily' | translate">
          @for (d of daily(); track d.day) {
            <div class="mr__day" [attr.title]="d.day">
              <div class="mr__bars">
                <span class="mr__bar mr__bar--visits" [style.height.%]="pct(d.visits, maxVisits())"></span>
                <span class="mr__bar mr__bar--orders" [style.height.%]="pct(d.orders, maxOrders())"></span>
                <span class="mr__bar mr__bar--sales" [style.height.%]="pct(d.sales, maxSales())"></span>
              </div>
              <small class="nota-num">{{ d.day.slice(5) }}</small>
            </div>
          }
        </div>
        <p class="mr__legend"><span class="mr__dot mr__dot--visits"></span>{{ 'marketing.kpi.visits' | translate }} <span class="mr__dot mr__dot--orders"></span>{{ 'marketing.kpi.ordersPlaced' | translate }} <span class="mr__dot mr__dot--sales"></span>{{ 'marketing.kpi.sales' | translate }}</p>
      } @else { <p class="mr__muted">{{ 'marketing.results.empty' | translate }}</p> }
    </ng-template>

    @if (layout.isMobile()) {
      <div class="m-page">
        <div class="m-card"><ng-container *ngTemplateOutlet="range" /></div>
        @if (loadError()) { <p class="nota-error m-note" role="alert">{{ 'marketing.loadFailed' | translate }}</p> }
        @if (data(); as d) {
          <div class="m-card" data-test="totals">
            <span class="m-row__sub">{{ 'marketing.results.totals' | translate }}</span>
            <strong class="nota-num" style="font-size:22px;display:block">{{ d.totals.sales | number: '1.0-2' }}</strong>
            <span class="m-row__sub">{{ 'marketing.kpi.orders' | translate }} {{ d.totals.ordersCompleted }} / {{ d.totals.ordersPlaced }} · {{ 'marketing.kpi.spend' | translate }} {{ d.totals.spend | number: '1.0-2' }}
              @if (d.totals.grossProfit !== undefined) { · {{ 'marketing.kpi.grossProfit' | translate }} {{ d.totals.grossProfit | number: '1.0-2' }} }</span>
          </div>
          @for (section of sections(); track section.key) {
            <div class="m-section-label">{{ section.titleKey | translate }}</div>
            <div class="m-card m-card--flush" [attr.data-section]="section.key">
              @for (line of section.lines; track line.label) {
                <a class="m-row" [routerLink]="line.link ?? null" data-test="result-row">
                  <span class="m-row__body"><span class="m-row__title" dir="auto" style="display:block">{{ line.label }}</span>
                    <span class="m-row__sub" style="display:block">{{ 'marketing.kpi.orders' | translate }} {{ line.row.ordersCompleted }} · {{ 'marketing.kpi.spend' | translate }} {{ line.row.spend | number: '1.0-2' }}
                      @if (line.row.returnOnSpend !== null) { · {{ 'marketing.kpi.returnOnSpend' | translate }} {{ line.row.returnOnSpend }} }</span></span>
                  <strong class="nota-num">{{ line.row.sales | number: '1.0-2' }}</strong>
                </a>
              } @empty { <div class="m-empty">{{ 'marketing.results.empty' | translate }}</div> }
            </div>
          }
          <div class="m-section-label">{{ 'marketing.results.daily' | translate }}</div>
          <div class="m-card"><ng-container *ngTemplateOutlet="chart" /></div>
        }
      </div>
    } @else {
      <div class="mr">
        <nota-page-header [title]="'marketing.results.title' | translate" [subtitle]="'marketing.results.subtitle' | translate" />
        <section class="nota-card"><ng-container *ngTemplateOutlet="range" /></section>
        @if (loadError()) { <p class="nota-error" role="alert">{{ 'marketing.loadFailed' | translate }}</p> }
        @if (data(); as d) {
          @for (section of sections(); track section.key) {
            <section class="nota-card" [attr.data-section]="section.key">
              <h2 class="mr__h">{{ section.titleKey | translate }}</h2>
              <div class="nota-table-wrap">
                <table class="nota-table">
                  <thead><tr>
                    <th></th>
                    <th class="nota-num">{{ 'marketing.kpi.clicks' | translate }}</th><th class="nota-num">{{ 'marketing.kpi.visits' | translate }}</th>
                    <th class="nota-num">{{ 'marketing.kpi.ordersPlaced' | translate }}</th><th class="nota-num">{{ 'marketing.kpi.orders' | translate }}</th><th class="nota-num">{{ 'marketing.kpi.notCompleted' | translate }}</th>
                    <th class="nota-num">{{ 'marketing.kpi.sales' | translate }}</th>
                    @if (d.includeProfit) { <th class="nota-num">{{ 'marketing.kpi.grossProfit' | translate }}</th> }
                    <th class="nota-num">{{ 'marketing.kpi.conversionRate' | translate }}</th><th class="nota-num">{{ 'marketing.kpi.averageOrderValue' | translate }}</th>
                    <th class="nota-num">{{ 'marketing.kpi.spend' | translate }}</th><th class="nota-num">{{ 'marketing.kpi.costPerOrder' | translate }}</th><th class="nota-num">{{ 'marketing.kpi.returnOnSpend' | translate }}</th>
                    @if (d.includeProfit) { <th class="nota-num">{{ 'marketing.kpi.profitAfterAds' | translate }}</th> }
                  </tr></thead>
                  <tbody>
                    @for (line of section.lines; track line.label) {
                      <tr data-test="result-row">
                        <td>@if (line.link) { <a [routerLink]="line.link" dir="auto">{{ line.label }}</a> } @else { <span dir="auto">{{ line.label }}</span> }</td>
                        <td class="nota-num">{{ line.row.clicks }}</td><td class="nota-num">{{ line.row.visits ?? '—' }}</td>
                        <td class="nota-num">{{ line.row.ordersPlaced }}</td><td class="nota-num">{{ line.row.ordersCompleted }}</td>
                        <td class="nota-num">{{ line.row.ordersCancelled + line.row.ordersRejected + line.row.ordersRefused }}</td>
                        <td class="nota-num">{{ line.row.sales | number: '1.0-2' }}</td>
                        @if (d.includeProfit) { <td class="nota-num" data-test="gross-profit">{{ line.row.grossProfit | number: '1.0-2' }}</td> }
                        <td class="nota-num">{{ pctText(line.row.conversionRate) }}</td><td class="nota-num">{{ line.row.averageOrderValue ?? '—' }}</td>
                        <td class="nota-num">{{ line.row.spend | number: '1.0-2' }}</td><td class="nota-num">{{ line.row.costPerOrder ?? '—' }}</td><td class="nota-num">{{ line.row.returnOnSpend ?? '—' }}</td>
                        @if (d.includeProfit) { <td class="nota-num">{{ line.row.profitAfterAds | number: '1.0-2' }}</td> }
                      </tr>
                    } @empty { <tr><td colspan="14" class="mr__muted">{{ 'marketing.results.empty' | translate }}</td></tr> }
                  </tbody>
                </table>
              </div>
            </section>
          }
          <section class="nota-card"><h2 class="mr__h">{{ 'marketing.results.daily' | translate }}</h2><ng-container *ngTemplateOutlet="chart" /></section>
        }
      </div>
    }
  `,
  styles: [`
    .mr { display: flex; flex-direction: column; gap: 16px; }
    .mr__h { font-size: 16px; margin: 0 0 8px; }
    .mr__range { display: flex; gap: 12px; flex-wrap: wrap; }
    .mr__range label { display: flex; flex-direction: column; gap: 4px; font-size: 13px; }
    .mr__muted { color: var(--text-muted, #6b7280); }
    .mr__chart { display: flex; gap: 6px; align-items: flex-end; height: 140px; overflow-x: auto; }
    .mr__day { display: flex; flex-direction: column; align-items: center; gap: 4px; min-width: 34px; height: 100%; justify-content: flex-end; }
    .mr__bars { display: flex; gap: 2px; align-items: flex-end; height: 110px; }
    .mr__bar { width: 8px; min-height: 2px; border-radius: 2px; display: inline-block; }
    .mr__bar--visits, .mr__dot--visits { background: #94a3b8; }
    .mr__bar--orders, .mr__dot--orders { background: #0e7490; }
    .mr__bar--sales, .mr__dot--sales { background: #15803d; }
    .mr__dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-inline: 8px 4px; }
    .mr__legend { font-size: 12px; margin: 8px 0 0; }
  `],
})
export class MarketingResultsComponent implements OnInit {
  protected readonly layout = inject(LayoutService);
  private readonly marketing = inject(MarketingService);
  private readonly translate = inject(TranslateService);

  protected readonly data = signal<Results | null>(null);
  protected readonly loadError = signal(false);
  protected readonly from = signal(daysAgo(29));
  protected readonly to = signal(localDateKey());
  protected readonly inputClass = computed(() => (this.layout.isMobile() ? 'm-input nota-num' : 'nota-input nota-num'));
  protected readonly daily = computed(() => this.data()?.daily ?? []);
  protected readonly maxVisits = computed(() => Math.max(1, ...this.daily().map((d) => d.visits)));
  protected readonly maxOrders = computed(() => Math.max(1, ...this.daily().map((d) => d.orders)));
  protected readonly maxSales = computed(() => Math.max(1, ...this.daily().map((d) => d.sales)));

  protected readonly sections = computed<Section[]>(() => {
    const d = this.data();
    if (!d) return [];
    const t = (key: string): string => this.translate.instant(key);
    return [
      { key: 'campaigns', titleKey: 'marketing.results.byCampaign', lines: d.campaigns.map((c) => ({ label: c.name, link: ['/marketing/campaigns', c.campaignId], row: c })) },
      { key: 'platforms', titleKey: 'marketing.results.byPlatform', lines: d.platforms.map((p) => ({ label: t(`marketing.platform.${p.platform}`), row: p })) },
      { key: 'direct', titleKey: 'marketing.results.direct', lines: [{ label: t('marketing.results.directLabel'), row: d.direct }] },
      { key: 'heard', titleKey: 'marketing.results.byHeard', lines: d.heardFrom.map((h) => ({ label: h.answer || t('marketing.results.noAnswer'), row: h })) },
    ];
  });

  ngOnInit(): void { this.load(); }

  protected setRange(from: string, to: string): void {
    this.from.set(from); this.to.set(to);
    if (from && to && from <= to) this.load();
  }

  protected pct(value: number, max: number): number { return Math.round((value / max) * 100); }
  protected pctText(rate: number | null): string { return rate === null ? '—' : `${Math.round(rate * 1000) / 10}%`; }

  private load(): void {
    this.loadError.set(false);
    this.marketing.results({ from: this.from(), to: this.to() }).subscribe({ next: (d) => this.data.set(d), error: () => this.loadError.set(true) });
  }
}
