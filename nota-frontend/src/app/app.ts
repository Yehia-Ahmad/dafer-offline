import { Component, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRouteSnapshot, NavigationEnd, Router, RouterOutlet } from '@angular/router';
import { filter } from 'rxjs';
import { getDesktopBridge } from './core/runtime/runtime-config';
import { environment } from '../environments/environment';
import { LanguageService } from './modules/shared/services/translation.service';
import { ThemeService } from './modules/shared/services/theme.service';
import { ConnectionOverlayComponent } from './offline/connection-overlay.component';
import { VersionNoticeComponent } from './offline/version-notice.component';
import { SideNavComponent } from './modules/layout/components/side-nav/side-nav.component';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, SideNavComponent, ConnectionOverlayComponent, VersionNoticeComponent],
  templateUrl: './app.html',
  styleUrl: './app.scss'
})
export class App {
  /** Offline desktop edition: connection overlay and version notice. */
  protected readonly offline = environment.offline;
  /** False when the active route has `data: { frame: false }` (design previews such as /ui-kit). */
  protected readonly framed = signal(true);

  constructor() {
    // Created at startup so <html lang/dir> and the theme class are set before any page renders.
    inject(LanguageService);
    inject(ThemeService);

    const router = inject(Router);
    router.events
      .pipe(filter((event) => event instanceof NavigationEnd), takeUntilDestroyed())
      .subscribe(() => this.framed.set(routeWantsFrame(router.routerState.snapshot.root)));

    // Offline edition: the tray menu can open a page, e.g. backup and restore.
    const onNavigate = this.offline ? getDesktopBridge()?.onNavigate : undefined;
    if (onNavigate) {
      const unsubscribe = onNavigate((url) => router.navigateByUrl(url));
      inject(DestroyRef).onDestroy(unsubscribe);
    }
  }
}

/** The deepest active route decides; any level can opt out with data.frame === false. */
export function routeWantsFrame(root: ActivatedRouteSnapshot): boolean {
  let route: ActivatedRouteSnapshot | null = root;
  while (route) {
    if (route.data?.['frame'] === false) return false;
    route = route.firstChild;
  }
  return true;
}
