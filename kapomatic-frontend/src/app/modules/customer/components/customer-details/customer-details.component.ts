import { CommonModule, isPlatformBrowser } from '@angular/common';
import { ChangeDetectorRef, Component, Inject, OnDestroy, OnInit, PLATFORM_ID } from '@angular/core';
import { FormArray, FormBuilder, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { DatePickerModule } from 'primeng/datepicker';
import { Dialog } from 'primeng/dialog';
import { InputNumberModule } from 'primeng/inputnumber';
import { Subscription } from 'rxjs';
import { SideNavComponent } from '../../../layout/components/side-nav/side-nav.component';
import {
  buildCreditInvoiceDocument,
  CreditInvoicePrintData,
  CreditInvoicePrintLanguage
} from './credit-invoice-print.util';
import { CreditSalesService } from '../../../products/services/credit-sales.service';
import { ReturnsService } from '../../../returns/services/returns.service';
import { ThemeService } from '../../../shared/services/theme.service';
import {
  Customer,
  CustomerCreditHistoryEntry,
  CustomerCreditSummary,
  CustomerDetails,
  CustomersService
} from '../../services/customers.service';

type CustomerHistoryView = {
  id: string;
  invoiceId: string;
  sellingDate: string | null;
  dueDate: string | null;
  status: 'pending' | 'partially_paid' | 'paid' | 'reactionary' | 'unknown';
  subtotal: number;
  discountAmount: number | null;
  discountPercentage: number | null;
  shippingFees: number | null;
  totalPrice: number;
  paidAmount: number;
  remainingAmount: number;
  itemCount: number;
  totalQuantity: number;
  notes: string;
  paymentsCount: number;
  items: Array<{
    id: string;
    productId: string;
    productName: string;
    productCode: string;
    categoryName: string;
    quantity: number;
    pricePerEach: number;
    totalPrice: number;
  }>;
  payments: Array<{
    id: string;
    amount: number;
    paymentDate: string | null;
    note: string;
  }>;
};

type CustomerDetailsView = CustomerDetails & {
  creditSummary: CustomerCreditSummary;
  creditHistory: CustomerHistoryView[];
};

@Component({
  selector: 'app-customer-details',
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule, SideNavComponent, TranslatePipe, DatePickerModule, Dialog, InputNumberModule],
  templateUrl: './customer-details.component.html'
})
export class CustomerDetailsComponent implements OnInit, OnDestroy {
  isDarkMode$;
  direction: 'rtl' | 'ltr' = 'ltr';
  customer: CustomerDetailsView | null = null;
  paymentForm: FormGroup;
  refundForm: FormGroup;
  printingInvoiceId = '';
  isLoading = true;
  paymentDialogVisible = false;
  paymentDialogMode: 'invoice' | 'customer' = 'invoice';
  paymentSubmitAttempted = false;
  isSavingPayment = false;
  refundDialogVisible = false;
  refundSubmitAttempted = false;
  isSavingRefund = false;
  errorMessage = '';
  historyActionError = '';
  paymentErrorMessage = '';
  refundErrorMessage = '';
  deleteCreditDialogVisible = false;
  isDeletingCreditSale = false;
  deleteCreditErrorMessage = '';
  selectedInvoiceForPayment: CustomerHistoryView | null = null;
  selectedInvoiceForRefund: CustomerHistoryView | null = null;
  selectedInvoiceForDelete: CustomerHistoryView | null = null;
  private readonly isBrowser: boolean;
  private currentCustomerId: string | null = null;
  private readonly subscriptions = new Subscription();

  constructor(
    private readonly themeService: ThemeService,
    private readonly customersService: CustomersService,
    private readonly creditSalesService: CreditSalesService,
    private readonly returnsService: ReturnsService,
    private readonly route: ActivatedRoute,
    private readonly router: Router,
    private readonly translate: TranslateService,
    private readonly formBuilder: FormBuilder,
    private readonly cdr: ChangeDetectorRef,
    @Inject(PLATFORM_ID) platformId: Object
  ) {
    this.isDarkMode$ = this.themeService.isDarkMode$;
    this.isBrowser = isPlatformBrowser(platformId);
    this.paymentForm = this.formBuilder.group({
      amount: [null, [Validators.required, Validators.min(0.01)]],
      paymentDate: [new Date(), Validators.required],
      note: [''],
      firstInvoice: [false],
      lastInvoice: [true]
    });
    this.refundForm = this.formBuilder.group({
      refundDate: [new Date(), Validators.required],
      note: [''],
      items: this.formBuilder.array([])
    });
  }

  ngOnInit(): void {
    this.updateDirection();
    this.subscriptions.add(
      this.translate.onLangChange.subscribe(() => {
        this.updateDirection();
      })
    );
    this.subscriptions.add(
      this.route.paramMap.subscribe((params) => {
        const customerId = params.get('id');
        this.currentCustomerId = customerId;
        if (!customerId) {
          this.isLoading = false;
          this.errorMessage = this.translate.instant('customerDetailsPage.messages.notFound');
          return;
        }

        this.loadCustomer(customerId);
      })
    );
  }

  ngOnDestroy(): void {
    this.subscriptions.unsubscribe();
  }

  backToCustomers(): void {
    this.router.navigate(['/customers']);
  }

  trackHistory(index: number, item: CustomerHistoryView): string {
    return item.id || item.invoiceId || String(index);
  }

  trackHistoryItem(index: number, item: CustomerHistoryView['items'][number]): string {
    return item.id || `${item.productCode}-${index}`;
  }

  trackPayment(index: number, item: CustomerHistoryView['payments'][number]): string {
    return item.id || `${item.paymentDate || 'payment'}-${index}`;
  }

  trackRefundItem(index: number): string {
    const productId = this.refundItems.at(index)?.get('productId')?.value;
    return String(productId || index);
  }

  get refundItems(): FormArray {
    return this.refundForm.get('items') as FormArray;
  }

  canAddPayment(entry: CustomerHistoryView): boolean {
    return !!entry.id && entry.remainingAmount > 0 && entry.status !== 'paid';
  }

  canAddRefund(entry: CustomerHistoryView): boolean {
    return !!entry.id && entry.items.some((item) => item.productId && item.quantity > 0);
  }

  printCreditInvoice(entry: CustomerHistoryView): void {
    if (!this.isBrowser || !entry?.id || !this.customer) {
      return;
    }

    this.printingInvoiceId = entry.id;
    this.historyActionError = '';
    this.cdr.detectChanges();

    try {
      const invoiceWindow = window.open('', '_blank', 'width=1180,height=860');

      if (!invoiceWindow) {
        this.historyActionError = this.translate.instant('invoiceHistoryPage.messages.invoiceWindowBlocked');
        return;
      }

      const language = this.getInvoiceLanguage();
      const printableInvoice = this.mapCreditInvoiceToPrintData(entry, this.customer);

      invoiceWindow.document.open();
      invoiceWindow.document.write(buildCreditInvoiceDocument({
        invoice: printableInvoice,
        language,
        logoUrl: this.resolveAssetUrl('assets/img/Kapo.jpeg'),
        fontUrl: this.resolveAssetUrl('assets/fonts/Montserrat-VariableFont_wght.ttf'),
      }));
      invoiceWindow.document.close();
      invoiceWindow.focus();
    } catch {
      this.historyActionError = this.translate.instant('invoiceHistoryPage.messages.invoiceDownloadFailed');
    } finally {
      this.printingInvoiceId = '';
      this.cdr.detectChanges();
    }
  }

  isPrintingInvoice(invoiceId: string): boolean {
    return this.printingInvoiceId === invoiceId;
  }

  openPaymentDialog(entry: CustomerHistoryView): void {
    if (!this.canAddPayment(entry)) {
      return;
    }

    this.paymentDialogMode = 'invoice';
    this.selectedInvoiceForPayment = entry;
    this.paymentDialogVisible = true;
    this.paymentSubmitAttempted = false;
    this.isSavingPayment = false;
    this.paymentErrorMessage = '';
    this.resetPaymentForm();
  }

  openCustomerPaymentDialog(): void {
    if (!this.hasAvailablePaymentTargets()) {
      return;
    }

    this.paymentDialogMode = 'customer';
    this.selectedInvoiceForPayment = null;
    this.paymentDialogVisible = true;
    this.paymentSubmitAttempted = false;
    this.isSavingPayment = false;
    this.paymentErrorMessage = '';
    this.resetPaymentForm();
  }

  closePaymentDialog(): void {
    this.paymentDialogVisible = false;
    this.paymentDialogMode = 'invoice';
    this.paymentSubmitAttempted = false;
    this.isSavingPayment = false;
    this.paymentErrorMessage = '';
    this.selectedInvoiceForPayment = null;
    this.resetPaymentForm();
  }

  openRefundDialog(entry: CustomerHistoryView): void {
    if (!this.canAddRefund(entry)) {
      return;
    }

    this.selectedInvoiceForRefund = entry;
    this.refundDialogVisible = true;
    this.refundSubmitAttempted = false;
    this.isSavingRefund = false;
    this.refundErrorMessage = '';
    this.refundForm.patchValue({
      refundDate: new Date(),
      note: ''
    });
    this.setRefundItems(entry.items);
  }

  closeRefundDialog(): void {
    this.refundDialogVisible = false;
    this.refundSubmitAttempted = false;
    this.isSavingRefund = false;
    this.refundErrorMessage = '';
    this.selectedInvoiceForRefund = null;
    this.refundForm.patchValue({
      refundDate: new Date(),
      note: ''
    });
    this.clearRefundItems();
  }

  openDeleteCreditDialog(entry: CustomerHistoryView): void {
    if (!entry?.id || this.isDeletingCreditSale) return;
    this.selectedInvoiceForDelete = entry;
    this.deleteCreditErrorMessage = '';
    this.deleteCreditDialogVisible = true;
  }

  closeDeleteCreditDialog(): void {
    if (this.isDeletingCreditSale) return;
    this.deleteCreditDialogVisible = false;
    this.selectedInvoiceForDelete = null;
    this.deleteCreditErrorMessage = '';
  }

  deleteCreditInvoice(): void {
    const invoice = this.selectedInvoiceForDelete;
    if (!invoice?.id || this.isDeletingCreditSale) return;

    this.isDeletingCreditSale = true;
    this.deleteCreditErrorMessage = '';
    this.creditSalesService.deleteCreditSale(invoice.id).subscribe({
      next: () => {
        this.isDeletingCreditSale = false;
        this.deleteCreditDialogVisible = false;
        this.selectedInvoiceForDelete = null;
        if (this.currentCustomerId) this.loadCustomer(this.currentCustomerId);
      },
      error: (error: any) => {
        this.isDeletingCreditSale = false;
        this.deleteCreditErrorMessage = this.extractErrorMessage(error, 'customerDetailsPage.messages.deleteInvoiceFailed');
        this.cdr.detectChanges();
      }
    });
  }

  fillRefundWithAllItems(): void {
    this.refundItems.controls.forEach((control) => {
      const availableQuantity = this.toInteger(control.get('availableQuantity')?.value);
      control.get('quantity')?.setValue(availableQuantity);
    });
  }

  clearRefundQuantities(): void {
    this.refundItems.controls.forEach((control) => {
      control.get('quantity')?.setValue(0);
    });
  }

  hasRefundSelection(): boolean {
    return this.refundItems.controls.some((control) => this.toInteger(control.get('quantity')?.value) > 0);
  }

  isRefundQuantityExceeded(index: number): boolean {
    const control = this.refundItems.at(index);
    return !!control?.get('quantity')?.hasError('max') && !!control.get('quantity')?.touched;
  }

  saveRefund(): void {
    const invoice = this.selectedInvoiceForRefund;
    if (!invoice?.id) {
      return;
    }

    this.refundSubmitAttempted = true;
    this.refundErrorMessage = '';

    if (this.refundForm.invalid || !this.hasRefundSelection()) {
      this.refundForm.markAllAsTouched();
      return;
    }

    const raw = this.refundForm.getRawValue();
    const items = (Array.isArray(raw.items) ? raw.items : [])
      .map((item: any) => ({
        productId: String(item?.productId || '').trim(),
        quantity: this.toInteger(item?.quantity)
      }))
      .filter((item) => item.productId && item.quantity > 0);

    if (!items.length) {
      return;
    }

    this.isSavingRefund = true;

    this.returnsService.createReturn({
      returnType: 'credit',
      invoiceId: invoice.id,
      refundDate: this.formatRequestDate(raw.refundDate),
      note: String(raw.note || '').trim() || undefined,
      items
    }).subscribe({
      next: () => {
        this.isSavingRefund = false;
        this.closeRefundDialog();
        if (this.currentCustomerId) {
          this.loadCustomer(this.currentCustomerId);
        }
      },
      error: (error: any) => {
        this.isSavingRefund = false;
        this.refundErrorMessage = this.extractErrorMessage(error, 'customerDetailsPage.messages.refundFailed');
        this.cdr.detectChanges();
      }
    });
  }

  isPaymentAmountExceeded(): boolean {
    const invoice = this.getPaymentTargetInvoice();
    if (!invoice) {
      return false;
    }

    return this.toNumber(this.paymentForm.get('amount')?.value) > invoice.remainingAmount;
  }

  hasAvailablePaymentTargets(): boolean {
    return this.getPayableInvoices().length > 0;
  }

  setPaymentTarget(target: 'first' | 'last', checked: boolean): void {
    const firstInvoiceControl = this.paymentForm.get('firstInvoice');
    const lastInvoiceControl = this.paymentForm.get('lastInvoice');

    if (!firstInvoiceControl || !lastInvoiceControl) {
      return;
    }

    if (target === 'first') {
      firstInvoiceControl.setValue(checked);
      if (checked) {
        lastInvoiceControl.setValue(false);
      }
      return;
    }

    lastInvoiceControl.setValue(checked);
    if (checked) {
      firstInvoiceControl.setValue(false);
    }
  }

  getPaymentTargetInvoice(): CustomerHistoryView | null {
    if (this.paymentDialogMode === 'invoice') {
      return this.selectedInvoiceForPayment;
    }

    const payableInvoices = this.getPayableInvoices();
    if (!payableInvoices.length) {
      return null;
    }

    const firstInvoiceSelected = !!this.paymentForm.get('firstInvoice')?.value;
    const lastInvoiceSelected = !!this.paymentForm.get('lastInvoice')?.value;

    if (firstInvoiceSelected === lastInvoiceSelected) {
      return null;
    }

    return firstInvoiceSelected
      ? payableInvoices[0]
      : payableInvoices[payableInvoices.length - 1];
  }

  hasPaymentTargetSelectionError(): boolean {
    return this.paymentDialogMode === 'customer' && this.paymentSubmitAttempted && !this.getPaymentTargetInvoice();
  }

  savePayment(): void {
    this.paymentSubmitAttempted = true;
    this.paymentErrorMessage = '';
    const invoice = this.getPaymentTargetInvoice();

    if (!invoice?.id || this.paymentForm.invalid) {
      this.paymentForm.markAllAsTouched();
      return;
    }

    this.isSavingPayment = true;
    const raw = this.paymentForm.getRawValue();

    this.creditSalesService.recordPayment(invoice.id, {
      amount: this.toNumber(raw.amount),
      paymentDate: this.formatRequestDate(raw.paymentDate),
      note: String(raw.note || '').trim() || undefined
    }).subscribe({
      next: () => {
        this.isSavingPayment = false;
        this.closePaymentDialog();
        if (this.currentCustomerId) {
          this.loadCustomer(this.currentCustomerId);
        }
      },
      error: (error: any) => {
        this.isSavingPayment = false;
        this.paymentErrorMessage = this.extractErrorMessage(error, 'customerDetailsPage.messages.paymentFailed');
        this.cdr.detectChanges();
      }
    });
  }

  formatMoney(value: number | null | undefined): string {
    return new Intl.NumberFormat(this.direction === 'rtl' ? 'ar-EG' : 'en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(value ?? 0);
  }

  formatPercentage(value: number | null | undefined): string {
    return `${new Intl.NumberFormat(this.direction === 'rtl' ? 'ar-EG' : 'en-US', {
      minimumFractionDigits: 0,
      maximumFractionDigits: 2
    }).format(value ?? 0)}%`;
  }

  formatDate(value: string | null | undefined): string {
    if (!value) {
      return this.translate.instant('customerDetailsPage.labels.notAvailable');
    }

    const parsedDate = new Date(value);
    if (Number.isNaN(parsedDate.getTime())) {
      return this.translate.instant('customerDetailsPage.labels.notAvailable');
    }

    return parsedDate.toLocaleDateString(this.direction === 'rtl' ? 'ar-EG' : 'en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    });
  }

  getStatusLabel(status: CustomerHistoryView['status']): string {
    return this.translate.instant(`customerDetailsPage.status.${status}`);
  }

  getStatusClasses(status: CustomerHistoryView['status']): string {
    switch (status) {
      case 'paid':
        return 'bg-[#1e6f5c]/15 text-[#20c997]';
      case 'partially_paid':
        return 'bg-[#ff9933]/15 text-[#ffb056]';
      case 'pending':
        return 'bg-[#f4d80a]/15 text-[#f4d80a]';
      case 'reactionary':
        return 'bg-[#b83c3c]/15 text-[#ff7b7b]';
      default:
        return 'bg-[#7f7f86]/20 text-[#d7d7dc]';
    }
  }

  isInvoiceOverdue(entry: CustomerHistoryView): boolean {
    if (!entry.dueDate || entry.remainingAmount <= 0) {
      return false;
    }

    const dueDate = new Date(entry.dueDate);
    if (Number.isNaN(dueDate.getTime())) {
      return false;
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    dueDate.setHours(0, 0, 0, 0);
    return dueDate < today;
  }

  private updateDirection(): void {
    const lang = this.translate.currentLang || this.translate.getDefaultLang() || 'en';
    this.direction = lang === 'ar' ? 'rtl' : 'ltr';
  }

  private loadCustomer(customerId: string): void {
    this.isLoading = true;
    this.errorMessage = '';

    this.customersService.getCustomerById(customerId).subscribe({
      next: (response: any) => {
        const normalized = this.normalizeCustomerResponse(response);
        this.customer = normalized;
        this.isLoading = false;
        this.cdr.detectChanges();
      },
      error: (error: any) => {
        this.isLoading = false;
        this.errorMessage = this.extractErrorMessage(error, 'customerDetailsPage.messages.loadFailed');
      }
    });
  }

  private normalizeCustomerResponse(response: any): CustomerDetailsView | null {
    const customerSource = this.extractCustomer(response);
    if (!customerSource) {
      return null;
    }

    const historySource = this.extractHistory(response, customerSource);
    const creditHistory = historySource
      .map((item) => this.normalizeHistoryEntry(item))
      .filter((item): item is CustomerHistoryView => item !== null);
    const creditSummary = this.normalizeSummary(this.extractSummary(response, customerSource), creditHistory);

    return {
      ...customerSource,
      lastCashSaleDate: this.pickFirstDateValue([response, customerSource], ['lastCashSaleDate']),
      lastCreditSaleDate: this.pickFirstDateValue([response, customerSource], ['lastCreditSaleDate']),
      lastCreditSalePaymentDate: this.pickFirstDateValue([response, customerSource], ['lastCreditSalePaymentDate']),
      creditSummary,
      creditHistory
    };
  }

  private extractCustomer(response: any): CustomerDetails | null {
    if (!response) return null;
    if (response?._id) return response;
    if (response?.data?.customer?._id) return response.data.customer;
    if (response?.customer?._id) return response.customer;
    if (response?.data?._id) return response.data;
    return null;
  }

  private extractSummary(response: any, customer: CustomerDetails): any {
    return response?.data?.creditSummary ?? response?.creditSummary ?? customer.creditSummary ?? null;
  }

  private extractHistory(response: any, customer: CustomerDetails): any[] {
    const history =
      response?.data?.creditHistory ??
      response?.creditHistory ??
      customer.creditHistory ??
      [];

    return Array.isArray(history) ? history : [];
  }

  private normalizeHistoryEntry(source: CustomerCreditHistoryEntry | any): CustomerHistoryView | null {
    if (!source) return null;

    const id = String(source._id || source.id || source.invoiceId || '').trim();
    const invoiceId = String(source.invoiceId || source._id || source.id || '').trim();
    if (!id && !invoiceId) {
      return null;
    }

    const items = this.normalizeHistoryItems(source.items);
    const subtotal = this.toNumber(source.subtotal ?? this.sumHistoryItemTotals(items));
    const discountAmountValue = this.toOptionalNonNegativeNumber(source.discountAmount);
    const discountPercentageValue =
      this.toOptionalBoundedPercentage(source.discountPercentage) ??
      this.calculateDiscountPercentageFromAmount(subtotal, discountAmountValue);
    const shippingFeesValue = this.toOptionalNonNegativeNumber(source.shippingFees);
    const discountPercentage = discountPercentageValue ?? 0;
    const discountAmount = discountAmountValue ?? this.roundCurrency((subtotal * discountPercentage) / 100);
    const shippingFees = shippingFeesValue ?? 0;
    const totalPrice = this.toNumber(
      source.totalPrice ?? Math.max(subtotal - discountAmount + shippingFees, 0)
    );
    const paidAmount = this.toNumber(source.paidAmount);
    const remainingAmount = this.toNumber(
      source.remainingAmount ?? Math.max(totalPrice - paidAmount, 0)
    );
    const itemCount = this.toInteger(source.itemCount ?? source.items?.length);
    const totalQuantity = this.toInteger(source.totalQuantity);
    const normalizedStatus = this.normalizeStatus(source.status);
    const payments = this.normalizePayments(source.payments);
    const paymentsCount = payments.length;

    return {
      id: id || invoiceId,
      invoiceId: invoiceId || id,
      sellingDate: source.sellingDate ? String(source.sellingDate) : null,
      dueDate: source.dueDate ? String(source.dueDate) : null,
      status: normalizedStatus,
      subtotal,
      discountAmount: discountAmountValue ?? discountAmount,
      discountPercentage: discountPercentageValue,
      shippingFees: shippingFeesValue,
      totalPrice,
      paidAmount,
      remainingAmount,
      itemCount,
      totalQuantity,
      notes: String(source.notes || '').trim(),
      paymentsCount,
      items,
      payments
    };
  }

  private normalizeSummary(
    source: Partial<CustomerCreditSummary> | any,
    history: CustomerHistoryView[]
  ): CustomerCreditSummary {
    const fallback: CustomerCreditSummary = {
      totalInvoices: history.length,
      openInvoices: history.filter((item) => item.remainingAmount > 0).length,
      totalCredit: history.reduce((sum, item) => sum + item.totalPrice, 0),
      paidAmount: history.reduce((sum, item) => sum + item.paidAmount, 0),
      remainingAmount: history.reduce((sum, item) => sum + item.remainingAmount, 0),
      pendingInvoices: history.filter((item) => item.status === 'pending').length,
      partiallyPaidInvoices: history.filter((item) => item.status === 'partially_paid').length,
      paidInvoices: history.filter((item) => item.status === 'paid').length,
      overdueInvoices: history.filter((item) => this.isInvoiceOverdue(item)).length,
      dueSoonInvoices: history.filter((item) => this.isDueSoon(item)).length
    };

    if (!source || typeof source !== 'object') {
      return fallback;
    }

    return {
      totalInvoices: this.pickFirstNumber(source, ['totalInvoices', 'invoicesCount', 'invoiceCount'], fallback.totalInvoices),
      openInvoices: this.pickFirstNumber(source, ['openInvoices', 'openInvoiceCount'], fallback.openInvoices),
      totalCredit: this.pickFirstNumber(
        source,
        ['totalCredit', 'totalPrice', 'totalAmount', 'totalCreditAmount', 'totalDebtAmount'],
        fallback.totalCredit
      ),
      paidAmount: this.pickFirstNumber(
        source,
        ['paidAmount', 'totalPaid', 'paid', 'totalPaidAmount'],
        fallback.paidAmount
      ),
      remainingAmount: this.pickFirstNumber(
        source,
        ['remainingAmount', 'totalRemaining', 'remaining', 'totalRemainingAmount'],
        fallback.remainingAmount
      ),
      pendingInvoices: this.pickFirstNumber(
        source,
        ['pendingInvoices', 'pendingCount', 'debtStatusSummary.pending'],
        fallback.pendingInvoices
      ),
      partiallyPaidInvoices: this.pickFirstNumber(
        source,
        ['partiallyPaidInvoices', 'partiallyPaidCount', 'debtStatusSummary.partiallyPaid', 'debtStatusSummary.partially_paid'],
        fallback.partiallyPaidInvoices
      ),
      paidInvoices: this.pickFirstNumber(
        source,
        ['paidInvoices', 'paidCount', 'debtStatusSummary.paid'],
        fallback.paidInvoices
      ),
      overdueInvoices: this.pickFirstNumber(source, ['overdueInvoices', 'overdueCount'], fallback.overdueInvoices),
      dueSoonInvoices: this.pickFirstNumber(source, ['dueSoonInvoices', 'dueSoonCount'], fallback.dueSoonInvoices)
    };
  }

  private normalizeStatus(value: unknown): CustomerHistoryView['status'] {
    if (value === 'pending' || value === 'partially_paid' || value === 'paid' || value === 'reactionary') {
      return value;
    }

    if (value === 'partiallyPaid') {
      return 'partially_paid';
    }

    if (value === 'Reactionary') {
      return 'reactionary';
    }

    return 'unknown';
  }

  private normalizeHistoryItems(source: CustomerCreditHistoryEntry['items'] | any): CustomerHistoryView['items'] {
    if (!Array.isArray(source)) {
      return [];
    }

    return source
      .map((item: any, index: number) => {
        const quantity = this.toInteger(item?.productQuantity ?? item?.productQuentity);
        const productName = String(item?.productName || '').trim();
        const productCode = String(item?.productCode || '').trim();
        const categoryName = String(item?.categoryName || '').trim();

        if (!productName && !productCode && !categoryName) {
          return null;
        }

        return {
          id: String(item?._id || item?.productId || `${index}`),
          productId: String(item?.productId || '').trim(),
          productName,
          productCode,
          categoryName,
          quantity,
          pricePerEach: this.toNumber(item?.productPricePerEach),
          totalPrice: this.toNumber(item?.totalPrice)
        };
      })
      .filter((item): item is CustomerHistoryView['items'][number] => item !== null);
  }

  private normalizePayments(source: CustomerCreditHistoryEntry['payments'] | any): CustomerHistoryView['payments'] {
    if (!Array.isArray(source)) {
      return [];
    }

    return source
      .map((payment: any, index: number) => {
        const amount = this.toNumber(payment?.amount);
        const paymentDate = payment?.paymentDate ? String(payment.paymentDate) : null;
        const note = String(payment?.note || '').trim();

        if (amount <= 0 && !paymentDate && !note) {
          return null;
        }

        return {
          id: String(payment?._id || `${index}`),
          amount,
          paymentDate,
          note
        };
      })
      .filter((item): item is CustomerHistoryView['payments'][number] => item !== null);
  }

  private isDueSoon(entry: CustomerHistoryView): boolean {
    if (!entry.dueDate || entry.remainingAmount <= 0 || this.isInvoiceOverdue(entry)) {
      return false;
    }

    const dueDate = new Date(entry.dueDate);
    if (Number.isNaN(dueDate.getTime())) {
      return false;
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const dueSoonThreshold = new Date(today);
    dueSoonThreshold.setDate(today.getDate() + 7);
    dueDate.setHours(0, 0, 0, 0);

    return dueDate >= today && dueDate <= dueSoonThreshold;
  }

  private pickFirstNumber(source: Record<string, any>, keys: string[], fallback: number): number {
    for (const key of keys) {
      const value = this.readPath(source, key);
      const normalized = Number(value);
      if (Number.isFinite(normalized)) {
        return normalized;
      }
    }

    return fallback;
  }

  private pickFirstDateValue(
    sources: Array<Record<string, any> | null | undefined>,
    keys: string[]
  ): string | null {
    for (const source of sources) {
      if (!source || typeof source !== 'object') {
        continue;
      }

      for (const key of keys) {
        const value = this.readPath(source, key);
        if (typeof value === 'string' && value.trim()) {
          return value.trim();
        }
      }
    }

    return null;
  }

  private mapCreditInvoiceToPrintData(
    entry: CustomerHistoryView,
    customer: CustomerDetailsView
  ): CreditInvoicePrintData {
    return {
      id: entry.id,
      invoiceId: entry.invoiceId || entry.id,
      invoiceNumber: entry.invoiceId || entry.id,
      customerName: customer.name || '',
      customerPhone: customer.phone || '',
      sellingDate: entry.sellingDate,
      dueDate: entry.dueDate,
      statusLabel: this.getStatusLabel(entry.status),
      itemCount: entry.itemCount,
      totalQuantity: entry.totalQuantity,
      subtotal: entry.subtotal,
      discountPercentage: entry.discountPercentage,
      shippingFees: entry.shippingFees,
      totalPrice: entry.totalPrice,
      paidAmount: entry.paidAmount,
      remainingAmount: entry.remainingAmount,
      footerNote: this.translate.instant('customerDetailsPage.print.footerNote'),
      items: entry.items.map((item) => ({
        id: item.id,
        productCode: item.productCode,
        productName: item.productName,
        categoryName: item.categoryName,
        quantity: item.quantity,
        unitPrice: item.pricePerEach,
        totalPrice: item.totalPrice
      }))
    };
  }

  private extractErrorMessage(error: any, fallbackKey: string): string {
    return (
      error?.error?.message ||
      error?.message ||
      this.translate.instant(fallbackKey)
    );
  }

  private setRefundItems(items: CustomerHistoryView['items']): void {
    this.clearRefundItems();
    items.forEach((item) => {
      this.refundItems.push(
        this.formBuilder.group({
          productId: [item.productId],
          productName: [item.productName],
          productCode: [item.productCode],
          categoryName: [item.categoryName],
          availableQuantity: [item.quantity],
          quantity: [0, [Validators.min(0), Validators.max(item.quantity)]]
        })
      );
    });
  }

  private clearRefundItems(): void {
    while (this.refundItems.length) {
      this.refundItems.removeAt(0);
    }
  }

  private resetPaymentForm(): void {
    this.paymentForm.reset({
      amount: null,
      paymentDate: new Date(),
      note: '',
      firstInvoice: false,
      lastInvoice: true
    });
  }

  private getPayableInvoices(): CustomerHistoryView[] {
    const creditHistory = (this.customer?.creditHistory ?? []) as CustomerHistoryView[];
    return creditHistory.filter((entry) => this.canAddPayment(entry));
  }

  private readPath(source: Record<string, any>, key: string): unknown {
    return key.split('.').reduce<unknown>((current, part) => {
      if (current && typeof current === 'object' && part in (current as Record<string, unknown>)) {
        return (current as Record<string, unknown>)[part];
      }

      return undefined;
    }, source);
  }

  private formatRequestDate(value: unknown): string | undefined {
    const parsedDate = this.parseDateValue(value);
    if (!parsedDate) {
      return undefined;
    }

    return [
      parsedDate.getFullYear(),
      String(parsedDate.getMonth() + 1).padStart(2, '0'),
      String(parsedDate.getDate()).padStart(2, '0')
    ].join('-');
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

  private getInvoiceLanguage(): CreditInvoicePrintLanguage {
    const activeLanguage = (
      this.translate.currentLang ||
      this.translate.getDefaultLang() ||
      'en'
    ).toLowerCase();

    return activeLanguage.startsWith('ar') ? 'ar' : 'en';
  }

  private resolveAssetUrl(assetPath: string): string {
    if (!this.isBrowser) {
      return assetPath;
    }

    return new URL(assetPath, document.baseURI).href;
  }

  private toNumber(value: unknown): number {
    const normalized = Number(value);
    return Number.isFinite(normalized) ? normalized : 0;
  }

  private toNumberOrNull(value: unknown): number | null {
    const normalized = Number(value);
    return Number.isFinite(normalized) ? normalized : null;
  }

  private toNonNegativeNumber(value: unknown): number {
    return Math.max(0, this.toNumber(value));
  }

  private toBoundedPercentage(value: unknown): number {
    return Math.min(100, this.toNonNegativeNumber(value));
  }

  private toOptionalNonNegativeNumber(value: unknown): number | null {
    const normalized = this.toNumberOrNull(value);
    return normalized === null ? null : Math.max(0, normalized);
  }

  private toOptionalBoundedPercentage(value: unknown): number | null {
    const normalized = this.toOptionalNonNegativeNumber(value);
    return normalized === null ? null : Math.min(100, normalized);
  }

  private calculateDiscountPercentageFromAmount(
    subtotal: number,
    discountAmount: number | null
  ): number | null {
    if (discountAmount === null || subtotal <= 0) {
      return null;
    }

    return this.roundCurrency(Math.min((discountAmount / subtotal) * 100, 100));
  }

  private roundCurrency(value: number): number {
    return Number((value || 0).toFixed(2));
  }

  private sumHistoryItemTotals(items: CustomerHistoryView['items']): number {
    return items.reduce((sum, item) => sum + this.toNumber(item.totalPrice), 0);
  }

  private toInteger(value: unknown): number {
    const normalized = Number(value);
    return Number.isFinite(normalized) ? Math.max(0, Math.floor(normalized)) : 0;
  }
}
