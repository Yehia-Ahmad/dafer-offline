import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';
import { VatPayPayload, VatReturnDetail, VatReturnList, VatReturnRow } from './vat.models';

/** Stage 21: /api/vat/returns (view: vat.file or accounting.view; file, pay and unfile: vat.file; unfile is also owner only). */
@Injectable({ providedIn: 'root' })
export class VatReturnsService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.api_base_url}vat/returns`;

  list(): Observable<VatReturnList> {
    return this.http.get<VatReturnList>(this.base);
  }

  get(period: string): Observable<VatReturnDetail> {
    return this.http.get<VatReturnDetail>(`${this.base}/${period}`);
  }

  file(period: string): Observable<VatReturnRow> {
    return this.http.post<VatReturnRow>(`${this.base}/${period}/file`, {});
  }

  pay(period: string, payload: VatPayPayload): Observable<{ payment: { number: string }; return: VatReturnRow }> {
    return this.http.post<{ payment: { number: string }; return: VatReturnRow }>(`${this.base}/${period}/pay`, payload);
  }

  unfile(period: string, reason: string): Observable<VatReturnRow> {
    return this.http.post<VatReturnRow>(`${this.base}/${period}/unfile`, { reason });
  }

  /** The Excel workbook of a month: the figures and every document behind them. */
  export(period: string): Observable<Blob> {
    return this.http.get(`${this.base}/${period}/export`, { responseType: 'blob' });
  }
}
