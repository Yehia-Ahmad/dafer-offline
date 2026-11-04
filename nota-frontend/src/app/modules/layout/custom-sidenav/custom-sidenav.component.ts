import { CommonModule, isPlatformBrowser } from '@angular/common';
import { ChangeDetectorRef, Component, DestroyRef, effect, EventEmitter, Inject, inject, Injector, OnInit, Output, PLATFORM_ID, runInInjectionContext, signal } from '@angular/core';
import { MatListModule } from '@angular/material/list';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { NavigationEnd, Router, RouterModule } from '@angular/router';
import { CategoryImportResult, CategoryPayload, CateoryService } from '../../category/services/cateory.service';
import { DialogModule } from 'primeng/dialog';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { FormArray, FormBuilder, FormGroup, FormsModule, ReactiveFormsModule, Validators } from '@angular/forms';
import { WarnComponent } from "../../assets/warn/warn.component";
import { ErrorIconComponent } from "../../assets/error/error-icon.component";
import { LanguageService } from '../../shared/services/translation.service';
import { TranslatePipe } from '@ngx-translate/core';
import { ThemeService } from '../../shared/services/theme.service';
import { HOME_DEFAULT_VIEW, HOME_VIEW_STORAGE_KEY } from '../constants/home-view.constants';
import { filter } from 'rxjs';
import { BRAND } from '../../../core/brand';
import { ProductsService } from '../../products/services/products.service';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { isOfflineMainPc } from '../../../core/runtime/app-features';

export type MenuItem = {
  label: string;
  icon: SafeHtml;
  route?: string;
  children?: { label: string; route: string; id: string; category?: any }[];
}

@Component({
  selector: 'app-custom-sidenav',
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule, FormsModule, MatListModule, MatButtonModule, MatProgressSpinnerModule, MatSnackBarModule, RouterModule, DialogModule, ButtonModule, InputTextModule, WarnComponent, ErrorIconComponent, TranslatePipe],
  templateUrl: './custom-sidenav.component.html',
  styleUrl: './custom-sidenav.component.scss'
})
export class CustomSidenavComponent implements OnInit {
  private _injector = inject(Injector);
  private _languageService = inject(LanguageService);
  private readonly destroyRef = inject(DestroyRef);
  isSidenavCollapsed = true;
  @Output() collapsedSidenav = new EventEmitter<boolean>();
  menuItems = signal<MenuItem[]>([]);
  expandedCategory: string | null = null;
  categories: any[] = [];
  visible: boolean = false;
  isSaving = signal(false);
  editingCategory: any = null;
  deleteCategoryVisible: boolean = false;
  categoryToDelete: any = null;
  addCategory: FormGroup;
  isDarkMode$;
  private isBrowser: boolean;
  direction = signal<'rtl' | 'ltr'>('ltr');
  // role: any = JSON.parse(localStorage.getItem("userProfile")).role;
  imagePreview: string | ArrayBuffer | null = null;
  errorMessage = signal('');
  errorVisible = signal(false);
  isExportingProducts = signal(false);
  hasProducts = signal(false);
  private hasProductsChecked = false;
  isExportingCategories = signal(false);
  isImportingCategories = signal(false);
  isGeneratingCategoryTemplate = signal(false);
  categoryImportResult = signal<CategoryImportResult | null>(null);
  importResultVisible = signal(false);

  constructor(
    private _themeService: ThemeService,
    private sanitizer: DomSanitizer,
    private _cateoryService: CateoryService,
    private _productsService: ProductsService,
    private fb: FormBuilder,
    private cdr: ChangeDetectorRef,
    private _router: Router,
    private snackBar: MatSnackBar,
    @Inject(PLATFORM_ID) platformId: Object
  ) {
    this.initalizeAddCategory();
    this.isDarkMode$ = this._themeService.isDarkMode$;
    this.isBrowser = isPlatformBrowser(platformId);
  }

  ngOnInit(): void {
    this.getAllCategories();
    this._router.events
      .pipe(filter((event) => event instanceof NavigationEnd))
      .subscribe(() => this.buildAdminMenuItems());
    runInInjectionContext(this._injector, () => {
      effect(() => {
        const lang = this._languageService.selectedLanguage();
        this.direction.set(lang === 'ar' ? 'rtl' : 'ltr');
        this.buildAdminMenuItems();
      });
    });
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

  private sanitize(svg: string): SafeHtml {
    return this.sanitizer.bypassSecurityTrustHtml(svg);
  }

  getAllCategories() {
    this.categories = [];
    this._cateoryService.getCategories().pipe(
      takeUntilDestroyed(this.destroyRef)
    ).subscribe({
      next: (res: any) => {
        const categories = Array.isArray(res) ? res : (res?.data ?? res?.categories ?? []);
        this.categories = categories.map((category: any) => ({
          label: category.name,
          route: `/categories/${category._id}`,
          id: category._id,
          category
        }));
        this.buildAdminMenuItems();
        this.checkHasAnyProducts();
      },
      error: (err) => this.showOperationError(
        err,
        'Failed to load categories.',
        'تعذر تحميل الفئات.'
      )
    });
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

  buildAdminMenuItems() {
    if (this.isProductsContext()) {
      this.menuItems.set(this.getProductsMenuItems());
      return;
    }

    this.menuItems.set(([
      {
        label: 'sidebarTitles.customers',
        icon: this.sanitize(`
        <span class="block w-8 h-8">
            <svg width="100%" height="100%" viewBox="0 0 640 640" xmlns="http://www.w3.org/2000/svg">
              <path d="M320 312C400.1 312 464 248.1 464 168C464 87.9 400.1 24 320 24C239.9 24 176 87.9 176 168C176 248.1 239.9 312 320 312zM229.3 360C123.6 360 38 445.6 38 551.3C38 584.8 65.2 612 98.7 612L541.3 612C574.8 612 602 584.8 602 551.3C602 445.6 516.4 360 410.7 360L229.3 360z" style="fill:#2f2f2f;fill-rule:nonzero;" />
            </svg>
        </span>
        `),
        route: '/customers'
      },
      this.shopProfileMenuItem(),
      ...(isOfflineMainPc() ? [this.backupMenuItem()] : []),
      {
        label: 'sidebarTitles.categories',
        icon: this.sanitize(`
        <span class="block w-8 h-8">
            <svg width="100%" height="100%" viewBox="0 0 31 28" version="1.1" xmlns="http://www.w3.org/2000/svg"
                xmlns:xlink="http://www.w3.org/1999/xlink" xml:space="preserve" xmlns:serif="http://www.serif.com/"
                style="fill-rule:evenodd;clip-rule:evenodd;stroke-linejoin:round;stroke-miterlimit:2;">
                <path
                    d="M14.349,0.699c0.793,-0.367 1.709,-0.367 2.502,-0l11.637,5.376c0.452,0.208 0.74,0.661 0.74,1.161c-0,0.5 -0.288,0.953 -0.74,1.16l-11.637,5.377c-0.793,0.367 -1.709,0.367 -2.502,-0l-11.637,-5.377c-0.452,-0.213 -0.739,-0.665 -0.739,-1.16c-0,-0.495 0.287,-0.953 0.739,-1.161l11.637,-5.376Zm11.307,10.881l2.832,1.309c0.452,0.208 0.74,0.66 0.74,1.161c-0,0.5 -0.288,0.953 -0.74,1.16l-11.637,5.377c-0.793,0.367 -1.709,0.367 -2.502,-0l-11.637,-5.377c-0.452,-0.213 -0.739,-0.665 -0.739,-1.16c-0,-0.495 0.287,-0.953 0.739,-1.161l2.832,-1.309l8.092,3.737c1.245,0.575 2.683,0.575 3.928,-0l8.092,-3.737Zm-8.092,10.55l8.092,-3.737l2.832,1.31c0.452,0.208 0.74,0.66 0.74,1.16c-0,0.501 -0.288,0.953 -0.74,1.161l-11.637,5.376c-0.793,0.368 -1.709,0.368 -2.502,0l-11.637,-5.376c-0.452,-0.213 -0.739,-0.665 -0.739,-1.161c-0,-0.495 0.287,-0.952 0.739,-1.16l2.832,-1.31l8.092,3.737c1.245,0.575 2.683,0.575 3.928,0Z"
                    style="fill:#2f2f2f;fill-rule:nonzero;" />
            </svg>
        </span>
        `),
        children: this.categories,
      }
    ] as MenuItem[]));
  }

  // The shop's own details, printed on invoices.
  private shopProfileMenuItem(): MenuItem {
    return {
      label: 'sidebarTitles.shop_profile',
      icon: this.sanitize(`
        <span class="block w-8 h-8">
          <svg width="100%" height="100%" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            <path d="M4 4h16l1.5 5a3 3 0 0 1-2.5 3.4V20H5v-7.6A3 3 0 0 1 2.5 9L4 4zm2 8.6V18h4v-4h4v4h4v-5.4a3 3 0 0 1-3-1.1 3 3 0 0 1-3 1.2 3 3 0 0 1-3-1.2 3 3 0 0 1-3 1.1zM5.5 6l-1 3.4a1 1 0 0 0 1 1.1 1 1 0 0 0 1-.9L7 6H5.5zm3.6 0-.5 4a1 1 0 0 0 2 .1V6H9.1zm3.4 0v4.1a1 1 0 0 0 2-.1l-.5-4h-1.5zm3.5 0 .5 3.6a1 1 0 0 0 1 .9 1 1 0 0 0 1-1.1l-1-3.4H16z" style="fill:#2f2f2f;fill-rule:nonzero;" />
          </svg>
        </span>
      `),
      route: '/shop-profile',
    };
  }

  // Offline edition, main PC only: backup and restore.
  private backupMenuItem(): MenuItem {
    return {
      label: 'sidebarTitles.backup',
      icon: this.sanitize(`
        <span class="block w-8 h-8">
          <svg width="100%" height="100%" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            <path d="M12 3C7.6 3 4 4.3 4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6c0-1.7-3.6-3-8-3zm0 2c3.9 0 6 1.1 6 1s-2.1 1-6 1-6-1.1-6-1 2.1-1 6-1zM6 8.3C7.5 8.8 9.6 9 12 9s4.5-.2 6-.7V12c0 .3-2.1 1-6 1s-6-.7-6-1V8.3zM6 14.3c1.5.5 3.6.7 6 .7s4.5-.2 6-.7V18c0 .3-2.1 1-6 1s-6-.7-6-1v-3.7z" style="fill:#2f2f2f;fill-rule:nonzero;" />
          </svg>
        </span>
      `),
      route: '/backup',
    };
  }

  isProductsContext(): boolean {
    const isProductsRoute = this._router.url.includes('/selling')
      || this._router.url.includes('/credit-sales')
      || this._router.url.includes('/invoice-history')
      || this._router.url.includes('/returns')
      || this._router.url.includes('/products/profit-report');
    if (!this.isBrowser) return isProductsRoute;

    const currentView = localStorage.getItem(HOME_VIEW_STORAGE_KEY);
    const isProductsView = currentView === 'products' || currentView === 'selling' || currentView === 'invoice-history' || currentView === 'returns' || currentView === 'profit-report';
    return isProductsView || isProductsRoute;
  }

  private getProductsMenuItems(): MenuItem[] {
    return [
      {
        label: 'sidebarTitles.selling',
        icon: this.sanitize(`
        <span class="block w-8 h-8">
            <svg width="100%" height="100%" viewBox="0 0 640 640" xmlns="http://www.w3.org/2000/svg">
              <path d="M142 66.2C150.5 62.3 160.5 63.7 167.6 69.8L208 104.4L248.4 69.8C257.4 62.1 270.7 62.1 279.6 69.8L320 104.4L360.4 69.8C369.4 62.1 382.6 62.1 391.6 69.8L432 104.4L472.4 69.8C479.5 63.7 489.5 62.3 498 66.2C506.5 70.1 512 78.6 512 88L512 552C512 561.4 506.5 569.9 498 573.8C489.5 577.7 479.5 576.3 472.4 570.2L432 535.6L391.6 570.2C382.6 577.9 369.4 577.9 360.4 570.2L320 535.6L279.6 570.2C270.6 577.9 257.3 577.9 248.4 570.2L208 535.6L167.6 570.2C160.5 576.3 150.5 577.7 142 573.8C133.5 569.9 128 561.4 128 552L128 88C128 78.6 133.5 70.1 142 66.2zM232 200C218.7 200 208 210.7 208 224C208 237.3 218.7 248 232 248L408 248C421.3 248 432 237.3 432 224C432 210.7 421.3 200 408 200L232 200zM208 416C208 429.3 218.7 440 232 440L408 440C421.3 440 432 429.3 432 416C432 402.7 421.3 392 408 392L232 392C218.7 392 208 402.7 208 416zM232 296C218.7 296 208 306.7 208 320C208 333.3 218.7 344 232 344L408 344C421.3 344 432 333.3 432 320C432 306.7 421.3 296 408 296L232 296z" style="fill:#2f2f2f;fill-rule:nonzero;" />
            </svg>
        </span>
        `),
        route: '/selling'
      },
      {
        label: 'sidebarTitles.credit_sales',
        icon: this.sanitize(`
        <span class="block w-8 h-8">
            <svg width="100%" height="100%" viewBox="0 0 640 640" xmlns="http://www.w3.org/2000/svg">
              <path d="M160 96C124.7 96 96 124.7 96 160L96 480C96 515.3 124.7 544 160 544L480 544C515.3 544 544 515.3 544 480L544 160C544 124.7 515.3 96 480 96L160 96zM320 184C355.3 184 384 212.7 384 248L384 264L432 264C445.3 264 456 274.7 456 288C456 301.3 445.3 312 432 312L384 312L384 336L432 336C445.3 336 456 346.7 456 360C456 373.3 445.3 384 432 384L384 384L384 408C384 443.3 355.3 472 320 472C289.6 472 264.1 450.8 257.4 422.4C254.3 409.4 262.4 396.4 275.3 393.3C288.2 390.2 301.3 398.3 304.4 411.2C306 417.8 312 424 320 424C328.8 424 336 416.8 336 408L336 384L232 384C218.7 384 208 373.3 208 360C208 346.7 218.7 336 232 336L336 336L336 312L272 312C228.9 312 194 277.1 194 234C194 190.9 228.9 156 272 156L408 156C421.3 156 432 166.7 432 180C432 193.3 421.3 204 408 204L272 204C255.4 204 242 217.4 242 234C242 250.6 255.4 264 272 264L336 264L336 248C336 239.2 328.8 232 320 232C312 232 306 238.2 304.4 244.8C301.3 257.7 288.2 265.8 275.3 262.7C262.4 259.6 254.3 246.6 257.4 233.6C264.1 205.2 289.6 184 320 184z" style="fill:#2f2f2f;fill-rule:nonzero;" />
            </svg>
        </span>
        `),
        route: '/credit-sales'
      },
      {
        label: 'sidebarTitles.invoice_history',
        icon: this.sanitize(`
        <span class="block w-8 h-8">
            <svg width="100%" height="100%" viewBox="0 0 640 640" xmlns="http://www.w3.org/2000/svg">
              <path d="M320 128C426 128 512 214 512 320C512 426 426 512 320 512C254.8 512 197.1 479.5 162.4 429.7C152.3 415.2 132.3 411.7 117.8 421.8C103.3 431.9 99.8 451.9 109.9 466.4C156.1 532.6 233 576 320 576C461.4 576 576 461.4 576 320C576 178.6 461.4 64 320 64C234.3 64 158.5 106.1 112 170.7L112 144C112 126.3 97.7 112 80 112C62.3 112 48 126.3 48 144L48 256C48 273.7 62.3 288 80 288L104.6 288C105.1 288 105.6 288 106.1 288L192.1 288C209.8 288 224.1 273.7 224.1 256C224.1 238.3 209.8 224 192.1 224L153.8 224C186.9 166.6 249 128 320 128zM344 216C344 202.7 333.3 192 320 192C306.7 192 296 202.7 296 216L296 320C296 326.4 298.5 332.5 303 337L375 409C384.4 418.4 399.6 418.4 408.9 409C418.2 399.6 418.3 384.4 408.9 375.1L343.9 310.1L343.9 216z" style="fill:#2f2f2f;fill-rule:nonzero;" />
            </svg>
        </span>
        `),
        route: '/invoice-history'
      },
      {
        label: 'sidebarTitles.returns',
        icon: this.sanitize(`
        <span class="block w-8 h-8">
          <svg width="100%" height="100%" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            <path d="M7 7h10v3l4-4-4-4v3H7a5 5 0 0 0-5 5v2h2v-2a3 3 0 0 1 3-3zm10 10H7v-3l-4 4 4 4v-3h10a5 5 0 0 0 5-5v-2h-2v2a3 3 0 0 1-3 3z" style="fill:#2f2f2f" />
          </svg>
        </span>
        `),
        route: '/returns'
      },
      {
        label: 'sidebarTitles.profit_report',
        icon: this.sanitize(`
        <span class="block w-8 h-8">
            <svg width="100%" height="100%" viewBox="0 0 640 640" xmlns="http://www.w3.org/2000/svg">
              <path d="M128 96C110.3 96 96 110.3 96 128L96 512C96 529.7 110.3 544 128 544L512 544C529.7 544 544 529.7 544 512C544 494.3 529.7 480 512 480L160 480L160 128C160 110.3 145.7 96 128 96zM464 184C471.7 176.3 471.7 163.7 464 156C456.3 148.3 443.7 148.3 436 156L336 256L284 204C276.3 196.3 263.7 196.3 256 204L188 272C180.3 279.7 180.3 292.3 188 300C195.7 307.7 208.3 307.7 216 300L270 246L322 298C329.7 305.7 342.3 305.7 350 298L464 184zM224 352C206.3 352 192 366.3 192 384C192 401.7 206.3 416 224 416L448 416C465.7 416 480 401.7 480 384C480 366.3 465.7 352 448 352L224 352z" style="fill:#2f2f2f;fill-rule:nonzero;" />
            </svg>
        </span>
        `),
        route: '/products/profit-report'
      }
    ];
  }

  private checkHasAnyProducts() {
    if (!this.isBrowser || this.hasProductsChecked) return;

    this.hasProductsChecked = true;
    const categoryIdHint = this.categories?.[0]?.id;

    if (!categoryIdHint) {
      this.hasProducts.set(false);
      return;
    }

    this._cateoryService.getProducts(categoryIdHint, { categoryId: categoryIdHint, limit: 1 }).subscribe({
      next: (res: any) => {
        this.hasProducts.set(this.extractList(res).length > 0);
      },
      error: () => this.hasProducts.set(false)
    });
  }

  private extractList(response: any): any[] {
    if (Array.isArray(response)) return response;
    if (Array.isArray(response?.data)) return response.data;
    if (Array.isArray(response?.products)) return response.products;
    if (Array.isArray(response?.data?.products)) return response.data.products;
    return [];
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
    if (this.isSidenavCollapsed) {
      this.openSidenav();
      // Wait a bit to allow sidenav to expand smoothly before showing children
      setTimeout(() => {
        this.expandedCategory = category;
      }, 300); // adjust delay to match your sidenav animation time
    } else {
      this.expandedCategory = this.expandedCategory === category ? null : category;
    }
  }


  openSidenav() {
    this.isSidenavCollapsed = false
    this.collapsedSidenav.emit(this.isSidenavCollapsed);
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

  resetHomeView() {
    if (this.isBrowser) {
      localStorage.setItem(HOME_VIEW_STORAGE_KEY, HOME_DEFAULT_VIEW);
    }
    this._router.navigate(['/home'], { queryParams: { resetView: Date.now() } });
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
