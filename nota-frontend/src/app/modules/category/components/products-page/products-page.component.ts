import { PrintActionItem, PrintActionsComponent } from '../../../../core/print/print-actions.component';
import { PrintDataService } from '../../../../core/print/print-data.service';
import { CommonModule, isPlatformBrowser } from '@angular/common';
import {
  ChangeDetectorRef,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  inject,
  OnDestroy,
  OnInit,
  PLATFORM_ID,
  ViewChild,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { distinctUntilChanged, map } from 'rxjs';
import { TranslatePipe } from '@ngx-translate/core';
import { DialogModule } from 'primeng/dialog';
import { CateoryService, Product } from '../../services/cateory.service';
import { CatalogStateService, SidebarCategory } from '../../../layout/nav/catalog-state.service';
import {
  NotaButtonDirective,
  NotaDialogShellComponent,
  NotaMoneyPipe,
  NotaNumberPipe,
  NotaPageHeaderComponent,
  NotaPillVariant,
} from '../../../shared/ui';
import { CategoryToolsComponent } from '../category-tools/category-tools.component';
import { NotaCanDirective } from '../../../../core/auth/nota-can.directive';
import { AuthService } from '../../../../core/auth/auth.service';
import { ToastService } from '../../../../core/auth/toast.service';
import { TranslateService } from '@ngx-translate/core';
import { firstValueFrom } from 'rxjs';
import { BarcodeApiService } from '../../../../core/scan/barcode-api.service';
import { ScanService } from '../../../../core/scan/scan.service';
import { ScanSoundService } from '../../../../core/scan/scan-sound.service';
import { normalizeCode } from '../../../../core/scan/scan-normalize';
import { LabelDialogProduct, LabelPrintDialogComponent } from '../../../../core/print/label-print-dialog.component';

/** Low stock when inventoryCount <= the product's lowStockThreshold, or this default (same as the backend). */
export const LOW_STOCK_THRESHOLD = 5;

/** The product's own threshold (Stage 12), else the default. */
export function stockThreshold(product: { lowStockThreshold?: unknown } | null | undefined): number {
  const value = Number(product?.lowStockThreshold);
  return product?.lowStockThreshold !== undefined && product?.lowStockThreshold !== null && Number.isFinite(value) && value >= 0
    ? value
    : LOW_STOCK_THRESHOLD;
}

/**
 * Products & categories (docs/design/screens/Products.dc.html), route /products?category=<id>.
 * The product list logic (paging, infinite scroll, search) is the old /categories/:id page's, unchanged;
 * the category tools are the old sidebar's (CategoryToolsComponent).
 */
@Component({
  selector: 'app-products-page',
  standalone: true,
  imports: [PrintActionsComponent, CommonModule, FormsModule, RouterLink, TranslatePipe, DialogModule, NotaButtonDirective, NotaDialogShellComponent,
    NotaMoneyPipe, NotaNumberPipe, NotaPageHeaderComponent, CategoryToolsComponent, NotaCanDirective, LabelPrintDialogComponent],
  templateUrl: './products-page.component.html',
  styleUrl: './products-page.component.scss',
})
export class ProductsPageComponent implements OnInit, OnDestroy {
  private readonly destroyRef = inject(DestroyRef);
  private readonly printData = inject(PrintDataService);

  /** Stage 23: the stock count sheet (PrStockList) of the open category, or of every product. The cost and value columns come only with products.viewCost. */
  stockPrintItems(): PrintActionItem[] {
    return [{ key: 'stock', load: () => this.printData.stockList(this.categoryId || null, this.categoryId ? (this.categories().find((category) => category.id === this.categoryId)?.label ?? '') : '') }];
  }
  private readonly _auth = inject(AuthService);
  /** Table columns: the purchase-price column is there only with products.viewCost. */
  readonly columnCount = computed(() => 8 + (this._auth.has('products.viewCost') ? 1 : 0) + (this._auth.has('products.printLabels') ? 1 : 0));
  private readonly _catalog = inject(CatalogStateService);
  private readonly _cateoryService = inject(CateoryService);
  private readonly _activatedRoute = inject(ActivatedRoute);
  private readonly _router = inject(Router);
  private readonly cdr = inject(ChangeDetectorRef);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));
  private readonly pageSize = 10;
  private scrollObserver?: IntersectionObserver;
  private scrollSentinel?: ElementRef<HTMLElement>;

  readonly tools = viewChild(CategoryToolsComponent);
  readonly categories = this._catalog.categories;
  readonly lowStockThreshold = LOW_STOCK_THRESHOLD;
  /** "كل الأصناف" count: sum of the categories' productCount, when the API sent them. */
  readonly allCount = computed(() => {
    const counts = this.categories().map((category) => category.productCount);
    return counts.every((count) => typeof count === 'number') ? counts.reduce((sum, count) => sum + (count as number), 0) : null;
  });

  @ViewChild('scrollSentinel')
  set infiniteScrollSentinel(element: ElementRef<HTMLElement> | undefined) {
    this.scrollSentinel = element;
    this.observeScrollSentinel();
  }

  categoryId = '';
  products: Product[] = [];
  searchTerm = '';
  lowStockOnly = false;
  includeArchived = false;
  errorVisible = false;
  errorMessage = '';
  isLoadingProducts = false;
  hasLoadedProducts = false;
  hasNextPage = true;
  currentPage = 0;
  totalPages = 1;

  // ---------- Stage 26: barcodes (scan to find, bulk generate, print labels) ----------
  private readonly scan = inject(ScanService);
  private readonly sounds = inject(ScanSoundService);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);
  private readonly barcodeApi = inject(BarcodeApiService);
  @ViewChild('productSearch') private productSearch?: ElementRef<HTMLInputElement>;

  /** Ids ticked for "اطبع ملصقات للمحدد". */
  selectedIds = new Set<string>();
  labelDialogVisible = false;
  labelProducts: LabelDialogProduct[] = [];
  bulkVisible = false;
  bulkCount = 0;
  bulkBusy = false;

  /** Reloads the list from the first page (after barcodes were generated from the label dialog). */
  reloadProducts(): void {
    this.resetProductsPagination();
    this.loadNextPage();
  }

  firstBarcode(product: Product | null | undefined): string {
    return Array.isArray(product?.barcodes) && product.barcodes.length ? product.barcodes[0] : '';
  }

  toggleSelected(product: Product, checked: boolean): void {
    if (checked) this.selectedIds.add(product._id);
    else this.selectedIds.delete(product._id);
  }

  allVisibleSelected(): boolean {
    const visible = this.filteredProducts.filter((product) => !product.isArchived);
    return visible.length > 0 && visible.every((product) => this.selectedIds.has(product._id));
  }

  toggleAllVisible(checked: boolean): void {
    for (const product of this.filteredProducts.filter((entry) => !entry.isArchived)) this.toggleSelected(product, checked);
  }

  /** "اطبع ملصقات للمحدد": a quantity per product (default 1) is set in the dialog. */
  printSelectedLabels(): void {
    this.labelProducts = this.products.filter((product) => this.selectedIds.has(product._id)).map((product) => ({ ...product, copies: 1 }));
    this.labelDialogVisible = this.labelProducts.length > 0;
  }

  /** "اطبع ملصقات كل منتجات الفئة": every non-archived product of the open category (read page by page, 100 at a time). */
  async printCategoryLabels(): Promise<void> {
    if (!this.categoryId) return;
    const all: Product[] = [];
    try {
      for (let page = 1; page <= 200; page += 1) {
        const result = await firstValueFrom(this._cateoryService.getProductsPage(this.categoryId, { page, limit: 100 }));
        all.push(...result.products);
        if (!result.pagination.hasNextPage) break;
      }
    } catch (error) {
      this.toast.error((error as { error?: { message?: string } })?.error?.message || this.translate.instant('barcodes.lookupFailed'));
      return;
    }
    this.labelProducts = all.map((product) => ({ ...product, copies: 1 }));
    this.labelDialogVisible = this.labelProducts.length > 0;
    this.cdr.detectChanges();
  }

  /** Enter in the search box (a scanner's last key): an exact barcode, then an exact code. Anything else keeps the typed filter. */
  async onSearchEnter(event: Event): Promise<void> {
    event.preventDefault();
    const typed = this.searchTerm.trim();
    if (!typed) return;
    const result = await this.scan.lookup(typed);
    if (result.kind === 'product') {
      const product = result.product as unknown as Product;
      if (!this.products.some((entry) => entry._id === product._id)) this.products = [product, ...this.products];
      this.searchTerm = result.matchedBy === 'barcode' ? this.firstBarcodeMatch(product, result.code) : String(product.code ?? typed);
      this.sounds.ok();
    } else if (result.kind === 'archived') {
      this.sounds.error();
      this.toast.error(this.translate.instant('barcodes.archived'));
      this.productSearch?.nativeElement.select();
    } else if (result.kind === 'notFound') {
      // Nothing exact: the typed text stays as a normal (partial) filter, no error (the user may be typing a name).
      this.searchTerm = typed;
    } else {
      this.toast.error(result.message || this.translate.instant('barcodes.lookupFailed'));
    }
    this.cdr.detectChanges();
  }

  private firstBarcodeMatch(product: Product, code: string): string {
    return (product.barcodes ?? []).find((barcode) => barcode === code) ?? code;
  }

  /** "ولّد باركود للمنتجات اللي ملهاش": shows how many products it will touch (the open category, or all) and asks to confirm. */
  async openBulkGenerate(): Promise<void> {
    try {
      const { count } = await firstValueFrom(this.barcodeApi.missingCount(this.categoryId || undefined));
      if (!count) {
        this.toast.show(this.translate.instant('barcodes.bulk.none', { scope: this.bulkScope() }), 'info');
        return;
      }
      this.bulkCount = count;
      this.bulkVisible = true;
    } catch (error) {
      this.toast.error((error as { error?: { message?: string } })?.error?.message || this.translate.instant('barcodes.bulk.failed'));
    }
    this.cdr.detectChanges();
  }

  bulkScope(): string {
    return this.categoryId ? (this.selectedCategory?.label ?? '') : this.translate.instant('barcodes.bulk.scopeAll');
  }

  async confirmBulkGenerate(): Promise<void> {
    this.bulkBusy = true;
    try {
      const { done } = await firstValueFrom(this.barcodeApi.generateMissing(this.categoryId || undefined));
      this.toast.show(this.translate.instant('barcodes.bulk.done', { count: done }), 'success');
      this.bulkVisible = false;
      this.resetProductsPagination();
      this.loadNextPage();
    } catch (error) {
      this.toast.error((error as { error?: { message?: string } })?.error?.message || this.translate.instant('barcodes.bulk.failed'));
    } finally {
      this.bulkBusy = false;
      this.cdr.detectChanges();
    }
  }

  ngOnInit(): void {
    this._activatedRoute.queryParamMap.pipe(
      map((params) => params.get('category') ?? ''),
      distinctUntilChanged(),
      takeUntilDestroyed(this.destroyRef)
    ).subscribe((categoryId) => {
      this.categoryId = categoryId;
      this.resetProductsPagination();
      this.loadNextPage();
    });
  }

  ngOnDestroy(): void {
    this.scrollObserver?.disconnect();
  }

  get selectedCategory(): SidebarCategory | undefined {
    return this.categories().find((category) => category.id === this.categoryId);
  }

  /** Stage 12: no ?category = "كل الأصناف" (GET products without categoryId). */
  get isAllProducts(): boolean {
    return !this.categoryId;
  }

  get filteredProducts(): Product[] {
    const normalizedSearchTerm = this.searchTerm.trim().toLowerCase();
    const searched = !normalizedSearchTerm
      ? this.products
      : this.products.filter((product) => {
        const productName = String(product?.name || '').toLowerCase();
        const productCode = String(product?.code || '').toLowerCase();
        // Stage 26: barcodes are searched too (a typed or Arabic-layout scanned code is normalised first).
        const scanned = normalizeCode(normalizedSearchTerm).toLowerCase();
        const barcodeHit = (product?.barcodes ?? []).some((barcode) => barcode.toLowerCase().includes(scanned));
        return productName.includes(normalizedSearchTerm) || productCode.includes(normalizedSearchTerm) || barcodeHit;
      });
    return this.lowStockOnly ? searched.filter((product) => this.isLowStock(product)) : searched;
  }

  selectCategory(categoryId: string, replaceUrl = false): void {
    this._router.navigate(['/products'], { queryParams: { category: categoryId }, replaceUrl });
  }

  /**
   * Codes of the loaded products: the new-product form suggests the next code from them, as the old dialog did.
   * On "كل الأصناف" the form opens on the first category and loads that category's codes itself.
   */
  newProduct(): void {
    if (this.isAllProducts) {
      this._router.navigate(['/products/new']);
      return;
    }
    this._router.navigate(['/products/new'], {
      queryParams: { category: this.categoryId },
      state: { productCodes: this.products.map((product) => product?.code ?? null) },
    });
  }

  openAddCategory(): void {
    this.tools()?.openDialog();
  }

  openEditCategory(category: SidebarCategory, event?: Event): void {
    this.tools()?.openEditCategoryDialog(category, event);
  }

  deleteCategory(category: SidebarCategory): void {
    this.tools()?.promptForCategoryDeletion(category);
  }

  /** low ≤ threshold, medium ≤ 2 × threshold, else ok (threshold 5 gives the Stage 11 levels ≤ 5 / ≤ 10). */
  stockVariant(product: Product): NotaPillVariant {
    if (this.isLowStock(product)) return 'overdue';
    const parsedValue = Number(product?.inventoryCount);
    return Number.isFinite(parsedValue) && parsedValue <= stockThreshold(product) * 2 ? 'due' : 'ok';
  }

  isLowStock(product: Product): boolean {
    const parsedValue = Number(product?.inventoryCount);
    return Number.isFinite(parsedValue) && parsedValue <= stockThreshold(product);
  }

  threshold(product: Product): number {
    return stockThreshold(product);
  }

  isOutOfStock(inventoryCount: unknown): boolean {
    const parsedValue = Number(inventoryCount);
    return Number.isFinite(parsedValue) && parsedValue === 0;
  }

  loadNextPage(): void {
    if (this.isLoadingProducts || !this.hasNextPage) {
      return;
    }

    const requestedPage = this.currentPage + 1;
    this.isLoadingProducts = true;

    const requestedCategoryId = this.categoryId;
    this._cateoryService.getProductsPage(requestedCategoryId || null, {
      page: requestedPage,
      limit: this.pageSize,
      includeArchived: this.includeArchived,
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

  toggleArchived(): void {
    this.includeArchived = !this.includeArchived;
    this.resetProductsPagination();
    this.loadNextPage();
  }

  restoreProduct(product: Product): void {
    this._cateoryService.restoreProduct(product._id).subscribe({
      next: () => { this.resetProductsPagination(); this.loadNextPage(); },
      error: (err) => { this.errorMessage = err?.error?.message || err?.message; this.errorVisible = true; },
    });
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
}
