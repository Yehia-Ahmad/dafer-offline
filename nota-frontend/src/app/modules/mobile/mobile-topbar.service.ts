import { Injectable, Injector, effect, inject, signal, untracked } from '@angular/core';
import { Router, NavigationStart } from '@angular/router';

/** What a phone screen puts in the shell's top bar (Online Stage 6B). Absent title = the menu label of the route. */
export interface TopBarState {
  title: string;
  subtitle?: string | null;
  /** Called first when back is pressed; return true when the screen handled it (for example a statement opened inside a list). */
  onBack?: () => boolean;
}

/**
 * The phone's top bar shows the page's own title ("تعديل مورد", the cash box's name) instead of a big title inside the page.
 * A screen calls `bind(() => ({ title, subtitle }))` in its constructor; the state is cleared on every navigation.
 */
@Injectable({ providedIn: 'root' })
export class MobileTopBarService {
  private readonly injector = inject(Injector);
  readonly state = signal<TopBarState | null>(null);

  constructor() {
    inject(Router).events.subscribe((event) => { if (event instanceof NavigationStart) this.state.set(null); });
  }

  /** Reactive: the top bar follows the signals read inside `read`. Call from an injection context (constructor / field initializer). */
  bind(read: () => TopBarState | null): void {
    effect(() => {
      const next = read();
      untracked(() => this.state.set(next));
    }, { injector: this.injector });
  }

  /** Back pressed: true when the screen consumed it. */
  handleBack(): boolean {
    return this.state()?.onBack?.() === true;
  }
}
