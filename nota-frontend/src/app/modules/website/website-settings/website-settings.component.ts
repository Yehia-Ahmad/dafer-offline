import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { TranslatePipe } from '@ngx-translate/core';
import { UnsavedWorkService } from '../../../core/unsaved-work/unsaved-work.service';
import { CatalogStateService } from '../../layout/nav/catalog-state.service';
import { ProductsService } from '../../products/services/products.service';
import { NotaButtonDirective, NotaFormFieldComponent, NotaPageHeaderComponent } from '../../shared/ui';
import { BannerLinkType, EMPTY_WEBSITE_SETTINGS, WEBSITE_LIMITS, WebsiteBanner, WebsiteSettings, WebsiteSettingsPayload } from '../website.models';
import { WebsiteService } from '../website.service';

type Outcome = { kind: 'saved' } | { kind: 'error'; message: string };

const URL_PATTERN = /^https?:\/\/\S+$/i;

/**
 * Online Stage 3: /website/settings. One page, sections: status, identity, banners, featured categories, contact and
 * social links, ordering rules, texts. GET/PUT /api/website/settings (website.manage). Leaving with unsaved changes asks first.
 */
@Component({
  selector: 'app-website-settings',
  imports: [TranslatePipe, ReactiveFormsModule, NotaButtonDirective, NotaFormFieldComponent, NotaPageHeaderComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './website-settings.component.html',
  styleUrl: './website-settings.component.scss',
})
export class WebsiteSettingsComponent implements OnInit {
  private readonly service = inject(WebsiteService);
  private readonly productsService = inject(ProductsService);
  private readonly catalog = inject(CatalogStateService);
  private readonly formBuilder = inject(FormBuilder);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly limits = WEBSITE_LIMITS;
  protected readonly categories = this.catalog.categories;

  protected readonly loading = signal(true);
  protected readonly loadError = signal(false);
  protected readonly saving = signal(false);
  protected readonly outcome = signal<Outcome | null>(null);
  protected readonly banners = signal<WebsiteBanner[]>([]);
  protected readonly featured = signal<string[]>([]);
  protected readonly bannerError = signal<string | null>(null);
  /** The product search of the banner whose link is being chosen. */
  protected readonly productSearch = signal<{ index: number; results: Array<{ _id: string; name: string }> } | null>(null);
  /** What was loaded or saved last, to tell whether anything changed. */
  private lastSnapshot = '';

  protected readonly form = this.formBuilder.nonNullable.group({
    enabled: [false],
    orderingEnabled: [true],
    closedMessage: ['', Validators.maxLength(WEBSITE_LIMITS.closedMessage)],
    title: ['', Validators.maxLength(WEBSITE_LIMITS.title)],
    about: ['', Validators.maxLength(WEBSITE_LIMITS.about)],
    whatsapp: ['', Validators.maxLength(100)],
    facebook: ['', [Validators.maxLength(300), Validators.pattern(URL_PATTERN)]],
    instagram: ['', [Validators.maxLength(300), Validators.pattern(URL_PATTERN)]],
    tiktok: ['', [Validators.maxLength(300), Validators.pattern(URL_PATTERN)]],
    // Strings while typing; a blank means "not set".
    minOrderAmount: ['', Validators.pattern(/^\d{1,9}(\.\d{1,2})?$/)],
    freeDeliveryFrom: ['', Validators.pattern(/^\d{1,9}(\.\d{1,2})?$/)],
    orderNote: ['', Validators.maxLength(WEBSITE_LIMITS.orderNote)],
    returnsPolicy: ['', Validators.maxLength(WEBSITE_LIMITS.returnsPolicy)],
    terms: ['', Validators.maxLength(WEBSITE_LIMITS.terms)],
  });

  protected readonly featuredFull = computed(() => this.featured().length >= WEBSITE_LIMITS.featured);
  protected readonly canAddBanner = computed(() => this.banners().length < WEBSITE_LIMITS.banners);

  constructor() {
    this.destroyRef.onDestroy(inject(UnsavedWorkService).register('website-settings', () => this.hasUnsavedChanges()));
  }

  /** A field, a banner or a featured category changed since the last load / save. */
  hasUnsavedChanges(): boolean {
    if (this.loading() || this.saving()) return false;
    return this.snapshot() !== this.lastSnapshot;
  }

  ngOnInit(): void {
    if (!this.catalog.categories().length) this.catalog.refresh();
    this.service
      .getSettings()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (settings) => {
          this.apply(settings);
          this.loading.set(false);
        },
        error: () => {
          this.loadError.set(true);
          this.loading.set(false);
        },
      });
  }

  protected showError(control: "facebook" | "instagram" | "tiktok" | "minOrderAmount" | "freeDeliveryFrom"): boolean {
    const field = this.form.controls[control];
    return field.invalid && (field.touched || field.dirty);
  }

  // ---- banners ----

  protected onBannerSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file || !this.canAddBanner()) return;
    if (!file.type.startsWith('image/')) return this.bannerError.set('website.settings.banners.invalidType');
    if (file.size > WEBSITE_LIMITS.bannerBytes) return this.bannerError.set('website.settings.banners.tooLarge');
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== 'string') return;
      this.banners.update((list) => [...list, { image: reader.result as string, linkType: 'none', linkId: null, sortOrder: list.length }]);
      this.bannerError.set(null);
    };
    reader.onerror = () => this.bannerError.set('website.settings.banners.readFailed');
    reader.readAsDataURL(file);
  }

  protected removeBanner(index: number): void {
    this.banners.update((list) => list.filter((_, i) => i !== index).map((banner, i) => ({ ...banner, sortOrder: i })));
    this.productSearch.set(null);
  }

  protected moveBanner(index: number, direction: -1 | 1): void {
    const target = index + direction;
    this.banners.update((list) => {
      if (target < 0 || target >= list.length) return list;
      const next = [...list];
      [next[index], next[target]] = [next[target], next[index]];
      return next.map((banner, i) => ({ ...banner, sortOrder: i }));
    });
    this.productSearch.set(null);
  }

  protected setLinkType(index: number, value: string): void {
    const linkType: BannerLinkType = value === 'category' || value === 'product' ? value : 'none';
    this.banners.update((list) => list.map((banner, i) => (i === index ? { ...banner, linkType, linkId: null } : banner)));
    this.productSearch.set(linkType === 'product' ? { index, results: [] } : null);
  }

  protected setLinkId(index: number, linkId: string): void {
    this.banners.update((list) => list.map((banner, i) => (i === index ? { ...banner, linkId: linkId || null } : banner)));
  }

  protected searchProducts(index: number, term: string): void {
    const query = term.trim();
    if (!query) return;
    this.productsService.searchProducts(query).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (res: any) => {
        const rows = Array.isArray(res) ? res : res?.data || [];
        this.productSearch.set({ index, results: rows.slice(0, 8).map((row: any) => ({ _id: row._id, name: row.name })) });
      },
      error: () => this.productSearch.set({ index, results: [] }),
    });
  }

  protected bannerLinkLabel(banner: WebsiteBanner): string {
    if (banner.linkType === 'category') return this.categories().find((category) => category.id === banner.linkId)?.label || '';
    return banner.linkId || '';
  }

  // ---- featured categories ----

  protected isFeatured(id: string): boolean {
    return this.featured().includes(id);
  }

  protected toggleFeatured(id: string): void {
    this.featured.update((list) => {
      if (list.includes(id)) return list.filter((item) => item !== id);
      return list.length >= WEBSITE_LIMITS.featured ? list : [...list, id];
    });
  }

  // ---- save ----

  protected cancel(): void {
    this.outcome.set(null);
    this.bannerError.set(null);
    this.productSearch.set(null);
    if (this.lastSnapshot) this.restore(JSON.parse(this.lastSnapshot));
  }

  protected save(): void {
    this.outcome.set(null);
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    if (this.banners().some((banner) => banner.linkType !== 'none' && !banner.linkId)) {
      this.bannerError.set('website.settings.banners.linkMissing');
      return;
    }
    const raw = this.form.getRawValue();
    const payload: WebsiteSettingsPayload = {
      enabled: raw.enabled,
      orderingEnabled: raw.orderingEnabled,
      closedMessage: raw.closedMessage.trim(),
      title: raw.title.trim(),
      about: raw.about.trim(),
      banners: this.banners().map((banner, index) => ({
        // A banner that was already saved keeps its image on the server: only the new ones send it.
        ...(banner.id ? { id: banner.id } : { image: banner.image }),
        linkType: banner.linkType,
        ...(banner.linkType !== 'none' && banner.linkId ? { linkId: banner.linkId } : {}),
        sortOrder: index,
      })),
      featuredCategoryIds: this.featured(),
      whatsapp: raw.whatsapp.trim(),
      facebook: raw.facebook.trim(),
      instagram: raw.instagram.trim(),
      tiktok: raw.tiktok.trim(),
      minOrderAmount: this.amount(raw.minOrderAmount),
      freeDeliveryFrom: this.amount(raw.freeDeliveryFrom),
      orderNote: raw.orderNote.trim(),
      returnsPolicy: raw.returnsPolicy.trim(),
      terms: raw.terms.trim(),
    };
    this.bannerError.set(null);
    this.saving.set(true);
    this.service
      .saveSettings(payload)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (settings) => {
          this.apply(settings);
          this.saving.set(false);
          this.outcome.set({ kind: 'saved' });
        },
        error: (error) => {
          this.saving.set(false);
          this.outcome.set({ kind: 'error', message: typeof error?.error?.message === 'string' ? error.error.message : '' });
        },
      });
  }

  /** '' = not set (the server clears it); else the number. */
  private amount(value: string): number | null {
    const text = value.trim();
    return text === '' ? null : Number(text);
  }

  private apply(settings: WebsiteSettings): void {
    const merged = { ...EMPTY_WEBSITE_SETTINGS, ...settings };
    this.banners.set([...merged.banners].sort((a, b) => a.sortOrder - b.sortOrder).map((banner, index) => ({ ...banner, sortOrder: index })));
    this.featured.set([...merged.featuredCategoryIds]);
    this.form.reset({
      enabled: merged.enabled,
      orderingEnabled: merged.orderingEnabled,
      closedMessage: merged.closedMessage || '',
      title: merged.title || '',
      about: merged.about || '',
      whatsapp: merged.whatsapp || '',
      facebook: merged.facebook || '',
      instagram: merged.instagram || '',
      tiktok: merged.tiktok || '',
      minOrderAmount: merged.minOrderAmount === null || merged.minOrderAmount === undefined ? '' : String(merged.minOrderAmount),
      freeDeliveryFrom: merged.freeDeliveryFrom === null || merged.freeDeliveryFrom === undefined ? '' : String(merged.freeDeliveryFrom),
      orderNote: merged.orderNote || '',
      returnsPolicy: merged.returnsPolicy || '',
      terms: merged.terms || '',
    });
    this.lastSnapshot = this.snapshot();
  }

  private restore(snapshot: { form: any; banners: WebsiteBanner[]; featured: string[] }): void {
    this.form.reset(snapshot.form);
    this.banners.set(snapshot.banners);
    this.featured.set(snapshot.featured);
  }

  private snapshot(): string {
    return JSON.stringify({ form: this.form.getRawValue(), banners: this.banners(), featured: this.featured() });
  }
}
