import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AR } from '../core/i18n/ar';
import { SettingsStore } from '../core/settings.store';

/** The closed page (shop logo + closedMessage), the "temporary problem" page and the 404 page: one simple centred card. */
@Component({
  selector: 'app-state-view',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="state wrap" [attr.aria-labelledby]="'state-title'">
      @if (kind() === 'closed') {
        @if (logo(); as src) { <img class="state-logo" [src]="src" alt="" width="96" height="96" /> }
        <h1 class="h1" id="state-title">{{ shop() || t.closed.title }}</h1>
        <p class="muted state-msg">{{ message() }}</p>
      } @else if (kind() === 'down') {
        <h1 class="h1" id="state-title">{{ t.apiDown.title }}</h1>
        <p class="muted">{{ t.apiDown.text }}</p>
        <a class="btn" href="" (click)="reload($event)">{{ t.apiDown.retry }}</a>
      } @else {
        <h1 class="h1" id="state-title">{{ t.notFound.title }}</h1>
        <p class="muted">{{ t.notFound.text }}</p>
        <a class="btn" routerLink="/">{{ t.notFound.home }}</a>
      }
    </section>
  `,
  styles: [`
    .state { display: flex; flex-direction: column; align-items: center; text-align: center; gap: 16px; padding-top: 80px; padding-bottom: 96px; }
    .state-logo { width: 96px; height: 96px; border-radius: var(--radius); object-fit: cover; background: var(--placeholder); }
    .state-msg { max-width: 520px; font-size: 17px; white-space: pre-line; }
  `],
})
export class StateViewComponent {
  protected readonly t = AR;
  private readonly settings = inject(SettingsStore);
  readonly kind = input.required<'closed' | 'down' | 'notfound'>();
  protected readonly logo = computed(() => this.settings.settings()?.shop?.logoUrl || this.settings.settings()?.logoUrl || null);
  protected readonly shop = computed(() => this.settings.settings()?.shop?.name || '');
  protected readonly message = computed(() => this.settings.settings()?.closedMessage || AR.closed.defaultMessage);

  protected reload(event: Event): void {
    event.preventDefault();
    if (typeof location !== 'undefined') location.reload();
  }
}
