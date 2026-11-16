import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { TranslatePipe } from '@ngx-translate/core';
import { UnsavedWorkService } from '../../../core/unsaved-work/unsaved-work.service';
import { CashboxService } from '../../cashbox/cashbox.service';
import { CatalogStateService } from '../../layout/nav/catalog-state.service';
import { ProductsService } from '../../products/services/products.service';
import { NotaButtonDirective, NotaFormFieldComponent, NotaPageHeaderComponent, NotaStatusPillComponent } from '../../shared/ui';
import { DeliveryZonesComponent } from '../delivery-zones/delivery-zones.component';
import {
  BRAND_COLORS, BannerLinkType, DEFAULT_WHATSAPP_TEMPLATE, EMPTY_WEBSITE_SETTINGS, HIGHLIGHT_ICONS, HighlightIcon, WEBSITE_LIMITS, WebsiteBanner, WebsiteHighlight, WebsiteSettings,
  WebsiteSettingsPayload,
} from '../website.models';
import { WebsiteService } from '../website.service';

type Outcome = { kind: 'saved' } | { kind: 'error'; message: string };

/** Online Stage 5A: the tabs of the page (the labels are website.settings.tabs.*). */
export type SettingsTab = 'general' | 'look' | 'delivery' | 'payment' | 'products';
export const SETTINGS_TABS: readonly SettingsTab[] = ['general', 'look', 'delivery', 'payment', 'products'];

const URL_PATTERN = /^https?:\/\/\S+$/i;
const MONEY_PATTERN = /^\d{1,9}(\.\d{1,2})?$/;

/** A wallet or bank box the transfer methods can be paid into. */
interface WalletBox { _id: string; name: string; type: string }

/**
 * Online Stage 3 / 5A: /website/settings. Tabs عام / الشكل / التوصيل / الدفع / المنتجات والطلبات, a side preview (brand color,
 * announcement, logo), "افتح الموقع" and the site status pill. GET/PUT /api/website/settings (website.manage). Delivery zones live in
 * the التوصيل tab (their own API). Leaving with unsaved changes asks first.
 */
@Component({
  selector: 'app-website-settings',
  imports: [TranslatePipe, ReactiveFormsModule, NotaButtonDirective, NotaFormFieldComponent, NotaPageHeaderComponent, NotaStatusPillComponent, DeliveryZonesComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './website-settings.component.html',
  styleUrl: './website-settings.component.scss',
})
export class WebsiteSettingsComponent implements OnInit {
  private readonly service = inject(WebsiteService);
  private readonly productsService = inject(ProductsService);
  private readonly cashbox = inject(CashboxService);
  private readonly catalog = inject(CatalogStateService);
  private readonly formBuilder = inject(FormBuilder);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly limits = WEBSITE_LIMITS;
  protected readonly categories = this.catalog.categories;
  protected readonly tabs = SETTINGS_TABS;
  protected readonly brandColors = BRAND_COLORS;
  protected readonly highlightIcons = HIGHLIGHT_ICONS;
  protected readonly defaultTemplate = DEFAULT_WHATSAPP_TEMPLATE;
  protected readonly placeholders = ['{الاسم}', '{رقم الطلب}', '{الإجمالي}', '{مدة التوصيل}'];

  protected readonly tab = signal<SettingsTab>('general');
  protected readonly loading = signal(true);
  protected readonly loadError = signal(false);
  protected readonly saving = signal(false);
  protected readonly outcome = signal<Outcome | null>(null);
  protected readonly banners = signal<WebsiteBanner[]>([]);
  protected readonly featured = signal<string[]>([]);
  protected readonly bannerError = signal<string | null>(null);
  /** The product search of the banner whose link is being chosen. */
  protected readonly productSearch = signal<{ index: number; results: Array<{ _id: string; name: string }> } | null>(null);
  // Online Stage 5A
  /** The website logo as a data URI (null = the shop logo is used). `logoChanged`: only then is it sent on save. */
  protected readonly logo = signal<string | null>(null);
  private logoChanged = false;
  protected readonly logoError = signal<string | null>(null);
  protected readonly highlights = signal<WebsiteHighlight[]>([]);
  protected readonly walletBoxes = signal<WalletBox[]>([]);
  /** Bumped on every form change so the preview recomputes. */
  private readonly formTick = signal(0);
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
    minOrderAmount: ['', Validators.pattern(MONEY_PATTERN)],
    freeDeliveryFrom: ['', Validators.pattern(MONEY_PATTERN)],
    orderNote: ['', Validators.maxLength(WEBSITE_LIMITS.orderNote)],
    returnsPolicy: ['', Validators.maxLength(WEBSITE_LIMITS.returnsPolicy)],
    terms: ['', Validators.maxLength(WEBSITE_LIMITS.terms)],
    // Online Stage 5A
    seoDescription: ['', Validators.maxLength(WEBSITE_LIMITS.seoDescription)],
    openingHours: ['', Validators.maxLength(WEBSITE_LIMITS.openingHours)],
    brandColor: [''],
    announcementEnabled: [false],
    announcementText: ['', Validators.maxLength(WEBSITE_LIMITS.announcement)],
    fulfillmentDelivery: [true],
    fulfillmentPickup: [false],
    sameDayCutoff: ['', Validators.pattern(/^([01]\d|2[0-3]):[0-5]\d$/)],
    codEnabled: [true],
    instapayEnabled: [false],
    // No spaces inside (leading / trailing ones are trimmed when saving).
    instapayAddress: ['', [Validators.maxLength(WEBSITE_LIMITS.instapayAddress), Validators.pattern(/^\s*\S*\s*$/)]],
    instapayBoxId: [''],
    vodafoneEnabled: [false],
    vodafoneNumber: ['', Validators.maxLength(30)],
    vodafoneBoxId: [''],
    productVisibility: ['marked' as 'marked' | 'all'],
    showOutOfStock: [true],
    showRemainingEnabled: [true],
    showRemainingThreshold: ['5', Validators.pattern(/^[1-9]\d{0,2}$|^1000$/)],
    whatsappConfirmTemplate: ['', Validators.maxLength(WEBSITE_LIMITS.whatsappTemplate)],
  });

  protected readonly featuredFull = computed(() => this.featured().length >= WEBSITE_LIMITS.featured);
  protected readonly canAddBanner = computed(() => this.banners().length < WEBSITE_LIMITS.banners);
  protected readonly canAddHighlight = computed(() => this.highlights().length < WEBSITE_LIMITS.highlights);

  /** The saved site status (not the unsaved toggle): the pill next to the title. */
  protected readonly savedEnabled = signal(false);
  protected readonly siteUrl = typeof window !== 'undefined' ? `${window.location.origin}/` : '/';

  /** The side preview: brand color, announcement and logo as they are in the form now. */
  protected readonly preview = computed(() => {
    this.formTick();
    const raw = this.form.getRawValue();
    return {
      color: raw.brandColor || null,
      title: raw.title.trim(),
      announcement: raw.announcementEnabled ? raw.announcementText.trim() : '',
      logo: this.logo(),
      pickup: raw.fulfillmentPickup,
      delivery: raw.fulfillmentDelivery,
    };
  });

  /** Neither fulfillment option on, or no payment method on: the page says so and the server refuses it. */
  protected readonly noFulfillment = computed(() => { this.formTick(); const raw = this.form.getRawValue(); return !raw.fulfillmentDelivery && !raw.fulfillmentPickup; });
  protected readonly noPayment = computed(() => { this.formTick(); const raw = this.form.getRawValue(); return !raw.codEnabled && !raw.instapayEnabled && !raw.vodafoneEnabled; });

  constructor() {
    this.destroyRef.onDestroy(inject(UnsavedWorkService).register('website-settings', () => this.hasUnsavedChanges()));
    this.form.valueChanges.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => this.formTick.update((n) => n + 1));
  }

  /** A field, a banner, a highlight, the logo or a featured category changed since the last load / save. */
  hasUnsavedChanges(): boolean {
    if (this.loading() || this.saving()) return false;
    return this.snapshot() !== this.lastSnapshot;
  }

  ngOnInit(): void {
    if (!this.catalog.categories().length) this.catalog.refresh();
    this.cashbox.paymentBoxes().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (response) => this.walletBoxes.set((response?.data || []).filter((box: any) => box.type === 'wallet' || box.type === 'bank').map((box: any) => ({ _id: box._id, name: box.name, type: box.type }))),
      error: () => undefined,
    });
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

  protected setTab(tab: SettingsTab): void {
    this.tab.set(tab);
  }

  protected showError(control: keyof typeof this.form.controls): boolean {
    const field = this.form.controls[control];
    return field.invalid && (field.touched || field.dirty);
  }

  protected setBrandColor(color: string): void {
    this.form.controls.brandColor.setValue(this.form.controls.brandColor.value === color ? '' : color);
    this.form.controls.brandColor.markAsDirty();
  }

  // ---- website logo ----

  protected onLogoSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) return this.logoError.set('website.settings.look.logoInvalidType');
    if (file.size > WEBSITE_LIMITS.bannerBytes) return this.logoError.set('website.settings.look.logoTooLarge');
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== 'string') return;
      this.logo.set(reader.result);
      this.logoChanged = true;
      this.logoError.set(null);
      this.formTick.update((n) => n + 1);
    };
    reader.onerror = () => this.logoError.set('website.settings.look.logoReadFailed');
    reader.readAsDataURL(file);
  }

  protected removeLogo(): void {
    this.logo.set(null);
    this.logoChanged = true;
    this.formTick.update((n) => n + 1);
  }

  // ---- highlights ----

  protected addHighlight(): void {
    if (!this.canAddHighlight()) return;
    this.highlights.update((list) => [...list, { icon: 'star', title: '', text: '' }]);
  }

  protected removeHighlight(index: number): void {
    this.highlights.update((list) => list.filter((_, i) => i !== index));
  }

  protected patchHighlight(index: number, patch: Partial<WebsiteHighlight>): void {
    this.highlights.update((list) => list.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  protected setHighlightIcon(index: number, icon: string): void {
    this.patchHighlight(index, { icon: (HIGHLIGHT_ICONS as readonly string[]).includes(icon) ? (icon as HighlightIcon) : 'star' });
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
      this.tab.set('look');
      return;
    }
    if (this.noFulfillment() || this.noPayment()) {
      this.tab.set(this.noFulfillment() ? 'delivery' : 'payment');
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
      // Online Stage 5A
      fulfillment: { delivery: raw.fulfillmentDelivery, pickup: raw.fulfillmentPickup },
      payments: {
        cod: { enabled: raw.codEnabled },
        instapay: { enabled: raw.instapayEnabled, address: raw.instapayAddress.trim(), boxId: raw.instapayBoxId },
        vodafoneCash: { enabled: raw.vodafoneEnabled, number: raw.vodafoneNumber.trim(), boxId: raw.vodafoneBoxId },
      },
      stock: { showOutOfStock: raw.showOutOfStock, showRemaining: { enabled: raw.showRemainingEnabled, threshold: Number(raw.showRemainingThreshold) || 5 } },
      productVisibility: raw.productVisibility,
      brandColor: raw.brandColor,
      announcement: { enabled: raw.announcementEnabled, text: raw.announcementText.trim() },
      seoDescription: raw.seoDescription.trim(),
      openingHours: raw.openingHours.trim(),
      sameDayCutoff: raw.sameDayCutoff.trim(),
      highlights: this.highlights().map((row) => ({ icon: row.icon, title: row.title.trim(), text: row.text.trim() })),
      whatsappConfirmTemplate: raw.whatsappConfirmTemplate.trim(),
      // The logo is sent only when it changed ('' removes it).
      ...(this.logoChanged ? { websiteLogo: this.logo() ?? '' } : {}),
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
    this.highlights.set((merged.highlights || []).map((row) => ({ icon: row.icon, title: row.title || '', text: row.text || '' })));
    this.logo.set(merged.websiteLogo || null);
    this.logoChanged = false;
    this.savedEnabled.set(merged.enabled);
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
      seoDescription: merged.seoDescription || '',
      openingHours: merged.openingHours || '',
      brandColor: merged.brandColor || '',
      announcementEnabled: merged.announcement.enabled,
      announcementText: merged.announcement.text || '',
      fulfillmentDelivery: merged.fulfillment.delivery,
      fulfillmentPickup: merged.fulfillment.pickup,
      sameDayCutoff: merged.sameDayCutoff || '',
      codEnabled: merged.payments.cod.enabled,
      instapayEnabled: merged.payments.instapay.enabled,
      instapayAddress: merged.payments.instapay.address || '',
      instapayBoxId: merged.payments.instapay.boxId || '',
      vodafoneEnabled: merged.payments.vodafoneCash.enabled,
      vodafoneNumber: merged.payments.vodafoneCash.number || '',
      vodafoneBoxId: merged.payments.vodafoneCash.boxId || '',
      productVisibility: merged.productVisibility,
      showOutOfStock: merged.stock.showOutOfStock,
      showRemainingEnabled: merged.stock.showRemaining.enabled,
      showRemainingThreshold: String(merged.stock.showRemaining.threshold),
      whatsappConfirmTemplate: merged.whatsappConfirmTemplate || '',
    });
    this.formTick.update((n) => n + 1);
    this.lastSnapshot = this.snapshot();
  }

  private restore(snapshot: { form: any; banners: WebsiteBanner[]; featured: string[]; highlights: WebsiteHighlight[]; logo: string | null }): void {
    this.form.reset(snapshot.form);
    this.banners.set(snapshot.banners);
    this.featured.set(snapshot.featured);
    this.highlights.set(snapshot.highlights);
    this.logo.set(snapshot.logo);
    this.logoChanged = false;
    this.formTick.update((n) => n + 1);
  }

  private snapshot(): string {
    return JSON.stringify({ form: this.form.getRawValue(), banners: this.banners(), featured: this.featured(), highlights: this.highlights(), logo: this.logo() });
  }
}
