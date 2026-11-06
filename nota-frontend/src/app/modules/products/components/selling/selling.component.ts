import { CommonModule, isPlatformBrowser } from '@angular/common';
import {
  ChangeDetectorRef,
  Component,
  DestroyRef,
  ElementRef,
  HostListener,
  Inject,
  inject,
  OnDestroy,
  OnInit,
  PLATFORM_ID,
  ViewEncapsulation,
  ViewChild
} from '@angular/core';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { CatalogStateService } from '../../../layout/nav/catalog-state.service';
import { CateoryService } from '../../../category/services/cateory.service';
import { AuthService } from '../../../../core/auth/auth.service';
import { CartRescueService } from '../../../../core/auth/cart-rescue.service';
import { isOverDiscountLimit } from '../../../../core/auth/discount-limit';
import { ToastService } from '../../../../core/auth/toast.service';
import { UnsavedWorkService } from '../../../../core/unsaved-work/unsaved-work.service';
import {
  NotaButtonDirective,
  NotaDialogShellComponent,
  NotaFormFieldComponent,
  NotaMoneyPipe,
  NotaNumberPipe,
  NotaPageHeaderComponent
} from '../../../shared/ui';
import {
  FormArray,
  FormBuilder,
  FormGroup,
  FormsModule,
  ReactiveFormsModule,
  Validators
} from '@angular/forms';
import { SelectModule } from 'primeng/select';
import { DatePickerModule } from 'primeng/datepicker';
import { InputNumberModule } from 'primeng/inputnumber';
import { Dialog } from 'primeng/dialog';
import { Subscription } from 'rxjs';
import { ProductsService } from '../../services/products.service';
import { format as formatDate } from 'date-fns';
import { CustomersService } from '../../../customer/services/customers.service';
import { NotaCanDirective } from '../../../../core/auth/nota-can.directive';
import { PaymentBoxSelectComponent } from '../../../cashbox/payment-box-select.component';
import { PaymentBoxService } from '../../../cashbox/payment-box.service';
import { LockedActionComponent } from '../../../../core/auth/locked-action.component';

type PriceType = 'wholesalePrice' | 'retailPrice' | 'custom';

type ProductSearchResult = {
  id: string;
  name: string;
  code: string;
  displayLabel: string;
  categoryName: string;
  wholesalePrice: number | null;
  retailPrice: number | null;
  discountPercentage: number | null;
  priceAfterDiscount: number | null;
  /** Display only (POS tiles). */
  inventoryCount: number | null;
};

/** POS tiles: stock at or below this shows in the danger color. */
export const POS_LOW_STOCK = 3;

type CustomerSearchResult = {
  id: string;
  name: string;
  phone: string;
  displayLabel: string;
};

type SellingPayload = {
  customerName: string;
  customerPhone?: string;
  sellingDate: string;
  discountAmount: number;
  discountPercentage: number;
  shippingFees: number;
  confirmInsufficientInventory: boolean;
  /** Stage 19: only when the user chose a box other than the default. */
  boxId?: string;
  items: Array<{
    productId: string;
    quantity: number;
    price: number;
  }>;
};

/** Stage 15: an open invoice kept in memory when the session expires (CartRescueService). */
export type PosSnapshot = {
  customerName: string;
  customerPhone: string;
  customerSearch: string;
  discountAmount: number;
  shippingFees: number;
  lines: Array<{ product: ProductSearchResult; priceType: PriceType; price: number | null; quantity: number }>;
};

type InventoryShortage = {
  productId: string;
  productName: string;
  requestedQuantity: number;
  availableQuantity: number;
  missingQuantity: number;
};

type InvoiceItemState = {
  id: string;
  searchInputValue: string;
  showSuggestionPanel: boolean;
  productOptions: ProductSearchResult[];
  isSearching: boolean;
  searchError: string;
  latestRequestedQuery: string;
  selectedProductOption: ProductSearchResult | null;
  selectedProduct: ProductSearchResult | null;
  searchBlurTimer: ReturnType<typeof setTimeout> | null;
};

@Component({
  selector: 'app-selling',
  standalone: true,
  imports: [LockedActionComponent, NotaCanDirective, PaymentBoxSelectComponent,
    CommonModule,
    FormsModule,
    ReactiveFormsModule,
    TranslatePipe,
    SelectModule,
    DatePickerModule,
    InputNumberModule,
    Dialog,
    NotaButtonDirective,
    NotaDialogShellComponent,
    NotaFormFieldComponent,
    NotaMoneyPipe,
    NotaNumberPipe,
    NotaPageHeaderComponent
  ],
  templateUrl: './selling.component.html',
  styleUrls: ['./selling.component.scss', './selling-invoice.scss'],
  // Classes are prefixed (pos__*), so the styles are not scoped; keeps the stylesheet within budget.
  encapsulation: ViewEncapsulation.None
})
export class SellingComponent implements OnInit, OnDestroy {
  private isBrowser: boolean;
  /** Category chips: the list the sidebar already loads (no extra request). */
  readonly categories = inject(CatalogStateService).categories;
  private readonly _cateoryService = inject(CateoryService);
  private readonly _auth = inject(AuthService);
  /** Stage 19: "طريقة الدفع" — the box this sale goes into. */
  readonly payment = inject(PaymentBoxService);
  private readonly _unsaved = inject(UnsavedWorkService);
  private readonly _cartRescue = inject(CartRescueService);
  private readonly _toast = inject(ToastService);
  /** Stage 15: "أقصى خصم: X٪" for this user, or null (no limit). */
  readonly maxDiscountPercent = this._auth.maxDiscountPercent;
  @ViewChild('posSearch') private posSearch?: ElementRef<HTMLInputElement>;
  /** POS product grid (frontend only): fed by GET products/search or GET products?categoryId. */
  gridQuery = '';
  gridProducts: ProductSearchResult[] = [];
  isGridLoading = false;
  gridError = '';
  activeCategoryId: string | null = null;
  private gridRequest = 0;
  readonly lowStock = POS_LOW_STOCK;
  private readonly subscriptions = new Subscription();
  private customerSearchBlurTimer: ReturnType<typeof setTimeout> | null = null;
  private invoiceItemSubscriptions = new Map<FormGroup, Subscription[]>();
  private invoiceItemSequence = 0;
  customerSearchInputValue = '';
  showCustomerSuggestionPanel = false;
  customerOptions: CustomerSearchResult[] = [];
  selectedCustomerOption: CustomerSearchResult | null = null;
  sellingForm: FormGroup;
  invoiceItemStates: InvoiceItemState[] = [];
  isSearchingCustomers = false;
  isSaving = false;
  successDialogVisible = false;
  errorDialogVisible = false;
  inventoryConfirmationVisible = false;
  inventoryShortages: InventoryShortage[] = [];
  customerSearchError = '';
  saveError = '';
  private pendingSellingPayload: SellingPayload | null = null;
  private latestRequestedCustomerQuery = '';

  priceTypeOptions = [
    { label: '', value: 'wholesalePrice' },
    { label: '', value: 'retailPrice' },
    { label: '', value: 'custom' }
  ];

  constructor(
    private _fb: FormBuilder,
    private _productsService: ProductsService,
    private _customersService: CustomersService,
    private _translate: TranslateService,
    private _cdr: ChangeDetectorRef,
    @Inject(PLATFORM_ID) platformId: Object
  ) {
    this.isBrowser = isPlatformBrowser(platformId);
    this.sellingForm = this.initializeForm();
    this.addInvoiceItem(false);
    // Stage 15: an open cart counts as unsaved work, and is kept if the session expires.
    const destroyRef = inject(DestroyRef);
    destroyRef.onDestroy(this._unsaved.register('pos', () => this.hasOpenCart()));
    destroyRef.onDestroy(this._cartRescue.register(() => (this.hasOpenCart() ? this.snapshot() : null)));
  }

  /** Stage 15: at least one product on the invoice. */
  hasOpenCart(): boolean {
    return this.invoiceItemStates.some((state) => Boolean(state.selectedProduct));
  }

  /** Stage 15: the discount is above this user's limit; saving is blocked (the backend also refuses it). */
  get discountOverLimit(): boolean {
    return isOverDiscountLimit(this.invoiceDiscountAmount, this.invoiceSubtotal, this.maxDiscountPercent());
  }

  /** Stage 15: what CartRescueService keeps. */
  snapshot(): PosSnapshot {
    const raw = this.sellingForm.getRawValue();
    return {
      customerName: String(raw.customerName || ''),
      customerPhone: String(raw.customerPhone || ''),
      customerSearch: this.customerSearchInputValue,
      discountAmount: this.invoiceDiscountAmount,
      shippingFees: this.toNonNegativeNumber(raw.shippingFees),
      lines: this.invoiceItemStates
        .map((state, index) => ({ state, raw: this.getInvoiceItem(index).getRawValue() }))
        .filter(({ state }) => Boolean(state.selectedProduct))
        .map(({ state, raw: line }) => ({
          product: state.selectedProduct as ProductSearchResult,
          priceType: line.priceType as PriceType,
          price: line.price === null || line.price === undefined ? null : Number(line.price),
          quantity: Number(line.quantity) || 1,
        })),
    };
  }

  /** Stage 15: puts a kept invoice back (same user signed in again after the session expired). */
  restoreSnapshot(saved: PosSnapshot): void {
    this.resetSellingForm();
    for (const line of saved.lines) {
      this.addProductToInvoice(line.product);
      const index = this.invoiceItemStates.findIndex((state) => state.selectedProduct?.id === line.product.id);
      if (index < 0) continue;
      const group = this.getInvoiceItem(index);
      group.get('priceType')?.setValue(line.priceType);
      if (line.priceType === 'custom') group.get('price')?.setValue(line.price);
      group.get('quantity')?.setValue(line.quantity);
    }
    this.customerSearchInputValue = saved.customerSearch;
    this.sellingForm.patchValue({
      customerName: saved.customerName,
      customerPhone: saved.customerPhone,
      discountAmount: saved.discountAmount,
      shippingFees: saved.shippingFees,
    });
    this.updateInvoiceTotals();
  }

  ngOnInit(): void {
    // Stage 15: the invoice that was open when the session expired, for the same user only.
    const saved = this._cartRescue.take<PosSnapshot>(this._auth.user()?._id);
    if (saved) {
      this.restoreSnapshot(saved);
      this._toast.show(this.translateKey('session.cartRestored'), 'success');
    }
    this.setPriceTypeOptions();
    this.subscriptions.add(
      this._translate.onLangChange.subscribe(() => {
        this.setPriceTypeOptions();
      })
    );
    this.subscriptions.add(
      this.sellingForm.get('discountAmount')!.valueChanges.subscribe(() => this.updateInvoiceTotals())
    );
    this.subscriptions.add(
      this.sellingForm.get('shippingFees')!.valueChanges.subscribe(() => this.updateInvoiceTotals())
    );
  }

  ngOnDestroy(): void {
    this.subscriptions.unsubscribe();

    if (this.customerSearchBlurTimer) {
      clearTimeout(this.customerSearchBlurTimer);
      this.customerSearchBlurTimer = null;
    }

    this.invoiceItemStates.forEach((state) => {
      if (state.searchBlurTimer) {
        clearTimeout(state.searchBlurTimer);
        state.searchBlurTimer = null;
      }
    });

    this.invoiceItemSubscriptions.forEach((subscriptions) => {
      subscriptions.forEach((subscription) => subscription.unsubscribe());
    });
    this.invoiceItemSubscriptions.clear();
  }

  get invoiceItems(): FormArray {
    return this.sellingForm.get('items') as FormArray;
  }

  get invoiceGrandTotal(): number {
    return Number(this.sellingForm.get('totalInvoicePrice')?.value || 0);
  }

  get invoiceSubtotal(): number {
    return this.calculateItemsSubtotal();
  }

  get invoiceDiscountAmount(): number {
    return this.toDiscountAmount(this.sellingForm.get('discountAmount')?.value, this.invoiceSubtotal);
  }

  get discountPercentageInfo(): number {
    return this.calculateDiscountPercentage(this.invoiceSubtotal, this.invoiceDiscountAmount);
  }

  get shippingFeesValue(): number {
    return this.toNonNegativeNumber(this.sellingForm.get('shippingFees')?.value);
  }

  get invoiceQuantityTotal(): number {
    return this.invoiceItems.controls.reduce((total, control) => {
      const quantity = Number((control as FormGroup).get('quantity')?.value || 0);
      return total + (Number.isFinite(quantity) ? quantity : 0);
    }, 0);
  }

  // ---------- POS grid, chips, shortcuts (Stage 9, frontend only) ----------

  /** F2 = focus the product search, F9 = save (same as the save button). */
  @HostListener('document:keydown', ['$event'])
  onShortcut(event: KeyboardEvent): void {
    if (event.key === 'F2') {
      event.preventDefault();
      this.focusSearch();
    } else if (event.key === 'F9') {
      event.preventDefault();
      if (this.isSaving || this.successDialogVisible || this.errorDialogVisible || this.inventoryConfirmationVisible) return;
      this.saveSelling();
    }
  }

  focusSearch(): void {
    const input = this.posSearch?.nativeElement;
    input?.focus();
    input?.select();
  }

  /** Top search box: same request as the line search (GET products/search?q=). */
  onGridSearchInput(event: Event): void {
    this.gridQuery = String((event.target as HTMLInputElement)?.value || '');
    this.activeCategoryId = null;
    this.loadGrid();
  }

  /** null = "All" (search results). */
  selectCategory(categoryId: string | null): void {
    this.activeCategoryId = categoryId;
    this.loadGrid();
  }

  private loadGrid(): void {
    const request = ++this.gridRequest;
    const query = this.gridQuery.trim();
    this.gridError = '';

    if (!this.activeCategoryId && !query) {
      this.gridProducts = [];
      this.isGridLoading = false;
      return;
    }

    this.isGridLoading = true;
    const source = this.activeCategoryId
      ? this._cateoryService.getProducts(this.activeCategoryId, { categoryId: this.activeCategoryId, limit: 100 })
      : this._productsService.searchProducts(query);

    source.subscribe({
      next: (response: any) => {
        if (request !== this.gridRequest) return;
        this.isGridLoading = false;
        this.gridProducts = this.extractProducts(response);
        if (!this.gridProducts.length) {
          this.gridError = this.translateKey('sellingPage.messages.noProductFound');
        }
        this._cdr.detectChanges();
      },
      error: (err: any) => {
        if (request !== this.gridRequest) return;
        this.isGridLoading = false;
        this.gridProducts = [];
        this.gridError = err?.error?.message || this.translateKey('sellingPage.messages.searchFailed');
        this._cdr.detectChanges();
      }
    });
  }

  isLowStock(product: ProductSearchResult): boolean {
    return product.inventoryCount !== null && product.inventoryCount <= POS_LOW_STOCK;
  }

  /** Tile click: +1 on the line that already has this product, else fill the first empty line (or a new one). */
  addProductToInvoice(product: ProductSearchResult): void {
    const existing = this.invoiceItemStates.findIndex((state) => state.selectedProduct?.id === product.id);
    if (existing > -1) {
      this.stepQuantity(existing, 1);
      return;
    }

    let index = this.invoiceItemStates.findIndex((state) => !state.selectedProduct);
    if (index === -1) {
      this.addInvoiceItem(false);
      index = this.invoiceItems.length - 1;
    }
    this.onNativeOptionSelect(index, product);
  }

  /** − / + next to the quantity; never below the existing minimum of 1. */
  stepQuantity(index: number, delta: number): void {
    const control = this.getInvoiceItem(index).get('quantity');
    if (!control) return;
    const current = Number(control.value || 0);
    const next = (Number.isFinite(current) ? current : 0) + delta;
    if (next < 1) return;
    control.setValue(next);
    control.markAsDirty();
  }

  /** "Change product" on a line: same as clearing its search box (keeps quantity and price type). */
  changeLineProduct(index: number): void {
    this.onSearchInputChange(index, { target: { value: '' } } as unknown as Event);
  }

  /** "Cancel / clear" button: the reset that runs after a successful save. */
  clearInvoice(): void {
    if (this.isSaving) return;
    this.resetSellingForm();
  }

  trackInvoiceItem(index: number): string {
    return this.invoiceItemStates[index]?.id || String(index);
  }

  getInvoiceItem(index: number): FormGroup {
    return this.invoiceItems.at(index) as FormGroup;
  }

  getInvoiceItemState(index: number): InvoiceItemState {
    return this.invoiceItemStates[index];
  }

  isCustomPrice(index: number): boolean {
    return this.getInvoiceItem(index).get('priceType')?.value === 'custom';
  }

  addInvoiceItem(emitChanges = true): void {
    const itemGroup = this.createInvoiceItemGroup();
    this.invoiceItems.push(itemGroup);
    this.invoiceItemStates.push(this.createInvoiceItemState());
    this.registerInvoiceItemSubscriptions(itemGroup);
    this.applyPriceTypeToItem(itemGroup, itemGroup.get('priceType')?.value as PriceType);
    this.updateInvoiceTotals();

    if (emitChanges) {
      this._cdr.detectChanges();
    }
  }

  removeInvoiceItem(index: number): void {
    if (this.invoiceItems.length === 1) {
      this.resetInvoiceItem(index);
      return;
    }

    const itemGroup = this.getInvoiceItem(index);
    const itemState = this.getInvoiceItemState(index);
    this.teardownInvoiceItem(itemGroup, itemState);
    this.invoiceItems.removeAt(index);
    this.invoiceItemStates.splice(index, 1);
    this.updateInvoiceTotals();
    this._cdr.detectChanges();
  }

  onSearchInputChange(index: number, event: Event): void {
    const itemGroup = this.getInvoiceItem(index);
    const itemState = this.getInvoiceItemState(index);
    const value = String((event.target as HTMLInputElement)?.value || '');
    const query = value.trim();

    itemState.searchError = '';
    itemState.searchInputValue = value;

    if (!query) {
      itemState.productOptions = [];
      itemState.isSearching = false;
      itemState.latestRequestedQuery = '';
      itemState.showSuggestionPanel = false;
      itemState.selectedProductOption = null;
      this.onProductSelectionChange(itemGroup, itemState, null);
      return;
    }

    if (itemState.selectedProduct && query !== itemState.selectedProduct.displayLabel) {
      itemState.selectedProductOption = null;
      this.onProductSelectionChange(itemGroup, itemState, null);
    }

    this.fetchProductOptions(itemGroup, itemState, query);
  }

  onSearchInputFocus(index: number): void {
    const itemState = this.getInvoiceItemState(index);

    if (itemState.searchBlurTimer) {
      clearTimeout(itemState.searchBlurTimer);
      itemState.searchBlurTimer = null;
    }

    if (itemState.productOptions.length > 0 || itemState.isSearching) {
      itemState.showSuggestionPanel = true;
    }
  }

  onSearchInputBlur(index: number): void {
    const itemState = this.getInvoiceItemState(index);
    itemState.searchBlurTimer = setTimeout(() => {
      itemState.showSuggestionPanel = false;
      this._cdr.detectChanges();
    }, 180);
  }

  onNativeOptionSelect(index: number, product: ProductSearchResult): void {
    const itemGroup = this.getInvoiceItem(index);
    const itemState = this.getInvoiceItemState(index);

    if (itemState.searchBlurTimer) {
      clearTimeout(itemState.searchBlurTimer);
      itemState.searchBlurTimer = null;
    }

    itemState.selectedProductOption = product;
    itemState.searchInputValue = product.displayLabel;
    itemState.showSuggestionPanel = false;
    this.onProductSelectionChange(itemGroup, itemState, product);
  }

  onCustomerSearchInputChange(event: Event): void {
    const value = String((event.target as HTMLInputElement)?.value || '');
    const query = value.trim();

    this.customerSearchError = '';
    this.customerSearchInputValue = value;

    if (!query) {
      this.customerOptions = [];
      this.isSearchingCustomers = false;
      this.latestRequestedCustomerQuery = '';
      this.showCustomerSuggestionPanel = false;
      this.selectedCustomerOption = null;
      return;
    }

    if (this.selectedCustomerOption && query !== this.selectedCustomerOption.displayLabel) {
      this.selectedCustomerOption = null;
    }

    this.fetchCustomerOptions(query);
  }

  onCustomerSearchInputFocus(): void {
    if (this.customerSearchBlurTimer) {
      clearTimeout(this.customerSearchBlurTimer);
      this.customerSearchBlurTimer = null;
    }

    if (this.customerOptions.length > 0 || this.isSearchingCustomers) {
      this.showCustomerSuggestionPanel = true;
    }
  }

  onCustomerSearchInputBlur(): void {
    this.customerSearchBlurTimer = setTimeout(() => {
      this.showCustomerSuggestionPanel = false;
      this._cdr.detectChanges();
    }, 180);
  }

  onCustomerOptionSelect(customer: CustomerSearchResult): void {
    if (this.customerSearchBlurTimer) {
      clearTimeout(this.customerSearchBlurTimer);
      this.customerSearchBlurTimer = null;
    }

    this.selectedCustomerOption = customer;
    this.customerSearchInputValue = customer.displayLabel;
    this.showCustomerSuggestionPanel = false;
    this.customerSearchError = '';
    this.sellingForm.patchValue({
      customerName: customer.name,
      customerPhone: customer.phone
    });
  }

  saveSelling(): void {
    this.errorDialogVisible = false;
    this.inventoryConfirmationVisible = false;
    this.saveError = '';

    if (this.sellingForm.invalid || !this.invoiceItems.length) {
      this.sellingForm.markAllAsTouched();
      return;
    }
    // Stage 15: blocked before sending (the hint under the discount says why).
    if (this.discountOverLimit) return;

    const raw = this.sellingForm.getRawValue();
    const sellingDate = this.formatSellingDate(raw.sellingDate);
    const items = Array.isArray(raw.items) ? raw.items : [];

    if (!items.length) {
      return;
    }

    const discountAmount = this.invoiceDiscountAmount;
    const payload: SellingPayload = {
      customerName: String(raw.customerName || '').trim(),
      customerPhone: String(raw.customerPhone || '').trim(),
      sellingDate,
      discountAmount,
      discountPercentage: this.discountPercentageInfo,
      shippingFees: this.toNonNegativeNumber(raw.shippingFees),
      confirmInsufficientInventory: false,
      items: items.map((item: any) => ({
        productId: String(item.productId || ''),
        quantity: Number(item.quantity),
        price: Number(item.price)
      }))
    };

    this.submitSelling(this.payment.withBox(payload));
  }

  confirmInsufficientInventory(): void {
    if (!this.pendingSellingPayload || this.isSaving) return;

    this.inventoryConfirmationVisible = false;
    this.submitSelling({
      ...this.pendingSellingPayload,
      confirmInsufficientInventory: true
    });
  }

  cancelInsufficientInventory(): void {
    this.inventoryConfirmationVisible = false;
    this.inventoryShortages = [];
    this.pendingSellingPayload = null;
  }

  private submitSelling(payload: SellingPayload): void {
    this.isSaving = true;

    this._productsService.createSelling(payload).subscribe({
      next: () => {
        this.isSaving = false;
        this.pendingSellingPayload = null;
        this.inventoryShortages = [];
        this.successDialogVisible = true;
        this.resetSellingForm();
        this._cdr.detectChanges();
      },
      error: (err: any) => {
        this.isSaving = false;

        if (this.isInsufficientInventoryError(err)) {
          this.pendingSellingPayload = payload;
          this.inventoryShortages = this.mapInventoryShortages(err.error?.shortages);
          this.inventoryConfirmationVisible = true;
          this._cdr.detectChanges();
          return;
        }

        this.saveError = err?.error?.message || this.translateKey('sellingPage.messages.createFailed');
        this.errorDialogVisible = true;
        this._cdr.detectChanges();
      }
    });
  }

  private isInsufficientInventoryError(err: any): boolean {
    return err?.status === 409 &&
      err?.error?.code === 'INSUFFICIENT_INVENTORY' &&
      err?.error?.requiresConfirmation === true &&
      Array.isArray(err?.error?.shortages) &&
      err.error.shortages.length > 0;
  }

  private mapInventoryShortages(shortages: any[]): InventoryShortage[] {
    return shortages.map((shortage) => {
      const productId = String(shortage?.productId?._id || shortage?.productId || '');
      const selectedProduct = this.invoiceItemStates.find(
        (state) => state.selectedProduct?.id === productId
      )?.selectedProduct;

      return {
        productId,
        productName: String(
          shortage?.productName || shortage?.name || shortage?.productId?.name ||
          selectedProduct?.name || productId
        ),
        requestedQuantity: Number(shortage?.requestedQuantity || 0),
        availableQuantity: Number(shortage?.availableQuantity || 0),
        missingQuantity: Number(shortage?.missingQuantity || 0)
      };
    });
  }

  closeSuccessPopup(): void {
    this.successDialogVisible = false;
  }

  closeErrorPopup(): void {
    this.errorDialogVisible = false;
  }

  private fetchProductOptions(
    itemGroup: FormGroup,
    itemState: InvoiceItemState,
    query: string
  ): void {
    itemState.latestRequestedQuery = query;
    itemState.isSearching = true;
    itemState.searchError = '';
    this.saveError = '';

    this._productsService.searchProducts(query).subscribe({
      next: (response: any) => {
        if (
          query !== itemState.latestRequestedQuery ||
          !this.invoiceItems.controls.includes(itemGroup)
        ) {
          return;
        }

        itemState.isSearching = false;
        itemState.productOptions = this.extractProducts(response);
        itemState.showSuggestionPanel =
          itemState.productOptions.length > 0 && itemState.searchInputValue.trim().length > 0;

        if (!itemState.productOptions.length) {
          itemState.searchError = this.translateKey('sellingPage.messages.noProductFound');
        }

        if (itemState.selectedProduct) {
          const stillAvailable = itemState.productOptions.some(
            (product) => product.id === itemState.selectedProduct?.id
          );

          if (!stillAvailable) {
            itemState.selectedProductOption = null;
            this.onProductSelectionChange(itemGroup, itemState, null);
          }
        }

        this._cdr.detectChanges();
      },
      error: (err: any) => {
        if (
          query !== itemState.latestRequestedQuery ||
          !this.invoiceItems.controls.includes(itemGroup)
        ) {
          return;
        }

        itemState.isSearching = false;
        itemState.selectedProduct = null;
        itemState.selectedProductOption = null;
        itemState.productOptions = [];
        itemState.showSuggestionPanel = false;
        this.clearProductDataForItem(itemGroup);
        itemState.searchError =
          err?.error?.message || this.translateKey('sellingPage.messages.searchFailed');
        this._cdr.detectChanges();
      }
    });
  }

  private fetchCustomerOptions(query: string): void {
    this.latestRequestedCustomerQuery = query;
    this.isSearchingCustomers = true;
    this.customerSearchError = '';

    this._customersService.getCustomers({ search: query }).subscribe({
      next: (response: any) => {
        if (query !== this.latestRequestedCustomerQuery) {
          return;
        }

        this.isSearchingCustomers = false;
        this.customerOptions = this.extractCustomerOptions(response);
        this.showCustomerSuggestionPanel =
          this.customerOptions.length > 0 && this.customerSearchInputValue.trim().length > 0;

        if (!this.customerOptions.length) {
          this.customerSearchError = this.translateKey('sellingPage.messages.noCustomerFound');
        }

        this._cdr.detectChanges();
      },
      error: (err: any) => {
        if (query !== this.latestRequestedCustomerQuery) {
          return;
        }

        this.isSearchingCustomers = false;
        this.selectedCustomerOption = null;
        this.customerOptions = [];
        this.showCustomerSuggestionPanel = false;
        this.customerSearchError =
          err?.error?.message || this.translateKey('sellingPage.messages.customerSearchFailed');
        this._cdr.detectChanges();
      }
    });
  }

  private onProductSelectionChange(
    itemGroup: FormGroup,
    itemState: InvoiceItemState,
    product: ProductSearchResult | null
  ): void {
    itemState.searchError = '';

    if (!product) {
      itemState.selectedProduct = null;
      this.clearProductDataForItem(itemGroup);
      return;
    }

    itemState.selectedProduct = product;
    itemGroup.patchValue({
      productId: product.id,
      productName: product.name,
      categoryName: product.categoryName
    });

    this.applyPriceTypeToItem(itemGroup, itemGroup.get('priceType')?.value as PriceType);
  }

  private setPriceTypeOptions(): void {
    this.priceTypeOptions = [
      {
        label: this.translateKey('sellingPage.priceTypeOptions.wholesalePrice'),
        value: 'wholesalePrice'
      },
      {
        label: this.translateKey('sellingPage.priceTypeOptions.retailPrice'),
        value: 'retailPrice'
      },
      {
        label: this.translateKey('sellingPage.priceTypeOptions.custom'),
        value: 'custom'
      }
    ];
  }

  private translateKey(key: string): string {
    return this._translate.instant(key);
  }

  private initializeForm(): FormGroup {
    return this._fb.group({
      customerName: ['', Validators.required],
      customerPhone: [''],
      sellingDate: [this.getTodayDate(), Validators.required],
      discountAmount: [0, [Validators.min(0)]],
      shippingFees: [0, [Validators.min(0)]],
      totalInvoicePrice: [{ value: 0, disabled: true }],
      items: this._fb.array([])
    });
  }

  private createInvoiceItemGroup(): FormGroup {
    return this._fb.group({
      productId: [null, Validators.required],
      productName: [{ value: '', disabled: true }],
      categoryName: [{ value: '', disabled: true }],
      priceType: ['wholesalePrice', Validators.required],
      price: [{ value: null, disabled: true }, [Validators.required, Validators.min(0.01)]],
      quantity: [1, [Validators.required, Validators.min(1)]],
      lineTotal: [{ value: 0, disabled: true }]
    });
  }

  private createInvoiceItemState(): InvoiceItemState {
    this.invoiceItemSequence += 1;

    return {
      id: `invoice-item-${this.invoiceItemSequence}`,
      searchInputValue: '',
      showSuggestionPanel: false,
      productOptions: [],
      isSearching: false,
      searchError: '',
      latestRequestedQuery: '',
      selectedProductOption: null,
      selectedProduct: null,
      searchBlurTimer: null
    };
  }

  private registerInvoiceItemSubscriptions(itemGroup: FormGroup): void {
    const subscriptions = [
      itemGroup
        .get('priceType')!
        .valueChanges.subscribe((value) => this.applyPriceTypeToItem(itemGroup, value as PriceType)),
      itemGroup.get('price')!.valueChanges.subscribe(() => this.updateInvoiceItemTotal(itemGroup)),
      itemGroup
        .get('quantity')!
        .valueChanges.subscribe(() => this.updateInvoiceItemTotal(itemGroup))
    ];

    this.invoiceItemSubscriptions.set(itemGroup, subscriptions);
  }

  private teardownInvoiceItem(itemGroup: FormGroup, itemState: InvoiceItemState): void {
    this.invoiceItemSubscriptions.get(itemGroup)?.forEach((subscription) => subscription.unsubscribe());
    this.invoiceItemSubscriptions.delete(itemGroup);

    if (itemState.searchBlurTimer) {
      clearTimeout(itemState.searchBlurTimer);
      itemState.searchBlurTimer = null;
    }
  }

  private applyPriceTypeToItem(itemGroup: FormGroup, priceType: PriceType): void {
    const priceControl = itemGroup.get('price');
    if (!priceControl) return;

    const itemIndex = this.invoiceItems.controls.indexOf(itemGroup);
    const selectedProduct =
      itemIndex > -1 ? this.invoiceItemStates[itemIndex]?.selectedProduct ?? null : null;

    if (priceType === 'custom') {
      priceControl.enable({ emitEvent: false });
      this.updateInvoiceItemTotal(itemGroup);
      return;
    }

    // A product without the chosen price falls back to the other one (retail ↔ wholesale), like the credit form;
    // it never becomes 0.
    const otherPriceType: PriceType = priceType === 'retailPrice' ? 'wholesalePrice' : 'retailPrice';
    const selectedPrice = selectedProduct?.[priceType] ?? selectedProduct?.[otherPriceType] ?? null;
    priceControl.setValue(selectedPrice, { emitEvent: false });
    priceControl.disable({ emitEvent: false });
    this.updateInvoiceItemTotal(itemGroup);
  }

  private updateInvoiceItemTotal(itemGroup: FormGroup): void {
    const raw = itemGroup.getRawValue();
    const price = Number(raw.price || 0);
    const quantity = Number(raw.quantity || 0);
    const total = Number.isFinite(price * quantity) ? price * quantity : 0;

    itemGroup.get('lineTotal')?.setValue(total, { emitEvent: false });
    this.updateInvoiceTotals();
  }

  private updateInvoiceTotals(): void {
    const subtotal = this.calculateItemsSubtotal();
    const discountAmount = this.normalizeDiscountAmountControl(subtotal);
    const shippingFees = this.shippingFeesValue;
    const total = this.roundCurrency(Math.max(subtotal - discountAmount + shippingFees, 0));
    this.sellingForm.get('totalInvoicePrice')?.setValue(total, { emitEvent: false });
  }

  private formatSellingDate(value: Date | string): string {
    if (value instanceof Date) {
      return formatDate(value, 'yyyy-MM-dd');
    }

    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return formatDate(parsed, 'yyyy-MM-dd');
    }

    return String(value);
  }

  private clearProductDataForItem(itemGroup: FormGroup): void {
    itemGroup.patchValue({
      productId: null,
      productName: '',
      categoryName: '',
      price: null,
      lineTotal: 0
    });
  }

  private resetInvoiceItem(index: number): void {
    const itemGroup = this.getInvoiceItem(index);
    const itemState = this.getInvoiceItemState(index);

    itemState.searchInputValue = '';
    itemState.showSuggestionPanel = false;
    itemState.productOptions = [];
    itemState.isSearching = false;
    itemState.searchError = '';
    itemState.latestRequestedQuery = '';
    itemState.selectedProductOption = null;
    itemState.selectedProduct = null;

    if (itemState.searchBlurTimer) {
      clearTimeout(itemState.searchBlurTimer);
      itemState.searchBlurTimer = null;
    }

    itemGroup.reset({
      productId: null,
      productName: '',
      categoryName: '',
      priceType: 'wholesalePrice',
      price: null,
      quantity: 1,
      lineTotal: 0
    });

    this.applyPriceTypeToItem(itemGroup, 'wholesalePrice');
    this.updateInvoiceTotals();
  }

  private resetSellingForm(): void {
    this.customerSearchInputValue = '';
    this.customerOptions = [];
    this.selectedCustomerOption = null;
    this.showCustomerSuggestionPanel = false;
    this.latestRequestedCustomerQuery = '';
    this.customerSearchError = '';
    this.saveError = '';

    while (this.invoiceItems.length > 0) {
      const itemGroup = this.getInvoiceItem(0);
      const itemState = this.getInvoiceItemState(0);
      this.teardownInvoiceItem(itemGroup, itemState);
      this.invoiceItems.removeAt(0);
      this.invoiceItemStates.splice(0, 1);
    }

    this.sellingForm.reset({
      customerName: '',
      customerPhone: '',
      sellingDate: this.getTodayDate(),
      discountAmount: 0,
      shippingFees: 0,
      totalInvoicePrice: 0
    });

    this.addInvoiceItem(false);
    this.updateInvoiceTotals();
  }

  private getTodayDate(): Date {
    return new Date();
  }

  private extractProducts(response: any): ProductSearchResult[] {
    let list: any[] = [];

    if (Array.isArray(response)) {
      list = response;
    } else if (Array.isArray(response?.data)) {
      list = response.data;
    } else if (Array.isArray(response?.products)) {
      list = response.products;
    } else if (response?.data && typeof response.data === 'object') {
      list = [response.data];
    } else if (response && typeof response === 'object') {
      list = [response];
    }

    return list
      .map((candidate) => this.mapProduct(candidate))
      .filter((item): item is ProductSearchResult => item !== null);
  }

  private extractCustomerOptions(response: any): CustomerSearchResult[] {
    let list: any[] = [];

    if (Array.isArray(response)) {
      list = response;
    } else if (Array.isArray(response?.data?.customers)) {
      list = response.data.customers;
    } else if (Array.isArray(response?.customers)) {
      list = response.customers;
    } else if (Array.isArray(response?.data)) {
      list = response.data;
    } else if (response?.data && typeof response.data === 'object') {
      list = [response.data];
    } else if (response && typeof response === 'object') {
      list = [response];
    }

    return list
      .map((candidate) => this.mapCustomer(candidate))
      .filter((item): item is CustomerSearchResult => item !== null);
  }

  private mapProduct(candidate: any): ProductSearchResult | null {
    if (!candidate) return null;

    const id = candidate._id || candidate.id || candidate.productId;
    if (!id) return null;

    const name = String(candidate.name || candidate.productName || '').trim();
    const code = String(candidate.code || candidate.productCode || '').trim();
    const categoryName = String(
      candidate.category?.name || candidate.categoryName || candidate.categoryId?.name || ''
    ).trim();

    const displayLabel = [name, code].filter(Boolean).join(' - ') || String(id);

    return {
      id: String(id),
      name,
      code,
      displayLabel,
      categoryName,
      // Stage 11: a missing price stays null (Number(null) would make it 0); see applyPriceTypeToItem.
      wholesalePrice: this.toPrice(candidate.wholesalePrice),
      retailPrice: this.toPrice(candidate.retailPrice),
      discountPercentage: this.toNumber(candidate.discountPercentage),
      priceAfterDiscount: this.toNumber(candidate.priceAfterDiscount),
      inventoryCount: candidate.inventoryCount === undefined || candidate.inventoryCount === null
        ? null
        : this.toNumber(candidate.inventoryCount)
    };
  }

  private mapCustomer(candidate: any): CustomerSearchResult | null {
    if (!candidate) return null;

    const id = candidate._id || candidate.id || candidate.customerId;
    if (!id) return null;

    const name = String(candidate.name || candidate.customerName || '').trim();
    const phone = String(candidate.phone || candidate.customerPhone || '').trim();
    const displayLabel = [name, phone].filter(Boolean).join(' - ') || String(id);

    return {
      id: String(id),
      name,
      phone,
      displayLabel
    };
  }

  private toNumber(value: any): number | null {
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
  }

  private toPrice(value: unknown): number | null {
    return value === null || value === undefined || value === '' ? null : this.toNumber(value);
  }

  private calculateItemsSubtotal(): number {
    return this.roundCurrency(this.invoiceItems.controls.reduce((sum, control) => {
      const raw = (control as FormGroup).getRawValue();
      const price = Number(raw.price || 0);
      const quantity = Number(raw.quantity || 0);
      const lineTotal = Number.isFinite(price * quantity) ? price * quantity : 0;
      return sum + lineTotal;
    }, 0));
  }

  private calculateDiscountAmount(subtotal: number, discountPercentage: number): number {
    return this.roundCurrency((subtotal * discountPercentage) / 100);
  }

  private calculateDiscountPercentage(subtotal: number, discountAmount: number): number {
    if (subtotal <= 0 || discountAmount <= 0) {
      return 0;
    }

    return this.roundCurrency(Math.min((discountAmount / subtotal) * 100, 100));
  }

  private toDiscountAmount(value: unknown, subtotal: number): number {
    return this.roundCurrency(Math.min(this.toNonNegativeNumber(value), Math.max(subtotal, 0)));
  }

  private normalizeDiscountAmountControl(subtotal: number): number {
    const discountAmountControl = this.sellingForm.get('discountAmount');
    const boundedValue = this.toDiscountAmount(discountAmountControl?.value, subtotal);

    if (discountAmountControl && discountAmountControl.value !== boundedValue) {
      discountAmountControl.setValue(boundedValue, { emitEvent: false });
    }

    return boundedValue;
  }

  private toNonNegativeNumber(value: unknown): number {
    const normalized = Number(value);
    if (!Number.isFinite(normalized) || normalized < 0) {
      return 0;
    }

    return normalized;
  }

  private toBoundedPercentage(value: unknown): number {
    return Math.min(100, this.toNonNegativeNumber(value));
  }

  private roundCurrency(value: number): number {
    return Number((value || 0).toFixed(2));
  }
}
