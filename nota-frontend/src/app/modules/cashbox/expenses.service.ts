import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';
import { ExpenseCategory, ExpenseRow, ExpensesResponse } from './cashbox.models';

export interface ExpenseFilters {
  /** YYYY-MM */
  month?: string;
  category?: string;
  box?: string;
}

export interface CreateExpensePayload {
  accountId: string;
  amount: number;
  boxId?: string;
  date?: string;
  note?: string;
  /** Stage 21: the VAT on the bill (part of `amount`); sent only while VAT applies and the user filled it. */
  vatAmount?: number;
}

/** Stage 19: /api/expenses (expenses.create records; expenses.manage cancels and manages categories). */
@Injectable({ providedIn: 'root' })
export class ExpensesService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.api_base_url}expenses`;

  list(filters: ExpenseFilters = {}): Observable<ExpensesResponse> {
    let params = new HttpParams();
    if (filters.month) params = params.set('month', filters.month);
    if (filters.category) params = params.set('category', filters.category);
    if (filters.box) params = params.set('box', filters.box);
    return this.http.get<ExpensesResponse>(this.base, { params });
  }

  categories(): Observable<{ data: ExpenseCategory[] }> {
    return this.http.get<{ data: ExpenseCategory[] }>(`${this.base}/categories`);
  }

  create(payload: CreateExpensePayload): Observable<ExpenseRow> {
    return this.http.post<ExpenseRow>(this.base, payload);
  }

  cancel(id: string, reason: string): Observable<ExpenseRow> {
    return this.http.post<ExpenseRow>(`${this.base}/${encodeURIComponent(id)}/cancel`, { reason });
  }

  createCategory(payload: { nameAr: string; nameEn?: string }): Observable<ExpenseCategory> {
    return this.http.post<ExpenseCategory>(`${this.base}/categories`, payload);
  }

  updateCategory(id: string, payload: { nameAr?: string; nameEn?: string; isActive?: boolean }): Observable<ExpenseCategory> {
    return this.http.put<ExpenseCategory>(`${this.base}/categories/${encodeURIComponent(id)}`, payload);
  }
}
