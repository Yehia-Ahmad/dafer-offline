import { CommonModule, isPlatformBrowser } from '@angular/common';
import { ChangeDetectorRef, Component, DestroyRef, Inject, inject, OnInit, PLATFORM_ID, signal } from '@angular/core';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { FormArray, FormBuilder, FormGroup, FormsModule, ReactiveFormsModule, Validators } from '@angular/forms';
import { DialogModule } from 'primeng/dialog';
import { TranslatePipe } from '@ngx-translate/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CategoryImportResult, CategoryPayload, CateoryService } from '../../services/cateory.service';
import { ProductsService } from '../../../products/services/products.service';
import { LanguageService } from '../../../shared/services/translation.service';
import { BRAND } from '../../../../core/brand';
import { NotaButtonDirective, NotaDialogShellComponent, NotaFormFieldComponent } from '../../../shared/ui';
import { CatalogStateService } from '../../../layout/nav/catalog-state.service';

/**
 * Category tools of the Products page (Stage 11; moved unchanged from the Stage 8 sidebar item):
 * add / edit / delete category, Excel import / export / template, export products.
 * Renders the page-header tool buttons and the dialogs; the page opens the dialogs through the public methods.
 * The list and the product-exists flag live in CatalogStateService (shared with the POS category chips).
 */
import { NotaCanDirective } from '../../../../core/auth/nota-can.directive';

@Component({
  selector: 'app-category-tools',
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule, FormsModule, MatProgressSpinnerModule, MatSnackBarModule, DialogModule, TranslatePipe,
    NotaButtonDirective, NotaDialogShellComponent, NotaFormFieldComponent, NotaCanDirective],
  templateUrl: './category-tools.component.html',
  host: { class: 'cat-tools' },
})
export class CategoryToolsComponent implements OnInit {
  private _languageService = inject(LanguageService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly _catalog = inject(CatalogStateService);
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
    // Entering the products page reloads the list and the product-exists flag (as the sidebar did per navigation).
    this.getAllCategories();
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
