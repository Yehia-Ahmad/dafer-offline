import { CommonModule } from '@angular/common';
import { ChangeDetectorRef, Component, OnInit } from '@angular/core';
import {
  AbstractControl,
  FormArray,
  FormBuilder,
  FormControl,
  FormGroup,
  ReactiveFormsModule,
  ValidationErrors,
  Validators
} from '@angular/forms';
import { TranslatePipe } from '@ngx-translate/core';
import { DialogModule } from 'primeng/dialog';
import { Router } from '@angular/router';
import { forkJoin } from 'rxjs';
import { SideNavComponent } from '../../../layout/components/side-nav/side-nav.component';
import { ThemeService } from '../../../shared/services/theme.service';
import { EcommerceSettingsService } from '../../services/ecommerce-settings.service';
import {
  EcommerceCategoryWithSettings,
  EcommerceGeneralSettings,
  EcommerceHomePageCategory,
  EcommerceProductOption,
  EcommerceSocialMediaLink,
  EcommerceStoreLocation,
  GovernmentShippingFee,
  UpdateEcommerceGeneralSettingsPayload,
  UpsertEcommerceSettingPayload
} from '../../models/ecommerce-settings.models';

type FilterForm = FormGroup<{
  title: FormControl<string>;
  values: FormControl<string[]>;
  isVisible: FormControl<boolean>;
}>;

type CategorySettingsForm = FormGroup<{
  categoryId: FormControl<string>;
  showOnWebsite: FormControl<boolean>;
  productIds: FormControl<string[]>;
  filters: FormArray<FilterForm>;
}>;

type ShippingGovernmentForm = FormGroup<{
  government: FormControl<string>;
  shippingFees: FormControl<number>;
}>;

type ShippingSettingsForm = FormGroup<{
  governmentFees: FormArray<ShippingGovernmentForm>;
}>;

type StoreLocationForm = FormGroup<{
  name: FormControl<string>;
  detailedLocation: FormControl<string>;
  mapLink: FormControl<string>;
}>;

type SocialMediaLinkForm = FormGroup<{
  name: FormControl<string>;
  link: FormControl<string>;
}>;

type WebsiteGeneralSettingsForm = FormGroup<{
  mainLogo: FormControl<string>;
  mainColor: FormControl<string>;
  freeShippingMinimumAmount: FormControl<number>;
  currency: FormControl<string>;
  walletPhone: FormControl<string>;
  instapayLink: FormControl<string>;
  storeLocations: FormArray<StoreLocationForm>;
  socialMediaLinks: FormArray<SocialMediaLinkForm>;
}>;

@Component({
  selector: 'app-ecommerce-settings',
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule, SideNavComponent, TranslatePipe, DialogModule],
  templateUrl: './ecommerce-settings.component.html',
  styleUrl: './ecommerce-settings.component.scss'
})
export class EcommerceSettingsComponent implements OnInit {
  isDarkMode$;
  isLoading = true;
  isSaving = false;
  isResetting = false;
  saveMessage = '';
  errorMessage = '';
  messageVisible = false;
  messageTitle = '';
  messageBody = '';
  messageTone: 'success' | 'error' | 'info' = 'info';
  categories: EcommerceCategoryWithSettings[] = [];
  activeCategory: EcommerceCategoryWithSettings | null = null;
  activeSection: 'categories' | 'shipping' | 'general' | 'homePage' = 'categories';
  form: CategorySettingsForm;
  shippingForm: ShippingSettingsForm;
  websiteGeneralSettingsForm: WebsiteGeneralSettingsForm;
  homePageCategoriesControl: FormControl<string[]>;
  homePageCategoryOptions: EcommerceHomePageCategory[] = [];
  isSavingShipping = false;
  isLoadingShipping = false;
  isLoadingWebsiteGeneralSettings = false;
  isSavingWebsiteGeneralSettings = false;
  isLoadingHomePageCategories = false;
  isSavingHomePageCategories = false;

  constructor(
    private fb: FormBuilder,
    private themeService: ThemeService,
    public ecommerceSettingsService: EcommerceSettingsService,
    private router: Router,
    private cdr: ChangeDetectorRef
  ) {
    this.isDarkMode$ = this.themeService.isDarkMode$;
    this.form = this.createForm();
    this.shippingForm = this.createShippingForm();
    this.websiteGeneralSettingsForm = this.createWebsiteGeneralSettingsForm();
    this.homePageCategoriesControl = this.fb.nonNullable.control<string[]>([]);
  }

  ngOnInit(): void {
    this.loadSettings();
    this.loadShippingSettings();
    this.loadWebsiteGeneralSettings();
    this.loadHomePageCategories();
  }

  get filters(): CategorySettingsForm['controls']['filters'] {
    return this.form.controls.filters;
  }

  get activeProducts(): EcommerceProductOption[] {
    return this.activeCategory?.products || [];
  }

  get governmentFees(): ShippingSettingsForm['controls']['governmentFees'] {
    return this.shippingForm.controls.governmentFees;
  }

  get storeLocations(): WebsiteGeneralSettingsForm['controls']['storeLocations'] {
    return this.websiteGeneralSettingsForm.controls.storeLocations;
  }

  get socialMediaLinks(): WebsiteGeneralSettingsForm['controls']['socialMediaLinks'] {
    return this.websiteGeneralSettingsForm.controls.socialMediaLinks;
  }

  get selectedHomePageCategories(): EcommerceHomePageCategory[] {
    const categoriesById = new Map(
      this.homePageCategoryOptions.map((category) => [category.id, category])
    );

    return this.homePageCategoriesControl.value
      .map((categoryId) => categoriesById.get(categoryId))
      .filter((category): category is EcommerceHomePageCategory => Boolean(category));
  }

  get areAllProductsSelected(): boolean {
    return this.activeProducts.length > 0 && this.form.controls.productIds.value.length === this.activeProducts.length;
  }

  get areSomeProductsSelected(): boolean {
    const selectedCount = this.form.controls.productIds.value.length;
    return selectedCount > 0 && selectedCount < this.activeProducts.length;
  }

  loadSettings(): void {
    this.isLoading = true;
    this.errorMessage = '';

    this.ecommerceSettingsService.getCategoriesWithProductsAndSettings().subscribe({
      next: (settings) => {
        this.categories = settings.categories;
        this.selectCategory(this.categories[0] || null);
        if (this.router.url.includes('/ecommerce-settings/shipping/governments')) {
          this.activeSection = 'shipping';
        } else if (this.router.url.includes('/ecommerce-settings/shipping/general')) {
          this.activeSection = 'general';
        }
        this.isLoading = false;
        this.cdr.detectChanges();
      },
      error: (err) => {
        this.showMessage('error', 'Failed to load e-commerce settings.', err?.error?.message);
        this.isLoading = false;
        this.cdr.detectChanges();
      }
    });
  }

  selectCategory(category: EcommerceCategoryWithSettings | null): void {
    this.activeSection = 'categories';
    this.activeCategory = category;
    this.saveMessage = '';
    this.errorMessage = '';
    this.form = this.createForm(category || undefined);
    this.cdr.detectChanges();
  }

  selectSection(section: 'categories' | 'shipping' | 'general' | 'homePage'): void {
    this.activeSection = section;
    this.saveMessage = '';
    this.errorMessage = '';

    if (section === 'shipping' && !this.governmentFees.length) {
      this.addGovernmentFee();
    }

    this.cdr.detectChanges();
  }

  toggleCategoryProduct(productId: string): void {
    const selectedIds = this.form.controls.productIds.value;
    const nextSelectedIds = selectedIds.includes(productId)
      ? selectedIds.filter((id) => id !== productId)
      : [...selectedIds, productId];

    this.form.controls.productIds.setValue(nextSelectedIds);
    this.form.controls.productIds.markAsDirty();

    this.cdr.detectChanges();
  }

  isProductSelected(productId: string): boolean {
    return this.form.controls.productIds.value.includes(productId);
  }

  toggleAllProducts(): void {
    const nextSelectedIds = this.areAllProductsSelected
      ? []
      : this.activeProducts.map((product) => product.id);

    this.form.controls.productIds.setValue(nextSelectedIds);
    this.form.controls.productIds.markAsDirty();
    this.cdr.detectChanges();
  }

  saveSettings(): void {
    if (this.form.invalid || this.isSaving) {
      this.form.markAllAsTouched();
      return;
    }

    this.isSaving = true;
    this.saveMessage = '';
    this.errorMessage = '';
    const categoryId = this.form.controls.categoryId.value;
    const payload = this.buildPayload();

    this.ecommerceSettingsService.upsertSetting(categoryId, payload).subscribe({
      next: (response) => {
        this.mergeCategory(response.setting);
        this.showMessage('success', 'Saved', response.message);
        this.isSaving = false;
        this.form.markAsPristine();
        this.cdr.detectChanges();
      },
      error: (err) => {
        this.showMessage('error', 'Save failed', err?.error?.message || 'Failed to save e-commerce setting.');
        this.isSaving = false;
        this.cdr.detectChanges();
      }
    });
  }

  resetSettings(): void {
    const categoryId = this.form.controls.categoryId.value;
    if (!categoryId || this.isResetting) return;

    this.isResetting = true;
    this.saveMessage = '';
    this.errorMessage = '';

    this.ecommerceSettingsService.resetSetting(categoryId).subscribe({
      next: (response) => {
        this.mergeCategory({
          categoryId,
          categoryName: this.activeCategory?.categoryName || '',
          showOnWebsite: false,
          productIds: [],
          filters: []
        });
        this.showMessage('success', 'Reset', response.message);
        this.isResetting = false;
        this.cdr.detectChanges();
      },
      error: (err) => {
        this.showMessage('error', 'Reset failed', err?.error?.message || 'Failed to reset e-commerce setting.');
        this.isResetting = false;
        this.cdr.detectChanges();
      }
    });
  }

  addGovernmentFee(): void {
    this.governmentFees.push(this.createShippingGovernmentGroup());
    this.shippingForm.markAsDirty();
    this.cdr.detectChanges();
  }

  loadShippingSettings(): void {
    this.isLoadingShipping = true;

    this.ecommerceSettingsService.getGovernmentShippingFees().subscribe({
      next: (settings) => {
        this.shippingForm = this.createShippingForm(settings.governmentFees);
        this.shippingForm.markAsPristine();
        this.isLoadingShipping = false;
        this.cdr.detectChanges();
      },
      error: (err) => {
        this.isLoadingShipping = false;
        this.showMessage(
          'error',
          'Failed to load shipping settings',
          err?.error?.message || 'Government shipping fees could not be loaded.'
        );
        this.cdr.detectChanges();
      }
    });
  }

  removeGovernmentFee(index: number): void {
    if (this.governmentFees.length <= 1) {
      this.governmentFees.at(0).reset({ government: '', shippingFees: 0 });
    } else {
      this.governmentFees.removeAt(index);
    }

    this.shippingForm.markAsDirty();
    this.cdr.detectChanges();
  }

  saveShippingSettings(): void {
    if (this.shippingForm.invalid || this.isSavingShipping || this.hasDuplicateGovernments()) {
      this.shippingForm.markAllAsTouched();
      if (this.hasDuplicateGovernments()) {
        this.showMessage('error', 'Save failed', 'Government names must be unique.');
      }
      return;
    }

    this.isSavingShipping = true;
    this.saveMessage = '';
    this.errorMessage = '';
    const payload = this.buildShippingPayload();

    this.ecommerceSettingsService.updateGovernmentShippingFees(payload).subscribe({
      next: (response) => {
        this.shippingForm = this.createShippingForm(response.governmentFees);
        this.showMessage('success', 'Saved', response.message);
        this.isSavingShipping = false;
        this.shippingForm.markAsPristine();
        this.cdr.detectChanges();
      },
      error: (err) => {
        this.showMessage(
          'error',
          'Save failed',
          err?.error?.message || 'Failed to save shipping settings.'
        );
        this.isSavingShipping = false;
        this.cdr.detectChanges();
      }
    });
  }

  loadWebsiteGeneralSettings(): void {
    this.isLoadingWebsiteGeneralSettings = true;

    this.ecommerceSettingsService.getGeneralSettings().subscribe({
      next: (settings) => {
        this.websiteGeneralSettingsForm = this.createWebsiteGeneralSettingsForm(settings);
        this.websiteGeneralSettingsForm.markAsPristine();
        this.isLoadingWebsiteGeneralSettings = false;
        this.cdr.detectChanges();
      },
      error: (err) => {
        this.isLoadingWebsiteGeneralSettings = false;
        this.showMessage(
          'error',
          'Failed to load general settings',
          err?.error?.message || 'The website general settings could not be loaded.'
        );
        this.cdr.detectChanges();
      }
    });
  }

  saveWebsiteGeneralSettings(): void {
    if (this.websiteGeneralSettingsForm.invalid || this.isSavingWebsiteGeneralSettings) {
      this.websiteGeneralSettingsForm.markAllAsTouched();
      return;
    }

    this.isSavingWebsiteGeneralSettings = true;
    const payload = this.buildWebsiteGeneralSettingsPayload();

    this.ecommerceSettingsService.updateGeneralSettings(payload).subscribe({
      next: (response) => {
        this.websiteGeneralSettingsForm = this.createWebsiteGeneralSettingsForm(response);
        this.websiteGeneralSettingsForm.markAsPristine();
        this.isSavingWebsiteGeneralSettings = false;
        this.showMessage('success', 'Saved', response.message);
        this.cdr.detectChanges();
      },
      error: (err) => {
        this.isSavingWebsiteGeneralSettings = false;
        this.showMessage(
          'error',
          'Save failed',
          err?.error?.message || 'Failed to save the website general settings.'
        );
        this.cdr.detectChanges();
      }
    });
  }

  onMainLogoSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      input.value = '';
      this.showMessage('error', 'Invalid logo', 'Select a valid image file.');
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== 'string') return;
      this.websiteGeneralSettingsForm.controls.mainLogo.setValue(reader.result);
      this.websiteGeneralSettingsForm.controls.mainLogo.markAsDirty();
      this.cdr.detectChanges();
    };
    reader.onerror = () => {
      input.value = '';
      this.showMessage('error', 'Logo upload failed', 'The selected image could not be read.');
      this.cdr.detectChanges();
    };
    reader.readAsDataURL(file);
  }

  addStoreLocation(): void {
    this.storeLocations.push(this.createStoreLocationForm());
    this.websiteGeneralSettingsForm.markAsDirty();
    this.cdr.detectChanges();
  }

  removeStoreLocation(index: number): void {
    this.storeLocations.removeAt(index);
    this.websiteGeneralSettingsForm.markAsDirty();
    this.cdr.detectChanges();
  }

  addSocialMediaLink(): void {
    this.socialMediaLinks.push(this.createSocialMediaLinkForm());
    this.websiteGeneralSettingsForm.markAsDirty();
    this.cdr.detectChanges();
  }

  removeSocialMediaLink(index: number): void {
    this.socialMediaLinks.removeAt(index);
    this.websiteGeneralSettingsForm.markAsDirty();
    this.cdr.detectChanges();
  }

  isWhatsAppSocialMediaLink(socialMediaLink: SocialMediaLinkForm): boolean {
    return this.isWhatsAppPlatform(socialMediaLink.controls.name.value);
  }

  getSocialMediaLinkPlaceholder(socialMediaLink: SocialMediaLinkForm): string {
    return this.isWhatsAppSocialMediaLink(socialMediaLink)
      ? '+20 100 000 0000'
      : 'https://facebook.com/example';
  }

  loadHomePageCategories(): void {
    this.isLoadingHomePageCategories = true;

    forkJoin({
      activeCategories: this.ecommerceSettingsService.getActiveCategories(),
      homePageSettings: this.ecommerceSettingsService.getHomePageCategories()
    }).subscribe({
      next: ({ activeCategories, homePageSettings }) => {
        this.homePageCategoryOptions = activeCategories;
        const activeCategoryIds = new Set(activeCategories.map((category) => category.id));
        this.homePageCategoriesControl.setValue(
          homePageSettings.categoryIds.filter((categoryId) => activeCategoryIds.has(categoryId))
        );
        this.homePageCategoriesControl.markAsPristine();
        this.isLoadingHomePageCategories = false;
        this.cdr.detectChanges();
      },
      error: (err) => {
        this.isLoadingHomePageCategories = false;
        this.showMessage(
          'error',
          'Failed to load home page categories',
          err?.error?.message || 'The active categories or home page selection could not be loaded.'
        );
        this.cdr.detectChanges();
      }
    });
  }

  isHomePageCategorySelected(categoryId: string): boolean {
    return this.homePageCategoriesControl.value.includes(categoryId);
  }

  addHomePageCategory(categoryId: string): void {
    if (this.isHomePageCategorySelected(categoryId)) return;

    this.homePageCategoriesControl.setValue([
      ...this.homePageCategoriesControl.value,
      categoryId
    ]);
    this.homePageCategoriesControl.markAsDirty();
    this.cdr.detectChanges();
  }

  removeHomePageCategory(index: number): void {
    const categoryIds = [...this.homePageCategoriesControl.value];
    categoryIds.splice(index, 1);
    this.homePageCategoriesControl.setValue(categoryIds);
    this.homePageCategoriesControl.markAsDirty();
    this.cdr.detectChanges();
  }

  moveHomePageCategory(index: number, direction: -1 | 1): void {
    const nextIndex = index + direction;
    const categoryIds = [...this.homePageCategoriesControl.value];
    if (nextIndex < 0 || nextIndex >= categoryIds.length) return;

    [categoryIds[index], categoryIds[nextIndex]] = [categoryIds[nextIndex], categoryIds[index]];
    this.homePageCategoriesControl.setValue(categoryIds);
    this.homePageCategoriesControl.markAsDirty();
    this.cdr.detectChanges();
  }

  saveHomePageCategories(): void {
    if (this.isSavingHomePageCategories) return;

    this.isSavingHomePageCategories = true;
    const categoryIds = [...this.homePageCategoriesControl.value];

    this.ecommerceSettingsService.updateHomePageCategories({ categoryIds }).subscribe({
      next: (response) => {
        this.homePageCategoriesControl.setValue(response.categoryIds);
        this.homePageCategoriesControl.markAsPristine();
        this.isSavingHomePageCategories = false;
        this.showMessage('success', 'Saved', response.message);
        this.cdr.detectChanges();
      },
      error: (err) => {
        this.isSavingHomePageCategories = false;
        this.showMessage(
          'error',
          'Save failed',
          err?.error?.message || 'Failed to save the home page categories.'
        );
        this.cdr.detectChanges();
      }
    });
  }

  closeMessageDialog(): void {
    this.messageVisible = false;
    this.cdr.detectChanges();
  }

  private createForm(category?: EcommerceCategoryWithSettings): CategorySettingsForm {
    return this.fb.group({
      categoryId: this.fb.nonNullable.control(category?.categoryId || ''),
      showOnWebsite: this.fb.nonNullable.control(category?.showOnWebsite ?? false),
      productIds: this.fb.nonNullable.control(category?.productIds || []),
      filters: this.fb.array(this.buildFilterItems(category).map((filter) => this.createFilterGroup(filter)))
    });
  }

  private createFilterGroup(filter?: {
    title?: string;
    values?: string[];
    isVisible?: boolean;
  }): FilterForm {
    return this.fb.group({
      title: this.fb.nonNullable.control(filter?.title || '', Validators.required),
      values: this.fb.nonNullable.control(filter?.values || []),
      isVisible: this.fb.nonNullable.control(filter?.isVisible ?? true)
    });
  }

  private createShippingForm(governmentFees: GovernmentShippingFee[] = []): ShippingSettingsForm {
    const fees = governmentFees.length ? governmentFees : [{ government: '', shippingFees: 0 }];

    return this.fb.group({
      governmentFees: this.fb.array(
        fees.map((item) => this.createShippingGovernmentGroup(item))
      )
    });
  }

  private createWebsiteGeneralSettingsForm(
    settings?: EcommerceGeneralSettings
  ): WebsiteGeneralSettingsForm {
    return this.fb.group({
      mainLogo: this.fb.nonNullable.control(settings?.mainLogo || ''),
      mainColor: this.fb.nonNullable.control(settings?.mainColor || '#F4D80A', [
        Validators.required,
        Validators.pattern(/^#[0-9A-Fa-f]{6}$/)
      ]),
      freeShippingMinimumAmount: this.fb.nonNullable.control(
        Number(settings?.freeShippingMinimumAmount ?? 0),
        [Validators.required, Validators.min(0)]
      ),
      currency: this.fb.nonNullable.control(settings?.currency || 'EGP', [
        Validators.required,
        Validators.pattern(/^[A-Za-z]{3}$/)
      ]),
      walletPhone: this.fb.nonNullable.control(settings?.walletPhone || '', [
        Validators.pattern(/^\+?[0-9\s-]{7,20}$/)
      ]),
      instapayLink: this.fb.nonNullable.control(settings?.instapayLink || '', [
        Validators.pattern(/^https?:\/\/\S+$/i)
      ]),
      storeLocations: this.fb.array(
        (settings?.storeLocations || []).map((location) =>
          this.createStoreLocationForm(location)
        )
      ),
      socialMediaLinks: this.fb.array(
        (settings?.socialMediaLinks || []).map((socialMediaLink) =>
          this.createSocialMediaLinkForm(socialMediaLink)
        )
      )
    });
  }

  private createStoreLocationForm(location?: EcommerceStoreLocation): StoreLocationForm {
    return this.fb.group({
      name: this.fb.nonNullable.control(location?.name || '', Validators.required),
      detailedLocation: this.fb.nonNullable.control(
        location?.detailedLocation || '',
        Validators.required
      ),
      mapLink: this.fb.nonNullable.control(location?.mapLink || '', [
        Validators.required,
        Validators.pattern(/^https?:\/\/\S+$/i)
      ])
    });
  }

  private createSocialMediaLinkForm(
    socialMediaLink?: EcommerceSocialMediaLink
  ): SocialMediaLinkForm {
    return this.fb.group(
      {
        name: this.fb.nonNullable.control(socialMediaLink?.name || '', Validators.required),
        link: this.fb.nonNullable.control(socialMediaLink?.link || '', Validators.required)
      },
      { validators: this.validateSocialMediaLink.bind(this) }
    );
  }

  private createShippingGovernmentGroup(item?: Partial<GovernmentShippingFee>): ShippingGovernmentForm {
    return this.fb.group({
      government: this.fb.nonNullable.control(item?.government || '', [
        Validators.required,
        Validators.maxLength(80)
      ]),
      shippingFees: this.fb.nonNullable.control(Number(item?.shippingFees ?? 0), [
        Validators.required,
        Validators.min(0)
      ])
    });
  }

  private buildFilterItems(category?: EcommerceCategoryWithSettings): UpsertEcommerceSettingPayload['filters'] {
    const computedFilters = category?.category.filters || [];
    if (!computedFilters.length) return category?.filters || [];

    const savedFilterByTitle = new Map((category?.filters || []).map((filter) => [filter.title, filter]));

    return computedFilters.map((filter, index) => {
      const savedFilter = savedFilterByTitle.get(filter.name);
      return {
        title: filter.name,
        values: filter.values,
        isVisible: savedFilter?.isVisible ?? true
      };
    });
  }

  private buildPayload(): UpsertEcommerceSettingPayload {
    const rawValue = this.form.getRawValue();

    if (!rawValue.showOnWebsite) {
      return {
        showOnWebsite: false,
        productIds: [],
        filters: []
      };
    }

    return {
      showOnWebsite: rawValue.showOnWebsite,
      productIds: rawValue.productIds,
      filters: rawValue.filters.map((filter) => ({
        title: filter.title.trim(),
        values: filter.values,
        isVisible: filter.isVisible
      }))
    };
  }

  private buildShippingPayload(): { governmentFees: GovernmentShippingFee[] } {
    const governmentFees = this.shippingForm.getRawValue().governmentFees.map((item) => ({
      government: item.government.trim(),
      shippingFees: Number(item.shippingFees)
    }));

    return { governmentFees };
  }

  private buildWebsiteGeneralSettingsPayload(): UpdateEcommerceGeneralSettingsPayload {
    const value = this.websiteGeneralSettingsForm.getRawValue();

    return {
      mainLogo: value.mainLogo,
      mainColor: value.mainColor.trim().toUpperCase(),
      freeShippingMinimumAmount: Number(value.freeShippingMinimumAmount),
      currency: value.currency.trim().toUpperCase(),
      currencyCode: value.currency.trim().toUpperCase(),
      walletPhone: value.walletPhone.trim(),
      instapayLink: value.instapayLink.trim(),
      storeLocations: value.storeLocations.map((location) => ({
        name: location.name.trim(),
        detailedLocation: location.detailedLocation.trim(),
        mapLink: location.mapLink.trim()
      })),
      socialMediaLinks: value.socialMediaLinks.map((socialMediaLink) => ({
        name: socialMediaLink.name.trim(),
        link: this.formatSocialMediaLinkValue(socialMediaLink.name, socialMediaLink.link)
      }))
    };
  }

  private validateSocialMediaLink(control: AbstractControl): ValidationErrors | null {
    const name = String(control.get('name')?.value || '').trim();
    const link = String(control.get('link')?.value || '').trim();

    if (!link) return null;

    if (this.isWhatsAppPlatform(name)) {
      return this.isValidWhatsAppValue(link) ? null : { invalidWhatsappPhone: true };
    }

    return /^https?:\/\/\S+$/i.test(link) ? null : { invalidSocialUrl: true };
  }

  private isWhatsAppPlatform(name: string): boolean {
    return name.trim().toLowerCase().replace(/[\s_-]+/g, '') === 'whatsapp';
  }

  private isValidWhatsAppValue(value: string): boolean {
    return /^https?:\/\/\S+$/i.test(value) || Boolean(this.normalizeWhatsAppPhone(value));
  }

  private formatSocialMediaLinkValue(name: string, value: string): string {
    const trimmedValue = value.trim();
    const normalizedPhone = this.normalizeWhatsAppPhone(trimmedValue);

    if (this.isWhatsAppPlatform(name) && normalizedPhone && !/^https?:\/\//i.test(trimmedValue)) {
      return `https://wa.me/${normalizedPhone}`;
    }

    return trimmedValue;
  }

  private normalizeWhatsAppPhone(value: string): string {
    const trimmedValue = value.trim();
    if (/^https?:\/\//i.test(trimmedValue)) return '';

    const hasInternationalPrefix = /^\s*(\+|00)/.test(value);
    const digits = trimmedValue.replace(/\D/g, '');

    if (digits.length < 8 || digits.length > 15) return '';

    if (hasInternationalPrefix) {
      return digits.replace(/^00/, '');
    }

    if (/^01\d{9}$/.test(digits)) {
      return `20${digits.slice(1)}`;
    }

    return digits;
  }

  private hasDuplicateGovernments(): boolean {
    const names = this.shippingForm
      .getRawValue()
      .governmentFees.map((item) => item.government.trim().toLowerCase())
      .filter(Boolean);

    return names.length !== new Set(names).size;
  }

  private mergeCategory(setting: {
    categoryId: string;
    categoryName: string;
    showOnWebsite: boolean;
    productIds: string[];
    filters: UpsertEcommerceSettingPayload['filters'];
  }): void {
    const categoryIndex = this.categories.findIndex(
      (category) => category.categoryId === setting.categoryId
    );
    if (categoryIndex < 0) return;

    const updatedCategory: EcommerceCategoryWithSettings = {
      ...this.categories[categoryIndex],
      categoryName: setting.categoryName || this.categories[categoryIndex].categoryName,
      showOnWebsite: setting.showOnWebsite,
      productIds: setting.productIds,
      filters: setting.filters
    };

    this.categories[categoryIndex] = updatedCategory;
    this.selectCategory(updatedCategory);
  }

  private showMessage(tone: 'success' | 'error' | 'info', title: string, body: string): void {
    this.messageTone = tone;
    this.messageTitle = title;
    this.messageBody = body;
    this.messageVisible = true;
    if (tone === 'error') {
      this.errorMessage = body;
    } else {
      this.saveMessage = body;
    }
  }
}
