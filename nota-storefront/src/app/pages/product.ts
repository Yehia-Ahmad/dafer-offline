import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { CartService, MAX_QTY } from '../core/cart.service';
import { money, whatsappLink } from '../core/format';
import { AR } from '../core/i18n/ar';
import { Loaded, ProductData } from '../core/resolvers';
import { SeoService, productJsonLd, trimText } from '../core/seo.service';
import { SettingsStore } from '../core/settings.store';
import { categoryPath } from '../core/slug';
import { IconComponent } from '../ui/icon';
import { ProductCardComponent } from '../ui/product-card';
import { StateViewComponent } from '../ui/state-view';

@Component({
  selector: 'app-product',
  imports: [RouterLink, IconComponent, ProductCardComponent, StateViewComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @switch (loaded().state) {
      @case ('notfound') { <app-state-view kind="notfound" /> }
      @case ('down') { <app-state-view kind="down" /> }
      @default {
        @if (data(); as d) {
          <div class="wrap page" style="gap:32px">
            <nav class="crumbs" [attr.aria-label]="t.product.breadcrumb">
              <a routerLink="/">{{ t.product.home }}</a><span aria-hidden="true">/</span>
              <a [routerLink]="catPath()">{{ d.product.category.name }}</a><span aria-hidden="true">/</span>
              <span aria-current="page">{{ d.product.name }}</span>
            </nav>
            <div class="cols">
              <section class="gallery" [attr.aria-label]="t.product.gallery">
                <div class="main-img">
                  @if (image(); as src) {
                    <img [src]="src" [alt]="d.product.name" width="800" height="600" loading="eager" fetchpriority="high" decoding="async" />
                  } @else {
                    <span class="ph"><app-icon name="image" [size]="56" /><span class="sr-only">{{ t.product.mainImage }}</span></span>
                  }
                </div>
                @if (d.product.images.length > 1) {
                  <div class="thumbs">
                    @for (src of d.product.images; track src; let i = $index) {
                      <button type="button" class="thumb" [class.on]="i === index()" (click)="index.set(i)" [attr.aria-label]="t.product.imageN(i + 1)" [attr.aria-pressed]="i === index()">
                        <img [src]="src" alt="" width="160" height="120" loading="lazy" />
                      </button>
                    }
                  </div>
                }
              </section>

              <section class="info">
                @if (badge(); as b) { <span class="badge" [class.out]="out()" style="align-self:flex-start">{{ b }}</span> }
                <h1 class="title">{{ d.product.name }}</h1>
                <p class="muted small">
                  @if (d.product.code) { {{ t.product.code }} <span class="num">{{ d.product.code }}</span> · }
                  {{ t.product.category }} {{ d.product.category.name }}
                </p>
                <div class="row" style="gap:14px;align-items:baseline">
                  <span class="big-price num">{{ fmt(d.product.finalPrice) }}</span>
                  @if (d.product.discountPercentage > 0) { <span class="old num" style="font-size:18px">{{ fmt(d.product.price) }}</span> }
                </div>
                <p class="stock" [class.low]="d.product.availability === 'low'" [class.none]="out()">
                  <span class="dot" aria-hidden="true"></span>
                  <strong>{{ out() ? t.product.outOfStock : (d.product.availability === 'low' ? t.product.low : t.product.inStock) }}</strong>
                  @if (d.product.remaining) { <span>· {{ t.product.remaining(d.product.remaining) }}</span> }
                </p>

                <div class="buy">
                  <div class="qty" role="group" [attr.aria-label]="t.product.qty">
                    <button type="button" (click)="step(1)" [disabled]="!canBuy() || qty() >= cap()" [attr.aria-label]="t.product.inc"><app-icon name="plus" /></button>
                    <span class="num" aria-live="polite" aria-atomic="true">{{ qty() }}</span>
                    <button type="button" (click)="step(-1)" [disabled]="!canBuy() || qty() <= 1" [attr.aria-label]="t.product.dec"><app-icon name="minus" /></button>
                  </div>
                  <button type="button" class="btn big grow" [disabled]="!canBuy()" (click)="add()">
                    {{ out() ? t.product.outOfStock : (settings.orderingOn() ? t.product.addWithTotal(fmt(d.product.finalPrice * qty())) : t.orderingOff) }}
                  </button>
                </div>
                @if (qty() >= cap() && cap() > 0 && !out()) { <p class="muted small" role="status">{{ t.product.max(cap()) }}</p> }
                @if (added()) { <p class="note" role="status">{{ t.card.added }} · <a routerLink="/cart">{{ t.header.cart }}</a></p> }
                @if (ask(); as link) { <a class="btn outline" [href]="link" target="_blank" rel="noopener"><app-icon name="chat" /> {{ t.product.askWhatsapp }}</a> }

                @if (d.product.specifications?.length) {
                  <section class="specs" [attr.aria-label]="t.product.specs">
                    @for (s of d.product.specifications; track s.label) { <div class="sp"><span class="muted">{{ s.label }}</span><strong>{{ s.value }}</strong></div> }
                  </section>
                }
                @if (d.product.description) { <p class="desc">{{ d.product.description }}</p> }
              </section>
            </div>

            @if (d.related.length) {
              <section class="stack" aria-labelledby="rel">
                <h2 class="h2" id="rel" style="font-size:24px">{{ t.product.related }}</h2>
                <div class="grid-products sm">@for (p of d.related; track p.id) { <app-product-card [product]="p" [compact]="true" /> }</div>
              </section>
            }
          </div>
        }
      }
    }
  `,
  styles: [`
    .crumbs { display: flex; flex-wrap: wrap; gap: 6px 10px; font-size: 13px; color: var(--text-muted); align-items: center; }
    .crumbs a { display: inline-flex; min-height: 32px; align-items: center; }
    .cols { display: flex; flex-wrap: wrap; gap: 40px; align-items: flex-start; }
    .gallery { flex: 1 1 440px; display: flex; flex-direction: column; gap: 12px; min-width: 0; }
    .main-img { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); height: 480px; display: flex; align-items: center; justify-content: center; overflow: hidden; }
    .main-img img { width: 100%; height: 100%; object-fit: contain; }
    .ph { color: var(--text-muted); }
    .thumbs { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
    .thumb { padding: 0; height: 96px; background: var(--placeholder); border: 1px solid var(--border); border-radius: var(--radius-control); overflow: hidden; }
    .thumb.on { border: 3px solid var(--brand); }
    .thumb img { width: 100%; height: 100%; object-fit: cover; }
    .info { flex: 1 1 400px; display: flex; flex-direction: column; gap: 16px; min-width: 0; }
    .title { font-size: 32px; font-weight: 800; line-height: 1.35; }
    .small { font-size: 13px; }
    .big-price { font-size: 36px; font-weight: 800; color: var(--brand); }
    .stock { display: flex; align-items: center; gap: 8px; color: var(--brand); }
    .stock.low { color: var(--danger); }
    .stock.none { color: var(--text-body); }
    .dot { width: 10px; height: 10px; border-radius: 999px; background: currentColor; }
    .buy { display: flex; flex-wrap: wrap; gap: 12px; }
    .grow { flex: 1 1 220px; }
    .qty { display: inline-flex; align-items: center; border: 1px solid var(--border-strong); border-radius: var(--radius-control); background: var(--surface); }
    .qty button { width: 48px; height: 52px; background: none; border: 0; display: inline-flex; align-items: center; justify-content: center; color: var(--text); }
    .qty button:disabled { color: var(--disabled); cursor: not-allowed; }
    .qty span { min-width: 40px; text-align: center; font-weight: 700; font-size: 17px; }
    .specs { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 6px 18px; }
    .sp { display: flex; justify-content: space-between; gap: 12px; padding: 12px 0; border-bottom: 1px solid var(--divider); font-size: 14px; }
    .sp:last-child { border-bottom: 0; }
    .desc { line-height: 1.8; white-space: pre-line; }
    @media (max-width: 640px) { .main-img { height: 320px; } .title { font-size: 24px; } .big-price { font-size: 30px; } .cols { gap: 24px; } }
  `],
})
export class ProductPage {
  protected readonly t = AR;
  protected readonly settings = inject(SettingsStore);
  private readonly cart = inject(CartService);
  private readonly seo = inject(SeoService);

  readonly loaded = input.required<Loaded<ProductData>>({ alias: 'product' });
  protected readonly data = computed(() => { const l = this.loaded(); return l.state === 'ok' ? l.data : null; });
  protected readonly index = signal(0);
  protected readonly qty = signal(1);
  protected readonly added = signal(false);
  protected fmt = money;

  protected readonly out = computed(() => { const p = this.data()?.product; return !p || p.availability === 'out_of_stock' || p.maxOrderQty < 1; });
  protected readonly cap = computed(() => Math.min(this.data()?.product.maxOrderQty ?? 0, MAX_QTY));
  protected readonly canBuy = computed(() => !this.out() && this.settings.orderingOn());
  protected readonly image = computed(() => this.data()?.product.images[this.index()] ?? null);
  protected readonly catPath = computed(() => { const c = this.data()?.product.category; return c ? categoryPath(c) : ['/']; });
  protected readonly badge = computed(() => {
    const p = this.data()?.product;
    if (!p) return '';
    if (this.out()) return AR.card.badge['out_of_stock'];
    return p.discountPercentage > 0 ? AR.card.discountPct(Math.round(p.discountPercentage)) : (p.badges?.includes('new') ? AR.card.badge['new'] : '');
  });
  protected readonly ask = computed(() => {
    const p = this.data()?.product;
    return p ? whatsappLink(this.settings.whatsapp(), AR.product.whatsappAsk(p.name, `${this.seo.origin()}/p/${p.id}/${encodeURIComponent(p.slug)}`)) : null;
  });

  constructor() {
    effect(() => {
      const d = this.data();
      this.index.set(0);
      this.qty.set(1);
      this.added.set(false);
      if (!d) return;
      const origin = this.seo.origin();
      this.seo.set({
        title: d.product.name,
        description: trimText(`${d.product.name}. ${d.product.description || ''} ${this.settings.settings()?.seoDescription || ''}`),
        path: `/p/${d.product.id}/${encodeURIComponent(d.product.slug)}`,
        image: d.product.images[0] || null,
        type: 'product',
        jsonLd: productJsonLd(d.product, origin),
      });
    });
  }

  protected step(by: number): void { this.qty.update((q) => Math.max(1, Math.min(this.cap() || 1, q + by))); }

  protected add(): void {
    const p = this.data()?.product;
    if (!p || !this.canBuy()) return;
    this.cart.add(p, this.qty());
    this.added.set(true);
  }
}
