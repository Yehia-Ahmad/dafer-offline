import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../../../environments/environment';
import { BalanceSheet, BoxMovements, IncomeStatement, PartyBalances, ReportKey, ReportQuery, TrialBalance } from './reports.models';

/** Stage 22: /api/reports/* (reports.financial). Read-only; `format=xlsx` returns the same report as an Excel file. */
@Injectable({ providedIn: 'root' })
export class ReportsService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.api_base_url}reports`;

  private params(query: ReportQuery, extra: Record<string, string> = {}): HttpParams {
    let params = new HttpParams();
    if (query.from) params = params.set('from', query.from);
    if (query.to) params = params.set('to', query.to);
    if (query.asOf) params = params.set('asOf', query.asOf);
    if (query.compare) params = params.set('compare', '1');
    if (query.type) params = params.set('type', query.type);
    for (const [key, value] of Object.entries(extra)) params = params.set(key, value);
    return params;
  }

  incomeStatement(query: ReportQuery): Observable<IncomeStatement> {
    return this.http.get<IncomeStatement>(`${this.base}/income-statement`, { params: this.params(query) });
  }

  balanceSheet(query: ReportQuery): Observable<BalanceSheet> {
    return this.http.get<BalanceSheet>(`${this.base}/balance-sheet`, { params: this.params(query) });
  }

  trialBalance(query: ReportQuery): Observable<TrialBalance> {
    return this.http.get<TrialBalance>(`${this.base}/trial-balance`, { params: this.params(query) });
  }

  boxMovements(query: ReportQuery): Observable<BoxMovements> {
    return this.http.get<BoxMovements>(`${this.base}/box-movements`, { params: this.params(query) });
  }

  partyBalances(query: ReportQuery): Observable<PartyBalances> {
    return this.http.get<PartyBalances>(`${this.base}/party-balances`, { params: this.params(query) });
  }

  /** "Excel للمحاسب": the same report as a workbook. */
  export(report: ReportKey, query: ReportQuery): Observable<Blob> {
    return this.http.get(`${this.base}/${report}`, { params: this.params(query, { format: 'xlsx' }), responseType: 'blob' });
  }
}
