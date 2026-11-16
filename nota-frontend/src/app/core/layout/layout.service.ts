import { DestroyRef, Injectable, inject, signal } from '@angular/core';

/** Online Stage 6A: below this width the admin app uses the phone layout; at and above it nothing changes. */
export const MOBILE_MAX_WIDTH = 767.98;
export const MOBILE_QUERY = `(max-width: ${MOBILE_MAX_WIDTH}px)`;

/**
 * One app, two layouts: `isMobile` follows the same media query the mobile styles use, so templates and CSS never disagree.
 * Root singleton; reacts live to rotation / window resize.
 */
@Injectable({ providedIn: 'root' })
export class LayoutService {
  readonly isMobile = signal(false);

  constructor() {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(MOBILE_QUERY);
    this.isMobile.set(query.matches);
    const onChange = (event: MediaQueryListEvent): void => this.isMobile.set(event.matches);
    query.addEventListener('change', onChange);
    inject(DestroyRef).onDestroy(() => query.removeEventListener('change', onChange));
  }
}
