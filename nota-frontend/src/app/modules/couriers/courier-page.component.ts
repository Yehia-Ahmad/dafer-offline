import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { CourierDetail, CourierOrderRow } from '../orders/orders.models';
import { OrdersService } from '../orders/orders.service';
import { Courier } from '../orders/orders.models';
import { CashBox } from '../cashbox/cashbox.models';
import { CashboxService } from '../cashbox/cashbox.service';
import { TransferDialogComponent } from '../cashbox/transfer-dialog.component';
import { NotaCanDirective } from '../../core/auth/nota-can.directive';
import { LayoutService } from '../../core/layout/layout.service';
import { MobBarComponent } from '../mobile/mob-sheet.component';
import { MobDatePipe } from '../mobile/mob-date.pipe';
import { mobilePillClass } from '../mobile/mobile-utils';
import { NotaMoneyPipe, NotaPageHeaderComponent, NotaStatusPillComponent } from '../shared/ui';
import { ORDER_STATUS_VARIANT } from '../orders/orders-list/orders-list.component';

/** Online Stage 4: /website/couriers/:id. The courier's figures, his open orders and the recent ones. */
@Component({
  selector: 'app-courier-page',
  imports: [TranslatePipe, RouterLink, DatePipe, NotaMoneyPipe, NotaPageHeaderComponent, NotaStatusPillComponent, MobBarComponent, MobDatePipe, NotaCanDirective, TransferDialogComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
@if (layout.isMobile()) {
    <!-- Online Stage 6B (phone): the same courier page. Name and phone in the top bar; the three figures as cards; "تسليم الفلوس" shortcut (the same transfer dialog as the list); the open and delivered orders as cards. -->
    @if (courier(); as c) { <nota-mob-bar [title]="c.name" [subtitle]="c.phone" /> }
    @if (loadError()) { <div class="m-card m-empty" style="margin:12px 14px" role="alert"><span class="nota-error">{{ 'couriers.loadFailed' | translate }}</span></div> }
    @if (courier(); as c) {
      <div class="m-page" style="padding-top:12px">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px" class="nota-num">
          <div class="m-card" style="padding:12px"><div class="m-row__sub">{{ 'couriers.columns.box' | translate }}</div><strong data-test="box-balance">{{ c.boxBalance | notaMoney }} {{ 'cashbox.currency' | translate }}</strong></div>
          <div class="m-card" style="padding:12px"><div class="m-row__sub">{{ 'couriers.columns.owed' | translate }}</div><strong data-test="amount-owed">{{ c.amountOwed | notaMoney }} {{ 'cashbox.currency' | translate }}</strong></div>
          <div class="m-card" style="padding:12px"><div class="m-row__sub">{{ 'couriers.columns.open' | translate }}</div><strong>{{ c.openOrders }}</strong></div>
        </div>
        <button *notaCan="'cashbox.manage'" type="button" class="m-btn m-btn--primary m-btn--lg m-btn--block" data-action="hand-in" [disabled]="c.boxBalance <= 0" (click)="handIn(c)">{{ 'couriers.handIn' | translate }}</button>
        @for (section of sections(c); track section.key) {
          <div class="m-section-label" [attr.data-test]="section.key">{{ section.title | translate }}</div>
          <div class="m-card m-card--flush">
            @for (order of section.rows; track order.id) {
              <div class="m-row m-stretch-host" data-test="courier-order">
                <a class="m-row__open m-stretch" [routerLink]="['/orders', order.id]">
                  <span class="m-row__title nota-num" style="display:block" dir="ltr"><span style="text-align:start;display:block">{{ order.number }}</span></span>
                  <span class="m-row__sub" style="display:block;white-space:normal" dir="auto">{{ order.customerName }} · {{ order.createdAt | mobDate: true }}</span>
                </a>
                <span class="m-row__end"><span class="nota-num" style="display:block">{{ order.total | notaMoney }}</span><span [class]="mobPill(order)">{{ 'orders.status.' + order.status | translate }}</span></span>
              </div>
            } @empty { <div class="m-empty">{{ 'couriers.noOrders' | translate }}</div> }
          </div>
        }
      </div>
      <app-transfer-dialog [(visible)]="transferOpen" [boxes]="boxes()" [presetFromId]="handInFrom()" [presetToId]="handInTo()" [presetAmount]="handInAmount()" (done)="load()" />
    }
} @else {

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
  }
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
  protected readonly layout = inject(LayoutService);
  private readonly cashbox = inject(CashboxService);
  // Phone (Online Stage 6B): the "تسليم الفلوس" shortcut: the same transfer dialog and presets as the couriers list.
  protected readonly boxes = signal<CashBox[]>([]);
  protected readonly transferOpen = signal(false);
  protected readonly handInFrom = signal('');
  protected readonly handInTo = signal('');
  protected readonly handInAmount = signal<number | null>(null);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly courier = signal<CourierDetail | null>(null);
  protected readonly loadError = signal(false);

  ngOnInit(): void {
    this.load();
  }

  protected load(): void {
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

  protected mobPill(order: CourierOrderRow): string {
    return mobilePillClass(this.variant(order) as string);
  }

  /** "Hand in cash": courier box → main box with the box balance as the amount (same as the couriers list). */
  protected handIn(courier: Courier): void {
    this.cashbox.boxes().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (response) => {
        const active = response.data.filter((box) => box.isActive);
        this.boxes.set(active);
        const main = active.find((box) => box.isMain);
        const own = active.find((box) => box._id === courier.boxId);
        this.handInFrom.set(courier.boxId);
        this.handInTo.set(main?._id ?? '');
        this.handInAmount.set(own?.balance ?? courier.boxBalance);
        this.transferOpen.set(true);
      },
      error: () => undefined,
    });
  }

  protected variant(order: CourierOrderRow) {
    return ORDER_STATUS_VARIANT[order.status] ?? 'neutral';
  }
}
