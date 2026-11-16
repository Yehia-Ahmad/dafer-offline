import { HttpClient, HttpContext, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';
import { environment } from '../../../environments/environment';
import { HANDLES_OWN_ERRORS } from '../../core/auth/auth.service';
import {
  Courier, CourierDetail, DeliverPayload, OrderDetail, OrderEditPayload, OrderListQuery, OrderListResponse, PickupPayload, WebsiteCustomer,
} from './orders.models';

/** Online Stage 4: /api/orders, /api/couriers and /api/website/customers. */
@Injectable({ providedIn: 'root' })
export class OrdersService {
  private readonly http = inject(HttpClient);
  private readonly orders = `${environment.api_base_url}orders`;
  private readonly couriers = `${environment.api_base_url}couriers`;
  private readonly customers = `${environment.api_base_url}website/customers`;

  list(query: OrderListQuery = {}): Observable<OrderListResponse> {
    let params = new HttpParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== '') params = params.set(key, String(value));
    }
    return this.http.get<OrderListResponse>(this.orders, { params });
  }

  /** The sidebar badge. Polled every 20 s, so a failure is silent (no toast per tick); the next normal request still ends an expired session. */
  summary(): Observable<{ newCount: number }> {
    return this.http.get<{ newCount: number }>(`${this.orders}/summary`, { context: new HttpContext().set(HANDLES_OWN_ERRORS, true) });
  }

  get(id: string): Observable<OrderDetail> {
    return this.http.get<OrderDetail>(`${this.orders}/${id}`);
  }

  edit(id: string, payload: OrderEditPayload): Observable<OrderDetail> {
    return this.http.put<OrderDetail>(`${this.orders}/${id}`, payload);
  }

  confirm(id: string): Observable<OrderDetail> { return this.http.post<OrderDetail>(`${this.orders}/${id}/confirm`, {}); }
  prepare(id: string): Observable<OrderDetail> { return this.http.post<OrderDetail>(`${this.orders}/${id}/prepare`, {}); }
  reject(id: string, reason: string): Observable<OrderDetail> { return this.http.post<OrderDetail>(`${this.orders}/${id}/reject`, { reason }); }
  cancel(id: string, reason: string): Observable<OrderDetail> { return this.http.post<OrderDetail>(`${this.orders}/${id}/cancel`, { reason }); }
  /** Online Stage 5A: pickup orders. ready = packed and waiting at the shop. */
  ready(id: string): Observable<OrderDetail> { return this.http.post<OrderDetail>(`${this.orders}/${id}/ready`, {}); }
  pickup(id: string, payload: PickupPayload = {}): Observable<OrderDetail> { return this.http.post<OrderDetail>(`${this.orders}/${id}/pickup`, payload); }
  /** Wallet orders: the shop saw the transfer. Posts nothing; the invoice does. */
  verifyPayment(id: string, reference = ''): Observable<OrderDetail> { return this.http.post<OrderDetail>(`${this.orders}/${id}/verify-payment`, reference.trim() ? { reference: reference.trim() } : {}); }
  dispatch(id: string, courierId: string): Observable<OrderDetail> { return this.http.post<OrderDetail>(`${this.orders}/${id}/dispatch`, { courierId }); }
  deliver(id: string, payload: DeliverPayload): Observable<OrderDetail> { return this.http.post<OrderDetail>(`${this.orders}/${id}/deliver`, payload); }
  refuse(id: string, reason: string): Observable<OrderDetail> { return this.http.post<OrderDetail>(`${this.orders}/${id}/refuse`, { reason }); }

  /** The active delivery zones for the edit form (orders.manage). */
  zones(): Observable<Array<{ id: string; name: string; fee: number }>> {
    return this.http.get<{ data: Array<{ id: string; name: string; fee: number }> }>(`${this.orders}/delivery-zones`).pipe(map((res) => res.data));
  }

  /** Any non-archived product (not only website-visible ones) to add to an order: the ordinary product search (products.view). */
  searchProducts(q: string): Observable<Array<{ _id: string; name: string; code?: string; retailPrice: number; discountPercentage?: number; inventoryCount: number }>> {
    return this.http.get<Array<{ _id: string; name: string; code?: string; retailPrice: number; discountPercentage?: number; inventoryCount: number }>>(
      `${environment.api_base_url}products/search`, { params: new HttpParams().set('q', q) });
  }

  listCouriers(): Observable<Courier[]> {
    return this.http.get<{ data: Courier[] }>(this.couriers).pipe(map((res) => res.data));
  }

  getCourier(id: string): Observable<CourierDetail> {
    return this.http.get<CourierDetail>(`${this.couriers}/${id}`);
  }

  createCourier(payload: { name: string; phone: string }): Observable<Courier> {
    return this.http.post<Courier>(this.couriers, payload);
  }

  updateCourier(id: string, payload: Partial<{ name: string; phone: string; isActive: boolean }>): Observable<Courier> {
    return this.http.put<Courier>(`${this.couriers}/${id}`, payload);
  }

  listWebsiteCustomers(q: string, page = 1): Observable<{ data: WebsiteCustomer[]; pagination: { page: number; totalPages: number; totalItems: number } }> {
    let params = new HttpParams().set('page', String(page));
    if (q.trim()) params = params.set('q', q.trim());
    return this.http.get<{ data: WebsiteCustomer[]; pagination: { page: number; totalPages: number; totalItems: number } }>(this.customers, { params });
  }

  setWebsiteCustomerActive(id: string, isActive: boolean): Observable<WebsiteCustomer> {
    return this.http.put<WebsiteCustomer>(`${this.customers}/${id}`, { isActive });
  }

  resetWebsiteCustomerPassword(id: string): Observable<{ temporaryPassword: string }> {
    return this.http.post<{ temporaryPassword: string }>(`${this.customers}/${id}/reset-password`, {});
  }
}
