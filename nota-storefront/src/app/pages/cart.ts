import { ChangeDetectionStrategy, Component, effect, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { CartService } from '../core/cart.service';
import { money } from '../core/format';
import { AR } from '../core/i18n/ar';
import { SeoService } from '../core/seo.service';
import { SettingsStore } from '../core/settings.store';
import { CartLinesComponent } from '../ui/cart-lines';

@Component({
  selector: 'app-cart',
  imports: [RouterLink, CartLinesComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="wrap page narrow">
      <h1 class="h1">{{ t.cart.title }}</h1>
      @if (cart.isEmpty()) {
        <div class="empty card">
          <strong>{{ t.cart.empty }}</strong>
          <span>{{ t.cart.emptyHint }}</span>
          <a class="btn" routerLink="/">{{ t.cart.continue }}</a>
        </div>
      } @else {
        <div class="card">
          <app-cart-lines [editable]="true" />
        </div>
        <div class="card">
          <div class="row between"><span>{{ t.cart.subtotal }}</span><strong class="num" style="font-size:20px" aria-live="polite">{{ fmt(cart.subtotal()) }}</strong></div>
          <p class="muted" style="font-size:13px">{{ t.cart.note }}</p>
          @if (settings.orderingOn()) {
            <a class="btn big block" routerLink="/checkout">{{ t.cart.checkout }}</a>
          } @else {
            <button type="button" class="btn big block" disabled>{{ t.cart.checkout }}</button>
            <p class="err" role="status">{{ t.orderingOff }}</p>
          }
          <div class="row between">
            <a routerLink="/">{{ t.cart.continue }}</a>
            <button type="button" class="link-btn" (click)="cart.clear()">{{ t.cart.clear }}</button>
          </div>
        </div>
      }
    </div>
  `,
})
export class CartPage {
  protected readonly t = AR;
  protected readonly cart = inject(CartService);
  protected readonly settings = inject(SettingsStore);
  protected fmt = money;

  constructor() {
    inject(SeoService).set({ title: AR.cart.title, path: '/cart', noindex: true });
    effect(() => this.cart.count());
  }
}
