import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { FormArray, FormBuilder, FormControl, ReactiveFormsModule, Validators } from '@angular/forms';
import { TranslatePipe } from '@ngx-translate/core';
import { LanguageService } from '../../../shared/services/translation.service';
import { brandName } from '../../../../core/brand';
import { NotaButtonDirective, NotaFormFieldComponent, NotaPageHeaderComponent } from '../../../shared/ui';
import { SHOP_PROFILE_LIMITS, ShopProfile } from '../../models/shop-profile.model';
import { ShopProfileService } from '../../services/shop-profile.service';
import { AUTO_LOCK_CHOICES, DEFAULT_AUTO_LOCK_MINUTES, normalizeAutoLock } from '../../../../core/auth/idle-lock.service';
import { UnsavedWorkService } from '../../../../core/unsaved-work/unsaved-work.service';

type Outcome = { kind: 'saved' } | { kind: 'error'; message: string };

/** The shop's own details (name, address, phones, logo, tax number, ...), printed on invoices. Stage 11: ShopProfile.dc.html + live preview. */
@Component({
  selector: 'app-shop-profile',
  imports: [TranslatePipe, ReactiveFormsModule, NotaButtonDirective, NotaFormFieldComponent, NotaPageHeaderComponent],
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
  });

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
    });
    this.form.markAsPristine();
    this.logo.set(profile.logo || null);
  }
}
