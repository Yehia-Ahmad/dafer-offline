import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { NotaCanDirective } from '../../core/auth/nota-can.directive';
import { NotaButtonDirective, NotaMoneyPipe, NotaPageHeaderComponent, NotaStatusPillComponent } from '../shared/ui';
import { Supplier, SuppliersService } from '../suppliers/suppliers.service';
import { Purchase, PurchaseFilters } from './purchases.models';
import { LayoutService } from '../../core/layout/layout.service';
import { FilterChip, MobFilterChipsComponent, MobFilterSheetComponent } from '../mobile/mob-sheet.component';
import { MobDatePipe, formatMobDate } from '../mobile/mob-date.pipe';
import { PurchasesService } from './purchases.service';

/** Stage 20: the purchases list. Number, supplier, supplier invoice no., date, total, paid, status; filters; click opens the detail. */
@Component({
  selector: 'app-purchases-page',
  standalone: true,
  imports: [DatePipe, FormsModule, RouterLink, TranslatePipe, NotaCanDirective, NotaButtonDirective, NotaMoneyPipe, NotaPageHeaderComponent, NotaStatusPillComponent, MobFilterChipsComponent, MobFilterSheetComponent, MobDatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
@if (layout.isMobile()) {
    <!-- Online Stage 6B (phone): the same list and filters. Cards instead of the table; the whole card opens the purchase; filters in a bottom sheet with removable chips. -->
    <form class="m-search" style="margin-top:12px;display:flex;gap:8px" (ngSubmit)="apply()">
      <input class="m-input" style="flex:1;min-width:0" type="search" name="search" data-test="search" [attr.aria-label]="'purchases.filters.search' | translate" [placeholder]="'purchases.filters.search' | translate" [(ngModel)]="search" />
      <button type="button" class="m-btn" (click)="filtersOpen.set(true)" data-testid="m-purchase-filters">{{ 'mobile.common.filters' | translate }}</button>
    </form>
    <nota-mob-filter-chips [chips]="activeChips()" (remove)="removeChip($event)" />
    <div class="m-page">
      @if (loading()) {
        <div class="m-skel m-skel-row" role="status" [attr.aria-label]="'purchases.loading' | translate"></div>
        <div class="m-skel m-skel-row"></div>
        <div class="m-skel m-skel-row"></div>
      } @else if (loadError()) {
        <div class="m-card m-empty"><span class="nota-error">{{ 'purchases.loadFailed' | translate }}</span> <button type="button" class="m-btn" (click)="load()">{{ 'purchases.retry' | translate }}</button></div>
      } @else {
        <div class="m-card m-card--flush">
          @for (row of rows(); track row._id) {
            <div class="m-row m-stretch-host" [attr.data-purchase]="row.number" [class.m-muted]="row.status === 'cancelled'">
              <a class="m-row__open m-stretch" [routerLink]="['/purchases', row._id]" data-action="open">
                <span class="m-row__title" style="display:block" dir="auto">{{ row.supplierName }}</span>
                <span class="m-row__sub nota-num" style="display:block"><span dir="ltr">{{ row.number }}</span> · {{ row.date | mobDate }}</span>
                @if (row.supplierInvoiceNo) { <span class="m-row__sub" style="display:block" dir="ltr">{{ row.supplierInvoiceNo }}</span> }
              </a>
              <span class="m-row__end">
                <span class="nota-num" style="display:block">{{ row.total | notaMoney }} {{ 'cashbox.currency' | translate }}</span>
                <span class="m-row__sub nota-num" style="display:block">{{ 'purchases.columns.paid' | translate }} {{ row.paidAmount | notaMoney }}</span>
                <span [class]="row.status === 'posted' ? 'm-pill m-pill--ok' : 'm-pill m-pill--warn'">{{ 'purchases.status.' + row.status | translate }}</span>
              </span>
            </div>
          } @empty {
            <div class="m-empty" data-test="empty">{{ 'purchases.empty' | translate }}</div>
          }
        </div>
        @if (totalPages() > 1) {
          <div class="m-actions" style="position:static;border:0;padding:0">
            <button type="button" class="m-btn" [disabled]="page() <= 1" data-action="prev" (click)="goto(page() - 1)">‹</button>
            <span class="m-row__sub nota-num" style="align-self:center;text-align:center;flex:1.4">{{ page() }} / {{ totalPages() }}</span>
            <button type="button" class="m-btn" [disabled]="page() >= totalPages()" data-action="next" (click)="goto(page() + 1)">›</button>
          </div>
        }
      }
    </div>
    <a *notaCan="'purchases.create'" class="m-fab" routerLink="/purchases/new" data-action="new-purchase">+ {{ 'purchases.newPurchase' | translate }}</a>
    <nota-mob-filter-sheet [(open)]="filtersOpen" [title]="'mobile.common.filters' | translate" (apply)="apply()" (clear)="clearFilters()">
      <label class="m-field">{{ 'purchases.filters.supplier' | translate }}
        <select class="m-input" name="supplierM" data-test="filter-supplier" [(ngModel)]="supplier">
          <option value="">{{ 'purchases.filters.allSuppliers' | translate }}</option>
          @for (row of suppliers(); track row._id) { <option [value]="row._id">{{ row.name }}</option> }
        </select>
      </label>
      <label class="m-field">{{ 'purchases.filters.from' | translate }}
        <input class="m-input" type="date" name="fromM" data-test="filter-from" [(ngModel)]="from" />
      </label>
      <label class="m-field">{{ 'purchases.filters.to' | translate }}
        <input class="m-input" type="date" name="toM" data-test="filter-to" [(ngModel)]="to" />
      </label>
      <label class="m-field">{{ 'purchases.filters.status' | translate }}
        <select class="m-input" name="statusM" data-test="filter-status" [(ngModel)]="status">
          <option value="">{{ 'purchases.filters.allStatuses' | translate }}</option>
          <option value="posted">{{ 'purchases.status.posted' | translate }}</option>
          <option value="cancelled">{{ 'purchases.status.cancelled' | translate }}</option>
        </select>
      </label>
    </nota-mob-filter-sheet>
} @else {

    <div class="pl">
      <nota-page-header [title]="'purchases.title' | translate" [subtitle]="'purchases.subtitle' | translate">
        <div notaPageActions>
          <a *notaCan="'purchases.create'" notaButton="primary" routerLink="/purchases/new" data-action="new-purchase">+ {{ 'purchases.newPurchase' | translate }}</a>
        </div>
      </nota-page-header>

      <form class="nota-card pl__filters" (ngSubmit)="apply()">
        <input class="nota-input" type="search" name="search" data-test="search" [attr.aria-label]="'purchases.filters.search' | translate" [placeholder]="'purchases.filters.search' | translate" [(ngModel)]="search" />
        <select class="nota-select" name="supplier" data-test="filter-supplier" [attr.aria-label]="'purchases.filters.supplier' | translate" [(ngModel)]="supplier">
          <option value="">{{ 'purchases.filters.allSuppliers' | translate }}</option>
          @for (row of suppliers(); track row._id) { <option [value]="row._id">{{ row.name }}</option> }
        </select>
        <input class="nota-input nota-num" type="date" name="from" data-test="filter-from" [attr.aria-label]="'purchases.filters.from' | translate" [(ngModel)]="from" />
        <input class="nota-input nota-num" type="date" name="to" data-test="filter-to" [attr.aria-label]="'purchases.filters.to' | translate" [(ngModel)]="to" />
        <select class="nota-select" name="status" data-test="filter-status" [attr.aria-label]="'purchases.filters.status' | translate" [(ngModel)]="status">
          <option value="">{{ 'purchases.filters.allStatuses' | translate }}</option>
          <option value="posted">{{ 'purchases.status.posted' | translate }}</option>
          <option value="cancelled">{{ 'purchases.status.cancelled' | translate }}</option>
        </select>
        <button type="submit" notaButton data-action="apply">{{ 'purchases.filters.apply' | translate }}</button>
      </form>

      <section class="nota-card">
        <div class="nota-table-wrap">
          <table class="nota-table">
            <thead><tr>
              <th>{{ 'purchases.columns.number' | translate }}</th>
              <th>{{ 'purchases.columns.supplier' | translate }}</th>
              <th>{{ 'purchases.columns.supplierInvoiceNo' | translate }}</th>
              <th>{{ 'purchases.columns.date' | translate }}</th>
              <th class="nota-num">{{ 'purchases.columns.total' | translate }}</th>
              <th class="nota-num">{{ 'purchases.columns.paid' | translate }}</th>
              <th>{{ 'purchases.columns.status' | translate }}</th>
            </tr></thead>
            <tbody>
              @if (loading()) {
                <tr><td colspan="7" class="pl__empty" role="status">{{ 'purchases.loading' | translate }}</td></tr>
              } @else if (loadError()) {
                <tr><td colspan="7" class="pl__empty"><span class="nota-error">{{ 'purchases.loadFailed' | translate }}</span> <button type="button" notaButton (click)="load()">{{ 'purchases.retry' | translate }}</button></td></tr>
              } @else {
                @for (row of rows(); track row._id) {
                  <tr [attr.data-purchase]="row.number" [class.pl__row--cancelled]="row.status === 'cancelled'">
                    <td><a [routerLink]="['/purchases', row._id]" data-action="open"><strong>{{ row.number }}</strong></a></td>
                    <td>{{ row.supplierName }}</td>
                    <td dir="ltr">{{ row.supplierInvoiceNo || '—' }}</td>
                    <td class="nota-num">{{ row.date | date: 'yyyy-MM-dd' }}</td>
                    <td class="nota-num">{{ row.total | notaMoney }}</td>
                    <td class="nota-num">{{ row.paidAmount | notaMoney }}</td>
                    <td><nota-status-pill [variant]="row.status === 'posted' ? 'ok' : 'overdue'">{{ 'purchases.status.' + row.status | translate }}</nota-status-pill></td>
                  </tr>
                } @empty {
                  <tr><td colspan="7" class="pl__empty" data-test="empty">{{ 'purchases.empty' | translate }}</td></tr>
                }
              }
            </tbody>
          </table>
        </div>
        @if (totalPages() > 1) {
          <div class="pl__pager">
            <button type="button" notaButton [disabled]="page() <= 1" data-action="prev" (click)="goto(page() - 1)">‹</button>
            <span class="nota-num">{{ page() }} / {{ totalPages() }}</span>
            <button type="button" notaButton [disabled]="page() >= totalPages()" data-action="next" (click)="goto(page() + 1)">›</button>
          </div>
        }
      </section>
    </div>
  }
  `,
  styles: `
    .pl { display: flex; flex-direction: column; gap: 16px; }
    .pl__filters { padding: 12px; display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; align-items: center; }
    .pl__empty { text-align: center; color: var(--text-muted); padding: 24px; }
    .pl__row--cancelled { opacity: .65; }
    .pl__pager { display: flex; align-items: center; justify-content: center; gap: 12px; padding: 12px; }
  `,
})
export class PurchasesPageComponent implements OnInit {
  private readonly service = inject(PurchasesService);
  private readonly suppliersService = inject(SuppliersService);
  protected readonly layout = inject(LayoutService);
  private readonly translate = inject(TranslateService);
  /** Phone only (Online Stage 6B): the filter sheet and the active-filter chips over the same filter fields. */
  protected readonly filtersOpen = signal(false);

  readonly rows = signal<Purchase[]>([]);
  readonly suppliers = signal<Supplier[]>([]);
  readonly loading = signal(true);
  readonly loadError = signal(false);
  readonly page = signal(1);
  readonly totalPages = signal(1);
  search = '';
  supplier = '';
  from = '';
  to = '';
  status: '' | 'posted' | 'cancelled' = '';

  ngOnInit(): void {
    this.suppliersService.list().subscribe({ next: (rows) => this.suppliers.set(rows), error: () => undefined });
    this.load();
  }

  protected activeChips(): FilterChip[] {
    const chips: FilterChip[] = [];
    if (this.supplier) chips.push({ key: 'supplier', label: this.suppliers().find((row) => row._id === this.supplier)?.name ?? this.supplier });
    if (this.from) chips.push({ key: 'from', label: formatMobDate(this.from, 'ar') });
    if (this.to) chips.push({ key: 'to', label: formatMobDate(this.to, 'ar') });
    if (this.status) chips.push({ key: 'status', label: this.translate.instant('purchases.status.' + this.status) });
    return chips;
  }

  protected removeChip(key: string): void {
    if (key === 'supplier') this.supplier = '';
    if (key === 'from') this.from = '';
    if (key === 'to') this.to = '';
    if (key === 'status') this.status = '';
    this.apply();
  }

  protected clearFilters(): void {
    this.supplier = ''; this.from = ''; this.to = ''; this.status = '';
    this.apply();
  }

  filters(): PurchaseFilters {
    return { search: this.search.trim(), supplier: this.supplier, from: this.from, to: this.to, status: this.status, page: this.page() };
  }

  apply(): void {
    this.page.set(1);
    this.load();
  }

  goto(page: number): void {
    this.page.set(Math.max(1, Math.min(this.totalPages(), page)));
    this.load();
  }

  load(): void {
    this.loading.set(true);
    this.loadError.set(false);
    this.service.list(this.filters()).subscribe({
      next: (response) => { this.rows.set(response.data); this.totalPages.set(response.pagination.totalPages || 1); this.loading.set(false); },
      error: () => { this.loadError.set(true); this.loading.set(false); },
    });
  }
}
