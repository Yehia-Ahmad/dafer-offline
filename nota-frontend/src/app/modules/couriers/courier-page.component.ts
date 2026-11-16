import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { CourierDetail, CourierOrderRow } from '../orders/orders.models';
import { OrdersService } from '../orders/orders.service';
import { NotaMoneyPipe, NotaPageHeaderComponent, NotaStatusPillComponent } from '../shared/ui';
import { ORDER_STATUS_VARIANT } from '../orders/orders-list/orders-list.component';

/** Online Stage 4: /website/couriers/:id. The courier's figures, his open orders and the recent ones. */
@Component({
  selector: 'app-courier-page',
  imports: [TranslatePipe, RouterLink, DatePipe, NotaMoneyPipe, NotaPageHeaderComponent, NotaStatusPillComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="cd">
      <nota-page-header [title]="courier()?.name || ('couriers.title' | translate)" [subtitle]="courier()?.phone || ''" backLink="/website/couriers" [backLabel]="'couriers.title' | translate" />
      @if (loadError()) { <div class="cd__alert" role="alert">{{ 'couriers.loadFailed' | translate }}</div> }
      @if (courier(); as c) {
        <div class="cd__kpis nota-num">
          <div class="cd__kpi"><span>{{ 'couriers.columns.box' | translate }}</span><b data-test="box-balance">{{ c.boxBalance | notaMoney }}</b></div>
          <div class="cd__kpi"><span>{{ 'couriers.columns.owed' | translate }}</span><b data-test="amount-owed">{{ c.amountOwed | notaMoney }}</b></div>
          <div class="cd__kpi"><span>{{ 'couriers.columns.open' | translate }}</span><b>{{ c.openOrders }}</b></div>
        </div>
        @for (section of sections(c); track section.key) {
          <section class="cd__card" [attr.data-test]="section.key">
            <h2>{{ section.title | translate }}</h2>
            <div class="nota-table-wrap">
              <table class="nota-table">
                <thead><tr>
                  <th>{{ 'orders.columns.number' | translate }}</th><th>{{ 'orders.columns.time' | translate }}</th><th>{{ 'orders.columns.customer' | translate }}</th>
                  <th class="num">{{ 'orders.columns.total' | translate }}</th><th>{{ 'orders.columns.status' | translate }}</th>
                </tr></thead>
                <tbody>
                  @for (order of section.rows; track order.id) {
                    <tr data-test="courier-order">
                      <td><a [routerLink]="['/orders', order.id]" class="nota-num">{{ order.number }}</a></td>
                      <td class="nota-num">{{ order.createdAt | date: 'short' }}</td>
                      <td>{{ order.customerName }}</td>
                      <td class="nota-num">{{ order.total | notaMoney }}</td>
                      <td><nota-status-pill [variant]="variant(order)">{{ 'orders.status.' + order.status | translate }}</nota-status-pill></td>
                    </tr>
                  } @empty { <tr><td colspan="5" class="cd__empty">{{ 'couriers.noOrders' | translate }}</td></tr> }
                </tbody>
              </table>
            </div>
          </section>
        }
      }
    </div>
  `,
  styles: `
    :host { display: block; }
    .cd { display: flex; flex-direction: column; gap: var(--space-gap); }
    .cd__alert { padding: 14px 16px; border-radius: 12px; background: var(--danger-soft); color: var(--danger-text); }
    .cd__kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: var(--space-gap); }
    .cd__kpi { background: var(--surface); border: 1px solid var(--border); border-radius: 16px; padding: 16px; display: flex; flex-direction: column; gap: 6px; }
    .cd__kpi span { color: var(--text-muted); font-size: 13px; }
    .cd__kpi b { font-size: 22px; }
    .cd__card { background: var(--surface); border: 1px solid var(--border); border-radius: 16px; padding: 18px; }
    .cd__card h2 { margin: 0 0 10px; font-size: 16px; }
    .cd__empty { text-align: center; color: var(--text-muted); padding: 18px; }
  `,
})
export class CourierPageComponent implements OnInit {
  private readonly service = inject(OrdersService);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly courier = signal<CourierDetail | null>(null);
  protected readonly loadError = signal(false);

  ngOnInit(): void {
    this.service.getCourier(this.route.snapshot.paramMap.get('id') || '').pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (courier) => this.courier.set(courier),
      error: () => this.loadError.set(true),
    });
  }

  protected sections(courier: CourierDetail): Array<{ key: string; title: string; rows: CourierOrderRow[] }> {
    return [
      { key: 'open-orders', title: 'couriers.openOrders', rows: courier.openOrderRows },
      { key: 'recent-orders', title: 'couriers.recentOrders', rows: courier.recentOrderRows },
    ];
  }

  protected variant(order: CourierOrderRow) {
    return ORDER_STATUS_VARIANT[order.status] ?? 'neutral';
  }
}
