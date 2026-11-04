import { isPlatformBrowser } from '@angular/common';
import { Component, computed, inject, PLATFORM_ID } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterModule } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { filter, map } from 'rxjs';
import { LanguageService } from '../../shared/services/translation.service';
import { ThemeService } from '../../shared/services/theme.service';
import { HOME_DEFAULT_VIEW, HOME_VIEW_STORAGE_KEY } from '../constants/home-view.constants';
import { brandName } from '../../../core/brand';
import { isOfflineMainPc } from '../../../core/runtime/app-features';
import { getDesktopRuntimeConfig } from '../../../core/runtime/runtime-config';
import { NAV_GROUPS, NavContext, visibleNavGroups } from '../nav/nav-menu.config';
import { NavIconComponent } from '../nav/nav-icon.component';
import { SidebarCategoriesComponent } from '../nav/sidebar-categories.component';
import { SidebarStateService } from '../nav/sidebar-state.service';

/**
 * Nota sidebar (docs/design/screens/Sidebar.dc.html): logo, grouped menu from NAV_GROUPS,
 * footer with language, theme and device. Category tools live in SidebarCategoriesComponent.
 */
@Component({
  selector: 'app-custom-sidenav',
  standalone: true,
  imports: [RouterModule, TranslatePipe, NavIconComponent, SidebarCategoriesComponent],
  templateUrl: './custom-sidenav.component.html',
  host: { class: 'nota-sidebar', '[class.is-rail]': 'state.collapsed()' },
})
export class CustomSidenavComponent {
  private readonly _languageService = inject(LanguageService);
  private readonly _themeService = inject(ThemeService);
  private readonly _router = inject(Router);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));
  protected readonly state = inject(SidebarStateService);

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
  readonly isHomeActive = computed(() => this.url().split(/[?#]/)[0] === '/home');

  setLanguage(lang: 'ar' | 'en'): void {
    if (this.language() !== lang) this._languageService.changeLanguage(lang);
  }

  toggleTheme(): void {
    this._themeService.toggleTheme();
  }

  /** Home link: same as the old "reset view" button, the home page opens on its first view. */
  onHomeClick(event: MouseEvent): void {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    this.resetHomeView();
  }

  resetHomeView() {
    if (this.isBrowser) {
      localStorage.setItem(HOME_VIEW_STORAGE_KEY, HOME_DEFAULT_VIEW);
    }
    this._router.navigate(['/home'], { queryParams: { resetView: Date.now() } });
  }
}

export function deviceLabelKey(role: 'main' | 'client' | null | undefined): string | null {
  if (role === 'main') return 'nav.deviceMain';
  if (role === 'client') return 'nav.deviceClient';
  return null;
}
