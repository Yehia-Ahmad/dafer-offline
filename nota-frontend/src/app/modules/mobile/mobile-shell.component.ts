import { Location } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, OnInit } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { filter, map } from 'rxjs';
import { AuthService } from '../../core/auth/auth.service';
import { OrdersNotifierService } from '../../core/orders-notifier/orders-notifier.service';
import { NavIconComponent } from '../layout/nav/nav-icon.component';
import { CatalogStateService } from '../layout/nav/catalog-state.service';
import { NAV_GROUPS } from '../layout/nav/nav-menu.config';
import { ShopProfileService } from '../shop-profile/services/shop-profile.service';
import { PwaBarComponent } from './pwa-bar.component';
import { activeTabKey, hidesTabBar, isRootScreen, visibleTabs } from './mobile-tabs';
import { hasInAppHistory, parentRoute } from './mobile-parent';

/**
 * Online Stage 6A: the phone layout around the same routes (MobNav + MobTop). Replaces the sidebar frame below 768 px; the pages
 * inside are the ordinary routed pages, so guards, services and permissions are exactly the ones the desktop uses.
 * - Bottom tab bar: only the tabs the user may open (+ المزيد), the orders tab carries the new-orders badge.
 * - Top bar on inner screens (back, title). Root tabs draw their own header.
 */
@Component({
  selector: 'nota-mobile-shell',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, TranslatePipe, NavIconComponent, PwaBarComponent],
  host: { class: 'm-shell', '[class.m-shell--no-tabs]': 'noTabs()' },
  template: `
    <nota-pwa-bar />
    @if (!root()) {
      <header class="m-top">
        <button type="button" class="m-top__back" (click)="back()" [attr.aria-label]="'nav.back' | translate" data-testid="m-back">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"
            stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6" /></svg>
        </button>
        <div class="m-top__titles">
          @if (titleKey()) { <span class="m-top__title">{{ titleKey()! | translate }}</span> }
        </div>
      </header>
    }
    <main class="m-content"><ng-content /></main>
    @if (!noTabs()) {
      <nav class="m-tabs" [attr.aria-label]="'nav.label' | translate" data-testid="m-tabs">
        @for (tab of tabs(); track tab.key) {
          <a class="m-tab" [routerLink]="tab.route" [class.is-active]="active() === tab.key"
            [attr.aria-current]="active() === tab.key ? 'page' : null" [attr.data-tab]="tab.key">
            <span class="m-tab__pill">
              <nota-nav-icon [path]="tab.icon" [size]="22" />
              @if (tab.badge === 'newOrders' && (orders.newCount() ?? 0) > 0) {
                <span class="m-badge" data-testid="orders-badge">{{ orders.newCount() }}</span>
              }
            </span>
            <span>{{ tab.labelKey | translate }}</span>
          </a>
        }
      </nav>
    }
  `,
})
export class MobileShellComponent implements OnInit {
  private readonly router = inject(Router);
  private readonly location = inject(Location);
  private readonly auth = inject(AuthService);
  private readonly catalog = inject(CatalogStateService);
  private readonly shop = inject(ShopProfileService);
  protected readonly orders = inject(OrdersNotifierService);

  private readonly url = toSignal(
    this.router.events.pipe(filter((event) => event instanceof NavigationEnd), map(() => this.router.url)),
    { initialValue: this.router.url },
  );

  protected readonly tabs = computed(() => {
    this.auth.permissions(); // re-evaluate when the permissions change
    return visibleTabs((rule) => this.auth.allows(rule));
  });
  protected readonly active = computed(() => activeTabKey(this.url(), this.tabs()));
  protected readonly root = computed(() => isRootScreen(this.url(), this.tabs()) || !this.auth.signedIn());
  protected readonly noTabs = computed(() => hidesTabBar(this.url()) || !this.auth.signedIn());

  /** Inner screens: the sidebar label of the item whose route (or sub-route) this is. */
  protected readonly titleKey = computed(() => {
    const path = this.url().split(/[?#]/)[0];
    let best: { key: string; length: number } | null = null;
    for (const group of NAV_GROUPS) {
      for (const item of group.items) {
        const prefixes = [item.route, ...(item.activePaths ?? [])].filter((value): value is string => Boolean(value));
        for (const prefix of prefixes) {
          const hit = path === prefix || path.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`);
          if (hit && (!best || prefix.length > best.length)) best = { key: item.labelKey, length: prefix.length };
        }
      }
    }
    return best?.key ?? null;
  });

  ngOnInit(): void {
    // Same start-up work the sidebar does: the product-category list for the POS chips, and the shop profile (name on the home / more cards).
    if (this.auth.has('products.view')) this.catalog.refresh();
    if (this.auth.signedIn() && !this.shop.profile()) this.shop.refresh();
  }

  /** Online Stage 6B: back goes to the logical parent (list ← detail ← edit) when the page was opened directly (link, notification, reload). */
  protected back(): void {
    if (hasInAppHistory(this.location.getState())) { this.location.back(); return; }
    void this.router.navigateByUrl(parentRoute(this.router.url) ?? '/home');
  }
}
