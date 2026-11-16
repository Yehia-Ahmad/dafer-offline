import { Component, computed, inject, OnInit } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterModule } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { filter, map } from 'rxjs';
import { LanguageService } from '../../shared/services/translation.service';
import { ThemeService } from '../../shared/services/theme.service';
import { brandName } from '../../../core/brand';
import { NAV_GROUPS, NavContext, NavItem, visibleNavGroups } from '../nav/nav-menu.config';
import { NavIconComponent } from '../nav/nav-icon.component';
import { SidebarStateService } from '../nav/sidebar-state.service';
import { CatalogStateService } from '../nav/catalog-state.service';
import { AuthService } from '../../../core/auth/auth.service';
import { DeviceService } from '../../../core/device/device.service';
import { UnsavedWorkService } from '../../../core/unsaved-work/unsaved-work.service';
import { ChangePasswordDialogComponent } from '../../auth/change-password-dialog/change-password-dialog.component';

/**
 * Nota sidebar (docs/design/screens/Sidebar.dc.html): logo, grouped menu from NAV_GROUPS,
 * footer with language and theme. Category tools live on the products page since Stage 11.
 * Stage 14: items follow the signed-in user's permissions; the user card (name, role,
 * change password, logout) sits at the bottom.
 */
@Component({
  selector: 'app-custom-sidenav',
  standalone: true,
  imports: [RouterModule, TranslatePipe, NavIconComponent, ChangePasswordDialogComponent],
  templateUrl: './custom-sidenav.component.html',
  host: { class: 'nota-sidebar', '[class.is-rail]': 'state.collapsed()' },
})
export class CustomSidenavComponent implements OnInit {
  private readonly _languageService = inject(LanguageService);
  private readonly _themeService = inject(ThemeService);
  private readonly _router = inject(Router);
  private readonly unsaved = inject(UnsavedWorkService);
  protected readonly state = inject(SidebarStateService);
  private readonly _catalog = inject(CatalogStateService);
  protected readonly auth = inject(AuthService);
  protected readonly device = inject(DeviceService);

  readonly language = this._languageService.selectedLanguage;
  readonly brandName = computed(() => brandName(this._languageService.selectedLanguage()));
  readonly isDark = toSignal(this._themeService.isDarkMode$, { initialValue: false });

  /** Re-evaluated when the signed-in user or their permissions change. */
  readonly groups = computed(() => {
    const permissions = new Set(this.auth.permissions());
    const ctx: NavContext = { has: (key) => permissions.has(key) };
    return visibleNavGroups(NAV_GROUPS, ctx);
  });

  readonly user = this.auth.user;
  /** First letter of the name, for the avatar. */
  readonly initial = computed(() => (this.user()?.name ?? '').trim().charAt(0) || '؟');
  /** "المالك" / "كاشير" …, or "صلاحيات مخصصة" when the template was edited (or role custom). */
  readonly roleLabelKey = computed(() => userRoleLabelKey(this.user()));
  changePasswordOpen = false;

  private readonly url = toSignal(
    this._router.events.pipe(
      filter((event) => event instanceof NavigationEnd),
      map(() => this._router.url)
    ),
    { initialValue: this._router.url }
  );

  ngOnInit(): void {
    // App start (the frame is created once): category list + product-exists flag for the POS chips,
    // as the sidebar category item did before Stage 11. Only for users who may view products.
    if (this.auth.has('products.view')) this._catalog.refresh();
  }

  /** Active on the item's route itself and on its `activePaths` prefixes. */
  isPathActive(item: NavItem): boolean {
    const path = this.url().split(/[?#]/)[0];
    return path === item.route || (item.activePaths ?? []).some((prefix) => path.startsWith(prefix));
  }

  setLanguage(lang: 'ar' | 'en'): void {
    if (this.language() !== lang) this._languageService.changeLanguage(lang);
  }

  toggleTheme(): void {
    this._themeService.toggleTheme();
  }

  /**
   * Signs out in this browser. Stage 15: asks first when a screen has unsaved work (POS cart, a form
   * being filled; UnsavedWorkService).
   */
  async logout(): Promise<void> {
    if (!(await this.unsaved.confirm())) return;
    this.unsaved.allowNextNavigation();
    this.state.closeDrawer();
    this.auth.logout();
    await this._router.navigate(['/login']);
  }
}

export function userRoleLabelKey(user: { role: string; permissionsEdited?: boolean } | null): string {
  if (!user) return '';
  if (user.role === 'custom' || (user.role !== 'owner' && user.permissionsEdited)) return 'auth.roles.customized';
  return `auth.roles.${user.role}`;
}
