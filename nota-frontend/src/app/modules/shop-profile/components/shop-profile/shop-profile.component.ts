import { AsyncPipe, NgClass } from '@angular/common';
import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormArray, FormBuilder, FormControl, ReactiveFormsModule, Validators } from '@angular/forms';
import { TranslatePipe } from '@ngx-translate/core';
import { SideNavComponent } from '../../../layout/components/side-nav/side-nav.component';
import { LanguageService } from '../../../shared/services/translation.service';
import { ThemeService } from '../../../shared/services/theme.service';
import { SHOP_PROFILE_LIMITS, ShopProfile } from '../../models/shop-profile.model';
import { ShopProfileService } from '../../services/shop-profile.service';

type Outcome = { kind: 'saved' } | { kind: 'error'; message: string };

/** The shop's own details (name, address, phones, logo, tax number, ...), printed on invoices. */
@Component({
  selector: 'app-shop-profile',
  imports: [SideNavComponent, TranslatePipe, AsyncPipe, NgClass, ReactiveFormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-side-nav>
      <main class="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4 md:p-8" [attr.dir]="direction()">
        <header>
          <h1 class="mb-1 text-2xl font-bold">{{ 'shopProfilePage.title' | translate }}</h1>
          <p class="text-gray-500">{{ 'shopProfilePage.subtitle' | translate }}</p>
        </header>

        @if (loading()) {
          <div class="flex items-center gap-3" role="status">
            <span class="h-5 w-5 animate-spin rounded-full border-4 border-gray-300 border-t-[#FF9933]"></span>
            <span>{{ 'shopProfilePage.loading' | translate }}</span>
          </div>
        } @else {
          @if (loadError()) {
            <div class="rounded-xl bg-[#fdecea] p-4 leading-7 text-[#8a1c12]" role="alert">{{ 'shopProfilePage.messages.loadFailed' | translate }}</div>
          }

          <form class="flex flex-col gap-6" [formGroup]="form" (ngSubmit)="save()" novalidate>
            <section class="flex flex-col gap-4 rounded-xl p-6" [ngClass]="cardClass(isDarkMode$ | async)">
              <label class="flex flex-col gap-1">
                <span class="font-semibold">{{ 'shopProfilePage.fields.name' | translate }} *</span>
                <input type="text" formControlName="name" [maxLength]="limits.name" [ngClass]="inputClass(isDarkMode$ | async)" />
                @if (showError('name')) {
                  <small class="text-[#8a1c12]">{{ 'shopProfilePage.validation.nameRequired' | translate }}</small>
                }
              </label>

              <label class="flex flex-col gap-1">
                <span class="font-semibold">{{ 'shopProfilePage.fields.address' | translate }}</span>
                <textarea rows="2" formControlName="address" [maxLength]="limits.address" [ngClass]="inputClass(isDarkMode$ | async)"></textarea>
              </label>

              <div class="flex flex-col gap-2">
                <span class="font-semibold">{{ 'shopProfilePage.fields.phones' | translate }}</span>
                @for (phone of phones.controls; track $index; let i = $index) {
                  <div class="flex items-center gap-2">
                    <input type="tel" dir="ltr" [formControl]="phone" [maxLength]="limits.phone"
                      [attr.aria-label]="('shopProfilePage.fields.phone' | translate) + ' ' + (i + 1)"
                      class="flex-1" [ngClass]="inputClass(isDarkMode$ | async)" />
                    <button type="button" class="underline" (click)="removePhone(i)">{{ 'shopProfilePage.actions.removePhone' | translate }}</button>
                  </div>
                }
                @if (phones.length < limits.phones) {
                  <button type="button" class="self-start rounded-lg px-4 py-1 font-semibold outline outline-1 outline-[#FF9933]" (click)="addPhone()">
                    {{ 'shopProfilePage.actions.addPhone' | translate }}
                  </button>
                }
              </div>

              <div class="grid gap-4 md:grid-cols-2">
                <label class="flex flex-col gap-1">
                  <span class="font-semibold">{{ 'shopProfilePage.fields.taxNumber' | translate }}</span>
                  <input type="text" dir="ltr" formControlName="taxNumber" [maxLength]="limits.taxNumber" [ngClass]="inputClass(isDarkMode$ | async)" />
                </label>
                <label class="flex flex-col gap-1">
                  <span class="font-semibold">{{ 'shopProfilePage.fields.commercialRegister' | translate }}</span>
                  <input type="text" dir="ltr" formControlName="commercialRegister" [maxLength]="limits.commercialRegister" [ngClass]="inputClass(isDarkMode$ | async)" />
                </label>
              </div>

              <label class="flex flex-col gap-1">
                <span class="font-semibold">{{ 'shopProfilePage.fields.invoiceFooter' | translate }}</span>
                <textarea rows="3" formControlName="invoiceFooter" [maxLength]="limits.invoiceFooter" [ngClass]="inputClass(isDarkMode$ | async)"></textarea>
                <small class="text-gray-500">{{ 'shopProfilePage.hints.invoiceFooter' | translate }}</small>
              </label>
            </section>

            <section class="flex flex-col gap-3 rounded-xl p-6" [ngClass]="cardClass(isDarkMode$ | async)">
              <h2 class="text-lg font-semibold">{{ 'shopProfilePage.fields.logo' | translate }}</h2>
              @if (logo(); as src) {
                <img [src]="src" [alt]="'shopProfilePage.fields.logo' | translate" class="max-h-40 w-auto self-start rounded-lg border border-gray-300 object-contain p-2" />
              } @else {
                <p class="text-gray-500">{{ 'shopProfilePage.logo.none' | translate }}</p>
              }
              <div class="flex flex-wrap items-center gap-3">
                <label class="cursor-pointer rounded-lg px-4 py-1 font-semibold outline outline-1 outline-[#FF9933]">
                  {{ (logo() ? 'shopProfilePage.logo.change' : 'shopProfilePage.logo.upload') | translate }}
                  <input type="file" accept="image/*" class="hidden" (change)="onLogoSelected($event)" />
                </label>
                @if (logo()) {
                  <button type="button" class="underline" (click)="removeLogo()">{{ 'shopProfilePage.logo.remove' | translate }}</button>
                }
              </div>
              <small class="text-gray-500">{{ 'shopProfilePage.logo.hint' | translate }}</small>
              @if (logoError(); as key) {
                <small class="text-[#8a1c12]" role="alert">{{ key | translate }}</small>
              }
            </section>

            <div class="flex flex-wrap items-center gap-4">
              <button type="submit" class="rounded-lg bg-[#FF9933] px-6 py-2 font-semibold text-[#2f2f2f] disabled:opacity-60" [disabled]="saving()">
                {{ (saving() ? 'shopProfilePage.actions.saving' : 'shopProfilePage.actions.save') | translate }}
              </button>
              @if (outcome(); as result) {
                <span role="status" [ngClass]="result.kind === 'error' ? 'text-[#8a1c12]' : 'text-[#1b5e20]'">
                  @if (result.kind === 'saved') {
                    {{ 'shopProfilePage.messages.saved' | translate }}
                  } @else if (result.message) {
                    {{ result.message }}
                  } @else {
                    {{ 'shopProfilePage.messages.saveFailed' | translate }}
                  }
                </span>
              }
            </div>
          </form>
        }
      </main>
    </app-side-nav>
  `,
})
export class ShopProfileComponent implements OnInit {
  private readonly shopProfileService = inject(ShopProfileService);
  private readonly formBuilder = inject(FormBuilder);
  private readonly destroyRef = inject(DestroyRef);
  private readonly language = inject(LanguageService);
  protected readonly isDarkMode$ = inject(ThemeService).isDarkMode$;
  protected readonly direction = computed(() => (this.language.selectedLanguage() === 'ar' ? 'rtl' : 'ltr'));
  protected readonly limits = SHOP_PROFILE_LIMITS;

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
  });

  protected get phones(): FormArray<FormControl<string>> {
    return this.form.controls.phones;
  }

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

  protected cardClass(dark: boolean | null): string {
    return dark ? 'bg-gray_dark text-white' : 'bg-white shadow';
  }

  protected inputClass(dark: boolean | null): string {
    return `rounded-lg border px-3 py-2 ${dark ? 'border-[#515151] bg-[#2f2f2f] text-white' : 'border-[#e2e2e2] bg-white text-[#2f2f2f]'}`;
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
    this.phones.clear();
    (profile.phones || []).slice(0, SHOP_PROFILE_LIMITS.phones).forEach((phone) => this.addPhone(phone));
    this.form.patchValue({
      name: profile.name || '',
      address: profile.address || '',
      taxNumber: profile.taxNumber || '',
      commercialRegister: profile.commercialRegister || '',
      invoiceFooter: profile.invoiceFooter || '',
    });
    this.form.markAsPristine();
    this.logo.set(profile.logo || null);
  }
}
