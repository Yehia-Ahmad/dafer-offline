import { CommonModule, isPlatformBrowser } from '@angular/common';
import { ChangeDetectorRef, Component, Inject, OnInit, PLATFORM_ID, inject } from '@angular/core';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { ProductsService } from '../../services/products.service';
import { FormsModule } from '@angular/forms';
import { InputNumberModule } from 'primeng/inputnumber';
import { DatePickerModule } from 'primeng/datepicker';
import { DialogModule } from 'primeng/dialog';
import { SelectModule } from 'primeng/select';
import { LockDateService } from '../../../../core/accounting-lock/lock-date.service';
import { CateoryService } from '../../../category/services/cateory.service';
import {
  NotaButtonDirective,
  NotaDialogShellComponent,
  NotaFormFieldComponent,
  NotaLockBannerComponent,
  NotaMoneyPipe,
  NotaNumberPipe,
  NotaPageHeaderComponent
} from '../../../shared/ui';
import { ReturnsService } from '../../../returns/services/returns.service';
import { InvoiceHistoryRow, buildFallbackInvoiceNumber } from '../../../../core/print/print-adapters';
import { ReturnPrintBannerComponent } from '../../../../core/print/return-print-banner.component';
import { PrintActionItem, PrintActionsComponent } from '../../../../core/print/print-actions.component';
import { PrintDataService } from '../../../../core/print/print-data.service';
import { ShopProfileService } from '../../../shop-profile/services/shop-profile.service';
import { NotaCanDirective } from '../../../../core/auth/nota-can.directive';
import { PaymentBoxSelectComponent } from '../../../cashbox/payment-box-select.component';
import { PaymentBoxService } from '../../../cashbox/payment-box.service';
import { LockedActionComponent } from '../../../../core/auth/locked-action.component';
import { RouterLink } from '@angular/router';
import { toInvoiceVat } from '../../../shared/vat/vat-print';

type SelectOption = {
  label: string;
  value: string;
};

type CashReturnItem = {
  productId: string;
  productName: string;
  productCode: string;
  availableQuantity: number;
  quantity: number;
  returnReason: string;
};

type SellingsPagination = {
  page: number;
  limit: number;
  totalItems: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPrevPage: boolean;
};

const DEFAULT_SELLINGS_PAGINATION: SellingsPagination = {
  page: 1,
  limit: 10,
  totalItems: 0,
  totalPages: 1,
  hasNextPage: false,
  hasPrevPage: false
};

@Component({
  selector: 'app-invoice-history',
  standalone: true,
  imports: [ReturnPrintBannerComponent, PrintActionsComponent, LockedActionComponent, NotaCanDirective, PaymentBoxSelectComponent, RouterLink,
    CommonModule,
    FormsModule,
    TranslatePipe,
    InputNumberModule,
    DatePickerModule,
    DialogModule,
    SelectModule,
    NotaButtonDirective,
    NotaDialogShellComponent,
    NotaFormFieldComponent,
    NotaLockBannerComponent,
    NotaMoneyPipe,
    NotaNumberPipe,
    NotaPageHeaderComponent
  ],
  templateUrl: './invoice-history.component.html',
  styleUrl: './invoice-history.component.scss'
})
export class InvoiceHistoryComponent implements OnInit {
  /** Stage 10: the invoice shown in the detail panel (frontend only). */
  selectedSelling: InvoiceHistoryRow | null = null;
  private isBrowser: boolean;
  isLoading = false;
  isLoadingMore = false;
  loadError = '';
  loadMoreError = '';
  sellings: InvoiceHistoryRow[] = [];
  pagination: SellingsPagination = { ...DEFAULT_SELLINGS_PAGINATION };
  isCategoriesLoading = false;
  isProductsLoading = false;
  categoryOptions: SelectOption[] = [];
  productOptions: SelectOption[] = [];
  filterCategoryId = '';
  filterProductId = '';
  filterCustomerName = '';
  filterCustomerPhone = '';
  filterSellingDate: Date | null = null;
  filterNumber = '';
  cancelReason = '';
  deletingSellingId = '';
  deleteDialogVisible = false;
  selectedSellingToDelete: InvoiceHistoryRow | null = null;
  returnDialogVisible = false;
  selectedSellingToReturn: InvoiceHistoryRow | null = null;
  cashReturnDate = new Date();
  cashReturnNote = '';
  cashReturnItems: CashReturnItem[] = [];
  returnError = '';
  returningSellingId = '';

  private readonly _shopProfileService = inject(ShopProfileService);
  private readonly printData = inject(PrintDataService);
  /** Stage 23: the invoice of the return just recorded (shows the return receipt's print buttons). */
  lastReturnInvoiceId = '';
  /** Stage 19: the box a cash refund comes out of. */
  readonly payment = inject(PaymentBoxService);
  /** Stage 22: locked days are disabled in the return date picker and a locked date cannot be submitted. */
  protected readonly lock = inject(LockDateService);

  constructor(
    private _productsService: ProductsService,
    private _returnsService: ReturnsService,
    private _categoryService: CateoryService,
    private _translate: TranslateService,
    private _cdr: ChangeDetectorRef,
    @Inject(PLATFORM_ID) platformId: Object
  ) {
    this.isBrowser = isPlatformBrowser(platformId);
  }

  ngOnInit(): void {
    if (!this.isBrowser) return;
    // Stage 22 review: another PC may have closed a period since this one signed in.
    this.lock.refresh();
    this.loadCategories();
    this.loadSellings();
    // Cached for printing; without it the invoice prints with a neutral header.
    this._shopProfileService.refresh();
  }

  applyFilters(): void {
    this.loadSellings(1, false);
  }

  resetFilters(): void {
    this.filterCategoryId = '';
    this.filterProductId = '';
    this.productOptions = [];
    this.filterCustomerName = '';
    this.filterCustomerPhone = '';
    this.filterSellingDate = null;
    this.filterNumber = '';
    this.loadSellings(1, false);
  }

  onCategoryFilterChange(categoryId: string): void {
    this.filterCategoryId = String(categoryId || '');
    this.filterProductId = '';
    this.productOptions = [];

    if (!this.filterCategoryId) {
      return;
    }

    this.loadProductsByCategory(this.filterCategoryId);
  }

  /** Stage 10 pager (replaces infinite scroll): same GET sellings request with the requested page. */
  goToPage(page: number): void {
    if (this.isLoading || page < 1 || page > Math.max(1, this.pagination.totalPages) || page === this.pagination.page) {
      return;
    }

    this.loadSellings(page, false);
  }

  selectSelling(selling: InvoiceHistoryRow): void {
    this.selectedSelling = selling;
  }

  /** First and last row number of the shown page (for "x–y of N"). */
  get pageRange(): { from: number; to: number } {
    if (!this.sellings.length) return { from: 0, to: 0 };
    const from = (this.pagination.page - 1) * this.pagination.limit + 1;
    return { from, to: from + this.sellings.length - 1 };
  }

  /** Total of the invoices on the shown page (labelled as such in the footer). */
  get pageTotal(): number {
    return this.sellings.reduce((sum, item) => sum + Number(item.totalPrice || 0), 0);
  }

  statusPill(selling: InvoiceHistoryRow): string {
    if (selling.status === 'cancelled') return 'nota-pill nota-pill--danger';
    return selling.refundStatus === 'partial' || selling.refundStatus === 'full'
      ? 'nota-pill nota-pill--info'
      : 'nota-pill nota-pill--ok';
  }

  private loadSellings(page = 1, append = false): void {
    if (append) {
      this.isLoadingMore = true;
    } else {
      this.isLoading = true;
      this.pagination = { ...DEFAULT_SELLINGS_PAGINATION, limit: this.pagination.limit };
    }
    this.loadError = '';
    this.loadMoreError = '';

    this._productsService.getSellings(this.buildFilterParams(page)).subscribe({
      next: (response: any) => {
        const nextSellings = this.extractSellings(response);
        this.sellings = append ? this.mergeSellings(this.sellings, nextSellings) : nextSellings;
        this.pagination = this.extractPagination(response, page);
        this.selectedSelling = this.sellings.find((item) => item.id === this.selectedSelling?.id) ?? this.sellings[0] ?? null;
        this.isLoading = false;
        this.isLoadingMore = false;
        this._cdr.detectChanges();
      },
      error: (err: any) => {
        const message = err?.error?.message || 'Failed to load sellings.';
        if (!append) {
          this.sellings = [];
          this.selectedSelling = null;
          this.pagination = { ...DEFAULT_SELLINGS_PAGINATION, limit: this.pagination.limit };
          this.loadError = message;
        } else {
          this.loadMoreError = message;
        }
        this.isLoading = false;
        this.isLoadingMore = false;
        this._cdr.detectChanges();
      }
    });
  }

  private buildFilterParams(page: number): {
    categoryId?: string;
    productId?: string;
    customerName?: string;
    customerPhone?: string;
    sellingDate?: string;
    number?: string;
    page: number;
    limit: number;
  } {
    const categoryId = this.filterCategoryId.trim();
    const productId = this.filterProductId.trim();
    const customerName = this.filterCustomerName.trim();
    const customerPhone = this.filterCustomerPhone.trim();
    const sellingDate = this.formatDateParam(this.filterSellingDate);
    const number = this.filterNumber.trim().toUpperCase();

    return {
      ...(categoryId ? { categoryId } : {}),
      ...(productId ? { productId } : {}),
      ...(customerName ? { customerName } : {}),
      ...(customerPhone ? { customerPhone } : {}),
      ...(sellingDate ? { sellingDate } : {}),
      ...(number ? { number } : {}),
      page,
      limit: this.pagination.limit
    };
  }

  private formatDateParam(value: Date | null): string | undefined {
    if (!value) return undefined;
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return undefined;
    return date.toISOString().split('T')[0];
  }

  private loadCategories(): void {
    this.isCategoriesLoading = true;

    this._categoryService.getCategories().subscribe({
      next: (response: any) => {
        const categories = this.extractCollection(response);
        this.categoryOptions = categories.map((item: any) => ({
          label: String(item?.name || ''),
          value: String(item?._id || item?.id || '')
        })).filter((item: SelectOption) => Boolean(item.value));

        this.isCategoriesLoading = false;
        this._cdr.detectChanges();
      },
      error: () => {
        this.categoryOptions = [];
        this.isCategoriesLoading = false;
        this._cdr.detectChanges();
      }
    });
  }

  private loadProductsByCategory(categoryId: string): void {
    this.isProductsLoading = true;
    const params = { categoryId };

    this._categoryService.getProducts(categoryId, params).subscribe({
      next: (response: any) => {
        const products = this.extractCollection(response);
        this.productOptions = products.map((item: any) => ({
          label: String(item?.name || item?.productName || ''),
          value: String(item?._id || item?.id || '')
        })).filter((item: SelectOption) => Boolean(item.value));

        this.isProductsLoading = false;
        this._cdr.detectChanges();
      },
      error: () => {
        this.productOptions = [];
        this.isProductsLoading = false;
        this._cdr.detectChanges();
      }
    });
  }

  private extractSellings(response: any): any[] {
    let list: any[] = [];

    if (Array.isArray(response)) {
      list = response;
    } else if (Array.isArray(response?.data?.invoices)) {
      list = response.data.invoices;
    } else if (Array.isArray(response?.data)) {
      list = response.data;
    } else if (Array.isArray(response?.invoices)) {
      list = response.invoices;
    } else if (Array.isArray(response?.sellings)) {
      list = response.sellings;
    } else if (response?.data && typeof response.data === 'object') {
      list = [response.data];
    } else if (response && typeof response === 'object') {
      list = [response];
    }

    return list
      .map((item) => this.mapSelling(item))
      .filter((item): item is InvoiceHistoryRow => item !== null);
  }

  private extractPagination(response: any, requestedPage: number): SellingsPagination {
    const source = response?.pagination ?? response?.data?.pagination ?? {};
    const page = this.toPositiveInteger(source.page, requestedPage);
    const limit = this.toPositiveInteger(source.limit, this.pagination.limit);
    const totalItems = this.toPositiveInteger(source.totalItems, this.sellings.length);
    const totalPages = this.toPositiveInteger(source.totalPages, page);

    return {
      page,
      limit,
      totalItems,
      totalPages,
      hasNextPage: Boolean(source.hasNextPage ?? page < totalPages),
      hasPrevPage: Boolean(source.hasPrevPage ?? page > 1)
    };
  }

  private mergeSellings(current: InvoiceHistoryRow[], next: InvoiceHistoryRow[]): InvoiceHistoryRow[] {
    const seenIds = new Set(current.map((item) => item.id));
    const uniqueNext = next.filter((item) => {
      if (seenIds.has(item.id)) {
        return false;
      }
      seenIds.add(item.id);
      return true;
    });

    return [...current, ...uniqueNext];
  }

  private extractCollection(response: any): any[] {
    if (Array.isArray(response)) return response;
    if (Array.isArray(response?.data)) return response.data;
    if (Array.isArray(response?.products)) return response.products;
    if (Array.isArray(response?.categories)) return response.categories;
    if (response?.data && typeof response.data === 'object') return [response.data];
    if (response && typeof response === 'object') return [response];
    return [];
  }

  private mapSelling(item: any): InvoiceHistoryRow | null {
    if (!item) return null;

    const id = item.invoiceId || item._id || item.id;
    if (!id) return null;
    const normalizedId = String(id);
    const items = this.extractInvoiceItems(item, normalizedId);
    const invoiceNumber = String(
      item.invoiceNumber ||
      item.invoiceNo ||
      item.number ||
      buildFallbackInvoiceNumber(normalizedId)
    );
    const subtotal = this.toNumber(item.subtotal) ?? this.sumInvoiceMetric(items, 'totalPrice');

    return {
      id: normalizedId,
      invoiceId: normalizedId,
      createdByName: item.createdByName ? String(item.createdByName) : null,
      invoiceNumber,
      customerName: String(item.customerName || ''),
      customerPhone: String(item.customerPhone || item.customer?.phone || item.customer?.phoneNumber || ''),
      sellingDate: item.sellingDate ? String(item.sellingDate) : (items[0]?.sellingDate || null),
      itemCount: this.toNumber(item.itemCount) ?? items.length,
      totalQuantity: this.toNumber(item.totalQuantity) ?? this.sumInvoiceMetric(items, 'quantity'),
      subtotal,
      discountAmount: this.resolveDiscountAmount(item, subtotal),
      discountPercentage: this.resolveDiscountPercentage(item, subtotal),
      shippingFees: this.toNumber(item.shippingFees),
      totalPrice: this.resolveInvoiceTotal(item, items),
      netTotal: this.toNumber(item.netTotal),
      ...(toInvoiceVat(item) ? { vat: toInvoiceVat(item) } : {}),
      status: String(item.status || 'active'),
      cancellationReason: item.cancellationReason ? String(item.cancellationReason) : null,
      cancelRefundAmount: this.toNumber(item.cancelRefundAmount),
      cancelRefundBoxName: item.cancelRefundBoxName ? String(item.cancelRefundBoxName) : null,
      items,
      refundStatus: String(item.refundStatus || 'none'),
      refundedAmount: this.toNumber(item.refundedAmount),
      refunds: (Array.isArray(item.refunds) ? item.refunds : []).map((refund: any, index: number) => ({
        id: String(refund?._id || index),
        refundDate: refund?.refundDate ? String(refund.refundDate) : null,
        totalAmount: this.toNumber(refund?.totalAmount),
        items: (Array.isArray(refund?.items) ? refund.items : []).map((refundItem: any) => ({
          productName: String(refundItem?.productName || ''),
          quantity: this.toNumber(refundItem?.quantity)
        }))
      }))
    };
  }

  private extractInvoiceItems(source: any, invoiceId: string): InvoiceHistoryRow['items'] {
    if (Array.isArray(source?.items)) {
      return source.items
        .map((item: any, index: number) => this.mapInvoiceItem(item, invoiceId, source, index))
        .filter((item): item is InvoiceHistoryRow['items'][number] => item !== null);
    }

    const legacyItem = this.mapInvoiceItem(source, invoiceId, source, 0);
    return legacyItem ? [legacyItem] : [];
  }

  private mapInvoiceItem(
    item: any,
    invoiceId: string,
    parentInvoice: any,
    index: number
  ): InvoiceHistoryRow['items'][number] | null {
    if (!item) return null;

    const id = item._id || item.id || `${invoiceId}-${item.productId || item.productCode || index}`;

    return {
      id: String(id),
      invoiceId,
      productId: String(item.productId || ''),
      productCode: String(item.productCode || item.product?.code || item.code || ''),
      productName: String(item.productName || item.product?.name || item.name || ''),
      categoryName: String(item.categoryName || item.category?.name || parentInvoice?.categoryName || ''),
      customerName: String(item.customerName || parentInvoice?.customerName || ''),
      customerPhone: String(
        item.customerPhone ||
        item.customer?.phone ||
        item.customer?.phoneNumber ||
        parentInvoice?.customerPhone ||
        parentInvoice?.customer?.phone ||
        parentInvoice?.customer?.phoneNumber ||
        ''
      ),
      sellingDate: item.sellingDate ? String(item.sellingDate) : (parentInvoice?.sellingDate ? String(parentInvoice.sellingDate) : null),
      quantity: this.toNumber(item.productQuantity ?? item.productQuentity ?? item.quantity),
      returnedQuantity: this.toNumber(item.returnedQuantity),
      unitPrice: this.toNumber(item.productPricePerEach ?? item.price),
      totalPrice: this.toNumber(item.totalPrice ?? item.total),
      ...(item.vatExempt === true ? { vatExempt: true } : {})
    };
  }

  /** Stage 23: the A4 invoice and the 80mm receipt of a cash sale (a cancelled one prints with the "ملغي" watermark). */
  printItems(selling: InvoiceHistoryRow): PrintActionItem[] {
    return [
      { key: 'invoice', label: this.translateKey('print.invoiceA4'), load: async () => this.printData.cashInvoice(selling) },
      { key: 'receipt', label: this.translateKey('print.receipt80'), load: async () => this.printData.cashReceipt(selling) }
    ];
  }

  canReturnSelling(selling: InvoiceHistoryRow): boolean {
    return !!selling?.id && selling.status !== 'cancelled' && selling.refundStatus !== 'full' && selling.items.some((item) => !!item.productId && Number(item.quantity) > 0);
  }

  openReturnDialog(selling: InvoiceHistoryRow): void {
    if (!this.canReturnSelling(selling)) return;

    this.selectedSellingToReturn = selling;
    this.cashReturnDate = new Date();
    this.cashReturnNote = '';
    this.returnError = '';
    this.cashReturnItems = selling.items
      .filter((item) => !!item.productId && Number(item.quantity) > 0)
      .map((item) => ({
        productId: item.productId,
        productName: item.productName,
        productCode: item.productCode,
        availableQuantity: Math.max(0, Math.floor(Number(item.quantity) || 0) - Math.floor(Number(item.returnedQuantity) || 0)),
        quantity: 0,
        returnReason: ''
      }));
    this.returnDialogVisible = true;
  }

  closeReturnDialog(): void {
    if (this.isReturningSelectedSelling) return;
    this.returnDialogVisible = false;
    this.selectedSellingToReturn = null;
    this.cashReturnItems = [];
    this.returnError = '';
  }

  fillCashReturnWithAllItems(): void {
    this.cashReturnItems.forEach((item) => item.quantity = item.availableQuantity);
  }

  clearCashReturnQuantities(): void {
    this.cashReturnItems.forEach((item) => item.quantity = 0);
  }

  hasCashReturnSelection(): boolean {
    return this.cashReturnItems.some((item) => Number(item.quantity) > 0);
  }

  createCashReturn(): void {
    const selling = this.selectedSellingToReturn;
    const returnDate = this.formatDateParam(this.cashReturnDate);
    if (!selling?.id || !returnDate || !this.hasCashReturnSelection() || this.lock.isLocked(this.cashReturnDate)) return;

    const items = this.cashReturnItems
      .map((item) => ({
        productId: item.productId,
        quantity: Math.min(item.availableQuantity, Math.max(0, Math.floor(Number(item.quantity) || 0))),
        ...(item.returnReason.trim() ? { returnReason: item.returnReason.trim() } : {})
      }))
      .filter((item) => item.quantity > 0);

    this.returningSellingId = selling.id;
    this.returnError = '';
    this._returnsService.createReturn({
      returnType: 'cash',
      invoiceId: selling.id,
      returnDate,
      ...(this.cashReturnNote.trim() ? { note: this.cashReturnNote.trim() } : {}),
      ...(this.payment.boxId() ? { boxId: this.payment.boxId() } : {}),
      items
    }).subscribe({
      next: () => {
        this.lastReturnInvoiceId = selling.id;
        this.returningSellingId = '';
        this.returnDialogVisible = false;
        this.selectedSellingToReturn = null;
        this.cashReturnItems = [];
        this.loadSellings(1, false);
      },
      error: (error: any) => {
        this.returningSellingId = '';
        this.returnError = error?.error?.message || this.translateKey('invoiceHistoryPage.messages.returnFailed');
        this._cdr.detectChanges();
      }
    });
  }

  isReturningSelling(sellingId: string): boolean {
    return this.returningSellingId === sellingId;
  }

  get isReturningSelectedSelling(): boolean {
    return this.isReturningSelling(this.selectedSellingToReturn?.id || '');
  }

  openDeleteDialog(selling: InvoiceHistoryRow): void {
    if (!selling?.id) {
      return;
    }

    this.selectedSellingToDelete = selling;
    this.cancelReason = '';
    this.deleteDialogVisible = true;
  }

  /** Amount handed back when a cash invoice is cancelled (net of returns already made). */
  get cashCancelRefundAmount(): number {
    const selling = this.selectedSellingToDelete;
    if (!selling) return 0;
    return Math.max(0, Number(selling.netTotal ?? Number(selling.totalPrice || 0) - Number(selling.refundedAmount || 0)));
  }

  closeDeleteDialog(): void {
    if (this.isDeletingSelectedSelling) {
      return;
    }

    this.deleteDialogVisible = false;
    this.selectedSellingToDelete = null;
  }

  deleteSelling(): void {
    const selling = this.selectedSellingToDelete;
    if (!selling?.id) {
      return;
    }

    const reason = this.cancelReason.trim();
    if (reason.length < 3) return;
    this.deletingSellingId = selling.id;
    this.loadError = '';
    this._productsService.cancelSelling(selling.id, reason, this.payment.boxId()).subscribe({
      next: () => {
        this.deletingSellingId = '';
        this.deleteDialogVisible = false;
        this.selectedSellingToDelete = null;
        this.cancelReason = '';
        this.loadSellings(this.pagination.page, false);
      },
      error: (err: any) => {
        this.deletingSellingId = '';
        this.deleteDialogVisible = false;
        this.selectedSellingToDelete = null;
        this.loadError = err?.error?.message || this.translateKey('invoiceHistoryPage.messages.deleteFailed');
        this._cdr.detectChanges();
      }
    });
  }

  isDeletingSelling(sellingId: string): boolean {
    return this.deletingSellingId === sellingId;
  }

  get isDeletingSelectedSelling(): boolean {
    return this.isDeletingSelling(this.selectedSellingToDelete?.id || '');
  }

  private sumInvoiceMetric(
    items: InvoiceHistoryRow['items'],
    field: 'quantity' | 'totalPrice'
  ): number {
    return items.reduce((total, item) => total + Number(item[field] || 0), 0);
  }

  private resolveInvoiceTotal(item: any, items: InvoiceHistoryRow['items']): number | null {
    const explicitTotal = this.toNumber(item.totalPrice ?? item.total);
    if (explicitTotal !== null) {
      return explicitTotal;
    }

    const subtotal = this.toNumber(item.subtotal) ?? this.sumInvoiceMetric(items, 'totalPrice');
    const discountAmount = this.resolveDiscountAmount(item, subtotal);
    const shippingFees = this.toNumber(item.shippingFees) ?? 0;

    return Number((Math.max(subtotal - discountAmount + shippingFees, 0)).toFixed(2));
  }

  private resolveDiscountAmount(item: any, subtotal: number): number {
    const explicitDiscountAmount = this.toNumber(item.discountAmount);
    if (explicitDiscountAmount !== null) {
      return Number((Math.min(Math.max(explicitDiscountAmount, 0), Math.max(subtotal, 0))).toFixed(2));
    }

    const discountPercentage = this.toNumber(item.discountPercentage) ?? 0;
    return Number(((subtotal * Math.min(Math.max(discountPercentage, 0), 100)) / 100).toFixed(2));
  }

  private resolveDiscountPercentage(item: any, subtotal: number): number | null {
    const explicitDiscountPercentage = this.toNumber(item.discountPercentage);
    if (explicitDiscountPercentage !== null) {
      return Number((Math.min(Math.max(explicitDiscountPercentage, 0), 100)).toFixed(2));
    }

    const explicitDiscountAmount = this.toNumber(item.discountAmount);
    if (explicitDiscountAmount === null || subtotal <= 0) {
      return null;
    }

    return Number((((Math.min(Math.max(explicitDiscountAmount, 0), subtotal) / subtotal) * 100)).toFixed(2));
  }

  private toNumber(value: any): number | null {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  private toPositiveInteger(value: any, fallback: number): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
  }

  private translateKey(key: string): string {
    return this._translate.instant(key);
  }
}
