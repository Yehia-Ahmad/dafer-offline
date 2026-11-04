import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';
import { filter } from 'rxjs';

export const SIDEBAR_COLLAPSED_KEY = 'nota.sidebarCollapsed';
/** At or below this width the sidebar starts as the icon rail (1024×768 screens get the rail). */
export const RAIL_BREAKPOINT = 1024;
/** Below this width the sidebar is an overlay drawer opened from the menu button. */
export const DRAWER_BREAKPOINT = 768;

export type SidebarMode = 'full' | 'rail' | 'drawer';

/**
 * Sidebar layout state, shared by every page's shell (root singleton, so it survives navigation).
 * - >1024px: the user's saved choice for this device (default expanded).
 * - 768–1024px: starts as the rail; the user may expand it for the session.
 * - <768px: hidden; an overlay drawer opened by the menu button.
 */
@Injectable({ providedIn: 'root' })
export class SidebarStateService {
  private readonly width = signal(typeof window === 'undefined' ? RAIL_BREAKPOINT : window.innerWidth);
  private readonly narrowExpanded = signal(false);
  private readonly savedCollapsed = signal(readSavedCollapsed());

  readonly drawerOpen = signal(false);

  readonly isDrawer = computed(() => this.width() < DRAWER_BREAKPOINT);
  private readonly isNarrow = computed(() => this.width() <= RAIL_BREAKPOINT);

  /** Icon-only rail (labels hidden). The drawer always shows the full sidebar. */
  readonly collapsed = computed(() => {
    if (this.isDrawer()) return false;
    if (this.isNarrow()) return !this.narrowExpanded();
    return this.savedCollapsed();
  });

  readonly mode = computed<SidebarMode>(() => (this.isDrawer() ? 'drawer' : this.collapsed() ? 'rail' : 'full'));

  constructor() {
    // The drawer closes once a link inside it has navigated.
    inject(Router).events.pipe(filter((e) => e instanceof NavigationEnd)).subscribe(() => this.closeDrawer());

    if (typeof window === 'undefined') return;
    const onResize = () => {
      const before = this.isDrawer();
      this.width.set(window.innerWidth);
      if (before && !this.isDrawer()) this.drawerOpen.set(false);
    };
    window.addEventListener('resize', onResize);
    inject(DestroyRef).onDestroy(() => window.removeEventListener('resize', onResize));
  }

  toggleCollapsed(): void {
    this.setCollapsed(!this.collapsed());
  }

  setCollapsed(collapsed: boolean): void {
    if (this.isDrawer()) return;
    if (this.isNarrow()) {
      this.narrowExpanded.set(!collapsed);
      return;
    }
    this.savedCollapsed.set(collapsed);
    try {
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(collapsed));
    } catch {
      // Storage unavailable: the choice lasts for this session only.
    }
  }

  openDrawer(): void {
    this.drawerOpen.set(true);
  }

  closeDrawer(): void {
    this.drawerOpen.set(false);
  }
}

function readSavedCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true';
  } catch {
    return false;
  }
}
