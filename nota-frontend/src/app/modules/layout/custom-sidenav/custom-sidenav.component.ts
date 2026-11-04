import { Component, computed, inject, OnInit } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterModule } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { filter, map } from 'rxjs';
import { LanguageService } from '../../shared/services/translation.service';
import { ThemeService } from '../../shared/services/theme.service';
import { brandName } from '../../../core/brand';
import { isOfflineMainPc } from '../../../core/runtime/app-features';
import { getDesktopRuntimeConfig } from '../../../core/runtime/runtime-config';
import { NAV_GROUPS, NavContext, NavItem, visibleNavGroups } from '../nav/nav-menu.config';
import { NavIconComponent } from '../nav/nav-icon.component';
import { SidebarStateService } from '../nav/sidebar-state.service';
import { CatalogStateService } from '../nav/catalog-state.service';

/**
 * Nota sidebar (docs/design/screens/Sidebar.dc.html): logo, grouped menu from NAV_GROUPS,
 * footer with language, theme and device. Category tools live on the products page since Stage 11.
 */
@Component({
  selector: 'app-custom-sidenav',
  standalone: true,
  imports: [RouterModule, TranslatePipe, NavIconComponent],
  templateUrl: './custom-sidenav.component.html',
  host: { class: 'nota-sidebar', '[class.is-rail]': 'state.collapsed()' },
})
export class CustomSidenavComponent implements OnInit {
  private readonly _languageService = inject(LanguageService);
  private readonly _themeService = inject(ThemeService);
  private readonly _router = inject(Router);
  protected readonly state = inject(SidebarStateService);
  private readonly _catalog = inject(CatalogStateService);

  readonly language = this._languageService.selectedLanguage;
  readonly brandName = computed(() => brandName(this._languageService.selectedLanguage()));
  readonly isDark = toSignal(this._themeService.isDarkMode$, { initialValue: false });

  readonly navContext: NavContext = { isMainPc: isOfflineMainPc() };
  readonly groups = visibleNavGroups(NAV_GROUPS, this.navContext);

  /** "الجهاز الرئيسي" / "جهاز فرعي" from the desktop runtime config; nothing outside the desktop app. */
  readonly deviceLabelKey: string | null = deviceLabelKey(getDesktopRuntimeConfig()?.role);

  private readonly url = toSignal(
    this._router.events.pipe(
      filter((event) => event instanceof NavigationEnd),
      map(() => this._router.url)
    ),
    { initialValue: this._router.url }
  );

  ngOnInit(): void {
    // App start (the frame is created once): category list + product-exists flag for the POS chips,
    // as the sidebar category item did before Stage 11.
    this._catalog.refresh();
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
}

export function deviceLabelKey(role: 'main' | 'client' | null | undefined): string | null {
  if (role === 'main') return 'nav.deviceMain';
  if (role === 'client') return 'nav.deviceClient';
  return null;
}
