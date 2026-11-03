import { CommonModule } from '@angular/common';
import { isPlatformBrowser } from '@angular/common';
import {
  ChangeDetectorRef,
  Component,
  DestroyRef,
  ElementRef,
  inject,
  OnDestroy,
  OnInit,
  PLATFORM_ID,
  ViewChild,
} from '@angular/core';
import { CateoryService, Product } from '../../services/cateory.service';
import { ActivatedRoute, Router } from '@angular/router';
import { SideNavComponent } from "../../../layout/components/side-nav/side-nav.component";
import { DialogModule } from "primeng/dialog";
import { FormArray, FormBuilder, FormGroup, FormsModule, ReactiveFormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from "primeng/select";
import { TranslatePipe } from '@ngx-translate/core';
import { ThemeService } from '../../../shared/services/theme.service';
import { ErrorIconComponent } from "../../../assets/error/error-icon.component";
import { LanguageService } from '../../../shared/services/translation.service';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { distinctUntilChanged, map } from 'rxjs';
import { SeoFormComponent } from '../../../seo/components/seo-form/seo-form.component';
import { SeoEditorForm, SeoFormContext } from '../../../seo/models/seo.models';
import { buildSeoFormValue, normalizeSeoExtensionPayload } from '../../../seo/utilities/seo.utils';
import { isWebsiteEnabled } from '../../../../core/runtime/app-features';

@Component({
  selector: 'app-category-details',
  standalone: true,
  imports: [
    CommonModule,
    ReactiveFormsModule,
    FormsModule,
    DialogModule,
    ButtonModule,
    SideNavComponent,
    SelectModule,
    TranslatePipe,
    ErrorIconComponent,
    SeoFormComponent,
],
  templateUrl: './category-details.component.html',
  styleUrl: './category-details.component.scss'
})
export class CategoryDetailsComponent implements OnInit, OnDestroy {
  @ViewChild(SeoFormComponent) private seoFormComponent?: SeoFormComponent;
  private readonly destroyRef = inject(DestroyRef);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));
  private readonly pageSize = 10;
  private scrollObserver?: IntersectionObserver;
  private scrollSentinel?: ElementRef<HTMLElement>;

  @ViewChild('scrollSentinel')
  set infiniteScrollSentinel(element: ElementRef<HTMLElement> | undefined) {
    this.scrollSentinel = element;
    this.observeScrollSentinel();
  }

  categoryId = '';
  categoryDetails: any;
  visible: boolean = false;
  categories: any[] = [];
  addProductForm: FormGroup;
  productSeoForm: SeoEditorForm;
  productSeoContext: SeoFormContext = { entityType: 'product' };
  readonly websiteEnabled = isWebsiteEnabled();
  products: Product[] = [];
  searchTerm = '';
  qrCodes: any[] = [];
  codes: string[] = [];
  selectedProduct: any;
  imagePreview: string | ArrayBuffer | null = null;
  

  // ✅ Loading flags for button disable state
  isLoading: boolean = false;
  isAddingProduct: boolean = false;
  isCreatingModel: boolean = false;
  isCreatingQrCodes: boolean = false;
  isPrinting: boolean = false;
  isDarkMode$;
  errorVisible = false;
  errorMessage = '';
  isLoadingProducts = false;
  hasLoadedProducts = false;
  hasNextPage = true;
  currentPage = 0;
  totalPages = 1;

  constructor(
    private _themeService: ThemeService,
    private _languageService: LanguageService,
    private _cateoryService: CateoryService,
    private _activatedRoute: ActivatedRoute,
    private fb: FormBuilder,
    private cdr: ChangeDetectorRef,
    private _router: Router
  ) {
    this.isDarkMode$ = this._themeService.isDarkMode$;
    this.initlizeAddProduct(null);
    this.productSeoForm = buildSeoFormValue(this.fb, 'product', {}, this.productSeoContext);
  }

  ngOnInit(): void {
    this._activatedRoute.paramMap.pipe(
      map((params) => params.get('id') ?? ''),
      distinctUntilChanged(),
      takeUntilDestroyed(this.destroyRef)
    ).subscribe((categoryId) => {
      this.categoryId = categoryId;
      this.initlizeAddProduct(categoryId);
      this.getAllCategories();
      this.resetProductsPagination();
      this.loadNextPage();
    });
  }

  ngOnDestroy(): void {
    this.scrollObserver?.disconnect();
  }

  get filteredProducts(): any[] {
    const normalizedSearchTerm = this.searchTerm.trim().toLowerCase();

    if (!normalizedSearchTerm) {
      return this.products;
    }

    return this.products.filter((product) => {
      const productName = String(product?.name || '').toLowerCase();
      const productCode = String(product?.code || '').toLowerCase();

      return productName.includes(normalizedSearchTerm) || productCode.includes(normalizedSearchTerm);
    });
  }

  get formDirection(): 'ltr' | 'rtl' {
    return this._languageService.selectedLanguage() === 'ar' ? 'rtl' : 'ltr';
  }

  initlizeAddProduct(category_id: string | null) {
    this.addProductForm = this.fb.group({
      name: [''],
      code: [''],
      inventoryCount: [''],
      imageBase64: [null],
      categoryId: [category_id],
      wholesalePrice: [''],
      purchasePrice: [''],
      retailPrice: [''],
      soldItemCount: [''],
      specifications: this.fb.array([]),
    });
  }

  get productDetails(): FormArray {
    return this.addProductForm.get('specifications') as FormArray;
  }

  private resetProductDetailsControls(details: { title: string; value?: string }[] = []): void {
    this.productDetails.clear();
    details.forEach((detail) => {
      this.productDetails.push(this.fb.group({
        title: [detail.title],
        value: [detail.value || '']
      }));
    });
  }

  getAllCategories() {
    this._cateoryService.getCategories().pipe(
      takeUntilDestroyed(this.destroyRef)
    ).subscribe({
      next: (res: any) => {
        this.categories = res;
        this.categoryDetails = this.categories.filter(cat => cat._id == this.categoryId)[0];
        this.cdr.detectChanges();
      }, 
      error: (err) => {
        this.errorVisible = true;
        this.errorMessage = err.error.message;
        this.cdr.detectChanges();
      }
    });
  }

  getProducts(): void {
    this.resetProductsPagination();
    this.loadNextPage();
  }

  loadNextPage(): void {
    if (!this.categoryId || this.isLoadingProducts || !this.hasNextPage) {
      return;
    }

    const requestedPage = this.currentPage + 1;
    this.isLoadingProducts = true;

    const requestedCategoryId = this.categoryId;
    this._cateoryService.getProductsPage(requestedCategoryId, {
      page: requestedPage,
      limit: this.pageSize
    }).pipe(
      takeUntilDestroyed(this.destroyRef)
    ).subscribe({
      next: ({ products, pagination }) => {
        if (this.categoryId !== requestedCategoryId) {
          return;
        }

        this.products = this.appendUniqueProducts(this.products, products);
        this.currentPage = pagination.page;
        this.totalPages = pagination.totalPages;
        this.hasNextPage = pagination.hasNextPage
          && pagination.page < pagination.totalPages;
        this.isLoadingProducts = false;
        this.hasLoadedProducts = true;
        this.cdr.detectChanges();
        this.observeScrollSentinel();
      },
      error: (err) => {
        if (this.categoryId !== requestedCategoryId) {
          return;
        }

        this.isLoadingProducts = false;
        this.hasLoadedProducts = true;
        this.errorVisible = true;
        this.errorMessage = err?.error?.message || err?.message || 'Failed to load products.';
        this.cdr.detectChanges();
      }
    });
  }

  retryProductsLoad(): void {
    this.errorVisible = false;
    this.loadNextPage();
  }

  showDialog() {
    this.resetForm();
    this.resetProductDetailsControls(this.buildProductDetailsFromCategory(this.categoryDetails));
    this.addProductForm.patchValue({
      code: this.getNextProductCode(),
      categoryId: this.categoryId,
    });
    this.refreshProductSeoContext();
    this.productSeoForm = buildSeoFormValue(this.fb, 'product', {}, this.productSeoContext);
    this.visible = true;
  }

  hideDialog() {
    this.visible = false;
    this.resetForm();
  }

  getCategoryDetails() {
    this._cateoryService.getCategoryById(this.categoryId).pipe(
      takeUntilDestroyed(this.destroyRef)
    ).subscribe({
      next: (res: any) => {
        this.categoryDetails = res.data;
        this.cdr.detectChanges();
      },
      error: (err) => {
        this.errorVisible = true;
        this.errorMessage = err.error.message;
        this.cdr.detectChanges();
      }
    });
  }

  addNewProduct() {
    this.isAddingProduct = true;
    if (!this.addProductForm.value.categoryId) this.addProductForm.value.categoryId = this.categoryId;
    const payload: any = { ...this.addProductForm.value };
    if (!payload.imageBase64) {
      delete payload.imageBase64;
    }
    payload.specifications = this.normalizeProductDetails(payload.specifications);
    if (!payload.specifications.length) {
      delete payload.specifications;
    }
    // Offline the SEO fields are hidden and not sent.
    if (this.websiteEnabled) {
      Object.assign(payload, normalizeSeoExtensionPayload(this.productSeoForm));
    }
    console.log('Adding product with payload:', this.addProductForm.value);
    console.log('Adding product with payload:', payload);

    this._cateoryService.addNewProduct(payload).pipe(
      takeUntilDestroyed(this.destroyRef)
    ).subscribe({
      next: (res: any) => {
        this.hideDialog();
        this.getProducts();
        this.resetForm();
        this.isAddingProduct = false;
      },
      error: (err: any) => {
        this.isAddingProduct = false;
        this.seoFormComponent?.applyDuplicateSlugError(err);
        this.errorVisible = true;
        this.errorMessage = err.error.message;
        this.cdr.detectChanges();
      }
    });
  }

  resetForm() {
    this.addProductForm.reset({
      name: '',
      code: '',
      inventoryCount: '',
      imageBase64: null,
      categoryId: this.categoryId,
      wholesalePrice: '',
      purchasePrice: '',
      retailPrice: '',
      soldItemCount: '',
      specifications: [],
    });
    this.resetProductDetailsControls();
    this.imagePreview = null;
    this.refreshProductSeoContext();
    this.productSeoForm = buildSeoFormValue(this.fb, 'product', {}, this.productSeoContext);
  }

  navigateToProductDetails(product) {
    this._router.navigate(['/products/edit', product._id]);
  }

  isLowInventory(inventoryCount: unknown): boolean {
    const parsedValue = Number(inventoryCount);
    return Number.isFinite(parsedValue) && parsedValue <= 10;
  }

  isOutOfStock(inventoryCount: unknown): boolean {
    const parsedValue = Number(inventoryCount);
    return Number.isFinite(parsedValue) && parsedValue === 0;
  }

  onBasicUploadAuto(event: any) {
    const file = event.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = () => {
        const base64String = reader.result as string;
        this.imagePreview = base64String;
        this.productSeoContext = { ...this.productSeoContext, image: base64String };
        this.addProductForm.patchValue({ imageBase64: base64String });
        this.addProductForm.get('imageBase64')!.updateValueAndValidity();
        this.cdr.detectChanges();
      };
      reader.readAsDataURL(file);
    }
  }

  private getNextProductCode(): string {
    if (this.products.length === 0) {
      return '01';
    }

    const parsedCodes = this.products
      .map((product) => this.parseProductCode(product?.code))
      .filter((code): code is { prefix: string; numericValue: number; width: number } => code !== null);

    if (parsedCodes.length > 0) {
      const highestCode = parsedCodes.reduce((currentHighest, currentCode) =>
        currentCode.numericValue > currentHighest.numericValue ? currentCode : currentHighest
      );

      const nextNumber = String(highestCode.numericValue + 1).padStart(highestCode.width, '0');
      return `${highestCode.prefix}${nextNumber}`;
    }

    const lastCode = this.products[this.products.length - 1]?.code;
    const fallbackCode = lastCode == null ? '' : String(lastCode).trim();
    return fallbackCode ? `${fallbackCode}-1` : '';
  }

  private parseProductCode(code: unknown): { prefix: string; numericValue: number; width: number } | null {
    if (code == null) {
      return null;
    }

    const normalizedCode = String(code).trim();
    const codeParts = normalizedCode.match(/^(.*?)(\d+)$/);

    if (!codeParts) {
      return null;
    }

    const [, prefix, numericPart] = codeParts;
    return {
      prefix,
      numericValue: Number(numericPart),
      width: numericPart.length,
    };
  }

  private buildProductDetailsFromCategory(category: any): { title: string; value: string }[] {
    return this.extractCategorySpecifications(category).map((specification) => ({
      title: specification.title,
      value: ''
    }));
  }

  private extractCategorySpecifications(category: any): { title: string }[] {
    const specifications = category?.specifications || category?.specification || category?.specs || [];
    if (!Array.isArray(specifications)) return [];

    return specifications
      .map((specification: any) => {
        if (typeof specification === 'string') return { title: specification };
        return { title: specification?.title || specification?.name || specification?.rowName || '' };
      })
      .map((specification: { title: string }) => ({
        title: String(specification.title || '').trim()
      }))
      .filter((specification: { title: string }) => Boolean(specification.title));
  }

  private normalizeProductDetails(details: any[]): { title: string; value: string }[] {
    if (!Array.isArray(details)) return [];

    return details
      .map((detail: any) => ({
        title: String(detail?.title || '').trim(),
        value: String(detail?.value || '').trim()
      }))
      .filter((detail: { title: string }) => Boolean(detail.title));
  }

  private resetProductsPagination(): void {
    this.products = [];
    this.currentPage = 0;
    this.totalPages = 1;
    this.hasNextPage = true;
    this.hasLoadedProducts = false;
    this.isLoadingProducts = false;
  }

  private observeScrollSentinel(): void {
    if (!this.isBrowser || !this.scrollSentinel) {
      return;
    }

    if (!this.scrollObserver) {
      this.scrollObserver = new IntersectionObserver(
        ([entry]) => {
          if (entry.isIntersecting) {
            this.loadNextPage();
          }
        },
        { root: null, rootMargin: '200px 0px', threshold: 0 }
      );
    }

    this.scrollObserver.disconnect();
    this.scrollObserver.observe(this.scrollSentinel.nativeElement);
  }

  private appendUniqueProducts(current: Product[], incoming: Product[]): Product[] {
    const productIds = new Set(current.map((product) => product._id));
    return [
      ...current,
      ...incoming.filter((product) => !productIds.has(product._id))
    ];
  }

  refreshProductSeoContext(): void {
    const raw = this.addProductForm?.getRawValue?.() ?? {};
    this.productSeoContext = {
      entityType: 'product',
      legacyName: String(raw.name || '').trim(),
      categoryName: String(this.categoryDetails?.name || this.categoryDetails?.categoryName || '').trim(),
      code: String(raw.code || '').trim(),
      image: typeof this.imagePreview === 'string' ? this.imagePreview : '',
      price: raw.retailPrice,
      specifications: this.normalizeProductDetails(raw.specifications || [])
    };
  }
}
