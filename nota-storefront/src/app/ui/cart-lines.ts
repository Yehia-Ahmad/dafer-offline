import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { CartLine, CartService } from '../core/cart.service';
import { money } from '../core/format';
import { AR } from '../core/i18n/ar';
import { LineProblem } from '../core/models';
import { IconComponent } from './icon';

/** The cart lines. `editable` (cart page): quantity stepper and remove. Always: the server's line problem with its fix action. */
@Component({
  selector: 'app-cart-lines',
  imports: [RouterLink, IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ul class="lines">
      @for (line of cart.lines(); track line.productId) {
        <li class="line" [class.bad]="problem(line)">
          <a class="thumb" [routerLink]="['/p', line.productId, line.slug]" tabindex="-1" aria-hidden="true">
            @if (line.image) { <img [src]="line.image" alt="" width="64" height="64" loading="lazy" /> } @else { <app-icon name="image" /> }
          </a>
          <div class="meta">
            <a class="name" [routerLink]="['/p', line.productId, line.slug]">{{ line.name }}</a>
            <span class="muted small num">{{ line.qty }} × {{ fmt(line.price) }}</span>
            @if (problem(line); as p) {
              <span class="err" role="alert">
                {{ p.reason === 'not_available' ? t.cart.notAvailable : t.cart.overStock(p.max ?? 0) }}
                @if (p.reason === 'not_available' || (p.max ?? 0) < 1) {
                  <button type="button" class="link-btn" (click)="cart.remove(line.productId)">{{ t.cart.remove }}</button>
                } @else {
                  <button type="button" class="link-btn" (click)="cart.setMax(line.productId, p.max ?? 1)">{{ t.cart.setMax(p.max ?? 1) }}</button>
                }
              </span>
            }
          </div>
          @if (editable()) {
            <div class="qty" role="group" [attr.aria-label]="line.name">
              <button type="button" (click)="cart.setQty(line.productId, line.qty + 1)" [disabled]="line.qty >= line.max" [attr.aria-label]="t.product.inc"><app-icon name="plus" [size]="18" /></button>
              <span class="num" aria-live="polite" aria-atomic="true">{{ line.qty }}</span>
              <button type="button" (click)="cart.setQty(line.productId, line.qty - 1)" [disabled]="line.qty <= 1" [attr.aria-label]="t.product.dec"><app-icon name="minus" [size]="18" /></button>
            </div>
          }
          <strong class="total num">{{ fmt(line.price * line.qty) }}</strong>
          @if (editable()) {
            <button type="button" class="rm" (click)="cart.remove(line.productId)" [attr.aria-label]="t.cart.removeNamed(line.name)"><app-icon name="close" [size]="18" /></button>
          }
        </li>
      }
    </ul>
  `,
  styles: [`
    .lines { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
    .line { display: flex; align-items: center; gap: 12px; padding: 12px 0; border-bottom: 1px solid var(--divider); flex-wrap: wrap; }
    .line:last-child { border-bottom: 0; }
    .line.bad { background: var(--danger-bg); padding-inline: 10px; border-radius: var(--radius-control); }
    .thumb { width: 64px; height: 64px; border-radius: var(--radius-input); background: var(--placeholder); display: inline-flex; align-items: center; justify-content: center; overflow: hidden; flex: none; color: var(--text-muted); }
    .thumb img { width: 100%; height: 100%; object-fit: cover; }
    .meta { flex: 1 1 160px; display: flex; flex-direction: column; min-width: 0; }
    .name { font-weight: 700; color: var(--text); }
    .small { font-size: 12px; }
    .qty { display: inline-flex; align-items: center; border: 1px solid var(--border-strong); border-radius: var(--radius-control); }
    .qty button { width: 44px; height: 44px; background: none; border: 0; display: inline-flex; align-items: center; justify-content: center; }
    .qty button:disabled { color: var(--disabled); cursor: not-allowed; }
    .qty span { min-width: 32px; text-align: center; font-weight: 700; }
    .total { min-width: 80px; text-align: end; }
    .rm { width: 44px; height: 44px; background: none; border: 0; color: var(--text-muted); display: inline-flex; align-items: center; justify-content: center; }
    .rm:hover { color: var(--danger); }
  `],
})
export class CartLinesComponent {
  protected readonly t = AR;
  protected readonly cart = inject(CartService);
  readonly editable = input(true);
  protected fmt = money;
  private readonly problems = computed(() => this.cart.problems());
  protected problem(line: CartLine): LineProblem | undefined { return this.problems()[line.productId]; }
}
