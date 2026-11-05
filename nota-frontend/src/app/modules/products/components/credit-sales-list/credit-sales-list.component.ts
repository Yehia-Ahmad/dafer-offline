import { CommonModule, isPlatformBrowser } from '@angular/common';
import { ChangeDetectorRef, Component, DestroyRef, OnInit, PLATFORM_ID, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormBuilder, FormsModule, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { DatePickerModule } from 'primeng/datepicker';
import { InputNumberModule } from 'primeng/inputnumber';
import { CreditSaleFilters, CreditSaleStatus, CreditSalesService } from '../../services/credit-sales.service';
import {
  creditSaleStatusPill,
  CreditSaleView,
  isCreditSaleOverdue,
  toCreditInvoicePrintData,
  toCreditSaleView
} from '../../../customer/utils/credit-sale-view.util';
import { buildCreditInvoiceDocument } from '../../../customer/components/customer-details/credit-invoice-print.util';
import { ShopProfileService } from '../../../shop-profile/services/shop-profile.service';
import { InvoiceBranding, toPrintableShop } from '../../../shop-profile/utils/invoice-branding.util';
import { brandName } from '../../../../core/brand';
import {
  NotaButtonDirective,
  NotaFormFieldComponent,
  NotaMoneyPipe,
  NotaNumberPipe,
  NotaPageHeaderComponent
} from '../../../shared/ui';
import { NotaCanDirective } from '../../../../core/auth/nota-can.directive';
import { LockedActionComponent } from '../../../../core/auth/locked-action.component';

/** Status pills map to the API `status` values (Reactionary = fully returned). */
export type CreditListStatusFilter = '' | CreditSaleStatus | 'Reactionary';

type ListPagination = { page: number; limit: number; totalItems: number; totalPages: number; hasNextPage: boolean; hasPrevPage: boolean };

const PAGE_SIZE = 10;

/**
 * /credit-sales list (docs/design/screens/CreditSales.dc.html, Stage 10). Uses the existing GET /credit-sales
 * (customerName | customerPhone, status, page, limit) and records payments with the same
 * POST /credit-sales/:id/payments body the customer page sends. New invoices: /credit-sales/new.
 */
@Component({
  selector: 'app-credit-sales-list',
  standalone: true,
  imports: [LockedActionComponent, NotaCanDirective, CommonModule, FormsModule, ReactiveFormsModule, RouterLink, TranslatePipe, DatePickerModule, InputNumberModule,
    NotaButtonDirective, NotaFormFieldComponent, NotaMoneyPipe, NotaNumberPipe, NotaPageHeaderComponent],
  templateUrl: './credit-sales-list.component.html',
  styleUrl: './credit-sales-list.component.scss'
})
export class CreditSalesListComponent implements OnInit {
  private readonly creditSalesService = inject(CreditSalesService);
  private readonly shopProfileService = inject(ShopProfileService);
  private readonly translate = inject(TranslateService);
  private readonly cdr = inject(ChangeDetectorRef);
  private readonly destroyRef = inject(DestroyRef);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  readonly statusFilters: CreditListStatusFilter[] = ['', 'pending', 'partially_paid', 'paid', 'Reactionary'];

  query = '';
  status: CreditListStatusFilter = '';
  rows: CreditSaleView[] = [];
  pagination: ListPagination = { page: 1, limit: PAGE_SIZE, totalItems: 0, totalPages: 1, hasNextPage: false, hasPrevPage: false };
  isLoading = false;
  loadError = '';
  selected: CreditSaleView | null = null;
  printingId = '';
  printError = '';

  readonly paymentForm = inject(FormBuilder).group({
    amount: [null as number | null, [Validators.required, Validators.min(0.01)]],
    paymentDate: [new Date() as Date | null, Validators.required],
    note: ['']
  });
  paymentSubmitAttempted = false;
  isSavingPayment = false;
  paymentError = '';
  paymentSaved = false;

  ngOnInit(): void {
    if (this.isBrowser) {
      // Cached for printing; without it the invoice prints with a neutral header.
      this.shopProfileService.refresh();
    }
    this.load(1);
  }

  /** The filter params as GET /credit-sales takes them. Digits → customerPhone, otherwise customerName. */
  buildParams(page: number): CreditSaleFilters {
    const query = this.query.trim();
    const byPhone = /^[\d\s+()-]+$/.test(query);
    return {
      ...(query ? (byPhone ? { customerPhone: query } : { customerName: query }) : {}),
      ...(this.status ? { status: this.status as CreditSaleStatus } : {}),
      page,
      limit: PAGE_SIZE
    };
  }

  search(): void {
    this.load(1);
  }

  clearSearch(): void {
    this.query = '';
    this.load(1);
  }

  setStatus(status: CreditListStatusFilter): void {
    if (this.status === status) return;
    this.status = status;
    this.load(1);
  }

  goToPage(page: number): void {
    if (this.isLoading || page < 1 || page > Math.max(1, this.pagination.totalPages) || page === this.pagination.page) return;
    this.load(page);
  }

  select(row: CreditSaleView): void {
    if (this.selected?.id === row.id) return;
    this.selected = row;
    this.resetPaymentForm();
  }

  load(page: number): void {
    this.isLoading = true;
    this.loadError = '';
    const keepId = this.selected?.id;

    this.creditSalesService.getCreditSales(this.buildParams(page)).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (response: any) => {
        const list: any[] = Array.isArray(response) ? response : Array.isArray(response?.data) ? response.data : [];
        this.rows = list.map((item) => toCreditSaleView(item)).filter((item): item is CreditSaleView => item !== null);
        this.pagination = this.extractPagination(response, page);
        const kept = this.rows.find((row) => row.id === keepId);
        if (!kept) this.resetPaymentForm();
        this.selected = kept ?? this.rows[0] ?? null;
        this.isLoading = false;
        this.cdr.markForCheck();
      },
      error: (error: any) => {
        this.rows = [];
        this.selected = null;
        this.isLoading = false;
        this.loadError = error?.error?.message || this.translate.instant('creditSalePage.list.loadFailed');
        this.cdr.markForCheck();
      }
    });
  }

  // ---------- KPIs (total from the API; sums only for the shown page, labelled as such) ----------

  get pageRemaining(): number {
    return this.rows.reduce((sum, row) => sum + row.remainingAmount, 0);
  }

  get pageOverdue(): number {
    return this.rows.filter((row) => this.isOverdue(row)).length;
  }

  get pageRangeFrom(): number {
    return this.rows.length ? (this.pagination.page - 1) * this.pagination.limit + 1 : 0;
  }

  isOverdue(row: CreditSaleView): boolean {
    return isCreditSaleOverdue(row);
  }

  statusPill(row: CreditSaleView): string {
    return creditSaleStatusPill(row.status, this.isOverdue(row));
  }

  statusKey(row: CreditSaleView): string {
    return this.isOverdue(row) ? 'creditSalePage.list.status.overdue' : `creditSalePage.list.status.${row.status}`;
  }

  shortRef(id: string): string {
    return id ? `#${id.slice(-6).toUpperCase()}` : '—';
  }

  canPay(row: CreditSaleView | null): boolean {
    return !!row?.id && row.remainingAmount > 0 && row.status !== 'paid';
  }

  // ---------- Payment (same request body as CustomerDetailsComponent.savePayment) ----------

  savePayment(): void {
    this.paymentSubmitAttempted = true;
    this.paymentError = '';
    this.paymentSaved = false;
    const invoice = this.selected;

    if (!invoice?.id || !this.canPay(invoice) || this.paymentForm.invalid || this.isSavingPayment) {
      this.paymentForm.markAllAsTouched();
      return;
    }

    this.isSavingPayment = true;
    const raw = this.paymentForm.getRawValue();
    this.creditSalesService.recordPayment(invoice.id, {
      amount: this.toNumber(raw.amount),
      paymentDate: this.formatRequestDate(raw.paymentDate),
      note: String(raw.note || '').trim() || undefined
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.isSavingPayment = false;
        this.resetPaymentForm();
        this.paymentSaved = true;
        this.load(this.pagination.page);
      },
      error: (error: any) => {
        this.isSavingPayment = false;
        this.paymentError = error?.error?.message || error?.message || this.translate.instant('customerDetailsPage.messages.paymentFailed');
        this.cdr.markForCheck();
      }
    });
  }

  // ---------- Print (existing credit-invoice print util) ----------

  print(row: CreditSaleView): void {
    if (!this.isBrowser || !row?.id) return;
    this.printingId = row.id;
    this.printError = '';
    try {
      const invoiceWindow = window.open('', '_blank', 'width=1180,height=860');
      if (!invoiceWindow) {
        this.printError = this.translate.instant('invoiceHistoryPage.messages.invoiceWindowBlocked');
        return;
      }
      invoiceWindow.document.open();
      invoiceWindow.document.write(buildCreditInvoiceDocument({
        invoice: toCreditInvoicePrintData(row, row.customerName, row.customerPhone, this.translate.instant(`customerDetailsPage.status.${row.status}`)),
        language: this.printLanguage(),
        branding: this.branding(),
        fontUrls: {
          arabic: new URL('assets/fonts/alexandria/alexandria-arabic-wght-normal.woff2', document.baseURI).href,
          latin: new URL('assets/fonts/alexandria/alexandria-latin-wght-normal.woff2', document.baseURI).href,
        },
      }));
      invoiceWindow.document.close();
      invoiceWindow.focus();
    } catch {
      this.printError = this.translate.instant('invoiceHistoryPage.messages.invoiceDownloadFailed');
    } finally {
      this.printingId = '';
    }
  }

  private branding(): InvoiceBranding {
    return {
      shop: toPrintableShop(this.shopProfileService.profile()),
      texts: {
        neutralTitle: this.translate.instant('invoicePrint.creditTitle'),
        systemNote: this.translate.instant('invoicePrint.systemNote', { appName: brandName(this.translate.currentLang) }),
        taxNumberLabel: this.translate.instant('invoicePrint.taxNumber'),
        commercialRegisterLabel: this.translate.instant('invoicePrint.commercialRegister')
      }
    };
  }

  private printLanguage(): 'ar' | 'en' {
    return (this.translate.currentLang || this.translate.getDefaultLang() || 'en').toLowerCase().startsWith('ar') ? 'ar' : 'en';
  }

  formatDate(value: string | null | undefined): string {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleDateString(this.translate.currentLang === 'ar' ? 'ar-EG' : 'en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  }

  private resetPaymentForm(): void {
    this.paymentForm.reset({ amount: null, paymentDate: new Date(), note: '' });
    this.paymentSubmitAttempted = false;
    this.paymentError = '';
    this.paymentSaved = false;
  }

  private extractPagination(response: any, page: number): ListPagination {
    const source = response?.pagination ?? {};
    const totalItems = Number(source.totalItems) || this.rows.length;
    const totalPages = Number(source.totalPages) || 1;
    return {
      page: Number(source.page) || page,
      limit: Number(source.limit) || PAGE_SIZE,
      totalItems,
      totalPages,
      hasNextPage: Boolean(source.hasNextPage ?? page < totalPages),
      hasPrevPage: Boolean(source.hasPrevPage ?? page > 1)
    };
  }

  /** Same yyyy-MM-dd (local date) the customer page sends. */
  private formatRequestDate(value: unknown): string | undefined {
    const date = value instanceof Date ? value : typeof value === 'string' || typeof value === 'number' ? new Date(value) : null;
    if (!date || Number.isNaN(date.getTime())) return undefined;
    return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
  }

  private toNumber(value: unknown): number {
    const normalized = Number(value);
    return Number.isFinite(normalized) ? normalized : 0;
  }
}
