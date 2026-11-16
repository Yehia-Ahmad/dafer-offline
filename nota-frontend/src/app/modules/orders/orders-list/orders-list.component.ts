import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { NotaButtonDirective, NotaMoneyPipe, NotaPageHeaderComponent, NotaStatusPillComponent } from '../../shared/ui';
import { NotaPillVariant } from '../../shared/ui/status-pill.component';
import { OrdersNotifierService } from '../../../core/orders-notifier/orders-notifier.service';
import { AuthService } from '../../../core/auth/auth.service';
import { Courier, ORDER_STATUSES, OrderListRow, OrderStatus } from '../orders.models';
import { OrdersService } from '../orders.service';

export const ORDER_STATUS_VARIANT: Record<OrderStatus, NotaPillVariant> = {
  new: 'due',
  confirmed: 'info',
  preparing: 'info',
  out_for_delivery: 'due',
  delivered: 'ok',
  cancelled: 'overdue',
  rejected: 'overdue',
  refused: 'overdue',
};

/** Online Stage 4: /orders. Tabs by status with counts, search, date range, courier filter. */
@Component({
  selector: 'app-orders-list',
  imports: [TranslatePipe, FormsModule, RouterLink, DatePipe, NotaButtonDirective, NotaMoneyPipe, NotaPageHeaderComponent, NotaStatusPillComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="ol">
      <nota-page-header [title]="'orders.title' | translate" [subtitle]="'orders.subtitle' | translate">
        <div notaPageActions>
          <button type="button" notaButton data-action="toggle-sound" (click)="notifier.toggleMute()" [attr.aria-pressed]="notifier.muted()">
            {{ (notifier.muted() ? 'orders.soundOff' : 'orders.soundOn') | translate }}
          </button>
        </div>
      </nota-page-header>

      <div class="ol__tabs" role="tablist">
        <button type="button" role="tab" class="ol__tab" data-tab="all" [class.is-active]="status() === ''" [attr.aria-selected]="status() === ''" (click)="setStatus('')">
          {{ 'orders.tabs.all' | translate }} <span class="ol__count nota-num">{{ total() }}</span>
        </button>
        @for (s of statuses; track s) {
          <button type="button" role="tab" class="ol__tab" [attr.data-tab]="s" [class.is-active]="status() === s" [attr.aria-selected]="status() === s" (click)="setStatus(s)">
            {{ 'orders.status.' + s | translate }} <span class="ol__count nota-num">{{ counts()[s] || 0 }}</span>
          </button>
        }
      </div>

      <div class="ol__filters">
        <input class="nota-input" type="search" data-test="order-search" [placeholder]="'orders.search' | translate" [ngModel]="q()" (ngModelChange)="q.set($event)" (keyup.enter)="reload()" />
        <label class="ol__field">{{ 'orders.from' | translate }}<input class="nota-input" type="date" data-test="order-from" [ngModel]="from()" (ngModelChange)="from.set($event); reload()" /></label>
        <label class="ol__field">{{ 'orders.to' | translate }}<input class="nota-input" type="date" data-test="order-to" [ngModel]="to()" (ngModelChange)="to.set($event); reload()" /></label>
        <select class="nota-select" data-test="order-courier" [ngModel]="courierId()" (ngModelChange)="courierId.set($event); reload()" [attr.aria-label]="'orders.courier' | translate">
          <option value="">{{ 'orders.allCouriers' | translate }}</option>
          @for (courier of couriers(); track courier.id) { <option [value]="courier.id">{{ courier.name }}</option> }
        </select>
        <button type="button" notaButton data-action="search" (click)="reload()">{{ 'orders.searchAction' | translate }}</button>
      </div>

      @if (loadError()) {
        <div class="ol__alert" role="alert">{{ 'orders.loadFailed' | translate }} <button type="button" notaButton (click)="reload()">{{ 'orders.retry' | translate }}</button></div>
      }

      <div class="nota-table-wrap">
        <table class="nota-table">
          <thead><tr>
            <th>{{ 'orders.columns.number' | translate }}</th>
            <th>{{ 'orders.columns.time' | translate }}</th>
            <th>{{ 'orders.columns.customer' | translate }}</th>
            <th>{{ 'orders.columns.phone' | translate }}</th>
            <th>{{ 'orders.columns.zone' | translate }}</th>
            <th class="num">{{ 'orders.columns.total' | translate }}</th>
            <th>{{ 'orders.columns.status' | translate }}</th>
            <th>{{ 'orders.columns.courier' | translate }}</th>
          </tr></thead>
          <tbody>
            @for (order of rows(); track order.id) {
              <tr data-test="order-row" class="ol__row" (click)="open(order)">
                <td><a [routerLink]="['/orders', order.id]" class="nota-num" (click)="$event.stopPropagation()">{{ order.number }}</a></td>
                <td class="nota-num">{{ order.createdAt | date: 'short' }}</td>
                <td>{{ order.customerName }}</td>
                <td class="nota-num ol__ltr">{{ order.phone }}</td>
                <td>{{ order.zone }}</td>
                <td class="nota-num">{{ order.total | notaMoney }}</td>
                <td><nota-status-pill [variant]="variant(order.status)">{{ 'orders.status.' + order.status | translate }}</nota-status-pill></td>
                <td>{{ order.courierName || '—' }}</td>
              </tr>
            } @empty {
              @if (!loading()) { <tr><td colspan="8" class="ol__empty">{{ 'orders.empty' | translate }}</td></tr> }
            }
          </tbody>
        </table>
      </div>
      @if (loading()) { <p class="ol__muted" role="status">{{ 'orders.loading' | translate }}</p> }
      @if (totalPages() > 1) {
        <div class="ol__pager">
          <button type="button" notaButton data-action="prev" [disabled]="page() <= 1" (click)="go(page() - 1)">‹</button>
          <span class="nota-num">{{ page() }} / {{ totalPages() }}</span>
          <button type="button" notaButton data-action="next" [disabled]="page() >= totalPages()" (click)="go(page() + 1)">›</button>
        </div>
      }
    </div>
  `,
  styles: `
    :host { display: block; }
    .ol { display: flex; flex-direction: column; gap: var(--space-gap); }
    .ol__tabs { display: flex; flex-wrap: wrap; gap: 6px; }
    .ol__tab { border: 1px solid var(--border); background: var(--surface); color: var(--text); border-radius: 999px; padding: 6px 14px; font: inherit; cursor: pointer; display: inline-flex; gap: 8px; align-items: center; }
    .ol__tab.is-active { background: var(--brand-soft); color: var(--brand-strong-text); border-color: var(--brand); font-weight: 700; }
    .ol__count { font-size: 12px; color: var(--text-muted); }
    .ol__filters { display: flex; flex-wrap: wrap; gap: 10px; align-items: end; }
    .ol__field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--text-muted); }
    .ol__alert { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; padding: 14px 16px; border-radius: 12px; background: var(--danger-soft); color: var(--danger-text); }
    .ol__row { cursor: pointer; }
    .ol__ltr { direction: ltr; text-align: start; }
    .ol__empty { text-align: center; color: var(--text-muted); padding: 24px; }
    .ol__muted { margin: 0; color: var(--text-muted); }
    .ol__pager { display: flex; gap: 12px; align-items: center; justify-content: center; }
  `,
})
export class OrdersListComponent implements OnInit {
  private readonly service = inject(OrdersService);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  private readonly auth = inject(AuthService);
  protected readonly notifier = inject(OrdersNotifierService);

  protected readonly statuses = ORDER_STATUSES;
  protected readonly rows = signal<OrderListRow[]>([]);
  protected readonly counts = signal<Partial<Record<OrderStatus, number>>>({});
  protected readonly total = signal(0);
  protected readonly couriers = signal<Courier[]>([]);
  protected readonly loading = signal(true);
  protected readonly loadError = signal(false);
  protected readonly page = signal(1);
  protected readonly totalPages = signal(1);

  protected readonly status = signal<OrderStatus | ''>('');
  protected readonly q = signal('');
  protected readonly from = signal('');
  protected readonly to = signal('');
  protected readonly courierId = signal('');

  ngOnInit(): void {
    this.reload();
    this.service.listCouriers().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (list) => this.couriers.set(list), error: () => undefined });
  }

  protected variant(status: OrderStatus): NotaPillVariant {
    return ORDER_STATUS_VARIANT[status] ?? 'neutral';
  }

  protected setStatus(status: OrderStatus | ''): void {
    this.status.set(status);
    this.reload();
  }

  protected go(page: number): void {
    this.page.set(page);
    this.load();
  }

  protected reload(): void {
    this.page.set(1);
    this.load();
  }

  protected open(order: OrderListRow): void {
    void this.router.navigate(['/orders', order.id]);
  }

  private load(): void {
    this.loading.set(true);
    this.loadError.set(false);
    this.service
      .list({ status: this.status(), q: this.q(), from: this.from(), to: this.to(), courierId: this.courierId(), page: this.page() })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (response) => {
          this.rows.set(response.data);
          this.counts.set(response.counts);
          this.total.set(Object.values(response.counts).reduce((sum, n) => sum + n, 0));
          this.totalPages.set(response.pagination.totalPages || 1);
          this.loading.set(false);
          // The tab count of `new` is also the sidebar badge: keep them equal without waiting for the next poll.
          if (this.auth.has('orders.view')) this.notifier.poll();
        },
        error: () => { this.loadError.set(true); this.loading.set(false); },
      });
  }
}
