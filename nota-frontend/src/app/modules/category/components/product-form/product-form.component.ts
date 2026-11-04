import { ChangeDetectorRef, Component, DestroyRef, effect, inject, OnInit, untracked } from '@angular/core';
import { CommonModule, Location } from '@angular/common';
import { FormArray, FormBuilder, FormGroup, FormsModule, ReactiveFormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TranslatePipe } from '@ngx-translate/core';
import { DialogModule } from 'primeng/dialog';
import { DatePickerModule } from 'primeng/datepicker';
import { format as formatDate } from 'date-fns';
import { CateoryService } from '../../services/cateory.service';
import { CatalogStateService } from '../../../layout/nav/catalog-state.service';
import {
  NotaButtonDirective,
  NotaDialogShellComponent,
  NotaFormFieldComponent,
  NotaMoneyPipe,
  NotaNumberPipe,
  NotaPageHeaderComponent,
} from '../../../shared/ui';

export type ProductFormMode = 'new' | 'edit';

/**
 * Product form (docs/design/screens/ProductForm.dc.html), routes /products/new?category=<id> and /products/edit/:id.
 * New: the old category-page "add product" dialog logic (reactive form, POST products, next-code suggestion).
 * Edit: the old /products/edit/:id logic (PUT, delete, sync purchase price). Request bodies unchanged.
 */
@Component({
  selector: 'app-product-form',
  standalone: true,
  imports: [CommonModule, FormsModule, ReactiveFormsModule, TranslatePipe, DialogModule, DatePickerModule,
    NotaButtonDirective, NotaDialogShellComponent, NotaFormFieldComponent, NotaMoneyPipe, NotaNumberPipe, NotaPageHeaderComponent],
  templateUrl: './product-form.component.html',
  styleUrl: './product-form.component.scss',
})
export class ProductFormComponent implements OnInit {
  private readonly destroyRef = inject(DestroyRef);
  /** The sidebar is mounted once; refresh the shared category list / product-exists flag after a create or delete. */
  private readonly _catalog = inject(CatalogStateService);
  private readonly _cateoryService = inject(CateoryService);
  private readonly _activatedRoute = inject(ActivatedRoute);
  private readonly _router = inject(Router);
  private readonly location = inject(Location);
  private readonly fb = inject(FormBuilder);
  private readonly cdr = inject(ChangeDetectorRef);

  readonly mode: ProductFormMode = this._activatedRoute.snapshot.params['id'] ? 'edit' : 'new';
  readonly categories = this._catalog.categories;
  errorVisible = false;
  errorMessage = '';
  isDragging = false;

  // ---------- new (from the old category page) ----------
  categoryId = '';
  addProductForm: FormGroup;
  imagePreview: string | ArrayBuffer | null = null;
  isAddingProduct = false;
  /** Codes the next-code suggestion is computed from (the category's loaded products, as in the old dialog). */
  private productCodes: unknown[] = [];
  /**
   * Stage 12, create only, kept outside the reactive form so its value (and today's POST body) stays the same:
   * sent only when filled.
   */
  newDiscountPercentage: number | string | null = '';
  newLowStockThreshold: number | string | null = '';

  // ---------- edit (from the old /products/edit/:id) ----------
  isLoading: boolean = false;
  productId: any;
  product: any = {};
  newInventory: number | string | null = null;
  loading: boolean = false;
  deleteVisible: boolean = false;
  syncVisible: boolean = false;
  syncLoading: boolean = false;
  syncDateFrom: Date | null = null;
  syncDateTo: Date | null = null;
  productDetails: { title: string; value: string }[] = [];
  /** Stage 12: the product's lowStockThreshold in the edit form ('' = none). */
  editLowStockThreshold: number | string | null = '';

  constructor() {
    this.productId = this._activatedRoute.snapshot.params['id'];
    this.initlizeAddProduct(null);
    // Opened directly (category list not loaded yet): fill the specification fields once it arrives.
    effect(() => {
      const categories = this.categories();
      untracked(() => {
        // Stage 12: opened from "كل الأصناف" (no ?category): start on the first category.
        if (this.mode === 'new' && !this.categoryId && categories[0]) {
          this.setNewCategory(categories[0].id, null);
          return;
        }
        if (this.mode !== 'new' || this.newProductDetails.length) return;
        const category = categories.find((item) => item.id === this.categoryId)?.category;
        const details = this.buildProductDetailsFromCategory(category);
        if (details.length) this.resetProductDetailsControls(details);
      });
    });
  }

  ngOnInit(): void {
    if (this.mode === 'edit') {
      setTimeout(() => {
        this.getProductById();
      }, 100);
      return;
    }

    const categoryId = this._activatedRoute.snapshot.queryParamMap.get('category') ?? '';
    const passedCodes = (typeof history !== 'undefined' ? history.state?.productCodes : null) as unknown[] | null;
    this.setNewCategory(categoryId, Array.isArray(passedCodes) ? passedCodes : null);
  }

  /** Back link / cancel target: the product's category on /products. */
  get listCategoryId(): string {
    return this.mode === 'edit' ? (this.product?.category?._id ?? '') : this.categoryId;
  }

  get categoryLabel(): string {
    if (this.mode === 'edit') return this.product?.category?.name ?? '';
    return this.categories().find((category) => category.id === this.categoryId)?.label ?? '';
  }

  /** Frontend-only hint: selling price minus purchase price, and that profit as a % of the selling price. */
  profitHint(sellingPrice: unknown, purchasePrice: unknown): { amount: number; percent: number } | null {
    const selling = Number(sellingPrice);
    const purchase = Number(purchasePrice);
    if (sellingPrice === '' || sellingPrice === null || sellingPrice === undefined) return null;
    if (!Number.isFinite(selling) || !Number.isFinite(purchase) || selling <= 0) return null;
    const amount = Math.round((selling - purchase) * 100) / 100;
    return { amount, percent: Math.round((amount / selling) * 1000) / 10 };
  }

  get prices(): { retail: unknown; wholesale: unknown; purchase: unknown } {
    if (this.mode === 'edit') {
      return { retail: this.product?.retailPrice, wholesale: this.product?.wholesalePrice, purchase: this.product?.purchasePrice };
    }
    const value = this.addProductForm.value;
    return { retail: value.retailPrice, wholesale: value.wholesalePrice, purchase: value.purchasePrice };
  }

  cancel(): void {
    if (this.mode === 'edit') {
      this.location.back();
      return;
    }
    this._router.navigate(['/products'], { queryParams: { category: this.categoryId || null } });
  }

  onCategoryChange(categoryId: string): void {
    this.setNewCategory(categoryId, null);
  }

  /** Category of a new product: its specification fields and the next code. */
  private setNewCategory(categoryId: string, codes: unknown[] | null): void {
    this.categoryId = categoryId;
    this.resetForm();
    this.resetProductDetailsControls(this.buildProductDetailsFromCategory(this.findCategory(categoryId)));
    if (codes) {
      this.productCodes = codes;
      this.addProductForm.patchValue({ code: this.getNextProductCode() });
      return;
    }
    this.productCodes = [];
    this.addProductForm.patchValue({ code: this.getNextProductCode() });
    if (!categoryId) return;
    this._cateoryService.getProductsPage(categoryId, { page: 1, limit: 10 }).pipe(
      takeUntilDestroyed(this.destroyRef)
    ).subscribe({
      next: ({ products }) => {
        if (this.categoryId !== categoryId) return;
        this.productCodes = products.map((product) => product?.code ?? null);
        this.addProductForm.patchValue({ code: this.getNextProductCode() });
        this.cdr.detectChanges();
      },
      error: () => undefined,
    });
  }

  private findCategory(categoryId: string): any {
    return this.categories().find((category) => category.id === categoryId)?.category ?? null;
  }

  // ======================= new product (old category-details code) =======================

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

  get newProductDetails(): FormArray {
    return this.addProductForm.get('specifications') as FormArray;
  }

  private resetProductDetailsControls(details: { title: string; value?: string }[] = []): void {
    this.newProductDetails.clear();
    details.forEach((detail) => {
      this.newProductDetails.push(this.fb.group({
        title: [detail.title],
        value: [detail.value || '']
      }));
    });
  }

  addNewProduct(addAnother = false) {
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
    // Stage 12: optional fields, appended only when filled (both empty → the same body as before).
    if (isFilled(this.newDiscountPercentage)) {
      payload.discountPercentage = Number(this.newDiscountPercentage);
    }
    if (isFilled(this.newLowStockThreshold)) {
      payload.lowStockThreshold = Number(this.newLowStockThreshold);
    }

    this._cateoryService.addNewProduct(payload).pipe(
      takeUntilDestroyed(this.destroyRef)
    ).subscribe({
      next: () => {
        this._catalog.refresh();
        this.isAddingProduct = false;
        if (!addAnother) {
          this._router.navigate(['/products'], { queryParams: { category: this.categoryId } });
          return;
        }
        // "Save and add another" (frontend only): clean form, same category, next code.
        this.productCodes = [payload.code, ...this.productCodes];
        this.resetForm();
        this.resetProductDetailsControls(this.buildProductDetailsFromCategory(this.findCategory(this.categoryId)));
        this.addProductForm.patchValue({ code: this.getNextProductCode(), categoryId: this.categoryId });
        this.cdr.detectChanges();
      },
      error: (err: any) => {
        this.isAddingProduct = false;
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
    this.newDiscountPercentage = '';
    this.newLowStockThreshold = '';
  }

  onNewImageSelected(event: any) {
    const file = event.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = () => {
        const base64String = reader.result as string;
        this.imagePreview = base64String;
        this.addProductForm.patchValue({ imageBase64: base64String });
        this.addProductForm.get('imageBase64')!.updateValueAndValidity();
        this.cdr.detectChanges();
      };
      reader.readAsDataURL(file);
    }
  }

  private getNextProductCode(): string {
    if (this.productCodes.length === 0) {
      return '01';
    }

    const parsedCodes = this.productCodes
      .map((code) => this.parseProductCode(code))
      .filter((code): code is { prefix: string; numericValue: number; width: number } => code !== null);

    if (parsedCodes.length > 0) {
      const highestCode = parsedCodes.reduce((currentHighest, currentCode) =>
        currentCode.numericValue > currentHighest.numericValue ? currentCode : currentHighest
      );

      const nextNumber = String(highestCode.numericValue + 1).padStart(highestCode.width, '0');
      return `${highestCode.prefix}${nextNumber}`;
    }

    const lastCode = this.productCodes[this.productCodes.length - 1];
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

  // ======================= edit product (old product-edit code) =======================

  getProductById() {
    this.loading = true;
    this._cateoryService.getProductById(this.productId).subscribe({
      next: (res: any) => {
        this.loading = false;
        this.product = res;
        this.productDetails = this.buildProductDetails(this.product);
        this.newInventory = null;
        this.editLowStockThreshold = isFilled(this.product?.lowStockThreshold) ? this.product.lowStockThreshold : '';
        this.cdr.detectChanges();
      }, error: (err: any) => {
        this.loading = false;
        this.errorVisible = true;
        this.errorMessage = err.error.message;
        this.cdr.detectChanges();
      }
    })
  }

  deleteProduct() {
    this.loading = true;
    this._cateoryService.deleteProduct(this.productId).subscribe({
      next: () => {
        this.loading = false;
        this._catalog.refresh();
        this.cdr.detectChanges();
        this.location.back();
      }, error: (err: any) => {
        this.loading = false;
        this.errorVisible = true;
        this.errorMessage = err.error.message;
        this.cdr.detectChanges();
      }
    })
  }

  updateProduct() {
    this.loading = true;
    const currentInventoryCount = this.toNumber(this.product.inventoryCount);
    const newInventoryCount = Math.max(0, this.toNumber(this.newInventory));

    let payload = {
      name: this.product.name,
      code: this.product.code,
      inventoryCount: currentInventoryCount,
      newInventory: newInventoryCount,
      wholesalePrice: this.product.wholesalePrice,
      purchasePrice: this.product.purchasePrice,
      retailPrice: this.product.retailPrice,
      discountPercentage: this.normalizePercentage(this.product.discountPercentage),
      soldItemCount: this.product.soldItemCount,
      image: this.product.image,
      editProduct: newInventoryCount === 0,
      specifications: this.normalizeProductDetails(this.productDetails),
      // Stage 12: only when filled, or null to clear a threshold the product had; otherwise not sent.
      ...this.lowStockThresholdUpdate(),
    };
    this._cateoryService.updateProduct(this.productId, payload).subscribe({
      next: () => {
        this.loading = false;
        this.cdr.detectChanges();
        this.location.back();
      }, error: (err: any) => {
        this.loading = false;
        this.errorVisible = true;
        this.errorMessage = err.error.message;
        this.cdr.detectChanges();
      }
    })
  }

  private lowStockThresholdUpdate(): { lowStockThreshold?: number | null } {
    if (isFilled(this.editLowStockThreshold)) return { lowStockThreshold: Number(this.editLowStockThreshold) };
    return isFilled(this.product?.lowStockThreshold) ? { lowStockThreshold: null } : {};
  }

  showDeleteDialog() {
    this.deleteVisible = true;
  }

  closeDialog() {
    this.deleteVisible = false;
  }

  showSyncDialog() {
    this.syncVisible = true;
  }

  closeSyncDialog() {
    if (this.syncLoading) return;
    this.syncVisible = false;
    this.syncDateFrom = null;
    this.syncDateTo = null;
  }

  syncPurchasePriceToInvoices() {
    this.syncLoading = true;

    const payload = {
      ...(this.syncDateFrom ? { dateFrom: formatDate(this.syncDateFrom, 'yyyy-MM-dd') } : {}),
      ...(this.syncDateTo ? { dateTo: formatDate(this.syncDateTo, 'yyyy-MM-dd') } : {})
    };

    this._cateoryService.syncProductPurchasePrice(this.productId, payload).subscribe({
      next: () => {
        this.syncLoading = false;
        this.closeSyncDialog();
        this.cdr.detectChanges();
      },
      error: (err: any) => {
        this.syncLoading = false;
        this.errorVisible = true;
        this.errorMessage = err.error.message;
        this.cdr.detectChanges();
      }
    });
  }

  onEditImageSelected(event: any) {
    const file = event.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = () => {
        const base64String = reader.result as string;
        this.imagePreview = base64String;
        this.product.image = base64String;
        this.cdr.detectChanges();
      };
      reader.readAsDataURL(file);
    }
  }

  isOutOfStock(inventoryCount: unknown): boolean {
    const parsedValue = Number(inventoryCount);
    return Number.isFinite(parsedValue) && parsedValue === 0;
  }

  // ======================= shared =======================

  /** Image drop zone (frontend only): the dropped file goes through the same handler as the file picker. */
  onImageDrop(event: DragEvent): void {
    event.preventDefault();
    this.isDragging = false;
    const file = event.dataTransfer?.files?.[0];
    if (!file || !file.type.startsWith('image/')) return;
    const fakeEvent = { target: { files: [file] } };
    if (this.mode === 'edit') this.onEditImageSelected(fakeEvent);
    else this.onNewImageSelected(fakeEvent);
  }

  onImageDragOver(event: DragEvent): void {
    event.preventDefault();
    this.isDragging = true;
  }

  get imageSrc(): string | null {
    if (this.mode === 'edit') return this.product?.image || null;
    return (this.imagePreview as string) || null;
  }

  private toNumber(value: unknown): number {
    const parsedValue = Number(value);
    return Number.isFinite(parsedValue) ? parsedValue : 0;
  }

  private normalizePercentage(value: unknown): number {
    return Math.min(100, Math.max(0, this.toNumber(value)));
  }

  private buildProductDetails(product: any): { title: string; value: string }[] {
    const existingDetails = this.normalizeProductDetails(product?.specifications || product?.details || []);
    const existingValueByTitle = new Map(
      existingDetails.map((detail) => [detail.title, detail.value])
    );

    const categorySpecifications = this.extractCategorySpecifications(product?.category);
    if (!categorySpecifications.length) {
      return existingDetails;
    }

    return categorySpecifications.map((specification) => ({
      title: specification.title,
      value: existingValueByTitle.get(specification.title) || ''
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
}

/** A form value the user actually entered (0 counts; '', null and undefined do not). */
function isFilled(value: unknown): boolean {
  return value !== '' && value !== null && value !== undefined && Number.isFinite(Number(value));
}
