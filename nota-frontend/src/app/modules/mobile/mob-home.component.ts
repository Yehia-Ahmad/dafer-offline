import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, input, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { AuthService } from '../../core/auth/auth.service';
import { errorMessage } from '../../core/auth/auth-errors';
import { ToastService } from '../../core/auth/toast.service';
import { OrdersNotifierService } from '../../core/orders-notifier/orders-notifier.service';
import { DashboardService, DashboardSummary, MobileSummary } from '../layout/services/dashboard.service';
import { LanguageService } from '../shared/services/translation.service';
import { NotaMoneyPipe, NotaNumberPipe } from '../shared/ui';
import { ShopProfileService } from '../shop-profile/services/shop-profile.service';
import { allowedOrderActions } from '../orders/order-actions';
import { OrderListRow } from '../orders/orders.models';
import { OrdersService } from '../orders/orders.service';
import { PushToggleComponent } from './push-toggle.component';
import { itemsCountKey, timeAgo } from './mobile-utils';

/** A new website order on the home screen: the list row plus the number of lines (from the order itself). */
interface HomeOrder { row: OrderListRow; items: number | null }

/** How many new orders the home screen shows. */
export const HOME_ORDERS_LIMIT = 3;

/**
 * Online Stage 6A, MobHome. Reads existing data only:
 * - today's numbers: GET /api/dashboard/mobile-summary (blocks the user may not see are simply absent),
 * - new website orders: GET /api/orders?status=new (+ each order for its line count),
 * - low stock: the dashboard summary the desktop home already loaded (passed in, no second request).
 * Each block shows only with its permission.
 */
@Component({
  selector: 'nota-mob-home',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, TranslatePipe, NotaMoneyPipe, NotaNumberPipe, PushToggleComponent],
  template: `
    <header class="m-head" data-testid="m-home-head">
      <div>
        <div class="m-head__title">{{ greetingKey() | translate }}، {{ firstName() }}</div>
        <div class="m-head__sub">{{ shopName() }}</div>
      </div>
      @if (auth.has('orders.view')) {
        <a class="m-btn" routerLink="/orders" [attr.aria-label]="'mobile.home.bell' | translate" data-testid="m-bell" style="position:relative;min-width:44px;padding:0 12px">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10 21a2 2 0 0 0 4 0" /></svg>
          @if ((notifier.newCount() ?? 0) > 0) { <span class="m-badge">{{ notifier.newCount() }}</span> }
        </a>
      }
    </header>

    <div class="m-page">
      @if (today(); as today) {
        <section class="m-dark-card" data-testid="m-today">
          <div class="m-dark-card__label">{{ 'mobile.home.today' | translate }}</div>
          <div class="m-dark-card__value nota-num">{{ today.total | notaMoney }}</div>
          <div class="m-dark-card__split">
            @if (today.shop !== undefined) { <div>{{ 'mobile.home.fromShop' | translate }}<strong class="nota-num">{{ today.shop | notaMoney }}</strong></div> }
            @if (today.website !== undefined) { <div>{{ 'mobile.home.fromWebsite' | translate }}<strong class="nota-num">{{ today.website | notaMoney }}</strong></div> }
            @if (cashDrawer() !== null) { <div>{{ 'mobile.home.inDrawer' | translate }}<strong class="nota-num">{{ cashDrawer() | notaMoney }}</strong></div> }
          </div>
        </section>
      } @else if (cashDrawer() !== null) {
        <section class="m-dark-card"><div class="m-dark-card__label">{{ 'mobile.home.inDrawer' | translate }}</div><div class="m-dark-card__value nota-num">{{ cashDrawer() | notaMoney }}</div></section>
      }

      @if (auth.has('orders.view')) {
        <section data-testid="m-new-orders">
          <div class="m-section-title">{{ 'mobile.home.newOrders' | translate }}
            <a routerLink="/orders" class="m-muted" style="font-size:12px;font-weight:600">{{ 'mobile.home.all' | translate }}</a></div>
          @for (order of orders(); track order.row.id) {
            <article class="m-card" style="margin-top:8px" data-test="home-order">
              <div style="display:flex;justify-content:space-between;gap:8px">
                <b class="nota-num">{{ order.row.number }}</b>
                <span class="m-muted" style="font-size:12px">{{ ago(order.row.createdAt) }}</span>
              </div>
              <div class="m-row__sub" style="margin:4px 0">
                {{ order.row.customerName }}
                @if (order.items !== null) { · {{ itemsKey(order.items) | translate: { count: (order.items | notaNumber) } }} }
                · {{ 'orders.fulfillment.' + order.row.fulfillment | translate }}
              </div>
              <div style="display:flex;align-items:center;gap:8px;margin-top:8px">
                <b class="nota-num" style="flex:1">{{ order.row.total | notaMoney }}</b>
                @if (canConfirm(order)) {
                  <button type="button" class="m-btn m-btn--primary" [disabled]="busyId() === order.row.id" (click)="confirm(order)" data-action="confirm">{{ 'orders.actions.confirm' | translate }}</button>
                }
                <a class="m-btn" [routerLink]="['/orders', order.row.id]" data-action="details">{{ 'mobile.home.details' | translate }}</a>
              </div>
            </article>
          } @empty {
            <div class="m-card m-empty" style="margin-top:8px">{{ 'mobile.home.noNewOrders' | translate }}</div>
          }
        </section>
        <section class="m-card m-card--flush"><nota-push-toggle /></section>
      }

      @if (lowStock().length) {
        <section data-testid="m-low-stock">
          <div class="m-section-title">{{ 'dashboard.lowStock.title' | translate }}
            <a routerLink="/products" class="m-muted" style="font-size:12px;font-weight:600">{{ 'dashboard.lowStock.all' | translate }}</a></div>
          <div class="m-card m-card--flush" style="margin-top:8px">
            @for (item of lowStock(); track item.id) {
              <a class="m-row" [routerLink]="['/products/edit', item.id]">
                <div class="m-row__body"><div class="m-row__title">{{ item.name }}</div><div class="m-row__sub">{{ item.code }}</div></div>
                <span class="m-pill m-pill--warn nota-num">{{ item.inventoryCount | notaNumber }}</span>
              </a>
            }
          </div>
        </section>
      }
    </div>
  `,
})
export class MobHomeComponent implements OnInit {
  protected readonly auth = inject(AuthService);
  protected readonly notifier = inject(OrdersNotifierService);
  private readonly dashboard = inject(DashboardService);
  private readonly ordersApi = inject(OrdersService);
  private readonly shop = inject(ShopProfileService);
  private readonly language = inject(LanguageService);
  private readonly toast = inject(ToastService);
  private readonly destroyRef = inject(DestroyRef);

  /** The summary the desktop home component already loaded (low stock needs dashboard.view). */
  readonly summary = input<DashboardSummary | null>(null);

  protected readonly mobile = signal<MobileSummary | null>(null);
  protected readonly today = computed(() => this.mobile()?.today ?? null);
  protected readonly cashDrawer = computed(() => this.mobile()?.cashDrawer ?? null);
  protected readonly orders = signal<HomeOrder[]>([]);
  protected readonly busyId = signal('');
  protected readonly lowStock = computed(() => (this.summary()?.lowStock ?? []).slice(0, 5));
  protected readonly firstName = computed(() => (this.auth.user()?.name ?? '').trim().split(/\s+/)[0] ?? '');
  protected readonly shopName = computed(() => this.shop.profile()?.name ?? '');
  protected readonly greetingKey = computed(() => (new Date().getHours() < 12 ? 'dashboard.greeting.morning' : 'dashboard.greeting.evening'));

  ngOnInit(): void {
    this.dashboard.getMobileSummary().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (value) => this.mobile.set(value), error: () => undefined });
    if (this.auth.has('orders.view')) this.loadOrders();
  }

  protected itemsKey = itemsCountKey;

  protected ago(iso: string): string {
    return timeAgo(iso, this.language.selectedLanguage());
  }

  /** "تأكيد الطلب": only when the order's status, kind and the user's permissions allow it (the Stage 4/5A table). */
  protected canConfirm(order: HomeOrder): boolean {
    const context = { status: order.row.status, fulfillment: order.row.fulfillment, paymentMethod: order.row.paymentMethod, payment: { status: order.row.paymentStatus } };
    return allowedOrderActions(context, (key) => this.auth.has(key)).includes('confirm');
  }

  protected confirm(order: HomeOrder): void {
    if (this.busyId()) return;
    this.busyId.set(order.row.id);
    this.ordersApi.confirm(order.row.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { this.busyId.set(''); this.loadOrders(); this.notifier.poll(); },
      error: (response) => { this.busyId.set(''); this.toast.error(errorMessage(response)); this.loadOrders(); },
    });
  }

  private loadOrders(): void {
    this.ordersApi.list({ status: 'new', limit: HOME_ORDERS_LIMIT }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (response) => {
        // The list row already carries the piece count: one request, no per-order detail calls.
        this.orders.set(response.data.slice(0, HOME_ORDERS_LIMIT).map((row) => ({ row, items: row.itemsCount ?? null })));
      },
      error: () => undefined,
    });
  }
}
