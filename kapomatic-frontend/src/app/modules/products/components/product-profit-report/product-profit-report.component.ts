import { CommonModule, isPlatformBrowser } from '@angular/common';
import { ChangeDetectorRef, Component, Inject, OnInit, PLATFORM_ID } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { format as formatDate } from 'date-fns';
import { firstValueFrom } from 'rxjs';
import { ButtonModule } from 'primeng/button';
import { DatePickerModule } from 'primeng/datepicker';
import { DialogModule } from 'primeng/dialog';
import { SelectModule } from 'primeng/select';
import { TableModule } from 'primeng/table';
import { CateoryService } from '../../../category/services/cateory.service';
import { SideNavComponent } from '../../../layout/components/side-nav/side-nav.component';
import { HOME_VIEW_STORAGE_KEY } from '../../../layout/constants/home-view.constants';
import { ThemeService } from '../../../shared/services/theme.service';
import {
  ProductProfitReportInvoice,
  ProductProfitReportRow,
  ProductsService
} from '../../services/products.service';
import { ProfitBarService, YearProfitBarResponse } from '../../services/profit-bar.service';

type SelectOption = {
  label: string;
  value: string;
};

@Component({
  selector: 'app-product-profit-report',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    SideNavComponent,
    TranslatePipe,
    TableModule,
    SelectModule,
    DatePickerModule,
    ButtonModule,
    DialogModule
  ],
  templateUrl: './product-profit-report.component.html',
  styleUrl: './product-profit-report.component.scss'
})
export class ProductProfitReportComponent implements OnInit {
  isDarkMode$;
  private readonly isBrowser: boolean;
  isLoading = false;
  loadError = '';
  reports: ProductProfitReportRow[] = [];
  categoryOptions: SelectOption[] = [];
  productOptions: SelectOption[] = [];
  isCategoriesLoading = false;
  isProductsLoading = false;
  filterCategoryId = '';
  filterProductId = '';
  filterDateFrom: Date | null = null;
  filterDateTo: Date | null = null;
  invoiceDialogVisible = false;
  selectedReportRow: ProductProfitReportRow | null = null;
  profitYear = new Date().getFullYear();
  maxProfitYear = new Date().getFullYear() + 5;
  isPdfGenerating = false;
  pdfError = '';

  constructor(
    private readonly themeService: ThemeService,
    private readonly router: Router,
    private readonly productsService: ProductsService,
    private readonly profitBarService: ProfitBarService,
    private readonly categoryService: CateoryService,
    private readonly translate: TranslateService,
    private readonly cdr: ChangeDetectorRef,
    @Inject(PLATFORM_ID) platformId: object
  ) {
    this.isDarkMode$ = this.themeService.isDarkMode$;
    this.isBrowser = isPlatformBrowser(platformId);
  }

  ngOnInit(): void {
    if (this.isBrowser) {
      localStorage.setItem(HOME_VIEW_STORAGE_KEY, 'profit-report');
    }

    this.loadCategories();
    this.loadProfitReport();
  }

  backToProducts(): void {
    if (this.isBrowser) {
      localStorage.setItem(HOME_VIEW_STORAGE_KEY, 'products');
    }

    this.router.navigate(['/home']);
  }

  applyFilters(): void {
    this.loadProfitReport();
  }

  resetFilters(): void {
    this.filterCategoryId = '';
    this.filterProductId = '';
    this.filterDateFrom = null;
    this.filterDateTo = null;
    this.productOptions = [];
    this.loadProfitReport();
  }

  async generateProfitPdf(): Promise<void> {
    if (!this.isBrowser || this.isPdfGenerating) {
      return;
    }

    this.isPdfGenerating = true;
    this.pdfError = '';
    this.cdr.detectChanges();

    const year = this.normalizeYear(this.profitYear);

    try {
      const response = await firstValueFrom(this.profitBarService.getYearProfitBar({ year }));
      const chartData = this.extractProfitBarChartData(response);

      const [{ jsPDF }, { default: ChartJS }] = await Promise.all([
        import('jspdf'),
        import('chart.js/auto')
      ]);

      const { default: html2canvas } = await import('html2canvas');

      const canvas = document.createElement('canvas');
      canvas.width = 1200;
      canvas.height = 600;

      const context = canvas.getContext('2d');
      if (!context) {
        throw new Error('Unable to initialize canvas.');
      }

      const chart = new ChartJS(context, {
        type: 'bar',
        data: {
          labels: chartData.labels,
          datasets: [
            {
              label: 'Profit',
              data: chartData.values,
              backgroundColor: '#ff9933'
            }
          ]
        },
        options: {
          responsive: false,
          animation: false,
          plugins: {
            legend: {
              display: false
            }
          },
          scales: {
            x: {
              ticks: {
                color: '#111111'
              }
            },
            y: {
              beginAtZero: true,
              ticks: {
                color: '#111111'
              }
            }
          }
        }
      });

      await this.waitForNextFrame();
      await this.waitForNextFrame();

      const chartImage = canvas.toDataURL('image/png', 1.0);
      chart.destroy();

      const detailsElement = this.buildArabicProfitBarDetailsElement(response);
      document.body.appendChild(detailsElement);

      await this.waitForNextFrame();
      const detailsCanvas = await html2canvas(detailsElement, {
        backgroundColor: '#ffffff',
        scale: 2
      });
      detailsElement.remove();
      const detailsImage = detailsCanvas.toDataURL('image/png', 1.0);

      const doc = new jsPDF({
        orientation: 'p',
        unit: 'pt',
        format: 'a4'
      });

      const margin = 24;
      const pageWidth = doc.internal.pageSize.getWidth();
      const pageHeight = doc.internal.pageSize.getHeight();
      const maxImageWidth = pageWidth - margin * 2;
      const maxImageHeight = pageHeight - margin * 2;

      const imageAspectRatio = canvas.width / canvas.height;
      let imageWidth = maxImageWidth;
      let imageHeight = imageWidth / imageAspectRatio;

      const detailsGap = 12;
      const reservedForDetails = Math.min(220, pageHeight * 0.32);
      const maxChartHeight = maxImageHeight - reservedForDetails - detailsGap;

      if (imageHeight > maxChartHeight) {
        imageHeight = maxChartHeight;
        imageWidth = imageHeight * imageAspectRatio;
      }

      const x = (pageWidth - imageWidth) / 2;
      const y = margin;

      doc.addImage(chartImage, 'PNG', x, y, imageWidth, imageHeight);

      const detailsMaxWidth = maxImageWidth;
      const detailsX = margin;
      const detailsY = y + imageHeight + detailsGap;
      const detailsAspectRatio = detailsCanvas.width / detailsCanvas.height;
      let detailsWidth = detailsMaxWidth;
      let detailsHeight = detailsWidth / detailsAspectRatio;

      if (detailsY + detailsHeight > pageHeight - margin) {
        detailsHeight = pageHeight - margin - detailsY;
        detailsWidth = detailsHeight * detailsAspectRatio;
      }

      if (detailsHeight > 0 && detailsWidth > 0) {
        doc.addImage(detailsImage, 'PNG', detailsX, detailsY, detailsWidth, detailsHeight);
      }

      doc.save(`profit-bar-${response?.year ?? year}.pdf`);
    } catch (err: any) {
      this.pdfError =
        err?.error?.message || err?.message || this.translate.instant('profitReportPage.messages.loadFailed');
    } finally {
      this.isPdfGenerating = false;
      this.cdr.detectChanges();
    }
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

  openInvoiceDetails(row: ProductProfitReportRow): void {
    this.selectedReportRow = row;
    this.invoiceDialogVisible = true;
  }

  closeInvoiceDetails(): void {
    this.invoiceDialogVisible = false;
    this.selectedReportRow = null;
  }

  formatMoney(value: number | null | undefined): string {
    return new Intl.NumberFormat('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(Number(value || 0));
  }

  formatDisplayDate(value: string | null | undefined): string {
    if (!value) {
      return '-';
    }

    const parsedDate = new Date(value);
    if (Number.isNaN(parsedDate.getTime())) {
      return String(value);
    }

    return formatDate(parsedDate, 'yyyy-MM-dd');
  }

  getInvoiceTypeLabel(type: string | null | undefined): string {
    const normalizedType = String(type || '').trim().toLowerCase();

    if (normalizedType.includes('credit')) {
      return this.translate.instant('profitReportPage.invoiceTypes.creditSale');
    }

    if (normalizedType.includes('sell') || normalizedType.includes('cash')) {
      return this.translate.instant('profitReportPage.invoiceTypes.selling');
    }

    return type || this.translate.instant('profitReportPage.invoiceTypes.unknown');
  }

  private loadProfitReport(): void {
    this.isLoading = true;
    this.loadError = '';

    this.productsService.getProductsProfitReport(this.buildFilterParams()).subscribe({
      next: (response: any) => {
        this.reports = this.extractProfitReports(response);
        this.isLoading = false;
        this.cdr.detectChanges();
      },
      error: (err: any) => {
        this.reports = [];
        this.isLoading = false;
        this.loadError = err?.error?.message || this.translate.instant('profitReportPage.messages.loadFailed');
        this.cdr.detectChanges();
      }
    });
  }

  private normalizeYear(value: unknown): number {
    const currentYear = new Date().getFullYear();
    const parsedValue = Math.trunc(Number(value));
    if (!Number.isFinite(parsedValue)) {
      return currentYear;
    }

    if (parsedValue < 1970 || parsedValue > currentYear + 5) {
      return currentYear;
    }

    return parsedValue;
  }

  private extractProfitBarChartData(response: YearProfitBarResponse): { labels: string[]; values: number[] } {
    const fallbackLabelsEn = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const fallbackLabelsAr = [
      'يناير',
      'فبراير',
      'مارس',
      'أبريل',
      'مايو',
      'يونيو',
      'يوليو',
      'أغسطس',
      'سبتمبر',
      'أكتوبر',
      'نوفمبر',
      'ديسمبر'
    ];

    const isArabic = String(this.translate.currentLang || this.translate.getDefaultLang() || '')
      .toLowerCase()
      .startsWith('ar');

    const labels = isArabic ? [...fallbackLabelsAr] : [...fallbackLabelsEn];
    const values = new Array<number>(12).fill(0);

    const months = Array.isArray(response?.months) ? response.months : [];
    for (const monthItem of months) {
      const monthIndex = this.toNumber(monthItem?.month) - 1;
      if (monthIndex < 0 || monthIndex > 11) continue;

      labels[monthIndex] = String(
        (isArabic ? monthItem?.labelAr : monthItem?.label) || labels[monthIndex] || ''
      );
      values[monthIndex] = this.toNumber(monthItem?.profit);
    }

    return { labels, values };
  }

  private async waitForNextFrame(): Promise<void> {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }

  private buildArabicProfitBarDetailsElement(response: YearProfitBarResponse): HTMLDivElement {
    const formatter = new Intl.NumberFormat('ar-EG', {
      minimumFractionDigits: 0,
      maximumFractionDigits: 2
    });

    const container = document.createElement('div');
    container.dir = 'rtl';
    container.lang = 'ar';
    container.style.position = 'fixed';
    container.style.left = '-10000px';
    container.style.top = '0';
    container.style.width = '1200px';
    container.style.padding = '16px';
    container.style.background = '#ffffff';
    container.style.color = '#111111';
    container.style.fontFamily = 'Roboto, Arial, sans-serif';

    const header = document.createElement('div');
    header.style.display = 'flex';
    header.style.justifyContent = 'space-between';
    header.style.gap = '12px';
    header.style.alignItems = 'center';
    header.style.marginBottom = '12px';

    const yearText = document.createElement('div');
    yearText.style.fontSize = '20px';
    yearText.style.fontWeight = '700';
    yearText.textContent = `السنة: ${formatter.format(this.toNumber(response?.year))}`;

    const totalText = document.createElement('div');
    totalText.style.fontSize = '20px';
    totalText.style.fontWeight = '700';
    totalText.textContent = `إجمالي الربح: ${formatter.format(this.toNumber(response?.totalProfit))}`;

    header.appendChild(yearText);
    header.appendChild(totalText);
    container.appendChild(header);

    const table = document.createElement('table');
    table.style.width = '100%';
    table.style.borderCollapse = 'collapse';
    table.style.fontSize = '16px';

    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    for (const title of ['الشهر', 'الربح', 'نقدي', 'آجل']) {
      const th = document.createElement('th');
      th.textContent = title;
      th.style.border = '1px solid #e4e4e4';
      th.style.padding = '10px 8px';
      th.style.background = '#f7f7f7';
      th.style.textAlign = 'right';
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    const months = Array.isArray(response?.months) ? response.months : [];
    for (const monthItem of months) {
      const tr = document.createElement('tr');

      const monthCell = document.createElement('td');
      monthCell.textContent = String(monthItem?.labelAr || monthItem?.label || monthItem?.month || '-');
      monthCell.style.border = '1px solid #e4e4e4';
      monthCell.style.padding = '10px 8px';

      const profitCell = document.createElement('td');
      profitCell.textContent = formatter.format(this.toNumber(monthItem?.profit));
      profitCell.style.border = '1px solid #e4e4e4';
      profitCell.style.padding = '10px 8px';

      const cashCell = document.createElement('td');
      cashCell.textContent = formatter.format(this.toNumber(monthItem?.cashProfit));
      cashCell.style.border = '1px solid #e4e4e4';
      cashCell.style.padding = '10px 8px';

      const creditCell = document.createElement('td');
      creditCell.textContent = formatter.format(this.toNumber(monthItem?.creditProfit));
      creditCell.style.border = '1px solid #e4e4e4';
      creditCell.style.padding = '10px 8px';

      tr.appendChild(monthCell);
      tr.appendChild(profitCell);
      tr.appendChild(cashCell);
      tr.appendChild(creditCell);
      tbody.appendChild(tr);
    }

    table.appendChild(tbody);
    container.appendChild(table);
    return container;
  }

  private buildFilterParams(): {
    categoryId?: string;
    productId?: string;
    dateFrom?: string;
    dateTo?: string;
  } {
    return {
      ...(this.filterCategoryId ? { categoryId: this.filterCategoryId } : {}),
      ...(this.filterProductId ? { productId: this.filterProductId } : {}),
      ...(this.filterDateFrom ? { dateFrom: formatDate(this.filterDateFrom, 'yyyy-MM-dd') } : {}),
      ...(this.filterDateTo ? { dateTo: formatDate(this.filterDateTo, 'yyyy-MM-dd') } : {})
    };
  }

  private loadCategories(): void {
    this.isCategoriesLoading = true;

    this.categoryService.getCategories().subscribe({
      next: (response: any) => {
        const categories = this.extractCollection(response);
        this.categoryOptions = categories
          .map((item: any) => ({
            label: String(item?.name || ''),
            value: String(item?._id || item?.id || '')
          }))
          .filter((item: SelectOption) => Boolean(item.value));

        this.isCategoriesLoading = false;
        this.cdr.detectChanges();
      },
      error: () => {
        this.categoryOptions = [];
        this.isCategoriesLoading = false;
        this.cdr.detectChanges();
      }
    });
  }

  private loadProductsByCategory(categoryId: string): void {
    this.isProductsLoading = true;

    this.categoryService.getProducts(categoryId, { categoryId }).subscribe({
      next: (response: any) => {
        const products = this.extractCollection(response);
        this.productOptions = products
          .map((item: any) => ({
            label: String(item?.name || item?.productName || ''),
            value: String(item?._id || item?.id || '')
          }))
          .filter((item: SelectOption) => Boolean(item.value));

        this.isProductsLoading = false;
        this.cdr.detectChanges();
      },
      error: () => {
        this.productOptions = [];
        this.isProductsLoading = false;
        this.cdr.detectChanges();
      }
    });
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

  private extractProfitReports(response: any): ProductProfitReportRow[] {
    let list: any[] = [];

    if (Array.isArray(response)) {
      list = response;
    } else if (Array.isArray(response?.data)) {
      list = response.data;
    } else if (Array.isArray(response?.reports)) {
      list = response.reports;
    } else if (response?.data && typeof response.data === 'object') {
      list = [response.data];
    } else if (response && typeof response === 'object') {
      list = [response];
    }

    return list
      .map((item) => this.mapProfitReportRow(item))
      .filter((item): item is ProductProfitReportRow => item !== null);
  }

  private mapProfitReportRow(source: any): ProductProfitReportRow | null {
    if (!source) {
      return null;
    }

    const productId = String(source.productId || source._id || source.id || '').trim();
    const productName = String(source.productName || source.name || '').trim();
    if (!productId && !productName) {
      return null;
    }

    const invoices = Array.isArray(source.invoices)
      ? source.invoices
      : Array.isArray(source.invoiceHistory)
        ? source.invoiceHistory
        : [];

    return {
      productId,
      productName,
      categoryName: String(source.categoryName || source.category?.name || '').trim(),
      totalProfit: this.toNumber(source.totalProfit ?? source.profitValue ?? source.profit),
      lastSellingDate: this.toNullableString(source.lastSellingDate ?? source.latestSellingDate ?? source.lastSaleDate),
      lastSellingPrice: this.toNullableNumber(source.lastSellingPrice ?? source.latestSellingPriceValue ?? source.lastPrice),
      invoices: invoices
        .map((invoice: any, index: number) => this.mapInvoice(invoice, index))
        .filter((invoice): invoice is ProductProfitReportInvoice => invoice !== null)
    };
  }

  private mapInvoice(source: any, index: number): ProductProfitReportInvoice | null {
    if (!source) {
      return null;
    }

    const id = source.invoiceId || source._id || source.id || source.number || `${index}`;

    return {
      id: String(id),
      invoiceNumber: this.toNullableString(source.invoiceNumber || source.number || id),
      type: String(source.type || source.invoiceType || source.kind || '').trim(),
      sellingDate: this.toNullableString(source.sellingDate || source.date || source.createdAt),
      sellingPrice: this.toNullableNumber(source.sellingPrice ?? source.price ?? source.unitPrice ?? source.totalPrice),
      quantity: this.toNullableNumber(source.quantity),
      purchasePrice: this.toNullableNumber(source.purchasePrice),
      profit: this.toNullableNumber(source.profit),
      customerName: this.toNullableString(source.customerName)
    };
  }

  private toNumber(value: unknown): number {
    const parsedValue = Number(value);
    return Number.isFinite(parsedValue) ? parsedValue : 0;
  }

  private toNullableNumber(value: unknown): number | null {
    const parsedValue = Number(value);
    return Number.isFinite(parsedValue) ? parsedValue : null;
  }

  private toNullableString(value: unknown): string | null {
    const normalized = String(value || '').trim();
    return normalized ? normalized : null;
  }
}
