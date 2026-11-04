import { Component, DestroyRef, inject } from '@angular/core';
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
export class App {
  /** Offline desktop edition: connection overlay and version notice. */
  protected readonly offline = environment.offline;


  constructor() {
    // Offline edition: the tray menu can open a page, e.g. backup and restore.
    const onNavigate = this.offline ? getDesktopBridge()?.onNavigate : undefined;
    if (onNavigate) {
      const router = inject(Router);
      const unsubscribe = onNavigate((url) => router.navigateByUrl(url));
      inject(DestroyRef).onDestroy(unsubscribe);
    }
  }
}
