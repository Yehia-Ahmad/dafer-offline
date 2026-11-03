import { CommonModule } from '@angular/common';
import { Component, DestroyRef, Input, OnChanges, OnInit, SimpleChanges, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { AbstractControl, ReactiveFormsModule } from '@angular/forms';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { catchError, debounceTime, distinctUntilChanged, filter, of, switchMap, tap } from 'rxjs';
import { ButtonModule } from 'primeng/button';
import {
  SeoEditorForm,
  SeoEntityType,
  SeoFormContext,
  SeoLanguage,
  SeoPreviewDevice,
  SeoSearchPreviewData
} from '../../models/seo.models';
import { SeoAdminService } from '../../services/seo-admin.service';
import {
  buildSeoPreviewData,
  extractDuplicateSlugMatch,
  generateArabicSlug,
  generateEnglishSlug,
  generateSeoSuggestions
} from '../../utilities/seo.utils';
import { SeoSearchPreviewComponent } from '../seo-search-preview/seo-search-preview.component';

type SeoTab = 'basic' | 'ar' | 'en' | 'social' | 'preview' | 'advanced';

@Component({
  selector: 'app-seo-form',
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule, TranslatePipe, ButtonModule, SeoSearchPreviewComponent],
  templateUrl: './seo-form.component.html',
  styleUrl: './seo-form.component.scss'
})
export class SeoFormComponent implements OnInit, OnChanges {
  @Input({ required: true }) form!: SeoEditorForm;
  @Input({ required: true }) context!: SeoFormContext;
  @Input() entityType: SeoEntityType = 'category';

  activeTab: SeoTab = 'basic';
  previewLanguage: SeoLanguage = 'ar';
  previewDevice: SeoPreviewDevice = 'desktop';
  arSlugChecking = false;
  enSlugChecking = false;
  arSlugManuallyEdited = false;
  enSlugManuallyEdited = false;
  private readonly destroyRef = inject(DestroyRef);
  private registeredForm: SeoEditorForm | null = null;

  readonly tabs: Array<{ id: SeoTab; labelKey: string }> = [
    { id: 'basic', labelKey: 'seo.tabs.basic' },
    { id: 'ar', labelKey: 'seo.tabs.ar' },
    { id: 'en', labelKey: 'seo.tabs.en' },
    { id: 'social', labelKey: 'seo.tabs.social' },
    { id: 'preview', labelKey: 'seo.tabs.preview' },
    { id: 'advanced', labelKey: 'seo.tabs.advanced' }
  ];
  readonly changeFrequencyOptions = ['always', 'hourly', 'daily', 'weekly', 'monthly', 'yearly', 'never'];

  constructor(
    private readonly seoAdminService: SeoAdminService,
    private readonly translate: TranslateService
  ) {}

  ngOnInit(): void {
    this.registerFormSubscriptions();
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['form'] && !changes['form'].firstChange) {
      this.registerFormSubscriptions();
    }
    if (changes['context'] && this.context?.image && this.form?.controls.seo.controls.useEntityImageFallback.value) {
      this.form.controls.seo.controls.ogImage.setValue(this.context.image, { emitEvent: false });
    }
  }

  get preview(): SeoSearchPreviewData {
    return buildSeoPreviewData(this.form, this.context, this.previewLanguage);
  }

  get currentLanguage(): string {
    return this.translate.currentLang || this.translate.defaultLang || 'en';
  }

  setTab(tab: SeoTab): void {
    this.activeTab = tab;
  }

  markSlugManual(language: SeoLanguage): void {
    if (language === 'ar') {
      this.arSlugManuallyEdited = true;
      return;
    }
    this.enSlugManuallyEdited = true;
  }

  generateSlug(language: SeoLanguage, force = false): void {
    const controls = this.form.controls.translations.controls[language].controls;
    const existingSlug = controls.slug.value.trim();
    const manuallyEdited = language === 'ar' ? this.arSlugManuallyEdited : this.enSlugManuallyEdited;

    if (existingSlug && manuallyEdited && !force) {
      const confirmed = window.confirm(this.translate.instant('seo.messages.regenerateSlugConfirm'));
      if (!confirmed) return;
    }

    const source = controls.name.value || this.context.legacyName || '';
    const nextSlug = language === 'ar' ? generateArabicSlug(source) : generateEnglishSlug(source);
    controls.slug.setValue(nextSlug);
    controls.slug.markAsDirty();
    if (language === 'ar') {
      this.arSlugManuallyEdited = false;
    } else {
      this.enSlugManuallyEdited = false;
    }
  }

  generateSeo(overwrite = false): void {
    if (!overwrite && this.hasGeneratedFields()) {
      const confirmed = window.confirm(this.translate.instant('seo.messages.overwriteConfirm'));
      if (!confirmed) return;
      generateSeoSuggestions(this.form, this.context, true);
      return;
    }

    generateSeoSuggestions(this.form, this.context, overwrite);
  }

  applyDuplicateSlugError(error: unknown): boolean {
    const match = extractDuplicateSlugMatch(error);
    if (!match) return false;

    const control = this.slugControl(match.language);
    control.setErrors({
      ...(control.errors || {}),
      slugDuplicate: match.message || true
    });
    control.markAsTouched();
    this.activeTab = match.language;
    return true;
  }

  fieldError(control: AbstractControl | null): string {
    if (!control || !control.errors || !(control.touched || control.dirty)) return '';
    const errors = control.errors;
    if (errors['required']) return this.translate.instant('seo.validation.required');
    if (errors['slugMaxLength']) return this.translate.instant('seo.validation.slugMaxLength');
    if (errors['slugSlash']) return this.translate.instant('seo.validation.slugSlash');
    if (errors['slugQuery']) return this.translate.instant('seo.validation.slugQuery');
    if (errors['slugProtocol']) return this.translate.instant('seo.validation.slugProtocol');
    if (errors['slugEdgeHyphen']) return this.translate.instant('seo.validation.slugEdgeHyphen');
    if (errors['slugRepeatedHyphen']) return this.translate.instant('seo.validation.slugRepeatedHyphen');
    if (errors['slugDuplicate']) return typeof errors['slugDuplicate'] === 'string'
      ? errors['slugDuplicate']
      : this.translate.instant('seo.validation.slugDuplicate');
    if (errors['metaTitleMaxLength']) return this.translate.instant('seo.validation.metaTitleHard');
    if (errors['metaDescriptionMaxLength']) return this.translate.instant('seo.validation.metaDescriptionHard');
    if (errors['maxlength']) return this.translate.instant('seo.validation.maxLength');
    if (errors['canonicalUrl']) return this.translate.instant('seo.validation.canonicalUrl');
    if (errors['keywordsCount']) return this.translate.instant('seo.validation.keywordsCount');
    if (errors['keywordMaxLength']) return this.translate.instant('seo.validation.keywordMaxLength');
    if (errors['sitemapPriority']) return this.translate.instant('seo.validation.sitemapPriority');
    return this.translate.instant('seo.validation.invalid');
  }

  warningFor(field: 'metaTitle' | 'metaDescription' | 'imageAlt' | 'canonical', language?: SeoLanguage): string {
    if (field === 'metaTitle' && language) {
      const value = this.form.controls.seo.controls[language].controls.metaTitle.value.trim();
      return value.length > 60 && value.length <= 70 ? this.translate.instant('seo.warnings.metaTitle') : '';
    }

    if (field === 'metaDescription' && language) {
      const value = this.form.controls.seo.controls[language].controls.metaDescription.value.trim();
      return value.length > 160 && value.length <= 200 ? this.translate.instant('seo.warnings.metaDescription') : '';
    }

    if (field === 'imageAlt' && language) {
      const value = this.form.controls.translations.controls[language].controls.imageAlt.value.trim();
      return this.context?.image && !value ? this.translate.instant('seo.warnings.imageAlt') : '';
    }

    if (field === 'canonical') {
      return this.translate.instant('seo.warnings.canonical');
    }

    return '';
  }

  private registerSlugAvailability(language: SeoLanguage): void {
    const control = this.slugControl(language);
    control.valueChanges.pipe(
      debounceTime(450),
      distinctUntilChanged(),
      tap(() => this.setSlugChecking(language, false)),
      filter((value) => {
        const slug = String(value || '').trim();
        return slug.length > 0 && !control.hasError('slugMaxLength') && !control.hasError('slugSlash') &&
          !control.hasError('slugQuery') && !control.hasError('slugProtocol') &&
          !control.hasError('slugEdgeHyphen') && !control.hasError('slugRepeatedHyphen');
      }),
      tap(() => this.setSlugChecking(language, true)),
      switchMap((slug) => this.seoAdminService.checkSlugAvailability({
        entityType: this.entityType,
        language,
        slug: String(slug).trim(),
        excludeId: this.context.entityId
      }).pipe(
        catchError((error) => {
          if (error?.status === 409) {
            return of({ available: false, slug: String(slug), language, entityType: this.entityType });
          }
          return of(null);
        })
      )),
      takeUntilDestroyed(this.destroyRef)
    ).subscribe((result) => {
      this.setSlugChecking(language, false);
      if (!result) return;
      const latestControl = this.slugControl(language);
      const currentErrors = { ...(latestControl.errors || {}) };
      delete currentErrors['slugDuplicate'];

      if (!result.available) {
        latestControl.setErrors({ ...currentErrors, slugDuplicate: true });
        return;
      }

      latestControl.setErrors(Object.keys(currentErrors).length ? currentErrors : null);
    });
  }

  private registerFormSubscriptions(): void {
    if (!this.form || this.registeredForm === this.form) return;
    this.registeredForm = this.form;
    this.registerSlugAvailability('ar');
    this.registerSlugAvailability('en');
  }

  private slugControl(language: SeoLanguage) {
    return this.form.controls.translations.controls[language].controls.slug;
  }

  private setSlugChecking(language: SeoLanguage, checking: boolean): void {
    if (language === 'ar') {
      this.arSlugChecking = checking;
    } else {
      this.enSlugChecking = checking;
    }
  }

  private hasGeneratedFields(): boolean {
    const raw = this.form.getRawValue();
    return Boolean(
      raw.translations.ar.slug || raw.translations.en.slug ||
      raw.seo.ar.metaTitle || raw.seo.en.metaTitle ||
      raw.seo.ar.metaDescription || raw.seo.en.metaDescription ||
      raw.seo.ar.keywordsText || raw.seo.en.keywordsText
    );
  }
}
