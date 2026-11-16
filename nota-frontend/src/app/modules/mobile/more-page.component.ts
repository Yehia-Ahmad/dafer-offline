import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { Router, RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { AuthService } from '../../core/auth/auth.service';
import { UnsavedWorkService } from '../../core/unsaved-work/unsaved-work.service';
import { ChangePasswordDialogComponent } from '../auth/change-password-dialog/change-password-dialog.component';
import { userRoleLabelKey } from '../layout/custom-sidenav/custom-sidenav.component';
import { NavIconComponent } from '../layout/nav/nav-icon.component';
import { NAV_GROUPS, NavGroup, visibleNavGroups } from '../layout/nav/nav-menu.config';
import { ShopProfileService } from '../shop-profile/services/shop-profile.service';
import { ThemeService } from '../shared/services/theme.service';
import { PushToggleComponent } from './push-toggle.component';

/** The order of the groups on the phone (the design lists الموقع right after المبيعات). */
export const MORE_GROUP_ORDER = ['sales', 'website', 'inventory', 'treasury', 'accounting', 'admin'] as const;

/** Pure: the grouped grid of المزيد, filtered by permission (every admin page is reachable from here). */
export function moreGroups(has: (key: string) => boolean): NavGroup[] {
  const visible = visibleNavGroups(NAV_GROUPS, { has });
  const rank = (key: string) => { const index = (MORE_GROUP_ORDER as readonly string[]).indexOf(key); return index === -1 ? 99 : index; };
  return visible.filter((group) => group.key !== 'main').sort((a, b) => rank(a.key) - rank(b.key));
}

/** Online Stage 6A, MobMore: the user card and the grouped icon grids. */
@Component({
  selector: 'nota-more-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, TranslatePipe, NavIconComponent, PushToggleComponent, ChangePasswordDialogComponent],
  template: `
    <header class="m-head"><div><div class="m-head__title">{{ 'mobile.tabs.more' | translate }}</div></div></header>
    <div class="m-page">
      <section class="m-card" data-testid="user-card">
        <div class="m-row" style="padding:0;border:0">
          <span class="m-avatar">{{ initial() }}</span>
          <div class="m-row__body">
            <div class="m-row__title">{{ user()?.name }}</div>
            <div class="m-row__sub">{{ roleKey() | translate }}@if (shopName()) { · {{ shopName() }} }</div>
          </div>
          <button type="button" class="m-btn m-btn--danger" (click)="logout()" data-testid="logout">{{ 'mobile.more.logout' | translate }}</button>
        </div>
      </section>

      @for (group of groups(); track group.key) {
        <section class="m-card m-card--flush" [attr.data-group]="group.key">
          <div class="m-card__title" style="padding:12px 14px 0">{{ group.labelKey! | translate }}</div>
          <div class="m-grid">
            @for (item of group.items; track item.key) {
              <a class="m-grid__item" [routerLink]="item.route" [attr.data-item]="item.key">
                <span class="m-grid__icon"><nota-nav-icon [path]="item.icon" [size]="22" /></span>
                <span>{{ item.labelKey | translate }}</span>
              </a>
            }
          </div>
        </section>
      }

      @if (auth.has('orders.view')) {
        <section class="m-card m-card--flush"><nota-push-toggle /></section>
      }

      <section class="m-card m-card--flush">
        <button type="button" class="m-row" (click)="toggleTheme()">
          <div class="m-row__body"><div class="m-row__title">{{ (isDark() ? 'mobile.more.lightMode' : 'mobile.more.darkMode') | translate }}</div></div>
        </button>
        <button type="button" class="m-row" (click)="changePasswordOpen = true" data-action="change-password">
          <div class="m-row__body"><div class="m-row__title">{{ 'auth.changePassword.open' | translate }}</div></div>
        </button>
      </section>
    </div>
    <nota-change-password-dialog [(open)]="changePasswordOpen" />
  `,
})
export class MorePageComponent {
  protected readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly unsaved = inject(UnsavedWorkService);
  private readonly theme = inject(ThemeService);
  private readonly shop = inject(ShopProfileService);

  protected readonly user = this.auth.user;
  protected readonly isDark = toSignal(this.theme.isDarkMode$, { initialValue: false });
  protected readonly initial = computed(() => (this.user()?.name ?? '').trim().charAt(0) || '؟');
  protected readonly roleKey = computed(() => userRoleLabelKey(this.user()));
  protected readonly shopName = computed(() => this.shop.profile()?.name ?? '');
  protected readonly groups = computed(() => {
    const permissions = new Set(this.auth.permissions());
    return moreGroups((key) => permissions.has(key));
  });
  protected changePasswordOpen = false;

  protected toggleTheme(): void {
    this.theme.toggleTheme();
  }

  /** Same sign-out as the sidebar: asks first when a screen has unsaved work. */
  protected async logout(): Promise<void> {
    if (!(await this.unsaved.confirm())) return;
    this.unsaved.allowNextNavigation();
    this.auth.logout();
    await this.router.navigate(['/login']);
  }
}
