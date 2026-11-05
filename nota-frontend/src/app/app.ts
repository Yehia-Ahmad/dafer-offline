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
import { ToastsComponent } from './core/auth/toasts.component';
import { LockOverlayComponent } from './core/auth/lock-overlay.component';
import { IdleLockService } from './core/auth/idle-lock.service';
import { AuthService } from './core/auth/auth.service';
import { UnsavedWorkDialogComponent } from './core/unsaved-work/unsaved-work-dialog.component';
import { UnsavedWorkService } from './core/unsaved-work/unsaved-work.service';
import { OtherMainBannerComponent } from './offline/other-main-banner.component';

@Component({
  selector: 'app-root',
  imports: [
    RouterOutlet,
    SideNavComponent,
    ConnectionOverlayComponent,
    VersionNoticeComponent,
    ToastsComponent,
    LockOverlayComponent,
    UnsavedWorkDialogComponent,
    OtherMainBannerComponent,
  ],
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

    const destroyRef = inject(DestroyRef);
    // Offline edition: the tray menu can open a page, e.g. backup and restore.
    const onNavigate = this.offline ? getDesktopBridge()?.onNavigate : undefined;
    if (onNavigate) {
      const unsubscribe = onNavigate((url) => router.navigateByUrl(url));
      destroyRef.onDestroy(unsubscribe);
    }

    // Stage 15: idle auto-lock (and the token refresh on activity) for this window.
    inject(IdleLockService).start(destroyRef);

    // Stage 15: a backup was restored on the main PC: its users replaced ours, so sign in again.
    const onSessionReset = this.offline ? getDesktopBridge()?.onSessionReset : undefined;
    if (onSessionReset) {
      const auth = inject(AuthService);
      const unsaved = inject(UnsavedWorkService);
      destroyRef.onDestroy(
        onSessionReset(() => {
          unsaved.allowNextNavigation();
          auth.clear();
          router.navigate(['/login'], { queryParams: { reason: 'restored' } });
        })
      );
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
