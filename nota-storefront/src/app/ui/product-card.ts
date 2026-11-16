import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { CartService } from '../core/cart.service';
import { money, percentOff } from '../core/format';
import { AR } from '../core/i18n/ar';
import { Product } from '../core/models';
import { SettingsStore } from '../core/settings.store';
import { productPath } from '../core/slug';
import { IconComponent } from './icon';

@Component({
  selector: 'app-product-card',
  imports: [RouterLink, IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <article class="pc">
      <a class="pc-img" [routerLink]="link()" [attr.aria-label]="product().name" [style.height.px]="imageHeight()">
        @if (product().images[0]; as src) {
          <img [src]="src" [alt]="product().name" width="400" height="300" [attr.loading]="eager() ? 'eager' : 'lazy'" [attr.fetchpriority]="eager() ? 'high' : null" decoding="async" />
        } @else {
          <span class="pc-ph"><app-icon name="image" [size]="36" /><span class="sr-only">{{ t.card.image }}</span></span>
        }
        @if (badge(); as b) {
          <span class="badge pc-badge" [class.out]="out()">{{ b }}</span>
        }
      </a>
      <div class="pc-body">
        <a class="pc-name" [routerLink]="link()">{{ product().name }}</a>
        <div class="pc-foot">
          <div class="pc-price">
            <span class="price num">{{ fmt(product().finalPrice) }}</span>
            @if (product().discountPercentage > 0) { <span class="old num">{{ fmt(product().price) }}</span> }
          </div>
          @if (showAdd()) {
            <button type="button" class="pc-add" [disabled]="!canAdd()" (click)="add()" [attr.aria-label]="canAdd() ? t.card.addNamed(product().name) : t.card.unavailable">
              <app-icon [name]="justAdded() ? 'check' : 'plus'" [size]="22" [stroke]="2.2" />
            </button>
          }
        </div>
        @if (justAdded()) { <span class="sr-only" role="status">{{ t.card.added }}</span> }
      </div>
    </article>
  `,
  styles: [`
    .pc { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; display: flex; flex-direction: column; height: 100%; }
    .pc-img { position: relative; display: block; background: var(--placeholder); height: 200px; }
    .pc-img img { width: 100%; height: 100%; object-fit: cover; }
    .pc-ph { display: flex; width: 100%; height: 100%; align-items: center; justify-content: center; color: var(--text-muted); }
    .pc-badge { position: absolute; top: 12px; inset-inline-start: 12px; }
    .pc-body { padding: 14px 16px 16px; display: flex; flex-direction: column; gap: 10px; flex: 1; }
    .pc-name { color: var(--text); font-weight: 700; font-size: 15px; line-height: 1.5; min-height: 44px; display: flex; align-items: center; }
    .pc-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: auto; }
    .pc-price { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
    .pc-add { width: 44px; height: 44px; border-radius: var(--radius-control); border: 0; background: var(--brand); color: #fff; display: inline-flex; align-items: center; justify-content: center; flex: none; }
    .pc-add:disabled { background: var(--disabled-bg); color: var(--disabled); cursor: not-allowed; }
  `],
})
export class ProductCardComponent {
  protected readonly t = AR;
  private readonly cart = inject(CartService);
  private readonly settings = inject(SettingsStore);

  readonly product = input.required<Product>();
  readonly eager = input(false);
  readonly compact = input(false);

  protected readonly justAdded = signal(false);
  protected readonly link = computed(() => productPath(this.product()));
  protected readonly imageHeight = computed(() => (this.compact() ? 170 : 200));
  protected readonly out = computed(() => this.product().availability === 'out_of_stock' || this.product().maxOrderQty < 1);
  protected readonly canAdd = computed(() => !this.out() && this.settings.orderingOn());
  protected readonly showAdd = computed(() => !this.compact());
  protected readonly badge = computed(() => {
    const p = this.product();
    if (this.out()) return AR.card.badge['out_of_stock'];
    if (p.discountPercentage > 0) {
      const pct = Math.round(p.discountPercentage) || percentOff(p.price, p.finalPrice);
      return pct > 0 ? AR.card.discountPct(pct) : AR.card.badge['discount'];
    }
    return p.badges?.includes('new') ? AR.card.badge['new'] : '';
  });

  protected fmt = money;

  protected add(): void {
    if (!this.canAdd()) return;
    this.cart.add(this.product(), 1);
    this.justAdded.set(true);
    setTimeout(() => this.justAdded.set(false), 1500);
  }
}
