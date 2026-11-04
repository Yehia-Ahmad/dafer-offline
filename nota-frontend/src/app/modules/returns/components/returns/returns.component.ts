import { CommonModule, DOCUMENT, isPlatformBrowser } from '@angular/common';
import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  DestroyRef,
  Inject,
  Injectable,
  OnInit,
  PLATFORM_ID,
  TemplateRef,
  ViewChild
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormBuilder, ReactiveFormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatPaginatorIntl, MatPaginatorModule, PageEvent } from '@angular/material/paginator';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatTableModule } from '@angular/material/table';
import { ButtonModule } from 'primeng/button';
import { DatePickerModule } from 'primeng/datepicker';
import { InputTextModule } from 'primeng/inputtext';
import { SelectModule } from 'primeng/select';
import { finalize, forkJoin, takeUntil } from 'rxjs';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { SideNavComponent } from '../../../layout/components/side-nav/side-nav.component';
import { ThemeService } from '../../../shared/services/theme.service';
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
  imports: [
    CommonModule,
    TranslatePipe,
    ReactiveFormsModule,
    SideNavComponent,
    ButtonModule,
    DatePickerModule,
    InputTextModule,
    SelectModule,
    MatButtonModule,
    MatDialogModule,
    MatPaginatorModule,
    MatProgressSpinnerModule,
    MatSnackBarModule,
    MatTableModule
  ],
  templateUrl: './returns.component.html',
  styleUrl: './returns.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [{ provide: MatPaginatorIntl, useClass: ReturnsPaginatorIntl }]
})
export class ReturnsComponent implements OnInit {
  @ViewChild('detailsDialog') private detailsDialog!: TemplateRef<unknown>;

  readonly displayedColumns = [
    'returnDate',
    'returnType',
    'invoiceNumber',
    'customerName',
    'customerPhone',
    'itemsCount',
    'finalReturnedAmount',
    'actions'
  ];
  readonly pageSizeOptions = [10, 25, 50, 100];
  readonly isDarkMode$;
  readonly filtersForm;

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
    private readonly dialog: MatDialog,
    private readonly snackBar: MatSnackBar,
    private readonly themeService: ThemeService,
    private readonly destroyRef: DestroyRef,
    private readonly cdr: ChangeDetectorRef,
    private readonly translate: TranslateService,
    @Inject(PLATFORM_ID) platformId: object,
    @Inject(DOCUMENT) private readonly document: Document
  ) {
    this.isBrowser = isPlatformBrowser(platformId);
    this.isDarkMode$ = this.themeService.isDarkMode$;
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
    this.loadReturns();
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
    const dialogRef = this.dialog.open(this.detailsDialog, {
      width: 'min(1000px, 94vw)',
      maxWidth: '94vw',
      maxHeight: '90vh',
      autoFocus: false,
      panelClass: 'returns-details-dialog'
    });

    this.returnsService.getReturnById(item._id).pipe(
      takeUntilDestroyed(this.destroyRef),
      takeUntil(dialogRef.afterClosed()),
      finalize(() => {
        this.isDetailsLoading = false;
        this.cdr.markForCheck();
      })
    ).subscribe({
      next: (response) => {
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

    dialogRef.afterClosed().pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => {
      this.selectedReturn = null;
      this.detailsErrorMessage = '';
      this.cdr.markForCheck();
    });
  }

  closeDetails(): void {
    this.dialog.closeAll();
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

  formatCurrency(value: number | null | undefined): string {
    return new Intl.NumberFormat(this.translate.currentLang === 'ar' ? 'ar-EG' : 'en-US', {
      style: 'currency',
      currency: 'EGP',
      minimumFractionDigits: 2
    }).format(Number(value ?? 0));
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

  get direction(): 'rtl' | 'ltr' {
    return this.translate.currentLang === 'ar' ? 'rtl' : 'ltr';
  }

  formatType(value: ReturnType): string {
    return this.translate.instant(`returnsPage.types.${value}`);
  }

  trackByReturnId(_: number, item: ReturnLog): string {
    return item._id;
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
