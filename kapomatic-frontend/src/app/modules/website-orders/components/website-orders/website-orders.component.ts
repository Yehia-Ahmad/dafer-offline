import { CommonModule, isPlatformBrowser } from '@angular/common';
import { ChangeDetectorRef, Component, Inject, OnInit, PLATFORM_ID } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';
import { TableModule } from 'primeng/table';
import { HOME_VIEW_STORAGE_KEY } from '../../../layout/constants/home-view.constants';
import { SideNavComponent } from '../../../layout/components/side-nav/side-nav.component';
import { ThemeService } from '../../../shared/services/theme.service';
import {
  WebsiteOrder,
  WebsiteOrdersPagination,
  WebsiteOrderScope
} from '../../models/website-orders.models';
import { WebsiteOrdersService } from '../../services/website-orders.service';

const DEFAULT_PAGINATION: WebsiteOrdersPagination = {
  page: 1,
  limit: 10,
  totalItems: 0,
  totalPages: 1,
  hasNextPage: false,
  hasPrevPage: false
};

@Component({
  selector: 'app-website-orders',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    SideNavComponent,
    TranslatePipe,
    TableModule,
    DialogModule,
    ButtonModule
  ],
  templateUrl: './website-orders.component.html',
  styleUrl: './website-orders.component.scss'
})
export class WebsiteOrdersComponent implements OnInit {
  isDarkMode$;
  activeScope: WebsiteOrderScope = 'all';
  orders: WebsiteOrder[] = [];
  pagination: WebsiteOrdersPagination = { ...DEFAULT_PAGINATION };
  expandedOrderIds = new Set<string>();
  isLoading = false;
  isLoadingMore = false;
  isConfirming = false;
  isRefunding = false;
  loadError = '';
  loadMoreError = '';
  actionError = '';
  confirmDialogVisible = false;
  refundDialogVisible = false;
  transferDialogVisible = false;
  selectedOrder: WebsiteOrder | null = null;
  selectedTransferOrder: WebsiteOrder | null = null;
  confirmInsufficientInventory = true;
  refundNote = '';
  readonly scopes: WebsiteOrderScope[] = ['all', 'pending', 'accepted', 'refunded'];
  private readonly isBrowser: boolean;

  constructor(
    private readonly themeService: ThemeService,
    private readonly router: Router,
    private readonly translate: TranslateService,
    private readonly service: WebsiteOrdersService,
    private readonly cdr: ChangeDetectorRef,
    @Inject(PLATFORM_ID) platformId: object
  ) {
    this.isDarkMode$ = this.themeService.isDarkMode$;
    this.isBrowser = isPlatformBrowser(platformId);
  }

  ngOnInit(): void {
    if (this.isBrowser) {
      localStorage.setItem(HOME_VIEW_STORAGE_KEY, 'dashboard');
    }
    this.loadOrders(1);
  }

  backToHome(): void {
    if (this.isBrowser) {
      localStorage.setItem(HOME_VIEW_STORAGE_KEY, 'dashboard');
    }
    this.router.navigate(['/home']);
  }

  setScope(scope: WebsiteOrderScope): void {
    if (scope === this.activeScope) return;
    this.activeScope = scope;
    this.expandedOrderIds.clear();
    this.loadOrders(1, false);
  }

  loadOrders(page = this.pagination.page, append = false): void {
    if (append) {
      this.isLoadingMore = true;
    } else {
      this.isLoading = true;
      this.pagination = { ...DEFAULT_PAGINATION, limit: this.pagination.limit };
    }
    this.loadError = '';
    this.loadMoreError = '';

    this.service.getOrders(this.activeScope, page, this.pagination.limit).subscribe({
      next: (result) => {
        this.orders = append ? this.mergeOrders(this.orders, result.orders) : result.orders;
        this.pagination = result.pagination;
        this.isLoading = false;
        this.isLoadingMore = false;
        this.cdr.detectChanges();
      },
      error: (error) => {
        const message = this.errorMessage(error, 'websiteOrders.messages.loadFailed');
        if (append) {
          this.loadMoreError = message;
        } else {
          this.orders = [];
          this.pagination = { ...DEFAULT_PAGINATION, limit: this.pagination.limit };
          this.loadError = message;
        }
        this.isLoading = false;
        this.isLoadingMore = false;
        this.cdr.detectChanges();
      }
    });
  }

  onOrdersViewportScroll(event: Event): void {
    const target = event.target as HTMLElement | null;
    if (!target || this.isLoading || this.isLoadingMore || !this.pagination.hasNextPage) {
      return;
    }

    const scrollThreshold = 80;
    const distanceFromBottom = target.scrollHeight - target.scrollTop - target.clientHeight;
    if (distanceFromBottom <= scrollThreshold) {
      this.loadOrders(this.pagination.page + 1, true);
    }
  }

  refresh(): void {
    this.expandedOrderIds.clear();
    this.loadOrders(1, false);
  }

  toggleItems(order: WebsiteOrder): void {
    if (this.expandedOrderIds.has(order.id)) {
      this.expandedOrderIds.delete(order.id);
    } else {
      this.expandedOrderIds.add(order.id);
    }
    this.cdr.detectChanges();
  }

  isExpanded(order: WebsiteOrder): boolean {
    return this.expandedOrderIds.has(order.id);
  }

  canConfirm(order: WebsiteOrder): boolean {
    return String(order.status).toLowerCase() === 'pending';
  }

  canRefund(order: WebsiteOrder): boolean {
    return !['refunded', 'cancelled', 'canceled'].includes(String(order.status).toLowerCase());
  }

  hasTransferDetails(order: WebsiteOrder): boolean {
    return Boolean(order.transferPhone || order.transferImage);
  }

  openTransferDialog(order: WebsiteOrder): void {
    if (!this.hasTransferDetails(order)) return;
    this.selectedTransferOrder = order;
    this.transferDialogVisible = true;
  }

  closeTransferDialog(): void {
    this.transferDialogVisible = false;
    this.selectedTransferOrder = null;
  }

  openConfirmDialog(order: WebsiteOrder): void {
    if (!this.canConfirm(order)) return;
    this.selectedOrder = order;
    this.confirmInsufficientInventory = true;
    this.actionError = '';
    this.confirmDialogVisible = true;
  }

  closeConfirmDialog(): void {
    if (this.isConfirming) return;
    this.confirmDialogVisible = false;
    this.selectedOrder = null;
    this.actionError = '';
  }

  confirmOrder(): void {
    const order = this.selectedOrder;
    if (!order?.id || this.isConfirming) return;

    this.isConfirming = true;
    this.actionError = '';
    this.service.confirmOrder(order.id, {
      confirmInsufficientInventory: this.confirmInsufficientInventory
    }).subscribe({
      next: () => this.finishAction(),
      error: (error) => {
        this.actionError = this.errorMessage(error, 'websiteOrders.messages.confirmFailed');
        this.isConfirming = false;
        this.cdr.detectChanges();
      }
    });
  }

  openRefundDialog(order: WebsiteOrder): void {
    if (!this.canRefund(order)) return;
    this.selectedOrder = order;
    this.refundNote = '';
    this.actionError = '';
    this.refundDialogVisible = true;
  }

  closeRefundDialog(): void {
    if (this.isRefunding) return;
    this.refundDialogVisible = false;
    this.selectedOrder = null;
    this.actionError = '';
    this.refundNote = '';
  }

  refundOrder(): void {
    const order = this.selectedOrder;
    if (!order?.id || this.isRefunding) return;

    this.isRefunding = true;
    this.actionError = '';
    this.service.refundOrder(order.id, {
      ...(this.refundNote.trim() ? { note: this.refundNote.trim() } : {})
    }).subscribe({
      next: () => this.finishAction(),
      error: (error) => {
        this.actionError = this.errorMessage(error, 'websiteOrders.messages.refundFailed');
        this.isRefunding = false;
        this.cdr.detectChanges();
      }
    });
  }

  statusClass(status: string): string {
    const normalized = String(status || '').toLowerCase();
    if (normalized === 'accepted') return 'website-orders-status website-orders-status--accepted';
    if (normalized === 'refunded') return 'website-orders-status website-orders-status--refunded';
    return 'website-orders-status website-orders-status--pending';
  }

  statusLabel(status: string): string {
    const normalized = String(status || 'pending').toLowerCase();
    const key = `websiteOrders.status.${normalized}`;
    const translated = this.translate.instant(key);
    return translated === key ? status || '-' : translated;
  }

  paymentMethodLabel(paymentMethod: string): string {
    const normalized = String(paymentMethod || '').toLowerCase();
    if (!normalized) return '-';

    const key = `websiteOrders.paymentMethods.${normalized}`;
    const translated = this.translate.instant(key);
    return translated === key ? paymentMethod : translated;
  }

  pageRangeLabel(): string {
    const total = this.pagination.totalItems;
    if (!total) {
      return this.translate.instant('websiteOrders.pagination.range', { start: 0, end: 0, total: 0 });
    }
    const start = (this.pagination.page - 1) * this.pagination.limit + 1;
    const end = Math.min(this.pagination.page * this.pagination.limit, total);
    return this.translate.instant('websiteOrders.pagination.range', { start, end, total });
  }

  private finishAction(): void {
    this.isConfirming = false;
    this.isRefunding = false;
    this.confirmDialogVisible = false;
    this.refundDialogVisible = false;
    this.transferDialogVisible = false;
    this.selectedOrder = null;
    this.selectedTransferOrder = null;
    this.refundNote = '';
    this.expandedOrderIds.clear();
    this.loadOrders(1, false);
  }

  private mergeOrders(current: WebsiteOrder[], next: WebsiteOrder[]): WebsiteOrder[] {
    const seenIds = new Set(current.map((order) => order.id));
    const uniqueNext = next.filter((order) => {
      if (seenIds.has(order.id)) {
        return false;
      }
      seenIds.add(order.id);
      return true;
    });

    return [...current, ...uniqueNext];
  }

  private errorMessage(error: any, fallbackKey: string): string {
    return error?.error?.message || this.translate.instant(fallbackKey);
  }
}
