import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ApiError, ApiService } from '../core/api.service';
import { exactAmount, money, whatsappLink } from '../core/format';
import { AR } from '../core/i18n/ar';
import { OrderView } from '../core/models';
import { SeoService } from '../core/seo.service';
import { SettingsStore } from '../core/settings.store';

/** Order placed + tracking (/order/:token). A guest can bookmark this page. Client-rendered, noindex. */
@Component({
  selector: 'app-order',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="wrap page narrow">
      @if (loading()) {
        <p class="empty" role="status">{{ t.loading }}</p>
      } @else if (order(); as o) {
        <h1 class="h1">{{ t.order.title }}</h1>
        <section class="card">
          <div class="row between"><span class="muted">{{ t.order.numberLabel }}</span><strong class="num" style="font-size:22px">{{ o.number }}</strong></div>
          <div class="row between"><span class="muted">{{ t.order.status }}</span><strong role="status">{{ statusText() }}</strong></div>
          @if (o.paymentStatus) { <div class="row between"><span class="muted"></span><strong>{{ o.paymentStatus === 'verified' ? t.order.paid : t.order.unpaid }}</strong></div> }
        </section>

        @if (wallet(); as w) {
          <section class="card" aria-labelledby="wal">
            <h2 id="wal" style="font-size:18px">{{ t.order.walletTitle }}</h2>
            <div class="row between"><span class="muted">{{ w.label }}</span><strong class="ltr">{{ w.value }}</strong></div>
            <div class="row between"><span class="muted">{{ t.order.walletAmount }}</span><strong class="num">{{ exact(o.total) }}</strong></div>
            <p class="note">{{ t.order.walletOrderNo }}: <strong class="num">{{ o.number }}</strong></p>
            @if (wa(); as link) { <a class="btn big" [href]="link" target="_blank" rel="noopener">{{ t.order.walletSend }}</a> }
          </section>
        } @else if (o.status === 'new' || o.status === 'confirmed') {
          <p class="note">{{ o.fulfillment === 'pickup' ? t.order.pickupNext : t.order.codNext }}</p>
        }

        <section class="card">
          <h2 style="font-size:18px">{{ t.order.items }}</h2>
          @for (i of o.items ?? []; track i.productId) {
            <div class="row between"><span>{{ i.name }} <span class="muted num">× {{ i.qty }}</span></span><span class="num">{{ fmt(i.lineTotal) }}</span></div>
          }
          <hr style="border:0;border-top:1px solid var(--divider);width:100%" />
          <div class="row between"><span>{{ t.order.subtotal }}</span><span class="num">{{ fmt(o.subtotal) }}</span></div>
          @if (o.zone) { <div class="row between"><span>{{ t.order.deliveryFee }} ({{ o.zone.name }})</span><span class="num">{{ o.deliveryFee > 0 ? fmt(o.deliveryFee) : t.checkout.deliveryFree }}</span></div> }
          @if (o.vat > 0) { <div class="row between"><span>{{ t.order.vat }}</span><span class="num">{{ fmt(o.vat) }}</span></div> }
          <div class="row between" style="font-size:20px;font-weight:800"><span>{{ t.order.total }}</span><span class="num">{{ fmt(o.total) }}</span></div>
        </section>
        <p class="muted" style="font-size:13px">{{ t.order.bookmark }}</p>
        <div class="row"><button type="button" class="btn outline" (click)="load(true)">{{ t.order.refresh }}</button><a class="btn" routerLink="/">{{ t.cart.continue }}</a></div>
      } @else {
        <div class="empty card"><strong>{{ t.order.notFound }}</strong><a class="btn" routerLink="/">{{ t.notFound.home }}</a></div>
      }
    </div>
  `,
})
export class OrderPage {
  protected readonly t = AR;
  private readonly api = inject(ApiService);
  private readonly settings = inject(SettingsStore);
  readonly token = input.required<string>();
  protected readonly order = signal<OrderView | null>(null);
  protected readonly loading = signal(true);
  protected fmt = money;
  protected exact = exactAmount;

  protected readonly statusText = computed(() => AR.order.statuses[this.order()?.status ?? ''] ?? this.order()?.status ?? '');
  protected readonly wallet = computed(() => {
    const o = this.order();
    const d = this.settings.settings()?.paymentDetails;
    if (!o || o.paymentMethod === 'cod') return null;
    if (o.paymentMethod === 'instapay' && d?.instapay?.address) return { label: AR.order.walletInstapay, value: d.instapay.address };
    if (o.paymentMethod === 'vodafone_cash' && d?.vodafoneCash?.number) return { label: AR.order.walletVodafone, value: d.vodafoneCash.number };
    return null;
  });
  protected readonly wa = computed(() => {
    const o = this.order();
    return o ? whatsappLink(this.settings.whatsapp(), AR.order.walletSendText(o.number, exactAmount(o.total))) : null;
  });

  constructor() {
    inject(SeoService).set({ title: AR.order.title, path: '/order', noindex: true });
    effect(() => { this.token(); void this.load(false); });
  }

  protected async load(quiet: boolean): Promise<void> {
    if (!quiet) this.loading.set(true);
    try {
      this.order.set(await this.api.track(this.token()));
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      if (!quiet) this.order.set(null);
    } finally {
      this.loading.set(false);
    }
  }
}
