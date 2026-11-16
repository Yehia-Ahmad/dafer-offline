import { ChangeDetectionStrategy, Component, computed, effect, inject, input } from '@angular/core';
import { money } from '../core/format';
import { AR } from '../core/i18n/ar';
import { PageStatus } from '../core/page-status.service';
import { Loaded } from '../core/resolvers';
import { Zone } from '../core/models';
import { SeoService } from '../core/seo.service';
import { SettingsStore } from '../core/settings.store';
import { StateViewComponent } from '../ui/state-view';

/** /policies/returns and /policies/terms: the shop's own text from the public settings, server-rendered. */
@Component({
  selector: 'app-policy',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="wrap page narrow">
      <h1 class="h1">{{ title() }}</h1>
      @if (text(); as body) { <div class="prose">{{ body }}</div> } @else { <p class="empty">{{ t.policy.noPolicy }}</p> }
    </div>
  `,
})
export class PolicyPage {
  protected readonly t = AR;
  private readonly settings = inject(SettingsStore);
  private readonly seo = inject(SeoService);
  /** 'returns' | 'terms', from the route data. */
  readonly kind = input.required<'returns' | 'terms'>();
  protected readonly title = computed(() => (this.kind() === 'returns' ? AR.policy.returnsTitle : AR.policy.termsTitle));
  protected readonly text = computed(() => (this.kind() === 'returns' ? this.settings.settings()?.returnsPolicy : this.settings.settings()?.terms) || '');

  constructor() {
    effect(() => this.seo.set({ title: this.title(), description: this.text(), path: `/policies/${this.kind()}` }));
  }
}

/** /delivery: zones and fees. */
@Component({
  selector: 'app-delivery',
  imports: [StateViewComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (loaded().state === 'down') { <app-state-view kind="down" /> } @else {
      <div class="wrap page narrow">
        <h1 class="h1">{{ t.policy.deliveryTitle }}</h1>
        @if (freeFrom(); as f) { <p class="note">{{ t.policy.freeFrom(fmt(f)) }}</p> }
        @if (cutoff(); as c) { <p class="note">{{ t.policy.sameDay(c) }}</p> }
        @if (zones().length) {
          <table class="table">
            <thead><tr><th scope="col">{{ t.policy.zone }}</th><th scope="col">{{ t.policy.fee }}</th><th scope="col">{{ t.policy.time }}</th></tr></thead>
            <tbody>@for (z of zones(); track z.id) { <tr><th scope="row">{{ z.name }}</th><td class="num">{{ fmt(z.fee) }}</td><td>{{ z.estimatedTime || '—' }}</td></tr> }</tbody>
          </table>
        } @else { <p class="empty">{{ t.policy.noZones }}</p> }
      </div>
    }
  `,
})
export class DeliveryPage {
  protected readonly t = AR;
  private readonly settings = inject(SettingsStore);
  private readonly seo = inject(SeoService);
  readonly loaded = input.required<Loaded<Zone[]>>({ alias: 'zones' });
  protected readonly zones = computed(() => { const l = this.loaded(); return l.state === 'ok' ? l.data : []; });
  protected readonly freeFrom = computed(() => this.settings.settings()?.freeDeliveryFrom || 0);
  protected readonly cutoff = computed(() => this.settings.settings()?.sameDayCutoff || '');
  protected fmt = money;

  constructor() {
    effect(() => this.seo.set({ title: AR.policy.deliveryTitle, path: '/delivery' }));
  }
}

@Component({
  selector: 'app-not-found',
  imports: [StateViewComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<app-state-view kind="notfound" />`,
})
export class NotFoundPage {
  constructor() {
    inject(SeoService).set({ title: AR.notFound.title, path: '/404', noindex: true });
    inject(PageStatus).notFound();
  }
}
