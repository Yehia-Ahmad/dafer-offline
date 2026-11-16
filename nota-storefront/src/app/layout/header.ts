import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '../core/auth.service';
import { CartService } from '../core/cart.service';
import { AR } from '../core/i18n/ar';
import { SettingsStore } from '../core/settings.store';
import { IconComponent } from '../ui/icon';

@Component({
  selector: 'app-header',
  imports: [RouterLink, FormsModule, IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <header class="hd">
      <div class="wrap hd-in">
        <a class="logo" routerLink="/" [attr.aria-label]="shop()">
          @if (logo(); as src) {
            <img class="logo-img" [src]="src" alt="" width="44" height="44" />
          } @else {
            <span class="logo-tile" aria-hidden="true">{{ initial() }}</span>
          }
          <span class="logo-name">{{ shop() }}</span>
        </a>
        <form class="search" role="search" (ngSubmit)="search()">
          <label class="search-box">
            <app-icon name="search" [size]="18" />
            <span class="sr-only">{{ t.header.searchLabel }}</span>
            <input type="search" name="q" [(ngModel)]="q" [placeholder]="t.header.searchPlaceholder" autocomplete="off" enterkeyhint="search" />
          </label>
        </form>
        <nav class="nav" [attr.aria-label]="t.header.navLabel">
          <a routerLink="/" fragment="cats" class="nl">{{ t.header.categories }}</a>
          <a routerLink="/" fragment="offers" class="nl">{{ t.header.offers }}</a>
          <a routerLink="/" fragment="contact" class="nl">{{ t.header.contact }}</a>
          <a [routerLink]="auth.signedIn() ? '/account' : '/login'" class="nl">{{ auth.signedIn() ? t.header.account : t.header.login }}</a>
        </nav>
        <a class="cart" routerLink="/cart" [attr.aria-label]="t.header.cartCount(cart.count())">
          <app-icon name="bag" [size]="20" />
          <span>{{ t.header.cart }}</span>
          <span class="count num" [hidden]="cart.count() === 0" aria-live="polite" aria-atomic="true">{{ cart.count() }}</span>
        </a>
      </div>
    </header>
  `,
  styles: [`
    .hd { background: var(--surface); border-bottom: 1px solid var(--border); }
    .hd-in { display: flex; flex-wrap: wrap; align-items: center; gap: 12px 24px; padding-top: 14px; padding-bottom: 14px; }
    .logo { display: flex; align-items: center; gap: 12px; color: var(--text); min-height: 44px; }
    .logo-tile, .logo-img { width: 44px; height: 44px; border-radius: var(--radius-control); flex: none; }
    .logo-tile { background: var(--brand); color: #fff; display: inline-flex; align-items: center; justify-content: center; font-size: 20px; font-weight: 800; }
    .logo-img { object-fit: cover; background: var(--placeholder); }
    .logo-name { font-size: 18px; font-weight: 800; }
    .search { flex: 1 1 280px; }
    .search-box { display: flex; align-items: center; gap: 10px; min-height: 46px; padding: 0 14px; background: var(--bg); border: 1px solid #c9c4b9; border-radius: var(--radius-control); color: var(--text-muted); }
    .search-box:focus-within { outline: 3px solid var(--brand); outline-offset: 2px; }
    .search-box input { flex: 1; min-width: 0; border: 0; background: transparent; outline: none; font-size: 15px; min-height: 44px; }
    .nav { display: flex; flex-wrap: wrap; gap: 4px 18px; }
    .nl { color: var(--text); padding: 10px 4px; min-height: 44px; display: inline-flex; align-items: center; }
    .cart { display: inline-flex; align-items: center; gap: 8px; min-height: 46px; padding: 0 16px; background: var(--brand); color: #fff; border-radius: var(--radius-control); font-weight: 700; }
    .cart:hover { color: #fff; filter: brightness(1.1); }
    .count { background: var(--accent); color: #fff; min-width: 22px; height: 22px; border-radius: 999px; font-size: 12px; display: inline-flex; align-items: center; justify-content: center; padding: 0 6px; }
    .count[hidden] { display: none; }
  `],
})
export class HeaderComponent {
  protected readonly t = AR;
  protected readonly cart = inject(CartService);
  protected readonly auth = inject(AuthService);
  private readonly settings = inject(SettingsStore);
  private readonly router = inject(Router);

  protected q = '';
  protected readonly shop = computed(() => this.settings.shopName() || AR.brandFallbackName);
  protected readonly logo = computed(() => this.settings.settings()?.logoUrl || null);
  protected readonly initial = computed(() => Array.from(this.shop())[0] || 'ن');

  protected search(): void {
    const q = this.q.trim();
    if (!q) return;
    void this.router.navigate(['/search'], { queryParams: { q } });
  }
}
