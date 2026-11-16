import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import { Router } from '@angular/router';
import { ApiService } from '../core/api.service';
import { AR } from '../core/i18n/ar';
import { Product } from '../core/models';
import { ListingData, Loaded } from '../core/resolvers';
import { SeoService } from '../core/seo.service';
import { ProductCardComponent } from '../ui/product-card';
import { StateViewComponent } from '../ui/state-view';

/** Category page (/c/:id/:slug) and search page (/search?q=): the same list with sort and "load more". */
@Component({
  selector: 'app-listing',
  imports: [ProductCardComponent, StateViewComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @switch (loaded().state) {
      @case ('notfound') { <app-state-view kind="notfound" /> }
      @case ('down') { <app-state-view kind="down" /> }
      @default {
        <div class="wrap page">
          <div class="row between">
            <div class="stack" style="gap:4px">
              <h1 class="h1">{{ heading() }}</h1>
              <span class="muted num" role="status">{{ t.listing.results(total()) }}</span>
            </div>
            <label class="lb sort">
              {{ t.listing.sortLabel }}
              <select class="in" [value]="sort()" (change)="setSort($any($event.target).value)">
                @for (s of sorts; track s) { <option [value]="s" [selected]="s === sort()">{{ t.listing.sort[s] }}</option> }
              </select>
            </label>
          </div>
          @if (products().length) {
            <div class="grid-products">@for (p of products(); track p.id; let i = $index) { <app-product-card [product]="p" [eager]="i < 4" /> }</div>
            @if (hasMore()) {
              <button type="button" class="btn outline" style="align-self:center" [disabled]="busy()" (click)="more()">{{ t.listing.more }}</button>
            }
          } @else {
            <p class="empty">{{ isSearch() ? t.listing.searchEmpty : t.listing.categoryEmpty }}</p>
          }
        </div>
      }
    }
  `,
  styles: ['.sort { min-width: 180px; }'],
})
export class ListingPage {
  protected readonly t = AR;
  private readonly api = inject(ApiService);
  private readonly router = inject(Router);
  private readonly seo = inject(SeoService);
  protected readonly sorts = ['newest', 'bestselling', 'price-asc', 'price-desc', 'name'];

  readonly loaded = input.required<Loaded<ListingData>>({ alias: 'listing' });
  /** Bound from the query string by withComponentInputBinding. */
  readonly sortParam = input<string | undefined>(undefined, { alias: 'sort' });
  readonly id = input<string | undefined>(undefined);

  private readonly extra = signal<Product[]>([]);
  private readonly nextPage = signal<number | null>(null);
  protected readonly busy = signal(false);

  private readonly data = computed(() => { const l = this.loaded(); return l.state === 'ok' ? l.data : null; });
  protected readonly sort = computed(() => (this.sortParam() && this.sorts.includes(this.sortParam()!) ? this.sortParam()! : 'newest'));
  protected readonly isSearch = computed(() => !this.data()?.category);
  protected readonly heading = computed(() => (this.isSearch() ? (this.data()?.query ? AR.listing.searchTitle(this.data()!.query) : AR.home.allTitle) : this.data()?.title ?? ''));
  protected readonly products = computed(() => [...(this.data()?.page.data ?? []), ...this.extra()]);
  protected readonly total = computed(() => this.data()?.page.pagination.totalItems ?? 0);
  protected readonly hasMore = computed(() => {
    const p = this.data()?.page.pagination;
    return !!p && (this.nextPage() ?? p.page + 1) <= p.totalPages;
  });

  constructor() {
    effect(() => {
      const d = this.data();
      this.extra.set([]);
      this.nextPage.set(null);
      if (!d) return;
      const path = d.category ? `/c/${d.category.id}/${d.correctSlug}` : '/search';
      this.seo.set({
        title: this.heading(),
        description: d.category ? `${d.category.name}` : undefined,
        path,
        // search results are not worth indexing; a category page is
        noindex: !d.category,
      });
    });
  }

  protected setSort(value: string): void {
    void this.router.navigate([], { queryParams: { sort: value === 'newest' ? null : value }, queryParamsHandling: 'merge' });
  }

  protected async more(): Promise<void> {
    const d = this.data();
    if (!d || this.busy()) return;
    this.busy.set(true);
    try {
      const page = this.nextPage() ?? d.page.pagination.page + 1;
      const result = await this.api.products({ page, limit: 24, sort: this.sort(), ...(d.category ? { category: d.category.id } : { q: d.query }) });
      this.extra.update((rows) => [...rows, ...result.data.filter((p) => !rows.some((r) => r.id === p.id))]);
      this.nextPage.set(result.pagination.hasNextPage ? page + 1 : result.pagination.totalPages + 1);
    } finally {
      this.busy.set(false);
    }
  }
}
