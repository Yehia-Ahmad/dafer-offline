import { CommonModule, isPlatformBrowser } from '@angular/common';
import {
  ChangeDetectorRef,
  Component,
  Inject,
  OnDestroy,
  OnInit,
  PLATFORM_ID
} from '@angular/core';
import { FormArray, FormBuilder, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { DatePickerModule } from 'primeng/datepicker';
import { Dialog } from 'primeng/dialog';
import { ButtonModule } from 'primeng/button';
import { InputNumberModule } from 'primeng/inputnumber';
import { InputTextModule } from 'primeng/inputtext';
import { Subscription } from 'rxjs';
import { format as formatDate } from 'date-fns';
import { CustomersService } from '../../../customer/services/customers.service';
import { HOME_VIEW_STORAGE_KEY } from '../../../layout/constants/home-view.constants';
import { SideNavComponent } from '../../../layout/components/side-nav/side-nav.component';
import { ThemeService } from '../../../shared/services/theme.service';
import {
  CreateCreditSalePayload,
  CreditSalesService
} from '../../services/credit-sales.service';
import { ProductsService } from '../../services/products.service';

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
};

type CustomerSearchResult = {
  id: string;
  name: string;
  phone: string;
  displayLabel: string;
};

type CreditLineItemState = {
  id: string;
  searchInputValue: string;
  showSuggestionPanel: boolean;
  productOptions: ProductSearchResult[];
  isSearching: boolean;
  searchError: string;
  latestRequestedQuery: string;
  selectedProduct: ProductSearchResult | null;
  searchBlurTimer: ReturnType<typeof setTimeout> | null;
};

@Component({
  selector: 'app-credit-sales',
  standalone: true,
  imports: [
    CommonModule,
    ReactiveFormsModule,
    SideNavComponent,
    TranslatePipe,
    InputTextModule,
    InputNumberModule,
    DatePickerModule,
    Dialog,
    ButtonModule
  ],
  templateUrl: './credit-sales.component.html',
  styleUrl: './credit-sales.component.scss'
})
export class CreditSalesComponent implements OnInit, OnDestroy {
  isDarkMode$;
  direction: 'rtl' | 'ltr' = 'ltr';
  creditSaleForm: FormGroup;
  reviewDialogVisible = false;
  successDialogVisible = false;
  errorDialogVisible = false;
  submitAttempted = false;
  isSaving = false;
  saveError = '';
  productsCount = 1;
  totalQuantity = 0;
  itemsSubtotal = 0;
  discountAmount = 0;
  discountPercentage = 0;
  shippingFees = 0;
  financedAmount = 0;
  totalReceivable = 0;
  customerSearchInputValue = '';
  showCustomerSuggestionPanel = false;
  customerOptions: CustomerSearchResult[] = [];
  selectedCustomerOption: CustomerSearchResult | null = null;
  isSearchingCustomers = false;
  customerSearchError = '';
  lineItemStates: CreditLineItemState[] = [];
  private readonly isBrowser: boolean;
  private readonly subscriptions = new Subscription();
  private customerSearchBlurTimer: ReturnType<typeof setTimeout> | null = null;
  private latestRequestedCustomerQuery = '';
  private lineItemSequence = 0;

  constructor(
    private readonly themeService: ThemeService,
    private readonly router: Router,
    private readonly formBuilder: FormBuilder,
    private readonly translate: TranslateService,
    private readonly productsService: ProductsService,
    private readonly customersService: CustomersService,
    private readonly creditSalesService: CreditSalesService,
    private readonly cdr: ChangeDetectorRef,
    @Inject(PLATFORM_ID) platformId: object
  ) {
    this.isDarkMode$ = this.themeService.isDarkMode$;
    this.isBrowser = isPlatformBrowser(platformId);
    this.creditSaleForm = this.initializeForm();
    this.addLineItem(false);
    this.refreshDerivedState();
  }

  ngOnInit(): void {
    this.updateDirection();
    this.subscriptions.add(
      this.translate.onLangChange.subscribe(() => {
        this.updateDirection();
        this.refreshDerivedState();
      })
    );
    this.subscriptions.add(
      this.creditSaleForm.valueChanges.subscribe(() => {
        this.refreshDerivedState();
      })
    );

    if (!this.isBrowser) {
      return;
    }

    localStorage.setItem(HOME_VIEW_STORAGE_KEY, 'products');
  }

  ngOnDestroy(): void {
    this.subscriptions.unsubscribe();

    if (this.customerSearchBlurTimer) {
      clearTimeout(this.customerSearchBlurTimer);
      this.customerSearchBlurTimer = null;
    }

    this.lineItemStates.forEach((state) => {
      if (state.searchBlurTimer) {
        clearTimeout(state.searchBlurTimer);
        state.searchBlurTimer = null;
      }
    });
  }

  get lineItems(): FormArray {
    return this.creditSaleForm.get('items') as FormArray;
  }

  get lineItemControls(): FormGroup[] {
    return this.lineItems.controls as FormGroup[];
  }

  backToProducts(): void {
    if (this.isBrowser) {
      localStorage.setItem(HOME_VIEW_STORAGE_KEY, 'products');
    }

    this.router.navigate(['/home']);
  }

  trackLineItem(index: number): string {
    return this.lineItemStates[index]?.id || `credit-line-${index}`;
  }

  getLineItemState(index: number): CreditLineItemState {
    return this.lineItemStates[index];
  }

  addLineItem(emitRefresh = true): void {
    this.lineItems.push(this.createLineItemGroup());
    this.lineItemStates.push(this.createLineItemState());
    if (emitRefresh) {
      this.refreshDerivedState();
    }
  }

  removeLineItem(index: number): void {
    if (this.lineItems.length === 1) {
      this.resetLineItem(index);
      return;
    }

    const itemState = this.getLineItemState(index);
    if (itemState.searchBlurTimer) {
      clearTimeout(itemState.searchBlurTimer);
      itemState.searchBlurTimer = null;
    }

    this.lineItems.removeAt(index);
    this.lineItemStates.splice(index, 1);
    this.refreshDerivedState();
    this.cdr.detectChanges();
  }

  resetDraft(): void {
    while (this.lineItems.length > 0) {
      this.lineItems.removeAt(0);
    }

    this.lineItemStates.forEach((state) => {
      if (state.searchBlurTimer) {
        clearTimeout(state.searchBlurTimer);
      }
    });
    this.lineItemStates = [];

    this.creditSaleForm.reset({
      customerId: null,
      customerName: '',
      customerPhone: '',
      sellingDate: new Date(),
      discountAmount: 0,
      shippingFees: 0,
      downPayment: 0
    });

    this.customerSearchInputValue = '';
    this.showCustomerSuggestionPanel = false;
    this.customerOptions = [];
    this.selectedCustomerOption = null;
    this.isSearchingCustomers = false;
    this.customerSearchError = '';
    this.latestRequestedCustomerQuery = '';
    this.submitAttempted = false;
    this.isSaving = false;
    this.saveError = '';
    this.reviewDialogVisible = false;
    this.errorDialogVisible = false;
    this.successDialogVisible = false;
    this.addLineItem(false);
    this.refreshDerivedState();
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
      return;
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
      this.cdr.detectChanges();
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
    this.creditSaleForm.patchValue({
      customerId: customer.id,
      customerName: customer.name,
      customerPhone: customer.phone
    });
  }

  clearSelectedCustomerIfEdited(): void {
    if (!this.selectedCustomerOption) {
      return;
    }

    const customerName = String(this.creditSaleForm.get('customerName')?.value || '').trim();
    const customerPhone = String(this.creditSaleForm.get('customerPhone')?.value || '').trim();

    if (
      customerName !== this.selectedCustomerOption.name ||
      customerPhone !== this.selectedCustomerOption.phone
    ) {
      this.selectedCustomerOption = null;
      this.creditSaleForm.patchValue({ customerId: null }, { emitEvent: false });
    }
  }

  onSearchInputChange(index: number, event: Event): void {
    const itemGroup = this.lineItemControls[index];
    const itemState = this.getLineItemState(index);
    const value = String((event.target as HTMLInputElement)?.value || '');
    const query = value.trim();

    itemState.searchError = '';
    itemState.searchInputValue = value;

    if (!query) {
      itemState.productOptions = [];
      itemState.isSearching = false;
      itemState.latestRequestedQuery = '';
      itemState.showSuggestionPanel = false;
      this.onProductSelectionChange(itemGroup, itemState, null);
      return;
    }

    if (itemState.selectedProduct && query !== itemState.selectedProduct.displayLabel) {
      this.onProductSelectionChange(itemGroup, itemState, null);
    }

    this.fetchProductOptions(itemGroup, itemState, query);
  }

  onSearchInputFocus(index: number): void {
    const itemState = this.getLineItemState(index);

    if (itemState.searchBlurTimer) {
      clearTimeout(itemState.searchBlurTimer);
      itemState.searchBlurTimer = null;
    }

    if (itemState.productOptions.length > 0 || itemState.isSearching) {
      itemState.showSuggestionPanel = true;
    }
  }

  onSearchInputBlur(index: number): void {
    const itemState = this.getLineItemState(index);
    itemState.searchBlurTimer = setTimeout(() => {
      itemState.showSuggestionPanel = false;
      this.cdr.detectChanges();
    }, 180);
  }

  onNativeOptionSelect(index: number, product: ProductSearchResult): void {
    const itemGroup = this.lineItemControls[index];
    const itemState = this.getLineItemState(index);

    if (itemState.searchBlurTimer) {
      clearTimeout(itemState.searchBlurTimer);
      itemState.searchBlurTimer = null;
    }

    itemState.searchInputValue = product.displayLabel;
    itemState.showSuggestionPanel = false;
    this.onProductSelectionChange(itemGroup, itemState, product);
  }

  getLineTotal(index: number): number {
    const itemGroup = this.lineItemControls[index];
    const quantity = this.toPositiveNumber(itemGroup.get('quantity')?.value);
    const unitPrice = this.toPositiveNumber(itemGroup.get('price')?.value);
    return quantity * unitPrice;
  }

  isDownPaymentExceeded(): boolean {
    const downPayment = this.toPositiveNumber(this.creditSaleForm.get('downPayment')?.value);
    return downPayment > this.totalReceivable && this.totalReceivable > 0;
  }

  formatMoney(value: number): string {
    return new Intl.NumberFormat(this.direction === 'rtl' ? 'ar-EG' : 'en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(value || 0);
  }

  formatDisplayDate(value: Date | string | null | undefined): string {
    const parsedDate = this.parseDateValue(value);
    if (!parsedDate) {
      return '-';
    }

    if (this.direction === 'rtl') {
      return parsedDate.toLocaleDateString('ar-EG', {
        year: 'numeric',
        month: 'short',
        day: 'numeric'
      });
    }

    return parsedDate.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    });
  }

  openReviewDialog(): void {
    this.submitAttempted = true;
    this.errorDialogVisible = false;
    this.saveError = '';

    if (this.creditSaleForm.invalid || this.itemsSubtotal <= 0 || this.isDownPaymentExceeded()) {
      this.markAllControlsTouched(this.creditSaleForm);
      return;
    }

    this.refreshDerivedState();
    this.reviewDialogVisible = true;
  }

  closeReviewDialog(): void {
    this.reviewDialogVisible = false;
  }

  saveCreditSale(): void {
    this.submitAttempted = true;
    this.errorDialogVisible = false;
    this.saveError = '';

    if (this.creditSaleForm.invalid || this.itemsSubtotal <= 0 || this.isDownPaymentExceeded()) {
      this.markAllControlsTouched(this.creditSaleForm);
      return;
    }

    const payload = this.buildCreatePayload();
    if (!payload.items.length) {
      return;
    }

    this.isSaving = true;

    this.creditSalesService.createCreditSale(payload).subscribe({
      next: () => {
        this.isSaving = false;
        this.reviewDialogVisible = false;
        this.successDialogVisible = true;
        this.resetDraft();
        this.successDialogVisible = true;
        this.cdr.detectChanges();
      },
      error: (err: any) => {
        this.isSaving = false;
        this.saveError =
          err?.error?.message || this.translateKey('creditSalePage.messages.createFailed');
        this.reviewDialogVisible = false;
        this.errorDialogVisible = true;
        this.cdr.detectChanges();
      }
    });
  }

  closeSuccessPopup(): void {
    this.successDialogVisible = false;
  }

  closeErrorPopup(): void {
    this.errorDialogVisible = false;
  }

  private initializeForm(): FormGroup {
    return this.formBuilder.group({
      customerId: [null],
      customerName: ['', Validators.required],
      customerPhone: ['', Validators.required],
      sellingDate: [new Date(), Validators.required],
      discountAmount: [0, [Validators.min(0)]],
      shippingFees: [0, [Validators.min(0)]],
      downPayment: [0, [Validators.min(0)]],
      items: this.formBuilder.array([])
    });
  }

  private createLineItemGroup(): FormGroup {
    return this.formBuilder.group({
      productId: [null, Validators.required],
      productName: [{ value: '', disabled: true }],
      itemCode: [{ value: '', disabled: true }],
      categoryName: [{ value: '', disabled: true }],
      price: [null, [Validators.required, Validators.min(0.01)]],
      quantity: [1, [Validators.required, Validators.min(1)]],
      lineTotal: [{ value: 0, disabled: true }]
    });
  }

  private createLineItemState(): CreditLineItemState {
    this.lineItemSequence += 1;

    return {
      id: `credit-line-${this.lineItemSequence}`,
      searchInputValue: '',
      showSuggestionPanel: false,
      productOptions: [],
      isSearching: false,
      searchError: '',
      latestRequestedQuery: '',
      selectedProduct: null,
      searchBlurTimer: null
    };
  }

  private resetLineItem(index: number): void {
    const itemGroup = this.lineItemControls[index];
    const itemState = this.getLineItemState(index);

    itemState.searchInputValue = '';
    itemState.showSuggestionPanel = false;
    itemState.productOptions = [];
    itemState.isSearching = false;
    itemState.searchError = '';
    itemState.latestRequestedQuery = '';
    itemState.selectedProduct = null;

    if (itemState.searchBlurTimer) {
      clearTimeout(itemState.searchBlurTimer);
      itemState.searchBlurTimer = null;
    }

    itemGroup.reset({
      productId: null,
      productName: '',
      itemCode: '',
      categoryName: '',
      price: null,
      quantity: 1,
      lineTotal: 0
    });

    this.refreshDerivedState();
  }

  private updateDirection(): void {
    const currentLang = this.translate.currentLang || this.translate.defaultLang || 'en';
    this.direction = currentLang === 'ar' ? 'rtl' : 'ltr';
  }

  private translateKey(key: string): string {
    return this.translate.instant(key);
  }

  private refreshDerivedState(): void {
    this.productsCount = this.lineItems.length;
    this.totalQuantity = this.lineItemControls.reduce((sum, control) => {
      return sum + this.toPositiveNumber(control.get('quantity')?.value);
    }, 0);
    this.itemsSubtotal = this.roundCurrency(this.lineItemControls.reduce((sum, control, index) => {
      const lineTotal = this.getLineTotal(index);
      control.get('lineTotal')?.setValue(lineTotal, { emitEvent: false });
      return sum + lineTotal;
    }, 0));

    this.discountAmount = this.normalizeDiscountAmountControl(this.itemsSubtotal);
    this.discountPercentage = this.calculateDiscountPercentage(
      this.itemsSubtotal,
      this.discountAmount
    );
    this.shippingFees = this.roundCurrency(
      this.toPositiveNumber(this.creditSaleForm.get('shippingFees')?.value)
    );
    const downPayment = this.toPositiveNumber(this.creditSaleForm.get('downPayment')?.value);
    this.totalReceivable = this.roundCurrency(
      Math.max(this.itemsSubtotal - this.discountAmount + this.shippingFees, 0)
    );
    this.financedAmount = this.roundCurrency(Math.max(this.totalReceivable - downPayment, 0));
  }

  private buildCreatePayload(): CreateCreditSalePayload {
    const raw = this.creditSaleForm.getRawValue();
    const normalizedCustomerName = String(raw.customerName || '').trim();
    const normalizedCustomerPhone = String(raw.customerPhone || '').trim();
    const normalizedCustomerId = String(raw.customerId || '').trim();
    const adjustedItems = this.buildItemPayloads(Array.isArray(raw.items) ? raw.items : []);
    const downPayment = this.toPositiveNumber(raw.downPayment);

    const payload: CreateCreditSalePayload = {
      sellingDate: this.formatRequestDate(raw.sellingDate),
      discountAmount: this.discountAmount,
      discountPercentage: this.discountPercentage,
      shippingFees: this.roundCurrency(this.toPositiveNumber(raw.shippingFees)),
      initialPaidAmount: downPayment > 0 ? downPayment : undefined,
      items: adjustedItems
    };

    if (normalizedCustomerId) {
      payload.customerId = normalizedCustomerId;
    } else {
      payload.customerName = normalizedCustomerName;
      payload.customerPhone = normalizedCustomerPhone;
    }

    return payload;
  }

  private buildItemPayloads(
    rawItems: Array<{
      productId: string;
      quantity: number;
      price: number;
    }>
  ): CreateCreditSalePayload['items'] {
    return rawItems
      .map((item) => {
        const quantity = Math.max(1, Math.floor(this.toPositiveNumber(item.quantity)));

        return {
          productId: String(item.productId || '').trim(),
          quantity,
          price: this.toPositiveNumber(item.price)
        };
      })
      .filter((item) => item.productId);
  }

  private fetchProductOptions(
    itemGroup: FormGroup,
    itemState: CreditLineItemState,
    query: string
  ): void {
    itemState.latestRequestedQuery = query;
    itemState.isSearching = true;
    itemState.searchError = '';

    this.productsService.searchProducts(query).subscribe({
      next: (response: any) => {
        if (
          query !== itemState.latestRequestedQuery ||
          !this.lineItems.controls.includes(itemGroup)
        ) {
          return;
        }

        itemState.isSearching = false;
        itemState.productOptions = this.extractProducts(response);
        itemState.showSuggestionPanel =
          itemState.productOptions.length > 0 && itemState.searchInputValue.trim().length > 0;

        if (!itemState.productOptions.length) {
          itemState.searchError = this.translateKey('creditSalePage.messages.noProductFound');
        }

        this.cdr.detectChanges();
      },
      error: (err: any) => {
        if (
          query !== itemState.latestRequestedQuery ||
          !this.lineItems.controls.includes(itemGroup)
        ) {
          return;
        }

        itemState.isSearching = false;
        itemState.productOptions = [];
        itemState.showSuggestionPanel = false;
        itemState.searchError =
          err?.error?.message || this.translateKey('creditSalePage.messages.searchFailed');
        this.clearProductDataForItem(itemGroup);
        this.cdr.detectChanges();
      }
    });
  }

  private fetchCustomerOptions(query: string): void {
    this.latestRequestedCustomerQuery = query;
    this.isSearchingCustomers = true;
    this.customerSearchError = '';

    this.customersService.getCustomers({ search: query }).subscribe({
      next: (response: any) => {
        if (query !== this.latestRequestedCustomerQuery) {
          return;
        }

        this.isSearchingCustomers = false;
        this.customerOptions = this.extractCustomerOptions(response);
        this.showCustomerSuggestionPanel =
          this.customerOptions.length > 0 && this.customerSearchInputValue.trim().length > 0;

        if (!this.customerOptions.length) {
          this.customerSearchError = this.translateKey('creditSalePage.messages.noCustomerFound');
        }

        this.cdr.detectChanges();
      },
      error: (err: any) => {
        if (query !== this.latestRequestedCustomerQuery) {
          return;
        }

        this.isSearchingCustomers = false;
        this.customerOptions = [];
        this.showCustomerSuggestionPanel = false;
        this.customerSearchError =
          err?.error?.message || this.translateKey('creditSalePage.messages.customerSearchFailed');
        this.cdr.detectChanges();
      }
    });
  }

  private onProductSelectionChange(
    itemGroup: FormGroup,
    itemState: CreditLineItemState,
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
      itemCode: product.code,
      categoryName: product.categoryName,
      price: product.retailPrice ?? product.wholesalePrice ?? 0
    });
    this.refreshDerivedState();
  }

  private clearProductDataForItem(itemGroup: FormGroup): void {
    itemGroup.patchValue({
      productId: null,
      productName: '',
      itemCode: '',
      categoryName: '',
      price: null,
      lineTotal: 0
    });
    this.refreshDerivedState();
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
      wholesalePrice: this.toNumber(candidate.wholesalePrice),
      retailPrice: this.toNumber(candidate.retailPrice),
      discountPercentage: this.toNumber(candidate.discountPercentage),
      priceAfterDiscount: this.toNumber(candidate.priceAfterDiscount)
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

  private formatRequestDate(value: Date | string): string {
    const parsedDate = this.parseDateValue(value);
    if (!parsedDate) {
      return String(value || '');
    }

    return formatDate(parsedDate, 'yyyy-MM-dd');
  }

  private parseDateValue(value: unknown): Date | null {
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
      return value;
    }

    if (typeof value === 'string' || typeof value === 'number') {
      const parsedDate = new Date(value);
      if (!Number.isNaN(parsedDate.getTime())) {
        return parsedDate;
      }
    }

    return null;
  }

  private markAllControlsTouched(formGroup: FormGroup | FormArray): void {
    Object.values(formGroup.controls).forEach((control) => {
      control.markAsTouched();
      if (control instanceof FormGroup || control instanceof FormArray) {
        this.markAllControlsTouched(control);
      }
    });
  }

  private toPositiveNumber(value: unknown): number {
    const normalized = Number(value);
    if (!Number.isFinite(normalized) || normalized < 0) {
      return 0;
    }

    return normalized;
  }

  private toBoundedPercentage(value: unknown): number {
    return Math.min(100, this.toPositiveNumber(value));
  }

  private calculateDiscountPercentage(subtotal: number, discountAmount: number): number {
    if (subtotal <= 0 || discountAmount <= 0) {
      return 0;
    }

    return this.roundCurrency(Math.min((discountAmount / subtotal) * 100, 100));
  }

  private toDiscountAmount(value: unknown, subtotal: number): number {
    return this.roundCurrency(Math.min(this.toPositiveNumber(value), Math.max(subtotal, 0)));
  }

  private normalizeDiscountAmountControl(subtotal: number): number {
    const discountAmountControl = this.creditSaleForm.get('discountAmount');
    const boundedValue = this.toDiscountAmount(discountAmountControl?.value, subtotal);

    if (discountAmountControl && discountAmountControl.value !== boundedValue) {
      discountAmountControl.setValue(boundedValue, { emitEvent: false });
    }

    return boundedValue;
  }

  private toNumber(value: unknown): number | null {
    const normalized = Number(value);
    return Number.isFinite(normalized) ? normalized : null;
  }

  private roundCurrency(value: number): number {
    return Number((value || 0).toFixed(2));
  }
}
