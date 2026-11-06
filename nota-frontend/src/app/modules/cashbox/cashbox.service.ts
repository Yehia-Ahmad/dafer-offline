import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';
import {
  BoxDetail, BoxLedger, BoxType, BoxesResponse, CashBox, CustomerCredit, DevicesResponse, DrawingRow,
  PaymentBoxesResponse, ShiftReport, ShiftSummary, TransferRow,
} from './cashbox.models';

export interface CreateBoxPayload {
  name: string;
  type: BoxType;
  /** The PC whose sales default to this box (X-Nota-Device-Id of that PC); omit for "any device". */
  deviceId?: string | null;
  shiftsEnabled?: boolean;
  /** Moved in from the main box when the box is created. */
  openingAmount?: number;
}

export interface UpdateBoxPayload {
  name?: string;
  deviceId?: string | null;
  shiftsEnabled?: boolean;
  isActive?: boolean;
  sortOrder?: number;
}

export interface TransferPayload {
  fromBoxId: string;
  toBoxId: string;
  amount: number;
  date?: string;
  note?: string;
}

export interface DrawingPayload {
  boxId?: string;
  amount: number;
  date?: string;
  note?: string;
}

export interface OpenShiftPayload {
  boxId: string;
  openingFloat: number;
  /** Set after FLOAT_MISMATCH, once the user confirmed the difference. */
  confirmFloat?: boolean;
  /** Required with confirmFloat: why the drawer differs from the system. */
  openingNote?: string;
}

export interface CloseShiftPayload {
  counted: number;
  differenceNote?: string;
  depositBoxId?: string;
  depositAmount?: number;
}

/** Stage 19: /api/cashbox, /api/shifts, /api/devices and the customer credit calls. */
@Injectable({ providedIn: 'root' })
export class CashboxService {
  private readonly http = inject(HttpClient);
  private readonly api = environment.api_base_url;

  boxes(): Observable<BoxesResponse> {
    return this.http.get<BoxesResponse>(`${this.api}cashbox/boxes`);
  }

  box(id: string): Observable<BoxDetail> {
    return this.http.get<BoxDetail>(`${this.api}cashbox/boxes/${encodeURIComponent(id)}`);
  }

  boxLedger(id: string): Observable<BoxLedger> {
    return this.http.get<BoxLedger>(`${this.api}cashbox/boxes/${encodeURIComponent(id)}/ledger`);
  }

  createBox(payload: CreateBoxPayload): Observable<CashBox> {
    return this.http.post<CashBox>(`${this.api}cashbox/boxes`, payload);
  }

  updateBox(id: string, payload: UpdateBoxPayload): Observable<CashBox> {
    return this.http.put<CashBox>(`${this.api}cashbox/boxes/${encodeURIComponent(id)}`, payload);
  }

  paymentBoxes(): Observable<PaymentBoxesResponse> {
    return this.http.get<PaymentBoxesResponse>(`${this.api}cashbox/payment-boxes`);
  }

  devices(): Observable<DevicesResponse> {
    return this.http.get<DevicesResponse>(`${this.api}devices`);
  }

  transfers(boxId?: string): Observable<{ data: TransferRow[] }> {
    let params = new HttpParams();
    if (boxId) params = params.set('boxId', boxId);
    return this.http.get<{ data: TransferRow[] }>(`${this.api}cashbox/transfers`, { params });
  }

  createTransfer(payload: TransferPayload): Observable<TransferRow> {
    return this.http.post<TransferRow>(`${this.api}cashbox/transfers`, payload);
  }

  cancelTransfer(id: string, reason: string): Observable<TransferRow> {
    return this.http.post<TransferRow>(`${this.api}cashbox/transfers/${encodeURIComponent(id)}/cancel`, { reason });
  }

  drawings(): Observable<{ data: DrawingRow[] }> {
    return this.http.get<{ data: DrawingRow[] }>(`${this.api}cashbox/drawings`);
  }

  createDrawing(payload: DrawingPayload): Observable<DrawingRow> {
    return this.http.post<DrawingRow>(`${this.api}cashbox/drawings`, payload);
  }

  cancelDrawing(id: string, reason: string): Observable<DrawingRow> {
    return this.http.post<DrawingRow>(`${this.api}cashbox/drawings/${encodeURIComponent(id)}/cancel`, { reason });
  }

  // ------------------------------------------------------------------ shifts

  shifts(params: { boxId?: string; status?: 'open' | 'closed' } = {}): Observable<{ data: ShiftSummary[] }> {
    let httpParams = new HttpParams();
    if (params.boxId) httpParams = httpParams.set('boxId', params.boxId);
    if (params.status) httpParams = httpParams.set('status', params.status);
    return this.http.get<{ data: ShiftSummary[] }>(`${this.api}shifts`, { params: httpParams });
  }

  shift(id: string): Observable<ShiftReport> {
    return this.http.get<ShiftReport>(`${this.api}shifts/${encodeURIComponent(id)}`);
  }

  openShift(payload: OpenShiftPayload): Observable<ShiftSummary> {
    return this.http.post<ShiftSummary>(`${this.api}shifts`, payload);
  }

  closeShift(id: string, payload: CloseShiftPayload): Observable<ShiftReport> {
    return this.http.post<ShiftReport>(`${this.api}shifts/${encodeURIComponent(id)}/close`, payload);
  }

  // ------------------------------------------------------------------ customer credit

  customerCredit(customerId: string): Observable<CustomerCredit> {
    return this.http.get<CustomerCredit>(`${this.api}customers/${encodeURIComponent(customerId)}/credit`);
  }

  payoutCredit(customerId: string, payload: { boxId?: string; amount: number; note?: string }): Observable<{ payout: { _id: string; number: string }; credit: CustomerCredit }> {
    return this.http.post<{ payout: { _id: string; number: string }; credit: CustomerCredit }>(`${this.api}customers/${encodeURIComponent(customerId)}/payouts`, payload);
  }

  applyCredit(customerId: string, amount: number): Observable<{ applied: number; credit: CustomerCredit }> {
    return this.http.post<{ applied: number; credit: CustomerCredit }>(`${this.api}customers/${encodeURIComponent(customerId)}/apply-credit`, { amount });
  }
}
