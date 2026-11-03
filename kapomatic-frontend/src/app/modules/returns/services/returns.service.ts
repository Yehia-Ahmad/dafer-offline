import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../../../environments/environment';
import {
  ApiDataResponse,
  CreateReturnPayload,
  ReturnLog,
  ReturnsFilters,
  ReturnsListResponse,
  ReturnsSummary
} from '../models/returns.model';

@Injectable({ providedIn: 'root' })
export class ReturnsService {
  private readonly baseUrl = `${environment.api_base_url}returns`;

  constructor(private readonly http: HttpClient) {}

  createReturn(payload: CreateReturnPayload): Observable<unknown> {
    return this.http.post(this.baseUrl, payload);
  }

  getReturns(filters: ReturnsFilters = {}): Observable<ReturnsListResponse> {
    return this.http.get<ReturnsListResponse>(this.baseUrl, {
      params: this.buildParams(filters)
    });
  }

  getReturnById(id: string): Observable<ReturnLog | ApiDataResponse<ReturnLog>> {
    return this.http.get<ReturnLog | ApiDataResponse<ReturnLog>>(
      `${this.baseUrl}/${encodeURIComponent(id)}`
    );
  }

  getReturnsSummary(
    filters: Omit<ReturnsFilters, 'page' | 'limit'> = {}
  ): Observable<ReturnsSummary | ApiDataResponse<ReturnsSummary>> {
    return this.http.get<ReturnsSummary | ApiDataResponse<ReturnsSummary>>(
      `${this.baseUrl}/summary`,
      { params: this.buildParams(filters) }
    );
  }

  private buildParams(filters: ReturnsFilters): HttpParams {
    let params = new HttpParams();

    Object.entries(filters).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') {
        params = params.set(key, String(value));
      }
    });

    return params;
  }
}
