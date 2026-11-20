import { ChangeDetectionStrategy, Component, afterNextRender, computed, inject } from '@angular/core';
import { DOCUMENT } from '@angular/common';
import { NavigationEnd, Router, RouterOutlet } from '@angular/router';
import { AttributionService } from './core/attribution.service';
import { AuthService } from './core/auth.service';
import { PixelsService } from './core/pixels.service';
import { ConsentBarComponent } from './ui/consent-bar';
import { CartService } from './core/cart.service';
import { AR } from './core/i18n/ar';
import { SettingsStore } from './core/settings.store';
import { FooterComponent } from './layout/footer';
import { HeaderComponent } from './layout/header';
import { StateViewComponent } from './ui/state-view';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, HeaderComponent, FooterComponent, StateViewComponent, ConsentBarComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '[style.--brand]': 'settings.brand()', class: 'shell' },
  template: `
    <a class="skip" href="#main" (click)="focusMain($event)">{{ t.skip }}</a>
    @if (settings.closed()) {
      <main id="main" tabindex="-1"><app-state-view kind="closed" /></main>
    } @else if (settings.down()) {
      <app-header />
      <main id="main" tabindex="-1"><app-state-view kind="down" /></main>
    } @else {
      @if (announcement(); as text) { <div class="announce">{{ text }}</div> }
      <app-header />
      @if (!settings.orderingOn()) { <div class="off" role="status">{{ t.orderingOff }}</div> }
      <main id="main" tabindex="-1"><router-outlet /></main>
      <app-footer />
      <app-consent-bar />
    }
  `,
  styles: [`
    :host { display: flex; flex-direction: column; min-height: 100vh; }
    main { flex: 1; outline: none; }
    .announce { background: var(--brand); color: var(--on-brand); font-size: 13px; text-align: center; padding: 9px 16px; }
    .off { background: var(--danger-bg); color: var(--danger); font-weight: 700; text-align: center; padding: 10px 16px; }
  `],
})
export class App {
  protected readonly t = AR;
  protected readonly settings = inject(SettingsStore);
  private readonly cart = inject(CartService);
  private readonly auth = inject(AuthService);
  private readonly doc = inject(DOCUMENT);
  protected readonly announcement = computed(() => this.settings.settings()?.announcement?.text || '');

  private readonly attribution = inject(AttributionService);
  private readonly pixels = inject(PixelsService);
  private readonly router = inject(Router);

  constructor() {
    // Browser only: the cart and the customer token are read after the first render, so server and browser render the same page first.
    afterNextRender(() => {
      this.cart.load();
      void this.auth.load();
      // Online Stage 7A: remember the campaign the visitor came from (last click wins), count the visit, then start the pixels.
      const landing = this.attribution.capture(window.location.search);
      if (landing) this.attribution.recordVisit(landing.code);
      this.pixels.start(this.settings.settings()?.marketing);
      // A page view on every later navigation (the first one is sent when the pixels load).
      this.router.events.subscribe((event) => { if (event instanceof NavigationEnd) this.pixels.track({ name: 'PageView' }); });
    });
  }

  protected focusMain(event: Event): void {
    event.preventDefault();
    this.doc.getElementById('main')?.focus();
  }
}
