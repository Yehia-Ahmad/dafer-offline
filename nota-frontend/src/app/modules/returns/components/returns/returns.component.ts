import { CommonModule, DOCUMENT, isPlatformBrowser } from '@angular/common';
import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  DestroyRef,
  Inject,
  Injectable,
  inject,
  OnInit,
  PLATFORM_ID
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormBuilder, ReactiveFormsModule } from '@angular/forms';
import { FormsModule } from '@angular/forms';
import { MatPaginatorIntl, MatPaginatorModule, PageEvent } from '@angular/material/paginator';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { DatePickerModule } from 'primeng/datepicker';
import { Dialog } from 'primeng/dialog';
import { SelectModule } from 'primeng/select';
import { finalize, forkJoin } from 'rxjs';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { ProductsService } from '../../../products/services/products.service';
import { CreditSalesService } from '../../../products/services/credit-sales.service';
import { toCreditSaleView } from '../../../customer/utils/credit-sale-view.util';
import {
  NotaButtonDirective,
  NotaDialogShellComponent,
  NotaFormFieldComponent,
  NotaMoneyPipe,
  NotaNumberPipe,
  NotaPageHeaderComponent
} from '../../../shared/ui';
import {
  ApiDataResponse,
  ReturnLog,
  ReturnsFilters,
  ReturnsListResponse,
  ReturnsPagination,
  ReturnsSummary,
  ReturnType
} from '../../models/returns.model';
import { ReturnsService } from '../../services/returns.service';
import { NotaCanDirective } from '../../../../core/auth/nota-can.directive';
import { PaymentBoxSelectComponent } from '../../../cashbox/payment-box-select.component';
import { PaymentBoxService } from '../../../cashbox/payment-box.service';
import { AuthService } from '../../../../core/auth/auth.service';
import { RouterLink } from '@angular/router';

type FilterFormValue = {
  returnType: ReturnType | '';
  customerName: string;
  customerPhone: string;
  productCode: string;
  invoiceId: string;
  dateFrom: Date | null;
  dateTo: Date | null;
};

const EMPTY_SUMMARY: ReturnsSummary = {
  totalCashReturns: 0,
  totalCreditReturns: 0,
  totalReturnedAmount: 0,
  totalReturnedItems: 0
};

/** New-return wizard (Stage 10): one invoice, cash or credit, as the wizard shows it. */
export type WizardInvoice = {
  id: string;
  type: ReturnType;
  label: string;
  customerName: string;
  customerPhone: string;
  date: string | null;
  total: number;
  remaining: number | null;
  items: Array<{ productId: string; productName: string; productCode: string; quantity: number; unitPrice: number }>;
  returnedByProduct: Record<string, number>;
};

export type WizardLine = {
  productId: string;
  productName: string;
  productCode: string;
  sold: number;
  returnedBefore: number;
  quantity: number;
  unitPrice: number;
  reason: string;
};

const DEFAULT_PAGINATION: ReturnsPagination = {
  page: 1,
  limit: 10,
  totalItems: 0,
  totalPages: 0,
  hasNextPage: false,
  hasPrevPage: false
};

@Injectable()
class ReturnsPaginatorIntl extends MatPaginatorIntl {
  constructor(
    private readonly translate: TranslateService,
    destroyRef: DestroyRef
  ) {
    super();
    this.updateLabels();
    this.translate.onLangChange.pipe(takeUntilDestroyed(destroyRef)).subscribe(() => {
      this.updateLabels();
      this.changes.next();
    });
  }

  override getRangeLabel = (page: number, pageSize: number, length: number): string => {
    if (length === 0 || pageSize === 0) {
      return this.translate.instant('returnsPage.pagination.range', { start: 0, end: 0, total: length });
    }
    const start = page * pageSize;
    const end = Math.min(start + pageSize, length);
    return this.translate.instant('returnsPage.pagination.range', {
      start: start + 1,
      end,
      total: length
    });
  };

  private updateLabels(): void {
    this.itemsPerPageLabel = this.translate.instant('returnsPage.pagination.itemsPerPage');
    this.nextPageLabel = this.translate.instant('returnsPage.pagination.next');
    this.previousPageLabel = this.translate.instant('returnsPage.pagination.previous');
    this.firstPageLabel = this.translate.instant('returnsPage.pagination.first');
    this.lastPageLabel = this.translate.instant('returnsPage.pagination.last');
  }
}

@Component({
  selector: 'app-returns',
  standalone: true,
  imports: [NotaCanDirective, PaymentBoxSelectComponent, RouterLink,
    CommonModule,
    TranslatePipe,
    ReactiveFormsModule,
    FormsModule,
    DatePickerModule,
    Dialog,
    SelectModule,
    MatPaginatorModule,
    MatSnackBarModule,
    NotaButtonDirective,
    NotaDialogShellComponent,
    NotaFormFieldComponent,
    NotaMoneyPipe,
    NotaNumberPipe,
    NotaPageHeaderComponent
  ],
  templateUrl: './returns.component.html',
  styleUrl: './returns.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [{ provide: MatPaginatorIntl, useClass: ReturnsPaginatorIntl }]
})
export class ReturnsComponent implements OnInit {
  private readonly _auth = inject(AuthService);
  /** Stage 19: the box a cash refund comes out of. */
  readonly payment = inject(PaymentBoxService);
  readonly pageSizeOptions = [10, 25, 50, 100];
  readonly filtersForm;
  /** Details dialog (p-dialog + dialog shell since Stage 10; same GET returns/:id). */
  detailsVisible = false;

  // ---------- New-return wizard (Stage 10) ----------
  view: 'log' | 'wizard' = 'log';
  wizardStep: 1 | 2 | 3 = 1;
  wizardType: ReturnType = 'cash';
  wizardQuery = '';
  wizardResults: WizardInvoice[] = [];
  wizardSearching = false;
  wizardSearched = false;
  wizardError = '';
  wizardInvoice: WizardInvoice | null = null;
  wizardLines: WizardLine[] = [];
  wizardDate: Date = new Date();
  wizardNote = '';
  wizardSaving = false;
  wizardSaveError = '';

  get returnTypeOptions(): Array<{ label: string; value: ReturnType | '' }> {
    return [
      { label: this.translate.instant('returnsPage.types.all'), value: '' },
      { label: this.translate.instant('returnsPage.types.cash'), value: 'cash' },
      { label: this.translate.instant('returnsPage.types.credit'), value: 'credit' }
    ];
  }

  returns: ReturnLog[] = [];
  summary: ReturnsSummary = { ...EMPTY_SUMMARY };
  pagination: ReturnsPagination = { ...DEFAULT_PAGINATION };
  selectedReturn: ReturnLog | null = null;
  isLoading = false;
  isDetailsLoading = false;
  isExporting = false;
  errorMessage = '';
  detailsErrorMessage = '';

  private appliedFilters: Omit<ReturnsFilters, 'page' | 'limit'> = {};
  private readonly isBrowser: boolean;

  constructor(
    private readonly fb: FormBuilder,
    private readonly returnsService: ReturnsService,
    private readonly productsService: ProductsService,
    private readonly creditSalesService: CreditSalesService,
    private readonly snackBar: MatSnackBar,
    private readonly destroyRef: DestroyRef,
    private readonly cdr: ChangeDetectorRef,
    private readonly translate: TranslateService,
    @Inject(PLATFORM_ID) platformId: object,
    @Inject(DOCUMENT) private readonly document: Document
  ) {
    this.isBrowser = isPlatformBrowser(platformId);
    this.filtersForm = this.fb.group({
      returnType: this.fb.control<ReturnType | ''>(''),
      customerName: this.fb.nonNullable.control(''),
      customerPhone: this.fb.nonNullable.control(''),
      productCode: this.fb.nonNullable.control(''),
      invoiceId: this.fb.nonNullable.control(''),
      dateFrom: this.fb.control<Date | null>(null),
      dateTo: this.fb.control<Date | null>(null)
    });
  }

  ngOnInit(): void {
    // Stage 14: the log needs returns.view; a user who may only record returns (the cashier
    // template) opens straight on the new-return wizard and never requests the log.
    if (this._auth.has('returns.view')) {
      this.loadReturns();
    } else {
      this.openWizard();
    }
  }

  search(): void {
    if (!this.isValidDateRange()) return;
    this.appliedFilters = this.buildFilters(this.filtersForm.getRawValue());
    this.pagination.page = 1;
    this.loadReturns();
  }

  resetFilters(): void {
    this.filtersForm.reset({
      returnType: '',
      customerName: '',
      customerPhone: '',
      productCode: '',
      invoiceId: '',
      dateFrom: null,
      dateTo: null
    });
    this.appliedFilters = {};
    this.pagination = { ...DEFAULT_PAGINATION, limit: this.pagination.limit };
    this.loadReturns();
  }

  onPageChange(event: PageEvent): void {
    const nextPage = event.pageIndex + 1;
    if (nextPage === this.pagination.page && event.pageSize === this.pagination.limit) return;
    this.pagination.page = event.pageSize !== this.pagination.limit ? 1 : nextPage;
    this.pagination.limit = event.pageSize;
    this.loadReturns();
  }

  viewDetails(item: ReturnLog): void {
    this.selectedReturn = item;
    this.detailsErrorMessage = '';
    this.isDetailsLoading = true;
    this.detailsVisible = true;
    const requestedId = item._id;

    this.returnsService.getReturnById(item._id).pipe(
      takeUntilDestroyed(this.destroyRef),
      finalize(() => {
        this.isDetailsLoading = false;
        this.cdr.markForCheck();
      })
    ).subscribe({
      next: (response) => {
        if (!this.detailsVisible || this.selectedReturn?._id !== requestedId) return;
        this.selectedReturn = this.unwrapData(response);
        this.cdr.markForCheck();
      },
      error: (error) => {
        this.detailsErrorMessage = this.getErrorMessage(
          error,
          this.translate.instant('returnsPage.messages.detailsLoadFailed')
        );
        this.cdr.markForCheck();
      }
    });

  }

  closeDetails(): void {
    this.detailsVisible = false;
    this.selectedReturn = null;
    this.detailsErrorMessage = '';
    this.cdr.markForCheck();
  }

  async exportToExcel(): Promise<void> {
    if (!this.isBrowser || this.isExporting || this.returns.length === 0) return;
    this.isExporting = true;
    this.cdr.markForCheck();

    try {
      const { Workbook } = await import('exceljs');
      const workbook = new Workbook();
      const worksheet = workbook.addWorksheet(this.translate.instant('returnsPage.title'));

      worksheet.columns = [
        { header: this.translate.instant('returnsPage.fields.returnDate'), key: 'returnDate', width: 16 },
        { header: this.translate.instant('returnsPage.fields.type'), key: 'type', width: 12 },
        { header: this.translate.instant('returnsPage.fields.invoiceNumber'), key: 'invoiceNumber', width: 20 },
        { header: this.translate.instant('returnsPage.fields.customerName'), key: 'customerName', width: 28 },
        { header: this.translate.instant('returnsPage.fields.customerPhone'), key: 'customerPhone', width: 22 },
        { header: this.translate.instant('returnsPage.fields.itemsCount'), key: 'itemsCount', width: 14 },
        { header: this.translate.instant('returnsPage.fields.finalReturnedAmount'), key: 'finalReturnedAmount', width: 24 }
      ];
      this.returns.forEach((item) => worksheet.addRow({
        returnDate: item.returnDate,
        type: this.formatType(item.returnType),
        invoiceNumber: item.invoiceNumber,
        customerName: item.customerName,
        customerPhone: item.customerPhone,
        itemsCount: item.items?.length ?? 0,
        finalReturnedAmount: item.finalReturnedAmount
      }));

      worksheet.views = [{ state: 'frozen', ySplit: 1 }];
      worksheet.autoFilter = { from: 'A1', to: 'G1' };
      worksheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
      worksheet.getRow(1).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFFF9933' }
      };
      worksheet.getColumn('finalReturnedAmount').numFmt = '#,##0.00';

      const buffer = await workbook.xlsx.writeBuffer();
      this.downloadBlob(new Blob([buffer as ArrayBuffer], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      }), 'returns-log.xlsx');
      this.snackBar.open(this.translate.instant('returnsPage.messages.exportSuccess'), undefined, {
        duration: 3000
      });
    } catch (error) {
      this.snackBar.open(this.getErrorMessage(
        error,
        this.translate.instant('returnsPage.messages.exportFailed')
      ), this.translate.instant('returnsPage.actions.close'), {
        duration: 5000
      });
    } finally {
      this.isExporting = false;
      this.cdr.markForCheck();
    }
  }

  formatDisplayDate(value: string | null | undefined): string {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return new Intl.DateTimeFormat(this.translate.currentLang === 'ar' ? 'ar-EG' : 'en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    }).format(date);
  }

  formatType(value: ReturnType): string {
    return this.translate.instant(`returnsPage.types.${value}`);
  }

  trackByReturnId(_: number, item: ReturnLog): string {
    return item._id;
  }

  get pageRangeFrom(): number {
    return this.returns.length ? (this.pagination.page - 1) * this.pagination.limit + 1 : 0;
  }

  // ---------- New-return wizard ----------

  openWizard(): void {
    this.view = 'wizard';
    this.resetWizard();
  }

  closeWizard(): void {
    if (this.wizardSaving) return;
    this.view = 'log';
    this.resetWizard();
  }

  setWizardType(type: ReturnType): void {
    if (this.wizardType === type) return;
    this.wizardType = type;
    this.wizardResults = [];
    this.wizardSearched = false;
    this.wizardError = '';
  }

  /** Same list endpoints the other screens use: GET sellings (cash) / GET credit-sales (credit). Digits → phone. */
  searchWizardInvoices(): void {
    const rawQuery = this.wizardQuery.trim();
    const query = /^(INV|CR)-\d+$/i.test(rawQuery) ? rawQuery.toUpperCase() : rawQuery;
    if (!query || this.wizardSearching) return;
    const byNumber = /^(INV|CR)-\d+$/i.test(query);
    const byPhone = !byNumber && /^[\d\s+()-]+$/.test(query);
    const filter = byNumber ? { number: query } : byPhone ? { customerPhone: query } : { customerName: query };
    this.wizardSearching = true;
    this.wizardError = '';
    const type = this.wizardType;
    const request$ = type === 'cash'
      ? this.productsService.getSellings({ ...filter, page: 1, limit: 10 })
      : this.creditSalesService.getCreditSales({ ...filter, page: 1, limit: 10 });

    request$.pipe(
      takeUntilDestroyed(this.destroyRef),
      finalize(() => {
        this.wizardSearching = false;
        this.wizardSearched = true;
        this.cdr.markForCheck();
      })
    ).subscribe({
      next: (response: any) => {
        if (type !== this.wizardType) return;
        const list: any[] = Array.isArray(response) ? response : Array.isArray(response?.data) ? response.data : [];
        this.wizardResults = list
          .map((item) => (type === 'cash' ? this.toCashWizardInvoice(item) : this.toCreditWizardInvoice(item)))
          .filter((item): item is WizardInvoice => !!item && item.items.length > 0);
      },
      error: (error) => {
        this.wizardResults = [];
        this.wizardError = this.getErrorMessage(error, this.translate.instant('returnsPage.s10.wizard.searchFailed'));
      }
    });
  }

  pickWizardInvoice(invoice: WizardInvoice): void {
    this.wizardInvoice = invoice;
    this.wizardLines = invoice.items
      .filter((item) => item.productId && item.quantity > 0)
      .map((item) => ({
        productId: item.productId,
        productName: item.productName,
        productCode: item.productCode,
        sold: item.quantity,
        returnedBefore: invoice.returnedByProduct[item.productId] ?? 0,
        quantity: 0,
        unitPrice: item.unitPrice,
        reason: ''
      }));
    this.wizardSaveError = '';
    this.wizardStep = 2;
  }

  stepWizardQuantity(line: WizardLine, delta: number): void {
    line.quantity = Math.min(line.sold, Math.max(0, Math.floor(Number(line.quantity) || 0) + delta));
  }

  wizardReturnAll(): void {
    this.wizardLines.forEach((line) => (line.quantity = line.sold));
  }

  wizardClear(): void {
    this.wizardLines.forEach((line) => (line.quantity = 0));
  }

  get wizardSelectedLines(): WizardLine[] {
    return this.wizardLines.filter((line) => this.wizardQuantityOf(line) > 0);
  }

  /** Σ quantity × unit price, before any invoice discount (the backend computes the final amount). */
  get wizardEstimatedAmount(): number {
    return this.wizardSelectedLines.reduce((sum, line) => sum + this.wizardQuantityOf(line) * line.unitPrice, 0);
  }

  goToWizardStep(step: 1 | 2 | 3): void {
    if (step === 3 && !this.wizardSelectedLines.length) return;
    if (step >= 2 && !this.wizardInvoice) return;
    this.wizardStep = step;
  }

  /**
   * POST /returns with the body each existing screen sends today: cash = the invoice-history dialog,
   * credit = the customer page refund dialog (plus returnReason per item only when filled; the API accepts it).
   */
  confirmWizardReturn(): void {
    const invoice = this.wizardInvoice;
    const lines = this.wizardSelectedLines;
    if (!invoice || !lines.length || this.wizardSaving) return;

    const note = this.wizardNote.trim();
    const items = lines.map((line) => ({
      productId: line.productId,
      quantity: this.wizardQuantityOf(line),
      ...(line.reason.trim() ? { returnReason: line.reason.trim() } : {})
    }));
    const payload = invoice.type === 'cash'
      ? {
          returnType: 'cash' as const,
          invoiceId: invoice.id,
          returnDate: this.toIsoDate(this.wizardDate),
          ...(note ? { note } : {}),
          ...(this.payment.boxId() ? { boxId: this.payment.boxId() } : {}),
          items
        }
      : {
          returnType: 'credit' as const,
          invoiceId: invoice.id,
          refundDate: this.formatDate(this.wizardDate),
          note: note || undefined,
          items
        };
    if (payload.returnType === 'cash' && !payload.returnDate) return;

    this.wizardSaving = true;
    this.wizardSaveError = '';
    this.returnsService.createReturn(payload).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.wizardSaving = false;
        this.snackBar.open(this.translate.instant('returnsPage.s10.wizard.saved'), undefined, { duration: 3000 });
        this.resetWizard();
        if (this._auth.has('returns.view')) {
          this.view = 'log';
          this.loadReturns();
        }
      },
      error: (error) => {
        this.wizardSaving = false;
        this.wizardSaveError = this.getErrorMessage(error, this.translate.instant('returnsPage.s10.wizard.saveFailed'));
        this.cdr.markForCheck();
      }
    });
  }

  private wizardQuantityOf(line: WizardLine): number {
    return Math.min(line.sold, Math.max(0, Math.floor(Number(line.quantity) || 0)));
  }

  private resetWizard(): void {
    this.wizardStep = 1;
    this.wizardQuery = '';
    this.wizardResults = [];
    this.wizardSearched = false;
    this.wizardError = '';
    this.wizardInvoice = null;
    this.wizardLines = [];
    this.wizardDate = new Date();
    this.wizardNote = '';
    this.wizardSaveError = '';
  }

  private toCashWizardInvoice(source: any): WizardInvoice | null {
    const id = String(source?.invoiceId || source?._id || source?.id || '');
    if (!id || source?.status === 'cancelled' || source?.refundStatus === 'full') return null;
    const items = (Array.isArray(source?.items) ? source.items : []).map((item: any) => ({
      productId: String(item?.productId || ''),
      productName: String(item?.productName || ''),
      productCode: String(item?.productCode || ''),
      quantity: Math.max(0, Math.floor(Number(item?.productQuantity ?? item?.productQuentity ?? item?.quantity) || 0)),
      unitPrice: Number(item?.productPricePerEach ?? item?.price) || 0
    }));
    return {
      id, type: 'cash', label: String(source?.number || source?.invoiceNumber || id),
      customerName: String(source?.customerName || ''), customerPhone: String(source?.customerPhone || ''),
      date: source?.sellingDate ? String(source.sellingDate) : null, total: Number(source?.totalPrice) || 0, remaining: null,
      items, returnedByProduct: this.sumReturned(source?.refunds)
    };
  }

  private toCreditWizardInvoice(source: any): WizardInvoice | null {
    const view = toCreditSaleView(source);
    if (!view || view.status === 'cancelled' || view.status === 'returned') return null;
    return {
      id: view.id, type: 'credit', label: view.number,
      customerName: view.customerName, customerPhone: view.customerPhone, date: view.sellingDate,
      total: view.totalPrice, remaining: view.remainingAmount,
      items: view.items.map((item) => ({
        productId: item.productId, productName: item.productName, productCode: item.productCode, quantity: item.quantity, unitPrice: item.pricePerEach
      })),
      returnedByProduct: this.sumReturned(source?.refunds)
    };
  }

  private sumReturned(refunds: any): Record<string, number> {
    const totals: Record<string, number> = {};
    (Array.isArray(refunds) ? refunds : []).forEach((refund: any) =>
      (Array.isArray(refund?.items) ? refund.items : []).forEach((item: any) => {
        const productId = String(item?.productId || '');
        if (productId) totals[productId] = (totals[productId] ?? 0) + (Number(item?.quantity) || 0);
      })
    );
    return totals;
  }

  /** Same date format the invoice-history cash return sends (ISO date part). */
  private toIsoDate(value: Date | null): string | undefined {
    if (!value) return undefined;
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return undefined;
    return date.toISOString().split('T')[0];
  }

  private loadReturns(): void {
    this.isLoading = true;
    this.errorMessage = '';
    const filters: ReturnsFilters = {
      ...this.appliedFilters,
      page: this.pagination.page,
      limit: this.pagination.limit
    };

    forkJoin({
      list: this.returnsService.getReturns(filters),
      summary: this.returnsService.getReturnsSummary(this.appliedFilters)
    }).pipe(
      takeUntilDestroyed(this.destroyRef),
      finalize(() => {
        this.isLoading = false;
        this.cdr.markForCheck();
      })
    ).subscribe({
      next: ({ list, summary }) => {
        this.returns = Array.isArray(list.data) ? list.data : [];
        this.pagination = { ...DEFAULT_PAGINATION, ...list.pagination };
        this.summary = { ...EMPTY_SUMMARY, ...this.unwrapData(summary) };
      },
      error: (error) => {
        this.returns = [];
        this.summary = { ...EMPTY_SUMMARY };
        this.pagination = { ...DEFAULT_PAGINATION, limit: this.pagination.limit };
        this.errorMessage = this.getErrorMessage(
          error,
          this.translate.instant('returnsPage.messages.loadFailed')
        );
      }
    });
  }

  private buildFilters(value: FilterFormValue): Omit<ReturnsFilters, 'page' | 'limit'> {
    return {
      ...(value.returnType ? { returnType: value.returnType } : {}),
      ...this.textFilter('customerName', value.customerName),
      ...this.textFilter('customerPhone', value.customerPhone),
      ...this.textFilter('productCode', value.productCode),
      ...this.textFilter('invoiceId', value.invoiceId),
      ...(value.dateFrom ? { dateFrom: this.formatDate(value.dateFrom) } : {}),
      ...(value.dateTo ? { dateTo: this.formatDate(value.dateTo) } : {})
    };
  }

  private textFilter<K extends 'customerName' | 'customerPhone' | 'productCode' | 'invoiceId'>(
    key: K,
    value: string
  ): Partial<Pick<ReturnsFilters, K>> {
    const normalized = value.trim();
    return normalized ? ({ [key]: normalized } as Pick<ReturnsFilters, K>) : {};
  }

  private isValidDateRange(): boolean {
    const { dateFrom, dateTo } = this.filtersForm.getRawValue();
    if (dateFrom && dateTo && dateFrom.getTime() > dateTo.getTime()) {
      this.snackBar.open(
        this.translate.instant('returnsPage.messages.invalidDateRange'),
        this.translate.instant('returnsPage.actions.close'),
        { duration: 5000 }
      );
      return false;
    }
    return true;
  }

  private formatDate(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  private unwrapData<T>(response: T | ApiDataResponse<T>): T {
    return response && typeof response === 'object' && 'data' in response
      ? (response as ApiDataResponse<T>).data
      : response as T;
  }

  private getErrorMessage(error: unknown, fallback: string): string {
    if (error && typeof error === 'object') {
      const candidate = error as { error?: { message?: string }; message?: string };
      return candidate.error?.message || candidate.message || fallback;
    }
    return fallback;
  }

  private downloadBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const anchor = this.document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    this.document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }
}
