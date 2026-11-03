import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { map, Observable } from 'rxjs';
import { environment } from '../../../../environments/environment';
import {
  WebsiteOrder,
  WebsiteOrderConfirmPayload,
  WebsiteOrderItem,
  WebsiteOrderRefundPayload,
  WebsiteOrdersPage,
  WebsiteOrdersPagination,
  WebsiteOrderScope
} from '../models/website-orders.models';

const DEFAULT_PAGINATION: WebsiteOrdersPagination = {
  page: 1,
  limit: 10,
  totalItems: 0,
  totalPages: 1,
  hasNextPage: false,
  hasPrevPage: false
};

@Injectable({ providedIn: 'root' })
export class WebsiteOrdersService {
  private readonly baseUrl = `${environment.api_base_url}website-orders`;

  constructor(private readonly http: HttpClient) {}

  getOrders(scope: WebsiteOrderScope, page = 1, limit = 10): Observable<WebsiteOrdersPage> {
    const url = scope === 'all' ? this.baseUrl : `${this.baseUrl}/${scope}`;
    const params = new HttpParams().set('page', page).set('limit', limit);

    return this.http.get<unknown>(url, { params }).pipe(
      map((response) => ({
        orders: this.extractOrders(response).map((order) => this.normalizeOrder(order)),
        pagination: this.normalizePagination(response, page, limit)
      }))
    );
  }

  confirmOrder(id: string, payload: WebsiteOrderConfirmPayload): Observable<WebsiteOrder> {
    return this.http.post<unknown>(`${this.baseUrl}/${encodeURIComponent(id)}/confirm`, payload).pipe(
      map((response) => this.normalizeOrder(this.extractOrder(response)))
    );
  }

  refundOrder(id: string, payload: WebsiteOrderRefundPayload): Observable<WebsiteOrder> {
    return this.http.post<unknown>(`${this.baseUrl}/${encodeURIComponent(id)}/refund`, payload).pipe(
      map((response) => this.normalizeOrder(this.extractOrder(response)))
    );
  }

  private extractOrders(response: any): any[] {
    if (Array.isArray(response)) return response;
    if (Array.isArray(response?.data)) return response.data;
    if (Array.isArray(response?.data?.orders)) return response.data.orders;
    if (Array.isArray(response?.orders)) return response.orders;
    if (Array.isArray(response?.items)) return response.items;
    return [];
  }

  private extractOrder(response: any): any {
    return response?.data?.order || response?.data?.websiteOrder || response?.data || response?.order || response || {};
  }

  private normalizePagination(response: any, requestedPage: number, requestedLimit: number): WebsiteOrdersPagination {
    const source = response?.pagination ?? response?.data?.pagination ?? {};
    const page = this.positiveInteger(source.page, requestedPage);
    const limit = this.positiveInteger(source.limit, requestedLimit);
    const totalItems = this.positiveInteger(source.totalItems, 0);
    const totalPages = this.positiveInteger(source.totalPages, 1);

    return {
      page,
      limit,
      totalItems,
      totalPages,
      hasNextPage: Boolean(source.hasNextPage ?? page < totalPages),
      hasPrevPage: Boolean(source.hasPrevPage ?? page > 1)
    };
  }

  private normalizeOrder(order: any): WebsiteOrder {
    const id = String(order?._id || order?.id || order?.orderId || '');
    const items = this.extractOrderItems(order, id);

    return {
      id,
      orderNumber: String(order?.orderNumber || order?.orderNo || order?.number || id || ''),
      status: String(order?.status || 'pending'),
      customerName: String(order?.customerName || order?.customer?.name || ''),
      customerPhone: String(order?.customerPhone || order?.customer?.phone || order?.phone || ''),
      shippingLocation: String(order?.shippingLocation || order?.address || order?.customer?.address || ''),
      government: String(order?.government || order?.governorate || order?.shippingGovernment || ''),
      createdAt: this.stringDate(order?.createdAt || order?.orderDate),
      acceptedAt: this.stringDate(order?.acceptedAt || order?.confirmedAt),
      refundedAt: this.stringDate(order?.refundedAt),
      sellingInvoiceId: String(order?.sellingInvoiceId || order?.sellingId || order?.invoiceId || order?.invoice?._id || ''),
      itemCount: this.numberOrNull(order?.itemCount) ?? items.length,
      totalQuantity: this.numberOrNull(order?.totalQuantity) ?? this.sumItems(items, 'quantity'),
      subtotal: this.numberOrNull(order?.subtotal),
      discountAmount: this.numberOrNull(order?.discountAmount),
      shippingFees: this.numberOrNull(order?.shippingFees),
      totalPrice: this.numberOrNull(order?.totalPrice ?? order?.total),
      refundNote: String(order?.refundNote || order?.note || ''),
      paymentMethod: String(order?.paymentMethod || ''),
      transferPhone: String(order?.transferPhone || order?.payment?.transferPhone || ''),
      transferImage: String(order?.transferImage || order?.payment?.transferImage || ''),
      items
    };
  }

  private extractOrderItems(order: any, orderId: string): WebsiteOrderItem[] {
    const source = Array.isArray(order?.items) ? order.items : [];
    return source.map((item: any, index: number) => ({
      id: String(item?._id || item?.id || `${orderId}-${item?.productId || index}`),
      productId: String(item?.productId || item?.product?._id || item?.product?.id || ''),
      productName: String(item?.productName || item?.product?.name || item?.name || ''),
      productCode: String(item?.productCode || item?.product?.code || item?.code || ''),
      categoryName: String(item?.categoryName || item?.category?.name || ''),
      quantity: this.numberOrNull(item?.quantity ?? item?.productQuantity),
      unitPrice: this.numberOrNull(item?.unitPrice ?? item?.price ?? item?.productPricePerEach),
      totalPrice: this.numberOrNull(item?.totalPrice ?? item?.total)
    }));
  }

  private sumItems(items: WebsiteOrderItem[], field: 'quantity' | 'totalPrice'): number {
    return items.reduce((total, item) => total + Number(item[field] || 0), 0);
  }

  private numberOrNull(value: any): number | null {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  private positiveInteger(value: any, fallback: number): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
  }

  private stringDate(value: any): string | null {
    return value ? String(value) : null;
  }
}
