import { ChangeDetectionStrategy, Component, computed, effect, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { whatsappLink } from '../core/format';
import { AR } from '../core/i18n/ar';
import { Category } from '../core/models';
import { HomeData, Loaded } from '../core/resolvers';
import { SeoService } from '../core/seo.service';
import { SettingsStore } from '../core/settings.store';
import { categoryPath } from '../core/slug';
import { IconComponent } from '../ui/icon';
import { ProductCardComponent } from '../ui/product-card';
import { StateViewComponent } from '../ui/state-view';

@Component({
  selector: 'app-home',
  imports: [RouterLink, IconComponent, ProductCardComponent, StateViewComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (loaded().state === 'down') {
      <app-state-view kind="down" />
    } @else {
      <div class="wrap page">
        <section class="hero" aria-labelledby="hero-title">
          <div class="hero-text">
            @if (offers().length) { <span class="hero-chip">{{ t.home.heroChip }}</span> }
            <h1 id="hero-title">{{ title() }}</h1>
            @if (about()) { <p class="hero-sub">{{ about() }}</p> }
            <div class="row">
              <a class="btn light big" routerLink="/search" [queryParams]="{ q: '' }" fragment="all">{{ t.home.heroCta }}</a>
              @if (wa(); as link) { <a class="btn outline-light big" [href]="link" target="_blank" rel="noopener">{{ t.home.heroWhatsapp }}</a> }
            </div>
          </div>
          @if (banner(); as src) {
            <div class="hero-img"><img [src]="src" alt="" width="640" height="400" fetchpriority="high" loading="eager" /></div>
          }
        </section>

        @if (highlights().length) {
          <section class="hl" aria-label="">
            @for (h of highlights(); track h.title) {
              <div class="hl-card">
                <span class="hl-ic"><app-icon [name]="h.icon" [size]="32" [stroke]="1.6" /></span>
                <strong>{{ h.title }}</strong>
                <span class="muted small">{{ h.text }}</span>
              </div>
            }
          </section>
        }

        @if (categories().length) {
          <section id="cats" class="stack" aria-labelledby="cats-title">
            <h2 class="h2" id="cats-title">{{ t.home.categoriesTitle }}</h2>
            <div class="grid-cats">
              @for (c of categories(); track c.id) {
                <a class="cat" [routerLink]="path(c)">
                  <span class="cat-ic">
                    @if (c.imageUrl) { <img [src]="c.imageUrl" alt="" width="56" height="56" loading="lazy" /> } @else { <app-icon name="grid" [size]="28" [stroke]="1.6" /> }
                  </span>
                  <strong>{{ c.name }}</strong>
                  <span class="muted small num">{{ t.home.productsCount(c.productCount) }}</span>
                </a>
              }
            </div>
          </section>
        }

        @if (data()?.best?.length) {
          <section id="best" class="stack" aria-labelledby="best-title">
            <h2 class="h2" id="best-title">{{ t.home.bestTitle }}</h2>
            <div class="grid-products">@for (p of data()!.best; track p.id; let i = $index) { <app-product-card [product]="p" [eager]="i < 4" /> }</div>
          </section>
        }

        @if (data()?.offers?.length) {
          <section id="offers" class="stack" aria-labelledby="offers-title">
            <h2 class="h2" id="offers-title">{{ t.home.offersTitle }}</h2>
            <div class="grid-products">@for (p of data()!.offers; track p.id) { <app-product-card [product]="p" /> }</div>
          </section>
        }

        <section id="all" class="stack" aria-labelledby="all-title">
          <h2 class="h2" id="all-title">{{ t.home.allTitle }}</h2>
          @if (data()?.latest?.length) {
            <div class="grid-products">@for (p of data()!.latest; track p.id) { <app-product-card [product]="p" /> }</div>
            <a class="btn outline" routerLink="/search" [queryParams]="{ q: '' }">{{ t.home.showAll }}</a>
          } @else {
            <p class="empty">{{ t.home.empty }}</p>
          }
        </section>
      </div>
    }
  `,
  styles: [`
    .hero { background: var(--brand); color: var(--on-brand); border-radius: 24px; display: flex; flex-wrap: wrap; overflow: hidden; }
    .hero-text { flex: 1 1 420px; padding: 48px; display: flex; flex-direction: column; justify-content: center; gap: 18px; align-items: flex-start; }
    .hero h1 { font-size: 46px; font-weight: 800; line-height: 1.25; }
    .hero-sub { font-size: 18px; line-height: 1.7; color: color-mix(in srgb, #fff 86%, var(--brand)); white-space: pre-line; }
    .hero-chip { background: rgba(245, 243, 238, 0.16); border-radius: 999px; padding: 4px 14px; font-size: 13px; font-weight: 700; }
    .hero-img { flex: 1 1 380px; min-height: 300px; background: rgba(245, 243, 238, 0.1); }
    .hero-img img { width: 100%; height: 100%; object-fit: cover; }
    .btn.outline-light { background: transparent; color: var(--on-brand); border-color: rgba(245, 243, 238, 0.7); }
    .btn.outline-light:hover { color: var(--on-brand); background: rgba(245, 243, 238, 0.12); }
    .hl { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 14px; }
    .hl-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 20px; display: flex; flex-direction: column; gap: 6px; }
    .hl-card strong { font-size: 16px; }
    .hl-ic { color: var(--brand); }
    .small { font-size: 13px; }
    .cat { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 20px 16px; display: flex; flex-direction: column; align-items: center; gap: 6px; text-align: center; color: var(--text); }
    .cat:hover { border-color: var(--brand); color: var(--text); }
    .cat-ic { width: 56px; height: 56px; border-radius: var(--radius); background: var(--brand-tint); color: var(--brand); display: inline-flex; align-items: center; justify-content: center; overflow: hidden; }
    .cat-ic img { width: 100%; height: 100%; object-fit: cover; }
    @media (max-width: 640px) { .hero-text { padding: 28px 20px; } .hero h1 { font-size: 30px; } .hero-sub { font-size: 16px; } }
  `],
})
export class HomePage {
  protected readonly t = AR;
  private readonly settings = inject(SettingsStore);
  private readonly seo = inject(SeoService);

  readonly loaded = input.required<Loaded<HomeData>>({ alias: 'home' });
  protected readonly data = computed(() => { const l = this.loaded(); return l.state === 'ok' ? l.data : null; });
  protected readonly offers = computed(() => this.data()?.offers ?? []);
  protected readonly title = computed(() => this.settings.settings()?.title || this.settings.shopName());
  protected readonly about = computed(() => this.settings.settings()?.about || '');
  protected readonly categories = computed(() => this.settings.categories());
  protected readonly banner = computed(() => this.settings.settings()?.banners?.[0]?.imageUrl || null);
  protected readonly highlights = computed(() => this.settings.settings()?.highlights ?? []);
  protected readonly wa = computed(() => whatsappLink(this.settings.whatsapp()));

  constructor() {
    effect(() => {
      const s = this.settings.settings();
      this.seo.set({
        title: this.settings.shopName() || AR.brandFallbackName,
        description: s?.seoDescription || s?.about,
        path: '/',
        image: s?.banners?.[0]?.imageUrl || s?.logoUrl || null,
      });
    });
  }

  protected path(c: Category): string[] { return categoryPath(c); }
}
