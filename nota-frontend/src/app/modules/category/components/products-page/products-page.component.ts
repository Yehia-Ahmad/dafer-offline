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
  imports: [CommonModule, FormsModule, RouterLink, TranslatePipe, DialogModule, NotaButtonDirective, NotaDialogShellComponent,
    NotaMoneyPipe, NotaNumberPipe, NotaPageHeaderComponent, CategoryToolsComponent],
  templateUrl: './products-page.component.html',
  styleUrl: './products-page.component.scss',
})
export class ProductsPageComponent implements OnInit, OnDestroy {
  private readonly destroyRef = inject(DestroyRef);
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
  errorVisible = false;
  errorMessage = '';
  isLoadingProducts = false;
  hasLoadedProducts = false;
  hasNextPage = true;
  currentPage = 0;
  totalPages = 1;

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
        return productName.includes(normalizedSearchTerm) || productCode.includes(normalizedSearchTerm);
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
