import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { FormArray, FormBuilder, FormControl, ReactiveFormsModule, Validators } from '@angular/forms';
import { TranslatePipe } from '@ngx-translate/core';
import { LanguageService } from '../../../shared/services/translation.service';
import { brandName } from '../../../../core/brand';
import { NotaButtonDirective, NotaFormFieldComponent, NotaPageHeaderComponent } from '../../../shared/ui';
import { DEFAULT_VAT, SHOP_PROFILE_LIMITS, ShopProfile } from '../../models/shop-profile.model';
import { ShopProfileService } from '../../services/shop-profile.service';
import { AUTO_LOCK_CHOICES, DEFAULT_AUTO_LOCK_MINUTES, normalizeAutoLock } from '../../../../core/auth/idle-lock.service';
import { UnsavedWorkService } from '../../../../core/unsaved-work/unsaved-work.service';

type Outcome = { kind: 'saved' } | { kind: 'error'; message: string };

/** The shop's own details (name, address, phones, logo, tax number, ...), printed on invoices. Stage 11: ShopProfile.dc.html + live preview. */
@Component({
  selector: 'app-shop-profile',
  imports: [DatePipe, TranslatePipe, ReactiveFormsModule, NotaButtonDirective, NotaFormFieldComponent, NotaPageHeaderComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './shop-profile.component.html',
  styleUrl: './shop-profile.component.scss',
})
export class ShopProfileComponent implements OnInit {
  private readonly shopProfileService = inject(ShopProfileService);
  private readonly formBuilder = inject(FormBuilder);
  private readonly destroyRef = inject(DestroyRef);
  private readonly language = inject(LanguageService);
  protected readonly appName = computed(() => brandName(this.language.selectedLanguage()));
  protected readonly limits = SHOP_PROFILE_LIMITS;
  /** Stage 15: the "الأمان" card (auto-lock after N idle minutes, 0 = off). */
  protected readonly autoLockChoices = AUTO_LOCK_CHOICES;
  /** Last profile loaded or saved; "Cancel" (frontend only) puts the form back to it. */
  private lastProfile: ShopProfile | null = null;

  protected readonly loading = signal(true);
  protected readonly loadError = signal(false);
  protected readonly saving = signal(false);
  protected readonly outcome = signal<Outcome | null>(null);
  protected readonly logo = signal<string | null>(null);
  protected readonly logoError = signal<string | null>(null);

  protected readonly form = this.formBuilder.nonNullable.group({
    name: ['', [Validators.required, Validators.maxLength(SHOP_PROFILE_LIMITS.name)]],
    address: ['', Validators.maxLength(SHOP_PROFILE_LIMITS.address)],
    phones: this.formBuilder.array<FormControl<string>>([]),
    taxNumber: ['', Validators.maxLength(SHOP_PROFILE_LIMITS.taxNumber)],
    commercialRegister: ['', Validators.maxLength(SHOP_PROFILE_LIMITS.commercialRegister)],
    invoiceFooter: ['', Validators.maxLength(SHOP_PROFILE_LIMITS.invoiceFooter)],
    autoLockMinutes: [DEFAULT_AUTO_LOCK_MINUTES as number],
    // Stage 21: the "الضريبة" card. `vatRate` is a string while typing (2 decimals, 0-100), validated in save().
    vatEnabled: [false],
    vatRate: [String(DEFAULT_VAT.rate), [Validators.required, Validators.pattern(/^\d{1,3}(\.\d{1,2})?$/)]],
    vatIncludes: [DEFAULT_VAT.pricesIncludeVat],
  });
  /** Stage 21: the start date shown once VAT is on (read only; the server sets it when VAT is turned on). */
  protected readonly vatStartDate = signal<string | null>(null);

  constructor() {
    // Stage 15: leaving with unsaved changes asks first (unsavedWorkGuard, logout).
    this.destroyRef.onDestroy(inject(UnsavedWorkService).register('shop-profile', () => this.hasUnsavedChanges()));
  }

  /** Stage 15: a field or the logo changed since the last load / save. */
  hasUnsavedChanges(): boolean {
    if (this.loading() || this.saving()) return false;
    return this.form.dirty || (this.logo() || null) !== (this.lastProfile?.logo || null);
  }

  protected get phones(): FormArray<FormControl<string>> {
    return this.form.controls.phones;
  }

  /** Live invoice preview, from the form as it is being typed. */
  protected readonly preview = toSignal(this.form.valueChanges, { initialValue: this.form.getRawValue() });
  protected readonly previewPhones = computed(() =>
    (this.preview().phones || []).map((phone) => String(phone || '').trim()).filter(Boolean).join(' · ')
  );

  ngOnInit(): void {
    this.shopProfileService
      .getProfile()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (profile) => {
          this.applyProfile(profile);
          this.loading.set(false);
        },
        error: () => {
          this.loadError.set(true);
          this.loading.set(false);
        },
      });
  }

  /** Frontend only: back to the last loaded / saved profile. */
  protected cancel(): void {
    this.outcome.set(null);
    this.logoError.set(null);
    if (this.lastProfile) {
      this.applyProfile(this.lastProfile);
    } else {
      this.phones.clear();
      this.form.reset();
      this.logo.set(null);
    }
  }

  /** Stage 21: turning VAT on needs the shop's tax number (the server answers 400 TAX_NUMBER_REQUIRED too). */
  protected readonly vatNeedsTaxNumber = computed(() => Boolean(this.preview().vatEnabled) && !String(this.preview().taxNumber || '').trim());

  protected vatRateInvalid(): boolean {
    const control = this.form.controls.vatRate;
    const value = Number(control.value);
    return control.invalid || !Number.isFinite(value) || value < 0 || value > 100;
  }

  protected showError(control: 'name'): boolean {
    const field = this.form.controls[control];
    return field.invalid && (field.touched || field.dirty);
  }

  protected addPhone(value = ''): void {
    if (this.phones.length >= SHOP_PROFILE_LIMITS.phones) return;
    this.phones.push(
      this.formBuilder.nonNullable.control(value, Validators.maxLength(SHOP_PROFILE_LIMITS.phone))
    );
  }

  protected removePhone(index: number): void {
    this.phones.removeAt(index);
  }

  protected onLogoSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      this.logoError.set('shopProfilePage.logo.invalidType');
      return;
    }
    if (file.size > SHOP_PROFILE_LIMITS.logoBytes) {
      this.logoError.set('shopProfilePage.logo.tooLarge');
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        this.logo.set(reader.result);
        this.logoError.set(null);
      }
    };
    reader.onerror = () => this.logoError.set('shopProfilePage.logo.readFailed');
    reader.readAsDataURL(file);
  }

  protected removeLogo(): void {
    this.logo.set(null);
    this.logoError.set(null);
  }

  protected save(): void {
    this.outcome.set(null);
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }

    const raw = this.form.getRawValue();
    // Stage 21: VAT validation (the rate, and the tax number when VAT is on) before anything is sent.
    if (raw.vatEnabled && (this.vatRateInvalid() || !raw.taxNumber.trim())) {
      this.form.controls.vatRate.markAsTouched();
      this.form.controls.taxNumber.markAsTouched();
      return;
    }
    // The vat block goes out only when VAT was ever saved or this card was touched: a shop without VAT sends what it always sent.
    const vatTouched = this.form.controls.vatEnabled.dirty || this.form.controls.vatRate.dirty || this.form.controls.vatIncludes.dirty;
    const vat = this.lastProfile?.vat || vatTouched
      ? { enabled: raw.vatEnabled, rate: Number(raw.vatRate), pricesIncludeVat: raw.vatIncludes }
      : undefined;
    this.saving.set(true);
    this.shopProfileService
      .saveProfile({
        name: raw.name.trim(),
        address: raw.address.trim(),
        phones: raw.phones.map((phone) => phone.trim()).filter(Boolean),
        logo: this.logo(),
        taxNumber: raw.taxNumber.trim(),
        commercialRegister: raw.commercialRegister.trim(),
        invoiceFooter: raw.invoiceFooter.trim(),
        autoLockMinutes: normalizeAutoLock(raw.autoLockMinutes),
        ...(vat ? { vat } : {}),
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (profile) => {
          this.applyProfile(profile);
          this.saving.set(false);
          this.outcome.set({ kind: 'saved' });
        },
        error: (error) => {
          this.saving.set(false);
          const message = typeof error?.error?.message === 'string' ? error.error.message : '';
          this.outcome.set({ kind: 'error', message });
        },
      });
  }

  private applyProfile(profile: ShopProfile): void {
    this.lastProfile = profile;
    this.phones.clear();
    (profile.phones || []).slice(0, SHOP_PROFILE_LIMITS.phones).forEach((phone) => this.addPhone(phone));
    this.form.patchValue({
      name: profile.name || '',
      address: profile.address || '',
      taxNumber: profile.taxNumber || '',
      commercialRegister: profile.commercialRegister || '',
      invoiceFooter: profile.invoiceFooter || '',
      autoLockMinutes: normalizeAutoLock(profile.autoLockMinutes),
      vatEnabled: profile.vat?.enabled ?? false,
      vatRate: String(profile.vat?.rate ?? DEFAULT_VAT.rate),
      vatIncludes: profile.vat?.pricesIncludeVat ?? DEFAULT_VAT.pricesIncludeVat,
    });
    this.vatStartDate.set(profile.vat?.enabled ? profile.vat.startDate ?? null : null);
    this.form.markAsPristine();
    this.logo.set(profile.logo || null);
  }
}
