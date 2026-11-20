import { DecimalPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { NotaCanDirective } from '../../../core/auth/nota-can.directive';
import { LayoutService } from '../../../core/layout/layout.service';
import { localDateKey } from '../../../core/utilities/local-date';
import { NotaButtonDirective, NotaPageHeaderComponent } from '../../shared/ui';
import { CAMPAIGN_STATUSES, Campaign, PLATFORMS } from '../marketing.models';
import { MarketingService } from '../marketing.service';

const daysAgo = (days: number): string => {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return localDateKey(date);
};

/** Online Stage 7A: /marketing/campaigns. Campaigns with status chips, a platform filter, a date range and the KPIs of each row. */
@Component({
  selector: 'app-campaigns',
  imports: [FormsModule, RouterLink, DecimalPipe, TranslatePipe, NotaCanDirective, NotaButtonDirective, NotaPageHeaderComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
@if (layout.isMobile()) {
    <div class="m-page">
      <div class="m-chips" role="group" [attr.aria-label]="'marketing.campaigns.status' | translate">
        <button type="button" class="m-chip" [class.m-chip--on]="!status()" (click)="setStatus('')">{{ 'marketing.campaigns.all' | translate }}</button>
        @for (s of statuses; track s) { <button type="button" class="m-chip" [class.m-chip--on]="status() === s" [attr.data-status]="s" (click)="setStatus(s)">{{ 'marketing.status.' + s | translate }}</button> }
      </div>
      <div class="m-chips" role="group" [attr.aria-label]="'marketing.campaigns.platform' | translate">
        <button type="button" class="m-chip" [class.m-chip--on]="!platform()" (click)="setPlatform('')">{{ 'marketing.campaigns.all' | translate }}</button>
        @for (p of platforms; track p) { <button type="button" class="m-chip" [class.m-chip--on]="platform() === p" [attr.data-platform]="p" (click)="setPlatform(p)">{{ 'marketing.platform.' + p | translate }}</button> }
      </div>
      <div style="display:flex;gap:8px">
        <input class="m-input nota-num" style="flex:1;min-width:0" type="date" name="fromM" data-test="range-from" [ngModel]="from()" (ngModelChange)="setRange($event, to())" />
        <input class="m-input nota-num" style="flex:1;min-width:0" type="date" name="toM" data-test="range-to" [ngModel]="to()" (ngModelChange)="setRange(from(), $event)" />
      </div>
      @if (loadError()) { <p class="nota-error m-note" role="alert">{{ 'marketing.loadFailed' | translate }}</p> }
      <div class="m-card m-card--flush">
        @for (c of rows(); track c._id) {
          <a class="m-row" data-test="campaign-row" [routerLink]="['/marketing/campaigns', c._id]">
            <span class="m-row__body">
              <span class="m-row__title" style="display:block" dir="auto">{{ c.name }}</span>
              <span class="m-row__sub" style="display:block">{{ 'marketing.platform.' + c.platform | translate }} · {{ 'marketing.type.' + c.type | translate }}
                @if (c.kpis) { · {{ 'marketing.kpi.orders' | translate }} {{ c.kpis.ordersCompleted }} · {{ 'marketing.kpi.sales' | translate }} {{ c.kpis.sales | number: '1.0-2' }} }</span>
            </span>
            <span [class]="c.status === 'active' ? 'm-pill m-pill--ok' : 'm-pill m-pill--muted'">{{ 'marketing.status.' + c.status | translate }}</span>
          </a>
        } @empty {
          @if (!loading()) { <div class="m-empty">{{ 'marketing.campaigns.empty' | translate }}</div> }
        }
      </div>
      <a *notaCan="'marketing.manage'" class="m-fab" data-action="new-campaign" routerLink="/marketing/campaigns/new">+ {{ 'marketing.campaigns.new' | translate }}</a>
    </div>
} @else {
    <div class="cmp">
      <nota-page-header [title]="'marketing.campaigns.title' | translate" [subtitle]="'marketing.campaigns.subtitle' | translate">
        <div notaPageActions>
          <a routerLink="/marketing/results" notaButton>{{ 'marketing.results.title' | translate }}</a>
          <a *notaCan="'marketing.manage'" routerLink="/marketing/campaigns/new" notaButton="primary" data-action="new-campaign">{{ 'marketing.campaigns.new' | translate }}</a>
        </div>
      </nota-page-header>
      <div class="cmp__filters">
        <label>{{ 'marketing.campaigns.status' | translate }}
          <select class="nota-select" name="status" data-test="filter-status" [ngModel]="status()" (ngModelChange)="setStatus($event)">
            <option value="">{{ 'marketing.campaigns.all' | translate }}</option>
            @for (s of statuses; track s) { <option [value]="s">{{ 'marketing.status.' + s | translate }}</option> }
          </select>
        </label>
        <label>{{ 'marketing.campaigns.platform' | translate }}
          <select class="nota-select" name="platform" data-test="filter-platform" [ngModel]="platform()" (ngModelChange)="setPlatform($event)">
            <option value="">{{ 'marketing.campaigns.all' | translate }}</option>
            @for (p of platforms; track p) { <option [value]="p">{{ 'marketing.platform.' + p | translate }}</option> }
          </select>
        </label>
        <label>{{ 'marketing.range.from' | translate }}
          <input class="nota-input nota-num" type="date" name="from" data-test="range-from" [ngModel]="from()" (ngModelChange)="setRange($event, to())" />
        </label>
        <label>{{ 'marketing.range.to' | translate }}
          <input class="nota-input nota-num" type="date" name="to" data-test="range-to" [ngModel]="to()" (ngModelChange)="setRange(from(), $event)" />
        </label>
      </div>
      @if (loadError()) { <div class="cmp__alert" role="alert">{{ 'marketing.loadFailed' | translate }}</div> }
      <div class="nota-table-wrap">
        <table class="nota-table" data-test="campaigns-table">
          <thead><tr>
            <th>{{ 'marketing.campaigns.name' | translate }}</th><th>{{ 'marketing.campaigns.platform' | translate }}</th><th>{{ 'marketing.campaigns.status' | translate }}</th>
            <th class="nota-num">{{ 'marketing.kpi.visits' | translate }}</th><th class="nota-num">{{ 'marketing.kpi.orders' | translate }}</th>
            <th class="nota-num">{{ 'marketing.kpi.sales' | translate }}</th><th class="nota-num">{{ 'marketing.kpi.spend' | translate }}</th><th class="nota-num">{{ 'marketing.kpi.returnOnSpend' | translate }}</th>
          </tr></thead>
          <tbody>
            @for (c of rows(); track c._id) {
              <tr data-test="campaign-row">
                <td><a [routerLink]="['/marketing/campaigns', c._id]" dir="auto">{{ c.name }}</a><small class="cmp__code nota-num"> {{ c.code }}</small></td>
                <td>{{ 'marketing.platform.' + c.platform | translate }} · {{ 'marketing.type.' + c.type | translate }}</td>
                <td><span class="nota-pill" [class.nota-pill--ok]="c.status === 'active'">{{ 'marketing.status.' + c.status | translate }}</span></td>
                <td class="nota-num">{{ c.kpis?.visits ?? 0 }}</td>
                <td class="nota-num">{{ c.kpis?.ordersCompleted ?? 0 }}</td>
                <td class="nota-num">{{ c.kpis?.sales ?? 0 | number: '1.0-2' }}</td>
                <td class="nota-num">{{ c.kpis?.spend ?? 0 | number: '1.0-2' }}</td>
                <td class="nota-num">{{ c.kpis?.returnOnSpend ?? '—' }}</td>
              </tr>
            } @empty {
              @if (!loading()) { <tr><td colspan="8" class="cmp__empty">{{ 'marketing.campaigns.empty' | translate }}</td></tr> }
            }
          </tbody>
        </table>
      </div>
    </div>
}
  `,
  styles: [`
    .cmp { display: flex; flex-direction: column; gap: 16px; }
    .cmp__filters { display: flex; flex-wrap: wrap; gap: 12px; align-items: end; }
    .cmp__filters label { display: flex; flex-direction: column; gap: 4px; font-size: 13px; }
    .cmp__code { color: var(--text-muted, #6b7280); }
    .cmp__empty { text-align: center; padding: 24px; }
    .cmp__alert { color: var(--danger, #b91c1c); }
  `],
})
export class CampaignsComponent implements OnInit {
  protected readonly layout = inject(LayoutService);
  private readonly marketing = inject(MarketingService);
  protected readonly statuses = CAMPAIGN_STATUSES;
  protected readonly platforms = PLATFORMS;

  protected readonly rows = signal<Campaign[]>([]);
  protected readonly loading = signal(true);
  protected readonly loadError = signal(false);
  protected readonly status = signal('');
  protected readonly platform = signal('');
  protected readonly from = signal(daysAgo(29));
  protected readonly to = signal(localDateKey());

  ngOnInit(): void { this.load(); }

  protected setStatus(value: string): void { this.status.set(value); this.load(); }
  protected setPlatform(value: string): void { this.platform.set(value); this.load(); }
  protected setRange(from: string, to: string): void {
    this.from.set(from); this.to.set(to);
    if (from && to && from <= to) this.load();
  }

  private load(): void {
    this.loading.set(true);
    this.loadError.set(false);
    this.marketing.campaigns({ status: this.status(), platform: this.platform(), from: this.from(), to: this.to() }).subscribe({
      next: (response) => { this.rows.set(response.data); this.loading.set(false); },
      error: () => { this.loadError.set(true); this.loading.set(false); },
    });
  }
}
