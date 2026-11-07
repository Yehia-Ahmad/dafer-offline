import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { NotaCanDirective } from '../../core/auth/nota-can.directive';
import { NotaButtonDirective, NotaMoneyPipe, NotaPageHeaderComponent, NotaStatusPillComponent } from '../shared/ui';
import { Supplier, SuppliersService } from '../suppliers/suppliers.service';
import { Purchase, PurchaseFilters } from './purchases.models';
import { PurchasesService } from './purchases.service';

/** Stage 20: the purchases list. Number, supplier, supplier invoice no., date, total, paid, status; filters; click opens the detail. */
@Component({
  selector: 'app-purchases-page',
  standalone: true,
  imports: [DatePipe, FormsModule, RouterLink, TranslatePipe, NotaCanDirective, NotaButtonDirective, NotaMoneyPipe, NotaPageHeaderComponent, NotaStatusPillComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
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
