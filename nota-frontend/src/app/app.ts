import { Component, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRouteSnapshot, NavigationEnd, Router, RouterOutlet } from '@angular/router';
import { filter } from 'rxjs';
import { LanguageService } from './modules/shared/services/translation.service';
import { ThemeService } from './modules/shared/services/theme.service';
import { SideNavComponent } from './modules/layout/components/side-nav/side-nav.component';
import { ToastsComponent } from './core/auth/toasts.component';
import { LockOverlayComponent } from './core/auth/lock-overlay.component';
import { IdleLockService } from './core/auth/idle-lock.service';
import { UnsavedWorkDialogComponent } from './core/unsaved-work/unsaved-work-dialog.component';
import { DeviceNameDialogComponent } from './modules/auth/device-name-dialog/device-name-dialog.component';

@Component({
  selector: 'app-root',
  imports: [
    RouterOutlet,
    SideNavComponent,
    ToastsComponent,
    LockOverlayComponent,
    UnsavedWorkDialogComponent,
    DeviceNameDialogComponent,
  ],
  templateUrl: './app.html',
  styleUrl: './app.scss'
})
export class App {
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

    // Stage 15: idle auto-lock (and the token refresh on activity) for this window.
    inject(IdleLockService).start(destroyRef);
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
