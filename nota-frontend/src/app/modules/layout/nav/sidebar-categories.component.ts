import { CommonModule, isPlatformBrowser } from '@angular/common';
import { ChangeDetectorRef, Component, DestroyRef, Inject, inject, input, OnInit, PLATFORM_ID, signal } from '@angular/core';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { NavigationEnd, Router, RouterModule } from '@angular/router';
import { FormArray, FormBuilder, FormGroup, FormsModule, ReactiveFormsModule, Validators } from '@angular/forms';
import { DialogModule } from 'primeng/dialog';
import { TranslatePipe } from '@ngx-translate/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { filter } from 'rxjs';
import { CategoryImportResult, CategoryPayload, CateoryService } from '../../category/services/cateory.service';
import { ProductsService } from '../../products/services/products.service';
import { LanguageService } from '../../shared/services/translation.service';
import { BRAND } from '../../../core/brand';
import { NotaButtonDirective, NotaDialogShellComponent, NotaFormFieldComponent } from '../../shared/ui';
import { NavIconComponent } from './nav-icon.component';
import { NAV_ICONS } from './nav-menu.config';
import { SidebarStateService } from './sidebar-state.service';
import { CatalogStateService, SidebarCategory } from './catalog-state.service';

export type { SidebarCategory } from './catalog-state.service';

/**
 * "الأصناف والفئات" in the sidebar: the category list (→ /categories/:id) and every category tool that used to live
 * in the old custom-sidenav (add / edit / delete, Excel import / export / template, export products).
 * Temporary: moves into the Products page in Stage 10. Logic and API calls are the old component's, unchanged.
 * Stage 9: mounted once (app.html); the list and the product-exists flag live in CatalogStateService.
 */
@Component({
  selector: 'app-sidebar-categories',
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule, FormsModule, MatProgressSpinnerModule, MatSnackBarModule, RouterModule, DialogModule, TranslatePipe,
    NotaButtonDirective, NotaDialogShellComponent, NotaFormFieldComponent, NavIconComponent],
  templateUrl: './sidebar-categories.component.html',
  host: { class: 'nota-nav__item nota-nav__item--expandable' },
})
export class SidebarCategoriesComponent implements OnInit {
  private _languageService = inject(LanguageService);
  private readonly destroyRef = inject(DestroyRef);
  protected readonly _sidebarState = inject(SidebarStateService);
  private readonly _router = inject(Router);
  /** i18n key of the item label. */
  readonly labelKey = input('nav.items.products');
  protected readonly icons = NAV_ICONS;
  private readonly _catalog = inject(CatalogStateService);
  /** The list as rendered (shared with the POS category chips). */
  readonly categoryItems = this._catalog.categories;
  readonly categoryKey = 'categories';
  expandedCategory: string | null = null;
  get categories(): SidebarCategory[] {
    return this._catalog.categories();
  }
  visible: boolean = false;
  isSaving = signal(false);
  editingCategory: any = null;
  deleteCategoryVisible: boolean = false;
  categoryToDelete: any = null;
  addCategory!: FormGroup;
  private isBrowser: boolean;
  imagePreview: string | ArrayBuffer | null = null;
  errorMessage = signal('');
  errorVisible = signal(false);
  isExportingProducts = signal(false);
  readonly hasProducts = this._catalog.hasProducts;
  isExportingCategories = signal(false);
  isImportingCategories = signal(false);
  isGeneratingCategoryTemplate = signal(false);
  categoryImportResult = signal<CategoryImportResult | null>(null);
  importResultVisible = signal(false);

  constructor(
    private _cateoryService: CateoryService,
    private _productsService: ProductsService,
    private fb: FormBuilder,
    private cdr: ChangeDetectorRef,
    private snackBar: MatSnackBar,
    @Inject(PLATFORM_ID) platformId: Object
  ) {
    this.initalizeAddCategory();
    this.isBrowser = isPlatformBrowser(platformId);
  }

  ngOnInit(): void {
    // (a) app start: the sidebar is created once, with the app frame.
    this.getAllCategories();
    // On a category or product page, show the list open.
    if (this.isProductsRoute) this.expandedCategory = this.categoryKey;

    // (c) entering a category or product page reloads the list and the product-exists flag and opens the list.
    this._router.events.pipe(
      filter((event) => event instanceof NavigationEnd),
      takeUntilDestroyed(this.destroyRef)
    ).subscribe(() => {
      if (!this.isProductsRoute) return;
      this.expandedCategory = this.categoryKey;
      this.getAllCategories();
      this.cdr.markForCheck();
    });
  }

  /** Category and product pages belong to this item. */
  get isProductsRoute(): boolean {
    const url = this._router.url;
    return url.startsWith('/categories/') || url.startsWith('/products/edit/');
  }

  get isExpanded(): boolean {
    return this.expandedCategory === this.categoryKey && !this._sidebarState.collapsed();
  }

  initalizeAddCategory() {
    this.addCategory = this.fb.group({
      name: [null, Validators.required],
      imageBase64: [null],
      specifications: this.fb.array([])
    })
  }

  get specifications(): FormArray {
    return this.addCategory.get('specifications') as FormArray;
  }

  addSpecification(): void {
    this.specifications.push(this.fb.control('', Validators.required));
  }

  removeSpecification(index: number): void {
    this.specifications.removeAt(index);
  }

  private resetSpecificationControls(specifications: string[] = []): void {
    this.specifications.clear();
    specifications.forEach((specification) => {
      this.specifications.push(this.fb.control(specification, Validators.required));
    });
  }

  /** GET categories + product-exists check, through CatalogStateService (same requests as before). */
  getAllCategories() {
    this._catalog.refresh((err) => this.showOperationError(
      err,
      'Failed to load categories.',
      'تعذر تحميل الفئات.'
    ));
  }

  exportCategories(): void {
    if (!this.isBrowser || this.isExportingCategories()) return;

    this.isExportingCategories.set(true);
    this._cateoryService.exportCategories().pipe(
      takeUntilDestroyed(this.destroyRef)
    ).subscribe({
      next: (blob) => {
        this.isExportingCategories.set(false);
        this.downloadBlob(blob, 'categories-export.xlsx');
        this.showSuccess('Categories exported successfully.', 'تم تصدير الفئات بنجاح.');
      },
      error: (err) => {
        this.isExportingCategories.set(false);
        this.showOperationError(err, 'Failed to export categories.', 'تعذر تصدير الفئات.');
      }
    });
  }

  onCategoryImportSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';

    if (!file || this.isImportingCategories()) return;
    if (!/\.(xlsx|xls)$/i.test(file.name)) {
      this.showOperationError(
        null,
        'Select a valid .xlsx or .xls file.',
        'اختر ملفًا صالحًا بصيغة .xlsx أو .xls.'
      );
      return;
    }

    this.isImportingCategories.set(true);
    this.categoryImportResult.set(null);
    this._cateoryService.importCategories(file).pipe(
      takeUntilDestroyed(this.destroyRef)
    ).subscribe({
      next: (result) => {
        this.isImportingCategories.set(false);
        this.categoryImportResult.set(result);
        this.importResultVisible.set(true);
        if (result.success) {
          this.getAllCategories();
          this.showSuccess('Categories import completed.', 'اكتمل استيراد الفئات.');
        } else {
          this.showOperationError(
            null,
            'The category import did not complete successfully.',
            'لم يكتمل استيراد الفئات بنجاح.'
          );
        }
      },
      error: (err) => {
        this.isImportingCategories.set(false);
        this.showOperationError(err, 'Failed to import categories.', 'تعذر استيراد الفئات.');
      }
    });
  }

  async downloadCategoriesTemplate(): Promise<void> {
    if (!this.isBrowser || this.isGeneratingCategoryTemplate()) return;

    this.isGeneratingCategoryTemplate.set(true);
    try {
      const { Workbook } = await import('exceljs');
      const workbook = new Workbook();
      workbook.creator = BRAND.nameEn;
      workbook.created = new Date();

      const worksheet = workbook.addWorksheet('Categories');
      worksheet.columns = [
        { header: 'Name', key: 'name', width: 28 },
        { header: 'ImageBase64', key: 'imageBase64', width: 35 },
        { header: 'Specifications', key: 'specifications', width: 70 }
      ];
      worksheet.addRow({
        name: 'Example Category',
        imageBase64: '',
        specifications: JSON.stringify([
          { name: 'Color', value: 'Black' },
          { name: 'Size', value: 'Medium' }
        ])
      });
      worksheet.views = [{ state: 'frozen', ySplit: 1 }];
      worksheet.autoFilter = 'A1:C1';
      worksheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
      worksheet.getRow(1).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFFF9933' }
      };
      worksheet.getColumn('specifications').alignment = { wrapText: true, vertical: 'top' };

      const buffer = await workbook.xlsx.writeBuffer();
      const template = new Blob([buffer as ArrayBuffer], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      });
      this.downloadBlob(template, 'categories-import-template.xlsx');
      this.showSuccess('Category template downloaded.', 'تم تنزيل قالب الفئات.');
    } catch (err) {
      this.showOperationError(err, 'Failed to generate the template.', 'تعذر إنشاء القالب.');
    } finally {
      this.isGeneratingCategoryTemplate.set(false);
    }
  }

  onImportResultVisibleChange(visible: boolean): void {
    this.importResultVisible.set(visible);
  }

  formatImportError(error: unknown): string {
    if (typeof error === 'string') return error;
    if (error && typeof error === 'object') {
      const candidate = error as Record<string, unknown>;
      if (typeof candidate['message'] === 'string') return candidate['message'];
      try {
        return JSON.stringify(error);
      } catch {
        return String(error);
      }
    }
    return String(error ?? 'Unknown import error');
  }

  exportProductsExcel() {
    if (!this.isBrowser || this.isExportingProducts()) return;

    this.isExportingProducts.set(true);
    this._productsService.exportProductsExcel().subscribe({
      next: (blob) => {
        this.isExportingProducts.set(false);
        this.downloadBlob(blob, `products-${new Date().toISOString().slice(0, 10)}.xlsx`);
      },
      error: (err) => {
        this.isExportingProducts.set(false);
        const fallback = this._languageService.selectedLanguage() === 'ar'
          ? 'حدث خطأ أثناء تصدير المنتجات'
          : 'Failed to export products.';
        this.errorMessage.set(this.extractErrorMessage(err, fallback));
        this.errorVisible.set(true);
        console.error(err);
      }
    });
  }

  private downloadBlob(blob: Blob, filename: string): void {
    if (!this.isBrowser) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  private showSuccess(english: string, arabic: string): void {
    this.snackBar.open(this.localizedMessage(english, arabic), undefined, {
      duration: 3500,
      horizontalPosition: 'end',
      verticalPosition: 'top',
      panelClass: ['operation-snackbar', 'operation-snackbar--success']
    });
  }

  private showOperationError(
    error: unknown,
    englishFallback: string,
    arabicFallback: string
  ): void {
    const fallback = this.localizedMessage(englishFallback, arabicFallback);
    const message = this.extractErrorMessage(error, fallback);
    this.snackBar.open(message, undefined, {
      duration: 6000,
      horizontalPosition: 'end',
      verticalPosition: 'top',
      panelClass: ['operation-snackbar', 'operation-snackbar--error']
    });
  }

  private localizedMessage(english: string, arabic: string): string {
    return this._languageService.selectedLanguage() === 'ar' ? arabic : english;
  }

  toggleCategory(category: string) {
    if (this._sidebarState.collapsed()) {
      this._sidebarState.setCollapsed(false);
      // Wait a bit to allow sidenav to expand smoothly before showing children
      setTimeout(() => {
        this.expandedCategory = category;
        this.cdr.markForCheck();
      }, 300); // adjust delay to match your sidenav animation time
    } else {
      this.expandedCategory = this.expandedCategory === category ? null : category;
    }
  }

  openDialog(): void {
    this.editingCategory = null;
    this.addCategory.reset();
    this.resetSpecificationControls();
    this.imagePreview = null;
    this.visible = true;
    this.errorMessage.set('');
    this.errorVisible.set(false);
    this.cdr.detectChanges();
  }

  openEditCategoryDialog(category: any, event?: Event): void {
    event?.preventDefault();
    event?.stopPropagation();

    this.editingCategory = category;
    this.addCategory.reset();
    this.resetSpecificationControls(this.extractSpecifications(category.category));
    this.addCategory.patchValue({
      name: category.label || category.category?.name || '',
      imageBase64: null
    });
    this.imagePreview = category.category?.image || null;
    this.visible = true;
    this.errorMessage.set('');
    this.errorVisible.set(false);

    this._cateoryService.getCategoryById(category.id).subscribe({
      next: (response: any) => {
        const categoryDetails = response?.data || response?.category || response;
        this.editingCategory = { ...category, category: categoryDetails };
        this.addCategory.patchValue({
          name: categoryDetails?.name || category.label || ''
        });
        this.resetSpecificationControls(this.extractSpecifications(categoryDetails));
        this.imagePreview = categoryDetails?.image || this.imagePreview;
        this.cdr.detectChanges();
      },
      error: () => this.cdr.detectChanges()
    });
    this.cdr.detectChanges();
  }

  closeDialog(): void {
    this.visible = false;
    this.editingCategory = null;
    this.addCategory.reset();
    this.resetSpecificationControls();
    this.imagePreview = null;
    this.errorMessage.set('');
    this.errorVisible.set(false);
    this.cdr.detectChanges();
  }

  onErrorDialogVisibleChange(visible: boolean): void {
    this.errorVisible.set(visible);
  }

  closeErrorDialog(): void {
    this.errorVisible.set(false);
  }

  addNewCategory() {
    if (this.addCategory.invalid || this.isSaving()) return;

    this.isSaving.set(true);
    this.errorMessage.set('');
    const payload = this.buildCategoryPayload();

    if (this.editingCategory?.id) {
      this._cateoryService.updateCategory(this.editingCategory.id, payload).subscribe({
        next: () => {
          this.isSaving.set(false);
          this.getAllCategories();
          this.closeDialog();
        },
        error: (err: any) => {
          this.isSaving.set(false);
          this.errorMessage.set(this.extractErrorMessage(err, 'حدث خطأ أثناء تعديل الفئة'));
          this.errorVisible.set(true);
          console.error(err);
        }
      });
      return;
    }

    this._cateoryService.createCategory(payload).subscribe({
      next: () => {
        this.isSaving.set(false);
        this.getAllCategories();
        this.closeDialog();
      },
      error: (err: any) => {
        this.isSaving.set(false);
        this.errorMessage.set(this.extractErrorMessage(err));
        this.errorVisible.set(true);
        console.error(err);
      }
    });
  }

  private buildCategoryPayload(): CategoryPayload {
    const payload: Record<string, unknown> = { ...this.addCategory.value };
    if (!payload['imageBase64']) {
      delete payload['imageBase64'];
    }
    payload['specifications'] = ((payload['specifications'] as string[] | undefined) || [])
      .map((specification: string) => String(specification || '').trim())
      .filter(Boolean)
      .map((title: string) => ({ title }));
    if (!(payload['specifications'] as unknown[]).length) {
      delete payload['specifications'];
    }
    return payload as CategoryPayload;
  }

  private extractSpecifications(category: any): string[] {
    const specifications = category?.specifications || category?.specification || category?.specs || [];
    if (!Array.isArray(specifications)) return [];

    return specifications
      .map((specification: any) => {
        if (typeof specification === 'string') return specification;
        return specification?.name || specification?.rowName || specification?.title || '';
      })
      .map((specification: string) => String(specification || '').trim())
      .filter(Boolean);
  }

  onBasicUploadAuto(event: any) {
    const file = event.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = () => {
        const base64String = reader.result as string;
        this.imagePreview = base64String;
        this.addCategory.patchValue({ imageBase64: base64String });
        this.addCategory.get('imageBase64')!.updateValueAndValidity();
        this.cdr.detectChanges();
      };
      reader.readAsDataURL(file);
    }
  }

  private extractErrorMessage(err: any, fallbackMessage: string = 'حدث خطأ أثناء إضافة الفئة'): string {
    if (typeof err?.error === 'string') return err.error;
    if (typeof err?.error?.message === 'string') return err.error.message;
    if (typeof err?.message === 'string') return err.message;
    return fallbackMessage;
  }

  promptForCategoryDeletion(category: any) {
    this.categoryToDelete = category;
    this.deleteCategoryVisible = true;
  }

  closeDeleteCategoryDialog() {
    this.deleteCategoryVisible = false;
    this.categoryToDelete = null;
  }

  confirmDeleteCategory() {
    if (!this.categoryToDelete) return;

    this._cateoryService.deleteCategory(this.categoryToDelete.id).subscribe({
      next: () => {
        this.getAllCategories();
        this.closeDeleteCategoryDialog();
      },
      error: (err) => {
        console.error(err);
        this.closeDeleteCategoryDialog();
      }
    });
  }
}
