import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { environment } from '../../../../environments/environment';
import { removeNullishFieldsParams } from '../../../core/utilities/helper-function';

export interface ProfitBarMonth {
  month: number;
  label: string;
  labelAr: string;
  profit: number;
  cashProfit: number;
  creditProfit: number;
}

export interface YearProfitBarResponse {
  year: number;
  startDate: string;
  endDate: string;
  totalProfit: number;
  months: ProfitBarMonth[];
}

@Injectable({
  providedIn: 'root'
})
export class ProfitBarService {
  private _baseUrl = environment.api_base_url;

  constructor(private _http: HttpClient) {}

  getYearProfitBar(params?: { year?: number }) {
    const cleanedParams = removeNullishFieldsParams({ ...(params ?? {}) });
    return this._http.get<YearProfitBarResponse>(`${this._baseUrl}products/profit-bar`, {
      params: cleanedParams
    });
  }
}

