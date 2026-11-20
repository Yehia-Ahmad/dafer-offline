import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { NotaCanDirective } from '../../../core/auth/nota-can.directive';
import { LayoutService } from '../../../core/layout/layout.service';
import { NotaButtonDirective, NotaPageHeaderComponent } from '../../shared/ui';
import { Campaign, LEAD_SOURCES, LEAD_STATUSES, Lead } from '../marketing.models';
import { MarketingService } from '../marketing.service';

/** Online Stage 7A: /marketing/leads (العملاء المحتملين). Search by name or phone, chips by status and source, a campaign filter. */
@Component({
  selector: 'app-leads',
  imports: [FormsModule, NgTemplateOutlet, RouterLink, TranslatePipe, NotaCanDirective, NotaButtonDirective, NotaPageHeaderComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ng-template #filters>
      <div [class]="layout.isMobile() ? 'm-chips' : 'ld__chips'" role="group" [attr.aria-label]="'marketing.leads.status' | translate">
        <button type="button" [class]="chip(!status())" (click)="setStatus('')">{{ 'marketing.campaigns.all' | translate }}</button>
        @for (s of statuses; track s) { <button type="button" [class]="chip(status() === s)" [attr.data-status]="s" (click)="setStatus(s)">{{ 'marketing.leadStatus.' + s | translate }}</button> }
      </div>
      <div [class]="layout.isMobile() ? 'm-chips' : 'ld__chips'" role="group" [attr.aria-label]="'marketing.leads.source' | translate">
        <button type="button" [class]="chip(!source())" (click)="setSource('')">{{ 'marketing.campaigns.all' | translate }}</button>
        @for (s of sources; track s) { <button type="button" [class]="chip(source() === s)" [attr.data-source]="s" (click)="setSource(s)">{{ 'marketing.leadSource.' + s | translate }}</button> }
      </div>
      <select [class]="layout.isMobile() ? 'm-input' : 'nota-select'" name="campaign" data-test="filter-campaign" [ngModel]="campaign()" (ngModelChange)="setCampaign($event)">
        <option value="">{{ 'marketing.leads.allCampaigns' | translate }}</option>
        @for (c of campaigns(); track c._id) { <option [value]="c._id">{{ c.name }}</option> }
      </select>
    </ng-template>

    @if (layout.isMobile()) {
      <div class="m-page">
        <div class="m-search" style="display:flex;gap:8px">
          <input class="m-input" style="flex:1;min-width:0" type="search" data-test="lead-search" [placeholder]="'marketing.leads.search' | translate" [ngModel]="q()" (ngModelChange)="q.set($event)" (keyup.enter)="reload()" />
          <button type="button" class="m-btn" data-action="search" (click)="reload()">{{ 'marketing.leads.searchAction' | translate }}</button>
        </div>
        <ng-container *ngTemplateOutlet="filters" />
        @if (loadError()) { <p class="nota-error m-note" role="alert">{{ 'marketing.loadFailed' | translate }}</p> }
        <div class="m-card m-card--flush">
          @for (lead of rows(); track lead._id) {
            <a class="m-row" data-test="lead-row" [routerLink]="['/marketing/leads', lead._id]">
              <span class="m-avatar">{{ lead.name.charAt(0) || '؟' }}</span>
              <span class="m-row__body">
                <span class="m-row__title" dir="auto" style="display:block">{{ lead.name }}</span>
                <span class="m-row__sub nota-num" dir="ltr" style="display:block;text-align:start">{{ lead.phone || '—' }}</span>
                <span class="m-row__sub" style="display:block">{{ 'marketing.leadSource.' + lead.source | translate }}@if (lead.campaignName) { · {{ lead.campaignName }} }</span>
              </span>
              <span class="m-pill">{{ 'marketing.leadStatus.' + lead.status | translate }}</span>
            </a>
          } @empty { @if (!loading()) { <div class="m-empty">{{ 'marketing.leads.empty' | translate }}</div> } }
        </div>
        @if (totalPages() > 1) {
          <div class="m-actions" style="position:static;border:0;padding:0">
            <button type="button" class="m-btn" [disabled]="page() <= 1" (click)="go(page() - 1)">‹</button>
            <span class="m-row__sub nota-num" style="align-self:center;text-align:center;flex:1.4">{{ page() }} / {{ totalPages() }}</span>
            <button type="button" class="m-btn" [disabled]="page() >= totalPages()" (click)="go(page() + 1)">›</button>
          </div>
        }
        <a *notaCan="'leads.manage'" class="m-fab" data-action="new-lead" routerLink="/marketing/leads/new">+ {{ 'marketing.leads.new' | translate }}</a>
      </div>
    } @else {
      <div class="ld">
        <nota-page-header [title]="'marketing.leads.title' | translate" [subtitle]="'marketing.leads.subtitle' | translate">
          <div notaPageActions>
            <a *notaCan="'leads.manage'" routerLink="/marketing/leads/import" notaButton data-action="import-leads">{{ 'marketing.leads.import' | translate }}</a>
            <a *notaCan="'leads.manage'" routerLink="/marketing/leads/new" notaButton="primary" data-action="new-lead">{{ 'marketing.leads.new' | translate }}</a>
          </div>
        </nota-page-header>
        <div class="ld__bar">
          <input class="nota-input" type="search" data-test="lead-search" [placeholder]="'marketing.leads.search' | translate" [ngModel]="q()" (ngModelChange)="q.set($event)" (keyup.enter)="reload()" />
          <button type="button" notaButton data-action="search" (click)="reload()">{{ 'marketing.leads.searchAction' | translate }}</button>
          <ng-container *ngTemplateOutlet="filters" />
        </div>
        @if (loadError()) { <p class="nota-error" role="alert">{{ 'marketing.loadFailed' | translate }}</p> }
        <div class="nota-table-wrap">
          <table class="nota-table" data-test="leads-table">
            <thead><tr><th>{{ 'marketing.leads.name' | translate }}</th><th>{{ 'marketing.leads.phone' | translate }}</th><th>{{ 'marketing.leads.source' | translate }}</th><th>{{ 'marketing.leads.campaign' | translate }}</th><th>{{ 'marketing.leads.status' | translate }}</th></tr></thead>
            <tbody>
              @for (lead of rows(); track lead._id) {
                <tr data-test="lead-row">
                  <td><a [routerLink]="['/marketing/leads', lead._id]" dir="auto">{{ lead.name }}</a></td>
                  <td class="nota-num" dir="ltr">{{ lead.phone || '—' }}</td>
                  <td>{{ 'marketing.leadSource.' + lead.source | translate }}</td>
                  <td>{{ lead.campaignName || '—' }}</td>
                  <td><span class="nota-pill">{{ 'marketing.leadStatus.' + lead.status | translate }}</span></td>
                </tr>
              } @empty { @if (!loading()) { <tr><td colspan="5" class="ld__empty">{{ 'marketing.leads.empty' | translate }}</td></tr> } }
            </tbody>
          </table>
        </div>
        @if (totalPages() > 1) {
          <div class="ld__pager">
            <button type="button" notaButton [disabled]="page() <= 1" (click)="go(page() - 1)">‹</button>
            <span class="nota-num">{{ page() }} / {{ totalPages() }}</span>
            <button type="button" notaButton [disabled]="page() >= totalPages()" (click)="go(page() + 1)">›</button>
          </div>
        }
      </div>
    }
  `,
  styles: [`
    .ld { display: flex; flex-direction: column; gap: 16px; }
    .ld__bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .ld__chips { display: flex; flex-wrap: wrap; gap: 6px; }
    .ld__chip { border: 1px solid var(--border, #d1d5db); background: transparent; border-radius: 999px; padding: 4px 12px; cursor: pointer; font: inherit; font-size: 13px; }
    .ld__chip--on { background: var(--brand, #0e4d45); color: #fff; border-color: transparent; }
    .ld__empty { text-align: center; padding: 24px; }
    .ld__pager { display: flex; gap: 12px; align-items: center; justify-content: center; }
  `],
})
export class LeadsComponent implements OnInit {
  protected readonly layout = inject(LayoutService);
  private readonly marketing = inject(MarketingService);
  private readonly route = inject(ActivatedRoute);
  protected readonly statuses = LEAD_STATUSES;
  protected readonly sources = LEAD_SOURCES;

  protected readonly rows = signal<Lead[]>([]);
  protected readonly campaigns = signal<Campaign[]>([]);
  protected readonly loading = signal(true);
  protected readonly loadError = signal(false);
  protected readonly q = signal('');
  protected readonly status = signal('');
  protected readonly source = signal('');
  protected readonly campaign = signal('');
  protected readonly page = signal(1);
  protected readonly totalPages = signal(1);

  ngOnInit(): void {
    this.campaign.set(this.route.snapshot.queryParamMap.get('campaign') ?? '');
    this.marketing.campaigns().subscribe({ next: (r) => this.campaigns.set(r.data), error: () => this.campaigns.set([]) });
    this.reload();
  }

  protected chip(on: boolean): string { return this.layout.isMobile() ? `m-chip${on ? ' m-chip--on' : ''}` : `ld__chip${on ? ' ld__chip--on' : ''}`; }
  protected setStatus(value: string): void { this.status.set(value); this.reload(); }
  protected setSource(value: string): void { this.source.set(value); this.reload(); }
  protected setCampaign(value: string): void { this.campaign.set(value); this.reload(); }
  protected go(page: number): void { this.page.set(page); this.load(); }
  protected reload(): void { this.page.set(1); this.load(); }

  private load(): void {
    this.loading.set(true);
    this.loadError.set(false);
    this.marketing.leads({ search: this.q().trim(), status: this.status(), source: this.source(), campaign: this.campaign(), page: this.page() }).subscribe({
      next: (r) => { this.rows.set(r.data); this.totalPages.set(r.pagination.totalPages); this.loading.set(false); },
      error: () => { this.loadError.set(true); this.loading.set(false); },
    });
  }
}
