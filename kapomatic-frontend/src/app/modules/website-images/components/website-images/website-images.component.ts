import { CommonModule } from '@angular/common';
import { ChangeDetectorRef, Component, OnInit } from '@angular/core';
import { FormArray, FormBuilder, FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { TranslatePipe } from '@ngx-translate/core';
import { forkJoin } from 'rxjs';
import { DialogModule } from 'primeng/dialog';
import { MultiSelectModule } from 'primeng/multiselect';
import { TableModule } from 'primeng/table';
import { SideNavComponent } from '../../../layout/components/side-nav/side-nav.component';
import { ThemeService } from '../../../shared/services/theme.service';
import {
  WebsiteImage,
  WebsiteImageCategoryOption,
  WebsiteImagePayload,
  WebsiteImageProductOption,
  WebsiteImageSpecificationFilter,
  WebsiteImageSpecificationOption,
  WebsiteImageTargetType
} from '../../models/website-images.models';
import { WebsiteImagesService } from '../../services/website-images.service';

type WebsiteImageForm = FormGroup<{
  title: FormControl<string>;
  imageBase64: FormControl<string>;
  targetType: FormControl<WebsiteImageTargetType>;
  categoryIds: FormControl<string[]>;
  productIds: FormControl<string[]>;
  maxPrice: FormControl<number | null>;
  specificationFilters: FormArray<SpecificationFilterForm>;
  viewOnly: FormControl<boolean>;
  isActive: FormControl<boolean>;
}>;

type SpecificationFilterForm = FormGroup<{
  specificationName: FormControl<string>;
  values: FormControl<string[]>;
}>;

@Component({
  selector: 'app-website-images',
  standalone: true,
  imports: [
    CommonModule,
    ReactiveFormsModule,
    SideNavComponent,
    TranslatePipe,
    DialogModule,
    MultiSelectModule,
    TableModule
  ],
  templateUrl: './website-images.component.html',
  styleUrl: './website-images.component.scss'
})
export class WebsiteImagesComponent implements OnInit {
  isDarkMode$;
  images: WebsiteImage[] = [];
  categories: WebsiteImageCategoryOption[] = [];
  products: WebsiteImageProductOption[] = [];
  resolvedProducts: WebsiteImageProductOption[] = [];
  form: WebsiteImageForm;
  imagePreview = '';
  editingId: string | null = null;
  deletingImage: WebsiteImage | null = null;
  previewingImage: WebsiteImage | null = null;
  editorVisible = false;
  deleteVisible = false;
  productsPreviewVisible = false;
  isLoading = false;
  isCategoriesLoading = false;
  isProductsLoading = false;
  isSpecificationsLoading = false;
  isEditorLoading = false;
  isSaving = false;
  isDeleting = false;
  isPreviewLoading = false;
  loadError = '';
  formError = '';
  previewError = '';
  availableSpecifications: WebsiteImageSpecificationOption[] = [];
  private productLoadSequence = 0;
  private specificationLoadSequence = 0;

  constructor(
    private readonly fb: FormBuilder,
    private readonly service: WebsiteImagesService,
    private readonly themeService: ThemeService,
    private readonly cdr: ChangeDetectorRef
  ) {
    this.isDarkMode$ = this.themeService.isDarkMode$;
    this.form = this.createForm();
  }

  ngOnInit(): void {
    this.loadImages();
    this.loadCategories();
  }

  get targetType(): WebsiteImageTargetType {
    return this.form.controls.targetType.value;
  }

  get isViewOnly(): boolean {
    return this.form.controls.viewOnly.value;
  }

  get showsCategories(): boolean {
    return !this.isViewOnly && ['category', 'product', 'both', 'price', 'specification'].includes(this.targetType);
  }

  get showsProducts(): boolean {
    return !this.isViewOnly && (this.targetType === 'product' || this.targetType === 'both');
  }

  get showsMaxPrice(): boolean {
    return !this.isViewOnly && this.targetType === 'price';
  }

  get showsSpecification(): boolean {
    return !this.isViewOnly && this.targetType === 'specification';
  }

  get specificationFilters(): FormArray<SpecificationFilterForm> {
    return this.form.controls.specificationFilters;
  }

  loadImages(): void {
    this.isLoading = true;
    this.loadError = '';

    this.service.getWebsiteImages().subscribe({
      next: (images) => {
        this.images = images;
        this.isLoading = false;
        this.cdr.detectChanges();
      },
      error: (error) => {
        this.loadError = this.errorMessage(error, 'Failed to load website images.');
        this.isLoading = false;
        this.cdr.detectChanges();
      }
    });
  }

  loadCategories(): void {
    this.isCategoriesLoading = true;

    this.service.getCategories().subscribe({
      next: (categories) => {
        this.categories = categories;
        this.isCategoriesLoading = false;
        this.cdr.detectChanges();
      },
      error: (error) => {
        this.formError = this.errorMessage(error, 'Failed to load categories.');
        this.isCategoriesLoading = false;
        this.cdr.detectChanges();
      }
    });
  }

  openCreate(): void {
    this.editingId = null;
    this.form = this.createForm();
    this.imagePreview = '';
    this.products = [];
    this.availableSpecifications = [];
    this.formError = '';
    this.updateConditionalValidators();
    this.editorVisible = true;
    this.cdr.detectChanges();
  }

  openEdit(image: WebsiteImage): void {
    this.editingId = image.id;
    this.form = this.createForm();
    this.imagePreview = image.image;
    this.products = [];
    this.formError = '';
    this.isEditorLoading = true;
    this.editorVisible = true;

    this.service.getWebsiteImage(image.id).subscribe({
      next: (details) => {
        this.imagePreview = details.image;
        this.form.patchValue({
          title: details.title,
          targetType: details.targetType,
          categoryIds: details.categoryIds,
          productIds: details.productIds,
          maxPrice: details.maxPrice,
          viewOnly: details.viewOnly,
          isActive: details.isActive
        });
        this.setSpecificationFilters(details.specificationFilters);
        this.updateConditionalValidators();
        this.form.markAsPristine();
        this.isEditorLoading = false;

        if (this.showsProducts) {
          this.loadProductsForSelectedCategories();
        }
        if (this.showsSpecification) {
          this.loadSpecificationsForSelectedCategories();
        }
        this.cdr.detectChanges();
      },
      error: (error) => {
        this.formError = this.errorMessage(error, 'Failed to load website image details.');
        this.isEditorLoading = false;
        this.cdr.detectChanges();
      }
    });
  }

  closeEditor(): void {
    if (this.isSaving) return;
    this.productLoadSequence++;
    this.specificationLoadSequence++;
    this.editorVisible = false;
    this.editingId = null;
    this.formError = '';
    this.products = [];
    this.availableSpecifications = [];
  }

  onTargetTypeChanged(): void {
    if (!this.showsCategories) this.form.controls.categoryIds.setValue([]);
    if (!this.showsProducts) {
      this.form.controls.productIds.setValue([]);
      this.products = [];
    }
    if (!this.showsMaxPrice) this.form.controls.maxPrice.setValue(null);
    if (!this.showsSpecification) {
      this.clearSpecificationFilters();
      this.availableSpecifications = [];
    }
    if (this.showsProducts) {
      this.loadProductsForSelectedCategories();
    }
    if (this.showsSpecification) {
      this.clearSpecificationFilters();
      this.loadSpecificationsForSelectedCategories();
    }

    this.updateConditionalValidators();
    this.cdr.detectChanges();
  }

  onViewOnlyChanged(): void {
    if (this.isViewOnly) {
      this.form.controls.categoryIds.setValue([]);
      this.form.controls.productIds.setValue([]);
      this.form.controls.maxPrice.setValue(null);
      this.products = [];
      this.clearSpecificationFilters();
      this.availableSpecifications = [];
      this.productLoadSequence++;
      this.specificationLoadSequence++;
    }

    this.updateConditionalValidators();
    this.cdr.detectChanges();
  }

  onCategoriesChanged(): void {
    if (this.showsProducts) {
      this.loadProductsForSelectedCategories();
    }
    if (this.showsSpecification) {
      this.clearSpecificationFilters();
      this.loadSpecificationsForSelectedCategories();
    }
  }

  addSpecificationFilter(): void {
    if (!this.availableSpecifications.length) return;
    this.specificationFilters.push(this.createSpecificationFilter());
    this.specificationFilters.markAsDirty();
  }

  removeSpecificationFilter(index: number): void {
    this.specificationFilters.removeAt(index);
    this.specificationFilters.markAsDirty();
  }

  onSpecificationChanged(index: number): void {
    this.specificationFilters.at(index).controls.values.setValue([]);
  }

  getSpecificationNames(index: number): string[] {
    const currentName = this.specificationFilters.at(index)?.controls.specificationName.value;
    const selectedNames = new Set(this.specificationFilters.controls
      .map((control, controlIndex) => controlIndex === index ? '' : control.controls.specificationName.value.toLocaleLowerCase())
      .filter(Boolean));
    const names = this.availableSpecifications
      .map((specification) => specification.specificationName)
      .filter((name) => name === currentName || !selectedNames.has(name.toLocaleLowerCase()));
    return currentName && !names.includes(currentName) ? [currentName, ...names] : names;
  }

  getSpecificationValues(specificationName: string, selectedValues: string[] = []): string[] {
    const normalizedName = String(specificationName || '').trim().toLocaleLowerCase();
    const availableValues = this.availableSpecifications.find(
      (specification) => specification.specificationName.toLocaleLowerCase() === normalizedName
    )?.values || [];
    return Array.from(new Set([...selectedValues, ...availableValues]));
  }

  canAddSpecificationFilter(): boolean {
    return this.availableSpecifications.length > this.specificationFilters.length &&
      this.specificationFilters.controls.every((control) => !!control.controls.specificationName.value);
  }

  onImageSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      this.formError = 'Select a valid image file.';
      input.value = '';
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== 'string') return;
      this.form.controls.imageBase64.setValue(reader.result);
      this.form.controls.imageBase64.markAsDirty();
      this.imagePreview = reader.result;
      this.formError = '';
      this.cdr.detectChanges();
    };
    reader.onerror = () => {
      this.formError = 'The selected image could not be read.';
      input.value = '';
      this.cdr.detectChanges();
    };
    reader.readAsDataURL(file);
  }

  save(): void {
    if (this.form.invalid || this.isSaving || this.isEditorLoading) {
      this.form.markAllAsTouched();
      return;
    }

    this.isSaving = true;
    this.formError = '';
    const payload = this.buildPayload();
    const request = this.editingId
      ? this.service.updateWebsiteImage(this.editingId, payload)
      : this.service.createWebsiteImage(payload);

    request.subscribe({
      next: () => {
        this.isSaving = false;
        this.editorVisible = false;
        this.editingId = null;
        this.loadImages();
        this.cdr.detectChanges();
      },
      error: (error) => {
        this.formError = this.errorMessage(error, 'Failed to save website image.');
        this.isSaving = false;
        this.cdr.detectChanges();
      }
    });
  }

  requestDelete(image: WebsiteImage): void {
    this.deletingImage = image;
    this.deleteVisible = true;
  }

  cancelDelete(): void {
    if (this.isDeleting) return;
    this.deleteVisible = false;
    this.deletingImage = null;
  }

  confirmDelete(): void {
    if (!this.deletingImage || this.isDeleting) return;

    this.isDeleting = true;
    this.service.deleteWebsiteImage(this.deletingImage.id).subscribe({
      next: () => {
        this.isDeleting = false;
        this.deleteVisible = false;
        this.deletingImage = null;
        this.loadImages();
      },
      error: (error) => {
        this.isDeleting = false;
        this.deleteVisible = false;
        this.loadError = this.errorMessage(error, 'Failed to delete website image.');
        this.deletingImage = null;
        this.cdr.detectChanges();
      }
    });
  }

  previewProducts(image: WebsiteImage): void {
    this.previewingImage = image;
    this.resolvedProducts = [];
    this.previewError = '';
    this.isPreviewLoading = true;
    this.productsPreviewVisible = true;

    this.service.getResolvedProducts(image.id).subscribe({
      next: (products) => {
        this.resolvedProducts = products;
        this.isPreviewLoading = false;
        this.cdr.detectChanges();
      },
      error: (error) => {
        this.previewError = this.errorMessage(error, 'Failed to resolve targeted products.');
        this.isPreviewLoading = false;
        this.cdr.detectChanges();
      }
    });
  }

  private loadProductsForSelectedCategories(): void {
    const categoryIds = this.form.controls.categoryIds.value;
    const requestSequence = ++this.productLoadSequence;

    if (!categoryIds.length) {
      this.products = [];
      this.form.controls.productIds.setValue([]);
      this.isProductsLoading = false;
      return;
    }

    this.isProductsLoading = true;
    this.formError = '';
    forkJoin(categoryIds.map((categoryId) => this.service.getProductsByCategory(categoryId))).subscribe({
      next: (productGroups) => {
        if (requestSequence !== this.productLoadSequence) return;
        const productsById = new Map<string, WebsiteImageProductOption>();
        productGroups.flat().forEach((product) => productsById.set(product.id, product));
        this.products = Array.from(productsById.values());

        const availableIds = new Set(this.products.map((product) => product.id));
        const selectedIds = this.form.controls.productIds.value.filter((id) => availableIds.has(id));
        this.form.controls.productIds.setValue(selectedIds, { emitEvent: false });
        this.isProductsLoading = false;
        this.cdr.detectChanges();
      },
      error: (error) => {
        if (requestSequence !== this.productLoadSequence) return;
        this.products = [];
        this.isProductsLoading = false;
        this.formError = this.errorMessage(error, 'Failed to load products for the selected categories.');
        this.cdr.detectChanges();
      }
    });
  }

  private loadSpecificationsForSelectedCategories(): void {
    const categoryIds = this.form.controls.categoryIds.value;
    const requestSequence = ++this.specificationLoadSequence;

    if (!categoryIds.length) {
      this.availableSpecifications = [];
      this.isSpecificationsLoading = false;
      return;
    }

    this.isSpecificationsLoading = true;
    this.formError = '';
    this.service.getSpecifications(categoryIds).subscribe({
      next: (specifications) => {
        if (requestSequence !== this.specificationLoadSequence) return;
        this.availableSpecifications = specifications;
        this.isSpecificationsLoading = false;
        this.cdr.detectChanges();
      },
      error: (error) => {
        if (requestSequence !== this.specificationLoadSequence) return;
        this.availableSpecifications = [];
        this.isSpecificationsLoading = false;
        this.formError = this.errorMessage(error, 'Failed to load specifications for the selected categories.');
        this.cdr.detectChanges();
      }
    });
  }

  private createForm(): WebsiteImageForm {
    return this.fb.group({
      title: this.fb.nonNullable.control('', [Validators.required, Validators.maxLength(150)]),
      imageBase64: this.fb.nonNullable.control(''),
      targetType: this.fb.nonNullable.control<WebsiteImageTargetType>('category', Validators.required),
      categoryIds: this.fb.nonNullable.control<string[]>([]),
      productIds: this.fb.nonNullable.control<string[]>([]),
      maxPrice: this.fb.control<number | null>(null),
      specificationFilters: this.fb.array<SpecificationFilterForm>([]),
      viewOnly: this.fb.nonNullable.control(false),
      isActive: this.fb.nonNullable.control(true)
    });
  }

  private updateConditionalValidators(): void {
    const titleControl = this.form.controls.title;
    const categoryControl = this.form.controls.categoryIds;
    const productControl = this.form.controls.productIds;
    const maxPriceControl = this.form.controls.maxPrice;
    const specificationFiltersControl = this.form.controls.specificationFilters;

    titleControl.clearValidators();
    categoryControl.clearValidators();
    productControl.clearValidators();
    maxPriceControl.clearValidators();
    specificationFiltersControl.clearValidators();

    titleControl.addValidators(this.isViewOnly
      ? Validators.maxLength(150)
      : [Validators.required, Validators.maxLength(150)]);
    if (!this.isViewOnly && ['category', 'product', 'both', 'specification'].includes(this.targetType)) {
      categoryControl.addValidators(Validators.required);
    }
    if (this.showsProducts) {
      productControl.addValidators(Validators.required);
    }
    if (this.showsMaxPrice) {
      maxPriceControl.addValidators([Validators.required, Validators.min(0)]);
    }
    if (this.showsSpecification) {
      specificationFiltersControl.addValidators(Validators.required);
    }
    if (!this.editingId) {
      this.form.controls.imageBase64.setValidators(Validators.required);
    } else {
      this.form.controls.imageBase64.clearValidators();
    }

    titleControl.updateValueAndValidity({ emitEvent: false });
    categoryControl.updateValueAndValidity({ emitEvent: false });
    productControl.updateValueAndValidity({ emitEvent: false });
    maxPriceControl.updateValueAndValidity({ emitEvent: false });
    specificationFiltersControl.updateValueAndValidity({ emitEvent: false });
    this.form.controls.imageBase64.updateValueAndValidity({ emitEvent: false });
  }

  private buildPayload(): WebsiteImagePayload {
    const value = this.form.getRawValue();
    const title = value.title.trim();
    const payload: WebsiteImagePayload = {
      viewOnly: value.viewOnly,
      isActive: value.isActive
    };

    if (title) payload.title = title;
    if (value.imageBase64) payload.imageBase64 = value.imageBase64;
    if (value.viewOnly) return payload;

    payload.targetType = value.targetType;
    if (this.showsCategories) payload.categoryIds = value.categoryIds;
    if (this.showsProducts) payload.productIds = value.productIds;
    if (this.showsMaxPrice && value.maxPrice !== null) payload.maxPrice = Number(value.maxPrice);
    if (this.showsSpecification) {
      payload.specificationFilters = value.specificationFilters.map((filter) => ({
        specificationName: filter.specificationName.trim(),
        values: filter.values.map((item) => item.trim()).filter(Boolean)
      }));
    }
    return payload;
  }

  private createSpecificationFilter(filter?: WebsiteImageSpecificationFilter): SpecificationFilterForm {
    return this.fb.group({
      specificationName: this.fb.nonNullable.control(filter?.specificationName || '', Validators.required),
      values: this.fb.nonNullable.control<string[]>(filter?.values || [], Validators.required)
    });
  }

  private setSpecificationFilters(filters: WebsiteImageSpecificationFilter[]): void {
    this.clearSpecificationFilters();
    filters.forEach((filter) => this.specificationFilters.push(this.createSpecificationFilter(filter)));
  }

  private clearSpecificationFilters(): void {
    this.specificationFilters.clear();
  }

  private errorMessage(error: any, fallback: string): string {
    return error?.error?.message || error?.message || fallback;
  }
}
