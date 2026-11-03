import { isPlatformBrowser } from '@angular/common';
import { AfterViewInit, Component, DestroyRef, Inject, PLATFORM_ID, inject, signal } from '@angular/core';
import { Router, RouterOutlet } from '@angular/router';
import { getDesktopBridge } from './core/runtime/runtime-config';
import { environment } from '../environments/environment';
import { ConnectionOverlayComponent } from './offline/connection-overlay.component';
import { VersionNoticeComponent } from './offline/version-notice.component';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, ConnectionOverlayComponent, VersionNoticeComponent],
  templateUrl: './app.html',
  styleUrl: './app.scss'
})
export class App implements AfterViewInit {
  protected readonly title = signal('okland-warranty-system');
  /** Offline desktop edition: connection overlay and version notice. */
  protected readonly offline = environment.offline;


  constructor(@Inject(PLATFORM_ID) private platformId: Object) {
    // Offline edition: the tray menu can open a page, e.g. backup and restore.
    const onNavigate = this.offline ? getDesktopBridge()?.onNavigate : undefined;
    if (onNavigate) {
      const router = inject(Router);
      const unsubscribe = onNavigate((url) => router.navigateByUrl(url));
      inject(DestroyRef).onDestroy(unsubscribe);
    }
  }

  ngAfterViewInit() {
    // Only run in the browser
    if (isPlatformBrowser(this.platformId)) {
      const splash = document.getElementById('splash-screen');
      if (splash) {
        splash.classList.add('fade-out');
        setTimeout(() => splash.remove(), 500);
      }
    }
  }
}
